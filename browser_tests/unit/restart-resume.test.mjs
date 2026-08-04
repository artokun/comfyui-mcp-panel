import test from "node:test";
import assert from "node:assert/strict";

import {
  adoptRebootRuns,
  decodeRebootMarker,
  encodeRebootMarker,
  planRebootResume,
  pruneRebootMarkerRaw,
  rebootMarkerAfterSend,
  stepRebootResume,
  unsettledRebootRuns,
  REBOOT_RESUME_MAX_WAIT_MS,
} from "../../web/js/lib/restart-resume.js";
import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";

// A real tracker with manual timers, so these tests exercise the ACTUAL delivery
// lifecycle rather than a hand-rolled stand-in for it. `fireTimers(ms)` runs the
// pending timers armed for that exact delay — used to trip the delivery watchdog.
function makeTracker(onFlush = () => {}) {
  const timers = new Set();
  const clock = { t: 1_000_000 };
  const tracker = createRunCompletionTracker({
    onFlush,
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
  });
  tracker._advance = (ms) => {
    clock.t += ms;
  };
  tracker._fireTimers = (ms) => {
    for (const t of [...timers]) {
      if (t.ms !== ms) continue;
      timers.delete(t);
      t.fn();
    }
  };
  return tracker;
}

const settledBy = (tracker) => (id) => tracker.isSettled(id);
const unconfirmedBy = (tracker) => (id) => tracker.isDeliveryUnconfirmed(id);
const DELIVERY_WATCHDOG_MS = 120000;

// ── the planner's own branches ────────────────────────────────────────────────

test("#585: no reboot marker never injects a restart-resume message", () => {
  assert.equal(planRebootResume({ rebootPending: false, unsettledRuns: ["a"] }), "none");
});

test("#585: a reboot with nothing owed resumes autonomously", () => {
  assert.equal(planRebootResume({ rebootPending: true, unsettledRuns: [] }), "resume");
});

test("#585: a reboot whose watched render is still owed a completion frame waits", () => {
  assert.equal(planRebootResume({ rebootPending: true, unsettledRuns: ["p1"] }), "wait_for_run");
});

// ── P1 #1 — the guard must survive a frontend RELOAD ──────────────────────────

test("#585 P1(reload): after a reload the fresh EMPTY ledger must not report the still-running render as finished", () => {
  // Pre-restart mount: render P is queued and running when the reboot is armed.
  const armed = makeTracker();
  armed.onQueued("P");
  armed.onExecutionStart("P");
  const raw = encodeRebootMarker({ at: 1000, runs: armed.unsettledPromptIds() });
  assert.deepEqual(decodeRebootMarker(raw).runs, ["P"], "the marker carries the SPECIFIC run id");

  // …the restart reloads the frontend. New mount ⇒ brand-new, EMPTY tracker; only
  // sessionStorage (the marker) survived.
  const fresh = makeTracker();
  assert.equal(
    fresh.isSettled("P"),
    true,
    "an id the fresh ledger never heard of owes nothing — exactly the trap the first fix fell into",
  );

  // Reload survival: re-adopt the PERSISTED ids before deciding anything.
  const adopted = adoptRebootRuns(decodeRebootMarker(raw).runs, fresh);
  assert.deepEqual(adopted, ["P"]);
  assert.equal(fresh.isSettled("P"), false);

  const step = stepRebootResume({ raw, isSettled: settledBy(fresh), nowMs: 1100 });
  assert.equal(step.decision, "wait_for_run", "a render still in flight must not be nudged over");
  assert.notEqual(step.nextRaw, null, "and the marker must survive the suppression");
});

test("#585 P1(reload): a still-unconfirmed run is not re-adopted within the SAME mount after its replay fence ages out", () => {
  // The terminal fence has a 10-minute TTL. Without the unconfirmed flag counting as
  // "known", a repeated ready ack past that TTL would re-adopt the run and let
  // reconcile dispatch its completion a second time.
  const t = makeTracker();
  t.onQueued("P");
  t.onExecutionStart("P");
  t.onExecuted("P", { images: [{ filename: "a.png" }] });
  t.onExecutionSuccess("P");
  t._fireTimers(DELIVERY_WATCHDOG_MS); // dispatched, never confirmed
  t._advance(11 * 60 * 1000);
  t.onQueued("other");
  t.markDelivered("other"); // drives a fence prune past the TTL
  assert.equal(t._terminal.has("P"), false, "the replay fence really did age out");
  assert.deepEqual(adoptRebootRuns(["P"], t), [], "…but the run is still KNOWN, so it is not re-adopted");
});

