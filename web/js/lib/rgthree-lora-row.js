/**
 * #757 — `panel_set_widget` could not CREATE an rgthree Power Lora Loader row.
 *
 * Reported: a freshly added `Power Lora Loader (rgthree)` carries only
 * `divider, PowerLoraLoaderHeaderWidget, divider, ➕ Add Lora`. The `lora_1`, `lora_2`, …
 * rows do not exist until the user clicks **➕ Add Lora**, a DOM-only control an agent
 * cannot activate — so every write to `lora_1` on a new node was refused for a widget that
 * could not be brought into existence by any tool. Writing an EXISTING row already works
 * (the composite schema and dotted sub-fields shipped earlier), so this is creation only.
 *
 * WHY THIS LIVES HERE. rgthree mints a row only from `node.addNewLoraWidget()`. The
 * maintainer probed the generic contract on a live canvas and found `callback`,
 * `onMouseClick` and `mouseClickCallback` all ACCEPT the call and create nothing — so any
 * fix written against the widget contract silently no-ops. Only this repo runs in the
 * browser and holds that node object, which is why the capability cannot be added upstream.
 * The mirror image already shipped: `panel_remove_widget` (comfyui-mcp#938) removes these
 * same rows by calling the node's own method and then verifying the list changed.
 *
 * WHAT IS DELIBERATELY NOT BEING DONE — the guard this must not become. The panel REFUSES
 * to auto-press a pressable control (`pressable-widget.js`), and that refusal is correct: a
 * generic "this node has one button, press it" rule would mutate the graph on an ordinary
 * TYPO, which is the overwhelmingly common reason a widget name misses. So this route is
 * keyed on THREE independent facts, all required:
 *
 *   1. the node TYPE is Power Lora Loader (rgthree);
 *   2. the requested name is `lora_<n>` and is ABSENT from the node;
 *   3. the VALUE is a lora-slot object the existing writer already accepts — read through
 *      `slotValue`, because in production it arrives as a JSON STRING.
 *
 * A typo cannot satisfy all three, and `pressableWidgetHint` stays the answer for every
 * other node and every other missing name.
 *
 * POST-VERIFY, BECAUSE THE METHOD IS PACK-PRIVATE. `addNewLoraWidget` is not ours and is
 * version-dependent. It is feature-detected (a loud refusal when absent, as
 * `ltx-director.js` does for its own private entry point) and its EFFECT is verified after
 * the call, because a silent no-op is exactly what the probe found on the generic
 * callbacks. Same discipline `remove-widget.js` applies to the removal half.
 *
 * NAMES ARE NOT POSITIONAL. rgthree's `loraWidgetsCounter` is monotonic and `configure()`
 * re-mints rows from serialized ORDER, so after removing `lora_1` the next created row is
 * NOT necessarily `lora_1`. When the row that appears is not the one asked for, it is
 * removed again and the refusal names the row that WOULD be created.
 *
 * AND THE COUNTER IS REWOUND WITH IT, which is the part that makes that refusal usable.
 * `addNewLoraWidget` increments before it names, and removing the row does not undo the
 * increment — so a refusal that only removed the widget would say `the next row is
 * "lora_7" … nothing was changed. Set "lora_7" instead` while having already moved the next
 * name to `lora_8`. Following the advice refuses again, one name further along, forever.
 * That was measured, not reasoned about. Undoing the mutation means undoing BOTH halves of
 * it; when the counter cannot be rewound the message stops promising a retry that would not
 * work. Leaving nothing behind is what makes a refusal safe to retry.
 */

import { isLoraSlotObject } from "./widget-write.js";

/** The one node type this route may touch. */
export const POWER_LORA_LOADER_TYPE = "Power Lora Loader (rgthree)";

/** `lora_1`, `lora_12`, … — the row names rgthree mints. */
const LORA_ROW_NAME = /^lora_\d+$/;

