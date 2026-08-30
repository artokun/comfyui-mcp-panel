// #2009 — panel_run rejects a freshly typed PrimitiveNode dynamic STRING widget.
//
// PrimitiveNode is frontend-only: connecting its generic output to a STRING
// widget input re-addresses it and mints a live `value` widget. Reads and writes
// see that widget; graphToPrompt then throws "Dynamic widget doesn't exist on
// node" because the serializer walks a widget-store schema captured before the
// node was typed. These tests drive the live-widget registrar the wrap uses —
// not a parallel reimplementation of graphToPrompt.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isTypedPrimitiveNode,
  livePrimitiveDynamicWidgets,
  registerLivePrimitiveWidgets,
  resyncLivePrimitiveWidgets,
  describeTypedPrimitiveWidgets,
} from "../../web/js/lib/primitive-dynamic-widgets.js";
import {
  isDynamicWidgetMissingError,
  installGraphToPromptDynamicReconcile,
} from "../../web/js/lib/dynamic-widget-reconcile.js";

function widgetStoreKey(nodeId, widget) {
  return `${nodeId}:${widget.name}`;
}

function makeValueWidget({ name = "value", value = "", registered = false } = {}) {
  let current = value;
  let boundNodeId = registered ? 12 : null;
  const store = new Map();
  const widget = {
    name,
    type: "customtext",
    get value() {
      return boundNodeId == null ? current : (store.get(widgetStoreKey(boundNodeId, widget)) ?? current);
    },
    set value(next) {
      current = next;
      if (boundNodeId != null) store.set(widgetStoreKey(boundNodeId, widget), next);
    },
    get widgetId() {
      return boundNodeId == null ? null : widgetStoreKey(boundNodeId, widget);
    },
    setNodeId(nodeId) {
      boundNodeId = nodeId;
      store.set(widgetStoreKey(nodeId, widget), current);
    },
  };
  return { widget, store, isRegistered: () => boundNodeId != null };
}

function makePrimitiveNode({
  id = 12,
  outputType = "STRING",
  widgets = [],
  recreate,
} = {}) {
  const node = {
    id,
    type: "PrimitiveNode",
    isVirtualNode: true,
    outputs: [{ name: outputType === "*" ? "connect to widget input" : outputType, type: outputType }],
    widgets,
    recreateWidget:
      recreate ??
      function recreateWidget() {
        return this.widgets?.[0];
      },
  };
  return node;
}

test("#2009: an untyped PrimitiveNode is not a live dynamic widget source", () => {
  const node = makePrimitiveNode({ outputType: "*", widgets: [] });
  assert.equal(isTypedPrimitiveNode(node), false);
  assert.deepEqual(livePrimitiveDynamicWidgets({ _nodes: [node] }), []);
});

test("#2009: a STRING-typed PrimitiveNode with a live value widget is the reported shape", () => {
  const { widget } = makeValueWidget({ value: "a cat walks into frame" });
  const node = makePrimitiveNode({ widgets: [widget] });
  assert.equal(isTypedPrimitiveNode(node), true);
  const live = livePrimitiveDynamicWidgets({ _nodes: [node] });
  assert.equal(live.length, 1);
  assert.equal(live[0].outputType, "STRING");
  assert.equal(live[0].widgetName, "value");
  assert.equal(live[0].nodeId, 12);
});

test("#2009: registerLivePrimitiveWidgets uses the live widget list, not nodeData", () => {
  const { widget, isRegistered } = makeValueWidget({ registered: false });
  const node = makePrimitiveNode({ widgets: [widget] });
  node.constructor = { nodeData: null };

  assert.equal(isRegistered(), false);
  const result = registerLivePrimitiveWidgets({ _nodes: [node] });
  assert.equal(result.registered, 1);
  assert.equal(result.nodes, 1);
  assert.equal(isRegistered(), true);
  assert.equal(widget.widgetId, "12:value");
});

test("#2009: nested subgraph PrimitiveNodes are registered too", () => {
  const { widget, isRegistered } = makeValueWidget({ registered: false });
  const inner = makePrimitiveNode({ id: 7, widgets: [widget] });
  const host = { id: 1, type: "Subgraph", widgets: [], subgraph: { _nodes: [inner] } };
  registerLivePrimitiveWidgets({ nodes: [host] });
  assert.equal(isRegistered(), true);
});

test("#2009: resync recreates from the live connection then re-registers", () => {
  const first = makeValueWidget({ value: "prompt a", registered: false });
  const second = makeValueWidget({ value: "prompt a", registered: false });
  const node = makePrimitiveNode({
    widgets: [first.widget],
    recreate() {
      this.widgets = [second.widget];
      return second.widget;
    },
  });

  const result = resyncLivePrimitiveWidgets({ _nodes: [node] });
  assert.equal(result.recreated, 1);
  assert.equal(result.registered, 1);
  assert.equal(node.widgets[0], second.widget);
  assert.equal(second.isRegistered(), true);
  assert.equal(first.isRegistered(), false);
});

