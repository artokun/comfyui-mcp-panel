/**
 * The API Keys / OAuth card renders in the user's language — and survives doing so.
 *
 * Two distinct regressions are guarded here, and they pull in opposite directions:
 *
 *   1. A raw English literal creeping back into the card. Every other string in the panel
 *      degrades gracefully when untranslated, but this card is where a user pastes a secret,
 *      so "not set" vs "set" being the one English phrase on a Korean screen is the point at
 *      which someone overwrites a key they already had. The strings are ENUMERATED rather
 *      than pattern-matched: a keyword sweep over an 800-line function reports the card's own
 *      CSS and wire-format literals as prose, and the usual fix for that noise is to loosen
 *      the pattern until it stops seeing the real ones too.
 *
 *   2. The escaping that translation made necessary. Before i18n these were build-time
 *      literals in an `innerHTML` template — safe by construction. They are now catalog
 *      lookups, and `/i18n` merges EVERY installed pack's `main.json` into one object
 *      (web/js/lib/i18n.js, note 1), so the value is not something this repo controls at
 *      build time. Two of the holes sit inside double-quoted attributes (`placeholder`,
 *      `title`), where an unescaped `"` closes the attribute and the rest of the string
 *      becomes markup. `esc2` around each `tr()` is what prevents that, and it is exactly
 *      the sort of call a later cleanup reads as redundant — so it is mutation-checked below
 *      by rendering with a translation that tries the break-out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const SRC = readFileSync(PANEL_JS, "utf8");

/** The credentials card, from its signature to the next top-level function. */
function credentialsFrameBody() {
  const start = SRC.indexOf("function cmcpOpenCredentialsFrame(");
  assert.notEqual(start, -1, "cmcpOpenCredentialsFrame must exist");
  const end = SRC.indexOf("\nfunction ", start + 1);
  assert.notEqual(end, -1, "cmcpOpenCredentialsFrame must be followed by another function");
  return SRC.slice(start, end);
}

/**
 * A template literal assigned at `anchor`, returned with its backticks so it can be
 * re-evaluated. Tracks `${...}` nesting so an interpolation containing a backtick-quoted
 * fragment (the card's `data-help` row is one) does not terminate the scan early.
 *
 * Counting `${` but NOT a bare `{` is a latent trap, and the trigger is narrower than it
 * first looks — measured, not reasoned about. An object literal alone is survivable: the
 * under-counted `}` drops depth to 0 early, but the scan then walks to the true terminator
 * anyway. It breaks only when a nested backtick template FOLLOWS the object literal inside
 * the SAME interpolation, because the scan is at depth 0 by then and takes that opening
 * backtick as the end:
 *
 *     `${cond ? f({ a: 1 }) : `<b>y</b>`}`   ->   truncated to  `${cond ? f({ a: 1 }) : `
 *
 * The card's `data-help` row is already `${s.help ? `<div…>` : ""}`, so it is one object
 * literal away from that shape. A truncated template surfaces as `new Function` throwing on
 * the product's own markup, which reads exactly like the panel being broken. Every `{`
 * therefore increments once an interpolation is open.
 */
function templateAt(body, anchor) {
  const at = body.indexOf(anchor);
  assert.notEqual(at, -1, `${anchor} must exist in the credentials card`);
  const start = body.indexOf("`", at);
  assert.notEqual(start, -1, `${anchor} must be assigned a template literal`);
  let depth = 0;
  let i = start + 1;
  for (; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") { i++; continue; }
    if (c === "$" && body[i + 1] === "{") { depth++; i++; continue; }
    if (c === "{" && depth > 0) { depth++; continue; }
    if (c === "}" && depth > 0) { depth--; continue; }
    if (c === "`" && depth === 0) break;
  }
  assert.ok(i < body.length, `${anchor} template literal must be closed`);
  return body.slice(start, i + 1);
}

