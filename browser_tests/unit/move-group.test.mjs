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
  rerouteWriteIsSound,
  describeItems,
  describeThrown,
  describeItem,
  syncNodeArea,
  refreshNodeArea,
} from "../../web/js/lib/group-geometry.js";
import { clipOutlineTitle } from "../../web/js/lib/graph-read.js";

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
const preflightUndoSrc = grab(/\nfunction describePreflightUndo\(unrestored\) \{[\s\S]*?\n\}/, "describePreflightUndo");
const moveGroupSrc = grab(/ {2}graph_move_group\(\{ group_id, pos, move_nodes \}\) \{[\s\S]*?\n {2}\},/, "graph_move_group");
// #614 gave summarizeGroup two new module-scope dependencies (the title clip and the
// member-id cap). The harness rebuilds that scope by hand, so anything summarizeGroup
// closes over has to be handed in explicitly — otherwise the extracted source throws
// ReferenceError, the handler's own error net swallows it, and every assertion here
// fails against an error reply instead of the behaviour it means to pin. Read the cap
// OUT of the shipped source rather than restating it, so a change to the shipped value
// cannot leave these tests passing against a number the panel no longer uses.
const GROUP_NODE_IDS_CAP = Number(
  grab(/\nconst GROUP_NODE_IDS_CAP = (\d+);/, "GROUP_NODE_IDS_CAP").match(/(\d+)/)[1],
);
const moveGroupLabelSrc = grab(/ {4}case "graph_move_group": \{[\s\S]*?\n {4}\}/, 'the graph_move_group activity label');

/** The real shipped handler, wired to the real shipped geometry lib.
 *
 *  `"use strict"` is NOT decoration: comfyui-mcp-panel.js is an ES module, so the
 *  shipped code runs strict, where a write to a frozen array or a setter-less
 *  accessor THROWS instead of silently doing nothing. A `new Function` body is
 *  sloppy by default, so without this the harness would exercise a more forgiving
 *  language than the one the panel actually runs in — and every "unwritable
 *  geometry" test below would be testing the wrong thing. */
function realMoveGroup(graph, overrides = {}) {
  const getGraphCtx = () => ({ graph });
  // `overrides` swaps a single injected dependency for a double. It exists for
  // ONE purpose: the mutation-phase catch is unreachable while the movers are
  // total, so the only way to exercise what that net actually DOES — rather than
  // assert on its source text — is to hand the real handler a mover that throws.
  const dep = (name, real) => (name in overrides ? overrides[name] : real);
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
    "rerouteWriteIsSound",
    "groupBoxIsAt",
    "describeItems",
    "describeThrown",
    "syncNodeArea",
    "clipOutlineTitle",
    "GROUP_NODE_IDS_CAP",
    `"use strict";
     ${resolveGroupSrc}
     ${setGroupBoundsSrc}
     ${summarizeGroupSrc}
     ${preflightUndoSrc}
     const executors = { ${moveGroupSrc} };
     return executors.graph_move_group;`,
  )(
    getGraphCtx,
    groupBoundsOf,
    dep("syncGraphNodeAreas", syncGraphNodeAreas),
    groupMemberNodes,
    nestedGroupsOf,
    reroutesInside,
    dep("moveGroupMembers", moveGroupMembers),
    dep("translateGroupBoxes", translateGroupBoxes),
    dep("moveReroutePoints", moveReroutePoints),
    rerouteWriteIsSound,
    groupBoxIsAt,
    describeItems,
    describeThrown,
    syncNodeArea,
    clipOutlineTitle,
    GROUP_NODE_IDS_CAP,
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

/** A reroute shaped like @comfyorg/litegraph's: `pos` is a get/set pair on the
 *  PROTOTYPE over the reroute's own Float64Array, and the setter is where the
 *  build's layout/persistence bookkeeping lives. `store` records every write the
 *  engine's own path would persist. */
function reroutePrototype(store) {
  return {
    get pos() { return this._p; },
    set pos(v) {
      this._p[0] = Number(v[0]);
      this._p[1] = Number(v[1]);
      store.push([Number(v[0]), Number(v[1])]);
    },
  };
}

function reroute(id, [x, y], { store = [], extra = {} } = {}) {
  const r = Object.assign(Object.create(reroutePrototype(store)), {
    id,
    _p: new Float64Array([x, y]),
    ...extra,
  });
  return { r, store };
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

test("#408: an ABSOLUTE reroute move() is never called, and the STORE ends correct", () => {
  // THE probe hazard. If move(x, y) is ABSOLUTE on this build and also writes the
  // persisted/reactive store, then "call move(dx, dy) and correct pos afterwards"
  // records the WRONG coordinate in the store, patches only the in-place array,
  // reports success — and the next render or save resurrects the wrong point.
  // You cannot learn an API's semantics by invoking it destructively, so we never
  // invoke it: the pos SETTER is the engine's own write path and needs no guess.
  const calls = [];
  const { r, store } = reroute(11, [100, 100], {
    extra: { move(x, y) { calls.push([x, y]); this._p[0] = Number(x); this._p[1] = Number(y); } },
  });
  const graph = makeGraph({ groups: [group(1, [0, 0, 400, 400])], reroutes: [r] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [100, 100] });

  assert.deepEqual(calls, [], "move() must never be invoked to discover what it means");
  assert.deepEqual([r.pos[0], r.pos[1]], [200, 200], "the point is where it should be");
  assert.deepEqual(
    store,
    [[200, 200]],
    "and the STORE — not just pos — recorded exactly the correct coordinate, once",
  );
  assert.equal(out.moved.reroutes, 1);
});

test("#408: an ABSOLUTE move() with a rollback still leaves the store correct, never a stale coordinate", () => {
  const calls = [];
  const { r, store } = reroute(11, [100, 100], {
    extra: { move(x, y) { calls.push([x, y]); this._p[0] = Number(x); this._p[1] = Number(y); } },
  });
  // A frozen member forces the refusal AFTER the reroute has moved.
  const stuckNode = { id: 8, size: [60, 40], boundingRect: [150, 120, 60, 70], get pos() { return Object.freeze([150, 150]); } };
  const graph = makeGraph({ nodes: [stuckNode], groups: [group(1, [0, 0, 400, 400])], reroutes: [r] });

  assert.throws(() => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }), /NOTHING was moved/);

  assert.deepEqual(calls, [], "not during the move, and not during the rollback either");
  assert.deepEqual([r.pos[0], r.pos[1]], [100, 100]);
  assert.deepEqual(
    store.at(-1),
    [100, 100],
    "the LAST thing the store recorded is the original coordinate — nothing stale survives a save",
  );
});

test("#408: a reroute we cannot reposition soundly is REFUSED up front, before anything moves", () => {
  // `pos` is a plain slot (no setter to carry the build's bookkeeping) and the
  // build exposes a move() whose meaning we cannot determine without calling it.
  // That is genuinely unknown, and the honest answer is a refusal — not a
  // coin-flip whose failure mode is a wrong coordinate at save time.
  const unsound = { id: 11, pos: [100, 100], move() { throw new Error("must never be called"); } };
  const a = node(7, [200, 200], [60, 40]);
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a], groups: [g], reroutes: [unsound] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /reroute 11.*does not let us determine without calling it.*NOTHING was moved.*move_nodes:false/s,
  );
  assert.deepEqual(a.pos, [200, 200], "and it is a PRE-FLIGHT refusal: not one node moved first");
  assert.deepEqual([unsound.pos[0], unsound.pos[1]], [100, 100]);
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
  assert.equal(graph.beforeCount, undefined, "no undo transaction was even opened");
});

test("#408: a plain-slot reroute with NO move() is still moved — the refusal is scoped to the unknown", () => {
  const plain = { id: 11, pos: [100, 100] };
  const graph = makeGraph({ groups: [group(1, [0, 0, 400, 400])], reroutes: [plain] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [100, 100] });

  assert.deepEqual([plain.pos[0], plain.pos[1]], [200, 200]);
  assert.equal(out.moved.reroutes, 1);
});

