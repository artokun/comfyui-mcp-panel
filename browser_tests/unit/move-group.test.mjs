// #408: `panel_move_group` must move a group's BOX and everything the box
// encloses — nodes, nested group boxes, reroute points — and must never report a
// membership it computed from stale geometry. The box is not the membership.
//
// These tests extract the SHIPPED graph_move_group (plus the real resolveGroup /
// setGroupBounds / summarizeGroup helpers) out of the panel source and run it
// against LiteGraph-shaped doubles, so they verify the real implementation rather
// than a copy of it. Deleting any of the behaviours under test turns one of these
// red — each assertion is pinned to a specific line of the handler.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  groupMemberNodes,
  syncGraphNodeAreas,
  moveGroupMembers,
  groupBoundsOf,
  nestedGroupsOf,
  translateGroupBox,
  reroutesInside,
  moveReroutePoints,
  containsBounds,
} from "../../web/js/lib/group-geometry.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const grab = (re, what) => {
  const m = panelSrc.match(re);
  assert.ok(m, `could not locate ${what} in panel source`);
  return m[0];
};

const resolveGroupSrc = grab(/\nfunction resolveGroup\(graph, groupId\) \{[\s\S]*?\n\}/, "resolveGroup");
const setGroupBoundsSrc = grab(/\nfunction setGroupBounds\(group, \[x, y, w, h\]\) \{[\s\S]*?\n\}/, "setGroupBounds");
const summarizeGroupSrc = grab(/\nfunction summarizeGroup\(graph, g\) \{[\s\S]*?\n\}/, "summarizeGroup");
const moveGroupSrc = grab(/ {2}graph_move_group\(\{ group_id, pos, move_nodes \}\) \{[\s\S]*?\n {2}\},/, "graph_move_group");
const moveGroupLabelSrc = grab(/ {4}case "graph_move_group": \{[\s\S]*?\n {4}\}/, 'the graph_move_group activity label');

/** The real shipped handler, wired to the real shipped geometry lib. */
function realMoveGroup(graph) {
  const getGraphCtx = () => ({ graph });
  return new Function(
    "getGraphCtx",
    "groupBoundsOf",
    "syncGraphNodeAreas",
    "groupMemberNodes",
    "nestedGroupsOf",
    "reroutesInside",
    "moveGroupMembers",
    "translateGroupBox",
    "moveReroutePoints",
    `${resolveGroupSrc}
     ${setGroupBoundsSrc}
     ${summarizeGroupSrc}
     const executors = { ${moveGroupSrc} };
     return executors.graph_move_group;`,
  )(
    getGraphCtx,
    groupBoundsOf,
    syncGraphNodeAreas,
    groupMemberNodes,
    nestedGroupsOf,
    reroutesInside,
    moveGroupMembers,
    translateGroupBox,
    moveReroutePoints,
  );
}

/** The real shipped activity-card label for a graph_move_group reply. */
const realMoveGroupLabel = new Function(
  "r",
  `switch ("graph_move_group") { ${moveGroupLabelSrc} }
   return null;`,
);

// ---- LiteGraph-shaped doubles ---------------------------------------------

/** A node whose cached boundingRect is kept exactly where the caller puts it,
 *  so "stale rect" scenarios are reproducible. `rect` defaults to the live
 *  footprint (pos/size + title band), matching nodeFocusBounds' own fallback. */
function node(id, pos, size = [100, 100], rect = null) {
  return {
    id,
    pos: [...pos],
    size: [...size],
    boundingRect: rect ? [...rect] : [pos[0], pos[1] - 30, size[0], size[1] + 30],
  };
}

function group(id, bounding, title = `G${id}`) {
  return { id, title, _bounding: [...bounding], recomputeInsideNodes() {} };
}

function makeGraph({ nodes = [], groups = [], reroutes = null } = {}) {
  return {
    _nodes: nodes,
    _groups: groups,
    ...(reroutes ? { reroutes } : {}),
    beforeChange() { this.beforeCount = (this.beforeCount ?? 0) + 1; },
    afterChange() { this.afterCount = (this.afterCount ?? 0) + 1; },
    setDirtyCanvas() { this.dirty = true; },
  };
}

// ---------------------------------------------------------------------------

test("#408: moving a group carries its NESTED group box, so its members stay grouped", () => {
  const inner = group(2, [50, 50, 100, 100], "Inner");
  const outer = group(1, [0, 0, 400, 400], "Outer");
  const a = node(7, [70, 90], [60, 40]); // rect [70,60,60,70], centre (100,95) → inside both
  const graph = makeGraph({ nodes: [a], groups: [outer, inner] });

  assert.deepEqual(groupMemberNodes(graph, inner).map((n) => n.id), [7], "precondition: node 7 is in the inner group");

  const out = realMoveGroup(graph)({ group_id: 1, pos: [100, 100], move_nodes: true });

  assert.deepEqual(a.pos, [170, 190], "the member node moved with the outer box");
  assert.deepEqual(inner._bounding, [150, 150, 100, 100], "the NESTED group box moved by the same delta");
  // The point of the whole fix: the node that was grouped is STILL grouped.
  assert.deepEqual(
    groupMemberNodes(graph, inner).map((n) => n.id),
    [7],
    "node 7 must still be a member of the inner group after the outer group moved",
  );
  assert.equal(out.moved.groups, 1, "the reply reports the nested group it carried");
  assert.equal(out.moved.nodes, 1);
});

