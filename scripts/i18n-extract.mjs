#!/usr/bin/env node
/**
 * Propose translatable strings from the panel sources.
 *
 * This REPORTS; it never rewrites. The panel is ~80k lines of DOM-building JS where a
 * user-facing label and an API parameter are both just string literals, so a codemod that
 * guessed would silently rewrite event names, CSS classes and wire-format keys. The output
 * here is reviewed, and only approved (file, line, text) tuples are converted.
 *
 *   node scripts/i18n-extract.mjs            # summary
 *   node scripts/i18n-extract.mjs --json     # full candidate list as JSON
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web', 'js');

/** Files whose strings are ours. Vendored bundles are excluded — not our text to translate. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'vendor') continue;
        walk(p);
      } else if (e.name.endsWith('.js') && !e.name.endsWith('.min.js')) out.push(p);
    }
  };
  walk(WEB);
  return out.sort();
}

/**
 * Contexts where a string literal is almost certainly rendered to a human.
 * Kept narrow on purpose: precision matters more than recall, because a missed string is a
 * visible English word in a translated panel, while a false positive is a broken feature.
 */
const UI_CONTEXT = [
  /\.textContent\s*=\s*$/,
  /\.innerText\s*=\s*$/,
  /\.placeholder\s*=\s*$/,
  /\.title\s*=\s*$/,
  /\.ariaLabel\s*=\s*$/,
  /\.label\s*=\s*$/,
  /setAttribute\(\s*["'](?:title|placeholder|aria-label)["']\s*,\s*$/,
  /\b(?:title|placeholder|label|tooltip|ariaLabel|heading|subtitle|hint|help|message|note|caption|confirmText|cancelText|okText|emptyText)\s*:\s*$/,
];

/** Strings that LOOK like prose but are wire format, selectors, or code. */
function isProbablyNotProse(s) {
  if (s.length < 3) return true;
  if (!/[a-zA-Z]/.test(s)) return true;
  if (/^[a-z0-9_-]+$/.test(s)) return true;              // identifiers / event names
  if (/^[A-Z0-9_]+$/.test(s)) return true;               // CONSTANTS
  if (/^[.#][a-zA-Z][\w-]*$/.test(s)) return true;       // css selectors
  if (/^https?:\/\//.test(s)) return true;
  if (/^[/\\][\w/\\.-]*$/.test(s)) return true;          // paths / routes
  if (/^[\w.-]+\.(?:js|json|css|png|svg|mjs|py)$/.test(s)) return true;
  if (/^\d+(?:px|em|rem|%|s|ms)$/.test(s)) return true;
  if (/^[{}[\]()<>|&/*+-]+$/.test(s)) return true;
  return false;
}

/** A stable, readable key: <fileslug>.<textslug>. */
function makeKey(file, text) {
  const fileSlug = path
    .basename(file, '.js')
    .replace(/^cmcp-/, '')
    .replace(/^comfyui-mcp-/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_');
  const textSlug = text
    .toLowerCase()
    .replace(/\{[^}]*\}/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .split('_')
    .filter(Boolean)
    .slice(0, 7)
    .join('_');
  return `${fileSlug}.${textSlug || 'text'}`;
}

/**
 * Index of the `}` that closes the object starting at `s[0] === '{'`, or -1.
 *
 * `s.indexOf('}')` cannot be used here, and the reason is not hypothetical: a plural fallback
 * is written `{ one: "{count} node", other: "{count} nodes" }`, so the FIRST `}` in the text
 * is the one inside `{count}` — the placeholder that makes it a plural in the first place.
 * Truncating there left a body with no complete `key: "value"` pair, the form regex matched
 * nothing, and the site vanished. Silently: an unreadable call site is missing from BOTH
 * sides of the round-trip comparison, so the gate that exists to catch exactly this stayed
 * green while every counted string in the panel became permanently untranslatable.
 *
 * Braces are therefore counted at depth, skipping string literals (where a `{` or `}` is
 * text, not structure) and their escapes.
 */
function objectBodyEnd(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;            // escaped char — never closes the string
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Read back an ALREADY-CONVERTED call site: `tr("key", "English")`, or the plural form
 * `tr("key", { one: "…", other: "…" })`.
 *
 * This is the authoritative source once conversion has happened, and its absence was a real
 * defect: the context patterns below anchor on the code PRECEDING a literal, so the moment a
 * site becomes `.textContent = tr("panel.save", "Save")` nothing matches it any more. The
 * extractor went from 264 candidates to 1, and regenerating English would have emptied a
 * 247-key catalog and failed the gate with ~246 unknown-key errors in every language.
 * Conversion has to be a round trip, not a one-way door.
 */
function readConverted(src, file) {
  const out = [];
  // `tr(` + a quoted key + `,` + either a quoted string or a `{ one: …, other: … }` object.
  const call = /\btr\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*/g;
  let m;
  while ((m = call.exec(src)) !== null) {
    const key = m[2];
    const rest = src.slice(m.index + m[0].length);
    const line = src.slice(0, m.index).split('\n').length;

    const str = rest.match(/^(["'`])((?:\\.|(?!\1)[^\\])*)\1/);
    if (str) {
      out.push({ key, text: str[2], file, line, converted: true });
      continue;
    }
    // Plural object: emit one candidate per category so English carries `key_one`/`key_other`.
    if (rest.startsWith('{')) {
      const close = objectBodyEnd(rest);
      if (close === -1) continue;
      const body = rest.slice(1, close);
      const form = /(\w+)\s*:\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g;
      let f;
      while ((f = form.exec(body)) !== null) {
        if (!['zero', 'one', 'two', 'few', 'many', 'other'].includes(f[1])) continue;
        out.push({ key: `${key}_${f[1]}`, text: f[3], file, line, converted: true });
      }
    }
  }
  return out;
}

const candidates = [];
const seenKeys = new Map();

for (const file of sources()) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');

  // Converted sites first — they own their key, so a later proposal cannot rename them.
  for (const c of readConverted(src, rel)) {
    const prior = seenKeys.get(c.key);
    if (prior !== undefined && prior !== c.text) {
      console.error(`key "${c.key}" has two different English texts:\n  a: ${prior}\n  b: ${c.text}\n  (${c.file}:${c.line})`);
      process.exitCode = 1;
    }
    seenKeys.set(c.key, c.text);
    candidates.push(c);
  }

  const lines = src.split('\n');
  lines.forEach((line, i) => {
    // Every quoted literal on the line, with the code that precedes it.
    const re = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const text = m[2];
      const before = line.slice(0, m.index);
      if (isProbablyNotProse(text)) continue;
      if (!UI_CONTEXT.some((rx) => rx.test(before))) continue;
      // A literal INSIDE a tr(...) call was already captured by readConverted above; catching
      // it again here would propose a second, derived key for text that already has one.
      if (/\btr\(\s*["'][^"']*["']\s*,\s*$/.test(before)) continue;
      // `${…}` holes still need a human to choose the {var} names, so they are reported as
      // candidates rather than skipped outright — silently dropping them is how a whole class
      // of user-facing strings stayed English through the first pass.
      const interpolated = /\$\{/.test(text);
      let key = makeKey(file, text);
      // Same text in the same file is one key; different text colliding gets a suffix.
      const prior = seenKeys.get(key);
      if (prior && prior !== text) {
        let n = 2;
        while (seenKeys.has(`${key}_${n}`) && seenKeys.get(`${key}_${n}`) !== text) n++;
        key = `${key}_${n}`;
      }
      seenKeys.set(key, text);
      candidates.push({ key, text, file: rel, line: i + 1, interpolated });
    }
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(candidates, null, 2));
} else {
  const byFile = {};
  for (const c of candidates) byFile[c.file] = (byFile[c.file] || 0) + 1;
  console.log(`${candidates.length} candidates (${new Set(candidates.map((c) => c.key)).size} distinct keys)\n`);
  for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) {
    console.log(String(n).padStart(5), f);
  }
}
