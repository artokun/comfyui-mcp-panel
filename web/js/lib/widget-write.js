// Widget-value validation + promoted-subgraph-widget target resolution for
// graph_set_widget. Extracted so the write targets the RIGHT widget with the
// RIGHT value and can be unit-tested by driving the SAME code path the handler
// runs (applyWidgetWrite), not a parallel reimplementation.
//
// Three graph-integrity bugs motivate this module:
//   #233 — panel_set_widget on a SUBGRAPH node's PROMOTED widget wrote by a
//          positionally-shifted slot and silently corrupted a DIFFERENT inner
//          widget (an INT slot ended up holding "euler"), reporting success.
//   #240 — a COMBO widget set to a valid enum silently drifted to a different
//          option (index-vs-value reinterpretation).
//   #366 — a PROMOTED widget write landed on the INNER node only; the parent's
//          own rail widget (what serializes at queue time) stayed stale, so the
//          render used the OLD value while the tool reported success (silent
//          wrong output).
//
// Safety contract (all three bugs are silent corruption; we NEVER fail open):
//   * A promoted widget resolves to its ACTUAL inner (node, widget) and the
//     write lands THERE. If it looks promoted but cannot be resolved
//     unambiguously, we THROW before mutating — never fall back to the shifted
//     parent slot.
//   * A promoted write also writes the AUTHORITATIVE parent rail widget —
//     identified by the promotion RELATIONSHIP (host-input↔widget backlink), never
//     a name/label guess — ATOMICALLY with the inner write (one undo; rollback +
//     throw on any callback failure, so never inner=new/parent=stale). If the
//     parent rail widget cannot be positively identified, we FAIL CLOSED (throw)
//     rather than write inner-only and render silently stale (#366).
//   * The value is validated against the target widget's declared type and
//     REJECTED on mismatch (combo must be an exact CURRENT option; numeric must
//     be numeric; boolean must be boolean; a combo whose options we cannot read
//     is refused, not written blindly).

export class WidgetWriteError extends Error {
  constructor(message, { combo = false, emptyOptions = false } = {}) {
    super(message);
    this.name = "WidgetWriteError";
    // `emptyOptions` narrows `combo` to the ONE case runSetWidget's #507 last-resort
    // path may act on: the option list was READ successfully and is EMPTY. It is set
    // ONLY by that branch, so the caller never has to pattern-match a message, and a
    // plain "not a valid option" rejection can never be mistaken for it.
    this.emptyOptions = emptyOptions;
    // `combo` marks the failure as "combo value rejected against the current
    // option list" (unreadable OR not-a-member). runSetWidget uses this as the
    // ONLY signal that a stale-combo refresh + single revalidation may help —
    // no other validation failure (numeric/boolean/promotion/stuck-check) is
    // retryable, so those still fail closed immediately.
    this.combo = combo;
  }
}

/**
 * The current option list for a combo widget, or null if it cannot be read.
 * `options.values` may be an array or a function `(widget) => string[]`
 * (litegraph dynamic combos). A function that throws yields null (unreadable).
 */
export function comboOptions(widget) {
  const raw = widget?.options?.values;
  let vals = raw;
  if (typeof raw === "function") {
    try {
      vals = raw(widget);
    } catch {
      return null;
    }
  }
  return Array.isArray(vals) ? vals : null;
}

export function isComboWidget(widget) {
  if (Array.isArray(widget?.options?.values) || typeof widget?.options?.values === "function") {
    return true;
  }
  return String(widget?.type ?? "").toLowerCase() === "combo";
}

/**
 * #667: the index of the option whose stringified LABEL equals the stringified
 * scalar `value`, or -1. Scalars only (string/number/boolean) on both sides.
 * Used by the combo coercion fallback AND by the #507 empty-list sibling rail
 * cross-check, so both apply the SAME matching rule; callers always write back
 * the list's ORIGINAL option, never the incoming scalar, so no number is ever
 * reinterpreted as an index and no mistyped value lands (#240 intact).
 */
function optionLabelIndex(options, value) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return -1;
  }
  return options.findIndex(
    (o) =>
      (typeof o === "string" || typeof o === "number" || typeof o === "boolean") &&
      String(o) === String(value),
  );
}

// litegraph "number"/"slider" and Comfy "INT"/"FLOAT" all render numeric.
export function isNumericWidget(widget) {
  const t = String(widget?.type ?? "").toLowerCase();
  return t === "number" || t === "slider" || t === "int" || t === "float";
}

export function isBooleanWidget(widget) {
  const t = String(widget?.type ?? "").toLowerCase();
  return t === "toggle" || t === "boolean";
}

/**
 * True for a COMPOSITE widget whose value is a plain object rather than a scalar
 * — e.g. the rgthree Power Lora Loader's `lora_N` rows ({on, lora, strength,
 * strengthTwo, …}). Detected by the CURRENT value's shape (a non-null, non-array
 * object) so it works without an rgthree-specific type tag. Combos are excluded
 * upstream (they are matched before this runs). (#179)
 */
