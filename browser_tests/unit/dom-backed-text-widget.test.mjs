/**
 * #1997 — panel_set_widget on a live StringMultilineTagEditor `text` widget
 * assigned `.value` and then observed a revert, because the pack's
 * `options.setValue` is a no-op after onConfigure and `getValue` reads the
 * contenteditable. The write must reach that live editor (and fire `input`,
 * which is how the pack copies the text into state / localStorage).
 *
 * These drive applyWidgetWrite(), the SAME function graph_set_widget uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite, WidgetWriteError } from "../../web/js/lib/widget-write.js";

const HOOKS = {};

function makeContentEditable(initial) {
  return {
    tagName: "DIV",
    contentEditable: "true",
    isContentEditable: true,
    className: "comfy-multiline-input",
    textContent: initial,
    dispatched: [],
    dispatchEvent(ev) {
      this.dispatched.push(ev?.type ?? ev);
      return true;
    },
  };
}

/** TTS-Audio-Suite StringMultilineTagEditor after onConfigure has run. */
function makeTagEditorWidget({ initial = "old script", setValueNoop = true } = {}) {
  const editor = makeContentEditable(initial);
  const options = {
    getValue() {
      return editor.textContent;
    },
    setValue(v) {
      if (setValueNoop) return;
      editor.textContent = String(v);
    },
  };
  const widget = {
    name: "text",
    type: "customtext",
    inputEl: editor,
    element: {
      querySelector(sel) {
        return /comfy-multiline-input|contenteditable/.test(String(sel)) ? editor : null;
      },
    },
    options,
    get value() {
      return options.getValue();
    },
    set value(v) {
      options.setValue(v);
    },
  };
  return { widget, editor };
}

test("#1997: StringMultilineTagEditor text sticks after setValue becomes a no-op", () => {
  const { widget, editor } = makeTagEditorWidget({ initial: "old script" });
  const node = { id: 143, type: "StringMultilineTagEditor", widgets: [widget] };

  const set = applyWidgetWrite(node, "text", "[de:Alice] Hallo", HOOKS);

  assert.equal(set.value, "[de:Alice] Hallo");
  assert.equal(editor.textContent, "[de:Alice] Hallo");
  assert.equal(widget.value, "[de:Alice] Hallo");
  assert.ok(editor.dispatched.includes("input"), "the pack's input listener must run so state/localStorage update");
});

test("#1997: clearing StringMultilineTagEditor text to '' writes the live editor", () => {
  const { widget, editor } = makeTagEditorWidget({ initial: "old script" });
  const node = { id: 143, type: "StringMultilineTagEditor", widgets: [widget] };

  const set = applyWidgetWrite(node, "text", "", HOOKS);

  assert.equal(set.value, "");
  assert.equal(editor.textContent, "");
  assert.equal(widget.value, "");
});

test("#1997: a textarea-backed customtext widget updates when setValue no-ops", () => {
  const textarea = {
    tagName: "TEXTAREA",
    value: "old",
    dispatched: [],
    dispatchEvent(ev) {
      this.dispatched.push(ev?.type ?? ev);
      return true;
    },
  };
  const options = {
    getValue() {
      return textarea.value;
    },
    setValue() {},
  };
  const widget = {
    name: "text",
    type: "customtext",
    inputEl: textarea,
    options,
    get value() {
      return options.getValue();
    },
    set value(v) {
      options.setValue(v);
    },
  };
  const node = { id: 7, type: "CustomMultiline", widgets: [widget] };

  const set = applyWidgetWrite(node, "text", "new copy", HOOKS);

  assert.equal(set.value, "new copy");
  assert.equal(textarea.value, "new copy");
  assert.ok(textarea.dispatched.includes("input"));
});

