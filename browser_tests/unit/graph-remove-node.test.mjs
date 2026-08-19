// #841: graph_remove_node accepts node_ids and applies the whole list as ONE
// undo envelope. Extract the shipped browser method and run it against
// LiteGraph-shaped doubles so this verifies the real implementation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");
const methodMatch = panelSrc.match(/\n  graph_remove_node\(args = \{\}\) \{[\s\S]*?\n  \},/);
assert.ok(methodMatch, "could not locate graph_remove_node in panel source");

function realRemove(getGraphCtx, resolveNode, summarizeNode, subgraphBoundaryModel, pruneOrphanedBoundaries, safeRemoveNode, clearStoredExecutionOutputs, app) {
  return new Function(
    "getGraphCtx",
    "resolveNode",
    "summarizeNode",
    "subgraphBoundaryModel",
    "pruneOrphanedBoundaries",
    "safeRemoveNode",
    "clearStoredExecutionOutputs",
    "app",
    `const executors = { ${methodMatch[0]} }; return executors.graph_remove_node;`,
  )(
    getGraphCtx,
    resolveNode,
    summarizeNode,
    subgraphBoundaryModel,
    pruneOrphanedBoundaries,
    safeRemoveNode,
    clearStoredExecutionOutputs,
    app,
  );
}

function makeNode(id, { type = `Type${id}`, ignore_remove = false } = {}) {
  return { id, type, title: `Node ${id}`, ignore_remove };
}

function setup(nodes, { rootGraph = null, safeRemove = null } = {}) {
  const events = [];
  const live = [...nodes];
  const graph = {
    _nodes: live,
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirtyCanvas: () => events.push("dirty"),
    getNodeById: (id) => live.find((n) => n.id === id) ?? null,
  };
  const cleared = [];
  const pruned = [];
  const fn = realRemove(
    () => ({ graph, rootGraph: rootGraph ?? graph }),
    (_graph, id) => {
      // Match shipped resolveNode: a miss on the LIVE graph throws. Falling back
      // to the original `nodes` list would make a gone id look retryable.
      const node = live.find((n) => n.id === id);
      if (!node) throw new Error(`No node with id ${id}`);
      return node;
    },
    (node) => ({ id: node.id, type: node.type }),
    () => ({ inputs: [], outputs: [] }),
    (_graph, _model, removedIds) => {
      pruned.push([...removedIds]);
      return { inputs: [], outputs: [] };
    },
    safeRemove ??
      ((g, node) => {
        events.push(`remove:${node.id}`);
        const i = g._nodes.indexOf(node);
        if (i !== -1) g._nodes.splice(i, 1);
      }),
    (_stores, id) => {
      cleared.push(id);
      return true;
    },
    { nodeOutputs: {}, nodePreviewImages: {} },
  );
  return { fn, events, graph, cleared, pruned };
}

test("#841 a single node_id still returns the historical {removed: summary} shape", () => {
  const node = makeNode(7);
  const { fn, events, cleared } = setup([node]);
  const result = fn({ node_id: 7 });
  assert.deepEqual(result, { removed: { id: 7, type: "Type7" } });
  assert.deepEqual(events.filter((e) => e === "before" || e === "after"), ["before", "after"]);
  assert.equal(events.at(-1), "dirty");
  assert.deepEqual(cleared, [7]);
});

test("#841 node_ids removes every listed node inside one undo envelope", () => {
  const a = makeNode(1);
  const b = makeNode(2);
  const c = makeNode(3);
  const { fn, events, graph, cleared } = setup([a, b, c]);
  const result = fn({ node_ids: [1, 3] });
  assert.deepEqual(result.removed.map((n) => n.id), [1, 3]);
  assert.equal(graph._nodes.length, 1);
  assert.equal(graph._nodes[0].id, 2);
  assert.deepEqual(events.filter((e) => e === "before" || e === "after"), ["before", "after"]);
  assert.deepEqual(
    events.filter((e) => String(e).startsWith("remove:")),
    ["remove:1", "remove:3"],
  );
  assert.deepEqual(cleared, [1, 3]);
});

test("#841 known-upfront failures refuse the whole list before the envelope opens", () => {
  const a = makeNode(1);
  const b = makeNode(2, { ignore_remove: true });
  const { fn, events, graph } = setup([a, b]);
  assert.throws(() => fn({}), /exactly one/);
  assert.throws(() => fn({ node_id: 1, node_ids: [1] }), /exactly one/);
  assert.throws(() => fn({ node_ids: [] }), /non-empty/);
  assert.throws(() => fn({ node_ids: [1, 1] }), /duplicates/);
  assert.throws(() => fn({ node_ids: [1, 2] }), /Nothing was removed/);
  assert.deepEqual(graph._nodes.map((n) => n.id), [1, 2]);
  assert.deepEqual(events, []);
});

