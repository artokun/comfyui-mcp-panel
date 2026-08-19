/**
 * #1443 — graph mutations must notify the ACTIVE canvas, not only the graph
 * object `panel_graph_outline` reads.
 *
 * The reported failure: panel_edit_node / panel_edit_group / panel_remove_group
 * returned success, outline showed the new 10-node group-free graph, and the
 * user's visible canvas did not change. `graph.setDirtyCanvas` walks
 * `list_of_graphcanvas`; after a Vue remount that list can omit the canvas the
 * user is looking at. Vue nodes also paint from a layout store keyed on
 * graph._version, which a raw setDirtyCanvas never bumps.
 *
 * These tests drive the SHIPPED helper (web/js/lib/visible-canvas-ack.js) and
 * the panel dispatch wiring that calls it after a mutating graph command, plus
 * the real graph_edit_node / graph_remove_group executors so a helper-only
 * green cannot hide a dispatch that never invokes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { writePoint } from "../../web/js/lib/group-geometry.js";
import {
  VISIBLE_CANVAS_ACK_NOTE,
  ackVisibleCanvasMutation,
  findLayoutStore,
  readCanvasRevision,
  recommitNodeLayouts,
  syncLayoutStoreFromGraph,
  visibleCanvasWasNotified,
  withVisibleCanvasAck,
} from "../../web/js/lib/visible-canvas-ack.js";
import { canonicalNodeId, isQualifiedNodeId } from "../../web/js/lib/node-id.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const PANEL_SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

function panelFunctionStart(src, name, from = 0) {
  const bare = src.indexOf(`function ${name}(`, from);
  assert.notEqual(bare, -1, `could not locate ${name} in panel source`);
  const asyncAt = bare - "async ".length;
  return asyncAt >= 0 && src.startsWith("async ", asyncAt) ? asyncAt : bare;
}

test("#1443 graph.setDirtyCanvas alone is NOT a visible-canvas ack when the active canvas was not dirtied", () => {
  const canvas = { dirty_canvas: false, dirty_bgcanvas: false };
  const graph = {
    _version: 3,
    setDirtyCanvas() {
      /* list_of_graphcanvas empty — the reported no-op */
    },
  };
  const before = readCanvasRevision({ graph, canvas });
  graph.setDirtyCanvas(true, true);
  const after = readCanvasRevision({ graph, canvas });
  assert.equal(
    visibleCanvasWasNotified({ canvas, before, after, dirtyInvoked: false }),
    false,
    "a graph-list dirty that never reaches the active canvas is not an ack",
  );
});

test("#1443 ackVisibleCanvasMutation dirties the ACTIVE canvas even when graph.setDirtyCanvas is a no-op", () => {
  const canvas = {
    dirty_canvas: false,
    dirty_bgcanvas: false,
    setDirty(fg, bg) {
      if (fg) this.dirty_canvas = true;
      if (bg) this.dirty_bgcanvas = true;
    },
  };
  const graph = {
    _version: 7,
    incrementVersion() {
      this._version += 1;
    },
    setDirtyCanvas() {
      /* no-op: the canvas is not in list_of_graphcanvas */
    },
  };
  const beforeVersion = graph._version;
  const ack = ackVisibleCanvasMutation({ graph, canvas });
  assert.equal(ack.notified, true);
  assert.equal(canvas.dirty_canvas, true);
  assert.equal(canvas.dirty_bgcanvas, true);
  assert.notEqual(graph._version, beforeVersion, "Vue paints from graph._version — it must advance");
});

test("#1443 a layout store is refreshed from the live LiteGraph nodes", () => {
  const captured = [];
  let layoutVersion = 1;
  const layoutStore = {
    get layoutVersion() {
      return layoutVersion;
    },
    initializeFromLiteGraph(nodes) {
      captured.push(nodes);
      layoutVersion += 1;
    },
  };
  const graph = {
    _nodes: [
      { id: 4, pos: [10, 20], size: [100, 50] },
      { id: 8, pos: [30, 40], size: [80, 60] },
    ],
    setDirtyCanvas() {},
  };
  const ack = ackVisibleCanvasMutation({ graph, canvas: { setDirty() {} }, layoutStore });
  assert.equal(ack.notified, true);
  assert.equal(captured.length, 1, "the live graph must be the refresh source");
  assert.deepEqual(
    captured[0].map((n) => n.id),
    graph._nodes.map((n) => n.id),
    "every live node is pushed — not a hardcoded fixture list",
  );
  assert.notEqual(ack.after.layoutVersion, ack.before.layoutVersion);
});

test("#1443 findLayoutStore prefers an attached store with initializeFromLiteGraph", () => {
  const store = { initializeFromLiteGraph() {} };
  assert.equal(findLayoutStore({ graph: { layoutStore: store } }), store);
  assert.equal(findLayoutStore({ canvas: { layoutStore: store } }), store);
  assert.equal(findLayoutStore({ graph: {}, canvas: {} }), null);
  const pinia = new Map([["other", {}], ["layout", store]]);
  assert.equal(findLayoutStore({ piniaStores: pinia }), store);
});

