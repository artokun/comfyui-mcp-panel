/**
 * #1181 — a frontend-only virtual PrimitiveNode wired INTO a promoted subgraph
 * input never reaches the prompt: ComfyUI's graphToPrompt DROPS the virtual node,
 * so the link carries nothing across the subgraph boundary and the inner node's
 * STORED widget value is what serializes. The panel read path claimed the exact
 * opposite ("the value in `widgets` is the stale stored value, NOT what
 * executes"), and panel_run queued the stale prompt in silence.
 *
 * Reported on ComfyUI 0.32.0 / frontend 1.48.7: the flattened CLIPTextEncode
 * kept the old internal widget text and the virtual PrimitiveNode was absent
 * from the execution graph; swapping the primitive for a BACKEND
 * PrimitiveStringMultiline made the source node appear in the prompt and the
 * rendered subject change as requested.
 *
 * The panel does not build this prompt and cannot carry the value itself — what
 * it can do, and what these pin, is stop asserting the backwards claim and stop
 * queueing in silence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  isNonSerializingValueSource,
  virtualFedInputs,
  collectVirtualSourceFeeds,
  virtualSourceNote,
  virtualSourceTag,
  linkedSourcePayload,
  applyLinkedSubgraphValuesToPrompt,
  installGraphToPromptVirtualSourceApply,
} from "../../web/js/lib/virtual-source-promotion.js";

// ---- fixtures ---------------------------------------------------------------

const primitive = (id, value = "a lantern") => ({
  id,
  type: "PrimitiveNode",
  isVirtualNode: true,
  widgets: [{ name: "value", value }],
});
const backendNode = (id, type = "PrimitiveStringMultiline") => ({
  id,
  type,
  constructor: { nodeData: {} },
});

/** A subgraph container whose input `text` is fed by link 7. */
const container = (id, inner = [], linkId = 7) => ({
  id,
  type: "some-subgraph-uuid",
  subgraph: { _nodes: inner },
  widgets: [{ name: "text", value: "OLD stored text" }],
  inputs: [{ name: "text", type: "STRING", link: linkId, _widget: { name: "text" } }],
});

/** A graph holding `nodes` plus `links` in the object form the live graph uses. */
const graphOf = (nodes, links = {}) => ({ _nodes: nodes, links });

const primitiveFeed = () =>
  graphOf(
    [primitive(85), container(10)],
    { 7: { origin_id: 85, origin_slot: 0 } },
  );

// ---- isNonSerializingValueSource --------------------------------------------

test("#1181 a virtual PrimitiveNode is a non-serializing value source", () => {
  assert.equal(isNonSerializingValueSource(primitive(85)), true);
});

test("#1181 a backend node is NOT a non-serializing source — its value DOES cross the boundary", () => {
  // The reporter verified this direction: a backend PrimitiveStringMultiline
  // wired the same way appears in the execution graph and drives the value.
  assert.equal(isNonSerializingValueSource(backendNode(85)), false);
});

test("#1181 a subgraph container is never a value source, even though it is virtual", () => {
  assert.equal(
    isNonSerializingValueSource({ id: 1, isVirtualNode: true, subgraph: { _nodes: [] } }),
    false,
  );
});

test("#1181 a virtual node with a CONNECTED input can relay a real value — not flagged", () => {
  assert.equal(
    isNonSerializingValueSource({
      id: 2,
      isVirtualNode: true,
      inputs: [{ name: "in", link: 3 }],
    }),
    false,
  );
});

test("#1181 a bare virtual node with nothing to forward IS flagged", () => {
  assert.equal(isNonSerializingValueSource({ id: 2, isVirtualNode: true, inputs: [] }), true);
});

test("#1181 GetNode is a bus relay graphToPrompt resolves, not a dropped value source", () => {
  // Krea2 wires Get_VAE / Get_CLIP into the subgraph. Clause 2 used to flag any
  // virtual node with no connected input, so panel_run claimed GetNode was the
  // non-source PrimitiveNode is. The widget is the bus NAME, not a payload.
  assert.equal(
    isNonSerializingValueSource({
      id: 59,
      type: "GetNode",
      isVirtualNode: true,
      inputs: [],
      widgets: [{ name: "value", value: "VAE" }],
    }),
    false,
  );
  assert.equal(
    isNonSerializingValueSource({
      id: 32,
      type: "SetNode",
      isVirtualNode: true,
      inputs: [{ name: "VAE", link: 1 }],
    }),
    false,
  );
  assert.equal(
    linkedSourcePayload({
      id: 59,
      type: "GetNode",
      isVirtualNode: true,
      widgets: [{ name: "value", value: "VAE" }],
    }),
    undefined,
  );
});