test("rerouteWriteIsSound: a pos setter is sound; a plain slot plus an uncharacterisable move() is not", () => {
  const { r } = reroute(11, [0, 0]);
  assert.equal(rerouteWriteIsSound(r), true, "accessor with a setter — the engine's own write path");
  const { r: withMove } = reroute(12, [0, 0], { extra: { move() {} } });
  assert.equal(rerouteWriteIsSound(withMove), true, "a setter wins even when move() also exists");
  assert.equal(rerouteWriteIsSound({ pos: [0, 0] }), true, "a plain slot with no move() is unambiguous");
  assert.equal(rerouteWriteIsSound({ pos: [0, 0], move() {} }), false, "plain slot + move() is UNKNOWN");
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

test("#408: a node whose pos SETTER carries side effects has that setter run", () => {
  // Current ComfyUI defines LGraphNode.pos as an accessor on the PROTOTYPE whose
  // setter also commits the move to the frontend's layout store. Poking the
  // underlying array directly would move the canvas and leave that store holding
  // the old coordinates — a success report over a half-applied move.
  const layoutStore = [];
  const proto = {
    get pos() { return this._geometry; },
    set pos(v) {
      this._geometry[0] = Number(v[0]);
      this._geometry[1] = Number(v[1]);
      layoutStore.push([Number(v[0]), Number(v[1])]);
    },
  };
  const a = Object.assign(Object.create(proto), {
    id: 7,
    size: [100, 100],
    boundingRect: [50, 20, 100, 130],
    _geometry: new Float64Array([50, 50]),
  });
  const container = a.pos;
  const graph = makeGraph({ nodes: [a], groups: [group(1, [0, 0, 200, 200])] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });

  assert.deepEqual(layoutStore, [[1050, 1050]], "the setter must have run exactly once, with the new position");
  assert.equal(a.pos, container, "and it must not have replaced the geometry container");
  assert.equal(out.moved.nodes, 1);
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

test("#408: a box write that lands the corner but mangles the SIZE is not a move", () => {
  // This build accepts x/y but rewrites the width. Verifying only the top-left
  // would call that a completed move and hand back a reshaped group.
  const quad = [0, 0, 400, 400];
  Object.defineProperty(quad, "2", {
    get() { return this._w ?? 400; },
    set() { this._w = 1; },
    configurable: true,
  });
  const g = { id: 1, title: "Reshaper", _bounding: quad };
  const a = node(7, [100, 100], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /the group box did not accept the new position/,
  );
  assert.deepEqual(a.pos, [100, 100], "the member is put back");
  assert.deepEqual([quad[0], quad[1]], [0, 0], "and the corner is put back");
});

test("#408: a NESTED box that would be reshaped by the move counts as stuck", () => {
  // Same hazard one level down: translating a child box must not resize it. If
  // the size does not survive the write, the child did not move — it mutated.
  const innerQuad = [50, 50, 100, 100];
  Object.defineProperty(innerQuad, "3", {
    get() { return this._h ?? 100; },
    set() { this._h = 5; },
    configurable: true,
  });
  // Nudge the height through the setter the way a reshaping build would.
  const inner = { id: 2, title: "Reshaping inner", _bounding: innerQuad };
  const outer = group(1, [0, 0, 400, 400], "Outer");
  const a = node(7, [200, 200], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [outer, inner] });
  // placeGroupBox writes only x/y; make the x write corrupt the height, which is
  // exactly the "landed the corner, changed the shape" case.
  Object.defineProperty(innerQuad, "0", {
    get() { return this._x ?? 50; },
    set(v) { this._x = v; this._h = 5; },
    configurable: true,
  });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /group 2.*(NOTHING was moved|PARTIALLY moved)/s,
  );
  assert.deepEqual(a.pos, [200, 200], "the member is put back");
  assert.deepEqual(outer._bounding, [0, 0, 400, 400], "and the outer box never moved");
});

test("#408: a node that SNAPS on the way out keeps a cached rect at its REAL position", () => {
  // The write misses its target (so the node is "stuck" and the move is refused)
  // but the node HAS relocated, and it refuses to go home. Its cached rect must
  // describe where it actually is — every membership read prefers that rect, so a
  // stale one would report the node as still inside the group it has left.
  const oneWaySnap = {
    id: 7,
    size: [60, 40],
    boundingRect: [100, 70, 60, 70],
    _p: [100, 100],
    get pos() { return [...this._p]; },
    set pos(v) {
      const x = Math.round(Number(v[0]) / 25) * 25;
      const y = Math.round(Number(v[1]) / 25) * 25;
      if (x === 100 && y === 100) return; // refuses to go home
      this._p = [x, y];
    },
  };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [oneWaySnap], groups: [g] });

  assert.throws(() => realMoveGroup(graph)({ group_id: 1, pos: [1013, 1013] }), /PARTIALLY moved/);

  assert.deepEqual(oneWaySnap._p, [1125, 1125], "precondition: it really did relocate and could not return");
  assert.deepEqual(
    [...oneWaySnap.boundingRect],
    [1125, 1095, 60, 70],
    "the cached rect must have followed it, not stayed at the old spot",
  );
  assert.deepEqual(
    groupMemberNodes(graph, g).map((n) => n.id),
    [],
    "and it must no longer read as a member of the group it left",
  );
});

// ---- collapsed members and the pre-flight invariant ------------------------

test("#408: a COLLAPSED member with a stale rect is moved, not silently left behind", () => {
  // Membership is rect-first and the bulk sync used to SKIP collapsed nodes, so a
  // collapsed node sitting inside the box while its cached rect claimed otherwise
  // was omitted from the move entirely — left behind, with the reply reporting it
  // had carried zero nodes.
  const collapsed = {
    id: 7,
    pos: [120, 120],
    size: [300, 200],
    flags: { collapsed: true },
    boundingRect: [-9999, -9999, 80, 30],
  };
  const graph = makeGraph({ nodes: [collapsed], groups: [group(1, [100, 60, 200, 200])] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1100, 1060] });

  assert.deepEqual(collapsed.pos, [1120, 1120], "the collapsed member travelled with the box");
  assert.equal(out.moved.nodes, 1, "and the reply says so instead of reporting an empty group");
  assert.deepEqual(out.group.node_ids, [7]);
});

test("#408: move_nodes:false does not report a STALE collapsed node as newly enclosed", () => {
  // The mirror image: its live position is far outside the box the caller is
  // moving to, but its cached rect claims it is inside.
  const collapsed = {
    id: 7,
    pos: [9000, 9000],
    size: [300, 200],
    flags: { collapsed: true },
    boundingRect: [1150, 1090, 80, 30], // stale: inside the DESTINATION box
  };
  const graph = makeGraph({ nodes: [collapsed], groups: [group(1, [0, 0, 200, 200])] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1100, 1060], move_nodes: false });

  assert.deepEqual(out.group.node_ids, [], "a node that is not there must not be reported as enclosed");
  assert.deepEqual(collapsed.pos, [9000, 9000]);
});

test("#408: a node whose cached rect cannot be resynced is refused BEFORE the box is written", () => {
  // The pre-flight resync is itself a write. It used to run in move_nodes:false
  // AFTER the box had already been moved: syncNodeArea threw on the frozen rect,
  // the box stayed at the requested position, and the caller got an unrelated
  // TypeError — not success, not "NOTHING was moved", not a stated partial.
  const frozenRect = {
    id: 7,
    pos: [50, 50],
    size: [100, 100],
    boundingRect: Object.freeze([0, 0, 1, 1]),
  };
  const g = group(1, [0, 0, 200, 200]);
  const graph = makeGraph({ nodes: [frozenRect], groups: [g] });

  for (const moveNodes of [true, false]) {
    assert.throws(
      () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000], move_nodes: moveNodes }),
      /node 7.*group membership cannot be determined.*NOTHING was moved/s,
      `move_nodes:${moveNodes}`,
    );
    assert.deepEqual(g._bounding, [0, 0, 200, 200], `the box must not have moved (move_nodes:${moveNodes})`);
    assert.deepEqual(frozenRect.pos, [50, 50]);
  }
  assert.equal(graph.beforeCount, undefined, "a pre-flight refusal opens no undo transaction");
});

test("#408: a COLLAPSED member with a frozen rect is refused up front, not moved-then-thrown", () => {
  // The precise leak: this node has a MUTABLE pos and a FROZEN boundingRect, and
  // being collapsed it used to slip past the bulk sync entirely. Its position
  // would be written successfully and refreshNodeArea would then throw on the
  // rect — from inside moveGroupMembers, before it returned, so the handler's
  // rollback never ran and the moved node leaked out under a raw TypeError.
  const collapsed = {
    id: 7,
    pos: [120, 120],
    size: [300, 200],
    flags: { collapsed: true },
    // Frozen AND stale, so the pre-flight resync cannot make it live.
    boundingRect: Object.freeze([-9999, -9999, 80, 30]),
  };
  const g = group(1, [100, 60, 200, 200]);
  const graph = makeGraph({ nodes: [collapsed], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1100, 1060] }),
    /node 7.*group membership cannot be determined.*NOTHING was moved/s,
  );
  assert.deepEqual(collapsed.pos, [120, 120], "the node must not have moved at all");
  assert.deepEqual(g._bounding, [100, 60, 200, 200]);
  assert.equal(graph.beforeCount, undefined, "and it is caught in pre-flight, before the transaction");
});

