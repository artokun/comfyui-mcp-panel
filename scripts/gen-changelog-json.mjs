#!/usr/bin/env node
// #758 — make CHANGELOG.md readable from inside the panel.
//
//   node scripts/gen-changelog-json.mjs
//
// The panel updates from the Comfy Registry without the user asking, so the first signal
// that something changed is usually behaviour they did not expect — which reads as a bug
// rather than a release. The changelog already answers that; it just lives somewhere the
// user is not.
//
// ComfyUI serves a custom node's `web/` directory at `/extensions/<pack>/`, and CHANGELOG.md
// sits at the repo root, so the panel cannot fetch it. This writes the parsed form into
// `web/changelog.json`, which IS served.
//
// Generated, not hand-maintained: a second copy of the changelog that can drift from the
// first is worse than no copy, because it is the one the user reads.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "CHANGELOG.md");
const OUT = join(ROOT, "web", "changelog.json");

/** Bullet text, flattened to one line. A changelog bullet wraps across source lines and
 *  often carries **bold** lead-ins; the panel renders plain text. */
function flattenBullet(lines) {
  return lines
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

export function parseChangelog(markdown) {
  const releases = [];
  let release = null;
  let section = null;
  let bullet = null;

  const flush = () => {
    if (release && section && bullet && bullet.length) {
      const text = flattenBullet(bullet);
      if (text) (release.sections[section] ||= []).push(text);
    }
    bullet = null;
  };

  for (const raw of String(markdown ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");

    const rel = line.match(/^##\s+\[([^\]]+)\]\s*-\s*(\S+)/);
    if (rel) {
      flush();
      // `[Unreleased]` has no version to compare against and nothing shipped in it.
      if (/^unreleased$/i.test(rel[1])) {
        release = null;
        section = null;
        continue;
      }
      release = { version: rel[1], date: rel[2], sections: {} };
      releases.push(release);
      section = null;
      continue;
    }
    if (/^##\s/.test(line)) {
      flush();
      release = null;
      section = null;
      continue;
    }
    if (!release) continue;

    const sec = line.match(/^###+\s+(.+?)\s*$/);
    if (sec) {
      flush();
      section = sec[1];
      continue;
    }
    // A blockquote under the heading is the "Covers changes since …" note, not an entry.
    if (/^>/.test(line)) continue;

    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) {
      flush();
      if (section) bullet = [item[1]];
      continue;
    }
    // A continuation line belongs to the bullet above it — but only when indented, so a
    // stray paragraph does not get glued onto the previous entry.
    if (bullet && /^\s+\S/.test(raw)) {
      bullet.push(line.trim());
      continue;
    }
    flush();
  }
  flush();
  return releases;
}

// Only when RUN, never when imported. The tests import parseChangelog to exercise the real
// parser rather than a copy of it (the #932 lesson), and an unguarded body would have them
// silently rewrite a shipped file as a side effect of running the suite.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

function main() {
  const releases = parseChangelog(readFileSync(SOURCE, "utf-8"));
  if (!releases.length) {
    // A parser that silently produced nothing would ship an empty file, and the panel would
    // announce nothing forever — which looks exactly like working.
    console.error("changelog-json: parsed ZERO releases — refusing to write an empty file");
    process.exit(1);
  }
  writeFileSync(OUT, JSON.stringify({ releases }, null, 0) + "\n");
  const entries = releases.reduce((n, r) => n + Object.values(r.sections).flat().length, 0);
  console.log(`changelog-json: wrote ${releases.length} release(s), ${entries} entrie(s) -> web/changelog.json`);
}
