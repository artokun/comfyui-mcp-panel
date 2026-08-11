#!/usr/bin/env node
/**
 * Validate every translation against the English source catalog.
 *
 * English is generated from the code (scripts/i18n-build-en.mjs), so it is the contract.
 * A translation may not invent keys, drop keys, or lose an interpolation placeholder —
 * each of those is a defect that is INVISIBLE at runtime, because `t()` falls back to
 * English and the panel looks fine in the one language the author happens to read.
 *
 * The schema is built from the English file at runtime rather than written by hand, so it
 * cannot fall out of date with the catalog it is supposed to police.
 *
 *   node scripts/i18n-check.mjs
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'locales');
const SOURCE = 'en';

const read = (locale, file) => {
  const p = path.join(LOCALES_DIR, locale, file);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${locale}/${file} is not valid JSON: ${e.message}`);
  }
};

/**
 * Mirror the English shape as a strict Zod schema: every key required, every leaf a
 * non-empty string, and `.strict()` at each level so an extra key is a hard failure rather
 * than dead weight that quietly accumulates.
 */
function schemaFor(node, trail = '') {
  if (typeof node === 'string') {
    return z.string().min(1, { message: `must not be empty (${trail})` });
  }
  const shape = {};
  for (const [k, v] of Object.entries(node)) shape[k] = schemaFor(v, trail ? `${trail}.${k}` : k);
  return z.object(shape).strict();
}

/** `{name}` placeholders must survive translation or the value silently never appears. */
const holes = (s) => (String(s).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(',');

const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const pluralSplit = (key) => {
  const m = key.match(/^(.*)_(zero|one|two|few|many|other)$/);
  return m ? { base: m[1], cat: m[2] } : null;
};

/**
 * A counted string must carry EXACTLY the plural categories its language uses — no more, no
 * fewer. Intl knows the CLDR answer per language, so this is checked rather than trusted:
 * Korean takes only `other`, Russian needs one/few/many/other, and a translator working from
 * the English one/other pair will get both of those wrong in a way nothing else detects.
 * The rendered result of a missing category is a silent fall back to `_other`, which reads as
 * correct to anyone who does not speak the language.
 */
function pluralIssues(locale, sourceFlat, targetFlat) {
  let cats;
  try {
    cats = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    return [];
  }
  const required = new Set(cats);
  // Plural bases the SOURCE declares — English only ever has one/other, so the base set comes
  // from English and the required categories come from the target language.
  const bases = new Set();
  for (const key of sourceFlat.keys()) {
    const p = pluralSplit(key);
    if (p) bases.add(p.base);
  }
  const out = [];
  for (const base of bases) {
    const have = new Set(
      [...targetFlat.keys()].map(pluralSplit).filter((p) => p && p.base === base).map((p) => p.cat),
    );
    for (const cat of required) {
      if (!have.has(cat)) out.push(`${base}: missing "_${cat}" — ${locale} requires [${cats.join(', ')}]`);
    }
    for (const cat of have) {
      if (!required.has(cat)) out.push(`${base}: has "_${cat}", which ${locale} never uses — remove it`);
    }
  }
  return out;
}

function flat(node, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(node ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flat(v, key, out);
    else out.set(key, v);
  }
  return out;
}

const FILES = ['main.json', 'settings.json', 'commands.json'];
let failures = 0;
const note = (msg) => {
  failures++;
  console.error(`  ✗ ${msg}`);
};

const locales = fs.existsSync(LOCALES_DIR)
  ? fs.readdirSync(LOCALES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];

if (!locales.includes(SOURCE)) {
  console.error(`no locales/${SOURCE} — run: node scripts/i18n-build-en.mjs`);
  process.exit(1);
}

/**
 * Plural siblings are legitimately per-language — Russian has `_few`/`_many` that English
 * never will, Korean drops `_one` that English needs. Strict key-parity is therefore checked
 * on the NON-plural keys only, and the plural bases are checked separately against Intl.
 * Without this split, a correct Russian file would fail as "unknown key" and the only way to
 * pass would be to make Russian grammatically wrong.
 */
function withoutPlurals(node) {
  if (!node || typeof node !== 'object') return node;
  const out = Array.isArray(node) ? [] : {};
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') {
      out[k] = withoutPlurals(v);
    } else if (!pluralSplit(k)) {
      out[k] = v;
    }
  }
  return out;
}

for (const file of FILES) {
  const source = read(SOURCE, file);
  if (!source) continue;
  const schema = schemaFor(withoutPlurals(source));
  const sourceFlat = flat(source);

  for (const locale of locales.filter((l) => l !== SOURCE).sort()) {
    const target = read(locale, file);
    if (!target) {
      // A language that has not started this file yet is not a failure — it falls back to
      // English in full. Only a PARTIAL file is a defect.
      console.log(`  · ${locale}/${file} absent (falls back to English)`);
      continue;
    }

    const parsed = schema.safeParse(withoutPlurals(target));
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 12)) {
        const at = issue.path.join('.') || '(root)';
        // Zod 4 dropped `issue.received`, so "is it missing?" is answered by walking the
        // target rather than by reading the issue — otherwise every absent key reports as
        // the far less actionable "expected string, received undefined".
        const absent =
          issue.code === 'invalid_type' &&
          issue.path.reduce((o, k) => (o == null ? undefined : o[k]), target) === undefined;
        const why =
          issue.code === 'unrecognized_keys'
            ? `unknown key(s): ${issue.keys.join(', ')} — not in ${SOURCE}/${file}`
            : absent
              ? `missing — present in ${SOURCE}/${file}, must be translated or copied`
              : issue.message;
        note(`${locale}/${file} @ ${at}: ${why}`);
      }
      if (parsed.error.issues.length > 12) {
        note(`${locale}/${file}: ${parsed.error.issues.length - 12} more issue(s)`);
      }
      continue;
    }

    // Shape is right; now check the things a shape check cannot see.
    const targetFlat = flat(target);

    for (const problem of pluralIssues(locale, sourceFlat, targetFlat)) {
      note(`${locale}/${file} @ ${problem}`);
    }

    let placeholderBad = 0;
    let untranslated = 0;
    for (const [key, en] of sourceFlat) {
      // Plural variants are compared by base above; a per-key comparison here would flag
      // every legitimately-absent English category as a mismatch.
      if (pluralSplit(key)) continue;
      const tr = targetFlat.get(key);
      if (holes(en) !== holes(tr)) {
        note(`${locale}/${file} @ ${key}: placeholders differ — English has [${holes(en) || 'none'}], ${locale} has [${holes(tr) || 'none'}]`);
        placeholderBad++;
        if (placeholderBad > 8) break;
      } else if (tr === en && /[a-z]{4}/.test(en)) {
        untranslated++;
      }
    }
    if (!placeholderBad) {
      const pct = Math.round(((sourceFlat.size - untranslated) / sourceFlat.size) * 100);
      console.log(`  ✓ ${locale}/${file} — ${sourceFlat.size} keys, ${pct}% translated`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} problem(s). Translations must match ${SOURCE} exactly.`);
  process.exit(1);
}
console.log('\nlocales OK');
