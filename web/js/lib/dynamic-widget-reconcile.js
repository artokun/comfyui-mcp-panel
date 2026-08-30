const DYNAMIC_COMBO_V3 = "COMFY_DYNAMICCOMBO_V3";
const DYNAMIC_WIDGET_MISSING_RE = /Dynamic widget doesn't exist on node/i;
const GRAPH_TO_PROMPT_RECONCILE = Symbol.for("comfyui-mcp.graphToPromptDynamicReconcile");
const DYNAMIC_COMBO_PRESERVE_CHILDREN = Symbol.for("comfyui-mcp.dynamicComboPreserveChildren");
const rawApply = Reflect.apply;

function hasValueSetter(widget) {
  try {
    let proto = widget;
    while (proto && proto !== Object.prototype) {
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc) return typeof desc.set === "function";
      proto = Object.getPrototypeOf(proto);
    }
    return false;
  } catch {
    return false;
  }
}

function graphNodes(graph) {
  if (Array.isArray(graph?._nodes) && graph._nodes.length) return graph._nodes;
  if (Array.isArray(graph?.nodes)) return graph.nodes;
  return [];
}

function nodeDef(node) {
  return node?.constructor?.nodeData ?? node?.nodeData ?? null;
}

function readWidgetId(widget) {
  try {
    const widgetId = widget?.widgetId;
    return typeof widgetId === "string" && widgetId ? widgetId : null;
  } catch {
    return null;
  }
}

function storeCleanupAlias(dynamicRoot, widgetId, index) {
  return {
    name: `${dynamicRoot}.__cmcp_store_cleanup_${index}`,
    widgetId,
    onRemove() {},
  };
}

function isDynamicComboSpec(spec) {
  return Array.isArray(spec) && spec[0] === DYNAMIC_COMBO_V3;
}

function walkDynamicComboChildren(spec, visit) {
  if (!isDynamicComboSpec(spec)) return;
  const options = spec[1]?.options;
  if (!Array.isArray(options)) return;
  for (const option of options) {
    const inputs = option?.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const group of ["required", "optional"]) {
      const groupInputs = inputs[group];
      if (!groupInputs || typeof groupInputs !== "object") continue;
      for (const [childName, childSpec] of Object.entries(groupInputs)) {
        if (typeof childName !== "string" || !childName) continue;
        visit(childName, childSpec);
        walkDynamicComboChildren(childSpec, visit);
      }
    }
  }
}

function nestedChildNamesByRoot(required) {
  const byRoot = new Map();
  if (!required || typeof required !== "object") return byRoot;
  for (const [name, spec] of Object.entries(required)) {
    if (!isDynamicComboSpec(spec)) continue;
    const children = new Set();
    walkDynamicComboChildren(spec, (childName) => children.add(childName));
    if (children.size) byRoot.set(name, children);
  }
  return byRoot;
}

/**
 * Bare names that exist only as children of a required DynamicCombo.
 *
 * SaveVideo's `codec` is declared under a chosen `format` option, not as its own
 * top-level input. A flattened optional/hidden copy of that child is not a
 * backend-declared row for remove_widget (#1931).
 *
 * @param {object} def
 * @returns {Set<string>}
 */
export function nestedDynamicComboChildNames(def) {
  const nested = new Set();
  const required = def?.input?.required;
  if (!required || typeof required !== "object") return nested;
  for (const children of nestedChildNamesByRoot(required).values()) {
    for (const name of children) nested.add(name);
  }
  return nested;
}

function isInternalRelocationName(name) {
  return typeof name === "string" && name.includes("__cmcp_");
}

function staleDynamicGroup(name, required, dynamicNames) {
  if (typeof name !== "string" || isInternalRelocationName(name)) return null;
  const parts = name.split(".");
  if (parts.length < 2) return null;

  // This is the one schema migration that needs cleanup here: an ordinary current
  // input can retain a dotted child whose path contains a CURRENT dynamic root (the
  // SaveVideo `format.codec` residue when `codec` itself is the required DynamicCombo).
  // The current definition proves both sides of that decision. Do not infer a root
  // from an arbitrary dotted accessor parent.
  const parent = parts[0];
  if (!Object.prototype.hasOwnProperty.call(required, parent) || dynamicNames.has(parent)) {
    return null;
  }
  const dynamicPart = parts.slice(1).find((part) => dynamicNames.has(part));
  return dynamicPart ?? null;
}

