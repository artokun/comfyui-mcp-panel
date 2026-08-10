/**
 * #983 — did a widget write reach the state the node actually SAVES?
 *
 * `panel_set_widget` on rgthree's Fast Groups Bypasser reported success and the value
 * reverted moments later. MEASURED on ComfyUI 0.31.1 / frontend 1.48.7:
 *
 *   before                     {"toggled":true}
 *   write                      reports {"toggled":false}, no warning
 *   read back immediately      {"toggled":false}      <- verification legitimately passes
 *   after rgthree rebuilds     {"toggled":true}       <- reverted
 *   target node .mode          unchanged throughout   <- nothing was bypassed
 *
 * The read-back check is NOT at fault: when it looked, the value really was `false`.
 * That widget is a VIEW which the node regenerates from live group state, so the
 * write lands on a copy that is about to be thrown away.
 *
 * THE SIGNAL, and why it is this one. Both of these are rgthree, `type: "custom"`,
 * and composite objects — so neither widget type, nor compositeness, nor authorship
 * separates them:
 *
 *   Power Lora Loader  `lora_1`                 -> IS in serialize().widgets_values
 *   Fast Groups Bypasser `RGTHREE_TOGGLE_AND_NAV` -> node serializes NO widgets_values
 *   KSampler `steps` (control)                  -> IS in serialize().widgets_values
 *
 * What separates them is the node's own serialization, which is the direct form of
 * the question that matters: will this write still exist after a save, a reload, or a
 * queue? Asked of the node itself, with no node-specific methods and no allowlist of
 * pack names to maintain.
 *
 * DISCLOSURE, NOT REFUSAL. A write that does not serialize can still have run the
 * widget's callback and done something real — a button-style widget is the obvious
 * case — so refusing outright would break writes whose whole purpose is the side
 * effect. What is certainly wrong is reporting a plain success for a value that
 * cannot reach the saved workflow or the queued prompt, so that is what this changes.
 */

/**
 * Read the node's own serialized widget values, defensively.
 *
 * Returns `{ readable, values }`. `readable` is false when the node cannot be
 * serialized at all — a diagnostic must never turn a working write into an error, so
 * an unreadable node yields no claim rather than a failure.
 */
export function readSerializedWidgetValues(node) {
  try {
    if (!node || typeof node.serialize !== "function") return { readable: false, values: null };
    const serialized = node.serialize();
    if (!serialized || typeof serialized !== "object") return { readable: false, values: null };
    const values = serialized.widgets_values;
    // A node with NO `widgets_values` key serializes no widget state at all — that is
    // the measured Fast Groups Bypasser shape, and it is a real answer, not a failure
    // to read. `null` values with the key present is treated the same way.
    if (values === undefined || values === null) return { readable: true, values: [] };
    if (Array.isArray(values)) return { readable: true, values };
    // Some nodes serialize an OBJECT keyed by widget name rather than a positional
    // array. Both shapes are handled by the caller; hand it through as-is.
    if (typeof values === "object") return { readable: true, values };
    return { readable: false, values: null };
  } catch {
    return { readable: false, values: null };
  }
}

/**
 * Is `expected` present in what the node serializes for `widgetName`?
 *
 * Returns one of:
 *   "present"      — the value reached the node's saved state
 *   "absent"       — the node serializes widget state, and this value is not in it
 *   "unknown"      — the node could not be serialized, or the widget's position could
 *                    not be established; no claim is made
 *
 * Matching is deliberately loose about POSITION and strict about VALUE. Widget index
 * and serialized index do not always line up — a node can skip non-serializing
 * widgets — so this asks whether the value appears at the widget's index OR anywhere
 * in the serialized values. Being wrong about the position would produce a false
 * "absent" on a healthy write, which is the expensive direction here.
 */
export function serializedWidgetValueState(node, widgetName, expected) {
  const { readable, values } = readSerializedWidgetValues(node);
  if (!readable) return "unknown";
  const sameValue = (candidate) => {
    if (Object.is(candidate, expected)) return true;
    // Composite widgets serialize as objects; compare by content, since the
    // serialized copy is not the same reference as the live one.
    try {
      return JSON.stringify(candidate) === JSON.stringify(expected);
    } catch {
      return false;
    }
  };
  // Object-keyed shape: ask for this widget by name.
  if (!Array.isArray(values)) {
    try {
      if (!Object.prototype.hasOwnProperty.call(values, widgetName)) return "unknown";
      return sameValue(values[widgetName]) ? "present" : "absent";
    } catch {
      return "unknown";
    }
  }
  // Positional shape. An EMPTY list from a node that has widgets is the measured
  // "serializes nothing" case, and it is a definite absent — that node cannot save
  // any widget value.
  let widgetCount = 0;
  try {
    widgetCount = Array.isArray(node?.widgets) ? node.widgets.length : 0;
  } catch {
    widgetCount = 0;
  }
  if (values.length === 0) return widgetCount > 0 ? "absent" : "unknown";
  try {
    if (values.some(sameValue)) return "present";
  } catch {
    return "unknown";
  }
  return "absent";
}

/**
 * The disclosure for a write that verified in memory but is not in the node's saved
 * state. Says what was established and what it means, without asserting a cause the
 * mechanism cannot see (which widget owns the value, or why the node drops it).
 */
export function notPersistedNote(widgetName, nodeType) {
  return (
    `The value was written and read back on the live widget, but it is NOT in what this ` +
    `node serializes, so it will not survive a save, a reload, or a queue — and any node ` +
    `that rebuilds this widget from its own state will overwrite it. Established by ` +
    `serializing node ${nodeType ?? "(unknown type)"} after the write and looking for the ` +
    `value: "${widgetName}" is not there. This happens with widgets that are a VIEW of ` +
    `state kept elsewhere (measured on rgthree's Fast Groups Bypasser, whose toggle ` +
    `reflects group bypass state rather than storing it, #983). If this widget is a ` +
    `control surface, drive the underlying state instead — for a group bypass toggle, ` +
    `set the target nodes' mode directly. Read the node back with panel_query_graph to ` +
    `see what it actually holds.`
  );
}
