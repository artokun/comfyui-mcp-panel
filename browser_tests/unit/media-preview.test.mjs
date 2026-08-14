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
  classifyShowMediaItem,
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
    paintedAudio: [],
    paintedLinks: [],
    storyboardsFor: [],
    uploads: [],
    warnings: [],
  };
  const timers = [];
  const deps = {
    paintImage: (url, caption) => calls.paintedImages.push({ url, caption }),
    paintVideo: (url, caption) => calls.paintedVideos.push({ url, caption }),
    paintAudio: (url, caption) => calls.paintedAudio.push({ url, caption }),
    paintFileLink: (url, caption) => calls.paintedLinks.push({ url, caption }),
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
  assert.match(reply.note, /ask the user how it looks/);
  // …and the size it DID manage to read is still reported.
  assert.match(reply.note, /72\.1 MB/);
  // The user still got the player.
  assert.equal(h.calls.paintedVideos.length, 1);
});

test("a sampler that returns nothing degrades with a remedy and NO invented cause", async () => {
  const h = harness({ buildVideoStoryboard: async () => null });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews.length, 0);
  assert.match(reply.note, /the sampler returned no contact sheet/);
  assert.match(reply.note, /the panel is not told which/);
  // The builder returns nothing for a metadata failure, an unusable frame, AND
  // a sheet that will not encode. Naming one of them is a diagnosis nothing made.
  assert.doesNotMatch(reply.note, /could not be seeked/);
  assert.doesNotMatch(reply.note, /not one of its frames/);
  assert.match(reply.note, /call get_image with filename "reference_clip\.mp4"/);
});

// comfyui-mcp#1493 — the builder knew which of its six failures it hit and threw
// that away, so the reply had to say "the panel is not told which". It can now
// hand back `{reason}`, and only then may the reply name a cause.
test("EVERY failure exit in the builder names itself — no bare `return null` survives", () => {
  // The consumer tests below all STUB buildVideoStoryboard, so none of them can
  // see the builder's own branches: mutation showed the duration branch could be
  // reverted to a bare `null` with the whole suite still green. The real builder
  // needs a DOM (video + canvas + seeking) that these node tests do not have, so
  // the honest instrument for "this function contains no unnamed exit" is the
  // source itself — bounded to the function body, not a fixed-size window that
  // silently stops covering what it checks.
  const body = functionBody("async function buildVideoStoryboard(");
  const bare = body.match(/return null\s*;/g) ?? [];
  assert.deepEqual(
    bare,
    [],
    `every failure exit must name its cause; found ${bare.length} bare \`return null\``,
  );
  // …and the named exits are actually there (a body that returns nothing at all
  // would trivially satisfy the assertion above).
  const named = body.match(/return storyboardFailure\(/g) ?? [];
  assert.ok(named.length >= 5, `expected the 5 failure branches to be named, saw ${named.length}`);
});

test("a NAMED sampler failure is passed through, not flattened to the generic note", async () => {
  const h = harness({
    buildVideoStoryboard: async () => ({
      reason: "the browser reported no usable duration for it (its codec may not be decodable here — VP9/AV1 .webm is the usual case)",
    }),
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);

  assert.equal(reply.previews.length, 0);
  assert.match(reply.note, /no usable duration/);
  assert.match(reply.note, /VP9\/AV1/);
  // The generic "not told which" line must be GONE — we were told which.
  assert.doesNotMatch(reply.note, /the panel is not told which/);
  // Still actionable, and the user still got the player.
  assert.match(reply.note, /call get_image with filename "reference_clip\.mp4"/);
  assert.equal(h.calls.paintedVideos.length, 1);
});

test("a named failure is never uploaded as if it were a sheet", async () => {
  // `{reason}` is TRUTHY. A consumer that only checked `if (!blob)` would sail
  // past it and hand the explanation to uploadBlobToInput as a PNG.
  const h = harness({ buildVideoStoryboard: async () => ({ reason: "no usable duration" }) });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);

  assert.equal(h.calls.uploads.length, 0, "an explanation must never be uploaded");
  assert.equal(reply.previews.length, 0);
});

test("a builder that returns a bare null STILL invents no cause", async () => {
  // The rule the pre-existing test holds, restated against the new code path: a
  // sampler that reports nothing tells us nothing, and naming a cause for it
  // would be a diagnosis nothing made. Only a SUPPLIED reason is repeated.
  const h = harness({ buildVideoStoryboard: async () => null });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);

  assert.match(reply.note, /the panel is not told which/);
  assert.doesNotMatch(reply.note, /could not be seeked/);
  assert.doesNotMatch(reply.note, /VP9/);
});

test("nothing that is not sheet-shaped is ever uploaded", async () => {
  // Success is recognised POSITIVELY (a numeric `size`, which is what a Blob has
  // and what the doubles model). Two earlier versions inferred FAILURE instead
  // and both leaked: keying on the reason's type uploaded `{reason:{…}}`, and
  // keying on its presence uploaded every other truthy value (review finding).
  for (const shape of [[], {}, "a string", 42, true, { paintedFrames: 3 }]) {
    const h = harness({ buildVideoStoryboard: async () => shape });
    const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
    assert.equal(
      h.calls.uploads.length,
      0,
      `a ${JSON.stringify(shape)} must not reach uploadBlobToInput`,
    );
    assert.equal(reply.previews.length, 0);
    assert.match(reply.note, /no sampled preview could be built/);
  }
});

