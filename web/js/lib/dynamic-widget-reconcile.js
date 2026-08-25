const DYNAMIC_COMBO_V3 = "COMFY_DYNAMICCOMBO_V3";

function hasValueSetter(widget) {
  try {
    return typeof Object.getOwnPropertyDescriptor(widget, "value")?.set === "function";
  } catch {
    return false;
  }
}

/**
 * Re-run the native value setter for dynamic-combo roots on a newly-created node.
 *
 * COMFY_DYNAMICCOMBO_V3 installs its rebuild logic as an own `value` setter. The
 * constructor runs that setter before `graph.add`, when the widget-value store has no
 * node identity yet. Replaying the same value after registration makes the node's
 * dynamic rows and store state agree. Dotted widget names also identify a stale dynamic
 * root (for example `format.codec`) that is no longer present in the current definition.
 *
 * @param {object} node
 * @param {object} currentDef
 * @returns {string[]} names of roots that were replayed
 */
export function reconcileFreshDynamicWidgets(node, currentDef) {
  const required = currentDef?.input?.required;
  const widgets = Array.isArray(node?.widgets) ? node.widgets.slice() : [];
  if (!required || typeof required !== "object" || !widgets.length) return [];

  const dynamicNames = new Set(
    Object.entries(required)
      .filter(([, spec]) => Array.isArray(spec) && spec[0] === DYNAMIC_COMBO_V3)
      .map(([name]) => name),
  );
  if (!dynamicNames.size) return [];

  const byName = new Map(
    widgets
      .filter((widget) => typeof widget?.name === "string")
      .map((widget) => [widget.name, widget]),
  );
  const roots = new Set();

  // Current dynamic declarations must be replayed even when they have no stale rows.
  for (const name of dynamicNames) {
    const widget = byName.get(name);
    if (widget) roots.add(widget);
  }

  // A stale dynamic declaration can leave a dotted child behind while its parent is no
  // longer described by currentDef. Replaying an accessor-bearing parent lets the
  // frontend's own rebuild remove that child without guessing at its input shape.
  for (const widget of widgets) {
    const name = widget?.name;
    if (typeof name !== "string") continue;
    const dot = name.indexOf(".");
    if (dot <= 0) continue;
    const parent = byName.get(name.slice(0, dot));
    if (parent && hasValueSetter(parent)) roots.add(parent);
  }

  const replayed = [];
  for (const widget of widgets) {
    if (
      !roots.has(widget) ||
      !node.widgets.includes(widget) ||
      !hasValueSetter(widget)
    ) {
      continue;
    }
    try {
      const value = widget.value;
      widget.value = value;
      replayed.push(widget.name);
    } catch {
      // A custom accessor remains responsible for its own failure; do not turn an
      // otherwise successful node add into a second, unrelated refusal.
    }
  }
  return replayed;
}