test("#408: a member that THROWS on read does not strand the ones already moved", () => {
  // If a mover threw partway it would never RETURN its undo, so everything it had
  // already moved would be unrecoverable — the handler's rollback cannot undo what
  // it was never handed. Containment is per item: a hostile accessor makes that
  // node stuck, and the whole move is refused with the others put back.
  const first = node(7, [50, 50], [60, 40]);
  const hostile = {
    id: 8,
    size: [60, 40],
    boundingRect: [100, 70, 60, 70],
    get pos() { throw new TypeError("node has been disposed"); },
  };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [first, hostile], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /node 8.*NOTHING was moved/s,
    "a raw TypeError must never be what the caller sees",
  );
  assert.deepEqual(first.pos, [50, 50], "the member moved before the hostile one must be back");
  assert.deepEqual([...first.boundingRect], [50, 20, 60, 70], "rect too");
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
});

test("#408: a member whose rect is already correct is NOT reported as unrestorable", () => {
  // A frozen rect that happens to describe the node exactly. The forward move
  // cannot take the rect along, so the node is stuck and the move is refused —
  // but the ROLLBACK puts the position back and the frozen rect is live again, so
  // this must read "NOTHING was moved", not an invented partial. The verdict is
  // whether the rect matches the node, not whether a delta-write happened.
  const collapsed = {
    id: 7,
    pos: [120, 120],
    size: [300, 200],
    flags: { collapsed: true },
    boundingRect: Object.freeze([120, 90, 80, 30]), // exactly the live pill
  };
  const g = group(1, [100, 60, 200, 200]);
  const graph = makeGraph({ nodes: [collapsed], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1100, 1060] }),
    /node 7.*NOTHING was moved/s,
  );
  assert.deepEqual(collapsed.pos, [120, 120]);
  assert.deepEqual(g._bounding, [100, 60, 200, 200]);
});

test("#408: a reroute that throws on read is stuck, not raised, and not silently skipped", () => {
  const hostileReroute = { id: 11, get pos() { throw new TypeError("gone"); } };
  const g = group(1, [0, 0, 400, 400]);
  const a = node(7, [50, 50], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [g], reroutes: [hostileReroute] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /would not accept a new position \(reroute 11\).*NOTHING was moved/s,
  );
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
  assert.deepEqual(a.pos, [50, 50]);
});

test("#408: a NESTED box that throws on read is stuck, not silently left behind", () => {
  // Unknown is not "outside". A box we cannot read might be inside this one, and
  // moving the group away from it while reporting success is the #408 shape.
  const hostileGroup = { id: 2, get _bounding() { throw new TypeError("gone"); } };
  const g = group(1, [0, 0, 400, 400]);
  const a = node(7, [50, 50], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [g, hostileGroup] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /would not accept a new position \(group 2\).*NOTHING was moved/s,
  );
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
  assert.deepEqual(a.pos, [50, 50], "and the member is back");
});

test("#408: an accessor that misbehaves only AFTER the resync still yields a stated refusal", () => {
  // The pre-flight resync reconciles rects, then membership/nesting/reroutes are
  // read. An accessor that behaves for the first pass and throws on the second is
  // the one way a bare TypeError could still reach the caller. Nothing has been
  // repositioned at that point, so the honest answer is a refusal that says so.
  let reads = 0;
  const flaky = {
    id: 7,
    size: [60, 40],
    // No cached rect, so the resync reads pos twice and returns clean, and the
    // membership pass is the next thing to touch it.
    _p: [50, 50],
    get pos() {
      reads += 1;
      if (reads > 2) throw new TypeError("disposed mid-read");
      return this._p;
    },
  };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [flaky], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /disposed mid-read.*cannot be determined.*NOTHING was moved/s,
  );
  assert.deepEqual(flaky._p, [50, 50]);
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
  assert.equal(graph.beforeCount, undefined, "and no undo transaction was opened");
});

test("#408: a node with NO cached rect and a hostile pos is caught by the readability pre-flight", () => {
  // syncNodeArea used to return early when there was no rect to write, without
  // ever touching pos — so this node sailed through the pre-flight and raised a
  // bare TypeError out of groupMemberNodes instead of a stated refusal.
  const hostile = { id: 7, size: [60, 40], get pos() { throw new TypeError("disposed"); } };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [hostile], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /node 7.*group membership cannot be determined.*NOTHING was moved/s,
  );
  assert.equal(graph.beforeCount, undefined);
});

// ---- the guards are themselves operations that can fail --------------------

test("#408: a pre-flight refusal ROLLS BACK the rects it already reconciled", () => {
  // The resync is a write. Node A's stale rect accepts the reconciliation, node
  // B's rejects it — and the reply says NOTHING was moved. That claim is only
  // true if A's cached geometry went back exactly as it was found.
  const a = { id: 7, pos: [500, 500], size: [100, 100], boundingRect: [-9, -9, 1, 1] };
  const b = { id: 8, pos: [10, 10], size: [100, 100], boundingRect: Object.freeze([-9, -9, 1, 1]) };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a, b], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /node 8.*group membership cannot be determined.*NOTHING was moved/s,
  );
  assert.deepEqual(
    [...a.boundingRect],
    [-9, -9, 1, 1],
    "the rect the pre-flight had already rewritten must be back — 'NOTHING was moved' has to be true",
  );
  assert.deepEqual(a.pos, [500, 500]);
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
});

test("#408: when a reconciled rect CANNOT be put back, the refusal says so instead of 'NOTHING'", () => {
  // A rect that accepts the forward reconciliation and then refuses the restore.
  // Claiming "NOTHING was moved" over it would be the fabrication this whole
  // path exists to prevent.
  const live = [-9, -9, 1, 1];
  // The pre-flight reads this rect twice (capture, then sync) and the undo reads
  // it a third time; from then on it is unwritable.
  let reads = 0;
  const oneWay = {
    id: 7,
    pos: [500, 500],
    size: [100, 100],
    get boundingRect() {
      reads += 1;
      return reads > 2 ? Object.freeze([...live]) : live;
    },
  };
  const blocker = { id: 8, pos: [10, 10], size: [100, 100], boundingRect: Object.freeze([-9, -9, 1, 1]) };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [oneWay, blocker], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /cached rect\(s\) could NOT be put back \(node 7\).*panel_query_graph/s,
  );
  assert.deepEqual(live, [500, 470, 100, 130], "it really is still holding the reconciled value");
});

test("#408: a summary that throws AFTER the move reports a COMPLETED move, not a failure", () => {
  // Reporting happens after the last geometry write. Re-raising there would tell
  // the caller a completed move failed — and an agent that retries would move the
  // group twice.
  const a = node(7, [50, 50], [60, 40]);
  const g = group(1, [0, 0, 400, 400]);
  let moved = false;
  Object.defineProperty(g, "title", {
    get() { if (moved) throw new TypeError("group detached during summary"); return "G1"; },
    configurable: true,
  });
  const graph = makeGraph({ nodes: [a], groups: [g] });

  let out;
  assert.doesNotThrow(() => {
    moved = true;
    out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });
  });
  assert.deepEqual(a.pos, [1050, 1050], "the move really did complete");
  assert.equal(out.moved.nodes, 1, "and the reply still reports what it carried");
  assert.match(out.summary_unavailable, /move COMPLETED.*do NOT re-issue the move/s);
  assert.equal(out.group, undefined, "no fabricated summary stands in for the one that failed");
});

test("#408: a throwing afterChange cannot turn a completed move into a raw failure", () => {
  const a = node(7, [50, 50], [60, 40]);
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a], groups: [g] });
  graph.afterChange = () => { throw new TypeError("undo stack detached"); };
  graph.setDirtyCanvas = () => { throw new TypeError("no canvas"); };

  let out;
  assert.doesNotThrow(() => { out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }); });
  assert.deepEqual(a.pos, [1050, 1050]);
  assert.equal(out.moved.nodes, 1);
});

