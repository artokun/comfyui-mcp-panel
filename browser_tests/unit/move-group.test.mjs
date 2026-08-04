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
  translateGroupBoxes,
  reroutesInside,
  moveReroutePoints,
  containsBounds,
  writePoint,
  samePoint,
  groupBoxIsAt,
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

/** The real shipped handler, wired to the real shipped geometry lib.
 *
 *  `"use strict"` is NOT decoration: comfyui-mcp-panel.js is an ES module, so the
 *  shipped code runs strict, where a write to a frozen array or a setter-less
 *  accessor THROWS instead of silently doing nothing. A `new Function` body is
 *  sloppy by default, so without this the harness would exercise a more forgiving
 *  language than the one the panel actually runs in — and every "unwritable
 *  geometry" test below would be testing the wrong thing. */
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
    "translateGroupBoxes",
    "moveReroutePoints",
    "groupBoxIsAt",
    `"use strict";
     ${resolveGroupSrc}
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
    translateGroupBoxes,
    moveReroutePoints,
    groupBoxIsAt,
  );
}

/** The real shipped activity-card label for a graph_move_group reply. */
const realMoveGroupLabel = new Function(
  "r",
  `"use strict";
   switch ("graph_move_group") { ${moveGroupLabelSrc} }
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

// ---- point shapes: the write must land on every frontend, or say it didn't --

test("#408: a node whose pos is a TYPED-ARRAY VIEW into its boundingRect is moved", () => {
  // Current ComfyUI frontends expose LGraphNode.pos as a Float64Array subarray of
  // the node's bounding Rectangle — Array.isArray(pos) is FALSE. A member loop
  // written for plain arrays skips every node on those builds: the box moves
  // alone, which is the exact #408 report.
  const backing = new Float64Array([50, 50]);
  const a = {
    id: 7,
    size: [100, 100],
    boundingRect: [50, 20, 100, 130],
    get pos() { return backing.subarray(0, 2); },
    set pos(v) { backing[0] = Number(v[0]); backing[1] = Number(v[1]); },
  };
  assert.equal(Array.isArray(a.pos), false, "precondition: this is exactly the shape a plain-array guard skips");
  const graph = makeGraph({ nodes: [a], groups: [group(1, [0, 0, 200, 200])] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });

  assert.deepEqual([a.pos[0], a.pos[1]], [1050, 1050], "the typed-array-backed node moved with the box");
  assert.equal(out.moved.nodes, 1);
  assert.deepEqual(out.group.node_ids, [7], "and it is still a member at the new box");
});

test("#408: a typed-array pos with NO setter is moved in place (assignment would throw)", () => {
  const backing = new Float64Array([50, 50]);
  const a = { id: 7, size: [100, 100], boundingRect: [50, 20, 100, 130], get pos() { return backing; } };
  const graph = makeGraph({ nodes: [a], groups: [group(1, [0, 0, 200, 200])] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });

  assert.deepEqual([...backing], [1050, 1050]);
  assert.equal(out.moved.nodes, 1);
});

test("#408: a node whose pos getter returns a COPY is still moved (assignment path)", () => {
  const a = {
    id: 7,
    size: [100, 100],
    boundingRect: [50, 20, 100, 130],
    _p: [50, 50],
    get pos() { return [...this._p]; },
    set pos(v) { this._p = [Number(v[0]), Number(v[1])]; },
  };
  const graph = makeGraph({ nodes: [a], groups: [group(1, [0, 0, 200, 200])] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });

  assert.deepEqual(a._p, [1050, 1050]);
  assert.equal(out.moved.nodes, 1);
});

