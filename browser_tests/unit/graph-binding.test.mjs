/**
 * Unit tests for panel#389 — detect a graph READ that is out of sync with the
 * active workflow (empty live root graph while the workflow reports nodes).
 *
 * The read tools count nodes off LiteGraph's live `app.graph._nodes`, while
 * "active / modified / missing-model" come from separate Vue/Pinia stores. When a
 * load / tab-switch / post-reconnect rebuild leaves the read bound to an empty
 * graph object, `node_count: 0` is returned while the workflow is still active with
 * red nodes — a silent false-clean. These lock the pure detection the panel's
 * read-tool guard throws on, and prove it NEVER fires for a genuinely-empty graph.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  activeWorkflowNodeCount,
  activeWorkflowCurrentNodeCount,
  activeWorkflowProvenEmpty,
  graphEmptyBindingUnproven,
  graphReadDesynced,
  graphRootMidPopulation,
  graphRootMismatchesActiveWorkflow,
  graphRootContentDriftOnBoundCanvas,
  graphRootStructureExtendsActiveWorkflow,
  graphRootProvenEmpty,
  graphRootWorkflowUuidMismatches,
  graphRootWorkflowUuidMatches,
  graphRootMatchesState,
  graphCommandMayMutateWorkflow,
  graphCommandBindingBar,
  graphBindingRefusalMessage,
  resolveGraphBindingVerdict,
  MUTATION_BINDING_BAR,
  graphReadBindingChanged,
  resolveGraphRootUuidRebind,
  sealProvenRootBinding,
  rootContentProvesActiveWorkflow,
  rootContentProvesActiveWorkflowDespiteEdits,
  contentProofExclusiveAmongOpen,
  serializedStateProvenEmpty,
} from "../../web/js/lib/graph-binding.js";
import {
  commandWorkflowMismatch,
  hasEmbeddedUuidSuccessionEvidence,
  isNewWorkflowLoad,
  rawWorkflowObject,
  sameWorkflowObject,
  shouldCarryIdentityAcrossSaveSwap,
  shouldForkEmbeddedUuidForLiveOwner,
  shouldForkEmbeddedWorkflowUuid,
  shouldForkInPlaceReload,
  workflowAliasForPath,
} from "../../web/js/lib/workflow-chat-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** Index of `function <name>(`, INCLUDING a preceding `async ` when present —
 *  without it an extracted async function loses its keyword and its `await`
 *  becomes a syntax error inside `new Function`. */
function panelFunctionStart(src, name, from = 0) {
  const bare = src.indexOf(`function ${name}(`, from);
  assert.notEqual(bare, -1, `could not locate ${name} in panel source`);
  const asyncAt = bare - "async ".length;
  return asyncAt >= 0 && src.startsWith("async ", asyncAt) ? asyncAt : bare;
}

function panelFunctionSource(src, name, nextName) {
  const start = panelFunctionStart(src, name);
  const end = panelFunctionStart(src, nextName, start + 1);
  assert.ok(end > start, `could not locate ${nextName} after ${name}`);
  return src.slice(start, end);
}

// Vue-faithful reactive proxy: real Vue proxies expose the raw target as
// __v_raw. A purely transparent Proxy has no raw back-pointer, so an
// inspection-based identity check could never match it to a carrier-less object
// — that combination is a test artifact, not a Vue behavior (r3).
const vueProxyOf = (raw) => new Proxy(raw, { get: (t, k) => (k === "__v_raw" ? t : t[k]) });

// r11 — the panel's per-object identity store is accessed ONLY through
// raw-keyed helpers; harnesses inject equivalents backed by their own WeakMap.
const rawKeyedUuidStore = (map) => ({
  workflowObjectUuid: (wf) => map.get(rawWorkflowObject(wf)),
  setWorkflowObjectUuid: (wf, id) => map.set(rawWorkflowObject(wf), id),
  deleteWorkflowObjectUuid: (wf) => map.delete(rawWorkflowObject(wf)),
});

// foreignClaim models WHETHER a live open tab claims the root tag when it
// conflicts with the active workflow's identity (#349/#545/#557):
//   "identity"              — tab B is OPEN and the root-blind resolver returns
//                             the tag for it: the guard must keep throwing;
//   "tracker-stamp"         — tab B is OPEN, the resolver mints a DIFFERENT
//                             identity for it, but B's OWN serialized state still
//                             carries the tag (an unregistered creation stamp):
//                             the guard must keep throwing;
//   "unloaded-proxy-owner"  — tab B is OPEN but only as a Vue-style PROXY, its
//                             serialized state is NOT populated (unloaded), and
//                             the resolver mints a different identity; only the
//                             registered owner map ties it to the tag (#558 r2):
//                             the guard must keep throwing;
//   "same-path-overlap"     — A and B are DISTINCT live objects at the SAME path
//                             (a closed→reopened overlap, #558 r3): path equality
//                             must NOT exempt B from the foreign-claim check;
//   "active-lineage"        — the tag's REGISTERED OWNER is the active object
//                             itself (object-keyed lineage, the #545/#557
//                             drifted-identity heal case): the guard rebinds;
//   "stale-lineage"         — the active object's LAGGING tracker state still
//                             carries the tag (replaced-predecessor residue,
//                             r6 P0): NOT object-keyed, must NOT count — the
//                             guard must keep throwing;
//   "none"                  — NOBODY claims the tag (a closed tab's leftover
//                             canvas, r5): the guard must keep throwing.
// foreignTab overrides the B object (e.g. a creation-lifecycle product), and
// registeredOwners/objectUuids override the identity stores the harness wires in.
// activeNodeCount/rootNodeCount/activeModified parameterize A and the root so
// the #560 (drifted tag on a matching clean canvas) and #565 (both sides
// empty) recurrence scenarios can reuse this wiring; defaults preserve the
// original dirty-A (27) / foreign-root-B (30) setup exactly.
function buildDirtyStaleRouteHarness({
  rootUuid = "workflow-B",
  foreignClaim = "identity",
  foreignTab = null,
  registeredOwners = null,
  objectUuids: objectUuidsOpt = null,
  activeNodeCount = 27,
  rootNodeCount = 30,
  activeModified = true,
  activeTracker,
  rootSerializer = null,
  postReconnectWindow = false,
} = {}) {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const stableSource = panelFunctionSource(src, "workflowStableUuid", "workflowStorageKey");
  const fenceSource = panelFunctionSource(src, "assertGraphBoundToActiveWorkflow", "getPiniaStore");
  const ownsTagSource = panelFunctionSource(src, "workflowOwnsRootUuidTag", "assertGraphBoundToActiveWorkflow");
  const overlap = foreignClaim === "same-path-overlap";
  const lineage = foreignClaim === "active-lineage";
  const staleLineage = foreignClaim === "stale-lineage";
  const workflowA = overlap
    ? { isPersisted: true, path: "workflows/a.json", isModified: activeModified, changeTracker: { activeState: state(activeNodeCount) } }
    : {
        isPersisted: false,
        isModified: activeModified,
        // activeTracker is deliberately NOT `??`-defaulted: an explicit null
        // models a workflow whose tracker is entirely unreadable, which the
        // proven-empty relaxation must treat as fail-closed (#565 gate).
        changeTracker: activeTracker !== undefined ? activeTracker : {
          activeState: {
            ...state(activeNodeCount),
            // "stale-lineage" (r6 P0): the active object's tracker state is
            // LAGGING — it still carries an OLD uuid (a replaced predecessor's
            // residue). Serialized-state evidence is not object-keyed, so this
            // must NOT count as an active-lineage claim.
            ...(staleLineage && rootUuid ? { extra: { comfyui_mcp: { workflow_uuid: rootUuid } } } : {}),
          },
        },
      };
  const rawB =
    foreignTab ??
    {
      isPersisted: true,
      path: overlap ? "workflows/a.json" : "workflows/b.json", // overlap: same file, NEW object
      changeTracker:
        foreignClaim === "unloaded-proxy-owner"
          ? null // a live tab whose serialized state is NOT loaded
          : {
              activeState: {
                ...state(rootNodeCount),
                // A creation-stamped graph carries the tag in the tab's own
                // serialized state even when no resolver/owner record observed it.
                ...(foreignClaim === "tracker-stamp" && rootUuid
                  ? { extra: { comfyui_mcp: { workflow_uuid: rootUuid } } }
                  : {}),
              },
            },
    };
  // The repo's store-double idiom (workflow-save.test.mjs): openWorkflows holds
  // PROXIES while the identity stores key on RAW objects.
  const proxyB = vueProxyOf(rawB);
  const rootB = {
    _nodes: Array.from({ length: rootNodeCount }, (_, i) => ({ id: i + 1, type: "KSampler" })),
    ...(rootUuid ? { extra: { comfyui_mcp: { workflow_uuid: rootUuid } } } : {}),
    // The proven-empty relaxation requires a SERIALIZABLE root whose full
    // non-identity surfaces are all empty (#565 gate): a bare empty _nodes
    // array is node-level evidence only and must not relax the guard.
    ...(rootSerializer ? { serialize: rootSerializer } : {}),
  };
  const openWorkflows =
    foreignClaim === "none" || foreignClaim === "active-lineage" || foreignClaim === "stale-lineage"
      ? [workflowA]
      : foreignClaim === "unloaded-proxy-owner"
        ? [workflowA, proxyB]
        : [workflowA, rawB];
  const registeredOwnersMap =
    registeredOwners ??
    new Map(
      foreignClaim === "unloaded-proxy-owner" && rootUuid
        ? [[rootUuid, rawB]]
        : foreignClaim === "active-lineage" && rootUuid
          ? [[rootUuid, workflowA]] // the tag's registered owner IS the active object
          : [],
    );
  const objectUuids = objectUuidsOpt ?? new WeakMap();
  const uuidStore = rawKeyedUuidStore(objectUuids);
  let minted = 0;
  const stableUuidA = new Function(
    "app",
    "getTabId",
    "savedWorkflowPath",
    "workflowObjectUuid",
    "setWorkflowObjectUuid",
    "embeddedWorkflowUuid",
    "resolveUnsavedInstanceUuid",
    "_loadGraphDataForkInstalled",
    "rememberWorkflowUuidOwner",
    "workflowOwnedExtra",
    "crypto",
    "sameWorkflowObject",
    `${stableSource}\nreturn workflowStableUuid;`,
  )(
    { graph: rootB },
    () => "fallback-tab",
    () => null,
    uuidStore.workflowObjectUuid,
    uuidStore.setWorkflowObjectUuid,
    (_wf, { allowGraph }) => (allowGraph ? rootB.extra?.comfyui_mcp?.workflow_uuid : null),
    ({ objectUuid, embeddedId, forkActive }) => objectUuid || (forkActive && embeddedId) || `workflow-A-${++minted}`,
    true,
    () => {},
    () => null,
    { randomUUID: () => `workflow-A-${++minted}` },
    sameWorkflowObject,
  );
  // Per-tab established identities as the real resolver would produce them: A
  // through the real (unsaved-branch) source; B returns its recorded identity —
  // under "identity"/"same-path-overlap" that IS the root tag; otherwise the
  // resolver mints a different identity and never observed B's stamp. The real
  // resolver consults the per-object cache FIRST, so a creation-registered tab
  // (its cache seeded at load, r3) resolves to its stamp even here.
  const stableUuid = (wf) => {
    if (wf === rawB || wf === proxyB) {
      const cached = objectUuids.get(wf) ?? objectUuids.get(rawB);
      if (cached) return cached;
      return foreignClaim === "identity" || foreignClaim === "same-path-overlap" ? rootUuid : "workflow-B-minted";
    }
    return stableUuidA(wf);
  };
  const ownsTag = new Function(
    "workflowStableUuid",
    "rawWorkflowObject",
    "sameWorkflowObject",
    "workflowUuidOwner",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    `${ownsTagSource}\nreturn workflowOwnsRootUuidTag;`,
  )(
    stableUuid,
    rawWorkflowObject,
    sameWorkflowObject,
    (id) => registeredOwnersMap.get(id) ?? null,
    "comfyui_mcp",
    "workflow_uuid",
  );
  const assertBound = new Function(
    "activeWorkflowRef",
    "workflowObjectUuid",
    "workflowStableUuid",
    "graphRootWorkflowUuidMismatches",
    "resolveGraphBindingVerdict",
    "graphBindingRefusalMessage",
    "activeWorkflowProvenEmpty",
    "graphRootProvenEmpty",
    "workflowOwnsRootUuidTag",
    "rememberWorkflowUuidOwner",
    "resolveGraphRootUuidRebind",
    "postReconnectSettleWindow",
    "sealProvenRootBinding",
    "rootContentProvesActiveWorkflow",
    "rootContentProvesActiveWorkflowDespiteEdits",
    "contentProofExclusiveAmongOpen",
    "graphRootMatchesState",
    "sameWorkflowObject",
    "app",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    `${fenceSource}\nreturn assertGraphBoundToActiveWorkflow;`,
  )(
    () => workflowA,
    uuidStore.workflowObjectUuid,
    stableUuid,
    graphRootWorkflowUuidMismatches,
    resolveGraphBindingVerdict,
    graphBindingRefusalMessage,
    activeWorkflowProvenEmpty,
    graphRootProvenEmpty,
    ownsTag,
    () => {},
    resolveGraphRootUuidRebind,
    // #618 — the extracted fence reads the reconnect window through this hook;
    // harnesses default to OUTSIDE the window and opt in explicitly.
    () => postReconnectWindow === true,
    sealProvenRootBinding,
    rootContentProvesActiveWorkflow,
    rootContentProvesActiveWorkflowDespiteEdits,
    contentProofExclusiveAmongOpen,
    graphRootMatchesState,
    sameWorkflowObject,
    { graph: rootB, extensionManager: { workflow: { openWorkflows } } },
    "comfyui_mcp",
    "workflow_uuid",
  );
  return { src, workflowA, rawB, proxyB, rootB, objectUuids, stableUuid, assertBound };
}

// #557 — the SAVED branch of workflowStableUuid after a save replaced the active
// ComfyWorkflow object: the successor parses the pre-save embedded uuid from the
// just-saved file while the replaced object is still its registered owner.
// currentPath/embeddedPath/aliases are parameterizable so a genuine co-open COPY
// (different path, same embedded uuid) can be distinguished from a same-path
// save-swap successor. ownerOpen: false | true | "proxy" — "proxy" models the
// live owner appearing in openWorkflows only as a Vue-style proxy (#558 r2).
function buildSavedSuccessorHarness({
  ownerOpen = false,
  currentPath = "workflows/x.json",
  embeddedPath = "workflows/x.json",
  aliases = { "workflows/x.json": "11111111-1111-4111-8111-111111111111" },
} = {}) {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const stableSource = panelFunctionSource(src, "workflowStableUuid", "workflowStorageKey");
  const U1 = "11111111-1111-4111-8111-111111111111";
  const replaced = { isPersisted: true, path: "workflows/x.json" };
  const successor = { isPersisted: true, path: currentPath };
  const owners = new Map([[U1, replaced]]);
  const objectUuids = new WeakMap();
  let minted = 0;
  const openWorkflows =
    ownerOpen === true
      ? [replaced, successor]
      : ownerOpen === "proxy"
        ? [vueProxyOf(replaced), successor]
        : [successor];
  const stableUuid = new Function(
    "app",
    "getTabId",
    "savedWorkflowPath",
    "workflowObjectUuid",
    "setWorkflowObjectUuid",
    "embeddedWorkflowUuid",
    "embeddedWorkflowPath",
    "workflowAliasForPath",
    "workflowUuidOwner",
    "rememberWorkflowUuidOwner",
    "shouldForkEmbeddedWorkflowUuid",
    "shouldForkEmbeddedUuidForLiveOwner",
    "hasEmbeddedUuidSuccessionEvidence",
    "resolveUnsavedInstanceUuid",
    "_loadGraphDataForkInstalled",
    "workflowOwnedExtra",
    "currentWorkflowRef",
    "_workflowUuidAliases",
    "persistWorkflowAliases",
    "workflowAliasMutationSink",
    "crypto",
    "sameWorkflowObject",
    `${stableSource}\nreturn workflowStableUuid;`,
  )(
    { extensionManager: { workflow: { openWorkflows } } },
    () => "fallback-tab",
    (wf) => (wf?.isPersisted === true && wf?.isTemporary !== true && typeof wf?.path === "string" ? wf.path : null),
    rawKeyedUuidStore(objectUuids).workflowObjectUuid,
    rawKeyedUuidStore(objectUuids).setWorkflowObjectUuid,
    () => U1, // the just-saved file carries the pre-save embedded uuid
    () => embeddedPath,
    workflowAliasForPath,
    (id) => owners.get(id) ?? null,
    (id, owner) => owners.set(id, owner),
    shouldForkEmbeddedWorkflowUuid,
    shouldForkEmbeddedUuidForLiveOwner,
    hasEmbeddedUuidSuccessionEvidence,
    ({ objectUuid, embeddedId, forkActive }) => objectUuid || (forkActive && embeddedId) || `fresh-${++minted}`,
    true,
    () => null,
    replaced, // currentWorkflowRef still points at the pre-save object (600ms poll hasn't run)
    aliases,
    () => {},
    null,
    { randomUUID: () => `fresh-${++minted}` },
    sameWorkflowObject,
  );
  return { stableUuid, successor, replaced, owners, objectUuids, U1 };
}

// A ComfyUI ChangeTracker-shaped workflow: serialized graph states hang off
// `changeTracker.activeState` / `.initialState` (and some builds hang them flat).
const wf = (over = {}) => ({ changeTracker: {}, ...over });
const state = (n) => ({ nodes: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) });
const typedState = (...nodes) => ({ nodes: nodes.map(([id, type]) => ({ id, type })) });
const liveRoot = (...nodes) => ({ _nodes: nodes.map(([id, type]) => ({ id, type })) });
const serializedRoot = (serialized) => ({
  _nodes: serialized.nodes.map(({ id, type }) => ({ id, type })),
  serialize: () => serialized,
});

// ── activeWorkflowNodeCount: fail-open ground truth ──────────────────────────

test("activeWorkflowNodeCount: reads activeState node count", () => {
  assert.equal(activeWorkflowNodeCount(wf({ changeTracker: { activeState: state(3) } })), 3);
});

test("activeWorkflowNodeCount: falls back to initialState when activeState is absent", () => {
  assert.equal(activeWorkflowNodeCount(wf({ changeTracker: { initialState: state(5) } })), 5);
});

test("activeWorkflowNodeCount: PREFERS activeState (unsaved-but-populated: empty initial, populated active)", () => {
  assert.equal(
    activeWorkflowNodeCount(wf({ changeTracker: { initialState: state(0), activeState: state(2) } })),
    2,
  );
});

test("activeWorkflowNodeCount: honors a well-formed activeState of ZERO — NOT the max (the graph_clear case, codex P1)", () => {
  // After a legitimate graph_clear, activeState→0 while the load baseline initialState
  // still holds nodes. A MAX would falsely report an expectation and throw a desync.
  assert.equal(
    activeWorkflowNodeCount(wf({ changeTracker: { activeState: state(0), initialState: state(7) } })),
    0,
  );
});

test("activeWorkflowNodeCount: falls back to initialState ONLY when activeState is malformed (not merely zero)", () => {
  assert.equal(
    activeWorkflowNodeCount(wf({ changeTracker: { activeState: { nodes: "bad" }, initialState: state(4) } })),
    4,
  );
});

test("activeWorkflowNodeCount: reads flat activeState/initialState on the workflow", () => {
  assert.equal(activeWorkflowNodeCount({ activeState: state(4) }), 4);
  assert.equal(activeWorkflowNodeCount({ initialState: state(6) }), 6);
});

test("activeWorkflowNodeCount: fail-open to 0 on null/garbage/malformed shapes", () => {
  assert.equal(activeWorkflowNodeCount(null), 0);
  assert.equal(activeWorkflowNodeCount(undefined), 0);
  assert.equal(activeWorkflowNodeCount(42), 0);
  assert.equal(activeWorkflowNodeCount({}), 0);
  assert.equal(activeWorkflowNodeCount({ changeTracker: { activeState: { nodes: "x" } } }), 0);
  assert.equal(activeWorkflowNodeCount({ changeTracker: { activeState: {} } }), 0);
});

// ── graphReadDesynced: the guard predicate ───────────────────────────────────

test("graphReadDesynced: TRUE — empty live root graph while the workflow reports nodes (the bug)", () => {
  assert.equal(
    graphReadDesynced({
      liveNodeCount: 0,
      activeWorkflow: wf({ changeTracker: { activeState: state(2) } }), // e.g. nodes 345/346
    }),
    true,
  );
});

test("graphReadDesynced: FALSE — genuinely-empty / brand-new workflow reads node_count:0 as before", () => {
  assert.equal(
    graphReadDesynced({ liveNodeCount: 0, activeWorkflow: wf({ changeTracker: { activeState: state(0) } }) }),
    false,
  );
  assert.equal(graphReadDesynced({ liveNodeCount: 0, activeWorkflow: null }), false);
  assert.equal(graphReadDesynced({ liveNodeCount: 0, activeWorkflow: undefined }), false);
});

