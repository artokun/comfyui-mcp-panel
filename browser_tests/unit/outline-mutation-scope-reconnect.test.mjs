// #1636 — Graph outline scope can disagree with mutation scope after reconnect.
//
// Reporter: panel_graph_outline returned viewing.scope="root", then the
// immediately following panel_enter_subgraph({node_id:1067}) failed with
// "Node 1067 is on the ROOT graph, but you are currently inside a subgraph."
// No user canvas change. panel_exit_subgraph then panel_enter_subgraph recovered.
//
// Cause: a read during post-reconnect restore sees the canvas at root and
// publishes that as viewing; the frontend then restores the pre-reconnect
// subgraph; enter_subgraph searches that subgraph. Outline and mutation must
// share one fenced scope so a root outline makes the next enter use root.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  resolveScope,
  describeScope,
  findSubgraphOwner,
  isSubgraphInRoot,
  resolveRailNode,
} from "../../web/js/lib/subgraph-scope.js";
import { describeMissingNode } from "../../web/js/lib/node-scope-locator.js";
import { canonicalNodeId, resolveLiveNode } from "../../web/js/lib/node-id.js";
import { withWorkflowUuid } from "../../web/js/lib/graph-view-identity.js";
import {
  rememberAutoLayoutScope,
  clearAutoLayoutScope,
  layoutScopeFingerprint,
} from "../../web/js/lib/auto-layout-scope.js";
import {
  applyReconnectScopeFence,
  noteReconnectScopeFence,
  pinReconnectScope,
  releaseReconnectScopePin,
  disarmReconnectScopeFence,
  peekReconnectScopeFence,
} from "../../web/js/lib/reconnect-scope-fence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const PANEL_SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

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

function makeGraph(nodes) {
  const g = { _nodes: nodes };
  g.getNodeById = (id) => nodes.find((n) => n.id === id) ?? null;
  return g;
}

function makeSubgraph({ name = "inner", nodes = [] } = {}) {
  const sub = {
    name,
    _nodes: nodes,
    inputNode: { id: -10 },
    outputNode: { id: -20 },
    getNodeById: (id) => nodes.find((n) => n.id === id) ?? null,
  };
  sub.serialize = () => ({ nodes: nodes.map((n) => ({ ...n })) });
  return sub;
}

function makeApp({ rootGraph, canvasGraph }) {
  const canvas = {
    graph: canvasGraph ?? rootGraph,
    setGraph(g) {
      this.graph = g;
    },
    setDirty() {},
  };
  return { graph: rootGraph, canvas };
}

test.beforeEach(() => {
  disarmReconnectScopeFence();
  clearAutoLayoutScope();
});

// ---------------------------------------------------------------------------
// Pure fence
// ---------------------------------------------------------------------------

test("#1636 a reconnect drops the stored pin so the next observation re-pins", () => {
  noteReconnectScopeFence();
  pinReconnectScope("subgraph");
  assert.equal(peekReconnectScopeFence().viewing, "subgraph");
  noteReconnectScopeFence();
  assert.deepEqual(peekReconnectScopeFence(), { armed: true, viewing: null });
});

test("#1636 first observation after reconnect pins whatever resolveScope reported", () => {
  noteReconnectScopeFence();
  const root = makeGraph([{ id: 1 }]);
  const live = { graph: root, rootGraph: root, scope: "root", owner: null, stale: false, diverged: false };
  const out = applyReconnectScopeFence(live);
  assert.equal(out, live);
  assert.equal(peekReconnectScopeFence().viewing, "root");
});

