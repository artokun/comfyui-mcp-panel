/**
 * Panel translations — piggybacked onto ComfyUI's own i18n plumbing.
 *
 * WHAT COMFYUI GIVES US FREE (verified against frontend 1.48.7 / ComfyUI 0.31.1):
 *
 *   - A `locales/<lang>/{main,settings,commands}.json` tree at the PACKAGE ROOT is
 *     discovered by ComfyUI's backend (`app/custom_node_manager.py::build_translations`)
 *     and served — merged across every installed custom node — from `GET /i18n`.
 *     We add no route and no build step; we drop files in a folder ComfyUI already reads.
 *
 *   - `settings.json` needs NO code at all. ComfyUI renders our `settings: [...]` block in
 *     its own dialog and looks up `settings.<id>.name` / `.tooltip` in that merged catalog.
 *     The id transform is dots-to-underscores, hyphens PRESERVED — confirmed against
 *     ComfyUI's own shipped keys (`Comfy-Desktop.AutoUpdate` -> `Comfy-Desktop_AutoUpdate`),
 *     so ours is `comfyui-mcp.defaultBackend` -> `comfyui-mcp_defaultBackend`.
 *
 * WHAT IT DOES NOT GIVE US — and why this file exists:
 *
 *   The translator itself. ComfyUI's build shims only `src/scripts` and `src/extensions/core`
 *   onto `window.comfyAPI` (70 namespaces in 1.48.7, none of them i18n), so vue-i18n's `t()`
 *   is genuinely unreachable from extension JS. The upstream docs leave this "[To be updated]".
 *   So we read the SAME catalog off the SAME route and do our own lookup. Everything else —
 *   file layout, language codes, fallback-to-English, the user's language choice — is theirs.
 *
 * TWO THINGS THAT WILL BITE WHOEVER EDITS THIS NEXT:
 *
 *   1. `/i18n` merges EVERY pack's `main.json` into one object per language
 *      (`merge_json_recursive`). A bare top-level key like `"Cancel"` would collide with
 *      another pack's — last writer wins, silently, and which one wins depends on folder
 *      sort order. Every key we own therefore lives under `NS` below. Do not flatten it.
 *
 *   2. `build_translations` is `@lru_cache(maxsize=1)`. Editing a locale file does nothing
 *      until ComfyUI restarts. That is upstream's cache, not ours, and it makes "my
 *      translation didn't apply" a restart question before it is a bug.
 */

/** Our namespace inside the shared `/i18n` catalog. See note 1 above. */
const NS = "comfyuiMcpPanel";

/**
 * The languages we offer. Deliberately the same set and the same codes ComfyUI ships,
 * so "the panel is in Korean" and "ComfyUI is in Korean" can never mean two different
 * things. `text` is each language in its OWN language — matching ComfyUI's dropdown,
 * where a user who cannot read the current UI language can still find their own.
 */
export const LOCALES = [
  { code: "en", text: "English" },
  { code: "zh", text: "中文" },
  { code: "zh-TW", text: "繁體中文" },
  { code: "ru", text: "Русский" },
  { code: "ja", text: "日本語" },
  { code: "ko", text: "한국어" },
  { code: "fr", text: "Français" },
  { code: "es", text: "Español" },
  { code: "pt-BR", text: "Português (BR)" },
  { code: "tr", text: "Türkçe" },
  { code: "ar", text: "العربية" },
  { code: "fa", text: "فارسی" },
];

/** Right-to-left scripts. The panel flips `dir` for these; see `applyDirection`. */
const RTL = new Set(["ar", "fa"]);

const SUPPORTED = new Set(LOCALES.map((l) => l.code));

/** Loaded catalog for the ACTIVE locale only: flat key -> string. Empty until loaded. */
let catalog = Object.create(null);
let activeLocale = "en";
let loaded = false;

/**
 * Resolve arbitrary locale input to something we ship.
 *
 * Region-tagged input degrades to its base language ("ko-KR" -> "ko") rather than being
 * discarded, because a browser sending `ko-KR` wants Korean and refusing it to fall back
 * to English is the wrong answer. Exact regional matches we DO ship (`zh-TW`, `pt-BR`)
 * are checked first so they are never flattened to `zh` / `pt`.
 */
