/**
 * Unit tests for web/js/lib/subgraph-scope.js — run with `node --test`.
 *
 * These drive the SAME pure helpers the panel's graph_* tools call, modelling the
 * subgraph scope/cleanup bug cluster:
 *   - #308: exit_subgraph reported "already at root" right after a query showed a
 *           live subgraph scope (read + navigation disagreed).
 *   - #302: the boundary RAIL ids (-10/-20) reported by query_graph were rejected
 *           by move_node.
 *   - #234: removing the last interior consumer left the boundary slot orphaned.
 *   - #220: after a reconnect the READ scope and the EDIT scope diverged (stale
 *           canvas subgraph the rebuilt root no longer owns).
 *
 * FAIL-before / PASS-after: with the OLD shallow describeActiveGraph +
 * app.canvas.graph read, a stale subgraph reference reports "subgraph" for reads
 * while writes target a ghost — the lockstep test below encodes that divergence and
 * only passes with resolveScope's reconciliation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  SUBGRAPH_INPUT_RAIL_ID,
  SUBGRAPH_OUTPUT_RAIL_ID,
  railKindFor,
  resolveRailNode,
  findSubgraphOwner,
  isSubgraphInRoot,
  resolveScope,
  describeScope,
  computeOrphanedBoundaries,
} from "../../web/js/lib/subgraph-scope.js";

// ---- Fixtures --------------------------------------------------------------

// Minimal rail nodes as LiteGraph exposes them: inputNode.id === -10,
// outputNode.id === -20. query_graph reports these ids as rail_node_id.
function makeSubgraph({ name = "sub", inputs = [], outputs = [], nodes = [], links = [] } = {}) {
  const inputNode = { id: SUBGRAPH_INPUT_RAIL_ID, pos: [100, 100] };
  const outputNode = { id: SUBGRAPH_OUTPUT_RAIL_ID, pos: [900, 100] };
  const linkMap = new Map(links.map((l) => [Number(l.id), l]));
  const sub = {
    name,
    inputs,
    outputs,
    inputNode,
    outputNode,
    _nodes: nodes,
    getLink: (id) => linkMap.get(Number(id)) ?? null,
    removeInput(slot) {
      const i = this.inputs.indexOf(slot);
      if (i >= 0) this.inputs.splice(i, 1);
    },
    removeOutput(slot) {
      const i = this.outputs.indexOf(slot);
      if (i >= 0) this.outputs.splice(i, 1);
    },
  };
  return sub;
}

// An `app` whose canvas points at `canvasGraph`, with a root graph whose nodes may
// (or may NOT) own the open subgraph — the latter models the post-reconnect stale ref.
function makeApp({ rootNodes = [], canvasGraph } = {}) {
  const root = { _nodes: rootNodes };
  let current = canvasGraph ?? root;
  return {
    graph: root,
    canvas: {
      graph: current,
      setGraph(g) {
        current = g;
        this.graph = g;
      },
      setDirty() {},
    },
  };
}

// ---- #302: move_node must accept the rail ids query_graph returns ----------

test("resolveRailNode: -10 / -20 (the ids query_graph reports) resolve to the rails", () => {
  const sub = makeSubgraph();
  const inRail = resolveRailNode(sub, SUBGRAPH_INPUT_RAIL_ID);
  assert.ok(inRail, "input rail id -10 must resolve");
  assert.equal(inRail.rail, "input");
  assert.equal(inRail.node, sub.inputNode);

  const outRail = resolveRailNode(sub, SUBGRAPH_OUTPUT_RAIL_ID);
  assert.ok(outRail, "output rail id -20 must resolve");
  assert.equal(outRail.rail, "output");
  assert.equal(outRail.node, sub.outputNode);
});

test("resolveRailNode: aliases and the frontend-assigned rail node id also resolve", () => {
  const sub = makeSubgraph();
  assert.equal(resolveRailNode(sub, "input").rail, "input");
  assert.equal(resolveRailNode(sub, "output_rail").rail, "output");
  // A rail node carrying a non-canonical positive id still matches by its own id.
  sub.inputNode.id = 42;
  assert.equal(resolveRailNode(sub, 42).rail, "input");
  // -10 STILL resolves to input even when the node id was reassigned (reserved id).
  assert.equal(resolveRailNode(sub, SUBGRAPH_INPUT_RAIL_ID).rail, "input");
});

test("resolveRailNode: a normal node id is NOT a rail (move_node falls through to resolveNode)", () => {
  const sub = makeSubgraph();
  assert.equal(resolveRailNode(sub, 5), null);
  // The ROOT graph has no rails, so even -10 resolves to nothing there.
  const root = { _nodes: [] };
  assert.equal(resolveRailNode(root, SUBGRAPH_INPUT_RAIL_ID), null);
});

test("#302 collision: a REAL node whose id is -10/-20 WINS over the reserved rail id (rail defers)", () => {
  const sub = makeSubgraph();
  const realNode = { id: SUBGRAPH_INPUT_RAIL_ID, type: "Note" };
  sub.getNodeById = (n) => (Number(n) === SUBGRAPH_INPUT_RAIL_ID ? realNode : null);
  // -10 now names a real interior node, so resolveRailNode must NOT claim it as a rail
  // (else move_node would move the input rail instead of that node).
  assert.equal(
    resolveRailNode(sub, SUBGRAPH_INPUT_RAIL_ID),
    null,
    "a real node with id -10 must win over the input rail",
  );
  // -20 has no colliding node ⇒ still resolves to the output rail.
  assert.equal(resolveRailNode(sub, SUBGRAPH_OUTPUT_RAIL_ID).rail, "output");
  // The rail's OWN frontend id stays rail-first even when getNodeById is present.
  sub.inputNode.id = 7;
  assert.equal(resolveRailNode(sub, 7).rail, "input");
});

test("railKindFor: reports intent even when the graph has no rails (root-graph error path)", () => {
  assert.equal(railKindFor(SUBGRAPH_INPUT_RAIL_ID), "input");
  assert.equal(railKindFor(SUBGRAPH_OUTPUT_RAIL_ID), "output");
  assert.equal(railKindFor("input"), "input");
  assert.equal(railKindFor(3), null);
});

// Model the production move path decision: rail id ⇒ move the rail node, not resolveNode.
test("#302 move_node path: a -10 rail id from query_graph is MOVABLE", () => {
  const sub = makeSubgraph();
  const rail = resolveRailNode(sub, SUBGRAPH_INPUT_RAIL_ID);
  assert.ok(rail);
  rail.node.pos = [160, 2500];
  assert.deepEqual(sub.inputNode.pos, [160, 2500]);
});

// ---- #234: removing an interior node prunes ITS orphaned boundary slot -----

test("#234 computeOrphanedBoundaries: slot whose only consumer was removed ⇒ pruned", () => {
  // Boundary input "text" fed ONLY interior node 87 (the removed CLIPTextEncode).
  const inputs = [
    { name: "text", index: 0, targetNodeIds: [87] },
    { name: "seed", index: 1, targetNodeIds: [88] }, // still feeds a surviving node
  ];
  const out = computeOrphanedBoundaries({ inputs, removedNodeIds: [87] });
  assert.deepEqual(out.inputs.map((s) => s.name), ["text"]);
  assert.equal(out.outputs.length, 0);
});

test("#234: a boundary still feeding a SURVIVING node is KEPT (never yank a live slot)", () => {
  const inputs = [{ name: "text", index: 0, targetNodeIds: [87, 99] }]; // 99 survives
  const out = computeOrphanedBoundaries({ inputs, removedNodeIds: [87] });
  assert.equal(out.inputs.length, 0, "slot with a surviving consumer must be kept");
});

test("#234: a freshly-added empty boundary (no interior link) is LEFT ALONE", () => {
  const inputs = [{ name: "text", index: 0, targetNodeIds: [] }];
  const out = computeOrphanedBoundaries({ inputs, removedNodeIds: [87] });
  assert.equal(out.inputs.length, 0);
});

test("#234: output boundary orphaned by removing its only producer ⇒ pruned", () => {
  const outputs = [{ name: "conditioning", index: 0, sourceNodeIds: [87] }];
  const out = computeOrphanedBoundaries({ outputs, removedNodeIds: [87] });
  assert.deepEqual(out.outputs.map((s) => s.name), ["conditioning"]);
});

// End-to-end prune against a live-ish subgraph object, exactly like the handler does.
test("#234 e2e: removing the interior owner prunes the orphaned `text` slot off the rail", () => {
  const textSlot = { name: "text", linkIds: [1] };
  const seedSlot = { name: "seed", linkIds: [2] };
  const sub = makeSubgraph({
    inputs: [textSlot, seedSlot],
    links: [
      { id: 1, origin_id: SUBGRAPH_INPUT_RAIL_ID, origin_slot: 0, target_id: 87, target_slot: 0 },
      { id: 2, origin_id: SUBGRAPH_INPUT_RAIL_ID, origin_slot: 1, target_id: 88, target_slot: 0 },
    ],
  });
  // Model = boundary→interior endpoints (what subgraphBoundaryModel builds).
  const model = {
    inputs: [
      { name: "text", index: 0, slot: textSlot, targetNodeIds: [87] },
      { name: "seed", index: 1, slot: seedSlot, targetNodeIds: [88] },
    ],
    outputs: [],
  };
  const orphans = computeOrphanedBoundaries({ ...model, removedNodeIds: [87] });
  for (const s of orphans.inputs) sub.removeInput(s.slot);
  // The orphaned `text` slot is gone; `seed` (live) remains — so re-exposing the
  // replacement node's input as `text` reuses the name instead of minting `text_1`.
  assert.deepEqual(sub.inputs.map((s) => s.name), ["seed"]);
});

// ---- #220 / #308: ONE authoritative scope for reads AND writes -------------

test("findSubgraphOwner: locates the owning SubgraphNode (incl. nested)", () => {
  const deep = makeSubgraph({ name: "inner" });
  const midOwner = { id: 5, subgraph: makeSubgraph({ name: "mid", nodes: [{ id: 9, subgraph: deep }] }) };
  const root = { _nodes: [{ id: 1 }, midOwner] };
  // deep is owned by node 9, which lives inside node 5's subgraph — nesting-aware.
  const owner = findSubgraphOwner(root, deep);
  assert.ok(owner);
  assert.equal(owner.id, 9);
  // An unrelated graph has no owner.
  assert.equal(findSubgraphOwner(root, makeSubgraph({ name: "orphan" })), null);
});

test("resolveScope: valid open subgraph ⇒ scope 'subgraph', not stale", () => {
  const sub = makeSubgraph({ name: "s", nodes: [{ id: 87 }] });
  const owner = { id: 130, subgraph: sub };
  const app = makeApp({ rootNodes: [owner], canvasGraph: sub });
  const scope = resolveScope(app);
  assert.equal(scope.scope, "subgraph");
  assert.equal(scope.stale, false);
  assert.equal(scope.owner.id, 130);
  assert.equal(scope.graph, sub);
  // title falls back to the subgraph name when the owner node has no title.
  assert.deepEqual(describeScope(scope), { scope: "subgraph", owner_node_id: 130, title: "s" });
});

test("resolveScope: at root ⇒ scope 'root'", () => {
  const app = makeApp({ rootNodes: [{ id: 1 }] });
  const scope = resolveScope(app);
  assert.equal(scope.scope, "root");
  assert.equal(scope.stale, false);
  assert.equal(scope.graph, app.graph);
  assert.deepEqual(describeScope(scope), { scope: "root" });
});

// THE #220 lockstep test: after a reconnect the root graph is REBUILT (new owner
// instance whose .subgraph is a NEW object), but the canvas still references the OLD
// subgraph. The old canvas subgraph is unreachable from the live root ⇒ STALE.
test("#220/#308: stale canvas subgraph (rebuilt root) ⇒ reconcile to root, read+edit in lockstep", () => {
  const staleSub = makeSubgraph({ name: "old", nodes: [{ id: 87 }, { id: 88 }] });
  // Rebuilt root: a fresh owner node whose subgraph is a DIFFERENT object.
  const freshSub = makeSubgraph({ name: "new", nodes: [{ id: 87 }, { id: 88 }] });
  const freshOwner = { id: 128, subgraph: freshSub };
  const app = makeApp({ rootNodes: [freshOwner], canvasGraph: staleSub });

  const scope = resolveScope(app);
  // The read scope resolves to ROOT (not a phantom subgraph) because staleSub is
  // unreachable from the rebuilt root — so it AGREES with where writes would land.
  assert.equal(scope.stale, true, "unreachable canvas subgraph must be flagged stale");
  assert.equal(scope.scope, "root");
  assert.equal(scope.graph, app.graph, "reads reconcile to the live root");
  assert.equal(scope.rootGraph, app.graph);
  // describeScope reports root — NOT 'subgraph, owner 128' — so graph_outline and
  // set_widget can no longer diverge (outline said subgraph, set_widget said 'no
  // node' in the bug).
  assert.deepEqual(describeScope(scope), { scope: "root" });

  // Caller rebinds the canvas to root (the getGraphCtx side effect) — physical view
  // now matches the reconciled scope, keeping read + edit in lockstep.
  if (scope.stale) app.canvas.setGraph(scope.rootGraph);
  assert.equal(app.canvas.graph, app.graph);
  // Re-resolving is now cleanly at root (no residual subgraph claim).
  assert.equal(resolveScope(app).scope, "root");
});

// #308 specifically: query and exit must AGREE. A valid subgraph → both see it; a
// stale one → both see root (so exit's "already at root" is truthful, not a
// contradiction of a preceding query that claimed subgraph).
// Guard against over-eager stale detection: a subgraph registered in the root's
// uuid→Subgraph registry (a definition with NO current owner-node instance) must NOT
// be misclassified as stale and force-exited to root.
test("resolveScope: subgraph reachable via rootGraph.subgraphs registry (no owner node) ⇒ NOT stale", () => {
  const sub = makeSubgraph({ name: "reg" });
  sub.id = "uuid-123";
  const app = makeApp({ rootNodes: [], canvasGraph: sub });
  // Root exposes the authoritative registry (a uuid→Subgraph Map), same shape
  // findSubgraphByUuid prefers — but there is no SubgraphNode instance for it.
  app.graph.subgraphs = new Map([["uuid-123", sub]]);
  assert.equal(isSubgraphInRoot(app.graph, sub), true);
  const scope = resolveScope(app);
  assert.equal(scope.stale, false, "a registered subgraph must not be flagged stale");
  assert.equal(scope.scope, "subgraph");
  assert.equal(scope.graph, sub);
  // owner node is null, but the title still resolves from the subgraph name.
  assert.deepEqual(describeScope(scope), { scope: "subgraph", owner_node_id: null, title: "reg" });
});

test("isSubgraphInRoot: a subgraph the registry does NOT hold ⇒ false (still stale-eligible)", () => {
  const sub = makeSubgraph({ name: "ghost" });
  sub.id = "uuid-x";
  const root = { _nodes: [], subgraphs: new Map([["uuid-y", makeSubgraph({ name: "other" })]]) };
  assert.equal(isSubgraphInRoot(root, sub), false);
});

test("#308: query scope and exit scope derive from the SAME resolver (cannot disagree)", () => {
  // Valid subgraph: query sees subgraph, exit would proceed (graph !== root).
  const sub = makeSubgraph({ name: "s" });
  const app = makeApp({ rootNodes: [{ id: 130, subgraph: sub }], canvasGraph: sub });
  const q = resolveScope(app);
  assert.equal(q.scope, "subgraph");
  assert.notEqual(q.graph, q.rootGraph, "exit_subgraph would proceed, not report 'already at root'");

  // Stale subgraph: query reconciles to root, so a following exit reporting root is
  // consistent — no 'subgraph then already-at-root' contradiction.
  const app2 = makeApp({ rootNodes: [{ id: 130, subgraph: makeSubgraph({ name: "fresh" }) }], canvasGraph: makeSubgraph({ name: "stale" }) });
  const q2 = resolveScope(app2);
  assert.equal(q2.scope, "root");
  assert.equal(q2.graph, q2.rootGraph, "exit truthfully reports root; query already said root too");
});
