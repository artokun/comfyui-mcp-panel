// #952 — withdrawing an interactive card must also END the command behind it.
//
// `ask_user` and `request_secret` are the only panel commands whose executor
// blocks on a HUMAN. When the connection that asked drops, the card is retired
// (its controls are disabled and it says why) but its promise was deliberately
// left unresolved: resolving it with an ANSWER would fabricate one, and the
// panel's rule is that a reply of this kind does not cross a reconnect.
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
// is fabricated — the reply says the question was withdrawn unanswered — and the
// reply is undeliverable on the socket that died, so it takes the existing
// lost-reply path exactly like any other late answer.
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
 * remedy names the current connection because a reply of this kind is never
 * replayed across a reconnect.
 */
export function abandonedInteractiveError(cmd) {
  const what = cmd === "request_secret" ? "secret request" : "question";
  return (
    `The ${what} was withdrawn: the connection it was asked on was replaced before anyone ` +
    `answered. NOTHING WAS ANSWERED and nothing was applied — the card on screen has been ` +
    `disabled, so a late answer to it cannot reach you either. Re-issue it on the current ` +
    `connection if you still need it.`
  );
}
