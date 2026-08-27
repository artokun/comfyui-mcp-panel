/**
 * #1913 — panel_restart_comfyui must restart the ComfyUI bound to the live
 * canvas, not the orchestrator's boot target.
 *
 * THE REPORT. Panel bound to 127.0.0.1:8189, tool-server boot target
 * 127.0.0.1:8188. Restart refused because the process at 8188 could not be
 * identified as the canvas, leaving a newly installed custom node unloaded.
 *
 * THE REMAINING HALF. Naming the mismatch already ships. Routing through the
 * bound origin is what was left: a live bridge/backend socket is a #871-grade
 * witness that THIS instance, not a successor on the same port, will receive
 * the Manager reboot.
 *
 * These drive the shipped helper. Restarting the boot target, or refusing the
 * bound instance while the witness is live, fails them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  decideBoundRestart,
  normalizeBoundOrigin,
  sameBoundOrigin,
} from "../../web/js/lib/bound-restart-witness.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const BOUND = "http://127.0.0.1:8189";
const BOOT = "http://127.0.0.1:8188";

function rebootExecutorSource() {
  const at = SRC.indexOf("  async comfy_reboot({ force } = {}) {");
  assert.ok(at > 0, "comfy_reboot must exist");
  return SRC.slice(at, SRC.indexOf("  async free_vram()", at));
}

test("#1913: trailing slash / path is not a different instance", () => {
  assert.equal(normalizeBoundOrigin("http://127.0.0.1:8189/"), BOUND);
  assert.equal(normalizeBoundOrigin("http://127.0.0.1:8189/comfy"), BOUND);
  assert.equal(sameBoundOrigin("http://127.0.0.1:8189/", BOUND), true);
});

test("#1913: garbage is omitted, never guessed", () => {
  for (const value of ["", "   ", null, undefined, 8189, "not-a-url", "ws://127.0.0.1:8189"]) {
    assert.equal(normalizeBoundOrigin(value), "", String(value));
  }
});

test("#1913: a live canvas bound to :8189 restarts :8189, not the :8188 boot target", () => {
  const decision = decideBoundRestart({
    boundOrigin: BOUND,
    bootTarget: BOOT,
    bridgeConnected: true,
    witnessAlive: true,
  });
  assert.equal(decision.kind, "reboot_bound");
  assert.equal(decision.target, BOUND);
  assert.notEqual(decision.target, BOOT, "must not restart the boot target");
  assert.match(decision.note, /8189/);
  assert.match(decision.note, /8188/);
});

test("#1913: cannot-restart-bound fails — a live witness authorizes the bound instance even when it is not the boot target", () => {
  // The remaining routing half. Refusing here is the filed bug: the canvas is
  // identified, the connection is live, and the only thing "wrong" is that the
  // orchestrator booted against a different port.
  const decision = decideBoundRestart({
    boundOrigin: BOUND,
    bootTarget: BOOT,
    bridgeConnected: true,
    witnessAlive: false,
  });
  assert.equal(decision.kind, "reboot_bound", "a live bridge is enough witness");
  assert.equal(decision.target, BOUND);
});

test("#1913: restarting the wrong instance fails — an explicit request for the boot target is refused", () => {
  const decision = decideBoundRestart({
    boundOrigin: BOUND,
    bootTarget: BOOT,
    requestedTarget: BOOT,
    bridgeConnected: true,
    witnessAlive: true,
  });
  assert.equal(decision.kind, "refuse_wrong_instance");
  assert.equal(decision.target, null);
  assert.match(decision.note, /DIFFERENT server/);
  assert.match(decision.note, /8188/);
  assert.match(decision.note, /8189/);
});

test("#1913: without a live witness, bound ≠ boot is not dispatched (successor risk)", () => {
  const decision = decideBoundRestart({
    boundOrigin: BOUND,
    bootTarget: BOOT,
    bridgeConnected: false,
    witnessAlive: false,
  });
  assert.equal(decision.kind, "refuse_no_witness");
  assert.equal(decision.target, null);
  assert.match(decision.note, /successor/);
});

test("#1913: bound === boot with a live witness restarts that origin", () => {
  const decision = decideBoundRestart({
    boundOrigin: BOOT,
    bootTarget: BOOT,
    bridgeConnected: true,
  });
  assert.equal(decision.kind, "reboot_bound");
  assert.equal(decision.target, BOOT);
});

test("#1913: an unidentified canvas with no witness is refused", () => {
  const decision = decideBoundRestart({
    boundOrigin: "",
    bootTarget: BOOT,
    bridgeConnected: false,
    witnessAlive: false,
  });
  assert.equal(decision.kind, "refuse_unidentified");
  assert.equal(decision.target, null);
});

test("#1913: a live command path with no readable origin still reboots (relative fetch hits the page host)", () => {
  const decision = decideBoundRestart({
    boundOrigin: "",
    bootTarget: "",
    bridgeConnected: true,
  });
  assert.equal(decision.kind, "reboot_bound");
  assert.equal(decision.target, null);
});

test("#1913: localhost is not silently equated with 127.0.0.1", () => {
  // Absence of proof is not proof of sameness — the orchestrator treats this
  // the same way. A live witness still routes to the bound origin, not the boot.
  const decision = decideBoundRestart({
    boundOrigin: "http://127.0.0.1:8189",
    bootTarget: "http://localhost:8189",
    bridgeConnected: true,
  });
  assert.equal(decision.kind, "reboot_bound");
  assert.equal(decision.target, "http://127.0.0.1:8189");
});

// ── production wiring ──────────────────────────────────────────────────────

test("#1913: comfy_reboot consults the helper before any Manager POST", () => {
  const reboot = rebootExecutorSource();
  const helperAt = reboot.indexOf("decideBoundRestart(");
  const fetchAt = reboot.indexOf("api.fetchApi(route, { method })");
  assert.ok(helperAt > 0, "comfy_reboot must call decideBoundRestart");
  assert.ok(fetchAt > helperAt, "the decision must precede the reboot POST");
  assert.match(reboot, /kind !== ["']reboot_bound["']/);
});

test("#1913: the reboot POST is relative to the bound page, never the boot URL", () => {
  const reboot = rebootExecutorSource();
  assert.ok(reboot.includes("api.fetchApi(route, { method })"), "Manager reboot stays on the page origin");
  assert.equal(reboot.includes("remoteUrlSetting()"), true, "boot/override is an input to the decision");
  assert.doesNotMatch(reboot, /fetchApi\(\s*(bootTarget|remoteUrlSetting)/);
});

test("#1913: reboot replies name the bound canvas origin, not the hello override", () => {
  // #851 taught the reply to name a host. Naming the hello override while the
  // POST hits the page origin is a confident wrong answer — the reported 8189
  // vs 8188 split. The bound origin is what actually goes down.
  const fields = SRC.slice(
    SRC.indexOf("function rebootTargetFields() {"),
    SRC.indexOf("function rebootTargetFields() {") + 280,
  );
  assert.ok(fields.includes("rebootBoundOrigin()"), "target fields must read the bound origin");
  assert.ok(!fields.includes("comfyuiUrlForAgent()"), "hello override must not label the reboot");

  const label = SRC.slice(
    SRC.indexOf("function rebootTargetLabel(prefix) {"),
    SRC.indexOf("function rebootTargetFields() {"),
  );
  assert.ok(label.includes("rebootBoundOrigin()"), "prose must name the bound origin too");
  assert.ok(!label.includes("comfyuiUrlForAgent()"));
});

test("#1913: the panel imports and calls the shipped helper", () => {
  assert.match(SRC, /from "\.\/lib\/bound-restart-witness\.js"/);
  assert.ok(SRC.includes("decideBoundRestart("));
  assert.ok(SRC.includes("normalizeBoundOrigin("));
});
