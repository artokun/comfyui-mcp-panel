// panel#2180 — a programmatic graph load can leave backend nodes present on the
// canvas while their frontend classes are absent from this tab's registry. The
// run preflight must give the authoritative refresh one chance to rehydrate them
// before refusing a prompt with missing class_type values.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
