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
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveRailSlotForRemoval, countHostRailLinks } from "../../web/js/lib/rail-slot.js";

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

function buildExecutors(graph, rootGraph, canvas = {}) {
  const factory = new Function(
    "getGraphCtx",
    "resolveRailSlotForRemoval",
    "countHostRailLinks",
    "findSubgraphHostNode",
    `const GRAPH_TOOL_EXECUTORS = {
${unexposeOutSrc}
${unexposeInSrc}
};
return GRAPH_TOOL_EXECUTORS;`,
  );
  return factory(
    () => ({ graph, canvas, rootGraph }),
    resolveRailSlotForRemoval,
    countHostRailLinks,
    () => null, // findSubgraphHostNode — no promoted views to refresh in a double
  );
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
