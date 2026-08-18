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
  assert.match(note, /STORED/i, "says the inner stored value is what executes");
  assert.match(note, /does NOT reach the prompt|dropped from the prompt/i);
  // The remedy the reporter verified: a BACKEND primitive carries the value.
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
  assert.match(tag, /NOT what executes|not serialized|stored value/i);
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
  const blockEnd = src.indexOf("return accept;", exempt);
  assert.ok(exempt > 0 && scan > blockEnd - 4000 && scan < blockEnd, "scan runs outside the scoped-run exemption");
});

test("#1181 the promoted-write refusal names the real repairs when the outer feed is virtual", () => {
  const src = readFileSync(WIDGET_WRITE_JS, "utf8");
  assert.match(src, /isNonSerializingValueSource\(origin\)/, "the refusal inspects the outer link's origin");
  assert.match(src, /does NOT cross the subgraph boundary/, "the corrected refusal says what happens");
  // The generic #366 refusal must still exist for real-source / nested-promotion cases.
  assert.match(src, /parent rail widget could not be identified/, "the generic refusal is kept");
});