test("#1181 malformed/missing nodes fail safe: not a source, never a throw", () => {
  assert.equal(isNonSerializingValueSource(null), false);
  assert.equal(isNonSerializingValueSource(undefined), false);
  assert.equal(isNonSerializingValueSource({}), false);
});

// ---- virtualFedInputs ---------------------------------------------------------

test("#1181 a container input fed by a PrimitiveNode is reported, naming the source", () => {
  const g = primitiveFeed();
  const host = g._nodes[1];
  host.graph = g;
  const fed = virtualFedInputs(host);
  assert.deepEqual(fed, { text: { node_id: 85, output_slot: 0, origin_type: "PrimitiveNode" } });
});

test("#1181 the SAME wiring from a BACKEND source is not virtual-fed (the working case)", () => {
  const g = graphOf(
    [backendNode(85), container(10)],
    { 7: { origin_id: 85, origin_slot: 0 } },
  );
  g._nodes[1].graph = g;
  assert.deepEqual(virtualFedInputs(g._nodes[1]), {});
});

test("#1181 a non-container node is never virtual-fed, even with a primitive origin", () => {
  // Top-level PrimitiveNode → ordinary node WORKS (graphToPrompt resolves the
  // primitive into the consumer's widget); only the subgraph boundary loses it.
  const leaf = {
    id: 3,
    type: "CLIPTextEncode",
    widgets: [{ name: "text", value: "x" }],
    inputs: [{ name: "text", type: "STRING", link: 7 }],
  };
  const g = graphOf([primitive(85), leaf], { 7: { origin_id: 85, origin_slot: 0 } });
  leaf.graph = g;
  assert.deepEqual(virtualFedInputs(leaf), {});
});

test("#1181 array-form links and getNodeById-only graphs are read too", () => {
  const host = container(10);
  const nodes = [primitive(85), host];
  const g = {
    _nodes: nodes,
    links: { 7: [7, 85, 0, 10, 0, "STRING"] },
    getNodeById: (id) => nodes.find((n) => n.id === id),
  };
  host.graph = g;
  assert.deepEqual(virtualFedInputs(host), {
    text: { node_id: 85, output_slot: 0, origin_type: "PrimitiveNode" },
  });
});

test("#1181 a dangling link id or missing origin node yields no entry, never a throw", () => {
  const host = container(10, [], 99);
  const g = graphOf([host], {});
  host.graph = g;
  assert.deepEqual(virtualFedInputs(host), {});
  const host2 = container(11);
  const g2 = graphOf([host2], { 7: { origin_id: 404, origin_slot: 0 } });
  host2.graph = g2;
  assert.deepEqual(virtualFedInputs(host2), {});
});

test("#1181 an unlinked host input is not virtual-fed", () => {
  const host = container(10, [], null);
  const g = graphOf([host], {});
  host.graph = g;
  assert.deepEqual(virtualFedInputs(host), {});
});

// ---- collectVirtualSourceFeeds ------------------------------------------------

test("#1181 the run-time scan finds a primitive feed at the ROOT level", () => {
  const found = collectVirtualSourceFeeds(primitiveFeed());
  assert.equal(found.length, 1);
  assert.equal(found[0].subgraph_node_id, "10");
  assert.equal(found[0].input_name, "text");
  assert.equal(found[0].origin_id, "85");
  assert.equal(found[0].origin_type, "PrimitiveNode");
});

test("#1181 the scan descends into subgraphs (a feed one level down is still lost)", () => {
  const inner = [primitive(85), container(10)];
  const innerGraph = graphOf(inner, { 7: { origin_id: 85, origin_slot: 0 } });
  const outer = { id: 5, subgraph: innerGraph, inputs: [], widgets: [] };
  const root = graphOf([outer], {});
  const found = collectVirtualSourceFeeds(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].subgraph_node_id, "10");
});

