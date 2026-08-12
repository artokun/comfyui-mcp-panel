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
// `--locales <dir>` exists so the gate can be run against a FIXTURE. Without it the only way
// to test that a rule fires is to break the shipped catalogs, which is why the plural rules
// below went unverified long enough for one of them to be missing entirely.
const dirArg = process.argv.indexOf('--locales');
const LOCALES_DIR = dirArg > -1 && process.argv[dirArg + 1]
  ? path.resolve(process.argv[dirArg + 1])
  : path.join(ROOT, 'locales');
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

/**
 * A backslash-escape that was never decoded, so it will be PAINTED rather than obeyed.
 *
 * The extractor used to slice literals straight out of the source, escapes and all, so
 * `"…?\n\nThis DELETES…"` reached the catalog as a backslash followed by an `n` and a confirm
 * dialog rendered it verbatim. Thirteen English strings shipped that way, and Korean — the
 * only catalog complete enough to reach them — copied six of them. Nothing could see it: keys,
 * placeholders and plural categories were all still exactly right.
 *
 * Only the sequences the extractor could produce are matched, so a genuine Windows path in a
 * catalog value (a backslash before an uppercase letter) is not a false positive.
 */
const mangled = (s) => (String(s).match(/\\[ntr"'`]/g) || []).length;

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
    // A base this language has not started renders English through tr()'s fallback, exactly
    // like any other missing key. Only a PARTIALLY-formed plural is a defect — that is the
    // one that silently resolves to `_other` and reads as correct to anyone who does not
    // speak the language. Without this, adding a counted string to English would instantly
    // break every language that has not caught up, which is the same mistake this file
    // already corrected for flat keys.
    if (have.size === 0) continue;
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

    // MISSING keys are reported, not failed.
    //
    // This was originally a hard error, on the reasoning that a half-translated file looks
    // fine to whoever reads English. True — but it makes incompleteness unreachable as a
    // state, and a trial merge proved the consequence: once the conversion units land,
    // English has 410 keys and every other language has 246, so EVERY merge is red until all
    // twelve languages are finished. No language could ever be added incrementally either.
    //
    // `tr()` already falls back per key, so a missing key renders correct English — the
    // honest description is "incomplete", not "broken". What stays a hard error is anything
    // WRONG: a key English does not have, an empty string, a lost {placeholder}, or a plural
    // category the language does not use. Those are defects at any completion level.
    // Coverage is printed on every run so incompleteness is visible rather than silent.
    const targetFlatEarly = flat(target);
    const missingKeys = [...sourceFlat.keys()].filter((k) => !pluralSplit(k) && !targetFlatEarly.has(k));
    const forSchema = withoutPlurals(target);
    for (const k of missingKeys) {
      // Fill missing keys with the English text purely so the SHAPE check can run and find
      // real defects in the keys that ARE present. Nothing is written to disk.
      const parts = k.split('.');
      let cur = forSchema;
      for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
      cur[parts.at(-1)] = sourceFlat.get(k);
    }

    const parsed = schema.safeParse(forSchema);
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
      // A key this language has not reached yet renders English via tr()'s fallback. It is
      // counted in coverage below, not checked for placeholder parity against itself.
      if (!targetFlat.has(key)) continue;
      const tr = targetFlat.get(key);
      if (mangled(tr) > mangled(en)) {
        note(
          `${locale}/${file} @ ${key}: contains an undecoded escape (a backslash before n/t/r/quote) — ` +
            `it will be printed literally, not obeyed. Write a real line break or quote instead.`,
        );
        placeholderBad++;
        continue;
      }
      if (holes(en) !== holes(tr)) {
        note(`${locale}/${file} @ ${key}: placeholders differ — English has [${holes(en) || 'none'}], ${locale} has [${holes(tr) || 'none'}]`);
        placeholderBad++;
        if (placeholderBad > 8) break;
      } else if (tr === en && /[a-z]{4}/.test(en)) {
        untranslated++;
      }
    }

    // Plural forms are skipped above for a good reason — a per-key comparison would flag
    // every English category the language legitimately does not have. But skipping them left
    // the 108 counted strings with NO placeholder check at all, and those are precisely the
    // ones carrying the number: a translation could drop {count}/{n} from all of them and
    // this gate would still print a clean bill. The rendered result is "Deleted nodes" with
    // no number, in the highest-traffic strings the panel has.
    //
    // The reference form is the SAME category when English declares it, else `_other`, else
    // `_one` — so Russian's `_few`, which English will never have, is still checked. All 54
    // English bases carry identical holes across their forms, so that reference is
    // unambiguous rather than a guess. Emptiness is checked here too: `withoutPlurals` strips
    // these keys before the Zod schema runs, so `.min(1)` never sees them either.
    for (const [key, value] of targetFlat) {
      if (placeholderBad > 8) break;
      const p = pluralSplit(key);
      if (!p) continue;
      if (typeof value !== 'string' || value.length === 0) {
        note(`${locale}/${file} @ ${key}: must not be empty`);
        placeholderBad++;
        continue;
      }
      const en =
        sourceFlat.get(key) ?? sourceFlat.get(`${p.base}_other`) ?? sourceFlat.get(`${p.base}_one`);
      // A plural base English does not declare at all is an unknown key; pluralIssues and the
      // schema own that verdict, and reporting it twice would just be noise.
      if (en === undefined) continue;
      if (mangled(value) > mangled(en)) {
        note(
          `${locale}/${file} @ ${key}: contains an undecoded escape (a backslash before n/t/r/quote) — ` +
            `it will be printed literally, not obeyed.`,
        );
        placeholderBad++;
        continue;
      }
      if (holes(en) !== holes(value)) {
        note(
          `${locale}/${file} @ ${key}: placeholders differ — English has [${holes(en) || 'none'}], ${locale} has [${holes(value) || 'none'}]`,
        );
        placeholderBad++;
      }
    }
    if (!placeholderBad) {
      // Coverage counts a key as untranslated if it is ABSENT or byte-identical to English.
      // Both render English to the user, so both are the same thing from where they sit.
      const total = [...sourceFlat.keys()].filter((k) => !pluralSplit(k)).length;
      const done = total - missingKeys.length - untranslated;
      const pct = total ? Math.round((done / total) * 100) : 100;
      const gap = missingKeys.length ? `, ${missingKeys.length} not yet translated (renders English)` : '';
      console.log(`  ✓ ${locale}/${file} — ${done}/${total} keys, ${pct}%${gap}`);
    }
  }
}

if (failures) {
  console.error(
    `\n${failures} problem(s). A translation may be INCOMPLETE — missing keys fall back to ` +
      `English — but it may not be WRONG: no unknown keys, no empty strings, no lost ` +
      `{placeholders}, and only the plural categories the language actually uses.`,
  );
  process.exit(1);
}
console.log('\nlocales OK');
