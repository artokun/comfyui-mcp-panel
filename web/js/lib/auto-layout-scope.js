// #1328 — auto-layout apply must target the graph the user was viewing, not
// whatever canvas.graph happens to point at after the mutation dispatch /
// preflight. dry_run already reads the live subgraph; apply used to re-resolve
// from a canvas that had escaped to root and then rearrange the root.
//
// The remembered identity is captured when the canvas is OBSERVED inside a
// subgraph (enter / a subgraph-scoped dry_run / getGraphCtx) and is only
// discarded on an explicit return to root (exit, or a root-scoped dry_run).
// An apply whose live canvas is root then re-resolves that identity from the
// live root and writes THERE — or refuses, if the owner / interior node count
// no longer match. It never silently falls through to the root graph.

import {
  SUBGRAPH_INPUT_RAIL_ID,
  SUBGRAPH_OUTPUT_RAIL_ID,
  findSubgraphOwner,
  findNodeInScopes,
  isSubgraphInRoot,
} from "./subgraph-scope.js";

let remembered = null;

/** Interior nodes only — rails are not laid out and must not inflate the count. */
export function interiorNodeCount(graph) {
  return (graph?._nodes ?? []).filter(
    (n) => n && n.id !== SUBGRAPH_INPUT_RAIL_ID && n.id !== SUBGRAPH_OUTPUT_RAIL_ID,
  ).length;
}

export function layoutScopeFingerprint(graph, rootGraph) {
  const node_count = interiorNodeCount(graph);
  if (!rootGraph || !graph || graph === rootGraph) {
    return { scope: "root", owner_node_id: null, node_count, title: null, graph };
  }
  const owner = findSubgraphOwner(rootGraph, graph);
  if (owner) {
    return {
      scope: "subgraph",
      owner_node_id: owner.id ?? null,
      node_count,
      title: owner.title ?? graph?.name ?? "subgraph",
      graph,
    };
  }
  if (isSubgraphInRoot(rootGraph, graph)) {
    return {
      scope: "subgraph",
      owner_node_id: null,
      node_count,
      title: graph?.name ?? "subgraph",
      graph,
    };
  }
  return { scope: "root", owner_node_id: null, node_count, title: null, graph };
}

export function viewingOf(fp) {
  if (!fp || fp.scope !== "subgraph") return { scope: "root" };
  return {
    scope: "subgraph",
    owner_node_id: fp.owner_node_id ?? null,
    title: fp.title ?? "subgraph",
  };
}

export function rememberAutoLayoutScope(fp) {
  if (fp && fp.scope === "subgraph") remembered = fp;
  return remembered;
}

export function clearAutoLayoutScope() {
  remembered = null;
}

export function peekAutoLayoutScope() {
  return remembered;
}

/** Find the subgraph object a captured fingerprint names on the LIVE root. */
export function resolveSubgraphForLayout(rootGraph, captured) {
  if (!captured || captured.scope !== "subgraph" || !rootGraph) return null;
  if (captured.graph && findSubgraphOwner(rootGraph, captured.graph)) return captured.graph;
  if (captured.graph && isSubgraphInRoot(rootGraph, captured.graph)) return captured.graph;
  if (captured.owner_node_id == null) return null;
  const hit = findNodeInScopes(rootGraph, captured.owner_node_id, rootGraph);
  return hit?.node?.subgraph ?? null;
}

function ownerMismatch(captured, live) {
  return (
    captured?.owner_node_id != null &&
    live?.owner_node_id != null &&
    captured.owner_node_id !== live.owner_node_id
  );
}

