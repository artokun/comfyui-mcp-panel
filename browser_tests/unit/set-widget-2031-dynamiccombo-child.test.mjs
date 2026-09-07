/**
 * #2031 — panel_set_widget on a dotted FLOAT child of a live COMFY_DYNAMICCOMBO_V3
 * reports success and a follow-up read confirms the new value, but graphToPrompt
 * queues the OLD value.
 *
 * Frontend 1.51.9 (dynamicWidgets.ts): COMFY_DYNAMICCOMBO_V3 installs an own
 * `value` setter that DESTROYS and recreates dotted children from the option
 * spec's defaults. graphToPrompt then re-assigns the parent combo (Vue v-model /
 * serialize flush) even when the choice did not change, so a verified
 * `mode.scale` write is rebuilt from `default: 2` after the agent already saw 1.5.
 *
 * These drive runSetWidget() and the shipped graphToPrompt wrap — the same units
 * graph_set_widget / graph_run use. Fail unfixed (write accepted, serialize lost);
 * pass when the queued prompt matches the confirmed write.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { installGraphToPromptDynamicReconcile } from "../../web/js/lib/dynamic-widget-reconcile.js";

const DYNAMIC = "COMFY_DYNAMICCOMBO_V3";
const TYPE = "MinimaxH3LatentUpscaler3D";
const MODE = "scale by multiplier";
const REGISTRY = { [TYPE]: {} };
const FRESH = { [TYPE]: { input: { required: { mode: modeSpec() } } } };

function modeSpec() {
  return [
    DYNAMIC,
    {
      options: [
        {
          key: MODE,
          inputs: {
            required: {
              scale: ["FLOAT", { default: 2 }],
              prompt: ["STRING", { default: "keep" }],
            },
          },
        },
        {
          key: "scale by dimensions",
          inputs: {
            required: {
              width: ["INT", { default: 64 }],
            },
          },
        },
      ],
    },
  ];
}

function widgetOpts() {
  return {
    registry: REGISTRY,
    getFreshObjectInfo: async () => FRESH,
  };
}

/**
 * Native DynamicCombo shape from ComfyUI frontend 1.51.9: assigning the root
 * combo rebuilds dotted children from the selected option's spec defaults.
 * graphToPrompt re-assigns the root (same value) before reading widgets — the
 * serialize flush that silently dropped the FLOAT write.
 */
function makeUpscalerNode() {
  const def = { name: TYPE, input: { required: { mode: modeSpec() } } };
  const node = {
    id: 186,
    type: TYPE,
    constructor: { nodeData: def },
    nodeData: def,
    widgets: [],
    inputs: [],
  };

  function addWidget(kind, name, value) {
    const widget = { type: kind, name, value };
    node.widgets.push(widget);
    return widget;
  }

  function installNativeDynamicCombo(widget, spec) {
    let current = widget.value;
    function rebuild() {
      for (let index = node.widgets.length - 1; index >= 0; index--) {
        const candidate = node.widgets[index];
        if (candidate !== widget && typeof candidate.name === "string" && candidate.name.startsWith(`${widget.name}.`)) {
          node.widgets.splice(index, 1);
        }
      }
      for (let index = node.inputs.length - 1; index >= 0; index--) {
        if (node.inputs[index].name.startsWith(`${widget.name}.`)) node.inputs.splice(index, 1);
      }
      const option = spec?.[1]?.options?.find((entry) => entry.key === current) ?? spec?.[1]?.options?.[0];
      const required = option?.inputs?.required ?? {};
      for (const [childName, childSpec] of Object.entries(required)) {
        const childWidgetName = `${widget.name}.${childName}`;
        const declared = Array.isArray(childSpec) ? childSpec[0] : null;
        const childType = declared === "FLOAT" || declared === "INT" ? "number" : declared === DYNAMIC ? "combo" : "text";
        const childDefault =
          declared === DYNAMIC ? childSpec[1]?.options?.[0]?.key ?? "auto" : childSpec?.[1]?.default ?? (childType === "number" ? 0 : "");
        addWidget(childType, childWidgetName, childDefault);
        node.inputs.push({ name: childWidgetName, type: declared, link: null });
      }
    }
    Object.defineProperty(widget, "value", {
      configurable: true,
      enumerable: true,
      get() {
        return current;
      },
      set(next) {
        current = next;
        rebuild();
      },
    });
    widget.value = current;
  }

  const mode = addWidget("combo", "mode", MODE);
  mode.options = { values: [MODE, "scale by dimensions"] };
  node.inputs.push({ name: "mode", type: DYNAMIC, link: null });
  installNativeDynamicCombo(mode, modeSpec());

  function nativeGraphToPrompt() {
    // The frontend reserializes the combo before reading widgets, even when the
    // selected option did not change. That rebuild is the silent revert.
    const root = node.widgets.find((widget) => widget.name === "mode");
    root.value = root.value;
    const inputs = {};
    for (const widget of node.widgets) {
      if (typeof widget?.name === "string") inputs[widget.name] = widget.value;
    }
    return {
      output: {
        [node.id]: { class_type: TYPE, inputs },
      },
      workflow: {},
    };
  }

  const app = {
    graph: { _nodes: [node] },
    graphToPrompt: nativeGraphToPrompt,
  };

  return { node, app, nativeGraphToPrompt };
}

