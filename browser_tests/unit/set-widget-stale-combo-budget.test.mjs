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

import { runSetWidget, COMBO_REFRESH_NEVER_RAN } from "../../web/js/lib/set-widget.js";
import { makeRefreshCoalescer, REFRESH_JOIN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { fetchNodeDefsWithRetry, OBJECT_INFO_RETRY_DELAYS_MS } from "../../web/js/lib/object-info-retry.js";
import {
  createObjectInfoCache,
  CACHE_OUTCOME,
  OBJECT_INFO_CACHE_TTL_MS,
} from "../../web/js/lib/object-info-cache.js";
import {
  fetchWholeObjectInfo,
  objectInfoOracleFailureNote,
  TRANSPORT_OUTCOME,
} from "../../web/js/lib/object-info-oracle.js";
import {
  createObjectInfoSnapshot,
  noBackendAnswerEstablished,
} from "../../web/js/lib/object-info-snapshot.js";
import { createVerifiedNodeDefCache } from "../../web/js/lib/verified-node-def-cache.js";
import {
  fetchTypeScopedObjectInfo,
  SCOPED_OBJECT_INFO_DEADLINE_MS,
} from "../../web/js/lib/scoped-object-info.js";
import { SINGLE_NODE_INFO_OUTCOME } from "../../web/js/lib/single-node-def.js";
import { scanComboAvailability } from "../../web/js/lib/live-combo-availability.js";
import { comboRebuildCovered } from "../../web/js/lib/asset-staleness.js";
import { describeNodeDefRefresh, NODE_DEF_REFRESH_REASONS } from "../../web/js/lib/node-def-refresh.js";
import { isRgthreeLoraRowCreation, createRgthreeLoraRow } from "../../web/js/lib/rgthree-lora-row.js";
import { inputAssetViewQuery } from "../../web/js/lib/input-asset.js";
import {
  PANEL_SRC,
  setWidgetCommandBudgetDeps,
  SET_WIDGET_COMMAND_BUDGET_MS,
  SET_WIDGET_POST_REFRESH_RESERVE_MS,
  COMBO_OK,
  COMBO_NO_ANSWER,
  NODE_DEFS_FETCH_TIMEOUT_MS,
  NODE_DEFS_RUN_BUDGET_MS,
  NODE_DEFS_FETCH_SHARE,
  NODE_DEFS_NO_ANSWER,
  monotonicNow,
  nodeDefsBudgetLeft,
} from "./_panel-constants.mjs";
import { runProductionGraphGetErrors } from "./_graph-get-errors-harness.mjs";

const graphGetMatch = PANEL_SRC.match(
  /\n  async graph_get_object_info\(\{ if_none_match \} = \{\}\) \{[\s\S]*?\n  \},/,
);
assert.ok(graphGetMatch, "could not locate graph_get_object_info in the panel source");

function extractFunction(marker) {
  const start = PANEL_SRC.indexOf(marker);
  assert.notEqual(start, -1, `${marker} not found`);
  const open = PANEL_SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < PANEL_SRC.length; i += 1) {
    const ch = PANEL_SRC[i];
    if (ch === "/" && PANEL_SRC[i + 1] === "/") {
      i = PANEL_SRC.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && PANEL_SRC[i + 1] === "*") {
      i = PANEL_SRC.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < PANEL_SRC.length; i += 1) {
        if (PANEL_SRC[i] === "\\") {
          i += 1;
          continue;
        }
        if (PANEL_SRC[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return PANEL_SRC.slice(start, i + 1);
  }
  throw new Error(`unterminated function: ${marker}`);
}

const REGISTER_COMFY_NODE_DEFS_SRC = extractFunction("async function registerComfyNodeDefs(");

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

test("#1418 a never-started recovery says NOTHING IS RUNNING — never 'still running'", async () => {
  // The budget-spent arm: the coalescer answered without starting anything, so the refusal
  // must rest the retry on what is true in THAT state — a fresh budget on the retry — not
  // on joining a run that does not exist.
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = makeNode("LoadImage", widget);
  await assert.rejects(
    () =>
      runSetWidget(node, "image", "new.png", {
        registry: REGISTRY,
        ...freshOracle,
        refreshCombos: async () => COMBO_REFRESH_NEVER_RAN,
      }),
    (err) => {
      assert.match(err.message, /panel_set_widget refused "image" on node 105/, "the standard refusal frame");
      assert.match(err.message, /never started/, "the true state: the recovery never ran");
      assert.match(err.message, /No node-def refresh is running/, "…and no run is claimed");
      assert.match(err.message, /NOTHING WAS WRITTEN/);
      assert.match(err.message, /RETRY/, "the remedy that is true in this state too");
      assert.match(err.message, /panel_refresh_nodes/, "…with the same escalation");
      assert.ok(!/still running/.test(err.message), "must not assert a refresh that does not exist");
      assert.ok(!/not a valid option/.test(err.message), "nor call the value invalid");
      return true;
    },
  );
  assert.equal(widget.value, "old_a.png", "nothing was written");
});

// ---------------------------------------------------------------------------
// 2. The wiring: the SHIPPED graph_set_widget, extracted and run.
// ---------------------------------------------------------------------------
//
// The defect is not in any helper — `makeRefreshCoalescer` has accepted `joinMs` since
// #1192. It is in whether THIS call site threads the budget through, and only driving the
// shipped body with the real coalescer answers that.

const SET_WIDGET_SRC = (() => {
  const m = PANEL_SRC.match(/ {2}async graph_set_widget\(\{ node_id, widget, value, workflow_uuid, builder_state(?:, expected_node_type)? \}\) \{[\s\S]*?\n {2}\},/);
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
  "classifyMiniMaxH3PromptBuilderWrite",
  "applyMiniMaxH3PromptBuilderWrite",
  "classifyMiniMaxH3DirectorWrite",
  "miniMaxH3DirectorPromptRefusal",
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
  "noBackendAnswerEstablished",
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
  // #1418 — the budget now reaches the seed wait, the oracle read and the upload probe,
  // and the recovery distinguishes "still running" from "never ran" on a second token.
  "withTimeout",
  "OBJECT_INFO_SEED_WAIT_MS",
  "OBJECT_INFO_DEADLINE_MS",
  "REFRESH_JOIN_ABANDONED",
  "COMBO_REFRESH_NEVER_RAN",
  "verifiedNodeDefCache",
  "fetchTypeScopedObjectInfo",
  "SCOPED_OBJECT_INFO_DEADLINE_MS",
  // The coalescer's live slot. The shipped refreshCombos reads it BEFORE calling the
  // coalescer, so the value captured at build time is exactly what that read must see:
  // the in-flight run a test started before dispatching the command.
  "nodeDefRefreshInFlight",
  // #1357 — confirmServerAsset builds the /view query with this free name. Leaving it
  // out of the eval harness throws ReferenceError, the catch returns false, fetchApi
  // never runs, and #1418's hung-probe assertion reads as "skipped" instead of bounded.
  "inputAssetViewQuery",
  // #1498 — the handler retires the turn's manual-change claim for the widget it just
  // wrote. Panel module state, so the harness supplies a no-op double.
  "dropManualChangeClaim",
];

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // #1418 — the two waits AHEAD of the recovery, made slow so the budget is genuinely
  // spent when the recovery is reached (the issue's no-concurrency arm).
  seedDelayMs = 0,
  oracleDelayMs = 0,
  // What the authorization oracle answers. Default lacks "Note"; the probe test needs a
  // LoadImage def whose image input is upload-capable.
  oracleDefs = null,
  // /view probe behaviour: default answers 404 (the asset is not there).
  fetchApiImpl = null,
  getNodeDefsImpl = null,
  objectInfoCache = createObjectInfoCache(),
  objectInfoSnapshot = {
    record: () => true,
    authorize: () => ({ defs: null, reason: "none recorded" }),
    clear: () => {},
  },
  verifiedNodeDefCache = createVerifiedNodeDefCache(),
  registeredNodeTypes = { LoadImage: {}, Note: {} },
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
    LG: { registered_node_types: registeredNodeTypes },
    rootGraph: graph,
    workflow: { uuid: "wf" },
  };

  // The authorization oracle answers with a schema that does NOT contain the (frontend-
  // only, allowlisted) node type — which is precisely the case that sends the panel's
  // refreshCombos down the full-refresh fallback this issue is about: a payload that
  // cannot contain the keyed type must not be treated as the authoritative list (#796).
  const api = {
    getNodeDefs: async () => {
      if (oracleDelayMs) await sleep(oracleDelayMs);
      if (getNodeDefsImpl) return getNodeDefsImpl();
      return oracleDefs ?? { LoadImage: { input: { required: { image: [["old_a.png"], {}] } } } };
    },
    fetchApi: fetchApiImpl ?? (async () => ({ ok: false, status: 404 })),
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
    classifyMiniMaxH3PromptBuilderWrite: () => null,
    classifyMiniMaxH3DirectorWrite: () => null,
    miniMaxH3DirectorPromptRefusal: () => "",
    // #1418 — honors the cap it is handed, the way the shipped one does: it waits at most
    // waitMs, and a slow seed simply spends it.
    awaitObjectInfoHistorySeed: (waitMs) =>
      seedDelayMs ? sleep(Math.min(typeof waitMs === "number" ? waitMs : 8000, seedDelayMs)) : Promise.resolve(),
    // The REAL classifier and creator, as rgthree-lora-row.test.mjs requires: a double
    // would let the executor pass against a route that never fires.
    isRgthreeLoraRowCreation,
    createRgthreeLoraRow,
    assertActiveWorkflowCommandTarget: () => {},
    WORKFLOW_UUID_FIELD: "workflow_uuid",
    runSetWidget,
    objectInfoCache,
    CACHE_OUTCOME,
    fetchWholeObjectInfo,
    api,
    backendReconnectEpoch: 0,
    objectInfoSnapshot,
    recordObjectInfoTypes: (defs) => defs,
    objectInfoOracleFailureNote,
    noBackendAnswerEstablished,
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
    verifiedNodeDefCache,
    fetchTypeScopedObjectInfo,
    SCOPED_OBJECT_INFO_DEADLINE_MS,
    SET_WIDGET_COMMAND_BUDGET_MS: budgetMs,
    SET_WIDGET_POST_REFRESH_RESERVE_MS: reserveMs,
    // Captured AFTER the held-open run above has taken the slot — the value the shipped
    // refreshCombos reads before it calls the coalescer.
    nodeDefRefreshInFlight: inFlight,
    inputAssetViewQuery,
    dropManualChangeClaim: () => {},
  };
  const factory = new Function(
    ...EXECUTOR_DEPS,
    `const GRAPH_TOOL_EXECUTORS = { ${SET_WIDGET_SRC} }; return GRAPH_TOOL_EXECUTORS.graph_set_widget;`,
  );
  return {
    graph_set_widget: factory(...EXECUTOR_DEPS.map((n) => deps[n])),
    runs,
    inFlightStarted,
    verifiedNodeDefCache: deps.verifiedNodeDefCache,
    verifiedSchemaContext: context,
    api,
    objectInfoCache,
    objectInfoSnapshot,
  };
}

/** The real refresh body used by graph_add_node when it supplies a whole preloaded payload. */
function realPreloadedRefresh({ app, api, objectInfoCache, objectInfoSnapshot, verifiedNodeDefCache }) {
  const names = [
    "app",
    "api",
    "recordObjectInfoTypes",
    "reapplyDefsToLiveNodes",
    "comboRebuildCovered",
    "describeNodeDefRefresh",
    "NODE_DEF_REFRESH_REASONS",
    "fetchNodeDefsWithRetry",
    "withTimeout",
    "NODE_DEFS_NO_ANSWER",
    "COMBO_OK",
    "COMBO_NO_ANSWER",
    "NODE_DEFS_FETCH_TIMEOUT_MS",
    "NODE_DEFS_RUN_BUDGET_MS",
    "NODE_DEFS_FETCH_SHARE",
    "fetchWholeObjectInfo",
    "nodeDefsBudgetLeft",
    "monotonicNow",
    "NODE_DEFS_RETRY_DELAYS_MS",
    "objectInfoCache",
    "objectInfoSnapshot",
    "verifiedNodeDefCache",
    "initialBackendReconnectEpoch",
    "comfyBackendSocketDown",
    "TRANSPORT_OUTCOME",
  ];
  const values = {
    app,
    api,
    recordObjectInfoTypes: (defs) => defs,
    reapplyDefsToLiveNodes: () => {},
    comboRebuildCovered,
    describeNodeDefRefresh,
    NODE_DEF_REFRESH_REASONS,
    fetchNodeDefsWithRetry: (getDefs, opts) => fetchNodeDefsWithRetry(getDefs, { ...opts, sleep: async () => {} }),
    withTimeout,
    NODE_DEFS_NO_ANSWER,
    COMBO_OK,
    COMBO_NO_ANSWER,
    NODE_DEFS_FETCH_TIMEOUT_MS,
    NODE_DEFS_RUN_BUDGET_MS,
    NODE_DEFS_FETCH_SHARE,
    fetchWholeObjectInfo,
    nodeDefsBudgetLeft,
    monotonicNow,
    NODE_DEFS_RETRY_DELAYS_MS: OBJECT_INFO_RETRY_DELAYS_MS,
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache,
    initialBackendReconnectEpoch: 0,
    comfyBackendSocketDown: false,
    TRANSPORT_OUTCOME,
  };
  const factory = new Function(
    ...names,
    `const boundedGetNodeDefs = async (ms = NODE_DEFS_FETCH_TIMEOUT_MS) => {
      if (typeof api?.getNodeDefs !== "function") return null;
      const settled = await withTimeout(
        Promise.resolve().then(() => api.getNodeDefs()).then((value) => ({ value }), (err) => ({ err })),
        ms,
        () => NODE_DEFS_NO_ANSWER,
      );
      if (settled === NODE_DEFS_NO_ANSWER) return NODE_DEFS_NO_ANSWER;
      if ("err" in settled) throw settled.err;
      return settled.value;
    };
    let backendReconnectEpoch = initialBackendReconnectEpoch;
    let nodeDefsRefreshConfirmed = false;
    ${REGISTER_COMFY_NODE_DEFS_SRC}
    return registerComfyNodeDefs;`,
  );
  return factory(...names.map((name) => values[name]));
}

/** Build the shipped whole-schema reader with the same cache/snapshot trust roots. */
function realGraphGetObjectInfo({ api, objectInfoCache, objectInfoSnapshot, verifiedNodeDefCache }) {
  const names = [
    "api",
    "backendReconnectEpoch",
    "fetchWholeObjectInfo",
    "objectInfoCache",
    "verifiedNodeDefCache",
    "objectInfoSnapshot",
    "pageComfyOrigin",
    "objectInfoOracleFailureNote",
    "objectInfoFingerprint",
    "objectInfoUnchanged",
  ];
  const factory = new Function(
    ...names,
    `const executors = {${graphGetMatch[0]}}; return executors.graph_get_object_info;`,
  );
  return factory(
    api,
    0,
    fetchWholeObjectInfo,
    objectInfoCache,
    verifiedNodeDefCache,
    objectInfoSnapshot,
    () => "http://127.0.0.1:8188",
    objectInfoOracleFailureNote,
    noBackendAnswerEstablished,
    () => "fp",
    () => false,
  );
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

test("#1418 wiring: a budget spent by the seed+oracle says NOTHING IS RUNNING, with no concurrency", async () => {
  // The issue's measured arm: no other command, no reconnect, no install — the seed wait
  // and the authorization read alone spend the budget, the coalescer starts NOTHING, and
  // the refusal must say so. Driven through the shipped handler so the caps on those two
  // waits are what keep the answer inside the window at all.
  const { node, widget } = noteNode();
  const built = realGraphSetWidget({
    node,
    budgetMs: 400,
    reserveMs: 220,
    seedDelayMs: 120, // waits its capped allowance…
    oracleDelayMs: 80, // …and the oracle answers, slowly, inside its own capped share
  });

  const started = Date.now();
  await assert.rejects(
    () => built.graph_set_widget({ node_id: 7, widget: "mode", value: "b", workflow_uuid: "u" }),
    (err) => {
      assert.match(err.message, /never started/, "the recovery never ran and says so");
      assert.match(err.message, /No node-def refresh is running/, "no phantom refresh is claimed");
      assert.match(err.message, /NOTHING WAS WRITTEN/);
      assert.match(err.message, /RETRY/);
      assert.ok(!/still running/.test(err.message), "the other state's wording must not appear");
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 3000,
    `the write took ${elapsed}ms — before the caps, the flat seed+oracle waits alone summed past the budget`,
  );
  assert.equal(widget.value, "a", "nothing was written");
  assert.deepEqual(built.runs, [], "no refresh run was ever started");
});

test("#1418 wiring: a hung /view probe gives up at the budget instead of outliving the relay", async () => {
  // The probe is reached after a SUCCESSFUL (in-place) refresh, so #1413's joinMs never
  // covered it: the payload contains LoadImage, the refresh re-lists only the top-level
  // file, the retry misses the nested value, and the #387 probe hangs on a dead backend.
  const widget = { name: "image", type: "combo", options: { values: ["example.png"] }, value: "example.png" };
  const node = { id: 191, type: "LoadImage", widgets: [widget] };
  let probed = false;
  const built = realGraphSetWidget({
    node,
    budgetMs: 300,
    reserveMs: 120,
    oracleDefs: { LoadImage: { input: { required: { image: [["example.png"], { image_upload: true }] } } } },
    fetchApiImpl: (route) => {
      if (String(route).startsWith("/view")) {
        probed = true;
        return new Promise(() => {}); // half-open: never answers, never fails
      }
      return Promise.resolve({ ok: false, status: 404 });
    },
  });

  const started = Date.now();
  await assert.rejects(
    () =>
      built.graph_set_widget({
        node_id: 191,
        widget: "image",
        value: "xyr_canvas/boswellia_source.png",
        workflow_uuid: "u",
      }),
    /not a valid option/,
    "a probe that cannot answer in time is the 'not confirmed' the probe already answers on any doubt",
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 3000,
    `the probe took ${elapsed}ms of a 300ms command — unbounded, the refusal never leaves the tab`,
  );
  assert.ok(probed, "the probe did run — it is bounded, not skipped");
  assert.equal(widget.value, "example.png", "nothing was written");
});

test("#1709: a live graph_set_widget schema read retires cached add-node proof", async () => {
  const node = { id: 211, type: "RemovedNode", widgets: [{ name: "mode", type: "combo", value: "a" }] };
  const built = realGraphSetWidget({
    node,
    oracleDefs: { OtherNode: { input: { required: {} } } },
  });
  const binding = { app: {}, graph: {}, rootGraph: {}, workflow: {} };
  const cached = { input: { required: {} } };
  const generation = built.verifiedNodeDefCache.generation();
  built.verifiedNodeDefCache.set("RemovedNode", cached, { epoch: 0, context: binding, generation });
  assert.equal(
    built.verifiedNodeDefCache.get("RemovedNode", { epoch: 0, context: binding, generation }),
    cached,
    "the precondition is a live verified add proof",
  );

  await assert.rejects(
    () => built.graph_set_widget({ node_id: 211, widget: "mode", value: "b", workflow_uuid: "u" }),
    /Cannot set widget|refused/i,
    "the authoritative whole schema refuses the removed backend type",
  );
  assert.equal(
    built.verifiedNodeDefCache.get("RemovedNode", {
      epoch: 0,
      context: binding,
      generation: built.verifiedNodeDefCache.generation(),
    }),
    undefined,
    "the live whole-schema observation retired the stale add proof",
  );
});

test("#1709: scoped graph_set_widget reads retire proof on definitive presence and absence", async () => {
  const def = { input: { required: { mode: ["STRING", {}] } } };
  const node = {
    id: 213,
    type: "RemovedNode",
    widgets: [{ name: "mode", type: "text", value: "old" }],
    constructor: { nodeData: def, comfyClass: "RemovedNode" },
  };
  const cache = createVerifiedNodeDefCache();
  const registeredNodeTypes = {
    LoadImage: {},
    Note: {},
    RemovedNode: { nodeData: def, comfyClass: "RemovedNode" },
  };
  let present = true;
  const built = realGraphSetWidget({
    node,
    verifiedNodeDefCache: cache,
    registeredNodeTypes,
    getNodeDefsImpl: async () => undefined,
    fetchApiImpl: async (route) => {
      if (route === "/object_info") return { ok: false, status: 504 };
      return {
        ok: true,
        status: 200,
        json: async () => (present ? { RemovedNode: def } : {}),
      };
    },
  });
  const context = built.verifiedSchemaContext;
  let generation = cache.generation();
  cache.set("RemovedNode", def, { epoch: 0, context, generation });
  assert.ok(
    cache.get("RemovedNode", { epoch: 0, context, generation }),
    "the scoped reader starts with reusable add proof",
  );

  const first = await built.graph_set_widget({ node_id: 213, widget: "mode", value: "new", workflow_uuid: "u" });
  assert.equal(first.set.value, "new", "a definitive scoped presence still authorizes the widget write");
  assert.ok(cache.generation() > generation, "scoped presence retired the pre-existing proof");

  present = false;
  generation = cache.generation();
  cache.set("RemovedNode", def, { epoch: 0, context, generation });
  await assert.rejects(
    () => built.graph_set_widget({ node_id: 213, widget: "mode", value: "refused", workflow_uuid: "u" }),
    /Cannot set widget|does not provide|refused/i,
    "a definitive scoped absence refuses the removed class",
  );
  assert.ok(cache.generation() > generation, "scoped absence retired the pre-existing proof");
  assert.equal(
    cache.get("RemovedNode", { epoch: 0, context, generation: cache.generation() }),
    undefined,
    "the absent scoped answer leaves no reusable add proof",
  );
});

test("#1709: authoritative empty retires whole cache and snapshot before ordinary timeout refusal", async () => {
  const widget = { name: "text", type: "text", value: "old" };
  const node = { id: 212, type: "LoadImage", widgets: [widget] };
  const oldDefs = { LoadImage: { input: { required: { text: ["STRING", {}] } } } };
  const objectInfoCache = createObjectInfoCache();
  const objectInfoSnapshot = createObjectInfoSnapshot();
  const calls = [];
  let unavailable = false;
  let authoritativeEmpty = false;
  const built = realGraphSetWidget({
    node,
    objectInfoCache,
    objectInfoSnapshot,
    getNodeDefsImpl: async () => {
      calls.push("/object_info");
      if (unavailable) return undefined;
      return authoritativeEmpty ? {} : oldDefs;
    },
    fetchApiImpl: async (route) => {
      calls.push(route);
      return unavailable ? { status: 503, json: async () => ({}) } : { status: 200, json: async () => oldDefs };
    },
  });

  const first = await built.graph_set_widget({ node_id: 212, widget: "text", value: "new", workflow_uuid: "u" });
  assert.equal(first.set.value, "new", "the initial live schema authorizes the ordinary write");
  assert.equal(objectInfoCache.peek().cached, true, "the initial whole payload is in the burst cache");
  assert.equal(objectInfoSnapshot.peek().held, true, "the initial whole payload is in the last-observed snapshot");
  assert.ok(
    objectInfoSnapshot.authorize({
      epoch: 0,
      outcomes: [{ kind: TRANSPORT_OUTCOME.NO_ANSWER }],
    }).defs,
    "the old snapshot really could authorize during silence before the deny-all answer",
  );

  authoritativeEmpty = true;
  const get = realGraphGetObjectInfo({
    api: built.api,
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache: built.verifiedNodeDefCache,
  });
  const denied = await get({});
  assert.equal(denied.ok, false, "the live empty whole schema is a deny-all answer");
  assert.equal(objectInfoCache.peek().cached, false, "authoritative empty retired the old whole payload");
  assert.equal(objectInfoSnapshot.peek().held, false, "authoritative empty retired old membership proof");
  assert.equal(
    objectInfoSnapshot.authorize({
      epoch: 0,
      outcomes: [{ kind: TRANSPORT_OUTCOME.NO_ANSWER }],
    }).defs,
    null,
    "the cleared snapshot cannot authorize the removed type during a later outage",
  );

  authoritativeEmpty = false;
  unavailable = true;
  await assert.rejects(
    () => built.graph_set_widget({ node_id: 212, widget: "text", value: "refused", workflow_uuid: "u" }),
    /Cannot set widget|object_info is unavailable|refused/i,
    "the later ordinary timeout path refuses instead of serving old whole-schema state",
  );
  assert.equal(widget.value, "new", "the timeout refusal did not write");
  assert.deepEqual(
    calls.slice(-2),
    ["/object_info", "/object_info"],
    "the later ordinary read reached both live routes after the cache was retired",
  );
});

test("#1709: graph_get_object_info replaces changed whole authority before graph_set_widget timeout", async () => {
  const widget = { name: "text", type: "text", value: "before" };
  const oldDef = { input: { required: { text: ["STRING", {}] } } };
  const oldDefs = { RemovedNode: oldDef };
  const changedDefs = { OtherNode: { input: { required: {} } } };
  const node = {
    id: 215,
    type: "RemovedNode",
    widgets: [widget],
    constructor: { nodeData: oldDef, comfyClass: "RemovedNode" },
  };
  let now = 0;
  let liveDefs = oldDefs;
  const objectInfoCache = createObjectInfoCache({ now: () => now });
  const objectInfoSnapshot = createObjectInfoSnapshot();
  const built = realGraphSetWidget({
    node,
    objectInfoCache,
    objectInfoSnapshot,
    getNodeDefsImpl: async () => liveDefs,
    fetchApiImpl: async () =>
      liveDefs
        ? { status: 200, json: async () => liveDefs }
        : { status: 504, json: async () => ({}) },
    oracleDefs: oldDefs,
    registeredNodeTypes: {
      LoadImage: {},
      Note: {},
      RemovedNode: { nodeData: oldDef, comfyClass: "RemovedNode" },
    },
  });

  const first = await built.graph_set_widget({
    node_id: 215,
    widget: "text",
    value: "live-old",
    workflow_uuid: "u",
  });
  assert.equal(first.set.value, "live-old", "the old whole schema establishes the initial authority");

  liveDefs = changedDefs;
  const get = realGraphGetObjectInfo({
    api: built.api,
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache: built.verifiedNodeDefCache,
  });
  const fresh = await get({});
  assert.equal(fresh.ok, true, "the changed non-empty whole response is authoritative");
  assert.deepEqual(
    await objectInfoCache.read(async () => ({ Unexpected: {} })),
    changedDefs,
    "a later burst read sees the changed whole map, not the old cached map",
  );
  assert.equal(objectInfoSnapshot.peek().held, true, "the replacement map is also the snapshot authority");

  // Let the replacement expire, then make both live routes silent. The timeout path must
  // consult the replacement snapshot and refuse RemovedNode; it must not resurrect the
  // previous whole map that graph_get_object_info superseded.
  now += OBJECT_INFO_CACHE_TTL_MS + 1;
  liveDefs = null;
  await assert.rejects(
    () => built.graph_set_widget({ node_id: 215, widget: "text", value: "stale", workflow_uuid: "u" }),
    /Cannot set widget|does not provide|object_info is unavailable|refused/i,
    "the timeout fallback refuses the removed class",
  );
  assert.equal(widget.value, "live-old", "the stale timeout path did not mutate the widget");
});

test("#1709: graph_add preloaded refresh replaces authority before graph_set_widget timeout", async () => {
  const widget = { name: "text", type: "text", value: "before" };
  const oldDef = { input: { required: { text: ["STRING", {}] } } };
  const oldDefs = { RemovedNode: oldDef };
  const changedDefs = { OtherNode: { input: { required: {} } } };
  let now = 0;
  let liveDefs = oldDefs;
  const objectInfoCache = createObjectInfoCache({ now: () => now });
  const objectInfoSnapshot = createObjectInfoSnapshot();
  const verifiedNodeDefCache = createVerifiedNodeDefCache();
  const node = {
    id: 216,
    type: "RemovedNode",
    widgets: [widget],
    constructor: { nodeData: oldDef, comfyClass: "RemovedNode" },
  };
  const built = realGraphSetWidget({
    node,
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache,
    getNodeDefsImpl: async () => liveDefs,
    fetchApiImpl: async () =>
      liveDefs
        ? { status: 200, json: async () => liveDefs }
        : { status: 504, json: async () => ({}) },
    oracleDefs: oldDefs,
    registeredNodeTypes: {
      LoadImage: {},
      Note: {},
      RemovedNode: { nodeData: oldDef, comfyClass: "RemovedNode" },
    },
  });
  await built.graph_set_widget({ node_id: 216, widget: "text", value: "live-old", workflow_uuid: "u" });

  const refreshApp = {
    graph: null,
    refreshComboInNodes: async () => {},
    registerNodesFromDefs: async (payload) => {
      payload.OtherNode.input.required.hook_added = ["STRING", {}];
    },
  };
  const refresh = realPreloadedRefresh({
    app: refreshApp,
    api: { getNodeDefs: async () => ({ Unexpected: {} }) },
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache,
  });
  const verdict = await refresh(changedDefs, { preloadedWholeSchema: true });
  assert.equal(verdict.refreshed, true, "the actual preloaded refresh completed");
  assert.equal(Object.prototype.hasOwnProperty.call(changedDefs.OtherNode.input.required, "hook_added"), true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      (await objectInfoCache.read(async () => ({ Unexpected: {} }))).OtherNode.input.required,
      "hook_added",
    ),
    false,
    "the cached authority is isolated from registration hooks",
  );

  now += OBJECT_INFO_CACHE_TTL_MS + 1;
  liveDefs = null;
  await assert.rejects(
    () => built.graph_set_widget({ node_id: 216, widget: "text", value: "stale", workflow_uuid: "u" }),
    /Cannot set widget|does not provide|object_info is unavailable|refused/i,
    "the timeout fallback refuses the removed class after graph_add's real preloaded refresh",
  );
  assert.equal(widget.value, "live-old", "the stale timeout path did not mutate the widget");
});

test("#1709: a definitive per-class absence retires cached whole proof before graph_set_widget timeout fallback", async () => {
  const widget = { name: "text", type: "text", value: "before" };
  const def = {
    input: { required: { mode: [["old"], {}], text: ["STRING", {}] } },
  };
  const scanWidget = { name: "mode", type: "combo", options: { values: ["old"] }, value: "old" };
  const node = {
    id: 214,
    type: "RemovedNode",
    widgets: [widget, scanWidget],
    constructor: { nodeData: def, comfyClass: "RemovedNode" },
  };
  const objectInfoCache = createObjectInfoCache();
  const objectInfoSnapshot = createObjectInfoSnapshot();
  let unavailable = false;
  let holdWholeRead = false;
  const wholeReadStarted = deferred();
  const oldWholeResponse = deferred();
  const wholeDefs = { RemovedNode: def };
  const built = realGraphSetWidget({
    node,
    objectInfoCache,
    objectInfoSnapshot,
    oracleDefs: wholeDefs,
    getNodeDefsImpl: async () => {
      if (unavailable) return undefined;
      if (holdWholeRead) {
        wholeReadStarted.resolve();
        await oldWholeResponse.promise;
      }
      return wholeDefs;
    },
    fetchApiImpl: async (route) =>
      unavailable
        ? { status: 504, json: async () => ({}) }
        : { status: 200, json: async () => wholeDefs },
    registeredNodeTypes: {
      LoadImage: {},
      Note: {},
      RemovedNode: { nodeData: def, comfyClass: "RemovedNode" },
    },
  });

  const first = await built.graph_set_widget({
    node_id: 214,
    widget: "text",
    value: "after-first-write",
    workflow_uuid: "u",
  });
  assert.equal(first.set.value, "after-first-write", "the initial live whole schema authorizes the write");
  assert.equal(objectInfoCache.peek().cached, true, "the whole proof is cached before the class reader runs");
  assert.equal(objectInfoSnapshot.peek().held, true, "the whole membership proof is held before the class reader runs");

  objectInfoCache.invalidate();
  objectInfoSnapshot.clear();
  holdWholeRead = true;
  const pendingWholeWrite = built.graph_set_widget({
    node_id: 214,
    widget: "text",
    value: "stale-response-write",
    workflow_uuid: "u",
  });
  // Attach the handler before the independent per-class command can retire the response.
  // Node reports a rejected command as unhandled if the assertion waits until after that
  // overlapping command has completed.
  pendingWholeWrite.catch(() => {});
  await wholeReadStarted.promise;

  const graph = { _nodes: [node], getNodeById: () => node };
  const absent = await runProductionGraphGetErrors({
    graph,
    rootGraph: graph,
    lastExecFailure: null,
    scan: scanComboAvailability,
    fetchSingleNodeInfo: async () => ({
      [SINGLE_NODE_INFO_OUTCOME]: true,
      kind: "absent",
      body: {},
    }),
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache: built.verifiedNodeDefCache,
    stepBudget: () => 1000,
  });
  assert.equal(absent.unchecked_nodes.length, 1, "the definitive per-class absence is reported as unchecked");
  assert.equal(objectInfoCache.peek().cached, false, "the per-class reader retires the whole burst cache");
  assert.equal(objectInfoSnapshot.peek().held, false, "the per-class reader retires the whole membership snapshot");

  oldWholeResponse.resolve();
  await assert.rejects(
    () => pendingWholeWrite,
    /REFRESHED|possibly-stale|Refusing|refused/i,
    "the in-flight whole response issued before per-class absence cannot authorize the write",
  );
  assert.equal(widget.value, "after-first-write", "the retired whole response did not mutate the widget");

  unavailable = true;
  await assert.rejects(
    () =>
      built.graph_set_widget({
        node_id: 214,
        widget: "mode",
        value: "refused",
        workflow_uuid: "u",
      }),
    /Cannot set widget|object_info is unavailable|refused/i,
    "after definitive class absence, a later whole-schema timeout cannot reuse the old proof",
  );
  assert.equal(widget.value, "after-first-write", "the timeout fallback refuses before mutating the widget");
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
    /joinMs = budget\.remaining\(\) - SET_WIDGET_POST_REFRESH_RESERVE_MS/,
    "the fallback join draws from the command's remaining budget, not a fresh constant",
  );
});

// ---------------------------------------------------------------------------
// 4. #1418: the waits AHEAD of the recovery draw from the budget too, and the probe
//    after it is bounded. SCOPED to this command's body — graph_add_node holds the
//    sibling call sites, so an unscoped pin stays green with these deleted (the trap
//    the issue itself names).
// ---------------------------------------------------------------------------

test("#1418 the seed wait and the oracle read are capped by the command budget", () => {
  const body = SET_WIDGET_SRC;
  assert.match(
    body,
    /awaitObjectInfoHistorySeed\(budget\.bounded\(OBJECT_INFO_SEED_WAIT_MS\)\)/,
    "the flat 8000ms seed wait is capped by what the command has left",
  );
  assert.match(
    body,
    /deadlineMs:\s*budget\.bounded\([\s\S]{0,260}OBJECT_INFO_DEADLINE_MS/,
    "the flat 20000ms oracle deadline is capped by what the command has left",
  );
  assert.match(
    body,
    /budget\.bounded\(\)/,
    "the upload probe draws the remainder (no constant of its own to drift)",
  );
});
