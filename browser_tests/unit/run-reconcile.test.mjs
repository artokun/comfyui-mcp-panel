/**
 * Unit tests for #370 — reconcile a run's completion across a connection drop.
 *
 * When the connection drops mid-render, the terminal `execution_success` can be
 * MISSED (WS lost) or the composed completion frame can be DROPPED (bridge down),
 * so the run finishes with no completion delivered and its status is unknowable.
 * On reconnect we reconcile still-pending prompt_ids against `/history` and
 * deliver the terminal outcome EXACTLY ONCE — never double-delivering and never
 * mis-attributing a different prompt_id.
 *
 * Covers both the pure parse (history-reconcile.js) and the tracker orchestration
 * (run-completion.js reconcile / pending / delivered).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";
import {
  parseHistoryEntry,
  queueMembership,
  historyEntryFor,
} from "../../web/js/lib/history-reconcile.js";

const isVideo = (m) => /\.(mp4|webm|mov)$/i.test(String(m?.filename || ""));

function makeHarness(opts = {}) {
  let clock = 0;
  const timers = new Map();
  let seq = 0;
  const flushes = [];
  const errors = [];
  const giveUps = [];
  const tracker = createRunCompletionTracker({
    onFlush: (p) => flushes.push(p),
    onReconcileError: (e) => errors.push(e),
    onReconcileGiveUp: (e) => giveUps.push(e),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    debounceMs: 1500,
    ...opts,
  });
  return {
    tracker,
    flushes,
    errors,
    giveUps,
    advance: (ms) => {
      clock += ms;
    },
    // Fire (and await) every timer whose deadline is due at the current clock.
    // A fired timer may schedule another; the caller advances + fires again.
    fireDueTimers: async () => {
      const due = [...timers].filter(([, t]) => t.at <= clock);
      const proms = [];
      for (const [id, t] of due) {
        timers.delete(id);
        proms.push(t.fn());
      }
      await Promise.all(proms);
    },
  };
}

const successEntry = (outputs) => ({
  outputs,
  status: { status_str: "success", completed: true, messages: [] },
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure parse
// ─────────────────────────────────────────────────────────────────────────────

test("parseHistoryEntry: terminal success classifies stills vs videos", () => {
  const parsed = parseHistoryEntry(
    successEntry({
      9: { images: [{ filename: "final.png", type: "output" }] },
      10: { gifs: [{ filename: "clip.mp4", type: "output" }] },
    }),
    { isVideo },
  );
  assert.equal(parsed.terminal, true);
  assert.equal(parsed.status, "success");
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].filename, "final.png");
  assert.equal(parsed.videos.length, 1);
  assert.equal(parsed.videos[0].m.filename, "clip.mp4");
  assert.equal(parsed.videos[0].nodeId, "10");
});

test("parseHistoryEntry: an errored run is terminal with status error and no batch delivered", () => {
  const parsed = parseHistoryEntry(
    { outputs: {}, status: { status_str: "error", completed: false } },
    { isVideo },
  );
  assert.equal(parsed.terminal, true);
  assert.equal(parsed.status, "error");
});

test("parseHistoryEntry: a still-running / missing entry is NOT terminal", () => {
  assert.equal(parseHistoryEntry(null, { isVideo }), null);
  const running = parseHistoryEntry({ outputs: {}, status: {} }, { isVideo });
  assert.equal(running.terminal, false);
  assert.equal(running.status, "unknown");
});

// ─────────────────────────────────────────────────────────────────────────────
// Tracker reconcile
// ─────────────────────────────────────────────────────────────────────────────

test("#370 drop-during-render: missed execution_success → reconcile delivers via /history exactly once", async () => {
  const { tracker, flushes } = makeHarness();
  // Render starts, one output arrives, THEN the WS drops — no execution_success.
  tracker.onExecutionStart("p1");
  tracker.onExecuted("p1", { images: [{ filename: "partial.png", type: "output" }] });
  assert.equal(flushes.length, 0, "no completion delivered yet (success was missed)");

  // Reconnect: /history has the authoritative, COMPLETE output set.
  const history = {
    p1: successEntry({
      9: { images: [{ filename: "final.png", type: "output" }] },
    }),
  };
  const fetchHistory = async (id) => history[id] ?? null;
  const summary = await tracker.reconcile({ fetchHistory, isVideo });

  assert.equal(flushes.length, 1, "exactly one completion delivered on reconcile");
  assert.equal(flushes[0].promptId, "p1");
  assert.equal(flushes[0].reconciled, true);
  // History is authoritative — the delivered batch is the /history output, not the
  // partial pre-drop buffer.
  assert.equal(flushes[0].images.length, 1);
  assert.equal(flushes[0].images[0].filename, "final.png");
  assert.deepEqual(summary, [{ promptId: "p1", status: "success", delivered: true }]);

  // A SECOND reconcile (e.g. another reconnect) must NOT double-deliver.
  await tracker.reconcile({ fetchHistory, isVideo });
  assert.equal(flushes.length, 1, "no double-delivery on a second reconcile");
});

test("#370: a stale pre-drop buffer can't double-deliver after reconcile (executing:null is a no-op)", async () => {
  const { tracker, flushes } = makeHarness();
  tracker.onExecutionStart("p1");
  tracker.onExecuted("p1", { images: [{ filename: "partial.png", type: "output" }] });
  const history = { p1: successEntry({ 9: { images: [{ filename: "final.png", type: "output" }] } }) };
  await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.length, 1);
  // A late queue-idle / next-run signal must not re-flush the (now cleared) buffer.
  tracker.onExecutingNull();
  assert.equal(flushes.length, 1, "cleared buffer does not re-deliver");
});

test("#370 bridge-down drop: execution_success fired but frame was dropped → markUndelivered re-pends → reconcile delivers", async () => {
  const { tracker, flushes } = makeHarness();
  tracker.onExecutionStart("p1");
  tracker.onExecuted("p1", { images: [{ filename: "final.png", type: "output" }] });
  // We DID observe success live → the buffer flushed (delivered optimistically).
  tracker.onExecutionSuccess("p1");
  assert.equal(flushes.length, 1, "flushed on execution_success");
  // …but the bridge was down, so the send failed. Caller re-pends it.
  tracker.markUndelivered("p1");

  // Reconnect → reconcile re-delivers from /history (the ONLY way this run's
  // result reaches the agent, since the live frame was lost).
  const history = { p1: successEntry({ 9: { images: [{ filename: "final.png", type: "output" }] } }) };
  const summary = await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.length, 2, "reconcile re-delivers the lost completion");
  assert.equal(flushes[1].reconciled, true);
  assert.deepEqual(summary, [{ promptId: "p1", status: "success", delivered: true }]);
});

test("#370 happy path: a CONFIRMED-delivered run is NOT reconciled (no double-delivery)", async () => {
  const { tracker, flushes } = makeHarness();
  tracker.onExecutionStart("p1");
  tracker.onExecuted("p1", { images: [{ filename: "final.png", type: "output" }] });
  tracker.onExecutionSuccess("p1"); // delivered
  tracker.markDelivered("p1"); // caller confirms the send succeeded
  assert.equal(flushes.length, 1);

  const history = { p1: successEntry({ 9: { images: [{ filename: "final.png", type: "output" }] } }) };
  const summary = await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.length, 1, "no reconcile delivery for a confirmed run");
  assert.deepEqual(summary, [], "nothing pending to reconcile");
});

test("#370 entire-run-in-drop: onQueued alone (no WS events) is still reconcilable", async () => {
  const { tracker, flushes } = makeHarness();
  // The run was accepted (prompt_id known) but started AND finished inside the
  // drop — no execution_start/executing/executed ever arrived.
  tracker.onQueued("p9");
  const history = { p9: successEntry({ 4: { images: [{ filename: "done.png", type: "output" }] } }) };
  const summary = await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].promptId, "p9");
  assert.equal(summary[0].status, "success");
});

test("#370 no mis-attribution: reconcile only delivers the queried prompt's outputs", async () => {
  const { tracker, flushes } = makeHarness();
  tracker.onQueued("pA");
  tracker.onQueued("pB");
  // History only knows about pA (pB still running / no entry).
  const history = {
    pA: successEntry({ 1: { images: [{ filename: "A.png", type: "output" }] } }),
    // pB: absent → not terminal
  };
  const summary = await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  const delivered = flushes.filter((f) => f.images.length);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].promptId, "pA");
  assert.equal(delivered[0].images[0].filename, "A.png");
  // pB stays pending (running — absent /history, queue unknown), pA delivered — no
  // cross-contamination.
  const byId = Object.fromEntries(summary.map((r) => [r.promptId, r.status]));
  assert.equal(byId.pA, "success");
  assert.equal(byId.pB, "running");
  // pB is still pending → a later reconcile with its history delivers ONLY pB.
  history.pB = successEntry({ 2: { images: [{ filename: "B.png", type: "output" }] } });
  await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  const bFlush = flushes.find((f) => f.promptId === "pB");
  assert.ok(bFlush, "pB delivered on the later reconcile");
  assert.equal(bFlush.images[0].filename, "B.png");
});

test("#370 errored run recovered from history: no batch delivered, status error reported", async () => {
  const { tracker, flushes } = makeHarness();
  tracker.onExecutionStart("pE");
  tracker.onExecuted("pE", { images: [{ filename: "partial.png", type: "output" }] });
  // Drop before we saw execution_error; history says it failed.
  const history = { pE: { outputs: {}, status: { status_str: "error" } } };
  const summary = await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.length, 0, "no completion batch for a failed run");
  assert.deepEqual(summary, [{ promptId: "pE", status: "error" }]);
});

test("#370 codex P1 (idempotency): a LATE executed+execution_success after reconcile does NOT double-deliver", async () => {
  const { tracker, flushes } = makeHarness();
  // Run dropped, reconcile recovers it from /history.
  tracker.onExecutionStart("pL");
  const history = { pL: successEntry({ 9: { images: [{ filename: "final.png", type: "output" }] } }) };
  await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.length, 1, "reconcile delivered once");
  assert.equal(tracker.wasTerminal("pL"), true);

  // The live WS now replays the buffered lifecycle for the SAME prompt. None of it
  // may produce a second completion.
  tracker.onExecutingNode("pL");
  tracker.onExecuted("pL", { images: [{ filename: "final.png", type: "output" }] });
  tracker.onExecutionSuccess("pL");
  assert.equal(flushes.length, 1, "no duplicate completion from the late live events");
});

test("#370 codex P1 (idempotency): wasTerminal fences a late execution_error after a reconciled error", async () => {
  const { tracker, flushes } = makeHarness();
  tracker.onExecutionStart("pX");
  const history = { pX: { outputs: {}, status: { status_str: "error" } } };
  await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(tracker.wasTerminal("pX"), true, "reconciled error is marked delivered");
  // Panel checks wasTerminal() BEFORE onExecutionFailed to skip the duplicate
  // run_error; the tracker-side late failed event re-buffers nothing.
  tracker.onExecuted("pX", { images: [{ filename: "late.png", type: "output" }] });
  tracker.onExecutionFailed("pX");
  assert.equal(flushes.length, 0, "no batch, no duplicate from the late error");
});

test("#370 codex P1 (TOCTOU): a live execution_success during the /history await is NOT double-delivered", async () => {
  const { tracker, flushes } = makeHarness();
  tracker.onExecutionStart("pT");
  tracker.onExecuted("pT", { images: [{ filename: "live.png", type: "output" }] });

  // fetchHistory resolves the run's terminal record, but WHILE it is in flight the
  // live `execution_success` arrives and delivers the buffered batch. reconcile
  // must notice the run was delivered during its await and NOT deliver again.
  const fetchHistory = async (id) => {
    tracker.onExecutionSuccess(id); // live delivery lands mid-await
    return { [id]: undefined }[id] ?? { outputs: { 1: { images: [{ filename: "hist.png", type: "output" }] } }, status: { status_str: "success" } };
  };
  const summary = await tracker.reconcile({ fetchHistory, isVideo });
  assert.equal(flushes.length, 1, "exactly one delivery (the live success), no reconcile duplicate");
  assert.equal(flushes[0].images[0].filename, "live.png");
  assert.deepEqual(summary, [], "reconcile delivered nothing — the live event already resolved it");
});

test("#370 codex P1: an error whose run_error frame failed to send is re-pended and retried", async () => {
  const { tracker, flushes } = makeHarness();
  tracker.onExecutionStart("pE");
  const history = { pE: { outputs: {}, status: { status_str: "error" } } };
  const fetchHistory = async (id) => history[id] ?? null;

  const s1 = await tracker.reconcile({ fetchHistory, isVideo });
  assert.deepEqual(s1, [{ promptId: "pE", status: "error" }]);
  assert.equal(flushes.length, 0);
  // Panel's run_error frame couldn't be delivered (bridge dropped again) → re-pend.
  tracker.markUndelivered("pE");

  // The error is NOT lost: a later reconnect reconciles it again.
  const s2 = await tracker.reconcile({ fetchHistory, isVideo });
  assert.deepEqual(s2, [{ promptId: "pE", status: "error" }]);

  // …and once the run_error is confirmed delivered, it stops retrying.
  tracker.markDelivered("pE");
  const s3 = await tracker.reconcile({ fetchHistory, isVideo });
  assert.deepEqual(s3, [], "no further retry after the error was delivered");
});

test("#370 a prior run flushed partial at next-run start is delivered (not re-delivered by reconcile)", async () => {
  const { tracker, flushes } = makeHarness();
  // Run A's end signal missed (a dropped frame on a LIVE connection — no reconnect
  // coming), then run B starts: A is flushed partial at B's start (#224 default).
  tracker.onExecutionStart("pA");
  tracker.onExecuted("pA", { images: [{ filename: "A.png", type: "output" }] });
  tracker.onExecutionStart("pB");
  assert.equal(flushes.length, 1, "A delivered at B's start (deliver-what-we-have)");
  assert.equal(flushes[0].promptId, "pA");
  // A was marked delivered by that flush → a later reconcile must NOT re-deliver it.
  const history = { pA: successEntry({ 9: { images: [{ filename: "A.png", type: "output" }] } }) };
  const summary = await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.length, 1, "no reconcile re-delivery of an already-delivered run");
  assert.equal(summary.find((r) => r.promptId === "pA"), undefined);
});

test("#370 delivered-fence ages out: an old fence is pruned once past the 10-min TTL", () => {
  const { tracker, advance } = makeHarness();
  tracker.onExecutionStart("p1");
  tracker.onExecuted("p1", { images: [{ filename: "a.png", type: "output" }] });
  tracker.onExecutionSuccess("p1");
  assert.equal(tracker.wasTerminal("p1"), true, "fenced right after delivery");

  // Well past the fence TTL, a new delivery prunes the stale fence (bounded memory).
  advance(10 * 60 * 1000 + 1);
  tracker.onExecutionStart("p2");
  tracker.onExecuted("p2", { images: [{ filename: "b.png", type: "output" }] });
  tracker.onExecutionSuccess("p2");
  assert.equal(tracker.wasTerminal("p1"), false, "stale fence aged out");
  assert.equal(tracker.wasTerminal("p2"), true, "recent fence retained");
});

test("#370 P1-2: a late execution_start(delivered P) does NOT flush a DIFFERENT active run's buffer", async () => {
  const { tracker, flushes } = makeHarness();
  // P finished during a drop and was recovered via reconcile (delivered).
  tracker.onQueued("P");
  const history = { P: successEntry({ 1: { images: [{ filename: "P.png", type: "output" }] } }) };
  await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.length, 1, "P delivered via reconcile");
  assert.equal(tracker.wasTerminal("P"), true);

  // A NEW run Q starts and buffers a preview (still in flight).
  tracker.onExecutionStart("Q");
  tracker.onExecuted("Q", { images: [{ filename: "Q_preview.png", type: "output" }] });

  // A DELAYED execution_start(P) — for the already-delivered prompt — arrives. It
  // must be IGNORED: it must not flush Q's partial buffer or clear Q's active.
  tracker.onExecutionStart("P");
  assert.equal(flushes.length, 1, "stale execution_start(P) did not flush Q's partial batch");
  assert.equal(tracker._active.has("Q"), true, "Q is still active");

  // Q now finishes normally and delivers its FULL output — nothing was lost.
  tracker.onExecuted("Q", { images: [{ filename: "Q_final.png", type: "output" }] });
  tracker.onExecutionSuccess("Q");
  const qFlush = flushes.find((f) => f.promptId === "Q");
  assert.ok(qFlush, "Q delivered");
  assert.deepEqual(
    qFlush.images.map((m) => m.filename),
    ["Q_preview.png", "Q_final.png"],
    "Q's full batch preserved (preview + final)",
  );
});

test("#370 P1 (codex): a RE-PENDED terminal P's replayed execution_start still does NOT flush active Q", async () => {
  const { tracker, flushes } = makeHarness();
  // P completes live and delivers…
  tracker.onExecutionStart("P");
  tracker.onExecuted("P", { images: [{ filename: "P.png", type: "output" }] });
  tracker.onExecutionSuccess("P");
  assert.equal(flushes.length, 1, "P delivered");
  assert.equal(tracker.wasTerminal("P"), true);

  // …but its completion frame failed to send (bridge down) → re-pend for retry.
  // This must NOT clear P's terminal REPLAY fence.
  tracker.markUndelivered("P");
  assert.equal(tracker.wasTerminal("P"), true, "terminal replay fence survives re-pend");
  assert.equal(tracker._pending.has("P"), true, "P re-pended for delivery retry");

  // A DIFFERENT run Q starts and buffers a preview.
  tracker.onExecutionStart("Q");
  tracker.onExecuted("Q", { images: [{ filename: "Q_preview.png", type: "output" }] });

  // A late/replayed execution_start(P) arrives. Because P is still TERMINAL-fenced
  // (despite the re-pend), it must be ignored — not flush Q's partial buffer.
  tracker.onExecutionStart("P");
  assert.equal(flushes.length, 1, "re-pended P's stale start did not flush Q");
  assert.equal(tracker._active.has("Q"), true, "Q still active");

  // Q finishes and delivers its FULL batch — nothing lost.
  tracker.onExecuted("Q", { images: [{ filename: "Q_final.png", type: "output" }] });
  tracker.onExecutionSuccess("Q");
  const qFlush = flushes.find((f) => f.promptId === "Q");
  assert.ok(qFlush, "Q delivered");
  assert.deepEqual(
    qFlush.images.map((m) => m.filename),
    ["Q_preview.png", "Q_final.png"],
    "Q's full batch preserved despite P's re-pended replayed start",
  );

  // And P's re-pended delivery is still recoverable via reconcile (retry path).
  const history = { P: successEntry({ 1: { images: [{ filename: "P.png", type: "output" }] } }) };
  await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  const pFlushes = flushes.filter((f) => f.promptId === "P");
  assert.equal(pFlushes.length, 2, "P re-delivered exactly once via reconcile after re-pend");
});

test("#370 P1 (codex): a terminal fence is NOT aged out while its run is still pending (prolonged outage)", async () => {
  const TTL = 10 * 60 * 1000;
  const h = makeHarness();
  const { tracker, flushes } = h;
  // P completes and delivers, but the frame can't send → re-pend (bridge down).
  tracker.onExecutionStart("P");
  tracker.onExecuted("P", { images: [{ filename: "P.png", type: "output" }] });
  tracker.onExecutionSuccess("P");
  tracker.markUndelivered("P");
  assert.equal(tracker._pending.has("P"), true, "P still pending recovery");
  assert.equal(tracker.wasTerminal("P"), true);

  // Bridge stays down LONGER than the fence TTL, and a prune runs (its self-arming
  // sweep fires). P is still pending, so its replay fence must be RETAINED — not
  // aged out from under the still-pending completion.
  h.advance(TTL + 1);
  await h.fireDueTimers(); // fires the fence-prune sweep
  assert.equal(tracker.wasTerminal("P"), true, "terminal fence retained while P still pending");

  // A different run Q begins and buffers; a replayed execution_start(P) — arriving
  // before /history(P) resolves — must STILL be fenced (not flush Q).
  tracker.onExecutionStart("Q");
  tracker.onExecuted("Q", { images: [{ filename: "Q_preview.png", type: "output" }] });
  tracker.onExecutionStart("P");
  assert.equal(tracker._active.has("Q"), true, "Q still active after replayed P start");
  tracker.onExecuted("Q", { images: [{ filename: "Q_final.png", type: "output" }] });
  tracker.onExecutionSuccess("Q");
  const qFlush = flushes.find((f) => f.promptId === "Q");
  assert.deepEqual(
    qFlush.images.map((m) => m.filename),
    ["Q_preview.png", "Q_final.png"],
    "Q's full batch preserved despite a post-TTL replayed P start",
  );

  // P still re-delivers exactly once on reconnect.
  const history = { P: successEntry({ 1: { images: [{ filename: "P.png", type: "output" }] } }) };
  await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.filter((f) => f.promptId === "P").length, 2, "P re-delivered once via reconcile");
});

test("#370 a terminal fence for a DELIVERED (not pending) run DOES age out (memory bounded)", async () => {
  const TTL = 10 * 60 * 1000;
  const h = makeHarness();
  const { tracker } = h;
  tracker.onExecutionStart("A");
  tracker.onExecuted("A", { images: [{ filename: "A.png", type: "output" }] });
  tracker.onExecutionSuccess("A"); // delivered AND confirmed (not re-pended) ⇒ not pending
  assert.equal(tracker._pending.has("A"), false);
  assert.equal(tracker.wasTerminal("A"), true);
  h.advance(TTL + 1);
  await h.fireDueTimers();
  assert.equal(tracker.wasTerminal("A"), false, "a resolved (non-pending) fence ages out normally");
});

test("#370 P1-3: entire-run-in-drop + a transient /history miss then terminal → delivered once via retry", async () => {
  const h = makeHarness({ reconcileRetryMs: 3000, maxReconcileRetries: 5 });
  const { tracker, flushes } = h;
  // The whole lifecycle happened during the drop — only the queue-time id is known.
  tracker.onQueued("D");

  // First reconcile (reconnect edge) hits a TRANSIENT /history miss (503/empty) and
  // the run has already left /queue (finished), so /history should become consistent
  // shortly — the retry covers that window.
  let historyReady = false;
  const fetchHistory = async (id) => {
    if (id !== "D") return null;
    return historyReady
      ? successEntry({ 7: { images: [{ filename: "D_final.png", type: "output" }] } })
      : null; // transient: not yet populated
  };
  const fetchQueued = async () => false; // not in /queue
  const summary = await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.deepEqual(summary, [{ promptId: "D", status: "unknown" }], "transient miss reported");
  assert.equal(flushes.length, 0, "nothing delivered yet");

  // /history becomes terminal WITHOUT another reconnect edge — the scheduled retry
  // must pick it up and deliver.
  historyReady = true;
  h.advance(3000);
  await h.fireDueTimers();
  assert.equal(flushes.length, 1, "retry delivered the completion once /history turned terminal");
  assert.equal(flushes[0].promptId, "D");
  assert.equal(flushes[0].images[0].filename, "D_final.png");

  // No further retry fires, and no duplicate on a later reconcile (delivered fence).
  h.advance(3000);
  await h.fireDueTimers();
  await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.equal(flushes.length, 1, "exactly once — no duplicate delivery");
});

test("#370 P1-3 (codex): a transient /history miss that later resolves to an ERROR is surfaced via retry", async () => {
  const h = makeHarness({ reconcileRetryMs: 2000, maxReconcileRetries: 5 });
  const { tracker, flushes, errors } = h;
  tracker.onQueued("F");
  let state = "transient"; // transient → error
  const fetchHistory = async (id) => {
    if (id !== "F") return null;
    if (state === "transient") return null; // 503/empty
    return { outputs: {}, status: { status_str: "error" } };
  };
  const fetchQueued = async () => false; // not in /queue
  const summary = await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.deepEqual(summary, [{ promptId: "F", status: "unknown" }]);
  assert.equal(errors.length, 0, "no error surfaced yet");

  // History turns terminal-ERROR — the scheduled retry must surface run_error.
  state = "error";
  h.advance(2000);
  await h.fireDueTimers();
  assert.equal(flushes.length, 0, "no completion batch for a failed run");
  assert.deepEqual(errors, [{ promptId: "F" }], "run_error surfaced exactly once via the retry");
  assert.equal(tracker.wasTerminal("F"), true, "fenced so no duplicate");

  // No further retry, no duplicate error.
  h.advance(2000);
  await h.fireDueTimers();
  await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.equal(errors.length, 1, "exactly one run_error");
});

test("#370 reconcile-loop error also routes through onReconcileError (single delivery path)", async () => {
  const { tracker, flushes, errors } = makeHarness();
  tracker.onExecutionStart("G");
  const history = { G: { outputs: {}, status: { status_str: "error" } } };
  const summary = await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.deepEqual(summary, [{ promptId: "G", status: "error" }]);
  assert.equal(flushes.length, 0);
  assert.deepEqual(errors, [{ promptId: "G" }], "error delivered via the hook, once");
});

test("#370 P1 (codex memory-leak): an exhausted-retry /history-ABSENT prompt is EVICTED (given up once), not retained forever", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 3 });
  const { tracker, flushes, giveUps } = h;
  tracker.onQueued("E");
  const fetchHistory = async () => null; // absent from /history
  const fetchQueued = async () => false; // AND absent from /queue ⇒ genuinely gone
  await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.equal(tracker._pending.has("E"), true, "pending while retries are in flight");
  // Drain the retry budget.
  for (let i = 0; i < 6; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.equal(flushes.length, 0, "nothing delivered — history never terminal");
  // Given up ONCE and evicted → the ledger does not grow without bound.
  assert.deepEqual(giveUps, [{ promptId: "E" }], "gave up exactly once");
  assert.equal(tracker._pending.has("E"), false, "EVICTED from pending (bounded memory)");
  // Its stamped terminal fence is no longer pinned by pending, so it ages out.
  h.advance(10 * 60 * 1000 + 1);
  await h.fireDueTimers();
  assert.equal(tracker.wasTerminal("E"), false, "given-up fence ages out (not retained forever)");
});

test("#370 P1 (codex): repeated cancelled queued prompts do NOT accumulate in the ledger", async () => {
  const h = makeHarness({ reconcileRetryMs: 500, maxReconcileRetries: 2 });
  const { tracker, giveUps } = h;
  const fetchHistory = async () => null; // absent from /history
  const fetchQueued = async () => false; // AND absent from /queue ⇒ each is gone
  for (let n = 0; n < 5; n++) {
    const id = `c${n}`;
    tracker.onQueued(id);
    await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
    for (let i = 0; i < 3; i++) {
      h.advance(500);
      await h.fireDueTimers();
    }
  }
  assert.equal(giveUps.length, 5, "each unconfirmable prompt given up once");
  assert.equal(tracker._pending.size, 0, "pending drained — no unbounded growth");
});

test("#370 P1 (codex): give-up RETIRES a partial buffer so no stale output flushes on the next run", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 2 });
  const { tracker, flushes, giveUps } = h;
  // P emitted a partial preview, then went history-absent (cancelled mid-run).
  tracker.onExecutionStart("P");
  tracker.onExecuted("P", { images: [{ filename: "P_partial.png", type: "output" }] });
  assert.equal(tracker._buffers.has("P"), true, "P has a buffered partial");

  const fetchHistory = async () => null; // absent from /history
  const fetchQueued = async () => false; // AND absent from /queue ⇒ gone
  await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  for (let i = 0; i < 4; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.deepEqual(giveUps, [{ promptId: "P" }], "P given up once");
  assert.equal(tracker._buffers.has("P"), false, "P's stale buffer was RETIRED on give-up");
  assert.equal(tracker._active.has("P"), false, "P no longer active");

  // A different run Q starts — P's stale partial must NOT be flushed here.
  tracker.onExecutionStart("Q");
  assert.equal(
    flushes.some((f) => f.promptId === "P"),
    false,
    "no stale P output ever delivered",
  );
});

test("#370 P2 (codex): maxReconcileRetries=0 gives up an absent-history prompt IMMEDIATELY", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 0 });
  const { tracker, giveUps } = h;
  tracker.onQueued("Z");
  const fetchHistory = async () => null; // absent from /history
  const fetchQueued = async () => false; // AND absent from /queue ⇒ gone
  await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.deepEqual(giveUps, [{ promptId: "Z" }], "gave up immediately (zero retries)");
  assert.equal(tracker._pending.has("Z"), false, "evicted — not stranded pending forever");
});

test("#370 P1 (codex CRITICAL): absent /history BUT present in /queue (running) is NOT given up, and its later live output still delivers", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 3 });
  const { tracker, flushes, giveUps } = h;
  // A long render: queued during a drop, still RUNNING on reconnect — ComfyUI only
  // writes /history on task_done, so /history/<id> is legitimately absent while the
  // prompt sits in /queue. The reconciler MUST NOT give up / fence it.
  tracker.onQueued("R");
  const fetchHistory = async () => null; // absent — normal for a running prompt
  const fetchQueued = async () => true; // BUT still in /queue (running)
  await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  // Exhaust the retry budget while it stays running.
  for (let i = 0; i < 6; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.equal(giveUps.length, 0, "a render still in /queue is NEVER given up");
  assert.equal(tracker._pending.has("R"), true, "left pending for the live path / next reconnect");
  assert.equal(tracker.wasTerminal("R"), false, "NOT fenced — its live lifecycle must still be honored");

  // The render finishes: its live executed + execution_success must STILL deliver
  // (fails-before: the prompt was fenced/evicted and this output was dropped).
  tracker.onExecutionStart("R");
  tracker.onExecuted("R", { images: [{ filename: "R_final.png", type: "output" }] });
  tracker.onExecutionSuccess("R");
  const rFlush = flushes.find((f) => f.promptId === "R");
  assert.ok(rFlush, "the long render's real output was delivered, not dropped");
  assert.equal(rFlush.images[0].filename, "R_final.png");
});

test("#370 P1 (codex): a PRESENT non-terminal /history entry is NEVER given up, even when /queue is absent", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 2 });
  const { tracker, flushes, giveUps } = h;
  // /history HAS a record for P but it's not terminal (status running) — a transient
  // queue↔history handoff where /queue momentarily omits it. A PRESENT record means
  // the prompt is confirmably NOT gone, so it must never be evicted/fenced.
  tracker.onQueued("P");
  const fetchHistory = async () => ({ status: { status_str: "running" }, outputs: {} });
  const fetchQueued = async () => false; // /queue momentarily omits it
  const summary = await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.deepEqual(summary, [{ promptId: "P", status: "running" }], "present-non-terminal ⇒ running, NOT unknown");
  for (let i = 0; i < 4; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.equal(giveUps.length, 0, "a present /history record is NEVER given up");
  assert.equal(tracker._pending.has("P"), true, "left pending");
  assert.equal(tracker.wasTerminal("P"), false, "NOT fenced");

  // Its later live output must still deliver (fails-before: it was evicted/fenced).
  tracker.onExecutionStart("P");
  tracker.onExecuted("P", { images: [{ filename: "P_final.png", type: "output" }] });
  tracker.onExecutionSuccess("P");
  const pFlush = flushes.find((f) => f.promptId === "P");
  assert.ok(pFlush, "the render's real output delivered, not dropped");
  assert.equal(pFlush.images[0].filename, "P_final.png");
});

test("#370 P1 (codex): give-up requires CLEAN-ABSENT /history (null), not a present non-terminal record", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 1 });
  const { tracker, giveUps } = h;
  const fetchQueued = async () => false; // /queue absent for both
  // "present" always has a present-non-terminal /history record; "gone" is cleanly
  // absent (null). Only the latter is give-up eligible.
  const fetchHistory = async (id) => (id === "present" ? { status: { status_str: "pending" } } : null);

  tracker.onQueued("present");
  tracker.onQueued("gone");
  await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  for (let i = 0; i < 3; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.deepEqual(giveUps, [{ promptId: "gone" }], "only null-history + absent-queue gives up");
  assert.equal(tracker._pending.has("present"), true, "present-non-terminal stays pending (never given up)");
  assert.equal(tracker._pending.has("gone"), false, "genuinely-gone prompt evicted (bounded memory)");
});

// ── historyEntryFor: strict /history map verdict ────────────────────────────────

test("historyEntryFor: well-formed map WITH the id ⇒ the entry (present record)", () => {
  const entry = { status: { status_str: "success" }, outputs: {} };
  assert.strictEqual(historyEntryFor({ R: entry }, "R"), entry);
});

test("historyEntryFor: well-formed map LACKING the id ⇒ null (clean absence)", () => {
  assert.strictEqual(historyEntryFor({}, "R"), null);
  assert.strictEqual(historyEntryFor({ other: { status: {} } }, "R"), null);
});

test("historyEntryFor: MALFORMED body (null/array/non-object) ⇒ undefined (uncertain, NOT null)", () => {
  assert.strictEqual(historyEntryFor(null, "R"), undefined); // the exact repro: 200 body `null`
  assert.strictEqual(historyEntryFor([], "R"), undefined); // 200 body `[]`
  assert.strictEqual(historyEntryFor([{ R: 1 }], "R"), undefined); // array, not a map
  assert.strictEqual(historyEntryFor("nonsense", "R"), undefined);
  assert.strictEqual(historyEntryFor(42, "R"), undefined);
  assert.strictEqual(historyEntryFor(undefined, "R"), undefined);
});

test("queueMembership/historyEntryFor: a NUMERIC lookup id coerces to string (defensive)", () => {
  // Belt-and-suspenders: even if a number reaches the pure helper, it compares as
  // its string form (ingestion normalizes upstream, so normally it's already "7").
  assert.equal(queueMembership({ queue_running: [[0, "7", {}]], queue_pending: [] }, 7), true);
  assert.equal(queueMembership({ queue_running: [[0, "8", {}]], queue_pending: [] }, 7), false);
  const entry = { status: { status_str: "success" } };
  assert.strictEqual(historyEntryFor({ 7: entry }, 7), entry);
  assert.strictEqual(historyEntryFor({ 8: entry }, 7), null);
  // Non-coercible lookup ids: queueMembership ⇒ null (uncertain), historyEntryFor ⇒
  // undefined (uncertain), NEVER a definitive absent/give-up signal.
  assert.equal(queueMembership({ queue_running: [], queue_pending: [] }, null), null);
  assert.equal(queueMembership({ queue_running: [], queue_pending: [] }, {}), null);
  assert.strictEqual(historyEntryFor({}, null), undefined);
  assert.strictEqual(historyEntryFor({}, {}), undefined);
});

test("historyEntryFor: id PRESENT with a null/undefined value ⇒ undefined (malformed present, NOT clean absence)", () => {
  assert.strictEqual(historyEntryFor({ R: null }, "R"), undefined); // present key, null value
  assert.strictEqual(historyEntryFor({ R: undefined }, "R"), undefined); // present key, undefined value
  // A sibling present-null must not make an ABSENT id look present-null.
  assert.strictEqual(historyEntryFor({ other: null }, "R"), null); // R's key genuinely absent ⇒ clean absence
});

// ── queueMembership: strict-array /queue verdict ────────────────────────────────

// Full ComfyUI queue rows carry the prompt dict at index 2: [num, prompt_id, prompt, …].
const qrow = (n, id) => [n, id, { /* prompt dict */ }, {}, []];

