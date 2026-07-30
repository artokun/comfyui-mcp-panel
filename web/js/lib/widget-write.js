// Widget-value validation + promoted-subgraph-widget target resolution for
// graph_set_widget. Extracted so the write targets the RIGHT widget with the
// RIGHT value and can be unit-tested without a live litegraph.
//
// Two graph-integrity bugs motivate this module:
//   #233 — panel_set_widget on a SUBGRAPH node's PROMOTED widget wrote by a
//          positionally-shifted slot and silently corrupted a DIFFERENT inner
//          widget (an INT slot ended up holding "euler"), reporting success.
//   #240 — a COMBO widget set to a valid enum silently drifted to a different
//          option (index-vs-value reinterpretation).
//
// Fixes: (a) resolve a parent promoted widget to its ACTUAL inner (node,widget)
// and write there; (b) validate/coerce the value against the target widget's
// declared type and REJECT a mismatch (combo must be an exact option, numeric
// must be a number) instead of writing garbage.

export class WidgetWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "WidgetWriteError";
  }
}

/**
 * The current option list for a combo widget, or null if the widget is not a
 * combo / has no resolvable list. `options.values` may be an array or a
 * function `(widget) => string[]` (litegraph dynamic combos).
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
  if (comboOptions(widget)) return true;
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
 * Validate + coerce `value` for `widget`, returning the value to write. Throws
 * WidgetWriteError (never silently coerces to a wrong value) when the value is
 * incompatible with the widget's declared type. This converts the class of
 * silent corruption in #233/#240 into an actionable error.
 */
export function coerceWidgetValue(widget, value) {
  const name = widget?.name ?? "(widget)";

  if (isComboWidget(widget)) {
    const options = comboOptions(widget);
    if (options) {
      // Require an EXACT value match against the CURRENT option list. Never
      // reinterpret the value as a dropdown index (the #240 drift) and never
      // fuzzy-match to a neighbouring option.
      if (options.includes(value)) return value;
      // Tolerate only lossless string identity (e.g. a number whose String()
      // equals a string option), still an exact-value match, not an index.
      const asStr = String(value);
      const exact = options.find((o) => String(o) === asStr);
      if (exact !== undefined) return exact;
      const preview = options.slice(0, 40).map((o) => JSON.stringify(o)).join(", ");
      throw new WidgetWriteError(
        `Value ${JSON.stringify(value)} is not a valid option for combo widget ` +
          `"${name}". Valid options (${options.length}): ${preview}` +
          (options.length > 40 ? ", …" : ""),
      );
    }
    // Dynamic combo with no resolvable list: accept the exact value as given;
    // do NOT coerce a string to an index.
    return value;
  }

  if (isNumericWidget(widget)) {
    const num = typeof value === "number" ? value : Number(value);
    if (value === null || value === "" || !Number.isFinite(num)) {
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

  // STRING / text / unknown widget: pass through unchanged.
  return value;
}

/**
 * Resolve a PARENT SubgraphNode's promoted widget to the ACTUAL inner
 * (node, widget) it stands for, so a write lands on the real target instead of
 * a positionally-shifted neighbour on the parent (root cause of #233).
 *
 * A promoted widget is backed by a SubgraphNode input whose `_subgraphSlot`
 * (subgraph input) links, inside the subgraph, to the inner node's widget
 * input. `resolveSource(subgraphNode, subgraphInput)` performs that link walk
 * (the panel injects its live-graph `sourceForSubgraphInput`) and returns
 * `{ sourceNodeId, sourceWidgetName }`.
 *
 * Returns `{ node, widget, input }` for the inner target, or null when the
 * widget is not a promoted subgraph widget (caller then writes on the node
 * directly).
 */
export function resolvePromotedInnerTarget(subgraphNode, widgetName, resolveSource) {
  const subgraph = subgraphNode?.subgraph;
  if (!subgraph || typeof resolveSource !== "function") return null;
  const wanted = String(widgetName).toLowerCase();

  for (const input of subgraphNode.inputs ?? []) {
    const subgraphInput = input?._subgraphSlot;
    if (!subgraphInput) continue;

    const source = resolveSource(subgraphNode, subgraphInput);
    if (!source) continue;

    // The promoted widget on the parent is named after the host input
    // (input.name / label) which mirrors the inner source widget name. Match
    // on any of them so a rename on either side still resolves.
    const candidates = [
      input.name,
      input.label,
      subgraphInput.name,
      subgraphInput.label,
      source.sourceWidgetName,
    ].map((c) => (c == null ? null : String(c).toLowerCase()));
    if (!candidates.includes(wanted)) continue;

    const innerNode =
      typeof subgraph.getNodeById === "function"
        ? subgraph.getNodeById(source.sourceNodeId)
        : (subgraph._nodes ?? []).find((n) => String(n?.id) === String(source.sourceNodeId));
    if (!innerNode) continue;

    const innerWidget = (innerNode.widgets ?? []).find(
      (w) => w?.name === source.sourceWidgetName,
    );
    if (!innerWidget) continue;

    return { node: innerNode, widget: innerWidget, input };
  }
  return null;
}
