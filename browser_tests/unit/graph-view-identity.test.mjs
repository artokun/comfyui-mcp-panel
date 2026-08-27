import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  graphViewIdentityFor,
  withGraphViewIdentity,
  withWorkflowUuid,
} from "../../web/js/lib/graph-view-identity.js";

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

test("graph read identity is stable per live graph object and differs across graphs", () => {
  const graphA = {};
  const graphB = {};
  const first = graphViewIdentityFor(graphA);
  assert.match(first, /^graph:/);
  assert.equal(graphViewIdentityFor(graphA), first);
  assert.notEqual(graphViewIdentityFor(graphB), first);
  assert.deepEqual(withGraphViewIdentity({ scope: "subgraph", owner_node_id: 7 }, graphA), {
    scope: "subgraph",
    owner_node_id: 7,
    graph_identity: first,
  });
});

test("production graph read callers publish the live viewing identity", () => {
  assert.match(PANEL_SRC, /const workflow = activeWorkflowRef\(\);/);
  assert.match(PANEL_SRC, /withGraphViewIdentity\(withWorkflowUuid\(viewing, root, workflowUuid\), graph\)/);

  const subgraphStart = PANEL_SRC.indexOf("graph_get_subgraph({ node_id }) {");
  const subgraphEnd = PANEL_SRC.indexOf("async graph_add_node", subgraphStart);
  assert.ok(subgraphStart >= 0 && subgraphEnd > subgraphStart);
  assert.match(PANEL_SRC.slice(subgraphStart, subgraphEnd), /viewing: describeActiveGraph\(graph\)/);
  assert.match(PANEL_SRC.slice(subgraphStart, subgraphEnd), /graph_identity: graphViewIdentityFor\(sub\)/);

  const queryStart = PANEL_SRC.indexOf("graph_query({");
  const queryEnd = PANEL_SRC.indexOf("graph_find_nodes({", queryStart);
  assert.ok(queryStart >= 0 && queryEnd > queryStart);
  assert.match(PANEL_SRC.slice(queryStart, queryEnd), /viewing: describeActiveGraph\(graph\)/);
});

test("#1925 production graph replies restock a parseable viewing witness", () => {
  assert.match(PANEL_SRC, /function withViewingWitness\(/);
  assert.match(PANEL_SRC, /result: withViewingWitness\(result\)/);
  assert.match(PANEL_SRC, /viewing: liveParseableViewingWitness\(\) \?\? undefined/);
});

test("#1925 withViewingWitness keeps parseable viewing, replaces malformed, attaches missing", () => {
  const start = PANEL_SRC.indexOf("function parseableViewingWitness");
  const end = PANEL_SRC.indexOf("\nfunction canonicalExpectedPromotedOwner", start);
  assert.ok(start >= 0 && end > start, "viewing-witness helpers not found");
  const live = {
    scope: "root",
    workflow_uuid: "workflow-a",
    graph_identity: "graph:root",
  };
  const withViewingWitness = new Function(
    "getGraphCtx",
    "describeActiveGraph",
    `${PANEL_SRC.slice(start, end)}; return withViewingWitness;`,
  )(
    () => ({ graph: {} }),
    () => live,
  );

  assert.deepEqual(withViewingWitness({ ok: true, viewing: live }), { ok: true, viewing: live });
  assert.deepEqual(withViewingWitness({ applied: true }), { applied: true, viewing: live });
  assert.deepEqual(
    withViewingWitness({ viewing: null, applied: true }),
    { applied: true, viewing: live },
    "malformed viewing must be replaced, not recorded as unverifiable",
  );
  assert.equal(withViewingWitness("plain"), "plain");
});

test("#1925 pinpoint detail publishes a structured is_subgraph row", () => {
  const queryStart = PANEL_SRC.indexOf("graph_query({");
  const queryEnd = PANEL_SRC.indexOf("graph_find_nodes({", queryStart);
  const query = PANEL_SRC.slice(queryStart, queryEnd);
  assert.match(query, /pinpointNodes/);
  assert.match(query, /is_subgraph: !!matched\[0\]\.subgraph/);
  assert.match(query, /\.\.\.\(pinpointNodes \? \{ nodes: pinpointNodes \} : \{\}\)/);
});
