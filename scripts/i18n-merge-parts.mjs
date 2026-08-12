#!/usr/bin/env node
/**
 * Reassemble `.i18n-work/<lang>/` into `locales/<lang>/{main,settings}.json`.
 *
 *   node scripts/i18n-merge-parts.mjs ru
 *
 * The counterpart to i18n-skeleton.mjs. It refuses rather than merges when a part file has
 * drifted from the English contract, because the failure it is guarding against is silent:
 * a truncated or mis-keyed catalog still passes the locale gate (missing keys are legal and
 * fall back to English), so "it merged and the tests are green" is not evidence that the
 * language is actually there.
 *
 * `--force` writes anyway, for the case where the drift is deliberate and the gate should be
 * the arbiter. It still prints what it found.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NS = 'comfyuiMcpPanel';

const args = process.argv.slice(2);
const force = args.includes('--force');
const lang = args.find((a) => !a.startsWith('--'));
if (!lang) {
  console.error('usage: node scripts/i18n-merge-parts.mjs <lang> [--force]');
  process.exit(1);
}

const workDir = path.join(ROOT, '.i18n-work', lang);
if (!fs.existsSync(workDir)) {
  console.error(`no .i18n-work/${lang} — run: node scripts/i18n-skeleton.mjs ${lang}`);
  process.exit(1);
}

let CATS;
try {
  CATS = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
} catch {
  console.error(`"${lang}" is not a locale Intl recognizes.`);
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
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

const enFlat = flat(readJson(path.join(ROOT, 'locales/en/main.json'))[NS]);
const enBases = new Set([...enFlat.keys()].map(pluralSplit).filter(Boolean).map((p) => p.base));

const problems = [];
const merged = new Map();

for (const file of fs.readdirSync(workDir).filter((f) => f.endsWith('.json'))) {
  if (file === '_TODO.json' || file === '_settings.json') continue;
  const area = file.replace(/\.json$/, '');
  let obj;
  try {
    obj = readJson(path.join(workDir, file));
  } catch (e) {
    // A truncated generation lands here, and this is the ONE place it is loud.
    problems.push(`${file} is not valid JSON: ${e.message}`);
    continue;
  }
  for (const [suffix, value] of Object.entries(obj)) {
    const key = `${area}.${suffix}`;
    if (typeof value !== 'string') {
      problems.push(`${key}: expected a string, got ${typeof value}`);
      continue;
    }
    if (!value.length) {
      problems.push(`${key}: empty`);
      continue;
    }
    const p = pluralSplit(key);
    if (p && enBases.has(p.base)) {
      if (!CATS.includes(p.cat)) {
        problems.push(`${key}: "${p.cat}" is a category ${lang} never uses — allowed: ${CATS.join(', ')}`);
        continue;
      }
    } else if (!enFlat.has(key)) {
      problems.push(`${key}: not a key English declares — the gate rejects unknown keys`);
      continue;
    }
    merged.set(key, value);
  }
}

// Every plural base must be complete or absent. A half-formed one silently resolves to
// `_other` at render time and reads as correct to anyone who does not speak the language.
for (const base of enBases) {
  const have = CATS.filter((c) => merged.has(`${base}_${c}`));
  if (have.length && have.length !== CATS.length) {
    const missing = CATS.filter((c) => !merged.has(`${base}_${c}`));
    problems.push(`${base}: incomplete plural — missing ${missing.map((c) => `_${c}`).join(', ')}`);
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s) in .i18n-work/${lang}:`);
  for (const p of problems.slice(0, 30)) console.error(`  ✗ ${p}`);
  if (problems.length > 30) console.error(`  … ${problems.length - 30} more`);
  if (!force) {
    console.error('\nNothing written. Fix the part files, or re-run with --force.');
    process.exit(1);
  }
  console.error('\n--force given — writing anyway.');
}

const nested = {};
for (const [key, value] of [...merged].sort((a, b) => a[0].localeCompare(b[0]))) {
  const parts = key.split('.');
  let cur = nested;
  for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
  cur[parts.at(-1)] = value;
}

const outDir = path.join(ROOT, 'locales', lang);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'main.json'), JSON.stringify({ [NS]: nested }, null, 2) + '\n');
console.log(`wrote locales/${lang}/main.json — ${merged.size} keys`);

const settingsPart = path.join(workDir, '_settings.json');
if (fs.existsSync(settingsPart)) {
  const settings = readJson(settingsPart);
  const enSettings = readJson(path.join(ROOT, 'locales/en/settings.json'));
  const bad = [];
  for (const [id, fields] of Object.entries(settings)) {
    if (!enSettings[id]) bad.push(`${id}: not a setting English declares`);
    else for (const f of Object.keys(fields)) if (!(f in enSettings[id])) bad.push(`${id}.${f}: unknown field`);
  }
  if (bad.length && !force) {
    for (const b of bad) console.error(`  ✗ ${b}`);
    console.error('settings.json NOT written.');
    process.exit(1);
  }
  fs.writeFileSync(path.join(outDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  console.log(`wrote locales/${lang}/settings.json — ${Object.keys(settings).length} settings`);
}

console.log(`\nNow prove it RENDERS: node scripts/i18n-render-check.mjs ${lang}`);
