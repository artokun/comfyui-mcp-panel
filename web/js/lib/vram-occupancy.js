/**
 * #1956 — panel_free_vram success used to return `{freed:true, unload_models, free_memory}`
 * with no MB, no before/after, and no indication whether occupancy was re-read.
 *
 * #2144 — and then the numbers it DID report were photographed too early. ComfyUI's
 * `POST /free` does not free anything before it answers:
 *
 *     @routes.post("/free")                        # ComfyUI server.py
 *     async def post_free(request):
 *         if unload_models: self.prompt_queue.set_flag("unload_models", unload_models)
 *         if free_memory:   self.prompt_queue.set_flag("free_memory", free_memory)
 *         return web.Response(status=200)
 *
 * The 200 certifies that a FLAG was set. The unload itself runs on ComfyUI's prompt-worker
 * thread, which reads those flags in its own loop (`main.py`: `flags = q.get_flags()` →
 * `unload_all_models()` → `gc.collect()` / `soft_empty_cache()`). Reading `/system_stats`
 * on the next line after the 200 therefore races that thread and reliably photographs the
 * PRE-free numbers — the reporter's `before_mb == after_mb == 9426, freed_mb: 0` on a card
 * that a health call found at 10.7/12.0 GB free moments later.
 *
 * And that loop only reaches `get_flags()` AFTER the prompt it is currently executing
 * finishes, so a /free issued during a render is genuinely queued behind it for as long as
 * the render takes. "Occupancy did not drop" is therefore an ordinary PENDING outcome — not
 * a failed free, and not the pinned device that prescribes a restart.
 *
 * So: settle before reporting (`settleVramOccupancyAfterFree`), and let the branch follow
 * what was actually observed.
 *
 * Four honest branches, all after a POST /free 2xx:
 *   - `verified_system_stats`  — occupancy was re-read and DROPPED.        freed:true
 *   - `unload_not_observed`    — re-read for the whole budget, no drop.    freed:false,
 *                                outcome:"pending" — the flag is set, ComfyUI has not
 *                                applied it yet.
 *   - `after_only_occupancy`   — no comparable baseline: the BEFORE read missed, or no
 *                                device in it could be matched to the after reading, so
 *                                this call cannot say whether anything moved.  freed:true
 *   - `bare_free_receipt`      — occupancy was not readable at all.        freed:true
 *
 * The #1956 rule still holds, and #2144 does not weaken it: an occupancy read that MISSES
 * never decides the command — it degrades to a receipt rather than failing a free that
 * already landed. What changed is the other half: an occupancy read that ANSWERS, and
 * answers "unchanged", is evidence, and is no longer allowed to be labelled verified.
 *
 * BECAUSE the numbers now decide `freed`, they are compared per DEVICE and never as a bare
 * total (`comparableUsedMb`). A device that drops out of `/system_stats` between the two
 * reads shrinks a total exactly like a successful unload does, so a sum-based verdict would
 * report a free that never happened — the same lie in the opposite direction.
 */

const BYTES_PER_MB = 1024 * 1024;

/** Total budget for waiting out ComfyUI's asynchronous unload after /free 2xx (#2144).
 *  Sized against the orchestrator's own 15 000 ms ceiling on this command
 *  (`ctx.call({cmd:"free_vram"}, 15000)` in comfyui-mcp's panel_free_vram): the settle
 *  shares that budget with the before-read, the POST and the final read, so it must leave
 *  the rest of the call room to answer. Overrunning it would trip the reply-timeout path,
 *  which re-issues /free directly — correct, but a worse receipt than this one. */
export const FREE_VRAM_SETTLE_BUDGET_MS = 5000;

/** Gap between occupancy samples while settling. Deliberately not tight: the worker thread
 *  holds the GIL through `unload_all_models()` and `gc.collect()`, so /system_stats — which
 *  is served by the same process — is slow exactly while the thing we are waiting for is
 *  happening. */
export const FREE_VRAM_SETTLE_POLL_MS = 250;

function roundMb(n) {
  return Math.round(Number(n) / BYTES_PER_MB);
}

