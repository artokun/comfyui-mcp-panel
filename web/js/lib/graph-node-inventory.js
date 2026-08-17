// #1275 — the live-graph INVENTORY a node-def refresh is checked against.
//
// panel_refresh_nodes runs registerNodesFromDefs + reapplyDefsToLiveNodes +
// app.refreshComboInNodes over the LIVE canvas. On the reporter's install
// (ComfyUI 0.27.0 / frontend 1.45.20) that path silently DELETED five of seven
// newly added, still-unconnected nodes — LoadImage #13, two CLIPTextEncode, an
// ImageDecode and a SaveImage — while the tool answered {ok:true,
// refreshed:true} over the loss. The pruning step runs inside frontend or
// extension code the panel calls, not in panel code, so the panel cannot avoid
// it by picking different calls; what it can do is refuse to let a loss pass
// silently. This module is the pure half of that guard: what the live graph
// held before the refresh, what is gone after it, and how a node entry reads
// in a disclosure.
//
// Pure: graphs arrive as arguments; nothing here touches the app or the DOM.

import { collectAllGraphs } from "./asset-staleness.js";

/**
 * One entry per live node reachable from `rootGraph` (subgraphs included), as
 * `{ graph, id, type, title }`. The GRAPH REFERENCE is kept on purpose:
 * `vanishedLiveNodes` keys on it, so a refresh that replaced a graph object
 * wholesale reads as every node on that graph having vanished — which is
 * exactly the loss shape this guard exists for. Best-effort: an unreadable
 * graph yields the entries collected so far, never a throw.
 */
export function liveGraphNodeInventory(rootGraph) {
  const out = [];
  try {
    for (const graph of collectAllGraphs(rootGraph)) {
      for (const node of graph?._nodes ?? []) {
        if (node == null || node.id == null) continue;
        out.push({
          graph,
          id: node.id,
          type: node.type ?? node.comfyClass ?? null,
          title: typeof node.title === "string" ? node.title : null,
        });
      }
    }
  } catch {
    /* inventory is best-effort — a guard that throws guards nothing */
  }
  return out;
}

/**
 * The `before` entries whose node is NO LONGER on the live graph, matched by
 * (graph reference, node id): an entry whose graph is no longer reachable from
 * `currentRoot` at all counts as vanished, because whatever replaced that
 * graph took the node with it. An empty result means the refresh was additive
 * — nothing the graph held is gone. Returns [] when there is nothing to check
 * against (`currentRoot` unreadable): the guard then claims nothing, which is
 * the pre-fix behavior, never a false loss report.
 */
export function vanishedLiveNodes(before, currentRoot) {
  if (!Array.isArray(before) || !before.length || !currentRoot) return [];
  const after = new Map();
  try {
    for (const graph of collectAllGraphs(currentRoot)) {
      const ids = new Set();
      for (const node of graph?._nodes ?? []) {
        if (node?.id != null) ids.add(node.id);
      }
      after.set(graph, ids);
    }
  } catch {
    return [];
  }
  return before.filter((entry) => entry != null && !after.get(entry.graph)?.has(entry.id));
}

/**
 * Id-set membership check for AFTER a full-graph restore: the restore rebuilds
 * every graph object, so the graph references on the `before` entries are all
 * stale and `vanishedLiveNodes` would report everything. Used only to verify
 * that a restore brought the nodes back, not to detect the loss in the first
 * place. One accepted imprecision, stated rather than hidden: node ids are
 * unique per graph, not across graphs, so a subgraph-local id that collides
 * with a surviving id elsewhere can read as restored when it is not. That is
 * narrower than skipping the verification entirely.
 */
export function missingInventoryIds(before, currentRoot) {
  if (!Array.isArray(before) || !before.length || !currentRoot) return [];
  const present = new Set();
  try {
    for (const graph of collectAllGraphs(currentRoot)) {
      for (const node of graph?._nodes ?? []) {
        if (node?.id != null) present.add(node.id);
      }
    }
  } catch {
    return [];
  }
  return before.filter((entry) => entry != null && entry.id != null && !present.has(entry.id));
}

/**
 * How one inventory entry reads in a disclosure: `LoadImage #13`, or
 * `"my loader" (LoadImage #13)` when the user gave the node a real title.
 * A null type (frontend-only node with neither) degrades to the title or the
 * bare id rather than printing "null".
 */
export function nodeInventoryLabel(entry) {
  const type = entry?.type ?? null;
  const title = entry?.title ?? null;
  const id = entry?.id;
  if (title && title !== type) return type ? `"${title}" (${type} #${id})` : `"${title}" (#${id})`;
  if (type) return `${type} #${id}`;
  return `#${id}`;
}
