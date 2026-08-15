import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rootContentProvesActiveWorkflow,
  resolveGraphRootUuidRebind,
  sealProvenRootBinding,
  graphRootMatchesState,
} from "../../web/js/lib/graph-binding.js";

// #817 — "panel_graph_outline rejects active workflow after tab switch with
// root-workflow-uuid-mismatch". Reproduced against these functions before
// anything was changed.
//
// ComfyUI reuses one app.graph object across tabs and its clear/configure does
// NOT reset graph.extra — the same mechanism the #565 both-empty clause already
// records. So switching from A to B leaves A's identity tag sitting on a canvas
// that now holds B's graph, and the tag guard refuses every graph tool.
//
// Nothing self-healed it, and that is the sharp part: `sealProvenRootBinding`
// declines a root that ALREADY carries a tag, so a WRONG tag was stickier than
// no tag at all. A byte-identical canvas with no tag was allowed; the same
// canvas wearing a stale tag was refused until the user re-opened the workflow.

const NODES = [
  { id: 1, type: "KSampler", pos: [0, 0], size: [100, 50] },
  { id: 2, type: "VAEDecode", pos: [0, 0], size: [100, 50] },
];
const B_EXTRA = { frontendVersion: "1.47.12" };
const stateOf = (nodes = NODES) => ({ nodes, links: [], groups: [], config: {}, extra: { ...B_EXTRA } });

/** A live root holding B's graph, optionally still tagged with A's identity. */
const rootOf = (tag, nodes = NODES) => ({
  _nodes: nodes,
  extra: tag ? { ...B_EXTRA, comfyui_mcp: { workflow_uuid: tag } } : { ...B_EXTRA },
  serialize() {
    return { ...stateOf(nodes), extra: { ...this.extra } };
  },
});
const tabOf = (name, nodes = NODES) => ({
  path: `workflows/${name}.json`,
  filename: `${name}.json`,
  isPersisted: true,
  isModified: false,
  changeTracker: { activeState: stateOf(nodes) },
});

/** The panel's exclusivity computation, as the fence performs it. */
const exclusive = (rootGraph, active, others) =>
  !others.some(
    (o) =>
      o &&
      o !== active &&
      o.isModified !== true &&
      graphRootMatchesState({ rootGraph, state: o.changeTracker?.activeState }),
  );

const rebindFor = (rootGraph, active, others, { ownsTag = false, staleEmpty = false } = {}) =>
  resolveGraphRootUuidRebind({
    rootGraph,
    activeWorkflowUuid: "UUID-B",
    rootTagClaimedByActiveWorkflow: ownsTag,
    staleTagOnEmptyCanvas: staleEmpty,
    contentProvesActiveWorkflow: rootContentProvesActiveWorkflow({
      rootGraph,
      activeWorkflow: active,
      proofExclusive: exclusive(rootGraph, active, others),
    }),
  });

// ── the reported case ──────────────────────────────────────────────────────

test("a stale tag on a canvas that IS the active workflow's now rebinds", () => {
  const b = tabOf("B");
  const root = rootOf("UUID-A");
  assert.equal(
    graphRootMatchesState({ rootGraph: root, state: b.changeTracker.activeState }),
    true,
    "precondition: the canvas really is B's",
  );
  assert.equal(rebindFor(root, b, [b]), "rebind");
});

test("the asymmetry is gone — a tagged canvas is treated like its untagged twin", () => {
  // This is the whole defect in one assertion: identical content, one wearing a
  // stale tag. Before #817 the untagged one sealed and the tagged one refused.
  const b = tabOf("B");
  const untagged = rootOf(null);
  const tagged = rootOf("UUID-A");
  const proof = (rootGraph) =>
    rootContentProvesActiveWorkflow({ rootGraph, activeWorkflow: b, proofExclusive: true });
  assert.equal(proof(untagged), true);
  assert.equal(proof(tagged), true, "a stale tag does not weaken the content evidence");
});

// ── what must still refuse ─────────────────────────────────────────────────

test("a clean identical TWIN makes the binding ambiguous — still refuses", () => {
  // Two clean tabs with byte-identical state: equality cannot tell the active
  // tab's canvas from its twin's, so nothing may be re-stamped.
  const b = tabOf("B");
  const twin = tabOf("Twin");
  const root = rootOf("UUID-A");
  assert.equal(exclusive(root, b, [b, twin]), false);
  assert.equal(rebindFor(root, b, [b, twin]), "conflict");
});