test("queueMembership: present in queue_running or queue_pending ⇒ true", () => {
  assert.equal(queueMembership({ queue_running: [qrow(0, "p1")], queue_pending: [] }, "p1"), true);
  assert.equal(queueMembership({ queue_running: [], queue_pending: [qrow(1, "p2")] }, "p2"), true);
  // {prompt_id} object form is also matched.
  assert.equal(queueMembership({ queue_running: [{ prompt_id: "p3" }], queue_pending: [] }, "p3"), true);
});

test("queueMembership: both arrays well-formed AND id absent ⇒ false (definitive)", () => {
  assert.equal(queueMembership({ queue_running: [qrow(0, "other")], queue_pending: [] }, "p1"), false);
  assert.equal(queueMembership({ queue_running: [], queue_pending: [] }, "p1"), false);
});

test("queueMembership: MALFORMED / missing fields ⇒ null (uncertain, NOT false)", () => {
  // The exact repro: queue arrays are objects, not arrays.
  assert.equal(queueMembership({ queue_running: {}, queue_pending: {} }, "p1"), null);
  assert.equal(queueMembership({ queue_running: [], queue_pending: {} }, "p1"), null); // one bad
  assert.equal(queueMembership({ queue_running: {}, queue_pending: [] }, "p1"), null);
  assert.equal(queueMembership({}, "p1"), null); // both missing
  assert.equal(queueMembership({ queue_running: null, queue_pending: null }, "p1"), null);
  assert.equal(queueMembership(null, "p1"), null);
  assert.equal(queueMembership("nonsense", "p1"), null);
});

