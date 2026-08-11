// Removing ONE dynamic widget row (artokun/comfyui-mcp#938).
//
// Nodes with repeatable rows are common — rgthree Power Lora Loader (`lora_1..lora_N`),
// Impact/Inspire list nodes, any "➕ Add row" custom node. Their add/remove affordance is a
// DOM-level custom widget (an x button, a right-click item) that an agent cannot click, so
// those rows were effectively un-removable from an agent session: `panel_set_widget` can
// overwrite a row's value but not delete the row, and `panel_remove_node` deletes the whole
// node. The user had to do it by hand, which breaks the "I can edit your canvas" contract.
//
// TWO THINGS THE ISSUE ASKED FOR THAT THE NODE'S OWN CODE SAYS NOT TO DO. I filed that
// issue and was wrong about both; the source is the authority, not the UI:
//
//   "Call the node's own removal path so its bookkeeping runs."  rgthree's 🗑️ Remove is
//   `removeArrayItem(this.widgets, widget)` — a plain splice, no hook, no bookkeeping.
//   There is nothing to call. We use the frontend's own `node.removeWidget()` when it
//   exists (LGraphNode provides it; rgthree's `configure()` calls it) and splice otherwise.
//
//   "Renumber the remaining rows (lora_2 -> lora_1)."  The names are not positional.
//   rgthree's `loraWidgetsCounter` is monotonic, `configure()` re-mints `lora_1..N` from
//   serialized ORDER on every load, and the python reads `**kwargs` filtered by
//   `startswith('lora_')`, so gaps never reach the backend. Renumbering would diverge from
//   the node's own UI, be undone on the next reload, and collide the counter so a later
//   "➕ Add Lora" could mint a name that already exists. ORDER is what is load-bearing —
//   serialization is positional — and a splice preserves it.
//
// THE REFUSALS ARE THE POINT. Deleting a widget the BACKEND declared is not a layout tweak:
// it changes what is sent at queue time. So the classifier is allowed exactly three
// answers, and "I could not find out" is one of them (#796) — it must never resolve to
// "it is not backend-declared", which is the shape of every bug in this codebase where a
// failed lookup became a confident negative.

import { isControlAfterGenerateWidget } from "./control-after-generate.js";

/** Widget names whose VALUE we never echo back, even in a "here is what I removed" reply. */
const SECRETISH_NAME = /(api[_-]?key|secret|token|password|passwd|credential)/i;

/**
 * The value to report for a removed widget. A dynamic row's value is normally innocuous
 * (a lora filename, a strength), but the reply lands in a transcript, so a widget whose
 * NAME advertises a credential is reported as present-or-absent and never quoted.
 */
export function reportableWidgetValue(name, value) {
  if (SECRETISH_NAME.test(String(name ?? ""))) {
    return value === undefined || value === null || value === "" ? null : "<redacted>";
  }
  return value;
}

/**
 * Input names the BACKEND declares for a node class, from a fresh /object_info def.
 * Returns null when the def cannot be read at all — the caller must treat that as
 * "unknown", never as "declares nothing".
 */
export function declaredInputNames(def) {
  if (!def || typeof def !== "object") return null;
  const input = def.input;
  if (!input || typeof input !== "object") return null;
  const names = new Set();
  for (const group of ["required", "optional", "hidden"]) {
    const g = input[group];
    if (g && typeof g === "object") for (const k of Object.keys(g)) names.add(k);
  }
  return names;
}

/**
 * Can this widget be removed?
 *
 *   "missing"          — no widget by that name on the node
 *   "unknown"          — the backend def could not be read, so we cannot tell a dynamic
 *                        row from a declared input. REFUSE; do not guess.
 *   "backend-declared" — the def lists this input. Removing it changes the queued prompt.
 *   "synthesized"      — a frontend-generated control (control_after_generate), which the
 *                        frontend re-creates, so removing it is a no-op that reads as a
 *                        success.
 *   "linked"           — the widget is carried by an input slot that currently has a LINK.
 *                        Removing it would orphan the wire silently.
 *   "dynamic"          — a row the node added itself. Removable.
 */
export function classifyWidgetRemoval(node, widgetName, { declaredNames } = {}) {
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  const index = widgets.findIndex((w) => w?.name === widgetName);
  if (index === -1) {
    return { kind: "missing", index: -1, widget: null, present: widgets.map((w) => w?.name).filter(Boolean) };
  }
  const widget = widgets[index];

  // Ordered so the CHEAP, certain answers come before the one that needs the backend:
  // a synthesized control and a linked input are decidable from the graph alone, and
  // reporting "I could not read /object_info" for a control_after_generate widget would
  // be a worse message than the true one.
  if (isControlAfterGenerateWidget(widget)) return { kind: "synthesized", index, widget };

  const linkedInput = (Array.isArray(node?.inputs) ? node.inputs : []).find(
    (i) => i?.widget?.name === widgetName && i?.link != null,
  );
  if (linkedInput) return { kind: "linked", index, widget, input_name: linkedInput.name ?? widgetName };

  if (!declaredNames) return { kind: "unknown", index, widget };
  if (declaredNames.has(widgetName)) return { kind: "backend-declared", index, widget };
  return { kind: "dynamic", index, widget };
}

