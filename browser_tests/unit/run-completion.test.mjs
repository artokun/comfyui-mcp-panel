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
import { createRunCompletionFlushHandler } from "../../web/js/lib/run-completion-delivery.js";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";
import { runCompletionKeyMatchesContext } from "../../web/js/lib/run-completion-persistence.js";

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
    // #1485 — this double used to be `{ fake: "blob" }`, and that is the exact
    // shape the composer must REFUSE: `storyboardFailure({reason})` is a truthy
    // plain object too, so a double that is truthy-but-not-a-Blob made the old
    // `if (!blob)` test look correct while production was uploading an
    // explanation to ComfyUI as `storyboard_<name>.png`. A sheet is the thing
    // with a numeric `size` (the test every consumer now applies), and
    // `paintedFrames` is what #648 requires a caller to describe it by — so the
    // double carries both, and the assertions below are unchanged.
    buildVideoStoryboard: async () => ({ size: 4096, paintedFrames: 20 }),
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

test("#1837 a repeat registration REUSES the run's identity — one finished run, one agent turn", () => {
  const h = makeHarness();
  const P = "repeat-registration";

  // Neither call supplies a completion key, so the tracker mints one. #1833 dropped
  // the `existingKey ||` term, and because createRunCompletionKey salts with
  // Date.now()+Math.random() the second call invented a SECOND identity for the same
  // prompt — an identity no orchestrator ticket ever opened. flushWithCompletionRecords
  // emits one frame per record, so a single finished run became two agent turns: the
  // exact symptom #1830 was filed about.
  const first = h.tracker.onQueued(P, { routeId: "route-a", sessionId: "session-a" });
  const second = h.tracker.onQueued(P, { routeId: "route-a", sessionId: "session-a" });
  assert.equal(second, first, "a repeat registration reports the identity the run already carries");
  assert.deepEqual(
    h.tracker.completionMetadata().map((row) => row.completionKey),
    [first],
    "minting must not add a second row the orchestrator never asked for",
  );

  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, imgs([img("repeat-registration.png")]));
  h.tracker.onExecutionSuccess(P);
  assert.deepEqual(
    h.flushes.map((payload) => payload.completionKey),
    [first],
    "ONE completion frame for one completed prompt",
  );

  // The single retained row still retires normally against its own receipt.
  assert.equal(h.tracker.acknowledgeDelivery(P, first), true);
  assert.equal(h.tracker.completionMetadata().length, 0);
  assert.equal(h.tracker.hasPending(), false);
});

test("#1837 a reused identity re-registered on another route/session does not duplicate", () => {
  const h = makeHarness();
  const P = "ctx-switch-prompt";

  // The identity tuple is [route, session, prompt, key], so reusing one key under a
  // second route/session would land as a DISTINCT record and flush a byte-identical
  // duplicate frame — strictly worse than the #1837 regression, since both copies
  // carry the same completion key and the agent cannot tell them apart.
  const first = h.tracker.onQueued(P, { routeId: "route-a", sessionId: "session-a" });
  h.tracker.onQueued(P, { routeId: "route-b", sessionId: "session-b" });
  assert.deepEqual(
    h.tracker.completionMetadata().map((row) => row.completionKey),
    [first],
    "one key is one receipt, whichever context re-registers it",
  );

  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, imgs([img("ctx-switch.png")]));
  h.tracker.onExecutionSuccess(P);
  assert.deepEqual(
    h.flushes.map((payload) => payload.completionKey),
    [first],
    "no byte-identical duplicate frame",
  );
});

