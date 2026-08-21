import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { withWorkflowUuid } from "../../web/js/lib/graph-view-identity.js";

const PANEL_SRC = fs.readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

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

test("an explicit live identity wins over a stale root tag", () => {
  const root = { extra: { comfyui_mcp: { workflow_uuid: "workflow-old" } } };
  assert.deepEqual(withWorkflowUuid({ scope: "root" }, root, "workflow-new"), {
    scope: "root",
    workflow_uuid: "workflow-new",
  });
  assert.deepEqual(withWorkflowUuid({ scope: "root" }, root, null), { scope: "root" });
});

test("production graph read callers publish the live viewing identity", () => {
  assert.match(PANEL_SRC, /const workflow = activeWorkflowRef\(\);/);
  assert.match(PANEL_SRC, /const withLiveIdentity = \(viewing\) => withWorkflowUuid\(viewing, root, workflowUuid\);/);

  const subgraphStart = PANEL_SRC.indexOf("graph_get_subgraph({ node_id }) {");
  const subgraphEnd = PANEL_SRC.indexOf("async graph_add_node", subgraphStart);
  assert.ok(subgraphStart >= 0 && subgraphEnd > subgraphStart);
  assert.match(PANEL_SRC.slice(subgraphStart, subgraphEnd), /viewing: describeActiveGraph\(graph\)/);

  const queryStart = PANEL_SRC.indexOf("graph_query({");
  const queryEnd = PANEL_SRC.indexOf("graph_find_nodes({", queryStart);
  assert.ok(queryStart >= 0 && queryEnd > queryStart);
  assert.match(PANEL_SRC.slice(queryStart, queryEnd), /viewing: describeActiveGraph\(graph\)/);
});
