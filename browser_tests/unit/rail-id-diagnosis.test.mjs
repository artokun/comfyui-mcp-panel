// artokun/comfyui-mcp#1294 — the read surface hands out an id the write surface
// called foreign.
//
// `panel_query_graph` reports a subgraph's boundary rails as
// `rails.output.rail_node_id: "-20"`. Feeding that straight back to a write got:
//
//     No node with id -20 in the current graph — and it is not in any other scope
//     either (searched the root graph and 4 subgraph(s)). The id may be from a
//     different workflow, or the node was removed. Re-read with panel_graph_outline
//     before retrying.
//
// Every clause after the first is false. The id came from THIS graph, from our own
// read, one call earlier; nothing was removed; and the prescribed remedy re-reads
// the surface that produced it — the loop the reporter actually ran.
//
// This is #697's mistake in a new place. There the missing axis was SCOPE ("it is
// somewhere else"); here it is KIND ("it is not that sort of thing"). Both used to
// end at the same dead sentence.
//
// SCOPE OF THIS FIX: the diagnosis only. Removing a boundary slot still has no
// operation, and this must not imply one — inventing a tool name would send the
// caller to a command that does not exist. That half stays parked.

import assert from "node:assert/strict";
import test from "node:test";

import { describeRailNodeTarget } from "../../web/js/lib/node-scope-locator.js";
import { resolveRailNode } from "../../web/js/lib/subgraph-scope.js";

/** A graph whose OUTPUT rail carries the reporter's id. */
function graphWithOutputRail(id = -20) {
  return {
    inputNode: { id: -10 },
    outputNode: { id },
    _nodes: [],
    getNodeById: () => null, // rails are never in _nodes_by_id — the real behaviour
  };
}

test("the reporter's id resolves as a rail — so 'no such node' was never true", () => {
  // The composition resolveNode performs: getNodeById declines, THEN we ask what
  // the id actually is.
  const found = resolveRailNode(graphWithOutputRail(), -20);
  assert.ok(found, "-20 must resolve as a boundary rail");
  assert.equal(found.rail, "output");
});

test("says what the id IS, and that it exists", () => {
  const msg = describeRailNodeTarget(-20, "output");
  assert.match(msg, /OUTPUT BOUNDARY RAIL/);
  assert.match(msg, /rails\.output\.rail_node_id/);
  assert.match(msg, /not a stale or foreign id/);
});

test("drops all three false claims", () => {
  const msg = describeRailNodeTarget(-20, "output");
  assert.ok(!/different workflow/.test(msg), "the id came from this graph");
  assert.ok(!/was removed/.test(msg), "nothing was removed");
  assert.ok(
    !/Re-read with panel_graph_outline/.test(msg),
    "re-reading returns the same id — that is the loop the reporter ran",
  );
});

test("names what DOES accept a rail id, rather than only refusing", () => {
  const msg = describeRailNodeTarget(-20, "output");
  assert.match(msg, /panel_move_node/);
  assert.match(msg, /move_rail/);
});

test("does NOT invent an unexpose tool — that half is parked", () => {
  const msg = describeRailNodeTarget(-20, "output");
  assert.ok(!/unexpose_subgraph/.test(msg), "no such command exists");
  assert.match(msg, /NO unexpose\/remove-boundary operation/);
  // The workaround that does work today is named instead of implied.
  assert.match(msg, /remove or replace the interior node/);
});

test("the INPUT rail reads as itself, not as a copy of the output text", () => {
  const msg = describeRailNodeTarget(-10, "input");
  assert.match(msg, /INPUT BOUNDARY RAIL/);
  assert.match(msg, /rails\.input\.rail_node_id/);
  assert.ok(!/OUTPUT/.test(msg));
});

test("a REAL node owning the id still wins — the diagnosis never fires for it", () => {
  // subgraph-scope's collision guard (#302): ComfyUI permits any integer node id,
  // so a real node with id -20 must resolve as that node. If this ever inverted,
  // an ordinary missing-node failure would be misreported as a rail.
  const real = { id: -20, type: "KSampler" };
  const graph = { inputNode: { id: -10 }, outputNode: { id: -20 }, getNodeById: () => real };
  assert.equal(resolveRailNode(graph, -20), null);
});

// ── WIRING ────────────────────────────────────────────────────────────────
// resolveNode is module-private and shared by 20+ handlers. A helper-only test
// cannot see the call being dropped, and dropping it restores the false message
// everywhere — so the composition is pinned at source.
test("WIRING: resolveNode asks WHAT the id is before reporting it missing", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(
    src,
    /import \{ describeMissingNode, describeRailNodeTarget \} from "\.\/lib\/node-scope-locator\.js";/,
  );

  const fn = src.slice(src.indexOf("function resolveNode(graph, nodeId) {"));
  const body = fn.slice(0, fn.indexOf("function normalizeLegacyNodeId"));

  assert.ok(body.includes("resolveRailNode(graph, nodeId)"), "the rail check must run");
  assert.ok(
    body.includes("throw new Error(describeRailNodeTarget(nodeId, rail.rail))"),
    "a resolved rail must produce the rail message",
  );
  // ORDER IS THE BEHAVIOUR: the rail branch has to come first, or the generic
  // "not in any other scope" message wins and nothing changes for the caller.
  assert.ok(
    body.indexOf("describeRailNodeTarget") < body.indexOf("describeMissingNode"),
    "the rail branch must precede the generic miss",
  );
  // And it stays diagnostics-only: resolution is still the current graph alone.
  assert.ok(body.includes("graph.getNodeById(Number(nodeId))"));
});
