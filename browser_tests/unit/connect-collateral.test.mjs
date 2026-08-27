/**
 * Unit tests for the graph_connect collateral-damage verdict
 * (artokun/comfyui-mcp#2380) — web/js/lib/connect-verify.js. Run with `node --test`.
 *
 * Bug: three panel_connect calls each returned a clean `{connected: ...}` success while
 * an untargeted node (#1282) was left with BOTH of its inputs re-pointed. Every check on
 * the connect path was scoped to the two endpoints the command named, so nothing on the
 * path could see it; the caller discovered it in a later panel_query_graph, "restored"
 * the node from that stale picture, and that corrective write tore down two more links.
 *
 * graph_disconnect has verified this since #668 (a disconnect that DELETED two unrelated
 * nodes while reporting success). These tests pin the same property for connect: after a
 * connect, the only legitimate changes are the link it created and the link it replaced,
 * and ANYTHING else is disclosed.
 *
 * The first test is the one that matters most in production. A verdict that cried
 * collateral on ordinary connects would be worse than no verdict at all — it would train
 * callers to ignore the warning that finally tells them the truth.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { snapshotGraphState } from "../../web/js/lib/disconnect-verify.js";
import {
  verifyConnect,
  snapshotInputSlotLinks,
  connectCollateralBullets,
  connectCollateralWarning,
} from "../../web/js/lib/connect-verify.js";

function mockGraph(nodes, links) {
  const g = {
    _nodes: nodes,
    links,
    getNodeById: (id) => g._nodes.find((n) => n.id === id) ?? null,
  };
  return g;
}
const node = (id, inputs = [], outputs = []) => ({ id, inputs, outputs });

/**
 * The #2380 chain, reduced to what the verdict actually reads. 1280 ColorMatchV2 →
 * 1273 MVEx_SubjectUncrop; 1273 → 1282 ColorMatchV2.image_target; 1235 Reroute →
 * 1282.image_ref. 1283 HDRPreviewKJ is the freshly added node the report wires in.
 */
function reproGraph() {
  const n1280 = node(1280, [], [{ name: "image", links: [10] }]);
  const n1273 = node(1273, [{ name: "cropped_images", link: 10 }], [{ name: "IMAGE", links: [11] }]);
  const n1235 = node(1235, [], [{ name: "", links: [12] }]);
  const n1282 = node(
    1282,
    [
      { name: "image_target", link: 11 },
      { name: "image_ref", link: 12 },
    ],
    [{ name: "image", links: [] }],
  );
  const n1283 = node(1283, [{ name: "image", link: null }], [{ name: "image", links: [] }]);
  return mockGraph([n1280, n1273, n1235, n1282, n1283], {
    10: { id: 10, origin_id: 1280, origin_slot: 0, target_id: 1273, target_slot: 0 },
    11: { id: 11, origin_id: 1273, origin_slot: 0, target_id: 1282, target_slot: 0 },
    12: { id: 12, origin_id: 1235, origin_slot: 0, target_id: 1282, target_slot: 1 },
  });
}

test("NO FALSE POSITIVE: an ordinary connect onto an empty input is ok", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  // 1280.image -> 1283.image, the report's first command. Nothing displaced.
  g.links[13] = { id: 13, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  g.getNodeById(1283).inputs[0].link = 13;

  const v = verifyConnect(g, before, { intendedLinkIds: [13], replacedLinkId: null });
  assert.equal(v.ok, true);
  assert.deepEqual(connectCollateralBullets(v), []);
});

test("the wire a connect REPLACES on its own target input is not collateral", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  // 1283.image -> 1282.image_target, displacing link 11 by design.
  delete g.links[11];
  g.links[14] = { id: 14, origin_id: 1283, origin_slot: 0, target_id: 1282, target_slot: 0 };
  g.getNodeById(1282).inputs[0].link = 14;

  const v = verifyConnect(g, before, { intendedLinkIds: [14], replacedLinkId: 11 });
  assert.equal(v.ok, true, "replaced_link is already reported; it must not double as collateral");
});

