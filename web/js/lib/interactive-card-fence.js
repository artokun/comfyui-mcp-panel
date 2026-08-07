// Which conversation may an INTERACTIVE card be painted into?
//
// Found by the independent gate on PR #680 (that PR's own structural fix is a
// different, larger problem — see the note at the bottom).
//
// The panel renders exactly two cards on the agent's behalf that COLLECT
// something from the user and hand it back as a tool result:
//
//   * `request_secret` — a masked input whose value is an API token / secret.
//   * `ask_user`       — a question card whose value is whatever the user typed.
//
// Both used to paint UNCONDITIONALLY. Every other late-frame handler beside them
// is fenced — `onThinking` returns early when no turn is in flight, precisely so
// "a late thinking frame arriving AFTER a local interrupt must not resurrect the
// indicator the user just dismissed". These two skipped that, and they are the
// two where the consequence is not a stray indicator but a stray VALUE:
//
//   the user interrupts / starts a new chat / opens an older conversation, an
//   abandoned or superseded turn's `request_secret` arrives a moment later, the
//   panel paints a secure input into whatever conversation is now on screen, and
//   the token typed there is returned as the result of a turn belonging to a
//   DIFFERENT conversation. The secret lands somewhere the user did not choose.
//
// mcp #897 made agent sessions ORCHESTRATOR-scoped — one session across every
// panel, tab and workflow — so "which conversation is on screen" and "which turn
// this frame belongs to" are now genuinely separable, which is what makes the
// above reachable rather than theoretical.
//
// WHAT THE FENCE KEYS ON, and why the alternatives are not enough:
//
//   * `agentWorking` alone is a bare "some turn is in flight". It is exactly the
//     flag #381 already found insufficient for ATTRIBUTION, which is why
//     `liveTurnThreadId` exists. It is still HALF the answer, and the load-bearing
//     half for the reported shape: every path that abandons the visible
//     conversation (new chat, opening an older conversation, a workflow switch, a
//     backend switch, Disconnect, Esc-interrupt, cancelling a queued message)
//     routes through endTurnLocally(), which clears it.
//   * The shown conversation alone (`thread?.id` / CURRENT_THREAD_KEY) describes
//     only what is on screen and carries no frame provenance whatsoever, so on its
//     own it cannot tell "this turn owns the screen" from "this is a late frame
//     for something else" — the one distinction needed here.
//   * The rid / epoch on the dispatch path (commandRidLedger, commandEpoch) are
//     COMMAND identity and ORCHESTRATOR-SESSION identity: the rid dedupes one
//     command from another, and the epoch separates a restarted orchestrator from
//     its predecessor (#694). An abandoned turn and the live turn share both the
//     epoch and the socket, so neither discriminates between them. (The socket
//     half is already covered upstream by the superseded-socket `isActive()`
//     check.)
//   * The frame itself carries nothing usable: `request_secret` carries only
//     `label`/`hint`, and `ask_user` carries an `ask_id` that is a fresh random
//     UUID minted per call for correlation, not a conversation. A conversation id
//     ON THE FRAME is the fix this SHOULD have; it does not exist on the wire, and
//     adding it is a protocol change, not a panel change.
//
// So the fence is the PAIR: a turn must be in flight in this tab, AND the
// conversation that turn was captured under must be the conversation on screen.
//
// Dependency-free (no DOM, no sockets, no timers) so it is unit-testable with
// plain values.
//
// DELIBERATELY NOT ADDRESSED: PR #680's structural blocker — the panel publishes
// shared conversation state off `sendFrame()` returning `true`, which only proves
// the local socket accepted bytes, not that the orchestrator applied the
// transition. That needs orchestrator-confirmed session transitions, which do not
// exist yet. This fence is orthogonal: it uses only state the panel already owns
// locally and observes directly.

/** The two commands whose card COLLECTS a value from the user and returns it as
 *  the tool result. Deliberately the same pair as command-liveness.js's
 *  SENSITIVE_RESULT_CMDS — the reason both modules single these two out is the
 *  same reason: their result is the user's own input, not a description of a
 *  graph operation, so it must never travel anywhere it was not asked for. */
