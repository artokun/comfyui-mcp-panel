// #1328 — auto-layout apply must not silently fall through to the root graph
// when the user was viewing a subgraph. These drive the SAME helpers the
// shipped graph_auto_layout bind uses.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SUBGRAPH_INPUT_RAIL_ID,
  SUBGRAPH_OUTPUT_RAIL_ID,
} from "../../web/js/lib/subgraph-scope.js";
import {
  interiorNodeCount,
  layoutScopeFingerprint,
  viewingOf,
  rememberAutoLayoutScope,
  clearAutoLayoutScope,
  peekAutoLayoutScope,
  resolveSubgraphForLayout,
  resolveAutoLayoutTarget,
  bindAutoLayoutGraph,
} from "../../web/js/lib/auto-layout-scope.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

function node(id, extra = {}) {
  return { id, pos: extra.pos ?? [id * 10, 0], size: [200, 100], ...extra };
}

function makeSubgraph({ name = "inner", nodes = [node(1), node(2), node(3)] } = {}) {
  const sub = {
    name,
    _nodes: nodes,
    inputNode: { id: SUBGRAPH_INPUT_RAIL_ID },
    outputNode: { id: SUBGRAPH_OUTPUT_RAIL_ID },
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
  };
  return sub;
}

function makeRoot(sub, { ownerId = 121, extraRoot = [node(64), node(65)] } = {}) {
  const owner = { id: ownerId, title: "Pack", subgraph: sub };
  const root = { _nodes: [...extraRoot, owner] };
  return { root, owner };
}

test.beforeEach(() => {
  clearAutoLayoutScope();
});

test("interiorNodeCount skips the subgraph rails", () => {
  const sub = makeSubgraph({
    nodes: [
      node(1),
      node(2),
      { id: SUBGRAPH_INPUT_RAIL_ID },
      { id: SUBGRAPH_OUTPUT_RAIL_ID },
    ],
  });
  assert.equal(interiorNodeCount(sub), 2);
});

test("layoutScopeFingerprint names a live subgraph by its owner node", () => {
  const sub = makeSubgraph();
  const { root } = makeRoot(sub);
  const fp = layoutScopeFingerprint(sub, root);
  assert.equal(fp.scope, "subgraph");
  assert.equal(fp.owner_node_id, 121);
  assert.equal(fp.node_count, 3);
  assert.equal(fp.graph, sub);
  assert.deepEqual(viewingOf(fp), {
    scope: "subgraph",
    owner_node_id: 121,
    title: "Pack",
  });
});

test("layoutScopeFingerprint reports root when the canvas graph IS the root", () => {
  const { root } = makeRoot(makeSubgraph());
  const fp = layoutScopeFingerprint(root, root);
  assert.equal(fp.scope, "root");
  assert.equal(fp.owner_node_id, null);
  assert.deepEqual(viewingOf(fp), { scope: "root" });
});

test("dry_run on a subgraph remembers it; apply after an escape retargets there", () => {
  const sub = makeSubgraph();
  const { root } = makeRoot(sub);
  const dry = resolveAutoLayoutTarget({
    liveGraph: sub,
    liveRoot: root,
    captured: null,
    apply: false,
  });
  assert.equal(dry.graph, sub);
  assert.equal(dry.viewing.scope, "subgraph");
  assert.equal(dry.captured.owner_node_id, 121);

  const applied = resolveAutoLayoutTarget({
    liveGraph: root,
    liveRoot: root,
    captured: dry.captured,
    apply: true,
  });
  assert.equal(applied.error, undefined);
  assert.equal(applied.graph, sub, "apply must write the subgraph, not the escaped root");
  assert.equal(applied.retargeted, true);
  assert.equal(applied.viewing.owner_node_id, 121);
});

test("apply fail-closes when the escaped subgraph's interior count no longer matches", () => {
  const sub = makeSubgraph();
  const { root } = makeRoot(sub);
  const captured = layoutScopeFingerprint(sub, root);
  sub._nodes.push(node(99));
  const applied = resolveAutoLayoutTarget({
    liveGraph: root,
    liveRoot: root,
    captured,
    apply: true,
  });
  assert.match(applied.error, /panel_auto_layout apply refused/);
  assert.match(applied.error, /Nothing was moved/);
  assert.match(applied.error, /panel_enter_subgraph/);
  assert.equal(applied.graph, undefined);
});

test("apply fail-closes when the remembered subgraph is unreachable from the live root", () => {
  const sub = makeSubgraph();
  const captured = layoutScopeFingerprint(sub, makeRoot(sub).root);
  const otherRoot = { _nodes: [node(64), node(65)] };
  const applied = resolveAutoLayoutTarget({
    liveGraph: otherRoot,
    liveRoot: otherRoot,
    captured,
    apply: true,
  });
  assert.match(applied.error, /no longer reachable/);
  assert.match(applied.error, /Nothing was moved/);
});

