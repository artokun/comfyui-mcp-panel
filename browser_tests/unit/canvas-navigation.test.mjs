// #619 — subgraph navigation must carry a post-navigation RECEIPT.
//
// graph_enter_subgraph used to fire canvas.openSubgraph(sub, node) and report
// success unconditionally: a silent no-op navigation would report `entered`
// for a canvas that never moved, and a navigation that landed while the
// tracker was mid-capture let the IMMEDIATELY following graph read refuse with
// [root-shape-mismatch]. The receipt polls (bounded) until the canvas
// observably shows the target AND the read-bar binding assert passes.
//
// The poll loop is tested as the pure lib function; the SHIPPING
// graph_enter_subgraph executor is extracted from the panel monolith and driven
// with doubles, so deleting the receipt from the panel fails these tests.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { confirmCanvasNavigation } from "../../web/js/lib/canvas-navigation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const instantSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// The pure poll loop
// ---------------------------------------------------------------------------

test("#619: landed + bound on the first poll resolves immediately", async () => {
  const target = { name: "sub" };
  const r = await confirmCanvasNavigation({
    readCanvasGraph: () => target,
    target,
    assertBound: () => {},
    sleep: instantSleep,
  });
  assert.deepEqual(r, { landed: true, everLanded: true, bound: true, lastError: null });
});

test("#619: a canvas observed landed then displaced is everLanded:true, landed:false — disclose, not refuse", async () => {
  const target = { name: "sub" };
  const elsewhere = { name: "other" };
  let reads = 0;
  const r = await confirmCanvasNavigation({
    readCanvasGraph: () => {
      reads += 1;
      // Lands on the target once, then something else moves the canvas away.
      return reads === 1 ? target : elsewhere;
    },
    target,
    assertBound: () => {
      throw new Error("[root-shape-mismatch] still settling");
    },
    tries: 4,
    sleep: instantSleep,
  });
  assert.equal(r.landed, false, "the LAST observation is not the target");
  assert.equal(r.everLanded, true, "but the navigation WAS observed — a refusal would be a lie");
  assert.equal(r.bound, false);
  assert.match(String(r.lastError?.message), /still settling/);
});

test("#619: a probe that MOVES the canvas off the target cannot produce a settled receipt (codex r2 P1)", async () => {
  // getGraphCtx's verified rebind heal repaints a provably content-free ghost
  // canvas to root — the probe itself can change what the canvas shows. Only a
  // landing that SURVIVES the probe is settled.
  const target = { name: "sub" };
  const root = { name: "root" };
  let current = target;
  const r = await confirmCanvasNavigation({
    readCanvasGraph: () => current,
    target,
    assertBound: () => {
      current = root; // the probe's side effect: the canvas is healed to root
    },
    tries: 3,
    sleep: instantSleep,
  });
  assert.equal(r.bound, false, "no settled receipt for a canvas the probe moved away");
  assert.equal(r.everLanded, true);
  assert.equal(r.landed, false);
});

test("#619: a probe that THROWS after moving the canvas still updates the terminal landed (codex r3)", async () => {
  const target = { name: "sub" };
  const root = { name: "root" };
  let current = target;
  const r = await confirmCanvasNavigation({
    readCanvasGraph: () => current,
    target,
    assertBound: () => {
      current = root;
      throw new Error("probe failed after the heal moved the canvas");
    },
    tries: 3,
    sleep: instantSleep,
  });
  assert.equal(r.landed, false, "the terminal verdict describes the LAST observation, not the pre-probe one");
  assert.equal(r.everLanded, true);
  assert.equal(r.bound, false);
  assert.match(String(r.lastError?.message), /probe failed/);
});

test("#619: a navigation that lands a few polls later is still confirmed", async () => {
  const target = { name: "sub" };
  let current = { name: "root" };
  let reads = 0;
  const r = await confirmCanvasNavigation({
    readCanvasGraph: () => {
      reads += 1;
      if (reads >= 3) current = target;
      return current;
    },
    target,
    assertBound: () => {},
    sleep: instantSleep,
  });
  assert.equal(r.landed, true);
  assert.equal(r.bound, true);
  assert.equal(reads, 4, "3 polls to land + the post-probe survival re-read (codex r2)");
});