test("#585 P1(reload): adoption never resurrects a run this mount already resolved", () => {
  const t = makeTracker();
  t.onQueued("P");
  t.markDelivered("P"); // already reported to the agent on this mount
  const adopted = adoptRebootRuns(["P"], t);
  assert.deepEqual(adopted, [], "re-pending it would make /history deliver its completion a SECOND time");
  assert.equal(t.isSettled("P"), true);
});

// ── P1 #2 — correlation, not a global count; never clear while suppressing ─────

test("#585 P1(correlation): an UNRELATED render in flight must not swallow a legitimate resume", () => {
  const t = makeTracker();
  t.onQueued("B"); // a different workflow's render, not one we are waiting on
  // Nothing of ours was in flight when the reboot was armed.
  const raw = encodeRebootMarker({ at: 1000, runs: [] });
  assert.equal(t.hasPending(), true, "the GLOBAL predicate the first fix used is TRUE here");
  const step = stepRebootResume({ raw, isSettled: settledBy(t), nowMs: 1100 });
  assert.equal(step.decision, "resume", "…but no run WE are waiting on is owed, so the resume must fire");
  assert.equal(step.nextRaw, null);
});

test("#585 P1(correlation): suppressing RETAINS the marker, so the resume is reissued once the watched run settles", () => {
  const t = makeTracker();
  t.onQueued("P");
  let raw = encodeRebootMarker({ at: 1000, runs: ["P"] });

  const first = stepRebootResume({ raw, isSettled: settledBy(t), nowMs: 1100 });
  assert.equal(first.decision, "wait_for_run");
  assert.notEqual(
    first.nextRaw,
    null,
    "clearing the marker here is the SILENT failure — the user waits forever for a turn that never starts",
  );
  raw = first.nextRaw;

  // The watched render finally reports back and its frame reaches the agent.
  t.markDelivered("P");
  const second = stepRebootResume({ raw, isSettled: settledBy(t), nowMs: 1200 });
  assert.equal(second.decision, "resume", "the suppressed resume must be REISSUED, not lost");
  assert.equal(second.nextRaw, null, "and only now is the marker retired");
  assert.equal(second.marker.armedRunCount, 1, "the resume knows it waited, so it can say so truthfully");
});

test("#585 P1(correlation): a run re-pended after a failed send re-opens the wait", () => {
  const t = makeTracker();
  t.onQueued("P");
  t.markDelivered("P");
  const raw = encodeRebootMarker({ at: 1000, runs: ["P"] });
  assert.equal(stepRebootResume({ raw, isSettled: settledBy(t), nowMs: 1100 }).decision, "resume");
  t.markUndelivered("P"); // bridge was down — the agent was NOT told after all
  assert.equal(stepRebootResume({ raw, isSettled: settledBy(t), nowMs: 1100 }).decision, "wait_for_run");
});

test("#585: the persisted marker is pruned as watched runs settle, so a reload re-adopts only what is still owed", () => {
  const t = makeTracker();
  t.onQueued("A");
  t.onQueued("B");
  const raw = encodeRebootMarker({ at: 1000, runs: ["A", "B"] });
  t.markDelivered("A");
  const pruned = decodeRebootMarker(pruneRebootMarkerRaw(raw, settledBy(t)));
  assert.deepEqual(pruned.runs, ["B"]);
  assert.equal(pruned.armedRunCount, 2, "how many it waited on is not lost by pruning");
  assert.equal(pruned.at, 1000, "…nor is the arm time, which bounds the wait");
});

// ── P1 #3 — gate on DELIVERED, not on the pre-delivery optimistic retire ───────

