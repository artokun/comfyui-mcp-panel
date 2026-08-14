// Unit tests for web/js/lib/rehello-gate.js — run with `node --test`.
//
// #1095: creating a workflow and immediately applying a batch of graph mutations lost the
// panel's route mid-batch —
//
//     panel tab tmp:2806 disconnected mid-command (graph_set_widget) — OUTCOME UNKNOWN
//     then: no connected tab ... Connected: none
//
// — because a re-advertise makes the backend drop this socket's prior tab mapping, and
// nothing stopped one from firing while a command was routed to that mapping.
//
// THE GATE IS DRIVEN HERE, NOT ASSERTED ABOUT AT SOURCE. The invariant is a temporal one
// ("no hello reaches the wire between a command starting and its reply") and a source
// pattern cannot express it: `if (false) advertise()` matches every regex you could write
// for it. Every test below runs the real factory with an injected clock and timer, and
// asserts on what was actually sent and when.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createRehelloGate,
  deferBudgetMs,
  HUMAN_PACED_COMMANDS,
  REHELLO_DEFER_MS,
  REHELLO_DEFER_HUMAN_MS,
} from "../../web/js/lib/rehello-gate.js";

/** A gate on a controllable clock. `advance` fires due timers in time order and lets them
 *  re-arm, because the gate deliberately re-arms rather than trusting a stale wake-up. */
function harness({ landed = true, advertise } = {}) {
  let t = 0;
  let nextId = 1;
  const timers = new Map();
  const sends = [];
  const gate = createRehelloGate({
    advertise:
      advertise ||
      (() => {
        sends.push(t);
        return Promise.resolve(landed);
      }),
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
  });
  const advance = (ms) => {
    const target = t + ms;
    for (;;) {
      let due = null;
      for (const [id, entry] of timers) {
        if (entry.at <= target && (due === null || entry.at < due.entry.at)) due = { id, entry };
      }
      if (due === null) break;
      timers.delete(due.id);
      t = Math.max(t, due.entry.at);
      due.entry.fn();
    }
    t = target;
  };
  return { gate, sends, advance, armed: () => timers.size };
}

// --- the defect itself ----------------------------------------------------

test("#1095: a re-advertise does NOT withdraw the route while a command is in flight", async () => {
  const { gate, sends, advance } = harness();
  gate.began("graph_set_widget");
  const landed = gate.request();
  assert.deepEqual(sends, [], "the hello must not go out while the command is still routed");
  advance(1);
  assert.deepEqual(sends, [], "…and not on the next tick either");
  gate.ended();
  assert.equal(sends.length, 1, "it goes out the moment the batch drains");
  assert.equal(await landed, true, "and the caller learns it reached the wire");
});

test("#1095: with nothing in flight the hello is immediate — the gate adds no latency", async () => {
  const { gate, sends } = harness();
  const landed = await gate.request();
  assert.equal(sends.length, 1);
  assert.equal(landed, true);
});

test("#1095: the drain releases it, not the timer — the budget is a CEILING, not a delay", () => {
  const { gate, sends, advance, armed } = harness();
  gate.began("graph_set_widget");
  gate.request();
  advance(5);
  gate.ended();
  assert.equal(sends.length, 1, "a 4-second budget must not mean a 4-second stall");
  assert.equal(armed(), 0, "and the pending timer must be disarmed, not left to fire again");
});

// --- the bound ------------------------------------------------------------

test("#1095: a command that never reports back cannot strand the tab — the wait is BOUNDED", async () => {
  // Unbounded would convert a race into a wedge, which is worse: the tab would sit on the
  // old workflow's route forever, and the #607 fence recovery that would clear it is itself
  // a re-advertise waiting behind this same gate.
  const { gate, sends, advance } = harness();
  gate.began("graph_set_widget");
  const landed = gate.request();
  advance(REHELLO_DEFER_MS - 1);
  assert.deepEqual(sends, [], "still inside the budget");
  advance(2);
  assert.equal(sends.length, 1, "past the budget the re-advertise proceeds regardless");
  assert.equal(await landed, true);
});

test("#1095: a HUMAN-paced command is not abandoned on the machine budget", async () => {
  // Review's second finding on the first cut: ask_user/request_secret hold the window for as
  // long as the person takes, so a ~3s bound stalls briefly and then withdraws the route
  // anyway — the user answers a question and the orchestrator reports OUTCOME UNKNOWN for
  // the answer they just gave. These are the commands that most need the cover.
  const { gate, sends, advance } = harness();
  gate.began("ask_user");
  const landed = gate.request();
  advance(REHELLO_DEFER_MS + 1);
  assert.deepEqual(sends, [], "the machine budget must not apply to a command paced by a person");
  gate.ended();
  assert.equal(sends.length, 1, "the answer's reply is delivered first, then the re-advertise");
  assert.equal(await landed, true);
});

test("#1095: the human budget is a bound too — an abandoned card cannot hold the tab forever", () => {
  const { gate, sends, advance } = harness();
  gate.began("request_secret");
  gate.request();
  advance(REHELLO_DEFER_HUMAN_MS - 1);
  assert.deepEqual(sends, [], "still waiting on the person");
  advance(2);
  assert.equal(sends.length, 1, "past the human budget a live route beats a preserved outcome");
});

