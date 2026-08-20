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
  assert.equal(locateNodeAcrossScopes(sub([node(1)]), "not-a-number").undetermined, "unparseable");
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

// ── #1495 the scope claim must be CHECKED, not assumed ────────────────────
//
// Reporter: panel_exit_subgraph returned scope=root / settled=true; a later
// panel_enter_subgraph(5548) failed saying they were inside a subgraph; the
// panel_exit_subgraph that error prescribed answered "already at root"; the
// retry then succeeded. Nothing in the panel had two scope stores to
// desynchronise — resolveScope is the single authority. What was wrong was the
// MESSAGE: this branch asserted a subgraph scope it never looked at, because its
// premise ("only reachable while viewing a subgraph") is not an invariant. The
// root walk reads `_nodes`; the lookup that missed reads `getNodeById`. When
// those two drift on the ROOT graph, the caller is at root and is sent to leave a
// subgraph they are not in — the exact round-trip the reporter ran.

test("#1495 a root node that missed while VIEWING root does not claim a subgraph", () => {
  // The lookup searched the root graph itself (currentGraph === rootGraph) and the
  // root walk found the id there. Claiming a subgraph scope here is unsupportable.
  const root = sub([node(5548, { type: "SaveImage" }), node(12, { type: "KSampler" })]);
  const msg = describeMissingNode(5548, root, true, root);
  assert.match(msg, /^No node with id 5548/);
  assert.ok(
    !/you are currently inside a subgraph/.test(msg),
    "must not assert a viewing scope it did not check",
  );
  assert.ok(
    !/Call panel_exit_subgraph, then retry/.test(msg),
    "prescribing the exit is the wasted round-trip the reporter ran",
  );
  assert.match(msg, /IS on the root graph/);
  assert.match(msg, /NOT a subgraph scope problem/);
  // and it still hands back something the caller can act on
  assert.match(msg, /12 \(KSampler\)/);
});

test("#1495 the graph the lookup SEARCHED outranks a separately-read viewingRoot", () => {
  // resolveNode reads `viewingRoot` from a SECOND getGraphCtx(), taken after the
  // lookup. `currentGraph` is the graph the lookup actually ran on, so identity
  // against the root decides — two readings must not be presented as one.
  const root = sub([node(7, { type: "A" }), node(8, { type: "B" })]);
  const msg = describeMissingNode(7, root, false, root);
  assert.ok(!/you are currently inside a subgraph/.test(msg));
  assert.match(msg, /IS on the root graph/);
});

test("#1495 a genuine subgraph view still gets the EXIT remedy", () => {
  // The fix must not disarm the #697 message: when the lookup really did run on a
  // subgraph, leaving it IS the remedy.
  const inner = sub([node(10, { type: "InnerA" })]);
  const root = sub([node(7, { type: "Root" }), node(9, { title: "S", subgraph: inner })]);
  const msg = describeMissingNode(7, root, false, inner);
  assert.match(msg, /on the ROOT graph/);
  assert.match(msg, /you are currently inside a subgraph/);
  assert.match(msg, /Call panel_exit_subgraph, then retry/);
});