test("queueMembership: MALFORMED ROWS (arrays are valid but a row is unreadable) ⇒ null", () => {
  // Row missing the prompt_id slot / wrong types — can't trust an "absent" verdict.
  assert.equal(queueMembership({ queue_running: [[0]], queue_pending: [] }, "p1"), null);
  assert.equal(queueMembership({ queue_running: [null], queue_pending: [] }, "p1"), null);
  assert.equal(queueMembership({ queue_running: [{}], queue_pending: [] }, "p1"), null);
  assert.equal(queueMembership({ queue_running: [[0, 123]], queue_pending: [] }, "p1"), null); // id not a string
  assert.equal(queueMembership({ queue_running: [], queue_pending: ["bare-string"] }, "p1"), null);
  // Row's index-0 must be a number (the queue-row shape is [number, prompt_id, …]).
  assert.equal(queueMembership({ queue_running: [["not-a-number", "other"]], queue_pending: [] }, "p1"), null);
  // A TRUNCATED [number, prompt_id] row (missing the prompt dict at index 2) is
  // MALFORMED — it must NOT be read as a valid id-absent entry (codex P1).
  assert.equal(queueMembership({ queue_running: [[0, "other"]], queue_pending: [] }, "p1"), null);
  // Index 2 must be a PRESENT, NON-ARRAY object (the prompt dict); null/primitive/
  // ARRAY ⇒ malformed (the classic `typeof [] === "object"` gotcha — codex P1).
  assert.equal(queueMembership({ queue_running: [[0, "other", null]], queue_pending: [] }, "p1"), null);
  assert.equal(queueMembership({ queue_running: [[0, "other", 7]], queue_pending: [] }, "p1"), null);
  assert.equal(queueMembership({ queue_running: [[0, "other", []]], queue_pending: [] }, "p1"), null); // idx2 array
  assert.equal(queueMembership({ queue_running: [[1, "other", [1, 2]]], queue_pending: [] }, "target"), null);
  // An object-row whose prompt_id is an array/non-string ⇒ malformed ⇒ null.
  assert.equal(queueMembership({ queue_running: [{ prompt_id: ["a"] }], queue_pending: [] }, "p1"), null);
  assert.equal(queueMembership({ queue_running: [{ prompt_id: 5 }], queue_pending: [] }, "p1"), null);
  // A FULL valid row that simply doesn't match is a clean absence ⇒ false.
  assert.equal(queueMembership({ queue_running: [qrow(0, "other")], queue_pending: [] }, "p1"), false);
  // A POSITIVE match is trustworthy even if OTHER rows are malformed (truncated).
  assert.equal(queueMembership({ queue_running: [qrow(0, "p1"), [1]], queue_pending: [] }, "p1"), true);
  // Only when EVERY row is well-formed AND the id is absent ⇒ definitive false.
  assert.equal(queueMembership({ queue_running: [qrow(0, "a")], queue_pending: [{ prompt_id: "b" }] }, "p1"), false);
});