test("#2009: describeTypedPrimitiveWidgets names the STRING value widget", () => {
  const { widget } = makeValueWidget({ value: "hello" });
  const node = makePrimitiveNode({ widgets: [widget] });
  assert.deepEqual(describeTypedPrimitiveWidgets({ _nodes: [node] }), [
    { nodeId: 12, nodeType: "PrimitiveNode", outputType: "STRING", widgetName: "value" },
  ]);
});

test("#2009: a hostile PrimitiveNode does not hide a sibling", () => {
  const { widget } = makeValueWidget();
  const good = makePrimitiveNode({ id: 13, widgets: [widget] });
  const hostile = new Proxy(
    { type: "PrimitiveNode", id: 1 },
    {
      get() {
        throw new Error("hostile getter");
      },
    },
  );
  const live = livePrimitiveDynamicWidgets({ _nodes: [hostile, good] });
  assert.equal(live.length, 1);
  assert.equal(live[0].nodeId, 13);
});

test("#2009: registering live widgets makes a store-keyed serialize succeed", async () => {
  const { widget, isRegistered } = makeValueWidget({
    value: "<Picture 1> walks through the door",
    registered: false,
  });
  const node = makePrimitiveNode({ widgets: [widget] });
  const app = {
    graph: { _nodes: [node] },
    graphToPrompt() {
      if (!widget.widgetId) throw new Error("Dynamic widget doesn't exist on node");
      return { output: { 15: { class_type: "DenoMiniMaxH3ReferenceToVideo", inputs: { prompt: widget.value } } } };
    },
  };

  assert.equal(isRegistered(), false);
  assert.equal(installGraphToPromptDynamicReconcile(app), true);
  const prompt = await app.graphToPrompt();
  assert.equal(isRegistered(), true);
  assert.equal(prompt.output[15].inputs.prompt, "<Picture 1> walks through the door");
});

test("#2009: a first-serialize throw is retried after PrimitiveNode resync", async () => {
  const first = makeValueWidget({ value: "first", registered: false });
  const second = makeValueWidget({ value: "first", registered: false });
  const node = makePrimitiveNode({
    widgets: [first.widget],
    recreate() {
      this.widgets = [second.widget];
      return second.widget;
    },
  });
  let calls = 0;
  const app = {
    graph: { _nodes: [node] },
    graphToPrompt() {
      calls += 1;
      const live = node.widgets[0];
      if (calls === 1 || live !== second.widget || !live.widgetId) {
        throw new Error("Dynamic widget doesn't exist on node");
      }
      return { output: { 15: { class_type: "DenoMiniMaxH3ReferenceToVideo", inputs: { prompt: live.value } } } };
    },
  };

  installGraphToPromptDynamicReconcile(app);
  const prompt = await app.graphToPrompt();
  assert.equal(calls, 2);
  assert.equal(node.widgets[0], second.widget);
  assert.equal(second.isRegistered(), true);
  assert.equal(prompt.output[15].inputs.prompt, "first");
});

test("#2009: a persistent serializer throw names the PrimitiveNode and its STRING widget", async () => {
  const { widget } = makeValueWidget({ value: "hello", registered: true });
  const node = makePrimitiveNode({ widgets: [widget] });
  const app = {
    graph: { _nodes: [node] },
    graphToPrompt() {
      throw new Error("Dynamic widget doesn't exist on node");
    },
  };
  installGraphToPromptDynamicReconcile(app);
  assert.throws(
    () => app.graphToPrompt(),
    (error) => {
      assert.equal(isDynamicWidgetMissingError(error), true);
      assert.match(error.message, /PrimitiveNode node 12/);
      assert.match(error.message, /typed STRING value widget/);
      return true;
    },
  );
});

test("#2009: an untyped PrimitiveNode is not blamed for a serializer throw", async () => {
  const node = makePrimitiveNode({ outputType: "*", widgets: [] });
  const app = {
    graph: { _nodes: [node] },
    graphToPrompt() {
      throw new Error("Dynamic widget doesn't exist on node");
    },
  };
  installGraphToPromptDynamicReconcile(app);
  assert.throws(
    () => app.graphToPrompt(),
    (error) => {
      assert.equal(error.message, "Dynamic widget doesn't exist on node");
      assert.doesNotMatch(error.message, /PrimitiveNode node/);
      return true;
    },
  );
});
