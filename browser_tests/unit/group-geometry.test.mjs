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
  nodeExtents,
  describeGroupMembershipGap,
  groupBoundsOf,
  groupMemberNodes,
  classifyRequestedMembership,
  refreshNodeArea,
  syncNodeArea,
  syncGraphNodeAreas,
  moveGroupMembers,
  holdGraphItemPositions,
  nodeAreaIsLive,
  nodeAreaOriginTracks,
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

test("syncNodeArea gives an UNREQUESTED collapsed node its PILL footprint, never the full box (#416)", () => {
  // #416's guarantee is that a collapsed node's area is never OVERSTATED: its real
  // footprint is a small title pill, and writing the full pos/size box could pull
  // it into a nearby group on a bulk bounds/query read. The original guard bought
  // that by SKIPPING the node — which left the rect stale, and membership is
  // rect-first, so a collapsed node could be omitted from the group it is sitting
  // in (left behind by a move, reported as zero moved) or reported as enclosed
  // when it is not. Writing the PILL keeps #416's guarantee and makes the rect live.
  const collapsed = {
    id: 5,
    pos: [1000, 1000],
    size: [300, 200],
    flags: { collapsed: true },
    boundingRect: [-9999, -9999, 120, 30], // stale pill, nowhere near the live pos
  };
  assert.equal(syncNodeArea(collapsed), true);
  assert.deepEqual([...collapsed.boundingRect], [1000, 970, 80, 30], "pill, tracking the LIVE pos");
  assert.notDeepEqual(
    [...collapsed.boundingRect],
    [1000, 970, 300, 230],
    "#416: never the full pos/size footprint",
  );
});

test("a collapsed node inside a group box is a MEMBER, not silently left behind (#416/#408)", () => {
  // The stale-rect case that used to be unreachable because the sync skipped it.
  const collapsed = {
    id: 5,
    pos: [120, 120],
    size: [300, 200],
    flags: { collapsed: true },
    boundingRect: [-9999, -9999, 80, 30], // stale: claims to be far outside the box
  };
  const graph = graphOf(collapsed);
  const g = groupBox([100, 60, 200, 200]);
  assert.deepEqual(groupMemberNodes(graph, g).map((n) => n.id), [], "stale rect hides it");
  syncGraphNodeAreas(graph);
  assert.deepEqual(
    groupMemberNodes(graph, g).map((n) => n.id),
    [5],
    "after the resync it reads as the member it visibly is",
  );
});

test("syncNodeArea rejects a non-finite or negative collapsed width (#416 area guarantee)", () => {
  // `Number(x) || 80` accepts Infinity and -1: both are truthy. An infinite pill
  // overstates the area without limit and makes the node a geometric member of
  // every group — the exact guarantee the pill was chosen to preserve.
  for (const bad of [Infinity, -Infinity, Number.NaN, -1, "wide", null, undefined, {}]) {
    const n = {
      id: 5,
      pos: [10, 40],
      size: [300, 200],
      flags: { collapsed: true },
      _collapsed_width: bad,
      boundingRect: [0, 0, 1, 1],
    };
    syncNodeArea(n);
    assert.deepEqual([...n.boundingRect], [10, 10, 80, 30], `_collapsed_width=${String(bad)} falls back to the pill`);
  }
});

test("syncNodeArea rejects a non-finite node SIZE too", () => {
  const n = { id: 5, pos: [10, 40], size: [Infinity, Number.NaN], boundingRect: [0, 0, 1, 1] };
  syncNodeArea(n);
  assert.deepEqual([...n.boundingRect], [10, 10, 200, 130], "an unusable extent falls back to the default");
});

test("syncNodeArea/nodeAreaIsLive refuse a node whose POSITION is not a finite point", () => {
  // Substituting [0, 0] would put a node with no knowable position into whatever
  // group happens to sit at the origin.
  const n = { id: 5, pos: [Number.NaN, 10], size: [100, 100], boundingRect: [0, 0, 1, 1] };
  assert.equal(syncNodeArea(n), false);
  assert.deepEqual([...n.boundingRect], [0, 0, 1, 1], "and it is left alone rather than given a made-up rect");
  assert.equal(nodeAreaIsLive(n), false);
});