test("#370 P1 (codex): a /queue with ONLY TRUNCATED rows is uncertain → NOT given up, later output delivers", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 1 });
  const { tracker, flushes, giveUps } = h;
  tracker.onQueued("R");
  const fetchHistory = async () => null; // clean-absent /history
  // /queue returns 200 with a TRUNCATED row (missing the prompt dict) — malformed,
  // so queueMembership ⇒ null (uncertain); the tracker must NOT give up.
  const fetchQueued = async (id) => queueMembership({ queue_running: [[0, "other"]], queue_pending: [] }, id);
  const summary = await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.deepEqual(summary, [{ promptId: "R", status: "running" }], "truncated-row queue ⇒ running, not unknown");
  for (let i = 0; i < 3; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.equal(giveUps.length, 0, "a truncated-row /queue never causes a give-up");
  assert.equal(tracker._pending.has("R"), true, "left pending (uncertain)");
  assert.equal(tracker.wasTerminal("R"), false, "not fenced");

  // Its later live output still delivers.
  tracker.onExecutionStart("R");
  tracker.onExecuted("R", { images: [{ filename: "R.png", type: "output" }] });
  tracker.onExecutionSuccess("R");
  assert.ok(flushes.find((f) => f.promptId === "R"), "output delivered, not dropped");
});

