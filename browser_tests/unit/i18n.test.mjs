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
import { readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
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

test("a substituted VALUE is never re-scanned for placeholders", () => {
  // The model picker renders `No model matches “{query}” across {count} connected
  // providers`, where {query} is whatever the user typed. A per-variable substitution loop
  // replaced {query} first and then re-scanned the result, so typing the literal text
  // "{count}" into the search box had the user's own query overwritten by the provider
  // count. Values are inserted, never re-interpreted — and this must hold whichever order
  // the vars object happens to enumerate in.
  __setCatalogForTest("en", {});
  assert.equal(
    tr("panel.absent", "No model matches “{query}” across {count} connected providers.", {
      query: "{count}",
      count: 3,
    }),
    "No model matches “{count}” across 3 connected providers.",
  );
  // Reversed declaration order must give the same answer.
  assert.equal(
    tr("panel.absent", "No model matches “{query}” across {count} connected providers.", {
      count: 3,
      query: "{count}",
    }),
    "No model matches “{count}” across 3 connected providers.",
  );
  // A hole with no matching var is still left verbatim, as it always was.
  assert.equal(tr("panel.absent", "Hello {name}, you are {rank}", { name: "Sean" }), "Hello Sean, you are {rank}");
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
  // Plural siblings are excluded, and have to be: the categories a counted string takes are a
  // property of the LANGUAGE, not of the catalog. English declares `_one`/`_other`; Korean,
  // Japanese and Chinese use only `_other`, and Russian needs `_few`/`_many` that English will
  // never have. Comparing them here made a correct Korean file fail as "missing keys", and the
  // only way to pass would have been to add a `_one` form Korean grammar does not have. The
  // per-language categories ARE checked — by scripts/i18n-check.mjs, against Intl.PluralRules,
  // which is the only thing that knows the CLDR answer.
  const isPluralForm = (key) => /_(?:zero|one|two|few|many|other)$/.test(key);
  const flat = (o, p = "", out = new Set()) => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === "object") flat(v, key, out);
      else if (!isPluralForm(key)) out.add(key);
    }
    return out;
  };
  // Plural siblings are excluded from EXACT parity and checked by category instead — the two
  // rules were mutually unsatisfiable otherwise. This test demanded zh carry `x_one` because
  // English has it; `scripts/i18n-check.mjs` rejects `x_one` because Chinese has no `one`
  // category. No zh file could satisfy both, so the only way to green was to make Chinese
  // grammatically wrong. Parity is the right rule for ordinary keys and the wrong one for
  // plurals, where the correct key SET differs per language by design.
  const PLURAL = /_(?:zero|one|two|few|many|other)$/;
  const expected = new Set([...flat(en)].filter((k) => !PLURAL.test(k)));
  for (const { code } of LOCALES) {
    if (code === "en") continue;
    let target;
    try {
      target = readJson(`locales/${code}/main.json`);
    } catch {
      continue; // not started yet — falls back to English wholesale, which is fine
    }
    const got = new Set([...flat(target)].filter((k) => !PLURAL.test(k)));
    // MISSING is allowed and EXTRA is not — the same asymmetry scripts/i18n-check.mjs
    // enforces. A key a language has not reached renders English through tr()'s fallback,
    // so demanding completeness here would make every merge red until all twelve languages
    // finish, and would make adding a language impossible incrementally. A key English does
    // NOT have is different: it is dead weight at best and a stale rename at worst, and
    // nothing else would ever surface it.
    const extra = [...got].filter((k) => !expected.has(k));
    assert.deepEqual(extra, [], `${code} has keys English does not`);
  }
});