test("graphReadDesynced: FALSE — a genuinely-cleared workflow (activeState 0, initialState populated) does NOT throw", () => {
  assert.equal(
    graphReadDesynced({
      liveNodeCount: 0,
      activeWorkflow: wf({ changeTracker: { activeState: state(0), initialState: state(9) } }),
    }),
    false,
  );
});

test("graphReadDesynced: FALSE — live graph already has nodes (self-evidently bound)", () => {
  assert.equal(
    graphReadDesynced({ liveNodeCount: 5, activeWorkflow: wf({ changeTracker: { activeState: state(5) } }) }),
    false,
  );
});

test("graphReadDesynced: FALSE — descended into an empty subgraph (legitimately empty at that scope)", () => {
  assert.equal(
    graphReadDesynced({
      liveNodeCount: 0,
      inSubgraph: true,
      activeWorkflow: wf({ changeTracker: { activeState: state(10) } }),
    }),
    false,
  );
});

test("graphReadDesynced: defensive — missing args never throw, default to not-desynced", () => {
  assert.equal(graphReadDesynced(), false);
  assert.equal(graphReadDesynced({}), false);
});

test("graphRootMismatchesActiveWorkflow: TRUE - a nonempty prior tab remains on the canvas (#349)", () => {
  const activeWorkflow = wf({ changeTracker: { activeState: typedState([1, "AnimeLoader"], [2, "KSampler"]) } });
  const rootGraph = liveRoot([1, "FluxLoader"], [2, "KSampler"], [3, "SaveImage"]);
  assert.equal(graphRootMismatchesActiveWorkflow({ rootGraph, activeWorkflow }), true);
});

test("graphRootMismatchesActiveWorkflow: TRUE - same node count but a different graph shape", () => {
  const activeWorkflow = wf({ changeTracker: { activeState: typedState([1, "CheckpointLoader"], [2, "KSampler"]) } });
  const rootGraph = liveRoot([1, "FluxLoader"], [2, "KSampler"]);
  assert.equal(graphRootMismatchesActiveWorkflow({ rootGraph, activeWorkflow }), true);
});

test("graphRootMismatchesActiveWorkflow: TRUE - matching id:type nodes but different widgets or links", () => {
  const activeState = {
    nodes: [
      { id: 1, type: "CheckpointLoader", widgets_values: ["anime.safetensors"] },
      { id: 2, type: "KSampler", widgets_values: [20] },
    ],
    links: [[1, 1, 0, 2, 0, "MODEL"]],
  };
  const staleState = {
    nodes: [
      { id: 1, type: "CheckpointLoader", widgets_values: ["flux.safetensors"] },
      { id: 2, type: "KSampler", widgets_values: [35] },
    ],
    links: [],
  };
  const activeWorkflow = wf({ changeTracker: { activeState } });
  assert.equal(
    graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(staleState), activeWorkflow }),
    true,
  );
});

test("graphRootMismatchesActiveWorkflow: TRUE - ChangeTracker-relevant non-node surfaces differ", () => {
  const activeState = {
    nodes: [{ id: 1, type: "KSampler" }],
    links: [],
    floatingLinks: [{ id: "floating-a", pos: [10, 20] }],
    reroutes: [{ id: "reroute-a", pos: [30, 40] }],
    subgraphs: [{ id: "subgraph-a", nodes: [{ id: 9, type: "SaveImage" }] }],
  };
  const activeWorkflow = wf({ changeTracker: { activeState } });
  const variants = [
    ["floatingLinks", [{ id: "floating-b", pos: [10, 20] }]],
    ["reroutes", [{ id: "reroute-b", pos: [30, 40] }]],
    ["subgraphs", [{ id: "subgraph-b", nodes: [{ id: 9, type: "SaveImage" }] }]],
  ];
  for (const [field, replacement] of variants) {
    const staleState = structuredClone(activeState);
    staleState[field] = replacement;
    assert.equal(
      graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(staleState), activeWorkflow }),
      true,
      `${field} must participate in the binding comparison`,
    );
  }
});

test("graphRootMismatchesActiveWorkflow: FALSE - omitted vs present-but-empty/null tracker surfaces are serializer dialect (#560/#565)", () => {
  // ChangeTracker states routinely OMIT optional surfaces that a live
  // graph.serialize() re-emits as present-but-empty (or null). Presence
  // strictness turned that dialect into a false binding refusal on the
  // legitimately-active canvas — the #560 recurrence and the #565 latent
  // instance. Empty/null now compares EQUAL to absent…
  const activeState = { nodes: [{ id: 1, type: "KSampler" }] };
  const activeWorkflow = wf({ changeTracker: { activeState } });
  for (const [field, replacement] of [
    ["links", []],
    ["floatingLinks", []],
    ["reroutes", []],
    ["groups", []],
    ["config", {}],
    ["subgraphs", []],
    ["definitions", null],
  ]) {
    const dialectState = { ...activeState, [field]: replacement };
    assert.equal(
      graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(dialectState), activeWorkflow }),
      false,
      `${field}: present-but-empty must not be confused with workflow content`,
    );
  }
  // …but a PRESENT, NON-empty surface remains content: a canvas that genuinely
  // has reroutes / links / groups the workflow's state lacks still mismatches
  // (the #349 wrong-canvas fence is not weakened).
  for (const [field, replacement] of [
    ["links", [[1, 1, 0, 2, 0, "MODEL"]]],
    ["floatingLinks", [{ id: "floating-a", pos: [10, 20] }]],
    ["reroutes", [{ id: "reroute-a", pos: [30, 40] }]],
    ["groups", [{ id: 1, title: "group-a" }]],
    ["subgraphs", [{ id: "subgraph-a", nodes: [{ id: 9, type: "SaveImage" }] }]],
  ]) {
    const staleState = { ...activeState, [field]: replacement };
    assert.equal(
      graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(staleState), activeWorkflow }),
      true,
      `${field}: a non-empty surface the state lacks remains a real mismatch`,
    );
  }
});

test("graphRootMismatchesActiveWorkflow: FALSE - matching serialized semantic state is bound", () => {
  const activeState = {
    nodes: [{ id: 1, type: "CheckpointLoader", widgets_values: ["anime.safetensors"] }],
    links: [],
    extra: { ds: { scale: 1 } },
  };
  const activeWorkflow = wf({ changeTracker: { activeState } });
  assert.equal(
    graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(structuredClone(activeState)), activeWorkflow }),
    false,
  );
});

test("graphRootMatchesState: strict positive proof rejects a missing serializer and a same-UUID stale shape (#721)", () => {
  const wanted = state(2);
  wanted.extra = { comfyui_mcp: { workflow_uuid: "workflow-A" } };
  assert.equal(graphRootMatchesState({ rootGraph: serializedRoot(structuredClone(wanted)), state: wanted }), true);
  assert.equal(
    graphRootMatchesState({ rootGraph: serializedRoot({ ...wanted, nodes: [{ id: 1, type: "Other" }, { id: 2, type: "Other" }] }), state: wanted }),
    false,
    "the target UUID alone cannot prove a stale same-workflow root was repainted",
  );
  assert.equal(graphRootMatchesState({ rootGraph: { _nodes: [] }, state: wanted }), false, "no serializer is no success proof");
});

test("graphRootMismatchesActiveWorkflow: FALSE - node array order and viewport drift do not invent a mismatch", () => {
  const activeState = {
    nodes: [
      { id: 1, type: "CheckpointLoader", widgets_values: ["anime.safetensors"] },
      { id: 2, type: "KSampler", widgets_values: [20] },
    ],
    links: [[1, 1, 0, 2, 0, "MODEL"]],
    extra: { ds: { scale: 1, offset: [0, 0] }, workflow_meta: { owner: "artist" } },
  };
  const sameWorkflowDifferentViewport = {
    ...structuredClone(activeState),
    nodes: [...activeState.nodes].reverse(),
    extra: { ds: { scale: 1.7, offset: [125, -40] }, workflow_meta: { owner: "artist" } },
  };
  const activeWorkflow = wf({ changeTracker: { activeState } });
  assert.equal(
    graphRootMismatchesActiveWorkflow({
      rootGraph: serializedRoot(sameWorkflowDifferentViewport),
      activeWorkflow,
    }),
    false,
  );
});

test("graphRootMismatchesActiveWorkflow: FALSE - viewport-only extra matches an absent extra field", () => {
  const activeState = { nodes: [{ id: 1, type: "KSampler", widgets_values: [20] }], links: [] };
  const liveState = {
    ...structuredClone(activeState),
    extra: { ds: { scale: 2, offset: [33, -17] } },
  };
  const activeWorkflow = wf({ changeTracker: { activeState } });
  assert.equal(
    graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(liveState), activeWorkflow }),
    false,
  );
});

test("graphRootMismatchesActiveWorkflow: FALSE - matching root shape is bound, independent of node order", () => {
  const activeWorkflow = wf({ changeTracker: { activeState: typedState([1, "CheckpointLoader"], [2, "KSampler"]) } });
  const rootGraph = liveRoot([2, "KSampler"], [1, "CheckpointLoader"]);
  assert.equal(graphRootMismatchesActiveWorkflow({ rootGraph, activeWorkflow }), false);
});

test("graphRootMismatchesActiveWorkflow: FALSE - absent or partial state is inconclusive, never a false refusal", () => {
  const rootGraph = liveRoot([1, "CheckpointLoader"]);
  assert.equal(graphRootMismatchesActiveWorkflow({ rootGraph, activeWorkflow: null }), false);
  assert.equal(
    graphRootMismatchesActiveWorkflow({
      rootGraph: { _nodes: [{ id: 1 }] },
      activeWorkflow: wf({ changeTracker: { activeState: typedState([1, "CheckpointLoader"]) } }),
    }),
    false,
  );
});

test("graphRootMismatchesActiveWorkflow: FALSE - initialState is a baseline, not a false stale-current comparison", () => {
  const baseline = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: [20] }],
    links: [],
  };
  const legitimateUnsavedLiveState = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: [30] }],
    links: [],
  };
  const activeWorkflow = wf({ changeTracker: { initialState: baseline } });
  assert.equal(
    graphRootMismatchesActiveWorkflow({
      rootGraph: serializedRoot(legitimateUnsavedLiveState),
      activeWorkflow,
    }),
    false,
  );
});

// ── #696/#663/#701/#702 — CONTENT DRIFT ON A POSITIVELY-BOUND CANVAS ─────────
//
// The shape guard compares the live root's FULL serialized node content against
// ChangeTracker's `activeState` and treats ANY difference as "the canvas is bound
// to a different graph". That inference does not hold, and the panel's own source
// says why: ComfyUI's ChangeTracker "snapshots on USER input events only" (the
// comment on the post-command `deferChangeTrackerSnapshot` wiring). So a widget a
// node rewrites WITHOUT user input — Impact-Pack's ImpactWildcardEncode in
// `populate` mode, `control_after_generate`, an rgthree mode toggle, any
// `loadedGraphNode` hook — drifts the live root away from `activeState` while the
// tab still reads `isModified: false`. The tab is clean, the canvas is the right
// canvas, and every graph read and write is refused.
//
// It is also SELF-REINFORCING, which is what turned it into "the remedy does not
// remedy" (#701/#702): the tracker is only re-captured after a command SUCCEEDS,
// and `workflow_open`'s repaint re-runs the very hook that rewrites the widget, so
// its own content proof fails, its tracker re-baseline is skipped, and the next
// read fails identically. Nothing short of a page reload breaks the loop.
//
// The fix is the EVIDENCE, not the verdict: a content difference is only proof of
// a WRONG CANVAS when it is STRUCTURAL. A difference confined to per-node mutable
// content, on a root that POSITIVELY carries this workflow's identity, is drift on
// the right canvas.
const driftFixture = ({
  uuid = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  rootUuid = uuid,
  drift = (nodes) => {
    nodes[1].widgets_values[1] = "a sorceress"; // the populate rewrite
    nodes[2].widgets_values[0] = 124; // control_after_generate bumped the seed
  },
  mutateLive = () => {},
} = {}) => {
  const trackerState = {
    nodes: [
      { id: 1, type: "CheckpointLoaderSimple", widgets_values: ["anime.safetensors"] },
      { id: 2, type: "ImpactWildcardEncode", widgets_values: ["__character__", "a knight"] },
      { id: 3, type: "KSampler", widgets_values: [123, "fixed", 20] },
    ],
    links: [[1, 1, 0, 3, 0, "MODEL"]],
    groups: [{ title: "sampling", bounding: [0, 0, 10, 10] }],
  };
  const liveSerialized = structuredClone(trackerState);
  drift(liveSerialized.nodes, liveSerialized);
  mutateLive(liveSerialized);
  const rootGraph = {
    _nodes: liveSerialized.nodes.map(({ id, type }) => ({ id, type })),
    serialize: () => liveSerialized,
    ...(rootUuid ? { extra: { comfyui_mcp: { workflow_uuid: rootUuid } } } : {}),
  };
  return {
    rootGraph,
    activeWorkflowUuid: uuid,
    activeWorkflow: wf({ isModified: false, changeTracker: { activeState: trackerState } }),
  };
};

const driftVerdict = (fixture, over = {}) =>
  resolveGraphBindingVerdict({
    graph: fixture.rootGraph,
    rootGraph: fixture.rootGraph,
    activeWorkflow: fixture.activeWorkflow,
    activeWorkflowUuid: fixture.activeWorkflowUuid,
    liveNodeCount: fixture.rootGraph._nodes.length,
    includeBaselineReadGuard: true,
    requireDirtyMutationBinding: true,
    ...over,
  });

test("#696: a widget a node rewrote itself is NOT a wrong canvas — the bound root is permitted", () => {
  const fixture = driftFixture();
  assert.equal(
    graphRootMismatchesActiveWorkflow({ rootGraph: fixture.rootGraph, activeWorkflow: fixture.activeWorkflow }),
    true,
    "the raw content comparator still reports the difference — that is its job",
  );
  assert.equal(
    graphRootContentDriftOnBoundCanvas(fixture),
    true,
    "…but with the workflow's identity on the root and every structural surface equal, " +
      "the difference is drift on the RIGHT canvas, not evidence of another one",
  );
  assert.equal(
    driftVerdict(fixture),
    null,
    "a read AND a mutation on a positively-identified canvas whose only drift is widget " +
      "content must not be refused (#696)",
  );
});

test("#696: the relaxation needs POSITIVE identity — an untagged root is still refused", () => {
  // Absence of the tag is absence of proof, and the whole relaxation rests on it:
  // without the tag, byte-identical structure cannot tell the active tab's canvas
  // from a duplicate tab's. Fail closed, exactly as before.
  const fixture = driftFixture({ rootUuid: null });
  assert.equal(graphRootContentDriftOnBoundCanvas(fixture), false);
  assert.equal(driftVerdict(fixture)?.reason, "root-shape-mismatch");
});

test("#696: a STRUCTURAL difference on a tagged root is still a refusal, in every surface", () => {
  // The direction that must NOT be softened. Each of these is a real wrong-canvas
  // signature; the identity tag is present in all of them, so only the structural
  // comparison can hold the line.
  const cases = {
    "a node type changed": (nodes) => {
      nodes[0].type = "UNETLoader";
    },
    "a node id changed": (nodes) => {
      nodes[0].id = 99;
    },
    "a node was removed": (nodes, state) => {
      state.nodes = nodes.slice(1);
    },
    "the links differ": (nodes, state) => {
      state.links = [];
    },
    "a group differs": (nodes, state) => {
      state.groups = [{ title: "OTHER", bounding: [0, 0, 10, 10] }];
    },
    "a reroute appeared": (nodes, state) => {
      state.reroutes = [{ id: "r1", pos: [1, 2] }];
    },
    "a top-level subgraph appeared": (nodes, state) => {
      state.subgraphs = [{ id: "s1", nodes: [{ id: 7, type: "SaveImage" }] }];
    },
  };
  for (const [label, drift] of Object.entries(cases)) {
    const fixture = driftFixture({ drift });
    assert.equal(
      graphRootContentDriftOnBoundCanvas(fixture),
      false,
      `${label} is STRUCTURAL — it must never be waved through as content drift`,
    );
    assert.ok(driftVerdict(fixture), `${label} must still be refused`);
  }
});

