// Regression guard for #584: `panel_reload(scope="frontend")` must not rely on
// the old extension-entry URL. ComfyUI discovers only *.js files, so a fresh
// loader path plus a versioned runtime import prevents a cached legacy entry
// from surviving a backend restart.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const loaderPath = fileURLToPath(new URL("../../web/v0.11.38/js/cmcp-panel-loader.js", import.meta.url));
const runtimePath = fileURLToPath(new URL("../../web/v0.11.38/js/comfyui-mcp-panel.mjs", import.meta.url));

test("#584: discovered loader imports the runtime at a versioned, fresh URL", () => {
  assert.ok(existsSync(loaderPath), "the only panel discovery entry must exist as .js");
  assert.ok(existsSync(runtimePath), "the full panel runtime must not be auto-discovered as .js");
  const loader = readFileSync(loaderPath, "utf8");
  const runtime = readFileSync(runtimePath, "utf8");

  const loaderVersion = loader.match(/const PANEL_BUNDLE_VERSION = "([^"]+)"/);
  const runtimeVersion = runtime.match(/const PANEL_VERSION = "([^"]+)"/);
  assert.ok(loaderVersion, "loader exposes a release-stamped bundle key");
  assert.ok(runtimeVersion, "runtime exposes the diagnostics panel version");
  assert.equal(loaderVersion[1], runtimeVersion[1], "reload key and reported panel version cannot drift");
  assert.match(loader, /new URL\("\.\/comfyui-mcp-panel\.mjs", import\.meta\.url\)/);
  assert.match(loader, /runtimeUrl\.searchParams\.set\("v", PANEL_BUNDLE_VERSION\)/);
  assert.match(loader, /await import\(runtimeUrl\.href\)/, "ComfyUI waits for the runtime registration");
  assert.doesNotMatch(loader, /new URL\("\.\/comfyui-mcp-panel\.js"/, "the loader must not import the legacy entry");
});
