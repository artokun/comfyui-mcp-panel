// The video-card poster: one still, three jobs.
//
// A video card needs a first frame for the previews-OFF placeholder, for the
// space it reserves, and for the `poster` that stops the pause/unmount cycle
// flashing gray on return. Each was previously paid for separately or not at
// all — the placeholder opened a media pipeline for `preload="metadata"`, and
// the wrapper reserved a GUESSED 16/9 that `loadedmetadata` later corrected,
// shifting every card below it.
//
// buildVideoStoryboard already decodes and seeks the video, so frame 0 is in
// hand; the poster costs one drawImage and no second decode.
//
// Pinned at SOURCE, like video-previews.test.mjs: the DOM closure is not
// importable, but these are the invariants that make the feature correct rather
// than merely present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appendStoryboardCacheBust,
  createStoryboardIdentity,
} from "../../web/js/lib/storyboard-cache-identity.js";
import { NO_PROMPT_KEY } from "../../web/js/lib/run-completion.js";
import { collectNodeOutputMedia } from "../../web/js/lib/node-output-media.js";

const panelSrc = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const frameSrc = readFileSync(new URL("../../web/js/lib/run-completion-frame.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0, `missing anchor: ${from}`);
  assert.ok(b > a, `missing end anchor: ${to}`);
  return src.slice(a, b);
}

test("poster: the storyboard pass emits it from the decode it already paid for", () => {
  const fn = slice(panelSrc, "async function buildVideoStoryboard(url) {", "\n/** Current workflow title");
  // Taken from the FIRST frame that actually painted, not `i === 0`: a video
  // whose opening frame refuses to seek `continue`s past it, and would otherwise
  // leave the poster null while the sheet itself is perfectly good.
  assert.match(fn, /if \(!posterCanvas\)/, "the poster is captured on the first frame that painted");
  assert.ok(
    !/if \(i === 0\)/.test(fn),
    "keying on i===0 would lose the poster whenever the opening frame fails to seek",
  );
  // Real dimensions are the whole point: they are what turn the guessed ratio
  // into an exact one.
  assert.match(fn, /pc\.width = vw;/, "the poster carries the video's true width");
  assert.match(fn, /pc\.height = vh;/, "the poster carries the video's true height");
  // Rides along on the sheet blob, exactly like paintedFrames — no new return
  // shape for existing callers to handle.
  assert.match(fn, /blob\.posterBlob = posterBlob/, "the poster rides along on the sheet blob");
});

test("poster: a failure to produce one never fails the storyboard", () => {
  const fn = slice(panelSrc, "async function buildVideoStoryboard(url) {", "\n/** Current workflow title");
  const capture = slice(fn, "if (!posterCanvas)", "if (STORYBOARD.LABEL)");
  assert.match(capture, /catch/, "a poster capture that throws must be swallowed");
  // The sheet is the product; the poster is an optimisation on top of it. A
  // tainted canvas or a refused context must not take the sheet down with it.
  const encode = slice(fn, "if (posterCanvas) {", "return blob;");
  assert.match(encode, /catch/, "a poster encode that throws must be swallowed");
});

test("poster: it is back-filled by video URL, because the card is painted first", () => {
  // The ordering is the whole reason this is a registry and not an argument:
  // the storyboard is async and resolves AFTER paintVideo has run.
  assert.match(panelSrc, /function registerVideoHolder\(url, holder\)/, "cards register themselves");
  assert.match(panelSrc, /function applyVideoPoster\(videoUrl, posterUrl\)/, "the storyboard calls back");
  const paint = slice(panelSrc, "function paintVideo(url, name) {", "function paintAudio(url, name) {");
  assert.match(paint, /registerVideoHolder\(url, holder\)/, "paintVideo must register its holder");
  // Registration happens BEFORE the ON/OFF branch, so an already-known poster
  // gives the placeholder a real image instead of a metadata-loading <video>.
  assert.ok(
    paint.indexOf("registerVideoHolder(url, holder)") <
      paint.indexOf("videoPreviewsEnabled(getSetting(SETTING_VIDEO_PREVIEWS))"),
    "registration must precede the surface choice, or a known poster arrives too late to be used",
  );
});

test("poster: detached cards are dropped rather than written to forever", () => {
  const fn = slice(panelSrc, "function applyVideoPoster(videoUrl, posterUrl)", "function unmountHolderVideo");
  assert.match(fn, /isConnected/, "holders whose card left the DOM must be released");
  assert.match(fn, /set\.delete\(holder\)/, "a detached holder is removed from the registry");
});

test("poster: it replaces the guess, the placeholder, and the remount flash", () => {
  const fn = slice(panelSrc, "function applyPosterToHolder(holder, posterUrl)", "/** Called by the storyboard");
  // (1) EXACT space reservation, from an <img> decode rather than a media pipeline.
  assert.match(fn, /naturalWidth/, "the exact ratio comes from the poster's natural size");
  assert.match(fn, /holder\.style\.aspectRatio/, "and is written onto the wrapper");
  // (2) the OFF placeholder becomes a true image.
  assert.match(fn, /video\[data-cmcp-placeholder\]/, "a metadata placeholder is found");
  assert.match(fn, /ph\.replaceWith\(img\)/, "and replaced by a real <img>");
  // (3) the live player stops flashing gray on remount.
  assert.match(fn, /holder\._video\.poster = posterUrl/, "a mounted player gets the poster too");
});

test("poster: the mounted player uses it, so the pause/unmount cycle never flashes", () => {
  const fn = slice(panelSrc, "function mountHolderVideo(holder) {", "function unmountHolderVideo");
  assert.match(
    fn,
    /if \(holder\.dataset\.poster\) v\.poster = holder\.dataset\.poster/,
    "a remount must paint the poster while the source decodes",
  );
});

test("poster: the upload is best-effort and threaded as a dependency", () => {
  assert.match(
    frameSrc,
    /if \(blob\.posterBlob && typeof applyVideoPoster === "function"\)/,
    "absent poster or absent dep must both degrade silently",
  );
  assert.match(
    frameSrc,
    /storyboardPosterUploadName\(base, storyboardIdentity\)/,
    "the poster uses the same per-attempt identity as the sheet",
  );
  assert.match(frameSrc, /\{ type: "temp" \}/, "into the swept temp namespace, never input/");
  assert.match(frameSrc, /applyVideoPoster\(sourceUrl, imageViewUrl\(posterRef\)\)/, "the late poster targets the painted card's URL");
  // Both composers paint video cards through the same painter, so both must
  // supply the back-fill or one surface silently keeps the old behaviour.
  const deps = panelSrc.split("applyVideoPoster,").length - 1;
  assert.ok(deps >= 2, `applyVideoPoster must be passed to both composers (found ${deps})`);
});

test("#1718 production boundary: late poster results stay with their render attempt", () => {
  // Drive the SHIPPED onExecuted branch, not the cache-name helper. Before the
  // fix both executions handed paintVideo the same stable /view URL, so the
  // holder registry treated two cards as one and a late first poster broadcast
  // into the second card.
  const onExecutedStart = panelSrc.indexOf("  function onExecuted(ev) {");
  const onExecutedEnd = panelSrc.indexOf("\n  function onExecError(ev)", onExecutedStart);
  assert.ok(onExecutedStart >= 0 && onExecutedEnd > onExecutedStart, "could not isolate production onExecuted");
  const onExecuted = new Function(
    "imageViewUrl",
    "isVideoOutput",
    "isAudioOutput",
    "paintVideo",
    "paintAudio",
    "paintImage",
    "runCompletion",
    "stripMisattachedExecutionPreviews",
    "app",
    "createStoryboardIdentity",
    "appendStoryboardCacheBust",
    "NO_PROMPT_KEY",
    "collectNodeOutputMedia",
    `return (${panelSrc.slice(onExecutedStart, onExecutedEnd).trim()});`,
  )(
    (m) => `/view?filename=${m.filename}&type=${m.type || "output"}`,
    () => true,
    () => false,
    (url) => painted.push(url),
    () => {},
    () => {},
    { onExecuted: (_promptId, output) => buffered.push(output) },
    () => {},
    {},
    createStoryboardIdentity,
    appendStoryboardCacheBust,
    NO_PROMPT_KEY,
    collectNodeOutputMedia,
  );

  const painted = [];
  const buffered = [];
  const video = { filename: "Minimax_00001.mp4", type: "temp" };
  onExecuted({ detail: { prompt_id: "first", output: { videos: [video] } } });
  onExecuted({ detail: { prompt_id: "second", output: { videos: [video] } } });
  assert.equal(painted.length, 2);
  assert.notEqual(painted[0], painted[1], "each onExecuted card must receive a distinct URL");
  assert.match(painted[0], /[?&]cmcp_storyboard=/);
  assert.match(painted[1], /[?&]cmcp_storyboard=/);
  assert.equal(buffered[0].videos[0].videoUrl, painted[0]);
  assert.equal(buffered[1].videos[0].videoUrl, painted[1]);

  // Execute the production holder registry against those exact URLs. A late
  // poster for the first completion must not reach the second holder.
  const registryStart = panelSrc.indexOf("  const _videoPosters = new Map();");
  const registerEnd = panelSrc.indexOf("  /** Put a known poster on one holder", registryStart);
  const applyVideoStart = panelSrc.indexOf("  function applyVideoPoster", registerEnd);
  const applyVideoEnd = panelSrc.indexOf("  function unmountHolderVideo", applyVideoStart);
  assert.ok(
    registryStart >= 0 && registerEnd > registryStart && applyVideoStart > registerEnd && applyVideoEnd > applyVideoStart,
    "could not isolate production poster registry",
  );
  const applied = [];
  const { registerVideoHolder, applyVideoPoster } = new Function(
    "applyPosterToHolder",
    `${panelSrc.slice(registryStart, registerEnd)}\n${panelSrc.slice(applyVideoStart, applyVideoEnd)}\nreturn { registerVideoHolder, applyVideoPoster };`,
  )((holder, poster) => applied.push({ holder, poster }));
  const firstHolder = { isConnected: true };
  const secondHolder = { isConnected: true };
  registerVideoHolder(painted[0], firstHolder);
  registerVideoHolder(painted[1], secondHolder);
  applyVideoPoster(painted[1], "poster-second.png");
  applyVideoPoster(painted[0], "poster-first.png");
  assert.deepEqual(applied, [
    { holder: secondHolder, poster: "poster-second.png" },
    { holder: firstHolder, poster: "poster-first.png" },
  ]);
});