test("#1830 keeps two same-prompt nonce rows and retires them by exact key", () => {
  const h = makeHarness();
  const P = "same-prompt";
  const keyA = JSON.stringify(["route-a", "session-a", P, "nonce-a"]);
  const keyB = JSON.stringify(["route-a", "session-a", P, "nonce-b"]);

  h.tracker.onQueued(P, { routeId: "route-a", sessionId: "session-a", completionKey: keyA });
  h.tracker.onQueued(P, { routeId: "route-a", sessionId: "session-a", completionKey: keyB });
  assert.deepEqual(
    h.tracker.completionMetadata().map((row) => row.completionKey),
    [keyA, keyB],
    "restoring/queueing the same prompt id does not overwrite the other nonce",
  );

  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, imgs([img("same-prompt.png")]));
  h.tracker.onExecutionSuccess(P);
  assert.deepEqual(
    h.flushes.map((payload) => payload.completionKey),
    [keyA, keyB],
    "the lifecycle sends one exact completion identity for each retained row",
  );

  assert.equal(h.tracker.acknowledgeDelivery(P, keyA), true);
  assert.deepEqual(h.tracker.completionMetadata().map((row) => row.completionKey), [keyB]);
  assert.equal(h.tracker.acknowledgeDelivery(P, keyA), false, "a stale duplicate receipt is harmless");
  assert.equal(h.tracker.acknowledgeDelivery(P, keyB), true);
  assert.equal(h.tracker.completionMetadata().length, 0);
  assert.equal(h.tracker.hasPending(), false);
});

test("#1830 lifecycle send fence rejects a session switch on the same route and retries exact identity", async () => {
  const { deps } = makeFrameDeps();
  const P = "session-switch-prompt";
  const completionKey = JSON.stringify(["route-a", "session-a", P, "nonce-a"]);
  let activeSession = "session-a";
  const rejected = [];
  const accepted = [];
  let tracker;
  const productionOnFlush = createRunCompletionFlushHandler({
    ...deps,
    sendFrame: (frame) => {
      if (!runCompletionKeyMatchesContext(frame.completion_key, "route-a", activeSession)) {
        rejected.push(frame);
        return false;
      }
      accepted.push(frame);
      return true;
    },
    markDelivered: (promptId, key) => tracker.markDelivered(promptId, key),
    markUndelivered: (promptId, key) => tracker.markUndelivered(promptId, key),
    pruneRebootMarker: () => {},
    isAgentMuted: () => false,
  });
  tracker = createRunCompletionTracker({
    onFlush: productionOnFlush,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  tracker.onQueued(P, { routeId: "route-a", sessionId: "session-a", completionKey });
  tracker.onExecutionStart(P);
  tracker.onExecuted(P, imgs([img("session-switch.png", "temp")]));
  tracker.onExecutionSuccess(P);
  activeSession = "session-b";
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(rejected.length, 1, "a same-route session switch rejects the in-flight completion");
  assert.equal(rejected[0].completion_key, completionKey);
  assert.equal(tracker.hasPending(), true, "the rejected completion remains recoverable");

  activeSession = "session-a";
  await tracker.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(accepted.length, 1, "the exact completion is retried once its original session returns");
  assert.equal(accepted[0].completion_key, completionKey);
  assert.equal(tracker.acknowledgeDelivery(P, completionKey), true);
  assert.equal(tracker.hasPending(), false);
});

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
  assert.equal(names[0], "final.png");
  assert.match(names[1], /^storyboard_v1_.+\.png$/);
  assert.match(names[2], /^storyboard_v2_.+\.png$/);
  assert.equal(names.length, 3, "one still + BOTH video storyboards consolidated into the single images array");
  // The note mentions the still result and both videos in one turn.
  assert.match(frames[0].note, /final\.png/, "note names the still output");
  assert.match(frames[0].note, /v1\.mp4/, "note names the first video");
  assert.match(frames[0].note, /v2\.mp4/, "note names the second video");
});

