// panel#1404 — `panel_refresh_nodes` timed out with no acknowledgement for 30 s against a
// ComfyUI that stayed healthy and idle, and the IDENTICAL call succeeded on the retry.
//
// The reply was not lost in transit. It was never COMPOSED inside the window: `refresh_nodes`
// is relayed at comfyui-mcp's `OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS` (30,000 ms) and was the
// only command relayed there that never took a command budget, so its forced coalescer call
// waited unbounded on an in-flight run AND on the trailing run queued behind it. Each run is
// ~14.5 s wall clock on the #610 install (NODE_DEFS_RUN_BUDGET_MS bounds only the WAITING it
// controls and stops its clock across `registerNodesFromDefs`), and two of them do not fit.
// The retry succeeds because by then the trailing run has settled and it pays for ONE.
//
// THE HARNESS RUNS THE SHIPPED `refresh_nodes` BODY, extracted from the panel source and
// given injected collaborators, over the REAL coalescer with a REAL in-flight run — the same
// technique as add-node-command-budget.test.mjs, and for the same reason. A helper-level test
// cannot reach this defect: `makeRefreshCoalescer` already accepts `joinMs` and already
// implements it correctly (#1192/#1351), and `refresh_nodes` already handled a non-fresh
// verdict. The whole bug was that the call site passed no bound. Only an assertion on THAT
// CALL SITE can see it — which is why every test below drives the extracted executor rather
// than the coalescer directly, and why deleting `joinMs` from the panel makes them fail.
import test from "node:test";
import assert from "node:assert/strict";

import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { makeRefreshCoalescer } from "../../web/js/lib/refresh-coalesce.js";
import { NODE_DEF_REFRESH_REASONS } from "../../web/js/lib/node-def-refresh.js";
import {
  PANEL_SRC,
  ADD_NODE_COMMAND_BUDGET_MS,
  REFRESH_NODES_COMMAND_BUDGET_MS,
  REFRESH_NODES_EXECUTOR_DEPS,
} from "./_panel-constants.mjs";

const refreshNodesMatch = PANEL_SRC.match(/\n {2}async refresh_nodes\(\) \{[\s\S]*?\n {2}\},/);
assert.ok(refreshNodesMatch, "could not locate refresh_nodes in panel source");

/** A tiny deferred so a test can hold the in-flight refresh open until it chooses. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Build the SHIPPED `refresh_nodes` with the REAL coalescer behind it.
 *
 * `budgetMs` is injected small so these tests run in milliseconds rather than waiting out the
 * shipped 25 s. Same code, same arithmetic, shorter deadline — the shipped NUMBER is pinned
 * separately, against the relay window, at the bottom of this file.
 *
 * `holdFirstRun` is a promise the FIRST run waits on before it registers anything. That run
 * is the one this panel starts for itself — a reconnect, a finished download, or the
 * missing-asset check that an upload triggers — and it is holding the coalescer's slot when
 * the tool call arrives. Held open, it is the reported scenario exactly.
 */
