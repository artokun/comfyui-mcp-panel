/**
 * Unit tests for web/js/lib/run-completion.js — run with `node --test`.
 *
 * Guards the run-completion cluster (#293, #224, #200, #269, #468): completion
 * must fire on the AUTHORITATIVE ComfyUI lifecycle for the CURRENT prompt_id,
 * carry the FULL output batch with the correct start→finish duration, and never
 * flush a partial batch or a previous prompt's outputs.
 *
 * A fake clock + fake timer queue lets us drive the debounce deterministically:
 * pending timers only fire when we explicitly `tick()`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";

/** Deterministic scheduler: timers are held until tick() fires the due ones. */
function makeHarness({ debounceMs = 1500, maxRearms = 600 } = {}) {
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
  // Advance the clock by ms and fire every timer that comes due (re-armed timers
  // scheduled during the tick fire on later ticks, matching real setTimeout).
  const tick = (ms) => {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= clock) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  const advance = (ms) => {
    clock += ms;
  };
  return { tracker, flushes, tick, advance, pending: () => timers.size };
}

const img = (name, type = "output") => ({ filename: name, type });

test("#293: two output nodes >1.5s apart yield ONE complete event, not an early partial flush", () => {
  const h = makeHarness();
  const P = "prompt-A";
  h.tracker.onExecutionStart(P); // t=0
  h.tracker.onExecuted(P, [img("preview_5.png", "temp"), img("preview_6.png", "temp")]);
  // 20s pass while the KSampler runs — the debounce would have flushed a partial
  // batch at 1.5s under the old behaviour. It must NOT, because P is still active.
  h.tick(20000);
  assert.equal(h.flushes.length, 0, "no partial flush while prompt is in-flight");
  h.tracker.onExecuted(P, [img("final_15.png"), img("final_17.png")]);
  h.tracker.onExecutionSuccess(P); // authoritative run-end
  assert.equal(h.flushes.length, 1, "exactly one consolidated completion event");
  const f = h.flushes[0];
  assert.deepEqual(
    f.images.map((m) => m.filename),
    ["preview_5.png", "preview_6.png", "final_15.png", "final_17.png"],
    "full batch — all four outputs, not just the fast preview branch",
  );
  assert.equal(f.durationMs, 20000, "duration measured start→finish, not to the early flush");
});

test("#200: idle executing:null never truncates a mid-flight run", () => {
  const h = makeHarness();
  const P = "prompt-B";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, [img("canny_preview.png", "temp")]);
  // A spurious idle signal arrives while SaveImage is still seconds from writing.
  h.tracker.onExecutingNull();
  assert.equal(h.flushes.length, 0, "active prompt is not flushed by idle signal");
  h.tracker.onExecuted(P, [img("ComfyUI_00667_.png")]);
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
  h.tracker.onExecuted(A, [img("pelirroja_00002_.png")]);
  // Prior run's execution_success is missed (the failure conditions in #224).
  // The NEW run starting must flush A's buffer as A (its own), never carry it in.
  h.tracker.onExecutionStart(B);
  assert.equal(h.flushes.length, 1, "prior buffer flushed at new-run start");
  assert.equal(h.flushes[0].key, A, "attributed to the prior prompt, not the new one");
  h.tracker.onExecuted(B, [img("maria_pelirroja_00001_.png")]);
  h.tracker.onExecutionSuccess(B);
  assert.equal(h.flushes.length, 2);
  assert.equal(h.flushes[1].key, B);
  assert.deepEqual(
    h.flushes[1].images.map((m) => m.filename),
    ["maria_pelirroja_00001_.png"],
    "new run reports ONLY its own output",
  );
});

test("#269/#468: a completed run reliably fires exactly one completion event (resume trigger)", () => {
  const h = makeHarness();
  const P = "prompt-video";
  h.tracker.onExecutionStart(P);
  h.advance(134000); // ~134s render
  h.tracker.onExecuted(P, [img("LTX_00005.png")]);
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1, "completion fires — this is what wakes the agent/TODO");
  assert.equal(h.flushes[0].durationMs, 134000, "correct duration for the completed run");
  // No stray later flush from a lingering timer.
  h.tick(60000);
  assert.equal(h.flushes.length, 1, "no duplicate/late flush");
});

test("no bogus 0.0s duration: missing start yields null duration, never 0", () => {
  const h = makeHarness();
  const P = "prompt-no-start";
  // execution_start missed; first signal is the executed event.
  h.advance(5000);
  h.tracker.onExecuted(P, [img("x.png")]);
  h.advance(3000);
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1);
  // Start anchored at first executed (t=5000), finish at t=8000 ⇒ 3000ms — a real
  // measured span, never a fabricated 0.
  assert.equal(h.flushes[0].durationMs, 3000);
});

test("safety net: an interrupted run with no run-end signal still flushes (bounded re-arm)", () => {
  const h = makeHarness({ debounceMs: 1500, maxRearms: 3 });
  const P = "prompt-stranded";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, [img("stranded.png")]);
  // Prompt stays active and never signals end. The timer re-arms up to maxRearms
  // then flushes so images are never permanently stranded.
  h.tick(1500); // re-arm 1
  h.tick(1500); // re-arm 2
  h.tick(1500); // re-arm 3
  assert.equal(h.flushes.length, 0, "still re-arming while active, within budget");
  h.tick(1500); // budget exhausted -> flush
  assert.equal(h.flushes.length, 1, "flushes once the re-arm budget is spent");
  assert.deepEqual(h.flushes[0].images.map((m) => m.filename), ["stranded.png"]);
});

test("execution_error drops the buffer — no stale batch delivered", () => {
  const h = makeHarness();
  const P = "prompt-err";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, [img("half.png")]);
  h.tracker.onExecutionError(P);
  h.tracker.onExecutingNull();
  h.tick(10000);
  assert.equal(h.flushes.length, 0, "failed run delivers no completion batch");
});

test("empty buffer never emits a completion event", () => {
  const h = makeHarness();
  const P = "prompt-video-only";
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutionSuccess(P); // video-only: no inline images buffered
  assert.equal(h.flushes.length, 0);
});
