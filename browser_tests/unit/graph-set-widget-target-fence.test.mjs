import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePromotedInnerTarget } from "../../web/js/lib/widget-write.js";
import { findSubgraphOwner } from "../../web/js/lib/subgraph-scope.js";

// This tree is CRLF; CI checks out LF. Every source pin below anchors on a BLANK LINE,
// and a literal two-newline anchor never matches a CRLF blank line — so these four fence
// pins passed on CI and were dead on Windows, one of them slicing to -1 and swallowing
// the rest of the file as a fake "helper". The five sibling pin files already normalise
// at read time; this one was missed (comfyui-mcp#2314).
const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function extractShippingMethod(signature) {
  const start = PANEL_SRC.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found in panel source`);
  const open = PANEL_SRC.indexOf(") {", start) + 1;
  let depth = 0;
  for (let i = open; i < PANEL_SRC.length; i += 1) {
    const ch = PANEL_SRC[i];
    if (ch === "/" && PANEL_SRC[i + 1] === "/") {
      i = PANEL_SRC.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && PANEL_SRC[i + 1] === "*") {
      i = PANEL_SRC.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < PANEL_SRC.length; i += 1) {
        if (PANEL_SRC[i] === "\\") {
          i += 1;
          continue;
        }
        if (PANEL_SRC[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return PANEL_SRC.slice(start, i + 1);
  }
  throw new Error(`unterminated method: ${signature}`);
}

test("graph_set_widget enforces expected_node_type at the synchronous write boundary", () => {
  const start = PANEL_SRC.indexOf("async graph_set_widget({");
  const end = PANEL_SRC.indexOf("\n  // artokun/comfyui-mcp#938", start);
  assert.ok(start >= 0, "graph_set_widget handler not found");
  assert.ok(end > start, "graph_set_widget handler boundary not found");
  const handler = PANEL_SRC.slice(start, end);

  const expectedArg = handler.indexOf("expected_node_type");
  const targetCheck = handler.indexOf("liveTarget.type !== expected_node_type");
  const identityCheck = handler.indexOf("liveTarget !== node");
  const runSet = handler.indexOf("runSetWidget(node, widget, value, setWidgetOpts)");
  assert.ok(expectedArg >= 0, "handler does not accept expected_node_type");
  assert.ok(targetCheck >= 0, "handler does not verify the live target type");
  assert.ok(identityCheck >= 0, "handler does not reject a same-type replacement object");
  assert.ok(runSet > targetCheck, "target type must be checked before runSetWidget");
  assert.ok(runSet > identityCheck, "target identity must be checked before runSetWidget");
});

test("the shipped target fence rejects replacement objects and preserves qualified ids", () => {
  const start = PANEL_SRC.indexOf("async graph_set_widget({");
  const end = PANEL_SRC.indexOf("\n  // artokun/comfyui-mcp#938", start);
  const handler = PANEL_SRC.slice(start, end);
  const fenceStart = handler.indexOf("assertTargetStillCurrent: () => {");
  const fenceTail = handler.slice(fenceStart).match(/\r?\n      \},\r?\n      \/\/ Stale-combo retry/);
  const fenceEnd = fenceTail?.index == null ? -1 : fenceStart + fenceTail.index;
  assert.ok(fenceStart >= 0, "production target fence not found");
  assert.ok(fenceEnd > fenceStart, "production target fence boundary not found");
  const fenceProperty = handler.slice(fenceStart, fenceEnd) + "\n      }";

  const original = { id: 7, type: "OtherLoraLoader" };
  let liveTarget = original;
  let resolvedId;
  const factorySource = `return function (node_id, expected_node_type, workflow_uuid, expected_scope, node, defer_replay) {
      const enforceDeferredExpected = defer_replay === true;
      return ({ ${fenceProperty} }).assertTargetStillCurrent;
    };`;
  let makeFence;
  try {
    makeFence = new Function(
    "getGraphCtx",
    "resolveNode",
    "assertActiveWorkflowCommandTarget",
    "assertExpectedPromotedScope",
    "WORKFLOW_UUID_FIELD",
    factorySource,
    );
  } catch (err) {
    throw new Error(`${err}\n${factorySource}`);
  }
  const fence = makeFence(
    () => ({ graph: {} }),
    (_graph, id) => {
      resolvedId = id;
      return liveTarget;
    },
    () => {},
    () => {},
    "workflow_uuid",
  )("7:subgraph", "OtherLoraLoader", undefined, undefined, original, undefined);

  fence();
  assert.equal(resolvedId, "7:subgraph");

  liveTarget = { id: 7, type: "OtherLoraLoader" };
  assert.throws(() => fence(), /target changed before dispatch/);

  liveTarget = { id: 7, type: "KSampler" };
  assert.throws(() => fence(), /target changed before dispatch/);
});

test("#2314 production scope fence refuses receiver navigation after graph_query reply", () => {
  const helperStart = PANEL_SRC.indexOf("function canonicalExpectedPromotedOwner");
  const helperEnd = PANEL_SRC.indexOf("\n\n// ---- per-turn graph snapshots", helperStart);
  assert.ok(helperStart >= 0, "production promoted-scope helper not found");
  assert.ok(helperEnd > helperStart, "production promoted-scope helper boundary not found");
  const helperSource = PANEL_SRC.slice(helperStart, helperEnd);
  const makeScopeHelpers = new Function(
    "describeActiveGraph",
    "findSubgraphOwner",
    `${helperSource}; return assertExpectedPromotedScope;`,
  );

  const graphA = { name: "A" };
  const graphB = { name: "B" };
  const rootGraph = { _nodes: [{ id: 78, subgraph: graphA }, { id: 79, subgraph: graphB }] };
  const describe = (graph) =>
    graph === graphA
      ? { scope: "subgraph", owner_node_id: 78, workflow_uuid: "workflow-a", graph_identity: "graph-a" }
      : { scope: "subgraph", owner_node_id: 78, workflow_uuid: "workflow-a", graph_identity: "graph-b" };
  const findOwner = (_root, graph) =>
    graph === graphA ? { id: 78 } : graph === graphB ? { id: 79 } : null;
  const assertScope = makeScopeHelpers(describe, findOwner);
  let currentGraph = graphA;
  let writes = 0;
  let liveTarget = { id: 76, type: "OrdinaryNode" };
  const currentCtx = () => ({ graph: currentGraph, rootGraph });
  const factorySource = `return function (node_id, expected_node_type, workflow_uuid, expected_scope, node, defer_replay) {
      const enforceDeferredExpected = defer_replay === true;
      return ({ ${PANEL_SRC.slice(
        PANEL_SRC.indexOf("assertTargetStillCurrent: () => {", PANEL_SRC.indexOf("async graph_set_widget({")),
        PANEL_SRC.indexOf("\n      // Stale-combo retry", PANEL_SRC.indexOf("assertTargetStillCurrent: () => {", PANEL_SRC.indexOf("async graph_set_widget({"))),
      )} }).assertTargetStillCurrent;
    };`;
  const makeFence = new Function(
    "getGraphCtx",
    "resolveNode",
    "assertActiveWorkflowCommandTarget",
    "assertExpectedPromotedScope",
    "WORKFLOW_UUID_FIELD",
    factorySource,
  );
  const fence = makeFence(
    currentCtx,
    () => liveTarget,
    () => {},
    assertScope,
    "workflow_uuid",
  )(
    76,
    "OrdinaryNode",
    "workflow-a",
    { scope: "subgraph", owner_node_id: 78, workflow_uuid: "workflow-a", graph_identity: "graph-a" },
    liveTarget,
    undefined,
  );

  // The graph_query reply was for owner A. Navigation happens before the
  // synchronous production callback, so the write must never be entered.
  currentGraph = graphB;
  assert.throws(() => {
    fence();
    writes += 1;
  }, /promoted receiver changed before dispatch/);
  assert.equal(writes, 0);

  // A same-owner write remains valid, while malformed metadata refuses closed.
  currentGraph = graphA;
  fence();
  writes += 1;
  assert.equal(writes, 1);
  assert.throws(
    () => assertScope(currentCtx(), {
      scope: "subgraph",
      owner_node_id: "not-an-id",
      graph_identity: "graph-a",
    }),
    /canonical node id/,
  );
  assert.throws(
    () => assertScope(currentCtx(), { scope: "subgraph", owner_node_id: 78 }),
    /graph_identity must be a non-empty string/,
  );
});

test("#2314 production graph_enter_subgraph -> graph_set_widget fence refuses a parent-rail relink", async () => {
  const helperStart = PANEL_SRC.indexOf("function canonicalExpectedPromotedOwner");
  const helperEnd = PANEL_SRC.indexOf("\n\n// ---- per-turn graph snapshots", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "production scope helper boundary not found");
  const promotionStart = PANEL_SRC.indexOf("function resolveSubgraphLink(");
  const promotionEnd = PANEL_SRC.indexOf("\nfunction findPromotedHostInput", promotionStart);
  assert.ok(promotionStart >= 0 && promotionEnd > promotionStart, "production promotion resolver boundary not found");
  const sourceForSubgraphInput = new Function(
    `${PANEL_SRC.slice(promotionStart, promotionEnd)}; return sourceForSubgraphInput;`,
  )();
  const assertScope = new Function(
    "describeActiveGraph",
    "findSubgraphOwner",
    "resolvePromotedInnerTarget",
    "sourceForSubgraphInput",
    `${PANEL_SRC.slice(helperStart, helperEnd)}; return assertExpectedPromotedScope;`,
  );

  const rail = { name: "quality_prompt", value: "old" };
  const innerWidget = { name: "quality_prompt", value: "old" };
  const innerInput = { name: "quality_prompt", widget: { name: "quality_prompt" } };
  const inner = {
    id: 76,
    type: "PrimitiveStringMultiline",
    inputs: [innerInput],
    widgets: [innerWidget],
  };
  const childGraph = {
    _nodes: [inner],
    getNodeById: (id) => (String(id) === "76" ? inner : null),
    getLink: (id) => (id === 1 ? { origin_id: 76, target_id: 76, target_slot: 0 } : null),
  };
  const hostInput = {
    name: "quality_prompt",
    widget: rail,
    _widget: rail,
    widgetId: "root:78:quality_prompt",
    _subgraphSlot: { name: "quality_prompt", linkIds: [1] },
  };
  const owner = { id: 78, widgets: [rail], inputs: [hostInput], subgraph: childGraph };
  const rootGraph = { _nodes: [owner] };
  let currentGraph = rootGraph;
  const canvas = {
    get graph() {
      return currentGraph;
    },
    openSubgraph: (subgraph) => {
      currentGraph = subgraph;
    },
    setDirty() {},
  };
  const app = { graph: rootGraph, canvas };
  const describeActiveGraph = (graph) =>
    graph === childGraph
      ? {
          scope: "subgraph",
          owner_node_id: 78,
          workflow_uuid: "workflow-a",
          graph_identity: "graph-a",
        }
      : { scope: "root", workflow_uuid: "workflow-a", graph_identity: "root-a" };
  const getGraphCtx = () => ({ app, graph: currentGraph, rootGraph, canvas });

  const enter = new Function(
    "getGraphCtx",
    "resolveNode",
    "confirmCanvasNavigation",
    "describeActiveGraph",
    "assertGraphBoundToActiveWorkflow",
    "coerceMessageText",
    "pinReconnectScope",
    "releaseReconnectScopePin",
    `return (${extractShippingMethod("async graph_enter_subgraph({ node_id })").replace(
      /^async graph_enter_subgraph\(/,
      "async function graph_enter_subgraph(",
    )});`,
  )(
    getGraphCtx,
    (_graph, id) => (String(id) === "78" ? owner : null),
    async ({ readCanvasGraph, assertBound }) => {
      assert.equal(readCanvasGraph(), childGraph);
      assertBound();
      return { landed: true, everLanded: true, bound: true };
    },
    describeActiveGraph,
    () => {},
    (value) => String(value),
    () => {},
    () => {},
  );

  const enterReply = await enter({ node_id: 78 });
  assert.equal(enterReply.settled, true, "the production enter path must settle on the child graph");

  const handlerStart = PANEL_SRC.indexOf("async graph_set_widget({");
  const fenceStart = PANEL_SRC.indexOf("assertTargetStillCurrent: () => {", handlerStart);
  const fenceTail = PANEL_SRC.slice(fenceStart).match(/\r?\n      \},\r?\n      \/\/ Stale-combo retry/);
  const fenceEnd = fenceTail?.index == null ? -1 : fenceStart + fenceTail.index;
  assert.ok(fenceStart >= 0 && fenceEnd > fenceStart, "production graph_set_widget fence not found");
  const fenceProperty = PANEL_SRC.slice(fenceStart, fenceEnd) + "\n      }";
  const makeFence = new Function(
    "getGraphCtx",
    "resolveNode",
    "assertActiveWorkflowCommandTarget",
    "assertExpectedPromotedScope",
    "WORKFLOW_UUID_FIELD",
    `return function (node_id, expected_node_type, workflow_uuid, expected_scope, node, defer_replay) {
      const enforceDeferredExpected = defer_replay === true;
      return ({ ${fenceProperty} }).assertTargetStillCurrent;
    };`,
  );
  const expectedScope = {
    scope: "subgraph",
    owner_node_id: 78,
    workflow_uuid: "workflow-a",
    graph_identity: "graph-a",
    promoted_widget: "quality_prompt",
    parent_rail: {
      authoritative: true,
      widget: "quality_prompt",
      widget_id: "root:78:quality_prompt",
    },
  };
  const fence = makeFence(
    getGraphCtx,
    () => inner,
    () => {},
    assertScope(describeActiveGraph, findSubgraphOwner, resolvePromotedInnerTarget, sourceForSubgraphInput),
    "workflow_uuid",
  )(76, "PrimitiveStringMultiline", "workflow-a", expectedScope, inner, undefined);

  assert.doesNotThrow(() => fence(), "the entered, still-authoritative promotion is writable");
  let applied = 0;
  hostInput.link = 99;
  assert.throws(
    () => {
      fence();
      applied += 1;
    },
    /promoted parent rail changed or became unverifiable/,
  );
  assert.equal(applied, 0, "the final graph_set_widget mutation must not run after the relink");
});

test("#2314 same owner id in a different graph is refused at the shipped fence", () => {
  const helperStart = PANEL_SRC.indexOf("function canonicalExpectedPromotedOwner");
  const helperEnd = PANEL_SRC.indexOf("\n\n// ---- per-turn graph snapshots", helperStart);
  const helperSource = PANEL_SRC.slice(helperStart, helperEnd);
  const assertScope = new Function(
    "describeActiveGraph",
    "findSubgraphOwner",
    `${helperSource}; return assertExpectedPromotedScope;`,
  )(
    (graph) => ({
      scope: "subgraph",
      owner_node_id: 78,
      workflow_uuid: "workflow-a",
      graph_identity: graph.name === "A" ? "graph-a" : "graph-b",
    }),
    () => ({ id: 78 }),
  );
  const graphA = { name: "A" };
  const graphB = { name: "B" };
  const current = () => ({ graph: currentGraph, rootGraph: {} });
  let currentGraph = graphA;
  const expected = {
    scope: "subgraph",
    owner_node_id: 78,
    workflow_uuid: "workflow-a",
    graph_identity: "graph-a",
  };
  assert.doesNotThrow(() => assertScope(current(), expected));
  currentGraph = graphB;
  assert.throws(() => assertScope(current(), expected), /promoted receiver changed before dispatch/);
});

test("#2314 terminal endpoint is part of the shipped receiver fence", () => {
  const helperStart = PANEL_SRC.indexOf("function canonicalExpectedPromotedOwner");
  const helperEnd = PANEL_SRC.indexOf("\n\n// ---- per-turn graph snapshots", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "production scope helper boundary not found");
  const assertScope = new Function(
    "describeActiveGraph",
    "findSubgraphOwner",
    `${PANEL_SRC.slice(helperStart, helperEnd)}; return assertExpectedPromotedScope;`,
  )(
    () => ({
      scope: "subgraph",
      owner_node_id: 78,
      workflow_uuid: "workflow-a",
      graph_identity: "graph-a",
    }),
    () => ({ id: 78 }),
  );
  const current = { graph: {}, rootGraph: {} };
  const expected = {
    scope: "subgraph",
    owner_node_id: 78,
    workflow_uuid: "workflow-a",
    graph_identity: "graph-a",
    terminal: {
      node_id: 2768,
      type: "KSampler",
      widget: "steps",
      inputs: [{ name: "steps", type: "INT" }],
      chain_depth: 1,
    },
  };
  const liveTerminal = () => ({
    node_id: 2768,
    type: "KSampler",
    widget: "steps",
    inputs: [{ name: "steps", type: "INT" }],
    depth: 1,
  });

  assert.doesNotThrow(() => assertScope(current, expected, liveTerminal));
  assert.throws(
    () => assertScope(current, { ...expected, terminal: { ...expected.terminal, node_id: 99 } }, liveTerminal),
    /promoted terminal receiver changed or became unverifiable/,
  );
  assert.throws(
    () => assertScope(current, { ...expected, terminal: { ...expected.terminal, chain_depth: 17 } }, liveTerminal),
    /chain_depth must be a bounded integer/,
  );
  assert.throws(
    () => assertScope(current, expected),
    /could not verify the terminal promotion endpoint/,
  );
});
