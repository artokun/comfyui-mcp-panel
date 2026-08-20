/**
 * #874 remaining load path — `panel_load_workflow` (`graph_load`) of a saved
 * subgraph host.
 *
 * The on-disk JSON keeps the edited `widgets_values` / `widgets_values_named`.
 * ComfyUI's SubgraphNode.configure then reseeds the live host from INNER
 * definition widgets, so node 116 shows pack defaults for prompt / dimensions
 * / length / selectors while seed/fps can remain. The load still reports
 * `loaded:true`.
 *
 * This drives the SHIPPED `graph_load` body, with `loadGraphData` modelled as
 * that configure (live rails = definition defaults). After graph_load returns,
 * the live host must show the FILE's values — not a reimplementation of the
 * apply helper, and not a hardcoded expected list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { applySavedSubgraphHostWidgets } from "../../web/js/lib/subgraph-instance-widgets.js";
import { sanitizeNodesAuxId } from "../../web/js/lib/aux-id-sanitize.js";
import { resolveLoadGraphArgs } from "../../web/js/lib/session-rebind.js";
import {
  installNodeConfigureIsolation,
  retryNodeRestores,
} from "../../web/js/lib/load-restore-isolation.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const PANEL = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

const start = PANEL.indexOf("  async graph_load({ graph: incoming } = {}) {");
const end = PANEL.indexOf("\n\n  graph_connect(", start);
assert.notEqual(start, -1, "graph_load executor must still be recognisable");
assert.ok(end > start, "the executor that follows graph_load must still be recognisable");
const graphLoadSource = PANEL.slice(start, end);

const SG_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ROOT_GRAPH_ID = "c4a254bb-935e-4013-b380-5e36954de4b0";

/** The reporter's shape: a single-host Image-to-Video subgraph with edited host widgets. */
function savedWorkflow() {
  return {
    nodes: [
      {
        id: 116,
        type: SG_ID,
        widgets_values: [
          "a vaporwave alley at dusk",
          1280,
          704,
          81,
          "wan_high.safetensors",
          42,
          16,
        ],
        widgets_values_named: {
          prompt: "a vaporwave alley at dusk",
          width: 1280,
          height: 704,
          length: 81,
          unet_name: "wan_high.safetensors",
          seed: 42,
          fps: 16,
        },
      },
    ],
    definitions: {
      subgraphs: [
        {
          id: SG_ID,
          name: "Image to Video (Wan 2.2)",
          nodes: [
            {
              id: 10,
              type: "CLIPTextEncode",
              widgets_values: ["DEFINITION-DEFAULT-PROMPT"],
            },
          ],
        },
      ],
    },
  };
}

const DEFINITION_DEFAULTS = {
  prompt: "DEFINITION-DEFAULT-PROMPT",
  width: 832,
  height: 480,
  length: 49,
  unet_name: "wan_default.safetensors",
  seed: 0,
  fps: 16,
};

/**
 * What SubgraphNode.configure does: rails exist, widgetIds exist, values are
 * the INNER definition defaults — not the host's saved widgets_values_named.
 */
function configureHostFromDefinition(saved) {
  const def = saved.definitions.subgraphs[0];
  const named = saved.nodes[0].widgets_values_named;
  const inner = {
    id: def.nodes[0].id,
    type: def.nodes[0].type,
    widgets: [{ name: "prompt", value: def.nodes[0].widgets_values[0] }],
  };
  const subgraph = { id: SG_ID, _nodes: [inner] };
  const store = new Map();
  const rails = [];
  const inputs = [];
  for (const name of Object.keys(named)) {
    const widgetId = `${ROOT_GRAPH_ID}:${encodeURIComponent("116")}:${encodeURIComponent(name)}`;
    store.set(widgetId, { name, value: DEFINITION_DEFAULTS[name] });
    const rail = {
      name,
      get widgetId() {
        return widgetId;
      },
      get value() {
        return store.get(widgetId)?.value;
      },
      set value(next) {
        const state = store.get(widgetId);
        if (state) state.value = next;
      },
      callback(next) {
        const state = store.get(widgetId);
        if (state) state.value = next;
      },
    };
    rails.push(rail);
    inputs.push({ name, widgetId, _widget: rail });
  }
  const host = {
    id: 116,
    type: SG_ID,
    subgraph,
    inputs,
    get widgets() {
      return rails;
    },
  };
  return { host, inner, graph: { _nodes: [host] }, rail: (n) => rails.find((r) => r.name === n) };
}

