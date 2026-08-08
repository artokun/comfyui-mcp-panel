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
//
// This list is a FALLBACK, not the discriminator. It exists only for the case
// where no fresh /object_info is available to prove link-ness structurally
// (see registeredSocketTypes + inputDeclaredAsSocket below, which is what the
// add path actually relies on). Growing it is not how a new core datatype gets
// fixed — #695 was filed after MASK, and would have been filed again after the
// next one.
const SAFE_SOCKET_TYPES = new Set([
  "*", "ANY", "AUDIO", "BBOX", "CLIP", "CLIP_VISION", "CLIP_VISION_OUTPUT",
  "CONDITIONING", "CONTROL_NET", "GLIGEN", "GUIDER", "HOOKS", "IMAGE",
  "IPADAPTER", "LATENT", "LATENT_OPERATION", "MASK", "MESH", "MODEL", "NOISE",
  "PHOTOMAKER", "SAMPLER", "SCHEDULER", "SIGMAS", "STYLE_MODEL", "UNET",
  "UPSCALE_MODEL", "VAE", "VOXEL",
]);

/**
 * Widget types ComfyUI's core frontend implements ITSELF.
 *
 * No pack registers these — they are built in — so waiting for a constructor to
 * appear for one is waiting for evidence that cannot arrive.
 */
const PRIMITIVE_WIDGET_TYPES = new Set(["FLOAT", "INT", "STRING", "BOOLEAN"]);

// COMBO is deliberately NOT in that set. A combo is declared as a LIST of options,
// so a bare "COMBO" type string is not the ordinary case, and two existing tests
// assert it must still wait. The justification here only reaches as far as the
// numeric/text primitives the core frontend certainly implements.

/**
 * A keyed name (`INT:seed`) is deliberately NOT unwrapped here.
 *
 * It would only matter inside a UNION — a lone `INT:seed` never reaches this
 * waiver, which requires more than one member — and no union naming a keyed
 * primitive has been observed. Mutation testing found the unwrapping killed no
 * test, which is the honest signal that it was handling a shape nobody has seen.
 * If one turns up, this fails CLOSED (the node waits, as it does today) rather
 * than silently accepting something unverified.
 */
function isPrimitiveWidgetType(member) {
  if (typeof member !== "string") return false;
  return PRIMITIVE_WIDGET_TYPES.has(member.trim().toUpperCase());
}


/**
 * The individual datatypes a declared input type names.
 *
 * ComfyUI declares a link-compatible UNION of datatypes as ONE COMMA-JOINED string:
 * core `PreviewImageOrMask` requires `("IMAGE,MASK")`, `SaveGLB` requires
 * `("MESH,FILE_3D_GLB,…")`, `ImageUncropByMask` requires `("BBOX,BOUNDING_BOX")`,
 * `LoraExtractKJ` requires `("MODEL,CLIP")`. LiteGraph splits on the comma to decide
 * link compatibility; every guard here must split it too. Comparing the whole string
 * against a set of single type names can only ever miss — the union is not the name of
 * any datatype, so it matched neither the allowlist nor the /object_info output proof,
 * and EVERY union input failed closed. That is #695's defect surviving the addition of
 * MASK to the allowlist: `PreviewImageOrMask` is still a mask node that cannot be added.
 *
 * A single (comma-free) type yields itself, so the single-type path is unchanged.
 */
export function declaredTypeMembers(type) {
  if (typeof type !== "string" || !type) return [];
  if (!type.includes(",")) return [type];
  return type
    .split(",")
    .map((member) => member.trim())
    .filter(Boolean);
}

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
  return unavailableRequiredWidgetReport(
    nodeOrNodeData,
    widgetConstructors,
    knownSocketTypes,
    currentDef,
  ).map((entry) => entry.type);
}

/**
 * The same verdict as unavailableRequiredCustomWidgetTypes, with what the caller needs
 * to say something TRUE about it: which required INPUTS carry each unavailable type, and
 * whether the current backend proves the type is a link datatype.
 *
 * #695 was reported against a message that blamed one cause — "may be custom widgets
 * still loading; retry shortly" — for two situations with opposite remedies, which is
 * what sent the reporter looking at a widget registry for a datatype that has no widget.
 * The two are distinguishable here, so they are distinguished here.
 */
