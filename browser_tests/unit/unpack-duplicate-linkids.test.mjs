/**
 * #1938 — panel_unpack_subgraph crashed on duplicate boundary link ids.
 *
 * The bundled anima-inpaint subgraph serialises link id 1883 twice on one IMAGE output
 * rail. ComfyUI frontend's `unpackSubgraph` removes the link on its first visit and then
 * dereferences the now-missing record on the duplicate:
 *
 *     Cannot read properties of undefined (reading 'target_id')
 *
 * The #405 rollback caught it, so no graph was ever corrupted — the operation simply
 * could not run on that workflow at all.
 *
 * These tests run the REAL shipped `graph_unpack_subgraph`, extracted from
 * web/js/comfyui-mcp-panel.js and given LiteGraph-shaped doubles whose
 * `unpackSubgraph` reproduces that crash. Deleting the dedupe from the panel source
 * (not merely from a helper) fails them: the mock throws, the handler rolls back, and
 * the call never returns a success.
 *
 * Run with `node --test`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  snapshotExternalLinks,
  verifyExternalLinks,
} from "../../web/js/lib/unpack-link-verify.js";
import {
  materializePromotedValues,
  materializedValuesNote,
  findDivergentPromotedValues,
} from "../../web/js/lib/unpack-promoted-values.js";
import { resolveLoadGraphArgs } from "../../web/js/lib/session-rebind.js";

const panelSrc = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

/** The method source between its signature line and the first `  },` line. */
function sliceMethod(signature) {
  const lines = panelSrc.split("\n");
  const start = lines.findIndex((l) => l === signature);
  assert.ok(start >= 0, `could not locate "${signature}" in the panel source`);
  const end = lines.findIndex((l, i) => i > start && l === "  },");
  assert.ok(end > start, `could not locate the end of "${signature}"`);
  return lines.slice(start, end + 1).join("\n");
}

const unpackSrc = sliceMethod("  async graph_unpack_subgraph({ node_id }) {");

function resolveNode(graph, id) {
  const n = graph.getNodeById(id);
  if (!n) throw new Error(`No node with id ${id}`);
  return n;
}

/**
 * The frontend crash: walk every boundary `linkIds` entry, read `target_id` off the
 * stored record, then delete the record. A duplicate id is undefined on the second
 * visit — exactly `Cannot read properties of undefined (reading 'target_id')`.
 */
function visitBoundaryLinks(node) {
  const store = node.subgraph._links;
  for (const slots of [node.subgraph?.inputs, node.subgraph?.outputs]) {
    for (const slot of slots ?? []) {
      for (const linkId of slot.linkIds ?? []) {
        const rec = store.get(linkId);
        void rec.target_id;
        store.delete(linkId);
      }
    }
  }
}

function mkGraph() {
  const map = new Map();
  const graph = {
    _links: map,
    links: map,
    _nodes: [],
    dirty: 0,
    unpackCalls: 0,
    getNodeById: (id) => graph._nodes.find((n) => String(n.id) === String(id)) ?? null,
    serialize: () => ({ nodes: graph._nodes.map((n) => ({ id: n.id })) }),
    setDirtyCanvas() {
      graph.dirty += 1;
    },
  };
  return graph;
}

function addLink(store, id, origin_id, origin_slot, target_id, target_slot) {
  store.set(id, { id, origin_id, origin_slot, target_id, target_slot });
}

/** Reporter's shape: IMAGE output rail serialises 1883 twice. No parent-graph wires. */
function duplicateOutputRailGraph() {
  const graph = mkGraph();
  const interior = new Map();
  addLink(interior, 1883, -20, 0, 10, 0);
  const imageOut = { name: "IMAGE", type: "IMAGE", linkIds: [1883, 1883] };
  const node = {
    id: 1277,
    type: "SubgraphNode",
    inputs: [],
    outputs: [{ name: "IMAGE", links: [] }],
    subgraph: {
      inputs: [],
      outputs: [imageOut],
      _links: interior,
      _nodes: [{ id: 10, inputs: [{ name: "IMAGE", link: 1883 }], outputs: [] }],
    },
  };
  graph._nodes.push(node);
  graph.unpackSubgraph = function (n) {
    this.unpackCalls += 1;
    visitBoundaryLinks(n);
    this.unpackedNodeId = n.id;
  };
  return { graph, node, imageOut };
}

