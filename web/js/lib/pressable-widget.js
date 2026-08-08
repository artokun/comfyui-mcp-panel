/**
 * panel#757 — when a widget is missing because a BUTTON has not been pressed,
 * say so instead of listing names.
 *
 * `panel_set_widget(node, "lora_1", …)` on a freshly added Power Lora Loader
 * (rgthree) refuses with:
 *
 *     Node 153 (Power Lora Loader (rgthree)) has no widget "lora_1"
 *     (available: divider, PowerLoraLoaderHeaderWidget, divider, ➕ Add Lora)
 *
 * The refusal is CORRECT — the slot genuinely does not exist yet. What it does
 * not say is that `➕ Add Lora`, sitting right there in the list, is a button
 * that CREATES those slots, and that the panel cannot press it. An agent reading
 * a bare availability list infers a typo, and the reporter's agent fell back to
 * chaining `LoraLoaderModelOnly` nodes — losing the stacking UI they wanted.
 *
 * This is the verification half of #757 and nothing more. Pressing the button
 * would be a new capability — a press-a-widget tool that invokes the widget's own
 * click handler — and is parked behind the stabilization pass. Naming a control
 * that is already visible in the message we ALREADY send cannot make anything
 * worse.
 *
 * (That tool is described in prose rather than by a `panel_`-prefixed name on
 * purpose: the vocabulary gate scans every such identifier, comments included,
 * and it is right to — a name in a comment is one copy-paste from a hint string,
 * and a hint string is read by the model. It caught this exact line.)
 *
 * WHY NOT `type === "button"`. That was the obvious check and it is wrong here.
 * rgthree's `RgthreeBetterButtonWidget` sets `this.type = "custom"` (verified in
 * the installed pack, `web/comfyui/utils_widgets.js`), so a type check would
 * never fire on the exact node this report is about. What actually makes a
 * widget pressable is that it HANDLES A CLICK, so that is what is tested — plus
 * litegraph's canonical `"button"` type, which is already how the rest of this
 * codebase recognises one (`cmcp-apps-ui.js` skips `w.type === "button"`).
 *
 * The detection is deliberately structural rather than name-based. Matching
 * "Add"/"➕"/"New" would fire on a combo called "Add Noise" — a real widget with
 * a real value — and tell the user to click something that is not a button.
 */

/**
 * Does this widget respond to a click rather than hold a value?
 *
 * @param {{ type?: string, onMouseClick?: unknown, mouseClickCallback?: unknown }} [w]
 */
export function isPressableWidget(w) {
  if (!w || typeof w !== "object") return false;
  // rgthree's base widget class, and any pack following the same convention.
  if (typeof w.onMouseClick === "function") return true;
  if (typeof w.mouseClickCallback === "function") return true;
  // litegraph's own button type.
  return w.type === "button";
}

/** The pressable widgets on a node, in the order they are drawn. */
export function pressableWidgets(node) {
  const list = Array.isArray(node?.widgets) ? node.widgets : [];
  return list.filter(isPressableWidget);
}

/**
 * The sentence to append to a missing-widget refusal, or "" when there is
 * nothing to add.
 *
 * Returns "" when the node has no pressable widget, which is the overwhelmingly
 * common case — a plain typo. That matters more than the message itself: adding
 * a button hypothesis to EVERY missing-widget refusal would make the ordinary
 * case noisier and slightly misleading, which is the stated reason this was not
 * bolted on when #757 was first triaged.
 *
 * @param {object} node
 * @param {string} widgetName the widget the caller asked for
 */
export function pressableWidgetHint(node, widgetName) {
  const buttons = pressableWidgets(node);
  if (buttons.length === 0) return "";
  const names = buttons.map((w) => `"${w?.label || w?.name || "(unnamed)"}"`).join(", ");
  const plural = buttons.length > 1;
  return (
    ` This node has ${plural ? "controls" : "a control"} the panel cannot activate: ` +
    `${names} — ${plural ? "these are buttons" : "that is a button"} rather than ` +
    `${plural ? "values" : "a value"}, and some nodes CREATE their remaining widgets only when ` +
    `${plural ? "one is" : "it is"} clicked (rgthree's Power Lora Loader builds its ` +
    `\`lora_1\`, \`lora_2\`, … rows this way). If "${widgetName}" is a slot of that kind, ask the ` +
    `user to click ${plural ? "the relevant button" : names} in the ComfyUI tab and then set it — ` +
    `writing an existing slot works normally. There is no tool to press a widget yet.`
  );
}
