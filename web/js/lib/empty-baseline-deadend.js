/**
 * comfyui-mcp#803 — after a ComfyUI reconnect the agent was left with NO working
 * recovery path.
 *
 * The reported sequence:
 *
 *   panel_graph_outline  -> "the workflow reports 0 node(s), but the canvas is bound
 *                            to a different graph ... Re-open the active workflow tab
 *                            (panel_open_workflow) or reload the panel"
 *   panel_list_workflows -> healthy: active_confirmed: true, the workflow present in
 *                            open[] with active: true, persisted: true
 *   panel_open_workflow  -> "could not prove that the active canvas was rebound"
 *
 * One tool says broken, one says fine, and the repair the error itself recommends is
 * refused. That is worse than any single wrong answer: there is no exit.
 *
 * ## Why the two tools disagree
 *
 * They read different sources. `panel_list_workflows` reads the workflow store, which
 * was genuinely healthy. The refusal compares ChangeTracker's `activeState` against the
 * live root graph — and ChangeTracker captures on USER INPUT, so after a restart it can
 * hold an EMPTY baseline for a workflow whose canvas is fully populated.
 *
 * ## What is not earned
 *
 * With `expected = 0` and a populated canvas on a CLEAN tab, "it is bound to a
 * different graph" is a conclusion the evidence does not support. An empty baseline and
 * a wrong canvas look identical from here, and the far more common cause after a
 * reconnect is the baseline. Stating the conclusion is the #796 shape: "cannot
 * determine" rendered as "is not the case".
 *
 * ## Why the remedy made it a dead end
 *
 * This file already documents the loop, for #701: the tracker re-baselines only after a
 * command SUCCEEDS. So the refusal blocks the very thing that would refresh the
 * baseline; `workflow_open`'s repaint re-runs the same hook, so its own proof fails;
 * and the retried read fails identically. Its note ends: "Only a page reload broke the
 * loop." The refusal was recommending the two levers that cannot work while omitting
 * the one that does.
 *
 * ## Scope
 *
 * DISCLOSURE ONLY. What gets refused is unchanged — #565 deliberately rejected a
 * blanket zero-node skip, because a zero-node state can still carry real content
 * (subgraphs, groups, reroutes, links), and relitigating that without a measurement is
 * how a binding guard stops guarding. This changes what the refusal CLAIMS, and what it
 * tells the reader to do.
 */

/** Is this the empty-baseline shape: nothing captured, but a populated canvas? */
export function isEmptyBaselineMismatch({ expected, live } = {}) {
  return (
    Number.isFinite(expected) && Number.isFinite(live) && expected === 0 && live > 0
  );
}

/**
 * What the refusal should SAY when the baseline is empty.
 *
 * Deliberately does not assert which of the two causes it is — that is the whole point
 * — and names the recovery that is known to work, plus the reason the obvious ones
 * may not.
 */
export function emptyBaselineNote(live) {
  return (
    `the workflow's last captured state is EMPTY while the live canvas holds ${live} ` +
    `node(s). That does NOT establish a different canvas: the panel captures a workflow's ` +
    `state on user input, so a reconnect or a ComfyUI restart can leave the captured ` +
    `state empty for a canvas that is perfectly correct. An empty baseline and a wrong ` +
    `canvas are indistinguishable from here, so this command was NOT applied.`
  );
}

/**
 * The remedy for that case.
 *
 * `panel_open_workflow` is named as something that MAY not clear it, because the
 * re-baseline only happens after a command succeeds — so recommending it alone is what
 * turned this into a loop (#803, mechanism recorded under #701).
 */
export function emptyBaselineRemedy() {
  return (
    `SAVE ANY UNSAVED CANVAS WORK FIRST, then reload the panel (or the browser tab) to ` +
    `rebuild the captured state — that is the step known to clear this. The save warning ` +
    `is not boilerplate: a reload discards unsaved graph edits, and this is a READ ` +
    `refusing, so nothing here is worth losing work over. Re-opening the workflow may ` +
    `NOT clear it: the captured state is refreshed only after a command SUCCEEDS, so ` +
    `while this refusal stands, the repair that would refresh it is itself blocked ` +
    `(comfyui-mcp#803). If a reload does not clear it, the empty baseline is no longer ` +
    `the likely explanation — check which workflow tab is actually active before ` +
    `retrying, but note a reload can also fail to re-capture for other reasons, so this ` +
    `still does not prove the canvas is bound elsewhere.`
  );
}
