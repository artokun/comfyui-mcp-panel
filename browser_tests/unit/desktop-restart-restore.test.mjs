/**
 * #1999 — panel_restart_comfyui must not stop Desktop ComfyUI unless a
 * Desktop relaunch path will restore it.
 *
 * THE REPORT. Manager reboot was dispatched into a ComfyUI Desktop instance,
 * the server went down, and nothing brought it back. The follow-up lifecycle
 * tool then refused because it could not prove Desktop still supervised the
 * port. Newly installed custom nodes stayed unloaded.
 *
 * These drive the shipped helper. A Manager POST on a Desktop shell with no
 * restore function, or skipping the proven restore when it exists, fails them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  decideDesktopRestartRestore,
  resolveDesktopRestore,
} from "../../web/js/lib/desktop-restart-restore.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

function rebootExecutorSource() {
  const at = SRC.indexOf("  async comfy_reboot({ force } = {}) {");
  assert.ok(at > 0, "comfy_reboot must exist");
  return SRC.slice(at, SRC.indexOf("  async free_vram()", at));
}

test("#1999: a browser tab is not Desktop — Manager reboot stays the path", () => {
  const decision = decideDesktopRestartRestore({
    desktopShell: false,
    restore: { name: "restartCore", restore: () => {} },
  });
  assert.equal(decision.kind, "manager_reboot");
  assert.equal(decision.via, null);
});

test("#1999: Desktop with restartCore restores through Desktop, not Manager", () => {
  const decision = decideDesktopRestartRestore({
    desktopShell: true,
    restore: { name: "restartCore", restore: () => {} },
  });
  assert.equal(decision.kind, "desktop_restore");
  assert.equal(decision.via, "restartCore");
  assert.match(decision.note, /restartCore/);
  assert.match(decision.note, /restores the backend after stop/);
});

test("#1999: restartApp / relaunchApp are also proven restore paths", () => {
  for (const name of ["restartApp", "relaunchApp"]) {
    const decision = decideDesktopRestartRestore({
      desktopShell: true,
      restore: { name, restore: () => {} },
    });
    assert.equal(decision.kind, "desktop_restore", name);
    assert.equal(decision.via, name);
  }
});

test("#1999: Desktop without a restore function refuses before the stop", () => {
  const decision = decideDesktopRestartRestore({ desktopShell: true, restore: null });
  assert.equal(decision.kind, "refuse");
  assert.equal(decision.via, null);
  assert.match(decision.note, /Refusing to restart/);
  assert.match(decision.note, /Desktop/);
  assert.match(decision.note, /STOP the backend/);
  assert.match(decision.note, /ComfyUI Desktop app/);
});

test("#1999: a named restore without a function is not a path", () => {
  const decision = decideDesktopRestartRestore({
    desktopShell: true,
    restore: { name: "restartCore", restore: "not-a-function" },
  });
  assert.equal(decision.kind, "refuse");
});

test("#1999: resolveDesktopRestore prefers restartCore over a whole-app relaunch", () => {
  const calls = [];
  const bridge = {
    restartApp() {
      calls.push("restartApp");
    },
    restartCore() {
      calls.push("restartCore");
    },
    relaunchApp() {
      calls.push("relaunchApp");
    },
  };
  const resolved = resolveDesktopRestore(bridge);
  assert.equal(resolved.name, "restartCore");
  resolved.restore();
  assert.deepEqual(calls, ["restartCore"]);
});

test("#1999: resolveDesktopRestore accepts restartApp when restartCore is absent", () => {
  const resolved = resolveDesktopRestore({
    restartApp() {
      return "app";
    },
  });
  assert.equal(resolved.name, "restartApp");
  assert.equal(resolved.restore(), "app");
});

test("#1999: garbage is omitted, never guessed", () => {
  for (const value of [null, undefined, "", 1, [], { restartCore: "no" }, { relaunchApp: {} }]) {
    assert.equal(resolveDesktopRestore(value), null, String(value));
  }
});

test("#1999: comfy_reboot consults the helper before any Manager POST", () => {
  const reboot = rebootExecutorSource();
  const helperAt = reboot.indexOf("decideDesktopRestartRestore(");
  const fetchAt = reboot.indexOf("api.fetchApi(route, { method })");
  assert.ok(helperAt > 0, "comfy_reboot must call decideDesktopRestartRestore");
  assert.ok(fetchAt > helperAt, "the Desktop decision must precede the Manager reboot POST");
  assert.match(reboot, /kind === ["']refuse["']/);
  assert.match(reboot, /kind === ["']desktop_restore["']/);
});

test("#1999: a Desktop restore never falls through to Manager reboot", () => {
  const reboot = rebootExecutorSource();
  const restoreAt = reboot.indexOf('kind === "desktop_restore"');
  const fetchAt = reboot.indexOf("api.fetchApi(route, { method })");
  assert.ok(restoreAt > 0);
  const restoreReturn = reboot.lastIndexOf("return {", fetchAt);
  assert.ok(restoreReturn > restoreAt, "desktop_restore must return before the Manager POST");
  const restoreBlock = reboot.slice(restoreAt, fetchAt);
  assert.match(restoreBlock, /via: desktopRestore\.name/);
  assert.match(restoreBlock, /desktopRestore\.restore\(\)/);
  assert.doesNotMatch(restoreBlock, /api\.fetchApi/);
});

test("#1999: a Desktop refuse names the server and does not POST Manager", () => {
  const reboot = rebootExecutorSource();
  const refuseAt = reboot.indexOf('kind === "refuse"');
  const fetchAt = reboot.indexOf("api.fetchApi(route, { method })");
  assert.ok(refuseAt > 0 && refuseAt < fetchAt);
  const branch = reboot.slice(reboot.lastIndexOf("return {", refuseAt + 80), fetchAt);
  assert.match(branch, /refused: true/);
  assert.match(branch, /rebootTargetFields\(\)/);
  assert.match(branch, /rebooting: false/);
});

test("#1999: a restore that fails while the backend is still up refuses, not a silent stop", () => {
  const reboot = rebootExecutorSource();
  assert.match(reboot, /comfyBackendIsDown\(\)/);
  assert.match(reboot, /failed before the backend went down/);
  assert.match(reboot, /ComfyUI was NOT restarted/);
});

test("#1999: the panel imports and calls the shipped helper", () => {
  assert.match(SRC, /from "\.\/lib\/desktop-restart-restore\.js"/);
  assert.ok(SRC.includes("decideDesktopRestartRestore("));
  assert.ok(SRC.includes("resolveDesktopRestore("));
  assert.ok(SRC.includes("window.__comfyDesktop2"));
});
