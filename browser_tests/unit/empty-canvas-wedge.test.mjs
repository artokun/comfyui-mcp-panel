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
  emptyCanvasBindingProven,
  rootContentProvesActiveWorkflow,
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

test("a BOOLEAN or NUMBER in `extra` is admitted — a graph cannot be encoded in one", () => {
  // Admitted by TYPE, so no allowlist is needed and no future extension can
  // invalidate it. These are the per-workflow flags extensions actually write.
  for (const extra of [
    { VHS_latentpreview: false },
    { VHS_KeepIntermediate: true },
    { qgn_locked: false },
    { workflowRendererVersion: 2 },
    { some_future_extension_flag: true },
    { aNumber: 0.5 },
  ]) {
    assert.equal(serializedStateProvenEmpty(emptyState(extra)), true, JSON.stringify(extra));
  }
});

test("a NAMED version string is admitted — these are what made every workflow unprovable", () => {
  for (const extra of [
    { frontendVersion: "1.47.12" },
    { workflowHash: "abc123" },
    { version: "1" },
    { revision: "7" },
  ]) {
    assert.equal(serializedStateProvenEmpty(emptyState(extra)), true, JSON.stringify(extra));
  }
});

test("an UNNAMED string stays content — a graph can be stashed as JSON text (codex)", () => {
  // The counterexample that killed "any scalar is safe": accepting unknown
  // strings is an accept-all-unknown policy on a fence that also gates root
  // UUID stamping. A workflow that keeps refusing is recoverable; a canvas
  // stamped with the wrong identity is not.
  assert.equal(
    serializedStateProvenEmpty(emptyState({ extension_graph: '{"nodes":[{"id":1}],"links":[]}' })),
    false,
  );
  assert.equal(serializedStateProvenEmpty(emptyState({ some_future_extension_setting: "on" })), false);
});

