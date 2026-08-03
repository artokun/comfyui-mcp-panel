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
 * #560 (2nd reopen) — the FALSE-EMPTY authoritative read. After a reconnect +
 * workflow-tab switch (or a failed workflow_open repaint), the shared
 * app.graph object is observable MID-POPULATION: `_nodes` empty, no root tag,
 * and the active workflow's tracker unreadable or not yet settled. Every other
 * binding predicate is inconclusive in that window BY DESIGN: the baseline
 * desync guard needs a POSITIVE tracker node count (it fails open to 0 on an
 * absent/malformed read), the shape guard deliberately skips both-empty
 * comparisons (#565), and the UUID guards treat a missing root tag as
 * inconclusive. An empty root READ there returned `node_count: 0` as
 * AUTHORITATIVE for a canvas known to hold 10 nodes — and the agent built ~70
 * nodes on the false reading (#349-class wrong-canvas work).
 *
 * This predicate is the empty-read evidence bar: an empty ROOT read is
 * authoritative ONLY when it is
 *   - PROVEN genuinely empty — a CLEAN tracker with a well-formed, all-empty
 *     CURRENT serialized state (activeWorkflowProvenEmpty; a node COUNT of 0
 *     from an absent/malformed read is NOT proof), or
 *   - POSITIVELY bound — the root tag matches the active workflow's identity
 *     (graphRootWorkflowUuidMatches), the known #545 availability case: a
 *     manual/agent clear on a bound canvas with the tracker legitimately
 *     lagging.
 *
 * Returns true (INCONCLUSIVE — the caller must refuse rather than treat the
 * empty read as authoritative) only when the root observably has zero nodes
 * AND neither proof holds. Availability is preserved where it must be:
 *   - a POPULATED root (self-evidently bound) and an unreadable root shape
 *     stay with the legacy predicates;
 *   - subgraph scope is exempt (a descended empty subgraph is legitimate,
 *     mirroring graphReadDesynced);
 *   - with NO active workflow service at all, the legacy availability path
 *     stands (that frontend never had binding fences).
 */
export function graphEmptyBindingUnproven({ graph, rootGraph, activeWorkflow, activeWorkflowUuid } = {}) {
  if (!!rootGraph && graph && graph !== rootGraph) return false; // subgraph scope
  const live = rootGraph?._nodes;
  if (!Array.isArray(live) || live.length !== 0) return false; // populated or unobservable
  if (!activeWorkflow) return false; // no workflow service — legacy availability
  if (activeWorkflowProvenEmpty(activeWorkflow)) return false; // PROVEN empty — truthful 0
  if (graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid })) return false; // positively bound
  return true; // empty + unproven + unbound ⇒ inconclusive, never authoritative-empty
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

/**
 * A serialized-surface value holding no content: null/undefined, an empty
 * array, or a plain object with no own keys. Scalars and non-empty values are
 * significant (malformed or real content — never silently tolerated).
 */
const isEmptySurfaceValue = (value) =>
  value == null ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && Object.keys(value).length === 0);

/**
 * Serialized-graph FORMAT metadata that is not workflow content: graph ids,
 * revision/version stamps, and the id counters LiteGraph leaves on a rebuilt
 * or cleared canvas. Everything else a serialized state carries is compared as
 * (potential) content by serializedStateProvenEmpty below.
 */
const SERIALIZED_FORMAT_METADATA_KEYS = new Set([
  "id",
  "revision",
  "version",
  "last_node_id",
  "last_link_id",
  "last_group_id",
  "lastGroupId",
  "last_reroute_id",
]);

/**
 * POSITIVE proof that a serialized graph state holds NO workflow content at
 * all — the empty-canvas relaxation's evidence bar (#565 gate). True only
 * when `state` is a well-formed serialized graph whose `nodes` is a PRESENT
 * empty array (a missing/malformed read proves nothing) AND every own
 * surface outside the format-metadata allowlist is absent-or-empty. Inside
 * `extra`, `ds` (viewport) and `comfyui_mcp` (the panel's own identity tag)
 * are not content; any other key must hold an empty value. A single
 * non-empty subgraphs/groups/reroutes/links surface — or any unknown
 * non-empty surface — defeats the proof, so a foreign content-bearing canvas
 * can never be re-stamped through the relaxation.
 */
