#!/usr/bin/env node
// Single source of truth for bumping the panel version — updates BOTH
// pyproject.toml [project].version AND the PANEL_VERSION constant in
// web/js/comfyui-mcp-panel.js so they can never drift, then stamps the
// changelogs.
//
// It deliberately does NOT write package.json — `npm version` owns that (and the
// lockfile with it). That makes package.json an INDEPENDENT witness: CI and the
// publish gate assert all three agree, so a release that bumps npm and forgets
// to run this script is a red build. Asserting only the two files below would be
// worthless for that, because this one script writes both and they cannot
// disagree — which is exactly how 0.15.86..0.15.96 shipped with pyproject and
// PANEL_VERSION frozen at 0.15.85 and CI green throughout.
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

// #758 — the panel-readable copy, OUTSIDE that catch on purpose.
//
// The narrative changelog may be skipped; this one may not. It has to run AFTER
// gen-changelog, or it captures the file as it was before this version was stamped — and
// then the release ships notes that stop one version short of itself, the panel records
// that version as already announced, and those notes are lost for good.
//
// Not best-effort, and not inside the try: a generator that throws, or a file that cannot
// be read back, must fail the release rather than warn and continue.
execFileSync("node", [join(root, "scripts", "gen-changelog-json.mjs")], { stdio: "inherit" });
{
  let newest;
  try {
    newest = JSON.parse(readFileSync(join(root, "web", "changelog.json"), "utf-8"))?.releases?.[0]?.version;
  } catch (err) {
    console.error(
      `set-version: web/changelog.json is unreadable — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (newest !== version) {
    console.error(
      `set-version: web/changelog.json is STALE — newest entry is ${newest ?? "(none)"}, expected ${version}. ` +
        "Refusing to leave a release that would announce the wrong notes.",
    );
    process.exit(1);
  }
}
