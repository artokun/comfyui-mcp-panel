// Unit tests for LIVE geometric group membership (web/js/lib/group-geometry.js).
//
// Regression coverage for the group-membership bug cluster:
//   #312 pasted-then-grouped nodes report zero members (stale/empty _nodes)
//   #311 stale node_ids after creating/moving explicit group bounds
//   #287 node_ids stay stale after moving nodes inside a resized group
//   #305 create_group(node_ids) produces incorrect live membership
//   #297 create_group(node_ids) silently encloses unrelated nodes in dense layouts
//
// The core invariant: membership is recomputed from LIVE node + group geometry
// on every read, NEVER trusting the cached LGraphGroup._nodes array.
import test from "node:test";
import assert from "node:assert/strict";

import {
  nodeFocusBounds,
  boundsAroundNodes,
  groupBoundsOf,
  groupMemberNodes,
  classifyRequestedMembership,
  refreshNodeArea,
  syncNodeArea,
  syncGraphNodeAreas,
  moveGroupMembers,
} from "../../web/js/lib/group-geometry.js";

// Minimal fixtures. No boundingRect => nodeFocusBounds falls back to pos/size
// (with the title band), exactly like a fresh node on the live graph.
const node = (id, x, y, w = 300, h = 120) => ({ id, pos: [x, y], size: [w, h] });
const graphOf = (...nodes) => ({ _nodes: nodes });
// A group whose _nodes cache is deliberately WRONG/stale — the helper must ignore it.
const groupBox = (bounding, staleNodes = null) => ({
  _bounding: bounding,
  _nodes: staleNodes ?? [],
  recomputeInsideNodes() {
    /* simulate a frontend build that leaves _nodes empty/stale */
  },
});

test("create-around-specific-nodes yields exactly those members (#305)", () => {
  const a = node(1, 100, 100);
  const b = node(2, 100, 300);
  const graph = graphOf(a, b);
  const bbox = boundsAroundNodes([a, b]);
  const g = groupBox(bbox);
  const ids = groupMemberNodes(graph, g).map((n) => n.id);
  assert.deepEqual(ids.sort(), [1, 2]);
});

test("pasted-then-grouped nodes are counted despite empty _nodes cache (#312)", () => {
  // Bounds + node positions taken straight from issue #312.
  const nodes = [
    node(10, 550, 60, 350, 140),
    node(11, 550, 250, 350, 140),
    node(12, 930, 60, 341, 118),
    node(13, 930, 250, 341, 118),
  ];
  const graph = graphOf(...nodes);
  const g = groupBox([520, -10, 781, 430], /* stale */ []);
  const members = groupMemberNodes(graph, g);
  assert.equal(members.length, 4, "all four pasted nodes must be members");
  assert.deepEqual(members.map((n) => n.id).sort(), [10, 11, 12, 13]);
});

test("moving a node OUT of the group updates membership (#287/#311)", () => {
  const a = node(1, 200, 200);
  const b = node(2, 250, 400);
  const graph = graphOf(a, b);
  const g = groupBox([140, -80, 680, 1200], /* stale, still lists both */ [a, b]);
  assert.equal(groupMemberNodes(graph, g).length, 2);

  // Move b far outside the box — live recompute must drop it.
  b.pos = [5000, 5000];
  const ids = groupMemberNodes(graph, g).map((n) => n.id);
  assert.deepEqual(ids, [1], "node moved out is no longer a member");
});

test("moving a node INTO a resized group updates membership (#287)", () => {
  // Group starts small with 2 members; a 3rd node lives outside.
  const a = node(33, 200, 0);
  const b = node(49, 200, 200);
  const c = node(62, 200, 1000, 400, 200);
  const graph = graphOf(a, b, c);
  const small = groupBox([140, -80, 680, 400], [a, b]);
  assert.deepEqual(
    groupMemberNodes(graph, small).map((n) => n.id).sort(),
    [33, 49],
    "c is outside the small box",
  );

  // Resize the group to enclose c (issue #287 expanded [140,-80,800,1600]).
  const resized = groupBox([140, -80, 800, 1600], /* stale cache still 2 */ [a, b]);
  const ids = groupMemberNodes(graph, resized).map((n) => n.id).sort();
  assert.deepEqual(ids, [33, 49, 62], "resized group now includes the moved-in node");
});

test("dense-layout create surfaces unrelated captured nodes (#297)", () => {
  // Six intended nodes, but an unrelated node sits between them.
  const intended = [
    node(379, 0, 0),
    node(380, 0, 400),
    node(384, 0, 800),
  ];
  const unrelated = node(999, 20, 200); // physically inside the wrapping rect
  const graph = graphOf(intended[0], unrelated, intended[1], intended[2]);
  const bbox = boundsAroundNodes(intended);
  const g = groupBox(bbox);
  const memberIds = groupMemberNodes(graph, g).map((n) => n.id);
  assert.ok(memberIds.includes(999), "geometric membership DOES capture the neighbor");

  const cls = classifyRequestedMembership([379, 380, 384], memberIds);
  assert.deepEqual(cls.extra, [999], "the neighbor is reported as extra, not hidden");
  assert.deepEqual(cls.missing, [], "no requested node is missing");
});

