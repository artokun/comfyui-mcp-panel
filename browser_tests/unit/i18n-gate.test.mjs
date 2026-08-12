// The locale gate, tested against fixtures rather than against the shipped catalogs.
//
// Every rule in scripts/i18n-check.mjs exists to catch a defect that is INVISIBLE at
// runtime — `tr()` falls back per key, so a broken translation renders as correct English to
// whoever wrote it. That makes the gate itself the only witness, and an unfired rule is
// indistinguishable from a clean catalog. Two rules were missing for exactly that reason:
// plural keys are excluded from the strict schema and from the placeholder comparison, so a
// translation could drop `{count}` from all 108 counted strings, or leave one empty, and the
// gate still printed a clean bill.
//
// These fixtures are the mutation: each one is a catalog that MUST be rejected. A green run
// here means the rule fired on a catalog built to break it, not that today's catalogs happen
// to be fine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = path.join(ROOT, "scripts", "i18n-check.mjs");
const EN_MAIN = JSON.parse(fs.readFileSync(path.join(ROOT, "locales/en/main.json"), "utf8"));
const EN_SETTINGS = JSON.parse(fs.readFileSync(path.join(ROOT, "locales/en/settings.json"), "utf8"));

/** A locales/ tree holding the real English catalog plus one hand-built translation. */
function fixture(locale, panelKeys) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmcp-i18n-"));
  fs.mkdirSync(path.join(dir, "en"), { recursive: true });
  fs.mkdirSync(path.join(dir, locale), { recursive: true });
  fs.writeFileSync(path.join(dir, "en/main.json"), JSON.stringify(EN_MAIN, null, 2));
  fs.writeFileSync(path.join(dir, "en/settings.json"), JSON.stringify(EN_SETTINGS, null, 2));
  fs.writeFileSync(
    path.join(dir, locale, "main.json"),
    JSON.stringify({ comfyuiMcpPanel: { panel: panelKeys } }, null, 2),
  );
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [CHECK, "--locales", dir], { encoding: "utf8" });

// `panel.nodes` is a real plural base in English ({count} node / {count} nodes), so these
// fixtures exercise the same key the panel actually renders.
const RU_OK = {
  nodes_one: "{count} узел",
  nodes_few: "{count} узла",
  nodes_many: "{count} узлов",
  nodes_other: "{count} узла",
};

test("a complete Russian plural — four categories, placeholder intact — passes", () => {
  const r = run(fixture("ru", RU_OK));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a plural form that DROPPED {count} is rejected", () => {
  // The whole point of a counted string. Without this rule the user reads "узла" with no
  // number and nothing anywhere reports a problem.
  const r = run(fixture("ru", { ...RU_OK, nodes_few: "узла" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nodes_few: placeholders differ/);
});

test("an EMPTY plural form is rejected", () => {
  // `withoutPlurals` strips plural keys before the Zod schema runs, so `.min(1)` never sees
  // them — emptiness has to be checked separately or not at all.
  const r = run(fixture("ru", { ...RU_OK, nodes_many: "" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nodes_many: must not be empty/);
});

test("Russian's _few is checked against English's _other, which English alone never has", () => {
  // The reference form matters: comparing `_few` against a same-named English key would find
  // nothing and skip silently, which is how this hole would reopen.
  const r = run(fixture("ru", { ...RU_OK, nodes_few: "{n} узла" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nodes_few: placeholders differ.*\{count\}.*\{n\}/s);
});

test("a translation missing a category its language requires is still rejected", () => {
  const r = run(fixture("ru", { nodes_one: "{count} узел", nodes_other: "{count} узла" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing "_few"/);
});

test("a translation carrying a category its language never uses is still rejected", () => {
  const r = run(fixture("ko", { nodes_one: "{count}개 노드", nodes_other: "{count}개 노드" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has "_one", which ko never uses/);
});

test("an undecoded backslash escape is rejected", () => {
  // The extractor used to slice literals out of the source with their escapes intact, so a
  // confirm dialog rendered a backslash and an `n` instead of breaking the line. Thirteen
  // English strings shipped that way and Korean copied six. Every other check stayed green:
  // the keys, the placeholders and the plural categories were all still exactly right.
  const BS = String.fromCharCode(92);
  const r = run(fixture("ko", { about: "정보" + BS + "n다음" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /undecoded escape/);
});

test("a real line break in a translation is fine", () => {
  const r = run(fixture("ko", { about: "정보\n다음" }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a plural base the language has not started at all is NOT a failure", () => {
  // Incompleteness renders English through tr()'s fallback. Failing it would make adding a
  // counted string to English instantly break every language that has not caught up.
  const r = run(fixture("ru", { about: "О программе" }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
