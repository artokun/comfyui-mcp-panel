/**
 * Unit tests for the graph_disconnect pre/post verification (#668) —
 * web/js/lib/disconnect-verify.js. Run with `node --test`.
 *
 * Bug: three panel_disconnect calls on a SUBGRAPH node's inputs silently DELETED
 * two unrelated nodes (a LoadImage two hops upstream, a downstream SaveVideo)
 * while every call returned a plain success payload. The panel assumed
 * node.disconnectInput() only drops one wire and never checked the post-state.
 * These tests pin the property: after a disconnect, the intended link is gone
 * and NOTHING else changed — otherwise the verdict is not ok and the caller
 * must disclose, never report a bare success.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  snapshotGraphState,
  describeInputLink,
  verifyDisconnect,
} from "../../web/js/lib/disconnect-verify.js";

/** Minimal mock graph: nodes by id, links as a legacy record store. getNodeById
 *  reads the LIVE _nodes array, like litegraph's _nodes_by_id lookup. */
function mockGraph(nodes, links) {
  const g = {
    _nodes: nodes,
    links,
    getNodeById: (id) => g._nodes.find((n) => n.id === id) ?? null,
  };
  return g;
}

function node(id, inputs = [], outputs = []) {
  return { id, inputs, outputs };
}

// The #668 repro shape (reduced): 121 ImageCrop ← 114 LoadImage; subgraph node
// 105 ← 121 (first_frame) and 105.VIDEO → 92 SaveVideo. Link ids 1, 2, 3.
function reproGraph() {
  const n114 = node(114, [], [{ name: "IMAGE", links: [1] }]);
  const n121 = node(121, [{ name: "image", link: 1 }], [{ name: "IMAGE", links: [2] }]);
  const n105 = node(
    105,
    [{ name: "first_frame", link: 2 }],
    [{ name: "VIDEO", links: [3] }],
  );
  const n92 = node(92, [{ name: "video", link: 3 }], []);
  return mockGraph([n114, n121, n105, n92], {
    1: { id: 1, origin_id: 114, origin_slot: 0, target_id: 121, target_slot: 0 },
    2: { id: 2, origin_id: 121, origin_slot: 0, target_id: 105, target_slot: 0 },
    3: { id: 3, origin_id: 105, origin_slot: 0, target_id: 92, target_slot: 0 },
  });
}

test("snapshotGraphState: node ids string-normalized, floating links excluded", () => {
  const g = mockGraph([node(1), node("sub")], {
    5: { id: 5, origin_id: 1, origin_slot: 0, target_id: "sub", target_slot: 0 },
    6: { id: 6, origin_id: -1, origin_slot: -1, target_id: "sub", target_slot: 0 }, // floating
    7: { id: 7, origin_id: 1, origin_slot: 0, target_id: -1, target_slot: -1 }, // floating
  });
  const s = snapshotGraphState(g);
  assert.deepEqual([...s.nodeIds].sort(), ["1", "sub"]);
  assert.deepEqual([...s.links.keys()], ["5"]);
});

test("snapshotGraphState: modern Map store (_links) is read", () => {
  const g = {
    _nodes: [node(1), node(2)],
    _links: new Map([
      [9, { id: 9, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 }],
    ]),
  };
  const s = snapshotGraphState(g);
  assert.deepEqual([...s.links.keys()], ["9"]);
  assert.equal(s.links.get("9").origin_id, 1);
});

test("describeInputLink: names the wire's former source (node id + output name)", () => {
  const g = reproGraph();
  const n105 = g.getNodeById(105);
  const d = describeInputLink(g, n105, 0);
  assert.equal(d.linkId, 2);
  assert.equal(d.node_id, 121);
  assert.equal(d.output, "IMAGE");
  assert.equal(d.output_index, 0);
});

test("describeInputLink: unlinked input → null (caller refuses the no-op)", () => {
  const g = reproGraph();
  const n105 = g.getNodeById(105);
  n105.inputs.push({ name: "width", link: null });
  assert.equal(describeInputLink(g, n105, 1), null);
});

