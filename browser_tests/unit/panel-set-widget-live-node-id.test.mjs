// #1759 — panel_set_widget must resolve the same live node that the graph
// readers enumerate after H3One workflow activity, even when LiteGraph's id
// index still points at the previous occupant of that id.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveLiveNode } from "../../web/js/lib/node-id.js";

const panelPath = new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url);
const panelSource = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

const resolverStart = panelSource.indexOf("function resolveNode(graph, nodeId) {");
const resolverEnd = panelSource.indexOf("\n\n// The consolidated editor", resolverStart);
assert.ok(resolverStart >= 0, "could not locate the shipped resolveNode");
assert.ok(resolverEnd > resolverStart, "could not locate the shipped resolveNode boundary");

const shippedResolveNode = new Function(
  "resolveLiveNode",
  "resolveRailNode",
  "getGraphCtx",
  "describeMissingNode",
  "describeRailNodeTarget",
  `${panelSource.slice(resolverStart, resolverEnd)}\nreturn resolveNode;`,
)(
  resolveLiveNode,
  () => null,
  () => ({ rootGraph: null, graph: null }),
  () => "missing",
  () => "rail",
);

const handlerStart = panelSource.indexOf("  async graph_set_widget({");
const handlerEnd = panelSource.indexOf("\n\n  // artokun/comfyui-mcp#938", handlerStart);
assert.ok(handlerStart >= 0, "could not locate the shipped graph_set_widget");
assert.ok(handlerEnd > handlerStart, "could not locate the shipped graph_set_widget boundary");

function shippedPanelSetWidget({ getGraphCtx, classifyTarget }) {
  return new Function(
    "SET_WIDGET_COMMAND_BUDGET_MS",
    "makeCommandBudget",
    "monotonicNow",
    "getGraphCtx",
    "resolveNode",
    "classifyMiniMaxH3DirectorWrite",
    "miniMaxH3DirectorPromptRefusal",
    `const executors = { ${panelSource.slice(handlerStart, handlerEnd)} };\nreturn executors.graph_set_widget;`,
  )(
    30_000,
    () => ({}),
    () => 0,
    getGraphCtx,
    shippedResolveNode,
    classifyTarget,
    (widget, nodeId) => `resolved ${nodeId} as the live target`,
  );
}

test("#1759 shipped panel_set_widget uses the live node, not a stale id-index occupant", async () => {
  const liveTarget = {
    id: 8,
    type: "LLMSessionChatNode",
    widgets: [{ name: "system_prompt", value: "old" }],
  };
  const staleIndexTarget = {
    id: 8,
    type: "MarkdownNote",
    widgets: [{ name: "text", value: "stale" }],
  };
  const graph = {
    _nodes: [liveTarget],
    getNodeById(id) {
      assert.equal(id, 8);
      return staleIndexTarget;
    },
  };
  let observedTarget = null;
  const run = shippedPanelSetWidget({
    getGraphCtx: () => ({ app: {}, graph, rootGraph: graph, LG: {} }),
    classifyTarget(node) {
      observedTarget = node;
      return "derived";
    },
  });

  await assert.rejects(
    run({ node_id: 8, widget: "system_prompt", value: "new" }),
    /resolved 8 as the live target/,
  );
  assert.equal(observedTarget, liveTarget, "the production handler must receive the live-list node");
  assert.notEqual(observedTarget, staleIndexTarget, "the stale id-index occupant must never be targeted");
});

test("#1759 does not resurrect a node that only remains in the stale id index", () => {
  const graph = {
    _nodes: [{ id: 9, type: "KSampler" }],
    getNodeById: () => ({ id: 8, type: "MarkdownNote" }),
  };

  assert.equal(resolveLiveNode(graph, 8), null);
  assert.throws(() => shippedResolveNode(graph, 8), /missing/);
});
