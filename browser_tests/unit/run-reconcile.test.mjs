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
import { parseHistoryEntry } from "../../web/js/lib/history-reconcile.js";

const isVideo = (m) => /\.(mp4|webm|mov)$/i.test(String(m?.filename || ""));

function makeHarness() {
  let clock = 0;
  const timers = new Map();
  let seq = 0;
  const flushes = [];
  const tracker = createRunCompletionTracker({
    onFlush: (p) => flushes.push(p),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    debounceMs: 1500,
  });
  return {
    tracker,
    flushes,
    advance: (ms) => {
      clock += ms;
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
  // pB stays pending (unknown), pA delivered — no cross-contamination.
  const byId = Object.fromEntries(summary.map((r) => [r.promptId, r.status]));
  assert.equal(byId.pA, "success");
  assert.equal(byId.pB, "unknown");
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
  assert.equal(tracker.wasDelivered("pL"), true);

  // The live WS now replays the buffered lifecycle for the SAME prompt. None of it
  // may produce a second completion.
  tracker.onExecutingNode("pL");
  tracker.onExecuted("pL", { images: [{ filename: "final.png", type: "output" }] });
  tracker.onExecutionSuccess("pL");
  assert.equal(flushes.length, 1, "no duplicate completion from the late live events");
});

test("#370 codex P1 (idempotency): wasDelivered fences a late execution_error after a reconciled error", async () => {
  const { tracker, flushes } = makeHarness();
  tracker.onExecutionStart("pX");
  const history = { pX: { outputs: {}, status: { status_str: "error" } } };
  await tracker.reconcile({ fetchHistory: async (id) => history[id] ?? null, isVideo });
  assert.equal(tracker.wasDelivered("pX"), true, "reconciled error is marked delivered");
  // Panel checks wasDelivered() BEFORE onExecutionFailed to skip the duplicate
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
  assert.equal(tracker.wasDelivered("p1"), true, "fenced right after delivery");

  // Well past the fence TTL, a new delivery prunes the stale fence (bounded memory).
  advance(10 * 60 * 1000 + 1);
  tracker.onExecutionStart("p2");
  tracker.onExecuted("p2", { images: [{ filename: "b.png", type: "output" }] });
  tracker.onExecutionSuccess("p2");
  assert.equal(tracker.wasDelivered("p1"), false, "stale fence aged out");
  assert.equal(tracker.wasDelivered("p2"), true, "recent fence retained");
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
