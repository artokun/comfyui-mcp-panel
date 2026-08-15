// #619 — the post-navigation RECEIPT for canvas scope changes.
//
// graph_enter_subgraph used to fire canvas.openSubgraph(sub, node) and immediately
// report success. openSubgraph is not a receipt: the canvas can land on the target
// a beat later (or, on a struggling frontend, not observably at all), and the
// workflow tracker can still be mid-capture right after the view moved — so the
// IMMEDIATELY following graph read evaluated the root-shape guard against a
// scope/binding that had not settled and refused with [root-shape-mismatch] on a
// perfectly valid navigation. A bare call also meant a silent no-op navigation
// reported `entered` for a canvas that never moved.
//
// This helper establishes the receipt: poll (bounded) until the canvas observably
// shows the navigation target AND the caller-supplied binding assert passes, then
// report which of the two held. The caller decides refuse-vs-disclose:
//   - never landed (everLanded === false) → the navigation did NOT take effect:
//     refuse (nothing was applied, the retry is safe).
//   - landed === true, bound === false → the navigation DID happen: disclose —
//     never report failure for an act that succeeded (that invites a destructive
//     retry), report the settle state instead.
//   - everLanded === true but landed === false → the navigation happened and the
//     canvas has SINCE moved elsewhere (a user navigation, a tab restore):
//     disclose that too — claiming "nothing was applied" after an observed
//     landing is the same lie one poll later (codex gate).
//
// Pure-ish: the canvas read, the assert, and the clock are all injected, so the
// poll loop is unit-testable without a browser.

/**
 * @param {{
 *   readCanvasGraph: () => any,   // current canvas graph (may throw → not landed)
 *   target: any,                  // the graph object the navigation aimed at
 *   assertBound: () => void,      // throws while the binding/scope has not settled
 *   tries?: number,               // poll attempts (default 25)
 *   intervalMs?: number,          // delay between attempts (default 40ms ⇒ ~1s budget)
 *   sleep?: (ms: number) => Promise<void>,
 * }} o
 * @returns {Promise<{ landed: boolean, everLanded: boolean, bound: boolean, lastError: any }>}
 *   landed:     the canvas observably showed `target` on the LAST poll.
 *   everLanded: the canvas showed `target` on ANY poll. Once observed, the
 *               navigation DID happen — even if the canvas has since moved
 *               elsewhere — so the caller must DISCLOSE, never claim "nothing
 *               was applied" (a false refusal invites a redundant retry).
 *   bound:      landed AND assertBound passed (lastError is null in that case).
 *   lastError:  the most recent assertBound rejection reason, for disclosure.
 */
export async function confirmCanvasNavigation({
  readCanvasGraph,
  target,
  assertBound,
  tries = 25,
  intervalMs = 40,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let landed = false;
  let everLanded = false;
  let lastError = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      landed = readCanvasGraph() === target;
    } catch {
      landed = false;
    }
    if (landed) {
      everLanded = true;
      let probePassed = false;
      try {
        assertBound();
        probePassed = true;
      } catch (e) {
        lastError = e;
      }
      // Re-read after EVERY probe, pass or throw: the probe can MOVE the canvas
      // (getGraphCtx's verified rebind heal repaints a provably content-free
      // ghost to root) on either outcome, and the terminal verdict must
      // describe the LAST observation, not the pre-probe one (codex r2/r3).
      try {
        landed = readCanvasGraph() === target;
      } catch {
        landed = false;
      }
      if (probePassed && landed) {
        return { landed: true, everLanded: true, bound: true, lastError: null };
      }
    }
    if (attempt + 1 < tries) await sleep(intervalMs);
  }
  return { landed, everLanded, bound: false, lastError };
}
