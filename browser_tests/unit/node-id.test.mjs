// artokun/comfyui-mcp#1425 — subgraph-qualified node ids must RESOLVE, and must
// never resolve to a different node.
//
// The dangerous direction is the fix done halfway. Widening what is accepted while
// still coercing turns "no node with id 263:78" into a silent edit of node 263, so
// every acceptance assertion here is paired with an identity one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalNodeId, isQualifiedNodeId } from "../../web/js/lib/node-id.js";

test("#1425 a qualified id is recognised at any depth", () => {
  for (const id of ["120:104", "263:78", "120:113:78", "1:2:3:4", "-20:3"]) {
    assert.equal(isQualifiedNodeId(id), true, id);
  }
});

test("#1425 a plain id is NOT qualified — it keeps the old numeric path", () => {
  for (const id of ["42", "0", "-20", 42, -20]) {
    assert.equal(isQualifiedNodeId(id), false, String(id));
  }
});

test("#1425 malformed shapes are not qualified ids", () => {
  for (const id of ["1:", ":1", "1::2", "1:2:", "1:-2", "1: 2", "a:b", "", "4.5:1"]) {
    assert.equal(isQualifiedNodeId(id), false, JSON.stringify(id));
  }
});

test("#1425 a qualified id reaches LiteGraph VERBATIM", () => {
  assert.equal(canonicalNodeId("263:78"), "263:78");
  assert.equal(canonicalNodeId("120:113:78"), "120:113:78");
  // The trap, stated outright: this is a real, different node in the same graph.
  assert.notEqual(canonicalNodeId("263:78"), 263);
  assert.notEqual(canonicalNodeId("263:78"), Number.parseInt("263:78", 10));
});

test("#1425 a plain id still becomes the NUMBER it always was", () => {
  assert.equal(canonicalNodeId("42"), 42);
  assert.equal(canonicalNodeId(42), 42);
  assert.equal(canonicalNodeId("-20"), -20); // boundary rail
});

test("#1425 a qualified id resolves against a LiteGraph-shaped lookup", () => {
  // getNodeById is `_nodes_by_id[id]`; object keys are strings, which is WHY
  // passing the qualified form through works. Measured against a live ComfyUI:
  // node ids there are already strings.
  const nodesById = { "263:78": { id: "263:78" }, 263: { id: 263 } };
  const getNodeById = (id) => nodesById[id] ?? null;

  assert.equal(getNodeById(canonicalNodeId("263:78")).id, "263:78");
  // Before the fix this was Number("263:78") === NaN → nothing.
  assert.equal(getNodeById(Number("263:78")), null);
  // And the plain id must still land on the OTHER node, not the qualified one.
  assert.equal(getNodeById(canonicalNodeId("263")).id, 263);
});

test("#1425 genuinely bad input still lands on NaN for the caller to report", () => {
  assert.ok(Number.isNaN(canonicalNodeId("abc")));
  assert.ok(Number.isNaN(canonicalNodeId("1:-2")));
});