test("#408: a member that CANNOT be repositioned aborts the whole move and rolls it back", () => {
  const outer = group(1, [0, 0, 400, 400], "Outer");
  const inner = group(2, [50, 50, 100, 100], "Inner");
  const movable = node(7, [200, 200], [60, 40]);
  // A read-only point: assignment throws (strict mode) and the in-place write is
  // rejected, so nothing can put this node anywhere.
  const frozenPoint = Object.freeze([80, 100]);
  const stuck = {
    id: 8,
    size: [60, 40],
    boundingRect: [80, 70, 60, 70],
    get pos() { return frozenPoint; },
  };
  const reroute = { id: 11, pos: [300, 300] };
  const graph = makeGraph({
    nodes: [movable, stuck],
    groups: [outer, inner],
    reroutes: new Map([[11, reroute]]),
  });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /refusing to move group 1: 1 enclosed item\(s\) would not accept a new position \(node 8\).*NOTHING was moved/s,
  );

  assert.deepEqual(outer._bounding, [0, 0, 400, 400], "the group box must be exactly where it was");
  assert.deepEqual(inner._bounding, [50, 50, 100, 100], "the nested box must be rolled back");
  assert.deepEqual(movable.pos, [200, 200], "the movable member must be rolled back");
  assert.deepEqual([...movable.boundingRect], [200, 170, 60, 70], "its cached rect must be rolled back too");
  assert.deepEqual([reroute.pos[0], reroute.pos[1]], [300, 300], "the reroute must be rolled back");
  assert.deepEqual([...frozenPoint], [80, 100], "the stuck node never moved");
});

test("#408: a reroute is moved through the engine's own move() when the build has one", () => {
  const calls = [];
  const reroute = {
    id: 11,
    pos: [100, 100],
    move(dx, dy) { calls.push([dx, dy]); this.pos = [this.pos[0] + dx, this.pos[1] + dy]; },
  };
  const graph = makeGraph({ groups: [group(1, [0, 0, 400, 400])], reroutes: [reroute] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [100, 100] });

  assert.deepEqual(calls, [[100, 100]], "the engine primitive was used, so the layout store sees the change");
  assert.deepEqual([reroute.pos[0], reroute.pos[1]], [200, 200]);
  assert.equal(out.moved.reroutes, 1);
});

test("#408: a build whose reroute move() has the wrong signature is corrected, not trusted", () => {
  // move(x, y) treated as ABSOLUTE by this build. The verified fallback must put
  // the point where the delta says, not where the primitive left it.
  const reroute = { id: 11, pos: [100, 100], move(x, y) { this.pos = [x, y]; } };
  const graph = makeGraph({ groups: [group(1, [0, 0, 400, 400])], reroutes: [reroute] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [100, 100] });

  assert.deepEqual([reroute.pos[0], reroute.pos[1]], [200, 200], "corrected to old + delta");
  assert.equal(out.moved.reroutes, 1);
});

test("#408: a reroute whose move() throws does not abort the move; the direct write still lands", () => {
  const reroute = { id: 11, pos: [100, 100], move() { throw new Error("not on this build"); } };
  const graph = makeGraph({ groups: [group(1, [0, 0, 400, 400])], reroutes: [reroute] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [100, 100] });

  assert.deepEqual([reroute.pos[0], reroute.pos[1]], [200, 200]);
  assert.equal(out.moved.reroutes, 1);
});