export function resolveLocale(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (SUPPORTED.has(raw)) return raw;

  // Script beats region for Chinese. We ship `zh` (Simplified) and `zh-TW` (Traditional);
  // Hong Kong and Macau write Traditional, so base-matching them to `zh` hands those users
  // the wrong script. Kept identical to the orchestrator's resolver in src/i18n/index.ts —
  // if these two ever disagree, a `say` bubble arrives in a different script than the panel
  // around it.
  if (/^zh[-_](HK|MO|Hant)/i.test(raw)) return "zh-TW";

  const base = raw.split(/[-_]/)[0];
  if (SUPPORTED.has(base)) return base;
  // Case-insensitive pass ("KO", "pt-br").
  const lower = raw.toLowerCase();
  for (const code of SUPPORTED) {
    if (code.toLowerCase() === lower) return code;
    if (code.toLowerCase() === base.toLowerCase()) return code;
  }
  // The base language isn't shipped standalone, but a REGIONAL variant of it is:
  // pt-PT -> pt-BR, zh-HK -> zh-TW. Someone asking for Portuguese is far better served by
  // Brazilian Portuguese than by English, which is what returning null here would give them.
  // Deterministic (first in LOCALES order) so the choice can't vary between loads.
  const baseLower = base.toLowerCase();
  for (const { code } of LOCALES) {
    if (code.toLowerCase().startsWith(`${baseLower}-`)) return code;
  }
  return null;
}

/**
 * Which language to render in.
 *
 * Order is deliberate. Our own setting wins because a user who explicitly picked a panel
 * language meant it. "Detect" (the default, stored as "") defers to ComfyUI's `Comfy.Locale`
 * so the panel follows the language the user already chose for the app — that deference IS
 * the piggyback. Only if ComfyUI has no opinion do we ask the browser.
 */
export function pickLocale({ ourSetting, comfyLocale, navigatorLangs } = {}) {
  const explicit = resolveLocale(ourSetting);
  if (explicit) return explicit;
  const comfy = resolveLocale(comfyLocale);
  if (comfy) return comfy;
  for (const l of navigatorLangs || []) {
    const hit = resolveLocale(l);
    if (hit) return hit;
  }
  return "en";
}

/**
 * Flatten `{a:{b:"x"}}` to `{"a.b":"x"}` so lookup is a single map hit and a malformed
 * nested file cannot produce a partially-walked object at render time.
 */
function flatten(obj, prefix = "", out = Object.create(null)) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else if (typeof v === "string") out[key] = v;
  }
  return out;
}

/**
 * Fetch the merged catalog and select our namespace for `locale`.
 *
 * Never throws and never rejects. Every failure mode here — no ComfyUI api object, a 404
 * from an older ComfyUI without the route, a network blip, malformed JSON — has the same
 * correct outcome: an empty catalog, which makes every `t()` return its English fallback.
 * A panel in English is a working panel; a panel that threw during setup is not.
 */
export async function loadCatalog(locale, api) {
  activeLocale = SUPPORTED.has(locale) ? locale : "en";
  catalog = Object.create(null);
  loaded = false;

  // English needs no catalog: the fallback argument at every call site IS the English text,
  // so fetching would cost a round trip to confirm what we already have inline.
  if (activeLocale === "en") {
    loaded = true;
    return { locale: activeLocale, keys: 0, skipped: "en-is-inline" };
  }

  try {
    const client = api ?? globalThis.window?.comfyAPI?.api?.api;
    if (typeof client?.fetchApi !== "function") return { locale: activeLocale, keys: 0, error: "no-api" };
    const res = await client.fetchApi("/i18n");
    // Guard `ok` explicitly: a non-2xx body parsed as JSON would silently install garbage.
    if (!res || res.ok === false) return { locale: activeLocale, keys: 0, error: `http-${res?.status ?? "?"}` };
    const all = await res.json();
    catalog = flatten(all?.[activeLocale]?.[NS]);
    loaded = true;
    return { locale: activeLocale, keys: Object.keys(catalog).length };
  } catch (err) {
    return { locale: activeLocale, keys: 0, error: String(err?.message || err) };
  }
}