function orphanParentRoot(name, nestedByRoot, widgets) {
  if (typeof name !== "string" || isInternalRelocationName(name)) return null;
  const matches = [];
  for (const [root, children] of nestedByRoot) {
    if (name === root || name.startsWith(`${root}.`)) continue;
    const first = name.split(".")[0];
    if (children.has(first)) matches.push(root);
  }
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  const first = name.split(".")[0];
  const withDotted = matches.find((root) =>
    widgets.some((widget) => widget?.name === `${root}.${first}`),
  );
  return withDotted ?? matches[0];
}

function isNestedChildName(name, nestedByRoot) {
  if (typeof name !== "string") return false;
  for (const children of nestedByRoot.values()) {
    if (children.has(name)) return true;
  }
  return false;
}

function capturePrefixedValues(node, rootName) {
  const values = new Map();
  for (const widget of node.widgets ?? []) {
    const name = widget?.name;
    if (typeof name !== "string" || isInternalRelocationName(name)) continue;
    if (!name.startsWith(`${rootName}.`)) continue;
    values.set(name, widget.value);
  }
  return values;
}

function restorePrefixedValues(node, values) {
  if (!values.size) return;
  const byName = new Map(
    (node.widgets ?? [])
      .filter((widget) => typeof widget?.name === "string")
      .map((widget) => [widget.name, widget]),
  );
  const names = [...values.keys()].sort((a, b) => a.split(".").length - b.split(".").length);
  for (const name of names) {
    const widget = byName.get(name);
    if (!widget) continue;
    const next = values.get(name);
    if (widget.value === next) continue;
    try {
      widget.value = next;
    } catch {
      // A restore that the native setter rejects is not a reason to fail the reconcile;
      // the rebuilt child already has the definition's default.
    }
  }
}

function valueDescriptor(widget) {
  try {
    let proto = widget;
    while (proto && proto !== Object.prototype) {
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc) return desc;
      proto = Object.getPrototypeOf(proto);
    }
  } catch {
    /* an unreadable widget is not wrappable */
  }
  return null;
}

/**
 * #2031 — native DynamicCombo value assignment DESTROYS dotted children and
 * recreates them from spec defaults. graphToPrompt re-assigns the parent combo
 * even when the selected option did not change (Vue v-model / serialize flush),
 * so a confirmed `mode.scale` write is rebuilt from `default: 2` after
 * panel_query_graph already showed 1.5.
 *
 * Wrap the setter so a SAME-VALUE assignment restores the live children.
 * Changing the selected option still rebuilds from the new option's spec.
 */
function wrapDynamicComboSetter(node, widget) {
  if (!widget || widget[DYNAMIC_COMBO_PRESERVE_CHILDREN]) return;
  const desc = valueDescriptor(widget);
  if (!desc || typeof desc.set !== "function") return;
  const origSet = desc.set;
  const origGet = typeof desc.get === "function" ? desc.get : null;
  Object.defineProperty(widget, "value", {
    configurable: true,
    enumerable: desc.enumerable !== false,
    get() {
      return origGet ? origGet.call(this) : undefined;
    },
    set(next) {
      let previous;
      try {
        previous = origGet ? origGet.call(this) : undefined;
      } catch {
        previous = undefined;
      }
      const preserved = capturePrefixedValues(node, widget.name);
      origSet.call(this, next);
      if (previous === next) restorePrefixedValues(node, preserved);
    },
  });
  widget[DYNAMIC_COMBO_PRESERVE_CHILDREN] = true;
}

function wrapGraphDynamicComboSetters(graph) {
  for (const node of graphNodes(graph)) {
    try {
      const required = nodeDef(node)?.input?.required;
      const dynamicNames = new Set();
      if (required && typeof required === "object") {
        for (const [name, spec] of Object.entries(required)) {
          if (isDynamicComboSpec(spec)) dynamicNames.add(name);
        }
      }
      for (const widget of node.widgets ?? []) {
        if (typeof widget?.name !== "string") continue;
        const isRoot = dynamicNames.has(widget.name);
        const hasChildren = (node.widgets ?? []).some(
          (candidate) =>
            candidate !== widget &&
            typeof candidate?.name === "string" &&
            candidate.name.startsWith(`${widget.name}.`),
        );
        if ((isRoot || hasChildren) && hasValueSetter(widget)) wrapDynamicComboSetter(node, widget);
      }
      if (node?.subgraph) wrapGraphDynamicComboSetters(node.subgraph);
    } catch {
      /* a hostile node must not block wrapping the rest of the graph */
    }
  }
}

