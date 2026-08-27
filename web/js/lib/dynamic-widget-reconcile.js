const DYNAMIC_COMBO_V3 = "COMFY_DYNAMICCOMBO_V3";

function hasValueSetter(widget) {
  try {
    return typeof Object.getOwnPropertyDescriptor(widget, "value")?.set === "function";
  } catch {
    return false;
  }
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
  for (const [name, spec] of Object.entries(required)) {
    if (!isDynamicComboSpec(spec)) continue;
    const children = new Set();
    walkDynamicComboChildren(spec, (childName) => children.add(childName));
    if (children.size) byRoot.set(name, children);
  }
  return byRoot;
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
  const nodes = Array.isArray(graph?._nodes) ? graph._nodes : [];
  const results = [];
  for (const node of nodes) {
    try {
      const def = node?.constructor?.nodeData;
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
