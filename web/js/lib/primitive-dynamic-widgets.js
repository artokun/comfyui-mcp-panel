/**
 * #2009 — panel_run rejects a freshly typed PrimitiveNode dynamic STRING widget.
 *
 * PrimitiveNode starts with a generic `*` output and no widgets. Connecting that
 * output to a STRING widget input (DenoMiniMaxH3ReferenceToVideo.prompt in the
 * report) re-addresses the node and mints a live `value` widget. panel_query_graph
 * and panel_set_widget see that widget; graphToPrompt then throws
 * "Dynamic widget doesn't exist on node".
 *
 * ComfyUI's DynamicCombo serializer looks widgets up by object identity / widget
 * store, which is captured from the node-definition schema. PrimitiveNode has no
 * backend schema — its widgets exist only on the live node, and a widget minted
 * after `graph.add()` can miss `setNodeId` registration. Reads and writes go
 * through the live widget; queue serialization does not.
 *
 * Before every prompt build, register the LIVE PrimitiveNode widgets (the graph's
 * own widget list, not constructor.nodeData). If the named serializer throw still
 * fires, recreate those widgets from the live connection and retry. A persistent
 * throw is named so the caller is not sent to a SaveVideo orphan hunt.
 *
 * Read-mostly and dependency-free so it can be unit-tested in isolation.
 */

function graphNodes(graph) {
  if (Array.isArray(graph?._nodes) && graph._nodes.length) return graph._nodes;
  if (Array.isArray(graph?.nodes)) return graph.nodes;
  return [];
}

function outputType(node) {
  try {
    const type = node?.outputs?.[0]?.type;
    return typeof type === "string" && type && type !== "*" ? type : null;
  } catch {
    return null;
  }
}

function widgetName(widget) {
  try {
    return typeof widget?.name === "string" && widget.name ? widget.name : null;
  } catch {
    return null;
  }
}

/**
 * True when `node` is a PrimitiveNode whose generic output has been re-addressed
 * by a connection and which now carries the live widgets that connection minted.
 */
export function isTypedPrimitiveNode(node) {
  if (!node || typeof node !== "object") return false;
  try {
    if (node.type !== "PrimitiveNode") return false;
  } catch {
    return false;
  }
  if (!outputType(node)) return false;
  try {
    return Array.isArray(node.widgets) && node.widgets.length > 0;
  } catch {
    return false;
  }
}

/**
 * Live PrimitiveNode dynamic widgets across `graph` and nested subgraphs.
 *
 * @param {object} graph
 * @returns {Array<{node: object, nodeId: unknown, outputType: string, widgetName: string, widget: object}>}
 */
export function livePrimitiveDynamicWidgets(graph) {
  const found = [];
  const seen = new Set();
  const walk = (g) => {
    if (!g || typeof g !== "object" || seen.has(g)) return;
    seen.add(g);
    for (const node of graphNodes(g)) {
      try {
        if (isTypedPrimitiveNode(node)) {
          const typed = outputType(node);
          for (const widget of node.widgets) {
            const name = widgetName(widget);
            if (!name) continue;
            found.push({
              node,
              nodeId: node.id,
              outputType: typed,
              widgetName: name,
              widget,
            });
          }
        }
        if (node?.subgraph) walk(node.subgraph);
      } catch {
        // A hostile node must not hide the rest of the graph.
      }
    }
  };
  walk(graph);
  return found;
}

function registerWidget(node, widget) {
  try {
    if (typeof widget?.setNodeId !== "function" || node?.id == null) return false;
    widget.setNodeId(node.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register every live PrimitiveNode widget against the node it already sits on.
 *
 * This is the live-graph widget schema: `node.widgets`, not `constructor.nodeData`.
 * `setNodeId` is what `graph.add()` would have called had the widget existed then.
 *
 * @param {object} graph
 * @returns {{registered: number, nodes: number}}
 */
export function registerLivePrimitiveWidgets(graph) {
  const live = livePrimitiveDynamicWidgets(graph);
  const nodes = new Set();
  let registered = 0;
  for (const entry of live) {
    if (registerWidget(entry.node, entry.widget)) {
      registered += 1;
      nodes.add(entry.node);
    }
  }
  return { registered, nodes: nodes.size };
}

/**
 * Recreate typed PrimitiveNode widgets from the live connection, then re-register.
 *
 * `recreateWidget` is PrimitiveNode's own resync (it tears down and rebuilds from
 * the connected target config). Used on the serializer retry so a widget minted
 * after `graph.add()` is the object identity graphToPrompt walks.
 *
 * @param {object} graph
 * @returns {{recreated: number, registered: number}}
 */
export function resyncLivePrimitiveWidgets(graph) {
  const seen = new Set();
  let recreated = 0;
  for (const entry of livePrimitiveDynamicWidgets(graph)) {
    if (seen.has(entry.node)) continue;
    seen.add(entry.node);
    try {
      if (typeof entry.node.recreateWidget === "function") {
        entry.node.recreateWidget();
        recreated += 1;
      }
    } catch {
      // A recreate that the frontend rejects is not a reason to skip registration
      // of whatever widgets are still live.
    }
  }
  const { registered } = registerLivePrimitiveWidgets(graph);
  return { recreated, registered };
}

/**
 * Typed PrimitiveNode widgets, for naming a serializer throw that otherwise
 * says only "Dynamic widget doesn't exist on node".
 *
 * @param {object} graph
 * @returns {Array<{nodeId: unknown, nodeType: string, outputType: string, widgetName: string}>}
 */
export function describeTypedPrimitiveWidgets(graph) {
  return livePrimitiveDynamicWidgets(graph).map((entry) => ({
    nodeId: entry.nodeId,
    nodeType: "PrimitiveNode",
    outputType: entry.outputType,
    widgetName: entry.widgetName,
  }));
}
