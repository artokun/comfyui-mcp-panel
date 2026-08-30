/**
 * #2109 — panel_set_widget on a subgraph's promoted widget was applied to the
 * INNER terminal (link-driven from rail -10) and reported success while the
 * enclosing container rail stayed stale. MCP's promoted-write protocol enters
 * the subgraph and writes node 289 `length` / CLIPTextEncode `text`; queue
 * serialization reads the parent rail (`frame_counts` / `text`).
 *
 * These drive runSetWidget — the SAME unit GRAPH_TOOL_EXECUTORS.graph_set_widget
 * delegates to — plus the dispatcher skip that stops the #1827 instance-rail
 * restore from putting the OLD parent value back after a widget write.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import {
  findEnclosingSubgraphNode,
  resolveEnclosingPromotedWrite,
} from "../../web/js/lib/widget-write.js";
import { withPreservedPromotedInstanceWidgets } from "../../web/js/lib/subgraph-instance-widgets.js";

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const SET_WIDGET_SRC = readFileSync(new URL("../../web/js/lib/set-widget.js", import.meta.url), "utf8");

const HOOKS = { beforeChange() {}, afterChange() {}, setDirty() {} };

function mkCtor() {
  const c = function NodeCtor() {};
  c.nodeData = { input: { required: {} } };
  return c;
}

function wired(types, extra = {}) {
  const r = {};
  const defs = {};
  for (const type of types) {
    r[type] = mkCtor();
    defs[type] = {};
  }
  return {
    registry: r,
    getRegistry: () => r,
    getFreshObjectInfo: async () => defs,
    ...HOOKS,
    ...extra,
  };
}

/**
 * Reported shape: wrapper 322 `frame_counts` promotes inner PrimitiveInt 289
 * `length`. The inner widget is link-driven from subgraph input rail -10.
 * Frontend 1.49.6 stores the serializing value on the host-keyed rail.
 */
function makeFrameCountsFixture({ withRail = true } = {}) {
  const innerWidget = { name: "length", type: "INT", value: 17 };
  const inner = {
    id: 289,
    type: "PrimitiveInt",
    constructor: mkCtor(),
    widgets: [innerWidget],
    inputs: [{ name: "length", link: 7 }],
  };
  const store = { value: 17 };
  const railWidget = {
    name: "frame_counts",
    widgetId: "root:322:frame_counts",
    type: "INT",
    get value() {
      return store.value;
    },
    set value(next) {
      store.value = next;
    },
  };
  const hostInput = {
    name: "frame_counts",
    widgetId: "root:322:frame_counts",
    widget: { name: "frame_counts" },
    _subgraphSlot: { name: "frame_counts" },
    ...(withRail ? { _widget: railWidget } : {}),
  };
  const subgraph = {
    _nodes: [inner],
    links: { 7: { origin_id: -10, origin_slot: 0, target_id: 289, target_slot: 0 } },
    inputNode: { id: -10 },
    getNodeById: (id) => (String(id) === "289" ? inner : null),
  };
  inner.graph = subgraph;
  const parent = {
    id: 322,
    type: "SubgraphNode",
    constructor: mkCtor(),
    subgraph,
    inputs: [hostInput],
    widgets: withRail ? [railWidget] : [],
  };
  subgraph.parentNode = parent;
  const rootGraph = { _nodes: [parent] };
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "frame_counts"
      ? { sourceNodeId: "289", sourceWidgetName: "length" }
      : null;
  return { parent, inner, innerWidget, railWidget, hostInput, store, subgraph, rootGraph, resolveSource };
}

/**
 * #366 CLIPTextEncode recurrence, addressed at the INNER converted-to-input
 * widget rather than the wrapper. Host `_widget` is a clone; the serializing
 * store is only built when that handle is dropped.
 */
