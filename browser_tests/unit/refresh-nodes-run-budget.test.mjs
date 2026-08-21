// panel#1562 — `panel_refresh_nodes` could never succeed on an install whose whole
// `/object_info` takes longer than 9 s to deliver, and said so in words that blamed a
// server which was up the whole time.
//
// The reporter measured `GET /object_info` at 25,104,088 bytes / 20.84 s while
// `/system_stats` and `/object_info/<Type>` both answered instantly. Every call returned
// `refreshed:false, reason:object_info_fetch_failed, "GET /object_info did not answer
// within its 1499ms share of the 2999ms budget"` — against a command whose own window is
// 25,000 ms.
//
// THE TWO BUDGETS WERE THE WRONG WAY ROUND. `joinMs` (REFRESH_NODES_COMMAND_BUDGET_MS,
// 25,000) is how long the command WAITS; `NODE_DEFS_RUN_BUDGET_MS` (9,000) is how long the
// run it starts may SPEND, and it is sized for a refresh that happens as a SUB-STEP of
// `graph_add_node`. Because the run's allowance was the smaller of the two, the run always
// died first — so `REFRESH_JOIN_ABANDONED` / `refresh_still_running`, the retryable verdict
// #1404 built for exactly "a big install ... without any concurrency at all", was
// STRUCTURALLY UNREACHABLE on the installs it was written for. The caller got a hard
// failure instead, which tears the run down, so each retry started another doomed run.
//
// Measured against a REAL 25,000,581-byte `/object_info` served in 20.80 s, driving the
// SHIPPED fetch phase (real `boundedGetNodeDefs`, real retry loop, real oracle):
//
//     run budget   route 1 bound   whole-document GETs   outcome
//      9,000 ms       6,000 ms            2              FAILED at 7.5 s — reported sentence
//     25,000 ms      16,666 ms            2              STILL FAILED at 20.9 s
//     32,000 ms      21,333 ms            1              20,020 types at 20.86 s
//     37,500 ms      25,000 ms            1              20,020 types at 20.98 s
//
// The 25,000 row is why the fix is not "hand the run the command's window": the FETCH
// SHARE is two thirds of whatever the run gets, and two thirds of the window is not the
// window. Hence the derivation these tests pin.
//
// WHAT THESE TESTS DRIVE. The call site, through the SHIPPED `refresh_nodes` body extracted
// from the panel source over the REAL coalescer — the technique #1404 established, and for
// its reason: the coalescer already forwards what it is given and `registerComfyNodeDefs`
// already honours what it receives, so the whole defect is a call site that passed nothing.
// Only an assertion on that call site can see it.
import test from "node:test";
import assert from "node:assert/strict";

import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { makeRefreshCoalescer } from "../../web/js/lib/refresh-coalesce.js";
import { describeNodeDefRefresh, NODE_DEF_REFRESH_REASONS } from "../../web/js/lib/node-def-refresh.js";
import {
  PANEL_SRC,
  REFRESH_NODES_COMMAND_BUDGET_MS,
  REFRESH_NODES_RUN_BUDGET_MS,
  REFRESH_NODES_EXECUTOR_DEPS,
  NODE_DEFS_FETCH_SHARE,
  NODE_DEFS_RUN_BUDGET_MS,
} from "./_panel-constants.mjs";

const refreshNodesMatch = PANEL_SRC.match(/\n {2}async refresh_nodes\(\) \{[\s\S]*?\n {2}\},/);
assert.ok(refreshNodesMatch, "could not locate refresh_nodes in panel source");

/**
 * Build the SHIPPED `refresh_nodes` over the REAL coalescer, recording what each run was
 * actually started with.
 */
