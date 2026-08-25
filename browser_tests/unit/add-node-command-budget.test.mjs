// panel#1192 — `graph_add_node`'s bounds are each defensible alone and do not compose.
//
// Serialized on one add they sum past the 30,000 ms window `panel_add_node` relays this
// command in, so the worst case was a bare `Panel tab … did not reply to "graph_add_node"
// within 30000 ms` — a message that names nothing and offers no remedy — instead of the
// worded, retryable refusal each of those bounds exists to produce.
//
// The term that dominates is the one a caller cannot shrink: `refresh(freshDefs)` goes
// through `makeRefreshCoalescer`, which waits for any in-flight run before starting its own.
// On the scenario this add is most likely to meet — a ComfyUI restart, which is exactly when
// a reconnect-triggered refresh is already running — that wait is on a run that ALREADY
// STARTED under someone else's deadline.
//
// THE HARNESS runs the SHIPPED `graph_add_node` body, extracted from the panel source and
// given injected collaborators, and wires the REAL coalescer to a REAL in-flight run — the
// same technique as add-node-socket-proof-scope.test.mjs. A helper-level test cannot reach
// this defect: `makeCommandBudget` and `makeRefreshCoalescer` are individually correct, and
// the bug lives entirely in whether the call site threads one into the other.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { makeRefreshCoalescer, REFRESH_JOIN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
import { makeCommandBudget } from "../../web/js/lib/command-budget.js";
import {
  applyCurrentDefWidgetValues,
  driftedRequiredInputNames,
  missingRequiredWidgetMaterializations,
  registeredSocketTypes,
  unavailableRequiredWidgetMessage,
  unavailableRequiredWidgetReport,
} from "../../web/js/lib/node-widget-materialization.js";
import {
  assertAddNodeResolvableRefreshing,
  isRegisteredNodeType,
} from "../../web/js/lib/node-resolve.js";
import { fetchSingleNodeInfo } from "../../web/js/lib/single-node-def.js";
import { fetchNodeDefsWithRetry, OBJECT_INFO_RETRY_DELAYS_MS } from "../../web/js/lib/object-info-retry.js";
import {
  fetchWholeObjectInfo,
  objectInfoOracleFailureNote,
  TRANSPORT_OUTCOME,
} from "../../web/js/lib/object-info-oracle.js";
import { describeNodeDefRefresh, NODE_DEF_REFRESH_REASONS } from "../../web/js/lib/node-def-refresh.js";
import { comboRebuildCovered } from "../../web/js/lib/asset-staleness.js";
import {
  describeUnmaterializedRequiredWidgets,
  snapshotBackendDef,
} from "../../web/js/lib/add-node-widget-guard.js";
import {
  NODE_DEFS_FETCH_TIMEOUT_MS,
  NODE_DEFS_NO_ANSWER,
  NODE_DEFS_FETCH_SHARE,
  NODE_DEFS_RUN_BUDGET_MS,
  COMBO_OK,
  COMBO_NO_ANSWER,
  WIDEN_SOCKET_PROOF_TIMEOUT_MS,
  monotonicNow,
  widenSocketProofBudget,
} from "./_panel-constants.mjs";
import { clearInheritedExecutionPreview } from "../../web/js/lib/execution-preview-attach.js";
import { sanitizeNodeAuxId } from "../../web/js/lib/aux-id-sanitize.js";
import { createVerifiedNodeDefCache } from "../../web/js/lib/verified-node-def-cache.js";
import { createObjectInfoCache } from "../../web/js/lib/object-info-cache.js";
import { createObjectInfoSnapshot } from "../../web/js/lib/object-info-snapshot.js";
import { reconcileFreshDynamicWidgets } from "../../web/js/lib/dynamic-widget-reconcile.js";
import { safeRemoveNode } from "../../web/js/lib/safe-remove-node.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const addNodeMatch = panelSrc.match(
  /\n {2}async graph_add_node\(\{ class_type, pos, title \}\) \{[\s\S]*?\n {2}\},/,
);
assert.ok(addNodeMatch, "could not locate graph_add_node in panel source");

const graphGetMatch = panelSrc.match(
  /\n  async graph_get_object_info\(\{ if_none_match \} = \{\}\) \{[\s\S]*?\n  \},/,
);
assert.ok(graphGetMatch, "could not locate graph_get_object_info in panel source");

const awaitWidgetsMatch = panelSrc.match(
  /\nasync function awaitRequiredCustomWidgetRegistration\([\s\S]*?\n\}/,
);
assert.ok(awaitWidgetsMatch, "could not locate awaitRequiredCustomWidgetRegistration");

const placementMatch = panelSrc.match(/\nfunction placementFor\(graph, pos\) \{[\s\S]*?\n\}/);
assert.ok(placementMatch, "could not locate placementFor");

const boundedMatch = panelSrc.match(/\nasync function boundedGetNodeDefs\([\s\S]*?\n\}/);
assert.ok(boundedMatch, "could not locate boundedGetNodeDefs in panel source");

