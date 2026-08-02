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
 * Return the active workflow's serialized CURRENT graph state. `initialState`
 * is deliberately excluded: it is a load/save baseline and can legitimately
 * differ from an active canvas with unsaved edits. `null` means current state is
 * unavailable, so callers must fail open rather than invent a binding mismatch.
 */
function activeWorkflowCurrentState(activeWorkflow) {
  try {
    if (!activeWorkflow || typeof activeWorkflow !== "object") return null;
    const ct = activeWorkflow.changeTracker;
    const state = (st) => (st && Array.isArray(st.nodes) ? st : null);
    return (
      state(ct?.activeState) ??
      state(activeWorkflow.activeState)
    );
  } catch {
    return null;
  }
}

function graphShape(state) {
  if (!state || !Array.isArray(state.nodes)) return null;
  // Omit counters/version metadata that can legitimately differ after LiteGraph
  // rebuilds; retain every serialized graph surface ChangeTracker treats as
  // workflow state, so the binding guard cannot accept a different canvas that
  // only differs in reroutes, floating links, or top-level subgraphs.
  // ChangeTracker distinguishes a missing surface from an explicitly empty or
  // null one. Preserve that distinction rather than `??`-normalizing it away.
  const own = (key) => Object.prototype.hasOwnProperty.call(state, key);
  const surface = (key) => ({ present: own(key), value: state[key] });
  const extra = (() => {
    if (!own("extra")) return { present: false };
    if (!state.extra || typeof state.extra !== "object") return { present: true, value: state.extra };
    const { ds: viewport, ...workflowExtra } = state.extra;
    // A sole `extra.ds` is viewport-only, so it compares like no extra field.
    if (viewport !== undefined && Object.keys(workflowExtra).length === 0) return { present: false };
    return { present: true, value: workflowExtra };
  })();
  const shape = {
    // LiteGraph preserves node array order opportunistically, but it does not
    // identify a workflow: equivalent loads can emit the same nodes in a
    // different order. Keep each node's full serialized content and normalize
    // only their ordering by stable id.
    nodes: [...state.nodes].sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? ""))),
    links: surface("links"),
    floatingLinks: surface("floatingLinks"),
    reroutes: surface("reroutes"),
    groups: surface("groups"),
    config: surface("config"),
    subgraphs: surface("subgraphs"),
    definitions: surface("definitions"),
    // `extra.ds` is the viewport transform. Panning/zooming changes it without
    // changing the workflow, so it must not block a valid graph command.
    extra,
  };
  try {
    const canonicalize = (value) => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonicalize(value[key])]),
        );
      }
      return value;
    };
    return JSON.stringify(canonicalize(shape));
  } catch {
    return null;
  }
}

/**
 * True when the live ROOT graph is demonstrably a different workflow from the
 * active workflow's own serialized state. Unlike graphReadDesynced's original
 * empty-canvas check, this catches a stale *nonempty* canvas (for example an
 * active nine-node tab while app.graph still holds a 63-node prior tab).
 *
 * Node count alone catches the common case. Where LiteGraph can serialize its
 * root, compare the complete semantic graph state (nodes, widgets, links,
 * groups, reroutes, floating links, top-level subgraphs, definitions, and extra)
 * so same-sized tabs cannot be silently confused.
 * Older/partial frontends fall back to an unordered `id` + `type` shape; if that
 * is also unavailable, equal counts remain inconclusive and return false. The
 * guard never manufactures a mismatch from partial state.
 */
