import { test } from "node:test";
import assert from "node:assert/strict";
import {
  locateNodeAcrossScopes,
  countSubgraphs,
  describeMissingNode,
} from "../../web/js/lib/node-scope-locator.js";

/**
 * #697 — "No node with id 105 in the current graph", right after graph_outline AND
 * query_graph had both reported node 105 on the active workflow.
 *
 * Nothing was stale. Reads walk every scope; a write applies to the graph being
 * VIEWED. The old message named neither scope, so a scope mismatch looked like a
 * routing/session bug — the reporter's workaround (re-target, re-read, retry) worked
 * only because it reset the viewing scope.
 */

const node = (id, extra = {}) => ({ id, ...extra });
const sub = (nodes) => ({ _nodes: nodes });

test("finds a node nested inside a subgraph and reports the route", () => {
  const root = sub([node(1), node(9, { title: "Video", subgraph: sub([node(104), node(105)]) })]);
  const hit = locateNodeAcrossScopes(root, 105);
  assert.equal(hit.scope, "subgraph");
  assert.deepEqual(hit.hostPath, [{ id: 9, title: "Video" }]);
});

test("finds a root node with an empty host path", () => {
  const root = sub([node(1), node(2)]);
  assert.deepEqual(locateNodeAcrossScopes(root, 2), { scope: "root", hostPath: [] });
});

test("prefers the CURRENT level over a same-id node deeper in", () => {
  // Load-bearing: ids are only unique within a graph, so a nested node can share an
  // id with a root node. Reporting the deep one would send the caller into a
  // subgraph they never needed to enter.
  const root = sub([node(5), node(9, { title: "S", subgraph: sub([node(5)]) })]);
  assert.deepEqual(locateNodeAcrossScopes(root, 5).hostPath, []);
});

test("walks more than one level deep", () => {
  const inner = sub([node(77)]);
  const mid = sub([node(50), node(60, { title: "Inner", subgraph: inner })]);
  const root = sub([node(9, { title: "Outer", subgraph: mid })]);
  const hit = locateNodeAcrossScopes(root, 77);
  assert.deepEqual(hit.hostPath.map((h) => h.title), ["Outer", "Inner"]);
});

test("returns null for an id that is nowhere", () => {
  assert.equal(locateNodeAcrossScopes(sub([node(1)]), 999), null);
});

test("a shared subgraph instance cannot loop the walk", () => {
  // The same subgraph object instanced twice must be visited once, not forever.
  const shared = sub([node(42)]);
  const root = sub([node(1, { subgraph: shared }), node(2, { subgraph: shared })]);
  assert.equal(locateNodeAcrossScopes(root, 42).scope, "subgraph");
  assert.equal(countSubgraphs(root), 2);
});

test("a self-referencing graph terminates instead of hanging", () => {
  const loop = { _nodes: [] };
  loop._nodes.push({ id: 1, subgraph: loop });
  assert.equal(locateNodeAcrossScopes(loop, 999), null);
  assert.ok(Number.isFinite(countSubgraphs(loop)));
});

test("a DEEP acyclic chain is bounded — `seen` never fires when every level is distinct", () => {
  // The hazard MAX_DEPTH exists for, and the one `seen` cannot catch: 400 distinct
  // graph objects, no repetition. Without the depth bound this recurses the whole
  // chain (and, on a pathological graph, past the stack).
  let deepest = { _nodes: [{ id: 999 }] };
  for (let i = 0; i < 400; i++) deepest = { _nodes: [{ id: i, subgraph: deepest }] };
  // The target sits below MAX_DEPTH, so a bounded search must NOT find it.
  assert.equal(locateNodeAcrossScopes(deepest, 999), null, "the search must stop before the bottom");
  // …while a node inside the bound is still found, so the guard is a ceiling and
  // not a blanket refusal.
  assert.ok(locateNodeAcrossScopes(deepest, 398), "shallow nodes stay reachable");
});

test("malformed graphs never throw — a diagnostic must not fail", () => {
  for (const bad of [null, undefined, 42, "x", {}, { _nodes: "nope" }]) {
    assert.doesNotThrow(() => locateNodeAcrossScopes(bad, 1));
    assert.equal(locateNodeAcrossScopes(bad, 1), null);
  }
  assert.equal(locateNodeAcrossScopes(sub([node(1)]), "not-a-number"), null);
});

// ── the message ───────────────────────────────────────────────────────────

test("keeps the historic prefix so existing matchers still work", () => {
  for (const root of [null, sub([node(1)])]) {
    assert.match(describeMissingNode(105, root, true), /^No node with id 105/);
  }
});

test("the reporter's case: names the subgraph, the host node, and the remedy", () => {
  const root = sub([node(9, { title: "MiniMax", subgraph: sub([node(104), node(105)]) })]);
  const msg = describeMissingNode(105, root, true);
  assert.match(msg, /lives INSIDE a subgraph/);
  assert.match(msg, /"MiniMax" \(node 9\)/);
  assert.match(msg, /panel_enter_subgraph\(9\)/);
  // Explains WHY the reads disagreed — the thing that made it look like staleness.
  assert.match(msg, /Reads such as panel_graph_outline span every scope/);
  // And refuses to overclaim which instance.
  assert.match(msg, /not necessarily the only one/);
});

test("a root node while viewing a subgraph tells you to EXIT", () => {
  const root = sub([node(7)]);
  const msg = describeMissingNode(7, root, false);
  assert.match(msg, /on the ROOT graph/);
  assert.match(msg, /panel_exit_subgraph/);
});

test("a genuine miss says how hard it looked, and does not invent a location", () => {
  const root = sub([node(1), node(9, { subgraph: sub([node(2)]) })]);
  const msg = describeMissingNode(999, root, true);
  assert.match(msg, /not in any other scope either/);
  assert.match(msg, /1 subgraph\(s\)/);
  assert.ok(!/panel_enter_subgraph/.test(msg), "must not suggest entering anything");
});

test("no root graph ⇒ the original message, unchanged", () => {
  assert.equal(describeMissingNode(5, null, true), "No node with id 5 in the current graph");
});

// ── WIRING ────────────────────────────────────────────────────────────────
test("WIRING: resolveNode builds its error through describeMissingNode", async () => {
  // resolveNode is module-private and shared by 20+ handlers, so the wiring is pinned
  // at source. Without it every one of them reverts to the bare message.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /import \{ describeMissingNode \} from "\.\/lib\/node-scope-locator\.js";/);
  const fn = src.slice(src.indexOf("function resolveNode(graph, nodeId) {"));
  const body = fn.slice(0, fn.indexOf("function normalizeLegacyNodeId"));
  assert.ok(body.includes("describeMissingNode(nodeId, rootGraph, viewingRoot)"),
    "the failure path must go through the locator");
  // The lookup itself must be unchanged — this is diagnostics only, never a wider search.
  assert.ok(body.includes("graph.getNodeById(Number(nodeId))"),
    "resolution must still be scoped to the current graph");
  // And the diagnostic must not be able to break the call.
  assert.ok(body.includes("} catch {"), "reading the root must be guarded");
});
