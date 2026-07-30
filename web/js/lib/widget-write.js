// Widget-value validation + promoted-subgraph-widget target resolution for
// graph_set_widget. Extracted so the write targets the RIGHT widget with the
// RIGHT value and can be unit-tested by driving the SAME code path the handler
// runs (applyWidgetWrite), not a parallel reimplementation.
//
// Two graph-integrity bugs motivate this module:
//   #233 — panel_set_widget on a SUBGRAPH node's PROMOTED widget wrote by a
//          positionally-shifted slot and silently corrupted a DIFFERENT inner
//          widget (an INT slot ended up holding "euler"), reporting success.
//   #240 — a COMBO widget set to a valid enum silently drifted to a different
//          option (index-vs-value reinterpretation).
//
// Safety contract (both bugs are silent corruption; we NEVER fail open):
//   * A promoted widget resolves to its ACTUAL inner (node, widget) and the
//     write lands THERE. If it looks promoted but cannot be resolved
//     unambiguously, we THROW before mutating — never fall back to the shifted
//     parent slot.
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

/**
 * Validate + coerce `value` for `widget`, returning the value to write. Throws
 * WidgetWriteError (never silently coerces to a wrong value) when the value is
 * incompatible with the widget's declared type.
 */
export function coerceWidgetValue(widget, value) {
  const name = widget?.name ?? "(widget)";

  // #347: distinguish "clear to empty" from "missing value". An EXPLICIT empty
  // string is a valid request to empty a text/string widget (handled by the
  // pass-through at the end); a MISSING value (undefined/null — e.g. an omitted
  // or dropped arg) is not, and must fail loudly instead of silently writing
  // `undefined`. The combo/numeric/boolean branches below still reject "" on
  // their own terms, so #240 strictness is untouched.
  if (value === undefined || value === null) {
    throw new WidgetWriteError(
      `No value provided for widget "${name}". To clear a text widget, pass an ` +
        `explicit empty string ("").`,
    );
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
  if (isCompositeObjectWidget(widget)) {
    let incoming = value;
    if (typeof value === "string") {
      try {
        incoming = JSON.parse(value);
      } catch {
        throw new WidgetWriteError(
          `Widget "${name}" holds a composite object value; the string ` +
            `${JSON.stringify(value)} is not valid JSON for it.`,
        );
      }
    }
    if (incoming == null || typeof incoming !== "object" || Array.isArray(incoming)) {
      throw new WidgetWriteError(
        `Widget "${name}" is a composite object widget; value ${JSON.stringify(value)} ` +
          `must be an object (or a JSON object string), e.g. ` +
          `{"on":true,"lora":"name.safetensors","strength":1}.`,
      );
    }
    return { ...widget.value, ...incoming };
  }

  // STRING / text / unknown widget: pass through unchanged (an explicit "" clears
  // it, #347).
  return value;
}

/**
 * Classify a widget request on `subgraphNode` against `widgetName` and, when it
 * is a PROMOTED subgraph widget, resolve it to the ACTUAL inner (node, widget).
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
 *   { promoted: false }                             → not a promoted widget
 *   { promoted: true, target: {node,widget,input} } → resolved inner target
 *   { promoted: true, target: null, error }         → promoted but UNRESOLVABLE/ambiguous
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
  return { promoted: true, target: { node: innerNode, widget: innerWidget, input } };
}

/**
 * Resolve the true write target (inner promoted widget or the node's own
 * widget) and validate/coerce the value. Throws WidgetWriteError on any
 * unresolved-promotion, missing-widget, or value-mismatch condition — BEFORE
 * any mutation. Pure: no graph side effects.
 */
export function resolveWidgetWrite(node, widgetName, value, resolveSource, assertTargetWritable) {
  let targetNode = node;
  let widget = null;
  let promotedFrom = null;

  if (node?.subgraph) {
    const res = resolvePromotedInnerTarget(node, widgetName, resolveSource);
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
    }
  }

  if (!widget) {
    widget = (targetNode.widgets ?? []).find(
      (cand) => cand?.name?.toLowerCase() === String(widgetName).toLowerCase(),
    );
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

  const coerced = coerceWidgetValue(widget, value);
  return { targetNode, widget, coerced, promotedFrom };
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
  { resolveSource, canvas, beforeChange, afterChange, setDirty, assertTargetWritable } = {},
) {
  // resolveWidgetWrite runs assertTargetWritable on the RESOLVED target (inner
  // promoted node for a subgraph write, or the node's own) BEFORE it coerces the
  // value, so no coercion callback and no mutation can touch an unregistered
  // placeholder that is about to be refused (#458).
  const { targetNode, widget: w, coerced, promotedFrom } = resolveWidgetWrite(
    node,
    widgetName,
    value,
    resolveSource,
    assertTargetWritable,
  );

  // Snapshot the EXPECTED value BEFORE the callback runs. For a COMPOSITE object
  // write (#179) `w.value` and `coerced` are the SAME reference, so a callback
  // that mutates the object IN PLACE would change our "expected" too — making a
  // post-hoc compare trivially pass and hiding real drift. A structural clone
  // taken up front preserves the drift check (a scalar clones to itself).
  const objectWrite = coerced !== null && typeof coerced === "object";
  const expected = objectWrite ? JSON.parse(JSON.stringify(coerced)) : coerced;

  beforeChange?.();
  const previous = w.value;
  try {
    w.value = coerced;
    // Fire the widget's own callback so combo/number side effects run — the
    // same path a manual UI edit takes.
    w.callback?.(coerced, canvas, targetNode, targetNode.pos, undefined);
  } finally {
    afterChange?.();
  }
  setDirty?.();

  // Verify the write stuck. A combo callback that reinterprets an index can
  // drift a SCALAR value silently — fail rather than report a false success, by
  // strict identity (#240). For a COMPOSITE object value (#179) the callback may
  // clone/normalize the object, so strict identity would false-fail; require
  // instead that every field we set is present with the value we wrote, compared
  // against the pre-callback snapshot so an in-place drift is still caught.
  const stuck = objectWrite
    ? w.value !== null &&
      typeof w.value === "object" &&
      Object.keys(expected).every(
        (k) => JSON.stringify(w.value[k]) === JSON.stringify(expected[k]),
      )
    : w.value === expected;
  if (!stuck) {
    throw new WidgetWriteError(
      `Widget "${w.name}" on node ${targetNode.id} (${targetNode.type}) did not ` +
        `retain the requested value: wrote ${JSON.stringify(expected)} but it ` +
        `became ${JSON.stringify(w.value)}.`,
    );
  }

  return {
    node_id: targetNode.id,
    widget: w.name,
    previous,
    value: w.value,
    ...(promotedFrom ? { promoted_from: promotedFrom } : {}),
  };
}
