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
  // #1280 followup — MOUNTING MUST NOT WAIT FOR THE OBSERVER.
  //
  // `observe()` alone made the first paint depend on the IntersectionObserver's
  // first callback, which is async and lands after the caller has appended
  // whatever comes next. A run completion paints the video card and then
  // immediately paints the storyboard contact sheet, so the video can already be
  // out of `root: log` by the time the callback runs — it never mounts, and the
  // card stays the gray 16/9 box. Reported as "previews stopped showing" with
  // the toggle ON, which no assertion here could see, because "the branch exists
  // and calls observe" was true the whole time.
  // The leading boundary is load-bearing: paintVideo ALSO contains
  // `unmountHolderVideo(holder)` (the collapse handler), and that string
  // CONTAINS `mountHolderVideo(holder)`. A bare substring/regex match is
  // therefore satisfied by the unmount call and passes with the mount deleted —
  // which is exactly what it did until a mutation run caught it.
  const MOUNT_CALL = /(?<![A-Za-z])mountHolderVideo\(holder\)/;
  assert.match(
    paint,
    MOUNT_CALL,
    "previews ON must mount the player at paint time, not only observe for it",
  );
  // ORDER is the assertion, not mere presence: mounting AFTER the observe call
  // would still leave the first paint racing the callback.
  const mountAt = paint.search(MOUNT_CALL);
  const observeAt = paint.indexOf("videoObserver().observe(holder)");
  assert.ok(mountAt >= 0 && observeAt >= 0, "both calls must be present");
  assert.ok(
    mountAt < observeAt,
    "the direct mount must come before the observe, so the first paint never waits on it",
  );
  assert.match(
    paint,
    /paintVideoPlaceholder\(holder, card, url, name\)/,
    "previews OFF paints the metadata-only placeholder",
  );
});

test("#1280: the placeholder never autoplays and plays INLINE on click", () => {
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
  // #1280 followup — THE REQUESTED BEHAVIOUR IS A PLAY BUTTON, NOT A LIGHTBOX.
  //
  // The feature asked for was: previews OFF shows the first frame with a play
  // button, and pressing it turns the video on. This shipped sending the click
  // to the lightbox instead, so OFF meant "watch it somewhere else" rather than
  // "watch it here, when you ask". The old assertion pinned the wrong behaviour
  // in place, which is why nothing caught the mismatch: it asserted the code did
  // what it did, not what it was for.
  assert.match(placeholder, /cmcp-video-play/, "the poster must carry a play affordance");
  assert.match(
    placeholder,
    /mountHolderVideo\(holder\)/,
    "clicking the poster must mount the real player IN PLACE",
  );
  assert.ok(
    !/openLightboxFromCard\(card\)/.test(placeholder),
    "the card's own surface plays inline; the lightbox belongs to the ⛶ button",
  );
  // Opting in is what earns observation: observing an opted-OUT card would let a
  // later scroll-in mount the very player the setting says not to mount.
  assert.match(
    placeholder,
    /videoObserver\(\)\.observe\(holder\)/,
    "once the user presses play, the card joins the normal unmount/remount cycle",
  );
});