export function unavailableRequiredWidgetReport(
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
  const inputsByType = new Map();
  for (const [name, spec] of Object.entries(required)) {
    const type = inputWidgetType(spec);
    if (!type) continue;
    (inputDeclaredAsSocket(spec) ? socketDeclared : widgetDeclared).add(type);
    if (!inputsByType.has(type)) inputsByType.set(type, []);
    inputsByType.get(type).push(name);
  }
  for (const type of widgetDeclared) socketDeclared.delete(type);

  const report = [];
  for (const [type, inputs] of inputsByType) {
    // The registry is keyed by the DECLARED type exactly as written — including
    // ComfyUI's own `INT:seed` / `INT:noise_seed` keys and any union a pack chooses to
    // register — so the whole string is checked first, before it is decomposed.
    if (typeof widgetConstructors?.[type] === "function") continue;
    const members = declaredTypeMembers(type);
    if (!members.length) continue;
    // Every member is a datatype no widget constructor will ever appear for: a built-in
    // connection type, or one the CURRENT backend declares as some node's output.
    const linkProven = members.every(
      (member) => SAFE_SOCKET_TYPES.has(member) || knownSocketTypes?.has?.(member) === true,
    );
    // A SINGLE built-in connection datatype is waived on the type alone. Unchanged from
    // before this fix, and sound for the same reason it was then: ComfyUI registers no
    // widget constructor for any of them, so there is nothing an input-level declaration
    // could be asking this to wait for.
    if (members.length === 1 && SAFE_SOCKET_TYPES.has(type)) continue;
    // A UNION does NOT get that shortcut, even when every member is a built-in. Members
    // being link datatypes is not the input being a link: a pack can declare
    // ("IMAGE,MASK", {widgetType: "IMAGE", default: …}) — the exact shape LTXV already
    // uses for ("FLOAT,INT", {widgetType: "FLOAT", default, min, max}) — and that is a
    // widget which ACCEPTS those links, not a socket. Only the input's own declaration
    // settles it, so a union must clear the input-level bar below as well. (Found by the
    // codex gate: waiving an all-built-in union on the type alone was a #580 false
    // accept, adding a node with neither a widget value nor a link.)
    // #626 P0: "some node OUTPUTS this type" does NOT establish that THIS input is
    // link-only. ComfyUI's frontend supports converting widget inputs to links, so a
    // widget-bearing input is link-compatible too — INT and a custom ACME_VALUE are
    // both output by some node somewhere. The output side is evidence about the TYPE;
    // the question asked here is about the INPUT. So the waiver needs the input-level
    // socket declaration as well: the type must be proven a link datatype AND every
    // required input carrying it must declare itself socket-shaped. A union is held to
    // exactly the same bar — LTXV's `("FLOAT,INT", {default, min, max, step})` is a
    // widget that ACCEPTS an int link, not a socket, and still waits for its constructor.
    if (linkProven && socketDeclared.has(type)) continue;
    // #686 — a CORE DYNAMIC-INPUT declaration is neither of the two things the waivers
    // above test for, so both misclassify it and it fails closed forever. See
    // isCoreDynamicV3Type: it is not a link datatype (nothing outputs it, so
    // knownSocketTypes can never contain it and `linkProven` is unreachable), and it is
    // not a value widget (no constructor is ever registered for it — the frontend
    // implements it natively).
    //
    // The input-level socket-shaped bar is deliberately NOT applied here, and that is a
    // correction to this fix's first version. `inputDeclaredAsSocket` asks whether an
    // input declares config keys that only a widget can honour — a sound question for an
    // ordinary datatype, and a meaningless one for this namespace, because the keys these
    // types carry are the dynamic-io SCHEMA's own structure rather than a widget value:
    // `template` (Autogrow, MatchType, MultiTyped), `inputs` (DynamicSlot) and — the one
    // that broke it — `options` (DynamicCombo). `options` is in WIDGET_VALUE_CONFIG_KEYS
    // because for a normal input it means a combo's choice list; for COMFY_DYNAMICCOMBO_V3
    // it is the list of dynamic OPTION BRANCHES, each with its own nested inputs. Requiring
    // socket-shapedness therefore left `SaveVideo` (whose `codec` is a DynamicCombo) exactly
    // as unaddable as before, which is #636's first defect.
    //
    // #580 is still respected: this waives ONLY ComfyUI's reserved namespace, for which no
    // widget constructor can ever appear, so there is nothing here that a retry could be
    // waiting for. Single-member only — a union naming a dynamic declaration is not a shape
    // ComfyUI emits, and admitting one would be guessing.
    // panel#788 — A UNION OF PRIMITIVES NEEDS NO REGISTERED WIDGET. The comment
    // above cites this exact shape and reaches the wrong conclusion about it:
    // core ComfyUI declares `frame_rate: ("FLOAT,INT", {widgetType: "FLOAT",
    // default, min, max})` on LTXVEmptyLatentAudio, and the panel waited 5s for a
    // constructor keyed "FLOAT,INT" that nothing will ever register. The node was
    // permanently unaddable — which blocks every LTX-2.3 audio-video graph, since
    // the audio latent is mandatory for AV models.
    //
    // Nothing was ever coming. FLOAT/INT/STRING/BOOLEAN are implemented by the
    // core frontend, not registered by packs, so this is the tracked pattern of
    // waiting on evidence that cannot arrive (#796) — and a reload, the remedy the
    // refusal named, cannot help.
    //
    // The stock frontend resolves it with `widgetType ?? type` (verified in the
    // shipped 1.47.12 bundle), i.e. the config's own hint wins and the declared
    // type is the fallback. Both are primitives here, so either way a native
    // widget is built and no registration is involved.
    //
    // This does NOT waive a union that merely CONTAINS a primitive: a pack's
    // ("ACME_VALUE,INT", …) still needs ACME_VALUE's constructor, and is still
    // held to the bar above. Every member must be primitive.
    // Restricted to UNIONS. A single primitive already resolves through the
    // constructor registry checked above, so widening it further would change
    // behaviour beyond the reported bug for no evidence.
    if (members.length > 1 && members.every(isPrimitiveWidgetType)) continue;
    if (members.length === 1 && isCoreDynamicV3Type(type)) continue;
    report.push({ type, inputs, linkProven });
  }
  return report;
}

