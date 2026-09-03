// panel#2128 recurrence — "Run finished, but no saved output node ran — these 16
// images are previews … Add a SaveImage node"
//
// The original #2128 was Save3DAdvanced's unread `result` bag (fixed in 0.15.150).
// It reopened on comfyui-mcp 0.52.178 / panel 0.15.159: `panel_run` targeted at
// custom `NKDVideoViewer` with `save_output=true` completed, `/history` showed a
// persisted MP4 under the custom `nkd_video` key as `{filename, subfolder,
// type:"output"}` (e.g. `unionen-time-machine/test/NKD_test__v012.mp4`), and the
// completion frame still claimed no saved output node ran while describing 16
// preview taps.
//
// `nkd_video` matches neither the three literal media keys nor
// `/(?:images|gifs|videos)$/`, so `collectNodeOutputMedia` returned nothing for
// that node. The 16 taps are genuine `type:"temp"` PreviewImage frames, so
// `buildStillsSegment` inferred a claim about the whole RUN from the image set
// alone — the same false classification as the 3D case, one key over.
//
// THE SHAPE OF THE FIX. A saved (`type:"output"`) VIDEO descriptor under an
// unrecognised key joins `deliverable` so the existing storyboard path names it.
// `buildStillsSegment` is told about videos (and about withheld `type:"output"`
// files) the same way it was told about 3D/audio, so it stops saying "no saved
// output node ran". CompareFrames `a_images`/`b_images` temps stay withheld and
// a genuinely preview-only run still gets the original SaveImage advice.
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectNodeOutputMedia,
  isVideoMediaDescriptor,
  mergeWithheldMedia,
} from "../../web/js/lib/node-output-media.js";
import { parseHistoryEntry } from "../../web/js/lib/history-reconcile.js";
import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";

const NKD_FILENAME = "NKD_test__v012.mp4";
const NKD_SUBFOLDER = "unionen-time-machine/test";
const NKD_VIDEO_OUTPUT = {
  nkd_video: [{ filename: NKD_FILENAME, subfolder: NKD_SUBFOLDER, type: "output" }],
};

const PREVIEW_TAPS = Array.from({ length: 16 }, (_, i) => ({
  filename: `preview_${String(i).padStart(2, "0")}.png`,
  subfolder: "",
  type: "temp",
}));