test("#408: a nested group with a MALFORMED _bounding but valid pos/size still moves", () => {
  // The validity rule has to reach the WRITE, not just the read. Picking
  // `_bounding` because it merely has length 4, then writing only x/y into it,
  // leaves it malformed — the read falls back to the untouched pos/size and a
  // movable nested group is reported as refusing to move.
  const inner = {
    id: 2,
    title: "Legacy inner",
    _bounding: ["x", "y", "w", "h"],
    pos: [50, 50],
    size: [100, 100],
  };
  const outer = group(1, [0, 0, 400, 400], "Outer");
  const a = node(7, [200, 200], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [outer, inner] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });

  assert.deepEqual(inner.pos, [1050, 1050], "written through the container the read comes back from");
  assert.deepEqual(inner.size, [100, 100], "and the size is untouched");
  assert.equal(out.moved.groups, 1);
});

test("#408: a reroute whose move() is a THROWING getter is refused, not raised", () => {
  // The refuse-by-inspection path is only as safe as inspection being safe:
  // `typeof r.move` RUNS the getter.
  const hostile = { id: 11, pos: [100, 100], get move() { throw new TypeError("gone"); } };
  const a = node(7, [50, 50], [60, 40]);
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a], groups: [g], reroutes: [hostile] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /reroute 11.*does not let us determine without calling it/s,
  );
  assert.deepEqual(a.pos, [50, 50]);
  assert.deepEqual([hostile.pos[0], hostile.pos[1]], [100, 100]);
});

// ---- roll back FIRST, format SECOND ----------------------------------------
// Every one of these puts a THROWING `id`/`title`/`message` on an item that the
// refusal path wants to NAME. Ids and titles exist only for display; nothing
// about restoring geometry needs them, so a message assembled over a dirty graph
// must never be what aborts the rollback.

/** A node whose geometry is perfectly ordinary but whose `id` cannot be read. */
function unnameableNode(pos, size, rect) {
  return {
    get id() { throw new TypeError("id is a revoked proxy"); },
    pos: [...pos],
    size: [...size],
    boundingRect: [...rect],
  };
}

test("#408 P0: a pre-flight refusal rolls back BEFORE naming the node that failed", () => {
  // A writable stale node A, then a frozen node B whose `id` getter throws.
  // Formatting B's name first would leave A's rect reconciled and emit a raw
  // TypeError instead of the refusal this path promises.
  const a = { id: 7, pos: [500, 500], size: [100, 100], boundingRect: [-9, -9, 1, 1] };
  const b = {
    get id() { throw new TypeError("id is a revoked proxy"); },
    pos: [10, 10],
    size: [100, 100],
    boundingRect: Object.freeze([-9, -9, 1, 1]),
  };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a, b], groups: [g] });

  let err = null;
  try {
    realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });
  } catch (error) {
    err = error;
  }
  assert.ok(err, "the move must be refused");
  assert.match(err.message, /refusing to move group 1/, "a stated refusal, not a raw TypeError");
  assert.match(err.message, /node unnamed/, "the unreadable id degrades to a placeholder");
  assert.match(err.message, /NOTHING was moved/);
  assert.deepEqual(
    [...a.boundingRect],
    [-9, -9, 1, 1],
    "and the rect the pre-flight had reconciled is back — the claim has to be true",
  );
});

test("#408 P0: the mutation-phase refusal rolls back BEFORE naming the stuck member", () => {
  // This member's setter CLAMPS (so it lands elsewhere and counts as stuck) and
  // its `id` throws. Building the name first left it displaced and threw raw.
  const clamped = {
    get id() { throw new TypeError("id is a revoked proxy"); },
    _p: [50, 50],
    size: [60, 40],
    boundingRect: [50, 20, 60, 70],
    get pos() { return [...this._p]; },
    set pos(v) { this._p = [Math.min(Number(v[0]), 200), Math.min(Number(v[1]), 200)]; },
  };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [clamped], groups: [g] });

  let err = null;
  try {
    realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });
  } catch (error) {
    err = error;
  }
  assert.ok(err);
  assert.match(err.message, /would not accept a new position \(node unnamed\)/);
  assert.match(err.message, /NOTHING was moved/);
  assert.deepEqual(clamped._p, [50, 50], "the clamped member is back where it started");
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
});

test("#408 P0: an UNRESTORABLE item with an unreadable id is named after the rollback, not during it", () => {
  // The rollback must deal in items, never in strings. This member accepts the
  // forward move and refuses to go home, so it lands in the UNRESTORED list — and
  // its `id` throws. Formatting names while walking the rollback would abort the
  // rollback itself, halfway through putting the rest of the group back.
  const oneWay = {
    get id() { throw new TypeError("id is a revoked proxy"); },
    _p: [50, 50],
    size: [60, 40],
    boundingRect: [50, 20, 60, 70],
    get pos() { return [...this._p]; },
    set pos(v) {
      if (Number(v[0]) === 50 && Number(v[1]) === 50) return; // refuses to go home
      this._p = [Number(v[0]), Number(v[1])];
    },
  };
  // A frozen sibling forces the refusal AFTER oneWay has already moved.
  const blocker = { id: 8, size: [60, 40], boundingRect: [150, 120, 60, 70], get pos() { return Object.freeze([150, 150]); } };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [oneWay, blocker], groups: [g] });

  let err = null;
  try {
    realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });
  } catch (error) {
    err = error;
  }
  assert.ok(err);
  assert.match(err.message, /PARTIALLY moved — 1 item\(s\) could NOT be put back \(node unnamed\)/);
  assert.deepEqual(g._bounding, [0, 0, 400, 400], "and the box the rollback also had to restore is back");
});

test("#408 P0: the box-write refusal names nothing until the children are back", () => {
  const unnameable = unnameableNode([50, 50], [60, 40], [50, 20, 60, 70]);
  const g = { id: 1, get title() { throw new TypeError("title is a revoked proxy"); }, _bounding: Object.freeze([0, 0, 400, 400]) };
  const graph = makeGraph({ nodes: [unnameable], groups: [g] });

  let err = null;
  try {
    realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });
  } catch (error) {
    err = error;
  }
  assert.ok(err);
  assert.match(err.message, /the group box did not accept the new position/);
  assert.deepEqual(unnameable.pos, [50, 50], "the member is back");
});

test("#408 P0 (the nastiest): a summary error whose OWN message throws still reports a COMPLETED move", () => {
  // The error path of the error path. summarizeGroup raises because `title`
  // throws; the resulting error's `message` getter throws too. Formatting the
  // fallback used to raise from inside the catch, so the caller saw a raw failure
  // for a move that COMPLETED — and re-issued it. That double move is precisely
  // what summary_unavailable exists to prevent.
  const hostileError = {
    get message() { throw new TypeError("message is a revoked proxy"); },
    get name() { throw new TypeError("name is a revoked proxy"); },
    toString() { throw new TypeError("toString is a revoked proxy"); },
    [Symbol.toPrimitive]() { throw new TypeError("coercion is a revoked proxy"); },
  };
  const a = node(7, [50, 50], [60, 40]);
  let movedYet = false;
  const g = {
    id: 1,
    _bounding: [0, 0, 400, 400],
    recomputeInsideNodes() {},
    get title() { if (movedYet) throw hostileError; return "G1"; },
  };
  const graph = makeGraph({ nodes: [a], groups: [g] });

  let out;
  assert.doesNotThrow(() => {
    movedYet = true;
    out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });
  }, "the completed move must not surface as a failure");

  assert.deepEqual(a.pos, [1050, 1050], "the move really did complete");
  assert.deepEqual(out.moved, { nodes: 1, groups: 0, reroutes: 0 }, "the caller still gets the counts");
  assert.match(out.summary_unavailable, /move COMPLETED/);
  assert.match(out.summary_unavailable, /do NOT re-issue the move/, "and the do-not-re-issue signal survives");
  assert.match(out.summary_unavailable, /could not be read/, "with an honest stand-in for the unreadable cause");
});

test("#408 P0: a beforeChange that throws rolls back the pre-flight's writes", () => {
  const a = { id: 7, pos: [500, 500], size: [100, 100], boundingRect: [-9, -9, 1, 1] };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a], groups: [g] });
  graph.beforeChange = () => { throw new TypeError("undo stack detached"); };

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /opening the undo transaction.*NOTHING was moved/s,
  );
  assert.deepEqual([...a.boundingRect], [-9, -9, 1, 1], "the reconciled rect is back");
  assert.deepEqual(a.pos, [500, 500]);
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
});

