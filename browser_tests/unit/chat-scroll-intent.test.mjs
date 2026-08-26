import assert from "node:assert/strict";
import test from "node:test";

import {
  createChatScrollIntentTracker,
  isUserScrollIntent,
  updateChatStickiness,
} from "../../web/js/lib/chat-scroll-intent.js";

test("programmatic and anchoring scroll events do not count as user intent", () => {
  const tracker = createChatScrollIntentTracker();

  tracker.note({ type: "scroll" });
  tracker.note({ type: "resize" });
  assert.equal(tracker.consume(), false);
  assert.equal(isUserScrollIntent({ type: "scroll" }), false);
  assert.equal(isUserScrollIntent({ type: "keydown", key: "a" }), false);
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
