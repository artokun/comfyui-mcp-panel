// #2125 — panel_add_node refused on a canvas nothing had touched.
//
// The reporter read `panel_graph_outline` on an empty unsaved workflow, then
// called `panel_add_node` and got "The active workflow or graph view changed
// while this node was preparing; nothing was added. Retry on the intended tab."
// No tab switch and no graph edit happened between the two calls, the graph
// stayed empty, and every retry refused identically.
//
// That asymmetry — read succeeds, mutation refuses — is the fingerprint.
// `revalidateGraphMutationContext` is the ONLY gate on the mutation path that
// compares a before/after workflow reference, and `activeWorkflowRef()` returns
// null whenever the frontend exposes no active workflow. The comparator it
// delegates to, `sameWorkflowObject`, answers false for any pair containing a
// null (correct for an identity question: no shared carrier, nothing proven),
// so absent-then-absent read as "the tab changed".
//
// The rest of the panel treats an absent workflow as supported, not as a
// refusal: `graphEmptyBindingUnproven` returns false on it ("no workflow
// service — legacy availability") and the binding bar that runs immediately
// AFTER this gate therefore returns no verdict at all. This gate was the one
// place that disagreed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sameGraphMutationContext } from "../../web/js/lib/graph-mutation-context.js";
import { sameWorkflowObject } from "../../web/js/lib/workflow-chat-identity.js";
import { resolveGraphBindingVerdict } from "../../web/js/lib/graph-binding.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

// STABLE across every ctx() in this file: a fresh object per call would make the
// app/graph/canvas slots differ too, and then every "still refused" assertion
// below would pass for a reason that has nothing to do with the workflow slot.
const APP = {};
const ROOT_GRAPH = { _nodes: [] };
const CANVAS = {};

