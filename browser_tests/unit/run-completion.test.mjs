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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  const uploadCalls = [];
  const deps = {
    sendFrame: (f) => frames.push(f),
    coerceMessageText: (v) => (v == null ? "" : typeof v === "string" ? v : String(v)),
    formatDuration: (ms) => (ms == null ? null : `${Math.round(ms / 1000)}s`),
    formatClock: () => "12:00:00",
    imageViewUrl: (m) => `view://${m?.filename ?? "x"}?type=${m?.type ?? "output"}`,
    fetchImageBytes: async () => 2048,
    fetchImageDimensions: async () => ({ w: 512, h: 512 }),
    humanizeBytes: (n) => (n == null ? null : `${n} B`),
    buildVideoStoryboard: async () => ({ fake: "blob" }),
    uploadBlobToInput: async (_blob, name, opts) => {
      uploadCalls.push({ name, opts });
      return { filename: name, type: opts?.type || "input" };
    },
    storyboardFrameCount: () => 20,
    paintImage: (url, name) => painted.push({ url, name }),
    videoStoryboardEnabled: true,
    warn: () => {},
    ...overrides,
  };
  return { deps, frames, painted, uploadCalls };
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

// #209 — the storyboard contact sheet is a panel-generated PREVIEW, never a
// real user input, so it must upload into ComfyUI's swept temp/ namespace
// (type:"temp") instead of permanently littering input/. FAIL-before: the OLD
// call site (`uploadBlobToInput(blob, name)`, no options) left `opts` undefined,
// so this test's stub would have recorded `opts: undefined` and the ImageRef
// would fall back to `type: "input"`.
test("#209 storyboard upload requests ComfyUI's temp namespace, never input/", async () => {
  const { deps, frames, uploadCalls } = makeFrameDeps();
  await composeRunCompletionFrame(
    {
      promptId: "p-storyboard-temp",
      images: [{ filename: "final.png", type: "output" }],
      videos: [{ m: { filename: "clip.mp4", type: "output" }, nodeId: "7" }],
      durationMs: 5000,
    },
    deps,
  );
  assert.equal(uploadCalls.length, 1, "one storyboard upload for the one video");
  assert.equal(uploadCalls[0].name, "storyboard_clip.png");
  assert.equal(uploadCalls[0].opts?.type, "temp", "must request the temp namespace, not input/");

  // The resulting ImageRef must carry type:"temp" all the way into the sent
  // frame, so the chat preview resolves via /view?...&type=temp — never silently
  // falls back to type:"input" (which would defeat the fix even if the upload
  // call itself requested temp).
  const storyboardImg = frames[0].images.find((m) => m.filename === "storyboard_clip.png");
  assert.ok(storyboardImg, "storyboard ref must be present in the sent frame");
  assert.equal(storyboardImg.type, "temp");
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

// ── #609: blind mode must not be asked for a visual verdict ────────────────
// With Blind ON, the sendFrame gate strips `images` from the agent_event — but
// the storyboard note still ordered the agent to "Review motion, sharpness, and
// temporal consistency", and the (vision-capable) agent confabulated a verdict
// on a sheet it never received. The review request is lawful ONLY when the
// pixels actually ride the frame; when withheld, the note must say so
// AFFIRMATIVELY (an explicit prohibition — a merely-absent request is not
// reliable) and name blind mode as the cause.

test("#609: blind mode (images withheld) — no review request, an explicit prohibition instead", async () => {
  const { deps, frames } = makeFrameDeps({ agentReceivesImages: () => false });
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-blind",
      images: [],
      videos: [{ m: { filename: "clip.mp4", type: "output" }, nodeId: "7" }],
      durationMs: 5000,
    },
    deps,
  );
  assert.equal(frames.length, 1);
  assert.doesNotMatch(
    frame.note,
    /Review motion, sharpness/,
    "must not order a visual review of a storyboard the agent never received",
  );
  // Assert the REASON, not just the absence: the note names blind mode as the
  // cause and prohibits the visual verdict outright.
  assert.match(frame.note, /Blind mode is ON/, "the withhold is disclosed, naming the cause");
  assert.match(frame.note, /NOT sent to you/, "the withhold itself is stated");
  assert.match(frame.note, /Do not comment on motion, sharpness, or visual quality/);
  // The factual half survives: the agent can still name the file and metadata.
  assert.match(frame.note, /clip\.mp4/, "the factual summary (file, metadata) still reaches the agent");
  // The storyboard is still produced for the USER (blind blinds the agent, not
  // the panel) — the ref rides the frame; the sendFrame gate strips it.
  assert.ok(
    frame.images.some((m) => m.filename === "storyboard_clip.png"),
    "the storyboard is still built for the user; only the agent-facing pixels are gated",
  );
});