/**
 * A VRAM counter, or `null` when the payload did not actually carry one.
 *
 * `Number()` alone is not enough: `Number(null)`, `Number("")`, `Number(false)` and
 * `Number([])` are all `0` and all finite, so a device reporting `vram_free: null` used to
 * parse as "0 bytes free" — the whole card occupied. That was cosmetic while these numbers
 * only decorated the reply; since #2144 they decide `freed`, so a counter that is not a
 * number is an UNREADABLE device, not a full one.
 */
function counterOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "object") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Stable identity for one `/system_stats` device row, so a before/after comparison can
 * match devices instead of trusting a total.
 *
 * ComfyUI emits `{name, type, index, …}` per device (`server.py`'s `/system_stats` builds
 * them from `get_all_torch_devices()`), so `type:index` is the exact key. `name` is the
 * fallback for older payloads that omit them — it carries the ordinal anyway
 * ("cuda:0 NVIDIA GeForce RTX 4070 Ti"). A row that yields neither is UNIDENTIFIABLE and
 * gets `null`, which excludes it from every comparison: an unmatchable device must not be
 * able to move a verdict.
 */
function deviceKeyOf(d) {
  let type = "";
  let index = null;
  try {
    type = typeof d?.type === "string" ? d.type : "";
    index = Number(d?.index);
  } catch {
    type = "";
    index = null;
  }
  if (type && Number.isFinite(index)) return `${type}:${index}`;
  let name = "";
  try {
    name = typeof d?.name === "string" ? d.name : "";
  } catch {
    name = "";
  }
  return name ? `name:${name}` : null;
}

/**
 * Device occupancy rows from a ComfyUI `/system_stats` payload.
 * Unreadable devices are skipped; an unreadable payload is `[]`.
 */
export function vramOccupancyFromStats(stats) {
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  const out = [];
  for (const d of devices) {
    let total;
    let free;
    try {
      total = counterOf(d?.vram_total);
      free = counterOf(d?.vram_free);
    } catch {
      continue;
    }
    if (total === null || free === null) continue;
    let name = "";
    try {
      name = typeof d?.name === "string" ? d.name : "";
    } catch {
      name = "";
    }
    out.push({
      name,
      device_key: deviceKeyOf(d),
      vram_total_mb: roundMb(total),
      vram_free_mb: roundMb(free),
      vram_used_mb: roundMb(total - free),
    });
  }
  return out;
}

function usedMb(rows) {
  return rows.reduce((sum, d) => sum + d.vram_used_mb, 0);
}

function occupancyRows(value) {
  return Array.isArray(value) && value.length ? value : null;
}

/** Rows indexed by device key. A key that appears twice in one reading is ambiguous, so
 *  BOTH copies are dropped rather than one of them silently winning. */
function keyedRows(rows) {
  const list = occupancyRows(rows);
  if (!list) return null;
  const byKey = new Map();
  const ambiguous = new Set();
  for (const row of list) {
    const key = row?.device_key;
    if (typeof key !== "string" || !key) continue;
    if (byKey.has(key)) {
      ambiguous.add(key);
      continue;
    }
    byKey.set(key, row);
  }
  for (const key of ambiguous) byKey.delete(key);
  return byKey;
}

/**
 * Used MB on each side, summed over the devices that appear — uniquely and identifiably —
 * in BOTH readings. `null` when no device can be matched.
 *
 * Comparing bare totals is what makes a DISAPPEARING device look like a free: with
 * `cuda:0` at 8000 MB and `cuda:1` at 2000 MB before, and only `cuda:0` answering after,
 * the totals fall 10000 → 8000 and a sum-based verdict reports `freed_mb: 2000` although
 * nothing was unloaded. `vramOccupancyFromStats` drops any device whose counters are
 * unreadable, so that shape needs only one flaky row, not a physically removed GPU. Before
 * #2144 the totals only decorated the reply; they now decide `freed`, so they have to be
 * about the same devices on both sides.
 */