test("#408: a FROZEN reroute point aborts and rolls back rather than half-moving the group", () => {
  const g = group(1, [0, 0, 400, 400]);
  const a = node(7, [100, 100], [60, 40]);
  const frozen = Object.freeze([200, 200]);
  const reroute = { id: 11, get pos() { return frozen; } };
  const graph = makeGraph({ nodes: [a], groups: [g], reroutes: [reroute] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /reroute 11.*NOTHING was moved/s,
  );
  assert.deepEqual(a.pos, [100, 100]);
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
});

test("#408: a nested box that will not move aborts and rolls back the members", () => {
  const outer = group(1, [0, 0, 400, 400], "Outer");
  const inner = { id: 2, title: "Frozen inner", _bounding: Object.freeze([50, 50, 100, 100]) };
  const a = node(7, [200, 200], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [outer, inner] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /group 2.*NOTHING was moved/s,
  );
  assert.deepEqual(a.pos, [200, 200], "the member must be back where it started");
  assert.deepEqual(outer._bounding, [0, 0, 400, 400]);
});

test("#408: a group box that refuses the write is a refusal, not a reported success", () => {
  // _bounding is frozen, so setGroupBounds cannot put the box anywhere. Under the
  // strict-mode semantics the shipped module actually runs under, that write
  // THROWS — after the children have already moved. The throw must not escape
  // past the rollback, or the graph is torn apart by an error that says nothing
  // was moved.
  const g = { id: 1, title: "Frozen", _bounding: Object.freeze([0, 0, 400, 400]) };
  const a = node(7, [100, 100], [60, 40]);
  const inner = group(2, [50, 50, 100, 100], "Inner");
  const reroute = { id: 11, pos: [200, 200] };
  const graph = makeGraph({ nodes: [a], groups: [g, inner], reroutes: [reroute] });

  let err = null;
  try {
    realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });
  } catch (error) {
    err = error;
  }
  assert.ok(err, "the move must be refused");
  assert.match(err.message, /the group box did not accept the new position[^(]*\(.+\)\. NOTHING was moved/s);
  // The parenthetical must carry a THROWN write error, not the "did not land"
  // verdict. That is the proof this harness compiled the handler STRICT, the way
  // the shipped ES module runs it: in sloppy mode the same write to a frozen array
  // silently no-ops and this refusal would be reached by luck rather than by the
  // catch that exists to handle it.
  assert.doesNotMatch(
    err.message,
    /the write did not land/,
    "under strict mode the frozen-quad write THROWS; a 'did not land' verdict means the harness ran sloppy",
  );
  assert.deepEqual(a.pos, [100, 100], "the members must be put back when the box write fails");
  assert.deepEqual([...a.boundingRect], [100, 70, 60, 70], "and their cached rects with them");
  assert.deepEqual(inner._bounding, [50, 50, 100, 100], "the nested box must be put back too");
  assert.deepEqual([reroute.pos[0], reroute.pos[1]], [200, 200], "and the reroute");
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
});

test("#408: a child that lands SOMEWHERE ELSE is rolled back too, not just the ones that landed", () => {
  // This build's pos setter snaps to a 25px grid, so the requested position is
  // never reached and the node counts as stuck — but it HAS moved. An undo that
  // only walked the successful moves would strand it there while the error says
  // nothing moved.
  const snapping = {
    id: 7,
    size: [60, 40],
    boundingRect: [100, 70, 60, 70],
    _p: [100, 100],
    get pos() { return [...this._p]; },
    set pos(v) { this._p = [Math.round(Number(v[0]) / 25) * 25, Math.round(Number(v[1]) / 25) * 25]; },
  };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [snapping], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1013, 1013] }),
    /node 7.*NOTHING was moved/s,
  );
  assert.deepEqual(snapping._p, [100, 100], "the snapped node must be restored to its ORIGINAL position");
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
});

test("#408: a snapping reroute is also restored exactly, not left where the engine put it", () => {
  const snapping = {
    id: 11,
    _p: [100, 100],
    get pos() { return [...this._p]; },
    set pos(v) { this._p = [Math.round(Number(v[0]) / 25) * 25, Math.round(Number(v[1]) / 25) * 25]; },
  };
  const frozenNode = { id: 7, size: [60, 40], boundingRect: [50, 20, 60, 70], get pos() { return Object.freeze([50, 50]); } };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [frozenNode], groups: [g], reroutes: [snapping] });

  assert.throws(() => realMoveGroup(graph)({ group_id: 1, pos: [1013, 1013] }), /NOTHING was moved/);
  assert.deepEqual(snapping._p, [100, 100], "restored to its original point, not to old+(-delta)");
});

test("#408: a node whose pos is a plain PROPERTY holding a typed-array view keeps that view", () => {
  // The view is the node's live geometry container. Replacing it with a fresh
  // plain array would leave the node at the right coordinates while silently
  // disconnecting it from whatever else writes through that view.
  const geometry = new Float64Array([50, 50, 0, 0]);
  const a = { id: 7, size: [100, 100], boundingRect: [50, 20, 100, 130], pos: geometry.subarray(0, 2) };
  const view = a.pos;
  const graph = makeGraph({ nodes: [a], groups: [group(1, [0, 0, 200, 200])] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });

  assert.equal(a.pos, view, "the node must still hold the SAME container it started with");
  assert.deepEqual([geometry[0], geometry[1]], [1050, 1050], "and the write went through it");
  assert.equal(out.moved.nodes, 1);
});

