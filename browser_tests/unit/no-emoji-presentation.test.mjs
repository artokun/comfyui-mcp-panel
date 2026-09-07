// panel#2023 — the panel was DEMANDING the one font the crash correlates with.
//
// Comfy Desktop's renderer dies in DirectWrite text layout at panel content-update
// moments, several times a day, and takes the ComfyUI server with it. The report
// notes that Windows update KB5120998 replaced `seguiemj.ttf` (Segoe UI Emoji) and
// `SegoeIcons.ttf` two days before the cluster, and lists font fallback for the
// panel's symbol glyphs as a candidate trigger — but as one hypothesis among
// several, with a toggle test still to run.
//
// Two things are checkable here without that test:
//
//   1. the panel's root stack is
//        font-family: var(--font-inter, "Inter", ui-sans-serif, system-ui, sans-serif)
//      with NO symbol or emoji face anywhere in it, so any glyph those faces do not
//      cover must be resolved by fallback — through DirectWrite, on Windows;
//
//   2. nine strings carried U+FE0F, VARIATION SELECTOR-16, which does not merely
//      permit emoji presentation but REQUESTS it — pinning those glyphs to
//      `seguiemj.ttf` specifically, the file the update replaced.
//
// All nine were the warning triangle, and several render exactly where the crash
// timeline puts the failures: graph-validation errors, missing assets and last-run
// failures at run completion; session-replaced and render-in-flight notices.
//
// Removing the selector is worth doing on its own merits — a warning triangle in a
// dense sidebar wants text presentation, not a colour emoji, and forcing an
// emoji-font lookup for it buys nothing. It is NOT claimed as the fix. It removes
// one mandatory dependency on the font the environment changed, which also makes
// it the cheapest arm of the toggle test that issue is waiting on.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_JS = join(HERE, "../../web/js");
const PANEL_JS = readFileSync(join(WEB_JS, "comfyui-mcp-panel.js"), "utf8");

/**
 * EVERY shipped .js, not just the main bundle. The first version of this gate read
 * `comfyui-mcp-panel.js` alone and passed while NINE more selectors sat in
 * web/js/lib -- graph-revert, media-preview and run-completion-frame all RENDER
 * theirs, so the crash surface the fix was meant to remove was still half there.
 * One exit fixed, the siblings left.
 *
 * A pattern that must MATCH text containing the selector writes it as a
 * backslash-uFE0F escape instead (see chat-serialize.js), so this stays a blanket
 * rule with no exemption list to drift out of date.
 */
function shippedJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...shippedJsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("panel#2023 nothing REQUESTS emoji presentation, anywhere in web/js", () => {
  // U+FE0F forces the emoji face. U+FE0E (text presentation) is fine and is not
  // what this forbids — the point is not to demand a specific font file.
  const offenders = [];
  for (const file of shippedJsFiles(WEB_JS)) {
    const n = [...readFileSync(file, "utf8")].filter((c) => c === "️").length;
    if (n > 0) offenders.push(`${file.slice(WEB_JS.length + 1)} (${n})`);
  }
  assert.deepEqual(offenders, [], `U+FE0F still shipped in: ${offenders.join(", ")}`);
});

test("panel#2023 the LOCALE CATALOGS request it either, and they are what renders", () => {
  // The gate above walks every shipped .js and still missed this, because the JS
  // literal is only the FALLBACK. `tr()` resolves the catalog FIRST:
  //
  //     if (loaded) out = catalog[key];
  //     if (out === undefined) out = fallback;
  //
  // So on any normal load the string that reaches the DOM comes from
  // locales/<lang>/main.json, not from the source line next to it. Five keys carried
  // the selector in all twelve languages -- three of them in graph-revert, the very
  // file whose fallbacks were cleaned -- so the render path still asked for the
  // emoji face while the source read as fixed.
  //
  // English is GENERATED (`npm run i18n:build`) from the tr() fallbacks; the other
  // eleven are translations, and the selector is stripped from them byte-wise so no
  // translated wording is touched.
  const offenders = [];
  const localesDir = join(HERE, "../../locales");
  for (const lang of readdirSync(localesDir, { withFileTypes: true })) {
    if (!lang.isDirectory()) continue;
    for (const f of readdirSync(join(localesDir, lang.name))) {
      if (!f.endsWith(".json")) continue;
      const rel = `${lang.name}/${f}`;
      const n = [...readFileSync(join(localesDir, lang.name, f), "utf8")].filter((c) => c === "️").length;
      if (n > 0) offenders.push(`${rel} (${n})`);
    }
  }
  assert.deepEqual(offenders, [], `U+FE0F still shipped in catalogs: ${offenders.join(", ")}`);
});

test("panel#2023 the catalog really does win over the fallback", () => {
  // The reason the test above has to exist. If tr() ever preferred the fallback,
  // cleaning the .js alone WOULD be sufficient and this gate could relax; pin the
  // resolution order so that stays a deliberate decision rather than a silent drift.
  const i18n = readFileSync(join(WEB_JS, "lib/i18n.js"), "utf8");
  const at = i18n.indexOf("export function tr(");
  assert.ok(at > -1);
  const body = i18n.slice(at, at + 900);
  // Anchor on the SINGULAR branch. tr() has a plural branch above it whose own
  // `out === undefined` sits earlier in the function, so an unanchored search
  // compares two different clauses and reports the order backwards.
  const cat = body.indexOf("out = catalog[key];");
  const fb = body.indexOf("out === undefined", cat);
  assert.ok(cat > -1, "tr()'s singular catalog lookup not found");
  assert.ok(fb > cat, "tr() must consult the catalog before falling back");
});

test("panel#2023 the warning glyph itself is still there", () => {
  // The selector goes; the glyph stays. Dropping the warning sign would be a
  // different change, and a worse one — these are the lines that tell a user a run
  // failed or their session was replaced.
  assert.ok(PANEL_JS.includes("⚠"), "the warning sign should still be rendered");
  assert.ok(PANEL_JS.includes("⚠ GRAPH VALIDATION ERRORS"), "…including at run completion");
});

test("panel#2023 the font stack still carries no symbol face — recorded, not fixed", () => {
  // This is the OTHER half of the mechanism and it is deliberately untouched:
  // naming a symbol font would still resolve through DirectWrite, so it is not
  // obviously a fix, and picking one blind on a machine I cannot reproduce is how
  // a mitigation becomes a second bug. Asserted so that if someone does change it,
  // they see this note.
  assert.match(
    PANEL_JS,
    /font-family: var\(--font-inter, "Inter", ui-sans-serif, system-ui, sans-serif\)/,
    "the root stack moved — re-read panel#2023 before changing it",
  );
});
