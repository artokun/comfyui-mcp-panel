/**
 * panel#1268 / comfyui-mcp#1658 — a widget litegraph binds to one of its node's own
 * properties (`options.property`). Run with `node --test`.
 *
 * Both reports are the same shape: `panel_set_widget` returned success, and the OLD
 * value was back by the next read and in the render. The cause `applyWidgetWrite` had
 * was structural — it assigned `w.value` and then read `w.value` back, which is true
 * whether or not the write reached anything the node reads.
 *
 * The fixtures below are litegraph's own two code paths, transcribed from
 * ComfyUI frontend 1.48.7 (`src/lib/litegraph/src/LGraphNode.ts#setProperty` and
 * `src/lib/litegraph/src/widgets/BaseWidget.ts#setValue`) rather than invented, so a
 * test passing here is a statement about the real binding and not about a mock.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite } from "../../web/js/lib/widget-write.js";
import { boundPropertyName, boundPropertyState } from "../../web/js/lib/widget-bound-property.js";

const HOOKS = {};

/**
 * `LGraphNode.setProperty`, transcribed:
 *
 *     this.properties[name] = value
 *     if (this.onPropertyChanged?.(name, value, prev_value) === false)
 *       this.properties[name] = prev_value
 *     for (const w of this.widgets) if (w.options.property == name) { w.value = value; break }
 */
function setProperty(name, value) {
  this.properties ||= {};
  if (value === this.properties[name]) return;
  const prev = this.properties[name];
  this.properties[name] = value;
  if (this.onPropertyChanged?.(name, value, prev) === false) this.properties[name] = prev;
  // NOTE the value pushed into the bound widget: litegraph writes the REQUESTED value,
  // not `this.properties[name]`. So a node whose `onPropertyChanged` refuses the change
  // ends up with the widget showing the new value and the property holding the old one —
  // the divergence this fix exists to catch, produced by litegraph itself.
  for (const w of this.widgets ?? []) {
    if (w?.options?.property === name) {
      w.value = value;
      break;
    }
  }
}

/**
 * The reverse leg every one of these nodes runs sooner or later: litegraph copies the
 * PROPERTY into the bound widget. Any `setProperty` on the node does it; so does the
 * node's own redraw/refresh code in the packs both issues name. This is the step that
 * turned a reported success into the old value on the next read.
 */
function resyncWidgetsFromProperties(node) {
  for (const w of node.widgets ?? []) {
    const p = w?.options?.property;
    if (typeof p === "string" && node.properties?.[p] !== undefined) w.value = node.properties[p];
  }
}

/** A node with one bound widget, wired the way litegraph wires one. */
function boundNode({ property = "mode", value = "depth", propertyValue = "depth", onPropertyChanged } = {}) {
  const node = {
    id: 41,
    type: "AIO_Preprocessor",
    properties: { [property]: propertyValue },
    widgets: [{ name: "preprocessor", type: "combo", value, options: { property, values: ["depth", "pose"] } }],
    setProperty,
  };
  if (onPropertyChanged) node.onPropertyChanged = onPropertyChanged;
  return node;
}

// ---- the classifier ---------------------------------------------------------

test("boundPropertyName reads options.property and nothing else", () => {
  assert.equal(boundPropertyName({ options: { property: "mode" } }), "mode");
  assert.equal(boundPropertyName({ options: { property: "" } }), null);
  assert.equal(boundPropertyName({ options: { property: 7 } }), null);
  assert.equal(boundPropertyName({ options: {} }), null);
  assert.equal(boundPropertyName({}), null);
  assert.equal(boundPropertyName(null), null);
  // A throwing `options` accessor is reported as NO binding, so the write path is
  // left exactly as it was rather than aimed at a target that could not be read.
  assert.equal(
    boundPropertyName({
      get options() {
        throw new Error("hostile");
      },
    }),
    null,
  );
});

test("a property the node does NOT carry is not a second store", () => {
  // litegraph's own condition: BaseWidget.setValue syncs only when
  // `node.properties[p] !== undefined`. With the property absent, an on-canvas edit
  // writes nothing either, so there is nothing to keep in step.
  const node = { id: 1, properties: {}, widgets: [], setProperty };
  assert.equal(boundPropertyState(node, { options: { property: "mode" } }), null);
  assert.equal(boundPropertyState({ id: 1 }, { options: { property: "mode" } }), null);
});

test("a bound property with no setProperty is UNKNOWN, not absent", () => {
  const state = boundPropertyState({ id: 1, properties: { mode: "depth" } }, { options: { property: "mode" } });
  assert.equal(state.property, "mode");
  assert.equal(state.reachable, false);
  assert.match(state.reason, /setProperty/);
});

// ---- the write path: the CALL SITE -----------------------------------------

