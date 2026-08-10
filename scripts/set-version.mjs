#!/usr/bin/env node
// Single source of truth for bumping the panel version — updates BOTH
// pyproject.toml [project].version AND the PANEL_VERSION constant in
// web/js/comfyui-mcp-panel.js so they can never drift. CI + the publish gate
// assert they match, so forgetting one is a red build, not a silent stale
// version in the "Need help?" diagnostics.
//
//   node scripts/set-version.mjs 0.6.8
//
import { readFileSync, writeFileSync } from "node:fs";
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
const jsPath = join(root, "web/js/comfyui-mcp-panel.js");

const py = readFileSync(pyPath, "utf-8");
const py2 = py.replace(/^version = "[^"]+"/m, `version = "${version}"`);
if (py2 === py || !/^version = "/m.test(py)) {
  console.error("could not find `version = \"...\"` in pyproject.toml");
  process.exit(1);
}

const js = readFileSync(jsPath, "utf-8");
const js2 = js.replace(/const PANEL_VERSION = "[^"]+"/, `const PANEL_VERSION = "${version}"`);
if (js2 === js) {
  console.error("could not find `const PANEL_VERSION = \"...\"` in comfyui-mcp-panel.js");
  process.exit(1);
}

writeFileSync(pyPath, py2);
writeFileSync(jsPath, js2);
console.log(`set version ${version} in pyproject.toml + PANEL_VERSION (web/js/comfyui-mcp-panel.js)`);

// Stamp the changelog for this version (hybrid: keeps hand-written [Unreleased]
// highlights, appends commits since the last release, deduped by PR). Best-effort
// — a bump must not fail because the changelog gen hiccuped.
try {
  execFileSync("node", [join(root, "scripts", "gen-changelog.mjs"), version], { stdio: "inherit" });
} catch (err) {
  console.warn(`changelog generation skipped: ${err instanceof Error ? err.message : String(err)}`);
}
