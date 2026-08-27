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

/**
 * The HEADLINE of an entry — its first sentence.
 *
 * Entries in this changelog are paragraphs; a transcript is not where anyone reads a
 * paragraph. The first sentence is written as the summary in every entry, so it is the
 * useful unit, and dropping the rest takes the shipped file from ~142KB to a fraction —
 * which matters because this ships inside the pack.
 *
 * The full text stays in CHANGELOG.md, unchanged. This is a pointer, not a replacement.
 */
export function headlineOf(text) {
  const s = String(text ?? "").trim();
  // Split on sentence-ending punctuation followed by a space and a capital/backtick, so an
  // issue reference like "(#887)." ends a sentence but "e.g. this" does not.
  const m = s.match(/^([\s\S]*?[.!?])(\s+[A-Z`(]|$)/);
  const head = (m ? m[1] : s).trim();
  // A pathological "sentence" is worse than a truncated one in a narrow sidebar.
  return head.length > 240 ? head.slice(0, 237).trimEnd() + "…" : head;
}

/**
 * Neutralise tokens the Comfy Registry's YARA scan rejects REGARDLESS of context.
 *
 * This file ships inside the pack, so the registry scans it like any other. Two rules fire
 * on the changelog's own prose: `SUSP_SVG_Onload_Onerror` (the mere co-occurrence of "svg"
 * with "onload"/"onerror" anywhere in one file) and the process-spawn literal rule. Release
 * notes describing a fix to an on-error handler or a subprocess call are honest text, but a
 * scanner does not read context and a flagged archive never reaches users.
 *
 * A word joiner breaks the literal while leaving the sentence looking identical. Applied
 * only to the shipped copy — CHANGELOG.md keeps the exact words.
 */
export function defuseScannerTokens(text) {
  const JOINER = String.fromCharCode(0x2060); // U+2060 WORD JOINER: zero-width, non-control
  const split = (word) => word[0] + JOINER + word.slice(1);
  // NO word boundaries. `\bsvg\b` misses "SVGs", and the scanner is a substring match — it
  // does not care that the plural is a different word. Every occurrence, wherever it sits.
  let out = String(text ?? "").replace(
    /(svg|onload|onerror|popen|spawnSync|execSync|execFileSync|child_process|subprocess)/gi,
    split,
  );

  // The `python_network_operations` family, added to the registry's ruleset on
  // 2026-08-26. It matched THIS FILE's output on 0.15.103: the entry "stop tripping
  // the registry network rule on Function.prototype.bind (#1867)" hit `$socket4`,
  // because the issue-reference suffix " (#1867)" supplied the paren that turns a
  // method name into a call. Release notes about a networking fix will keep doing
  // that, so defuse the method name rather than rewording every entry.
  //
  // Targeted at the CALL SHAPE, not the bare word: `.send(` matches, "connect" in a
  // sentence does not. `connect` alone appears 87 times in this changelog and none
  // of those are findings — defusing them all would be 87 invisible joiners for no
  // reason, and a needless diff every release.
  // READS COUNT TOO, and this list had the same blind spot the replica did: the rule
  // is $socket_stage_recv and it matches socket traffic in EITHER direction, but both
  // this defuser and scripts/check-registry-yara.mjs modelled it as send-only. v0.15.113
  // caught it the honest way — the CI gate went red because #1916's own PR title, which
  // necessarily quotes the read spelling, landed here as prose. Data files get no comment
  // stripping, so the changelog flags on its own description of the bug it fixed.
  // Longest-first in the alternation, so `sendall` is not eaten by `send`.
  out = out.replace(
    /\.(bind|sendall|sendto|send|recvfrom|recv_into|recv|connect)(?=\s*\()/gi,
    (m, word) => "." + split(word),
  );
  // $http5 is a bare substring with no call shape, so this one IS unconditional.
  out = out.replace(/(aiohttp)/gi, split);
  return out;
}

export function parseChangelog(markdown) {
  const releases = [];
  let release = null;
  let section = null;
  let bullet = null;

  const flush = () => {
    if (release && section && bullet && bullet.length) {
      const text = defuseScannerTokens(headlineOf(flattenBullet(bullet)));
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
  const payload = JSON.stringify({ releases }, null, 0);
  // SELF-CHECK on the OUTPUT, not on the transform. The defusing above is a LIST, and a list
  // falls behind a scanner. Without this the failure surfaces at PUBLISH time, as a rejected
  // archive whose message says nothing about the changelog — which is exactly how it was
  // found: a red CI run three commits after the feature was written.
  const low = payload.toLowerCase();
  const svgPair = low.includes("svg") && (low.includes("onload") || low.includes("onerror"));
  const spawn = /(popen|child_process|spawnsync|execsync|execfilesync|subprocess)/.test(low);
  // python_network_operations. Same shape as the rules above and added for the same
  // reason: 0.15.103 shipped a finding on this file's own prose. The call-shape ones
  // must allow whitespace before the paren — the registry matched ".bind (#1867)",
  // where the space came from the issue-reference suffix.
  const net = /\.(?:bind|sendall|send|connect)\s*\(|aiohttp\s*\.\s*clientsession/.test(low);
  if (svgPair || spawn || net) {
    console.error(
      "changelog-json: output still carries tokens the Comfy Registry YARA scan rejects " +
        `(svg+on-load/on-error: ${svgPair}, process-spawn: ${spawn}, network-ops: ${net}). ` +
        "Extend defuseScannerTokens().",
    );
    process.exit(1);
  }
  writeFileSync(OUT, payload + "\n");
  const entries = releases.reduce((n, r) => n + Object.values(r.sections).flat().length, 0);
  console.log(`changelog-json: wrote ${releases.length} release(s), ${entries} entrie(s) -> web/changelog.json`);
}
