import { test } from "node:test";
import assert from "node:assert/strict";

import { isImeComposing } from "../../web/js/lib/ime.js";

// isImeComposing is the guard every chat/menu keydown handler calls FIRST so a
// CJK IME's commit keystroke (Enter) doesn't submit early and leak the trailing
// syllable as a stray one-char message (#385).

test("true when event.isComposing is set (the standard signal)", () => {
  assert.equal(isImeComposing({ key: "Enter", isComposing: true }), true);
});

test("true on the legacy keyCode === 229 sentinel (isComposing false/absent)", () => {
  // Some engines report isComposing=false on the first/last keydown of a
  // composition but still emit keyCode 229 while the IME is processing.
  assert.equal(isImeComposing({ key: "Enter", keyCode: 229 }), true);
  assert.equal(isImeComposing({ key: "Enter", isComposing: false, keyCode: 229 }), true);
});

test("false for an ordinary (non-composing) Enter — submit proceeds", () => {
  assert.equal(isImeComposing({ key: "Enter", isComposing: false, keyCode: 13 }), false);
  assert.equal(isImeComposing({ key: "Enter" }), false);
});

test("false for ordinary navigation keys with no IME state", () => {
  assert.equal(isImeComposing({ key: "ArrowDown", keyCode: 40 }), false);
  assert.equal(isImeComposing({ key: "Escape", keyCode: 27 }), false);
});

test("always returns a boolean, and is null/undefined safe", () => {
  assert.equal(isImeComposing(null), false);
  assert.equal(isImeComposing(undefined), false);
  assert.equal(typeof isImeComposing({ isComposing: true }), "boolean");
});
