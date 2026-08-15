// #952 — withdrawing an interactive card must also END the command behind it.
//
// `ask_user` and `request_secret` are the only panel commands whose executor
// blocks on a HUMAN. Once a DIFFERENT socket reaches `connected`, cards painted
// on the superseded one are retired (their controls are disabled and they say
// why) but their promises were deliberately left unresolved: resolving one with
// an ANSWER would fabricate it, and the panel's rule is that a reply CARRYING an
// answer does not cross a reconnect.
//
// Note the trigger precisely (codex r4): a bare disconnect retires nothing. Until
// a replacement connection hands the UI a new socket id, the card stays live and
// its command stays pending — which is correct, since a socket that comes back is
// the same conversation. Everything below is about what happens once the sweep
// does run.
//
// Leaving it unresolved has its own cost, and that cost is what this module is
// for. The executor stays suspended on `await onAsk(...)` forever, so:
//
//   * `settleRid` never runs, and the rid ledger keeps an IN-FLIGHT entry. Those
//     are never evicted — by design, since dropping an unsettled command would
//     let its replay double-apply — so every abandoned question permanently
//     occupies a slot and holds the settled cap out of reach.
//
//   * a redelivery of that rid `await`s the in-flight promise, which can never
//     resolve. The panel then sends NOTHING: a second outcome-unknown for the
//     caller, this time with no timeout of the panel's own to end it.
//
// The fix is a value that is NOT an answer. Retiring a card resolves its promise
// with the sentinel below; the executor recognizes it and fails the command
// explicitly, which settles the ledger through the ordinary error path. Nothing
// is fabricated — the reply says the question was withdrawn unanswered.
//
// WHAT SETTLING BUYS — and what it does not. Measured against the orchestrator
// twice, because the first two answers here were both too generous (codex).
//
// It does NOT rescue the interrupted call. In the ordinary disconnect the caller
// never sees the text below:
//
//   * the old socket's close already removed the pending rid and rejected the call
//     with the bridge's own OUTCOME-UNKNOWN error, before anything from the panel
//     could arrive;
//
//   * the journal replay on the fresh socket then finds no pending rid. The
//     bridge's late-answer buffer for `ask_user` keeps `msg.ok` replies only, so a
//     payload-free FAILURE is dropped there; `request_secret` has no late route at
//     all.
//
// Nor is the ledger's replay branch a recovery path for these two commands. It
// needs the SAME rid (every dispatch mints a fresh UUID and overwrites a supplied
// one) or a `retry_of` naming it (injected only for RETRY_TOKEN_CMDS, which
// excludes both) — and re-asking mints a new `ask_id`, which is part of the
// fingerprint, so even a hand-written token would miss. Treat that branch as
// defensive: it answers a duplicate frame if one is ever delivered, instead of
// waiting forever on a promise that cannot resolve.
//
// What settling actually buys, stated exactly (codex r3 — the earlier "no future
// delivery of that rid can hang the handler" was one step too broad, and the
// tests below contain its own counterexample):
//
//   While the settled (epoch, rid, fingerprint) entry is RETAINED, a matching
//   duplicate replays its recorded failure instead of awaiting the abandoned
//   promise. Settling also makes the entry eligible for normal cap eviction.
//
// Not more than that. Eviction is deliberately fail-open, so a duplicate arriving
// after the entry ages out calls `begin()` and executes a fresh interactive
// command — which blocks on a human again, correctly. A same-rid frame with a
// DIFFERENT fingerprint is treated as new work for the same reason. Both are the
// ledger behaving as designed; neither is something this change removes.
//
// The reply is journaled by the existing lost-reply path like any other
// undelivered outcome. Unlike an ANSWER, it is safe to replay across a reconnect —
// it carries no user input — which is why `redactSensitiveReply` was narrowed to
// replies that actually carry one.
//
// A SYMBOL, not a string: the "Other…" field lets a user type any text they
// like, and a sentinel a human can type is a sentinel a human can forge. The
// global registry (`Symbol.for`) is used so the identity survives the module
// being evaluated twice — a duplicate instance would otherwise make the sentinel
// unrecognizable and silently restore the hang this exists to remove.
//
// Dependency-free (no DOM, no LiteGraph). Unit-testable with plain fixtures.

/** Resolution value meaning "this card was withdrawn; the user answered nothing". */
export const INTERACTIVE_ABANDONED = Symbol.for("comfyui-mcp.interactiveAbandoned");

/**
 * Identity check, deliberately strict. Anything else — including a string that
 * happens to read like the sentinel's description — is a real user answer.
 */
export function isAbandonedInteractive(value) {
  return value === INTERACTIVE_ABANDONED;
}

/**
 * The failure text for a withdrawn interactive command.
 *
 * States only what the mechanism establishes: the card is gone, nothing was
 * answered, and the answer cannot arrive later. It does NOT claim the user saw
 * the card, ignored it, or declined — the panel cannot know any of that. The
 * remedy names the current connection because the ANSWER to a withdrawn card is
 * never replayed across a reconnect, so re-asking is the only way to get one.
 *
 * Rarely read, and the header says why: the interrupted call has already been
 * failed by the bridge. This is the outcome the panel RECORDS, and what a
 * duplicate frame would be answered with — not a rescue for the original caller.
 */
export function abandonedInteractiveError(cmd) {
  const what = cmd === "request_secret" ? "secret request" : "question";
  return (
    `The ${what} was withdrawn: the connection it was asked on was replaced before anyone ` +
    `answered. NOTHING WAS ANSWERED and nothing was applied — and any card still on screen ` +
    `for it has been disabled, so a late answer given there cannot reach you either. ` +
    `Re-issue it on the current connection if you still need it.`
  );
}
