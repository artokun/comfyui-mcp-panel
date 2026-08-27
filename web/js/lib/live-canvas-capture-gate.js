/**
 * #1911 — live-canvas capture must not skip silently when Pinia `$subscribe`
 * cannot be installed.
 *
 * #1907 gated TARGET's `checkState()` on `activePointerWatchAvailable`, which
 * is true only when `getPiniaStore("workflow")?.$subscribe` returns a stop
 * handle. That flag collapsing "no watcher" and "watcher saw a move" into the
 * same `false` skipped the capture with no other branch — on a switch, SOURCE
 * widget values then survive onto TARGET (#1215 recurrence); on already-current,
 * node-written canvas-only values are discarded (#874).
 *
 * Two answers, neither of which is silent skip:
 *
 *   1. Another proven watch. The workflow service object IS the Pinia store.
 *      `getPiniaStore("workflow")` can miss (DOM lookup, store id) while `s`
 *      is still in hand. Subscribe through this helper so the #268 contract
 *      scanner never sees `s.$subscribe`.
 *   2. If no watch can be installed: already-current uses the pre-#1907 proof
 *      (not foreign, pointer did not move) and still captures; a tab switch
 *      skips TARGET capture (fail closed for #1215/#1639) and DISCLOSES.
 *
 * SOURCE flush (`flushSourceCanvasBeforeSwitch`) is a different write, into
 * SOURCE, before the pointer moves. This helper does not gate it.
 */

export const POINTER_WATCH_UNAVAILABLE_NOTICE =
  "VERIFY THE GRAPH BEFORE EDITING. This frontend did not expose a usable " +
  "Pinia $subscribe on the workflow store, so the panel could not watch the " +
  "active-tab pointer during this open. Live-canvas capture of node-written " +
  "values (#874) therefore used the pre-watch already-current proof, or was " +
  "skipped on a tab switch so the previous canvas is not written into this " +
  "tab (#1215/#1639/#1911). The SOURCE tab was still flushed before the " +
  "switch (#1295). Read the graph (panel_graph_outline / panel_query_graph) " +
  "and compare it against what you expect this workflow to contain. If it " +
  "IS the wrong graph, panel_load_workflow with this workflow's path loads " +
  "the saved copy from disk. That REPLACES the canvas.";

/**
 * Install a synchronous Pinia pointer watch on the first candidate store that
 * exposes `$subscribe` and returns a stop handle.
 *
 * @param {() => void} observer
 * @param {unknown[]} [stores]
 * @returns {{ available: boolean, stop: (() => void) | null }}
 */
export function installActivePointerWatch(observer, stores = []) {
  if (typeof observer !== "function") return { available: false, stop: null };
  for (const store of stores) {
    if (typeof store?.$subscribe !== "function") continue;
    try {
      const stop = store.$subscribe(observer, { detached: true, flush: "sync" });
      if (typeof stop === "function") return { available: true, stop };
    } catch {
      // Try the next candidate; a throwing store is the same as a missing one.
    }
  }
  return { available: false, stop: null };
}

/**
 * Decide whether TARGET's live canvas may be captured after `openWorkflow`,
 * and whether the missing-watch capability must be named on the reply.
 *
 * @param {{
 *   watchAvailable?: boolean,
 *   openLoaded?: boolean,
 *   captureSourceProof?: boolean,
 *   pointerProof?: boolean,
 *   pointerMovedThisOpen?: boolean,
 * }} [input]
 * @returns {{
 *   capture: boolean,
 *   disclose: boolean,
 *   reason: string,
 *   notice?: string,
 * }}
 */
export function decideLiveCanvasCapture({
  watchAvailable = false,
  openLoaded = false,
  captureSourceProof = false,
  pointerProof = false,
  pointerMovedThisOpen = false,
} = {}) {
  const discloseMissingWatch = watchAvailable !== true;
  const withNotice = (capture, reason) =>
    discloseMissingWatch
      ? {
          capture,
          disclose: true,
          reason,
          notice: POINTER_WATCH_UNAVAILABLE_NOTICE,
        }
      : { capture, disclose: false, reason };

  // A state this command just read off disk holds no node-written values to
  // save, and the canvas behind it is whatever the closed tab left there.
  if (openLoaded === true) return withNotice(false, "loaded-from-disk");

  if (watchAvailable === true) {
    if (pointerProof === true && captureSourceProof === true) {
      return { capture: true, disclose: false, reason: "pointer-proof" };
    }
    return {
      capture: false,
      disclose: false,
      reason: pointerProof !== true ? "unproven-pointer" : "unproven-source",
    };
  }

  // No watcher. "bound" on a switch is the #1639 hole (stale root UUID is not
  // independent canvas proof), so the fallback is already-current only — the
  // proof this path used before the watcher existed, minus the bound-after-move
  // arm #1907 closed. A switch skips TARGET capture (do not poison) and names
  // the missing capability instead of going quiet.
  if (pointerMovedThisOpen === true) {
    return withNotice(false, "watch-unavailable-switch");
  }
  if (captureSourceProof !== true) {
    return withNotice(false, "watch-unavailable-unproven-source");
  }
  return withNotice(true, "watch-unavailable-already-current");
}