test("#1495 a root graph holding only the missing node does not also say it is empty", () => {
  // currentIdSuffix filters the missing id out, so a one-node root degrades to
  // "has no nodes" — which would contradict "it IS on the root graph" in the same
  // breath. The retarget list is offered only when it actually names ids.
  const root = sub([node(7, { type: "SaveImage" })]);
  const msg = describeMissingNode(7, root, true, root);
  assert.match(msg, /IS on the root graph/);
  assert.ok(!/currently has no nodes/.test(msg), "self-contradicting in one message");
  assert.match(msg, /Re-read with panel_graph_outline/);
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

// ── #1298 current ids on a genuine miss ───────────────────────────────────
//
// Reporter: panel_remove_node(99) after a prior outline had shown 99, then the
// user deleted nodes. The miss said only "not in the current graph" and sent
// them to re-read — a second round-trip whose answer was already on the graph
// the write had just searched. Naming the live ids lets the next mutation
// retarget (or skip) without another outline.

test("#1298 genuine miss lists the current live ids so a mutation can retarget", () => {
  const root = sub([
    node(1, { type: "CheckpointLoaderSimple" }),
    node(3, { type: "KSampler" }),
    node(8, { type: "SaveImage" }),
  ]);
  const msg = describeMissingNode(99, root, true);
  assert.match(msg, /^No node with id 99/);
  assert.match(msg, /not in any other scope either/);
  assert.match(msg, /Current ids on the graph you are viewing:/);
  assert.match(msg, /1 \(CheckpointLoaderSimple\)/);
  assert.match(msg, /3 \(KSampler\)/);
  assert.match(msg, /8 \(SaveImage\)/);
  assert.ok(!/99 \(/.test(msg), "must not invent the missing id as live");
  assert.match(msg, /Retarget using a current id/);
});

test("#1298 lists ids from the graph being viewed, not the root", () => {
  // A subgraph-scoped write that misses must not hand back root ids: those are
  // not addressable without exiting, and naming them would retarget the next
  // mutation into the wrong scope.
  const inner = sub([node(10, { type: "InnerA" }), node(11, { type: "InnerB" })]);
  const root = sub([node(1, { type: "Root" }), node(9, { title: "S", subgraph: inner })]);
  const msg = describeMissingNode(99, root, false, inner);
  assert.match(msg, /10 \(InnerA\)/);
  assert.match(msg, /11 \(InnerB\)/);
  assert.ok(!/1 \(Root\)/.test(msg), "root ids would retarget a write into the wrong scope");
});

test("#1298 current-id list is capped so a large graph does not dump every id", () => {
  const nodes = Array.from({ length: 60 }, (_, i) => node(i + 1, { type: "N" }));
  const msg = describeMissingNode(999, sub(nodes), true);
  assert.match(msg, /Current ids on the graph you are viewing:/);
  assert.match(msg, /1 \(N\)/);
  assert.match(msg, /40 \(N\)/);
  assert.match(msg, /and 20 more/);
  assert.ok(!/\b41 \(N\)/.test(msg), "the 41st id is past the cap");
});

test("#1298 empty current graph is said plainly", () => {
  const msg = describeMissingNode(99, sub([]), true);
  assert.match(msg, /currently has no nodes/);
  assert.match(msg, /Re-read with panel_graph_outline/);
  assert.ok(!/Current ids on the graph you are viewing:/.test(msg));
});

test("#1298 a current graph with no root still names live ids", () => {
  // resolveNode can lose the root (getGraphCtx throws) and still holds the
  // graph it just searched. That graph's ids are the ones a retarget can use.
  const current = sub([node(4, { type: "CLIPTextEncode" })]);
  const msg = describeMissingNode(99, null, true, current);
  assert.match(msg, /^No node with id 99 in the current graph/);
  assert.match(msg, /4 \(CLIPTextEncode\)/);
  assert.match(msg, /Retarget using a current id/);
});

test("#1298 current-id listing never throws", () => {
  const root = { get _nodes() { throw new Error("boom"); } };
  assert.doesNotThrow(() => describeMissingNode(1, root, true));
});

// ── #1501 null must not mean "could not look" ─────────────────────────────
//
// Reporter (filed from the #1495 review): locateNodeAcrossScopes returned
// null for three different jobs — searched-and-absent, the walk threw, and
// the id was not a finite number — and describeMissingNode could only spell
// one of them: "The id may be from a different workflow, or the node was
// removed." A throw mid-walk, or a subgraph-qualified id (`263:78`) the
// rest of the system produces on purpose, was therefore reported as a
// positive statement about the node's absence. Same shape as #1495: a
// diagnostic that could not look claimed a fact it did not have.

test("#1501 a walk that threw is inconclusive, not a miss", () => {
  // Flat scan of this graph succeeds; descending into node 2 throws. The
  // search did not finish, so "not in any other scope" is unsupportable.
  const root = sub([
    node(1, { type: "KSampler" }),
    { id: 2, type: "S", get subgraph() { throw new Error("boom"); } },
  ]);
  const hit = locateNodeAcrossScopes(root, 99);
  assert.equal(hit.undetermined, "threw");
  assert.ok(!hit.scope, "must not look like a location");

  const msg = describeMissingNode(99, root, true, root);
  assert.match(msg, /^No node with id 99/);
  assert.match(msg, /this is not a finding that the node is absent/);
  assert.match(msg, /threw before it finished/);
  assert.ok(!/not in any other scope either/.test(msg), "the walk did not finish");
  assert.ok(!/may be from a different workflow/.test(msg), "must not invent a workflow-identity problem");
  assert.ok(!/the node was removed/.test(msg), "must not invent a removal");
  // live ids on the graph that DID scan are still the retarget the caller can use
  assert.match(msg, /1 \(KSampler\)/);
});

test("#1501 a qualified id is found by the same identity the writes use", () => {
  // Unpacking leaves genuine root nodes whose id is `263:78`. Number("263:78")
  // is NaN, and Number.parseInt is 263 — a different, real node. The locator
  // used to return null before searching and the miss message called it foreign.
  const root = sub([
    node("263:78", { type: "CLIPTextEncode" }),
    node(263, { type: "KSampler" }),
  ]);
  const hit = locateNodeAcrossScopes(root, "263:78");
  assert.equal(hit.scope, "root");
  assert.deepEqual(hit.hostPath, []);
  // The parseInt trap: a graph that only has 263 must NOT report `263:78` as found.
  assert.equal(locateNodeAcrossScopes(sub([node(263)]), "263:78"), null);
});

test("#1501 a qualified id on the root while viewing a subgraph says EXIT, not 'different workflow'", () => {
  const inner = sub([node(10, { type: "InnerA" })]);
  const root = sub([
    node("263:78", { type: "SaveImage" }),
    node(9, { title: "S", subgraph: inner }),
  ]);
  const msg = describeMissingNode("263:78", root, false, inner);
  assert.match(msg, /on the ROOT graph/);
  assert.match(msg, /panel_exit_subgraph/);
  assert.ok(!/may be from a different workflow/.test(msg));
  assert.ok(!/not a local integer or a subgraph-qualified id/.test(msg), "it is a qualified id; we searched");
});

test("#1501 an unparseable id is inconclusive, not a miss", () => {
  const root = sub([node(1, { type: "KSampler" })]);
  const hit = locateNodeAcrossScopes(root, "not-a-number");
  assert.equal(hit.undetermined, "unparseable");

  const msg = describeMissingNode("not-a-number", root, true, root);
  assert.match(msg, /^No node with id not-a-number/);
  assert.match(msg, /this is not a finding that the node is absent/);
  assert.match(msg, /not a local integer or a subgraph-qualified id/);
  assert.ok(!/not in any other scope either/.test(msg), "nothing was searched");
  assert.ok(!/may be from a different workflow/.test(msg));
});

test("#1501 a genuine miss of a qualified id may still say the id is gone", () => {
  // Once we actually searched, the old sentence is allowed: the node is not here.
  const root = sub([node(1, { type: "KSampler" })]);
  const msg = describeMissingNode("120:104", root, true, root);
  assert.match(msg, /not in any other scope either/);
  assert.match(msg, /may be from a different workflow/);
});

// ── WIRING ────────────────────────────────────────────────────────────────
test("WIRING: resolveNode builds its error through describeMissingNode", async () => {
  // resolveNode is module-private and shared by 20+ handlers, so the wiring is pinned
  // at source. Without it every one of them reverts to the bare message.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /import \{ describeMissingNode(?:, describeRailNodeTarget)? \} from "\.\/lib\/node-scope-locator\.js";/);
  const fn = src.slice(src.indexOf("function resolveNode(graph, nodeId) {"));
  const body = fn.slice(0, fn.indexOf("function normalizeLegacyNodeId"));
  assert.ok(body.includes("describeMissingNode(nodeId, rootGraph, viewingRoot, graph)"),
    "the failure path must go through the locator with the live graph so current ids can be named");
  // The lookup itself must be unchanged — this is diagnostics only, never a wider search.
  assert.ok(body.includes("graph.getNodeById(canonicalNodeId(nodeId))"),
    "resolution must still be scoped to the current graph");
  // And the diagnostic must not be able to break the call.
  assert.ok(body.includes("} catch {"), "reading the root must be guarded");
  // graph_save_subgraph used to throw the bare prefix and skip the locator, so a
  // post-edit miss there named no current ids. Pin the one remaining production
  // site onto resolveNode.
  assert.ok(
    /target = resolveNode\(graph, node_id\)/.test(src),
    "graph_save_subgraph must resolve through the same miss path",
  );
  assert.ok(
    !/throw new Error\(`No node with id \$\{node_id\} in the current graph`\)/.test(src),
    "no production mutation may still throw the bare missing-id message",
  );
});
