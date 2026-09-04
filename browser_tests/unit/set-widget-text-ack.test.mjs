/**
 * #2233 — long CLIPTextEncode / multiline text writes applied on the live
 * canvas, but graph_set_widget did not acknowledge within 90s. query_graph
 * then showed the new values, and a short filename_prefix write succeeded.
 *
 * The assignment is the receipt. A backgrounded-tab rAF flush, a hanging
 * customtext callback, or a Vue getter that lags the live textarea must not
 * own the command reply. Fail-closed: the write still applies.
 *
 * These drive applyWidgetWrite / runSetWidget / awaitSetWidgetAck — the SAME
 * units graph_set_widget uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyWidgetWrite } from "../../web/js/lib/widget-write.js";
import {
  runSetWidget,
  awaitSetWidgetAck,
  readLiveWidgetValue,
} from "../../web/js/lib/set-widget.js";

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const SET_WIDGET_SRC = readFileSync(new URL("../../web/js/lib/set-widget.js", import.meta.url), "utf8");
const WIDGET_WRITE_SRC = readFileSync(new URL("../../web/js/lib/widget-write.js", import.meta.url), "utf8");

const NEVER = new Promise(() => {});
const HANG_MS = 250;
const REGISTRY = { CLIPTextEncode: {} };
const FRESH = { CLIPTextEncode: {} };

const LONG_POSITIVE = (
  "masterpiece, best quality, chibi icon sheet, soft rim light,\n" + "volumetric haze, ".repeat(50)
).trim();
const LONG_NEGATIVE = ("blurry, extra fingers, watermark,\n" + "lowres, extra limbs, ".repeat(40)).trim();

function withHangBudget(work) {
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`#2233 hung: text write did not ack in ${HANG_MS}ms`)), HANG_MS);
    }),
  ]);
}

function fireableTimers() {
  const timers = [];
  return {
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    fire: () => {
      assert.equal(timers.length, 1, "the acknowledgement wait must arm a timeout");
      timers[0]();
    },
  };
}

function makeClipTextEncode(initial = "old prompt") {
  const store = { value: initial };
  const textarea = {
    tagName: "TEXTAREA",
    value: initial,
    dispatched: [],
    dispatchEvent(ev) {
      this.dispatched.push(ev?.type ?? ev);
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
      const text = String(v);
      textarea.value = text;
      store.value = text;
    },
  };
  let callbackCalls = 0;
  const widget = {
    name: "text",
    type: "customtext",
    inputEl: textarea,
    element: textarea,
    options,
    callback() {
      callbackCalls += 1;
      return NEVER;
    },
    get value() {
      return options.getValue();
    },
    set value(v) {
      options.setValue(v);
      this.callback?.(this.value);
    },
  };
  const node = { id: 3, type: "CLIPTextEncode", widgets: [widget] };
  return {
    node,
    widget,
    textarea,
    store,
    callbackCalls: () => callbackCalls,
  };
}

function wired(extra = {}) {
  return {
    registry: REGISTRY,
    getRegistry: () => REGISTRY,
    getFreshObjectInfo: async () => FRESH,
    beforeChange() {},
    afterChange() {},
    setDirty() {},
    ...extra,
  };
}

test("#2233 long CLIPTextEncode text is ~800 chars (the reported write)", () => {
  assert.ok(LONG_POSITIVE.length >= 800, `positive prompt is ${LONG_POSITIVE.length} chars`);
  assert.ok(LONG_NEGATIVE.length >= 650, `negative prompt is ${LONG_NEGATIVE.length} chars`);
  assert.match(LONG_POSITIVE, /\n|,/);
});

test("#2233 applyWidgetWrite lands long customtext without awaiting the callback", async () => {
  const { node, widget, textarea, store, callbackCalls } = makeClipTextEncode();
  const set = await withHangBudget(() => applyWidgetWrite(node, "text", LONG_POSITIVE, {}));
  assert.equal(set.value, LONG_POSITIVE);
  assert.equal(store.value, LONG_POSITIVE);
  assert.equal(textarea.value, LONG_POSITIVE);
  assert.equal(widget.value, LONG_POSITIVE);
  assert.equal(callbackCalls(), 0, "a live customtext must not re-enter a hanging callback");
});

test("#2233 runSetWidget acks a long text write while rAF never fires", async () => {
  const { node, textarea, store } = makeClipTextEncode();
  const res = await withHangBudget(() =>
    runSetWidget(node, "text", LONG_POSITIVE, {
      ...wired(),
      awaitFrontendWidgetFlush: () => NEVER,
    }),
  );
  assert.equal(res.applied, true);
  assert.equal(res.set.value, LONG_POSITIVE);
  assert.equal(store.value, LONG_POSITIVE);
  assert.equal(textarea.value, LONG_POSITIVE);
  assert.equal(res.error, undefined);
});

test("#2233 a second long negative-prompt write also acks (the reporter's pair)", async () => {
  const first = makeClipTextEncode();
  const second = makeClipTextEncode("old negative");
  second.node.id = 4;
  const flushNever = () => NEVER;
  const a = await withHangBudget(() =>
    runSetWidget(first.node, "text", LONG_POSITIVE, { ...wired(), awaitFrontendWidgetFlush: flushNever }),
  );
  const b = await withHangBudget(() =>
    runSetWidget(second.node, "text", LONG_NEGATIVE, { ...wired(), awaitFrontendWidgetFlush: flushNever }),
  );
  assert.equal(a.applied, true);
  assert.equal(b.applied, true);
  assert.equal(first.textarea.value, LONG_POSITIVE);
  assert.equal(second.textarea.value, LONG_NEGATIVE);
});

test("#2233 fail-closed: a hanging flush must not skip the write", async () => {
  const { node, textarea } = makeClipTextEncode();
  await withHangBudget(() =>
    runSetWidget(node, "text", LONG_POSITIVE, {
      ...wired(),
      awaitFrontendWidgetFlush: () => NEVER,
    }),
  );
  assert.equal(textarea.value, LONG_POSITIVE, "the mutation must land even if the canvas flush never settles");
});

test("#2233 timeout readback: a live textarea is applied even when .value lags", async () => {
  const { node, widget, textarea, store } = makeClipTextEncode();
  store.value = "old prompt";
  textarea.value = LONG_POSITIVE;
  Object.defineProperty(widget, "value", {
    configurable: true,
    get: () => store.value,
    set(v) {
      store.value = v;
    },
  });
  const live = readLiveWidgetValue(node, "text");
  assert.equal(live.found, true);
  const clock = fireableTimers();
  const pending = awaitSetWidgetAck(NEVER, {
    node,
    widget: "text",
    requested: LONG_POSITIVE,
    timeoutMs: 80,
    delivered: true,
    timers: { setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  });
  clock.fire();
  const out = await withHangBudget(() => pending);
  assert.equal(out.applied, true, "a committed editor is not outcome-unknown");
  assert.equal(out.verified, true);
  assert.equal(out.set.value, LONG_POSITIVE);
});

test("#2233 a short filename_prefix write is unchanged when nothing hangs", async () => {
  const widget = { name: "filename_prefix", type: "text", value: "ComfyUI" };
  const node = { id: 9, type: "SaveImage", widgets: [widget] };
  const res = await runSetWidget(node, "filename_prefix", "chibi_icon", {
    registry: { SaveImage: {} },
    getFreshObjectInfo: async () => ({ SaveImage: {} }),
  });
  assert.equal(res.applied, true);
  assert.equal(widget.value, "chibi_icon");
});

test("#2233 wiring: live editor hold is the receipt, ahead of the rAF flush", () => {
  const handlerStart = PANEL_SRC.indexOf("async graph_set_widget({");
  const handlerEnd = PANEL_SRC.indexOf("\n  // artokun/comfyui-mcp#938", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "graph_set_widget handler not found");
  const handler = PANEL_SRC.slice(handlerStart, handlerEnd);
  assert.match(handler, /await runSetWidget\(node, widget, value, setWidgetOpts\)/);
  assert.match(WIDGET_WRITE_SRC, /export function liveTextEditorHolds/);
  assert.match(SET_WIDGET_SRC, /liveTextEditorHolds/);
  const holdAt = SET_WIDGET_SRC.indexOf("liveTextEditorHolds(");
  const flushAt = SET_WIDGET_SRC.indexOf("await flushFrontendWidgets()");
  assert.ok(holdAt >= 0 && flushAt > holdAt, "the live editor receipt must be taken before waiting on rAF");
});
