/**
 * #1855 — `panel_add_node` accepted `title: "Preview Mask Animation"` for a
 * `PreviewAnimation` node and reported it back, but a `panel_query_graph` read
 * showed `Preview Animation`. The add "reported state that was not persisted".
 *
 * MECHANISM, read from source rather than inferred:
 *
 *   - `graph_add_node`'s payload is `summarizeNode(node)`, which reads
 *     `title: node.title` LIVE, after `graph.add(node)`. It is not a pre-add echo.
 *   - `LGraph.add` (comfyui_frontend_package 1.49.x, the reporter's version) sets
 *     `node.graph`, pushes the node, calls `onAdded` / `onNodeAdded`. It never
 *     assigns `title`.
 *   - ComfyUI-KJNodes registers `PreviewAnimation` with two title writers of its
 *     own (web/js/jsnodes.js):
 *         onConnectInput → this.title = "Preview Animation"
 *         onExecuted     → this.title = "Preview Animation " + values
 *   - The frontend invokes `onConnectInput` from `connectSlots` and
 *     `SubgraphInput.connect` only — i.e. from WIRING.
 *
 * So the title is discarded when the node is CONNECTED, not when it is created,
 * and `panel_connect` returned a plain success while the name the caller had
 * just been told was this node's went stale with nothing in the reply to say so.
 *
 * These tests run the REAL shipped executors, extracted from
 * web/js/comfyui-mcp-panel.js — the same technique as connect-throw-verdict and
 * add-node-loaded-subgraph. A helper-only test would stay green against an
 * unwired call site, which is the failure mode those files exist to avoid.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  isLinkPersisted,
  removePhantomLink,
  isWidgetBackedInput,
  inputLinkIds,
  railSlotLinkIds,
  linkIdExclusionSet,
  findLandedInboundLink,
  findLandedRailLink,
  isRailLinkPersisted,
  landedAfterThrowWarning,
  verifyConnect,
  snapshotInputSlotLinks,
  connectCollateralBullets,
  connectCollateralWarning,
} from "../../web/js/lib/connect-verify.js";
import { snapshotGraphState } from "../../web/js/lib/disconnect-verify.js";
import { findExistingRailSlot, refuseConnectToRawRail } from "../../web/js/lib/rail-slot.js";
import {
  captureNodeTitles,
  describeTitleRewrites,
  titleRewriteWarning,
} from "../../web/js/lib/node-title-rewrite.js";
import {
  captureSlotNames,
  describeSlotRewrites,
  slotRewriteWarning,
} from "../../web/js/lib/slot-rename-disclosure.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
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
import {
  describeUnmaterializedRequiredWidgets,
  snapshotBackendDef,
} from "../../web/js/lib/add-node-widget-guard.js";
import {
  NODE_DEFS_FETCH_TIMEOUT_MS,
  NODE_DEFS_NO_ANSWER,
  WIDEN_SOCKET_PROOF_TIMEOUT_MS,
  addNodeCommandBudgetDeps,
  monotonicNow,
} from "./_panel-constants.mjs";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

/** The method source between its signature line and the first `  },` line. */
function sliceMethod(signature) {
  const lines = panelSrc.split("\n");
  const start = lines.findIndex((l) => l === signature);
  assert.ok(start >= 0, `could not locate "${signature}" in the panel source`);
  const end = lines.findIndex((l, i) => i > start && l === "  },");
  assert.ok(end > start, `could not locate the end of "${signature}"`);
  return lines.slice(start, end + 1).join("\n");
}

const connectSrc = sliceMethod(
  "  graph_connect({ from_node_id, from_output, to_node_id, to_input, auto_match }) {",
);

// ---------------------------------------------------------------------------
// graph_connect harness — doubles for everything AROUND the code under test,
// the REAL verification helpers injected.
// ---------------------------------------------------------------------------

function resolveNode(graph, id) {
  const n = graph.getNodeById(id);
  if (!n) throw new Error(`No node with id ${id}`);
  return n;
}

