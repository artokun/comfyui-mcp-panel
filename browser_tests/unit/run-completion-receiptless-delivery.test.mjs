/**
 * panel#1871 — the receipt-less `panel_run` completion, driven END TO END.
 *
 * THE GAP THIS FILE CLOSES. Two suites already stand on either side of this
 * path and neither crosses it:
 *
 *  - `run-completion-redelivery-storm.test.mjs` pins the BOUND (#1842), but its
 *    harness flushes into `(p) => flushes.push(p)`. The production delivery
 *    boundary — `run-completion-delivery.js` — never executes there, so the one
 *    decision that matters here ("is this entry retired on the socket write?")
 *    is never actually taken. Every assertion in that file survives a mutation
 *    of the guard, because the guard is not on the path.
 *  - `run-completion.test.mjs` DOES wire the real handler, but around a
 *    REFUSING transport (#1830 session-switch): `sendFrame` returns false, which
 *    lands in a different branch of the same `if`. A write that FAILS re-pends
 *    for reasons that have nothing to do with the receipt.
 *
 * Nobody drove the case #1824 actually reported: the socket write SUCCEEDS and
 * the orchestrator receipt never arrives. That run — a 458-second SaveVideo —
 * was retired on `framePushed` alone, so the /history sweep never saw it again
 * and the user waited 31 minutes before checking by hand.
 *
 * THE SEQUENCE PINNED BELOW is that path as one story, with the real tracker
 * and the real delivery handler wired together the way `comfyui-mcp-panel.js`
 * wires them:
 *
 *   1. the completion flushes and `sendFrame` returns TRUE
 *   2. `awaitsReceipt` is set, so the entry is NOT retired  <- the #1824 defect
 *   3. no receipt arrives
 *   4. the /history sweep finds the still-pending entry and re-delivers it
 *   5. delivery stops at `maxUnackedDeliveries` — not zero, not unbounded
 *
 * ASSERTION 2 IS THE LOAD-BEARING ONE. Deleting `!awaitsReceipt` from
 * `run-completion-delivery.js` retires the run on the write, and steps 3-5 stop
 * existing: there is no storm left to bound, which is exactly why the storm test
 * stays green through that mutation.
 *
 * ASSERTION 5 KEEPS IT HONEST. The panel cannot tell "delivered but
 * unacknowledged" from "written but lost", so the designed answer is a bounded
 * retry and then silence. A test asserting unbounded recovery would be pinning
 * the wrong behaviour — and #1842 is the incident where unbounded replay was the
 * bug.
 *
 * The CONTROLS at the bottom are the other half. "Never retire anything" also
 * satisfies steps 1-4, and is strictly worse than the bug, so an unkeyed
 * completion must still retire on its write, and a receipt must still retire a
 * keyed one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";
import { createRunCompletionFlushHandler } from "../../web/js/lib/run-completion-delivery.js";

const PROMPT = "9f0f7d2e-6c1a-49f0-9f0a-1c2f5a6b7c8d";
const ROUTE = "route-a";
const SESSION = "sess-1";
const IMAGE = { filename: "receiptless_0001.png", subfolder: "", type: "output" };

/**
 * The bound, written out as its own literal rather than read from the module —
 * an expectation computed from the code it checks moves with that code and stops
 * being an expectation. Changing `maxUnackedDeliveries` must fail this file and
 * make someone re-argue the number (same rule as the storm suite).
 */
const BUDGET = 3;

const HISTORY = {
  outputs: { 9: { images: [IMAGE] } },
  status: { status_str: "success", completed: true, messages: [] },
};

/**
 * The composition is fire-and-forget inside the delivery handler (metadata
 * HEADs, storyboard sampling), so the retire decision lands a few turns after
 * the tracker returns. Every double below resolves immediately, so yielding the
 * macrotask queue a bounded number of times is enough — and cannot hang.
 */
