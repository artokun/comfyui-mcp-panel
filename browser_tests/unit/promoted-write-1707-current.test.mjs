/**
 * comfyui-mcp#1707 — current ComfyUI promoted multiline widgets.
 *
 * The app-level createPromotedMultilineWidget owns a textarea and is bound to
 * the host input's widgetId, but the returned DOM widget intentionally has no
 * widgetId of its own. If Panel drops that live object and asks SubgraphNode
 * for a projection, the fallback copies the inner widget's options. A string
 * write can then touch the shared definition and fail during repair, even
 * though the live host widget had a per-instance store of its own.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { applyWidgetWrite, WidgetWriteError } from "../../web/js/lib/widget-write.js";

const ROOT_GRAPH_ID = "c4a254bb-935e-4013-b380-5e36954de4b0";
const OLD_VALUE = "old lyrics";
const NEW_VALUE = "new lyrics that belongs to one wrapper";

function mkCtor() {
  const ctor = function NodeCtor() {};
  ctor.nodeData = { input: { required: {} } };
  return ctor;
}

function wired(types, extra = {}) {
  const registry = {};
  const defs = {};
  for (const type of types) {
    registry[type] = mkCtor();
    defs[type] = {};
  }
  return {
    registry,
    getRegistry: () => registry,
    getFreshObjectInfo: async () => defs,
    ...extra,
  };
}

function makeCurrentMultilineFixture({
  rollbackRestores = true,
  hostDom = true,
  widgetName = "value",
} = {}) {
  const values = new Map();
  let definitionValue = OLD_VALUE;
  const innerElement = { tagName: "TEXTAREA", value: OLD_VALUE };
  const innerWidget = {
    name: widgetName,
    type: "customtext",
    element: innerElement,
    options: {
      getValue: () => definitionValue,
      setValue: (value) => {
        definitionValue = rollbackRestores || value !== OLD_VALUE ? value : "";
        innerElement.value = definitionValue;
      },
    },
    get value() {
      return this.options.getValue();
    },
    set value(value) {
      this.options.setValue(value);
    },
  };
  const registeredOptions = { ...innerWidget.options };
  const inner = {
    id: 10,
    type: "PrimitiveStringMultiline",
    constructor: mkCtor(),
    widgets: [innerWidget],
  };
  const subgraph = {
    _nodes: [inner],
    getNodeById: (id) => (String(id) === "10" ? inner : null),
  };

  function createProjection(input, widgetId) {
    return {
      name: input.name,
      type: "customtext",
      // This is the generic _projectPromotedWidget fallback. Its options are
      // the cloned inner options registered for the store, not the app-level
      // host textarea's store-only options.
      get options() {
        return registeredOptions;
      },
      get value() {
        return values.get(widgetId)?.value;
      },
      set value(value) {
        values.get(widgetId).value = value;
      },
    };
  }

  function instance(id) {
    const widgetId = `${ROOT_GRAPH_ID}:${encodeURIComponent(String(id))}:${encodeURIComponent(widgetName)}`;
    values.set(widgetId, { value: OLD_VALUE });
    const hostElement = hostDom ? { tagName: "TEXTAREA", value: OLD_VALUE } : null;
    const hostWidget = {
      name: widgetName,
      type: "customtext",
      ...(hostDom ? { element: hostElement } : {}),
      // This is createPromotedMultilineWidget's actual binding: the host
      // textarea and widget-value store, with no widgetId on the widget.
      options: {
        getValue: () => values.get(widgetId)?.value ?? "",
        setValue: (value) => {
          if (hostElement) hostElement.value = value;
          values.get(widgetId).value = value;
        },
      },
      get value() {
        return this.options.getValue();
      },
      set value(value) {
        this.options.setValue(value);
      },
    };
    const input = {
      name: widgetName,
      widgetId,
      _widget: hostWidget,
      // Current litegraph keeps a name stub here; identity is supplied by
      // _widget and node.widgets, not by this label.
      widget: { name: widgetName },
      _subgraphSlot: { name: widgetName },
    };
    const node = {
      id,
      type: "SubgraphNode",
      constructor: mkCtor(),
      subgraph,
      inputs: [input],
      get widgets() {
        if (!input._widget) input._widget = createProjection(input, widgetId);
        return [input._widget];
      },
      serialize() {
        return { widgets_values: [values.get(widgetId)?.value] };
      },
    };
    return { node, input, hostWidget, hostElement, widgetId, widgetName };
  }

  return {
    values,
    instance,
    definition: () => definitionValue,
    serialize: (wrapper) => wrapper.node.serialize(),
    inner,
  };
}

const resolveSource = (_node, input) =>
  ["value", "text", "lyrics"].includes(input?.name)
    ? { sourceNodeId: "10", sourceWidgetName: input.name }
    : null;

test("#1707: current promoted STRING host widget writes one instance and serializes it", () => {
  const fixture = makeCurrentMultilineFixture();
  const target = fixture.instance(251);
  const sibling = fixture.instance(252);
  let unrelatedCallbackCalls = 0;
  const unrelatedWidget = {
    name: "value",
    type: "customtext",
    value: "unrelated",
    callback: () => {
      unrelatedCallbackCalls += 1;
    },
  };
  const unrelatedNode = { id: 999, type: "OtherNode", widgets: [unrelatedWidget] };
  target.node.graph = { _nodes: [target.node, unrelatedNode] };

  const result = applyWidgetWrite(target.node, target.widgetName, NEW_VALUE, { resolveSource });

  assert.equal(result.value, NEW_VALUE);
  assert.equal(result.node_id, 251);
  assert.equal(result.promoted_from.value_scope, "instance");
  assert.equal(target.input.widgetId, target.widgetId);
  assert.equal(target.hostWidget.widgetId, undefined, "the current DOM host has no widgetId of its own");
  assert.equal(fixture.values.get(target.widgetId).value, NEW_VALUE);
  assert.equal(fixture.serialize(target)["widgets_values"][0], NEW_VALUE);
  assert.equal(sibling.node.widgets[0].value, OLD_VALUE, "sibling store must stay isolated");
  assert.equal(fixture.definition(), OLD_VALUE, "shared definition must stay untouched");
  assert.equal(target.input._widget, target.hostWidget, "live host DOM widget must not be rematerialized");
  assert.equal(unrelatedWidget.value, "unrelated");
  assert.equal(unrelatedCallbackCalls, 0);
});

test("#1707: promoted text and lyrics rails use the same instance-scoped path", () => {
  for (const widgetName of ["text", "lyrics"]) {
    const fixture = makeCurrentMultilineFixture({ widgetName });
    const target = fixture.instance(251);
    const sibling = fixture.instance(252);

    const result = applyWidgetWrite(target.node, widgetName, NEW_VALUE, { resolveSource });

    assert.equal(result.promoted_from.value_scope, "instance", widgetName);
    assert.equal(target.hostWidget.value, NEW_VALUE, widgetName);
    assert.equal(sibling.node.widgets[0].value, OLD_VALUE, widgetName);
    assert.equal(fixture.definition(), OLD_VALUE, widgetName);
  }
});

test("#1707: entering the subgraph and writing inner value retargets to the live host rail", async () => {
  const fixture = makeCurrentMultilineFixture();
  const target = fixture.instance(251);
  const inner = fixture.inner;
  const subgraph = {
    ...target.node.subgraph,
    parentNode: target.node,
    getNodeById: (id) => (String(id) === "10" ? inner : null),
  };
  inner.graph = subgraph;
  target.node.subgraph = subgraph;
  const rootGraph = { _nodes: [target.node] };
  target.node.graph = rootGraph;

  const result = await runSetWidget(
    inner,
    target.widgetName,
    NEW_VALUE,
    wired(["PrimitiveStringMultiline", "SubgraphNode"], { resolveSource, rootGraph }),
  );

  assert.equal(result.set.promoted_from.value_scope, "instance");
  assert.equal(target.hostWidget.value, NEW_VALUE);
  assert.equal(fixture.definition(), OLD_VALUE);
});

test("#1707: an unrestorable shared-definition fallback reports partial state truthfully", () => {
  const fixture = makeCurrentMultilineFixture({ rollbackRestores: false, hostDom: false });
  const target = fixture.instance(251);

  assert.throws(
    () => applyWidgetWrite(target.node, "value", NEW_VALUE, { resolveSource }),
    (error) => {
      assert.ok(error instanceof WidgetWriteError);
      assert.equal(error.partialWrite, true);
      assert.match(error.message, /shared subgraph definition|did not retain|refusing/i);
      assert.match(error.message, /value_scope|partial state|Nothing was written/i);
      return true;
    },
  );
  assert.equal(target.hostElement, null);
  assert.equal(fixture.values.get(target.widgetId).value, OLD_VALUE);
  assert.equal(fixture.definition(), "", "the failed fallback is observable as partial shared-definition state");
});