test("a genuinely FOREIGN canvas still refuses — this is the #349 case", () => {
  const b = tabOf("B");
  const foreign = rootOf("UUID-A", [{ id: 9, type: "SaveImage", pos: [0, 0], size: [10, 10] }]);
  assert.equal(rebindFor(foreign, b, [b]), "conflict");
});

test("a DIRTY tab proves nothing — a lagging tracker is not evidence (#545)", () => {
  const dirty = tabOf("B");
  dirty.isModified = true;
  const root = rootOf("UUID-A");
  assert.equal(rootContentProvesActiveWorkflow({ rootGraph: root, activeWorkflow: dirty, proofExclusive: true }), false);
  assert.equal(rebindFor(root, dirty, [dirty]), "conflict");
});

test("an unreadable exclusivity check is NOT exclusive — fails closed", () => {
  const b = tabOf("B");
  const root = rootOf("UUID-A");
  assert.equal(
    rootContentProvesActiveWorkflow({ rootGraph: root, activeWorkflow: b, proofExclusive: false }),
    false,
  );
});

test("a descended SUBGRAPH is not the workflow's root canvas", () => {
  const b = tabOf("B");
  const root = rootOf("UUID-A");
  assert.equal(
    rootContentProvesActiveWorkflow({ rootGraph: root, activeWorkflow: b, inSubgraph: true, proofExclusive: true }),
    false,
  );
});

test("missing inputs prove nothing", () => {
  assert.equal(rootContentProvesActiveWorkflow(), false);
  assert.equal(rootContentProvesActiveWorkflow({ proofExclusive: true }), false);
  assert.equal(rootContentProvesActiveWorkflow({ rootGraph: rootOf(null), proofExclusive: true }), false);
  assert.equal(rootContentProvesActiveWorkflow({ activeWorkflow: tabOf("B"), proofExclusive: true }), false);
});

test("no UUID conflict at all is still 'none', not a rebind", () => {
  const b = tabOf("B");
  assert.equal(
    resolveGraphRootUuidRebind({
      rootGraph: rootOf("UUID-B"),
      activeWorkflowUuid: "UUID-B",
      contentProvesActiveWorkflow: true,
    }),
    "none",
  );
  assert.equal(
    resolveGraphRootUuidRebind({ rootGraph: rootOf(null), activeWorkflowUuid: "UUID-B", contentProvesActiveWorkflow: true }),
    "none",
    "an untagged root is inconclusive, not a conflict",
  );
  void b;
});

// ── the seal's own contract is unchanged ───────────────────────────────────

test("the seal still refuses to overwrite an existing tag", () => {
  // The rebind path owns that decision. If the seal started overwriting tags,
  // the #349 conflict case would lose its refusal entirely.
  const b = tabOf("B");
  const tagged = rootOf("UUID-A");
  assert.equal(
    sealProvenRootBinding({ rootGraph: tagged, activeWorkflow: b, activeWorkflowUuid: "UUID-B", proofExclusive: true }),
    false,
  );
  assert.equal(tagged.extra.comfyui_mcp.workflow_uuid, "UUID-A", "the tag is untouched");
});

test("the seal still stamps an untagged, proven, exclusive root", () => {
  const b = tabOf("B");
  const untagged = rootOf(null);
  assert.equal(
    sealProvenRootBinding({ rootGraph: untagged, activeWorkflow: b, activeWorkflowUuid: "UUID-B", proofExclusive: true }),
    true,
  );
  assert.equal(untagged.extra.comfyui_mcp.workflow_uuid, "UUID-B");
});

test("the seal and the rebind ask the SAME question", () => {
  // They drifted once already. The seal now delegates to the shared predicate,
  // so a change to one cannot silently leave the other behind.
  const b = tabOf("B");
  const dirty = tabOf("B");
  dirty.isModified = true;
  for (const [label, active, expected] of [["clean", b, true], ["dirty", dirty, false]]) {
    const untagged = rootOf(null);
    assert.equal(
      sealProvenRootBinding({ rootGraph: untagged, activeWorkflow: active, activeWorkflowUuid: "UUID-B", proofExclusive: true }),
      expected,
      `seal, ${label}`,
    );
    assert.equal(
      rootContentProvesActiveWorkflow({ rootGraph: rootOf(null), activeWorkflow: active, proofExclusive: true }),
      expected,
      `proof, ${label}`,
    );
  }
});