test("#841 a protected single node still throws the historical message", () => {
  const node = makeNode(9, { ignore_remove: true });
  const { fn, events } = setup([node]);
  assert.throws(() => fn({ node_id: 9 }), /Node 9 could not be removed \(it may be protected \/ ignore_remove\)/);
  assert.deepEqual(events, []);
});

test("#841 a missing id in a batch never starts the undo envelope", () => {
  const a = makeNode(1);
  const { fn, events, graph } = setup([a]);
  assert.throws(() => fn({ node_ids: [1, 99] }), /No node with id 99/);
  assert.equal(graph._nodes.length, 1);
  assert.deepEqual(events, []);
});

test("#841 a mid-batch survivor is named, not reported as a clean success", () => {
  const a = makeNode(1);
  const b = makeNode(2);
  const c = makeNode(3);
  const skipped = new Set();
  const { fn, events, graph } = setup([a, b, c], {
    safeRemove: (g, node) => {
      events.push(`remove:${node.id}`);
      if (node.id === 2 && !skipped.has(2)) {
        skipped.add(2);
        return; // first attempt no-op: stays on the graph
      }
      const i = g._nodes.indexOf(node);
      if (i !== -1) g._nodes.splice(i, 1);
    },
  });
  const result = fn({ node_ids: [1, 2, 3] });
  assert.deepEqual(result.removed.map((n) => n.id), [1, 3]);
  assert.deepEqual(result.not_removed.map((n) => n.id), [2]);
  assert.match(result.not_removed[0].reason, /could not be removed/);
  assert.match(result.warning, /STILL on the canvas/);
  assert.match(result.warning, /panel_graph_outline/);
  assert.match(result.warning, /not_removed/);
  assert.match(result.warning, /refuses the whole list/);
  assert.doesNotMatch(result.warning, /no-op/i);
  assert.deepEqual(graph._nodes.map((n) => n.id), [2]);
  assert.deepEqual(events.filter((e) => e === "before" || e === "after"), ["before", "after"]);

  // The leftover is only actionable as `not_removed`. Including an id that
  // already left throws before the envelope opens and never retries 2.
  const eventsAfterPartial = events.length;
  assert.throws(() => fn({ node_ids: [1, 2, 3] }), /No node with id 1/);
  assert.throws(() => fn({ node_ids: [1, 3] }), /No node with id 1/);
  assert.deepEqual(graph._nodes.map((n) => n.id), [2]);
  assert.equal(events.length, eventsAfterPartial);

  const retry = fn({ node_ids: [2] });
  assert.deepEqual(retry.removed.map((n) => n.id), [2]);
  assert.equal(retry.not_removed, undefined);
  assert.deepEqual(graph._nodes.map((n) => n.id), []);
});

test("#841 a one-id node_ids call still shares the batch reply shape", () => {
  const node = makeNode(4);
  const { fn, events } = setup([node]);
  const result = fn({ node_ids: [4] });
  assert.ok(Array.isArray(result.removed));
  assert.equal(result.removed[0].id, 4);
  assert.deepEqual(events.filter((e) => e === "before" || e === "after"), ["before", "after"]);
});

test("#841 a mid-batch throw keeps going and names the leftover with the error", () => {
  const a = makeNode(1);
  const b = makeNode(2);
  const c = makeNode(3);
  const { fn, graph } = setup([a, b, c], {
    safeRemove: (g, node) => {
      if (node.id === 2) throw new Error("findInputSlot exploded");
      const i = g._nodes.indexOf(node);
      if (i !== -1) g._nodes.splice(i, 1);
    },
  });
  const result = fn({ node_ids: [1, 2, 3] });
  assert.deepEqual(result.removed.map((n) => n.id), [1, 3]);
  assert.equal(result.not_removed.length, 1);
  assert.equal(result.not_removed[0].id, 2);
  assert.match(result.not_removed[0].reason, /findInputSlot exploded/);
  assert.deepEqual(graph._nodes.map((n) => n.id), [2]);
});

test("#841 subgraph boundary pruning sees every id that actually left, in the same frame", () => {
  const a = makeNode(4);
  const b = makeNode(5);
  const inner = {};
  const { fn, events, pruned } = setup([a, b], { rootGraph: inner });
  fn({ node_ids: [4, 5] });
  assert.deepEqual(pruned, [[4, 5]]);
  assert.deepEqual(events.filter((e) => e === "before" || e === "after"), ["before", "after"]);
});
