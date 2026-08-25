const DYNAMIC_COMBO_V3 = "COMFY_DYNAMICCOMBO_V3";

function hasValueSetter(widget) {
  try {
    return typeof Object.getOwnPropertyDescriptor(widget, "value")?.set === "function";
  } catch {
    return false;
  }
}

function staleDynamicGroup(name, required, dynamicNames) {
  if (typeof name !== "string") return null;
  const parts = name.split(".");
  if (parts.length < 2) return null;

  // This is the one schema migration that needs cleanup here: an ordinary current
  // input can retain a dotted child whose path contains a CURRENT dynamic root (the
  // SaveVideo `format.codec` residue). The current definition proves both sides of
  // that decision. Do not infer a root from an arbitrary dotted accessor parent.
  const parent = parts[0];
  if (!Object.prototype.hasOwnProperty.call(required, parent) || dynamicNames.has(parent)) {
    return null;
  }
  const dynamicPart = parts.slice(1).find((part) => dynamicNames.has(part));
  return dynamicPart ?? null;
}

/**
 * Re-run the native value setter for dynamic-combo roots on a newly-created node.
 *
 * COMFY_DYNAMICCOMBO_V3 installs its rebuild logic as an own `value` setter. The
 * constructor runs that setter before `graph.add`, when the widget-value store has no
 * node identity yet. Replaying the same value after registration makes the node's
 * dynamic rows and store state agree. A schema-verified legacy dotted path (for
 * example `format.codec`) is temporarily placed in the current dynamic root's group
 * so the native setter removes it through the frontend's normal widget/store cleanup.
 *
 * @param {object} node
 * @param {object} currentDef
 * @returns {{replayed: string[], relocated: string[], failures: Array<{name: string, phase: string, error: unknown}>}}
 */
export function reconcileFreshDynamicWidgets(node, currentDef) {
  const required = currentDef?.input?.required;
  const widgets = Array.isArray(node?.widgets) ? node.widgets.slice() : [];
  const empty = { replayed: [], relocated: [], failures: [] };
  if (!required || typeof required !== "object" || !widgets.length) return empty;

  const dynamicNames = new Set(
    Object.entries(required)
      .filter(([, spec]) => Array.isArray(spec) && spec[0] === DYNAMIC_COMBO_V3)
      .map(([name]) => name),
  );
  if (!dynamicNames.size) return empty;

  const byName = new Map(
    widgets
      .filter((widget) => typeof widget?.name === "string")
      .map((widget) => [widget.name, widget]),
  );
  const roots = new Set();
  const relocated = [];
  const failures = [];

  // A current dynamic root is the only accessor we are authorized to replay. Before
  // doing so, move a schema-verified legacy child into that root's native group. This
  // lets the native setter call its own onRemove/widget-store deletion logic; simply
  // filtering node.widgets would leave a stale store entry behind.
  let relocationIndex = 0;
  const relocationByName = new Map();
  for (const widget of widgets) {
    const dynamicRoot = staleDynamicGroup(widget?.name, required, dynamicNames);
    if (!dynamicRoot) continue;
    const oldName = widget.name;
    let replacement = relocationByName.get(oldName);
    if (!replacement) {
      replacement = `${dynamicRoot}.__cmcp_stale_${relocationIndex++}`;
      relocationByName.set(oldName, replacement);
    }
    try {
      widget.name = replacement;
      relocated.push(oldName);
    } catch (error) {
      failures.push({ name: oldName, phase: "relocate", error });
    }
  }
  if (Array.isArray(node.inputs)) {
    for (const input of node.inputs) {
      const replacement = relocationByName.get(input?.name);
      if (replacement) input.name = replacement;
    }
  }

  // Current dynamic declarations must be replayed even when they have no stale rows.
  for (const name of dynamicNames) {
    const widget = byName.get(name);
    if (!widget) {
      failures.push({ name, phase: "missing-root", error: new Error("dynamic widget root is missing") });
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
    try {
      const value = widget.value;
      widget.value = value;
      replayed.push(widget.name);
    } catch (error) {
      failures.push({ name: widget.name, phase: "setter", error });
    }
  }
  return { replayed, relocated, failures };
}
