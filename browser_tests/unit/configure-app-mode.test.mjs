// Coverage for #1429: graph_configure_app_mode writes extra.linearData /
// extra.linearMode on the live root without replacing extra or touching
// extra.comfyui_mcp. Validation refuses unknown ids/widgets before opening
// the undo envelope.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  APP_MODE_META_NAMESPACE,
  configureAppMode,
  mergeAppModeExtra,
  parseAppModeArgs,
  validateAppModeTargets,
} from "../../web/js/lib/configure-app-mode.js";
import { normalizedCanvasDs } from "../../web/js/lib/canvas-ds.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

function makeNode(id, widgetNames, { widgetIdFor } = {}) {
  return {
    id,
    widgets: widgetNames.map((name) => {
      const widget = { name };
      if (widgetIdFor && widgetIdFor[name]) widget.widgetId = widgetIdFor[name];
      return widget;
    }),
  };
}

function makeGraph(nodes, extra = {}) {
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const calls = { before: 0, after: 0, dirty: 0 };
  return {
    extra: { ...extra },
    calls,
    beforeChange() { calls.before += 1; },
    afterChange() { calls.after += 1; },
    setDirtyCanvas() { calls.dirty += 1; },
    getNodeById(id) { return byId.get(String(id)) ?? null; },
  };
}

function resolverFor(graph) {
  return (_g, id) => {
    const node = graph.getNodeById(id);
    if (!node) throw new Error(`No node with id ${id} in the current graph`);
    return node;
  };
}

test("#1429 parseAppModeArgs requires at least one field", () => {
  assert.throws(() => parseAppModeArgs({}), /inputs, outputs, and\/or default_mode/);
});

test("#1429 parseAppModeArgs refuses a bad default_mode before any write", () => {
  assert.throws(() => parseAppModeArgs({ default_mode: true }), /"graph" or "app"/);
  assert.throws(() => parseAppModeArgs({ default_mode: "linear" }), /"graph" or "app"/);
});

test("#1429 parseAppModeArgs refuses duplicate inputs and outputs", () => {
  assert.throws(
    () => parseAppModeArgs({ inputs: [{ node_id: 6, widget: "text" }, { node_id: 6, widget: "text" }] }),
    /more than once/,
  );
  assert.throws(() => parseAppModeArgs({ outputs: [9, 9] }), /more than once/);
});

test("#1429 validateAppModeTargets names every unknown id and widget", () => {
  const prompt = makeNode(6, ["text"]);
  const graph = makeGraph([prompt]);
  assert.throws(
    () =>
      validateAppModeTargets({
        rootGraph: graph,
        resolveNode: resolverFor(graph),
        inputs: [{ node_id: 6, widget: "texxt" }, { node_id: 99, widget: "seed" }],
        outputs: [9],
      }),
    /unknown App Mode inputs:.*no widget "texxt".*node 99.*unknown App Mode outputs:.*9/,
  );
  assert.equal(graph.calls.before, 0);
});

test("#1429 merge never replaces extra and never writes comfyui_mcp", () => {
  const stamp = { workflow_uuid: "wf-live", workflow_path: "a.json" };
  const extra = {
    comfyui_mcp: stamp,
    ds: { scale: 1, offset: [0, 0] },
    linearData: { inputs: [[1, "old"]], outputs: [2], other: true },
    linearMode: false,
  };
  const same = extra;
  mergeAppModeExtra(extra, {
    inputTuples: [[6, "text"]],
    outputIds: [9],
    defaultMode: "app",
  });
  assert.equal(extra, same, "extra object identity must be preserved");
  assert.equal(extra.comfyui_mcp, stamp);
  assert.deepEqual(extra.comfyui_mcp, { workflow_uuid: "wf-live", workflow_path: "a.json" });
  assert.deepEqual(extra.ds, { scale: 1, offset: [0, 0] });
  assert.equal(extra.linearData.other, true, "unrelated linearData keys stay");
  assert.deepEqual(extra.linearData.inputs, [[6, "text"]]);
  assert.deepEqual(extra.linearData.outputs, [9]);
  assert.equal(extra.linearMode, true);
});

test("#1429 configureAppMode writes tuples, one undo envelope, then captures", () => {
  const prompt = makeNode(6, ["text"]);
  const save = makeNode(9, ["filename_prefix"]);
  const extra = { comfyui_mcp: { workflow_uuid: "wf-A" }, ds: { scale: 0.8 } };
  const graph = makeGraph([prompt, save], extra);
  let captures = 0;
  let loaded = null;
  let captureDuringEnvelope = false;

  const result = configureAppMode({
    rootGraph: graph,
    resolveNode: resolverFor(graph),
    args: {
      inputs: [{ node_id: 6, widget: "text", config: { description: "Prompt" } }],
      outputs: [9],
      default_mode: "app",
    },
    captureCanvasState() {
      captures += 1;
      captureDuringEnvelope = graph.calls.before !== graph.calls.after;
    },
    loadSelections(data) { loaded = data; },
  });

  assert.equal(graph.calls.before, 1);
  assert.equal(graph.calls.after, 1);
  assert.equal(graph.calls.dirty, 1);
  assert.equal(captures, 1);
  assert.equal(captureDuringEnvelope, false, "captureCanvasState must run after afterChange");
  assert.equal(graph.extra.comfyui_mcp.workflow_uuid, "wf-A");
  assert.deepEqual(graph.extra.ds, { scale: 0.8, offset: [0, 0] });
  assert.deepEqual(graph.extra.linearData.inputs, [[6, "text", { description: "Prompt" }]]);
  assert.deepEqual(graph.extra.linearData.outputs, [9]);
  assert.equal(graph.extra.linearMode, true);
  assert.equal(loaded, graph.extra.linearData);
  assert.equal(result.default_mode, "app");
  assert.equal(result.preserved_meta, true);
  assert.equal(result.linearMode, true);
});

