// Regression guard for #525: the panel's bridge-disconnect handler used to reset
// an undeclared, obsolete `lastAgentModelConfig`, throwing a ReferenceError on
// every reconnect. The callback depends on the real browser/ComfyUI environment,
// so inspect the shipped callback source directly (the panel's established wiring
// test pattern) rather than substitute a different implementation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

function bridgeStatusHandler() {
  const source = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("const client = createBridgeClient({\n    onStatus(state) {");
  assert.notEqual(start, -1, "could not locate the bridge status callback");
  const end = source.indexOf("\n    onSay(", start);
  assert.notEqual(end, -1, "could not locate the callback following onStatus");
  return source.slice(start, end);
}

test("#525 bridge disconnect handler has no obsolete undeclared config reset", () => {
  const handler = bridgeStatusHandler();
  assert.match(handler, /bridgeWasDown = true/, "disconnects must still be remembered for reconciliation");
  assert.doesNotMatch(
    handler,
    /\blastAgentModelConfig\b/,
    "the dead cache reset would throw a ReferenceError because no cache exists",
  );
});
