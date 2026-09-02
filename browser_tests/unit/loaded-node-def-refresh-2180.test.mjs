// panel#2180 — a programmatic graph load can leave backend nodes present on the
// canvas while their frontend classes are absent from this tab's registry. The
// run preflight must give the authoritative refresh one chance to rehydrate them
// before refusing a prompt with missing class_type values.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { makeCommandBudget } from "../../web/js/lib/command-budget.js";
import {
  describeUnrunnable,
  graphToPromptFailureRefusal,
  graphToPromptUnusable,
  missingNodeRunRefusal,
  unresolvedNodeTypes,
  unserializableGraphRefusal,
  unrunnableNodeIdsInScope,
} from "../../web/js/lib/missing-node-preflight.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SOURCE = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

function graphRunSource() {
  const start = SOURCE.indexOf("  async graph_run({ batch_count, to_node_id }) {");
  const end = SOURCE.indexOf("\n\n  graph_", start + 1);
  assert.ok(start >= 0, "could not locate graph_run executor");
  assert.ok(end > start, "could not locate graph_run executor boundary");
  return SOURCE.slice(start, end);
}

test("#2180 retries serialization after refreshing definitions for loaded nodes", () => {
  const source = graphRunSource();
  const firstBuild = source.indexOf("const preflightBuild = await withTimeout(");
  const refresh = source.indexOf("await refreshComfyNodeDefs(undefined", firstBuild);
  const secondBuild = source.indexOf("const retryBuild = await withTimeout(", refresh);
  const refusal = source.indexOf("missingNodeRunRefusal(", secondBuild);

  assert.ok(firstBuild >= 0, "panel_run must build a preflight prompt");
  assert.ok(refresh > firstBuild, "the recovery refresh must follow the first serialization");
  assert.ok(secondBuild > refresh, "panel_run must retry serialization after the refresh");
  assert.ok(refusal > secondBuild, "the existing refusal must remain after the retry");

  const recovery = source.slice(refresh, secondBuild);
  assert.match(recovery, /force: true/, "the recovery must fetch current definitions");
  assert.match(recovery, /joinMs: refreshBudget/, "the recovery must share the run budget");
  assert.match(recovery, /runBudgetMs: refreshBudget/, "the refresh run must be bounded");
  assert.match(recovery, /skipDuplicateComboRefresh: true/, "the loaded graph must not pay for a duplicate schema fetch");
});

test("#2180 leaves the fail-closed refusal when rehydration does not repair the prompt", () => {
  const source = graphRunSource();
  const recovery = source.slice(
    source.indexOf("if (unrunnableNodeIdsInScope(built, partialTargets).length)"),
    source.indexOf("const badIds = unrunnableNodeIdsInScope(built, partialTargets);"),
  );
  assert.match(recovery, /built = retryBuild\.value;/);
  assert.match(source, /const badIds = unrunnableNodeIdsInScope\(built, partialTargets\);/);
  assert.match(source, /throw new Error\(\s*missingNodeRunRefusal\(/);
});

test("#2180 blocks queueing when the recovery serialization is malformed", async () => {
  const marker = SOURCE.indexOf("// Inspect the SERIALIZED prompt");
  assert.ok(marker > 0, "could not locate the graph_run preflight");
  const start = SOURCE.lastIndexOf("try {", marker);
  const endMark = SOURCE.indexOf("if (err instanceof Error && /^NOT queued:/.test(err.message)) throw err;", start);
  assert.ok(endMark > start, "could not locate the graph_run preflight catch");
  const body = SOURCE.slice(start, SOURCE.indexOf("\n", endMark)) + "\n    }";

  let serializations = 0;
  let refreshes = 0;
  let queueCalls = 0;
  const preflight = new Function(
    "app",
    "graph",
    "unrunnableNodeIdsInScope",
    "partialTargets",
    "describeUnrunnable",
    "missingNodeRunRefusal",
    "graphToPromptUnusable",
    "graphToPromptFailureRefusal",
    "unserializableGraphRefusal",
    "rootGraph",
    "unresolvedNodeTypes",
    "window",
    "withTimeout",
    "budget",
    "RUN_SERIALIZE_TIMEOUT_MS",
    "refreshComfyNodeDefs",
    `return async function preflight() {\n${body}\n};`,
  )(
    {
      graphToPrompt() {
        serializations += 1;
        return serializations === 1
          ? { output: { 1: { class_type: undefined, inputs: {} } }, workflow: {} }
          : {};
      },
    },
    { _nodes: [{ id: 1, type: "StaleCustomNode" }] },
    unrunnableNodeIdsInScope,
    undefined,
    describeUnrunnable,
    missingNodeRunRefusal,
    graphToPromptUnusable,
    graphToPromptFailureRefusal,
    unserializableGraphRefusal,
    { _nodes: [{ id: 1, type: "StaleCustomNode" }] },
    unresolvedNodeTypes,
    { LiteGraph: { registered_node_types: {} } },
    withTimeout,
    makeCommandBudget(30000),
    8000,
    async (_payload, options) => {
      refreshes += 1;
      assert.equal(options.force, true);
    },
  );

  let refusal;
  try {
    await preflight();
    queueCalls += 1;
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }

  assert.equal(serializations, 2, "the malformed value must come from the recovery retry");
  assert.equal(refreshes, 1, "the loaded-node recovery must run once");
  assert.equal(queueCalls, 0, "a malformed retry prompt must not reach queueing");
  assert.match(refusal, /^NOT queued:/);
  assert.match(refusal, /graphToPrompt/);
});
