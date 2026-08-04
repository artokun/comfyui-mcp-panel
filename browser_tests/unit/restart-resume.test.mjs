import test from "node:test";
import assert from "node:assert/strict";

import {
  adoptRebootRuns,
  decodeRebootMarker,
  encodeRebootMarker,
  isRealBridgeDrop,
  planRebootResume,
  pruneRebootMarkerRaw,
  rebootMarkerAfterSend,
  rebootResumeRepeatWarning,
  rebootWaitBudget,
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
  assert.equal(planRebootResume({ rebootPending: true, unsettledRuns: ["p1"], waitedMs: 0 }), "wait_for_run");
});

test("#585 P1(unknown-elapsed): an UNKNOWN wait duration must not read as zero elapsed", () => {
  // Substituting 0 is a definite claim that no time has passed — and it is re-made
  // on every tick, so the 15-minute backstop never advances and the wait becomes
  // unbounded and silent. The mechanism built to prevent an indefinite wait would
  // be the thing guaranteeing one.
  for (const waitedMs of [undefined, null, NaN, Infinity, "0"]) {
    assert.equal(
      planRebootResume({ rebootPending: true, unsettledRuns: ["p1"], waitedMs }),
      "resume_unconfirmed",
      String(waitedMs),
    );
  }
  // An explicit, known zero is a real answer and still waits.
  assert.equal(planRebootResume({ rebootPending: true, unsettledRuns: ["p1"], waitedMs: 0 }), "wait_for_run");
});

