/**
 * #1956 — panel_free_vram success must say which branch ran and include the
 * occupancy numbers the shipped path actually has. `{freed:true}` alone is the
 * misleading receipt.
 *
 * #2144 — and the numbers must be measured after the free actually happens.
 * ComfyUI's POST /free only sets a flag on the prompt queue and returns 200; the
 * unload runs later on the prompt-worker thread. Reading /system_stats on the next
 * line races that thread, which is how the reporter got
 * `branch: verified_system_stats, before_mb 9426 → after_mb 9426, freed_mb 0` on a
 * card that was 10.7/12.0 GB free moments afterwards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FREE_VRAM_SETTLE_BUDGET_MS,
  FREE_VRAM_SETTLE_POLL_MS,
  comparableUsedMb,
  freeVramSuccessResult,
  readVramOccupancy,
  settleVramOccupancyAfterFree,
  vramOccupancyFromStats,
} from "../../web/js/lib/vram-occupancy.js";
import { describeHttpFailure } from "../../web/js/lib/http-failure.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");
const libSrc = readFileSync(
  fileURLToPath(new URL("../../web/js/lib/vram-occupancy.js", import.meta.url)),
  "utf8",
);

const MB = 1024 * 1024;
const stats = (usedMb, totalMb = 16384) => ({
  devices: [
    {
      name: "cuda:0 NVIDIA GeForce RTX 5080",
      vram_total: totalMb * MB,
      vram_free: (totalMb - usedMb) * MB,
    },
  ],
});

/** A multi-GPU /system_stats payload. Each entry is `[usedMb, index]`; ComfyUI emits
 *  `type` and `index` per device, which is what makes a device identifiable. */
const multiStats = (entries, totalMb = 12282) => ({
  devices: entries.map(([usedMb, index]) => ({
    name: `cuda:${index} NVIDIA GeForce RTX 4070 Ti`,
    type: "cuda",
    index,
    vram_total: totalMb * MB,
    vram_free: (totalMb - usedMb) * MB,
  })),
});
function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const methodStart = panelSrc.indexOf("async free_vram()");
assert.ok(methodStart > 0, "free_vram executor not found");
const methodEnd = panelSrc.indexOf("\n  },", methodStart);
const methodSrc = panelSrc.slice(methodStart, methodEnd + 4);

/**
 * Run the SHIPPED executor source. `settle` is injected so a test can shrink the
 * five-second budget; the default is the real helper with the real budget, and the
 * "waits for the drop" test below deliberately uses that default so the wiring is
 * exercised end to end rather than through a stub.
 */
function realFreeVram({ fetchApi, backendDown = false, settle = settleVramOccupancyAfterFree }) {
  const factory = new Function(
    "api",
    "describeHttpFailure",
    "comfyBackendIsDown",
    "readVramOccupancy",
    "freeVramSuccessResult",
    "settleVramOccupancyAfterFree",
    `const executors = { ${methodSrc} };\nreturn executors.free_vram;`,
  );
  const api = { fetchApi };
  return factory(
    api,
    describeHttpFailure,
    () => backendDown,
    readVramOccupancy,
    freeVramSuccessResult,
    settle,
  ).call({});
}

/** A fake ComfyUI whose occupancy drops only after `dropAfterReads` post-/free reads —
 *  the asynchronous unload this whole fix is about. */
function asyncFreeingComfy({ usedBefore = 9426, usedAfter = 1500, dropAfterReads = 2 } = {}) {
  const calls = [];
  let postFreeReads = 0;
  const fetchApi = async (path, init) => {
    calls.push({ path, method: init?.method });
    if (path === "/free") return jsonRes({}, 200);
    if (path === "/system_stats") {
      const freed = calls.some((c) => c.path === "/free");
      if (!freed) return jsonRes(stats(usedBefore, 12282));
      postFreeReads += 1;
      const used = postFreeReads > dropAfterReads ? usedAfter : usedBefore;
      return jsonRes(stats(used, 12282));
    }
    throw new Error(`unexpected ${path}`);
  };
  return { fetchApi, calls, statsReads: () => postFreeReads };
}

/** The NAIVE total the pre-review code compared on — kept only to demonstrate that the
 *  hazard is real, never used by production. */
const usedTotal = (rows) => rows.reduce((sum, d) => sum + d.vram_used_mb, 0);