function realRefreshNodes({ verdict = { refreshed: true, reason: "refreshed" } } = {}) {
  let inFlight = null;
  const runOptsSeen = [];
  const refreshComfyNodeDefs = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    // The SECOND parameter is the thing under test: `registerComfyNodeDefs(preloadedDefs,
    // runOpts)`. A coalescer that drops it, or a call site that never sets it, arrives here
    // as `undefined`.
    runRegister: async (_preloadedDefs, runOpts) => {
      runOptsSeen.push(runOpts);
      return verdict;
    },
    withTimeout,
  });
  const deps = { refreshComfyNodeDefs, ...REFRESH_NODES_EXECUTOR_DEPS };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const executors = {${refreshNodesMatch[0]}};
     return executors.refresh_nodes;`,
  );
  return { refresh_nodes: factory(...names.map((n) => deps[n])), runOptsSeen };
}

// ---------------------------------------------------------------------------
// 1. THE CALL SITE
// ---------------------------------------------------------------------------

test("#1562: refresh_nodes hands the RUN its own allowance, not just the join", async () => {
  const built = realRefreshNodes();
  const reply = await built.refresh_nodes();
  assert.equal(reply.refreshed, true);
  assert.equal(
    built.runOptsSeen.length,
    1,
    "the tool call must start exactly one run",
  );
  assert.equal(
    built.runOptsSeen[0]?.runBudgetMs,
    REFRESH_NODES_RUN_BUDGET_MS,
    "refresh_nodes must pass runBudgetMs — without it the run keeps the 9,000 ms default " +
      "sized for a SUB-STEP refresh, dies before the 25,000 ms join can abandon, and the " +
      "retryable refresh_still_running verdict is unreachable",
  );
});

// ---------------------------------------------------------------------------
// 2. THE DERIVATION — the property, not the number
// ---------------------------------------------------------------------------

test("#1562: the run's FETCH SHARE alone covers everything the command will wait for", () => {
  // This is the whole point. A run budget merely "bigger than 9,000" is not enough: on the
  // reporter's install a 25,000 ms run budget still failed, because route 1 is capped at
  // NODE_DEFS_FETCH_SHARE of it. The property below is what made 32,000 and 37,500 work and
  // 25,000 not, so it — and not the literal — is what is asserted.
  assert.ok(
    REFRESH_NODES_RUN_BUDGET_MS * NODE_DEFS_FETCH_SHARE >= REFRESH_NODES_COMMAND_BUDGET_MS,
    `the fetch phase gets ${Math.floor(REFRESH_NODES_RUN_BUDGET_MS * NODE_DEFS_FETCH_SHARE)}ms ` +
      `of the ${REFRESH_NODES_RUN_BUDGET_MS}ms run, which is less than the ` +
      `${REFRESH_NODES_COMMAND_BUDGET_MS}ms this command is willing to wait — so a document ` +
      "that WOULD have arrived inside the window is abandoned before it does",
  );
});

test("#1562: the run allowance is strictly longer than the wait it must outlast", () => {
  assert.ok(
    REFRESH_NODES_RUN_BUDGET_MS > REFRESH_NODES_COMMAND_BUDGET_MS,
    "the run must outlast the join, or the run is what ends the command and the caller is " +
      "told a hard failure where refresh_still_running is the true answer",
  );
  assert.ok(
    REFRESH_NODES_RUN_BUDGET_MS > NODE_DEFS_RUN_BUDGET_MS,
    "…and it must actually differ from the sub-step default it replaces",
  );
});

// ---------------------------------------------------------------------------
// 3. THE COALESCER FORWARDS IT — on every path that can start a run
// ---------------------------------------------------------------------------

function coalescerRecorder() {
  let inFlight = null;
  const seen = [];
  let release;
  const held = new Promise((r) => (release = r));
  const refresh = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    runRegister: async (preloadedDefs, runOpts) => {
      seen.push({ preloadedDefs, runOpts });
      if (seen.length === 1) await held;
      return { refreshed: true };
    },
    withTimeout,
  });
  return { refresh, seen, release };
}

test("#1562: the coalescer forwards runBudgetMs on the NOTHING-IN-FLIGHT path", async () => {
  const { refresh, seen, release } = coalescerRecorder();
  release();
  await refresh(undefined, { force: true, joinMs: 500, runBudgetMs: 4242 });
  assert.equal(seen[0]?.runOpts?.runBudgetMs, 4242);
});

test("#1562: the coalescer forwards runBudgetMs on the PAYLOAD path", async () => {
  // The payload branch is only reached while a run is ALREADY IN FLIGHT — a payload call
  // that arrives with the slot empty takes the nothing-in-flight branch instead. Written
  // the other way first, and the mutation harness caught it: dropping the forward on this
  // exact branch killed nothing, because the test was never on it.
  const { refresh, seen, release } = coalescerRecorder();
  const first = refresh(undefined, { force: true, joinMs: 5000, runBudgetMs: 1 });
  const withPayload = refresh({ SomeNode: {} }, { joinMs: 5000, runBudgetMs: 4243 });
  release();
  await first;
  await withPayload;
  assert.equal(seen.length, 2, "the payload must run AFTER the in-flight run, not join it");
  assert.equal(seen.at(-1)?.preloadedDefs?.SomeNode !== undefined, true, "…on the payload branch");
  assert.equal(seen.at(-1)?.runOpts?.runBudgetMs, 4243);
});

test("#1562: the coalescer forwards runBudgetMs on the TRAILING (forced) path", async () => {
  const { refresh, seen, release } = coalescerRecorder();
  const first = refresh(undefined, { force: true, joinMs: 5000, runBudgetMs: 1 });
  const trailing = refresh(undefined, { force: true, joinMs: 5000, runBudgetMs: 4244 });
  release();
  await first;
  await trailing;
  assert.equal(
    seen.at(-1)?.runOpts?.runBudgetMs,
    4244,
    "the trailing run keeps the allowance of the caller that QUEUED it",
  );
});

test("#1562: a caller that states NO run budget still gets undefined, not a fabricated one", async () => {
  const { refresh, seen, release } = coalescerRecorder();
  release();
  await refresh(undefined, { force: true, joinMs: 500 });
  assert.equal(
    seen[0]?.runOpts,
    undefined,
    "the coordinator must forward, never invent — every check of the value belongs in the run",
  );
});

// ---------------------------------------------------------------------------
// 4. THE RUN HONOURS IT — the deadline arithmetic, as the panel writes it
// ---------------------------------------------------------------------------

/**
 * The panel's own runDeadline expression, lifted rather than restated.
 *
 * #1562 round 2 — the allowance is NAMED (`runBudgetMs`) before it becomes a deadline,
 * because the combo phase's refusal has to quote it; the deadline is then
 * `monotonicNow() + runBudgetMs`, and this pattern asserts that too.
 *
 * Built INSIDE the test, not at module scope: a mutation that removes the expression must
 * fail a test BY NAME, and a throw during import fails the whole FILE instead — which
 * counts as a kill and names nothing a reader can act on.
 */
function runDeadlineExpr() {
  const m = PANEL_SRC.match(
    /const runBudgetMs =\r?\n\s*([\s\S]*?);\r?\n\s*let runDeadline = monotonicNow\(\) \+ runBudgetMs;/,
  );
  assert.ok(m, "the run deadline is no longer derived where this harness looks");
  // eslint-disable-next-line no-new-func
  return new Function("runOpts", "NODE_DEFS_RUN_BUDGET_MS", `return (${m[1]});`);
}

test("#1562: a stated run budget is used; anything unusable falls back to the default", () => {
  const deadline = runDeadlineExpr();
  assert.equal(deadline({ runBudgetMs: 37500 }, NODE_DEFS_RUN_BUDGET_MS), 37500);
  for (const bad of [undefined, null, 0, -1, NaN, Infinity, "37500", {}]) {
    assert.equal(
      deadline({ runBudgetMs: bad }, NODE_DEFS_RUN_BUDGET_MS),
      NODE_DEFS_RUN_BUDGET_MS,
      `runBudgetMs=${String(bad)} must not become the run's allowance — Infinity/NaN would ` +
        "restore the unbounded run this deadline exists to prevent, and a non-positive one " +
        "would start a run with no time at all",
    );
  }
  assert.equal(deadline(undefined, NODE_DEFS_RUN_BUDGET_MS), NODE_DEFS_RUN_BUDGET_MS);
});

