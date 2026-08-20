/**
 * #1519 — `panel_set_widget` fired the widget's OWN callback and stopped there, so
 * the NODE-level litegraph hook `node.onWidgetChanged(name, value, prevValue, widget)`
 * never ran for a programmatic write.
 *
 * ## The mechanism, read from the frontend rather than assumed
 *
 * Both of the frontend's interactive write paths fire it, and they fire it in the
 * SAME position relative to the widget callback that `widget-write.js` already
 * reproduces for everything else. From comfyui-frontend-package 1.48.7, `BaseWidget.setValue`:
 *
 *     this.value = a
 *     this.options?.property && … && node.setProperty(this.options.property, a)
 *     this.callback?.(this.value, canvas, node, pos, e)
 *     node.onWidgetChanged?.(this.name ?? "", a, i, this)      // <- i is the PRIOR value
 *     node.graph && node.graph.incrementVersion()
 *
 * and the canvas mouse path (`processNodeWidgets`):
 *
 *     if (prev != w.value) { node.onWidgetChanged?.(w.name, w.value, prev, w); … }
 *
 * `widget-write.js` already performs the assignment, the `setProperty` copy-back
 * (#1268) and the callback invocation in exactly that order — the node hook was the
 * one step missing, and `onWidgetChanged` appeared NOWHERE in the panel's web/js.
 *
 * ## Why the omission is expensive rather than cosmetic
 *
 * A pack whose slot TOPOLOGY is driven by a widget hooks `onWidgetChanged`, not the
 * widget's callback — `beforeRegisterNodeDef` patches the node type's prototype, which
 * is the only hook that survives the widget being rebuilt. `comfyui-subworkflow`'s
 * `SWF_Subworkflow` is the reported case: it fetches `/subworkflow/info` for the
 * selected child workflow from `onWidgetChanged` (plus `onConfigure` and `onAdded`)
 * and builds its `swf_in_*` / `out_*` slots from the answer. `panel_add_node` creates
 * it with an empty `workflow` widget, so `onAdded` fetched nothing; `panel_set_widget`
 * then set the value and fired no node hook, so the fetch never happened and the node
 * kept the generic `out_0..out_7` shape. The write reported success — honestly, the
 * VALUE was verified present — and every later `panel_connect` to a real slot failed
 * because the slot did not exist. Nothing anywhere raised an error, so the natural
 * read was "this pack is incompatible with the panel".
 *
 * This is not specific to that pack. Any node type whose slots are rebuilt from
 * `onWidgetChanged` was affected identically.
 *
 * ## What this does, and the two things it deliberately does not do
 *
 * Fires the hook ONCE, on the node/widget pair whose callback the write just fired —
 * for a promoted write that is the same single semantic widget `widget-write.js`
 * already chose (see its callback note: the inner target on the definition-scoped
 * path, the rail on the instance-scoped one). Firing a second hook for the other end
 * of a promotion would announce a change for a widget whose value did not move.
 *
 * It does NOT run on a rolled-back write. The call site sits after the verification
 * verdict and after every failure path has thrown, so a write that did not stick can
 * never leave a pack rebuilt against a value that was restored — the failure mode the
 * report explicitly asked to avoid.
 *
 * It does NOT decide the write's verdict. The write already succeeded and was
 * verified; a hook that throws is DISCLOSED on the success result, never thrown over
 * it. Same containment `widget-write.js` gives the widget callback, and the same
 * containment `dynamic-inputs-refresh.js` (#1282) gives the pack's own refresh
 * button — which is the closest precedent for this whole route.
 *
 * ## What it reports
 *
 *   - the node's input/output slot names CHANGED → `{ changed: { inputs, outputs } }`,
 *     so the caller can wire the node without a re-read.
 *   - the hook threw (or could not be invoked at all) → `{ failed: <sentence> }`.
 *   - no hook, or the hook ran and the slots did not move → `null`, and the result
 *     looks exactly as it did before this change.
 *
 * "The slots did not move" is NOT reported as anything. A pack that rebuilds them
 * from a `fetch` (which `SWF_Subworkflow` does) resolves after this returns, so a
 * synchronous snapshot showing no change means "not yet", not "nothing happened" —
 * exactly as it means for an interactive edit. Claiming either way would be a lie
 * about a state this cannot observe.
 *
 * Never throws.
 */

// Captured at module load, as widget-write.js and dynamic-inputs-refresh.js do for
// their own invocations: a poisoned `.call` getter or a Proxy `get` trap on the hook
// must not be able to throw from INSIDE the span the throw is attributed to, and
// `Reflect.apply` checks callability first — so a non-callable hook still throws a
// TypeError exactly as the frontend's `?.()` form does, and is disclosed as one.
const reflectApply = Reflect.apply;

/** One slot list's names, in order. Never throws. */
function slotNames(list) {
  try {
    if (!Array.isArray(list)) return [];
    return list.map((slot) => {
      try {
        return typeof slot?.name === "string" ? slot.name : null;
      } catch {
        return null;
      }
    });
  } catch {
    return [];
  }
}

/**
 * The node's input AND output slot names. Never throws.
 *
 * The `inputs`/`outputs` READS are inside the try, not just the list walk: a pack that
 * rebuilds slots is exactly the kind of node that defines them as accessors, and a throw
 * from the BEFORE snapshot would abort this route before the hook ever fired — reporting
 * a machinery failure while leaving behind the stale slots this file exists to fix. A
 * snapshot that could not be taken yields empty lists, which compare equal to the other
 * side's and so claim nothing either way.
 */
