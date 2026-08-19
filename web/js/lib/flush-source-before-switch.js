/**
 * #1295 — flush the outgoing tab's live canvas into ITS tracker before a
 * workflow switch moves the pointer.
 *
 * ComfyUI's ChangeTracker snapshots on USER INPUT events only. A node added
 * through the bridge (`panel_add_node`) lives on the live canvas, but the
 * outgoing tab's `activeState` is one capture behind — the add's own snapshot
 * is deferred after the reply (#581) and is lost if a switch/reconnect lands
 * first. The switch then repaints from that stale snapshot and the added node
 * is gone; a later reconnect restores the same stale state. Measured shape of
 * the report: a 31-node workflow, ImpactWildcardProcessor id 49 on the canvas,
 * 31 nodes after the switch+reconnect, node 49 absent.
 *
 * This is the inverse of the #1215 capture gate, not a weakening of it:
 *
 *   #1215  — do NOT write SOURCE's still-mounted canvas into TARGET after the
 *            pointer has moved (that poisons the tab being opened).
 *   #1295  — DO write SOURCE's canvas into SOURCE, while SOURCE is still the
 *            active pointer. `captureCanvasIntoTracker` no-ops on a non-active
 *            tracker, so this has to happen BEFORE `openWorkflow`.
 *
 * "foreign" still skips: the mounted canvas is proven to belong to someone
 * else, and capturing it would be the #708/#1215 poisoning in the other
 * direction. "unknown" MUST flush — that is the already-current untagged
 * case, and it is the configuration after a restart with Persist=false
 * (#1215's reported setup), which is when the extra node is most at risk.
 *
 * Best-effort: a failed or pending-then-failed capture never blocks the
 * switch. Blocking it would strand the session on a tab the caller is
 * trying to leave. Callers inject the collaborators so the decision is
 * unit-testable without a DOM.
 */

/**
 * @param {{
 *   source?: object | null,
 *   target?: object | null,
 *   sameWorkflowObject?: (a: unknown, b: unknown) => boolean,
 *   describeLiveCanvasBinding?: (wf: object) => string,
 *   captureCanvasIntoTracker?: (wf: object) =>
 *     | { verdict?: string, settled?: Promise<string> }
 *     | null
 *     | undefined,
 * }} [input]
 * @returns {Promise<{ flushed: boolean, reason: string, verdict?: string }>}
 */
export async function flushSourceCanvasBeforeSwitch({
  source,
  target,
  sameWorkflowObject,
  describeLiveCanvasBinding,
  captureCanvasIntoTracker,
} = {}) {
  try {
    if (!source || typeof source !== "object") {
      return { flushed: false, reason: "no-source" };
    }
    const same =
      typeof sameWorkflowObject === "function"
        ? sameWorkflowObject(source, target)
        : source === target;
    if (same) return { flushed: false, reason: "already-current" };

    const binding =
      typeof describeLiveCanvasBinding === "function"
        ? describeLiveCanvasBinding(source)
        : "unknown";
    if (binding === "foreign") return { flushed: false, reason: "foreign" };
    if (typeof captureCanvasIntoTracker !== "function") {
      return { flushed: false, reason: "unavailable" };
    }

    const captured = captureCanvasIntoTracker(source);
    if (!captured || typeof captured !== "object") {
      return { flushed: false, reason: "unavailable" };
    }
    let verdict = captured.verdict;
    if (verdict === "pending") {
      try {
        verdict = (await captured.settled) ?? "unverified";
      } catch {
        verdict = "failed";
      }
    }
    const finalVerdict = typeof verdict === "string" && verdict ? verdict : "unverified";
    return {
      flushed: finalVerdict === "captured",
      reason: finalVerdict,
      verdict: finalVerdict,
    };
  } catch {
    return { flushed: false, reason: "failed" };
  }
}