test("REPORTED SHAPE: an untargeted node's input re-pointed IS collateral", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  // The command: 1280.image -> 1283.image. Landed, and legitimate.
  g.links[13] = { id: 13, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  g.getNodeById(1283).inputs[0].link = 13;
  // AND 1282.image_target silently moved from 1273 to 1280 — no command named 1282.
  delete g.links[11];
  g.links[15] = { id: 15, origin_id: 1280, origin_slot: 0, target_id: 1282, target_slot: 0 };
  g.getNodeById(1282).inputs[0].link = 15;

  const v = verifyConnect(g, before, { intendedLinkIds: [13], replacedLinkId: null });
  assert.equal(v.ok, false, "this is the whole bug: it used to return a clean success");
  assert.deepEqual(
    v.collateralRemovedLinks.map((l) => l.id),
    [11],
  );
  assert.deepEqual(
    v.collateralAddedLinks.map((l) => l.id),
    [15],
  );

  const bullets = connectCollateralBullets(v);
  assert.equal(bullets.length, 2);
  assert.ok(bullets.some((b) => b.includes("REMOVED") && b.includes("1282")));
  assert.ok(bullets.some((b) => b.includes("APPEARED") && b.includes("1282")));
});

test("a re-slotted link carrying a DIFFERENT id is not collateral when named intended", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  // connect() returned link 20, then a dynamic-input pack re-slotted it as link 21.
  g.links[21] = { id: 21, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  g.getNodeById(1283).inputs[0].link = 21;

  const naive = verifyConnect(g, before, { intendedLinkIds: [20], replacedLinkId: null });
  assert.equal(naive.ok, false, "id 21 is unaccounted for when only the returned id is named");

  const v = verifyConnect(g, before, { intendedLinkIds: [20, 21], replacedLinkId: null });
  assert.equal(v.ok, true, "the caller passes both the returned id and the landed id");
});

test("a node that disappears during a connect is disclosed (the #668 shape)", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  g._nodes = g._nodes.filter((n) => n.id !== 1235);
  delete g.links[12];

  const v = verifyConnect(g, before, { intendedLinkIds: [], replacedLinkId: null });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missingNodes, ["1235"]);
  assert.ok(connectCollateralBullets(v).some((b) => b.includes("REMOVED from the graph")));
});

test("verdict is defensive: a null `before` never throws", () => {
  const g = reproGraph();
  const v = verifyConnect(g, null, {});
  assert.equal(typeof v.ok, "boolean");
  assert.equal(v.missingNodes.length, 0);
});

test("intendedLinkIds accepts a bare id and ignores null entries", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  g.links[13] = { id: 13, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  assert.equal(verifyConnect(g, before, { intendedLinkIds: 13 }).ok, true);
  assert.equal(verifyConnect(g, before, { intendedLinkIds: [null, 13] }).ok, true);
});

test("string and number link ids are the same id", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  g.links[13] = { id: 13, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  assert.equal(verifyConnect(g, before, { intendedLinkIds: ["13"] }).ok, true);

  const g2 = reproGraph();
  const before2 = snapshotGraphState(g2);
  delete g2.links[11];
  assert.equal(verifyConnect(g2, before2, { replacedLinkId: "11" }).ok, true);
});

test("the warning does not read as a failed connect, and cites the issue", () => {
  const w = connectCollateralWarning(["- something moved"]);
  assert.ok(w.includes("#2380"));
  assert.ok(w.includes("this connect landed"), "the wire the caller asked for DID land");
  assert.ok(w.includes("- something moved"));
  assert.ok(
    w.includes("panel_graph_outline"),
    "the report's own damage came from correcting off a stale picture",
  );
  assert.ok(!/\bfailed\b/i.test(w), "must not describe itself as a failure");
});