/**
 * Inbound fan-out with a duplicated interior consumer id. After a correct unpack there
 * is ONE live parent-graph link (the duplicate was never a second edge). A snapshot
 * taken over the duplicates would expect two consumers and refuse a correct unpack.
 */
function duplicateInboundRailGraph() {
  const graph = mkGraph();
  const source = {
    id: 131,
    outputs: [{ name: "IMAGE", links: [50] }],
    inputs: [],
  };
  const interior = new Map();
  addLink(interior, 1883, -10, 0, 10, 0);
  const imageIn = { name: "IMAGE", type: "IMAGE", linkIds: [1883, 1883] };
  const node = {
    id: 1277,
    type: "SubgraphNode",
    inputs: [{ name: "IMAGE", link: 50 }],
    outputs: [],
    subgraph: {
      inputs: [imageIn],
      outputs: [],
      _links: interior,
      _nodes: [{ id: 10, inputs: [{ name: "IMAGE", link: 1883 }], outputs: [] }],
    },
  };
  graph._nodes.push(source, node);
  addLink(graph._links, 50, 131, 0, 1277, 0);
  graph.unpackSubgraph = function (n) {
    this.unpackCalls += 1;
    visitBoundaryLinks(n);
    const inner = { id: 10, inputs: [{ name: "IMAGE", link: 60 }], outputs: [] };
    this._nodes = this._nodes.filter((x) => x !== n).concat(inner);
    this._links.delete(50);
    addLink(this._links, 60, 131, 0, 10, 0);
    source.outputs[0].links = [60];
  };
  return { graph, node, imageIn, source };
}

function buildUnpack(graph, { app, canvas, rootGraph, methodSrc = unpackSrc } = {}) {
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    "findDivergentPromotedValues",
    "resolvePromotedInnerTarget",
    "sourceForSubgraphInput",
    "materializePromotedValues",
    "resolveLoadGraphArgs",
    "snapshotExternalLinks",
    "verifyExternalLinks",
    "materializedValuesNote",
    `return ({
${methodSrc}
}).graph_unpack_subgraph;`,
  );
  return factory(
    () => ({
      graph,
      canvas: canvas ?? { setDirty() {} },
      app: app ?? {
        loadGraphData: async () => {
          graph.rolledBack = true;
        },
      },
      rootGraph: rootGraph ?? graph,
    }),
    resolveNode,
    findDivergentPromotedValues,
    () => ({ promoted: false }),
    () => null,
    materializePromotedValues,
    resolveLoadGraphArgs,
    snapshotExternalLinks,
    verifyExternalLinks,
    materializedValuesNote,
  );
}

test("#1938 the frontend-shaped unpack crashes on the reporter's duplicate link id", () => {
  const { node } = duplicateOutputRailGraph();
  assert.throws(() => visitBoundaryLinks(node), {
    name: "TypeError",
    message: /Cannot read properties of undefined \(reading 'target_id'\)/,
  });
});

test("#1938 the shipped unpack_subgraph runs on that same duplicate and does not crash", async () => {
  const { graph, node, imageOut } = duplicateOutputRailGraph();
  const unpack = buildUnpack(graph);
  const res = await unpack({ node_id: 1277 });
  assert.equal(graph.unpackCalls, 1, "the frontend unpack ran");
  assert.equal(graph.unpackedNodeId, 1277);
  assert.deepEqual(imageOut.linkIds, [1883], "only the repeat is removed");
  assert.equal(res.unpacked.node_id, 1277);
  assert.equal(node.subgraph._links.has(1883), false, "the single real edge was visited once");
});

test("#1938 duplicate INPUT-rail ids are normalised too, and the unpack still runs", async () => {
  const { graph, imageIn } = duplicateInboundRailGraph();
  const unpack = buildUnpack(graph);
  const res = await unpack({ node_id: 1277 });
  assert.equal(graph.unpackCalls, 1);
  assert.deepEqual(imageIn.linkIds, [1883]);
  assert.equal(res.unpacked.node_id, 1277);
  assert.equal(res.unpacked.external_links_verified, 1, "the one real inbound edge survived");
});