// ---------------------------------------------------------------------------
// 5. THE VERDICT STOPS BLAMING A SERVER IT NEVER OBSERVED FAILING
// ---------------------------------------------------------------------------

const fetchFailure = (extra) =>
  describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: false,
    defsRegistered: false,
    comboApiPresent: true,
    comboRan: false,
    phase: "fetch",
    didThrow: true,
    thrown: new Error("api.getNodeDefs() did not answer within this refresh's remaining budget"),
    fetchRouteFailures: [
      "api.getNodeDefs() failed: api.getNodeDefs() did not answer within this refresh's remaining budget",
      "GET /object_info did not answer within its 1499ms share of the 2999ms budget",
    ],
    ...extra,
  });

test("#1562: every route ABANDONED AT ITS BOUND is not reported as a server that is down", () => {
  const v = fetchFailure({ fetchAbandonedAtBound: true });
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED);
  assert.doesNotMatch(
    v.remedy,
    /check that the ComfyUI server process is still running/,
    "the reporter's server answered 25,104,088 bytes in 20.84 s while this sentence told " +
      "them to check whether it was running — a remedy for a cause that was never established",
  );
  assert.match(v.remedy, /ABANDONED AT ITS BOUND/);
  assert.match(
    v.remedy,
    /plain retry meets the same bound/,
    "a document that does not fit the window will not fit the next one either",
  );
  // The routes are still named — #608's evidence clause is not lost to the new branch.
  assert.match(v.remedy, /GET \/object_info did not answer/);
});