test("#585 P1(unknown-elapsed): a marker with owed runs but NO arm time cannot park the session", () => {
  const raw = JSON.stringify({ v: 1, at: null, runs: ["P"], n: 1 });
  const step = stepRebootResume({ raw, isSettled: () => false, nowMs: 5000 });
  assert.equal(step.decision, "resume_unconfirmed", "an unbounded wait is the silent strand");
  assert.equal(step.nextRaw, null);
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

test("#585 P1(arm): a reboot armed AFTER the delivery watchdog still records the uncertain run", () => {
  // unsettledPromptIds is the arm-time snapshot, and the planner can only reason
  // about ids the marker carries. If a run whose delivery was never confirmed were
  // omitted, a reboot armed after the 120s watchdog would resume with the plain
  // "your result was already delivered" wording — the false reassurance again.
  const t = makeTracker();
  t.onQueued("P");
  t.onExecutionStart("P");
  t.onExecuted("P", { images: [{ filename: "a.png" }] });
  t.onExecutionSuccess("P");
  t._fireTimers(DELIVERY_WATCHDOG_MS);
  assert.equal(t.isSettled("P"), true, "it no longer blocks…");
  assert.deepEqual(t.unsettledPromptIds(), ["P"], "…but it is still not known to have been delivered");

  const raw = encodeRebootMarker({ at: 1000, runs: t.unsettledPromptIds() });
  assert.equal(
    stepRebootResume({ raw, isSettled: settledBy(t), isDeliveryUnconfirmed: unconfirmedBy(t), nowMs: 1100 })
      .decision,
    "resume_unconfirmed",
  );
});

test("#585: unsettledPromptIds never reports the same id twice across its three sources", () => {
  const t = makeTracker();
  t.onQueued("P");
  t.onExecutionStart("P");
  t.onExecuted("P", { images: [{ filename: "a.png" }] });
  t.onExecutionSuccess("P"); // pending-retired + awaitingDelivery
  assert.deepEqual(t.unsettledPromptIds(), ["P"]);
  t._fireTimers(DELIVERY_WATCHDOG_MS); // now unconfirmedDelivery
  assert.deepEqual(t.unsettledPromptIds(), ["P"]);
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

test("#585 P1(version): an UNRECOGNIZED marker version is not interpreted field by field", () => {
  // A future version — or a partial write that happens to still be valid JSON —
  // would otherwise have its `runs` trusted while its `at` was absent, and an
  // absent arm time is exactly what makes the wait unbounded.
  const future = JSON.stringify({ v: 2, runs: ["P"] });
  assert.deepEqual(decodeRebootMarker(future).runs, [], "runs from an unknown shape are not trusted");
  const step = stepRebootResume({ raw: future, isSettled: () => false, nowMs: 5000 });
  assert.equal(step.decision, "resume", "…and it degrades exactly like the legacy marker");
  assert.equal(step.nextRaw, null);
});

test("#585 P1(version): a v1 marker still round-trips every field", () => {
  const raw = encodeRebootMarker({ at: 1000, runs: ["P"], threadId: "t-A", sessionId: "s-A" });
  const m = decodeRebootMarker(raw);
  assert.equal(m.at, 1000);
  assert.deepEqual(m.runs, ["P"]);
  assert.equal(m.threadId, "t-A");
  assert.equal(m.sessionId, "s-A");
});

// ── the resume must reach the conversation that ASKED for the restart ─────────

test("#585 P1(session): switching conversations between arm and ack must not misdeliver the resume", () => {
  const t = makeTracker();
  // Conversation A arms the reboot with nothing in flight — it would resume at once.
  const raw = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A", sessionId: "s-A" });
  assert.equal(
    stepRebootResume({ raw, isSettled: settledBy(t), currentThreadId: "t-A", nowMs: 1100 }).decision,
    "resume",
    "on A, it resumes",
  );

  // …the user switches to conversation B before the ready ack lands.
  const onB = stepRebootResume({ raw, isSettled: settledBy(t), currentThreadId: "t-B", nowMs: 1100 });
  assert.equal(
    onB.decision,
    "wait_for_session",
    "B must NOT receive A's restart nudge — that is the duplicate-render hazard aimed at the wrong workflow",
  );
  assert.notEqual(onB.nextRaw, null, "and A's resume must not be lost while B is on screen");

  // Switching back delivers it, to A, intact.
  const backOnA = stepRebootResume({
    raw: onB.nextRaw,
    isSettled: settledBy(t),
    currentThreadId: "t-A",
    nowMs: 1200,
  });
  assert.equal(backOnA.decision, "resume");
  assert.equal(backOnA.marker.threadId, "t-A");
});

test("#585 P1(unknown-elapsed): a wrong-session marker with NO arm time HOLDS, it is not expired away", () => {
  // Substituting 0 for an unknown elapsed makes it never expire; substituting
  // infinity makes it always expire. Both manufacture a definite answer from an
  // absent one — and here the "always expired" direction DELETES a legitimate
  // resume that switching back to the arming conversation would have delivered.
  const raw = JSON.stringify({ v: 1, at: null, runs: [], n: 0, tid: "t-A", sid: null, t: 0 });
  const step = stepRebootResume({ raw, isSettled: () => true, currentThreadId: "t-B", nowMs: 9_999_999 });
  assert.equal(step.decision, "wait_for_session", "unknown must hold, not abandon");
  assert.notEqual(step.nextRaw, null, "and the marker must survive");

  // Switching back still delivers it.
  assert.equal(
    stepRebootResume({ raw: step.nextRaw, isSettled: () => true, currentThreadId: "t-A", nowMs: 9_999_999 })
      .decision,
    "resume",
  );
});

test("#585 P1(persisted-write): an attempt that could not be RECORDED still warns", () => {
  // `ssSet` returning is not evidence the write stuck — quota, private mode and
  // eviction fail silently. An increment that didn't persist reads back as "no
  // attempt yet", so a retry after a reload would go out as a first attempt with no
  // warning. Written is not persisted, exactly as sent is not received.
  assert.equal(
    rebootResumeRepeatWarning({ totalAttempts: 0, attemptRecorded: false }),
    true,
    "if storage cannot count attempts, we must assume there may have been one",
  );
  assert.equal(rebootResumeRepeatWarning({ totalAttempts: 1, attemptRecorded: true }), true);
  assert.equal(
    rebootResumeRepeatWarning({ totalAttempts: 0, attemptRecorded: true, sentThisMount: 1 }),
    true,
    "a send we made in this mount is storage-independent evidence",
  );
  for (const totalAttempts of [undefined, null, NaN, "1"]) {
    assert.equal(
      rebootResumeRepeatWarning({ totalAttempts, attemptRecorded: true }),
      true,
      `uncountable attempts (${String(totalAttempts)}) must warn`,
    );
  }
  assert.equal(
    rebootResumeRepeatWarning({ totalAttempts: 0, attemptRecorded: true, sentThisMount: 0 }),
    false,
    "a genuine, verified first attempt does not warn",
  );
  assert.equal(
    rebootResumeRepeatWarning({}),
    true,
    "and with no information at all the safe side is to warn — no parameter default may invent one",
  );
});

test("#585 P1(budget-vs-evidence): a bridge drop refreshes the BUDGET without erasing the duplicate evidence", () => {
  // These are two different facts and were one field. The retry budget is per
  // delivery episode and an observed drop legitimately refreshes it; "a nudge may
  // already be in the agent's queue" is monotonic and must survive every episode.
  // Conflated, a drop erased the evidence — and a resume that reached the
  // orchestrator but lost its receipt IN THAT DROP is exactly the case a later
  // undisclosed retry would duplicate.
  const afterTwoSends = decodeRebootMarker(
    encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A", attempts: 2, totalAttempts: 2 }),
  );
  assert.equal(afterTwoSends.attempts, 2);
  assert.equal(afterTwoSends.totalAttempts, 2);

  // The drop-gated refresh zeroes the episode budget only.
  const afterDrop = decodeRebootMarker(encodeRebootMarker({ ...afterTwoSends, attempts: 0 }));
  assert.equal(afterDrop.attempts, 0, "the budget is refreshed…");
  assert.equal(afterDrop.totalAttempts, 2, "…but the evidence is not erased");
  assert.equal(
    rebootResumeRepeatWarning({
      totalAttempts: afterDrop.totalAttempts,
      attemptRecorded: true,
      sentThisMount: 0, // a remount cleared the in-memory supplement
    }),
    true,
    "so the next attempt still discloses the possible duplicate",
  );
});

test("#585 P1(unknown-count): an absent or malformed attempt count is UNKNOWN, not a verified zero", () => {
  // Coercing it to 0 says "no attempt was ever made" on no evidence, and that is
  // precisely what suppresses the duplicate warning.
  for (const bad of [{}, { t: "2" }, { t: null }, { ts: {} }, { t: NaN, ts: NaN }]) {
    const m = decodeRebootMarker(JSON.stringify({ v: 1, at: 1000, runs: [], n: 0, ...bad }));
    assert.equal(m.totalAttempts, null, JSON.stringify(bad));
    assert.equal(
      rebootResumeRepeatWarning({ totalAttempts: m.totalAttempts, attemptRecorded: true, sentThisMount: 0 }),
      true,
      `an unknown count must warn (${JSON.stringify(bad)})`,
    );
  }
});

test("#585 P1(unknown-count): re-encoding an unknown count must not launder it into a zero", () => {
  // A retained marker is re-encoded on every wait tick, so a lossy round-trip would
  // convert "unknown" to "verified none" within seconds of the uncertainty arising.
  const unknown = decodeRebootMarker(JSON.stringify({ v: 1, at: 1000, runs: ["P"], n: 1 }));
  assert.equal(unknown.totalAttempts, null);
  const round = decodeRebootMarker(encodeRebootMarker({ ...unknown }));
  assert.equal(round.totalAttempts, null, "still unknown after a round-trip");
  assert.equal(round.attempts, null);

  // …and the wait path, which rewrites the marker, preserves it too.
  const held = stepRebootResume({
    raw: encodeRebootMarker({ ...unknown }),
    isSettled: () => false,
    nowMs: 1100,
  });
  assert.equal(held.decision, "wait_for_run");
  assert.equal(decodeRebootMarker(held.nextRaw).totalAttempts, null);
});

test("#585: a legacy marker with only the per-episode count still reports it as evidence", () => {
  // `ts` absent ⇒ fall back to `t` rather than to zero: an older marker that
  // recorded one attempt must not read as "never attempted".
  const m = decodeRebootMarker(JSON.stringify({ v: 1, at: 1000, runs: [], n: 0, t: 2 }));
  assert.equal(m.totalAttempts, 2);
});

test("#585 P1(budget): only a real drop refreshes the budget — a fresh mount's 'connecting' is not one", () => {
  // A freshly mounted client emits `connecting` before it has ever connected. If
  // that counted as a drop, a page RELOAD would manufacture one and refill the
  // persisted budget — so repeated reloads would mint unlimited nudges, defeating
  // the bound through the very event the persisted budget was meant to survive.
  assert.equal(isRealBridgeDrop({ everConnected: false, connected: false }), false, "never connected");
  assert.equal(isRealBridgeDrop({ everConnected: true, connected: false }), true, "a genuine transition");
  assert.equal(isRealBridgeDrop({ everConnected: true, connected: true }), false, "still up");
  assert.equal(isRealBridgeDrop({}), false, "absent evidence is not a drop");
  assert.equal(isRealBridgeDrop(), false);
});

test("#585: the wait budget is a TRI-STATE — within / spent / unknown", () => {
  assert.equal(rebootWaitBudget(0, 1000), "within");
  assert.equal(rebootWaitBudget(999, 1000), "within");
  assert.equal(rebootWaitBudget(1000, 1000), "spent");
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, "500"]) {
    assert.equal(rebootWaitBudget(bad, 1000), "unknown", String(bad));
  }
});

test("#585 P1(clock): a NEGATIVE elapsed is an unusable clock, not 'no time has passed'", () => {
  // A clock rollback (NTP correction, resume from suspend, the user changing the
  // system time) puts `at` and `now` on different timelines, so their difference
  // measures nothing. Clamping it to 0 would make the backstop wait for the wall
  // clock to catch up before it could ever fire — an unbounded, silent hold.
  assert.equal(rebootWaitBudget(-1, 900000), "unknown");
  assert.equal(rebootWaitBudget(-900000, 900000), "unknown");
  assert.equal(rebootWaitBudget(0, 900000), "within", "a real zero is still a real answer");

  // End to end: a marker armed "in the future" relative to now.
  const raw = encodeRebootMarker({ at: 5000, runs: ["P"] });
  assert.equal(
    stepRebootResume({ raw, isSettled: () => false, nowMs: 1000 }).decision,
    "resume_unconfirmed",
    "the disclosed exit, not an indefinite wait",
  );
});

test("#585 P1(clock): an unusable clock HOLDS a wrong-session marker rather than expiring it", () => {
  const raw = encodeRebootMarker({ at: 5000, runs: [], threadId: "t-A" });
  const step = stepRebootResume({ raw, isSettled: () => true, currentThreadId: "t-B", nowMs: 1000 });
  assert.equal(step.decision, "wait_for_session", "unknown holds on this path — never discards");
  assert.notEqual(step.nextRaw, null);
});

test("#585: a KNOWN-spent budget on a wrong-session marker still abandons it visibly", () => {
  const raw = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A" });
  assert.equal(
    stepRebootResume({
      raw,
      isSettled: () => true,
      currentThreadId: "t-B",
      nowMs: 1000 + REBOOT_RESUME_MAX_WAIT_MS,
    }).decision,
    "expired_wrong_session",
    "only a budget we KNOW is spent may abandon the resume",
  );
});

test("#585 P1(session): a resume held for an absent conversation is abandoned VISIBLY, never misdelivered", () => {
  const raw = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A" });
  const step = stepRebootResume({
    raw,
    isSettled: () => true,
    currentThreadId: "t-B",
    nowMs: 1000 + REBOOT_RESUME_MAX_WAIT_MS,
  });
  assert.equal(step.decision, "expired_wrong_session", "holding it forever would be the silent strand");
  assert.notEqual(step.decision, "resume", "…and sending it to B would be misdelivery");
  assert.equal(step.nextRaw, null);
});

test("#585 P1(session): the session hold outranks the run wait — a mismatch never sends, however settled", () => {
  const t = makeTracker();
  const raw = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A" });
  assert.equal(
    stepRebootResume({ raw, isSettled: settledBy(t), currentThreadId: null, nowMs: 1100 }).decision,
    "wait_for_session",
    "no conversation on screen is still not the ARMING conversation",
  );
});

test("#585 P1(session): a marker with no recorded conversation carries no constraint (legacy)", () => {
  const raw = encodeRebootMarker({ at: 1000, runs: [] });
  assert.equal(
    stepRebootResume({ raw, isSettled: () => true, currentThreadId: "t-anything", nowMs: 1100 }).decision,
    "resume",
  );
});

test("#585 P1(session): PRUNING a settled run must not drop the delivery target", () => {
  // Pruning runs on every confirmed delivery, so a field dropped here is dropped
  // almost immediately and permanently — and losing the arming conversation
  // silently converts the marker back into "deliver to whoever is on screen".
  const t = makeTracker();
  t.onQueued("A1");
  t.onQueued("B1");
  const raw = encodeRebootMarker({ at: 1000, runs: ["A1", "B1"], threadId: "t-A", sessionId: "s-A" });
  t.markDelivered("B1"); // an unrelated run settles and prunes the marker
  const pruned = pruneRebootMarkerRaw(raw, settledBy(t), unconfirmedBy(t));
  assert.deepEqual(decodeRebootMarker(pruned).runs, ["A1"]);
  assert.equal(decodeRebootMarker(pruned).threadId, "t-A", "the arming conversation must survive pruning");

  // …and the surviving marker still refuses to deliver to a different conversation.
  t.markDelivered("A1");
  assert.equal(
    stepRebootResume({ raw: pruned, isSettled: settledBy(t), currentThreadId: "t-B", nowMs: 1200 }).decision,
    "wait_for_session",
  );
});

test("#585 P1(receipt): the attempt count is PERSISTED, so a retry after a reload discloses itself", () => {
  const raw = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A", attempts: 1 });
  assert.equal(decodeRebootMarker(raw).attempts, 1);
  // …and it survives both round-trips the marker makes.
  const step = stepRebootResume({ raw, isSettled: () => true, currentThreadId: "t-A", nowMs: 1100 });
  assert.equal(step.marker.attempts, 1);
  const held = stepRebootResume({ raw, isSettled: () => true, currentThreadId: "t-B", nowMs: 1100 });
  assert.equal(decodeRebootMarker(held.nextRaw).attempts, 1, "a wrong-session hold keeps it too");
});

test("#585 P1(budget): the retry budget lives in the PERSISTED marker, so a reload cannot refill it", () => {
  // An in-memory counter starts at zero on a fresh mount, so after three
  // unacknowledged sends a reload would hand back a full budget — and repeated
  // reloads would mint unlimited duplicate "continue" nudges.
  const MAX = 3;
  let raw = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A", attempts: MAX });
  const afterReload = stepRebootResume({
    raw,
    isSettled: () => true,
    currentThreadId: "t-A",
    nowMs: 1100,
  });
  assert.equal(
    afterReload.marker.attempts,
    MAX,
    "the count the gate reads must survive the reload that reset every in-memory counter",
  );
  // …and it is carried by every rewrite the marker undergoes while waiting.
  const held = stepRebootResume({ raw, isSettled: () => true, currentThreadId: "t-B", nowMs: 1100 });
  assert.equal(decodeRebootMarker(held.nextRaw).attempts, MAX);
});

test("#585: every marker field survives a retain/prune round-trip", () => {
  const t = makeTracker();
  t.onQueued("X");
  t.onQueued("Y");
  const raw = encodeRebootMarker({
    at: 4242,
    runs: ["X", "Y"],
    armedRunCount: 2,
    threadId: "t-A",
    sessionId: "s-A",
    attempts: 2,
  });
  t.markDelivered("Y");
  const after = decodeRebootMarker(pruneRebootMarkerRaw(raw, settledBy(t), unconfirmedBy(t)));
  assert.deepEqual(
    { at: after.at, armedRunCount: after.armedRunCount, threadId: after.threadId, sessionId: after.sessionId, attempts: after.attempts },
    { at: 4242, armedRunCount: 2, threadId: "t-A", sessionId: "s-A", attempts: 2 },
  );
});

test("#585 P1(session): a REPLACED agent session is disclosed, never used to withhold the resume", () => {
  const raw = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A", sessionId: "s-old" });
  const step = stepRebootResume({
    raw,
    isSettled: () => true,
    currentThreadId: "t-A",
    currentSessionId: "s-new",
    sessionKnown: true,
    nowMs: 1100,
  });
  assert.equal(step.sessionState, "replaced", "the mismatch is reported…");
  assert.equal(
    step.decision,
    "resume",
    "…but never withheld: a session id legitimately changes across a resume, so refusing here would strand every ordinary restart",
  );
});

test("#585 P1(session): an UNKNOWN session is its own answer — never silently 'same'", () => {
  const withSid = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A", sessionId: "s-old" });
  const base = { isSettled: () => true, currentThreadId: "t-A", nowMs: 1100 };
  assert.equal(
    stepRebootResume({ ...base, raw: withSid, currentSessionId: null, sessionKnown: true }).sessionState,
    "unknown",
    "no current session id ⇒ cannot compare",
  );
  const noSid = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A" });
  assert.equal(
    stepRebootResume({ ...base, raw: noSid, currentSessionId: "s-new", sessionKnown: true }).sessionState,
    "unknown",
    "no armed session recorded ⇒ cannot compare",
  );
  assert.equal(
    stepRebootResume({ ...base, raw: withSid, currentSessionId: "s-old", sessionKnown: true }).sessionState,
    "same",
  );
});

test("#585 P1(session): before the orchestrator's session frame lands, the session is UNKNOWN, not 'same'", () => {
  // The `session` frame is not ordered against the "ready" ack that drives this
  // decision. If ready lands first, the id on hand is still the one we armed with —
  // a two-state check would confidently answer "same" for a session about to be
  // replaced, and send the ordinary undisclosed continuation.
  const raw = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A", sessionId: "s-old" });
  const step = stepRebootResume({
    raw,
    isSettled: () => true,
    currentThreadId: "t-A",
    currentSessionId: "s-old",
    sessionKnown: false,
    nowMs: 1100,
  });
  assert.equal(step.sessionState, "unknown");
  assert.equal(step.decision, "resume", "still delivered — the uncertainty is disclosed, not withheld");
});

test("#585 P1(send): a wait_for_session step retains its marker regardless of send outcome", () => {
  const raw = encodeRebootMarker({ at: 1000, runs: [], threadId: "t-A" });
  const step = stepRebootResume({ raw, isSettled: () => true, currentThreadId: "t-B", nowMs: 1100 });
  assert.equal(rebootMarkerAfterSend(step, false), step.nextRaw);
  assert.equal(rebootMarkerAfterSend(step, true), step.nextRaw);
});

test("#585 P1(receipt): a send the orchestrator never acknowledged must NOT retire the marker", () => {
  // sendUserMessage returns true the instant WebSocket.send() accepts the bytes;
  // the socket can close before the orchestrator reads them, and an abandoned
  // channel cannot testify that it wasn't. Only a receipt ack may retire it — so
  // the panel passes `false` here for every send and clears on the ack instead.
  const step = { decision: "resume", marker: { at: 1000, runs: [], armedRunCount: 0 }, nextRaw: null };
  assert.notEqual(
    rebootMarkerAfterSend(step, false),
    null,
    "handed-to-transport is not receipt — retiring here strands the resume permanently",
  );
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
