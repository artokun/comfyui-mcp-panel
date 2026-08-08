/**
 * panel#701(2) — a commanded frontend reload that never happens must SAY SO.
 *
 * `softReload("…", "frontend")` ends in `window.location.replace(...)`, and a
 * ComfyUI tab with unsaved work has a `beforeunload` handler. The browser begins
 * the unload — enough to tear down the panel's WebSocket — and then blocks on a
 * confirmation dialog nobody answers, because the caller was an agent rather than
 * a person sitting at the tab.
 *
 * The end state, reproduced on released builds: the orchestrator logs
 * `panel tab disconnected`, the page never navigates (no `cmcpReload` param on the
 * URL), the socket does not come back, and the tool has already reported
 * "soft reload (frontend) scheduled". Nothing tells anyone a modal is waiting.
 *
 * THIS IS THE VERIFICATION HALF ONLY. Whether the tool should REFUSE outright when
 * workflows are modified is a product decision and is left alone. Noticing that a
 * navigation we requested did not occur, and saying so, cannot make anything worse
 * — the alternative is the current silence.
 *
 * WHY A TIMER IS SOUND HERE. If the navigation succeeds this code is destroyed
 * with the document and the callback never runs; that is the intended "no news"
 * path. Surviving the deadline is therefore positive evidence that the unload was
 * cancelled — not an inference, an observation. The one false-positive risk is a
 * navigation slower than the deadline, so the message says the reload "has not
 * happened yet" rather than declaring it failed, and re-checks before speaking.
 */

/** Generous enough that an ordinary reload is long gone (a same-origin document
 *  swap is tens of ms), short enough that a stranded user is told promptly. */
export const RELOAD_BLOCKED_AFTER_MS = 4000;

/**
 * Arm a check that runs only if the page is STILL ALIVE afterwards.
 *
 * @param {object} deps
 * @param {(msg: string) => void} deps.notify  where to surface the finding.
 * @param {() => boolean} [deps.stillHere]  re-checked at fire time; default true.
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {number} [deps.afterMs]
 * @returns {unknown} the timer handle, so a caller can cancel it.
 */
export function armReloadBlockedNotice({
  notify,
  stillHere = () => true,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  afterMs = RELOAD_BLOCKED_AFTER_MS,
} = {}) {
  if (typeof notify !== "function") return null;
  return setTimer(() => {
    // Re-check rather than assume: between arming and firing the document may
    // have gone, and speaking then would be a claim about a page that no longer
    // exists.
    if (!stillHere()) return;
    notify(reloadBlockedMessage());
  }, afterMs);
}

/**
 * Names the cause it can actually support, and the two ways out.
 *
 * It does NOT assert "you have unsaved work" — this code cannot see which handler
 * cancelled the unload, and a browser extension or another pack can register one
 * too. Unsaved work is by far the most likely and is named as such, not as fact.
 */
export function reloadBlockedMessage() {
  return (
    "The panel reload was requested but has NOT happened yet — this page is still running " +
    "the old code. A browser dialog is almost certainly waiting for a click: ComfyUI asks " +
    "for confirmation before leaving a tab with unsaved workflows, and that prompt blocks " +
    "the reload until someone answers it in the browser. Check the ComfyUI tab and confirm " +
    "the prompt, or save the modified workflows and try again. Note the panel's connection " +
    "may already have dropped while the browser was preparing to navigate, so the agent can " +
    "appear disconnected until the reload completes or is dismissed."
  );
}
