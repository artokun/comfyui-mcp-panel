// #1184 — the ORDER in which a backend switch commits.
//
// `connectBackend()` used to commit the new backend to memory, to localStorage and to the
// UI, and only then check whether the old provider's session could be durably invalidated.
// When that check failed it returned — leaving the panel persistently claiming a backend it
// had never connected to:
//
//   - `STORAGE_KEY_BACKEND` outlives the tab, and on reload the runtime pick WINS over the
//     saved Settings default, so the aborted choice is adopted permanently;
//   - the armed one-shot replay — the whole prior transcript under a "continued in a fresh
//     AI session" preamble — stays armed against the OLD provider's still-live session,
//     which already has that history. `client.stop()` does not clear it;
//   - prefs hold the new backend's model/effort while the old socket is live, which is the
//     stale cross-backend push the reseed exists to prevent;
//   - `endTurnLocally()` has already cleared the working indicator and MID_TASK_KEY for a
//     turn that may still be running on the old provider, and the `client.stop()` that
//     normally accompanies that never runs on this path.
//
// COMMIT LATER, DO NOT ROLL BACK. Rollback would have to restore six pieces of state, and
// `armContext` has no disarm affordance at all. Ordering the invalidate first leaves the
// failure path with nothing to undo, which is why this module is an ORDER rather than a
// repair.
//
// It is a module because the defect is an ordering property. Asserting order inside the
// 1.7MB panel IIFE is not possible, and an outcome-only test passes against the buggy order
// just as happily as against the fixed one.

// ---------------------------------------------------------------------------
// mcp#884 — THE HANDOVER.
//
// The order above was built when a provider switch ALWAYS meant a fresh session:
// destroy the outgoing session, replay the outgoing transcript into the incoming
// provider, done. mcp#884/#897 changed the premise — each backend now keeps its
// OWN durable conversation and its own orchestrator-keyed session — and the two
// halves disagreed:
//
//   - the invalidate cleared the OUTGOING THREAD's sessionId, so switching back
//     later sent `new_session` instead of resuming: the per-backend persistence
//     this PR exists to add, defeated by its own switch path;
//   - the replay armed the OUTGOING conversation's transcript before connecting,
//     so it could be replayed into the INCOMING backend's own existing thread.
//
// Both are consequences of ONE question the switch never asked: what does the
// incoming backend already have? `planBackendHandover` asks it once and derives
// both, so the two can no longer drift apart.
// ---------------------------------------------------------------------------

/** What the outgoing session and the armed replay must do on a handover.
 *
 *  `replay`:
 *   - "arm"   — the incoming backend has no conversation, so this really is a
 *               fresh chat and the outgoing transcript rides in as one-shot
 *               context (the long-standing, disclosed behaviour);
 *   - "clear" — the incoming backend HAS its own conversation, which `loadThread`
 *               will resume. The outgoing transcript must not ride into it, and
 *               anything already armed must be dropped rather than left to be
 *               consumed by the next message in the wrong conversation;
 *   - "leave" — not a switch; nothing to decide.
 *
 *  `preserveOutgoingSession`: the outgoing THREAD keeps its sessionId so the
 *  backend can be resumed when the user switches back. The TAB pointer is still
 *  cleared either way — that is the thing that must not leak across backends.
 */
export function planBackendHandover({ switching, incomingHasConversation } = {}) {
  if (!switching) return { preserveOutgoingSession: false, replay: "leave" };
  return {
    preserveOutgoingSession: true,
    replay: incomingHasConversation ? "clear" : "arm",
  };
}

/** What a switch did, for the caller's disclosure and for tests. */
export const BACKEND_SWITCH = Object.freeze({
  SWITCHED: "switched",
  /** Not a switch at all: a first connect, or a re-pick of the live backend. */
  CONNECTED: "connected",
  /** The old provider's session could not be durably invalidated; nothing was committed. */
  INVALIDATE_FAILED: "invalidate_failed",
});

/**
 * Run a backend switch in an order where nothing is committed until it is legal.
 *
 * Every effect is injected so the panel can pass closures over its real state and a test
 * can pass recorders. The panel keeps its own intra-block ordering inside `commitSelection`
 * — `renderBackendChips` highlights on `selectedBackend` and `connectAgent` POSTs it, so
 * those writes must stay together and must precede the connect.
 *
 * @param {string} id the backend being switched to
 * @param {{
 *   liveBackend: () => string|null,   // `connectedBackend`, READ LATE (see below)
 *   pickedBackend: () => string|null, // `selectedBackend`
 *   incomingHasConversation: (id: string) => boolean, // ask the STORE, not panel state
 *   invalidate: (opts: {preserveThreadSession: boolean}) => Promise<boolean>,
 *   seedPrefs: (id: string) => void,
 *   commitSelection: (id: string) => void,
 *   endTurn: () => void,
 *   buildReplay: () => string,
 *   armContext: (replay: string) => void,
 *   teardownAndConnect: (id: string) => void,
 *   disclose: (reason: string) => void,
 * }} effects
 * @returns {Promise<{switched: boolean, reason: string}>}
 */
