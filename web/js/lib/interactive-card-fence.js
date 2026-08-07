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
// conversation that turn was captured under must be the conversation on screen
// (with one carefully-bounded case for a turn that began before this view had a
// conversation at all — see classifyInteractiveCard below).
//
// WHAT THIS DOES NOT REACH (my own adversarial gate, round 1 — recorded here so
// the next reader does not have to rediscover it). Both residuals have the SAME
// single root cause: the `turn` frame carries a STATE ("working"/"done") and no
// turn identity, so `agentWorking` / `liveTurnThreadId` are the panel's best
// available proxy for "which turn", not the thing itself.
//
//   * A straggler `turn:working` belonging to an already-ended turn, arriving
//     more than STALE_WORKING_GUARD_MS after the local end, is indistinguishable
//     from a fresh turn's. onTurn accepts it and captures the conversation THEN
//     on screen as its owner — after which that turn's card passes this fence.
//     Narrower than the defect being fixed (which needed nothing at all), but
//     not zero.
//   * The mirror image: a genuinely fresh turn whose `turn:working` lands INSIDE
//     the guard window is discarded, so `agentWorking` stays false and a
//     legitimate card is refused. Reachable when the orchestrator releases a
//     queued message immediately after an interrupt. The cost is bounded — the
//     agent gets an explicit, honest failure (below) rather than a card in the
//     wrong place — which is the direction this must fail in.
//
// Closing either one means putting a turn/conversation id ON THE WIRE and having
// the fence compare against THAT. It is a protocol change in comfyui-mcp, not a
// panel change, and it subsumes both. It is deliberately not attempted here.
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
 *  - `mintedThreadId` — the conversation record() MINTED since this turn started
 *                      (`lastMintedThreadId`), or null if it has minted none.
 *
 * Returns `{ paint, reason }`; `reason` is null when painting.
 *
 * THE NULL-OWNER CASE (`turnThreadId === null` while a turn is in flight) is the
 * subtlest part of this. My own gate got it wrong twice, so both wrong answers are
 * written down:
 *
 * `liveTurnThreadId` is captured in onTurn("working") as `thread?.id ?? null`, so
 * it is null for a turn that began on a view with no conversation yet. Such a turn
 * is not owner-less — it owns the conversation IT creates. record() mints that
 * conversation from the turn's own first message/output and does NOT retroactively
 * update liveTurnThreadId. So:
 *
 *   * Refusing whenever `owner !== shown` (round 2) false-refuses that legitimate
 *     card: the agent emits a progress `say`, which mints the conversation, then
 *     asks — in the conversation the user is looking at.
 *   * Painting whenever `owner === null` opens a hole the other way: loadThread()'s
 *     cross-workflow BLOCKED branch calls detachInvalidCurrentThread({rebind}) and
 *     returns WITHOUT endTurnLocally(), so a thread-less live turn can find a
 *     conversation on screen that it does not own.
 *   * "Created after the turn started" (round 3) is not enough either: a
 *     conversation created in ANOTHER TAB after this turn began can sync into this
 *     tab's history and be rebound onto the screen by that same detach path. It is
 *     newer than the turn and still not the turn's.
 *
 * The discriminator has to be provenance, not age: was this exact conversation
 * MINTED by record() during this turn? `lastMintedThreadId` answers that directly
 * — record()'s mint is its only writer and onTurn("working") resets it — so no
 * conversation that merely APPEARED on screen can satisfy it.
 */
export function classifyInteractiveCard({
  agentWorking,
  turnThreadId,
  shownThreadId,
  mintedThreadId,
} = {}) {
  if (!agentWorking) return { paint: false, reason: "no_live_turn" };
  const owner = turnThreadId ?? null;
  const shown = shownThreadId ?? null;
  if (owner === null) {
    // Nothing on screen either: the turn began on an empty view and it is still
    // empty. There is no other conversation for the card to land in.
    if (shown === null) return { paint: true, reason: null };
    const minted = mintedThreadId ?? null;
    if (minted !== null && shown === minted) return { paint: true, reason: null };
    return { paint: false, reason: "other_conversation" };
  }
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

/**
 * What we OBSERVED, never a guess (the house style from command-liveness.js).
 *
 * `no_live_turn` deliberately does NOT assert that the turn ended. That is the
 * usual cause but not the only one — a fresh turn's `turn:working` discarded by
 * onTurn's straggler guard produces the identical observation — and the panel
 * knows only what it saw. Stating the observation and offering the likely causes
 * as examples keeps it true in every case.
 */
const CAUSE = {
  no_live_turn:
    "that ComfyUI tab has no turn in flight, so nothing there owns this card. That is what the " +
    "panel OBSERVED, not a diagnosis — the usual cause is that the turn was ended in that tab " +
    "(an interrupt, a new chat, an older conversation reopened, a workflow or backend switch, a " +
    "disconnect), but a turn start the panel has not registered yet looks the same",
  other_conversation:
    "the turn in flight in that ComfyUI tab belongs to a different conversation than the one on " +
    "screen — the visible conversation was replaced mid-turn",
};

/**
 * The error the AGENT receives for a refused card. It must be a clear failure:
 * not silence, not a fabricated success, and not a card painted somewhere else.
 * Tone matches command-liveness.js's redactSensitiveReply — say what happened,
 * say plainly that nothing was collected or stored, and give a next step.
 *
 * The next step is deliberately "say what you need in plain text, and ask again
 * after the user's next message" rather than "retry". A tight retry loop is the
 * failure mode to avoid: it burns the turn against a refusal that will not
 * change until the user acts, and for the transient case (a turn start the panel
 * has not registered yet) plain text reaches the user anyway.
 */
export function refusedInteractiveCardError(cmd, reason) {
  const noun = CARD_NOUN[cmd] ?? "the interactive card";
  const why = WHY_FENCED[cmd] ?? WHY_FENCED.ask_user;
  const cause = CAUSE[reason] ?? CAUSE.no_live_turn;
  return (
    `the panel did not show ${noun} for "${cmd}": ${cause}. Nothing was shown, nothing was ` +
    `collected and nothing was stored — ${why}. Do not retry this in a loop: say in plain text ` +
    `what you need and why, and ask again after the user's next message in the tab you want to ` +
    `ask in.`
  );
}