test("#1997: a nested contenteditable under widget.element is found when inputEl is absent", () => {
  const editor = makeContentEditable("old");
  const options = {
    getValue() {
      return editor.textContent;
    },
    setValue() {},
  };
  const widget = {
    name: "text",
    type: "customtext",
    element: {
      querySelector(sel) {
        return String(sel).includes("contenteditable") ? editor : null;
      },
    },
    options,
    get value() {
      return options.getValue();
    },
    set value(v) {
      options.setValue(v);
    },
  };
  const node = { id: 8, type: "StringMultilineTagEditor", widgets: [widget] };

  const set = applyWidgetWrite(node, "text", "from element", HOOKS);
  assert.equal(set.value, "from element");
  assert.equal(editor.textContent, "from element");
});

test("#1997: a nested textarea under widget.element is found when inputEl is absent", () => {
  const textarea = { tagName: "TEXTAREA", value: "old", dispatchEvent() { return true; } };
  const options = {
    getValue() {
      return textarea.value;
    },
    setValue() {},
  };
  const widget = {
    name: "text",
    type: "customtext",
    element: {
      querySelector(sel) {
        return String(sel).includes("textarea") ? textarea : null;
      },
    },
    options,
    get value() {
      return options.getValue();
    },
    set value(v) {
      options.setValue(v);
    },
  };
  const node = { id: 8, type: "NestedTextEditor", widgets: [widget] };

  const set = applyWidgetWrite(node, "text", "from element", HOOKS);
  assert.equal(set.value, "from element");
  assert.equal(textarea.value, "from element");
});

test("#1997: a DOM widget whose setValue already sticks is not refused", () => {
  const textarea = { tagName: "TEXTAREA", value: "old", dispatchEvent() { return true; } };
  let setValueCalls = 0;
  const options = {
    getValue() {
      return textarea.value;
    },
    setValue(v) {
      setValueCalls += 1;
      textarea.value = String(v);
    },
  };
  const widget = {
    name: "text",
    type: "customtext",
    inputEl: textarea,
    options,
    get value() {
      return options.getValue();
    },
    set value(v) {
      options.setValue(v);
    },
  };
  const node = { id: 9, type: "HealthyDomText", widgets: [widget] };

  const set = applyWidgetWrite(node, "text", "already works", HOOKS);
  assert.equal(set.value, "already works");
  assert.equal(textarea.value, "already works");
  assert.ok(setValueCalls >= 1);
});

test("#1997: a failed write rolls the contenteditable back to the previous text", () => {
  const { widget, editor } = makeTagEditorWidget({ initial: "old script" });
  widget.options.property = "bound";
  const node = {
    id: 143,
    type: "StringMultilineTagEditor",
    widgets: [widget],
    properties: { bound: "old script" },
    setProperty() {
      /* leave properties.bound unchanged so verification fails closed */
    },
  };

  assert.throws(
    () => applyWidgetWrite(node, "text", "new script", HOOKS),
    (err) => err instanceof WidgetWriteError && /bound/.test(err.message),
  );
  assert.equal(editor.textContent, "old script", "rollback must restore the live editor, not only .value");
  assert.equal(widget.value, "old script");
});

test("#1997: a non-text-bearing DOM widget is still a diagnosis, not a guessed write", () => {
  const widget = {
    name: "pix_prompt_ui",
    element: {},
    options: {
      getValue: () => null,
      setValue() {},
    },
    get value() {
      return this.options.getValue();
    },
    set value(v) {
      this.options.setValue(v);
    },
  };
  const node = {
    id: 44,
    type: "PixaromaPrompt",
    widgets: [widget],
    properties: { promptState: { text: "" }, mode: "a" },
  };

  assert.throws(
    () => applyWidgetWrite(node, "pix_prompt_ui", "hello", HOOKS),
    (err) =>
      err instanceof WidgetWriteError &&
      /did not retain/.test(err.message) &&
      /DOM-backed display widget/.test(err.message) &&
      /panel_set_property/.test(err.message),
  );
  assert.equal(widget.value, null);
});

test("#1997: a plain string widget without a DOM editor is unchanged", () => {
  const widget = { name: "text", type: "customtext", value: "keep me" };
  const node = { id: 1, type: "CLIPTextEncode", widgets: [widget] };
  const set = applyWidgetWrite(node, "text", "plain write", HOOKS);
  assert.equal(set.value, "plain write");
  assert.equal(widget.value, "plain write");
});