export function graphRootMismatchesActiveWorkflow({ rootGraph, activeWorkflow } = {}) {
  // #545 — ChangeTracker's activeState is a useful *clean-tab* binding witness,
  // but it is not a synchronous mirror of every manual LiteGraph edit. A dirty
  // workflow can therefore legitimately serialize differently from the root it
  // owns (including a different node count). Treat that comparison as
  // inconclusive while dirty rather than permanently rejecting every graph tool.
  // Callers can still use a durable per-workflow identity to prove a dirty root
  // belongs to a different tab.
  if (activeWorkflow?.isModified === true) return false;
  const activeState = activeWorkflowCurrentState(activeWorkflow);
  const expected = activeState?.nodes;
  const live = rootGraph?._nodes;
  if (!Array.isArray(expected) || !Array.isArray(live)) return false;
  if (live.length !== expected.length) return true;

  // Current LiteGraph can serialize its live ROOT graph. When both sides can be
  // represented, compare the complete semantic shape so equal id:type node sets
  // with different links, widgets, groups, or subgraphs cannot be confused.
  // An unavailable/throwing serializer remains inconclusive and falls through to
  // the older id:type comparison below.
  try {
    const liveShape = graphShape(rootGraph?.serialize?.());
    const expectedShape = graphShape(activeState);
    if (liveShape != null && expectedShape != null) return liveShape !== expectedShape;
  } catch {
    // Old/partial LiteGraph frontends: use the defensive shape fallback below.
  }

  const shape = (node) => {
    if (!node || (typeof node.id !== "string" && typeof node.id !== "number") || typeof node.type !== "string") {
      return null;
    }
    return `${typeof node.id}:${node.id}\u0000${node.type}`;
  };
  const expectedShapes = expected.map(shape);
  const liveShapes = live.map(shape);
  if (expectedShapes.includes(null) || liveShapes.includes(null)) return false;
  const expectedSet = new Set(expectedShapes);
  if (expectedSet.size !== expectedShapes.length) return false;
  return liveShapes.some((entry) => !expectedSet.has(entry));
}

/**
 * True only when a root graph carries a durable workflow UUID that conflicts
 * with the active workflow object's already-established UUID. Missing identity
 * on either side is inconclusive: older frontends and first observation must
 * never manufacture a false refusal.
 *
 * This is deliberately separate from ChangeTracker state comparison. It remains
 * trustworthy for a dirty workflow, where activeState may lag manual edits but a
 * root from another tab still carries that other tab's identity.
 */
export function graphRootWorkflowUuidMismatches({ rootGraph, activeWorkflowUuid } = {}) {
  if (typeof activeWorkflowUuid !== "string" || !activeWorkflowUuid) return false;
  const rootUuid = rootGraph?.extra?.comfyui_mcp?.workflow_uuid;
  return typeof rootUuid === "string" && rootUuid && rootUuid !== activeWorkflowUuid;
}

/**
 * True only when both sides carry the same established workflow identity. This
 * is stronger than `graphRootWorkflowUuidMismatches`: missing metadata is
 * inconclusive for reads, but a dirty graph mutation cannot safely use an
 * inconclusive root because ChangeTracker may lag the user's real canvas.
 */
export function graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid } = {}) {
  if (typeof activeWorkflowUuid !== "string" || !activeWorkflowUuid) return false;
  const rootUuid = rootGraph?.extra?.comfyui_mcp?.workflow_uuid;
  return typeof rootUuid === "string" && rootUuid === activeWorkflowUuid;
}

/**
 * Whether a bridge graph command can change durable workflow state.
 *
 * A dirty workflow without a root UUID is not sufficiently proven for a graph
 * mutation: ChangeTracker can lag the canvas, so a stale untagged root must
 * stay fail-closed (#545 P1).  That proof requirement must not, however,
 * prevent the read-only tools from inspecting the live canvas and recovering
 * from a stale tracker snapshot.  In particular, an unsaved local edit may
 * legitimately make the root differ from ChangeTracker until the next state
 * capture.
 *
 * Keep the small read-only list explicit and default unknown/new graph commands
 * to mutating.  Adding a graph tool therefore cannot accidentally weaken the
 * wrong-workflow mutation fence.
 */
const READ_ONLY_GRAPH_COMMANDS = new Set([
  "graph_serialize",
  "graph_get_state",
  "graph_view_selected",
  "graph_view_nodes_in_viewport",
  "graph_outline",
  "graph_query",
  "graph_find_nodes",
  "graph_get_subgraph",
  "graph_list_subgraphs",
  "graph_screenshot",
]);

export function graphCommandMayMutateWorkflow(command) {
  return !READ_ONLY_GRAPH_COMMANDS.has(command);
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
