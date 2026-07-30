/**
 * Unit tests for web/js/lib/run-completion.js — run with `node --test`.
 *
 * Guards the run-completion cluster (#293, #224, #200, #269, #468): completion
 * must fire on the AUTHORITATIVE ComfyUI lifecycle for the CURRENT prompt_id,
 * carry the FULL output batch (stills AND videos) with the correct start→finish
 * duration and machine-readable attribution, and NEVER flush a partial batch, a
 * previous prompt's outputs, or an active (still-running) run.
 *
 * A fake clock + fake timer queue drives the debounce deterministically: pending
 * timers only fire when we explicitly `tick()`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createRunCompletionTracker,
  NO_PROMPT_KEY,
} from "../../web/js/lib/run-completion.js";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";

/** Deterministic scheduler: timers are held until tick() fires the due ones. */
function makeHarness({ debounceMs = 1500, maxRearms = 40 } = {}) {
  let clock = 0;
  let seq = 0;
  const timers = new Map(); // id -> { at, fn }
  const flushes = [];
  const tracker = createRunCompletionTracker({
    onFlush: (payload) => flushes.push(payload),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    debounceMs,
    maxRearms,
  });
  // Advance the clock and fire every timer that comes due (re-armed timers
  // scheduled during a tick fire in the same tick, matching real setTimeout with
  // a 0-progress clock — the loop drains until no timer is due).
  const tick = (ms) => {
    clock += ms;
    let guard = 0;
    let fired = true;
    while (fired) {
      fired = false;
      for (const [id, t] of [...timers]) {
        if (t.at <= clock) {
          timers.delete(id);
          fired = true;
          t.fn();
        }
      }
      if (++guard > 100000) throw new Error("timer loop runaway");
    }
  };
  const advance = (ms) => {
    clock += ms;
  };
  return { tracker, flushes, tick, advance, pending: () => timers.size };
}

const img = (name, type = "output") => ({ filename: name, type });
const imgs = (list) => ({ images: list });

test("#293: two output nodes >1.5s apart yield ONE complete event, not an early partial flush", () => {
  const h = makeHarness();
  const P = "prompt-A";
  h.tracker.onExecutionStart(P); // t=0
  h.tracker.onExecutingNode(P, "5");
  h.tracker.onExecuted(P, imgs([img("preview_5.png", "temp"), img("preview_6.png", "temp")]));
  // 20s pass while the KSampler runs — the debounce would have flushed a partial
  // batch at 1.5s under the old behaviour. It must NOT: P is active.
  h.tick(20000);
  assert.equal(h.flushes.length, 0, "no partial flush while prompt is in-flight");
  h.tracker.onExecuted(P, imgs([img("final_15.png"), img("final_17.png")]));
  h.tracker.onExecutionSuccess(P); // authoritative run-end
  assert.equal(h.flushes.length, 1, "exactly one consolidated completion event");
  const f = h.flushes[0];
  assert.deepEqual(
    f.images.map((m) => m.filename),
    ["preview_5.png", "preview_6.png", "final_15.png", "final_17.png"],
    "full batch — all four outputs, not just the fast preview branch",
  );
  assert.equal(f.durationMs, 20000, "duration measured start→finish, not to the early flush");
  assert.equal(f.promptId, P, "attributed to the correct prompt_id");
});

test("#293 long run: an active run far past the re-arm cap is never flushed partially", () => {
  const h = makeHarness({ debounceMs: 1500, maxRearms: 5 });
  const P = "prompt-long";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutingNode(P, "sampler");
  h.tracker.onExecuted(P, imgs([img("preview.png", "temp")]));
  // 30 minutes elapse — well past the re-arm churn cap. Still no flush: active.
  h.tick(30 * 60 * 1000);
  assert.equal(h.flushes.length, 0, "no partial flush for a legitimately long run");
  h.tracker.onExecuted(P, imgs([img("final.png")]));
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1);
  assert.deepEqual(h.flushes[0].images.map((m) => m.filename), ["preview.png", "final.png"]);
  assert.equal(h.flushes[0].durationMs, 30 * 60 * 1000, "full run duration");
});

test("#200: idle executing:null never truncates a mid-flight run", () => {
  const h = makeHarness();
  const P = "prompt-B";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutingNode(P, "canny");
  h.tracker.onExecuted(P, imgs([img("canny_preview.png", "temp")]));
  // The old code flushed a partial here; the timer must not either.
  h.tick(5000);
  assert.equal(h.flushes.length, 0);
  h.tracker.onExecuted(P, imgs([img("ComfyUI_00667_.png")]));
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1);
  assert.deepEqual(
    h.flushes[0].images.map((m) => m.filename),
    ["canny_preview.png", "ComfyUI_00667_.png"],
    "SaveImage output is included — the run was not truncated to the preview",
  );
});