function realRefreshNodes({
  holdFirstRun = null,
  // Whether the held run is started BEFORE the tool call (someone else's, holding the slot)
  // or left for the tool call to start itself (nothing in flight — the uncontended case).
  startInFlight = true,
  budgetMs = 150,
  verdicts = [{ refreshed: true, reason: "refreshed" }],
} = {}) {
  let inFlight = null;
  const runs = [];
  const refreshComfyNodeDefs = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    runRegister: async () => {
      const index = runs.length;
      runs.push(index);
      if (index === 0 && holdFirstRun) await holdFirstRun;
      return verdicts[Math.min(index, verdicts.length - 1)];
    },
    withTimeout,
  });
  // A refresh THIS PANEL started — not the tool call — already holding the slot.
  const inFlightStarted =
    holdFirstRun && startInFlight ? refreshComfyNodeDefs(undefined, { force: true }) : null;

  const deps = {
    refreshComfyNodeDefs,
    // Every other binding from the one place that holds them, so this harness picks up a
    // new one automatically — then the budget, injected small, LAST so it wins.
    ...REFRESH_NODES_EXECUTOR_DEPS,
    REFRESH_NODES_COMMAND_BUDGET_MS: budgetMs,
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const executors = {${refreshNodesMatch[0]}};
     return executors.refresh_nodes;`,
  );
  return {
    refresh_nodes: factory(...names.map((n) => deps[n])),
    refreshComfyNodeDefs,
    getInFlight: () => inFlight,
    runs,
    inFlightStarted,
  };
}

/**
 * Await `run()` but FAIL LOUDLY rather than hang if the budget never reaches the coalescer.
 *
 * Without the fix this call resolves only once the held run releases, which is the whole
 * defect — and a test that simply awaited it would sit there being slow instead of red. The
 * elapsed time is returned so the caller can assert the bound was the thing that ended it.
 */
async function withWatchdog(run, ms, what) {
  let timer;
  const startedAt = Date.now();
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} — waited ${ms}ms`)), ms);
  });
  try {
    const value = await Promise.race([run(), watchdog]);
    return { value, elapsed: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 1. The reported shape: a run already in flight, and the tool call behind it.
// ---------------------------------------------------------------------------

test("#1404: refresh_nodes REPLIES at its budget instead of waiting two runs out", async () => {
  const gate = deferred();
  const built = realRefreshNodes({ holdFirstRun: gate.promise, budgetMs: 150 });

  const { value, elapsed } = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "refresh_nodes never replied: the command budget is not reaching the coalescer, so the " +
      "forced call is waiting for a run someone else started PLUS its own — the composition " +
      "that does not fit the 30,000 ms relay window",
  );

  assert.equal(value.ok, true, "nothing failed, so the command still succeeds");
  assert.equal(value.refreshed, false, "…but it must not claim a refresh it never confirmed");
  assert.ok(
    elapsed < 1000,
    `replied in ${elapsed}ms — the reply must be composed at the bound, not after the run`,
  );

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
});

test("#1404: the reply NAMES the cause instead of collapsing it into 'unknown'", async () => {
  const gate = deferred();
  const built = realRefreshNodes({ holdFirstRun: gate.promise, budgetMs: 150 });

  const { value } = await withWatchdog(() => built.refresh_nodes(), 1500, "refresh_nodes never replied");

  // The STRUCTURED field is the load-bearing part. A caller must never have to parse prose to
  // decide it may re-issue a command, and "unknown" — what the generic branch produces for a
  // Symbol — would make a refresh that is still running indistinguishable from a fetch that
  // threw, which is the one distinction a caller deciding whether to retry actually needs.
  // THE LITERAL, not only the map lookup. The panel and this file read the token from the
  // SAME frozen map, so deleting the entry degrades both to `undefined` together and
  // `assert.equal(undefined, undefined)` passes — while the shipped reply carries
  // `reason: undefined`, which `JSON.stringify` DROPS, so the field a caller keys on
  // vanishes from the wire with all 67 tests in the three refresh harnesses still green.
  // Measured, not reasoned about: that mutation was run and killed nothing.
  assert.equal(value.reason, "refresh_still_running", "the WIRE token, spelled out");
  assert.equal(NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING, "refresh_still_running");
  assert.equal(value.reason, NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING);
  assert.notEqual(value.reason, "unknown", "an abandoned wait is not an unknown failure");
  assert.match(value.remedy, /RETRY/, "…and the remedy is a retry");
  // A tab reload throws away canvas state, so it may only ever be the ESCALATION — named
  // after the retry, and conditioned on the retry not working. #852/#663: a refusal that
  // sends the caller to the wrong recovery costs more than the refusal itself.
  assert.ok(
    value.remedy.indexOf("RETRY") < value.remedy.search(/reload/i),
    "reload must come after the retry, never instead of it",
  );
  assert.match(value.remedy, /keeps reporting this[\s\S]*reload/i, "…and only if retrying fails");
  assert.match(
    value.detail,
    /[Nn]othing failed/,
    "the caller must know nothing was left half-done before it retries",
  );
  // BOTH runs. The coalescer returns one symbol whether the budget went on a run someone
  // else started or on this command's own, so a detail naming only the first would be
  // flatly wrong on an uncontended big install — the case with no concurrency at all.
  assert.match(value.detail, /something else started/, "the contended case");
  assert.match(value.detail, /own registration/, "…and this command's own run");

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
});

test("#1404: the abandoned run is NOT cancelled, and the retry it asks for succeeds", async () => {
  // This is why the remedy is honest rather than hopeful, and it is also the reporter's
  // observation: the identical call succeeded on the second attempt. The coalescer does not
  // cancel what it stopped waiting for, so the retry pays for ONE run rather than two.
  const gate = deferred();
  const built = realRefreshNodes({
    holdFirstRun: gate.promise,
    budgetMs: 150,
    verdicts: [{ refreshed: true, reason: "refreshed" }],
  });

  const first = await withWatchdog(() => built.refresh_nodes(), 1500, "refresh_nodes never replied");
  assert.equal(first.value.refreshed, false);
  assert.notEqual(built.getInFlight(), null, "the run this call abandoned still holds the slot");

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});

  const second = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "the retry the remedy prescribes never replied either",
  );
  assert.deepEqual(second.value, { ok: true, refreshed: true });
});

test("#1404: an UNCONTENDED run that outlives the budget lands on the same named verdict", async () => {
  // The other half of the symbol, and the reason the detail names both runs. With nothing in
  // flight the coalescer takes the last branch — `waitForRun(startRun(…), joinMs)` — so the
  // budget can run out on a run this command started ITSELF, with no concurrency anywhere.
  // That is a big install's ordinary case, and a reply that blamed "something else" for it
  // would be a true-sounding statement about the wrong cause.
  const gate = deferred();
  // Held, but NOT pre-started: the slot is empty when the tool call arrives, so the run that
  // outlives the bound is the one this command started itself.
  const built = realRefreshNodes({ holdFirstRun: gate.promise, startInFlight: false, budgetMs: 150 });

  const { value, elapsed } = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "an uncontended slow run never replied",
  );
  assert.equal(value.reason, "refresh_still_running");
  assert.equal(built.runs.length, 1, "there was never a second run — nothing else was in flight");
  assert.ok(elapsed < 1000, `replied in ${elapsed}ms — the bound must end this wait too`);

  gate.resolve();
});

