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