test("#1268: the write drives the bound property, not just the widget", () => {
  const node = boundNode();
  const set = applyWidgetWrite(node, "preprocessor", "pose", HOOKS);

  // The effect, not the request: the store the NODE reads changed.
  assert.equal(node.properties.mode, "pose");
  assert.equal(node.widgets[0].value, "pose");
  assert.deepEqual(set.bound_property, { name: "mode", previous: "depth" });
  assert.equal(set.bound_property_unverified, undefined);
});

test("#1268: the value SURVIVES the node copying its property back into the widget", () => {
  // This is the reported symptom reproduced end to end. Before the fix the widget held
  // "pose" and `properties.mode` still held "depth", so this resync — which litegraph
  // performs on any later setProperty, and which these packs' own redraw code performs —
  // put "depth" straight back while the tool had already reported success.
  const node = boundNode();
  applyWidgetWrite(node, "preprocessor", "pose", HOOKS);

  resyncWidgetsFromProperties(node);

  assert.equal(node.widgets[0].value, "pose");
});

test("#1268: a node that REFUSES the property fails the write and rolls both stores back", () => {
  const node = boundNode({ onPropertyChanged: () => false });

  assert.throws(
    () => applyWidgetWrite(node, "preprocessor", "pose", HOOKS),
    (err) => {
      assert.match(err.message, /bound to that node's own property "mode"/);
      assert.match(err.message, /wrote "pose" but it is "depth"/);
      return true;
    },
  );
  // Rolled back: neither store is left holding a value the caller was told failed.
  assert.equal(node.properties.mode, "depth");
  assert.equal(node.widgets[0].value, "depth");
});

test("#1658: a bound property that cannot be driven is reported UNKNOWN on a SUCCESS", () => {
  // The node declares the property, so `w.value` is provably not the only store — but
  // it exposes no setProperty, so neither driving it nor reading the effect back is
  // possible from here. Success with the claim narrowed, never a refusal: refusing
  // would block writes that are very likely fine.
  const node = {
    id: 2768,
    type: "AnimaRegionalCanvasInline",
    properties: { animaPrompts: "old" },
    widgets: [{ name: "red_prompt", type: "customtext", value: "old", options: { property: "animaPrompts" } }],
  };

  const set = applyWidgetWrite(node, "red_prompt", "a red car", HOOKS);

  assert.equal(set.value, "a red car");
  assert.equal(set.bound_property, undefined);
  assert.equal(set.bound_property_unverified.name, "animaPrompts");
  assert.match(set.bound_property_unverified.reason, /setProperty/);
  assert.match(set.bound_property_note, /CANNOT establish/);
  assert.match(set.bound_property_note, /panel_set_property/);
});

// ---- the opposite harm: ordinary writes must be untouched -------------------

test("a widget with no options.property is written and reported exactly as before", () => {
  const node = {
    id: 7,
    type: "KSampler",
    properties: { "Node name for S&R": "KSampler" },
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    setProperty,
  };

  const set = applyWidgetWrite(node, "steps", 30, HOOKS);

  assert.equal(set.value, 30);
  assert.equal(node.widgets[0].value, 30);
  assert.equal(set.bound_property, undefined);
  assert.equal(set.bound_property_unverified, undefined);
  assert.equal(set.bound_property_note, undefined);
  // The node's unrelated properties are not touched by a widget write.
  assert.deepEqual(node.properties, { "Node name for S&R": "KSampler" });
});

test("a bound NUMERIC widget the node normalizes still succeeds", () => {
  // #805: litegraph's own order is `value = v` → `setProperty(p, v)` → `callback`, so a
  // callback that snaps the widget leaves the property holding the REQUESTED value on
  // an on-canvas edit too. Failing that divergence would refuse a write the UI performs.
  const node = {
    id: 9,
    type: "Snapper",
    properties: { size: 512 },
    widgets: [
      {
        name: "size",
        type: "INT",
        value: 512,
        options: { property: "size", min: 1, step: 2 },
        callback() {
          node.widgets[0].value = 4097;
        },
      },
    ],
    setProperty,
  };

  const set = applyWidgetWrite(node, "size", 4096, HOOKS);

  assert.equal(set.normalized, true);
  assert.equal(set.value, 4097);
  assert.equal(node.properties.size, 4096);
  assert.deepEqual(set.bound_property, { name: "size", previous: 512 });
});

test("a bound widget whose `value` is an ACCESSOR still verifies", () => {
  // ComfyUI's DOM widgets define `value` as an accessor —
  // `set value(v) { options.setValue?.(v); callback?.(this.value) }` — so `setProperty`'s
  // copy-back runs that setter a second time. The write must still verify, and the
  // widget's own callback must not be able to turn the extra invocation into a failure.
  // Counted, because the count is the thing that changes for a BOUND widget, and it is
  // the same count `BaseWidget.setValue` produces for an on-canvas edit of one.
  let store = "old";
  let callbacks = 0;
  const widget = {
    name: "prompt",
    type: "customtext",
    options: { property: "prompt", getValue: () => store, setValue: (v) => (store = v) },
    callback() {
      callbacks += 1;
    },
    get value() {
      return this.options.getValue();
    },
    set value(v) {
      this.options.setValue(v);
      this.callback?.(this.value);
    },
  };
  const node = { id: 3, type: "DomBacked", properties: { prompt: "old" }, widgets: [widget], setProperty };

  const set = applyWidgetWrite(node, "prompt", "new", HOOKS);

  assert.equal(set.value, "new");
  assert.equal(store, "new");
  assert.equal(node.properties.prompt, "new");
  assert.deepEqual(set.bound_property, { name: "prompt", previous: "old" });
  assert.equal(callbacks, 3);
});

test("#1735: an accessor-backed BooleanWidget copy-back deletion is recovered only after both stores retain", () => {
  let stored = false;
  let setterCalls = 0;
  let callbacks = 0;
  const widget = {
    name: "resize_source",
    type: "BOOLEAN",
    options: { property: "resize_source" },
    callback() {
      callbacks += 1;
    },
  };
  // This is the descriptor shape comboBoolMigration installs: an own accessor
  // with the omitted configurable/enumerable defaults.
  Object.defineProperty(widget, "value", {
    get() {
      return stored;
    },
    set(next) {
      stored = next;
      setterCalls += 1;
      if (setterCalls === 2) {
        throw new TypeError("Cannot delete property 'value' of #<BooleanWidget>");
      }
    },
  });
  const node = {
    id: 1735,
    type: "ImageCompositeMasked",
    properties: { resize_source: false },
    widgets: [widget],
    setProperty,
  };

  const set = applyWidgetWrite(node, "resize_source", true, {});

  assert.equal(set.value, true);
  assert.equal(widget.value, true, "the accessor-backed widget retains the write");
  assert.equal(node.properties.resize_source, true, "the bound node property retains the write");
  assert.equal(callbacks, 1, "the standard callback path still runs after recovery");
  assert.equal(set.write_warning, undefined, "the verified Impact Pack setter quirk is not surfaced as a write warning");
});

test("#1735: a custom accessor that mutates then throws the same deletion error is disclosed, not recovered", () => {
  let stored = false;
  let setterCalls = 0;
  let callbacks = 0;
  class CustomBooleanWidget {
    get value() {
      return stored;
    }
    set value(next) {
      stored = next;
      setterCalls += 1;
      if (setterCalls === 2) {
        throw new TypeError("Cannot delete property 'value' of #<BooleanWidget>");
      }
    }
  }
  const widget = new CustomBooleanWidget();
  Object.assign(widget, {
    name: "resize_source",
    type: "BOOLEAN",
    options: { property: "resize_source" },
    callback() {
      callbacks += 1;
    },
  });
  const node = {
    id: 1735,
    type: "CustomBooleanNode",
    properties: { resize_source: false },
    widgets: [widget],
    setProperty,
  };

  const set = applyWidgetWrite(node, "resize_source", true, {});

  assert.equal(set.value, true, "read-back may show the mutation, but it is not clean success");
  assert.equal(widget.value, true, "the custom setter mutated before throwing");
  assert.equal(node.properties.resize_source, true, "the bound property was mutated before the throw");
  assert.equal(callbacks, 0, "the callback must not run after an unrecovered setter failure");
  assert.match(set.write_warning ?? "", /thrown while applying the write/);
  assert.match(set.write_warning ?? "", /Cannot delete property/);
});

test("#1735: an accessor-backed BooleanWidget that does not retain still fails closed", () => {
  let stored = false;
  const widget = {
    name: "resize_source",
    type: "BOOLEAN",
    options: { property: "resize_source" },
    get value() {
      return stored;
    },
    set value(next) {
      if (next === true) throw new TypeError("Cannot delete property 'value' of #<BooleanWidget>");
      stored = next;
    },
  };
  const node = {
    id: 1735,
    type: "ImageCompositeMasked",
    properties: { resize_source: false },
    widgets: [widget],
    setProperty,
  };

  assert.throws(
    () => applyWidgetWrite(node, "resize_source", true, {}),
    /did not retain|thrown while applying the write/,
  );
  assert.equal(widget.value, false, "the failed write is rolled back or remains unchanged");
  assert.equal(node.properties.resize_source, false, "the bound property is not falsely reported as changed");
});

test("an unrelated failure still rolls the bound property back", () => {
  // The widget's own callback reverts the value, so the write fails on the #240 check.
  // The property must not be left carrying the new value after that rollback.
  const node = boundNode();
  node.widgets[0].callback = () => {
    node.widgets[0].value = "depth";
  };

  assert.throws(() => applyWidgetWrite(node, "preprocessor", "pose", HOOKS), /did not retain/);
  assert.equal(node.properties.mode, "depth");
  assert.equal(node.widgets[0].value, "depth");
});
