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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8");

test("panel#2023 nothing REQUESTS emoji presentation", () => {
  // U+FE0F forces the emoji face. U+FE0E (text presentation) is fine and is not
  // what this forbids — the point is not to demand a specific font file.
  const forced = [...PANEL_JS].filter((c) => c === "️").length;
  assert.equal(forced, 0, `${forced} U+FE0F (VARIATION SELECTOR-16) still in the bundle`);
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
