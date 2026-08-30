/**
 * #1996 — live-canvas capture for panel_strip_workflow.
 *
 * Newer MCP converts this capture against the panel's own node schema
 * (`graph_get_object_info`). The serialized `widgets_values` array is
 * positional in the FRONTEND's order, which that schema does not always
 * reproduce (V3 DynamicCombo nested leaves, JS-added widgets). MCP prefers
 * a name-keyed `capturedWidgetValues` map when present. Attach it here so
 * strip does not depend on schema-version agreement for widget routing.
 *
 * Unknown extra fields on the serialized graph (a newer LiteGraph / MCP
 * schema) are left in place. This helper only ADDS the name map.
 */

function asNodeList(graph) {
  if (!graph || typeof graph !== "object") return [];
  if (Array.isArray(graph._nodes)) return graph._nodes;
  if (Array.isArray(graph.nodes)) return graph.nodes;
  return [];
}

/** Live nodes on this graph and any nested subgraph instances. */
export function collectLiveNodes(graph, out = []) {
  for (const node of asNodeList(graph)) {
    if (!node) continue;
    out.push(node);
    if (node.subgraph) collectLiveNodes(node.subgraph, out);
  }
  return out;
}

/**
 * Name→value map for one live node's widgets, or null when none are named.
 * Values are the live widget values, not the positional serialize() row.
 */
export function capturedWidgetValuesForNode(liveNode) {
  const widgets = liveNode?.widgets;
  if (!Array.isArray(widgets) || widgets.length === 0) return null;
  const captured = {};
  let any = false;
  for (const widget of widgets) {
    if (!widget || typeof widget.name !== "string") continue;
    captured[widget.name] = widget.value;
    any = true;
  }
  return any ? captured : null;
}

/**
 * Stamp `capturedWidgetValues` onto serialized nodes that have a matching live
 * node. Does not clone, strip, or rewrite any other field — a newer schema's
 * extra keys and version stamp stay as serialize() emitted them.
 */
export function attachCapturedWidgetValues(workflow, liveNodes) {
  if (!workflow || typeof workflow !== "object") return workflow;
  const nodes = workflow.nodes;
  if (!Array.isArray(nodes)) return workflow;
  const liveById = new Map();
  for (const live of liveNodes ?? []) {
    if (live && live.id != null) liveById.set(live.id, live);
  }
  for (const node of nodes) {
    if (!node || typeof node !== "object" || node.id == null) continue;
    const captured = capturedWidgetValuesForNode(liveById.get(node.id));
    if (captured) node.capturedWidgetValues = captured;
  }
  const subgraphs = workflow.definitions?.subgraphs;
  if (Array.isArray(subgraphs)) {
    for (const def of subgraphs) attachCapturedWidgetValues(def, liveNodes);
  }
  return workflow;
}

function runSerialize(rootGraph) {
  if (typeof rootGraph?.serialize !== "function") {
    throw new Error("The live canvas has no serialize()");
  }
  return rootGraph.serialize();
}

/**
 * Serialize the live root, retrying once after an optional reconcile if the
 * first serialize throws (V3 DynamicCombo leftovers). Then attach name-keyed
 * widget values for the converter.
 *
 * @param {object} rootGraph
 * @param {{ reconcile?: ((graph: object) => void) | null }} [opts]
 */
export function serializeLiveGraph(rootGraph, { reconcile = null } = {}) {
  if (typeof reconcile === "function") {
    try {
      reconcile(rootGraph);
    } catch {
      // Best-effort: a hostile node must not block the capture.
    }
  }
  let workflow;
  try {
    workflow = runSerialize(rootGraph);
  } catch (first) {
    if (typeof reconcile === "function") {
      try {
        reconcile(rootGraph);
      } catch {
        /* retry with whatever we could clean */
      }
    }
    try {
      workflow = runSerialize(rootGraph);
    } catch (retry) {
      throw retry ?? first;
    }
  }
  attachCapturedWidgetValues(workflow, collectLiveNodes(rootGraph));
  return workflow;
}