export async function runBackendSwitch(id, effects) {
  const {
    liveBackend,
    pickedBackend,
    incomingHasConversation,
    invalidate,
    seedPrefs,
    commitSelection,
    endTurn,
    buildReplay,
    armContext,
    teardownAndConnect,
    disclose,
  } = effects;

  const startedOn = liveBackend();
  // Computed from `connectedBackend`, which none of the commits below touch — it is written
  // only at its declaration and by the `onModels` handshake. That is what makes deciding
  // this before committing anything equivalent to deciding it after.
  const switching = startedOn !== null && startedOn !== id;
  // Which backend is live once the await (if any) is done. Same as `startedOn` unless a
  // handshake landed underneath us.
  let landedOn = startedOn;

  // Asked BEFORE anything is committed, and answered from the store rather than from
  // panel state, so it is independent of `selectedBackend` moving underneath us.
  const handover = planBackendHandover({
    switching,
    incomingHasConversation: switching ? incomingHasConversation(id) === true : false,
  });

  if (switching) {
    // THE ONLY AWAIT BEFORE A COMMIT, and the non-switching path must never reach it: a
    // first connect and a re-pick of the live backend stay fully synchronous, so neither is
    // ever gated on the history store's health.
    //
    // `preserveThreadSession` (mcp#884): the outgoing THREAD keeps its sessionId. The old
    // unconditional clear was correct when a switch meant the session was gone; now the
    // orchestrator keys sessions per backend, so the outgoing backend's session outlives
    // this switch and its thread must keep pointing at it. The TAB pointer is still cleared.
    const invalidated = await invalidate({
      preserveThreadSession: handover.preserveOutgoingSession,
    });

    // THE INVALIDATE IS DESTRUCTIVE BEFORE IT REPORTS, and an earlier version of this file
    // claimed the opposite. `invalidateDurableAgentSession` clears the session key, nulls
    // `thread.sessionId` and persists — and only THEN consults `flush()` for the boolean it
    // returns. So "it failed, therefore nothing happened" was never true: by the time we
    // learn the answer the old session's resume pointer is already gone, whatever it says.
    //
    // That is why the turn is ended HERE rather than with the commits below. The old order
    // ended it before the invalidate, so a failure left the two consistent. Ending it only
    // on success left MID_TASK_KEY armed against a session pointer that no longer exists,
    // and the mid-task nudge would later fire into a brand-new empty session telling the
    // agent it "resumed with full context" — the exact false-reassurance class this repo
    // keeps fixing. A turn whose session id has been destroyed cannot resume, so it ends,
    // and both abort paths below inherit that.
    endTurn();

    if (!invalidated) {
      // Honest now in a narrower sense than the first draft of this comment claimed: no
      // BACKEND state has been committed, so the panel is still on the old provider and
      // "reconnect is paused" is true of the switch. It is not true of the session, which
      // is already invalid — see #1198 for the part this ordering cannot fix.
      disclose(BACKEND_SWITCH.INVALIDATE_FAILED);
      return { switched: false, reason: BACKEND_SWITCH.INVALIDATE_FAILED };
    }
    // RE-READ, because awaiting opened a window this function did not have before: a
    // handshake landing during the invalidate writes `connectedBackend` underneath us.
    //
    // PROCEED, DO NOT ABORT — the first version of this guard returned here, and that was
    // worse than the race it was guarding. By this point the session has already been
    // invalidated, so aborting left the user with a destroyed session, no connect, and their
    // explicit pick silently dropped. An explicit click must not lose to a handshake that
    // happened to land during it.
    //
    // What the re-read is actually FOR is `switching`, which was decided against a backend
    // that may no longer be live. If the handshake landed on the very backend being asked
    // for, this is no longer a switch: the replay must not be armed (the new provider
    // already has the conversation) and the turn was already ended above. Recomputing is
    // what keeps those two decisions honest; the commits below run either way.
    landedOn = liveBackend();
  }
  // `switching` governs only the REPLAY now — the turn ended above, and every commit below
  // is unconditional. False here means "the live backend is already the one asked for", so
  // arming a fresh-session preamble against it would replay the conversation to the provider
  // that is already holding it.
  const stillSwitching = switching && landedOn !== id;

  // From here everything commits, in the panel's original order.
  //
  // `pickedBackend()` is consulted ONLY when there is no live backend — and that is exactly
  // the path with no await, so nothing can move underneath it. Reading it before or after
  // the guard above is therefore unobservable, and it was briefly changed to a late read on
  // the theory that the `backends` auto-pick (which writes `selectedBackend` WITHOUT
  // `connectedBackend`, so it does slip past the supersede check) could stale it. It cannot:
  // when that writer can run, this expression has already resolved to `startedOn`.
  const prevBackend = startedOn || pickedBackend();
  if (id !== prevBackend) seedPrefs(id);
  commitSelection(id);

  if (stillSwitching) {
    // The turn was already ended above, as soon as the invalidate had run — see the note
    // there. Only the replay belongs here, and only when this is really still a switch:
    // arming a fresh-session preamble against a provider that already holds the
    // conversation is what shipped the whole transcript back to the backend that had it.
    if (handover.replay === "arm") {
      const replay = buildReplay();
      if (replay) armContext(replay);
    } else {
      // The incoming backend HAS its own conversation; `loadThread` will resume it and
      // arm its OWN replay if it needs one. Cleared rather than merely skipped: a context
      // armed earlier in this tab would otherwise be consumed by the next user message,
      // inside a conversation it does not belong to. `armContext(null)` is the clear —
      // the client stores only a non-empty string.
      armContext(null);
    }
  }

  teardownAndConnect(id);
  return { switched: stillSwitching, reason: stillSwitching ? BACKEND_SWITCH.SWITCHED : BACKEND_SWITCH.CONNECTED };
}