test("#1181 a healthy graph reports nothing", () => {
  const g = graphOf(
    [backendNode(1, "KSampler"), backendNode(2, "SaveImage")],
    { 7: { origin_id: 1, origin_slot: 0 } },
  );
  assert.deepEqual(collectVirtualSourceFeeds(g), []);
});

test("#1181 a subgraph cycle terminates instead of hanging", () => {
  const a = { id: 1, inputs: [], widgets: [] };
  const b = { id: 2, inputs: [], widgets: [] };
  a.subgraph = graphOf([b], {});
  b.subgraph = graphOf([a], {}); // pathological self-reference
  assert.deepEqual(collectVirtualSourceFeeds(graphOf([a], {})), []);
});

// ---- virtualSourceNote --------------------------------------------------------

test("#1181 the queue-time note names the source and says the STORED value executes", () => {
  const note = virtualSourceNote(collectVirtualSourceFeeds(primitiveFeed()));
  assert.match(note, /PrimitiveNode #85/);
  assert.match(note, /subgraph #10/);
  assert.match(note, /"text"/);
  assert.match(note, /STORED/i, "names the inner stored fallback ComfyUI would serialize");
  assert.match(note, /DROPS that source|dropped from the prompt/i);
  assert.match(note, /compiles the linked/i, "says panel_run compiles the linked value into the prompt");
  assert.match(note, /backend/i);
});

test("#1181 no findings, no note", () => {
  assert.equal(virtualSourceNote([]), "");
  assert.equal(virtualSourceNote(null), "");
});

// ---- virtualSourceTag ---------------------------------------------------------

test("#1181 the outline/compact tag says the link value is NOT what executes", () => {
  const tag = virtualSourceTag({ node_id: 85, output_slot: 0 });
  assert.match(tag, /#85\.0/);
  assert.match(tag, /not serialized/i);
  assert.match(tag, /compiles the linked value into the prompt/i);
  assert.equal(virtualSourceTag(null), "");
});

// ---- wiring pins --------------------------------------------------------------
//
// The detector above is only worth anything where the reporter was misled: the
// read path (panel_query_graph / panel_graph_outline), the run path
// (panel_run → graph_run), and the write path (panel_set_widget on the promoted
// rail). These pin that the consumers actually CONSUME the lib — the pattern
// slot-labels.test.mjs established for module-local panel functions — so the
// detector cannot rot back into "perfectly correct and entirely unwired".

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const WIDGET_WRITE_JS = fileURLToPath(new URL("../../web/js/lib/widget-write.js", import.meta.url));

test("#1181 the read path splits virtual-fed widgets OUT of driven_by_link and says what executes", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /from "\.\/lib\/virtual-source-promotion\.js"/, "the panel imports the detector");
  assert.match(src, /const virtualFed = virtualFedInputs\(node\);/, "summarizeNode computes the virtual-fed set");
  assert.match(src, /fed_by_virtual_source: fedByVirtual/, "summarizeNode emits the corrected claim");
  assert.match(src, /source_not_serialized: true/, "inputs[].connected_from is annotated");
  // The outline and compact rows must not reuse drivenTag's backwards claim for these.
  assert.match(src, /virtualSourceTag\(vFed\[w\.name\]\)/, "the outline row tags virtual-fed widgets");
  assert.match(src, /vFed\[k\] \? virtualSourceTag\(vFed\[k\]\)/, "the compact row tags virtual-fed widgets");
});

test("#1181 graph_run discloses a virtual-fed subgraph input at QUEUE time, scoped runs included", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /collectVirtualSourceFeeds\(rootGraph\)/, "graph_run scans the root graph");
  assert.match(src, /accept\.virtual_source_feeds = virtualFeeds;/);
  assert.match(src, /accept\.virtual_source_note = virtualSourceNote\(virtualFeeds\);/);
  // Unlike #985's disabled-outputs scan, this one must NOT sit inside the
  // `if (!partialTargets)` exemption — a dropped source feeds nothing no matter
  // how the run is scoped. Pin that the scan comes AFTER that block closes.
  const exempt = src.indexOf("if (!partialTargets) {");
  const scan = src.indexOf("collectVirtualSourceFeeds(rootGraph)");
  const blockEnd = src.indexOf("return honestRunAck(downgradeUnstableRunResult(accept", exempt);
  assert.ok(exempt > 0 && scan > blockEnd - 4000 && scan < blockEnd, "scan runs outside the scoped-run exemption");
});