export const INTERACTIVE_CARD_CMDS = new Set(["request_secret", "ask_user"]);

/**
 * May an interactive card paint right now?
 *
 *  - `agentWorking`   — is a turn in flight in THIS tab (the panel's own flag).
 *  - `turnThreadId`   — the conversation captured as the live turn's owner at
 *                       turn start (`liveTurnThreadId`), or null.
 *  - `shownThreadId`  — the conversation currently on screen (`thread?.id`), or
 *                       null for the pre-first-message view.
 *
 * Returns `{ paint, reason }`; `reason` is null when painting.
 *
 * The null-owner case (`turnThreadId === null` while a turn is in flight) is
 * ALLOWED only against a screen that is also conversation-less, and that is not
 * leniency — it is the same equality, and the pairing is safe by construction:
 * a turn whose owner is null began on a view that had no conversation, so there
 * is no other conversation for it to leak into, and every way the user REACHES a
 * different existing conversation (loadThread / newChat / a workflow switch)
 * calls endTurnLocally() first, which fails the `agentWorking` check above. The
 * remaining way the screen changes mid-turn — detachInvalidCurrentThread(), a
 * sync from another tab replacing the active conversation — can only fire when
 * there WAS an active conversation, i.e. when the owner is not null, and that is
 * caught by the inequality.
 */
export function classifyInteractiveCard({ agentWorking, turnThreadId, shownThreadId } = {}) {
  if (!agentWorking) return { paint: false, reason: "no_live_turn" };
  const owner = turnThreadId ?? null;
  const shown = shownThreadId ?? null;
  if (owner !== shown) return { paint: false, reason: "other_conversation" };
  return { paint: true, reason: null };
}

/** What each refused card WOULD have been, for the agent-facing line. */
const CARD_NOUN = {
  request_secret: "the secure token input",
  ask_user: "the question card",
};

/** Why painting it into the conversation on screen would have been wrong. Same
 *  shape for both; the payload is what differs. */
const WHY_FENCED = {
  request_secret:
    "a secure input must never be painted into whatever conversation the tab happens to be " +
    "showing — the token typed there would come back as THIS turn's result, putting a secret in " +
    "a conversation the user never chose to put it in",
  ask_user:
    "an interactive card must never be painted into whatever conversation the tab happens to be " +
    "showing — the answer typed there would come back as THIS turn's result, in a conversation " +
    "the user never chose to answer in",
};

/** What we OBSERVED, never a guess (the house style from command-liveness.js). */
const CAUSE = {
  no_live_turn:
    "that ComfyUI tab has no turn in flight, so the turn this card belongs to has already ended " +
    "there — interrupted, or left behind by a new chat, an older conversation being reopened, a " +
    "workflow switch, a backend switch, or a disconnect",
  other_conversation:
    "the turn in flight in that ComfyUI tab belongs to a different conversation than the one on " +
    "screen — the visible conversation was replaced mid-turn",
};

/**
 * The error the AGENT receives for a refused card. It must be a clear failure:
 * not silence, not a fabricated success, and not a card painted somewhere else.
 * Tone matches command-liveness.js's redactSensitiveReply — say what happened,
 * say plainly that nothing was collected or stored, and give the ONE next step
 * that actually works.
 */
export function refusedInteractiveCardError(cmd, reason) {
  const noun = CARD_NOUN[cmd] ?? "the interactive card";
  const why = WHY_FENCED[cmd] ?? WHY_FENCED.ask_user;
  const cause = CAUSE[reason] ?? CAUSE.no_live_turn;
  return (
    `the panel did not show ${noun} for "${cmd}": ${cause}. Nothing was shown, nothing was ` +
    `collected and nothing was stored — ${why}. Retrying right now gets the same refusal; ask ` +
    `again after the user sends a message in the tab you want to ask in.`
  );
}