test("describeInputLink: dangling slot ref (no link record) → null, like unlinked", () => {
  const g = reproGraph();
  const n105 = g.getNodeById(105);
  n105.inputs[0].link = 99; // dangling id, no record in the store
  assert.equal(describeInputLink(g, n105, 0), null);
});

test("describeInputLink: origin node gone but record present → slot-index fallback", () => {
  const g = reproGraph();
  const n105 = g.getNodeById(105);
  g._nodes = g._nodes.filter((n) => n.id !== 121); // origin deleted, record survives
  const d = describeInputLink(g, n105, 0);
  assert.equal(d.linkId, 2);
  assert.equal(d.node_id, 121);
  assert.equal(d.output, 0); // no origin outputs to name — the slot index
  assert.equal(d.output_index, 0);
});

test("clean disconnect: intended link gone, nothing else changed → ok", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  // Simulate litegraph dropping link 2 (record deleted, slot ref nulled).
  delete g.links[2];
  g.getNodeById(105).inputs[0].link = null;
  g.getNodeById(121).outputs[0].links = [];
  const v = verifyDisconnect(g, g.getNodeById(105), before, 2);
  assert.equal(v.ok, true);
  assert.equal(v.intendedRemoved, true);
  assert.deepEqual(v.missingNodes, []);
  assert.deepEqual(v.addedNodes, []);
  assert.deepEqual(v.collateralRemovedLinks, []);
  assert.deepEqual(v.addedLinks, []);
});

test("#668 repro: unrelated nodes deleted by the cascade → not ok, ids disclosed", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  // The cascade: intended link 2 gone, but LoadImage 114 and SaveVideo 92
  // DELETED — and their wires (1, 3) removed with them.
  delete g.links[2];
  g.getNodeById(105).inputs[0].link = null;
  delete g.links[1];
  delete g.links[3];
  g._nodes = g._nodes.filter((n) => n.id !== 114 && n.id !== 92);
  const v = verifyDisconnect(g, g.getNodeById(105), before, 2);
  assert.equal(v.ok, false);
  assert.equal(v.intendedRemoved, true, "the disconnect itself did land");
  assert.deepEqual(v.missingNodes.sort(), ["114", "92"]);
  const collateralIds = v.collateralRemovedLinks.map((l) => String(l.id)).sort();
  assert.deepEqual(collateralIds, ["1", "3"]);
});

test("node APPEARED during the disconnect → not ok", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  delete g.links[2];
  g.getNodeById(105).inputs[0].link = null;
  g._nodes.push(node(200));
  const v = verifyDisconnect(g, g.getNodeById(105), before, 2);
  assert.equal(v.ok, false);
  assert.deepEqual(v.addedNodes, ["200"]);
});

test("intended link still in the store → not ok (disconnect silently failed)", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  // Litegraph no-op: slot ref cleared but the record survived (or vice versa —
  // either half means the wire is not fully gone).
  g.getNodeById(105).inputs[0].link = null;
  const v = verifyDisconnect(g, g.getNodeById(105), before, 2);
  assert.equal(v.ok, false);
  assert.equal(v.intendedRemoved, false);
});

test("intended link record deleted but a slot still references it → not ok", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  delete g.links[2];
  // Boundary-slot cascade shifted the inputs array; the link id is still
  // referenced by SOME input (checked across the whole array, not a fixed index).
  const n105 = g.getNodeById(105);
  n105.inputs = [{ name: "width", link: null }, { name: "first_frame", link: 2 }];
  const v = verifyDisconnect(g, n105, before, 2);
  assert.equal(v.ok, false);
  assert.equal(v.intendedRemoved, false);
});

test("slot-shift safety: inputs array reordered but link fully gone → ok", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  delete g.links[2];
  const n105 = g.getNodeById(105);
  // The boundary slot was removed entirely (indices shifted) — legitimate
  // cascade the caller discloses via the slotsShifted warning, not a failure.
  n105.inputs = [];
  const v = verifyDisconnect(g, n105, before, 2);
  assert.equal(v.ok, true);
  assert.equal(v.intendedRemoved, true);
});

