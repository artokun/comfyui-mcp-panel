/**
 * #983 — `panel_set_widget` on rgthree's Fast Groups Bypasser reported success and the
 * value reverted moments later.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7. The read-back verification is NOT at
 * fault — when it looked, the value really was `false`; rgthree regenerates that widget
 * from live group state afterwards. The signal that separates it from composites that
 * DO persist is the node's own serialization, measured three ways on one canvas:
 *
 *   Power Lora Loader   `lora_1`                  -> IS in serialize().widgets_values
 *   Fast Groups Bypasser `RGTHREE_TOGGLE_AND_NAV` -> node serializes NO widgets_values
 *   KSampler `steps` (control)                    -> IS in serialize().widgets_values
 *
 * Both rgthree, both `type: "custom"`, both composite objects, opposite sides. Neither
 * widget type nor compositeness nor authorship separates them; serialization does.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  readSerializedWidgetValues,
  serializedWidgetValueState,
  notPersistedNote,
} from "../../web/js/lib/widget-persistence.js";

/** A node whose `serialize()` returns exactly what the real one did. */
const nodeWith = (type, widgets, serialized) => ({
  id: 1,
  type,
  widgets,
  serialize: () => serialized,
});

test("#983 the reported case: a node that serializes NO widget values is a definite absent", () => {
  // The measured Fast Groups Bypasser shape — `serialize()` has no widgets_values key.
  const node = nodeWith(
    "Fast Groups Bypasser (rgthree)",
    [{ name: "RGTHREE_TOGGLE_AND_NAV", type: "custom", value: { toggled: false } }],
    { type: "Fast Groups Bypasser (rgthree)", properties: { matchTitle: "g" } },
  );
  assert.equal(serializedWidgetValueState(node, "RGTHREE_TOGGLE_AND_NAV", { toggled: false }), "absent");
});

test("#983 the composite that WORKS is present — this must not fire on Power Lora Loader", () => {
  // Same pack, same widget type, same composite shape. The false-positive that would
  // make this change worse than the bug it fixes.
  const row = { on: true, lora: null, strength: 1, strengthTwo: null };
  const node = nodeWith(
    "Power Lora Loader (rgthree)",
    [
      { name: "divider", type: "custom", value: {} },
      { name: "PowerLoraLoaderHeaderWidget", type: "custom", value: { type: "PowerLoraLoaderHeaderWidget" } },
      { name: "lora_1", type: "custom", value: row },
      { name: "divider", type: "custom", value: {} },
    ],
    { widgets_values: [{}, { type: "PowerLoraLoaderHeaderWidget" }, row, {}, ""] },
  );
  assert.equal(serializedWidgetValueState(node, "lora_1", row), "present");
});

test("#983 the control: an ordinary scalar widget is present", () => {
  const node = nodeWith(
    "KSampler",
    [{ name: "steps", value: 33 }],
    { widgets_values: [0, "randomize", 33, 8, "euler", "simple", 1] },
  );
  assert.equal(serializedWidgetValueState(node, "steps", 33), "present");
});

test("#983 a composite is compared by CONTENT — the serialized copy is not the same reference", () => {
  const live = { on: false, strength: 0.5 };
  const node = nodeWith("N", [{ name: "lora_1", value: live }], {
    widgets_values: [{ on: false, strength: 0.5 }], // structurally equal, different object
  });
  assert.equal(serializedWidgetValueState(node, "lora_1", live), "present");
});

test("#983 a value the node serializes DIFFERENTLY is absent — the write did not reach saved state", () => {
  const node = nodeWith("N", [{ name: "steps", value: 33 }], { widgets_values: [20] });
  assert.equal(serializedWidgetValueState(node, "steps", 33), "absent");
});

test("#983 position is not required to line up — the value anywhere in the list counts", () => {
  // Widget index and serialized index do not always match; a node can skip
  // non-serializing widgets. A false "absent" on a healthy write is the expensive
  // direction, so the match is by value rather than by position.
  const node = nodeWith("N", [{ name: "a" }, { name: "b" }, { name: "steps", value: 33 }], {
    widgets_values: [33, "other"],
  });
  assert.equal(serializedWidgetValueState(node, "steps", 33), "present");
});

test("#983 an object-keyed serialization is asked for the widget by NAME", () => {
  const node = nodeWith("N", [{ name: "steps", value: 33 }], { widgets_values: { steps: 33, other: 1 } });
  assert.equal(serializedWidgetValueState(node, "steps", 33), "present");
  const stale = nodeWith("N", [{ name: "steps", value: 33 }], { widgets_values: { steps: 20 } });
  assert.equal(serializedWidgetValueState(stale, "steps", 33), "absent");
  // A name the object does not carry establishes nothing either way.
  const missing = nodeWith("N", [{ name: "steps", value: 33 }], { widgets_values: { other: 1 } });
  assert.equal(serializedWidgetValueState(missing, "steps", 33), "unknown");
});

test("#983 UNKNOWN makes no claim — an unserializable node must not turn a good write into a warning", () => {
  const throwing = { id: 1, type: "N", widgets: [{ name: "steps", value: 33 }], serialize: () => { throw new Error("boom"); } };
  assert.equal(serializedWidgetValueState(throwing, "steps", 33), "unknown");
  const noSerialize = { id: 1, type: "N", widgets: [{ name: "steps", value: 33 }] };
  assert.equal(serializedWidgetValueState(noSerialize, "steps", 33), "unknown");
  const junk = nodeWith("N", [{ name: "steps", value: 33 }], { widgets_values: "not-a-list" });
  assert.equal(serializedWidgetValueState(junk, "steps", 33), "unknown");
  assert.equal(serializedWidgetValueState(null, "steps", 33), "unknown");
});

test("#983 an empty list on a node with NO widgets is unknown, not absent", () => {
  // Nothing to serialize is not evidence that a write failed to persist.
  const node = nodeWith("N", [], { widgets_values: [] });
  assert.equal(serializedWidgetValueState(node, "steps", 33), "unknown");
});

test("#983 readSerializedWidgetValues treats a MISSING key as a real answer, not a read failure", () => {
  // The distinction the whole fix rests on: no `widgets_values` means the node saves no
  // widget state, which is knowledge — not an inability to look.
  assert.deepEqual(readSerializedWidgetValues(nodeWith("N", [], { type: "N" })), { readable: true, values: [] });
  assert.deepEqual(readSerializedWidgetValues(nodeWith("N", [], { widgets_values: null })), {
    readable: true,
    values: [],
  });
  assert.equal(readSerializedWidgetValues({ serialize: () => { throw new Error("x"); } }).readable, false);
});

test("#983 the note says what was established and offers the remedy that works", () => {
  const note = notPersistedNote("RGTHREE_TOGGLE_AND_NAV", "Fast Groups Bypasser (rgthree)");
  assert.match(note, /written and read back on the live widget/, "the read-back is not blamed — it passed honestly");
  assert.match(note, /will not survive a save, a reload, or a queue/, "what absent actually means");
  assert.match(note, /Fast Groups Bypasser \(rgthree\)/, "names the node it serialized");
  assert.match(note, /set the target nodes' mode directly/, "the reporter's verified workaround");
  assert.doesNotMatch(note, /the widget is broken|the pack is/, "asserts no cause it cannot see");
});
