import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCompletionDelivery,
  completionCompositionDiagnostic,
  COMPLETION_LATE_COMPOSITION_MS,
} from "../../web/js/lib/completion-delivery-diagnostics.js";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";

test("completion delivery diagnostics distinguish panel-observable outcomes", () => {
  assert.equal(classifyCompletionDelivery(), "never-sent");
  assert.equal(
    classifyCompletionDelivery({ frameEmitted: false }),
    "empty-no-frame",
  );
  assert.equal(classifyCompletionDelivery({ sendAttempted: true }), "transport-failure");
  assert.equal(
    classifyCompletionDelivery({
      sendAttempted: true,
      transportAccepted: true,
      compositionMs: COMPLETION_LATE_COMPOSITION_MS + 1,
    }),
    "late-composition",
  );
  assert.equal(
    classifyCompletionDelivery({
      sendAttempted: true,
      transportAccepted: true,
      compositionMs: COMPLETION_LATE_COMPOSITION_MS,
    }),
    "transport-accepted",
  );
});

test("an intentionally empty composer result is not classified as never-sent", async () => {
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-1781-empty",
      images: [],
      videos: [],
      durationMs: null,
      noMedia: false,
    },
    {
      now: () => new Date(1_000_000_000_000),
      formatClock: () => "12:00:00",
    },
  );

  assert.equal(frame, null);
  assert.equal(
    classifyCompletionDelivery({ frameEmitted: frame != null }),
    "empty-no-frame",
  );
  assert.notEqual(
    classifyCompletionDelivery({ frameEmitted: frame != null }),
    "never-sent",
  );
});

test("completion frames carry late-composition diagnostics without changing delivery", async () => {
  let nowMs = 1_000_000_000_000;
  const frames = [];
  const deps = {
    sendFrame: (frame) => {
      frames.push(frame);
      return true;
    },
    coerceMessageText: (value) => String(value ?? ""),
    formatDuration: (ms) => `${ms}ms`,
    formatClock: () => "12:00:00",
    imageViewUrl: (ref) => `/view?filename=${ref.filename}`,
    fetchImageBytes: async () => {
      nowMs += COMPLETION_LATE_COMPOSITION_MS + 1;
      return 100;
    },
    fetchImageDimensions: async () => ({ w: 64, h: 64 }),
    humanizeBytes: (bytes) => `${bytes} B`,
    buildVideoStoryboard: async () => null,
    uploadBlobToInput: async () => null,
    storyboardFrameCount: () => 1,
    paintImage: () => {},
    agentReceivesImages: () => true,
    now: () => new Date(nowMs),
    warn: () => {},
  };

  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-1781",
      images: [{ filename: "result.png", type: "output" }],
      videos: [],
      durationMs: 1,
    },
    deps,
  );

  assert.equal(frames.length, 1);
  assert.equal(frame, frames[0]);
  assert.equal(frame.prompt_id, "p-1781");
  assert.equal(frame.completion_diagnostics.source, "panel");
  assert.equal(frame.completion_diagnostics.composition_stage, "late-composition");
  assert.ok(frame.completion_diagnostics.composition_ms > COMPLETION_LATE_COMPOSITION_MS);
});

test("composition diagnostics normalize invalid or negative elapsed time", () => {
  assert.deepEqual(completionCompositionDiagnostic({ compositionMs: -4 }), {
    source: "panel",
    composition_ms: 0,
    composition_stage: "on-time",
  });
  assert.deepEqual(completionCompositionDiagnostic({ compositionMs: NaN }), {
    source: "panel",
    composition_ms: null,
    composition_stage: "on-time",
  });
});
