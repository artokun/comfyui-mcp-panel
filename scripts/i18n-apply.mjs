#!/usr/bin/env node
/**
 * Rewrite the reviewed call sites to `t("key", "English")`.
 *
 * This is deterministic, not a regex sweep: the extractor already resolved each candidate to
 * an exact (file, line, literal) tuple, so this only replaces a literal it has re-confirmed
 * is still at that line. Anything that moved is REPORTED and skipped rather than guessed at,
 * because the failure mode of a wrong replacement here is a silently broken panel.
 *
 *   node scripts/i18n-apply.mjs --dry     # report only (default)
 *   node scripts/i18n-apply.mjs --write   # apply
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const WRITE = process.argv.includes('--write');

const candidates = JSON.parse(
  execSync('node scripts/i18n-extract.mjs --json', { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
);

/** Group by file so each file is read and written exactly once. */
const byFile = new Map();
for (const c of candidates) {
  if (!byFile.has(c.file)) byFile.set(c.file, []);
  byFile.get(c.file).push(c);
}

/** JS string literal with the quote style the source already used at that spot. */
function literal(text, quote) {
  const escaped = text.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

/** Relative specifier from a source file to web/js/lib/i18n.js. */
function importPathFor(file) {
  const from = path.dirname(path.join(ROOT, file));
  let rel = path.relative(from, path.join(ROOT, 'web/js/lib/i18n.js')).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

let applied = 0;
let skipped = 0;
const skips = [];

for (const [file, items] of [...byFile.entries()].sort()) {
  const abs = path.join(ROOT, file);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  let touched = false;

  // Descending by line so earlier edits never shift later line numbers.
  for (const c of items.sort((a, b) => b.line - a.line)) {
    const idx = c.line - 1;
    const line = lines[idx];
    if (line === undefined) {
      skipped++; skips.push(`${file}:${c.line} line no longer exists`); continue;
    }
    // Re-confirm the literal is still here, in either quote style.
    let found = null;
    for (const q of ['"', "'", '`']) {
      const lit = literal(c.text, q);
      const at = line.indexOf(lit);
      if (at !== -1) { found = { lit, at, q }; break; }
    }
    if (!found) {
      skipped++; skips.push(`${file}:${c.line} literal moved or changed: ${JSON.stringify(c.text.slice(0, 45))}`); continue;
    }
    // Already converted (idempotent re-runs are safe).
    if (/\btr\(\s*$/.test(line.slice(0, found.at))) continue;

    const call = `tr("${c.key}", ${literal(c.text, '"')})`;
    lines[idx] = line.slice(0, found.at) + call + line.slice(found.at + found.lit.length);
    applied++;
    touched = true;
  }

  if (touched && WRITE) {
    // Add the import if this file does not already have one.
    if (!lines.some((l) => /from ["'].*lib\/i18n\.js["']/.test(l))) {
      const spec = importPathFor(file);
      const stmt = `import { tr } from "${spec}";`;
      // Insert BEFORE the first import, never after "the last line starting with import".
      // That heuristic shipped a P0: a multi-line `import {\n  a,\n  b,\n} from "x"` has its
      // opening line match `/^import\s/`, so the new statement landed INSIDE the specifier
      // list and the whole panel became a SyntaxError — no chat, no tools, no settings, in
      // every language. `node --check foo.js` parses as CommonJS and reported OK throughout;
      // only checking it as a MODULE reveals it. Inserting before the first import is
      // position-independent and cannot land inside anything.
      const firstImport = lines.findIndex((l) => /^import\s/.test(l));
      if (firstImport >= 0) lines.splice(firstImport, 0, stmt);
      else {
        // No imports yet: place it after the leading block comment so the file's
        // explanatory header stays at the top where readers expect it.
        let insertAt = 0;
        if (lines[0]?.startsWith('/**') || lines[0]?.startsWith('/*')) {
          const end = lines.findIndex((l) => l.includes('*/'));
          insertAt = end >= 0 ? end + 1 : 0;
        }
        lines.splice(insertAt, 0, stmt);
      }
    }
    fs.writeFileSync(abs, lines.join('\n'));
  }
}

console.log(`${WRITE ? 'applied' : 'would apply'}: ${applied}`);
console.log(`skipped: ${skipped}`);
for (const s of skips.slice(0, 20)) console.log('  ·', s);
if (!WRITE) console.log('\n(dry run — pass --write to apply)');
