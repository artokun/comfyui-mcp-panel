// control_after_generate detection for graph reads + set_widget honesty (#558).
//
// A seed/noise_seed (and any INT/COMBO) widget can carry a companion combo widget
// named "control_after_generate" whose value ("fixed" | "increment" | "decrement" |
// "randomize") makes ComfyUI SILENTLY rewrite the governed value AFTER each
// generation. The ComfyUI frontend adds this control widget to `node.widgets` with
// `serialize:false, canvasOnly:true`, so it renders as an unassociated widget entry
// that is easy to miss — a value the agent explicitly set (e.g. a fixed seed for a
// controlled A/B run) will not hold, with nothing in the tool surface revealing it.
//
// This module is EXTRACTED so the detection is unit-tested against the SAME code the
// panel's summarizeNode / graph_outline / runSetWidget run — a regression fails a
// test instead of silently re-hiding the mode.

export const CONTROL_AFTER_GENERATE_MODES = ["fixed", "increment", "decrement", "randomize"];

/**
 * True for a control_after_generate combo widget. Detected by OPTION SHAPE — an option
 * list containing every control mode — NOT by the literal widget name. ComfyUI lets a
 * node def name the control widget arbitrarily (a `seed` may be governed by a control
 * widget named e.g. `seed_behavior`), so a name-substring test misses renamed controls
 * and drops the #558 warning. The mode option list is the reliable, name-independent
 * signal — nothing else in a graph carries options [fixed, increment, decrement,
 * randomize] — and a value-only match (a text widget merely holding "fixed") is still
 * refused as too weak.
 */
export function isControlAfterGenerateWidget(w) {
  const opts = w?.options;
  if (!opts) return false;
  // AUTHORITATIVE control marker: ComfyUI creates the value-control combo with BOTH
  // `serialize:false` AND `canvasOnly:true`. Requiring BOTH (the real frontend shape)
  // distinguishes a genuine control from an unrelated hidden combo that merely happens to
  // be non-serialized and share the mode strings — so no false outline annotation/warning.
  if (opts.serialize !== false || opts.canvasOnly !== true) return false;
  // SIDE-EFFECT-FREE detection: a real control combo always carries a STATIC option array,
  // so we require an array and NEVER invoke a dynamic `values()` function. Detection runs
  // during reads AND after a write has been verified; invoking a side-effecting callback
  // here could mutate the graph AFTER verification and silently change the reported value.
  const vals = opts.values;
  if (!Array.isArray(vals)) return false;
  // SUPERSET test: the option list must CONTAIN every base control mode. Not exact-set —
  // ComfyUI appends a 5th option, "increment-wrap", when the governed widget is itself a
  // COMBO, so an exact-4 check would MISS combo-governed controls (a real false negative).
  const set = new Set(vals.map((v) => String(v)));
  return CONTROL_AFTER_GENERATE_MODES.every((m) => set.has(m));
}

// A widget that control_after_generate plausibly GOVERNS: a numeric value, a combo, or a
// seed-named widget. Used to gate the POSITIONAL predecessor fallback so a coincidental
// mode-option combo does not attach its mode to an unrelated preceding widget.
function isEligibleGovernedWidget(w) {
  if (!w || typeof w.name !== "string") return false;
  const t = String(w.type ?? "").toLowerCase();
  if (["int", "float", "number", "slider", "combo"].includes(t)) return true;
  if (Array.isArray(w?.options?.values) || typeof w?.options?.values === "function") return true;
  return /(^|_)seed$/i.test(w.name) || /noise_seed/i.test(w.name);
}

/**
 * The control_after_generate relationships on a node, as
 * `{ widget: <governed name>, control: <control widget name>, mode }[]`.
 *
 * The governed value widget is identified by the AUTHORITATIVE frontend link first
 * (a value widget whose `linkedWidgets` array includes the control widget), then by
 * POSITION (the control widget is inserted immediately after the value widget it
 * governs) as a fallback. When neither yields a distinct governed widget, the entry
 * is keyed on the control widget itself so the mode is never dropped.
 */
export function controlAfterGenerateEntries(node) {
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  const entries = [];
  widgets.forEach((w, i) => {
    if (!isControlAfterGenerateWidget(w)) return;
    const mode = typeof w.value === "string" ? w.value : String(w.value);
    let governed = null;
    // 1) Authoritative: a value widget that links to THIS control widget.
    for (const v of widgets) {
      if (v !== w && Array.isArray(v.linkedWidgets) && v.linkedWidgets.includes(w)) {
        governed = v;
        break;
      }
    }
    // 2) Fallback: the IMMEDIATELY preceding widget, and ONLY when it is an ELIGIBLE
    //    control target (a numeric/combo value or a seed-named widget — what
    //    control_after_generate actually governs). ComfyUI inserts the control combo
    //    directly after the value widget it governs, so the predecessor at i-1 is the
    //    right one; restricting it to eligible widgets avoids attaching a spurious mode
    //    to an unrelated predecessor if some combo happens to share the mode option set.
    if (!governed && i > 0) {
      const cand = widgets[i - 1];
      if (
        cand &&
        typeof cand.name === "string" &&
        !isControlAfterGenerateWidget(cand) &&
        isEligibleGovernedWidget(cand)
      ) {
        governed = cand;
      }
    }
    entries.push({
      widget: governed && typeof governed.name === "string" ? governed.name : w.name,
      control: w.name,
      mode,
    });
  });
  return entries;
}

