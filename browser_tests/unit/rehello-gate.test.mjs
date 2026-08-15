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
  routeIsStale,
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
  const mark = gate.began("graph_set_widget");
  const landed = gate.request();
  assert.deepEqual(sends, [], "the hello must not go out while the command is still routed");
  advance(1);
  assert.deepEqual(sends, [], "…and not on the next tick either");
  gate.ended(mark);
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
  const mark = gate.began("graph_set_widget");
  gate.request();
  advance(5);
  gate.ended(mark);
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
  const mark = gate.began("ask_user");
  const landed = gate.request();
  advance(REHELLO_DEFER_MS + 1);
  assert.deepEqual(sends, [], "the machine budget must not apply to a command paced by a person");
  gate.ended(mark);
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
  const first = gate.began("graph_set_widget"); // deadline t=4000
  gate.request();
  advance(3000);
  const second = gate.began("ask_user"); // deadline t=33000
  advance(1500); // t=4500 — past the ORIGINAL deadline
  assert.deepEqual(sends, [], "the wait must follow the newest command, not the first one");
  gate.ended(first);
  gate.ended(second);
  assert.equal(sends.length, 1);
});

test("#1095: an already-spent budget does not restart the wait", () => {
  const { gate, sends, advance } = harness();
  gate.began("graph_set_widget");
  advance(REHELLO_DEFER_MS + 1); // budget spent before anyone asked to re-advertise
  gate.request();
  assert.equal(sends.length, 1, "a stuck command must not buy a fresh budget per request");
});

// --- coalescing and mark identity ----------------------------------------

test("#1095: several deferred re-advertises coalesce into ONE hello, all told the same outcome", async () => {
  // A hello is a statement of current state, not an event log: two parked requests both want
  // the orchestrator to hold this tab's live identity, and one send says that.
  const { gate, sends } = harness();
  const mark = gate.began("graph_set_widget");
  const a = gate.request();
  const b = gate.request();
  const c = gate.request();
  gate.ended(mark);
  assert.equal(sends.length, 1, "one send, not a queue of three");
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
});

test("#1095: a DOUBLE release of one mark cannot discount another command", () => {
  // deliverReply releases the mark, and a double-delivery (a retry, a future refactor) must
  // not free work that is still running. A counter could not tell the two apart; an id can.
  const { gate, sends } = harness();
  const mine = gate.began("graph_set_widget");
  gate.began("graph_set_widget"); // a second, still-running command
  gate.request();
  gate.ended(mine);
  gate.ended(mine);
  gate.ended(mine);
  assert.equal(gate.inFlight(), 1, "the other command must still be marked");
  assert.deepEqual(sends, [], "…and the hello must still be parked behind it");
});

test("#1095: a release that does not NAME its mark frees nothing — it fails closed", () => {
  // The safe direction: an unnamed release can only DELAY a re-advertise (the budget still
  // expires), never let one through while a command is mid-flight.
  const { gate, sends } = harness();
  const mark = gate.began("graph_set_widget");
  gate.request();
  gate.ended();
  gate.ended(undefined);
  gate.ended(999999);
  assert.deepEqual(sends, [], "an unknown mark must not release a real one");
  gate.ended(mark);
  assert.equal(sends.length, 1);
});