test("#585 P1(delivery): a completion dispatched but not yet delivered still suppresses the resume", () => {
  const flushed = [];
  const t = makeTracker((p) => flushed.push(p));
  t.onQueued("P");
  t.onExecutionStart("P");
  t.onExecuted("P", { images: [{ filename: "a.png" }] });
  const raw = encodeRebootMarker({ at: 1000, runs: ["P"] });

  t.onExecutionSuccess("P");
  assert.equal(flushed.length, 1, "the batch was handed to the caller…");
  assert.equal(
    t.hasPending(),
    false,
    "…and the ledger retired it OPTIMISTICALLY, before the caller's async compose+send resolved",
  );
  assert.equal(t.isSettled("P"), false, "but NO frame has reached the agent yet");
  assert.equal(
    stepRebootResume({ raw, isSettled: settledBy(t), nowMs: 1100 }).decision,
    "wait_for_run",
    "a resume sent in this window arrives BEFORE the completion — the agent re-queues the render",
  );

  // The caller's compose+send finally resolves and confirms delivery.
  t.markDelivered("P");
  assert.equal(t.isSettled("P"), true);
  assert.equal(stepRebootResume({ raw, isSettled: settledBy(t), nowMs: 1200 }).decision, "resume");
});

test("#585 P1(delivery): a dispatched completion whose send FAILS goes back to owed, not settled", () => {
  const t = makeTracker();
  t.onQueued("P");
  t.onExecutionStart("P");
  t.onExecuted("P", { images: [{ filename: "a.png" }] });
  t.onExecutionSuccess("P");
  t.markUndelivered("P"); // bridge down
  assert.equal(t.isSettled("P"), false);
  assert.equal(t.unsettledPromptIds().includes("P"), true);
});

test("#585: a run mid-delivery is still reported by unsettledPromptIds, so arming a reboot then records it", () => {
  const t = makeTracker();
  t.onQueued("P");
  t.onExecutionStart("P");
  t.onExecuted("P", { images: [{ filename: "a.png" }] });
  t.onExecutionSuccess("P"); // dispatched, delivery unconfirmed
  assert.deepEqual(t.unsettledPromptIds(), ["P"]);
});

test("#585 P1(delivery): a dispatched completion the caller NEVER confirms must not be resumed over as if it had been delivered", () => {
  const t = makeTracker();
  t.onQueued("P");
  t.onExecutionStart("P");
  t.onExecuted("P", { images: [{ filename: "a.png" }] });
  t.onExecutionSuccess("P");
  const raw = encodeRebootMarker({ at: 1000, runs: ["P"] });

  // The caller's compose/send promise never settles. The watchdog must release the
  // block (otherwise the session strands) WITHOUT claiming the agent was told.
  t._fireTimers(DELIVERY_WATCHDOG_MS);
  assert.equal(t.isSettled("P"), true, "it must stop blocking — an eternal wait is the silent failure");
  assert.equal(t.isDeliveryUnconfirmed("P"), true, "…but delivery was never confirmed");

  const step = stepRebootResume({
    raw,
    isSettled: settledBy(t),
    isDeliveryUnconfirmed: unconfirmedBy(t),
    nowMs: 1100,
  });
  assert.equal(
    step.decision,
    "resume_unconfirmed",
    'a plain "resume" here tells the agent its result was already delivered — a false reassurance that invites the duplicate',
  );
  assert.deepEqual(step.owed, ["P"]);
});

test("#585 P1(delivery): an unconfirmed run is kept in the persisted marker while a DIFFERENT run is still owed", () => {
  const t = makeTracker();
  t.onQueued("A");
  t.onQueued("B");
  t.onExecutionStart("B");
  t.onExecuted("B", { images: [{ filename: "b.png" }] });
  t.onExecutionSuccess("B");
  t._fireTimers(DELIVERY_WATCHDOG_MS); // B: dispatched, never confirmed
  const raw = encodeRebootMarker({ at: 1000, runs: ["A", "B"] });

  const waiting = stepRebootResume({
    raw,
    isSettled: settledBy(t),
    isDeliveryUnconfirmed: unconfirmedBy(t),
    nowMs: 1100,
  });
  assert.equal(waiting.decision, "wait_for_run", "A is still owed");
  assert.deepEqual(
    decodeRebootMarker(waiting.nextRaw).runs,
    ["A", "B"],
    "dropping B here would erase the only evidence the eventual resume has to disclose",
  );

  t.markDelivered("A");
  const done = stepRebootResume({
    raw: waiting.nextRaw,
    isSettled: settledBy(t),
    isDeliveryUnconfirmed: unconfirmedBy(t),
    nowMs: 1200,
  });
  assert.equal(done.decision, "resume_unconfirmed");
});

