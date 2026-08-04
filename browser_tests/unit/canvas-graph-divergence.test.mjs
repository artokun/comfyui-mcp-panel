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
  graphRootMatchesState,
  graphRootWorkflowUuidMatches,
  resolveGraphBindingVerdict,
  MUTATION_BINDING_BAR,
} from "../../web/js/lib/graph-binding.js";
import { describeRevertOutcome } from "../../web/js/lib/graph-revert.js";

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

/** restoreSnapshot PLUS the canvas-interaction lock and load-deadline machinery it
 *  closes over, so both fences under test are the REAL ones rather than stubs that
 *  could drift from them. */
function restoreSnapshotSource(src) {
  const start = src.indexOf("// ---- the canvas interaction lock, as a fence with an OWNER");
  assert.notEqual(start, -1, "could not locate the canvas interaction lock");
  const end = panelFunctionStart(src, "revertGraphToLastSnapshot", start + 1);
  assert.ok(end > start);
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
 *  (the same members resolveRailNode reads). `serialize` is present so the
 *  content-free proof can actually be evaluated — without it the graph is
 *  unprovable and fails closed, which is asserted separately. */
function subgraphObject({ nodes: inner = [] } = {}) {
  const sub = {
    name: "sub",
    inputNode: { id: SUBGRAPH_INPUT_RAIL_ID },
    outputNode: { id: SUBGRAPH_OUTPUT_RAIL_ID },
    inputs: [],
    outputs: [],
    _nodes: inner,
  };
  sub.serialize = () => ({ nodes: inner.map((n) => ({ ...n })) });
  return sub;
}

/** An `app` whose canvas points at `canvasGraph`; setGraph is COUNTED because
 *  calling it at all is the destructive act under test. `setGraph` models the three
 *  real outcomes: "ok" (rebinds), "throw" (a reconnect-time failure), "missing"
 *  (older frontends that never exposed it), and "noop" (accepts and does nothing). */
function makeApp({ rootGraph, canvasGraph, setGraph = "ok" }) {
  const canvas = {
    graph: canvasGraph ?? rootGraph,
    setGraphCalls: 0,
    setDirty() {},
    /** A hand edit, gated the way LiteGraph gates one. Returns whether it landed. */
    userEdit(node) {
      if (!this.allow_interaction) return false;
      this.graph?._nodes?.push(node);
      return true;
    },
  };
  if (setGraph !== "missing") {
    canvas.setGraph = function (g) {
      this.setGraphCalls += 1;
      if (setGraph === "throw") throw new Error("canvas is mid-reconnect");
      if (setGraph === "noop") return;
      this.graph = g;
    };
  }
  // LiteGraph's own gate for hand editing. workflow_open freezes it across its
  // destructive await; the restore must too, or a hand edit landing mid-load is
  // overwritten when the load settles. Backed by an accessor that RECORDS every
  // write: asserting the end value alone cannot tell "froze then restored" from
  // "never touched it", so a deleted freeze would satisfy it.
  let interaction = true;
  canvas.interactionWrites = [];
  // `lockWrites: "throw"` models a read-only property or a throwing setter — the
  // case where the freeze does NOT happen even though the property reads boolean.
  canvas.lockWrites = "ok";
  Object.defineProperty(canvas, "allow_interaction", {
    get: () => interaction,
    set(value) {
      if (canvas.lockWrites === "throw") throw new TypeError("allow_interaction is read-only");
      canvas.interactionWrites.push(value);
      interaction = value;
    },
    configurable: true,
    enumerable: true,
  });
  return { graph: rootGraph, canvas };
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

test("#220/#308 regression fence: a PROVABLY EMPTY ghost subgraph still reconciles to root", () => {
  // A subgraph the REBUILT root neither owns via an owner node nor registers, and
  // which provably holds nothing — the one case a repaint can lose nothing.
  const rootGraph = { _nodes: [{ id: 1, type: "Node" }] };
  const ghost = subgraphObject();
  const scope = resolveScope(makeApp({ rootGraph, canvasGraph: ghost }));

  assert.equal(scope.stale, true, "the #220/#308 reconcile must survive for an empty ghost");
  assert.equal(scope.diverged, false);
  assert.equal(scope.graph, rootGraph, "reads and edits both land on the live root");
});

test("#604: a ghost SUBGRAPH holding content is a divergence too — kind never overrides content", () => {
  // The P0 the first cut of this fix missed: "unreachable from the live root"
  // proves only that the root does not own the graph — never that it is
  // disposable. A stranded subgraph can hold the user's unsaved work exactly like
  // a stranded root, and repainting it away is the same unrecoverable loss.
  const rootGraph = { _nodes: [{ id: 1, type: "Node" }] };
  const ghost = subgraphObject({ nodes: nodes(2, 100) });
  const app = makeApp({ rootGraph, canvasGraph: ghost });
  const scope = resolveScope(app);

  assert.equal(scope.diverged, true, "a content-bearing ghost is unresolvable, not disposable");
  assert.equal(scope.stale, false, "the repaint trigger must stay disarmed");
  assert.equal(scope.divergedKind, "subgraph");
  assert.equal(scope.graph, ghost, "the graph the user is looking at is what gets reported");

  assert.throws(() => buildGetGraphCtx(app)(), /\[canvas-root-divergence\]/);
  assert.equal(app.canvas.setGraphCalls, 0, "the ghost's contents must remain reachable to the user");
  assert.equal(app.canvas.graph, ghost);
});

test("#604: the subgraph divergence offers the escape that actually applies to it", () => {
  const app = makeApp({
    rootGraph: { _nodes: nodes(1) },
    canvasGraph: subgraphObject({ nodes: nodes(2, 100) }),
  });
  let message = "";
  try {
    buildGetGraphCtx(app)();
  } catch (err) {
    message = err.message;
  }
  assert.match(message, /Leave the open subgraph/, "a stranded subgraph is escaped by leaving it");
  assert.match(message, /reload the ComfyUI page/, "with the page reload as the fallback");
});

test("#604: an unserializable ghost is NOT proven empty — unprovable fails closed", () => {
  const ghost = {
    inputNode: { id: SUBGRAPH_INPUT_RAIL_ID },
    outputNode: { id: SUBGRAPH_OUTPUT_RAIL_ID },
    _nodes: [],
  };
  const scope = resolveScope(makeApp({ rootGraph: { _nodes: nodes(1) }, canvasGraph: ghost }));
  assert.equal(
    scope.diverged,
    true,
    "a bare empty _nodes array is node-level evidence only — groups/links/nested subgraphs are unproven",
  );
  assert.equal(scope.stale, false);
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

test("#220/#308 regression fence: getGraphCtx still reconciles a PROVABLY EMPTY ghost to root", () => {
  const rootGraph = { _nodes: [{ id: 1, type: "Node" }] };
  const ghost = subgraphObject();
  const app = makeApp({ rootGraph, canvasGraph: ghost });
  const ctx = buildGetGraphCtx(app)();

  assert.equal(ctx.graph, rootGraph);
  assert.equal(app.canvas.setGraphCalls, 1, "the ghost view is reconciled so reads and edits stay in lockstep");
  assert.equal(app.canvas.graph, rootGraph);
});

// An ATTEMPTED repaint is not a repaint. setGraph is optional on older frontends and
// can throw during a reconnect; swallowing that and returning the root anyway
// resolved commands onto a graph the user is provably NOT looking at — the same
// wrong-canvas outcome by a different route (e.g. graph_clear emptying the bound
// root while the user still sees the ghost).
for (const [label, setGraph] of [
  ["throws", "throw"],
  ["is unavailable on this frontend", "missing"],
  ["accepts but does not rebind", "noop"],
]) {
  test(`#604: an empty ghost whose canvas rebind ${label} is REFUSED, not silently resolved to root`, () => {
    const rootGraph = { _nodes: [{ id: 1, type: "Node" }] };
    const ghost = subgraphObject();
    const app = makeApp({ rootGraph, canvasGraph: ghost, setGraph });

    assert.throws(
      () => buildGetGraphCtx(app)(),
      /\[canvas-root-divergence\][\s\S]*could not confirm it/,
      "an unconfirmed rebind leaves the divergence in place and must be refused like one",
    );
    assert.equal(app.canvas.graph, ghost, "the user is still looking at the ghost — say so, don't act");
  });
}

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

test("#604: EVERY direct mutation path clears the same full bar bridge dispatch demands", () => {
  // The shared constant must BE the dispatch mutation bar, not a weaker copy…
  assert.deepEqual(
    { ...MUTATION_BINDING_BAR },
    graphCommandBindingBar("graph_add_node"),
    "a direct path must not get a different bar from a dispatched mutation",
  );
  const verdict = resolveGraphBindingVerdict({ ...halfRebuiltRootEvidence(3), ...MUTATION_BINDING_BAR });
  assert.ok(verdict, "…and it must refuse the same evidence bridge dispatch refuses");
  assert.equal(verdict.reason, "root-node-count-desync");

  // …and every path that bypasses bridge dispatch must actually USE it. Each of
  // these invokes a graph mutation without going through the dispatch fence: the
  // panel's Run button (/run), the CivitAI workflow picker's graph_load, the
  // per-turn snapshot capture and its revert, and the deferred add-node
  // revalidation after an awaited node-definition fetch. Skipping dispatch must
  // not mean skipping evidence, so each is checked at its own call site.
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const DIRECT_MUTATION_PATHS = [
    ["async graph_run({ batch_count, to_node_id })", "app.queuePrompt"],
    ["async graph_load({ graph: incoming } = {})", 'captureGraphSnapshot(null, "before graph_load")'],
    ["function captureGraphSnapshot(mid, label)", "const data = rootGraph.serialize();"],
    ["function restoreSnapshot(snap)", "payload = JSON.parse(JSON.stringify(snap.data))"],
    ["function revalidateGraphMutationContext(captured)", "return current;"],
  ];
  for (const [startNeedle, beforeNeedle] of DIRECT_MUTATION_PATHS) {
    const start = src.indexOf(startNeedle);
    assert.notEqual(start, -1, `${startNeedle} must exist`);
    const before = src.indexOf(beforeNeedle, start);
    assert.notEqual(before, -1, `${beforeNeedle} must follow ${startNeedle}`);
    const fence = src.indexOf("assertGraphBoundToActiveWorkflow(", start);
    assert.ok(
      fence > start && fence < before,
      `${startNeedle} must assert the binding BEFORE it acts`,
    );
    assert.match(
      src.slice(fence, before),
      /\.\.\.MUTATION_BINDING_BAR/,
      `${startNeedle} bypasses bridge dispatch, so it must name the full mutation bar itself`,
    );
  }
});

// ---------------------------------------------------------------------------
// The recovery path: the refusal must reach the user who is trying to recover
// ---------------------------------------------------------------------------

test("#604: /revert during a divergence REFUSES with the remedy — it must not claim there was no snapshot", async () => {
  // The whole timeline, end to end: a snapshot was captured while the binding was
  // sound → a backend restart leaves the canvas on the unsaved 31-node graph while
  // app.graph is empty → the user reaches for /revert. getGraphCtx refuses BEFORE
  // loadGraphData, which is correct; what must not happen is that refusal being
  // swallowed into "Nothing to revert — no graph snapshot captured in this session
  // yet." That is false, drops the remedy, and ends the recovery attempt.
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const restoreSource = restoreSnapshotSource(src);

  const rootGraph = { _nodes: [] };
  const canvasGraph = { _nodes: nodes(31) };
  const app = makeApp({ rootGraph, canvasGraph });
  const workflow = { isModified: false, changeTracker: { activeState: { nodes: nodes(31) } } };
  let loads = 0;

  const guard = makeReloadGuardStub();
  app.loadGraphData = () => {
    loads += 1; // never reached: getGraphCtx refuses first
  };
  const restoreSnapshot = buildRestoreSnapshot({
    restoreSource,
    app, // buildGetGraphCtx over it is the REAL resolver — it refuses the divergence
    activeWorkflowRef: () => workflow,
    guard,
  });

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(12) } });

  assert.equal(outcome.status, "refused", "a snapshot EXISTS — the answer is 'refused', never 'none'");
  assert.match(outcome.reason, /canvas-root-divergence/, "the refusal must carry the reason code");
  assert.equal(loads, 0, "and nothing may be loaded onto a canvas the panel cannot identify");
  assert.equal(app.canvas.setGraphCalls, 0, "nor may the user's 31-node canvas be repainted away");

  // What the user actually sees.
  const line = describeRevertOutcome(outcome, {
    action: "revert",
    restoredText: "Reverted.",
    noneText: "Nothing to revert — no graph snapshot captured in this session yet.",
  });
  assert.doesNotMatch(line, /Nothing to revert/, "the exact regression this guards");
  assert.match(line, /reload the ComfyUI page/, "the remedy survives to the person who needs it");
});

/** A faithful stand-in for the panel's #442 reload-guard section: the real one is
 *  module state, and the restore now takes it so a bridge command cannot land
 *  mid-load. `held` lets a test pretend a workflow switch already owns it. */
function makeReloadGuardStub({ held = null } = {}) {
  let guard = held;
  let seq = 0;
  return {
    calls: [],
    activeWorkflowReloadGuard: () => guard,
    acquireWorkflowReloadGuard(key) {
      const token = ++seq;
      guard = { token, key, since: Date.now(), pending: 0 };
      this.calls.push(`acquire:${key}`);
      return token;
    },
    beginWorkflowReloadStep(token) {
      if (!guard || guard.token !== token) return false;
      guard.pending += 1;
      this.calls.push("begin");
      return true;
    },
    endWorkflowReloadStep(token) {
      if (guard && guard.token === token && guard.pending > 0) guard.pending -= 1;
      this.calls.push("end");
    },
    releaseWorkflowReloadGuard(token) {
      if (guard && guard.token === token) guard = null;
      this.calls.push("release");
    },
    get current() {
      return guard;
    },
    /** Model another operation TAKING OVER the section. acquireWorkflowReloadGuard
     *  overwrites unconditionally — workflow_open does exactly that — so a holder
     *  can lose its section without its own release ever running. */
    takeOver() {
      guard = null;
    },
  };
}

/** The real restoreSnapshot over a sound binding, with an injectable loader.
 *  `applies` models whether the frontend's load ACTUALLY lands the payload on the
 *  root — the default is a faithful frontend that does; pass false for one that
 *  resolves without applying (which resolution alone can never rule out). */
function buildSoundRestoreSnapshot(
  loadGraphData,
  { guard = makeReloadGuardStub(), applies = true, deadlineMs = 5000 } = {},
) {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const restoreSource = restoreSnapshotSource(src);
  // A live root that serializes to whatever was last loaded into it, which is what
  // the post-load proof reads. Starts as the pre-revert canvas.
  let live = { nodes: nodes(12), links: [] };
  const rootGraph = {
    _nodes: nodes(12),
    extra: {},
    serialize: () => JSON.parse(JSON.stringify(live)),
  };
  const app = makeApp({ rootGraph, canvasGraph: rootGraph });
  const workflow = { isModified: false, changeTracker: { activeState: { nodes: nodes(12) } } };
  // `undefined` models a frontend that never exposed loadGraphData at all — the
  // wrapper must not paper over that, since it is one of the pre-load refusals.
  if (loadGraphData) {
    app.loadGraphData = (payload, ...rest) => {
      const result = loadGraphData(payload, ...rest);
      // A real load lands `extra` (including the panel's identity stamp) on the live
      // root, which is where graphRootWorkflowUuidMatches reads it, AND lands the
      // content. "identity-only" models a frontend that takes the stamp but does not
      // faithfully install the graph, so the CONTENT check is what has to catch it.
      if (applies === true || applies === "identity-only") {
        rootGraph.extra = JSON.parse(JSON.stringify(payload.extra ?? {}));
      }
      if (applies === true || applies === "content-only") live = JSON.parse(JSON.stringify(payload));
      // "content-only" models the A->B->A window: the canvas ends up holding a graph
      // whose CONTENT matches the snapshot, but it is not carrying the identity this
      // restore stamped — a different tab's same-shaped canvas.
      if (applies === "content-only") rootGraph.extra = { comfyui_mcp: { workflow_uuid: "some-other-tab" } };
      return result;
    };
  }
  const restoreSnapshot = buildRestoreSnapshot({
    restoreSource,
    app,
    activeWorkflowRef: () => workflow,
    guard,
    deadlineMs,
  });
  return { restoreSnapshot, workflow, guard, app, rootGraph };
}

/** Wire the extracted restoreSnapshot to its collaborators. Identity is modelled
 *  the way the panel does it: a stable per-instance uuid the stamp/read pair agree
 *  on, so the post-load identity proof is exercised rather than stubbed out. */
function buildRestoreSnapshot({ restoreSource, app, activeWorkflowRef, guard, deadlineMs = 5000 }) {
  const uuids = new WeakMap();
  const uuidCalls = [];
  let seq = 0;
  // Models the real workflowStableUuid's `embed` STEP — the option whose job is to
  // write the uuid into the workflow's own `extra`, where it rides the next save.
  // It deliberately does NOT model the real helper's unsaved branch, which persists
  // a freshly-minted id even without the option (#570 durability); that is
  // pre-existing behaviour shared with every graph command and is not what these
  // tests are about. Calls are recorded so a test can assert the call HAPPENED and
  // with what options, rather than inferring it from an absence.
  const stableUuid = (wf, { embed = false } = {}) => {
    uuidCalls.push({ wf, embed });
    if (!wf || typeof wf !== "object") return null;
    if (!uuids.has(wf)) uuids.set(wf, `wf-uuid-${++seq}`);
    const id = uuids.get(wf);
    if (embed) {
      wf.extra = { ...(wf.extra ?? {}), comfyui_mcp: { workflow_uuid: id } };
    }
    return id;
  };
  const built = new Function(
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
    "graphRootMatchesState",
    "graphRootWorkflowUuidMatches",
    "workflowStableUuid",
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_UUID_FIELD",
    // The ONLY consumer of setTimeout inside the extracted slice is the load
    // deadline, so shadowing it here rescales just that — the tests drive the real
    // bounded-load code instead of sleeping out its 15s production budget.
    "setTimeout",
    // The lock helpers ride out too, so a test can model a CONCURRENT holder
    // (workflow_open) taking the canvas while a timed-out revert is still live.
    `${restoreSource}\nreturn { restoreSnapshot, acquireCanvasInteractionLock, releaseCanvasInteractionLock };`,
  )(
    buildGetGraphCtx(app),
    activeWorkflowRef,
    () => {},
    MUTATION_BINDING_BAR,
    (v) => String(v ?? ""),
    () => guard.activeWorkflowReloadGuard(),
    (key) => guard.acquireWorkflowReloadGuard(key),
    (token) => guard.beginWorkflowReloadStep(token),
    (token) => guard.endWorkflowReloadStep(token),
    (token) => guard.releaseWorkflowReloadGuard(token),
    graphRootMatchesState,
    graphRootWorkflowUuidMatches,
    stableUuid,
    "comfyui_mcp",
    "workflow_uuid",
    (fn) => setTimeout(fn, deadlineMs),
  );
  const { restoreSnapshot } = built;
  restoreSnapshot.uuidCalls = uuidCalls;
  restoreSnapshot.acquireCanvasInteractionLock = built.acquireCanvasInteractionLock;
  restoreSnapshot.releaseCanvasInteractionLock = built.releaseCanvasInteractionLock;
  return restoreSnapshot;
}

test("#604: a sound binding still reverts — the recovery path is not simply disabled", async () => {
  let loaded = null;
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot((data) => {
    loaded = data;
  });

  const snap = { workflowRef: workflow, data: { nodes: nodes(3) }, label: "before your last message" };
  const outcome = await restoreSnapshot(snap);
  assert.equal(outcome.status, "restored");
  assert.equal(outcome.snapshot, snap);
  assert.deepEqual(loaded?.nodes, snap.data.nodes, "the snapshot actually reached loadGraphData");
  assert.ok(
    loaded?.extra?.comfyui_mcp?.workflow_uuid,
    "and it carries the identity stamp the post-load proof will demand back",
  );
  assert.equal(snap.data.extra, undefined, "the STORED snapshot is not mutated by the stamp");
});

test("#604: a load that THROWS is disclosed as failed — never as 'nothing to revert'", async () => {
  // The binding was sound and loadGraphData was CALLED, so the canvas may be
  // partly changed. This is the disclose case, not the refuse case: reporting
  // "nothing happened" would invite a retry on top of a half-applied load.
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(() => {
    throw new Error("loadGraphData blew up mid-configure");
  });

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3) } });
  assert.equal(outcome.status, "failed", "the action was STARTED — that is not 'none'");
  assert.match(outcome.reason, /blew up mid-configure/, "carry what went wrong");

  const line = describeRevertOutcome(outcome, {
    action: "revert",
    restoredText: "Reverted.",
    noneText: "Nothing to revert — no graph snapshot captured in this session yet.",
  });
  assert.doesNotMatch(line, /Nothing to revert/);
  assert.match(line, /canvas may have changed/, "tell the user to check the canvas before retrying");
});

