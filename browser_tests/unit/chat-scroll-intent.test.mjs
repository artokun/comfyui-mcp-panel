import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createChatScrollIntentTracker,
  isUserScrollIntent,
  updateChatStickiness,
} from "../../web/js/lib/chat-scroll-intent.js";
import { revealInteractiveCard } from "../../web/js/lib/interactive-card-reveal.js";

const panelSource = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const listenerStart = panelSource.indexOf("  const scrollIntent = createChatScrollIntentTracker();");
const listenerEnd = panelSource.indexOf("  const chatScrollStabilizer =", listenerStart);
assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, "production chat scroll listener block not found");
const productionListener = panelSource.slice(listenerStart, listenerEnd);

class ChatLog extends EventTarget {
  constructor({ dispatchScrollOnWrite = false } = {}) {
    super();
    this.listeners = new Map();
    this._scrollTop = 400;
    this.dispatchScrollOnWrite = dispatchScrollOnWrite;
    this.programmaticWrites = [];
  }

  scrollHeight = 1000;
  clientHeight = 100;

  get scrollTop() {
    return this._scrollTop;
  }

  set scrollTop(value) {
    this.programmaticWrites.push(value);
    if (this.dispatchScrollOnWrite) {
      this.dispatchEventFrom(this, { type: "scroll" });
    } else {
      this._scrollTop = value;
    }
  }

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

function buildProductionScrollSurface(options) {
  const log = new ChatLog(options);
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

function productionRevealScrollNowSource(painterName) {
  const painterStart = panelSource.indexOf(`function ${painterName}(`);
  assert.ok(painterStart >= 0, `${painterName} production painter not found`);
  const callbackStart = panelSource.indexOf("scrollNow: () => {", painterStart);
  assert.ok(callbackStart > painterStart, `${painterName} production reveal callback not found`);
  const bodyStart = panelSource.indexOf("{", callbackStart);
  let depth = 0;
  for (let i = bodyStart; i < panelSource.length; i += 1) {
    if (panelSource[i] === "{") depth += 1;
    if (panelSource[i] === "}" && --depth === 0) return panelSource.slice(bodyStart + 1, i);
  }
  assert.fail(`${painterName} production reveal callback is not balanced`);
}

function buildProductionRevealScrollNow(painterName, surface) {
  const card = {
    scrollIntoView() {
      surface.cardScrolls += 1;
      surface.log.dispatchEventFrom(surface.log, { type: "scroll" });
    },
  };
  const scrollNow = new Function(
    "scrollIntent",
    "log",
    "card",
    productionRevealScrollNowSource(painterName),
  );
  return () => scrollNow(surface.scrollIntent, surface.log, card);
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

test("production reveal paths fence both writes before preserving a later root scroll", () => {
  for (const painterName of ["paintQuestion", "paintSecret"]) {
    const surface = buildProductionScrollSurface({ dispatchScrollOnWrite: true });
    surface.cardScrolls = 0;
    const scrollNow = buildProductionRevealScrollNow(painterName, surface);

    emit(surface.log, "pointerdown");
    revealInteractiveCard({ scrollNow, retryMs: 0 });
    assert.deepEqual(surface.log.programmaticWrites, [surface.log.scrollHeight]);
    assert.equal(surface.cardScrolls, 1, `${painterName} must deliver its card reveal scroll`);
    assert.equal(
      surface.stickToBottom,
      true,
      `${painterName} must fence both synchronous programmatic scroll deliveries`,
    );

    surface.log._scrollTop = 250;
    emit(surface.log, "scroll");
    assert.equal(
      surface.stickToBottom,
      false,
      `${painterName} must preserve the marker for the later root scroll`,
    );
    surface.disposeChatScrollListeners();
    surface.scrollIntent.dispose();
  }
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

test("nested gesture targets (wheel, touchmove, pointerdown) from descendant elements count as scroll intent", () => {
  const surface = buildProductionScrollSurface();
  const nestedElement = {};

  // Pointerdown on a nested element (e.g., a button inside a message card) should mark intent
  surface.log.scrollTop = 300;
  emit(surface.log, "pointerdown", {}, nestedElement);
  emit(surface.log, "scroll");
  assert.equal(
    surface.stickToBottom,
    false,
    "a pointerdown gesture on a descendant element must still latch stickToBottom off"
  );

  // Wheel on a nested element should also mark intent
  const surface2 = buildProductionScrollSurface();
  surface2.log.scrollTop = 300;
  emit(surface2.log, "wheel", {}, nestedElement);
  emit(surface2.log, "scroll");
  assert.equal(
    surface2.stickToBottom,
    false,
    "a wheel gesture on a descendant element must still latch stickToBottom off"
  );

  // Touchmove on a nested element should also mark intent
  const surface3 = buildProductionScrollSurface();
  surface3.log.scrollTop = 300;
  emit(surface3.log, "touchmove", {}, nestedElement);
  emit(surface3.log, "scroll");
  assert.equal(
    surface3.stickToBottom,
    false,
    "a touchmove gesture on a descendant element must still latch stickToBottom off"
  );

  surface.disposeChatScrollListeners();
  surface.scrollIntent.dispose();
  surface2.disposeChatScrollListeners();
  surface2.scrollIntent.dispose();
  surface3.disposeChatScrollListeners();
  surface3.scrollIntent.dispose();
});

test("programmatic scroll events on nested elements do not count as user intent", () => {
  const surface = buildProductionScrollSurface();
  const nestedElement = {};

  // Scroll events on nested elements (non-user-generated) should not mark intent
  surface.log.scrollTop = 300;
  emit(surface.log, "scroll", {}, nestedElement);
  emit(surface.log, "scroll");
  assert.equal(
    surface.stickToBottom,
    true,
    "a programmatic scroll event on a nested element must not unstick"
  );

  surface.disposeChatScrollListeners();
  surface.scrollIntent.dispose();
});

test("keydown in form fields (nested editable elements) counts as scroll intent", () => {
  const surface = buildProductionScrollSurface();
  const textField = {}; // Simulates an input/textarea within the chat

  surface.log.scrollTop = 300;
  // User typing in a form field inside the chat (e.g., a TextField in an A2UI card)
  // should count as scroll intent
  emit(surface.log, "keydown", { key: "ArrowDown" }, textField);
  emit(surface.log, "scroll");
  assert.equal(
    surface.stickToBottom,
    false,
    "a keydown event on a nested form field must count as scroll intent"
  );

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