test("#224: a new prompt does not inherit the prior run's buffered outputs", () => {
  const h = makeHarness();
  const A = "prompt-prev";
  const B = "prompt-new";
  h.tracker.onExecutionStart(A);
  h.tracker.onExecutingNode(A, "save");
  h.tracker.onExecuted(A, imgs([img("pelirroja_00002_.png")]));
  // Prior run's execution_success is MISSED (the #224 conditions). The NEW run
  // starting must flush A's buffer as A (its own), never carry it into B.
  h.tracker.onExecutionStart(B);
  assert.equal(h.flushes.length, 1, "prior buffer flushed at new-run start");
  assert.equal(h.flushes[0].promptId, A, "attributed to the prior prompt, not the new one");
  h.tracker.onExecuted(B, imgs([img("maria_pelirroja_00001_.png")]));
  h.tracker.onExecutionSuccess(B);
  assert.equal(h.flushes.length, 2);
  assert.equal(h.flushes[1].promptId, B);
  assert.deepEqual(
    h.flushes[1].images.map((m) => m.filename),
    ["maria_pelirroja_00001_.png"],
    "new run reports ONLY its own output",
  );
});

test("#224 missing prompt_id: back-to-back id-less runs do NOT merge", () => {
  const h = makeHarness();
  // Legacy/id-less: everything lands in __no_prompt__. A new run starting must
  // flush the prior __no_prompt__ buffer first so the two runs stay separate.
  h.tracker.onExecutionStart(undefined);
  h.tracker.onExecuted(undefined, imgs([img("run_a.png")]));
  h.tracker.onExecutionStart(undefined); // run B begins
  assert.equal(h.flushes.length, 1, "run A flushed at run B's start");
  assert.equal(h.flushes[0].key, NO_PROMPT_KEY);
  assert.deepEqual(h.flushes[0].images.map((m) => m.filename), ["run_a.png"]);
  h.tracker.onExecuted(undefined, imgs([img("run_b.png")]));
  h.tracker.onExecutionSuccess(undefined); // authoritative end of run B
  assert.equal(h.flushes.length, 2);
  assert.deepEqual(
    h.flushes[1].images.map((m) => m.filename),
    ["run_b.png"],
    "run B is its own batch — outputs never merged with run A",
  );
});

test("#200/#224: a spurious executing:null mid-run does NOT flush an active run", () => {
  const h = makeHarness();
  const P = "prompt-spurious-null";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutingNode(P, "canny");
  h.tracker.onExecuted(P, imgs([img("preview.png", "temp")]));
  // A stray null arrives while the KSampler is still running — must be ignored:
  // the prompt is active, so no early/partial completion.
  h.tracker.onExecutingNull();
  assert.equal(h.flushes.length, 0, "active run untouched by a spurious null");
  h.tracker.onExecuted(P, imgs([img("final.png")]));
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1, "single complete event on the authoritative end");
  assert.deepEqual(h.flushes[0].images.map((m) => m.filename), ["preview.png", "final.png"]);
});

test("missed execution_start: executing(node) keeps the timer from early-flushing", () => {
  const h = makeHarness();
  const P = "prompt-nostart";
  // No execution_start (dropped). executing(node) marks the prompt active.
  h.tracker.onExecutingNode(P, "n1");
  h.tracker.onExecuted(P, imgs([img("a.png", "temp")]));
  h.tick(10000); // debounce would have flushed a partial under the old model
  assert.equal(h.flushes.length, 0, "active via executing(node) — no early flush");
  h.tracker.onExecuted(P, imgs([img("b.png")]));
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1);
  assert.deepEqual(h.flushes[0].images.map((m) => m.filename), ["a.png", "b.png"]);
});

test("orphan safety net: outputs with NO start/executing still flush (never stranded)", () => {
  const h = makeHarness();
  const P = "prompt-orphan";
  // Only an executed frame arrives — no start, no executing(node). We have no
  // evidence it's running, so the timer flushes it as a last resort.
  h.tracker.onExecuted(P, imgs([img("orphan.png")]));
  assert.equal(h.flushes.length, 0, "buffered, waiting on the debounce");
  h.tick(1500);
  assert.equal(h.flushes.length, 1, "orphan flushed so images are never stranded");
  assert.deepEqual(h.flushes[0].images.map((m) => m.filename), ["orphan.png"]);
});

