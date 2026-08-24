// panel#356 Bug 2 — `panel_run` promises a completion notification that never arrives.
//
// THE REPORTED FAILURE, in the reporter's own words: panel_run returns
//
//   [IMPORTANT] You will be notified automatically with the output image(s)/video when
//   the render finishes — do NOT poll the queue, the history, or the output listing.
//   Just end your turn now and wait for the result to be delivered to you.
//
// (Paraphrased: the reporter's verbatim text named tools that have since been retired,
// and the vocabulary gate correctly refuses a dead tool name even inside a quotation.)
//
// …and then nothing arrives. They called it corrosive *because* the tool tells the agent
// to trust it and not poll: a dropped notification becomes an indefinite silent stall,
// the agent believes it is still rendering, and the only escape is the user prompting
// again. That is exactly right, and it is why silence here is a defect and not merely an
// omission — the PROMISE is what converts a missing event into a wedged agent.
//
// THE MECHANISM, for the clean 0.11.44 recurrence (cache hit, total_duration_ms: 3,
// status success, THREE TEXT OUTPUTS, nothing delivered). The completion path was gated
// on media in four places, and a text output is neither an image nor a video:
//
//   1. onExecuted            — `if (!images.length && !videos.length) return;`
//                              so a media-less `executed` never creates a buffer;
//   2. flush()               — `if (!buf) return;` then a second empty-batch guard;
//   3. reconcileOne()        — `if (hasBatch)` gates the flush, and it reports
//                              `delivered: hasBatch`, so the /history safety net built
//                              for #370/#468 could not recover this case either;
//   4. composeRunCompletionFrame — `return null`, which the call site reads as
//                              "empty batch ⇒ nothing to deliver ⇒ delivered".
//
// So the run was marked delivered and no frame was ever sent.
//
// SCOPE, and why it is not simply "always notify". `pending` looked like the set of
// agent-initiated runs but is NOT: onExecutionStart and onExecuted both call
// trackPending, so it holds every run observed on the socket, including ones the user
// started on the canvas. (An existing test caught that assumption.) Only `onQueued` —
// called from the panel's own queue path — marks a run the panel queued, which is
// exactly the set that carried the wait-for-it promise. A user's own media-less canvas
// run stays silent, so this adds no wakeups beyond the promise actually made.
import test from "node:test";
import assert from "node:assert/strict";

import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";

function makeTracker() {
  const flushes = [];
  let clock = 1000;
  const timers = new Set();
  const tracker = createRunCompletionTracker({
    onFlush: (payload) => flushes.push(payload),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
  });
  return {
    tracker,
    flushes,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const frameDeps = (sent) => ({
  sendFrame: (f) => (sent.push(f), true),
  coerceMessageText: (s) => String(s ?? ""),
  formatDuration: (ms) => `${(ms / 1000).toFixed(1)}s`,
  formatClock: () => "12:00:00",
  agentReceivesImages: () => true,
  warn: () => {},
});

// ---------------------------------------------------------------------------
// 1. The tracker: who gets a media-less completion, and who does not.
// ---------------------------------------------------------------------------

test("#356 a PANEL-QUEUED run that produces no media still flushes a completion", () => {
  const h = makeTracker();
  const P = "prompt-textonly";

  h.tracker.onQueued(P); // panel_run queued it — the promise was made here
  h.tracker.onExecutionStart(P);
  h.advance(3); // the reporter's cache hit: total_duration_ms 3
  h.tracker.onExecutionSuccess(P);

  assert.equal(h.flushes.length, 1, "the agent that was told to wait must be told it finished");
  assert.equal(h.flushes[0].promptId, P);
  assert.equal(h.flushes[0].noMedia, true);
  assert.deepEqual(h.flushes[0].images, []);
  assert.deepEqual(h.flushes[0].videos, []);
  assert.equal(h.flushes[0].durationMs, 3);
});

test("#356 a USER canvas run that produces no media stays silent", () => {
  // No onQueued: nothing promised this run would be reported, so reporting it would be
  // a new wakeup rather than a repaired one. This is the guard against turning a fix
  // into noise, and it is the whole reason the scope is `onQueued` and not `pending`.
  const h = makeTracker();
  const P = "prompt-user";

  h.tracker.onExecutionStart(P);
  h.tracker.onExecutionSuccess(P);

  assert.equal(h.flushes.length, 0);
});

test("#356 a panel-queued run WITH media is unchanged — one flush, media intact", () => {
  const h = makeTracker();
  const P = "prompt-media";

  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, { images: [{ filename: "out.png" }] });
  h.advance(2500);
  h.tracker.onExecutionSuccess(P);

  assert.equal(h.flushes.length, 1, "no extra media-less flush alongside the real one");
  assert.equal(h.flushes[0].images.length, 1);
  assert.notEqual(h.flushes[0].noMedia, true);
});

test("#356 a media-less completion is delivered EXACTLY once", () => {
  // execution_success and a trailing executing:null are both end signals; the terminal
  // fence must stop the second from producing a duplicate completion.
  const h = makeTracker();
  const P = "prompt-once";

  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutionSuccess(P);
  h.tracker.onExecutingNull();
  h.tracker.onExecutionSuccess(P); // replayed

  assert.equal(h.flushes.length, 1);
});

test("#1728 a terminal media-less success is emitted once when its late panel receipt arrives", () => {
  const h = makeTracker();
  const P = "prompt-late-panel-receipt";

  // execution_success wins the race: before #1728 this decided that the run was
  // an ordinary user canvas run because onQueued had not arrived yet.
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 0, "no promise existed before the late receipt");

  h.tracker.onQueued(P);
  assert.equal(h.flushes.length, 1, "the late receipt applies the panel_run promise");
  assert.equal(h.flushes[0].noMedia, true);

  // A duplicate /prompt capture and replayed lifecycle success cannot emit a
  // second completion: the terminal fence and one-shot retained outcome both hold.
  h.tracker.onQueued(P);
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1, "late receipt reconciliation is idempotent");
});