/**
 * Re-run the native value setter for dynamic-combo roots on a newly-created node.
 *
 * COMFY_DYNAMICCOMBO_V3 installs its rebuild logic as an own `value` setter. The
 * constructor runs that setter before `graph.add`, when the widget-value store has no
 * node identity yet. Replaying the same value after registration makes the node's
 * dynamic rows and store state agree.
 *
 * Two schema-verified leftovers are routed through a current dynamic root so the
 * native setter removes them:
 *   - a dotted child of an ordinary current input (`format.codec` when `codec` is
 *     the required DynamicCombo — #2254)
 *   - a bare name that also exists as a nested child of a required DynamicCombo
 *     (`codec` next to `format.codec` when `format` is the required DynamicCombo —
 *     #1931). SaveVideo declares `codec` only under a chosen `format` option; a
 *     top-level `codec` widget is an orphan the queue-time serializer trips on.
 *
 * @param {object} node
 * @param {object} currentDef
 * @returns {{replayed: string[], relocated: string[], failures: Array<{name: string, phase: string, error: unknown}>, cleanupStore: () => {cleaned: boolean, error?: unknown}}}
 */
export function reconcileFreshDynamicWidgets(node, currentDef) {
  const required = currentDef?.input?.required;
  const widgets = Array.isArray(node?.widgets) ? node.widgets.slice() : [];
  const empty = {
    replayed: [],
    relocated: [],
    failures: [],
    cleanupStore: () => ({ cleaned: true }),
  };
  if (!required || typeof required !== "object" || !widgets.length) return empty;

  const dynamicNames = new Set(
    Object.entries(required)
      .filter(([, spec]) => isDynamicComboSpec(spec))
      .map(([name]) => name),
  );
  if (!dynamicNames.size) return empty;

  const nestedByRoot = nestedChildNamesByRoot(required);
  const byName = new Map(
    widgets
      .filter((widget) => typeof widget?.name === "string")
      .map((widget) => [widget.name, widget]),
  );
  const roots = new Set();
  const relocated = [];
  const failures = [];
  const relocatedWidgets = new Set();

  let relocationIndex = 0;
  const relocationByName = new Map();

  const relocateInto = (widget, dynamicRoot) => {
    const oldName = widget.name;
    const oldWidgetId = readWidgetId(widget);
    let replacement = relocationByName.get(oldName);
    if (!replacement) {
      replacement = `${dynamicRoot}.__cmcp_stale_${relocationIndex++}`;
      relocationByName.set(oldName, replacement);
    }
    try {
      widget.name = replacement;
      relocatedWidgets.add(widget);
      // Current LiteGraph widgets derive widgetId from name. graph.add() already
      // registered the old key, so renaming alone leaves that key behind and the
      // native setter would delete only the newly-derived key. Re-register the
      // renamed widget, then give native cleanup an alias carrying the original
      // key so both registrations are deleted by deleteWidget().
      if (oldWidgetId) {
        node.widgets.push(storeCleanupAlias(dynamicRoot, oldWidgetId, relocationIndex++));
      }
      if (typeof widget.setNodeId === "function" && node?.id != null) {
        widget.setNodeId(node.id);
      }
      relocated.push(oldName);
    } catch (error) {
      failures.push({ name: oldName, phase: "relocate", error });
    }
  };

  // A current dynamic root is the only accessor we are authorized to replay. Before
  // doing so, move a schema-verified leftover into that root's native group. This
  // lets the native setter call its own onRemove/widget-store deletion logic; simply
  // filtering node.widgets would leave a stale store entry behind.
  for (const widget of widgets) {
    const dynamicRoot = staleDynamicGroup(widget?.name, required, dynamicNames);
    if (!dynamicRoot) continue;
    relocateInto(widget, dynamicRoot);
  }
  for (const widget of widgets) {
    if (relocatedWidgets.has(widget)) continue;
    const dynamicRoot = orphanParentRoot(widget?.name, nestedByRoot, node.widgets ?? widgets);
    if (!dynamicRoot) continue;
    relocateInto(widget, dynamicRoot);
  }
  if (Array.isArray(node.inputs)) {
    for (const input of node.inputs) {
      const replacement = relocationByName.get(input?.name);
      if (replacement) input.name = replacement;
    }
  }

  // Current dynamic declarations must be replayed even when they have no stale rows.
  // A required name that is only a nested child of another required DynamicCombo is
  // the orphan we just relocated, not a missing root.
  for (const name of dynamicNames) {
    const widget = byName.get(name);
    if (!widget || relocatedWidgets.has(widget) || widget.name !== name) {
      if (isNestedChildName(name, nestedByRoot)) continue;
      if (!widget) {
        failures.push({ name, phase: "missing-root", error: new Error("dynamic widget root is missing") });
      }
      continue;
    }
    if (!hasValueSetter(widget)) {
      failures.push({ name, phase: "missing-setter", error: new Error("dynamic widget value setter is missing") });
      continue;
    }
    roots.add(widget);
  }

  const replayed = [];
  for (const widget of widgets) {
    if (!roots.has(widget) || !node.widgets.includes(widget) || !hasValueSetter(widget)) {
      continue;
    }
    const preserved = capturePrefixedValues(node, widget.name);
    try {
      const value = widget.value;
      widget.value = value;
      replayed.push(widget.name);
      restorePrefixedValues(node, preserved);
    } catch (error) {
      failures.push({ name: widget.name, phase: "setter", error });
    }
  }

  const cleanupStore = () => {
    const root = roots.values().next().value;
    if (!root) {
      return { cleaned: false, error: new Error("no verified dynamic root can clean widget-store entries") };
    }

    const widgetIds = new Set();
    for (const widget of node.widgets ?? []) {
      const widgetId = readWidgetId(widget);
      if (widgetId) widgetIds.add(widgetId);
    }
    const aliases = [];
    let aliasIndex = 0;
    for (const widgetId of widgetIds) {
      const alias = storeCleanupAlias(root.name, widgetId, `rollback_${aliasIndex++}`);
      aliases.push(alias);
      node.widgets.push(alias);
    }
    try {
      const value = root.value;
      root.value = value;
      const remaining = aliases.filter((alias) => node.widgets.includes(alias));
      return remaining.length
        ? { cleaned: false, error: new Error("native dynamic cleanup left widget-store aliases attached") }
        : { cleaned: true };
    } catch (error) {
      return { cleaned: false, error };
    }
  };

  return { replayed, relocated, failures, cleanupStore };
}

