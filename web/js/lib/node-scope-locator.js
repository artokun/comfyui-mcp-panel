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
 * NOT-FOUND AND COULD-NOT-LOOK ARE DIFFERENT ANSWERS (#1501). Failing closed is right;
 * reporting the failure as a finding is not. `null` used to mean all three of "searched
 * every scope and it is absent", "the walk threw part-way", and "that id is not a shape
 * I can look up" — and the only one of the three the caller could spell was the first:
 * "The id may be from a different workflow, or the node was removed." So a malformed
 * graph or a throwing getter on a third-party node was published to the agent as a
 * positive statement about the node's ABSENCE. The walk reads arbitrary third-party node
 * objects (`n.subgraph`, `n.title`, `n.type`), so this is reachable rather than
 * theoretical. `null` now means only "searched and absent"; "could not look" comes back
 * as `{ unsearchable }` and the message says so instead of guessing.
 *
 * A QUALIFIED ID IS A REAL ID (#1501, artokun/comfyui-mcp#1425). The walk matched on
 * `Number(id)`, so `120:104` — the form the READ tools deliberately hand out once a
 * subgraph has been unpacked — came out NaN and the locator returned before searching
 * anything. The node existed, was addressable, and the diagnostic said it was from a
 * different workflow: worse than silence, because it points the reader at a
 * workflow-identity problem that does not exist. Ids are now compared the way
 * `canonicalNodeId` resolves them — a qualified id by its string key, everything else
 * numerically, exactly as before.
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

import { isQualifiedNodeId } from "./node-id.js";

/** Depth guard for a pathological/looping graph. Real workflows nest a handful deep. */
const MAX_DEPTH = 12;

/**
 * Cap on ids named in a genuine-miss error. The list exists so a mutation can
 * retarget without another outline call (#1298); it is not a substitute for
 * outline, so a 200-node dump would hide the diagnosis.
 */
const MAX_CURRENT_IDS = 40;

/**
 * The opening of the retarget suffix, named once because #1495's message has to ask
 * whether the suffix actually NAMES ids (it degrades to "…has no nodes" on an empty
 * graph) before it may offer it as the remedy. A second literal here would drift.
 */
const CURRENT_IDS_PREFIX = "Current ids on the graph you are viewing: ";

function nodesOf(graph) {
  const raw = graph?._nodes ?? graph?.nodes;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Why a search produced no location. Both mean "I could not look", never "it is
 * not there" — see the `{ unsearchable }` note in the module header.
 *
 * `"walk-threw"`  the graph walk raised part-way through; scopes remain unsearched.
 * `"id-shape"`    the id is neither an integer nor a subgraph-qualified id, so there
 *                 was no key to look for and nothing was searched at all.
 */
const UNSEARCHABLE_REASONS = ["walk-threw", "id-shape"];

/** True for the "could not look" result, so a caller can never mistake it for a miss. */
export function isUnsearchable(result) {
  return Boolean(result) && UNSEARCHABLE_REASONS.includes(result.unsearchable);
}

/**
 * Find a node by its LOCAL id anywhere in the workflow, reporting the route to it.
 *
 * THREE ANSWERS, NOT TWO (#1501). `null` means the search RAN and the id is absent —
 * only a caller holding that value may say the node is not here. A `{ unsearchable }`
 * result means the search could not run or could not finish, and the caller must say
 * that instead of guessing at absence.
 *
 * @param {object} rootGraph the workflow's root graph
 * @param {number|string} nodeId the local id being looked up — an integer, a numeric
 *   string, or a subgraph-qualified id such as `"120:104"` (comfyui-mcp#1425)
 * @returns {null | {unsearchable: string} | {scope: "root"|"subgraph", hostPath: Array<{id: any, title: string}>}}
 *   `hostPath` is the chain of subgraph HOST nodes to enter, outermost first; empty
 *   for a node on the root graph.
 */
export function locateNodeAcrossScopes(rootGraph, nodeId) {
  // A qualified id is a LiteGraph object key, matched as the string it is; anything
  // else keeps the numeric comparison unchanged, so a plain id behaves exactly as
  // before (including the numeric-string surface: `Number("5548") === 5548`, and live
  // ComfyUI ids really are strings). Parsing a qualified id is the one thing that must
  // not happen — `parseInt("263:78")` is 263, a different real node.
  const qualified = isQualifiedNodeId(nodeId);
  const target = qualified ? nodeId : Number(nodeId);
  if (!qualified && !Number.isFinite(target)) return { unsearchable: "id-shape" };
  const matches = qualified
    ? (n) => n?.id != null && String(n.id) === target
    : (n) => Number(n?.id) === target;
  const seen = new Set();

  const walk = (graph, hostPath, depth) => {
    if (!graph || depth > MAX_DEPTH || seen.has(graph)) return null;
    seen.add(graph);
    for (const n of nodesOf(graph)) {
      if (matches(n)) {
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
    // Still non-throwing — but no longer indistinguishable from a completed search.
    return { unsearchable: "walk-threw" };
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
      `${CURRENT_IDS_PREFIX}${shown.join(", ")}${extra}. ` +
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

  // #1501 — "I could not look" must never be published as "it is not there". Both of
  // these used to fall into the genuine-miss branch below and assert absence.
  if (isUnsearchable(found)) {
    const why =
      found.unsearchable === "id-shape"
        ? `no wider search was possible: ${JSON.stringify(String(nodeId))} is not an id ` +
          `shape this panel can look up (expected an integer, or a subgraph-qualified ` +
          `id such as 120:104 — the form the read tools emit once a subgraph is unpacked)`
        : `the wider search could NOT be completed: reading this workflow's graph threw ` +
          `part-way through, so some scopes were never searched`;
    return (
      `${base} — and ${why}. Whether node ${nodeId} exists in another scope is ` +
      `UNKNOWN: this is NOT a statement that it was removed or that the id belongs to ` +
      `a different workflow. ` +
      (ids || `Re-read with panel_graph_outline before retrying.`)
    );
  }

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
    // #1495 — this branch used to assert "you are currently inside a subgraph"
    // unconditionally, on the premise the old comment here stated: that it was
    // "only reachable while viewing a subgraph". Nothing enforces that premise.
    // The branch fires whenever the ROOT walk finds the id, and the ROOT walk reads
    // the graph's node LIST (`_nodes`) while the lookup that just missed reads the
    // id INDEX (`getNodeById`) — the same two sources `currentIdSuffix` above
    // already assumes can drift. When they drift on the root graph, the caller is
    // AT root and is told to leave a subgraph they are not in. The reporter ran
    // exactly that: panel_exit_subgraph answered "already at root", and the retry
    // that followed succeeded. The wasted round-trip IS the defect, and its cause
    // is a scope claim published without checking the scope.
    //
    // So decide it from evidence THIS call holds. `currentGraph` is the graph the
    // failed lookup actually searched, so `currentGraph === rootGraph` is
    // same-reading object identity. `viewingRoot` is a separately-timed reading of
    // the viewing scope (resolveNode takes it AFTER the lookup, from a second
    // getGraphCtx()), so it is only consulted when no `currentGraph` was passed.
    const searchedRoot = currentGraph ? currentGraph === rootGraph : Boolean(viewingRoot);
    if (searchedRoot) {
      // The retarget list is offered only when it actually names ids: on a graph
      // whose only node is the missing one it degrades to "has no nodes", which
      // would contradict the sentence right before it.
      const retarget = ids.startsWith(CURRENT_IDS_PREFIX)
        ? ids
        : "Re-read with panel_graph_outline before retrying.";
      return (
        `${base} — but node ${nodeId} IS on the root graph, and the root graph is what ` +
        `you are VIEWING, so this is NOT a subgraph scope problem: panel_exit_subgraph ` +
        `would answer "already at root" and change nothing. The root graph's node list ` +
        `holds ${nodeId} while the id lookup this write uses did not resolve it, so the ` +
        `id and that graph's index disagree. ` +
        retarget
      );
    }
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
