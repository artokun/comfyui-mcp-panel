#!/usr/bin/env node
/**
 * Fail if the panel references a name that does not resolve.
 *
 *   node scripts/check-panel-scope.mjs
 *
 * ## Why this exists
 *
 * comfyui-mcp-panel#1136: the status pill sat on "disconnected" through a completely healthy
 * session. The cause was one line — `STATUS_LABEL` was declared inside `createBridgeClient`
 * and read inside `buildPanel`, which are sibling functions, so the name was never in scope
 * and `onStatus` threw `ReferenceError` on the FIRST status frame. The socket connected
 * normally and chat worked, so the only visible symptom was a frozen pill; everything after
 * that line in the handler (the Connect button label, the dot class, the dead-bridge liveness
 * fallback) silently never ran.
 *
 * The sweep that found it turned up three more of the same shape, one of them hidden inside a
 * `try/catch` that was meant to guard something else entirely.
 *
 * ## Why it is tsc and not a regex
 *
 * Two hand-rolled detectors were written first and both were measured and thrown away:
 *
 *   - "an identifier declared in one top-level function and used in another" reported 494
 *     findings on the buggy file and 493 on the fixed one. Common local names (`token`,
 *     `nodes`, `rootGraph`) drown the signal completely.
 *   - "ALL_CAPS constants must live at module scope" flags 57 constants that are correctly
 *     function-local.
 *
 * Neither could separate the bug from the noise, because the question is genuinely about
 * lexical scope and only a parser knows the answer. `tsc --checkJs` already does exactly this
 * analysis; it just was not pointed at `web/js` (tsconfig covers only the TypeScript under
 * browser_tests, plus the Playwright config).
 * TS2304 "Cannot find name" is the whole signal — every other diagnostic is ignored, so this
 * is not a typing gate and untyped JS stays untyped.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Names that genuinely exist at runtime but that no type declaration describes.
 * ComfyUI installs LiteGraph as a browser global; the vendored Lit bundle refers to its own
 * internals across its minified chunks. Keep this list short — every entry is a name nothing
 * can check for you.
 */
const ALLOWED = new Set(['LiteGraph', 'litPropertyMetadata']);

/** Vendored bundles are third-party build output; we do not police their internals. */
const IGNORED_PATH = /[\\/]vendor[\\/]/;

const ENTRIES = ['web/js/comfyui-mcp-panel.js'];

/**
 * The checker must be RUNNABLE, and its absence must be loud.
 *
 * This gate lived on a `catch` that harvests tsc's diagnostics — because tsc exits non-zero
 * whenever it emits any, which for this file is always. A tsc that could not START lands in
 * the same catch with empty stdout, produces zero findings, and prints OK. So in any
 * checkout without `node_modules/typescript` — a fresh git worktree, most obviously — the
 * gate reported "every name resolves" while checking nothing.
 *
 * Found by probing it with a name I knew was undefined: it passed. CI, which has the
 * dependency, was failing on a real ReferenceError (`LG`, comfyui-mcp#1582) at the same
 * time the local run said OK.
 */
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(TSC)) {
  console.error(
    `[check-panel-scope] CANNOT RUN — TypeScript is not installed at ${TSC}.\n\n` +
      'This gate is the only thing that catches a name resolving in a sibling function ' +
      'instead of this one, which throws ReferenceError the moment that line runs. It ' +
      'used to print OK in this situation, which is worse than not running at all. ' +
      'Run `npm install` here (a fresh git worktree does not inherit node_modules).',
  );
  process.exit(2);
}

let raw = '';
let ran = false;
try {
  execFileSync(
    process.execPath,
    [
      TSC,
      '--noEmit', '--allowJs', '--checkJs',
      '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'bundler',
      '--lib', 'ES2022,DOM,DOM.Iterable',
      '--skipLibCheck',
      ...ENTRIES,
    ],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  ran = true;
} catch (e) {
  // tsc exits non-zero whenever it emits ANY diagnostic, and this file is full of ordinary
  // untyped-JS complaints. A non-zero exit is expected; the diagnostics are the payload.
  raw = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  // …but a tsc that never STARTED (ENOENT, EACCES, a corrupt install) lands in this same
  // catch with nothing to parse. Zero output is not zero findings.
  if (!raw.trim()) {
    console.error(
      `[check-panel-scope] CANNOT RUN — tsc produced no output (${e.code ?? e.message}). ` +
        'Refusing to report a pass for a check that did not run.',
    );
    process.exit(2);
  }
  ran = true;
}
if (!ran) {
  console.error('[check-panel-scope] CANNOT RUN — the checker did not execute.');
  process.exit(2);
}

const findings = [];
for (const line of raw.split('\n')) {
  const m = line.match(/^(.*?)\((\d+),(\d+)\): error TS2304: Cannot find name '([^']+)'/);
  if (!m) continue;
  const [, file, ln, , name] = m;
  if (IGNORED_PATH.test(file)) continue;
  if (ALLOWED.has(name)) continue;
  findings.push({ file, line: Number(ln), name });
}

if (findings.length) {
  console.error(`[check-panel-scope] FAIL — ${findings.length} unresolved name(s):\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.name}`);
  console.error(
    '\nEach of these throws ReferenceError the moment that line runs. The usual cause is a ' +
      'declaration sitting in a sibling function rather than a shared scope — move it, or ' +
      'import it. If the name is a real runtime global nothing declares, add it to ALLOWED ' +
      'with a reason.',
  );
  process.exit(1);
}
console.log(`[check-panel-scope] OK — every name in ${ENTRIES.join(', ')} resolves.`);
