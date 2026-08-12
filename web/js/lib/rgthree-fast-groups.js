// #983 — rgthree's Fast Groups Muter/Bypasser toggle is DERIVED, and a widget write to it
// cannot take effect. Refused loudly rather than reported as a success that silently reverts.
//
// The reported shape: `panel_set_widget` on `RGTHREE_TOGGLE_AND_NAV.toggled = false` returned
// a clean success showing `{"toggled": false}`, and the very next `panel_query_graph` showed
// `{"toggled": true}` again, with the target node still active.
//
// THREE FACTS FROM THE PACK'S OWN SOURCE (rgthree-comfy `src_web/comfyui/`), any one of which
// is enough on its own — this is not inferred from the report:
//
//  1. `BaseFastGroupsModeChanger` sets `override serialize_widgets = false`
//     (fast_groups_muter.ts). Both Muter and Bypasser extend it, so these nodes NEVER
//     serialize widget values into the workflow. A write cannot persist even in principle.
//
//  2. The node's own refresh loop OVERWRITES the value from the live graph:
//
//         if (group.rgthree_hasAnyActiveNode != null &&
//             widget.toggled != group.rgthree_hasAnyActiveNode) {
//           widget.toggled = group.rgthree_hasAnyActiveNode;
//         }
//
//     `toggled` REPORTS whether the matched group currently has an active node. It is a
//     readout, not a setting, so a raw write is reverted on the next refresh tick.
//
//  3. The only path that changes anything is the widget's own `toggle()`:
//
//         toggle(value) {
//           if (value !== this.toggled) { this.value.toggled = value; this.doModeChange(); }
//         }
//
//     `doModeChange()` is what actually mutes/bypasses the group's nodes. Assigning
//     `widget.value.toggled` directly — which is what a widget write does — skips it, so no
//     node mode changes and there is nothing for the readout to keep.
//
// So the value the caller sees in the reply is real for an instant and means nothing. That is
// precisely the silent-success shape `panel_set_widget` must not produce.
//
// WHY A REFUSAL AND NOT A ROUTE. The natural next step is to drive the node's own `toggle()`,
// the way the LTXDirector route drives `_applyLoadedTimeline` (#314). That is better UX and it
// is deliberately NOT done here: `toggle()` calls `doModeChange()`, which mutates the MODE OF
// EVERY NODE in the matched group — a much larger effect than "set a widget" — and this issue
// has already been reverted twice for shipping ahead of what could be verified. Refusing costs
// the caller one tool call and cannot corrupt a graph; routing wrongly can. The route is worth
// revisiting once it can be exercised against a live canvas.
//
// A SECOND reason a write here is unsound, worth stating because it survives any pack change:
// these nodes carry ONE `RGTHREE_TOGGLE_AND_NAV` widget PER MATCHED GROUP, all sharing that
// name and distinguished only by `label`. Addressing one by name is ambiguous whenever more
// than one group matches, so even a working write could not say which group it meant.
//
// Dependency-free (no DOM, no LiteGraph). Unit-testable with plain fixtures.

/** The rgthree node types whose toggle rows are derived readouts. `addRgthree()` in the pack's
 *  constants.ts appends " (rgthree)" to every name, which is what reaches `node.type`. */
const FAST_GROUPS_TYPES = new Set(["Fast Groups Muter (rgthree)", "Fast Groups Bypasser (rgthree)"]);

/** The widget name the pack gives every toggle row. */
export const RGTHREE_TOGGLE_WIDGET = "RGTHREE_TOGGLE_AND_NAV";

/** The base widget name a request addresses, with any composite sub-field removed:
 *  `"RGTHREE_TOGGLE_AND_NAV.toggled"` and `"RGTHREE_TOGGLE_AND_NAV"` both name the same widget. */
function baseWidgetName(widgetName) {
  if (typeof widgetName !== "string") return "";
  const dot = widgetName.indexOf(".");
  return dot === -1 ? widgetName : widgetName.slice(0, dot);
}

/**
 * `"derived"` when this write targets a Fast Groups toggle row, else null.
 *
 * Keyed on BOTH the node type and the widget name, deliberately. Either alone would be
 * wrong: the type alone would refuse a legitimate write to some other widget these nodes may
 * gain, and the widget name alone would refuse it on an unrelated node that happens to reuse
 * the name. Anything else on these nodes is untouched, exactly as it is today.
 *
 * @param {{type?: unknown}} node
 * @param {unknown} widgetName
 * @returns {"derived"|null}
 */
export function classifyRgthreeFastGroupsWrite(node, widgetName) {
  const type = node && typeof node === "object" ? node.type : undefined;
  if (typeof type !== "string" || !FAST_GROUPS_TYPES.has(type)) return null;
  return baseWidgetName(widgetName) === RGTHREE_TOGGLE_WIDGET ? "derived" : null;
}

/**
 * The refusal. Names what the widget actually is, why the write cannot land, and the remedy
 * the reporter verified themselves — set the group's node modes directly, which is not a
 * workaround but the mechanism the toggle merely reports on.
 */
export function rgthreeFastGroupsRefusal(widgetName, nodeId, nodeType) {
  return (
    `panel_set_widget cannot drive "${widgetName}" on ${nodeType} node ${nodeId}: the toggle row ` +
    `is a DERIVED READOUT of whether its matched group currently has an active node, not a stored ` +
    `setting (#983). The node re-reads it from the group on every refresh, and it declares ` +
    `serialize_widgets = false so the value never reaches the workflow at all — a direct write ` +
    `shows in the reply and in panel_query_graph for an instant, then reverts, and no node ever ` +
    `changes mode. Only the widget's own toggle() changes anything, because it also runs the ` +
    `group mode change that this value reports on.\n` +
    `Set the TARGET NODES' modes instead — mute or bypass the nodes in that group directly — ` +
    `and the toggle will follow, because it is reporting on them. (These nodes also carry one ` +
    `toggle row PER MATCHED GROUP, all named "${RGTHREE_TOGGLE_WIDGET}", so addressing one by ` +
    `name cannot say which group you meant.)`
  );
}
