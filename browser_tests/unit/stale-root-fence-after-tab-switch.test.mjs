/**
 * #1477 — Workflow tab switch leaves stale root workflow identity fence.
 *
 * After the frontend switched to a saved workflow, panel_graph_outline and
 * panel_get_errors both failed `[root-workflow-uuid-mismatch]`. panel_open_workflow
 * then ran but returned content mismatch / outcome unknown (the #1111/#1089
 * wording). panel_list_workflows (fence-exempt) republished the active identity
 * and the next outline succeeded.
 *
 * Two holes on the shipped path:
 *
 *   1. Tab-switch rebind (#817) proved content with byte-identity. A workflow
 *      containing subgraphs regenerates definition link/node ids on the live
 *      canvas (#886/#1706) while the tracker still holds the saved ids, so a
 *      canvas that IS the new tab's still refused. The fence now uses the same
 *      content proof workflow_open already trusts.
 *
 *   2. A CONTENT_UNVERIFIED open whose only differing surface is `definitions`
 *      threw before publishing `workflow_uuid`, leaving the session fenced to
 *      the prior workflow. Binding is proven; a previous-workflow graph disagrees
 *      on nodes/links, not on this surface alone. The open now publishes the
 *      fence and discloses.
 *
 * These drive the shipped functions (rootContentProvesActiveWorkflow, the
 * extracted assertGraphBoundToActiveWorkflow, openContentDifferenceIsDefinitionsOnly)
 * — not a reimplementation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  activeWorkflowProvenEmpty,
  contentProofExclusiveAmongOpen,
  graphBindingRefusalMessage,
  graphCommandBindingBar,
  graphRootMatchesState,
  graphRootProvenEmpty,
  graphRootReproducesStateContent,
  graphRootWorkflowUuidMismatches,
  openContentDifferenceIsDefinitionsOnly,
  resolveGraphBindingVerdict,
  resolveGraphRootUuidRebind,
  rootContentProvesActiveWorkflow,
  rootContentProvesActiveWorkflowDespiteEdits,
  sealProvenRootBinding,
} from "../../web/js/lib/graph-binding.js";
import { rawWorkflowObject, sameWorkflowObject } from "../../web/js/lib/workflow-chat-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const PANEL_SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const ACTIVE = "1477active-0000-4000-8000-00000000000a";
const PREV = "1477prevtab-0000-4000-8000-00000000000b";

const NODES = [
  { id: 1, type: "KSampler", pos: [0, 0], size: [200, 100], widgets_values: [1] },
  { id: 2, type: "VAEDecode", pos: [0, 0], size: [200, 100], widgets_values: [] },
];

function subgraph(lastLinkId, linkId) {
  return {
    id: "sub-1",
    name: "Upscale",
    state: { lastNodeId: 623, lastLinkId, lastGroupId: 0, lastRerouteId: 0 },
    nodes: [
      { id: 65, type: "LoadImage", outputs: [{ name: "IMAGE", type: "IMAGE", links: [linkId] }] },
      { id: 623, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: linkId }] },
    ],
    links: [[linkId, 65, 0, 623, 0, "IMAGE"]],
    inputs: [],
    outputs: [],
  };
}

function stateOf(defs, nodes = NODES) {
  return {
    nodes: nodes.map((n) => ({ ...n })),
    links: [],
    groups: [],
    config: {},
    extra: { frontendVersion: "1.49.6" },
    definitions: { subgraphs: [subgraph(...defs)] },
  };
}

const SAVED_DEFS = [2092, 7];
const LIVE_DEFS = [2106, 21];

function rootOf(tag, liveState) {
  return {
    _nodes: liveState.nodes,
    extra: { frontendVersion: "1.49.6", comfyui_mcp: { workflow_uuid: tag } },
    serialize() {
      return {
        ...liveState,
        extra: { ...liveState.extra, comfyui_mcp: { workflow_uuid: tag } },
      };
    },
  };
}

function tabOf(state, { modified = false } = {}) {
  return {
    path: "workflows/minimaxH3InfiniteVideoRef2va9Img3_v2Turbo.json",
    filename: "minimaxH3InfiniteVideoRef2va9Img3_v2Turbo.json",
    isPersisted: true,
    isModified: modified,
    changeTracker: { activeState: state },
  };
}

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

/** The shipping fence, extracted — the function panel_graph_outline actually runs. */
function buildFence({ openWorkflows, rootGraph }) {
  const fenceSource = panelFunctionSource(PANEL_SRC, "assertGraphBoundToActiveWorkflow", "getPiniaStore");
  const ownsTagSource = panelFunctionSource(PANEL_SRC, "workflowOwnsRootUuidTag", "assertGraphBoundToActiveWorkflow");
  const activeWorkflow = openWorkflows[0];
  const ownsTag = new Function(
    "workflowStableUuid",
    "rawWorkflowObject",
    "sameWorkflowObject",
    "workflowUuidOwner",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    `${ownsTagSource}\nreturn workflowOwnsRootUuidTag;`,
  )(() => ACTIVE, rawWorkflowObject, sameWorkflowObject, () => null, "comfyui_mcp", "workflow_uuid");
  return new Function(
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
    () => activeWorkflow,
    (wf) => (wf === activeWorkflow ? ACTIVE : null),
    () => ACTIVE,
    graphRootWorkflowUuidMismatches,
    resolveGraphBindingVerdict,
    graphBindingRefusalMessage,
    activeWorkflowProvenEmpty,
    graphRootProvenEmpty,
    ownsTag,
    () => {},
    resolveGraphRootUuidRebind,
    () => false,
    sealProvenRootBinding,
    rootContentProvesActiveWorkflow,
    rootContentProvesActiveWorkflowDespiteEdits,
    contentProofExclusiveAmongOpen,
    graphRootMatchesState,
    sameWorkflowObject,
    { graph: rootGraph, extensionManager: { workflow: { openWorkflows } } },
    "comfyui_mcp",
    "workflow_uuid",
  );
}

