import {
  definitionsDifferOnlyByCompletedLoadNormalization,
  definitionsDifferOnlyByRenumber,
} from "./definitions-renumber.js";
import { nodeInputsDifferOnlyByDefinitionRebuild } from "./node-inputs-rebuild.js";
import { nodePropertiesDifferOnlyByRandomRangeNormalization } from "./node-properties-random-range.js";
import {
  isEmptyBaselineMismatch,
  emptyBaselineNote,
  emptyBaselineRemedy,
} from "./empty-baseline-deadend.js";
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
 * The active workflow's OWN current-state node count, or `null` when that state
 * is absent/malformed. Unlike activeWorkflowNodeCount this NEVER falls back to
 * the load/save baseline (`initialState`): a baseline legitimately differs from
 * an edited canvas, so it is not evidence the live canvas is behind. `null`
 * lets callers fail OPEN — an unreadable current state proves nothing.
 */
export function activeWorkflowCurrentNodeCount(activeWorkflow) {
  const state = activeWorkflowCurrentState(activeWorkflow);
  return state ? state.nodes.length : null;
}

/**
 * #618 — the MID-POPULATION read. After a ComfyUI backend reconnect the frontend
 * RESTORES the active tab's graph incrementally, and for a window the live root
 * canvas observably holds FEWER nodes than the active workflow's own current
 * serialized state (the restore source). Every pre-existing predicate is blind
 * to exactly this signature on a DIRTY tab — and the reported tabs are dirty
 * (the unsaved edits are what the restore re-applies): the shape guard treats a
 * dirty tracker's state as inconclusive (#545: it can lag manual edits), the
 * baseline desync guard requires a trustworthy (clean) current state, and the
 * empty-read guard needs ZERO nodes, not a partial count. So an 8-of-31-node
 * restoring canvas was returned as an AUTHORITATIVE 8-node outline — and the
 * agent that trusted it duplicated a node it could not see and ran a
 * whole-graph layout against an under-reported graph (#618's follow-up; the
 * first report lost a single LoadImage the same way).
 *
 * This predicate is the evidence bar for that window, fired only when ALL of:
 *   - `postReconnectWindow`: the caller's monotonic/epoch machinery says a
 *     reconnect just happened and no explicit open/new has re-proven the tab
 *     since (outside the window the #545 dirty-tab availability is untouched);
 *   - ROOT scope (a descended subgraph is exempt, mirroring graphReadDesynced);
 *   - the workflow's CURRENT state is a well-formed read reporting N > 0 nodes
 *     (an absent/malformed read proves nothing — fail open);
 *   - the live root reads strictly FEWER nodes than N.
 *
 * The one signature it cannot distinguish is a manual node DELETION on a dirty
 * tab whose tracker has not captured yet, inside the same window. That refusal
 * is safe and self-clearing: the tracker's event-driven capture closes the gap
 * and the retry the message names succeeds — whereas a mid-population canvas
 * returned as authoritative is the fabricated-success outcome this repo treats
 * as the worst case. Reads and mutations alike are fenced: a mutation on a
 * canvas that is still being restored is #604's wrong-canvas family wearing a
 * milder hat.
 */
export function graphRootMidPopulation({
  liveNodeCount,
  activeWorkflow,
  inSubgraph = false,
  postReconnectWindow = false,
} = {}) {
  if (!postReconnectWindow) return false;
  if (inSubgraph) return false;
  const live = Number(liveNodeCount);
  if (!Number.isFinite(live) || live < 0) return false;
  const expected = activeWorkflowCurrentNodeCount(activeWorkflow);
  if (expected == null || expected <= 0) return false;
  return live < expected;
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
export function graphEmptyBindingUnproven({
  graph,
  rootGraph,
  activeWorkflow,
  activeWorkflowUuid,
  graphLoading = false,
} = {}) {
  if (!!rootGraph && graph && graph !== rootGraph) return false; // subgraph scope
  const live = rootGraph?._nodes;
  if (!Array.isArray(live) || live.length !== 0) return false; // populated or unobservable
  if (!activeWorkflow) return false; // no workflow service — legacy availability
  if (activeWorkflowProvenEmpty(activeWorkflow)) return false; // PROVEN empty — truthful 0
  if (graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid })) return false; // positively bound
  // #833 — both sides provably content-free. The clause above cannot fire on a blank
  // tab (always dirty), which left the ordinary "about to build a workflow" state
  // permanently refused.
  if (emptyCanvasBindingProven({ rootGraph, activeWorkflow, graphLoading })) return false;
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
 * Can a value inside `extra` be GRAPH CONTENT — nodes, links, groups, subgraph
 * definitions, anything whose loss would mean a canvas is not really empty?
 *
 * #833 — the rule used to be "any non-empty value in `extra` defeats the proof",
 * and on a real install that meant NO empty workflow was ever provably empty.
 * Every workflow ComfyUI writes carries `extra.frontendVersion` (a version
 * string), and installed extensions add their own per-workflow settings —
 * `VHS_latentpreview: false`, `workflowRendererVersion`, `workflowHash`. All
 * verified against this repo owner's own `user/default/workflows`. A blank
 * canvas therefore failed `activeWorkflowProvenEmpty`, which is the FIRST escape
 * out of `graphEmptyBindingUnproven`, and the panel fell through to the seal —
 * where a second blank tab makes the exclusivity probe ambiguous, so nothing
 * sealed and every graph tool refused with no way out.
 *
 * THE RULE IS BY TYPE, NOT BY TRUST (codex). The first cut said "a scalar cannot
 * be graph content" and admitted every scalar, present and future, from any
 * extension. That is an accept-all-unknown policy on a fence that also gates root
 * UUID stamping, and it has a real counterexample: an extension may stash a
 * serialized graph as a JSON STRING. So:
 *
 *  - a BOOLEAN or a NUMBER is admitted, because a graph cannot be encoded in one.
 *    That is a property of the type, not a judgement about who wrote it, so it
 *    needs no allowlist and cannot be invalidated by a future extension;
 *  - a STRING must be NAMED. `extra.frontendVersion` and its siblings are the
 *    stamps that made every real workflow unprovable, and they are a short,
 *    knowable list. Anything else stays content until someone establishes
 *    otherwise — a workflow that keeps refusing is recoverable, a canvas stamped
 *    with the wrong identity is not;
 *  - an ARRAY or OBJECT is structured and stays content, which is what keeps
 *    `groupNodes`, `ue_links`, `linkExtensions` and a stashed `reroutes`
 *    defeating the proof exactly as before.
 *
 * This does not weaken the #560 protection it was written for. A tab that is
 * MID-RESTORE has the full graph in its tracker state — that is the restore
 * source — so it fails the `nodes.length !== 0` check above and never reaches
 * this rule. The strictness on version stamps was protecting nothing and costing
 * the empty-canvas case its only exit.
 */
const EXTRA_METADATA_STRING_KEYS = new Set([
  "frontendVersion",
  "workflowRendererVersion",
  "workflowHash",
  "version",
  "revision",
]);

/** Could this text be carrying STRUCTURED data rather than naming or stamping
 *  something? A version, a hash and an extension's setting name are all short and
 *  free of JSON delimiters; a stashed graph is neither. Applied to admitted string
 *  VALUES and to the KEY itself, because a graph can be encoded in an object key
 *  with a boolean value just as easily as in a string value (codex round 2). */
const STRUCTURAL_TEXT_CHARS = ["{", "}", "[", "]"];
const looksStructured = (text) =>
  text.length > 64 || STRUCTURAL_TEXT_CHARS.some((ch) => text.includes(ch));

const extraValueMayBeGraphContent = (key, value) => {
  // The KEY first: a name carrying JSON delimiters is not a setting name, and the
  // value's type says nothing about what the key is smuggling.
  if (typeof key === "string" && looksStructured(key)) return true;
  if (isEmptySurfaceValue(value)) return false;
  if (typeof value === "boolean" || typeof value === "number") return false;
  if (typeof value === "string") {
    // A named stamp still has to LOOK like one. Trusting the key alone would let
    // `frontendVersion: '{"nodes":[…]}'` through on the strength of its name.
    return !EXTRA_METADATA_STRING_KEYS.has(key) || looksStructured(value);
  }
  // Arrays, objects, and anything exotic (bigint, symbol, function) stay content:
  // an unrecognized shape is not evidence of emptiness.
  return true;
};

/**
 * POSITIVE proof that a serialized graph state holds NO workflow content at
 * all — the empty-canvas relaxation's evidence bar (#565 gate). True only
 * when `state` is a well-formed serialized graph whose `nodes` is a PRESENT
 * empty array (a missing/malformed read proves nothing) AND every own
 * surface outside the format-metadata allowlist is absent-or-empty. Inside
 * `extra`, `ds` (viewport) and `comfyui_mcp` (the panel's own identity tag)
 * are not content, and neither is a boolean, a number or a NAMED version stamp
 * (see above, #833); any other key
 * must hold an empty value. A single non-empty subgraphs/groups/reroutes/links
 * surface — or any unknown non-empty STRUCTURED surface — defeats the proof, so
 * a foreign content-bearing canvas can never be re-stamped through the
 * relaxation.
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
        for (const [extraKey, extraValue] of Object.entries(workflowExtra)) {
          if (extraValueMayBeGraphContent(extraKey, extraValue)) return false;
        }
        continue;
      }
      // OUTSIDE `extra` the surfaces are the graph's own (nodes, links, groups,
      // reroutes, subgraphs, definitions), so the strict rule stands: anything
      // non-empty here is content by construction.
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
 * BOTH SIDES PROVABLY CONTENT-FREE — the one thing that can bind an EMPTY canvas
 * (#833).
 *
 * Content cannot identify an empty canvas: every blank canvas serializes alike, so
 * `rootContentProvesActiveWorkflow` has nothing to compare and the seal never fires.
 * And a blank tab is ALWAYS dirty — creating or clearing it is what dirties it — so
 * `activeWorkflowProvenEmpty` short-circuits on `isModified` and can never succeed
 * either. Both proofs are therefore permanently unavailable in exactly the state a
 * user is in right before asking an agent to build a workflow: reads refused as
 * `empty-binding-unproven`, mutations as `dirty-mutation-binding-unproven`, with no
 * recovery that clears it.
 *
 * This is #565's own rule, applied where it was never reached. That gate already
 * re-stamps a MISMATCHED tag when both sides are proven content-free, on the stated
 * grounds that **the #349 fence protects CONTENT** and there is none. The same holds
 * for an UNTAGGED root, and it does not stop holding because the tab is dirty:
 *
 *   - the lag `isModified` guards against (#545) is neutralised by the CONJUNCTION,
 *     not by cleanliness. A lagging tracker's state is merely OLD; if either the
 *     stale snapshot or the live root held content, that side fails its proof and
 *     this returns false. Both sides can only agree on empty when neither has any.
 *   - what cleanliness genuinely proves elsewhere is IDENTITY by content match, and
 *     that is not what is claimed here. Nothing is being matched — the claim is only
 *     that there is no content anywhere to mis-attribute.
 *
 * `graphLoading` is the one case emptiness alone cannot exclude: a canvas mid-load
 * reads genuinely empty at that instant and is about to be populated, which is the
 * FALSE-EMPTY reading the refusal text names. The caller passes ComfyUI's own
 * `ChangeTracker.isLoadingGraph` rather than a proxy for it; unreadable ⇒ pass true
 * and prove nothing.
 *
 * Deliberately NOT weakened to "the root is empty": an empty ROOT with a workflow
 * that reports content is #389, and it must keep failing.
 */
export function emptyCanvasBindingProven({ rootGraph, activeWorkflow, graphLoading = false } = {}) {
  try {
    if (graphLoading === true) return false; // mid-load ⇒ a 0 read may be FALSE-empty
    if (!activeWorkflow) return false; // no workflow service — legacy availability path
    if (!graphRootProvenEmpty(rootGraph)) return false; // the live canvas holds content
    // The workflow's OWN current state, WITHOUT the cleanliness short-circuit — see
    // above for why dirtiness does not weaken a both-sides-empty claim.
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

/**
 * The ONE normalization. `graphShape` (whole-graph equality) and
 * `graphShapeSurfaces` (which surface disagreed) are both derived from this, so
 * the answer to "do these match?" and the answer to "what differs?" can never
 * drift apart — a second, subtly-different comparator is how this family of bugs
 * keeps recurring.
 */
function buildGraphShape(state) {
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
  return shape;
}

const canonicalizeShapeValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeShapeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeShapeValue(value[key])]),
    );
  }
  return value;
};

function graphShape(state) {
  const shape = buildGraphShape(state);
  if (shape == null) return null;
  try {
    return JSON.stringify(canonicalizeShapeValue(shape));
  } catch {
    return null;
  }
}

/**
 * Per-node fields that carry no workflow CONTENT — the ones the ComfyUI frontend
 * is free to rewrite while loading a graph it reproduced faithfully.
 *
 * THE LIST IS BORROWED, NOT INVENTED. `diffGraphsForAgent` — the panel's own
 * user-facing graph diff — already draws this line, and states it: it reports
 * adds, removes, mode, widget values, titles and connections, and "ignores pure
 * moves/resizes/recolors (noise)". This set is exactly that noise, so the two
 * places that decide what counts as a real edit cannot disagree.
 *
 * `size` is the reported case (#825): a node's box is recomputed from live
 * widget/DOM metrics on load, so a workflow saved by one frontend build and
 * loaded by another routinely comes back resized with an identical graph.
 * `order` is LiteGraph's recomputed execution index, not user state.
 *
 * DELIBERATELY ABSENT, each one a way this could have lied (codex):
 *  - `widgets_values` — the difference between two runs. Content.
 *  - `title` — user-editable and persisted by `graph_edit_node`; the panel's own
 *    diff reports a title change as a real edit. A load that reset a custom title
 *    HAS lost something, and must not be waved through as a resize.
 *  - `flags` — not just `collapsed`: `graph_edit_node` persists `pinned` here too.
 *  - `mode` — bypass/mute is execution semantics.
 */
/**
 * Node fields whose difference cannot mean AUTHORED CONTENT WAS LOST (#696).
 *
 * The rule, because a bare list grows by whoever filed last. `cosmeticOnly` licenses
 * exactly one sentence downstream — "every node that was loaded is on it with the
 * same id and type, nothing was lost" — so a field belongs here only when a
 * difference in it is compatible with that sentence being TRUE. Not "does not affect
 * execution": a node `title` does not affect execution either, and a title that
 * changed IS lost authoring, so it stays out.
 *
 * By that test:
 *   size, pos     the frontend re-measures and re-places on load
 *   order         recomputed topologically, never authored directly
 *   color/bgcolor authored, and a difference IS an authoring difference — but not a
 *                 lost node and not a lost widget value, which is all the sentence
 *                 downstream now claims.
 *
 * `showAdvanced` was added here for #696 and then REMOVED again (codex). The
 * argument for it was that a display toggle cannot carry a lost value; the argument
 * against is simply that a boolean IS a value, and this classifier sees every node
 * type there will ever be. A pack can legitimately serialize meaningful state under
 * that name, and nothing here can tell the two apart — a field name is not a
 * contract, and a value-shape guard only re-states the name's promise in another
 * form. #696 is fixed instead by not needing the question answered: see
 * `nodeSetIntact` below, where the reassurance that actually matters rests on the
 * node SET, which is proven, rather than on guessing what a field means.
 *
 * DENYLIST, deliberately, and it must stay one. An unknown field reads as
 * non-cosmetic, so a pack the panel has never seen makes the disclosure cautious —
 * noisy, and safe. Inverting to an allowlist of execution-relevant fields would make
 * every unknown field cosmetic, i.e. the panel would tell a user "nothing was lost"
 * about a surface it has never heard of. That is the fabricated all-clear this whole
 * module exists to avoid, and it is worth more than the noise.
 */
const COSMETIC_NODE_FIELDS = new Set(["size", "pos", "order", "color", "bgcolor"]);


/** The node's identity for set comparison: what makes it THIS node rather than
 *  another one. Type included, because an id reused for a different type is a
 *  different node however the count reads.
 *
 *  JSON-encoded rather than joined on a delimiter, because a join is not
 *  injective (codex): with `id + "|" + type`, `{id:"a|b",type:"c"}` and
 *  `{id:"a",type:"b|c"}` produce the SAME key, and two different nodes reading as
 *  one is precisely the mis-pairing `sameNodeSet` must never make. Any delimiter
 *  has this problem for some input; encoding the boundary removes it. */
function nodeIdentityKey(node) {
  return JSON.stringify([String(node?.id ?? ""), String(node?.type ?? "")]);
}

/**
 * #1618 — fields the ComfyUI frontend recomputes while loading a graph it
 * otherwise reproduced. Restoring them from the payload we asked to load undoes
 * that hydration so a later save does not persist box heights / execution order
 * the user never authored. Color/bgcolor stay out: those are authored, and a
 * difference in them is not a measured rewrite.
 */
const HYDRATED_PRESENTATION_FIELDS = ["size", "order"];