function extractGraphLoad(getGraphCtx) {
  return new Function(
    "getGraphCtx",
    "assertGraphBoundToActiveWorkflow",
    "MUTATION_BINDING_BAR",
    "coerceMessageText",
    "looksLikeApiWorkflow",
    "sanitizeNodesAuxId",
    "captureGraphSnapshot",
    "resolveLoadGraphArgs",
    "installNodeConfigureIsolation",
    "retryNodeRestores",
    "loadLandedWorkflowUuid",
    "applySavedSubgraphHostWidgets",
    `const GRAPH_TOOL_EXECUTORS = {${graphLoadSource}\n}; return GRAPH_TOOL_EXECUTORS.graph_load;`,
  )(
    getGraphCtx,
    () => {},
    {},
    (v) => String(v ?? ""),
    () => false,
    sanitizeNodesAuxId,
    () => {},
    resolveLoadGraphArgs,
    installNodeConfigureIsolation,
    retryNodeRestores,
    () => null,
    applySavedSubgraphHostWidgets,
  );
}

test("#874 panel_load_workflow leaves the saved subgraph host widgets on the live host", async () => {
  const file = savedWorkflow();
  const live = configureHostFromDefinition(file);
  const app = {
    loadGraphData: async (payload) => {
      // The frontend load "succeeds" and leaves definition defaults on the host.
      assert.equal(payload.nodes[0].id, file.nodes[0].id);
      Object.assign(live.graph, { extra: payload.extra });
    },
    graph: live.graph,
    extensionManager: { workflow: { activeWorkflow: { path: "wan.json" } } },
  };
  const graphLoad = extractGraphLoad(() => ({
    app,
    graph: live.graph,
    rootGraph: live.graph,
    LG: null,
  }));

  assert.equal(live.rail("prompt").value, DEFINITION_DEFAULTS.prompt, "the bug: configure left the definition default");
  const reply = await graphLoad({ graph: file });
  assert.equal(reply.loaded, true);

  const saved = file.nodes[0].widgets_values_named;
  for (const [name, want] of Object.entries(saved)) {
    assert.equal(live.rail(name).value, want, `${name} must be the value the FILE carried`);
  }
  assert.equal(live.inner.widgets[0].value, file.definitions.subgraphs[0].nodes[0].widgets_values[0]);
});

test("#874 removing the post-load apply leaves the host at definition defaults", async () => {
  const file = savedWorkflow();
  const live = configureHostFromDefinition(file);
  const app = {
    loadGraphData: async () => {},
    graph: live.graph,
    extensionManager: { workflow: { activeWorkflow: { path: "wan.json" } } },
  };
  const graphLoad = extractGraphLoad(() => ({
    app,
    graph: live.graph,
    rootGraph: live.graph,
    LG: null,
  }));
  // Inject a no-op so this is the SAME executor with the apply stripped — the
  // semantic assertion the original #874 e2e required: the live host must carry
  // the file's prompt, not merely that a helper was named.
  const stripped = new Function(
    "getGraphCtx",
    "assertGraphBoundToActiveWorkflow",
    "MUTATION_BINDING_BAR",
    "coerceMessageText",
    "looksLikeApiWorkflow",
    "sanitizeNodesAuxId",
    "captureGraphSnapshot",
    "resolveLoadGraphArgs",
    "installNodeConfigureIsolation",
    "retryNodeRestores",
    "loadLandedWorkflowUuid",
    "applySavedSubgraphHostWidgets",
    `const GRAPH_TOOL_EXECUTORS = {${graphLoadSource}\n}; return GRAPH_TOOL_EXECUTORS.graph_load;`,
  )(
    () => ({ app, graph: live.graph, rootGraph: live.graph, LG: null }),
    () => {},
    {},
    (v) => String(v ?? ""),
    () => false,
    sanitizeNodesAuxId,
    () => {},
    resolveLoadGraphArgs,
    installNodeConfigureIsolation,
    retryNodeRestores,
    () => null,
    () => ({ restored: 0, skipped: 0 }),
  );
  await stripped({ graph: file });
  assert.equal(
    live.rail("prompt").value,
    DEFINITION_DEFAULTS.prompt,
    "without the apply, the host stays at the definition default the reporter saw",
  );
  await graphLoad({ graph: file });
  assert.equal(live.rail("prompt").value, file.nodes[0].widgets_values_named.prompt);
});
