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
  h.tracker.onExecutingNull(); // queue idle ends run B
  assert.equal(h.flushes.length, 2);
  assert.deepEqual(
    h.flushes[1].images.map((m) => m.filename),
    ["run_b.png"],
    "run B is its own batch — outputs never merged with run A",
  );
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
  h.tracker.onExecutionError(P);
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
