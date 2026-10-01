// #2267 — recover a panel_create_subgraph whose conversion applied but whose
// reply never reached the caller (HTTP send error / dropped orchestrator
// transport). convertToSubgraph moves the selected nodes INTO the new wrapper,
// so a blind retry of the same node_ids either throws "provide node_ids" or
// wraps whatever leftover siblings still sit on the parent.
//
// An exact live-graph conversion receipt is the source of truth: if EVERY named id is gone from this graph
// and a recorded wrapper is still on this graph, the conversion already
// landed. A retry returns that wrapper. A partial leftover set is refused —
// converting it would wrap a different set. Dependency-light so unit tests can
// drive the same functions the executor calls.

import { isPromotedContainer } from "./graph-read.js";

const RAIL_IDS = new Set([-10, -20]);

/** Unique numeric node ids, dropping rails and non-finite values. */
export function normalizeCreateSubgraphNodeIds(nodeIds) {
  if (!Array.isArray(nodeIds)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of nodeIds) {
    if (raw == null || raw === "") continue;
    const id = Number(raw);
    if (!Number.isFinite(id) || RAIL_IDS.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Provenance is local to a live graph object. Numeric IDs are not globally unique:
// an unrelated subgraph can contain the same IDs as a vanished selection.
const conversions = new WeakMap();
const selectionKey = (ids) => JSON.stringify(normalizeCreateSubgraphNodeIds(ids).sort((a, b) => a - b));

export function rememberConvertedSubgraph(graph, nodeIds, host) {
  let receipts = conversions.get(graph);
  if (!receipts) conversions.set(graph, (receipts = new Map()));
  receipts.set(selectionKey(nodeIds), host);
  // Bound memory for long-running graph sessions; evicted outcomes fail closed.
  if (receipts.size > 128) receipts.delete(receipts.keys().next().value);
}

export function recoverConvertedSubgraph({ graph, nodeIds } = {}) {
  const wanted = normalizeCreateSubgraphNodeIds(nodeIds);
  if (!wanted.length || !graph || wanted.some((id) => graph.getNodeById?.(id))) return null;
  const host = conversions.get(graph)?.get(selectionKey(wanted));
  if (!host || !isPromotedContainer(host) || !graph._nodes?.includes(host)) return null;
  return host;
}

/** Success payload for a conversion that already landed. */
export function recoveredCreateSubgraphResult(host, fromNodes) {
  return {
    subgraph: {
      node_id: host?.id ?? null,
      name: host?.subgraph?.name ?? host?.title ?? null,
      from_nodes: Array.isArray(fromNodes) ? fromNodes : [],
      recovered: true,
    },
  };
}

/**
 * Refusal when the named nodes are not a complete live selection and cannot be
 * recovered as an already-converted subgraph.
 */
export function unresolvedCreateSubgraphNodesRefusal({ what, requested, foundIds } = {}) {
  const wanted = normalizeCreateSubgraphNodeIds(requested);
  const found = normalizeCreateSubgraphNodeIds(foundIds);
  const tool = typeof what === "string" && what ? what : "panel_create_subgraph";
  if (!wanted.length) return "provide node_ids to group into a subgraph";
  const foundSet = new Set(found);
  const missing = wanted.filter((id) => !foundSet.has(id));
  if (!found.length) {
    return (
      `${tool} was NOT run — none of the named nodes (${wanted.join(", ")}) are on this ` +
      `graph, and no live conversion receipt proves their outcome. A prior convertToSubgraph ` +
      `whose reply was lost would have moved them inside a wrapper; this retry could not ` +
      `find that wrapper. Re-read the graph (panel_graph_outline) before grouping again.`
    );
  }
  return (
    `${tool} was NOT retried because only ${found.length} of ${wanted.length} named nodes ` +
    `are still on this graph (missing: ${missing.join(", ")}). A lost reply after ` +
    `convertToSubgraph can leave the rest inside a subgraph already. Converting the leftover ` +
    `nodes would wrap a different set. Re-read the graph (panel_graph_outline) before grouping again.`
  );
}