// The gate's P1 on the first version of this fix. Both set comparisons above are keyed
// on link ID, so a record whose id SURVIVES while its endpoints are rewritten in place
// appears in `before` and `after` alike — neither removed nor added — and the verdict
// came back ok:true with nothing disclosed. That is the shape #2380 actually reports:
// two inputs on an untargeted node fed from different sources afterwards.
test("#2380 in-place endpoint rewrite is COLLATERAL, not invisible", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  // The command: 1280.image -> 1283.image (legitimate).
  g.links[13] = { id: 13, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  g.getNodeById(1283).inputs[0].link = 13;
  // AND link 11 is REWRITTEN IN PLACE — same id, new source — on a node nothing named.
  g.links[11] = { id: 11, origin_id: 1280, origin_slot: 0, target_id: 1282, target_slot: 0 };

  const v = verifyConnect(g, before, { intendedLinkIds: [13], replacedLinkId: null });
  assert.equal(v.ok, false, "an id that survives a move must not read as untouched");
  assert.deepEqual(v.collateralRemovedLinks, [], "it was not removed");
  assert.deepEqual(v.collateralAddedLinks, [], "nor added");
  assert.equal(v.collateralMovedLinks.length, 1);
  assert.equal(String(v.collateralMovedLinks[0].before.origin_id), "1273");
  assert.equal(String(v.collateralMovedLinks[0].after.origin_id), "1280");

  const bullets = connectCollateralBullets(v);
  assert.equal(bullets.length, 1);
  assert.match(bullets[0], /MOVED/);
  assert.match(bullets[0], /1282/);
});

test("#2380 an intended id ALREADY PRESENT is id REUSE — the old wire's loss is reported", () => {
  // This test previously asserted the opposite, and it was wrong: exempting an intended
  // id from the before-side analysis is what let a reused id destroy an unrelated wire
  // silently. A genuinely new link cannot be in `before`, so an intended id that IS
  // present means LiteGraph handed the new link an id another wire already held.
  const g = reproGraph();
  const before = snapshotGraphState(g);
  // Link 11 was 1273 -> 1282. connect() returns id 11 for a completely different wire.
  g.links[11] = { id: 11, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };

  const v = verifyConnect(g, before, { intendedLinkIds: [11], replacedLinkId: null });
  assert.equal(v.ok, false, "the wire that held this id is gone and must be disclosed");
  assert.equal(v.collateralMovedLinks.length, 1);
  assert.equal(String(v.collateralMovedLinks[0].before.target_id), "1282");
  assert.equal(String(v.collateralMovedLinks[0].after.target_id), "1283");
});

test("#2380 the REPLACED link may still be displaced without being called collateral", () => {
  // replacedLinkId stays exempt: connect drops that wire by design and the reply already
  // names it as replaced_link. Only the intended exemption was too broad.
  const g = reproGraph();
  const before = snapshotGraphState(g);
  g.links[12] = { id: 12, origin_id: 1283, origin_slot: 0, target_id: 1282, target_slot: 1 };
  assert.equal(verifyConnect(g, before, { replacedLinkId: 12 }).ok, true);
});
test("#2380 an unmoved link is not reported — no false positive on a quiet connect", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  g.links[13] = { id: 13, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  const v = verifyConnect(g, before, { intendedLinkIds: [13] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.collateralMovedLinks, []);
});

// Third gate P1: the link STORE and the node SLOTS are independent views. A hook can
// leave every link record byte-identical while repointing a bystander's inputs[i].link,
// and execution follows the slot — the report's own symptom, an input fed from a source
// nobody named.
test("#2380 a bystander input RESLOTTED to another link is collateral", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  const beforeSlots = snapshotInputSlotLinks(g);
  // Records untouched. Only 1282's first input is repointed from link 11 to link 12.
  g.getNodeById(1282).inputs[0].link = 12;

  const v = verifyConnect(g, before, { intendedLinkIds: [], beforeSlots });
  assert.deepEqual(v.collateralRemovedLinks, [], "no record was removed");
  assert.deepEqual(v.collateralMovedLinks, [], "and none moved");
  assert.equal(v.ok, false, "yet the graph is wired differently");
  assert.equal(v.collateralReslottedInputs.length, 1);
  assert.match(connectCollateralBullets(v)[0], /DIFFERENT link/);
});