test("#696: a CONFLICTING identity tag still refuses ahead of any content reasoning", () => {
  const fixture = driftFixture({ rootUuid: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" });
  assert.equal(
    graphRootContentDriftOnBoundCanvas(fixture),
    false,
    "the relaxation demands a MATCH, and a foreign tag is the #349 wrong-canvas case",
  );
  assert.equal(driftVerdict(fixture, { rootUuidMismatch: true })?.reason, "root-workflow-uuid-mismatch");
});

// ── #1187 — A STRUCTURAL HAND EDIT INSIDE THE TRACKER'S CAPTURE LAG ───────────
//
// ChangeTracker captures on USER INPUT events, so a node added or a wire dropped
// by hand leaves `activeState` one capture behind the live canvas while
// `isModified` has NOT flipped. In that window the equality relaxation above is
// unreachable — the edit differs structurally by definition — and before this fix
// every graph read and mutation refused the workflow's OWN canvas until the
// tracker happened to capture. The rescue is containment, not equality: the live
// root must still hold every node and link the workflow's own state carries, so
// the admitted canvas can never be missing anything the workflow owns.
test("#1187: a node ADDED by hand before the tracker captures is the right canvas, not a refusal", () => {
  const fixture = driftFixture({
    drift: (nodes) => {
      nodes.push({ id: 4, type: "PreviewImage" }); // the hand edit: 3 -> 4 nodes
    },
  });
  assert.equal(
    graphRootMismatchesActiveWorkflow({ rootGraph: fixture.rootGraph, activeWorkflow: fixture.activeWorkflow }),
    true,
    "the content comparator still sees the lag — that difference is real",
  );
  assert.equal(
    graphRootStructureExtendsActiveWorkflow(fixture),
    true,
    "…but the live root still CONTAINS every node and link the workflow's own state carries",
  );
  assert.equal(
    driftVerdict(fixture),
    null,
    "the reported case (saved 98, live 99, matching tag) must not refuse the read",
  );
});

test("#1187: an added node WIRED into the graph is permitted — the state's links all survive", () => {
  const fixture = driftFixture({
    drift: (nodes, state) => {
      nodes.push({ id: 4, type: "PreviewImage" });
      state.links.push([2, 3, 2, 4, 0, "IMAGE"]); // the wire to the new node
    },
  });
  assert.equal(graphRootStructureExtendsActiveWorkflow(fixture), true);
  assert.equal(driftVerdict(fixture), null);
});

test("#1187: a wire added between two EXISTING nodes is permitted — links are containment, not equality", () => {
  const fixture = driftFixture({
    drift: (nodes, state) => {
      state.links.push([2, 1, 0, 3, 3, "CLIP"]); // no new node, one new link
    },
  });
  assert.equal(graphRootStructureExtendsActiveWorkflow(fixture), true);
  assert.equal(driftVerdict(fixture), null);
});

test("#1187: a hand REMOVAL still refuses in the lag window — containment must never under-report", () => {
  // The deliberate bound: live ⊆ state would admit a canvas MISSING content the
  // workflow owns (the count-short read is the #618 lesson), so removals and
  // link deletions keep refusing until the tracker captures and the refusal
  // self-clears.
  const nodeRemoved = driftFixture({
    drift: (nodes, state) => {
      state.nodes = nodes.slice(1);
    },
  });
  assert.equal(graphRootStructureExtendsActiveWorkflow(nodeRemoved), false);
  assert.equal(driftVerdict(nodeRemoved)?.reason, "root-shape-mismatch");

  const linkRemoved = driftFixture({
    drift: (nodes, state) => {
      state.links = [];
    },
  });
  assert.equal(graphRootStructureExtendsActiveWorkflow(linkRemoved), false);
  assert.equal(driftVerdict(linkRemoved)?.reason, "root-shape-mismatch");
});

test("#1187: a difference in any OTHER structural surface is not the hand edit and still refuses", () => {
  // Adding a node does not rewrite groups, reroutes, subgraphs, definitions or
  // content-bearing extra — those surfaces stay EQUAL under the rescue, so the
  // #696 structural refusals are untouched.
  const cases = {
    "a group changed": (nodes, state) => {
      nodes.push({ id: 4, type: "PreviewImage" });
      state.groups = [{ title: "OTHER", bounding: [0, 0, 10, 10] }];
    },
    "a reroute appeared": (nodes, state) => {
      nodes.push({ id: 4, type: "PreviewImage" });
      state.reroutes = [{ id: "r1", pos: [1, 2] }];
    },
    "a top-level subgraph appeared": (nodes, state) => {
      nodes.push({ id: 4, type: "PreviewImage" });
      state.subgraphs = [{ id: "s1", nodes: [{ id: 7, type: "SaveImage" }] }];
    },
  };
  for (const [label, drift] of Object.entries(cases)) {
    const fixture = driftFixture({ drift });
    assert.equal(graphRootStructureExtendsActiveWorkflow(fixture), false, label);
    assert.ok(driftVerdict(fixture), `${label} must still be refused`);
  }
});

test("#1187: the rescue still demands POSITIVE identity — an untagged or foreign-tagged root refuses", () => {
  // Same conjunct discipline as the equality relaxation: containment is never
  // trusted without the workflow's own stamp, because two canvases can both
  // contain a shared structure.
  const additive = (nodes) => {
    nodes.push({ id: 4, type: "PreviewImage" });
  };
  const untagged = driftFixture({ rootUuid: null, drift: additive });
  assert.equal(graphRootStructureExtendsActiveWorkflow(untagged), true, "the content proof itself runs");
  assert.equal(driftVerdict(untagged)?.reason, "root-shape-mismatch", "…but without identity it proves nothing");

  const foreign = driftFixture({ rootUuid: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", drift: additive });
  assert.equal(driftVerdict(foreign)?.reason, "root-shape-mismatch");
});

test("#1187: a count-SHORT canvas is not containment — the mid-restore window stays refused", () => {
  // The other direction of the bound: a restoring root holding a PREFIX of the
  // workflow's nodes contains none of what the state carries beyond it, so this
  // rescue cannot mask #618's mid-population signature.
  const fixture = driftFixture({
    drift: (nodes, state) => {
      state.nodes = nodes.slice(0, 1);
    },
  });
  fixture.rootGraph._nodes = [{ id: 1, type: "CheckpointLoaderSimple" }];
  assert.equal(graphRootStructureExtendsActiveWorkflow(fixture), false);
  assert.equal(driftVerdict(fixture, { postReconnectWindow: true })?.reason, "root-mid-population");
});

test("#1187: an unreadable comparison fails closed, never relaxes", () => {
  const fixture = driftFixture({
    drift: (nodes) => {
      nodes.push({ id: 4, type: "PreviewImage" });
    },
  });
  fixture.rootGraph = {
    ...fixture.rootGraph,
    serialize: () => {
      throw new Error("serializer unavailable");
    },
  };
  assert.equal(graphRootStructureExtendsActiveWorkflow(fixture), false);
  assert.ok(driftVerdict(fixture), "an uncompleted comparison is not containment");
  assert.equal(graphRootStructureExtendsActiveWorkflow(), false, "no arguments ⇒ no relaxation");
  assert.equal(graphRootStructureExtendsActiveWorkflow({}), false);
});

test("#1187: the first node on a blank, tagged workflow is permitted — blank state is trivially contained", () => {
  // The edge where the workflow's own state is EMPTY: every blank canvas
  // satisfies containment, so identity alone separates this from any other
  // blank-rooted tab — and #570 mints that identity at creation, including
  // new-blank. With the tag matching, the user's first node must not refuse.
  const fixture = driftFixture({
    drift: (nodes, state) => {
      state.nodes = [{ id: 1, type: "CheckpointLoaderSimple", widgets_values: ["anime.safetensors"] }];
      state.links = [];
      state.groups = [];
    },
  });
  fixture.activeWorkflow = wf({ isModified: false, changeTracker: { activeState: { nodes: [] } } });
  assert.equal(graphRootStructureExtendsActiveWorkflow(fixture), true);
  assert.equal(driftVerdict(fixture), null);
});

test("#618: a mid-restore canvas is count-short, so the relaxation cannot mask it", () => {
  const fixture = driftFixture({
    drift: (nodes, state) => {
      state.nodes = nodes.slice(0, 1); // still restoring: 1 of 3
    },
  });
  fixture.rootGraph._nodes = [{ id: 1, type: "CheckpointLoaderSimple" }];
  assert.equal(graphRootContentDriftOnBoundCanvas(fixture), false);
  assert.equal(driftVerdict(fixture, { postReconnectWindow: true })?.reason, "root-mid-population");
});

test("#696: an unreadable root serializer stays inconclusive rather than relaxing", () => {
  const fixture = driftFixture();
  const blind = {
    ...fixture,
    rootGraph: {
      _nodes: fixture.rootGraph._nodes,
      extra: fixture.rootGraph.extra,
      serialize: () => {
        throw new Error("serializer unavailable");
      },
    },
  };
  assert.equal(
    graphRootContentDriftOnBoundCanvas(blind),
    false,
    "a structural comparison that could not RUN is not a structural match",
  );

  // The subtler direction: BOTH sides unreadable. Two failed reads must not
  // collapse into "equal" — that is `graphRootMatchesState`'s original sin
  // (one return value doing two jobs) reappearing inside the relaxation, and it
  // would permit on a canvas nothing ever managed to look at.
  const uuid = fixture.activeWorkflowUuid;
  const tagged = (serialize) => ({
    _nodes: [{ id: 1, type: "KSampler" }],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
    serialize,
  });
  assert.equal(
    graphRootContentDriftOnBoundCanvas({
      rootGraph: tagged(() => ({})),
      activeWorkflow: wf({ isModified: false, changeTracker: {} }),
      activeWorkflowUuid: uuid,
    }),
    false,
    "no tracker state and no serialized nodes is two absences, not a match",
  );
  assert.equal(
    graphRootContentDriftOnBoundCanvas({
      rootGraph: tagged(() => ({ nodes: [{ id: 1 }] })),
      activeWorkflow: wf({ isModified: false, changeTracker: { activeState: { nodes: [{ id: 1 }] } } }),
      activeWorkflowUuid: uuid,
    }),
    false,
    "nodes with no usable type cannot be structurally compared on EITHER side (older frontends), " +
      "and an uncomparable pair must not read as identical",
  );

  assert.equal(graphRootContentDriftOnBoundCanvas(), false, "no arguments ⇒ no relaxation");
  assert.equal(graphRootContentDriftOnBoundCanvas({}), false);
});

test("#701/#702: the refusal reports the LIVE count and only claims 'a different graph' when it is one", () => {
  // Three reports read "the workflow reports N node(s), but the canvas is bound to
  // a different graph" / "left this command pointed at the wrong canvas" and went
  // hunting a wrong-tab bug. The counts were EQUAL in all of them — the message
  // never printed the live one, and asserted a conclusion the evidence (one widget
  // value) did not support. BOTH claims are unmeasured, so both must go.
  const contentOnly = graphBindingRefusalMessage({ reason: "root-shape-mismatch", expected: 23, live: 23 });
  assert.match(contentOnly, /^\[root-shape-mismatch\]/);
  assert.match(contentOnly, /23/, "the counts the verdict measured must appear");
  assert.doesNotMatch(
    contentOnly,
    /bound to a different graph/,
    "equal counts + a content difference is NOT proof of a different graph",
  );
  assert.doesNotMatch(
    contentOnly,
    /pointed at the wrong canvas/,
    "…and neither is it proof that a load/switch/reconnect mis-pointed the command",
  );
  assert.match(contentOnly, /cannot tell/, "an unresolved ambiguity must be disclosed as one");

  const reallyDifferent = graphBindingRefusalMessage({ reason: "root-shape-mismatch", expected: 23, live: 4 });
  assert.match(reallyDifferent, /23/);
  assert.match(reallyDifferent, /\b4\b/, "the LIVE count is the reader's only way to tell the two apart");
  assert.match(reallyDifferent, /holds a graph other than/, "a real size disagreement may still say so");
  // …but even THERE the event is offered as an explanation, never asserted: the
  // predicate measured a mismatch, it did not watch a load/switch/reconnect happen.
  assert.match(reallyDifferent, /observed the mismatch, not the event/);
  assert.doesNotMatch(reallyDifferent, /reconnect left this command pointed at the wrong canvas, so/);

  // An absent live count is an UNMEASURED one: it must not become a claim either way.
  const unmeasured = graphBindingRefusalMessage({ reason: "root-node-count-desync", expected: 3 });
  assert.match(unmeasured, /the workflow reports 3 node\(s\)/);
  assert.doesNotMatch(
    unmeasured,
    /bound to a different graph|pointed at the wrong canvas/,
    "a live count nobody measured cannot support a different-graph claim",
  );
});

test("#701: a structure-matching refusal names the remedy that actually supplies the missing proof", () => {
  // The one refusal whose remedy is guaranteed to help, and the reason to
  // distinguish it: the canvas IS structurally this workflow and the only thing
  // absent is the identity stamp — which panel_open_workflow writes. Saying so is
  // the difference between an actionable refusal and the one the reporters got,
  // whose named remedy re-created the same drift and failed identically forever.
  const msg = graphBindingRefusalMessage({
    reason: "root-shape-mismatch",
    expected: 23,
    live: 23,
    structureMatches: true,
  });
  assert.match(msg, /^\[root-shape-mismatch\]/);
  assert.match(msg, /STRUCTURE/, "the disclosure must say what DID match");
  assert.match(msg, /panel_open_workflow/);
  assert.match(msg, /identity/, "…and why that remedy is the one that can clear it");
  assert.doesNotMatch(msg, /pointed at the wrong canvas/);
  assert.match(msg, /NOT applied/);
  // The #606 promises survive the new branch — and extend to the OPEN, which is
  // no more observable than the reload: workflow_open can run and still fail to
  // prove its rebind, so neither "it will clear this" nor its contrapositive
  // ("still refusing ⇒ the difference is more than content") may be stated.
  assert.match(msg, /panel_reload/);
  assert.match(msg, /REQUESTED, NOT CONFIRMED/);
  assert.match(msg, /cannot observe/);
  assert.doesNotMatch(msg, /which (restores|rebinds|re-?establishes|rebuilds)|reload always/i);
  assert.doesNotMatch(
    msg,
    /after that a content-only difference no longer refuses|the difference is NOT content-only/,
    "an unprovable rebind must not be reported as a completed one, in either direction",
  );
  assert.match(msg, /do NOT read that as proof/, "the invalid inference is named and refused");
  assert.match(msg, /panel_set_workflow_target is NOT a remedy/);

  // A structure match is NOT claimable when the sizes disagree — the two cannot
  // both be true, and the size evidence is the stronger one.
  const conflicting = graphBindingRefusalMessage({
    reason: "root-shape-mismatch",
    expected: 23,
    live: 4,
    structureMatches: true,
  });
  assert.match(conflicting, /different graph/);
  assert.doesNotMatch(conflicting, /reproduces this workflow's STRUCTURE/);
});

test("#701: the verdict carries the structural answer, positively — never from an unread comparison", () => {
  const fixture = driftFixture({ rootUuid: null }); // structure equal, identity unproven
  const verdict = driftVerdict(fixture);
  assert.equal(verdict.reason, "root-shape-mismatch");
  assert.equal(verdict.structureMatches, true, "the structural comparison RAN and matched");

  const structural = driftFixture({ rootUuid: null, drift: (nodes) => void (nodes[0].type = "UNETLoader") });
  assert.equal(driftVerdict(structural).structureMatches, false);

  // Unreadable ⇒ false ("unestablished"), never true.
  const blind = driftFixture({ rootUuid: null });
  blind.rootGraph = {
    _nodes: blind.rootGraph._nodes,
    serialize: () => {
      throw new Error("serializer unavailable");
    },
  };
  const blindVerdict = driftVerdict(blind);
  if (blindVerdict) assert.equal(blindVerdict.structureMatches, false);
});

test("#545: a DIRTY workflow's tracker state may lag legitimate canvas edits, so it is never a binding refusal", () => {
  const staleTrackerState = {
    nodes: Array.from({ length: 27 }, (_, i) => ({ id: i + 1, type: "KSampler" })),
    links: [],
  };
  const actualDirtyCanvas = {
    nodes: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, type: "KSampler" })),
    links: [],
  };
  const activeWorkflow = wf({ changeTracker: { activeState: staleTrackerState }, isModified: true });
  assert.equal(
    graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(actualDirtyCanvas), activeWorkflow }),
    false,
    "a dirty tab's cached ChangeTracker state is not proof that its live canvas is another workflow",
  );
});

test("#545: a DIRTY workflow still rejects a root positively identified as another workflow", () => {
  const rootGraph = {
    _nodes: [{ id: 1, type: "KSampler" }],
    extra: { comfyui_mcp: { workflow_uuid: "workflow-B" } },
  };
  assert.equal(
    graphRootWorkflowUuidMismatches({ rootGraph, activeWorkflowUuid: "workflow-A" }),
    true,
    "a durable root UUID disagreement remains a real wrong-canvas proof even while dirty",
  );
  assert.equal(graphRootWorkflowUuidMismatches({ rootGraph, activeWorkflowUuid: "workflow-B" }), false);
  assert.equal(graphRootWorkflowUuidMismatches({ rootGraph, activeWorkflowUuid: null }), false);
  assert.equal(graphRootWorkflowUuidMismatches({ rootGraph: {}, activeWorkflowUuid: "workflow-A" }), false);
  assert.equal(graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid: "workflow-A" }), false);
  assert.equal(graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid: "workflow-B" }), true);
  assert.equal(graphRootWorkflowUuidMatches({ rootGraph: {}, activeWorkflowUuid: "workflow-A" }), false);
});

