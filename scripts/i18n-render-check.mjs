#!/usr/bin/env node
/**
 * Render every key of every shipped catalog through the REAL `tr()` and inspect the output.
 *
 *   node scripts/i18n-render-check.mjs            # every language
 *   node scripts/i18n-render-check.mjs ru ar      # just these
 *
 * Why this exists, given that i18n-check.mjs already validates the catalogs.
 *
 * i18n-check compares two JSON files. It can prove the key sets line up and the placeholder
 * NAMES match. It cannot see what a user sees, because between the file and the screen sits
 * `tr()` — plural category selection, single-pass interpolation, per-key English fallback.
 * Every bug that survived the last pass lived in that gap, including one inside the detector
 * written to catch them. So this loads the actual catalog into the actual module and reads
 * the actual string that would be painted.
 *
 * What it asserts, all of which are defects rather than incompleteness:
 *   · a key never renders as its own name (the classic "panel.cancel" leaking onto a button)
 *   · every placeholder the English carries is SUBSTITUTED, not merely present — a renamed
 *     hole survives interpolation verbatim, so `{coutn}` ships as visible text
 *   · no brace residue of any kind is left in the output
 *   · every plural base resolves to a non-empty string across counts 0,1,2,3,5,11,21,100 —
 *     the counts that separate Russian's four categories and Arabic's six
 *   · leading and trailing spaces survive, because several English values are FRAGMENTS
 *     concatenated onto a sentence (" (auto-matched)") and losing the space closes the gap
 *   · no underscore-joined word contains a non-ASCII letter, which is a CI failure in
 *     check-tool-vocabulary and is otherwise discovered only after the PR is open
 *   · no value contains a raw catalog key, i.e. a translator pasted the key instead of text
 *
 * Coverage is REPORTED, never failed — a missing key renders correct English by design.
 */
import fs from 'fs';
import path from 'path';
import { tr, __setCatalogForTest } from '../web/js/lib/i18n.js';

const ROOT = path.resolve(import.meta.dirname, '..');
// `--locales <dir>` so the rules below can be fired at a FIXTURE. An instrument that has only
// ever been pointed at catalogs it passes is not known to work.
const dirArg = process.argv.indexOf('--locales');
const LOCALES = dirArg > -1 && process.argv[dirArg + 1]
  ? path.resolve(process.argv[dirArg + 1])
  : path.join(ROOT, 'locales');