// ── the reported tab-switch case ─────────────────────────────────────────────

test("#1477 a stale tag plus definitions-only live rewrite IS the active workflow", () => {
  const saved = stateOf(SAVED_DEFS);
  const live = stateOf(LIVE_DEFS);
  const root = rootOf(PREV, live);
  const active = tabOf(saved);
  assert.equal(
    graphRootMatchesState({ rootGraph: root, state: saved }),
    false,
    "precondition: byte-identity still sees the definitions rewrite — that is why #817 missed this",
  );
  assert.equal(
    graphRootReproducesStateContent({ rootGraph: root, state: saved }).proven,
    true,
    "the open's own content proof already accounts for the rewrite",
  );
  assert.equal(
    rootContentProvesActiveWorkflow({ rootGraph: root, activeWorkflow: active, proofExclusive: true }),
    true,
    "the tab-switch rebind must ask that same question",
  );
  assert.equal(
    resolveGraphRootUuidRebind({
      rootGraph: root,
      activeWorkflowUuid: ACTIVE,
      contentProvesActiveWorkflow: true,
    }),
    "rebind",
  );
});

test("#1477 the shipping fence restamps the tag and admits the read", () => {
  const saved = stateOf(SAVED_DEFS);
  const live = stateOf(LIVE_DEFS);
  const root = rootOf(PREV, live);
  const active = tabOf(saved);
  const fence = buildFence({ openWorkflows: [active], rootGraph: root });
  assert.doesNotThrow(
    () => fence(root, root, graphCommandBindingBar("graph_outline")),
    "panel_graph_outline must not refuse the canvas the user just switched to",
  );
  assert.equal(root.extra.comfyui_mcp.workflow_uuid, ACTIVE, "the previous tab's tag is gone");
});

test("#1477 panel_get_errors draws the same bar — both reported tools recover", () => {
  assert.deepEqual(graphCommandBindingBar("graph_get_errors"), graphCommandBindingBar("graph_outline"));
});

test("#1477 a different ROOT node set is still a foreign canvas — fail closed", () => {
  const saved = stateOf(SAVED_DEFS);
  const foreign = stateOf(LIVE_DEFS, [{ id: 9, type: "SaveImage", pos: [0, 0], size: [10, 10], widgets_values: [] }]);
  const root = rootOf(PREV, foreign);
  const active = tabOf(saved);
  assert.equal(
    rootContentProvesActiveWorkflow({ rootGraph: root, activeWorkflow: active, proofExclusive: true }),
    false,
  );
  const fence = buildFence({ openWorkflows: [active], rootGraph: root });
  assert.throws(
    () => fence(root, root, graphCommandBindingBar("graph_outline")),
    /\[root-workflow-uuid-mismatch\]/,
  );
  assert.equal(root.extra.comfyui_mcp.workflow_uuid, PREV, "the tag is untouched");
});

test("#1477 a ROOT widget-value difference is still a foreign canvas", () => {
  const saved = stateOf(SAVED_DEFS);
  const live = stateOf(LIVE_DEFS, [
    { ...NODES[0], widgets_values: [999] },
    NODES[1],
  ]);
  const root = rootOf(PREV, live);
  const active = tabOf(saved);
  assert.equal(
    rootContentProvesActiveWorkflow({ rootGraph: root, activeWorkflow: active, proofExclusive: true }),
    false,
    "a genuine content change must not ride in on the definitions rewrite",
  );
});

