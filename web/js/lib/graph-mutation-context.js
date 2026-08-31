/**
 * Async preflights must not commit into a graph selected before a tab/subgraph
 * switch. The caller supplies the workflow comparator because ComfyUI can
 * expose the same workflow through a Vue proxy and its raw object.
 */

/**
 * #2125 — the workflow slot answers a CHANGE question, not an IDENTITY one, and
 * the two disagree about absence.
 *
 * `activeWorkflowRef()` returns null whenever the frontend exposes no active
 * workflow — an `extensionManager.workflow` surface that is missing, still
 * seating, or throwing. The caller's comparator (`sameWorkflowObject`) answers
 * false for ANY pair containing a null, and that is the right answer to the
 * question it is asked: two references sharing no identity carrier can never be
 * PROVEN the same. But absent-then-absent is not two references, it is no
 * reference twice, and nothing moved between them.
 *
 * Delegating the null pair to that comparator therefore refused every graph
 * mutation on such a frontend, claiming "the active workflow or graph view
 * changed" about a tab that never changed and telling the caller to "retry on
 * the intended tab" — advice no retry can satisfy, because the next capture
 * reads null again and refuses identically. The rest of the panel treats this
 * state as supported: `graphEmptyBindingUnproven` returns false on a null
 * workflow ("no workflow service — legacy availability"), and every other
 * predicate in `resolveGraphBindingVerdict` degrades to no-refusal, so the
 * binding bar that runs immediately after this gate lets the mutation through.
 * This gate was the only one that did not, and it runs on the MUTATION path
 * alone — which is why the reporter's `panel_graph_outline` read succeeded
 * against the very canvas the following `panel_add_node` was refused on.
 *
 * Absence appearing or disappearing is still a change: a workflow that arrives
 * mid-preflight, or one that vanishes, both stay refused. Only absent→absent is
 * admitted, and it is admitted because it is not evidence of anything.
 *
 * ABSENT IS NOT THE SAME AS UNREADABLE (gate r1 P1), and the whole safety of the
 * paragraph above rests on the distinction. `activeWorkflowRef()` also answers
 * `null` when its lookup THREW, and two throws would otherwise witness
 * "absent, then absent" across a preflight the workflow genuinely moved during —
 * admitting a write onto a canvas nothing verified. So the caller reports whether
 * the probe RAN (`workflowReadable`), and a null is only unchanged when BOTH ends
 * proved there was nothing to see. Unreadable, or unstated, fails closed exactly
 * as before this fix: a context that does not carry the flag is refused on a null
 * workflow, so no other caller can opt into the relaxation by accident.
 */
function absenceProven(context) {
  return context.workflow == null && context.workflowReadable === true;
}

function sameWorkflowSlot(before, after, sameWorkflow) {
  if (before.workflow == null || after.workflow == null) {
    return absenceProven(before) && absenceProven(after);
  }
  return sameWorkflow(before.workflow, after.workflow);
}

export function sameGraphMutationContext(before, after, sameWorkflow = (a, b) => a === b) {
  return !!before && !!after &&
    before.app === after.app &&
    before.graph === after.graph &&
    before.rootGraph === after.rootGraph &&
    before.canvas === after.canvas &&
    sameWorkflowSlot(before, after, sameWorkflow);
}
