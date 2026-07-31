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

/**
 * Validate + coerce `value` for `widget`, returning the value to write. Throws
 * WidgetWriteError (never silently coerces to a wrong value) when the value is
 * incompatible with the widget's declared type.
 */
export function coerceWidgetValue(widget, value, mergeBaseWidget = widget) {
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
    // #366×#179: for a PROMOTED composite, the AUTHORITATIVE base is the RAIL
    // widget's current object (what serializes), not the inner widget's — merging
    // onto a stale inner would clobber the rail's unspecified fields when the same
    // coerced value is written to both. Prefer the rail's object; fall back to the
    // target widget's own value when the rail base isn't a usable object.
    const base =
      mergeBaseWidget && mergeBaseWidget.value != null && typeof mergeBaseWidget.value === "object" && !Array.isArray(mergeBaseWidget.value)
        ? mergeBaseWidget.value
        : widget.value;
    return { ...base, ...incoming };
  }

  // STRING / text / unknown widget: pass through unchanged (an explicit "" clears
  // it, #347).
  return value;
}

/**
 * The parent SubgraphNode's OWN projected promoted widget that is backed by
 * `hostInput` — i.e. the widget whose value serializes into the subgraph input
 * rail at queue time (#366). Resolved by the PROMOTION RELATIONSHIP (litegraph's
 * slot↔widget backlink: `node.getWidgetFromSlot(input)`, or the `input.widget`
 * name reference), NEVER by a stable-name/label guess — a bare name match could
 * select an unrelated decoy own-widget (#233) or a non-authoritative same-named
 * widget when the true rail widget is absent, corrupting the wrong slot while the
 * render stays stale. Returns the widget object, or null when no widget positively
 * backs this input (e.g. the input is fed from an OUTER promotion / another node,
 * so there is no settable rail widget at this level).
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

  // 1) litegraph's AUTHORITATIVE slot→widget resolution (the same method the panel
  //    uses to walk promotions). Returns the actual backing widget OBJECT.
  let widget = null;
  if (typeof subgraphNode.getWidgetFromSlot === "function") {
    try {
      widget = subgraphNode.getWidgetFromSlot(hostInput);
    } catch {
      widget = null;
    }
  }

  // 2) IDENTITY fallback: the host input's `widget` back-reference, accepted ONLY
  //    when it is an actual widget OBJECT already in this node's widget list. A NAME
  //    reference is deliberately NOT accepted here: a bare name could match an
  //    unrelated decoy own-widget while the true rail widget is absent, silently
  //    writing the WRONG widget and reporting success (#233/#366).
  if (!widget && hostInput.widget && typeof hostInput.widget === "object" && inWidgets.includes(hostInput.widget)) {
    widget = hostInput.widget;
  }

  // The resolved widget MUST be a real, writable member of this node's widgets.
  if (!widget || !inWidgets.includes(widget)) return null;

  // DISAMBIGUATION GUARD. litegraph's own slot→widget resolution (getWidgetFromSlot)
  // matches by NAME — `widgets.find(w => w.name === slot.widget.name)` — so if the
  // node carries MORE THAN ONE widget with the resolved name, the pick is ambiguous
  // and could diverge from whichever same-named widget the queue serializer reads.
  // We cannot prove we are writing the widget that actually serializes, so FAIL
  // CLOSED rather than risk a silent stale rail. (Realistic promotions use a UNIQUE
  // widget name; a differently-named decoy is never selected because the resolution
  // keys on the rail's own name — #233 stays safe.)
  const sameName = inWidgets.filter((c) => c?.name === widget.name);
  if (sameName.length !== 1) return null;

  return widget;
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
 * Resolve the true write target (inner promoted widget or the node's own
 * widget) and validate/coerce the value. Throws WidgetWriteError on any
 * unresolved-promotion, missing-widget, or value-mismatch condition — BEFORE
 * any mutation. Pure: no graph side effects.
 */
export function resolveWidgetWrite(node, widgetName, value, resolveSource, assertTargetWritable) {
  let targetNode = node;
  let widget = null;
  let promotedFrom = null;
  let promotedParentWidget = null;
  let promotedHostInput = null;

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

  // For a promoted COMPOSITE write, merge onto the AUTHORITATIVE rail widget's
  // current object (#366×#179) so its unspecified fields are preserved; scalars are
  // unaffected (they don't merge). Non-promoted writes merge onto their own value.
  // (A promoted write with no authoritative rail already threw above, BEFORE this
  // possibly side-effecting coercion — so `promotedParentWidget` is non-null here.)
  const coerced = coerceWidgetValue(widget, value, promotedParentWidget ?? widget);

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
  { resolveSource, canvas, beforeChange, afterChange, setDirty, assertTargetWritable } = {},
) {
  // resolveWidgetWrite runs assertTargetWritable on the RESOLVED target (inner
  // promoted node for a subgraph write, or the node's own) BEFORE it coerces the
  // value, so no coercion callback and no mutation can touch an unregistered
  // placeholder that is about to be refused (#458).
  const { targetNode, widget: w, coerced, promotedFrom, promotedParentWidget, promotedHostInput } =
    resolveWidgetWrite(node, widgetName, value, resolveSource, assertTargetWritable);

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

  const previous = w.value;
  const previousParent = parentWidget ? parentWidget.value : undefined;

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
    w.value = coerced;
    // Fire the widget's own callback so combo/number side effects run — the same
    // path a manual UI edit takes.
    w.callback?.(coerced, canvas, targetNode, targetNode.pos, undefined);
    // Write the AUTHORITATIVE parent rail widget inside the same envelope.
    if (parentWidget) {
      parentWidget.value = coerced;
      parentWidget.callback?.(coerced, canvas, node, node.pos, undefined);
    }
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
    const recheck = resolvePromotedInnerTarget(node, widgetName, resolveSource);
    const drifted =
      !recheck.promoted ||
      !recheck.target ||
      recheck.target.input !== promotedHostInput ||
      recheck.target.widget !== w ||
      recheck.target.parentWidget !== parentWidget;
    if (drifted) {
      failure =
        `Promotion of "${w.name}" on subgraph node ${node.id} CHANGED during the write (a widget ` +
        `or afterChange hook altered the host input, its link, or the slot→widget mapping), so the ` +
        `rail that was synced is no longer the value that serializes at queue time. Rolled back to ` +
        `avoid a silently-stale render (#366).`;
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
    // Authoritative read-back AFTER the rollback envelope (Object.is compares scalars
    // by value, objects by pre-write identity).
    let rollbackFailed = null;
    if (!Object.is(w.value, previous)) rollbackFailed = `inner "${w.name}"`;
    if (parentWidget && !Object.is(parentWidget.value, previousParent)) {
      rollbackFailed = rollbackFailed
        ? `${rollbackFailed} and rail "${parentWidget.name}"`
        : `rail "${parentWidget.name}"`;
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