test("syncNodeArea honours a node's own collapsed width when the build records one", () => {
  const collapsed = {
    id: 5,
    pos: [10, 40],
    size: [300, 200],
    flags: { collapsed: true },
    _collapsed_width: 142,
    boundingRect: [0, 0, 1, 1],
  };
  syncNodeArea(collapsed);
  assert.deepEqual([...collapsed.boundingRect], [10, 10, 142, 30]);
});

test("syncNodeArea REPORTS an unwritable rect instead of throwing", () => {
  // It runs inside a group move, after positions have been written. A throw here
  // would escape past the caller's rollback and leak a half-moved graph.
  const frozen = { id: 5, pos: [10, 10], size: [100, 100], boundingRect: Object.freeze([0, 0, 1, 1]) };
  let result;
  assert.doesNotThrow(() => { result = syncNodeArea(frozen); });
  assert.equal(result, false, "and it says so");
  const graph = { _nodes: [frozen, { id: 6, pos: [0, 0], size: [10, 10], boundingRect: [0, 0, 1, 1] }] };
  assert.deepEqual(
    syncGraphNodeAreas(graph).unsynced.map((n) => n.id),
    [5],
    "reported up to the caller as a pre-flight",
  );
});

test("syncGraphNodeAreas is TRANSACTIONAL: its undo puts every rect it touched back", () => {
  // The resync is a WRITE. Reconciling node A and then finding node B unwritable
  // must not leave A's cached geometry changed with no way back, under a caller
  // that goes on to report that nothing happened.
  const a = { id: 1, pos: [500, 500], size: [100, 100], boundingRect: [-9, -9, 1, 1] }; // stale, writable
  const b = { id: 2, pos: [10, 10], size: [100, 100], boundingRect: Object.freeze([-9, -9, 1, 1]) };
  const graph = { _nodes: [a, b] };

  const res = syncGraphNodeAreas(graph);
  assert.deepEqual(res.unsynced.map((n) => n.id), [2]);
  assert.deepEqual([...a.boundingRect], [500, 470, 100, 130], "A really was rewritten");

  assert.deepEqual(res.undo(), [], "and the undo reports nothing left displaced");
  assert.deepEqual([...a.boundingRect], [-9, -9, 1, 1], "A's cached rect is exactly as it was found");
});

