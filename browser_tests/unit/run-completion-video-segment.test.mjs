// panel#1485 — the video completion the panel PROMISED, and what it spends
// getting there.
//
// THE REPORT. `panel_run` on a graph that writes an .mp4 finished successfully
// and the panel's completion event never showed up; ~5 s later the orchestrator
// synthesised a success notice of its own, and that notice carried no output —
// the agent had to go and find the file with list_outputs and panel_show_media.
// The first filing of this issue saw the same thing at ~45 s.
//
// WHY 45 s BECAME 5 s, AND WHY THAT MATTERS HERE. The orchestrator's
// `DEFAULT_SYNTHESIS_GRACE_MS` was cut from 45 000 to 5 000, on a stated
// assumption: "the normal path lands within a second or two; that is the only
// race the grace has to win." For a STILL that is true. For a VIDEO the panel's
// single completion frame is not sent until it has sampled the clip in a hidden
// <video>, encoded a contact sheet, uploaded it, encoded a poster, uploaded THAT
// and taken a HEAD of the video — measured on this repo's rig (headless and
// headed Chromium, a 4.84 s and a 19.36 s 960×544 h264 mp4, ComfyUI on
// localhost): 1.0–9.7 s end to end, and bounded at 25 s by design. And when the
// orchestrator wins that race, the notice it synthesises cannot carry the video
// at all — an .mp4 is deliberately named-but-not-attached (comfyui-mcp#1861), so
// the storyboard is the ONLY thing that ever shows the agent this render.
//
// So the panel's half of the fix is: take off that path everything that is not
// needed to tell the agent the run finished. The tests below pin the three
// things that came off it, plus two claims the same function was making that
// were not true.
//
// These drive the REAL composeRunCompletionFrame with injected deps rather than
// asserting on source text: every one of them fails when its fix is reverted
// (verified by reverting each in turn), which a source-regex pin cannot promise.
import test from "node:test";
import assert from "node:assert/strict";

import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";

/** A stand-in for the sheet Blob: what every consumer actually tests for is a
 *  numeric `size`, so that is what the double carries. */
function sheetBlob({ size = 4096, paintedFrames, posterBlob } = {}) {
  const b = { size };
  if (paintedFrames !== undefined) b.paintedFrames = paintedFrames;
  if (posterBlob !== undefined) b.posterBlob = posterBlob;
  return b;
}

function videoPayload() {
  return {
    promptId: "p-1485",
    images: [],
    videos: [{ m: { filename: "clip_00001_.mp4", subfolder: "", type: "output", format: "video/h264-mp4" }, nodeId: 128 }],
    durationMs: 28_770,
  };
}

/**
 * Deps wired to succeed. `overrides` replaces individual helpers; `calls`
 * records what the pipeline reached out to and in what order.
 */
function makeDeps(overrides = {}) {
  const calls = { uploads: [], painted: [], posters: [], sizeHeads: [], frames: [] };
  const deps = {
    sendFrame: (frame) => {
      calls.frames.push(frame);
      return true;
    },
    coerceMessageText: (v) => (typeof v === "string" ? v : v == null ? "" : String(v)),
    formatDuration: (ms) => `${Math.round(ms / 1000)}s`,
    formatClock: () => "7:45:29 AM",
    imageViewUrl: (ref) => `/view?filename=${ref?.filename ?? ""}`,
    fetchImageBytes: async (url) => {
      calls.sizeHeads.push(url);
      return 1_177_013;
    },
    fetchImageDimensions: async () => null,
    humanizeBytes: (n) => (n == null ? null : `${n} B`),
    buildVideoStoryboard: async () => sheetBlob({ paintedFrames: 20 }),
    uploadBlobToInput: async (blob, name) => {
      calls.uploads.push({ name, blob });
      return { filename: name, subfolder: "", type: "temp" };
    },
    storyboardFrameCount: () => 20,
    paintImage: (url, caption) => calls.painted.push({ url, caption }),
    applyVideoPoster: (videoUrl, posterUrl) => calls.posters.push({ videoUrl, posterUrl }),
    videoStoryboardEnabled: true,
    agentReceivesImages: () => true,
    warn: () => {},
    // Real timers, so a segment that is genuinely awaiting something never
    // silently "completes" because a fake clock advanced past it.
    videoStoryboardTimeoutMs: 25_000,
    ...overrides,
  };
  return { deps, calls };
}