test("#408 P0: a node list that dies MID-WALK still yields a rollback, not a raw throw", () => {
  // Containing per item is not enough while the TRAVERSAL can throw: the walk can
  // die fetching the next entry after earlier rects are already reconciled, and a
  // sync that threw there would never return the undo those writes need.
  const a = { id: 7, pos: [500, 500], size: [100, 100], boundingRect: [-9, -9, 1, 1] };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [], groups: [g] });
  graph._nodes = {
    [Symbol.iterator]() {
      let i = 0;
      return {
        next() {
          i += 1;
          if (i === 1) return { value: a, done: false };
          throw new TypeError("node list detached mid-walk");
        },
      };
    },
  };

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /could not be walked to the end.*NOTHING was moved/s,
  );
  assert.deepEqual(
    [...a.boundingRect],
    [-9, -9, 1, 1],
    "the rect reconciled before the walk died is back",
  );
  assert.deepEqual(g._bounding, [0, 0, 400, 400]);
});

// ---- the transaction ends at SERIALIZATION, not at the last write ----------

test("#408 P0: a summary field whose toJSON throws still yields the completed counts, not a lost reply", () => {
  // summarizeGroup returns `color` UNCOERCED, so a value with a throwing toJSON
  // lets it succeed and then makes the bridge's JSON.stringify fail — after the
  // move, outside the guard, where the caller receives no success response at all
  // and re-issues. That is the double move summary_unavailable exists to prevent,
  // surviving one layer further out than the guard reached.
  //
  // This test used to aim at `title`. #614 put every title through
  // clipOutlineTitle, which does String(title ?? "") and so COERCES it long before
  // serialization — closing that particular hole as a side effect (pinned by the
  // next test). `color` is the field that is still handed through untouched, so the
  // invariant is re-aimed at it rather than retired: the point was never "titles
  // are dangerous", it is that the transaction is not over until the reply
  // serializes, and ANY uncoerced field can end it late.
  const a = node(7, [50, 50], [60, 40]);
  const hostileColor = {
    toJSON() { throw new TypeError("color toJSON is a revoked proxy"); },
    toString() { return "#333"; },
  };
  const g = {
    id: 1,
    title: "Fine",
    color: hostileColor,
    _bounding: [0, 0, 400, 400],
    recomputeInsideNodes() {},
  };
  const graph = makeGraph({ nodes: [a], groups: [g] });

  let out;
  assert.doesNotThrow(() => { out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }); });

  assert.deepEqual(a.pos, [1050, 1050], "the move really did complete");
  assert.deepEqual(out.moved, { nodes: 1, groups: 0, reroutes: 0 }, "the caller still gets the counts");
  assert.match(out.summary_unavailable, /move COMPLETED/);
  assert.match(out.summary_unavailable, /do NOT re-issue the move/);
  // And the whole reply must itself survive the boundary it is about to cross.
  assert.doesNotThrow(() => JSON.stringify(out), "the reply the bridge will serialize must be serializable");
});

test("#614: a title whose toJSON throws is COERCED, so it never degrades the reply", () => {
  // The guarantee #614 added, pinned so that removing the coercion is caught here
  // and not by a lost reply in production. A throwing toJSON on the title must not
  // reach JSON.stringify at all: clipOutlineTitle stringifies via toString first,
  // so this move keeps its FULL summary rather than falling back to
  // summary_unavailable. Asserting the degraded path is absent is the point — a
  // bare "the reply serializes" would pass either way.
  const a = node(7, [50, 50], [60, 40]);
  const hostileTitle = {
    toJSON() { throw new TypeError("title toJSON is a revoked proxy"); },
    toString() { return "Hostile"; },
  };
  const g = { id: 1, title: hostileTitle, _bounding: [0, 0, 400, 400], recomputeInsideNodes() {} };
  const graph = makeGraph({ nodes: [a], groups: [g] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });

  assert.equal(out.summary_unavailable, undefined, "the title no longer costs the caller its summary");
  assert.equal(out.group.title, "Hostile", "coerced through toString, not through toJSON");
  assert.deepEqual(out.moved, { nodes: 1, groups: 0, reroutes: 0 });
  assert.doesNotThrow(() => JSON.stringify(out));
});

test("#408 P0: a BigInt group_id on the FALLBACK path still yields a serializable completion reply", () => {
  // Prove the reply you RETURN, not a payload inside it. Round-tripping only the
  // inner `group` left the ENVELOPE free to carry something the bridge's
  // JSON.stringify chokes on — a caller-supplied BigInt group_id is enough. That
  // throws AFTER the move, outside every guard, so the caller receives no
  // completion reply at all and re-issues an already-completed move:
  // summary_unavailable bypassed one level further out.
  const a = node(7, [50, 50], [60, 40]);
  const g = {
    id: 1n, // BigInt: summarizeGroup will put it in the summary, stringify will refuse
    title: "Big",
    _bounding: [0, 0, 400, 400],
    recomputeInsideNodes() {},
  };
  const graph = makeGraph({ nodes: [a], groups: [g] });

  let out;
  assert.doesNotThrow(() => { out = realMoveGroup(graph)({ group_id: 1n, pos: [1000, 1000] }); });

  assert.deepEqual(a.pos, [1050, 1050], "the move really did complete");
  assert.deepEqual(out.moved, { nodes: 1, groups: 0, reroutes: 0 }, "the verified counts survive");
  assert.match(out.summary_unavailable, /move COMPLETED/);
  assert.match(out.summary_unavailable, /do NOT re-issue the move/, "the do-not-re-issue signal survives");
  assert.doesNotThrow(
    () => JSON.stringify(out),
    "the reply the bridge is about to serialize must itself be serializable",
  );
  assert.equal("group_id" in out, false, "the unserializable id is dropped rather than losing the whole reply");
});

test("#408: a serializable group_id is still reported on the fallback path", () => {
  // The degraded reply drops the id only when it has to; an ordinary id survives.
  // Aimed at `color` for the same reason as above: #614 coerces titles, so a hostile
  // title no longer reaches the fallback path this test is about.
  const hostileColor = { toJSON() { throw new TypeError("gone"); } };
  const a = node(7, [50, 50], [60, 40]);
  const g = {
    id: 1,
    title: "Fine",
    color: hostileColor,
    _bounding: [0, 0, 400, 400],
    recomputeInsideNodes() {},
  };
  const graph = makeGraph({ nodes: [a], groups: [g] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });

  assert.equal(out.group_id, 1);
  assert.match(out.summary_unavailable, /do NOT re-issue the move/);
  assert.doesNotThrow(() => JSON.stringify(out));
});

test("#408: an ordinary reply is plain JSON — round-tripped, not live engine references", () => {
  const a = node(7, [50, 50], [60, 40]);
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });

  assert.deepEqual(out.group.node_ids, [7]);
  assert.deepEqual(out.moved, { nodes: 1, groups: 0, reroutes: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out, "already plain");
});

// ---- both undos, and only what was recorded --------------------------------

test("#408 P0: the mutation-phase rollback also undoes the PRE-FLIGHT's rect writes", () => {
  // Node A carries a stale rect the pre-flight reconciles. Node B is frozen in
  // place so the move is refused. Rolling back only the mutation phase left A's
  // reconciled rect in place under a reply saying NOTHING was moved.
  const a = { id: 7, pos: [100, 100], size: [60, 40], boundingRect: [-9, -9, 1, 1] };
  const b = { id: 8, size: [60, 40], boundingRect: [150, 120, 60, 70], get pos() { return Object.freeze([150, 150]); } };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a, b], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /node 8.*NOTHING was moved/s,
  );
  assert.deepEqual(a.pos, [100, 100], "the member is back");
  assert.deepEqual(
    [...a.boundingRect],
    [-9, -9, 1, 1],
    "and the rect the PRE-FLIGHT reconciled is back too — there are two undos and this path owns both",
  );
});

test("#408 P0: move_nodes:false undoes the pre-flight when its box write fails", () => {
  const a = { id: 7, pos: [100, 100], size: [60, 40], boundingRect: [-9, -9, 1, 1] };
  const g = { id: 1, title: "Frozen", _bounding: Object.freeze([0, 0, 400, 400]) };
  const graph = makeGraph({ nodes: [a], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000], move_nodes: false }),
    /the group box did not accept the new position.*NOTHING was moved/s,
  );
  assert.deepEqual([...a.boundingRect], [-9, -9, 1, 1], "the pre-flight's write is taken back");
});