test("#2380 the slot comparison is opt-in — an older call site is unaffected", () => {
  // Omitting beforeSlots must contribute nothing rather than invent a finding.
  const g = reproGraph();
  const before = snapshotGraphState(g);
  g.getNodeById(1282).inputs[0].link = 12;
  const v = verifyConnect(g, before, { intendedLinkIds: [] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.collateralReslottedInputs, []);
});

test("#2380 an input reslotted to the INTENDED link is not collateral", () => {
  // A dynamic pack landing this connect on a different slot is the #1873 path, already
  // disclosed as slots_rewritten; it must not also read as bystander damage.
  const g = reproGraph();
  const before = snapshotGraphState(g);
  const beforeSlots = snapshotInputSlotLinks(g);
  g.links[13] = { id: 13, origin_id: 1280, origin_slot: 0, target_id: 1282, target_slot: 0 };
  g.getNodeById(1282).inputs[0].link = 13;
  assert.equal(verifyConnect(g, before, { intendedLinkIds: [13], beforeSlots }).ok, true);
});

// Fifth gate P1: the first slot comparison only walked `beforeSlots` and skipped a slot
// that was absent afterwards, so two of the three transitions were invisible.
test("#2380 an untargeted input EMPTIED (link -> null) is collateral", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  const beforeSlots = snapshotInputSlotLinks(g);
  g.getNodeById(1282).inputs[0].link = null;
  const v = verifyConnect(g, before, { intendedLinkIds: [], beforeSlots });
  assert.equal(v.ok, false, "an input that lost its wire must be disclosed");
  assert.equal(v.collateralReslottedInputs.length, 1);
  assert.equal(v.collateralReslottedInputs[0].after, null);
});

test("#2380 an untargeted input FILLED (null -> link) is collateral", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  const beforeSlots = snapshotInputSlotLinks(g);
  // 1283.image was empty; something wires it without this connect naming it.
  g.getNodeById(1283).inputs[0].link = 12;
  const v = verifyConnect(g, before, { intendedLinkIds: [], beforeSlots });
  assert.equal(v.ok, false, "an input that gained a wire must be disclosed");
  assert.equal(v.collateralReslottedInputs[0].before, null);
  assert.equal(String(v.collateralReslottedInputs[0].after), "12");
});

test("#2380 the INTENDED link filling its own target is not collateral", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  const beforeSlots = snapshotInputSlotLinks(g);
  g.links[13] = { id: 13, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  g.getNodeById(1283).inputs[0].link = 13;
  assert.equal(verifyConnect(g, before, { intendedLinkIds: [13], beforeSlots }).ok, true);
});

// Gate P1: the intended-id exemption was global, so a hook assigning that id to an
// UNTARGETED input was exempt — hiding the exact rewiring this verifier exists to catch.
test("#2380 the intended link landing on an UNTARGETED slot is still collateral", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  const beforeSlots = snapshotInputSlotLinks(g);
  // The connect addressed 1283#0, but link 13 ends up on 1282#0 as well.
  g.links[13] = { id: 13, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  g.getNodeById(1283).inputs[0].link = 13;
  g.getNodeById(1282).inputs[0].link = 13;

  const v = verifyConnect(g, before, {
    intendedLinkIds: [13],
    beforeSlots,
    intendedSlots: new Set(["1283#0"]),
  });
  assert.equal(v.ok, false, "the intended id is only exempt where it was addressed");
  assert.ok(v.collateralReslottedInputs.some((r) => r.slot === "1282#0"));
  assert.ok(!v.collateralReslottedInputs.some((r) => r.slot === "1283#0"));
});