/** Every widget name currently on the node, as a plain array. Never throws. */
function widgetNames(node) {
  try {
    return (node?.widgets ?? []).map((w) => {
      try {
        return w?.name;
      } catch {
        return undefined;
      }
    });
  } catch {
    return [];
  }
}

/**
 * The slot object a caller actually sent, or null.
 *
 * A LORA ROW ARRIVES AS A JSON STRING IN PRODUCTION, and missing that made the first version
 * of this file DEAD CODE. `panel_set_widget` carries scalar values, and `coerceWidgetValue`
 * is what turns the string into an object — at `widget-write.js:508-512`, well AFTER this
 * classifier runs. So testing the raw argument with `isLoraSlotObject` answered "not a slot"
 * for every real request: the route never fired and the reported refusal stood, while the
 * unit tests passed because they handed in objects. That is the shape the tests chose, not
 * the shape the tool sends.
 *
 * Parsed with the same tolerance the writer uses: a string that is not valid JSON, or that
 * parses to something which is not a slot, is simply not a creation request. Nothing here
 * widens what counts as a slot — `isLoraSlotObject` remains the only judge, and it is asked
 * about the parsed value rather than about a string it would always reject.
 */
function slotValue(value) {
  if (isLoraSlotObject(value)) return value;
  if (typeof value !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return isLoraSlotObject(parsed) ? parsed : null;
}

/**
 * Should this write MINT a row first?
 *
 * Pure and total — it never throws and never mutates, so a caller can ask before it has
 * decided to do anything. All three facts must hold; see the header for why.
 */
export function isRgthreeLoraRowCreation(node, widgetName, value) {
  try {
    const type = node?.type ?? node?.comfyClass;
    if (type !== POWER_LORA_LOADER_TYPE) return false;
    if (typeof widgetName !== "string" || !LORA_ROW_NAME.test(widgetName)) return false;
    // ABSENT only. An existing row is written by the ordinary path, which already handles
    // the composite merge — minting over it would duplicate the row.
    if (widgetNames(node).includes(widgetName)) return false;
    return slotValue(value) !== null;
  } catch {
    return false; // an unreadable node is not one this route may mutate
  }
}

/**
 * rgthree's monotonic row counter, when this node exposes a readable one.
 *
 * Read so a refusal can put it BACK — see `restoreRowCounter`. Never used to DECIDE
 * anything: the name that appeared is established by comparing the widget list, because a
 * pack-private field is not a contract and the whole point of the post-verify is that the
 * call's effect is the only thing worth trusting.
 */
function readRowCounter(node) {
  try {
    const n = node?.loraWidgetsCounter;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Put the counter back after a refusal removed the row that advanced it.
 *
 * WITHOUT THIS THE REFUSAL IS A TRAP. `addNewLoraWidget` does `loraWidgetsCounter++` before
 * it names the row, and removing the row does not undo the increment. So a refusal that
 * says `the next row is "lora_7" … nothing was changed. Set "lora_7" instead` was wrong on
 * BOTH counts the moment it was printed: something *had* changed, and the very next call
 * mints `lora_8`. Following the advice refuses again, one name further along, forever —
 * measured on a faithful stand-in before this was written.
 *
 * Best-effort and narrow: only ever lowers a counter this call raised, never touches one it
 * cannot read, and the caller only asks once the row is confirmed gone — restoring while a
 * row still holds the name would hand the next mint a duplicate.
 */
function restoreRowCounter(node, previous) {
  if (previous === null) return false;
  try {
    if (typeof node.loraWidgetsCounter === "number" && node.loraWidgetsCounter > previous) {
      node.loraWidgetsCounter = previous;
      return true;
    }
  } catch {
    /* an unwritable counter is reported by the caller's wording, never raised */
  }
  return false;
}

/**
 * Grow the node to fit a row that was just added.
 *
 * `addNewLoraWidget` only mints, appends and reorders — it does NOT resize. rgthree's own
 * "➕ Add Lora" button does the resize itself, right after calling it:
 *
 *     this.addNewLoraWidget(value);
 *     const computed = this.computeSize();
 *     const tempHeight = this._tempHeight ?? 15;
 *     this.size[1] = Math.max(tempHeight, computed[1]);
 *     this.setDirtyCanvas(true, true);
 *
 * (rgthree-comfy/web/comfyui/power_lora_loader.js, `addNonLoraWidgets`.) Marking the canvas
 * dirty is not the same thing: a fresh loader keeps its old height, so the new row can be
 * clipped or drawn over the button until some unrelated edit resizes the node. Only the
 * HEIGHT is touched, exactly as the pack does — widening a node the user sized is not ours
 * to do. Best-effort: a stand-in without `computeSize` simply keeps its size.
 */
function fitNodeToRows(node) {
  try {
    if (typeof node?.computeSize !== "function" || !Array.isArray(node.size)) return;
    const computed = node.computeSize();
    const tempHeight = node._tempHeight ?? 15;
    node.size[1] = Math.max(tempHeight, computed[1]);
  } catch {
    /* a node that cannot measure itself keeps the size it had */
  }
}

/** Put a node's size back after a creation is rolled back. Best-effort, never throws. */
function restoreNodeSize(node, previous) {
  try {
    if (!previous || !Array.isArray(node?.size)) return;
    node.size[0] = previous[0];
    node.size[1] = previous[1];
  } catch {
    /* the row removal is what matters; a stale height is cosmetic */
  }
}

// A NEW ROW HAS A SETTLING PERIOD; AN EXISTING ONE DOES NOT. This is the difference that
// produced two separate P1s, and it is worth stating exactly once, here.
//
// `new PowerLoraLoaderWidget()` sets `showModelAndClip = null`, and the field is only
// synchronised with the node in `draw()` — read verbatim from the pack:
//
//     // PowerLoraLoaderWidget.draw
//     let currentShowModelAndClip =
//       node.properties[PROP_LABEL_SHOW_STRENGTHS] === PROP_VALUE_SHOW_STRENGTHS_SEPARATE;
//     if (this.showModelAndClip !== currentShowModelAndClip) {
//       let oldShowModelAndClip = this.showModelAndClip;
//       this.showModelAndClip = currentShowModelAndClip;
//       …
//     }
//
//     // PowerLoraLoaderWidget.serializeValue
//     const v = { ...this.value };
//     if (!this.showModelAndClip) { delete v.strengthTwo; }
//     else { this.value.strengthTwo = this.value.strengthTwo ?? 1; v.strengthTwo = …; }
//
// (rgthree-comfy/web/comfyui/power_lora_loader.js.) So a row that has not been DRAWN yet has
// `showModelAndClip === null`, which is falsy — every serialization takes the first branch and
// simply drops `strengthTwo`. A human never sees this: they click "➕ Add Lora", the canvas
// repaints, and the row is settled long before they touch a value. An agent creating and
// writing in one synchronous command gets no frame in between, so it writes into an unsettled
// row: the write verifies (nothing touched the value), and the FIRST draw afterwards flips
// `showModelAndClip` to true, at which point `serializeValue` rewrites `strengthTwo: null` to
// 1. A verified success that changes later, which is the one thing this file exists to prevent.
//
// The fix is to do what the first draw would have done, at creation time. Only the
// synchronisation is copied — NOT the value adjustment beside it, which the pack itself skips
// on a first draw (`oldShowModelAndClip != null` is false for a row that has never been drawn).
// That keeps a created row byte-identical to the same row created by the button and drawn once.
const RGTHREE_SHOW_STRENGTHS_PROP = "Show Strengths";
const RGTHREE_SHOW_STRENGTHS_SEPARATE = "Separate Model & Clip";

/**
 * Put a just-minted row into the state its first canvas draw would have left it in.
 *
 * Deliberately NARROW: one named field, mirroring one specific line of the pack's `draw`.
 * A blanket "copy everything a sibling has" would carry `value` and `name` across and corrupt
 * the row, and a general "simulate a draw" is not available without a canvas context.
 *
 * Best-effort on READS — a node whose `properties` throws simply leaves the row as it was, and
 * the caller's own verification still applies — but an assignment that throws propagates, so
 * the creation is rolled back rather than left half-settled.
 */
function settleCreatedRow(node, widget) {
  if (!widget) return;
  // Absent (not merely null) means this pack build has no such mode: nothing to settle.
  if (!("showModelAndClip" in widget)) return;
  if (widget.showModelAndClip !== null && widget.showModelAndClip !== undefined) return;
  let separate;
  try {
    separate = node?.properties?.[RGTHREE_SHOW_STRENGTHS_PROP] === RGTHREE_SHOW_STRENGTHS_SEPARATE;
  } catch {
    return; // an unreadable node tells us nothing; leave the row exactly as the pack made it
  }
  widget.showModelAndClip = separate;
}

/** Drop a widget the node grew but that we are not keeping. Best-effort, never throws. */
function removeCreatedRow(node, widget) {
  try {
    // Nothing to remove is a successful no-op, not a call with a missing argument: a node's
    // `removeWidget(undefined)` is pack code this file does not control.
    if (!widget) return;
    if (typeof node.removeWidget === "function") node.removeWidget(widget);
    else {
      const i = (node.widgets ?? []).indexOf(widget);
      if (i >= 0) node.widgets.splice(i, 1);
    }
  } catch {
    /* reported by the caller's message, never raised over the refusal it explains */
  }
}

/**
 * Create the requested `lora_N` row on an rgthree Power Lora Loader.
 *
 * Call ONLY when `isRgthreeLoraRowCreation` is true. Returns `{ created, remove }` — the name
 * of the row that now exists, and the undo for it, which the caller MUST run if the write it
 * made room for goes on to refuse. Throws with an actionable message otherwise, having left
 * the node as it found it.
 */
export function createRgthreeLoraRow(node, widgetName, { beforeChange, afterChange, setDirty } = {}) {
  // FEATURE-DETECT, and refuse loudly. A pack that renamed or dropped this method must
  // produce a refusal a reader can act on, never a silent no-op that reports success.
  if (typeof node?.addNewLoraWidget !== "function") {
    throw new Error(
      `Cannot create "${widgetName}" on node ${node?.id} (${POWER_LORA_LOADER_TYPE}): this ` +
        `version of the rgthree pack does not expose addNewLoraWidget(), which is the only ` +
        `way its lora rows are created. Ask the user to click "➕ Add Lora" on the node in ` +
        `the ComfyUI tab and then set the row — writing an existing row works normally.`,
    );
  }

  const before = widgetNames(node);
  // Snapshot the counter BEFORE the mint, so either refusal below can put it back and mean
  // it when it says nothing was changed. See `restoreRowCounter`.
  const counterBefore = readRowCounter(node);
  // …and the size, so a rollback puts back the height the creation grew. See `fitNodeToRows`.
  const sizeBefore = (() => {
    try {
      return Array.isArray(node?.size) ? [node.size[0], node.size[1]] : null;
    } catch {
      return null;
    }
  })();

  /** Rows on the node now that were not there before this call. */
  const appendedSince = () => {
    const grown = [];
    const seen = [...before];
    for (const name of widgetNames(node)) {
      const at = seen.indexOf(name);
      if (at >= 0) seen.splice(at, 1);
      else grown.push(name);
    }
    return grown;
  };

  beforeChange?.();
  try {
    node.addNewLoraWidget();
  } catch (err) {
    // The pack's own callback threw. Attribute it rather than letting a raw pack error
    // surface as though the panel had failed.
    const detail = (() => {
      try {
        return err?.message ? String(err.message) : String(err);
      } catch {
        return "the reason could not be rendered";
      }
    })();
    // A THROW IS NOT A NO-OP. The shipped method is
    //   `this.loraWidgetsCounter++; const w = this.addCustomWidget(new PowerLoraLoaderWidget(...));
    //    if (lora) w.setLora(lora); moveArrayItem(this.widgets, w, ...)`
    // so the counter is spent FIRST and the widget is appended SECOND. A throw in any later
    // step leaves the number burnt and can leave the row on the node — reporting "nothing was
    // added" without looking would be asserting something we never checked. Clean up whatever
    // did land, and say which of the two it was.
    const stranded = appendedSince();
    for (const name of stranded) {
      const w = (node.widgets ?? []).find((x) => x?.name === name);
      if (w) removeCreatedRow(node, w);
    }
    const rowsGone = appendedSince().length === 0;
    restoreRowCounter(node, counterBefore);
    if (rowsGone) restoreNodeSize(node, sizeBefore);
    // AN UNKNOWN COUNTER IS AN INCOMPLETE ROLLBACK, not a clean one. When the pack exposes
    // no readable `loraWidgetsCounter` we cannot see whether the throw happened after the
    // private increment — and it happens FIRST in the shipped method, so it probably did.
    // Treating `counterBefore === null` as "nothing changed" told the caller a retry was
    // safe when a row name had in fact been consumed, which is the same unfollowable advice
    // the mismatch refusal already had to stop giving. Only a counter we can READ and that
    // now READS BACK unchanged counts as restored.
    const counterRestored = counterBefore !== null && readRowCounter(node) === counterBefore;
    throw new Error(
      `Cannot create "${widgetName}" on node ${node?.id}: the rgthree pack's own ` +
        `addNewLoraWidget() threw (${detail}). ` +
        (rowsGone && counterRestored
          ? `Anything it had already added was removed again, so nothing was changed.`
          : !rowsGone
            ? `It had already changed the node before it threw, and that could not be fully ` +
              `undone (${stranded.join(", ")} is still on the node) — inspect the node before ` +
              `retrying.`
            : `The row it had started to add was removed again, but this node's row counter ` +
              `could not be ${counterBefore === null ? "read" : "rewound"}, so it may have ` +
              `consumed a row name before it threw — the next row could be numbered later ` +
              `than you expect. Read the node before retrying.`),
    );
  } finally {
    afterChange?.();
  }

  // THE EFFECT, NOT THE CALL. The probe that motivated this file found pack callbacks that
  // accept a call and create nothing; only comparing the list catches that.
  const appended = appendedSince();

  if (appended.length === 0) {
    // No row appeared, but the counter may still have been bumped before whatever went
    // wrong. Put it back, or this failed attempt silently costs the node a row name.
    restoreRowCounter(node, counterBefore);
    restoreNodeSize(node, sizeBefore);
    // Same rule as the throw path above: only a counter we can read, and that reads back
    // unchanged, licenses "nothing was changed". A pack that hides its counter may well have
    // advanced it — the increment comes first in the shipped method — and a caller told
    // nothing changed will retry into a row name that has already moved.
    const counterRestored = counterBefore !== null && readRowCounter(node) === counterBefore;
    throw new Error(
      `Cannot create "${widgetName}" on node ${node?.id}: addNewLoraWidget() ran but added ` +
        `no widget. ` +
        (counterRestored
          ? `Nothing was changed.`
          : `This node's row counter could not be ${counterBefore === null ? "read" : "rewound"}, ` +
            `so the call may still have consumed a row name — the next row could be numbered ` +
            `later than you expect. Read the node before retrying.`),
    );
  }

  if (!appended.includes(widgetName)) {
    // rgthree's counter is monotonic, so the row it minted may not be the name asked for.
    // Take it back out — a refusal that leaves a stray row behind cannot be safely retried.
    const created = (node.widgets ?? []).find((w) => appended.includes(w?.name));
    if (created) removeCreatedRow(node, created);
    // ONLY once the row is really gone: restoring the counter while the name is still held
    // would point the next mint at a duplicate. `removeCreatedRow` is best-effort, so ask
    // the node rather than assuming the call worked.
    const rowIsGone = !created || !(node.widgets ?? []).includes(created);
    if (rowIsGone) restoreRowCounter(node, counterBefore);
    if (rowIsGone) restoreNodeSize(node, sizeBefore);
    // ASK THE NODE, do not trust the attempt. `restoreRowCounter` reports whether it ran an
    // assignment, not whether the assignment TOOK: a counter that accepts `++` but silently
    // ignores writes back — a getter-only property, a pack that clamps, a proxy — returns
    // true from it while the number stays spent. The remedy below is only truthful if the
    // counter now READS BACK at the value this call started from, which is the same rule the
    // two refusal branches above and `remove()` below all use.
    const rewound = rowIsGone && counterBefore !== null && readRowCounter(node) === counterBefore;
    const real = appended.join(", ");
    // The remedy is only truthful if the counter went back. When it did not — an older pack
    // with no readable counter, or one that refuses the write — `real` is the name this
    // attempt CONSUMED, and the next one lands further along. Say which world we are in
    // rather than printing advice that cannot work; a wrong remedy costs a name per retry.
    const remedy = rewound
      ? `The row that was created has been removed again and the row counter was rewound — ` +
        `nothing was changed. Set "${real}" instead.`
      : `The row that was created has been removed again, but this node's row counter could ` +
        `not be rewound, so "${real}" is now used up and the next row will be named later ` +
        `still. Ask the user to click "➕ Add Lora" on the node and then set the row it adds.`;
    throw new Error(
      `Cannot create "${widgetName}" on node ${node?.id}: this node's next row is "${real}", ` +
        `not "${widgetName}" (rgthree numbers rows from a counter that only ever increases, ` +
        `so a removed row's name is not reused). ${remedy}`,
    );
  }

  // The row OBJECT, captured now — see `remove` below.
  const createdWidget = (() => {
    try {
      return (node.widgets ?? []).find((w) => w?.name === widgetName) ?? null;
    } catch {
      return null;
    }
  })();
  // EVERYTHING BELOW MUTATES A ROW THAT IS ALREADY ON THE NODE while the caller still has no
  // way to undo it — `remove` is only handed back at the very end, and runSetWidget evaluates
  // this whole function BEFORE it enters the try that would clean up. So a throw in any of
  // these steps (a hostile `computeSize`, an injected `setDirty` that raises, a widget whose
  // mode field has a throwing setter) used to strand the row, the row NAME it had spent and
  // the height it had grown, while the command reported a failure that had changed the graph.
  // The tail therefore undoes itself before it rethrows.
  try {
    // SETTLE THE ROW BEFORE ANYTHING READS IT. See `settleCreatedRow`.
    settleCreatedRow(node, createdWidget);
    // GROW THE NODE, as the pack's own button does. Marking the canvas dirty only repaints.
    fitNodeToRows(node);
    try {
      setDirty?.();
    } catch {
      /* a repaint hint is cosmetic — it must never fail a creation that otherwise worked */
    }
  } catch (err) {
    if (createdWidget) removeCreatedRow(node, createdWidget);
    restoreRowCounter(node, counterBefore);
    restoreNodeSize(node, sizeBefore);
    throw err;
  }
  // The counter as it stands with THIS row's increment and no other. `remove` refuses to
  // rewind unless it still reads exactly this, because anything else means the number it
  // would rewind past is not only ours. See the note on the rollback below.
  const counterAfter = readRowCounter(node);
  return {
    created: widgetName,
    /**
     * Take this creation back out again.
     *
     * The caller needs it because creation has to happen BEFORE the value write (the widget
     * must exist for the ordinary path to resolve it) while the write can still refuse
     * afterwards. Reporting that refusal over a node this command had already GROWN is the
     * mutate-then-refuse shape the panel works to avoid, and every retry would add a row.
     *
     * BY IDENTITY, not by name. Re-finding `lora_N` at undo time would remove whatever
     * answers to that name then, which after an intervening `configure()` — rgthree re-mints
     * rows from serialized order — is not necessarily the widget this call grew.
     *
     * CALLED IN THE SAME SYNCHRONOUS STRETCH AS THE CREATION, from runSetWidget's write
     * boundary. That is what makes it safe to remove the row unconditionally: no other
     * command frame, user gesture or undo capture can run between the two, so the row can
     * only be the one this call grew and untouched since. An earlier version created the row
     * before an awaited /object_info fetch and needed a claim to avoid deleting a row a
     * concurrent request had written; moving the creation past the await removed the window
     * instead, and the claim with it.
     *
     * BOTH HALVES, for the reason `restoreRowCounter` exists: `addNewLoraWidget` increments
     * before it names, so dropping only the widget leaves the number spent and the next mint
     * lands further along.
     *
     * BUT NEVER PAST SOMEBODY ELSE'S INCREMENT. The counter is rewound only when it still
     * reads exactly what this call left it at. If another row was added in the meantime the
     * counter includes that one too, and winding back to `counterBefore` would re-issue names
     * that are already taken — create lora_1, add lora_2, roll back, and the next two mints
     * are lora_1 and a DUPLICATE lora_2. A burnt number is recoverable; two rows with the
     * same name are not.
     *
     * Returns `{ removed, incomplete }`. `removed` says whether the row itself went;
     * `incomplete` is a sentence for the caller to disclose when the rollback could NOT put
     * everything back, or null when it could. Never throws — an undo running on an error path
     * must not replace the refusal with an error about the undo.
     *
     * WHY AN UNRESTORED COUNTER IS A REPORTABLE OUTCOME AND NOT A SHRUG. A pack that exposes
     * `addNewLoraWidget` but hides or freezes `loraWidgetsCounter` lets this call mint a row,
     * lets the write refuse it (a slot with an invalid field type), and then takes the row
     * back out — but the NAME stays spent. Returning a bare success there told the caller
     * only that its value was invalid, so the obvious retry (same `lora_N`, corrected value)
     * mints a LATER row and refuses again on the name, which is the same unfollowable advice
     * the mismatch refusal already had to stop giving.
     */
    remove: () => {
      try {
        if (!createdWidget) return { removed: false, incomplete: null };
        removeCreatedRow(node, createdWidget);
        const rowIsGone = !(node.widgets ?? []).includes(createdWidget);
        if (!rowIsGone) {
          return {
            removed: false,
            incomplete:
              `The row "${widgetName}" this call had added could not be removed again and is ` +
              `still on the node — inspect the node before retrying.`,
          };
        }
        // Only when the counter is still exactly this call's increment.
        if (counterAfter !== null && readRowCounter(node) === counterAfter) {
          restoreRowCounter(node, counterBefore);
        }
        restoreNodeSize(node, sizeBefore);
        // DID IT COME BACK? Asked of the NODE, not of the attempt — the same rule the two
        // refusal branches above use. `restoreRowCounter` reports false both when it could
        // not write and when there was nothing to undo, so its return cannot tell those
        // apart; reading the counter can. A counter that never moved is clean, an unreadable
        // or unwritable one is not, and a counter another row has since advanced is not ours
        // to wind back and leaves this name spent all the same.
        const counterBack = counterBefore !== null && readRowCounter(node) === counterBefore;
        return {
          removed: true,
          incomplete: counterBack
            ? null
            : `The row "${widgetName}" it had created was removed again, but this node's row ` +
              `counter could not be ${counterBefore === null ? "read" : "rewound"}, so that name ` +
              `is used up: the next row will be numbered later than you expect. Read the node ` +
              `with panel_query_graph before retrying — asking for "${widgetName}" again will ` +
              `create a differently-named row and refuse a second time.`,
        };
      } catch {
        /* best-effort: the refusal this is undoing is the message that reaches the caller */
        return { removed: false, incomplete: null };
      }
    },
  };
}