test("#1805: cache-assisted and real completion spans are labelled as workflow time", async () => {
  const formatDuration = (ms) => `${(ms / 1000).toFixed(1)}s`;

  // A cache-assisted prompt still has a real lifecycle span, but the panel does
  // not observe ComfyUI's execution_cached events and must not call that span a
  // render benchmark.
  const cached = makeHarness();
  cached.tracker.onExecutionStart("cached-prompt");
  cached.advance(5800);
  cached.tracker.onExecuted("cached-prompt", {
    videos: [{ m: { filename: "cached.mp4", type: "output" }, nodeId: "save" }],
  });
  cached.tracker.onExecutionSuccess("cached-prompt");
  assert.equal(cached.flushes[0].durationMs, 5800, "keep the measured workflow span");
  const cachedDeps = makeFrameDeps({ formatDuration });
  const cachedFrame = await composeRunCompletionFrame(cached.flushes[0], cachedDeps.deps);
  assert.match(cachedFrame.note, /workflow completed in 5\.8s/);
  assert.doesNotMatch(cachedFrame.note, /rendered in/);

  // The same wording applies when still metadata is unavailable and the
  // completion falls back to the batch-level duration line.
  const fallbackDeps = makeFrameDeps({
    formatDuration,
    fetchImageBytes: () => new Promise(() => {}),
    fetchImageDimensions: () => new Promise(() => {}),
    stillsMetadataTimeoutMs: 1,
  });
  const fallbackFrame = await composeRunCompletionFrame(
    { promptId: "cached-stills", images: [{ filename: "cached.png", type: "output" }], durationMs: 5800 },
    fallbackDeps.deps,
  );
  assert.match(fallbackFrame.note, /workflow completed in 5\.8s/);
  assert.doesNotMatch(fallbackFrame.note, /rendered in/);

  // A genuine long render keeps its full measured duration; only the misleading
  // render-time label changes.
  const rendered = makeHarness();
  rendered.tracker.onExecutionStart("rendered-prompt");
  rendered.advance(940000);
  rendered.tracker.onExecuted("rendered-prompt", {
    images: [{ filename: "rendered.png", type: "output" }],
  });
  rendered.tracker.onExecutionSuccess("rendered-prompt");
  assert.equal(rendered.flushes[0].durationMs, 940000, "preserve true render duration data");
  const renderedDeps = makeFrameDeps({ formatDuration });
  const renderedFrame = await composeRunCompletionFrame(rendered.flushes[0], renderedDeps.deps);
  assert.match(renderedFrame.note, /workflow completed in 940\.0s/);
  assert.doesNotMatch(renderedFrame.note, /rendered in/);
  assert.equal(renderedFrame.metadata[0].durationMs, 940000);
});