test("#269/#468: a completed run reliably fires exactly one completion event (resume trigger)", () => {
  const h = makeHarness();
  const P = "prompt-video";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutingNode(P, "ltx");
  h.advance(134000); // ~134s render
  // Video-only run: no still images, one video descriptor.
  h.tracker.onExecuted(P, {
    videos: [{ m: { filename: "LTX_00005.mp4", type: "output" }, nodeId: "49" }],
  });
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1, "completion fires — this is what wakes the agent/TODO");
  assert.equal(h.flushes[0].images.length, 0);
  assert.equal(h.flushes[0].videos.length, 1, "video routed through the authoritative lifecycle");
  assert.equal(h.flushes[0].videos[0].m.filename, "LTX_00005.mp4");
  assert.equal(h.flushes[0].durationMs, 134000, "correct start→finish duration for the video");
  // No stray later flush from a lingering timer.
  h.tick(60000);
  assert.equal(h.flushes.length, 1, "no duplicate/late flush");
});

test("video + stills in one run flush together as a single completion", () => {
  const h = makeHarness();
  const P = "prompt-mixed";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutingNode(P, "a");
  h.tracker.onExecuted(P, {
    images: [img("still.png")],
    videos: [{ m: { filename: "v.mp4", type: "output" }, nodeId: "7" }],
  });
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1, "one completion for the whole run");
  assert.equal(h.flushes[0].images.length, 1);
  assert.equal(h.flushes[0].videos.length, 1);
});

test("no bogus 0.0s duration: missing start yields a real span, never 0", () => {
  const h = makeHarness();
  const P = "prompt-no-start";
  // execution_start missed; first signal is the executed event (fallback start).
  h.advance(5000);
  h.tracker.onExecuted(P, imgs([img("x.png")]));
  h.advance(3000);
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1);
  // Start anchored at first executed (t=5000), finish at t=8000 ⇒ 3000ms — a real
  // measured span, never a fabricated 0.
  assert.equal(h.flushes[0].durationMs, 3000);
});

test("execution_error drops the buffer — no stale batch delivered", () => {
  const h = makeHarness();
  const P = "prompt-err";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutingNode(P, "x");
  h.tracker.onExecuted(P, imgs([img("half.png")]));
  h.tracker.onExecutionFailed(P);
  h.tracker.onExecutingNull();
  h.tick(10000);
  assert.equal(h.flushes.length, 0, "failed run delivers no completion batch");
});

test("empty completion (no buffered output) never emits an event", () => {
  const h = makeHarness();
  const P = "prompt-empty";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutionSuccess(P); // no executed at all
  assert.equal(h.flushes.length, 0);
});

test("execution_success + executing:null ordering yields exactly one event", () => {
  const h = makeHarness();
  const P = "prompt-order";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutingNode(P, "n");
  h.tracker.onExecuted(P, imgs([img("o.png")]));
  h.tracker.onExecutionSuccess(P); // flushes + clears
  h.tracker.onExecutingNull(); // buffer already gone → no-op
  assert.equal(h.flushes.length, 1, "no double delivery across the two end signals");
});

// ── Presentation layer: ONE combined agent_event per completed prompt ────────
// The tracker delivers ONE flush per prompt (asserted above). composeRunCompletionFrame
// (web/js/lib/run-completion-frame.js) turns that flush into the SINGLE outbound
// agent_event. This guards the #269/#468 blocker: a mixed / multi-video run must
// emit EXACTLY ONE completion frame carrying stills AND every video's storyboard,
// never a stills frame plus one frame per video.

/** Fake presentation deps — every I/O helper is deterministic and side-effect free. */
function makeFrameDeps(overrides = {}) {
  const frames = [];
  const painted = [];
  const deps = {
    sendFrame: (f) => frames.push(f),
    coerceMessageText: (v) => (v == null ? "" : typeof v === "string" ? v : String(v)),
    formatDuration: (ms) => (ms == null ? null : `${Math.round(ms / 1000)}s`),
    formatClock: () => "12:00:00",
    imageViewUrl: (m) => `view://${m?.filename ?? "x"}`,
    fetchImageBytes: async () => 2048,
    fetchImageDimensions: async () => ({ w: 512, h: 512 }),
    humanizeBytes: (n) => (n == null ? null : `${n} B`),
    buildVideoStoryboard: async () => ({ fake: "blob" }),
    uploadBlobToInput: async (_blob, name) => ({ filename: name, type: "input" }),
    storyboardFrameCount: () => 20,
    paintImage: (url, name) => painted.push({ url, name }),
    videoStoryboardEnabled: true,
    warn: () => {},
    ...overrides,
  };
  return { deps, frames, painted };
}

