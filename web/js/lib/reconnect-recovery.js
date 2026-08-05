// #663 / #646 — post-reconnect recovery: the proactive settle watch and the
// graph-mutation gate that rides on it.
//
// The panel's post-reconnect machinery used to be entirely PASSIVE on the canvas
// side: the `reconnected` handler bumped the epoch and armed the 30s possibly-
// stale window, but nothing ever RE-PROVED that the restored canvas is bound to
// the active workflow. Two defects shared that root:
//
//   #663 — the window (and with it the mid-population refusals) ran its full
//     30s even when the tab had finished restoring in two seconds, and a restore
//     that never settled hard-refused every graph command until a manual
//     panel_open_workflow / panel reload. Nothing proactive ever ran the binding
//     evidence bar.
//
//   #646 — nothing gated graph MUTATIONS on the post-restart state at all: a
//     mutation dispatched while ComfyUI's backend socket is down, or before the
//     restored canvas binding was re-proven, could land on a canvas the restore
//     was about to rebuild (a fabricated success) or die mid-command with the
//     socket (OUTCOME UNKNOWN).
//
// The shared invariant, implemented ONCE here: a graph mutation may only run
// when the post-reconnect binding has been re-proven — by the watch below, or
// by an explicit workflow_open/new, whose own receipts are stronger proof. The
// watch performs only SAFE heals (the ones a graph command performs lazily on
// every call): getGraphCtx's verified canvas rebind for a provably content-free
// ghost, and the binding guard's uuid-rebind / proven-binding seal. It
// deliberately NEVER repaints the canvas from serialized state — a live root
// whose content differs from the workflow's state can be holding user work
// (#604), and "could not determine whose canvas this is" must stay a refusal,
// not an automatic overwrite. A restore that never settles therefore still
// refuses after the window, with the remedy the refusal message names; what the
// watch buys is that the healthy case stops refusing as soon as the binding is
// observably settled instead of at the 30s wall.

/** Poll cadence for the settle watch (ms). */
export const RECONNECT_SETTLE_POLL_MS = 1000;
/** First poll delay (ms) — the restore needs a beat before it can pass. */
export const RECONNECT_SETTLE_FIRST_POLL_MS = 500;

/**
 * The post-reconnect settle watch. Polls until the caller's binding proof
 * passes, then stamps the proof via `markProven`. Stops early when the window
 * closed without it (an explicit open/new re-proved the tab, or the window
 * expired) and when a newer reconnect superseded it.
 *
 * Every dependency is injected, so the loop is unit-testable with fakes; the
 * panel wires the module-scope epoch state and the real evidence bar.
 *
 * @param {{
 *   isCurrent: () => boolean,    // false once a NEWER reconnect supersedes this watch
 *   windowOpen: () => boolean,   // the #433/#618 possibly-stale window, live
 *   proveBinding: () => boolean, // true when the binding clears the full read bar
 *   markProven: () => void,      // stamp the binding proof for this epoch
 *   sleep?: (ms: number) => Promise<void>,
 *   firstDelayMs?: number,
 *   pollMs?: number,
 *   maxPolls?: number,           // hard cap so the loop is bounded even if the
 *                                // window predicate never closes (fail-safe)
 * }} o
 * @returns {Promise<"proven"|"closed"|"superseded"|"exhausted">}
 */
export async function watchPostReconnectSettle({
  isCurrent,
  windowOpen,
  proveBinding,
  markProven,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  firstDelayMs = RECONNECT_SETTLE_FIRST_POLL_MS,
  pollMs = RECONNECT_SETTLE_POLL_MS,
  maxPolls = 45,
} = {}) {
  await sleep(firstDelayMs);
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (!isCurrent()) return "superseded";
    if (!windowOpen()) return "closed";
    let proven = false;
    try {
      proven = proveBinding() === true;
    } catch {
      // The proof is itself an operation that can fail — a throwing probe is
      // "not yet", never "proven".
      proven = false;
    }
    if (proven) {
      // Re-check currency BEFORE stamping: a reconnect that landed while the
      // proof ran must not let this older watch close the NEW window.
      if (!isCurrent()) return "superseded";
      markProven();
      return "proven";
    }
    await sleep(pollMs);
  }
  return "exhausted";
}

/**
 * The #646 graph-mutation gate: the refusal message for a mutating graph
 * command that arrives while the post-reconnect environment is known-unstable,
 * or null when the command may run. Two independent instability signals:
 *
 *   - backendDown: ComfyUI's own backend socket is between its "reconnecting"
 *     and "reconnected" events. A mutation dispatched in that gap lands on a
 *     canvas the incoming restore is about to rebuild — applied-then-wiped is
 *     the fabricated-success outcome this repo treats as the worst case.
 *   - bindingSettleWindow: a reconnect happened within the possibly-stale
 *     window and the canvas binding has NOT been re-proven for this epoch yet
 *     (the watch / an explicit open/new closes this). Reads stay available on
 *     their own evidence bars; only mutations are gated.
 *
 * Both refusals are retryable and state that nothing was applied — true
 * because the gate runs BEFORE the executor.
 */
export function graphMutationReconnectGate({ cmd, backendDown = false, bindingSettleWindow = false } = {}) {
  const name = typeof cmd === "string" && cmd ? `"${cmd}"` : "this graph command";
  if (backendDown) {
    return (
      `[backend-reconnecting] ComfyUI's backend connection is down right now (a restart or ` +
      `reconnect is in progress), so ${name} was NOT applied — nothing changed. A graph mutation ` +
      `dispatched in this window can land on a canvas the reconnect is about to rebuild. Retry ` +
      `once the tab has reconnected (usually seconds); if it never reconnects, reload the ComfyUI page.`
    );
  }
  if (bindingSettleWindow) {
    return (
      `[post-reconnect-settling] ComfyUI reconnected moments ago and the panel has not yet ` +
      `re-proven that the canvas is bound to the active workflow, so ${name} was NOT applied — ` +
      `nothing changed. The panel re-proves the binding automatically (usually within a few ` +
      `seconds); retry in a moment. If this persists past ~30 seconds, re-open the active ` +
      `workflow tab (panel_open_workflow) or reload the panel (panel_reload scope:frontend), then retry.`
    );
  }
  return null;
}