test("#408 P0: a node whose rect SNAPSHOT throws is never written to", () => {
  // You cannot undo what you never recorded. This rect's `[1]` getter throws once
  // — while the snapshot is being taken — and then accepts every write. Syncing it
  // anyway would reconcile it with no undo recorded, and a later refusal would say
  // NOTHING was moved over a node it has no way to put back.
  let reads = 0;
  const values = [-9, -9, 1, 1];
  const trapRect = {
    length: 4,
    get 0() { return values[0]; },
    set 0(v) { values[0] = v; },
    get 1() {
      reads += 1;
      if (reads === 1) throw new TypeError("rect read is a revoked proxy");
      return values[1];
    },
    set 1(v) { values[1] = v; },
    get 2() { return values[2]; },
    set 2(v) { values[2] = v; },
    get 3() { return values[3]; },
    set 3(v) { values[3] = v; },
  };
  const a = { id: 7, pos: [100, 100], size: [60, 40], boundingRect: trapRect };
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /node 7.*group membership cannot be determined.*NOTHING was moved/s,
  );
  assert.deepEqual(values, [-9, -9, 1, 1], "the rect it could not snapshot was never written");
  assert.deepEqual(a.pos, [100, 100]);
});

test("#408 P0: the target coordinates are read ONCE, before the first write", () => {
  // An array whose index 0 answers during validation and throws on a later read
  // used to pass pre-flight, move the members, and then raise before writeBox —
  // a new throwable operation performed after the first geometry write.
  let reads = 0;
  const hostilePos = [1000, 1000]; // a REAL array, so Array.isArray still holds
  Object.defineProperty(hostilePos, "0", {
    get() {
      reads += 1;
      if (reads > 1) throw new TypeError("pos read is a revoked proxy");
      return 1000;
    },
    configurable: true,
  });
  const a = node(7, [50, 50], [60, 40]);
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: hostilePos });

  assert.equal(reads, 1, "exactly one read of the target, taken before anything moved");
  assert.deepEqual(a.pos, [1050, 1050], "and the move completed from the value read then");
  assert.equal(out.moved.nodes, 1);
});

// ---- lib branches the handler tests above do not reach ---------------------

test("describeItem / describeItems are total where they are EXPORTED, not just in the happy path", () => {
  // The contract says total. `kind` is coerced by the template, and describeItems
  // calls slice / destructures entries / reads length — all on caller-supplied
  // values, all outside the original guard. A totality claim that holds for most
  // of a function is the class of comment this codebase keeps getting burned by.
  const hostileKind = { toString() { throw new TypeError("gone"); }, [Symbol.toPrimitive]() { throw new TypeError("gone"); } };
  let out;
  assert.doesNotThrow(() => { out = describeItem(hostileKind, { id: 1 }); });
  assert.equal(typeof out, "string");

  const hostilePairs = {
    get length() { throw new TypeError("gone"); },
    [Symbol.iterator]() { return [["node", { id: 1 }]][Symbol.iterator](); },
  };
  assert.doesNotThrow(() => { out = describeItems(hostilePairs); });
  assert.match(out, /node 1/);

  const noIterator = { length: 3 };
  assert.doesNotThrow(() => { out = describeItems(noIterator); });
  assert.equal(typeof out, "string");
  assert.doesNotThrow(() => describeItems(null));
});

test("describeItem / describeItems never throw, and degrade to a placeholder", () => {
  assert.equal(describeItem("node", { id: 7 }), "node 7");
  assert.equal(describeItem("node", {}), "node ?", "a missing id is not an error");
  assert.equal(describeItem("node", null), "node ?");
  assert.equal(describeItem("node", { get id() { throw new TypeError("gone"); } }), "node unnamed");
  assert.equal(
    describeItem("node", { id: { toString() { throw new TypeError("gone"); } } }),
    "node unnamed",
    "even the String() coercion is contained",
  );

  const many = Array.from({ length: 8 }, (_, i) => ["node", { id: i }]);
  assert.equal(describeItems(many), "node 0, node 1, node 2, node 3, node 4, …");
  assert.equal(describeItems([]), "");
  assert.doesNotThrow(() => describeItems([["node", { get id() { throw new Error("x"); } }]]));
});

test("describeThrown survives an error whose message AND coercion both throw", () => {
  assert.equal(describeThrown(new Error("plain")), "plain");
  assert.equal(describeThrown("a string"), "a string");
  assert.equal(describeThrown({ message: 42 }), "[object Object]", "a non-string message falls back to coercion");
  const hostile = {
    get message() { throw new TypeError("gone"); },
    toString() { throw new TypeError("gone"); },
    [Symbol.toPrimitive]() { throw new TypeError("gone"); },
  };
  assert.equal(describeThrown(hostile), "an error whose message could not be read");
});

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

test("groupBoxIsAt is total even when the accessor throws on its SECOND read", () => {
  // groupBoxIsAt reads the box twice: once through groupBoundsOf (already safe)
  // and once directly, for the Float32 check. It is the verification step of the
  // box write — running after the children have moved and before the rollback —
  // so a throw from that second read would escape the transaction through the
  // very check that exists to keep it honest. A first-read-throws fixture cannot
  // reach it: groupBoundsOf swallows that one and returns early.
  let reads = 0;
  const flaky = {
    get _bounding() {
      reads += 1;
      if (reads > 1) throw new TypeError("group detached mid-verification");
      return [0, 0, 10, 10];
    },
  };
  let result;
  assert.doesNotThrow(() => { result = groupBoxIsAt(flaky, 0, 0, 10, 10); });
  assert.equal(reads > 1, true, "precondition: the second read really was attempted");
  assert.equal(result, false, "cannot be shown to be there ⇒ treated as not there");

  const deadOnArrival = { get _bounding() { throw new TypeError("gone"); } };
  assert.doesNotThrow(() => { result = groupBoxIsAt(deadOnArrival, 0, 0, 10, 10); });
  assert.equal(result, false);
});

test("writePoint never throws — not even for a container it cannot inspect or read", () => {
  // hasSetter walks the prototype chain with getPrototypeOf/getOwnPropertyDescriptor,
  // and BOTH throw on a revoked Proxy — as does reading the property itself. A
  // write helper whose callers guard on its RETURN value must not raise instead.
  const { proxy, revoke } = Proxy.revocable({ pos: [0, 0] }, {});
  revoke();
  let result;
  assert.doesNotThrow(() => { result = writePoint(proxy, "pos", 10, 20); });
  assert.equal(result, false, "and it reports the honest verdict: the write did not land");

  const hostile = { get pos() { throw new TypeError("disposed"); } };
  assert.doesNotThrow(() => { result = writePoint(hostile, "pos", 10, 20); });
  assert.equal(result, false);
});

// ---- the mutation-phase net, driven for real -------------------------------
// This path is unreachable while the movers are total, so it used to be pinned
// only by a source-level assertion on its wording. That was not coverage of what
// it DOES. Injecting a throwing mover into the real handler drives it properly —
// and the behaviours below are the two ways it could have made things WORSE if it
// ever fired, not merely failed to help.

/** The real handler with a mover that mutates and then throws BEFORE returning
 *  its undo — the exact shape the net exists for. */
function moveGroupWithThrowingMover(graph, mutateBeforeThrowing) {
  return realMoveGroup(graph, {
    moveGroupMembers: (members, dx, dy) => {
      mutateBeforeThrowing(members, dx, dy);
      throw new TypeError("mover died before returning its undo");
    },
  });
}

test("#408: the net reports UNKNOWN — it never claims a restoration it could not make", () => {
  const a = node(7, [50, 50], [60, 40]);
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  let err = null;
  try {
    moveGroupWithThrowingMover(graph, (members, dx, dy) => {
      for (const n of members) n.pos = [n.pos[0] + dx, n.pos[1] + dy];
    })({ group_id: 1, pos: [1000, 1000] });
  } catch (error) {
    err = error;
  }
  assert.ok(err, "the move must be refused");
  assert.doesNotMatch(err.message, /NOTHING was moved/, "it cannot verify a rollback, so it must not assert one");
  assert.match(err.message, /UNKNOWN/);
  assert.match(err.message, /PARTIALLY moved/);
  assert.match(err.message, /Ctrl\+Z/);
});

