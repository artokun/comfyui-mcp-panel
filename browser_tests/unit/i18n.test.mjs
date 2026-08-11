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
  // Script beats region: Hong Kong and Macau write Traditional, so they get zh-TW even
  // though plain `zh` is shipped and would win a naive base match.
  assert.equal(resolveLocale("zh-HK"), "zh-TW");
  assert.equal(resolveLocale("zh-MO"), "zh-TW");
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

/**
 * Read a panel source with line endings NORMALISED. The working tree is CRLF here
 * (core.autocrlf=true on Windows), so a `\n}\n` boundary silently never matches and every
 * "is it inside this function?" check quietly widens to the rest of the file — a guard that
 * still passes, while no longer testing what it names.
 */
const readSource = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

/**
 * Slice `function <name>() { ... }` out of a source file, bounded by the closing brace in
 * column 0. Text-level, because the panel module registers itself on import and cannot be
 * loaded in node — the same reason the startup test above reads source.
 */
function functionBody(src, name) {
  const at = src.indexOf(`\nfunction ${name}() {`);
  assert.notEqual(at, -1, `${name}() must still exist`);
  const rest = src.slice(at + 1);
  const end = rest.indexOf("\n}\n");
  assert.notEqual(end, -1, `${name}() must end with a column-0 brace for this scan to be bounded`);
  const body = rest.slice(0, end);
  // A scan that silently captured the whole file would pass every "no eager X" check below
  // for the wrong reason, and fail on unrelated code elsewhere.
  assert.ok(body.length < src.length / 2, `${name}() scan is unbounded — it captured ${body.length} of ${src.length} chars`);
  return body;
}

