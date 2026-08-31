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
  isDesktopSupervisedShell,
  resolveDesktopRestore,
  resolveDesktopRestoreFrom,
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
  // #2134 renamed the resolver call to the all-candidates form; the point of this
  // assertion is unchanged — the panel must use the shipped resolver, not its own.
  assert.ok(SRC.includes("resolveDesktopRestoreFrom("));
  assert.ok(SRC.includes("window.__comfyDesktop2"));
});

/**
 * #2134 — the refusal above fired on instances that are not Desktop at all.
 *
 * THE REPORT. `panel_restart_comfyui` refused after a custom-node install with
 * "no Desktop relaunch path (restartCore / restartApp / relaunchApp) is
 * available", leaving the user unable to load the nodes they had just installed.
 *
 * TWO CAUSES, both on the input to the (correct) decision helper:
 *
 *   * Desktop-ness came from `isEmbeddedDesktopShell`, whose `Electron/`
 *     User-Agent arm answers a question about the BROWSER. Any Electron-embedded
 *     browser pointed at an ordinary ComfyUI therefore got refused, and told it
 *     was a Desktop instance.
 *   * The bridge was picked with `??`, which stops at the first non-nullish
 *     global — a bridge carrying no restore function masked a later one that had
 *     one, so "no relaunch path is available" was asserted without looking.
 */

test("#2134: an Electron browser with no bridge is not Desktop — Manager reboot stays the path", () => {
  assert.equal(isDesktopSupervisedShell({ electronBridge: null, restore: null }), false);
  const decision = decideDesktopRestartRestore({
    desktopShell: isDesktopSupervisedShell({ electronBridge: null, restore: null }),
    restore: resolveDesktopRestoreFrom([undefined, undefined, undefined, undefined]),
  });
  assert.equal(decision.kind, "manager_reboot");
  assert.equal(decision.note, "");
});

test("#2134: a truthy alternate global with no relaunch function is NOT Desktop proof", () => {
  // The alternates (window.api, window.__comfyDesktop2, comfyAPI.electron) are
  // unverified guesses. Stock ComfyUI defines no `window.api` at all — it exposes
  // `window.comfyAPI.api.api` — but a custom node may. Accepting a bare truthy
  // value there would put a new weak signal exactly where the User-Agent was.
  for (const alternate of [{}, { someUnrelatedMethod() {} }, "truthy", 1]) {
    const bridges = [undefined, undefined, alternate, undefined];
    assert.equal(
      isDesktopSupervisedShell({
        electronBridge: undefined,
        restore: resolveDesktopRestoreFrom(bridges),
      }),
      false,
      String(alternate),
    );
  }
});

test("#2134: an alternate global that DOES expose a relaunch function is Desktop", () => {
  const bridges = [undefined, { restartCore() {} }, undefined, undefined];
  const restore = resolveDesktopRestoreFrom(bridges);
  assert.equal(isDesktopSupervisedShell({ electronBridge: undefined, restore }), true);
});

test("#2134: #1999 is preserved — electronAPI alone is Desktop, even with no restore", () => {
  const bridges = [{ openExternalUrl() {} }, undefined, undefined, undefined];
  const decision = decideDesktopRestartRestore({
    desktopShell: isDesktopSupervisedShell({
      electronBridge: bridges[0],
      restore: resolveDesktopRestoreFrom(bridges),
    }),
    restore: resolveDesktopRestoreFrom(bridges),
  });
  assert.equal(decision.kind, "refuse");
  assert.match(decision.note, /Refusing to restart/);
});

test("#2134: a bridge with no restore does not mask a later bridge that has one", () => {
  const calls = [];
  const bridges = [
    { openExternalUrl() {} },
    {
      restartApp() {
        calls.push("restartApp");
      },
    },
  ];
  // The old `a ?? b` picked the first object and reported no relaunch path.
  const resolved = resolveDesktopRestoreFrom(bridges);
  assert.ok(resolved, "a restore on a later bridge must still be found");
  assert.equal(resolved.name, "restartApp");
  resolved.restore();
  assert.deepEqual(calls, ["restartApp"]);
  assert.equal(
    decideDesktopRestartRestore({
      desktopShell: isDesktopSupervisedShell({ electronBridge: bridges[0], restore: resolved }),
      restore: resolved,
    }).kind,
    "desktop_restore",
  );
});

test("#2134: preference is by function, not by which global was defined first", () => {
  const resolved = resolveDesktopRestoreFrom([
    { relaunchApp() {} },
    { restartCore: () => "core" },
  ]);
  assert.equal(resolved.name, "restartCore");
  assert.equal(resolved.restore(), "core");
});

