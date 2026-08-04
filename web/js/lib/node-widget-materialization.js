/**
 * The frontend's node definition retains the V1-shaped input data even for
 * V3-schema nodes.  A registered widget constructor is the authoritative
 * signal that an input must be represented by a node widget rather than an
 * unconnected socket.
 */
function inputWidgetType(spec) {
  if (!Array.isArray(spec)) return null;
  const config = spec[1];
  // A forced or default-rendered socket is intentionally not materialized as
  // a widget even when its type also has a widget constructor: `forceInput` /
  // `widget:false` are socket-only, and `defaultInput` renders the socket by
  // default (convertible back by the user). The raw /object_info config keeps
  // the snake_case spelling; the normalized frontend nodeData uses camelCase.
  if (
    config &&
    typeof config === "object" &&
    (config.forceInput || config.force_input || config.defaultInput || config.widget === false)
  ) {
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

// These are ComfyUI's built-in connection datatypes. A required input carrying
// one is safe to leave as a socket when no widget constructor exists. An
// unrecognised type is NOT assumed safe: it may be a custom V3 widget whose
// extension is still registering.
const SAFE_SOCKET_TYPES = new Set([
  "*", "ANY", "AUDIO", "BBOX", "CLIP", "CLIP_VISION", "CLIP_VISION_OUTPUT",
  "CONDITIONING", "CONTROL_NET", "GLIGEN", "GUIDER", "HOOKS", "IMAGE",
  "IPADAPTER", "LATENT", "LATENT_OPERATION", "MASK", "MESH", "MODEL", "NOISE",
  "SAMPLER", "SCHEDULER", "SIGMAS", "STYLE_MODEL", "UNET", "UPSCALE_MODEL",
  "VAE", "VOXEL",
]);

/**
 * Required input types that might be custom widgets but have not entered the
 * live ComfyUI registry yet. Unknown custom socket types deliberately remain
 * unavailable: their schema is indistinguishable from a widget pending its
 * extension hook, so admitting one would reintroduce #580's bad prompt.
 *
 * `currentDef` is the class's entry in a FRESH /object_info map. When given,
 * it — not the possibly-stale registered nodeData — is the source of the
 * required-input scan: frontend-injected inputs (LoadImage's `upload`
 * button, #620) are absent from it and therefore never guarded, and inputs
 * the backend ADDED since page load are still seen. A def present with no
 * `input` means the backend requires nothing, so nothing is guarded. Omit
 * it (frontend-only types have no backend def) to scan the node data.
 *
 * `knownSocketTypes` lifts the unknown-type ambiguity where the CURRENT
 * backend already proves the type is a link datatype (some node in the same
 * fresh /object_info declares it as an OUTPUT — no widget constructor will
 * ever appear for it). Without it the hardcoded allowlist above fails closed
 * FOREVER on every third-party socket datatype (#620 STITCHER) and on core
 * types the list missed (#620 MASK, #608 VIDEO), which no retry/refresh can
 * ever clear. A still-unknown type with NO proof continues to fail closed,
 * so #580's protection is intact.
 */
export function unavailableRequiredCustomWidgetTypes(
  nodeOrNodeData,
  widgetConstructors,
  knownSocketTypes,
  currentDef,
) {
  return requiredWidgetInputTypes(currentDef ?? nodeOrNodeData).filter(
    (type) =>
      typeof widgetConstructors?.[type] !== "function" &&
      !SAFE_SOCKET_TYPES.has(type) &&
      knownSocketTypes?.has?.(type) !== true,
  );
}

/**
 * Datatypes some CURRENT backend node declares as an OUTPUT are link sockets,
 * not widgets pending registration — a widget constructor will never appear
 * for them. Derived from a FRESH /object_info map (NOT the LiteGraph
 * registry, which keeps stale nodeData.output positives for removed or
 * schema-changed packs and would wrongly waive the guard) so third-party
 * socket types (#620 STITCHER) and core types the allowlist missed (#608
 * VIDEO) resolve without an allowlist that can only ever be incomplete.
 */
export function registeredSocketTypes(objectInfoDefs) {
  const types = new Set();
  for (const def of Object.values(objectInfoDefs ?? {})) {
    const outputs = def?.output;
    if (!Array.isArray(outputs)) continue;
    for (const out of outputs) {
      if (typeof out === "string" && out) types.add(out);
    }
  }
  return types;
}

/**
 * What about a required input declaration determines the SHAPE of the node
 * createNode builds: the widget/socket type (combo choices included — a
 * widget created from the old values list can hold a value the backend no
 * longer accepts) and the forceInput/defaultInput/widget:false flags that
 * decide socket vs widget. Benign config (default, min/max, tooltip) is
 * deliberately not compared: a stale default still serializes a valid value.
 */
function inputShapeSignature(spec) {
  if (!Array.isArray(spec)) return null;
  const declared = spec[0];
  const type = Array.isArray(declared)
    ? `COMBO:${JSON.stringify(declared)}`
    : typeof declared === "string"
      ? declared
      : null;
  if (type === null) return null;
  const config = spec[1];
  const forced =
    config &&
    typeof config === "object" &&
    (config.forceInput || config.force_input || config.defaultInput || config.widget === false);
  return forced ? `${type}|socket` : type;
}

/**
 * Required input names whose declaration in the CURRENT backend def the
 * registered (possibly stale) node definition does not match. A pack
 * upgraded mid-session can add required inputs — or CHANGE an existing
 * one's type — on an ALREADY-registered class; the registry is refreshed
 * only for absent classes, so createNode would build the OLD shape — a new
 * link input would not even get a slot, and a retyped widget would hold a
 * value the backend rejects. The caller refuses with a reload remedy
 * instead.
 */
export function driftedRequiredInputNames(currentDef, nodeOrNodeData) {
  const current = currentDef?.input?.required;
  if (!current || typeof current !== "object") return [];
  const stale = requiredInputs(nodeOrNodeData) ?? {};
  return Object.keys(current).filter(
    (name) =>
      !Object.prototype.hasOwnProperty.call(stale, name) ||
      inputShapeSignature(stale[name]) !== inputShapeSignature(current[name]),
  );
}

/**
 * Return required inputs whose registered frontend widget did not materialize
 * on `node`.  A socket-only custom datatype is deliberately not reported: it
 * has no registered widget constructor and is valid to wire later.
 *
 * `currentDef` has the same meaning as in unavailableRequiredCustomWidgetTypes:
 * the fresh backend definition is the source of the required-input scan, so
 * frontend-injected inputs (LoadImage's `upload`, #620) are never misread as
 * a missing prompt value, and backend-required inputs the stale registry
 * does not know yet are still checked.
 */
export function missingRequiredWidgetMaterializations(node, widgetConstructors, currentDef) {
  const required = requiredInputs(currentDef ?? node);
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
