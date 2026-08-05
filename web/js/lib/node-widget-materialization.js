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
  const source = currentDef ?? nodeOrNodeData;
  const required = requiredInputs(source) ?? {};
  // Types for which EVERY required input carrying them declares itself socket-shaped.
  // "Every", not "some": a def can require the same datatype twice, once as a link and
  // once as a widget, and waiving the widget one because its sibling is a socket would
  // reproduce the very error this fixes one level down.
  const socketDeclared = new Set();
  const widgetDeclared = new Set();
  for (const spec of Object.values(required)) {
    const type = inputWidgetType(spec);
    if (!type) continue;
    (inputDeclaredAsSocket(spec) ? socketDeclared : widgetDeclared).add(type);
  }
  for (const type of widgetDeclared) socketDeclared.delete(type);
  return requiredWidgetInputTypes(source).filter(
    (type) =>
      typeof widgetConstructors?.[type] !== "function" &&
      !SAFE_SOCKET_TYPES.has(type) &&
      // #626 P0: "some node OUTPUTS this type" does NOT establish that THIS input is
      // link-only. ComfyUI's frontend supports converting widget inputs to links, so a
      // widget-bearing input is link-compatible too — INT and a custom ACME_VALUE are
      // both output by some node somewhere. The output side is evidence about the TYPE;
      // the question asked here is about the INPUT. So the waiver now needs the
      // input-level socket declaration as well: the type must be proven a link datatype
      // AND every required input carrying it must declare itself socket-shaped.
      !(knownSocketTypes?.has?.(type) === true && socketDeclared.has(type)),
  );
}

/**
 * Whether a required input DECLARES itself as a link socket rather than a prompt value.
 *
 * This is the input-level half of the #626 waiver, and it is a POSITIVE reading of the
 * declaration, not an absence: a widget input exists to carry a VALUE, and ComfyUI's
 * input config is where that value's presence is declared — `default`, and the numeric/
 * text/combo shaping (`min`/`max`/`step`/`multiline`/`options`/`control_after_generate`)
 * that only a widget can honour. An input declaring none of them is asking for a link.
 *
 * Deliberately NOT inferred from the type: the same datatype can be a widget on one node
 * and a socket on another, which is exactly why the output-side evidence was insufficient.
 */
export function inputDeclaredAsSocket(spec) {
  if (!Array.isArray(spec)) return false;
  // A legacy combo (choices as the first tuple item) is always a widget — it exists to
  // select one of those choices, and nothing can link a choice in.
  if (Array.isArray(spec[0])) return false;
  const config = spec[1];
  if (config == null) return true;
  if (typeof config !== "object") return true;
  // An explicit socket flag settles it outright.
  if (config.forceInput || config.force_input || config.defaultInput || config.widget === false) {
    return true;
  }
  return !WIDGET_VALUE_CONFIG_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(config, key),
  );
}

// Config keys that only a WIDGET can honour — their presence is the input declaring it
// carries a value. `tooltip`, `lazy`, `rawLink` and friends are deliberately absent:
// they say nothing about widget-vs-socket and a socket input commonly carries them.
const WIDGET_VALUE_CONFIG_KEYS = [
  "default",
  "min",
  "max",
  "step",
  "round",
  "precision",
  "multiline",
  "dynamicPrompts",
  "dynamic_prompts",
  "options",
  "control_after_generate",
  "image_upload",
  "video_upload",
  "audio_upload",
  "placeholder",
];

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

/** The numeric constraint / default a required input's CURRENT declaration carries. */
function inputValueConfig(spec) {
  const config = Array.isArray(spec) ? spec[1] : null;
  return config && typeof config === "object" ? config : null;
}

/**
 * Reconcile a JUST-CREATED node's widget values and numeric bounds against the CURRENT
 * backend definition, returning the corrections that were applied.
 *
 * Why this exists (#626 P0): `LG.createNode` builds from the REGISTERED `nodeData`, and
 * the registry is only refreshed for classes that are ABSENT. A pack upgraded mid-session
 * keeps its stale entry, so a required INT that moved from
 * `{default: 1, min: 0, max: 10}` to `{default: 20, min: 20, max: 100}` still matches on
 * shape signature — both are `INT` — and the node is created holding `1`. That is out of
 * range: the backend rejects it at QUEUE time, far from its cause, which is exactly the
 * confusing-failure outcome an add-time check exists to prevent. And even when the stale
 * value happens to remain valid it is an INVENTED value in the user's graph rather than
 * the current definition's.
 *
 * Applied to a node the caller has just created and not yet placed, so every widget still
 * holds the stale DEFAULT — there is no user intent here to overwrite. Bounds are written
 * BEFORE the value, so a new default outside the old range is not clamped back out by a
 * stale min/max. A value that is still outside the current range after both (a def that
 * declares no default) is CLAMPED, and the clamp is reported like any other correction —
 * silently shipping an out-of-range value is the defect, and silently fixing one without
 * saying so is the fabrication.
 *
 * Pure apart from the node it is handed; returns [] when there is nothing current to
 * compare against, so a frontend-only type is untouched.
 */
export function applyCurrentDefWidgetValues(node, currentDef) {
  const required = currentDef?.input?.required;
  if (!required || typeof required !== "object") return [];
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  const corrections = [];
  for (const [name, spec] of Object.entries(required)) {
    const widget = widgets.find((w) => w?.name === name);
    if (!widget) continue; // a socket, or a widget that never materialized — not ours
    const config = inputValueConfig(spec);
    if (!config) continue;
    const before = widget.value;
    // 1) BOUNDS first, so a raised default is not clamped by a stale max.
    const options = widget.options && typeof widget.options === "object" ? widget.options : null;
    if (options) {
      for (const key of ["min", "max", "step", "round", "precision"]) {
        if (Object.prototype.hasOwnProperty.call(config, key) && options[key] !== config[key]) {
          options[key] = config[key];
        }
      }
    }
    // 2) The VALUE comes from the CURRENT definition, never the stale registered one.
    if (Object.prototype.hasOwnProperty.call(config, "default") && widget.value !== config.default) {
      widget.value = config.default;
    }
    // 3) A numeric value still outside the CURRENT range (no default declared, or a
    //    default the def itself contradicts) is clamped rather than shipped invalid.
    if (typeof widget.value === "number" && Number.isFinite(widget.value)) {
      if (typeof config.min === "number" && widget.value < config.min) widget.value = config.min;
      if (typeof config.max === "number" && widget.value > config.max) widget.value = config.max;
    }
    if (widget.value !== before) corrections.push({ name, from: before, to: widget.value });
  }
  return corrections;
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