test("classifyRequestedMembership reports missing requested nodes", () => {
  const cls = classifyRequestedMembership([1, 2, 3], [1, 3]);
  assert.deepEqual(cls.missing, [2]);
  assert.deepEqual(cls.extra, []);
});

test("classifyRequestedMembership matches number requests to string live ids (#566/#388)", () => {
  // Tool schema sends node_ids as numbers; live LiteGraph ids are strings. A raw
  // Set compare (9 !== "9") would put every id in BOTH extra and missing and fire
  // the geometric warning on every clean grouping. Type-normalized compare = clean.
  const cls = classifyRequestedMembership([9, 10], ["9", "10"]);
  assert.deepEqual(cls.extra, [], "no member is spuriously 'extra'");
  assert.deepEqual(cls.missing, [], "no requested id is spuriously 'missing'");
});

test("classifyRequestedMembership still flags genuine extra/missing across id types", () => {
  // Requested numbers; live string ids: one requested node absent, one neighbor captured.
  const cls = classifyRequestedMembership([9, 10, 11], ["9", "10", "999"]);
  assert.deepEqual(cls.extra, ["999"], "captured neighbor reported once, original string form");
  assert.deepEqual(cls.missing, [11], "absent requested node reported once, original number form");
});

test("syncNodeArea makes create-group membership include nodes with a stale rect (#391)", () => {
  // Node lives at [3400,0] but its cached boundingRect is stale at the origin
  // (loaded/rendered elsewhere). boundsAroundNodes uses pos/size → correct box,
  // but groupMemberNodes tests boundingRect-first → misses the node → empty group.
  const n = { id: 278, pos: [3400, 0], size: [300, 120], boundingRect: [0, -30, 300, 150] };
  const graph = graphOf(n);
  const bbox = boundsAroundNodes([n]); // box wraps the LIVE pos, far from origin
  const g = groupBox(bbox);

  // FAIL-BEFORE: stale rect (preferred by nodeFocusBounds) sits at the origin,
  // outside the box → node is wrongly excluded and the group looks empty.
  assert.deepEqual(
    groupMemberNodes(graph, g).map((x) => x.id),
    [],
    "stale boundingRect wrongly yields an empty group",
  );

  // PASS-AFTER: the create path syncs the cached rect to live pos/size first.
  syncNodeArea(n);
  assert.deepEqual(n.boundingRect, [3400, -30, 300, 150], "rect resynced to live pos/size");
  assert.deepEqual(
    groupMemberNodes(graph, g).map((x) => x.id),
    [278],
    "requested node is now a geometric member of its own box",
  );
});

test("syncNodeArea is a no-op without a cached rect and supports typed arrays", () => {
  const fresh = { id: 1, pos: [10, 10], size: [200, 100] };
  syncNodeArea(fresh);
  assert.equal(fresh.boundingRect, undefined, "nothing to sync when nodeFocusBounds uses live pos/size");
  syncNodeArea(null); // must not throw
  const typed = { id: 2, pos: [50, 60], size: [80, 40], boundingRect: Float32Array.from([0, 0, 1, 1]) };
  syncNodeArea(typed);
  assert.deepEqual([...typed.boundingRect], [50, 30, 80, 70], "typed-array rect resynced in place");
});

test("groupBoundsOf handles _bounding and pos/size, rejects garbage", () => {
  assert.deepEqual(groupBoundsOf({ _bounding: [1, 2, 3, 4] }), [1, 2, 3, 4]);
  assert.deepEqual(groupBoundsOf({ pos: [5, 6], size: [7, 8] }), [5, 6, 7, 8]);
  assert.equal(groupBoundsOf({ _bounding: [NaN, 0, 0, 0] }), null);
  assert.equal(groupBoundsOf({}), null);
});

test("groupMemberNodes returns [] for a group with no finite bounds", () => {
  assert.deepEqual(groupMemberNodes(graphOf(node(1, 0, 0)), {}), []);
});

test("nodeFocusBounds prefers boundingRect when present", () => {
  assert.deepEqual(nodeFocusBounds({ boundingRect: [10, 20, 30, 40] }), [10, 20, 30, 40]);
  // Fallback includes the title band above pos.
  assert.deepEqual(nodeFocusBounds({ pos: [0, 100], size: [200, 100] }), [0, 70, 200, 130]);
});