test("#408: the STUCK-ITEMS refusal does not write a box the forward path never wrote", () => {
  // Same rule, reachable path. The stuck check fires BEFORE the box write, and
  // restoreBox() is a write: on a clamping setter it would displace a box nothing
  // had displaced. A rollback must not move what no forward path moved.
  const writes = [];
  const quad = [0, 0, 400, 400];
  Object.defineProperty(quad, "0", {
    get() { return this._x ?? 0; },
    set(v) { writes.push(v); this._x = Math.max(50, v); }, // a write MOVES it
    configurable: true,
  });
  const g = { id: 1, title: "Clamping", get _bounding() { return quad; } };
  // A frozen member makes the move refuse at the stuck check.
  const stuckNode = { id: 7, size: [60, 40], boundingRect: [100, 70, 60, 70], get pos() { return Object.freeze([100, 100]); } };
  const graph = makeGraph({ nodes: [stuckNode], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /would not accept a new position \(node 7\).*NOTHING was moved/s,
  );
  assert.deepEqual(writes, [], "no box write at all — neither forward nor in recovery");
  assert.equal(quad[0], 0);
});

/** A group whose `_bounding[0]` setter REJECTS its first assignment (leaving the
 *  box untouched) and CLAMPS every later one. "We attempted a write" is true for
 *  it while "the box changed" is false — the exact gap between intent and state. */
function rejectThenClampGroup(id = 1) {
  const quad = [0, 0, 400, 400];
  const assignments = [];
  Object.defineProperty(quad, "0", {
    get() { return this._x ?? 0; },
    set(v) {
      assignments.push(v);
      if (assignments.length === 1) throw new TypeError("first write rejected");
      this._x = Math.max(50, v); // clamps: any later write MOVES it
    },
    configurable: true,
  });
  return { g: { id, title: "RejectThenClamp", get _bounding() { return quad; } }, quad, assignments };
}

test("#408 P0: a box write REJECTED on its first attempt is not 'written' — the rollback must not move it", () => {
  // The forward write throws without changing anything, so the box is exactly
  // where it started. Gating the restore on "we attempted a write" would then
  // fire a recovery write into a clamping setter and displace an untouched box
  // (x: 0 → 50) — a refusal-time geometry mutation. State, not intent, decides.
  const { g, quad, assignments } = rejectThenClampGroup();
  const a = node(7, [100, 100], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] }),
    /the group box did not accept the new position.*NOTHING was moved/s,
  );
  assert.deepEqual(assignments, [1000], "exactly the one forward attempt — no recovery write");
  assert.equal(quad[0], 0, "the box is untouched; the rollback did not move it");
  assert.deepEqual(a.pos, [100, 100], "and the members are back");
});

test("#408 P0: the same, on the move_nodes:false branch", () => {
  const { g, quad, assignments } = rejectThenClampGroup();
  const graph = makeGraph({ nodes: [], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000], move_nodes: false }),
    /the group box did not accept the new position.*NOTHING was moved/s,
  );
  assert.deepEqual(assignments, [1000], "no recovery write on this branch either");
  assert.equal(quad[0], 0);
});

test("#408: a box whose CORNER is unchanged but whose SIZE was mangled is not 'as found'", () => {
  // The state check has to compare the whole quad. This build pins the corner
  // (any x/y write clamps back to 0) but mangles the width, so after the forward
  // write the corner matches the original while the size does not. A corner-only
  // check would call that "exactly as found", skip the restore, and report
  // NOTHING was moved over a group the user would find reshaped.
  const quad = [0, 0, 400, 400];
  Object.defineProperty(quad, "0", { get() { return 0; }, set() {}, configurable: true });
  Object.defineProperty(quad, "1", { get() { return 0; }, set() {}, configurable: true });
  Object.defineProperty(quad, "2", {
    get() { return this._w ?? 400; },
    set() { this._w = 1; },
    configurable: true,
  });
  const g = { id: 1, title: "PinnedCornerMangledSize", get _bounding() { return quad; } };
  const a = node(7, [100, 100], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  let err = null;
  try {
    realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });
  } catch (error) {
    err = error;
  }
  assert.ok(err);
  assert.equal(quad[2], 1, "precondition: the width really was mangled and cannot be repaired");
  assert.match(
    err.message,
    /PARTIALLY moved — 1 item\(s\) could NOT be put back \(group 1\)/,
    "the reshaped box must be reported, not waved through as 'NOTHING was moved'",
  );
  assert.deepEqual(a.pos, [100, 100], "the members are still back");
});

