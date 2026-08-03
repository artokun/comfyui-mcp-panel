/**
 * The frontend's node definition retains the V1-shaped input data even for
 * V3-schema nodes.  A registered widget constructor is the authoritative
 * signal that an input must be represented by a node widget rather than an
 * unconnected socket.
 */
function inputWidgetType(spec) {
  if (!Array.isArray(spec)) return null;
  const config = spec[1];
  // A forced socket is intentionally not materialized as a widget even when
  // its type also has a widget constructor.
  if (config && typeof config === "object" && (config.forceInput || config.widget === false)) {
    return null;
  }
  const declared = spec[0];
  // Legacy combo specs store their choices as the first tuple item; ComfyUI
  // materializes those through the COMBO constructor.
  return Array.isArray(declared) ? "COMBO" : typeof declared === "string" ? declared : null;
}

/**
 * Return required inputs whose registered frontend widget did not materialize
 * on `node`.  A socket-only custom datatype is deliberately not reported: it
 * has no registered widget constructor and is valid to wire later.
 */
export function missingRequiredWidgetMaterializations(node, widgetConstructors) {
  const required = node?.constructor?.nodeData?.input?.required;
  if (!required || typeof required !== "object") return [];

  const widgets = Array.isArray(node.widgets) ? node.widgets : [];
  const missing = [];
  for (const [name, spec] of Object.entries(required)) {
    const type = inputWidgetType(spec);
    if (!type || typeof widgetConstructors?.[type] !== "function") continue;
    const widget = widgets.find((candidate) => candidate?.name === name);
    // serialize:false controls must never stand in for a required prompt
    // value: they are canvas-only and graphToPrompt omits them.
    if (!widget || widget.serialize === false) missing.push(name);
  }
  return missing;
}