test("#408: a group box that CLAMPS the write is refused, and the box is put back", () => {
  // A frontend whose quad clamps to the positive quadrant: the write does not
  // throw, it just does not land where we asked.
  const quad = [0, 0, 400, 400];
  const clamping = {
    id: 1,
    title: "Clamped",
    get _bounding() { return quad; },
    set _bounding(v) { quad[0] = Math.max(0, v[0]); quad[1] = Math.max(0, v[1]); },
  };
  const a = node(7, [100, 100], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [clamping] });
  // setGroupBounds mutates _bounding IN PLACE, so emulate the clamp on the quad.
  Object.defineProperty(quad, "0", {
    get() { return this._x ?? 0; },
    set(v) { this._x = Math.max(0, Math.min(500, v)); },
    configurable: true,
  });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [9000, 10] }),
    /the group box did not accept the new position .*NOTHING was moved/s,
  );
  assert.equal(quad[0], 0, "the box is back at its original x");
  assert.deepEqual(a.pos, [100, 100], "and the member is back too");
});

test("#408: move_nodes:false VERIFIES the box write instead of assuming it", () => {
  const g = { id: 1, title: "Frozen", _bounding: Object.freeze([0, 0, 400, 400]) };
  const graph = makeGraph({ nodes: [], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000], move_nodes: false }),
    /the group box did not accept the new position/,
  );
  assert.deepEqual([...g._bounding], [0, 0, 400, 400]);
});

test("#408: when a child cannot be put back, the refusal says PARTIALLY moved, not 'nothing'", () => {
  // This node accepts any position except its original one — so the forward move
  // succeeds and the rollback cannot undo it. Announcing "nothing was moved"
  // there would be the exact fabrication this whole path exists to prevent.
  const oneWay = {
    id: 7,
    size: [60, 40],
    boundingRect: [100, 70, 60, 70],
    _p: [100, 100],
    get pos() { return [...this._p]; },
    set pos(v) {
      if (Number(v[0]) === 100 && Number(v[1]) === 100) return; // refuses to go home
      this._p = [Number(v[0]), Number(v[1])];
    },
  };
  // A frozen sibling forces the refusal AFTER oneWay has already moved.
  const stuckNode = { id: 8, size: [60, 40], boundingRect: [150, 120, 60, 70], get pos() { return Object.freeze([150, 150]); } };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [oneWay, stuckNode], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /The graph is PARTIALLY moved — 1 item\(s\) could NOT be put back \(node 7\)\. Press Ctrl\+Z/s,
  );
  assert.deepEqual(oneWay._p, [1100, 1100], "it really is still displaced — the message must not deny it");
  assert.deepEqual(g._bounding, [0, 0, 400, 400], "the box itself never moved");
});

// ---- lib branches the handler tests above do not reach ---------------------