test("#604: a load that REJECTS is disclosed as failed too — loadGraphData is ASYNC", async () => {
  // The reachable form of the case above on current frontends: loadGraphData
  // returns a promise, and the panel's own creation-boundary wrapper preserves it.
  // Un-awaited, a load that started, changed the canvas in part, and then rejected
  // returned "restored" — every consumer reported success (rewind even said "canvas
  // reverted") over a half-applied load, and the rejection escaped unhandled.
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(
    () => Promise.reject(new Error("configure rejected after partial apply")),
  );

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3) } });
  assert.equal(
    outcome.status,
    "failed",
    "an async rejection must reach the failed branch, not be reported as a successful revert",
  );
  assert.match(outcome.reason, /partial apply/);
});

test("#604: the restore HOLDS the reload section across its await", async () => {
  // The restore is an async destructive load, and the bridge refuses graph commands
  // while the #442 section is held. Without it an agent command arriving during the
  // await is accepted and ACKNOWLEDGED, then erased when the load settles — the
  // data-loss shape that section exists to close.
  // Sampled INSIDE the load — the guard object is mutated in place, so a saved
  // reference would read post-settle values.
  let keyDuringLoad = null;
  let pendingDuringLoad = null;
  const guard = makeReloadGuardStub();
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(
    () =>
      new Promise((resolve) => {
        keyDuringLoad = guard.current?.key ?? null;
        pendingDuringLoad = guard.current?.pending ?? null;
        setTimeout(resolve, 1);
      }),
    { guard },
  );

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3) } });
  assert.equal(outcome.status, "restored");
  assert.equal(keyDuringLoad, "graph-revert", "the section must be HELD while loadGraphData is in flight");
  assert.equal(pendingDuringLoad, 1, "and marked in-flight so it cannot age out mid-load");
  assert.equal(guard.current, null, "and released once the load settles");
});