test("#609: sighted mode (default) — the review request is unchanged", async () => {
  const { deps, frames } = makeFrameDeps();
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-sighted",
      images: [],
      videos: [{ m: { filename: "clip.mp4", type: "output" }, nodeId: "7" }],
      durationMs: 5000,
    },
    deps,
  );
  assert.match(
    frames[0].note,
    /frames run top-left→bottom-right = start→end\. Review motion, sharpness, and temporal consistency\./,
    "when the pixels DO reach the agent, the review request must survive verbatim",
  );
  assert.doesNotMatch(frame.note, /Blind mode is ON/);
});

test("#609: the sighted/blind decision is made NEAR SEND TIME (a mid-flush toggle is honored)", async () => {
  let sighted = true;
  const { deps, frames } = makeFrameDeps({
    agentReceivesImages: () => sighted,
    // Flip blind ON only once the storyboard upload is in flight — the decision
    // is made after every segment resolves, so a flush-start snapshot would
    // read the stale value.
    uploadBlobToInput: async (_blob, name, opts) => {
      sighted = false;
      return { filename: name, type: opts?.type || "input" };
    },
  });
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-toggle",
      images: [],
      videos: [{ m: { filename: "t.mp4", type: "output" }, nodeId: "7" }],
      durationMs: 5000,
    },
    deps,
  );
  assert.equal(frames.length, 1);
  assert.doesNotMatch(
    frame.note,
    /Review motion, sharpness/,
    "a flush-start snapshot would still ask for the review — the decision must be made after the segments resolve",
  );
  assert.match(frame.note, /Blind mode is ON/);
});

test("#609: ONE decision per frame — parallel segments can never disagree with each other or the gate", async () => {
  // codex gate finding: with a PER-SEGMENT read, a fast storyboard whose note
  // was already composed stays "Review…" while a slow one, still in flight when
  // Blind flips ON, says "NOT sent" — two segments of the SAME frame
  // contradicting each other, and the fast one contradicting the sendFrame gate
  // (which strips BOTH images at send time). The decision must be single and
  // made after the slowest segment, immediately before send.
  let sighted = true;
  const { deps, frames } = makeFrameDeps({
    agentReceivesImages: () => sighted,
    // fast.mp4's storyboard resolves immediately; slow.mp4's takes a real 20ms.
    buildVideoStoryboard: async (url) => {
      if (/slow/.test(url)) await new Promise((r) => setTimeout(r, 20));
      return { fake: "blob" };
    },
    // Blind flips ON during slow.mp4's upload — AFTER fast.mp4's whole segment
    // (including its note) was already built.
    uploadBlobToInput: async (_blob, name, opts) => {
      if (/slow/.test(name)) sighted = false;
      return { filename: name, type: opts?.type || "input" };
    },
  });
  const frame = await composeRunCompletionFrame(
    {
      promptId: "p-interleave",
      images: [],
      videos: [
        { m: { filename: "fast.mp4", type: "output" }, nodeId: "1" },
        { m: { filename: "slow.mp4", type: "output" }, nodeId: "2" },
      ],
      durationMs: 5000,
    },
    deps,
  );
  assert.equal(frames.length, 1);
  // The single decision was made after slow.mp4 resolved — Blind was ON by
  // then, so BOTH segments disclose, and NEITHER requests a review.
  assert.equal(
    frame.note.match(/Blind mode is ON/g)?.length,
    2,
    "both video segments must follow the SAME per-frame decision",
  );
  assert.doesNotMatch(
    frame.note,
    /Review motion, sharpness/,
    "the fast segment's pre-flip composition must not survive into the sent note",
  );
  assert.match(frame.note, /fast\.mp4/);
  assert.match(frame.note, /slow\.mp4/);
});

// #609 wiring: the behavioral tests above inject `agentReceivesImages` by hand,
// so they cannot catch the panel's REAL call site dropping the dep (the composer
// then defaults to always-sighted while the sendFrame gate still strips the
// pixels — the exact #609 hole). Pin the wiring by source inspection, the
// panel's established pattern for the giant module (cf. bridge-disconnect).
test("#609 wiring: the panel call site feeds the composer the gate's own blind predicate", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = src.indexOf("composeRunCompletionFrame(");
  assert.notEqual(start, -1, "could not locate the composeRunCompletionFrame call site");
  const end = src.indexOf(".then((frame)", start);
  assert.notEqual(end, -1, "could not locate the end of the call site");
  const callSite = src.slice(start, end);
  assert.match(
    callSite,
    /agentReceivesImages:\s*\(\)\s*=>\s*!AGENT_BLIND/,
    "the note's review request must be conditioned on the SAME blind flag the sendFrame gate strips by",
  );
});
