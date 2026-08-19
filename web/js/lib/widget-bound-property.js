// A widget that LiteGraph binds to one of its node's own properties (#1268, comfyui-mcp#1658).
//
// THE DEFECT THIS EXISTS FOR. `applyWidgetWrite` decided every write by assigning
// `w.value` and then reading `w.value` back. For a widget whose real state lives
// somewhere else, that read is a TAUTOLOGY: it confirms the assignment, never the
// effect. Two reports of the same shape — a clean success followed by the OLD value
// on the next read, and by a render built from the old value.
//
// LiteGraph gives one such "somewhere else" a FIRST-PARTY, DECLARED name, and this
// module is scoped to exactly that one. A widget may carry `options.property`, the
// name of an entry in its own node's `properties` map. The two stores are kept in
// step by litegraph itself, in BOTH directions:
//
//   `BaseWidget.setValue` (widgets/BaseWidget.ts — the INTERACTIVE edit path):
//
//       this.value = v
//       if (this.options?.property && node.properties[this.options.property] !== undefined) {
//         node.setProperty(this.options.property, v)
//       }
//       this.callback?.(this.value, canvas, node, pos, e)
//
//   `LGraphNode.setProperty` (LGraphNode.ts — the reverse leg):
//
//       this.properties[name] = value
//       if (this.onPropertyChanged?.(name, value, prev_value) === false)
//         this.properties[name] = prev_value
//       for (const w of this.widgets) if (w.options.property == name) { w.value = value; break }
//
// Read together those two say the thing that matters here. A bare `w.value = x`
// assignment — which is what a programmatic write does — updates ONE of the two
// stores. `node.properties[p]` keeps the old value, and the NEXT `setProperty` on
// that node pushes the old value straight back into `w.value`. The write reads back
// clean at write time and is gone by the next read: the reported symptom exactly.
//
// WHY THIS IS NOT THE GUESS #698 REFUSED. `describeNonValueBearingWidget` deliberately
// lists a node's property NAMES and refuses to say which one backs a given widget,
// because pairing them by name similarity would eventually point a write at unrelated
// node state. Nothing is paired here: `options.property` IS the name, declared by the
// node's own author, and it is the same field litegraph reads. Where a widget declares
// no `options.property`, this module returns null and the write path is untouched.
//
// SCOPE, and what is deliberately left alone:
//   * The WRITTEN widget on the node the write landed on. A promoted subgraph rail is
//     a projection built by the subgraph machinery rather than an `addWidget(…, "prop")`
//     binding, and #366/#477 already verify it against its own store.
//   * `node.properties[p] === undefined` is NOT bound. That is litegraph's OWN condition
//     in `BaseWidget.setValue`: with the property absent, an interactive edit syncs
//     nothing either, so there is no second store and nothing to report.
//   * Nothing here invokes a serializer, an options provider, or any other pack callback
//     to find out what is true. `setProperty` is called on the WRITE path only, which is
//     the same call an interactive edit makes.

/**
 * The property name this widget is bound to, or null.
 *
 * Read defensively: `options` may be absent on a hand-built widget, and a pack may
 * install a throwing accessor. An unreadable binding is reported as NO binding, which
 * leaves the write path exactly as it was rather than inventing a target for it.
 *
 * @param {unknown} widget
 * @returns {string|null}
 */
export function boundPropertyName(widget) {
  try {
    const opts = widget && typeof widget === "object" ? widget.options : null;
    if (!opts || typeof opts !== "object") return null;
    const name = opts.property;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Classify the binding between `widget` and `node`, WITHOUT touching either store.
 *
 * Returns null when there is no second store to keep in step — no declared property,
 * or the node does not carry that property (litegraph's own condition). Otherwise:
 *
 *   { property, reachable: true,  previous }   sync it, then verify it stuck
 *   { property, reachable: false, reason }     the store exists and cannot be reached
 *                                              from here — report UNKNOWN, never refuse
 *
 * The unreachable case is the point. The node declares the property, so the value the
 * node reads is NOT the one we can see through `w.value`; but with no `setProperty` we
 * can neither drive it nor read the effect back. Saying "success" there is the same
 * false claim this module exists to remove, and refusing would block a write that may
 * well be fine. Unknown is the only honest third answer.
 *
 * @param {unknown} node
 * @param {unknown} widget
 * @returns {{property: string, reachable: boolean, previous?: unknown, reason?: string}|null}
 */
export function boundPropertyState(node, widget) {
  const property = boundPropertyName(widget);
  if (!property) return null;
  let props;
  try {
    props = node && typeof node === "object" ? node.properties : undefined;
  } catch {
    return { property, reachable: false, reason: "reading the node's `properties` threw" };
  }
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  let previous;
  try {
    previous = props[property];
  } catch {
    return { property, reachable: false, reason: "reading the bound property threw" };
  }
  // litegraph's own guard: an ABSENT property is not a second store, and an
  // interactive edit does not create one either.
  if (previous === undefined) return null;
  let hasSetter = false;
  try {
    hasSetter = typeof node.setProperty === "function";
  } catch {
    hasSetter = false;
  }
  if (!hasSetter) {
    return {
      property,
      reachable: false,
      reason: "the node exposes no `setProperty`, so the bound property cannot be driven the way an on-canvas edit drives it",
    };
  }
  return { property, reachable: true, previous };
}

/**
 * The failure text for a bound property that did NOT take the written value.
 *
 * Mirrors the #366 rail wording, because it is the same class of fact: a second store
 * that the node reads is holding a DIFFERENT value from the one just written, so a
 * success here would be a success for a value the node is about to overwrite.
 *
 * States only what was observed — the two values, and that litegraph pushes the
 * property back into the widget. It does NOT claim to know WHY the node refused it;
 * `onPropertyChanged` returning false is the documented way, but a property accessor
 * or a later hook can produce the same observation.
 */
export function boundPropertyFailure({ property, widgetName, nodeId, expected, actual, unreadable }) {
  // An unreadable property is reported as unreadable, never rendered as a value. A
  // throwing accessor and a property genuinely holding `undefined` are different facts,
  // and JSON.stringify collapses both to the same text.
  const observed = unreadable ? "unreadable (reading it threw)" : `${JSON.stringify(actual)}`;
  return (
    `Widget "${widgetName}" on node ${nodeId} is bound to that node's own property ` +
    `"${property}" (\`options.property\`), and the property did not take the requested ` +
    `value: wrote ${JSON.stringify(expected)} but it is ${observed}. ` +
    `LiteGraph copies that property back into the widget on the next \`setProperty\`, so ` +
    `reporting success here would report a value the node is about to replace with the ` +
    `old one. Rolled back.`
  );
}

/**
 * The UNKNOWN note for a bound property that could not be reached.
 *
 * Carried on an otherwise-successful result, next to a structured field, so a caller
 * can tell "verified" from "assigned, effect not established" without reading prose.
 */
export function boundPropertyUnverifiedNote({ property, widgetName, nodeId, reason }) {
  return (
    `The write to "${widgetName}" on node ${nodeId} was applied and read back, but this ` +
    `widget is bound to the node's own property "${property}" (\`options.property\`) and ` +
    `${reason}. The panel therefore CANNOT establish whether the value the node reads has ` +
    `changed — the widget's stored value is what was verified, not the bound property. ` +
    `Read the property with panel_query_graph, and set it with panel_set_property if it ` +
    `still holds the old value.`
  );
}
