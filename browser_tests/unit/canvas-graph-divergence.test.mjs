/**
 * Unit tests for the "mutations reach the wrong graph" family — #604 / #603 /
 * #616 / #374 — run with `node --test`.
 *
 * THE SHARED INVARIANT
 * --------------------
 * A graph command may only run on a canvas whose identity the panel can PROVE,
 * and a MUTATION may never run on evidence that would not satisfy a READ.
 *
 * The panel broke that invariant in the two places where a graph command picks
 * its target and checks it, and both breaks read a value computed for one
 * purpose as the answer to a different question:
 *
 *  1. `resolveScope` / `getGraphCtx` MANUFACTURED a binding. "The canvas graph is
 *     not reachable from app.graph" was computed to mean "the canvas still points
 *     at a SUBGRAPH the rebuilt root no longer owns" (#220/#308) — a ghost that
 *     holds none of the workflow, so reconciling the view to root loses nothing.
 *     It was then read as "the canvas graph is garbage, replace it", and the
 *     repair (`app.canvas.setGraph(app.graph)`) ran for the ROOT-LEVEL case too.
 *     #604's follow-up report is exactly that: after a backend restart with no
 *     page reload, `app.graph` was empty while the canvas held the user's unsaved
 *     ~31-node graph; the panel pointed the canvas at the empty root, the 31-node
 *     graph became unreferenced ("the memory-only graph was unrecoverable"), and
 *     every downstream guard was then handed a self-consistent
 *     (app.graph, activeWorkflow) pair that said nothing about the canvas the
 *     command was issued for. The evidence was destroyed before it could be
 *     reported.
 *
 *  2. The binding EVIDENCE BAR was lower for mutations than for reads. The bridge
 *     dispatch fence hard-coded `includeBaselineReadGuard: false` for every
 *     command and only the read executors re-asserted with it on. So the exact
 *     evidence that made `graph_outline` refuse — "the active workflow reports
 *     N>0 nodes but the live root reads empty" — let `graph_remove_node` through.
 *     That is #604's title verbatim: reads blocked, mutations still routed to the
 *     wrong workflow tab and deleted nodes from it.
 *
 * FAIL-before / PASS-after: with the old resolveScope the divergence test below
 * sees `stale: true`, getGraphCtx repaints the canvas and returns normally, so
 * both the refusal and the "user's graph still mounted" assertions fail. With the
 * old dispatch bar the mutation-symmetry test sees a `null` verdict for every
 * mutating command on evidence a read refuses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  graphIsSubgraphLike,
  resolveScope,
  SUBGRAPH_INPUT_RAIL_ID,
  SUBGRAPH_OUTPUT_RAIL_ID,
} from "../../web/js/lib/subgraph-scope.js";
import {
  graphBindingRefusalMessage,
  graphCommandBindingBar,
  graphCommandMayMutateWorkflow,
  resolveGraphBindingVerdict,
  MUTATION_BINDING_BAR,
} from "../../web/js/lib/graph-binding.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

function panelFunctionSource(src, name, nextName) {
  const start = src.indexOf(`function ${name}(`);
  const end = src.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `could not locate ${name} in panel source`);
  assert.notEqual(end, -1, `could not locate ${nextName} after ${name}`);
  return src.slice(start, end);
}

/** The panel's REAL getGraphCtx, with only its ambient globals injected, so the
 *  refusal AND the absence of the destructive repaint are both observable. */
function buildGetGraphCtx(app) {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const source = panelFunctionSource(src, "getGraphCtx", "workflowOwnsRootUuidTag");
  return new Function(
    "app",
    "window",
    "resolveScope",
    `${source}\nreturn getGraphCtx;`,
  )(app, { LiteGraph: {} }, resolveScope);
}

function nodes(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1 + offset, type: "Node" }));
}

/** A LiteGraph SUBGRAPH as this codebase already identifies one: boundary rails
 *  (the same members resolveRailNode reads). */
function subgraphObject({ nodes: inner = [] } = {}) {
  return {
    name: "sub",
    inputNode: { id: SUBGRAPH_INPUT_RAIL_ID },
    outputNode: { id: SUBGRAPH_OUTPUT_RAIL_ID },
    inputs: [],
    outputs: [],
    _nodes: inner,
  };
}

/** An `app` whose canvas points at `canvasGraph`; setGraph is COUNTED because
 *  calling it at all is the destructive act under test. */
function makeApp({ rootGraph, canvasGraph }) {
  const app = {
    graph: rootGraph,
    canvas: {
      graph: canvasGraph ?? rootGraph,
      setGraphCalls: 0,
      setGraph(g) {
        this.setGraphCalls += 1;
        this.graph = g;
      },
      setDirty() {},
    },
  };
  return app;
}

