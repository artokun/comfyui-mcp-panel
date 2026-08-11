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

const candidates = [];
const seenKeys = new Map();

for (const file of sources()) {
  const src = fs.readFileSync(file, 'utf8');
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
      if (/\$\{/.test(text)) continue; // template holes: convert by hand, they need vars
      let key = makeKey(file, text);
      // Same text in the same file is one key; different text colliding gets a suffix.
      const prior = seenKeys.get(key);
      if (prior && prior !== text) {
        let n = 2;
        while (seenKeys.has(`${key}_${n}`) && seenKeys.get(`${key}_${n}`) !== text) n++;
        key = `${key}_${n}`;
      }
      seenKeys.set(key, text);
      candidates.push({ key, text, file: path.relative(ROOT, file).replace(/\\/g, '/'), line: i + 1 });
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
