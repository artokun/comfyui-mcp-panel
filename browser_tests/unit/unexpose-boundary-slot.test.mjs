/**
 * #1294 — a supported way to REMOVE a subgraph boundary slot. Before this, the
 * boundary surface had expose/move but no unexpose; the only path was deleting
 * the interior node feeding the slot.
 *
 * These tests run the REAL shipped executors, extracted from
 * web/js/comfyui-mcp-panel.js and given LiteGraph-shaped doubles, with the REAL
 * rail-slot helpers injected — so deleting the wiring from the panel source (not
 * merely from the helper module) fails them, the lesson connect-throw-verdict
 * established for the expose twin.
 *
 * The failure modes that matter for a DESTRUCTIVE op:
 *  - unknown name / rail id: refuse, remove nothing;
 *  - a cancelable "removing-output" event: a clean return is NOT a removal;
 *  - a throw from removeOutput: the slot may be gone anyway — the live rail
 *    decides, and the throw is disclosed as a warning;
 *  - the wires that crossed the boundary are counted BEFORE the removal and
 *    reported, never silently dropped.
 *  - #1969: remaining host SubgraphNode links after a non-last splice must be
 *    re-pointed at the live index; a positional `inputs[i].link` check cannot
 *    see the stale target_slot / origin_slot graphToPrompt uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveRailSlotForRemoval, countHostRailLinks, reindexHostRailLinks } from "../../web/js/lib/rail-slot.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

/** The method source between its signature line and the first `  },` line. */
function sliceMethod(signature) {
  const lines = panelSrc.split("\n");
  const start = lines.findIndex((l) => l === signature);
  assert.ok(start >= 0, `could not locate "${signature}" in the panel source`);
  const end = lines.findIndex((l, i) => i > start && l === "  },");
  assert.ok(end > start, `could not locate the end of "${signature}"`);
  return lines.slice(start, end + 1).join("\n");
}

const unexposeOutSrc = sliceMethod("  graph_unexpose_subgraph_output({ name }) {");
const unexposeInSrc = sliceMethod("  graph_unexpose_subgraph_input({ name }) {");

function buildExecutors(graph, rootGraph, canvas = {}, src = { out: unexposeOutSrc, inn: unexposeInSrc }) {
  const factory = new Function(
    "getGraphCtx",
    "resolveRailSlotForRemoval",
    "countHostRailLinks",
    "reindexHostRailLinks",
    "findSubgraphHostNode",
    `const GRAPH_TOOL_EXECUTORS = {
${src.out}
${src.inn}
};
return GRAPH_TOOL_EXECUTORS;`,
  );
  return factory(
    () => ({ graph, canvas, rootGraph }),
    resolveRailSlotForRemoval,
    countHostRailLinks,
    reindexHostRailLinks,
    () => null, // findSubgraphHostNode — no promoted views to refresh in a double
  );
}

/** The #1969 reporter shape: STRING `text` at index 3, remaining IMAGE host links
 *  later on the rail. `removeInput` splices the rail AND the host slots in lockstep
 *  (frontend) but does NOT rewrite remaining link.target_slot — that is the bug. */
