/**
 * panel#2234 — a refused completion retry must not fill ComfyUI/temp.
 *
 * Two deliberate behaviours combine into unbounded disk write when the bridge
 * is down: `releaseUnackedDelivery()` decrements the replay budget on a
 * transport refusal (#370 / #1739: a run whose frames are ALWAYS refused still
 * retries), and each retry used to mint a FRESH storyboard identity (#1718 /
 * #1834 cache-busting) so `storyboard_<base>_<identity>.png` was a new file
 * every 20 s sweep.
 *
 * The decrement stays. What these tests pin is the remaining hole: retries of
 * the SAME finished video record reuse the composed identity and skip
 * sample/upload, while a genuinely new completion still cache-busts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";
import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";
import { createRunCompletionFlushHandler } from "../../web/js/lib/run-completion-delivery.js";

function sheetBlob({ size = 4096, paintedFrames = 20, posterBlob } = {}) {
  const b = { size, paintedFrames };
  if (posterBlob !== undefined) b.posterBlob = posterBlob;
  return b;
}

function videoRecord() {
  return {
    m: { filename: "LOOP_HQ_00001_.mp4", subfolder: "", type: "output", format: "video/h264-mp4" },
    nodeId: 12,
  };
}

function videoPayload(overrides = {}) {
  return {
    promptId: "p-2234",
    images: [],
    videos: [videoRecord()],
    durationMs: 8000,
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const calls = { uploads: [], samples: [], painted: [], frames: [] };
  const deps = {
    sendFrame: (frame) => {
      calls.frames.push(frame);
      return false;
    },
    coerceMessageText: (v) => (typeof v === "string" ? v : v == null ? "" : String(v)),
    formatDuration: (ms) => `${Math.round(ms / 1000)}s`,
    formatClock: () => "1:51:14 AM",
    imageViewUrl: (ref) => `/view?filename=${ref?.filename ?? ""}`,
    fetchImageBytes: async () => 5_400_000,
    fetchImageDimensions: async () => null,
    humanizeBytes: (n) => (n == null ? null : `${n} B`),
    buildVideoStoryboard: async (url) => {
      calls.samples.push(url);
      return sheetBlob();
    },
    uploadBlobToInput: async (blob, name) => {
      calls.uploads.push({ name, blob });
      return { filename: name, subfolder: "", type: "temp" };
    },
    storyboardFrameCount: () => 20,
    paintImage: (url, caption) => calls.painted.push({ url, caption }),
    applyVideoPoster: () => {},
    videoStoryboardEnabled: true,
    agentReceivesImages: () => true,
    warn: () => {},
    videoStoryboardTimeoutMs: 25_000,
    ...overrides,
  };
  return { deps, calls };
}

function sheetNames(calls) {
  return calls.uploads.map((u) => u.name).filter((name) => name.startsWith("storyboard_"));
}

async function settle(turns = 8) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("#2234: refused retries of the SAME finished record reuse the identity and skip re-upload", async () => {
  const payload = videoPayload();
  const { deps, calls } = makeDeps({
    buildVideoStoryboard: async (url) => {
      calls.samples.push(url);
      return sheetBlob({ posterBlob: { size: 718_372 } });
    },
  });

  const first = await composeRunCompletionFrame(payload, deps);
  const second = await composeRunCompletionFrame(payload, deps);
  await settle(4);

  assert.equal(calls.samples.length, 1, "the source is sampled once — re-composing cannot change it");
  const sheets = sheetNames(calls);
  const posters = calls.uploads.map((u) => u.name).filter((name) => name.startsWith("poster_"));
  assert.equal(sheets.length, 1, "one temp storyboard filename, not one per retry");
  assert.equal(posters.length, 1, "the poster is uploaded once, under the same identity");
  assert.equal(first.images[0]?.filename, sheets[0]);
  assert.equal(second.images[0]?.filename, sheets[0], "the retry attaches the already-uploaded sheet");
  assert.match(sheets[0], new RegExp(`^storyboard_LOOP_HQ_00001__${payload.videos[0].storyboardIdentity}\\.png$`));
  assert.match(posters[0], new RegExp(`^poster_LOOP_HQ_00001__${payload.videos[0].storyboardIdentity}\\.png$`));
  assert.equal(calls.painted.length, 1, "the chat card is not re-painted on every sweep");
});

test("#2234: overlapping produces of the same record share one pipeline", async () => {
  let release;
  const payload = videoPayload();
  const { deps, calls } = makeDeps({
    buildVideoStoryboard: async (url) => {
      calls.samples.push(url);
      await new Promise((resolve) => {
        release = resolve;
      });
      return sheetBlob();
    },
  });

  const first = composeRunCompletionFrame(payload, deps);
  const second = composeRunCompletionFrame(payload, deps);
  await settle(4);
  assert.equal(typeof release, "function", "the first produce is waiting on the sample");
  release();
  const frames = await Promise.all([first, second]);

  assert.equal(calls.samples.length, 1, "a sweep that overlaps the first encode must not start a second");
  assert.equal(sheetNames(calls).length, 1);
  assert.equal(frames[0].images[0]?.filename, frames[1].images[0]?.filename);
});

test("#1718 CONTROL: a genuinely new completion still mints a fresh identity", async () => {
  const attempts = [];
  for (let i = 0; i < 2; i += 1) {
    const { deps, calls } = makeDeps({
      buildVideoStoryboard: async (url) => {
        attempts.push({ url });
        return sheetBlob();
      },
    });
    await composeRunCompletionFrame(videoPayload({ promptId: `p-2234-new-${i}` }), deps);
    attempts[i].name = sheetNames(calls)[0] ?? null;
  }
  assert.notEqual(attempts[0].url, attempts[1].url, "a new completion must not reuse the previous /view cache key");
  assert.notEqual(attempts[0].name, attempts[1].name, "a new completion must not reuse the previous temp filename");
});

test("#2234: a down-bridge history sweep keeps retrying the frame but writes the sheet once", async () => {
  const PROMPT = "9f0f7d2e-6c1a-49f0-9f0a-2234-loop";
  const ROUTE = "route-a";
  const SESSION = "sess-1";
  const VIDEO = { filename: "LOOP_HQ_00001_.mp4", subfolder: "", type: "output", format: "video/h264-mp4" };
  const HISTORY = {
    outputs: { 9: { gifs: [VIDEO] } },
    status: { status_str: "success", completed: true, messages: [] },
  };

  const uploads = [];
  const samples = [];
  const sendAttempts = [];
  let tracker;

  const onFlush = createRunCompletionFlushHandler({
    sendFrame: (frame) => {
      sendAttempts.push(frame);
      return false;
    },
    markDelivered: (promptId, completionKey) => tracker.markDelivered(promptId, completionKey),
    markUndelivered: (promptId, completionKey) => tracker.markUndelivered(promptId, completionKey),
    pruneRebootMarker: () => {},
    coerceMessageText: (v) => (v == null ? "" : typeof v === "string" ? v : String(v)),
    formatDuration: (ms) => (ms == null ? null : `${Math.round(ms / 1000)}s`),
    formatClock: () => "1:51:14 AM",
    imageViewUrl: (m) => `/view?filename=${m?.filename ?? "x"}`,
    fetchImageBytes: async () => 5_400_000,
    fetchImageDimensions: async () => null,
    humanizeBytes: (n) => (n == null ? null : `${n} B`),
    buildVideoStoryboard: async (url) => {
      samples.push(url);
      return sheetBlob();
    },
    uploadBlobToInput: async (_blob, name) => {
      uploads.push(name);
      return { filename: name, subfolder: "", type: "temp" };
    },
    storyboardFrameCount: () => 20,
    paintImage: () => {},
    applyVideoPoster: () => {},
    videoStoryboardEnabled: true,
    agentReceivesImages: () => true,
    isAgentMuted: () => false,
    warn: () => {},
  });

  tracker = createRunCompletionTracker({
    onFlush,
    setTimer: () => 0,
    clearTimer: () => {},
  });

  const completionKey = tracker.onQueued(PROMPT, { routeId: ROUTE, sessionId: SESSION });
  assert.ok(completionKey);

  const sweep = async () => {
    await tracker.reconcile({
      fetchHistory: async () => HISTORY,
      fetchQueued: async () => false,
      isVideo: (m) => /\.(mp4|webm|mov)$/i.test(String(m?.filename || "")),
    });
    await settle();
  };

  await sweep();
  assert.equal(sendAttempts.length, 1, "the first sweep still composes and attempts delivery");
  assert.equal(tracker.hasPending(), true, "a refusal re-pends — #370 / #1739 stay fail-closed");

  for (let tick = 0; tick < 8; tick += 1) await sweep();

  assert.ok(sendAttempts.length >= 2, "refused frames keep retrying; the decrement is not a cap");
  const sheets = uploads.filter((name) => name.startsWith("storyboard_"));
  const posters = uploads.filter((name) => name.startsWith("poster_"));
  assert.equal(new Set(sheets).size, 1, "temp storyboard filenames must not multiply across sweeps");
  assert.equal(sheets.length, 1, "the already-uploaded sheet is not written again");
  assert.equal(samples.length, 1, "the source video is not re-sampled every sweep");
  assert.equal(posters.length, 0, "no poster blob in this double, so none uploaded");
  assert.equal(tracker.hasPending(), true, "the run stays owed until something acknowledges it");
});