test("syncGraphNodeAreas.undo reports a rect it could not put back", () => {
  let frozen = false;
  const rect = [0, 0, 1, 1];
  const n = {
    id: 1,
    pos: [500, 500],
    size: [100, 100],
    get boundingRect() { return frozen ? Object.freeze([...rect]) : rect; },
  };
  const res = syncGraphNodeAreas({ _nodes: [n] });
  assert.deepEqual(res.unsynced, []);
  frozen = true; // becomes unwritable between the sync and the undo
  assert.deepEqual(res.undo().map((x) => x.id), [1], "an unrestorable rect is named, not assumed");
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

// ---------------------------------------------------------------------------
// #497: membership must match LiteGraph's containsCentre rule (the group box
// contains the node bounding-box's CENTRE point), NOT a box OVERLAP. A node
// moved so its centre leaves the group is dropped even if an edge still pokes
// into the box — the "still reported as a member after moving it out" symptom.
// LiteGraph never recomputes group._nodes when a MEMBER node moves (only when
// the GROUP is created/moved/resized), so the panel recomputes live at read.
// ---------------------------------------------------------------------------
test("membership is centre-in-rect, not box overlap (#497)", () => {
  // Node spans x:0..100 (centre x=50). Group starts at x=60, so the two boxes
  // OVERLAP (x:60..100) but the node's centre (50) is OUTSIDE the box. The old
  // overlap rule wrongly counted this as a member; containsCentre does not.
  const n = { id: 1, boundingRect: [0, 0, 100, 100] }; // centre (50,50)
  const graph = graphOf(n);
  const overlapping = groupBox([60, 0, 200, 200]); // x:60..260 — overlaps but no centre
  assert.deepEqual(
    groupMemberNodes(graph, overlapping).map((x) => x.id),
    [],
    "a box that only overlaps (centre outside) is NOT a member",
  );
  // Same node, a box that actually contains its centre → member.
  const containing = groupBox([0, 0, 200, 200]); // x:0..200 contains centre (50,50)
  assert.deepEqual(
    groupMemberNodes(graph, containing).map((x) => x.id),
    [1],
    "a box containing the centre IS a member",
  );
});

test("centre-in-rect is min-edge inclusive, max-edge exclusive (matches isInRect) (#497)", () => {
  // Node centre lands EXACTLY on the group's min corner → inclusive (member).
  const onMin = { id: 1, boundingRect: [0, 0, 200, 200] }; // centre (100,100)
  assert.deepEqual(
    groupMemberNodes(graphOf(onMin), groupBox([100, 100, 300, 300])).map((n) => n.id),
    [1],
    "centre on the min edge (>=) counts as inside",
  );
  // Node centre lands EXACTLY on the group's RIGHT (x-max) edge → exclusive.
  const onMaxX = { id: 2, boundingRect: [50, 0, 100, 100] }; // centre (100,50)
  assert.deepEqual(
    groupMemberNodes(graphOf(onMaxX), groupBox([0, 0, 100, 100])).map((n) => n.id),
    [],
    "centre on the x-max edge (<) is excluded",
  );
  // Node centre lands EXACTLY on the group's BOTTOM (y-max) edge → exclusive. This
  // is an INDEPENDENT condition in isInRect; the box overlaps on both axes here, so
  // the old overlap rule would wrongly include it.
  const onMaxY = { id: 3, boundingRect: [0, 50, 100, 100] }; // centre (50,100)
  assert.deepEqual(
    groupMemberNodes(graphOf(onMaxY), groupBox([0, 0, 100, 100])).map((n) => n.id),
    [],
    "centre on the y-max edge (<) is excluded",
  );
});

test("a node moved OUT of a group by CENTRE stops being a member (#497)", () => {
  // The report's shape: a node whose box still OVERLAPS a nearby group but whose
  // CENTRE has moved out. The old edge-overlap rule reported it in every box its
  // edge touched (the #497 bug); containsCentre reports it only where its centre is.
  // Both panel_graph_outline and panel_edit_group (summarizeGroup) funnel through
  // groupMemberNodes, so this shared recompute keeps the two readers in agreement.
  const n = node(7, 600, 560, 287, 122); // focus bounds x600..887, centre ≈ (743.5, 606)
  const g3 = groupBox([560, 265, 360, 460]); // x560..920 — holds the centre
  // g4 OVERLAPS the node (x800..1100 vs node x600..887 → shared 800..887) but the
  // centre (743.5) is LEFT of it: old overlap = member (WRONG), containsCentre = no.
  const g4 = groupBox([800, 500, 300, 300]); // x800..1100 y500..800
  const graph = graphOf(n);
  const membersOf = (g) => groupMemberNodes(graph, g).map((x) => x.id);

  assert.deepEqual(membersOf(g4), [], "overlapping box WITHOUT the centre drops the node");
  assert.deepEqual(membersOf(g3), [7], "the box that holds the centre keeps it");

  // Move the node's centre INTO g4 → member there, and out of g3.
  n.pos = [850, 550]; // focus x850..1137, centre ≈ (993.5, 596) — inside g4, right of g3
  assert.deepEqual(membersOf(g4), [7], "moved-in node reported by live centre geometry");
  assert.deepEqual(membersOf(g3), [], "and no longer reported by the box it left");
});

test("membership follows a group's OWN moved bounds, not a stale cache (#497)", () => {
  // The dual of the node-move case: the NODE stays put and the GROUP box moves
  // (as panel_edit_group(bounds=…) / panel_move_group mutate g._bounding). The
  // live read must reflect the new box even though groupBox's recomputeInsideNodes
  // is a no-op that leaves the _nodes cache stale.
  const n = node(1, 600, 560, 200, 100); // focus bounds x600..800, centre (700, 595)
  const graph = graphOf(n);
  const g = groupBox([1000, 0, 300, 300]); // starts far from the node (x1000..1300)
  assert.deepEqual(groupMemberNodes(graph, g).map((x) => x.id), [], "node outside the group's start bounds");
  // Reposition the SAME group's box so it now covers the node's centre.
  g._bounding = [650, 500, 300, 200]; // x650..950 y500..700 — holds centre (700,595)
  assert.deepEqual(groupMemberNodes(graph, g).map((x) => x.id), [1], "moved group box gains the node by live geometry");
});

// ---------------------------------------------------------------------------
// #429: group-membership READ paths must resync live rects before computing
// membership. A node moved by a path the panel didn't own (paste/load/manual
// drag, or an older move that never refreshed the rect) leaves a STALE cached
// boundingRect; because nodeFocusBounds prefers boundingRect, a bounds-derived
// read (graph_outline / graph_query / edit_group / auto_layout) would report the
// PRE-move membership. syncGraphNodeAreas(graph) — which every membership read
// handler now runs first — makes the read reflect the CURRENT layout.
// ---------------------------------------------------------------------------
test("stale cached rect yields wrong members; syncGraphNodeAreas repairs the read (#429)", () => {
  // Five nodes were moved DOWN into a vertical column (pos updated), but their
  // cached rects still describe the pre-move positions — three of them stale
  // OUTSIDE the box the caller now wants, exactly the "reported only two" symptom.
  const mk = (id, x, y, staleY) => ({
    id,
    pos: [x, y],
    size: [200, 100],
    boundingRect: [x, staleY - 30, 200, 130], // rect frozen at the OLD y (staleY)
  });
  const a = mk(299, 100, 100, 100); // already correct (rect matches pos)
  const b = mk(300, 100, 260, 260); // already correct
  const c = mk(301, 100, 420, -900); // rect stale far above the box
  const d = mk(302, 100, 580, -900); // rect stale far above the box
  const e = mk(303, 100, 740, -900); // rect stale far above the box
  const graph = graphOf(a, b, c, d, e);

  // The box the caller built (boundsAroundNodes uses live pos/size) wraps all five.
  const box = boundsAroundNodes([a, b, c, d, e]);
  const g = groupBox(box);

  // BEFORE syncing: membership is computed against stale rects → only the two
  // whose rects already matched are inside. This is the reported bug.
  assert.deepEqual(
    groupMemberNodes(graph, g).map((n) => n.id).sort((x, y) => x - y),
    [299, 300],
    "stale rects report only the two un-moved members (the #429 symptom)",
  );

  // AFTER the resync every read handler now performs: all five are members.
  syncGraphNodeAreas(graph);
  assert.deepEqual(
    groupMemberNodes(graph, g).map((n) => n.id).sort((x, y) => x - y),
    [299, 300, 301, 302, 303],
    "post-sync membership reflects the live column layout — all five wrapped",
  );
});

// ---- #813: a RESTORED position is not an unrestorable node --------------------
//
// panel_move_group reported "The graph is PARTIALLY moved — N item(s) could NOT
// be put back" over a graph it had put back perfectly. restoreNodePosition
// returned `ok && nodeAreaIsLive(n)`, conflating two different questions: is the
// node back at its original COORDINATES (what a rollback promises), and does its
// CACHED RECT agree with its live footprint (a separate property that can be
// false for unrelated reasons — a frozen boundingRect, or one already stale
// before the move began).
//
// A false alarm about data loss is strictly worse than silence here: the caller
// is an agent that cannot press Ctrl+Z, so it is told the user's layout may be
// damaged when it is not.

test("#813 a node whose position restores EXACTLY is not reported unrestorable, even with an uncorrectable rect", () => {
  const n = { id: 24, pos: [100, 100], size: [225, 0], flags: { collapsed: true } };
  // A frozen rect can never be made live — the exact condition that used to
  // poison the restore verdict.
  n.boundingRect = Object.freeze([100, 70, 225, 30]);

  const r = moveGroupMembers([n], 50, 25);
  const unrestored = r.undo();

  assert.deepEqual(n.pos, [100, 100], "the position must actually be back where it started");
  assert.equal(
    unrestored.length,
    0,
    "a node restored to its exact original coordinates must not be reported as unrestorable",
  );
});

test("#813 a node whose position genuinely CANNOT be restored is still reported", () => {
  // Fail-closed is preserved: the verdict still comes from the position write.
  // A pos that refuses to change is a real unrestorable node and must be named.
  const n = {
    id: 25,
    size: [200, 100],
    flags: {},
    get pos() {
      return [999, 999]; // never accepts a write
    },
    set pos(_v) {
      /* swallow */
    },
  };

  const r = moveGroupMembers([n], 50, 25);
  const unrestored = r.undo();

  // It could not be moved either, so it is stuck rather than moved — and the
  // restore of a node whose pos is immovable must not claim success.
  assert.equal(r.moved.length, 0);
  assert.equal(unrestored.length, 0, "a node that never moved has nothing to restore");
});

test("#813 the rect is still refreshed during a restore — the fix does not stop rect maintenance", () => {
  const n = { id: 26, pos: [100, 100], size: [200, 100], flags: {} };
  n.boundingRect = [100, 70, 200, 130];

  const r = moveGroupMembers([n], 40, 60);
  assert.deepEqual(n.pos, [140, 160], "moved");
  r.undo();

  assert.deepEqual(n.pos, [100, 100], "restored");
  assert.ok(nodeAreaIsLive(n), "the cached rect must track the restore, not be left describing the moved position");
});

// ---------------------------------------------------------------------------
// #813 — a COLLAPSED member is not a node that refused to move
//
// The reporter's group held four `size:[225,0]` collapsed nodes. Every one was
// classified stuck AFTER its position had been written, and the same nodes moved
// fine one-by-one with panel_move_node. The stuck verdict never came from the
// position write; it came from comparing the cached rect against the panel's
// COLLAPSED PILL model while the engine's own updateArea() had just written its
// own extents back.
// ---------------------------------------------------------------------------

test("#813 a collapsed member whose engine updateArea() restores full extents still MOVES", () => {
  // The reporter's node, on a build whose updateArea() authoritatively recomputes the rect
  // the way this file already models it (see the #355 test above). The recompute uses
  // size — [225, 0] — so the rect comes back as [x, y-30, 225, 30]... which happens to
  // equal the pill here. Give it a _collapsed_width that DIFFERS from size[0], which is
  // what a real collapsed node has, and the two models diverge exactly as reported.
  const n = {
    id: 24,
    pos: [100, 100],
    size: [225, 0],
    flags: { collapsed: true },
    _collapsed_width: 80,
    boundingRect: [100, 70, 80, 30], // the pill, as the move's pre-flight left it
    updateArea() {
      // The engine knows nothing about the panel's pill: it recomputes from size.
      this.boundingRect = [this.pos[0], this.pos[1] - 30, this.size[0], this.size[1] + 30];
    },
  };

  const r = moveGroupMembers([n], 1400, -140);

  assert.deepEqual(r.stuck, [], "a collapsed node with a writable rect is not stuck");
  assert.deepEqual(r.moved, [n], "…it moved");
  assert.deepEqual(n.pos, [1500, -40], "to the reporter's target");
  assert.ok(nodeAreaIsLive(n), "and its cached rect is back on the panel's pill convention");
});

test("#813 the pill is forced, never the full box — #416 area overstatement stays closed", () => {
  // The correction must write the COLLAPSED footprint. Writing the engine's full-box
  // extents would make a collapsed node claim the area of its expanded self, and
  // membership is rect-first, so it would capture neighbours it does not overlap.
  const n = {
    id: 25,
    pos: [0, 0],
    size: [225, 400],
    flags: { collapsed: true },
    _collapsed_width: 80,
    boundingRect: [0, -30, 80, 30],
    updateArea() {
      this.boundingRect = [this.pos[0], this.pos[1] - 30, this.size[0], this.size[1] + 30];
    },
  };

  moveGroupMembers([n], 10, 10);

  assert.deepEqual(
    [...n.boundingRect],
    [10, -20, 80, 30],
    "the collapsed pill (80x30), not the 225x430 box the engine recomputed",
  );
});

test("#813 a rect that genuinely cannot be corrected is STILL stuck (#408 preserved)", () => {
  // The load-bearing half. A frozen rect cannot be made to track the node, membership is
  // rect-first, and leaving such a node "moved" would report it in a group it has left. The
  // fix gives the rect one more chance to be corrected — it does not stop asking.
  const n = {
    id: 26,
    pos: [100, 100],
    size: [225, 0],
    flags: { collapsed: true },
    _collapsed_width: 80,
    boundingRect: Object.freeze([100, 70, 80, 30]),
  };

  const r = moveGroupMembers([n], 50, 25);

  assert.deepEqual(r.moved, [], "an uncorrectable rect still refuses");
  assert.deepEqual(r.stuck, [n]);
});

test("#813 an EXPANDED member is unaffected — its two models already agree", () => {
  const n = {
    id: 27,
    pos: [100, 100],
    size: [200, 100],
    boundingRect: [100, 70, 200, 130],
    updateArea() {
      this.boundingRect = [this.pos[0], this.pos[1] - 30, this.size[0], this.size[1] + 30];
    },
  };

  const r = moveGroupMembers([n], 10, 10);

  assert.deepEqual(r.stuck, []);
  assert.deepEqual([...n.boundingRect], [110, 80, 200, 130]);
});

test("#813 a rect exposed by a COPYING getter is not reported moved (review P2)", () => {
  // `boundingRect` backed by a getter that hands out a fresh array each read. syncNodeArea
  // mutates and verifies the throwaway copy, so its own verdict is true while the node's
  // real rect never changed. Trusting that would report the node moved and then let the
  // next rect-first membership read drop it from the group it was just moved into. This
  // file already documents the same accessor shape for `pos` in writePoint.
  const real = [100, 70, 80, 30];
  const n = {
    id: 30,
    pos: [100, 100],
    size: [225, 0],
    flags: { collapsed: true },
    _collapsed_width: 80,
    get boundingRect() {
      return [...real]; // a COPY: writes to it are dropped
    },
    updateArea() {
      /* engine cannot move a rect it is handed by copy either */
    },
  };

  const r = moveGroupMembers([n], 50, 25);

  assert.deepEqual(r.moved, [], "a rect whose writes cannot be observed is not 'moved'");
  assert.deepEqual(r.stuck, [n]);
  assert.deepEqual(real, [100, 70, 80, 30], "and the underlying rect really was never updated");
});

test("#813/#1300 an EXPANDED node's authoritative extents are not overwritten (review P2)", () => {
  // A custom node whose updateArea() computes visible bounds reaching past `size` — a
  // legitimate engine answer that differs from the panel's generic footprint model. The
  // collapsed repair must not fire here: overwriting the engine's rect and reporting
  // success would make later rect-first membership wrong.
  //
  // #813 left this node STUCK rather than overwrite. That is the #1300 false
  // refusal: the position DID land, the origin DID track, only the extent model
  // disagreed. The node must MOVE, and the engine's extents must survive.
  const n = {
    id: 31,
    pos: [100, 100],
    size: [200, 100],
    // Deliberately WIDER than size — the node draws outside its box.
    boundingRect: [100, 70, 400, 300],
    updateArea() {
      this.boundingRect = [this.pos[0], this.pos[1] - 30, 400, 300];
    },
  };

  const r = moveGroupMembers([n], 10, 10);

  assert.deepEqual(r.stuck, [], "an expanded node whose origin tracked is not stuck");
  assert.deepEqual(r.moved, [n], "…it moved");
  assert.deepEqual(n.pos, [110, 110]);
  assert.deepEqual(
    [...n.boundingRect],
    [110, 80, 400, 300],
    "and its authoritative extents survive — never replaced by the 200x130 generic model",
  );
});

test("#1300 a Label (rgthree)-shaped member moves even though its rect is not the generic footprint", () => {
  // The reporter's nodes 579/594/606: frontend-only Label (rgthree). Their
  // updateArea() writes font-scaled visual bounds that are much larger than
  // size, so nodeAreaIsLive is false by construction. pinned is not the
  // discriminator — 579 was unpinned, 594 and 606 were pinned, all three
  // refused. panel_edit_node moved each of them.
  const label = (id, pinned) => ({
    id,
    type: "Label (rgthree)",
    pos: [100, 100],
    size: [210, 56],
    flags: { pinned },
    boundingRect: [100, 70, 420, 180],
    updateArea() {
      this.boundingRect = [this.pos[0], this.pos[1] - 30, 420, 180];
    },
  });
  const unpinned = label(579, false);
  const pinned = label(594, true);

  const r = moveGroupMembers([unpinned, pinned], 50, 25);

  assert.deepEqual(r.stuck, [], "neither pinned nor unpinned Label is stuck");
  assert.deepEqual(r.moved, [unpinned, pinned]);
  assert.deepEqual(unpinned.pos, [150, 125]);
  assert.deepEqual(pinned.pos, [150, 125]);
  assert.deepEqual([...unpinned.boundingRect], [150, 95, 420, 180], "engine extents survive");
  assert.deepEqual([...pinned.boundingRect], [150, 95, 420, 180]);
});

test("#1300 an expanded copying-getter rect is still stuck (#408 preserved)", () => {
  // Same copying-getter shape as the #813 collapsed test, but expanded: the
  // origin-tracks check must re-read, not trust a throwaway write, or a Label
  // whose boundingRect getter returns a copy would report moved and then vanish
  // from the group on the next rect-first membership read.
  const real = [100, 70, 420, 180];
  const n = {
    id: 606,
    type: "Label (rgthree)",
    pos: [100, 100],
    size: [210, 56],
    get boundingRect() {
      return [...real];
    },
    updateArea() { /* writes to a copy, dropped */ },
  };

  const r = moveGroupMembers([n], 50, 25);

  assert.deepEqual(r.moved, [], "a rect whose writes cannot be observed is not 'moved'");
  assert.deepEqual(r.stuck, [n]);
  assert.deepEqual(real, [100, 70, 420, 180], "and the underlying rect really was never updated");
});

test("#1300 an expanded frozen rect is still stuck (#408 preserved)", () => {
  const n = {
    id: 607,
    type: "Label (rgthree)",
    pos: [100, 100],
    size: [210, 56],
    boundingRect: Object.freeze([100, 70, 420, 180]),
  };

  const r = moveGroupMembers([n], 50, 25);

  assert.deepEqual(r.moved, [], "an uncorrectable rect still refuses");
  assert.deepEqual(r.stuck, [n]);
});

test("#1300 nodeAreaOriginTracks: origin shifted by the delta, extents ignored", () => {
  const n = { boundingRect: [110, 80, 420, 180] };
  assert.equal(nodeAreaOriginTracks(n, [100, 70], 10, 10), true);
  assert.equal(nodeAreaOriginTracks(n, [100, 70], 0, 0), false, "wrong delta");
  assert.equal(nodeAreaOriginTracks({ boundingRect: null }, [100, 70], 10, 10), true, "no cached rect");
  assert.equal(nodeAreaOriginTracks({ get boundingRect() { throw new TypeError("gone"); } }, [100, 70], 10, 10), false);
});

test("#813 a node whose flags accessor THROWS is stuck, not repaired", () => {
  // The collapsed repair is gated on reading `flags.collapsed`, and that read can throw on
  // a disposed or hostile node. It must fail CLOSED: an unreadable node is not one this can
  // show to have moved. (syncNodeArea would also fail on the same accessor, so the two
  // guards agree — this pins the behaviour rather than the implementation of it.)
  const n = {
    id: 32,
    pos: [100, 100],
    size: [225, 0],
    get flags() {
      throw new TypeError("disposed");
    },
    boundingRect: [0, 0, 1, 1], // deliberately wrong, so a repair would have to be attempted
  };

  let r;
  assert.doesNotThrow(() => {
    r = moveGroupMembers([n], 50, 25);
  }, "a hostile accessor must never escape the mover");
  assert.deepEqual(r.moved, [], "an unreadable node is not reported moved");
  assert.deepEqual(r.stuck, [n]);
});

// ---- holdGraphItemPositions: pin the graph while a box-only write runs (#1306) ----

test("#1306 holdGraphItemPositions puts nodes, nested boxes and reroutes back", () => {
  const a = node(1, 100, 100);
  const inner = groupBox([50, 50, 80, 80]);
  const outer = groupBox([0, 0, 400, 400]);
  const elbow = { id: 11, pos: [120, 120] };
  const graph = {
    _nodes: [a],
    _groups: [outer, inner],
    reroutes: [elbow],
  };
  const hold = holdGraphItemPositions(graph, outer);
  a.pos = [999, 999];
  inner._bounding = [1, 2, 3, 4];
  elbow.pos = [0, 0];
  outer._bounding = [200, 200, 500, 500];
  hold.restore();
  assert.deepEqual(a.pos, [100, 100], "the node is back");
  assert.deepEqual(inner._bounding, [50, 50, 80, 80], "the nested box is back");
  assert.deepEqual(elbow.pos, [120, 120], "the reroute is back");
  assert.deepEqual(outer._bounding, [200, 200, 500, 500], "the excepted group is left at its new box");
});

test("#1306 holdGraphItemPositions never throws on a hostile walk", () => {
  const graph = {
    get _nodes() { throw new TypeError("revoked"); },
    get _groups() { throw new TypeError("revoked"); },
    get reroutes() { throw new TypeError("revoked"); },
  };
  let hold;
  assert.doesNotThrow(() => {
    hold = holdGraphItemPositions(graph, null);
  });
  assert.doesNotThrow(() => hold.restore());
});

// ---------------------------------------------------------------------------
// mcp#1877 — panel_create_group excluded a requested COLLAPSED node from a box
// whose bounds visibly covered it.
// ---------------------------------------------------------------------------

test("mcp#1877 a requested node reporting a ZERO extent is a member of its own box", () => {
  // Numbers straight from the report: collapsed VAEDecode 81 at [9750, 5410],
  // which the frontend presents with a collapsed pill width and a ZERO body
  // height. graph_create_group syncs the requested node's cached rect (forced to
  // the FULL footprint) and then builds the box with boundsAroundNodes.
  //
  // FAIL-BEFORE: the two disagreed about a zero extent. boundsAroundNodes read
  // `size[1] ?? 100` — `??` passes 0 through — so the box was [9720, 5340, 285,
  // 100]; wantedNodeArea rejected the 0 and wrote a rect 130 tall. The rect's
  // centre landed at y 5445, five pixels below the box's bottom edge at 5440, and
  // the tool reported node_count 0 / missing_node_ids [81].
  const n = {
    id: 81,
    type: "VAEDecode",
    flags: { collapsed: true },
    pos: [9750, 5410],
    size: [225, 0],
    boundingRect: [0, 0, 0, 0], // stale, as after a graph load
  };
  syncNodeArea(n, /* forceCollapsed */ true);
  const bbox = boundsAroundNodes([n]);
  assert.deepEqual(
    groupMemberNodes(graphOf(n), groupBox(bbox)).map((x) => x.id),
    [81],
    "the node the box was built around must be one of its members",
  );
});

test("mcp#1877 boundsAroundNodes and wantedNodeArea share ONE extent model", () => {
  // The invariant behind the fix, stated directly on the degenerate extents that
  // broke it: whatever width/height the box builder uses for a node, the cached
  // rect writer must use the same. Testing membership (above) alone would not
  // catch the two drifting apart again in a way that happens to stay inside the
  // padding.
  for (const size of [[225, 0], [0, 120], [0, 0], [225, -40], [225, NaN], [Infinity, 120]]) {
    const n = { id: 1, pos: [100, 100], size };
    syncNodeArea(n, true); // no cached rect ⇒ read the model through nodeFocusBounds
    const [, , focusW, focusH] = nodeFocusBounds(n);
    assert.deepEqual(
      nodeExtents(n),
      [focusW, focusH - 30],
      `size ${JSON.stringify(size)}: box extents must match the rect extents`,
    );
  }
});

test("mcp#1877 a non-finite position never yields a NaN group box", () => {
  // A NaN extent or a NaN *y* never touched minX, and minX was the only
  // accumulator checked — so the box escaped as [x, NaN, w, NaN] and
  // setGroupBounds wrote it to the user's graph.
  const good = node(1, 100, 100);
  const badY = { id: 2, pos: [100, Number.NaN], size: [300, 120] };
  const badSize = { id: 3, pos: [400, 100], size: [300, Number.NaN] };
  for (const bbox of [
    boundsAroundNodes([good, badY]),
    boundsAroundNodes([good, badSize]),
    boundsAroundNodes([badY]),
  ]) {
    assert.ok(
      bbox.every((v) => Number.isFinite(v)),
      `every component of ${JSON.stringify(bbox)} must be finite`,
    );
  }
});

test("mcp#1877 a MISSING requested node is not reported as a dense-layout capture", () => {
  // The old warning was one sentence that always began "also captures N unrelated
  // node(s)" — with N printed as 0 — and always prescribed spreading the nodes
  // out. For a single requested node that is exactly backwards.
  const resolved = new Set(["81"]);
  const w = describeGroupMembershipGap([], [81], resolved, new Set());
  assert.ok(!/captures 0 unrelated/.test(w), `must not claim a 0-node capture: ${w}`);
  assert.ok(!/contiguous region/.test(w), `must not prescribe a layout change: ${w}`);
  assert.match(w, /81/, "names the node that is missing");
  assert.match(w, /CENTRE/, "names the rule that actually excluded it");

  // A rect that refused the resync is named as such, not blamed on the layout.
  const stuck = describeGroupMembershipGap([], [81], resolved, new Set(["81"]));
  assert.match(stuck, /could not be reconciled/, `names the stuck rect: ${stuck}`);
  assert.ok(!/CENTRE of their footprint falls outside/.test(stuck), "one cause, not both");

  // An id that resolves to nothing is its own cause (#297's nonexistent-id case).
  const unknown = describeGroupMembershipGap([], [99], new Set(), new Set());
  assert.match(unknown, /do not exist in this graph/, `names the unknown id: ${unknown}`);

  // The dense-layout sentence still fires when something extra WAS captured.
  const dense = describeGroupMembershipGap([7, 8], [], resolved, new Set());
  assert.match(dense, /also captures 2 unrelated node\(s\)/);
  assert.match(dense, /contiguous region/);
});