test("no fallback is concatenated with a variable instead of using a {placeholder}", () => {
  // `tr("k", "Hello " + name)` puts only "Hello " in the catalog. English looks perfect — it
  // evaluates the whole expression at runtime — while every translated language loses the
  // value entirely, and no RTL language can move it to where its grammar needs it. Adjacent
  // string literals are now joined automatically; a VARIABLE has to become a {placeholder},
  // which only a human can name.
  const out = execFileSync("node", ["scripts/i18n-extract.mjs", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const bad = JSON.parse(out).filter((c) => c.varConcat);
  assert.deepEqual(
    bad.map((c) => `${c.file}:${c.line} tr("${c.key}", "…" + <var>)`),
    [],
    'use tr("key", "… {name} …", { name }) so translators can move the value',
  );
});

test("every panel source parses AS AN ES MODULE, not just as a script", () => {
  // This is the check that was missing, and its absence shipped a P0: the i18n import was
  // spliced INSIDE a multi-line import's specifier list, making the whole panel a
  // SyntaxError — nothing constructed, in every language including English.
  //
  // `node --check foo.js` reports OK on that file, because a bare .js is parsed as CommonJS
  // where `import` is merely an identifier. The panel is served as type="module". So the
  // check has to run against a .mjs copy, or it is not checking what the browser does.
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== "vendor") walk(`${dir}/${e.name}`);
      } else if (e.name.endsWith(".js")) files.push(`${dir}/${e.name}`);
    }
  };
  walk("web/js");
  assert.ok(files.length > 5, "expected to find the panel sources");

  const tmp = join(tmpdir(), `cmcp-modcheck-${process.pid}.mjs`);
  const broken = [];
  for (const f of files) {
    writeFileSync(tmp, readFileSync(join(ROOT, f), "utf8"));
    try {
      execFileSync("node", ["--check", tmp], { stdio: "pipe" });
    } catch (e) {
      broken.push(`${f}: ${String(e.stderr || e).split("\n").find((l) => l.includes("Error")) || "parse failed"}`);
    }
  }
  rmSync(tmp, { force: true });
  assert.deepEqual(broken, [], "these do not parse as ES modules — the browser will not load them");
});

