#!/usr/bin/env node
/**
 * Lay out a language's translation work as area-sized files, with the plural categories
 * already decided.
 *
 *   node scripts/i18n-skeleton.mjs ko
 *
 * Two problems this removes.
 *
 * The first is plural categories. `Intl.PluralRules` decides which forms a language may
 * carry, and the gate enforces it exactly: Korean takes only `_other`, Russian needs
 * one/few/many/other, Arabic six. A translator working from the English `_one`/`_other` pair
 * gets that wrong in both directions, and the wrong answer renders as plausible text to
 * anyone who does not speak the language. So the skeleton emits exactly the keys the language
 * is allowed to have — the translator never decides, and never has to know the rule.
 *
 * The second is size. A thousand-key JSON file written in one pass is where a long generation
 * truncates, and a truncated catalog still PASSES the gate, because missing keys are legal
 * and fall back to English. Split by UI area (panel, training_ui, civitai_ui…) each piece is
 * a screen's worth of strings, and `i18n-merge-parts.mjs` reassembles them.
 *
 * Output goes to `.i18n-work/<lang>/`, deliberately OUTSIDE `locales/` — scratch files cannot
 * be committed by accident from there, and a half-finished area can never be served.
 *
 * An existing translation is carried through, so a language that is partly done (ja, zh) is
 * seeded with its own work rather than reset to English. `_TODO.json` lists what is still
 * English, which is the actual worklist.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOCALES = path.join(ROOT, 'locales');
const NS = 'comfyuiMcpPanel';

const lang = process.argv[2];
if (!lang) {
  console.error('usage: node scripts/i18n-skeleton.mjs <lang>   (e.g. ru, zh-TW, pt-BR)');
  process.exit(1);
}

let CATS;
try {
  CATS = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
} catch {
  console.error(`"${lang}" is not a locale Intl recognizes — check the tag (zh-TW, pt-BR).`);
  process.exit(1);
}

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

const enMain = readJson(path.join(LOCALES, 'en', 'main.json'));
const enSettings = readJson(path.join(LOCALES, 'en', 'settings.json'));
if (!enMain) {
  console.error('no locales/en/main.json — run: npm run i18n:build');
  process.exit(1);
}

const enFlat = flat(enMain[NS]);
const existingFlat = flat(readJson(path.join(LOCALES, lang, 'main.json'))?.[NS] ?? {});

// Group English into non-plural keys and plural bases. The bases are re-expanded below into
// THIS language's categories, which is the whole point of the file.
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

// key -> { value, todo }. `todo` means "still reads as English", which is what a translator
// needs to act on — absent and byte-identical-to-English look the same to a user.
const rows = new Map();
for (const [key, en] of plain) {
  const have = existingFlat.get(key);
  rows.set(key, { value: have ?? en, todo: have === undefined || have === en });
}
for (const [base, forms] of bases) {
  for (const cat of CATS) {
    const key = `${base}_${cat}`;
    // Seed from the English form of the SAME category when English declares it, else its
    // `other`, else its `one` — so Russian's `_few` starts from real English text rather
    // than from nothing.
    const en = forms[cat] ?? forms.other ?? forms.one;
    const have = existingFlat.get(key);
    rows.set(key, { value: have ?? en, todo: have === undefined || have === en });
  }
}

const area = (key) => key.split('.')[0];
const byArea = new Map();
for (const [key, row] of rows) {
  const a = area(key);
  if (!byArea.has(a)) byArea.set(a, new Map());
  byArea.get(a).set(key.slice(a.length + 1), row);
}

const outDir = path.join(ROOT, '.i18n-work', lang);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const todo = {};
for (const [a, keys] of [...byArea].sort((x, y) => y[1].size - x[1].size)) {
  const obj = {};
  const pending = [];
  for (const [k, row] of [...keys].sort((x, y) => x[0].localeCompare(y[0]))) {
    obj[k] = row.value;
    if (row.todo) pending.push(k);
  }
  fs.writeFileSync(path.join(outDir, `${a}.json`), JSON.stringify(obj, null, 2) + '\n');
  if (pending.length) todo[a] = pending;
}

// Settings ride a different mechanism (ComfyUI's own settings translation, keyed by id with
// dots turned into underscores) but they are the same job for a translator, so they get a
// part file like everything else.
if (enSettings) {
  const haveSettings = readJson(path.join(LOCALES, lang, 'settings.json')) ?? {};
  const merged = {};
  const pending = [];
  for (const [id, fields] of Object.entries(enSettings)) {
    merged[id] = {};
    for (const [field, en] of Object.entries(fields)) {
      const have = haveSettings[id]?.[field];
      merged[id][field] = have ?? en;
      if (have === undefined || have === en) pending.push(`${id}.${field}`);
    }
  }
  fs.writeFileSync(path.join(outDir, '_settings.json'), JSON.stringify(merged, null, 2) + '\n');
  if (pending.length) todo._settings = pending;
}

fs.writeFileSync(path.join(outDir, '_TODO.json'), JSON.stringify(todo, null, 2) + '\n');

const totalRows = rows.size;
const totalTodo = Object.values(todo).reduce((n, list) => n + list.length, 0);
console.log(`${lang}: plural categories [${CATS.join(', ')}] — ${bases.size} counted string(s)`);
console.log(`wrote .i18n-work/${lang}/ — ${byArea.size} area file(s), ${totalRows} main key(s)`);
for (const [a, keys] of [...byArea].sort((x, y) => y[1].size - x[1].size)) {
  const left = todo[a]?.length ?? 0;
  console.log(`  ${a}.json`.padEnd(22) + `${keys.size} key(s), ${left} still English`);
}
if (enSettings) console.log(`  _settings.json`.padEnd(22) + `${Object.keys(enSettings).length} setting(s)`);
console.log(`\n${totalTodo} string(s) to translate. Do NOT add or remove a _<category> suffix:`);
console.log(`${lang} may use exactly [${CATS.join(', ')}] and the gate rejects anything else.`);
console.log(`When every area file is done: node scripts/i18n-merge-parts.mjs ${lang}`);
