// #1931 — SaveVideo's `codec` exists only as a child of a chosen `format` option.
// The panel was materialising both `format.codec` (correct) and a bare orphan
// `codec`. graphToPrompt then threw "Dynamic widget doesn't exist on node".
//
// add_node and load-of-saved-workflow share reconcileFreshDynamicWidgets /
// reconcileGraphDynamicWidgets. These tests fail on the duplicate/orphan set
// and pass on the shipped nested set.

import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileFreshDynamicWidgets,
  reconcileGraphDynamicWidgets,
  nestedDynamicComboChildNames,
  describeOrphanDynamicWidgets,
  isDynamicWidgetMissingError,
  installGraphToPromptDynamicReconcile,
} from "../../web/js/lib/dynamic-widget-reconcile.js";

const DYNAMIC = "COMFY_DYNAMICCOMBO_V3";

function codecSpec(optionalHidden = false) {
  const spec = [
    DYNAMIC,
    {
      options: [
        { key: "auto", inputs: {} },
        {
          key: "h264",
          inputs: {
            required: {
              encoding: [
                DYNAMIC,
                {
                  options: [
                    { key: "auto", inputs: {} },
                    { key: "re-encode", inputs: { required: { crf: ["FLOAT", { default: 23 }] } } },
                  ],
                },
              ],
            },
          },
        },
      ],
      ...(optionalHidden ? { hidden: true } : {}),
    },
  ];
  return spec;
}

/** Current ComfyUI SaveVideo: `format` is the required DynamicCombo; `codec` is nested. */
function nestedFormatDef({ hiddenCodec = true } = {}) {
  const def = {
    name: "SaveVideo",
    input: {
      required: {
        video: ["VIDEO"],
        filename_prefix: ["STRING", { default: "video/ComfyUI" }],
        format: [
          DYNAMIC,
          {
            options: [
              { key: "auto", inputs: { required: { codec: codecSpec() } } },
              { key: "mp4", inputs: { required: { codec: codecSpec() } } },
            ],
          },
        ],
      },
    },
  };
  if (hiddenCodec) {
    def.input.optional = { codec: codecSpec(true) };
  }
  return def;
}

/** #2254 schema: ordinary `format` plus required DynamicCombo `codec`. */
function legacyCodecDef() {
  return {
    name: "SaveVideo",
    input: {
      required: {
        video: ["VIDEO"],
        filename_prefix: ["STRING", { default: "video/ComfyUI" }],
        format: [["auto", "mp4"], { default: "auto" }],
        codec: codecSpec(),
      },
    },
  };
}

function widgetStoreKey(nodeId, widget) {
  return `${nodeId}:${widget.name}`;
}