test("#2134: garbage candidates never invent a relaunch path", () => {
  assert.equal(resolveDesktopRestoreFrom([null, undefined, "", 1, [], { restartCore: "no" }]), null);
  assert.equal(resolveDesktopRestoreFrom(null), null);
});

/**
 * The tests above drive the helpers, and a helper can be right while the call site
 * feeds it the wrong input — which is exactly what #2134 was. This one EXECUTES the
 * shipped call-site expression against synthetic `window` shapes, so a regression is
 * caught by behaviour rather than by a source match.
 */
function runRebootDesktopDecision(win) {
  const reboot = rebootExecutorSource();
  const start = reboot.indexOf("    const desktopBridges =");
  assert.ok(start > 0, "the reboot executor must build its Desktop bridge candidates");
  const decideAt = reboot.indexOf("decideDesktopRestartRestore({", start);
  assert.ok(decideAt > start, "the candidates must feed decideDesktopRestartRestore");
  const end = reboot.indexOf("    });", decideAt) + "    });".length;
  const snippet = reboot.slice(start, end);
  // A vacuous slice would make every assertion below trivially true.
  assert.ok(snippet.includes("isDesktopSupervisedShell("), "snippet must contain the decision inputs");
  const run = new Function(
    "window",
    "navigator",
    "decideDesktopRestartRestore",
    "isDesktopSupervisedShell",
    "resolveDesktopRestoreFrom",
    `${snippet}\n return desktopDecision;`,
  );
  return run(
    win,
    { userAgent: "Mozilla/5.0 ... Electron/32.0.1 Safari/537.36" },
    decideDesktopRestartRestore,
    isDesktopSupervisedShell,
    resolveDesktopRestoreFrom,
  );
}

test("#2134: the shipped call site does not refuse an Electron browser with no bridge", () => {
  // Pre-fix this returned `refuse` with the exact string the reporter quoted.
  const decision = runRebootDesktopDecision({});
  assert.equal(decision.kind, "manager_reboot");
});

test("#2134: the shipped call site does not treat a bare window.api as Desktop", () => {
  // Raised on review of this fix: `window.api` is not ComfyUI's API object (that is
  // `window.comfyAPI.api.api`), but a custom node may define it. With no relaunch
  // function on it there is no Desktop evidence and nothing to restore with, so the
  // reboot must proceed rather than refuse.
  const decision = runRebootDesktopDecision({ api: { someUnrelatedMethod() {} } });
  assert.equal(decision.kind, "manager_reboot");
});

test("#2134: the shipped call site still refuses a real Desktop with no relaunch path", () => {
  const decision = runRebootDesktopDecision({ electronAPI: { openExternalUrl() {} } });
  assert.equal(decision.kind, "refuse");
  assert.match(decision.note, /no Desktop relaunch path/);
});

test("#2134: the shipped call site restores through a real Desktop bridge", () => {
  const decision = runRebootDesktopDecision({ electronAPI: { restartApp() {} } });
  assert.equal(decision.kind, "desktop_restore");
  assert.equal(decision.via, "restartApp");
});

test("#2134: the shipped call site finds a restore the `??` chain used to mask", () => {
  const decision = runRebootDesktopDecision({
    electronAPI: { openExternalUrl() {} },
    comfyAPI: { electron: { restartCore() {} } },
  });
  assert.equal(decision.kind, "desktop_restore");
  assert.equal(decision.via, "restartCore");
});

test("#2134: comfy_reboot must not decide Desktop from the User-Agent", () => {
  const reboot = rebootExecutorSource();
  assert.ok(reboot.length > 400, "the reboot executor source must actually be extracted");
  assert.ok(
    reboot.includes("isDesktopSupervisedShell("),
    "the reboot path must prove Desktop from the injected bridge",
  );
  assert.ok(reboot.includes("resolveDesktopRestoreFrom("), "every candidate bridge must be probed");
  // The UA arm is what refused non-Desktop servers. `isEmbeddedDesktopShell` is
  // still correct for the mic button, so this is scoped to the reboot executor.
  assert.ok(
    !reboot.includes("isEmbeddedDesktopShell"),
    "comfy_reboot must not derive Desktop-ness from isEmbeddedDesktopShell",
  );
  assert.ok(!reboot.includes("userAgent"), "comfy_reboot must not read the User-Agent");
  // `??` between the globals is the masking bug; the candidates must be a list.
  assert.doesNotMatch(reboot, /window\.electronAPI \?\?/);
});
