/**
 * Detect a graph READ that is out of sync with the ACTIVE workflow (panel#389).
 *
 * The panel reads node counts straight off LiteGraph's live `app.graph._nodes`,
 * while "active / modified / missing-model" come from ENTIRELY separate Vue/Pinia
 * stores (`extensionManager.workflow.activeWorkflow`, the `missingModel` store).
 * Nothing reconciles the two. When a load / tab-switch / post-reconnect canvas
 * rebuild leaves the live root graph bound to a DIFFERENT, empty graph object than
 * the one the active workflow describes, a read returns `node_count: 0` while the
 * workflow service still reports the workflow active with red missing-model nodes.
 * That silent false-clean makes the agent believe the canvas is empty — and e.g.
 * tell the user to ignore red nodes or re-download a model that IS wired.
 *
 * The reliable, version-defensive ground truth is the workflow object's OWN
 * serialized state, kept by ComfyUI's ChangeTracker: `activeState` (current) and
 * `initialState` (load baseline), each a serialized graph `{ nodes: [...] }`. For
 * the desync above the active workflow retains its real node count (its state was
 * captured when ITS graph was live) while the now-bound `app.graph` is empty.
 *
 * These helpers are PURE (no DOM / no ComfyUI globals — every input is passed in)
 * so the detection can be unit-tested without a browser.
 */

/**
 * The active workflow's OWN expected node count, read from its ChangeTracker's
 * serialized state. `activeState` is the workflow's CURRENT intended node set;
 * `initialState` is the load/save baseline.
 *
 * PREFER `activeState` and honor its count EVEN WHEN ZERO — only fall back to
 * `initialState` when `activeState` is absent or malformed. Taking the MAX of the
 * two would falsely report an expectation after a legitimate `graph_clear`
 * (activeState→0 but the baseline `initialState` still holds the pre-clear nodes),
 * making the desync guard throw on a genuinely-emptied workflow (codex P1). Some
 * builds hang the serialized states flat off the workflow rather than off
 * `changeTracker`, so each source is probed there too.
 *
 * Fail-open to 0: any missing/malformed shape yields 0, so an ABSENT expectation
 * can NEVER manufacture a false desync — the guard only ever fires on a POSITIVE,
 * well-formed node count from the workflow's own CURRENT state.
 */
export function activeWorkflowNodeCount(activeWorkflow) {
  try {
    if (!activeWorkflow || typeof activeWorkflow !== "object") return 0;
    const ct = activeWorkflow.changeTracker;
    // Well-formed node-array length, or null when the state is absent/malformed.
    const nodesLen = (st) => (st && Array.isArray(st.nodes) ? st.nodes.length : null);
    // activeState first (current intent — 0 after a clear is authoritative), from the
    // change tracker then a flat fallback; only if BOTH are unavailable/malformed do
    // we drop to the load baseline. `??` keeps a well-formed 0 rather than skipping it.
    const active = nodesLen(ct?.activeState) ?? nodesLen(activeWorkflow.activeState);
    if (active != null) return active;
    const initial = nodesLen(ct?.initialState) ?? nodesLen(activeWorkflow.initialState);
    return initial ?? 0;
  } catch {
    return 0;
  }
}

/**
 * True when a graph READ is DESYNCED from the active workflow: the live ROOT graph
 * is EMPTY (`liveNodeCount === 0`) while the active workflow's own serialized state
 * carries nodes. Returns false (no desync — never throw) whenever:
 *   - the read is scoped INTO a subgraph (`inSubgraph`): a descended subgraph can
 *     legitimately be empty while the root workflow has nodes;
 *   - the live graph already has nodes (self-evidently bound);
 *   - there is no active workflow, or its state reports 0 nodes (a genuinely empty
 *     / brand-new workflow legitimately reads `node_count: 0`).
 *
 * Fail-safe by construction: it fires ONLY on a provable "workflow has N>0 nodes
 * but the live root graph has zero" mismatch, so a genuinely-empty workflow is
 * never misflagged.
 */
export function graphReadDesynced({ liveNodeCount, activeWorkflow, inSubgraph = false } = {}) {
  if (inSubgraph) return false;
  if (Number(liveNodeCount) !== 0) return false;
  return activeWorkflowNodeCount(activeWorkflow) > 0;
}

/**
 * True when the graph READ's binding changed across an AWAIT: the active-workflow
 * instance or the bound root-graph object captured before the await no longer
 * matches after it. Used to detect a workflow-tab SWITCH that interleaved with a
 * server probe mid-read (graph_get_errors' nested-input /view probe, #513 review)
 * — without it, the read would join the PRE-switch workflow's asset verdicts onto
 * the now-active workflow and return workflow A's result while B is active.
 *
 * Identity-based, not value-based: ComfyUI mutates a workflow instance's path in
 * place on rename/Save-As, so the INSTANCE is the only stable identity (a rename
 * alone leaves it intact and correctly reads as NO switch). Fires only on a
 * provable change — both snapshots unresolvable (null/null) compares equal and
 * never manufactures a mismatch.
 */
export function graphReadBindingChanged({
  beforeWorkflow,
  afterWorkflow,
  beforeRootGraph,
  afterRootGraph,
} = {}) {
  return beforeWorkflow !== afterWorkflow || beforeRootGraph !== afterRootGraph;
}
