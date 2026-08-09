// #909 — an undecodable video must SAY so, and a teardown must not say it.
//
// `panel_show_media` answers for the DOM dispatch, not the browser's decode, so an MP4
// the browser refuses (the report: MPEG-4 Part 2, `mpeg4`/`mp4v`) returned ok:true and
// rendered a blank card. `mountHolderVideo` swallows the `play()` rejection — correctly,
// blocked muted autoplay is not a failure — so the error listener is the only place the
// difference can surface.
//
// Pinned at source because the lazy holder is a closure inside the panel and needs a
// live DOM; the teardown half is asserted behaviourally in
// browser_tests/video-decode-failure-is-visible.spec.ts.
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

test("#909: MEDIA_ERR_SRC_NOT_SUPPORTED gets the actionable message, others do not", () => {
  // Code 4 is the codec/container case and the only one with a remedy. A network or
  // decode error gets a narrower, truthful sentence instead of advice that would not
  // help — the same rule the rest of this file follows about not asserting a cause.
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
