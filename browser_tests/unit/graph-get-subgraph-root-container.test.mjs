/**
 * artokun/comfyui-mcp-panel#1941 — a root-level ordinary node is not a promoted
 * container. MCP's `preparePromotedWidgetWrite` calls graph_get_subgraph when
 * the query probe is not a boolean `is_subgraph:false` at root. Anything other
 * than the panel's own `Node <id> (<type>) is not a subgraph` line is treated
 * as indeterminate and refused:
 *
 *   panel_set_widget refused the promoted "filename_prefix" write because
 *   graph_get_subgraph could not determine whether the addressed node is a
 *   promoted container. No graph_set_widget was dispatched.
 *
 * VHS_VideoCombine in the report is a plain root node. A truthy leftover
 * `subgraph` that is not a live inner graph used to skip the throw, and a type
 * with nested parentheses made the orchestrator miss the definitive form.
 *
 * Run with `node --test`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isPromotedContainer } from "../../web/js/lib/graph-read.js";

const PANEL_SRC = readFileSync(
  new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

/** Copied from the orchestrator's `isDefinitiveNonPromotedSubgraphRead`. A
 *  throw that does not match this is rewritten as the #1941 refusal. */
const DEFINITIVE_NON_SUBGRAPH_RE =
  /^Error:\s*Node\s+\S+(?:\s+\((?:(?:[^()]|\([^()]*\))*|[^)]*)\))?\s+is not a subgraph\b/i;