test("#1636 a root pin holds when the live canvas later sits in a subgraph", () => {
  noteReconnectScopeFence();
  const inner = makeSubgraph({ nodes: [{ id: 2 }] });
  const owner = { id: 1067, type: "Graph", subgraph: inner, title: "Detail" };
  const root = makeGraph([owner]);
  applyReconnectScopeFence({
    graph: root,
    rootGraph: root,
    scope: "root",
    owner: null,
    stale: false,
    diverged: false,
  });
  const liveSub = {
    graph: inner,
    rootGraph: root,
    scope: "subgraph",
    owner: { id: 1067, title: "Detail" },
    stale: false,
    diverged: false,
  };
  const held = applyReconnectScopeFence(liveSub);
  assert.equal(held.scope, "root", "mutations must keep the graph the outline promised");
  assert.equal(held.graph, root);
  assert.equal(held.stale, true, "the caller rebinds the canvas to match");
  assert.equal(held.diverged, false, "this is not a #604 content-bearing ghost");
});

test("#1636 a subgraph pin does not yank the canvas back into a subgraph", () => {
  noteReconnectScopeFence();
  const inner = makeSubgraph({ nodes: [{ id: 2 }] });
  const root = makeGraph([{ id: 1067, subgraph: inner }]);
  applyReconnectScopeFence({
    graph: inner,
    rootGraph: root,
    scope: "subgraph",
    owner: { id: 1067 },
    stale: false,
    diverged: false,
  });
  const liveRoot = {
    graph: root,
    rootGraph: root,
    scope: "root",
    owner: null,
    stale: false,
    diverged: false,
  };
  const out = applyReconnectScopeFence(liveRoot);
  assert.equal(out, liveRoot, "a breadcrumb exit stays at root");
});

test("#1636 explicit enter is allowed to move a root pin into a subgraph", () => {
  noteReconnectScopeFence();
  pinReconnectScope("root");
  pinReconnectScope("subgraph");
  const inner = makeSubgraph({ nodes: [{ id: 2 }] });
  const root = makeGraph([{ id: 1067, subgraph: inner }]);
  const liveSub = {
    graph: inner,
    rootGraph: root,
    scope: "subgraph",
    owner: { id: 1067 },
    stale: false,
    diverged: false,
  };
  const out = applyReconnectScopeFence(liveSub);
  assert.equal(out, liveSub, "panel_enter_subgraph must not be rebounded to root");
});

test("#1636 the fence is inert until a reconnect arms it", () => {
  const inner = makeSubgraph({ nodes: [{ id: 2 }] });
  const root = makeGraph([{ id: 1067, subgraph: inner }]);
  pinReconnectScope("root"); // no-op — not armed
  const liveSub = {
    graph: inner,
    rootGraph: root,
    scope: "subgraph",
    owner: { id: 1067 },
    stale: false,
    diverged: false,
  };
  assert.equal(applyReconnectScopeFence(liveSub), liveSub);
});

test("#1636 a diverged live scope is not rewritten into a stale rebind", () => {
  noteReconnectScopeFence();
  pinReconnectScope("root");
  const root = makeGraph([]);
  const ghost = makeSubgraph({ nodes: [{ id: 1 }, { id: 2 }] });
  const diverged = {
    graph: ghost,
    rootGraph: root,
    scope: "root",
    owner: null,
    stale: false,
    diverged: true,
    divergedKind: "subgraph",
  };
  const out = applyReconnectScopeFence(diverged);
  assert.equal(out, diverged, "#604: a content-bearing ghost must still refuse, never repaint");
});

// ---------------------------------------------------------------------------
// Shipped getGraphCtx + describeActiveGraph + resolveNode
// ---------------------------------------------------------------------------