test("#545 wiring: dirty tracker state is inconclusive, but an established workflow UUID still fences a foreign root", () => {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("function assertGraphBoundToActiveWorkflow(");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(
    body,
    /const activeWorkflowUuid = activeWorkflow\s*\? \(workflowObjectUuid\(activeWorkflow\) \|\| workflowStableUuid\(activeWorkflow\)\)\s*: null;/,
    "the fence must establish a missing object UUID through the root-blind resolver, never from a stale root",
  );
  assert.match(
    body,
    /graphRootWorkflowUuidMismatches\(\{ rootGraph, activeWorkflowUuid \}\)/,
    "a dirty tab retains the positive foreign-root identity fence",
  );
  // The predicate composition itself now lives in lib/graph-binding.js
  // (resolveGraphBindingVerdict) so the read-vs-mutation bar is observable in
  // tests; the panel fence only resolves the evidence and delegates the verdict.
  assert.match(
    body,
    /const verdict = resolveGraphBindingVerdict\(\{/,
    "the fence must delegate its verdict to the pure resolver",
  );
  const bindingSrc = readFileSync(
    join(HERE, "../../web/js/lib/graph-binding.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const verdictStart = bindingSrc.indexOf("export function resolveGraphBindingVerdict(");
  assert.notEqual(verdictStart, -1);
  const verdictBody = bindingSrc.slice(verdictStart, bindingSrc.indexOf("\n}\n", verdictStart));
  assert.match(
    verdictBody,
    /requireDirtyMutationBinding[\s\S]*!graphRootWorkflowUuidMatches\(\{ rootGraph, activeWorkflowUuid \}\)/,
    "a dirty mutation must require a positive root-to-active UUID match, not merely no mismatch",
  );
  assert.match(
    verdictBody,
    /const currentStateTrustworthy = activeWorkflow\?\.isModified !== true;/,
    "a dirty ChangeTracker snapshot is not trustworthy as a binding proof",
  );
  assert.match(
    verdictBody,
    /currentStateTrustworthy &&\s*includeBaselineReadGuard &&\s*graphReadDesynced/,
    "the old node-count baseline guard must not reject a dirty canvas from stale tracker state",
  );
});

test("#545 P1: an untagged stale root is refused for dirty mutations but a proven dirty root remains editable", () => {
  const unbound = buildDirtyStaleRouteHarness({ rootUuid: null });
  assert.throws(
    () => unbound.assertBound(unbound.rootB, unbound.rootB, {
      includeBaselineReadGuard: false,
      requireDirtyMutationBinding: true,
    }),
    /NOT applied/,
    "dirty A must not mutate an untagged stale B just because tracker comparison is unavailable",
  );
  const bound = buildDirtyStaleRouteHarness({ rootUuid: "workflow-A" });
  bound.objectUuids.set(bound.workflowA, "workflow-A");
  assert.doesNotThrow(
    () => bound.assertBound(bound.rootB, bound.rootB, {
      includeBaselineReadGuard: false,
      requireDirtyMutationBinding: true,
    }),
    "the #545 dirty-edit case remains available once the live root positively matches A",
  );
});

// ── #601: the seal — a proven-CLEAN binding is stamped onto the root ─────────
//
// The one-mutation-per-page-load deadlock: a reload rebuilds app.graph from
// saved JSON with NO root stamp, and the first mutation is itself what dirties
// the tab — so every mutation after the first hit dirty-mutation-binding-
// unproven. The seal stamps the active workflow's uuid onto the root at the one
// moment it is provably correct: clean tab + root serializes EQUAL to the
// workflow's own current state.

test("sealProvenRootBinding: clean tab + proven-equal root gets stamped (and preserves other extra keys)", () => {
  const workflow = { isModified: false, changeTracker: { activeState: state(5) } };
  const root = { _nodes: [], extra: { ds: { scale: 1 } }, serialize: () => state(5) };
  assert.equal(
    sealProvenRootBinding({ rootGraph: root, activeWorkflow: workflow, activeWorkflowUuid: "uuid-A" }),
    true,
  );
  assert.equal(root.extra.comfyui_mcp.workflow_uuid, "uuid-A");
  assert.deepEqual(root.extra.ds, { scale: 1 }, "the stamp must not clobber unrelated extra keys");
});

test("sealProvenRootBinding: fails CLOSED — dirty tab, subgraph scope, foreign stamp, unproven root, missing identity", () => {
  const clean = { isModified: false, changeTracker: { activeState: state(5) } };
  const dirty = { isModified: true, changeTracker: { activeState: state(5) } };
  const root = () => ({ _nodes: [], serialize: () => state(5) });
  // Dirty tab: the tracker can lag the real canvas (#545) — no seal.
  {
    const r = root();
    assert.equal(sealProvenRootBinding({ rootGraph: r, activeWorkflow: dirty, activeWorkflowUuid: "uuid-A" }), false);
    assert.equal(r.extra, undefined);
  }
  // Subgraph scope: the stamp belongs on the root only — the caller passes the root, but the flag is defense in depth.
  {
    const r = root();
    assert.equal(
      sealProvenRootBinding({ rootGraph: r, activeWorkflow: clean, activeWorkflowUuid: "uuid-A", inSubgraph: true }),
      false,
    );
    assert.equal(r.extra, undefined);
  }
  // An EXISTING stamp — even a conflicting one — is the rebind path's decision, never overwritten here.
  {
    const r = { _nodes: [], extra: { comfyui_mcp: { workflow_uuid: "uuid-B" } }, serialize: () => state(5) };
    assert.equal(sealProvenRootBinding({ rootGraph: r, activeWorkflow: clean, activeWorkflowUuid: "uuid-A" }), false);
    assert.equal(r.extra.comfyui_mcp.workflow_uuid, "uuid-B");
  }
  // A root that does NOT serialize equal to the workflow's current state stays unstamped (stale/foreign canvas).
  {
    const r = { _nodes: [], serialize: () => state(9) };
    assert.equal(sealProvenRootBinding({ rootGraph: r, activeWorkflow: clean, activeWorkflowUuid: "uuid-A" }), false);
    assert.equal(r.extra, undefined);
  }
  // An unserializable root / missing identity / missing sides: no stamp, no throw.
  {
    const r = { _nodes: [] };
    assert.equal(sealProvenRootBinding({ rootGraph: r, activeWorkflow: clean, activeWorkflowUuid: "uuid-A" }), false);
    assert.equal(sealProvenRootBinding({ rootGraph: root(), activeWorkflow: clean, activeWorkflowUuid: "" }), false);
    assert.equal(sealProvenRootBinding({ rootGraph: root(), activeWorkflow: clean, activeWorkflowUuid: null }), false);
    assert.equal(sealProvenRootBinding({}), false);
  }
  // A NON-EXCLUSIVE content proof (an identical-twin open tab, or an
  // exclusivity check that could not run) never seals (codex gate).
  {
    const r = root();
    assert.equal(
      sealProvenRootBinding({ rootGraph: r, activeWorkflow: clean, activeWorkflowUuid: "uuid-A", proofExclusive: false }),
      false,
    );
    assert.equal(r.extra, undefined);
  }
});

test("#601: the FIRST post-reload mutation seals the proven-clean root, so the SECOND (dirty-tab) mutation passes", () => {
  // Post-reload state: CLEAN tab, unstamped root that provably carries the
  // workflow's own content (rootSerializer emits exactly the tracker state).
  const h = buildDirtyStaleRouteHarness({
    rootUuid: null,
    foreignClaim: "none",
    activeNodeCount: 5,
    rootNodeCount: 5,
    activeModified: false,
    rootSerializer: () => state(5),
  });
  // First mutation on the clean tab: passes AND seals the root with A's identity.
  assert.doesNotThrow(() =>
    h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true, requireDirtyMutationBinding: true }),
  );
  assert.equal(
    h.rootB.extra?.comfyui_mcp?.workflow_uuid,
    "workflow-A-1",
    "the seal stamps the active workflow's own resolved identity onto the proven root",
  );
  // That first mutation is what dirties the tab. Before the seal, every
  // mutation from here was refused (one mutation per page load); now the
  // stamped root positively matches A, so the mutation bar clears.
  h.workflowA.isModified = true;
  assert.doesNotThrow(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true, requireDirtyMutationBinding: true }),
    "a dirty tab whose root carries its own sealed identity must stay editable",
  );
});

test("#601: without a clean proof the seal does not fire — the #545 P1 fence semantics are unchanged", () => {
  // Dirty tab + unstamped root: refused as before, and the root stays UNSTAMPED
  // (a refused command must leave no authorization residue behind).
  const dirty = buildDirtyStaleRouteHarness({ rootUuid: null });
  assert.throws(
    () =>
      dirty.assertBound(dirty.rootB, dirty.rootB, {
        includeBaselineReadGuard: false,
        requireDirtyMutationBinding: true,
      }),
    /NOT applied/,
  );
  assert.equal(dirty.rootB.extra, undefined, "a dirty unproven root must never receive the stamp");
  // Clean tab whose root does NOT carry the workflow's content: refused, unstamped.
  const diverged = buildDirtyStaleRouteHarness({
    rootUuid: null,
    foreignClaim: "none",
    activeNodeCount: 5,
    rootNodeCount: 5,
    activeModified: false,
    rootSerializer: () => state(9), // root content ≠ tracker state — a genuinely diverged canvas
  });
  assert.throws(
    () =>
      diverged.assertBound(diverged.rootB, diverged.rootB, {
        includeBaselineReadGuard: true,
        requireDirtyMutationBinding: true,
      }),
    /NOT applied/,
  );
  assert.equal(diverged.rootB.extra, undefined, "a diverged root must never receive the stamp");
});

test("#601 (codex gate): an identical-TWIN open tab makes the content proof ambiguous — no seal, fail closed", () => {
  // Two clean, separately open DUPLICATE workflows carry byte-identical state, so
  // content equality cannot tell the active tab's canvas from its twin's. The seal
  // must stay off: stamping here could authorize later dirty writes to the wrong
  // canvas.
  const twin = buildDirtyStaleRouteHarness({
    rootUuid: null,
    foreignClaim: "identity", // B sits in openWorkflows alongside A
    foreignTab: {
      isPersisted: true,
      path: "workflows/twin.json",
      changeTracker: { activeState: state(5) }, // the twin's OWN copy of the identical content
    },
    activeNodeCount: 5,
    rootNodeCount: 5,
    activeModified: false,
    rootSerializer: () => state(5),
  });
  // The clean-tab command itself still passes (the binding verdict is null either
  // way) — but it must NOT leave a stamp behind.
  assert.doesNotThrow(() =>
    twin.assertBound(twin.rootB, twin.rootB, { includeBaselineReadGuard: true, requireDirtyMutationBinding: true }),
  );
  assert.equal(twin.rootB.extra, undefined, "an ambiguous (twin) content proof must never seal the root");
  // …and once the tab is dirty, the ambiguous binding still refuses mutations,
  // exactly as before the seal existed.
  twin.workflowA.isModified = true;
  assert.throws(
    () =>
      twin.assertBound(twin.rootB, twin.rootB, { includeBaselineReadGuard: true, requireDirtyMutationBinding: true }),
    /NOT applied/,
    "a dirty tab with an ambiguous binding stays fenced (#545 P1)",
  );
});

test("#601: the dirty-mutation-binding-unproven refusal names the real cause and remedy — not a node count", () => {
  const msg = graphBindingRefusalMessage({ reason: "dirty-mutation-binding-unproven", expected: 339 });
  assert.match(msg, /\[dirty-mutation-binding-unproven\]/, "the reason tag stays observable");
  assert.match(msg, /NOT applied/, "the refusal claim stays truthful");
  assert.doesNotMatch(
    msg,
    /reports 339 node\(s\)/,
    "reporting a node count for a UUID-binding failure is what sent two real diagnoses down wrong paths",
  );
  assert.match(msg, /identity stamp/, "names the actual failing predicate (no proven stamp on a dirty tab)");
  assert.match(msg, /panel_open_workflow/, "names a working remedy");
  assert.match(msg, /multiple_active_tabs/, "disambiguates the confusable sibling guard");
  // The other verdicts keep their existing wording.
  const generic = graphBindingRefusalMessage({ reason: "root-shape-mismatch", expected: 27 });
  assert.match(generic, /reports 27 node\(s\)/);
});

test("#545: read-only graph commands recover from an untagged dirty root, while workflow mutations remain fenced", () => {
  const unbound = buildDirtyStaleRouteHarness({ rootUuid: null });
  assert.equal(graphCommandMayMutateWorkflow("graph_outline"), false);
  assert.equal(graphCommandMayMutateWorkflow("graph_query"), false);
  assert.equal(graphCommandMayMutateWorkflow("graph_set_node_property"), true);
  assert.equal(graphCommandMayMutateWorkflow("graph_future_command"), true, "unknown commands fail closed");

  assert.doesNotThrow(
    () => unbound.assertBound(unbound.rootB, unbound.rootB, {
      includeBaselineReadGuard: false,
      requireDirtyMutationBinding: graphCommandMayMutateWorkflow("graph_outline"),
    }),
    "a read must remain available when a dirty canvas lacks UUID metadata",
  );
  assert.throws(
    () => unbound.assertBound(unbound.rootB, unbound.rootB, {
      includeBaselineReadGuard: false,
      requireDirtyMutationBinding: graphCommandMayMutateWorkflow("graph_set_node_property"),
    }),
    /NOT applied/,
    "the same unproven dirty root must not accept a workflow mutation",
  );
});

test("#545: a positively identified wrong root remains rejected even for a read", () => {
  const stale = buildDirtyStaleRouteHarness({ rootUuid: "workflow-B" });
  assert.throws(
    () => stale.assertBound(stale.rootB, stale.rootB, {
      includeBaselineReadGuard: false,
      requireDirtyMutationBinding: graphCommandMayMutateWorkflow("graph_outline"),
    }),
    /NOT applied/,
    "availability for an unproven dirty root must not turn a known wrong workflow into a read result",
  );
  assert.equal(
    stale.rootB.extra.comfyui_mcp.workflow_uuid,
    "workflow-B",
    "a foreign-owned live tag must NOT be rewritten — the wrong-canvas fence stays intact",
  );
});

// ── #545/#557: recoverable desync — orphaned root tags rebind ────────────────

test("resolveGraphRootUuidRebind: none without a conflict, rebind only when the ACTIVE workflow claims the tag", () => {
  const tagged = { extra: { comfyui_mcp: { workflow_uuid: "workflow-B" } } };
  assert.equal(
    resolveGraphRootUuidRebind({
      rootGraph: tagged,
      activeWorkflowUuid: "workflow-A",
      rootTagClaimedByActiveWorkflow: true,
    }),
    "rebind",
    "the active tab's own lineage tag is stale bookkeeping — heal it",
  );
  assert.equal(
    resolveGraphRootUuidRebind({ rootGraph: tagged, activeWorkflowUuid: "workflow-A" }),
    "conflict",
    "a tag the active workflow does NOT claim fails closed — foreign claim OR closed-tab leftover (r5)",
  );
  assert.equal(
    resolveGraphRootUuidRebind({ rootGraph: tagged, activeWorkflowUuid: "workflow-B" }), "none");
  assert.equal(
    resolveGraphRootUuidRebind({ rootGraph: {}, activeWorkflowUuid: "workflow-A" }),
    "none",
    "a missing tag stays inconclusive, exactly like the mismatch predicate",
  );
  assert.equal(resolveGraphRootUuidRebind({ rootGraph: tagged, activeWorkflowUuid: null }), "none");
});

test("#545: a root tag whose REGISTERED OWNER is the active object itself rebinds instead of blocking every tool", () => {
  const h = buildDirtyStaleRouteHarness({ rootUuid: "workflow-B", foreignClaim: "active-lineage" });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.doesNotThrow(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    "a tag registered to the active object is its own lineage — heal, don't block",
  );
  assert.equal(
    h.rootB.extra.comfyui_mcp.workflow_uuid,
    "workflow-A",
    "the rebind re-stamps the root with the ACTIVE workflow's identity",
  );
  assert.doesNotThrow(
    () =>
      h.assertBound(h.rootB, h.rootB, {
        includeBaselineReadGuard: false,
        requireDirtyMutationBinding: graphCommandMayMutateWorkflow("graph_set_node_property"),
      }),
    "after the rebind the root positively matches, so a dirty-tab mutation proceeds",
  );
});

test("#349 r6 P0: a LAGGING tracker state carrying the tag (replaced-predecessor residue) must NOT prove active lineage", () => {
  // The r6 spoof: the active object resolved identity B ("workflow-A" here),
  // but its stale serialized state still carries the tag "workflow-B" — while
  // the root is a FOREIGN canvas genuinely tagged "workflow-B". Serialized
  // state is not object-keyed, so this must fail closed: no re-stamp, throw.
  const h = buildDirtyStaleRouteHarness({ rootUuid: "workflow-B", foreignClaim: "stale-lineage" });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    /NOT applied/,
    "a lagging tracker stamp must not re-stamp a foreign root with the active identity",
  );
  assert.throws(
    () =>
      h.assertBound(h.rootB, h.rootB, {
        includeBaselineReadGuard: false,
        requireDirtyMutationBinding: graphCommandMayMutateWorkflow("graph_set_node_property"),
      }),
    /NOT applied/,
    "the same spoofed lineage must refuse a dirty mutation",
  );
  assert.equal(
    h.rootB.extra.comfyui_mcp.workflow_uuid,
    "workflow-B",
    "the foreign root must NOT be rewritten on serialized-state evidence",
  );
});

test("#349 r5: a root tag NOBODY claims (a closed tab's leftover canvas) must throw, never re-stamp", () => {
  // A closed workflow's stale graph left mounted: the active tab does not claim
  // the tag, and no live open tab does either. Re-stamping it with the active
  // identity would authorize writes to that dead graph as if it were the active
  // one (r5 P0) — fail closed; panel_open_workflow's proven repaint is the remedy.
  const h = buildDirtyStaleRouteHarness({ rootUuid: "workflow-B", foreignClaim: "none" });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    /NOT applied/,
    "an unclaimed tag is not proof the root belongs to the active workflow",
  );
  assert.throws(
    () =>
      h.assertBound(h.rootB, h.rootB, {
        includeBaselineReadGuard: false,
        requireDirtyMutationBinding: graphCommandMayMutateWorkflow("graph_set_node_property"),
      }),
    /NOT applied/,
    "an unclaimed tag must refuse a dirty mutation",
  );
  assert.equal(
    h.rootB.extra.comfyui_mcp.workflow_uuid,
    "workflow-B",
    "an unclaimed tag must NOT be rewritten",
  );
});

test("#349: a root tag a LIVE OPEN workflow claims through the resolver must throw", () => {
  const h = buildDirtyStaleRouteHarness({ rootUuid: "workflow-B", foreignClaim: "identity" });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    /NOT applied/,
    "B's live open tab claims the tag — rebinding over it would authorize mutating B (#349)",
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, "workflow-B", "the foreign tag must NOT be rewritten");
});

test("#349 P0: a root tag claimed ONLY by a live open tab's serialized state (unregistered creation stamp) must throw", () => {
  // The codex-gate hole: a CREATION stamps the graph uuid without any owner/
  // object-cache record (creation loadGraphData passes no workflow object), so
  // the owner map says nothing while B is LIVE in openWorkflows. The rebind must
  // treat B's own serialized-state stamp as a foreign claim — never re-stamp B's
  // canvas as A's.
  const h = buildDirtyStaleRouteHarness({ rootUuid: "workflow-B", foreignClaim: "tracker-stamp" });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    /NOT applied/,
    "a live but UNTRACKED foreign owner must stay fail-closed (#349)",
  );
  assert.throws(
    () =>
      h.assertBound(h.rootB, h.rootB, {
        includeBaselineReadGuard: false,
        requireDirtyMutationBinding: graphCommandMayMutateWorkflow("graph_set_node_property"),
      }),
    /NOT applied/,
    "the same live-untracked foreign root must refuse a dirty mutation",
  );
  assert.equal(
    h.rootB.extra.comfyui_mcp.workflow_uuid,
    "workflow-B",
    "an unregistered live creation stamp must NOT be rewritten",
  );
});

test("#349 P0 r2: a live UNLOADED foreign tab present only as a proxy must throw — the registered owner map still claims the tag", () => {
  // The codex r2 hole: B is LIVE in openWorkflows but only as a Vue-style proxy
  // (raw `!==` misses the registered raw owner), its serialized state is NOT
  // populated (unloaded → the tracker claim can't fire), and the resolver mints
  // a different identity for it. Only the owner map ties B to the tag — and the
  // rebind must honor that claim rather than re-stamping B's live root as A's
  // and permitting dirty writes to B.
  const h = buildDirtyStaleRouteHarness({ rootUuid: "workflow-B", foreignClaim: "unloaded-proxy-owner" });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    /NOT applied/,
    "a live foreign claim registered only in the owner map must stay fail-closed (#349)",
  );
  assert.throws(
    () =>
      h.assertBound(h.rootB, h.rootB, {
        includeBaselineReadGuard: false,
        requireDirtyMutationBinding: graphCommandMayMutateWorkflow("graph_set_node_property"),
      }),
    /NOT applied/,
    "the unloaded foreign proxy root must refuse a dirty mutation",
  );
  assert.equal(
    h.rootB.extra.comfyui_mcp.workflow_uuid,
    "workflow-B",
    "a live foreign proxy's tag must NOT be rewritten",
  );
});

test("#349 P0 r3: a same-path OVERLAP (closed→reopened object) is NOT self — the foreign claim still throws", () => {
  // A and B are DISTINCT live objects at the SAME path (a closed→reopened
  // overlap). Path equality must not classify B as the active workflow and
  // exempt it from the foreign-claim check — the reopened object is a NEW
  // identity (r3 P0), so B's claim on the root tag stays a hard refusal.
  const h = buildDirtyStaleRouteHarness({ rootUuid: "workflow-B", foreignClaim: "same-path-overlap" });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    /NOT applied/,
    "a same-path foreign object must not be exempted as self (#349)",
  );
  assert.throws(
    () =>
      h.assertBound(h.rootB, h.rootB, {
        includeBaselineReadGuard: false,
        requireDirtyMutationBinding: graphCommandMayMutateWorkflow("graph_set_node_property"),
      }),
    /NOT applied/,
    "the same-path foreign root must refuse a dirty mutation",
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, "workflow-B", "the foreign root keeps its tag");
});

// Drives the REAL installCreateBoundaryFork source against a fake app whose
// loadGraphData simulates ComfyUI's creation behavior (the graph goes live in a
// NEW active tab). onLoad customizes what the load leaves active — e.g. a
// mid-load switch to an unrelated tab with an unreadable tracker (r6 P0).
function buildCreationForkHarness({ onLoad } = {}) {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const forkSource = panelFunctionSource(src, "installCreateBoundaryFork", "workflowUuidOwner");
  const objectUuids = new WeakMap();
  const owners = new Map();
  const createdTab = { isPersisted: false, changeTracker: null };
  const fakeApp = {
    graph: null,
    extensionManager: { workflow: { activeWorkflow: null, openWorkflows: [] } },
    loadGraphData(graphData) {
      this.graph = { _nodes: graphData.nodes ?? [], extra: graphData.extra };
      onLoad?.({ app: this, graphData, createdTab });
    },
  };
  const install = new Function(
    "_loadGraphDataForkInstalled",
    "workflowObjectUuid",
    "setWorkflowObjectUuid",
    "deleteWorkflowObjectUuid",
    "rememberWorkflowUuidOwner",
    "isNewWorkflowLoad",
    "shouldForkInPlaceReload",
    "recordPreLoadPromptRelayEditors",
    "crypto",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    `${forkSource}\nreturn installCreateBoundaryFork;`,
  )(
    false,
    rawKeyedUuidStore(objectUuids).workflowObjectUuid,
    rawKeyedUuidStore(objectUuids).setWorkflowObjectUuid,
    rawKeyedUuidStore(objectUuids).deleteWorkflowObjectUuid,
    (id, owner) => owners.set(id, owner),
    isNewWorkflowLoad,
    shouldForkInPlaceReload,
    () => {},
    { randomUUID: () => "creation-uuid-1" },
    "comfyui_mcp",
    "workflow_uuid",
  );
  install(fakeApp);
  return { fakeApp, createdTab, objectUuids, owners };
}

test("#349 P0 r3: a CREATION-minted tag is registered to the tab the load activates (lifecycle, no manual seeding)", async () => {
  const { fakeApp, createdTab, objectUuids, owners } = buildCreationForkHarness({
    onLoad: ({ app, graphData, createdTab }) => {
      // ComfyUI's creation behavior: the graph goes live in a NEW active tab,
      // and the tab's tracker captures the configured state (stamp included).
      createdTab.changeTracker = { activeState: { extra: graphData.extra } };
      app.extensionManager.workflow.activeWorkflow = createdTab;
      app.extensionManager.workflow.openWorkflows.push(createdTab);
    },
  });
  await fakeApp.loadGraphData({ nodes: [{ id: 1, type: "KSampler" }] });
  assert.equal(
    fakeApp.graph.extra.comfyui_mcp.workflow_uuid,
    "creation-uuid-1",
    "the creation stamps the graph before it goes live",
  );
  assert.equal(
    owners.get("creation-uuid-1"),
    createdTab,
    "the creation stamp is registered to the tab the load activated — no ownerless tags",
  );
  assert.equal(
    objectUuids.get(createdTab),
    "creation-uuid-1",
    "the receiving tab's identity cache carries its stamp",
  );

  // …so the desync guard refuses to rebind over that live creation while
  // ANOTHER workflow is active: the active tab does not claim the tag.
  const h = buildDirtyStaleRouteHarness({
    rootUuid: "creation-uuid-1",
    foreignClaim: "unloaded-proxy-owner",
    foreignTab: createdTab,
    registeredOwners: owners,
    objectUuids,
  });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    /NOT applied/,
    "a live creation-registered tab keeps its root — never rebound (#349)",
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, "creation-uuid-1", "the created tab's tag survives");
});

test("#349 r6 P0: a mid-load switch to a tab whose tracker is unreadable registers NOTHING (no guessing)", async () => {
  // The r6 hole: an async creation settles while a DIFFERENT tab B is active
  // and B's tracker can't be read. Registering the minted uuid against B
  // anyway would let C's tagged canvas match B through the guard's lineage
  // claim — a fail-open misattribution. With no positive stamp match the
  // registration must be skipped entirely (the tag floats ownerless, which can
  // only fail CLOSED).
  const foreignB = { isPersisted: true, path: "workflows/b.json", changeTracker: null };
  const { fakeApp, objectUuids, owners } = buildCreationForkHarness({
    onLoad: ({ app }) => {
      app.extensionManager.workflow.activeWorkflow = foreignB; // mid-load switch
      app.extensionManager.workflow.openWorkflows.push(foreignB);
    },
  });
  await fakeApp.loadGraphData({ nodes: [{ id: 1, type: "KSampler" }] });
  assert.equal(
    fakeApp.graph.extra.comfyui_mcp.workflow_uuid,
    "creation-uuid-1",
    "the creation still stamps the graph before it goes live",
  );
  assert.equal(
    owners.get("creation-uuid-1"),
    undefined,
    "no positive stamp match → NO registration (fail safe, never a guess)",
  );
  assert.equal(objectUuids.get(foreignB), undefined, "B's identity is untouched");

  // …and the guard fences C's tagged canvas while B is active: B does not
  // claim the tag, so there is nothing to heal — the stale canvas throws.
  const h = buildDirtyStaleRouteHarness({
    rootUuid: "creation-uuid-1",
    foreignClaim: "unloaded-proxy-owner",
    foreignTab: foreignB,
    registeredOwners: owners,
    objectUuids,
  });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    /NOT applied/,
    "an ownerless creation tag on a stale canvas stays fenced (#349)",
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, "creation-uuid-1", "the ownerless tag is not rewritten");
});

test("#349 r7 P0: a positive tracker match must NOT promote the stamp over an established CONFLICTING identity", async () => {
  // The r7 hole: the mid-load active tab B ALREADY has an established WeakMap
  // identity "uuid-B" and its (stale) tracker happens to carry the minted
  // stamp. Recording stampUuid → B anyway creates an owner-map claim that the
  // guard's lineage check then accepts — re-stamping C's foreign root with B's
  // identity. A conflicting established identity must veto the registration.
  const foreignB = {
    isPersisted: true,
    path: "workflows/b.json",
    changeTracker: { activeState: { extra: { comfyui_mcp: { workflow_uuid: "creation-uuid-1" } } } },
  };
  const { fakeApp, objectUuids, owners } = buildCreationForkHarness({
    onLoad: ({ app }) => {
      app.extensionManager.workflow.activeWorkflow = foreignB;
      app.extensionManager.workflow.openWorkflows.push(foreignB);
    },
  });
  objectUuids.set(foreignB, "uuid-B"); // B's identity is ALREADY established — and differs
  await fakeApp.loadGraphData({ nodes: [{ id: 1, type: "KSampler" }] });
  assert.equal(
    owners.get("creation-uuid-1"),
    undefined,
    "a conflicting established identity must veto the owner-map registration",
  );
  assert.equal(
    objectUuids.get(foreignB),
    "uuid-B",
    "B's established identity must NOT be overwritten by the creation stamp",
  );

  // …and the guard fences C's tagged canvas while B is active: with no
  // registration, B does not claim the tag — nothing to heal, the stale
  // canvas throws.
  const h = buildDirtyStaleRouteHarness({
    rootUuid: "creation-uuid-1",
    foreignClaim: "unloaded-proxy-owner",
    foreignTab: foreignB,
    registeredOwners: owners,
    objectUuids,
  });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    /NOT applied/,
    "with the registration vetoed, C's tagged canvas stays fenced (#349)",
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, "creation-uuid-1", "the foreign tag is not rewritten");
});