test("#604: a HAND edit cannot land during the restore's destructive await", async () => {
  // The section fences the BRIDGE; this fences the USER. Both halves of the same
  // window: an edit made while loadGraphData is in flight is silently overwritten
  // when the load settles, which is the unsaved-work loss this whole change exists
  // to stop — arriving through the window that making the path async opened.
  // workflow_open already freezes allow_interaction for exactly this reason.
  let editLanded = null;
  let frozenDuringLoad = null;
  const guard = makeReloadGuardStub();
  const { restoreSnapshot, workflow, app } = buildSoundRestoreSnapshot(
    () =>
      new Promise((resolve) => {
        frozenDuringLoad = app.canvas.allow_interaction;
        editLanded = app.canvas.userEdit({ id: 999, type: "HandAdded" });
        setTimeout(resolve, 1);
      }),
    { guard },
  );

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3), links: [] } });
  assert.equal(outcome.status, "restored");
  assert.equal(frozenDuringLoad, false, "canvas interaction must be FROZEN across the await");
  assert.equal(editLanded, false, "so a hand edit is refused rather than silently clobbered");
  assert.equal(app.canvas.allow_interaction, true, "and the freeze is lifted once the load settles");
});

test("#604: the canvas freeze is lifted even when the load FAILS", async () => {
  // A throw must never leave the user unable to touch their own canvas. The freeze
  // is sampled INSIDE the load, so this fails both if the freeze never happens and
  // if it is never lifted — asserting the end state alone would pass with the whole
  // freeze deleted, since the canvas starts unfrozen.
  let frozenDuringLoad = null;
  const failing = buildSoundRestoreSnapshot(() => {
    frozenDuringLoad = failing.app.canvas.allow_interaction;
    return Promise.reject(new Error("nope"));
  });
  const failed = await failing.restoreSnapshot({ workflowRef: failing.workflow, data: { nodes: nodes(3) } });
  assert.equal(failed.status, "failed");
  assert.equal(frozenDuringLoad, false, "the load ran inside the freeze");
  assert.equal(failing.app.canvas.allow_interaction, true, "and a failed load must not wedge the canvas");
});