test("#408: a group that is only OVERLAPPED (or exactly coincident) is NOT dragged along", () => {
  const outer = group(1, [0, 0, 400, 400], "Outer");
  const overlapping = group(2, [350, 350, 200, 200], "Neighbour"); // pokes outside → not a child
  const coincident = group(3, [0, 0, 400, 400], "Twin"); // identical box → peer, not child
  const graph = makeGraph({ nodes: [], groups: [outer, overlapping, coincident] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [100, 100] });

  assert.deepEqual(overlapping._bounding, [350, 350, 200, 200], "a partially overlapping group must not move");
  assert.deepEqual(coincident._bounding, [0, 0, 400, 400], "an identically-bounded group is a peer, not a child");
  assert.equal(out.moved.groups, 0);
});

test("#408: moving a group carries the reroute points inside its box and leaves the others", () => {
  const g = group(1, [0, 0, 400, 400]);
  const inside = { id: 11, pos: [100, 100] };
  const outside = { id: 12, pos: [900, 900] };
  const graph = makeGraph({
    groups: [g],
    reroutes: new Map([[11, inside], [12, outside]]),
  });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [100, 100] });

  assert.deepEqual([inside.pos[0], inside.pos[1]], [200, 200], "an enclosed reroute moved with the box");
  assert.deepEqual([outside.pos[0], outside.pos[1]], [900, 900], "a reroute outside the box stayed put");
  assert.equal(out.moved.reroutes, 1);
});

test("#408: a reroute whose pos is a COPY-returning getter is still moved (assignment fallback)", () => {
  const g = group(1, [0, 0, 400, 400]);
  const reroute = {
    id: 11,
    _p: [100, 100],
    get pos() { return [...this._p]; }, // in-place writes are dropped
    set pos(v) { this._p = [Number(v[0]), Number(v[1])]; },
  };
  const graph = makeGraph({ groups: [g], reroutes: [reroute] });

  realMoveGroup(graph)({ group_id: 1, pos: [100, 100] });

  assert.deepEqual(reroute._p, [200, 200], "the in-place write was dropped, so the setter must have been used");
});

test("#408: move_nodes:false reports the membership of the NEW box from LIVE geometry, not stale rects", () => {
  const g = group(1, [0, 0, 200, 200]);
  // Node 7 is really at [50,50] (centre inside the box) but its CACHED rect is
  // left over from a position the panel never saw it leave (paste / load / drag).
  const a = node(7, [50, 50], [100, 100], [1000, 1000, 100, 130]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [10, 10], move_nodes: false });

  assert.deepEqual(a.pos, [50, 50], "move_nodes:false must not move the node");
  assert.deepEqual(out.group.bounding, [10, 10, 200, 200], "the box moved");
  assert.deepEqual(
    out.group.node_ids,
    [7],
    "membership must be recomputed from the node's LIVE footprint, not its stale cached rect",
  );
  assert.equal(out.group.node_count, 1);
  assert.deepEqual(out.moved, { nodes: 0, groups: 0, reroutes: 0 }, "box-only moves must report carrying nothing");
});

test("#408: move_nodes:false drops a node whose live position left the new box", () => {
  const g = group(1, [0, 0, 200, 200]);
  // Live pos is far away; the STALE rect still claims it is inside the box.
  const a = node(7, [5000, 5000], [100, 100], [50, 20, 100, 130]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [0, 0], move_nodes: false });

  assert.deepEqual(out.group.node_ids, [], "a node that has really moved out must not be reported as a member");
});

test("#408: a non-finite pos is refused LOUDLY instead of NaN-ing the whole group", () => {
  const g = group(1, [0, 0, 200, 200]);
  const a = node(7, [50, 50], [100, 100]);
  const graph = makeGraph({ nodes: [a], groups: [g] });
  const move = realMoveGroup(graph);

  for (const bad of [[Number.NaN, 0], [0, undefined], ["left", 10], [10], undefined, null, "10,10"]) {
    assert.throws(() => move({ group_id: 1, pos: bad, move_nodes: true }), /pos must be \[x, y\] finite numbers/);
  }
  assert.deepEqual(a.pos, [50, 50], "no member position may be corrupted by a refused move");
  assert.deepEqual(g._bounding, [0, 0, 200, 200], "the group box must be untouched by a refused move");
  assert.equal(graph.beforeCount, undefined, "a refused move must not open an undo transaction");
});

