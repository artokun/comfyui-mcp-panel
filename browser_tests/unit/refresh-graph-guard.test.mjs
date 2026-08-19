// #1275 — panel_refresh_nodes deleted newly added unconnected live-canvas nodes.
//
// The reporter added seven nodes with panel_add_node, called panel_refresh_nodes
// to refresh a LoadImage dropdown, and five of the seven silently vanished —
// LoadImage #13, two CLIPTextEncode, an ImageDecode, a SaveImage — while the
// tool answered {ok:true, refreshed:true}. The pruning step runs inside
// frontend/extension code the panel calls (registerNodesFromDefs /
// refreshComboInNodes hooks), so the panel cannot prevent it by choosing
// different calls; what it can do is REFUSE to report a refresh over a graph it
// watched shrink. These tests pin:
//
//   1. the pure inventory/diff/label helpers (lib/graph-node-inventory.js);
//   2. the verdict wording (lib/node-def-refresh.js) — restored disclosure and
//      the fail-closed graph_nodes_lost verdict;
//   3. the SHIPPING registerComfyNodeDefs, extracted from the monolith and
//      driven with doubles whose register phase prunes the graph, so deleting
//      the guard wiring in the panel fails these tests;
//   4. the refresh_nodes executor forwarding restored_nodes / lost_nodes into
//      the tool reply (the #981/#1172 whitelist hole, this time for #1275).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  liveGraphNodeInventory,
  vanishedLiveNodes,
  missingInventoryIds,
  nodeInventoryLabel,
} from "../../web/js/lib/graph-node-inventory.js";
import {
  NODE_DEF_REFRESH_REASONS,
  describeNodeDefRefresh,
  describeRefreshGraphLoss,
  restoredLiveNodesNote,
} from "../../web/js/lib/node-def-refresh.js";
import { fetchNodeDefsWithRetry, OBJECT_INFO_RETRY_DELAYS_MS } from "../../web/js/lib/object-info-retry.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { REFRESH_NODES_EXECUTOR_DEPS } from "./_panel-constants.mjs";
import {
  COMBO_NO_ANSWER,
  COMBO_OK,
  NODE_DEFS_FETCH_SHARE,
  NODE_DEFS_FETCH_TIMEOUT_MS,
  NODE_DEFS_NO_ANSWER,
  NODE_DEFS_RUN_BUDGET_MS,
  monotonicNow,
  nodeDefsBudgetLeft,
} from "./_panel-constants.mjs";

import { comboRebuildCovered } from "../../web/js/lib/asset-staleness.js";

const NODE_DEFS_RETRY_DELAYS_MS = OBJECT_INFO_RETRY_DELAYS_MS;

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// Fake live graph: just enough LiteGraph for collectAllGraphs + the guard.
// ---------------------------------------------------------------------------

function fakeNode(id, type, title = null) {
  return { id, type, title: title ?? type };
}

function fakeGraph(nodeList) {
  return {
    _nodes: [...nodeList],
    serialize() {
      return { nodes: this._nodes.map((n) => ({ id: n.id, type: n.type, title: n.title })) };
    },
  };
}

// The issue's reproduction shape: seven newly added nodes, mixed
// connected/unconnected (link realism is irrelevant to the guard — it watches
// node PRESENCE), ids 13-19 as reported.
const SEVEN = [
  fakeNode(13, "LoadImage"),
  fakeNode(14, "CLIPTextEncode"),
  fakeNode(15, "CLIPTextEncode"),
  fakeNode(16, "LanPaint_ImageEncode"),
  fakeNode(17, "LanPaint_KSampler"),
  fakeNode(18, "LanPaint_ImageDecode"),
  fakeNode(19, "SaveImage"),
];
// The five the reporter lost.
const PRUNED_IDS = new Set([13, 14, 15, 18, 19]);

// ---------------------------------------------------------------------------
// 1. The pure helpers
// ---------------------------------------------------------------------------

