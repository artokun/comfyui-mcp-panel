// #1625 — an interactive card the user cannot see is the same failure as not
// painting at all.
//
// `ask_user` and `request_secret` are the only panel commands that BLOCK on a
// human. `panel_restart_comfyui`'s confirmation is one of them: the orchestrator
// waits up to 90s for a click, then reports "No confirmation received … the
// panel tab may be backgrounded or still reconnecting … the confirmation card
// wasn't answered." That wording is a guess. What the panel actually does is
// append the card to the chat log and call `scrollLog()`. Three independent
// ways that leaves the card unreachable, all of them the reported shape:
//
//   1. The Agent tab is not selected. Keep-alive detaches `.cmcp-root` rather
//      than destroying it, so the card is in a tree that is not on screen. The
//      What's New path already names this: "painting into a transcript the user
//      cannot see is the same failure as not painting at all."
//   2. The user has scrolled up. Discord-style stick-to-bottom leaves them
//      there and only shows a "New messages" pill. A destructive confirm is not
//      a message they can miss — the tool is blocked on the click.
//   3. The ComfyUI tab is backgrounded. `scrollLog()` defers to
//      `requestAnimationFrame`, which browsers pause in a hidden tab
//      (hidden-tab.spec.ts). A card appended below the fold stays there until
//      the tab is looked at, which is past the 90s budget.
//
// This helper does not paint and does not answer. Call it AFTER the card is in
// the log. It brings the Agent tab forward, forces stick-to-bottom, and scrolls
// NOW — not on an rAF tick a backgrounded tab will never fire. The retry covers
// the same "first activate lands before the tab store is ready" race Ask AI and
// What's New already wait out.
//
// WHAT THIS DOES NOT DO. A card that never arrived (the socket was down, the
// command landed on a superseded connection) cannot be revealed; #952 retires
// those, and the orchestrator re-asks. A click after the 90s cap is orchestrator
// recovery (panel#1554), not a panel-visibility problem.
//
// Dependency-free (no DOM, no sockets, no timers of its own). The callers inject
// `openTab` / `forceStick` / `scrollNow` / `schedule` so this is unit-testable
// with plain functions.

/** Retry delay matching Ask AI / What's New — the tab store can miss the first set. */
export const INTERACTIVE_CARD_REVEAL_RETRY_MS = 120;

/**
 * Make a just-painted interactive card reachable: Agent tab forward, stick to
 * the bottom, scroll synchronously.
 *
 * Each injected action is best-effort and isolated — a throw from `openTab`
 * must not skip the scroll; the card is already in the keep-alive tree.
 *
 * @param {{
 *   openTab?: () => void,
 *   forceStick?: () => void,
 *   scrollNow?: () => void,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   retryMs?: number,
 * }} [opts]
 */
export function revealInteractiveCard({
  openTab,
  forceStick,
  scrollNow,
  schedule,
  retryMs = INTERACTIVE_CARD_REVEAL_RETRY_MS,
} = {}) {
  try {
    forceStick?.();
  } catch {
    /* stick is cosmetic next to a card the user still cannot see */
  }
  try {
    openTab?.();
  } catch {
    /* the card still lives in the keep-alive root */
  }
  try {
    scrollNow?.();
  } catch {
    /* scroll is best-effort; the card is still in the tree */
  }
  if (!(retryMs > 0) || typeof schedule !== "function") return;
  schedule(() => {
    try {
      openTab?.();
    } catch {
      /* same as the first attempt */
    }
    try {
      scrollNow?.();
    } catch {
      /* same as the first attempt */
    }
  }, retryMs);
}