/** Map of governed-widget-name → mode, e.g. `{ seed: "randomize" }`. */
export function controlAfterGenerateModes(node) {
  const out = {};
  for (const e of controlAfterGenerateEntries(node)) out[e.widget] = e.mode;
  return out;
}

/**
 * The control entry whose GOVERNED VALUE widget is `widgetName` (case-insensitive), or
 * null. Self-keyed fallback entries (an orphan control widget with no distinct governed
 * widget, keyed on the control itself) are EXCLUDED: writing `control_after_generate`
 * changes the MODE, it is not a value governed by that mode, so it must never warn.
 */
export function controlEntryForWidget(node, widgetName) {
  if (widgetName == null) return null;
  const wanted = String(widgetName).toLowerCase();
  return (
    controlAfterGenerateEntries(node).find(
      (e) => e.widget !== e.control && String(e.widget).toLowerCase() === wanted,
    ) ?? null
  );
}

/**
 * The REMEDY half of the #558 warning, expressed in the CALLER'S OWN SCOPE (#650).
 *
 * A remedy must be actionable from where the caller actually is. The control widget
 * lives on the node that is ULTIMATELY governed — for a PROMOTED subgraph write that is
 * an INNER node, whose id does not exist in the caller's (root) graph at all. The old
 * unconditional `panel_set_widget(node_id=<inner id>, …)` therefore returned
 * "No node with id 75 in the current graph" when followed: a remedy the caller cannot
 * follow is not better than none, it is worse — it reads as a working instruction.
 *
 * `scope` states, as OBSERVED FACT by the caller that resolved the write, how the
 * control widget is reachable from the addressed scope:
 *   {}                              — DIRECT write: the control is on the very node the
 *                                     caller addressed; address it there.
 *   { outerNodeId, promotedAs }     — the control is ITSELF promoted onto the outer
 *                                     subgraph node under `promotedAs`; set it there,
 *                                     without entering anything.
 *   { outerNodeId, enterPath: [id…] } — the control is only reachable INSIDE; enter each
 *                                     container in order (each id is addressable in the
 *                                     scope the previous enter lands in), set it on the
 *                                     inner node, then exit.
 * An unrecognised/empty scope falls back to the direct form — the shape it had before —
 * so a caller that cannot describe the scope is no worse off than today.
 */
export function controlAfterGenerateRemedy(entry, node, scope = {}) {
  const control = entry?.control;
  const outerId = scope?.outerNodeId;
  if (outerId != null && typeof scope?.promotedAs === "string") {
    return (
      `"${control}" is promoted onto subgraph node ${outerId} as "${scope.promotedAs}", so set it ` +
      `from here: panel_set_widget(node_id=${outerId}, widget='${scope.promotedAs}', value='fixed').`
    );
  }
  const path = Array.isArray(scope?.enterPath) ? scope.enterPath.filter((id) => id != null) : [];
  if (outerId != null && path.length) {
    const enters = path.map((id) => `panel_enter_subgraph(node_id=${id})`).join(", then ");
    return (
      `"${control}" is NOT promoted onto subgraph node ${outerId}, so it is not settable from this ` +
      `scope — node ${node?.id} does not exist in the graph you are addressing. Enter the owning ` +
      `subgraph first: ${enters}, then ` +
      `panel_set_widget(node_id=${node?.id}, widget='${control}', value='fixed'), then ` +
      `panel_exit_subgraph()${path.length > 1 ? ` ${path.length} times` : ""}.`
    );
  }
  return `panel_set_widget(node_id=${node?.id}, widget='${control}', value='fixed').`;
}

/**
 * A warning string when writing `widgetName` on `node` targets a value governed by a
 * NON-fixed control_after_generate (the write will not hold), else null. Points at
 * the exact control widget + value to make it stick, so the agent can self-correct.
 *
 * `scope` (#650) is passed straight to controlAfterGenerateRemedy — see there. Omit it
 * for a direct read/write where the control widget is on the node the caller addressed.
 */
export function controlAfterGenerateWarning(node, widgetName, scope = {}) {
  const entry = controlEntryForWidget(node, widgetName);
  if (!entry || entry.mode === "fixed") return null;
  const behavior = {
    randomize: "a new random value each run",
    increment: "increased by 1 each run",
    decrement: "decreased by 1 each run",
  }[entry.mode] ?? "automatically changed each run";
  return (
    `control_after_generate='${entry.mode}' governs widget "${entry.widget}" on node ${node?.id}: ` +
    `ComfyUI automatically CHANGES this value on subsequent runs (${behavior}), so the value you set ` +
    `will NOT persist. Set "${entry.control}" to 'fixed' to hold it — ` +
    `${controlAfterGenerateRemedy(entry, node, scope)}`
  );
}
