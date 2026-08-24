// panel#1523 — `panel_add_node` of a subgraph UUID already loaded in the live
// workflow rejected it as an unknown backend node and appended an unrelated
// `comfyui-reactor-node FAILED TO IMPORT`.
//
// Subgraph types are never in /object_info (registerSubgraphNodeDef synthesizes
// the class from the workflow's definitions). The add-node guard's backend
// oracle therefore cannot authorize them, and the missing-type diagnostic
// named whichever pack happened to fail import.
//
// THE HARNESS runs the SHIPPED `graph_add_node` body, extracted from the panel
// source — the same technique as add-node-schema-auto-refresh.test.mjs. A
// helper-only test could not have caught a wiring miss of `getRootGraph`.

import test from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyCurrentDefWidgetValues,
  driftedRequiredInputNames,
  missingRequiredWidgetMaterializations,
  registeredSocketTypes,
  unavailableRequiredWidgetMessage,
  unavailableRequiredWidgetReport,
} from "../../web/js/lib/node-widget-materialization.js";
import {
  assertAddNodeResolvableRefreshing,
  isRegisteredNodeType,
  subgraphUuidAddRefusal,
} from "../../web/js/lib/node-resolve.js";
import { fetchSingleNodeInfo } from "../../web/js/lib/single-node-def.js";
import {
  describeUnmaterializedRequiredWidgets,
  snapshotBackendDef,
} from "../../web/js/lib/add-node-widget-guard.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const addNodeMatch = panelSrc.match(
  /\n {2}async graph_add_node\(\{ class_type, pos, title \}\) \{[\s\S]*?\n {2}\},/,
);
assert.ok(addNodeMatch, "could not locate graph_add_node in panel source");

const awaitWidgetsMatch = panelSrc.match(
  /\nasync function awaitRequiredCustomWidgetRegistration\([\s\S]*?\n\}/,
);
assert.ok(awaitWidgetsMatch, "could not locate awaitRequiredCustomWidgetRegistration");

const placementMatch = panelSrc.match(/\nfunction placementFor\(graph, pos\) \{[\s\S]*?\n\}/);
assert.ok(placementMatch, "could not locate placementFor");

const boundedMatch = panelSrc.match(/\nasync function boundedGetNodeDefs\([\s\S]*?\n\}/);
assert.ok(boundedMatch, "could not locate boundedGetNodeDefs in panel source");

import {
  NODE_DEFS_FETCH_TIMEOUT_MS,
  NODE_DEFS_NO_ANSWER,
  WIDEN_SOCKET_PROOF_TIMEOUT_MS,
  addNodeCommandBudgetDeps,
  monotonicNow,
} from "./_panel-constants.mjs";

/** The reporter's official core Image Segmentation (SAM3) subgraph type. */
const SAM3_UUID = "6e7ab3ea-96aa-470f-9b94-3d9d0e01f481";

function backendObjectInfo() {
  return {
    KSampler: {
      name: "KSampler",
      input: { required: { seed: ["INT", { default: 0 }] } },
      output: ["LATENT"],
    },
  };
}

function uuidSubgraphCtor(uuid) {
  const ctor = function ComfySubgraphNode() {};
  ctor.nodeData = { input: { required: {} }, name: uuid };
  ctor.comfyClass = uuid;
  return ctor;
}

function makeComfy({ loadSubgraph = true, registerSubgraph = true } = {}) {
  const widgets = {};
  const registry = {};
  let nextId = 1;

  const ctor = uuidSubgraphCtor(SAM3_UUID);
  if (registerSubgraph) registry[SAM3_UUID] = ctor;

  const LG = {
    registered_node_types: registry,
    createNode(type) {
      const cls = registry[type];
      if (!cls) return null;
      const node = {
        id: nextId++,
        type,
        constructor: cls,
        pos: [0, 0],
        size: [210, 100],
        widgets: [],
        inputs: [],
        outputs: [],
        addWidget(kind, name, value, callback, options) {
          const widget = { type: kind, name, value, callback, options: options ?? {} };
          node.widgets.push(widget);
          return widget;
        },
      };
      for (const [name, spec] of Object.entries(cls.nodeData?.input?.required ?? {})) {
        node.inputs.push({ name, type: Array.isArray(spec) ? spec[0] : spec });
      }
      return node;
    },
  };

  const app = {
    widgets,
    async registerNodesFromDefs(defs) {
      for (const [type, nodeData] of Object.entries(defs ?? {})) {
        const cls = function ComfyNode() {};
        cls.nodeData = nodeData;
        cls.comfyClass = type;
        registry[type] = cls;
      }
    },
  };

  const existing = {
    id: 1,
    type: SAM3_UUID,
    constructor: ctor,
    subgraph: { id: SAM3_UUID, _nodes: [] },
  };
  const graph = {
    _nodes: loadSubgraph ? [existing] : [],
    subgraphs: loadSubgraph ? new Map([[SAM3_UUID, existing.subgraph]]) : new Map(),
    add(node) {
      graph._nodes.push(node);
    },
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
  };

  return { app, LG, graph, registry };
}

