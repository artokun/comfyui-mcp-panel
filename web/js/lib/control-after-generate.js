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

// #2029 — panel_add_node can leave the control combo visible (mode "randomize")
// without the queue hooks app.queuePrompt actually fires. ComfyUI_frontend
// widgets.ts hangs beforeQueued/afterQueued on the combo and points the value
// widget's linkedWidgets at it; without that, ordinary Queue-button runs cache-hit
// on seed 0 until a tab reload rebuilds the node through the frontend pipeline.
const ADVANCING_CONTROL_MODES = new Set(["randomize", "increment", "decrement", "increment-wrap"]);
const SAFE_INTEGER_MAX = 1125899906842624;
const SAFE_INTEGER_MIN = -1125899906842624;
const controlHasQueued = new WeakSet();

function targetInputIsConnected(node, target) {
  const name = target?.name;
  if (typeof name !== "string") return false;
  const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
  for (const input of inputs) {
    if (!input || input.link == null) continue;
    if (input.widget?.name === name || input.name === name) return true;
  }
  return false;
}

function nextControlledValue(target, mode) {
  if (!ADVANCING_CONTROL_MODES.has(mode)) return undefined;
  const values = target?.options?.values;
  if (Array.isArray(values) && values.length) {
    const asString = values.map((v) => String(v));
    let index = asString.indexOf(String(target.value));
    const length = values.length;
    if (mode === "randomize") index = Math.floor(Math.random() * length);
    else if (mode === "decrement") index -= 1;
    else index += 1;
    if (mode === "increment-wrap" && index >= length) index = 0;
    index = Math.max(0, Math.min(length - 1, index));
    return values[index];
  }
  if (typeof target?.value !== "number" || !Number.isFinite(target.value)) return undefined;
  const opts = target.options && typeof target.options === "object" ? target.options : {};
  const step2 = Number(opts.step2) || (Number(opts.step) > 0 ? Number(opts.step) / 10 : 1) || 1;
  const rawMin = Number(opts.min);
  const rawMax = Number(opts.max);
  const min = Number.isFinite(rawMin) ? Math.max(SAFE_INTEGER_MIN, rawMin) : 0;
  const max = Number.isFinite(rawMax) ? Math.min(SAFE_INTEGER_MAX, rawMax) : min;
  let next = target.value;
  if (mode === "decrement") next -= step2;
  else if (mode === "increment" || mode === "increment-wrap") next += step2;
  else {
    const range = (max - min) / step2;
    next = Math.floor(Math.random() * range) * step2 + min;
  }
  return Math.min(Math.max(next, min), max);
}

function linkControlToTarget(target, control) {
  if (!target || target === control) return;
  if (!Array.isArray(target.linkedWidgets)) target.linkedWidgets = [];
  if (!target.linkedWidgets.includes(control)) target.linkedWidgets.push(control);
}

function applyControlToTarget(node, target, control) {
  if (targetInputIsConnected(node, target)) return;
  const mode = typeof control?.value === "string" ? control.value : String(control?.value ?? "");
  const next = nextControlledValue(target, mode);
  if (next === undefined) return;
  target.value = next;
  if (typeof target.callback === "function") target.callback(next);
}

/**
 * Make an already-materialized control_after_generate combo actually roll its
 * governed widget on app.queuePrompt, matching the frontend seed-widget pipeline.
 *
 * No-op when the combo already carries beforeQueued/afterQueued (a UI-created or
 * reload-rebuilt node). Never invents a control widget that is not already there.
 * Returns how many inert combos were armed.
 */
export function ensureControlAfterGenerateQueueHooks(node, { getControlMode } = {}) {
  const entries = controlAfterGenerateEntries(node);
  if (!entries.length) return 0;
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  let armed = 0;
  const runsBefore = () => {
    try {
      return getControlMode?.() === "before";
    } catch {
      return false;
    }
  };
  for (const entry of entries) {
    if (!entry || entry.widget === entry.control) continue;
    const control = widgets.find((w) => w && w.name === entry.control);
    const target = widgets.find((w) => w && w.name === entry.widget);
    if (!control || !target || control === target) continue;
    try {
      linkControlToTarget(target, control);
    } catch {
      /* a non-writable linkedWidgets still gets the queue hooks below */
    }
    if (typeof control.beforeQueued === "function" || typeof control.afterQueued === "function") {
      continue;
    }
    control.beforeQueued = () => {
      if (runsBefore() && controlHasQueued.has(control)) applyControlToTarget(node, target, control);
      controlHasQueued.add(control);
    };
    control.afterQueued = () => {
      if (!runsBefore()) applyControlToTarget(node, target, control);
    };
    armed += 1;
  }
  return armed;
}