test("#370 P1 (codex): a FALSY prompt_id 0 is tracked as '0' — onQueued fires, drop→reconcile checks /queue+/history, delivers", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 0 });
  const { tracker, flushes, giveUps } = h;
  // The whole point of the falsy-0 sweep: onQueued(0) MUST register (a truthiness
  // guard would skip it, leaving no "0" pending key so a drop loses the completion).
  tracker.onQueued(0);
  assert.equal(tracker._pending.has("0"), true, "0 tracked under the normalized string key '0'");

  let queueChecked = false;
  let historyChecked = false;
  const fetchHistory = async (id) => {
    historyChecked = true;
    assert.equal(id, "0", "reconcile queries /history for the string '0'");
    return null; // clean-absent (queued/running, not yet in history)
  };
  const fetchQueued = async (id) => {
    queueChecked = true;
    assert.equal(id, "0", "reconcile queries /queue for the string '0'");
    return queueMembership({ queue_running: [[0, "0", {}, {}, []]], queue_pending: [] }, id); // present ⇒ true
  };
  const summary = await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.ok(historyChecked && queueChecked, "a drop→reconcile checks BOTH /history and /queue for 0");
  assert.deepEqual(summary, [{ promptId: "0", status: "running" }], "0 is present in /queue ⇒ running");
  assert.equal(giveUps.length, 0, "0 is never given up (it's a real, present render)");

  // And its later live output delivers under the normalized string id.
  tracker.onExecutionStart(0);
  tracker.onExecuted(0, { images: [{ filename: "0.png", type: "output" }] });
  tracker.onExecutionSuccess(0);
  const f = flushes.find((x) => x.promptId === "0");
  assert.ok(f, "completion for id 0 delivered under '0'");
  assert.equal(f.promptId, "0");
});

