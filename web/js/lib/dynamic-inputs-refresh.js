/**
 * #1282 — after `panel_set_widget` writes a count widget, a dynamic-input node's
 * input slots stayed STALE.
 *
 * ## The mechanism this works around, read from the pack
 *
 * KJNodes' `*Multi` nodes (ImageBatchMulti, ImageAddMulti, CrossFadeImagesMulti,
 * TransitionImagesMulti, ImageConcatMulti, MaskBatchMulti, ConditioningMultiCombine,
 * JoinStringMulti) share one helper, `setupDynamicInputs` (ComfyUI-KJNodes
 * web/js/jsnodes.js), which does two things:
 *
 *   1. wraps the count widget's callback as
 *
 *          countW.callback = function (value, canvas) {
 *            const r = origCb ? origCb.apply(this, arguments) : undefined;
 *            if (!canvas) rebuild();   // bare = API reload; skip interactive scrub
 *            return r;
 *          };
 *
 *      — the `canvas` argument is the pack's deliberate tell: an INTERACTIVE edit
 *      carries it, and scrubbing a count must not reflow the node under the user's
 *      cursor, so the rebuild is skipped. The panel's write path invokes the
 *      callback exactly the way an interactive edit does (`widget-write.js` passes
 *      `canvas`), so a panel write took the skip branch and the slots never moved.
 *      The write reported success — verified, honestly — while `image_3…` did not
 *      exist, and every follow-up read saw the stale slot list.
 *
 *   2. adds a button widget, `node.addWidget("button", "Update inputs", null, rebuild)`,
 *      so the interactive user can run the deferred rebuild. That button is the
 *      pack's own refresh control: pressing it is what a user does after scrubbing
 *      the count, and `rebuild` is idempotent — it adds or removes trailing inputs
 *      until their count matches the widget, and returns early when they already do.
 *
 * ## What this does
 *
 * After a write has succeeded and been verified, if the node the write landed on
 * carries that control, press it — inside the same synchronous stretch as the
 * write, so no workflow switch or concurrent command can interleave, and inside
 * the same before/afterChange bracketing every graph mutation here gets, so the
 * slot changes are part of the command's undo history.
 *
 * ## Why it is keyed this way
 *
 * NOT keyed on node.type: the pack list above is a version-dependent enumeration,
 * and a node added to the pack tomorrow would silently keep the stale-slot
 * behaviour. The key is the CONTROL itself — a litegraph `type === "button"`
 * widget named exactly "Update inputs" with a callable callback. That name is the
 * behavioural contract ("rebuild my input slots from the count widget"), and the
 * press is verified by its effect, so a control that accepts the call and does
 * nothing is never reported as a refresh (the #757 probe found pack callbacks that
 * accept a call and do exactly nothing).
 *
 * Name-keying is deliberate and safe here, unlike the refusal-hint case
 * `pressable-widget.js` rejected: a candidate must already be a BUTTON — a value
 * widget that happens to share the name (the "Add Noise" combo problem) is never
 * touched — and the press only ever runs on a node whose write already succeeded.
 * It is also never AUTO-pressed to satisfy a missing widget; that refusal stays
 * exactly as it was.
 *
 * ## What it reports
 *
 *   - slots changed → `{ refreshed: true, inputs: [...] }`, the node's input slot
 *     names AFTER the press, so the caller can proceed without a re-read.
 *   - the control threw → `{ failed: <sentence> }`. The write already succeeded
 *     and was verified, so this must not throw — the failure is disclosed on the
 *     result instead, with the partial-rebuild possibility stated.
 *   - no such control, or the press changed nothing (slots already matched — the
 *     idempotent no-op) → `null`, and the result looks exactly as it did before
 *     this change. "Changed nothing" cannot be distinguished from a broken control
 *     that silently no-ops, so nothing is claimed either way; the follow-up
 *     panel_query_graph read shows the truth.
 *
 * Never throws: it runs AFTER a verified write, and a failure here must never turn
 * that write's honest success into an error report.
 */

// The label `setupDynamicInputs` gives its rebuild button. Treated as the
// behavioural contract — see the header for why the route keys on it.
export const UPDATE_INPUTS_BUTTON = "Update inputs";

// Captured at module load, as widget-write.js does for its own callback
// invocation: a poisoned `.call` getter or Proxy trap on the control must not be
// able to throw from INSIDE the span the throw is attributed to.
const reflectApply = Reflect.apply;

