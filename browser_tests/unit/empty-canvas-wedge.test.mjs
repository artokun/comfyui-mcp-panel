import { test } from "node:test";
import assert from "node:assert/strict";

import {
  serializedStateProvenEmpty,
  activeWorkflowProvenEmpty,
  graphRootProvenEmpty,
  graphEmptyBindingUnproven,
  sealProvenRootBinding,
  graphRootMatchesState,
  resolveGraphBindingVerdict,
} from "../../web/js/lib/graph-binding.js";

// #833 — with an EMPTY workflow active, every panel_* graph tool was refused and
// no documented recovery cleared it. The mechanism, reproduced against these
// functions before anything was changed:
//
//   1. A real empty ComfyUI workflow is not `activeWorkflowProvenEmpty`, because
//      every workflow ComfyUI writes carries `extra.frontendVersion` (a version
//      STRING) and installed extensions add their own per-workflow scalars. The
//      old rule was "any non-empty value in `extra` defeats the proof", so on a
//      real install NO blank workflow was ever provably empty.
//   2. That is the FIRST escape out of `graphEmptyBindingUnproven`. Missing it,
//      the panel needs the second: a root carrying the workflow's uuid, which
//      `sealProvenRootBinding` supplies.
//   3. The seal's exclusivity probe refuses when another CLEAN open workflow's
//      state also matches the root — and against an EMPTY root, every other
//      blank tab matches. Two blank tabs therefore blocked the seal permanently.
//
// So the exit existed only while exactly one blank tab was open, and
// `panel_new_workflow` — step 5 of the report, the one the reporter said
// "escalates the problem" — creates the second one.

/** What a real empty ComfyUI workflow serializes as: zero nodes, but frontend
 *  and extension metadata in `extra`. Verified against this repo owner's own
 *  user/default/workflows — every file carries frontendVersion. */
const REAL_EXTRA = {
  frontendVersion: "1.47.12",
  workflowRendererVersion: 2,
  VHS_latentpreview: false,
  ue_links: [],
  ds: { scale: 1, offset: [0, 0] },
};
const emptyState = (extra = REAL_EXTRA) => ({
  nodes: [], links: [], groups: [], config: {}, extra: { ...extra },
});
const emptyRoot = () => ({ _nodes: [], extra: {}, serialize: () => emptyState() });
const blankTab = (name) => ({
  path: `workflows/${name}.json`,
  filename: `${name}.json`,
  isPersisted: true,
  isModified: false,
  changeTracker: { activeState: emptyState() },
});

/** The panel's own exclusivity computation (comfyui-mcp-panel.js, seal call site). */
const proofExclusive = (rootGraph, active, others) =>
  !others.some(
    (o) =>
      o &&
      o !== active &&
      o.isModified !== true &&
      graphRootMatchesState({ rootGraph, state: o.changeTracker?.activeState }),
  );

// ── The proof bar ──────────────────────────────────────────────────────────

test("a REAL empty workflow is provably empty — version stamps are not content", () => {
  assert.equal(serializedStateProvenEmpty(emptyState()), true);
  assert.equal(activeWorkflowProvenEmpty(blankTab("Untitled")), true);
});

test("a scalar in `extra` cannot be graph content, whatever the extension called it", () => {
  for (const extra of [
    { frontendVersion: "1.47.12" },
    { workflowRendererVersion: 2 },
    { VHS_latentpreview: false },
    { workflowHash: "abc123" },
    { some_future_extension_setting: "on" },
    { aNumber: 0.5 },
  ]) {
    assert.equal(serializedStateProvenEmpty(emptyState(extra)), true, JSON.stringify(extra));
  }
});

test("a STRUCTURED extra value still defeats the proof — that is where content hides", () => {
  for (const [what, extra] of [
    ["groupNodes", { groupNodes: { g1: { nodes: [{ id: 1 }] } } }],
    ["ue_links", { ue_links: [{ from: 1, to: 2 }] }],
    ["linkExtensions", { linkExtensions: [{ id: 1 }] }],
    ["a stashed reroutes array", { reroutes: [{ id: 1, pos: [0, 0] }] }],
  ]) {
    assert.equal(serializedStateProvenEmpty(emptyState(extra)), false, what);
  }
});

test("the graph's OWN surfaces keep the strict rule — a scalar there is malformed, not a stamp", () => {
  assert.equal(serializedStateProvenEmpty({ ...emptyState(), groups: [{ title: "g" }] }), false);
  assert.equal(serializedStateProvenEmpty({ ...emptyState(), links: [[1, 2]] }), false);
  assert.equal(serializedStateProvenEmpty({ ...emptyState(), subgraphs: [{ id: "s" }] }), false);
  assert.equal(serializedStateProvenEmpty({ ...emptyState(), definitions: { x: 1 } }), false);
  // The scalar relaxation is for `extra` ONLY, and this is what says so. A
  // scalar where a graph surface belongs is a MALFORMED read, and an unreadable
  // state is never proof of emptiness — the same "unknown is not a value" rule
  // the rest of this module runs on. Applying the extra rule here would quietly
  // upgrade a corrupt state into a proven-empty canvas.
  assert.equal(serializedStateProvenEmpty({ ...emptyState(), links: "corrupt" }), false);
  assert.equal(serializedStateProvenEmpty({ ...emptyState(), groups: 5 }), false);
  assert.equal(serializedStateProvenEmpty({ ...emptyState(), reroutes: true }), false);
});