test("#1562: a route that genuinely FAILED keeps the old, correct remedy", () => {
  for (const value of [false, null, undefined]) {
    const v = fetchFailure(value === undefined ? {} : { fetchAbandonedAtBound: value });
    assert.match(
      v.remedy,
      /check that the ComfyUI server process is still running/,
      `fetchAbandonedAtBound=${String(value)} must NOT claim the abandonment finding — ` +
        "null means no whole-document route was reached, and an unestablished fact must " +
        "fall to the wording that claims less",
    );
    assert.doesNotMatch(v.remedy, /ABANDONED AT ITS BOUND/);
  }
});

// ---------------------------------------------------------------------------
// 6. THE PANEL DECIDES IT FROM TAGS, NEVER FROM PROSE (#1223)
// ---------------------------------------------------------------------------

test("#1562: the fetch phase classifies route endings by TAG, not by message text", () => {
  const block = PANEL_SRC.slice(
    PANEL_SRC.indexOf("      let sawRealError = false;"),
    PANEL_SRC.indexOf("      if (clientRouteThrew) throw clientRouteError;"),
  );
  assert.ok(block.length > 0, "the fetch phase moved — update this harness");
  assert.match(
    block,
    /fetchAbandonedAtBound = clientRouteThrew && lastAttemptTimedOut === true && !sawRealError;/,
    "route 1's ending must come from the loop's own flags — the timeout AND the real-error " +
      "flag it already ranks above it. Dropping `!sawRealError` classifies a route that " +
      "FAILED and then stalled as an abandonment, which is asserted behaviourally in " +
      "node-def-refresh.test.mjs; this line is what makes the rule readable in one place.",
  );
  assert.match(
    block,
    /o\?\.kind === TRANSPORT_OUTCOME\.NO_ANSWER/,
    "route 2's ending must come from the oracle's TAG — matching its sentence is the " +
      "coupling #1223 removed, and it re-breaks the first time a message is reworded",
  );
  assert.doesNotMatch(
    block,
    /fetchAbandonedAtBound\s*=[^;]*\.(includes|match|test)\(/,
    "no branch may decide this by reading the failure prose",
  );
  // A SOURCE assertion, and said to be one. When route 2 ANSWERS, "every route was
  // abandoned" stops being true — but the run then succeeds, so no fetch-phase refusal is
  // reachable and no verdict can observe the value. There is nothing to assert
  // behaviourally; what there is to protect is that the clear does not get dropped, since
  // a stale `true` left for the next reader is exactly the shape this issue is about.
  const answered = block.slice(block.indexOf("if (fallbackDefs) {"));
  assert.match(
    answered.slice(0, answered.indexOf("} else {")),
    /fetchAbandonedAtBound = false;/,
    "a fallback that ANSWERED must clear the abandonment finding rather than leave it set",
  );
});
