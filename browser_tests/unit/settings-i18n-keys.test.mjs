// The Settings rows are translated with ZERO JavaScript, which is also why nothing else
// notices when they stop being translated.
//
// ComfyUI paints our `settings: [...]` block in its OWN dialog and looks each row up as
// `settings.<normalizeI18nKey(id)>.name` / `.tooltip` in the catalog merged from
// locales/<lang>/settings.json (SettingItem.vue; `normalizeI18nKey` replaces dots with
// underscores and PRESERVES hyphens). There is no call site to break and no exception to
// catch: a key that does not match an id simply falls back to the English literal
// registered in the code, and the row renders in English in every language, forever, while
// every test and the Zod locale gate stay green — the gate only checks that the four
// catalogs agree with EACH OTHER, never that any of their keys reaches a real setting.
//
// So this asserts the join the mechanism depends on, in both directions:
//   · every registered setting id has a catalog entry (a new row can't ship untranslated)
//   · every catalog key resolves to a registered id (a typo'd or stale key can't linger)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// Newlines normalized: this file is checked out with CRLF on Windows, and the
// column-0 `}` that ends panelSettingsList() is located by an anchored newline below.
const SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");
const EN = JSON.parse(readFileSync(join(HERE, "../../locales/en/settings.json"), "utf8"));

/** ComfyUI's own transform (utils/formatUtil.ts). Dots to underscores; hyphens survive. */
const normalizeI18nKey = (id) => id.replace(/\./g, "_");

/** `const SETTING_X = "comfyui-mcp.y";` — the single-string ids, by constant name. */
function settingConstants() {
  const out = new Map();
  for (const m of SRC.matchAll(/^const (SETTING_[A-Z0-9_]+) = "([^"]+)";$/gm)) out.set(m[1], m[2]);
  return out;
}

/** The body of panelSettingsList(), so a `id:` elsewhere in the file cannot leak in. */
function settingsListBody() {
  const start = SRC.indexOf("function panelSettingsList() {");
  assert.notEqual(start, -1, "panelSettingsList() must exist");
  // The function is top-level, so its closing brace is the next `}` in column 0.
  const end = SRC.indexOf("\n}\n", start);
  assert.notEqual(end, -1, "panelSettingsList() must be closed");
  const body = SRC.slice(start, end);
  // A column-0 `}` introduced INSIDE the function (a template literal, a re-indent) would
  // truncate the slice silently — ids after the cut would vanish and both assertions would
  // pass while checking a fraction of the list. So the slice has to be shown to reach the
  // end: the LAST row registered in the returned array, and the array's own terminator.
  assert.match(body, /tokenSetting\(SETTING_TOKEN_HF\b/, "the extracted body is truncated before the last row");
  assert.match(body, /\n {2}\];\s*$/, "the extracted body does not end at the returned array");
  return body;
}

/** Every setting id the extension actually registers. */
function registeredIds() {
  const consts = settingConstants();
  const body = settingsListBody();
  const ids = new Set();

  // Rows written inline: `id: "comfyui-mcp.starGithub"` or `id: SETTING_BACKEND`.
  for (const m of body.matchAll(/\bid: "(comfyui-mcp\.[^"]+)"/g)) ids.add(m[1]);
  for (const m of body.matchAll(/\bid: (SETTING_[A-Z0-9_]+)\b/g)) {
    // `id: SETTING_MODEL[backend]` inside a factory resolves to no single string — the
    // factory's real ids come from its CALL SITES below, so skipping is correct here.
    const v = consts.get(m[1]);
    if (v) ids.add(v);
  }
  // Rows produced by the factories, one id per call site. These are the 29 rows that have
  // no `id:` literal anywhere, and the ones a per-provider tooltip is most likely to miss.
  for (const m of body.matchAll(/\bmodelSetting\("([a-z0-9]+)"/g)) ids.add(`comfyui-mcp.defaultModel.${m[1]}`);
  for (const m of body.matchAll(/\beffortSetting\("([a-z0-9]+)"/g)) ids.add(`comfyui-mcp.defaultEffort.${m[1]}`);
  for (const m of body.matchAll(/\btokenSetting\((SETTING_[A-Z0-9_]+)/g)) {
    const v = consts.get(m[1]);
    if (v) ids.add(v);
  }
  return ids;
}

test("every registered setting id has an English name and tooltip in the catalog", () => {
  const ids = [...registeredIds()].sort();
  // A silent zero, or a collapse to the handful of inline rows, would make every assertion
  // below vacuous — the failure mode this file exists to prevent.
  assert.ok(ids.length >= 50, `expected the full settings list, extracted ${ids.length}`);

  const missing = ids.filter((id) => !EN[normalizeI18nKey(id)]);
  assert.deepEqual(missing, [], `setting ids with no locales/en/settings.json entry:\n  ${missing.join("\n  ")}`);

  const incomplete = ids.filter((id) => {
    const row = EN[normalizeI18nKey(id)];
    return !row?.name?.trim() || !row?.tooltip?.trim();
  });
  assert.deepEqual(incomplete, [], `catalog entries missing name or tooltip:\n  ${incomplete.join("\n  ")}`);
});

test("every catalog key resolves to a registered setting id", () => {
  const registered = registeredIds();
  // The key transform is only reversible while no id contains a literal underscore. If one
  // ever does, `a_b` becomes ambiguous and a key can silently address the wrong row — so
  // that is checked rather than assumed.
  const underscored = [...registered].filter((id) => id.includes("_"));
  assert.deepEqual(underscored, [], "a setting id with an underscore makes its i18n key ambiguous");

  const normalized = new Set([...registered].map(normalizeI18nKey));
  const orphans = Object.keys(EN).filter((k) => !normalized.has(k));
  assert.deepEqual(
    orphans,
    [],
    `locales/*/settings.json keys matching no registered setting (typo, or the row was removed):\n  ${orphans.join("\n  ")}`,
  );
});
