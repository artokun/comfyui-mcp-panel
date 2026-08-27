/**
 * #1956 — panel_audit_prompt_director with zero director nodes is a correct
 * empty result (count 0, changed:false). A 404 from /prompt_director/inspection
 * is expected in that case and must not land as inspection_unavailable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const methodMatch = panelSrc.match(/async graph_prompt_director_audit\(\) \{[\s\S]*?\n  \},/);
assert.ok(methodMatch, "could not locate graph_prompt_director_audit in panel source");

function realAudit({ nodes = [], fetchImpl }) {
  const factory = new Function(
    "getGraphCtx",
    "fetch",
    "describeActiveGraph",
    `const executors = { ${methodMatch[0]} };\nreturn executors.graph_prompt_director_audit;`,
  );
  const fn = factory(
    () => ({ graph: { _nodes: nodes } }),
    fetchImpl,
    () => ({ scope: "root" }),
  );
  return fn();
}

function http(status, body = { inspections: [] }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("#1956 zero director nodes + HTTP 404 is not inspection_unavailable", async () => {
  const result = await realAudit({
    nodes: [{ id: 1, type: "KSampler", widgets: [] }],
    fetchImpl: async () => http(404),
  });
  assert.equal(result.prompt_director_node_count, 0);
  assert.equal(result.changed, false);
  assert.ok(result.observations.some((o) => o.code === "prompt_director_not_present"));
  assert.ok(
    !result.observations.some((o) => o.code === "inspection_unavailable"),
    `empty canvas must not warn about the expected 404: ${JSON.stringify(result.observations)}`,
  );
  assert.ok(
    !result.observations.some((o) => /HTTP 404/.test(o.message ?? "")),
    "must not mention HTTP 404 when node_count is 0",
  );
});

test("#1956 zero director nodes + a thrown fetch is not inspection_unavailable", async () => {
  const result = await realAudit({
    nodes: [],
    fetchImpl: async () => {
      throw new Error("Failed to fetch");
    },
  });
  assert.equal(result.prompt_director_node_count, 0);
  assert.equal(result.changed, false);
  assert.ok(!result.observations.some((o) => o.code === "inspection_unavailable"));
});

test("#1956 a live director node still surfaces a 404 as inspection_unavailable", async () => {
  const result = await realAudit({
    nodes: [{ id: 9, type: "PromptDirector", widgets: [], inputs: [], outputs: [], mode: 0 }],
    fetchImpl: async () => http(404),
  });
  assert.equal(result.prompt_director_node_count, 1);
  const warning = result.observations.find((o) => o.code === "inspection_unavailable");
  assert.ok(warning, "a present director + 404 must still warn");
  assert.match(warning.message, /HTTP 404/);
});