function makeNode({ def, extraWidgets = [], extraInputs = [], throwOn } = {}) {
  const store = new Map();
  const storeEvents = [];
  const node = {
    id: 15,
    type: "SaveVideo",
    constructor: { nodeData: def },
    widgets: [],
    inputs: [],
    dynamicRebuilds: [],
    graph: true,
  };

  function deleteWidget(widgetId) {
    if (!widgetId) return false;
    const deleted = store.delete(widgetId);
    if (deleted) storeEvents.push({ type: "delete", widgetId });
    return deleted;
  }

  function registerWidget(widget, nodeId) {
    const widgetId = widgetStoreKey(nodeId, widget);
    store.set(widgetId, { value: widget.value });
    storeEvents.push({ type: "register", widgetId });
    return widgetId;
  }

  function installNativeDynamicCombo(widget, spec) {
    let value = widget.value;
    function rebuild() {
      for (let index = node.widgets.length - 1; index >= 0; index--) {
        const candidate = node.widgets[index];
        if (candidate !== widget && typeof candidate.name === "string" && candidate.name.startsWith(`${widget.name}.`)) {
          candidate.onRemove?.();
          deleteWidget(candidate.widgetId);
          node.widgets.splice(index, 1);
        }
      }
      for (let index = node.inputs.length - 1; index >= 0; index--) {
        if (node.inputs[index].name.startsWith(`${widget.name}.`)) node.inputs.splice(index, 1);
      }
      const option =
        spec?.[1]?.options?.find((entry) => entry.key === value) ?? spec?.[1]?.options?.[0];
      const required = option?.inputs?.required ?? {};
      for (const [childName, childSpec] of Object.entries(required)) {
        const childWidgetName = `${widget.name}.${childName}`;
        const child = node.addWidget(
          "combo",
          childWidgetName,
          Array.isArray(childSpec) && childSpec[0] === DYNAMIC
            ? childSpec[1]?.options?.[0]?.key ?? "auto"
            : childSpec?.[1]?.default ?? "auto",
          null,
          {},
        );
        if (Array.isArray(childSpec) && childSpec[0] === DYNAMIC) {
          installNativeDynamicCombo(child, childSpec);
        }
        node.inputs.push({ name: childWidgetName, type: DYNAMIC, link: null });
      }
    }
    Object.defineProperty(widget, "value", {
      configurable: true,
      get() {
        return store.get(widget.widgetId)?.value ?? value;
      },
      set(next) {
        const state = store.get(widget.widgetId);
        if (state) state.value = next;
        value = next;
        node.dynamicRebuilds.push(widget.name);
        if (throwOn && widget.name === throwOn) {
          throwOn = null;
          throw new Error("native rebuild failed");
        }
        rebuild();
      },
    });
    widget.value = value;
  }

  node.addWidget = function addWidget(kind, name, value, callback, options) {
    let boundNodeId = node.id;
    const widget = {
      type: kind,
      name,
      value,
      callback,
      options: options ?? {},
      onRemove() {},
    };
    Object.defineProperty(widget, "widgetId", {
      configurable: true,
      get() {
        return boundNodeId == null ? null : widgetStoreKey(boundNodeId, widget);
      },
    });
    widget.setNodeId = (nodeId) => {
      boundNodeId = nodeId;
      registerWidget(widget, nodeId);
    };
    node.widgets.push(widget);
    registerWidget(widget, node.id);
    return widget;
  };

  for (const [name, spec] of Object.entries(def.input?.required ?? {})) {
    const declared = Array.isArray(spec) ? spec[0] : null;
    if (declared === DYNAMIC) {
      const widget = node.addWidget("combo", name, spec[1]?.options?.[0]?.key ?? "auto", null, {});
      installNativeDynamicCombo(widget, spec);
      node.inputs.push({ name, type: DYNAMIC, link: null });
    } else if (Array.isArray(declared)) {
      node.addWidget("combo", name, declared[0], null, { values: declared });
    } else if (declared === "STRING") {
      node.addWidget("text", name, spec[1]?.default ?? "", null, {});
    } else {
      node.inputs.push({ name, type: declared, link: null });
    }
  }
  for (const extra of extraWidgets) {
    const widget = node.addWidget("combo", extra.name, extra.value ?? "auto", null, {});
    if (extra.dynamic) installNativeDynamicCombo(widget, extra.spec ?? codecSpec());
    node.inputs.push({ name: extra.name, type: DYNAMIC, link: extra.link ?? null });
  }
  for (const extra of extraInputs) node.inputs.push(extra);

  function graphToPrompt() {
    if (node.widgets.some((widget) => widget.name === "codec") || node.inputs.some((input) => input.name === "codec")) {
      throw new Error("Dynamic widget doesn't exist on node");
    }
    const format = node.widgets.find((widget) => widget.name === "format");
    const nested = node.widgets.find((widget) => widget.name === "format.codec");
    if (!format || !nested) throw new Error("nested format.codec is missing");
    return {
      output: {
        [node.id]: {
          class_type: "SaveVideo",
          inputs: { format: format.value, codec: nested.value },
        },
      },
    };
  }

  return { node, store, storeEvents, graphToPrompt };
}

test("#1931: the duplicate set (format.codec AND codec) is not queueable", () => {
  const { graphToPrompt } = makeNode({
    def: nestedFormatDef(),
    extraWidgets: [{ name: "codec", dynamic: true }],
  });
  assert.throws(graphToPrompt, /Dynamic widget doesn't exist on node/);
});

test("#1931: reconcile drops the orphan codec and keeps nested format.codec", () => {
  const def = nestedFormatDef();
  const { node, store, graphToPrompt } = makeNode({
    def,
    extraWidgets: [{ name: "codec", dynamic: true }],
  });

  assert.ok(node.widgets.some((widget) => widget.name === "format.codec"));
  assert.ok(node.widgets.some((widget) => widget.name === "codec"));

  const result = reconcileFreshDynamicWidgets(node, def);
  assert.equal(result.failures.length, 0, result.failures.map((f) => `${f.name}:${f.phase}`).join(", "));
  assert.ok(result.relocated.includes("codec"), "the bare codec is relocated into format's group");
  assert.deepEqual(
    node.widgets.map((widget) => widget.name).filter((name) => !name.includes("__cmcp_")),
    ["filename_prefix", "format", "format.codec"],
  );
  assert.equal(node.inputs.some((input) => input.name === "codec"), false);
  assert.equal(node.inputs.some((input) => input.name === "format.codec"), true);
  assert.equal([...store.keys()].some((key) => key.endsWith(":codec")), false);

  const prompt = graphToPrompt();
  assert.equal(prompt.output[15].inputs.format, "auto");
  assert.equal(prompt.output[15].inputs.codec, "auto");
});

test("#1931: the shipped nested set is left alone and stays queueable", () => {
  const def = nestedFormatDef({ hiddenCodec: false });
  const { node, graphToPrompt } = makeNode({ def });

  assert.deepEqual(
    node.widgets.map((widget) => widget.name),
    ["filename_prefix", "format", "format.codec"],
  );
  const result = reconcileFreshDynamicWidgets(node, def);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.relocated, []);
  assert.deepEqual(
    node.widgets.map((widget) => widget.name),
    ["filename_prefix", "format", "format.codec"],
  );
  const prompt = graphToPrompt();
  assert.equal(prompt.output[15].inputs.codec, "auto");
});