/**
 * Apply {@link reconcileFreshDynamicWidgets} to every node on a loaded graph.
 *
 * add_node and load share this materialiser: SaveVideo's nested `format.codec`
 * must exist and a bare orphan `codec` must not, whether the node was just
 * created or restored from a saved workflow.
 *
 * Failures are recorded per node and never thrown — a load of a 30-node graph
 * must not abort because one SaveVideo leftover could not be cleaned.
 *
 * @param {object} graph
 * @returns {Array<object>}
 */
export function reconcileGraphDynamicWidgets(graph) {
  const nodes = graphNodes(graph);
  const results = [];
  for (const node of nodes) {
    try {
      const def = nodeDef(node);
      if (def) results.push(reconcileFreshDynamicWidgets(node, def));
      if (node?.subgraph) results.push(...reconcileGraphDynamicWidgets(node.subgraph));
    } catch (error) {
      results.push({
        replayed: [],
        relocated: [],
        failures: [{ name: String(node?.type ?? node?.id ?? "node"), phase: "graph", error }],
        cleanupStore: () => ({ cleaned: false, error }),
      });
    }
  }
  return results;
}

export function isDynamicWidgetMissingError(error) {
  let raw = "";
  try {
    raw = error instanceof Error ? error.message : String(error ?? "");
  } catch {
    return false;
  }
  return DYNAMIC_WIDGET_MISSING_RE.test(raw);
}

/**
 * Nodes that still carry a schema-verified DynamicCombo orphan (bare `codec`
 * next to `format.codec` on SaveVideo). Used to name the serializer throw.
 *
 * @param {object} graph
 * @returns {Array<{nodeId: unknown, nodeType: string, orphan: string, nested: string}>}
 */
