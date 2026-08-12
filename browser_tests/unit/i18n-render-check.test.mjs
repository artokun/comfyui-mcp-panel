// Mutation tests for scripts/i18n-render-check.mjs.
//
// That script is the instrument this whole translation effort leans on: it is the only thing
// that puts a real catalog through the real `tr()` and reads what a user would see. An
// instrument that has only ever been pointed at catalogs it passes is not known to work —
// its first run already produced seven false positives (a sentinel containing an underscore,
// which the Korean particle rule then flagged) and three more against correct Chinese
// (fullwidth "：" needs no trailing space). Both were fixed by these fixtures, not by reading
// the code.
//
// So each test here is a catalog built to trip exactly one rule. A green run means every rule
// fires on input designed to break it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts", "i18n-render-check.mjs");
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "locales/en/main.json"), "utf8"));

// Korean: `other` is its only plural category, so a complete counted string is one key.
const CLEAN = {
  about: "정보",
  moved_node_to: "{node_id} 노드를 [{pos}]로 이동했습니다",
  connected_auto_matched: " (자동 매칭됨)",
  nodes_other: "노드 {count}개",
};

function run(panelKeys, locale = "ko") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-render-"));
  fs.mkdirSync(path.join(dir, "en"), { recursive: true });
  fs.mkdirSync(path.join(dir, locale), { recursive: true });
  fs.writeFileSync(path.join(dir, "en/main.json"), JSON.stringify(EN, null, 2));
  fs.writeFileSync(
    path.join(dir, locale, "main.json"),
    JSON.stringify({ comfyuiMcpPanel: { panel: panelKeys } }, null, 2),
  );
  return spawnSync(process.execPath, [SCRIPT, "--locales", dir, locale], { encoding: "utf8" });
}

test("a correct partial catalog renders clean", () => {
  const r = run(CLEAN);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Incompleteness is reported, never failed — the rest falls back to English by design.
  assert.match(r.stdout, /fall back to English/);
});

test("a value that is its own key name is caught", () => {
  const r = run({ ...CLEAN, about: "panel.about" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rendered its own key|raw catalog key/);
});

test("a RENAMED placeholder is caught — it survives interpolation as visible text", () => {
  // The defect i18n-check's name comparison also catches, but here it is observed as the
  // user sees it: the hole is still sitting in the output.
  const r = run({ ...CLEAN, moved_node_to: "{node_ids} 노드를 [{pos}]로 이동했습니다" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /never substituted|unsubstituted/);
});

test("a plural form that lost {count} is caught at every count", () => {
  const r = run({ ...CLEAN, nodes_other: "노드 여러 개" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the number is missing/);
});

test("a leading space dropped from a sentence FRAGMENT is caught", () => {
  // English is " (auto-matched)" — it is appended to a provider name. Without the space the
  // line reads "OpenRouter(auto-matched)", which looks like a typo rather than a bug.
  const r = run({ ...CLEAN, connected_auto_matched: "(자동 매칭됨)" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /starts with a space/);
});

test("fullwidth punctuation satisfies the trailing-space rule without a space", () => {
  // The false positive that made this rule trustworthy. U+FF1A already occupies a full
  // character cell; a space after it would be the actual typographic error.
  const r = run({ about: "정보", connected_auto_matched: " （자동 매칭됨）" }, "zh");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// Assembled at runtime, never written adjacent in source. The rule under test is enforced by
// check-tool-vocabulary over every tracked file — including this one — so spelling the
// offending form out here fails CI on the very commit that adds the test for it. (It also
// passed locally first: that gate reads `git ls-files`, so an untracked new file is invisible
// to it until after `git add`.)
const IDENT = "panel_find_nodes";
const PARTICLE = "로"; // Korean "-ro"; a particle, glued straight onto the preceding word

test("non-ASCII glued onto an underscored word is caught before CI sees it", () => {
  const r = run({ ...CLEAN, about: `${IDENT}${PARTICLE} 이동` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /glues non-ASCII onto an underscored word/);
});

test("the same word separated from the identifier passes", () => {
  const r = run({ ...CLEAN, about: `${IDENT} ${PARTICLE} 이동` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("an empty value is caught", () => {
  const r = run({ ...CLEAN, about: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rendered empty/);
});