test("#1938 a snapshot taken over the duplicates would refuse a correct unpack", () => {
  // Why the dedupe must precede snapshotExternalLinks, not just the unpack: #1665
  // derives an expected interior-consumer count from these arrays.
  const { graph, node } = duplicateInboundRailGraph();
  const snapDup = snapshotExternalLinks(graph, node);
  assert.equal(snapDup.links[0].consumers, 2, "duplicates inflate the expected count");
  node.subgraph.inputs[0].linkIds = [1883];
  const snapDeduped = snapshotExternalLinks(graph, node);
  assert.equal(snapDeduped.links[0].consumers, 1, "one id is one edge");
});

test("#1938 a slot that cannot contain a duplicate keeps its array identity", async () => {
  const graph = mkGraph();
  const empty = [];
  const one = [1883];
  const unique = [1884, 1885];
  const interior = new Map();
  addLink(interior, 1883, -20, 0, 10, 0);
  addLink(interior, 1884, -20, 1, 11, 0);
  addLink(interior, 1885, -20, 2, 12, 0);
  const slots = [
    { name: "A", linkIds: empty },
    { name: "B", linkIds: one },
    { name: "C", linkIds: unique },
  ];
  const node = {
    id: 1277,
    type: "SubgraphNode",
    inputs: [],
    outputs: slots.map((s) => ({ name: s.name, links: [] })),
    subgraph: { inputs: [], outputs: slots, _links: interior, _nodes: [] },
  };
  graph._nodes.push(node);
  graph.unpackSubgraph = function (n) {
    this.unpackCalls += 1;
    visitBoundaryLinks(n);
  };
  const unpack = buildUnpack(graph);
  await unpack({ node_id: 1277 });
  assert.equal(slots[0].linkIds, empty);
  assert.equal(slots[1].linkIds, one);
  assert.equal(slots[2].linkIds, unique);
  assert.equal(graph.unpackCalls, 1);
});

test("#1938 stripping the dedupe from the shipped body makes the reporter fixture crash", async () => {
  const start = unpackSrc.indexOf("for (const slots of [node.subgraph?.inputs, node.subgraph?.outputs])");
  const end = unpackSrc.indexOf("const externalLinks = snapshotExternalLinks");
  assert.ok(start > 0 && end > start, "could not cut the dedupe loop out of the shipped body");
  const stripped = unpackSrc.slice(0, start) + unpackSrc.slice(end);
  assert.equal(stripped.includes("new Set(slot.linkIds)"), false);

  const { graph } = duplicateOutputRailGraph();
  const unpack = buildUnpack(graph, { methodSrc: stripped });
  await assert.rejects(
    () => unpack({ node_id: 1277 }),
    /Cannot read properties of undefined \(reading 'target_id'\)/,
  );
  assert.equal(graph.unpackCalls, 1, "the frontend unpack was reached");
  assert.equal(graph.rolledBack, true, "the #405 rollback still caught the throw");
});

test("#1938 the shipped method still owns the dedupe, before snapshot and unpack", () => {
  // Placement pins. The inbound consumer-count test is the behavioural proof; these
  // fail if the loop is moved after the snapshot or dropped from this handler.
  assert.match(unpackSrc, /\[node\.subgraph\?\.inputs, node\.subgraph\?\.outputs\]/);
  assert.match(unpackSrc, /new Set\(slot\.linkIds\)/);
  const dedupeAt = unpackSrc.indexOf("new Set(slot.linkIds)");
  const snapshotAt = unpackSrc.indexOf("snapshotExternalLinks(graph, node)");
  const unpackAt = unpackSrc.indexOf("graph.unpackSubgraph(node");
  assert.ok(dedupeAt > 0 && snapshotAt > 0 && unpackAt > 0);
  assert.ok(dedupeAt < snapshotAt, "dedupe must precede the snapshot");
  assert.ok(dedupeAt < unpackAt, "dedupe must precede the unpack");
  assert.match(unpackSrc, /graph\.unpackSubgraph\(node[\s\S]{0,400}?\} catch \(err\)/);
});