function makeTracker() {
  const flushes = [];
  let clock = 1000;
  const timers = new Set();
  const tracker = createRunCompletionTracker({
    onFlush: (payload) => flushes.push(payload),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
  });
  return {
    tracker,
    flushes,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const frameDeps = (sent) => ({
  sendFrame: (f) => (sent.push(f), true),
  coerceMessageText: (s) => String(s ?? ""),
  formatDuration: (ms) => `${(ms / 1000).toFixed(1)}s`,
  formatClock: () => "12:00:00",
  imageViewUrl: (m) => `view://${m?.filename ?? "x"}`,
  agentReceivesImages: () => true,
  videoStoryboardEnabled: false,
  warn: () => {},
});

function isVideo(m) {
  return isVideoMediaDescriptor(m);
}

// ---------------------------------------------------------------------------
// 1. Collection — the reported `nkd_video` bag is a saved video, not a miss.
// ---------------------------------------------------------------------------

test("#2128 NKDVideoViewer nkd_video type:output MP4 is deliverable", () => {
  const got = collectNodeOutputMedia(NKD_VIDEO_OUTPUT);
  assert.equal(got.deliverable.length, 1, "the saved MP4 must join the video path");
  assert.equal(got.deliverable[0].filename, NKD_FILENAME);
  assert.equal(got.deliverable[0].subfolder, NKD_SUBFOLDER);
  assert.equal(got.deliverable[0].type, "output");
  assert.equal(got.withheld, null, "a single saved video is not a media-budget dump");
  assert.deepEqual(got.audio, []);
  assert.deepEqual(got.models3d, []);
});

test("#2128 nkd_video type:temp is ignored — save_output=false is not a save", () => {
  const got = collectNodeOutputMedia({
    nkd_video: [{ filename: NKD_FILENAME, subfolder: NKD_SUBFOLDER, type: "temp" }],
  });
  assert.deepEqual(got.deliverable, []);
  assert.equal(got.withheld, null);
});

test("#2128 a format:video/* descriptor on a custom key is a video even without an extension", () => {
  const got = collectNodeOutputMedia({
    nkd_video: [{ filename: "clip", subfolder: "", type: "output", format: "video/h264-mp4" }],
  });
  assert.equal(got.deliverable.length, 1);
  assert.equal(got.deliverable[0].filename, "clip");
});

test("#2128 an animated gif on a custom key stays off the video harvest", () => {
  const got = collectNodeOutputMedia({
    nkd_video: [{ filename: "loop.gif", subfolder: "", type: "output", format: "image/gif" }],
  });
  assert.deepEqual(got.deliverable, [], "image/gif must not be lifted onto the video path");
  assert.equal(got.withheld.outputCount, 1, "but it is still a saved output");
  assert.deepEqual(got.withheld.keys, ["nkd_video"]);
});

test("#2128 a custom-key saved non-video is withheld, not attached", () => {
  const got = collectNodeOutputMedia({
    nkd_file: [{ filename: "mesh.bin", subfolder: "out", type: "output" }],
  });
  assert.deepEqual(got.deliverable, [], "unknown media must not ride the frame");
  assert.equal(got.withheld.count, 1);
  assert.equal(got.withheld.outputCount, 1);
  assert.deepEqual(got.withheld.keys, ["nkd_file"]);
  assert.deepEqual(got.withheld.types, ["output"]);
});

test("#2128 an arbitrary array on an unrecognised key is still not media", () => {
  const got = collectNodeOutputMedia({
    nkd_video: ["not", "media"],
    notes: [{ text: "hello" }, { filename: "no-type.mp4" }],
  });
  assert.deepEqual(got.deliverable, []);
  assert.equal(got.withheld, null);
});

test("#2128 CompareFrames a_images stay withheld and are not deliverable", () => {
  const got = collectNodeOutputMedia({
    a_images: [{ filename: "a_00001.png", subfolder: "", type: "temp" }],
    b_images: [{ filename: "b_00001.png", subfolder: "", type: "temp" }],
  });
  assert.deepEqual(got.deliverable, []);
  assert.equal(got.withheld.count, 2);
  assert.equal(got.withheld.outputCount, undefined);
  assert.deepEqual(got.withheld.types, ["temp"]);
});

test("#2128 standard videos bag is unchanged — custom-key harvest does not steal it", () => {
  const got = collectNodeOutputMedia({
    videos: [{ filename: "vhs.mp4", type: "output" }],
    nkd_video: [{ filename: NKD_FILENAME, subfolder: NKD_SUBFOLDER, type: "output" }],
  });
  assert.equal(got.deliverable.length, 2);
  assert.deepEqual(
    got.deliverable.map((m) => m.filename),
    ["vhs.mp4", NKD_FILENAME],
  );
});

test("#2128 mergeWithheldMedia sums outputCount across nodes", () => {
  const a = collectNodeOutputMedia({
    nkd_file: [{ filename: "a.bin", type: "output" }],
  }).withheld;
  const b = collectNodeOutputMedia({
    other_file: [{ filename: "b.bin", type: "output" }],
  }).withheld;
  const merged = mergeWithheldMedia(a, b);
  assert.equal(merged.count, 2);
  assert.equal(merged.outputCount, 2);
  assert.deepEqual(merged.keys, ["nkd_file", "other_file"]);
});

// ---------------------------------------------------------------------------
// 2. History parse — /history recovery classifies the MP4 as a video.
// ---------------------------------------------------------------------------

test("#2128 parseHistoryEntry puts nkd_video MP4 on videos, not images", () => {
  const parsed = parseHistoryEntry(
    {
      outputs: {
        44: NKD_VIDEO_OUTPUT,
        9: { images: PREVIEW_TAPS },
      },
      status: { status_str: "success", completed: true },
    },
    { isVideo },
  );
  assert.equal(parsed.images.length, 16, "the preview taps stay images");
  assert.equal(parsed.videos.length, 1);
  assert.equal(parsed.videos[0].m.filename, NKD_FILENAME);
  assert.equal(parsed.videos[0].nodeId, "44");
  assert.equal(parsed.withheld, null);
});

// ---------------------------------------------------------------------------
// 3. Completion-frame classification — the reported sentence is gone.
// ---------------------------------------------------------------------------

test("#2128 THE REOPENED FRAME — 16 previews plus nkd_video no longer claims nothing was saved", async () => {
  const sent = [];
  const collected = collectNodeOutputMedia(NKD_VIDEO_OUTPUT);
  const frame = await composeRunCompletionFrame(
    {
      promptId: "63c30f2a-67c6-4e3d-955e-7c16466ec69a",
      images: PREVIEW_TAPS,
      videos: collected.deliverable.map((m) => ({ m, nodeId: "44" })),
      durationMs: 12_000,
    },
    frameDeps(sent),
  );

  assert.doesNotMatch(frame.note, /no saved output node ran/);
  assert.doesNotMatch(
    frame.note,
    /Add a SaveImage node to persist the result/,
    "SaveImage cannot persist an MP4",
  );
  assert.match(frame.note, /previews \(temporary, not a final file\)/);
  assert.match(frame.note, /also produced 1 video output/);
  assert.match(frame.note, /Do NOT add a SaveImage node/);
  assert.match(frame.note, /NKD_test__v012\.mp4/);
  assert.equal(frame.images.length, 16, "the preview taps are still delivered");
});

test("#2128 a withheld type:output custom file also retires the false no-save claim", async () => {
  const sent = [];
  const collected = collectNodeOutputMedia({
    nkd_file: [{ filename: "mesh.bin", subfolder: "out", type: "output" }],
  });
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-custom-file",
      images: PREVIEW_TAPS,
      videos: [],
      withheld: collected.withheld,
      durationMs: 1000,
    },
    frameDeps(sent),
  );
  assert.doesNotMatch(frame.note, /no saved output node ran/);
  assert.match(frame.note, /also produced 1 saved file output/);
  assert.match(frame.note, /`nkd_file`/);
});

