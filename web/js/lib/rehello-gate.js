// #1095 — hold a RE-ADVERTISE until the commands it would strand have reported back.
//
// ## The defect
//
// A hello re-advertises this browser tab, and the backend DROPS the socket's prior tab
// mapping when it does. That is deliberate and correct — it is what stops a background
// workflow's output leaking into the tab the user is looking at (see rehelloForWorkflow's
// own note in the panel). The defect is *when* it fires.
//
// A workflow change is detected by a 600 ms poll that knows nothing about whether a graph
// command is currently executing. `panel_new_workflow` changes the tab's identity to a
// fresh `tmp:<uuid>`, the next poll tick re-hellos, and the orchestrator drops the mapping
// the in-flight `graph_set_widget` is routed to:
//
//     panel tab tmp:2806 disconnected mid-command (graph_set_widget) — OUTCOME UNKNOWN
//     then: no connected tab ... Connected: none
//
// The command really did apply ("the new nodes had already been added"), so the outcome is
// UNKNOWN rather than failed — which is the correct report for a lost route, and exactly
// why the route must not be lost.
//
// ## Why this is a MECHANISM, not a check at one caller
//
// The first cut of this fix gated `onWorkflowMaybeChanged` — the poll. Review rejected it,
// and the lead finding was that it could make the reported scenario MORE likely:
//
//   * `rehelloForWorkflow` is not the only thing that re-advertises. The #607/#570
//     workflow-instance fence calls `noteWorkflowInstanceMismatch()`, which fires a full
//     `sendHello()` from inside the command branch — the same re-advertise, dropping the
//     same mapping, while a command is running. So does the #310 free_vram re-advertise and
//     the #508 self-heal re-registration.
//   * And the interaction ran the wrong way. Deferring the POLL's re-hello keeps the
//     orchestrator's cached `workflow_uuid` stale for LONGER, which makes the fence more
//     likely to trip, which fires the ungated re-hello mid-batch — reproducing the issue's
//     own symptom through a path the "fix" had made more reachable.
//
// A guard at one caller cannot be completed by patching the other callers, because the next
// caller added would be ungated again. It belongs where every caller already passes: the
// re-advertise itself. That is this module.
//
// ## What a caller sees
//
// Nothing changes for a caller except WHEN the frame reaches the wire. `request()` returns
// the same promise-of-"did it land" that an immediate advertise returns, so:
//
//   * `onWorkflowMaybeChanged` commits `currentWorkflowId`, the storage key, the workflow
//     ref and `ssSet(SESSION_KEY, …)` INLINE and unconditionally. The first cut returned
//     before that commit, which meant the chat-scope hook (`panelHooks.applyChatScope`)
//     announced a re-bind that had not happened and left the panel internally inconsistent
//     until a later tick repaired it. Deferring only the wire send cannot do that.
//   * the #607 fence still gets a truthful `landed` boolean for its per-identity budget,
//     one drain later.
//
// ## The bound, and why it is not a tick count
//
// An UNBOUNDED wait would convert a race into a wedge, which is worse: a command whose reply
// never arrives would strand the tab on the old workflow's route permanently, and the fence
// recovery that would clear it is itself a re-advertise waiting behind the same gate.
//
// The first cut bounded it at five poll ticks (~3 s). Review rejected that too, because one
// class of command is HUMAN-paced: `ask_user` and `request_secret` hold the window for as
// long as the person takes to answer. Those are precisely the commands most likely to still
// be running across a workflow change, and a 3 s bound means the panel stalls for three
// seconds and then withdraws the route anyway — the user answers a question and the
// orchestrator reports OUTCOME UNKNOWN for the answer they just gave.
//
// So the bound is a WALL-CLOCK deadline contributed by the commands themselves: each command
// declares, when it starts, how long it may legitimately hold the route. Two classes, because
// there are two clocks — a machine one and a person one.
//
// MEASURED ON A MONOTONIC CLOCK. `now` defaults to `performance.now()`, never `Date.now()`:
// a wall clock can step backwards (NTP, a laptop waking, a manual change) and an elapsed-time
// window built on it either expires instantly or never. This file follows `monotonicNow()`
// in the panel and the same rule in `session-rebind.js` / `reconnect-staleness.js`.
//
// ## What this deliberately does NOT do
//
// It does not bound a `graph_run` that runs for minutes. Such a command gets the machine
// budget and then loses its route exactly as it does today — no regression, but no cover
// either. Extending the deadline to cover it would mean holding a stale route for the length
// of an arbitrary render, during which every mutation aimed at the NEW canvas is fence-refused;
// a clean, retryable "nothing was applied" refusal for a few seconds is a good trade, and for
// minutes it is not.
//
// It also does not cancel or reorder anything. A deferred re-advertise is still exactly one
// hello carrying whatever identity is live WHEN IT GOES OUT, which is the identity the
// orchestrator should have. That is why several deferred requests coalesce into one send
// rather than queueing: a hello is a statement of current state, not an event log.