test("#1655 configureAppMode repairs malformed persisted canvas metadata", () => {
  const graph = makeGraph([], { ds: { scale: null, offset: [null, null] } });

  configureAppMode({
    rootGraph: graph,
    resolveNode: resolverFor(graph),
    args: { default_mode: "app" },
  });

  assert.deepEqual(graph.extra.ds, { scale: 1, offset: [0, 0] });
});

test("#1655 normalizedCanvasDs defaults malformed and typed viewport values", () => {
  assert.deepEqual(normalizedCanvasDs({ scale: 0, offset: Float32Array.of(NaN, Infinity) }), {
    scale: 1,
    offset: [0, 0],
  });
  assert.deepEqual(normalizedCanvasDs({ scale: 0.8, offset: [12, -4] }), {
    scale: 0.8,
    offset: [12, -4],
  });
});

test("#1429 configureAppMode prefers a live widgetId when the frontend assigned one", () => {
  const widgetId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:6:text";
  const prompt = makeNode(6, ["text"], { widgetIdFor: { text: widgetId } });
  const graph = makeGraph([prompt], { comfyui_mcp: { workflow_uuid: "wf-B" } });

  const result = configureAppMode({
    rootGraph: graph,
    resolveNode: resolverFor(graph),
    args: { inputs: [{ node_id: 6, widget: "text" }] },
  });

  assert.deepEqual(result.linearData.inputs, [[widgetId, "text"]]);
  assert.equal(graph.extra.comfyui_mcp.workflow_uuid, "wf-B");
});

test("#1429 partial update leaves the omitted field and linearMode alone", () => {
  const prompt = makeNode(6, ["text"]);
  const save = makeNode(9, []);
  const graph = makeGraph([prompt, save], {
    comfyui_mcp: { workflow_uuid: "wf-C" },
    linearData: { inputs: [[6, "text"]], outputs: [9] },
    linearMode: true,
  });

  configureAppMode({
    rootGraph: graph,
    resolveNode: resolverFor(graph),
    args: { outputs: [9] },
  });

  assert.deepEqual(graph.extra.linearData.inputs, [[6, "text"]]);
  assert.deepEqual(graph.extra.linearData.outputs, [9]);
  assert.equal(graph.extra.linearMode, true);
});

test("#1429 a validation miss does not open the undo envelope or write extra", () => {
  const prompt = makeNode(6, ["text"]);
  const graph = makeGraph([prompt], { comfyui_mcp: { workflow_uuid: "wf-D" } });
  let captures = 0;
  assert.throws(
    () =>
      configureAppMode({
        rootGraph: graph,
        resolveNode: resolverFor(graph),
        args: { inputs: [{ node_id: 6, widget: "missing" }] },
        captureCanvasState() { captures += 1; },
      }),
    /no widget "missing"/,
  );
  assert.equal(graph.calls.before, 0);
  assert.equal(graph.calls.after, 0);
  assert.equal(captures, 0);
  assert.equal(graph.extra.linearData, undefined);
  assert.equal(graph.extra.comfyui_mcp.workflow_uuid, "wf-D");
});

test("#1429 empty inputs/outputs clear those arrays", () => {
  const graph = makeGraph([], {
    linearData: { inputs: [[6, "text"]], outputs: [9] },
    linearMode: true,
  });
  configureAppMode({
    rootGraph: graph,
    resolveNode: resolverFor(graph),
    args: { inputs: [], outputs: [] },
  });
  assert.deepEqual(graph.extra.linearData.inputs, []);
  assert.deepEqual(graph.extra.linearData.outputs, []);
  assert.equal(graph.extra.linearMode, true);
});

test("#1429 default_mode only does not create empty linearData", () => {
  const graph = makeGraph([], { comfyui_mcp: { workflow_uuid: "wf-E" } });
  const result = configureAppMode({
    rootGraph: graph,
    resolveNode: resolverFor(graph),
    args: { default_mode: "graph" },
  });
  assert.equal(graph.extra.linearMode, false);
  assert.equal(graph.extra.linearData, undefined);
  assert.equal(result.default_mode, "graph");
  assert.equal(graph.extra.comfyui_mcp.workflow_uuid, "wf-E");
});

test("#1429 panel executor is wired to the shared lib and live-canvas capture", () => {
  assert.match(panelSrc, /import \{ configureAppMode \} from "\.\/lib\/configure-app-mode\.js"/);
  const start = panelSrc.indexOf("graph_configure_app_mode(args = {})");
  assert.ok(start > 0, "GRAPH_TOOL_EXECUTORS must expose graph_configure_app_mode");
  const body = panelSrc.slice(start, start + 900);
  assert.match(body, /configureAppMode\(/);
  assert.match(body, /captureCanvasState/);
  assert.match(body, /getPiniaStore\("appMode"\)/);
  assert.match(body, /loadSelections/);
  assert.doesNotMatch(body, /graph_load/);
  assert.doesNotMatch(panelSrc, /JSON\.parse[\s\S]{0,80}linearData/);
});
