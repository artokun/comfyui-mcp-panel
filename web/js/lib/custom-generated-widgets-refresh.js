/**
 * #1932 — after `panel_set_widget` writes a hidden backend widget, a node's
 * generated custom-widget UI stayed STALE.
 *
 * ## The mechanism this works around, read from the pack
 *
 * Deno's Multi LoRA loaders (`DenoMultiLoraLoader`, `DenoLTXMultiLoraLoader`,
 * `web/js/deno_multi_lora.js` / `deno_ltx_multi_lora.js`) keep the values the
 * backend actually reads on HIDDEN widgets (`active_loras`, `lora_N`,
 * strengths, …) and draw a generated row UI on top:
 *
 *     this.options = { serialize: false };
 *     this.name = `${GENERATED_PREFIX}row_${index}`;   // type "custom"
 *
 * `rebuildUi()` is the only function that mints or drops those rows, and it
 * runs from setup/configure and from the node's own +Add / remove handlers.
 * `redraw()` — what an in-node value tweak calls — only `setDirtyCanvas()`s.
 * It does not rebuild rows, and it does not recompute height.
 *
 * `panel_set_widget` writes the hidden backend widget (and dirties the canvas)
 * the way an interactive edit of that widget would. There is no interactive
 * edit of the hidden widget: the user clicks generated rows, which call
 * `rebuildUi`. So a write to `active_loras` 1→3 (or to `lora_2` on a node
 * whose generated list was already one row behind) reported success while
 * the visible rows/height stayed at the previous count until the subgraph
 * was left and re-entered — which is `onConfigure` → `setupNode` → `rebuildUi`.
 *
 * ## What this does
 *
 * After a write has succeeded and been verified, if the node the write landed
 * on carries that pattern — hidden backend widgets PLUS generated
 * non-serialized custom widgets — rebuild the generated rows to match the
 * hidden `active_loras` count, recompute size, and dirty the canvas. The
 * rebuild is the pack's own:
 *
 *   1. `onConfigure()` is the public re-entry the workaround already used
 *      (Deno queues `setupNode` from it). Invoked when present.
 *   2. Generated row widgets are then reconciled synchronously from an
 *      existing row's constructor (`new RowCtor(index)`), because Deno's
 *      `onConfigure` is a `queueMicrotask` and a caller that reads the node
 *      in the same turn must see the new rows without waiting for paint.
 *
 * ## Why it is keyed this way
 *
 * NOT keyed on node.type: the two Deno loaders already share the pattern
 * under different type names and generated-name prefixes, and a third pack
 * that hides backend widgets behind serialize:false custom rows would
 * silently keep the stale-UI behaviour. The key is the PATTERN itself.
 *
 * The +Add generated control is NEVER pressed. Auto-pressing it would
 * increment `active_loras` (the #757 / pressable-widget.js lesson: a
 * generic "this node has one button" rule mutates the graph on a typo).
 * Rows are minted only to MATCH a count the write already stored.
 *
 * ## What it reports
 *
 *   - generated widget names or node size changed → `{ refreshed: true, widgets: [...] }`
 *   - the rebuild threw → `{ failed: <sentence> }` (and `widgets` when the
 *     list moved before the throw). Never thrown over a verified write.
 *   - no such pattern, or the rebuild changed nothing → `null`.
 *
 * Never throws.
 */

const reflectApply = Reflect.apply;
const MAX_SLOT_GUARD = 32;

function coerceThrowMessage(err) {
  try {
    const msg = err?.message;
    if (typeof msg === "string" && msg) return msg;
    return String(err);
  } catch {
    return "the reason could not be rendered";
  }
}

function widgetName(widget) {
  try {
    return typeof widget?.name === "string" ? widget.name : null;
  } catch {
    return null;
  }
}

function isHiddenBackendWidget(widget) {
  try {
    if (!widget) return false;
    if (widget.hidden === true) return true;
    return widget.type === "converted-widget";
  } catch {
    return false;
  }
}

function isGeneratedCustomWidget(widget) {
  try {
    if (!widget) return false;
    if (isHiddenBackendWidget(widget)) return false;
    const serialize = widget.options?.serialize;
    return serialize === false;
  } catch {
    return false;
  }
}

function readWidgets(node) {
  try {
    return Array.isArray(node?.widgets) ? node.widgets : null;
  } catch {
    return null;
  }
}

function generatedNames(node) {
  const widgets = readWidgets(node);
  if (!widgets) return [];
  const names = [];
  for (const widget of widgets) {
    if (!isGeneratedCustomWidget(widget)) continue;
    names.push(widgetName(widget));
  }
  return names;
}

