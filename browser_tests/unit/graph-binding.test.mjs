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
  graphReadDesynced,
  graphRootMismatchesActiveWorkflow,
  graphRootWorkflowUuidMismatches,
  graphRootWorkflowUuidMatches,
  graphRootMatchesState,
  graphCommandMayMutateWorkflow,
  graphReadBindingChanged,
  resolveGraphRootUuidRebind,
} from "../../web/js/lib/graph-binding.js";
import {
  isNewWorkflowLoad,
  rawWorkflowObject,
  sameWorkflowObject,
  shouldForkEmbeddedUuidForLiveOwner,
  shouldForkEmbeddedWorkflowUuid,
  shouldForkInPlaceReload,
  workflowAliasForPath,
} from "../../web/js/lib/workflow-chat-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

function panelFunctionSource(src, name, nextName) {
  const start = src.indexOf(`function ${name}(`);
  const end = src.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `could not locate ${name} in panel source`);
  assert.notEqual(end, -1, `could not locate ${nextName} after ${name}`);
  return src.slice(start, end);
}

// Vue-faithful reactive proxy: real Vue proxies expose the raw target as
// __v_raw. A purely transparent Proxy has no raw back-pointer, so an
// inspection-based identity check could never match it to a carrier-less object
// — that combination is a test artifact, not a Vue behavior (r3).
const vueProxyOf = (raw) => new Proxy(raw, { get: (t, k) => (k === "__v_raw" ? t : t[k]) });

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
//   "none"                  — NO live open tab claims the tag (a closed/replaced
//                             tab's leftover): genuine stale bookkeeping — the
//                             guard rebinds.
// foreignTab overrides the B object (e.g. a creation-lifecycle product), and
// registeredOwners/objectUuids override the identity stores the harness wires in.
function buildDirtyStaleRouteHarness({
  rootUuid = "workflow-B",
  foreignClaim = "identity",
  foreignTab = null,
  registeredOwners = null,
  objectUuids: objectUuidsOpt = null,
} = {}) {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const stableSource = panelFunctionSource(src, "workflowStableUuid", "workflowStorageKey");
  const fenceSource = panelFunctionSource(src, "assertGraphBoundToActiveWorkflow", "getPiniaStore");
  const ownsTagSource = panelFunctionSource(src, "workflowOwnsRootUuidTag", "assertGraphBoundToActiveWorkflow");
  const overlap = foreignClaim === "same-path-overlap";
  const workflowA = overlap
    ? { isPersisted: true, path: "workflows/a.json", isModified: true, changeTracker: { activeState: state(27) } }
    : { isPersisted: false, isModified: true, changeTracker: { activeState: state(27) } };
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
                ...state(30),
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
    _nodes: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, type: "KSampler" })),
    ...(rootUuid ? { extra: { comfyui_mcp: { workflow_uuid: rootUuid } } } : {}),
  };
  const openWorkflows =
    foreignClaim === "none"
      ? [workflowA]
      : foreignClaim === "unloaded-proxy-owner"
        ? [workflowA, proxyB]
        : [workflowA, rawB];
  const registeredOwnersMap =
    registeredOwners ??
    new Map(foreignClaim === "unloaded-proxy-owner" && rootUuid ? [[rootUuid, rawB]] : []);
  const objectUuids = objectUuidsOpt ?? new WeakMap();
  let minted = 0;
  const stableUuidA = new Function(
    "app",
    "getTabId",
    "savedWorkflowPath",
    "_workflowObjectUuids",
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
    objectUuids,
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
    "_workflowObjectUuids",
    "workflowStableUuid",
    "graphRootWorkflowUuidMismatches",
    "graphRootWorkflowUuidMatches",
    "graphRootMismatchesActiveWorkflow",
    "graphReadDesynced",
    "activeWorkflowNodeCount",
    "sameWorkflowObject",
    "workflowOwnsRootUuidTag",
    "rememberWorkflowUuidOwner",
    "resolveGraphRootUuidRebind",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    "app",
    `${fenceSource}\nreturn assertGraphBoundToActiveWorkflow;`,
  )(
    () => workflowA,
    objectUuids,
    stableUuid,
    graphRootWorkflowUuidMismatches,
    graphRootWorkflowUuidMatches,
    graphRootMismatchesActiveWorkflow,
    graphReadDesynced,
    activeWorkflowNodeCount,
    sameWorkflowObject,
    ownsTag,
    () => {},
    resolveGraphRootUuidRebind,
    "comfyui_mcp",
    "workflow_uuid",
    { graph: rootB, extensionManager: { workflow: { openWorkflows } } },
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
    "_workflowObjectUuids",
    "embeddedWorkflowUuid",
    "embeddedWorkflowPath",
    "workflowAliasForPath",
    "workflowUuidOwner",
    "rememberWorkflowUuidOwner",
    "shouldForkEmbeddedWorkflowUuid",
    "shouldForkEmbeddedUuidForLiveOwner",
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
    new WeakMap(),
    () => U1, // the just-saved file carries the pre-save embedded uuid
    () => embeddedPath,
    workflowAliasForPath,
    (id) => owners.get(id) ?? null,
    (id, owner) => owners.set(id, owner),
    shouldForkEmbeddedWorkflowUuid,
    shouldForkEmbeddedUuidForLiveOwner,
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
  return { stableUuid, successor, replaced, owners, U1 };
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

test("graphRootMismatchesActiveWorkflow: TRUE - missing and explicitly empty/null tracker surfaces differ", () => {
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
    const staleState = { ...activeState, [field]: replacement };
    assert.equal(
      graphRootMismatchesActiveWorkflow({ rootGraph: serializedRoot(staleState), activeWorkflow }),
      true,
      `${field}: missing must not collapse into an explicit value`,
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
    /const activeWorkflowUuid = activeWorkflow\s*\? \(_workflowObjectUuids\.get\(activeWorkflow\) \|\| workflowStableUuid\(activeWorkflow\)\)\s*: null;/,
    "the fence must establish a missing object UUID through the root-blind resolver, never from a stale root",
  );
  assert.match(
    body,
    /graphRootWorkflowUuidMismatches\(\{ rootGraph, activeWorkflowUuid \}\)/,
    "a dirty tab retains the positive foreign-root identity fence",
  );
  assert.match(
    body,
    /requireDirtyMutationBinding[\s\S]*!graphRootWorkflowUuidMatches\(\{ rootGraph, activeWorkflowUuid \}\)/,
    "a dirty mutation must require a positive root-to-active UUID match, not merely no mismatch",
  );
  assert.match(
    body,
    /const currentStateTrustworthy = activeWorkflow\?\.isModified !== true;/,
    "a dirty ChangeTracker snapshot is not trustworthy as a binding proof",
  );
  assert.match(
    body,
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

test("resolveGraphRootUuidRebind: none without a conflict, conflict for a foreign open owner, rebind otherwise", () => {
  const tagged = { extra: { comfyui_mcp: { workflow_uuid: "workflow-B" } } };
  assert.equal(
    resolveGraphRootUuidRebind({ rootGraph: tagged, activeWorkflowUuid: "workflow-A" }),
    "rebind",
    "a tag no LIVE OPEN workflow claims is stale bookkeeping, not a wrong canvas",
  );
  assert.equal(
    resolveGraphRootUuidRebind({
      rootGraph: tagged,
      activeWorkflowUuid: "workflow-A",
      rootTagOwnedByForeignOpenWorkflow: true,
    }),
    "conflict",
    "a tag owned by another LIVE OPEN workflow keeps the #349 data-loss fence",
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

test("#545: a root tag NO LIVE OPEN workflow claims (closed/replaced tab's leftover) rebinds instead of blocking every tool", () => {
  const h = buildDirtyStaleRouteHarness({ rootUuid: "workflow-B", foreignClaim: "none" });
  h.objectUuids.set(h.workflowA, "workflow-A");
  assert.doesNotThrow(
    () => h.assertBound(h.rootB, h.rootB, { includeBaselineReadGuard: false }),
    "a leftover tag no open tab claims must not hard-block reads",
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

test("#349 P0 r3: a CREATION-minted tag is registered to the tab the load activates (lifecycle, no manual seeding)", async () => {
  // Drive the REAL creation path: installCreateBoundaryFork wraps
  // app.loadGraphData; a creation (non-object workflow arg) stamps a fresh uuid
  // and — after the load — must register it against the tab the load activated.
  // Without that registration a live, unloaded, never-resolved creation carries
  // a tag nothing claims, and the guard rebinds over its foreign root (r3 P0).
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const forkSource = panelFunctionSource(src, "installCreateBoundaryFork", "workflowUuidOwner");
  const objectUuids = new WeakMap();
  const owners = new Map();
  const createdTab = { isPersisted: false, changeTracker: null }; // live, unloaded, never resolved
  const fakeApp = {
    graph: null,
    extensionManager: { workflow: { activeWorkflow: null, openWorkflows: [] } },
    loadGraphData(graphData) {
      // ComfyUI's creation behavior: the graph goes live in a NEW active tab.
      this.graph = { _nodes: graphData.nodes ?? [], extra: graphData.extra };
      this.extensionManager.workflow.activeWorkflow = createdTab;
      this.extensionManager.workflow.openWorkflows.push(createdTab);
    },
  };
  const install = new Function(
    "_loadGraphDataForkInstalled",
    "_workflowObjectUuids",
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
    objectUuids,
    (id, owner) => owners.set(id, owner),
    isNewWorkflowLoad,
    shouldForkInPlaceReload,
    () => {},
    { randomUUID: () => "creation-uuid-1" },
    "comfyui_mcp",
    "workflow_uuid",
  );
  install(fakeApp);
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

  // …so the desync guard refuses to rebind over that live, unloaded,
  // never-resolved creation while ANOTHER workflow is active: the resolver
  // claim fires straight from the registration (no manual owner-map seeding).
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

test("#557 r3 wiring: programmaticSave threads the pre-save identity across an in-place object swap", () => {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("async function programmaticSave(name)");
  assert.notEqual(start, -1, "programmaticSave must exist");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(
    body,
    /preSwapUuid = expectWf \? _workflowObjectUuids\.get\(expectWf\) \|\| workflowStableUuid\(expectWf\) : null/,
    "the pre-save identity must be captured from the pre-save object BEFORE the save",
  );
  assert.match(
    body,
    /shouldCarryIdentityAcrossSaveSwap\(\{ preWf: expectWf, postWf: postSwapWf, savedAs: outcome\.saved_as \}\)/,
    "the carry must be gated by the pure continuous-lifetime rule (never a Save-As copy)",
  );
  assert.match(
    body,
    /_workflowObjectUuids\.set\(postSwapWf, preSwapUuid\)/,
    "the successor object cache must be seeded with the pre-save uuid",
  );
  assert.match(
    body,
    /rememberWorkflowUuidOwner\(preSwapUuid, postSwapWf\)/,
    "the successor must be registered as the pre-save uuid's owner",
  );
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

test("#545 P1: direct snapshot restore refuses an untagged stale B for dirty A", () => {
  const { src, workflowA, rootB, objectUuids, assertBound } = buildDirtyStaleRouteHarness({ rootUuid: null });
  let loads = 0;
  const restoreSource = panelFunctionSource(src, "restoreSnapshot", "revertGraphToLastSnapshot");
  const restoreSnapshot = new Function(
    "getGraphCtx",
    "activeWorkflowRef",
    "assertGraphBoundToActiveWorkflow",
    `${restoreSource}\nreturn restoreSnapshot;`,
  )(
    () => ({ app: { loadGraphData: () => { loads += 1; } }, graph: rootB, rootGraph: rootB }),
    () => workflowA,
    assertBound,
  );

  assert.equal(
    restoreSnapshot({ workflowRef: workflowA, data: { nodes: [] } }),
    null,
    "the local restore path catches the binding refusal instead of loading B into A",
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
    `const GRAPH_TOOL_EXECUTORS = {${graphLoadSource}\n}; return GRAPH_TOOL_EXECUTORS.graph_load;`,
  )(
    () => ({ app: { loadGraphData: async () => { loads += 1; } }, graph: rootB, rootGraph: rootB }),
    assertBound,
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
    /assertGraphBoundToActiveWorkflow\(graph, rootGraph, \{[\s\S]*requireDirtyMutationBinding: graphCommandMayMutateWorkflow\(msg\.cmd\)[\s\S]*\}\)/,
    "the fence must inspect the executor graph and demand positive dirty binding only for mutations",
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
      /requireDirtyMutationBinding: true/,
      `${startNeedle} must require a positive binding for dirty mutation`,
    );
  };

  orderedFence("async graph_run({ batch_count, to_node_id })", "app.queuePrompt");
  orderedFence("async graph_load({ graph: incoming } = {})", "captureGraphSnapshot(null, \"before graph_load\")");
  orderedFence("function restoreSnapshot(snap)", "app.loadGraphData(JSON.parse(JSON.stringify(snap.data))");
});

test("#349 snapshots: capture is bound and restore rejects a snapshot from another workflow", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const captureStart = src.indexOf("function captureGraphSnapshot(mid, label)");
  const captureSerialize = src.indexOf("const data = rootGraph.serialize();", captureStart);
  const captureFence = src.indexOf("assertGraphBoundToActiveWorkflow(graph, rootGraph, {", captureStart);
  assert.ok(captureStart >= 0 && captureFence > captureStart && captureFence < captureSerialize);
  assert.match(
    src.slice(captureFence, captureSerialize),
    /requireDirtyMutationBinding: true/,
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
  const restoreLoad = src.indexOf("app.loadGraphData(JSON.parse(JSON.stringify(snap.data))", restoreStart);
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
