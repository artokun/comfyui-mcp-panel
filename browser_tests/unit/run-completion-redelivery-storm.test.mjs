/**
 * panel#1842 — the pre-receipt reconcile REPLAY must be bounded.
 *
 * REPORTED SHAPE. After ~10 `panel_run` calls the panel began re-delivering the
 * SAME completed-run notifications every agent turn, indefinitely: 40+
 * consecutive turns for a fixed set of 6 already-finished prompt ids, with
 * `running: 0, pending: 0` on the queue and no new runs — the flood continued
 * after the agent stopped calling `panel_run` at all.
 *
 * MECHANISM. A KEYED `panel_run` completion deliberately stays in the tracker's
 * `pending` ledger until the orchestrator's receipt (`acknowledgeDelivery`), and
 * #1824 deliberately lets a /history reconcile REPLAY that completion under the
 * same completion key before the receipt arrives — that is how a frame lost in
 * transit is recovered. What was missing is a BOUND: `reconcileKey`'s only entry
 * guard was `delivered.has(k) || !pending.has(k)`, which a run awaiting a receipt
 * satisfies neither of, so the 20-second safety sweep re-emitted the same
 * finished run on EVERY tick for as long as the panel stayed open.
 *
 * The replay's premise — "the key makes it idempotent downstream" — is a
 * property of the OTHER process, and it was false for the orchestrator the
 * reporters ran: comfyui-mcp sent no `ack {kind:"completion"}` at all before
 * v0.52.122 (`8282e05`), so no receipt could arrive and every replay minted a
 * fresh agent turn.
 *
 * WHAT IS COUNTED is deliberately "frames the transport ACCEPTED for this run
 * and no receipt has retired", not "reconcile passes": a refusal gives its own
 * slot back but must never reset the count, or a flapping transport mints one
 * agent turn per flap forever and the bound is decorative (codex gate R1 P1).
 *
 * The tests below are pins for the bound plus CONTROLS for everything that must
 * still be delivered. "Stop the replays" is satisfiable by delivering nothing,
 * which is strictly worse than the bug (#1739 / #585 / #370 are all that class),
 * so the controls are the load-bearing half — and three of them are green on
 * unfixed main as well as on the fix, which is what makes them controls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

const PROMPT = "122c1547-990a-4ea2-8594-95998585a364";
const ROUTE = "route-a";
const SESSION = "sess-1";
const IMAGE = { filename: "out_0001.png", subfolder: "", type: "output" };

/**
 * The bound, written out here as its own literal rather than imported from the
 * module under test. An expectation computed from the code it is checking moves
 * with that code and stops being an expectation, so changing
 * `maxUnackedDeliveries` must fail these tests and make someone re-argue the
 * number.
 */
const BUDGET = 3;

const HISTORY = {
  outputs: { 9: { images: [IMAGE] } },
  status: { status_str: "success", completed: true, messages: [] },
};

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
  const probes = { history: 0 };
  /** One pass of the periodic safety sweep (createRunReconcileSweep -> reconcile). */
  const sweep = () =>
    tracker.reconcile({
      fetchHistory: async () => {
        probes.history += 1;
        return HISTORY;
      },
      fetchQueued: async () => false,
      isVideo: () => false,
    });
  return { tracker, flushes, sweep, probes, advance: (ms) => { clock += ms; } };
}

/** A panel_run that queued, rendered and succeeded — its receipt still owed. */
function runToSuccess(tracker) {
  const completionKey = tracker.onQueued(PROMPT, { routeId: ROUTE, sessionId: SESSION });
  tracker.onExecutionStart(PROMPT);
  tracker.onExecuted(PROMPT, { images: [IMAGE] });
  tracker.onExecutionSuccess(PROMPT);
  return completionKey;
}

test("#1842: the sweep stops re-delivering a receipt-less completion after a bounded number of frames", async () => {
  const { tracker, flushes, sweep, probes } = makeHarness();
  const completionKey = runToSuccess(tracker);

  assert.equal(flushes.length, 1, "the live execution_success delivers exactly one frame");
  assert.equal(tracker.hasPending(), true, "a keyed panel_run stays pending until its receipt");

  // The orchestrator never acknowledges (comfyui-mcp < 0.52.122 had no ack at
  // all). The sweep re-arms for as long as hasPending() is true, so this is what
  // the reporter's session did every 20 seconds for 40+ turns.
  for (let tick = 0; tick < 20; tick += 1) await sweep();

  assert.equal(
    flushes.length,
    BUDGET,
    "twenty sweep ticks must not compose twenty more copies of one finished run",
  );
  assert.equal(
    probes.history,
    BUDGET - 1,
    "…and past the budget the run is refused BEFORE the /history probe, so the sweep " +
      "also stops hammering ComfyUI once per stuck run per tick, forever",
  );
  assert.equal(tracker.hasPending(), true, "the run is still owed its receipt");
  assert.equal(
    tracker.isDeliveryUnconfirmed(PROMPT),
    false,
    "…and the #585 delivery evidence is untouched by the budget",
  );

  // The receipt, whenever it lands, still retires the run.
  assert.equal(tracker.acknowledgeDelivery(PROMPT, completionKey), true);
  assert.equal(tracker.hasPending(), false, "an acked completion drains the ledger");
  assert.equal(flushes.length, BUDGET, "and no further frame is composed");
});