/** Deterministic clock + sleep: `sleep(ms)` advances the clock instead of waiting. */
function fakeClock() {
  let t = 1000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

test("#1956 occupancy parser reports used/free/total MB", () => {
  const rows = vramOccupancyFromStats(stats(4096, 16384));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vram_used_mb, 4096);
  assert.equal(rows[0].vram_free_mb, 12288);
  assert.equal(rows[0].vram_total_mb, 16384);
});

test("#1956 verified before/after includes freed_mb and the branch name", () => {
  const result = freeVramSuccessResult({
    before: vramOccupancyFromStats(stats(8000)),
    after: vramOccupancyFromStats(stats(1200)),
  });
  assert.equal(result.freed, true);
  assert.equal(result.unload_models, true);
  assert.equal(result.free_memory, true);
  assert.equal(result.branch, "verified_system_stats");
  assert.equal(result.occupancy.before_mb, 8000);
  assert.equal(result.occupancy.after_mb, 1200);
  assert.equal(result.occupancy.freed_mb, 6800);
});

test("#1956 missing occupancy is an honest bare /free receipt, still success", () => {
  const result = freeVramSuccessResult({});
  assert.equal(result.freed, true);
  assert.equal(result.branch, "bare_free_receipt");
  assert.equal(result.occupancy, undefined);
  assert.match(result.note, /\/system_stats/);
  assert.match(result.note, /no MB/);
});

test("#1956 readVramOccupancy swallows a miss rather than throwing", async () => {
  assert.equal(await readVramOccupancy(null), null);
  assert.equal(await readVramOccupancy(async () => jsonRes({}, 500)), null);
  assert.equal(
    await readVramOccupancy(async () => {
      throw new Error("Failed to fetch");
    }),
    null,
  );
});

test("#1956 shipped free_vram reports verified occupancy on a healthy /system_stats", async () => {
  const calls = [];
  const fetchApi = async (path, init) => {
    calls.push({ path, method: init?.method });
    if (path === "/system_stats") {
      const used = calls.filter((c) => c.path === "/free").length ? 500 : 4000;
      return jsonRes(stats(used));
    }
    if (path === "/free") return jsonRes({ success: true });
    throw new Error(`unexpected ${path}`);
  };
  const result = await realFreeVram({ fetchApi });
  assert.equal(result.freed, true);
  assert.equal(result.branch, "verified_system_stats");
  assert.equal(result.occupancy.before_mb, 4000);
  assert.equal(result.occupancy.after_mb, 500);
  assert.equal(result.occupancy.freed_mb, 3500);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/system_stats", "/free", "/system_stats"],
  );
});

test("#1956 shipped free_vram still succeeds when /system_stats is down — bare receipt", async () => {
  const fetchApi = async (path) => {
    if (path === "/system_stats") return jsonRes({}, 404);
    if (path === "/free") return jsonRes({ success: true });
    throw new Error(`unexpected ${path}`);
  };
  const result = await realFreeVram({ fetchApi });
  assert.equal(result.freed, true);
  assert.equal(result.branch, "bare_free_receipt");
  assert.match(result.note, /bare|not re-read|no MB/i);
});

test("#1956 shipped free_vram still fails closed on a not-ok /free", async () => {
  const fetchApi = async (path) => {
    if (path === "/system_stats") return jsonRes(stats(1000));
    if (path === "/free") return jsonRes({ error: "nope" }, 502);
    throw new Error(`unexpected ${path}`);
  };
  await assert.rejects(() => realFreeVram({ fetchApi }), /free VRAM|502/);
});