export function describeOrphanDynamicWidgets(graph) {
  const found = [];
  for (const node of graphNodes(graph)) {
    try {
      const required = nodeDef(node)?.input?.required;
      const nestedByRoot = nestedChildNamesByRoot(required);
      if (!nestedByRoot.size) {
        if (node?.subgraph) found.push(...describeOrphanDynamicWidgets(node.subgraph));
        continue;
      }
      const widgets = Array.isArray(node.widgets) ? node.widgets : [];
      const names = new Set();
      for (const widget of widgets) {
        if (typeof widget?.name === "string") names.add(widget.name);
      }
      for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
        if (typeof input?.name === "string") names.add(input.name);
      }
      for (const name of names) {
        const root = orphanParentRoot(name, nestedByRoot, widgets);
        if (!root) continue;
        found.push({
          nodeId: node.id,
          nodeType: typeof node.type === "string" ? node.type : "node",
          orphan: name,
          nested: `${root}.${name.split(".")[0]}`,
        });
      }
      if (node?.subgraph) found.push(...describeOrphanDynamicWidgets(node.subgraph));
    } catch {
      // A hostile node must not hide the rest of the graph.
    }
  }
  return found;
}

function namedDynamicWidgetError(error, graph) {
  const candidates = describeOrphanDynamicWidgets(graph);
  let base = "";
  try {
    base = error instanceof Error ? error.message : String(error ?? "");
  } catch {
    base = "";
  }
  if (!candidates.length) {
    return error instanceof Error ? error : new Error(base || "Dynamic widget doesn't exist on node");
  }
  const listed = candidates
    .slice(0, 8)
    .map((entry) => `${entry.nodeType} node ${entry.nodeId} has ${entry.nested} and orphan ${entry.orphan}`)
    .join("; ");
  const extra = candidates.length > 8 ? ` (${candidates.length - 8} more)` : "";
  const message =
    DYNAMIC_WIDGET_MISSING_RE.test(base) && !/\bnode\s+\d+/i.test(base)
      ? `Dynamic widget doesn't exist on node: ${listed}${extra}`
      : `${base} (${listed}${extra})`;
  const named = new Error(message);
  if (error instanceof Error) named.cause = error;
  return named;
}

/**
 * Reconcile nested DynamicCombo leftovers immediately before every prompt build,
 * and retry once if the frontend still throws the unnamed SaveVideo serializer
 * error. add_node/load already clean what they can; 0.15.124 recurrences still
 * queued a graph that grew the orphan back (set_widget, restore, restart).
 *
 * @param {object} app
 * @returns {boolean}
 */
export function installGraphToPromptDynamicReconcile(app) {
  if (!app || typeof app.graphToPrompt !== "function") return false;
  if (app[GRAPH_TO_PROMPT_RECONCILE]) return true;
  const graphToPromptFn = app.graphToPrompt;
  const orig = (...args) => rawApply(graphToPromptFn, app, args);
  app.graphToPrompt = function reconcileThenGraphToPrompt(graph, ...rest) {
    const target = graph ?? app.rootGraph ?? app.graph ?? null;
    try {
      // #2031 — wrap before native serialize: graphToPrompt re-assigns DynamicCombo
      // roots, which would otherwise rebuild dotted children from spec defaults.
      wrapGraphDynamicComboSetters(target);
      reconcileGraphDynamicWidgets(target);
    } catch {
      // Best-effort: a hostile node must not block serialization.
    }
    const retry = (error) => {
      if (!isDynamicWidgetMissingError(error)) throw error;
      try {
        wrapGraphDynamicComboSetters(target);
        reconcileGraphDynamicWidgets(target);
      } catch {
        // Retry with whatever state we could clean.
      }
      try {
        const retried = orig(graph, ...rest);
        if (retried && typeof retried.then === "function") {
          return Promise.resolve(retried).then(
            (value) => value,
            (retryError) => {
              throw namedDynamicWidgetError(retryError, target);
            },
          );
        }
        return retried;
      } catch (retryError) {
        throw namedDynamicWidgetError(retryError, target);
      }
    };
    try {
      const result = orig(graph, ...rest);
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).then((value) => value, retry);
      }
      return result;
    } catch (error) {
      return retry(error);
    }
  };
  app[GRAPH_TO_PROMPT_RECONCILE] = true;
  return true;
}