// An explicit timeout so REMOVING the bounded load fails this test instead of
// hanging the suite: an unbounded restore never resolves, and a hang is a much
// worse signal than a failure.
test(
  "#604: a load past its deadline KEEPS the fences — releasing one while the writer is live cannot be made safe",
  { timeout: 5000 },
  async () => {
    // The panel cannot cancel a loadGraphData once it is running. The deadline
    // therefore bounds how long the CALLER waits, never how long the canvas is
    // protected: releasing the freeze here would hand the canvas back, let a hand
    // edit land, and then let the original load overwrite it — the silent loss this
    // whole change exists to stop, introduced by the deadline meant to help.
    let releaseHungLoad;
    const hung = new Promise((resolve) => {
      releaseHungLoad = resolve;
    });
    const guard = makeReloadGuardStub();
    const { restoreSnapshot, workflow, app } = buildSoundRestoreSnapshot(() => hung, {
      guard,
      deadlineMs: 5,
    });
    app.canvas.interactionWrites.length = 0;

    const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3), links: [] } });

    assert.equal(outcome.status, "failed", "unfinished ⇒ disclose; never 'restored', never 'none'");
    assert.match(outcome.reason, /did not finish within/);
    assert.match(outcome.reason, /has NOT been cancelled/, "say the writer is still live");
    assert.match(outcome.reason, /canvas stays locked/, "and that the fences are deliberately held");
    assert.match(outcome.reason, /unlock by themselves the moment it finishes/, "and when they lift");
    assert.match(outcome.reason, /reload the ComfyUI page/, "with a remedy if it never does");

    // THE POINT: the caller has its answer, and the fences are still up.
    assert.deepEqual(app.canvas.interactionWrites, [false], "frozen, and NOT released while the load lives");
    assert.equal(app.canvas.allow_interaction, false);
    assert.equal(app.canvas.userEdit({ id: 42, type: "HandAdded" }), false, "so a hand edit still cannot land");
    assert.ok(guard.current, "and graph commands stay fenced too");

    // …and they lift by themselves once the writer finally finishes.
    releaseHungLoad();
    await hung;
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(app.canvas.interactionWrites, [false, true], "released when the load settles, not before");
    assert.equal(guard.current, null, "and the section with it");
  },
);