export function isCompositeObjectWidget(widget) {
  const v = widget?.value;
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Resolve a widget name without silently choosing between case-colliding
 * widgets. Exact spelling always wins; a case-insensitive fallback remains for
 * older callers, but only when it names exactly one widget (#524).
 */
function resolveWidgetByName(node, widgetName) {
  const wanted = String(widgetName);
  const widgets = node?.widgets ?? [];
  const exact = widgets.find((cand) => cand?.name === wanted);
  if (exact) return exact;

  const matches = widgets.filter(
    (cand) => typeof cand?.name === "string" && cand.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (matches.length > 1) {
    throw new WidgetWriteError(
      `Node ${node?.id} (${node?.type}) has ${matches.length} widgets matching "${wanted}" ` +
        `case-insensitively (${matches.map((cand) => cand.name).join(", ")}); pass the exact widget name.`,
    );
  }
  return matches[0] ?? null;
}

// DECLARED field schema for known composite widgets. Types are enforced from THIS
// schema, never inferred from the current value — a field whose current value is `null`
// still enforces the correct type, so a scalar of the wrong type (e.g. a number into a
// `lora` filename) can never be written on an EMPTY/cleared row (#560 P0). `nullable`
// marks fields that legitimately hold `null` (an empty slot), so clearing them is
// allowed (#560 P2). rgthree Power Lora Loader slot: {on, lora, strength, strengthTwo}.
const RGTHREE_LORA_SLOT_SCHEMA = {
  on: { type: "boolean", nullable: false },
  lora: { type: "string", nullable: true },
  strength: { type: "number", nullable: false },
  strengthTwo: { type: "number", nullable: true },
};

// True for an rgthree Power Lora Loader slot object. Identified by its KEY-SET SHAPE
// ONLY — the keys are a SUBSET of the rgthree slot keys {on, lora, strength, strengthTwo}
// and include the core {on, lora, strength}. The classification does NOT depend on the
// current VALUES being well-formed: a PARTIALLY-CORRUPT row (e.g. lora already holding a
// number from a prior bad write) must STILL be recognized so the schema is ENFORCED and
// the row is repaired-forward — never fall back to inferring a type from a corrupt value,
// which would accept a further wrong-type write and deepen the corruption.
const RGTHREE_LORA_SLOT_KEYS = new Set(["on", "lora", "strength", "strengthTwo"]);
function isLoraSlotObject(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  if (!keys.every((k) => RGTHREE_LORA_SLOT_KEYS.has(k))) return false; // no foreign/extra keys
  for (const core of ["on", "lora", "strength"]) {
    if (!Object.prototype.hasOwnProperty.call(obj, core)) return false;
  }
  return true;
}

// The declared {type, nullable} schema for `field` of composite `base`, or null when the
// composite is unknown (no declared schema).
function compositeFieldSchema(base, field) {
  if (isLoraSlotObject(base) && Object.prototype.hasOwnProperty.call(RGTHREE_LORA_SLOT_SCHEMA, field)) {
    return RGTHREE_LORA_SLOT_SCHEMA[field];
  }
  return null;
}

// STRICT type coercion to a declared primitive type. Mirrors the whole-widget #240
// strictness. Throws WidgetWriteError on mismatch.
function coerceByType(type, value, where) {
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const s = String(value).toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    throw new WidgetWriteError(`${where} is boolean but value ${JSON.stringify(value)} is not a boolean.`);
  }
  if (type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    throw new WidgetWriteError(`${where} is numeric but value ${JSON.stringify(value)} is not a number.`);
  }
  if (type === "string") {
    if (typeof value === "string") return value;
    throw new WidgetWriteError(`${where} is a string but value ${JSON.stringify(value)} is not a string.`);
  }
  return value;
}

/**
 * Validate + coerce a composite field value. The expected type comes FIRST from the
 * declared schema (so a null current field still enforces the right type, #560 P0), and
 * `null` is accepted only for a nullable field (#560 P2). For an UNKNOWN composite with
 * no schema, fall back to the existing NON-null value's type; a null/undefined current
 * value with no schema is genuinely untyped, so only a primitive is accepted verbatim.
 * Throws WidgetWriteError on a mismatch.
 */
function coerceCompositeFieldValue(widgetName, base, field, value) {
  const where = `sub-field "${widgetName}.${field}"`;
  const schema = compositeFieldSchema(base, field);
  if (schema) {
    if (value === null) {
      if (schema.nullable) return null;
      throw new WidgetWriteError(`${where} is not nullable (expected ${schema.type}).`);
    }
    return coerceByType(schema.type, value, where);
  }
  // Unknown composite: infer the expected type from the EXISTING non-null value.
  const existing = base?.[field];
  if (typeof existing === "boolean") return coerceByType("boolean", value, where);
  if (typeof existing === "number") return coerceByType("number", value, where);
  if (typeof existing === "string") return coerceByType("string", value, where);
  // No schema AND an untyped current value (null/undefined/object): the field's type is
  // genuinely unknowable, so we REFUSE rather than write a possibly-wrong-typed value —
  // #560's principle is a loud, safe failure over silent corruption. (A KNOWN composite,
  // e.g. rgthree, is handled by the schema above and its nullable fields still clear.)
  throw new WidgetWriteError(
    `${where}: cannot validate the value — this composite is not a recognized type and the ` +
      `field's current value is ${existing === undefined ? "undefined" : JSON.stringify(existing)}, ` +
      `so its expected type is unknown. Set a correctly-typed value only if the field already ` +
      `holds one, or edit this widget from the node UI.`,
  );
}

/**
 * Merge `incoming` fields onto composite `base`, FAILING CLOSED on any field that does
 * not already exist (never ADD a member) and validating each value against the field's
 * DECLARED type / an unknown composite's existing type (#560 hardening). Used by BOTH
 * the dotted single-field path and the #179 full-JSON-object path so neither can silently
 * mistype or junk-up a composite row.
 */
function mergeCompositeFields(widgetName, base, incoming) {
  const out = { ...base };
  for (const key of Object.keys(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) {
      throw new WidgetWriteError(
        `Composite widget "${widgetName}" has no field "${key}" ` +
          `(fields: ${Object.keys(base).join(", ") || "none"}). Refusing to add an unknown field.`,
      );
    }
    out[key] = coerceCompositeFieldValue(widgetName, base, key, incoming[key]);
  }
  return out;
}

/**
 * Validate + coerce `value` for `widget`, returning the value to write. Throws
 * WidgetWriteError (never silently coerces to a wrong value) when the value is
 * incompatible with the widget's declared type.
 */
export function coerceWidgetValue(
  widget,
  value,
  mergeBaseWidget = widget,
  subFieldPath = null,
  { acceptEmptyComboOptions = false, out } = {},
) {
  const name = widget?.name ?? "(widget)";

  // #347: distinguish "clear to empty" from "missing value". An EXPLICIT empty
  // string is a valid request to empty a text/string widget (handled by the
  // pass-through at the end); a MISSING value (undefined/null — e.g. an omitted
  // or dropped arg) is not, and must fail loudly instead of silently writing
  // `undefined`. The combo/numeric/boolean branches below still reject "" on
  // their own terms, so #240 strictness is untouched.
  // A MISSING value (undefined) is always refused. An explicit `null` for a WHOLE-widget
  // write is also refused (#347: clear a text widget with ""); but for a SUB-FIELD write
  // `null` is a legitimate CLEAR of a nullable composite field (e.g. `lora_1.lora=null`),
  // so it is allowed through to coerceCompositeFieldValue, which enforces the schema's
  // nullability (a non-nullable field still rejects null).
  if (value === undefined || (value === null && subFieldPath == null)) {
    throw new WidgetWriteError(
      subFieldPath != null
        ? `No value provided for sub-field "${name}.${subFieldPath}".`
        : `No value provided for widget "${name}". To clear a text widget, pass an ` +
            `explicit empty string ("").`,
    );
  }

  // #560: EXPLICIT sub-field addressing (widget "lora_1.on" / "lora_1.strength").
  // Writing a bare scalar to a COMPOSITE object widget (rgthree Power Lora Loader's
  // `lora_N` rows: {on, lora, strength, strengthTwo}) previously corrupted the row —
  // a scalar toggled one field and nulled the rest. Addressing ONE field merges that
  // field onto the CURRENT object and PRESERVES every other field. This runs BEFORE
  // the combo/numeric/boolean branches so a sub-field write is never reinterpreted by
  // the base widget's declared type.
  if (subFieldPath != null && subFieldPath !== "") {
    // Only single-level fields are supported; a nested path needs a per-node schema
    // we do not have — refuse LOUDLY rather than write a wrongly-shaped object.
    if (subFieldPath.includes(".")) {
      throw new WidgetWriteError(
        `Nested sub-field path "${name}.${subFieldPath}" is not supported. Address ONE ` +
          `top-level field (e.g. "${name}.on", "${name}.strength") or pass a full JSON object.`,
      );
    }
    // The AUTHORITATIVE base object to merge onto: the promoted rail's current object
    // when present (#366×#179), else the target widget's own value. The field is only
    // addressable when that base is a real (non-array) object.
    const railBase =
      mergeBaseWidget &&
      mergeBaseWidget.value != null &&
      typeof mergeBaseWidget.value === "object" &&
      !Array.isArray(mergeBaseWidget.value)
        ? mergeBaseWidget.value
        : null;
    const ownBase =
      widget?.value != null && typeof widget.value === "object" && !Array.isArray(widget.value)
        ? widget.value
        : null;
    const base = railBase ?? ownBase;
    if (base == null) {
      throw new WidgetWriteError(
        `Widget "${name}" is not a composite object widget, so its sub-field ` +
          `"${subFieldPath}" cannot be addressed. Sub-field writes (e.g. "lora_1.on") are ` +
          `only valid on widgets whose current value is an object.`,
      );
    }
    // Merge ONLY the addressed field: FAIL CLOSED on an unknown field (a typo like
    // "lora_1.strenght" must not create junk) and validate the value against the
    // existing field's type (no silent mistyping — "false" into a boolean, a number
    // into a filename), mirroring #240 whole-widget strictness. All other fields survive.
    return mergeCompositeFields(name, base, { [subFieldPath]: value });
  }

  if (isComboWidget(widget)) {
    const options = comboOptions(widget);
    // A declared combo whose option list we cannot read cannot be validated —
    // refuse rather than write a value that may be reinterpreted as an index
    // (#240 fail-open). Covers missing options.values and a throwing fn.
    if (!options) {
      throw new WidgetWriteError(
        `Combo widget "${name}" has no readable option list; cannot validate ` +
          `value ${JSON.stringify(value)} — refusing to write.`,
        { combo: true },
      );
    }
    // #507: a DYNAMIC, CLIENT-POPULATED combo declared with an EMPTY option list —
    // e.g. StarNodes' `"model": ((), {...})`, which /object_info reports as
    // `[[], {...}]` and whose dropdown the node's own frontend JS fills at runtime
    // (a "Refresh Models" button). `comboOptions` returns `[]`, which is TRUTHY, so
    // the `!options` guard above never fired and `[].includes(value)` rejected EVERY
    // value — the widget was permanently unwritable by the agent.
    //
    // ZERO options means the option set is NOT KNOWABLE from here — the same state
    // the guard above names, NOT "no value is valid". And the #240 reason for strict
    // membership does not apply: that rule exists so a numeric value cannot be
    // silently reinterpreted as an INDEX into a real list, and with an empty list
    // there is no list to index into. So accept the value as written.
    //
    // This does NOT loosen #233/#240. An empty LIVE list is ambiguous — it can also
    // simply be STALE (never populated yet) while the SERVER publishes a real list —
    // so acceptance is NOT automatic: by default the empty case throws a RETRYABLE
    // combo error, which drives runSetWidget's authoritative /object_info refresh
    // first. Only if the list is STILL empty after that (`acceptEmptyComboOptions`)
    // is the value taken as written. The moment the list is NON-EMPTY — from the
    // server or from the node's own client-side refresh, whichever is richer, since
    // `options` is read from the LIVE widget — strict membership below applies
    // unchanged and an off-list value is refused.
    //
    // Only a SCALAR is ever accepted: an object/array could never be an option under
    // any list and would corrupt the widget, so it fails closed and is marked
    // NON-retryable (no refresh can make it valid).
    if (options.length === 0) {
      if (typeof value === "object") {
        throw new WidgetWriteError(
          `Combo widget "${name}" has an EMPTY option list (a dynamic, client-populated ` +
            `combo), so ${JSON.stringify(value)} cannot be validated against it — and only a ` +
            `scalar (string/number/boolean) can be written to a combo. Refusing to write.`,
        );
      }
      if (acceptEmptyComboOptions) {
        // Record that THIS acceptance — not ordinary membership — is what admitted the
        // value, so applyWidgetWrite can decide the sibling cross-check from the
        // COERCION-TIME verdict. It must never re-read the list to infer this: a
        // stateful dynamic source can answer differently on a second call and would
        // become an escape hatch around the check (codex confirmation round).
        if (out) out.emptyAcceptanceUsed = true;
        return value;
      }
      throw new WidgetWriteError(
        `Combo widget "${name}" has an EMPTY option list; the server's option list may ` +
          `simply be stale — refreshing it before deciding.`,
        { combo: true, emptyOptions: true },
      );
    }
    // STRICT typed membership first: an exact-typed option is always writable.
    if (options.includes(value)) return value;
    // #667: NUMERIC-LABELLED options (VHS ProRes profile ["lt",…,"4444",…], ffv1
    // level ["0","1","3"]). The tool's `value` param is string|number|boolean, so a
    // numeric-looking label can arrive as the NUMBER 4444 after upstream JSON
    // coercion, and strict membership then refused it even though the label sits in
    // the list — the option was unreachable via the panel. Fall back to matching the
    // option's LABEL stringified, and on a match return the option's ORIGINAL value
    // from the list — NEVER the incoming scalar — so no mistyped value lands on the
    // widget and no number is ever reinterpreted as an INDEX: the #240 concern was
    // a number silently read as a dropdown position, and that stays refused below
    // (options ["alpha","beta","gamma"] with value 1 matches no label).
    const labelIdx = optionLabelIndex(options, value);
    if (labelIdx >= 0) return options[labelIdx];
    const preview = options.slice(0, 40).map((o) => JSON.stringify(o)).join(", ");
    throw new WidgetWriteError(
      `Value ${JSON.stringify(value)} is not a valid option for combo widget ` +
        `"${name}". Valid options (${options.length}): ${preview}` +
        (options.length > 40 ? ", …" : ""),
      { combo: true },
    );
  }

  if (isNumericWidget(widget)) {
    // Accept ONLY a finite number, or a non-blank numeric string. Reject
    // arrays/objects/booleans/null/whitespace — Number([])===0 and
    // Number([5])===5 would otherwise silently mutate an INT/FLOAT slot.
    let num;
    if (typeof value === "number" && Number.isFinite(value)) {
      num = value;
    } else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      num = Number(value);
    } else {
      throw new WidgetWriteError(
        `Widget "${name}" is numeric (type ${widget?.type}) but value ` +
          `${JSON.stringify(value)} is not a number.`,
      );
    }
    return num;
  }

  if (isBooleanWidget(widget)) {
    if (typeof value === "boolean") return value;
    const s = String(value).toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    throw new WidgetWriteError(
      `Widget "${name}" is boolean but value ${JSON.stringify(value)} is not ` +
        `a boolean (true/false).`,
    );
  }

  // #179: rgthree Power Lora Loader (and similar) expose a COMPOSITE widget whose
  // value is a plain object ({on, lora, strength, …}), not a scalar. The MCP arg
  // schema allows only string|number|boolean, so a composite is sent as a JSON
  // STRING; writing that string verbatim corrupts the row (rgthree then reads
  // lora=null and drops strength). Parse a JSON-string payload (or accept an
  // object directly) and MERGE onto the current value so fields the caller did
  // not specify (e.g. strengthTwo) are preserved.
  //
  // Detect the composite from the inner widget OR the AUTHORITATIVE promoted RAIL widget
  // (mergeBaseWidget): the value that SERIALIZES is the rail's, so if the rail still holds
  // a composite object while the inner value has gone stale/scalar, the write must STILL
  // be treated as composite — otherwise the JSON payload would fall through as a raw
  // string and clobber the rail (#179/#366 rail-authoritative guarantee).
  if (isCompositeObjectWidget(widget) || isCompositeObjectWidget(mergeBaseWidget)) {
    let incoming = value;
    if (typeof value === "string") {
      try {
        incoming = JSON.parse(value);
      } catch {
        throw new WidgetWriteError(
          `Widget "${name}" holds a composite object value; the string ` +
            `${JSON.stringify(value)} is not valid JSON for it. To change ONE field, ` +
            `address it directly (e.g. "${name}.on" or "${name}.strength"), or pass a full ` +
            `JSON object like {"on":false}.`,
        );
      }
    }
    if (incoming == null || typeof incoming !== "object" || Array.isArray(incoming)) {
      throw new WidgetWriteError(
        `Widget "${name}" is a composite object widget; a bare scalar would corrupt it. ` +
          `Value ${JSON.stringify(value)} must be an object (or JSON object string), e.g. ` +
          `{"on":true,"lora":"name.safetensors","strength":1}. To change ONE field and keep ` +
          `the rest, address it directly: "${name}.on"=false, "${name}.strength"=0.8, or pass ` +
          `a JSON object {"on":false}.`,
      );
    }
    // #366×#179: for a PROMOTED composite, the AUTHORITATIVE base is the RAIL
    // widget's current object (what serializes), not the inner widget's — merging
    // onto a stale inner would clobber the rail's unspecified fields when the same
    // coerced value is written to both. Prefer the rail's object; fall back to the
    // target widget's own value when the rail base isn't a usable object.
    const base =
      mergeBaseWidget && mergeBaseWidget.value != null && typeof mergeBaseWidget.value === "object" && !Array.isArray(mergeBaseWidget.value)
        ? mergeBaseWidget.value
        : widget.value;
    // Validate EACH incoming key against the existing row (fail closed on an unknown
    // field, type-check each value) so a full-object write cannot silently mistype `on`
    // or add junk members either — the same strictness the dotted path enforces (#560).
    const mergeBase =
      base != null && typeof base === "object" && !Array.isArray(base) ? base : {};
    return mergeCompositeFields(name, mergeBase, incoming);
  }

  // STRING / text / unknown widget: pass through unchanged (an explicit "" clears
  // it, #347).
  return value;
}

/**
 * The parent SubgraphNode's OWN projected promoted widget that is backed by
 * `hostInput` — i.e. the widget whose value serializes into the subgraph input
 * rail at queue time (#366).
 *
 * Authenticated by OBJECT IDENTITY, never by a name/label lookup. In the ComfyUI
 * frontend the host input slot stores only a `{ name }` STUB in `input.widget`;
 * the real authoritative rail widget is the PROJECTION object litegraph builds for
 * the slot (`input._widget`), whose get/set `value` proxies the subgraph widget
 * value STORE that is serialized at queue time. `getWidgetFromSlot()` returns that
 * projection when present but otherwise FALLS BACK to a name-based lookup — and a
 * name match (even a unique one) could select an unrelated decoy own-widget while
 * no authenticated rail object exists. So we accept ONLY a candidate that is an
 * actual widget OBJECT AND is `===` a live member of `node.widgets`, and otherwise
 * FAIL CLOSED (return null) — never write inner or parent on a name-only stub.
 */
export function resolveHostPromotedWidgets(subgraphNode, hostInput) {
  if (!subgraphNode || !hostInput) return [];

  // EXTERNALLY-LINKED host input ⇒ the local projected widget is NOT authoritative.
  // When the host input carries an outer link, ComfyUI's queue compiler IGNORES
  // this node's projected widget and recursively follows the OUTER source (the
  // enclosing subgraph's rail); ComfyUI's own promoted-widget control treats
  // `input.link != null` as "host store is non-authoritative". Writing the local
  // widget here would pass verification yet render the enclosing rail's OLD value —
  // a false success. Refuse (→ caller FAILS CLOSED); the widget must be edited from
  // the OUTERMOST subgraph node, where its host input has no outer link.
  if (hostInput.link != null) return [];

  const inWidgets = Array.isArray(subgraphNode.widgets) ? subgraphNode.widgets : [];

  // OBJECT-IDENTITY authentication. A rail/proxy widget must be an actual projection
  // object the host input LINKS to (`_widget`, or an `input.widget` that is itself a
  // real widget object — NOT a `{ name }` stub) AND must be `===` a live member of
  // this node's projected widgets. A name-only stub is an object too, but it is NOT a
  // member of node.widgets, so it is rejected. This never resolves by name, so an
  // unrelated same-named decoy can never be selected (#233/#366).
  //
  // #477: a single host input can reference TWO distinct authenticated widgets — the
  // serializing rail PROJECTION (`_widget`) AND the parent-facing DISPLAY proxy
  // (`input.widget`, a real widget in newer ComfyUI). BOTH belong to this exact
  // promotion by identity and must be synced, or the display proxy renders/queries
  // the OLD value while the tool reports success. Returned in priority order — the
  // FIRST element is the AUTHORITATIVE serializing rail (what #366 verifies).
  const out = [];
  for (const cand of [hostInput._widget, hostInput.widget]) {
    if (cand && typeof cand === "object" && inWidgets.includes(cand) && !out.includes(cand)) {
      out.push(cand);
    }
  }
  return out;
}

/**
 * The single AUTHORITATIVE parent rail widget for `hostInput` — the projection whose
 * value serializes at queue time (#366). This is the FIRST identity-authenticated
 * widget resolveHostPromotedWidgets returns, or null when none can be authenticated
 * (→ caller FAILS CLOSED). Kept as the load-bearing #366 accessor; #477's additional
 * display-proxy widgets are synced via resolveHostPromotedWidgets.
 */
export function resolveHostPromotedWidget(subgraphNode, hostInput) {
  return resolveHostPromotedWidgets(subgraphNode, hostInput)[0] ?? null;
}

/**
 * Classify a widget request on `subgraphNode` against `widgetName` and, when it
 * is a PROMOTED subgraph widget, resolve it to the ACTUAL inner (node, widget)
 * AND the authoritative parent rail widget (via the promotion relationship).
 *
 * Detection matches ONLY the OUTER alias the caller sees on the parent
 * (host-input name/label and the backing subgraph-input name/label) — never the
 * inner source widget name — so a renamed promotion (`scheduler` on the parent
 * mapping to inner `sampler_name`) is followed to the RIGHT inner widget.
 *
 * `resolveSource(subgraphNode, subgraphInput)` walks the subgraph link and
 * returns `{ sourceNodeId, sourceWidgetName }` (the panel injects its live
 * `sourceForSubgraphInput`).
 *
 * Returns a status object — the caller MUST honour it and never fall back to
 * the parent slot when `promoted` is true but `target` is null:
 *   { promoted: false }                                          → not a promoted widget
 *   { promoted: true, target: {node,widget,input,parentWidget,parentWidgets} } → resolved
 *                                                                  inner target (parentWidget
 *                                                                  may be null; parentWidgets
 *                                                                  is every identity-authenticated
 *                                                                  rail/display proxy, #477)
 *   { promoted: true, target: null, error }                      → promoted but UNRESOLVABLE/ambiguous
 */
export function resolvePromotedInnerTarget(subgraphNode, widgetName, resolveSource) {
  const subgraph = subgraphNode?.subgraph;
  if (!subgraph) return { promoted: false };
  const wanted = String(widgetName).toLowerCase();

  // Host inputs whose OUTER alias matches the requested name. We match on the
  // HOST input's own name/label AND (when present) its backing subgraph slot,
  // so a promoted widget is DETECTED even if `_subgraphSlot` is missing — that
  // must fail CLOSED, never fall through to the shifted parent widget.
  const matches = [];
  for (const input of subgraphNode.inputs ?? []) {
    const subgraphInput = input?._subgraphSlot ?? null;
    const aliases = [
      input?.name,
      input?.label,
      subgraphInput?.name,
      subgraphInput?.label,
    ].map((a) => (a == null ? null : String(a).toLowerCase()));
    // Labels are used ONLY to DETECT which promotion the caller meant (a caller
    // may address by a renamed promotion's display label). Locating the parent's
    // authoritative rail widget is done LATER by the promotion RELATIONSHIP
    // (host-input → backing widget), never by a name match (#366/#233).
    if (aliases.includes(wanted)) matches.push({ input, subgraphInput });
  }

  // No matching host input at all ⇒ a genuine non-promoted own-widget.
  if (matches.length === 0) return { promoted: false };
  if (matches.length > 1) {
    return {
      promoted: true,
      target: null,
      error: `promoted widget "${widgetName}" is ambiguous — ${matches.length} promoted inputs match; refusing to guess.`,
    };
  }

  const { input, subgraphInput } = matches[0];
  // It IS a promoted widget, but its backing subgraph slot is absent — we
  // cannot reach the inner target, so refuse rather than corrupt the parent.
  if (!subgraphInput) {
    return {
      promoted: true,
      target: null,
      error: `promoted widget "${widgetName}" has no backing subgraph slot (_subgraphSlot missing) — cannot resolve inner target.`,
    };
  }
  if (typeof resolveSource !== "function") {
    return {
      promoted: true,
      target: null,
      error: `no resolver available for promoted widget "${widgetName}".`,
    };
  }
  const source = resolveSource(subgraphNode, subgraphInput);
  if (!source) {
    return {
      promoted: true,
      target: null,
      error: `promoted widget "${widgetName}" has no resolvable inner link (stale/empty linkIds).`,
    };
  }
  const innerNode =
    typeof subgraph.getNodeById === "function"
      ? subgraph.getNodeById(source.sourceNodeId)
      : (subgraph._nodes ?? []).find((n) => String(n?.id) === String(source.sourceNodeId));
  if (!innerNode) {
    return {
      promoted: true,
      target: null,
      error: `promoted widget "${widgetName}" links to missing inner node ${source.sourceNodeId}.`,
    };
  }
  const innerWidget = (innerNode.widgets ?? []).find((w) => w?.name === source.sourceWidgetName);
  if (!innerWidget) {
    return {
      promoted: true,
      target: null,
      error: `promoted widget "${widgetName}" links to missing inner widget "${source.sourceWidgetName}" on node ${source.sourceNodeId}.`,
    };
  }
  // AUTHENTICATE the parent's own rail widget by the PROMOTION RELATIONSHIP — the
  // host-input's backing widget — not by any name/label match. This is the widget
  // that serializes into the subgraph input rail at queue time (#366). May be null
  // (e.g. the widget is further promoted OUTWARD to an enclosing subgraph and is
  // exposed here as an input with no settable widget); the caller FAILS CLOSED on
  // null rather than write inner-only and render silently stale.
  const parentWidgets = resolveHostPromotedWidgets(subgraphNode, input);
  const parentWidget = parentWidgets[0] ?? null;
  return { promoted: true, target: { node: innerNode, widget: innerWidget, input, parentWidget, parentWidgets } };
}

/**
 * Follow a promoted write target through any NESTED SubgraphNodes to the ULTIMATE
 * CONCRETE backend node (#458 nested-promotion false-failure). ComfyUI supports
 * promoting an outer subgraph widget from an INNER subgraph that itself promotes from
 * a real node (A → B → KSampler). The immediate resolved target of the outer
 * promotion is the inner SubgraphNode (B) — a VIRTUAL node whose subgraph-id type is
 * absent from /object_info, so authorizing THAT against the backend would wrongly
 * refuse a valid write. Traverse the chain until a node with no `.subgraph` (the
 * concrete backend node) is reached, and return it for fresh authorization; a virtual
 * SubgraphNode type in the chain is TRAVERSED, never authorized. Pure: read-only.
 *
 * `target` is the immediate `{ node, widget }` from resolvePromotedInnerTarget.
 * Returns (always carrying the widget reached at the terminal, for combo-refresh
 * name mapping — nested promotions may RENAME the widget at each level, #366):
 *   { node, widget }                        → the CONCRETE backend node + its widget
 *   { node, widget, terminalVirtual: true } → chain ended on a virtual node's OWN
 *                                             (non-promoted) widget; authorize its type
 *   { node: null, widget: null, error }     → a deeper promotion link is unresolvable
 *   { node, widget, cycle: true }           → a promotion cycle was detected (defensive)
 */
export function followPromotionToConcrete(target, resolveSource) {
  let node = target?.node ?? null;
  let widget = target?.widget ?? null;
  const seen = new Set();
  while (node && node.subgraph) {
    if (seen.has(node)) return { node, widget, cycle: true };
    seen.add(node);
    const res = resolvePromotedInnerTarget(node, widget?.name, resolveSource);
    if (!res.promoted) return { node, widget, terminalVirtual: true };
    if (!res.target) return { node: null, widget: null, error: res.error };
    node = res.target.node;
    widget = res.target.widget;
  }
  return { node, widget };
}

/**
 * Collect EVERY INTERMEDIATE virtual SubgraphNode traversed from `target` (the
 * immediate promoted inner) down to — but EXCLUDING — the ultimate concrete node. A
 * nested promotion drives the value THROUGH each of these containers, so each must be
 * authorized (#458 nested-intermediate) — not just the immediate inner and the
 * terminal. Returns nodes in order [immediate, …deeper]; the concrete terminal (no
 * `.subgraph`) is never included, and traversal stops on an unresolvable/cyclic chain
 * (those fail closed elsewhere). Pure: read-only. Mirrors followPromotionToConcrete's
 * walk so the SAME chain is authorized that the write actually drives.
 */
export function collectPromotionIntermediates(target, resolveSource) {
  const out = [];
  let node = target?.node ?? null;
  let widget = target?.widget ?? null;
  const seen = new Set();
  while (node && node.subgraph) {
    if (seen.has(node)) break;
    seen.add(node);
    out.push(node);
    const res = resolvePromotedInnerTarget(node, widget?.name, resolveSource);
    if (!res.promoted || !res.target) break;
    node = res.target.node;
    widget = res.target.widget;
  }
  return out;
}

/**
 * Resolve the true write target (inner promoted widget or the node's own
 * widget) and validate/coerce the value. Throws WidgetWriteError on any
 * unresolved-promotion, missing-widget, or value-mismatch condition — BEFORE
 * any mutation. Pure: no graph side effects.
 */
export function resolveWidgetWrite(
  node,
  widgetName,
  value,
  resolveSource,
  assertTargetWritable,
  promotedResolution,
  coerceOpts,
) {
  let targetNode = node;
  let widget = null;
  let promotedFrom = null;
  let promotedParentWidget = null;
  let promotedParentWidgets = [];
  let promotedHostInput = null;
  // #560: sub-field addressing ("lora_1.on") is derived AFTER an exact-name lookup
  // fails — never by pre-splitting the caller's name — so a real widget whose own
  // name contains a dot is never hijacked.
  let subFieldPath = null;

  if (node?.subgraph) {
    // Reuse a promotion resolution the caller already computed (graph_set_widget
    // resolves it ONCE up front to fresh-authorize the inner target, #458), so the
    // write targets the IDENTICAL inner node it authorized — a relink between the
    // async /object_info fetch and the write can't swap in an unauthorized target.
    // Falls back to resolving here for direct callers (e.g. unit fixtures).
    const res = promotedResolution ?? resolvePromotedInnerTarget(node, widgetName, resolveSource);
    if (res.promoted) {
      // Promoted widget: use the resolved inner widget DIRECTLY. Never re-search
      // the inner node by the OUTER name (a rename would hit the wrong inner
      // widget), and never fall back to the shifted parent slot on failure.
      if (!res.target) {
        throw new WidgetWriteError(
          res.error || `promoted widget "${widgetName}" could not be resolved to an inner widget.`,
        );
      }
      targetNode = res.target.node;
      widget = res.target.widget;
      promotedFrom = { subgraph_node_id: node.id, inner_node_id: res.target.node.id };
      promotedHostInput = res.target.input;
      // The AUTHORITATIVE parent rail widget (backed by the host input via the
      // promotion relationship). Null ⇒ FAIL CLOSED right here — BEFORE the
      // assertTargetWritable gate and BEFORE any (potentially side-effecting)
      // coercion. coerceWidgetValue may INVOKE a dynamic combo's
      // `options.values(widget)` callback which can mutate the inner widget; if we
      // refused only after coercion, a missing/linked/ambiguous rail could leave an
      // uncaptured inner mutation. Refusing first guarantees a promoted write with
      // no authoritative rail performs NO side effect at all (#366).
      promotedParentWidget = res.target.parentWidget ?? null;
      // #477: EVERY identity-authenticated projection this host input references —
      // the serializing rail AND the parent-facing display proxy. All are synced +
      // rolled back atomically so no proxy renders/queries the stale value. Falls
      // back to the single primary for older resolutions that omit the list.
      promotedParentWidgets =
        Array.isArray(res.target.parentWidgets) && res.target.parentWidgets.length
          ? res.target.parentWidgets
          : promotedParentWidget
            ? [promotedParentWidget]
            : [];
      if (!promotedParentWidget) {
        throw new WidgetWriteError(
          `promoted widget "${widgetName}" on subgraph node ${node.id} resolves to an inner ` +
            `widget, but its AUTHORITATIVE parent rail widget could not be identified (the value ` +
            `that serializes at queue time). This happens when the widget is further promoted to ` +
            `an enclosing subgraph (fed by an outer link / exposed as an input, not a settable ` +
            `widget), the promotion metadata is malformed, or its name is duplicated. Refusing to ` +
            `write the inner widget alone, which would silently render the OLD value (#366). Edit ` +
            `this widget from the outermost subgraph node, or disconnect the inner input to make ` +
            `the inner value authoritative.`,
        );
      }
    }
  }

  if (!widget) {
    // EXACT-NAME FIRST: a widget whose own name is literally `widgetName` (dots and
    // all) always wins — the split is never taken when an exact match exists.
    widget = resolveWidgetByName(targetNode, widgetName);
  }
  if (!widget && node?.subgraph) {
    // #560 SAFETY: on a SUBGRAPH parent, a dotted name that did not resolve as a
    // promotion alias must NOT fall through to the base-name dotted fallback below —
    // that would write the parent's projected RAIL widget DIRECTLY, bypassing the
    // atomic inner+rail #366 path (inner left stale, silent partial). A promoted
    // composite is driven with a FULL JSON object on the promoted widget instead,
    // which goes through the #366 merge. Refuse the dotted form loudly here.
    const nameStr = String(widgetName);
    if (nameStr.indexOf(".") > 0) {
      const baseName = nameStr.slice(0, nameStr.indexOf("."));
      throw new WidgetWriteError(
        `Dotted sub-field addressing ("${widgetName}") is not supported on subgraph node ` +
          `${node.id}. If "${baseName}" is a promoted composite widget, set it with a full JSON ` +
          `object (e.g. {"on":false}) so the promoted inner + rail update atomically (#366); ` +
          `otherwise address it from the node that owns the widget.`,
      );
    }
  }
  if (!widget) {
    // #560: no exact widget — try DOTTED sub-field addressing ("lora_1.on") on a DIRECT
    // node. Resolve the BASE widget (before the first dot); the field is only
    // addressable when the base is a COMPOSITE object widget. An empty suffix ("foo.")
    // is rejected LOUDLY rather than silently degrading to a bare write on the base.
    const nameStr = String(widgetName);
    const dot = nameStr.indexOf(".");
    if (dot > 0) {
      const baseName = nameStr.slice(0, dot);
      const sub = nameStr.slice(dot + 1);
      const baseWidget = resolveWidgetByName(targetNode, baseName);
      if (baseWidget) {
        if (sub === "") {
          throw new WidgetWriteError(
            `Widget "${widgetName}" has an empty sub-field after the dot. Address a field, ` +
              `e.g. "${baseName}.on" or "${baseName}.strength".`,
          );
        }
        if (!isCompositeObjectWidget(baseWidget)) {
          throw new WidgetWriteError(
            `Widget "${baseName}" is not a composite object widget, so its sub-field ` +
              `"${sub}" cannot be addressed. Sub-field writes are only valid on widgets ` +
              `whose current value is an object (e.g. an rgthree Power Lora Loader row).`,
          );
        }
        widget = baseWidget;
        subFieldPath = sub;
      }
    }
  }
  if (!widget) {
    const names = (targetNode.widgets ?? []).map((cand) => cand?.name).join(", ");
    throw new WidgetWriteError(
      `Node ${targetNode.id} (${targetNode.type}) has no widget "${widgetName}" (available: ${names || "none"}).`,
    );
  }

  // Gate on the RESOLVED target BEFORE coercion (#458). coerceWidgetValue reads —
  // and thus may INVOKE — a dynamic combo's `options.values(widget)` callback,
  // which can mutate; so the registration/placeholder refusal must land here,
  // before ANY value handling touches the (possibly placeholder) node. The panel
  // injects a registry check; it throws to refuse.
  assertTargetWritable?.(targetNode, widget);

  // For a promoted COMPOSITE write, merge onto the AUTHORITATIVE rail widget's
  // current object (#366×#179) so its unspecified fields are preserved; scalars are
  // unaffected (they don't merge). Non-promoted writes merge onto their own value.
  // (A promoted write with no authoritative rail already threw above, BEFORE this
  // possibly side-effecting coercion — so `promotedParentWidget` is non-null here.)
  const coerced = coerceWidgetValue(widget, value, promotedParentWidget ?? widget, subFieldPath, coerceOpts);

  return { targetNode, widget, coerced, promotedFrom, promotedParentWidget, promotedParentWidgets, promotedHostInput };
}

/**
 * The COMPLETE graph_set_widget body as a driveable unit: resolve target →
 * validate/coerce → write (with the widget's own callback) → verify the value
 * stuck EXACTLY (fail loudly on drift, #240). Graph hooks are injected so this
 * runs both live and under unit test. Throws WidgetWriteError on any failure.
 */
export function applyWidgetWrite(
  node,
  widgetName,
  value,
  {
    resolveSource,
    canvas,
    beforeChange,
    afterChange,
    setDirty,
    assertTargetWritable,
    promotedResolution,
    // #507: only the FINAL attempt (after the authoritative /object_info combo refresh
    // has had its chance) may treat a still-EMPTY combo option list as "not knowable"
    // and take the value as written. Default false ⇒ the empty case is a RETRYABLE
    // combo rejection, so a merely-stale empty list is refreshed before any decision.
    acceptEmptyComboOptions = false,
  } = {},
) {
  // resolveWidgetWrite runs assertTargetWritable on the RESOLVED target (inner
  // promoted node for a subgraph write, or the node's own) BEFORE it coerces the
  // value, so no coercion callback and no mutation can touch an unregistered
  // placeholder that is about to be refused (#458). A caller-supplied
  // promotedResolution is reused so the write targets the EXACT node the fresh
  // /object_info gate authorized (#458), and resolveWidgetWrite also fails closed if
  // the AUTHORITATIVE parent rail widget can't be identified (#366).
  const coerceOutcome = {};
  // `coerced` is mutable: the #507 empty-list sibling cross-check below may ADOPT a
  // rail option's original value when the numeric-labelled fallback matches there
  // (#667 codex round-3) — the write then lands the list's own value, not the
  // caller's coerced scalar.
  let { targetNode, widget: w, coerced, promotedFrom, promotedParentWidget, promotedParentWidgets, promotedHostInput } =
    resolveWidgetWrite(node, widgetName, value, resolveSource, assertTargetWritable, promotedResolution, {
      acceptEmptyComboOptions,
      // Filled in by coerceWidgetValue when the EMPTY-LIST acceptance (not ordinary
      // membership) is what admitted the value. Read below — never re-derived.
      out: coerceOutcome,
    });

  // #366: for a promoted subgraph widget the AUTHORITATIVE value lives on the
  // parent's OWN rail widget (resolved by the promotion RELATIONSHIP in
  // resolveWidgetWrite, which already FAILED CLOSED if it could not be identified).
  // We now write BOTH the inner widget AND the parent rail widget ATOMICALLY inside
  // one undo envelope: either both land, or neither does and we throw — a thrown
  // callback on EITHER side must never leave inner=new / parent=stale (a silent
  // partial write that renders the OLD value while reporting success).
  const parentWidget = promotedFrom ? promotedParentWidget : null;
  // #477: the SECONDARY parent-facing DISPLAY proxy widgets this promotion references
  // by identity (every authenticated projection beyond the authoritative rail). #366
  // synced only the primary rail, leaving a distinct display proxy stale so a query of
  // the parent node saw the OLD value even though the tool reported success. Sync +
  // roll them back alongside the rail, atomically. Empty for the common single-widget
  // shape (all existing #366/#233 fixtures), so those paths are byte-identical; and
  // resolved by IDENTITY, never by name, so a same-named decoy is never touched (#233).
  const displayWidgets =
    promotedFrom && Array.isArray(promotedParentWidgets)
      ? promotedParentWidgets.filter((dw) => dw && dw !== w && dw !== parentWidget)
      : [];

  // #507 (codex round-3, MODERATE): coerceWidgetValue validated the value against the
  // IMMEDIATE inner widget's option list only — but a promoted write assigns the SAME
  // value to the parent's authoritative RAIL widget and to every display proxy, whose
  // own option lists can DIFFER from the inner's. That is harmless while the inner list
  // is authoritative, but the empty-list acceptance deliberately writes a value nothing
  // validated, so an inner combo that is (server-declared) EMPTY could push an OFF-LIST
  // value into a rail/proxy that DOES have a real list. Scoped strictly to that path:
  // when acceptEmptyComboOptions is in force, every OTHER mutated combo with a readable
  // NON-EMPTY list must contain the value, or the whole write fails closed BEFORE any
  // mutation. A rail whose own list is unreadable or empty adds no information and is
  // skipped (the inner's server declaration already governs).
  // …and ONLY when the EMPTY-LIST acceptance is what actually admitted the value. Keying
  // on the caller's FLAG alone over-reached: with a stateful inner options function the
  // final attempt may have been validated by ordinary membership, and refusing the rail
  // then would be the very "guard rejects a legitimate case" bug this PR exists to fix.
  // The verdict is taken from COERCION TIME (coerceOutcome, set inside coerceWidgetValue)
  // and never re-derived by reading the list again: a second read of a stateful dynamic
  // source can disagree with the first, which would turn the narrowing into an escape
  // hatch around this very check (codex confirmation round).
  if (coerceOutcome.emptyAcceptanceUsed) {
    let adoptedOption = false;
    // Each sibling's option list AS READ during admission. A STATEFUL non-function
    // source (an accessor/proxy answering differently per read) must not be read a
    // second time: the post-adoption re-validation below checks the SAME snapshots
    // admission was decided against — a fresh read could produce a false DISAGREE
    // or pass against a list that has since changed (codex delta-gate 2), the same
    // never-read-twice rule `emptyAcceptanceUsed` itself follows (above).
    const siblingSnapshots = [];
    for (const other of [parentWidget, ...displayWidgets]) {
      if (!other || !isComboWidget(other)) continue;
      // A DYNAMIC (function) sibling list is UNVERIFIABLE from here (codex round-5): it
      // can return [] during this check and a real, non-empty list immediately afterwards
      // — a one-shot read proves nothing, and the off-list value would still land on the
      // mutated, serializing rail. Only the value's membership matters, and we cannot
      // establish it, so fail closed rather than report a success we cannot stand behind.
      if (typeof other.options?.values === "function") {
        throw new WidgetWriteError(
          `Cannot verify value ${JSON.stringify(coerced)} against the parent subgraph's combo ` +
            `widget "${other.name}", which this promoted write also mutates: its option list is ` +
            `computed dynamically and the inner widget's list is empty, so nothing authoritative ` +
            `validates the value. Refusing to write.`,
        );
      }
      const otherOptions = comboOptions(other);
      if (!Array.isArray(otherOptions) || otherOptions.length === 0) continue;
      // Snapshot the list AS READ (a stateful non-function source can answer
      // differently per read — the re-validation below must check the SAME list
      // admission was decided against, codex delta-gate 2). The copy itself can
      // throw: a buggy-but-in-scope array with a THROWING later-index getter must
      // not crash a write `includes()` would admit from an early member (codex
      // final gate) — so a failed copy records a NULL snapshot and admission
      // proceeds exactly as before. Only if an adoption later REPLACES the value
      // does the missing snapshot matter, and then the write fails closed (below)
      // rather than skip re-validation.
      let snapshot = null;
      try {
        snapshot = otherOptions.slice();
      } catch {
        snapshot = null;
      }
      siblingSnapshots.push({ name: other.name, options: snapshot });
      if (otherOptions.includes(coerced)) continue;
      // #667 (codex round-3): the SAME numeric-labelled-option rule applies here —
      // a numeric request (4444) against a rail list holding the string "4444" must
      // not refuse an option the rail itself publishes. On a label match ADOPT the
      // rail list's ORIGINAL value for the whole write (the inner's empty list
      // accepted any scalar, so writing the rail's own option there is at least as
      // valid), never the incoming scalar — the #240 no-index guarantee holds.
      const siblingLabelIdx = optionLabelIndex(otherOptions, coerced);
      if (siblingLabelIdx >= 0) {
        adoptedOption = true;
        coerced = otherOptions[siblingLabelIdx];
        continue;
      }
      throw new WidgetWriteError(
        `Value ${JSON.stringify(coerced)} is not a valid option for the parent subgraph's ` +
          `combo widget "${other.name}" (${otherOptions.length} options), which this promoted ` +
          `write also mutates — the inner widget's option list is empty, but this one is not. ` +
          `Refusing to write.`,
      );
    }
    // Codex delta-gate: an adoption REPLACES the value mid-loop, and a later sibling
    // can adopt a DIFFERENTLY-TYPED original of the same label (rail lists "4444",
    // a display proxy lists 4444) — the final write would then land a value an
    // earlier-validated sibling's list does not contain. When any adoption
    // happened, re-validate the FINAL value against every sibling's SNAPSHOT: a
    // sibling that does not strictly contain it conflicts (same label, different
    // type — or the value absent there), so no single value satisfies every list;
    // fail closed.
    if (adoptedOption) {
      for (const snap of siblingSnapshots) {
        // A NULL snapshot (the list could not be fully copied — a member access
        // threw) means the adopted value cannot be re-validated against this
        // sibling at all: fail closed rather than skip the check. A snapshot's
        // elements are plain copies, so `includes` here cannot throw.
        if (snap.options && snap.options.includes(coerced)) continue;
        throw new WidgetWriteError(
          snap.options
            ? `The sibling combo widgets this promoted write mutates DISAGREE about option ` +
              `${JSON.stringify(coerced)}: after matching it by label, "${snap.name}"'s list ` +
              `(${snap.options.length} options) does not contain the resulting value — the lists ` +
              `hold the same label with different types (or not at all), so no single value ` +
              `satisfies every list. Refusing to write.`
            : `The sibling combo widget "${snap.name}"'s option list could not be fully read ` +
              `(a member access threw), so the label-adopted value ${JSON.stringify(coerced)} ` +
              `cannot be re-validated against it. Refusing to write.`,
        );
      }
    }
  }

  // Snapshot the EXPECTED value BEFORE the callback runs. For a COMPOSITE object
  // write (#179) `w.value` and `coerced` are the SAME reference, so a callback
  // that mutates the object IN PLACE would change our "expected" too — making a
  // post-hoc compare trivially pass and hiding real drift. A structural clone
  // taken up front preserves the drift check (a scalar clones to itself).
  const objectWrite = coerced !== null && typeof coerced === "object";
  const expected = objectWrite ? JSON.parse(JSON.stringify(coerced)) : coerced;

  const matchesExpected = (actual) =>
    objectWrite
      ? actual !== null &&
        typeof actual === "object" &&
        Object.keys(expected).every((k) => JSON.stringify(actual[k]) === JSON.stringify(expected[k]))
      : actual === expected;

  // Snapshot the PRIOR values AND deep clones of them. Rollback restores the prior
  // OBJECT REFERENCE (`previous`), but a subsequent afterChange hook could mutate
  // that object IN PLACE (e.g. `inner.value.strength = …`), so an identity compare
  // (Object.is) would pass while the restored object holds corrupted fields. We
  // verify rollback STRUCTURALLY against the pre-mutation deep clone instead.
  // `panel_set_widget` is addressed to the OUTER subgraph widget, even though a
  // promoted write mutates its inner implementation widget too. Its result must
  // therefore report the prior value the caller could observe on the requested
  // outer rail, not the (potentially divergent) inner widget's prior value (#583).
  // Keep the latter separately for diagnostics; it is not the API-level
  // `previous` for a promoted request.
  const previous = w.value;
  const previousParent = parentWidget ? parentWidget.value : undefined;
  const deepClone = (v) => (v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);
  const structurallyEqual = (a, b) =>
    (a !== null && typeof a === "object") || (b !== null && typeof b === "object")
      ? JSON.stringify(a) === JSON.stringify(b)
      : Object.is(a, b);
  const previousClone = deepClone(previous);
  const previousParentClone = parentWidget ? deepClone(previousParent) : undefined;
  // #477: prior values (+ deep clones) of the secondary display proxies, so rollback
  // restores them exactly and a stateful hook mutating a restored object in place is
  // caught structurally, mirroring the rail's rollback rigor.
  const previousDisplays = displayWidgets.map((dw) => dw.value);
  const previousDisplayClones = displayWidgets.map((dw) => deepClone(dw.value));
  // The ACTUAL serialization binding for an unlinked subgraph input is its
  // `widgetId` (the widget-value STORE key that queue compilation reads). A callback
  // could keep the SAME host input and projection objects but re-point `widgetId` to
  // another store entry holding the OLD value — passing every object-identity check
  // while the render reads the stale entry. Snapshot it so the recheck can detect a
  // swap (#366).
  const promotedHostWidgetId = promotedHostInput ? promotedHostInput.widgetId : undefined;
  // #477: snapshot the promotion TOPOLOGY (the host input's projection references), so
  // a rollback restores not just the values but the WIRING. A callback can swap
  // `hostInput.widget`/`_widget` to a live replacement proxy; the drift recheck catches
  // it and throws, but without restoring these refs the replacement stays installed
  // after a "clean" rollback — violating the atomic snapshot→verify→rollback contract.
  const promotedHostWidgetRef = promotedHostInput ? promotedHostInput.widget : undefined;
  const promotedHostProjectionRef = promotedHostInput ? promotedHostInput._widget : undefined;
  // #477 P1: snapshot the OUTER node's widget-LIST membership too. Authentication of a
  // rail/proxy is by identity-membership in node.widgets (resolveHostPromotedWidgets),
  // so a callback that not only swaps hostInput.widget but ALSO replaces/reorders
  // node.widgets (natural cleanup when substituting a live proxy) detaches a captured
  // proxy while leaving a replacement live. Restoring only the host refs would leave
  // node.widgets corrupt yet pass read-back. Snapshot the array REFERENCE + its contents
  // so rollback re-points and refills it, and read-back verifies membership/order.
  const prevOuterWidgetsRef = promotedFrom && Array.isArray(node.widgets) ? node.widgets : null;
  const prevOuterWidgets = prevOuterWidgetsRef ? prevOuterWidgetsRef.slice() : null;

  // The undo hooks are BOOKKEEPING (litegraph history). Invoke them exception-SAFE
  // so a throwing hook can never bypass our verification/rollback and leave a silent
  // partial write; a stateful hook that mutates values is still caught because ALL
  // verification runs AFTER the hook fires.
  const safeBefore = () => {
    try {
      beforeChange?.();
    } catch {
      /* history hook is best-effort */
    }
  };
  const safeAfter = () => {
    try {
      afterChange?.();
    } catch {
      /* history hook is best-effort */
    }
  };

  // Perform the write + callbacks inside ONE undo envelope. A thrown callback is
  // CAPTURED (not rethrown here) so that VERIFICATION runs AFTER afterChange has
  // fired its hooks: an afterChange hook can itself re-stale a widget or change the
  // promotion topology, and that must be caught too (not just callback-time drift).
  let threw = null;
  safeBefore();
  try {
    // Assign BOTH values first. The parent's projected promoted widget is a VIEW of
    // the inner widget; its own callback typically FORWARDS to the inner one, so we
    // fire the SEMANTIC widget callback exactly ONCE (the inner target's), NOT the
    // rail's — otherwise a forwarding view would double-invoke the side effect. The
    // rail's value serializes directly from `parentWidget.value`, which we set here,
    // so it needs no callback of its own.
    w.value = coerced;
    if (parentWidget) parentWidget.value = coerced;
    // #477: sync the parent-facing DISPLAY proxies too. They are VIEWS of the same
    // promoted value (no semantic callback of their own — the inner target's fires
    // once below), so we assign their value directly, same as the rail.
    for (const dw of displayWidgets) dw.value = coerced;
    // Fire the inner widget's own callback so combo/number side effects run — the
    // same single invocation a manual UI edit of the promoted control performs.
    w.callback?.(coerced, canvas, targetNode, targetNode.pos, undefined);
  } catch (err) {
    // #639 (codex round-3 + delta-gate): WHICH construct threw is NOT recorded — a
    // value setter can invoke the callback itself, `w.callback` can be a throwing
    // accessor, a setter can throw before OR after applying, a rail/proxy setter
    // or a `targetNode.pos` getter can throw, and a write to a frozen widget
    // throws with no user code at all — so no attribution the mechanism cannot
    // establish is ever reported. The disclosure below names none of them.
    threw = err;
  } finally {
    safeAfter();
  }

  // VERIFY AFTER afterChange. Compute the failure reason (if any) WITHOUT mutating,
  // so rollback happens in its own envelope below. Order: a value that did not stick
  // on the inner (#240) or the authoritative rail (#366); then a promotion-
  // relationship change (re-resolved from the LIVE graph, catching an outer link, a
  // replaced/detached host input, or a re-pointed slot→widget map).
  //
  // #639: a THROWN callback is deliberately NOT a verdict in this chain. The value
  // assignments above run BEFORE the callback fires, so when the callback throws the
  // write may ALREADY be in effect (MiniMaxH3Director's `duration`: the extension's
  // own callback throws on `options` of undefined on ANY programmatic invocation,
  // which made the widget permanently unwritable when any throw forced a refusal).
  // Rolling a VERIFIED write back and refusing would report failure for work that
  // succeeded and invite a destructive retry — so the structural checks below
  // decide. A throw on a verified write is DISCLOSED on the success result
  // (`write_warning`); only a write that ALSO fails verification fails + rolls
  // back, with the throw named as the likely cause.
  let failure = null;
  let originalErr = null;
  let driftFailure = false;
  let writeWarning = null;
  if (!matchesExpected(w.value)) {
    failure =
      `Widget "${w.name}" on node ${targetNode.id} (${targetNode.type}) did not retain the ` +
      `requested value: wrote ${JSON.stringify(expected)} but it became ${JSON.stringify(w.value)}.`;
  } else if (parentWidget && !matchesExpected(parentWidget.value)) {
    failure =
      `Promoted rail widget "${parentWidget.name}" on subgraph node ${node.id} did not retain ` +
      `the requested value: wrote ${JSON.stringify(expected)} but it became ` +
      `${JSON.stringify(parentWidget.value)}. Refusing to report success with a stale rail that ` +
      `would render the OLD value (#366).`;
  } else if (displayWidgets.some((dw) => !matchesExpected(dw.value))) {
    // #477: a parent-facing display proxy did not retain the value. Fail closed +
    // roll back rather than report success while the parent node still shows/queries
    // the OLD value (the exact stale-outer-widget symptom).
    const bad = displayWidgets.find((dw) => !matchesExpected(dw.value));
    failure =
      `Promoted display widget "${bad.name}" on subgraph node ${node.id} did not retain the ` +
      `requested value: wrote ${JSON.stringify(expected)} but it became ${JSON.stringify(bad.value)}. ` +
      `Refusing to report success with a stale parent-facing widget (#477).`;
  } else if (parentWidget) {
    // RE-RESOLVE the promotion from the LIVE graph. This is wrapped so that ANY
    // exception thrown DURING the recheck (e.g. a callback replaced `_subgraphSlot`
    // and the injected resolveSource now THROWS for the replacement) is treated as a
    // topology change and drives the FULL rollback below — a recheck throw must NEVER
    // escape with inner/rail left mutated.
    let recheck = null;
    let recheckThrew = false;
    try {
      recheck = resolvePromotedInnerTarget(node, widgetName, resolveSource);
    } catch {
      recheckThrew = true;
    }
    // #477: the FULL identity-authenticated projection set (rail + display proxies)
    // must be UNCHANGED too. A callback can swap `hostInput.widget` to a NEW live
    // same-named display proxy holding the OLD value while leaving `_widget`, the
    // inner widget, and our CAPTURED old proxy untouched — every rail-only check would
    // pass yet the current outer-facing proxy renders/queries stale. Re-resolve the
    // whole set and identity-compare it (fixed order [_widget, widget]) against what we
    // synced; any membership/identity difference is drift.
    const reWidgets = Array.isArray(recheck?.target?.parentWidgets)
      ? recheck.target.parentWidgets
      : [];
    const capturedWidgets = Array.isArray(promotedParentWidgets) ? promotedParentWidgets : [];
    const projectionSetDrifted =
      reWidgets.length !== capturedWidgets.length ||
      reWidgets.some((rw, i) => rw !== capturedWidgets[i]);
    const drifted =
      recheckThrew ||
      !recheck ||
      !recheck.promoted ||
      !recheck.target ||
      recheck.target.input !== promotedHostInput ||
      recheck.target.widget !== w ||
      recheck.target.parentWidget !== parentWidget ||
      projectionSetDrifted ||
      // The host input's serialization binding (`widgetId`, the store key queue
      // compilation reads) must be UNCHANGED — a swap re-points serialization to a
      // different store entry even though the input/projection objects are identical.
      !Object.is(promotedHostInput ? promotedHostInput.widgetId : undefined, promotedHostWidgetId);
    if (drifted) {
      driftFailure = true;
      failure =
        `Promotion of "${w.name}" on subgraph node ${node.id} CHANGED during the write (a widget ` +
        `or afterChange hook altered the host input, its link, or the slot→widget mapping${
          recheckThrew ? "; re-resolving the promotion threw" : ""
        }), so the rail that was synced is no longer the value that serializes at queue time. Rolled ` +
        `back to avoid a silently-stale render (#366).`;
    }
  }

  // #639: reconcile a captured throw with the verification verdict. The write
  // VERIFIED (value + rail + proxies retained, promotion topology intact) — the
  // throw came from applying the write: DISCLOSE it on the success result, never
  // report a clean failure for an applied write. The write did NOT verify — the
  // throw is the likely cause: compose BOTH causes into the failure (codex
  // round-1: a thrown WidgetWriteError saved un-composed discarded the structural
  // detail), keeping the error's retry flags (combo/emptyOptions) through the
  // composition.
  //
  // Attribution (codex rounds 2-3 + delta-gates): only what the mechanism can
  // ESTABLISH is claimed. The write envelope evaluates value setters on the inner,
  // rail, and display proxies, property reads (`w.callback` may be a throwing
  // accessor, `targetNode.pos` a getter), and the callback invocation — and a
  // plain write to a frozen widget throws with NO user code involved. So the
  // message does not name ANY construct: only that an exception was thrown while
  // applying the write. And read-back verifies only that the requested value IS
  // present — not that THIS write put it there (a frozen widget may already have
  // held it), so the disclosure claims "IS in effect", never "DID take effect".
  // What IS established and claimed: the requested value is present by read-back,
  // and the write's side effects may not have run or completed.
  if (threw) {
    const threwLabel = "an exception was thrown while applying the write";
    if (!failure) {
      writeWarning =
        `${threwLabel} (${threw?.message ?? threw}); the requested value IS in effect — ` +
        `verified present by read-back — and was NOT rolled back. Side effects the write ` +
        `would normally trigger (refreshing dependent widgets, previews, thumbnails) may ` +
        `not have run or completed; inspect the node if dependents look stale.`;
    } else {
      failure = `${threwLabel} (${threw?.message ?? threw}); ${failure}`;
      if (threw instanceof WidgetWriteError) {
        originalErr = new WidgetWriteError(failure, {
          combo: threw.combo,
          emptyOptions: threw.emptyOptions,
        });
      }
    }
  }

  if (failure) {
    // ROLL BACK in its OWN (exception-safe) undo envelope. The restore assignments
    // are each guarded, then we READ BACK the FINAL values AFTER the envelope closes
    // — so a setter that throws OR silently ignores the restore, AND a stateful
    // afterChange hook that re-stales the restored value, are ALL detected. `w.value`
    // is a plain data property on real widgets so this normally succeeds; when it
    // does not, we report an HONEST partial-state failure rather than falsely claim
    // a clean rollback.
    //
    // #477 P1: only restore the OUTER widget-list membership when the ORIGINAL host
    // input is STILL wired into node.inputs. If a callback replaced the host input
    // ENTIRELY (a new promotion), restoring node.widgets would DETACH the live
    // replacement while it still serializes via the changed input — masking a genuine
    // partial state. In that case we leave node.widgets and REPORT partial-state below.
    const hostStillWired =
      !!promotedHostInput && Array.isArray(node.inputs) && node.inputs.includes(promotedHostInput);
    safeBefore();
    try {
      // Restore the serialization BINDING + the promotion TOPOLOGY first (the store key
      // queue compilation reads, and the projection references the outer node exposes),
      // so restoring the rail value below lands on the entry that actually serializes and
      // the original proxies are re-wired — a callback may have re-pointed the store entry
      // OR swapped in a replacement proxy (#366/#477).
      if (promotedHostInput) {
        try {
          promotedHostInput.widgetId = promotedHostWidgetId;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
        try {
          promotedHostInput.widget = promotedHostWidgetRef;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
        try {
          promotedHostInput._widget = promotedHostProjectionRef;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
      }
      // #477 P1: restore the OUTER node's widget-list membership/order — undo any
      // replacement/reorder a callback did, so a detached captured proxy is re-attached
      // and a swapped-in replacement is dropped. ONLY when the original host input is
      // still wired (else a wholesale-replaced promotion is left for partial-state
      // reporting rather than masked).
      if (prevOuterWidgetsRef && hostStillWired) {
        try {
          prevOuterWidgetsRef.length = 0;
          for (const wd of prevOuterWidgets) prevOuterWidgetsRef.push(wd);
          if (node.widgets !== prevOuterWidgetsRef) node.widgets = prevOuterWidgetsRef;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
      }
      try {
        w.value = previous;
      } catch {
        /* restore best-effort; read-back below is authoritative */
      }
      if (parentWidget) {
        try {
          parentWidget.value = previousParent;
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
      }
      // #477: restore the secondary display proxies too, so no proxy is left holding
      // the just-written value after a failed write.
      for (let i = 0; i < displayWidgets.length; i++) {
        try {
          displayWidgets[i].value = previousDisplays[i];
        } catch {
          /* restore best-effort; read-back below is authoritative */
        }
      }
    } finally {
      safeAfter();
    }
    // Authoritative read-back AFTER the rollback envelope, compared STRUCTURALLY
    // against the pre-mutation deep clones — so a setter that throws or silently
    // ignores the restore, AND a stateful afterChange hook that mutates the restored
    // object IN PLACE (which an identity compare would miss), are ALL detected.
    let rollbackFailed = null;
    if (!structurallyEqual(w.value, previousClone)) rollbackFailed = `inner "${w.name}"`;
    if (parentWidget && !structurallyEqual(parentWidget.value, previousParentClone)) {
      rollbackFailed = rollbackFailed
        ? `${rollbackFailed} and rail "${parentWidget.name}"`
        : `rail "${parentWidget.name}"`;
    }
    // #477: a display proxy whose rollback did not take effect is an honest partial
    // state too — report it rather than falsely claim a clean rollback.
    for (let i = 0; i < displayWidgets.length; i++) {
      if (!structurallyEqual(displayWidgets[i].value, previousDisplayClones[i])) {
        const label = `display "${displayWidgets[i].name}"`;
        rollbackFailed = rollbackFailed ? `${rollbackFailed} and ${label}` : label;
      }
    }
    // The serialization binding must be back to its original store key, else queue
    // compilation still reads whatever entry a callback re-pointed it to.
    if (promotedHostInput && !Object.is(promotedHostInput.widgetId, promotedHostWidgetId)) {
      rollbackFailed = rollbackFailed
        ? `${rollbackFailed} and the serialization binding (widgetId)`
        : `the serialization binding (widgetId)`;
    }
    // #477: the promotion TOPOLOGY (the host input's projection references) must be back
    // to the originals too, else a callback-swapped replacement proxy stays wired to the
    // outer node after a supposedly-clean rollback.
    if (promotedHostInput && !Object.is(promotedHostInput.widget, promotedHostWidgetRef)) {
      rollbackFailed = rollbackFailed
        ? `${rollbackFailed} and the promotion topology (host input.widget)`
        : `the promotion topology (host input.widget)`;
    }
    if (promotedHostInput && !Object.is(promotedHostInput._widget, promotedHostProjectionRef)) {
      rollbackFailed = rollbackFailed
        ? `${rollbackFailed} and the promotion topology (host input._widget)`
        : `the promotion topology (host input._widget)`;
    }
    // #477 P1: after rollback the OUTER promotion topology must be EXACTLY intact.
    // node.widgets must be the SAME array reference AND hold the SAME members in the
    // SAME order as the pre-write snapshot — so a stateful afterChange that RE-ADDS a
    // replacement proxy (leaving the captured members present but adding an extra/
    // reordered one), a replaced array, or an in-place push are ALL surfaced as partial
    // state, never a falsely-clean rollback. The LIVE host input must also still be the
    // captured one (a replaced input — even one referencing the same proxies but a
    // different widgetId — serializes differently). This holds whether or not the gated
    // restore above ran.
    if (promotedFrom) {
      const listExact =
        prevOuterWidgets == null ||
        (node.widgets === prevOuterWidgetsRef &&
          Array.isArray(node.widgets) &&
          node.widgets.length === prevOuterWidgets.length &&
          node.widgets.every((wd, i) => wd === prevOuterWidgets[i]));
      let liveInput = undefined;
      try {
        const live = resolvePromotedInnerTarget(node, widgetName, resolveSource);
        if (live && live.target) liveInput = live.target.input;
      } catch {
        liveInput = undefined;
      }
      const inputReplaced = promotedHostInput != null && liveInput !== promotedHostInput;
      if (!listExact || inputReplaced) {
        rollbackFailed = rollbackFailed
          ? `${rollbackFailed} and the promotion host input / parent widget list (node.inputs/widgets)`
          : `the promotion host input / parent widget list (node.inputs/widgets)`;
      }
    }
    // On a TOPOLOGY DRIFT, the captured `parentWidget` we just restored may be
    // DETACHED — a callback could have swapped in a DIFFERENT live authoritative
    // rail. Restoring the old rail does not touch that replacement, so if the LIVE
    // promotion now resolves to a different rail that holds the just-written value,
    // the serialized value is NOT what our rollback restored: report a PARTIAL STATE
    // rather than falsely claim a clean rollback.
    if (driftFailure) {
      let liveRail = null;
      let liveWidgets = [];
      try {
        const live = resolvePromotedInnerTarget(node, widgetName, resolveSource);
        liveRail = live && live.target ? live.target.parentWidget : null;
        liveWidgets =
          live && live.target && Array.isArray(live.target.parentWidgets)
            ? live.target.parentWidgets
            : [];
      } catch {
        liveRail = null;
        liveWidgets = [];
      }
      if (liveRail && liveRail !== parentWidget && structurallyEqual(liveRail.value, expected)) {
        rollbackFailed = rollbackFailed
          ? `${rollbackFailed} and a live replacement rail "${liveRail.name}"`
          : `a live replacement rail "${liveRail.name}"`;
      }
      // #477: a callback could also have swapped in a NEW live DISPLAY PROXY (a member
      // of the freshly-resolved set that was NOT in our captured set) holding the
      // just-written value. Restoring our captured proxies does not touch it — so if
      // any such replacement still carries `expected`, report a PARTIAL STATE rather
      // than falsely claim a clean rollback.
      const capturedSet = Array.isArray(promotedParentWidgets) ? promotedParentWidgets : [];
      for (const lw of liveWidgets) {
        if (lw && lw !== liveRail && !capturedSet.includes(lw) && structurallyEqual(lw.value, expected)) {
          rollbackFailed = rollbackFailed
            ? `${rollbackFailed} and a live replacement display proxy "${lw.name}"`
            : `a live replacement display proxy "${lw.name}"`;
        }
      }
    }
    setDirty?.();
    if (rollbackFailed) {
      throw new WidgetWriteError(
        `Widget "${w.name}" on node ${targetNode.id} (${targetNode.type}) write failed: ${failure} ` +
          `Rollback of ${rollbackFailed} did not take effect (a value setter or history hook ` +
          `rejected/overrode it) — the graph may be in a partial state; re-set the widget or undo.`,
      );
    }
    // Rollback succeeded: preserve the original WidgetWriteError message where there
    // was one, else throw the computed failure.
    if (originalErr) throw originalErr;
    throw new WidgetWriteError(failure);
  }

  setDirty?.();

  // On success, a promoted write has ALWAYS synced the authoritative parent rail
  // widget (verified AFTER afterChange, or it would have rolled back + thrown).
  // parent_widget_synced is reported for observability / defense-in-depth in the
  // panel summary. display_widgets_synced counts the additional parent-facing display
  // proxies also synced so the outer node no longer shows a stale value (#477).
  // #639: write_warning discloses a widget callback that threw AFTER the verified
  // write landed — the value IS in effect, its side effects are uncertain.
  return {
    node_id: targetNode.id,
    widget: w.name,
    previous: parentWidget ? previousParent : previous,
    value: w.value,
    ...(writeWarning ? { write_warning: writeWarning } : {}),
    ...(promotedFrom
      ? {
          inner_previous: previous,
          promoted_from: {
            ...promotedFrom,
            parent_widget_synced: parentWidget != null,
            ...(displayWidgets.length ? { display_widgets_synced: displayWidgets.length } : {}),
          },
        }
      : {}),
  };
}