test("#1485: a storyboard FAILURE object is never uploaded as if it were a sheet", async () => {
  // buildVideoStoryboard answers a codec it cannot decode with
  // storyboardFailure({reason}) — which is TRUTHY. The old `if (!blob)` test
  // sailed past it and handed the plain object to uploadBlobToInput, which
  // appends it to a FormData as "[object Object]" and uploads that under a .png
  // name; the agent was then shown a "20-frame storyboard" that is not an image
  // and asked to review its motion and sharpness.
  const reason =
    "the browser reported no usable duration for it (its codec may not be decodable here — VP9/AV1 .webm is the usual case)";
  const { deps, calls } = makeDeps({ buildVideoStoryboard: async () => ({ reason }) });
  const frame = await composeRunCompletionFrame(videoPayload(), deps);

  assert.deepEqual(calls.uploads, [], "a failure object must never reach uploadBlobToInput");
  assert.ok(frame, "the completion frame is still sent — a failed storyboard is not a failed run");
  assert.deepEqual(frame.images, [], "and it carries no sheet, because none was built");
  assert.ok(
    !/storyboard \(contact sheet\)|-frame storyboard \(contact sheet\)/.test(frame.note),
    "the note must not describe a contact sheet that does not exist",
  );
  // #1493 built the reason precisely so the panel could stop saying "the panel is
  // not told which". Saying it is the whole point of carrying it.
  assert.ok(frame.note.includes(reason), `the note must name the cause the builder supplied\n${frame.note}`);
});

test("#1485: the note describes the frames actually PAINTED, not the grid's capacity", async () => {
  // #648 put the real count on the blob and told callers to use it. This one used
  // storyboardFrameCount() — the CAPACITY — so a sheet holding one frame and
  // nineteen blank cells was announced to the agent as twenty samples.
  const { deps } = makeDeps({ buildVideoStoryboard: async () => sheetBlob({ paintedFrames: 3 }) });
  const frame = await composeRunCompletionFrame(videoPayload(), deps);

  assert.ok(
    !/20-frame storyboard/.test(frame.note),
    `a 3-frame sheet must not be announced as 20 frames\n${frame.note}`,
  );
  assert.match(frame.note, /Only 3 of its 20 cells hold a sampled frame/, "the count that was drawn is the count that is stated");
  assert.match(frame.note, /the other 17 are BLANK/, "and the blanks are disclosed, not implied");
  assert.match(frame.note, /📽️ 20-cell storyboard \(contact sheet\) of the FINAL saved video/,
    "the head names the sheet and flows into the file — the caveat is its own sentence");
});

test("#1485: a FULL sheet still reads as a plain N-frame storyboard", async () => {
  // The disclosure above is for the degraded case only — a sheet whose every
  // planned cell filled must not acquire a caveat it does not need.
  const { deps, calls } = makeDeps();
  const frame = await composeRunCompletionFrame(videoPayload(), deps);

  assert.match(frame.note, /📽️ 20-frame storyboard \(contact sheet\)/);
  assert.ok(!/BLANK/.test(frame.note), "nothing was blank, so nothing is disclosed as blank");
  assert.deepEqual(
    calls.painted.map((p) => p.caption),
    ["Storyboard · 20 frames"],
    "the user's caption counts the same frames the agent's note does",
  );
});

test("#1485: exactly ONE sampled frame is described in the singular, with the blanks named", async () => {
  // The reported shape of a barely-decodable video: the builder paints one cell
  // and leaves nineteen blank. This is the case the capacity claim was worst
  // for, so the wording is pinned rather than assumed to fall out of the plural.
  const { deps } = makeDeps({ buildVideoStoryboard: async () => sheetBlob({ paintedFrames: 1 }) });
  const frame = await composeRunCompletionFrame(videoPayload(), deps);

  assert.match(frame.note, /Only 1 of its 20 cells hold/, "one frame is one frame");
  assert.match(frame.note, /the other 19 are BLANK, so judge nothing from them/);
  assert.ok(!/20-frame storyboard/.test(frame.note), `\n${frame.note}`);
});

