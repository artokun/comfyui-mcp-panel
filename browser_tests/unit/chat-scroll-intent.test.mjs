import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createChatScrollIntentTracker,
  isUserScrollIntent,
  updateChatStickiness,
} from "../../web/js/lib/chat-scroll-intent.js";

const panelSource = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const listenerStart = panelSource.indexOf("  const scrollIntent = createChatScrollIntentTracker();");
const listenerEnd = panelSource.indexOf("  const chatScrollStabilizer =", listenerStart);
assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, "production chat scroll listener block not found");
const productionListener = panelSource.slice(listenerStart, listenerEnd);

class ChatLog extends EventTarget {
  constructor() {
    super();
    this.listeners = new Map();
  }

  scrollHeight = 1000;
  scrollTop = 400;
  clientHeight = 100;

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }

  dispatchEvent(event) {
    return this.dispatchEventFrom(this, event);
  }

  dispatchEventFrom(target, event) {
    const delivered = { ...event, target, currentTarget: this };
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(delivered);
    return true;
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.length, 0);
  }
}

function emit(log, type, props = {}, target = log) {
  log.dispatchEventFrom(target, { type, ...props });
}

function buildProductionScrollSurface() {
  const log = new ChatLog();
  const newMsgBtn = { hidden: true };
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight <= 48;
  const build = new Function(
    "log",
    "newMsgBtn",
    "atBottom",
    "createChatScrollIntentTracker",
    "updateChatStickiness",
    `let stickToBottom = true;\n${productionListener}\nreturn {\n  log,\n  newMsgBtn,\n  scrollIntent,\n  disposeChatScrollListeners,\n  get stickToBottom() { return stickToBottom; },\n};`,
  );
  return build(log, newMsgBtn, atBottom, createChatScrollIntentTracker, updateChatStickiness);
}

test("programmatic and anchoring scroll events do not count as user intent", () => {
  const tracker = createChatScrollIntentTracker();

  tracker.note({ type: "scroll" });
  tracker.note({ type: "resize" });
  assert.equal(tracker.consume(), false);
  assert.equal(isUserScrollIntent({ type: "scroll" }), false);
  assert.equal(isUserScrollIntent({ type: "keydown", key: "a" }), false);
});

test("programmatic scroll cancellation preserves the real marker for the following user scroll", () => {
  const tracker = createChatScrollIntentTracker();
  tracker.note({ type: "pointerdown" });
  tracker.noteProgrammaticScroll();
  assert.equal(tracker.consume(), false);
  assert.equal(tracker.consume(), true);

  tracker.note({ type: "wheel" });
  tracker.noteProgrammaticScroll({ behavior: "smooth" });
  tracker.noteProgrammaticScroll();
  assert.equal(tracker.consume(), false);
  tracker.endProgrammaticScroll();
  assert.equal(tracker.consume(), true);
  tracker.dispose();
});

test("production wiring preserves a root marker across multiple app writes before scroll delivery", () => {
  const surface = buildProductionScrollSurface();

  emit(surface.log, "pointerdown");
  // These are the two production callers' writes before the browser delivers
  // either scroll event (for example, reveal/anchoring corrections in one turn).
  surface.scrollIntent.noteProgrammaticScroll();
  surface.log.scrollTop = 350;
  surface.scrollIntent.noteProgrammaticScroll();
  surface.log.scrollTop = 300;
  emit(surface.log, "scroll");
  assert.equal(surface.stickToBottom, true, "the first app write must not spend the marker");
  emit(surface.log, "scroll");
  assert.equal(surface.stickToBottom, true, "the second app write must not spend the marker");

  surface.log.scrollTop = 250;
  emit(surface.log, "wheel");
  emit(surface.log, "scroll");
  assert.equal(surface.stickToBottom, false, "the following root user scroll must still unstick");
  surface.disposeChatScrollListeners();
  surface.scrollIntent.dispose();
});

test("wheel, touch, pointer, and vertical keyboard scrolling preserve user intent", () => {
  for (const event of [
    { type: "wheel" },
    { type: "touchmove" },
    { type: "pointerdown" },
    { type: "keydown", key: "ArrowUp" },
    { type: "keydown", key: "PageDown" },
    { type: "keydown", key: "End" },
  ]) {
    const tracker = createChatScrollIntentTracker();
    tracker.note(event);
    assert.equal(tracker.consume(), true, `${event.type}/${event.key ?? ""} is user intent`);
    assert.equal(tracker.consume(), false, "one user action is consumed by one scroll event");
  }
});