/** The refusal text for each non-removable classification. Exported so tests assert it. */
export function removalRefusal(node, widgetName, classification, { objectInfoNote } = {}) {
  const id = node?.id;
  const type = node?.type ?? node?.comfyClass ?? "node";
  switch (classification.kind) {
    case "missing": {
      const names = classification.present ?? [];
      return (
        `Node ${id} (${type}) has no widget named "${widgetName}". ` +
        (names.length
          ? `Its widgets are: ${names.join(", ")}.`
          : `It has no widgets at all.`)
      );
    }
    case "unknown":
      return (
        `Refusing to remove "${widgetName}" from node ${id} (${type}): I could not read the ` +
        `node definitions, so I cannot tell a dynamic row from an input the backend declares. ` +
        `Removing a declared input changes what is sent at queue time, so this is not a guess ` +
        `worth making.` + (objectInfoNote ? ` ${objectInfoNote}` : "")
      );
    case "backend-declared":
      return (
        `"${widgetName}" is an input the backend declares for ${type}, not a dynamic row — ` +
        `removing it would change what is sent when the workflow is queued. Set its value with ` +
        `panel_set_widget instead, or remove the whole node with panel_remove_node.`
      );
    case "synthesized":
      return (
        `"${widgetName}" on node ${id} is a control widget the ComfyUI frontend generates ` +
        `(it governs how the value next to it is rewritten after each run). The frontend ` +
        `re-creates it, so removing it would look like it worked and change nothing. Set it to ` +
        `"fixed" with panel_set_widget if you want the value to stop moving.`
      );
    case "linked":
      return (
        `"${widgetName}" on node ${id} is currently connected to another node by a link. ` +
        `Removing it would leave that wire dangling. Disconnect it first with panel_disconnect ` +
        `(input "${classification.input_name ?? widgetName}"), then remove the row.`
      );
    default:
      return `"${widgetName}" on node ${id} cannot be removed.`;
  }
}

/**
 * Remove the widget, or throw with the refusal.
 *
 * Bracketed in ONE beforeChange/afterChange pair so a single Ctrl+Z restores the row —
 * the "Undoable with Ctrl+Z" contract the other mutators keep.
 *
 * Removal is VERIFIED rather than assumed: `node.removeWidget` is an override point (any
 * custom node may reimplement it, and rgthree does reimplement plenty), so a call that
 * silently no-ops would otherwise be reported as a success and the agent would move on
 * believing the row is gone.
 */
export function runRemoveWidget(node, widgetName, opts = {}) {
  const { declaredNames, objectInfoNote, beforeChange, afterChange, setDirty } = opts;
  const classification = classifyWidgetRemoval(node, widgetName, { declaredNames });
  if (classification.kind !== "dynamic") {
    throw new Error(removalRefusal(node, widgetName, classification, { objectInfoNote }));
  }

  const { widget, index } = classification;
  const previous = reportableWidgetValue(widgetName, widget?.value);

  beforeChange?.();
  try {
    // PASS THE WIDGET, NOT THE INDEX. LGraphNode.removeWidget takes the widget OBJECT:
    // it does `indexOf(arg)` and throws "Widget not found on this node" when that misses,
    // so an index argument threw on every call and removed nothing.
    //
    // I had evidence and misread it. rgthree's `configure()` does
    // `while (this.widgets?.length) this.removeWidget(0)`, and I took that as proof the
    // signature is index-based. It is legacy code written against an older litegraph;
    // on the current frontend that line throws too. A call that happens to exist is not
    // a contract — the method's own source is.
    //
    // There is no fallback path. removeWidget lives on LGraphNode.prototype, so
    // `typeof === "function"` is unconditionally true and a `splice` branch behind that
    // test is unreachable code that reads like a safety net. If the method is ever
    // genuinely absent, the verification below reports it honestly instead.
    if (typeof node.removeWidget === "function") node.removeWidget(widget);
    else node.widgets.splice(index, 1);
  } finally {
    afterChange?.();
  }

  if (node.widgets?.includes(widget)) {
    throw new Error(
      `"${widgetName}" is still on node ${node.id} after the removal — the node appears to ` +
        `protect this widget (its own removeWidget did not drop it). Nothing was changed.`,
    );
  }

  setDirty?.();
  return {
    removed: {
      node_id: node.id,
      node_type: node.type ?? node.comfyClass ?? null,
      widget: widgetName,
      index,
      previous_value: previous,
    },
    // The remaining row names, because they are NOT renumbered (see the header): an agent
    // that assumed `lora_2` became `lora_1` would address the wrong row on its next call.
    remaining_widgets: (node.widgets ?? []).map((w) => w?.name).filter(Boolean),
  };
}