test("nodeFocusBounds accepts a typed-array boundingRect (current ComfyUI Rectangle)", () => {
  const br = Float32Array.from([1, 2, 3, 4]);
  assert.deepEqual(nodeFocusBounds({ boundingRect: br }), [1, 2, 3, 4]);
});

// ---- refreshNodeArea: keep boundingRect live after a programmatic move (#355) ----

test("stale boundingRect gives WRONG membership until refreshNodeArea (#355)", () => {
  // Node lived at [0,0]; its cached boundingRect reflects that old spot.
  const n = { id: 1, pos: [0, 0], size: [300, 120], boundingRect: [0, -30, 300, 150] };
  const graph = graphOf(n);
  // A group box far to the right — the node is NOT in it while at [0,0].
  const g = groupBox([400, 0, 300, 300]);
  assert.deepEqual(groupMemberNodes(graph, g).map((x) => x.id), [], "node starts outside");

  // Programmatic move INTO the group box, exactly like graph_move_node writes pos.
  const prev = [n.pos[0], n.pos[1]];
  n.pos = [450, 50];
  // FAIL-BEFORE: without refreshing, the stale boundingRect (which nodeFocusBounds
  // prefers) still says the node is at [0,-30] → membership misses it.
  assert.deepEqual(
    groupMemberNodes(graph, g).map((x) => x.id),
    [],
    "stale boundingRect wrongly excludes the moved-in node",
  );

  // PASS-AFTER: refresh translates the cached rect by the move delta.
  refreshNodeArea(n, prev);
  assert.deepEqual(n.boundingRect, [450, 20, 300, 150], "rect shifted by (+450,+50)");
  assert.deepEqual(
    groupMemberNodes(graph, g).map((x) => x.id),
    [1],
    "refreshed geometry now reports the node as a member",
  );
});

test("refreshNodeArea trusts the engine's own updateArea() recompute (#355)", () => {
  // A build whose updateArea() authoritatively recomputes boundingRect from pos.
  const n = {
    id: 7,
    pos: [1000, 1000],
    size: [200, 100],
    boundingRect: [0, -30, 200, 130],
    updateArea() {
      this.boundingRect = [this.pos[0], this.pos[1] - 30, this.size[0], this.size[1] + 30];
    },
  };
  refreshNodeArea(n, [0, 0]);
  // Engine moved the origin → refresh must NOT also apply the delta (no double-shift).
  assert.deepEqual(n.boundingRect, [1000, 970, 200, 130]);
});

test("refreshNodeArea is a no-op when there is no boundingRect to correct (#355)", () => {
  // No boundingRect → nodeFocusBounds already uses fresh pos/size; nothing to do.
  const n = { id: 9, pos: [10, 10], size: [200, 100] };
  refreshNodeArea(n, [0, 0]);
  assert.equal(n.boundingRect, undefined);
  // Guard against throwing on odd inputs.
  refreshNodeArea(null, [0, 0]);
  refreshNodeArea(n, undefined);
});

test("refreshNodeArea supports a typed-array boundingRect (ComfyUI Rectangle)", () => {
  const n = { id: 3, pos: [100, 200], size: [80, 40], boundingRect: Float32Array.from([0, 0, 80, 70]) };
  refreshNodeArea(n, [0, 0]);
  assert.deepEqual([...n.boundingRect], [100, 200, 80, 70], "typed-array origin shifted in place");
});

// ---- syncNodeArea collapse guard + syncGraphNodeAreas: bounds-create live geometry (#416) ----

test("syncNodeArea leaves an UNREQUESTED collapsed node's cached rect untouched (#416)", () => {
  // A collapsed node's real footprint is a small title pill; overwriting it with
  // the full pos/size footprint would overstate its area and risk pulling it into
  // a nearby group box on a bulk (sync-all) bounds/query read. Default = skip it.
  const collapsed = {
    id: 5,
    pos: [1000, 1000],
    size: [300, 200],
    flags: { collapsed: true },
    boundingRect: [1000, 970, 120, 30], // small title-only pill
  };
  syncNodeArea(collapsed);
  assert.deepEqual([...collapsed.boundingRect], [1000, 970, 120, 30], "collapsed rect preserved by default");
});

test("syncNodeArea(node, true) FORCE-syncs a REQUESTED collapsed node into its own box (#391)", () => {
  // A collapsed node the caller explicitly asked to group: its box is built around
  // the full pos/size, so its stale pill rect must be resynced to the full footprint
  // to be a member — otherwise create-by-node_ids silently drops a requested node.
  const n = {
    id: 8,
    pos: [3400, 0],
    size: [300, 120],
    flags: { collapsed: true },
    boundingRect: [0, -30, 120, 30], // stale pill at the origin
  };
  const graph = graphOf(n);
  const g = groupBox(boundsAroundNodes([n])); // box wraps the LIVE full footprint
  assert.deepEqual(groupMemberNodes(graph, g).map((x) => x.id), [], "stale pill excludes it");
  syncNodeArea(n, true);
  assert.deepEqual([...n.boundingRect], [3400, -30, 300, 150], "forced to full live footprint");
  assert.deepEqual(groupMemberNodes(graph, g).map((x) => x.id), [8], "requested collapsed node included");
});