test("#1477 cosmetic nodes plus accounted definitions still prove the canvas", () => {
  // The presentation-only ground used to read RAW surfaces, so `nodes`+`definitions`
  // (the subgraph-workflow shape) failed it even when definitions were accounted
  // and the node difference was pos/order only.
  const saved = stateOf(SAVED_DEFS);
  const live = stateOf(LIVE_DEFS, [
    { ...NODES[0], pos: [40, 10], order: 2 },
    { ...NODES[1], pos: [240, 10], order: 1 },
  ]);
  const proof = graphRootReproducesStateContent({ rootGraph: rootOf(PREV, live), state: saved });
  assert.equal(proof.presentationOnly, true);
  assert.equal(
    rootContentProvesActiveWorkflow({
      rootGraph: rootOf(PREV, live),
      activeWorkflow: tabOf(saved),
      proofExclusive: true,
    }),
    true,
  );
});

// ── open must not leave the session fenced to the prior workflow ─────────────

test("#1477 definitions-only is recognised, and a node mismatch is not", () => {
  assert.equal(
    openContentDifferenceIsDefinitionsOnly({ comparable: true, surfaces: ["definitions"] }),
    true,
  );
  assert.equal(
    openContentDifferenceIsDefinitionsOnly({ comparable: true, surfaces: ["nodes", "definitions"] }),
    false,
    "a previous-workflow graph disagrees on nodes — that stays fail-closed",
  );
  assert.equal(
    openContentDifferenceIsDefinitionsOnly({ comparable: true, surfaces: ["nodes"] }),
    false,
  );
  assert.equal(openContentDifferenceIsDefinitionsOnly({ comparable: false, surfaces: ["definitions"] }), false);
  assert.equal(openContentDifferenceIsDefinitionsOnly({ comparable: true, surfaces: [] }), false);
});

test("#1477 a CONTENT_UNVERIFIED open that is definitions-only publishes the fence", () => {
  // The throw is what skipped `workflow_uuid`. Binding-proven + definitions-only
  // must take the disclose-and-publish path instead.
  const openBody = PANEL_SRC.slice(
    PANEL_SRC.indexOf("async workflow_open({ path, rid }) {"),
    PANEL_SRC.indexOf("\n  async workflow_live_sync("),
  );
  assert.match(
    openBody,
    /openContentDifferenceIsDefinitionsOnly\(\{/,
    "the open must ask the definitions-only question before throwing",
  );
  assert.match(openBody, /openDefinitionsUnverified = true/, "and take the publish path");
  const skipBlock = openBody.slice(openBody.indexOf("openContentDifferenceIsDefinitionsOnly({"));
  assert.match(
    skipBlock,
    /openDefinitionsUnverified = true[\s\S]*?else \{\s*rebindFailed = new Error\(\s*describeOpenRebindOutcome/,
    "the skip is decided BEFORE the throw, and every other verdict still throws",
  );
  assert.match(openBody, /definitions_unverified: true/, "the reply discloses rather than hiding it");
  assert.match(openBody, /\.\.\.\(activeWorkflowUuid \? \{ workflow_uuid: activeWorkflowUuid \} : \{\}\)/);
});

test("#1477 a genuine wrong-graph open still throws — the skip is definitions-only", () => {
  const openBody = PANEL_SRC.slice(
    PANEL_SRC.indexOf("async workflow_open({ path, rid }) {"),
    PANEL_SRC.indexOf("\n  async workflow_live_sync("),
  );
  // The throw remains for every other CONTENT_UNVERIFIED / UNPROVEN verdict.
  assert.match(openBody, /rebindFailed = new Error\(\s*describeOpenRebindOutcome\(verdict,/);
  assert.match(
    openBody,
    /verdict\.status === OPEN_REBIND_STATUS\.CONTENT_UNVERIFIED/,
    "UNPROVEN (identity not proven) must not take this skip",
  );
});

// ── tab switch restamps in the same tick as the session re-hello ─────────────

test("#1477 a genuine tab switch heals the root tag next to the re-hello", () => {
  const start = PANEL_SRC.indexOf("function onWorkflowMaybeChanged() {");
  assert.notEqual(start, -1);
  const body = PANEL_SRC.slice(start, PANEL_SRC.indexOf("\n  function renderHistory()", start));
  assert.match(body, /client\?\.rehello\?\.\(\)/, "the session fence still republishes");
  assert.match(
    body,
    /if \(!renaming\) tryHealStaleRootWorkflowIdentity\(\)/,
    "and the root tag is restamped on the same switch, not a later graph command",
  );
  const heal = panelFunctionSource(PANEL_SRC, "tryHealStaleRootWorkflowIdentity", "stampGraphRootWorkflowUuid");
  assert.match(
    heal,
    /assertGraphBoundToActiveWorkflow\(graph, rootGraph, graphCommandBindingBar\("graph_outline"\)\)/,
    "the heal is the shipped fence, not a second spelling of the proof",
  );
});
