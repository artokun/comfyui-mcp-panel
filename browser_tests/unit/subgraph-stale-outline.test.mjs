// #516: native convertToSubgraph rewires surviving root nodes but can leave a
// stale LiteGraph red outline. Exercise the shipped inline handlers by extracting
// their actual source; the browser-only module cannot be imported under Node.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

function methodSource(name, args) {
  const match = panelSrc.match(new RegExp(`${name}\\(${args}\\) \\{[\\s\\S]*?\\n  \\},`));
  assert.ok(match, `could not locate ${name} in panel source`);
  return match[0];
}

const createSource = methodSource("graph_create_subgraph", "\\{ node_ids \\}");
const groupSource = methodSource("graph_subgraph_group", "\\{ group \\}");

function realCreate(getGraphCtx, clearStaleRedFlagsAfterSubgraphConversion) {
  return new Function(
    "getGraphCtx",
    "clearStaleRedFlagsAfterSubgraphConversion",
    `const executors = { ${createSource} }; return executors.graph_create_subgraph;`,
  )(getGraphCtx, clearStaleRedFlagsAfterSubgraphConversion);
}

function realGroup(
  getGraphCtx,
  resolveGroupRef,
  syncGraphNodeAreas,
  groupMemberNodes,
  clearStaleRedFlagsAfterSubgraphConversion,
) {
  return new Function(
    "getGraphCtx",
    "resolveGroupRef",
    "syncGraphNodeAreas",
    "groupMemberNodes",
    "clearStaleRedFlagsAfterSubgraphConversion",
    `const executors = { ${groupSource} }; return executors.graph_subgraph_group;`,
  )(
    getGraphCtx,
    resolveGroupRef,
    syncGraphNodeAreas,
    groupMemberNodes,
    clearStaleRedFlagsAfterSubgraphConversion,
  );
}

function makeCtx() {
  const events = [];
  const selected = [];
  const app = { lastNodeErrors: {} };
  const rootGraph = { name: "root" };
  const wrapper = { id: 100, subgraph: { name: "converted" } };
  const result = { node: wrapper, subgraph: wrapper.subgraph };
  const graph = {
    getNodeById: (id) => ({ id: Number(id) }),
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    convertToSubgraph: (items) => {
      events.push(`convert:${items.length}`);
      return result;
    },
    setDirtyCanvas: () => events.push("dirty"),
  };
  const canvas = {
    selectedItems: [],
    selectItems: (items) => {
      selected.push(...items);
      canvas.selectedItems = items;
    },
  };
  return { events, selected, app, rootGraph, graph, canvas, result };
}

test("graph_create_subgraph re-adjudicates only after conversion, before canvas dirties (#516)", () => {
  const ctx = makeCtx();
  const cleanups = [];
  const create = realCreate(
    () => ({ app: ctx.app, graph: ctx.graph, canvas: ctx.canvas, rootGraph: ctx.rootGraph }),
    (res, args) => {
      cleanups.push({ res, args });
      ctx.events.push("cleanup");
    },
  );

  const out = create({ node_ids: [7, 8] });
  assert.deepEqual(ctx.selected.map((node) => node.id), [7, 8]);
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0].res, ctx.result, "cleanup receives the returned native wrapper");
  assert.equal(cleanups[0].args.graph, ctx.graph);
  assert.equal(cleanups[0].args.rootGraph, ctx.rootGraph);
  assert.deepEqual(ctx.events, ["before", "convert:2", "after", "cleanup", "dirty"]);
  assert.equal(out.subgraph.node_id, 100);
});

test("graph_subgraph_group applies the same post-conversion stale-outline cleanup (#516)", () => {
  const ctx = makeCtx();
  const cleanups = [];
  const group = realGroup(
    () => ({ app: ctx.app, graph: ctx.graph, canvas: ctx.canvas, rootGraph: ctx.rootGraph }),
    () => ({ title: "Replacement" }),
    () => ctx.events.push("sync"),
    () => [{ id: 17 }, { id: 18 }],
    (res, args) => {
      cleanups.push({ res, args });
      ctx.events.push("cleanup");
    },
  );

  const out = group({ group: "Replacement" });
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0].res, ctx.result);
  assert.equal(cleanups[0].args.app, ctx.app);
  assert.deepEqual(ctx.events, ["sync", "before", "convert:2", "after", "cleanup", "dirty"]);
  assert.deepEqual(out.subgraph.from_nodes, [17, 18]);
});