test("the Settings dialog's own labels are read LAZILY, not when the block is built", () => {
  // WHY THIS IS NOT THE SAME AS THE MODULE-SCOPE GUARD BELOW: panelSettingsList() is a
  // FUNCTION, so the usual rule ("inside a function, a plain tr() is fine — it runs after
  // the catalog loads") reads as satisfied. It is not. This particular function is called
  // while `app.registerExtension({ settings: panelSettingsList() })` is being constructed —
  // synchronously, before that same extension's `async setup()` gets to await
  // loadCatalog(). Anything translated eagerly in here is English for the life of the tab,
  // and it looks completely correct to an English-reading reviewer.
  //
  // ComfyUI re-reads `setting.category` and `setting.options` when the dialog RENDERS
  // (SettingGroup.vue, SettingItem.vue's `formItem` computed), so getters are both
  // necessary and sufficient.
  const src = readSource("web/js/comfyui-mcp-panel.js");
  const body = functionBody(src, "panelSettingsList");

  const eagerCategories = body.split("\n").filter((l) => /^\s*category:\s/.test(l));
  assert.deepEqual(
    eagerCategories,
    [],
    "every settings row must use `get category() { return cat(...) }` — a plain `category:` freezes English",
  );

  const eagerOptions = body.split("\n").filter((l) => /^\s*options:\s/.test(l));
  assert.deepEqual(
    eagerOptions,
    [],
    "every combo must use `get options() { return [...] }` — a plain `options:` freezes English",
  );

  // And the getters must actually be there: a block that simply stopped declaring
  // categories/options would pass both checks above by having nothing to find.
  assert.ok(
    (body.match(/get category\(\) \{/g) || []).length >= 20,
    "the settings rows should still declare their categories, via getters",
  );
  assert.ok(
    (body.match(/get options\(\) \{/g) || []).length >= 4,
    "the combo rows should still declare their options, via getters",
  );

  // No combo option may still carry a bare literal label. The getters above make a row
  // CAPABLE of translating; this is what says every row in it actually does — including the
  // one-off "Detect (follow ComfyUI)", which no per-setting test would otherwise cover.
  const bareOptionLabels = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\{ value: .*, text: "/.test(l));
  assert.deepEqual(bareOptionLabels, [], "combo option labels must go through tr()");

  // The sub-category label must be read INSIDE the getter. `cat(BACKEND_SECTION.ollama, …)`
  // written outside one would fire that getter at construction time and re-freeze English —
  // the failure the getters exist to prevent, reintroduced one level up.
  for (const line of body.split("\n")) {
    if (!/BACKEND_SECTION\./.test(line)) continue;
    assert.match(line, /get category\(\) \{/, `BACKEND_SECTION read outside a getter: ${line.trim()}`);
  }
});

test("translating a combo changes only its TEXT, never the value that gets stored", () => {
  // The one way this whole unit could corrupt data: ComfyUI persists `option.value` and
  // shows `option.text`, so a translation that reached `value` would write "Ollama (로컬)"
  // into comfy.settings.json as the backend id. Locked here as an exact list, because the
  // damage is invisible until a Korean user's panel refuses to connect.
  const src = readSource("web/js/comfyui-mcp-panel.js");
  const body = functionBody(src, "panelSettingsList");
  const at = body.indexOf("id: SETTING_BACKEND");
  assert.notEqual(at, -1, "the default-backend setting must still exist");
  const block = body.slice(at, body.indexOf("defaultValue:", at));
  const values = [...block.matchAll(/\{ value: "([^"]*)", text:/g)].map((m) => m[1]);
  assert.deepEqual(values, [
    "claude", "codex", "gemini", "antigravity", "pi", "grok", "kimi", "moonshot",
    "glm", "minimax", "ollama", "openrouter", "lmstudio", "llamacpp", "custom",
  ]);
  // Every one of those labels must go through tr() — a bare string here is a row that
  // stays English in all 12 languages while its neighbours translate.
  assert.equal((block.match(/text: tr\(/g) || []).length, values.length);
});

test("EVERY backend section label is a getter — not most of them", () => {
  // BACKEND_SECTION deliberately does NOT go in MODULE_SCOPE_CONFIGS below: that guard
  // looks for `label:`/`title:`-shaped fields and asserts the block contains *a* getter, so
  // with 15 keys it stays green while 14 of them silently revert to eager strings. Measured
  // per key instead — the failure this is protecting against is one provider going English,
  // not the whole table.
  const src = readSource("web/js/comfyui-mcp-panel.js");
  const at = src.indexOf("\nconst BACKEND_SECTION = {");
  assert.notEqual(at, -1, "BACKEND_SECTION must still be declared at module scope");
  const block = src.slice(at + 1, src.indexOf("\n};", at) + 3);

  const getters = [...block.matchAll(/^\s*get (\w+)\(\) \{ return tr\(/gm)].map((m) => m[1]);
  assert.deepEqual(getters, [
    "claude", "codex", "gemini", "antigravity", "pi", "grok", "kimi", "moonshot",
    "glm", "minimax", "ollama", "openrouter", "lmstudio", "llamacpp", "custom",
  ], "every backend must resolve its section label lazily, through tr()");

  // Nothing may sneak back in as a plain property: `claude: "Claude"` or `claude: tr(...)`
  // both evaluate at import time, when the catalog is still empty.
  const eager = block.split("\n").filter((l) => /^\s*\w+:\s/.test(l));
  assert.deepEqual(eager, [], "a plain property here is read at import time and freezes English");
});

test("a settings row's section label is still deferred one level down", () => {
  // The composition the guard above enforces, proven to behave. `cat()` takes the sub-label
  // as an ARGUMENT, so the whole point is that the argument is evaluated inside the getter
  // and not when the row object is built.
  const BACKEND_SECTION = {
    get ollama() { return tr("panel.ollama_local", "Ollama (local)"); },
  };
  const cat = (sub, name) => [tr("panel.comfy_mcp_agent", "Comfy MCP Agent"), sub, name];

  __setCatalogForTest("ko", {});
  const row = {
    id: "comfyui-mcp.ollama.api",
    get category() { return cat(BACKEND_SECTION.ollama, "Endpoint type"); },
    get options() { return [{ value: "ollama", text: tr("panel.ollama_local", "Ollama (local)") }]; },
  };
  // Built before the catalog exists — exactly when registerExtension() builds the real one.
  assert.deepEqual(row.category, ["Comfy MCP Agent", "Ollama (local)", "Endpoint type"]);

  __setCatalogForTest("ko", {
    panel: { comfy_mcp_agent: "Comfy MCP 에이전트", ollama_local: "Ollama (로컬)" },
  });
  assert.deepEqual(row.category, ["Comfy MCP 에이전트", "Ollama (로컬)", "Endpoint type"]);
  assert.equal(row.options[0].text, "Ollama (로컬)");
  assert.equal(row.options[0].value, "ollama", "the stored value never moves");
});

test("module-scope config reads translations LAZILY, not at import time", () => {
  // The defect this guards: `const TABS = [{ label: tr("x", "Tabs") }]` at module scope runs
  // at IMPORT time — before setup() awaits loadCatalog() — so it captures the English
  // fallback permanently. The key can be perfectly translated in every catalog and the tab
  // will still read "Tabs" forever. Nothing else in the suite notices: the English rendering
  // is exactly what an English-reading reviewer expects to see.
  // Checked against an ENUMERATED list of the module-scope config declarations, not a
  // keyword pattern. A pattern like /\{.*label: tr\(/ also matches objects built INSIDE
  // functions — `buildPanel()`, `makeShellCommandBlock()` — where a plain `tr()` is entirely
  // correct because the function runs long after the catalog loads. Blocking those would be
  // wrong in the direction nobody checks: the guard looks green either way, and the fix it
  // demands makes correct code worse.
  const MODULE_SCOPE_CONFIGS = [
    ["web/js/cmcp-sidepanel-ui.js", "TABS"],
    ["web/js/cmcp-civitai-ui.js", "TABS"],
    ["web/js/cmcp-training-ui.js", "FLOWS"],
    ["web/js/cmcp-training-ui.js", "PRESETS"],
    ["web/js/comfyui-mcp-panel.js", "CMCP_OAUTH_PROVIDERS"],
    ["web/js/comfyui-mcp-panel.js", "EFFORT_META"],
  ];
  for (const [f, name] of MODULE_SCOPE_CONFIGS) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const start = src.indexOf(`\nconst ${name} = `);
    assert.notEqual(start, -1, `${f} must still declare ${name} at module scope`);
    // Bound the block at the next column-0 statement.
    const rest = src.slice(start + 1);
    const endRel = rest.search(/\n(?:const|let|var|function|export|\/\*\*|\/\/ ─)/);
    const block = endRel === -1 ? rest : rest.slice(0, endRel);
    const bare = block.split("\n").filter((l) => /\b(?:label|title|note|hint)\s*:\s*tr\(/.test(l));
    assert.deepEqual(
      bare,
      [],
      `${name} in ${f} evaluates tr() at import time. Use \`get <field>() { return tr(...) }\``,
    );
    // And it must actually be using the getter form — otherwise a block that simply stopped
    // translating would pass the check above by having no tr() at all.
    assert.match(block, /get \w+\(\) \{ return tr\(/, `${name} in ${f} should read translations via getters`);
  }
});

test("a getter-backed label re-reads the catalog after it loads", () => {
  // The behavioural half: proves the pattern the test above enforces actually fixes it.
  const cfg = { get label() { return tr("panel.cancel", "Cancel"); } };
  __setCatalogForTest("ko", {});
  assert.equal(cfg.label, "Cancel", "before the catalog loads, English");
  __setCatalogForTest("ko", { panel: { cancel: "취소" } });
  assert.equal(cfg.label, "취소", "after it loads, the same object yields Korean");
});

test("plurals pick the category the language actually uses", () => {
  // English: two forms.
  __setCatalogForTest("en", {});
  const enForms = { one: "{count} node", other: "{count} nodes" };
  assert.equal(tr("panel.n", enForms, { count: 1 }), "1 node");
  assert.equal(tr("panel.n", enForms, { count: 5 }), "5 nodes");

  // Korean: ONE form for every number. An English-shaped one/other would be wrong.
  __setCatalogForTest("ko", { panel: { n_other: "노드 {count}개" } });
  assert.equal(tr("panel.n", enForms, { count: 1 }), "노드 1개");
  assert.equal(tr("panel.n", enForms, { count: 5 }), "노드 5개");

  // Russian: 1 / 2 / 5 take three DIFFERENT forms — the case hand-rolled n===1 always breaks.
  __setCatalogForTest("ru", { panel: { n_one: "{count} узел", n_few: "{count} узла", n_many: "{count} узлов" } });
  assert.equal(tr("panel.n", enForms, { count: 1 }), "1 узел");
  assert.equal(tr("panel.n", enForms, { count: 3 }), "3 узла");
  assert.equal(tr("panel.n", enForms, { count: 5 }), "5 узлов");

  // A catalog with only `_other` still resolves for a language that wants `_one`.
  __setCatalogForTest("en", { panel: { n_other: "{count} nodes" } });
  assert.equal(tr("panel.n", enForms, { count: 1 }), "1 nodes");
});

test("right-to-left languages are flagged", () => {
  assert.ok(isRTL("ar"));
  assert.ok(isRTL("fa"));
  assert.ok(!isRTL("ko"));
  assert.ok(!isRTL("en"));
});