test(
  "#604: a late-settling revert must not unlock the canvas under a workflow_open that is still loading",
  { timeout: 5000 },
  async () => {
    // The reason the still-running tracker is not dead code is the same reason this
    // matters: acquireWorkflowReloadGuard OVERWRITES, so a timed-out revert can lose
    // its section to a workflow_open while its own load is still live. If the revert
    // then settles FIRST and restores its saved `true`, it unlocks the canvas in the
    // middle of the open's reload — a hand edit lands and the newer load overwrites
    // it. A fence may only be released by its current owner.
    let releaseHungLoad;
    const hung = new Promise((resolve) => {
      releaseHungLoad = resolve;
    });
    const guard = makeReloadGuardStub();
    const { restoreSnapshot, workflow, app } = buildSoundRestoreSnapshot(() => hung, {
      guard,
      deadlineMs: 5,
    });
    app.canvas.interactionWrites.length = 0;

    const timedOut = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3), links: [] } });
    assert.equal(timedOut.status, "failed");
    assert.equal(app.canvas.allow_interaction, false, "the revert's freeze is holding");

    // A workflow_open now takes over: it overwrites the section and takes the canvas
    // lock through the SAME owned helper the panel uses.
    guard.takeOver();
    const openToken = restoreSnapshot.acquireCanvasInteractionLock(app.canvas);
    assert.ok(openToken, "the open takes the lock too");

    // …and the revert's load finally lands, releasing what IT thinks it owns.
    releaseHungLoad();
    await hung;
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(
      app.canvas.allow_interaction,
      false,
      "THE POINT: the canvas stays locked — the open is still loading and did not release it",
    );
    assert.equal(
      app.canvas.userEdit({ id: 77, type: "HandAdded" }),
      false,
      "so a hand edit still cannot land into the open's load",
    );

    // Only when the open itself releases does the canvas reopen, to the value from
    // before the FIRST freeze.
    restoreSnapshot.releaseCanvasInteractionLock(openToken, app.canvas);
    assert.equal(app.canvas.allow_interaction, true, "the last holder out reopens it");
  },
);

test("#604: a freeze that THROWS registers no holder — the lock cannot be owned forever", async () => {
  // The rule that killed boxWritten: do not record that you did something before
  // you did it. Registering the holder before the write is a CLAIM that the freeze
  // happened; if the write then throws, nobody holds the token and nobody ever
  // releases it, so the orphan keeps the count nonzero and the NEXT canvas is
  // permanently locked with nothing running. Giving the lock an owner is exactly
  // what created a way to own it forever.
  let loads = 0;
  const { restoreSnapshot, workflow, app } = buildSoundRestoreSnapshot(() => {
    loads += 1;
  });
  app.canvas.lockWrites = "throw";

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3), links: [] } });
  assert.equal(outcome.status, "refused", "a freeze that did not happen is no fence at all");
  assert.match(outcome.reason, /does not expose a canvas interaction lock/);
  assert.equal(loads, 0, "and the destructive load never ran");

  // THE POINT: no orphan holder survived. Prove it through a FRESH canvas — a
  // leaked holder would keep the count nonzero and make this release a no-op.
  const fresh = makeApp({ rootGraph: { _nodes: [] } }).canvas;
  const token = restoreSnapshot.acquireCanvasInteractionLock(fresh);
  assert.ok(token, "a healthy canvas can still be frozen");
  assert.equal(fresh.allow_interaction, false);
  assert.equal(
    restoreSnapshot.releaseCanvasInteractionLock(token, fresh),
    true,
    "and its release is the LAST one out — no stale holder is still counted",
  );
  assert.equal(fresh.allow_interaction, true, "so the new canvas returns to interactive");
});