test("#1443 Vue-nodes recommit runs pos/size setters so the layout store is told", () => {
  const layout = [];
  const proto = {
    get pos() {
      return this._pos;
    },
    set pos(v) {
      this._pos[0] = Number(v[0]);
      this._pos[1] = Number(v[1]);
      layout.push([Number(v[0]), Number(v[1])]);
    },
    get size() {
      return this._size;
    },
    set size(v) {
      this._size[0] = Number(v[0]);
      this._size[1] = Number(v[1]);
    },
  };
  const node = Object.assign(Object.create(proto), {
    id: 1,
    _pos: [5, 6],
    _size: [40, 50],
  });
  const graph = { _nodes: [node] };
  const n = recommitNodeLayouts(graph);
  assert.equal(n, 1);
  assert.deepEqual(layout, [[5, 6]], "the pos SETTER must run — in-place writes skip the layout store");
});

test("#1443 ack with vueNodes re-commits live node geometry", () => {
  let setterRuns = 0;
  const node = {
    id: 2,
    _pos: [1, 2],
    get pos() {
      return this._pos;
    },
    set pos(v) {
      this._pos[0] = Number(v[0]);
      this._pos[1] = Number(v[1]);
      setterRuns += 1;
    },
    size: [10, 10],
  };
  const graph = {
    _nodes: [node],
    _version: 0,
    incrementVersion() {
      this._version += 1;
    },
    setDirtyCanvas() {},
  };
  ackVisibleCanvasMutation({ graph, vueNodes: true });
  assert.equal(setterRuns, 1);
});

test("#1443 withVisibleCanvasAck discloses a miss and leaves a notified result alone", () => {
  const ok = { edited: [{ node_id: 1 }] };
  assert.equal(withVisibleCanvasAck(ok, { notified: true }), ok);
  const missed = withVisibleCanvasAck(ok, { notified: false });
  assert.equal(missed.canvas_ack, false);
  assert.equal(missed.canvas_ack_note, VISIBLE_CANVAS_ACK_NOTE);
  assert.deepEqual(missed.edited, ok.edited);
});

test("#1443 syncLayoutStoreFromGraph feeds the store the graph's own nodes", () => {
  const graph = {
    _nodes: [
      { id: 11, pos: [0, 1], size: [2, 3] },
      { id: 12, pos: [4, 5], size: [6, 7] },
    ],
  };
  let received;
  const store = {
    initializeFromLiteGraph(nodes) {
      received = nodes;
    },
  };
  assert.equal(syncLayoutStoreFromGraph(store, graph), true);
  assert.equal(received.length, graph._nodes.length);
  assert.equal(received[0].id, graph._nodes[0].id);
  assert.deepEqual(received[0].pos, [graph._nodes[0].pos[0], graph._nodes[0].pos[1]]);
});