test("#370 the id-less (null/undefined) path is STILL excluded from the recovery ledger", () => {
  const { tracker } = makeHarness();
  tracker.onQueued(null);
  tracker.onQueued(undefined);
  assert.equal(tracker._pending.size, 0, "null/undefined ids are never tracked (NO_PROMPT_KEY, excluded)");
  assert.equal(tracker._pending.has("null"), false);
  assert.equal(tracker._pending.has("undefined"), false);
});

test("#370 P1 (codex): a NUMERIC prompt_id is normalized to a string at ingestion — matches a string /queue row, not dropped", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 0 });
  const { tracker, flushes, giveUps } = h;
  tracker.onQueued(7); // a NUMBER enters the ledger
  assert.equal(tracker._pending.has("7"), true, "numeric id normalized to the string key '7'");
  assert.equal(tracker._pending.has(7), false, "not stored under the raw number");

  const fetchHistory = async () => null; // clean-absent /history
  const fetchQueued = async (id) => {
    // reconcile passes the NORMALIZED string id, so the string queue row matches.
    assert.equal(id, "7", "reconcile passes the normalized string id");
    return queueMembership({ queue_running: [[0, "7", { /* prompt */ }, {}, []]], queue_pending: [] }, id);
  };
  const summary = await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  // Was present in /queue as "7" ⇒ running, NOT given up (fails-before: number 7 !==
  // string "7" ⇒ reported absent ⇒ evicted + dropped).
  assert.deepEqual(summary, [{ promptId: "7", status: "running" }]);
  assert.equal(giveUps.length, 0, "the present render is never given up");
  assert.equal(tracker.wasTerminal("7"), false, "not fenced");

  // Fence + delivery also key on the normalized string id — a numeric lifecycle id
  // still resolves to "7".
  tracker.onExecutionStart(7);
  tracker.onExecuted(7, { images: [{ filename: "7.png", type: "output" }] });
  tracker.onExecutionSuccess(7);
  const f = flushes.find((x) => x.promptId === "7");
  assert.ok(f, "delivered under the normalized string id");
  assert.equal(f.promptId, "7", "completion carries the string id, not the number");
});

