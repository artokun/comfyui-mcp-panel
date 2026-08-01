/**
 * Unit tests for the periodic run-completion SAFETY SWEEP (panel#356 Bug 2).
 *
 * The panel's reconnect reconcile is edge-triggered only; if the ComfyUI WS drops
 * and reopens during an idle gap WITHOUT a `reconnected` edge, the terminal
 * execution_success is missed and the agent stalls. This sweep re-runs the reconcile
 * on a timer while any run is pending. These lock: single-flight arming, re-arm only
 * while pending, self-disarm on drain, and — critically — that a dispose() landing
 * WHILE an async reconcile is in flight cannot resurrect the timer (the codex P1
 * unmount-resurrection leak).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createRunReconcileSweep } from "../../web/js/lib/run-reconcile-sweep.js";

// A controllable fake scheduler: timers fire only when we advance() past them.
function harness({ hasPending, reconcile, intervalMs = 100 } = {}) {
  let clock = 0;
  let seq = 0;
  const timers = new Map();
  const errors = [];
  const sweep = createRunReconcileSweep({
    hasPending,
    reconcile,
    onSweepError: (e) => errors.push(e),
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    intervalMs,
  });
  return {
    sweep,
    errors,
    timerCount: () => timers.size,
    // Fire every due timer (a fired timer may re-arm another); await async fns.
    tick: async () => {
      clock += intervalMs;
      const due = [...timers].filter(([, t]) => t.at <= clock);
      for (const [id, t] of due) {
        timers.delete(id);
        await t.fn();
      }
    },
  };
}

test("sweep: does not arm when nothing is pending", () => {
  const h = harness({ hasPending: () => false, reconcile: async () => {} });
  h.sweep.arm();
  assert.equal(h.sweep._hasTimer(), false);
  assert.equal(h.timerCount(), 0);
});

test("sweep: single-flight — repeated arm() schedules at most one timer", () => {
  const h = harness({ hasPending: () => true, reconcile: async () => {} });
  h.sweep.arm();
  h.sweep.arm();
  h.sweep.arm();
  assert.equal(h.timerCount(), 1, "only one timer despite three arms");
});

test("sweep: reconciles while pending, then self-disarms once the ledger drains", async () => {
  let pending = true;
  let reconciles = 0;
  const h = harness({
    hasPending: () => pending,
    reconcile: async () => {
      reconciles += 1;
      if (reconciles >= 2) pending = false; // recovered on the 2nd sweep
    },
  });
  h.sweep.arm();
  await h.tick(); // sweep 1 — still pending → re-arms
  assert.equal(h.sweep._hasTimer(), true, "re-armed while still pending");
  await h.tick(); // sweep 2 — drains → does NOT re-arm
  assert.equal(reconciles, 2);
  assert.equal(h.sweep._hasTimer(), false, "disarmed once pending drained");
  assert.equal(h.timerCount(), 0);
});

test("sweep: a reconcile that throws is caught and still re-arms while pending", async () => {
  let calls = 0;
  const h = harness({
    hasPending: () => calls < 2,
    reconcile: async () => {
      calls += 1;
      throw new Error("history 503");
    },
  });
  h.sweep.arm();
  await h.tick(); // throws → onSweepError → re-arm (still pending)
  assert.equal(h.errors.length, 1);
  assert.equal(h.sweep._hasTimer(), true, "re-armed despite the throw");
  await h.tick(); // calls===2 → hasPending false → disarm
  assert.equal(h.sweep._hasTimer(), false);
});

test("sweep: dispose() cancels a pending timer and blocks future arm()", () => {
  const h = harness({ hasPending: () => true, reconcile: async () => {} });
  h.sweep.arm();
  assert.equal(h.timerCount(), 1);
  h.sweep.dispose();
  assert.equal(h.timerCount(), 0, "dispose cleared the armed timer");
  h.sweep.arm();
  assert.equal(h.timerCount(), 0, "arm() after dispose is a no-op");
  assert.equal(h.sweep._isDisposed(), true);
});

test("sweep: dispose() DURING an in-flight reconcile does NOT resurrect the timer (codex P1 leak)", async () => {
  let releaseReconcile;
  const reconcileGate = new Promise((res) => {
    releaseReconcile = res;
  });
  let reconciles = 0;
  const h = harness({
    hasPending: () => true, // always pending — a naive finally would re-arm forever
    reconcile: async () => {
      reconciles += 1;
      await reconcileGate; // stay in-flight until we release it
    },
  });
  h.sweep.arm();
  // Fire the timer so the async reconcile starts and parks on the gate.
  const ticking = h.tick();
  // Unmount happens WHILE the reconcile await is in flight.
  h.sweep.dispose();
  // Let the reconcile finish; its finally must NOT re-arm because disposed is set.
  releaseReconcile();
  await ticking;
  assert.equal(reconciles, 1, "reconcile ran exactly once");
  assert.equal(h.sweep._hasTimer(), false, "no timer re-armed after dispose mid-await");
  assert.equal(h.timerCount(), 0, "sweep fully stopped — no resurrection leak");
});
