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
  const switching = startedOn !== null && startedOn !== id;
  // Computed from `connectedBackend`, which none of the commits below touch — it is written
  // only at its declaration and by the `onModels` handshake. That is what makes deciding
  // this before committing anything equivalent to deciding it after.
  const prevBackend = startedOn || pickedBackend();

  if (switching) {
    // THE ONLY AWAIT BEFORE A COMMIT, and the non-switching path must never reach it: a
    // first connect and a re-pick of the live backend stay fully synchronous, so neither is
    // ever gated on the history store's health.
    if (!(await invalidate())) {
      // Nothing has been committed, so "nothing happened" is now TRUE. That matters: an
      // earlier attempt at disclosure here was withdrawn on the grounds that telling the
      // user the switch was paused was a lie while the panel was already half-switched.
      // Ordering the invalidate first is what makes the honest message available.
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
  if (id !== prevBackend) seedPrefs(id);
  commitSelection(id);

  if (switching) {
    // Switching providers abandons the old agent session — not portable across backends.
    // End the turn locally so the working indicator does not outlive the session being
    // dropped, then replay the visible transcript to the NEW provider as one-shot context.
    endTurn();
    const replay = buildReplay();
    if (replay) armContext(replay);
  }

  teardownAndConnect(id);
  return { switched: switching, reason: switching ? BACKEND_SWITCH.SWITCHED : BACKEND_SWITCH.CONNECTED };
}
