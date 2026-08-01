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

import { activeWorkflowNodeCount, graphReadDesynced } from "../../web/js/lib/graph-binding.js";

// A ComfyUI ChangeTracker-shaped workflow: serialized graph states hang off
// `changeTracker.activeState` / `.initialState` (and some builds hang them flat).
const wf = (over = {}) => ({ changeTracker: {}, ...over });
const state = (n) => ({ nodes: Array.from({ length: n }, (_, i) => ({ id: i + 1 })) });

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
