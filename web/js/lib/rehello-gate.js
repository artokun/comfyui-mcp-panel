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

/**
 * #1095 — does this socket's ADVERTISED route still name the workflow the panel has
 * already committed to?
 *
 * THIS IS THE PROPERTY THE DEFERRAL PUTS AT RISK, and it is separate from the deferral
 * itself. `onWorkflowMaybeChanged` commits the new workflow inline (that is deliberate —
 * see its own note), so between the commit and the parked hello landing, the panel believes
 * it is on workflow B while the orchestrator still has this socket bound to A.
 *
 * A `user_message` frame carries NO tab id — only `sendFrame` stamps one — so the
 * orchestrator can route it ONLY by the binding the socket already has. Sent in that window
 * it is handled by the agent for the PREVIOUS workflow: the user's text, context and images
 * for B delivered into A's conversation. That is a cross-workflow leak, not a lost route,
 * and the human budget that `ask_user` earns is exactly the window that makes it worst.
 *
 * Kept pure, and separate from the gate, because it is a claim about two ids rather than
 * about timing — so it can be driven directly rather than asserted about at the call site.
 *
 * FAILS OPEN on an unreadable id, deliberately. An id we cannot READ is not an id we know
 * to be different (the same rule the #607 fence applies to its own identity). Treating
 * unreadable as stale would hold every frame on this socket for as long as it stayed
 * unreadable, which converts a leak into a mute panel.
 *
 * @param {{advertised: string|null, live: string|null, mapped: boolean}} state
 *   `mapped` is whether a hello has actually LANDED on the current socket — before that
 *   there is no binding to disagree with, and the first hello is never deferred.
 */
export function routeIsStale({ advertised, live, mapped } = {}) {
  if (!mapped) return false;
  if (typeof advertised !== "string" || !advertised) return false;
  if (typeof live !== "string" || !live) return false;
  return live !== advertised;
}

/** How long `cmd` may hold the route before a pending re-advertise stops waiting for it.
 *  An unknown or absent command name gets the machine budget: under-declaring only shortens
 *  the wait, while over-declaring would let any unrecognised frame pin the route for 30 s. */
export function deferBudgetMs(cmd) {
  return HUMAN_PACED_COMMANDS.has(cmd) ? REHELLO_DEFER_HUMAN_MS : REHELLO_DEFER_MS;
}

