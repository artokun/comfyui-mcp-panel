/**
 * #648 — panel_show_media must never leave the caller at a dead end, and must
 * never let a sampled preview be mistaken for the media.
 *
 * These tests are about the REPLY TEXT, not about whether a blob was produced.
 * "A preview was returned" passes whether or not the reply discloses that it is
 * sampled — and the disclosure is the entire point, so every preview case here
 * asserts the disclosure and every failure case asserts a named next step.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  composeShowMediaReply,
  dataUrlByteLength,
  isVideoShowMediaItem,
  MEDIA_PREVIEW_TIMEOUT_MS,
  MEDIA_SIZE_PROBE_TIMEOUT_MS,
} from "../../web/js/lib/media-preview.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";

// ── harness ────────────────────────────────────────────────────────────────

/** The panel's own humanizeBytes, mirrored so the sizes in a note are real. */
function humanizeBytes(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let v = n;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(1)} ${u[i]}`;
}

function harness(over = {}) {
  const calls = {
    paintedImages: [],
    paintedVideos: [],
    storyboardsFor: [],
    uploads: [],
    warnings: [],
  };
  const timers = [];
  const deps = {
    paintImage: (url, caption) => calls.paintedImages.push({ url, caption }),
    paintVideo: (url, caption) => calls.paintedVideos.push({ url, caption }),
    imageViewUrl: (ref) =>
      `/view?filename=${ref.filename}&subfolder=${ref.subfolder ?? ""}&type=${ref.type ?? "output"}`,
    coerceMessageText: (v) => (typeof v === "string" ? v : v == null ? "" : String(v)),
    // The real builder returns a PNG Blob carrying `paintedFrames` — the number
    // of cells it actually drew into, which is NOT the grid capacity.
    buildVideoStoryboard: async (url) => {
      calls.storyboardsFor.push(url);
      return { size: 4096, paintedFrames: 20 };
    },
    uploadBlobToInput: async (blob, name, opts) => {
      calls.uploads.push({ blob, name, opts });
      return { filename: name, subfolder: "", type: opts?.type ?? "input" };
    },
    storyboardFrameCount: () => 20,
    humanizeBytes,
    fetchMediaBytes: async () => null,
    videoStoryboardEnabled: true,
    warn: (...a) => calls.warnings.push(a.map(String).join(" ")),
    // Deterministic timers: nothing fires unless a test fires it.
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
    ...over,
  };
  return {
    deps,
    calls,
    timers,
    /**
     * Let every already-resolvable step settle, then fire the still-armed timers
     * whose bound is `ms` — i.e. "that particular wall clock elapsed, and only
     * for the steps that had not finished". Draining first is what makes the
     * assertion meaningful: a healthy step's timer is cleared by then, so firing
     * cannot be mistaken for having caused its degradation.
     */
    async elapse(ms) {
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
      for (const t of timers) if (!t.cleared && t.ms === ms) t.fn();
    },
  };
}

const VIDEO_REF = {
  kind: "viewRef",
  viewRef: { filename: "reference_clip.mp4", subfolder: "", type: "input" },
  filename: "reference_clip.mp4",
  caption: "the reference",
};

// 72.1 MB — the size in the report.
const OVERSIZED_BYTES = 75_600_000;

// ── the sampled-preview disclosure ─────────────────────────────────────────

test("an oversized local video yields a preview AND says it is a sample, not the video (#648)", async () => {
  const h = harness({ fetchMediaBytes: async () => OVERSIZED_BYTES });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);

  // It got somewhere: a sheet exists and is reachable.
  assert.equal(reply.previews.length, 1);
  assert.equal(reply.previews[0].frames, 20);
  assert.equal(reply.previews[0].sourceBytes, OVERSIZED_BYTES);
  assert.equal(reply.previews[0].type, "temp", "the sheet must land in ComfyUI's swept temp/");
  assert.equal(h.calls.uploads.length, 1);
  assert.equal(h.calls.uploads[0].opts.type, "temp");

  // …and the reply cannot be read as "you have seen the video".
  assert.match(reply.note, /NOT shown this video/);
  assert.match(reply.note, /SAMPLED PREVIEW/);
  assert.match(reply.note, /20-frame contact sheet/);
  assert.match(reply.note, /evenly-spaced SAMPLES/);
  assert.match(
    reply.note,
    /do not describe the video as 20 frames long/,
    "the frame count must be disarmed explicitly — this is the fabrication the disclosure exists to stop",
  );
  // The source size, in the note, in human units.
  assert.match(reply.note, /72\.1 MB/);
  // A next step that actually shows the agent the sheet.
  assert.match(reply.note, /call get_image with filename "storyboard_reference_clip\.png", type "temp"/);
});

test("the batch headline states the agent was not sent the files at all", async () => {
  const h = harness();
  const reply = await composeShowMediaReply(
    [{ kind: "image", dataUrl: "data:image/png;base64,AAAA", filename: "a.png" }],
    h.deps,
  );
  assert.match(reply.note, /displayed to the USER/);
  assert.match(reply.note, /You were NOT sent this file/);
});

// ── under-cap / non-video: behaviour unchanged ─────────────────────────────

test("an image-only call paints exactly as before and claims no sampled preview", async () => {
  const h = harness();
  const reply = await composeShowMediaReply(
    [
      { kind: "image", dataUrl: "data:image/png;base64,AAAA", filename: "a.png", caption: "A" },
      {
        kind: "viewRef",
        viewRef: { filename: "b.png", subfolder: "sub", type: "output" },
        filename: "b.png",
      },
    ],
    h.deps,
  );

  assert.equal(h.calls.paintedImages.length, 2);
  assert.equal(h.calls.paintedVideos.length, 0);
  assert.equal(h.calls.storyboardsFor.length, 0, "no video ⇒ no sampling work at all");
  assert.equal(reply.previews.length, 0);
  assert.equal(reply.ok, true);
  assert.equal(reply.count, 2);
  assert.equal(reply.painted, 2);
  assert.doesNotMatch(reply.note, /SAMPLED PREVIEW/);
  assert.doesNotMatch(reply.note, /contact sheet/);
});

test("an inlined (under-cap) video is still disclosed as sampled, with its exact size", async () => {
  // 6 base64 chars, no padding → 4 bytes of payload. Size is COMPUTED, not probed.
  const dataUrl = `data:video/mp4;base64,${"A".repeat(1400)}`;
  const h = harness({
    fetchMediaBytes: async () => {
      throw new Error("a data URL must never be probed over the network");
    },
  });
  const reply = await composeShowMediaReply(
    [{ kind: "video", dataUrl, filename: "small.mp4" }],
    h.deps,
  );
  assert.equal(h.calls.paintedVideos.length, 1);
  assert.equal(reply.previews.length, 1);
  assert.equal(reply.previews[0].sourceBytes, dataUrlByteLength(dataUrl));
  assert.match(reply.note, /NOT shown this video/);
  assert.match(reply.note, new RegExp(humanizeBytes(dataUrlByteLength(dataUrl)).replace(".", "\\.")));
});

// ── "could not determine X" is not "determined X is not the case" ──────────

test("a source size that cannot be read is reported UNKNOWN — not omitted, not guessed", async () => {
  const h = harness({ fetchMediaBytes: async () => null });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);

  assert.equal(reply.previews.length, 1, "an unreadable size must not cost the preview");
  assert.equal(reply.previews[0].sourceBytes, null);
  assert.match(reply.note, /size UNKNOWN/);
  assert.match(reply.note, /not the same as knowing it is small/);
  assert.doesNotMatch(reply.note, /\d+(\.\d+)? (B|KB|MB|GB|TB)\b/, "no size may be stated");
});

test("a size probe that THROWS is also UNKNOWN, and still yields a preview", async () => {
  const h = harness({
    fetchMediaBytes: async () => {
      throw new Error("HEAD blew up");
    },
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews.length, 1);
  assert.match(reply.note, /size UNKNOWN/);
});

test("a size probe that never settles is bounded and degrades to UNKNOWN", async () => {
  const h = harness({ fetchMediaBytes: () => new Promise(() => {}) });
  const p = composeShowMediaReply([VIDEO_REF], h.deps);
  await h.elapse(MEDIA_SIZE_PROBE_TIMEOUT_MS);
  const reply = await p;
  assert.equal(reply.previews.length, 1, "a hung HEAD must not cost the preview");
  assert.match(reply.note, /size UNKNOWN/);
});

// ── bounded, and honest about having degraded ──────────────────────────────

test("a storyboard step that never settles is bounded, degrades, and names a next step", async () => {
  const h = harness({
    buildVideoStoryboard: () => new Promise(() => {}),
    fetchMediaBytes: async () => OVERSIZED_BYTES,
  });
  const p = composeShowMediaReply([VIDEO_REF], h.deps);
  await h.elapse(MEDIA_PREVIEW_TIMEOUT_MS);
  const reply = await p;

  assert.equal(reply.previews.length, 0);
  assert.match(reply.note, /NOT shown this video/);
  assert.match(reply.note, /no sampled preview could be built/);
  assert.match(
    reply.note,
    new RegExp(`took longer than ${Math.round(MEDIA_PREVIEW_TIMEOUT_MS / 1000)}s`),
    "the reply must say the bound fired, not merely that nothing happened",
  );
  // Still actionable: the file itself, plus the human who can see it.
  assert.match(reply.note, /call get_image with filename "reference_clip\.mp4", type "input"/);
  assert.match(reply.note, /Ask the user how it looks/);
  // …and the size it DID manage to read is still reported.
  assert.match(reply.note, /72\.1 MB/);
  // The user still got the player.
  assert.equal(h.calls.paintedVideos.length, 1);
});

test("a video the browser cannot decode degrades with a reason and a remedy", async () => {
  const h = harness({ buildVideoStoryboard: async () => null });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews.length, 0);
  assert.match(reply.note, /could not be decoded or seeked/);
  assert.match(reply.note, /call get_image with filename "reference_clip\.mp4"/);
});

test("a failed sheet upload degrades with a reason and a remedy", async () => {
  const h = harness({ uploadBlobToInput: async () => null });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews.length, 0);
  assert.match(reply.note, /could not be uploaded to ComfyUI/);
  assert.match(reply.note, /call get_image with filename "reference_clip\.mp4"/);
});

test("a sheet whose SAMPLE count is unknown is NOT offered as an N-frame sample", async () => {
  // A sheet exists, but the builder did not say how many cells it drew into.
  // Quoting the grid capacity instead would invent observations from blank
  // cells, so the preview is withheld rather than described vaguely.
  const h = harness({ buildVideoStoryboard: async () => ({ size: 1 }) });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews.length, 0);
  assert.match(reply.note, /could not say how many frames it actually sampled/);
  assert.doesNotMatch(reply.note, /SAMPLED PREVIEW/);
  assert.doesNotMatch(reply.note, /20/, "the grid capacity must never stand in for the sample count");
});

test("a PARTIALLY sampled sheet reports what was sampled, not the grid capacity", async () => {
  // 20 cells, 3 seeks succeeded. Describing this as "20 evenly-spaced samples"
  // is a fabricated observation about 17 blank cells.
  const h = harness({ buildVideoStoryboard: async () => ({ size: 1, paintedFrames: 3 }) });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews.length, 1);
  assert.equal(reply.previews[0].frames, 3);
  assert.equal(reply.previews[0].cells, 20);
  assert.match(reply.note, /contact sheet of 20 cells, 3 of which hold a sampled frame/);
  assert.match(reply.note, /the other 17 could not be seeked and are blank/);
  assert.match(reply.note, /do not describe the video as 3 frames long/);
  assert.doesNotMatch(reply.note, /a 20-frame contact sheet/);
});

test("an unknown grid capacity still allows an honest N-sample description", async () => {
  const h = harness({ storyboardFrameCount: () => 0 });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews.length, 1);
  assert.equal(reply.previews[0].frames, 20);
  assert.equal(reply.previews[0].cells, null);
  assert.match(reply.note, /a 20-frame contact sheet/);
});

test("a storyboard pipeline that THROWS degrades instead of failing the reply", async () => {
  const h = harness({
    buildVideoStoryboard: async () => {
      throw new Error("decoder exploded");
    },
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.ok, true);
  assert.equal(reply.previews.length, 0);
  assert.match(reply.note, /sampling pipeline failed/);
  assert.match(reply.note, /Ask the user how it looks/);
});

test("storyboard previews turned off is stated as the reason, not silently skipped", async () => {
  const h = harness({ videoStoryboardEnabled: false });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(h.calls.storyboardsFor.length, 0);
  assert.match(reply.note, /turned off in the panel's settings/);
  assert.match(reply.note, /call get_image with filename "reference_clip\.mp4"/);
});

// ── one item's failure must not eat the batch ──────────────────────────────

test("one painter throwing costs that item only, and the reply says so", async () => {
  const h = harness();
  const boom = h.deps.paintImage;
  let n = 0;
  h.deps.paintImage = (url, caption) => {
    n += 1;
    if (n === 1) throw new Error("DOM exploded");
    return boom(url, caption);
  };
  const reply = await composeShowMediaReply(
    [
      { kind: "image", dataUrl: "data:image/png;base64,AAAA", filename: "bad.png" },
      { kind: "image", dataUrl: "data:image/png;base64,BBBB", filename: "good.png" },
    ],
    h.deps,
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.painted, 1);
  assert.equal(reply.count, 2);
  assert.match(reply.note, /1 of the 2 requested item\(s\) could not be rendered at all/);
});

test("a throwing text coercer does not cost the agent its reply", async () => {
  // The trivial helpers are operations that can fail too. A throwing coercer
  // used to reject before anything was composed — a transport error instead of
  // a reply is exactly the dead end this module removes.
  const h = harness({
    coerceMessageText: () => {
      throw new Error("coercion exploded");
    },
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.ok, true);
  assert.match(reply.note, /You were NOT sent/);
});

test("a throwing logger does not become the failure it was logging", async () => {
  const h = harness({
    warn: () => {
      throw new Error("logger exploded");
    },
    buildVideoStoryboard: async () => null,
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.ok, true);
  assert.match(reply.note, /could not be decoded or seeked/);
});

test("a painter that settles LATER is reported unconfirmed, not counted as shown", async () => {
  // A promise-returning painter cannot be confirmed from here, and its rejection
  // must not surface as an unhandled rejection either.
  const h = harness({ paintImage: () => Promise.reject(new Error("late failure")) });
  const reply = await composeShowMediaReply(
    [{ kind: "image", dataUrl: "data:image/png;base64,AAAA", filename: "a.png" }],
    h.deps,
  );
  assert.equal(reply.painted, 0, "an unconfirmed paint is not a paint");
  assert.equal(reply.unconfirmed, 1);
  assert.match(reply.note, /whether the user can see it is UNKNOWN/);
  await new Promise((r) => setImmediate(r));
});

test("the STORYBOARD SHEET's painter is guarded exactly like the batch pass's", async () => {
  // A second, hand-rolled painter call is how this one ended up unguarded: it
  // could reject after the fact, producing an unhandled rejection and a reply
  // that quietly implied the user could see the sheet.
  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const h = harness({ paintImage: () => Promise.reject(new Error("sheet DOM failure")) });
    const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
    assert.equal(reply.previews.length, 1, "the agent's own copy is unaffected");
    assert.match(reply.note, /could not be confirmed as shown/);
    assert.match(reply.note, /Your own copy, below, is unaffected/);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(rejections, [], "a deferred painter must not surface as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a sheet painter that THROWS is disclosed and still leaves the agent its copy", async () => {
  const h = harness({
    paintImage: () => {
      throw new Error("DOM exploded");
    },
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews.length, 1);
  assert.match(reply.note, /could not be shown\s+in the chat/);
  assert.match(reply.note, /call get_image with filename "storyboard_reference_clip\.png"/);
});

test("a sheet that IS painted carries no visibility caveat", async () => {
  const h = harness({ fetchMediaBytes: async () => OVERSIZED_BYTES });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.doesNotMatch(reply.note, /could not be (shown|confirmed as shown)/);
});

test("two videos are previewed independently — one wedged does not suppress the other", async () => {
  const second = { ...VIDEO_REF, viewRef: { ...VIDEO_REF.viewRef, filename: "other.mp4" } };
  const h = harness({
    buildVideoStoryboard: async (url) =>
      url.includes("other") ? { size: 1, paintedFrames: 20 } : new Promise(() => {}),
  });
  const p = composeShowMediaReply([VIDEO_REF, second], h.deps);
  await h.elapse(MEDIA_PREVIEW_TIMEOUT_MS);
  const reply = await p;
  assert.equal(reply.previews.length, 1);
  assert.equal(reply.previews[0].of, "other.mp4");
  assert.match(reply.note, /reference_clip\.mp4 — you were NOT shown this video, and no sampled preview/);
  assert.match(reply.note, /other\.mp4 — you were NOT shown this video\. What exists for you is a SAMPLED PREVIEW/);
});

test("an item with no usable source is reported unrendered, not counted as shown", async () => {
  const h = harness();
  const reply = await composeShowMediaReply([{ kind: "image", filename: "nothing.png" }], h.deps);
  assert.equal(reply.painted, 0);
  assert.equal(h.calls.paintedImages.length, 0);
  assert.match(reply.note, /1 of the 1 requested item\(s\) could not be rendered at all/);
});

// ── classification + byte accounting ───────────────────────────────────────

test("video classification does not treat an arbitrary character as a dot", () => {
  const ref = (filename) => ({ kind: "viewRef", viewRef: { filename } });
  assert.equal(isVideoShowMediaItem(ref("clip.mp4")), true);
  assert.equal(isVideoShowMediaItem(ref("clip.MP4")), true);
  assert.equal(isVideoShowMediaItem(ref("clip.mov")), true);
  assert.equal(isVideoShowMediaItem(ref("sheet.png")), false);
  assert.equal(
    isVideoShowMediaItem(ref("xmp4")),
    false,
    "the old test used an unescaped dot, so this was painted as a video",
  );
  assert.equal(isVideoShowMediaItem({ kind: "video", dataUrl: "data:video/mp4;base64,AA==" }), true);
  assert.equal(isVideoShowMediaItem(null), false);
});

test("dataUrlByteLength reads the payload exactly, and refuses to guess otherwise", () => {
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AAAA"), 3);
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AAA="), 2);
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AA=="), 1);
  assert.equal(dataUrlByteLength("data:video/mp4;base64,"), 0);
  assert.equal(dataUrlByteLength("/view?filename=a.mp4"), null, "not a data URL ⇒ unknown");
  assert.equal(dataUrlByteLength("data:video/mp4,raw"), null, "not base64 ⇒ unknown");
  assert.equal(dataUrlByteLength(null), null);
  // UNPADDED bodies are legal in a data URL and the browser decodes them, so
  // calling them unknown would be its own dishonesty in the other direction.
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AAA"), 2);
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AA"), 1);
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AAAAAA"), 4);
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AAAAA"), null, "trailing 1-char group");
  // Cross-check the whole table against a real base64 decoder.
  for (const body of ["AAAA", "AAA=", "AA==", "AAA", "AA", "AAAAAA"]) {
    assert.equal(
      dataUrlByteLength(`data:video/mp4;base64,${body}`),
      Buffer.from(body, "base64").length,
      `payload "${body}" must measure what it actually decodes to`,
    );
  }
  // MALFORMED payloads must be unknown, not measured. The arithmetic is happy
  // to measure nonsense, and a measured nonsense payload told the agent the
  // source video was a few bytes — an invented size.
  assert.equal(dataUrlByteLength("data:video/mp4;base64,A"), null, "1 char encodes nothing");
  assert.equal(dataUrlByteLength("data:video/mp4;base64,!!!!"), null, "not the base64 alphabet");
  assert.equal(dataUrlByteLength("data:video/mp4;base64,A==="), null, "3 pad chars is not base64");
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AA=A"), null, "padding is trailing-only");
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AAAA="), null, "padding must complete a group");
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AAAA=="), null, "a full group needs no padding");
  assert.equal(dataUrlByteLength("data:video/mp4;base64,ab-_"), null, "base64url is not decoded here");
});

test("a video whose inline payload is malformed reports its size UNKNOWN, never a tiny one", async () => {
  const h = harness();
  const reply = await composeShowMediaReply(
    [{ kind: "video", dataUrl: "data:video/mp4;base64,!!!!", filename: "broken.mp4" }],
    h.deps,
  );
  assert.match(reply.note, /size UNKNOWN/);
  assert.doesNotMatch(reply.note, /source file \d/, "a size that could not be read must not be stated");
  assert.equal(reply.previews[0].sourceBytes, null);
});

// ── the SHIPPED panel is actually wired to this module ─────────────────────
//
// Everything above tests a module the panel could simply stop calling. Deleting
// the wiring in comfyui-mcp-panel.js would leave every assertion in this file
// green while the shipped panel went back to answering {ok:true,count:N} — so
// the wiring is asserted against the real source, the way manager-install.test
// already does for the install runtime.

const panelSource = () =>
  readFileSync(fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");

test("the show_media dispatcher answers with the handler's reply, not a fixed acknowledgement", () => {
  const src = panelSource();
  assert.match(
    src,
    /import \{ composeShowMediaReply \} from "\.\/lib\/media-preview\.js";/,
    "the panel must import the reply composer",
  );
  const i = src.indexOf('msg.cmd === "show_media"');
  assert.ok(i > 0, "could not locate the show_media dispatcher branch");
  const branch = src.slice(i, i + 1600);
  assert.match(
    branch,
    /result = \(await onShowMedia\?\.\(mediaItems\)\)/,
    "the reply must be AWAITED from the handler — a preview is real work",
  );
});

test("the panel's storyboard builder carries the count it ACTUALLY drew", () => {
  // Without this, media-preview has only the grid capacity to go on and every
  // partially-sampled sheet is described as a full one — 19 blank cells
  // presented to the agent as 19 observations.
  const src = panelSource();
  const i = src.indexOf("async function buildVideoStoryboard(");
  assert.ok(i > 0, "could not locate buildVideoStoryboard");
  const fn = src.slice(i, i + 4000);
  assert.match(fn, /blob\.paintedFrames = painted;/);
  assert.match(fn, /if \(!blob\) return null;/);
});

test("onShowMedia routes through composeShowMediaReply with the storyboard pipeline wired", () => {
  const src = panelSource();
  const handler = src.match(/onShowMedia\(items\) \{[\s\S]*?\n {4}\},/);
  assert.ok(handler, "could not locate the onShowMedia handler");
  assert.match(handler[0], /return composeShowMediaReply\(items, \{/);
  for (const dep of [
    "paintImage",
    "paintVideo",
    "imageViewUrl",
    "buildVideoStoryboard",
    "uploadBlobToInput",
    "storyboardFrameCount",
    "humanizeBytes",
    "fetchMediaBytes: fetchImageBytes",
    "videoStoryboardEnabled",
  ]) {
    assert.ok(handler[0].includes(dep), `onShowMedia must pass ${dep} through`);
  }
  assert.doesNotMatch(
    handler[0],
    /paintVideo\(url, caption\)/,
    "the handler must not keep its own painting loop — that is the drift this fix removes",
  );
});

// ── the shared bound is itself a guard that can fail ───────────────────────

test("withTimeout resolves the value when the bounded step wins", async () => {
  const timers = [];
  const v = await withTimeout(Promise.resolve("ok"), 1000, () => "late", {
    setTimer: (fn) => {
      const t = { fn, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      t.cleared = true;
    },
  });
  assert.equal(v, "ok");
  assert.equal(timers[0].cleared, true, "the timer must be cleared on settle so it cannot leak");
});

test("withTimeout falls back when the bounded step REJECTS", async () => {
  const v = await withTimeout(Promise.reject(new Error("nope")), 1000, () => "fallback", {
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  assert.equal(v, "fallback");
});

test("withTimeout still settles when onTimeout THROWS — a guard that wedges is not a guard", async () => {
  let fire;
  const p = withTimeout(
    new Promise(() => {}),
    1000,
    () => {
      throw new Error("the fallback itself failed");
    },
    {
      setTimer: (fn) => {
        fire = fn;
        return {};
      },
      clearTimer: () => {},
    },
  );
  fire();
  assert.equal(await p, undefined);
});

test("withTimeout still settles when clearTimer THROWS", async () => {
  const v = await withTimeout(Promise.resolve("ok"), 1000, () => "late", {
    setTimer: () => ({}),
    clearTimer: () => {
      throw new Error("clear blew up");
    },
  });
  assert.equal(v, "ok");
});

test("withTimeout still settles when setTimer THROWS", async () => {
  const v = await withTimeout(Promise.resolve("ok"), 1000, () => "late", {
    setTimer: () => {
      throw new Error("no timers available");
    },
    clearTimer: () => {},
  });
  assert.equal(v, "ok");
});

test("a THROWING setTimer must not silently REMOVE the bound", async () => {
  // Falling through to "unbounded" turns "bounded, degrades" into "pending
  // forever" — the one outcome this helper exists to prevent. It falls back to
  // the platform timer instead, so a never-settling step still degrades.
  const v = await withTimeout(new Promise(() => {}), 5, () => "fallback", {
    setTimer: () => {
      throw new Error("no timers available");
    },
    clearTimer: () => {},
  });
  assert.equal(v, "fallback");
});

test("withTimeout with a non-positive bound is a passthrough", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 0, () => 8, {}), 7);
});

test("a late fulfilment after the bound fired does not overwrite the fallback", async () => {
  let fire;
  let settle;
  const p = withTimeout(
    new Promise((res) => {
      settle = res;
    }),
    1000,
    () => "fallback",
    {
      setTimer: (fn) => {
        fire = fn;
        return {};
      },
      clearTimer: () => {},
    },
  );
  fire();
  settle("too late");
  assert.equal(await p, "fallback");
});
