/**
 * comfyui-mcp#1665 — panel_unpack_subgraph silently dropped external links whose
 * parent-graph targets were widget-converted inputs (`length`) or dynamic/optional
 * inputs (`values.a`, `ref_audios.ref_audio_0`), leaving them half-broken: target
 * slot `connected_from: null` while the source output still reported `links: 1`.
 *
 * MEASURED on ComfyUI 0.33.0 / frontend 1.49.6 (the reporter's graph): 3 of ~35
 * external links were not restored by litegraph's unpackSubgraph, every one into a
 * widget-converted or dynamic target slot, and the tool returned a bare success.
 * Repairing by hand with panel_connect worked, so the information needed to detect
 * the loss is available — these tests pin the snapshot/verify logic that detects it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  snapshotExternalLinks,
  verifyExternalLinks,
  reseatExternalLinksByIdentity,
} from "../../web/js/lib/unpack-link-verify.js";

const mkLink = (id, origin_id, origin_slot, target_id, target_slot) => ({
  id,
  origin_id,
  origin_slot,
  target_id,
  target_slot,
});

const mkGraph = (nodes, links, { asMap = true } = {}) => ({
  links: asMap
    ? new Map(links.map((l) => [l.id, l]))
    : Object.fromEntries(links.map((l) => [l.id, l])),
  getNodeById(id) {
    return nodes.find((n) => String(n.id) === String(id)) ?? null;
  },
});

const input = (name, link = null) => ({ name, link });
const output = (name, links = []) => ({ name, links });

/** The reporter's shape: subgraph node 6350 whose output rail feeds node 136's
 *  widget-converted `length` input. */
const fixtureBefore = () => {
  const n131 = { id: 131, outputs: [output("INT", [50])], inputs: [] };
  const n136 = {
    id: 136,
    inputs: [input("prompt", 51), input("width", 52), input("length", 53)],
    outputs: [],
  };
  const subgraphNode = {
    id: 6350,
    inputs: [input("int_in", 50)],
    outputs: [output("int_out", [53])],
    subgraph: { inputs: [{ name: "int_in", linkIds: [900] }] },
  };
  const links = [
    mkLink(50, 131, 0, 6350, 0), // 131.INT -> subgraph input rail
    mkLink(51, 6400, 0, 136, 0), // unrelated interior source -> 136.prompt
    mkLink(52, 6400, 1, 136, 1), // unrelated -> 136.width
    mkLink(53, 6350, 0, 136, 2), // subgraph output rail -> 136.length
  ];
  return { graph: mkGraph([n131, n136, subgraphNode], links), n131, n136, subgraphNode };
};

test("#1665 snapshot names external endpoints on BOTH sides of the wrapper", () => {
  const { graph, subgraphNode } = fixtureBefore();
  const snap = snapshotExternalLinks(graph, subgraphNode);
  assert.equal(snap.unverifiable.length, 0);
  assert.equal(snap.links.length, 2);
  const inbound = snap.links.find((l) => l.kind === "in");
  assert.deepEqual(inbound.source, { node_id: 131, slot: 0, name: "INT", type: null });
  assert.deepEqual(inbound.interior, []);
  assert.equal(inbound.identity_unresolved, false);
  assert.equal(inbound.rail, "int_in");
  assert.equal(inbound.consumers, 1);
  assert.equal(inbound.baseline, 1);
  const outbound = snap.links.find((l) => l.kind === "out");
  assert.deepEqual(outbound.target, { node_id: 136, slot: 2, name: "length", type: null });
  assert.equal(outbound.producer, null);
  assert.equal(outbound.identity_unresolved, false);
  assert.equal(outbound.rail, "int_out");
});

test("#1665 a clean unpack verifies every external link as restored", () => {
  const { graph, n136, subgraphNode } = fixtureBefore();
  const snap = snapshotExternalLinks(graph, subgraphNode);
  // Post-unpack: rail 6350 is gone; the inlined interior node 6367 now feeds
  // 136.length, and 131.INT feeds the inlined consumer 6368.
  n136.inputs[2].link = 60;
  graph.links.delete(50);
  graph.links.delete(53);
  graph.links.set(60, mkLink(60, 6367, 0, 136, 2));
  graph.links.set(61, mkLink(61, 131, 0, 6368, 0));
  const n6367 = { id: 6367, outputs: [output("INT", [60])], inputs: [] };
  const n6368 = { id: 6368, inputs: [input("a", 61)], outputs: [] };
  const graph2 = mkGraph([graph.getNodeById(131), n136, n6367, n6368], [...graph.links.values()]);
  const res = verifyExternalLinks(graph2, snap);
  assert.equal(res.restored, 2);
  assert.deepEqual(res.dropped, []);
});