export function serializedStateProvenEmpty(state) {
  try {
    if (!state || typeof state !== "object" || Array.isArray(state)) return false;
    if (!Array.isArray(state.nodes) || state.nodes.length !== 0) return false;
    for (const [key, value] of Object.entries(state)) {
      if (key === "nodes" || SERIALIZED_FORMAT_METADATA_KEYS.has(key)) continue;
      if (key === "extra") {
        if (value == null) continue;
        if (typeof value !== "object" || Array.isArray(value)) return false;
        const { ds: viewport, comfyui_mcp: panelTag, ...workflowExtra } = value;
        for (const extraValue of Object.values(workflowExtra)) {
          if (!isEmptySurfaceValue(extraValue)) return false;
        }
        continue;
      }
      if (!isEmptySurfaceValue(value)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * POSITIVE proof that the ACTIVE workflow's own canvas is content-free
 * (#565 gate). Requires ALL of:
 *   - the workflow is CLEAN — a dirty tracker state can lag the user's real
 *     canvas (#545), so a dirty tab can never prove emptiness;
 *   - the workflow's OWN serialized CURRENT state exists and is well-formed
 *     (activeWorkflowCurrentState — a missing/malformed read proves nothing,
 *     and a node COUNT of 0 from a failed read is not evidence either);
 *   - that state holds no content on any non-identity surface.
 * Absent or malformed state fails closed: false.
 */
export function activeWorkflowProvenEmpty(activeWorkflow) {
  try {
    if (activeWorkflow?.isModified === true) return false;
    return serializedStateProvenEmpty(activeWorkflowCurrentState(activeWorkflow));
  } catch {
    return false;
  }
}

/**
 * POSITIVE proof that the live ROOT graph is content-free (#565 gate). A bare
 * empty `_nodes` array is node-level evidence only: without serialize() there
 * is no way to prove the root holds no non-node content (subgraphs, groups,
 * links), so an unserializable root fails closed.
 */
export function graphRootProvenEmpty(rootGraph) {
  try {
    if (!Array.isArray(rootGraph?._nodes) || rootGraph._nodes.length !== 0) return false;
    if (typeof rootGraph?.serialize !== "function") return false;
    return serializedStateProvenEmpty(rootGraph.serialize());
  } catch {
    return false;
  }
}

function graphShape(state) {
  if (!state || !Array.isArray(state.nodes)) return null;
  // Omit counters/version metadata that can legitimately differ after LiteGraph
  // rebuilds; retain every serialized graph surface ChangeTracker treats as
  // workflow state, so the binding guard cannot accept a different canvas that
  // only differs in reroutes, floating links, or top-level subgraphs.
  //
  // #560/#565 — a surface ChangeTracker OMITS but LiteGraph's serialize() emits
  // as present-but-empty (or null) is a serializer DIALECT, not workflow
  // content: a ChangeTracker state routinely lacks `links`/`groups`/`config`/
  // `reroutes`/`subgraphs`/`definitions`/`extra` keys that the live root's
  // serialize() re-emits as `[]`/`{}`/`null`. Comparing presence strictly made
  // a canvas false-mismatch the very state it was just loaded from — which
  // broke the workflow_open repaint proof on a drifted binding (#560) and the
  // empty-canvas read guard (#565). Present-empty therefore compares EQUAL to
  // absent. NON-empty values keep the full present-vs-absent strictness, so a
  // canvas that genuinely differs in reroutes / floating links / groups /
  // subgraphs still mismatches (#349 unchanged).
  const EMPTY_SURFACE = { present: false };
  const own = (key) => Object.prototype.hasOwnProperty.call(state, key);
  const surface = (key) => {
    if (!own(key)) return EMPTY_SURFACE;
    const value = state[key];
    return isEmptySurfaceValue(value) ? EMPTY_SURFACE : { present: true, value };
  };
  const extra = (() => {
    if (!own("extra")) return EMPTY_SURFACE;
    if (!state.extra || typeof state.extra !== "object") {
      // A scalar extra is malformed, not a dialect — keep it significant.
      return isEmptySurfaceValue(state.extra) ? EMPTY_SURFACE : { present: true, value: state.extra };
    }
    // `ds` is the viewport transform and `comfyui_mcp` is the panel's own
    // identity tag — neither is workflow content. Panning/zooming or an
    // identity (re)stamp must never manufacture a binding mismatch: a root
    // re-tagged by the guard's rebind heal would otherwise instantly
    // false-mismatch a tracker capture that still holds the prior tag (#560).
    // Tag CONFLICTS are owned by the dedicated UUID predicates above, with
    // their claim/heal semantics (#545/#557) — not by this content shape.
    // The same dialect rule applies INSIDE extra: a key one side emits with an
    // empty value (e.g. LiteGraph's linkExtensions: []) is not content, so
    // empty-valued keys are dropped before comparing; a non-empty value stays
    // significant, and only what remains is compared.
    const { ds: viewport, comfyui_mcp: panelTag, ...workflowExtra } = state.extra;
    const contentExtra = Object.fromEntries(
      Object.entries(workflowExtra).filter(([, extraValue]) => !isEmptySurfaceValue(extraValue)),
    );
    return Object.keys(contentExtra).length === 0 ? EMPTY_SURFACE : { present: true, value: contentExtra };
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
 * Strict positive proof that a root graph now represents this exact serialized
 * state. Unlike the ordinary read guard, this does NOT treat missing serializer
 * data or a dirty workflow as inconclusive: callers use it only after they have
 * just asked `loadGraphData` to install `state`, so an absent proof must not turn
 * into a fabricated success. Strictness is about CONTENT: every node and every
 * non-empty surface must match. Serializer dialect — an optional surface the
 * state omits but LiteGraph re-emits as present-but-empty, or the panel's own
 * `extra.comfyui_mcp` identity tag — is NOT content and can never make a
 * faithful repaint fail this proof (#560: that false negative is what left a
 * drifted binding with no recovery short of a panel reload).
 */
export function graphRootMatchesState({ rootGraph, state } = {}) {
  try {
    const expected = graphShape(state);
    const actual = graphShape(rootGraph?.serialize?.());
    return expected != null && actual != null && expected === actual;
  } catch {
    return false;
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
 *
 * #565 — there is deliberately NO blanket zero-node skip: a state with zero
 * nodes can still carry real content (subgraphs, groups, reroutes, links), and
 * a genuinely-empty canvas compares equal through the serializer-dialect
 * normalization above anyway. Zero nodes relaxes nothing.
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
 * #545/#557 — a root-tag/active-identity UUID conflict is not always a wrong
 * canvas. The tag is panel-owned bookkeeping, and a save or reconnect can drift
 * it from the ACTIVE workflow's resolved identity while the root is still that
 * workflow's own canvas. For that case the guard must be RECOVERABLE: re-stamp
 * the root with the active identity instead of hard-blocking every graph tool
 * until a frontend reload.
 *
 * Returns:
 *   "none"     — no UUID conflict (missing identity on either side stays
 *                inconclusive, exactly like graphRootWorkflowUuidMismatches);
 *   "rebind"   — the ACTIVE workflow ITSELF claims the tag (its resolver
 *                identity, its own serialized state, or its registered owner
 *                record ties it to the tag): the tag is the active tab's own
 *                lineage, stale relative to its current identity, so the root
 *                is provably its own canvas — re-stamp and proceed. Also when
 *                `staleTagOnEmptyCanvas` is set (#565): ComfyUI reuses the
 *                app.graph object across tabs and its clear/configure does NOT
 *                reset graph.extra, so a brand-new blank tab inherits the
 *                PREVIOUS workflow's tag while minting its own identity. With
 *                zero nodes on BOTH sides there is no workflow content that
 *                could be confused — the #349 fence protects CONTENT — so the
 *                leftover tag is stale metadata: re-stamp and proceed;
 *   "conflict" — anything else. A tag claimed by a FOREIGN open workflow is the
 *                #349 wrong-canvas case, and a tag NOBODY claims may be a
 *                closed tab's stale canvas — re-stamping either would authorize
 *                writes to a graph that is not the active workflow's (r4/r5
 *                P0). Both fail closed; the remedy for a genuinely drifted
 *                binding is panel_open_workflow's proven repaint re-stamp.
 */
export function resolveGraphRootUuidRebind({
  rootGraph,
  activeWorkflowUuid,
  rootTagClaimedByActiveWorkflow = false,
  staleTagOnEmptyCanvas = false,
} = {}) {
  if (!graphRootWorkflowUuidMismatches({ rootGraph, activeWorkflowUuid })) return "none";
  return rootTagClaimedByActiveWorkflow || staleTagOnEmptyCanvas ? "rebind" : "conflict";
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
