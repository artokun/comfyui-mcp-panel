/**
 * #983 — `panel_set_widget` reported success while the rgthree Fast Groups Bypasser toggle
 * stayed as it was. Read-back verification is not at fault: at the moment it checked, the
 * value really was what had been written. It simply did not survive.
 *
 * MEASURED on the reported canvas — Power Lora Loader persists its composite value,
 * Fast Groups Bypasser emits no `widgets_values` key at all, KSampler persists a plain
 * one — so the distinguishing question is what the node SERIALIZES.
 *
 * THE PREVIOUS ATTEMPT SEARCHED THE SERIALIZED FORM FOR THE VALUE, and review reverted it
 * on four counts, which are the spec this is built to:
 *
 *   1. a custom widget can persist through `properties`, not just `widgets_values`;
 *   2. a serializer may TRANSFORM the value, so absence proves nothing;
 *   3. matching anywhere in an array creates the complementary false negative;
 *   4. an empty `widgets_values` proves only that no positional values were emitted.
 *
 * Comparing the whole serialized form BEFORE and AFTER answers all four: a transformed
 * value still changes it, a value in `properties` still changes it, and nothing is matched.
 *
 * COST, measured rather than argued, on a 24-node canvas of the reporter's kind: one node
 * serializes in ≤0.1 ms and all 24 in 0.4 ms, against a write path that already awaits an
 * /object_info oracle measured at 818 ms cold.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  captureSerializedNode,
  writeLeftNoSerializedTrace,
  nonPersistingWriteNote,
} from "../../web/js/lib/write-persistence.js";

/** A node whose serialize() reflects a mutable field — the ordinary case. */
const persistingNode = () => {
  const state = { widgets_values: ["a"] };
  return {
    id: 7,
    type: "KSampler",
    state,
    serialize: () => ({ id: 7, type: "KSampler", widgets_values: [...state.widgets_values] }),
  };
};

/** A node whose serialize() ignores the widget entirely — the reported case. */
const viewOnlyNode = () => ({
  id: 9,
  type: "Fast Groups Bypasser (rgthree)",
  serialize: () => ({ id: 9, type: "Fast Groups Bypasser (rgthree)", properties: {} }),
});

test("#983 a write the node does not serialize leaves an identical form", () => {
  const node = viewOnlyNode();
  const before = captureSerializedNode(node);
  // …the write happens, and the live widget reads back correctly…
  const after = captureSerializedNode(node);
  assert.equal(writeLeftNoSerializedTrace(before, after), true, "nothing it serializes changed");
});

test("#983 a write that DOES persist is never reported", () => {
  const node = persistingNode();
  const before = captureSerializedNode(node);
  node.state.widgets_values[0] = "b";
  const after = captureSerializedNode(node);
  assert.equal(writeLeftNoSerializedTrace(before, after), false);
});

test("#983 (spec 1) a value that persists through PROPERTIES is not reported", () => {
  // The previous attempt read only `widgets_values` and would have called this a
  // non-persisting write. Comparing the whole form sees it.
  const props = { toggled: false };
  const node = { id: 1, type: "Custom", serialize: () => ({ id: 1, type: "Custom", properties: { ...props } }) };
  const before = captureSerializedNode(node);
  props.toggled = true;
  assert.equal(writeLeftNoSerializedTrace(before, captureSerializedNode(node)), false);
});

test("#983 (spec 2) a TRANSFORMING serializer is not reported", () => {
  // A combo written as a label may serialize as an index; a number may be normalized. The
  // value never appears verbatim, and a search for it would call this non-persisting.
  let label = "euler";
  const options = ["euler", "dpmpp_2m"];
  const node = { id: 2, type: "KSampler", serialize: () => ({ id: 2, widgets_values: [options.indexOf(label)] }) };
  const before = captureSerializedNode(node);
  label = "dpmpp_2m";
  assert.equal(writeLeftNoSerializedTrace(before, captureSerializedNode(node)), false, "the FORM changed");
});