function buildShippedScopeTools(app) {
  const getGraphCtx = new Function(
    "app",
    "window",
    "resolveScope",
    "applyReconnectScopeFence",
    "rememberAutoLayoutScope",
    "layoutScopeFingerprint",
    `${panelFunctionSource(PANEL_SRC, "getGraphCtx", "workflowOwnsRootUuidTag")}\nreturn getGraphCtx;`,
  )(
    app,
    { LiteGraph: {} },
    resolveScope,
    applyReconnectScopeFence,
    rememberAutoLayoutScope,
    layoutScopeFingerprint,
  );

  const describeActiveGraph = new Function(
    "app",
    "activeWorkflowRef",
    "workflowObjectUuid",
    "workflowStableUuid",
    "withWorkflowUuid",
    "findSubgraphOwner",
    "isSubgraphInRoot",
    `${panelFunctionSource(PANEL_SRC, "describeActiveGraph", "captureGraphSnapshot")}\nreturn describeActiveGraph;`,
  )(app, () => null, () => "", () => "", withWorkflowUuid, findSubgraphOwner, isSubgraphInRoot);

  const resolveNode = new Function(
    "canonicalNodeId",
    "resolveLiveNode",
    "resolveRailNode",
    "getGraphCtx",
    "describeMissingNode",
    `${panelFunctionSource(PANEL_SRC, "resolveNode", "normalizeLegacyNodeId")}\nreturn resolveNode;`,
  )(canonicalNodeId, resolveLiveNode, resolveRailNode, getGraphCtx, describeMissingNode);

  return { getGraphCtx, describeActiveGraph, resolveNode };
}

function reporterGraph() {
  const inner = makeSubgraph({ name: "Detail", nodes: [{ id: 10, type: "CLIPTextEncode" }] });
  const owner = { id: 1067, type: "Graph", title: "Detail", subgraph: inner };
  const root = makeGraph([owner, { id: 1, type: "KSampler" }]);
  return { inner, owner, root };
}

test("#1636 outline reporting root makes the immediate enter search root (reporter case)", () => {
  const { inner, owner, root } = reporterGraph();
  const app = makeApp({ rootGraph: root, canvasGraph: root });
  const { getGraphCtx, describeActiveGraph, resolveNode } = buildShippedScopeTools(app);

  noteReconnectScopeFence();

  const outlineCtx = getGraphCtx();
  const viewing = describeActiveGraph(outlineCtx.graph);
  assert.equal(viewing.scope, "root", "outline published root");
  assert.equal(outlineCtx.graph, root);

  // Frontend restore: the pre-reconnect subgraph is back on the canvas.
  // No user action — this is what "immediately following" looks like.
  app.canvas.graph = inner;
  assert.equal(resolveScope(app).scope, "subgraph", "the live canvas DID move into the subgraph");

  const enterCtx = getGraphCtx();
  assert.equal(describeActiveGraph(enterCtx.graph).scope, "root", "viewing stays at the outlined scope");
  assert.equal(enterCtx.graph, root, "enter must search the root, not the restored subgraph");
  const node = resolveNode(enterCtx.graph, 1067);
  assert.equal(node, owner, "panel_enter_subgraph({node_id:1067}) resolves the root host");
  assert.equal(app.canvas.graph, root, "the physical view is rebound to match");
});

test("#1636 without a reconnect the live subgraph is still the mutation target", () => {
  const { inner, root } = reporterGraph();
  const app = makeApp({ rootGraph: root, canvasGraph: inner });
  const { getGraphCtx, describeActiveGraph, resolveNode } = buildShippedScopeTools(app);

  const ctx = getGraphCtx();
  assert.equal(describeActiveGraph(ctx.graph).scope, "subgraph");
  assert.equal(ctx.graph, inner);
  assert.throws(
    () => resolveNode(ctx.graph, 1067),
    /you are currently inside a subgraph/,
    "a genuine subgraph view still gets the EXIT remedy",
  );
});

test("#1636 explicit enter after a root pin is allowed to target the subgraph", () => {
  const { inner, owner, root } = reporterGraph();
  const app = makeApp({ rootGraph: root, canvasGraph: root });
  const { getGraphCtx, describeActiveGraph, resolveNode } = buildShippedScopeTools(app);

  noteReconnectScopeFence();
  const outlineCtx = getGraphCtx();
  assert.equal(describeActiveGraph(outlineCtx.graph).scope, "root");
  const host = resolveNode(outlineCtx.graph, 1067);
  assert.equal(host, owner);

  app.canvas.setGraph(inner);
  pinReconnectScope("subgraph");
  const inside = getGraphCtx();
  assert.equal(inside.graph, inner);
  assert.equal(describeActiveGraph(inside.graph).scope, "subgraph");
});

