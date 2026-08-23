import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PANEL_JS = new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url);

function graphFindNodesBody(source) {
  const start = source.indexOf("  graph_find_nodes({");
  assert.ok(start >= 0, "graph_find_nodes handler must exist");
  const next = source.slice(start).match(/\n  (?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  return source.slice(start, next ? start + next.index : source.length);
}

function productionSafeJson() {
  const body = graphFindNodesBody(readFileSync(PANEL_JS, "utf8"));
  const match = body.match(/    const safeJson = \(v\) => \{[\s\S]*?^    \};/m);
  assert.ok(match, "graph_find_nodes must define safeJson");
  return new Function(`${match[0]}\nreturn safeJson;`)();
}

const includes = (safeJson, value, query) =>
  String(safeJson(value) ?? "")
    .toLowerCase()
    .includes(query.toLowerCase());

test("#1678 graph_find_nodes matches raw embedded quotes in string widget values", () => {
  const safeJson = productionSafeJson();
  const value = 'say "hello" to the model';

  assert.equal(safeJson(value), value, "strings must not be JSON-escaped before matching");
  assert.equal(includes(safeJson, value, '"hello"'), true);
});

test("#1678 graph_find_nodes keeps JSON matching for non-string widget values", () => {
  const safeJson = productionSafeJson();

  assert.equal(safeJson(42), "42");
  assert.equal(safeJson(false), "false");
  assert.equal(safeJson({ mode: "fast" }), '{"mode":"fast"}');
  assert.equal(includes(safeJson, { mode: "fast" }, '"mode":"fast"'), true);
});
