/**
 * #1418 — three things #1416 left behind, and the audit #1413 asked for.
 *
 *   1. THE REFUSAL ASSERTED A REFRESH THAT WAS NOT RUNNING. `REFRESH_JOIN_ABANDONED` comes
 *      back from `refresh-coalesce.js` in TWO states — a join this caller gave up on, and
 *      a non-positive `joinMs` against an EMPTY slot, which starts nothing — and the
 *      shipped text ("That refresh is still running and is registering exactly the list
 *      this write needs") was true in only one. The second arm was reachable with NO
 *      concurrency at all, because the two waits ahead of the recovery still held flat
 *      constants that composed past the command budget: 8,000 ms seed + 20,000 ms oracle =
 *      28,000 ms against a 25,000 ms budget, so `joinMs` came out at -7,000.
 *
 *   2. THE #387 `/view` PROBE WAS STILL UNBOUNDED. #1416's abandoned-refresh refusal fires
 *      before it, which covers the abandoned arm only — when the refresh COMPLETES and the
 *      retry write still misses (the subfolder-nested LoadImage image the probe exists
 *      for), the ladder reaches it, and it was the last network step of a command relayed
 *      at 30,000 ms with no bound of any kind.
 *
 *   3. THE AUDIT #1413 ASKED FOR, as a test rather than a sentence: `graph_get_object_info`
 *      and `graph_remove_widget` are the other two relayed commands, and both are clean
 *      today — one await each, landing on `fetchWholeObjectInfo`, which bounds itself.
 *      That is a claim with a shelf life, so it goes red the day either grows a second
 *      wait or reaches the coalescer, whether or not anyone rereads the note.
 *
 * WHAT THESE TESTS DRIVE. The bounds are one-line wiring changes, and a helper-level test
 * cannot see them — `withTimeout`, `makeCommandBudget` and `fetchWholeObjectInfo` all
 * accepted these arguments before this change and would pass against a call site that
 * never passes one. So the SHIPPED `graph_set_widget` body is extracted from the panel
 * source and run, with the REAL oracle, the REAL budget and the REAL bounding primitive;
 * only the graph, the network and the SCALE of the constants are doubled.
 *
 * AND THE SOURCE PINS ARE SCOPED TO THAT BODY, never to the file. A pin written as
 * `assert.match(PANEL_SRC, /awaitObjectInfoHistorySeed\(budget\.bounded\(/)` stays GREEN
 * with `graph_set_widget`'s bound deleted, because `graph_add_node`'s sibling call site
 * satisfies it — measured, on the branch this issue came from.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { makeRefreshCoalescer, REFRESH_JOIN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { makeCommandBudget } from "../../web/js/lib/command-budget.js";
import { createObjectInfoCache, CACHE_OUTCOME } from "../../web/js/lib/object-info-cache.js";
import { fetchWholeObjectInfo, objectInfoOracleFailureNote } from "../../web/js/lib/object-info-oracle.js";
import { isRgthreeLoraRowCreation, createRgthreeLoraRow } from "../../web/js/lib/rgthree-lora-row.js";
import {
  PANEL_SRC,
  setWidgetCommandBudgetDeps,
  SET_WIDGET_COMMAND_BUDGET_MS,
  SET_WIDGET_POST_REFRESH_RESERVE_MS,
  SET_WIDGET_ASSET_PROBE_MS,
  OBJECT_INFO_SEED_WAIT_MS,
  OBJECT_INFO_DEADLINE_MS,
} from "./_panel-constants.mjs";

// ---------------------------------------------------------------------------
// 0. The arm the shipped refusal denied existed.
// ---------------------------------------------------------------------------

test("#1418 the exhausted arm returns REFRESH_JOIN_ABANDONED having started NOTHING", async () => {
  // Driven over the REAL coalescer at the REAL shipped numbers, on a virtual clock so the
  // 25s budget costs no wall time. This is the measurement the issue reports, reproduced:
  // an empty slot plus a non-positive joinMs is the token with no concurrency anywhere.
  let t = 0;
  const budget = makeCommandBudget(SET_WIDGET_COMMAND_BUDGET_MS, () => t);
  t += OBJECT_INFO_SEED_WAIT_MS; // the seed wait, at its own flat constant
  t += OBJECT_INFO_DEADLINE_MS; // the authorization /object_info, at its own flat constant
  const joinMs = budget.remaining() - SET_WIDGET_POST_REFRESH_RESERVE_MS;
  assert.ok(joinMs <= 0, `uncapped, the two waits ahead of the recovery leave joinMs=${joinMs}`);

  let inFlight = null;
  const runs = [];
  const refresh = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => (inFlight = p),
    runRegister: async (defs) => {
      runs.push(defs);
      return true;
    },
    withTimeout,
  });
  const outcome = await refresh(undefined, { joinMs });
  assert.equal(outcome, REFRESH_JOIN_ABANDONED, "the token comes back");
  assert.equal(runs.length, 0, "…having started no run at all");
  assert.equal(inFlight, null, "…and leaving the slot empty, so nothing is registering anything");
});

test("#1418 the refusal names BOTH abandoned states and rests the retry on the fresh budget", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = { id: 105, type: "LoadImage", widgets: [widget] };
  await assert.rejects(
    () =>
      runSetWidget(node, "image", "new.png", {
        registry: { LoadImage: {} },
        getFreshObjectInfo: async () => ({ LoadImage: {} }),
        refreshCombos: async () => REFRESH_JOIN_ABANDONED,
      }),
    (err) => {
      const m = err.message;
      // STATE A — a run someone else started, still going.
      assert.match(m, /still running when the budget ran out waiting for it/, "state A is named");
      assert.match(m, /was NOT\s+cancelled/, "…and that it survives, which is what makes the retry useful");
      // STATE B — the budget was gone before the recovery; nothing was started.
      assert.match(
        m,
        /no refresh was\s+started for this write at all/,
        "state B is named — the arm the shipped text asserted could not happen",
      );
      // The retry advice must be true on BOTH arms.
      assert.match(m, /re-enters this recovery with a FRESH\s+budget/, "the fact that holds either way");
      assert.ok(
        !/normally succeeds on the next attempt/.test(m),
        "a promise that is false on state B: the retry meets the same slow /object_info",
      );
      assert.match(m, /a bare retry can meet the same wall/, "…said plainly instead");
      assert.match(m, /panel_refresh_nodes/, "…with the escalation that does resolve state B");
      // #1413's invariants, unchanged.
      assert.match(m, /NOTHING WAS WRITTEN/);
      assert.ok(!/not a valid option/.test(m), "the revalidation never ran, so that cause cannot be asserted");
      return true;
    },
  );
  assert.equal(widget.value, "old_a.png", "nothing was written");
});

// ---------------------------------------------------------------------------
// 1. The wiring: the SHIPPED graph_set_widget, extracted and run.
// ---------------------------------------------------------------------------

const SET_WIDGET_SRC = (() => {
  const m = PANEL_SRC.match(/ {2}async graph_set_widget\(\{ node_id, widget, value, workflow_uuid \}\) \{[\s\S]*?\n {2}\},/);
  assert.ok(m, "could not locate graph_set_widget in the panel source");
  return m[0];
})();

/** Every free name the extracted method can reach — kept in step with its siblings. */
const EXECUTOR_DEPS = [
  "getGraphCtx",
  "resolveNode",
  "classifyLtxTimelineWrite",
  "derivedTimelineRefusal",
  "applyLtxTimelineWrite",
  "classifyPromptRelayTimelineWrite",
  "promptRelayDerivedRefusal",
  "applyPromptRelayTimelineWrite",
  "classifyRgthreeFastGroupsWrite",
  "rgthreeFastGroupsRefusal",
  "classifyIdeogram4PromptBuilderWrite",
  "ideogram4PromptBuilderRefusal",
  "awaitObjectInfoHistorySeed",
  "isRgthreeLoraRowCreation",
  "createRgthreeLoraRow",
  "assertActiveWorkflowCommandTarget",
  "WORKFLOW_UUID_FIELD",
  "runSetWidget",
  "objectInfoCache",
  "CACHE_OUTCOME",
  "fetchWholeObjectInfo",
  "api",
  "backendReconnectEpoch",
  "objectInfoSnapshot",
  "recordObjectInfoTypes",
  "objectInfoOracleFailureNote",
  "comfyBackendSocketDown",
  "comfyBackendIsDown",
  "objectInfoHistory",
  "sourceForSubgraphInput",
  "refreshComboOptionsFromDefs",
  "refreshComfyNodeDefs",
  "clearStaleRedFlag",
  "snapshotAuthorizationNote",
  "makeCommandBudget",
  "SET_WIDGET_COMMAND_BUDGET_MS",
  "SET_WIDGET_POST_REFRESH_RESERVE_MS",
  "monotonicNow",
  "OBJECT_INFO_SEED_WAIT_MS",
  "OBJECT_INFO_DEADLINE_MS",
  "SET_WIDGET_ASSET_PROBE_MS",
  "withTimeout",
  "inputAssetProbeVerdict",
];