test("#1636 a failed enter releases the pin so the next observation re-pins", () => {
  noteReconnectScopeFence();
  pinReconnectScope("root");
  releaseReconnectScopePin();
  assert.equal(peekReconnectScopeFence().viewing, null);
  const inner = makeSubgraph({ nodes: [{ id: 2 }] });
  const root = makeGraph([{ id: 1067, subgraph: inner }]);
  const liveSub = {
    graph: inner,
    rootGraph: root,
    scope: "subgraph",
    owner: { id: 1067 },
    stale: false,
    diverged: false,
  };
  assert.equal(applyReconnectScopeFence(liveSub), liveSub);
});

// ---------------------------------------------------------------------------
// Panel wiring — deleting the fence from getGraphCtx / reconnect / enter-exit
// fails these, so a helper-only green cannot hide an unwired panel.
// ---------------------------------------------------------------------------

test("#1636 wiring: getGraphCtx runs the fence on the same resolveScope result writes use", () => {
  const body = panelFunctionSource(PANEL_SRC, "getGraphCtx", "workflowOwnsRootUuidTag");
  assert.match(body, /applyReconnectScopeFence\(resolveScope\(app\)\)/);
});

test("#1636 wiring: reconnect clears the stored subgraph owner and arms the fence", () => {
  const start = PANEL_SRC.indexOf('api.addEventListener("reconnected"');
  assert.notEqual(start, -1);
  const end = PANEL_SRC.indexOf("});", PANEL_SRC.indexOf("void healStaleBundleIfNeeded();", start));
  const block = PANEL_SRC.slice(start, end);
  assert.match(block, /clearAutoLayoutScope\(\)/, "the remembered subgraph owner must not survive reconnect");
  assert.match(block, /noteReconnectScopeFence\(\)/, "the viewing/mutation pin is reset for this epoch");
});

test("#1636 wiring: enter pins subgraph before any post-nav getGraphCtx, exit pins the parent", () => {
  const enterStart = PANEL_SRC.indexOf("async graph_enter_subgraph({ node_id })");
  const enterEnd = PANEL_SRC.indexOf("async graph_exit_subgraph()", enterStart);
  const enter = PANEL_SRC.slice(enterStart, enterEnd);
  const pinAt = enter.indexOf('pinReconnectScope("subgraph")');
  const openAt = enter.indexOf("canvas.openSubgraph");
  const confirmAt = enter.indexOf("confirmCanvasNavigation");
  assert.ok(pinAt > openAt && pinAt < confirmAt, "pin before the receipt's getGraphCtx or hold-root undoes the enter");
  assert.match(enter, /releaseReconnectScopePin\(\)/, "a never-landed enter must not leave a subgraph pin");

  const exitStart = PANEL_SRC.indexOf("async graph_exit_subgraph()");
  const exitEnd = PANEL_SRC.indexOf("graph_move_rail({ rail, pos })", exitStart);
  const exit = PANEL_SRC.slice(exitStart, exitEnd);
  assert.match(exit, /pinReconnectScope\("root"\)/);
  assert.match(exit, /pinReconnectScope\("subgraph"\)/);
});

test("#1636 describeScope of a fenced hold-root is root, matching the mutation graph", () => {
  noteReconnectScopeFence();
  const inner = makeSubgraph({ nodes: [{ id: 2 }] });
  const root = makeGraph([{ id: 1067, subgraph: inner }]);
  applyReconnectScopeFence({
    graph: root,
    rootGraph: root,
    scope: "root",
    owner: null,
    stale: false,
    diverged: false,
  });
  const held = applyReconnectScopeFence({
    graph: inner,
    rootGraph: root,
    scope: "subgraph",
    owner: { id: 1067, title: "Detail" },
    stale: false,
    diverged: false,
  });
  assert.deepEqual(describeScope(held), { scope: "root" });
});