test("#604: a release whose restore write throws still drops the claim", async () => {
  // The mirror case. A dead canvas staying frozen is unavoidable; keeping its holder
  // registered would be strictly worse — it would lock out every later canvas too.
  const { restoreSnapshot } = buildSoundRestoreSnapshot(() => {});
  const dying = makeApp({ rootGraph: { _nodes: [] } }).canvas;
  const token = restoreSnapshot.acquireCanvasInteractionLock(dying);
  assert.ok(token);
  dying.lockWrites = "throw"; // the canvas goes away mid-section
  assert.equal(restoreSnapshot.releaseCanvasInteractionLock(token, dying), true);

  const fresh = makeApp({ rootGraph: { _nodes: [] } }).canvas;
  const next = restoreSnapshot.acquireCanvasInteractionLock(fresh);
  assert.equal(restoreSnapshot.releaseCanvasInteractionLock(next, fresh), true);
  assert.equal(fresh.allow_interaction, true, "the dead canvas's claim did not outlive it");
});

test("#604: a frontend with no interaction lock is REFUSED, not run unfenced", async () => {
  // Without allow_interaction there is no way to stop a hand edit landing mid-load,
  // and the load would overwrite it. Claiming the fence is there when it cannot be
  // established is the fabrication; workflow_open sets the precedent by gating its
  // own destructive re-read on the same condition.
  let loads = 0;
  const { restoreSnapshot, workflow, app } = buildSoundRestoreSnapshot(() => {
    loads += 1;
  });
  delete app.canvas.allow_interaction; // frontend without the lock

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3), links: [] } });
  assert.equal(outcome.status, "refused", "no fence ⇒ do not run the destructive await at all");
  assert.match(outcome.reason, /does not expose a canvas interaction lock/);
  assert.match(outcome.reason, /silently overwritten/, "say what the missing fence would cost");
  assert.equal(loads, 0, "and nothing was loaded");
});

test("#604: a restore is REFUSED while an earlier load is still running past its deadline", async () => {
  // Belt and braces alongside the held section: the tracker is what still refuses a
  // second restore if the section were ever released first, so a load that outran
  // its deadline can never be the one that lands last.
  // ONE builder: the still-running load is module state in the real panel, so all
  // three attempts must share a single extracted scope. The loader switches
  // behaviour between calls instead.
  let releaseHungLoad;
  const hung = new Promise((resolve) => {
    releaseHungLoad = resolve;
  });
  let hang = true;
  let laterLoads = 0;
  const { restoreSnapshot, workflow, guard } = buildSoundRestoreSnapshot(
    () => {
      if (hang) return hung;
      laterLoads += 1;
      return undefined;
    },
    { deadlineMs: 5 },
  );
  const snapshot = { workflowRef: workflow, data: { nodes: nodes(3), links: [] } };

  const timedOut = await restoreSnapshot(snapshot);
  assert.equal(timedOut.status, "failed");
  hang = false;

  // While the timed-out load holds the section, that alone refuses a second restore.
  const bySection = await restoreSnapshot(snapshot);
  assert.equal(bySection.status, "refused");
  assert.match(bySection.reason, /switching or reloading/);

  // The tracker is the backstop for when the section is NOT enough:
  // acquireWorkflowReloadGuard overwrites unconditionally (workflow_open does that),
  // so a holder can lose its section while its load is still live. Then only the
  // tracker stands between "the earlier load lands last" and a silent overwrite.
  guard.takeOver();
  const byTracker = await restoreSnapshot(snapshot);
  assert.equal(byTracker.status, "refused", "the earlier load could still land last");
  assert.match(byTracker.reason, /STILL running/);
  assert.equal(laterLoads, 0, "and nothing was loaded on top of it");

  // …and once the abandoned load finally settles, restores work again.
  releaseHungLoad();
  await hung;
  await Promise.resolve();
  const ok = await restoreSnapshot(snapshot);
  assert.equal(ok.status, "restored", "the block is released when the load finishes, not permanent");
  assert.equal(laterLoads, 1);
});

test("#604: a refusal does not touch canvas interaction at all", async () => {
  // Asserted from the WRITE LOG, not the end value: "unchanged" is also what a
  // deleted freeze looks like. Paired with a SUCCESSFUL restore in the same test,
  // because an empty log on its own is satisfied by having no freeze at all.
  const guard = makeReloadGuardStub({ held: { token: 9, key: "wf:other.json", since: Date.now(), pending: 1 } });
  const refusedCase = buildSoundRestoreSnapshot(() => {}, { guard });
  refusedCase.app.canvas.interactionWrites.length = 0;
  const refused = await refusedCase.restoreSnapshot({
    workflowRef: refusedCase.workflow,
    data: { nodes: nodes(3) },
  });
  assert.equal(refused.status, "refused");
  assert.deepEqual(
    refusedCase.app.canvas.interactionWrites,
    [],
    "a refusal never froze, so it must not write to the flag at all — including un-freezing someone else's freeze",
  );

  // …and the freeze DOES exist, so the emptiness above means something.
  const ok = buildSoundRestoreSnapshot(() => {});
  ok.app.canvas.interactionWrites.length = 0;
  await ok.restoreSnapshot({ workflowRef: ok.workflow, data: { nodes: nodes(3), links: [] } });
  assert.deepEqual(ok.app.canvas.interactionWrites, [false, true], "a restore that RUNS does freeze");
});

