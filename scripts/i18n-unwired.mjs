#!/usr/bin/env node
/**
 * Find user-visible strings that never reach `tr()`.
 *
 * This is the INVERSE of the coverage metric, and the gap that let "Korean is 100%" be true
 * and wrong at the same time. Coverage compares the ko catalog against the en catalog — but
 * English is GENERATED from `tr()` call sites, so a string that was never wired has no key,
 * appears in neither file, and is invisible to every check we had. The user saw `disconnected`,
 * the composer placeholder and most hover states still in English while the gate read 100%.
 *
 * So this scans for literals flowing into a VISIBLE SINK instead:
 *   - `.textContent` / `.innerText` / `.title` / `.placeholder` / `.ariaLabel` assignment
 *   - `setAttribute("title"|"aria-label"|"placeholder", …)`
 *   - helper functions whose parameter becomes one of those (iconBtn, toolbarBtn, el, makeBtn…)
 *
 *   node scripts/i18n-unwired.mjs           # grouped summary
 *   node scripts/i18n-unwired.mjs --list    # every site
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web', 'js');

function sources() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); }
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(WEB);
  return out.sort();
}

/** Helpers whose Nth argument (0-based) lands in a visible sink. Discovered by reading them. */
const HELPER_ARG = [
  { fn: 'iconBtn', arg: 1 },     // -> b.title AND aria-label
  { fn: 'toolbarBtn', arg: 1 },  // -> span.textContent
  { fn: 'makeBtn', arg: 0 },
  { fn: 'linkBtn', arg: 0 },
];

const SINK_ASSIGN = /\.(textContent|innerText|title|placeholder|ariaLabel)\s*=\s*$/;
const SINK_SETATTR = /setAttribute\(\s*["'](?:title|aria-label|placeholder)["']\s*,\s*$/;

/**
 * Product and vendor names that are correct to leave in English in every language.
 *
 * Without this the gate reports a permanent, unfixable finding — and a gate that is always
 * red is a gate everyone learns to skip, which is worse than not having one. Kept as an
 * explicit list rather than a heuristic so adding a name is a deliberate act.
 */
const BRANDS = new Set([
  'CivitAI', 'Civitai', 'ComfyUI', 'RunPod', 'OpenRouter', 'Claude', 'ChatGPT', 'Gemini',
  'Grok', 'Kimi', 'MiniMax', 'Ollama', 'LM Studio', 'llama.cpp', 'Antigravity', 'PowerShell',
  'GitHub Copilot', 'TestFlight', 'IndexedDB', 'HuggingFace',
]);

/** Literals that are identifiers, wire values or markup rather than prose. */
function notProse(s) {
  if (BRANDS.has(s.trim())) return true;
  // Strip `${…}` first: what matters is whether WORDS survive. `"${k}: ${val}"` and
  // `"✓ ${answerText}"` are pure composition — there is nothing in them for a translator to
  // translate, and flagging them would train whoever runs this to ignore its output.
  const words = s.replace(/\$\{[^}]*\}/g, '').replace(/[^A-Za-z]+/g, ' ').trim();
  if (!/[A-Za-z]{2,}/.test(words)) return true;
  if (s.length < 3 || !/[a-zA-Z]/.test(s)) return true;
  // An identifier needs a NON-LETTER to look like one: `workflow_new`, `pi-plus`, `graph.query`.
  // The original rule here was `^[a-z0-9_.-]+$`, which also swallowed ordinary lowercase words
  // — and `disconnected` is exactly that. It is the first string the user reported, and this
  // detector filtered it out as an identifier. A blind spot in the thing built to find blind
  // spots; only checking against a real report caught it.
  if (/^[a-z0-9][a-z0-9_.-]*$/.test(s) && /[_.\-0-9]/.test(s)) return true;
  if (/^[A-Z0-9_]+$/.test(s)) return true;
  if (/^(pi|pi-)/.test(s)) return true;                  // primeicons
  if (/^https?:|^ws:|^\/|^[.#]/.test(s)) return true;
  if (/^<[a-z]/.test(s)) return true;                    // markup fragments
  return false;
}

const findings = [];
for (const file of sources()) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    // 1) literal flowing straight into a sink
    const STR = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = STR.exec(line)) !== null) {
      const head = line.slice(0, m.index);
      // A sink and its literal are ROUTINELY on different lines — a formatter breaks after
      // `=` whenever the string is long, and long strings are exactly the prose worth
      // translating. Testing only the current line missed `helpDiv.textContent =\n "Click
      // Connect to start…"`, the largest single block of English on the connect screen.
      // This is the SAME multi-line blind spot the original extractor had, reproduced in the
      // detector written to catch what that extractor missed — so join the previous line when
      // the literal starts one.
      const prev = i > 0 && /^\s*$/.test(head) ? lines[i - 1].trimEnd() : '';
      const before = prev ? prev + head : head;
      const text = m[2];
      if (notProse(text)) continue;
      if (/\btr\(/.test(before)) continue;                       // already translated
      if (SINK_ASSIGN.test(before) || SINK_SETATTR.test(before)) {
        findings.push({ file: rel, line: i + 1, sink: 'assign', text: text.slice(0, 60) });
      }
    }
    // 2) literal in a known helper's visible-argument position
    for (const { fn, arg } of HELPER_ARG) {
      const call = new RegExp(`\\b${fn}\\(([^)]*)\\)`);
      const c = line.match(call);
      if (!c) continue;
      const args = c[1].split(',').map((s) => s.trim());
      const a = args[arg];
      if (!a) continue;
      const lit = a.match(/^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/);
      if (lit && !notProse(lit[2])) {
        findings.push({ file: rel, line: i + 1, sink: `${fn}(arg${arg})`, text: lit[2].slice(0, 60) });
      }
    }
  });
}

if (process.argv.includes('--list')) {
  for (const f of findings) console.log(`${f.file}:${f.line}  [${f.sink}]  ${JSON.stringify(f.text)}`);
} else {
  const by = {};
  for (const f of findings) by[f.file] = (by[f.file] || 0) + 1;
  console.log(`${findings.length} unwired user-visible string(s)\n`);
  for (const [f, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), f);
}
process.exitCode = findings.length ? 1 : 0;