const never = () => new Promise(() => {});

/**
 * Await `run()`, but FAIL rather than hang if a deleted bound makes it never settle.
 *
 * Every test below removes a bound to prove it matters, and an unbounded wait does not
 * report a failure — it stops the run and leaves the suite looking merely slow. A watchdog
 * turns "this bound is gone" into a red assertion with the elapsed time in it, which is
 * what a reviewer reverting the fix actually needs to see.
 */
async function withinWatchdog(ms, what, run) {
  const settled = await Promise.race([
    Promise.resolve(run()).then(
      (value) => ({ value }),
      (err) => ({ err }),
    ),
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);
  assert.ok(settled !== null, `${what} did not settle within ${ms}ms — the bound it depends on is gone`);
  if ("err" in settled) return settled.err;
  return settled.value;
}

/**
 * Build the SHIPPED `graph_set_widget` with the REAL runSetWidget, the REAL oracle, the
 * REAL bounding primitive and the REAL command budget. The constants are injected SMALL
 * so a bound that is missing costs seconds rather than half a minute; the shipped numbers
 * are pinned separately at the bottom of this file.
 */
function realGraphSetWidget({
  node,
  // The `/object_info` the authorization oracle answers with. `never()` models a route
  // that does not settle — the case the deadline exists for.
  getNodeDefs,
  // What `/view?type=input` does when the #387 probe reaches it.
  viewFetch = async () => ({ ok: true, status: 206 }),
  // How long the baseline seed takes to land. `never()` models one that does not.
  seedWait = async () => {},
  budgetMs = 400,
  reserveMs = 120,
  seedMs = 5000,
  oracleMs = 5000,
  probeMs = 5000,
} = {}) {
  const graph = {
    _nodes: [node],
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
  };
  const context = {
    app: { canvas: null },
    graph,
    LG: { registered_node_types: { LoadImage: {} } },
    rootGraph: graph,
  };

  const seen = { seedMs: null, deadlineMs: null, viewRoutes: [] };
  const api = {
    getNodeDefs,
    fetchApi: async (route) => {
      if (String(route).startsWith("/view?")) {
        seen.viewRoutes.push(route);
        return viewFetch();
      }
      return { ok: false, status: 404 };
    },
  };

  let inFlight = null;
  const refreshComfyNodeDefs = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => (inFlight = p),
    runRegister: async () => true,
    withTimeout,
  });

  const deps = {
    getGraphCtx: () => context,
    resolveNode: () => node,
    classifyLtxTimelineWrite: () => null,
    classifyPromptRelayTimelineWrite: () => null,
    classifyRgthreeFastGroupsWrite: () => null,
    classifyIdeogram4PromptBuilderWrite: () => null,
    // Records the bound it is HANDED and honours it, exactly as `awaitHistoryBaseline`
    // does: a seed that has not landed inside `waitMs` stops being waited for.
    awaitObjectInfoHistorySeed: async (ms) => {
      seen.seedMs = ms;
      await withTimeout(seedWait(), ms, () => null);
    },
    isRgthreeLoraRowCreation,
    createRgthreeLoraRow,
    assertActiveWorkflowCommandTarget: () => {},
    WORKFLOW_UUID_FIELD: "workflow_uuid",
    runSetWidget,
    objectInfoCache: createObjectInfoCache(),
    CACHE_OUTCOME,
    // The REAL oracle, wrapped only to record the deadline the call site chose. A double
    // here would let this pass against a handler that passes no deadline at all.
    fetchWholeObjectInfo: (opts) => {
      seen.deadlineMs = opts?.deadlineMs;
      return fetchWholeObjectInfo(opts);
    },
    api,
    backendReconnectEpoch: 0,
    objectInfoSnapshot: { record: () => true, authorize: () => ({ defs: null, reason: "none recorded" }) },
    recordObjectInfoTypes: (defs) => defs,
    objectInfoOracleFailureNote,
    comfyBackendSocketDown: false,
    comfyBackendIsDown: () => false,
    objectInfoHistory: { wasTypeEverDefined: () => true },
    sourceForSubgraphInput: () => undefined,
    refreshComboOptionsFromDefs: () => 0,
    refreshComfyNodeDefs,
    clearStaleRedFlag: () => {},
    snapshotAuthorizationNote: () => "",
    ...setWidgetCommandBudgetDeps(),
    SET_WIDGET_COMMAND_BUDGET_MS: budgetMs,
    SET_WIDGET_POST_REFRESH_RESERVE_MS: reserveMs,
    OBJECT_INFO_SEED_WAIT_MS: seedMs,
    OBJECT_INFO_DEADLINE_MS: oracleMs,
    SET_WIDGET_ASSET_PROBE_MS: probeMs,
  };
  const factory = new Function(
    ...EXECUTOR_DEPS,
    `const GRAPH_TOOL_EXECUTORS = { ${SET_WIDGET_SRC} }; return GRAPH_TOOL_EXECUTORS.graph_set_widget;`,
  );
  return { graph_set_widget: factory(...EXECUTOR_DEPS.map((n) => deps[n])), seen };
}