function mkShiftedInputGraph() {
  const names = ["unet_name", "clip_name", "vae_name", "text", "image", "image_1", "noise_seed"];
  const hostCalls = { disconnectInput: 0, connect: 0 };
  const subgraph = {
    inputs: names.map((name) => ({
      name,
      type: name.startsWith("image") ? "IMAGE" : name === "text" ? "STRING" : "COMBO",
      linkIds: name === "text" ? [7] : [],
    })),
    outputs: [],
    outputNode: { id: -20 },
    inputNode: { id: -10 },
    setDirtyCanvas() {},
  };
  const imageLink = { id: 10, origin_id: 1, origin_slot: 0, target_id: 92, target_slot: 4, type: "IMAGE" };
  const image1Link = { id: 11, origin_id: 2, origin_slot: 0, target_id: 92, target_slot: 5, type: "IMAGE" };
  const vaeLink = { id: 9, origin_id: 3, origin_slot: 0, target_id: 92, target_slot: 2, type: "COMBO" };
  const links = { 9: vaeLink, 10: imageLink, 11: image1Link };
  const host = {
    id: 92,
    subgraph,
    inputs: names.map((name) => ({
      name,
      link: name === "image" ? 10 : name === "image_1" ? 11 : name === "vae_name" ? 9 : null,
    })),
    outputs: [],
    disconnectInput() { hostCalls.disconnectInput++; },
    connect() { hostCalls.connect++; },
  };
  const rootGraph = {
    _nodes: [host],
    links,
    getLink: (id) => links[id] ?? null,
  };
  host.graph = rootGraph;
  subgraph.removeInput = (slot) => {
    const i = subgraph.inputs.indexOf(slot);
    if (i < 0) return;
    subgraph.inputs.splice(i, 1);
    host.inputs.splice(i, 1);
  };
  subgraph.removeOutput = () => {};
  return { subgraph, host, rootGraph, imageLink, image1Link, vaeLink, hostCalls };
}

function mkShiftedOutputGraph() {
  const names = ["latent", "images", "mask"];
  const hostCalls = { disconnectOutput: 0, connect: 0 };
  const subgraph = {
    outputs: names.map((name) => ({ name, type: name === "latent" ? "LATENT" : "IMAGE", linkIds: [] })),
    inputs: [],
    outputNode: { id: -20 },
    inputNode: { id: -10 },
    setDirtyCanvas() {},
  };
  const imagesLink = { id: 20, origin_id: 5, origin_slot: 1, target_id: 8, target_slot: 0, type: "IMAGE" };
  const maskLink = { id: 21, origin_id: 5, origin_slot: 2, target_id: 9, target_slot: 0, type: "MASK" };
  const links = { 20: imagesLink, 21: maskLink };
  const host = {
    id: 5,
    subgraph,
    inputs: [],
    outputs: [
      { name: "latent", links: [] },
      { name: "images", links: [20] },
      { name: "mask", links: [21] },
    ],
    disconnectOutput() { hostCalls.disconnectOutput++; },
    connect() { hostCalls.connect++; },
  };
  const rootGraph = {
    _nodes: [host],
    links,
    getLink: (id) => links[id] ?? null,
  };
  host.graph = rootGraph;
  subgraph.removeOutput = (slot) => {
    const i = subgraph.outputs.indexOf(slot);
    if (i < 0) return;
    subgraph.outputs.splice(i, 1);
    host.outputs.splice(i, 1);
  };
  subgraph.removeInput = () => {};
  return { subgraph, host, rootGraph, imagesLink, maskLink, hostCalls };
}

/**
 * A subgraph double with one output slot ("images", carrying one interior link)
 * and one input slot ("model"). `removeOutput`/`removeInput` splice the slot out
 * the way LGraph does when no listener cancels.
 */
function mkSubgraph() {
  const calls = { removeOutput: 0, removeInput: 0 };
  const subgraph = {
    outputs: [{ name: "images", type: "IMAGE", linkIds: [41] }],
    inputs: [{ name: "model", type: "MODEL", linkIds: [7, 8] }],
    outputNode: { id: -20 },
    inputNode: { id: -10 },
    removeOutput(slot) {
      calls.removeOutput++;
      this.outputs.splice(this.outputs.indexOf(slot), 1);
    },
    removeInput(slot) {
      calls.removeInput++;
      this.inputs.splice(this.inputs.indexOf(slot), 1);
    },
    setDirtyCanvas() {},
  };
  return { subgraph, calls };
}

