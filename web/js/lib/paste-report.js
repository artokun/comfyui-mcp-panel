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

// Snapshot of the last clipboard write, so a later paste can diff against it —
// paired with a FINGERPRINT of the raw clipboard at copy time. The snapshot is
// only trustworthy while the clipboard still holds exactly what we copied; a
// native Ctrl+C in between replaces the clipboard and invalidates it.
let _clipboardSnapshot = [];
let _clipboardFingerprint = null;

/** Record what was just copied. `fingerprint` is the raw clipboard payload
 *  (e.g. the localStorage string) captured right AFTER the copy, used later to
 *  detect whether the clipboard was replaced before the paste. */
export function recordCopiedNodes(items, fingerprint = null) {
  _clipboardSnapshot = normalizeCopiedItems(items);
  _clipboardFingerprint = fingerprint;
  return _clipboardSnapshot;
}

/** The most recent clipboard snapshot (empty array if nothing was copied). */
export function getCopiedSnapshot() {
  return _clipboardSnapshot;
}

/**
 * The snapshot, but ONLY if `currentFingerprint` proves the clipboard hasn't
 * changed since it was recorded (non-null and byte-identical). Otherwise [].
 * This is what lets the snapshot fallback be used safely: if a native Ctrl+C
 * replaced the clipboard, the fingerprint won't match and no stale nodes leak
 * into the drop report. A null fingerprint (clipboard unreadable at copy or
 * paste) is never considered a match, so it can't fabricate drops either.
 */
export function getVerifiedSnapshot(currentFingerprint) {
  if (
    _clipboardFingerprint != null &&
    currentFingerprint != null &&
    currentFingerprint === _clipboardFingerprint
  ) {
    return _clipboardSnapshot;
  }
  return [];
}

/**
 * Parse LiteGraph's serialized clipboard payload into `{id, type}` records.
 * This is the AUTHORITATIVE source of what a paste will attempt — it reflects
 * whatever is on the clipboard right now, whether it got there via
 * graph_copy_nodes or a native Ctrl+C, so it can never go stale the way a
 * remembered snapshot can. Accepts the raw JSON string, a parsed object, or an
 * array; tolerates the `{nodes:[…]}` and bare-array shapes. Returns [] on any
 * unrecognized / unreadable payload (caller then falls back to the snapshot).
 */
export function parseClipboardNodes(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!data) return [];
  const nodes = Array.isArray(data) ? data : Array.isArray(data.nodes) ? data.nodes : null;
  if (!nodes) return [];
  return normalizeCopiedItems(nodes);
}

/**
 * Diff the copied clipboard nodes against the nodes that actually pasted.
 * Matches per node TYPE (a multiset subtraction) because paste assigns fresh
 * ids, so ids can't be compared directly. Any copied node whose type wasn't
 * produced by the paste is reported as dropped (carrying its ORIGINAL id/type).
 *
 * A candidate drop is only REPORTED when its type is genuinely unregistered on
 * the target frontend (that is the sole mechanism by which paste drops a node).
 * This guards against a STALE snapshot: if the user tool-copied selection A but
 * then native-copied selection B before pasting, the snapshot no longer matches
 * the clipboard — but B's types are all registered (they just pasted), so the
 * per-type subtraction against A can only leave REGISTERED leftovers, which the
 * `isRegisteredType` filter discards instead of fabricating a false warning.
 * When no predicate is supplied every leftover is reported (used by the pure
 * multiset tests); the handler always supplies the frontend registry.
 *
 * @param {Array<{id?:any,type?:string}>} copied  clipboard snapshot
 * @param {Array<{id?:any,type?:string}>} pasted  nodes that landed on the graph
 * @param {(type:string)=>boolean} [isRegisteredType]  true if type is a known node class
 * @returns {{dropped: Array<{id:any,type:string}>, dropped_count: number, dropped_types: string[]}}
 */
export function diffCopiedVsPasted(copied, pasted, isRegisteredType) {
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
    } else if (typeof isRegisteredType === "function" && isRegisteredType(t)) {
      // Registered but absent from the paste → not a genuine drop; this is a
      // stale-snapshot artifact (a different selection was actually pasted).
      continue;
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