// ---------------------------------------------------------------------------
// graphIsSubgraphLike — the predicate that separates the two questions
// ---------------------------------------------------------------------------

test("graphIsSubgraphLike: POSITIVE subgraph evidence only (rails, or a foreign rootGraph back-pointer)", () => {
  assert.equal(graphIsSubgraphLike(subgraphObject()), true, "boundary rails are subgraph evidence");
  assert.equal(
    graphIsSubgraphLike({ _nodes: [], _inputNode: { id: SUBGRAPH_INPUT_RAIL_ID } }),
    true,
    "the private rail members count too (resolveRailNode reads both forms)",
  );
  const root = { _nodes: [] };
  assert.equal(
    graphIsSubgraphLike({ _nodes: [], rootGraph: root }),
    true,
    "a rootGraph back-pointer naming a DIFFERENT graph is subgraph evidence",
  );

  const selfRooted = { _nodes: [] };
  selfRooted.rootGraph = selfRooted;
  assert.equal(
    graphIsSubgraphLike(selfRooted),
    false,
    "a root LGraph is its own rootGraph — that is NOT subgraph evidence",
  );
  assert.equal(graphIsSubgraphLike({ _nodes: nodes(31) }), false, "a bare root-level graph");
  assert.equal(graphIsSubgraphLike(null), false);
  assert.equal(graphIsSubgraphLike("graph"), false);
});

// ---------------------------------------------------------------------------
// resolveScope — divergence is its own verdict, and must NOT arm the repaint
// ---------------------------------------------------------------------------

test("#604: canvas and app.graph hold two different ROOT graphs ⇒ diverged, and stale stays FALSE", () => {
  // The reported post-backend-restart state: app.graph empty, the canvas still
  // holding the user's unsaved 31-node workflow.
  const rootGraph = { _nodes: [] };
  const canvasGraph = { _nodes: nodes(31) };
  const scope = resolveScope(makeApp({ rootGraph, canvasGraph }));

  assert.equal(scope.diverged, true, "a root-level canvas unreachable from app.graph is a DIVERGENCE");
  assert.equal(
    scope.stale,
    false,
    "stale is the caller's REPAINT trigger — arming it here is what discarded the user's graph",
  );
  assert.equal(
    scope.graph,
    canvasGraph,
    "the reported graph is the one the user is looking at, not the one we could reach",
  );
  assert.equal(scope.rootGraph, rootGraph);
});

test("#220/#308 regression fence: a ghost SUBGRAPH still reconciles to root (stale, not diverged)", () => {
  // A subgraph the REBUILT root neither owns via an owner node nor registers.
  const rootGraph = { _nodes: [{ id: 1, type: "Node" }] };
  const ghost = subgraphObject({ nodes: nodes(2, 100) });
  const scope = resolveScope(makeApp({ rootGraph, canvasGraph: ghost }));

  assert.equal(scope.stale, true, "the #220/#308 ghost must still reconcile to root");
  assert.equal(scope.diverged, false, "a ghost subgraph is NOT the #604 root divergence");
  assert.equal(scope.graph, rootGraph, "reads and edits both land on the live root");
});

test("resolveScope: an EMPTY diverged canvas is still a divergence — 'no content' is not proof of a good binding", () => {
  // Both sides empty. There is no content to lose, but there is also no proof of
  // which graph the command names — and "could not determine" must not become a
  // verdict in either direction.
  const scope = resolveScope(makeApp({ rootGraph: { _nodes: [] }, canvasGraph: { _nodes: [] } }));
  assert.equal(scope.diverged, true);
  assert.equal(scope.stale, false);
});

// ---------------------------------------------------------------------------
// getGraphCtx — refuse the divergence; never repaint the user's canvas away
// ---------------------------------------------------------------------------

test("#604: getGraphCtx REFUSES a diverged canvas and leaves the user's live graph mounted", () => {
  const rootGraph = { _nodes: [] };
  const canvasGraph = { _nodes: nodes(31) };
  const app = makeApp({ rootGraph, canvasGraph });
  const getGraphCtx = buildGetGraphCtx(app);

  assert.throws(
    () => getGraphCtx(),
    /\[canvas-root-divergence\][\s\S]*was NOT applied/,
    "the divergence must be a loud, reasoned refusal — not a silently-picked graph",
  );
  assert.equal(
    app.canvas.setGraphCalls,
    0,
    "the user's canvas must NOT be repainted: setGraph(app.graph) is what made the 31-node graph unrecoverable",
  );
  assert.equal(app.canvas.graph, canvasGraph, "the graph the user was editing is still mounted");
});