test("#557 r3/r4 wiring: programmaticSave threads the pre-save identity across a PROVEN in-place object swap", () => {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("async function programmaticSave(name)");
  assert.notEqual(start, -1, "programmaticSave must exist");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(
    body,
    /preSwapUuid = expectWf \? workflowObjectUuid\(expectWf\) \|\| workflowStableUuid\(expectWf\) : null/,
    "the pre-save identity must be captured from the pre-save object BEFORE the save",
  );
  // #1263 — the carry is shared with grounding's per-turn auto-persist, which swaps
  // the active object the same way: programmaticSave must delegate with the save's
  // own evidence, and the shared carry must keep the whole proof bar.
  assert.match(
    body,
    /carryIdentityAcrossSaveSwap\(\{\s*svc,\s*preWf: expectWf,\s*preSwapUuid,\s*savedAs: outcome\.saved_as,\s*savedRecord: details\?\.savedRecord \?\? null,?\s*\}\)/,
    "the carry must be delegated with the save API's own PRODUCED record — never path occupancy (r10 P0)",
  );
  const carryStart = src.indexOf("function carryIdentityAcrossSaveSwap(");
  assert.notEqual(carryStart, -1, "carryIdentityAcrossSaveSwap must exist");
  const carry = src.slice(carryStart, src.indexOf("\n}\n", carryStart));
  assert.match(
    carry,
    /preWfStillOpen =\s*!Array\.isArray\(openList\) \|\| openList\.some\(\(w\) => sameWorkflowObject\(w, preWf\)\)/,
    "a predecessor still present in the open tabs (a mid-save switch) must be detected",
  );
  assert.match(
    carry,
    /postWfIsSaveProducedRecord = Boolean\(savedRecord\) && sameWorkflowObject\(savedRecord, postSwapWf\)/,
    "continuity must be threaded from the save API's own PRODUCED record — never path occupancy (r10 P0)",
  );
  assert.doesNotMatch(
    carry,
    /successorCarriesPreUuid|postWfIsSaveTargetRecord|targetRecord/,
    "static evidence (tracker state, path occupancy) is NOT continuity (r8/r10 P0) — it must not appear in the carry",
  );
  assert.match(
    carry,
    /shouldCarryIdentityAcrossSaveSwap\(\{\s*preWf,\s*postWf: postSwapWf,\s*savedAs,\s*preWfStillOpen,\s*postWfHasConflictingEstablishedIdentity,\s*postWfIsSaveProducedRecord,?\s*\}\)/,
    "the carry must pass ALL continuity evidence to the pure rule (never a Save-As copy, never a mid-save switch, never over an established conflict, never on static evidence)",
  );
  assert.doesNotMatch(
    carry,
    /successorInPreSlot|preSwapSlotIndex/,
    "tab-slot occupancy is NOT continuity evidence (r5 P0) — it must not appear in the carry",
  );
  assert.match(
    carry,
    /postWfHasConflictingEstablishedIdentity = Boolean\(\s*postSwapWf && workflowObjectUuid\(postSwapWf\) && workflowObjectUuid\(postSwapWf\) !== preSwapUuid,?\s*\)/,
    "an established conflicting WeakMap identity on the successor must veto the carry (r7 P0)",
  );
  assert.match(
    carry,
    /setWorkflowObjectUuid\(postSwapWf, preSwapUuid\)/,
    "the successor object cache must be seeded with the pre-save uuid",
  );
  assert.match(
    carry,
    /rememberWorkflowUuidOwner\(preSwapUuid, postSwapWf\)/,
    "the successor must be registered as the pre-save uuid's owner",
  );
});

// Drives the REAL programmaticSave source with a fake saveActiveWorkflow that
// switches the active workflow mid-await — the r4 P0 shape (user switch or
// reconnect during the save). onSave performs the mid-save mutation of svc.
function buildProgrammaticSaveHarness({ onSave } = {}) {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  // #1263 — the slice starts at the shared carry: programmaticSave delegates to it,
  // so both functions must be in the evaluated source.
  const start = src.indexOf("function carryIdentityAcrossSaveSwap(");
  const end = src.indexOf("async function reconcileSavedWorkflowCopy(", start);
  assert.notEqual(start, -1, "carryIdentityAcrossSaveSwap must exist");
  assert.notEqual(end, -1, "programmaticSave boundary must exist");
  const saveSource = src.slice(start, end);
  const ownsTagSource = panelFunctionSource(src, "workflowOwnsRootUuidTag", "assertGraphBoundToActiveWorkflow");
  const A = { isPersisted: true, path: "workflows/a.json", changeTracker: { activeState: state(27) } };
  const B = {
    isPersisted: true,
    path: "workflows/b.json",
    isModified: true, // a DISTINCT dirty tab — the r4 switch target
    changeTracker: { activeState: state(5) },
  };
  const svc = { activeWorkflow: A, openWorkflows: [A, B] };
  const objectUuids = new WeakMap();
  const owners = new Map();
  const identityOf = (wf) =>
    objectUuids.get(wf) ?? (wf === A ? "uuid-A" : wf === B ? "uuid-B" : null);
  const ownsTag = new Function(
    "workflowStableUuid",
    "rawWorkflowObject",
    "sameWorkflowObject",
    "workflowUuidOwner",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    `${ownsTagSource}\nreturn workflowOwnsRootUuidTag;`,
  )(identityOf, rawWorkflowObject, sameWorkflowObject, (id) => owners.get(id) ?? null, "comfyui_mcp", "workflow_uuid");
  const save = new Function(
    "app",
    "saveActiveWorkflow",
    "autoWorkflowName",
    "workflowExistsOnDisk",
    "workflowDiskBytes",
    "reconcileSavedWorkflowCopy",
    "describeLiveCanvasBinding",
    "describeSaveOutcome",
    "classifyOriginalOnDisk",
    "normalizePath",
    "getWorkflowTitle",
    "workflowObjectUuid",
    "setWorkflowObjectUuid",
    "workflowStableUuid",
    "rememberWorkflowUuidOwner",
    "sameWorkflowObject",
    "shouldCarryIdentityAcrossSaveSwap",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    `${saveSource}\nreturn programmaticSave;`,
  )(
    { extensionManager: { workflow: svc } },
    async (svcArg, _name, opts) => {
      const outcome = onSave?.({ svc: svcArg, A, B }) ?? {}; // the mid-await switch / swap / reconnect
      opts.details.mode = "in-place";
      opts.details.targetPath = "workflows/a.json"; // the save wrote A's file (mirrors recordOutcome)
      // Mirrors the save lib's r10 thread: the save API's own produced record.
      if (outcome.producedRecord) opts.details.savedRecord = outcome.producedRecord;
      return "a.json";
    },
    () => "Untitled",
    async () => true,
    async () => null,
    async () => "unknown",
    () => "unknown", // describeLiveCanvasBinding — no durable tag in this harness (#708)
    () => ({ saved_as: false }),
    () => "unknown",
    (p) => p,
    () => "title",
    rawKeyedUuidStore(objectUuids).workflowObjectUuid,
    rawKeyedUuidStore(objectUuids).setWorkflowObjectUuid,
    identityOf,
    (id, owner) => owners.set(id, owner),
    sameWorkflowObject,
    shouldCarryIdentityAcrossSaveSwap,
    "comfyui_mcp",
    "workflow_uuid",
  );
  // The #349 fence input, computed the same way the guard does: does the ACTIVE
  // workflow itself claim this root tag (its own lineage → heal) or not (→
  // fail closed)?
  const activeClaims = (rootUuid) => ownsTag(svc.activeWorkflow, rootUuid);
  return { save, svc, A, B, objectUuids, owners, activeClaims };
}

test("#349 r4 P0: a tab SWITCH during the awaited save aborts the identity carry — B is never seeded with A's uuid", async () => {
  const { save, svc, A, B, objectUuids, owners, activeClaims } = buildProgrammaticSaveHarness({
    onSave: ({ svc }) => {
      svc.activeWorkflow = B; // user switched to a distinct dirty B while the save awaited
    },
  });
  await save();
  assert.equal(objectUuids.get(B), undefined, "B must NOT be seeded with A's uuid");
  assert.notEqual(owners.get("uuid-A"), B, "A's uuid must not be re-registered to B");
  assert.equal(
    activeClaims("uuid-A"),
    false,
    "B must not claim A's tag — the guard cannot heal an A-tagged root onto B",
  );
  assert.equal(
    resolveGraphRootUuidRebind({
      rootGraph: { extra: { comfyui_mcp: { workflow_uuid: "uuid-A" } } },
      activeWorkflowUuid: "uuid-B",
      rootTagClaimedByActiveWorkflow: activeClaims("uuid-A"),
    }),
    "conflict",
    "with the carry aborted, an A-tagged root stays fenced while B is active",
  );
});

test("#349 r4 P0: a RECONNECT-shaped mid-save switch (tab list rebuilt with new objects) aborts the carry", async () => {
  const aRebuilt = {
    isPersisted: true,
    path: "workflows/a.json", // A's file, NEW object after a reconnect — NOT A
    changeTracker: { activeState: state(27) },
  };
  const { save, svc, B, objectUuids, owners } = buildProgrammaticSaveHarness({
    onSave: ({ svc }) => {
      svc.openWorkflows = [aRebuilt, B]; // reconnect rebuilt the tab list
      svc.activeWorkflow = B;
    },
  });
  await save();
  assert.equal(objectUuids.get(B), undefined, "B must NOT be seeded with A's uuid");
  assert.notEqual(owners.get("uuid-A"), B, "A's uuid must not be re-registered to B");
});

test("#349 r5 P0: a CLOSE mid-await that compacts the tab list (B lands in A's old slot) aborts the carry", async () => {
  // The r5 hole: A is CLOSED while its save awaits and the open-tab list
  // compacts to [B], seating B in A's former slot. Slot occupancy is NOT
  // succession — B carries NO A lineage, so the carry must abort and B must
  // keep its own identity.
  const { save, svc, B, objectUuids, owners, activeClaims } = buildProgrammaticSaveHarness({
    onSave: ({ svc }) => {
      svc.openWorkflows = [B]; // A closed; the list compacted — B now occupies A's slot
      svc.activeWorkflow = B;
    },
  });
  await save();
  assert.equal(objectUuids.get(B), undefined, "B must NOT be seeded with A's uuid via A's vacated slot");
  assert.notEqual(owners.get("uuid-A"), B, "A's uuid must not be re-registered to B");
  assert.equal(
    activeClaims("uuid-A"),
    false,
    "B must not claim A's tag — the guard cannot heal an A-tagged stale canvas onto B",
  );
  assert.equal(
    resolveGraphRootUuidRebind({
      rootGraph: { extra: { comfyui_mcp: { workflow_uuid: "uuid-A" } } },
      activeWorkflowUuid: "uuid-B",
      rootTagClaimedByActiveWorkflow: activeClaims("uuid-A"),
    }),
    "conflict",
    "with the carry aborted, writes to A's stale root stay fenced while B is active",
  );
});

test("#349 r8 P0: a foreign tab whose LAGGING tracker carries the pre-save uuid must not inherit the carry", async () => {
  // The r8 spoof: A closed mid-await; B — a FOREIGN tab (different file), with
  // no WeakMap cache (so the r7 conflict veto cannot fire) — becomes active,
  // and its lagging activeState still carries A's uuid as residue. Static
  // tracker evidence is indistinguishable from "the successor parsed the
  // just-saved file" (the r6 evidence class, one layer up), so the carry must
  // require event-threaded continuity instead: the post-save ACTIVE object
  // must be the service's current record for the file THIS save wrote.
  const foreignB = {
    isPersisted: true,
    path: "workflows/b.json",
    isModified: true,
    changeTracker: {
      activeState: { ...state(5), extra: { comfyui_mcp: { workflow_uuid: "uuid-A" } } }, // stale residue
    },
  };
  const { save, svc, A, objectUuids, owners, activeClaims } = buildProgrammaticSaveHarness({
    onSave: ({ svc }) => {
      svc.openWorkflows = [foreignB]; // A closed; foreign B activated
      svc.activeWorkflow = foreignB;
    },
  });
  await save();
  assert.equal(objectUuids.get(foreignB), undefined, "B must NOT be seeded with A's uuid on stale residue");
  assert.notEqual(owners.get("uuid-A"), foreignB, "A's owner record must stay intact");
  assert.equal(
    activeClaims("uuid-A"),
    false,
    "B must not claim A's tag — the guard cannot heal an A-tagged stale canvas onto B",
  );
  assert.equal(
    resolveGraphRootUuidRebind({
      rootGraph: { extra: { comfyui_mcp: { workflow_uuid: "uuid-A" } } },
      activeWorkflowUuid: "uuid-B",
      rootTagClaimedByActiveWorkflow: activeClaims("uuid-A"),
    }),
    "conflict",
    "with the carry vetoed, writes to A's stale canvas stay fenced while B is active",
  );
});

test("#349 r10 P0: a same-path close→reopen during the awaited save aborts the carry (reopened = new identity)", async () => {
  // The r10 hole: A's tab CLOSES while the save awaits and a DISTINCT object B
  // reopens the SAME path. Path occupancy (r8's target record) is satisfied by
  // B — but B is not what the save PRODUCED, so the carry must abort: a
  // closed→reopened object is a NEW identity (r5's rule), never a successor.
  const reopenedB = {
    isPersisted: true,
    path: "workflows/a.json", // SAME path — but a DISTINCT object
    isModified: true,
    changeTracker: {
      activeState: { ...state(27), extra: { comfyui_mcp: { workflow_uuid: "uuid-A" } } },
    },
  };
  const saveProducedRecord = {
    isPersisted: true,
    path: "workflows/a.json", // what the save API itself produced — NOT reopenedB
    changeTracker: { activeState: state(27) },
  };
  const { save, svc, objectUuids, owners, activeClaims } = buildProgrammaticSaveHarness({
    onSave: ({ svc }) => {
      svc.openWorkflows = [reopenedB]; // A closed; B reopened the same path and is its record
      svc.activeWorkflow = reopenedB;
      return { producedRecord: saveProducedRecord };
    },
  });
  await save();
  assert.equal(objectUuids.get(reopenedB), undefined, "a reopened object must NOT be seeded — it is a NEW identity");
  assert.notEqual(owners.get("uuid-A"), reopenedB, "A's owner record stays intact");
  assert.equal(
    activeClaims("uuid-A"),
    false,
    "the reopened object must not claim A's tag — the guard cannot heal onto it",
  );
  assert.equal(
    commandWorkflowMismatch({ commandUuid: "uuid-A", activeUuid: "uuid-B" }),
    true,
    "stale A-scoped commands stay fenced against the reopened object (#349)",
  );
});

test("#557 r4 control: a GENUINE save-swap successor still carries the pre-save identity", async () => {
  const successor = {
    isPersisted: true,
    path: "workflows/a.json", // A's successor: same file, NEW object, predecessor GONE
    changeTracker: {
      activeState: { ...state(27), extra: { comfyui_mcp: { workflow_uuid: "uuid-A" } } },
    },
  };
  const { save, svc, objectUuids, owners } = buildProgrammaticSaveHarness({
    onSave: ({ svc }) => {
      svc.openWorkflows = [successor]; // a genuine swap REMOVES the predecessor
      svc.activeWorkflow = successor;
      return { producedRecord: successor }; // the save API's own result IS the successor
    },
  });
  await save();
  assert.equal(
    objectUuids.get(successor),
    "uuid-A",
    "the save-produced successor is seeded with the pre-save uuid (#557)",
  );
  assert.equal(owners.get("uuid-A"), successor, "the successor becomes the uuid's registered owner");
});

test("#566: a FIRST-SAVE swap (temp tab saved under a real name) carries the identity to the saved successor", async () => {
  // The #566 first-save shape: a never-persisted "Unsaved Workflow" tab is saved
  // under a real name — the successor lives at a DIFFERENT path, and the save
  // CONSUMED the temp predecessor (no ghost tab). The temp tab's identity must
  // continue onto the saved successor, not die with the consumed tab.
  const successor = {
    isPersisted: true,
    path: "workflows/XYR_SH01_v001.json", // the first save's real file — a NEW path
    changeTracker: {
      activeState: { ...state(27), extra: { comfyui_mcp: { workflow_uuid: "uuid-A" } } },
    },
  };
  const { save, svc, objectUuids, owners } = buildProgrammaticSaveHarness({
    onSave: ({ svc }) => {
      svc.openWorkflows = [successor]; // the first save CONSUMED the temp predecessor (#566)
      svc.activeWorkflow = successor;
      return { producedRecord: successor }; // the trio's produced record IS the successor (r10)
    },
  });
  await save();
  assert.equal(
    objectUuids.get(successor),
    "uuid-A",
    "the saved successor inherits the temp tab's pre-save identity",
  );
  assert.equal(owners.get("uuid-A"), successor, "the successor becomes the uuid's registered owner");
});

test("#349 r7 P0: a successor with an established CONFLICTING identity is not overwritten by the carry", async () => {
  // The successor proves continuity (its tracker carries the pre-save uuid),
  // but it ALREADY has an established, different WeakMap identity — a
  // conflicting tab, not A's continuation. Overwriting would promote the stamp
  // over the object's own identity and poison the owner map.
  const successor = {
    isPersisted: true,
    path: "workflows/a.json",
    changeTracker: {
      activeState: { ...state(27), extra: { comfyui_mcp: { workflow_uuid: "uuid-A" } } },
    },
  };
  const { save, svc, objectUuids, owners } = buildProgrammaticSaveHarness({
    onSave: ({ svc }) => {
      svc.openWorkflows = [successor];
      svc.activeWorkflow = successor;
    },
  });
  objectUuids.set(successor, "uuid-X"); // established BEFORE the seed — and conflicting
  await save();
  assert.equal(
    objectUuids.get(successor),
    "uuid-X",
    "the carry must not overwrite an established conflicting identity",
  );
  assert.notEqual(owners.get("uuid-A"), successor, "A's uuid must not be re-registered over the conflict");
});

test("#349 r11 P0: the carry veto sees a RAW-keyed established identity when the active successor arrives as a PROXY", async () => {
  // The r2 proxy/raw duality inside the veto itself: the established identity
  // "uuid-X" is keyed by the RAW successor, but the post-save ACTIVE object
  // arrives as a Vue proxy. A proxy-keyed WeakMap lookup misses the raw-keyed
  // conflict, and the seed then writes a proxy-keyed foreign identity.
  const successor = {
    isPersisted: true,
    path: "workflows/a.json",
    changeTracker: {
      activeState: { ...state(27), extra: { comfyui_mcp: { workflow_uuid: "uuid-A" } } },
    },
  };
  const successorProxy = vueProxyOf(successor);
  const { save, svc, objectUuids, owners } = buildProgrammaticSaveHarness({
    onSave: ({ svc }) => {
      svc.openWorkflows = [successorProxy];
      svc.activeWorkflow = successorProxy;
      return { producedRecord: successor }; // the save produced the RAW record; active holds the PROXY
    },
  });
  objectUuids.set(successor, "uuid-X"); // established BEFORE the seed, keyed by the RAW object
  await save();
  assert.equal(objectUuids.get(successor), "uuid-X", "the veto must see the raw-keyed conflict — no overwrite");
  assert.notEqual(owners.get("uuid-A"), successor, "no owner registration over the conflict");
  assert.notEqual(owners.get("uuid-A"), successorProxy, "no proxy-keyed registration either");
});

test("#349 r11 P0: the creation-registration veto sees a RAW-keyed established identity when the active tab is a PROXY", async () => {
  const foreignB = {
    isPersisted: true,
    path: "workflows/b.json",
    changeTracker: { activeState: { extra: { comfyui_mcp: { workflow_uuid: "creation-uuid-1" } } } },
  };
  const foreignBProxy = vueProxyOf(foreignB);
  const { fakeApp, objectUuids, owners } = buildCreationForkHarness({
    onLoad: ({ app }) => {
      app.extensionManager.workflow.activeWorkflow = foreignBProxy; // mid-load switch, PROXY form
      app.extensionManager.workflow.openWorkflows.push(foreignBProxy);
    },
  });
  objectUuids.set(foreignB, "uuid-B"); // established BEFORE, keyed by the RAW object
  await fakeApp.loadGraphData({ nodes: [{ id: 1, type: "KSampler" }] });
  assert.equal(
    owners.get("creation-uuid-1"),
    undefined,
    "the veto must see the raw-keyed conflict — no owner-map registration",
  );
  assert.equal(objectUuids.get(foreignB), "uuid-B", "the raw-keyed identity is untouched");
  assert.equal(objectUuids.get(foreignBProxy), undefined, "nothing was keyed by the proxy");
});