// The codex gate's R1 P1, pinned. An earlier revision RESET the count on every
// refusal, so alternating refuse/accept — a flapping bridge, or a route that
// keeps moving under `sendRunCompletionFrame` — minted one fresh agent turn per
// flap, forever. The bound has to be on frames that were ACCEPTED.
test("#1842: a FLAPPING transport cannot mint unlimited turns by resetting the budget", async () => {
  // Shaped like production: the flush handler decides each frame's fate and
  // reports a refusal through markUndelivered, so exactly one refusal can ever
  // correspond to one emission.
  let clock = 0;
  const accepted = [];
  const emitted = [];
  let socketUp = true;
  let tracker;
  tracker = createRunCompletionTracker({
    onFlush: (payload) => {
      emitted.push(payload);
      socketUp = !socketUp; // the bridge flaps between every attempt
      if (socketUp) accepted.push(payload);
      else tracker.markUndelivered(payload.promptId, payload.completionKey);
    },
    now: () => clock,
    setTimer: () => 0,
    clearTimer: () => {},
    debounceMs: 1500,
  });
  runToSuccess(tracker);

  for (let flap = 0; flap < 40; flap += 1) {
    await tracker.reconcile({
      fetchHistory: async () => HISTORY,
      fetchQueued: async () => false,
      isVideo: () => false,
    });
  }

  assert.equal(
    accepted.length,
    BUDGET,
    `a flapping transport landed ${accepted.length} frames on the agent; the bound is ${BUDGET}`,
  );
  const settled = emitted.length;
  for (let flap = 0; flap < 10; flap += 1) {
    await tracker.reconcile({
      fetchHistory: async () => HISTORY,
      fetchQueued: async () => false,
      isVideo: () => false,
    });
  }
  assert.equal(emitted.length, settled, "…and it has stopped composing frames entirely");
});

// #1824's own call-site test (run-command-budget.test.mjs) pins this too. It is
// repeated here because it is the property the bound must not destroy: the FIRST
// replay is the recovery for a frame lost in transit, and a bound that started at
// zero would silently un-ship it.
test("CONTROL #1824: a reconcile before the receipt still replays the SAME keyed completion", async () => {
  const { tracker, flushes, sweep } = makeHarness();
  const completionKey = runToSuccess(tracker);
  assert.equal(flushes.length, 1);

  await sweep();
  assert.equal(flushes.length, 2, "the pre-receipt reconcile replays the completion");
  assert.equal(flushes[1].reconciled, true);
  assert.equal(
    flushes[1].completionKey,
    completionKey,
    "…under the same key, so it is idempotent to an orchestrator that reads receipts",
  );
});

// Green on unfixed `origin/main` as well as on the fix — that is what makes it a
// control rather than a second pin. Keep the storm assertion OUT of it.
test("CONTROL #1739: a completion the TRANSPORT refused is still re-delivered by the sweep", async () => {
  const { tracker, flushes, sweep } = makeHarness();
  const completionKey = runToSuccess(tracker);
  assert.equal(flushes.length, 1);

  // sendFrame returned false (bridge down when the flush fired) — the caller
  // re-pends the run. This is the ONLY thing standing between the agent and a
  // silently lost render, so the bound must not swallow it.
  tracker.markUndelivered(PROMPT, completionKey);

  await sweep();
  assert.equal(flushes.length, 2, "a re-pended completion is re-delivered");
  assert.equal(flushes[1].reconciled, true, "…from /history, as the #370 recovery");
  assert.equal(flushes[1].promptId, PROMPT);
});

// The other half of the same guarantee, and the reason the refusal DECREMENTS
// rather than merely being ignored: a run nothing has ever accepted is not
// bounded at all, because no frame has ever had a chance to reach the agent.
test("CONTROL: a run whose frames are ALWAYS refused is retried without limit", async () => {
  const { tracker, flushes, sweep } = makeHarness();
  const completionKey = runToSuccess(tracker);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    tracker.markUndelivered(PROMPT, completionKey);
    await sweep();
  }

  assert.equal(
    flushes.length,
    13,
    "every attempt after a refusal is re-delivered — nothing ever landed, so nothing is bounded",
  );
  assert.equal(tracker.hasPending(), true);
});

test("REACHABILITY: production drives this exact path — the safety sweep calls tracker.reconcile", () => {
  // The bound lives in `reconcileKey`. A green tracker test proves the mechanism
  // works; it does not prove the panel reaches it. The reported storm is the
  // periodic sweep re-arming on `hasPending()` and calling `reconcile()`, so pin
  // that wiring rather than assume it.
  const src = readFileSync(PANEL_JS, "utf8");
  const sweep = src.indexOf("createRunReconcileSweep({");
  assert.notEqual(sweep, -1, "the panel still constructs the periodic safety sweep");
  const block = src.slice(sweep, sweep + 600);
  assert.match(block, /hasPending:\s*\(\)\s*=>\s*runCompletion\.hasPending\(\)/, "armed by the ledger");
  assert.match(block, /reconcile:\s*\(\)\s*=>\s*reconcileRunsAfterReconnect\(\)/, "…and it reconciles");
  assert.match(
    src,
    /runCompletion\.reconcile\(\{/,
    "reconcileRunsAfterReconnect drives the tracker's own reconcile, which is where the bound is",
  );
});

// Also green BOTH BEFORE AND AFTER, for the same reason as the #1739 control.
test("CONTROL #370: a run whose execution_success was MISSED entirely is still recovered", async () => {
  const { tracker, flushes, sweep } = makeHarness();
  // Queued, then the WS drops: no execution_start, no executed, no success.
  tracker.onQueued(PROMPT, { routeId: ROUTE, sessionId: SESSION });
  assert.equal(flushes.length, 0);
  assert.equal(tracker.hasPending(), true);

  await sweep();
  assert.equal(flushes.length, 1, "the sweep is still the recovery for an outcome never seen");
  assert.equal(flushes[0].reconciled, true);
  assert.equal(flushes[0].images.length, 1);
});