test("#619: a canvas that never moves is landed:false, bound:false", async () => {
  let assertCalls = 0;
  const r = await confirmCanvasNavigation({
    readCanvasGraph: () => ({ name: "root" }),
    target: { name: "sub" },
    assertBound: () => {
      assertCalls += 1;
    },
    tries: 5,
    sleep: instantSleep,
  });
  assert.equal(r.landed, false);
  assert.equal(r.bound, false);
  assert.equal(assertCalls, 0, "the binding assert is only evaluated once the canvas has landed");
});

test("#619: landed but never bound discloses bound:false with the assert's error", async () => {
  const target = { name: "sub" };
  const boom = new Error("[root-shape-mismatch] still settling");
  const r = await confirmCanvasNavigation({
    readCanvasGraph: () => target,
    target,
    assertBound: () => {
      throw boom;
    },
    tries: 4,
    sleep: instantSleep,
  });
  assert.equal(r.landed, true, "the navigation DID happen — the caller must disclose, not refuse");
  assert.equal(r.bound, false);
  assert.equal(r.lastError, boom);
});

test("#619: an assert that settles mid-poll still ends bound", async () => {
  const target = { name: "sub" };
  let calls = 0;
  const r = await confirmCanvasNavigation({
    readCanvasGraph: () => target,
    target,
    assertBound: () => {
      calls += 1;
      if (calls < 3) throw new Error("not yet");
    },
    sleep: instantSleep,
  });
  assert.equal(r.bound, true);
  assert.equal(calls, 3);
});

test("#619: a throwing canvas read is not-landed evidence, never a crash", async () => {
  const r = await confirmCanvasNavigation({
    readCanvasGraph: () => {
      throw new Error("canvas gone");
    },
    target: { name: "sub" },
    assertBound: () => {},
    tries: 3,
    sleep: instantSleep,
  });
  assert.equal(r.landed, false);
  assert.equal(r.bound, false);
});

// ---------------------------------------------------------------------------
// The SHIPPING graph_enter_subgraph executor, extracted and driven with doubles
// ---------------------------------------------------------------------------

