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
  constructor(message, { combo = false } = {}) {
    super(message);
    this.name = "WidgetWriteError";
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
export function coerceWidgetValue(widget, value, mergeBaseWidget = widget, subFieldPath = null) {
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
    // STRICT typed membership: no numeric<->string coercion. Numeric options
    // [0,1,2] accept numeric 1; string options ["0","1","2"] require "1", never
    // the number 1 (which would otherwise behave like an index).
    if (options.includes(value)) return value;
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
export function resolveHostPromotedWidget(subgraphNode, hostInput) {
  if (!subgraphNode || !hostInput) return null;

  // EXTERNALLY-LINKED host input ⇒ the local projected widget is NOT authoritative.
  // When the host input carries an outer link, ComfyUI's queue compiler IGNORES
  // this node's projected widget and recursively follows the OUTER source (the
  // enclosing subgraph's rail); ComfyUI's own promoted-widget control treats
  // `input.link != null` as "host store is non-authoritative". Writing the local
  // widget here would pass verification yet render the enclosing rail's OLD value —
  // a false success. Refuse (→ caller FAILS CLOSED); the widget must be edited from
  // the OUTERMOST subgraph node, where its host input has no outer link.
  if (hostInput.link != null) return null;

  const inWidgets = Array.isArray(subgraphNode.widgets) ? subgraphNode.widgets : [];

  // OBJECT-IDENTITY authentication. The rail widget must be the actual projection
  // object the host input LINKS to (`_widget`, or an `input.widget` that is itself a
  // real widget object — NOT a `{ name }` stub) AND must be `===` a live member of
  // this node's projected widgets. A name-only stub is an object too, but it is NOT
  // a member of node.widgets, so it is rejected → FAIL CLOSED. This never resolves by
  // name, so an unrelated same-named decoy can never be selected (#233/#366).
  for (const cand of [hostInput._widget, hostInput.widget]) {
    if (cand && typeof cand === "object" && inWidgets.includes(cand)) return cand;
  }
  return null;
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
 *   { promoted: true, target: {node,widget,input,parentWidget} } → resolved inner target
 *                                                                  (parentWidget may be null)
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
  const parentWidget = resolveHostPromotedWidget(subgraphNode, input);
  return { promoted: true, target: { node: innerNode, widget: innerWidget, input, parentWidget } };
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
) {
  let targetNode = node;
  let widget = null;
  let promotedFrom = null;
  let promotedParentWidget = null;
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
    widget = (targetNode.widgets ?? []).find(
      (cand) => cand?.name?.toLowerCase() === String(widgetName).toLowerCase(),
    );
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
      const baseWidget = (targetNode.widgets ?? []).find(
        (cand) => cand?.name?.toLowerCase() === baseName.toLowerCase(),
      );
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
  const coerced = coerceWidgetValue(widget, value, promotedParentWidget ?? widget, subFieldPath);

  return { targetNode, widget, coerced, promotedFrom, promotedParentWidget, promotedHostInput };
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
  { resolveSource, canvas, beforeChange, afterChange, setDirty, assertTargetWritable, promotedResolution } = {},
) {
  // resolveWidgetWrite runs assertTargetWritable on the RESOLVED target (inner
  // promoted node for a subgraph write, or the node's own) BEFORE it coerces the
  // value, so no coercion callback and no mutation can touch an unregistered
  // placeholder that is about to be refused (#458). A caller-supplied
  // promotedResolution is reused so the write targets the EXACT node the fresh
  // /object_info gate authorized (#458), and resolveWidgetWrite also fails closed if
  // the AUTHORITATIVE parent rail widget can't be identified (#366).
  const { targetNode, widget: w, coerced, promotedFrom, promotedParentWidget, promotedHostInput } =
    resolveWidgetWrite(node, widgetName, value, resolveSource, assertTargetWritable, promotedResolution);

  // #366: for a promoted subgraph widget the AUTHORITATIVE value lives on the
  // parent's OWN rail widget (resolved by the promotion RELATIONSHIP in
  // resolveWidgetWrite, which already FAILED CLOSED if it could not be identified).
  // We now write BOTH the inner widget AND the parent rail widget ATOMICALLY inside
  // one undo envelope: either both land, or neither does and we throw — a thrown
  // callback on EITHER side must never leave inner=new / parent=stale (a silent
  // partial write that renders the OLD value while reporting success).
  const parentWidget = promotedFrom ? promotedParentWidget : null;

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
  const previous = w.value;
  const previousParent = parentWidget ? parentWidget.value : undefined;
  const deepClone = (v) => (v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);
  const structurallyEqual = (a, b) =>
    (a !== null && typeof a === "object") || (b !== null && typeof b === "object")
      ? JSON.stringify(a) === JSON.stringify(b)
      : Object.is(a, b);
  const previousClone = deepClone(previous);
  const previousParentClone = parentWidget ? deepClone(previousParent) : undefined;
  // The ACTUAL serialization binding for an unlinked subgraph input is its
  // `widgetId` (the widget-value STORE key that queue compilation reads). A callback
  // could keep the SAME host input and projection objects but re-point `widgetId` to
  // another store entry holding the OLD value — passing every object-identity check
  // while the render reads the stale entry. Snapshot it so the recheck can detect a
  // swap (#366).
  const promotedHostWidgetId = promotedHostInput ? promotedHostInput.widgetId : undefined;

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
    // Fire the inner widget's own callback so combo/number side effects run — the
    // same single invocation a manual UI edit of the promoted control performs.
    w.callback?.(coerced, canvas, targetNode, targetNode.pos, undefined);
  } catch (err) {
    threw = err;
  } finally {
    safeAfter();
  }

  // VERIFY AFTER afterChange. Compute the failure reason (if any) WITHOUT mutating,
  // so rollback happens in its own envelope below. Order: a thrown callback; then a
  // value that did not stick on the inner (#240) or the authoritative rail (#366);
  // then a promotion-relationship change (re-resolved from the LIVE graph, catching
  // an outer link, a replaced/detached host input, or a re-pointed slot→widget map).
  let failure = null;
  let originalErr = null;
  let driftFailure = false;
  if (threw) {
    originalErr = threw instanceof WidgetWriteError ? threw : null;
    failure =
      threw instanceof WidgetWriteError
        ? threw.message
        : `a widget callback threw (${threw?.message ?? threw})`;
  } else if (!matchesExpected(w.value)) {
    failure =
      `Widget "${w.name}" on node ${targetNode.id} (${targetNode.type}) did not retain the ` +
      `requested value: wrote ${JSON.stringify(expected)} but it became ${JSON.stringify(w.value)}.`;
  } else if (parentWidget && !matchesExpected(parentWidget.value)) {
    failure =
      `Promoted rail widget "${parentWidget.name}" on subgraph node ${node.id} did not retain ` +
      `the requested value: wrote ${JSON.stringify(expected)} but it became ` +
      `${JSON.stringify(parentWidget.value)}. Refusing to report success with a stale rail that ` +
      `would render the OLD value (#366).`;
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
    const drifted =
      recheckThrew ||
      !recheck ||
      !recheck.promoted ||
      !recheck.target ||
      recheck.target.input !== promotedHostInput ||
      recheck.target.widget !== w ||
      recheck.target.parentWidget !== parentWidget ||
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

  if (failure) {
    // ROLL BACK in its OWN (exception-safe) undo envelope. The restore assignments
    // are each guarded, then we READ BACK the FINAL values AFTER the envelope closes
    // — so a setter that throws OR silently ignores the restore, AND a stateful
    // afterChange hook that re-stales the restored value, are ALL detected. `w.value`
    // is a plain data property on real widgets so this normally succeeds; when it
    // does not, we report an HONEST partial-state failure rather than falsely claim
    // a clean rollback.
    safeBefore();
    try {
      // Restore the serialization BINDING first (the store key queue compilation
      // reads), so restoring the rail value below lands on the entry that actually
      // serializes — a callback may have re-pointed it to a different store entry.
      if (promotedHostInput) {
        try {
          promotedHostInput.widgetId = promotedHostWidgetId;
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
    // The serialization binding must be back to its original store key, else queue
    // compilation still reads whatever entry a callback re-pointed it to.
    if (promotedHostInput && !Object.is(promotedHostInput.widgetId, promotedHostWidgetId)) {
      rollbackFailed = rollbackFailed
        ? `${rollbackFailed} and the serialization binding (widgetId)`
        : `the serialization binding (widgetId)`;
    }
    // On a TOPOLOGY DRIFT, the captured `parentWidget` we just restored may be
    // DETACHED — a callback could have swapped in a DIFFERENT live authoritative
    // rail. Restoring the old rail does not touch that replacement, so if the LIVE
    // promotion now resolves to a different rail that holds the just-written value,
    // the serialized value is NOT what our rollback restored: report a PARTIAL STATE
    // rather than falsely claim a clean rollback.
    if (driftFailure) {
      let liveRail = null;
      try {
        const live = resolvePromotedInnerTarget(node, widgetName, resolveSource);
        liveRail = live && live.target ? live.target.parentWidget : null;
      } catch {
        liveRail = null;
      }
      if (liveRail && liveRail !== parentWidget && structurallyEqual(liveRail.value, expected)) {
        rollbackFailed = rollbackFailed
          ? `${rollbackFailed} and a live replacement rail "${liveRail.name}"`
          : `a live replacement rail "${liveRail.name}"`;
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
  // panel summary.
  return {
    node_id: targetNode.id,
    widget: w.name,
    previous,
    value: w.value,
    ...(promotedFrom ? { promoted_from: { ...promotedFrom, parent_widget_synced: parentWidget != null } } : {}),
  };
}
