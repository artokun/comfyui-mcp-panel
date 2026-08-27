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
});
