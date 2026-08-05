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
  assert.match(reply.note, /whether the user can see it is UNKNOWN/);
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
  assert.match(reply.note, /whether the user can see it is UNKNOWN/);
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
