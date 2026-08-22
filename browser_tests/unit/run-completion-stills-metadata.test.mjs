// panel#1610 — a finished stills render must notify the agent BEFORE the
// orchestrator's history fallback synthesises a completion of its own.
//
// THE REPORT. `panel_run(to_node_id=10)` finished successfully in ComfyUI and
// the panel's completion event never showed up; ~6 s later the orchestrator
// synthesised a success notice from history. Same notice, same ~5 s number,
// as #1485 — but this filing is a STILLS run, not a video.
//
// WHY THE PANEL LOSES THAT RACE. composeRunCompletionFrame does not send until
// every part of the one frame resolves. For stills that included a HEAD of
// /view (Content-Length) and an Image() decode (natural size) per final
// output, each bounded at 8 s inside the helpers. The orchestrator's
// `DEFAULT_SYNTHESIS_GRACE_MS` on 0.52.45 is 5 s. A stalled HEAD against a
// ComfyUI busy with the next job is enough for the watchdog to declare the
// panel silent while it is still composing — the stills twin of #1485, and
// the shape comfyui-mcp#2001 measured from the other side of the bridge.
//
// The panel's half: bound the metadata gather well under that grace, send the
// frame with the output refs it already has, and start the video storyboard
// without waiting for the HEAD. Fast probes still enrich the note.
//
// These drive the REAL composeRunCompletionFrame with injected deps. A
// source-regex pin of the timeout constant cannot promise the hung HEAD
// actually lets sendFrame fire.

import test from "node:test";
import assert from "node:assert/strict";

import {
  composeRunCompletionFrame,
  STILLS_METADATA_TIMEOUT_MS,
} from "../../web/js/lib/run-completion-frame.js";

function stillsPayload() {
  return {
    promptId: "p-1610",
    images: [{ filename: "ComfyUI_00010_.png", subfolder: "", type: "output" }],
    videos: [],
    durationMs: 3_100,
  };
}

function sheetBlob({ size = 4096, paintedFrames = 20 } = {}) {
  return { size, paintedFrames };
}

function makeDeps(overrides = {}) {
  const calls = { frames: [], sizeHeads: [], dimLoads: [], storyboards: [] };
  const deps = {
    sendFrame: (frame) => {
      calls.frames.push(frame);
      return true;
    },
    coerceMessageText: (v) => (typeof v === "string" ? v : v == null ? "" : String(v)),
    formatDuration: (ms) => `${Math.round(ms / 1000)}s`,
    formatClock: () => "11:13:07",
    imageViewUrl: (ref) => `/view?filename=${ref?.filename ?? ""}`,
    fetchImageBytes: async (url) => {
      calls.sizeHeads.push(url);
      return 2048;
    },
    fetchImageDimensions: async (url) => {
      calls.dimLoads.push(url);
      return { w: 512, h: 512 };
    },
    humanizeBytes: (n) => (n == null ? null : `${n} B`),
    buildVideoStoryboard: async (url) => {
      calls.storyboards.push(url);
      return sheetBlob();
    },
    uploadBlobToInput: async (_blob, name) => ({ filename: name, subfolder: "", type: "temp" }),
    storyboardFrameCount: () => 20,
    paintImage: () => {},
    videoStoryboardEnabled: true,
    agentReceivesImages: () => true,
    warn: () => {},
    ...overrides,
  };
  return { deps, calls };
}

test("#1610: the stills metadata bound is shorter than the orchestrator 5s grace", () => {
  // The bound exists to win DEFAULT_SYNTHESIS_GRACE_MS = 5_000 on 0.52.45.
  // A constant at or above that grace cannot be why the synthesised notice
  // stopped arriving.
  assert.ok(
    STILLS_METADATA_TIMEOUT_MS < 5_000,
    `stills metadata bound ${STILLS_METADATA_TIMEOUT_MS}ms must lose to a 5s grace, not beat it`,
  );
});

test("#1610: a stalled /view HEAD does not delay the stills completion past the metadata bound", async () => {
  const { deps, calls } = makeDeps({
    fetchImageBytes: () => new Promise(() => {}),
    fetchImageDimensions: () => new Promise(() => {}),
    stillsMetadataTimeoutMs: 25,
  });
  const t0 = Date.now();
  const frame = await composeRunCompletionFrame(stillsPayload(), deps);
  const elapsed = Date.now() - t0;

  assert.equal(calls.frames.length, 1, "the one completion frame is still sent");
  assert.equal(frame, calls.frames[0]);
  assert.equal(frame.type, "agent_event");
  assert.equal(frame.kind, "executed");
  assert.equal(frame.prompt_id, "p-1610");
  assert.equal(frame.images[0].filename, "ComfyUI_00010_.png", "the output ref the agent was promised still rides the frame");
  assert.match(frame.note, /ComfyUI_00010_\.png/, "the filename note does not wait on metadata");
  assert.ok(
    elapsed < 400,
    `a hung HEAD must not hold sendFrame; took ${elapsed}ms with a 25ms bound`,
  );
});

test("#1610: stills metadata that arrives in time still rides the note", async () => {
  const { deps, calls } = makeDeps();
  const frame = await composeRunCompletionFrame(stillsPayload(), deps);
  assert.equal(calls.frames.length, 1);
  assert.ok(calls.sizeHeads.length > 0, "the happy path still HEADs /view");
  assert.ok(calls.dimLoads.length > 0, "the happy path still reads dimensions");
  assert.match(frame.note, /2048 B/, "size reaches the note when the probe lands");
  assert.match(frame.note, /512×512/, "dimensions reach the note when the probe lands");
});

test("#1610: video storyboard starts while a stills HEAD is still in flight", async () => {
  // FAIL-before: stills ran to completion (including its metadata await) BEFORE
  // buildVideoStoryboard was called, so a HEAD that has not settled yet held
  // the sheet off the critical path of a mixed run as well.
  let releaseHead;
  const headHold = new Promise((resolve) => {
    releaseHead = resolve;
  });
  let storyboardStarted = false;
  const { deps, calls } = makeDeps({
    fetchImageBytes: () => headHold,
    fetchImageDimensions: () => headHold,
    buildVideoStoryboard: async () => {
      storyboardStarted = true;
      return sheetBlob();
    },
    // Long enough that a sequential compose would still be inside stills
    // metadata when we sample. Parallel compose must have started the sheet
    // already.
    stillsMetadataTimeoutMs: 5_000,
  });
  const done = composeRunCompletionFrame(
    {
      promptId: "p-1610-mixed",
      images: [{ filename: "final.png", type: "output" }],
      videos: [{ m: { filename: "clip.mp4", type: "output" }, nodeId: "10" }],
      durationMs: 8_000,
    },
    deps,
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    storyboardStarted,
    true,
    "the storyboard must start without waiting for the stills HEAD to settle",
  );
  releaseHead(2048);
  const frame = await done;
  assert.equal(calls.frames.length, 1);
  assert.ok(
    frame.images.some((m) => m.filename === "final.png"),
    "the still rides the mixed frame",
  );
  assert.ok(
    frame.images.some((m) => m.filename === "storyboard_clip.png"),
    "the sheet rides the mixed frame once the HEAD is released",
  );
});
