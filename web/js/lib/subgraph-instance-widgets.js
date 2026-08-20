/**
 * comfyui-mcp#1827 — keep instance-scoped promoted widget values when a subgraph
 * DEFINITION is updated.
 *
 * Copied subgraph nodes share one `Subgraph` object (`clone()` does not deep-clone).
 * Entering a copy, adding/rewiring inner nodes, then exiting caused ComfyUI to
 * reconfigure every instance of that definition. `SubgraphNode.configure` recreates
 * host inputs WITHOUT `widgetId`, so `_applyPromotedWidgetValues` is a no-op, and
 * `_setWidget` then seeds the per-instance store from the INNER widget (or leaves
 * the rail as `""`). `panel_query_graph` showed `widgets.text=""` on every copy;
 * `inner_previous` still held the template default.
 *
 * The panel cannot stop the frontend replacing the definition. It can snapshot the
 * parent rails BEFORE an inner mutation and write them back AFTER, once widgetIds
 * exist again. Restore writes the RAIL only — never the shared inner widget.
 */

import { promotedValueScope } from "./widget-write.js";

function cloneValue(value) {
  if (value == null || typeof value !== "object") return value;
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    /* JSON fallback below */
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function valuesMatch(a, b) {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function subgraphIdentity(subgraph) {
  if (!subgraph || typeof subgraph !== "object") return null;
  if (subgraph.id != null) return String(subgraph.id);
  return null;
}

/**
 * Every SubgraphNode that instances `subgraph`. Copied wrappers share the object
 * AND the type UUID (`SubgraphNode.type === subgraph.id`); match either so a
 * clone that did not keep object identity still restores.
 */
export function collectSubgraphInstanceNodes(rootGraph, subgraph) {
  const out = [];
  if (!rootGraph || !subgraph) return out;
  const wantId = subgraphIdentity(subgraph);
  const stack = [rootGraph];
  const seen = new Set();
  while (stack.length) {
    const graph = stack.pop();
    if (!graph || seen.has(graph)) continue;
    seen.add(graph);
    for (const node of graph._nodes ?? []) {
      if (!node) continue;
      if (node.subgraph) stack.push(node.subgraph);
      const sameObject = node.subgraph === subgraph;
      const sameId =
        wantId != null &&
        (String(node.subgraph?.id ?? "") === wantId || String(node.type ?? "") === wantId);
      if (sameObject || sameId) out.push(node);
    }
  }
  return out;
}

function readRails(node) {
  let widgets;
  try {
    widgets = node?.widgets;
  } catch {
    return [];
  }
  if (!Array.isArray(widgets)) return [];
  const out = [];
  for (const rail of widgets) {
    if (!rail || typeof rail.name !== "string" || !rail.name) continue;
    let value;
    try {
      value = rail.value;
    } catch {
      continue;
    }
    let widgetId = null;
    try {
      widgetId = typeof rail.widgetId === "string" && rail.widgetId ? rail.widgetId : null;
    } catch {
      widgetId = null;
    }
    if (!widgetId) {
      const input = (node.inputs ?? []).find((inp) => inp && inp.name === rail.name);
      try {
        widgetId = typeof input?.widgetId === "string" && input.widgetId ? input.widgetId : null;
      } catch {
        widgetId = null;
      }
    }
    out.push({ name: rail.name, value, widgetId, rail });
  }
  return out;
}

function findRail(node, widgetName, widgetId) {
  const rails = readRails(node);
  if (widgetId) {
    const byId = rails.find((r) => r.widgetId === widgetId);
    if (byId) return byId;
  }
  return rails.find((r) => r.name === widgetName) ?? null;
}

function hostInputFor(node, widgetName, widgetId) {
  const inputs = node?.inputs;
  if (!Array.isArray(inputs)) return widgetId ? { widgetId } : { name: widgetName };
  if (widgetId) {
    const byId = inputs.find((inp) => inp && inp.widgetId === widgetId);
    if (byId) return byId;
  }
  return inputs.find((inp) => inp && inp.name === widgetName) ?? { widgetId, name: widgetName };
}

/**
 * @returns {{ subgraph: object, entries: Array<{ nodeId: *, widgetName: string, value: *, widgetId: string | null }> }}
 */
export function snapshotPromotedInstanceWidgets(rootGraph, subgraph) {
  const entries = [];
  for (const node of collectSubgraphInstanceNodes(rootGraph, subgraph)) {
    for (const rail of readRails(node)) {
      entries.push({
        nodeId: node.id,
        widgetName: rail.name,
        value: cloneValue(rail.value),
        widgetId: rail.widgetId,
      });
    }
  }
  return { subgraph, entries };
}

/**
 * Write snapshotted instance values back onto matching parent rails. Skips a
 * rail that is definition-scoped (no per-instance `widgetId`) so a restore
 * cannot broadcast into the shared inner widget. Missing rails (unexposed
 * since the snapshot) are skipped, not invented.
 *
 * @returns {{ restored: number, skipped: number }}
 */
export function restorePromotedInstanceWidgets(rootGraph, snapshot) {
  const result = { restored: 0, skipped: 0 };
  if (!snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0) {
    return result;
  }
  const instances = collectSubgraphInstanceNodes(rootGraph, snapshot.subgraph);
  const byId = new Map();
  for (const node of instances) {
    if (node?.id != null) byId.set(String(node.id), node);
  }
  for (const entry of snapshot.entries) {
    const node = byId.get(String(entry.nodeId));
    if (!node) {
      result.skipped += 1;
      continue;
    }
    const found = findRail(node, entry.widgetName, entry.widgetId);
    if (!found) {
      result.skipped += 1;
      continue;
    }
    const hostInput = hostInputFor(node, entry.widgetName, entry.widgetId ?? found.widgetId);
    if (promotedValueScope(node, hostInput) !== "instance") {
      result.skipped += 1;
      continue;
    }
    if (valuesMatch(found.value, entry.value)) {
      result.skipped += 1;
      continue;
    }
    const next = cloneValue(entry.value);
    try {
      found.rail.value = next;
    } catch {
      result.skipped += 1;
      continue;
    }
    if (typeof found.rail.callback === "function") {
      try {
        found.rail.callback(next);
      } catch {
        /* setter is the store; a callback throw must not undo a landed restore */
      }
    }
    result.restored += 1;
  }
  return result;
}

/**
 * Named `widgets_values_named` map from a serialized node, or null when the
 * file did not carry one. Positional `widgets_values` is the fallback — it is
 * what older saves (and a frontend with named restore off) have — zipped with
 * the LIVE rail names after configure has built them.
 */
function savedHostWidgetMap(savedNode, liveNode) {
  const named = savedNode?.widgets_values_named;
  if (named && typeof named === "object" && !Array.isArray(named)) {
    const out = {};
    for (const [key, value] of Object.entries(named)) {
      if (typeof key === "string" && key) out[key] = value;
    }
    if (Object.keys(out).length) return out;
  }
  const positional = savedNode?.widgets_values;
  if (!Array.isArray(positional)) return {};
  const names = [];
  try {
    for (const rail of liveNode?.widgets ?? []) {
      if (rail && typeof rail.name === "string" && rail.name) names.push(rail.name);
    }
  } catch {
    return {};
  }
  const out = {};
  for (let i = 0; i < names.length && i < positional.length; i++) {
    out[names[i]] = positional[i];
  }
  return out;
}

function savedDefinitionsById(savedGraph) {
  const byId = new Map();
  for (const def of savedGraph?.definitions?.subgraphs ?? []) {
    if (def?.id != null) byId.set(String(def.id), def);
  }
  return byId;
}

/**
 * #874 remaining load path — `panel_load_workflow` / `graph_load` of a saved
 * subgraph host.
 *
 * ComfyUI's `SubgraphNode.configure` (frontend 1.49.6 and current master)
 * recreates host inputs from the definition, then `_setWidget` seeds the
 * per-instance store from the INNER widget. `_applyPromotedWidgetValues` is a
 * no-op while those inputs still have no `widgetId`. The file's
 * `widgets_values` / `widgets_values_named` survive on disk and the load
 * reports `loaded:true`, but the live host shows definition defaults for
 * prompt, dimensions, length, and selectors. Seed/fps can remain because they
 * are not rebuilt the same way.
 *
 * After `loadGraphData` the rails exist and have widgetIds. Re-apply the FILE's
 * host values onto those instance rails — never the shared inner widget.
 *
 * @returns {{ restored: number, skipped: number }}
 */
export function applySavedSubgraphHostWidgets(liveRoot, savedGraph) {
  const result = { restored: 0, skipped: 0 };
  if (!liveRoot || !savedGraph || typeof savedGraph !== "object") return result;
  const defs = savedDefinitionsById(savedGraph);

  const applyInGraph = (liveGraph, savedNodes) => {
    if (!liveGraph || !Array.isArray(savedNodes)) return;
    const savedById = new Map();
    for (const node of savedNodes) {
      if (node?.id != null) savedById.set(String(node.id), node);
    }
    let liveNodes;
    try {
      liveNodes = liveGraph._nodes;
    } catch {
      return;
    }
    if (!Array.isArray(liveNodes)) return;
    for (const live of liveNodes) {
      if (!live?.subgraph) continue;
      const saved = savedById.get(String(live.id));
      if (saved) {
        const values = savedHostWidgetMap(saved, live);
        const entries = Object.entries(values).map(([widgetName, value]) => ({
          nodeId: live.id,
          widgetName,
          value: cloneValue(value),
          widgetId: null,
        }));
        if (entries.length) {
          const one = restorePromotedInstanceWidgets(
            { _nodes: [live] },
            { subgraph: live.subgraph, entries },
          );
          result.restored += one.restored;
          result.skipped += one.skipped;
        }
      }
      const def = defs.get(String(live.subgraph.id ?? live.type ?? ""));
      if (def) applyInGraph(live.subgraph, def.nodes);
    }
  };

  applyInGraph(liveRoot, savedGraph.nodes);
  return result;
}

/**
 * Snapshot instance-scoped promoted rails, run `fn`, then restore. Used around
 * inner-graph mutations (and exit) so a definition replace cannot keep the
 * empty rails it just wrote. `fn` may be sync or async.
 *
 * A frontend `queueMicrotask` may delete a store entry AFTER the mutation
 * returns; one microtask flush runs before restore so that delete lands first.
 */
export async function withPreservedPromotedInstanceWidgets(rootGraph, subgraph, fn) {
  if (!rootGraph || !subgraph || rootGraph === subgraph) return fn();
  const snapshot = snapshotPromotedInstanceWidgets(rootGraph, subgraph);
  try {
    return await fn();
  } finally {
    try {
      await Promise.resolve();
    } catch {
      /* a hostile thenable must not skip restore */
    }
    restorePromotedInstanceWidgets(rootGraph, snapshot);
  }
}