test("#1275: the inventory walks subgraphs and keeps graph identity", () => {
  const inner = fakeGraph([fakeNode(1, "LoadImage")]);
  const root = fakeGraph([fakeNode(2, "CheckpointLoaderSimple"), { ...fakeNode(3, "SubgraphNode"), subgraph: inner }]);
  const inv = liveGraphNodeInventory(root);
  assert.equal(inv.length, 3);
  assert.deepEqual(
    inv.map((e) => e.id).sort(),
    [1, 2, 3],
  );
  const innerEntry = inv.find((e) => e.id === 1);
  assert.equal(innerEntry.graph, inner, "the entry remembers WHICH graph held the node");
});

test("#1275: vanishedLiveNodes names exactly the pruned nodes, connected or not", () => {
  const graph = fakeGraph(SEVEN);
  const before = liveGraphNodeInventory(graph);
  graph._nodes = graph._nodes.filter((n) => !PRUNED_IDS.has(n.id));
  const vanished = vanishedLiveNodes(before, graph);
  assert.deepEqual(vanished.map((e) => e.id).sort((a, b) => a - b), [13, 14, 15, 18, 19]);
  assert.equal(vanishedLiveNodes(before, graph).some((e) => e.id === 16), false, "the survivors stay survivors");
});

test("#1275: a wholesale graph replacement reads as total loss, not as a clean bill", () => {
  const before = liveGraphNodeInventory(fakeGraph(SEVEN));
  const replacement = fakeGraph(SEVEN.slice(0, 2));
  const vanished = vanishedLiveNodes(before, replacement);
  assert.equal(vanished.length, 7, "a new graph OBJECT means every old reference is gone");
  // ...and the id-based post-restore check is what sees through it:
  assert.deepEqual(missingInventoryIds(before, replacement).map((e) => e.id).sort((a, b) => a - b), [15, 16, 17, 18, 19]);
});

test("#1275: no loss, no missing root, no false report", () => {
  const graph = fakeGraph(SEVEN);
  const before = liveGraphNodeInventory(graph);
  assert.deepEqual(vanishedLiveNodes(before, graph), []);
  assert.deepEqual(vanishedLiveNodes(before, null), [], "an unreadable root claims nothing");
  assert.deepEqual(missingInventoryIds(before, graph), []);
  assert.deepEqual(vanishedLiveNodes([], graph), []);
});

test("#1275: labels read like the issue's report", () => {
  assert.equal(nodeInventoryLabel({ id: 13, type: "LoadImage", title: "LoadImage" }), "LoadImage #13");
  assert.equal(nodeInventoryLabel({ id: 4, type: "LoadImage", title: "portrait source" }), '"portrait source" (LoadImage #4)');
  assert.equal(nodeInventoryLabel({ id: 9, type: null, title: null }), "#9");
});

// ---------------------------------------------------------------------------
// 2. The verdict wording
// ---------------------------------------------------------------------------

