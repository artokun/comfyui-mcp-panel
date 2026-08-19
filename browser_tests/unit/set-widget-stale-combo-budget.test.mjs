/**
 * #1413 — `graph_set_widget`'s stale-combo recovery awaited `refreshComfyNodeDefs()` with
 * no `joinMs` and no outer bound, inside the orchestrator's 30,000 ms relay window
 * (`OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS`, the same constant add_node is relayed at). The
 * fourth instance of the defect #1192 fixed for `graph_add_node`: reached only after the
 * authorization /object_info has already spent part of the window, an unbounded join of a
 * run someone else started could outlive the relay and turn a worded, retryable refusal
 * into a bare `did not reply to "graph_set_widget" within 30000 ms`.
 *
 * TWO layers are tested, because the defect lives in the SEAM between them:
 *
 *   1. THE LIB (runSetWidget, driven directly — the same unit the handler delegates to):
 *      an abandoned refresh (REFRESH_JOIN_ABANDONED back from refreshCombos) must refuse
 *      IN WORDS — nothing written, retry is the remedy — instead of revalidating against
 *      the list that was never refreshed and calling the value "not a valid option".
 *
 *   2. THE WIRING (the SHIPPED graph_set_widget body, extracted from the panel source and
 *      run against doubles, the rgthree-lora-row technique): the handler must take a
 *      command budget on its first line and thread `budget.remaining() - reserve` into
 *      the coalescer as `joinMs`. The coalescer and the budget are REAL — a stubbed
 *      refresh would pass against a wiring that bounds nothing, which is exactly the
 *      failure this file exists to catch.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { makeRefreshCoalescer, REFRESH_JOIN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { createObjectInfoCache, CACHE_OUTCOME } from "../../web/js/lib/object-info-cache.js";
import { fetchWholeObjectInfo, objectInfoOracleFailureNote } from "../../web/js/lib/object-info-oracle.js";
import { isRgthreeLoraRowCreation, createRgthreeLoraRow } from "../../web/js/lib/rgthree-lora-row.js";
import {
  PANEL_SRC,
  setWidgetCommandBudgetDeps,
  SET_WIDGET_COMMAND_BUDGET_MS,
  SET_WIDGET_POST_REFRESH_RESERVE_MS,
} from "./_panel-constants.mjs";

// ---------------------------------------------------------------------------
// 1. The lib: an abandoned refresh is a worded, honest, retryable refusal.
// ---------------------------------------------------------------------------

// A registry whose entries have no `nodeData` so the placeholder cross-check in
// assertResolvedTargetRegistered is skipped while the type still resolves as registered.
const REGISTRY = { LoadImage: {} };

// Fresh /object_info oracle, as every runSetWidget driver must supply (#458). The stale-
// COMBO recovery is the subject, so the type gate is a no-op here.
const FRESH = { LoadImage: {} };
const freshOracle = { getFreshObjectInfo: async () => FRESH };

function makeNode(type, widget) {
  return { id: 105, type, widgets: [widget] };
}

test("#1413 an abandoned combo refresh refuses IN WORDS — never 'not a valid option'", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = makeNode("LoadImage", widget);
  let refreshCalls = 0;
  await assert.rejects(
    () =>
      runSetWidget(node, "image", "new.png", {
        registry: REGISTRY,
        ...freshOracle,
        refreshCombos: async () => {
          refreshCalls += 1;
          return REFRESH_JOIN_ABANDONED; // the panel's bounded join gave up waiting
        },
      }),
    (err) => {
      assert.match(err.message, /panel_set_widget refused "image" on node 105/, "the standard refusal frame");
      assert.match(err.message, /still running/, "the cause: a refresh this command stopped waiting for");
      assert.match(err.message, /did NOT complete/, "the revalidation never happened, and it says so");
      assert.match(err.message, /NOTHING WAS WRITTEN/, "the caller must know the graph is untouched");
      assert.match(err.message, /RETRY/, "…and that retrying is the remedy");
      assert.match(err.message, /panel_refresh_nodes/, "…with a concrete escalation if retrying keeps failing");
      assert.ok(
        !/not a valid option/.test(err.message),
        "the refresh never re-read the list, so 'invalid value' is a cause this refusal cannot assert",
      );
      return true;
    },
  );
  assert.equal(refreshCalls, 1, "the refresh was still attempted exactly once");
  assert.equal(widget.value, "old_a.png", "nothing was written");
});

test("#1413 an abandoned refresh outranks the upload-asset probe — no unbounded step after the budget", async () => {
  // #387's probe is a server round-trip with no budget of its own. Running it AFTER the
  // command's budget ran out on the refresh would reopen exactly the relay-window overrun
  // the joinMs bound just closed — so the refusal comes first. On the retry the refresh
  // has usually landed and a genuine asset then takes the ordinary probe path.
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = makeNode("LoadImage", widget);
  let probes = 0;
  await assert.rejects(
    () =>
      runSetWidget(node, "image", "sub/new.png", {
        registry: REGISTRY,
        ...freshOracle,
        refreshCombos: async () => REFRESH_JOIN_ABANDONED,
        confirmServerAsset: async () => {
          probes += 1;
          return true;
        },
      }),
    /still running/,
  );
  assert.equal(probes, 0, "the probe does not run on a command whose budget is spent");
  assert.equal(widget.value, "old_a.png");
});

test("#1413 a refresh that COMPLETES (resolves undefined) still drives the retry, unchanged", async () => {
  // The healthy path must not be narrowed by the abandonment check: a plain join that
  // settled resolves undefined (the coalescer's documented success value), and the write
  // is then revalidated against the refreshed list exactly as before.
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = makeNode("LoadImage", widget);
  const res = await runSetWidget(node, "image", "new.png", {
    registry: REGISTRY,
    ...freshOracle,
    refreshCombos: async () => {
      widget.options.values = ["old_a.png", "new.png"];
      return undefined;
    },
  });
  assert.equal(res.set.value, "new.png");
  assert.equal(res.refreshed, true);
});

// ---------------------------------------------------------------------------
// 2. The wiring: the SHIPPED graph_set_widget, extracted and run.
// ---------------------------------------------------------------------------
//
// The defect is not in any helper — `makeRefreshCoalescer` has accepted `joinMs` since
// #1192. It is in whether THIS call site threads the budget through, and only driving the
// shipped body with the real coalescer answers that.

const SET_WIDGET_SRC = (() => {
  const m = PANEL_SRC.match(/ {2}async graph_set_widget\(\{ node_id, widget, value, workflow_uuid \}\) \{[\s\S]*?\n {2}\},/);
  assert.ok(m, "could not locate graph_set_widget in the panel source");
  return m[0];
})();

/** Every free name the extracted method can reach — the rgthree-lora-row list, kept in step. */
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
  // #1418 — the capped seed wait, the capped authorization deadline and the bounded
  // #387 /view probe. Supplied by setWidgetCommandBudgetDeps(); named here because a
  // free identifier the rebuilt body reaches is a ReferenceError, not a failed assert.
  "OBJECT_INFO_SEED_WAIT_MS",
  "OBJECT_INFO_DEADLINE_MS",
  "SET_WIDGET_ASSET_PROBE_MS",
  "withTimeout",
  "inputAssetProbeVerdict",
];

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Build the SHIPPED `graph_set_widget` with the REAL runSetWidget, the REAL coalescer and
 * the REAL command budget — only the graph, the network and the clocks' SCALE are doubled.
 *
 * `budgetMs`/`reserveMs` are injected small so the tests run in milliseconds rather than
 * waiting out the shipped 25s; the shipped numbers are pinned separately below.
 */
