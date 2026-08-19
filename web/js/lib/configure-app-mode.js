// #1429 — write ComfyUI App Mode metadata onto the live root graph.
//
// Official frontend keys (Comfy-Org/ComfyUI_frontend appModeStore / LinearData):
//   extra.linearData = { inputs: [id, widgetName, config?][], outputs: nodeId[] }
//   extra.linearMode = boolean   (true → open as app, false → graph)
//
// The identity stamp lives on the same extra object (`extra.comfyui_mcp`). This
// module merges linearData / linearMode onto the EXISTING bag and never replaces
// extra or touches that namespace.

export const APP_MODE_META_NAMESPACE = "comfyui_mcp";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function own(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

export function widgetNamesOn(node) {
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  const names = [];
  for (const widget of widgets) {
    if (widget && typeof widget.name === "string" && widget.name) names.push(widget.name);
  }
  return names;
}

export function findNodeWidget(node, widgetName) {
  if (typeof widgetName !== "string" || !widgetName) return null;
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  return widgets.find((widget) => widget && widget.name === widgetName) ?? null;
}

function normalizeInputConfig(raw) {
  if (raw == null) return undefined;
  if (!isPlainObject(raw)) throw new Error("input config must be an object with optional height and description");
  const config = {};
  if (own(raw, "height")) {
    if (typeof raw.height !== "number" || !Number.isFinite(raw.height)) {
      throw new Error("input config.height must be a finite number");
    }
    config.height = raw.height;
  }
  if (own(raw, "description")) {
    if (typeof raw.description !== "string") throw new Error("input config.description must be a string");
    config.description = raw.description;
  }
  return Object.keys(config).length ? config : undefined;
}

function storedInputId(node, widget) {
  if (typeof widget?.widgetId === "string" && widget.widgetId) return widget.widgetId;
  return node.id;
}

function formatMissingNode(id, err) {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  return detail && /node/i.test(detail) ? detail : `no node with id ${id}`;
}

/**
 * Parse the command payload. Throws before any graph is touched.
 * Partial updates: omitted fields stay undefined (caller leaves them unchanged).
 */
export function parseAppModeArgs(args = {}) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("graph_configure_app_mode args must be an object");
  }
  const hasInputs = own(args, "inputs");
  const hasOutputs = own(args, "outputs");
  const hasMode = own(args, "default_mode");
  if (!hasInputs && !hasOutputs && !hasMode) {
    throw new Error('provide inputs, outputs, and/or default_mode ("graph" | "app")');
  }

  let inputs;
  if (hasInputs) {
    if (!Array.isArray(args.inputs)) throw new Error("inputs must be an array of { node_id, widget }");
    const seen = new Set();
    inputs = args.inputs.map((item, index) => {
      if (!isPlainObject(item)) throw new Error(`inputs[${index}] must be an object { node_id, widget }`);
      if (!own(item, "node_id")) throw new Error(`inputs[${index}] is missing node_id`);
      if (typeof item.widget !== "string" || !item.widget.trim()) {
        throw new Error(`inputs[${index}] widget must be a non-empty string`);
      }
      const widget = item.widget.trim();
      const key = `${String(item.node_id)}\0${widget}`;
      if (seen.has(key)) throw new Error(`inputs lists node ${item.node_id} widget "${widget}" more than once`);
      seen.add(key);
      return {
        node_id: item.node_id,
        widget,
        config: own(item, "config") ? normalizeInputConfig(item.config) : undefined,
      };
    });
  }

  let outputs;
  if (hasOutputs) {
    if (!Array.isArray(args.outputs)) throw new Error("outputs must be an array of node ids");
    const seen = new Set();
    outputs = args.outputs.map((id, index) => {
      if (id == null || (typeof id !== "number" && typeof id !== "string")) {
        throw new Error(`outputs[${index}] must be a node id`);
      }
      const key = String(id);
      if (seen.has(key)) throw new Error(`outputs lists node ${id} more than once`);
      seen.add(key);
      return id;
    });
  }

  let defaultMode;
  if (hasMode) {
    if (args.default_mode !== "graph" && args.default_mode !== "app") {
      throw new Error('default_mode must be "graph" or "app"');
    }
    defaultMode = args.default_mode;
  }

  return { inputs, outputs, defaultMode };
}

/**
 * Resolve every named node/widget against the live root. Collects ALL failures
 * so a caller sees every unknown id/widget, not just the first.
 */
