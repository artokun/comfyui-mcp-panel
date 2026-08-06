/**
 * Periodic run-completion SAFETY SWEEP (panel#356 Bug 2).
 *
 * The panel's reconnect reconcile is EDGE-triggered only (ComfyUI `reconnected` /
 * bridge back). If the ComfyUI WS silently drops and reopens during an idle gap
 * between agent turns WITHOUT firing `reconnected` (background-tab throttling, a
 * socket the client library swaps on a visibility change), the terminal
 * `execution_success` is missed and NO edge fires — the run finishes, images paint
 * for the user, but the agent is never notified and stalls indefinitely.
 *
 * This is a self-disarming timer that re-runs the SAME /history reconcile WHILE any
 * run is still pending delivery (`hasPending()`), so such a completion is recovered
 * even with no reconnect edge. It:
 *   - runs at most ONE timer at a time (single-flight `arm`);
 *   - only re-arms while `hasPending()` stays true, so an idle panel keeps no timer;
 *   - is safe to `arm()` repeatedly (each queue kicks it — a redundant arm is a
 *     no-op);
 *   - stops cleanly on `dispose()` and, critically, will NOT re-arm even if
 *     `dispose()` lands WHILE an async reconcile is in flight (the `finally` re-arm
 *     is guarded by the disposed flag) — closing the unmount-resurrection leak.
 *
 * Pure of DOM / ComfyUI globals (timers + callbacks injected) so it is unit-tested
 * without a browser.
 *
 * @param {object} o
 * @param {() => boolean} o.hasPending   True while a completion is still undelivered.
 * @param {() => (Promise<any>|any)} o.reconcile  Runs one /history reconcile pass.
 * @param {(err:any) => void} [o.onSweepError] Reconcile failure sink (never rethrows).
 * @param {(fn:Function, ms:number) => any} [o.setTimer]
 * @param {(t:any) => void} [o.clearTimer]
 * @param {number} [o.intervalMs]        Sweep period (default 20000).
 */
export function createRunReconcileSweep({
  hasPending,
  reconcile,
  onSweepError = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  intervalMs = 20000,
} = {}) {
  if (typeof hasPending !== "function" || typeof reconcile !== "function") {
    throw new TypeError("createRunReconcileSweep requires hasPending + reconcile callbacks");
  }
  let timer = null;
  let disposed = false;

  function arm() {
    if (disposed) return; // torn down ⇒ never schedule
    if (timer != null) return; // one sweep armed at a time (single-flight)
    if (!hasPending()) return; // nothing to recover ⇒ no timer
    timer = setTimer(async () => {
      timer = null;
      // Re-check on fire: disposed, or the ledger drained meanwhile ⇒ disarm.
      if (disposed || !hasPending()) return;
      try {
        await reconcile();
      } catch (err) {
        onSweepError(err);
      } finally {
        // Re-arm ONLY while still mounted AND something is undelivered. The disposed
        // guard here is what stops an unmount that landed DURING the await from
        // resurrecting the sweep against a torn-down panel (codex P1).
        if (!disposed) arm();
      }
    }, intervalMs);
  }

  function dispose() {
    disposed = true;
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    arm,
    dispose,
    // Introspection for tests.
    _isDisposed: () => disposed,
    _hasTimer: () => timer != null,
  };
}
