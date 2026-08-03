/**
 * Async preflights must not commit into a graph selected before a tab/subgraph
 * switch. The caller supplies the workflow comparator because ComfyUI can
 * expose the same workflow through a Vue proxy and its raw object.
 */
export function sameGraphMutationContext(before, after, sameWorkflow = (a, b) => a === b) {
  return !!before && !!after &&
    before.app === after.app &&
    before.graph === after.graph &&
    before.rootGraph === after.rootGraph &&
    before.canvas === after.canvas &&
    sameWorkflow(before.workflow, after.workflow);
}
