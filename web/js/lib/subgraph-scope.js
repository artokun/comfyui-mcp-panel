// Authoritative subgraph scope tracking + boundary-rail helpers, extracted so the
// SAME logic the panel's graph_* tools run is unit-testable headlessly (the live
// LiteGraph canvas cannot be driven from `node --test`).
//
// Fixes a cluster of subgraph scope/cleanup defects:
//  - #308: panel_exit_subgraph reported "already at root" immediately after a
//    query showed a live subgraph scope — the read tool and the navigation tool
//    disagreed about where the user was.
//  - #220: after a panel reconnect the READ scope (graph_outline) and the EDIT
//    scope (set_widget / move_node) diverged — the outline listed inner node ids
//    while mutations answered "No node with id ...". The canvas still pointed at a
//    subgraph object that the REBUILT root graph no longer owns (a STALE ref).
//  - #302: the input/output boundary RAIL ids (-10/-20) that query_graph reports
//    were rejected by move_node.
//  - #234: removing the last interior consumer of an exposed boundary slot left
//    the now-orphaned slot behind on the parent SubgraphNode.
//
// The unifying idea is ONE authoritative scope resolver (`resolveScope`) that BOTH
// reads and writes derive their target graph from, and that treats a canvas graph
// unreachable from the LIVE root as stale — reconciling to root so a read and an
// edit issued back-to-back can never target two different graphs.

export const SUBGRAPH_INPUT_RAIL_ID = -10;
export const SUBGRAPH_OUTPUT_RAIL_ID = -20;

const RAIL_INPUT_ALIASES = new Set(["input", "input_rail", "inputs", "in"]);
const RAIL_OUTPUT_ALIASES = new Set(["output", "output_rail", "outputs", "out"]);

/** Rail INTENT from a reference, independent of whether rails exist on the active
 *  graph: an alias string ("input"/"output"/…) or the reserved rail ids -10/-20.
 *  Returns "input" | "output" | null. Used to give a precise error when a rail
 *  endpoint is used at the ROOT graph (which has no rails). */
export function railKindFor(ref) {
  if (typeof ref === "string") {
    const key = ref.trim().toLowerCase();
    if (RAIL_INPUT_ALIASES.has(key)) return "input";
    if (RAIL_OUTPUT_ALIASES.has(key)) return "output";
  }
  const num = Number(ref);
  if (Number.isFinite(num)) {
    if (num === SUBGRAPH_INPUT_RAIL_ID) return "input";
    if (num === SUBGRAPH_OUTPUT_RAIL_ID) return "output";
  }
  return null;
}

/** Resolve a reference to a subgraph boundary rail NODE on `graph`, by the rail
 *  node's real id (-10 / -20), by the frontend-assigned node id, or by an alias.
 *  Returns { rail: "input"|"output", node } or null when it isn't a rail reference
 *  or the graph has no such rail (e.g. the root graph). This is exactly the id form
 *  panel_query_graph reports as `rails.input.rail_node_id`, so move_node can accept
 *  it (#302). */
export function resolveRailNode(graph, ref) {
  const inNode = graph?.inputNode ?? graph?._inputNode ?? null;
  const outNode = graph?.outputNode ?? graph?._outputNode ?? null;
  if (typeof ref === "string") {
    const key = ref.trim().toLowerCase();
    if (RAIL_INPUT_ALIASES.has(key)) return inNode ? { rail: "input", node: inNode } : null;
    if (RAIL_OUTPUT_ALIASES.has(key)) return outNode ? { rail: "output", node: outNode } : null;
  }
  const num = Number(ref);
  if (Number.isFinite(num)) {
    // A REAL node always wins a numeric reference: rail nodes are not in
    // graph._nodes_by_id, so getNodeById only ever returns an ordinary node. When one
    // owns this id the ref names that node — even if the id collides with a reserved
    // rail id (-10/-20) or the rail's own id — so defer (return null) and let move_node
    // resolve it as a normal node (#302 numeric collision; ComfyUI permits any integer
    // node id). The `!== inNode/outNode` guard keeps a legit rail move working even if a
    // build DID surface a rail through getNodeById.
    const found =
      typeof graph?.getNodeById === "function" ? graph.getNodeById(num) : null;
    const collidingNode = found && found !== inNode && found !== outNode ? found : null;
    if (!collidingNode) {
      if (inNode && (Number(inNode.id) === num || num === SUBGRAPH_INPUT_RAIL_ID))
        return { rail: "input", node: inNode };
      if (outNode && (Number(outNode.id) === num || num === SUBGRAPH_OUTPUT_RAIL_ID))
        return { rail: "output", node: outNode };
    }
  }
  return null;
}

/** Walk the root graph (through nested subgraphs) to find the SubgraphNode that
 *  owns `subgraph`. Returns { id, node, title } or null when unreachable — the
 *  signal that a canvas graph reference is STALE (its owner was replaced when the
 *  root graph was rebuilt on reconnect). */
export function findSubgraphOwner(rootGraph, subgraph) {
  if (!rootGraph || !subgraph) return null;
  const stack = [...(rootGraph._nodes ?? [])];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (node.subgraph === subgraph) {
      return { id: node.id ?? null, node, title: node.title ?? subgraph?.name ?? "subgraph" };
    }
    const inner = node.subgraph?._nodes;
    if (inner?.length) stack.push(...inner);
  }
  return null;
}