function makeInnerClipTextEncodeFixture() {
  const innerWidget = { name: "text", type: "STRING", value: "old instructional prompt" };
  const inner = {
    id: 11,
    type: "CLIPTextEncode",
    constructor: mkCtor(),
    widgets: [innerWidget],
    inputs: [{ name: "text", widget: { name: "text" }, type: "STRING", link: 1 }],
  };
  const links = {
    1: { id: 1, origin_id: -10, origin_slot: 0, target_id: 11, target_slot: 0 },
  };
  const subgraph = {
    _nodes: [inner],
    inputs: [{ name: "text", linkIds: [1] }],
    inputNode: { id: -10 },
    links,
    getNodeById: (id) => (String(id) === "11" ? inner : null),
    getLink: (id) => links[id] ?? null,
  };
  inner.graph = subgraph;
  const innerClone = { name: "text", type: "STRING", value: "old instructional prompt" };
  const store = { value: "old instructional prompt" };
  const hostInput = {
    name: "text",
    widgetId: "root:22:text",
    widget: { name: "text" },
    _widget: innerClone,
    _subgraphSlot: { name: "text" },
  };
  const parent = {
    id: 22,
    type: "SubgraphNode",
    constructor: mkCtor(),
    subgraph,
    inputs: [hostInput],
    get widgets() {
      if (!hostInput._widget && hostInput.widgetId) {
        const rail = {
          name: "text",
          widgetId: hostInput.widgetId,
          type: "STRING",
          get value() {
            return store.value;
          },
          set value(next) {
            store.value = next;
          },
        };
        hostInput._widget = rail;
      }
      return hostInput._widget ? [hostInput._widget] : [];
    },
  };
  subgraph.parentNode = parent;
  const rootGraph = { _nodes: [parent] };
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "text" ? { sourceNodeId: "11", sourceWidgetName: "text" } : null;
  return { parent, inner, innerWidget, innerClone, hostInput, store, rootGraph, resolveSource };
}

test("#2109 findEnclosingSubgraphNode follows parentNode and the root walk", () => {
  const { parent, inner, subgraph, rootGraph } = makeFrameCountsFixture();
  assert.equal(findEnclosingSubgraphNode(inner), parent);
  subgraph.parentNode = null;
  assert.equal(findEnclosingSubgraphNode(inner, rootGraph), parent);
  assert.equal(findEnclosingSubgraphNode(inner), null);
});

test("#2109 resolveEnclosingPromotedWrite maps inner length onto wrapper frame_counts", () => {
  const { parent, inner, resolveSource, rootGraph } = makeFrameCountsFixture();
  const hit = resolveEnclosingPromotedWrite(inner, "length", { rootGraph, resolveSource });
  assert.equal(hit.owner, parent);
  assert.equal(hit.widgetName, "frame_counts");
  assert.equal(hit.resolution.target.node, inner);
  assert.equal(hit.resolution.target.widget.name, "length");
  assert.equal(hit.resolution.target.parentWidget?.name, "frame_counts");
});

test("#2109: an inner PrimitiveInt length write syncs the enclosing frame_counts rail", async () => {
  const { parent, inner, innerWidget, store, resolveSource, rootGraph } = makeFrameCountsFixture();
  const res = await runSetWidget(
    inner,
    "length",
    33,
    wired(["PrimitiveInt", "SubgraphNode"], { resolveSource, rootGraph }),
  );

  assert.equal(store.value, 33, "the serializing parent rail store must receive the write");
  assert.equal(parent.widgets[0].value, 33);
  assert.equal(innerWidget.value, 17, "the shared inner PrimitiveInt is not the serializing rail");
  assert.equal(res.set?.value, 33);
  assert.equal(res.set?.node_id, 322);
  assert.equal(res.set?.widget, "frame_counts");
  assert.equal(res.set?.promoted_from?.parent_widget_synced, true);
  assert.equal(res.set?.promoted_from?.value_scope, "instance");
  assert.equal(res.set?.promoted_from?.inner_node_id, 289);
  assert.equal(
    res.warning,
    undefined,
    "a link-driven warning here is the reported lie — the enclosing rail was written",
  );
});

