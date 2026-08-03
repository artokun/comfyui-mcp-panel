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

function requiredInputs(nodeOrNodeData) {
  const nodeData = nodeOrNodeData?.constructor?.nodeData ?? nodeOrNodeData;
  const required = nodeData?.input?.required;
  return required && typeof required === "object" ? required : null;
}

/**
 * The distinct required input types that are eligible to be frontend widgets.
 * `forceInput` / `widget:false` are sockets even if a custom widget constructor
 * happens to share their declared type.
 */
export function requiredWidgetInputTypes(nodeOrNodeData) {
  const required = requiredInputs(nodeOrNodeData);
  if (!required) return [];
  return [...new Set(Object.values(required).map(inputWidgetType).filter(Boolean))];
}

/**
 * Custom widget hooks declare their types before ComfyUI copies them into the
 * public widget registry. This detects that transient state without treating
 * unrelated custom socket datatypes as widgets.
 */
export function unavailableDeclaredCustomWidgetTypes(nodeOrNodeData, declaredTypes, widgetConstructors) {
  return requiredWidgetInputTypes(nodeOrNodeData).filter(
    (type) => declaredTypes?.has(type) && typeof widgetConstructors?.[type] !== "function",
  );
}

/**
 * Return required inputs whose registered frontend widget did not materialize
 * on `node`.  A socket-only custom datatype is deliberately not reported: it
 * has no registered widget constructor and is valid to wire later.
 */
export function missingRequiredWidgetMaterializations(node, widgetConstructors) {
  const required = requiredInputs(node);
  if (!required) return [];

  const widgets = Array.isArray(node.widgets) ? node.widgets : [];
  const missing = [];
  for (const [name, spec] of Object.entries(required)) {
    const type = inputWidgetType(spec);
    if (!type || typeof widgetConstructors?.[type] !== "function") continue;
    const widget = widgets.find((candidate) => candidate?.name === name);
    // ComfyUI's prompt serializer reads the widget *options* flag. A widget
    // property named `serialize` is not authoritative and must not allow a
    // canvas-only control to satisfy a required prompt value.
    if (!widget || widget.options?.serialize === false) missing.push(name);
  }
  return missing;
}
