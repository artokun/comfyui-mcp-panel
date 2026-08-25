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

test("says what the id IS, and where it resolved", () => {
  const msg = describeRailNodeTarget(-20, "output");
  assert.match(msg, /OUTPUT BOUNDARY RAIL/);
  assert.match(msg, /rails\.output\.rail_node_id/);
  assert.match(msg, /in the graph you are viewing/);
});

test("drops the false claims — WITHOUT replacing them with a new one", () => {
  const msg = describeRailNodeTarget(-20, "output");
  assert.ok(!/may be from a different workflow/.test(msg), "the id came from this graph");
  assert.ok(!/the node was removed/.test(msg), "nothing was removed");
  // The first draft asserted "this is not a stale or foreign id". It cannot know
  // that (codex review): node ids are arbitrary integers, so an ordinary node may
  // once have held this id and been deleted. The message reports what RESOLVED and
  // leaves the one case it cannot rule out standing.
  assert.ok(!/not a stale or foreign id/.test(msg), "an unprovable claim");
});

test("keeps the re-read remedy available for the case it IS right for", () => {
  const msg = describeRailNodeTarget(-20, "output");
  // Not as the headline — prescribing it for a rail_node_id is the loop the
  // reporter ran — but a stale ordinary id that collides with a rail is real, and
  // for that caller re-reading is exactly right.
  assert.match(msg, /If you meant an ORDINARY node with this id/);
  assert.match(msg, /re-read\s+panel_graph_outline if that is your case/);
});

test("names what accepts a rail id — and how each one actually takes it", () => {
  const msg = describeRailNodeTarget(-20, "output");
  // panel_move_node takes the ID (pos only); panel_move_rail takes the SIDE. Saying
  // "both accept rail ids" would send a caller to pass -20 to a tool whose schema is
  // rail:"input"|"output" — verified against the registration, not assumed.
  assert.match(msg, /panel_move_node DOES accept a rail id, but only to reposition it/);
  assert.match(msg, /panel_move_rail addresses the same rail by SIDE/);
});

test("names the unexpose tools as the removal path — by slot NAME, not rail id (artokun/comfyui-mcp#1294)", () => {
  const msg = describeRailNodeTarget(-20, "output");
  // The removal half is no longer parked: the tools exist and are named. But the
  // message must not read as "pass -20 to unexpose" — a rail id names the whole
  // rail and is refused there too.
  assert.match(msg, /panel_unexpose_subgraph_input/);
  assert.match(msg, /panel_unexpose_subgraph_output/);
  assert.match(msg, /take the slot's NAME/);
  assert.match(msg, /a rail id is refused there too/);
  // The interior-node workaround stays named for the slot-and-source case.
  assert.match(msg, /Removing or replacing the interior node/);
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
  // And it stays diagnostics-only: resolution is still the current graph alone,
  // with the live-list/index reconciliation covered by #1759.
  assert.ok(body.includes("resolveLiveNode(graph, nodeId)"));
});