test("#370 P1 (codex): a /queue row whose idx2 is an ARRAY is malformed → NOT given up (typeof [] gotcha)", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 0 });
  const { tracker, flushes, giveUps } = h;
  tracker.onQueued("target");
  const fetchHistory = async () => null; // clean-absent /history
  // /queue row [1,"other",[]] — idx2 is an ARRAY, not a prompt dict ⇒ malformed ⇒
  // queueMembership null (uncertain). With a ZERO retry budget the tracker must
  // STILL not give up (the malformed row must not read as a valid absent entry).
  const fetchQueued = async (id) => queueMembership({ queue_running: [[1, "other", []]], queue_pending: [] }, id);
  const summary = await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.deepEqual(summary, [{ promptId: "target", status: "running" }], "idx2-array row ⇒ running, not unknown");
  assert.equal(giveUps.length, 0, "idx2-array malformed row never causes give-up (even at maxRetries=0)");
  assert.equal(tracker._pending.has("target"), true, "left pending (uncertain)");
  assert.equal(tracker.wasTerminal("target"), false, "not fenced");

  // Its later live output still delivers.
  tracker.onExecutionStart("target");
  tracker.onExecuted("target", { images: [{ filename: "t.png", type: "output" }] });
  tracker.onExecutionSuccess("target");
  assert.ok(flushes.find((f) => f.promptId === "target"), "output delivered, not dropped");
});

test("#370 P1 (codex): give-up fires on FULL valid /history-map-absent + FULL valid /queue-row-absent; a matching full row ⇒ running", async () => {
  const full = (n, id) => [n, id, {}, {}, []];
  // (a) gone: /history well-formed map lacking id, /queue full valid row lacking id ⇒ give up once.
  {
    const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 1 });
    const { tracker, giveUps } = h;
    tracker.onQueued("gone");
    const fetchHistory = async (id) => historyEntryFor({}, id); // ⇒ null
    const fetchQueued = async (id) => queueMembership({ queue_running: [full(0, "x")], queue_pending: [] }, id); // full valid, absent ⇒ false
    await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
    for (let i = 0; i < 3; i++) {
      h.advance(1000);
      await h.fireDueTimers();
    }
    assert.deepEqual(giveUps, [{ promptId: "gone" }], "full-valid-absent both sides ⇒ give up once");
    assert.equal(tracker._pending.has("gone"), false, "evicted");
  }
  // (b) present: a full valid /queue row MATCHING the id ⇒ running (positive wins amid a malformed sibling), never given up.
  {
    const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 1 });
    const { tracker, giveUps } = h;
    tracker.onQueued("R");
    const fetchHistory = async () => null; // clean-absent
    const fetchQueued = async (id) => queueMembership({ queue_running: [full(0, "R"), [9]], queue_pending: [] }, id); // match + malformed sibling ⇒ true
    await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
    for (let i = 0; i < 3; i++) {
      h.advance(1000);
      await h.fireDueTimers();
    }
    assert.equal(giveUps.length, 0, "a matched (running) prompt is never given up");
    assert.equal(tracker._pending.has("R"), true, "left pending");
  }
});

test("#370 P1 (codex): a MALFORMED /queue (non-array fields) is uncertain → NOT given up, later output delivers", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 1 });
  const { tracker, flushes, giveUps } = h;
  tracker.onQueued("m");
  const fetchHistory = async () => null; // clean-absent /history
  // /queue returns a 200 but with malformed (non-array) queue fields — the panel's
  // queueMembership maps this to null (uncertain), so the tracker must NOT give up.
  const fetchQueued = async (id) => queueMembership({ queue_running: {}, queue_pending: {} }, id);
  const summary = await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.deepEqual(summary, [{ promptId: "m", status: "running" }], "malformed queue ⇒ running, not unknown");
  for (let i = 0; i < 3; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.equal(giveUps.length, 0, "a malformed /queue never causes a give-up");
  assert.equal(tracker._pending.has("m"), true, "left pending (uncertain)");
  assert.equal(tracker.wasTerminal("m"), false, "not fenced");

  // Its later live output still delivers.
  tracker.onExecutionStart("m");
  tracker.onExecuted("m", { images: [{ filename: "m.png", type: "output" }] });
  tracker.onExecutionSuccess("m");
  assert.ok(flushes.find((f) => f.promptId === "m"), "output delivered, not dropped");
});

test("#370 P1 (codex): a MALFORMED /history 200 body (null) is uncertain → NOT given up, later output delivers", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 1 });
  const { tracker, flushes, giveUps } = h;
  tracker.onQueued("R");
  // /history/R returns 200 with a malformed body (`null`) — historyEntryFor maps
  // this to `undefined` (uncertain), so the reconciler must NOT give up even though
  // /queue is well-formed-both-absent.
  const fetchHistory = async (id) => historyEntryFor(null, id); // ⇒ undefined
  const fetchQueued = async (id) => queueMembership({ queue_running: [], queue_pending: [] }, id); // false
  const summary = await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.deepEqual(summary, [{ promptId: "R", status: "running" }], "malformed history ⇒ running, not unknown");
  for (let i = 0; i < 3; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.equal(giveUps.length, 0, "a malformed /history never causes a give-up");
  assert.equal(tracker._pending.has("R"), true, "left pending (uncertain)");
  assert.equal(tracker.wasTerminal("R"), false, "not fenced");

  // Its later live output still delivers.
  tracker.onExecutionStart("R");
  tracker.onExecuted("R", { images: [{ filename: "R.png", type: "output" }] });
  tracker.onExecutionSuccess("R");
  assert.ok(flushes.find((f) => f.promptId === "R"), "output delivered, not dropped");
});

test("#370 P1 (codex): give-up requires BOTH a well-formed absent /history map AND well-formed absent /queue", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 1 });
  const { tracker, giveUps } = h;
  // well-formed /history map lacking the id (⇒ null) AND well-formed empty /queue (⇒ false).
  const fetchHistory = async (id) => historyEntryFor({}, id); // ⇒ null (clean absence)
  const fetchQueued = async (id) => queueMembership({ queue_running: [], queue_pending: [] }, id); // ⇒ false
  tracker.onQueued("gone");
  await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  for (let i = 0; i < 3; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.deepEqual(giveUps, [{ promptId: "gone" }], "both sides well-formed-absent ⇒ give up once (memory bound)");
  assert.equal(tracker._pending.has("gone"), false, "evicted");
});