function cloneHydratedPresentationValue(field, value) {
  if (field === "size") {
    if (!Array.isArray(value) || value.length < 2) return undefined;
    const width = Number(value[0]);
    const height = Number(value[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
    return [width, height];
  }
  if (field === "order") {
    const order = Number(value);
    return Number.isFinite(order) ? order : undefined;
  }
  return undefined;
}

function presentationFieldEquals(field, liveValue, savedValue) {
  const saved = cloneHydratedPresentationValue(field, savedValue);
  if (saved === undefined) return false;
  if (field === "size") {
    const live = cloneHydratedPresentationValue("size", liveValue);
    return live !== undefined && live[0] === saved[0] && live[1] === saved[1];
  }
  return Number(liveValue) === saved;
}

function writeHydratedPresentationField(live, field, value) {
  const copy = cloneHydratedPresentationValue(field, value);
  if (copy === undefined) return false;
  if (field === "size") {
    const cur = live.size;
    if (cur && typeof cur === "object") {
      cur[0] = copy[0];
      cur[1] = copy[1];
      return true;
    }
    live.size = copy;
    return true;
  }
  live.order = copy;
  return true;
}

/**
 * Put the saved `size` / `order` back onto live nodes after `loadGraphData`.
 *
 * The frontend recomputes both during configure. Leaving them rewritten marks
 * a clean tab modified and makes the next save persist hydration (#1618).
 * Only nodes with the same id AND type are written; widgets, title, flags and
 * mode are never touched. Missing or unreadable inputs are a no-op.
 *
 * @returns {{ restored: number, skipped: number }}
 */
export function applySavedNodePresentation(liveRoot, savedGraph) {
  const result = { restored: 0, skipped: 0 };
  if (!liveRoot || !savedGraph || typeof savedGraph !== "object") return result;
  const savedNodes = savedGraph.nodes;
  if (!Array.isArray(savedNodes)) return result;
  let liveNodes;
  try {
    liveNodes = liveRoot._nodes ?? liveRoot.nodes;
  } catch {
    return result;
  }
  if (!Array.isArray(liveNodes)) return result;

  const savedByKey = new Map();
  for (const node of savedNodes) {
    if (!node || typeof node !== "object") continue;
    savedByKey.set(nodeIdentityKey(node), node);
  }

  for (const live of liveNodes) {
    if (!live || typeof live !== "object") {
      result.skipped += 1;
      continue;
    }
    const saved = savedByKey.get(nodeIdentityKey(live));
    if (!saved) {
      result.skipped += 1;
      continue;
    }
    let restoredThis = false;
    for (const field of HYDRATED_PRESENTATION_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(saved, field) || saved[field] === undefined) continue;
      if (presentationFieldEquals(field, live[field], saved[field])) continue;
      if (writeHydratedPresentationField(live, field, saved[field])) restoredThis = true;
    }
    if (restoredThis) result.restored += 1;
    else result.skipped += 1;
  }
  return result;
}

/**
 * WHY two node arrays differ — specifically, whether anything was LOST.
 *
 * THE DEFECT THIS ANSWERS (#825). `nodes` is a single surface holding the whole
 * serialized array, so "the graph on the canvas differs from what was loaded on:
 * nodes" is emitted identically for a node that vanished and for a node whose box
 * the frontend re-measured. A reporter read that after a perfectly good open and
 * was pushed toward redoing work that was fine.
 *
 * This does NOT soften the verdict — see `resolveOpenRebindVerdict`, which stays
 * `unknown` either way, deliberately. It makes the DISCLOSURE say which of the two
 * it observed, because they send a reader to opposite places.
 *
 * Returns `{ comparable, sameNodeSet, cosmeticOnly, fields, propertyFields }`:
 *  - `sameNodeSet` — every loaded node is present with the same id AND type, and
 *    no extra ones appeared. Nothing was dropped, added or retyped.
 *  - `cosmeticOnly` — sameNodeSet AND every per-node difference is confined to
 *    COSMETIC_NODE_FIELDS. This is the "the frontend re-measured it" case.
 *  - `fields` — the per-node keys that actually differed, so the disclosure can
 *    name them instead of asking the reader to guess.
 *  - `propertyFields` — when `properties` is one of those fields, the keys INSIDE
 *    it that differed (#886). One field name covers both a pack-version stamp the
 *    frontend rewrote and an extension's stored settings; the disclosure needs
 *    the keys to tell the reader which. Empty when properties matched or its
 *    shape was unreadable — no keys are named rather than guessed at.
 * Anything unreadable is `comparable:false` and asserts nothing.
 */
export function classifyNodeDifference({ expectedNodes, actualNodes } = {}) {
  const NOT_COMPARABLE = { comparable: false, sameNodeSet: false, cosmeticOnly: false, fields: [], propertyFields: [] };
  if (!Array.isArray(expectedNodes) || !Array.isArray(actualNodes)) return NOT_COMPARABLE;
  try {
    const byKey = (list) => {
      const map = new Map();
      for (const node of list) {
        if (!node || typeof node !== "object") return null; // a junk entry makes the set unreadable
        const key = nodeIdentityKey(node);
        if (map.has(key)) return null; // duplicate identity — cannot pair them up honestly
        map.set(key, node);
      }
      return map;
    };
    const expected = byKey(expectedNodes);
    const actual = byKey(actualNodes);
    if (!expected || !actual) return NOT_COMPARABLE;

    if (expected.size !== actual.size) return { ...NOT_COMPARABLE, comparable: true };
    for (const key of expected.keys()) {
      if (!actual.has(key)) return { ...NOT_COMPARABLE, comparable: true };
    }

    // Same set. Now: which per-node keys disagree?
    //
    // PRESENCE IS COMPARED BEFORE VALUE (codex). An earlier cut wrote
    // `canonicalizeShapeValue(v) ?? null`, which made an ABSENT field equal to one
    // explicitly set to `null` — so a node that lost its `widgets_values`
    // (present-as-null on one side, gone on the other) dropped out of `fields`
    // entirely, and a size change alongside it passed the cosmetic gate. A
    // classifier that erases the very field that would have blocked the all-clear
    // is the worst possible failure here.
    //
    // `undefined` IS ABSENT, though — and only `undefined` (#1001). A saved workflow
    // is JSON, and `JSON.stringify` drops a key whose value is `undefined`, so no
    // file can carry one: comparing a live in-memory `serialize()` against a parsed
    // file declares a difference in a form that cannot exist on disk. MEASURED on
    // ComfyUI 0.31.1 / frontend 1.48.7 — every node the frontend instantiates carries
    // `showAdvanced: undefined`, absent from the file, so EVERY open of EVERY saved
    // workflow reported a non-cosmetic per-node difference and the caller was told to
    // go read widget values that had never changed.
    //
    // `null` stays significant, deliberately: JSON carries null, so present-as-null
    // and absent are genuinely different states of a saved file, and collapsing them
    // is the erasure the paragraph above exists to prevent. Spelling this `!= null`
    // would in fact behave identically today — the value comparison below flags
    // absent-vs-null anyway, `"undefined" !== "null"` — so the strict test is chosen
    // for what it MEANS, not because the looser one currently misbehaves. Verified by
    // mutation: swapping it changes no result, which is why no test claims otherwise.
    const has = (node, field) =>
      Object.prototype.hasOwnProperty.call(node, field) && node[field] !== undefined;
    const fields = new Set();
    // #886 — `properties` is one field name standing in for a whole bag of keys, and
    // the difference between a benign one (a pack-version stamp the frontend rewrote)
    // and a real one (an extension's stored settings) is WHICH KEYS moved. The open
    // refusal names the field; name the keys too, so the reader can judge and the
    // report carries the measurement a per-key account would need. Same discipline as
    // the field comparison above: presence before value, `undefined` is absent. Only
    // when BOTH sides are readable objects — anything else names no keys rather than
    // guessing, exactly as an unreadable node set asserts nothing.
    const propertyFields = new Set();
    const readableProps = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

    for (const [key, expectedNode] of expected) {
      const actualNode = actual.get(key);
      const keys = new Set([...Object.keys(expectedNode), ...Object.keys(actualNode)]);
      for (const field of keys) {
        const present = has(expectedNode, field) === has(actualNode, field);
        const a = JSON.stringify(canonicalizeShapeValue(expectedNode[field]));
        const b = JSON.stringify(canonicalizeShapeValue(actualNode[field]));
        if (present && a === b) continue;
        fields.add(field);
        if (field !== "properties") continue;
        const before = expectedNode.properties;
        const after = actualNode.properties;
        if (!readableProps(before) || !readableProps(after)) continue;
        for (const propKey of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (has(before, propKey) !== has(after, propKey)) {
            propertyFields.add(propKey);
            continue;
          }
          const pa = JSON.stringify(canonicalizeShapeValue(before[propKey]));
          const pb = JSON.stringify(canonicalizeShapeValue(after[propKey]));
          if (pa !== pb) propertyFields.add(propKey);
        }
      }
    }
    const list = [...fields].sort();
    return {
      comparable: true,
      sameNodeSet: true,
      cosmeticOnly: list.length > 0 && list.every((field) => COSMETIC_NODE_FIELDS.has(field)),
      fields: list,
      propertyFields: [...propertyFields].sort(),
    };
  } catch {
    return NOT_COMPARABLE;
  }
}

/**
 * WHICH surfaces of a just-loaded state the live root does not reproduce.
 *
 * This exists for the DISCLOSURE only — it names what disagreed so the answer is
 * actionable ("nodes differ" and "groups differ" send a reader to different
 * places). It deliberately decides NOTHING: see the note on
 * `resolveOpenRebindVerdict` for why no classification of a content mismatch is
 * currently trustworthy enough to soften a verdict.
 *
 * `nodeDifference` (#825) is the one refinement, and it refines the SENTENCE, not
 * the verdict: within the `nodes` surface it separates "a node is missing" from
 * "the frontend re-measured the boxes", which the surface name alone cannot.
 *
 * "The panel could not compare" and "the panel compared and they differ" are
 * different answers, and collapsing the first into the second is the defect this
 * whole cluster is about. `comparable:false` means exactly that no comparison
 * happened — it is never evidence of a mismatch.
 */
export function describeGraphStateDifference({ rootGraph, state } = {}) {
  const NOT_COMPARABLE = { comparable: false, surfaces: [], accountedSurfaces: [], nodeDifference: null };
  try {
    const expectedShape = buildGraphShape(state);
    let actualShape = null;
    let actualState = null;
    try {
      actualState = rootGraph?.serialize?.();
      actualShape = buildGraphShape(actualState);
    } catch {
      actualShape = null;
    }
    if (!expectedShape || !actualShape) return NOT_COMPARABLE;
    const canon = (shape) => {
      const out = {};
      for (const key of Object.keys(shape)) out[key] = JSON.stringify(canonicalizeShapeValue(shape[key]));
      return out;
    };
    const expected = canon(expectedShape);
    const actual = canon(actualShape);
    const surfaces = Object.keys(expected).filter((key) => expected[key] !== actual[key]);
    // #1588 — WHICH OF THOSE SURFACES IS ALREADY EXPLAINED.
    //
    // `surfaces` answers "what disagreed". It cannot answer "and is that a difference
    // anyone should act on", and treating the two as the same sentence is what made a
    // faithful open of any workflow containing SUBGRAPHS read as possible data loss:
    // the reporter's message named `nodes, definitions`, and the mere presence of a
    // second surface sent it down the maximal-alarm path.
    //
    // `definitions` is the one surface with a hardened account of WHY it differs.
    // #886 measured it on the rig: loading a persisted workflow regenerates link
    // identity inside `definitions.subgraphs` (`state.lastLinkId` 2092 -> 2106) while
    // node ids, types and topology stay identical. `definitionsDifferOnlyByRenumber`
    // is the predicate `graphRootReproducesStateContent` — the VERDICT — already trusts
    // for exactly this, and it fails CLOSED: anything it cannot fully account for
    // returns false, which is read as "not accounted for", never as "changed".
    //
    // So this reports the SAME judgement the verdict makes, to the sentence that had no
    // access to it. It decides nothing new; it stops the disclosure from being blind to
    // a difference the verdict has already characterised.
    //
    // comfyui-mcp#1706 — the SECOND rewrite on the same surface, and the reason the
    // predicate now takes the ROOT nodes. The frontend also renumbers subgraph NODE ids
    // on load (`deduplicateSubgraphNodeIds`, measured on 1.48.7: definition node ids
    // 78/77/76 came back 182/183/184 with the definition's links patched through the
    // same map and `state.lastNodeId` 196 -> 214, root `nodes` unchanged). A definition
    // node id is also referenced from OUTSIDE `definitions` — a root node's
    // `properties.proxyWidgets` names the definition node a promoted widget comes from —
    // so the payload's root nodes are the evidence that admits or refuses that account.
    const accountedSurfaces = surfaces.filter(
      (key) =>
        key === "definitions" &&
        definitionsDifferOnlyByRenumber(state?.definitions, actualState?.definitions, {
          rootNodes: state?.nodes,
        }),
    );
    return {
      comparable: true,
      surfaces,
      accountedSurfaces,
      // Only when `nodes` is one of the disagreeing surfaces: otherwise there is
      // nothing about the nodes to explain, and an all-clear here would read as
      // one about the difference that actually fired.
      nodeDifference: surfaces.includes("nodes")
        ? classifyNodeDifference({ expectedNodes: state?.nodes, actualNodes: actualState?.nodes })
        : null,
    };
  } catch {
    return NOT_COMPARABLE;
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
 * Per-node fields the ComfyUI frontend RECOMPUTES while loading a graph it
 * reproduced faithfully.
 *
 * Deliberately NARROWER than `COSMETIC_NODE_FIELDS`. That set answers "may I
 * reassure the reader", and it includes `color`/`bgcolor` because the sentence it
 * feeds names the fields. THIS set answers "may the panel call the content
 * PROVEN", and a lost `color` is a lost authored value — it must be able to hold
 * the proof back even though it is cosmetic to look at.
 *
 * ONLY FIELDS THAT WERE MEASURED, and each one carries its own check below —
 * membership here is necessary, never sufficient. An earlier cut also listed
 * `pos` and `order`, on the reasoning that they are layout too. Neither was
 * observed being rewritten by anything, `pos` is authored by the user dragging a
 * node, and `order` is execution-order state in a LiteGraph-derived graph —
 * proving content across a changed `order` would publish a fence for a graph
 * whose observable behaviour changed (codex). Both remain OUT.
 *
 *   `size`   — the live install rewrote node HEIGHT on every open of every saved
 *              workflow. Admitted only when the difference is height-only.
 *   `inputs` — #1467. MEASURED in comfyui_frontend_package 1.48.7:
 *              `ComfyNode.prototype.configure` GENERATES the live array from the
 *              node definition (definition order, with `name`/`type`/`shape`/
 *              `localized_name`/`widget` overlaid from it, unknown saved slots
 *              appended), so a faithful open cannot round-trip what was saved.
 *              Admitted only when every difference fits that rebuild.
 *
 * `properties` is deliberately absent even though #1608 characterised a rewrite
 * inside it. The field is a bag: membership here would admit ANY key that moved
 * on the strength of evidence about `randomMin`/`randomMax`. Those two keys are
 * filtered out below, the same way a height-only `size` is admitted by its own
 * check rather than by the field name. `geometry_rewritten`'s note asserts a
 * height-only rewrite, so a properties-only proof must not land in that list.
 *
 * `widgets_values` is deliberately absent despite ALSO being rewritten on every
 * load (`migrateWidgetsValues`): it is the field a genuine partial load drops,
 * which is what #1111/#1089 are about, so admitting it would gut this guard.
 *
 * The rule stands: this grows only when a measurement says it must, and the
 * measurement has to characterise the rewrite well enough to write its check.
 */
const RECOMPUTED_NODE_FIELDS = new Set(["size", "inputs"]);

/**
 * Did the live root reproduce this state's CONTENT — allowing for the geometry the
 * frontend measures for itself?
 *
 * THE DEFECT THIS ANSWERS (#1001). `workflow_open` proved its content with
 * `graphRootMatchesState`, a byte-shape equality over the whole serialized node
 * array. MEASURED on ComfyUI 0.31.1 / frontend 1.48.7, opening a saved workflow
 * from the user's own library: the frontend re-measured node boxes on load
 * (`SaveVideo` 358 -> 126 high), so the shapes differed and the open reported
 * CONTENT_UNVERIFIED — on a load that was perfect. That verdict throws, and a
 * throwing open never reaches the line that publishes `workflow_uuid`, so the
 * caller's fence stayed stale and the NEXT command was refused as a workflow
 * instance mismatch. The reporter needed four calls to reach a state the panel
 * already believed it was in.
 *
 * The difference is not a race — sampled at 0ms, one frame, 50ms, 250ms, 1s and 2s
 * after the load resolved, it was identical every time. It is deterministic, and it
 * applies to any workflow whose stored sizes are not what this frontend computes.
 *
 * Returns `{ proven, exact, fields }`. `exact` distinguishes a byte-identical
 * repaint from one where geometry was rewritten, so a caller can DISCLOSE the
 * difference instead of the panel quietly deciding it did not happen.
 */
/**
 * Every node whose `size` differs differs ONLY in height, and both sides are a readable
 * `[width, height]` pair.
 *
 * The measurement behind the whole exemption is a recomputed BOX HEIGHT. Width is not
 * something the frontend was observed rewriting, so a width change is not covered by
 * the evidence and must not ride in on the field's name (codex r2). Anything
 * unreadable — a non-pair, a non-finite number, an unpairable node — answers false,
 * because a proof cannot rest on a value nobody could read.
 */
function sizeDifferenceIsHeightOnly(expectedNodes, actualNodes) {
  try {
    if (!Array.isArray(expectedNodes) || !Array.isArray(actualNodes)) return false;
    // STRICTLY numbers. `Number.isFinite(Number(n))` would accept `null` (Number(null)
    // is 0) and a numeric string — and a JSON round-trip turns NaN into null, so a
    // height that arrived unreadable would have passed as a readable zero.
    const readable = (size) =>
      Array.isArray(size) && size.length === 2 && size.every((n) => typeof n === "number" && Number.isFinite(n));
    const actualByKey = new Map();
    for (const node of actualNodes) {
      if (!node || typeof node !== "object") return false;
      actualByKey.set(nodeIdentityKey(node), node);
    }
    for (const expectedNode of expectedNodes) {
      if (!expectedNode || typeof expectedNode !== "object") return false;
      const actualNode = actualByKey.get(nodeIdentityKey(expectedNode));
      if (!actualNode) return false;
      const before = expectedNode.size;
      const after = actualNode.size;
      if (JSON.stringify(canonicalizeShapeValue(before)) === JSON.stringify(canonicalizeShapeValue(after))) continue;
      if (!readable(before) || !readable(after)) return false;
      if (Number(before[0]) !== Number(after[0])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the whole difference confined to PRESENTATION — i.e. can nothing AUTHORED have
 * been lost? (#1623)
 *
 * THE DEFECT THIS ANSWERS. `workflow_open`'s pass/fail is taken from
 * `graphRootReproducesStateContent`, whose `RECOMPUTED_NODE_FIELDS` answers a
 * different question — "is this difference explained by a rewrite this panel has
 * MEASURED" — and holds only `size` (height-only) and `inputs`. The DISCLOSURE asks
 * the question the caller acts on, `cosmeticOnly`, and on the very same observation
 * answers "you are on the right workflow and there is no missing work to redo".
 *
 * A reporter got exactly that sentence with the call reported as an ERROR, on two
 * consecutive workflow switches, and went and re-read a graph that was already
 * correct (#1623). One reply cannot say both things. So the sentence's own predicate
 * is promoted to a shared function, and the VERDICT is taken from it too: two lists
 * that agreed by accident and then stopped is what produced the contradiction.
 *
 * WHY THIS IS SAFE, against the reason `content` blocks success at all.
 * `resolveOpenRebindVerdict` records the mechanism: `loadGraphData` catches a
 * `configure()` throw and returns, leaving the complete node id/type set, the links
 * and the panel's marker over nodes that silently LOST their widget values and
 * properties — byte-identical to "the loader normalized the values", with no
 * discriminator to separate them. That failure cannot present HERE.
 * `widgets_values`, `properties`, `title`, `flags`, `mode`, `inputs` and `outputs`
 * are every one of them OUTSIDE `COSMETIC_NODE_FIELDS`, and `configure()` writes
 * them in the same pass as the cosmetic five — so a load that died mid-configure
 * answers false on the first node it reached. One discriminator that comment once said
 * did not exist is WHICH FIELDS DIFFER, and the panel already computes it. (The other,
 * an observation of the load itself, is `openContentDifferenceIsCompletedLoadNormalization`
 * below.)
 *
 * It is deliberately NOT a widening of `RECOMPUTED_NODE_FIELDS`. That set licenses
 * "the content was reproduced", which is why it demands a characterised rewrite per
 * field; this one licenses only "nothing authored was lost", which is the weaker
 * claim the open's pass/fail actually turns on. `widgets_values` stays outside BOTH,
 * so the guard #1111 and #1089 exist for is untouched: a widget value that differs
 * still fails the open, however plausibly a frontend might have normalized it.
 */
export function openContentDifferenceIsPresentationOnly({ comparable, surfaces, nodeDifference } = {}) {
  // Never inferred from an absent comparison — `comparable:false` means no comparison
  // happened, which is not evidence in either direction.
  if (comparable !== true) return false;
  const unique = Array.isArray(surfaces) ? [...new Set(surfaces)] : [];
  // `nodes`, and NOTHING else. A group, a link, a reroute or a definitions difference
  // is unexplained by anything a node comparison establishes — #825's own rule, kept.
  if (unique.length !== 1 || unique[0] !== "nodes") return false;
  // THESE TWO OVERLAP for anything `classifyNodeDifference` produces — it computes
  // `fields` only once the sets match, so its `cosmeticOnly:true` already implies
  // `sameNodeSet:true`, and deleting the set check kills no test off that classifier
  // alone (measured: the mutation survived until a test was written for it). Both are
  // kept because they answer different questions — "is this the same graph" and "can
  // the panel name what moved" — and this predicate is EXPORTED, so it must refuse an
  // inconsistent shape rather than let a set difference through on a field list.
  return (
    nodeDifference?.comparable === true &&
    nodeDifference.sameNodeSet === true &&
    // `cosmeticOnly` is itself false for an EMPTY field list, so this cannot pass on a
    // `nodes` surface nobody could name a difference in.
    nodeDifference.cosmeticOnly === true
  );
}

/**
 * #1477 — the live root differs from what was loaded ONLY on `definitions`.
 *
 * Binding (instance, marker, identity) is a separate question, already proven by
 * the time this is asked. A previous-workflow graph (#1111/#1089) disagrees on
 * `nodes` / `links` / `groups`, not on this surface alone. So a definitions-only
 * mismatch is a frontend id rewrite (or an unaccounted cousin of one), not a
 * wrong canvas, and it must not leave the session fenced to the prior workflow.
 *
 * It does NOT claim the subgraph internals are the file's. Callers disclose.
 */
export function openContentDifferenceIsDefinitionsOnly({ comparable, surfaces } = {}) {
  if (comparable !== true) return false;
  const unique = Array.isArray(surfaces) ? [...new Set(surfaces)] : [];
  return unique.length === 1 && unique[0] === "definitions";
}

/**
 * Did this open apply COMPLETELY, leaving only per-node fields the frontend rewrote?
 * (panel#1283 / #1285 / #1307 / #1330, comfyui-mcp#1705)
 *
 * ## The defect this answers
 *
 * Five reporters got `isError` on an open the same reply describes as correct: the
 * canvas bound, every node present with the same id and type, nothing extra — and a
 * per-node difference in `widgets_values`, `outputs`, `properties` or
 * `widgets_values_named`. None of those is on `COSMETIC_NODE_FIELDS`, so #1623's
 * presentation-only ground does not reach them, and none has a per-field rewrite
 * account, so `RECOMPUTED_NODE_FIELDS` does not either.
 *
 * The two existing grounds are both FIELD-LEVEL: they ask "is a difference in THIS
 * NAME benign". That question cannot be answered for `widgets_values` — it is the
 * field a genuine partial load drops, which is what #1111/#1089 are about — and
 * chasing it field by field just moves the refusal to the next field a pack invents.
 * `outputs` would be the sixth such entry; `widgets_values_named` the seventh.
 *
 * ## So this asks a different question, at a different level
 *
 * `resolveOpenRebindVerdict` states exactly one mechanism for why a content
 * difference might mean data loss: `loadGraphData` catches a mid-`configure()` throw
 * and returns, leaving the node id/type set and the marker over nodes that lost their
 * values. Before panel#1283/#1358 it added that no discriminator separates that from
 * normalization; that sentence is gone from it now and points back here instead.
 *
 * There is one, and the panel already owns half of it. `installNodeConfigureIsolation`
 * (#1260) records every per-node `configure` throw; `installGraphConfigureWatch`
 * records a throw out of the graph restore itself. MEASURED against the frontend
 * source: those two are the ONLY places the restore can abort — `LGraph.configure`
 * runs the node pass with no try/catch of its own, and nothing between it and
 * `loadGraphData`'s catch adds one. So `loadRanToCompletion === true` REFUTES the
 * hypothesis the refusal rests on, for this load, by observation.
 *
 * ## What it therefore may and may not claim
 *
 * It licenses "the load did not stop early, so nothing was dropped by a failed
 * restore". It does NOT license "these values are the file's values" — the caller is
 * told which fields differ and that a widget value is content. That is why the reply
 * this feeds carries `content_normalized` with the field names rather than silence.
 *
 * Everything else still refuses, and deliberately:
 *  - `loadRanToCompletion !== true` — a throw was recorded, OR the frontend could not
 *    be instrumented at all. Unknown is not a yes: the strict `=== true` is what keeps
 *    an un-watched load on the old, refusing path.
 *  - any surface but `nodes` — a lost link, group, reroute or unaccounted definitions
 *    block is not explained by anything a completed node pass establishes.
 *  - a changed node SET — a missing, extra or retyped node is the shape real loss
 *    takes, and a completed restore does not produce it.
 *  - an unnamed difference — `fields` empty means the classifier could not point at
 *    what moved, and proving an open off a difference nobody can name is the
 *    fabricated all-clear this module exists to avoid.
 */
export function openContentDifferenceIsCompletedLoadNormalization({
  comparable,
  surfaces,
  nodeDifference,
  loadRanToCompletion,
} = {}) {
  // STRICTLY true. `null` is "nobody watched" and `false` is "something threw"; both
  // must refuse, and collapsing either into a truthiness test is the same two-states-
  // one-answer fold this predicate exists to undo.
  if (loadRanToCompletion !== true) return false;
  if (comparable !== true) return false;
  const unique = Array.isArray(surfaces) ? [...new Set(surfaces)] : [];
  if (unique.length !== 1 || unique[0] !== "nodes") return false;
  if (nodeDifference?.comparable !== true || nodeDifference.sameNodeSet !== true) return false;
  return Array.isArray(nodeDifference.fields) && nodeDifference.fields.length > 0;
}

export function graphRootReproducesStateContent({ rootGraph, state, loadRanToCompletion } = {}) {
  const NOT_PROVEN = {
    proven: false,
    exact: false,
    fields: [],
    presentationOnly: false,
    normalizedOnly: false,
    normalizedFields: [],
    definitionsNormalized: false,
  };
  try {
    // ONE SNAPSHOT, and every check below reads it (codex r3). Serializing separately
    // per check let a synchronous serialization hook — a broken or hostile custom node —
    // show a height-only difference to the classifier and then alter a widget before the
    // size check re-serialized, so a fence would be published for content no comparison
    // ever saw. A single snapshot cannot disagree with itself.
    const actualState = rootGraph?.serialize?.();
    if (actualState == null) return NOT_PROVEN;
    const frozen = { serialize: () => actualState };
    if (graphRootMatchesState({ rootGraph: frozen, state })) {
      return {
        proven: true,
        exact: true,
        fields: [],
        presentationOnly: false,
        normalizedOnly: false,
        normalizedFields: [],
        definitionsNormalized: false,
      };
    }
    const diff = describeGraphStateDifference({ rootGraph: frozen, state });
    // Never inferred from an absent comparison: `comparable:false` means no
    // comparison happened, which is not evidence either way.
    if (diff?.comparable !== true) return NOT_PROVEN;
    // panel#1283 family — the surfaces still UNEXPLAINED, which is what #1588's second
    // round established the reassurance's own predicate must read. `definitions` differs
    // on every open of a workflow containing subgraphs (#886: link ids are regenerated),
    // and `describeGraphStateDifference` has already run the SAME fail-closed predicate
    // the strict proof below trusts to decide whether THIS difference is only that. A
    // surface that predicate accounted for is not a second unexplained difference, and
    // comfyui-mcp#1705 is precisely the shape that fails on it: `nodes, definitions`.
    //
    // #1477 — computed BEFORE presentationOnly so that ground can read the same list.
    // Passing the RAW surfaces made a cosmetic-only node rewrite plus an accounted
    // `definitions` difference fail presentation-only (unique length 2), so a faithful
    // tab-switch onto a subgraph workflow still refused as root-workflow-uuid-mismatch.
    const accounted = Array.isArray(diff.accountedSurfaces) ? diff.accountedSurfaces : [];
    const unexplainedSurfaces = (Array.isArray(diff.surfaces) ? diff.surfaces : []).filter(
      (s) => !accounted.includes(s),
    );
    // #1623 — the WEAKER question ("could anything authored have been lost"), asked
    // off THE SAME SNAPSHOT the strict proof below reads. Answering it from a second
    // serialization would reopen exactly the hole the frozen snapshot closes: a
    // synchronous serialization hook could show a cosmetic-only difference here and a
    // changed widget to the proof, and the open would be reported applied on content
    // no single comparison ever saw.
    //
    // Every refusal BELOW this line is a refusal of the strict proof only, so each one
    // carries this answer out rather than discarding it — the reporter's own case
    // (`pos`/`order`, and a `size` whose WIDTH moved) is refused by the strict proof
    // and is presentation-only, and returning the shared `NOT_PROVEN` there is what
    // would have left the fix wired into a branch its own bug report cannot reach.
    //
    // panel#1283 family — AND NOT WHEN A RESTORE FAILURE WAS RECORDED. This is a hole the
    // observation OPENS if it is only ever used to say yes, and it is worth spelling out.
    // Before it, `workflow_open` did not contain a per-node `configure` throw, so a node
    // that threw aborted the whole restore and the links and groups never landed — which
    // this predicate refuses on the surface list. With the throw contained, the rest of
    // the graph restores and the throwing node sits at CONSTRUCTION DEFAULTS, including
    // `pos: [10, 10]` — and `pos` IS cosmetic. A node whose saved state differed from its
    // defaults only in position would then be waved through as "nothing authored was lost"
    // while the user's layout for it was in fact lost.
    //
    // So a recorded throw vetoes the weaker ground. `proven` is deliberately NOT vetoed:
    // byte equality with the payload means nothing was lost whatever threw. And this is
    // `=== false`, so a caller that passes nothing (every caller but the open) behaves
    // exactly as before.
    const presentationOnly =
      loadRanToCompletion !== false &&
      openContentDifferenceIsPresentationOnly({
        comparable: true,
        surfaces: unexplainedSurfaces,
        nodeDifference: diff.nodeDifference,
      });
    // The load RAN TO COMPLETION, so the mid-`configure()` partial load the strict
    // refusal rests on did not happen here. Weaker than `presentationOnly` about the
    // fields (it names them rather than vouching for them) and stronger about the LOAD
    // (it is an observation of this restore, not a judgement about a field name).
    //
    // panel#1283 (the 2026-08-21 recurrence) — AND THE SAME GROUND ONE LEVEL DOWN.
    //
    // `definitions` is subtracted from `unexplainedSurfaces` above only by
    // `definitionsDifferOnlyByRenumber`, which is FIELD-LEVEL: it enumerates what a
    // renumbering may touch and requires every other field to be deep-equal. Measured in
    // a real browser on v0.15.32 / ComfyUI 0.33.2 / frontend 1.49.6, an installed pack
    // stamps a key into every node's `properties` during `configure`. On the ROOT nodes
    // that is already accounted for — by the completed-load ground immediately below,
    // which admits any NAMED per-node difference once the panel has watched the restore
    // run to completion. The identical rewrite, on the same nodes, inside a subgraph
    // definition had no account at all, so a faithful open of any subgraph workflow on
    // that machine was refused on `nodes, definitions`, published no `workflow_uuid`, and
    // sent the caller through the multi-call recovery this whole cluster is about.
    //
    // So the completed-load ground reads the surface list with that account applied too.
    // Deliberately NOT applied to `presentationOnly`: that ground claims "nothing
    // AUTHORED was lost", and this admits an arbitrary per-node field inside a definition
    // — a claim only the weaker, observation-licensed ground may make.
    const definitionsNormalized =
      unexplainedSurfaces.includes("definitions") &&
      definitionsDifferOnlyByCompletedLoadNormalization(state?.definitions, actualState?.definitions, {
        loadRanToCompletion,
      });
    const normalizedOnly = openContentDifferenceIsCompletedLoadNormalization({
      comparable: true,
      surfaces: definitionsNormalized
        ? unexplainedSurfaces.filter((surface) => surface !== "definitions")
        : unexplainedSurfaces,
      nodeDifference: diff.nodeDifference,
      loadRanToCompletion,
    });
    const notProven = {
      proven: false,
      exact: false,
      // NAMED, so the reply can tell the caller which fields moved instead of asking
      // them to guess — the same contract `geometry_rewritten` already has. Empty
      // unless presentation-only, because on any other refusal these fields describe a
      // difference nobody has accounted for.
      fields: presentationOnly && Array.isArray(diff.nodeDifference?.fields) ? diff.nodeDifference.fields : [],
      presentationOnly,
      normalizedOnly,
      // Carried on EVERY refusal below, for the same reason `presentationOnly` is: the
      // reporters' own cases (`widgets_values`, `outputs`, `properties`) are refused by
      // the strict proof, so a fix that only populated this on the success path would be
      // wired into a branch its own bug reports cannot reach.
      normalizedFields: normalizedOnly && Array.isArray(diff.nodeDifference?.fields) ? diff.nodeDifference.fields : [],
      // Only when it actually CARRIED the verdict. The caller turns this into the
      // `definitions_unverified` disclosure, and a reply may not announce a subgraph
      // difference the verdict never rested on — this is an account that was USED, not
      // one that would have applied had some other refusal not fired first.
      definitionsNormalized: normalizedOnly && definitionsNormalized,
    };
    const surfaces = Array.isArray(diff.surfaces) ? diff.surfaces : [];
    // ONE surface, and it must be `nodes`. A group or a link that disagrees is
    // unexplained by anything the node comparison establishes.
    // #886 — a `definitions` surface may accompany `nodes`, but ONLY when the whole
    // of it is link renumbering. Measured: the frontend regenerates link identity
    // inside subgraph definitions on load (state.lastLinkId advanced 2092 -> 2106 on
    // a real 4-subgraph workflow) while node ids, types and topology stay identical.
    // Before this, a faithful open of ANY workflow containing subgraphs reported
    // CONTENT_UNVERIFIED — binding proven, nodes perfect, refused on a surface nobody
    // had characterised.
    //
    // Everything else still refuses. `definitionsDifferOnlyByRenumber` returns
    // false for anything it cannot fully account for, and the caller reads that as
    // "not proven" — never as "changed".
    // The surface set must be a subset of { nodes, definitions } — nothing else is
    // accounted for, and an unaccounted surface refuses.
    //
    // `definitions` is admitted ONLY when the difference there is pure link
    // renumbering, which is what loading a persisted workflow does to
    // definitions.subgraphs (measured: state.lastLinkId 2092 -> 2106).
    //
    // `nodes` is NOT required to be present. The earlier version demanded it, which
    // review caught: the reported #886 case is a graph where definitions is the ONLY
    // differing surface, so requiring `nodes` refused exactly the case this exists to
    // prove — a fix wired into a branch its own bug report cannot reach.
    const unique = [...new Set(surfaces)];
    if (!unique.length) return notProven;
    if (unique.some((s) => s !== "nodes" && s !== "definitions")) return notProven;
    if (unique.includes("definitions")) {
      // comfyui-mcp#1706 — `state?.nodes` is not decoration here. The node-id
      // relabeling is admitted only against the PAYLOAD's root nodes, because a root
      // node's `properties.proxyWidgets` references a definition node BY ID: when the
      // relabeling touches one of those, the frontend's own `patchProxyWidgets` runs
      // over `rootNodes` too and the promoted widget's value did not survive (measured).
      // Without this argument the predicate answers the pre-#1706 question, so removing
      // it silently un-ships the fix.
      if (
        !definitionsDifferOnlyByRenumber(state?.definitions, actualState?.definitions, {
          rootNodes: state?.nodes,
        })
      ) {
        return notProven;
      }
    }
    // A definitions-only difference is fully accounted for once the renumber check
    // passes: there is no node difference to classify.
    if (!unique.includes("nodes")) {
      return {
        proven: true,
        exact: false,
        fields: [],
        presentationOnly: false,
        normalizedOnly: false,
        normalizedFields: [],
        definitionsNormalized: false,
      };
    }
    const nodes = diff.nodeDifference;
    // THE NEXT TWO CHECKS DELIBERATELY OVERLAP, and neither can be killed alone by
    // mutation: `classifyNodeDifference` only computes `fields` once the sets match, so
    // a changed set arrives here as `sameNodeSet:false` with an EMPTY field list and
    // either check refuses it. Removing BOTH does fail the suite. They are kept as two
    // because they answer different questions — "is this the same graph" and "can the
    // panel name what moved" — and a later change to one classifier must not silently
    // remove the other's guarantee.
    if (nodes?.comparable !== true || nodes.sameNodeSet !== true) return notProven;
    const fields = Array.isArray(nodes.fields) ? nodes.fields : [];
    // WIDTH IS NOT MEASURED (codex r2). The evidence is a recomputed HEIGHT, and a
    // field-name allowlist admits any rewrite of the whole `[w, h]` pair — so a changed
    // width, or an arbitrary replacement, would have been PROVEN on the strength of a
    // measurement about something else. Every differing size must be height-only.
    if (fields.includes("size") && !sizeDifferenceIsHeightOnly(state?.nodes, actualState?.nodes)) {
      return notProven;
    }
    // #1467 — `inputs` is REBUILT by the frontend, not restored, and admitting it
    // needs the same treatment `size` gets: characterise the rewrite and require
    // every difference to fit it, rather than allowlisting the field name and
    // waving through any change that lands in it.
    //
    // MEASURED (comfyui_frontend_package 1.48.7, ComfyNode.prototype.configure,
    // which runs before LiteGraph's): the live array is generated by walking the
    // node DEFINITION, overlaying `name`/`type`/`shape`/`localized_name`/`widget`
    // from it, and appending saved slots the definition does not know. So its
    // order is the definition's and five of its keys come from the definition on
    // every load — a faithful open cannot reproduce the saved array.
    //
    // `nodeInputsDifferOnlyByDefinitionRebuild` returns false for anything that
    // rewrite does not explain — a slot name appearing or vanishing, a changed
    // `link`, any other key that moved — and false reads as NOT PROVEN here,
    // never as "changed".
    if (
      fields.includes("inputs") &&
      !nodeInputsDifferOnlyByDefinitionRebuild(state?.nodes, actualState?.nodes)
    ) {
      return notProven;
    }
    // #1608 — `properties` is a bag, and the characterised rewrite is two keys
    // inside it (`randomMin`/`randomMax`), not the field. A field-name allowlist
    // would admit a pack-version stamp on the strength of evidence about Seed
    // range bounds. The check refuses any other key; when it passes, drop
    // `properties` from the remaining list so it cannot ride into
    // `geometry_rewritten` (that note asserts a height-only rewrite).
    let remaining = fields;
    if (fields.includes("properties")) {
      if (!nodePropertiesDifferOnlyByRandomRangeNormalization(state?.nodes, actualState?.nodes)) {
        return notProven;
      }
      remaining = fields.filter((field) => field !== "properties");
    }
    // An empty field list with a differing `nodes` surface means the two disagreed
    // somewhere this classifier could not name — proving content off a difference
    // nobody can point at is exactly the fabricated all-clear to avoid.
    // An empty REMAINING list after the properties account is the opposite: the
    // difference was named (`properties`) and fully characterised, same shape as
    // a definitions-only renumber (proven, not exact, nothing to disclose as
    // geometry).
    if (!remaining.length) {
      if (!fields.length) return notProven;
      return {
        proven: true,
        exact: false,
        fields: [],
        presentationOnly: false,
        normalizedOnly: false,
        normalizedFields: [],
        definitionsNormalized: false,
      };
    }
    if (!remaining.every((field) => RECOMPUTED_NODE_FIELDS.has(field))) return notProven;
    return {
      proven: true,
      exact: false,
      fields: remaining,
      presentationOnly: false,
      normalizedOnly: false,
      normalizedFields: [],
      definitionsNormalized: false,
    };
  } catch {
    return NOT_PROVEN;
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
  // #1477 — a definitions-only (or presentation-only) rewrite is THIS workflow's
  // canvas, not a different graph. Byte-shape treats regenerated subgraph ids as
  // a mismatch, so after the tab-switch rebind restamped the tag the shape guard
  // still refused panel_graph_outline. Same proof the rebind already asked.
  if (graphRootAgreesWithActiveState(rootGraph, activeState)) return false;
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
 * The STRUCTURE of a serialized graph — everything that says WHICH workflow a
 * canvas holds — with the per-node content that can legitimately drift on a
 * correctly-bound canvas removed.
 *
 * Derived from `buildGraphShape` so it can never disagree with the full
 * comparison about what a surface even IS (the one-normalization rule above);
 * the ONLY difference is that each node collapses to its `id` and `type`. Every
 * non-node surface — links, floating links, reroutes, groups, config, top-level
 * subgraphs, definitions, extra — is compared in FULL, unchanged, because those
 * are where a genuinely different workflow shows itself.
 *
 * `null` when no structural read is possible (no serialized state, or any node
 * without a usable id/type): callers must treat that as NOT a match, never as
 * one — "could not compare" is not "compared and equal".
 */
function buildGraphStructureShape(state) {
  const shape = buildGraphShape(state);
  if (shape == null) return null;
  const nodes = [];
  for (const node of shape.nodes) {
    const id = node?.id;
    const type = node?.type;
    if ((typeof id !== "string" && typeof id !== "number") || typeof type !== "string") return null;
    // Type-qualified, exactly like the legacy id:type fallback: numeric 1 and
    // string "1" are different ids and must not collide.
    nodes.push({ id: `${typeof id}:${id}`, type });
  }
  return { ...shape, nodes };
}

function graphStructureShape(state) {
  const shape = buildGraphStructureShape(state);
  if (shape == null) return null;
  try {
    return JSON.stringify(canonicalizeShapeValue(shape));
  } catch {
    return null;
  }
}

/**
 * #696/#663/#701/#702 — the live root differs from the active workflow's own
 * current state ONLY in per-node mutable content, on a canvas that POSITIVELY
 * carries this workflow's identity. That is drift on the RIGHT canvas, not
 * evidence of a different one, and it must not refuse a graph command.
 *
 * WHY the plain content comparison is the wrong evidence. `graphRootMismatches-
 * ActiveWorkflow` reads a difference between `rootGraph.serialize()` and
 * ChangeTracker's `activeState` as "bound to a different graph". That inference
 * needs `activeState` to be a faithful mirror of the live root whenever the tab
 * is clean — and it is not. ComfyUI's ChangeTracker captures on USER INPUT
 * events (see the panel's post-command `deferChangeTrackerSnapshot` wiring, which
 * exists precisely because bridge-driven edits are otherwise invisible to it), so
 * a widget a NODE rewrites without user input drifts the root while the tab still
 * reports `isModified: false`: Impact-Pack's ImpactWildcardEncode re-resolving
 * `populated_text` on every execution, `control_after_generate` advancing a seed,
 * an rgthree mode toggle, any extension's `loadedGraphNode` hook. Every reported
 * instance of this cluster carried the RIGHT node count on the RIGHT tab.
 *
 * It is self-reinforcing, which is what made "the remedy does not remedy" (#701):
 * the tracker is re-captured only after a command SUCCEEDS, and `workflow_open`'s
 * repaint re-runs the same hook that rewrote the widget, so its own content proof
 * fails, its tracker re-baseline is skipped, and the retried read fails
 * identically. Only a page reload broke the loop.
 *
 * The relaxation is deliberately NARROW, and both conjuncts are load-bearing:
 *
 *   IDENTITY — `graphRootWorkflowUuidMatches`. Structural equality alone cannot
 *     tell the active tab's canvas from a DUPLICATE tab's: two copies of one
 *     workflow are structurally identical and differ only in widget values, which
 *     is exactly the difference this would wave through. The same exclusivity
 *     problem already blocks `sealProvenRootBinding`, and the answer is the same
 *     one — require the canvas to positively claim THIS workflow. An untagged
 *     root is absence of proof and stays refused; a foreign tag is the #349
 *     wrong-canvas case and is refused earlier still.
 *
 *   STRUCTURE — every surface that identifies a workflow must be EQUAL, read
 *     through the shared normalization. A different node set, a different id or
 *     type, different links, groups, reroutes, floating links, top-level
 *     subgraphs, definitions or content-bearing extra all remain refusals, so
 *     #349 is untouched. A count-short mid-restore canvas (#618) differs in its
 *     node set and cannot reach this at all.
 *
 * An unreadable structural comparison on EITHER side returns false: the relaxation
 * only ever fires on a positive, completed match.
 *
 * KNOWN, DELIBERATE GAPS — both pre-existing, neither opened here:
 *
 *   drift INSIDE a `subgraphs`/`definitions` payload still refuses, because that
 *   surface is compared whole. Narrowing it would mean recursing a nested
 *   serializer dialect, and the fail-closed direction is the right one to leave
 *   standing.
 *
 *   a BYTE-IDENTICAL duplicate whose canvas got the active workflow's tag, and
 *   this one IS widened here — stated plainly rather than argued away (codex
 *   gate, two rounds). The only writer that can put A's tag on a root without A's
 *   own claim is `sealProvenRootBinding`, and it fires only on an UNTAGGED root
 *   that already serializes EQUAL to A's current state with no other OPEN
 *   workflow matching it — which a CLOSED duplicate's stranded canvas can satisfy,
 *   since the exclusivity sweep can only see open tabs (its own comment says so).
 *   From the seal onward that canvas is content-equal to A, so reads AND
 *   mutations alike were already permitted on it; what the old shape guard added
 *   was that the permission ENDED whenever the stranded canvas happened to drift.
 *   This removes that late stop. It is accepted knowingly: the stop was
 *   timing-dependent (it arrived only after arbitrary work had already landed on
 *   that same canvas), the ambiguity it half-covered is `proofExclusive`'s
 *   documented limit, and in the one construction that reaches it the stranded
 *   root is also the object the active workflow would itself serialize on save.
 *   Buying back that fraction of a case by refusing the four reported ones — the
 *   right canvas, permanently locked, with no working remedy — is the worse trade.
 */
export function graphRootContentDriftOnBoundCanvas({
  rootGraph,
  activeWorkflow,
  activeWorkflowUuid,
} = {}) {
  if (!graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid })) return false;
  return graphRootStructureMatchesActiveWorkflow({ rootGraph, activeWorkflow });
}

/**
 * Does the live root reproduce the active workflow's STRUCTURE — its node set
 * (ids and types), links, floating links, reroutes, groups, config, top-level
 * subgraphs, definitions and content-bearing extra?
 *
 * Exported separately from the relaxation above because the answer is also what
 * makes a REFUSAL truthful. "The counts agree but the contents differ" leaves the
 * reader unable to tell a genuinely different graph from the right one whose
 * widgets drifted — and the old message resolved that ambiguity by asserting the
 * worse reading ("a load, tab switch, or reconnect left this command pointed at
 * the wrong canvas"), which is the sentence three reports in this cluster were
 * derailed by. With this the disclosure states which of the two was measured.
 *
 * False when either side cannot be read: an uncompleted comparison is not a match.
 */
export function graphRootStructureMatchesActiveWorkflow({ rootGraph, activeWorkflow } = {}) {
  try {
    const expected = graphStructureShape(activeWorkflowCurrentState(activeWorkflow));
    if (expected == null) return false;
    let actual = null;
    try {
      actual = graphStructureShape(rootGraph?.serialize?.());
    } catch {
      return false;
    }
    return actual != null && actual === expected;
  } catch {
    return false;
  }
}

/**
 * #1187 — does the live root still CONTAIN the active workflow's whole structure?
 * Every node the workflow's own current state carries is present with the same id
 * and type, every one of its links survives, and each remaining structural surface
 * (floating links, reroutes, groups, config, top-level subgraphs, definitions,
 * content-bearing extra) is EQUAL. The live root may carry MORE — extra nodes and
 * extra links — and that is the whole point:
 *
 * ChangeTracker captures on user-input events, so a structural HAND EDIT (a node
 * added, a wire dropped) leaves `activeState` one capture behind the canvas while
 * `isModified` has not flipped. In that window `graphRootStructureMatchesActive-
 * Workflow` is false BY DEFINITION — the edit differs structurally — so the
 * equality relaxation above can never rescue the read, and every graph tool
 * refuses the workflow's own canvas until the tracker happens to capture. That
 * window is exactly "the live root is the workflow's structure PLUS the edit",
 * which this predicate proves from content alone.
 *
 * Why the addition-only direction, and why each clause is load-bearing:
 *
 *   CONTAINMENT, not intersection. An admitted canvas holds EVERY node and link
 *   the workflow owns, unaltered — a read served from it can never under-report
 *   the workflow (the count-short read is the #618 lesson, and a canvas missing
 *   the workflow's content is what the whole guard exists to refuse). The mirror
 *   relation — live ⊆ state, a hand REMOVAL still in the lag window — would admit
 *   exactly that under-reporting canvas, so removals keep refusing here and
 *   self-clear when the tracker captures. Deliberate, and disclosed in the PR.
 *
 *   Non-node/link surfaces stay EQUAL. Adding a node or a wire does not rewrite
 *   groups, reroutes, subgraphs, definitions or extra, so a canvas that differs
 *   there is not "A plus an edit" and stays refused, exactly as under the
 *   equality relaxation.
 *
 *   Fail closed on an unreadable side, like every predicate in this module: a
 *   comparison that could not run is not containment.
 *
 * IDENTITY IS STILL A SEPARATE CONJUNCT — this predicate is consulted only
 * alongside `graphRootWorkflowUuidMatches`, so the stale-tag legs recorded in
 * docs/design/graph-binding-tag-vs-tracker.md are answered the same way the
 * equality relaxation answers them: the tag is never trusted alone, and the
 * content proof demanded here is one no foreign canvas satisfies (a different
 * workflow does not contain this one's node ids and links). The known residual
 * is the seal's closed-duplicate gap, widened from "still structurally A" to
 * "structurally A plus additions": a stranded duplicate canvas that already
 * carries A's tag and then gains nodes keeps its reads. That is the same
 * ambiguity `graphRootContentDriftOnBoundCanvas`'s comment accepts knowingly —
 * the two canvases are observationally identical to every signal the panel has,
 * and #1187 cannot be fixed without admitting the edit — while the bound still
 * holds in the direction that matters: nothing A owns can be absent.
 */
export function graphRootStructureExtendsActiveWorkflow({ rootGraph, activeWorkflow } = {}) {
  try {
    const expected = buildGraphStructureShape(activeWorkflowCurrentState(activeWorkflow));
    if (expected == null) return false;
    let actual = null;
    try {
      actual = buildGraphStructureShape(rootGraph?.serialize?.());
    } catch {
      return false;
    }
    if (actual == null) return false;
    // Nodes: containment by identity (id + type), the same identity
    // buildGraphStructureShape establishes — type-qualified, so numeric 1 and
    // string "1" still cannot collide.
    const actualNodes = new Set(actual.nodes.map((node) => JSON.stringify([node.id, node.type])));
    for (const node of expected.nodes) {
      if (!actualNodes.has(JSON.stringify([node.id, node.type]))) return false;
    }
    // Links: every link the workflow's state carries must survive on the live
    // root; the live root may carry extra ones (a wire to the node just added).
    // A links surface that is present but not an array is malformed — fail closed.
    const linkSet = (surface) => {
      if (!surface.present) return new Set();
      if (!Array.isArray(surface.value)) return null;
      return new Set(surface.value.map((link) => JSON.stringify(canonicalizeShapeValue(link))));
    };
    const expectedLinks = linkSet(expected.links);
    const actualLinks = linkSet(actual.links);
    if (expectedLinks == null || actualLinks == null) return false;
    for (const link of expectedLinks) {
      if (!actualLinks.has(link)) return false;
    }
    // Everything else that identifies a workflow must be EQUAL — an added node
    // does not touch these surfaces, so a difference here is not the hand edit
    // this relaxation exists for.
    const restOf = (shape) => {
      const { nodes, links, ...rest } = shape;
      return JSON.stringify(canonicalizeShapeValue(rest));
    };
    return restOf(actual) === restOf(expected);
  } catch {
    return false;
  }
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

/** The panel's own namespace inside a serialized graph's `extra`. Not workflow
 *  content — `buildGraphShape` strips it from every content comparison. */
export const PANEL_GRAPH_META_KEY = "comfyui_mcp";
/** Where workflow_open records the single-use marker for THIS repaint attempt. */
export const OPEN_PROOF_FIELD = "open_proof";

/**
 * ATTEMPT-scoped proof that the live root was configured from the exact payload
 * this call just handed `loadGraphData` (#604/#603/#616 residue).
 *
 * `graphRootWorkflowUuidMatches` proves the root carries a WORKFLOW's durable
 * identity. That is weaker than it looks for a post-load receipt: the tag is
 * panel-owned bookkeeping that a rebind HEAL (#545/#557/#565) can legitimately
 * stamp onto a root, and a previous load of the same workflow leaves it there
 * too — so "the root carries A's uuid" does not establish that THIS load landed.
 * A single-use marker minted per attempt and written into the payload's own
 * `extra` does: ComfyUI's `configure()` replaces `graph.extra` wholesale from the
 * data it is given, so nothing but that payload can put this value on the root.
 *
 * ADDITIONAL evidence, NOT a replacement — and specifically NOT a superset of the
 * uuid predicate, which is easy to assume and false: a root carrying
 * `{ open_proof: M, workflow_uuid: "B" }` PASSES this for marker M while
 * `graphRootWorkflowUuidMatches` correctly FAILS it for workflow A. The two answer
 * different questions — this one "was the root configured by this attempt", that
 * one "whose workflow is this" — and `resolveOpenRebindVerdict` requires BOTH.
 * Reading this as the stronger check would licence dropping the identity one, which
 * is how an overclaiming comment turns into a real hole several refactors later.
 *
 * Absent or non-matching is NOT proof of a wrong canvas — it is absence of
 * proof. The caller must disclose it as such and must never widen it into a
 * claim about which workflow the canvas holds.
 */
export function graphRootCarriesOpenProof({ rootGraph, proofMarker } = {}) {
  if (typeof proofMarker !== "string" || !proofMarker) return false;
  const seen = rootGraph?.extra?.[PANEL_GRAPH_META_KEY]?.[OPEN_PROOF_FIELD];
  return typeof seen === "string" && seen === proofMarker;
}

/**
 * #1089 — does the STATE this open is about to repaint FROM belong to the tab
 * being opened?
 *
 * Every proof `resolveOpenRebindVerdict` weighs is taken AFTER the load, against
 * the root the loader produced. None of them looks at the state the load was
 * handed. So when that state holds another workflow's graph, the open repaints it
 * faithfully, stamps the target's identity onto it, and all four parts pass — not
 * by being fooled, but because each one is a TRUE statement about a poisoned
 * source. That is #1089 exactly: a clean success, `modified: false`, and the
 * previous workflow's graph on the canvas.
 *
 * #968 closed the writer this repo owns (the pre-repaint `checkState` capture) and
 * recorded its own residual: an UNTAGGED root is still captured. A state poisoned
 * before that fix shipped, through the residual, or by any capture the panel does
 * not mediate, still reaches this load — and the load is the step that turns it
 * into durable loss, because the stamp makes a later save write the foreign graph
 * to the target's file.
 *
 * WHAT THE ANSWER IS FOR. Not a refusal — `workflow_open` must not refuse on this,
 * and the first attempt at this fix did (codex NO-SHIP, round 1). The repaint's root
 * re-stamp is the one documented heal for a conflicting root tag, so refusing before
 * the load removes it and strands the pointer on the target with another workflow's
 * uuid on `app.graph`. Every `graph_*` command is then refused by
 * `assertGraphBoundToActiveWorkflow` — including the `panel_load_workflow` the
 * refusal recommended, whose own error says to re-open the tab, which re-enters the
 * refusal. A hard loop, on true positives as much as false ones.
 *
 * `foreign` therefore authorizes a DISCLOSURE and nothing else. The load proceeds
 * exactly as before, the root gets re-stamped by it, and the caller is told to verify
 * the graph before editing. That is the whole remedy, and the reason it is the whole
 * remedy is worth reading before anyone tries to strengthen it again.
 *
 * The evidence rule is `describeLiveCanvasBinding`'s (#708/#349), applied to the
 * source state instead of the live canvas, plus ONE additional requirement:
 *
 *   bound   — the state carries the target's own identity.
 *   foreign — the state carries a tag the target does not claim, AND that tag is
 *             owned by a DIFFERENT currently-open workflow.
 *   unknown — anything else.
 *
 * WHY THE LIVE OWNER. `workflowOwnsRootUuidTag`'s header records that a lagging
 * `activeState` can carry a REPLACED PREDECESSOR's uuid residue, "indistinguishable
 * from the genuine lineage stamp". A predecessor is not an open tab, so requiring a
 * live owner separates residue from another tab's graph.
 *
 * WHAT THIS DOES NOT ESTABLISH, and cannot. The tag does not prove the GRAPH is
 * foreign. #817 is the counter-example: a tab switch leaves the previous workflow's
 * tag on the reused `app.graph`, and the guard's rebind re-stamps that root on
 * CONTENT proof — `rootContentProvesActiveWorkflow`, not a claimed tag.
 * `stampGraphRootWorkflowUuid` writes `rootGraph.extra` and nothing else, so a
 * capture taken before the heal leaves the tab's OWN content under the other tab's
 * meta block, indefinitely. The whole `comfyui_mcp` block travels together as
 * residue, so no field in it separates the two. The disclosure says "may be" for
 * that reason and hands the comparison to the caller, who knows what the workflow
 * should contain.
 *
 * TWO STRONGER REMEDIES WERE BUILT AND REMOVED. Both are recorded because both look
 * obviously right and are not.
 *
 *   REFUSING the open (codex NO-SHIP). The repaint's root re-stamp is the one
 *   documented heal for a conflicting root tag, so refusing strands the pointer on
 *   the target with another workflow's uuid on `app.graph`. Every `graph_*` command
 *   is then refused — including the `panel_load_workflow` the refusal recommended,
 *   whose own error says to re-open the tab, which re-enters the refusal. A hard
 *   loop, on true positives as much as false ones.
 *
 *   AUTO-CORRECTING from disk. Gated on the tab being clean, which cannot bear it:
 *   #874 records that ChangeTracker captures on USER INPUT events only, so a value a
 *   NODE wrote (a populated wildcard, a rolled seed) is on the canvas, never marks
 *   the tab modified, and was never saved — the re-read would silently replace
 *   exactly what an agent just generated. The same flag fails in the other direction
 *   too: a first-time open can still read modified when freeze/re-baseline is
 *   unavailable, and gating on it would have disarmed this guard for that
 *   population. #442's re-read survives the argument only because it
 *   fires on the FILE provably having changed, which is independent evidence about
 *   the disk copy. A foreign source tag is no evidence about the file at all.
 *
 * STATED RESIDUAL: this warns, it does not prevent. An agent that ignores the
 * disclosure can still edit the wrong graph. Closing that needs evidence separating
 * residue from a foreign graph, which does not exist here — and every remedy tried
 * on the weaker evidence traded a silent wrong-graph edit for a wedge or a silent
 * data loss.
 *
 * Pure, so the ownership questions arrive as injected predicates. A predicate that
 * throws is inconclusive, never a positive answer.
 */
export function describeRepaintSourceBinding({
  state,
  targetUuid,
  targetClaimsTag,
  tagOwnedByOtherOpenWorkflow,
} = {}) {
  try {
    const tag = state?.extra?.[PANEL_GRAPH_META_KEY]?.workflow_uuid;
    if (typeof tag !== "string" || !tag) return "unknown";
    if (typeof targetUuid !== "string" || !targetUuid) return "unknown";
    if (tag === targetUuid) return "bound";
    // A conflicting tag the target's own lineage claims is its own drifted stamp
    // (#545/#557), not another tab's graph.
    try {
      if (targetClaimsTag?.(tag) === true) return "unknown";
    } catch {
      return "unknown";
    }
    try {
      return tagOwnedByOtherOpenWorkflow?.(tag) === true ? "foreign" : "unknown";
    } catch {
      return "unknown";
    }
  } catch {
    return "unknown";
  }
}

export const OPEN_REBIND_STATUS = Object.freeze({
  /** The canvas is provably the requested workflow AND holds what was loaded. */
  PROVEN: "proven",
  /** The BINDING is proven — the canvas is this workflow's canvas — but the graph
   *  on it could not be confirmed to be what was loaded. Still not a success:
   *  `workflow_open` answers `unknown` for this exactly as it does for a wholly
   *  unproven rebind. It is a distinct STATUS so the disclosure can say which half
   *  is settled, which is the difference between an actionable answer and a bare
   *  "the fence rejected". */
  CONTENT_UNVERIFIED: "content-unverified",
  /** Nothing here says the canvas is wrong — only that this call cannot show it is
   *  right. */
  UNPROVEN: "unproven",
});

/**
 * workflow_open's post-repaint verdict, as a NAMED answer per part rather than one
 * boolean.
 *
 * The parts answer different questions and no one of them answers another's (#621
 * established the shape; this names them so a failure can say which one fired):
 *
 *   instance — the active workflow is still the tab we were asked to open. A tab
 *              switch during the load makes every other part describe a DIFFERENT
 *              canvas, so nothing else is meaningful without it.
 *   marker   — the live root was configured from THIS attempt's payload. It answers
 *              FRESHNESS, which the workflow uuid cannot: the uuid can already be on
 *              the root from a previous load of the same tab or from the guard's own
 *              rebind heal (#545/#557/#565), so it never established that this load
 *              landed. It is NOT a superset of `identity` and must never be treated
 *              as one — a root carrying this attempt's marker alongside a DIFFERENT
 *              workflow's uuid passes here and fails `identity`, which is the whole
 *              reason both are ANDed. Dropping either in a later refactor reopens a
 *              hole the other does not cover.
 *   identity — the root carries the workflow uuid the command fence will compare,
 *              i.e. the desync fence is actually healed by this open. Answers WHICH
 *              WORKFLOW, which the marker does not.
 *   content  — the graph on the canvas reproduces the payload exactly.
 *
 * WHY `content` STILL BLOCKS SUCCESS, even though it is a FIDELITY question and the
 * binding is separately proven. `loadGraphData` transforms the payload it is given
 * before the root serializes again — it grows every node to at least
 * `computeSize()`, normalizes combo and `control_after_generate` widget values, may
 * substitute a schema-validated copy, and runs every installed extension's
 * `loadedGraphNode` hook on every node — so a perfectly rebound canvas can differ
 * from the bytes handed in. It is therefore genuinely a false negative to deny the
 * OPEN for it, and softening it was tried here.
 *
 * It was reverted the first time, because the two cases could not then be told apart.
 * LiteGraph creates every node (with its id and type) and THEN configures each one,
 * and `loadGraphData` catches a `configure()` failure and returns. A throw in that
 * second pass leaves the complete node id/type set, the links, and the panel's
 * marker — written by `_configureBase` before any node is built — over nodes that
 * silently LOST their widget values and properties. That is byte-for-byte the same
 * observation as "the loader normalized the widget values". Reporting it as a
 * completed open would fabricate a success over data loss, which is worse than the
 * false negative.
 *
 * THE DISCRIMINATOR NOW EXISTS (panel#1283 / #1358), and it is not a field-name
 * judgement — it is an observation of THIS load. `installNodeConfigureIsolation` and
 * `installGraphConfigureWatch` (web/js/lib/load-restore-isolation.js) wrap the only
 * two places the restore can abort, `loadRestoreCompleted` folds them into
 * true/false/null, and `openContentDifferenceIsCompletedLoadNormalization` (above)
 * consumes it. In one line: **a mid-`configure()` abort is a THROW, and a load whose
 * throws the panel watched for and did not see did not abort.** Only an explicit
 * `true` licenses anything — `false` (something threw) and `null` (the watch was
 * absent, or installed on a method this frontend's restore never called) both keep
 * the old, refusing path.
 *
 * `resolveOpenRebindVerdict` itself is unchanged and still says `unknown` on
 * `contentMatches !== true`: the discriminator is applied UPSTREAM, where the content
 * proof is computed, so what arrives here is already the answer. What the status split
 * buys is that the DISCLOSURE can say the binding IS proven and only the content is
 * unconfirmed, instead of implying the canvas may be the wrong workflow.
 *
 * Every part is compared against `true` explicitly: an unreadable observation
 * arrives as null/undefined and must count as NOT proven, never as proven.
 */
export function resolveOpenRebindVerdict({
  instanceStillTarget,
  markerMatches,
  identityMatches,
  contentMatches,
} = {}) {
  const unproven = [];
  if (instanceStillTarget !== true) unproven.push("instance");
  if (markerMatches !== true) unproven.push("marker");
  if (identityMatches !== true) unproven.push("identity");
  if (unproven.length) {
    return { status: OPEN_REBIND_STATUS.UNPROVEN, bindingProven: false, unproven };
  }
  if (contentMatches !== true) {
    // Binding proven, content not. NOT a success — see above — but the disclosure
    // gets to say which half is settled.
    return { status: OPEN_REBIND_STATUS.CONTENT_UNVERIFIED, bindingProven: true, unproven: ["content"] };
  }
  return { status: OPEN_REBIND_STATUS.PROVEN, bindingProven: true, unproven: [] };
}

/**
 * What a CONTENT_UNVERIFIED open must ALSO say (#702).
 *
 * That branch has already PROVEN the binding — instance, marker and identity all match —
 * and only the content is unconfirmed. But the reply still throws, so it never reaches
 * the line that publishes `workflow_uuid`, and the caller's fence keeps whatever it had.
 * The disclosure then closed by recommending `panel_graph_outline`, which is precisely
 * the call that is about to be refused as a `workflow instance mismatch`. Two reporters
 * followed that advice into the refusal and concluded, reasonably, that only a full
 * panel_reload could recover.
 *
 * So the reply names the state it leaves behind and the ONE cheap call that clears it.
 * `workflow_list` is deliberately fence-EXEMPT (#759/#932) precisely to be the recovery
 * probe, and it republishes the active identity — measured: after this outcome it
 * returns the same uuid and a stamped graph read then succeeds.
 *
 * The note promises a fence refresh and nothing more (codex). On the fourth wording the
 * panel could not READ the graph at all, and a refreshed fence cannot make that read
 * succeed — it only stops the mismatch from being the reason it fails.
 */
const FENCE_NOT_REFRESHED =
  " This reply carries NO fence refresh — an open that could not verify its content" +
  " publishes no workflow_uuid, so a command stamped from an older one is still refused" +
  " as a workflow instance mismatch. Call panel_list_workflows first: it is exempt from" +
  " the fence and republishes the active identity, which permits a freshly stamped graph" +
  " read. Reloading the panel is NOT required to refresh the fence (#702).";

/** Did a content comparison actually HAPPEN? The single rule every sentence about
 *  content asks, so the headline and the per-part clause cannot disagree with each
 *  other — which they did, because one tested `=== true` and the other `=== false`
 *  and an absent value fell down opposite branches.
 *
 *  Only an explicit `true` counts. `graphRootMatchesState` returns false for BOTH
 *  "compared and differed" and "could not read the root", so a caller that says
 *  nothing about comparability has not established one — and an unestablished
 *  observation must never license the definite claim. */
function contentWasCompared(observed) {
  return observed?.contentComparable === true;
}

/**
 * The sentence that says whether anything was LOST from the node set (#825).
 *
 * "nodes differ" is the same three words whether a node vanished or the frontend
 * re-measured every box, and the reporter read it after a perfectly good open as
 * possible data loss. So when the node set is intact, say so — plainly, in the
 * same breath, because a warning the reader cannot size is one they must assume
 * the worst about.
 *
 * It states an OBSERVATION and stops. `cosmeticOnly` names the fields that moved
 * and says the frontend rewrites them; a widget-value difference is NOT cosmetic
 * and gets the plain same-set sentence with no reassurance attached. Nothing here
 * touches the verdict, which stays `unknown` either way.
 */
function nodeSurfaceClause(observed = {}) {
  const diff = observed.contentNodeDifference;
  if (!diff || diff.comparable !== true) return "";
  if (!diff.sameNodeSet) {
    return (
      ` — and the node SET itself differs (a node is missing, extra, or has a different type), ` +
      `which is not something the frontend does while loading a graph faithfully`
    );
  }
  const fields = (diff.fields ?? []).join(", ") || "no readable field";
  // #886 — when `properties` is among the differing fields, name the KEYS that
  // differ inside it. "properties" alone sends the reader to re-read the whole
  // graph for what may be a rewritten pack-version stamp; the keys are the
  // difference between that and an extension's stored settings, and naming them
  // is what turns the next report of this shape into the measurement a per-key
  // account could be written from. Capped, so a hostile properties bag cannot
  // grow this clause without bound; the cap only trims the LIST, never the
  // verdict, which this clause does not touch.
  const propertyKeys = Array.isArray(diff.propertyFields) ? diff.propertyFields : [];
  const namedKeys = propertyKeys.slice(0, 10).join(", ");
  const keyDetail =
    diff.fields?.includes("properties") && namedKeys
      ? `; within properties, the keys that differ are: ${namedKeys}` +
        (propertyKeys.length > 10 ? `, and ${propertyKeys.length - 10} more` : "")
      : "";
  if (diff.cosmeticOnly) {
    // States the NODE observation and stops. The overall "nothing to redo"
    // conclusion is the headline's to draw, and only when `nodes` is the sole
    // surface that differed — a group or a link lost alongside the re-measured
    // boxes is work the node set cannot vouch for.
    // #696 (codex) — no claim about WHO changed these. "which the ComfyUI frontend
    // recomputes on load" was true of size/pos/order and false of `color`/`bgcolor`,
    // which are in the same cosmetic set and are authored by the user, not
    // recomputed by anything. Naming the fields says more than the guess did, and
    // says only what was observed.
    return (
      ` — but every node that was loaded IS on the canvas with the same id and type, and nothing ` +
      `extra appeared, so NO node was lost. What differs is per-node presentation (${fields})`
    );
  }
  return (
    ` — every node that was loaded IS on the canvas with the same id and type and nothing extra ` +
    `appeared, so no node was lost; what differs is per-node (${fields})${keyDetail}. A widget value is real ` +
    `content, so read it (panel_graph_outline) before assuming either way`
  );
}

/**
 * The restore ABORTED — say so, and name what aborted it. (panel#1283 family)
 *
 * Only when `contentLoadRanToCompletion` is explicitly `false`: the panel watched this
 * load and something threw. `null` means the load could not be watched, which is the
 * pre-existing state of knowledge and gets no sentence — an absent observation must
 * not be narrated as a clean one OR as a failed one.
 *
 * This is the ONE case where a content difference has a KNOWN cause other than the
 * frontend rewriting its own fields, so it is the one the reader most needs named.
 * Without it the refusal says "widget values differ" and leaves them to guess between
 * a normalization and a node that never got its values at all.
 */
function abortedRestoreClause(observed = {}) {
  if (observed.contentLoadRanToCompletion !== false) return "";
  const failures = Array.isArray(observed.contentRestoreFailures) ? observed.contentRestoreFailures : [];
  // Capped like `nodeSurfaceClause`'s property keys: a graph full of broken nodes must
  // not grow this clause without bound. The cap trims the LIST, never the claim.
  const named = failures
    .slice(0, 10)
    .map((f) => {
      const widgets = Array.isArray(f?.widgetDifferences) && f.widgetDifferences.length
        ? `; widgets not verified: ${f.widgetDifferences.join(", ")}`
        : "";
      const linkDriven =
        Array.isArray(f?.linkDrivenWidgetDifferences) && f.linkDrivenWidgetDifferences.length
          ? `; link-driven widgets observed: ${f.linkDrivenWidgetDifferences.join(", ")}`
          : "";
      return `${f?.type ?? "node"} (id ${f?.id ?? "?"})${f?.error ? `: ${f.error}` : ""}${widgets}${linkDriven}`;
    })
    .join("; ");
  if (!named) {
    // Something threw, and nothing is still broken that the panel can name — a node
    // whose post-load retry repaired it, or a throw out of the graph restore itself.
    // The refusal stands (a restore that stopped early is not one whose result can be
    // called byte-identical) but it may NOT claim values are missing, because the
    // observation that would support that is exactly the one that came back empty.
    return (
      `. The restore also DID NOT RUN TO COMPLETION: the panel watched this load and ` +
      `something threw while the graph was being restored. No node is still reported ` +
      `unrestored, so this may already be repaired — but the panel cannot call the result ` +
      `byte-identical, which is why the content stays unconfirmed rather than applied`
    );
  }
  return (
    `. AND THE RESTORE DID NOT RUN TO COMPLETION: the panel watched this load and ` +
    `${failures.length} node(s) are still at CONSTRUCTION DEFAULTS after a post-load retry — ` +
    `${named}` +
    (failures.length > 10 ? `, and ${failures.length - 10} more` : "") +
    `. So this difference is NOT the frontend normalizing its own fields: part of what was ` +
    `loaded never landed. Fix or update the pack that threw, then open again`
  );
}

/** The only surfaces this file has a written account of. `definitions` differs on a
 *  faithful open because loading a saved workflow regenerates ids inside subgraph
 *  definitions — LINK ids (#886, measured: state.lastLinkId 2092 -> 2106) and, when they
 *  collide with the payload's own root node ids, NODE ids (comfyui-mcp#1706, measured:
 *  78/77/76 -> 182/183/184 with the definition's links patched through the same map).
 *  `definitionsDifferOnlyByRenumber` decides per-case whether THIS difference is only
 *  those. Nothing else has such an account, so nothing else may be waved through. */
const ACCOUNTABLE_CONTENT_SURFACES = new Set(["definitions"]);

/**
 * #1588 — the differing surfaces, split by whether anything ACCOUNTS for them.
 *
 * `contentAccountedSurfaces` is produced by `describeGraphStateDifference` from the
 * same predicate the content VERDICT uses, so the disclosure and the verdict cannot
 * disagree about what a `definitions` difference means. Absent (an older caller, or a
 * comparison that never happened) it is an empty list, which reproduces the previous
 * behaviour exactly — an unknown account is not an account.
 */
function accountedContentSurfaces(observed = {}) {
  const accounted = observed.contentAccountedSurfaces;
  if (!Array.isArray(accounted)) return [];
  const surfaces = observed.contentSurfaces ?? [];
  // TWO gates, and both are about the direction that costs something. This list
  // SHRINKS the set of differences a reader is asked to worry about, so a wrong entry
  // here waves away a real one.
  //  • `ACCOUNTABLE_CONTENT_SURFACES` — only a surface with a written, hardened account
  //    of WHY it differs may appear. Today that is `definitions` and nothing else; a
  //    caller cannot use this channel to excuse `groups` or `links`, whose differences
  //    nothing has characterised. Widening it means writing the account first.
  //  • membership in `contentSurfaces` — a name that did not actually differ is not an
  //    account of anything, and must not be able to shorten the unexplained list.
  return accounted.filter(
    (s) => typeof s === "string" && ACCOUNTABLE_CONTENT_SURFACES.has(s) && surfaces.includes(s),
  );
}

function unexplainedContentSurfaces(observed = {}) {
  const accounted = accountedContentSurfaces(observed);
  return (observed.contentSurfaces ?? []).filter((s) => !accounted.includes(s));
}

/** One clause per failed part, naming the TWO VALUES that disagreed. A refusal
 *  that says only "the fence rejected" is not actionable; one that says which
 *  observation failed and what was seen instead is. */
function openRebindPartClause(part, observed = {}) {
  switch (part) {
    case "instance":
      // "could not confirm", NOT "changed". The observation is `!== true`, which an
      // UNREADABLE active-workflow pointer produces just as a genuine tab switch does.
      // Asserting the switch would state a cause for a reading that was never taken.
      return (
        `the panel could not confirm the active workflow is still ${observed.targetLabel ?? "the requested tab"} ` +
        `(it now reads ${observed.activeLabel ?? "something else"}), so nothing else observed here is known ` +
        `to describe the tab you asked for`
      );
    case "marker":
      return (
        `the live canvas does not carry this open's one-time marker ` +
        `(expected ${observed.expectedMarker ?? "a marker"}, found ${observed.observedMarker ?? "none"}), ` +
        `so the panel cannot show that the graph it loaded is the one now on screen`
      );
    case "identity":
      return (
        `the live canvas does not carry this workflow's identity ` +
        `(expected ${observed.expectedUuid ?? "its uuid"}, found ${observed.observedUuid ?? "none"}), ` +
        `so the graph-command fence would still treat it as a different canvas`
      );
    case "content":
      // `contentWasCompared`, NOT `=== false`. Testing only the literal false let an
      // ABSENT or non-boolean comparability fall through to the definite-difference
      // wording — so this clause asserted a measured mismatch while the headline
      // (which tests `=== true`) correctly said the panel could not read the graph,
      // and one disclosure contradicted itself. Both now ask the same question, and
      // the burden sits on the CLAIM: only a positive "yes, compared" licenses it.
      if (!contentWasCompared(observed)) {
        return (
          `the panel could not compare the loaded graph with the canvas at all, so it is UNKNOWN — ` +
          `not established — whether the whole graph landed`
        );
      }
      // #1588 — name the surfaces that are still UNEXPLAINED, and account for the rest
      // separately. Listing an accounted-for `definitions` alongside a genuinely
      // unexplained `nodes` invites the reader to weigh two differences when only one
      // of them is a question.
      const unexplained = unexplainedContentSurfaces(observed);
      const accounted = accountedContentSurfaces(observed);
      const named = unexplained.join(", ") || "an unnamed surface";
      return (
        `the graph on the canvas differs from what was loaded on: ${named}` +
        nodeSurfaceClause(observed) +
        abortedRestoreClause(observed) +
        // comfyui-mcp#1706 — this sentence used to name LINK renumbering as "the whole
        // difference". There are TWO measured rewrites on this surface now (link ids,
        // #886; subgraph node ids, #1706), and the predicate does not report which one
        // it matched — so naming one would state a mechanism this reply never observed.
        // It says instead exactly what the predicate PROVED, which covers both.
        (accounted.length
          ? `. Its \`${accounted.join("`, `")}\` also differ, and that one IS accounted for: the ` +
            `whole difference is the frontend RENUMBERING its own ids on load — link ids, and the ` +
            `node ids inside subgraph definitions when they collide — with the same nodes in the ` +
            `same order, the same values, and every connection still joining the same two slots, ` +
            `so it is not a content change and is not part of what is unconfirmed here`
          : "")
      );
    default:
      return `an unrecognized check (${part}) did not pass`;
  }
}

/**
 * What workflow_open tells the caller about its own repaint.
 *
 * DISCLOSURE, never refusal: by the time this runs the destructive load has
 * ALREADY executed. Wording that invites a clean retry ("nothing happened")
 * would be false, and wording that asserts a cause the panel did not observe
 * ("the open may have switched the active workflow") narrates a bucket as if it
 * were the diagnosis. Each clause states only what was actually observed.
 */
export function describeOpenRebindOutcome(verdict, observed = {}) {
  const workflow = observed.targetLabel ?? "the requested workflow";
  const clauses = (verdict?.unproven ?? []).map((part) => openRebindPartClause(part, observed));
  const because = clauses.length ? ` Specifically: ${clauses.join("; ")}.` : "";
  // Every sentence below states an OBSERVATION, never the event that produced it. The
  // instance check reads "is the active workflow this target now" — it does not watch a
  // switch happen, and the target may already have been active — so "the tab switched"
  // would narrate an event nobody saw. Its failure is likewise `!== true`, which an
  // unreadable pointer produces just as a real switch does, so that direction can only
  // say the panel could not confirm which workflow is active.
  const activeIsTarget = !(verdict?.unproven ?? []).includes("instance");
  if (verdict?.status === OPEN_REBIND_STATUS.CONTENT_UNVERIFIED) {
    // The precise answer, and precisely as far as it goes: the canvas IS this
    // workflow's, and what is unknown is narrower than "which workflow is this".
    // The open still reports `unknown`, because the panel cannot tell the frontend
    // NORMALIZING the graph apart from the load only partly applying it.
    //
    // "does not match" is stated ONLY when a comparison actually happened.
    // `graphRootMatchesState` returns false for BOTH "compared and differed" and
    // "could not read the root at all" — one return value doing two jobs, the same
    // fold this whole change exists to remove, hiding one level down in the wording.
    // An unreadable post-load root would otherwise be disclosed as a definite
    // mismatch: telling the user their canvas holds something different when the
    // truth is that we could not look. `describeGraphStateDifference` keeps the two
    // apart and the caller passes that through as `contentComparable`; anything but
    // an explicit `true` takes the non-asserting wording.
    const compared = contentWasCompared(observed);
    // panel#1283 family — AN ABORTED RESTORE GETS ITS OWN HEADLINE, before either of the
    // sentences below can be reached.
    //
    // Both of those were written for a load that COMPLETED, and both are false here. The
    // reassuring one says "there is no missing work to redo"; the generic one says "the
    // panel cannot tell whether the ComfyUI frontend merely normalized it or the load only
    // partly applied". Since the panel started watching the restore it CAN tell, and it
    // knows the answer is the second — so leaving either in place would put a sentence
    // next to `because`'s "part of what was loaded never landed" that contradicts it.
    // A reply that says two opposite things about one observation is the defect #1623 was
    // reported for, one level down.
    if (compared && observed.contentLoadRanToCompletion === false) {
      return (
        `workflow_open RAN and the canvas IS bound to ${workflow} — that much was proven — but the ` +
        `RESTORE ITSELF DID NOT FINISH, so the graph on the canvas is not what was loaded. This is ` +
        `not the frontend normalizing its own fields: the panel watched this load and something ` +
        `threw part-way through it.${because} Treat the canvas as UNKNOWN and re-read it ` +
        `(panel_graph_outline) before editing. Any node named above is at CONSTRUCTION DEFAULTS — ` +
        `its saved widget values were never applied — so reconfigure it, or fix the pack it comes ` +
        `from and open again. Do NOT save from here: it would write the unrestored state over ` +
        `${workflow}.` + FENCE_NOT_REFRESHED
      );
    }
    // #825 — the headline may only claim "the panel cannot tell" while that is
    // still true. When the ONLY surface that differs is `nodes` and the node set
    // came through intact with just presentation rewritten, the panel CAN tell:
    // it compared the sets and nothing was lost. Leaving the generic sentence
    // there is what made a healthy open read as possible data loss, and sent a
    // reporter looking for work to redo that was never gone. Narrow on purpose —
    // any second differing surface is unexplained by a node-set observation, so
    // it falls back to the honest "cannot tell".
    //
    // #1588 — UNEXPLAINED, not merely PRESENT, and the distinction is the whole bug.
    // The gate above tested the raw surface list, so ANY workflow containing subgraphs
    // failed it: #886 measured that loading one regenerates link ids inside
    // `definitions.subgraphs`, which puts `definitions` in that list on every faithful
    // open. The reporter's message named `nodes, definitions` and fell to the maximal-
    // alarm paragraph — while the clause below it said every node had come through with
    // the same id and type.
    //
    // The narrowness was right and is kept: what may not gate this is a surface the
    // panel has already fully characterised with the same predicate the content VERDICT
    // trusts. `definitionsDifferOnlyByRenumber` fails closed, so a `definitions`
    // difference that is anything more than renumbering is NOT accounted for and still
    // sends this to the honest "cannot tell" — as does any other second surface.
    const unexplained = unexplainedContentSurfaces(observed);
    const nodesOnly = unexplained.length === 1 && unexplained[0] === "nodes";
    // #696 — this used to also require `cosmeticOnly`, i.e. that every differing
    // field be on an allowlist of names. That made the reassurance hostage to
    // guessing what a field MEANS: one unrecognised display flag from any node pack
    // (`showAdvanced` was the reported one) sent a perfectly healthy open down the
    // "the load may only have partly applied" path. Chasing it by extending the
    // allowlist just moves the problem to the next pack, and a value-shape guard only
    // restates the name's promise in another form (codex).
    //
    // The node SET is what the panel actually PROVED: every node that was loaded is
    // on the canvas with the same id and type, and nothing extra appeared. That is
    // worth saying on its own, whatever fields differ — so it is what the headline
    // now rests on, with the differing fields NAMED so the reader judges the rest.
    const nodeSetIntact =
      observed.contentNodeDifference?.comparable === true &&
      observed.contentNodeDifference?.sameNodeSet === true;
    // #1623 — the SHARED predicate, not a fourth spelling of it. This sentence and
    // `workflow_open`'s pass/fail must not be able to disagree about the same
    // observation, which is the defect that was reported: the caller was told "there
    // is no missing work to redo" on a call reported as an error.
    //
    // The panel now reports that case APPLIED, so reaching this branch means the
    // strict proof saw something else — a second serialization of a live canvas can
    // move between the verdict and this message. The sentence stays for that, and it
    // stays TRUE of what it is describing, because it asks the same question.
    //
    // #1588 — fed the UNEXPLAINED surfaces, not the raw list, for the same reason
    // `nodesOnly` above is: an accounted `definitions` difference (pure link
    // renumbering, verified by the fail-closed predicate that produced
    // `contentAccountedSurfaces`) is not a second surface anyone should weigh, and
    // the predicate refuses on ANY second surface. Passing the raw list re-blocked
    // the reassurance one level below the gate the accounted list was added to fix.
    // Anything NOT accounted for still arrives here and still refuses — `unexplained`
    // only ever drops a surface the panel has already fully characterised.
    const valuesMatched = openContentDifferenceIsPresentationOnly({
      comparable: compared,
      surfaces: unexplained,
      nodeDifference: observed.contentNodeDifference,
    });
    if (compared && nodesOnly && nodeSetIntact) {
      // Two claims, and only the ones the comparison supports (codex). The node set
      // is proven in both branches. `cosmeticOnly` additionally establishes that the
      // fields carrying VALUES — `widgets_values`, `inputs` — matched, because those
      // are not on the cosmetic allowlist; it does NOT establish "no value is
      // missing" in general, since `color`/`bgcolor` are authored values that may
      // legitimately differ. So say the narrow thing.
      // The differing fields are NOT named here: `because` already names them, in
      // almost these words. An earlier cut added them to the headline too and a
      // mutation test caught the duplication by refusing to fail — the assertion
      // could not tell the addition from the clause that was already there. The
      // headline states the conclusion; `because` carries the detail.
      // Each branch is its OWN sentence. An earlier cut shared a `which the panel
      // cannot call byte-identical` tail between them, which read fine after the
      // cosmetic clause and attached to the wrong phrase after the other one
      // ("...or the load applied them differently, which the panel cannot call
      // byte-identical"). Sharing a tail across two different claims is how wording
      // drifts away from meaning.
      const head =
        `workflow_open RAN, the canvas IS bound to ${workflow}, and every node that was loaded ` +
        `is on it with the same id and type`;
      if (valuesMatched) {
        return (
          `${head}, carrying the same widget values and links. What differs is per-node ` +
          `presentation only, which the panel cannot call byte-identical, so the content ` +
          `is reported UNCONFIRMED rather than failed.${because} You are on the right workflow ` +
          `and there is no missing work to redo; if you need the exact graph, read it with ` +
          `panel_graph_outline.` + FENCE_NOT_REFRESHED
        );
      }
      return (
        `${head}, and nothing extra appeared — no node was lost. What differs is ` +
        `per-node fields; the panel cannot tell from here whether the ComfyUI frontend ` +
        `normalized those or the load applied them differently, so the content is reported ` +
        `UNCONFIRMED rather than failed.${because} You are on the right workflow; if you need ` +
        `the exact graph, read it with panel_graph_outline.` + FENCE_NOT_REFRESHED
      );
    }
    return (
      `workflow_open RAN and the canvas IS bound to ${workflow} — that much was proven — but ` +
      (compared
        ? `the graph on it does not match the state that was loaded, and the panel cannot tell whether ` +
          `the ComfyUI frontend merely normalized it (node sizes, widget values) or the load only ` +
          `partly applied. `
        : `the panel could not READ the graph on it to compare against the state that was loaded, so ` +
          `whether the whole graph landed is unestablished — NOT established as wrong. `) +
      `Treat the canvas as UNKNOWN and re-read it (panel_graph_outline) before editing.${because} ` +
      `The identity is settled — ${workflow} IS the active one — but that is a statement about ` +
      `the IDENTITY, not about the nodes: this outcome has been reported (#1111, #1089) with the ` +
      `PREVIOUS workflow's graph still on the canvas, which a re-read then returns as if it were ` +
      `this workflow's. So compare what you read against what you expect, and if it is the wrong ` +
      `graph, panel_load_workflow with this workflow's path reloads it — that is what recovered ` +
      `it for both reporters, and neither panel_graph_outline nor a fence refresh will. It loads ` +
      `from DISK, so whatever is on the canvas right now is replaced: if the graph you are looking ` +
      `at holds unsaved work — and if it is the previous workflow's, it may — preserve it FIRST. ` +
      `To a NEW path, with Save As or an export: a plain save would write it to ${workflow}, ` +
      `because that is what the active identity already names, and the stale graph would land on ` +
      `top of the workflow you were trying to open. Recovering the binding is not worth losing a ` +
      `graph to, and neither is preserving one.` +
      FENCE_NOT_REFRESHED
    );
  }
  if (verdict?.status === OPEN_REBIND_STATUS.UNPROVEN) {
    return (
      `workflow_open RAN but could not prove that the active canvas was rebound to ${workflow}, so ` +
      `treat the canvas as unknown rather than unchanged. ` +
      (activeIsTarget
        ? `${workflow} IS the active workflow — what could not be established is the state of the ` +
          `canvas under it.`
        : `The panel could not confirm which workflow is active, so the open may have left a ` +
          `different one active.`) +
      `${because} Check panel_list_workflows, then reload the panel before graph edits.`
    );
  }
  return "";
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
 *                `staleTagOnEmptyCanvas` is set (#565): on the frontend that
 *                report came from, ComfyUI reused the app.graph object across
 *                tabs and its clear/configure did NOT reset graph.extra, so a
 *                brand-new blank tab inherited the
 *                PREVIOUS workflow's tag while minting its own identity. With
 *                zero nodes on BOTH sides there is no workflow content that
 *                could be confused — the #349 fence protects CONTENT — so the
 *                leftover tag is stale metadata: re-stamp and proceed;
 *                Also when `contentProvesActiveWorkflow` is set (#817): the live
 *                root serializes EQUAL to the active workflow's own current
 *                state, on a clean tab, with no other open workflow able to
 *                claim the same canvas. That is the same proof
 *                `sealProvenRootBinding` accepts to stamp an UNTAGGED root, and
 *                the evidence does not get weaker because a stale tag happens to
 *                be sitting on the object. The asymmetry it removes was the #817
 *                report: switching tabs leaves the PREVIOUS workflow's tag on the
 *                reused app.graph (on that build configure did not reset graph.extra — the
 *                same mechanism the empty-canvas clause above records), so a
 *                canvas that IS the active workflow's, byte for byte, was refused
 *                where an untagged copy of it was allowed. Nothing self-healed
 *                it: the seal declines a root that already carries a tag, so a
 *                WRONG tag was stickier than no tag at all;
 *
 * MEASURED 2026-08-09 on ComfyUI frontend 1.48.7 — stamp a marker on the live
 * root, then change its content three ways, same graph object throughout:
 *
 *   configure(payload with extra:{})      -> tag gone, nodes 10 -> 1
 *   configure(payload with NO extra key)  -> tag gone, nodes  1 -> 2
 *   clear()                               -> tag gone, nodes    -> 0
 *
 * So on THAT build a tag does not survive a content change, including the
 * no-extra-key case both clauses above name. Their premise is therefore
 * frontend-specific, and the clauses may simply not be reachable on current
 * builds. They are left in place deliberately: both ADMIT (they widen the
 * fence), so an unreachable one costs nothing, while removing one would make
 * the fence stricter for anyone still on the frontend that reported it. The
 * wording is scoped rather than deleted so the next reader does not inherit a
 * universal claim from a single observation — in either direction. Verified on
 * one frontend, which is exactly why neither statement should be universal.
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
  contentProvesActiveWorkflow = false,
} = {}) {
  if (!graphRootWorkflowUuidMismatches({ rootGraph, activeWorkflowUuid })) return "none";
  return rootTagClaimedByActiveWorkflow || staleTagOnEmptyCanvas || contentProvesActiveWorkflow
    ? "rebind"
    : "conflict";
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
  // #1478 — `graph_get_errors` reads the error surface and writes nothing. It was
  // missing here, so `graphCommandMayMutateWorkflow` called it a MUTATION and a
  // dirty tab refused it as `dirty-mutation-binding-unproven` — a message that
  // calls a read "this mutation" and prescribes reloading the tab or re-opening
  // the workflow, neither of which a read should ever cost.
  //
  // It is also the worst possible moment to refuse it: the reporter had just
  // loaded a pack whose nodes were already red, which is exactly when this tool
  // is the one to call. They fell back to filesystem globs.
  //
  // WHY THIS LIST IS THE FIX AND NOT THE GUARD. Membership here lowers the bar
  // for a command, so it is an enumeration that must stay conservative: a read
  // aimed at the wrong canvas returns wrong DATA, while a mutation aimed there
  // corrupts a graph, and that asymmetry is the whole reason reads have a lower
  // bar at all. So this grows one verified command at a time, never by pattern.
  //
  // `graph_get_object_info` and `graph_prompt_director_audit` are also absent and
  // also look like reads, but "looks like" is not the standard for weakening a
  // guard — they stay out until someone establishes it the way this one was
  // (the orchestrator's own tool description says "Read-only", and its executor
  // touches no graph state).
  "graph_get_errors",
]);

export function graphCommandMayMutateWorkflow(command) {
  return !READ_ONLY_GRAPH_COMMANDS.has(command);
}

/**
 * #601 — seal a PROVEN binding onto the live root while the tab is still CLEAN.
 *
 * The dirty-mutation fence (#545 P1) requires a POSITIVE uuid match on the live
 * root once the tab is dirty. But the first successful mutation is itself what
 * dirties the tab, and a page reload rebuilds `app.graph` from saved JSON with
 * NO stamp on the live root (the stamp lives on the workflow's saved state, not
 * the rebuilt canvas). So after each reload exactly ONE mutation passed and
 * every later one was refused as `dirty-mutation-binding-unproven` — one
 * mutation per page load, with reloads as the only recovery.
 *
 * The seal closes that: while the workflow is CLEAN, its tracker's current state
 * is trustworthy (#545's caveat is dirty-lag only), so a root that serializes
 * EQUAL to that state (graphRootMatchesState — a strict full-surface proof that
 * never passes on a partial/unavailable serializer) is provably this workflow's
 * own canvas, and stamping it with the active uuid is a statement of fact, not
 * an authorization guess. Strictly additive and fail-closed:
 *   - subgraph scope, missing identity, or a DIRTY tab → no stamp;
 *   - an EXISTING stamp (matching or conflicting) is never touched here — a
 *     conflict is the rebind path's decision (#545/#557), with its claim
 *     analysis this proof deliberately does not redo;
 *   - a stale or foreign root fails graphRootMatchesState and stays unstamped,
 *     so the fence below still refuses exactly as before;
 *   - content equality proves BINDING only when it is EXCLUSIVE: two clean,
 *     separately open DUPLICATE workflows can carry byte-identical state, and
 *     equality alone cannot tell the active tab's canvas from its twin's
 *     (codex gate). `proofExclusive: false` (the caller found another open
 *     workflow provably carrying the same state, or could not prove
 *     exclusivity at all) therefore also refuses the stamp and the command
 *     keeps the pre-seal fail-closed behaviour.
 * Returns true only when it actually wrote the stamp.
 */

/**
 * #1477 — does this root agree with the workflow's current state enough to
 * prove it is THAT workflow's canvas?
 *
 * Byte-identity is too strict after a tab switch: subgraph definition ids are
 * regenerated on the live canvas while the tracker still holds the saved ids.
 * This is the same bar `workflow_open` uses to decide the canvas is this
 * workflow (`proven` or `presentationOnly`), plus definitions-only — a previous
 * workflow's graph disagrees on root nodes or links, not on this surface alone.
 */
function graphRootAgreesWithActiveState(rootGraph, state) {
  if (state == null) return false;
  const proof = graphRootReproducesStateContent({ rootGraph, state });
  if (proof.proven === true || proof.presentationOnly === true) return true;
  const diff = describeGraphStateDifference({ rootGraph, state });
  return openContentDifferenceIsDefinitionsOnly({
    comparable: diff.comparable,
    surfaces: diff.surfaces,
  });
}

/**
 * POSITIVE proof that the live root graph IS the active workflow's own canvas,
 * from its CONTENT alone — independent of whatever identity tag it happens to
 * carry.
 *
 * This is the bar `sealProvenRootBinding` has always used; #817 lifted it out so
 * a second caller could ask the same question without the two drifting. Every
 * clause is load-bearing:
 *   - ROOT scope: a descended subgraph is not the workflow's root canvas;
 *   - CLEAN tab: a dirty tracker's state can lag the real canvas (#545), so it
 *     cannot prove anything about it;
 *   - the root must reproduce the workflow's own CURRENT state — not its load
 *     baseline, which legitimately differs from an edited canvas. Byte-identity
 *     (`graphRootMatchesState`) is too strict here: a tab switch onto a workflow
 *     containing subgraphs regenerates definition link/node ids on the live
 *     canvas (#886/#1706) while the tracker still holds the saved ids, so the
 *     canvas IS this workflow's and a stale previous-tab tag still refused every
 *     graph tool (#1477). `graphRootReproducesStateContent` is the same proof
 *     `workflow_open` already trusts, and it still fails closed on a foreign
 *     node set, a rewired link, or a widget-value change;
 *   - EXCLUSIVE: two clean, separately open DUPLICATE tabs can carry
 *     byte-identical state, and equality alone cannot tell the active tab's
 *     canvas from its twin's. The caller establishes this by enumerating the
 *     other open workflows; an enumeration that cannot run is NOT exclusive.
 */
export function rootContentProvesActiveWorkflow({
  rootGraph,
  activeWorkflow,
  inSubgraph = false,
  proofExclusive = false,
} = {}) {
  try {
    if (inSubgraph) return false;
    if (proofExclusive !== true) return false;
    if (!rootGraph || !activeWorkflow) return false;
    if (activeWorkflow.isModified === true) return false;
    return graphRootAgreesWithActiveState(rootGraph, activeWorkflowCurrentState(activeWorkflow));
  } catch {
    return false;
  }
}

/**
 * EXCLUSIVITY for a content proof that has to hold even though the active tab has
 * unsaved edits (#995).
 *
 * The ordinary exclusivity check SKIPS a dirty twin — "unprovable, not evidence of
 * ambiguity" — which is right while the ACTIVE side must be clean, because a clean
 * active workflow plus a dirty twin still leaves only one provable owner. Once the
 * active side may itself be dirty, that skip becomes the hole: a dirty twin holding the
 * same content would be invisible, and the panel could re-stamp the active identity onto
 * a root that is the twin's canvas — wedging THAT tab the moment the user switched to it.
 *
 * So here a dirty twin is DISQUALIFYING rather than skippable. `others` is every OTHER
 * open workflow; each must be readable and provably different from the root, and any one
 * of them being modified (or unreadable) makes the whole thing unprovable.
 */
export function contentProofExclusiveAmongOpen({ rootGraph, others } = {}) {
  try {
    if (!rootGraph || !Array.isArray(others)) return false;
    for (const other of others) {
      if (!other || typeof other !== "object") return false; // unreadable — prove nothing
      // A lagging tracker cannot establish that its canvas DIFFERS either, so a dirty
      // twin is not "no evidence" here: it is missing evidence the proof requires.
      if (other.isModified === true) return false;
      const state = activeWorkflowCurrentState(other);
      if (state == null) return false; // no readable state — same reason
      // Same comparison the proof uses (#1477): a twin that only disagrees by
      // definition renumbering is still a twin.
      if (graphRootAgreesWithActiveState(rootGraph, state)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * #995 — the content proof, for a canvas whose tab has UNSAVED EDITS.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7, reproducing the report through UI clicks:
 * a modified workflow whose canvas the panel's own comparison proves is its own, and a
 * root still carrying the PREVIOUS workflow's tag:
 *
 *   active workflow            probe995.json, isModified true
 *   root tag                   e66e531b…  (another workflow's)
 *   uuid mismatch              true
 *   rootContentProvesActiveWorkflow   false   <- only because the tab is dirty
 *   graphRootMatchesState(root, tracker state)   TRUE
 *   rebind verdict             "conflict"      -> every graph tool refused
 *
 * The clean-tab requirement on the ordinary proof exists because a dirty tracker can LAG
 * the canvas (#545). But a lagging snapshot makes an equality test FAIL, not falsely
 * succeed — the failure mode it guards against is a false NEGATIVE. What a dirty tab
 * genuinely costs is the twin comparison, which is why this takes its exclusivity from
 * `contentProofExclusiveAmongOpen` instead, where a dirty twin disqualifies.
 *
 * Deliberately NOT used by `sealProvenRootBinding`. That path WRITES a tag onto an
 * untagged root, and relaxing what may be written is a different decision from relaxing
 * what may be re-stamped over a tag the panel itself minted.
 */
export function rootContentProvesActiveWorkflowDespiteEdits({
  rootGraph,
  activeWorkflow,
  inSubgraph = false,
  proofExclusive = false,
} = {}) {
  try {
    if (inSubgraph) return false;
    if (proofExclusive !== true) return false;
    if (!rootGraph || !activeWorkflow) return false;
    // AN EMPTY CANVAS CANNOT IDENTIFY ITSELF. Every blank graph serialises alike, so
    // equality against a blank tracker state is not evidence about WHOSE canvas this is —
    // a dirty blank twin is exactly as plausible an owner, and re-stamping would wedge
    // THAT tab. The clean path guards this through `staleTagOnEmptyCanvas`, which demands
    // both sides be provably empty AND the tab be clean; here the tab is dirty, so the
    // only safe answer is to refuse. (Caught by the #565 gate, not by reasoning.)
    // Both sides are tested, and neither can be killed alone by mutation: the proof only
    // fires when the two are EQUAL, so an empty one implies an empty other and either
    // check refuses. Removing BOTH does fail the suite. They are kept as two because they
    // answer the question about different objects, and a later change to one side's
    // emptiness rule must not silently remove the other's guarantee.
    if (graphRootProvenEmpty(rootGraph)) return false;
    const state = activeWorkflowCurrentState(activeWorkflow);
    if (state == null) return false;
    if (serializedStateProvenEmpty(state)) return false;
    return graphRootAgreesWithActiveState(rootGraph, state);
  } catch {
    return false;
  }
}

export function sealProvenRootBinding({
  rootGraph,
  activeWorkflow,
  activeWorkflowUuid,
  inSubgraph = false,
  proofExclusive = true,
} = {}) {
  try {
    if (typeof activeWorkflowUuid !== "string" || !activeWorkflowUuid) return false;
    // A CONFLICTING stamp is the rebind path's decision, never overwritten here.
    const existing = rootGraph?.extra?.comfyui_mcp?.workflow_uuid;
    if (typeof existing === "string" && existing) return false;
    // #833 — an EMPTY canvas can never clear this proof: every blank canvas serialises
    // alike, so there is nothing to match, and a blank tab is always dirty besides. That
    // is why mutations stay refused on one. Sealing on emptiness was tried and withdrawn:
    // it would stamp the ACTIVE identity onto a root that a reconnect tab restore may
    // have left holding a DIFFERENT blank workflow (the #708 mismatch), putting the first
    // node on the wrong canvas. Emptiness proves there is nothing to mis-attribute; a
    // seal claims WHOSE canvas this is, and only the read gate needs the weaker fact.
    if (!rootContentProvesActiveWorkflow({ rootGraph, activeWorkflow, inSubgraph, proofExclusive })) {
      return false;
    }
    const extra =
      rootGraph.extra && typeof rootGraph.extra === "object" ? rootGraph.extra : (rootGraph.extra = {});
    const prior = extra.comfyui_mcp;
    extra.comfyui_mcp = {
      ...(prior && typeof prior === "object" ? prior : {}),
      workflow_uuid: activeWorkflowUuid,
    };
    return true;
  } catch {
    // A root that refuses the stamp keeps the pre-seal fail-closed behaviour.
    return false;
  }
}

/**
 * THE binding evidence bar a bridge graph command must clear (#604 family).
 *
 * The invariant this encodes: **a MUTATION may never run on binding evidence that
 * a READ would refuse.** It was the other way round. The bridge dispatch fence
 * asked for `includeBaselineReadGuard: false` for EVERY command, and only the
 * read executors (graph_outline, graph_get_errors) re-asserted with it switched
 * on. So the exact evidence that made `graph_outline` refuse — "the active
 * workflow reports N>0 nodes but the live root reads empty" — let
 * `graph_remove_node` through, which is #604's title verbatim: reads blocked,
 * mutations still routed to the wrong canvas and deleted nodes from it.
 *
 * The hole is not hypothetical-only in the both-empty case: when the live root
 * exposes no `_nodes` ARRAY at all (a half-rebuilt root after a backend restart),
 * `graphRootMismatchesActiveWorkflow` and `graphEmptyBindingUnproven` BOTH bail
 * out as inconclusive by design, and `graphReadDesynced` is the only predicate
 * that still fires. Gating it off for mutations left them with no fence at all.
 *
 * Reads keep the LOWER bar at dispatch on purpose (they re-assert with the full
 * bar inside their own executors, where they can also offer a recovery path);
 * mutations get the full bar here, before their executor ever runs.
 */
export const MUTATION_BINDING_BAR = Object.freeze({
  includeBaselineReadGuard: true,
  requireDirtyMutationBinding: true,
});

export function graphCommandBindingBar(command) {
  return graphCommandMayMutateWorkflow(command)
    ? { ...MUTATION_BINDING_BAR }
    : {
        includeBaselineReadGuard: false,
        requireDirtyMutationBinding: false,
        // #995 — POSITIVE evidence that this call is a classified read, set in exactly
        // one place. The stale-tag content bypass is gated on this rather than on
        // `requireDirtyMutationBinding !== true`, which is default-permit: a caller that
        // omits the flag, or a fence call added later without the classification, would
        // have inherited a bypass nobody decided to give it (codex). Opting in here means
        // the read list above is the whole surface that can reach it.
        staleTagReadBypass: true,
      };
}

/**
 * The binding refusal VERDICT for a graph command, or `null` when the binding
 * clears the bar. Pure — every input is passed in — so the read/mutation symmetry
 * above is unit-testable without a browser (it previously lived inline in the
 * panel monolith, where nothing could observe it).
 *
 * Returns `{ reason, expected, live }`; `reason` names the firing predicate so a
 * misfiring guard is diagnosable instead of driving a blind reload/retry loop
 * (#565). Order is significant: the positive-mismatch verdicts (identity first,
 * then the #618 mid-population window, then shape) stay more specific than the
 * inconclusive-empty verdict, which is evaluated LAST so it can never mask them.
 */
export function resolveGraphBindingVerdict({
  graph,
  rootGraph,
  activeWorkflow,
  activeWorkflowUuid,
  liveNodeCount,
  inSubgraph = false,
  rootUuidMismatch = false,
  includeBaselineReadGuard = true,
  requireDirtyMutationBinding = false,
  postReconnectWindow = false,
  graphLoading = false,
} = {}) {
  const nodeCount = Number.isFinite(Number(liveNodeCount))
    ? Number(liveNodeCount)
    : (rootGraph?._nodes?.length ?? 0);
  // On a dirty tab, ChangeTracker's activeState can lag the live canvas (#545),
  // so it cannot prove the root belongs to this workflow. Reads remain
  // availability-oriented, but mutations need a positive UUID match: otherwise
  // a stale, untagged root B is indistinguishable from A and could be changed.
  const dirtyMutationBindingUnproven =
    requireDirtyMutationBinding &&
    activeWorkflow?.isModified === true &&
    !graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid });
  // #618 — inside the post-reconnect window a live root reading BEHIND the
  // active workflow's own current state is mid-restore evidence, and it is the
  // ONLY mismatch a dirty tab can surface (the shape guard below is deliberately
  // inconclusive while dirty). Ordered ahead of rootShapeMismatch: in the window
  // a count-short canvas is far more often a still-restoring tab than a wrong
  // one, and this verdict's remedy (settle, then re-open if it persists)
  // resolves both — while a genuine wrong canvas still refuses, just with the
  // cheaper remedy first. Gated on includeBaselineReadGuard so reads keep their
  // lower bar at dispatch and re-assert here in their executors, exactly like
  // the baseline desync guard.
  const midPopulation =
    includeBaselineReadGuard &&
    graphRootMidPopulation({
      liveNodeCount: nodeCount,
      activeWorkflow,
      inSubgraph,
      postReconnectWindow,
    });
  // #696/#663/#701/#702 — a content difference is only WRONG-CANVAS evidence when
  // it is STRUCTURAL. On a root that positively carries this workflow's identity
  // and reproduces every structural surface, the residue is a widget the canvas
  // rewrote itself between ChangeTracker captures (see
  // graphRootContentDriftOnBoundCanvas): the right canvas, drifted — and refusing
  // it blocked every read and write with no recovery, because the remedy's own
  // repaint re-created the same drift.
  //
  // The structural answer is computed ONCE and kept, because it is also what the
  // refusal has to say when it does fire: without it a shape refusal cannot tell
  // "a different graph" from "this graph, drifted, with no identity stamp", and
  // the old message resolved that ambiguity by asserting the worse one.
  //
  // #1187 — the `structureMatches` conjunct alone cannot rescue a structural HAND
  // EDIT: adding a node or a wire makes the structural comparison false by
  // definition, so on a clean tab inside ChangeTracker's capture lag the
  // workflow's own identity stamp never rescued the read and every graph tool
  // refused the right canvas (docs/design/graph-binding-tag-vs-tracker.md records
  // the two rejected fixes — dropping the conjunct, settling the tracker — and why
  // both fail open). What rescues it instead is a CONTENT proof with the same
  // conjunct discipline: the live root must still CONTAIN the workflow's whole
  // structure (`graphRootStructureExtendsActiveWorkflow`), so nothing the workflow
  // owns can be absent from a canvas this admits, and the identity tag is never
  // trusted without it.
  const contentDiffers = graphRootMismatchesActiveWorkflow({ rootGraph, activeWorkflow });
  const structureMatches =
    contentDiffers && graphRootStructureMatchesActiveWorkflow({ rootGraph, activeWorkflow });
  const structureExtends =
    contentDiffers &&
    structureMatches !== true &&
    graphRootStructureExtendsActiveWorkflow({ rootGraph, activeWorkflow });
  const rootShapeMismatch =
    contentDiffers &&
    !((structureMatches || structureExtends) &&
      graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid }));
  const currentStateTrustworthy = activeWorkflow?.isModified !== true;
  const baselineReadDesync =
    currentStateTrustworthy &&
    includeBaselineReadGuard &&
    graphReadDesynced({ liveNodeCount: nodeCount, activeWorkflow, inSubgraph });
  if (rootUuidMismatch || dirtyMutationBindingUnproven || midPopulation || rootShapeMismatch || baselineReadDesync) {
    const reason = rootUuidMismatch
      ? "root-workflow-uuid-mismatch"
      : dirtyMutationBindingUnproven
        ? "dirty-mutation-binding-unproven"
        : midPopulation
          ? "root-mid-population"
          : rootShapeMismatch
            ? "root-shape-mismatch"
            : "root-node-count-desync";
    return {
      reason,
      // The mid-population count must come from the CURRENT state alone — the
      // load baseline is not evidence the canvas is behind (#618).
      expected: midPopulation
        ? activeWorkflowCurrentNodeCount(activeWorkflow)
        : activeWorkflowNodeCount(activeWorkflow),
      live: nodeCount,
      // Only meaningful for the shape verdict, and only ever a POSITIVE `true`:
      // a comparison that could not run leaves it false, which the message reads
      // as "unestablished", never as "they differ".
      ...(reason === "root-shape-mismatch" ? { structureMatches: structureMatches === true } : {}),
    };
  }
  if (graphEmptyBindingUnproven({ graph, rootGraph, activeWorkflow, activeWorkflowUuid, graphLoading })) {
    return { reason: "empty-binding-unproven", expected: activeWorkflowNodeCount(activeWorkflow) };
  }
  return null;
}

/**
 * The caller-facing refusal text for a `resolveGraphBindingVerdict` result. Kept
 * next to the predicates so the claim and the evidence cannot drift apart.
 *
 * Every message states that the command was NOT applied. That claim is only ever
 * TRUE because every caller asserts BEFORE doing any work — a caller that has
 * already mutated something must disclose, not refuse (a refusal for work that
 * landed invites a destructive retry, which is #603's duplicate-node cascade).
 * (#618 later added a third, mid-population, verdict on the same terms.)
 */
export function graphBindingRefusalMessage(verdict) {
  if (!verdict) return null;
  if (verdict.reason === "root-mid-population") {
    // #618 — disclose the uncertainty, don't narrate the bucket as a cause: a
    // count-short canvas in the reconnect window is USUALLY a tab still
    // restoring, but it can also be a genuine wrong canvas, so the message
    // names the settle-and-recheck path that resolves both.
    return (
      `[root-mid-population] The live root canvas shows ${verdict.live} node(s), but the active workflow's ` +
      `own current state reports ${verdict.expected} node(s). ComfyUI reconnected moments ago, so the canvas ` +
      `may still be restoring the tab — a partial canvas read as complete is how duplicate nodes and ` +
      `wrong-graph edits happen — so this command was NOT applied as authoritative. Retry in a moment once ` +
      `the tab finishes settling; if the count never catches up, re-open the active workflow tab ` +
      `(panel_open_workflow) or reload the panel to rebind the graph, then retry.`
    );
  }
  if (verdict.reason === "empty-binding-unproven") {
    return (
      `[empty-binding-unproven] The live root canvas reads EMPTY, but the active workflow's own ` +
      `state cannot prove it is genuinely empty — the tab may still be loading after a switch, ` +
      `reconnect, or a failed open, and node_count 0 could be a FALSE-EMPTY reading, so this ` +
      `command was NOT applied as authoritative. Retry in a moment once the tab settles; if it ` +
      `persists, re-open the workflow tab (panel_open_workflow) or reload the panel.`
    );
  }
  // #606 — name the firing predicate honestly, and order the remedies by which
  // one to try first. panel_open_workflow rebinds in place; a panel reload is the
  // broader fallback when re-opening does not clear it — earlier text sent the
  // agent to open_workflow with no hint that the reload exists, and phrased a
  // 0-node expectation as "the workflow reports 0 node(s), but the canvas is bound
  // to a different graph", which reads as nonsense for a genuinely-empty tab.
  //
  // NEITHER remedy is promised to SUCCEED, and the text must not imply one (codex
  // gate, two rounds). It first said a reload "always re-establishes the binding",
  // then "rebuilds the binding from scratch" — both unconditional claims about an
  // outcome nothing here observes. panel_reload asks the browser to navigate and
  // returns; there is no post-reload binding receipt anywhere, and a reload that
  // never happens, or that restores the same stale state, would leave the agent
  // retrying on the strength of a repair it was told had already occurred. So the
  // remedy names the ACTION and says plainly that it is unconfirmed — the caller
  // learns whether it worked from the retry, the only thing that can tell.
  const remedy =
    `Re-open the active workflow tab (panel_open_workflow) to rebind the graph in place; if that ` +
    `does not clear it, reload the panel (panel_reload scope:frontend), then retry. The reload is ` +
    `REQUESTED, NOT CONFIRMED — the panel cannot observe whether it rebound the canvas, so treat ` +
    `the retry's own result as the answer rather than assuming the binding was repaired. ` +
    // #663 — agents burned retries on the WRONG recovery signal: panel_set_workflow_target
    // only re-points which workflow the agent session follows; it never touches the
    // canvas binding this guard checks, so its success response does not mean the
    // desync is resolved. Say so, so the retry budget goes to the remedies that can work.
    `Re-targeting with panel_set_workflow_target is NOT a remedy for this — it re-points the ` +
    `session, it does not rebind the canvas.`;
  if (verdict.reason === "root-workflow-uuid-mismatch") {
    // The predicate observed TWO TAGS THAT DISAGREE and nothing else. The earlier
    // text went on to narrate "a load, tab switch, or reconnect left a stale tag
    // behind" — a cause nobody watched happen, and one of several (a stranded
    // canvas from a closed tab reads identically). Same defect as the shape
    // message's wrong-canvas sentence, one branch over: state the observation,
    // offer the usual causes as possibilities rather than as the finding.
    return (
      `[root-workflow-uuid-mismatch] The live canvas carries a different workflow's identity tag ` +
      `than the active workflow, so this command was NOT applied. What the panel observed is the ` +
      `disagreement itself, not what produced it — a load, tab switch or reconnect leaving a stale ` +
      `tag behind is the usual explanation, but none of them was witnessed here. ${remedy}`
    );
  }
  // #601 — name the ACTUAL failing predicate. This verdict is not a node-count
  // or wrong-canvas finding: the tab is dirty and the live canvas carries no
  // identity stamp (a page reload rebuilds the canvas WITHOUT the stamp the
  // saved file carries), so binding is UNPROVEN, not disproven. Reporting the
  // generic "reports N node(s)" text here sent two real diagnoses down wrong
  // paths. The remedy that works from here: reload the tab / re-open the
  // workflow — while the tab is CLEAN the panel now seals the proven binding
  // onto the canvas (sealProvenRootBinding), so the retried mutation clears.
  if (verdict.reason === "dirty-mutation-binding-unproven") {
    return (
      `[dirty-mutation-binding-unproven] The active tab has unsaved changes and the live canvas ` +
      `carries no identity stamp proving it belongs to this workflow (a page reload rebuilds the ` +
      `canvas without the stamp the saved file carries), so the canvas COULD be a stale graph from ` +
      `another tab and this mutation was NOT applied. Reload the ComfyUI browser tab or re-open the ` +
      `workflow (panel_open_workflow) — while the tab is clean the panel re-seals the proven ` +
      `binding onto the canvas — then retry. If the refusal instead says "multiple_active_tabs", ` +
      `that is a different guard (two browser tabs share one agent session) with a different ` +
      `remedy: close the extra tab.`
    );
  }
  // #701/#702 — SAY WHAT WAS MEASURED, AND ONLY THAT.
  //
  // The verdict already carried the LIVE count and the message threw it away, then
  // asserted "a load, tab switch, or reconnect left this command pointed at the
  // wrong canvas" from the half it kept. In every report in this cluster the two
  // counts were EQUAL and the difference was a widget the canvas rewrote itself,
  // so that sentence narrated a cause nobody observed — and three diagnoses went
  // hunting a wrong-tab bug that was not there.
  //
  // Three distinct observations now get three distinct sentences:
  //   sizes DISAGREE          → the canvas provably holds a different graph;
  //   structure MATCHES       → the canvas reproduces this workflow's node set,
  //                             links and groups exactly, and only its content and
  //                             its identity stamp are unestablished. That is the
  //                             one case where the ONLY thing missing is proof,
  //                             and it names the remedy that supplies it;
  //   anything else           → the contents disagree and the panel does not know
  //                             which of the two it is looking at. Say that.
  const expected = Number(verdict.expected);
  const live = Number(verdict.live);
  const measured = Number.isFinite(live) && Number.isFinite(expected);
  const sizesDisagree = measured && expected > 0 && live !== expected;
  if (verdict.reason === "root-shape-mismatch" && verdict.structureMatches === true && !sizesDisagree) {
    return (
      `[root-shape-mismatch] The live canvas reproduces this workflow's STRUCTURE exactly — same ` +
      `node ids and types${measured ? ` (${expected})` : ""}, same links, groups and subgraphs — but its ` +
      `CONTENT differs from the state the workflow last captured, and the canvas carries no identity ` +
      `stamp proving it is this workflow's. A canvas whose widgets a node rewrote itself (a populate/ ` +
      `wildcard node, control_after_generate, a bypass toggle) looks exactly like a DUPLICATE tab's ` +
      `canvas from here, and the panel cannot tell them apart, so this command was NOT applied. ` +
      `Re-open the active workflow tab (panel_open_workflow): its repaint is the one path that can ` +
      `put this workflow's identity on the canvas, which is the proof this refusal is missing. ` +
      `Whether it lands is REQUESTED, NOT CONFIRMED — the open reports its own rebind verdict and the ` +
      `panel cannot observe the outcome otherwise, so treat the retry's own result as the answer. If ` +
      `it still refuses, do NOT read that as proof the difference is more than content: an open that ` +
      `could not prove its rebind leaves this refusal exactly where it was. A panel reload ` +
      `(panel_reload scope:frontend) is the next step, and it is unconfirmed on the same terms. ` +
      `Re-targeting with panel_set_workflow_target is NOT a remedy for this — it re-points the ` +
      `session, it does not rebind the canvas.`
    );
  }
  // #803 — an EMPTY baseline against a populated canvas is not evidence of a different
  // graph. The panel captures a workflow's state on user input, so a reconnect or a
  // ComfyUI restart can leave it empty for a canvas that is perfectly correct. Asserting
  // "bound to a different graph" here is the #796 shape: cannot-determine rendered as
  // is-not-the-case. What gets REFUSED is unchanged (#565 rejected a zero-node skip);
  // only the claim is.
  const emptyBaseline = sizesDisagree && isEmptyBaselineMismatch({ expected, live });
  const expectation = emptyBaseline
    ? emptyBaselineNote(live)
    : sizesDisagree
    ? `the workflow reports ${expected} node(s) but the live canvas holds ${live} — it is bound to a ` +
      `different graph`
    : measured && expected > 0
      ? `both the workflow and the live canvas report ${expected} node(s), but the canvas does not ` +
        `reproduce the workflow's own state — the difference is in the graph's CONTENT, not its size`
      : expected > 0
        ? `the workflow reports ${expected} node(s) and the live count was not measured here`
        : `the canvas's content does not match the active workflow's own state`;
  // Neither branch narrates an EVENT. A size disagreement establishes the canvas
  // holds a different graph — it does not establish what put it there, and the
  // load/switch/reconnect list is a set of usual explanations, not the finding
  // (codex gate r3; the same defect the uuid-mismatch branch had). A content
  // disagreement at equal size does not even establish that much: it is exactly
  // the ambiguity above, and resolving it in the text is how this message misled
  // three readers.
  const cause = emptyBaseline
    ? ""
    : sizesDisagree
    ? `The canvas therefore holds a graph other than the one the workflow describes, so this ` +
      `command was NOT applied. A load, tab switch or reconnect leaving the command on the wrong ` +
      `canvas is the usual explanation — the panel observed the mismatch, not the event.`
    : `The panel cannot tell whether this is a DIFFERENT workflow's canvas or this workflow's own ` +
      `canvas drifted from the state it last captured, so it was NOT applied.`;
  // #803 — the remedy is REPLACED for the empty-baseline case, not appended to. The
  // standing advice ("re-open the active workflow tab") is what turned this into a
  // dead end: the captured state is refreshed only after a command SUCCEEDS, so while
  // this refusal stands the repair that would refresh it is itself blocked, and the
  // retry fails identically. A reload is the step known to break the loop.
  const finalRemedy = emptyBaseline ? emptyBaselineRemedy() : remedy;
  // Join the non-empty parts rather than collapsing whitespace across the whole
  // string. The collapse was only there to absorb the empty `cause` in this branch,
  // and review was right that it overreached: it rewrote INTERPOLATED content too
  // (verdict.reason, the existing remedy), so a value carrying meaningful newlines or
  // repeated spaces would have been silently reflowed. This change is scoped to the
  // claim and the remedy; it has no business touching either of those.
  const parts = [emptyBaseline ? expectation : `${expectation}.`, cause, finalRemedy].filter(
    (s) => typeof s === "string" && s.trim() !== "",
  );
  return `[${verdict.reason}] The live graph is out of sync with the active workflow: ${parts.join(" ")}`;
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
