// #1834 — the chat's inline image card must not show a PREVIOUS run's pixels.
//
// ComfyUI's /view is keyed by filename and nothing sets Cache-Control on it
// (server.py says so in its own comment; `no-store` is attached only on the
// dangerous-content-type branch). A SaveImage `filename_prefix` built from
// `%date%` + `%counter%` can therefore re-emit a name an earlier day's run
// already used, and the browser paints the cached bytes under the new name. The
// reporter saw exactly that: the chat thumbnail for `test_face_00005_.png`
// showed a studio background while opening the same filename in the file viewer
// showed the grass-field render they had just prompted for.
//
// WHAT THIS PINS, and why it is pinned HERE rather than on the helper:
//
// The first attempt at this bug (PR #1835) added the cache-bust inside
// `buildStillsSegment`, on the URL handed to `fetchImageBytes` /
// `fetchImageDimensions`. Those are the completion frame's SIZE AND DIMENSION
// PROBES. The picture the person actually looks at is painted much earlier, by
// `onExecuted`, from a bare `imageViewUrl(m)` — so the symptom was untouched and
// the issue was closed on a fix that could not reach it. A helper-level test
// would have passed just as happily.
//
// So this drives the SHIPPED `onExecuted` out of the panel source and asserts on
// what `paintImage` is actually handed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { appendImageCacheBust } from "../../web/js/lib/storyboard-cache-identity.js";
import { composeShowMediaReply } from "../../web/js/lib/media-preview.js";
import { NO_PROMPT_KEY } from "../../web/js/lib/run-completion.js";
import { collectNodeOutputMedia } from "../../web/js/lib/node-output-media.js";

const panelSrc = readFileSync(
  new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  "utf8",
);

/** Instantiate the production `onExecuted` with injected panel helpers. */
function productionOnExecuted() {
  const start = panelSrc.indexOf("  function onExecuted(ev) {");
  const end = panelSrc.indexOf("\n  function onExecError(ev)", start);
  assert.ok(start >= 0 && end > start, "could not isolate production onExecuted");

  const painted = [];
  const buffered = [];
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
    "appendImageCacheBust",
    "NO_PROMPT_KEY",
    "collectNodeOutputMedia",
    `return (${panelSrc.slice(start, end).trim()});`,
  )(
    (m) =>
      `/view?filename=${m.filename}&subfolder=${m.subfolder ?? ""}&type=${m.type || "output"}`,
    () => false,
    () => false,
    () => {},
    () => {},
    (url, name) => painted.push({ url, name }),
    { onExecuted: (promptId, output) => buffered.push({ promptId, output }) },
    () => {},
    {},
    () => "identity",
    (url) => url,
    appendImageCacheBust,
    NO_PROMPT_KEY,
    collectNodeOutputMedia,
  );
  return { onExecuted, painted, buffered };
}

const SAME_FILE = { filename: "test_face_00005_.png", type: "output" };

/** The same /view URL the harness's injected `imageViewUrl` builds. */
const rawViewUrl = (m) =>
  `/view?filename=${m.filename}&subfolder=${m.subfolder ?? ""}&type=${m.type || "output"}`;

// Mirrors of the completion tracker's private normalisers — they are not
// exported, so the source lines are pinned by the test below. A mirror that
// drifts would leave this file agreeing with itself instead of with production.
const key = (id) => (id == null ? NO_PROMPT_KEY : String(id));
const promptIdOf = (k) => (k === NO_PROMPT_KEY ? null : k);