test("#2380 omitting intendedSlots keeps the previous id-only behaviour", () => {
  // Back-compat: a caller that cannot name the addressed slot must not start seeing
  // its own intended link reported as damage.
  const g = reproGraph();
  const before = snapshotGraphState(g);
  const beforeSlots = snapshotInputSlotLinks(g);
  g.links[13] = { id: 13, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  g.getNodeById(1283).inputs[0].link = 13;
  assert.equal(verifyConnect(g, before, { intendedLinkIds: [13], beforeSlots }).ok, true);
});

// Gate P1: an id that is BOTH the replaced link and the reused intended id was exempt
// unconditionally, so a reassignment onto an untargeted node was invisible.
test("#2380 an id both replaced AND reused is checked by where it LANDED", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  // Link 11 fed 1282#0. The connect reuses id 11 but it ends up on 1283 — not the
  // slot addressed — so the wire 1282#0 relied on is gone with nothing disclosed.
  g.links[11] = { id: 11, origin_id: 1280, origin_slot: 0, target_id: 1283, target_slot: 0 };
  const v = verifyConnect(g, before, {
    intendedLinkIds: [11],
    replacedLinkId: 11,
    intendedSlots: new Set(["1282#0"]),
  });
  assert.equal(v.ok, false, "it did not land where the connect addressed");
  assert.equal(v.collateralMovedLinks.length, 1);
});

test("#2380 a replaced id reused ON the addressed slot stays exempt", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  g.links[11] = { id: 11, origin_id: 1283, origin_slot: 0, target_id: 1282, target_slot: 0 };
  const v = verifyConnect(g, before, {
    intendedLinkIds: [11],
    replacedLinkId: 11,
    intendedSlots: new Set(["1282#0"]),
  });
  assert.equal(v.ok, true, "reconnecting the addressed input is the whole point");
});

test("#2380 a replaced link that is GONE stays exempt (the ordinary case)", () => {
  const g = reproGraph();
  const before = snapshotGraphState(g);
  delete g.links[11];
  assert.equal(verifyConnect(g, before, { replacedLinkId: 11 }).ok, true);
});

test('#2380 an untargeted input RETYPED (11 -> "11") is collateral', () => {
  // The wire is not merely different, it is BROKEN: litegraph's `_links` is a NUMBER-keyed
  // Map whose `links` proxy binds Map.prototype.get through, so get("11") misses a record
  // stored under 11 (#1425). String()-normalising the slot snapshot made the two compare
  // equal, so this read ok:true with nothing disclosed (gate P1).
  const g = reproGraph();
  const before = snapshotGraphState(g);
  const beforeSlots = snapshotInputSlotLinks(g);
  assert.equal(
    typeof g.getNodeById(1282).inputs[0].link,
    "number",
    "premise: the slot starts NUMBER-typed, or this pin proves nothing",
  );
  g.getNodeById(1282).inputs[0].link = "11"; // same id, other type — record untouched

  const v = verifyConnect(g, before, { intendedLinkIds: [], beforeSlots });
  assert.deepEqual(v.collateralRemovedLinks, [], "no record changed");
  assert.equal(v.ok, false, "yet 1282#0 can no longer resolve its own link");
  assert.deepEqual(
    v.collateralReslottedInputs.map((r) => r.slot),
    ["1282#0"],
  );
});

test("#2380 identity across types still holds where it is NEEDED — the addressed slot", () => {
  // The normalisation was not wrong, only misplaced. A caller naming its intended id as a
  // string while the slot lands it as a number must still be exempt, or every connect
  // whose id types disagree with the caller's reads as damage.
  const g = reproGraph();
  const before = snapshotGraphState(g);
  const beforeSlots = snapshotInputSlotLinks(g);
  g.getNodeById(1282).inputs[0].link = 12;

  const v = verifyConnect(g, before, {
    intendedLinkIds: ["12"], // string, while the slot holds the number
    intendedSlots: new Set(["1282#0"]),
    beforeSlots,
  });
  assert.deepEqual(v.collateralReslottedInputs, [], "the addressed slot got what was asked for");
});
