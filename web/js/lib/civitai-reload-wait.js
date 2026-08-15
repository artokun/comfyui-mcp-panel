// Bounding the drive methods' wait on an in-flight CivitAI fetch
// (comfyui-mcp#1520).
//
// `driveGetResults` and `driveHighlight` await `state.activeReloadPromise` so
// they don't answer from a grid that hasn't filled yet (panel#793). The await is
// right; its lack of a bound is not. What it waits on is a third party, so the
// panel's reply deadline was effectively set by CivitAI: on a slow or 503-ing
// upstream the orchestrator's bridge timed out first and the caller got an error
// carrying no information, from a panel that was working perfectly.
//
// Lives in lib/ so the drive methods and the tests share ONE implementation.
// The previous version of this was inlined in cmcp-civitai-ui.js and mirrored
// into the test file, which tests a copy and lets the copy drift.

import { withTimeout } from "./bounded-step.js";

/**
 * How long a drive method waits on an in-flight fetch before answering anyway.
 *
 * The orchestrator bounds these two commands at BRIDGE_READ_DEFAULT_TIMEOUT_MS
 * (20 s). This budget has to finish far enough inside that for the reply to
 * still travel back, or the caller gets a bridge timeout instead of our honest
 * interim answer — which is the exact failure #1520 is about. 12 s leaves 8 s.
 *
 * Drift between the two degrades gracefully: a budget shorter than the bridge
 * bound just answers sooner, and one longer than it degrades to the old
 * behaviour (bridge timeout) rather than to anything new. Keep it well below.
 */
export const RELOAD_WAIT_BUDGET_MS = 12000;

/**
 * Await an in-flight reload, but never longer than `budgetMs`.
 *
 * @param {Promise<any>|null|undefined} reload  `state.activeReloadPromise`
 * @param {number} budgetMs
 * @param {{setTimer?:Function, clearTimer?:Function}} [timers] injectable for tests
 * @returns {Promise<boolean>} true if it settled (or none was in flight), false
 *   if the budget expired first. Never rejects.
 *
 * A REJECTED reload maps to `true`, and doing that BEFORE `withTimeout` sees it
 * is the whole subtlety. `withTimeout` routes a rejection to the same fallback
 * as a timeout — correct for a step that produced no result, wrong here. A
 * failed fetch DID settle: it is not still pending, and it reaches the caller as
 * `state.error`. Reporting it as pending would tell an agent to re-read and wait
 * for an answer that has already arrived.
 */
/**
 * Which answer `driveHighlight` owes its caller once the bounded wait returns.
 *
 * Both conditions can hold at once — the results generation changed while a slow
 * reload was still in flight — and the PRECEDENCE is load-bearing, because the
 * two answers ask the agent to do different things:
 *
 *   - `superseded`: a reload/tab/filter moved the grid on. The ids belong to the
 *     old search and can no longer match. Re-read results, then highlight again.
 *   - `pending`: the ids are still good, we just could not confirm them inside
 *     the budget. Ask again, unchanged.
 *   - `install`: current generation, reload settled — do the work.
 *
 * `superseded` wins. Reporting `pending` for a superseded request sends the
 * agent back with ids that cannot match, and buries a bail-out path that
 * predates the bound. This function exists so that precedence is testable rather
 * than a statement about line order inside a DOM-heavy module (#1520 review).
 *
 * @param {{revChanged: boolean, reloadSettled: boolean}} s
 * @returns {"superseded"|"pending"|"install"}
 */
export function classifyHighlightOutcome({ revChanged, reloadSettled }) {
  if (revChanged) return "superseded";
  if (!reloadSettled) return "pending";
  return "install";
}

export function awaitReloadWithin(reload, budgetMs, timers) {
  return withTimeout(
    Promise.resolve(reload).then(
      () => true,
      () => true,
    ),
    budgetMs,
    () => false,
    timers,
  );
}