/** The node's input slot names, in order. Never throws. */
function inputNames(node) {
  try {
    if (!Array.isArray(node?.inputs)) return [];
    return node.inputs.map((inp) => {
      try {
        return typeof inp?.name === "string" ? inp.name : null;
      } catch {
        return null;
      }
    });
  } catch {
    return [];
  }
}

function sameNames(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A never-throwing rendering of what the control's invocation threw. */
function coerceThrowMessage(err) {
  try {
    const msg = err?.message;
    if (typeof msg === "string" && msg) return msg;
    return String(err);
  } catch {
    return "the reason could not be rendered";
  }
}

/**
 * The node's dynamic-input refresh control, when it exposes one: a litegraph
 * button widget named exactly "Update inputs" with a callable callback. Returns
 * null for every other node — which is almost all of them. Never throws.
 *
 * @param {object} node
 */
export function dynamicInputsRefreshControl(node) {
  try {
    const widgets = node?.widgets;
    if (!Array.isArray(widgets)) return null;
    for (const w of widgets) {
      try {
        if (w?.type === "button" && w?.name === UPDATE_INPUTS_BUTTON && typeof w?.callback === "function") {
          return w;
        }
      } catch {
        /* an unreadable widget is not the control */
      }
    }
  } catch {
    /* an unreadable node has no control this file may invoke */
  }
  return null;
}

/**
 * Press the node's own dynamic-input refresh control after a successful write.
 *
 * Call ONLY from the synchronous write boundary of a write that has already
 * succeeded and been verified — the press is a graph mutation (inputs are
 * added/removed), so it must not sit across an await.
 *
 * @returns {null | { refreshed: true, inputs: (string|null)[] } | { failed: string }}
 *   See the module header for the three outcomes.
 */
export function refreshDynamicInputsAfterWrite(node, { canvas, beforeChange, afterChange, setDirty } = {}) {
  try {
    const button = dynamicInputsRefreshControl(node);
    if (!button) return null;

    const before = inputNames(node);
    // Bookkeeping hooks are best-effort, exactly as widget-write.js's own
    // safeBefore/safeAfter: a throwing history hook must never decide the outcome
    // it is merely bracketing, and must never replace the disclosure the caller
    // needs to read.
    try {
      beforeChange?.();
    } catch {
      /* history hook is best-effort */
    }
    let threw = null;
    try {
      // Invoked with litegraph's button-click argument shape (widget, canvas,
      // node, pos, event). The control this route exists for — the pack's
      // `rebuild` — reads no arguments at all (verified in its source), so the
      // exact list is convention, not contract. `node.pos` may be a throwing
      // getter, so the arguments are built INSIDE the try: that throw is then
      // attributed to the refresh attempt rather than escaping over a verified
      // write.
      const args = [button, canvas, node, node?.pos, undefined];
      reflectApply(button.callback, button, args);
    } catch (err) {
      threw = err;
    } finally {
      try {
        afterChange?.();
      } catch {
        /* history hook is best-effort */
      }
    }

    const after = inputNames(node);
    const changed = !sameNames(before, after);

    if (threw) {
      // The write already succeeded; the refresh is the part that failed. The
      // control may have partially rebuilt the slots before it threw, so say
      // that rather than calling the slots simply stale.
      return {
        failed:
          `The write itself succeeded and was verified, but invoking the node's own ` +
          `"${UPDATE_INPUTS_BUTTON}" control threw (${coerceThrowMessage(threw)}), so its dynamic ` +
          `input slots may still be stale${changed ? " — and may be PARTIALLY rebuilt, because the list changed before it threw" : ""}. ` +
          `Read the node with panel_query_graph before relying on its inputs.`,
        ...(changed ? { inputs: after } : {}),
      };
    }

    // A press that changed nothing is the idempotent no-op — the slots already
    // matched the widget. It cannot be told apart from a control that silently
    // does nothing, so nothing is claimed.
    if (!changed) return null;

    try {
      setDirty?.();
    } catch {
      /* a repaint hint is cosmetic — never fail a refresh that worked */
    }
    return { refreshed: true, inputs: after };
  } catch (err) {
    // This runs after a verified write; nothing it does may escape over that
    // success — but an unexpected failure of the refresh MACHINERY itself (as
    // opposed to the control, handled above) is still disclosed, because the
    // slots it leaves behind are the stale ones this file exists to fix.
    return {
      failed:
        `The write itself succeeded and was verified, but refreshing the node's dynamic ` +
        `input slots afterwards failed (${coerceThrowMessage(err)}), so they may still be ` +
        `stale. Read the node with panel_query_graph before relying on its inputs.`,
    };
  }
}