/** A LoadImage whose `image` input is an UPLOAD combo — the shape the #387 probe gates on. */
function loadImageNode() {
  const widget = { name: "image", type: "combo", options: { values: ["top.png"] }, value: "top.png" };
  return { node: { id: 12, type: "LoadImage", widgets: [widget] }, widget };
}
const UPLOAD_DEFS = {
  LoadImage: { input: { required: { image: [["top.png"], { image_upload: true }] } } },
};

test("#1418 the seed wait is capped by the command, not by its own flat constant", async () => {
  // A baseline seed that never lands. Uncapped it holds the command for the WHOLE seed
  // constant (5,000 ms here, 8,000 ms shipped) before anything else on the path has run.
  const { node } = loadImageNode();
  const built = realGraphSetWidget({
    node,
    getNodeDefs: async () => UPLOAD_DEFS,
    seedWait: never,
    budgetMs: 300,
    seedMs: 5000,
  });
  const startedAt = Date.now();
  // The value IS in the list, so the write succeeds — this test is about the WAIT, not the
  // ladder, and a passing write proves the cap did not break the ordinary path either.
  const res = await withinWatchdog(2000, "the write", () =>
    built.graph_set_widget({ node_id: 12, widget: "image", value: "top.png", workflow_uuid: "u" }),
  );
  assert.equal(res?.set?.value, "top.png", "the ordinary path still writes");
  const elapsed = Date.now() - startedAt;
  assert.ok(
    built.seen.seedMs <= 300,
    `the seed was handed ${built.seen.seedMs}ms — uncapped it takes the flat 5000ms constant`,
  );
  assert.ok(elapsed < 2000, `the command answered in ${elapsed}ms; uncapped it waits out the full 5000ms seed`);
});

