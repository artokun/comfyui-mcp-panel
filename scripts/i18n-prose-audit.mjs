#!/usr/bin/env node
/**
 * Broadest possible net: every PROSE-shaped literal in the panel sources that is not inside a
 * `tr(` call, regardless of where it flows.
 *
 * Why this exists on top of i18n-unwired.mjs: sink-based detection keeps missing classes.
 * It missed helper argument positions, then a state token behind a variable, then a
 * multi-line assignment — each time reporting ZERO while a user was looking at English on
 * screen. Enumerating sinks means enumerating every way a string can reach a pixel, and that
 * list is not knowable in advance.
 *
 * So this inverts the question: instead of "does this reach a sink I know about", it asks
 * "does this LOOK like something a human reads". Deliberately noisy — agent-facing tool prose
 * and developer diagnostics will appear — but noise a human triages beats silence that reads
 * as done. Output is a worklist, not a gate.
 *
 *   node scripts/i18n-prose-audit.mjs [minWords]
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIN_WORDS = Number(process.argv[2] || 4);

function sources() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); }
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'web', 'js'));
  return out.sort();
}

const findings = [];
for (const file of sources()) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    // Skip comment lines outright — they are not rendered, and flagging them is how a
    // worklist becomes noise nobody reads.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const STR = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = STR.exec(line)) !== null) {
      const text = m[2];
      const words = text.replace(/\$\{[^}]*\}/g, ' ').match(/[A-Za-z][a-z]{2,}/g) || [];
      if (words.length < MIN_WORDS) continue;                 // not a sentence
      if (/^[a-z0-9_]+$/.test(text)) continue;                // identifier
      if (/^https?:|^\//.test(text)) continue;

      // Inside a tr(...) call? Look back a little: the key may be on a previous line.
      const ctx = (lines[i - 1] || '') + line.slice(0, m.index);
      if (/\btr\(\s*(["'][^"']*["']\s*,\s*)?$/.test(ctx)) continue;
      if (/\btr\(/.test(line.slice(0, m.index))) continue;

      findings.push({ file: rel, line: i + 1, text: text.slice(0, 70), words: words.length });
    }
  });
}

findings.sort((a, b) => b.words - a.words);
const byFile = {};
for (const f of findings) byFile[f.file] = (byFile[f.file] || 0) + 1;
console.log(`${findings.length} prose-shaped literal(s) not inside tr() (>=${MIN_WORDS} words)\n`);
for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), f);
if (process.argv.includes('--list')) {
  console.log();
  for (const f of findings.slice(0, 60)) console.log(`${f.file}:${f.line}  ${JSON.stringify(f.text)}`);
}