function realGraphSetWidget({
  node,
  widget,
  // A promise a refresh someone else started waits on before registering — the reported
  // scenario (a reconnect refresh still running when the write arrives). Null: nothing
  // in flight.
  holdInFlight = null,
  // Set on the refresh run to make the retry SUCCEED (the healthy path).
  onRunRegister = null,
  budgetMs = 400,
  reserveMs = 120,
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
    // "Note" registered with NO nodeData/comfyClass — a genuine frontend-only class, the
    // two positive signals the #475 exemption requires.
    LG: { registered_node_types: { LoadImage: {}, Note: {} } },
    rootGraph: graph,
  };

  // The authorization oracle answers with a schema that does NOT contain the (frontend-
  // only, allowlisted) node type — which is precisely the case that sends the panel's
  // refreshCombos down the full-refresh fallback this issue is about: a payload that
  // cannot contain the keyed type must not be treated as the authoritative list (#796).
  const api = {
    getNodeDefs: async () => ({ LoadImage: { input: { required: { image: [["old_a.png"], {}] } } } }),
    fetchApi: async () => ({ ok: false, status: 404 }),
  };

  // The REAL single-flight coordinator over a real slot, with a real in-flight run when
  // the test holds one open. Stubbing this away would remove the term the issue is about.
  let inFlight = null;
  const runs = [];
  const refreshComfyNodeDefs = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    runRegister: async (defs) => {
      runs.push(defs);
      if (defs == null && holdInFlight) await holdInFlight;
      onRunRegister?.(defs);
      return true;
    },
    withTimeout,
  });
  const inFlightStarted = holdInFlight ? refreshComfyNodeDefs(undefined) : null;

  const deps = {
    getGraphCtx: () => context,
    resolveNode: () => node,
    classifyLtxTimelineWrite: () => null,
    classifyPromptRelayTimelineWrite: () => null,
    classifyRgthreeFastGroupsWrite: () => null,
    classifyIdeogram4PromptBuilderWrite: () => null,
    awaitObjectInfoHistorySeed: async () => {},
    // The REAL classifier and creator, as rgthree-lora-row.test.mjs requires: a double
    // would let the executor pass against a route that never fires.
    isRgthreeLoraRowCreation,
    createRgthreeLoraRow,
    assertActiveWorkflowCommandTarget: () => {},
    WORKFLOW_UUID_FIELD: "workflow_uuid",
    runSetWidget,
    objectInfoCache: createObjectInfoCache(),
    CACHE_OUTCOME,
    fetchWholeObjectInfo,
    api,
    backendReconnectEpoch: 0,
    objectInfoSnapshot: { record: () => true, authorize: () => ({ defs: null, reason: "none recorded" }) },
    recordObjectInfoTypes: (defs) => defs,
    objectInfoOracleFailureNote,
    comfyBackendSocketDown: false,
    comfyBackendIsDown: () => false,
    // "Note" is frontend-only and never seen on a backend — never-seen is the verdict that
    // lets the #475 allowlist authorize it against a schema that cannot contain it.
    objectInfoHistory: { wasTypeEverDefined: () => false },
    sourceForSubgraphInput: () => undefined,
    refreshComboOptionsFromDefs: () => 0,
    refreshComfyNodeDefs,
    clearStaleRedFlag: () => {},
    snapshotAuthorizationNote: () => "",
    ...setWidgetCommandBudgetDeps(),
    SET_WIDGET_COMMAND_BUDGET_MS: budgetMs,
    SET_WIDGET_POST_REFRESH_RESERVE_MS: reserveMs,
  };
  const factory = new Function(
    ...EXECUTOR_DEPS,
    `const GRAPH_TOOL_EXECUTORS = { ${SET_WIDGET_SRC} }; return GRAPH_TOOL_EXECUTORS.graph_set_widget;`,
  );
  return {
    graph_set_widget: factory(...EXECUTOR_DEPS.map((n) => deps[n])),
    runs,
    inFlightStarted,
  };
}