function resolveSlot(slots, ref, kind) {
  const list = slots ?? [];
  if (typeof ref === "number") {
    if (ref < 0 || ref >= list.length) throw new Error(`no ${kind} slot ${ref}`);
    return ref;
  }
  const i = list.findIndex((s) => s?.name === ref);
  if (i === -1) throw new Error(`no ${kind} named ${ref}`);
  return i;
}

const railIntent = () => null;
const resolveRail = () => null;
const isEmptyRailSlotRef = (ref) => ref == null || ref === "";
const slotDiagnostic = () => "slot diagnostic";
const loopbackRefusalReason = () => "loopback";
const findSubgraphHostNode = () => null;
const uniqueSubgraphOutputName = (_g, base) => base;
const uniqueSubgraphInputName = (_g, base) => base;

function autoMatchSlots(origin, target, from_output, to_input) {
  return {
    outIdx: resolveSlot(origin.outputs, from_output ?? 0, "output"),
    inIdx: resolveSlot(target.inputs, to_input ?? 0, "input"),
    autoMatched: [],
  };
}

/**
 * Build `graph_connect` from the shipped source.
 *
 * `titleDeps` is how the mutation check is done: pass stand-ins that neuter the
 * fix (a capture that records nothing) and the disclosure must vanish. That
 * proves these tests are pinned to THIS mechanism and not to something the
 * fixture would produce anyway.
 */