test("#1418 the authorization /object_info deadline is capped by what the command has left", async () => {
  // Both transports silent, so the REAL oracle runs its deadline out. Uncapped it takes
  // OBJECT_INFO_DEADLINE_MS whole, on top of whatever the seed already spent.
  const { node, widget } = loadImageNode();
  const built = realGraphSetWidget({
    node,
    getNodeDefs: never,
    budgetMs: 400,
    oracleMs: 5000,
  });
  const startedAt = Date.now();
  // A silent oracle refuses on the #458 unavailable-schema path — the point here is WHEN
  // it refuses, not which refusal it is.
  const outcome = await withinWatchdog(2500, "the refusal", () =>
    built.graph_set_widget({ node_id: 12, widget: "image", value: "sub/new.png", workflow_uuid: "u" }),
  );
  assert.ok(outcome instanceof Error, "the write is refused, not silently accepted");
  const elapsed = Date.now() - startedAt;
  assert.ok(
    built.seen.deadlineMs > 0 && built.seen.deadlineMs <= 400,
    `the oracle was handed ${built.seen.deadlineMs}ms — uncapped it takes its own 5000ms constant`,
  );
  assert.ok(elapsed < 2500, `the command answered in ${elapsed}ms; uncapped the oracle alone spends 5000ms`);
  assert.equal(widget.value, "top.png", "nothing was written");
});

