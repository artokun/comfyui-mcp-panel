/**
 * #1585 — find the live ComfyApp across frontend shapes.
 *
 * The Agent tab is registered from `setup()`, and `setup()` only runs if
 * `app.registerExtension(...)` landed BEFORE ComfyUI's setup wave. The
 * previous lookup was `window.comfyAPI.app.app || window.app`. On some
 * 1.49.x Vite/Rolldown builds the instance is `window.comfyAPI.app` (the
 * namespace flattened), so `.app.app` is missing, the poller waits out,
 * `registerExtension` never runs, Settings search finds nothing, and the
 * sidebar never grows an Agent tab — with no `[comfyui-mcp-panel]` line
 * until the 10s timeout, which a "mcp" console filter can miss.
 *
 * These helpers are PURE / dependency-injected (the page is passed in) so
 * the lookup is unit-testable without a browser.
 */

/** True when `value` is something we can call `registerExtension` on. */
export function isComfyApp(value) {
  return Boolean(value && typeof value.registerExtension === "function");
}

/**
 * The live ComfyApp, or `null` if this page has not exposed one yet.
 *
 * Order is load-bearing: the Vite shim puts the instance at
 * `comfyAPI.app.app` and the class at `comfyAPI.app.ComfyApp`, so the
 * nested instance must win over the namespace object. A flattened
 * `comfyAPI.app` (the 1.49 miss) is next. Legacy `window.app` last.
 */
export function resolveComfyApp(root = globalThis) {
  if (!root || (typeof root !== "object" && typeof root !== "function")) return null;
  const comfy = root.comfyAPI;
  const candidates = [
    comfy && comfy.app && comfy.app.app,
    comfy && comfy.app,
    root.app,
  ];
  for (const candidate of candidates) {
    if (isComfyApp(candidate)) return candidate;
  }
  return null;
}

/**
 * The live ComfyApi used for `/extensions`-era fetches. Same three shapes
 * as the app, because the shim wraps `api` the same way it wraps `app`.
 */
export function resolveComfyApi(root = globalThis) {
  if (!root || (typeof root !== "object" && typeof root !== "function")) return null;
  const comfy = root.comfyAPI;
  const candidates = [
    comfy && comfy.api && comfy.api.api,
    comfy && comfy.api,
    root.api,
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      (typeof candidate.fetchApi === "function" || typeof candidate.addEventListener === "function")
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * True when the workspace API that paints sidebar tabs is already live.
 *
 * ComfyUI creates `extensionManager` on the Vue workspace *before*
 * `loadExtensions()` returns on current frontends, and it is definitely
 * live after `invokeExtensionsAsync('setup')`. A registration that lands
 * once this is true can install the tab itself; one that lands earlier
 * must wait for the framework's `setup()` call.
 */
export function canInstallSidebarTab(comfyApp) {
  return typeof comfyApp?.extensionManager?.registerSidebarTab === "function";
}

/**
 * One poll/register cycle. The panel owns the extension object (settings,
 * setup); this module only decides WHETHER to register and WHETHER setup
 * must be invoked here because the framework's wave already passed.
 *
 * Returns:
 *   `{ status: "pending" }` — no app yet; caller retries
 *   `{ status: "stood-down", comfyApp }` — duplicate-copy guard; do not register
 *   `{ status: "registered", comfyApp, api, invokeSetup }` — `register()` ran
 */
export function tryRegisterWhenReady({
  root = globalThis,
  active,
  register,
} = {}) {
  const comfyApp = resolveComfyApp(root);
  if (!isComfyApp(comfyApp)) return { status: "pending" };
  if (typeof active === "function" && !active()) {
    return { status: "stood-down", comfyApp };
  }
  const api = resolveComfyApi(root);
  const invokeSetup = canInstallSidebarTab(comfyApp);
  if (typeof register === "function") {
    register({ comfyApp, api, invokeSetup });
  }
  return { status: "registered", comfyApp, api, invokeSetup };
}