/** A root graph hosting the subgraph on one SubgraphNode with wires attached. */
function mkRootGraph(subgraph, { hostOutputLinks = 0, hostInputLink = false } = {}) {
  const host = {
    id: 5,
    subgraph,
    outputs: [{ links: Array.from({ length: hostOutputLinks }, (_, i) => 100 + i) }],
    inputs: [{ link: hostInputLink ? 200 : null }],
  };
  return { _nodes: [host] };
}

test("#1294 unexpose OUTPUT removes the named slot and reports what it dropped", () => {
  const { subgraph, calls } = mkSubgraph();
  const rootGraph = mkRootGraph(subgraph, { hostOutputLinks: 2 });
  const res = buildExecutors(subgraph, rootGraph).graph_unexpose_subgraph_output({ name: "images" });
  assert.equal(calls.removeOutput, 1);
  assert.equal(subgraph.outputs.length, 0);
  assert.deepEqual(res.removed, {
    side: "output",
    name: "images",
    type: "IMAGE",
    slot: 0,
    interior_links_dropped: 1,
    host_links_dropped: 2,
    host_links_reindexed: true,
  });
  assert.equal(res.warning, undefined);
});

test("#1294 unexpose INPUT counts the host input's single .link", () => {
  const { subgraph, calls } = mkSubgraph();
  const rootGraph = mkRootGraph(subgraph, { hostInputLink: true });
  const res = buildExecutors(subgraph, rootGraph).graph_unexpose_subgraph_input({ name: "model" });
  assert.equal(calls.removeInput, 1);
  assert.equal(subgraph.inputs.length, 0);
  assert.equal(res.removed.side, "input");
  assert.equal(res.removed.interior_links_dropped, 2);
  assert.equal(res.removed.host_links_dropped, 1);
});

test("#1294 an unknown name refuses and removes NOTHING", () => {
  const { subgraph, calls } = mkSubgraph();
  const rootGraph = mkRootGraph(subgraph);
  assert.throws(
    () => buildExecutors(subgraph, rootGraph).graph_unexpose_subgraph_output({ name: "latent" }),
    /No output boundary slot "latent" on this subgraph — nothing was removed\. Available output slots: images/,
  );
  assert.equal(calls.removeOutput, 0);
  assert.equal(subgraph.outputs.length, 1);
});

test("#1294 a rail_node_id is refused by name — it is the whole rail, not a slot", () => {
  const { subgraph, calls } = mkSubgraph();
  const rootGraph = mkRootGraph(subgraph);
  assert.throws(
    () => buildExecutors(subgraph, rootGraph).graph_unexpose_subgraph_output({ name: "-20" }),
    /rail_node_id/,
  );
  assert.equal(calls.removeOutput, 0);
  assert.equal(subgraph.outputs.length, 1);
});

test("#1294 a CANCELED removal (slot still on the rail) is a failure, not a success", () => {
  const { subgraph } = mkSubgraph();
  // A listener canceled the "removing-output" event: clean return, slot stays.
  subgraph.removeOutput = () => {};
  const rootGraph = mkRootGraph(subgraph);
  assert.throws(
    () => buildExecutors(subgraph, rootGraph).graph_unexpose_subgraph_output({ name: "images" }),
    /still on the rail after removeOutput returned/,
  );
});

test("#1294 a THROW with the slot gone is a landed removal carrying a warning", () => {
  const { subgraph } = mkSubgraph();
  const real = subgraph.removeOutput.bind(subgraph);
  subgraph.removeOutput = (slot) => {
    real(slot);
    throw new Error("hook exploded");
  };
  const rootGraph = mkRootGraph(subgraph);
  const res = buildExecutors(subgraph, rootGraph).graph_unexpose_subgraph_output({ name: "images" });
  assert.equal(res.removed.name, "images");
  assert.match(res.warning, /hook exploded/);
  assert.match(res.warning, /removal landed despite the throw/);
});

test("#1294 the ROOT graph is refused — unexpose runs INSIDE a subgraph", () => {
  const { subgraph } = mkSubgraph();
  // graph === rootGraph: the caller never entered the subgraph.
  assert.throws(
    () => buildExecutors(subgraph, subgraph).graph_unexpose_subgraph_output({ name: "images" }),
    /must be run INSIDE a subgraph/,
  );
});