test("#1418 the #387 /view probe IS reached after a refresh that completes, and is bounded", async () => {
  // The exact case #1416's refusal does not cover: the refresh completes (the payload
  // contains LoadImage, so refreshCombos takes the in-place branch and resolves), the
  // retry write still misses, and the ladder runs the upload-asset probe. `/view` never
  // answers. Unbounded, this is the last network step of a 30,000 ms-relayed command
  // parking forever.
  const { node, widget } = loadImageNode();
  const built = realGraphSetWidget({
    node,
    getNodeDefs: async () => UPLOAD_DEFS,
    viewFetch: never,
    budgetMs: 4000,
    probeMs: 300,
  });
  const startedAt = Date.now();
  const outcome = await withinWatchdog(2500, "the refusal", () =>
    built.graph_set_widget({ node_id: 12, widget: "image", value: "sub/new.png", workflow_uuid: "u" }),
  );
  assert.ok(outcome instanceof Error, "the write is refused, not silently accepted");
  const elapsed = Date.now() - startedAt;
  assert.equal(built.seen.viewRoutes.length, 1, "the probe WAS reached — this path is not covered by the refusal");
  assert.match(built.seen.viewRoutes[0], /subfolder=sub/, "…with the nested path #387 is about");
  assert.ok(elapsed < 2500, `the command answered in ${elapsed}ms; unbounded the probe never settles`);
  assert.equal(widget.value, "top.png", "a probe that could not answer admits nothing — #240 strictness holds");
});

test("#1418 a probe that could not ANSWER is not reported as a confirmed miss", async () => {
  // The trap this bound would otherwise set. #1357 established the tri-state for the live
  // combo scan: `false` is the server saying the file is not there, `null` is nobody having
  // answered. Bounding the probe created a NEW way to produce `null`, and the old boolean
  // collapsed it into `false` — so a command whose budget ran out would tell the caller
  // their perfectly-real nested upload is invalid, on the strength of a request that never
  // came back. That is the same wrong-cause shape this issue is about.
  const { node, widget } = loadImageNode();
  const built = realGraphSetWidget({
    node,
    getNodeDefs: async () => UPLOAD_DEFS,
    viewFetch: never, // reached, bounded, never answers
    budgetMs: 4000,
    probeMs: 200,
  });
  const outcome = await withinWatchdog(2500, "the refusal", () =>
    built.graph_set_widget({ node_id: 12, widget: "image", value: "sub/new.png", workflow_uuid: "u" }),
  );
  assert.ok(outcome instanceof Error);
  assert.equal(built.seen.viewRoutes.length, 1, "the probe was reached");
  assert.match(outcome.message, /probe did NOT answer/, "the refusal says the question went unanswered");
  assert.match(
    outcome.message,
    /does NOT\s+establish that the file is missing/,
    "…and explicitly declines to assert the cause it could not observe",
  );
  assert.match(outcome.message, /RETRY/, "…and says the one thing that can change the answer");
  assert.equal(widget.value, "top.png", "still nothing written — #240 strictness is untouched");
});

