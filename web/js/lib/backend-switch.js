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

/** What a switch did, for the caller's disclosure and for tests. */
export const BACKEND_SWITCH = Object.freeze({
  SWITCHED: "switched",
  /** Not a switch at all: a first connect, or a re-pick of the live backend. */
  CONNECTED: "connected",
  /** The old provider's session could not be durably invalidated; nothing was committed. */
  INVALIDATE_FAILED: "invalidate_failed",
  /** A handshake changed the live backend while we were awaiting the invalidate. */
  SUPERSEDED: "superseded",
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
 *   invalidate: () => Promise<boolean>,
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

  if (switching) {
    // THE ONLY AWAIT BEFORE A COMMIT, and the non-switching path must never reach it: a
    // first connect and a re-pick of the live backend stay fully synchronous, so neither is
    // ever gated on the history store's health.
    const invalidated = await invalidate();

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
    // RE-READ, because awaiting opened a window this function did not have before. A
    // handshake landing during the invalidate writes `connectedBackend` (and the chips, and
    // localStorage) underneath us. Under the old order those writes overwrote our commits;
    // under this one ours would land last and silently win against a backend the user did
    // not pick from the state we decided on.
    if (liveBackend() !== startedOn) {
      disclose(BACKEND_SWITCH.SUPERSEDED);
      return { switched: false, reason: BACKEND_SWITCH.SUPERSEDED };
    }
  }

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

  if (switching) {
    // The turn was already ended above, as soon as the invalidate had run — see the note
    // there. Only the replay belongs here: it is the one step that must NOT happen on an
    // abort, because arming context against a provider we are not switching to is what
    // shipped the whole prior transcript back to the backend that already had it.
    const replay = buildReplay();
    if (replay) armContext(replay);
  }

  teardownAndConnect(id);
  return { switched: switching, reason: switching ? BACKEND_SWITCH.SWITCHED : BACKEND_SWITCH.CONNECTED };
}