// A "Note" node is on the reserved frontend-only allowlist (#475): registered with no
// backend provenance, legitimately absent from /object_info, so authorization passes AND
// the payload cannot refresh its combo — the one route to the full-refresh fallback.
function noteNode() {
  const widget = { name: "mode", type: "combo", options: { values: ["a"] }, value: "a" };
  const node = { id: 7, type: "Note", widgets: [widget] };
  return { node, widget };
}

test("#1413 wiring: a held-open in-flight refresh refuses the write at the budget, in words", async () => {
  const { node, widget } = noteNode();
  const gate = deferred(); // the reconnect run never lands — the reported scenario
  const built = realGraphSetWidget({ node, holdInFlight: gate.promise, budgetMs: 400, reserveMs: 120 });

  const started = Date.now();
  await assert.rejects(
    () => built.graph_set_widget({ node_id: 7, widget: "mode", value: "b", workflow_uuid: "u" }),
    (err) => {
      assert.match(err.message, /panel_set_widget refused "mode" on node 7/, "the standard refusal frame");
      assert.match(err.message, /still running/, "the true cause, not 'not a valid option'");
      assert.match(err.message, /NOTHING WAS WRITTEN/);
      assert.match(err.message, /RETRY/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 4000,
    `the write took ${elapsed}ms — unbounded, it would never have answered at all while the gate is held`,
  );
  assert.equal(widget.value, "a", "nothing was written");
  assert.deepEqual(built.runs, [undefined], "the abandoned write did NOT start a competing refresh run");

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
});

test("#1413 wiring: an in-flight refresh that LANDS in time lets the retry succeed", async () => {
  // The bound must not become a way to refuse writes on a machine doing nothing wrong.
  const { node, widget } = noteNode();
  const built = realGraphSetWidget({
    node,
    holdInFlight: new Promise((r) => setTimeout(r, 20)),
    onRunRegister: () => {
      widget.options.values = ["a", "b"]; // the refresh delivers the new option
    },
    budgetMs: 4000,
    reserveMs: 120,
  });

  const res = await built.graph_set_widget({ node_id: 7, widget: "mode", value: "b", workflow_uuid: "u" });
  assert.equal(res.set.value, "b", "the write landed on the retry");
  assert.equal(res.refreshed, true);
  await built.inFlightStarted;
});

test("#1413 wiring: with NOTHING in flight the fallback still runs the refresh, bounded", async () => {
  const { node, widget } = noteNode();
  const built = realGraphSetWidget({
    node,
    onRunRegister: () => {
      widget.options.values = ["a", "b"];
    },
    budgetMs: 4000,
    reserveMs: 120,
  });
  const res = await built.graph_set_widget({ node_id: 7, widget: "mode", value: "b", workflow_uuid: "u" });
  assert.equal(res.set.value, "b");
  assert.equal(built.runs.length, 1, "the fallback ran exactly one refresh");
});

// ---------------------------------------------------------------------------
// 3. The shipped numbers, pinned against the relay window (the single-node-def
//    technique): the harnesses above inject small budgets, so only a source-level check
//    can catch the constants drifting.
// ---------------------------------------------------------------------------

test("#1413 the shipped budget mirrors add_node's against the same 30s relay window", () => {
  assert.equal(SET_WIDGET_COMMAND_BUDGET_MS, 25000, "25s budget + 5s slack against the 30s relay");
  assert.ok(
    SET_WIDGET_POST_REFRESH_RESERVE_MS > 0 && SET_WIDGET_POST_REFRESH_RESERVE_MS < SET_WIDGET_COMMAND_BUDGET_MS,
    "a reserve that is nothing protects nothing; one that is everything refuses everything",
  );
  const body = SET_WIDGET_SRC;
  assert.match(
    body,
    /const budget = makeCommandBudget\(SET_WIDGET_COMMAND_BUDGET_MS, monotonicNow\);/,
    "the deadline is taken inside the handler, from the monotonic clock",
  );
  assert.match(
    body,
    /joinMs: budget\.remaining\(\) - SET_WIDGET_POST_REFRESH_RESERVE_MS/,
    "the fallback join draws from the command's remaining budget, not a fresh constant",
  );
});