/**
 * Translate.
 *
 * NAMED `tr`, NOT `t`, and this is load-bearing — do not "tidy" it. `t` is a local variable
 * in 93 places across the panel sources (`const t = getTarget()`, `(t) => ...`, loop temps).
 * Any of those shadows a module-scope `t` INSIDE the function that uses it, so the call
 * still parses, still passes `node --check`, and fails only at runtime as "t is not a
 * function". That is precisely how it was caught here — by the unit suite, after a codemod
 * that looked clean in review. `tr` has zero such bindings.
 *
 * `fallback` is REQUIRED and is the English source text, mirroring ComfyUI's own
 * `st(key, fallbackMessage)` idiom. It means the English string stays visible at the call
 * site (so the code still reads as prose) and a missing translation degrades to correct
 * English instead of leaking a raw key like `composer.send` into someone's UI.
 *
 * `vars` interpolates `{name}` placeholders. Values are inserted as text by the caller's
 * DOM write — this returns a string and never HTML, so it introduces no injection path.
 */
export function tr(key, fallback, vars) {
  const plural = vars && typeof vars.count === "number";
  let out;

  if (plural) {
    // Ask Intl for the CATEGORY this number takes in this language — "one"/"other" for
    // English, "other" alone for ja/ko/zh, and one/few/many/other for ru, which no amount of
    // hand-rolled `n === 1` logic gets right. Fall back to `_other`, the one category every
    // language has, then to the unsuffixed key so an un-pluralised catalog still resolves.
    const cat = pluralCategory(activeLocale, vars.count);
    if (loaded) out = catalog[`${key}_${cat}`] ?? catalog[`${key}_other`] ?? catalog[key];
    if (out === undefined) out = pickFallbackForm(fallback, "en", vars.count);
  } else {
    if (loaded) out = catalog[key];
    if (out === undefined) out = typeof fallback === "string" ? fallback : pickFallbackForm(fallback, "en", 0);
  }
  out = out ?? "";

  return interpolate(out, vars);
}

/**
 * Substitute `{name}` holes in ONE pass.
 *
 * Deliberately not a loop of `split(...).join(...)` per variable: that expands placeholders
 * that appear INSIDE an already-substituted value, so a group literally titled `{id}` renders
 * as `Created group "7" (id 7)` — the user's own title destroyed by the next variable's turn.
 * ComfyUI widget values carry braces routinely (dynamic-prompt syntax), so this is ordinary
 * data, not a crafted input. A single pass never revisits what it just wrote.
 *
 * The function replacer is also load-bearing: a plain string replacement would expand
 * `$&` / `$1` occurring inside a substituted VALUE. Values are data and must stay literal.
 */
function interpolate(str, vars) {
  if (!vars || !str) return str;
  return String(str).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** Intl.PluralRules is not free to construct; one per locale is plenty. */
const pluralRules = new Map();
function pluralCategory(locale, n) {
  try {
    let r = pluralRules.get(locale);
    if (!r) {
      r = new Intl.PluralRules(locale);
      pluralRules.set(locale, r);
    }
    return r.select(n);
  } catch {
    // An exotic tag Intl refuses still has to render something.
    return n === 1 ? "one" : "other";
  }
}

/**
 * English fallbacks for counted strings are written at the call site as
 * `{ one: "{count} node", other: "{count} nodes" }` — an object, not a string, so the English
 * plural stays visible in the code instead of being reconstructed from a suffix convention.
 */
function pickFallbackForm(fallback, sourceLocale, n) {
  if (typeof fallback === "string") return fallback;
  if (!fallback || typeof fallback !== "object") return "";
  const cat = pluralCategory(sourceLocale, n);
  return fallback[cat] ?? fallback.other ?? Object.values(fallback)[0] ?? "";
}

/** The active locale code. */
export function currentLocale() {
  return activeLocale;
}

/** Whether the active locale is right-to-left. */
export function isRTL(locale = activeLocale) {
  return RTL.has(locale);
}

/**
 * Set `dir` on the panel root so Arabic and Persian lay out correctly. Scoped to our own
 * element on purpose — flipping `document.documentElement` would re-lay-out ComfyUI's
 * entire canvas and every other extension's UI, which is not ours to do.
 */
export function applyDirection(rootEl, locale = activeLocale) {
  if (!rootEl) return;
  try {
    rootEl.setAttribute("dir", isRTL(locale) ? "rtl" : "ltr");
    rootEl.setAttribute("lang", locale);
  } catch {
    // A detached or exotic node that refuses attributes still renders; direction is cosmetic.
  }
}

/** Test seam: install a catalog directly, bypassing the network. */
export function __setCatalogForTest(locale, obj) {
  activeLocale = locale;
  catalog = flatten(obj);
  loaded = true;
}
