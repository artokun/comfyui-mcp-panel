/**
 * #697 — "No node with id 105 in the current graph", immediately after
 * panel_graph_outline AND panel_query_graph had both reported node 105 on the
 * active workflow.
 *
 * Nothing was stale. The reads and the write ask different questions:
 *
 *   • the READS walk the root graph AND its nested subgraphs, so they report a
 *     node wherever it lives;
 *   • `resolveNode` calls `graph.getNodeById()` on the CURRENT graph only — and
 *     `getGraphCtx().graph` is the graph being VIEWED, which is a subgraph while
 *     you are inside one.
 *
 * So a node a read just listed is genuinely unresolvable for a write whenever the
 * two scopes differ, and the old message said only that it was not "in the current
 * graph" — true, and useless, because it named neither the scope the caller was in
 * nor the scope the node was in. The reporter's own workaround (re-target, re-read,
 * retry) worked because it reset the viewing scope, which is also why it looked like
 * a routing/session bug rather than a scope mismatch.
 *
 * This module answers the question the failure raises: WHERE is it, then?
 *
 * SEARCH IS BOUNDED AND NON-THROWING. It runs only on the failure path, and any
 * unexpected shape simply ends that branch — a diagnostic that throws would replace a
 * bad error with a worse one.
 *
 * `MAX_DEPTH` IS THE SAFETY PROPERTY; `seen` IS AN OPTIMIZATION. Worth stating because
 * the reverse is the natural assumption. `MAX_DEPTH` bounds the one case nothing else
 * does — an unbounded ACYCLIC chain, where every level is a distinct object and `seen`
 * never fires — and it is pinned by its own test. `seen` only stops a subgraph
 * definition instanced N times from being searched N times; with the depth bound in
 * place a self-referencing graph already terminates without it, so deleting `seen`
 * correctly breaks no test. Do not "fix" that by adding one: it would assert an
 * invariant this code does not depend on.
 *
 * NO CLAIM IS MADE ABOUT WHICH INSTANCE. A subgraph definition can be instanced
 * several times; the first host found is reported as *a* route to the node, not as
 * the only one, because picking one and calling it "the" location would be a guess
 * with a plausible-looking shape.
 */

/** Depth guard for a pathological/looping graph. Real workflows nest a handful deep. */
const MAX_DEPTH = 12;

function nodesOf(graph) {
  const raw = graph?._nodes ?? graph?.nodes;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Find a node by its LOCAL id anywhere in the workflow, reporting the route to it.
 *
 * @param {object} rootGraph the workflow's root graph
 * @param {number|string} nodeId the local id being looked up
 * @returns {null | {scope: "root"|"subgraph", hostPath: Array<{id: any, title: string}>}}
 *   `hostPath` is the chain of subgraph HOST nodes to enter, outermost first; empty
 *   for a node on the root graph.
 */
export function locateNodeAcrossScopes(rootGraph, nodeId) {
  const target = Number(nodeId);
  if (!Number.isFinite(target)) return null;
  const seen = new Set();

  const walk = (graph, hostPath, depth) => {
    if (!graph || depth > MAX_DEPTH || seen.has(graph)) return null;
    seen.add(graph);
    for (const n of nodesOf(graph)) {
      if (Number(n?.id) === target) {
        return { scope: hostPath.length ? "subgraph" : "root", hostPath };
      }
    }
    // Depth-first into each subgraph host. Done AFTER the flat scan so a node in the
    // current level is always preferred over a same-id node deeper in.
    for (const n of nodesOf(graph)) {
      if (!n?.subgraph) continue;
      const hit = walk(n.subgraph, [...hostPath, { id: n.id, title: n.title || n.type || "subgraph" }], depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  try {
    return walk(rootGraph, [], 0);
  } catch {
    return null; // a diagnostic must never throw
  }
}

/** Count the subgraphs searched, so a genuine miss can say how hard it looked. */
export function countSubgraphs(rootGraph) {
  const seen = new Set();
  let n = 0;
  const walk = (graph, depth) => {
    if (!graph || depth > MAX_DEPTH || seen.has(graph)) return;
    seen.add(graph);
    for (const node of nodesOf(graph)) {
      if (!node?.subgraph) continue;
      n++;
      walk(node.subgraph, depth + 1);
    }
  };
  try {
    walk(rootGraph, 0);
  } catch {
    /* best effort */
  }
  return n;
}

/**
 * The message for a node id that did not resolve in the current graph.
 *
 * Always begins `No node with id <id>` so existing callers/tests that match that
 * prefix are unaffected.
 *
 * @param {number|string} nodeId
 * @param {object|null} rootGraph  null/absent ⇒ the plain message, unchanged
 * @param {boolean} viewingRoot    true when the current graph IS the root
 */
export function describeMissingNode(nodeId, rootGraph, viewingRoot) {
  const base = `No node with id ${nodeId} in the current graph`;
  if (!rootGraph) return base;

  const found = locateNodeAcrossScopes(rootGraph, nodeId);
  if (!found) {
    const subs = countSubgraphs(rootGraph);
    return (
      `${base} — and it is not in any other scope either ` +
      `(searched the root graph${subs ? ` and ${subs} subgraph(s)` : ""}). ` +
      `The id may be from a different workflow, or the node was removed. ` +
      `Re-read with panel_graph_outline before retrying.`
    );
  }

  if (found.scope === "root") {
    // Only reachable while viewing a subgraph, so the remedy is to leave it.
    return (
      `${base}. Node ${nodeId} is on the ROOT graph, but you are currently inside a ` +
      `subgraph — the write applies to the graph you are VIEWING, not the whole ` +
      `workflow. Call panel_exit_subgraph, then retry. (Reads such as ` +
      `panel_graph_outline span every scope, which is why they listed it.)`
    );
  }

  const route = found.hostPath.map((h) => `"${h.title}" (node ${h.id})`).join(" → ");
  const enter = found.hostPath.map((h) => `panel_enter_subgraph(${h.id})`).join(", then ");
  return (
    `${base}. Node ${nodeId} lives INSIDE a subgraph — ${route}${viewingRoot ? "" : ", from the root"} — ` +
    `and the write applies to the graph you are VIEWING, not the whole workflow. ` +
    `Enter it (${enter}), then retry. (Reads such as panel_graph_outline span every ` +
    `scope, which is why they listed it.) A subgraph can be instanced more than once; ` +
    `this is one route to that node, not necessarily the only one.`
  );
}