test("#983 (spec 3) another widget holding the same value cannot mask the finding", () => {
  // Array-wide matching reported "present" when any element equalled the written value.
  // Nothing is matched here, so a neighbouring widget with the same value is irrelevant.
  const node = { id: 3, type: "Custom", serialize: () => ({ id: 3, widgets_values: [true, true] }) };
  const before = captureSerializedNode(node);
  assert.equal(writeLeftNoSerializedTrace(before, captureSerializedNode(node)), true);
});

test("#983 (spec 4) an EMPTY widgets_values is not itself the finding", () => {
  // It proves only that no positional values were emitted. What decides is whether the
  // form changed — so a node that emits `[]` both times AND changes something else is fine.
  const props = { n: 0 };
  const node = { id: 4, type: "Custom", serialize: () => ({ id: 4, widgets_values: [], properties: { ...props } }) };
  const before = captureSerializedNode(node);
  props.n = 1;
  assert.equal(writeLeftNoSerializedTrace(before, captureSerializedNode(node)), false);
});

test("#983 an unreadable node makes NO claim — a missing capture is not 'unchanged'", () => {
  const throwing = {
    serialize() {
      throw new Error("plugin serializer boom");
    },
  };
  assert.equal(captureSerializedNode(throwing), null);
  assert.equal(captureSerializedNode(null), null);
  assert.equal(captureSerializedNode({}), null, "no serialize method");
  assert.equal(captureSerializedNode({ serialize: () => null }), null);
  assert.equal(captureSerializedNode({ serialize: () => "not an object" }), null);
  // …and a null on either side can never produce the positive claim.
  assert.equal(writeLeftNoSerializedTrace(null, "x"), false);
  assert.equal(writeLeftNoSerializedTrace("x", null), false);
  assert.equal(writeLeftNoSerializedTrace(null, null), false);
  assert.equal(writeLeftNoSerializedTrace(undefined, undefined), false);
});

test("#983 the note reports persistence, and explicitly not effect", () => {
  const note = nonPersistingWriteNote({ nodeId: 9, nodeType: "Fast Groups Bypasser (rgthree)", widget: "toggle" });
  assert.match(note, /reads back as the value that was written/, "read-back is not blamed");
  assert.match(note, /NOTHING this node serializes changed/);
  assert.match(note, /node 9 \("Fast Groups Bypasser \(rgthree\)"\)/, "names where");
  assert.match(note, /"toggle"/, "and which widget");
  assert.match(note, /save or a queued prompt is built from that serialized form/, "why it matters");
  // The issue settled that this is a disclosure, not a refusal: the callback may have run.
  assert.match(note, /callback may still have run and done something real/);
  assert.match(note, /reported rather than refused/);
  assert.match(note, /set those nodes directly/, "the reporter's own working remedy");
});

test("#983 source guard: disclosure, never refusal, and a field of its own", () => {
  const src = readFileSync(new URL("../../web/js/lib/set-widget.js", import.meta.url), "utf8");
  assert.match(src, /const before = captureSerializedNode\(probeNode\);/, "captured BEFORE the write");
  assert.match(src, /after: captureSerializedNode\(probeNode\),/, "and after");
  assert.match(src, /persisted: false, persistence_warning: nonPersistingWriteNote\(p\)/, "reported");
  // A separate field: a control_after_generate advisory and a persistence disclosure are
  // different facts and neither may displace the other.
  assert.match(src, /const withPersistence = \(result\) => \{/);
  assert.ok(!/throw new Error\(nonPersistingWriteNote/.test(src), "never a refusal");
  // EVERY success path goes through it — asserted as "no bare one is left" rather than by
  // counting, so adding a fifth success path fails here instead of quietly skipping the
  // disclosure. (The count is also pinned, to catch a call site being deleted.)
  assert.ok(!/return withWarning\(/.test(src), "no success path returns without the persistence check");
  assert.equal((src.match(/withPersistence\(/g) ?? []).length, 4, "its four call sites");
});