test("#2128 CompareFrames temps do not suppress the genuine preview-only advice", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-cf-temps",
      images: PREVIEW_TAPS,
      videos: [],
      withheld: { count: 768, keys: ["a_images", "b_images"], types: ["temp"] },
      durationMs: 1000,
    },
    frameDeps(sent),
  );
  assert.match(frame.note, /no saved output node ran/);
  assert.match(frame.note, /Add a SaveImage node to persist the result/);
});

test("#2128 a genuinely preview-only run keeps the original advice", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    { promptId: "p-previews", images: PREVIEW_TAPS, videos: [], durationMs: 1000 },
    frameDeps(sent),
  );
  assert.match(frame.note, /no saved output node ran/);
  assert.match(frame.note, /Add a SaveImage node to persist the result/);
});

test("#2128 a preview video does not count as a saved output node", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-preview-video",
      images: PREVIEW_TAPS,
      videos: [{ m: { filename: "preview.mp4", subfolder: "", type: "temp" }, nodeId: "8" }],
      durationMs: 1000,
    },
    frameDeps(sent),
  );
  assert.match(frame.note, /no saved output node ran/);
});

test("#2128 a VHS videos bag plus preview taps also stops claiming nothing ran", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-vhs",
      images: PREVIEW_TAPS,
      videos: [{ m: { filename: "combine.mp4", subfolder: "", type: "output" }, nodeId: "8" }],
      durationMs: 4000,
    },
    frameDeps(sent),
  );
  assert.doesNotMatch(frame.note, /no saved output node ran/);
  assert.match(frame.note, /also produced 1 video output/);
});

// ---------------------------------------------------------------------------
// 4. Tracker — live panel_run of NKDVideoViewer flushes the MP4.
// ---------------------------------------------------------------------------

test("#2128 live NKDVideoViewer flush carries the MP4 on videos", () => {
  const h = makeTracker();
  const P = "prompt-nkd-live";
  const { deliverable, withheld } = collectNodeOutputMedia(NKD_VIDEO_OUTPUT);
  const videos = deliverable.filter(isVideo).map((m) => ({ m, nodeId: "44" }));
  const images = deliverable.filter((m) => !isVideo(m));

  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, { images: PREVIEW_TAPS });
  h.tracker.onExecuted(P, { images, videos, withheld });
  h.tracker.onExecutionSuccess(P);

  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].images.length, 16);
  assert.equal(h.flushes[0].videos.length, 1);
  assert.equal(h.flushes[0].videos[0].m.filename, NKD_FILENAME);
});

test("#2128 /history reconcile of NKDVideoViewer recovers the MP4 as a video", async () => {
  const h = makeTracker();
  const P = "prompt-nkd-hist";
  h.tracker.onQueued(P);
  await h.tracker.reconcile({
    fetchHistory: async () => ({
      status: { status_str: "success", completed: true },
      outputs: { 44: NKD_VIDEO_OUTPUT, 9: { images: PREVIEW_TAPS } },
    }),
    fetchQueued: async () => false,
    isVideo,
  });

  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].reconciled, true);
  assert.equal(h.flushes[0].videos.length, 1);
  assert.equal(h.flushes[0].videos[0].m.filename, NKD_FILENAME);
  assert.equal(h.flushes[0].images.length, 16);
});