/** Commands whose in-flight window is paced by a PERSON, not by the machine. Their reply is
 *  the user's own answer; losing its route means the panel collected an answer the caller
 *  will never receive, which is the worst outcome available here. */
export const HUMAN_PACED_COMMANDS = new Set(["ask_user", "request_secret"]);

/** Machine-paced budget. A graph mutation completes in milliseconds, so this is generous by
 *  three orders of magnitude while staying far below the point at which a stale route starts
 *  costing more than it saves. */
export const REHELLO_DEFER_MS = 4000;

/** Human-paced budget. Long enough for a person to read a question and answer it; short
 *  enough that an abandoned card cannot hold the tab on a dead workflow indefinitely. Past
 *  it, a LIVE route is worth more than one preserved outcome — the caller is told the outcome
 *  is unknown, which is true, rather than being left with a tab nothing can reach. */
export const REHELLO_DEFER_HUMAN_MS = 30000;

/** How long `cmd` may hold the route before a pending re-advertise stops waiting for it.
 *  An unknown or absent command name gets the machine budget: under-declaring only shortens
 *  the wait, while over-declaring would let any unrecognised frame pin the route for 30 s. */
export function deferBudgetMs(cmd) {
  return HUMAN_PACED_COMMANDS.has(cmd) ? REHELLO_DEFER_HUMAN_MS : REHELLO_DEFER_MS;
}

/**
 * @param {{
 *   advertise: () => any,          the real re-advertise (the panel's hello send)
 *   now?: () => number,            MONOTONIC clock; defaults to performance.now()
 *   setTimer?: Function,
 *   clearTimer?: Function,
 * }} deps
 */
