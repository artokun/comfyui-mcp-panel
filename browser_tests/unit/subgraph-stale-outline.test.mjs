// #516: native convertToSubgraph rewires surviving root nodes but can leave a
// stale LiteGraph red outline. Exercise the shipped inline handlers by extracting
// their actual source; the browser-only module cannot be imported under Node.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  collectMissingNodeTypeReasons,
  nodeRedFlagIsStale,
} from "../../web/js/lib/asset-staleness.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

function methodSource(name, args) {
  const match = panelSrc.match(new RegExp(`${name}\\(${args}\\) \\{[\\s\\S]*?\\n  \\},`));
  assert.ok(match, `could not locate ${name} in panel source`);
  return match[0];
}

const createSource = methodSource("graph_create_subgraph", "\\{ node_ids \\}");
const groupSource = methodSource("graph_subgraph_group", "\\{ group \\}");
const setWidgetSource = methodSource("async graph_set_widget", "\\{ node_id, widget, value, workflow_uuid \\}");
// Extract the actual helper through its unindented closing brace. Do not depend on
// the following doc comment or on checkout line endings: Windows worktrees retain
// CRLF, while the test runner reads the source verbatim.
const cleanupMatch = panelSrc.match(/function clearStaleRedFlag\(node, \{ app, graph, rootGraph \}\) \{[\s\S]*?\r?\n\}/);
assert.ok(cleanupMatch, "could not locate clearStaleRedFlag in panel source");
const cleanupSource = cleanupMatch[0];

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

/** Run the actual shipped cleanup body with deterministic live-source stubs. */
function realClearStaleRedFlag({ assets, storeNodeErrors = null } = {}) {
  return new Function(
    "collectMissingAssets",
    "collectMissingNodeTypeReasons",
    "getPiniaStore",
    "nodeRedFlagIsStale",
    "findNodeByScopedId",
    `${cleanupSource}; return clearStaleRedFlag;`,
  )(
    () => assets,
    collectMissingNodeTypeReasons,
    () => ({ lastNodeErrors: storeNodeErrors }),
    nodeRedFlagIsStale,
    () => null,
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

test("real stale-outline cleanup preserves a node still blamed by missingNodesError (#516 P1)", () => {
  const node = { id: 7, type: "MissingCustom", has_errors: true };
  let dirtied = 0;
  const graph = { _nodes: [node], setDirtyCanvas: () => { dirtied += 1; } };
  const clear = realClearStaleRedFlag({
    assets: { models: [], media: [], nodeTypes: ["MissingCustom"] },
  });

  assert.equal(clear(node, { app: { lastNodeErrors: {} }, graph, rootGraph: graph }), false);
  assert.equal(node.has_errors, true, "a real missing-node-type red flag is never cleared");
  assert.equal(dirtied, 0);
});

test("real stale-outline cleanup clears only an unblamed direct node (#516)", () => {
  const node = { id: 7, type: "LoadImage", has_errors: true };
  let dirtied = 0;
  const graph = { _nodes: [node], setDirtyCanvas: () => { dirtied += 1; } };
  const clear = realClearStaleRedFlag({ assets: { models: [], media: [], nodeTypes: [] } });

  assert.equal(clear(node, { app: { lastNodeErrors: {} }, graph, rootGraph: graph }), true);
  assert.equal(node.has_errors, false);
  assert.equal(dirtied, 1);
});

test("graph_set_widget delegates all stale-outline clearing to the shared adjudicator (#516 P1)", () => {
  assert.match(
    setWidgetSource,
    /clearStaleRedFlag\(node, \{ app, graph, rootGraph \}\)/,
    "the direct set-widget path must execute the complete shared adjudicator",
  );
  assert.doesNotMatch(
    setWidgetSource,
    /nodeRedFlagIsStale\(/,
    "a narrower duplicate predicate could clear a missing-node-type outline",
  );
});