test("no tr() call site is invisible to the extractor", () => {
  // The blind spot unit 6 found: a plural fallback's first `}` is the one inside `{count}`,
  // so the object body was truncated and every plural site silently vanished. The round-trip
  // guard could not see it — a site the parser chokes on is absent from BOTH sides of that
  // comparison, so it stayed green while reporting on nothing. Only counting what was SKIPPED
  // notices. Any future parser gap fails here rather than quietly shrinking the catalog.
  const out = execFileSync("node", ["scripts/i18n-extract.mjs", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const parsed = JSON.parse(out).filter((c) => c.converted);
  const byFile = new Map();
  for (const c of parsed) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }
  const unparsed = [];
  for (const [file, items] of byFile) {
    const src = readFileSync(join(ROOT, file), "utf8");
    const lines = new Set(items.map((c) => c.line));
    const call = /\btr\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*,/g;
    let m;
    while ((m = call.exec(src)) !== null) {
      const line = src.slice(0, m.index).split("\n").length;
      if (!lines.has(line)) unparsed.push(`${file}:${line} tr("${m[2]}", …)`);
    }
  }
  assert.deepEqual(unparsed, [], "the extractor could not read these call sites — their keys would vanish from English");
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
  // The window covers everything setup() does BEFORE the catalog load. It grew
  // 900 → 1200 with #1269, whose duplicate-copy gate is itself mandated-first
  // (a copy that lost the page arbitration must stop before anything wraps or
  // connects); the pin's purpose — awaited, and before the first paint — is
  // unchanged.
  const head = src.slice(setupAt, setupAt + 1200);
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
  // `chatgpt` sits next to `codex` (#1084): they are two routes to the same ChatGPT
  // subscription — a `codex app-server` subprocess and the direct Codex Responses OAuth
  // API — and the panel named only the first, so the picker showed "ChatGPT" beside a raw
  // "chatgpt". Both are ids on the wire and neither may ever be translated, which is what
  // this list is here to hold.
  assert.deepEqual(values, [
    "claude", "codex", "chatgpt", "gemini", "antigravity", "pi", "grok", "qwen", "kimi", "moonshot",
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
    "claude", "codex", "gemini", "antigravity", "pi", "grok", "qwen", "kimi", "moonshot",
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
    // `desc` added after unit 7 found FLOWS' desc: fields eagerly evaluated while the title:
    // fields beside them were correctly lazy — the guard listed the fields it had seen fail,
    // not the fields that can fail. Add any new display field here when one appears.
    const bare = block.split("\n").filter((l) => /\b(?:label|title|note|hint|desc|text|summary)\s*:\s*tr\(/.test(l));
    assert.deepEqual(
      bare,
      [],
      `${name} in ${f} evaluates tr() at import time. Use \`get <field>() { return tr(...) }\``,
    );
    // And every display field must be a getter — not merely SOME of them.
    //
    // Asserting a single `get x() { return tr(` match was blind: reverting 5 of 6 entries to
    // bare English still left one getter, so the guard passed. The round-trip guard caught
    // that revert only because orphaned catalog keys remained — and in the merge flow English
    // is regenerated in the same step, which removes the orphans and leaves nothing to notice.
    // So this checks the shape that cannot be partially satisfied: NO bare display literal.
    // Per-FIELD consistency, not blanket coverage. A field nobody has converted yet (`desc:`
    // before its unit lands) is untranslated work, not a defect. A field converted in SOME
    // entries and bare in others is the partial-revert bug — and that is the shape a
    // single-match assertion cannot see.
    const FIELDS = ["label", "title", "note", "hint", "desc", "text", "summary"];
    for (const field of FIELDS) {
      const lazy = new RegExp(`get ${field}\\(\\) \\{ return tr\\(`, "g");
      const bare = new RegExp(`\\b${field}\\s*:\\s*["'\`]`, "g");
      const lazyCount = (block.match(lazy) || []).length;
      const bareCount = (block.match(bare) || []).length;
      if (lazyCount > 0 && bareCount > 0) {
        assert.fail(
          `${name} in ${f}: \`${field}\` is a getter in ${lazyCount} entr${lazyCount === 1 ? "y" : "ies"} but a bare ` +
            `literal in ${bareCount} — those ${bareCount} are frozen to English at import. Convert all or none.`,
        );
      }
    }
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

test("regenerating English is a ROUND TRIP — it never loses a converted key", () => {
  // The defect this locks down: the extractor's context patterns anchor on the code PRECEDING
  // a literal, so once a site became `.textContent = tr("panel.save", "Save")` nothing matched
  // it. Extraction fell from 264 candidates to 1, and `npm run i18n:build` would have
  // overwritten a 247-key catalog with 1 key — then the gate would fail every language with
  // ~246 "unknown key" errors. Conversion must be a round trip, not a one-way door.
  const out = execFileSync("node", ["scripts/i18n-extract.mjs", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const converted = JSON.parse(out).filter((c) => c.converted);
  const committed = readJson("locales/en/main.json");
  const flat = (o, p = "", m = new Map()) => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === "object") flat(v, key, m);
      else m.set(key, v);
    }
    return m;
  };
  const inCatalog = flat(committed.comfyuiMcpPanel);
  const missing = converted.filter((c) => !inCatalog.has(c.key));
  assert.deepEqual(
    missing.map((c) => `${c.key} (${c.file}:${c.line})`),
    [],
    "every tr() call site must be readable back into the English catalog — run `npm run i18n:build`",
  );
  // And the reverse: a catalog key with no call site is dead vocabulary.
  const called = new Set(converted.map((c) => c.key));
  assert.deepEqual(
    [...inCatalog.keys()].filter((k) => !called.has(k)),
    [],
    "these catalog keys have no tr() call site — stale after a revert or rename",
  );
});

test("the extractor reads a PLURAL call site back, placeholders and all", () => {
  // The round-trip test above cannot see this defect, and that is the point. The plural
  // reader took `rest.indexOf("}")` as the end of the forms object — but every plural form
  // contains a `{count}` placeholder, so the first `}` is the one closing `{count}` inside
  // the literal. The body arrived cut off mid-string, neither `one` nor `other` matched, and
  // the site produced ZERO candidates. Zero candidates is invisible to a round trip: there is
  // no key for it to demand and no catalog entry for it to orphan, so every plural string in
  // the panel would stay English in every language with the entire suite green.
  const out = execFileSync("node", ["scripts/i18n-extract.mjs", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const plural = JSON.parse(out).filter((c) => c.converted && /_(?:zero|one|two|few|many|other)$/.test(c.key));
  assert.ok(plural.length > 0, "no plural call site was read back — the forms object is not being parsed");
  // Both categories of each base, and the placeholder has to survive: a form that lost its
  // `{count}` renders the number nowhere, which no shape check would notice.
  const bases = new Set(plural.map((c) => c.key.replace(/_(?:zero|one|two|few|many|other)$/, "")));
  for (const base of bases) {
    const forms = plural.filter((c) => c.key.startsWith(`${base}_`));
    assert.ok(
      forms.some((c) => c.key.endsWith("_one")) && forms.some((c) => c.key.endsWith("_other")),
      `${base}: English declares one/other, so both must be extracted (got ${forms.map((f) => f.key).join(", ")})`,
    );
    // Each form must carry SOME placeholder — but not necessarily `{count}`.
    //
    // `count` is the plural SELECTOR, not necessarily the displayed value, and separating
    // them is correct rather than sloppy: `{ count: downloads, n: compactCount(downloads) }`
    // selects on the raw number while rendering "1.2k", and `{ count: chars, n:
    // chars.toLocaleString(locale) }` renders a locale-grouped number. You cannot pluralise
    // on the string "1.2k". Demanding a literal {count} in the text would force those sites
    // to display a raw integer — a real regression in service of a tidier assertion.
    for (const f of forms) {
      assert.match(f.text, /\{\w+\}/, `${f.key} has no placeholder at all — a counted string must interpolate something`);
    }
  }
});

test("RTL is actually WIRED, not just implemented", () => {
  // `isRTL`/`applyDirection` existed and were exported but never called by anything, while
  // ar and fa shipped in the language dropdown — so an Arabic user got a left-to-right panel
  // and every unit test stayed green. An exported-but-uncalled function is indistinguishable
  // from a working feature until someone speaks the language.
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.match(src, /import \{[^}]*applyDirection[^}]*\} from "\.\/lib\/i18n\.js"/, "applyDirection must be imported");
  const at = src.indexOf('root.className = "cmcp-root"');
  assert.notEqual(at, -1, "the panel root must still be created in buildPanel()");
  assert.match(
    src.slice(at, at + 900),
    /applyDirection\(root\)/,
    "every panel root must get its direction set where it is created, or RTL languages lay out wrongly",
  );
});

test("no DOM property written from tr() is read back as a comparison sentinel", () => {
  // The bug this generalises: `chip.title = tr("panel.running", "Running")` was written in
  // one place and read back as `el.title === "Running"` in two others to reconstruct state.
  // Translating the tooltip made that comparison permanently false, silently losing the flag
  // for every non-English user — and every test stayed green, because the whole suite runs in
  // English. Visible text is for humans; state belongs in a data attribute.
  //
  // Scoped to DOM display properties on purpose. A bare `sort === "Newest"` compares a
  // CivitAI API value that merely shares an English word with a label, and flagging it would
  // be a false positive that pushes someone to "fix" correct code.
  const DISPLAY_PROPS = ["textContent", "innerText", "title", "label", "placeholder", "ariaLabel"];
  const en = new Map();
  const flat = (o, p = "") => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === "object") flat(v, key);
      else en.set(v, key);
    }
  };
  flat(readJson("locales/en/main.json").comfyuiMcpPanel);

  const files = [
    "web/js/comfyui-mcp-panel.js", "web/js/cmcp-apps-ui.js", "web/js/cmcp-civitai-ui.js",
    "web/js/cmcp-training-ui.js", "web/js/cmcp-runpod-ui.js", "web/js/cmcp-sidepanel-ui.js",
    "web/js/cmcp-modal.js", "web/js/cmcp-a2ui.js", "web/js/cmcp-civitai.js",
  ];
  const offenders = [];
  const rx = new RegExp(`\\.(${DISPLAY_PROPS.join("|")})\\s*(?:===|!==|==|!=)\\s*(["'])(.*?)\\2`, "g");
  for (const f of files) {
    let src;
    try {
      src = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    src.split("\n").forEach((line, i) => {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(line)) !== null) {
        if (en.has(m[3])) offenders.push(`${f}:${i + 1} compares .${m[1]} to ${JSON.stringify(m[3])} (key ${en.get(m[3])})`);
      }
    });
  }
  assert.deepEqual(offenders, [], "put the state in a data attribute and compare that instead");
});

test("a variable's VALUE is never re-scanned for placeholders", () => {
  // Substituting one variable at a time expands `{name}` holes that appear inside a value
  // already written by an earlier variable. ComfyUI widget values carry braces routinely
  // (dynamic-prompt syntax), so a group genuinely titled "{id}" rendered as
  // `Created group "7" (id 7)` — the user's own title silently replaced by other data.
  __setCatalogForTest("en", {});
  const out = tr("panel.x", 'Created group "{title}" (id {id})', { title: "{id}", id: 7 });
  assert.equal(out, 'Created group "{id}" (id 7)');

  // An unknown placeholder is left alone rather than blanked — a missing var should look
  // obviously wrong in review, not silently erase part of the sentence.
  assert.equal(tr("panel.y", "a {nope} b", { other: 1 }), "a {nope} b");
});

test("right-to-left languages are flagged", () => {
  assert.ok(isRTL("ar"));
  assert.ok(isRTL("fa"));
  assert.ok(!isRTL("ko"));
  assert.ok(!isRTL("en"));
});

test("every connection status token has a translated label", () => {
  // The status pill renders a state TOKEN (`emitStatus("connected")`), not a literal at the
  // display site — so no literal scan can see it, and `connected` reached the screen in
  // English while coverage read 100%. STATUS_LABEL fixes that, but only for the tokens it
  // lists: add a fourth status and it silently renders the raw token again.
  //
  // So pin both sides. Keys must be LITERAL (a key built as `panel.status_${state}` is
  // invisible to the extractor, which is why the catalog validator rejected the first
  // attempt), and every token emitStatus can emit must appear in the map.
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");

  const emitted = [...src.matchAll(/emitStatus\("([a-z]+)"\)/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 3, "expected emitStatus call sites");

  const mapAt = src.indexOf("const STATUS_LABEL = {");
  assert.notEqual(mapAt, -1, "STATUS_LABEL must exist — the status pill translates through it");
  const map = src.slice(mapAt, src.indexOf("};", mapAt));
  const covered = [...map.matchAll(/(\w+):\s*\(\)\s*=>\s*tr\("([^"]+)"/g)].map((m) => ({ token: m[1], key: m[2] }));

  const missing = [...new Set(emitted)].filter((t) => !covered.some((c) => c.token === t));
  assert.deepEqual(missing, [], "these status tokens render untranslated — add them to STATUS_LABEL");

  // And the render site must go through the map, not rebuild a key at runtime.
  //
  // Scoped to the onStatus handler, not the whole file, for two reasons: a whole-file
  // doesNotMatch dumps 1.6MB into the failure output, and a COMMENT explaining the rejected
  // shape would trip it — which is exactly what happened on the first run.
  const onStatusAt = src.indexOf("onStatus(state, socketId)");
  assert.notEqual(onStatusAt, -1, "onStatus handler must exist");
  const handler = src.slice(onStatusAt, onStatusAt + 1400).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(handler, /tr\(\s*`/, "status keys must be literal, not assembled at runtime");
  assert.match(handler, /STATUS_LABEL\[state\]/, "the status pill must render through STATUS_LABEL");
});