test("syncGraphNodeAreas resyncs stale rects so bounds membership is LIVE (#416)", () => {
  // Reproduce #416: nodes were moved (e.g. via paste / a path that didn't refresh
  // the rect) so their cached boundingRect still describes the OLD spot. Creating a
  // group by bounds around the LIVE positions then returns the wrong node_ids: it
  // captures a node that has moved AWAY and misses one that is now inside.
  const inside = { id: 27, pos: [0, 60], size: [300, 120], boundingRect: [360, 30, 300, 150] }; // stale-far
  const outside = { id: 4, pos: [360, 60], size: [300, 120], boundingRect: [0, 30, 300, 150] }; // stale-near
  const graph = graphOf(inside, outside);
  const g = groupBox([-50, 0, 325, 360]); // x:[-50,275] — wraps LIVE 27, excludes LIVE 4

  // FAIL-BEFORE: stale rects invert membership → returns [4] (moved-away) not [27].
  assert.deepEqual(
    groupMemberNodes(graph, g).map((n) => n.id).sort(),
    [4],
    "stale cached rects yield the wrong node_ids",
  );

  // PASS-AFTER: resync all rects to live pos/size → membership reflects the layout.
  syncGraphNodeAreas(graph);
  assert.deepEqual(
    groupMemberNodes(graph, g).map((n) => n.id).sort(),
    [27],
    "live geometry returns exactly the enclosed node",
  );
});

test("syncGraphNodeAreas tolerates a missing/empty graph", () => {
  syncGraphNodeAreas(null); // must not throw
  syncGraphNodeAreas({}); // no _nodes
  syncGraphNodeAreas(graphOf()); // empty
});

// ---- moveGroupMembers: move box + members together, keep rects live (#408) ----

test("moveGroupMembers translates members AND keeps membership live at the new box (#408)", () => {
  // A group with two members; move the whole group by a delta. Without refreshing
  // the cached rect the members "stay behind" for the very next membership read.
  const a = { id: 1, pos: [200, 200], size: [300, 120], boundingRect: [200, 170, 300, 150] };
  const b = { id: 2, pos: [200, 400], size: [300, 120], boundingRect: [200, 370, 300, 150] };
  const graph = graphOf(a, b);
  const oldBox = [140, 120, 500, 480]; // wraps both at their start
  assert.deepEqual(groupMemberNodes(graph, groupBox(oldBox)).map((n) => n.id).sort(), [1, 2]);

  const dx = 1000;
  const dy = 500;
  moveGroupMembers([a, b], dx, dy);

  // Nodes AND their cached rects both shifted by the delta.
  assert.deepEqual(a.pos, [1200, 700]);
  assert.deepEqual([...a.boundingRect], [1200, 670, 300, 150], "rect shifted with pos");
  assert.deepEqual(b.pos, [1200, 900]);

  // The moved box (old box + same delta) still encloses both members...
  const newBox = [oldBox[0] + dx, oldBox[1] + dy, oldBox[2], oldBox[3]];
  assert.deepEqual(
    groupMemberNodes(graph, groupBox(newBox)).map((n) => n.id).sort(),
    [1, 2],
    "members travel with the box (no stale membership)",
  );
  // ...and they are NO LONGER inside the old box position.
  assert.deepEqual(
    groupMemberNodes(graph, groupBox(oldBox)).map((n) => n.id),
    [],
    "nothing left behind at the old box location",
  );
});

test("moveGroupMembers skips nodes without a usable pos and never throws", () => {
  const ok = { id: 1, pos: [10, 10], size: [200, 100] };
  moveGroupMembers([ok, null, { id: 2 }, { id: 3, pos: null }], 5, 7);
  assert.deepEqual(ok.pos, [15, 17], "valid member moved");
  moveGroupMembers(null, 1, 1); // must not throw
});

test("membership overlap is edge-inclusive (matches LiteGraph overlapBounding)", () => {
  // Node's right edge exactly touches the group's left edge.
  const n = { id: 1, boundingRect: [0, 0, 100, 100] }; // spans x:0..100
  const graph = graphOf(n);
  const g = groupBox([100, 0, 200, 200]); // starts exactly at x=100
  assert.deepEqual(
    groupMemberNodes(graph, g).map((x) => x.id),
    [1],
    "edge contact counts as membership",
  );
});
