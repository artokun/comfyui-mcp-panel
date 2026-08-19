/**
 * #1233 — after a tab switch onto an UNSAVED (never-saved, modified) workflow tab,
 * panel_graph_outline was refused `[root-workflow-uuid-mismatch]` even though the
 * #995 dispatch-fence bypass had already PROVEN the canvas: content-equal to the
 * active tab's own tracker state, exclusive among open tabs, nothing written.
 *
 * The fence runs TWICE for those reads. Bridge dispatch asserts with
 * `graphCommandBindingBar(msg.cmd)` — the read bar, which carries the #995
 * stale-tag bypass — and the graph_outline / graph_get_errors executors then
 * RE-assert for the #389 baseline guard. The executors passed NO options, and the
 * bypass defaults OFF, so the re-assert recomputed the same mismatch and refused
 * the canvas the dispatch fence had just admitted. Every other read executor
 * relies on the dispatch fence alone, which is why the surviving symptom named
 * graph_outline. Re-opening the workflow re-stamps the root tag, which is why
 * panel_open_workflow "fixed" it.
 *
 * Proven here against the SHIPPING fence, extracted from the monolith and driven
 * with doubles (the graph-binding.test.mjs idiom): the dispatch bar passes the
 * reported state, bare executor defaults refuse it, and the read bar the
 * executors now re-assert with passes it — while a foreign canvas, a twin, and
 * every mutation still refuse.
 */
import test from "node:test";
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
  graphRootWorkflowUuidMismatches,
  resolveGraphBindingVerdict,
  resolveGraphRootUuidRebind,
  rootContentProvesActiveWorkflow,
  rootContentProvesActiveWorkflowDespiteEdits,
  sealProvenRootBinding,
} from "../../web/js/lib/graph-binding.js";
import {
  rawWorkflowObject,
  sameWorkflowObject,
} from "../../web/js/lib/workflow-chat-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** Index of `function <name>(`, INCLUDING a preceding `async ` when present —
 *  without it an extracted async function loses its keyword and its `await`
 *  becomes a syntax error inside `new Function`. (Same helper as
 *  graph-binding.test.mjs.) */
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

const ACTIVE_UUID = "1233active-0000-4000-8000-00000000000a";
const PREV_UUID = "1233prevtab-0000-4000-8000-00000000000b";

const state = (n, tweak = {}) => ({
  nodes: Array.from({ length: n }, (_, i) => ({ id: i + 1, type: "KSampler", pos: [0, 0], size: [200, 100] })),
  links: [],
  groups: [],
  config: {},
  extra: {},
  ...tweak,
});

/** A live root holding the ACTIVE tab's graph, still wearing the PREVIOUS tab's
 *  identity tag — ComfyUI reuses one app.graph across tabs and clear/configure
 *  does not reset graph.extra (the #817 mechanism). */
const rootOf = (s, tag = PREV_UUID) => ({
  _nodes: s.nodes,
  extra: { comfyui_mcp: { workflow_uuid: tag } },
  serialize: () => ({ ...s, extra: { ...(s.extra ?? {}), comfyui_mcp: { workflow_uuid: tag } } }),
});

/** The #1233 active tab: never saved, carrying unsaved edits. */
const unsavedTab = (s, { modified = true } = {}) => ({
  isPersisted: false,
  isModified: modified,
  changeTracker: { activeState: s },
});

/**
 * The shipping fence, extracted and wired exactly as graph-binding.test.mjs wires
 * it: the real lib predicates, the real `workflowOwnsRootUuidTag` (with an empty
 * owner registry — NOBODY claims the previous tab's tag, the reported state), and
 * an identity resolver that answers the active tab's own uuid. `openWorkflows`
 * parameterizes the exclusivity enumeration.
 */
function buildFence({ openWorkflows }) {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const fenceSource = panelFunctionSource(src, "assertGraphBoundToActiveWorkflow", "getPiniaStore");
  const ownsTagSource = panelFunctionSource(src, "workflowOwnsRootUuidTag", "assertGraphBoundToActiveWorkflow");
  const activeWorkflow = openWorkflows[0];
  const ownsTag = new Function(
    "workflowStableUuid",
    "rawWorkflowObject",
    "sameWorkflowObject",
    "workflowUuidOwner",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    `${ownsTagSource}\nreturn workflowOwnsRootUuidTag;`,
  )(
    () => ACTIVE_UUID,
    rawWorkflowObject,
    sameWorkflowObject,
    () => null, // no registered owner for the previous tab's tag
    "comfyui_mcp",
    "workflow_uuid",
  );
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
    (wf) => (wf === activeWorkflow ? ACTIVE_UUID : null),
    () => ACTIVE_UUID,
    graphRootWorkflowUuidMismatches,
    resolveGraphBindingVerdict,
    graphBindingRefusalMessage,
    activeWorkflowProvenEmpty,
    graphRootProvenEmpty,
    ownsTag,
    () => {},
    resolveGraphRootUuidRebind,
    () => false, // outside any post-reconnect settle window
    sealProvenRootBinding,
    rootContentProvesActiveWorkflow,
    rootContentProvesActiveWorkflowDespiteEdits,
    contentProofExclusiveAmongOpen,
    graphRootMatchesState,
    sameWorkflowObject,
    { graph: null, extensionManager: { workflow: { openWorkflows } } },
    "comfyui_mcp",
    "workflow_uuid",
  );
}