function buildConnect(graph, titleDeps = {}) {
  const deps = {
    getGraphCtx: () => ({ graph, canvas: {}, app: {}, rootGraph: graph, LG: {} }),
    resolveNode,
    resolveSlot,
    resolveRail,
    railIntent,
    isEmptyRailSlotRef,
    findExistingRailSlot,
    refuseConnectToRawRail,
    findSubgraphHostNode,
    autoMatchSlots,
    slotDiagnostic,
    loopbackRefusalReason,
    uniqueSubgraphOutputName,
    uniqueSubgraphInputName,
    isLinkPersisted,
    removePhantomLink,
    isWidgetBackedInput,
    inputLinkIds,
    railSlotLinkIds,
    linkIdExclusionSet,
    findLandedInboundLink,
    findLandedRailLink,
    isRailLinkPersisted,
    landedAfterThrowWarning,
    snapshotGraphState,
    snapshotInputSlotLinks,
    verifyConnect,
    connectCollateralBullets,
    connectCollateralWarning,
    captureNodeTitles,
    describeTitleRewrites,
    titleRewriteWarning,
    captureSlotNames,
    describeSlotRewrites,
    slotRewriteWarning,
    ...titleDeps,
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const GRAPH_TOOL_EXECUTORS = {
${connectSrc}
};
return GRAPH_TOOL_EXECUTORS.graph_connect;`,
  );
  return factory(...names.map((n) => deps[n]));
}

/** The REAL link store shape: `_links` is a number-keyed Map (see #1425). */
function mkLinkStore() {
  const isIndex = (prop) => typeof prop === "string" && /^(?:0|[1-9]\d*)$/.test(prop);
  const map = new Map();
  const proxy = new Proxy(map, {
    get(target, prop) {
      if (isIndex(prop)) return target.get(Number(prop));
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
    has: (target, prop) => (isIndex(prop) ? target.has(Number(prop)) : Reflect.has(target, prop)),
    ownKeys: (target) => [...target.keys()].map(String),
    getOwnPropertyDescriptor(target, prop) {
      if (isIndex(prop) && target.has(Number(prop))) {
        return { value: target.get(Number(prop)), enumerable: true, configurable: true, writable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  return { map, proxy };
}

function mkGraph() {
  const store = mkLinkStore();
  const graph = {
    lastLinkId: 0,
    _links: store.map,
    links: store.proxy,
    nodes: [],
    outputs: [],
    inputs: [],
    getNodeById: (id) => graph.nodes.find((n) => String(n.id) === String(id)) ?? null,
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
    getLink: (id) => store.map.get(id) ?? null,
  };
  return graph;
}

function mkNode(graph, id, title, inputs, outputs) {
  const node = { id, title, inputs, outputs, graph };
  graph.nodes.push(node);
  return node;
}

/**
 * The origin node's connect(), mirroring the frontend's `connectSlots` ORDER:
 *
 *     t.onConnectInput?.(s, e.type, e, this, o) === false  → refuse
 *     …write graph._links / output.links / input.link…
 *     …then the onConnectionsChange hooks (`afterWrite` here)…
 *
 * KJNodes' PreviewAnimation writes its title from `onConnectInput`, i.e. in the
 * FIRST of those three positions — before the link even exists.
 */
function attachConnect(node, { onConnectInput, afterWrite } = {}) {
  node.connect = (outIdx, target, inIdx) => {
    const graph = node.graph;
    if (onConnectInput?.(target, inIdx) === false) return null;
    const id = ++graph.lastLinkId;
    const link = { id, origin_id: node.id, origin_slot: outIdx, target_id: target.id, target_slot: inIdx };
    graph._links.set(id, link);
    (node.outputs[outIdx].links ??= []).push(id);
    target.inputs[inIdx].link = id;
    afterWrite?.({ link, target, inIdx, graph });
    return link;
  };
}

/** The reporter's graph: an IMAGE source wired into a self-renaming PreviewAnimation. */
function previewAnimationFixture({ clobber = true, throwAfterWrite = false } = {}) {
  const graph = mkGraph();
  const source = mkNode(graph, 1, "Load Image", [], [{ name: "IMAGE", type: "IMAGE", links: [] }]);
  const preview = mkNode(
    graph,
    2,
    "Preview Mask Animation",
    [{ name: "image", type: "IMAGE", link: null }],
    [],
  );
  attachConnect(source, {
    onConnectInput: (target) => {
      // web/js/jsnodes.js, case "PreviewAnimation" — unconditional, no guard on
      // whether the user had named the node.
      if (clobber) target.title = "Preview Animation";
    },
    afterWrite: () => {
      if (throwAfterWrite) throw new Error("Cannot read properties of undefined (reading 'slots')");
    },
  });
  return { graph, source, preview };
}

// ---------------------------------------------------------------------------
// graph_connect: the reported path
// ---------------------------------------------------------------------------

test("#1855 shipped graph_connect: a target that renames itself on connect is DISCLOSED", () => {
  const { graph, preview } = previewAnimationFixture();
  const graph_connect = buildConnect(graph);

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: 0 });

  // The wire is real — the rename must never be reported as a connect failure.
  assert.equal(res.connected.to.node_id, 2);
  assert.equal(preview.title, "Preview Animation", "the pack really did rewrite it");

  assert.deepEqual(res.title_rewritten, [
    { node_id: 2, from: "Preview Mask Animation", to: "Preview Animation" },
  ]);
  assert.match(res.warning, /RENAMED/);
  assert.match(res.warning, /"Preview Mask Animation" → "Preview Animation"/);
  assert.match(res.warning, /panel_edit_node/);
});

test("#1855 the disclosure is produced by the FIX, not by the fixture", () => {
  const { graph } = previewAnimationFixture();
  // Neuter only the capture — everything else, including the fixture's rename,
  // is unchanged. If the assertions above could pass without the call site
  // reading the snapshot, they would pass here too.
  const graph_connect = buildConnect(graph, { captureNodeTitles: () => [] });

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: 0 });

  assert.equal(res.connected.to.node_id, 2, "the connect itself is unaffected");
  assert.equal(res.title_rewritten, undefined);
  assert.equal(res.warning, undefined);
});

test("#1855 an ordinary connect is byte-identical to before — no rider, no warning key", () => {
  const { graph, preview } = previewAnimationFixture({ clobber: false });
  const graph_connect = buildConnect(graph);

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: 0 });

  assert.equal(preview.title, "Preview Mask Animation", "nothing renamed it");
  assert.deepEqual(Object.keys(res), ["connected"]);
});

test("#1855 the ORIGIN end is snapshotted too, not just the target", () => {
  const graph = mkGraph();
  const source = mkNode(graph, 1, "My Loader", [], [{ name: "IMAGE", type: "IMAGE", links: [] }]);
  mkNode(graph, 2, "Preview Image", [{ name: "images", type: "IMAGE", link: null }], []);
  attachConnect(source, {
    // The output twin of the same hazard: LiteGraph calls the ORIGIN's
    // onConnectOutput in the same expression it calls the target's
    // onConnectInput, so a pack can rename either end.
    afterWrite: () => {
      source.title = "Load Image";
    },
  });
  const graph_connect = buildConnect(graph);

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: 0 });

  assert.deepEqual(res.title_rewritten, [{ node_id: 1, from: "My Loader", to: "Load Image" }]);
});

test("#1855 a hook that renames AND throws after wiring keeps BOTH warnings", () => {
  const { graph } = previewAnimationFixture({ throwAfterWrite: true });
  const graph_connect = buildConnect(graph);

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: 0 });

  assert.equal(res.connected.to.node_id, 2, "#1272: a throw after the write is still a landed wire");
  assert.deepEqual(res.title_rewritten, [
    { node_id: 2, from: "Preview Mask Animation", to: "Preview Animation" },
  ]);
  // The #1272 warning is the louder of the two and must not be displaced by the
  // rename rider — an append bug here would silently un-ship that fix.
  assert.match(res.warning, /slots/, "the #1272 landed-after-throw warning survives");
  assert.match(res.warning, /RENAMED/, "and the #1855 rename is appended to it");
});

// ---------------------------------------------------------------------------
// node-title-rewrite.js — the two properties the call site relies on
// ---------------------------------------------------------------------------

test("#1855 captureNodeTitles dedupes by node IDENTITY (a self-connect is one node)", () => {
  const node = { id: 7, title: "Both Ends" };
  const snapshot = captureNodeTitles([node, node, null, "not a node"]);
  assert.equal(snapshot.length, 1);
  node.title = "Renamed";
  assert.deepEqual(describeTitleRewrites(snapshot), [
    { node_id: 7, from: "Both Ends", to: "Renamed" },
  ]);
});

test("#1855 a node that carries no title at all is not reported as a rewrite", () => {
  const node = { id: 3 };
  const snapshot = captureNodeTitles([node]);
  assert.deepEqual(describeTitleRewrites(snapshot), []);
  assert.equal(titleRewriteWarning([]), "");
});

// ---------------------------------------------------------------------------
// graph_add_node: the command's claim, checked against the node it just made
// ---------------------------------------------------------------------------

const addNodeMatch = panelSrc.match(
  /\n {2}async graph_add_node\(\{ class_type, pos, title \}\) \{[\s\S]*?\n {2}\},/,
);
assert.ok(addNodeMatch, "could not locate graph_add_node in panel source");
const awaitWidgetsMatch = panelSrc.match(
  /\nasync function awaitRequiredCustomWidgetRegistration\([\s\S]*?\n\}/,
);
const placementMatch = panelSrc.match(/\nfunction placementFor\(graph, pos\) \{[\s\S]*?\n\}/);
const boundedMatch = panelSrc.match(/\nasync function boundedGetNodeDefs\([\s\S]*?\n\}/);
assert.ok(awaitWidgetsMatch && placementMatch && boundedMatch, "add-node helpers not located");

const OBJECT_INFO = {
  PreviewAnimation: { name: "PreviewAnimation", input: { required: {} }, output: [] },
};

/**
 * `renameOnCreate` stands in for a class that writes its own title during
 * creation (`onNodeCreated` / a `nodeCreated` extension hook). KJNodes'
 * PreviewAnimation does NOT do this — which is exactly why the add-time check is
 * a contract check on the command's own claim and not the #1855 repro.
 */
function buildAddNode({ renameOnCreate = null } = {}) {
  let nextId = 1;
  const ctor = function ComfyNode() {};
  ctor.nodeData = OBJECT_INFO.PreviewAnimation;
  ctor.comfyClass = "PreviewAnimation";
  const registry = { PreviewAnimation: ctor };
  const LG = {
    registered_node_types: registry,
    createNode(type) {
      if (!registry[type]) return null;
      const node = {
        id: nextId++,
        type,
        title: "Preview Animation",
        constructor: registry[type],
        pos: [0, 0],
        size: [210, 100],
        widgets: [],
        inputs: [],
        outputs: [],
      };
      return node;
    },
  };
  const graph = {
    _nodes: [],
    subgraphs: new Map(),
    add(node) {
      graph._nodes.push(node);
      if (renameOnCreate) node.title = renameOnCreate;
    },
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
  };
  const context = { app: { widgets: {} }, LG, graph, rootGraph: graph, workflow: { uuid: "wf" } };
  const api = {
    async getNodeDefs() {
      return OBJECT_INFO;
    },
    async fetchApi(route) {
      const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
      const body = Object.prototype.hasOwnProperty.call(OBJECT_INFO, cls) ? { [cls]: OBJECT_INFO[cls] } : {};
      return { status: 200, json: async () => body };
    },
  };

  const deps = {
    captureGraphMutationContext: () => context,
    revalidateGraphMutationContext: () => context,
    getGraphCtx: () => context,
    awaitObjectInfoHistorySeed: async () => {},
    recordObjectInfoTypes: (defs) => defs,
    objectInfoHistory: { wasTypeEverDefined: () => true },
    objectInfoSnapshot: { record: () => true, clear: () => {} },
    objectInfoCache: { invalidate() {}, replace: () => true },
    verifiedNodeDefCache: {
      generation: () => 0,
      invalidate() {},
      clear() {},
      get: () => null,
      set() {},
    },
    backendReconnectEpoch: 0,
    readPackImportFailures: async () => [],
    managerGet: async () => null,
    api,
    refreshComfyNodeDefs: async () => ({ refreshed: true }),
    // Mirrors the real summarizeNode's `title: node.title` — a live read, which
    // is the whole reason the add's claim is checkable at all.
    summarizeNode: (node) => ({ id: node.id, type: node.type, title: node.title }),
    reconcileFreshDynamicWidgets: () => ({ failures: [] }),
    sanitizeNodeAuxId: () => false,
    clearInheritedExecutionPreview: () => {},
    safeRemoveNode: () => {},
    addNodeRefreshBusyMessage: (t) => `busy: ${t}`,
    REFRESH_JOIN_ABANDONED: Symbol("abandoned"),
    schemaAutoRefreshed: false,
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
    monotonicNow,
    NODE_DEFS_FETCH_TIMEOUT_MS,
    withTimeout,
    ...addNodeCommandBudgetDeps(),
  };
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

  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `${awaitWidgetsMatch[0]}
     ${placementMatch[0]}
     const CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS = 200;
     const CUSTOM_WIDGET_REGISTRATION_POLL_MS = 5;
     const executors = {${addNodeMatch[0]}};
     return executors.graph_add_node;`,
  );
  return factory(...names.map((n) => deps[n]));
}

test("#1855 shipped graph_add_node: a title that DOES stick is reported with no rider", async () => {
  const graph_add_node = buildAddNode();
  const res = await graph_add_node({ class_type: "PreviewAnimation", title: "Preview Mask Animation" });

  assert.equal(res.added.title, "Preview Mask Animation");
  assert.equal(res.added.title_not_applied, undefined, "PreviewAnimation does not rename on ADD");
  assert.equal(res.added.warning, undefined);
});

test("#1855 shipped graph_add_node: a class that renames itself on create cannot be reported as success", async () => {
  const graph_add_node = buildAddNode({ renameOnCreate: "Preview Animation" });
  const res = await graph_add_node({ class_type: "PreviewAnimation", title: "Preview Mask Animation" });

  // The payload keeps reporting the node's ACTUAL title — never the request.
  assert.equal(res.added.title, "Preview Animation");
  assert.deepEqual(res.added.title_not_applied, {
    requested: "Preview Mask Animation",
    actual: "Preview Animation",
  });
  assert.match(res.added.warning, /is NOT what this node ended up with/);
  assert.match(res.added.warning, /"Preview Mask Animation"/);
});
