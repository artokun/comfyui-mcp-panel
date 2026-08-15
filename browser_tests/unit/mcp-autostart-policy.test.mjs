import test from "node:test";
import assert from "node:assert/strict";
import { migrateAutostartValue, panelOpenAction } from "../../web/js/lib/mcp-autostart-policy.js";

test("new installs default autostart on while existing installs preserve legacy intent", () => {
  assert.equal(migrateAutostartValue({ existingInstall: false, legacyValue: false }), true);
  assert.equal(migrateAutostartValue({ existingInstall: true, legacyValue: false }), false);
  assert.equal(migrateAutostartValue({ existingInstall: true, legacyValue: true }), true);
});

test("panel open connects an existing MCP before considering autostart", () => {
  assert.equal(panelOpenAction({ orchestratorRunning: true, autostartEnabled: false }), "connect");
  assert.equal(panelOpenAction({ orchestratorRunning: false, autostartEnabled: true }), "start");
  assert.equal(panelOpenAction({ orchestratorRunning: false, autostartEnabled: false }), "idle");
});