function extractMethod(sig) {
  const start = SRC.indexOf(sig);
  assert.notEqual(start, -1, `${sig} not found in the panel source`);
  // The signature carries a destructured param ("({ node_id })"), so the BODY
  // brace is the one after the params close paren.
  const open = SRC.indexOf(") {", start) + 1;
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    const ch = SRC[i];
    if (ch === "/" && SRC[i + 1] === "/") {
      i = SRC.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && SRC[i + 1] === "*") {
      i = SRC.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < SRC.length; i += 1) {
        if (SRC[i] === "\\") {
          i += 1;
          continue;
        }
        if (SRC[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) {
      return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated method: ${sig}`);
}

function buildEnterSubgraph(doubles) {
  const body = extractMethod("async graph_enter_subgraph({ node_id })").replace(
    /^async graph_enter_subgraph\(/,
    "async function graph_enter_subgraph(",
  );
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    "confirmCanvasNavigation",
    "describeActiveGraph",
    "assertGraphBoundToActiveWorkflow",
    "coerceMessageText",
    `return (${body});`,
  );
  return factory(
    doubles.getGraphCtx,
    doubles.resolveNode,
    doubles.confirmCanvasNavigation ?? confirmCanvasNavigation,
    doubles.describeActiveGraph,
    doubles.assertGraphBoundToActiveWorkflow,
    doubles.coerceMessageText ?? ((v) => String(v)),
  );
}

/** A minimal canvas/app pair where openSubgraph can be made to land or no-op. */
function fakeScope({ land = true, landAfterReads = 0 } = {}) {
  const rootGraph = { _nodes: [], name: "root" };
  const sub = { _nodes: [], name: "sub", rootGraph };
  const node = { id: 105, type: "SubgraphNode", subgraph: sub };
  const canvas = {
    _graph: rootGraph,
    reads: 0,
    // The receipt reads canvas.graph directly, so the delayed landing is
    // modeled on the property read itself.
    get graph() {
      this.reads += 1;
      if (this.pending && this.reads > landAfterReads) {
        this._graph = this.pending;
        this.pending = null;
      }
      return this._graph;
    },
    openSubgraph(s) {
      if (!land) return; // silent no-op — the pre-#619 shape this must catch
      if (landAfterReads <= 0) {
        this._graph = s;
      } else {
        this.pending = s;
      }
    },
    setDirty() {},
  };
  const app = { graph: rootGraph, canvas };
  const getGraphCtx = () => ({ app, graph: canvas.graph, rootGraph, canvas });
  return {
    rootGraph,
    sub,
    node,
    canvas,
    getGraphCtx,
    resolveNode: () => node,
    describeActiveGraph: (g) => ({ scope: g === rootGraph ? "root" : "subgraph" }),
  };
}

test("#619: the shipping enter reports settled:true when the canvas lands and the binding clears", async () => {
  const scope = fakeScope();
  const enter = buildEnterSubgraph({
    ...scope,
    assertGraphBoundToActiveWorkflow: () => {},
  });
  const reply = await enter({ node_id: 105 });
  assert.equal(reply.entered, 105);
  assert.equal(reply.viewing.scope, "subgraph");
  assert.equal(reply.settled, true);
});

test("#619: the shipping enter REFUSES when the canvas was never observed inside the subgraph — without claiming non-occurrence", async () => {
  const scope = fakeScope({ land: false });
  const enter = buildEnterSubgraph({
    ...scope,
    assertGraphBoundToActiveWorkflow: () => {},
  });
  await assert.rejects(
    () => enter({ node_id: 105 }),
    /could not confirm[\s\S]*do NOT assume nothing happened/,
    "an unconfirmed navigation is an uncertainty, not a proven no-op (codex r5)",
  );
  await assert.rejects(
    () => enter({ node_id: 105 }),
    /panel_graph_outline/,
    "the next step it names is a scope READ, not a blind retry",
  );
});

test("#619: the shipping enter DISCLOSES settled:false when it landed but the binding has not caught up", async () => {
  const scope = fakeScope();
  const enter = buildEnterSubgraph({
    ...scope,
    assertGraphBoundToActiveWorkflow: () => {
      throw new Error("[root-shape-mismatch] tracker mid-capture");
    },
  });
  const reply = await enter({ node_id: 105 });
  assert.equal(reply.entered, 105, "the navigation DID happen — refuse would invite a pointless retry");
  assert.equal(reply.settled, false);
  assert.match(reply.note, /DID enter the subgraph/);
  assert.match(reply.note, /tracker mid-capture/, "the actual blocker is named");
});

test("#619: the shipping enter waits out a slow landing instead of racing it", async () => {
  const scope = fakeScope({ landAfterReads: 2 });
  const enter = buildEnterSubgraph({
    ...scope,
    assertGraphBoundToActiveWorkflow: () => {},
  });
  const reply = await enter({ node_id: 105 });
  assert.equal(reply.settled, true);
  assert.equal(reply.viewing.scope, "subgraph");
});

test("#619: the shipping enter DISCLOSES (never refuses) when the canvas landed then navigated away", async () => {
  const rootGraph = { _nodes: [], name: "root" };
  const sub = { _nodes: [], name: "sub", rootGraph };
  const elsewhere = { _nodes: [], name: "elsewhere", rootGraph };
  const node = { id: 105, type: "SubgraphNode", subgraph: sub };
  let reads = 0;
  const canvas = {
    _g: rootGraph,
    // The first post-navigation read sees the target; every later one sees the
    // canvas somewhere else (a user navigation landed in between).
    get graph() {
      reads += 1;
      return reads <= 2 ? this._g : elsewhere;
    },
    openSubgraph(s) {
      this._g = s;
    },
    setDirty() {},
  };
  const app = { graph: rootGraph, canvas };
  const enter = buildEnterSubgraph({
    getGraphCtx: () => ({ app, graph: canvas.graph, rootGraph, canvas }),
    resolveNode: () => node,
    describeActiveGraph: (g) => ({ scope: g === rootGraph ? "root" : "subgraph" }),
    assertGraphBoundToActiveWorkflow: () => {
      throw new Error("[root-shape-mismatch] still settling");
    },
  });
  const reply = await enter({ node_id: 105 });
  assert.equal(reply.entered, 105, "the navigation happened — the reply must not claim otherwise");
  assert.equal(reply.settled, false);
  assert.match(reply.note, /navigated away/, "the displacement is disclosed, not a false refusal");
});

test("#619: the shipping enter does not claim settled when the canvas moved after the receipt (codex r8)", async () => {
  const rootGraph = { _nodes: [], name: "root" };
  const sub = { _nodes: [], name: "sub", rootGraph };
  const elsewhere = { _nodes: [], name: "elsewhere", rootGraph };
  const node = { id: 105, type: "SubgraphNode", subgraph: sub };
  let reads = 0;
  const canvas = {
    _g: rootGraph,
    // Reads: 1 = enter's own getGraphCtx, 2 = the receipt's landing read,
    // 3 = the receipt assert's getGraphCtx, 4 = the post-probe survival
    // re-read, 5+ = the reply's fresh observation (viewing + stillOnTarget).
    get graph() {
      reads += 1;
      return reads <= 4 ? this._g : elsewhere;
    },
    openSubgraph(s) {
      this._g = s;
    },
    setDirty() {},
  };
  const app = { graph: rootGraph, canvas };
  const enter = buildEnterSubgraph({
    getGraphCtx: () => ({ app, graph: canvas.graph, rootGraph, canvas }),
    resolveNode: () => node,
    describeActiveGraph: (g) => ({ scope: g === rootGraph ? "root" : "subgraph" }),
    assertGraphBoundToActiveWorkflow: () => {},
  });
  const reply = await enter({ node_id: 105 });
  assert.equal(reply.settled, false, "no settled receipt for a scope the canvas has already left");
  assert.match(reply.note, /binding check passed, but the view has already moved elsewhere/);
});

test("#619: the shipping exit carries the same receipt wiring", () => {  // Source-level pin: exit must run the same confirmCanvasNavigation receipt
  // (delete it and this fails) and must keep the immediate-parent resolution.
  const body = extractMethod("async graph_exit_subgraph()");
  assert.match(body, /await confirmCanvasNavigation\(\{/, "exit runs the receipt");
  assert.match(body, /findSubgraphOwner\(rootGraph, graph\)\?\.parentGraph/, "exit keeps the immediate-parent walk (#412)");
});

// ---------------------------------------------------------------------------
// r9: the terminal observation is three-state — an UNREADABLE canvas read is
// neither "still on target" nor "moved elsewhere"
// ---------------------------------------------------------------------------

function buildExitSubgraph(doubles) {
  const body = extractMethod("async graph_exit_subgraph()").replace(
    /^async graph_exit_subgraph\(/,
    "async function graph_exit_subgraph(",
  );
  const factory = new Function(
    "getGraphCtx",
    "findSubgraphOwner",
    "confirmCanvasNavigation",
    "describeActiveGraph",
    "assertGraphBoundToActiveWorkflow",
    "coerceMessageText",
    "clearAutoLayoutScope",
    "rememberAutoLayoutScope",
    "layoutScopeFingerprint",
    `return (${body});`,
  );
  return factory(
    doubles.getGraphCtx,
    doubles.findSubgraphOwner,
    doubles.confirmCanvasNavigation ?? confirmCanvasNavigation,
    doubles.describeActiveGraph,
    doubles.assertGraphBoundToActiveWorkflow,
    doubles.coerceMessageText ?? ((v) => String(v)),
    doubles.clearAutoLayoutScope ?? (() => {}),
    doubles.rememberAutoLayoutScope ?? (() => {}),
    doubles.layoutScopeFingerprint ?? (() => ({ scope: "root" })),
  );
}

test("#619: an UNREADABLE terminal canvas read discloses uncertainty, not displacement (codex r9, enter)", async () => {
  const rootGraph = { _nodes: [], name: "root" };
  const sub = { _nodes: [], name: "sub", rootGraph };
  const node = { id: 105, type: "SubgraphNode", subgraph: sub };
  let reads = 0;
  const canvas = {
    _g: rootGraph,
    // Reads 1-4 complete the receipt (landing, assert's ctx read, survival
    // re-read); the reply's own reads throw.
    get graph() {
      reads += 1;
      if (reads >= 5) throw new Error("canvas getter exploded");
      return this._g;
    },
    openSubgraph(s) {
      this._g = s;
    },
    setDirty() {},
  };
  const app = { graph: rootGraph, canvas };
  const enter = buildEnterSubgraph({
    getGraphCtx: () => ({ app, graph: canvas.graph, rootGraph, canvas }),
    resolveNode: () => node,
    describeActiveGraph: (g) => ({ scope: g === rootGraph ? "root" : "subgraph" }),
    assertGraphBoundToActiveWorkflow: () => {},
  });
  const reply = await enter({ node_id: 105 });
  assert.equal(reply.settled, false);
  assert.match(reply.note, /could not determine which/, "uncertainty is disclosed");
  assert.doesNotMatch(reply.note, /navigated away|moved elsewhere/, "no displacement claim without an observation");
  assert.match(reply.note, /panel_graph_outline/, "the remedy is a scope read");
});

test("#619: the shipping exit settles at root on a clean navigation (driven, not just source-pinned)", async () => {
  const rootGraph = { _nodes: [], name: "root" };
  const sub = { _nodes: [], name: "sub", rootGraph };
  const canvas = {
    _g: sub,
    get graph() {
      return this._g;
    },
    setGraph(g) {
      this._g = g;
    },
    setDirty() {},
  };
  const app = { graph: rootGraph, canvas };
  const exit = buildExitSubgraph({
    getGraphCtx: () => ({ app, graph: canvas.graph, rootGraph, canvas }),
    findSubgraphOwner: () => ({ id: 105, parentGraph: rootGraph }),
    describeActiveGraph: (g) => ({ scope: g === rootGraph ? "root" : "subgraph" }),
    assertGraphBoundToActiveWorkflow: () => {},
  });
  const reply = await exit();
  assert.equal(reply.settled, true);
  assert.equal(reply.viewing.scope, "root");
});

test("#619: an UNREADABLE terminal canvas read discloses uncertainty, not displacement (codex r9, exit)", async () => {
  const rootGraph = { _nodes: [], name: "root" };
  const sub = { _nodes: [], name: "sub", rootGraph };
  let reads = 0;
  const canvas = {
    _g: sub,
    get graph() {
      reads += 1;
      if (reads >= 5) throw new Error("canvas getter exploded");
      return this._g;
    },
    setGraph(g) {
      this._g = g;
    },
    setDirty() {},
  };
  const app = { graph: rootGraph, canvas };
  const exit = buildExitSubgraph({
    getGraphCtx: () => ({ app, graph: canvas.graph, rootGraph, canvas }),
    findSubgraphOwner: () => ({ id: 105, parentGraph: rootGraph }),
    describeActiveGraph: (g) => ({ scope: g === rootGraph ? "root" : "subgraph" }),
    assertGraphBoundToActiveWorkflow: () => {},
  });
  const reply = await exit();
  assert.equal(reply.settled, false);
  assert.match(reply.note, /could not determine which/);
  assert.doesNotMatch(reply.note, /navigated away|moved elsewhere/);
});

test("#619: a MISSING post-receipt canvas is unreadable, not 'moved elsewhere' (codex r10, enter)", async () => {
  const rootGraph = { _nodes: [], name: "root" };
  const sub = { _nodes: [], name: "sub", rootGraph };
  const node = { id: 105, type: "SubgraphNode", subgraph: sub };
  let reads = 0;
  const canvas = {
    _g: rootGraph,
    get graph() {
      reads += 1;
      if (reads >= 5) return null; // canvas/graph gone during teardown
      return this._g;
    },
    openSubgraph(s) {
      this._g = s;
    },
    setDirty() {},
  };
  const app = { graph: rootGraph, canvas };
  const enter = buildEnterSubgraph({
    getGraphCtx: () => ({ app, graph: canvas.graph, rootGraph, canvas }),
    resolveNode: () => node,
    describeActiveGraph: (g) => ({ scope: g === rootGraph ? "root" : "subgraph" }),
    assertGraphBoundToActiveWorkflow: () => {},
  });
  const reply = await enter({ node_id: 105 });
  assert.equal(reply.settled, false);
  assert.match(reply.note, /could not determine which/);
  assert.doesNotMatch(reply.note, /navigated away|moved elsewhere/);
});

test("#619: a MISSING post-receipt canvas is unreadable, not 'moved elsewhere' (codex r10, exit)", async () => {
  const rootGraph = { _nodes: [], name: "root" };
  const sub = { _nodes: [], name: "sub", rootGraph };
  let reads = 0;
  const canvas = {
    _g: sub,
    get graph() {
      reads += 1;
      if (reads >= 5) return null;
      return this._g;
    },
    setGraph(g) {
      this._g = g;
    },
    setDirty() {},
  };
  const app = { graph: rootGraph, canvas };
  const exit = buildExitSubgraph({
    getGraphCtx: () => ({ app, graph: canvas.graph, rootGraph, canvas }),
    findSubgraphOwner: () => ({ id: 105, parentGraph: rootGraph }),
    describeActiveGraph: (g) => ({ scope: g === rootGraph ? "root" : "subgraph" }),
    assertGraphBoundToActiveWorkflow: () => {},
  });
  const reply = await exit();
  assert.equal(reply.settled, false);
  assert.match(reply.note, /could not determine which/);
  assert.doesNotMatch(reply.note, /navigated away|moved elsewhere/);
});