function childValue(node, name) {
  return node.widgets.find((widget) => widget.name === name)?.value;
}

test("#2031 unfixed shape: a direct FLOAT child assign is readable, then lost at native serialize", () => {
  const { node, nativeGraphToPrompt } = makeUpscalerNode();
  assert.equal(childValue(node, "mode.scale"), 2);

  const child = node.widgets.find((widget) => widget.name === "mode.scale");
  child.value = 1.5;
  assert.equal(childValue(node, "mode.scale"), 1.5, "query-style readback confirms the write");

  const queued = nativeGraphToPrompt();
  assert.equal(
    queued.output[186].inputs["mode.scale"],
    2,
    "native serialize rebuilds the combo from spec defaults and drops the FLOAT write",
  );
});

test("#2031 a same-value parent flush after set_widget keeps the FLOAT child without waiting for graphToPrompt", async () => {
  const { node } = makeUpscalerNode();

  const result = await runSetWidget(node, "mode.scale", 1.5, widgetOpts());
  assert.equal(result.set.value, 1.5);
  assert.equal(childValue(node, "mode.scale"), 1.5);

  const root = node.widgets.find((widget) => widget.name === "mode");
  root.value = root.value;
  assert.equal(
    childValue(node, "mode.scale"),
    1.5,
    "Vue/widget-store flush after set must not revert the child before query_graph",
  );
});

test("#2031 the shipped set-widget / serialize path queues the confirmed FLOAT child", async () => {
  const { node, app } = makeUpscalerNode();

  const result = await runSetWidget(node, "mode.scale", 1.5, widgetOpts());
  assert.equal(result.set.value, 1.5);
  assert.equal(childValue(node, "mode.scale"), 1.5);

  assert.equal(installGraphToPromptDynamicReconcile(app), true);
  const prompt = await app.graphToPrompt();
  assert.equal(
    prompt.output[186].inputs["mode.scale"],
    1.5,
    "queued prompt must match the confirmed write, not the combo default",
  );
  assert.equal(prompt.output[186].inputs.mode, MODE);
  assert.equal(childValue(node, "mode.scale"), 1.5);
});

test("#2031 a same-value combo reserialize after wrap does not drop STRING children either", async () => {
  const { node, app } = makeUpscalerNode();
  const written = await runSetWidget(node, "mode.prompt", "new prompt", widgetOpts());
  assert.equal(written.set.value, "new prompt");
  assert.equal(childValue(node, "mode.prompt"), "new prompt");

  installGraphToPromptDynamicReconcile(app);
  const prompt = await app.graphToPrompt();
  assert.equal(prompt.output[186].inputs["mode.prompt"], "new prompt");
});

test("#2031 changing the parent combo still rebuilds from the new option", async () => {
  const { node, app } = makeUpscalerNode();
  await runSetWidget(node, "mode.scale", 1.5, widgetOpts());
  installGraphToPromptDynamicReconcile(app);

  const mode = node.widgets.find((widget) => widget.name === "mode");
  mode.value = "scale by dimensions";
  assert.equal(childValue(node, "mode.scale"), undefined, "old option children must not survive an option change");
  assert.equal(childValue(node, "mode.width"), 64);

  const prompt = await app.graphToPrompt();
  assert.equal(prompt.output[186].inputs.mode, "scale by dimensions");
  assert.equal(prompt.output[186].inputs["mode.width"], 64);
  assert.equal(prompt.output[186].inputs["mode.scale"], undefined);
});

test("#2031 an ordinary FLOAT widget is unchanged", async () => {
  const node = {
    id: 1,
    type: TYPE,
    widgets: [{ name: "strength", type: "number", value: 2 }],
  };
  const result = await runSetWidget(node, "strength", 1.5, widgetOpts());
  assert.equal(result.set.value, 1.5);
  assert.equal(node.widgets[0].value, 1.5);
});