test("#408: a group with unusable bounds is refused with a stated remedy, not moved to NaN", () => {
  const broken = { id: 1, title: "Broken", _bounding: ["x", "y", "w", "h"] };
  const graph = makeGraph({ groups: [broken] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [10, 10] }),
    /no usable bounds .* panel_edit_group/s,
  );
});

test("#408 regression: the members move with the box and the reply says so", () => {
  const g = group(1, [0, 0, 300, 300]);
  const a = node(7, [50, 50], [100, 100]);
  const b = node(8, [150, 150], [100, 100]);
  const away = node(9, [9000, 9000], [100, 100]);
  const graph = makeGraph({ nodes: [a, b, away], groups: [g] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 2000] });

  assert.deepEqual(a.pos, [1050, 2050]);
  assert.deepEqual(b.pos, [1150, 2150]);
  assert.deepEqual(away.pos, [9000, 9000], "a node outside the box is not a member and must not move");
  assert.deepEqual(out.group.node_ids, [7, 8], "membership at the new box is reported from the moved footprints");
  assert.equal(out.moved.nodes, 2);
  assert.equal(graph.beforeCount, 1, "the whole move is one undo transaction");
  assert.equal(graph.afterCount, 1);
});

test("the activity card names what came with the box, and says so when nothing did", () => {
  assert.match(
    realMoveGroupLabel({ group: { id: 1, title: "Outer" }, moved: { nodes: 2, groups: 1, reroutes: 3 } }).text,
    /with 2 nodes, 1 nested group, 3 reroutes/,
  );
  assert.match(
    realMoveGroupLabel({ group: { id: 1, title: "Outer" }, moved: { nodes: 1, groups: 0, reroutes: 0 } }).text,
    /with 1 node$/,
  );
  assert.match(
    realMoveGroupLabel({ group: { id: 1, title: "Outer" }, moved: { nodes: 0, groups: 0, reroutes: 0 } }).text,
    /box only/,
  );
});

// ---- lib branches the handler tests above do not reach ---------------------

test("containsBounds: strict containment, identical rects excluded (litegraph containsRect)", () => {
  assert.equal(containsBounds([0, 0, 100, 100], [10, 10, 50, 50]), true);
  assert.equal(containsBounds([0, 0, 100, 100], [0, 0, 100, 100]), false, "identical rects are peers");
  assert.equal(containsBounds([0, 0, 100, 100], [0, 0, 100, 50]), true, "sharing an edge is still containment");
  assert.equal(containsBounds([0, 0, 100, 100], [90, 90, 50, 50]), false, "overlap is not containment");
  assert.equal(containsBounds(null, [0, 0, 1, 1]), false);
  assert.equal(containsBounds([0, 0, 1, 1], null), false);
});

test("translateGroupBox falls back to pos when the build exposes no _bounding quad", () => {
  const g = { pos: [10, 20], size: [100, 50] };
  translateGroupBox(g, 5, -5);
  assert.deepEqual(g.pos, [15, 15]);
  assert.deepEqual(g.size, [100, 50], "a move must never change the box size");
  assert.doesNotThrow(() => translateGroupBox(null, 1, 1));
});

test("reroutesInside reads the Map, array and plain-object shapes of graph.reroutes", () => {
  const bounds = [0, 0, 100, 100];
  const hit = { id: 1, pos: [50, 50] };
  const miss = { id: 2, pos: [500, 500] };
  assert.deepEqual(reroutesInside({ reroutes: new Map([[1, hit], [2, miss]]) }, bounds).map((r) => r.id), [1]);
  assert.deepEqual(reroutesInside({ reroutes: [hit, miss] }, bounds).map((r) => r.id), [1]);
  assert.deepEqual(reroutesInside({ reroutes: { a: hit, b: miss } }, bounds).map((r) => r.id), [1]);
  assert.deepEqual(reroutesInside({}, bounds), [], "no reroutes on this build → nothing to move");
  assert.deepEqual(reroutesInside({ reroutes: [{ id: 3 }, { id: 4, pos: [Number.NaN, 0] }] }, bounds), []);
  assert.deepEqual(reroutesInside({ reroutes: [hit] }, null), []);
});

test("nestedGroupsOf tolerates a group with no usable bounds on either side", () => {
  const outer = group(1, [0, 0, 400, 400]);
  const junk = { id: 2, title: "junk", _bounding: ["a", "b", "c", "d"] };
  const graph = makeGraph({ groups: [outer, junk] });
  assert.deepEqual(nestedGroupsOf(graph, outer), []);
  assert.deepEqual(nestedGroupsOf(graph, junk), [], "an unbounded group has no children");
  assert.deepEqual(nestedGroupsOf(null, outer), []);
});

test("moveReroutePoints skips malformed points and never throws", () => {
  const ok = { pos: [1, 2] };
  assert.doesNotThrow(() => moveReroutePoints([ok, {}, { pos: [1] }, { pos: ["a", "b"] }, null], 10, 10));
  assert.deepEqual(ok.pos, [11, 12]);
  assert.doesNotThrow(() => moveReroutePoints(undefined, 1, 1));
});
