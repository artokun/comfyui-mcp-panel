import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stepIndex,
  mediaKindFromUrl,
  normalizeMediaItem,
  createLightboxModel,
} from "../../web/js/lib/lightbox-gallery.js";

// In-panel media lightbox (#163). The overlay DOM lives in the main panel and
// is covered by e2e; these tests pin the pure core it drives: index math,
// url→kind inference, descriptor normalization, and the stateful model.

test("stepIndex wraps in both directions", () => {
  assert.equal(stepIndex(0, 1, 3), 1);
  assert.equal(stepIndex(2, 1, 3), 0, "next past the end wraps to first");
  assert.equal(stepIndex(0, -1, 3), 2, "prev before the start wraps to last");
  assert.equal(stepIndex(1, -1, 3), 0);
});

test("stepIndex clamps when wrap:false", () => {
  assert.equal(stepIndex(2, 1, 3, { wrap: false }), 2, "clamps at the end");
  assert.equal(stepIndex(0, -1, 3, { wrap: false }), 0, "clamps at the start");
  assert.equal(stepIndex(1, 5, 3, { wrap: false }), 2);
});

test("stepIndex is out-of-bounds safe for degenerate inputs", () => {
  assert.equal(stepIndex(0, 1, 0), 0, "empty list");
  assert.equal(stepIndex(5, -2, NaN), 0, "non-finite length");
  assert.equal(stepIndex(NaN, NaN, 4), 0, "non-finite cur/delta collapse to 0-step");
});

test("stepIndex stays in range for huge finite operands (no Infinity%n NaN)", () => {
  const r1 = stepIndex(Number.MAX_VALUE, Number.MAX_VALUE, 3);
  assert.ok(Number.isInteger(r1) && r1 >= 0 && r1 < 3, `wrap result ${r1} in [0,3)`);
  const r2 = stepIndex(Number.MAX_VALUE, 1, 3, { wrap: false });
  assert.equal(r2, 2, "clamp path handles Infinity sum");
  // Lengths beyond Number.MAX_SAFE_INTEGER (where integer indices aren't
  // representable and float rounding could push a result to exactly n) collapse
  // to 0 — never NaN, Infinity, or an out-of-range value.
  for (const [c, d, len] of [
    [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MAX_VALUE / 2, 0, Number.MAX_VALUE],
    [2 ** 99 - 2 ** 46, 2 ** 99, 2 ** 100], // codex round-4 counterexample
  ]) {
    assert.equal(stepIndex(c, d, len), 0, `huge-n (${len}) collapses to 0`);
  }
  // Within the safe-integer range the wrap contract [0,n) is exact.
  const big = Number.MAX_SAFE_INTEGER; // n <= this ⇒ all arithmetic exact
  const rb = stepIndex(big - 1, 5, big);
  assert.ok(Number.isInteger(rb) && rb >= 0 && rb < big, `safe-max wrap ${rb} in [0,n)`);
  assert.equal(rb, 4, "wraps past the end of a max-safe-length gallery");
});

test("mediaKindFromUrl honours data: MIME then extension", () => {
  assert.equal(mediaKindFromUrl("data:video/mp4;base64,AAAA"), "video");
  assert.equal(mediaKindFromUrl("data:image/png;base64,AAAA"), "image");
  assert.equal(mediaKindFromUrl("data:image/gif;base64,AAAA"), "image", "animated gif stays <img>");
  assert.equal(mediaKindFromUrl("/view?filename=clip.webm&type=output"), "video");
  assert.equal(mediaKindFromUrl("/view?filename=pic.png&type=output"), "image");
  assert.equal(mediaKindFromUrl("https://host/a/b/render.MP4"), "video", "case-insensitive ext");
  assert.equal(mediaKindFromUrl(""), "image", "empty → default image");
});

test("normalizeMediaItem coerces strings, objects, and captions", () => {
  assert.deepEqual(normalizeMediaItem("http://x/y.png"), {
    url: "http://x/y.png",
    type: "image",
    caption: "",
  });
  assert.deepEqual(normalizeMediaItem({ url: "http://x/y.mp4", caption: "a clip" }), {
    url: "http://x/y.mp4",
    type: "video",
    caption: "a clip",
  });
  // Explicit type wins even if the extension disagrees.
  assert.equal(normalizeMediaItem({ url: "http://x/y.png", type: "video" }).type, "video");
  // Non-string caption is coerced to a string (never leaks an object).
  assert.equal(normalizeMediaItem({ url: "http://x/y.png", caption: 42 }).caption, "42");
  assert.equal(normalizeMediaItem({}), null, "no url → null");
  assert.equal(normalizeMediaItem(null), null);
});

test("createLightboxModel drops url-less items and clamps the start index", () => {
  const m = createLightboxModel(
    [{ url: "a.png" }, { caption: "no url" }, "b.mp4"],
    9, // out of range → clamped
  );
  assert.equal(m.length, 2, "the url-less descriptor is filtered out");
  assert.equal(m.index, 1, "start index clamps to the last valid item");
  assert.deepEqual(m.current(), { url: "b.mp4", type: "video", caption: "" });
  assert.equal(m.hasMultiple(), true);
});

test("createLightboxModel.step wraps and returns the new current", () => {
  const m = createLightboxModel(["a.png", "b.png", "c.png"], 0);
  assert.equal(m.step(1).url, "b.png");
  assert.equal(m.step(1).url, "c.png");
  assert.equal(m.step(1).url, "a.png", "wraps past the end");
  assert.equal(m.step(-1).url, "c.png", "wraps before the start");
  assert.equal(m.index, 2);
});

test("createLightboxModel handles an empty gallery without throwing", () => {
  const m = createLightboxModel([], 0);
  assert.equal(m.length, 0);
  assert.equal(m.current(), null);
  assert.equal(m.step(1), null);
  assert.equal(m.hasMultiple(), false);
});

test("createLightboxModel.goto clamps to range", () => {
  const m = createLightboxModel(["a.png", "b.png", "c.png"], 0);
  assert.equal(m.goto(1).url, "b.png");
  assert.equal(m.goto(99).url, "c.png", "clamps high");
  assert.equal(m.goto(-5).url, "a.png", "clamps low");
});