function mismatchError(captured, live) {
  const intended =
    captured?.scope === "subgraph"
      ? `subgraph owner node ${captured.owner_node_id ?? "unknown"} (${captured.node_count} inner node(s))`
      : `the root graph (${captured?.node_count ?? "unknown"} node(s))`;
  const found =
    live?.scope === "subgraph"
      ? `subgraph owner node ${live.owner_node_id ?? "unknown"} (${live.node_count} inner node(s))`
      : `the root graph (${live?.node_count ?? "unknown"} node(s))`;
  return (
    `panel_auto_layout apply refused: the intended layout target was ${intended}, but the ` +
    `graph selected at apply time is ${found}. Nothing was moved. Re-enter the subgraph ` +
    `(panel_enter_subgraph) if that is still where you mean to work, then retry.`
  );
}

function escapedUnreachableError(captured) {
  return (
    `panel_auto_layout apply refused: the canvas is at the root graph, but the last viewing ` +
    `scope was subgraph owner node ${captured.owner_node_id ?? "unknown"} ` +
    `(${captured.node_count} inner node(s)), which is no longer reachable from the live root. ` +
    `Nothing was moved. Re-enter the subgraph (panel_enter_subgraph) and retry.`
  );
}

/**
 * Pick the graph auto-layout may read or write.
 *
 * dry_run (`apply: false`) uses the live canvas and, when that canvas is a
 * subgraph, remembers its identity.
 *
 * apply uses the live subgraph when the canvas is still inside one (failing
 * closed on an owner change). If the canvas has escaped to root, it re-resolves
 * the remembered subgraph from the live root and returns that graph — or
 * refuses when the owner / interior node count no longer match. It never
 * returns the root graph while a subgraph identity is still outstanding.
 */
export function resolveAutoLayoutTarget({ liveGraph, liveRoot, captured, apply } = {}) {
  const live = layoutScopeFingerprint(liveGraph, liveRoot);
  if (!apply) {
    return {
      graph: liveGraph,
      viewing: viewingOf(live),
      captured: live.scope === "subgraph" ? live : null,
      retargeted: false,
    };
  }
  if (live.scope === "subgraph") {
    if (captured?.scope === "subgraph" && ownerMismatch(captured, live)) {
      return { error: mismatchError(captured, live) };
    }
    return { graph: liveGraph, viewing: viewingOf(live), captured: live, retargeted: false };
  }
  if (captured?.scope === "subgraph") {
    const sub = resolveSubgraphForLayout(liveRoot, captured);
    if (!sub) return { error: escapedUnreachableError(captured) };
    const now = layoutScopeFingerprint(sub, liveRoot);
    if (now.node_count !== captured.node_count || ownerMismatch(captured, now)) {
      return { error: mismatchError(captured, now) };
    }
    return { graph: sub, viewing: viewingOf(now), captured: now, retargeted: true };
  }
  return { graph: liveGraph, viewing: viewingOf(live), captured: null, retargeted: false };
}

/**
 * The production bind: remember a live subgraph, resolve the apply target,
 * and walk the canvas back onto a retargeted subgraph so follow-up tools
 * (move_rail) stay in the same scope.
 */
export function bindAutoLayoutGraph(ctx, { apply } = {}) {
  const liveGraph = ctx?.graph ?? null;
  const liveRoot = ctx?.rootGraph ?? liveGraph;
  const liveFp = layoutScopeFingerprint(liveGraph, liveRoot);
  if (liveFp.scope === "subgraph") rememberAutoLayoutScope(liveFp);
  const target = resolveAutoLayoutTarget({
    liveGraph,
    liveRoot,
    captured: peekAutoLayoutScope(),
    apply: !!apply,
  });
  if (target.error) throw new Error(target.error);
  if (target.retargeted && typeof ctx?.canvas?.setGraph === "function") {
    try {
      ctx.canvas.setGraph(target.graph);
      ctx.canvas.setDirty?.(true, true);
    } catch {
      // The write still goes to the subgraph object; only the view failed to follow.
    }
  }
  if (target.captured?.scope === "subgraph") rememberAutoLayoutScope(target.captured);
  else if (!apply && liveFp.scope === "root") clearAutoLayoutScope();
  return target;
}