test("#1956 WIRING: free_vram returns freeVramSuccessResult, not a bare {freed:true}", () => {
  assert.match(methodSrc, /freeVramSuccessResult\(/);
  assert.doesNotMatch(
    methodSrc,
    /return \{ freed: true, unload_models: true, free_memory: true \}/,
  );
});

// ---------------------------------------------------------------------------
// #2144 — the free is asynchronous, so the reply must settle before it claims.
// ---------------------------------------------------------------------------

test("#2144 occupancy that was re-read and did NOT move is pending, not freed", () => {
  // The reporter's exact numbers: 12282 MB card, 2856 MB free on both sides.
  const pinned = vramOccupancyFromStats(stats(9426, 12282));
  const result = freeVramSuccessResult({
    before: pinned,
    after: vramOccupancyFromStats(stats(9426, 12282)),
    waitedMs: 5000,
    polls: 19,
  });
  assert.equal(result.freed, false, "freed:true alongside freed_mb:0 is the reported defect");
  assert.equal(result.outcome, "pending");
  assert.equal(result.branch, "unload_not_observed");
  assert.notEqual(result.branch, "verified_system_stats");
  assert.equal(result.occupancy.before_mb, 9426);
  assert.equal(result.occupancy.after_mb, 9426);
  assert.equal(result.occupancy.freed_mb, 0);
  assert.equal(result.occupancy.waited_ms, 5000);
  assert.equal(result.occupancy.samples, 19);
  // The POST still landed, so the reply must not read as a failure or prescribe a restart.
  assert.match(result.note, /PENDING/);
  assert.match(result.note, /idempotent/);
  assert.match(result.note, /NOT the "device still pinned"|not a failure/i);
  assert.match(result.note, /panel_restart_comfyui/);
});

test("#2144 occupancy that GREW is not a free either", () => {
  const result = freeVramSuccessResult({
    before: vramOccupancyFromStats(stats(4000)),
    after: vramOccupancyFromStats(stats(4200)),
  });
  assert.equal(result.freed, false);
  assert.equal(result.branch, "unload_not_observed");
  assert.equal(result.occupancy.freed_mb, -200);
});

test("#2144 an after-only reading has no baseline and says so", () => {
  const result = freeVramSuccessResult({ after: vramOccupancyFromStats(stats(4000)) });
  assert.equal(result.freed, true, "a missed BEFORE read must not fail a /free that landed");
  assert.equal(result.branch, "after_only_occupancy");
  assert.notEqual(result.branch, "verified_system_stats");
  assert.equal(result.occupancy.after_mb, 4000);
  assert.equal(result.occupancy.before_mb, undefined);
  assert.match(result.note, /baseline/i);
});

test("#2144 settle keeps polling until occupancy drops", async () => {
  const clock = fakeClock();
  const comfy = asyncFreeingComfy({ dropAfterReads: 3 });
  await comfy.fetchApi("/free", { method: "POST" }); // mark the free as posted
  const before = vramOccupancyFromStats(stats(9426, 12282));
  const settled = await settleVramOccupancyAfterFree(comfy.fetchApi, before, {
    budgetMs: 5000,
    pollMs: 250,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(settled.observed, true);
  assert.equal(settled.polls, 4, "stops at the first sample that shows the drop");
  assert.equal(settled.waitedMs, 750);
  assert.equal(settled.after[0].vram_used_mb, 1500);
});

test("#2144 settle gives up at the budget and reports NOT observed", async () => {
  const clock = fakeClock();
  const comfy = asyncFreeingComfy({ dropAfterReads: Number.POSITIVE_INFINITY });
  await comfy.fetchApi("/free", { method: "POST" });
  const before = vramOccupancyFromStats(stats(9426, 12282));
  const settled = await settleVramOccupancyAfterFree(comfy.fetchApi, before, {
    budgetMs: 1000,
    pollMs: 250,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(settled.observed, false);
  assert.equal(settled.waitedMs, 1000, "bounded — it does not poll forever");
  assert.ok(settled.polls <= 5, `polls bounded by the budget, got ${settled.polls}`);
});

test("#2144 settle does not burn the budget when there is no baseline to compare", async () => {
  const clock = fakeClock();
  const comfy = asyncFreeingComfy({ dropAfterReads: Number.POSITIVE_INFINITY });
  await comfy.fetchApi("/free", { method: "POST" });
  const settled = await settleVramOccupancyAfterFree(comfy.fetchApi, null, {
    budgetMs: 5000,
    pollMs: 250,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(settled.polls, 1);
  assert.equal(settled.waitedMs, 0);
  assert.equal(settled.observed, false);
});

test("#2144 a transient /system_stats miss mid-settle keeps the reading that answered", async () => {
  const clock = fakeClock();
  let n = 0;
  const fetchApi = async () => {
    n += 1;
    if (n === 1) return jsonRes(stats(9426, 12282)); // still pinned
    if (n === 2) return jsonRes({}, 503); // transient miss
    return jsonRes(stats(1500, 12282)); // freed
  };
  const settled = await settleVramOccupancyAfterFree(
    fetchApi,
    vramOccupancyFromStats(stats(9426, 12282)),
    { budgetMs: 5000, pollMs: 250, now: clock.now, sleep: clock.sleep },
  );
  assert.equal(settled.observed, true);
  assert.equal(settled.after[0].vram_used_mb, 1500);
});

test("#2144 a miss on the LAST sample keeps the numbers, it does not erase them", async () => {
  // The mid-settle case is recovered by the next read; this one is not, so the guard that
  // keeps the last reading that ANSWERED is the only thing standing between a measured
  // `unload_not_observed` and a numberless bare receipt.
  const clock = fakeClock();
  let n = 0;
  const fetchApi = async () => {
    n += 1;
    if (n === 1) return jsonRes(stats(9426, 12282)); // answered, still pinned
    return jsonRes({}, 503); // and every later sample misses
  };
  const before = vramOccupancyFromStats(stats(9426, 12282));
  const settled = await settleVramOccupancyAfterFree(fetchApi, before, {
    budgetMs: 300,
    pollMs: 250,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.ok(n > 1, `the settle must have sampled again, got ${n} read(s)`);
  assert.notEqual(settled.after, null, "the reading that answered must survive a later miss");
  assert.equal(settled.after[0].vram_used_mb, 9426);
  assert.equal(settled.observed, false);
  const result = freeVramSuccessResult({ before, after: settled.after });
  assert.equal(result.branch, "unload_not_observed");
  assert.notEqual(result.branch, "bare_free_receipt");
  assert.equal(result.occupancy.after_mb, 9426);
});
test("#2144 an unreadable settle degrades to the bare receipt, never to a failure", async () => {
  const clock = fakeClock();
  const settled = await settleVramOccupancyAfterFree(async () => jsonRes({}, 500), null, {
    budgetMs: 500,
    pollMs: 100,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(settled.after, null);
  const result = freeVramSuccessResult({ before: null, after: settled.after });
  assert.equal(result.freed, true);
  assert.equal(result.branch, "bare_free_receipt");
});

test("#2144 SHIPPED free_vram waits out the async unload instead of photographing it", async () => {
  // No injected settle: the real helper, the real 250 ms cadence, the real budget.
  const comfy = asyncFreeingComfy({ usedBefore: 9426, usedAfter: 1500, dropAfterReads: 2 });
  const result = await realFreeVram({ fetchApi: comfy.fetchApi });
  assert.equal(result.branch, "verified_system_stats");
  assert.equal(result.freed, true);
  assert.equal(result.occupancy.before_mb, 9426);
  assert.equal(result.occupancy.after_mb, 1500);
  assert.equal(
    result.occupancy.freed_mb,
    7926,
    "the pre-#2144 executor read once and reported freed_mb: 0 here",
  );
  assert.ok(comfy.statsReads() > 1, "it must re-read, not trust the first post-/free sample");
  assert.ok(result.occupancy.samples > 1);
});

test("#2144 SHIPPED free_vram reports pending when the unload never lands", async () => {
  // Budget shrunk here ONLY so the test does not sit out the real five seconds; the
  // shipped value is asserted separately below.
  const comfy = asyncFreeingComfy({ dropAfterReads: Number.POSITIVE_INFINITY });
  const result = await realFreeVram({
    fetchApi: comfy.fetchApi,
    settle: (fetchApi, before) =>
      settleVramOccupancyAfterFree(fetchApi, before, { budgetMs: 60, pollMs: 10 }),
  });
  assert.equal(result.freed, false);
  assert.equal(result.outcome, "pending");
  assert.equal(result.branch, "unload_not_observed");
  assert.equal(result.occupancy.freed_mb, 0);
  assert.match(result.note, /prompt-worker thread|currently executing/);
});

test("#2144 WIRING: the executor settles, and no longer takes a single post-/free reading", () => {
  assert.match(methodSrc, /settleVramOccupancyAfterFree\(/, "the call site must use the settle");
  assert.match(
    methodSrc,
    /freeVramSuccessResult\(\{ before, after, waitedMs, polls \}\)/,
    "the settle's measurements must reach the reply",
  );
  // The BEFORE read is still a plain readVramOccupancy; the AFTER read must not be.
  const afterPost = methodSrc.slice(methodSrc.indexOf('api.fetchApi("/free"'));
  assert.ok(afterPost.length > 0, "POST /free not found in the executor");
  assert.doesNotMatch(
    afterPost,
    /const after = await readVramOccupancy\(/,
    "reading occupancy once, immediately after the /free 200, is the #2144 defect",
  );
});

test("#2144 the shipped budget fits under the orchestrator's 15s ceiling on this command", () => {
  assert.ok(
    FREE_VRAM_SETTLE_BUDGET_MS >= 2000,
    `a settle shorter than 2s cannot outlast an unload, got ${FREE_VRAM_SETTLE_BUDGET_MS}`,
  );
  assert.ok(
    FREE_VRAM_SETTLE_BUDGET_MS <= 10000,
    `the orchestrator calls free_vram with a 15000 ms bound and the settle is not the only ` +
      `step in it, got ${FREE_VRAM_SETTLE_BUDGET_MS}`,
  );
  assert.ok(FREE_VRAM_SETTLE_POLL_MS > 0 && FREE_VRAM_SETTLE_POLL_MS <= 1000);
});

test("#2144 the settle budget is measured on a monotonic clock, never Date.now", () => {
  // A wall-clock correction mid-settle would end the budget early or never end it.
  assert.match(libSrc, /performance\.now\(\)/);
  const defaultNow = libSrc.slice(libSrc.indexOf("function defaultNow()"));
  const body = defaultNow.slice(0, defaultNow.indexOf("\n}"));
  assert.ok(body.length > 0, "defaultNow not found");
  assert.match(body, /performance\.now\(\)/);
  assert.doesNotMatch(
    body.slice(0, body.indexOf("performance.now()")),
    /Date\.now\(\)/,
    "Date.now must only ever be the fallback, never the primary reading",
  );
});

test("#2144 the panel row stops saying 'freed VRAM' for a pending unload", () => {
  const rowStart = panelSrc.indexOf('case "free_vram":');
  assert.ok(rowStart > 0, "free_vram summary row not found");
  const row = panelSrc.slice(rowStart, panelSrc.indexOf('case "workflow_save":', rowStart));
  assert.match(row, /r\.freed === false/);
  assert.match(row, /panel\.free_vram_pending/);
  assert.ok(
    row.indexOf("r.freed === false") < row.indexOf("panel.unloaded_models_freed_vram"),
    "the pending branch must be reached BEFORE the unconditional 'freed VRAM' row",
  );
});

// ---------------------------------------------------------------------------
// #2144 review round 1 — the verdict must not rest on a cross-device TOTAL.
// ---------------------------------------------------------------------------

test("#2144 a device that stops answering must not look like a free", () => {
  // cuda:0 8000 MB + cuda:1 2000 MB before; only cuda:0 answers after, unchanged.
  // A sum-based verdict sees 10000 -> 8000 and reports freed_mb 2000 for an unload
  // that never happened.
  const before = vramOccupancyFromStats(multiStats([[8000, 0], [2000, 1]]));
  const after = vramOccupancyFromStats(multiStats([[8000, 0]]));
  assert.equal(usedTotal(before), 10000, "the naive total really does fall");
  assert.equal(usedTotal(after), 8000);
  const result = freeVramSuccessResult({ before, after });
  assert.equal(result.freed, false);
  assert.equal(result.branch, "unload_not_observed");
  assert.equal(result.occupancy.freed_mb, 0, "the vanished device must not be counted as freed");
  assert.equal(result.occupancy.before_mb, 8000);
  assert.equal(result.occupancy.after_mb, 8000);
  assert.deepEqual(result.occupancy.compared_devices, ["cuda:0"]);
});

test("#2144 a device with unreadable counters vanishes from the rows — same hazard", () => {
  // vramOccupancyFromStats DROPS a device whose vram_free is not a number, so this
  // needs one flaky row, not a physically removed GPU.
  const before = vramOccupancyFromStats(multiStats([[8000, 0], [2000, 1]]));
  const flaky = multiStats([[8000, 0], [2000, 1]]);
  flaky.devices[1].vram_free = null;
  const after = vramOccupancyFromStats(flaky);
  assert.equal(after.length, 1, "the flaky row is dropped by the parser");
  const result = freeVramSuccessResult({ before, after });
  assert.equal(result.freed, false);
  assert.equal(result.occupancy.freed_mb, 0);
});

test("#2144 a real free on one card is still verified when another card vanishes", () => {
  const before = vramOccupancyFromStats(multiStats([[8000, 0], [2000, 1]]));
  const after = vramOccupancyFromStats(multiStats([[1000, 0]]));
  const result = freeVramSuccessResult({ before, after });
  assert.equal(result.freed, true);
  assert.equal(result.branch, "verified_system_stats");
  assert.equal(result.occupancy.freed_mb, 7000, "only the matched device is counted");
  assert.deepEqual(result.occupancy.compared_devices, ["cuda:0"]);
});

test("#2144 multi-GPU frees add up across the devices present on both sides", () => {
  const before = vramOccupancyFromStats(multiStats([[8000, 0], [2000, 1]]));
  const after = vramOccupancyFromStats(multiStats([[1000, 0], [500, 1]]));
  const result = freeVramSuccessResult({ before, after });
  assert.equal(result.freed, true);
  assert.equal(result.occupancy.before_mb, 10000);
  assert.equal(result.occupancy.after_mb, 1500);
  assert.equal(result.occupancy.freed_mb, 8500);
  assert.deepEqual(result.occupancy.compared_devices, ["cuda:0", "cuda:1"]);
});

test("#2144 an APPEARING device cannot be counted as occupancy that failed to free", () => {
  const before = vramOccupancyFromStats(multiStats([[8000, 0]]));
  const after = vramOccupancyFromStats(multiStats([[1000, 0], [9000, 1]]));
  const result = freeVramSuccessResult({ before, after });
  assert.equal(result.freed, true, "cuda:0 really did drop 8000 -> 1000");
  assert.equal(result.occupancy.freed_mb, 7000);
});

test("#2144 no matchable device at all is a receipt, never a claimed free", () => {
  const before = vramOccupancyFromStats(multiStats([[8000, 0]]));
  const after = vramOccupancyFromStats(multiStats([[1000, 7]]));
  assert.equal(comparableUsedMb(before, after), null);
  const result = freeVramSuccessResult({ before, after });
  assert.equal(result.freed, true, "an unanswerable comparison must not fail a /free that landed");
  assert.equal(result.branch, "after_only_occupancy");
  assert.notEqual(result.branch, "verified_system_stats");
  assert.equal(result.occupancy.freed_mb, undefined);
  assert.match(result.note, /could not be matched|comparable baseline/i);
});

test("#2144 a duplicated device key is ambiguous, so it is excluded from the compare", () => {
  const before = vramOccupancyFromStats(multiStats([[8000, 0], [2000, 0]]));
  const after = vramOccupancyFromStats(multiStats([[1000, 0], [500, 0]]));
  assert.equal(comparableUsedMb(before, after), null, "two cuda:0 rows cannot be matched");
  const result = freeVramSuccessResult({ before, after });
  assert.equal(result.branch, "after_only_occupancy");
});

test("#2144 a device row with no type/index falls back to its name as the key", () => {
  // The single-GPU payload the other tests use carries no `type`/`index` at all.
  const before = vramOccupancyFromStats(stats(9426, 12282));
  const after = vramOccupancyFromStats(stats(1500, 12282));
  assert.match(before[0].device_key, /^name:/);
  const result = freeVramSuccessResult({ before, after });
  assert.equal(result.branch, "verified_system_stats");
  assert.equal(result.occupancy.freed_mb, 7926);
});

test("#2144 the settle does not end early when a device drops out mid-wait", async () => {
  const clock = fakeClock();
  let n = 0;
  const fetchApi = async () => {
    n += 1;
    // cuda:1 disappears from the second sample onwards; cuda:0 never moves.
    return jsonRes(n === 1 ? multiStats([[8000, 0], [2000, 1]]) : multiStats([[8000, 0]]));
  };
  const before = vramOccupancyFromStats(multiStats([[8000, 0], [2000, 1]]));
  const settled = await settleVramOccupancyAfterFree(fetchApi, before, {
    budgetMs: 1000,
    pollMs: 250,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(settled.observed, false, "a vanished device is not an observed free");
  assert.equal(settled.waitedMs, 1000, "it waits out the whole budget rather than stopping");
});