test("#2109: an inner CLIPTextEncode.text write rematerializes the host-keyed rail", async () => {
  const { inner, innerWidget, innerClone, hostInput, store, resolveSource, rootGraph } =
    makeInnerClipTextEncodeFixture();
  const res = await runSetWidget(
    inner,
    "text",
    "new vertical prompt",
    wired(["CLIPTextEncode", "SubgraphNode"], { resolveSource, rootGraph }),
  );

  assert.equal(store.value, "new vertical prompt", "the serializing parent rail store must receive the write");
  assert.notEqual(hostInput._widget, innerClone);
  assert.equal(innerWidget.value, "old instructional prompt");
  assert.equal(innerClone.value, "old instructional prompt");
  assert.equal(res.set?.node_id, 22);
  assert.equal(res.set?.promoted_from?.parent_widget_synced, true);
  assert.equal(res.warning, undefined);
});

test("#2109 FAIL CLOSED: an inner promoted write whose parent rail cannot be identified is refused", async () => {
  const { inner, innerWidget, resolveSource, rootGraph } = makeFrameCountsFixture({ withRail: false });
  await assert.rejects(
    () =>
      runSetWidget(
        inner,
        "length",
        33,
        wired(["PrimitiveInt", "SubgraphNode"], { resolveSource, rootGraph }),
      ),
    /OLD value \(#2109\)/,
  );
  assert.equal(innerWidget.value, 17, "inner must not be mutated when the rail cannot be synced");
});

test("#2109: a link-driven inner write with no enclosing promotion still warns (#1087)", async () => {
  // The #1087 fixture: inner is rail-driven, but there is no wrapper on this
  // graph. Retarget must not fire, and the existing advisory remains.
  const graph = { links: { 4: { origin_id: -10, origin_slot: 4 } } };
  const node = {
    id: 3,
    type: "KSampler",
    constructor: mkCtor(),
    graph,
    widgets: [{ name: "steps", type: "INT", value: 14 }],
    inputs: [{ name: "steps", link: 4 }],
  };
  const res = await runSetWidget(node, "steps", 10, wired(["KSampler"]));
  assert.equal(res.set.value, 10);
  assert.match(res.warning, /link-driven/);
});

test("#2109: preserving instance rails after a promoted inner write restores the OLD parent value", async () => {
  // Why graph_set_widget is not wrapped in withPreservedPromotedInstanceWidgets:
  // the wrapper snapshots the rail (17), the write lands (33), restore puts 17 back.
  const { inner, store, resolveSource, rootGraph, subgraph } = makeFrameCountsFixture();
  await withPreservedPromotedInstanceWidgets(rootGraph, subgraph, async () => {
    await runSetWidget(
      inner,
      "length",
      33,
      wired(["PrimitiveInt", "SubgraphNode"], { resolveSource, rootGraph }),
    );
    assert.equal(store.value, 33, "the write lands on the rail inside the wrapper");
  });
  assert.equal(
    store.value,
    17,
    "restore puts the snapshot back — wrapping set_widget is the container-not-written bug",
  );
});

test("#2109 runSetWidget retargets an inner promoted terminal through the enclosing rail", () => {
  assert.match(SET_WIDGET_SRC, /resolveEnclosingPromotedWrite/);
  assert.match(SET_WIDGET_SRC, /#2109/);
});

test("#2109 dispatcher does not restore instance rails around graph_set_widget", () => {
  assert.match(
    PANEL_SRC,
    /msg\.cmd !== "graph_set_widget"/,
    "graph_set_widget must skip the #1827 preserve wrapper or the new rail value is undone",
  );
  assert.match(
    PANEL_SRC,
    /visibleMutationTarget\.graph !== visibleMutationTarget\.rootGraph/,
    "add/rewire inside a subgraph still restore instance rails",
  );
  assert.match(
    PANEL_SRC,
    /timeoutMs: budget\.bounded\(\),\s*\/\/ #2109[\s\S]*?rootGraph,/,
    "graph_set_widget must pass the live root so an inner terminal can find its wrapper",
  );
});