test("#1095: the budget classes are exactly the two clocks, and an unknown command is machine-paced", () => {
  assert.equal(deferBudgetMs("ask_user"), REHELLO_DEFER_HUMAN_MS);
  assert.equal(deferBudgetMs("request_secret"), REHELLO_DEFER_HUMAN_MS);
  assert.equal(deferBudgetMs("graph_set_widget"), REHELLO_DEFER_MS);
  // Under-declaring only shortens the wait; over-declaring would let any unrecognised frame
  // pin the route for the human budget. So the default must be the SHORT one.
  assert.equal(deferBudgetMs(undefined), REHELLO_DEFER_MS);
  assert.equal(deferBudgetMs("some_future_command"), REHELLO_DEFER_MS);
  assert.ok(REHELLO_DEFER_HUMAN_MS > REHELLO_DEFER_MS);
  assert.deepEqual([...HUMAN_PACED_COMMANDS].sort(), ["ask_user", "request_secret"]);
});

test("#1095: a command that STARTS during the wait extends it — the timer cannot fire early", () => {
  // The bound belongs to the commands, so a batch that keeps going keeps the cover. Firing
  // on the deadline that was current when the timer was armed would re-advertise while a
  // newer command is mid-flight: the exact race, reintroduced by the bound meant to end it.
  const { gate, sends, advance } = harness();
  gate.began("graph_set_widget"); // deadline t=4000
  gate.request();
  advance(3000);
  gate.began("ask_user"); // deadline t=33000
  advance(1500); // t=4500 — past the ORIGINAL deadline
  assert.deepEqual(sends, [], "the wait must follow the newest command, not the first one");
  gate.ended();
  gate.ended();
  assert.equal(sends.length, 1);
});

test("#1095: an already-spent budget does not restart the wait", () => {
  const { gate, sends, advance } = harness();
  gate.began("graph_set_widget");
  advance(REHELLO_DEFER_MS + 1); // budget spent before anyone asked to re-advertise
  gate.request();
  assert.equal(sends.length, 1, "a stuck command must not buy a fresh budget per request");
});

// --- coalescing and pairing ----------------------------------------------

test("#1095: several deferred re-advertises coalesce into ONE hello, all told the same outcome", async () => {
  // A hello is a statement of current state, not an event log: two parked requests both want
  // the orchestrator to hold this tab's live identity, and one send says that.
  const { gate, sends } = harness();
  gate.began("graph_set_widget");
  const a = gate.request();
  const b = gate.request();
  const c = gate.request();
  gate.ended();
  assert.equal(sends.length, 1, "one send, not a queue of three");
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
});

test("#1095: an over-release cannot convince the gate that nothing is running", () => {
  // deliverReply releases the mark, and a double-delivery (a retry, a future refactor) must
  // not drive the count negative — a negative count never returns to 0, so the gate would
  // wave every later re-advertise straight through and the race would be back.
  const { gate, sends } = harness();
  gate.began();
  gate.ended();
  gate.ended();
  gate.ended();
  assert.equal(gate.inFlight(), 0);
  gate.began("graph_set_widget");
  gate.request();
  assert.deepEqual(sends, [], "a real command must still be covered after the over-release");
  gate.ended();
  assert.equal(sends.length, 1);
});

test("#1095: a leaked mark delays the hello but can never block it", () => {
  // The mark/release pair is checked structurally in command-liveness.test.mjs. This is the
  // blast radius if one ever escapes anyway: the budget still expires.
  const { gate, sends, advance } = harness();
  gate.began("graph_set_widget"); // never released
  gate.request();
  advance(REHELLO_DEFER_MS + 1);
  assert.equal(sends.length, 1);
  // …and the tab is not permanently penalised: a later re-advertise is not made to wait out
  // a budget that has already expired.
  gate.request();
  assert.equal(sends.length, 2);
});

// --- teardown -------------------------------------------------------------

test("#1095: cancel() DROPS the parked hello — it must not fire into a replaced connection", async () => {
  const { gate, sends, advance, armed } = harness();
  gate.began("ask_user");
  const landed = gate.request();
  gate.cancel();
  assert.deepEqual(sends, [], "a hello queued for the old socket must never register the tab elsewhere");
  assert.equal(await landed, false, "waiters are told it did not land, rather than left pending");
  assert.equal(gate.inFlight(), 0, "commands abandoned with the socket must not leak the count");
  assert.equal(armed(), 0, "no timer may outlive the client");
  advance(REHELLO_DEFER_HUMAN_MS * 2);
  assert.deepEqual(sends, [], "and nothing fires later either");
});

// --- the gate's own failure modes ----------------------------------------

test("#1095: an advertise that THROWS resolves false — it never rejects out of the gate", async () => {
  const { gate } = harness({
    advertise: () => {
      throw new Error("send failed");
    },
  });
  assert.equal(await gate.request(), false);
});

test("#1095: an advertise that REJECTS resolves false, so a retry budget is not spent on a guess", async () => {
  const { gate } = harness({ advertise: () => Promise.reject(new Error("nope")) });
  assert.equal(await gate.request(), false);
});

test("#1095: a hello that did not reach the wire resolves false, not true", async () => {
  const { gate } = harness({ landed: false });
  assert.equal(await gate.request(), false);
});

test("#1095: no usable timer source ⇒ advertise NOW rather than park the hello forever", () => {
  // The one outcome this gate must never produce is a tab nothing can reach. If the bound
  // cannot be armed, degrade to today's behaviour (the race) instead of to a wedge.
  const sends = [];
  const gate = createRehelloGate({
    advertise: () => {
      sends.push(1);
      return Promise.resolve(true);
    },
    now: () => 0,
    setTimer: () => {
      throw new Error("no timers here");
    },
    clearTimer: () => {},
  });
  gate.began("ask_user");
  gate.request();
  assert.equal(sends.length, 1, "an unarmable bound must not become an unbounded wait");
});