test("#1485: cells-minus-one reads 'is BLANK', not 'are BLANK' (gate non-finding)", async () => {
  // The boundary the plural rule actually gets wrong: 19 of 20 painted leaves
  // exactly one blank cell. Caught by the review gate reading the generated
  // string rather than the branch, which is why it is pinned by the string.
  const { deps } = makeDeps({ buildVideoStoryboard: async () => sheetBlob({ paintedFrames: 19 }) });
  const frame = await composeRunCompletionFrame(videoPayload(), deps);

  assert.match(frame.note, /the other 1 is BLANK, so judge nothing from it/, `
${frame.note}`);
  assert.ok(!/the other 1 are BLANK/.test(frame.note), "one blank cell is 'is', not 'are'");
});

test("#1485: a count over capacity is CLAMPED, never announced as more than the grid holds", async () => {
  // paintedFrames is an expando the builder sets; a caller must not be able to
  // claim 25 samples from a 20-cell sheet. Clamped to the capacity, which then
  // reads as a full sheet with no blanks — the honest description of 20 cells
  // that all hold a frame.
  const { deps } = makeDeps({ buildVideoStoryboard: async () => sheetBlob({ paintedFrames: 25 }) });
  const frame = await composeRunCompletionFrame(videoPayload(), deps);

  assert.ok(!/25/.test(frame.note), `a count above the capacity must never be printed
${frame.note}`);
  assert.match(frame.note, /📽️ 20-frame storyboard \(contact sheet\)/);
  assert.ok(!/BLANK/.test(frame.note), "a clamped-full sheet has no blanks to disclose");
});

test("#1485: an UNKNOWN sampled count claims no count at all — never the capacity, never 'null'", async () => {
  // `paintedFrames` is best-effort: buildVideoStoryboard sets it on the blob and
  // its own comment allows a Blob implementation that refuses extra properties,
  // "which callers must treat as unknown — never as the capacity". Unlike
  // show_media's produceSheet, this path does NOT withhold the sheet for an
  // unknown count — it is the run's ONE completion and the sheet is the only
  // thing that shows the agent the video — so it must describe it without one.
  //
  // The second half is the trap: `metaSuffix`'s storyboard clause is a plain
  // truthiness guard, so passing an unknown count through as a number-shaped
  // nothing would print "null-frame storyboard" on the metadata line.
  const { deps, calls } = makeDeps({ buildVideoStoryboard: async () => sheetBlob({}) });
  const frame = await composeRunCompletionFrame(videoPayload(), deps);

  assert.equal(frame.images.length, 1, "the sheet still ships — an unknown count is not a reason to withhold it");
  assert.match(frame.note, /📽️ storyboard \(contact sheet\)/, "described, but not counted");
  assert.ok(!/20-frame|20-cell/.test(frame.note), `the capacity must not stand in for the count\n${frame.note}`);
  assert.ok(
    !/null|undefined|NaN/.test(frame.note),
    `an unknown count must never reach the note as a value\n${frame.note}`,
  );
  assert.deepEqual(
    calls.painted.map((p) => p.caption),
    ["Storyboard"],
    "and the user's caption drops the count too, rather than inventing one",
  );
});

