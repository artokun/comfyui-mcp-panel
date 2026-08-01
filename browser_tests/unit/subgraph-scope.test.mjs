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
  subgraphInstancePath,
  buildNodeExecutionId,
  findNodeInScopes,
  resolveRunToNodeTarget,
  unsafeBypassMappings,
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

// ---- #411: run-to-node targeting an output nested in a subgraph ------------

test("#411 subgraphInstancePath: outermost-first instance-id path, [] at root, null when unreachable", () => {
  const deep = makeSubgraph({ name: "inner" });
  const midSub = makeSubgraph({ name: "mid", nodes: [{ id: 15, subgraph: deep }] });
  const root = { _nodes: [{ id: 10, subgraph: midSub }] };
  assert.deepEqual(subgraphInstancePath(root, root), [], "root graph → empty path");
  assert.deepEqual(subgraphInstancePath(root, midSub), [10], "first-level → [outerInstanceId]");
  assert.deepEqual(subgraphInstancePath(root, deep), [10, 15], "nested → outermost-first chain");
  // A subgraph the root can't reach (stale) → null.
  assert.equal(subgraphInstancePath(root, makeSubgraph({ name: "ghost" })), null);
});

test("#411 buildNodeExecutionId: colon path outermost→leaf; String(id) at root; null when stale", () => {
  const deep = makeSubgraph({ name: "inner", nodes: [{ id: 359 }] });
  const midSub = makeSubgraph({ name: "mid", nodes: [{ id: 15, subgraph: deep }] });
  const root = { _nodes: [{ id: 10, subgraph: midSub }, { id: 7 }] };
  assert.equal(buildNodeExecutionId(root, deep, 359), "10:15:359", "nested leaf → full colon path");
  assert.equal(buildNodeExecutionId(root, root, 7), "7", "root leaf → plain id (no regression)");
  assert.equal(buildNodeExecutionId(root, makeSubgraph({ name: "ghost" }), 1), null);
});

test("#411 findNodeInScopes: resolves the VIEWING scope first, then root, then nested", () => {
  const target = { id: 359, type: "ShowText|pysssss" };
  const deep = makeSubgraph({ name: "inner", nodes: [target] });
  const midSub = makeSubgraph({ name: "mid", nodes: [{ id: 15, subgraph: deep }] });
  const root = { _nodes: [{ id: 10, subgraph: midSub }, { id: 359, type: "RootNote" }] };
  // Same id 359 exists at root AND in the deep subgraph — viewing the deep subgraph
  // must resolve to the INNER node (what the user is looking at), not the root one.
  const hit = findNodeInScopes(root, 359, deep);
  assert.equal(hit.node, target);
  assert.equal(hit.ownerGraph, deep);
  // Without a preferred scope, the root node wins (searched before descending).
  assert.equal(findNodeInScopes(root, 359).ownerGraph, root);
  // A truly nested-only id resolves via the deep walk even from root.
  const deepOnly = { id: 900 };
  deep._nodes.push(deepOnly);
  const hit2 = findNodeInScopes(root, 900);
  assert.equal(hit2.node, deepOnly);
  assert.equal(hit2.ownerGraph, deep);
  // Unknown id → null.
  assert.equal(findNodeInScopes(root, 12345), null);
});

test("#411 e2e: viewing a nested subgraph, an inner output node yields its full colon path", () => {
  const out = { id: 359, type: "ShowText|pysssss" };
  const deep = makeSubgraph({ name: "inner", nodes: [out] });
  const midSub = makeSubgraph({ name: "mid", nodes: [{ id: 15, subgraph: deep }] });
  const root = { _nodes: [{ id: 10, subgraph: midSub }] };
  const hit = findNodeInScopes(root, 359, deep);
  assert.equal(buildNodeExecutionId(root, hit.ownerGraph, hit.node.id), "10:15:359");
});

// An output node as ComfyUI tags it: node.constructor.nodeData.output_node === true.
// resolveRunToNodeTarget gates on this exactly like graph_run does.
function makeOutputNode(id, type) {
  return { id, type, constructor: { nodeData: { output_node: true } } };
}

test("#438/#439 resolveRunToNodeTarget: an output node in the ACTIVE first-level subgraph yields the owner:leaf path (the exact graph_run resolution)", () => {
  // Reporter scenario (dup of #411, verified fixed in 0.11.25): the user ENTERED a
  // first-level subgraph (owner instance id 76) containing an output node — a
  // PreviewImage (#438, id 34) / MaskPreview (#439, id 74). graph_run passes the ACTIVE
  // viewing graph so the inner output resolves IN THAT SCOPE and the "76:34" colon path
  // is used as partial_execution_targets — instead of the OLD root-only rejection
  // ("node 34 is not on the root graph"). Drives the SAME helper graph_run calls,
  // through the real output-eligibility + colon-path build, not just findNodeInScopes.
  const preview = makeOutputNode(34, "PreviewImage");
  const maskPreview = makeOutputNode(74, "MaskPreview");
  const active = makeSubgraph({ name: "LAB 07 — ANIMA INPAINT", nodes: [preview, maskPreview] });
  const root = { _nodes: [{ id: 76, subgraph: active }] };

  const r34 = resolveRunToNodeTarget(root, active, 34);
  assert.equal(r34.ok, true, "an output node in the active subgraph is runnable");
  assert.equal(r34.node, preview);
  assert.equal(r34.execId, "76:34", "#438: first-level active-subgraph output → owner:leaf target");

  const r74 = resolveRunToNodeTarget(root, active, 74);
  assert.equal(r74.execId, "76:74", "#439: MaskPreview inside the active subgraph resolves too");
});