test("a canvas WITH NODES is never proven empty — the #560 protection is untouched", () => {
  // A mid-restore tab holds the full graph in its tracker state (that IS the
  // restore source), so it fails on nodes and never reaches the extra rule.
  assert.equal(serializedStateProvenEmpty({ ...emptyState(), nodes: [{ id: 1, type: "KSampler" }] }), false);
  const restoring = blankTab("Restoring");
  restoring.changeTracker.activeState = { ...emptyState(), nodes: [{ id: 1, type: "KSampler" }] };
  assert.equal(activeWorkflowProvenEmpty(restoring), false);
});

test("a DIRTY tab still cannot prove emptiness", () => {
  const dirty = blankTab("Dirty");
  dirty.isModified = true;
  assert.equal(activeWorkflowProvenEmpty(dirty), false);
});

test("an absent or malformed state still proves nothing", () => {
  assert.equal(serializedStateProvenEmpty(null), false);
  assert.equal(serializedStateProvenEmpty({}), false);
  assert.equal(serializedStateProvenEmpty({ nodes: "nope" }), false);
  assert.equal(serializedStateProvenEmpty({ ...emptyState(), extra: "scalar-extra" }), false);
  assert.equal(activeWorkflowProvenEmpty({ isModified: false }), false);
});

// ── The wedge itself ───────────────────────────────────────────────────────

test("TWO blank tabs no longer wedge every graph tool (#833)", () => {
  const active = blankTab("Untitled A");
  const other = blankTab("Untitled B");
  const uuid = "48e8cdaa-f399-4ba8-a76d-45dafc43d859";
  const root = emptyRoot();

  // The seal is still refused — two blank tabs genuinely are ambiguous, and this
  // change does not pretend otherwise.
  const exclusive = proofExclusive(root, active, [active, other]);
  assert.equal(exclusive, false, "a second blank tab still blocks the seal");
  assert.equal(
    sealProvenRootBinding({ rootGraph: root, activeWorkflow: active, activeWorkflowUuid: uuid, proofExclusive: exclusive }),
    false,
  );

  // …and the tools work anyway, because the canvas is now PROVABLY empty, which
  // is the first escape and never needed the seal.
  assert.equal(graphEmptyBindingUnproven({ graph: root, rootGraph: root, activeWorkflow: active, activeWorkflowUuid: uuid }), false);
  assert.equal(
    resolveGraphBindingVerdict({
      graph: root, rootGraph: root, activeWorkflow: active, activeWorkflowUuid: uuid,
      nodeCount: 0, includeBaselineReadGuard: true, requireDirtyMutationBinding: true,
    }),
    null,
    "no refusal — a blank canvas is a legitimate state to read and build on",
  );
});

test("the ONE-blank-tab case that used to work still works", () => {
  const active = blankTab("Only");
  const uuid = "48e8cdaa-f399-4ba8-a76d-45dafc43d859";
  const root = emptyRoot();
  assert.equal(proofExclusive(root, active, [active]), true);
  assert.equal(
    resolveGraphBindingVerdict({
      graph: root, rootGraph: root, activeWorkflow: active, activeWorkflowUuid: uuid,
      nodeCount: 0, includeBaselineReadGuard: true, requireDirtyMutationBinding: true,
    }),
    null,
  );
});

test("a canvas that is empty but whose workflow claims NODES still refuses", () => {
  // The genuinely dangerous shape: the workflow says it has content, the canvas
  // shows none. That is the false-empty read (#560/#604) and must stay fenced.
  const active = blankTab("Has content");
  active.changeTracker.activeState = { ...emptyState(), nodes: [{ id: 1, type: "KSampler" }] };
  const root = emptyRoot();
  const verdict = resolveGraphBindingVerdict({
    graph: root, rootGraph: root, activeWorkflow: active, activeWorkflowUuid: "u",
    nodeCount: 0, includeBaselineReadGuard: true, requireDirtyMutationBinding: true,
  });
  assert.ok(verdict, "an empty canvas under a content-bearing workflow must still refuse");
  // The shape guard reaches it first (the workflow's 1-node state does not
  // reproduce on an empty root); the count guard would catch it too. Either is a
  // correct refusal — what must never happen is no refusal at all.
  assert.ok(
    ["root-shape-mismatch", "root-node-count-desync"].includes(verdict.reason),
    `unexpected reason ${verdict.reason}`,
  );
});

test("an empty root whose workflow is UNREADABLE still refuses — proof, not assumption", () => {
  const root = emptyRoot();
  const unreadable = { isModified: false }; // no tracker, no state
  assert.equal(graphRootProvenEmpty(root), true, "the ROOT is observably empty");
  assert.equal(
    graphEmptyBindingUnproven({ graph: root, rootGraph: root, activeWorkflow: unreadable, activeWorkflowUuid: "u" }),
    true,
    "an unreadable workflow state is not evidence the canvas is genuinely empty",
  );
});
