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
 * #1298 is the sibling when the answer is NOWHERE. A mutation after a graph
 * change (the user deleted nodes; a load remapped ids) used to stop at "not in
 * the current graph" and send the caller to re-read. The re-read is a second
 * round-trip they already had the evidence for: the live graph the write just
 * searched. The genuine-miss path now names the current ids on the graph the
 * mutation applied to, so the next call can retarget without another outline.
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

/**
 * Cap on ids named in a genuine-miss error. The list exists so a mutation can
 * retarget without another outline call (#1298); it is not a substitute for
 * outline, so a 200-node dump would hide the diagnosis.
 */
const MAX_CURRENT_IDS = 40;

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
 * Current ids on the graph a mutation actually applied to, so a genuine miss
 * can name what IS addressable (#1298). Best-effort and non-throwing: a
 * diagnostic that throws replaces a bad error with a worse one.
 *
 * The missing id is filtered out even if `_nodes` and `getNodeById` have
 * drifted — listing it as live would send the caller back at the same miss.
 */
function currentIdSuffix(graph, nodeId) {
  if (!graph) return "";
  try {
    const wanted = nodeId == null ? "" : String(nodeId);
    const parts = [];
    for (const n of nodesOf(graph)) {
      if (n?.id == null) continue;
      if (wanted && String(n.id) === wanted) continue;
      const type =
        typeof n.type === "string" && n.type
          ? n.type
          : typeof n.comfyClass === "string" && n.comfyClass
            ? n.comfyClass
            : "";
      parts.push(type ? `${n.id} (${type})` : `${n.id}`);
    }
    if (!parts.length) {
      return (
        "The graph you are viewing currently has no nodes. " +
        "Re-read with panel_graph_outline before retrying."
      );
    }
    const shown = parts.slice(0, MAX_CURRENT_IDS);
    const extra =
      parts.length > MAX_CURRENT_IDS ? `, …and ${parts.length - MAX_CURRENT_IDS} more` : "";
    return (
      `Current ids on the graph you are viewing: ${shown.join(", ")}${extra}. ` +
      `Retarget using a current id; re-read with panel_graph_outline if you need wiring.`
    );
  } catch {
    return "";
  }
}

/**
 * The message for a node id that did not resolve in the current graph.
 *
 * Always begins `No node with id <id>` so existing callers/tests that match that
 * prefix are unaffected.
 *
 * @param {number|string} nodeId
 * @param {object|null} rootGraph  null/absent ⇒ the plain message, unless
 *   `currentGraph` can still name live ids
 * @param {boolean} viewingRoot    true when the current graph IS the root
 * @param {object|null} [currentGraph]  the graph the mutation applied to (the
 *   one `getNodeById` just searched). When omitted, the root is used only if
 *   `viewingRoot` is true — a subgraph view must not be told the root's ids.
 */
export function describeMissingNode(nodeId, rootGraph, viewingRoot, currentGraph) {
  const base = `No node with id ${nodeId} in the current graph`;
  const graphForIds = currentGraph ?? (viewingRoot ? rootGraph : null);
  const ids = currentIdSuffix(graphForIds, nodeId);
  if (!rootGraph) return ids ? `${base}. ${ids}` : base;

  const found = locateNodeAcrossScopes(rootGraph, nodeId);
  if (!found) {
    const subs = countSubgraphs(rootGraph);
    return (
      `${base} — and it is not in any other scope either ` +
      `(searched the root graph${subs ? ` and ${subs} subgraph(s)` : ""}). ` +
      `The id may be from a different workflow, or the node was removed. ` +
      (ids || `Re-read with panel_graph_outline before retrying.`)
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

/**
 * The message for an id that IS resolvable — as a subgraph BOUNDARY RAIL — but is
 * not an ordinary node the write can act on (artokun/comfyui-mcp#1294).
 *
 * WHAT WAS WRONG. `panel_query_graph` reports the rails it found as
 * `rails.output.rail_node_id: "-20"`. Passing that straight back to a write got:
 *
 *     No node with id -20 in the current graph — and it is not in any other scope
 *     either (searched the root graph and 4 subgraph(s)). The id may be from a
 *     different workflow, or the node was removed. Re-read with panel_graph_outline
 *     before retrying.
 *
 * Every clause after the first is false. The id did not come from another workflow;
 * it came from THIS graph, from our own read, one call earlier. Nothing was removed.
 * And the remedy sends the caller to re-read a surface that will hand back the very
 * same id — the loop the reporter actually ran.
 *
 * This is the #697 mistake in a new place: the reads and the writes ask different
 * questions, and the failure described only the write's answer. There the missing
 * axis was SCOPE; here it is KIND. A rail is a real, addressable thing — `move_rail`
 * and `panel_move_node` both take exactly this id (#302) — so "no such node" is not
 * even true of the panel's own tool surface.
 *
 * WHAT IS AND IS NOT CLAIMED. It says what the id is, that this operation works on
 * ordinary nodes, and what does work today. Removal now exists —
 * `panel_unexpose_subgraph_input`/`panel_unexpose_subgraph_output` take a slot's
 * NAME (artokun/comfyui-mcp#1294) — but a RAIL id is refused there too, because it
 * names the whole rail, not a slot on it; the message must not read as "pass -20 to
 * unexpose". The interior-node workaround stays named for the caller who wants the
 * slot and its source gone together.
 *
 * @param {number|string} nodeId
 * @param {"input"|"output"} rail
 */
export function describeRailNodeTarget(nodeId, rail) {
  const side = rail === "input" ? "INPUT" : "OUTPUT";
  return (
    `Id ${nodeId} resolves to this subgraph's ${side} BOUNDARY RAIL in the graph you ` +
    `are viewing — the pseudo-node panel_query_graph reports as ` +
    `rails.${rail}.rail_node_id. It is not an ordinary node, and this operation acts ` +
    `on ordinary graph nodes and their links, which is why it cannot take it. ` +
    `panel_move_node DOES accept a rail id, but only to reposition it (pos only — a ` +
    `rail has nothing else to set); panel_move_rail addresses the same rail by SIDE ` +
    `("${rail}") rather than by id. ` +
    `To REMOVE one slot from this rail, panel_unexpose_subgraph_input / ` +
    `panel_unexpose_subgraph_output take the slot's NAME as panel_query_graph lists ` +
    `it under rails.${rail} — a rail id is refused there too, because it names the ` +
    `whole rail, not a slot on it. Removing or replacing the interior node feeding ` +
    `a slot also cleans the slot up automatically. ` +
    // The one thing this CANNOT rule out, stated rather than glossed over: node ids
    // are arbitrary integers, so an ordinary node may once have held this id and been
    // removed. Then the id really is stale and re-reading is right — which is why the
    // message says what resolved, not "your id is fine".
    `(If you meant an ORDINARY node with this id, there is none in the graph you are ` +
    `viewing. A removed node's id can collide with a rail's, so re-read ` +
    `panel_graph_outline if that is your case — but an id taken from ` +
    `rails.${rail}.rail_node_id is not.)`
  );
}