test("a sheet-shaped result that ALSO carries a reason is read as the failure", async () => {
  // The ambiguous shape the code comments call out. It is not one the builder
  // produces, so the question is only which way to be wrong: preferring the
  // explanation over silently uploading something that announced its own
  // failure. Documented behaviour deserves a test — mutation showed that
  // dropping the guard changed nothing observable without one.
  const h = harness({
    buildVideoStoryboard: async () => ({ size: 4096, reason: "no usable duration" }),
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);

  assert.equal(h.calls.uploads.length, 0);
  assert.match(reply.note, /no usable duration/);
});

test("a sheet-shaped result is still uploaded — the positive check did not break success", async () => {
  // The other direction, and the one a stricter check is most likely to break.
  const h = harness({ buildVideoStoryboard: async () => ({ size: 4096, paintedFrames: 20 }) });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(h.calls.uploads.length, 1);
  assert.equal(reply.previews.length, 1);
});

test("a non-string reason is ignored rather than interpolated", async () => {
  // A malformed object must degrade to the generic note, not print
  // "[object Object]" at the agent — the serialization failure this repo keeps
  // rediscovering.
  const h = harness({ buildVideoStoryboard: async () => ({ reason: { nested: true } }) });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);

  assert.doesNotMatch(reply.note, /\[object Object\]/);
  assert.match(reply.note, /the panel is not told which/);
});