// ---------------------------------------------------------------------------
// 2. What the bound must NOT break.
// ---------------------------------------------------------------------------

test("#1404: an uncontended refresh still reports its real verdict, disclosures included", async () => {
  // The bound is a deadline for waiting, not a shortcut past the answer. #981/#1172/#1193/#1275
  // each had to be forwarded through this executor's fixed object literal; a budget that
  // dropped one of them would re-silence exactly the disclosure it was added for.
  const built = realRefreshNodes({
    budgetMs: 5000,
    verdicts: [
      {
        refreshed: true,
        reason: "refreshed",
        requires_reload: true,
        stale_placeholders: ["LoadImage#7"],
        stale_placeholders_note: "note",
        empty_combo_lists: ["ckpt_name"],
        empty_combo_lists_note: "empty note",
        restored_nodes: ["3"],
        restored_nodes_note: "restored note",
        combo_refresh_confirmed: false,
        combo_refresh_note: "combo note",
      },
    ],
  });

  const { value } = await withWatchdog(() => built.refresh_nodes(), 2000, "refresh_nodes never replied");
  assert.equal(value.refreshed, true);
  assert.equal(value.requires_reload, true);
  assert.deepEqual(value.stale_placeholders, ["LoadImage#7"]);
  assert.deepEqual(value.empty_combo_lists, ["ckpt_name"]);
  assert.deepEqual(value.restored_nodes, ["3"]);
  assert.equal(value.combo_refresh_confirmed, false);
});

test("#1404: a run that genuinely FAILED still reports its own reason, not the new one", async () => {
  // The two states must stay distinguishable in BOTH directions. A budget that reported
  // `refresh_still_running` for a fetch that threw would send the caller to retry forever
  // against a backend that is down — the mirror image of the bug this fixes.
  const built = realRefreshNodes({
    budgetMs: 5000,
    verdicts: [
      {
        refreshed: false,
        reason: NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED,
        remedy: "check that ComfyUI is running",
      },
    ],
  });

  const { value } = await withWatchdog(() => built.refresh_nodes(), 2000, "refresh_nodes never replied");
  assert.equal(value.reason, NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED);
  assert.equal(value.remedy, "check that ComfyUI is running");
});

// ---------------------------------------------------------------------------
// 3. The shipped number, against the window it exists for.
// ---------------------------------------------------------------------------

test("#1404: the shipped budget leaves the relay window room to carry the reply", () => {
  // comfyui-mcp relays `refresh_nodes` at OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS = 30,000 ms. That
  // constant lives in the OTHER repo, so this asserts the property this repo can keep true:
  // the budget is the SAME number `graph_add_node` and `nodes_install` already derived against
  // that window, so the three cannot drift into disagreeing about what "too long" means.
  assert.equal(
    REFRESH_NODES_COMMAND_BUDGET_MS,
    ADD_NODE_COMMAND_BUDGET_MS,
    "the two commands relayed in the same window must hold the same budget",
  );
  assert.ok(
    REFRESH_NODES_COMMAND_BUDGET_MS > 0 && REFRESH_NODES_COMMAND_BUDGET_MS <= 25000,
    "a budget at or over the relay window would restore the bug it exists to prevent",
  );
});

test("#1404: the shipped call site passes the budget — the helper alone cannot prove this", () => {
  // `makeRefreshCoalescer` has accepted `joinMs` since #1192 and implements it correctly; the
  // whole of #1404 was that this one call site never passed it. A behavioural test drives the
  // extracted body, so it already covers the wiring — this is the same fact asserted where a
  // reviewer reading the diff will look for it, on the SOURCE.
  // #1562 — the same shape, now with the RUN allowance beside the JOIN. The two are
  // different quantities and both belong here: `joinMs` is how long this command WAITS,
  // `runBudgetMs` is how long the run it starts may SPEND, and a run that gives up first
  // makes the retryable `refresh_still_running` verdict below unreachable. The comment
  // between them is skipped by `[\s\S]*?`, deliberately — pinning prose is not the point —
  // but BOTH options are required by name.
  assert.match(
    refreshNodesMatch[0],
    /refreshComfyNodeDefs\(undefined, \{[\s\S]*?force: true,[\s\S]*?joinMs: REFRESH_NODES_COMMAND_BUDGET_MS,[\s\S]*?runBudgetMs: REFRESH_NODES_RUN_BUDGET_MS,\s*\}\)/,
    "refresh_nodes must bound its own wait on the coalescer AND state the run's allowance",
  );
});