test("#408: a box that REALLY moved is still restored — the state check is not a blanket skip", () => {
  // The mirror of the above: when the forward write did change the box, the
  // restore must still run. Clamping to [0, 500] means the write lands somewhere
  // other than asked, so the move is refused and the box must go back to 0.
  const quad = [0, 0, 400, 400];
  Object.defineProperty(quad, "0", {
    get() { return this._x ?? 0; },
    set(v) { this._x = Math.max(0, Math.min(500, v)); },
    configurable: true,
  });
  const g = { id: 1, title: "Clamped", get _bounding() { return quad; } };
  const a = node(7, [100, 100], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  assert.throws(
    () => realMoveGroup(graph)({ group_id: 1, pos: [9000, 10] }),
    /the group box did not accept the new position.*NOTHING was moved/s,
  );
  assert.equal(quad[0], 0, "the box that really did move is put back");
  assert.deepEqual(a.pos, [100, 100]);
});

test("#408: the net does NOT write the group box, which no forward path had moved", () => {
  // The box write happens strictly AFTER the movers, so when this net fires
  // nothing has displaced the box. Calling restoreBox() anyway is a WRITE, and on
  // an effectful or clamping setter it can create a displacement of its own — a
  // rollback moving something no forward path moved.
  const writes = [];
  const quad = [0, 0, 400, 400];
  const g = {
    id: 1,
    title: "Clamping",
    get _bounding() { return quad; },
  };
  Object.defineProperty(quad, "0", {
    get() { return this._x ?? 0; },
    set(v) { writes.push(v); this._x = Math.max(50, v); }, // clamps: a write MOVES it
    configurable: true,
  });
  const a = node(7, [100, 100], [60, 40]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  assert.throws(
    () => moveGroupWithThrowingMover(graph, () => {})({ group_id: 1, pos: [1000, 1000] }),
    /UNKNOWN/,
  );
  assert.deepEqual(writes, [], "the recovery must not write a box the forward path never touched");
  assert.equal(quad[0], 0, "so the clamping setter never got the chance to displace it");
});

test("#408: when a LATER mover throws, the net still undoes the ones that completed", () => {
  // The nets's `unrestored` list is only meaningful for movers that already
  // ASSIGNED. moveGroupMembers completes here and translateGroupBoxes throws, so
  // the members' undo is real and must run — that is the half of the recovery the
  // net can actually do.
  const a = node(7, [50, 50], [60, 40]);
  const inner = group(2, [20, 20, 100, 100], "Inner");
  const outer = group(1, [0, 0, 400, 400], "Outer");
  const graph = makeGraph({ nodes: [a], groups: [outer, inner] });

  assert.throws(
    () =>
      realMoveGroup(graph, {
        translateGroupBoxes: () => { throw new TypeError("box mover died"); },
      })({ group_id: 1, pos: [1000, 1000] }),
    /UNKNOWN/,
  );
  assert.deepEqual(a.pos, [50, 50], "the members that DID move are put back");
  assert.deepEqual(outer._bounding, [0, 0, 400, 400], "and the box was never written");
});

test("#408: the net leaves rects describing where nodes ARE, not a replayed snapshot", () => {
  // The mover that threw may have changed `pos` without returning its undo.
  // Replaying the pre-flight rect snapshot over such a node recreates exactly the
  // stale-rect fabrication removed from the stranded-member path: a rect claiming
  // a position the node no longer holds, which reads as membership of a group it
  // has left. When the state is UNKNOWN, the truthful rect is the live one.
  const moved7 = node(7, [100, 100], [60, 40]);
  const g = group(1, [0, 0, 400, 400]);
  const graph = makeGraph({ nodes: [moved7], groups: [g] });

  assert.throws(
    () =>
      moveGroupWithThrowingMover(graph, (members) => {
        for (const n of members) n.pos = [5000, 5000]; // relocated, undo never returned
      })({ group_id: 1, pos: [1000, 1000] }),
    /UNKNOWN/,
  );
  assert.deepEqual(moved7.pos, [5000, 5000], "precondition: the mover really did relocate it");
  assert.deepEqual(
    [...moved7.boundingRect],
    [5000, 4970, 60, 70],
    "its cached rect must describe where it IS",
  );
  assert.deepEqual(
    groupMemberNodes(graph, g).map((n) => n.id),
    [],
    "and it must not read as a member of the group it has left",
  );
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

test("a mover NEVER throws out of its loop, so its undo is always returned", () => {
  // The contract the handler's rollback depends on. If a mover threw partway it
  // would never RETURN its undo, and everything it had already moved would be
  // unrecoverable — the caller cannot undo what it was never handed. (The handler
  // also gates hostile nodes in its pre-flight, so this exercises the mover's own
  // guarantee directly rather than through a path that shadows it.)
  const first = { id: 1, pos: [10, 10], size: [60, 40], boundingRect: [10, -20, 60, 70] };
  const hostile = { id: 2, get pos() { throw new TypeError("disposed"); } };
  const last = { id: 3, pos: [50, 50], size: [60, 40], boundingRect: [50, 20, 60, 70] };

  let res;
  assert.doesNotThrow(() => { res = moveGroupMembers([first, hostile, last], 100, 100); });
  assert.deepEqual(res.stuck.map((n) => n.id), [2], "the hostile member is stuck, not an exception");
  assert.deepEqual(res.moved.map((n) => n.id), [1, 3], "the others still moved");
  assert.deepEqual(first.pos, [110, 110]);
  assert.deepEqual(res.undo(), [], "and the undo it returned puts them all back");
  assert.deepEqual(first.pos, [10, 10]);
  assert.deepEqual(last.pos, [50, 50]);
});

test("moveReroutePoints and translateGroupBoxes never throw on a hostile item either", () => {
  const hostileReroute = { id: 1, get pos() { throw new TypeError("gone"); } };
  const okReroute = { id: 2, pos: [10, 10] };
  let rr;
  assert.doesNotThrow(() => { rr = moveReroutePoints([hostileReroute, okReroute], 5, 5); });
  assert.deepEqual(rr.stuck.map((r) => r.id), [1]);
  assert.deepEqual([okReroute.pos[0], okReroute.pos[1]], [15, 15]);
  assert.deepEqual(rr.undo(), []);
  assert.deepEqual([okReroute.pos[0], okReroute.pos[1]], [10, 10]);

  const hostileGroup = { id: 1, get _bounding() { throw new TypeError("gone"); } };
  const okGroup = group(2, [0, 0, 100, 100]);
  let gr;
  assert.doesNotThrow(() => { gr = translateGroupBoxes([hostileGroup, okGroup], 5, 5); });
  assert.deepEqual(gr.stuck.map((x) => x.id), [1]);
  assert.deepEqual(okGroup._bounding, [5, 5, 100, 100]);
  assert.deepEqual(gr.undo(), []);
  assert.deepEqual(okGroup._bounding, [0, 0, 100, 100]);
});

test("a rollback reports an unrestorable item rather than throwing over the refusal", () => {
  // restoreNodePositions runs while the caller is already composing an error. A
  // throw here would replace that carefully-worded refusal with a raw TypeError.
  let armed = false;
  const trap = {
    id: 1,
    _p: [10, 10],
    size: [60, 40],
    boundingRect: [10, -20, 60, 70],
    get pos() {
      if (armed) throw new TypeError("disposed between the move and the undo");
      return this._p;
    },
    set pos(v) { this._p = [Number(v[0]), Number(v[1])]; },
  };
  const res = moveGroupMembers([trap], 100, 100);
  assert.deepEqual(res.moved.map((n) => n.id), [1]);
  armed = true;
  let failures;
  assert.doesNotThrow(() => { failures = res.undo(); });
  assert.deepEqual(failures.map((n) => n.id), [1], "reported as unrestorable, which is the honest answer");
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

test("translateGroupBoxes.undo restores the SIZE too, not just the corner", () => {
  // A build that reshapes on reposition: putting only the corner back would leave
  // the box the wrong shape while the undo reported success.
  const quad = [0, 0, 100, 100];
  Object.defineProperty(quad, "0", {
    get() { return this._x ?? 0; },
    set(v) { this._x = v; this._h = 5; },
    configurable: true,
  });
  Object.defineProperty(quad, "3", {
    get() { return this._h ?? 100; },
    set(v) { this._h = v; },
    configurable: true,
  });
  const g = { id: 1, _bounding: quad };

  const res = translateGroupBoxes([g], 10, 10);
  assert.deepEqual(res.stuck.map((x) => x.id), [1], "reshaping the box is not moving it");
  assert.deepEqual(res.undo(), [], "and the undo puts the whole quad back");
  assert.deepEqual([quad[0], quad[1], quad[2], quad[3]], [0, 0, 100, 100]);
});


test("groupBoundsOf falls back on VALIDITY, not on _bounding being nullish", () => {
  // A present-but-malformed _bounding used to short-circuit the ?? and make a
  // group with perfectly good pos/size read as having no usable bounds — refused
  // as unmovable when it was nothing of the sort.
  assert.deepEqual(
    groupBoundsOf({ _bounding: ["x", "y", "w", "h"], pos: [10, 20], size: [300, 200] }),
    [10, 20, 300, 200],
    "malformed _bounding must not veto valid pos/size",
  );
  assert.deepEqual(
    groupBoundsOf({ _bounding: [1, 2], pos: [10, 20], size: [300, 200] }),
    [10, 20, 300, 200],
    "a half-length quad is not usable either",
  );
  assert.deepEqual(groupBoundsOf({ _bounding: [1, 2, 3, 4], pos: [9, 9], size: [9, 9] }), [1, 2, 3, 4],
    "a VALID _bounding still wins");
  assert.equal(groupBoundsOf({ _bounding: [NaN, 0, 0, 0] }), null, "and neither form usable ⇒ null");
  assert.equal(groupBoundsOf(null), null);
});

test("#408: a group whose _bounding is malformed but whose pos/size is valid still moves", () => {
  const g = { id: 1, title: "Legacy", _bounding: ["x", "y", "w", "h"], pos: [0, 0], size: [200, 200] };
  const a = node(7, [50, 50], [100, 100]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  const out = realMoveGroup(graph)({ group_id: 1, pos: [1000, 1000] });

  assert.deepEqual(a.pos, [1050, 1050], "the member moved by the delta from the usable bounds");
  assert.equal(out.moved.nodes, 1);
});

test("refreshNodeArea REPORTS an unwritable rect instead of throwing mid-move", () => {
  const frozen = { pos: [110, 110], boundingRect: Object.freeze([100, 70, 60, 70]) };
  let result;
  assert.doesNotThrow(() => { result = refreshNodeArea(frozen, [100, 100]); });
  assert.equal(result, false);
  // Its "never throws" contract has to cover the READS too — a disposed accessor
  // raises as readily on the way in as on the way out, and this runs mid-move
  // with the caller relying on a verdict rather than an exception.
  const unreadableRect = { pos: [110, 110], get boundingRect() { throw new TypeError("disposed"); } };
  assert.doesNotThrow(() => { result = refreshNodeArea(unreadableRect, [100, 100]); });
  assert.equal(result, false);
  const unreadablePos = { boundingRect: [100, 70, 60, 70], get pos() { throw new TypeError("disposed"); } };
  assert.doesNotThrow(() => { result = refreshNodeArea(unreadablePos, [100, 100]); });
  assert.equal(result, false);
  const ok = { pos: [110, 110], boundingRect: [100, 70, 60, 70] };
  assert.equal(refreshNodeArea(ok, [100, 100]), true);
  assert.deepEqual([...ok.boundingRect], [110, 80, 60, 70]);
  assert.equal(refreshNodeArea({ pos: [1, 1] }, [0, 0]), true, "no cached rect ⇒ nothing to keep in step");
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
  assert.deepEqual(reroutesInside({ reroutes: [hit] }, null), []);
  // A reroute with NO pos is not a positioned item — nothing to move, nothing to
  // be wrong about. A reroute WITH a pos that is not finite, or that cannot be
  // read at all, is INDETERMINATE: it must ride along so the move refuses rather
  // than quietly leaving it behind. "Could not determine" is not "outside".
  assert.deepEqual(reroutesInside({ reroutes: [{ id: 3 }] }, bounds), []);
  assert.deepEqual(
    reroutesInside({ reroutes: [{ id: 4, pos: [Number.NaN, 0] }] }, bounds).map((r) => r.id),
    [4],
  );
  assert.deepEqual(
    reroutesInside({ reroutes: [{ id: 5, get pos() { throw new TypeError("gone"); } }] }, bounds).map((r) => r.id),
    [5],
  );
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