test("#604: a successful restore returns interaction to its PRIOR value, not to true", async () => {
  let frozenDuringLoad = null;
  const held = buildSoundRestoreSnapshot(() => {
    frozenDuringLoad = held.app.canvas.allow_interaction;
  });
  held.app.canvas.allow_interaction = false; // already frozen by something else
  held.app.canvas.interactionWrites.length = 0;
  const outcome = await held.restoreSnapshot({
    workflowRef: held.workflow,
    data: { nodes: nodes(3), links: [] },
  });
  assert.equal(outcome.status, "restored");
  assert.equal(frozenDuringLoad, false);
  assert.deepEqual(
    held.app.canvas.interactionWrites,
    [false, false],
    "froze, then restored the PRIOR value — never assumed true",
  );
});

test("#604: a successful restore on an unfrozen canvas freezes and unfreezes exactly once", async () => {
  const open = buildSoundRestoreSnapshot(() => {});
  open.app.canvas.interactionWrites.length = 0;
  const outcome = await open.restoreSnapshot({
    workflowRef: open.workflow,
    data: { nodes: nodes(3), links: [] },
  });
  assert.equal(outcome.status, "restored");
  assert.deepEqual(open.app.canvas.interactionWrites, [false, true]);
});

test("#604: a restore is REFUSED while another switch/reload owns the section (single-flight)", async () => {
  // Covers both a workflow_open switch in progress AND a second /revert landing on
  // top of a first: racing two loads settles them out of user-action order.
  let loads = 0;
  const guard = makeReloadGuardStub({ held: { token: 99, key: "wf:other.json", since: Date.now(), pending: 1 } });
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(() => {
    loads += 1;
  }, { guard });

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3) } });
  assert.equal(outcome.status, "refused", "nothing was loaded — safe to retry");
  assert.match(outcome.reason, /wf:other\.json/, "name what is holding the section");
  assert.equal(loads, 0, "and do not race it");
});

test("#604: the section is released even when the load FAILS", async () => {
  const guard = makeReloadGuardStub();
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(
    () => Promise.reject(new Error("nope")),
    { guard },
  );
  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3) } });
  assert.equal(outcome.status, "failed");
  // The section must have been TAKEN and then let go. Asserting only that nothing
  // is held would also be satisfied by never taking it — the stub starts empty.
  assert.deepEqual(
    guard.calls,
    ["acquire:graph-revert", "begin", "end", "release"],
    "the section is taken across the load and released on the failure path",
  );
  assert.equal(guard.current, null, "a failed load must not wedge the section and block every graph command");
});

test("#604: a PRE-load failure is refused, not falsely disclosed as a partial apply", async () => {
  // loadGraphData missing on this frontend: the action never started, so claiming it
  // "was STARTED and did not finish" — and telling the user their canvas may be
  // partly changed — would be fabricated.
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(undefined);
  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3) } });
  assert.equal(outcome.status, "refused", "nothing ran ⇒ refused, never failed");
  assert.match(outcome.reason, /does not expose loadGraphData/);
});

test("#604: an unserializable snapshot is refused, not falsely disclosed as a partial apply", async () => {
  let loads = 0;
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(() => {
    loads += 1;
  });
  const circular = { nodes: [] };
  circular.self = circular; // JSON.parse(JSON.stringify(...)) throws
  const outcome = await restoreSnapshot({ workflowRef: workflow, data: circular });
  assert.equal(outcome.status, "refused", "the clone failed BEFORE the load — nothing was applied");
  assert.equal(loads, 0);
});

test("#604: an unreadable active workflow is REFUSED, not reported as 'no snapshot'", async () => {
  // There may well be snapshots in the ring — the panel just cannot read the active
  // workflow, so it cannot tell which of them belong to this canvas. Answering
  // "none" would be the same could-not-determine-becomes-a-verdict defect one level
  // up, and it is the answer that ends the user's recovery attempt.
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const source = panelFunctionSource(src, "revertGraphToLastSnapshot", "manualChangeBanner");
  const ring = [{ workflowRef: {}, data: { nodes: nodes(3) } }];
  let restores = 0;

  const revertGraphToLastSnapshot = new Function(
    "activeWorkflowRef",
    "graphSnapshots",
    "getGraphCtx",
    "pickRevertSnapshot",
    "restoreSnapshot",
    `${source}\nreturn revertGraphToLastSnapshot;`,
  )(
    () => null, // the workflow service cannot be read right now
    ring,
    () => ({ rootGraph: { serialize: () => ({ nodes: [] }) } }),
    (snaps) => snaps[snaps.length - 1],
    async () => {
      restores += 1;
      return { status: "restored" };
    },
  );

  const outcome = await revertGraphToLastSnapshot();
  assert.equal(outcome.status, "refused", "unknown scope ⇒ refused, never a definite 'none'");
  assert.match(outcome.reason, /cannot read the active workflow/);
  assert.match(outcome.reason, /Retry in a moment/, "and it clears on retry, so say so");
  assert.equal(restores, 0, "nothing may be loaded when the panel cannot scope the ring");
});

test("#604: a load that RESOLVES WITHOUT APPLYING is not reported as a successful revert", async () => {
  // The panel's own workflow_open code says it outright: a resolved load promise is
  // not a binding receipt — an old or partial frontend can resolve while leaving the
  // canvas on the previous root. Calling that "restored" would tell the user their
  // canvas was reverted when it was not, and the rollback modal would then rewind
  // the conversation and resend against it.
  let calls = 0;
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(
    () => {
      calls += 1;
    },
    { applies: false }, // resolves, changes nothing
  );

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3) } });
  assert.equal(calls, 1, "the load really was attempted");
  assert.equal(outcome.status, "failed", "unverifiable ⇒ disclose; never 'restored', never 'none'");
  assert.match(outcome.reason, /cannot confirm/);
  assert.match(outcome.reason, /Check the canvas/, "and tell them what to do about it");
});