test("#585 P1(delivery): a confirmed delivery clears the unconfirmed flag", () => {
  const t = makeTracker();
  t.onQueued("P");
  t.onExecutionStart("P");
  t.onExecuted("P", { images: [{ filename: "a.png" }] });
  t.onExecutionSuccess("P");
  t._fireTimers(DELIVERY_WATCHDOG_MS);
  t.markDelivered("P"); // the compose finally resolved after all
  assert.equal(t.isDeliveryUnconfirmed("P"), false);
  const raw = encodeRebootMarker({ at: 1000, runs: ["P"] });
  assert.equal(
    stepRebootResume({ raw, isSettled: settledBy(t), isDeliveryUnconfirmed: unconfirmedBy(t), nowMs: 1100 })
      .decision,
    "resume",
  );
});

test("#585 P1(delivery): the unconfirmed-delivery flag does not EXPIRE under the restart backstop's window", () => {
  // The fences age out on a 10-minute TTL; the restart resume may still be waiting
  // at 15 minutes. If the flag aged with them, a run whose frame never reached the
  // agent would silently read as delivered and get the reassuring resume.
  const t = makeTracker();
  t.onQueued("P");
  t.onExecutionStart("P");
  t.onExecuted("P", { images: [{ filename: "a.png" }] });
  t.onExecutionSuccess("P");
  t._fireTimers(DELIVERY_WATCHDOG_MS);
  assert.equal(t.isDeliveryUnconfirmed("P"), true);

  // Age the clock well past the fence TTL and run every age-based sweep the tracker
  // has: its own self-scheduled prune, plus the prune every terminal marking does.
  const FENCE_TTL_MS = 10 * 60 * 1000;
  t._advance(FENCE_TTL_MS * 2);
  t._fireTimers(FENCE_TTL_MS);
  t.onQueued("later");
  t.markDelivered("later"); // markDelivered ⇒ markTerminal ⇒ pruneFences
  assert.equal(t._terminal.has("P"), false, "the ordinary fences DID age out — the sweep really ran");

  assert.equal(t.isDeliveryUnconfirmed("P"), true, "the evidence must outlive the fence TTL");
  const raw = encodeRebootMarker({ at: 1000, runs: ["P"] });
  assert.equal(
    stepRebootResume({
      raw,
      isSettled: settledBy(t),
      isDeliveryUnconfirmed: unconfirmedBy(t),
      nowMs: 1000 + REBOOT_RESUME_MAX_WAIT_MS - 1,
    }).decision,
    "resume_unconfirmed",
  );
});

test("#585 P1(delivery): a give-up notice that never reached the agent is flagged, not treated as told", () => {
  // The give-up path EVICTS the run from the ledger, so unlike the error path there
  // is nothing to re-pend when its one frame is dropped.
  const t = makeTracker();
  t.onQueued("P");
  t.markDelivered("P"); // stand-in for the give-up eviction
  assert.equal(t.isSettled("P"), true);
  t.markDeliveryUnconfirmed("P"); // …but its notice could not be sent
  assert.equal(t.isSettled("P"), true, "it must not block — nothing will ever settle it");
  assert.equal(t.isDeliveryUnconfirmed("P"), true);
  const raw = encodeRebootMarker({ at: 1000, runs: ["P"] });
  assert.equal(
    stepRebootResume({ raw, isSettled: settledBy(t), isDeliveryUnconfirmed: unconfirmedBy(t), nowMs: 1100 })
      .decision,
    "resume_unconfirmed",
  );
});