test("#1443 dispatch acks the visible canvas AFTER a mutating graph executor succeeds", () => {
  const idx = PANEL_SRC.indexOf("result = await executor(msg);");
  assert.notEqual(idx, -1, "the dispatch executor call must still exist");
  const window = PANEL_SRC.slice(idx, idx + 1800);
  assert.match(
    window,
    /ackVisibleCanvasMutation\(/,
    "the ack must run on the same path as the mutation, not a later idle task",
  );
  assert.match(window, /withVisibleCanvasAck\(/);
  assert.match(window, /graphCommandMayMutateWorkflow\(msg\.cmd\)/);
  const snapshot = window.indexOf("changeTrackerToSnapshot");
  const ackAt = window.indexOf("ackVisibleCanvasMutation(");
  assert.ok(ackAt > -1 && snapshot > -1, "both the tracker snapshot and the canvas ack must be present");
});

test("#1443 reads are not canvas-acked", () => {
  // A read that dirtied the canvas would look like a mutation to the user.
  const fence = PANEL_SRC.slice(
    PANEL_SRC.indexOf("if (msg.cmd.startsWith(\"graph_\")"),
    PANEL_SRC.indexOf("result = await executor(msg);"),
  );
  assert.match(fence, /visibleMutationTarget/);
  assert.match(fence, /graphCommandMayMutateWorkflow\(msg\.cmd\)/);
});

test("#1443 the helper is imported by the panel", () => {
  assert.match(PANEL_SRC, /from "\.\/lib\/visible-canvas-ack\.js"/);
  assert.match(PANEL_SRC, /ackVisibleCanvasMutation/);
  assert.match(PANEL_SRC, /withVisibleCanvasAck/);
});

function realGraphEditNode(getGraphCtx) {
  const methodMatch = PANEL_SRC.match(/graph_edit_node\(args = \{\}\) \{[\s\S]*?\n  \},/);
  assert.ok(methodMatch, "could not locate graph_edit_node in panel source");
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    "refreshNodeArea",
    "unsafeBypassMappings",
    "resolveRailNode",
    "railKindFor",
    "canonicalNodeId",
    "isQualifiedNodeId",
    "writePoint",
    `const executors = { ${methodMatch[0]} }; return executors.graph_edit_node;`,
  );
  const graph = getGraphCtx().graph;
  return factory(
    getGraphCtx,
    (_graph, id) => {
      const node = graph._nodes.find((n) => n.id === id);
      if (!node) throw new Error(`No node with id ${id}`);
      return node;
    },
    () => {},
    () => [],
    () => null,
    () => null,
    canonicalNodeId,
    isQualifiedNodeId,
    writePoint,
  );
}

test("#1443 graph_edit_node then ack: outline-visible mutation becomes canvas-visible", () => {
  const node = {
    id: 7,
    pos: [0, 0],
    size: [140, 60],
    title: "LoadImage",
    flags: {},
    setSize(next) {
      this.size = [...next];
    },
  };
  const canvas = {
    dirty_canvas: false,
    setDirty(fg) {
      if (fg) this.dirty_canvas = true;
    },
  };
  const graph = {
    _nodes: [node],
    _version: 0,
    incrementVersion() {
      this._version += 1;
    },
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {
      /* no-op — the #1443 shape */
    },
    getNodeById(id) {
      return id === node.id ? node : null;
    },
  };
  const fn = realGraphEditNode(() => ({ graph, canvas, LG: { LGraphCanvas: { node_colors: {} } } }));
  const result = fn({ node_id: 7, pos: [100, 200] });
  assert.deepEqual(node.pos, [100, 200], "the graph object outline reads DID change");
  assert.equal(canvas.dirty_canvas, false, "the executor's graph.setDirtyCanvas did not reach the canvas");
  const ack = ackVisibleCanvasMutation({ graph, canvas });
  const disclosed = withVisibleCanvasAck(result, ack);
  assert.equal(ack.notified, true);
  assert.equal(canvas.dirty_canvas, true, "the active canvas must be dirtied");
  assert.equal(disclosed, result, "a notified canvas keeps the happy-path reply");
});

function realRemoveGroup(graph) {
  const start = PANEL_SRC.indexOf("graph_remove_group({ group_id }) {");
  assert.ok(start > -1, "graph_remove_group must exist");
  const end = PANEL_SRC.indexOf("graph_set_node_mode(", start);
  const body = PANEL_SRC.slice(start, end);
  const resolveStart = panelFunctionStart(PANEL_SRC, "resolveGroup");
  const resolveEnd = PANEL_SRC.indexOf("\nfunction nextGroupId", resolveStart);
  const stillStart = panelFunctionStart(PANEL_SRC, "groupStillPresent");
  const stillEnd = PANEL_SRC.indexOf("\nfunction describePreflightUndo", stillStart);
  const summaryStart = panelFunctionStart(PANEL_SRC, "summarizeGroup");
  const summaryEnd = PANEL_SRC.indexOf("\nfunction ", summaryStart + "function summarizeGroup".length);
  return new Function(
    "getGraphCtx",
    "syncGraphNodeAreas",
    "summarizeGroup",
    "resolveGroup",
    "groupStillPresent",
    `"use strict";
     const GRAPH_TOOL_EXECUTORS = { ${body} };
     return GRAPH_TOOL_EXECUTORS.graph_remove_group;`,
  )(
    () => ({ graph }),
    () => {},
    (g, group) => ({ id: group.id, title: group.title }),
    (g, id) => {
      const found = (g._groups || []).find((x) => x.id === id);
      if (!found) throw new Error(`No group with id ${id}`);
      return found;
    },
    (g, group) => (g._groups || []).includes(group),
  );
}

test("#1443 graph_remove_group then ack: a group gone from the graph is painted off the canvas", () => {
  const group = { id: 1, title: "Box" };
  const canvas = {
    dirty_canvas: false,
    setDirty(fg) {
      if (fg) this.dirty_canvas = true;
    },
  };
  const graph = {
    _nodes: [{ id: 1, pos: [0, 0], size: [10, 10] }],
    _groups: [group],
    _version: 4,
    incrementVersion() {
      this._version += 1;
    },
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {
      /* no-op */
    },
    removeGroup(g) {
      const i = this._groups.indexOf(g);
      if (i >= 0) this._groups.splice(i, 1);
    },
  };
  const fn = realRemoveGroup(graph);
  const result = fn({ group_id: 1 });
  assert.equal(graph._groups.length, 0, "outline would already report group-free");
  assert.equal(canvas.dirty_canvas, false, "the executor did not dirty the active canvas");
  const beforeVersion = graph._version;
  const ack = ackVisibleCanvasMutation({ graph, canvas });
  assert.equal(ack.notified, true);
  assert.equal(canvas.dirty_canvas, true);
  assert.notEqual(graph._version, beforeVersion);
  assert.equal(result.removed.id, 1);
});
