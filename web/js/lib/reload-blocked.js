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

/**
 * The open workflows whose unsaved edits will make the browser block a
 * programmatic navigation.
 *
 * panel#701 defect (2) — reproduced on the rig: with 3 unsaved workflows open,
 * `panel_reload({scope:"frontend"})` reported "soft reload (frontend) scheduled",
 * the orchestrator logged `panel tab disconnected`, and then nothing. The page
 * never navigated (the URL still lacked `cmcpReload`, the title still carried its
 * unsaved `*`) and stopped accepting script injection at all.
 *
 * `beforeunload` is why, and the ORDER is what makes it a wedge rather than a
 * no-op: the browser tears the socket down first and only then puts up the
 * "Leave site?" dialog. Nobody is at the keyboard to answer it during an
 * agent-commanded reload, so the tab is left with no navigation AND no bridge —
 * strictly worse off than before the command.
 *
 * We must NOT suppress the dialog. It is the only thing standing between an
 * agent-issued reload and someone's unsaved graph.
 *
 * So detect it instead, and don't start something that cannot finish.
 *
 * @param {Array<{isModified?: boolean, filename?: string, path?: string, key?: string}>} openWorkflows
 * @returns {string[]} human-readable labels of the blocking tabs
 */
export function unsavedReloadBlockers(openWorkflows) {
  if (!Array.isArray(openWorkflows)) return [];
  const out = [];
  for (const w of openWorkflows) {
    // Only a DEFINITE modification blocks. An absent/unknown flag is not
    // evidence of unsaved work, and refusing on it would make the reload
    // unusable on any build that does not expose the field.
    if (w?.isModified !== true) continue;
    const label =
      (typeof w.filename === "string" && w.filename) ||
      (typeof w.path === "string" && w.path) ||
      (typeof w.key === "string" && w.key) ||
      "an unsaved workflow";
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * What to say instead of navigating. Names the tabs, the mechanism, and the two
 * ways forward — a refusal without a route out is just a different dead end.
 *
 * @param {string[]} blockers
 */
export function reloadWouldBeBlockedMessage(blockers) {
  const list = blockers.join(", ");
  const many = blockers.length > 1;
  return (
    `Did NOT reload the panel: ${many ? "these workflows have" : "this workflow has"} unsaved ` +
    `changes — ${list}. The browser blocks a scripted navigation while unsaved work is open, ` +
    `and it drops this tab's bridge connection BEFORE showing the "Leave site?" dialog — so ` +
    `reloading now would leave the tab with neither a reload nor a connection, and no one at ` +
    `the keyboard to answer the prompt. Nothing was changed. Save or close ` +
    `${many ? "those tabs" : "that tab"} and ask again, or reload the tab yourself ` +
    `(Ctrl+Shift+R) and confirm the dialog.`
  );
}

/**
 * The refusal for a blocker state that could not be READ.
 *
 * Deliberately not reloadWouldBeBlockedMessage(): that one names the dirty
 * workflows, and naming none while claiming unsaved changes would be a claim
 * about something nobody observed. This says what actually happened.
 */
export function reloadBlockerUnreadableMessage() {
  return (
    `Did NOT reload the panel: could not read which workflows have unsaved changes, ` +
    `so whether reloading would discard work is UNKNOWN. A reload is not reversible, ` +
    `so this refuses rather than guess. Nothing was changed. Try again, or reload the ` +
    `tab yourself (Ctrl+Shift+R) once you have checked your open workflows.`
  );
}

/**
 * Run an agent-commanded frontend reload through every dirtiness fence.
 *
 * The command reply must not call a clean, pre-prime snapshot "scheduled": the
 * cache prime can yield to a user edit, and the final check can race one too.
 * Returning the refusal lets the command handler throw it through its normal
 * `{ok:false,error}` reply path while keeping navigation out of the refused path.
 *
 * @param {object} deps
 * @param {() => string[]} deps.getBlockers
 * @param {() => Promise<unknown>} deps.prime
 * @param {() => void} deps.clearSidebarReopen
 * @param {(message: string) => void} deps.appendSystem
 * @param {() => void} deps.armNotice
 * @param {() => void} deps.navigate
 * @returns {Promise<{ok: true}|{ok: false, stage: string, error: string}>}
 */
export async function runAgentFrontendReload({
  getBlockers,
  prime,
  clearSidebarReopen,
  appendSystem,
  armNotice,
  navigate,
} = {}) {
  // #1839 — an empty array is the CLEAN signal that permits navigation, so
  // returning [] on a throw made an unreadable blocker state mean "nothing is
  // dirty" and navigated: a destructive, irreversible action failing OPEN on the
  // exact check that exists to prevent it. The #1830 reporter was saved by this
  // refusal firing correctly, which is what makes the throw path worth closing.
  //
  // Unreadable is reported as its own outcome rather than folded into either
  // answer: "could not determine" is not "determined not" (#796).
  const blockersNow = () => {
    try {
      return { readable: true, blockers: typeof getBlockers === "function" ? getBlockers() : [] };
    } catch {
      return { readable: false, blockers: [] };
    }
  };
  const refuse = (stage, blockers, readable = true) => {
    const error = readable ? reloadWouldBeBlockedMessage(blockers) : reloadBlockerUnreadableMessage();
    try {
      clearSidebarReopen?.();
    } catch {}
    try {
      appendSystem?.(error);
    } catch {}
    return { ok: false, stage, error };
  };

  const initial = blockersNow();
  if (!initial.readable) return refuse("initial", [], false);
  if (initial.blockers.length) return refuse("initial", initial.blockers);

  try {
    await prime?.();
  } catch {
    // A failed or timed-out cache prime does not waive the dirtiness fences.
  }
  const postPrime = blockersNow();
  if (!postPrime.readable) return refuse("post-prime", [], false);
  if (postPrime.blockers.length) return refuse("post-prime", postPrime.blockers);

  const beforeNavigation = blockersNow();
  if (!beforeNavigation.readable) return refuse("pre-navigation", [], false);
  if (beforeNavigation.blockers.length) return refuse("pre-navigation", beforeNavigation.blockers);

  armNotice?.();
  navigate?.();
  return { ok: true };
}