/** Whether `subgraph` is authoritatively part of `rootGraph` via the root's
 *  `subgraphs` registry (a uuid → Subgraph Map on real LiteGraph builds, the same
 *  registry findSubgraphByUuid in asset-staleness.js prefers). A subgraph DEFINITION
 *  can be owned through this registry with no current presentation-owner node, so we
 *  must NOT treat "no owner node found" alone as stale — only a subgraph the root
 *  neither owns via a node NOR registers is genuinely a ghost. Matches by IDENTITY,
 *  not just uuid, so a rebuilt root carrying a NEW subgraph under the same uuid does
 *  not mask the old (stale) instance. */
export function isSubgraphInRoot(rootGraph, subgraph) {
  const reg = rootGraph?.subgraphs;
  if (!reg || !subgraph) return false;
  const id = subgraph.id;
  if (id != null && typeof reg.get === "function" && reg.get(id) === subgraph) return true;
  if (typeof reg.values === "function") {
    for (const v of reg.values()) if (v === subgraph) return true;
  } else if (typeof reg.forEach === "function") {
    let found = false;
    reg.forEach((v) => {
      if (v === subgraph) found = true;
    });
    if (found) return true;
  } else if (typeof reg === "object") {
    for (const v of Object.values(reg)) if (v === subgraph) return true;
  }
  return false;
}

/** THE authoritative viewing-scope resolver. Both graph reads and graph mutations
 *  derive their target graph from this, so they can never diverge (#220 / #308).
 *
 *  Returns { graph, rootGraph, scope, owner, stale }:
 *   - root             → { graph: root,     scope: "root" }
 *   - a valid subgraph → { graph: subgraph, scope: "subgraph", owner? } — valid when
 *     the live root reaches it via an owner NODE or its `subgraphs` registry.
 *   - a STALE subgraph (the canvas still points at a subgraph the rebuilt root
 *     neither owns nor registers — e.g. after a reconnect) → reconcile to root:
 *     { graph: root, scope: "root", stale: true }. The caller rebinds the canvas
 *     so the physical view matches, keeping read + edit in lockstep. */
export function resolveScope(app) {
  const rootGraph = app?.graph ?? null;
  const canvasGraph = app?.canvas?.graph ?? null;
  if (!rootGraph) {
    return { graph: canvasGraph ?? null, rootGraph: null, scope: "root", owner: null, stale: false };
  }
  if (!canvasGraph || canvasGraph === rootGraph) {
    return { graph: rootGraph, rootGraph, scope: "root", owner: null, stale: false };
  }
  const owner = findSubgraphOwner(rootGraph, canvasGraph);
  if (owner) {
    return { graph: canvasGraph, rootGraph, scope: "subgraph", owner, stale: false };
  }
  // No presentation-owner node — but the subgraph may still be authoritative via the
  // root's uuid→Subgraph registry (a registered definition without a live instance
  // node). Only when it is NEITHER owned NOR registered is it a genuine post-reconnect
  // ghost; then fall back to root so reads AND writes agree rather than target a ghost.
  if (isSubgraphInRoot(rootGraph, canvasGraph)) {
    return { graph: canvasGraph, rootGraph, scope: "subgraph", owner: null, stale: false };
  }
  return { graph: rootGraph, rootGraph, scope: "root", owner: null, stale: true };
}

/** Compact JSON scope descriptor for tool responses (the `viewing` field). Derived
 *  from resolveScope so `viewing` and the graph the tool actually acted on always
 *  match. */
export function describeScope(scope) {
  if (!scope || scope.scope !== "subgraph") return { scope: "root" };
  return {
    scope: "subgraph",
    owner_node_id: scope.owner?.id ?? null,
    title: scope.owner?.title ?? scope.graph?.name ?? "subgraph",
  };
}

/** Compute which subgraph boundary slots become ORPHANED when the given interior
 *  node(s) are removed (#234): a boundary whose every interior endpoint is among
 *  the removed nodes (and which had at least one) no longer has a consumer/producer
 *  and should be pruned. Freshly-added empty boundaries (no interior endpoint) are
 *  LEFT ALONE — they were not orphaned by this removal, and a boundary that still
 *  feeds a surviving node is KEPT (never yank a slot with a live consumer).
 *
 *  `inputs`  : [{ name, index, slot?, targetNodeIds: number[] }] (input rail → interior)
 *  `outputs` : [{ name, index, slot?, sourceNodeIds: number[] }] (interior → output rail)
 *  Returns { inputs, outputs } — the SAME item objects to remove (so callers keep
 *  the `slot` handle). */
export function computeOrphanedBoundaries({ inputs = [], outputs = [], removedNodeIds = [] } = {}) {
  const removed = new Set((removedNodeIds ?? []).map((id) => Number(id)));
  const allRemoved = (ids) => {
    const nums = (ids ?? []).map((id) => Number(id)).filter((n) => Number.isFinite(n));
    return nums.length > 0 && nums.every((id) => removed.has(id));
  };
  return {
    inputs: (inputs ?? []).filter((s) => allRemoved(s?.targetNodeIds)),
    outputs: (outputs ?? []).filter((s) => allRemoved(s?.sourceNodeIds)),
  };
}