test("#557 r11: workflowStableUuid finds a RAW-keyed established identity when handed the PROXY", () => {
  const { stableUuid, successor, objectUuids } = buildSavedSuccessorHarness({ ownerOpen: false });
  objectUuids.set(successor, "uuid-R"); // established, keyed by the RAW object
  const id = stableUuid(vueProxyOf(successor)); // the lookup side holds the PROXY
  assert.equal(id, "uuid-R", "the resolver unwraps the proxy and finds the raw-keyed identity");
});

// ── #557: save replaces the active workflow object — identity must follow ────

test("#557: a save's successor object INHERITS the embedded uuid when the replaced owner is gone", () => {
  const { stableUuid, successor, replaced, owners, U1 } = buildSavedSuccessorHarness({ ownerOpen: false });
  const id = stableUuid(successor);
  assert.equal(
    id,
    U1,
    "the successor must keep the pre-save identity — minting fresh desyncs it from the root tag",
  );
  assert.equal(owners.get(U1), successor, "ownership moves to the successor object");
  assert.notEqual(owners.get(U1), replaced);
});

test("#557: a genuinely co-open copy still FORKS away from the live owner's embedded uuid (#570)", () => {
  // A real copy lives at a DIFFERENT path while carrying the source's embedded
  // uuid; the source (owner) is live in openWorkflows.
  const { stableUuid, successor, U1 } = buildSavedSuccessorHarness({
    ownerOpen: true,
    currentPath: "workflows/y.json",
    embeddedPath: "workflows/x.json",
    aliases: {},
  });
  const id = stableUuid(successor);
  assert.notEqual(id, U1, "two simultaneously-open objects must never share one identity");
  assert.match(id, /^fresh-/, "the copy gets a fresh per-instance identity");
});

test("#570 r2: a co-open copy FORKS even when the live owner appears in openWorkflows only as a proxy", () => {
  // The codex r2 hole: openWorkflows holds a PROXY of the raw registered owner,
  // so a raw `includes` reads the live foreign owner as closed and the copy
  // INHERITS the source identity (shared uuid → cross-resume, and the desync
  // guard can no longer tell the two canvases apart). No path evidence saves us
  // here (the file carries no embedded path and the browser has no aliases), so
  // the proxy-safe owner check is the ONLY fork signal.
  const { stableUuid, successor, U1 } = buildSavedSuccessorHarness({
    ownerOpen: "proxy",
    currentPath: "workflows/y.json",
    embeddedPath: null,
    aliases: {},
  });
  const id = stableUuid(successor);
  assert.notEqual(id, U1, "a proxy-wrapped live owner is still a live foreign owner — the copy must fork");
  assert.match(id, /^fresh-/);
});

test("#349 r9 P0: a CLOSED owner + different-path copy + no alias/embedded-path FORKS — never inherits", () => {
  // The r9 hole: "the owner is closed" alone qualified as succession, so a copy
  // of a file that carries ONLY workflow_uuid (saved from an unsaved tab, whose
  // embed omitted workflow_path) inherited A's identity once A closed — then
  // overwrote A's owner record, letting stale A-scoped commands pass the fence
  // against the copy. Without positive succession evidence the copy must fork.
  const { stableUuid, successor, replaced, owners, U1 } = buildSavedSuccessorHarness({
    ownerOpen: false, // the owner is CLOSED
    currentPath: "workflows/y.json", // the COPY lives at a different path
    embeddedPath: null, // the file carries only workflow_uuid — no path record
    aliases: {}, // and no alias exists
  });
  const id = stableUuid(successor);
  assert.notEqual(id, U1, "a different-path copy with no succession evidence must FORK");
  assert.match(id, /^fresh-/, "the copy gets a fresh per-instance identity");
  assert.equal(owners.get(U1), replaced, "A's owner record stays intact — never re-keyed to the copy");
  assert.equal(
    commandWorkflowMismatch({ commandUuid: U1, activeUuid: id }),
    true,
    "stale A-scoped commands stay fenced against the copy (#349)",
  );
});

test("#349 r10: a same-path successor of a PATH-LESS file FORKS — reopened object, new identity", () => {
  // The file carries only workflow_uuid (no workflow_path record) and no alias
  // exists, so the only "evidence" would be the closed owner's file matching —
  // which r10 excludes: a closed→reopened object at the same path is a NEW
  // identity. (The durable-resume heal belongs to the UNREGISTERED-embedded
  // path, not to registered-owner inheritance.)
  const { stableUuid, successor, replaced, owners, U1 } = buildSavedSuccessorHarness({
    ownerOpen: false,
    currentPath: "workflows/x.json", // same path as the closed owner, but a distinct object
    embeddedPath: null,
    aliases: {},
  });
  const id = stableUuid(successor);
  assert.notEqual(id, U1, "owner-file match alone is NOT succession evidence (r10)");
  assert.match(id, /^fresh-/, "the reopened object gets a fresh per-instance identity");
  assert.equal(owners.get(U1), replaced, "A's owner record stays intact");
});

test("#557 r9 control: a same-file successor still INHERITS via the file's own path record", () => {
  // Positive succession evidence layer 1: the file's recorded workflow_path
  // ties the uuid to this object's file — the genuine #557 save-swap / same-file
  // reload of a properly-stamped file.
  const { stableUuid, successor, U1 } = buildSavedSuccessorHarness({
    ownerOpen: false,
    currentPath: "workflows/x.json",
    embeddedPath: "workflows/x.json",
    aliases: {},
  });
  const id = stableUuid(successor);
  assert.equal(id, U1, "the file's own path record proves succession — the successor inherits");
});

test("#557 regression: after the save-swap, the guard sees no mismatch (root tag and object stay aligned)", () => {
  // The pre-save root tag equals the embedded uuid the successor inherits — the
  // exact alignment panel_save_workflow broke before this fix.
  const { stableUuid, successor, U1 } = buildSavedSuccessorHarness({ ownerOpen: false });
  const activeWorkflowUuid = stableUuid(successor);
  const rootGraph = { extra: { comfyui_mcp: { workflow_uuid: U1 } } };
  assert.equal(graphRootWorkflowUuidMismatches({ rootGraph, activeWorkflowUuid }), false);
  assert.equal(graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid }), true);
});

test("#545 P1: command identity resolution cannot adopt a stale dirty root before the binding fence", () => {
  // This drives the actual panel resolver followed by the actual panel fence in
  // the same order bridge dispatch uses. It reproduces the P1: active dirty A
  // has not been seen yet, while app.graph still holds B. If workflowStableUuid
  // reads or rewrites that root, the fence sees A as B and graph mutation passes.
  const { workflowA, rootB, stableUuid, assertBound } = buildDirtyStaleRouteHarness();

  const activeUuid = stableUuid(workflowA);
  assert.notEqual(activeUuid, "workflow-B", "the stale root must not establish A's identity");
  assert.equal(rootB.extra.comfyui_mcp.workflow_uuid, "workflow-B", "identity resolution must not rewrite the foreign root");
  assert.throws(
    () => assertBound(rootB, rootB, { includeBaselineReadGuard: false }),
    /NOT applied/,
    "the positive B-vs-A UUID mismatch must stop the graph command after resolution",
  );
});

test("#545 P1: direct snapshot restore refuses an untagged stale B for dirty A", async () => {
  const { src, workflowA, rootB, objectUuids, assertBound } = buildDirtyStaleRouteHarness({ rootUuid: null });
  let loads = 0;
  // restoreSnapshot PLUS the load-deadline machinery it closes over.
  const restoreStart = src.indexOf("/** How long a snapshot restore's " + String.fromCharCode(96) + "loadGraphData" + String.fromCharCode(96));
  assert.notEqual(restoreStart, -1, "could not locate the restore load budget");
  const restoreSource = src.slice(restoreStart, panelFunctionStart(src, "revertGraphToLastSnapshot", restoreStart + 1));
  const restoreSnapshot = new Function(
    "getGraphCtx",
    "activeWorkflowRef",
    "assertGraphBoundToActiveWorkflow",
    "MUTATION_BINDING_BAR",
    "coerceMessageText",
    "activeWorkflowReloadGuard",
    "acquireWorkflowReloadGuard",
    "beginWorkflowReloadStep",
    "endWorkflowReloadStep",
    "releaseWorkflowReloadGuard",
    `${restoreSource}\nreturn restoreSnapshot;`,
  )(
    () => ({ app: { loadGraphData: () => { loads += 1; } }, graph: rootB, rootGraph: rootB }),
    () => workflowA,
    assertBound,
    MUTATION_BINDING_BAR,
    (v) => String(v ?? ""),
    () => null,
    () => 1,
    () => true,
    () => {},
    () => {},
  );

  const outcome = await restoreSnapshot({ workflowRef: workflowA, data: { nodes: [] } });
  assert.equal(
    outcome.status,
    "refused",
    "the local restore path must REFUSE the binding rather than load B into A",
  );
  // …and it must PRESERVE the reason rather than collapse it to a bare null: the
  // callers render an absent outcome as "nothing to revert", which would tell the
  // user there was never a snapshot at the exact moment they are trying to recover.
  assert.match(
    outcome.reason,
    /NOT applied/,
    "the refusal must carry the panel's own reason for the caller to surface",
  );
  assert.ok(objectUuids.get(workflowA), "the direct guard must root-blindly establish A");
  assert.equal(rootB.extra?.comfyui_mcp?.workflow_uuid, undefined, "the untagged stale root remains untouched");
  assert.equal(loads, 0, "a refused direct restore must not call loadGraphData");
});

test("#545 P1: direct CivitAI graph_load refuses an untagged stale B for dirty A", async () => {
  const { src, workflowA, rootB, objectUuids, assertBound } = buildDirtyStaleRouteHarness({ rootUuid: null });
  let loads = 0;
  const start = src.indexOf("  async graph_load({ graph: incoming } = {}) {");
  const end = src.indexOf("\n\n  graph_connect(", start);
  assert.notEqual(start, -1, "could not locate graph_load executor");
  assert.notEqual(end, -1, "could not locate graph_load executor boundary");
  const graphLoadSource = src.slice(start, end);
  const graphLoad = new Function(
    "getGraphCtx",
    "assertGraphBoundToActiveWorkflow",
    "MUTATION_BINDING_BAR",
    `const GRAPH_TOOL_EXECUTORS = {${graphLoadSource}\n}; return GRAPH_TOOL_EXECUTORS.graph_load;`,
  )(
    () => ({ app: { loadGraphData: async () => { loads += 1; } }, graph: rootB, rootGraph: rootB }),
    assertBound,
    MUTATION_BINDING_BAR,
  );

  await assert.rejects(
    graphLoad({ graph: { nodes: [] } }),
    /NOT applied/,
    "the CivitAI direct path must stop before loading external JSON into stale B",
  );
  assert.ok(objectUuids.get(workflowA), "the direct guard must root-blindly establish A");
  assert.equal(rootB.extra?.comfyui_mcp?.workflow_uuid, undefined, "the untagged stale root remains untouched");
  assert.equal(loads, 0, "a refused direct graph_load must not call loadGraphData");
});

test("graphReadBindingChanged: FALSE — same workflow instance and root graph across the await", () => {
  const w = wf();
  const g = {};
  assert.equal(
    graphReadBindingChanged({ beforeWorkflow: w, afterWorkflow: w, beforeRootGraph: g, afterRootGraph: g }),
    false,
  );
});

test("graphReadBindingChanged: TRUE — a tab switch swapped the active workflow instance mid-probe (#513 review)", () => {
  const g = {};
  assert.equal(
    graphReadBindingChanged({ beforeWorkflow: wf(), afterWorkflow: wf(), beforeRootGraph: g, afterRootGraph: g }),
    true,
  );
});

test("graphReadBindingChanged: TRUE — the root graph was rebound across the await", () => {
  const w = wf();
  assert.equal(
    graphReadBindingChanged({ beforeWorkflow: w, afterWorkflow: w, beforeRootGraph: {}, afterRootGraph: {} }),
    true,
  );
});

test("graphReadBindingChanged: TRUE — the binding went unresolvable mid-read (one side null)", () => {
  const w = wf();
  const g = {};
  assert.equal(
    graphReadBindingChanged({ beforeWorkflow: w, afterWorkflow: null, beforeRootGraph: g, afterRootGraph: g }),
    true,
  );
});

test("graphReadBindingChanged: FALSE — both snapshots unresolvable never manufactures a mismatch", () => {
  assert.equal(graphReadBindingChanged(), false);
  assert.equal(
    graphReadBindingChanged({
      beforeWorkflow: null,
      afterWorkflow: null,
      beforeRootGraph: null,
      afterRootGraph: null,
    }),
    false,
  );
});

// ── panel wiring: validationBanner's probe is fenced by the correlation ─────

test("#513 review wiring: validationBanner fences its server probe against a mid-await workflow switch", () => {
  // The proactive turn-start banner captures node errors / exec failure / missing
  // assets from workflow A, then AWAITS the nested-input server probe. A tab
  // switch in that window used to inject A's banner into B's session. The panel
  // source must snapshot the binding BEFORE the await and silently skip (the
  // banner is best-effort — no recoverable retry) when it provably changed.
  // (the panel file is CRLF — normalize so the column-0 `}` anchor matches)
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("async function validationBanner()");
  assert.notEqual(start, -1, "validationBanner must exist in the panel");
  const end = src.indexOf("\n}\n", start); // top-level function closes at column 0
  assert.notEqual(end, -1);
  const body = src.slice(start, end);

  const snapAt = body.indexOf("const preProbeWorkflow = activeWorkflowRef();");
  const probeAt = body.indexOf("await filterServerConfirmedInputSubfolderMedia");
  assert.notEqual(snapAt, -1, "banner must snapshot the active workflow before probing");
  assert.notEqual(probeAt, -1, "banner must await the nested-input probe");
  assert.ok(
    snapAt < probeAt,
    `workflow snapshot must precede the probe await (snap@${snapAt} vs probe@${probeAt})`,
  );

  const fenceAt = body.indexOf("graphReadBindingChanged({");
  assert.notEqual(fenceAt, -1, "banner must re-check the binding after the probe");
  assert.ok(fenceAt > probeAt, "the binding re-check must follow the probe await");
  assert.match(
    body.slice(fenceAt),
    /afterWorkflow: activeWorkflowRef\(\)/,
    "the fence must re-read the NOW-active workflow",
  );
  const discardAt = body.indexOf('return "";', fenceAt);
  assert.notEqual(discardAt, -1, "a binding change must silently skip the banner (best-effort)");
  const sigAt = body.indexOf("lastInjectedValidationSig = sig");
  assert.notEqual(sigAt, -1, "banner must stamp the dedupe signature");
  assert.ok(
    discardAt < sigAt,
    "the mismatch discard must precede the dedupe-sig stamp — A's state must not poison B's dedupe",
  );
});

test("#349 wiring: every graph command verifies LiteGraph is bound, with positive dirty binding limited to mutations", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const handlerStart = src.indexOf("const executor = GRAPH_TOOL_EXECUTORS[msg.cmd];");
  assert.notEqual(handlerStart, -1, "bridge graph-command handler must exist");
  const handler = src.slice(handlerStart, src.indexOf("result = await executor(msg);", handlerStart));
  assert.match(handler, /msg\.cmd\.startsWith\("graph_"\)/, "graph commands must have a root-binding fence");
  assert.match(
    handler,
    /assertGraphBoundToActiveWorkflow\(graph, rootGraph, graphCommandBindingBar\(msg\.cmd\)\)/,
    "the fence must inspect the executor graph and derive its bar from the command's mutability",
  );
});

test("#349 direct paths: run, CivitAI load, and snapshot restore fence the live root before success", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const orderedFence = (startNeedle, beforeNeedle) => {
    const start = src.indexOf(startNeedle);
    const before = src.indexOf(beforeNeedle, start);
    const fence = src.indexOf("assertGraphBoundToActiveWorkflow(graph, rootGraph, {", start);
    assert.notEqual(start, -1, `${startNeedle} must exist`);
    assert.notEqual(before, -1, `${beforeNeedle} must follow ${startNeedle}`);
    assert.ok(fence > start && fence < before, `${startNeedle} must fence before ${beforeNeedle}`);
    assert.match(
      src.slice(fence, before),
      /\.\.\.MUTATION_BINDING_BAR/,
      `${startNeedle} must clear the full MUTATION binding bar, not a reduced one`,
    );
  };

  orderedFence("async graph_run({ batch_count, to_node_id })", "app.queuePrompt");
  orderedFence("async graph_load({ graph: incoming } = {})", "captureGraphSnapshot(null, \"before graph_load\")");
  orderedFence("function restoreSnapshot(snap)", "payload = JSON.parse(JSON.stringify(snap.data))");
});

test("#349 snapshots: capture is bound and restore rejects a snapshot from another workflow", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const captureStart = src.indexOf("function captureGraphSnapshot(mid, label)");
  const captureSerialize = src.indexOf("const data = rootGraph.serialize();", captureStart);
  const captureFence = src.indexOf("assertGraphBoundToActiveWorkflow(graph, rootGraph, {", captureStart);
  assert.ok(captureStart >= 0 && captureFence > captureStart && captureFence < captureSerialize);
  assert.match(
    src.slice(captureFence, captureSerialize),
    /\.\.\.MUTATION_BINDING_BAR/,
    "snapshot capture must not record an unbound dirty root for later restore",
  );
  assert.match(
    src.slice(captureStart, captureSerialize),
    /\[workflowRef\?\.changeTracker\?\.activeState, workflowRef\?\.activeState\]\.find\(/,
    "snapshot capture must fall back to a valid flat activeState when tracker state is malformed",
  );
  assert.match(
    src.slice(captureStart, src.indexOf("while (graphSnapshots.length", captureStart)),
    /graphSnapshots\.push\(\{[^}]*data, workflowRef \}\)/,
    "a captured snapshot must retain its workflow instance",
  );

  const restoreStart = src.indexOf("function restoreSnapshot(snap)");
  const restoreLoad = src.indexOf("payload = JSON.parse(JSON.stringify(snap.data))", restoreStart);
  const restoreBody = src.slice(restoreStart, restoreLoad);
  assert.match(
    restoreBody,
    /!snap\.workflowRef \|\| snap\.workflowRef !== activeWorkflowRef\(\)/,
    "restore must reject missing or cross-workflow snapshot provenance",
  );

  const revertStart = src.indexOf("function revertGraphToLastSnapshot()");
  const revertEnd = src.indexOf("\n}\n", revertStart);
  const revertBody = src.slice(revertStart, revertEnd);
  assert.match(
    revertBody,
    /graphSnapshots\.filter\(\(snap\) => snap\?\.workflowRef === workflowRef\)/,
    "revert must select candidates only from the active workflow instance",
  );
  assert.match(
    revertBody,
    /pickRevertSnapshot\(scopedSnapshots, current\)/,
    "a foreign newer snapshot must not hide an older same-workflow revert",
  );
});

// ── #560/#565: reconnect / multi-tab + blank-canvas binding recurrence ──────

test("resolveGraphRootUuidRebind: a stale tag on a BOTH-EMPTY canvas rebinds (#565); anything else stays closed", () => {
  const tagged = { _nodes: [], extra: { comfyui_mcp: { workflow_uuid: "workflow-prev" } } };
  assert.equal(
    resolveGraphRootUuidRebind({
      rootGraph: tagged,
      activeWorkflowUuid: "workflow-new",
      rootTagClaimedByActiveWorkflow: false,
      staleTagOnEmptyCanvas: true,
    }),
    "rebind",
    "zero content on both sides: the leftover tag is stale metadata, not a foreign canvas",
  );
  assert.equal(
    resolveGraphRootUuidRebind({ rootGraph: tagged, activeWorkflowUuid: "workflow-new", staleTagOnEmptyCanvas: false }),
    "conflict",
    "without the both-empty proof the same tag still fails closed (r4/r5)",
  );
  assert.equal(
    resolveGraphRootUuidRebind({ rootGraph: tagged, activeWorkflowUuid: "workflow-prev", staleTagOnEmptyCanvas: true }),
    "none",
    "no conflict stays inconclusive, flag or not",
  );
});

test("#565: graphRootMismatchesActiveWorkflow is inconclusive when BOTH node arrays are empty", () => {
  const activeWorkflow = wf({ changeTracker: { activeState: { nodes: [] } } });
  const liveState = {
    nodes: [],
    links: [],
    groups: [],
    reroutes: [],
    config: {},
    extra: { ds: { scale: 1 }, comfyui_mcp: { workflow_uuid: "workflow-prev" } },
  };
  assert.equal(
    graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(liveState), activeWorkflow }),
    false,
    "zero content on both sides can never be a confused canvas",
  );
});

// ── #565 gate: the proven-empty evidence bar ─────────────────────────────────