test("#1275: the fail-closed verdict is not refreshed, names the lost nodes, and says what was tried", () => {
  const lost = SEVEN.filter((n) => PRUNED_IDS.has(n.id)).map((n) => ({ graph: null, id: n.id, type: n.type, title: n.title }));
  const v = describeRefreshGraphLoss(lost, { restoreAvailable: false });
  assert.equal(v.refreshed, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.GRAPH_NODES_LOST);
  assert.equal(v.lost_nodes.length, 5);
  assert.match(v.lost_nodes[0], /LoadImage #13/);
  assert.match(v.remedy, /REMOVED 5 nodes/);
  assert.match(v.remedy, /LoadImage #13/);
  assert.match(v.remedy, /no loadGraphData/, "the remedy says why no restore ran");
  assert.match(v.remedy, /re-add them, or reload your last saved workflow/);
  assert.match(v.remedy, /Do NOT call panel_refresh_nodes again/);
  assert.equal(v.detail, undefined, "no restore ran, so no restore detail");
});

test("#1275: a failed restore is disclosed with its error, not folded into 'still missing'", () => {
  const lost = [{ graph: null, id: 13, type: "LoadImage", title: "LoadImage" }];
  const v = describeRefreshGraphLoss(lost, { restoreAvailable: true, restoreThrew: new Error("boom") });
  assert.match(v.remedy, /the restore itself failed/);
  assert.match(v.detail, /boom/);
  const incomplete = describeRefreshGraphLoss(lost, { restoreAvailable: true });
  assert.match(incomplete.remedy, /still missing/);
});

test("#1275: the restore disclosure keeps refreshed honest about what was re-verified", () => {
  const entries = SEVEN.filter((n) => PRUNED_IDS.has(n.id)).map((n) => ({ graph: null, id: n.id, type: n.type, title: n.title }));
  const note = restoredLiveNodesNote(entries);
  assert.match(note, /REMOVED 5 nodes/);
  assert.match(note, /LoadImage #13/);
  assert.match(note, /re-verified every one is present/);
  assert.match(note, /only their presence was re-verified/, "presence is the claim, not full fidelity");
  assert.equal(restoredLiveNodesNote([]), "");
});

// ---------------------------------------------------------------------------
// 3. The SHIPPING registerComfyNodeDefs, extracted and driven with doubles.
//    Same extraction pattern as node-def-refresh.test.mjs, extended with the
//    #1275 guard collaborators (that harness predates the guard and stays
//    untouched; this one is where the guard is exercised).
// ---------------------------------------------------------------------------

/** Balanced-brace extraction of a top-level function by its declaration marker. */
function extractFunction(marker) {
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1, `${marker} not found`);
  const open = SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    const ch = SRC[i];
    if (ch === "/" && SRC[i + 1] === "/") {
      i = SRC.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && SRC[i + 1] === "*") {
      i = SRC.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < SRC.length; i += 1) {
        if (SRC[i] === "\\") {
          i += 1;
          continue;
        }
        if (SRC[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unterminated function: ${marker}`);
}

function buildRegisterComfyNodeDefs({ appValue, apiValue }) {
  const body = extractFunction("async function registerComfyNodeDefs(");
  const factory = new Function(
    "app",
    "api",
    "recordObjectInfoTypes",
    "reapplyDefsToLiveNodes",
    "comboRebuildCovered",
    "describeNodeDefRefresh",
    "fetchNodeDefsWithRetry",
    "withTimeout",
    "NODE_DEFS_NO_ANSWER",
    "COMBO_OK",
    "COMBO_NO_ANSWER",
    "NODE_DEFS_FETCH_TIMEOUT_MS",
    "NODE_DEFS_RUN_BUDGET_MS",
    "NODE_DEFS_FETCH_SHARE",
    "nodeDefsBudgetLeft",
    "monotonicNow",
    "NODE_DEFS_RETRY_DELAYS_MS",
    "objectInfoCache",
    "objectInfoSnapshot",
    "backendReconnectEpoch",
    // #1275 — the guard's collaborators, REAL lib functions, so this harness proves
    // the shipped wiring and not a re-implementation of it.
    "liveGraphNodeInventory",
    "vanishedLiveNodes",
    "missingInventoryIds",
    "nodeInventoryLabel",
    "describeRefreshGraphLoss",
    "restoredLiveNodesNote",
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
     let nodeDefsRefreshConfirmed = false;
     ${body}
     return { registerComfyNodeDefs };`,
  );
  return factory(
    appValue,
    apiValue,
    () => ({}),
    () => {},
    // #1193 — the REAL predicate, not a stub: it is the guard that decides whether the
    // panel may claim the live combo lists were rebuilt, and a stub would let this harness
    // agree with itself about it.
    comboRebuildCovered,
    describeNodeDefRefresh,
    (getDefs, opts) => fetchNodeDefsWithRetry(getDefs, { ...opts, sleep: async () => {} }),
    withTimeout,
    NODE_DEFS_NO_ANSWER,
    COMBO_OK,
    COMBO_NO_ANSWER,
    NODE_DEFS_FETCH_TIMEOUT_MS,
    NODE_DEFS_RUN_BUDGET_MS,
    NODE_DEFS_FETCH_SHARE,
      nodeDefsBudgetLeft,
    monotonicNow,
    NODE_DEFS_RETRY_DELAYS_MS,
    { invalidate: () => {}, read: async (f) => f() },
    { clear: () => {}, record: () => true },
    7,
    liveGraphNodeInventory,
    vanishedLiveNodes,
    missingInventoryIds,
    nodeInventoryLabel,
    describeRefreshGraphLoss,
    restoredLiveNodesNote,
  );
}

const DEFS = { LoadImage: { input: { required: {} } } };
const apiStub = { getNodeDefs: async () => DEFS };

/** An app double whose register phase prunes the five nodes the reporter lost. */
function pruningApp({ withLoader = true, restoreOmit = new Set() } = {}) {
  const graph = fakeGraph(SEVEN);
  const calls = { loadGraphData: [] };
  const app = {
    graph,
    registerNodesFromDefs: async () => {
      graph._nodes = graph._nodes.filter((n) => !PRUNED_IDS.has(n.id));
    },
    refreshComboInNodes: async () => {},
  };
  if (withLoader) {
    app.loadGraphData = async (snapshot) => {
      calls.loadGraphData.push(snapshot);
      graph._nodes = snapshot.nodes
        .filter((d) => !restoreOmit.has(d.id))
        .map((d) => fakeNode(d.id, d.type, d.title));
    };
  }
  return { app, graph, calls };
}

test("#1275: a refresh that prunes newly added unconnected nodes restores them and SAYS so", async () => {
  const { app, calls } = pruningApp();
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({ appValue: app, apiValue: apiStub });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, true, "the refresh itself worked and the canvas is back");
  assert.equal(calls.loadGraphData.length, 1, "the pre-refresh snapshot was replayed exactly once");
  assert.equal(
    calls.loadGraphData[0].nodes.length,
    7,
    "the snapshot was taken BEFORE the register phase ran — all seven nodes ride along",
  );
  assert.equal(app.graph._nodes.length, 7, "every pruned node is back on the live graph");
  assert.deepEqual(verdict.restored_nodes.sort(), [
    "CLIPTextEncode #14",
    "CLIPTextEncode #15",
    "LanPaint_ImageDecode #18",
    "LoadImage #13",
    "SaveImage #19",
  ]);
  assert.match(verdict.restored_nodes_note, /REMOVED 5 nodes/);
  assert.equal(verdict.lost_nodes, undefined, "a restored loss is not reported as a loss");
});

test("#1275: no loadGraphData on this frontend → fail CLOSED, the lost nodes named", async () => {
  const { app, graph } = pruningApp({ withLoader: false });
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({ appValue: app, apiValue: apiStub });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, false, "refreshed over a shrunk canvas is the bug being fixed");
  assert.equal(verdict.reason, "graph_nodes_lost");
  assert.equal(verdict.lost_nodes.length, 5);
  assert.match(verdict.remedy, /LoadImage #13/);
  assert.match(verdict.remedy, /no loadGraphData/);
  assert.equal(graph._nodes.length, 2, "nothing was invented back onto the canvas");
});

test("#1275: a restore that leaves nodes missing fails closed with what is still gone", async () => {
  const { app, calls } = pruningApp({ restoreOmit: new Set([13, 19]) });
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({ appValue: app, apiValue: apiStub });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, false);
  assert.equal(verdict.reason, "graph_nodes_lost");
  assert.deepEqual(verdict.lost_nodes, ["LoadImage #13", "SaveImage #19"], "only the unrecovered nodes are named lost");
  assert.match(verdict.remedy, /still missing/);
  assert.equal(calls.loadGraphData.length, 1);
});

test("#1275: an additive refresh reports nothing about the guard", async () => {
  const graph = fakeGraph(SEVEN);
  const app = {
    graph,
    registerNodesFromDefs: async () => {},
    refreshComboInNodes: async () => {},
    loadGraphData: async () => {
      throw new Error("must not be called — nothing vanished");
    },
  };
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({ appValue: app, apiValue: apiStub });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.deepEqual(verdict, { refreshed: true, reason: "refreshed" });
});

test("#1275: the graph loss overrides a phase failure already on the verdict", async () => {
  const { app } = pruningApp({ withLoader: false });
  app.refreshComboInNodes = async () => {
    throw new Error("combo exploded");
  };
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({ appValue: app, apiValue: apiStub });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, false);
  assert.equal(
    verdict.reason,
    "graph_nodes_lost",
    "the lost nodes are the fact the caller must act on first, ahead of a combo failure",
  );
  assert.equal(verdict.lost_nodes.length, 5);
});

// ---------------------------------------------------------------------------
// 4. The shipping refresh_nodes executor forwards the guard's fields.
// ---------------------------------------------------------------------------

function buildRefreshNodes(refreshImpl) {
  const start = SRC.indexOf("async refresh_nodes()");
  assert.notEqual(start, -1, "refresh_nodes executor not found in the panel source");
  const open = SRC.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < SRC.length; i += 1) {
    const ch = SRC[i];
    if (ch === "/" && SRC[i + 1] === "/") {
      i = SRC.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && SRC[i + 1] === "*") {
      i = SRC.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < SRC.length; i += 1) {
        if (SRC[i] === "\\") {
          i += 1;
          continue;
        }
        if (SRC[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  assert.notEqual(end, -1, "could not bound the refresh_nodes executor body");
  const body = SRC.slice(start, end + 1);
  // #1404 — every OTHER module binding the executor closes over, from the one place that
  // holds them (REFRESH_NODES_EXECUTOR_DEPS), so a new one is added once for all three
  // harnesses rather than three times.
  const extra = Object.entries(REFRESH_NODES_EXECUTOR_DEPS);
  const factory = new Function(
    "refreshComfyNodeDefs",
    ...extra.map(([name]) => name),
    `return (${body.replace(/^async refresh_nodes\(\)/, "async function refresh_nodes()")});`,
  );
  return factory(refreshImpl, ...extra.map(([, value]) => value));
}

test("#1275: restored_nodes survive the executor's success-branch whitelist", async () => {
  const refresh_nodes = buildRefreshNodes(async () => ({
    refreshed: true,
    reason: "refreshed",
    restored_nodes: ["LoadImage #13"],
    restored_nodes_note: "The refresh REMOVED 1 node ...",
  }));
  const reply = await refresh_nodes();
  assert.equal(reply.ok, true);
  assert.equal(reply.refreshed, true);
  assert.deepEqual(reply.restored_nodes, ["LoadImage #13"]);
  assert.match(reply.restored_nodes_note, /REMOVED 1 node/);
});

test("#1275: a fail-closed graph-loss verdict reaches the reply with lost_nodes intact", async () => {
  const refresh_nodes = buildRefreshNodes(async () => ({
    refreshed: false,
    reason: "graph_nodes_lost",
    lost_nodes: ["LoadImage #13", "SaveImage #19"],
    remedy: "The refresh REMOVED 2 nodes ...",
  }));
  const reply = await refresh_nodes();
  assert.equal(reply.refreshed, false);
  assert.equal(reply.reason, "graph_nodes_lost");
  assert.deepEqual(reply.lost_nodes, ["LoadImage #13", "SaveImage #19"]);
  assert.match(reply.remedy, /REMOVED 2 nodes/);
});

test("#1275: a clean verdict still reads clean — no guard fields invented", async () => {
  const refresh_nodes = buildRefreshNodes(async () => ({ refreshed: true, reason: "refreshed" }));
  const reply = await refresh_nodes();
  assert.deepEqual(reply, { ok: true, refreshed: true });
});