test("#1181 the promoted-write refusal names the real repairs when the outer feed is virtual", () => {
  const src = readFileSync(WIDGET_WRITE_JS, "utf8");
  assert.match(src, /isNonSerializingValueSource\(origin\)/, "the refusal inspects the outer link's origin");
  assert.match(src, /does NOT cross the subgraph boundary/, "the corrected refusal says what happens");
  // The generic #366 refusal must still exist for real-source / nested-promotion cases.
  assert.match(src, /parent rail widget could not be identified/, "the generic refusal is kept");
});

// ---- compiled-prompt apply (Krea2 recurrence) --------------------------------

function krea2LikeGraph() {
  const latent = {
    id: 76,
    type: "EmptyLatentImage",
    widgets: [
      { name: "width", value: 1920 },
      { name: "height", value: 1080 },
      { name: "batch_size", value: 1 },
    ],
    inputs: [],
  };
  const encode = {
    id: 15,
    type: "CLIPTextEncode",
    widgets: [{ name: "text", value: "" }],
    inputs: [
      { name: "clip", type: "CLIP", link: 42 },
      { name: "text", type: "STRING", link: 83, widget: { name: "text" } },
    ],
  };
  const anySwitch = {
    id: 72,
    type: "Any Switch (rgthree)",
    isVirtualNode: true,
    widgets: [],
    inputs: [
      { name: "any_01", type: "*", link: 97 },
      { name: "any_02", type: "*", link: null },
    ],
    outputs: [{ name: "*", type: "*", links: [83] }],
  };
  const inner = {
    _nodes: [latent, encode, anySwitch],
    inputNode: { id: -10 },
    links: [
      { id: 97, origin_id: -10, origin_slot: 4, target_id: 72, target_slot: 0, type: "*" },
      { id: 83, origin_id: 72, origin_slot: 0, target_id: 15, target_slot: 1, type: "STRING" },
      { id: 42, origin_id: -10, origin_slot: 1, target_id: 15, target_slot: 0, type: "CLIP" },
    ],
  };
  const promptNode = {
    id: 143,
    type: "PrimitiveStringMultiline",
    constructor: { nodeData: {} },
    outputs: [{ name: "STRING", type: "STRING", links: [153] }],
    widgets: [{ name: "value", value: "a lantern at dusk" }],
  };
  const getVae = {
    id: 59,
    type: "GetNode",
    isVirtualNode: true,
    inputs: [],
    outputs: [{ name: "VAE", type: "VAE", links: [84] }],
    widgets: [{ name: "value", value: "VAE" }],
  };
  const host = {
    id: 78,
    type: "21ffbd86-8db8-4fab-954b-2cd8ab0662da",
    subgraph: inner,
    properties: { proxyWidgets: [["76", "width"], ["76", "height"]] },
    widgets: [
      { name: "width", value: 1024 },
      { name: "height", value: 768 },
    ],
    inputs: [
      { name: "vae", type: "VAE", link: 84 },
      { name: "clip", type: "CLIP", link: 85 },
      { name: "model", type: "MODEL", link: 156 },
      { name: "positive", type: "CONDITIONING", link: 238 },
      { name: "any_01", type: "STRING", link: 153 },
      { name: "any_02", type: "STRING", link: null },
    ],
  };
  const g = graphOf(
    [getVae, promptNode, host],
    {
      84: { origin_id: 59, origin_slot: 0 },
      153: { origin_id: 143, origin_slot: 0 },
    },
  );
  host.graph = g;
  return g;
}

function staleKrea2Prompt() {
  return {
    output: {
      "78:76": {
        class_type: "EmptyLatentImage",
        inputs: { width: 1920, height: 1080, batch_size: 1 },
      },
      "78:15": {
        class_type: "CLIPTextEncode",
        inputs: { clip: ["1", 0], text: "" },
      },
    },
  };
}

