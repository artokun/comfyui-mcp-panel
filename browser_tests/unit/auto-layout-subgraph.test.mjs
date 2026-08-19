// #1328 — the SHIPPED graph_auto_layout must not mutate the root graph when the
// canvas escapes a subgraph between dry_run and apply. These extract the real
// executor from the panel source and drive it against LiteGraph-shaped doubles.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { computeLayout } from "../../web/js/lib/layout-engine.js";
import {
  boundsAroundNodes,
  groupMemberNodes,
  refreshNodeArea,
  syncGraphNodeAreas,
} from "../../web/js/lib/group-geometry.js";
import {
  SUBGRAPH_INPUT_RAIL_ID,
  SUBGRAPH_OUTPUT_RAIL_ID,
} from "../../web/js/lib/subgraph-scope.js";
import {
  bindAutoLayoutGraph,
  clearAutoLayoutScope,
} from "../../web/js/lib/auto-layout-scope.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const grab = (re, what) => {
  const m = panelSrc.match(re);
  assert.ok(m, `could not locate ${what} in panel source`);
  return m[0];
};

const autoLayoutSrc = grab(
  / {2}graph_auto_layout\(\{[\s\S]*?\n {2}\},/,
  "graph_auto_layout",
);
const setGroupBoundsSrc = grab(
  /\nfunction setGroupBounds\(group, \[x, y, w, h\]\) \{[\s\S]*?\n\}/,
  "setGroupBounds",
);

function posOf(n) {
  return [n.pos[0], n.pos[1]];
}

function node(id, pos = [id * 40, id * 15]) {
  return {
    id,
    type: "CLIPTextEncode",
    pos: [...pos],
    size: [200, 80],
    flags: {},
  };
}

function attachGraphApi(graph) {
  graph.getNodeById = (id) => (graph._nodes ?? []).find((n) => n.id === Number(id)) ?? null;
  graph.links = graph.links ?? {};
  graph._groups = graph._groups ?? [];
  graph.beforeChange = graph.beforeChange ?? (() => {});
  graph.afterChange = graph.afterChange ?? (() => {});
  graph.setDirtyCanvas = graph.setDirtyCanvas ?? (() => {});
  return graph;
}

function fixture() {
  const inner = [node(1, [10, 10]), node(2, [20, 80]), node(3, [30, 160])];
  const sub = attachGraphApi({
    name: "inner",
    _nodes: inner,
    inputNode: { id: SUBGRAPH_INPUT_RAIL_ID, pos: [0, 0] },
    outputNode: { id: SUBGRAPH_OUTPUT_RAIL_ID, pos: [400, 0] },
  });
  const rootNodes = [node(64, [100, 100]), node(65, [400, 100]), node(66, [700, 100])];
  const owner = { id: 121, type: "SubgraphNode", title: "Pack", pos: [1000, 100], size: [200, 120], flags: {}, subgraph: sub };
  const root = attachGraphApi({ _nodes: [...rootNodes, owner] });
  let canvasGraph = sub;
  const canvas = {
    get graph() {
      return canvasGraph;
    },
    setGraph(g) {
      canvasGraph = g;
    },
    setDirty() {},
  };
  return { inner, sub, root, owner, rootNodes, canvas };
}

function resolveNode(graph, id) {
  const n = graph.getNodeById(id);
  if (!n) throw new Error(`No node with id ${id} in the current graph`);
  return n;
}

function realAutoLayout(getGraphCtx) {
  return new Function(
    "getGraphCtx",
    "bindAutoLayoutGraph",
    "syncGraphNodeAreas",
    "SUBGRAPH_INPUT_RAIL_ID",
    "SUBGRAPH_OUTPUT_RAIL_ID",
    "resolveNode",
    "groupMemberNodes",
    "computeLayout",
    "boundsAroundNodes",
    "refreshNodeArea",
    `"use strict";
     ${setGroupBoundsSrc}
     const executors = { ${autoLayoutSrc} };
     return executors.graph_auto_layout;`,
  )(
    getGraphCtx,
    bindAutoLayoutGraph,
    syncGraphNodeAreas,
    SUBGRAPH_INPUT_RAIL_ID,
    SUBGRAPH_OUTPUT_RAIL_ID,
    resolveNode,
    groupMemberNodes,
    computeLayout,
    boundsAroundNodes,
    refreshNodeArea,
  );
}

test.beforeEach(() => {
  clearAutoLayoutScope();
});

test("#1328 dry_run and apply both target the subgraph; an escaped canvas does not move root nodes", () => {
  const { inner, sub, root, owner, rootNodes, canvas } = fixture();
  const rootBefore = new Map(root._nodes.map((n) => [n.id, posOf(n)]));
  const innerBefore = new Map(inner.map((n) => [n.id, posOf(n)]));

  let viewing = sub;
  const layout = realAutoLayout(() => ({
    graph: viewing,
    rootGraph: root,
    canvas,
  }));

  const dry = layout({ mode: "flow_horizontal", groups: "ignore", dry_run: true });
  assert.equal(dry.applied, false);
  assert.equal(dry.viewing.scope, "subgraph");
  assert.equal(dry.viewing.owner_node_id, 121);
  assert.equal(dry.moved.length, 3);
  assert.deepEqual(
    dry.moved.map((m) => m.node_id).sort((a, b) => a - b),
    [1, 2, 3],
  );
  for (const n of inner) assert.deepEqual(posOf(n), innerBefore.get(n.id), "dry_run must not move inner nodes");
  for (const n of root._nodes) assert.deepEqual(posOf(n), rootBefore.get(n.id), "dry_run must not move root nodes");

  // The reported bug: the canvas has escaped to root by the time apply runs.
  viewing = root;
  const applied = layout({ mode: "flow_horizontal", groups: "ignore", dry_run: false });
  assert.equal(applied.applied, true);
  assert.equal(applied.viewing.scope, "subgraph");
  assert.equal(applied.viewing.owner_node_id, 121);
  assert.deepEqual(
    applied.moved.map((m) => m.node_id).sort((a, b) => a - b),
    [1, 2, 3],
    "apply must return inner ids, not the root set that includes owner 121",
  );
  for (const n of rootNodes) {
    assert.deepEqual(posOf(n), rootBefore.get(n.id), `root node ${n.id} must stay put`);
  }
  assert.deepEqual(posOf(owner), rootBefore.get(owner.id), "the subgraph owner node on root must stay put");
  const innerMoved = inner.some((n) => JSON.stringify(posOf(n)) !== JSON.stringify(innerBefore.get(n.id)));
  assert.equal(innerMoved, true, "inner nodes must actually be rearranged");
  assert.equal(canvas.graph, sub, "apply must walk the canvas back into the subgraph");
});

test("#1328 apply without a prior subgraph capture still layouts a live subgraph", () => {
  const { inner, sub, root, canvas } = fixture();
  const layout = realAutoLayout(() => ({ graph: sub, rootGraph: root, canvas }));
  const applied = layout({ mode: "flow_horizontal", groups: "ignore" });
  assert.equal(applied.applied, true);
  assert.equal(applied.viewing.scope, "subgraph");
  assert.equal(applied.moved.length, inner.length);
});

test("#1328 a root-only apply with no captured subgraph still rearranges the root", () => {
  const { root, canvas } = fixture();
  const before = new Map(root._nodes.map((n) => [n.id, posOf(n)]));
  const layout = realAutoLayout(() => ({ graph: root, rootGraph: root, canvas }));
  const applied = layout({ mode: "flow_horizontal", groups: "ignore" });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.viewing, { scope: "root" });
  assert.ok(applied.moved.some((m) => m.node_id === 121), "root layout includes the subgraph owner node");
  const moved = root._nodes.some((n) => JSON.stringify(posOf(n)) !== JSON.stringify(before.get(n.id)));
  assert.equal(moved, true);
});

test("#1328 apply refuses rather than writing root when the subgraph node count drifted", () => {
  const { inner, sub, root, rootNodes, canvas } = fixture();
  const originals = inner.slice();
  const rootBefore = new Map(root._nodes.map((n) => [n.id, posOf(n)]));
  const innerBefore = new Map(originals.map((n) => [n.id, posOf(n)]));
  let viewing = sub;
  const layout = realAutoLayout(() => ({ graph: viewing, rootGraph: root, canvas }));
  layout({ mode: "flow_horizontal", groups: "ignore", dry_run: true });
  sub._nodes.push(node(99, [50, 50]));
  viewing = root;
  assert.throws(
    () => layout({ mode: "flow_horizontal", groups: "ignore" }),
    /Nothing was moved/,
  );
  for (const n of rootNodes) assert.deepEqual(posOf(n), rootBefore.get(n.id));
  for (const n of originals) assert.deepEqual(posOf(n), innerBefore.get(n.id));
});