test("apply on a live subgraph with no captured identity uses that subgraph", () => {
  const sub = makeSubgraph();
  const { root } = makeRoot(sub);
  const applied = resolveAutoLayoutTarget({
    liveGraph: sub,
    liveRoot: root,
    captured: null,
    apply: true,
  });
  assert.equal(applied.graph, sub);
  assert.equal(applied.retargeted, false);
});

test("apply on root with no captured subgraph still layouts the root", () => {
  const { root } = makeRoot(makeSubgraph());
  const applied = resolveAutoLayoutTarget({
    liveGraph: root,
    liveRoot: root,
    captured: null,
    apply: true,
  });
  assert.equal(applied.graph, root);
  assert.equal(applied.retargeted, false);
  assert.deepEqual(applied.viewing, { scope: "root" });
});

test("apply fail-closes when the live subgraph owner is a different instance", () => {
  const subA = makeSubgraph({ name: "A" });
  const subB = makeSubgraph({ name: "B" });
  const { root } = makeRoot(subA, { ownerId: 121 });
  root._nodes.push({ id: 200, title: "Other", subgraph: subB });
  const captured = layoutScopeFingerprint(subA, root);
  const applied = resolveAutoLayoutTarget({
    liveGraph: subB,
    liveRoot: root,
    captured,
    apply: true,
  });
  assert.match(applied.error, /owner node 121/);
  assert.match(applied.error, /owner node 200/);
});

test("bindAutoLayoutGraph walks the canvas back onto a retargeted subgraph", () => {
  const sub = makeSubgraph();
  const { root } = makeRoot(sub);
  let current = sub;
  const canvas = {
    get graph() {
      return current;
    },
    setGraph(g) {
      current = g;
    },
    setDirty() {},
  };
  bindAutoLayoutGraph({ graph: sub, rootGraph: root, canvas }, { apply: false });
  assert.equal(peekAutoLayoutScope()?.owner_node_id, 121);

  const bound = bindAutoLayoutGraph({ graph: root, rootGraph: root, canvas }, { apply: true });
  assert.equal(bound.graph, sub);
  assert.equal(bound.retargeted, true);
  assert.equal(current, sub, "canvas must follow the retarget so move_rail stays in-scope");
});

test("a root-scoped dry_run drops the remembered subgraph so a later root apply is allowed", () => {
  const sub = makeSubgraph();
  const { root } = makeRoot(sub);
  rememberAutoLayoutScope(layoutScopeFingerprint(sub, root));
  bindAutoLayoutGraph({ graph: root, rootGraph: root, canvas: {} }, { apply: false });
  assert.equal(peekAutoLayoutScope(), null);
  const bound = bindAutoLayoutGraph({ graph: root, rootGraph: root, canvas: {} }, { apply: true });
  assert.equal(bound.graph, root);
});

test("resolveSubgraphForLayout finds the subgraph by owner id when the graph ref is stale", () => {
  const sub = makeSubgraph();
  const { root } = makeRoot(sub);
  const captured = {
    scope: "subgraph",
    owner_node_id: 121,
    node_count: 3,
    graph: { name: "ghost" },
  };
  assert.equal(resolveSubgraphForLayout(root, captured), sub);
});

test("#1328 the shipping auto-layout executor binds scope BEFORE it writes", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.indexOf("graph_auto_layout({");
  assert.notEqual(start, -1, "graph_auto_layout must exist");
  const bodyStart = src.indexOf("{", start);
  const next = src.indexOf("\n  graph_canvas(", start);
  const body = src.slice(bodyStart, next);
  const bindAt = body.indexOf("bindAutoLayoutGraph(ctx, { apply: !dry_run })");
  const writeAt = body.indexOf("graph.beforeChange()");
  assert.notEqual(bindAt, -1, "apply must go through bindAutoLayoutGraph");
  assert.notEqual(writeAt, -1, "apply still wraps writes in one undo step");
  assert.ok(bindAt < writeAt, "the scope bind must happen before any position write");
});

test("#1328 getGraphCtx remembers a live subgraph and exit drops it at root", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(
    src,
    /rememberAutoLayoutScope\(layoutScopeFingerprint\(graph, app\.graph\)\)/,
    "getGraphCtx must capture subgraph identity after enter_subgraph",
  );
  const exit = src.slice(src.indexOf("async graph_exit_subgraph()"));
  const clearAt = exit.indexOf("clearAutoLayoutScope()");
  const parentAt = exit.indexOf("parentGraph === rootGraph");
  assert.notEqual(clearAt, -1, "exit must drop the captured identity");
  assert.ok(parentAt >= 0 && parentAt < clearAt, "only a return to ROOT clears it");
});

test("#1328 dry_run does not schedule the structural auto-fit", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(
    src,
    /AUTOFIT_CMDS\.has\(cmd\) && msg\?\.dry_run !== true/,
    "a preview must not fire the post-command fit that can displace the canvas",
  );
});
