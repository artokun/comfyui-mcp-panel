// Run-completion lifecycle tracker.
//
// ComfyUI fires `executed` once PER output node, so a multi-output run would
// otherwise inject several fragmented image turns into the agent. We BUFFER a
// run's inline image refs (and video descriptors) by prompt_id as `executed`
// events arrive, then deliver ONE consolidated completion when that prompt
// *authoritatively* finishes.
//
// "Authoritative" is the whole point. Completion is keyed on the ComfyUI
// execution lifecycle for a SPECIFIC prompt_id — NOT on a debounce timer. The
// prior implementation flushed on a 1.5s debounce, which fired mid-run whenever
// two output nodes were >1.5s apart (a fast PreviewImage upstream of a slow
// KSampler is the normal shape of many graphs), producing partial batches, wrong
// durations, a prior run's buffer delivered as the current prompt's result, and
// the correct batch being dropped so the agent never resumed (#293/#224/#200/
// #269/#468).
//
// Model (the invariants that make partial/misattributed completion unreachable):
//   • A prompt is ACTIVE from the first sign it is running — `execution_start`
//     OR `executing(node)` (which always precedes that node's `executed`). This
//     is what closes the "missed execution_start" hole: even if the start frame
//     is dropped, the per-node `executing` marks the prompt active before any
//     output is buffered.
//   • The debounce timer NEVER flushes an ACTIVE prompt. While active it simply
//     re-arms (bounded, purely to cap timer churn) and then stops — it never
//     emits a partial batch, so a legitimately long run (video gen can far
//     exceed any fixed cutoff) is always completed by its real end signal with
//     the full batch and correct duration.
//   • The timer's ONLY flush is a last-resort safety net for an ORPHAN buffer we
//     have NO evidence is running (outputs arrived but no start and no
//     executing(node) — i.e. heavily dropped frames). Normal runs are always
//     active, so this path never fires for them.
//   • Authoritative flush triggers, each scoped to ONE prompt_id and carrying the
//     full buffered set: `execution_success(prompt_id)` (primary), the queue
//     going idle via `executing:null` (per-prompt end signal — ComfyUI emits it
//     exactly once at prompt end, never mid-run), and a NEW run starting (which
//     means every prior sequential run is done — flush them first so nothing
//     bleeds into the new run, including a legacy __no_prompt__ buffer).
//   • duration = finish − start, both from the same clock, anchored on the run
//     start and read at flush; a missing start yields a null (omitted) duration,
//     never a bogus 0.0s.
//
// The module owns ONLY lifecycle + buffering + timing. Presentation (note text,
// metadata fetch, sendFrame, video storyboard) stays with the caller via the
// `onFlush` callback, which receives the full, correctly-scoped batch — plus the
// prompt_id `key` for machine-readable attribution — exactly once per completion.

import { parseHistoryEntry } from "./history-reconcile.js";

export const NO_PROMPT_KEY = "__no_prompt__";

/**
 * @param {object} opts
 * @param {(payload:{key:string, promptId:(string|null), images:any[], videos:any[], durationMs:number|null, finishedAt:number}) => void} opts.onFlush
 *   Called exactly once per completed prompt that buffered ≥1 image or video,
 *   with the FULL batch for that prompt_id, the correct start→finish duration,
 *   and the prompt_id (`key`/`promptId`) so the delivery can be attributed.
 * @param {() => number} [opts.now]        Clock (injectable for tests).
 * @param {(fn:Function, ms:number) => any} [opts.setTimer]
 * @param {(t:any) => void} [opts.clearTimer]
 * @param {number} [opts.debounceMs]       Orphan-flush / re-arm interval (default 1500).
 * @param {number} [opts.maxRearms]        Re-arm churn cap for an active buffer (default 40).
 */