test("#1969 unexpose INPUT of a non-last slot reindexes remaining host links", () => {
  const { subgraph, host, rootGraph, imageLink, image1Link, vaeLink, hostCalls } = mkShiftedInputGraph();
  const res = buildExecutors(subgraph, rootGraph).graph_unexpose_subgraph_input({ name: "text" });
  assert.equal(res.removed.slot, 3);
  assert.equal(res.removed.host_links_reindexed, true, "#2473 MCP must see that the panel reindexed");
  assert.equal(host.inputs.map((s) => s.name).join(","), "unet_name,clip_name,vae_name,image,image_1,noise_seed");
  // The live backlink still names the same wires — that is what query/outline see.
  assert.equal(host.inputs[3].link, 10);
  assert.equal(host.inputs[4].link, 11);
  // Serialization reads target_slot. After removing index 3, image must be 3 and
  // image_1 must be 4 — leaving 4 and 5 is the queue-time miss.
  assert.equal(imageLink.target_slot, 3);
  assert.equal(image1Link.target_slot, 4);
  assert.equal(vaeLink.target_slot, 2, "slots before the removal must not be rewritten");
  assert.equal(hostCalls.disconnectInput, 0, "reindex must not disconnect (#668)");
  assert.equal(hostCalls.connect, 0, "reindex must not reconnect");
});

test("#1969 unexpose OUTPUT of a non-last slot reindexes remaining host links", () => {
  const { subgraph, host, rootGraph, imagesLink, maskLink, hostCalls } = mkShiftedOutputGraph();
  buildExecutors(subgraph, rootGraph).graph_unexpose_subgraph_output({ name: "latent" });
  assert.equal(host.outputs.map((s) => s.name).join(","), "images,mask");
  assert.equal(imagesLink.origin_slot, 0);
  assert.equal(maskLink.origin_slot, 1);
  assert.equal(hostCalls.disconnectOutput, 0);
  assert.equal(hostCalls.connect, 0);
});

test("#1969 stripping the reindex call leaves remaining host links at the old index", () => {
  const strip = (src) => src.replace(/\s*reindexHostRailLinks\([^;]+;/g, "");
  const { subgraph, rootGraph, imageLink, image1Link } = mkShiftedInputGraph();
  const res = buildExecutors(subgraph, rootGraph, {}, { out: strip(unexposeOutSrc), inn: strip(unexposeInSrc) })
    .graph_unexpose_subgraph_input({ name: "text" });
  assert.equal(res.removed.name, "text");
  assert.equal(imageLink.target_slot, 4, "without reindex, image still points at the pre-splice index");
  assert.equal(image1Link.target_slot, 5, "without reindex, image_1 still points at the pre-splice index");
});

test("#1969 a last-slot unexpose does not rewrite earlier host links", () => {
  const { subgraph, host, rootGraph, imageLink, image1Link, vaeLink } = mkShiftedInputGraph();
  buildExecutors(subgraph, rootGraph).graph_unexpose_subgraph_input({ name: "noise_seed" });
  assert.equal(host.inputs.at(-1).name, "image_1");
  assert.equal(imageLink.target_slot, 4);
  assert.equal(image1Link.target_slot, 5);
  assert.equal(vaeLink.target_slot, 2);
});

test("#1969 a canceled removal does not reindex remaining host links", () => {
  const { subgraph, rootGraph, imageLink, image1Link } = mkShiftedInputGraph();
  subgraph.removeInput = () => {};
  assert.throws(
    () => buildExecutors(subgraph, rootGraph).graph_unexpose_subgraph_input({ name: "text" }),
    /still on the rail after removeInput returned/,
  );
  assert.equal(imageLink.target_slot, 4);
  assert.equal(image1Link.target_slot, 5);
});