test("#1095: a leaked mark delays the hello but can never block it", () => {
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

// --- generation scoping (codex P1) ---------------------------------------

test("#1095 codex P1: a LATE release from a retired connection must not free the new one's mark", () => {
  // cancel() runs when the connection is replaced (setUrl / stop / destroy / an ordinary
  // close). A command already executing on the RETIRED socket still finishes and still calls
  // its release. Against a shared counter that release lands on whatever the NEW socket is
  // running and decrements ITS mark — so a parked hello flushes while a live command is
  // mid-flight, recreating the exact route-loss race this module exists to close.
  const { gate, sends } = harness();
  const retired = gate.began("graph_set_widget"); // running on the old socket
  gate.cancel(); // the connection is replaced
  const current = gate.began("graph_set_widget"); // the new socket's command
  const landed = gate.request();
  assert.deepEqual(sends, [], "parked behind the NEW command");

  gate.ended(retired); // the old socket's command finally finishes
  assert.equal(gate.inFlight(), 1, "the retired mark is not accounted for, so nothing is freed");
  assert.deepEqual(sends, [], "a stale release must not withdraw the route from a live command");

  gate.ended(current);
  assert.equal(sends.length, 1, "only the real release lets the hello go");
  return landed;
});

test("#1095 codex P1: cancel() invalidates outstanding marks, so they cannot delay the next hello", () => {
  // The other direction of the same defect: marks belonging to a dead socket must not make
  // the replacement connection's legitimate re-advertise wait out a budget for commands that
  // can never reply.
  const { gate, sends } = harness();
  gate.began("ask_user");
  gate.began("graph_set_widget");
  gate.cancel();
  assert.equal(gate.inFlight(), 0, "a replaced connection carries none of its predecessor's marks");
  gate.request();
  assert.equal(sends.length, 1, "the new connection's hello is immediate");
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

// --- the outbound-frame leak (codex P1) ----------------------------------

test("#1095 codex P1: the advertised route is STALE once the committed workflow moves past it", () => {
  // onWorkflowMaybeChanged commits the new workflow inline while the hello is parked, so
  // for the length of the deferral the panel is on B and the orchestrator's binding says A.
  assert.equal(routeIsStale({ advertised: "tmp:A", live: "tmp:B", mapped: true }), true);
  assert.equal(routeIsStale({ advertised: "tmp:A", live: "tmp:A", mapped: true }), false);

  // Before a hello has LANDED on this socket there is no binding to disagree with, and the
  // first hello is never deferred — so nothing may be held on that account.
  assert.equal(routeIsStale({ advertised: "tmp:A", live: "tmp:B", mapped: false }), false);
  assert.equal(routeIsStale({ advertised: null, live: "tmp:B", mapped: true }), false);

  // FAILS OPEN on an unreadable id: an id we cannot read is not one we know to be
  // different (the #607 fence's own rule). Treating it as stale would hold every frame for
  // as long as it stayed unreadable, turning a leak into a mute panel.
  assert.equal(routeIsStale({ advertised: "tmp:A", live: null, mapped: true }), false);
  assert.equal(routeIsStale({ advertised: "tmp:A", live: "", mapped: true }), false);
  assert.equal(routeIsStale({}), false);
});

test("#1095 codex P1: a held frame does not leave before the re-advertise lands", async () => {
  // The leak: a user_message carries NO tab id, so the orchestrator routes it by the socket
  // binding. Sent during the deferral it reaches the PREVIOUS workflow's agent — the user's
  // text, context and images delivered into another canvas's conversation.
  const order = [];
  let resolveHello;
  const gate = createRehelloGate({
    advertise: () => {
      order.push("hello");
      return new Promise((r) => {
        resolveHello = r;
      });
    },
    now: () => 0,
  });
  gate.began("ask_user"); // a human-paced command is holding the route
  const accepted = gate.sendAfterAdvertise(() => order.push("user_message"));
  assert.equal(accepted, true, "the frame is accepted, not refused — it is queued, not dropped");
  assert.deepEqual(order, ["hello"], "the hello is EXPEDITED, and the frame has not gone out");
  assert.equal(gate.heldFrames(), 1);

  resolveHello(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, ["hello", "user_message"], "the frame follows the hello, never precedes it");
  assert.equal(gate.heldFrames(), 0);
});

test("#1095 codex P1: holding EXPEDITES the parked hello rather than waiting out the budget", () => {
  // The trade, stated: the user has done something that requires the new route, and their
  // action outranks an in-flight command's reply. A lost reply is OUTCOME UNKNOWN, which is
  // honest and recoverable; a message delivered to the previous workflow's agent is not.
  const { gate, sends } = harness();
  gate.began("ask_user"); // 30s budget — the worst case for the leak
  gate.request();
  assert.deepEqual(sends, [], "parked, as the #1095 fix intends");
  gate.sendAfterAdvertise(() => {});
  assert.equal(sends.length, 1, "a frame that needs the new route forces the hello out now");
});

test("#1095 codex P1: held frames keep their order and drain as one batch", async () => {
  const order = [];
  let resolveHello;
  const gate = createRehelloGate({
    advertise: () => new Promise((r) => { resolveHello = r; }),
    now: () => 0,
  });
  gate.began("graph_set_widget");
  for (const n of [1, 2, 3]) gate.sendAfterAdvertise(() => order.push(n));
  assert.equal(gate.heldFrames(), 3, "one queue, not one per frame");
  resolveHello(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, [1, 2, 3], "frames on one socket are ordered; the hold must not reorder them");
});

test("#1095 codex P1: a FAILED re-advertise still drains the hold — a mute panel is worse", async () => {
  const order = [];
  const gate = createRehelloGate({
    advertise: () => Promise.reject(new Error("hello failed")),
    now: () => 0,
  });
  gate.began("graph_set_widget");
  gate.sendAfterAdvertise(() => order.push("sent"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, ["sent"], "a frame held forever would be a panel that silently stops talking");
});

test("#1095 codex P1: one frame's failure does not strand the rest of the batch", async () => {
  const order = [];
  const gate = createRehelloGate({ advertise: () => Promise.resolve(true), now: () => 0 });
  gate.began("graph_set_widget");
  gate.sendAfterAdvertise(() => {
    throw new Error("this frame blew up");
  });
  gate.sendAfterAdvertise(() => order.push("second"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, ["second"]);
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
