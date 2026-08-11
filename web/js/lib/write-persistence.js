/**
 * #983 — `panel_set_widget` reported success while the rgthree Fast Groups Bypasser toggle
 * stayed as it was. Read-back verification is NOT at fault: at the moment it checked, the
 * value really was what had been written. It simply did not survive.
 *
 * MEASURED on the reported canvas, three nodes, all rgthree or core, all composite:
 *
 *   Power Lora Loader · lora_1                 value present in node.serialize()
 *   Fast Groups Bypasser · RGTHREE_TOGGLE…     NO widgets_values key at all
 *   KSampler · steps                           new value present
 *
 * so the working composite persists and the broken one persists nothing.
 *
 * WHY THIS DOES NOT LOOK FOR THE VALUE. The previous attempt searched the serialized form
 * for what had been written, and review took it apart on four counts: a custom widget can
 * persist through `properties` rather than `widgets_values`; a serializer may TRANSFORM the
 * value (a combo to an index, a normalized number) so absence proves nothing; matching
 * anywhere in an array creates the complementary false negative; and an empty
 * `widgets_values` says only that this serializer emitted no positional values.
 *
 * Asking whether the node's serialized form CHANGED answers all four. A transformed value
 * still changes it. A value that lands in `properties` still changes it. Nothing is
 * matched, so nothing can be matched wrongly. And the question is the one that matters:
 * will this write survive a save or a queue, both of which serialize.
 *
 * COST, measured rather than argued — the previous attempt also drew a cost objection for
 * calling a plugin-overridable `serialize()` on the write path (#716). On a 24-node canvas
 * of the reporter's kind: a single node serializes in ≤0.1 ms, every node together in
 * 0.4 ms. Two per-node captures per write is ~0.1–0.2 ms, against a write path that
 * already awaits an /object_info oracle measured at 818 ms cold.
 *
 * DISCLOSURE, NEVER REFUSAL, which the issue settled: a non-persisting write can still have
 * run the widget's callback and done something real, so refusing would break legitimate
 * side-effect writes.
 */

/**
 * A comparable snapshot of everything a node serializes, or null when it cannot be taken.
 *
 * Null is not "unchanged" — every caller must treat it as "no comparison happened", because
 * a snapshot that failed says nothing about persistence and a claim built on it would be
 * invented.
 */
export function captureSerializedNode(node) {
  try {
    if (!node || typeof node.serialize !== "function") return null;
    const serialized = node.serialize();
    if (serialized == null || typeof serialized !== "object") return null;
    return JSON.stringify(serialized);
  } catch {
    // A plugin serializer that throws is a node this check cannot speak about.
    return null;
  }
}

/**
 * Did the write leave NO trace in what this node serializes?
 *
 * Returns `true` only when both snapshots were taken and they are identical. Anything
 * else — either capture missing, any difference at all — is `false`, because the only
 * claim worth making here is a positive one about a write that vanished.
 *
 * NOTE THE DIRECTION OF THE FAILURE MODES. A serializer that emits something volatile (a
 * timestamp, a fresh id) makes every comparison differ, so this stays silent for that node:
 * useless there, but never wrong. The opposite error — reporting "unchanged" for a write
 * that did persist — would need a serializer that omits its own change, which is the very
 * condition being reported.
 */
export function writeLeftNoSerializedTrace(before, after) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  return before === after;
}

/**
 * What the reply says when a write verified by read-back but changed nothing the node
 * serializes.
 *
 * Every clause is an observation. It does NOT say the write did nothing — the widget's
 * callback may have run and had a real effect — and it does not name a cause, because the
 * panel observed a serialized form, not a mechanism.
 */
export function nonPersistingWriteNote({ nodeId, nodeType, widget } = {}) {
  const where = `node ${nodeId ?? "(unknown)"}${nodeType ? ` ("${nodeType}")` : ""}`;
  return (
    `The widget now reads back as the value that was written, but NOTHING this node ` +
    `serializes changed: ${where}'s serialized form is byte-identical before and after the ` +
    `write${widget ? ` to "${widget}"` : ""}. A save or a queued prompt is built from that ` +
    `serialized form, so this value will not appear in either — the read-back is the live ` +
    `widget object, which for some custom widgets is a VIEW that persists nothing. ` +
    `That is an observation about persistence, not about effect: the widget's callback may ` +
    `still have run and done something real, which is why this is reported rather than ` +
    `refused. If the value needs to survive, drive the underlying state instead — for a ` +
    `control surface over other nodes, set those nodes directly (#983).`
  );
}