test("serializedStateProvenEmpty: TRUE only for a well-formed, fully content-free state", () => {
  assert.equal(serializedStateProvenEmpty({ nodes: [] }), true, "the minimal blank state");
  assert.equal(
    serializedStateProvenEmpty({
      id: "g",
      revision: 3,
      version: 0.4,
      last_node_id: 12,
      last_link_id: 8,
      nodes: [],
      links: [],
      groups: [],
      config: {},
      extra: { ds: { scale: 2 }, comfyui_mcp: { workflow_uuid: "u" }, linkExtensions: [] },
    }),
    true,
    "format metadata, viewport, the panel identity tag, and empty surfaces are not content",
  );
});

test("serializedStateProvenEmpty: FALSE for missing/malformed nodes or ANY non-empty surface", () => {
  for (const state of [
    null,
    undefined,
    42,
    [],
    {},
    { nodes: "bad" }, // malformed read — not an empty-array proof
    { nodes: [{ id: 1 }] }, // a node is content
    { nodes: [], subgraphs: [{ id: "s", nodes: [{ id: 9 }] }] },
    { nodes: [], groups: [{ id: 1, title: "g" }] },
    { nodes: [], reroutes: [{ id: "r" }] },
    { nodes: [], links: [[1, 1, 0, 2, 0, "MODEL"]] },
    { nodes: [], config: { setting: 1 } },
    { nodes: [], definitions: { subgraphs: [{ id: "def" }] } },
    { nodes: [], extra: { workflow_meta: { owner: "artist" } } }, // real extra content
    { nodes: [], extra: 5 }, // malformed scalar extra
    { nodes: [], unknownSurface: { nested: "content" } }, // unknown non-empty surface
  ]) {
    assert.equal(serializedStateProvenEmpty(state), false, JSON.stringify(state));
  }
});

test("activeWorkflowProvenEmpty: requires a CLEAN, well-formed, zero-node CURRENT state", () => {
  assert.equal(
    activeWorkflowProvenEmpty(wf({ changeTracker: { activeState: { nodes: [] } } })),
    true,
    "the genuine #565 blank tab",
  );
  assert.equal(
    activeWorkflowProvenEmpty(wf({ activeState: { nodes: [] } })),
    true,
    "flat activeState shapes count too",
  );
  // A DIRTY tab's tracker can lag the real canvas (#545) — never proof.
  assert.equal(
    activeWorkflowProvenEmpty(wf({ changeTracker: { activeState: { nodes: [] } }, isModified: true })),
    false,
  );
  // Absent / malformed / baseline-only reads fail closed — a 0 from
  // activeWorkflowNodeCount is not evidence.
  assert.equal(activeWorkflowProvenEmpty(null), false);
  assert.equal(activeWorkflowProvenEmpty(wf({ changeTracker: {} })), false);
  assert.equal(activeWorkflowProvenEmpty(wf({ changeTracker: { activeState: { nodes: "bad" } } })), false);
  assert.equal(activeWorkflowProvenEmpty(wf({ changeTracker: { initialState: state(0) } })), false);
  // Surface content defeats the proof even at zero nodes.
  assert.equal(
    activeWorkflowProvenEmpty(wf({ changeTracker: { activeState: { nodes: [], subgraphs: [{ id: "s" }] } } })),
    false,
  );
});

test("graphRootProvenEmpty: requires a present empty _nodes array AND a serializable content-free state", () => {
  assert.equal(
    graphRootProvenEmpty(serializedRoot({ nodes: [], links: [], extra: { comfyui_mcp: { workflow_uuid: "u" } } })),
    true,
    "the genuine reused blank canvas (identity tag is not content)",
  );
  assert.equal(
    graphRootProvenEmpty({ _nodes: [] }),
    false,
    "a bare empty node array without serialize() proves nothing about surfaces",
  );
  assert.equal(
    graphRootProvenEmpty(serializedRoot({ nodes: [], groups: [{ id: 1, title: "g" }] })),
    false,
    "non-node surface content defeats the proof",
  );
  assert.equal(
    graphRootProvenEmpty(serializedRoot({ nodes: [{ id: 1, type: "KSampler" }] })),
    false,
    "a populated root is not empty",
  );
  assert.equal(graphRootProvenEmpty(null), false);
  assert.equal(graphRootProvenEmpty({}), false);
});

test("#560: a tracker state omitting optional surfaces does NOT false-mismatch the live canvas it was loaded from", () => {
  // The reconnect / multi-tab recurrence: the canvas IS the active workflow's
  // own graph, but ChangeTracker's state omits surfaces LiteGraph's
  // serialize() emits present-but-empty, and the panel tag lives only on the
  // live side. That serializer dialect is not a binding mismatch.
  const trackerState = {
    nodes: [
      { id: 1, type: "CheckpointLoader", widgets_values: ["model.safetensors"] },
      { id: 2, type: "KSampler", widgets_values: [20] },
      { id: 3, type: "SaveImage" },
    ],
    links: [[1, 1, 0, 2, 0, "MODEL"]],
  };
  const liveState = {
    ...structuredClone(trackerState),
    floatingLinks: [],
    reroutes: [],
    groups: [],
    config: {},
    subgraphs: [],
    extra: { ds: { scale: 1.4, offset: [12, -8] }, comfyui_mcp: { workflow_uuid: "drifted-tag" } },
  };
  const activeWorkflow = wf({ changeTracker: { activeState: trackerState } });
  assert.equal(
    graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(liveState), activeWorkflow }),
    false,
  );
});

test("#560: the panel identity tag inside extra is NOT workflow content — tag drift alone is no shape mismatch", () => {
  // The guard's rebind heal re-stamps the root with the active identity; if the
  // tag participated in the shape comparison, a tracker capture holding the
  // PRIOR tag would instantly re-throw after the heal, so a clean tab could
  // never heal. Tag conflicts are owned by the UUID predicates, not by shape.
  const trackerState = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: [20] }],
    links: [],
    extra: { comfyui_mcp: { workflow_uuid: "workflow-old" } },
  };
  const liveState = {
    ...structuredClone(trackerState),
    extra: { comfyui_mcp: { workflow_uuid: "workflow-new" } },
  };
  const activeWorkflow = wf({ changeTracker: { activeState: trackerState } });
  assert.equal(
    graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(liveState), activeWorkflow }),
    false,
    "tag drift is judged by the UUID branch with claim/heal semantics, not by content shape",
  );
});

test("#560: graphRootMatchesState proves a faithful repaint despite serializer dialect — the recovery that failed", () => {
  // panel_open_workflow's repaint proof: the just-loaded root serializes with
  // present-but-empty surfaces and a viewport, while the loaded state (a
  // ChangeTracker clone) omits them. That asymmetry false-failed the proof and
  // left a drifted binding with no recovery short of a panel reload.
  const repaintState = {
    nodes: [
      { id: 1, type: "CheckpointLoader", widgets_values: ["model.safetensors"] },
      { id: 2, type: "KSampler", widgets_values: [20] },
    ],
    links: [[1, 1, 0, 2, 0, "MODEL"]],
    extra: { comfyui_mcp: { workflow_uuid: "workflow-A", workflow_path: "workflows/a.json" } },
  };
  const liveAfterRepaint = {
    ...structuredClone(repaintState),
    floatingLinks: [],
    reroutes: [],
    groups: [],
    config: {},
    extra: {
      ds: { scale: 0.9, offset: [1, 2] },
      comfyui_mcp: { workflow_uuid: "workflow-A", workflow_path: "workflows/a.json" },
    },
  };
  assert.equal(
    graphRootMatchesState({ rootGraph: serializedRoot(liveAfterRepaint), state: repaintState }),
    true,
    "the proven repaint is accepted even when serialize() re-emits omitted surfaces as empty",
  );
  assert.equal(
    graphRootMatchesState({
      rootGraph: serializedRoot({ ...structuredClone(repaintState), reroutes: [{ id: "reroute-a", pos: [1, 2] }] }),
      state: repaintState,
    }),
    false,
    "content strictness is unchanged: a genuinely different canvas still fails the proof",
  );
});

test("#565: a NEW blank workflow after a tagged workflow heals the stale root tag instead of throwing", () => {
  // ComfyUI reuses app.graph across tabs and its clear/configure does not
  // reset graph.extra: a brand-new blank tab inherits the PREVIOUS workflow's
  // root tag while minting its own identity. Both sides are PROVEN empty — a
  // clean, well-formed zero-node active state and a serializable root whose
  // every non-identity surface is empty — so no foreign content can be
  // confused and the guard re-stamps instead of hard-blocking.
  for (const foreignClaim of ["identity", "none"]) {
    const h = buildDirtyStaleRouteHarness({
      rootUuid: "workflow-prev",
      foreignClaim, // previous tab still OPEN and claiming the tag / nobody claims it
      activeNodeCount: 0,
      rootNodeCount: 0,
      activeModified: false,
      rootSerializer: () => ({
        nodes: [],
        links: [],
        groups: [],
        config: {},
        extra: { ds: { scale: 1 }, comfyui_mcp: { workflow_uuid: "workflow-prev" } },
      }),
    });
    assert.doesNotThrow(
      () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
      `blank active tab + provably empty tagged root (${foreignClaim}) must not be rejected`,
    );
    assert.equal(
      h.rootB.extra.comfyui_mcp.workflow_uuid,
      h.stableUuid(h.workflowA),
      "the stale tag is re-stamped with the ACTIVE blank workflow's identity",
    );
  }
});

test("#565 gate: counters/version metadata on a blank canvas does not defeat the proven-empty heal", () => {
  // LiteGraph rebuilds can leave format metadata (ids/counters/version) on an
  // otherwise content-free canvas. That metadata is not workflow content, so
  // the relaxation still fires — real surface CONTENT (next tests) is what
  // keeps the guard strict.
  const h = buildDirtyStaleRouteHarness({
    rootUuid: "workflow-prev",
    foreignClaim: "none",
    activeNodeCount: 0,
    rootNodeCount: 0,
    activeModified: false,
    activeTracker: { activeState: { nodes: [], version: 0.4, last_node_id: 7, last_link_id: 3 } },
    rootSerializer: () => ({
      id: "graph-uuid",
      revision: 12,
      version: 0.4,
      last_node_id: 7,
      last_link_id: 3,
      nodes: [],
      links: [],
      extra: { ds: { scale: 1 }, comfyui_mcp: { workflow_uuid: "workflow-prev" }, linkExtensions: [] },
    }),
  });
  assert.doesNotThrow(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    "format metadata must not be mistaken for canvas content",
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, h.stableUuid(h.workflowA));
});

test("#565 gate: malformed or absent tracker state does NOT prove the active workflow empty — the relaxation fails closed", () => {
  // activeWorkflowNodeCount() deliberately returns 0 for absent/malformed
  // state — that is NOT proof of an empty workflow. Without an explicit clean,
  // well-formed zero-node active state there is no relaxation: the tag
  // conflict fails closed and the root is never re-stamped.
  for (const activeTracker of [
    null, // tracker entirely unreadable
    {}, // no readable states
    { activeState: { nodes: "bad" } }, // malformed nodes
    { activeState: {} }, // state without a nodes array
    { initialState: state(0) }, // load baseline only — NOT a current-state proof
  ]) {
    const h = buildDirtyStaleRouteHarness({
      rootUuid: "workflow-prev",
      foreignClaim: "none",
      activeNodeCount: 0,
      rootNodeCount: 0,
      activeModified: false,
      activeTracker,
      rootSerializer: () => ({ nodes: [], extra: { comfyui_mcp: { workflow_uuid: "workflow-prev" } } }),
    });
    assert.throws(
      () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
      /\[root-workflow-uuid-mismatch\]/,
      `absent/malformed current state must fail closed: ${JSON.stringify(activeTracker)}`,
    );
    assert.equal(
      h.rootB.extra.comfyui_mcp.workflow_uuid,
      "workflow-prev",
      "no re-stamp without a proven-empty active workflow",
    );
  }
});

test("#565 gate: a DIRTY zero-node workflow is not proven empty — a lagging tracker is not evidence", () => {
  // #545: a dirty workflow's ChangeTracker state can lag the user's real
  // canvas, so a dirty tab can never prove its canvas is content-free.
  const h = buildDirtyStaleRouteHarness({
    rootUuid: "workflow-prev",
    foreignClaim: "none",
    activeNodeCount: 0,
    rootNodeCount: 0,
    activeModified: true,
    rootSerializer: () => ({ nodes: [], extra: { comfyui_mcp: { workflow_uuid: "workflow-prev" } } }),
  });
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    /\[root-workflow-uuid-mismatch\]/,
    "a dirty tab's zero-node tracker read is not an empty-canvas proof",
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, "workflow-prev", "no re-stamp for a dirty tab");
});

test("#565 gate: an UNSERIALIZABLE empty root is not proven empty — node-level evidence only fails closed", () => {
  // A bare empty `_nodes` array says nothing about non-node surfaces. Without
  // serialize() there is no proof the root holds no subgraphs/groups/links,
  // so the relaxation must not fire (the pre-gate harness root had exactly
  // this shape and the guard re-stamped it).
  const h = buildDirtyStaleRouteHarness({
    rootUuid: "workflow-prev",
    foreignClaim: "none",
    activeNodeCount: 0,
    rootNodeCount: 0,
    activeModified: false,
  });
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    /\[root-workflow-uuid-mismatch\]/,
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, "workflow-prev", "no re-stamp without full-surface proof");
});

test("#565 gate: zero nodes with NON-EMPTY surfaces is content — the shape check stays strict", () => {
  // Removing the blanket zero-node skip: a state with zero nodes but real
  // surface content (subgraphs, groups, reroutes, links) versus an empty
  // canvas is a genuine desync and must still mismatch — in BOTH directions.
  const contentByField = {
    subgraphs: [{ id: "subgraph-a", nodes: [{ id: 9, type: "SaveImage" }] }],
    groups: [{ id: 1, title: "kept-group" }],
    reroutes: [{ id: "reroute-a", pos: [30, 40] }],
    floatingLinks: [{ id: "floating-a", pos: [10, 20] }],
    links: [[1, 1, 0, 2, 0, "MODEL"]],
  };
  for (const [field, content] of Object.entries(contentByField)) {
    const activeWorkflow = wf({ changeTracker: { activeState: { nodes: [], [field]: content } } });
    assert.equal(
      graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot({ nodes: [] }), activeWorkflow }),
      true,
      `${field}: workflow content missing from the live canvas is a desync even at zero nodes`,
    );
    const reverseWorkflow = wf({ changeTracker: { activeState: { nodes: [] } } });
    assert.equal(
      graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot({ nodes: [], [field]: content }), activeWorkflow: reverseWorkflow }),
      true,
      `${field}: foreign content on the live canvas is a mismatch even at zero nodes`,
    );
  }
});

test("#565 gate: a zero-node root bearing foreign surface content is never re-stamped through the relaxation", () => {
  const h = buildDirtyStaleRouteHarness({
    rootUuid: "workflow-prev",
    foreignClaim: "none",
    activeNodeCount: 0,
    rootNodeCount: 0,
    activeModified: false,
    rootSerializer: () => ({
      nodes: [],
      subgraphs: [{ id: "subgraph-a", nodes: [{ id: 9, type: "SaveImage" }] }],
      extra: { comfyui_mcp: { workflow_uuid: "workflow-prev" } },
    }),
  });
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    /\[root-workflow-uuid-mismatch\]/,
    "a content-bearing root must stay strict even at zero nodes",
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, "workflow-prev", "foreign content is never re-stamped");
});

test("#565 gate: a zero-node active STATE bearing surface content does not relax the guard", () => {
  const h = buildDirtyStaleRouteHarness({
    rootUuid: "workflow-prev",
    foreignClaim: "none",
    activeNodeCount: 0,
    rootNodeCount: 0,
    activeModified: false,
    activeTracker: { activeState: { nodes: [], groups: [{ id: 1, title: "kept-group" }] } },
    rootSerializer: () => ({ nodes: [], extra: { comfyui_mcp: { workflow_uuid: "workflow-prev" } } }),
  });
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    /\[root-workflow-uuid-mismatch\]/,
    "surface content in the active state defeats the empty-canvas relaxation",
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, "workflow-prev", "no re-stamp when the workflow still holds content");
});

test("#565 boundary: the both-empty heal never fires while content exists on EITHER side", () => {
  // #389 preserved: an EMPTY root against a workflow that reports nodes still
  // fails closed — the tag conflict is real and the tag is not rewritten.
  const readDesync = buildDirtyStaleRouteHarness({
    rootUuid: "workflow-prev",
    foreignClaim: "identity",
    activeNodeCount: 5,
    rootNodeCount: 0,
    activeModified: false,
  });
  assert.throws(
    () => readDesync.assertBound(readDesync.rootB, readDesync.rootB, { includeBaselineReadGuard: true }),
    /\[root-workflow-uuid-mismatch\]/,
    "empty root + populated workflow still fails closed",
  );
  assert.equal(readDesync.rootB.extra.comfyui_mcp.workflow_uuid, "workflow-prev", "no re-stamp on a real conflict");

  // #349 preserved: a FOREIGN NONEMPTY canvas is never re-stamped for a blank
  // active tab — the wrong-canvas fence protects content exactly as before.
  const foreignContent = buildDirtyStaleRouteHarness({
    rootUuid: "workflow-B",
    foreignClaim: "identity",
    activeNodeCount: 0,
    rootNodeCount: 30,
    activeModified: false,
  });
  assert.throws(
    () => foreignContent.assertBound(foreignContent.rootB, foreignContent.rootB, { includeBaselineReadGuard: true }),
    /\[root-workflow-uuid-mismatch\]/,
    "a foreign canvas with content keeps the #349 fence",
  );
  assert.equal(foreignContent.rootB.extra.comfyui_mcp.workflow_uuid, "workflow-B", "foreign content is never re-stamped");
});

test("#560: after reconnect + multi-tab switch the drifted-tag canvas fails closed with a reason code, and the proven re-stamp restores agreement", () => {
  // panel_list_workflows reports X active (and active_confirmed — a reconnect
  // -epoch concept independent of this guard) while the root tag drifted to an
  // unclaimed pre-reconnect identity. The canvas CONTENT is X's own graph, so
  // the shape branch stays silent; the UUID branch fails closed (the drift is
  // unprovable inline) and now NAMES the firing predicate. The sanctioned
  // recovery — panel_open_workflow's proven repaint re-stamp, modeled here —
  // then restores active/binding agreement.
  const h = buildDirtyStaleRouteHarness({
    rootUuid: "workflow-old",
    foreignClaim: "none", // the tag's owner record is a dead predecessor — nobody live claims it
    activeNodeCount: 11,
    rootNodeCount: 11,
    activeModified: false,
  });
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    /\[root-workflow-uuid-mismatch\]/,
    "an unprovable drift still fails closed — and is now diagnosable",
  );
  assert.equal(h.rootB.extra.comfyui_mcp.workflow_uuid, "workflow-old", "a failed-closed root is never rewritten");
  h.rootB.extra.comfyui_mcp.workflow_uuid = h.stableUuid(h.workflowA); // the proven repaint re-stamp
  assert.doesNotThrow(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    "after the proven re-stamp the legitimately-active workflow reads normally",
  );
});

test("#565: the guard names the root-shape-mismatch predicate when a genuinely different canvas is mounted", () => {
  const h = buildDirtyStaleRouteHarness({
    rootUuid: null,
    foreignClaim: "none",
    activeNodeCount: 27,
    rootNodeCount: 30,
    activeModified: false,
  });
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    /\[root-shape-mismatch\]/,
  );
});

test("#389: the guard names the root-node-count-desync predicate when the canvas reads empty against a populated workflow", () => {
  const h = buildDirtyStaleRouteHarness({
    rootUuid: null,
    foreignClaim: "none",
    rootNodeCount: 0,
    activeModified: false,
    activeTracker: { activeState: { nodes: "bad" }, initialState: state(5) },
  });
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    /\[root-node-count-desync\]/,
    "the #389 baseline read guard still fires, and now says so",
  );
});

// ── #560 (2nd reopen): the FALSE-EMPTY authoritative read ────────────────────
// After a reconnect + tab switch (or a failed workflow_open repaint), the
// shared app.graph object is observed MID-POPULATION: _nodes empty, no root
// tag, and the tracker unreadable/not yet settled. Every legacy predicate is
// inconclusive there (desync needs a POSITIVE tracker count; the shape guard
// skips both-empty; the UUID guards skip a missing tag), so graph_outline
// returned node_count 0 as authoritative for a canvas known to hold 10 nodes
// — and the agent built ~70 nodes on the false reading (#349-class). An empty
// ROOT read must distinguish PROVEN-empty from not-yet-populated.

