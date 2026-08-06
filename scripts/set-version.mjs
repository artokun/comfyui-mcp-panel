#!/usr/bin/env node
// Bump the panel version and rename the complete frontend bundle directory.
// The directory name is part of every discovered, runtime, and relative-dependency
// URL, so each release has an immutable browser module graph.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+([-.].+)?$/.test(version)) {
  console.error(`usage: node scripts/set-version.mjs <version>  (got: ${version ?? "nothing"})`);
  process.exit(1);
}

const pyPath = join(root, "pyproject.toml");
const initPath = join(root, "__init__.py");
const py = readFileSync(pyPath, "utf-8");
const currentMatch = py.match(/^version = "([^"]+)"/m);
if (!currentMatch) {
  console.error("could not find current version in pyproject.toml");
  process.exit(1);
}
const currentVersion = currentMatch[1];
const currentBundleDir = join(root, "web", `v${currentVersion}`);
const nextBundleDir = join(root, "web", `v${version}`);
const runtimePath = join(currentBundleDir, "js", "comfyui-mcp-panel.mjs");
if (!existsSync(runtimePath)) {
  console.error(`could not find panel runtime for ${currentVersion}: ${runtimePath}`);
  process.exit(1);
}
if (version !== currentVersion && existsSync(nextBundleDir)) {
  console.error(`refusing to overwrite versioned bundle directory: ${nextBundleDir}`);
  process.exit(1);
}

const runtime = readFileSync(runtimePath, "utf-8");
const runtime2 = runtime.replace(/const PANEL_VERSION = "[^"]+"/, `const PANEL_VERSION = "${version}"`);
if (runtime2 === runtime && version !== currentVersion) {
  console.error("could not find PANEL_VERSION in comfyui-mcp-panel.mjs");
  process.exit(1);
}
const init = readFileSync(initPath, "utf-8");
const init2 = init.replace(/_PANEL_WEB_VERSION = "[^"]+"/, `_PANEL_WEB_VERSION = "${version}"`);
if (init2 === init && version !== currentVersion) {
  console.error("could not find _PANEL_WEB_VERSION in __init__.py");
  process.exit(1);
}

if (version !== currentVersion) renameSync(currentBundleDir, nextBundleDir);
writeFileSync(pyPath, py.replace(/^version = "[^"]+"/m, `version = "${version}"`));
writeFileSync(initPath, init2);
writeFileSync(join(nextBundleDir, "js", "comfyui-mcp-panel.mjs"), runtime2);
console.log(`set version ${version} in pyproject, runtime, and frontend directory`);

try {
  execFileSync("node", [join(root, "scripts", "gen-changelog.mjs"), version], { stdio: "inherit" });
} catch (err) {
  console.warn(`changelog generation skipped: ${err instanceof Error ? err.message : String(err)}`);
}