test("exotic types are not evidence of emptiness either", () => {
  assert.equal(serializedStateProvenEmpty(emptyState({ weird: 10n })), false);
  assert.equal(serializedStateProvenEmpty(emptyState({ weird: Symbol("x") })), false);
  assert.equal(serializedStateProvenEmpty(emptyState({ weird: () => {} })), false);
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

  // The CONTENT exclusivity probe is not satisfied — two blank tabs genuinely are
  // ambiguous about which one an empty root belongs to.
  assert.equal(proofExclusive(root, active, [active, other]), false);

  // The seal is still refused — two blank tabs genuinely are ambiguous, and this
  // change does not pretend otherwise.
  assert.equal(
    sealProvenRootBinding({
      rootGraph: root, activeWorkflow: active, activeWorkflowUuid: uuid, proofExclusive: false,
    }),
    false,
  );

  // …and the tools work, which is the point of the whole issue.
  assert.equal(graphEmptyBindingUnproven({ graph: root, rootGraph: root, activeWorkflow: active, activeWorkflowUuid: uuid }), false);
  assert.equal(
    resolveGraphBindingVerdict({
      graph: root, rootGraph: root, activeWorkflow: active, activeWorkflowUuid: uuid,
      liveNodeCount: 0, includeBaselineReadGuard: true, requireDirtyMutationBinding: true,
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

// ── The same bar gates root STAMPING, not just command authorization ────────
// graphRootProvenEmpty runs this predicate on the LIVE root, and the panel uses
// `graphRootProvenEmpty(root) && activeWorkflowProvenEmpty(wf)` to rebind a stale
// root uuid and to stamp a newly created workflow. A false "proven empty" there
// authorizes an identity write, so the tightened rule has to hold on this side
// too (codex).

test("graphRootProvenEmpty admits a real blank root", () => {
  assert.equal(graphRootProvenEmpty(emptyRoot()), true);
});

test("graphRootProvenEmpty refuses a root stashing a graph as JSON text", () => {
  const root = {
    _nodes: [],
    extra: {},
    serialize: () => ({ ...emptyState(), extra: { extension_graph: '{"nodes":[{"id":1}]}' } }),
  };
  assert.equal(graphRootProvenEmpty(root), false, "an identity stamp must not be authorized here");
});

test("graphRootProvenEmpty refuses a root with structured extra content", () => {
  const root = {
    _nodes: [],
    extra: {},
    serialize: () => ({ ...emptyState(), extra: { groupNodes: { g: { nodes: [{ id: 1 }] } } } }),
  };
  assert.equal(graphRootProvenEmpty(root), false);
});

// ── codex round 2: a graph smuggled somewhere a type check does not look ────

test("a graph encoded in the KEY is content, whatever the value's type is", () => {
  const key = '{"nodes":[{"id":1}],"links":[]}';
  assert.equal(serializedStateProvenEmpty(emptyState({ [key]: true })), false);
  assert.equal(serializedStateProvenEmpty(emptyState({ [key]: 1 })), false);
  assert.equal(serializedStateProvenEmpty(emptyState({ [key]: "x" })), false);
});

test("a NAMED stamp still has to look like a stamp", () => {
  // Trusting the key alone admits anything an extension chooses to put there.
  assert.equal(serializedStateProvenEmpty(emptyState({ frontendVersion: '{"nodes":[{"id":1}]}' })), false);
  assert.equal(serializedStateProvenEmpty(emptyState({ workflowHash: "[1,2,3]" })), false);
  assert.equal(serializedStateProvenEmpty(emptyState({ version: "x".repeat(200) })), false);
  // …and a real one still passes.
  assert.equal(serializedStateProvenEmpty(emptyState({ frontendVersion: "1.47.12" })), true);
  assert.equal(serializedStateProvenEmpty(emptyState({ workflowHash: "9f3ac21e" })), true);
});

test("the same two routes are blocked on the STAMPING side", () => {
  const rootWith = (extra) => ({ _nodes: [], extra: {}, serialize: () => ({ ...emptyState(), extra }) });
  assert.equal(graphRootProvenEmpty(rootWith({ '{"nodes":[{"id":1}]}': true })), false);
  assert.equal(graphRootProvenEmpty(rootWith({ frontendVersion: '{"nodes":[{"id":1}]}' })), false);
  assert.equal(graphRootProvenEmpty(rootWith({ frontendVersion: "1.47.12" })), true);
});

// ── The DIRTY blank tab — the half 0.11.49 could not reach (#833 regression) ──
//
// Reported again on panel 0.11.62 after the 0.11.49 fix shipped. The escapes above
// all require a CLEAN tab, and a blank tab is never clean: creating or clearing it
// is what dirties it. So on the reported path both proofs are structurally
// unavailable, and the regression report adds that it survives a hard refresh AND a
// ComfyUI restart — there was no exit at all.
//
// Reproduced end-to-end before changing anything (browser_tests/blank-canvas-not-wedged.spec.ts):
//     graph_outline  -> [empty-binding-unproven]
//     graph_add_node -> [dirty-mutation-binding-unproven]

const dirtyBlankTab = (name) => ({ ...blankTab(name), isModified: true });

test("#833 regression: a DIRTY blank canvas is readable", () => {
  const active = dirtyBlankTab("Untitled");
  const root = emptyRoot();
  // The old escapes genuinely cannot fire here — this is what makes it a wedge.
  assert.equal(activeWorkflowProvenEmpty(active), false, "cleanliness proof is unavailable");
  assert.equal(
    rootContentProvesActiveWorkflow({ rootGraph: root, activeWorkflow: active, proofExclusive: true }),
    false,
    "content proof is unavailable — an empty canvas has nothing to match",
  );
  // …and the read is admitted anyway, because BOTH sides are provably content-free.
  assert.equal(emptyCanvasBindingProven({ rootGraph: root, activeWorkflow: active }), true);
  assert.equal(
    graphEmptyBindingUnproven({ graph: root, rootGraph: root, activeWorkflow: active, activeWorkflowUuid: null }),
    false,
  );
});

test("#833: emptiness is not a skeleton key", () => {
  const uuid = "48e8cdaa-f399-4ba8-a76d-45dafc43d859";

  // A workflow that claims NODES against an empty canvas is the FALSE-EMPTY read
  // (#389/#604) and must stay fenced — this is the shape the guard exists for.
  const claimsNodes = dirtyBlankTab("Has content");
  claimsNodes.changeTracker.activeState = { ...emptyState(), nodes: [{ id: 1, type: "KSampler" }] };
  assert.equal(emptyCanvasBindingProven({ rootGraph: emptyRoot(), activeWorkflow: claimsNodes }), false);

  // A root holding content is not empty, whatever the workflow says.
  const populatedRoot = {
    _nodes: [{ id: 1 }],
    extra: {},
    serialize: () => ({ ...emptyState(), nodes: [{ id: 1, type: "KSampler" }] }),
  };
  assert.equal(
    emptyCanvasBindingProven({ rootGraph: populatedRoot, activeWorkflow: dirtyBlankTab("A") }),
    false,
  );

  // MID-LOAD is the one false-empty emptiness cannot exclude on its own: the canvas
  // reads genuinely empty at that instant and is about to be populated.
  assert.equal(
    emptyCanvasBindingProven({ rootGraph: emptyRoot(), activeWorkflow: dirtyBlankTab("A"), graphLoading: true }),
    false,
  );
  assert.equal(
    sealProvenRootBinding({
      rootGraph: emptyRoot(), activeWorkflow: dirtyBlankTab("A"),
      activeWorkflowUuid: uuid, proofExclusive: true, emptyProofExclusive: true, graphLoading: true,
    }),
    false,
    "a mid-load canvas must never be sealed",
  );

  // An unserializable root proves nothing (a bare empty _nodes array is not proof).
  assert.equal(
    emptyCanvasBindingProven({
      rootGraph: { _nodes: [], extra: {} },
      activeWorkflow: dirtyBlankTab("A"),
    }),
    false,
  );

  // No workflow service at all: the legacy availability path, not a new proof.
  assert.equal(emptyCanvasBindingProven({ rootGraph: emptyRoot(), activeWorkflow: null }), false);
});