function extractFunction(marker) {
  const start = panelSrc.indexOf(marker);
  assert.notEqual(start, -1, `${marker} not found`);
  const open = panelSrc.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < panelSrc.length; i += 1) {
    const ch = panelSrc[i];
    if (ch === "/" && panelSrc[i + 1] === "/") {
      i = panelSrc.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && panelSrc[i + 1] === "*") {
      i = panelSrc.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < panelSrc.length; i += 1) {
        if (panelSrc[i] === "\\") {
          i += 1;
          continue;
        }
        if (panelSrc[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return panelSrc.slice(start, i + 1);
  }
  throw new Error(`unterminated function: ${marker}`);
}

const registerComfyNodeDefsBody = extractFunction("async function registerComfyNodeDefs(");

// The SHIPPED refusal, built from source rather than restated. A hand-copied sentence here
// would let the real one drift into naming a remedy that cannot work while this file stayed
// green — which is the failure mode the message itself exists to prevent.
const busyMatch = panelSrc.match(/const addNodeRefreshBusyMessage = [\s\S]*?;\r?\n/);
assert.ok(busyMatch, "could not locate addNodeRefreshBusyMessage in panel source");
const addNodeRefreshBusyMessage = new Function(
  "ADD_NODE_COMMAND_BUDGET_MS",
  `${busyMatch[0]}
   return addNodeRefreshBusyMessage;`,
)(25000);

/** A tiny deferred so a test can hold the in-flight refresh open until it chooses. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The backend's schema. `NewNode` is the freshly installed class the add is asking for. */
function backendObjectInfo() {
  return {
    ExistingNode: {
      name: "ExistingNode",
      input: { required: { seed: ["INT", { default: 0, min: 0, max: 10 }] } },
      output: ["IMAGE"],
    },
    NewNode: {
      name: "NewNode",
      input: { required: { count: ["INT", { default: 1, min: 0, max: 8 }] } },
      output: ["IMAGE"],
    },
  };
}

function makeComfy() {
  const widgets = {
    INT(node, name, spec) {
      const w = { name, type: "number", value: spec?.[1]?.default ?? 0, options: spec?.[1] ?? {} };
      node.widgets.push(w);
      return { widget: w };
    },
  };
  const graph = {
    _nodes: [],
    add(n) {
      n.id = this._nodes.length + 1;
      this._nodes.push(n);
    },
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
  };
  const LG = {
    registered_node_types: {},
    createNode(type) {
      const nodeData = LG.registered_node_types[type]?.nodeData;
      if (!nodeData) return null;
      const node = { type, title: type, pos: [0, 0], size: [200, 100], widgets: [], inputs: [] };
      for (const [name, spec] of Object.entries(nodeData.input?.required ?? {})) {
        const ctor = widgets[String(spec?.[0])];
        if (ctor) ctor(node, name, spec);
        else node.inputs.push({ name, type: spec?.[0] });
      }
      return node;
    },
  };
  const app = {
    graph,
    widgets,
    registerNodesFromDefs(defs) {
      for (const [type, nodeData] of Object.entries(defs ?? {})) {
        LG.registered_node_types[type] = { nodeData, comfyClass: type };
      }
    },
  };
  return { app, LG, graph, widgets };
}

/** Build the SHIPPED refresh body so the graph-add regression crosses the real
 * `registerComfyNodeDefs(preloadedDefs, runOpts)` invalidation boundary. */
function realRegisterComfyNodeDefs({ app, api, objectInfoCache, objectInfoSnapshot, verifiedNodeDefCache, epoch = 0 }) {
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
    nodeDefsBudgetLeft: (deadline, share = 1) => Math.max(1, Math.floor((deadline - monotonicNow()) * share)),
    monotonicNow,
    NODE_DEFS_RETRY_DELAYS_MS: OBJECT_INFO_RETRY_DELAYS_MS,
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache,
    initialBackendReconnectEpoch: epoch,
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
    ${registerComfyNodeDefsBody}
    return registerComfyNodeDefs;`,
  );
  return factory(...names.map((name) => values[name]));
}

/**
 * Build the SHIPPED `graph_add_node` with the REAL coalescer behind it.
 *
 * `budgetMs`/`reserveMs` are injected small so these tests run in milliseconds rather than
 * waiting out the shipped 25s. Same code, same arithmetic, shorter deadline — the shipped
 * NUMBERS are pinned separately, against the relay window, in single-node-def.test.mjs.
 */
function realGraphAddNode({
  comfy,
  getNodeDefs,
  // A promise the PAYLOAD-LESS (reconnect) run waits on before it registers anything, or
  // null for "no refresh is in flight". Held open, it is the reported scenario: a ComfyUI
  // restart, whose reconnect refresh is still running when the add arrives.
  holdInFlight = null,
  // #1351 — milliseconds the PAYLOAD run (this add's own registration) waits before it
  // registers. The residual: joinMs used to ignore this wait, so a join that landed still
  // paid the own run in full. Zero keeps every #1192 test on the same clock it had.
  ownRunMs = 0,
  // Defs the payload-less (reconnect) run registers once it lands. Default is a live
  // fetch, which includes NewNode — the #1192 "lands in time" path. The #1351 residual
  // is the older reconnect that did NOT see NewNode, so this add's own run is what
  // registers it.
  inFlightDefs = undefined,
  // Hook the refresh boundary used by the production coalescer. Tests use it to model the
  // same-epoch refresh invalidation that happens before the payload is registered.
  onRunRegister = null,
  budgetMs = 400,
  reserveMs = 120,
  registrationMs = 200,
  productionRegister = null,
  overrides = {},
} = {}) {
  const c = comfy ?? makeComfy();
  const { app, LG, graph } = c;
  const context = { app, LG, graph, rootGraph: graph, workflow: { uuid: "wf" } };

  const api = {
    getNodeDefs: getNodeDefs ?? (async () => backendObjectInfo()),
    async fetchApi(route) {
      const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
      const all = backendObjectInfo();
      const body = Object.prototype.hasOwnProperty.call(all, cls) ? { [cls]: all[cls] } : {};
      return { status: 200, json: async () => body };
    },
  };

  // The REAL single-flight coordinator, over a real slot, with a real in-flight run when the
  // test supplies one. Stubbing this away would remove the term the whole issue is about.
  let inFlight = null;
  const runs = [];
  const refreshComfyNodeDefs = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    runRegister: async (defs, runOpts, runControl) => {
      runs.push(defs);
      if (productionRegister) return productionRegister(defs, runOpts, runControl);
      // The reconnect run — the one with no payload — is the one a test can hold open.
      if (defs == null && holdInFlight) await holdInFlight;
      // #1351 — this add's own registration, after any join. Distinct from holdInFlight:
      // that is someone else's run, this is ours.
      if (defs != null && ownRunMs > 0) await sleep(ownRunMs);
      onRunRegister?.(defs);
      app.registerNodesFromDefs(defs ?? inFlightDefs ?? (await api.getNodeDefs()));
      return true;
    },
    withTimeout,
  });
  // A refresh someone else started — a websocket reconnect, a finished install — already
  // holding the slot when the add arrives.
  const inFlightStarted = holdInFlight ? refreshComfyNodeDefs(undefined) : null;

  const deps = {
    captureGraphMutationContext: () => context,
    revalidateGraphMutationContext: () => context,
    getGraphCtx: () => context,
    app,
    awaitObjectInfoHistorySeed: async () => {},
    recordObjectInfoTypes: (defs) => defs,
    objectInfoHistory: { wasTypeEverDefined: () => false },
    objectInfoSnapshot: { record: () => true, clear: () => {} },
    objectInfoCache: createObjectInfoCache(),
    verifiedNodeDefCache: createVerifiedNodeDefCache(),
    backendReconnectEpoch: 0,
    readPackImportFailures: async () => [],
    api,
    refreshComfyNodeDefs,
    summarizeNode: (node) => ({ id: node.id, type: node.type }),
    assertAddNodeResolvableRefreshing,
    driftedRequiredInputNames,
    registeredSocketTypes,
    missingRequiredWidgetMaterializations,
    applyCurrentDefWidgetValues,
    unavailableRequiredWidgetReport,
    unavailableRequiredWidgetMessage,
    snapshotBackendDef,
    isRegisteredNodeType,
    fetchSingleNodeInfo,
    describeUnmaterializedRequiredWidgets,
    NODE_DEFS_NO_ANSWER,
    WIDEN_SOCKET_PROOF_TIMEOUT_MS,
    widenSocketProofBudget,
    monotonicNow,
    NODE_DEFS_FETCH_TIMEOUT_MS,
    withTimeout,
    makeCommandBudget,
    REFRESH_JOIN_ABANDONED,
    addNodeRefreshBusyMessage,
    clearInheritedExecutionPreview,
    sanitizeNodeAuxId,
    reconcileFreshDynamicWidgets,
    safeRemoveNode,
    OBJECT_INFO_SEED_WAIT_MS: 8000,
    ADD_NODE_COMMAND_BUDGET_MS: budgetMs,
    ADD_NODE_POST_REFRESH_RESERVE_MS: reserveMs,
    ...overrides,
  };

  if (!("boundedGetNodeDefs" in deps)) {
    const build = new Function(
      "api",
      "withTimeout",
      "NODE_DEFS_NO_ANSWER",
      "NODE_DEFS_FETCH_TIMEOUT_MS",
      `${boundedMatch[0]}
       return boundedGetNodeDefs;`,
    );
    deps.boundedGetNodeDefs = (timeoutMs) =>
      build(deps.api, withTimeout, NODE_DEFS_NO_ANSWER, NODE_DEFS_FETCH_TIMEOUT_MS)(timeoutMs);
  }

  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `${awaitWidgetsMatch[0]}
     ${placementMatch[0]}
     const CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS = ${registrationMs};
     const CUSTOM_WIDGET_REGISTRATION_POLL_MS = 5;
     const executors = {${addNodeMatch[0]}};
     return executors.graph_add_node;`,
  );
  return {
    graph_add_node: factory(...names.map((n) => deps[n])),
    comfy: c,
    runs,
    inFlightStarted,
    verifiedNodeDefCache: deps.verifiedNodeDefCache,
    verifiedSchemaContext: context,
    objectInfoCache: deps.objectInfoCache,
    objectInfoSnapshot: deps.objectInfoSnapshot,
  };
}

function realGraphGetObjectInfo({
  api,
  verifiedNodeDefCache,
  objectInfoCache = createObjectInfoCache(),
  objectInfoSnapshot = { record: () => true, clear: () => {} },
}) {
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
    `const executors = {${graphGetMatch[0]}};
     return executors.graph_get_object_info;`,
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
    () => "fp",
    () => false,
  );
}

test("#1709: cached reuse still probes authority and refuses after backend removal", async () => {
  const comfy = makeComfy();
  const defs = backendObjectInfo();
  // The class is already registered, matching the reported repeated-add path and keeping
  // the first verification on the single-class route.
  comfy.app.registerNodesFromDefs(defs);
  const calls = [];
  let unavailable = false;
  let removed = false;
  const api = {
    async fetchApi(route) {
      calls.push(route);
      if (unavailable) return { status: 503, json: async () => ({}) };
      if (removed) return { status: 503, json: async () => ({}) };
      const classType = decodeURIComponent(String(route).replace("/object_info/", ""));
      return {
        status: 200,
        json: async () =>
          Object.prototype.hasOwnProperty.call(defs, classType) ? { [classType]: defs[classType] } : {},
      };
    },
    async getNodeDefs() {
      calls.push("/object_info");
      if (removed) return {};
      return NODE_DEFS_NO_ANSWER;
    },
  };
  const built = realGraphAddNode({
    comfy,
    overrides: { api, objectInfoHistory: { wasTypeEverDefined: () => true } },
  });

  const first = await built.graph_add_node({ class_type: "ExistingNode" });
  assert.equal(first.added.type, "ExistingNode");
  unavailable = true;

  const second = await built.graph_add_node({ class_type: "ExistingNode" });
  assert.equal(second.added.type, "ExistingNode");
  assert.equal(comfy.graph._nodes.length, 2);
  assert.deepEqual(
    calls,
    ["/object_info/ExistingNode", "/object_info/ExistingNode", "/object_info"],
    "the second add used the verified proof only after both live routes timed out",
  );

  unavailable = false;
  removed = true;
  await assert.rejects(
    () => built.graph_add_node({ class_type: "ExistingNode" }),
    /ABSENT from the current \/object_info|since-removed/i,
    "an authoritative whole-schema absence cannot be bypassed by the cached proof",
  );
  assert.equal(comfy.graph._nodes.length, 2, "the removed backend type was not added again");

  removed = false;
  const restored = await built.graph_add_node({ class_type: "ExistingNode" });
  assert.equal(restored.added.type, "ExistingNode", "a fresh authoritative re-add still works");
  assert.equal(comfy.graph._nodes.length, 3);
});

test("#1709: an overlapping authoritative absence fences a late cached-proof write", async () => {
  const comfy = makeComfy();
  const defs = {
    ...backendObjectInfo(),
    ExistingNode: {
      name: "ExistingNode",
      input: { required: { mode: ["RACE_WIDGET", { default: "ready" }] } },
      output: ["IMAGE"],
    },
  };
  const customWidget = (node, name, spec) => {
    const widget = {
      name,
      type: "custom",
      value: spec?.[1]?.default ?? "ready",
      options: { serialize: true },
    };
    node.widgets.push(widget);
    return { widget };
  };
  comfy.widgets.RACE_WIDGET = customWidget;
  comfy.app.registerNodesFromDefs(defs);

  const calls = [];
  let unavailable = false;
  let removed = false;
  const api = {
    async fetchApi(route) {
      calls.push(route);
      if (unavailable || removed) return { status: 503, json: async () => ({}) };
      const classType = decodeURIComponent(String(route).replace("/object_info/", ""));
      return {
        status: 200,
        json: async () =>
          Object.prototype.hasOwnProperty.call(defs, classType) ? { [classType]: defs[classType] } : {},
      };
    },
    async getNodeDefs() {
      calls.push("/object_info");
      return removed ? {} : NODE_DEFS_NO_ANSWER;
    },
  };
  const built = realGraphAddNode({
    comfy,
    overrides: { api, objectInfoHistory: { wasTypeEverDefined: () => true } },
  });

  const initial = await built.graph_add_node({ class_type: "ExistingNode" });
  assert.equal(initial.added.type, "ExistingNode");
  delete comfy.widgets.RACE_WIDGET;

  // The real shipped awaitRequiredCustomWidgetRegistration supplies the async pause after
  // the cached proof has been accepted. Its production widget registry is proxied only to
  // observe that the first add reached that wait; the actual constructor is restored below.
  const customWidgetWait = deferred();
  let waitObserved = false;
  const widgetRegistry = comfy.app.widgets;
  comfy.app.widgets = new Proxy(widgetRegistry, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "RACE_WIDGET" && typeof value !== "function" && !waitObserved) {
        waitObserved = true;
        customWidgetWait.resolve();
      }
      return value;
    },
  });

  unavailable = true;
  const overlappingAdd = built.graph_add_node({ class_type: "ExistingNode" });
  await customWidgetWait.promise;

  removed = true;
  await assert.rejects(
    () => built.graph_add_node({ class_type: "ExistingNode" }),
    /ABSENT from the current \/object_info|since-removed/i,
    "the overlapping command observes authoritative removal and invalidates proof",
  );
  const invalidatedGeneration = built.verifiedNodeDefCache.generation();
  assert.equal(
    built.verifiedNodeDefCache.get("ExistingNode", {
      epoch: 0,
      context: built.verifiedSchemaContext,
      generation: invalidatedGeneration,
    }),
    undefined,
    "authoritative absence removed the pre-existing proof before the first add resumed",
  );

  comfy.widgets.RACE_WIDGET = customWidget;
  const resumed = await overlappingAdd;
  assert.equal(resumed.added.type, "ExistingNode");
  assert.equal(comfy.graph._nodes.length, 2, "the paused add completed once");
  assert.equal(
    built.verifiedNodeDefCache.get("ExistingNode", {
      epoch: 0,
      context: built.verifiedSchemaContext,
      generation: invalidatedGeneration,
    }),
    undefined,
    "the paused add could not resurrect proof with its pre-invalidation generation",
  );

  unavailable = true;
  removed = false;
  await assert.rejects(
    () => built.graph_add_node({ class_type: "ExistingNode" }),
    /cannot verify node type|object_info is unavailable|Refusing to add/i,
    "a later silent add fails closed instead of reusing the stale proof",
  );
  assert.equal(comfy.graph._nodes.length, 2, "the later silent add did not mutate the graph");
  assert.deepEqual(
    calls,
    [
      "/object_info/ExistingNode",
      "/object_info/ExistingNode",
      "/object_info",
      "/object_info",
      "/object_info/ExistingNode",
      "/object_info",
      "/object_info/ExistingNode",
      "/object_info",
    ],
    "the later add still probes both live routes after the fenced write",
  );
});

test("#1709: an authoritative empty whole read retires cached proof before timeout fallback", async () => {
  const comfy = makeComfy();
  const defs = backendObjectInfo();
  comfy.app.registerNodesFromDefs(defs);
  const calls = [];
  let removed = false;
  let unavailable = false;
  const api = {
    async getNodeDefs() {
      calls.push("/object_info");
      if (unavailable) return NODE_DEFS_NO_ANSWER;
      if (removed) return {};
      return defs;
    },
    async fetchApi(route) {
      calls.push(route);
      if (unavailable || removed) return { status: 503, json: async () => ({}) };
      const classType = decodeURIComponent(String(route).replace("/object_info/", ""));
      return { status: 200, json: async () => ({ [classType]: defs[classType] }) };
    },
  };
  const built = realGraphAddNode({
    comfy,
    overrides: { api, objectInfoHistory: { wasTypeEverDefined: () => true } },
  });
  const first = await built.graph_add_node({ class_type: "ExistingNode" });
  assert.equal(first.added.type, "ExistingNode");
  const beforeGeneration = built.verifiedNodeDefCache.generation();
  assert.ok(
    built.verifiedNodeDefCache.get("ExistingNode", {
      epoch: 0,
      context: built.verifiedSchemaContext,
      generation: beforeGeneration,
    }),
    "the first production add established reusable proof",
  );

  removed = true;
  const getObjectInfo = realGraphGetObjectInfo({
    api,
    verifiedNodeDefCache: built.verifiedNodeDefCache,
    objectInfoCache: createObjectInfoCache(),
  });
  const denied = await getObjectInfo({});
  assert.equal(denied.ok, false, "the authoritative empty whole schema still refuses");
  const afterGeneration = built.verifiedNodeDefCache.generation();
  assert.ok(afterGeneration > beforeGeneration, "the live deny-all answer advanced the cache fence");
  assert.equal(
    built.verifiedNodeDefCache.get("ExistingNode", {
      epoch: 0,
      context: built.verifiedSchemaContext,
      generation: afterGeneration,
    }),
    undefined,
    "the authoritative empty whole read retired the cached proof",
  );

  removed = false;
  unavailable = true;
  await assert.rejects(
    () => built.graph_add_node({ class_type: "ExistingNode" }),
    /cannot verify node type|object_info is unavailable|Refusing to add/i,
    "a later timeout cannot fall back to proof retired by the empty answer",
  );
  assert.equal(comfy.graph._nodes.length, 1, "the refused timeout fallback did not add a node");
  assert.deepEqual(
    calls,
    ["/object_info/ExistingNode", "/object_info", "/object_info/ExistingNode", "/object_info"],
    "the later add reached both live probes rather than bypassing them",
  );
});

test("#1709: a direct schema response crossing refresh cannot authorize a later timeout fallback", async () => {
  const comfy = makeComfy();
  const defs = backendObjectInfo();
  comfy.app.registerNodesFromDefs(defs);
  const snapshot = createObjectInfoSnapshot();
  assert.equal(
    snapshot.record(defs, {
      observedAtEpoch: 0,
      currentEpoch: 0,
      observedAtGeneration: 0,
      currentGeneration: 0,
      whole: true,
    }),
    true,
    "the pre-refresh production state has an old whole-schema snapshot",
  );

  const directStarted = deferred();
  const oldDirectResponse = deferred();
  let holdDirect = false;
  const calls = [];
  const api = {
    async fetchApi(route) {
      calls.push(route);
      if (route === "/object_info/ExistingNode" && holdDirect) {
        directStarted.resolve();
        await oldDirectResponse.promise;
      }
      const classType = decodeURIComponent(String(route).replace("/object_info/", ""));
      return {
        status: 200,
        json: async () =>
          Object.prototype.hasOwnProperty.call(defs, classType) ? { [classType]: defs[classType] } : {},
      };
    },
    async getNodeDefs() {
      calls.push("/object_info");
      return NODE_DEFS_NO_ANSWER;
    },
  };
  const built = realGraphAddNode({
    comfy,
    overrides: {
      api,
      objectInfoSnapshot: snapshot,
      objectInfoHistory: { wasTypeEverDefined: () => true },
    },
  });

  const initial = await built.graph_add_node({ class_type: "ExistingNode" });
  assert.equal(initial.added.type, "ExistingNode");
  const beforeRefreshGeneration = built.verifiedNodeDefCache.generation();
  assert.ok(
    built.verifiedNodeDefCache.get("ExistingNode", {
      epoch: 0,
      context: built.verifiedSchemaContext,
      generation: beforeRefreshGeneration,
    }),
    "the initial add established the reusable proof",
  );

  holdDirect = true;
  const pendingAdd = built.graph_add_node({ class_type: "ExistingNode" });
  await directStarted.promise;

  // This is the same state transition registerComfyNodeDefs performs at refresh start:
  // old whole-schema membership and verified per-class proof are both retired before the
  // refresh fetch is allowed to establish new authority.
  snapshot.clear();
  built.verifiedNodeDefCache.clear();
  const afterRefreshGeneration = built.verifiedNodeDefCache.generation();
  assert.ok(afterRefreshGeneration > beforeRefreshGeneration);

  oldDirectResponse.resolve();
  await assert.rejects(
    () => pendingAdd,
    /cannot verify node type|object_info is unavailable|Refusing to add/i,
    "the old direct response cannot authorize after refresh; the timeout fallback refuses",
  );
  assert.equal(comfy.graph._nodes.length, 1, "the stale response did not mutate the graph");
  assert.equal(snapshot.peek().held, false, "the old whole-schema snapshot stayed retired");
  assert.equal(
    built.verifiedNodeDefCache.get("ExistingNode", {
      epoch: 0,
      context: built.verifiedSchemaContext,
      generation: afterRefreshGeneration,
    }),
    undefined,
    "the old direct response did not repopulate verified proof",
  );
  assert.deepEqual(
    calls,
    ["/object_info/ExistingNode", "/object_info/ExistingNode", "/object_info"],
    "the stale direct response was discarded and the add reached the timeout fallback",
  );
});

test("#2249: the shipped refresh keeps last-known membership after whole-schema replacement fails", async () => {
  const comfy = makeComfy();
  const snapshot = createObjectInfoSnapshot();
  const verifiedNodeDefCache = createVerifiedNodeDefCache();
  assert.equal(
    snapshot.record({ ImageScale: {} }, {
      observedAtEpoch: 0,
      currentEpoch: 0,
      observedAtGeneration: 0,
      currentGeneration: 0,
      whole: true,
    }),
    true,
  );
  const register = realRegisterComfyNodeDefs({
    app: comfy.app,
    api: {
      async getNodeDefs() {
        return NODE_DEFS_NO_ANSWER;
      },
      async fetchApi() {
        return { ok: false, status: 503, json: async () => ({}) };
      },
    },
    objectInfoCache: createObjectInfoCache(),
    objectInfoSnapshot: snapshot,
    verifiedNodeDefCache,
  });

  const verdict = await register(undefined, { runBudgetMs: 100 });
  assert.equal(verdict.refreshed, false, "the failed replacement does not claim freshness");
  assert.equal(snapshot.isReplacementPending(), false, "the pending fence settles after failure");
  const fallback = snapshot.authorize({
    epoch: 0,
    generation: verifiedNodeDefCache.generation(),
    socketDown: false,
    outcomes: [
      { route: "client", kind: TRANSPORT_OUTCOME.NO_ANSWER },
      { route: "http", kind: TRANSPORT_OUTCOME.NO_ANSWER },
    ],
  });
  assert.ok(fallback.defs?.ImageScale, "the old whole map remains usable for an existing node");
});

test("#2249: an empty refresh response retires the old whole snapshot instead of rebinding it", async () => {
  const comfy = makeComfy();
  const snapshot = createObjectInfoSnapshot();
  const verifiedNodeDefCache = createVerifiedNodeDefCache();
  snapshot.record(
    { ImageScale: {} },
    {
      observedAtEpoch: 0,
      currentEpoch: 0,
      observedAtGeneration: 0,
      currentGeneration: 0,
      whole: true,
    },
  );
  const register = realRegisterComfyNodeDefs({
    app: comfy.app,
    api: {
      async getNodeDefs() {
        return {};
      },
    },
    objectInfoCache: createObjectInfoCache(),
    objectInfoSnapshot: snapshot,
    verifiedNodeDefCache,
  });

  await register(undefined, { runBudgetMs: 100 });
  assert.equal(snapshot.peek().held, false, "an authoritative empty replacement leaves no old membership proof");
  assert.equal(
    snapshot.authorize({
      epoch: 0,
      generation: verifiedNodeDefCache.generation(),
      socketDown: false,
      outcomes: [{ route: "client", kind: TRANSPORT_OUTCOME.NO_ANSWER }],
    }).defs,
    null,
    "a later silent probe cannot resurrect a type absent from the empty replacement",
  );
});

test("#1709: graph_add_node replaces the old whole cache and snapshot on a changed response", async () => {
  const comfy = makeComfy();
  const oldDefs = { OldNode: { input: { required: {} } } };
  const changedDefs = {
    NewNode: { input: { required: { count: ["INT", { default: 1 }] } } },
  };
  const objectInfoCache = createObjectInfoCache();
  const objectInfoSnapshot = createObjectInfoSnapshot();
  const verifiedNodeDefCache = createVerifiedNodeDefCache();
  await objectInfoCache.read(async () => oldDefs);
  assert.equal(
    objectInfoSnapshot.record(oldDefs, {
      observedAtEpoch: 0,
      currentEpoch: 0,
      observedAtGeneration: 0,
      currentGeneration: 0,
      whole: true,
    }),
    true,
    "the production precondition starts with an older whole authority",
  );
  comfy.app.refreshComboInNodes = async () => {};
  const originalRegister = comfy.app.registerNodesFromDefs;
  comfy.app.registerNodesFromDefs = (defs) => {
    defs.NewNode.input.required.count[1].default = 999;
    originalRegister(defs);
  };
  const api = {
    getNodeDefs: async () => changedDefs,
    fetchApi: async () => ({ status: 503, json: async () => ({}) }),
  };
  const productionRegister = realRegisterComfyNodeDefs({
    app: comfy.app,
    api,
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache,
  });

  const built = realGraphAddNode({
    comfy,
    getNodeDefs: async () => changedDefs,
    productionRegister,
    overrides: {
      api,
      objectInfoCache,
      objectInfoSnapshot,
      verifiedNodeDefCache,
    },
  });
  const result = await built.graph_add_node({ class_type: "NewNode" });
  assert.equal(result.added.type, "NewNode", "the changed whole response still permits its current class");
  const cached = await objectInfoCache.read(async () => ({ Unexpected: {} }));
  assert.equal(cached.NewNode.input.required.count[1].default, 1, "the cache is isolated from registration-hook mutation");
  assert.equal(Object.prototype.hasOwnProperty.call(cached, "OldNode"), false, "the old whole map was replaced");
  const fallback = objectInfoSnapshot.authorize({
    epoch: 0,
    outcomes: [{ kind: TRANSPORT_OUTCOME.NO_ANSWER }],
  });
  assert.ok(fallback.defs, "the changed response remains available as current snapshot authority");
  assert.equal(Object.prototype.hasOwnProperty.call(fallback.defs, "OldNode"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fallback.defs, "NewNode"), true);
});

test("#1709: a same-epoch refresh fences graph_add_node's late whole-schema snapshot write", async () => {
  const comfy = makeComfy();
  const defs = backendObjectInfo();
  const snapshot = createObjectInfoSnapshot();
  const verifiedNodeDefCache = createVerifiedNodeDefCache();
  assert.equal(
    snapshot.record(defs, {
      observedAtEpoch: 0,
      currentEpoch: 0,
      observedAtGeneration: 0,
      currentGeneration: 0,
      whole: true,
    }),
    true,
    "the pre-refresh state starts with a whole-schema snapshot",
  );
  let unavailable = false;
  const api = {
    async getNodeDefs() {
      return unavailable ? NODE_DEFS_NO_ANSWER : defs;
    },
    async fetchApi(route) {
      if (unavailable) return { status: 503, json: async () => ({}) };
      const classType = decodeURIComponent(String(route).replace("/object_info/", ""));
      return { status: 200, json: async () => ({ [classType]: defs[classType] }) };
    },
  };
  const built = realGraphAddNode({
    comfy,
    onRunRegister: (refreshDefs) => {
      if (refreshDefs != null) {
        // registerComfyNodeDefs performs this transition before registration. Keep the
        // backend epoch unchanged: this is precisely the same-epoch race under review.
        snapshot.clear();
        verifiedNodeDefCache.clear();
      }
    },
    overrides: {
      api,
      objectInfoSnapshot: snapshot,
      verifiedNodeDefCache,
    },
  });

  const first = await built.graph_add_node({ class_type: "NewNode" });
  assert.equal(first.added.type, "NewNode", "the refresh still registers and adds the requested class");
  assert.equal(snapshot.peek().held, true, "the authoritative whole result was re-filed against the post-refresh generation");

  unavailable = true;
  await assert.rejects(
    () => built.graph_add_node({ class_type: "NewNode" }),
    /cannot verify node type|object_info is unavailable|Refusing to add/i,
    "a later silent add refuses because the fenced snapshot supplied no stale fallback",
  );
  assert.equal(comfy.graph._nodes.length, 1, "the later timeout did not add through old snapshot authority");
});

// ---------------------------------------------------------------------------
// 1. The reported composition: the join alone would exhaust the command.
// ---------------------------------------------------------------------------

test("#1192: an add refuses IN WORDS when the in-flight refresh would eat the whole budget", async () => {
  // Held open, so the add's `refresh(freshDefs)` genuinely waits on a run it did not start
  // and cannot shorten — the term the whole issue is about, exercised through the real
  // coalescer rather than modelled.
  const gate = deferred();
  const comfy = makeComfy();
  const built = realGraphAddNode({
    comfy,
    holdInFlight: gate.promise,
    budgetMs: 400,
    reserveMs: 120,
  });

  const started = Date.now();
  await assert.rejects(
    () => built.graph_add_node({ class_type: "NewNode" }),
    (err) => {
      // The SHIPPED wording, not a paraphrase.
      assert.equal(err.message, addNodeRefreshBusyMessage("NewNode"));
      return true;
    },
    "an add whose budget went on someone else's refresh must refuse, in words",
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `refused in ${elapsed}ms — it must give up at the bound, not wait the run out`);

  // NOTHING was added. The alternative to refusing is adding a node whose class may not be
  // registered, which is #458's fabricated placeholder.
  assert.equal(comfy.graph._nodes.length, 0, "the graph was not touched");

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
});

test("#1192: the refusal names a remedy that WORKS — retry, not a tab reload", async () => {
  // #663/#852: a refusal that sends the caller to the wrong recovery costs more than the
  // refusal itself. The resolver's own message here is "the node-def refresh failed — reload
  // the ComfyUI tab", which is wrong twice over: the refresh did not fail, and reloading
  // throws away the user's canvas state for a condition that clears on its own.
  const msg = addNodeRefreshBusyMessage("NewNode");
  assert.match(msg, /NOTHING WAS ADDED/, "the caller must know the graph is untouched before it retries");
  assert.match(msg, /RETRY/, "…and that a retry is the remedy");
  assert.ok(!/reload/i.test(msg), "…and must not be told to reload the tab");
  assert.match(msg, /panel_refresh_nodes/, "…with a concrete escalation if retrying keeps failing");
});

test("#1192: the abandoned add does NOT start a competing registration run", async () => {
  // Two concurrent registerNodesFromDefs passes are the stampede makeRefreshCoalescer exists
  // to prevent. A caller that has just given up waiting for one is the last thing that
  // should launch a second — so the fresh payload is DROPPED, which is safe only because the
  // caller refuses rather than claiming success. (#289 P2 forbids dropping a payload while
  // reporting success, not dropping one while refusing.)
  const gate = deferred();
  const comfy = makeComfy();
  const built = realGraphAddNode({ comfy, holdInFlight: gate.promise, budgetMs: 400, reserveMs: 120 });

  await built.graph_add_node({ class_type: "NewNode" }).catch(() => {});
  assert.deepEqual(built.runs, [undefined], "only the in-flight reconnect run ever started");

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
});

// ---------------------------------------------------------------------------
// 2. The healthy paths, which the bound must not narrow.
// ---------------------------------------------------------------------------

test("#1192: an in-flight refresh that lands in time still lets the add through", async () => {
  // The bound must not become a way to refuse adds on a machine doing nothing wrong. This is
  // what the reported scenario actually hits most of the time.
  const comfy = makeComfy();
  const landing = sleep(20); // the reconnect run finishes well inside the add's join budget
  const built = realGraphAddNode({ comfy, holdInFlight: landing, budgetMs: 4000, reserveMs: 120 });

  const { added } = await built.graph_add_node({ class_type: "NewNode" });
  assert.equal(added.type, "NewNode", "the add succeeded");
  assert.equal(comfy.graph._nodes.length, 1);
  await built.inFlightStarted;
});

test("#1192: with NO refresh in flight the add pays nothing for the join at all", async () => {
  const comfy = makeComfy();
  const built = realGraphAddNode({ comfy, budgetMs: 4000 });
  const started = Date.now();
  const { added } = await built.graph_add_node({ class_type: "NewNode" });
  assert.equal(added.type, "NewNode");
  assert.ok(Date.now() - started < 500, "a healthy add is not slowed by a bound it never reaches");
});

test("#1192: an ALREADY-registered class takes the fast path and never reaches the refresh", async () => {
  // #780's saving, preserved: the budget must not have made the cheap path pay for the
  // expensive one's protection.
  const comfy = makeComfy();
  comfy.app.registerNodesFromDefs({ ExistingNode: backendObjectInfo().ExistingNode });
  let wholeReads = 0;
  const built = realGraphAddNode({
    comfy,
    budgetMs: 4000,
    getNodeDefs: async () => {
      wholeReads += 1;
      return backendObjectInfo();
    },
  });
  const { added } = await built.graph_add_node({ class_type: "ExistingNode" });
  assert.equal(added.type, "ExistingNode");
  assert.equal(wholeReads, 0, "the whole schema was never re-downloaded");
  assert.deepEqual(built.runs, [], "…and no refresh run was needed");
});

// ---------------------------------------------------------------------------
// 3. The budget reaches the LAST step too, and says so when it does.
// ---------------------------------------------------------------------------

test("#1192: a /object_info read that eats the budget leaves the add a bound, not a hang", async () => {
  // The whole-schema fetch draws `budget.bounded(NODE_DEFS_FETCH_TIMEOUT_MS)`. With the
  // command nearly spent that is a small number, and the add fails closed on the path an
  // unreadable schema already takes — rather than parking on a 10s bound the command cannot
  // afford.
  const comfy = makeComfy();
  const built = realGraphAddNode({
    comfy,
    budgetMs: 200,
    getNodeDefs: () => new Promise(() => {}), // half-open: never answers, never fails
  });
  const started = Date.now();
  await assert.rejects(
    () => built.graph_add_node({ class_type: "NewNode" }),
    /object_info is unavailable|cannot verify node type/,
    "a schema that never answers must produce the unreadable-schema refusal",
  );
  assert.ok(Date.now() - started < 3000, "…at the command's bound, not at the standalone 10s one");
});

test("#1192: a registration wait cut short by the budget SAYS it was, and says retry first", async () => {
  // The message this wait throws tells the user to reload the tab and that "retrying alone
  // will not fix it" — right for an extension that failed to load, and exactly wrong for a
  // wait that was cut short by a command already running late, where a retry gets the full
  // window. Without the note, the budget would manufacture a confident wrong diagnosis.
  const comfy = makeComfy();
  // A required input whose declared type has no registered widget and no installed producer:
  // the guard waits for a constructor that will never appear.
  const schema = {
    NewNode: {
      name: "NewNode",
      input: { required: { thing: ["MYSTERY_T", { default: 1 }] } },
      output: ["IMAGE"],
    },
  };
  const built = realGraphAddNode({
    comfy,
    budgetMs: 260,
    reserveMs: 0,
    // 400, not 200: the wait must end at the BUDGET's remainder (~60ms after the fetch), so
    // the standalone timeout has to sit far enough past it that a wait which ignores the
    // budget and takes its full window is unambiguously late — 180ms of fetch plus 400ms of
    // wait is more than double the whole command.
    registrationMs: 400,
    getNodeDefs: async () => {
      await sleep(180); // most of the command spent before the wait even begins
      return schema;
    },
  });

  const started = Date.now();
  await assert.rejects(
    () => built.graph_add_node({ class_type: "NewNode" }),
    (err) => {
      assert.match(err.message, /had no widget after/, "…still the #695 report, with its causes");
      assert.match(err.message, /this wait was cut short/, "the truncation must be disclosed");
      assert.match(err.message, /RETRY FIRST/, "…and the retry must outrank the reload advice");
      return true;
    },
  );
  // The MESSAGE assertions above pass even when the wait ignores the budget it was handed —
  // `cutShort` is computed from the same `wait` the mutation bypasses — so the truncation
  // itself is asserted on the clock: the refusal must land near the budget's remainder, not
  // after the wait's full standalone window. A wait that took its own 400ms after a 180ms
  // fetch has spent more than two command budgets.
  assert.ok(
    Date.now() - started < 400,
    "the wait must end at the budget's remainder, not run out its full standalone window",
  );
});

test("#1192: a registration wait that got its FULL window says nothing about a budget", async () => {
  // The note must not appear on a wait that was not truncated — a disclosure that fires
  // every time is one nobody reads, and it would send a genuine extension failure chasing a
  // budget that was never the cause.
  const comfy = makeComfy();
  const schema = {
    NewNode: {
      name: "NewNode",
      input: { required: { thing: ["MYSTERY_T", { default: 1 }] } },
      output: ["IMAGE"],
    },
  };
  const built = realGraphAddNode({
    comfy,
    budgetMs: 8000,
    registrationMs: 120,
    getNodeDefs: async () => schema,
  });

  await assert.rejects(
    () => built.graph_add_node({ class_type: "NewNode" }),
    (err) => {
      assert.match(err.message, /had no widget after/);
      assert.ok(!/cut short/.test(err.message), "an untruncated wait must not claim a budget cut it");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 4. The whole point: the command lands inside its window.
// ---------------------------------------------------------------------------

test("#1192: every step stalling at once still replies inside the command budget", async () => {
  // The composition, end to end. Before this fix each of these stalls took its own full
  // bound and they ADDED — ~41s against a 30s relay window — so the reply never left the
  // tab. Now they draw on one deadline, so the command reports SOMETHING in time, which is
  // the property the relay actually needs.
  const comfy = makeComfy();
  const gate = deferred(); // the reconnect run never lands
  const BUDGET_MS = 500;
  const built = realGraphAddNode({
    comfy,
    holdInFlight: gate.promise,
    budgetMs: BUDGET_MS,
    reserveMs: 100,
    registrationMs: 200,
    getNodeDefs: async () => {
      await sleep(150);
      return backendObjectInfo();
    },
    overrides: {
      // A baseline seed that never settles on its own: bounded at the command's remainder,
      // so it costs what the command can afford and no more.
      awaitObjectInfoHistorySeed: (waitMs) =>
        new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(waitMs ?? 8000, 8000)))),
    },
  });

  const started = Date.now();
  const outcome = await built.graph_add_node({ class_type: "NewNode" }).then(
    (v) => ({ ok: v }),
    (err) => ({ err }),
  );
  const elapsed = Date.now() - started;

  assert.ok(outcome.err, "with every step stalled the add must refuse rather than succeed");
  // Generous against the budget, because the unbounded local work this deliberately cannot
  // interrupt is real and the CI box is shared. The number that matters is that it is a
  // small multiple of the budget rather than the ~41s sum of the individual bounds.
  assert.ok(
    elapsed < BUDGET_MS * 6,
    `the add took ${elapsed}ms against a ${BUDGET_MS}ms budget — the bounds are adding again`,
  );

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
});

// ---------------------------------------------------------------------------
// 4. THE FIFTH WAIT: #1242's drift recovery is inside this command too.
//
// `graph_add_node` has FIVE waits, not four. The fifth is #1242's `force: true` refresh,
// run when the registered schema has drifted from the backend's. The coalescer's forced
// branch AWAITS ANY IN-FLIGHT RUN before queueing its own, so unbounded it is the same
// term this issue is about — reached later, with the window already partly spent.
//
// Counting `budget.` call sites in the source cannot see this: the budget was threaded
// through four awaits and the fifth simply was not one of them. Only a test that DRIVES
// this path finds it, which is why this one holds a real in-flight run open and asserts
// the add still answers at all.
// ---------------------------------------------------------------------------

test("#1192: the #1242 drift-recovery refresh is bounded by the command budget too", async () => {
  // The class is ALREADY registered, so the resolver returns on its fast path and never
  // calls refresh — the only refresh this add performs is #1242's. `driftedRequiredInput-
  // Names` is forced non-empty so that recovery actually runs; that is the path under test.
  const comfy = makeComfy();
  comfy.app.registerNodesFromDefs({ ExistingNode: backendObjectInfo().ExistingNode });
  const gate = deferred(); // a reconnect refresh that never lands
  const built = realGraphAddNode({
    comfy,
    holdInFlight: gate.promise,
    budgetMs: 400,
    reserveMs: 120,
    overrides: { driftedRequiredInputNames: () => ["seed"] },
  });

  const started = Date.now();
  // UNBOUNDED, this call parks on the held-open run and the add never answers at all — the
  // reported failure, reproduced. Bounded, it gives up and refuses in words about the drift.
  await assert.rejects(
    () => built.graph_add_node({ class_type: "ExistingNode" }),
    (err) => {
      assert.match(err.message, /required input/i, "the refusal is the drift one, worded");
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 3000,
    `the drift recovery took ${elapsed}ms — it must give up at the command's bound, not ` +
      "wait out a run started by something else",
  );
  gate.resolve();
});

test("#1192: an abandoned drift recovery is reported as a RETRY, not as 'unknown'", async () => {
  // The generic branch turns any non-true verdict into reason "unknown". A Symbol lands
  // there unless it is handled FIRST, and "unknown" is the shape of answer this repo keeps
  // getting burned by: it cannot tell a refresh that FAILED from one this command simply
  // stopped waiting for. Only the second is cleared by retrying.
  const addBody = addNodeMatch[0];
  assert.match(
    addBody,
    /force: true,\s*\n\s*joinMs: budget\.remaining\(\) - ADD_NODE_POST_REFRESH_RESERVE_MS,/,
    "the #1242 drift refresh must draw its join bound from the command budget",
  );
  const at = addBody.indexOf("if (verdict === REFRESH_JOIN_ABANDONED)");
  assert.ok(at > 0, "an abandoned drift recovery must be distinguished from a failed one");
  assert.match(
    addBody.slice(at, at + 700),
    /retry/i,
    "…and its reason must name the remedy that actually works",
  );
});

// ---------------------------------------------------------------------------
// 5. #1351: the join SUCCEEDING is not the end of the wait this command owns.
//
// `joinMs` bounded the wait on someone else's run. After that join landed, this add's
// OWN run was awaited unbounded — 8.0× its bound in the gate measurement (2,251 ms
// against 280 ms), and ~13 s on shipped numbers after a join that ended at 20 s, which
// is the ~33 s worst case against the 30 s relay window. The failing path is the one
// where every per-step bound is respected and the command still outlives the window.
// ---------------------------------------------------------------------------

test("#1351: a join that lands near its bound does not then wait out this add's own run", async () => {
  // The join SUCCEEDS — the in-flight reconnect finishes inside joinMs. The own run is
  // then what used to blow the window. Without the bound it would take landing + 2000 ms;
  // with it the add refuses at what joinMs has left and names the retry.
  const gate = deferred();
  const comfy = makeComfy();
  const built = realGraphAddNode({
    comfy,
    holdInFlight: gate.promise,
    // Older reconnect: settled, but did not register NewNode. This add's own run is
    // the one that would — and used to be waited out unbounded after the join.
    inFlightDefs: { ExistingNode: backendObjectInfo().ExistingNode },
    ownRunMs: 2000,
    budgetMs: 280,
    reserveMs: 40,
  });

  const started = Date.now();
  const pending = built.graph_add_node({ class_type: "NewNode" });
  // Land AFTER the add has reached the join, so this is the succeed-then-own-run path
  // rather than a race against a timer started at harness construction.
  await sleep(30);
  gate.resolve();
  await assert.rejects(
    () => pending,
    (err) => {
      assert.equal(err.message, addNodeRefreshBusyMessage("NewNode"));
      return true;
    },
    "an add whose own run would blow the remaining bound must refuse, in words",
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 1200,
    `the add took ${elapsed}ms — it must give up at the remaining bound, not wait the own run's 2000ms`,
  );
  assert.equal(comfy.graph._nodes.length, 0, "the graph was not touched");
  await built.inFlightStarted?.catch(() => {});
});

test("#1351: with NO refresh in flight the add still stops waiting on its own run at the bound", async () => {
  // The 8.0× measurement: no join to spend, a 280 ms bound, a multi-second own run.
  const comfy = makeComfy();
  const built = realGraphAddNode({
    comfy,
    ownRunMs: 2000,
    budgetMs: 280,
    reserveMs: 0,
  });

  const started = Date.now();
  await assert.rejects(
    () => built.graph_add_node({ class_type: "NewNode" }),
    (err) => {
      assert.equal(err.message, addNodeRefreshBusyMessage("NewNode"));
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 1200,
    `the add took ${elapsed}ms against a 280ms bound — the own run is unbounded again`,
  );
  assert.equal(comfy.graph._nodes.length, 0, "the graph was not touched");
});
