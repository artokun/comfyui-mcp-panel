import test from "node:test";
import assert from "node:assert/strict";

import { withWorkflowUuid } from "../../web/js/lib/graph-view-identity.js";

test("graph read identity carries the live root workflow uuid", () => {
  const root = { extra: { comfyui_mcp: { workflow_uuid: "workflow-a" } } };
  assert.deepEqual(withWorkflowUuid({ scope: "root" }, root), {
    scope: "root",
    workflow_uuid: "workflow-a",
  });
});

test("subgraph replies retain the root workflow uuid", () => {
  const root = { extra: { comfyui_mcp: { workflow_uuid: "workflow-a" } } };
  assert.deepEqual(withWorkflowUuid({ scope: "subgraph", owner_node_id: 7, title: "Detail" }, root), {
    scope: "subgraph",
    owner_node_id: 7,
    title: "Detail",
    workflow_uuid: "workflow-a",
  });
});

test("missing or malformed identity stays omitted", () => {
  assert.deepEqual(withWorkflowUuid({ scope: "root" }, {}), { scope: "root" });
  assert.deepEqual(
    withWorkflowUuid({ scope: "root" }, { extra: { comfyui_mcp: { workflow_uuid: "" } } }),
    { scope: "root" },
  );
});