// ── a resume the transport refused must not be retired ────────────────────────

test("#585 P1(send): a REFUSED send keeps the marker, so the resume is reissued instead of lost", () => {
  const step = { decision: "resume", marker: { at: 1000, runs: [], armedRunCount: 1 }, nextRaw: null };
  const kept = rebootMarkerAfterSend(step, false);
  assert.notEqual(kept, null, "a closed socket returns false — retiring the marker here strands the session");
  assert.equal(decodeRebootMarker(kept).armedRunCount, 1, "and the retained marker keeps its context");
  assert.equal(rebootMarkerAfterSend(step, true), null, "only a CONFIRMED send retires it");
});

test("#585 P1(send): a wait step's marker is retained regardless of any send outcome", () => {
  const step = {
    decision: "wait_for_run",
    marker: { at: 1000, runs: ["P"], armedRunCount: 1 },
    nextRaw: encodeRebootMarker({ at: 1000, runs: ["P"], armedRunCount: 1 }),
  };
  assert.equal(rebootMarkerAfterSend(step, false), step.nextRaw);
  assert.equal(rebootMarkerAfterSend(step, true), step.nextRaw);
});

// ── the bounded backstop: never strand silently ───────────────────────────────

test("#585: an outcome that cannot be determined within the wait budget RESUMES with a disclosure", () => {
  const t = makeTracker();
  t.onQueued("P");
  const raw = encodeRebootMarker({ at: 1000, runs: ["P"] });
  const step = stepRebootResume({
    raw,
    isSettled: settledBy(t),
    nowMs: 1000 + REBOOT_RESUME_MAX_WAIT_MS,
  });
  assert.equal(step.decision, "resume_unconfirmed", "a visible duplicate beats an invisible strand");
  assert.deepEqual(step.owed, ["P"], "and the resume names the run it could not confirm");
  assert.equal(step.nextRaw, null);
});

test("#585: the wait budget is measured from the persisted arm time, so a reload cannot restart it", () => {
  const t = makeTracker();
  t.onQueued("P");
  const raw = encodeRebootMarker({ at: 1000, runs: ["P"] });
  // A reload lands near the end of the budget; the marker, not the new mount, owns the clock.
  const reloaded = pruneRebootMarkerRaw(raw, settledBy(t));
  assert.equal(
    stepRebootResume({ raw: reloaded, isSettled: settledBy(t), nowMs: 1000 + REBOOT_RESUME_MAX_WAIT_MS })
      .decision,
    "resume_unconfirmed",
  );
});

// ── degraded markers must never strand ────────────────────────────────────────

test('#585: a legacy "1" marker (no recorded ids) resumes immediately rather than waiting forever', () => {
  const step = stepRebootResume({ raw: "1", isSettled: () => false, nowMs: 5000 });
  assert.equal(step.decision, "resume");
  assert.equal(step.nextRaw, null);
});

test("#585: a corrupt marker resumes rather than parking the session in silence", () => {
  for (const raw of ["{not json", "{}", "[]", '{"v":1,"runs":"nope"}']) {
    assert.equal(stepRebootResume({ raw, isSettled: () => false, nowMs: 5000 }).decision, "resume", raw);
  }
});

test("#585: no marker at all is not our ack", () => {
  assert.equal(stepRebootResume({ raw: null }).decision, "none");
  assert.equal(stepRebootResume({ raw: "" }).decision, "none");
});

test("#585: an unavailable tracker reports every watched run as owed — never nudge on a blind guess", () => {
  assert.deepEqual(unsettledRebootRuns(["a", "b"], undefined), ["a", "b"]);
  assert.deepEqual(
    unsettledRebootRuns(["a"], () => {
      throw new Error("tracker exploded");
    }),
    ["a"],
  );
});

test("#585: run ids normalize to strings so a numeric prompt_id survives the sessionStorage round-trip", () => {
  const raw = encodeRebootMarker({ at: 1, runs: [7, "7", null, undefined, 8] });
  assert.deepEqual(decodeRebootMarker(raw).runs, ["7", "8"]);
});
