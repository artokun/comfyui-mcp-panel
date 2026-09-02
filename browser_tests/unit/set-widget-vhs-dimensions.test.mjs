/**
 * #1533 — VHS_LoadVideo's custom dimensions are VHSINT widgets whose format
 * callback replaces their options and invokes the callback again. These tests
 * keep that production lifecycle, including serialized widget read-back, while
 * driving the same runSetWidget path used by graph_set_widget.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { applyWidgetWrite } from "../../web/js/lib/widget-write.js";

const TYPE = "VHS_LoadVideo";
const REGISTRY = { [TYPE]: {} };
const FRESH = { [TYPE]: {} };

function vhsIntCallback(value) {
  if (this.options.max && value > this.options.max) value = this.options.max;
  if (this.options.min && value < this.options.min) value = this.options.min;
  if (value === 0) return;
  const step = this.options.step;
  const mod = this.options.mod ?? 0;
  this.value = Math.round((value - mod) / step) * step + mod;
}

function makeDimension(name, value = 0, options = {}) {
  return {
    name,
    type: "VHS.ANNOTATED",
    value,
    options: { default: 0, min: 0, max: 8192, disable: 0, ...options },
    config: ["VHSINT", options],
    callback: vhsIntCallback,
  };
}

function makeVhsNode({ width = 0, height = 0 } = {}) {
  const baseOptions = { default: 0, min: 0, max: 8192, disable: 0 };
  const formats = {
    None: {},
    AnimateDiff: {
      custom_width: { step: 8, mod: 0, reset: 512 },
      custom_height: { step: 8, mod: 0, reset: 512 },
    },
  };
  const node = { id: 1533, type: TYPE, widgets: [] };
  const format = {
    name: "format",
    type: "combo",
    value: "AnimateDiff",
    options: { values: Object.keys(formats) },
  };
  const widthWidget = makeDimension("custom_width", width, baseOptions);
  const heightWidget = makeDimension("custom_height", height, baseOptions);
  node.widgets.push(format, widthWidget, heightWidget);

  // Mirrors VideoHelperSuite's initializeLoadFormat: it keeps the original
  // options, installs a format-specific clone, then replays each widget callback.
  const base = {
    custom_width: widthWidget.options,
    custom_height: heightWidget.options,
  };
  format.callback = function (value) {
    const selected = formats[value];
    if (!selected) return;
    for (const widget of [widthWidget, heightWidget]) {
      const wasDefault = widget.options?.reset == widget.value;
      widget.options = Object.assign({}, base[widget.name], selected[widget.name]);
      if (wasDefault && widget.options.reset !== undefined) widget.value = widget.options.reset;
      widget.callback(widget.value);
    }
  };
  format.callback("AnimateDiff");

  // Mirrors VideoHelperSuite's useKVState serializer: the live widget values,
  // not a separate panel-side cache, are the persisted/read-back state.
  node.onSerialize = (info) => {
    info.widgets_values = {};
    for (const widget of node.widgets) info.widgets_values[widget.name] = widget.value;
  };
  return { node, format, widthWidget, heightWidget };
}

const oracle = {
  registry: REGISTRY,
  getFreshObjectInfo: async () => FRESH,
};

test("#1533 a throwing VHS callback accessor cannot block the assignment", () => {
  const { node, widthWidget } = makeVhsNode();
  let reads = 0;
  Object.defineProperty(widthWidget, "callback", {
    configurable: true,
    get() {
      reads += 1;
      throw new Error("VHS callback accessor boom");
    },
  });

  const result = applyWidgetWrite(node, "custom_width", 832, {});

  assert.equal(widthWidget.value, 832);
  assert.equal(result.value, 832);
  assert.equal(reads, 1);
  assert.match(result.write_warning ?? "", /VHS callback accessor boom/);
  assert.equal(result.write_warning_source, undefined);
});

test("#1533 does not wrap same-shaped dimensions on unrelated nodes", () => {
  const widthWidget = makeDimension("custom_width");
  let runs = 0;
  const callback = function () {
    runs += 1;
    this.value = NaN;
  };
  widthWidget.callback = callback;
  const unrelatedNode = { id: 1534, type: "UnrelatedNode", widgets: [widthWidget] };

  const result = applyWidgetWrite(unrelatedNode, "custom_width", 832, {});

  assert.equal(result.value, 832);
  assert.equal(runs, 1);
  assert.equal(widthWidget.callback, callback);
  widthWidget.callback(999);
  assert.equal(runs, 2);
  assert.ok(Number.isNaN(widthWidget.value));
});

test("#1533 non-zero custom dimensions survive VHS format callback and serialization", async () => {
  const { node, format, widthWidget, heightWidget } = makeVhsNode();

  await runSetWidget(node, "custom_width", 1280, oracle);
  await runSetWidget(node, "custom_height", 720, oracle);
  assert.equal(widthWidget.value, 1280);
  assert.equal(heightWidget.value, 720);

  // Switching to None removes the dim step in VHS and immediately replays the
  // VHSINT callbacks. This is the recurrence: without the production fix both
  // non-zero values become NaN and serialize as null.
  format.value = "None";
  format.callback("None");

  assert.equal(widthWidget.value, 1280);
  assert.equal(heightWidget.value, 720);
  const serialized = {};
  node.onSerialize(serialized);
  assert.deepEqual(serialized.widgets_values, {
    format: "None",
    custom_width: 1280,
    custom_height: 720,
  });
});

test("#1533 a panel format update preserves loaded non-zero dimensions", async () => {
  const { node } = makeVhsNode({ width: 1280, height: 720 });

  const result = await runSetWidget(node, "format", "None", oracle);
  assert.equal(result.set.value, "None");
  const serialized = {};
  node.onSerialize(serialized);
  assert.equal(serialized.widgets_values.custom_width, 1280);
  assert.equal(serialized.widgets_values.custom_height, 720);
});

test("#1533 rebuilt VHS rows are rewritten through the retained receipt", async () => {
  const first = makeVhsNode();
  let flushes = 0;
  const flushAfterRebuild = async () => {
    if (flushes++ !== 0) return;
    const replacement = makeVhsNode();
    first.node.widgets = replacement.node.widgets;
    first.format = replacement.format;
    first.widthWidget = replacement.widthWidget;
    first.heightWidget = replacement.heightWidget;
    // The frontend rebuild replays the current format after replacing rows.
    first.format.callback("None");
  };

  const result = await runSetWidget(first.node, "custom_width", 1280, {
    ...oracle,
    awaitFrontendWidgetFlush: flushAfterRebuild,
  });

  assert.equal(result.set.value, 1280);
  assert.equal(first.node.widgets.find((widget) => widget.name === "custom_width").value, 1280);
  const serialized = {};
  first.node.onSerialize(serialized);
  assert.equal(serialized.widgets_values.custom_width, 1280);
});