test("#1485: the completion frame does not wait for the card's poster", async () => {
  // THE LATENCY FIX. The poster decorates the USER's video card; the agent never
  // receives it and no part of the note depends on it. It used to be awaited —
  // a full-resolution PNG encode plus a second POST /upload/image between the
  // run finishing and the agent being told it finished.
  //
  // Modelled as the worst case that is not a crash: an upload that never
  // settles. Before the fix this test hangs until the 25 s segment timeout and
  // then reports a "storyboard preview timed out" with NO sheet; after it, the
  // frame is sent immediately with the sheet intact.
  let posterUploadStarted = false;
  const { deps, calls } = makeDeps({
    buildVideoStoryboard: async () => sheetBlob({ paintedFrames: 20, posterBlob: { size: 718_372 } }),
    uploadBlobToInput: async (blob, name) => {
      calls.uploads.push({ name, blob });
      if (name.startsWith("poster_")) {
        posterUploadStarted = true;
        return new Promise(() => {}); // never settles
      }
      return { filename: name, subfolder: "", type: "temp" };
    },
  });

  const frame = await Promise.race([
    composeRunCompletionFrame(videoPayload(), deps),
    new Promise((_, reject) => setTimeout(() => reject(new Error("completion frame waited on the poster")), 2000)),
  ]);

  assert.ok(frame, "the completion frame is sent");
  assert.equal(frame.images.length, 1, "and it carries the storyboard the agent needs");
  assert.match(frame.note, /📽️ 20-frame storyboard/, "not the timed-out fallback");
  assert.ok(posterUploadStarted, "the poster is still uploaded — it is detached, not dropped");
  assert.equal(calls.posters.length, 0, "it simply has not landed yet, and the card back-fills when it does");
});

test("#1485: the poster still reaches the card when its upload resolves", async () => {
  // Detached must not mean abandoned: the card's back-fill is the entire reason
  // the poster is produced, and #1280's behaviour has to survive this change.
  let resolvePoster;
  const { deps, calls } = makeDeps({
    buildVideoStoryboard: async () => sheetBlob({ paintedFrames: 20, posterBlob: { size: 718_372 } }),
    uploadBlobToInput: async (blob, name) => {
      calls.uploads.push({ name, blob });
      if (name.startsWith("poster_")) {
        return new Promise((res) => {
          resolvePoster = () => res({ filename: name, subfolder: "", type: "temp" });
        });
      }
      return { filename: name, subfolder: "", type: "temp" };
    },
  });

  await composeRunCompletionFrame(videoPayload(), deps);
  assert.equal(calls.posters.length, 0, "the frame did not wait for it");
  resolvePoster();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.posters, [
    { videoUrl: "/view?filename=clip_00001_.mp4", posterUrl: "/view?filename=poster_clip_00001_.png" },
  ], "and the card is back-filled by video URL exactly as before");
});

test("#1485: the video's size HEAD overlaps the sampling instead of following the upload", async () => {
  // fetchImageBytes is bounded at 8 s inside the panel, and it used to run AFTER
  // the sheet upload — so on a remote target it was a whole round trip added to
  // the completion's critical path for a metadata line. Started before the
  // sampling pass, it costs nothing the decode was not already spending.
  const order = [];
  const { deps } = makeDeps({
    fetchImageBytes: async () => {
      order.push("head:start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("head:end");
      return 1_177_013;
    },
    buildVideoStoryboard: async () => {
      order.push("sample:start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("sample:end");
      return sheetBlob({ paintedFrames: 20 });
    },
  });

  const frame = await composeRunCompletionFrame(videoPayload(), deps);
  assert.equal(order[0], "head:start", "the HEAD is issued first");
  assert.ok(
    order.indexOf("head:end") < order.indexOf("sample:end"),
    `the HEAD must finish while the decode is still running, not after it\n${order.join(" → ")}`,
  );
  // Overlapping it must not cost the note the value it was fetched for.
  assert.match(frame.note, /1177013 B/, "the size still reaches the metadata line");
});

test("#1485: a HEAD that throws degrades the metadata line, never the completion", async () => {
  // The old code awaited fetchImageBytes inline, so a throw fell into the
  // segment's catch and cost the agent the whole storyboard. Detaching it makes
  // that reachable in a new way, so it is pinned rather than assumed.
  const { deps } = makeDeps({
    fetchImageBytes: async () => {
      throw new Error("HEAD refused");
    },
  });
  const frame = await composeRunCompletionFrame(videoPayload(), deps);
  assert.match(frame.note, /📽️ 20-frame storyboard/, "the sheet survives a failed size lookup");
  assert.equal(frame.images.length, 1);
});