test("#269/#468 presentation: a MIXED run (stills + 2 videos) emits EXACTLY ONE agent_event with all outputs", async () => {
  const { deps, frames } = makeFrameDeps();
  const P = "prompt-mixed-multi";
  const frame = await composeRunCompletionFrame(
    {
      promptId: P,
      images: [{ filename: "final.png", type: "output" }],
      videos: [
        { m: { filename: "v1.mp4", type: "output" }, nodeId: "7" },
        { m: { filename: "v2.mp4", type: "output" }, nodeId: "9" },
      ],
      durationMs: 42000,
    },
    deps,
  );
  // The whole point: ONE send, not 1 stills + 1 per video (which was 3 before).
  assert.equal(frames.length, 1, "exactly one completion agent_event for the whole run");
  assert.equal(frames[0], frame, "returned frame is the one that was sent");
  assert.equal(frames[0].type, "agent_event");
  assert.equal(frames[0].kind, "executed");
  assert.equal(frames[0].prompt_id, P, "attributed to the finishing prompt");
  // All outputs ride in the single frame: the still + both storyboard refs.
  const names = frames[0].images.map((m) => m.filename);
  assert.deepEqual(
    names,
    ["final.png", "storyboard_v1.png", "storyboard_v2.png"],
    "one still + BOTH video storyboards consolidated into the single images array",
  );
  // The note mentions the still result and both videos in one turn.
  assert.match(frames[0].note, /final\.png/, "note names the still output");
  assert.match(frames[0].note, /v1\.mp4/, "note names the first video");
  assert.match(frames[0].note, /v2\.mp4/, "note names the second video");
});

test("presentation: a still-storyboard fallback (no blob) still yields ONE frame with the note", async () => {
  const { deps, frames } = makeFrameDeps({ buildVideoStoryboard: async () => null });
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-fallback",
      images: [{ filename: "s.png", type: "output" }],
      videos: [
        { m: { filename: "a.mp4", type: "output" }, nodeId: "1" },
        { m: { filename: "b.mp4", type: "output" }, nodeId: "2" },
      ],
      durationMs: 10000,
    },
    deps,
  );
  assert.equal(frames.length, 1, "still exactly one frame when storyboards fall back to note-only");
  // Only the still image rides along (no storyboard refs were produced).
  assert.deepEqual(frame.images.map((m) => m.filename), ["s.png"]);
  assert.match(frame.note, /a\.mp4/);
  assert.match(frame.note, /b\.mp4/);
});

test("presentation: a video-only run (2 videos) is still ONE frame", async () => {
  const { deps, frames } = makeFrameDeps();
  await composeRunCompletionFrame(
    {
      promptId: "p-video2",
      images: [],
      videos: [
        { m: { filename: "x.mp4", type: "output" }, nodeId: "1" },
        { m: { filename: "y.mp4", type: "output" }, nodeId: "2" },
      ],
      durationMs: 120000,
    },
    deps,
  );
  assert.equal(frames.length, 1, "two videos, one completion frame");
  assert.deepEqual(
    frames[0].images.map((m) => m.filename),
    ["storyboard_x.png", "storyboard_y.png"],
    "both storyboards in the single frame",
  );
});

test("presentation: an empty batch emits NO frame", async () => {
  const { deps, frames } = makeFrameDeps();
  const frame = await composeRunCompletionFrame(
    { promptId: "p-empty", images: [], videos: [], durationMs: 1000 },
    deps,
  );
  assert.equal(frame, null);
  assert.equal(frames.length, 0);
});

test("presentation: a STALLED storyboard upload still yields ONE frame (never wedges the completion)", async () => {
  // Regression for the consolidation risk: because the single frame awaits every
  // video segment, an unbounded upload must NOT be able to suppress the frame.
  // A very short REAL timeout bounds the never-settling upload deterministically.
  const { deps, frames } = makeFrameDeps({
    uploadBlobToInput: () => new Promise(() => {}), // never settles
    videoStoryboardTimeoutMs: 5,
  });
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-stall",
      images: [{ filename: "s.png", type: "output" }],
      videos: [
        { m: { filename: "a.mp4", type: "output" }, nodeId: "1" },
        { m: { filename: "b.mp4", type: "output" }, nodeId: "2" },
      ],
      durationMs: 5000,
    },
    deps,
  );
  assert.equal(frames.length, 1, "the single completion frame is sent despite the stalled upload");
  assert.equal(frame.images.length, 1, "only the still rides along (storyboards timed out)");
  assert.equal(frame.images[0].filename, "s.png");
  assert.match(frame.note, /timed out/, "each stalled video degrades to a note-only fallback");
  assert.match(frame.note, /a\.mp4/);
  assert.match(frame.note, /b\.mp4/);
});
