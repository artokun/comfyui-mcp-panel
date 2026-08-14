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
 *   3. the VALUE is a lora-slot object the existing writer already accepts.
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
    return isLoraSlotObject(value);
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

/** Drop a widget the node grew but that we are not keeping. Best-effort, never throws. */
function removeCreatedRow(node, widget) {
  try {
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
 * Call ONLY when `isRgthreeLoraRowCreation` is true. Returns `{ created }` naming the row
 * that now exists; throws with an actionable message otherwise, having left the node as it
 * found it.
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
    throw new Error(
      `Cannot create "${widgetName}" on node ${node?.id}: the rgthree pack's own ` +
        `addNewLoraWidget() threw (${detail}). Nothing was added.`,
    );
  } finally {
    afterChange?.();
  }

  const after = widgetNames(node);
  // THE EFFECT, NOT THE CALL. The probe that motivated this file found pack callbacks that
  // accept a call and create nothing; only comparing the list catches that.
  const appended = [];
  const seen = [...before];
  for (const name of after) {
    const at = seen.indexOf(name);
    if (at >= 0) seen.splice(at, 1);
    else appended.push(name);
  }

  if (appended.length === 0) {
    // No row appeared, but the counter may still have been bumped before whatever went
    // wrong. Put it back, or this failed attempt silently costs the node a row name.
    restoreRowCounter(node, counterBefore);
    throw new Error(
      `Cannot create "${widgetName}" on node ${node?.id}: addNewLoraWidget() ran but added ` +
        `no widget. Nothing was changed.`,
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
    const rewound = rowIsGone && restoreRowCounter(node, counterBefore);
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

  setDirty?.();
  return { created: widgetName };
}