/**
 * The refusal text for a report that never cleared. Says which INPUT is unsatisfiable
 * (not just its datatype), which of the two situations it is, and what actually fixes
 * each — the previous single-cause message named a remedy ("retry shortly") that cannot
 * work for a datatype no widget will ever back, and named none for the case that does.
 */
export function unavailableRequiredWidgetMessage(report, classType, waitedMs) {
  const target = classType ? `"${classType}"` : "this node";
  const lines = report.map((entry) => {
    const inputs = entry.inputs.map((name) => `"${name}"`).join(", ");
    const cause = entry.linkProven
      ? `the backend declares "${entry.type}" as a link datatype, but this input also declares a ` +
        `widget value (default/min/max/options), so it needs a registered widget and none appeared`
      : `no installed node outputs "${entry.type}" and no frontend widget is registered for it`;
    return `  - input ${inputs} (declared type "${entry.type}"): ${cause}.`;
  });
  const waited = Number.isFinite(waitedMs) ? `${(waitedMs / 1000).toFixed(1)}s` : "the wait window";
  return (
    `Cannot add ${target}: ${report.length} required input type${report.length === 1 ? "" : "s"} ` +
    `had no widget after ${waited} waiting for node extensions to register.\n` +
    `${lines.join("\n")}\n` +
    "Reload the ComfyUI browser tab so node packs can re-register their frontend widgets, then " +
    "retry. If it fails again the pack's frontend extension is not loading and retrying alone " +
    "will not fix it. This is NOT a link datatype being misread: an input the backend proves is " +
    "a socket (MASK, IMAGE, LATENT, a comma-joined union of them) is added immediately, without " +
    "any wait."
  );
}

/**
 * ComfyUI's CORE V3 dynamic-input declarations, which occupy the reserved `COMFY_*_V3`
 * type namespace: `COMFY_AUTOGROW_V3`, `COMFY_DYNAMICCOMBO_V3`, `COMFY_DYNAMICSLOT_V3`,
 * `COMFY_MATCHTYPE_V3`, `COMFY_MULTITYPED_V3` (declared with `@comfytype(io_type=…)` in
 * ComfyUI's `comfy_api/latest/_io.py`).
 *
 * These are a THIRD kind of required input, and the reason #686 failed closed forever:
 *
 *   • Not a value widget. No widget constructor is ever registered for them — the
 *     frontend implements the dynamic behaviour natively — so waiting for `app.widgets`
 *     to gain one waits for something that never happens. The reporter proved this
 *     directly: dragging `StringFormat` in from ComfyUI's own node menu works, and the
 *     node then wires and executes normally, so the def is valid and complete.
 *   • Not a link datatype. Nothing OUTPUTS `COMFY_AUTOGROW_V3`, so no fresh
 *     /object_info can ever put it in `knownSocketTypes`, and `linkProven` is
 *     structurally unreachable for it.
 *
 * The input is a TEMPLATE that makes the node grow real inputs; it carries no prompt
 * value of its own, which is why `StringFormat` and `ComfyMathExpression` are perfectly
 * valid the instant they are created.
 *
 * MATCHED BY RESERVED NAMESPACE, NOT BY A LIST — deliberately. This module already
 * carries the lesson: "Growing [SAFE_SOCKET_TYPES] is not how a new core datatype gets
 * fixed — #695 was filed after MASK, and would have been filed again after the next
 * one." Enumerating today's five would need editing the moment ComfyUI adds a sixth, and
 * that report would look exactly like this one. `COMFY_*_V3` is ComfyUI's own reserved
 * prefix for these, so the rule covers the family rather than its current membership.
 *
 * #580's protection is intact: this waives ONLY the reserved core namespace, and the
 * caller still requires the input to declare itself socket-shaped, so an input using one
 * of these types while declaring widget-value keys keeps waiting for a constructor.
 */
const CORE_DYNAMIC_V3_TYPE_RE = /^COMFY_[A-Z0-9]+_V3$/;

export function isCoreDynamicV3Type(type) {
  return typeof type === "string" && CORE_DYNAMIC_V3_TYPE_RE.test(type);
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
