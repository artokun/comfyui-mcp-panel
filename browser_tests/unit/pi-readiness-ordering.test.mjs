// #505: a generic bridge ready ack can be dispatched before the MCP's `backends`
// readiness frame. Pi must not become ready from that ack alone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readyAckCanPromoteBackend } from "../../web/js/lib/pi-readiness.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

test("#505 Pi ready ack before backends stays unready; authoritative frame unlocks promotion", () => {
  let piBackendsReadinessReceived = false;
  assert.equal(readyAckCanPromoteBackend("pi", piBackendsReadinessReceived), false);

  // The subsequent MCP `backends` frame is the readiness authority.
  piBackendsReadinessReceived = true;
  assert.equal(readyAckCanPromoteBackend("pi", piBackendsReadinessReceived), true);
  assert.equal(readyAckCanPromoteBackend("codex", false), true, "other backends retain ready-ack behavior");
});

test("#505 panel wiring records the backends frame before allowing Pi ack promotion", () => {
  const source = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");
  const backendsStart = source.indexOf("    onBackends(data) {");
  const ackStart = source.indexOf("    onAck(ack) {");
  assert.ok(backendsStart >= 0 && ackStart > backendsStart, "could not locate bridge callbacks");
  const backends = source.slice(backendsStart, ackStart);
  const ack = source.slice(ackStart, source.indexOf("    getResume:", ackStart));
  const statusStart = source.indexOf("    onStatus(state) {");
  const status = source.slice(statusStart, source.indexOf("    onSay(", statusStart));

  assert.match(backends, /piBackendsReadinessReceived = true/, "backends frame must unlock Pi ack promotion");
  assert.match(
    ack,
    /readyAckCanPromoteBackend\(b, piBackendsReadinessReceived\)/,
    "generic ready ack must use the Pi ordering guard",
  );
  assert.match(
    status,
    /if \(!connected\) \{\n\s*piBackendsReadinessReceived = false/,
    "a reconnect must require a fresh authoritative backends frame",
  );
});