test("#1665 the reporter's exact failure: widget-converted target comes back link:null with a ghost on the source", () => {
  const { graph, n136, subgraphNode } = fixtureBefore();
  const snap = snapshotExternalLinks(graph, subgraphNode);
  // Post-unpack reality from the issue: 136.length has connected_from null, but a
  // stale link id still claims the origin — the one-sided ghost. 131 kept its link.
  n136.inputs[2].link = null;
  graph.links.delete(50);
  graph.links.set(53, mkLink(53, 6367, 0, 136, 2)); // ghost: stored, never attached
  graph.links.set(61, mkLink(61, 131, 0, 6368, 0));
  const n6367 = { id: 6367, outputs: [output("INT", [53])], inputs: [] };
  const n6368 = { id: 6368, inputs: [input("a", 61)], outputs: [] };
  const graph2 = mkGraph([graph.getNodeById(131), n136, n6367, n6368], [...graph.links.values()]);
  const res = verifyExternalLinks(graph2, snap);
  assert.equal(res.restored, 1, "the 131.INT side survived");
  assert.equal(res.dropped.length, 1);
  assert.match(res.dropped[0], /136\.length/, "the dropped link is named, not indexed");
  assert.match(res.dropped[0], /subgraph output "int_out"/);
});

test("#1665 slot INDICES shifting (new dynamic slot) does not defeat the name-based check", () => {
  const { graph, n136, subgraphNode } = fixtureBefore();
  const snap = snapshotExternalLinks(graph, subgraphNode);
  // The measured report: 136 gained a dynamic ref_audio_1 slot, moving `length`.
  n136.inputs = [
    input("prompt", 51),
    input("width", 52),
    input("ref_audio_1", null), // new dynamic slot — length is now index 3
    input("length", 60),
  ];
  graph.links.delete(50);
  graph.links.delete(53);
  graph.links.set(60, mkLink(60, 6367, 0, 136, 3));
  graph.links.set(61, mkLink(61, 131, 0, 6368, 0));
  const n6367 = { id: 6367, outputs: [output("INT", [60])], inputs: [] };
  const n6368 = { id: 6368, inputs: [input("a", 61)], outputs: [] };
  const graph2 = mkGraph([graph.getNodeById(131), n136, n6367, n6368], [...graph.links.values()]);
  const res = verifyExternalLinks(graph2, snap);
  assert.equal(res.restored, 2);
  assert.deepEqual(res.dropped, []);
});

test("#1665 a target whose slot NAME vanished fails CLOSED as dropped", () => {
  const { graph, n136, subgraphNode } = fixtureBefore();
  const snap = snapshotExternalLinks(graph, subgraphNode);
  n136.inputs = [input("prompt", 51), input("width", 52)]; // dynamic re-slot ate `length`
  graph.links.delete(50);
  graph.links.delete(53);
  graph.links.set(61, mkLink(61, 131, 0, 6368, 0));
  const n6368 = { id: 6368, inputs: [input("a", 61)], outputs: [] };
  const graph2 = mkGraph([graph.getNodeById(131), n136, n6368], [...graph.links.values()]);
  const res = verifyExternalLinks(graph2, snap);
  assert.equal(res.restored, 1);
  assert.equal(res.dropped.length, 1);
  assert.match(res.dropped[0], /136\.length/);
});

test("#1665 a stored link that disagrees with the back-reference is NOT restored", () => {
  const { graph, n136, subgraphNode } = fixtureBefore();
  const snap = snapshotExternalLinks(graph, subgraphNode);
  // 136.length references link 60, but the stored link 60 claims a DIFFERENT target
  // slot — the re-slotted mismatch from the dynamic-input failure mode.
  n136.inputs[2].link = 60;
  graph.links.delete(50);
  graph.links.delete(53);
  graph.links.set(60, mkLink(60, 6367, 0, 136, 9));
  graph.links.set(61, mkLink(61, 131, 0, 6368, 0));
  const n6367 = { id: 6367, outputs: [output("INT", [60])], inputs: [] };
  const n6368 = { id: 6368, inputs: [input("a", 61)], outputs: [] };
  const graph2 = mkGraph([graph.getNodeById(131), n136, n6367, n6368], [...graph.links.values()]);
  const res = verifyExternalLinks(graph2, snap);
  assert.equal(res.dropped.length, 1);
  assert.match(res.dropped[0], /136\.length/);
});