async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The panel's own wiring: `createRunCompletionTracker({ onFlush:
 * createRunCompletionFlushHandler({...}) })`, with `markDelivered` /
 * `markUndelivered` pointed back at the tracker, exactly as
 * `comfyui-mcp-panel.js` points them. The only doubles are the transport and the
 * composer's I/O helpers.
 */
function makeDeliveryHarness({ sendSucceeds = () => true } = {}) {
  const sent = [];
  const painted = [];
  const prunes = [];
  let tracker;

  const onFlush = createRunCompletionFlushHandler({
    sendFrame: (frame) => {
      const ok = sendSucceeds(frame);
      if (ok) sent.push(frame);
      return ok;
    },
    markDelivered: (promptId, completionKey) => tracker.markDelivered(promptId, completionKey),
    markUndelivered: (promptId, completionKey) => tracker.markUndelivered(promptId, completionKey),
    pruneRebootMarker: () => prunes.push(true),
    coerceMessageText: (v) => (v == null ? "" : typeof v === "string" ? v : String(v)),
    formatDuration: (ms) => (ms == null ? null : `${Math.round(ms / 1000)}s`),
    formatClock: () => "12:00:00",
    imageViewUrl: (m) => `view://${m?.filename ?? "x"}?type=${m?.type ?? "output"}`,
    fetchImageBytes: async () => 2048,
    fetchImageDimensions: async () => ({ w: 512, h: 512 }),
    humanizeBytes: (n) => (n == null ? null : `${n} B`),
    buildVideoStoryboard: async () => null,
    uploadBlobToInput: async (_blob, name, opts) => ({ filename: name, type: opts?.type || "input" }),
    storyboardFrameCount: () => 20,
    paintImage: (url, name) => painted.push({ url, name }),
    applyVideoPoster: () => {},
    videoStoryboardEnabled: false,
    agentReceivesImages: () => true,
    isAgentMuted: () => false,
    warn: () => {},
  });

  tracker = createRunCompletionTracker({
    onFlush,
    setTimer: () => 0,
    clearTimer: () => {},
  });

  const probes = { history: 0 };
  /** One pass of the periodic safety sweep (createRunReconcileSweep -> reconcile). */
  const sweep = async () => {
    await tracker.reconcile({
      fetchHistory: async () => {
        probes.history += 1;
        return HISTORY;
      },
      fetchQueued: async () => false,
      isVideo: () => false,
    });
    await settle();
  };

  return { tracker, sent, painted, prunes, probes, sweep };
}

test("#1871/#1824: a completion whose write SUCCEEDS but is never acked stays pending, is swept, and stops at the bound", async () => {
  const { tracker, sent, sweep, probes } = makeDeliveryHarness();

  // --- step 1: the run completes and the socket write succeeds -------------
  const completionKey = tracker.onQueued(PROMPT, { routeId: ROUTE, sessionId: SESSION });
  assert.ok(completionKey, "a route-scoped panel_run carries a completion key");

  tracker.onExecutionStart(PROMPT);
  tracker.onExecuted(PROMPT, { images: [IMAGE] });
  tracker.onExecutionSuccess(PROMPT);
  await settle();

  assert.equal(sent.length, 1, "step 1: the live execution_success writes exactly one frame");
  assert.equal(
    sent[0].completion_key,
    completionKey,
    "…and the delivery boundary stamps it with the run's completion key",
  );

  // --- step 2: NOT retired on the write alone ------------------------------
  // This is the #1824 defect, and the only assertion in the suite that the
  // production `framePushed && !awaitsReceipt && !awaitsCompletionKey` guard can
  // fail. A successful write is evidence the BROWSER handed the frame over; it
  // is not evidence the orchestrator received it.
  assert.equal(
    tracker.hasPending(),
    true,
    "step 2: a keyed completion is retired by its RECEIPT, never by the socket write",
  );
  assert.equal(
    tracker.completionMetadata().map((row) => row.completionKey).join(),
    completionKey,
    "…and the run keeps its exact identity for the replay",
  );

  // --- step 3: no receipt ever arrives -------------------------------------
  // (acknowledgeDelivery is deliberately not called: comfyui-mcp sent no
  // `ack {kind:"completion"}` at all before v0.52.122.)

  // --- step 4: the /history sweep re-delivers it ---------------------------
  await sweep();
  assert.equal(sent.length, 2, "step 4: the sweep finds the still-pending run and re-delivers it");
  assert.equal(sent[1].completion_key, completionKey, "…under the SAME key, so a receipt can still retire it");
  assert.ok(probes.history >= 1, "…having actually probed /history for the outcome");

  // --- step 5: and stops at the bound, not before and not forever ----------
  for (let tick = 0; tick < 20; tick += 1) await sweep();

  assert.equal(
    sent.length,
    BUDGET,
    `step 5: delivery stops at ${BUDGET} frames — not 1 (retired early, #1824) and not 22 (unbounded, #1842)`,
  );
  assert.equal(tracker.hasPending(), true, "the run stays owed until something acknowledges it");
});