test("#1834: the mirrored tracker normalisers still match the tracker", () => {
  const src = readFileSync(
    new URL("../../web/js/lib/run-completion.js", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /const key = \(id\) => \(id == null \? NO_PROMPT_KEY : String\(id\)\);/,
    "the card's cache key is normalised to match this line — see the numeric-id test",
  );
  assert.match(
    src,
    /const promptIdOf = \(k\) => \(k === NO_PROMPT_KEY \? null : k\);/,
    "this is what decides the promptId the completion frame's probes bust with",
  );
});

test("#1834: two runs reusing one filename paint two DIFFERENT card URLs", () => {
  const { onExecuted, painted } = productionOnExecuted();

  onExecuted({ detail: { prompt_id: "run-a", output: { images: [SAME_FILE] } } });
  onExecuted({ detail: { prompt_id: "run-b", output: { images: [SAME_FILE] } } });

  assert.equal(painted.length, 2, "both runs must paint a card");
  // THE bug: identical URL → the browser's HTTP cache answers the second card
  // with the first run's bytes.
  assert.notEqual(
    painted[0].url,
    painted[1].url,
    "a re-used output filename must not resolve to one cacheable URL",
  );
  for (const p of painted) {
    assert.match(p.url, /[?&]cmcp_prompt=/, "each card URL carries the run key");
    // The bust must not cost the URL its meaning — /view still has to resolve.
    assert.match(p.url, /[?&]filename=test_face_00005_\.png(?:&|$)/);
    assert.match(p.url, /[?&]type=output(?:&|$)/);
  }
  assert.match(painted[0].url, /[?&]cmcp_prompt=run-a(?:&|$)/);
  assert.match(painted[1].url, /[?&]cmcp_prompt=run-b(?:&|$)/);
  assert.equal(painted[0].name, "test_face_00005_.png", "the caption is untouched");
});

test("#1834: the card and the completion frame's probes address ONE url", () => {
  // buildStillsSegment busts with the same key (PR #1835). If these two ever
  // diverge the size/dimensions reported in the completion note describe a
  // download the card never made — the exact "metadata was right, picture was
  // wrong" split that #1718 reported for storyboards.
  const { onExecuted, painted, buffered } = productionOnExecuted();
  onExecuted({ detail: { prompt_id: "run-a", output: { images: [SAME_FILE] } } });

  const probeUrl = appendImageCacheBust(
    `/view?filename=${SAME_FILE.filename}&subfolder=&type=output`,
    "run-a",
  );
  assert.equal(painted[0].url, probeUrl);
  // The raw ref still rides the completion buffer unmodified — the agent's
  // image blocks are resolved by the orchestrator, not from this URL.
  assert.deepEqual(buffered[0].output.images, [SAME_FILE]);
  assert.equal(buffered[0].promptId, "run-a");
});

test("#1834: a NON-STRING prompt id is normalised the way the tracker does", () => {
  // The tracker stringifies: `key = (id) => id == null ? NO_PROMPT_KEY :
  // String(id)`, and `promptIdOf` hands that string to the completion frame. So
  // a numeric prompt id reaches the frame's probes as "7". A card keyed on the
  // raw `7` would fail the helper's string check and be left unbusted — stale
  // pixels, AND a note describing a file the card never fetched. Parity with
  // `key()` is the assertion, not merely "something was appended".
  const { onExecuted, painted } = productionOnExecuted();
  onExecuted({ detail: { prompt_id: 7, output: { images: [SAME_FILE] } } });
  onExecuted({ detail: { prompt_id: 8, output: { images: [SAME_FILE] } } });

  assert.equal(painted.length, 2);
  assert.equal(painted[0].url, appendImageCacheBust(rawViewUrl(SAME_FILE), promptIdOf(key(7))));
  assert.equal(painted[1].url, appendImageCacheBust(rawViewUrl(SAME_FILE), promptIdOf(key(8))));
  assert.match(painted[0].url, /[?&]cmcp_prompt=7(?:&|$)/);
  assert.notEqual(painted[0].url, painted[1].url);
});

test("#1834: a prompt id that IS the reserved sentinel busts nothing", () => {
  // `promptIdOf` maps NO_PROMPT_KEY back to null, so the completion frame gets
  // no key for such a run. Busting the card on the literal string would put it
  // on a URL the probe never requests. Running only `key()` and not
  // `promptIdOf()` is exactly that half-mirror, so it is pinned.
  //
  // Not reachable from a current ComfyUI (prompt ids are UUIDs); pinned because
  // the call site claims to mirror the tracker, and a claim that is only true
  // for the inputs someone thought of is how this fix went wrong the first time.
  const { onExecuted, painted } = productionOnExecuted();
  onExecuted({ detail: { prompt_id: NO_PROMPT_KEY, output: { images: [SAME_FILE] } } });

  assert.equal(painted.length, 1);
  assert.equal(promptIdOf(key(NO_PROMPT_KEY)), null, "the tracker maps it to null");
  assert.equal(
    painted[0].url,
    rawViewUrl(SAME_FILE),
    "the card must not carry a key the completion probes will never use",
  );
});

test("#1834: an id-less run is left UNBUSTED rather than given a local key", () => {
  // This looks like the fix declining to do its job, and pinning it is the
  // point. An id-less run (#224 — legacy; a current ComfyUI `executed` always
  // carries a prompt id) could be busted here with a minted key, and it would
  // be WRONG: `buildStillsSegment` mints independently, so the card and the
  // completion note's size/dimensions would address different URLs and could
  // describe different bytes. That is #1718's "metadata right, picture wrong"
  // reintroduced by the fix for its sibling.
  //
  // So the guard is: never bust one of the two surfaces without the other.
  // Closing the id-less gap for real needs a per-run identity threaded through
  // the completion tracker, which a caller cannot fake locally.
  const { onExecuted, painted } = productionOnExecuted();
  onExecuted({ detail: { output: { images: [SAME_FILE] } } });

  assert.equal(painted.length, 1);
  assert.doesNotMatch(
    painted[0].url,
    /[?&]cmcp_prompt=/,
    "no run identity means no key — not a locally invented one",
  );
  // The invariant that actually matters: whatever the card is painted from,
  // the frame's probe computes the SAME string for the same run.
  assert.equal(
    painted[0].url,
    appendImageCacheBust(painted[0].url, undefined),
    "card and probe must agree on the id-less path too",
  );
});

// ── the other surface that paints an inline image card ─────────────────────
//
// `panel_show_media` reaches the SAME chat card through its own composer, and
// its video branch already carries the #1718 bust on the adjacent line. Stills
// were the half left unguarded, so the reported symptom is reproducible there
// too: show a filename, let the file be rewritten, show it again.

function showMediaHarness() {
  const paintedImages = [];
  const probed = [];
  return {
    paintedImages,
    probed,
    deps: {
      paintImage: (url, caption) => paintedImages.push({ url, caption }),
      paintVideo: () => {},
      paintAudio: () => {},
      paintFileLink: () => {},
      imageViewUrl: (ref) =>
        `/view?filename=${ref.filename}&subfolder=${ref.subfolder ?? ""}&type=${ref.type ?? "output"}`,
      coerceMessageText: (v) => (typeof v === "string" ? v : v == null ? "" : String(v)),
      humanizeBytes: () => null,
      fetchMediaBytes: async () => null,
      probeMedia: (url) => {
        probed.push(url);
        return { ok: true };
      },
      warn: () => {},
      setTimer: (fn, ms) => ({ fn, ms }),
      clearTimer: () => {},
    },
  };
}

const IMAGE_REF = {
  kind: "viewRef",
  viewRef: { filename: "test_face_00005_.png", subfolder: "", type: "output" },
  filename: "test_face_00005_.png",
};

test("#1834: show_media re-showing one filename paints two distinct URLs", async () => {
  const first = showMediaHarness();
  const second = showMediaHarness();
  await composeShowMediaReply([IMAGE_REF], first.deps);
  await composeShowMediaReply([IMAGE_REF], second.deps);

  assert.equal(first.paintedImages.length, 1);
  assert.equal(second.paintedImages.length, 1);
  assert.match(first.paintedImages[0].url, /[?&]cmcp_prompt=/);
  assert.notEqual(
    first.paintedImages[0].url,
    second.paintedImages[0].url,
    "a rewritten file must not be re-shown from the browser's cache",
  );
  assert.match(first.paintedImages[0].url, /[?&]filename=test_face_00005_\.png(?:&|$)/);
});

test("#1834: show_media probes the SAME url it paints", async () => {
  // The probe decides whether the card is claimed as shown. Probing an unbusted
  // URL while painting a busted one would answer for a different request than
  // the card makes — the video branch busts before its probe for the same
  // reason.
  const h = showMediaHarness();
  await composeShowMediaReply([IMAGE_REF], h.deps);
  assert.equal(h.probed.length, 1);
  assert.equal(h.probed[0], h.paintedImages[0].url);
});

test("#1834: an inline data URL is left alone — its bytes are already here", async () => {
  const h = showMediaHarness();
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  await composeShowMediaReply(
    [{ kind: "dataUrl", dataUrl, filename: "inline.png" }],
    h.deps,
  );
  assert.equal(h.paintedImages.length, 1);
  assert.equal(
    h.paintedImages[0].url,
    dataUrl,
    "a data URL carries no cache identity to bust and must not be rewritten",
  );
});

test("#1834: appendImageCacheBust preserves a fragment and existing query", () => {
  assert.equal(
    appendImageCacheBust("/view?filename=a.png#frag", "p1"),
    "/view?filename=a.png&cmcp_prompt=p1#frag",
  );
  assert.equal(appendImageCacheBust("/view", "p1"), "/view?cmcp_prompt=p1");
  assert.equal(appendImageCacheBust("/view?", "p1"), "/view?cmcp_prompt=p1");
  assert.equal(
    appendImageCacheBust("/view?filename=a b.png", "p 1"),
    "/view?filename=a b.png&cmcp_prompt=p%201",
  );
  // A non-string / empty URL is handed straight back rather than becoming "?…".
  assert.equal(appendImageCacheBust("", "p1"), "");
  assert.equal(appendImageCacheBust(null, "p1"), null);
  // Strict on the KEY as well — see the id-less test above. A missing key must
  // not become a minted one, or the two surfaces stop agreeing.
  assert.equal(appendImageCacheBust("/view?filename=a.png"), "/view?filename=a.png");
  assert.equal(appendImageCacheBust("/view?filename=a.png", ""), "/view?filename=a.png");
  assert.equal(appendImageCacheBust("/view?filename=a.png", 7), "/view?filename=a.png");
});