export function createRunCompletionTracker({
  onFlush,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  debounceMs = 1500,
  maxRearms = 40,
} = {}) {
  if (typeof onFlush !== "function") {
    throw new TypeError("createRunCompletionTracker requires an onFlush callback");
  }
  const key = (id) => id ?? NO_PROMPT_KEY;
  const promptIdOf = (k) => (k === NO_PROMPT_KEY ? null : k);
  const buffers = new Map(); // key -> { images: any[], videos: any[], timer, rearms }
  const active = new Set(); // keys ComfyUI currently reports as running
  const starts = new Map(); // key -> start timestamp
  // #370 reconciliation state. A run is PENDING from its first liveness signal
  // until its completion is CONFIRMED delivered to the agent. If the connection
  // drops (WS lost → execution_success missed, OR bridge down → the composed
  // frame silently dropped by sendFrame), the run stays pending and can be
  // recovered on reconnect by reconciling its prompt_id against `/history`.
  const pending = new Map(); // key -> { promptId, at }  (real prompt_ids only)
  // `delivered` is the IDEMPOTENCY FENCE: keys whose completion has been delivered
  // (live or via reconcile). It exists to suppress a DUPLICATE from a late WS
  // lifecycle replay for an already-delivered prompt (a reconnect replays the
  // buffered executed/execution_success within seconds). key -> deliveredAt so the
  // fence can be pruned by AGE — only once no late event could still arrive — which
  // bounds memory WITHOUT ever evicting a fence that's still doing its job.
  const delivered = new Map();
  // Far beyond any realistic WS-replay-after-reconnect delay, so pruning an entry
  // older than this can never re-open the double-delivery window it guards.
  const deliveredTtlMs = 10 * 60 * 1000;

  // Pending is a RECOVERY LEDGER, not a debounce cache: it holds exactly the runs
  // whose completion has NOT been confirmed delivered. Every entry is removed the
  // instant its run reaches a confirmed terminal outcome — execution_success/error
  // with a delivered frame, or a /history reconcile — so the map is self-limiting
  // to the (normally ≤1–2) currently-undelivered runs. It is deliberately NOT
  // size-capped: evicting an entry would permanently forfeit the ONLY record that
  // lets a bridge-down completion be recovered on reconnect, defeating #370 for
  // that prompt (codex P1). Entries are tiny ({promptId, at}); a large batch simply
  // registers each of its accepted prompt_ids and drains them as they finish —
  // ledger depth mirrors the actual ComfyUI queue depth, which the server bounds.
  function trackPending(id) {
    if (id == null) return; // no prompt_id ⇒ not reconcilable against /history
    const k = key(id);
    if (delivered.has(k)) return;
    if (!pending.has(k)) pending.set(k, { promptId: id, at: now() });
  }

  // Drop every fence older than the TTL. `delivered` is kept in strict
  // last-delivered order (markDelivered re-inserts, below), so the expired entries
  // are always a prefix — stop at the first fresh one. O(number actually pruned),
  // i.e. each entry is visited once over its lifetime.
  function pruneDeliveredFence() {
    const cutoff = now() - deliveredTtlMs;
    for (const [dk, at] of delivered) {
      if (at >= cutoff) break;
      delivered.delete(dk);
    }
  }

  // Age fences out even when NO further completion arrives (idle): a single
  // self-disarming sweep that re-arms only while fences remain, so memory is
  // bounded without a perpetual timer.
  let deliveredPruneTimer = null;
  function scheduleDeliveredPrune() {
    if (deliveredPruneTimer != null) return;
    deliveredPruneTimer = setTimer(() => {
      deliveredPruneTimer = null;
      pruneDeliveredFence();
      if (delivered.size) scheduleDeliveredPrune();
    }, deliveredTtlMs);
  }

  function markDelivered(id) {
    const k = key(id);
    // NO_PROMPT_KEY is a SHARED, reused key for every id-less run — it is never
    // reconcilable and must never enter the `delivered` fence, or the first id-less
    // run would permanently block all later ones (back-to-back id-less runs must
    // still each deliver, #224). It's also never in `pending` (trackPending skips
    // null ids), so there is nothing to retire here for it.
    if (k === NO_PROMPT_KEY) return;
    pruneDeliveredFence(); // trim expired fences on every delivery (active path)
    delivered.delete(k); // re-insert at the end so the map stays in delivery order
    delivered.set(k, now());
    pending.delete(k);
    scheduleDeliveredPrune(); // ensure idle fences also age out
  }

  function markStart(id) {
    const k = key(id);
    // First signal wins — a later per-node event must not reset an earlier start.
    if (!starts.has(k)) starts.set(k, now());
    // Bound the map so a run that never signals end can't leak entries.
    if (starts.size > 20) {
      const oldest = starts.keys().next().value;
      if (oldest !== k) starts.delete(oldest);
    }
  }

  function arm(k) {
    const buf = buffers.get(k);
    if (!buf) return;
    if (buf.timer) clearTimer(buf.timer);
    buf.timer = setTimer(() => {
      const b = buffers.get(k);
      if (!b) return;
      b.timer = null;
      if (active.has(k)) {
        // The prompt is (still) running per ComfyUI — NEVER flush a partial batch
        // (#293/#200). Re-arm a bounded number of times purely to cap timer churn,
        // then stop and wait for the authoritative end signal (success / queue
        // idle / next run). A legitimately long run is completed there, in full.
        if (b.rearms < maxRearms) {
          b.rearms += 1;
          arm(k);
        }
        return;
      }
      // Not active: we have NO evidence this prompt is running (no start, no
      // executing(node)) yet outputs arrived — an orphan from dropped frames.
      // Flush it as a last resort so images are never permanently stranded.
      flush(k);
    }, debounceMs);
  }

  function flush(k) {
    const buf = buffers.get(k);
    if (!buf) return;
    if (buf.timer) clearTimer(buf.timer);
    buffers.delete(k);
    // Read + retire the start synchronously so a concurrent flush can't
    // double-count it. A missing start ⇒ null duration (never a bogus 0.0s).
    const startTs = starts.get(k);
    starts.delete(k);
    const durationMs = startTs != null ? now() - startTs : null;
    if (!buf.images.length && !buf.videos.length) return;
    // Optimistically mark delivered so a reconnect-triggered reconcile racing
    // this flush can't double-deliver the same prompt. If the caller reports the
    // send FAILED (bridge down), it calls markUndelivered() to re-pend it (#370).
    markDelivered(k);
    onFlush({
      key: k,
      promptId: promptIdOf(k),
      images: buf.images,
      videos: buf.videos,
      durationMs,
      finishedAt: now(),
    });
  }

  function ensureBuffer(k) {
    let buf = buffers.get(k);
    if (!buf) {
      buf = { images: [], videos: [], timer: null, rearms: 0 };
      buffers.set(k, buf);
    }
    return buf;
  }

  return {
    /** ComfyUI `execution_start` — authoritative run-start for a prompt. */
    onExecutionStart(id) {
      const k = key(id);
      // Runs are sequential: a new run beginning means EVERY prior run has ended
      // (even one whose end signal we missed). Flush every existing buffer under
      // ITS OWN key/timing first, so an older buffer — including a legacy
      // __no_prompt__ one from the previous run — can never bleed into, or be
      // misreported as, this new run (#224). A run cannot have buffered output
      // before its own start, so nothing belonging to THIS run is lost here.
      //
      // NB: a prior run whose end signal was missed is flushed here with whatever
      // it buffered — the #224 safe default of "deliver what we have" — because a
      // missed end is USUALLY a dropped frame on a live connection with no
      // reconnect (hence no /history reconcile) ever coming. flush() marks it
      // delivered, so a LATER reconcile for that prompt is correctly a no-op; the
      // drop-with-reconnect case (where the next run does NOT start before the
      // reconnect) is still recovered in full by reconcile.
      for (const other of [...buffers.keys()]) flush(other);
      active.clear();
      markStart(id);
      active.add(k);
      trackPending(id);
    },

    /**
     * ComfyUI `executed` (per output node) — buffer this prompt's outputs.
     * @param {string|null} id
     * @param {{images?: any[], videos?: any[]}} outputs
     */
    onExecuted(id, { images = [], videos = [] } = {}) {
      if (!images.length && !videos.length) return;
      // Idempotency fence: if this prompt was ALREADY delivered (a /history
      // reconcile beat the live WS, which then replayed a late `executed`), do NOT
      // re-buffer it — otherwise the trailing execution_success would flush a
      // second, duplicate completion for the same run (codex P1).
      if (delivered.has(key(id))) return;
      // Fallback render-start if execution_start was missed (no-op otherwise).
      // Does NOT mark active: `executing(node)` is the run-liveness signal, so an
      // output with no start AND no executing(node) is treated as an orphan.
      markStart(id);
      trackPending(id);
      const k = key(id);
      const buf = ensureBuffer(k);
      if (images.length) buf.images.push(...images);
      if (videos.length) buf.videos.push(...videos);
      arm(k);
    },

    /** ComfyUI `execution_success` — the authoritative flush for THIS prompt. */
    onExecutionSuccess(id) {
      const k = key(id);
      active.delete(k);
      // Already delivered (e.g. via reconcile) — a late success must not deliver
      // again. Just retire any residual live state (codex P1 idempotency fence).
      if (delivered.has(k)) {
        starts.delete(k);
        return;
      }
      flush(k);
      // Retire start for runs that buffered nothing (flush early-returns then).
      starts.delete(k);
      // A terminal success we OBSERVED live needs no /history reconcile — clear it
      // from pending. (If the completion frame is later reported undelivered, the
      // caller's markUndelivered re-pends it, so a bridge-down drop still recovers.)
      markDelivered(k);
    },

    /** ComfyUI `execution_error` — drop this prompt's buffer, deliver no batch. */
    onExecutionFailed(id) {
      const k = key(id);
      active.delete(k);
      const buf = buffers.get(k);
      if (buf?.timer) clearTimer(buf.timer);
      buffers.delete(k);
      starts.delete(k);
      // If already delivered (reconcile surfaced this run's outcome), don't touch
      // pending/delivered again — the caller uses wasDelivered() BEFORE calling
      // this to suppress a duplicate run_error frame (codex P1).
      if (!delivered.has(k)) markDelivered(k);
    },

    /**
     * Legacy/secondary run-end: `executing` with node===null (queue idle).
     *
     * This flushes ONLY buffers whose prompt is NOT currently active — it can
     * never truncate a run ComfyUI still reports as in-flight (#200/#224). On
     * modern ComfyUI the authoritative `execution_success` has already cleared
     * `active` and flushed the buffer, so this is a no-op there; its remaining job
     * is a backstop for an ORPHAN/non-active leftover (e.g. a legacy __no_prompt__
     * buffer). Deliberately NOT trusting a possibly-spurious null to end an active
     * run is what makes an early/partial completion from a stray null unreachable.
     */
    onExecutingNull() {
      for (const k of [...buffers.keys()]) {
        if (!active.has(k)) flush(k);
      }
    },

    /**
     * `executing` with a node id. Anchors the render-start AND marks the prompt
     * active — this is the run-liveness signal that closes the "missed
     * execution_start" hole (it always precedes that node's `executed`), so the
     * timer can never early-flush a run whose start frame was dropped.
     */
    onExecutingNode(id) {
      if (id == null) return;
      // A late `executing` for an already-delivered run must not re-open it.
      if (delivered.has(key(id))) return;
      markStart(id);
      active.add(key(id));
      trackPending(id);
    },

    /**
     * Has this prompt's completion already been delivered (via live success or a
     * /history reconcile)? The caller checks this BEFORE surfacing a live
     * execution_error so a reconciled outcome isn't duplicated by a late WS event.
     */
    wasDelivered(id) {
      return delivered.has(key(id));
    },

    /**
     * Register a prompt_id the instant it is QUEUED (from the POST /prompt
     * response), before any WS lifecycle event. Closes the worst-case #370 hole:
     * a run that STARTS AND FINISHES entirely inside a connection drop — no
     * execution_start/executing/executed ever reaches us — is still reconcilable
     * against /history because we recorded its prompt_id at queue time.
     */
    onQueued(id) {
      trackPending(id);
    },

    /**
     * Caller reports the completion frame for `id` was CONFIRMED delivered to the
     * agent (sendFrame succeeded / batch was empty). Retires it from pending.
     */
    markDelivered(id) {
      markDelivered(id);
    },

    /**
     * Caller reports the completion frame for `id` could NOT be delivered (bridge
     * down when the flush fired). Re-pend it so the next reconnect recovers it via
     * /history — this is what makes a bridge-down drop, where we DID observe the
     * terminal success, still deliver the result on reconnect (#370).
     */
    markUndelivered(id) {
      if (id == null) return;
      const k = key(id);
      delivered.delete(k);
      if (!pending.has(k)) pending.set(k, { promptId: id, at: now() });
    },

    /**
     * Reconcile every still-pending prompt against ComfyUI's `/history` and
     * deliver any terminal outcome exactly once. Call on reconnect (WS back OR
     * bridge back).
     *
     * @param {object} args
     * @param {(promptId:string)=>Promise<object|null>} args.fetchHistory  Resolves
     *   the per-prompt `/history/<id>` entry (already unwrapped from `{[id]:…}`), or
     *   null when absent.
     * @param {(m:object)=>boolean} [args.isVideo]  Output classifier (see parse).
     * @returns {Promise<Array<{promptId:string, status:string, delivered?:boolean}>>}
     *   One row per pending prompt inspected — the caller surfaces error/unknown
     *   notices; SUCCESS batches are delivered here via onFlush.
     */
    async reconcile({ fetchHistory, isVideo } = {}) {
      const summary = [];
      pruneDeliveredFence(); // reconnect is a natural sweep point for old fences
      if (typeof fetchHistory !== "function") return summary;
      for (const [k, info] of [...pending.entries()]) {
        if (delivered.has(k)) {
          pending.delete(k);
          continue;
        }
        const promptId = info.promptId;
        if (promptId == null) continue;
        let entry = null;
        try {
          entry = await fetchHistory(promptId);
        } catch {
          // A live lifecycle event may have delivered+retired this prompt while
          // we awaited /history — don't emit an "unknown" for an already-resolved
          // run (TOCTOU across the await).
          if (delivered.has(k) || !pending.has(k)) continue;
          summary.push({ promptId, status: "unknown" });
          continue; // leave pending — a later reconnect can retry
        }
        // Re-check AFTER the await: if a live `execution_success`/`execution_error`
        // delivered and retired this prompt while /history was in flight, deliver
        // nothing here — otherwise we'd emit the same batch or run_error twice
        // (codex P1, reconcile TOCTOU).
        if (delivered.has(k) || !pending.has(k)) continue;
        const parsed = parseHistoryEntry(entry, { isVideo });
        if (!parsed) {
          summary.push({ promptId, status: "unknown" });
          continue; // leave pending
        }
        if (!parsed.terminal) {
          summary.push({ promptId, status: "running" });
          continue; // still in flight — the live lifecycle will complete it
        }
        // Terminal. Retire ALL live state for this key so a stale partial buffer
        // (from the pre-drop `executed` events) can never double-deliver later,
        // and mark it delivered BEFORE onFlush so a concurrent reconcile can't
        // race it.
        const buf = buffers.get(k);
        if (buf?.timer) clearTimer(buf.timer);
        buffers.delete(k);
        active.delete(k);
        const startTs = starts.get(k);
        starts.delete(k);
        markDelivered(k);
        if (parsed.status === "error") {
          summary.push({ promptId, status: "error" });
          continue; // no batch for a failed run (mirrors onExecutionFailed)
        }
        const hasBatch = parsed.images.length > 0 || parsed.videos.length > 0;
        if (hasBatch) {
          const durationMs = startTs != null ? now() - startTs : null;
          onFlush({
            key: k,
            promptId,
            images: parsed.images,
            videos: parsed.videos,
            durationMs,
            finishedAt: now(),
            reconciled: true,
          });
        }
        summary.push({ promptId, status: "success", delivered: hasBatch });
      }
      return summary;
    },

    /** Synchronous start lookup (diagnostics / fallbacks). */
    startFor(id) {
      return starts.get(key(id));
    },

    // Introspection for tests / diagnostics.
    _active: active,
    _buffers: buffers,
    _starts: starts,
    _pending: pending,
    _delivered: delivered,
  };
}