test("#1181 GetNode feeding a subgraph is not a virtual-source feed", () => {
  const found = collectVirtualSourceFeeds(krea2LikeGraph());
  assert.equal(found.some((f) => f.origin_type === "GetNode"), false);
});

test("#1181 Krea2-like compiled prompt carries promoted width/height and the linked prompt", () => {
  const g = krea2LikeGraph();
  const prompt = staleKrea2Prompt();
  const n = applyLinkedSubgraphValuesToPrompt(g, prompt);
  assert.ok(n >= 3, `expected width, height, and text patches, got ${n}`);
  assert.equal(prompt.output["78:76"].inputs.width, 1024);
  assert.equal(prompt.output["78:76"].inputs.height, 768);
  assert.equal(prompt.output["78:15"].inputs.text, "a lantern at dusk");
  assert.equal(prompt.output["78:15"].inputs.clip[0], "1", "tensor links are left alone");
});

test("#1181 PrimitiveNode coverage is not weakened: it is still a non-serializing source", () => {
  assert.equal(isNonSerializingValueSource(primitive(85, "a lantern")), true);
  const g = primitiveFeed();
  const prompt = {
    output: {
      "10:3": { class_type: "CLIPTextEncode", inputs: { text: "OLD stored text" } },
    },
  };
  // primitiveFeed's container has no inner CLIPTextEncode — pin the detector still fires.
  const found = collectVirtualSourceFeeds(g);
  assert.equal(found.length, 1);
  assert.equal(found[0].origin_type, "PrimitiveNode");
  applyLinkedSubgraphValuesToPrompt(g, prompt);
});

test("#1181 PrimitiveNode linked into a subgraph STRING input is copied onto the inner prompt node", () => {
  const innerNode = {
    id: 3,
    type: "CLIPTextEncode",
    widgets: [{ name: "text", value: "OLD stored text" }],
    inputs: [{ name: "text", type: "STRING", link: 1, widget: { name: "text" } }],
  };
  const innerGraph = {
    _nodes: [innerNode],
    inputNode: { id: -10 },
    links: [{ id: 1, origin_id: -10, origin_slot: 0, target_id: 3, target_slot: 0, type: "STRING" }],
  };
  const host = container(10);
  host.subgraph = innerGraph;
  host.inputs = [{ name: "text", type: "STRING", link: 7, _widget: { name: "text" } }];
  const g = graphOf([primitive(85, "a lantern at dusk"), host], { 7: { origin_id: 85, origin_slot: 0 } });
  host.graph = g;
  const prompt = {
    output: { "10:3": { class_type: "CLIPTextEncode", inputs: { text: "OLD stored text" } } },
  };
  applyLinkedSubgraphValuesToPrompt(g, prompt);
  assert.equal(prompt.output["10:3"].inputs.text, "a lantern at dusk");
});

test("#1181 graphToPrompt wrap patches the compiled prompt and does not mutate live inner widgets", async () => {
  const g = krea2LikeGraph();
  const inner = g._nodes[2].subgraph._nodes[0];
  const app = {
    graph: g,
    graphToPrompt: () => staleKrea2Prompt(),
  };
  assert.equal(installGraphToPromptVirtualSourceApply(app), true);
  assert.equal(installGraphToPromptVirtualSourceApply(app), true, "idempotent");
  const prompt = await app.graphToPrompt();
  assert.equal(prompt.output["78:76"].inputs.width, 1024);
  assert.equal(prompt.output["78:15"].inputs.text, "a lantern at dusk");
  assert.equal(inner.widgets[0].value, 1920, "live inner stored value is untouched");
});

test("#1181 graph_run installs the virtual-source prompt apply before the snapshot barrier", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const apply = src.indexOf("installGraphToPromptVirtualSourceApply(app)");
  const snapshot = src.indexOf("installGraphToPromptSnapshotBarrier(app)");
  const preflight = src.indexOf("const preflightBuild = await withTimeout(");
  assert.ok(apply > 0, "graph_run must install the virtual-source prompt apply");
  assert.ok(snapshot > apply, "snapshot barrier stays outermost");
  assert.ok(preflight > snapshot, "apply is installed before pre-flight serialize");
});