test("collateral wire cut with all nodes surviving → not ok (the 114→121 case)", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  delete g.links[2];
  g.getNodeById(105).inputs[0].link = null;
  delete g.links[1]; // ImageCrop's image input silently emptied
  g.getNodeById(121).inputs[0].link = null;
  const v = verifyDisconnect(g, g.getNodeById(105), before, 2);
  assert.equal(v.ok, false);
  assert.equal(v.intendedRemoved, true);
  assert.deepEqual(v.missingNodes, []);
  assert.deepEqual(
    v.collateralRemovedLinks.map((l) => [l.origin_id, l.target_id]),
    [[114, 121]],
  );
});

test("new link appeared → not ok", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  delete g.links[2];
  g.getNodeById(105).inputs[0].link = null;
  g.links[4] = { id: 4, origin_id: 121, origin_slot: 0, target_id: 92, target_slot: 0 };
  const v = verifyDisconnect(g, g.getNodeById(105), before, 2);
  assert.equal(v.ok, false);
  assert.deepEqual(v.addedLinks.map((l) => l.id), [4]);
});

test("floating-link churn alone does not fail the verdict", () => {
  const g = reproGraph();
  g.links[50] = { id: 50, origin_id: -1, origin_slot: -1, target_id: 105, target_slot: 0 };
  const before = snapshotGraphState(g);
  delete g.links[2];
  g.getNodeById(105).inputs[0].link = null;
  delete g.links[50]; // mid-drag stub discarded during the disconnect — not a wire
  const v = verifyDisconnect(g, g.getNodeById(105), before, 2);
  assert.equal(v.ok, true);
});

test("interior node deletion inside the target's subgraph is detected (path-qualified)", () => {
  const g = reproGraph();
  const n105 = g.getNodeById(105);
  n105.subgraph = { _nodes: [node(12), node(13)] };
  const before = snapshotGraphState(g);
  assert.ok(before.nodeIds.has("105>12"), "interior nodes are in the snapshot");
  delete g.links[2];
  n105.inputs[0].link = null;
  n105.subgraph._nodes = [node(13)]; // inner node 12 deleted by the cascade
  const v = verifyDisconnect(g, n105, before, 2);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missingNodes, ["105>12"]);
});

test("interior LINK pruning (boundary-slot cascade) does NOT fail — documented asymmetry", () => {
  const g = reproGraph();
  const n105 = g.getNodeById(105);
  n105.subgraph = {
    _nodes: [node(12)],
    links: { 1: { id: 1, origin_id: -10, origin_slot: 0, target_id: 12, target_slot: 0 } },
  };
  const before = snapshotGraphState(g);
  delete g.links[2];
  n105.inputs[0].link = null;
  // The boundary slot was pruned: its interior rail link went with it. Interior
  // link stores are deliberately NOT diffed (legitimate cascade) — only the
  // interior NODE set is. The panel's slotsShifted warning covers the shape.
  n105.subgraph.links = {};
  n105.inputs = [];
  const v = verifyDisconnect(g, n105, before, 2);
  assert.equal(v.ok, true);
});

test("null/undefined intendedLinkId fails closed", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  const v = verifyDisconnect(g, g.getNodeById(105), before, null);
  assert.equal(v.ok, false);
  assert.equal(v.intendedRemoved, false);
});

test("string-vs-number node ids across the boundary are not false positives", () => {
  // Subgraph node ids can be strings; _nodes may carry "7" while a rebuilt
  // array carries 7. The snapshot normalizes both, so no phantom add/remove.
  const g1 = mockGraph([node("7"), node(8)], {});
  const before = snapshotGraphState(g1);
  const g2 = mockGraph([node(7), node("8")], {});
  const v = verifyDisconnect(g2, g2.getNodeById(7), before, null);
  assert.deepEqual(v.missingNodes, []);
  assert.deepEqual(v.addedNodes, []);
});