export function createRehelloGate({ advertise, now, setTimer, clearTimer } = {}) {
  const clock =
    typeof now === "function"
      ? now
      : typeof performance !== "undefined" && typeof performance.now === "function"
        ? () => performance.now()
        : () => Date.now();
  const arm = typeof setTimer === "function" ? setTimer : (fn, ms) => setTimeout(fn, ms);
  const disarm = typeof clearTimer === "function" ? clearTimer : (t) => clearTimeout(t);
  const send = typeof advertise === "function" ? advertise : () => Promise.resolve(false);

  let inFlight = 0;
  // The latest instant at which SOME in-flight command still has budget left. Zero means
  // nothing is running.
  //
  // Deliberately the MAX over the batch, cleared only when the count reaches zero, rather
  // than a per-command deadline. A per-command deadline needs per-command identity, and rids
  // are NOT unique here: the #517 retry path re-delivers a previously-seen rid, so a map
  // keyed by rid would collapse two marks into one entry and release both on the first
  // reply — an unpaired release, which reopens the very race this exists to close. The cost
  // of the max is that a short command running alongside an `ask_user` inherits the human
  // budget until the batch drains. That over-waits; it cannot under-wait, and only the
  // under-wait direction loses a reply.
  let drainDeadline = 0;

  // The parked re-advertise. ONE, because coalescing is correct (see the header): several
  // callers asking to re-advertise want the orchestrator to hold this tab's current
  // identity, and one hello carrying the identity live at send time says exactly that.
  let waiters = null;
  let timer = null;

  function disarmTimer() {
    if (timer === null) return;
    try {
      disarm(timer);
    } catch {
      // A leaked timer is a leak; a throw here would strand the pending hello, which is a
      // wedge. `fire` re-checks its own precondition, so a stray timer is inert anyway.
    }
    timer = null;
  }

  /** Send now, and hand the SAME outcome to every coalesced caller. Never rejects: a caller
   *  that cannot tell "did not land" from "threw" would spend a retry budget on neither. */
  function flush() {
    const pending = waiters;
    waiters = null;
    disarmTimer();
    let result;
    try {
      result = send();
    } catch {
      result = false;
    }
    const settled = Promise.resolve(result).then(
      (v) => v === true,
      () => false,
    );
    if (pending) for (const resolve of pending) settled.then(resolve);
    return settled;
  }

  function fire() {
    timer = null;
    if (!waiters) return;
    // Re-check rather than trust the arming. A command that STARTED after the timer was
    // armed pushes `drainDeadline` out, and firing on the old deadline would advertise while
    // that command is mid-flight — the exact race, reintroduced by the bound meant to end it.
    if (inFlight > 0 && clock() < drainDeadline) {
      armFor(drainDeadline - clock());
      return;
    }
    flush();
  }

  function armFor(ms) {
    disarmTimer();
    try {
      timer = arm(fire, Math.max(0, ms));
    } catch {
      // No timer source. Rather than leave the hello parked forever — which is the one
      // outcome this gate must never produce — advertise immediately and accept the race we
      // were trying to avoid. Degrading to today's behaviour beats a tab nothing can reach.
      flush();
    }
  }

  return {
    /** A command frame has begun executing against this socket's tab mapping. */
    began(cmd) {
      inFlight++;
      const until = clock() + deferBudgetMs(cmd);
      if (until > drainDeadline) {
        drainDeadline = until;
        // A parked hello was armed against the OLD deadline; re-arm so it does not fire
        // early. (`fire` would catch this on its own, but re-arming keeps the timer honest
        // rather than relying on a re-check to paper over a wrong wake-up.)
        if (waiters) armFor(drainDeadline - clock());
      }
    },

    /** Its reply has been handed to the socket — whatever happens to it after. */
    ended() {
      if (inFlight > 0) inFlight--;
      if (inFlight === 0) {
        drainDeadline = 0;
        // The batch drained, which is the event the parked hello was waiting for. Send it
        // NOW rather than waiting out the remaining budget: the budget is a CEILING on the
        // wait, not a delay to serve.
        if (waiters) flush();
      }
    },

    /** How many command frames are executing. Read-only: only the command path may move it,
     *  and a caller that could reset it could manufacture the race this closes. */
    inFlight() {
      return inFlight;
    },

    /** Re-advertise, waiting for the in-flight batch first if there is one.
     *  @returns {Promise<boolean>} whether the hello reached the wire. */
    request() {
      if (inFlight === 0) return flush();
      const left = drainDeadline - clock();
      // Budget already spent (a command that will not report back). Proceed — an unbounded
      // wait here is the wedge described in the header.
      if (!(left > 0)) return flush();
      const promise = new Promise((resolve) => {
        if (waiters) waiters.push(resolve);
        else waiters = [resolve];
      });
      // Arm only for the FIRST waiter; a later join must not restart the clock, or a steady
      // trickle of re-advertise requests would push the deadline forward forever.
      if (timer === null) armFor(left);
      return promise;
    },

    /** Torn down (stop/destroy/setUrl). Drop the parked hello WITHOUT sending it: the socket
     *  it was meant for is gone, and a hello fired into a replaced connection re-registers a
     *  tab under a route the caller never asked for. Waiters are resolved false — "it did not
     *  land" — because leaving them pending would hang the fence's own bookkeeping. */
    cancel() {
      const pending = waiters;
      waiters = null;
      disarmTimer();
      inFlight = 0;
      drainDeadline = 0;
      if (pending) for (const resolve of pending) resolve(false);
    },

    /** Diagnostics/tests: whether a re-advertise is currently parked. */
    deferring() {
      return waiters !== null;
    },
  };
}