test("CONTROL #1871: a receipt — whenever it comes — still retires the run and composes nothing further", async () => {
  const { tracker, sent, sweep } = makeDeliveryHarness();
  const completionKey = tracker.onQueued(PROMPT, { routeId: ROUTE, sessionId: SESSION });
  tracker.onExecutionStart(PROMPT);
  tracker.onExecuted(PROMPT, { images: [IMAGE] });
  tracker.onExecutionSuccess(PROMPT);
  await settle();
  await sweep();
  assert.equal(sent.length, 2, "one live frame plus one swept replay");

  assert.equal(tracker.acknowledgeDelivery(PROMPT, completionKey), true, "the receipt lands");
  assert.equal(tracker.hasPending(), false, "…and retires the run");

  await sweep();
  assert.equal(sent.length, 2, "an acknowledged run is never swept again");
});

test("CONTROL #1871: an UNKEYED completion is still retired by its successful write", async () => {
  // "Never retire anything" would satisfy the main test above while breaking
  // every canvas run, so the legacy/unkeyed transport-confirmation behaviour is
  // pinned here: no completion key means no receipt is coming, and the write is
  // the only confirmation that exists.
  const { tracker, sent, sweep } = makeDeliveryHarness();

  tracker.onExecutionStart(PROMPT);
  tracker.onExecuted(PROMPT, { images: [IMAGE] });
  tracker.onExecutionSuccess(PROMPT);
  await settle();

  assert.equal(sent.length, 1, "the canvas run delivers one frame");
  assert.equal(sent[0].completion_key, undefined, "…with no completion key, because nothing will ack it");
  assert.equal(tracker.hasPending(), false, "an unkeyed completion IS retired on its successful write");

  await sweep();
  assert.equal(sent.length, 1, "…and the sweep has nothing left to replay");
});

test("CONTROL #1871: a write that FAILS gives its slot back, so a run nothing accepted is not capped", async () => {
  // The bound counts frames the transport ACCEPTED. A refusal must not spend a
  // slot, or a flapping socket exhausts the budget without the agent ever having
  // been told anything — the #1842 gate's P1.
  let accept = false;
  const { tracker, sent, sweep } = makeDeliveryHarness({ sendSucceeds: () => accept });

  const completionKey = tracker.onQueued(PROMPT, { routeId: ROUTE, sessionId: SESSION });
  tracker.onExecutionStart(PROMPT);
  tracker.onExecuted(PROMPT, { images: [IMAGE] });
  tracker.onExecutionSuccess(PROMPT);
  await settle();

  assert.equal(sent.length, 0, "the down transport accepted nothing");
  assert.equal(tracker.hasPending(), true, "the completion stays recoverable");

  for (let tick = 0; tick < 10; tick += 1) await sweep();
  assert.equal(sent.length, 0, "…still nothing accepted after ten refused sweeps");

  accept = true;
  await sweep();
  assert.equal(sent.length, 1, "the budget was never spent, so the recovered frame still gets through");
  assert.equal(sent[0].completion_key, completionKey, "…as the exact run the agent is waiting on");
});
