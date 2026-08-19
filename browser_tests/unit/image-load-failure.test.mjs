// #1417 — a broken image must SAY so, not render as a silent broken card.
//
// `panel_show_media` answers for the DOM dispatch, not the browser's fetch/decode, so a
// large 16-bit PNG served through /view returned ok:true, painted a card, and rendered
// as the browser's broken-image icon — the user had to ask "where is the image", and
// nothing surfaced an error to anyone. Unlike <video> (see #909), an <img> error event
// carries NO error code, so the fallback claims no cause: one honest sentence plus the
// same Open-original escape hatch the lightbox offers.
//
// Pinned at SOURCE, for the same reason the #909 pins are: `show_media` is a
// server->panel push and this harness has no way to drive paintImage against a real
// DOM. A test that never reaches the code it names cannot catch that code breaking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const FAILURE_DEF = "function paintImageFailure(img, url, { offerOpen = true } = {}) {";
const paint = src.slice(
  src.indexOf("function paintImage(url, name) {"),
  src.indexOf(FAILURE_DEF),
);
const failure = src.slice(
  src.indexOf(FAILURE_DEF),
  src.indexOf("function videoObserver() {"),
);
const lightbox = src.slice(
  src.indexOf("function openMediaLightbox(items, startIndex) {"),
  src.indexOf("function openLightboxFromCard(card) {"),
);

test("#1417: the image card observes a load failure at all", () => {
  assert.ok(paint.length > 0, "paintImage must exist");
  assert.match(paint, /addEventListener\("error"/, "a failed fetch/decode must be observed");
});

test("#1417: a zero-size decode counts as a failure even when `error` never fires", () => {
  // Some decode failures surface as `load` with naturalWidth 0 rather than an error
  // event; a browser that decodes the 16-bit master to nothing must not look delivered.
  assert.match(paint, /addEventListener\("load"/, "the load event must be inspected");
  assert.match(paint, /naturalWidth === 0/, "a zero natural size is not a rendered image");
});

test("#1417: listeners attach BEFORE src, so a synchronously cached failure cannot slip past", () => {
  const errAt = paint.indexOf('addEventListener("error"');
  const srcAt = paint.indexOf("img.src = url;");
  assert.ok(errAt > -1 && srcAt > -1, "both statements must exist");
  assert.ok(errAt < srcAt, "setting src first would race a cache-instant failure");
});

test("#1417: the fallback says what happened without inventing a cause", () => {
  // <img> errors carry no code (unlike MEDIA_ERR_SRC_NOT_SUPPORTED), so no
  // 16-bit/size verdict is claimed — one sentence, translated, visible in the card.
  assert.match(failure, /tr\("panel\.this_image_could_not_be_loaded"/, "the failure is stated");
  assert.doesNotMatch(failure, /16-bit|too large/i, "no unprovable cause is asserted");
});

test("#1417: the fallback offers the way out — the lightbox's own open-original path", () => {
  assert.match(failure, /tr\("panel\.open_original"/, "the escape hatch is labelled");
  assert.match(failure, /openMediaUrl\(url\)/, "and it opens the bytes the card could not render");
});

test("#1417: the dead <img> is replaced, not left next to the message", () => {
  // replaceWith also removes the card's click-to-lightbox target, which would only
  // open the same undecodable source one size larger.
  assert.match(failure, /img\.replaceWith\(/, "the broken element must go");
});

test("#1417: error followed by a 0-size load must not paint twice", () => {
  // Both events can fire for one failure; the guard keeps the card to one message.
  assert.match(failure, /if \(img\._cmcpFailed\) return;/, "the double-fire guard must exist");
  assert.match(failure, /img\._cmcpFailed = true;/, "the failure must be recorded");
});

// #1422 — two gaps of the same class survived #1417: the lightbox stage was still a
// silent blank (a failed card stays in collectChatGallery, so prev/next lands on it),
// and a failed card ignored the collapse toggle (the stylesheet hid `> img`, not the
// box that replaced it). Both measured in Chromium against merged main.

test("#1422: the lightbox stage observes a load failure", () => {
  assert.ok(lightbox.length > 0, "openMediaLightbox must exist");
  assert.match(lightbox, /addEventListener\("error"/, "an undecodable stage must be observed");
  assert.match(lightbox, /naturalWidth === 0/, "the zero-size decode route applies here too");
});

test("#1422: the stage reuses the card's failure paint", () => {
  assert.match(lightbox, /paintImageFailure\(img, it\.url/, "one painter, one wording");
  assert.match(lightbox, /offerOpen: false/, "the bar already has Open original — no duplicate");
  assert.match(failure, /offerOpen = true/, "the card keeps its own Open-original button");
});

test("#1422: a verdict for an item the stage moved on from must not paint", () => {
  // render() clears the stage with innerHTML="" and detaching an <img> does not fire
  // error, so no video-style teardown guard is needed — but an async error CAN land
  // after prev/next moved to another item, and that verdict belongs to a stage that
  // no longer shows it.
  assert.match(lightbox, /img\.parentNode !== mediaWrap/, "the stale-stage guard must exist");
});

test("#1422: the stage listeners attach before src, as the card's do", () => {
  const errAt = lightbox.indexOf('addEventListener("error"');
  const srcAt = lightbox.indexOf("img.src = it.url;");
  assert.ok(errAt > -1 && srcAt > -1, "both statements must exist");
  assert.ok(errAt < srcAt, "setting src first would race a cache-instant failure");
});

test("#1422: a collapsed card hides the failure box too", () => {
  // The box sits in the <img>'s slot as a direct child of the card; the collapse rule
  // that hid `> img` and `> .cmcp-video-holder` must name it or the one failed card in
  // the log shows the stub AND the failure box at once.
  assert.match(
    src,
    /\.cmcp-imgcard\.cmcp-media-collapsed > \.cmcp-imgcard-failed \{ display: none; \}/,
    "the failure box must obey the collapse toggle",
  );
});