test("#1418 a server that ANSWERS 404 is still a confirmed miss, with no unanswered note", async () => {
  // The other half: `false` must keep meaning what it meant. A refusal that hedged on a
  // real 404 would be its own kind of dishonesty, and would train callers to retry forever.
  const { node } = loadImageNode();
  const built = realGraphSetWidget({
    node,
    getNodeDefs: async () => UPLOAD_DEFS,
    viewFetch: async () => ({ ok: false, status: 404 }),
    budgetMs: 4000,
    probeMs: 300,
  });
  const outcome = await withinWatchdog(2500, "the refusal", () =>
    built.graph_set_widget({ node_id: 12, widget: "image", value: "sub/new.png", workflow_uuid: "u" }),
  );
  assert.ok(outcome instanceof Error);
  assert.equal(built.seen.viewRoutes.length, 1, "the probe was reached and answered");
  assert.ok(
    !/probe did NOT answer/.test(outcome.message),
    "the server answered, so the refusal must NOT hedge — 404 is a real observation",
  );
});

test("#1418 a /view that ANSWERS still accepts the nested asset — the bound refuses nothing else", async () => {
  // The bound must not become a way to reject #387's whole point. A probe that answers
  // inside it accepts exactly as before.
  const { node, widget } = loadImageNode();
  const built = realGraphSetWidget({
    node,
    getNodeDefs: async () => UPLOAD_DEFS,
    viewFetch: async () => ({ ok: true, status: 206 }),
    budgetMs: 4000,
    probeMs: 300,
  });
  const res = await built.graph_set_widget({
    node_id: 12,
    widget: "image",
    value: "sub/new.png",
    workflow_uuid: "u",
  });
  assert.equal(res.set.value, "sub/new.png", "the server-confirmed nested asset is written");
  assert.equal(res.server_confirmed, true);
  assert.equal(widget.value, "sub/new.png");
});

// ---------------------------------------------------------------------------
// 2. The source pins — SCOPED TO graph_set_widget's OWN BODY.
// ---------------------------------------------------------------------------