/** What the graph_outline / graph_get_errors executors must re-assert with after
 *  the fix: this command's OWN read bar (the #995 bypass included) plus the
 *  executor-only #389 baseline guard. */
const READ_EXECUTOR_BAR = (cmd) => ({ ...graphCommandBindingBar(cmd), includeBaselineReadGuard: true });

// ── the reported case, driven through the shipping fence ─────────────────────

test("#1233 the dispatch fence ADMITS the reported read — the #995 bypass proves the canvas", () => {
  const s = state(3);
  const fence = buildFence({ openWorkflows: [unsavedTab(s)] });
  const root = rootOf(s);
  assert.doesNotThrow(() => fence(root, root, graphCommandBindingBar("graph_outline")));
});

test("#1233 bare executor defaults REVOKE that admission — the residual this fix removes", () => {
  // What the executors passed before the fix: no options. The bypass defaults
  // OFF, the re-assert recomputes the same mismatch, and the canvas the dispatch
  // fence had just proven is refused as root-workflow-uuid-mismatch. This is the
  // exact error text of the report, and it is why panel_open_workflow (which
  // re-stamps the root) was the only way out.
  const s = state(3);
  const fence = buildFence({ openWorkflows: [unsavedTab(s)] });
  const root = rootOf(s);
  assert.throws(() => fence(root, root), /\[root-workflow-uuid-mismatch\]/);
});

test("#1233 the executor's re-assert on the command's OWN read bar passes the same canvas", () => {
  const s = state(3);
  const fence = buildFence({ openWorkflows: [unsavedTab(s)] });
  const root = rootOf(s);
  assert.doesNotThrow(() => fence(root, root, READ_EXECUTOR_BAR("graph_outline")), "graph_outline");
  assert.doesNotThrow(() => fence(root, root, READ_EXECUTOR_BAR("graph_get_errors")), "graph_get_errors");
  assert.equal(
    root.extra.comfyui_mcp.workflow_uuid,
    PREV_UUID,
    "and nothing was written — the bypass clears the flag for the call, the tag is left alone",
  );
});

// ── what must still refuse through that same bar ─────────────────────────────

test("#1233 a FOREIGN canvas still refuses — the bypass needs content equality", () => {
  const fence = buildFence({ openWorkflows: [unsavedTab(state(3))] });
  const foreign = rootOf(state(5));
  assert.throws(
    () => fence(foreign, foreign, READ_EXECUTOR_BAR("graph_outline")),
    /\[root-workflow-uuid-mismatch\]/,
  );
});

test("#1233 a dirty TWIN still refuses — exclusivity is not skippable once edits are allowed (#995)", () => {
  const s = state(3);
  const active = unsavedTab(s);
  const dirtyTwin = unsavedTab(s, { modified: true });
  const fence = buildFence({ openWorkflows: [active, dirtyTwin] });
  const root = rootOf(s);
  assert.throws(() => fence(root, root, READ_EXECUTOR_BAR("graph_outline")), /\[root-workflow-uuid-mismatch\]/);
});

test("#1233 a MUTATION still refuses the same canvas — the bypass is read-only by classification", () => {
  const s = state(3);
  const fence = buildFence({ openWorkflows: [unsavedTab(s)] });
  const root = rootOf(s);
  assert.throws(() => fence(root, root, graphCommandBindingBar("graph_add_node")));
});

// ── the shipping executors really re-assert with their own read bar ──────────

test("#1233 source guard: both re-asserting read executors pass their OWN classified bar", () => {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  for (const cmd of ["graph_outline", "graph_get_errors"]) {
    const methodStart = src.indexOf(`${cmd}(`);
    assert.notEqual(methodStart, -1, `${cmd} executor not found`);
    const fenceCall = src.indexOf("assertGraphBoundToActiveWorkflow(graph, rootGraph", methodStart);
    assert.notEqual(fenceCall, -1, `${cmd} executor no longer re-asserts the fence`);
    const callSlice = src.slice(fenceCall, fenceCall + 300);
    assert.match(
      callSlice,
      new RegExp(`graphCommandBindingBar\\("${cmd}"\\)`),
      `${cmd} must re-assert with its OWN classified bar — bare defaults silently drop the #995 stale-tag bypass`,
    );
    assert.match(
      callSlice,
      /includeBaselineReadGuard: true/,
      `${cmd} must keep the executor-only #389 baseline read guard on`,
    );
  }
});