test("#560 r2 graphEmptyBindingUnproven: truth table — inconclusive only when empty + unproven + unbound", () => {
  const bareRoot = { _nodes: [] };
  const taggedRoot = { _nodes: [], extra: { comfyui_mcp: { workflow_uuid: "uuid-A" } } };
  const noTracker = { isModified: false };
  const malformedTracker = { isModified: false, changeTracker: { activeState: "garbage" } };
  const dirtyTracker = { isModified: true, changeTracker: { activeState: { nodes: [{ id: 1 }] } } };
  const provenEmpty = {
    isModified: false,
    changeTracker: { activeState: { nodes: [], links: [], groups: [], config: {} } },
  };
  // The mid-load / failed-repaint / post-reconnect window: INCONCLUSIVE.
  assert.equal(
    graphEmptyBindingUnproven({ graph: bareRoot, rootGraph: bareRoot, activeWorkflow: noTracker, activeWorkflowUuid: "uuid-A" }),
    true,
    "tracker entirely absent — an empty read cannot be authoritative",
  );
  assert.equal(
    graphEmptyBindingUnproven({ graph: bareRoot, rootGraph: bareRoot, activeWorkflow: malformedTracker, activeWorkflowUuid: "uuid-A" }),
    true,
    "malformed tracker state — same blind window",
  );
  assert.equal(
    graphEmptyBindingUnproven({ graph: bareRoot, rootGraph: bareRoot, activeWorkflow: dirtyTracker, activeWorkflowUuid: "uuid-A" }),
    true,
    "a dirty tracker cannot prove emptiness (#545 lag) and the root is unbound",
  );
  // PROVEN genuinely empty: node_count 0 is the TRUTH.
  assert.equal(
    graphEmptyBindingUnproven({ graph: bareRoot, rootGraph: bareRoot, activeWorkflow: provenEmpty, activeWorkflowUuid: "uuid-A" }),
    false,
    "clean + well-formed all-empty state ⇒ a truthful empty read",
  );
  // POSITIVELY bound (root tag matches the active identity): the known #545
  // availability case — a manual/agent clear on a bound canvas, tracker lagging.
  assert.equal(
    graphEmptyBindingUnproven({ graph: taggedRoot, rootGraph: taggedRoot, activeWorkflow: dirtyTracker, activeWorkflowUuid: "uuid-A" }),
    false,
    "a positively-bound canvas stays availability-oriented",
  );
  // Populated root: self-evidently bound; other guards own it.
  const populated = { _nodes: [{ id: 1 }] };
  assert.equal(
    graphEmptyBindingUnproven({ graph: populated, rootGraph: populated, activeWorkflow: noTracker, activeWorkflowUuid: "uuid-A" }),
    false,
    "a populated canvas can never false-read empty",
  );
  // Subgraph scope: a descended empty subgraph is legitimate scope content.
  assert.equal(
    graphEmptyBindingUnproven({ graph: { _nodes: [] }, rootGraph: bareRoot, activeWorkflow: noTracker, activeWorkflowUuid: "uuid-A" }),
    false,
    "descended subgraph scope is exempt (mirrors the baseline desync guard)",
  );
  // No workflow service at all: the legacy availability path — this frontend
  // never had binding fences, so an empty canvas keeps reading as empty.
  assert.equal(
    graphEmptyBindingUnproven({ graph: bareRoot, rootGraph: bareRoot, activeWorkflow: null, activeWorkflowUuid: null }),
    false,
    "no workflow service ⇒ legacy behavior preserved",
  );
  // An UNREADABLE root (no _nodes array) stays with the legacy predicates.
  assert.equal(
    graphEmptyBindingUnproven({ graph: {}, rootGraph: {}, activeWorkflow: noTracker, activeWorkflowUuid: "uuid-A" }),
    false,
    "an unobservable root is not this predicate's case",
  );
});

test("#560 r2: the read guard throws [empty-binding-unproven] for the mid-population window — never a false-empty read", () => {
  for (const [label, activeTracker] of [
    ["tracker absent", null],
    ["tracker malformed", { activeState: "garbage" }],
  ]) {
    const h = buildDirtyStaleRouteHarness({
      rootUuid: null, // no binding tag: the shared root mid-population / failed repaint
      foreignClaim: "none",
      activeNodeCount: 10, // (unused — the injected tracker below replaces the default)
      rootNodeCount: 0,
      activeModified: false,
      activeTracker,
    });
    assert.throws(
      () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
      (err) => {
        assert.match(err.message, /\[empty-binding-unproven\]/);
        assert.match(err.message, /FALSE-EMPTY/i);
        assert.match(err.message, /Retry in a moment/i);
        assert.doesNotMatch(err.message, /out of sync/, "this is inconclusive, not a wrong-canvas verdict");
        return true;
      },
      `${label}: the empty root is inconclusive, never authoritative-empty`,
    );
  }
});

test("#560 r2: a populated tracker verdict still wins over the empty-binding check (desync ordering)", () => {
  // The tracker positively reports 10 nodes against an empty root: the #389
  // desync is the louder, more specific error and must keep firing FIRST
  // (malformed activeState so the shape guard stays inconclusive, exactly the
  // existing #389 naming test's shape).
  const h = buildDirtyStaleRouteHarness({
    rootUuid: null,
    foreignClaim: "none",
    rootNodeCount: 0,
    activeModified: false,
    activeTracker: { activeState: { nodes: "bad" }, initialState: state(10) },
  });
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    /\[root-node-count-desync\]/,
  );
});

test("#560 r2: a PROVEN-empty canvas still reads truthfully (no false refusal) — and a bound empty canvas stays editable", () => {
  const h = buildDirtyStaleRouteHarness({
    rootUuid: null,
    foreignClaim: "none",
    rootNodeCount: 0,
    activeModified: false,
    activeTracker: { activeState: { nodes: [], links: [], groups: [], config: {} } },
    rootSerializer: () => ({ nodes: [], links: [], groups: [], config: {} }),
  });
  assert.doesNotThrow(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: true }),
    "clean tracker + well-formed all-empty state ⇒ the empty read is authoritative",
  );
  // The #545 availability case: the root is positively bound to the active
  // identity (tag match), so even a dirty, lagging tracker keeps the cleared
  // canvas readable/editable — only UNBOUND emptiness is inconclusive.
  const bound = buildDirtyStaleRouteHarness({
    rootUuid: "workflow-A-1", // the harness resolver's first deterministic mint
    foreignClaim: "none",
    rootNodeCount: 0,
    activeModified: true, // dirty tracker — cannot prove, but the binding is positive
  });
  assert.doesNotThrow(
    () => bound.assertBound(bound.rootB, bound.rootB, { includeBaselineReadGuard: true }),
    "positively-bound empty canvas: reads stay availability-oriented (#545)",
  );
  assert.doesNotThrow(
    () => bound.assertBound(bound.rootB, bound.rootB, { includeBaselineReadGuard: false, requireDirtyMutationBinding: true }),
    "…and mutations too (the agent's clear-and-rebuild flow)",
  );
});

test("#560 r2: mutations are fenced against the false-empty window exactly like reads", () => {
  const h = buildDirtyStaleRouteHarness({
    rootUuid: null,
    foreignClaim: "none",
    rootNodeCount: 0,
    activeModified: false,
    activeTracker: null,
  });
  assert.throws(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false, requireDirtyMutationBinding: true }),
    /\[empty-binding-unproven\]/,
    "graph_add_node on a mid-population canvas is refused, not applied to a false-empty graph",
  );
});

// #606 — the refusal text must name the firing predicate honestly: a 0-node
// expectation phrased as "the workflow reports 0 node(s), but the canvas is bound to
// a different graph" reads as nonsense on a genuinely-empty tab, and the remedy must
// name the reload as the certain fallback rather than sending the agent to
// panel_open_workflow with no hint about which recovery actually works.
test("#606 refusal message: uuid-mismatch names the identity tag, not a 0-node different-graph claim", () => {
  const msg = graphBindingRefusalMessage({ reason: "root-workflow-uuid-mismatch", expected: 0 });
  assert.match(msg, /^\[root-workflow-uuid-mismatch\]/);
  assert.match(msg, /identity tag/);
  assert.ok(!msg.includes("reports 0 node(s)"), "no nonsense 0-node clause");
  assert.match(msg, /NOT applied/);
  assert.match(msg, /panel_open_workflow/);
  assert.match(msg, /panel_reload/);
  // …and it states the OBSERVATION, not a cause nobody watched happen. The
  // predicate saw two tags disagree; "a load, tab switch, or reconnect left a
  // stale tag behind" was one guess presented as the finding — the same defect
  // the shape branch's wrong-canvas sentence had (codex gate, r2 P2).
  assert.match(msg, /observed is the disagreement itself, not what produced it/);
  assert.doesNotMatch(
    msg,
    /reconnect left a stale tag behind, so/,
    "the usual explanation may be offered as one — never asserted as what happened",
  );
});

test("#606 refusal message: a 0-expected shape mismatch drops the node-count clause", () => {
  const msg = graphBindingRefusalMessage({ reason: "root-shape-mismatch", expected: 0 });
  assert.match(msg, /^\[root-shape-mismatch\]/);
  assert.ok(!msg.includes("reports 0 node(s)"));
  assert.match(msg, /NOT applied/);
});

test("#606 refusal message: a positive-count desync keeps the count", () => {
  const msg = graphBindingRefusalMessage({ reason: "root-node-count-desync", expected: 164 });
  assert.match(msg, /^\[root-node-count-desync\]/);
  assert.match(msg, /reports 164 node\(s\)/);
  assert.match(msg, /NOT applied/);
});

test("#606 refusal message: dirty-mutation-binding-unproven names the unproven binding", () => {
  // Message wording is #624's (#601): names the unstamped-canvas cause and the
  // reload/re-open remedy; this locks that the #606 reason tag and NOT-applied
  // claims survived the integration.
  const msg = graphBindingRefusalMessage({ reason: "dirty-mutation-binding-unproven", expected: 0 });
  assert.match(msg, /^\[dirty-mutation-binding-unproven\]/);
  assert.match(msg, /NOT applied/);
  assert.match(msg, /identity stamp/);
  assert.match(msg, /panel_open_workflow/);
});

test("#606 refusal message: empty-binding-unproven keeps its false-empty warning", () => {
  const msg = graphBindingRefusalMessage({ reason: "empty-binding-unproven", expected: 0 });
  assert.match(msg, /^\[empty-binding-unproven\]/);
  assert.match(msg, /FALSE-EMPTY/);
  assert.match(msg, /NOT applied/);
});

// ---------------------------------------------------------------------------
// #618 — the MID-POPULATION fence. After a ComfyUI reconnect the frontend
// restores the active tab's graph incrementally; for a window the live root
// observably reads FEWER nodes than the active workflow's own current state
// (the restore source). On a DIRTY tab every pre-existing predicate was blind
// to that signature (shape guard inconclusive while dirty, #545; baseline
// desync guard gated on a clean tracker; empty-read guard needs ZERO nodes),
// so an 8-of-31 restoring canvas was served as an authoritative outline and
// the agent duplicated nodes it could not see. The fence closes that window —
// and ONLY that window: outside it the #545 dirty-tab availability stands.
// ---------------------------------------------------------------------------

// A workflow whose CURRENT serialized state reports `n` nodes (the restore
// source). `withState:false` models an absent/unreadable tracker — no evidence.
const midPopWorkflow = (n, { modified = true, withState = true } = {}) => ({
  isModified: modified,
  ...(withState ? { changeTracker: { activeState: state(n) } } : {}),
});
const midPopRoot = (n, extra) => ({
  _nodes: state(n).nodes,
  ...(extra ? { extra } : {}),
});

test("#618: dirty tab in the reconnect window — a live root BEHIND the workflow's own state refuses as root-mid-population", () => {
  const verdict = resolveGraphBindingVerdict({
    graph: midPopRoot(8),
    rootGraph: midPopRoot(8),
    activeWorkflow: midPopWorkflow(31),
    liveNodeCount: 8,
    postReconnectWindow: true,
  });
  assert.equal(verdict?.reason, "root-mid-population");
  // Assert the EVIDENCE, not just the state: the verdict quotes the current-state
  // count (31), never a load baseline, and the observed live count (8).
  assert.equal(verdict?.expected, 31);
  assert.equal(verdict?.live, 8);
});

test("#618: the SAME evidence outside the reconnect window stays available (the #545 dirty-tab relaxation is untouched)", () => {
  const verdict = resolveGraphBindingVerdict({
    graph: midPopRoot(8),
    rootGraph: midPopRoot(8),
    activeWorkflow: midPopWorkflow(31),
    liveNodeCount: 8,
    postReconnectWindow: false,
  });
  assert.equal(verdict, null, "a dirty tab's live-behind-tracker read is legitimate manual-edit lag outside the window");
});

test("#618: clean tab in the window — the count-short canvas reads as mid-population, not the heavier wrong-canvas verdict", () => {
  const verdict = resolveGraphBindingVerdict({
    graph: midPopRoot(8),
    rootGraph: midPopRoot(8),
    activeWorkflow: midPopWorkflow(31, { modified: false }),
    liveNodeCount: 8,
    postReconnectWindow: true,
  });
  assert.equal(verdict?.reason, "root-mid-population");
  // Outside the window the same clean-tab evidence keeps its pre-#618 verdict.
  const settled = resolveGraphBindingVerdict({
    graph: midPopRoot(8),
    rootGraph: midPopRoot(8),
    activeWorkflow: midPopWorkflow(31, { modified: false }),
    liveNodeCount: 8,
    postReconnectWindow: false,
  });
  assert.equal(settled?.reason, "root-shape-mismatch");
});

test("#618: a descended SUBGRAPH is exempt — an entered subgraph legitimately reads smaller than the root state", () => {
  const verdict = resolveGraphBindingVerdict({
    graph: { _nodes: state(4).nodes },
    rootGraph: midPopRoot(8),
    activeWorkflow: midPopWorkflow(31),
    liveNodeCount: 4,
    inSubgraph: true,
    postReconnectWindow: true,
  });
  assert.equal(verdict, null);
});

test("#618: no current-state evidence fails OPEN — an absent/malformed tracker read proves nothing", () => {
  for (const wf of [midPopWorkflow(31, { withState: false }), null, undefined]) {
    const verdict = resolveGraphBindingVerdict({
      graph: midPopRoot(8),
      rootGraph: midPopRoot(8),
      activeWorkflow: wf,
      liveNodeCount: 8,
      postReconnectWindow: true,
    });
    assert.equal(verdict, null, "unreadable current state must never manufacture a mid-population verdict");
  }
});

test("#618: equal or AHEAD live counts do not fire — only a canvas BEHIND the workflow's own state is mid-restore evidence", () => {
  for (const live of [31, 40]) {
    const verdict = resolveGraphBindingVerdict({
      graph: midPopRoot(live),
      rootGraph: midPopRoot(live),
      activeWorkflow: midPopWorkflow(31),
      liveNodeCount: live,
      postReconnectWindow: true,
    });
    assert.equal(verdict, null, `live=${live} against a 31-node state is not mid-population evidence`);
  }
});

test("#618: a current state of ZERO nodes does not fire — an empty restore target is the empty-read guards' case, not this one's", () => {
  const verdict = resolveGraphBindingVerdict({
    graph: midPopRoot(0),
    rootGraph: midPopRoot(0),
    activeWorkflow: midPopWorkflow(0),
    liveNodeCount: 0,
    postReconnectWindow: true,
  });
  assert.equal(verdict, null);
});

test("#618: reads keep their LOWER bar at dispatch — the fence re-asserts in the read executor, like the baseline desync guard", () => {
  const verdict = resolveGraphBindingVerdict({
    graph: midPopRoot(8),
    rootGraph: midPopRoot(8),
    activeWorkflow: midPopWorkflow(31),
    liveNodeCount: 8,
    postReconnectWindow: true,
    ...graphCommandBindingBar("graph_outline"),
  });
  assert.equal(verdict, null, "dispatch does not refuse reads early; the executor's full bar is where the fence lives");
});

test("#618: MUTATIONS are fenced in the window too — a proven-bound dirty root still refuses while the canvas is mid-restore", () => {
  const uuid = "wf-uuid-A";
  const verdict = resolveGraphBindingVerdict({
    graph: midPopRoot(8),
    rootGraph: midPopRoot(8, { comfyui_mcp: { workflow_uuid: uuid } }),
    activeWorkflow: midPopWorkflow(31),
    activeWorkflowUuid: uuid,
    liveNodeCount: 8,
    postReconnectWindow: true,
    ...graphCommandBindingBar("graph_remove_node"),
  });
  assert.equal(verdict?.reason, "root-mid-population");
});

test("#618: a positive UUID conflict outranks the mid-population verdict — identity evidence stays first", () => {
  const verdict = resolveGraphBindingVerdict({
    graph: midPopRoot(8),
    rootGraph: midPopRoot(8, { comfyui_mcp: { workflow_uuid: "foreign-tab-B" } }),
    activeWorkflow: midPopWorkflow(31),
    activeWorkflowUuid: "wf-uuid-A",
    liveNodeCount: 8,
    // rootUuidMismatch is computed by the caller (the monolith fence) from the
    // tag/identity conflict above; passed in here exactly as it would be live.
    rootUuidMismatch: true,
    postReconnectWindow: true,
    ...MUTATION_BINDING_BAR,
  });
  assert.equal(verdict?.reason, "root-workflow-uuid-mismatch");
});

test("#618: the refusal message discloses the uncertainty and names a remedy that works from where the caller is", () => {
  const message = graphBindingRefusalMessage({
    reason: "root-mid-population",
    expected: 31,
    live: 8,
  });
  assert.match(message, /\[root-mid-population\]/);
  assert.match(message, /shows 8 node\(s\)/, "the live count is quoted");
  assert.match(message, /reports 31/, "the workflow's own count is quoted");
  assert.match(message, /NOT applied/, "the refusal never reads as a partial success");
  assert.match(message, /Retry in a moment/, "the cheap remedy comes first");
  assert.match(message, /panel_open_workflow/, "the persistent-case remedy is actionable from here");
  assert.doesNotMatch(message, /did NOT land|not installed/, "no stale-install blame leaks into a binding verdict");
});

test("#618: the monolith's fence feeds the verdict the live reconnect window (extracted source, window ON and OFF)", () => {
  const inWindow = buildDirtyStaleRouteHarness({
    rootUuid: null,
    foreignClaim: "none",
    activeNodeCount: 31,
    rootNodeCount: 8,
    postReconnectWindow: true,
  });
  assert.throws(
    () => inWindow.assertBound(inWindow.rootB, inWindow.rootB),
    /\[root-mid-population\]/,
    "the real assertGraphBoundToActiveWorkflow refuses the 8-of-31 restoring canvas inside the window",
  );
  const settled = buildDirtyStaleRouteHarness({
    rootUuid: null,
    foreignClaim: "none",
    activeNodeCount: 31,
    rootNodeCount: 8,
  });
  assert.doesNotThrow(
    () => settled.assertBound(settled.rootB, settled.rootB),
    "the same canvas stays available once the window has closed",
  );
});

test("#618: the panel source wires the window from the #433 epoch/monotonic machinery, not a wall-clock guess", () => {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const helper = panelFunctionSource(src, "postReconnectSettleWindow", "assertGraphBoundToActiveWorkflow");
  assert.match(helper, /activeWorkflowPossiblyStale\(\{/, "the window decision is the shared #433 predicate");
  assert.match(helper, /reconnectEpoch: backendReconnectEpoch/);
  assert.match(helper, /resyncEpoch: activeWorkflowResyncEpoch/);
  assert.match(helper, /reconnectedAt: backendReconnectedAt/);
  assert.match(helper, /now: monotonicNow\(\)/, "the window reads a monotonic clock");
  const fence = panelFunctionSource(src, "assertGraphBoundToActiveWorkflow", "getPiniaStore");
  assert.match(
    fence,
    /postReconnectWindow: postReconnectSettleWindow\(\)/,
    "the binding verdict receives the live window on every fenced command",
  );
});

test("#618: graphRootMidPopulation unit edges — NaN/negative live counts and subgraph scope never fire", () => {
  const wf = midPopWorkflow(31);
  assert.equal(graphRootMidPopulation({ liveNodeCount: NaN, activeWorkflow: wf, postReconnectWindow: true }), false);
  assert.equal(graphRootMidPopulation({ liveNodeCount: -1, activeWorkflow: wf, postReconnectWindow: true }), false);
  assert.equal(graphRootMidPopulation({ liveNodeCount: 8, activeWorkflow: wf, inSubgraph: true, postReconnectWindow: true }), false);
  assert.equal(graphRootMidPopulation({ liveNodeCount: 8, activeWorkflow: wf }), false, "window defaults closed");
});

test("#618: activeWorkflowCurrentNodeCount reads ONLY the current state — the load baseline is not mid-population evidence", () => {
  // initialState says 31 (the load baseline) but the current state has legitimately
  // shrunk to 8: the baseline must NOT accuse the canvas.
  const wf = {
    changeTracker: { activeState: state(8), initialState: state(31) },
  };
  assert.equal(activeWorkflowCurrentNodeCount(wf), 8);
  assert.equal(
    graphRootMidPopulation({ liveNodeCount: 8, activeWorkflow: wf, postReconnectWindow: true }),
    false,
    "a canvas matching the CURRENT state is not mid-population, whatever the baseline held",
  );
  assert.equal(activeWorkflowCurrentNodeCount({}), null, "no current state → no evidence");
});