test("#1665 inbound fan-out: every interior consumer must get a live link back", () => {
  // One rail link feeding TWO interior consumers; the unpack recreated only one.
  const n131 = { id: 131, outputs: [output("INT", [50])], inputs: [] };
  const subgraphNode = {
    id: 6350,
    inputs: [input("int_in", 50)],
    outputs: [],
    subgraph: { inputs: [{ name: "int_in", linkIds: [900, 901] }] },
  };
  const graph = mkGraph([n131, subgraphNode], [mkLink(50, 131, 0, 6350, 0)]);
  const snap = snapshotExternalLinks(graph, subgraphNode);
  assert.equal(snap.links[0].consumers, 2);
  assert.equal(snap.links[0].baseline, 1);

  const restoredOne = mkGraph(
    [n131, { id: 6368, inputs: [input("a", 61)], outputs: [] }],
    [mkLink(61, 131, 0, 6368, 0)],
  );
  const res1 = verifyExternalLinks(restoredOne, snap);
  assert.equal(res1.dropped.length, 1, "one of two consumers lost its feed");
  assert.match(res1.dropped[0], /fed 2 interior node\(s\)/);

  const restoredBoth = mkGraph(
    [
      n131,
      { id: 6368, inputs: [input("a", 61)], outputs: [] },
      { id: 6369, inputs: [input("b", 62)], outputs: [] },
    ],
    [mkLink(61, 131, 0, 6368, 0), mkLink(62, 131, 0, 6369, 0)],
  );
  const res2 = verifyExternalLinks(restoredBoth, snap);
  assert.equal(res2.restored, 1);
  assert.deepEqual(res2.dropped, []);
});

test("#1665 a pre-existing dangling link is UNVERIFIABLE, not a refusal — the unpack did not cause it", () => {
  const subgraphNode = {
    id: 6350,
    inputs: [input("ghost_in", 999)], // link id 999 is not in the link table
    outputs: [output("out", [])],
    subgraph: { inputs: [] },
  };
  const graph = mkGraph([subgraphNode], []);
  const snap = snapshotExternalLinks(graph, subgraphNode);
  assert.equal(snap.links.length, 0);
  assert.equal(snap.unverifiable.length, 1);
  const res = verifyExternalLinks(graph, snap);
  assert.deepEqual(res.dropped, []);
  assert.equal(res.unverifiable.length, 1);
  assert.match(res.unverifiable[0], /ghost_in/);
});

test("#1665 object-keyed link tables (older LiteGraph) verify the same", () => {
  const n136 = { id: 136, inputs: [input("length", 53)], outputs: [] };
  const subgraphNode = {
    id: 6350,
    inputs: [],
    outputs: [output("int_out", [53])],
    subgraph: { inputs: [] },
  };
  const graph = mkGraph([n136, subgraphNode], [mkLink(53, 6350, 0, 136, 0)], { asMap: false });
  const snap = snapshotExternalLinks(graph, subgraphNode);
  assert.equal(snap.links.length, 1);
  // Post-unpack: link re-created from the inlined node, still object-keyed.
  const graph2 = mkGraph(
    [n136, { id: 6367, outputs: [output("INT", [60])], inputs: [] }],
    [mkLink(60, 6367, 0, 136, 0)],
    { asMap: false },
  );
  n136.inputs[0].link = 60;
  const res = verifyExternalLinks(graph2, snap);
  assert.equal(res.restored, 1);
  assert.deepEqual(res.dropped, []);
});

const inputT = (name, link, type) => ({ name, link, type });
const outputT = (name, links, type) => ({ name, links, type });

/** Reporter's MiniMaxH3 shape: dotted autogrow children plus shared INT rails. */
function minimaxUnpackFixture() {
  const load = { id: 10, outputs: [outputT("IMAGE", [50], "IMAGE")], inputs: [] };
  const res = { id: 11, outputs: [outputT("INT", [51], "INT")], inputs: [] };
  const inner = {
    id: 136,
    inputs: [
      inputT("prompt", null, "STRING"),
      inputT("ref_images.ref_image_0", 900, "IMAGE"),
      inputT("ref_videos.ref_video_0", null, "VIDEO"),
      inputT("width", 901, "INT"),
    ],
    outputs: [],
  };
  const interiorLinks = [mkLink(900, -10, 0, 136, 1), mkLink(901, -10, 1, 136, 3)];
  const subgraphNode = {
    id: 6350,
    inputs: [inputT("ref_images", 50, "IMAGE"), inputT("width", 51, "INT")],
    outputs: [],
    subgraph: {
      inputs: [
        { name: "ref_images", type: "IMAGE", linkIds: [900] },
        { name: "width", type: "INT", linkIds: [901] },
      ],
      _links: new Map(interiorLinks.map((l) => [l.id, l])),
      _nodes: [inner],
      getNodeById(id) {
        return this._nodes.find((n) => String(n.id) === String(id)) ?? null;
      },
    },
  };
  return {
    graph: mkGraph([load, res, subgraphNode], [mkLink(50, 10, 0, 6350, 0), mkLink(51, 11, 0, 6350, 1)]),
    inner,
    subgraphNode,
  };
}