test("writePoint reports the truth for every point shape", () => {
  const plain = { pos: [1, 2] };
  assert.equal(writePoint(plain, "pos", 10, 20), true);
  assert.deepEqual([plain.pos[0], plain.pos[1]], [10, 20]);

  const typed = { pos: new Float64Array([1, 2]) };
  assert.equal(writePoint(typed, "pos", 10, 20), true);
  assert.deepEqual([typed.pos[0], typed.pos[1]], [10, 20]);

  // A Float32-backed point (older LiteGraph) cannot store an arbitrary double
  // exactly, so the value read back differs from the value written. A strict
  // read-back would call this perfectly good write a FAILURE — and since an
  // unmovable child now aborts the whole group move, that would turn every group
  // move on those builds into a refusal.
  const f32backing = new Float32Array([0, 0]);
  const f32 = { get pos() { return f32backing; } };
  assert.equal(writePoint(f32, "pos", 1234.1, 5678.2), true);
  assert.notEqual(f32backing[0], 1234.1, "precondition: the read-back is genuinely not equal");
  assert.equal(f32backing[0], Math.fround(1234.1), "but it is exactly what Float32 storage can hold");

  const readOnly = { get pos() { return Object.freeze([1, 2]); } };
  assert.equal(writePoint(readOnly, "pos", 10, 20), false, "an unwritable point must report false");

  // A build that SNAPS the write to a grid did not put the point where we asked.
  // Accepting that would be reporting a move to coordinates the node is not at.
  const snapping = {
    _p: [0, 0],
    get pos() { return [...this._p]; },
    set pos(v) { this._p = [Math.round(v[0] / 25) * 25, Math.round(v[1] / 25) * 25]; },
  };
  assert.equal(writePoint(snapping, "pos", 113, 113), false, "a snapped write is not the write we asked for");
});

test("samePoint is exact unless the destination really is a Float32Array", () => {
  assert.equal(samePoint(10, 10), true);
  assert.equal(samePoint(1234.2, 1234.1), false, "0.1px of slack is already a different point");
  assert.equal(
    samePoint(Math.fround(1234.1), 1234.1),
    false,
    "Float32 rounding is only forgiven for a Float32 container, not by default",
  );
  assert.equal(samePoint(Math.fround(1234.1), 1234.1, true), true, "…and it IS forgiven for one");
  // The failure mode a RELATIVE tolerance has: at a large coordinate it accepts a
  // huge error, so a write that did nothing at all reads as a completed move.
  assert.equal(samePoint(1e9, 1e9 + 1), false, "a no-op at a large coordinate is NOT a move");
  assert.equal(samePoint(1e9, 1e9 + 1000), false);
  assert.equal(samePoint(1e9, 1e9 + 1000, true), false, "not even for a Float32 container");
  assert.equal(samePoint(Number.NaN, 10), false);
  assert.equal(samePoint(10, Number.NaN), false);
  assert.equal(samePoint(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), false);
});

test("a Float32Array-backed group box (older LiteGraph) still moves and reports honestly", () => {
  // _bounding is a Float32Array on those builds. An EXACT read-back would reject
  // every write to it and turn every group move into a refusal.
  const g = { id: 1, title: "F32", _bounding: new Float32Array([0, 0, 400, 400]) };
  const a = node(7, [100, 100], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000.1, 2000.2] });

  assert.equal(groupBoxIsAt(g, 1000.1, 2000.2), true, "the box is where Float32 storage can put it");
  assert.equal(out.moved.nodes, 1);
  assert.deepEqual(a.pos, [1100.1, 2100.2], "the member moved by the exact delta");
});

test("moveGroupMembers reports moved vs stuck instead of silently skipping", () => {
  const ok = { id: 1, pos: [10, 10], size: [200, 100] };
  const noPos = { id: 2 };
  const res = moveGroupMembers([ok, null, noPos, { id: 3, pos: null }], 5, 7);
  assert.deepEqual(ok.pos, [15, 17]);
  assert.deepEqual(res.moved.map((n) => n.id), [1]);
  assert.deepEqual(res.stuck.map((n) => n.id), [2, 3], "an unmovable member is reported, never dropped silently");
  assert.doesNotThrow(() => moveGroupMembers(null, 1, 1));
});

test("translateGroupBoxes reports a box that would not move", () => {
  const ok = group(1, [0, 0, 100, 100]);
  const frozen = { id: 2, _bounding: Object.freeze([0, 0, 100, 100]) };
  const res = translateGroupBoxes([ok, frozen], 10, 10);
  assert.deepEqual(ok._bounding, [10, 10, 100, 100]);
  assert.deepEqual(res.moved.map((g) => g.id), [1]);
  assert.deepEqual(res.stuck.map((g) => g.id), [2]);
  assert.equal(translateGroupBox({ nonsense: true }, 1, 1), false, "a group with no bounds cannot be moved");
});


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
