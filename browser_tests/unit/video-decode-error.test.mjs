// #909 — an undecodable video must SAY so, and a teardown must not say it.
//
// `panel_show_media` answers for the DOM dispatch, not the browser's decode, so an MP4
// the browser refuses (the report: MPEG-4 Part 2, `mpeg4`/`mp4v`) returned ok:true and
// rendered a blank card. `mountHolderVideo` swallows the `play()` rejection — correctly,
// blocked muted autoplay is not a failure — so the error listener is the only place the
// difference can surface.
//
// Pinned at SOURCE, and only at source. An earlier version of this change shipped an
// e2e alongside it that manipulated a plain div and never invoked mountHolderVideo, the
// production error listener, or the observer — it proved that an empty div stays empty
// (codex). It was removed rather than kept as decoration: a test that never reaches the
// code it names cannot catch that code breaking, and claiming otherwise is worse than
// having no test at all. `show_media` is a server->panel push whose lazy holder this
// harness could not get to paint; making it drivable is its own piece of work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const mount = src.slice(
  src.indexOf("function mountHolderVideo(holder) {"),
  src.indexOf("function unmountHolderVideo(holder) {"),
);

test("#909: the video mount reports a decode failure", () => {
  assert.ok(mount.length > 0, "the mount must exist");
  assert.match(mount, /addEventListener\("error"/, "a decode failure must be observed at all");
  assert.match(
    mount,
    /Re-encode as H\.264 \(yuv420p\) or WebM/,
    "the unsupported-format case must name what actually works",
  );
});

test("#909: MEDIA_ERR_SRC_NOT_SUPPORTED gets the re-encode hint, others do not", () => {
  // Code 4 is "unsupported source or type" — not exclusively codec/container, and some
  // decode failures arrive as code 3 (codex). So re-encoding is OFFERED on 4 and never
  // asserted as the only remedy, while other codes get a sentence that claims no cause
  // at all — the same rule the rest of this file follows.
  assert.match(mount, /v\.error\?\.code === 4/, "the codec case must be distinguished");
  assert.match(mount, /could not be loaded/, "other failures need their own wording");
});

test("#909: a TEARDOWN must not be reported as a failure", () => {
  // unmountHolderVideo clears `src` and calls load() to release decode buffers, and that
  // fires `error`. Without both guards every healthy video would show the failure message
  // as soon as it scrolled out of view — a false failure in place of a silent one.
  assert.match(mount, /if \(holder\._video !== v\) return;/, "a holder that moved on explains nothing");
  assert.match(mount, /if \(!v\.getAttribute\("src"\)\) return;/, "a cleared source is a teardown");
});

test("#909: a failed source is TERMINAL — the observer must not remount it", () => {
  // `data-src` survives the error paint, so without this the lazy observer remounts the
  // same known-bad media on the next scroll-in: the message vanishes, the decode fails
  // again, and the card blinks back to blank (codex).
  assert.match(
    mount,
    /holder\._mediaFailedSrc && holder\._mediaFailedSrc === holder\.dataset\.src/,
    "a remount of the SAME failed source must be refused",
  );
  // Keyed on the source, not a bare flag, so a later card with a different source still
  // gets a real attempt.
  assert.match(mount, /holder\._mediaFailedSrc = holder\.dataset\.src;/, "the failure records its source");
});

test("#909: the dead element releases its decode buffers", () => {
  // Detaching alone is not deterministic release, and unmountHolderVideo skips the
  // element once `_video` is null — so the error path is the last chance to do it.
  const handler = mount.slice(mount.indexOf('addEventListener("error"'));
  assert.match(handler, /v\.removeAttribute\("src"\)/, "the source must be cleared");
  assert.match(handler, /v\.load\(\)/, "and load() called, the way unmount does it");
});

test("#909: a DIFFERENT source does not inherit the failure's styling", () => {
  // The terminal guard is keyed on the source, so a new one bypasses it and mounts —
  // and `textContent = ""` does not undo the appended inline declarations, so a valid
  // video would render inside the error layout and repeated failures would keep
  // appending (codex). Restoring the saved cssText is reversible; clearing it would
  // also discard the learned aspect-ratio.
  assert.match(mount, /holder\._preFailCss = holder\.style\.cssText;/, "the pre-failure styling is saved");
  assert.match(mount, /holder\.style\.cssText = holder\._preFailCss;/, "and restored for a new source");
  assert.match(mount, /holder\._mediaFailedSrc = null;/, "the terminal mark clears with it");
});
