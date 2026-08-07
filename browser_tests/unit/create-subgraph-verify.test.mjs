import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * PROACTIVE — fourth find from the audit behind #232 / #635 / #708 / #710, after
 * set_node_mode (#739), remove_group (#740) and clear (#741).
 *
 * `graph_create_subgraph` and `graph_subgraph_group` both reported the converted
 * node's id with a null fallback, so a conversion that produced nothing returned
 * `{subgraph: {node_id: null, name: null, …}}` with NO error. That reads as "a
 * subgraph was created, with a missing field" rather than "nothing happened" — and
 * the caller then addresses a node id that does not exist.
 *
 * The sibling `graph_add_subgraph` already guards exactly this ("don't report a fake
 * success if deserialize produced nothing"). This is that rule applied to the two
 * paths that were missing it — the same one-surface-not-its-sibling shape as #712.
 */

const src = () =>
  readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

/** Source with comment lines stripped. The guard's own doc comment quotes the bad
 *  expression to explain what it prevents, and matching that would fail on a correct
 *  tree — the assertion has to look at code. */
const code = () =>
  src()
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");

function guardBody() {
  const s = src();
  const fn = s.slice(s.indexOf("function assertSubgraphNodeLanded("));
  return fn.slice(0, fn.indexOf("function clearStaleRedFlagsAfterSubgraphConversion"));
}

test("neither conversion path reports a null-coalesced node id any more", () => {
  assert.ok(
    !/node_id: res\?\.node\?\.id \?\? null/.test(code()),
    "a conversion result must not be reported with a null-coalesced node id",
  );
});

test("both paths assert the node LANDED before reporting", () => {
  const s = src();
  assert.match(s, /assertSubgraphNodeLanded\(res, graph, "panel_create_subgraph"\)/);
  assert.match(s, /assertSubgraphNodeLanded\(res, graph, "panel_subgraph_group"\)/);
  // …and the reported id comes from the verified node, not the raw result.
  assert.match(s, /node_id: created\.id,/);
  assert.match(s, /node_id: grouped\.id,/);
});

test("the guard checks the LIVE graph, not just the returned object", () => {
  // A result carrying a node that never landed is exactly the case a truthful report
  // has to catch, so an id alone is not enough.
  const body = guardBody();
  assert.ok(body.includes("list.includes(node)"), "must confirm the node is on the graph");
  assert.match(
    body,
    /if \(id == null \|\| \(list && !list\.includes\(node\)\)\) \{/,
    "the refusal must be gated on the missing id OR the absent node",
  );
});

test("an unreadable node list does not manufacture a failure", () => {
  // `list` is null when `_nodes` is not an array; the guard must then fall back to the
  // id check alone rather than refusing every conversion on an unfamiliar frontend.
  assert.ok(
    guardBody().includes("Array.isArray(graph?._nodes) ? graph._nodes : null"),
    "an unreadable list must degrade to the id check, not to a refusal",
  );
});

test("the refusal says nothing was created and leaves the selection alone", () => {
  const body = guardBody();
  assert.match(body, /Nothing is being reported as created/);
  assert.match(body, /left as they are/);
});
