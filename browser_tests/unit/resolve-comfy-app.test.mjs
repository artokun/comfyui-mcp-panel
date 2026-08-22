/**
 * #1585 — the Agent tab never appears if we look for ComfyApp in the wrong
 * place, or if registerExtension lands after ComfyUI's setup() wave.
 *
 * The reporter's JS loaded (190 files, 200) and Settings search for "mcp"
 * found nothing: `registerExtension` itself never ran. The lookup was
 * `window.comfyAPI.app.app || window.app`. These drive the REAL resolver
 * against the three shapes the frontend has shipped, plus the "invoke
 * setup ourselves when the tab API is already live" decision.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  canInstallSidebarTab,
  isComfyApp,
  resolveComfyApi,
  resolveComfyApp,
  tryRegisterWhenReady,
} from "../../web/js/lib/resolve-comfy-app.js";

function appLike(extra = {}) {
  return { registerExtension() {}, ...extra };
}

test("isComfyApp: only an object with registerExtension counts", () => {
  assert.equal(isComfyApp(null), false);
  assert.equal(isComfyApp({}), false);
  assert.equal(isComfyApp({ registerExtension: 1 }), false);
  assert.equal(isComfyApp(appLike()), true);
});

test("#1585: the Vite shim shape (comfyAPI.app.app) still wins", () => {
  const instance = appLike({ id: "nested" });
  const root = { comfyAPI: { app: { app: instance, ComfyApp: function ComfyApp() {} } } };
  assert.equal(resolveComfyApp(root), instance);
});

test("#1585: a flattened comfyAPI.app (the 1.49 miss) is the live app", () => {
  // This is the reporter's frontend: `window.comfyAPI.app` IS the instance,
  // `.app.app` is missing, and `window.app` was never assigned. The old
  // lookup polled for 10s and the tab never registered.
  const instance = appLike({ id: "flat" });
  const root = { comfyAPI: { app: instance } };
  assert.equal(resolveComfyApp(root), instance);
  assert.equal(resolveComfyApp({ comfyAPI: { app: { ComfyApp: function C() {} } } }), null);
});

test("#1585: nested instance beats a namespace that is not itself the app", () => {
  const instance = appLike({ id: "nested" });
  const namespace = { app: instance, ComfyApp: function ComfyApp() {} };
  assert.equal(resolveComfyApp({ comfyAPI: { app: namespace } }), instance);
});

test("#1585: legacy window.app is the last fallback", () => {
  const instance = appLike({ id: "legacy" });
  assert.equal(resolveComfyApp({ app: instance }), instance);
  assert.equal(resolveComfyApp({}), null);
  assert.equal(resolveComfyApp(null), null);
});

test("#1585: resolveComfyApi mirrors the same three shapes", () => {
  const api = { fetchApi() {} };
  assert.equal(resolveComfyApi({ comfyAPI: { api: { api } } }), api);
  assert.equal(resolveComfyApi({ comfyAPI: { api } }), api);
  assert.equal(resolveComfyApi({ api: { addEventListener() {} } }).addEventListener !== undefined, true);
  assert.equal(resolveComfyApi({}), null);
});

test("#1585: canInstallSidebarTab is evidence the setup wave is reachable now", () => {
  assert.equal(canInstallSidebarTab(null), false);
  assert.equal(canInstallSidebarTab(appLike()), false);
  assert.equal(
    canInstallSidebarTab(appLike({ extensionManager: { registerSidebarTab() {} } })),
    true,
  );
});

test("#1585 tryRegisterWhenReady: pending until an app exists", () => {
  const calls = [];
  const out = tryRegisterWhenReady({
    root: {},
    register: (args) => calls.push(args),
  });
  assert.equal(out.status, "pending");
  assert.deepEqual(calls, []);
});

test("#1585 tryRegisterWhenReady: a stood-down copy never registers", () => {
  const calls = [];
  const instance = appLike();
  const out = tryRegisterWhenReady({
    root: { comfyAPI: { app: instance } },
    active: () => false,
    register: (args) => calls.push(args),
  });
  assert.equal(out.status, "stood-down");
  assert.deepEqual(calls, []);
});

test("#1585 tryRegisterWhenReady: flattened app registers and asks setup to run when the tab API is live", () => {
  const calls = [];
  const instance = appLike({
    extensionManager: { registerSidebarTab() {} },
  });
  const api = { fetchApi() {} };
  const out = tryRegisterWhenReady({
    root: { comfyAPI: { app: instance, api } },
    active: () => true,
    register: (args) => calls.push(args),
  });
  assert.equal(out.status, "registered");
  assert.equal(out.invokeSetup, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].comfyApp, instance);
  assert.equal(calls[0].api, api);
  assert.equal(calls[0].invokeSetup, true);
});

test("#1585 tryRegisterWhenReady: early registration does not invoke setup itself", () => {
  // loadExtensions() runs BEFORE extensionManager exists. setup() must wait
  // for the framework's wave, or it would paint then get skipped on the
  // real call.
  const calls = [];
  const instance = appLike();
  const out = tryRegisterWhenReady({
    root: { comfyAPI: { app: { app: instance } } },
    register: (args) => calls.push(args),
  });
  assert.equal(out.status, "registered");
  assert.equal(out.invokeSetup, false);
  assert.equal(calls[0].invokeSetup, false);
});

test("#1585 wiring: the panel drives tryRegisterWhenReady, not a second lookup", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(src, /from "\.\/lib\/resolve-comfy-app\.js"/);
  const fnAt = src.indexOf("function registerExtensionWhenReady(");
  assert.notEqual(fnAt, -1);
  const body = src.slice(fnAt, src.indexOf("\nregisterExtensionWhenReady();"));
  assert.match(body, /tryRegisterWhenReady\(/);
  assert.doesNotMatch(
    body,
    /window\.comfyAPI\?\.app\?\.app \|\| window\.app/,
    "the old two-shape lookup must not still be the registration gate",
  );
  // A late registration (tab API already live) must invoke setup() itself —
  // that is the only way the Agent tab appears when the poller missed the wave.
  assert.match(body, /invokeSetup/);
  assert.match(body, /extension\.setup\(\)/);
});
