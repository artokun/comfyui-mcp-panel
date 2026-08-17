#!/usr/bin/env node
/**
 * Print ONE version's section from CHANGELOG.md.
 *
 * ONE call site in this repo: `.github/workflows/publish_action.yml`, which
 * feeds the output to `comfy node publish --changelog-file` so it lands in the
 * Registry's "Updates" section for this pack. (The sibling script of the same
 * name in comfyui-mcp additionally writes GitHub Release bodies; this repo does
 * not generate those, so do not assume that integration exists here.)
 *
 * Why this exists: every publish to the Registry has shipped with a BLANK
 * changelog. `comfy node publish` accepts `--changelog-file <path>`, but the
 * wrapper action we used never passed one. CHANGELOG.md is already curated
 * per version (Keep a Changelog), so it is the honest source: it says what
 * changed, in our words, for exactly this version — not a synthesised commit
 * diff and not the whole file.
 *
 * (Ported from comfyui-mcp's scripts/changelog-section.mjs, written for the
 * same defect on that repo's GitHub Release bodies — see mcp#1138.)
 *
 * Usage:  node scripts/changelog-section.mjs 0.11.45 [--file CHANGELOG.md]
 * Exits non-zero (and prints nothing to stdout) when the section is absent or
 * empty. That is a supported outcome, not an error to escalate: the workflow
 * treats it as "no notes for this version" and publishes without them rather
 * than failing the release over missing prose.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const fileFlag = args.indexOf("--file");
const file = fileFlag >= 0 ? args[fileFlag + 1] : "CHANGELOG.md";
const raw = args.find((a) => !a.startsWith("--") && a !== file);
if (!raw) {
  console.error("usage: changelog-section.mjs <version> [--file CHANGELOG.md]");
  process.exit(2);
}
// Accept `v0.11.45` and `0.11.45` alike — callers may hold either, and getting
// this wrong publishes an empty changelog.
const version = raw.replace(/^v/, "");

const md = readFileSync(file, "utf8");
const lines = md.split(/\r?\n/);

// Keep a Changelog heading: `## [0.11.45] - 2026-08-08`. Match the version
// inside brackets exactly, so 0.11.4 never matches 0.11.45's heading.
const isVersionHeading = (line) => /^##\s+\[/.test(line);
const headingVersion = (line) => {
  const m = line.match(/^##\s+\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
};

let start = -1;
for (let i = 0; i < lines.length; i += 1) {
  if (isVersionHeading(lines[i]) && headingVersion(lines[i]) === version) {
    start = i;
    break;
  }
}
if (start === -1) {
  console.error(`changelog-section: no section for ${version} in ${file}`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (isVersionHeading(lines[i])) {
    end = i;
    break;
  }
}

// Drop the heading itself — the caller already knows the version being
// published; repeating "## [0.11.45] - date" in the changelog body is noise.
const body = lines
  .slice(start + 1, end)
  .join("\n")
  .replace(/^\s*\n+/, "")
  .replace(/\s+$/, "");

if (!body) {
  console.error(`changelog-section: section for ${version} is empty in ${file}`);
  process.exit(1);
}

process.stdout.write(body + "\n");