const NS = 'comfyuiMcpPanel';
const COUNTS = [0, 1, 2, 3, 5, 11, 21, 100];

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const flat = (node, prefix = '', out = new Map()) => {
  for (const [k, v] of Object.entries(node ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flat(v, key, out);
    else out.set(key, v);
  }
  return out;
};
const pluralSplit = (key) => {
  const m = key.match(/^(.*)_(zero|one|two|few|many|other)$/);
  return m ? { base: m[1], cat: m[2] } : null;
};
const holes = (s) => [...new Set(String(s).match(/\{[a-zA-Z0-9_]+\}/g) || [])].map((h) => h.slice(1, -1));

const enMain = readJson(path.join(LOCALES, 'en', 'main.json'));
if (!enMain) {
  console.error('no locales/en/main.json — run: npm run i18n:build');
  process.exit(1);
}
const enFlat = flat(enMain[NS]);
const AREAS = [...new Set([...enFlat.keys()].map((k) => k.split('.')[0]))];
const KEY_SHAPED = new RegExp(`\\b(?:${AREAS.join('|')})\\.[a-z0-9_]{3,}`);

const plain = new Map();
const bases = new Map();
for (const [key, text] of enFlat) {
  const p = pluralSplit(key);
  if (p) {
    if (!bases.has(p.base)) bases.set(p.base, {});
    bases.get(p.base)[p.cat] = text;
  } else {
    plain.set(key, text);
  }
}

/** Sentinels rather than realistic values: if a hole is not substituted, the marker is the
 *  thing that shows up missing, and it cannot be confused with catalog text.
 *
 *  Numbered, NOT named after the hole. A sentinel spelling out `node_id` carries an
 *  underscore into the rendered string, where it lands against whatever follows the hole —
 *  and in Korean that is a particle, so the underscore rule below fired on seven perfectly
 *  correct translations. The real substitution is a node id like `42`, which glues onto
 *  nothing. The sentinel must not invent a character the runtime never produces. */
const varsFor = (names, count) => {
  const vars = {};
  names.forEach((n, i) => (vars[n] = `⟦v${i}⟧`));
  if (count !== undefined) vars.count = count;
  return vars;
};

const requested = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--locales');
const available = fs.existsSync(LOCALES)
  ? fs.readdirSync(LOCALES, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'en').map((e) => e.name)
  : [];
const targets = requested.length ? requested : available;

let failures = 0;
const shown = new Map();
const fail = (locale, msg) => {
  failures++;
  const n = (shown.get(locale) ?? 0) + 1;
  shown.set(locale, n);
  if (n <= 10) console.error(`  ✗ ${locale}: ${msg}`);
  else if (n === 11) console.error(`  … further ${locale} problems suppressed`);
};

for (const locale of targets) {
  const file = path.join(LOCALES, locale, 'main.json');
  const doc = readJson(file);
  if (!doc) {
    console.log(`  · ${locale} absent (renders English in full)`);
    continue;
  }
  __setCatalogForTest(locale, doc[NS]);
  const targetFlat = flat(doc[NS]);

  // The two source-text rules run over the RAW catalog value, because that is what CI reads.
  // Running them on the rendered output instead asks a different question — one whose answer
  // depends on the test's own substitution values rather than on the file that ships.
  for (const [key, value] of targetFlat) checkSource(locale, key, value);

  // settings.json gets the same source-text rules. It was skipped entirely, and the gap was
  // hit for real: a zh-TW tooltip ending `…例如 OPENROUTER_API_KEY）` glues a fullwidth
  // parenthesis onto an identifier, which check-tool-vocabulary rejects — and this script
  // still printed "rendering OK". Only the CI-only vocabulary gate caught it. That rule bites
  // hardest in Chinese, where （）：、， all fall inside its character class and extend the
  // match across the surrounding Han text.
  //
  // Settings do not go through tr() — ComfyUI renders them from its own /i18n payload — so
  // there is nothing to render here, only text to inspect.
  const settings = readJson(path.join(LOCALES, locale, 'settings.json'));
  if (settings) for (const [key, value] of flat(settings)) checkSource(locale, `settings.${key}`, value);

  let rendered = 0;
  let fellBack = 0;

  for (const [key, en] of plain) {
    const present = targetFlat.has(key);
    if (!present) {
      fellBack++;
      continue;
    }
    rendered++;
    const names = [...new Set([...holes(en), ...holes(targetFlat.get(key))])];
    const vars = varsFor(names);
    let out;
    try {
      out = tr(key, en, names.length ? vars : undefined);
    } catch (e) {
      fail(locale, `${key}: tr() threw — ${e.message}`);
      continue;
    }
    checkOne(locale, key, en, out, names, vars);
  }

  for (const [base, forms] of bases) {
    // A base this language has not begun renders English through the fallback — the same
    // situation as any missing key, and not something to report as broken.
    const started = [...targetFlat.keys()].some((k) => pluralSplit(k)?.base === base);
    if (!started) {
      fellBack++;
      continue;
    }
    rendered++;
    const names = [...new Set(Object.values(forms).flatMap(holes))];
    for (const count of COUNTS) {
      const vars = varsFor(names.filter((n) => n !== 'count'), count);
      let out;
      try {
        out = tr(base, forms, vars);
      } catch (e) {
        fail(locale, `${base} @count=${count}: tr() threw — ${e.message}`);
        break;
      }
      if (typeof out !== 'string' || !out.length) {
        fail(locale, `${base} @count=${count}: rendered empty`);
        break;
      }
      if (names.includes('count') && !out.includes(String(count))) {
        fail(locale, `${base} @count=${count}: the number is missing from "${out}"`);
        break;
      }
      const residue = out.match(/\{[a-zA-Z0-9_]+\}/);
      if (residue) {
        fail(locale, `${base} @count=${count}: unsubstituted ${residue[0]} in "${out}"`);
        break;
      }
    }
  }

  const total = plain.size + bases.size;
  const pct = total ? Math.round((rendered / total) * 100) : 100;
  console.log(
    `  ${failures && shown.get(locale) ? '✗' : '✓'} ${locale} — ${rendered}/${total} rendered (${pct}%), ${fellBack} fall back to English`,
  );
}

function checkOne(locale, key, en, out, names, vars) {
  if (typeof out !== 'string' || !out.length) return void fail(locale, `${key}: rendered empty`);
  if (out === key || out.includes(key)) return void fail(locale, `${key}: rendered its own key`);
  for (const n of names) {
    if (!out.includes(vars[n])) {
      return void fail(locale, `${key}: {${n}} was never substituted — rendered "${out}"`);
    }
  }
  const residue = out.match(/\{[a-zA-Z0-9_]+\}/);
  if (residue) return void fail(locale, `${key}: unsubstituted ${residue[0]} in "${out}"`);
  // A fragment concatenated onto a sentence loses its join if the space is dropped, and the
  // result reads as a typo in the middle of a line rather than as a translation defect.
  //
  // Fullwidth punctuation is the legitimate exception, not a loophole. Chinese writes
  // "工作流：" for English's "Graph: " — U+FF1A already occupies a full character cell, so a
  // trailing space after it is a typographic ERROR. Demanding byte-for-byte whitespace parity
  // here would have made three correct Chinese strings look like defects, which is how a
  // check earns a reputation for crying wolf and stops being read.
  const padded = (s) => /[\s\u3000-\u303F\uFF00-\uFFEF]$/.test(s);
  const leading = (s) => /^[\s\u3000-\u303F\uFF00-\uFFEF]/.test(s);
  if (leading(en) && !leading(out)) {
    return void fail(locale, `${key}: English starts with a space; this joins straight onto the text before it`);
  }
  if (padded(en) && !padded(out)) {
    return void fail(locale, `${key}: English ends with a space; this joins straight onto the value after it`);
  }
}

/** Rules about the catalog TEXT itself, evaluated on the value as it ships. */
function checkSource(locale, key, out) {
  // check-tool-vocabulary rule 2b, run here instead of after the PR is open: any
  // underscore-joined word carrying a non-ASCII LETTER fails CI, which is what happens when
  // a particle or suffix is glued straight onto an identifier (panel_find_nodes + a suffix).
  // Character class copied from the gate, but with \u escapes rather than the literal
  // U+0080/U+FFFF bytes: a raw C1 control byte keeps the file git-TEXT while silently
  // breaking the pattern if anything ever re-encodes it.
  for (const m of out.matchAll(/[A-Za-z0-9_\u0080-\uFFFF]*_[A-Za-z0-9_\u0080-\uFFFF]*/g)) {
    if ([...m[0]].some((c) => c.codePointAt(0) > 0x7f && /[\p{L}\p{M}\p{Cf}]/u.test(c))) {
      fail(locale, `${key}: "${m[0]}" glues non-ASCII onto an underscored word — CI rejects this`);
      return false;
    }
  }
  const keyish = out.match(KEY_SHAPED);
  if (keyish) {
    fail(locale, `${key}: contains a raw catalog key "${keyish[0]}" — text was expected`);
    return false;
  }
  return true;
}

if (failures) {
  console.error(
    `\n${failures} rendering problem(s). These are defects, not incompleteness: a missing key ` +
      `renders correct English, but a dropped placeholder, an empty plural form, or a key that ` +
      `renders as its own name reaches the user as broken text.`,
  );
  process.exit(1);
}
console.log('rendering OK');