test("non-bottom browser scrolls preserve stickiness, while user scrolls unstick", () => {
  assert.equal(
    updateChatStickiness(true, { atBottom: false, userScrollIntent: false }),
    true,
    "anchoring must not disable autoscroll",
  );
  assert.equal(
    updateChatStickiness(true, { atBottom: false, userScrollIntent: true }),
    false,
    "intentional user scrolling must disable autoscroll",
  );
  assert.equal(
    updateChatStickiness(false, { atBottom: false, userScrollIntent: false }),
    false,
    "an already detached reader remains detached",
  );
  assert.equal(
    updateChatStickiness(false, { atBottom: true, userScrollIntent: false }),
    true,
    "reaching the bottom always re-sticks",
  );
});

test("production DOM wiring expires input that never scrolls before a later browser scroll", async () => {
  const surfaces = [
    [{ type: "pointerdown" }],
    [{ type: "wheel" }],
    [{ type: "touchmove" }],
    [{ type: "keydown", key: "PageDown" }],
  ].map(([event]) => {
    const surface = buildProductionScrollSurface();
    emit(surface.log, event.type, event);
    return surface;
  });

  await new Promise((resolve) => setTimeout(resolve, 120));
  for (const surface of surfaces) {
    surface.log.scrollTop = 300;
    emit(surface.log, "scroll");
    assert.equal(surface.stickToBottom, true, "an unrelated later scroll must not unstick the feed");
    surface.disposeChatScrollListeners();
    surface.scrollIntent.dispose();
  }
});

test("production DOM wiring skips an app scroll, preserves the marker, and re-sticks at bottom", () => {
  const surface = buildProductionScrollSurface();

  emit(surface.log, "pointerdown");
  surface.scrollIntent.noteProgrammaticScroll();
  surface.log.scrollTop = 350;
  emit(surface.log, "scroll");
  assert.equal(surface.stickToBottom, true, "the app scroll must not spend the user marker");

  surface.log.scrollTop = 250;
  emit(surface.log, "scroll");
  assert.equal(surface.stickToBottom, false, "the following genuine user scroll must still unstick");

  surface.log.scrollTop = 900;
  emit(surface.log, "scroll");
  assert.equal(surface.stickToBottom, true, "reaching bottom must re-stick in the production listener");
  surface.disposeChatScrollListeners();
  surface.scrollIntent.dispose();
});

test("production wiring ignores nested input and scroll targets while preserving root scrolling", () => {
  const surface = buildProductionScrollSurface();
  const nestedInput = {};

  surface.log.scrollTop = 300;
  emit(surface.log, "pointerdown", {}, nestedInput);
  emit(surface.log, "scroll", {}, nestedInput);
  assert.equal(surface.stickToBottom, true, "nested code/card/thinking activity is not root intent");

  emit(surface.log, "scroll");
  assert.equal(surface.stickToBottom, true, "nested activity must not unstick a root anchoring scroll");

  emit(surface.log, "wheel");
  emit(surface.log, "scroll");
  assert.equal(surface.stickToBottom, false, "root user scrolling remains intentional");
  surface.disposeChatScrollListeners();
  surface.scrollIntent.dispose();
});

test("production teardown removes every scroll listener and leaves the tracker inert", () => {
  const surface = buildProductionScrollSurface();
  assert.equal(surface.log.listenerCount(), 6, "the production surface installs six scroll listeners");

  surface.disposeChatScrollListeners();
  surface.scrollIntent.dispose();
  assert.equal(surface.log.listenerCount(), 0, "teardown removes every production scroll listener");

  surface.log.scrollTop = 250;
  emit(surface.log, "pointerdown");
  emit(surface.log, "scroll");
  assert.equal(surface.stickToBottom, true, "post-dispose input cannot change stickiness");
  surface.scrollIntent.note({ type: "wheel" });
  assert.equal(surface.scrollIntent.consume(), false, "post-dispose tracker calls are inert");
});
