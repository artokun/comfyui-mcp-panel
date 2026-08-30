/**
 * #1996 — panel_strip_workflow fails when MCP is newer than panel graph schema
 * support.
 *
 * Newer MCP (0.52.146+) converts the live canvas with `graph_serialize` then
 * `graph_get_object_info`. Two production holes:
 *
 *   1. `graph_get_object_info` was classified as a MUTATION and was not
 *      canvas-independent, so a dirty/unbound tab or a uuid-fence miss refused
 *      the schema read. Strip then failed with "too old for graph_get_object_info"
 *      (or a dirty-mutation refusal) even though the command exists.
 *   2. `graph_serialize` returned LiteGraph's positional `widgets_values` only.
 *      A newer graph schema (extra keys, version > 0.4, V3 nested widgets) must
 *      survive the capture, and name-keyed `capturedWidgetValues` must ride along
 *      so MCP can convert without agreeing on positional widget order.
 *
 * These tests drive the REAL helpers and pin the PANEL wiring, not a replica.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  attachCapturedWidgetValues,
  capturedWidgetValuesForNode,
  collectLiveNodes,
  serializeLiveGraph,
} from "../../web/js/lib/graph-serialize-capture.js";
import { commandIsCanvasIndependent, activeWorkflowFenceApplies } from "../../web/js/lib/workflow-chat-identity.js";
import { graphCommandMayMutateWorkflow, graphCommandBindingBar } from "../../web/js/lib/graph-binding.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PANEL = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");

function newerSchemaWorkflow(over = {}) {
  return {
    last_node_id: 1,
    last_link_id: 1,
    version: 1.2,
    extra: { frontendVersion: "1.49.9", future_mcp_schema: { nested: true } },
    nodes: [
      {
        id: 1,
        type: "KSampler",
        widgets_values: [7, "fixed"],
        future_v3_slot: { kind: "COMFY_DYNAMICCOMBO_V3" },
      },
    ],
    links: [{ id: 1, origin_id: 2, origin_slot: 0, target_id: 1, target_slot: 0, type: "MODEL" }],
    ...over,
  };
}

function liveSampler(over = {}) {
  return {
    id: 1,
    type: "KSampler",
    widgets: [
      { name: "seed", value: 7 },
      { name: "control_after_generate", value: "fixed" },
    ],
    ...over,
  };
}

test("#1996 graph_get_object_info is canvas-independent — strip cannot be uuid-fenced off the schema", () => {
  assert.equal(commandIsCanvasIndependent("graph_get_object_info"), true);
  assert.equal(activeWorkflowFenceApplies({ cmd: "graph_get_object_info" }), false);
  // A canvas capture still answers for the active workflow.
  assert.equal(commandIsCanvasIndependent("graph_serialize"), false);
  assert.equal(activeWorkflowFenceApplies({ cmd: "graph_serialize" }), true);
});

test("#1996 graph_get_object_info is a read, same bar as the capture it pairs with", () => {
  assert.equal(graphCommandMayMutateWorkflow("graph_get_object_info"), false);
  assert.deepEqual(
    graphCommandBindingBar("graph_get_object_info"),
    graphCommandBindingBar("graph_serialize"),
  );
});

test("#1996 the executor reads /object_info, not the canvas", () => {
  const start = PANEL.indexOf("async graph_get_object_info({ if_none_match } = {}) {");
  assert.ok(start >= 0, "graph_get_object_info must exist");
  const next = PANEL.indexOf("\n  graph_get_virtual_types()", start);
  const body = PANEL.slice(start, next > start ? next : start + 4000);
  assert.match(body, /fetchWholeObjectInfo/);
  assert.doesNotMatch(body, /getGraphCtx/);
});

test("#1996 graph_serialize uses serializeLiveGraph so extra schema fields and named widgets survive", () => {
  const start = PANEL.indexOf("graph_serialize() {");
  assert.ok(start >= 0, "graph_serialize must exist");
  const body = PANEL.slice(start, PANEL.indexOf("\n  graph_configure_app_mode", start));
  assert.match(body, /serializeLiveGraph\(rootGraph/);
  assert.doesNotMatch(
    body,
    /const workflow = rootGraph\.serialize\(\)/,
    "the production strip capture must not return a bare serialize() — that drops the name map and does not retry a V3 throw",
  );
  assert.match(body, /reconcileGraphDynamicWidgets/);
});

test("#1996 capturedWidgetValues is a name-keyed map of the LIVE widgets", () => {
  const captured = capturedWidgetValuesForNode(liveSampler());
  assert.deepEqual(captured, { seed: 7, control_after_generate: "fixed" });
  assert.equal(capturedWidgetValuesForNode({ id: 1, widgets: [] }), null);
  assert.equal(capturedWidgetValuesForNode({ id: 1 }), null);
});

test("#1996 attachCapturedWidgetValues keeps a newer schema's extra fields and version", () => {
  const workflow = newerSchemaWorkflow();
  attachCapturedWidgetValues(workflow, [liveSampler()]);
  assert.equal(workflow.version, 1.2);
  assert.deepEqual(workflow.extra, { frontendVersion: "1.49.9", future_mcp_schema: { nested: true } });
  assert.deepEqual(workflow.links[0], {
    id: 1,
    origin_id: 2,
    origin_slot: 0,
    target_id: 1,
    target_slot: 0,
    type: "MODEL",
  });
  assert.deepEqual(workflow.nodes[0].future_v3_slot, { kind: "COMFY_DYNAMICCOMBO_V3" });
  assert.deepEqual(workflow.nodes[0].widgets_values, [7, "fixed"]);
  assert.deepEqual(workflow.nodes[0].capturedWidgetValues, {
    seed: 7,
    control_after_generate: "fixed",
  });
});

test("#1996 attachCapturedWidgetValues stamps subgraph definition nodes without cloning them away", () => {
  const inner = { id: 9, type: "CLIPTextEncode", widgets_values: ["hello"] };
  const workflow = newerSchemaWorkflow({
    definitions: { subgraphs: [{ id: "sg", nodes: [inner], links: [] }] },
  });
  attachCapturedWidgetValues(workflow, [
    liveSampler(),
    { id: 9, widgets: [{ name: "text", value: "hello" }] },
  ]);
  assert.equal(workflow.definitions.subgraphs[0].nodes[0], inner);
  assert.deepEqual(inner.capturedWidgetValues, { text: "hello" });
});

test("#1996 collectLiveNodes walks nested subgraph instances", () => {
  const inner = { id: 4, type: "SaveVideo" };
  const host = { id: 3, type: "SubgraphNode", subgraph: { _nodes: [inner] } };
  const collected = collectLiveNodes({ _nodes: [liveSampler(), host] });
  assert.equal(collected.length, 3);
  assert.equal(collected[2], inner);
});

test("#1996 serializeLiveGraph attaches named widgets and preserves extra schema keys", () => {
  const live = liveSampler();
  const raw = newerSchemaWorkflow();
  const root = {
    _nodes: [live],
    serialize() {
      return raw;
    },
  };
  const out = serializeLiveGraph(root);
  assert.equal(out, raw, "must mutate the serialize() object in place, not clone extra fields away");
  assert.equal(out.version, 1.2);
  assert.equal(out.extra.future_mcp_schema.nested, true);
  assert.deepEqual(out.nodes[0].capturedWidgetValues, {
    seed: 7,
    control_after_generate: "fixed",
  });
});

test("#1996 serializeLiveGraph retries once after reconcile when serialize throws", () => {
  const live = liveSampler();
  let calls = 0;
  let reconciled = 0;
  const root = {
    _nodes: [live],
    serialize() {
      calls += 1;
      if (calls === 1) throw new Error("Dynamic widget doesn't exist on node");
      return newerSchemaWorkflow();
    },
  };
  const out = serializeLiveGraph(root, {
    reconcile() {
      reconciled += 1;
    },
  });
  assert.equal(calls, 2);
  assert.ok(reconciled >= 2, "reconcile runs before the first serialize and again on retry");
  assert.deepEqual(out.nodes[0].capturedWidgetValues.seed, 7);
});

test("#1996 a serialize throw that survives reconcile is rethrown, not swallowed", () => {
  const root = {
    _nodes: [liveSampler()],
    serialize() {
      throw new Error("Dynamic widget doesn't exist on node");
    },
  };
  assert.throws(
    () => serializeLiveGraph(root, { reconcile() {} }),
    /Dynamic widget doesn't exist on node/,
  );
});