test("#604: matching CONTENT on a canvas carrying another tab's identity is not a successful revert", async () => {
  // The A->B->A window the active-instance pointer cannot see: the user switches to
  // a same-shaped tab B and back to A while the load completes, so the pointer reads
  // A again and graphRootMatchesState (which deliberately ignores identity) also
  // passes. The stamped-identity round-trip is the only part that catches it.
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(() => {}, {
    applies: "content-only",
  });

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3), links: [] } });
  assert.equal(outcome.status, "failed", "content equality is not proof of WHICH canvas");
  assert.match(outcome.reason, /not carrying the identity/, "the IDENTITY round-trip is what fires here");
});

test("#604: a load that takes the identity but NOT the graph is caught by the CONTENT check", async () => {
  // Isolates the third part of the proof: identity alone cannot tell a faithful
  // install from a partial one, so content is checked as well as the stamp.
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(() => {}, {
    applies: "identity-only",
  });

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3), links: [] } });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.reason, /does not match the snapshot/, "the CONTENT check is what fires here");
});

// An AVAILABILITY test, and deliberately deletion-INSENSITIVE: an ordinary revert
// reports "restored" whether or not any proof exists, so this names no production
// symbol and claims to cover none. Its job is the opposite direction — catching a
// proof that has become a blanket refusal, warning on every working /revert.
// Deletion-sensitivity for each proof part lives in the three tests above.
test("availability: an ordinary revert on a faithful frontend still reports restored", async () => {
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(() => {});
  const snap = { workflowRef: workflow, data: { nodes: nodes(3), links: [] } };
  const outcome = await restoreSnapshot(snap);
  assert.equal(outcome.status, "restored");
  assert.equal(outcome.snapshot, snap);
});

test("#604: the restore asks for its identity WITHOUT the embed step", async () => {
  // Scope, precisely: restoreSnapshot's own identity call must not pass
  // `{embed:true}`, whose job is to write the uuid (and path) into the workflow's own
  // `extra`, where it rides the user's next save. The restore needs a value, not a
  // write.
  //
  // What this does NOT claim: that resolving an identity is side-effect free in
  // general. The real helper's UNSAVED branch persists a freshly-minted id even
  // without the option (#570 durability), and the binding assert above short-circuits
  // on a cached object uuid so it does not necessarily get there first. Both are
  // pre-existing behaviour shared with every graph command and are stubbed here.
  //
  // Both halves live in ONE test on purpose: the ordering half asserts an ABSENCE,
  // which on its own is also what a deleted call looks like. Paired with the success
  // half, deleting the call fails this test.
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(() => {});
  workflow.extra = { existing: true };

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3), links: [] } });
  assert.equal(outcome.status, "restored", "the restore must reach its identity call");
  // Asserted from the CALL, not from an absence of writes: "no write" is also what a
  // deleted call looks like.
  const own = restoreSnapshot.uuidCalls.filter((c) => c.wf === workflow);
  assert.equal(own.length, 1, "the restore resolves the snapshot's workflow identity exactly once");
  assert.equal(own[0].embed, false, "and never asks for the embed step");
  assert.deepEqual(workflow.extra, { existing: true }, "so nothing is written to the workflow here");

  // …and a restore refused before the section never reaches that call at all.
  const guard = makeReloadGuardStub({ held: { token: 7, key: "wf:other.json", since: Date.now(), pending: 1 } });
  const refusedCase = buildSoundRestoreSnapshot(() => {}, { guard });
  refusedCase.workflow.extra = { existing: true };
  const refused = await refusedCase.restoreSnapshot({
    workflowRef: refusedCase.workflow,
    data: { nodes: nodes(3) },
  });
  assert.equal(refused.status, "refused");
  assert.deepEqual(
    refusedCase.restoreSnapshot.uuidCalls.filter((c) => c.wf === refusedCase.workflow),
    [],
    "a refusal must short-circuit before the identity call, whatever that call does",
  );
  assert.deepEqual(refusedCase.workflow.extra, { existing: true });
});

test("#604: a workflow SWITCH during the load is not certified by matching content", async () => {
  // Content equality cannot tell tab A from a same-shaped tab B, and
  // graphRootMatchesState deliberately excludes the identity tag. Without an
  // identity re-check the restore would report "restored" for a canvas it cannot
  // prove is the one it was asked about — and the modal would rewind and resend
  // against it.
  const other = { isModified: false, changeTracker: { activeState: { nodes: nodes(12) } } };
  let active = null;
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const restoreSource = restoreSnapshotSource(src);
  const snapWorkflow = { isModified: false, changeTracker: { activeState: { nodes: nodes(12) } } };
  active = snapWorkflow;

  let live = { nodes: nodes(12), links: [] };
  const rootGraph = { _nodes: nodes(12), extra: {}, serialize: () => JSON.parse(JSON.stringify(live)) };
  const app = makeApp({ rootGraph, canvasGraph: rootGraph });
  app.loadGraphData = (payload) => {
    live = JSON.parse(JSON.stringify(payload)); // the load DOES apply…
    rootGraph.extra = JSON.parse(JSON.stringify(payload.extra ?? {}));
    active = other; // …but the user switched tabs while it was in flight
  };
  const guard = makeReloadGuardStub();
  const restoreSnapshot = buildRestoreSnapshot({
    restoreSource,
    app,
    activeWorkflowRef: () => active,
    guard,
  });

  // Content matches perfectly — only the INSTANCE moved.
  const outcome = await restoreSnapshot({ workflowRef: snapWorkflow, data: { nodes: nodes(3), links: [] } });
  assert.equal(outcome.status, "failed", "matching content is not proof it is the right canvas");
  assert.match(outcome.reason, /active workflow changed/);
  assert.equal(guard.current, null, "and the section is still released");
});

test("#604: the restore RESOLVES only after the async load settles", async () => {
  // Ordering matters for the per-message rollback, which resends the edited
  // message after the revert: resolving early would resend against a canvas whose
  // load is still in flight.
  let settled = false;
  const { restoreSnapshot, workflow } = buildSoundRestoreSnapshot(
    () =>
      new Promise((resolve) =>
        setTimeout(() => {
          settled = true;
          resolve();
        }, 5),
      ),
  );

  const outcome = await restoreSnapshot({ workflowRef: workflow, data: { nodes: nodes(3) } });
  assert.equal(settled, true, "the outcome must not be reported before the load completes");
  assert.equal(outcome.status, "restored");
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