test("#370 P1 (codex): give-up STILL fires when /history null AND /queue well-formed both-absent", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 1 });
  const { tracker, giveUps } = h;
  tracker.onQueued("gone");
  const fetchHistory = async () => null;
  const fetchQueued = async (id) => queueMembership({ queue_running: [], queue_pending: [] }, id); // valid + absent ⇒ false
  await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  for (let i = 0; i < 3; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.deepEqual(giveUps, [{ promptId: "gone" }], "well-formed both-absent still gives up (memory bound intact)");
  assert.equal(tracker._pending.has("gone"), false, "evicted");
});

test("#370 P1 (codex): CONCURRENT reconciles give up a gone prompt exactly once (no double notice)", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 0 });
  const { tracker, giveUps } = h;
  tracker.onQueued("g");
  const fetchHistory = async () => null; // clean-absent
  const fetchQueued = async () => false; // absent from /queue ⇒ gone
  // Two reconcile passes race over the same pending prompt (both resolve "unknown"
  // and, with a zero budget, both reach giveUpReconcile). The ownership claim must
  // ensure the eviction + onReconcileGiveUp notice fire only ONCE.
  await Promise.all([
    tracker.reconcile({ fetchHistory, fetchQueued, isVideo }),
    tracker.reconcile({ fetchHistory, fetchQueued, isVideo }),
  ]);
  assert.deepEqual(giveUps, [{ promptId: "g" }], "given up exactly once despite the race");
  assert.equal(tracker._pending.has("g"), false, "evicted once");
});

test("#370 P1 (codex): only a STRICT null /history is give-up eligible — undefined stays running", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 1 });
  const { tracker, giveUps } = h;
  const fetchQueued = async () => false; // /queue absent for both
  // A custom fetchHistory that resolves `undefined` (not null) must NOT be treated
  // as a clean absence — undefined is uncertain, never give-up eligible.
  const fetchHistory = async (id) => (id === "u" ? undefined : null);
  tracker.onQueued("u");
  tracker.onQueued("n");
  await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  for (let i = 0; i < 3; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.deepEqual(giveUps, [{ promptId: "n" }], "only strict-null history gives up (undefined does not)");
  assert.equal(tracker._pending.has("u"), true, "undefined-history prompt stays pending (uncertain)");
  assert.equal(tracker._pending.has("n"), false, "null-history + absent-queue evicted");
});

test("#370 P1 (codex): a /history 503 (fetch throws) is UNCERTAIN → running, never given up even if /queue is absent", async () => {
  const h = makeHarness({ reconcileRetryMs: 1000, maxReconcileRetries: 2 });
  const { tracker, flushes, giveUps } = h;
  // A finished render whose /history is transiently 503 AND already gone from /queue.
  // The 503 must be treated as uncertain — NOT a clean absence — so it's never
  // given up (its result may just be temporarily unreadable).
  tracker.onQueued("H");
  const fetchHistory = async () => {
    throw new Error("503"); // /history unreachable
  };
  const fetchQueued = async () => false; // not in /queue
  const summary = await tracker.reconcile({ fetchHistory, fetchQueued, isVideo });
  assert.deepEqual(summary, [{ promptId: "H", status: "running" }], "503 ⇒ running (uncertain), not unknown");
  for (let i = 0; i < 4; i++) {
    h.advance(1000);
    await h.fireDueTimers();
  }
  assert.equal(giveUps.length, 0, "a 503 /history is NEVER given up");
  assert.equal(tracker._pending.has("H"), true, "left pending");
  assert.equal(tracker.wasTerminal("H"), false, "not fenced");
  // /history recovers as terminal on a later reconnect → delivered.
  const okHistory = async (id) => ({ [id]: undefined }[id] ?? successEntry({ 1: { images: [{ filename: "H.png", type: "output" }] } }));
  await tracker.reconcile({ fetchHistory: okHistory, fetchQueued, isVideo });
  assert.equal(flushes.filter((f) => f.promptId === "H").length, 1, "delivered once /history recovered");
});

test("#370 still-running: reconcile leaves it pending and delivers nothing", async () => {
  const { tracker, flushes } = makeHarness();
  tracker.onExecutionStart("pR");
  // History entry exists but has no terminal status yet.
  const history = { pR: { outputs: {}, status: {} } };
  const summary = await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.length, 0);
  assert.deepEqual(summary, [{ promptId: "pR", status: "running" }]);
  // Later the run finishes → a subsequent reconcile delivers it.
  history.pR = successEntry({ 1: { images: [{ filename: "late.png", type: "output" }] } });
  await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].promptId, "pR");
});

// ─────────────────────────────────────────────────────────────────────────────
// panel#356 Bug 2 — hasPending() gate for the periodic SAFETY-SWEEP reconcile
//
// The reconnect reconcile is EDGE-triggered only (ComfyUI `reconnected` / bridge
// back). If the ComfyUI WS silently drops and reopens during an idle gap between
// agent turns WITHOUT firing `reconnected`, the terminal `execution_success` is
// missed and NO edge fires — the run finishes but the agent is never notified.
// The panel arms a periodic sweep that re-runs reconcile WHILE `hasPending()`, so
// such a completion is recovered even with no reconnect edge. These lock the gate
// the panel's self-disarming sweep loop depends on.
// ─────────────────────────────────────────────────────────────────────────────

test("panel#356: hasPending() false with no runs, true once a prompt is queued", () => {
  const { tracker } = makeHarness();
  assert.equal(tracker.hasPending(), false, "no runs ⇒ nothing to sweep");
  tracker.onQueued("Q1");
  assert.equal(tracker.hasPending(), true, "a queued prompt arms the sweep");
});

test("panel#356: a LIVE, delivered success drains the ledger so the sweep disarms", () => {
  const { tracker, flushes } = makeHarness();
  tracker.onQueued("L1");
  tracker.onExecutionStart("L1");
  tracker.onExecuted("L1", { images: [{ filename: "a.png", type: "output" }] });
  assert.equal(tracker.hasPending(), true, "pending until the terminal signal");
  tracker.onExecutionSuccess("L1"); // observed live ⇒ flush + markDelivered
  assert.equal(flushes.length, 1, "delivered live");
  assert.equal(tracker.hasPending(), false, "delivered ⇒ ledger drained ⇒ sweep self-disarms");
});

test("panel#356: a MISSED terminal success keeps hasPending() true; a sweep reconcile recovers it and drains", async () => {
  const { tracker, flushes } = makeHarness();
  // Idle-gap WS drop: the run queues + starts, but its execution_success is NEVER
  // observed (no reconnect edge fires), so it stays pending — exactly the stall.
  tracker.onQueued("M1");
  tracker.onExecutionStart("M1");
  assert.equal(tracker.hasPending(), true, "still pending — the sweep would stay armed");

  // Simulate the panel's self-disarming sweep loop: reconcile against /history
  // while anything is pending. The run has since finished on the server.
  const history = {
    M1: successEntry({ 1: { images: [{ filename: "m1.png", type: "output" }] } }),
  };
  let sweeps = 0;
  while (tracker.hasPending() && sweeps < 5) {
    sweeps += 1;
    await tracker.reconcile({
      fetchHistory: async (id) => history[id] ?? null,
      fetchQueued: async () => false,
      isVideo,
    });
  }
  assert.equal(flushes.filter((f) => f.promptId === "M1").length, 1, "sweep recovered the missed completion exactly once");
  assert.equal(tracker.hasPending(), false, "recovery drained the ledger ⇒ sweep disarms");
  assert.equal(sweeps, 1, "one sweep sufficed once /history was terminal");
});
