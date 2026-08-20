import { test } from "node:test";
import assert from "node:assert/strict";
import {
  locateNodeAcrossScopes,
  countSubgraphs,
  describeMissingNode,
  isUnsearchable,
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
    // These are searchABLE — there is simply nothing in them. A completed search
    // that found nothing is `null`, and stays `null`.
    assert.equal(locateNodeAcrossScopes(bad, 1), null);
  }
  // …whereas an id the walk cannot key on was never searched at all (#1501).
  assert.deepEqual(locateNodeAcrossScopes(sub([node(1)]), "not-a-number"), {
    unsearchable: "id-shape",
  });
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

// ── #1501 "could not look" is not "it is not there" ───────────────────────
//
// The same shape as #1495 twice more: a diagnostic that cannot find a node reported
// "it does not exist" when what happened was "I could not look". `null` was doing
// three jobs — searched-and-absent, the walk threw, and the id was not a shape the
// walk could key on — and the caller could only spell the first of them.

test("#1501 a walk that THREW is not reported as a completed search", () => {
  // The issue's own scenario: the walk touches arbitrary third-party node objects,
  // so `n.subgraph` can throw. Before, that came back as `null` — identical to a
  // finished search that found nothing.
  const hostile = { id: 9, get subgraph() { throw new Error("third-party getter"); } };
  const root = sub([node(1), hostile]);
  const result = locateNodeAcrossScopes(root, 999);
  assert.ok(isUnsearchable(result), "a thrown walk must not masquerade as a miss");
  assert.equal(result.unsearchable, "walk-threw");
  assert.notEqual(result, null);
});

test("#1501 a thrown walk still never throws out of the diagnostic", () => {
  const root = { get _nodes() { throw new Error("boom"); } };
  assert.doesNotThrow(() => locateNodeAcrossScopes(root, 1));
  assert.doesNotThrow(() => describeMissingNode(1, root, true, root));
});

test("#1501 a thrown walk says UNKNOWN instead of claiming the node is gone", () => {
  const hostile = { id: 9, type: "Hostile", get subgraph() { throw new Error("nope"); } };
  const root = sub([node(1, { type: "CheckpointLoaderSimple" }), hostile]);
  const msg = describeMissingNode(999, root, true, root);
  assert.match(msg, /^No node with id 999/);
  // The three lies, gone.
  assert.ok(!/may be from a different workflow/.test(msg), "it never searched for that");
  assert.ok(!/the node was removed/.test(msg), "absence was never established");
  assert.ok(!/not in any other scope either/.test(msg), "other scopes went unsearched");
  // …replaced by what actually happened.
  assert.match(msg, /could NOT be completed/);
  assert.match(msg, /UNKNOWN/);
  // and it still hands back something the caller can act on
  assert.match(msg, /1 \(CheckpointLoaderSimple\)/);
});

test("#1501 an id shape the walk cannot key on is not searched, and says so", () => {
  const root = sub([node(1, { type: "KSampler" })]);
  const msg = describeMissingNode("not-a-number", root, true, root);
  assert.match(msg, /^No node with id not-a-number/);
  assert.ok(!/may be from a different workflow/.test(msg));
  assert.ok(!/not in any other scope either/.test(msg));
  assert.match(msg, /no wider search was possible/);
  assert.match(msg, /subgraph-qualified/);
  assert.match(msg, /UNKNOWN/);
});

test("#1501 a genuine miss is still a genuine miss — the fix does not blanket everything", () => {
  // Load-bearing: if "unknown" swallowed the real absence case too, #1298's retarget
  // path would be lost and the message would stop being actionable.
  const root = sub([node(1), node(9, { subgraph: sub([node(2)]) })]);
  const msg = describeMissingNode(999, root, true);
  assert.equal(isUnsearchable(locateNodeAcrossScopes(root, 999)), false);
  assert.equal(locateNodeAcrossScopes(root, 999), null);
  assert.match(msg, /not in any other scope either/);
  assert.match(msg, /may be from a different workflow/);
  assert.ok(!/UNKNOWN/.test(msg));
});

// ── #1501 a QUALIFIED id is a real id (artokun/comfyui-mcp#1425) ──────────
//
// `Number("120:104")` is NaN, so the locator returned before searching anything and
// the caller announced a workflow-identity problem for an id shape the read tools
// deliberately hand out after a subgraph is unpacked.

test("#1501 a qualified id on the root graph is FOUND, not blamed on another workflow", () => {
  const root = sub([node("120:104", { type: "KSampler" }), node("120:113", { type: "VAEDecode" })]);
  const hit = locateNodeAcrossScopes(root, "120:104");
  assert.equal(hit.scope, "root");
  assert.deepEqual(hit.hostPath, []);
  const msg = describeMissingNode("120:104", root, true, root);
  assert.ok(!/may be from a different workflow/.test(msg), "it came from this graph");
  assert.ok(!/not in any other scope either/.test(msg));
  assert.match(msg, /IS on the root graph/);
});

test("#1501 a qualified id inside a subgraph gets the route, like any other id", () => {
  const inner = sub([node("263:78", { type: "CLIPTextEncode" })]);
  const root = sub([node(1), node(9, { title: "Refiner", subgraph: inner })]);
  const hit = locateNodeAcrossScopes(root, "263:78");
  assert.equal(hit.scope, "subgraph");
  assert.deepEqual(hit.hostPath, [{ id: 9, title: "Refiner" }]);
  const msg = describeMissingNode("263:78", root, true, root);
  assert.match(msg, /lives INSIDE a subgraph/);
  assert.match(msg, /panel_enter_subgraph\(9\)/);
});

test("#1501 a qualified id that really is absent still reports a completed search", () => {
  const root = sub([node("120:104")]);
  assert.equal(locateNodeAcrossScopes(root, "999:1"), null);
  assert.match(describeMissingNode("999:1", root, true), /not in any other scope either/);
});

test("#1501 a qualified id is never PARSED into the different node its prefix names", () => {
  // `parseInt("120:104")` is 120 — a real, different node. Matching it would turn a
  // loud miss into a confident pointer at the wrong node.
  const root = sub([node(120, { type: "Host" }), node(104, { type: "Other" })]);
  assert.equal(locateNodeAcrossScopes(root, "120:104"), null);
  // and the reverse: a plain id must not be answered by a qualified node
  assert.equal(locateNodeAcrossScopes(sub([node("120:104")]), 120), null);
});

test("#1501 plain and numeric-string ids are matched exactly as before", () => {
  // Live ComfyUI ids are strings, so the numeric comparison is the load-bearing one.
  const root = sub([node("5548", { type: "SaveImage" })]);
  assert.equal(locateNodeAcrossScopes(root, 5548).scope, "root");
  assert.equal(locateNodeAcrossScopes(root, "5548").scope, "root");
  assert.equal(locateNodeAcrossScopes(sub([node(7)]), 7).scope, "root");
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