export function validateAppModeTargets({ rootGraph, resolveNode, inputs, outputs }) {
  if (!rootGraph) throw new Error("root graph is not available");
  if (typeof resolveNode !== "function") throw new Error("resolveNode is required");

  const inputFailures = [];
  const outputFailures = [];
  const resolvedInputs = [];
  const resolvedOutputs = [];

  if (inputs) {
    for (const item of inputs) {
      let node;
      try {
        node = resolveNode(rootGraph, item.node_id);
      } catch (err) {
        inputFailures.push(`node ${item.node_id} (${formatMissingNode(item.node_id, err)})`);
        continue;
      }
      const widget = findNodeWidget(node, item.widget);
      if (!widget) {
        const names = widgetNamesOn(node);
        const listed = names.length ? `widgets: ${names.join(", ")}` : "this node has no widgets";
        inputFailures.push(`node ${node.id} has no widget "${item.widget}" (${listed})`);
        continue;
      }
      resolvedInputs.push({ node, widget, config: item.config });
    }
  }

  if (outputs) {
    for (const id of outputs) {
      let node;
      try {
        node = resolveNode(rootGraph, id);
      } catch (err) {
        outputFailures.push(`${id} (${formatMissingNode(id, err)})`);
        continue;
      }
      resolvedOutputs.push(node);
    }
  }

  if (inputFailures.length || outputFailures.length) {
    const parts = [];
    if (inputFailures.length) parts.push(`unknown App Mode inputs: ${inputFailures.join("; ")}`);
    if (outputFailures.length) parts.push(`unknown App Mode outputs: ${outputFailures.join("; ")}`);
    throw new Error(parts.join(" — "));
  }

  return { resolvedInputs, resolvedOutputs };
}

function extraBag(graph) {
  if (!isPlainObject(graph.extra)) graph.extra = {};
  return graph.extra;
}

function linearDataBag(extra) {
  if (!isPlainObject(extra.linearData)) extra.linearData = { inputs: [], outputs: [] };
  if (!Array.isArray(extra.linearData.inputs)) extra.linearData.inputs = [];
  if (!Array.isArray(extra.linearData.outputs)) extra.linearData.outputs = [];
  return extra.linearData;
}

function toInputTuple(node, widget, config) {
  const id = storedInputId(node, widget);
  return config === undefined ? [id, widget.name] : [id, widget.name, config];
}

/**
 * Merge App Mode fields onto the existing extra object. Never replaces extra
 * and never writes extra.comfyui_mcp.
 */
export function mergeAppModeExtra(extra, { inputTuples, outputIds, defaultMode } = {}) {
  if (!isPlainObject(extra)) throw new Error("extra must be a plain object");
  if (inputTuples !== undefined || outputIds !== undefined) {
    const linearData = linearDataBag(extra);
    if (inputTuples !== undefined) linearData.inputs = inputTuples;
    if (outputIds !== undefined) linearData.outputs = outputIds;
  }
  if (defaultMode !== undefined) extra.linearMode = defaultMode === "app";
  return extra;
}

function snapshotAppMode(extra) {
  const linearData = isPlainObject(extra?.linearData)
    ? {
        inputs: Array.isArray(extra.linearData.inputs) ? extra.linearData.inputs.slice() : [],
        outputs: Array.isArray(extra.linearData.outputs) ? extra.linearData.outputs.slice() : [],
      }
    : { inputs: [], outputs: [] };
  return {
    linearData,
    linearMode: typeof extra?.linearMode === "boolean" ? extra.linearMode : undefined,
  };
}

/**
 * Validate, then write extra.linearData / extra.linearMode on the live root
 * inside one beforeChange/afterChange envelope. captureCanvasState runs AFTER
 * the envelope closes — upstream capture is a silent no-op mid-transaction.
 */
export function configureAppMode({
  rootGraph,
  resolveNode,
  args = {},
  captureCanvasState = null,
  loadSelections = null,
} = {}) {
  const parsed = parseAppModeArgs(args);
  const { resolvedInputs, resolvedOutputs } = validateAppModeTargets({
    rootGraph,
    resolveNode,
    inputs: parsed.inputs,
    outputs: parsed.outputs,
  });

  const inputTuples =
    parsed.inputs !== undefined
      ? resolvedInputs.map(({ node, widget, config }) => toInputTuple(node, widget, config))
      : undefined;
  const outputIds =
    parsed.outputs !== undefined ? resolvedOutputs.map((node) => node.id) : undefined;

  const before = typeof rootGraph.beforeChange === "function" ? rootGraph.beforeChange.bind(rootGraph) : null;
  const after = typeof rootGraph.afterChange === "function" ? rootGraph.afterChange.bind(rootGraph) : null;
  before?.();
  try {
    const extra = extraBag(rootGraph);
    mergeAppModeExtra(extra, {
      inputTuples,
      outputIds,
      defaultMode: parsed.defaultMode,
    });
  } finally {
    after?.();
  }

  try {
    rootGraph.setDirtyCanvas?.(true, true);
  } catch {
    /* redraw is best-effort */
  }

  // Transaction is closed; capture now so ChangeTracker / Ctrl+Z sees extra.
  if (typeof captureCanvasState === "function") {
    try {
      captureCanvasState();
    } catch {
      /* tracker capture is best-effort; dispatch also snapshots after reply */
    }
  }

  const extra = isPlainObject(rootGraph.extra) ? rootGraph.extra : {};
  if (typeof loadSelections === "function") {
    try {
      loadSelections(extra.linearData);
    } catch {
      /* builder store is best-effort; extra is already written */
    }
  }

  const snap = snapshotAppMode(extra);
  return {
    linearData: snap.linearData,
    linearMode: snap.linearMode,
    default_mode: snap.linearMode === true ? "app" : snap.linearMode === false ? "graph" : undefined,
    preserved_meta: isPlainObject(extra[APP_MODE_META_NAMESPACE]),
  };
}
