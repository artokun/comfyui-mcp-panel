// panel#832 — placeholder pinning the CURRENT behaviour; the fix follows.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelSrc = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");
const a2uiSrc = readFileSync(
  fileURLToPath(new URL("../../web/js/cmcp-a2ui.js", import.meta.url)), "utf8");

test("#832 today: a repainted record is rendered INERT and never re-registered", () => {
  const paint = panelSrc.match(/function paintA2UIRecord\(m\) \{[\s\S]*?\n  \}/)[0];
  assert.match(paint, /renderA2UIInert/, "the replay is inert");
  assert.doesNotMatch(paint, /liveA2uiCards\.set/, "and nothing is put back in the live registry");
});

test("#832 today: the record carries no card_id, so a repaint could not restore one", () => {
  const append = panelSrc.match(/function appendA2UICard\(spec\) \{[\s\S]*?\n  \}/)[0];
  assert.match(append, /const rec = \{ role: "card", kind: "a2ui", spec, resolved: false, choice: null \}/);
  assert.doesNotMatch(append, /rec\.cardId/, "the id the agent holds is never persisted on the record");
});

test("#832 today: renderA2UICard always mints a fresh id, with no way to supply one", () => {
  assert.match(a2uiSrc, /export function renderA2UICard\(spec, \{ onAction, onDismiss \} = \{\}\) \{/);
});
