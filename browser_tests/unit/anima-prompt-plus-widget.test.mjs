/**
 * #2020 — panel_set_widget on AnimaPromptPlus `quality_prompt` (and other
 * customtext textareas) stalled indefinitely. ComfyUI's DOM widget setter is
 * `set value(v) { options.setValue?.(v); callback?.(this.value) }`, and the
 * write path then invoked the 5-arg callback again. Those callbacks can fail
 * to settle; the RPC stayed in-flight until the client timed out and the
 * canvas never changed.
 *
 * The shipped write must:
 *   - land the string on the live textarea / getValue store
 *   - not invoke (and therefore not await) a non-resolving widget.callback
 *   - settle well inside the client timeout
 *
 * These drive applyWidgetWrite() / runSetWidget(), the SAME functions
 * graph_set_widget uses — not a parallel reimplementation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite } from "../../web/js/lib/widget-write.js";
import { runSetWidget } from "../../web/js/lib/set-widget.js";

const HOOKS = {};
const NEW_PROMPT = "masterpiece, best quality, score_7, safe";
const HANG_MS = 200;

function neverSettles() {
  return new Promise(() => {});
}

function withHangBudget(work) {
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`#2020 hung: write did not settle in ${HANG_MS}ms`)), HANG_MS);
    }),
  ]);
}

/** AnimaPromptPlus.quality_prompt after ComfyUI addDOMWidget + bindMultilineTextareaWidget. */
function makeAnimaQualityPrompt(initial = "") {
  const store = { value: initial };
  const textarea = {
    tagName: "TEXTAREA",
    value: initial,
    dispatched: [],
    dispatchEvent(ev) {
      this.dispatched.push(ev?.type ?? ev);
      // ComfyUI bindMultilineTextareaWidget: input assigns widget.value,
      // which re-enters the setter and the callback.
      widget.value = this.value;
      widget.callback?.(widget.value);
      return true;
    },
  };
  const options = {
    getValue() {
      return store.value ?? textarea.value;
    },
    setValue(v) {
      textarea.value = String(v);
      store.value = String(v);
    },
  };
  let callbackCalls = 0;
  const widget = {
    name: "quality_prompt",
    type: "customtext",
    inputEl: textarea,
    element: textarea,
    options,
    callback() {
      callbackCalls += 1;
      return neverSettles();
    },
    get value() {
      return options.getValue();
    },
    set value(v) {
      options.setValue(v);
      this.callback?.(this.value);
    },
  };
  const node = { id: 181, type: "AnimaPromptPlus", widgets: [widget] };
  return {
    node,
    widget,
    textarea,
    store,
    callbackCalls: () => callbackCalls,
  };
}

test("#2020: AnimaPromptPlus quality_prompt lands without invoking a never-settling callback", async () => {
  const { node, widget, textarea, store, callbackCalls } = makeAnimaQualityPrompt("old");

  const set = await withHangBudget(() => applyWidgetWrite(node, "quality_prompt", NEW_PROMPT, HOOKS));

  assert.equal(set.value, NEW_PROMPT);
  assert.equal(set.widget, "quality_prompt");
  assert.equal(store.value, NEW_PROMPT);
  assert.equal(textarea.value, NEW_PROMPT);
  assert.equal(widget.value, NEW_PROMPT);
  assert.equal(callbackCalls(), 0, "must not invoke the unacked customtext callback");
  assert.equal(textarea.dispatched.length, 0, "input would re-enter the hanging callback via widget.value");
});

test("#2020: a second isolated quality_prompt write also settles (the reporter's retry)", async () => {
  const { node, textarea, callbackCalls } = makeAnimaQualityPrompt("old");

  const first = await withHangBudget(() => applyWidgetWrite(node, "quality_prompt", NEW_PROMPT, HOOKS));
  const second = await withHangBudget(() =>
    applyWidgetWrite(node, "quality_prompt", "1girl, long hair", HOOKS),
  );

  assert.equal(first.value, NEW_PROMPT);
  assert.equal(second.value, "1girl, long hair");
  assert.equal(textarea.value, "1girl, long hair");
  assert.equal(callbackCalls(), 0);
});

test("#2020: a thenable customtext callback on a plain widget is not awaited", async () => {
  const widget = {
    name: "quality_prompt",
    type: "customtext",
    value: "old",
    callback() {
      return neverSettles();
    },
  };
  const node = { id: 181, type: "AnimaPromptPlus", widgets: [widget] };

  const set = await withHangBudget(() => applyWidgetWrite(node, "quality_prompt", NEW_PROMPT, HOOKS));

  assert.equal(set.value, NEW_PROMPT);
  assert.equal(widget.value, NEW_PROMPT);
});

test("#2020: runSetWidget on AnimaPromptPlus quality_prompt does not hang the RPC", async () => {
  const { node, textarea, store, callbackCalls } = makeAnimaQualityPrompt("old");
  const registry = { AnimaPromptPlus: {} };

  const res = await withHangBudget(() =>
    runSetWidget(node, "quality_prompt", NEW_PROMPT, {
      registry,
      getFreshObjectInfo: async () => ({ AnimaPromptPlus: {} }),
    }),
  );

  assert.equal(res.set.value, NEW_PROMPT);
  assert.equal(res.set.previous, "old");
  assert.equal(store.value, NEW_PROMPT);
  assert.equal(textarea.value, NEW_PROMPT);
  assert.equal(callbackCalls(), 0);
  assert.equal(res.applied, true);
});

test("#2020: a plain customtext without a DOM editor still fires its callback", () => {
  let calls = 0;
  const widget = {
    name: "text",
    type: "customtext",
    value: "keep me",
    callback() {
      calls += 1;
    },
  };
  const node = { id: 1, type: "CLIPTextEncode", widgets: [widget] };

  const set = applyWidgetWrite(node, "text", "plain write", HOOKS);

  assert.equal(set.value, "plain write");
  assert.equal(widget.value, "plain write");
  assert.equal(calls, 1, "core string widgets keep the 5-arg callback");
});
