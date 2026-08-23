import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

test("graph_set_widget enforces expected_node_type at the synchronous write boundary", () => {
  const start = PANEL_SRC.indexOf("async graph_set_widget({");
  const end = PANEL_SRC.indexOf("\n  // artokun/comfyui-mcp#938", start);
  assert.ok(start >= 0, "graph_set_widget handler not found");
  assert.ok(end > start, "graph_set_widget handler boundary not found");
  const handler = PANEL_SRC.slice(start, end);

  const expectedArg = handler.indexOf("expected_node_type");
  const targetCheck = handler.indexOf("liveTarget.type !== expected_node_type");
  const identityCheck = handler.indexOf("liveTarget !== node");
  const runSet = handler.indexOf("runSetWidget(node, widget, value, setWidgetOpts)");
  assert.ok(expectedArg >= 0, "handler does not accept expected_node_type");
  assert.ok(targetCheck >= 0, "handler does not verify the live target type");
  assert.ok(identityCheck >= 0, "handler does not reject a same-type replacement object");
  assert.ok(runSet > targetCheck, "target type must be checked before runSetWidget");
});