test("#438/#439 NON-VACUOUS: the ACTIVE-scope PREFERENCE is what reaches the inner output — dropping it targets the wrong (root) node", () => {
  // The SAME id 34 exists at BOTH the root AND inside the active subgraph, and both are
  // output nodes. This is the case that only the viewing-scope preference disambiguates:
  //  - viewing the active subgraph → the INNER output, target "76:34" (correct branch).
  //  - NO viewing scope (as if graph_run stopped passing the active graph) → the ROOT
  //    node, target "34" — a DIFFERENT branch. So this test FAILS if the fix is reverted.
  const innerOut = makeOutputNode(34, "PreviewImage");
  const active = makeSubgraph({ name: "LAB", nodes: [innerOut] });
  const rootOut = makeOutputNode(34, "SaveImage");
  const root = { _nodes: [{ id: 76, subgraph: active }, rootOut] };

  const viewing = resolveRunToNodeTarget(root, active, 34);
  assert.equal(viewing.node, innerOut, "viewing the active subgraph resolves the INNER output");
  assert.equal(viewing.execId, "76:34", "the active-scope preference targets the inner branch");

  const noScope = resolveRunToNodeTarget(root, root, 34);
  assert.equal(noScope.node, rootOut, "without the active scope the ROOT node wins");
  assert.equal(noScope.execId, "34", "→ a DIFFERENT (root) target: the preference is load-bearing");
});

test("#438/#439: a NON-output node in the active subgraph is refused with the not_output code (never queued as a bad root)", () => {
  const notOutput = { id: 34, type: "CLIPTextEncode", constructor: { nodeData: { output_node: false } } };
  const active = makeSubgraph({ name: "LAB", nodes: [notOutput] });
  const root = { _nodes: [{ id: 76, subgraph: active }] };
  const res = resolveRunToNodeTarget(root, active, 34);
  assert.equal(res.ok, false);
  assert.equal(res.code, "not_output");
  assert.equal(res.node, notOutput, "carries the node so graph_run can name its type in the error");

  // Unknown id → not_found (graph_run's first guard).
  assert.deepEqual(resolveRunToNodeTarget(root, active, 999), { ok: false, code: "not_found", node: null });
});

// ---- #409: reject unsafe bypass on a multi-input subgraph ------------------

test("#409 unsafeBypassMappings: reorder that forwards a wrong-type input is flagged", () => {
  // The reported shape: inputs [BBOX_DETECTOR, IMAGE, MASK], one IMAGE output. Bypass
  // forwards output[0] from input[0] (BBOX_DETECTOR) — a type mismatch.
  const inputs = [{ name: "bbox_detector", type: "BBOX_DETECTOR" }, { name: "image", type: "IMAGE" }, { name: "mask", type: "MASK" }];
  const outputs = [{ name: "image", type: "IMAGE", connected: true }];
  const bad = unsafeBypassMappings({ inputs, outputs });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].output_type, "IMAGE");
  assert.equal(bad[0].input_type, "BBOX_DETECTOR");
});

test("#409 unsafeBypassMappings: aligned same-type positional mapping is SAFE", () => {
  // input[0]=IMAGE lines up with output[0]=IMAGE → no mismatch.
  const inputs = [{ name: "image", type: "IMAGE" }, { name: "mask", type: "MASK" }];
  const outputs = [{ name: "image", type: "IMAGE", connected: true }];
  assert.deepEqual(unsafeBypassMappings({ inputs, outputs }), []);
});

test("#409 unsafeBypassMappings: an UNCONNECTED output can't mis-wire (ignored)", () => {
  const inputs = [{ name: "bbox_detector", type: "BBOX_DETECTOR" }];
  const outputs = [{ name: "image", type: "IMAGE", connected: false }];
  assert.deepEqual(unsafeBypassMappings({ inputs, outputs }), []);
});

test("#409 unsafeBypassMappings: wildcard (*/'') passes; missing positional input flagged", () => {
  // Wildcard output type is compatible with anything.
  assert.deepEqual(
    unsafeBypassMappings({ inputs: [{ type: "BBOX_DETECTOR" }], outputs: [{ type: "*", connected: true }] }),
    [],
  );
  // Two connected outputs but only one input → the 2nd output has no positional source.
  const bad = unsafeBypassMappings({
    inputs: [{ name: "image", type: "IMAGE" }],
    outputs: [{ name: "image", type: "IMAGE", connected: true }, { name: "extra", type: "MASK", connected: true }],
  });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].output_index, 1);
  assert.equal(bad[0].input_name, null);
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

// #412: exit_subgraph must pop to the IMMEDIATE parent graph, not the root. The
// owner walk now reports the parent graph that DIRECTLY contains the owner node.
test("#412 findSubgraphOwner: parentGraph is the IMMEDIATE parent (root for L1, the mid subgraph for L2)", () => {
  const deep = makeSubgraph({ name: "inner" });
  const midSub = makeSubgraph({ name: "mid", nodes: [{ id: 9, subgraph: deep }] });
  const midOwner = { id: 5, subgraph: midSub };
  const root = { _nodes: [{ id: 1 }, midOwner] };

  // A first-level subgraph's parent IS the root graph.
  const l1 = findSubgraphOwner(root, midSub);
  assert.ok(l1);
  assert.equal(l1.id, 5);
  assert.equal(l1.parentGraph, root, "first-level parent is the root graph");

  // The nested subgraph's parent is the MID subgraph — NOT the root (the #412 bug
  // set the canvas to the root instead of this parent).
  const l2 = findSubgraphOwner(root, deep);
  assert.ok(l2);
  assert.equal(l2.id, 9);
  assert.equal(l2.parentGraph, midSub, "nested parent is the enclosing subgraph, not root");
  assert.notEqual(l2.parentGraph, root, "exit must NOT jump straight to root (#412)");
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
