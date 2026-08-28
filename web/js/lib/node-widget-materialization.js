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
  "IPADAPTER", "LATENT", "LATENT_OPERATION",
  // #751 — LIST is ComfyUI's list-of-items socket. Packs often stamp leftover
  // INPUT_TYPES `default: []` on it, which is not a widget constructor.
  "LIST", "MASK", "MESH", "MODEL", "NOISE",
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
  // #1062 (codex) — types for which EVERY carrying input resolves to a widget the core
  // frontend builds natively (`widgetType ?? type` naming a primitive). Held to the same
  // "every, not some" discipline as socketDeclared directly below, and for the same reason:
  // one input's native hint must not waive a sibling that needs a real constructor.
  const nativeWidgetDeclared = new Set();
  const nonNativeDeclared = new Set();
  const inputsByType = new Map();
  for (const [name, spec] of Object.entries(required)) {
    const type = inputWidgetType(spec);
    if (!type) continue;
    (inputDeclaredAsSocket(spec) ? socketDeclared : widgetDeclared).add(type);
    (inputDeclaresNativeWidgetType(spec) ? nativeWidgetDeclared : nonNativeDeclared).add(type);
    if (!inputsByType.has(type)) inputsByType.set(type, []);
    inputsByType.get(type).push(name);
  }
  for (const type of widgetDeclared) socketDeclared.delete(type);
  for (const type of nonNativeDeclared) nativeWidgetDeclared.delete(type);

  // #1584 — `*` is ComfyUI's wildcard output type, not a literal datatype. A live
  // wildcard producer such as JsonParseNode can feed a custom input like DICT, so an
  // exact membership test would still misclassify that socket as a widget waiting for
  // registration. This only widens the OUTPUT-side proof; the input-level
  // `socketDeclared` check below remains required so a value-bearing custom widget is
  // never waived merely because some node emits a wildcard.
  const wildcardOutputProven = knownSocketTypes?.has?.("*") === true;

  const report = [];
  for (const [type, inputs] of inputsByType) {
    // The registry is keyed by the DECLARED type exactly as written — including
    // ComfyUI's own `INT:seed` / `INT:noise_seed` keys and any union a pack chooses to
    // register — so the whole string is checked first, before it is decomposed.
    if (typeof widgetConstructors?.[type] === "function") continue;
    // #1062 (codex) — a NATIVE widget hint resolves without any registration, so there is
    // nothing here a retry could be waiting for. Checked before the member analysis because
    // it is a statement about the INPUT's own resolution, independent of what the declared
    // type's members are or whether anything outputs them.
    if (nativeWidgetDeclared.has(type)) continue;
    const members = declaredTypeMembers(type);
    if (!members.length) continue;
    // Every member is a datatype no widget constructor will ever appear for: a built-in
    // connection type, or one the CURRENT backend declares as some node's output.
    // #1062 — `isCore3dFileType` is a THIRD way for a member to be proven a link datatype,
    // alongside the built-in allowlist and the live output proof. It exists because the
    // output proof cannot see a core datatype that no INSTALLED node happens to emit; see
    // its own comment. The quantifier is still `every` — a proven member never vouches for
    // an unproven one.
    const linkProven = members.every(
      (member) =>
        SAFE_SOCKET_TYPES.has(member) ||
        isCore3dFileType(member) ||
        knownSocketTypes?.has?.(member) === true ||
        wildcardOutputProven,
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
 * (not just its datatype), which of the situations it is, and what actually fixes
 * each — the previous single-cause message named a remedy ("retry shortly") that cannot
 * work for a datatype no widget will ever back, and named none for the case that does.
 *
 * #1848 — there are THREE situations, not two. "No installed node outputs T" is a claim
 * about the whole install, and it is only true if the whole schema was actually read. The
 * socket proof may come from a single-class /object_info (#780's optimisation), in which
 * case it is widened against the full schema on the refusal path (#821) — and that widen
 * is BOUNDED (#1180/#1192), so on a heavy install it can return nothing. When it does,
 * the guard rightly keeps failing closed, but the MESSAGE must not upgrade "I could not
 * find out" into "nothing produces it". That is the same false-cause defect #695 and #700
 * were about, and it sends the reader to a remedy (reload the tab) that cannot help: the
 * missing thing is not a frontend widget, it is the answer to a question never asked.
 *
 * `schemaProofComplete` is false only when a widen was attempted and could not answer.
 */
export function unavailableRequiredWidgetMessage(report, classType, waitedMs, schemaProofComplete = true) {
  const target = classType ? `"${classType}"` : "this node";
  const lines = report.map((entry) => {
    const inputs = entry.inputs.map((name) => `"${name}"`).join(", ");
    const cause = entry.linkProven
      ? `the backend declares "${entry.type}" as a link datatype, but this input also declares a ` +
        `widget value (default/min/max/options), so it needs a registered widget and none appeared`
      : schemaProofComplete
        ? `no installed node outputs "${entry.type}" and no frontend widget is registered for it`
        : `no frontend widget is registered for "${entry.type}", and whether any installed node ` +
          `outputs it is UNKNOWN — the full /object_info read that would answer it did not ` +
          `complete, so this is not evidence that nothing produces it`;
    return `  - input ${inputs} (declared type "${entry.type}"): ${cause}.`;
  });
  const waited = Number.isFinite(waitedMs) ? `${(waitedMs / 1000).toFixed(1)}s` : "the wait window";
  // #1848 (gate) — the CAUSE is per entry, so the REMEDY has to be too. `linkProven` is
  // decided from SAFE_SOCKET_TYPES / core 3D types / this class's own outputs, none of
  // which a widen can change, so a report made only of link-proven entries is untouched
  // by the schema question and must keep the remedy that can actually help it. Switching
  // the whole message on a report-wide flag deleted that advice — the same
  // remedy-that-cannot-work defect (#695/#700) this change exists to fix.
  const schemaUnknown = !schemaProofComplete && report.some((e) => !e.linkProven);
  const reloadRemedy =
    "Reload the ComfyUI browser tab so node packs can re-register their frontend widgets, then " +
    "retry. If it fails again the pack's frontend extension is not loading and retrying alone " +
    "will not fix it. This is NOT a link datatype being misread: an input the backend proves is " +
    "a socket (MASK, IMAGE, LATENT, a comma-joined union of them) is added immediately, without " +
    "any wait.";
  // ADDITIVE, never substitutive. Every entry in this report reached it because no widget
  // constructor existed after the full poll, so "no frontend widget is registered" is the
  // one thing here that is PROVEN. An unfinished schema read adds a second possible cause
  // (a sibling may output the type); it does not retract the first. Saying "the missing
  // thing is the schema answer, not a frontend widget" denied the proven half and removed
  // its remedy — and because the widen's bound is fixed, an install whose /object_info
  // exceeds it re-fails identically on every retry, so that advice could never resolve.
  const retryRemedy =
    "ALSO worth a RETRY: whether any installed node outputs the type(s) above is unresolved — " +
    "the full /object_info read that would settle it did not complete, and a retry can " +
    "complete that read. If retries keep hitting the same wall, this install's /object_info " +
    "may be large enough that the read needs a longer budget.";
  // The reload advice fits EVERY entry (each one is a widget that did not appear), so it
  // is always emitted. The retry advice is stacked on top only when a producer question
  // was left unanswered.
  const remedy = schemaUnknown ? `${reloadRemedy}
${retryRemedy}` : reloadRemedy;
  return (
    `Cannot add ${target}: ${report.length} required input type${report.length === 1 ? "" : "s"} ` +
    `had no widget after ${waited} waiting for node extensions to register.\n` +
    `${lines.join("\n")}\n` +
    remedy
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
 * #1062 — ComfyUI's core 3D FILE-FORMAT datatypes.
 *
 * These are link datatypes that OFTEN NOTHING INSTALLED OUTPUTS, which is the specific
 * blind spot in the output-proof oracle: `knownSocketTypes` proves a type is a link
 * datatype by finding some node that emits it, so a datatype that is real but simply has
 * no producer on THIS install is indistinguishable from an unregistered custom widget.
 *
 * That is not hypothetical, it is the whole of #1062. Core `SaveGLB` declares
 * `mesh: ("MESH,FILE_3D_GLB,FILE_3D_GLTF,FILE_3D_OBJ,FILE_3D_FBX,FILE_3D_STL,
 * FILE_3D_USDZ,FILE_3D_PLY,FILE_3D_SPLAT,FILE_3D_SPZ,FILE_3D_KSPLAT,FILE_3D_SPLAT_ANY,
 * FILE_3D_POINT_CLOUD_ANY,FILE_3D", {tooltip})`. Measured against a live ComfyUI 0.31 with
 * 4183 node definitions: SEVEN of those members are emitted by some node
 * (MESH, FILE_3D_GLB, FILE_3D_OBJ, FILE_3D_FBX, FILE_3D_SPLAT_ANY,
 * FILE_3D_POINT_CLOUD_ANY, FILE_3D) and SEVEN are emitted by nothing at all
 * (FILE_3D_GLTF, FILE_3D_STL, FILE_3D_USDZ, FILE_3D_PLY, FILE_3D_SPLAT, FILE_3D_SPZ,
 * FILE_3D_KSPLAT) — a union naming formats ComfyUI can WRITE but that no installed node
 * PRODUCES. So `linkProven` was false, and SaveGLB — the only core node that writes a
 * .glb — could not be placed on the canvas at all.
 *
 * WHY NOT #1062'S OWN PROPOSED FIX (`every` -> `some` over the members): because a proven
 * member must not vouch for an unproven one. An empty config counts as socket-shaped, so
 * the input-level bar cannot catch `("MESH,ZIPN_STYLE_GALLERY", {})` — only `every` does,
 * and `some` would admit that node while silently skipping a widget that never registered
 * (#580's false accept). That invariant is pinned by its own test and is UNCHANGED here:
 * the quantifier stays `every`. What changes is what a member can be proven BY.
 *
 * AN EXPLICIT SET, NOT A `FILE_3D_*` PREFIX — deliberately the opposite choice from
 * `COMFY_*_V3` above, because the two namespaces have opposite ownership. `COMFY_*_V3` is
 * ComfyUI's reserved prefix, so covering the family is right and enumerating it would rot.
 * `FILE_3D_*` is not reserved: a pack is free to invent `FILE_3D_ACME`, and a prefix rule
 * would launder exactly the unregistered custom member the invariant above exists to
 * refuse. This is a closed list of the 13 members ComfyUI core ships — verified against the
 * shipped 1.50.3 frontend, where all 13 appear in the `dataTypes` translation tables (one
 * entry per locale) and NONE appears as a widget constructor. A future core format is a
 * one-line addition and fails closed until then, which is the safe direction.
 *
 * The caller still requires the input to declare itself socket-shaped, so a node using one
 * of these types while declaring widget-value keys keeps waiting for its constructor.
 */
const CORE_3D_FILE_TYPES = new Set([
  "FILE_3D",
  "FILE_3D_FBX",
  "FILE_3D_GLB",
  "FILE_3D_GLTF",
  "FILE_3D_KSPLAT",
  "FILE_3D_OBJ",
  "FILE_3D_PLY",
  "FILE_3D_POINT_CLOUD_ANY",
  "FILE_3D_SPLAT",
  "FILE_3D_SPLAT_ANY",
  "FILE_3D_SPZ",
  "FILE_3D_STL",
  "FILE_3D_USDZ",
]);

/**
 * EXACT match, no normalisation (codex). Trimming and upper-casing looked like tidiness and
 * was a hole in the closed-list claim above: every other registry here keys on the declared
 * spelling verbatim — the widget-constructor lookup and `knownSocketTypes` both do — so a
 * required input declared `file_3d_gltf`, or a single-member `" FILE_3D_GLTF "`, is a
 * DIFFERENT identifier from the core type everywhere else in this module. Normalising here
 * would have let those be waived as proven core sockets, which is precisely the laundering
 * the explicit set exists to prevent, and would additionally have made the refusal text
 * claim the backend declares that exact spelling as a link datatype when it does not.
 *
 * Union members arrive already trimmed from `declaredTypeMembers`; a single type does not,
 * and that asymmetry is the store's, not ours to paper over.
 */
export function isCore3dFileType(type) {
  return typeof type === "string" && CORE_3D_FILE_TYPES.has(type);
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
/**
 * #1062 (codex re-review) — whether an input's `widgetType` hint names a widget the CORE
 * FRONTEND IMPLEMENTS ITSELF.
 *
 * The companion to putting `widgetType` in WIDGET_VALUE_CONFIG_KEYS. That key correctly says
 * "this input is a widget, not a socket", which is what stops an unregistered custom widget
 * from being waived as a link. But it is not the whole ruling, and taking it as the whole
 * ruling was a false REFUSAL — the exact mirror of the accept it fixed.
 *
 * ComfyUI resolves the widget as `widgetType ?? type`, so `("FILE_3D_GLTF", {widgetType:
 * "STRING"})` renders a NATIVE STRING widget. Nothing registers a constructor for
 * FILE_3D_GLTF and nothing ever will, so refusing it waits on evidence that cannot arrive
 * (#796) — the same failure #788 fixed for `("FLOAT,INT", {widgetType: "FLOAT"})`, which
 * this file already documents. The difference is only that #788 read the resolution off the
 * declared TYPE and this reads it off the hint, which is the half that actually wins.
 *
 * A NON-primitive hint is unchanged and still fails closed: `{widgetType: "ACME_GALLERY"}`
 * genuinely needs a constructor no core frontend provides, and that is the case the key-list
 * addition exists to catch.
 */
function inputDeclaresNativeWidgetType(spec) {
  if (!Array.isArray(spec)) return false;
  const config = spec[1];
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  // EXACT match against the primitive set, deliberately NOT via isPrimitiveWidgetType
  // (codex). That helper trims and upper-cases, which is right where it is used — the #788
  // waiver feeds it union MEMBERS, and whitespace around a comma is the store's syntax
  // rather than part of the identifier. Here the value is an identifier the frontend looks
  // up verbatim, so normalising would waive `"string"` and `" STRING "` as native widgets
  // when ComfyUI would resolve neither, granting the waiver to a name that is not the
  // primitive. Same exact-spelling discipline as isCore3dFileType, and for the same reason.
  //
  // Left isPrimitiveWidgetType untouched rather than tightening it globally: it predates
  // this and #788 depends on its current behaviour, so narrowing it here is the change that
  // is actually justified by the evidence.
  return typeof config.widgetType === "string" && PRIMITIVE_WIDGET_TYPES.has(config.widgetType);
}

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
  // #1062 (codex) — `widgetType` is the strongest widget declaration of all, and it was
  // missing. It is not a value like the keys above; it is the input naming the widget it
  // renders as, which the stock frontend resolves with `widgetType ?? type` (verified in
  // the shipped bundle, and already documented by the #788 case
  // `("FLOAT,INT", {widgetType: "FLOAT", …})`).
  //
  // Its absence was latent rather than harmless: an input declaring ONLY `widgetType` — no
  // `default`, no range — counted as socket-shaped, so `socketDeclared` held it and the
  // input-level bar waved it through. Nothing reached that state before, because such a
  // type still had to clear `linkProven` and an unproduced datatype never did. Adding the
  // core-3D proof removed that accidental second lock, which is what surfaced this:
  // `("FILE_3D_GLTF", {widgetType: "STRING"})` would have been added as a socket while
  // genuinely being a STRING widget — a node with neither a widget value nor a link, which
  // is exactly #580's false accept.
  "widgetType",
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
      if (typeof out !== "string" || !out) continue;
      types.add(out);
      // ComfyUI's `*` wildcard can be one segment of a comma-joined output type
      // (for example `*,IMAGE`). Keep the existing whole-output proof, and add the
      // same wildcard sentinel used by the report's output-side check.
      if (out.split(",").some((segment) => segment.trim() === "*")) types.add("*");
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
/** Own ENUMERABLE DATA keys, or null when the object carries anything a key-by-key
 *  comparison cannot faithfully see (#1085 codex): a SYMBOL key, a NON-ENUMERABLE own
 *  property, or an ACCESSOR. Accessors matter twice over — a getter would be INVOKED by the
 *  comparison, so two different shapes can read equal, and a THROWING getter would crash a
 *  path that used to be a bare `!==`. `allowLength` skips an array's own non-enumerable
 *  `length`, which every array has.
 *
 *  Returning null means "cannot compare structurally", and the caller then falls back to
 *  identity — the answer `!==` gave before any of this existed. */
function plainDataKeys(obj, allowLength) {
  const out = [];
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === "symbol") return null;
    if (allowLength && key === "length") continue;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || !desc.enumerable || !("value" in desc)) return null;
    out.push(key);
  }
  return out;
}

/** A canonical ARRAY INDEX key. `String(Number(k)) === k` is NOT this test: it accepts
 *  "Infinity", "1.5" and "1e+21" (codex).
 *
 *  REDUNDANT TODAY, and said plainly rather than implied otherwise — mutation-verified:
 *  loosening this predicate breaks no test. What actually closed that hole was switching
 *  the array branch from a 0..length WALK to a comparison of the PRESENT KEY SET, which
 *  visits every own key including the ones that are not indices. This kept as an explicit
 *  refusal because a key that is not an index has no business in a value being compared as
 *  an array, and because it is what would still hold if the loop ever went back to walking
 *  indices. */
function isArrayIndexKey(key) {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === key;
}

/** #1085 — whether two widget values are the SAME VALUE, not the same reference.
 *
 *  `!==` is the right question for a scalar and the wrong one for an OBJECT default, where
 *  it is true for every pair of distinct references no matter what they contain. Core
 *  `ImageCropV2` declares `crop_region` as `{x, y, width, height}`, and each `/object_info`
 *  read materialises a fresh object — so every add "corrected" that widget from
 *  `{"x":0,"y":0,"width":512,"height":512}` to the identical `{"x":0,"y":0,"width":512,
 *  "height":512}` and warned that the tab's schema was STALE. Nothing had changed, and the
 *  advice that came with it (reload the tab before editing further) was work the user did
 *  not need to do.
 *
 *  Structural, not `JSON.stringify`: key ORDER differs freely between two readings of the
 *  same definition, and stringify would call those unequal — reproducing the bug through a
 *  second mechanism. Prototypes must match too, so a plain object never compares equal to a
 *  class instance that happens to carry the same keys.
 *
 *  FAILS TOWARD TODAY'S BEHAVIOUR wherever it declines to compare: a proxy that throws, an
 *  exotic object, an accessor or a symbol key all answer "different", which is exactly what
 *  `!==` answered before this existed — a spurious correction at worst, never a missed one.
 *  A CYCLE is the one case that is decided rather than refused: re-encountering a pair means
 *  the traversal closed a loop, and two structures that agree everywhere else agree there.
 *
 *  ON HANGING PROXY TRAPS, since a structural compare reads what `!==` did not: for an
 *  OBJECT-valued widget this exposure is not new. `!==` was true for every object, so a
 *  correction was always recorded, and the caller's disclosure interpolates
 *  `JSON.stringify(c.from)` — which invokes the same ownKeys/get/getOwnPropertyDescriptor
 *  traps. A non-returning trap already hung there. Comparing first REDUCES the exposure:
 *  when the values are equal there is now no correction, so nothing is stringified.
 *
 *  NOT full parity, and the difference is named rather than glossed (codex): this also calls
 *  `Object.getPrototypeOf`, which JSON serialization does not, so a proxy whose
 *  `getPrototypeOf` trap never returns is newly reachable. There is no general defence — a
 *  non-returning trap cannot be interrupted from JS, and no reliable proxy detection exists —
 *  and a widget value of that shape means custom-node code that already runs in the page.
 */
function sameWidgetValue(a, b) {
  // GUARDED ENTRY (codex). Everything below can touch a live widget value, and a live value
  // can be a PROXY: Array.isArray, getPrototypeOf, Reflect.ownKeys,
  // getOwnPropertyDescriptor, hasOwnProperty and a plain property read are all trap points,
  // and a REVOKED proxy throws on the first of them. The path this replaced was a bare
  // `!==`, which touches nothing — so without this, adding a node could fail outright where
  // it used to succeed. Any throw (including a RangeError from an over-deep structure)
  // answers "different", which is exactly what `!==` said.
  //
  // A trap that HANGS rather than throws is not guardable from here, and is not introduced
  // by this change alone — any structural read of such a value has the same exposure.
  try {
    return sameWidgetValueDeep(a, b, new WeakMap());
  } catch {
    return false;
  }
}

function sameWidgetValueDeep(a, b, seen) {
  // Numbers first, so the two IEEE oddities are answered deliberately rather than by
  // whichever operator happened to be used: NaN equals NaN (a NaN default would otherwise
  // "change" on every single add), and -0 equals +0 (Object.is alone says they differ, which
  // would invent a correction `!==` never reported). Everything else uses Object.is.
  if (typeof a === "number" && typeof b === "number") {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  // CYCLE DETECTION, replacing a depth cap. Two successive caps (8, then 100) were both
  // wrong in the same way (codex): a cap is a limit on SHAPE, and any equal structure past
  // it received the exact spurious correction this fix exists to remove — then got
  // reassigned, re-aliasing the widget to the definition's object. There is no depth at
  // which that is the right answer.
  //
  // Tracking the (a, b) pairs already compared bounds a cycle EXACTLY. A finite structure is
  // then limited only by the CALL STACK rather than by a constant — which is not the same as
  // unlimited (codex), and the earlier wording claiming otherwise was wrong. Past that the
  // recursion overflows, the guarded entry catches the RangeError, and the answer degrades to
  // "different" — the pre-fix answer. Materially better than a cap of 8 or 100, which real
  // values could reach; a JSON widget default cannot approach the stack. Re-encountering a pair means the traversal closed a loop, and the
  // standard reading is co-inductive: the pair is equal unless something else proves
  // otherwise. A stack deep enough to overflow still ends in the guarded entry's catch,
  // which answers "different".
  //
  // Pairs are retained for the WHOLE traversal, not just the current path (codex) — that is
  // ordinary bisimulation and is what makes sibling branches cheap; it is stated here
  // because "on this path" was the wrong description of it.
  //
  // ACCEPTED LIMIT of that reading: it compares SHAPE, not aliasing topology. A self-cycle
  // (`a.self === a`) and a two-object mutual cycle (`b.self = c; c.self = b`) are bisimilar
  // and compare EQUAL though the objects differ. Unreachable in this function's actual job:
  // the value being compared against is `config.default`, which comes from /object_info and
  // is therefore JSON — and JSON cannot express a cycle at all. Recorded rather than fixed,
  // because distinguishing topologies costs real complexity for a case the input format
  // rules out.
  let partners = seen.get(a);
  if (partners?.has(b)) return true;
  if (!partners) seen.set(a, (partners = new Set()));
  partners.add(b);

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    // Array subclasses are not plain arrays; compare them by identity like any other
    // exotic object (the check below would otherwise be skipped for the array branch).
    if (Object.getPrototypeOf(a) !== Array.prototype || Object.getPrototypeOf(b) !== Array.prototype) {
      return false;
    }
    if (a.length !== b.length) return false;
    // Compare the PRESENT INDEX KEYS rather than walking 0..length (codex). A single valid
    // sparse index of 4294967294 sets length to 4294967295, and a length walk would spin
    // through billions of absent slots and freeze the tab. This also compares hole-ness for
    // free: a hole simply has no own key, so `[,1]` and `[0,1]` differ by key set.
    const aIdx = plainDataKeys(a, true);
    const bIdx = plainDataKeys(b, true);
    if (!aIdx || !bIdx) return false;
    if (aIdx.length !== bIdx.length) return false;
    if (!aIdx.every(isArrayIndexKey) || !bIdx.every(isArrayIndexKey)) return false;
    for (const key of aIdx) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!sameWidgetValueDeep(a[key], b[key], seen)) return false;
    }
    return true;
  }

  // PLAIN OBJECTS ONLY (codex). `Object.keys` sees no content on a Date, Map, Set,
  // ArrayBuffer or DataView, so two instances of any of them compared EQUAL whatever they
  // held — again a real change reported as none. An /object_info default is JSON and can be
  // none of these, but a live widget value can, so the structural path is restricted to the
  // shape it was written for and everything else falls back to the identity answer
  // `Object.is` already gave — which is exactly what `!==` did before this existed.
  //
  const aProto = Object.getPrototypeOf(a);
  if (aProto !== Object.getPrototypeOf(b)) return false;
  if (aProto !== Object.prototype && aProto !== null) return false;
  // A PLAIN object can still carry symbol-keyed or non-enumerable own properties, which
  // Object.keys does not see (codex). An earlier version of this comment claimed the
  // prototype restriction disposed of them — it does not, and a test asserted that false
  // negative under a title saying it could not happen. Refuse to compare structurally when
  // either side has any such property; identity then answers, as it did before this existed.
  const aKeys = plainDataKeys(a, false);
  const bKeys = plainDataKeys(b, false);
  if (!aKeys || !bKeys) return false;
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(b, k) && sameWidgetValueDeep(a[k], b[k], seen),
  );
}

export function applyCurrentDefWidgetValues(node, currentDef, out) {
  const required = currentDef?.input?.required;
  if (!required || typeof required !== "object") return [];
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  const corrections = [];
  /** #1369 — corrections REFUSED because the definition's own default is not a member of
   *  its own option list. Reported rather than dropped: the node is usable, but the
   *  caller should know its schema is self-contradictory, and silently declining to act
   *  is the same class of omission as silently acting. */
  const rejected = [];
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
    //    …UNLESS the definition contradicts itself. #1369: KJNodes declares
    //
    //      "sage_attention": [ ["disabled","auto",…], { "default": false } ]
    //
    //    a COMBO whose default is not a member of its own option list — a leftover from
    //    when that input was a BOOLEAN. Applying it faithfully (which is what this
    //    function is FOR) rewrote a perfectly good "disabled" to `false`, and ComfyUI
    //    then refused the run with `Value not in list`.
    //
    //    The enum is already in hand — it is the same spec this default came from — so
    //    the check costs nothing. A default outside it is DISCARDED rather than clamped
    //    or coerced: there is no defensible way to pick a replacement from an option list
    //    the node author evidently did not mean, and the value the widget already holds
    //    came from the registered schema and is at least a real member.
    // #1085 — VALUE equality, not reference equality. An object default is a fresh object on
    // every /object_info read, so `!==` reported a correction on every add of a node whose
    // default is structured (ImageCropV2's `crop_region`), and the "schema is STALE" warning
    // that follows was raised about a value that had not changed.
    if (
      Object.prototype.hasOwnProperty.call(config, "default") &&
      !sameWidgetValue(widget.value, config.default)
    ) {
      const comboOptions = Array.isArray(spec?.[0])
        ? spec[0]
        : Array.isArray(config.options)
          ? config.options
          : null;
      if (comboOptions && !comboOptions.includes(config.default)) {
        rejected.push({ name, proposed: config.default, kept: widget.value });
      } else {
        widget.value = config.default;
      }
    }
    // 3) A numeric value still outside the CURRENT range (no default declared, or a
    //    default the def itself contradicts) is clamped rather than shipped invalid.
    if (typeof widget.value === "number" && Number.isFinite(widget.value)) {
      if (typeof config.min === "number" && widget.value < config.min) widget.value = config.min;
      if (typeof config.max === "number" && widget.value > config.max) widget.value = config.max;
    }
    // Same reason (#1085): after an assignment above, `before` and the new value can be
    // distinct objects holding identical content, and only a structural compare can say so.
    if (!sameWidgetValue(widget.value, before)) corrections.push({ name, from: before, to: widget.value });
  }
  // Reported through an OPT-IN out-param rather than as a property on the returned array.
  // The first cut attached `corrections.rejected` and claimed every existing caller was
  // unaffected — wrong, and the #626 tests said so immediately: `.length` survives that
  // but `assert.deepEqual` compares own properties, so four passing tests went red. A
  // caller that does not ask for rejections gets exactly the array it always got.
  if (out && typeof out === "object") out.rejected = rejected;
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

/**
 * Which unavailable entries a node of the SAME CLASS, already live on the canvas,
 * does NOT explain (#636).
 *
 * The type reasoning above asks what SHOULD happen: does some node output this
 * datatype, does this input declare itself socket-shaped. On a backend where nothing
 * outputs the type, a socket-shaped input has no proof and fails closed forever — no
 * retry can change it, because every input to the decision is a snapshot. That is the
 * reported case: `SaveVideo` refused for `VIDEO` on an install whose node set never
 * outputs one.
 *
 * A live node of that class answers a different question: what DID happen. ComfyUI
 * already built this class on THIS backend — an input that came out as a link SLOT is a
 * socket, one that came out as a WIDGET had its constructor.
 *
 * It is a WITNESS, not a proof (codex). A widget can survive from an earlier
 * registration, or have been converted to a slot, so it does not guarantee a fresh node
 * materialises identically — and the argument must NOT rest on "extensions never
 * unregister". What makes admitting it safe is that it only permits an ATTEMPT: the
 * newly created node still goes through missingRequiredWidgetMaterializations before any
 * success is reported, and that post-creation check is the real soundness boundary. The
 * worst case here is a creation attempt that then fails closed.
 *
 * So this is deliberately NOT a relaxation of the type rules. It adds evidence rather
 * than lowering a bar: an input the live node does not account for stays unavailable, so
 * #580's protection is untouched for every case this cannot observe.
 *
 * Requires EVERY input carrying the type to be accounted for. A def can require the same
 * datatype twice, and explaining one occurrence says nothing about the other — the same
 * "every, not some" rule the socket/widget split above is built on.
 */
export function unavailableEntriesLiveNodeCannotExplain(report, liveNode) {
  if (!Array.isArray(report) || !report.length) return [];
  if (!liveNode || typeof liveNode !== "object") return report;
  let widgetNames;
  let slotNames;
  try {
    widgetNames = new Set(
      (Array.isArray(liveNode.widgets) ? liveNode.widgets : [])
        .map((w) => (w && typeof w.name === "string" ? w.name : null))
        .filter(Boolean),
    );
    slotNames = new Set(
      (Array.isArray(liveNode.inputs) ? liveNode.inputs : [])
        .map((i) => (i && typeof i.name === "string" ? i.name : null))
        .filter(Boolean),
    );
  } catch {
    return report; // an unreadable node explains nothing
  }
  return report.filter((entry) => {
    const inputs = Array.isArray(entry?.inputs) ? entry.inputs : [];
    if (!inputs.length) return true; // nothing to check against ⇒ unexplained
    return !inputs.every((name) => widgetNames.has(name) || slotNames.has(name));
  });
}