test("#1418 the pins are scoped to the method body, not to the file", () => {
  // The guard on the guard. `graph_add_node` has held `budget.bounded(OBJECT_INFO_SEED_WAIT_MS)`
  // since #1192, so a file-wide pin is satisfied by ITS call site and stays green with
  // graph_set_widget's deleted. Assert the extraction really is one method.
  assert.ok(!/async graph_add_node\(/.test(SET_WIDGET_SRC), "the extraction must not run past into a sibling");
  assert.ok(SET_WIDGET_SRC.length < PANEL_SRC.length / 4, "…and must be one method, not most of the panel");
  assert.ok(
    /budget\.bounded\(OBJECT_INFO_SEED_WAIT_MS\)/.test(PANEL_SRC.replace(SET_WIDGET_SRC, "")),
    "the sibling call site that makes a file-wide pin worthless is still there — this is why scoping matters",
  );
});

test("#1418 graph_set_widget's own body caps every wait ahead of the recovery", () => {
  assert.match(
    SET_WIDGET_SRC,
    /await awaitObjectInfoHistorySeed\(budget\.bounded\(OBJECT_INFO_SEED_WAIT_MS\)\)/,
    "the seed wait draws from the command budget",
  );
  assert.match(
    SET_WIDGET_SRC,
    /deadlineMs: budget\.bounded\(OBJECT_INFO_DEADLINE_MS\)/,
    "the authorization /object_info draws from the command budget",
  );
  assert.match(
    SET_WIDGET_SRC,
    /budget\.bounded\(SET_WIDGET_ASSET_PROBE_MS\)/,
    "the #387 upload-asset probe draws from the command budget",
  );
  assert.ok(
    !/await api\.fetchApi\(`\/view\?/.test(SET_WIDGET_SRC),
    "…and is not awaited bare — a bound beside an unbounded await is not a bound",
  );
});

test("#1418 the shipped numbers still compose inside the relay window", () => {
  // The harnesses above inject small constants, so only a source-level check catches these
  // drifting. The property: everything the command can spend BEFORE the recovery now fits
  // inside the budget, where uncapped it was 28,000ms against 25,000ms.
  assert.equal(OBJECT_INFO_SEED_WAIT_MS + OBJECT_INFO_DEADLINE_MS, 28000, "the uncapped sum this issue measured");
  assert.ok(
    OBJECT_INFO_SEED_WAIT_MS + OBJECT_INFO_DEADLINE_MS > SET_WIDGET_COMMAND_BUDGET_MS,
    "…which is why capping them is not cosmetic: their own constants overrun the budget",
  );
  assert.ok(
    SET_WIDGET_ASSET_PROBE_MS > 0 && SET_WIDGET_ASSET_PROBE_MS < SET_WIDGET_POST_REFRESH_RESERVE_MS,
    "the probe is sized inside the reserve, so composing and relaying the reply still has room",
  );
});

// ---------------------------------------------------------------------------
// 3. The audit #1413 asked for, as a test.
// ---------------------------------------------------------------------------
//
// "Worth auditing the remaining two relayed commands (graph_get_object_info,
// graph_remove_widget) in the same pass, so the fifth instance does not get filed next
// week." Both are clean: one await each, landing on fetchWholeObjectInfo, which bounds
// itself at OBJECT_INFO_DEADLINE_MS — under the 30,000 ms window with nothing to compose
// against. Neither needs a command budget. Written as a test because a sentence saying so
// stops being true silently.

/** Slice one executor method out of the panel source by its exact signature line. */
function executorBody(signature) {
  const i = PANEL_SRC.indexOf(signature);
  assert.ok(i >= 0, `${signature} is no longer findable in the panel source — update this harness`);
  const j = PANEL_SRC.indexOf("\n  },", i);
  assert.ok(j > i, `could not find the end of ${signature}`);
  return PANEL_SRC.slice(i, j + 5);
}

const CLEAN_RELAYED_COMMANDS = [
  ["graph_get_object_info", "  async graph_get_object_info({ if_none_match } = {}) {"],
  ["graph_remove_widget", "  async graph_remove_widget({ node_id, widget, workflow_uuid }) {"],
];

for (const [name, signature] of CLEAN_RELAYED_COMMANDS) {
  test(`#1418 audit: ${name} still holds ONE await and never reaches the coalescer`, () => {
    const body = executorBody(signature);
    const awaits = body.match(/\bawait\b/g) ?? [];
    assert.equal(
      awaits.length,
      1,
      `${name} now holds ${awaits.length} awaits. A SECOND one is what makes bounds compose — ` +
        `if the new wait is unbounded, or bounded by its own flat constant, this command is the ` +
        `fifth instance of #1192/#1404/#1413/#1418 and needs a command budget of its own.`,
    );
    assert.ok(
      !/refreshComfyNodeDefs/.test(body),
      `${name} now reaches the node-def coalescer, whose join is unbounded without a joinMs — ` +
        `the exact step every one of those four issues was filed about.`,
    );
    assert.match(
      body,
      /fetchWholeObjectInfo\(/,
      `${name}'s one await is supposed to land on the self-bounding oracle; if it no longer ` +
        `does, the bound this audit rests on is gone.`,
    );
  });
}
