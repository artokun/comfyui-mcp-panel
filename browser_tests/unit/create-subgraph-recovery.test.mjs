/**
 * #2267 — panel_create_subgraph whose HTTP reply is lost must be recoverable.
 *
 * convertToSubgraph moves the named nodes into the wrapper. A retry of the same
 * ids must return that wrapper (and must not convert leftover siblings). These
 * drive the shipped recoverConvertedSubgraph / graph_create_subgraph / mutation
 * receipt functions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  danglingInputLinks,
  disconnectedBoundaryInputs,
  brokenConversionRefusal,
  brokenConversionWarning,
  detachedConversionNodes,
  detachedConversionRefusal,
  conversionSnapshot,
  conversionThrowReport,
} from "../../web/js/lib/subgraph-conversion-integrity.js";
import {
  normalizeCreateSubgraphNodeIds,
  recoverConvertedSubgraph,
  recoveredCreateSubgraphResult,
  unresolvedCreateSubgraphNodesRefusal,
} from "../../web/js/lib/subgraph-conversion-recovery.js";
import {
  createMutationReceiptStore,
  resolveLateMutationReply,
} from "../../web/js/lib/mutation-receipt.js";
import { commandFingerprint } from "../../web/js/lib/command-dedupe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8");

test("#2267 normalizeCreateSubgraphNodeIds drops rails, dupes, and junk", () => {
  assert.deepEqual(normalizeCreateSubgraphNodeIds([10, "11", 10, -10, -20, "x", null]), [10, 11]);
  assert.deepEqual(normalizeCreateSubgraphNodeIds("not-an-array"), []);
  assert.deepEqual(normalizeCreateSubgraphNodeIds([]), []);
});

function hostWithInner(id, innerIds, extra = {}) {
  return {
    id,
    title: extra.title ?? "New Subgraph",
    subgraph: {
      name: extra.name ?? "New Subgraph",
      _nodes: [
        { id: -10 },
        { id: -20 },
        ...innerIds.map((nid) => ({ id: nid })),
      ],
    },
  };
}

test("#2267 recoverConvertedSubgraph returns the unique host that holds every named id", () => {
  const host = hostWithInner(302, [1, 2, 3]);
  const graph = {
    _nodes: [{ id: 4 }, host],
    getNodeById: (id) => (id === 4 ? graph._nodes[0] : null),
  };
  const recovered = recoverConvertedSubgraph({ graph, nodeIds: [1, 2, 3] });
  assert.equal(recovered, host);
  assert.equal(recoveredCreateSubgraphResult(recovered, [1, 2, 3]).subgraph.recovered, true);
  assert.equal(recoveredCreateSubgraphResult(recovered, [1, 2, 3]).subgraph.node_id, 302);
});

test("#2267 recoverConvertedSubgraph misses when any named node is still on this graph", () => {
  const host = hostWithInner(302, [1, 2, 3]);
  const live = { id: 1 };
  const graph = {
    _nodes: [live, host],
    getNodeById: (id) => (id === 1 ? live : null),
  };
  assert.equal(recoverConvertedSubgraph({ graph, nodeIds: [1, 2, 3] }), null);
});

test("#2267 recoverConvertedSubgraph misses when two hosts contain the set", () => {
  const a = hostWithInner(301, [1, 2, 3], { name: "A" });
  const b = hostWithInner(302, [1, 2, 3, 9], { name: "B" });
  const graph = { _nodes: [a, b], getNodeById: () => null };
  assert.equal(recoverConvertedSubgraph({ graph, nodeIds: [1, 2, 3] }), null);
});

test("#2267 recoverConvertedSubgraph misses when no host contains every id", () => {
  const host = hostWithInner(302, [1, 2]);
  const graph = { _nodes: [host], getNodeById: () => null };
  assert.equal(recoverConvertedSubgraph({ graph, nodeIds: [1, 2, 3] }), null);
});

test("#2267 unresolvedCreateSubgraphNodesRefusal names a lost-reply recovery path", () => {
  const missing = unresolvedCreateSubgraphNodesRefusal({
    what: "panel_create_subgraph",
    requested: [1, 2, 3],
    foundIds: [],
  });
  assert.match(missing, /none of the named nodes/);
  assert.match(missing, /panel_graph_outline/);
  const partial = unresolvedCreateSubgraphNodesRefusal({
    what: "panel_create_subgraph",
    requested: [1, 2, 3],
    foundIds: [1],
  });
  assert.match(partial, /only 1 of 3/);
  assert.match(partial, /wrap a different set/);
  assert.match(partial, /missing: 2, 3/);
});

function methodSource(name, args) {
  const match = PANEL_SRC.match(new RegExp(`${name}\\(${args}\\) \\{[\\s\\S]*?\\n  \\},`));
  assert.ok(match, `could not locate ${name} in panel source`);
  return match[0];
}

const createSource = methodSource("graph_create_subgraph", "\\{ node_ids \\}");
const runnerMatch = PANEL_SRC.match(
  /function convertSelectionToSubgraph\(\{ graph, canvas, nodes, what \}\) \{[\s\S]*?\r?\n\}/,
);
assert.ok(runnerMatch, "could not locate convertSelectionToSubgraph");
const landedMatch = PANEL_SRC.match(
  /function assertSubgraphNodeLanded\(res, graph, what\) \{[\s\S]*?\r?\n\}/,
);
const serializableMatch = PANEL_SRC.match(
  /function assertSubgraphConversionSerializable\(res, node, what\) \{[\s\S]*?\r?\n\}/,
);
const advisoriesMatch = PANEL_SRC.match(
  /function subgraphConversionAdvisories\(\{ disconnected, dangling, warning \}\) \{[\s\S]*?\r?\n\}/,
);

function shippedCreate(getGraphCtx) {
  const convertSelectionToSubgraph = new Function(
    "detachedConversionNodes",
    "detachedConversionRefusal",
    "conversionSnapshot",
    "conversionThrowReport",
    `return ${runnerMatch[0]};`,
  )(detachedConversionNodes, detachedConversionRefusal, conversionSnapshot, conversionThrowReport);
  return new Function(
    "getGraphCtx",
    "clearStaleRedFlagsAfterSubgraphConversion",
    "convertSelectionToSubgraph",
    "assertSubgraphNodeLanded",
    "assertSubgraphConversionSerializable",
    "subgraphConversionAdvisories",
    "normalizeCreateSubgraphNodeIds",
    "recoverConvertedSubgraph",
    "recoveredCreateSubgraphResult",
    "unresolvedCreateSubgraphNodesRefusal",
    `const executors = { ${createSource} }; return executors.graph_create_subgraph;`,
  )(
    getGraphCtx,
    () => {},
    convertSelectionToSubgraph,
    new Function(`return ${landedMatch[0]};`)(),
    new Function(
      "danglingInputLinks",
      "disconnectedBoundaryInputs",
      "brokenConversionRefusal",
      "brokenConversionWarning",
      `return ${serializableMatch[0]};`,
    )(danglingInputLinks, disconnectedBoundaryInputs, brokenConversionRefusal, brokenConversionWarning),
    new Function(`return ${advisoriesMatch[0]};`)(),
    normalizeCreateSubgraphNodeIds,
    recoverConvertedSubgraph,
    recoveredCreateSubgraphResult,
    unresolvedCreateSubgraphNodesRefusal,
  );
}

test("#2267 shipped graph_create_subgraph returns the existing wrapper without converting again", () => {
  const host = hostWithInner(302, [7, 8, 9]);
  host.subgraph._nodes.push(host); // landing check uses graph._nodes.includes(node)
  let converted = 0;
  const graph = {
    _nodes: [host],
    getNodeById: () => null,
    convertToSubgraph: () => {
      converted += 1;
      return { node: host, subgraph: host.subgraph };
    },
    setDirtyCanvas: () => {},
    beforeChange: () => {},
    afterChange: () => {},
  };
  const create = shippedCreate(() => ({
    app: {},
    graph,
    canvas: { selectItems() {}, selectedItems: [] },
    rootGraph: graph,
  }));
  const out = create({ node_ids: [7, 8, 9] });
  assert.equal(converted, 0, "a recovered conversion must not run convertToSubgraph");
  assert.equal(out.subgraph.node_id, 302);
  assert.equal(out.subgraph.recovered, true);
  assert.deepEqual(out.subgraph.from_nodes, [7, 8, 9]);
});

test("#2267 shipped graph_create_subgraph still converts when every named node is live", () => {
  const n7 = { id: 7 };
  const n8 = { id: 8 };
  const wrapper = { id: 100, subgraph: { name: "converted" } };
  let converted = 0;
  const graph = {
    _nodes: [wrapper],
    getNodeById: (id) => (id === 7 ? n7 : id === 8 ? n8 : null),
    convertToSubgraph: () => {
      converted += 1;
      return { node: wrapper, subgraph: wrapper.subgraph };
    },
    setDirtyCanvas: () => {},
    beforeChange: () => {},
    afterChange: () => {},
  };
  const create = shippedCreate(() => ({
    app: {},
    graph,
    canvas: {
      selectedItems: [],
      selectItems(items) {
        graph.canvasSelected = items;
        this.selectedItems = items;
      },
    },
    rootGraph: graph,
  }));
  const out = create({ node_ids: [7, 8] });
  assert.equal(converted, 1);
  assert.equal(out.subgraph.node_id, 100);
  assert.equal(out.subgraph.recovered, undefined);
});

test("#2267 shipped graph_create_subgraph refuses a partial leftover set instead of converting it", () => {
  const leftover = { id: 7 };
  const host = hostWithInner(302, [8, 9]);
  let converted = 0;
  const graph = {
    _nodes: [leftover, host],
    getNodeById: (id) => (id === 7 ? leftover : null),
    convertToSubgraph: () => {
      converted += 1;
      return { node: host, subgraph: host.subgraph };
    },
  };
  const create = shippedCreate(() => ({
    app: {},
    graph,
    canvas: { selectItems() {}, selectedItems: [] },
    rootGraph: graph,
  }));
  assert.throws(
    () => create({ node_ids: [7, 8, 9] }),
    /only 1 of 3 named nodes/,
  );
  assert.equal(converted, 0, "a partial leftover must not be wrapped");
});

test("#2267 mutation receipts persist a landed create_subgraph and retry_of replays it", () => {
  const store = createMutationReceiptStore();
  const result = {
    subgraph: { node_id: 302, name: "New Subgraph", from_nodes: [1, 2, 3], recovered: true },
  };
  const fingerprint = commandFingerprint({
    cmd: "graph_create_subgraph",
    node_ids: [1, 2, 3],
  });
  store.remember("r1", result, { cmd: "graph_create_subgraph", fingerprint });
  const hit = store.lookup("r1", fingerprint);
  assert.equal(hit.cmd, "graph_create_subgraph");
  assert.equal(hit.result.subgraph.node_id, 302);
  const resolved = resolveLateMutationReply(
    store,
    { rid: "r2", retry_of: "r1", cmd: "graph_create_subgraph" },
    fingerprint,
  );
  assert.equal(resolved.retryOfHit, true);
  assert.equal(resolved.reply.rid, "r2");
  assert.equal(resolved.reply.result.subgraph.node_id, 302);
});

test("#2267 wiring: create_subgraph recovers from graph state and stores a receipt", () => {
  const start = PANEL_SRC.indexOf("graph_create_subgraph({ node_ids })");
  assert.ok(start >= 0, "graph_create_subgraph handler not found");
  const handler = PANEL_SRC.slice(start, PANEL_SRC.indexOf("\n  graph_subgraph_group", start));
  assert.match(handler, /recoverConvertedSubgraph\(\{ graph, nodeIds: requested \}\)/);
  assert.match(handler, /recoveredCreateSubgraphResult\(recovered, requested\)/);
  assert.match(handler, /unresolvedCreateSubgraphNodesRefusal/);
  assert.match(PANEL_SRC, /from "\.\/lib\/subgraph-conversion-recovery\.js"/);
  assert.match(
    PANEL_SRC,
    /msg\.cmd === "graph_create_subgraph"/,
  );
  assert.match(
    PANEL_SRC,
    /lateMutationReceipts\.remember\(msg\.rid, reply\.result/,
  );
});