test("#1931: orphan codec descendants (codec.encoding) are removed with the orphan root", () => {
  const def = nestedFormatDef();
  const { node } = makeNode({
    def,
    extraWidgets: [{ name: "codec", dynamic: true, value: "h264" }],
  });
  // The hidden codec DynamicCombo builds codec.encoding for h264.
  assert.ok(node.widgets.some((widget) => widget.name === "codec"));
  assert.ok(node.widgets.some((widget) => widget.name === "codec.encoding"));

  const result = reconcileFreshDynamicWidgets(node, def);
  assert.equal(result.failures.length, 0);
  const names = node.widgets.map((widget) => widget.name).filter((name) => !name.includes("__cmcp_"));
  assert.equal(names.includes("codec"), false);
  assert.equal(names.includes("codec.encoding"), false);
  assert.equal(names.includes("format.codec"), true);
});

test("#1931: a loaded graph is cleaned by the shared materialiser", () => {
  const def = nestedFormatDef();
  const { node, graphToPrompt } = makeNode({
    def,
    extraWidgets: [{ name: "codec", dynamic: true }],
  });
  const graph = { _nodes: [node] };
  assert.throws(graphToPrompt, /Dynamic widget doesn't exist on node/);

  const results = reconcileGraphDynamicWidgets(graph);
  assert.equal(results.length, 1);
  assert.equal(results[0].failures.length, 0);
  assert.deepEqual(
    node.widgets.map((widget) => widget.name).filter((name) => !name.includes("__cmcp_")),
    ["filename_prefix", "format", "format.codec"],
  );
  assert.doesNotThrow(graphToPrompt);
});

test("#1931: nested subgraphs are walked on load", () => {
  const def = nestedFormatDef();
  const inner = makeNode({
    def,
    extraWidgets: [{ name: "codec", dynamic: true }],
  });
  inner.node.id = 7;
  const host = {
    id: 1,
    type: "Subgraph",
    constructor: { nodeData: { input: { required: {} } } },
    widgets: [],
    subgraph: { _nodes: [inner.node] },
  };
  const results = reconcileGraphDynamicWidgets({ _nodes: [host] });
  assert.ok(results.length >= 1);
  assert.equal(
    inner.node.widgets.some((widget) => widget.name === "codec"),
    false,
    "the inner SaveVideo orphan is cleaned",
  );
  assert.equal(inner.node.widgets.some((widget) => widget.name === "format.codec"), true);
});

test("#1931: a saved nested codec value survives orphan cleanup", () => {
  const def = nestedFormatDef();
  const { node } = makeNode({
    def,
    extraWidgets: [{ name: "codec", dynamic: true }],
  });
  const nested = node.widgets.find((widget) => widget.name === "format.codec");
  nested.value = "h264";
  assert.equal(nested.value, "h264");

  reconcileFreshDynamicWidgets(node, def);
  const after = node.widgets.find((widget) => widget.name === "format.codec");
  assert.ok(after);
  assert.equal(after.value, "h264");
  assert.equal(node.widgets.some((widget) => widget.name === "codec"), false);
});

test("#2254: stale format.codec is still removed when codec is the required root", () => {
  const def = legacyCodecDef();
  const { node } = makeNode({
    def,
    extraWidgets: [{ name: "format.codec", dynamic: true }],
  });
  // format is an ordinary combo here; format.codec is leftover from the old construction.
  const result = reconcileFreshDynamicWidgets(node, def);
  assert.equal(result.failures.length, 0);
  assert.ok(result.relocated.includes("format.codec"));
  assert.equal(node.widgets.some((widget) => widget.name === "format.codec"), false);
  assert.equal(node.widgets.some((widget) => widget.name === "codec"), true);
});

test("#1931: nested DynamicCombo children are codec/encoding/crf, not top-level format", () => {
  const names = nestedDynamicComboChildNames(nestedFormatDef());
  assert.equal(names.has("codec"), true);
  assert.equal(names.has("encoding"), true);
  assert.equal(names.has("format"), false);
  assert.equal(nestedDynamicComboChildNames(legacyCodecDef()).has("codec"), false);
});

test("#1931: describeOrphanDynamicWidgets names the SaveVideo duplicate set", () => {
  const { node } = makeNode({
    def: nestedFormatDef(),
    extraWidgets: [{ name: "codec", dynamic: true }],
  });
  const found = describeOrphanDynamicWidgets({ _nodes: [node] });
  assert.equal(found.length, 1);
  assert.equal(found[0].nodeId, 15);
  assert.equal(found[0].nodeType, "SaveVideo");
  assert.equal(found[0].orphan, "codec");
  assert.equal(found[0].nested, "format.codec");
});

test("#1931: a loaded graph keyed on graph.nodes is still cleaned", () => {
  const def = nestedFormatDef();
  const { node, graphToPrompt } = makeNode({
    def,
    extraWidgets: [{ name: "codec", dynamic: true }],
  });
  assert.throws(graphToPrompt, /Dynamic widget doesn't exist on node/);
  reconcileGraphDynamicWidgets({ nodes: [node] });
  assert.equal(node.widgets.some((widget) => widget.name === "codec"), false);
  assert.doesNotThrow(graphToPrompt);
});

test("#1931: a prototype value setter still counts as a dynamic root", () => {
  const def = nestedFormatDef({ hiddenCodec: false });
  const { node } = makeNode({ def });
  const format = node.widgets.find((widget) => widget.name === "format");
  const own = Object.getOwnPropertyDescriptor(format, "value");
  delete format.value;
  const proto = Object.create(Object.getPrototypeOf(format));
  Object.defineProperty(proto, "value", own);
  Object.setPrototypeOf(format, proto);
  const result = reconcileFreshDynamicWidgets(node, def);
  assert.equal(result.failures.length, 0);
  assert.ok(result.replayed.includes("format"));
});

test("#1931: the serializer wrap drops the orphan before graphToPrompt", async () => {
  const def = nestedFormatDef();
  const { node, graphToPrompt } = makeNode({
    def,
    extraWidgets: [{ name: "codec", dynamic: true }],
  });
  const app = { graph: { _nodes: [node] }, graphToPrompt };
  assert.equal(installGraphToPromptDynamicReconcile(app), true);
  const prompt = await app.graphToPrompt();
  assert.equal(node.widgets.some((widget) => widget.name === "codec"), false);
  assert.equal(prompt.output[15].inputs.codec, "auto");
});

test("#1931: a first-serialize DynamicCombo throw is retried after reconcile", async () => {
  const def = nestedFormatDef();
  const { node, graphToPrompt } = makeNode({
    def,
    extraWidgets: [{ name: "codec", dynamic: true }],
  });
  let calls = 0;
  const app = {
    graph: { _nodes: [node] },
    graphToPrompt() {
      calls += 1;
      if (calls === 1) throw new Error("Dynamic widget doesn't exist on node");
      return graphToPrompt();
    },
  };
  installGraphToPromptDynamicReconcile(app);
  const prompt = await app.graphToPrompt();
  assert.equal(calls, 2);
  assert.equal(node.widgets.some((widget) => widget.name === "codec"), false);
  assert.equal(prompt.output[15].inputs.codec, "auto");
});

test("#1931: a persistent serializer throw names the SaveVideo node and orphan", async () => {
  const def = nestedFormatDef();
  const { node } = makeNode({
    def,
    extraWidgets: [{ name: "codec", dynamic: true }],
  });
  const codec = node.widgets.find((widget) => widget.name === "codec");
  Object.defineProperty(codec, "name", { configurable: true, writable: false, value: "codec" });
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
      assert.match(error.message, /SaveVideo node 15/);
      assert.match(error.message, /format\.codec/);
      assert.match(error.message, /orphan codec/);
      return true;
    },
  );
});

test("#1931: the serializer wrap is idempotent", () => {
  const app = { graphToPrompt: async () => ({ output: {} }) };
  const first = app.graphToPrompt;
  assert.equal(installGraphToPromptDynamicReconcile(app), true);
  const wrapped = app.graphToPrompt;
  assert.notEqual(wrapped, first);
  assert.equal(installGraphToPromptDynamicReconcile(app), true);
  assert.equal(app.graphToPrompt, wrapped);
  assert.equal(installGraphToPromptDynamicReconcile({}), false);
  assert.equal(installGraphToPromptDynamicReconcile(null), false);
});