function asOrchestratorError(err) {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

function loadGetSubgraph() {
  const start = PANEL_SRC.indexOf("graph_get_subgraph({ node_id }) {");
  const end = PANEL_SRC.indexOf("async graph_add_node(", start);
  assert.ok(start >= 0 && end > start, "graph_get_subgraph handler must remain extractable");
  const method = PANEL_SRC.slice(start, end).replace(/,\s*$/, "");
  return (node) =>
    new Function(
      "getGraphCtx",
      "resolveNode",
      "describeActiveGraph",
      "subgraphValueProvenance",
      "redactWidgetValue",
      "graphViewIdentityFor",
      "MAX_STATE_NODES",
      "fixedCapNote",
      "summarizeNode",
      "promotedTerminalWitnesses",
      "isPromotedContainer",
      `return ({${method}}).graph_get_subgraph;`,
    )(
      () => ({ graph: {} }),
      () => node,
      () => ({ scope: "root", graph_identity: "graph:root" }),
      () => ({}),
      () => ({}),
      () => "graph:child",
      50,
      () => "truncation note",
      (inner) => ({ id: inner.id, type: inner.type }),
      () => [],
      isPromotedContainer,
    );
}

function assertDefinitiveNonContainer(node) {
  const getSubgraph = loadGetSubgraph()(node);
  let thrown;
  try {
    getSubgraph({ node_id: node.id });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `expected a throw for node ${node.id}`);
  assert.match(
    asOrchestratorError(thrown),
    DEFINITIVE_NON_SUBGRAPH_RE,
    `ordinary node ${node.id} (${node.type}) must stay a parseable non-container, not an indeterminate probe`,
  );
}

test("#1941 a root VHS_VideoCombine throws the definitive non-container line", () => {
  const getSubgraph = loadGetSubgraph()({
    id: 74,
    type: "VHS_VideoCombine",
    widgets: [{ name: "filename_prefix", value: "video/ComfyUI" }],
  });
  assert.throws(
    () => getSubgraph({ node_id: 74 }),
    (err) => {
      assert.match(String(err.message), /Node 74 \(VHS_VideoCombine\) is not a subgraph/);
      assert.match(asOrchestratorError(err), DEFINITIVE_NON_SUBGRAPH_RE);
      return true;
    },
  );
});

test("#1941 a truthy leftover subgraph that is not a live inner graph is still not a container", () => {
  // The unfixed predicate was `if (!sub)`. `{}` is truthy, so the handler
  // returned a fake ownership envelope and MCP refused the write as
  // indeterminate instead of dispatching graph_set_widget.
  for (const leftover of [{}, { name: "not-a-graph" }, { nodes: "nope" }]) {
    const getSubgraph = loadGetSubgraph()({
      id: 74,
      type: "VHS_VideoCombine",
      subgraph: leftover,
    });
    assert.throws(
      () => getSubgraph({ node_id: 74 }),
      (err) => {
        assert.match(asOrchestratorError(err), DEFINITIVE_NON_SUBGRAPH_RE);
        return true;
      },
      `leftover subgraph ${JSON.stringify(leftover)} must not look like a container`,
    );
  }
});

test("#1941 nested parentheses in the node type still parse as definitive", () => {
  const getSubgraph = loadGetSubgraph()({
    id: 82,
    type: "Foo (Bar (Baz))",
  });
  assert.throws(
    () => getSubgraph({ node_id: 82 }),
    (err) => {
      assert.doesNotMatch(String(err.message), /\(.*\(.*\).*\)/);
      assert.match(asOrchestratorError(err), DEFINITIVE_NON_SUBGRAPH_RE);
      return true;
    },
  );
});

test("#1941 a parenthesised pack type stays parseable after flattening", () => {
  assertDefinitiveNonContainer({ id: 43, type: "KSampler (Efficient)" });
  assertDefinitiveNonContainer({ id: 82, type: "Power Lora Loader (rgthree)" });
});

test("#1941 a missing type still throws the canonical line", () => {
  const getSubgraph = loadGetSubgraph()({ id: 9 });
  assert.throws(
    () => getSubgraph({ node_id: 9 }),
    (err) => {
      assert.equal(err.message, "Node 9 is not a subgraph");
      assert.match(asOrchestratorError(err), DEFINITIVE_NON_SUBGRAPH_RE);
      return true;
    },
  );
});

test("#2006 a root PrimitiveNode throws the definitive non-container line", () => {
  assertDefinitiveNonContainer({
    id: 198,
    type: "PrimitiveNode",
    isVirtualNode: true,
    widgets: [{ name: "value", value: "a prompt" }],
  });
});

test("#2006 a PrimitiveNode leftover subgraph that looks live is still not a container", () => {
  // The unfixed predicate treated any live-looking `.subgraph` as a container.
  // PrimitiveNode is a frontend value source: leftover `_nodes` / getNodeById
  // must not skip the definitive throw, or MCP refuses the ordinary `value` write.
  for (const leftover of [
    { _nodes: [{ id: 1, type: "CLIPTextEncode" }] },
    { nodes: [{ id: 1, type: "CLIPTextEncode" }] },
    { getNodeById() { return null; } },
  ]) {
    assertDefinitiveNonContainer({
      id: 198,
      type: "PrimitiveNode",
      isVirtualNode: true,
      subgraph: leftover,
    });
  }
});

test("#2006 a PrimitiveNode whose subgraph getter throws still uses the definitive line", () => {
  const node = {
    id: 198,
    type: "PrimitiveNode",
    isVirtualNode: true,
    get subgraph() {
      throw new Error("subgraph accessor exploded");
    },
  };
  assertDefinitiveNonContainer(node);
});

test("#1941 a live inner graph is still a container — the throw does not fire", () => {
  const inner = { id: 12, type: "PrimitiveBoolean" };
  const getSubgraph = loadGetSubgraph()({
    id: 4,
    type: "SubgraphNode",
    title: "Video",
    subgraph: { _nodes: [inner] },
  });
  const out = getSubgraph({ node_id: 4 });
  assert.equal(out.subgraph_of.node_id, 4);
  assert.equal(out.node_count, 1);
  assert.equal(out.nodes[0].id, 12);
  assert.deepEqual(out.promoted_terminals, []);
  assert.equal(out.truncated, false, "a complete ownership envelope must emit truncated:false, not omit it");
});

/** MCP's promoted-write fence: missing `truncated` used to be `!== false` and
 *  a veto; current MCP still vetoes any asserted truncation and any
 *  node_count/nodes length mismatch. Copied from
 *  describePromotedSubgraphEnvelope so a listing cap cannot look like a
 *  complete witness. */
function mcpAcceptsOwnershipEnvelope(payload) {
  if (!payload || typeof payload !== "object") return false;
  // Older MCP: `truncated !== false` (unset is a veto).
  if (payload.truncated !== false) return false;
  if (!Number.isSafeInteger(payload.node_count) || payload.node_count < 0) return false;
  if (!Array.isArray(payload.nodes)) return false;
  if (payload.nodes.length !== payload.node_count) return false;
  return true;
}

test("#2057 a 162-node subgraph still publishes a complete ownership envelope", () => {
  // The reporter's wrapper 6066 had 162 inner nodes. graph_get_subgraph used to
  // slice at MAX_STATE_NODES (50 in this harness, 100 in production) and set
  // truncated:true — MCP then refused panel_set_widget on the promoted
  // model_name before graph_set_widget dispatch.
  const inner = Array.from({ length: 162 }, (_, i) => ({
    id: i + 1,
    type: i === 0 ? "UNETLoader" : "CLIPTextEncode",
  }));
  const getSubgraph = loadGetSubgraph()({
    id: 6066,
    type: "SubgraphNode",
    title: "wrapper",
    subgraph: { _nodes: inner },
  });
  const out = getSubgraph({ node_id: 6066 });
  assert.equal(out.truncated, false, "truncated must be exactly false, not unset and not true");
  assert.equal(out.node_count, 162);
  assert.equal(out.nodes.length, 162);
  assert.equal(out.nodes[0].id, 1);
  assert.equal(out.nodes[161].id, 162);
  assert.equal(out.truncation_hint, undefined);
  assert.ok(mcpAcceptsOwnershipEnvelope(out), "MCP's ownership fence must accept this envelope");
});

test("#2057 graph_get_subgraph does not cap the inner list used as an ownership envelope", () => {
  const src = PANEL_SRC.slice(
    PANEL_SRC.indexOf("graph_get_subgraph({ node_id }) {"),
    PANEL_SRC.indexOf("async graph_add_node(", PANEL_SRC.indexOf("graph_get_subgraph({ node_id }) {")),
  );
  assert.doesNotMatch(
    src,
    /inner\.slice\s*\(\s*0\s*,\s*MAX_STATE_NODES\s*\)/,
    "slicing the inner list makes node_count disagree with nodes[] and vetoes the write",
  );
  assert.doesNotMatch(
    src,
    /truncated:\s*inner\.length\s*>\s*MAX_STATE_NODES/,
    "asserting truncated:true is a promoted-write veto even when promoted_terminals is complete",
  );
  assert.match(src, /truncated:\s*false/, "complete ownership envelopes emit truncated:false");
});