test("the 'ask the user' remedy is withheld when the user cannot see it either", async () => {
  // Telling the caller to ask a person who was never shown the video sends it
  // somewhere that does not work from where it is.
  const h = harness({
    paintVideo: () => {
      throw new Error("player exploded");
    },
    buildVideoStoryboard: async () => null,
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.match(reply.note, /The user cannot see it either/);
  assert.match(reply.note, /asking them how it looks will not help/);
  assert.doesNotMatch(reply.note, /they can answer for the parts you cannot/);
  // …and the reachable-file remedy is still offered.
  assert.match(reply.note, /call get_image with filename "reference_clip\.mp4"/);
});

test("an UNCONFIRMED player makes the 'ask the user' remedy conditional, not confident", async () => {
  const h = harness({
    paintVideo: () => Promise.resolve(),
    buildVideoStoryboard: async () => null,
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.match(reply.note, /Whether the user can see it in the chat is UNKNOWN/);
  assert.match(reply.note, /ask whether they can see it before asking them to describe it/);
});

test("a player that WAS put in the chat gets the confident remedy", async () => {
  const h = harness({ buildVideoStoryboard: async () => null });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.match(reply.note, /Its player is in the chat, so ask the user how it looks/);
});

test("a failed sheet upload degrades with a reason and a remedy", async () => {
  const h = harness({ uploadBlobToInput: async () => null });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews.length, 0);
  assert.match(reply.note, /could not be uploaded to ComfyUI/);
  assert.match(reply.note, /call get_image with filename "reference_clip\.mp4"/);
});

test("a truthy-but-UNRETRIEVABLE sheet ref is not announced as a preview", async () => {
  // uploadBlobToInput builds {filename: info.name, …}, so an /upload/image
  // response without `name` yields a truthy object with no filename. Announcing
  // a preview and telling the agent to fetch `filename ""` is a remedy that
  // cannot be followed — worse than saying the preview failed.
  for (const bad of [{}, { filename: "" }, { filename: "   " }, { filename: null }]) {
    const h = harness({ uploadBlobToInput: async () => bad });
    const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
    assert.equal(reply.previews.length, 0, `announced a preview for ${JSON.stringify(bad)}`);
    assert.match(reply.note, /came back with no filename/);
    assert.doesNotMatch(reply.note, /SAMPLED PREVIEW/);
    assert.doesNotMatch(reply.note, /filename ""/);
    // …and it still ends somewhere the caller can go.
    assert.match(reply.note, /call get_image with filename "reference_clip\.mp4"/);
  }
});

test("a URL builder that RETURNS nothing is the same failure as one that throws", async () => {
  // Keyed on the outcome, not on whether it threw: "carried neither inline data
  // nor a ComfyUI reference" is false when the reference is right there, and it
  // tells the caller to re-send something it already sent correctly.
  const h = harness({ imageViewUrl: () => null });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.match(reply.note, /could not build a view URL for its ComfyUI reference/);
  assert.doesNotMatch(reply.note, /carried neither inline data/);
  assert.match(reply.note, /call get_image with filename "reference_clip\.mp4", type "input"/);
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
  // The builder blanks a cell when the SEEK fails and when the DRAW fails after
  // a successful seek, and it does not distinguish them — so naming a cause
  // would hand the agent a diagnosis nothing observed.
  assert.match(reply.note, /the other 17 could not be captured and are blank/);
  assert.doesNotMatch(reply.note, /could not be seeked/);
  assert.match(reply.note, /do not describe the video as 3 frames long/);
  assert.doesNotMatch(reply.note, /a 20-frame contact sheet/);
  // The builder aims at even spacing but SKIPS unseekable positions, so the
  // three that survived may all sit near the start. Claiming coverage that was
  // not observed is the same fabrication one level down.
  assert.doesNotMatch(reply.note, /evenly-spaced SAMPLES across the video/);
  assert.match(reply.note, /may be CLUSTERED rather than spread/);
});

test("a COMPLETE sheet may claim even spacing; a partial one may not", async () => {
  const complete = harness({ storyboardFrameCount: () => 20 });
  const a = await composeShowMediaReply([VIDEO_REF], complete.deps);
  assert.match(a.note, /Those 20 frames are evenly-spaced SAMPLES across the video/);

  const partial = harness({ buildVideoStoryboard: async () => ({ size: 1, paintedFrames: 19 }) });
  const b = await composeShowMediaReply([VIDEO_REF], partial.deps);
  assert.doesNotMatch(b.note, /evenly-spaced SAMPLES across the video/);
});

test("an unknown grid capacity may not claim even spacing either", async () => {
  const h = harness({ storyboardFrameCount: () => 0 });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews[0].cells, null);
  assert.doesNotMatch(
    reply.note,
    /evenly-spaced SAMPLES across the video/,
    "with no plan size, nothing establishes that no positions were skipped",
  );
  assert.match(reply.note, /may be CLUSTERED rather than spread/);
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
  assert.match(reply.note, /ask the user how it looks/);
});

test("storyboard previews turned off is stated as the reason, not silently skipped", async () => {
  const h = harness({ videoStoryboardEnabled: false });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(h.calls.storyboardsFor.length, 0);
  assert.match(reply.note, /turned off in the panel's settings/);
  assert.match(reply.note, /call get_image with filename "reference_clip\.mp4"/);
});

// ── one item's failure must not eat the batch ──────────────────────────────

test("one painter throwing costs that item only, and the reply names the REAL reason", async () => {
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
  assert.match(reply.note, /1 of the 2 requested item\(s\) were NOT displayed/);
  assert.match(reply.note, /• bad\.png — the panel's own painter failed/);
  assert.doesNotMatch(
    reply.note,
    /no usable source/,
    "the file resolved fine — telling the caller to re-send it is a wrong remedy",
  );
  // "Re-sending will not help" is true and is NOT a next step. Every drop must
  // carry one, or the reply is a dead end with a better explanation.
  assert.match(reply.note, /ask them to reload the panel and try again/);
  assert.match(reply.note, /call get_image on it if you need to look at it/);
});

test("a non-video DROP with a ComfyUI ref is pointed at get_image, not just told to give up", async () => {
  const h = harness({
    paintImage: () => {
      throw new Error("DOM exploded");
    },
  });
  const reply = await composeShowMediaReply(
    [
      {
        kind: "viewRef",
        viewRef: { filename: "sheet.png", subfolder: "sub", type: "output" },
        filename: "sheet.png",
      },
    ],
    h.deps,
  );
  assert.match(reply.note, /• sheet\.png — the panel's own painter failed/);
  assert.match(
    reply.note,
    /call get_image with filename "sheet\.png", type "output", subfolder "sub" — it returns the image inline/,
  );
});

test("a viewRef whose URL cannot be built is handed the ref, not a dead end", async () => {
  // The reference is right there; get_image resolves it without the panel's URL
  // builder, which is the very step that failed.
  const h = harness({
    imageViewUrl: () => {
      throw new Error("apiURL exploded");
    },
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.match(reply.note, /could not build a view URL for its ComfyUI reference/);
  assert.match(reply.note, /The reference itself is intact/);
  assert.match(
    reply.note,
    /call get_image with filename "reference_clip\.mp4", type "input"/,
    "the URL-build failure must still name a next step — no preview job exists to carry one",
  );
});

test("EVERY drop carries a next step, whatever the cause", async () => {
  // The discrimination the reasons provide is worthless if one of the branches
  // still ends in "you cannot".
  const cases = [
    // no usable source
    { deps: {}, items: [{ kind: "image", filename: "nothing.png" }] },
    // URL build failed
    {
      deps: {
        imageViewUrl: () => {
          throw new Error("no url");
        },
      },
      items: [VIDEO_REF],
    },
    // painter failed, image with a ref
    {
      deps: {
        paintImage: () => {
          throw new Error("dom");
        },
      },
      items: [{ kind: "viewRef", viewRef: { filename: "a.png", type: "output" }, filename: "a.png" }],
    },
    // painter failed, inline image with no ref
    {
      deps: {
        paintImage: () => {
          throw new Error("dom");
        },
      },
      items: [{ kind: "image", dataUrl: "data:image/png;base64,AAAA", filename: "a.png" }],
    },
    // painter failed, video
    {
      deps: {
        paintVideo: () => {
          throw new Error("dom");
        },
      },
      items: [VIDEO_REF],
    },
  ];
  for (const c of cases) {
    const h = harness(c.deps);
    const reply = await composeShowMediaReply(c.items, h.deps);
    const line = reply.note.split("\n").find((l) => l.startsWith("• "));
    assert.ok(line, `no drop line for ${JSON.stringify(c.items[0].filename)}`);
    assert.match(
      line,
      /(call get_image|Re-send it as an absolute path|reload the panel|sampled-preview note below)/,
      `drop line names no next step: ${line}`,
    );
  }
});

test("a VIDEO whose player fails to paint still gets its sampled preview", async () => {
  // The storyboard needs the URL, not the chat player. Dropping the preview
  // because the DOM failed would deny the agent the only thing it can see.
  const h = harness({
    paintVideo: () => {
      throw new Error("video element exploded");
    },
    fetchMediaBytes: async () => OVERSIZED_BYTES,
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.equal(reply.previews.length, 1, "a painter failure must not cost the preview");
  assert.match(reply.note, /• reference_clip\.mp4 — the panel's own painter failed/);
  assert.doesNotMatch(reply.note, /no usable source/);
  assert.match(reply.note, /SAMPLED PREVIEW/);
  assert.match(reply.note, /72\.1 MB/);
});

test("a viewRef whose URL cannot be built says THAT, not 'no usable source'", async () => {
  const h = harness({
    imageViewUrl: () => {
      throw new Error("apiURL exploded");
    },
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.match(reply.note, /could not build a view URL for its ComfyUI reference/);
  assert.doesNotMatch(reply.note, /no usable source/);
});

test("a VIDEO drop points at its own sampled-preview note rather than repeating a remedy", async () => {
  const h = harness({
    paintVideo: () => {
      throw new Error("player exploded");
    },
  });
  const reply = await composeShowMediaReply([VIDEO_REF], h.deps);
  assert.match(reply.note, /see this video's sampled-preview note below/);
  assert.match(reply.note, /tell the user their player did not appear/);
  assert.match(reply.note, /SAMPLED PREVIEW/, "…and that note must actually be there");
});

test("a painter whose returned object has a THROWING then getter still yields a reply", async () => {
  // Merely READING `.then` is an operation that can fail. Doing it outside the
  // guard rejected the whole reply.
  const h = harness({
    paintImage: () => ({
      get then() {
        throw new Error("then getter threw");
      },
    }),
  });
  const reply = await composeShowMediaReply(
    [{ kind: "image", dataUrl: "data:image/png;base64,AAAA", filename: "a.png" }],
    h.deps,
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.unconfirmed, 1);
  assert.match(reply.note, /whether the user can see or hear it is UNKNOWN/);
});

test("a painter that returns a thenable whose then() THROWS still yields a reply", async () => {
  const h = harness({
    paintImage: () => ({
      then() {
        throw new Error("then threw");
      },
    }),
  });
  const reply = await composeShowMediaReply(
    [{ kind: "image", dataUrl: "data:image/png;base64,AAAA", filename: "a.png" }],
    h.deps,
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.painted, 0);
  assert.equal(reply.unconfirmed, 1);
  assert.match(reply.note, /whether the user can see or hear it is UNKNOWN/);
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
  assert.match(reply.note, /the sampler returned no contact sheet/);
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
  assert.match(reply.note, /whether the user can see or hear it is UNKNOWN/);
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
  assert.match(reply.note, /1 of the 1 requested item\(s\) were NOT displayed/);
  assert.match(reply.note, /• nothing\.png — no usable source/);
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
  // A query string or fragment on the filename must not demote a real video to
  // an image — that skips the storyboard AND the whole sampled-preview
  // disclosure, which is this module's entire job.
  assert.equal(isVideoShowMediaItem(ref("clip.mp4?download=1")), true);
  assert.equal(isVideoShowMediaItem(ref("clip.MP4?t=3")), true);
  assert.equal(isVideoShowMediaItem(ref("clip.webm#t=10")), true);
  assert.equal(isVideoShowMediaItem(ref("clip.mp4?a=1#b")), true);
  assert.equal(isVideoShowMediaItem(ref("sheet.png?v=2")), false);
  assert.equal(isVideoShowMediaItem(ref("xmp4?v=2")), false);
});

test("a video ref carrying a query string still gets a full sampled preview", async () => {
  const h = harness({ fetchMediaBytes: async () => OVERSIZED_BYTES });
  const reply = await composeShowMediaReply(
    [
      {
        kind: "viewRef",
        viewRef: { filename: "reference_clip.mp4?download=1", type: "input" },
        filename: "reference_clip.mp4?download=1",
      },
    ],
    h.deps,
  );
  assert.equal(h.calls.paintedVideos.length, 1, "it must be played, not painted as an image");
  assert.equal(reply.previews.length, 1);
  assert.match(reply.note, /SAMPLED PREVIEW/);
  assert.match(reply.note, /72\.1 MB/);
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
  // Only the five ASCII whitespace characters the decoder itself ignores may be
  // removed. Stripping JavaScript's \s scrubbed U+00A0 / U+2028 out of a payload
  // no browser will decode, and then reported a byte count for it.
  assert.equal(dataUrlByteLength("data:video/mp4;base64,AA ==\t\r\n"), 1, "ASCII whitespace is ignored");
  // Written as \u escapes on purpose: these characters are invisible, and a
  // reviewer has to be able to see WHICH codepoint each case is about.
  for (const cp of ["\u00A0", "\u2028", "\u2029", "\uFEFF", "\u3000", "\u000B", "\u2003"]) {
    const u = `U+${cp.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    assert.equal(
      dataUrlByteLength(`data:video/mp4;base64,AA==${cp}`),
      null,
      `${u} is not base64 and must not be scrubbed away`,
    );
    assert.equal(
      dataUrlByteLength(`data:video/mp4;base64,A${cp}A==`),
      null,
      `${u} is not base64 anywhere in the body either`,
    );
  }
});

test("a payload padded with non-ASCII whitespace reports UNKNOWN, not a byte count", async () => {
  const h = harness();
  const reply = await composeShowMediaReply(
    [{ kind: "video", dataUrl: "data:video/mp4;base64,AA==\u00A0", filename: "sneaky.mp4" }],
    h.deps,
  );
  assert.equal(reply.previews[0].sourceBytes, null);
  assert.match(reply.note, /size UNKNOWN/);
  assert.doesNotMatch(reply.note, /source file \d/);
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

// ── #710 — audio, and kinds the panel cannot present ───────────────────────
//
// The panel used to know exactly two media kinds. An AUDIO ref (a ComfyUI /view
// ref can name anything on disk) fell through to the image branch, so the user
// got a broken <img> icon — and the reply still said `painted:N, unconfirmed:0`,
// a full success. The agent then told the user to listen to something nobody
// could hear. Both halves are tested here: audio must PLAY, and anything the
// panel cannot present must never be counted as painted.

const AUDIO_REF = {
  kind: "viewRef",
  viewRef: { filename: "vo_sophie_00001.mp3", subfolder: "synlara", type: "output" },
  filename: "vo_sophie_00001.mp3",
  caption: "Sophie, line 1",
};

test("an audio ref is PLAYED, never painted as an image (#710)", async () => {
  const h = harness();
  const reply = await composeShowMediaReply([AUDIO_REF], h.deps);

  assert.equal(
    h.calls.paintedImages.length,
    0,
    "audio painted through the image branch is the broken-<img> icon the user saw",
  );
  assert.equal(h.calls.paintedVideos.length, 0);
  assert.equal(h.calls.paintedAudio.length, 1, "audio must reach the audio painter");
  assert.match(h.calls.paintedAudio[0].url, /filename=vo_sophie_00001\.mp3/);
  assert.equal(h.calls.paintedAudio[0].caption, "Sophie, line 1");
  assert.equal(h.calls.storyboardsFor.length, 0, "audio has no frames to sample");
  assert.equal(reply.previews.length, 0);
});

test("an audio item's reply says the user can HEAR it and that the agent cannot (#710)", async () => {
  const h = harness();
  const reply = await composeShowMediaReply([AUDIO_REF], h.deps);

  assert.equal(reply.painted, 1, "a played audio file IS presented to the user");
  assert.deepEqual(reply.unrenderable, []);
  // The headline must not claim the audio was DISPLAYED — a player is not a picture.
  assert.match(reply.note, /audio player/i);
  // …and it must disarm the fabrication an audio card invites: the agent has
  // heard nothing, so it must not describe how the file sounds.
  assert.match(reply.note, /do not describe how it sounds/i);
  assert.match(reply.note, /vo_sophie_00001\.mp3/);
  // A real next step, and one that actually works: get_image saves audio to disk.
  assert.match(
    reply.note,
    /call get_image with filename "vo_sophie_00001\.mp3", type "output", subfolder "synlara"/,
  );
  // …and `painted` must not be oversold. The painter is synchronous: it returns
  // before a byte is fetched, so a player in the chat is not evidence the file
  // decoded. Claiming "the user can play it" full stop is the same overclaim as
  // the success this fix removes, one layer down.
  assert.match(reply.note, /NOT proof the browser could decode the file/);
  assert.match(reply.note, /ask the user whether it actually plays/);
});

test("an audio file whose player could not be painted is not counted as painted (#710)", async () => {
  const h = harness({
    paintAudio: () => {
      throw new Error("DOM exploded");
    },
  });
  const reply = await composeShowMediaReply([AUDIO_REF], h.deps);
  assert.equal(reply.painted, 0);
  assert.match(reply.note, /were NOT displayed/);
  assert.match(reply.note, /vo_sophie_00001\.mp3/);
});

test("a kind the panel cannot present is NOT counted as painted (#710)", async () => {
  // The honesty half in one assertion: the agent must be able to tell "the user
  // can perceive this" from "I was handed something I could not present".
  const h = harness();
  const reply = await composeShowMediaReply(
    [
      { kind: "image", dataUrl: "data:image/png;base64,AAAA", filename: "a.png" },
      {
        kind: "viewRef",
        viewRef: { filename: "notes.txt", subfolder: "", type: "output" },
        filename: "notes.txt",
      },
    ],
    h.deps,
  );

  assert.equal(reply.count, 2);
  assert.equal(reply.painted, 1, "only the image was presented; the .txt was not");
  assert.equal(reply.unconfirmed, 0);
  assert.equal(reply.unrenderable.length, 1);
  assert.equal(reply.unrenderable[0].name, "notes.txt");
  assert.equal(reply.unrenderable[0].ext, ".txt");
  assert.equal(h.calls.paintedImages.length, 1, "the .txt must not go to the image painter");
  assert.match(reply.note, /the panel cannot present/i);
  assert.match(reply.note, /notes\.txt/);
  // get_image only returns image/video/audio and REFUSES anything else, so
  // pointing the agent at it here would be a remedy that cannot be followed.
  assert.doesNotMatch(reply.note, /call get_image with filename "notes\.txt"/);
});

test("an unpresentable item still gives the USER something to act on — a link (#710)", async () => {
  const h = harness();
  const reply = await composeShowMediaReply(
    [
      {
        kind: "viewRef",
        viewRef: { filename: "scene.blend", subfolder: "", type: "output" },
        filename: "scene.blend",
      },
    ],
    h.deps,
  );
  assert.equal(h.calls.paintedLinks.length, 1);
  assert.match(h.calls.paintedLinks[0].url, /filename=scene\.blend/);
  assert.equal(reply.unrenderable[0].shown, "link");
  assert.match(reply.note, /LINK/);
});

test("an unpresentable item whose link ALSO failed says the user got nothing at all (#710)", async () => {
  const h = harness({
    paintFileLink: () => {
      throw new Error("DOM exploded");
    },
  });
  const reply = await composeShowMediaReply(
    [{ kind: "viewRef", viewRef: { filename: "scene.blend", type: "output" }, filename: "scene.blend" }],
    h.deps,
  );
  assert.equal(reply.painted, 0);
  assert.equal(reply.unrenderable[0].shown, "nothing");
  assert.match(reply.note, /nothing at all/i);
});

test("audio in a panel with no audio painter degrades to a link and is NOT painted (#710)", async () => {
  // A dep the panel forgot to wire must fail honest, not fail silent.
  const h = harness({ paintAudio: undefined });
  const reply = await composeShowMediaReply([AUDIO_REF], h.deps);
  assert.equal(h.calls.paintedImages.length, 0, "never fall back to the image painter");
  assert.equal(reply.painted, 0);
  assert.equal(reply.unrenderable.length, 1);
  assert.equal(h.calls.paintedLinks.length, 1);
});

test("classifyShowMediaItem decides by explicit kind, then the ref's filename, then the data URL", () => {
  const ref = (filename) => ({ kind: "viewRef", viewRef: { filename }, filename });
  // The orchestrator's own kind wins — it built the MIME from the extension.
  assert.equal(classifyShowMediaItem({ kind: "image", dataUrl: "data:image/png;base64,AA==" }).kind, "image");
  assert.equal(classifyShowMediaItem({ kind: "video", dataUrl: "data:video/mp4;base64,AA==" }).kind, "video");
  assert.equal(classifyShowMediaItem({ kind: "audio", dataUrl: "data:audio/mpeg;base64,AA==" }).kind, "audio");
  // A /view ref carries no kind, so the filename decides.
  assert.equal(classifyShowMediaItem(ref("a.png")).kind, "image");
  assert.equal(classifyShowMediaItem(ref("a.WEBP")).kind, "image");
  assert.equal(classifyShowMediaItem(ref("a.gif")).kind, "image", "animated gifs render in <img>");
  assert.equal(classifyShowMediaItem(ref("a.mp4")).kind, "video");
  assert.equal(classifyShowMediaItem(ref("a.MP3")).kind, "audio");
  assert.equal(classifyShowMediaItem(ref("a.wav")).kind, "audio");
  assert.equal(classifyShowMediaItem(ref("a.flac")).kind, "audio");
  assert.equal(classifyShowMediaItem(ref("a.ogg")).kind, "audio");
  assert.equal(classifyShowMediaItem(ref("a.m4a")).kind, "audio");
  assert.equal(classifyShowMediaItem(ref("a.aac")).kind, "audio");
  // Query strings and fragments must not demote a kind (the #648 dot bug's twin).
  assert.equal(classifyShowMediaItem(ref("a.mp3?download=1")).kind, "audio");
  assert.equal(classifyShowMediaItem(ref("a.mp3#t=3")).kind, "audio");
  // An unescaped dot would make "xmp3" audio, exactly as it once made "xmp4" video.
  assert.equal(classifyShowMediaItem(ref("xmp3")).kind, "unknown");
  // UNKNOWN is a decision, not a fallback to <img>.
  assert.equal(classifyShowMediaItem(ref("notes.txt")).kind, "unknown");
  assert.equal(classifyShowMediaItem(ref("notes.txt")).ext, ".txt");
  assert.equal(classifyShowMediaItem(ref("noextension")).kind, "unknown");
  assert.equal(classifyShowMediaItem(ref("noextension")).ext, "");
  // A data URL with no declared kind is classified by its MIME.
  assert.equal(classifyShowMediaItem({ dataUrl: "data:audio/wav;base64,AA==" }).kind, "audio");
  assert.equal(classifyShowMediaItem({ dataUrl: "data:application/pdf;base64,AA==" }).kind, "unknown");
  assert.equal(classifyShowMediaItem(null).kind, "unknown");
});

test("the audio branch does not change how images and videos are classified (#710)", () => {
  // The common path is the one a regression here would cost, so it is asserted
  // against the SAME classifier the paint pass uses.
  const ref = (filename) => ({ kind: "viewRef", viewRef: { filename }, filename });
  for (const name of ["out.png", "out.jpg", "out.jpeg", "out.webp", "out.gif", "out.bmp", "out.avif"]) {
    assert.equal(classifyShowMediaItem(ref(name)).kind, "image", name);
    assert.equal(isVideoShowMediaItem(ref(name)), false, name);
  }
  for (const name of ["clip.mp4", "clip.webm", "clip.mov", "clip.m4v", "clip.mkv", "clip.avi"]) {
    assert.equal(classifyShowMediaItem(ref(name)).kind, "video", name);
    assert.equal(isVideoShowMediaItem(ref(name)), true, name);
  }
});

test("a mixed batch reports each kind's outcome separately (#710)", async () => {
  const h = harness();
  const reply = await composeShowMediaReply(
    [
      { kind: "image", dataUrl: "data:image/png;base64,AAAA", filename: "a.png" },
      AUDIO_REF,
      { kind: "viewRef", viewRef: { filename: "notes.txt", type: "output" }, filename: "notes.txt" },
    ],
    h.deps,
  );
  assert.equal(h.calls.paintedImages.length, 1);
  assert.equal(h.calls.paintedAudio.length, 1);
  assert.equal(h.calls.paintedLinks.length, 1);
  assert.equal(reply.count, 3);
  assert.equal(reply.painted, 2, "the image and the audio — not the .txt");
  assert.equal(reply.unrenderable.length, 1);
  assert.match(reply.note, /1 item was displayed/);
  assert.match(reply.note, /1 audio player/);
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

/**
 * The body of a named function, bounded by its OWN braces.
 *
 * Replaces the fixed-size `slice(i, i + N)` these source tests used to take. A
 * fixed window has a cliff: #1493 grew the storyboard builder past 4000 chars
 * and the assertion below silently stopped covering the line it checked. Raising
 * the number only moves the cliff (review finding), so bound the real thing.
 *
 * Not a JS parser, and it does not need to be — but a brace counter that reads
 * braces inside STRINGS and COMMENTS can mis-bound and then validate the wrong
 * region entirely, which is worse than no check. So mask those first, preserving
 * length so offsets still line up with the original.
 *
 * STRINGS ARE MASKED BEFORE COMMENTS, and the order is load-bearing: a `//` or
 * `/*` inside a string literal would otherwise start a comment that runs to the
 * end of the line (or to the next close) and blank out real code, moving the
 * bound (review, round 3). Masking strings first removes those characters before
 * anything can read them as a comment opener.
 *
 * ACCEPTED LIMITS, stated rather than implied: regex literals are NOT masked, so
 * a regex containing an unbalanced brace inside this function would mis-bound
 * it, and nested template literals are matched only to their first unescaped
 * backtick. Both are absent from the function this is used on, and the
 * assertions here fail loudly rather than silently passing if the bound moves —
 * a body that no longer contains `storyboardFailure(` trips the >= 5 check. Buy
 * a real parser if this helper ever gets pointed at arbitrary code.
 */
function functionBody(signature) {
  const src = panelSource();
  const start = src.indexOf(signature);
  assert.ok(start > 0, `could not locate ${signature}`);

  const blank = (m) => m.replace(/[^\n]/g, " "); // keep newlines, drop content
  const masked = src
    .replace(/"(?:\\.|[^"\\\n])*"/g, blank) // "…"  ─┐ strings FIRST, so a `//`
    .replace(/'(?:\\.|[^'\\\n])*'/g, blank) // '…'   │ inside one cannot open a
    .replace(/`(?:\\.|[^`\\])*`/g, blank) //  `…`   ─┘ comment that eats real code
    .replace(/\/\*[\s\S]*?\*\//g, blank) // block comments
    .replace(/\/\/[^\n]*/g, blank); // line comments

  const open = masked.indexOf("{", start);
  assert.ok(open > start, `could not find the opening brace of ${signature}`);
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) {
      return src.slice(open, i); // the ORIGINAL text, precisely bounded
    }
  }
  assert.fail(`could not bound the body of ${signature}`);
}

test("the show_media dispatcher answers with the handler's reply, not a fixed acknowledgement", () => {
  const src = panelSource();
  assert.match(
    src,
    /import \{ composeShowMediaReply \} from "\.\/lib\/media-preview\.js";/,
    "the panel must import the reply composer",
  );
  const i = src.indexOf('msg.cmd === "show_media"');
  assert.ok(i > 0, "could not locate the show_media dispatcher branch");
  // Bound the slice to THIS branch — a fixed window ran into the next one and
  // asserted against its code.
  const j = src.indexOf('} else if (msg.cmd === "open_civitai")', i);
  assert.ok(j > i, "could not find the end of the show_media branch");
  const branch = src.slice(i, j);
  assert.match(
    branch,
    /const mediaReply = await onShowMedia\(mediaItems\);/,
    "the reply must be AWAITED from the handler — a preview is real work",
  );
  // The handler is what paints and what composes the disclosure, so its absence
  // cannot be success. An optional call with an {ok:true} fallback reproduces
  // the exact dead-end acknowledgement this whole PR removes, on the branch
  // nobody re-reads.
  assert.match(
    branch,
    /if \(!onShowMedia\) throw new Error\(/,
    "an absent handler must fail loudly, not succeed quietly",
  );
  assert.doesNotMatch(
    branch,
    /onShowMedia\?\./,
    "the optional call is the tell — it makes 'no handler' indistinguishable from 'delivered'",
  );
  assert.doesNotMatch(
    branch,
    /ok: true/,
    "no branch of show_media may report success the panel did not observe",
  );
  assert.match(
    branch,
    /delivered: "unknown"/,
    "a handler that returns nothing leaves the delivery UNKNOWN, not done",
  );
});

test("the panel's storyboard builder carries the count it ACTUALLY drew", () => {
  // Without this, media-preview has only the grid capacity to go on and every
  // partially-sampled sheet is described as a full one — 19 blank cells
  // presented to the agent as 19 observations.
  // Brace-bounded, not a fixed window. #1493 grew this function past the old
  // 4000-char slice and the assertion below stopped covering the line it
  // checks; bumping the number would only move that cliff.
  const fn = functionBody("async function buildVideoStoryboard(");
  assert.match(fn, /blob\.paintedFrames = painted;/);
  // A sheet that will not encode must still not be reported as a sheet. This
  // used to pin the literal `if (!blob) return null;`; comfyui-mcp#1493 replaced
  // the bare null with a NAMED failure, so pin the property that matters — the
  // encode branch does not fall through — rather than the exact wording, which
  // was only ever incidental to this test's point.
  assert.match(fn, /if \(!blob\) return storyboardFailure\(/);
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
  // #710 — a painter the panel never passes leaves this module with nothing to
  // dispatch to, and the composer degrades every audio file to a link card. The
  // module's audio branch is only real if the panel actually wires it.
  for (const dep of ["paintAudio", "paintFileLink"]) {
    assert.ok(handler[0].includes(dep), `onShowMedia must pass ${dep} through (#710)`);
  }
});

/** One `function name(...) { … }` at the panel closure's 2-space indent, sliced
 *  at its OWN closing brace — a fixed window (or one bounded by the next
 *  function) runs into the following declaration's comment block and asserts
 *  against prose rather than code. */
function panelFunctionBody(src, decl) {
  const i = src.indexOf(decl);
  assert.ok(i > 0, `could not locate ${decl}`);
  const end = src.slice(i).search(/\n {2}\}/);
  assert.ok(end > 0, `could not find the end of ${decl}`);
  return src.slice(i, i + end + 4);
}

test("paintAudio builds a real <audio> player, not an <img> (#710)", () => {
  const src = panelSource();
  const fn = panelFunctionBody(src, "function paintAudio(");
  assert.match(fn, /createElement\("audio"\)/);
  assert.match(fn, /\.controls = true/, "a player with no controls is not playable");
  assert.doesNotMatch(fn, /createElement\("img"\)/);
  // The chat lightbox gathers `.cmcp-imgcard` and renders every member as an
  // image or a video. An audio card in that gallery is the broken <img> back by
  // another route, so it must carry its own class and no _cmcpMedia descriptor.
  assert.doesNotMatch(fn, /cmcp-imgcard/);
  assert.doesNotMatch(fn, /_cmcpMedia/);
  assert.match(fn, /recordMedia\("audio", url, name\)/, "audio must survive a reload as audio");
});

test("paintFileLink gives the user an openable link for a kind the panel cannot present (#710)", () => {
  const src = panelSource();
  const fn = panelFunctionBody(src, "function paintFileLink(");
  assert.match(fn, /createElement\("a"\)/);
  assert.match(fn, /\.href = url/);
  assert.doesNotMatch(fn, /createElement\("img"\)/);
  assert.doesNotMatch(fn, /cmcp-imgcard/);
});

test("chat audio is STOPPED at every teardown — a detached <audio> keeps playing (#710)", () => {
  // Removing a playing <audio> from the DOM does not pause it, and once the card
  // is gone there are no controls left to stop it with. Videos are covered by
  // their IntersectionObserver; audio needs an explicit stop.
  const src = panelSource();
  const fn = panelFunctionBody(src, "function stopChatAudio(");
  assert.match(fn, /querySelectorAll\("audio"\)/);
  assert.match(fn, /\.pause\(\)/);
  // A permanent teardown drops the source too; a keep-alive detach must NOT —
  // the same element is re-attached, and a player with no src is a new bug.
  assert.match(fn, /if \(release\)[\s\S]{0,120}removeAttribute\("src"\)/);
  const reset = panelFunctionBody(src, "function resetFeed(");
  assert.match(reset, /releaseChatAudio\(\);/, "a thread/workflow switch must not leave sound playing");
  assert.ok(
    reset.indexOf("releaseChatAudio()") < reset.indexOf("el.remove()"),
    "release BEFORE detaching — a detached element is no longer reachable from `log`",
  );
  // The panel's own unmount is the other teardown: after it there is no card at
  // all, so nothing else could ever stop the sound. Several objects in this file
  // have a destroy(); the panel's is the one that unsubscribes history sync.
  const destroys = [...src.matchAll(/\n {4}destroy\(\) \{/g)]
    .map((m) => src.slice(m.index, m.index + 4000))
    .filter((body) => body.includes("unsubscribeHistorySync()"));
  assert.equal(destroys.length, 1, "could not locate the panel's own destroy()");
  assert.match(destroys[0], /releaseChatAudio\(\);/);
});

test("a KEEP-ALIVE sidebar detach pauses chat audio without destroying the player (#710)", () => {
  // A sidebar-tab switch does not tear the panel down — it detaches the root and
  // re-attaches the same DOM on re-entry. The audio still has to stop (its
  // controls just left with the root, and the chat's videos are already paused
  // here by their IntersectionObserver), but only by PAUSING: dropping `src`
  // would hand the returning user a dead player.
  const src = panelSource();
  const onHide = src.match(/onHide\(\) \{[\s\S]*?\n {4}\},/);
  assert.ok(onHide, "the panel handle must expose onHide for the keep-alive detach");
  assert.match(onHide[0], /stopChatAudio\(\);/);
  assert.doesNotMatch(onHide[0], /release/, "a keep-alive detach must not drop the source");
  // BOTH detach paths must call it: the tab's own destroy(), and the
  // sidebar-overlap guard that removes a stray root when another tab is active.
  const tabDestroy = src.match(/destroy: \(\) => \{[\s\S]*?\n {8}\},/);
  assert.ok(tabDestroy, "could not locate the sidebar tab's destroy()");
  assert.match(tabDestroy[0], /mounted\?\.onHide\?\.\(\);/);
  assert.ok(
    tabDestroy[0].indexOf("onHide") < tabDestroy[0].indexOf("root?.remove()"),
    "pause BEFORE the root is detached",
  );
  const guard = src.match(/function installSidebarTabGuard\([\s\S]*?\n {2}const start =/);
  assert.ok(guard, "could not locate installSidebarTabGuard");
  assert.match(guard[0], /onDetach\?\.\(\)/);
  assert.match(
    src,
    /installSidebarTabGuard\(\s*tabId,[\s\S]{0,160}mounted\?\.onHide\?\.\(\)/,
    "the guard must actually be given the panel's onHide",
  );
});

test("run completion PLAYS an audio output instead of painting it as an image (#710)", () => {
  // The second copy of the kind decision. The completion path knew only
  // image-vs-video, so an audio descriptor arriving there was painted as an
  // <img> AND handed to the agent as an inline image — a picture nobody has.
  const src = panelSource();
  const fn = panelFunctionBody(src, "function isAudioOutput(");
  assert.match(fn, /fmt\.startsWith\("audio\/"\)/);
  assert.match(fn, /mp3\|wav\|flac/);
  const onExecuted = panelFunctionBody(src, "function onExecuted(");
  // The exact branch, not merely a mention of the predicate: `false &&
  // isAudioOutput(m)` still "mentions" it while routing every audio file back
  // through paintImage, and a test that passes on that is testing nothing.
  assert.match(onExecuted, /\} else if \(isAudioOutput\(m\)\) \{/);
  assert.match(onExecuted, /isAudioOutput\(m\)\) \{[\s\S]{0,600}paintAudio\(url, m\.filename\)/);
  const audioBranch = onExecuted.slice(onExecuted.indexOf("isAudioOutput(m)"));
  const branchEnd = audioBranch.indexOf("} else {");
  assert.ok(branchEnd > 0);
  assert.doesNotMatch(
    audioBranch.slice(0, branchEnd),
    /inlineImages\.push/,
    "audio must never join the agent's inline-IMAGE delivery",
  );
});

test("a persisted audio card REPLAYS as audio, not as a broken image (#710)", () => {
  // The reload path is a second copy of the kind decision. Leaving it behind
  // reproduces the exact defect one refresh later.
  const src = panelSource();
  const i = src.indexOf('if (m.mkind === "video") paintVideo(m.url, m.caption);');
  assert.ok(i > 0, "could not locate the media replay branch");
  const branch = src.slice(i, i + 400);
  assert.match(branch, /m\.mkind === "audio"[\s\S]{0,40}paintAudio\(m\.url, m\.caption\)/);
  assert.match(branch, /m\.mkind === "file"[\s\S]{0,40}paintFileLink\(m\.url, m\.caption\)/);
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

test("firing the bound clears the timer it holds, so two timers are never left pending", async () => {
  // The arm-then-throw case leaks the injected timer irrecoverably (its handle
  // was never returned). Whichever timer fires first must at least clear the
  // other, or the leak is two rather than one.
  let injected;
  let cleared = 0;
  const v = await withTimeout(new Promise(() => {}), 1000, () => "fallback", {
    setTimer: (fn) => {
      injected = fn;
      throw new Error("armed, then threw");
    },
    clearTimer: () => {
      cleared += 1;
    },
  });
  assert.equal(v, "fallback");
  assert.equal(typeof injected, "function", "the thrower still captured the callback");
  // The platform fallback is what resolved; firing the leaked injected timer now
  // must be a no-op rather than a second resolution.
  injected();
  assert.equal(await withTimeout(Promise.resolve("x"), 0, () => "y", {}), "x");
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

test("#1161 withTimeout: a `timers` object that cannot be READ is treated as absent, never a rejection", async () => {
  // bounded-step.js's own header argues that every injected guard is an operation that can
  // fail, and wraps `onTimeout` and `clearTimer` accordingly — but READING the injected
  // object was itself unguarded. A throwing getter, or a Proxy whose get trap throws, threw
  // synchronously before the returned promise existed, so withTimeout REJECTED out of a
  // function documented three lines above its signature as never rejecting. The
  // /object_info oracle passes this object straight through, and two panel commands await
  // that oracle with no catch of their own.
  const hostile = [
    { get setTimer() { throw new Error("hostile getter"); } },
    new Proxy({}, { get() { throw new Error("proxy trap"); } }),
    { setTimer: 5, clearTimer: "no" }, // present, but not callable
  ];
  for (const timers of hostile) {
    const value = await withTimeout(Promise.resolve("answered"), 1000, () => "timed out", timers);
    assert.equal(value, "answered", "an unreadable timers object must fall back to the real timer");
  }
  // …and the bound must still WORK through that fallback, not merely avoid throwing.
  const timedOut = await withTimeout(new Promise(() => {}), 1, () => "timed out", {
    get setTimer() { throw new Error("hostile getter"); },
  });
  assert.equal(timedOut, "timed out", "the real timer still bounds the step");
});