test("#604: the divergence refusal states BOTH candidate graphs and a remedy that actually rebinds", () => {
  const app = makeApp({ rootGraph: { _nodes: nodes(4) }, canvasGraph: { _nodes: nodes(31) } });
  const getGraphCtx = buildGetGraphCtx(app);
  let message = "";
  try {
    getGraphCtx();
  } catch (err) {
    message = err.message;
  }
  assert.match(message, /31 node\(s\)/, "the canvas the user is looking at must be named");
  assert.match(message, /4 node\(s\)/, "the bound root must be named");
  assert.match(message, /reload the ComfyUI page/, "the remedy must be the one that rebuilds the binding");
  assert.doesNotMatch(
    message,
    /panel_open_workflow/,
    "open_workflow cannot rebuild this binding — recommending it produces the #603/#604 retry churn",
  );
});

test("#220/#308 regression fence: getGraphCtx still reconciles a GHOST subgraph to root", () => {
  const rootGraph = { _nodes: [{ id: 1, type: "Node" }] };
  const ghost = subgraphObject({ nodes: nodes(2, 100) });
  const app = makeApp({ rootGraph, canvasGraph: ghost });
  const ctx = buildGetGraphCtx(app)();

  assert.equal(ctx.graph, rootGraph);
  assert.equal(app.canvas.setGraphCalls, 1, "the ghost view is reconciled so reads and edits stay in lockstep");
  assert.equal(app.canvas.graph, rootGraph);
});

test("getGraphCtx: an ordinary root-bound canvas is untouched (no false refusal)", () => {
  const rootGraph = { _nodes: nodes(3) };
  const app = makeApp({ rootGraph, canvasGraph: rootGraph });
  const ctx = buildGetGraphCtx(app)();
  assert.equal(ctx.graph, rootGraph);
  assert.equal(ctx.rootGraph, rootGraph);
  assert.equal(app.canvas.setGraphCalls, 0);
});

test("getGraphCtx: a VALID open subgraph keeps subgraph scope (no false refusal)", () => {
  const sub = subgraphObject({ nodes: nodes(2, 100) });
  const rootGraph = { _nodes: [{ id: 7, type: "SubgraphNode", subgraph: sub }] };
  const app = makeApp({ rootGraph, canvasGraph: sub });
  const ctx = buildGetGraphCtx(app)();
  assert.equal(ctx.graph, sub, "the user is inside the subgraph; reads and edits target it");
  assert.equal(ctx.rootGraph, rootGraph);
  assert.equal(app.canvas.setGraphCalls, 0);
});

// ---------------------------------------------------------------------------
// The evidence bar: a mutation may never clear a LOWER bar than a read
// ---------------------------------------------------------------------------

/**
 * The evidence in which ONLY the baseline read guard can fire, which is what
 * made the read/mutation asymmetry reachable rather than theoretical: a live
 * root that exposes no `_nodes` ARRAY at all (a half-rebuilt root after a
 * backend restart). `graphRootMismatchesActiveWorkflow` and
 * `graphEmptyBindingUnproven` both bail out as inconclusive by design when the
 * live node array is unreadable, so `graphReadDesynced` is the only predicate
 * left — and gating it off for mutations left them with no fence at all.
 */
function halfRebuiltRootEvidence(expectedNodeCount = 3) {
  return {
    graph: {},
    rootGraph: {}, // no _nodes array: unreadable, not "empty"
    activeWorkflow: {
      isModified: false,
      changeTracker: { activeState: { nodes: nodes(expectedNodeCount) } },
    },
    activeWorkflowUuid: "workflow-A",
    liveNodeCount: 0,
    inSubgraph: false,
    rootUuidMismatch: false,
  };
}

// What a READ tool asks for inside its own executor (graph_outline, graph_get_errors).
const READ_EXECUTOR_BAR = { includeBaselineReadGuard: true, requireDirtyMutationBinding: false };

const MUTATING_GRAPH_COMMANDS = [
  "graph_add_node",
  "graph_remove_node",
  "graph_connect",
  "graph_set_widget",
  "graph_edit_node",
  "graph_move_node",
  "graph_clear",
  "graph_load",
  "graph_run",
  "graph_future_command", // unknown commands fail closed as mutations
];

test("#604: a mutation may never clear a LOWER binding bar than a read", () => {
  const evidence = halfRebuiltRootEvidence(3);

  const readVerdict = resolveGraphBindingVerdict({ ...evidence, ...READ_EXECUTOR_BAR });
  assert.ok(readVerdict, "graph_outline refuses this canvas — that is the #389/#604 read guard");
  assert.equal(readVerdict.reason, "root-node-count-desync");

  for (const cmd of MUTATING_GRAPH_COMMANDS) {
    const verdict = resolveGraphBindingVerdict({ ...evidence, ...graphCommandBindingBar(cmd) });
    assert.ok(
      verdict,
      `${cmd} must be refused on evidence a read refuses — this is #604: reads blocked, ` +
        `mutations still routed to the wrong canvas and deleted nodes from it`,
    );
    assert.equal(verdict.reason, "root-node-count-desync", `${cmd} must refuse for the READ guard's reason`);
    assert.equal(verdict.expected, 3, `${cmd} must report the workflow's own expected node count`);
  }
});

