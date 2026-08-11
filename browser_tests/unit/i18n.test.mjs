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
  const flat = (o, p = "", out = new Set()) => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === "object") flat(v, key, out);
      else out.add(key);
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
    const missing = [...expected].filter((k) => !got.has(k));
    const extra = [...got].filter((k) => !expected.has(k));
    assert.deepEqual(missing, [], `${code} is missing keys`);
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
