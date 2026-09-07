// #2267 — recover a panel_create_subgraph whose conversion applied but whose
// reply never reached the caller (HTTP send error / dropped orchestrator
// transport). convertToSubgraph moves the selected nodes INTO the new wrapper,
// so a blind retry of the same node_ids either throws "provide node_ids" or
// wraps whatever leftover siblings still sit on the parent.
//
// Graph state is the source of truth: if EVERY named id is gone from this graph
// and lives inside exactly one subgraph node here, the conversion already
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

function subgraphContainsAll(subgraph, wanted) {
  if (!subgraph || typeof subgraph !== "object" || !wanted.length) return false;
  const nodes = Array.isArray(subgraph._nodes)
    ? subgraph._nodes
    : Array.isArray(subgraph.nodes)
      ? subgraph.nodes
      : null;
  if (nodes) {
    const inner = new Set();
    for (const node of nodes) {
      const id = Number(node?.id);
      if (!Number.isFinite(id) || RAIL_IDS.has(id)) continue;
      inner.add(id);
    }
    return wanted.every((id) => inner.has(id));
  }
  if (typeof subgraph.getNodeById === "function") {
    return wanted.every((id) => {
      const node = subgraph.getNodeById(id);
      if (!node) return false;
      const liveId = Number(node.id);
      return Number.isFinite(liveId) && !RAIL_IDS.has(liveId);
    });
  }
  return false;
}

/**
 * The subgraph node that already holds every named id, or null.
 *
 * Returns null when any named node is still on THIS graph (conversion has not
 * consumed them), when no host contains all of them, or when more than one host
 * does (ambiguous — fail closed rather than pick).
 *
 * @param {{ graph?: object, nodeIds?: unknown[] }} args
 * @returns {object | null}
 */
export function recoverConvertedSubgraph({ graph, nodeIds } = {}) {
  const wanted = normalizeCreateSubgraphNodeIds(nodeIds);
  if (!wanted.length || !graph || typeof graph !== "object") return null;
  if (typeof graph.getNodeById === "function") {
    for (const id of wanted) {
      if (graph.getNodeById(id)) return null;
    }
  }
  const list = Array.isArray(graph._nodes) ? graph._nodes : [];
  const hosts = [];
  for (const node of list) {
    if (!isPromotedContainer(node)) continue;
    if (subgraphContainsAll(node.subgraph, wanted)) hosts.push(node);
  }
  return hosts.length === 1 ? hosts[0] : null;
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
      `graph, and no existing subgraph contains all of them. A prior convertToSubgraph ` +
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
