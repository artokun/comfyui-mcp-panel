/**
 * #2263 — panel_get_errors reported previous-workflow node ids (H3AdaLNLoRAFix
 * 5599, H3SLAAttention 5603) after a switch to a 17-node graph. ComfyUI can
 * load the new workflow into the SAME graph object, so the instance-identity
 * fence stays quiet while the live combo scan still names the old nodes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { collectMissingNodeTypeReasons } from "../../web/js/lib/asset-staleness.js";
import { runProductionGraphGetErrors } from "./_graph-get-errors-harness.mjs";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

test("#2263 wiring: graph_get_errors refuses a live scan whose ids left the bound graph", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const at = src.indexOf("async graph_get_errors()");
  assert.ok(at > 0, "graph_get_errors must still be recognisable");
  const body = src.slice(at, at + 16000);
  assert.match(body, /graphGetErrorsLiveScanStale\(\{/, "must correlate the scan against the post-await live root");
  assert.match(body, /scannedNodes: scanNodes/, "must pass the pre-await scan node list");
  assert.match(body, /liveRootGraph: postProbeRootGraph/, "must use the post-await root, not the pre-scan one");
  assert.match(body, /recordedMissingTypesOnLiveGraph\(adjudicated\.stillMissing, allNodes\)/, "must drop previous-tab missing types");
});

test("#2263 production graph_get_errors refuses leftover ids after an in-place workflow load", async () => {
  const previous = [
    { id: 5599, type: "H3AdaLNLoRAFix", widgets: [{ name: "lora_name", value: "x.safetensors" }] },
    { id: 5603, type: "H3SLAAttention", widgets: [{ name: "model", value: "y.safetensors" }] },
  ];
  const current = Array.from({ length: 17 }, (_, i) => ({
    id: i + 1,
    type: "LoadImage",
    widgets: [{ name: "image", value: "ok.png" }],
  }));
  const graph = {
    _nodes: previous,
    getNodeById: (id) => (graph._nodes.find((n) => String(n.id) === String(id)) ?? null),
  };
  await assert.rejects(
    () =>
      runProductionGraphGetErrors({
        graph,
        rootGraph: graph,
        lastExecFailure: null,
        scan: async (nodes) => {
          graph._nodes = current;
          return {
            unavailable: [],
            unknown: nodes.map((n) => ({
              id: n.id,
              type: n.type,
              reason: "node type not found in /object_info",
            })),
          };
        },
      }),
    (err) => {
      assert.match(String(err?.message ?? err), /active workflow changed/i);
      assert.match(String(err?.message ?? err), /Retry panel_get_errors/);
      return true;
    },
  );
});

test("#2263 production graph_get_errors keeps nested inner ids of the CURRENT bound root", async () => {
  const inner = {
    id: 5599,
    type: "H3AdaLNLoRAFix",
    widgets: [{ name: "lora_name", value: "x.safetensors" }],
  };
  const innerGraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "5599" ? inner : null) };
  const host = { id: 12, type: "MiniMaxH3", subgraph: innerGraph, widgets: [] };
  const graph = {
    _nodes: [host],
    getNodeById: (id) => (String(id) === "12" ? host : null),
  };
  const result = await runProductionGraphGetErrors({
    graph,
    rootGraph: graph,
    lastExecFailure: null,
    collectAllGraphs: (root) => [root, innerGraph],
    scan: async () => ({
      unavailable: [],
      unknown: [{ id: 5599, type: "H3AdaLNLoRAFix", reason: "node type not found in /object_info" }],
    }),
  });
  assert.equal(result.unchecked_nodes.length, 1);
  assert.equal(result.unchecked_nodes[0].id, 5599);
});

test("#2263 production graph_get_errors drops load-time missing types the live graph does not carry", async () => {
  const nodes = Array.from({ length: 17 }, (_, i) => ({
    id: i + 1,
    type: i === 0 ? "LoadImage" : "CLIPTextEncode",
    widgets: [],
  }));
  const graph = {
    _nodes: nodes,
    getNodeById: (id) => nodes.find((n) => String(n.id) === String(id)) ?? null,
  };
  const result = await runProductionGraphGetErrors({
    graph,
    rootGraph: graph,
    lastExecFailure: null,
    collectMissingAssets: () => ({
      models: [],
      media: [],
      nodeTypes: ["H3AdaLNLoRAFix", "H3SLAAttention"],
      nodeCount: 2,
    }),
    collectMissingNodeTypeReasons,
    scan: async () => ({ unavailable: [], unknown: [] }),
  });
  assert.equal(result.missing_node_types, undefined);
  assert.equal(result.missing_node_count, undefined);
  assert.equal(result.unchecked_nodes, undefined);
  assert.equal(result.nodes.length, 0);
});
