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
  graphReadBindingChanged,
} from "../../web/js/lib/graph-binding.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

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