test("#604: every DIRECT mutation path (run, CivitAI load, snapshot capture/restore) uses the same full bar", () => {
  // Paths that skip bridge dispatch must not thereby skip evidence.
  assert.deepEqual(
    { ...MUTATION_BINDING_BAR },
    graphCommandBindingBar("graph_add_node"),
    "the shared constant must BE the dispatch mutation bar, not a weaker copy",
  );
  const verdict = resolveGraphBindingVerdict({ ...halfRebuiltRootEvidence(3), ...MUTATION_BINDING_BAR });
  assert.ok(verdict, "a direct mutation path must refuse the same evidence bridge dispatch refuses");
  assert.equal(verdict.reason, "root-node-count-desync");
});

test("graphCommandBindingBar: reads get the reduced DISPATCH bar (they re-assert with the full one)", () => {
  for (const cmd of ["graph_outline", "graph_query", "graph_get_state", "graph_screenshot"]) {
    assert.equal(graphCommandMayMutateWorkflow(cmd), false, `${cmd} must stay classified read-only`);
    assert.deepEqual(graphCommandBindingBar(cmd), {
      includeBaselineReadGuard: false,
      requireDirtyMutationBinding: false,
    });
  }
});

test("availability: the raised mutation bar never refuses a genuinely EMPTY workflow", () => {
  // Same unreadable root, but the workflow's own current state reports zero nodes:
  // there is nothing to be out of sync WITH, so no command may be refused.
  const evidence = {
    ...halfRebuiltRootEvidence(0),
    activeWorkflow: { isModified: false, changeTracker: { activeState: { nodes: [] } } },
  };
  assert.equal(resolveGraphBindingVerdict({ ...evidence, ...READ_EXECUTOR_BAR }), null);
  for (const cmd of MUTATING_GRAPH_COMMANDS) {
    assert.equal(
      resolveGraphBindingVerdict({ ...evidence, ...graphCommandBindingBar(cmd) }),
      null,
      `${cmd} must stay available on a genuinely empty workflow`,
    );
  }
});

test("availability: the raised mutation bar never refuses a DIRTY canvas whose root is positively tagged", () => {
  // The #545 case: ChangeTracker lags the user's real canvas, so its node count is
  // not evidence — a positive root/active UUID match is what authorizes the edit.
  const rootGraph = { _nodes: nodes(5), extra: { comfyui_mcp: { workflow_uuid: "workflow-A" } } };
  const evidence = {
    graph: rootGraph,
    rootGraph,
    activeWorkflow: { isModified: true, changeTracker: { activeState: { nodes: nodes(9) } } },
    activeWorkflowUuid: "workflow-A",
    liveNodeCount: 5,
    inSubgraph: false,
    rootUuidMismatch: false,
  };
  for (const cmd of MUTATING_GRAPH_COMMANDS) {
    assert.equal(
      resolveGraphBindingVerdict({ ...evidence, ...graphCommandBindingBar(cmd) }),
      null,
      `${cmd} must remain available on a proven dirty canvas (#545)`,
    );
  }
});

test("availability: the raised mutation bar never fires inside a SUBGRAPH scope", () => {
  const evidence = { ...halfRebuiltRootEvidence(3), inSubgraph: true };
  for (const cmd of MUTATING_GRAPH_COMMANDS) {
    assert.equal(
      resolveGraphBindingVerdict({ ...evidence, ...graphCommandBindingBar(cmd) }),
      null,
      `${cmd} inside a descended subgraph must not be refused by a ROOT node-count comparison`,
    );
  }
});

// ---------------------------------------------------------------------------
// The refusal TEXT must state the reason and must not overclaim
// ---------------------------------------------------------------------------

test("the refusal message names the firing predicate and claims only 'NOT applied'", () => {
  const msg = graphBindingRefusalMessage({ reason: "root-node-count-desync", expected: 3 });
  assert.match(msg, /^\[root-node-count-desync\]/, "a verdict with a cause must state the cause (#565)");
  assert.match(msg, /the workflow reports 3 node\(s\)/);
  assert.match(msg, /was NOT applied/, "callers assert BEFORE any work — that is what makes this claim true");

  const empty = graphBindingRefusalMessage({ reason: "empty-binding-unproven", expected: 0 });
  assert.match(empty, /^\[empty-binding-unproven\]/);
  assert.match(empty, /FALSE-EMPTY/, "an unproven empty read must not become a definite 'empty' verdict");

  assert.equal(graphBindingRefusalMessage(null), null, "no verdict ⇒ no message");
});