function sameNames(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readSize(node) {
  try {
    const size = node?.size;
    if (!Array.isArray(size) || size.length < 2) return [null, null];
    return [size[0], size[1]];
  } catch {
    return [null, null];
  }
}

function snapshot(node) {
  const size = readSize(node);
  return { names: generatedNames(node), size0: size[0], size1: size[1] };
}

function snapshotsEqual(a, b) {
  return sameNames(a.names, b.names) && Object.is(a.size0, b.size0) && Object.is(a.size1, b.size1);
}

/**
 * True when the node hides backend widgets AND draws generated custom widgets
 * that do not serialize — the Deno Multi LoRA pattern. Never throws.
 *
 * @param {object} node
 */
export function hasGeneratedCustomWidgetPattern(node) {
  try {
    const widgets = readWidgets(node);
    if (!widgets || !widgets.length) return false;
    let hidden = false;
    let generated = false;
    for (const widget of widgets) {
      if (!hidden && isHiddenBackendWidget(widget)) hidden = true;
      if (!generated && isGeneratedCustomWidget(widget)) generated = true;
      if (hidden && generated) return true;
    }
  } catch {
    /* an unreadable node does not match */
  }
  return false;
}

function rowIndexOf(widget) {
  try {
    const name = widgetName(widget);
    if (typeof name === "string") {
      const match = /row_(\d+)$/.exec(name);
      if (match) return Number(match[1]);
    }
    const index = widget?.index;
    if (typeof index === "number" && Number.isFinite(index) && index >= 1) return index;
  } catch {
    /* not a row */
  }
  return null;
}

function hiddenCountWidget(widgets) {
  for (const widget of widgets) {
    try {
      if (isHiddenBackendWidget(widget) && widgetName(widget) === "active_loras") return widget;
    } catch {
      /* skip */
    }
  }
  return null;
}

function hiddenSlotCeiling(widgets) {
  let max = 0;
  for (const widget of widgets) {
    try {
      if (!isHiddenBackendWidget(widget)) continue;
      const name = widgetName(widget);
      if (!name) continue;
      const match = /^(?:lora|enabled|model_strength|clip_strength|strength|video|audio|trigger|description)_(\d+)$/.exec(
        name,
      );
      if (match) max = Math.max(max, Number(match[1]));
    } catch {
      /* skip */
    }
  }
  return max;
}

function targetRowCount(node) {
  const widgets = readWidgets(node);
  if (!widgets) return null;
  const countWidget = hiddenCountWidget(widgets);
  if (!countWidget) return null;
  let raw;
  try {
    raw = Number(countWidget.value);
  } catch {
    return null;
  }
  const n = Number.isFinite(raw) ? Math.round(raw) : 0;
  const ceiling = hiddenSlotCeiling(widgets) || MAX_SLOT_GUARD;
  return Math.max(0, Math.min(n, ceiling, MAX_SLOT_GUARD));
}

function removeStaleRowElement(widget) {
  try {
    const element = widget?.element;
    if (!element) return;
    if (element.parentNode && typeof element.parentNode.removeChild === "function") {
      element.parentNode.removeChild(element);
      return;
    }
    if (typeof element.remove === "function") element.remove();
  } catch {
    /* DOM teardown is best-effort */
  }
}

function mintedRowLooksRight(row, index) {
  try {
    if (!row || typeof row !== "object") return false;
    if (rowIndexOf(row) === index) return true;
    const name = widgetName(row);
    return typeof name === "string" && name.endsWith(`row_${index}`);
  } catch {
    return false;
  }
}

function insertRow(node, row) {
  const widgets = readWidgets(node);
  if (!widgets) return false;
  if (typeof node.addCustomWidget === "function") {
    try {
      reflectApply(node.addCustomWidget, node, [row]);
    } catch {
      /* fall through to splice onto whatever array we can still see */
    }
  }
  const live = readWidgets(node);
  if (!live) return false;
  if (!live.includes(row)) live.push(row);
  const at = live.indexOf(row);
  const addIdx = live.findIndex((widget, i) => {
    if (i === at) return false;
    const name = widgetName(widget);
    return typeof name === "string" && name.endsWith("add_button");
  });
  if (addIdx >= 0 && at >= 0 && at !== addIdx) {
    live.splice(at, 1);
    live.splice(at < addIdx ? addIdx - 1 : addIdx, 0, row);
  }
  return live.includes(row);
}

function dropRowsAbove(node, target) {
  const widgets = readWidgets(node);
  if (!widgets) return;
  const kept = [];
  for (const widget of widgets) {
    const index = isGeneratedCustomWidget(widget) ? rowIndexOf(widget) : null;
    if (index != null && index > target) {
      removeStaleRowElement(widget);
      continue;
    }
    kept.push(widget);
  }
  if (kept.length === widgets.length) return;
  try {
    node.widgets = kept;
  } catch {
    widgets.length = 0;
    for (const widget of kept) widgets.push(widget);
  }
}

function existingRows(node) {
  const widgets = readWidgets(node);
  const byIndex = new Map();
  if (!widgets) return byIndex;
  for (const widget of widgets) {
    if (!isGeneratedCustomWidget(widget)) continue;
    const index = rowIndexOf(widget);
    if (index == null) continue;
    if (!byIndex.has(index)) byIndex.set(index, widget);
  }
  return byIndex;
}

function rowConstructor(rows) {
  for (const widget of rows.values()) {
    try {
      if (typeof widget?.constructor === "function") return widget.constructor;
    } catch {
      /* skip */
    }
  }
  return null;
}

function reconcileGeneratedRows(node) {
  const target = targetRowCount(node);
  if (target == null) return;
  dropRowsAbove(node, target);
  if (target < 1) return;
  const rows = existingRows(node);
  const Ctor = rowConstructor(rows);
  if (typeof Ctor !== "function") return;
  for (let index = 1; index <= target; index++) {
    if (rows.has(index)) continue;
    let minted = null;
    try {
      minted = new Ctor(index);
    } catch {
      continue;
    }
    if (!mintedRowLooksRight(minted, index)) continue;
    if (insertRow(node, minted)) rows.set(index, minted);
  }
}

function recomputeSize(node) {
  try {
    const computed = typeof node.computeSize === "function" ? node.computeSize() : null;
    if (!Array.isArray(computed) || computed.length < 2) return;
    const next0 = computed[0];
    const next1 = computed[1];
    if (!Array.isArray(node.size)) {
      node.size = [next0, next1];
      return;
    }
    const cur0 = Number(node.size[0]);
    node.size[0] = Number.isFinite(cur0) ? Math.max(cur0, Number(next0) || 0) : next0;
    node.size[1] = next1;
  } catch {
    /* size is presentation; a throw must not fail a rebuild that already minted rows */
  }
}

function dirtyCanvas(node, setDirty) {
  try {
    setDirty?.();
  } catch {
    /* a repaint hint is cosmetic */
  }
  try {
    node.setDirtyCanvas?.(true, true);
  } catch {
    /* same */
  }
}

/**
 * Rebuild generated custom-widget rows after a successful write.
 *
 * Call ONLY from the synchronous write boundary of a write that has already
 * succeeded and been verified — minting/dropping widgets is a graph mutation,
 * so it must not sit across an await.
 *
 * @returns {null | { refreshed: true, widgets: (string|null)[] } | { failed: string, widgets?: (string|null)[] }}
 */
export function refreshCustomGeneratedWidgetsAfterWrite(node, { beforeChange, afterChange, setDirty } = {}) {
  try {
    if (!hasGeneratedCustomWidgetPattern(node)) return null;

    const before = snapshot(node);
    try {
      beforeChange?.();
    } catch {
      /* history hook is best-effort */
    }
    let threw = null;
    try {
      // Pack-owned re-entry. Deno rebuilds generated rows from onConfigure →
      // setupNode → rebuildUi (the same path leaving and re-entering a subgraph
      // takes). Arguments are not supplied: this is a refresh of widgets already
      // on the node, not a deserialize.
      if (typeof node.onConfigure === "function") {
        reflectApply(node.onConfigure, node, []);
      }
    } catch (err) {
      threw = err;
    }
    try {
      // Constructor-clone is independent of onConfigure: Deno queues setupNode
      // on a microtask, and a throwing onConfigure must not skip the sync mint
      // that makes the new rows visible in this turn.
      reconcileGeneratedRows(node);
      recomputeSize(node);
    } catch (err) {
      threw = threw ?? err;
    } finally {
      try {
        afterChange?.();
      } catch {
        /* history hook is best-effort */
      }
    }

    const after = snapshot(node);
    const changed = !snapshotsEqual(before, after);
    dirtyCanvas(node, setDirty);

    if (threw) {
      return {
        failed:
          `The write itself succeeded and was verified, but rebuilding the node's generated ` +
          `custom widgets threw (${coerceThrowMessage(threw)}), so its visible rows may still ` +
          `be stale${changed ? " — and may be PARTIALLY rebuilt, because the list changed before it threw" : ""}. ` +
          `Read the node with panel_query_graph before relying on its widgets.`,
        ...(changed ? { widgets: after.names } : {}),
      };
    }

    if (!changed) return null;
    return { refreshed: true, widgets: after.names };
  } catch (err) {
    return {
      failed:
        `The write itself succeeded and was verified, but refreshing the node's generated ` +
        `custom widgets afterwards failed (${coerceThrowMessage(err)}), so they may still be ` +
        `stale. Read the node with panel_query_graph before relying on its widgets.`,
    };
  }
}
