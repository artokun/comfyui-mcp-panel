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
  scrollHeight = 1000;
  scrollTop = 400;
  clientHeight = 100;
}

function emit(log, type, props = {}) {
  const event = new Event(type);
  for (const [key, value] of Object.entries(props)) {
    if (key !== "type") event[key] = value;
  }
  log.dispatchEvent(event);
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
    `let stickToBottom = true;\n${productionListener}\nreturn {\n  log,\n  newMsgBtn,\n  scrollIntent,\n  get stickToBottom() { return stickToBottom; },\n};`,
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
  surface.scrollIntent.dispose();
});