test("#1728 a late panel receipt cannot turn a media completion into a second empty frame", () => {
  const h = makeTracker();
  const P = "prompt-late-panel-media";

  h.tracker.onExecutionStart(P);
  h.tracker.onExecuted(P, { images: [{ filename: "out.png" }] });
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1);
  assert.equal(h.flushes[0].images.length, 1);

  h.tracker.onQueued(P);
  assert.equal(h.flushes.length, 1, "late capture does not double-queue a media run");
});

test("#356 a FAILED panel-queued run still delivers no completion batch", () => {
  // execution_error has its own reporting path; a media-less success note must not
  // start speaking for failures, which would report a crash as a clean finish.
  const h = makeTracker();
  const P = "prompt-failed";

  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutionFailed(P);

  assert.equal(h.flushes.length, 0);
});

// ---------------------------------------------------------------------------
// 2. The frame: what the agent actually receives.
// ---------------------------------------------------------------------------

test("#356 a noMedia flush composes and SENDS a frame", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    { promptId: "p1", images: [], videos: [], durationMs: 3, noMedia: true },
    frameDeps(sent),
  );

  assert.ok(frame, "a frame is produced");
  assert.equal(sent.length, 1, "and actually sent — composing without sending is the bug");
  assert.equal(frame.kind, "executed");
  assert.equal(frame.prompt_id, "p1");
  assert.deepEqual(frame.images, []);
});

test("#356 the note tells the agent this IS the completion, so it stops waiting", async () => {
  const sent = [];
  const { note } = await composeRunCompletionFrame(
    { promptId: "p1", images: [], videos: [], durationMs: 3000, noMedia: true },
    frameDeps(sent),
  );

  assert.match(note, /finished successfully/i);
  assert.match(note, /no image or video output/i);
  // The load-bearing sentence: without it an agent told "wait for media" may keep waiting
  // even after being handed this frame.
  assert.match(note, /This IS the completion you were told to wait for/i);
  assert.match(note, /3\.0s/, "the duration it took is reported");
});

test("#356 an empty compose WITHOUT the noMedia flag still returns null", async () => {
  // The call site treats null as "empty batch ⇒ already delivered". Every path that
  // relied on that contract keeps it; only a flush that declares itself media-less opts
  // into the new frame.
  const sent = [];
  const frame = await composeRunCompletionFrame(
    { promptId: "p1", images: [], videos: [], durationMs: 3 },
    frameDeps(sent),
  );

  assert.equal(frame, null);
  assert.deepEqual(sent, []);
});

test("#356 a run with no duration recorded omits the timing rather than inventing 0.0s", async () => {
  const sent = [];
  const { note } = await composeRunCompletionFrame(
    { promptId: "p1", images: [], videos: [], durationMs: null, noMedia: true },
    frameDeps(sent),
  );

  assert.doesNotMatch(note, /0\.0s/);
  assert.match(note, /finished successfully, and produced no image or video/i);
});

// ---------------------------------------------------------------------------
// 3. The /history recovery path — the safety net that could not catch this case.
// ---------------------------------------------------------------------------

