#!/usr/bin/env node
/**
 * Generate `locales/en/main.json` from the reviewed extractor candidates.
 *
 * English is the SOURCE catalog: it is generated from the code, never hand-edited, so the
 * key set can't drift from what the panel actually renders. Every other language is then
 * validated against it (scripts/i18n-check.mjs).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const all = JSON.parse(
  execSync('node scripts/i18n-extract.mjs --json', { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
);

// ONLY already-converted `tr("key", "English")` sites become catalog entries. The extractor
// also reports PROPOSALS for strings that are still bare literals; those are a to-do list for
// a human, not vocabulary. Emitting them would add keys no code ever looks up, and — because
// the gate demands exact parity — would instantly fail every translated language for keys
// that do not exist yet.
const candidates = all.filter((c) => c.converted);
const proposals = all.length - candidates.length;

// key -> text, de-duplicated. Identical text under the same key is the common case
// (the same label rendered from two places) and collapses to one entry.
const flat = new Map();
for (const c of candidates) {
  const prior = flat.get(c.key);
  if (prior !== undefined && prior !== c.text) {
    console.error(`key collision: ${c.key}\n  a: ${prior}\n  b: ${c.text}`);
    process.exit(1);
  }
  flat.set(c.key, c.text);
}

// Nest `a.b.c` into objects so the file reads by area rather than as one long list.
const nested = {};
for (const [key, text] of [...flat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const parts = key.split('.');
  let cur = nested;
  for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
  cur[parts.at(-1)] = text;
}

const outDir = path.join(ROOT, 'locales', 'en');
fs.mkdirSync(outDir, { recursive: true });
const out = { comfyuiMcpPanel: nested };
fs.writeFileSync(path.join(outDir, 'main.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote locales/en/main.json — ${flat.size} keys`);
if (proposals) {
  console.log(`${proposals} string(s) still unconverted — run \`npm run i18n:extract\` to list them`);
}
