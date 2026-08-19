// #1280 — "Video previews in chat" (default ON): off paints a metadata-only
// placeholder and leaves the full decode to the lightbox.
//
// Two things are pinned here:
//
//  1. THE DECISION (lib/video-previews.js) — the setting defaults ON, and only
//     an explicit stored `false` turns previews off. A missing or unreadable
//     settings store answers `undefined`; treating that as "off" would silently
//     change what every returning user sees the day the store hiccups, which is
//     exactly the quiet behaviour change this codebase refuses elsewhere.
//
//  2. THE GATE (paintVideo) — pinned at SOURCE, the same way
//     video-decode-error.test.mjs pins mountHolderVideo: the DOM closure is not
//     importable, but the branch deciding live-player vs placeholder is the
//     whole point of the change, so the test asserts it exists, consults the
//     setting, and defaults to the live player.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { videoPreviewsEnabled } from "../../web/js/lib/video-previews.js";

test("#1280: previews are ON unless the stored value is explicitly false", () => {
  assert.equal(videoPreviewsEnabled(true), true);
  // The DEFAULT path: a fresh install has never written the setting, and a
  // settings store that cannot be read answers undefined — both must keep the
  // behaviour every existing user already has.
  assert.equal(videoPreviewsEnabled(undefined), true);
  assert.equal(videoPreviewsEnabled(null), true);
  assert.equal(videoPreviewsEnabled(false), false);
});

test("#1280: paintVideo consults the setting and falls back to the live player", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const paint = src.slice(
    src.indexOf("function paintVideo(url, name) {"),
    src.indexOf("function paintAudio(url, name) {"),
  );
  assert.ok(paint.length > 0, "paintVideo must exist");
  assert.match(
    paint,
    /videoPreviewsEnabled\(getSetting\(SETTING_VIDEO_PREVIEWS\)\)/,
    "the card must ask the setting before choosing its surface",
  );
  assert.match(
    paint,
    /videoObserver\(\)\.observe\(holder\)/,
    "previews ON keeps the lazy live player",
  );
  assert.match(
    paint,
    /paintVideoPlaceholder\(holder, card, url, name\)/,
    "previews OFF paints the metadata-only placeholder",
  );
});

test("#1280: the placeholder never autoplays and stays reachable via the lightbox", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const placeholder = src.slice(
    src.indexOf("function paintVideoPlaceholder(holder, card, url, name) {"),
    src.indexOf("function paintVideo(url, name) {"),
  );
  assert.ok(placeholder.length > 0, "the placeholder painter must exist");
  // The RAM this setting exists to save is the decode. preload="metadata" is
  // the load ceiling — headers and the first frame, nothing more.
  assert.match(placeholder, /v\.preload = "metadata"/, "metadata-only load is the whole point");
  assert.ok(!/v\.autoplay\s*=\s*true/.test(placeholder), "a placeholder must not autoplay");
  assert.ok(!/v\.loop\s*=\s*true/.test(placeholder), "a placeholder must not loop");
  // The video stays REACHABLE: clicking the card opens the same lightbox the
  // expand button does.
  assert.match(placeholder, /openLightboxFromCard\(card\)/, "click opens the lightbox");
});