function scrambledMinimaxGraph(inner) {
  inner.inputs = [
    inputT("prompt", null, "STRING"),
    inputT("ref_images.ref_image_0", null, "IMAGE"),
    inputT("ref_videos.ref_video_0", 60, "VIDEO"),
    inputT("width", 61, "INT"),
  ];
  return mkGraph(
    [
      { id: 10, outputs: [outputT("IMAGE", [60], "IMAGE")], inputs: [] },
      { id: 11, outputs: [outputT("INT", [61], "INT")], inputs: [] },
      inner,
    ],
    [mkLink(60, 10, 0, 136, 2), mkLink(61, 11, 0, 136, 3)],
  );
}

test("#2887 snapshot names interior autogrow children, not just the rail", () => {
  const { graph, subgraphNode } = minimaxUnpackFixture();
  const snap = snapshotExternalLinks(graph, subgraphNode);
  assert.equal(snap.unverifiable.length, 0);
  const imageIn = snap.links.find((l) => l.rail === "ref_images");
  assert.deepEqual(imageIn.interior, [{ node_id: 136, name: "ref_images.ref_image_0", type: "IMAGE" }]);
  assert.equal(imageIn.identity_unresolved, false);
  const widthIn = snap.links.find((l) => l.rail === "width");
  assert.deepEqual(widthIn.interior, [{ node_id: 136, name: "width", type: "INT" }]);
});

test("#2887 a count-matching scramble onto ref_videos is DROPPED, not restored", () => {
  const { graph, inner, subgraphNode } = minimaxUnpackFixture();
  const snap = snapshotExternalLinks(graph, subgraphNode);
  const graph2 = scrambledMinimaxGraph(inner);
  const res = verifyExternalLinks(graph2, snap);
  assert.equal(res.restored, 1, "the INT width rail still sits on width");
  assert.equal(res.dropped.length, 1);
  assert.match(res.dropped[0], /ref_images\.ref_image_0/);
  assert.match(res.dropped[0], /10\.IMAGE/);
});

test("#2887 reseat moves the IMAGE off ref_videos onto the unique named child", () => {
  const { graph, inner, subgraphNode } = minimaxUnpackFixture();
  const snap = snapshotExternalLinks(graph, subgraphNode);
  const graph2 = scrambledMinimaxGraph(inner);
  const moved = reseatExternalLinksByIdentity(graph2, snap);
  assert.ok(moved >= 1);
  assert.equal(inner.inputs[1].link, 60, "ref_images.ref_image_0 holds the IMAGE");
  assert.equal(inner.inputs[2].link, null, "ref_videos is empty again");
  const res = verifyExternalLinks(graph2, snap);
  assert.equal(res.restored, 2);
  assert.deepEqual(res.dropped, []);
});

test("#2887 duplicate child names fail closed instead of reseating onto a guess", () => {
  const { graph, inner, subgraphNode } = minimaxUnpackFixture();
  const snap = snapshotExternalLinks(graph, subgraphNode);
  inner.inputs = [
    inputT("ref_images.ref_image_0", 60, "IMAGE"),
    inputT("ref_images.ref_image_0", null, "IMAGE"),
    inputT("ref_videos.ref_video_0", null, "VIDEO"),
    inputT("width", 61, "INT"),
  ];
  const graph2 = mkGraph(
    [
      { id: 10, outputs: [outputT("IMAGE", [60], "IMAGE")], inputs: [] },
      { id: 11, outputs: [outputT("INT", [61], "INT")], inputs: [] },
      inner,
    ],
    [mkLink(60, 10, 0, 136, 0), mkLink(61, 11, 0, 136, 3)],
  );
  assert.equal(reseatExternalLinksByIdentity(graph2, snap), 0);
  const res = verifyExternalLinks(graph2, snap);
  assert.match(res.dropped.join("\n"), /ref_images\.ref_image_0/);
});

test("#2887 an unreadable interior store with a live linkId is unresolved identity", () => {
  const load = { id: 10, outputs: [outputT("IMAGE", [50], "IMAGE")], inputs: [] };
  const subgraphNode = {
    id: 6350,
    inputs: [inputT("ref_images", 50, "IMAGE")],
    outputs: [],
    subgraph: {
      inputs: [{ name: "ref_images", type: "IMAGE", linkIds: [900] }],
      _links: new Map(),
      _nodes: [],
    },
  };
  const graph = mkGraph([load, subgraphNode], [mkLink(50, 10, 0, 6350, 0)]);
  const snap = snapshotExternalLinks(graph, subgraphNode);
  assert.equal(snap.links[0].identity_unresolved, true);
  assert.deepEqual(snap.links[0].interior, []);
  const after = mkGraph(
    [load, { id: 136, inputs: [inputT("ref_images.ref_image_0", 60, "IMAGE")], outputs: [] }],
    [mkLink(60, 10, 0, 136, 0)],
  );
  const res = verifyExternalLinks(after, snap);
  assert.equal(res.dropped.length, 1);
});