const historyOf = (entry) => async () => entry;
const noQueue = async () => false;

test("#356 the /history reconcile recovers a media-less panel-queued run", async () => {
  // The live completion was missed (bridge down, WS drop). Before this fix
  // reconcileOne gated its flush on `hasBatch` and returned `delivered: false`, so
  // the mechanism built for #370/#468 to recover a lost completion structurally
  // could not recover the quietest kind of loss.
  const h = makeTracker();
  const P = "prompt-reconcile-textonly";

  h.tracker.onQueued(P);
  const res = await h.tracker.reconcile({
    fetchHistory: historyOf({ status: { status_str: "success", completed: true }, outputs: {} }),
    fetchQueued: noQueue,
  });

  assert.equal(h.flushes.length, 1, "the lost completion is recovered");
  assert.equal(h.flushes[0].noMedia, true);
  assert.equal(h.flushes[0].reconciled, true);
  assert.equal(res?.[0]?.delivered ?? res?.delivered, true, "and reported as delivered");
});

test("#356 an INTERRUPTED run is never reported as a successful completion", async () => {
  // ComfyUI records a manually stopped render as status_str:"error" plus an
  // execution_interrupted message. Telling the agent "finished successfully" for a
  // render the user cancelled would be a worse lie than the silence this fixes.
  const h = makeTracker();
  const P = "prompt-cancelled";

  h.tracker.onQueued(P);
  await h.tracker.reconcile({
    fetchHistory: historyOf({
      status: { status_str: "error", completed: true, messages: [["execution_interrupted", {}]] },
      outputs: {},
    }),
    fetchQueued: noQueue,
  });

  assert.equal(h.flushes.length, 0);
});

test("#356 a run still RUNNING in /history is not given a premature completion", async () => {
  // A non-terminal record must stay pending, not be reported as finished-with-no-media.
  const h = makeTracker();
  const P = "prompt-running";

  h.tracker.onQueued(P);
  await h.tracker.reconcile({
    fetchHistory: historyOf({ status: { status_str: "running" }, outputs: {} }),
    fetchQueued: noQueue,
  });

  assert.equal(h.flushes.length, 0);
});

test("#356 a media-less completion the bridge DROPPED is redelivered on reconcile", async () => {
  // Codex review finding. The tracker's own markDelivered is OPTIMISTIC — flush and
  // execution_success both call it before the caller has confirmed the frame reached
  // the agent — and markUndelivered re-pends the run when sendFrame reports the bridge
  // was down. If the panel-queued mark were retired by that optimistic call, the
  // re-pended run would look like an ordinary canvas run on the way back and stay
  // silent forever: the exact stall this issue is about, reintroduced one layer down.
  const h = makeTracker();
  const P = "prompt-bridge-down";

  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutionSuccess(P);
  assert.equal(h.flushes.length, 1, "the live completion was composed");
  assert.equal(h.flushes[0].noMedia, true);

  h.tracker.markUndelivered(P); // sendFrame said the bridge was down

  const res = await h.tracker.reconcile({
    fetchHistory: historyOf({ status: { status_str: "success", completed: true }, outputs: {} }),
    fetchQueued: noQueue,
  });

  assert.equal(h.flushes.length, 2, "the dropped completion is recovered, not lost");
  assert.equal(h.flushes[1].noMedia, true);
  assert.equal(h.flushes[1].reconciled, true);
  assert.equal(res?.[0]?.delivered, true);
});

test("#356 a replayed success after a CONFIRMED delivery makes no second completion", () => {
  // The counterpart to the re-pend case: once the caller confirms the agent was told,
  // a replayed lifecycle event must not manufacture a duplicate.
  //
  // Honest note on what this does and does not prove. Mutation testing showed the
  // guarantee here comes from the `terminal` fence, NOT from retiring the panel-queued
  // mark on confirmation — deleting that line leaves this test green. The retire is a
  // MEMORY-BOUNDING measure (the set would otherwise keep confirmed keys for the
  // session), and its absence is not observable through the public API, so it is
  // deliberately left unpinned rather than guarded by a test that would pass either way.
  const h = makeTracker();
  const P = "prompt-confirmed";

  h.tracker.onQueued(P);
  h.tracker.onExecutionStart(P);
  h.tracker.onExecutionSuccess(P);
  h.tracker.markDelivered(P); // caller confirms
  h.tracker.onExecutionSuccess(P); // replayed

  assert.equal(h.flushes.length, 1);
});