export function comparableUsedMb(before, after) {
  const b = keyedRows(before);
  const a = keyedRows(after);
  if (!b || !a) return null;
  let beforeMb = 0;
  let afterMb = 0;
  const devices = [];
  for (const [key, row] of b) {
    const other = a.get(key);
    if (!other) continue;
    beforeMb += row.vram_used_mb;
    afterMb += other.vram_used_mb;
    devices.push(key);
  }
  return devices.length ? { beforeMb, afterMb, devices } : null;
}

/** Monotonic default clock — never runs backwards, so a wall-clock correction cannot make
 *  the settle budget expire early or never (the repo's standing rule; `monotonicNow()` in
 *  comfyui-mcp-panel.js and the reconnect-staleness header say the same). */
function defaultNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Best-effort occupancy. Returns `null` rather than throwing — a miss must not
 * fail a /free that already succeeded.
 */
export async function readVramOccupancy(fetchApi) {
  try {
    if (typeof fetchApi !== "function") return null;
    const res = await fetchApi("/system_stats", { cache: "no-store" });
    if (!res || !res.ok) return null;
    const stats = await res.json();
    const rows = vramOccupancyFromStats(stats);
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Re-read occupancy after a /free 2xx until it DROPS below the pre-free baseline, or until
 * the budget expires (#2144). Returns the last reading, plus how long it took and how many
 * samples it cost, so the reply can state what was actually watched.
 *
 * Stops at the first strict decrease, and that is enough: ComfyUI's worker sets
 * `last_gc_collect = 0` as it consumes the flags, which forces `gc.collect()` and
 * `soft_empty_cache()` to run in the SAME pass as `unload_all_models()` rather than being
 * deferred to the next 10 s tick. The drop is therefore one contiguous event, not a
 * staircase we would under-report by leaving early.
 *
 * "Dropped" is measured per DEVICE, not on a total — see `comparableUsedMb`. A device that
 * stops answering mid-settle would otherwise shrink the total and end the wait as if it had
 * been freed.
 *
 * Waits only when there is a baseline to compare against and something to free: with no
 * `before`, or a baseline of 0 MB, no amount of polling can produce an observation, so
 * burning the budget would only slow the command down.
 *
 * @param {(path: string, init?: object) => Promise<any>} fetchApi
 * @param {Array|null} before  occupancy read BEFORE POST /free, or null
 * @param {{budgetMs?: number, pollMs?: number, now?: () => number,
 *          sleep?: (ms: number) => Promise<void>}} [opts]  clock/timer injected for tests
 * @returns {Promise<{after: Array|null, observed: boolean, waitedMs: number, polls: number}>}
 */
export async function settleVramOccupancyAfterFree(fetchApi, before, opts = {}) {
  const {
    budgetMs = FREE_VRAM_SETTLE_BUDGET_MS,
    pollMs = FREE_VRAM_SETTLE_POLL_MS,
    now = defaultNow,
    sleep = defaultSleep,
  } = opts ?? {};

  const startedAt = now();
  const baseline = occupancyRows(before);
  // Only devices that can be identified can ever be compared, so only their occupancy is
  // worth waiting on: an unidentifiable row can never produce an observation.
  const identifiable = baseline ? [...(keyedRows(baseline)?.values() ?? [])] : [];
  const baselineMb = identifiable.length ? usedMb(identifiable) : null;

  let after = await readVramOccupancy(fetchApi);
  let polls = 1;
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));
  const dropped = () => {
    const cmp = comparableUsedMb(baseline, after);
    return cmp != null && cmp.afterMb < cmp.beforeMb;
  };

  if (baselineMb == null || baselineMb <= 0) {
    return { after, observed: dropped(), waitedMs: elapsed(), polls };
  }

  const deadline = startedAt + Math.max(0, Number(budgetMs) || 0);
  const gap = Math.max(0, Number(pollMs) || 0);
  // The deadline is checked BEFORE each sample, so a slow /system_stats can overrun it by at
  // most one read — it can never multiply into a second budget's worth of requests.
  while (!dropped() && now() < deadline) {
    await sleep(gap);
    if (now() >= deadline) break;
    const next = await readVramOccupancy(fetchApi);
    polls += 1;
    // Keep the last reading that ANSWERED: one transient miss mid-settle must not turn a
    // measured call into a bare receipt.
    if (next) after = next;
  }

  return { after, observed: dropped(), waitedMs: elapsed(), polls };
}

function settleFields(waitedMs, polls) {
  const fields = {};
  if (Number.isFinite(waitedMs)) fields.waited_ms = Math.max(0, Math.round(waitedMs));
  if (Number.isFinite(polls)) fields.samples = Math.max(1, Math.round(polls));
  return fields;
}

function notObservedNote(beforeMb, afterMb, waitedMs, polls) {
  const watched = Number.isFinite(waitedMs) ? `${Math.max(0, Math.round(waitedMs))} ms` : "the settle budget";
  const samples = Number.isFinite(polls) ? `${Math.max(1, Math.round(polls))} samples` : "repeated samples";
  return (
    `POST /free was accepted (unload_models and free_memory), but this call did NOT observe the ` +
    `unload happen: occupancy was re-read over ${watched} across ${samples} and did not drop ` +
    `(before_mb ${beforeMb} → after_mb ${afterMb}). ComfyUI's /free only SETS a flag on its ` +
    `prompt queue and returns 200 immediately; the unload runs afterwards on the prompt-worker ` +
    `thread, and that thread does not read the flag until the prompt it is currently executing ` +
    `finishes. So this is PENDING, not a failure — and NOT the "device still pinned" reading ` +
    `that would justify panel_restart_comfyui. If a render is in flight the unload is queued ` +
    `behind it; re-read VRAM with get_system_stats once the queue is idle. /free is idempotent, ` +
    `so re-issuing it cannot double-apply anything. Note also that /system_stats reports the ` +
    `whole device, so occupancy held by another process on the same card cannot be freed here.`
  );
}

/**
 * Reply payload after POST /free 2xx. The branch and the `freed` claim follow the numbers
 * this call actually measured — `freed:true` is never asserted alongside occupancy that was
 * read and did not move (#2144).
 *
 * The verdict is DERIVED here from `before`/`after` rather than accepted from the caller:
 * a settle loop and a reply that disagreed about what was observed is precisely the split
 * this bug was made of.
 */
export function freeVramSuccessResult({ before = null, after = null, waitedMs, polls } = {}) {
  const base = { unload_models: true, free_memory: true };
  const beforeOcc = occupancyRows(before);
  const afterOcc = occupancyRows(after);
  // The verdict, and every number quoted beside it, come from the SAME matched device set.
  // Reporting a total the verdict was not taken on is how a reply ends up self-contradicting.
  const cmp = beforeOcc && afterOcc ? comparableUsedMb(beforeOcc, afterOcc) : null;
  if (cmp) {
    const { beforeMb, afterMb, devices } = cmp;
    const occupancy = {
      before_mb: beforeMb,
      after_mb: afterMb,
      freed_mb: beforeMb - afterMb,
      compared_devices: devices,
      ...settleFields(waitedMs, polls),
      devices_before: beforeOcc,
      devices_after: afterOcc,
    };
    if (afterMb < beforeMb) {
      return { freed: true, ...base, branch: "verified_system_stats", occupancy };
    }
    return {
      freed: false,
      ...base,
      outcome: "pending",
      branch: "unload_not_observed",
      occupancy,
      note: notObservedNote(beforeMb, afterMb, waitedMs, polls),
    };
  }
  if (afterOcc) {
    return {
      freed: true,
      ...base,
      branch: "after_only_occupancy",
      occupancy: {
        after_mb: usedMb(afterOcc),
        ...settleFields(waitedMs, polls),
        ...(beforeOcc ? { devices_before: beforeOcc } : {}),
        devices_after: afterOcc,
      },
      note:
        "POST /free accepted this request (unload_models and free_memory), but there is no " +
        "comparable baseline: either /system_stats did not answer BEFORE the free, or no device " +
        "in that reading could be matched to a device in this one. So this reply cannot say how " +
        "much was freed — after_mb is the occupancy now, not a measured change.",
    };
  }
  return {
    freed: true,
    ...base,
    branch: "bare_free_receipt",
    note:
      "POST /free accepted this request (unload_models and free_memory). Occupancy was not " +
      "re-read from /system_stats, so no MB before/after is available.",
  };
}
