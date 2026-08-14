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

/**
 * A stable, readable key: <fileslug>.<textslug>.
 *
 * Two rules below exist because `check-tool-vocabulary` treats every underscored token
 * beginning with the panel prefix as a possible tool reference. A tool named in PROSE escapes
 * the call-site scan, so such a token that is NOT a real tool reaches the model as an
 * instruction to call something that does not exist. Auto-generated keys walked straight into
 * it twice: a source filename beginning with that prefix became an area of the same shape,
 * and a string whose first word repeated its own area produced a doubled slug. Neither was a
 * tool; both were indistinguishable from one to any text scan.
 *
 * (Deliberately described rather than illustrated — spelling the offending tokens out here
 * would trip the very gate this comment is about, which is itself the point.)
 */
function makeKey(file, text) {
  let fileSlug = path
    .basename(file, '.js')
    .replace(/^cmcp-/, '')
    .replace(/^comfyui-mcp-/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_');
  // An AREA may not look like a panel tool. The bare prefix alone is fine — it is the
  // dotted namespace and is never flattened into an identifier — but prefix+suffix is not.
  if (/^panel_./.test(fileSlug)) fileSlug = fileSlug.replace(/^panel_/, '');
  // First seven words, taken with a single match rather than split/slice/rejoin.
  //
  // Not stylistic. `check-tool-vocabulary` rejects any shape that stitches an identifier
  // together from fragments, because such a shape can evaluate to a real tool name at runtime
  // while leaving no contiguous token for a text scan to find. This builder could only ever
  // produce a catalog key, but the gate cannot know that, and narrowing a safety net to suit
  // one caller is the wrong trade — so the caller changed instead.
  //
  // (Described, not illustrated: the gate reads comments too, so writing the banned shape
  // here would trip it. That is the third time this batch that prose tripped a scanner —
  // worth remembering that a comment is code as far as these gates are concerned.)
  const normalized = text
    .toLowerCase()
    .replace(/\{[^}]*\}/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const textSlug = (normalized.match(/^(?:[a-z0-9]+_){0,6}[a-z0-9]+/) ?? [''])[0]
    // Drop a leading repeat of the area. A string starting with its own area name produced
    // a doubled slug whose flattened form reads as a tool identifier — and it was redundant
    // anyway, since the area already carries that word.
    .replace(new RegExp(`^${fileSlug}_`), '');
  return `${fileSlug}.${textSlug || 'text'}`;
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
/**
 * Index of the `}` closing the object that starts at `s[0]`, skipping braces inside strings.
 *
 * A naive `indexOf('}')` finds the brace inside `{count}` — the FIRST thing every plural
 * fallback contains — so it truncated the object body and every plural site was dropped.
 * Worse, the round-trip guard could not see it: a site the extractor cannot parse is absent
 * from BOTH sides of the comparison, so the gate written to catch exactly this stayed green.
 * Hence `unparsedCallSites()` below, which counts what was skipped rather than what was read.
 */
function matchingBrace(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
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
 * Every `tr(` in the source that `readConverted` did NOT turn into a candidate.
 *
 * This is the blind-spot check. Comparing catalog-to-candidates can only ever police sites
 * the parser already understood; a site it chokes on is invisible to both sides. Counting the
 * difference is the only thing that notices.
 */
export function unparsedCallSites(src, file, parsed) {
  const seen = new Set(parsed.map((c) => c.line));
  const out = [];
  const call = /\btr\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*,/g;
  let m;
  while ((m = call.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    if (!seen.has(line)) out.push({ file, line, key: m[2] });
  }
  return out;
}

/**
 * Turn the SOURCE CHARACTERS between the quotes back into the string the engine builds.
 *
 * Everything here captures a literal by slicing the raw source, which leaves escape sequences
 * as the two characters they are written as. `"…?\n\nThis DELETES…"` reached the catalog as a
 * backslash followed by an `n`, and a confirm dialog rendered that verbatim; `\"` and `\'`
 * did the same in a toast and a provider hint. English is affected too, because the panel
 * loads the `en` catalog rather than falling back to the source expression — so this was
 * visible to every user in every language, in 13 strings, and no gate could see it: key
 * parity, placeholder parity and plural categories are all still perfectly correct.
 */
function unescapeLiteral(raw) {
  return String(raw).replace(
    /\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|[\s\S])/g,
    (whole, _tail, uBrace, u4, x2) => {
      if (uBrace) return String.fromCodePoint(parseInt(uBrace, 16));
      if (u4) return String.fromCharCode(parseInt(u4, 16));
      if (x2) return String.fromCharCode(parseInt(x2, 16));
      const ch = whole[1];
      switch (ch) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'v': return '\v';
        case '0': return '\0';
        // A backslash-newline is a line continuation: it contributes nothing to the value.
        case '\n': return '';
        // \\ \" \' \` and anything else stands for the character itself.
        default: return ch;
      }
    },
  );
}

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
      // Fallbacks are often written as `"first half " + "second half"` to stay inside the
      // line limit. Reading only the first literal put HALF a sentence in the catalog: English
      // still rendered correctly (it evaluates the whole expression at runtime), so every
      // translated language silently lost the rest and nothing in English could reveal it.
      let text = unescapeLiteral(str[2]);
      let tail = rest.slice(str[0].length);
      let more;
      while ((more = tail.match(/^\s*\+\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/))) {
        text += unescapeLiteral(more[2]);
        tail = tail.slice(more[0].length);
      }
      // `"Hello " + name` is a different animal: the variable never reaches the catalog at
      // all, so no translator can move it and RTL languages cannot reorder it. That needs a
      // {placeholder}, and it is reported rather than silently half-captured.
      const varConcat = /^\s*\+\s*[A-Za-z_$]/.test(tail);
      out.push({ key, text, file, line, converted: true, ...(varConcat ? { varConcat: true } : {}) });
      continue;
    }
    // Plural object: emit one candidate per category so English carries `key_one`/`key_other`.
    if (rest.startsWith('{')) {
      const close = matchingBrace(rest);
      if (close === -1) continue;
      const body = rest.slice(1, close);
      const form = /(\w+)\s*:\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g;
      let f;
      while ((f = form.exec(body)) !== null) {
        if (!['zero', 'one', 'two', 'few', 'many', 'other'].includes(f[1])) continue;
        out.push({ key: `${key}_${f[1]}`, text: unescapeLiteral(f[3]), file, line, converted: true });
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
