/**
 * Copy/paste drop detection (#261).
 *
 * LiteGraph's `pasteFromClipboard` silently SKIPS any clipboard node whose
 * `type` is not a registered node class on the target frontend
 * (`LiteGraph.createNode` returns null → the node is dropped with no signal).
 * That is how copying 21 nodes from the `wan-multitalk` pack pasted only 19:
 * `AudioCrop` and `AudioSeparation` weren't registered on the destination
 * canvas, so they vanished and `pasted_count` quietly reported 19.
 *
 * This module records what `graph_copy_nodes` put on the clipboard and diffs it
 * against what actually landed after `graph_paste_nodes`, so the handler can
 * surface an explicit dropped-node report (ids + types) instead of silently
 * shrinking the count. The diff is a pure, per-type multiset subtraction so it
 * is fully unit-testable against the real serialized node shape.
 */

/** Normalize an iterable of live LiteGraph items (or a Set) into `{id, type}`
 *  records, keeping only real nodes (an `id` and a string `type`). Groups,
 *  reroutes without a type, and other canvas selection items are excluded. */
export function normalizeCopiedItems(items) {
  const out = [];
  for (const it of items ?? []) {
    if (it && it.id != null && typeof it.type === "string") {
      out.push({ id: it.id, type: it.type });
    }
  }
  return out;
}

// Snapshot of the last clipboard write, so a later paste can diff against it.
let _clipboardSnapshot = [];

/** Record what was just copied to the clipboard. Returns the normalized list. */
export function recordCopiedNodes(items) {
  _clipboardSnapshot = normalizeCopiedItems(items);
  return _clipboardSnapshot;
}

/** The most recent clipboard snapshot (empty array if nothing was copied). */
export function getCopiedSnapshot() {
  return _clipboardSnapshot;
}

/**
 * Diff the copied clipboard nodes against the nodes that actually pasted.
 * Matches per node TYPE (a multiset subtraction) because paste assigns fresh
 * ids, so ids can't be compared directly. Any copied node whose type wasn't
 * produced by the paste is reported as dropped (carrying its ORIGINAL id/type).
 *
 * @param {Array<{id?:any,type?:string}>} copied  clipboard snapshot
 * @param {Array<{id?:any,type?:string}>} pasted  nodes that landed on the graph
 * @returns {{dropped: Array<{id:any,type:string}>, dropped_count: number, dropped_types: string[]}}
 */
export function diffCopiedVsPasted(copied, pasted) {
  const pastedByType = new Map();
  for (const n of pasted ?? []) {
    const t = n?.type;
    if (typeof t !== "string") continue;
    pastedByType.set(t, (pastedByType.get(t) ?? 0) + 1);
  }
  const dropped = [];
  for (const item of copied ?? []) {
    const t = item?.type;
    if (typeof t !== "string") continue;
    const avail = pastedByType.get(t) ?? 0;
    if (avail > 0) {
      pastedByType.set(t, avail - 1);
    } else {
      dropped.push({ id: item.id ?? null, type: t });
    }
  }
  const dropped_types = [...new Set(dropped.map((d) => d.type))];
  return { dropped, dropped_count: dropped.length, dropped_types };
}

/** Human-readable one-liner for a dropped-node report, or null if none. */
export function formatDroppedWarning(dropped) {
  if (!dropped || !dropped.length) return null;
  const byType = new Map();
  for (const d of dropped) byType.set(d.type, [...(byType.get(d.type) ?? []), d.id]);
  const parts = [...byType.entries()].map(
    ([type, ids]) => `${type} (source id${ids.length > 1 ? "s" : ""}: ${ids.join(", ")})`,
  );
  return (
    `${dropped.length} node${dropped.length > 1 ? "s" : ""} could not be pasted because ` +
    `their node type${byType.size > 1 ? "s are" : " is"} not registered on this ComfyUI ` +
    `frontend (install the pack that provides them, then retry): ${parts.join("; ")}`
  );
}