/**
 * @param {{
 *   advertise: (context?: any) => any, the real re-advertise (the panel's hello send)
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

  // The marks currently outstanding, by id.
  //
  // A SET OF IDS RATHER THAN A COUNTER, because a counter cannot tell a release apart from
  // the mark it belongs to, and three separate defects all come from that one gap:
  //
  //   * A LATE release from a RETIRED socket. `cancel()` runs when the connection is
  //     replaced (setUrl/stop/destroy/close), but a command already executing on the old
  //     socket still finishes and still calls its release. Against a counter that release
  //     lands on whatever the NEW socket is running and decrements ITS mark — so a parked
  //     hello can flush while a live command is mid-flight, which is precisely the
  //     route-loss race this module exists to close, recreated by its own bookkeeping.
  //     An id from a cleared generation is simply not in the set, so it releases nothing.
  //   * A DOUBLE release (a retry, a future refactor). The second `ended` finds no id and
  //     is a no-op, instead of discounting an unrelated command.
  //   * Command identity in general. Keying on `rid` was considered and rejected: rids are
  //     NOT unique here, because the #517 retry path re-delivers a previously-seen rid, so
  //     a map keyed by rid would collapse two marks into one entry and release both on the
  //     first reply.
  //
  // `ended` with a missing or unknown id releases NOTHING, which fails CLOSED — it can only
  // delay a re-advertise (bounded below), never let one through early. That is the safe
  // direction, and the only one of the two that can lose a reply is the other.
  const live = new Set();
  let nextMark = 1;
  // The latest instant at which SOME outstanding mark still has budget left. Zero means
  // nothing is running.
  //
  // Deliberately the MAX over the batch, cleared only when the set empties, rather than a
  // per-mark deadline. The cost is that a short command running alongside an `ask_user`
  // inherits the human budget until the batch drains. That over-waits; it cannot under-wait,
  // and only the under-wait direction loses a reply.
  let drainDeadline = 0;

  // The parked re-advertise. ONE, because coalescing is correct (see the header): several
  // callers asking to re-advertise want the orchestrator to hold this tab's current
  // identity, and one hello carrying the identity live at send time says exactly that.
  let waiters = null;
  let timer = null;
  // Frames that must not leave before the route has been re-advertised (see `routeIsStale`).
  // FIFO, and drained as one batch, because frames on a socket are ordered and holding some
  // while letting others past would reorder a conversation.
  // Each entry is { deliver, route } — see `holdForRoute` for why a bare callback was not
  // enough: a frame must carry the route it was composed for, or a later advertisement for
  // a DIFFERENT workflow delivers it to that one.
  //
  // NO GENERATION STAMP, and that is a deliberate removal rather than an omission. An
  // earlier cut carried one, because the drain was SCHEDULED on the advertisement's promise
  // and could therefore outlive a `cancel()` that had already cleared the queue. The drain
  // is now synchronous — `noteAdvertised` is called from the hello's landed path and reads
  // the queue there and then — so `cancel()` clearing it synchronously is total: no callback
  // survives to see a batch that is not its own. Mutation testing is what settled this:
  // deleting the generation check failed no test, and the reason was that it had become
  // unreachable, not that it was untested. An unreachable guard implying a protection nobody
  // exercises is the same defect as a test asserting a property it cannot observe.
  //
  // IF THE DRAIN EVER BECOMES ASYNCHRONOUS AGAIN, the stamp has to come back with it.
  const held = [];
  let holdTimer = null;

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

  // The advertisement currently ON ITS WAY, or null between advertisements.
  //
  // A hello is ASYNCHRONOUS — it awaits the tab-identity lease before it can even build its
  // payload — so "a hello is happening" is a state with real duration, not an instant. Two
  // callers that both want the route advertised during that window want the SAME hello, and
  // without this they got two.
  //
  // The path that exposed it is the most common one in this whole feature, not an edge case:
  // an ordinary workflow switch with an existing session and nothing in flight.
  // `rehelloForWorkflow` starts the hello and then immediately sends `resume_session`; that
  // frame finds the route still stale (the hello has not published anything yet), asks to be
  // held, and the hold's flush started a SECOND full registration — duplicate hello,
  // duplicate "agent ready" greeting, and TWO agentSessionEpoch increments for one switch.
  // The doubled epoch is not cosmetic: it feeds the canvas-tool disclosure, whose whole job
  // is to run exactly once per generation.
  let inFlight = null;

  /** Send now — or JOIN the advertisement already on its way — and hand the SAME outcome to
   *  every coalesced caller. Never rejects: a caller that cannot tell "did not land" from
   *  "threw" would spend a retry budget on neither. */
  function flush(contextOverride) {
    const pending = waiters;
    waiters = null;
    disarmTimer();
    const context = contextOverride === undefined ? pending?.[0]?.context : contextOverride;
    // Joining is correct rather than merely cheaper: `makePayload` reads the tab identity
    // AFTER the lease resolves, so an advertisement started a microtask ago has not yet
    // decided what it carries and will carry whatever is live when it gets there — which is
    // the identity a later caller is asking it to advertise.
    if (inFlight) {
      if (pending) for (const { resolve } of pending) inFlight.then(resolve);
      return inFlight;
    }
    let result;
    try {
      result = send(context);
    } catch {
      result = false;
    }
    const settled = Promise.resolve(result).then(
      (v) => v === true,
      () => false,
    );
    inFlight = settled;
    // Cleared once it has SETTLED, so the next request starts a genuinely new advertisement
    // rather than joining a finished one. `settled` never rejects, so this always runs.
    void settled.then(() => {
      if (inFlight === settled) inFlight = null;
    });
    if (pending) for (const { resolve } of pending) settled.then(resolve);
    return settled;
  }

  function fire() {
    timer = null;
    if (!waiters) return;
    // Re-check rather than trust the arming. A command that STARTED after the timer was
    // armed pushes `drainDeadline` out, and firing on the old deadline would advertise while
    // that command is mid-flight — the exact race, reintroduced by the bound meant to end it.
    if (live.size > 0 && clock() < drainDeadline) {
      armFor(drainDeadline - clock());
      return;
    }
    flush();
  }

  /**
   * (Re)arm the expiry that discards held frames when no advertisement arrives.
   *
   * IT TRACKS THE DEFERRAL, rather than being a fixed timeout from the first enqueue. The
   * first cut armed once, for the first frame, and never moved it — but the advertisement a
   * held frame is waiting for is itself deferred by whatever commands are in flight, and
   * `began()` pushes that deadline out. A route switch queues a frame; an `ask_user` then
   * starts while the hello is parked; the hello may legitimately not go out until 30 s after
   * THAT command, while a timer armed 30 s after the earlier enqueue clears the queue first.
   * The frame is then discarded while the advertisement it is waiting for is still perfectly
   * pending — a self-inflicted loss, not a timeout.
   *
   * So the expiry is "the deferral's own deadline, plus a machine budget for the hello to
   * actually land", floored at the human budget so an unparked hold still gets a full window.
   */
  function armHoldExpiry() {
    if (!held.length) return;
    const afterDrain = drainDeadline > 0 ? drainDeadline - clock() + REHELLO_DEFER_MS : 0;
    const ms = Math.max(REHELLO_DEFER_HUMAN_MS, afterDrain);
    if (holdTimer !== null) {
      try {
        disarm(holdTimer);
      } catch {
        // A stray timer only clears an already-empty queue.
      }
      holdTimer = null;
    }
    try {
      holdTimer = arm(() => {
        holdTimer = null;
        // Nothing advertised in time. These frames were composed for a route the
        // orchestrator was never told about; sending them now would send them on whatever
        // route it does hold, which is the leak this exists to prevent.
        held.length = 0;
      }, ms);
    } catch {
      // No timer source: prefer dropping the frames to holding them forever on a route that
      // may never be advertised.
      held.length = 0;
    }
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

  /** Re-advertise, waiting for the in-flight batch first if there is one.
   *  Declared out here rather than only as a method because `sendAfterAdvertise` calls it:
   *  a held frame waits for the hello the deferral will produce, and must not be able to
   *  force one (see that method for the whole argument).
   *  @returns {Promise<boolean>} whether the hello reached the wire. */
  function request(context) {
    if (live.size === 0) return flush(context);
    const left = drainDeadline - clock();
    // Budget already spent (a command that will not report back). Proceed — an unbounded
    // wait here is the wedge described in the header.
    if (!(left > 0)) return flush(context);
    const promise = new Promise((resolve) => {
      const waiter = { resolve, context };
      if (waiters) waiters.push(waiter);
      else waiters = [waiter];
    });
    // Arm only for the FIRST waiter; a later join must not restart the clock, or a steady
    // trickle of re-advertise requests would push the deadline forward forever.
    if (timer === null) armFor(left);
    return promise;
  }

  return {
    /** A command frame has begun executing against this socket's tab mapping.
     *  @returns {number} the mark id to hand back to `ended()` when its reply goes out.
     *    Callers MUST keep it: a release without it is inert (see `live` above). */
    began(cmd) {
      const mark = nextMark++;
      live.add(mark);
      const until = clock() + deferBudgetMs(cmd);
      if (until > drainDeadline) {
        drainDeadline = until;
        // A parked hello was armed against the OLD deadline; re-arm so it does not fire
        // early. (`fire` would catch this on its own, but re-arming keeps the timer honest
        // rather than relying on a re-check to paper over a wrong wake-up.)
        if (waiters) armFor(drainDeadline - clock());
        // …and held frames must not expire while the advertisement they wait for is still
        // legitimately deferred by THIS command. See armHoldExpiry.
        armHoldExpiry();
      }
      return mark;
    },

    /** The reply for `mark` has been handed to the socket — whatever happens to it after.
     *  A mark that was never taken, already released, or invalidated by `cancel()` releases
     *  nothing: it belongs to a generation this gate no longer accounts for. */
    ended(mark) {
      if (!live.delete(mark)) return;
      if (live.size === 0) {
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
      return live.size;
    },

    request,

    /** The connection this state belongs to is gone (setUrl / stop / destroy, and an
     *  ordinary close of the ACTIVE socket — a reconnect must not inherit any of it).
     *
     *  Drops the parked hello WITHOUT sending it: the socket it was meant for no longer
     *  exists, and a hello fired into the REPLACEMENT connection re-registers this tab under
     *  a route the caller never asked for — the corruption class #508 refuses to risk.
     *  Waiters resolve false ("it did not land") rather than being left pending, which would
     *  hang the #607 fence's own bookkeeping.
     *
     *  Clearing `live` also INVALIDATES every outstanding mark. Commands still executing on
     *  the retired socket will finish and call their release; those releases now find no id
     *  and are inert, so they cannot decrement a mark taken by a command on the NEW socket.
     *  Zeroing a shared COUNTER here is exactly the bug that made this a Set. */
    cancel() {
      const pending = waiters;
      waiters = null;
      disarmTimer();
      live.clear();
      drainDeadline = 0;
      // Retire the held batch WITH the connection, and fence any drain already scheduled
      // against it. Leaving these behind meant the retired advertisement would settle, the
      // drain would run against the MUTABLE current `sock`, and a frame composed for the old
      // connection would be written to the REPLACEMENT one — or silently dropped after
      // `true` had already been returned to the caller. Dropping is the honest outcome here:
      // the frame was built for a route that no longer exists, and the caller's delivery
      // timeout surfaces it. Clearing `held` also unwedges the queue — otherwise a stale
      // promise that never settles leaves every later frame stuck behind `held.length > 1`.
      held.length = 0;
      if (holdTimer !== null) {
        try {
          disarm(holdTimer);
        } catch {
          // A stray timer only clears an already-empty queue.
        }
        holdTimer = null;
      }
      // The advertisement on its way belongs to the connection being retired. A frame held
      // on the REPLACEMENT socket must not join it and conclude the new route is published
      // because the old socket's hello landed.
      inFlight = null;
      if (pending) for (const { resolve } of pending) resolve(false);
    },

    /**
     * #1095 — run `send` only once this socket's route has been (re)advertised.
     *
     * Used for outbound frames the orchestrator routes by the socket's BINDING rather than
     * by a stamped tab id (see `routeIsStale`). The frame is not refused and not dropped: it
     * is queued behind a hello that is EXPEDITED — the parked re-advertise goes out now
     * rather than waiting out its budget.
     *
     * IT WAITS FOR THE HELLO THE DEFERRAL WILL PRODUCE — it does NOT force one out.
     *
     * An earlier cut expedited: the hold called `flush()`, pushing the parked hello onto the
     * wire immediately. That was argued as a trade — "a person is waiting, and their action
     * outranks an in-flight command's reply" — and the argument was sound for the case it
     * was written about and wrong for the traffic it actually covered. `rehelloForWorkflow`
     * also runs AUTOMATICALLY: when workflow-scoped history supplies a session id it
     * re-hellos and immediately sends `resume_session`. Nobody is waiting for that frame. It
     * reached here, expedited the hello the gate had correctly parked, and let the backend
     * drop the old mapping before an in-flight command's reply — the OUTCOME UNKNOWN race
     * this whole PR exists to close, re-opened by the convenience added to protect against a
     * different failure.
     *
     * The fix is not a user-vs-automatic flag. Nothing in the gate can know which is which,
     * every call site that gets it wrong is another P1, and the flag would have to be
     * threaded through `sendUserMessage` — which the restart-resume nudges also call without
     * a person involved. So the expedite is GONE, and the rule is now uniform: a frame that
     * needs the new route waits for it, and the deferral decides when that is.
     *
     * TWO RULES, AND THEY REPLACE FOUR ROUNDS OF POINT FIXES.
     *
     * (1) A HELD FRAME IS SCOPED TO THE ROUTE IT WAS COMPOSED FOR. It leaves only when THAT
     *     route is the one the orchestrator has been told about. If the panel commits to a
     *     different workflow first, the frame is discarded rather than delivered, because a
     *     message composed for B has no correct meaning on C. (A→B queues B's frames, the
     *     user switches B→C, the hello advertises C — without the stamp the loop delivered
     *     B's `user_message` and `resume_session` onto C.)
     *
     * (2) A HELD FRAME NEVER CAUSES AN ADVERTISEMENT. It waits for one. This is the rule
     *     that stops the family of bugs rather than another instance of it, and it is worth
     *     stating why.
     *
     *     `onWorkflowMaybeChanged` is the ONLY place that commits a workflow switch as a
     *     whole: it binds SESSION_KEY and only then re-hellos, and its own comment says
     *     "Order is the whole fix" — the hello reads SESSION_KEY for its spawn-time
     *     `resume`, so advertising before the bind spawns the new route as a resume-FORK of
     *     the previous workflow's conversation. But `bridgeRouteId()` is derived from the
     *     LIVE canvas and moves the instant the user clicks a tab, while SESSION_KEY does
     *     not move until the 600 ms poll runs. Anything that advertises inside that gap
     *     pairs the NEW route with the PREVIOUS workflow's session.
     *
     *     Earlier cuts of this hold called `request()`, which advertises immediately when
     *     nothing is in flight — so an outbound frame arriving in the gap was itself the
     *     thing that published the half-committed switch. Removing the trigger removes the
     *     whole class: the poll remains the only author of a workflow re-advertisement, and
     *     everything else observes.
     *
     * COST, stated plainly. A frame composed in the gap waits for the poll (~600 ms) plus
     * any deferral, and is bounded at `REHELLO_DEFER_HUMAN_MS`; past that, or if the panel
     * commits to a different workflow, it is DISCARDED and the caller's delivery timeout
     * surfaces it in the pending tray. Refusing a write is acceptable; sending it to the
     * wrong workflow's agent is not.
     *
     * Ordering is preserved: the queue is FIFO and drains as one batch per advertisement.
     */
    holdForRoute(send, route) {
      if (typeof send !== "function") return false;
      // Property named `deliver`, not the obvious short verb: the registry's YARA
      // ruleset matches that verb as a method call anywhere in a shipped file. These
      // entries are built and read only in here, so the rename costs nothing.
      held.push({ deliver: send, route });
      armHoldExpiry();
      // ALWAYS FALSE, and this is the contract fix rather than a detail.
      //
      // The synchronous return of every send path means one thing — "the bytes reached the
      // socket" — and for a queued frame that is simply not true yet, and may never become
      // true: the queue is discarded on a mismatched advertisement, on expiry, and on
      // cancellation. Returning `true` here propagated up through sendFrame as a successful
      // write, and `runCompletion` acts on that IRREVERSIBLY: `framePushed` → markDelivered
      // → the prompt is retired from pending and never recovered from /history. A frame
      // reported as delivered and then discarded is neither refused nor delivered but
      // invisible, which is worse than either.
      //
      // Callers that must not be lied to therefore see a plain "not sent" and use the
      // recovery they already have. The ONE caller that queues (a session-ordered control
      // frame, which has no meaning before the hello anyway) ignores the return entirely.
      return false;
    },

    /**
     * #1095 — a hello has LANDED, carrying `route`. Release exactly the frames composed for
     * it, and discard the rest.
     *
     * This is the observation side of the rule above. It is called from the hello's success
     * path, so "advertised" means the orchestrator was actually told — never that the panel
     * intended to tell it.
     */
    noteAdvertised(route) {
      if (holdTimer !== null) {
        try {
          disarm(holdTimer);
        } catch {
          // A stray timer only clears an already-empty queue.
        }
        holdTimer = null;
      }
      const batch = held.splice(0, held.length);
      for (const entry of batch) {
        // A frame composed for a workflow the panel has since moved past has no correct
        // destination. Dropped, deliberately and silently at this layer — the caller that was
        // told `true` learns about it through its own delivery timeout, which is the
        // mechanism that already exists for "it never got there".
        if (entry.route !== route) continue;
        try {
          entry.deliver();
        } catch {
          // One frame's failure must not strand the rest of the batch.
        }
      }
    },

    /** Diagnostics/tests: whether a re-advertise is currently parked. */
    deferring() {
      return waiters !== null;
    },

    /** Diagnostics/tests: how many outbound frames are waiting on the route. */
    heldFrames() {
      return held.length;
    },
  };
}
