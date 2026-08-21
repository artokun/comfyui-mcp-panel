import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrateAutostartValue, panelOpenAction, connectEntryPlan } from "../../web/js/lib/mcp-autostart-policy.js";
import {
  DEFAULT_BRIDGE_URL,
  LEGACY_9180_BRIDGE_URL,
  defaultDialOrder,
} from "../../web/js/lib/bridge-defaults.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

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

test("#1596 Connect entry: 9199 silent + 9180 protocol → connect 9180, do not spawn", () => {
  const plan = connectEntryPlan({
    pinnedUrl: DEFAULT_BRIDGE_URL,
    advertisedLocalUrl: null,
    statusRunning: true,
    statusBridgeUrl: LEGACY_9180_BRIDGE_URL,
  });
  assert.equal(plan.spawn, false);
  assert.equal(plan.action, "connect");
  assert.equal(plan.url, LEGACY_9180_BRIDGE_URL);
});

test("#1596 Connect entry: advertised 9180 wins even if status.running is false", () => {
  const plan = connectEntryPlan({
    pinnedUrl: DEFAULT_BRIDGE_URL,
    advertisedLocalUrl: LEGACY_9180_BRIDGE_URL,
    statusRunning: false,
    statusBridgeUrl: DEFAULT_BRIDGE_URL,
  });
  assert.equal(plan.spawn, false);
  assert.equal(plan.url, LEGACY_9180_BRIDGE_URL);
});

test("#1596 Connect entry: a custom pin is never moved onto 9199", () => {
  const pin = "ws://127.0.0.1:7777";
  const plan = connectEntryPlan({
    pinnedUrl: pin,
    advertisedLocalUrl: LEGACY_9180_BRIDGE_URL,
    statusRunning: true,
    statusBridgeUrl: DEFAULT_BRIDGE_URL,
  });
  assert.equal(plan.spawn, false);
  assert.equal(plan.url, pin);
});

test("#1596 Connect entry: default-ish still tries 9180 before spawn", () => {
  const plan = connectEntryPlan({
    pinnedUrl: DEFAULT_BRIDGE_URL,
    advertisedLocalUrl: null,
    statusRunning: false,
    statusBridgeUrl: DEFAULT_BRIDGE_URL,
  });
  assert.equal(plan.spawn, true);
  assert.deepEqual(plan.tryUrls, defaultDialOrder());
  assert.equal(plan.tryUrls.includes(LEGACY_9180_BRIDGE_URL), true);
  assert.ok(
    plan.tryUrls.indexOf(DEFAULT_BRIDGE_URL) < plan.tryUrls.indexOf(LEGACY_9180_BRIDGE_URL),
  );
});

test("#1596 WIRING: startMcpThenConnect consults connectEntryPlan before launcher/start", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const fn = src.slice(
    src.indexOf("async function startMcpThenConnect()"),
    src.indexOf("async function connectAgent("),
  );
  assert.ok(fn.length > 0, "located startMcpThenConnect");
  const planAt = fn.indexOf("connectEntryPlan(");
  const startAt = fn.indexOf("launcher/start");
  assert.ok(planAt > -1, "Connect entry must call connectEntryPlan");
  assert.ok(startAt > -1, "launcher/start still exists for a true empty-machine autostart");
  assert.ok(planAt < startAt, "skipping the 9180 try before startMcp must go red");
  assert.match(fn, /if \(!plan\.spawn\)/);
  assert.doesNotMatch(fn, /taskkill/i);
});