function slotSnapshot(node) {
  let inputs = [];
  let outputs = [];
  try {
    inputs = slotNames(node?.inputs);
  } catch {
    inputs = [];
  }
  try {
    outputs = slotNames(node?.outputs);
  } catch {
    outputs = [];
  }
  return { inputs, outputs };
}

function sameNames(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameSlots(a, b) {
  return sameNames(a.inputs, b.inputs) && sameNames(a.outputs, b.outputs);
}

/** A never-throwing rendering of what the hook's invocation threw. */
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
 * The node-level widget-change hook, when the node has one.
 *
 * Read TOTALLY and read ONCE: `onWidgetChanged` may be an accessor (a pack patching
 * a prototype is the normal way this hook is installed, and a throwing getter is a
 * legal shape), and a read that throws must yield "no hook" rather than escape over
 * a verified write. A non-nullish, non-callable value is returned as a CANDIDATE, not
 * rejected — the frontend's `node.onWidgetChanged?.(…)` would invoke it and throw, and
 * silently skipping it here would restore exactly the silent staleness this fixes.
 *
 * @returns {{ hook: unknown } | null}
 */
export function nodeWidgetChangedHook(node) {
  try {
    const hook = node?.onWidgetChanged;
    if (hook === null || hook === undefined) return null;
    return { hook };
  } catch {
    // The read itself threw. There is no hook this file may invoke, and nothing is
    // claimed about whether one exists.
    return null;
  }
}

/**
 * Fire `node.onWidgetChanged(name, value, previous, widget)` after a verified write.
 *
 * Call ONLY from the synchronous write boundary of a write that has already succeeded
 * and been verified — the hook is a graph mutation (a pack rebuilds slots from it), so
 * it must not sit across an await, and it must never run for a write that rolled back.
 *
 * @param {object} node    the node that OWNS the written widget (`valueNode`)
 * @param {object} widget  the widget that was written (`valueWidget`)
 * @param {{ name: string, value: unknown, previous: unknown,
 *          beforeChange?: Function, afterChange?: Function, setDirty?: Function }} opts
 *   `value` is the VERIFIED value read back off the widget, and `previous` is that same
 *   widget's own prior value — never the other end of a promotion's.
 * @returns {null | { changed: { inputs: (string|null)[], outputs: (string|null)[] } } | { failed: string }}
 */
export function fireNodeWidgetChanged(
  node,
  widget,
  { name, value, previous, beforeChange, afterChange, setDirty } = {},
) {
  try {
    const found = nodeWidgetChangedHook(node);
    if (!found) return null;

    const before = slotSnapshot(node);
    // Bookkeeping hooks are best-effort, exactly as widget-write.js's own
    // safeBefore/safeAfter: a throwing history hook must never decide the outcome it
    // is merely bracketing. Bracketed so slot changes join the command's undo history.
    try {
      beforeChange?.();
    } catch {
      /* history hook is best-effort */
    }
    let threw = null;
    let didThrow = false;
    try {
      // The frontend's argument shape, verbatim: (name, newValue, prevValue, widget),
      // with the NODE as the receiver. `Reflect.apply` rather than `hook.call(…)` —
      // `.call` is a property read ON the hook, so a poisoned getter could throw
      // without the hook running, and a non-callable `{ call() {} }` would be invoked
      // through its own `.call` and reported clean.
      reflectApply(found.hook, node, [name, value, previous, widget]);
    } catch (err) {
      didThrow = true;
      threw = err;
    } finally {
      try {
        afterChange?.();
      } catch {
        /* history hook is best-effort */
      }
    }

    const after = slotSnapshot(node);
    const changed = !sameSlots(before, after);

    if (didThrow) {
      // The write already succeeded and was verified; the hook is the part that
      // failed. It may have rebuilt some slots before it threw, so say that rather
      // than calling them simply stale.
      //
      // "attempting to invoke", uniformly — a class constructor, a revoked Proxy and
      // a throwing `apply` trap all satisfy the invocation and throw before any body
      // runs, so any wording that says the hook RAN is false for them, and this cannot
      // tell them apart from a body that threw.
      const notCallable = typeof found.hook !== "function";
      return {
        failed:
          `The write itself succeeded and was verified, but attempting to invoke this node's ` +
          `own onWidgetChanged hook threw (${coerceThrowMessage(threw)})` +
          (notCallable
            ? // No indefinite article: `typeof` yields "object", and "a object" reads
              // as a panel bug — which is the impression this whole route exists to stop.
              `. The node's onWidgetChanged is of type "${typeof found.hook}", not a function, so ` +
              `it could not be invoked at all and none of its side effects ran`
            : "") +
          `, so slots or other node state it rebuilds from "${name}" may be stale` +
          (changed ? " — and may be PARTIALLY rebuilt, because the slot list changed before it threw" : "") +
          `. Read the node with panel_query_graph before relying on its slots.`,
        ...(changed ? { changed: after } : {}),
      };
    }

    if (!changed) return null;

    try {
      setDirty?.();
    } catch {
      /* a repaint hint is cosmetic — never fail a hook invocation that worked */
    }
    return { changed: after };
  } catch (err) {
    // Runs after a verified write; nothing here may escape over that success. An
    // unexpected failure of the MACHINERY (as opposed to the hook, handled above) is
    // still disclosed, because the state it leaves behind is the stale one this file
    // exists to fix.
    return {
      failed:
        `The write itself succeeded and was verified, but firing this node's onWidgetChanged ` +
        `hook afterwards failed (${coerceThrowMessage(err)}), so slots or other node state it ` +
        `rebuilds may be stale. Read the node with panel_query_graph before relying on its slots.`,
    };
  }
}