function realGraphAddNode(comfy, overrides = {}) {
  const { app, LG, graph } = comfy;
  const context = { app, LG, graph, rootGraph: graph, workflow: { uuid: "wf" } };

  const api = {
    async getNodeDefs() {
      return backendObjectInfo();
    },
    async fetchApi(route) {
      const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
      const all = backendObjectInfo();
      const body = Object.prototype.hasOwnProperty.call(all, cls) ? { [cls]: all[cls] } : {};
      return { status: 200, json: async () => body };
    },
  };

  const deps = {
    captureGraphMutationContext: () => context,
    revalidateGraphMutationContext: () => context,
    getGraphCtx: () => context,
    awaitObjectInfoHistorySeed: async () => {},
    recordObjectInfoTypes: (defs) => defs,
    objectInfoHistory: { wasTypeEverDefined: () => false },
    objectInfoSnapshot: { record: () => true, clear: () => {} },
    backendReconnectEpoch: 0,
    readPackImportFailures: async () => ["comfyui-reactor-node"],
    api,
    refreshComfyNodeDefs: async () => ({ refreshed: true }),
    summarizeNode: (node) => ({ id: node.id, type: node.type }),
    assertAddNodeResolvableRefreshing,
    driftedRequiredInputNames,
    registeredSocketTypes,
    missingRequiredWidgetMaterializations,
    applyCurrentDefWidgetValues,
    unavailableRequiredWidgetReport,
    unavailableRequiredWidgetMessage,
    snapshotBackendDef,
    isRegisteredNodeType,
    fetchSingleNodeInfo,
    describeUnmaterializedRequiredWidgets,
    NODE_DEFS_NO_ANSWER,
    WIDEN_SOCKET_PROOF_TIMEOUT_MS,
    monotonicNow,
    NODE_DEFS_FETCH_TIMEOUT_MS,
    withTimeout,
    ...addNodeCommandBudgetDeps(),
    ...overrides,
  };

  if (!("boundedGetNodeDefs" in deps)) {
    const build = new Function(
      "api",
      "withTimeout",
      "NODE_DEFS_NO_ANSWER",
      "NODE_DEFS_FETCH_TIMEOUT_MS",
      `${boundedMatch[0]}
       return boundedGetNodeDefs;`,
    );
    deps.boundedGetNodeDefs = (timeoutMs) =>
      build(deps.api, withTimeout, NODE_DEFS_NO_ANSWER, NODE_DEFS_FETCH_TIMEOUT_MS)(timeoutMs);
  }

  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `${awaitWidgetsMatch[0]}
     ${placementMatch[0]}
     const CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS = 200;
     const CUSTOM_WIDGET_REGISTRATION_POLL_MS = 5;
     const executors = {${addNodeMatch[0]}};
     return executors.graph_add_node;`,
  );
  return { graph_add_node: factory(...names.map((n) => deps[n])), graph };
}

test("#1523 shipped graph_add_node: a loaded SAM3 subgraph UUID is added, not refused as a missing pack", async () => {
  const comfy = makeComfy({ loadSubgraph: true, registerSubgraph: true });
  const { graph_add_node, graph } = realGraphAddNode(comfy);
  const before = graph._nodes.length;

  const res = await graph_add_node({ class_type: SAM3_UUID });

  assert.equal(res.added.type, SAM3_UUID);
  assert.equal(graph._nodes.length, before + 1, "a new instance lands on the live graph");
  assert.equal(graph._nodes[graph._nodes.length - 1].type, SAM3_UUID);
});

test("#1523 shipped graph_add_node: an unloaded subgraph UUID is refused without naming ReActor", async () => {
  const comfy = makeComfy({ loadSubgraph: false, registerSubgraph: false });
  const { graph_add_node } = realGraphAddNode(comfy);

  const err = await graph_add_node({ class_type: SAM3_UUID }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "an unloaded UUID must still be refused");
  assert.equal(
    err.message,
    subgraphUuidAddRefusal(SAM3_UUID, { loaded: false, registered: false }),
  );
  assert.doesNotMatch(err.message, /comfyui-reactor-node/);
  assert.doesNotMatch(err.message, /FAILED TO IMPORT/);
  assert.doesNotMatch(err.message, /Unknown node type/);
});

test("#1523 shipped graph_add_node: loaded but unregistered UUID is refused with copy-instance advice", async () => {
  const comfy = makeComfy({ loadSubgraph: true, registerSubgraph: false });
  const { graph_add_node } = realGraphAddNode(comfy);

  const err = await graph_add_node({ class_type: SAM3_UUID }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "createNode would mint a placeholder — must refuse");
  assert.equal(
    err.message,
    subgraphUuidAddRefusal(SAM3_UUID, { loaded: true, registered: false }),
  );
  assert.doesNotMatch(err.message, /comfyui-reactor-node/);
});
