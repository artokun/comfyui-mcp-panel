/**
 * The panel's translation runtime.
 *
 * The behaviour worth guarding is not "does it translate" — it is what happens when it
 * CANNOT. Every failure here has to degrade to readable English, because the alternative
 * is a user staring at `panel.read_the_docs` or a blank control, in a language nobody
 * chose, with no way to tell whether the panel is broken or just untranslated.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { tr, pickLocale, resolveLocale, LOCALES, isRTL, loadCatalog, __setCatalogForTest } from "../../web/js/lib/i18n.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

test("a missing key renders the English fallback, never the key", () => {
  __setCatalogForTest("ko", {});
  assert.equal(tr("panel.cancel", "Cancel"), "Cancel");
  // The specific regression: a raw dotted key leaking into the UI.
  assert.doesNotMatch(tr("panel.nope", "Save"), /panel\./);
});

test("a present key wins over the fallback", () => {
  __setCatalogForTest("ko", { panel: { cancel: "취소" } });
  assert.equal(tr("panel.cancel", "Cancel"), "취소");
});

test("placeholders interpolate in both the translation and the fallback", () => {
  __setCatalogForTest("ko", { panel: { greet: "{name}님 환영합니다" } });
  assert.equal(tr("panel.greet", "Welcome {name}", { name: "Sean" }), "Sean님 환영합니다");
  assert.equal(tr("panel.absent", "Welcome {name}", { name: "Sean" }), "Welcome Sean");
});

test("Detect defers to ComfyUI, an explicit choice overrides it", () => {
  // "" (Detect) -> ComfyUI's language.
  assert.equal(pickLocale({ ourSetting: "", comfyLocale: "ja", navigatorLangs: ["fr"] }), "ja");
  // Explicit choice beats ComfyUI — a user who picked Korean meant Korean.
  assert.equal(pickLocale({ ourSetting: "ko", comfyLocale: "ja", navigatorLangs: ["fr"] }), "ko");
  // Nothing set anywhere -> browser, then English.
  assert.equal(pickLocale({ navigatorLangs: ["fr-CA"] }), "fr");
  assert.equal(pickLocale({}), "en");
  // An unshipped language is not honoured just because someone asked for it.
  assert.equal(pickLocale({ ourSetting: "kl", comfyLocale: "xx", navigatorLangs: ["zz"] }), "en");
});

test("region tags degrade to the base language, except where we ship the region", () => {
  assert.equal(resolveLocale("ko-KR"), "ko");
  assert.equal(resolveLocale("pt-PT"), "pt-BR"); // only Portuguese we ship
  // Regional variants we DO ship must not be flattened.
  assert.equal(resolveLocale("zh-TW"), "zh-TW");
  assert.equal(resolveLocale("zh-CN"), "zh");
  assert.equal(resolveLocale("KO"), "ko");
  assert.equal(resolveLocale(""), null);
  assert.equal(resolveLocale(null), null);
});

test("English short-circuits: no catalog fetch, and no api object required", async () => {
  // Regression guard: an `en` user must not pay a round trip to be told what the
  // fallbacks in the source already say — and must not depend on the api existing.
  const res = await loadCatalog("en", null);
  assert.equal(res.skipped, "en-is-inline");
  assert.equal(res.keys, 0);
});

test("a broken /i18n response leaves the panel in English instead of throwing", async () => {
  const throwing = { fetchApi: () => Promise.reject(new Error("network down")) };
  assert.equal((await loadCatalog("ko", throwing)).keys, 0);

  const notOk = { fetchApi: () => Promise.resolve({ ok: false, status: 404 }) };
  assert.equal((await loadCatalog("ko", notOk)).error, "http-404");

  const garbage = { fetchApi: () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error("bad json")) }) };
  assert.equal((await loadCatalog("ko", garbage)).keys, 0);

  // And after every one of those, translation still works in English.
  assert.equal(tr("panel.cancel", "Cancel"), "Cancel");
});

test("a non-2xx body is never parsed as a catalog", async () => {
  // A 500 page that happens to be JSON must not become the UI's vocabulary.
  let parsed = false;
  const evil = {
    fetchApi: () => Promise.resolve({ ok: false, status: 500, json: () => { parsed = true; return Promise.resolve({ ko: { comfyuiMcpPanel: { panel: { cancel: "WRONG" } } } }); } }),
  };
  await loadCatalog("ko", evil);
  assert.equal(parsed, false, "the body of a failed response must not be read");
  assert.equal(tr("panel.cancel", "Cancel"), "Cancel");
});

test("every shipped locale file matches the English key set exactly", () => {
  const en = readJson("locales/en/main.json");
  const flat = (o, p = "", out = new Set()) => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === "object") flat(v, key, out);
      else out.add(key);
    }
    return out;
  };
  const expected = flat(en);
  for (const { code } of LOCALES) {
    if (code === "en") continue;
    let target;
    try {
      target = readJson(`locales/${code}/main.json`);
    } catch {
      continue; // not started yet — falls back to English wholesale, which is fine
    }
    const got = flat(target);
    const missing = [...expected].filter((k) => !got.has(k));
    const extra = [...got].filter((k) => !expected.has(k));
    assert.deepEqual(missing, [], `${code} is missing keys`);
    assert.deepEqual(extra, [], `${code} has keys English does not`);
  }
});

test("our language table matches the codes ComfyUI itself ships", () => {
  // Parity is the point: if ComfyUI offers a language and we silently do not, "Detect"
  // hands that user an English panel inside a translated app with no explanation.
  const comfy = ["en", "zh", "zh-TW", "ru", "ja", "ko", "fr", "es", "pt-BR", "tr", "ar", "fa"];
  assert.deepEqual([...LOCALES.map((l) => l.code)].sort(), [...comfy].sort());
});

test("the catalog is loaded at startup, before the panel paints", () => {
  // A SOURCE assertion, because this is a one-line install with no observable return value:
  // delete the await and every other test in this repo stays green while the panel ships
  // permanently untranslated. Nothing else in the suite would notice.
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  const setupAt = src.indexOf("async setup() {");
  assert.notEqual(setupAt, -1, "registerExtension must still have a setup()");
  const head = src.slice(setupAt, setupAt + 900);
  assert.match(head, /await applyPanelLocale\(\)/, "setup() must await the catalog load");

  // AWAITED, not fired-and-forgotten: an unawaited load resolves after the first render and
  // leaves the panel in English until something happens to re-render it.
  assert.doesNotMatch(head, /void applyPanelLocale\(\)\s*;/, "startup must await, not fire-and-forget");

  // And it must come before the sidebar tab is registered, or the first paint is English.
  const tabAt = src.indexOf("registerSidebarTab", setupAt);
  if (tabAt !== -1) {
    assert.ok(src.indexOf("await applyPanelLocale()", setupAt) < tabAt, "the catalog must load before the tab renders");
  }
});

test("the language setting offers Detect plus every shipped language", () => {
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  const at = src.indexOf("id: SETTING_LANGUAGE");
  assert.notEqual(at, -1, "the panel must register a language setting");
  const row = src.slice(at, at + 1200);
  // Detect must exist and must be the default: following ComfyUI is the whole premise.
  assert.match(row, /value: ""[^}]*Detect/, "there must be a Detect option");
  assert.match(row, /defaultValue: ""/, "Detect must be the default");
  // Built FROM the table rather than a hand-copied list, so adding a language cannot
  // silently miss the dropdown.
  assert.match(row, /LOCALES\.map/, "options must derive from LOCALES, not a duplicate list");
});

test("right-to-left languages are flagged", () => {
  assert.ok(isRTL("ar"));
  assert.ok(isRTL("fa"));
  assert.ok(!isRTL("ko"));
  assert.ok(!isRTL("en"));
});