// `workflowReadable: true` = the probe RAN and found no active workflow. A context
// that omits it (or sets it false) is an UNREADABLE probe and must stay refused.
function ctx(overrides = {}) {
  return {
    app: APP,
    graph: ROOT_GRAPH,
    rootGraph: ROOT_GRAPH,
    canvas: CANVAS,
    workflow: null,
    workflowReadable: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The comparator
// ---------------------------------------------------------------------------

test("#2125: a workflow absent at BOTH ends is unchanged — the context did not move", () => {
  const before = ctx();
  // The strongest possible statement of the defect: the SAME object, compared
  // with itself, through the comparator production actually passes in.
  assert.equal(
    sameGraphMutationContext(before, before, sameWorkflowObject),
    true,
    "an identical context object cannot be a tab switch",
  );
  // And a re-read that produced an equal-but-distinct record, as the real
  // capture/revalidate pair does.
  assert.equal(sameGraphMutationContext(before, { ...before }, sameWorkflowObject), true);
});

test("#2125: absence APPEARING or DISAPPEARING is still a change", () => {
  const absent = ctx();
  const wfA = { changeTracker: {} };
  const wfB = { changeTracker: {} };
  // A workflow that seats itself mid-preflight: the node would land on a tab the
  // caller never named. Still refused.
  assert.equal(sameGraphMutationContext(absent, ctx({ workflow: wfA }), sameWorkflowObject), false);
  // A workflow that vanishes mid-preflight. Still refused.
  assert.equal(sameGraphMutationContext(ctx({ workflow: wfA }), absent, sameWorkflowObject), false);
  // And the case the guard exists for, untouched: two different workflows.
  assert.equal(
    sameGraphMutationContext(ctx({ workflow: wfA }), ctx({ workflow: wfB }), sameWorkflowObject),
    false,
    "the tab-switch guard this whole gate exists for must not be weakened",
  );
  // A proxy/raw pair of the SAME workflow stays same (the reason the comparator
  // is injected at all).
  assert.equal(
    sameGraphMutationContext(
      ctx({ workflow: wfA }),
      ctx({ workflow: { __v_raw: wfA } }),
      sameWorkflowObject,
    ),
    true,
  );
});

test("#2125 gate r1: an UNREADABLE probe is not proven absence — it stays refused", () => {
  // `activeWorkflowRef()` answers null both when there is no active workflow and
  // when the lookup THREW. Only the first is evidence the tab did not move; the
  // second is "I did not find out", and two of them must not witness each other.
  const unreadable = ctx({ workflowReadable: false });
  const proven = ctx();
  assert.equal(
    sameGraphMutationContext(unreadable, unreadable, sameWorkflowObject),
    false,
    "two failed reads must not pass as absent-then-absent — the workflow may have changed under them",
  );
  assert.equal(sameGraphMutationContext(proven, unreadable, sameWorkflowObject), false);
  assert.equal(sameGraphMutationContext(unreadable, proven, sameWorkflowObject), false);
  // Fail-closed for any caller that does not carry the flag at all: the relaxation
  // is opt-in by evidence, never by default.
  const silent = { ...proven };
  delete silent.workflowReadable;
  assert.equal(
    sameGraphMutationContext(silent, silent, sameWorkflowObject),
    false,
    "a context that never stated readability gets the pre-fix behaviour",
  );
  // …and readability is irrelevant once a workflow is actually present.
  const wf = { changeTracker: {} };
  assert.equal(
    sameGraphMutationContext(
      { ...ctx({ workflow: wf }), workflowReadable: false },
      { ...ctx({ workflow: wf }), workflowReadable: false },
      sameWorkflowObject,
    ),
    true,
    "a probe that returned an object plainly ran, whatever the flag says",
  );
});

test("#2125: the non-workflow slots still decide the verdict when the workflow is absent", () => {
  // Admitting absent→absent must not admit a graph/canvas move underneath it.
  const before = ctx();
  for (const slot of ["app", "graph", "rootGraph", "canvas"]) {
    assert.equal(
      sameGraphMutationContext(before, { ...before, [slot]: {} }, sameWorkflowObject),
      false,
      `a changed ${slot} must still refuse even with no workflow to compare`,
    );
  }
});

// ---------------------------------------------------------------------------
// Why admitting it is safe: the gate that runs NEXT already permits this state
// ---------------------------------------------------------------------------

test("#2125: the binding bar that follows this gate returns no verdict on an absent workflow", () => {
  // This is the load-bearing safety claim. If the binding assert refused an
  // absent workflow, admitting it here would only move the refusal one line
  // down and the fix would be cosmetic. It does not: every predicate degrades
  // to no-refusal, which is the "legacy availability" contract stated in
  // graphEmptyBindingUnproven.
  const rootGraph = { _nodes: [] };
  const verdict = resolveGraphBindingVerdict({
    graph: rootGraph,
    rootGraph,
    activeWorkflow: null,
    activeWorkflowUuid: null,
    liveNodeCount: 0,
    inSubgraph: false,
    rootUuidMismatch: false,
    includeBaselineReadGuard: true,
    requireDirtyMutationBinding: true, // the MUTATION bar, not the read bar
    postReconnectWindow: false,
    graphLoading: false,
  });
  assert.equal(verdict, null, "an absent workflow is permitted by the binding bar — so the add proceeds");
});

// ---------------------------------------------------------------------------
// The call site: the REAL revalidateGraphMutationContext source, executed
// ---------------------------------------------------------------------------

/** Build the panel's real capture/revalidate pair over injected dependencies.
 *  Source-sliced rather than re-implemented: a fix that lives only in the lib
 *  while the call site passes its own comparator would pass every test above
 *  and still ship the refusal. */
function buildMutationContextPair(deps) {
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("function captureGraphMutationContext()");
  assert.notEqual(start, -1, "captureGraphMutationContext must exist");
  const endNeedle = "  return current;\n}";
  const end = src.indexOf(endNeedle, start);
  assert.notEqual(end, -1, "revalidateGraphMutationContext must still end by returning the context");
  const body = src.slice(start, end + endNeedle.length);
  assert.match(body, /function revalidateGraphMutationContext\(captured\)/, "both halves are in the slice");
  const names = Object.keys(deps);
  const make = new Function(
    ...names,
    `${body}\nreturn { captureGraphMutationContext, revalidateGraphMutationContext };`,
  );
  return make(...names.map((n) => deps[n]));
}

function harness({ workflow = null, readable = true, bindingVerdict = null } = {}) {
  const rootGraph = { _nodes: [] };
  const app = {};
  const canvas = {};
  const calls = { asserted: 0, assertOpts: null, freshReads: 0 };
  return {
    rootGraph,
    calls,
    ...buildMutationContextPair({
      // The real comparators — this is the whole point of the harness.
      sameGraphMutationContext,
      sameWorkflowObject,
      getGraphCtx: () => ({ app, graph: rootGraph, rootGraph, canvas, LG: {} }),
      probeActiveWorkflow: () => ({ workflow, readable }),
      // Any read taken OUTSIDE the two probes is a fresh sample of the same
      // surface — the gate r2 P1. Counted so a test can assert there are none.
      activeWorkflowRef: () => {
        calls.freshReads += 1;
        return workflow;
      },
      // The #646 reconnect gate is not what this test is about; it must stay
      // wired (reconnect-recovery.test.mjs pins that) but answer "no refusal".
      graphMutationReconnectGate: () => null,
      comfyBackendIsDown: () => false,
      postReconnectBindingSettleWindow: () => false,
      reconnectRefusalError: (gate) => new Error(`reconnect-refusal:${gate}`),
      assertGraphBoundToActiveWorkflow: (_graph, _rootGraph, opts) => {
        calls.asserted += 1;
        calls.assertOpts = opts;
        if (bindingVerdict) throw new Error(bindingVerdict);
      },
      MUTATION_BINDING_BAR: { requireDirtyMutationBinding: true },
    }),
  };
}

test("#2125 call site: graph_add_node's revalidation admits a canvas whose workflow is absent", () => {
  const h = harness({ workflow: null });
  const captured = h.captureGraphMutationContext();
  assert.equal(captured.workflow, null, "the reporter's state: no active workflow to read");

  // The await window of the real command happens here. Nothing touches the tab.
  const current = h.revalidateGraphMutationContext(captured);

  assert.equal(current.rootGraph, h.rootGraph, "the node is committed to the canvas that was captured");
  assert.equal(h.calls.asserted, 1, "and the binding bar still ran — the gate was admitted, not skipped");
});

test("#2125 gate r2: the binding assert decides on the probe, not a third fresh read", () => {
  // The gate's r2 P1. Admitting a PROVEN absence at the comparison is only safe if
  // the binding bar decides about that same observation. Left to take its own
  // `activeWorkflowRef()` sample, a throw there returns null, and every predicate in
  // resolveGraphBindingVerdict reads null as "no workflow service — legacy
  // availability" — so the write would be permitted on an UNREADABLE surface, which
  // is precisely the conflation this whole fix removes one line above.
  const h = harness({ workflow: null, readable: true });
  const captured = h.captureGraphMutationContext();
  h.revalidateGraphMutationContext(captured);

  assert.equal(h.calls.asserted, 1, "the binding bar still runs");
  assert.ok(h.calls.assertOpts, "…and it is given options");
  assert.deepEqual(
    h.calls.assertOpts.workflowProbe,
    { workflow: null, readable: true },
    "the binding bar is handed the observation the comparison just validated",
  );
  assert.equal(
    h.calls.freshReads,
    0,
    "nothing on this path takes a fresh activeWorkflowRef() sample — one observation, one decision",
  );
});

test("#2125 gate r2: the binding assert PREFERS the supplied probe over its own read", () => {
  // The consuming half, pinned on the real source. The assert is far too entangled
  // to execute here, so this asserts the exact expression that decides it — a revert
  // to a bare `activeWorkflowRef()` fails.
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("function assertGraphBoundToActiveWorkflow(");
  assert.notEqual(start, -1, "assertGraphBoundToActiveWorkflow must exist");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(
    body,
    /const activeWorkflow = workflowProbe \? workflowProbe\.workflow : activeWorkflowRef\(\);/,
    "a caller-supplied observation wins; only a caller that made none re-reads",
  );
  assert.match(body, /workflowProbe = null,/, "and the option defaults off, so every other caller is unchanged");
});

test("#2125 call site r1: a probe that THREW at both ends is still refused", () => {
  // The gate's P1. If the panel reported this as an ordinary absence, a workflow
  // that moved during the preflight while the lookup happened to be throwing
  // would be written to unverified.
  const h = harness({ workflow: null, readable: false });
  const captured = h.captureGraphMutationContext();
  assert.equal(captured.workflow, null);
  assert.equal(captured.workflowReadable, false, "the capture must record that the probe did not run");
  assert.throws(
    () => h.revalidateGraphMutationContext(captured),
    /active workflow or graph view changed/,
    "unreadable is 'I did not find out', never 'nothing changed'",
  );
  assert.equal(h.calls.asserted, 0, "and nothing reached the binding assert or the graph");
});

test("#2125 call site r1: the panel's own probe reports readable:false when the lookup throws", () => {
  // Not a stub: the REAL probeActiveWorkflow source, driven with a getter that
  // throws — the shape that makes activeWorkflowRef() return a bare null today.
  const src = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("function probeActiveWorkflow()");
  assert.notEqual(start, -1, "probeActiveWorkflow must exist");
  const endNeedle = "\n}";
  const body = src.slice(start, src.indexOf(endNeedle, start) + endNeedle.length);
  const probe = new Function("window", "app", `${body}\nreturn probeActiveWorkflow;`);

  const exploding = {};
  Object.defineProperty(exploding, "activeWorkflow", {
    get() { throw new Error("extensionManager surface is unavailable"); },
  });
  assert.deepEqual(
    probe({}, { extensionManager: { workflow: exploding } })(),
    { workflow: null, readable: false },
    "a throwing lookup must be reported as unreadable, not as an absent workflow",
  );

  // And the two states it must still distinguish.
  assert.deepEqual(
    probe({}, { extensionManager: { workflow: { activeWorkflow: null } } })(),
    { workflow: null, readable: true },
    "a lookup that ran and found nothing is PROVEN absence",
  );
  const wf = { changeTracker: {} };
  assert.deepEqual(
    probe({}, { extensionManager: { workflow: { activeWorkflow: wf } } })(),
    { workflow: wf, readable: true },
  );
});

test("#2125 call site: a genuine tab switch during the preflight is still refused", () => {
  // The guard's reason for existing, exercised through the same real source: the
  // capture sees workflow A, the revalidate sees workflow B.
  // Every non-workflow slot is a STABLE object across both reads, so the only
  // thing that can decide this test is the workflow slot.
  const app = {};
  const canvas = {};
  const rootGraph = { _nodes: [] };
  let workflow = { changeTracker: {} };
  const pair = buildMutationContextPair({
    sameGraphMutationContext,
    sameWorkflowObject,
    getGraphCtx: () => ({ app, graph: rootGraph, rootGraph, canvas, LG: {} }),
    probeActiveWorkflow: () => ({ workflow, readable: true }),
    activeWorkflowRef: () => workflow,
    graphMutationReconnectGate: () => null,
    comfyBackendIsDown: () => false,
    postReconnectBindingSettleWindow: () => false,
    reconnectRefusalError: (gate) => new Error(`reconnect-refusal:${gate}`),
    assertGraphBoundToActiveWorkflow: () => {},
    MUTATION_BINDING_BAR: {},
  });
  const captured = pair.captureGraphMutationContext();
  // Sanity: with the workflow held FIXED this same pair admits the context, so a
  // refusal below can only be the switch.
  pair.revalidateGraphMutationContext(captured);
  const switched = { changeTracker: {} };
  workflow = switched;
  assert.throws(
    () => pair.revalidateGraphMutationContext(captured),
    /active workflow or graph view changed/,
    "a real switch must still refuse — #2125 must not become a hole in the #646/#349 fence",
  );
});