test("#1805 production event wiring: a cached completion reaches the agent frame as workflow time", async () => {
  const panelSrc = readFileSync(
    new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const onExecutedStart = panelSrc.indexOf("  function onExecuted(ev) {");
  const onExecutedEnd = panelSrc.indexOf("\n  function onExecError(ev)", onExecutedStart);
  const onExecutionSuccessStart = panelSrc.indexOf(
    "  function onExecutionSuccess(ev) {",
  );
  const onExecutionSuccessEnd = panelSrc.indexOf(
    "\n  // Primary render-duration start signal",
    onExecutionSuccessStart,
  );
  const onExecutionStart = panelSrc.indexOf(
    "  function onExecutionStart(ev) {",
  );
  const onExecutionStartEnd = panelSrc.indexOf(
    "\n  // Legacy/secondary run-end",
    onExecutionStart,
  );
  assert.ok(onExecutedStart >= 0 && onExecutedEnd > onExecutedStart);
  assert.ok(
    onExecutionSuccessStart >= 0 &&
      onExecutionSuccessEnd > onExecutionSuccessStart,
  );
  assert.ok(onExecutionStart >= 0 && onExecutionStartEnd > onExecutionStart);

  const createProductionHandlers = new Function(
    "imageViewUrl",
    "isVideoOutput",
    "isAudioOutput",
    "paintVideo",
    "paintAudio",
    "paintImage",
    "stripMisattachedExecutionPreviews",
    "app",
    "createStoryboardIdentity",
    "appendStoryboardCacheBust",
    "appendImageCacheBust",
    "NO_PROMPT_KEY",
    `return (runCompletion) => [
      (${panelSrc.slice(onExecutedStart, onExecutedEnd).trim()}),
      (${panelSrc.slice(
        onExecutionSuccessStart,
        onExecutionSuccessEnd,
      ).trim()}),
      (${panelSrc.slice(onExecutionStart, onExecutionStartEnd).trim()}),
    ];`,
  )(
    (media) => `view://${media.filename}`,
    () => false,
    () => false,
    () => {},
    () => {},
    () => {},
    () => {},
    { graph: {}, nodeOutputs: {}, nodePreviewImages: {} },
    () => "storyboard",
    (url) => url,
    // This harness asserts run bookkeeping, not URLs — the real helper is pinned
    // by inline-image-cache-bust.test.mjs. Kept identity-ish so the image refs
    // buffered below stay comparable.
    (url) => url,
  NO_PROMPT_KEY,
  );

  const registrationStart = panelSrc.indexOf(
    '    api.addEventListener("executed", onExecuted);',
  );
  const registrationEnd = panelSrc.indexOf("\n  } catch {", registrationStart);
  assert.ok(registrationStart >= 0 && registrationEnd > registrationStart);
  const listenerLines = panelSrc
    .slice(registrationStart, registrationEnd)
    .match(/    api\.addEventListener\("[^"]+", \w+\);/g);
  assert.ok(listenerLines);
  assert.ok(
    listenerLines.includes('    api.addEventListener("executed", onExecuted);'),
  );
  assert.ok(
    listenerLines.includes(
      '    api.addEventListener("execution_success", onExecutionSuccess);',
    ),
  );
  assert.ok(
    listenerLines.includes(
      '    api.addEventListener("execution_start", onExecutionStart);',
    ),
  );

  let now = 0;
  const frameDeps = makeFrameDeps({
    formatDuration: (durationMs) => `${(durationMs / 1000).toFixed(1)}s`,
  });
  let resolveFrame;
  const frameReady = new Promise((resolve) => {
    resolveFrame = resolve;
  });
  let runCompletion;
  let sentFrame = null;
  let pruneCount = 0;
  const productionOnFlush = createRunCompletionFlushHandler({
    ...frameDeps.deps,
    sendFrame: (frame) => {
      const ok = frameDeps.deps.sendFrame(frame);
      if (ok) sentFrame = frame;
      return ok;
    },
    markDelivered: (promptId) => runCompletion.markDelivered(promptId),
    markUndelivered: (promptId) => runCompletion.markUndelivered(promptId),
    pruneRebootMarker: () => {
      pruneCount += 1;
      if (sentFrame) resolveFrame(sentFrame);
    },
    isAgentMuted: () => false,
    now: () => Date.now(),
  });
  runCompletion = createRunCompletionTracker({
    onFlush: productionOnFlush,
    now: () => now,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const [onExecuted, onExecutionSuccess, onStart] =
    createProductionHandlers(runCompletion);

  const api = new EventTarget();
  let cachedSignalSeen = false;
  api.addEventListener("execution_cached", () => {
    cachedSignalSeen = true;
  });
  new Function(
    "api",
    "onExecuted",
    "onExecutionSuccess",
    "onExecutionStart",
    "onExecuting",
    "onExecError",
    "onComfyReconnecting",
    "onComfyReconnected",
    listenerLines.join("\n"),
  )(
    api,
    onExecuted,
    onExecutionSuccess,
    onStart,
    () => {},
    () => {},
    () => {},
    () => {},
  );

  const dispatch = (type, detail) => {
    const event = new Event(type);
    Object.defineProperty(event, "detail", { value: detail });
    api.dispatchEvent(event);
  };
  const promptId = "cached-production-path";
  dispatch("execution_start", { prompt_id: promptId });
  // The shipped wiring does not consume this provenance-only signal; it is
  // still delivered on the same API target before the normal completion events.
  dispatch("execution_cached", { prompt_id: promptId, nodes: ["sampler"] });
  now = 5800;
  dispatch("executed", {
    prompt_id: promptId,
    node: "save",
    output: { images: [{ filename: "cached.png", type: "output" }] },
  });
  dispatch("execution_success", { prompt_id: promptId });

  const frame = await frameReady;
  assert.equal(cachedSignalSeen, true);
  assert.equal(frameDeps.frames.length, 1);
  assert.equal(frame.type, "agent_event");
  assert.equal(frame.kind, "executed");
  assert.match(frame.note, /workflow completed in 5\.8s/);
  assert.doesNotMatch(frame.note, /rendered in/);
  assert.equal(pruneCount, 1);
  assert.equal(runCompletion.isSettled(promptId), true);
  assert.equal(runCompletion._delivered.has(promptId), true);
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
  const names = frames[0].images.map((m) => m.filename);
  assert.equal(names.length, 2, "both storyboards in the single frame");
  assert.match(names[0], /^storyboard_x_.+\.png$/);
  assert.match(names[1], /^storyboard_y_.+\.png$/);
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
  assert.match(uploadCalls[0].name, /^storyboard_clip_.+\.png$/);
  assert.equal(uploadCalls[0].opts?.type, "temp", "must request the temp namespace, not input/");

  // The resulting ImageRef must carry type:"temp" all the way into the sent
  // frame, so the chat preview resolves via /view?...&type=temp — never silently
  // falls back to type:"input" (which would defeat the fix even if the upload
  // call itself requested temp).
  const storyboardImg = frames[0].images.find((m) => /^storyboard_clip_.+\.png$/.test(m.filename));
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
    frame.images.some((m) => /^storyboard_clip_.+\.png$/.test(m.filename)),
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
      return { size: 4096, paintedFrames: 20 }; // #1485 — a Blob-shaped sheet, see makeFrameDeps

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
// so they cannot catch the panel's REAL delivery seam dropping the dep (the
// composer then defaults to always-sighted while the sendFrame gate still strips
// the pixels — the exact #609 hole). Pin the wiring by source inspection, the
// panel's established pattern for the giant module (cf. bridge-disconnect).
test("#609 wiring: the panel delivery seam feeds the gate's own blind predicate", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = src.indexOf("createRunCompletionFlushHandler({");
  assert.notEqual(start, -1, "could not locate the run-completion delivery seam");
  const end = src.indexOf("\n    }),\n    // #370: deliver a reconcile-discovered terminal ERROR", start);
  assert.notEqual(end, -1, "could not locate the end of the delivery seam");
  const callSite = src.slice(start, end);
  assert.match(
    callSite,
    /agentReceivesImages:\s*\(\)\s*=>\s*!AGENT_BLIND/,
    "the note's review request must be conditioned on the SAME blind flag the sendFrame gate strips by",
  );
});

// ---------------------------------------------------------------------------
// #986 — the SAME finished output re-announced as separate completions. Six in
// ~30s, each under a different prompt id with a sub-second "render" time, because
// the user re-queued from the canvas and ComfyUI served it from cache. The
// prompt-id fence cannot collapse genuinely different prompts; the OUTPUT is what
// repeats. These drive the real tracker, so the wiring is what is under test.
// ---------------------------------------------------------------------------

/** A harness that also captures suppressions and lets the dedupe window be set. */
function makeDedupeHarness({ duplicateWindowMs = 5 * 60 * 1000 } = {}) {
  let clock = 0;
  let seq = 0;
  const timers = new Map();
  const flushes = [];
  const tracker = createRunCompletionTracker({
    onFlush: (p) => flushes.push(p),
    duplicateWindowMs,
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return { tracker, flushes, advance: (ms) => (clock += ms) };
}

/** One canvas run that produces the given video and finishes. */
const canvasRun = (h, promptId, filename) => {
  h.tracker.onExecutionStart(promptId);
  h.tracker.onExecuted(promptId, { images: [], videos: [{ filename, subfolder: "", type: "output" }] });
  h.tracker.onExecutionSuccess(promptId);
};

test("#986: the reported burst — every repeat is DELIVERED, and every repeat is labelled", () => {
  const h = makeDedupeHarness();
  for (const id of ["2d9d64f5", "c3e90187", "c5184f9e", "4ce0a352", "740ff0f5", "aa11bb22"]) {
    canvasRun(h, id, "Video_00144.mp4");
    h.advance(5000); // the reported burst was ~30s across six
  }
  assert.equal(h.flushes.length, 6, "no result is ever swallowed");
  assert.equal(h.flushes[0].duplicateOf, undefined, "the first duplicates nothing");
  for (const f of h.flushes.slice(1)) {
    assert.equal(f.duplicateOf, "2d9d64f5", "each repeat names the delivery it duplicates");
    assert.equal(f.looksCached, true, "and says it did no real work — the 0.1s giveaway");
  }
});

test("#986: a PANEL-QUEUED run is delivered even when its output was already seen", () => {
  // panel_run promised the agent a notification and told it to end its turn.
  // Suppressing that wedges it forever — strictly worse than the duplicates.
  const h = makeDedupeHarness();
  canvasRun(h, "canvas-1", "same.mp4");
  assert.equal(h.flushes.length, 1);
  h.tracker.onQueued("panel-1");
  canvasRun(h, "panel-1", "same.mp4");
  assert.equal(h.flushes.length, 2, "the run the agent is waiting for always arrives");
  assert.equal(h.flushes[h.flushes.length-1].duplicateOf, undefined, "not labelled a duplicate");
});

test("#986: a DIFFERENT output is never collapsed into a previous one", () => {
  const h = makeDedupeHarness();
  canvasRun(h, "p1", "Video_00144.mp4");
  canvasRun(h, "p2", "Video_00145.mp4");
  assert.equal(h.flushes.length, 2);
  assert.equal(h.flushes[h.flushes.length-1].duplicateOf, undefined, "not labelled a duplicate");
});

test("#986: past the window, a deliberate re-render of the same file is a real event again", () => {
  const h = makeDedupeHarness({ duplicateWindowMs: 1000 });
  canvasRun(h, "p1", "same.mp4");
  h.advance(5000);
  canvasRun(h, "p2", "same.mp4");
  assert.equal(h.flushes.length, 2, "an hour-later re-render is not a duplicate");
});

test("#986: a REAL re-render overwriting the same filename is delivered and NOT called cached", () => {
  // The case that killed suppression: a fixed-name writer producing different bytes.
  const h = makeDedupeHarness({ duplicateWindowMs: 60 * 60 * 1000 });
  canvasRun(h, "first", "fixed.mp4");
  h.tracker.onExecutionStart("second");
  h.advance(600000);
  h.tracker.onExecuted("second", { images: [], videos: [{ filename: "fixed.mp4", subfolder: "", type: "output" }] });
  h.tracker.onExecutionSuccess("second");
  assert.equal(h.flushes.length, 2, "a real render always arrives");
  assert.equal(h.flushes[1].duplicateOf, "first", "the filename repeat is still disclosed");
  assert.equal(h.flushes[1].looksCached, false, "but it is NOT claimed to be a replay");
});

test("#986 (codex r3): a later `executing` must NOT upgrade a FABRICATED start to trusted", () => {
  // Partial frame loss: execution_start and the first node's `executing` are both
  // dropped, so `onExecuted` invents a timestamp. A later `executing` for a SECOND
  // output node used to mark that invented value trusted — making a genuine long
  // multi-output render look sub-second AND trusted, which is the shape that gets
  // suppressed. It must deliver.
  const h = makeDedupeHarness();
  // Seed: an earlier run announced the same fixed filename.
  canvasRun(h, "earlier", "fixed.mp4");
  assert.equal(h.flushes.length, 1);
  h.advance(1000);
  // The genuine second render, with its start frames lost.
  h.tracker.onExecuted("second", { images: [], videos: [{ filename: "fixed.mp4", subfolder: "", type: "output" }] });
  h.tracker.onExecutingNode("second", "node-2"); // later signal, different node
  h.tracker.onExecutionSuccess("second"); // finishes within the cache-hit threshold
  assert.equal(h.flushes.length, 2, "a real render is delivered even when its duration looks tiny");
  assert.equal(h.flushes[1].looksCached, false, "an INVENTED duration is never called a cache hit");
});

// ---------------------------------------------------------------------------
// comfyui-mcp#1739 — a successful panel run whose completion frame FAILED to
// send (bridge/socket churn around a workflow-tab switch re-hello) is re-pended
// by markUndelivered. But flush() retires runs OPTIMISTICALLY, so a safety-sweep
// tick in the async compose+send window sees an empty ledger and self-disarms —
// leaving the re-pended run in a ledger NOTHING sweeps until a real reconnect
// edge or the next queue (possibly never). The tracker now notifies the wiring
// (onRepend) on every re-pend so it can re-arm the sweep.
// ---------------------------------------------------------------------------

test("#1739: markUndelivered re-pend fires onRepend so recovery can be re-armed", () => {
  const repends = [];
  const tracker = createRunCompletionTracker({
    onFlush: () => {},
    onRepend: (id) => repends.push(id),
    // No-op scheduler: markDelivered schedules a fence-prune timer, and a REAL
    // one would hold the node process open for the whole fence TTL.
    setTimer: () => 0,
    clearTimer: () => {},
  });
  tracker.markUndelivered("prompt-x");
  assert.deepEqual(repends, ["prompt-x"], "the re-pend is announced with the run's id");
  assert.ok(tracker.hasPending(), "the run is genuinely back in the pending ledger");
});

test("#1739: a null id re-pends nothing and must NOT fire onRepend", () => {
  const repends = [];
  const tracker = createRunCompletionTracker({
    onFlush: () => {},
    onRepend: (id) => repends.push(id),
    // No-op scheduler: markDelivered schedules a fence-prune timer, and a REAL
    // one would hold the node process open for the whole fence TTL.
    setTimer: () => 0,
    clearTimer: () => {},
  });
  tracker.markUndelivered(null);
  assert.equal(repends.length, 0);
  assert.equal(tracker.hasPending(), false);
});

test("#1739: markDelivered is a confirmation, not a re-pend — it never fires onRepend", () => {
  const repends = [];
  const tracker = createRunCompletionTracker({
    onFlush: () => {},
    onRepend: (id) => repends.push(id),
    // No-op scheduler: markDelivered schedules a fence-prune timer, and a REAL
    // one would hold the node process open for the whole fence TTL.
    setTimer: () => 0,
    clearTimer: () => {},
  });
  tracker.markDelivered("prompt-x");
  assert.equal(repends.length, 0);
});

test("#1739 wiring: the panel re-arms the run-reconcile sweep on every re-pend", () => {
  // Behavioral tests above inject onRepend by hand; this pins the REAL call
  // site's wiring by source inspection — the established pattern for the giant
  // module (cf. the #609 wiring test above).
  const src = readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = src.indexOf("createRunCompletionTracker({");
  assert.notEqual(start, -1, "could not locate the createRunCompletionTracker call site");
  const end = src.indexOf("onFlush:", start);
  assert.notEqual(end, -1, "could not locate the onFlush option after the call site");
  const head = src.slice(start, end);
  assert.match(
    head,
    /onRepend:\s*\(\)\s*=>\s*\{[\s\S]*armRunReconcileSweepRef\?\.\(\)/,
    "a re-pended run must re-arm the safety sweep, or its completion can be lost forever",
  );
});