/** The card's own escaper, copied so the test does not have to import the whole panel. */
function esc2(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** Render one of the card's templates with a supplied `tr`. */
function render(tpl, trImpl, scope = {}) {
  const fn = new Function("esc2", "tr", ...Object.keys(scope), `return ${tpl};`);
  return fn(esc2, trImpl, ...Object.values(scope));
}

/** The real thing: fallback text with `{placeholders}` filled in, as lib/i18n.js does. */
const trEnglish = (key, fallback, vars) => {
  let out = typeof fallback === "string" ? fallback : "";
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
};

const BODY = credentialsFrameBody();
const CARD_TPL = templateAt(BODY, "card.innerHTML =");
const ROW_TPL = templateAt(BODY, "r.innerHTML =");

/**
 * BODY with whole-line comments dropped, for the occurrence COUNTING below.
 *
 * A comment that quotes a UI string ("resets this to "paste key"") is prose, not a render
 * site, but it is indistinguishable from an untranslated literal to a counter — measured
 * here, when a two-line explanatory comment made "paste key" report 4 occurrences against 2
 * tr() calls. Only lines whose FIRST non-space characters are `//` are removed: a JS string
 * literal cannot span lines, so such a line is provably not inside one, which a general
 * comment-stripping regex could not promise (it would eat the `/^https:\/\//` test below).
 */
const CODE = BODY.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

/**
 * Every human-readable string this card renders, with the key it must resolve through.
 * Enumerated, not inferred — see the header note. A string added to the card and not added
 * here is not caught, which is the trade accepted for never flagging a CSS declaration.
 */
const TRANSLATED = [
  ["panel.connect_the_panel_first_the_credentials_console", "Connect the panel first — the credentials console isn't available yet."],
  ["panel.api_keys", "API Keys"],
  ["panel.stored_locally_on_the_backend_per_instance", "Stored locally on the backend, per instance. Values are write-only and never leave this machine."],
  ["panel.loading", "Loading…"],
  ["panel.set", "set · "],
  ["panel.not_set", "not set"],
  ["panel.set_type_to_replace", "•••• set — type to replace"],
  ["panel.paste_key", "paste key"],
  ["panel.save", "Save"],
  ["panel.remove_this_key_from_the_orchestrator_s", "Remove this key from the orchestrator's store"],
  ["panel.clear", "Clear"],
  ["panel.saving", "Saving…"],
  ["panel.saved", "Saved ✓"],
  ["panel.clearing", "Clearing…"],
  ["panel.save_failed", "save failed"],
  ["panel.clear_failed", "clear failed"],
  ["panel.could_not_load", "could not load"],
  ["panel.no_credential_slots", "No credential slots."],
  ["panel.couldn_t_load_credentials_reconnect_the_panel", "Couldn't load credentials — reconnect the panel. ({error})"],
  ["panel.sign_in", "Sign in"],
  ["panel.sign_out", "Sign out"],
  ["panel.signed_in", "Signed in"],
  ["panel.signed_in_as", "Signed in as {label}"],
  ["panel.sign_in_with", "Sign in with {provider}"],
  ["panel.sign_in_failed", "Sign-in failed."],
  ["panel.sign_out_failed", "Sign-out failed."],
  ["panel.not_connected_reconnect_the_panel_first", "Not connected — reconnect the panel first."],
  ["panel.couldn_t_load_sign_in_status", "Couldn't load sign-in status."],
  ["panel.copy_url", "Copy URL"],
  ["panel.copied", "Copied ✓"],
  ["panel.waiting_for_approval", "Waiting for approval…"],
  ["panel.a_browser_window_opened_finish_sign_in", "A browser window opened — finish sign-in there…"],
  ["panel.experimental", "Experimental"],
  ["panel.signs_in_as_vs_code_against_github", "Signs in as VS Code — against GitHub's Copilot API terms; use at your own risk."],
];

/**
 * The `tr("key", "English"` pairs in the card, PARSED rather than string-matched.
 * Two of these calls are written across several lines (the interpolated ones, which do not
 * fit on one), so a literal `includes()` on the joined form reports them as missing — a
 * harness defect that reads exactly like the regression this file exists to catch.
 */
const TR_CALLS = [...BODY.matchAll(/\btr\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")/g)]
  .map((m) => ({ key: JSON.parse(m[1]), text: JSON.parse(m[2]) }));

test("every string the credentials card renders goes through tr(), with its English kept inline", () => {
  // Sanity: the parse itself must have worked, or every assertion below passes vacuously.
  assert.ok(TR_CALLS.length >= TRANSLATED.length, `parsed only ${TR_CALLS.length} tr() calls`);

  for (const [key, english] of TRANSLATED) {
    const matching = TR_CALLS.filter((c) => c.key === key && c.text === english);
    assert.ok(
      matching.length > 0,
      `${key} must be called as tr("${key}", ${JSON.stringify(english)}, …) — a raw literal here is an English word on a translated screen`,
    );
    // The English must appear ONLY as a tr() fallback. A second, bare occurrence is the
    // regression this catches: a copy of the string re-added somewhere tr() never reaches.
    // (String literals cannot span lines, so counting the JSON form is whitespace-safe.)
    const bare = JSON.stringify(english);
    const occurrences = CODE.split(bare).length - 1;
    assert.equal(
      occurrences,
      matching.length,
      `${bare} appears ${occurrences}× but only ${matching.length}× as a tr() fallback — one copy is untranslated`,
    );
  }
});

test("the English rendering is byte-identical to the pre-translation markup", () => {
  const card = render(CARD_TPL, trEnglish);
  assert.match(card, /<b style="flex:1;font-size:15px">API Keys<\/b>/);
  assert.match(card, />Stored locally on the backend, per instance\. Values are write-only and never leave this machine\.</);
  assert.match(card, /<div data-list style="opacity:\.7">Loading…<\/div>/);

  const set = render(ROW_TPL, trEnglish, { s: { id: "a", label: "OpenAI", set: true, masked: "sk-…9f" } });
  assert.match(set, />set · sk-…9f</);
  assert.match(set, /placeholder="•••• set — type to replace"/);
  assert.match(set, /title="Remove this key from the orchestrator's store"/);
  assert.match(set, />Save<\/button>/);
  assert.match(set, />Clear<\/button>/);

  const unset = render(ROW_TPL, trEnglish, { s: { id: "b", label: "CivitAI", set: false } });
  assert.match(unset, />not set</);
  assert.match(unset, /placeholder="paste key"/);
});

/**
 * Reaching `tr()` is only half of shipping a translation — the key also has to EXIST in the
 * source catalog, or every language renders the English fallback and this file stays green
 * while the dialog it guards is permanently English. That is the "green check is a stale
 * check" shape, and it is worth stating out loud rather than leaving as an absence.
 *
 * Marked `todo` because it currently FAILS and the fix is not available from here:
 *
 *   - `locales/en/main.json` is GENERATED, never hand-edited (scripts/i18n-build-en.mjs), so
 *     adding the keys by hand would be overwritten by the next build.
 *   - That build is itself broken for converted call sites: it reads
 *     scripts/i18n-extract.mjs, whose UI_CONTEXT patterns anchor on the code PRECEDING a
 *     literal (`/\.textContent\s*=\s*$/` and friends), which no longer matches once the site
 *     reads `… = tr("k", "English")`. Measured: `node scripts/i18n-extract.mjs` reports 1
 *     candidate against the 247 keys already in the catalog. Its line 100 also skips any
 *     literal containing `${`, so the four interpolated keys here could never be emitted.
 *
 * A `todo` test reports on every run without failing the build, so the gap is visible
 * instead of silent. When the extractor learns to read `tr("key", "English")` and the
 * catalog is regenerated, this should start passing — drop the `todo` marker then.
 */
test("every key the card uses exists in the English catalog", { todo: "blocked on the i18n-extract regeneration gap — see comment above" }, () => {
  const en = JSON.parse(readFileSync(join(HERE, "../../locales/en/main.json"), "utf8")).comfyuiMcpPanel;
  const has = (key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), en) !== undefined;
  const missing = TRANSLATED.map(([key]) => key).filter((key) => !has(key));
  assert.deepEqual(missing, [], `${missing.length} key(s) render English in every language`);
});

/**
 * Which keys each `innerHTML` template must resolve through, per branch. The counting check
 * above is BLIND here and was measured to be: reverting `${esc2(tr("panel.save", "Save"))}`
 * to a bare `Save` inside the template left every assertion green, because a word sitting in
 * markup has no quotes to count and `tr("panel.save", "Save")` still appears in the row's
 * JS. Rendering with a marker catalog is what makes that visible.
 */
const TEMPLATE_KEYS = {
  card: ["panel.api_keys", "panel.stored_locally_on_the_backend_per_instance", "panel.loading"],
  rowSet: ["panel.set", "panel.set_type_to_replace", "panel.save", "panel.remove_this_key_from_the_orchestrator_s", "panel.clear"],
  rowUnset: ["panel.not_set", "panel.paste_key", "panel.save", "panel.remove_this_key_from_the_orchestrator_s", "panel.clear"],
};

test("the card's markup resolves through the catalog — no English is baked into the template", () => {
  // A `tr` that answers with the key instead of the English. Anything English still in the
  // output is a literal the translator can never reach.
  const trMarker = (key) => `«${key}»`;
  // Scope values chosen to be marker-free so they cannot be mistaken for template text.
  const marked = {
    card: render(CARD_TPL, trMarker),
    rowSet: render(ROW_TPL, trMarker, { s: { id: "a", label: "‹label›", set: true, masked: "‹masked›", help: "‹help›" } }),
    rowUnset: render(ROW_TPL, trMarker, { s: { id: "b", label: "‹label›", set: false } }),
  };

  for (const [which, keys] of Object.entries(TEMPLATE_KEYS)) {
    for (const key of keys) {
      assert.ok(marked[which].includes(`«${key}»`), `${which} must render ${key} through tr()`);
    }
  }
  for (const [which, html] of Object.entries(marked)) {
    for (const [, english] of TRANSLATED) {
      assert.ok(
        !html.includes(english),
        `${which}: ${JSON.stringify(english)} is baked into the template — it renders in English no matter the language`,
      );
    }
  }
});

test("a hostile translation cannot break out of the card's markup", () => {
  // The break-out attempt: a leading `"` closes an attribute, `<script>` opens an element,
  // and `onload=` is what would then be parsed as a handler. If any of these survive RAW,
  // the catalog has become an injection path into a card that shows credential state.
  //
  // `<script>` rather than `<b>` on purpose: the card's own header legitimately contains
  // `<b style="…">`, so a `<b>` probe would only ever pass because of that style attribute,
  // and moving the bold to a CSS class — a routine cleanup — would fail this test on
  // completely correct output. No tag below appears in either template.
  const HOSTILE = 'x" onload="alert(1)" <script>&';
  const trHostile = (key, _fallback, vars) => {
    let out = `${HOSTILE}|${key}`;
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
    return out;
  };

  for (const [what, html] of [
    ["card", render(CARD_TPL, trHostile)],
    ["row(set)", render(ROW_TPL, trHostile, { s: { id: "a", label: "OpenAI", set: true, masked: "sk-…9f" } })],
    ["row(unset)", render(ROW_TPL, trHostile, { s: { id: "b", label: "CivitAI", set: false } })],
  ]) {
    // `onload=&quot;` is the ESCAPED form and is the outcome we want; only a raw quote after
    // it is a break-out. Asserting on the raw form matters — a check for a bare `onload=`
    // passes on nothing and fails on the correct output.
    assert.doesNotMatch(html, /onload="/, `${what}: translation broke out of an attribute`);
    assert.ok(!html.includes(HOSTILE), `${what}: translation reached the DOM unescaped`);
    assert.ok(!html.includes("<script>"), `${what}: translation injected an element`);
  }
});

test("the hooks the card queries by selector survive translation", () => {
  // paintOauthRow and the row wiring find their elements by these attributes. A template
  // edit that lost one would leave the card rendering but inert, which no string assertion
  // above would notice.
  const card = render(CARD_TPL, trEnglish);
  for (const hook of ["data-close", "data-err", "data-list", "data-oauth"]) {
    assert.ok(card.includes(hook), `card must keep [${hook}]`);
  }
  const row = render(ROW_TPL, trEnglish, { s: { id: "a", label: "OpenAI", set: true, masked: "sk-…9f" } });
  for (const hook of ["data-badge", "data-input", "data-save", "data-clear"]) {
    assert.ok(row.includes(hook), `row must keep [${hook}]`);
  }
});

test("the card's error paths translate their OWN text and pass the server's through", () => {
  // `d.error` / `ack.message` is the orchestrator's reason, in English, and is not ours to
  // translate — but the fallback beside it is. Both halves must stay in that shape: a
  // `tr()` wrapped around the whole expression would translate nothing and lose the reason.
  //
  // Matched as a SHAPE, not as an exact source substring. `d.error || tr("panel.save_failed"`
  // as a literal breaks the moment a formatter wraps the line or someone writes `d?.error`,
  // neither of which changes whether the server's reason still wins — a test that fails on
  // reformatting teaches people to delete it.
  for (const [source, key] of [
    ["d.error", "panel.save_failed"],
    ["d.error", "panel.clear_failed"],
    ["d.error", "panel.could_not_load"],
    ["ack.message", "panel.couldn_t_load_sign_in_status"],
    ["ack.message", "panel.sign_in_failed"],
    ["ack.message", "panel.sign_out_failed"],
  ]) {
    const shape = new RegExp(
      `${source.replace(".", "\\??\\.")}\\s*\\|\\|\\s*tr\\(\\s*"${key.replace(/\./g, "\\.")}"`,
    );
    assert.match(CODE, shape, `${key} must keep ${source} ahead of the translated fallback`);
  }
});

test("save and clear both leave the field's placeholder telling the truth", () => {
  // Not an i18n assertion — a symmetry one, found while translating the pair. The clear
  // path has always reset the placeholder to "paste key"; the save path never set it, so a
  // slot that had just been filled kept inviting a paste directly under a badge reading
  // "set · sk-…". Both directions are asserted so neither can drift back to one-sided.
  const slice = (from, to) => {
    const a = BODY.indexOf(from);
    assert.notEqual(a, -1, `${from} must exist`);
    const b = BODY.indexOf(to, a + from.length);
    assert.notEqual(b, -1, `${to} must follow ${from}`);
    return BODY.slice(a, b);
  };
  assert.match(
    slice("btn.onclick = async () => {", "clearBtn.onclick"),
    /input\.placeholder = tr\("panel\.set_type_to_replace"/,
    "a successful save must switch the placeholder to the replace hint",
  );
  assert.match(
    slice("clearBtn.onclick = async () => {", "return r;"),
    /input\.placeholder = tr\("panel\.paste_key"/,
    "a successful clear must switch the placeholder back to the paste hint",
  );
});

test("the secure-token recovery alert is translated too", () => {
  // The other half of the credentials story: `triggerSecret` is what a Settings "Set …
  // token" button drives, and this alert is the ONLY thing a user sees when the panel
  // never mounted. It lives outside cmcpOpenCredentialsFrame, so the checks above cannot
  // see it — and the provider name is interpolated, which is why it needs a placeholder
  // rather than a template literal.
  const at = SRC.indexOf("function triggerSecret(");
  assert.notEqual(at, -1, "triggerSecret must exist");
  const body = SRC.slice(at, SRC.indexOf("\nfunction ", at + 1));
  const call = [...body.matchAll(/\btr\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")/g)]
    .map((m) => ({ key: JSON.parse(m[1]), text: JSON.parse(m[2]) }))
    .find((c) => c.key === "panel.open_the_agent_panel_connect_then_set");
  assert.ok(call, "the recovery alert must go through tr()");
  assert.equal(call.text, "Open the Agent panel, connect, then set the {name} token again.");
  // `${friendly}` back in the string would render the provider name but drop the
  // translation's freedom to move it — several languages cannot keep it in this position.
  assert.doesNotMatch(body, /\$\{friendly\}/, "the provider name must interpolate through tr()'s vars");
});
