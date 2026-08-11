// CivitAI data client for the panel's CivitAI modal — a JS port of the mobile
// app's civitai_service.dart + civitai_models.dart. Every network call goes
// through the same-origin Python proxy (/comfyui_mcp_panel/civitai/*, see
// py/civitai_proxy.py) because a browser can't set the bot-gate headers or beat
// CORS. Media (thumbs/full/video) resolve to same-origin /media URLs usable as
// <img>/<video> src and fetchable as Blobs for share-with-agent.
//
// NOTE (parity, no NSFW gate): all browsing levels are freely selectable; there
// is no sign-in clamp. OAuth only enables the Favorites tab.

import { coerceMessageText } from "./lib/chat-serialize.js";
import { tr } from "./lib/i18n.js";

/** #417 — client-side abort budget for a single proxied CivitAI request. The
 *  Python proxy already bounds each upstream ATTEMPT at 30s but retries 3× on
 *  429/503, so a stalled search can outlast the agent's bridge read; this caps
 *  the whole browser-side call so _loadMore's catch/finally always runs. */
export const CIVITAI_REQUEST_TIMEOUT_MS = 15000;

// ── constants (mirror civitai_models.dart) ─────────────────────────────────
export const LEVELS = [
  { label: "PG", level: 1 },
  { label: "PG-13", level: 2 },
  { label: "R", level: 4 },
  { label: "X", level: 8 },
  { label: "XXX", level: 16 },
];

/** Human rating label for an image's `nsfwLevel` bit (1=PG … 16=XXX). An
 *  nsfwLevel is normally a single bit, but tolerate a combined mask by
 *  labelling with the HIGHEST rating present (so nothing under-reports). Used
 *  by the gated-favorite placeholder cards, which show the rating in place of
 *  the (withheld) media. */
export function levelLabel(n) {
  const lvl = Number(n) || 0;
  const exact = LEVELS.find((l) => l.level === lvl);
  if (exact) return exact.label;
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (lvl & LEVELS[i].level) return LEVELS[i].label;
  }
  return "?";
}
export const PERIODS = ["Day", "Week", "Month", "Year", "AllTime"];
export const IMAGE_SORTS = ["Most Reactions", "Most Comments", "Most Collected", "Newest", "Oldest"];
export const MODEL_SORTS = ["Most Downloaded", "Highest Rated", "Most Liked", "Newest", "Oldest"];

// #459: CivitAI's REST list endpoints (/v1/models, /v1/images) ZodError-reject
// ANY `sort`/`period` value outside their enum with a hard `400 Bad Request`
// that dead-ends the docked browser with "No data". A stale, renamed, or
// CROSS-TAB value — most notably an IMAGE sort such as "Most Reactions" reaching
// the /v1/models endpoint (which only accepts MODEL sorts) — must be clamped to
// a supported value BEFORE dispatch instead of surfacing as an opaque 400. These
// clamp against the panel's own offered sets (the only values its UI produces),
// falling back to the default at index 0, so the request is always well-formed.
// NOTE: an agent-supplied sort that is API-valid but NOT in the panel's offered
// subset (e.g. "Most Collected" for models) is normalized to the default too —
// a deliberate tradeoff: the docked browser only ever dispatches sorts it also
// exposes in its dropdown, so the dispatched request and the visible UI agree.
export const normalizeModelSort = (s) => (MODEL_SORTS.includes(s) ? s : MODEL_SORTS[0]);
export const normalizeImageSort = (s) => (IMAGE_SORTS.includes(s) ? s : IMAGE_SORTS[0]);
export const normalizePeriod = (p) => (PERIODS.includes(p) ? p : "Week");
/**
 * Civitai's full `BaseModel` enum. The site accepts ONLY these strings for
 * `baseModels=` — anything else silently returns nothing, so this list is the
 * filter's entire vocabulary and an omission is invisible: the model just
 * "doesn't exist" to the browser.
 *
 * It is hardcoded because Civitai publishes no endpoint for it. There is no
 * paginated enum route to walk (`system.getBaseModels` 404s on the tRPC API);
 * the values live in the site's own bundle. So this must be refreshed by hand
 * when Civitai adds a family — see ACTIVE_BASE_MODELS below for the subset
 * currently accepting uploads, which is what changes.
 */
export const BASE_MODELS = [
  "Anima", "AuraFlow", "Chroma", "CogVideoX", "Ernie",
  "Flux.1 S", "Flux.1 D", "Flux.1 Krea", "Flux.1 Kontext",
  "Flux.2 D", "Flux.2 Klein 9B", "Flux.2 Klein 9B-base",
  "Flux.2 Klein 4B", "Flux.2 Klein 4B-base",
  "Grok", "HappyHorse", "HiDream", "HiDream-O1", "Hunyuan 1", "Hunyuan Video",
  "Hunyuan3D", "Ideogram 4.0", "Boogu", "Illustrious", "Imagen4", "Kolors",
  "Krea 2", "LTXV", "LTXV2", "LTXV 2.3", "Lens", "Lumina", "MAI", "Mochi",
  "Nano Banana", "NoobAI", "ODOR", "OpenAI", "Upscaler", "Other",
  "PixArt a", "PixArt E", "Playground v2", "PolyGen", "Pony", "Pony V7",
  "Qwen", "Qwen 2", "Reve", "Seedance", "Seedream", "Sora 2",
  "Stable Cascade", "SVD", "SVD XT",
  "SD 1.4", "SD 1.5", "SD 1.5 LCM", "SD 1.5 Hyper",
  "SD 2.0", "SD 2.0 768", "SD 2.1", "SD 2.1 768", "SD 2.1 Unclip",
  "SD 3", "SD 3.5", "SD 3.5 Medium", "SD 3.5 Large", "SD 3.5 Large Turbo",
  "SDXL 0.9", "SDXL 1.0", "SDXL 1.0 LCM", "SDXL Distilled",
  "SDXL Turbo", "SDXL Lightning", "SDXL Hyper",
  "Tripo", "Veo 3", "Vidu Q1", "Hailuo by MiniMax", "Kling",
  "Wan Video", "Wan Video 1.3B t2v", "Wan Video 14B t2v",
  "Wan Video 14B i2v 480p", "Wan Video 14B i2v 720p",
  "Wan Video 2.2 TI2V-5B", "Wan Video 2.2 I2V-A14B", "Wan Video 2.2 T2V-A14B",
  "Wan Video 2.5 T2V", "Wan Video 2.5 I2V", "Wan Image 2.7", "Wan Video 2.7",
  "ZImageTurbo", "ZImageBase", "ACE Audio",
];

/**
 * The subset Civitai still accepts new uploads for. Surfaced FIRST in the
 * filter dropdown: the full list is 90+ entries and the retired half (SD 2.x,
 * SVD, Playground) buries what people actually search for today under names
 * that will return almost nothing.
 */
export const ACTIVE_BASE_MODELS = new Set([
  "Anima", "AuraFlow", "Chroma", "CogVideoX", "Ernie",
  "Flux.1 S", "Flux.1 D", "Flux.1 Krea", "Flux.1 Kontext",
  "Flux.2 D", "Flux.2 Klein 9B", "Flux.2 Klein 9B-base",
  "Flux.2 Klein 4B", "Flux.2 Klein 4B-base",
  "Grok", "HappyHorse", "HiDream", "HiDream-O1", "Hunyuan 1", "Hunyuan Video",
  "Ideogram 4.0", "Boogu", "Illustrious", "Kolors", "Krea 2",
  "LTXV", "LTXV2", "LTXV 2.3", "Lens", "Lumina", "MAI", "Mochi", "NoobAI",
  "Upscaler", "Other", "PixArt a", "PixArt E", "Pony", "Pony V7",
  "Qwen", "Qwen 2", "Reve",
  "SD 1.4", "SD 1.5", "SD 1.5 LCM", "SD 1.5 Hyper", "SD 2.0", "SD 2.1",
  "SDXL 1.0", "SDXL Lightning", "SDXL Hyper",
  "Wan Video 1.3B t2v", "Wan Video 14B t2v",
  "Wan Video 14B i2v 480p", "Wan Video 14B i2v 720p",
  "Wan Video 2.2 TI2V-5B", "Wan Video 2.2 I2V-A14B", "Wan Video 2.2 T2V-A14B",
  "Wan Video 2.5 T2V", "Wan Video 2.5 I2V", "Wan Image 2.7", "Wan Video 2.7",
  "ZImageTurbo", "ZImageBase", "ACE Audio",
]);

/**
 * Match a base-model name against a typed query.
 *
 * Plain substring matching is wrong here, and fails on the most obvious
 * searches there are: Civitai writes the families as "Flux.2 D" and
 * "Wan Video 2.5 T2V", so `"flux 2"` and `"wan 2.5"` — what a person actually
 * types — both find NOTHING, because of a dot in one and an interposed word in
 * the other. A zero-result list reads as "this model isn't supported", which is
 * exactly the wrong conclusion.
 *
 * So: split both sides on punctuation and require every query token to appear,
 * IN ORDER, as the prefix of some later name token. "flux 2" reaches "Flux.2 D"
 * and "wan 2.5" reaches "Wan Video 2.5 T2V", while "flux 2" still does not
 * reach "Flux.1 D". Order matters — without it "d flux" would match too, and
 * ranking suffers when every token floats free.
 */
/**
 * Split into words, keeping a version number whole: "wan 2.5" -&gt; ["wan","2.5"],
 * "Flux.2 D" -&gt; ["flux","2","d"]. The dot survives only BETWEEN DIGITS, which
 * is what separates a version from ordinary punctuation — and it is what keeps
 * "wan 2.5" off "Wan Video 2.2 TI2V-5B", where a naive split into ["wan","2","5"]
 * happily matches the "2" of 2.2 and the "5" of 5B and offers the wrong model.
 */
export function tokenizeQuery(q) {
  return String(q ?? "").toLowerCase().match(/[0-9]+(?:\.[0-9]+)+|[a-z0-9]+/g) || [];
}

/** Everything that isn't alphanumeric, dropped — "z-image" and "Z Image" both
 *  collapse onto "zimage", which is how they reach "ZImageTurbo". */
function compactify(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function prepareQuery(q) {
  const raw = String(q ?? "").trim();
  return { raw, tokens: tokenizeQuery(raw), compact: compactify(raw) };
}

/**
 * Match a base-model name against a typed query.
 *
 * Two matching strategies, because Civitai's names break each one alone:
 *
 * - **Ordered token prefixes** handle names with words in between. "wan 2.5"
 *   has to cross "Video" to reach "Wan Video 2.5 T2V".
 * - **Compacted substring** handles names that are jammed together. "z-image"
 *   and "aura flow" have to reach "ZImageTurbo" and "AuraFlow", which are one
 *   token each — no amount of token matching gets there, since the query has
 *   two tokens and the name has one.
 *
 * Either one hitting is a match. Both are ordered, so "flux 2" still cannot
 * reach "Flux.1 D" and "sd 3.5" cannot reach bare "SD 3" — matching the wrong
 * version is worse than matching nothing, because it sends someone off to
 * download a model that will not do what they asked.
 */
export function matchesBaseModel(name, query) {
  const q = query && typeof query === "object" && "raw" in query
    ? query
    : prepareQuery(Array.isArray(query) ? query.join(" ") : query);

  // An empty box means "no filter". But a query of "🔥" or "..." is NOT empty —
  // it tokenizes to nothing, and treating that as no-filter would answer a
  // nonsense search with all 96 models, which reads as if they all matched.
  if (!q.raw) return true;
  if (!q.tokens.length && !q.compact) return false;

  if (q.compact && compactify(name).includes(q.compact)) return true;

  const words = tokenizeQuery(name);
  let at = 0;
  for (const t of q.tokens) {
    const hit = words.findIndex((w, i) => i >= at && w.startsWith(t));
    if (hit < 0) return false;
    at = hit + 1;
  }
  return true;
}

export const DEFAULT_FILTERS = Object.freeze({
  period: "Week",
  baseModels: [],
  imageSort: "Most Reactions",
  modelSort: "Most Downloaded",
  browsingLevels: [1],
  favorited: false,
  username: null, // creator filter — null means everyone
});

/**
 * GitHub-style search qualifiers: an "@name" token anywhere in the input sets
 * the creator filter; every other token stays part of the ranked full-text
 * query. "@ba0zi cyberpunk city rain" -> { creator: "ba0zi", query:
 * "cyberpunk city rain" }. The terms deliberately remain Meili `q` (typo-
 * tolerant, relevance-ranked) rather than exact tagNames filters, which would
 * be brittle. Only the FIRST @token is the creator; later ones are treated as
 * plain terms so a pasted sentence can't silently retarget the filter.
 */
export function parseCreatorQuery(raw) {
  const tokens = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  const atIdx = tokens.findIndex((t) => t.length > 1 && t.startsWith("@"));
  return {
    creator: atIdx >= 0 ? tokens[atIdx].slice(1) : null,
    // Remove only the FIRST qualifier occurrence — a later identical token is
    // a plain term per the documented rule ("@alice cats @alice").
    query: tokens.filter((_, i) => i !== atIdx).join(" "),
  };
}

export function filtersDirty(f) {
  return (
    f.period !== "Week" ||
    f.imageSort !== "Most Reactions" ||
    f.modelSort !== "Most Downloaded" ||
    f.baseModels.length > 0 ||
    f.favorited ||
    !!f.username ||
    !(f.browsingLevels.length === 1 && f.browsingLevels[0] === 1)
  );
}

export function bitmask(levels) {
  if (!levels || levels.length === 0) return 1;
  return levels.reduce((a, b) => a | b, 0);
}

// ── hosts / keys (mirror civitai_service.dart) ─────────────────────────────
const API = "https://civitai.red/api";
const SEARCH_URL = "https://search-new.civitai.com/multi-search";
const SEARCH_KEY =
  "8c46eb2508e21db1e9828a97968d91ab1ca1caa5f70a00e88a2ba1e286603b61";
const CDN_TOKEN = "xG1nkqKTMzGDvpLrqFT7WA";

const _levelFromString = (s) =>
  ({ None: 1, Soft: 2, Mature: 4, X: 8, XXX: 16 }[s] || 1);

// CivitAI's tRPC responses switched from superjson ({json,meta}) to the devalue
// "flattened" form: result.data is a STRING that parses to a flat array where
// index 0 is the root and EVERY container value is an integer index into that
// array (negatives are special values). Our readers all expect result.data.json,
// so on a string result.data we unflatten and rewrap as { json: <root> }. This
// is what broke Favorites (the only tab on tRPC image.getInfinite) on prod while
// the REST-backed tabs kept working. No-op on already-normal / REST responses.
const _DEVALUE_SPECIAL = { "-1": undefined, "-2": null, "-3": NaN, "-4": Infinity, "-5": -Infinity, "-6": -0 };
export function unflattenDevalue(flat) {
  if (!Array.isArray(flat) || flat.length === 0) return flat;
  const seen = new Array(flat.length);
  const build = (i) => {
    if (typeof i === "number" && i < 0) return _DEVALUE_SPECIAL[i];
    if (typeof i !== "number") return i;
    if (i in seen) return seen[i];
    const v = flat[i];
    if (v === null || typeof v !== "object") { seen[i] = v; return v; }
    if (Array.isArray(v)) { const a = []; seen[i] = a; for (const e of v) a.push(build(e)); return a; }
    const o = {}; seen[i] = o; for (const k in v) o[k] = build(v[k]); return o;
  };
  return build(0);
}
export function normalizeTrpcResponse(data) {
  const d = data && data.result ? data.result.data : undefined;
  if (typeof d !== "string") return data; // already {json:…} or a REST/plain response
  try {
    const flat = JSON.parse(d);
    if (Array.isArray(flat)) data.result.data = { json: unflattenDevalue(flat) };
  } catch { /* not the devalue string form — leave untouched */ }
  return data;
}

// ── upstream failure description (#705) ─────────────────────────────────────
// A bare "CivitAI API 503: Service Unavailable" is a MISLEADING error, not just
// a terse one: it reads as QUERY-SPECIFIC ("my search for 'min' is broken") and
// sent the reporter of #705 hunting through our code, while the actual cause was
// sitting in the response body the Python proxy already forwards verbatim —
//   {"error":"Model search is temporarily overloaded — please retry."}
// The user has to be able to tell an outage on CivitAI's side of the wire from a
// bug on ours, and the body is the only place that distinction exists.
//
// Three rules hold everything below together:
//   1. NEVER pretend to a cause. An empty body, an HTML edge-cache page and a
//      JSON blob with no message field each get a description of what ACTUALLY
//      came back; none of them get a fabricated reason. "503, no detail from
//      CivitAI" beats a bare status, and beats an invented explanation by more.
//   2. NEVER dump the body. It is untrusted, arbitrary-length text heading for a
//      UI string and the ComfyUI console: bounded, flattened to one line, control
//      bytes stripped, credential-shaped runs redacted, and always QUOTED and
//      ATTRIBUTED so CivitAI's words can never be mistaken for ours. (The error
//      card renders via textContent, so markup can't execute — but pasting a CDN
//      error page into a sentence is its own misleading-error bug.)
//   3. Advice follows the STATUS, not the body. "Retry shortly" is right for a
//      503 and actively wrong for a 400 that will never succeed however often
//      it is repeated.

/** Longest run of upstream text quoted into a user-facing message. Generous
 *  enough for a real API sentence, small enough that a hostile or accidental
 *  megabyte-long body cannot BECOME the error card. */
export const CIVITAI_DETAIL_MAX = 240;

// Credential-shaped runs, redacted before any upstream text is displayed or
// logged. The proxy injects the CivitAI OAuth bearer (and the MeiliSearch key)
// into the REQUEST, server-side; an upstream that echoes a request header back
// inside its error body must not turn our own error card into a token leak.
// Two rules: a LABELLED secret (Authorization: Bearer …, api_key=…), and a bare
// JWT, which is the shape of CivitAI's OAuth access tokens. The 20-char floor on
// the value keeps ordinary prose intact ("Invalid API key provided" survives).
// The optional scheme token matters: "Authorization: Basic <base64>" puts a word
// between the label and the secret, and without it the credential walks straight
// through (codex gate finding — Bearer and JWT were covered, Basic was not).
const _LABELLED_SECRET_RE =
  /\b(bearer|authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token)\b[\s:=]*(?:basic|bearer|digest|negotiate|token)?[\s:=]*["']?[A-Za-z0-9._~+/-]{20,}={0,2}["']?/gi;
const _JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

// Redaction runs over a WINDOW, never the whole body. The patterns are cheap on a
// sentence and needlessly expensive on the megabytes /api will now carry, and
// everything past the window is discarded by the cap anyway.
const _REDACT_WINDOW = CIVITAI_DETAIL_MAX * 8;

/** Replace credential-shaped runs with a visible marker. Never silently drop:
 *  the reader should be able to tell that something was withheld. */
export function redactCredentials(text) {
  return String(text)
    .replace(_JWT_RE, "[redacted]")
    .replace(_LABELLED_SECRET_RE, (_m, label) => `${label} [redacted]`);
}

/** One-line, control-byte-free, credential-free, bounded rendering of untrusted
 *  upstream text. Truncation is MARKED (…), never silent — a message that was
 *  quietly cut in half is a new way to mislead. */
function _cleanUpstreamText(raw) {
  const flat = String(raw ?? "")
    // Newlines, tabs, ANSI escapes and stray NULs all become spaces: a one-line
    // error card must stay one line, and no control byte may ride an untrusted
    // body into the DOM or the console.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Narrow to the redaction window BEFORE running the credential patterns: those
  // have adjacent overlapping quantifiers (polynomial, not exponential, but
  // still wasted work on a multi-megabyte body), and nothing past the window can
  // reach the user anyway. Flattening above is a linear character-class pass, so
  // it is safe to do on the whole string.
  const windowed = flat.length > _REDACT_WINDOW ? flat.slice(0, _REDACT_WINDOW) : flat;
  const clipped = windowed.length < flat.length;
  const safe = redactCredentials(windowed).replace(/\s+/g, " ").trim();
  if (safe.length > CIVITAI_DETAIL_MAX) {
    return `${safe.slice(0, CIVITAI_DETAIL_MAX - 1).trimEnd()}…`;
  }
  // Redaction SHRINKS text, so a body that overflowed the window can come back
  // under the cap and skip the marker above — the reader would then see a
  // message that looks whole while the real cause sat past the window. If
  // anything was dropped, say so. (Codex gate: three long `token=…` runs
  // followed by the actual reason rendered as "token [redacted]" ×3, full stop.)
  return clipped ? `${safe}…` : safe;
}

const _firstString = (...vals) => {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return "";
};

/** Pull the human sentence out of a parsed error body. The shapes are the ones
 *  CivitAI and this proxy actually produce: REST {"error":"…"}, the panel proxy's
 *  own {"error":"…"} guards, tRPC {"error":{"json":{"message":…}}}, and Zod's
 *  {"error":{"issues":[{"message":…}]}} (which is what a #459-class 400 looks
 *  like). A deliberately SHALLOW, ordered lookup — a generic deep search would
 *  happily surface some unrelated nested string as "the reason". */
function _messageFromJson(j) {
  if (typeof j === "string") return j;
  if (Array.isArray(j)) return j.length ? _messageFromJson(j[0]) : ""; // tRPC batch
  if (!j || typeof j !== "object") return "";
  const e = j.error;
  return _firstString(
    typeof e === "string" ? e : "",
    e?.message,
    e?.json?.message,
    j.message,
    j.detail,
    j.error_description,
    e?.issues?.[0]?.message,
    j.issues?.[0]?.message,
  );
}

/** Marker py/civitai_proxy.py stamps on error bodies IT authored. Its absence
 *  means the body came from CivitAI. Quoting our own guard rails back at the
 *  user as "CivitAI said: …" would be the same misattribution #705 is about,
 *  only pointed the other way — the whole bar here is that the user can tell an
 *  outage on CivitAI's side of the wire from a problem on ours. */
const PANEL_PROXY_SOURCE = "comfyui-mcp-panel";

/** Turn a raw upstream body into `{ text, shape, fromProxy }`. `text` is the
 *  quotable sentence — already flattened, redacted and bounded — or "" when
 *  there isn't one; `shape` says what actually came back so the caller can be
 *  honest instead of silent; `fromProxy` says who to attribute it to. */
export function extractUpstreamDetail(bodyText) {
  const raw = typeof bodyText === "string" ? bodyText.trim() : "";
  if (!raw) return { text: "", shape: "empty", fromProxy: false, proxyRetryable: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The proxy stamps content_type:"application/json" on WHATEVER CivitAI
    // returned, so the header is not evidence — only the body is. A leading "<"
    // is an HTML/XML error page (a CDN or edge 5xx): reporting its shape is
    // honest; pasting its markup into a sentence would be misleading noise.
    if (raw.startsWith("<")) return { text: "", shape: "html", fromProxy: false, proxyRetryable: null };
    // Everything else is plain text. The panel's own proxy always answers in
    // JSON on the routes this client reads, so unmarked text is CivitAI's.
    return { text: _cleanUpstreamText(raw), shape: "text", fromProxy: false, proxyRetryable: null };
  }
  const fromProxy = parsed?.source === PANEL_PROXY_SOURCE;
  // When the panel's own proxy authored the body, IT decides whether retrying
  // helps: the status on such a reply is ours, and says nothing useful. Its 502
  // covers both "could not reach CivitAI" (worth retrying) and the redirect
  // allow-list refusal (deterministic — it will fail identically forever), and
  // inferring "transient" from the number would advise a retry that cannot work.
  const proxyRetryable =
    fromProxy && typeof parsed?.retryable === "boolean" ? parsed.retryable : null;
  const msg = _cleanUpstreamText(_messageFromJson(parsed));
  return msg
    ? { text: msg, shape: "json", fromProxy, proxyRetryable }
    : { text: "", shape: "json-nomessage", fromProxy, proxyRetryable };
}

/** How an upstream HTTP status should steer the user:
 *   transient — CivitAI failed the request on its own side; retrying may work.
 *   terminal  — CivitAI REJECTED the request; repeating it unchanged cannot work.
 *   auth      — it needs a signed-in account.
 *   unknown   — claim neither.
 *  Status-driven on purpose: the body says what went wrong, the status says
 *  whether doing the same thing again is worth the user's time. */
export function upstreamFailureClass(status) {
  const s = Number(status);
  if (s === 401 || s === 403) return "auth";
  if (s === 408 || s === 425 || s === 429) return "transient";
  // 501/505 are 5xx the server will never satisfy, however long you wait.
  if (s === 501 || s === 505) return "terminal";
  if (s >= 500 && s <= 599) return "transient";
  if (s >= 400 && s <= 499) return "terminal";
  return "unknown";
}

const _SHAPE_NOTE = {
  empty: "There was no detail in CivitAI's response body.",
  html:
    "CivitAI returned an HTML error page instead of JSON (typically a CDN or edge " +
    "failure in front of the API), so it gave no machine-readable reason.",
  "json-nomessage": "CivitAI's response body was JSON with no error message in it.",
  // Same shape, ours: the note must not name CivitAI when the marker says the
  // panel's own proxy wrote the body. (`empty` and `html` need no such variant —
  // a body with no readable JSON carries no marker to read, so it is CivitAI's
  // by construction.)
  "json-nomessage-proxy":
    "The panel's CivitAI proxy returned JSON with no error message in it.",
};

const _ADVICE = {
  transient:
    "CivitAI failed this request on its own side rather than rejecting it, so " +
    "retrying shortly may succeed.",
  terminal: "CivitAI rejected the request itself, so repeating it unchanged will not help.",
  auth:
    "CivitAI wants a signed-in account for this — use the account button in the " +
    "CivitAI browser to sign in (or sign out and back in if you already are).",
  // The panel's own proxy stopped the request. Neither sentence may claim
  // anything about what CivitAI did — the request may never have reached it.
  "transient-proxy":
    "The panel's CivitAI proxy could not complete the request, so retrying " +
    "shortly may succeed.",
  "terminal-proxy": "The panel's CivitAI proxy refused this outright, so repeating it will not help.",
  // Ours, but we don't know whether retrying helps — so claim neither.
  "unknown-proxy": "This failure came from the panel's CivitAI proxy rather than from a CivitAI response.",
};

/** Build the user-facing description of a non-2xx proxy reply.
 *  Returns `{ message, detail, retryable }`: `message` is the whole sentence for
 *  the error card, `detail` is the bounded upstream text ALONE (so the UI and the
 *  agent-facing error state can use it without re-parsing prose), and `retryable`
 *  is true / false / null. Exported for unit tests. Pure with respect to its
 *  ARGUMENTS; since `label` defaults through tr() it also reads the loaded
 *  translation catalog, so the same inputs render in the user's language. */
// `label` is a DEFAULT PARAMETER, which is why the string extractor missed it: it
// matches assignment contexts, not destructuring defaults. It heads the sentence
// on the error card ("CivitAI API 503: …") — "CivitAI" is the brand and stays,
// "API" is the translatable noun. Evaluated per call, so the catalog is loaded
// long before any request can fail.
//
// `message` has a SECOND audience: civitaiErrorState carries it into
// panel_civitai_results as `error`, so under a non-English locale the agent reads
// a partly-translated status line. That is accepted, not overlooked — the same is
// already true of the tr()'d download label below, the status code and the quoted
// upstream detail are untouched, and the user seeing their own language on the
// card is what #705 was about. Do not, however, ever compare this string.
export function describeUpstreamFailure({ status, statusText, bodyText, label = tr("civitai.civitai_api", "CivitAI API") }) {
  const { text, shape, fromProxy, proxyRetryable } = extractUpstreamDetail(bodyText);
  // A proxy-authored reply carries OUR status, so upstreamFailureClass would be
  // reading a number that says nothing about CivitAI. Honour what the proxy
  // declared instead — except for 401/403, where "sign in" is the action either
  // way. (Codex gate: a 502 from the redirect allow-list guard was being sold to
  // the user as a transient CivitAI outage worth retrying. It never succeeds.)
  const statusCls = upstreamFailureClass(status);
  let cls;
  if (statusCls === "auth") {
    cls = "auth"; // whoever spoke, signing in is the action
  } else if (!fromProxy) {
    cls = statusCls;
  } else if (proxyRetryable === true) {
    cls = "transient-proxy";
  } else if (proxyRetryable === false) {
    cls = "terminal-proxy";
  } else {
    // Proxy-authored but silent about retryability (an older proxy than this
    // panel JS). Falling back to the status would read the number as CivitAI's
    // and tell the user "CivitAI failed this on its own side" directly after
    // saying the PANEL's proxy spoke — two contradictory claims in one message.
    cls = "unknown-proxy";
  }
  const head = `${label} ${status}: ${statusText || "request failed"}`;
  // Quote and attribute, always: the reader must be able to tell borrowed words
  // from ours, and WHOSE they are. A trailing stop is added when the quote
  // doesn't carry one, so the advice that follows doesn't run into it.
  const who = fromProxy ? "The panel's CivitAI proxy said" : "CivitAI said";
  const noteKey = fromProxy && _SHAPE_NOTE[`${shape}-proxy`] ? `${shape}-proxy` : shape;
  const said = text
    ? `${who}: “${text}”${/[.!?…]$/.test(text) ? "" : "."}`
    : _SHAPE_NOTE[noteKey] || _SHAPE_NOTE.empty;
  return {
    message: [head, "—", said, _ADVICE[cls]].filter(Boolean).join(" "),
    detail: text,
    retryable:
      cls === "transient" || cls === "transient-proxy"
        ? true
        : cls === "unknown" || cls === "unknown-proxy"
          ? null
          : false,
  };
}

/** Best-effort read of a FAILED response's body. A body we cannot read is our
 *  problem, not CivitAI's: it degrades to the status description and must never
 *  mask, replace or narrate over the failure it was meant to explain. Only ever
 *  called on the !res.ok path, so it can never consume a success body. */
async function _readErrorBody(res) {
  try {
    return typeof res?.text === "function" ? await res.text() : "";
  } catch {
    return ""; // e.g. an already-consumed stream — say nothing rather than lie
  }
}

export class CivitaiClient {
  /** @param {object} api ComfyUI api ({fetchApi, apiURL}) injected by the monolith. */
  constructor(api) {
    this.api = api;
  }

  // ── proxy plumbing ───────────────────────────────────────────────────────
  async _get(url, { auth = false, headers } = {}) {
    return this._request({ url, method: "GET", auth, headers });
  }

  async _request({ url, method = "GET", body, auth = false, headers, idempotent: idem }) {
    // #417: bound EVERY proxied CivitAI call with a client-side abort. Without it,
    // a proxy/upstream request that never settles leaves this fetch pending
    // forever, so _loadMore never reaches its catch/finally — the docked browser
    // and panel_civitai_results stay {loading:true, total:0, error:null} with no
    // way to recover. On timeout we THROW a plain Error (no AbortError leaking to
    // callers) so the existing catch sets state.error and clears loading.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CIVITAI_REQUEST_TIMEOUT_MS);
    // #599: a bare transport rejection (TypeError "Failed to fetch", NO HTTP
    // status) establishes exactly ONE thing — the browser obtained no HTTP
    // response. It does NOT identify which leg failed, and it does NOT rule
    // CivitAI out: a request that reached ComfyUI, whose own upstream CivitAI
    // call then failed or whose response connection dropped on the way back,
    // rejects identically. So `kind:"transport"` means "no HTTP response was
    // received; the failing hop is UNDETERMINED" — never "the browser→ComfyUI
    // hop is the cause". Naming one candidate as the cause is the very defect
    // #599 exists to remove (the opaque bucket narrated as a diagnosis): it
    // sends the user to rule out a component that may be perfectly healthy.
    // The marker is still worth carrying, because it distinguishes "no HTTP
    // response at all" from an upstream CivitAI error (which ALWAYS carries an
    // HTTP status) and from a true empty result (error is null) — those three
    // really are different, and only the hop is unknown.
    //
    // The proxy call is always a POST, which Chrome will NOT self-retry when a
    // pooled keep-alive connection turns out to be stale, so do ONE bounded
    // retry here — but only for an idempotent spec: a mutation
    // (reaction.toggle, collection writes) must never be double-fired. The
    // retry shares the #417 abort budget above, so the worst case is unchanged.
    //
    // Idempotency is a property of the OPERATION, not the HTTP method: CivitAI
    // reads are GETs EXCEPT MeiliSearch multi-search, which is a read-only
    // POST — callers pass `idempotent: true` for that one. Anything else POST
    // (reaction.toggle, collection writes) is a mutation and is never retried.
    const idempotent = idem ?? ((method || "GET").toUpperCase() === "GET");
    // The FIRST attempt's rejection, retained so the retry can never destroy
    // it: attempt 1 can fail with the actionable error and attempt 2 with an
    // unrelated one, and showing only the second loses the diagnosis. Every
    // throw below reports the whole trail and attaches the original as `cause`.
    let firstTransportError = null;
    const errText = (e) => coerceMessageText(e?.message ?? e);
    const attemptTrail = (last) =>
      firstTransportError
        ? `attempt 1 failed with: ${errText(firstTransportError)}; the retry then failed with: ${errText(last)}`
        : `browser transport error: ${errText(last)}`;
    // Append attempt 1's rejection to a failure raised AFTER a retry actually
    // got a response (an upstream status, or a body that won't parse). Those
    // throws are outside the retry catch, so without this the first attempt's
    // evidence is dropped exactly as it was before this fix.
    const withFirstAttempt = (msg) =>
      firstTransportError
        ? `${msg} (a first attempt had already failed at transport with: ${errText(firstTransportError)})`
        : msg;
    let res;
    let errorBody = "";
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          res = await this.api.fetchApi("/comfyui_mcp_panel/civitai/api", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url, method, body, auth, headers }),
            signal: controller.signal,
          });
          break;
        } catch (e) {
          if (e?.name === "AbortError") {
            throw Object.assign(
              new Error(
                `CivitAI request timed out after ${Math.round(CIVITAI_REQUEST_TIMEOUT_MS / 1000)} seconds` +
                (firstTransportError
                  ? ` (a first attempt had already failed with: ${errText(firstTransportError)})`
                  : ""),
              ),
              firstTransportError ? { cause: firstTransportError } : {},
            );
          }
          if (typeof e?.status !== "number") {
            if (idempotent && attempt < 1) {
              firstTransportError = e;
              continue;
            }
            throw Object.assign(
              new Error(
                `The CivitAI request produced no HTTP response, so the failing hop could NOT be ` +
                `determined (${attemptTrail(e)}). A rejected fetch carrying no HTTP status does not ` +
                `say which leg failed and does not rule CivitAI out — every one of these produces ` +
                `the identical error: ComfyUI is not running, is restarting or is unreachable; the ` +
                `connection to ComfyUI dropped; a browser extension, proxy or policy blocked the ` +
                `request; or ComfyUI did reach CivitAI, CivitAI failed, and no response made it ` +
                `back. What IS certain is that no HTTP status was received, so this is not a ` +
                `confirmed empty result — no result arrived at all. Start by checking that ComfyUI ` +
                `is running and reachable, then retry.`,
              ),
              {
                status: null,
                kind: "transport",
                ...(firstTransportError ? { cause: firstTransportError } : {}),
              },
            );
          }
          throw e;
        }
      }
      // #705 + #417: read a FAILED response's body while the abort budget above
      // is still ARMED. Headers can arrive and the body then never finish, and a
      // body read placed after clearTimeout would turn a perfectly known 503
      // into the exact hang #417 exists to prevent — _loadMore never reaching
      // its catch/finally, the grid stuck on {loading:true, total:0}. Inside the
      // budget, an unfinished body aborts, _readErrorBody swallows it, and the
      // status is still reported. Only ever entered on the !ok path, so it can
      // never consume a success body.
      if (!res.ok) errorBody = await _readErrorBody(res);
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      // Carry the upstream status as a property so callers (the UI's fetch
      // catch) can surface a distinct error state instead of an empty grid
      // (#190). The proxy forwards CivitAI's status, so res.status is the real
      // upstream code (e.g. 503 when model search is overloaded).
      //
      // If attempt 1 died at transport and the RETRY is what produced this
      // status, that first rejection is still evidence and must survive here
      // too — otherwise the failure that only shows up on the first attempt
      // (an extension blocking the request, a dropped connection) is silently
      // replaced by an unrelated upstream status. Same rule as the transport
      // and timeout throws above: report the whole trail, never just the last.
      //
      // #705: read the forwarded BODY too. The proxy hands CivitAI's own bytes
      // back with the upstream status, and that is where the actionable text
      // lives ("Model search is temporarily overloaded — please retry."); a
      // message built from status/statusText alone throws all of it away and
      // reads as though the user's own query were at fault.
      const upstream = describeUpstreamFailure({
        status: res.status,
        statusText: res.statusText,
        bodyText: errorBody,
      });
      throw Object.assign(new Error(withFirstAttempt(upstream.message)), {
        status: res.status,
        detail: upstream.detail,
        retryable: upstream.retryable,
        ...(firstTransportError ? { cause: firstTransportError } : {}),
      });
    }
    try {
      return normalizeTrpcResponse(await res.json());
    } catch (e) {
      // A body that will not parse is a real failure, and if attempt 1 had
      // already failed at transport that first error is part of the diagnosis.
      // Do NOT stamp an HTTP status here: res was ok, so there is no upstream
      // error status to report, and inventing one would read to
      // civitaiErrorState as "CivitAI returned an error" — a different claim.
      //
      // AUGMENT the parse error in place; never rebuild it. Wrapping it in a
      // fresh Error would drop its class (SyntaxError) and its stack — losing
      // the retry's evidence in the very act of preserving attempt 1's, which
      // is the same defect this whole change exists to remove.
      if (!firstTransportError) throw e;
      if (e instanceof Error) {
        e.message = withFirstAttempt(e.message);
        // Only fill an EMPTY cause — an existing one is itself evidence and
        // must not be overwritten. The trail is in the message either way.
        if (e.cause === undefined) e.cause = firstTransportError;
        throw e;
      }
      throw Object.assign(new Error(withFirstAttempt(errText(e))), {
        cause: firstTransportError,
      });
    }
  }

  /** Same-origin CDN media URL (usable as <img>/<video> src AND fetchable as a Blob). */
  mediaUrl(uuid, transform, ext) {
    const q = new URLSearchParams({ uuid, transform, ext });
    return this.api.apiURL(`/comfyui_mcp_panel/civitai/media?${q.toString()}`);
  }

  _thumb(uuid, isVideo) {
    return isVideo
      ? this.mediaUrl(uuid, "anim=false,transcode=true,width=450,original=false,optimized=true", "jpeg")
      : this.mediaUrl(uuid, "width=450", "jpeg");
  }
  _full(uuid, isVideo) {
    return isVideo
      ? this.mediaUrl(uuid, "transcode=true,width=450,optimized=true", "mp4")
      : this.mediaUrl(uuid, "original=true", "jpeg");
  }

  // Strip a full CDN url down to its uuid (the path segment after the token);
  // MeiliSearch already gives a bare uuid.
  _uuid(u) {
    if (typeof u !== "string" || !u.startsWith("http")) return u;
    const parts = u.split("/").filter(Boolean);
    const i = parts.indexOf(CDN_TOKEN);
    return i >= 0 && parts[i + 1] ? parts[i + 1] : parts[parts.length - 2] || u;
  }

  // primary downloadable file name for a model version (for "in library" matching)
  _primaryFile(v) {
    const files = (v && v.files) || [];
    const f = files.find((x) => x.primary) || files[0];
    return f && f.name ? f.name : null;
  }

  /** Parse the `list_local_models` markdown into a Set of normalized local
   *  filenames (lowercased full name AND stem) for "in library" matching. */
  static parseLocalNames(text) {
    const set = new Set();
    for (const line of (text || "").split("\n")) {
      const m = line.match(/^\s*-\s+(.+?)(?:\s+\(\d|\s*$)/);
      if (!m) continue;
      const name = m[1].trim().toLowerCase();
      if (!name || name.startsWith("trigger words") || name.startsWith("base:")) continue;
      set.add(name);
      set.add(name.replace(/\.[a-z0-9]+$/, "")); // stem, for extension mismatches
    }
    return set;
  }

  _reactions(m) {
    const k = (a, b) => (m[a] ?? m[b] ?? 0);
    return k("likeCount", "likeCountAllTime") + k("heartCount", "heartCountAllTime") +
      k("laughCount", "laughCountAllTime") + k("cryCount", "cryCountAllTime");
  }

  // ── parsers ────────────────────────────────────────────────────────────
  _fromRest(j) {
    const isVideo = (j.type || "image") === "video";
    const uuid = this._uuid(j.url);
    const nsfw = typeof j.nsfwLevel === "string" ? _levelFromString(j.nsfwLevel) : (j.nsfwLevel || 1);
    return {
      id: j.id, uuid, type: isVideo ? "video" : "image",
      thumbnailUrl: this._thumb(uuid, isVideo), fullUrl: this._full(uuid, isVideo),
      width: j.width || 0, height: j.height || 0, nsfwLevel: nsfw,
      prompt: j.meta?.prompt || null, modelName: j.meta?.Model || j.baseModel || null,
      author: j.username || null, reactions: this._reactions(j.stats || {}),
      meta: j.meta || null,
    };
  }

  _fromMeili(j) {
    const isVideo = (j.type || "image") === "video";
    const uuid = this._uuid(j.url);
    return {
      id: j.id, uuid, type: isVideo ? "video" : "image",
      thumbnailUrl: this._thumb(uuid, isVideo), fullUrl: this._full(uuid, isVideo),
      width: j.width || 0, height: j.height || 0, nsfwLevel: j.nsfwLevel || 1,
      prompt: j.meta?.prompt || null, modelName: j.meta?.Model || j.baseModel || null,
      author: j.user?.username || j.username || null, reactions: this._reactions(j.stats || j),
      meta: j.meta || null,
    };
  }

  // pick the highest-level cover image whose level is in the selected set (mask);
  // drop the model entirely if none qualify (no NSFW cover leaking into an SFW view)
  _modelFromJson(j, levels) {
    // #515: /v1/models gates nsfw=false loosely — entries explicitly flagged
    // nsfw:true still come back. When the selected levels are SFW-only
    // (mask ⊆ {PG, PG-13}), drop such models outright; cover-level filtering
    // below alone isn't enough because a PG cover can front an NSFW model.
    if (bitmask(levels) <= 3 && j.nsfw === true) return null;
    const mask = bitmask(levels);
    let best = null, bestLvl = -1;
    for (const v of j.modelVersions || []) {
      for (const img of v.images || []) {
        const lvl = img.nsfwLevel || 1;
        if ((lvl & mask) !== 0 && lvl > bestLvl) { best = img; bestLvl = lvl; }
      }
    }
    if (!best) return null;
    const uuid = this._uuid(best.url);
    const isVideo = (best.type || "image") === "video";
    return {
      id: j.id, name: j.name, type: j.type,
      coverUrl: this._thumb(uuid, isVideo), coverIsVideo: isVideo,
      nsfwLevel: bestLvl, baseModel: j.modelVersions?.[0]?.baseModel || null,
      creator: j.creator?.username || null,
      downloadCount: j.stats?.downloadCount, thumbsUp: j.stats?.thumbsUpCount,
      fileName: this._primaryFile(j.modelVersions?.[0]),
    };
  }

  _versionFromJson(v, levels) {
    const mask = bitmask(levels);
    const examples = (v.images || [])
      .filter((img) => (((img.nsfwLevel || 1) & mask) !== 0))
      .map((img) => this._fromRest({ ...img, url: img.url }));
    return {
      id: v.id, name: v.name || null, baseModel: v.baseModel || null,
      descriptionHtml: v.description || null,
      trainedWords: v.trainedWords || [], examples,
      downloadCount: v.stats?.downloadCount,
      fileName: this._primaryFile(v),
      // Downloadable files, kept for the Workflows "load onto canvas" path.
      // `format` rides in metadata (live shape: type:"Archive", metadata:{format:"Other"}).
      files: (v.files || []).map((f) => ({
        id: f.id, name: f.name || "", sizeKB: f.sizeKB ?? null,
        type: f.type || null, format: f.metadata?.format ?? null,
      })),
    };
  }

  /** Escape a string for use inside a quoted MeiliSearch filter value.
   *  Backslashes FIRST, then quotes — the other order would re-escape the
   *  quote escaping, letting a trailing `\` (or a crafted `\"`) break out of
   *  the quoted string and alter the filter. */
  static escapeMeili(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // ── public API ───────────────────────────────────────────────────────────
  async fetchFeed({ type = "image", period = "Week", sort = "Most Reactions", levels = [1], limit = 100, cursor, username } = {}) {
    const q = new URLSearchParams({
      limit: String(limit), browsingLevel: String(bitmask(levels)),
      period: normalizePeriod(period), type, sort: normalizeImageSort(sort), // #459: clamp to enum
    });
    if (username) q.set("username", username); // narrow to one creator's posts
    if (cursor) q.set("cursor", cursor);
    const data = await this._get(`${API}/v1/images?${q.toString()}`);
    return {
      items: (data.items || []).map((x) => this._fromRest(x)),
      nextCursor: data.metadata?.nextCursor || null,
    };
  }

  async fetchModelImages(modelVersionId, { levels = [1], sort = "Most Reactions", limit = 30 } = {}) {
    const q = new URLSearchParams({
      limit: String(limit), modelVersionId: String(modelVersionId),
      browsingLevel: String(bitmask(levels)), sort: normalizeImageSort(sort), // #459: clamp to enum
      nsfw: bitmask(levels) > 2 ? "X" : "None",
    });
    const data = await this._get(`${API}/v1/images?${q.toString()}`);
    return (data.items || []).map((x) => this._fromRest(x));
  }

  async searchMedia(query, { type = "image", levels = [1], limit = 100, offset = 0, username } = {}) {
    const filter = [`type = ${type}`, `nsfwLevel IN [${levels.join(", ")}]`];
    // Creator filter — the index exposes the author under `user.username`
    // (live-verified filterable on the mobile app). Quoted + escaped so any
    // legal username parses without breaking out of the filter string.
    if (username) filter.push(`user.username = "${CivitaiClient.escapeMeili(username)}"`);
    const data = await this._request({
      url: SEARCH_URL, method: "POST",
      // A Meili multi-search is a READ issued as a POST — flag it idempotent so
      // the #599 transport retry covers keyword media search too (a mutation
      // POST must never pass this flag).
      idempotent: true,
      headers: {
        authorization: `Bearer ${SEARCH_KEY}`,
        origin: "https://civitai.red",
        "x-meilisearch-client":
          "Meilisearch instant-meilisearch (v0.13.5) ; Meilisearch JavaScript (v0.34.0)",
      },
      body: { queries: [{ indexUid: "images_v6", q: query, limit, offset, filter }] },
    });
    return (data.results?.[0]?.hits || []).map((x) => this._fromMeili(x));
  }

  /** Toggle the signed-in user's "Like" on an image (tRPC reaction.toggle —
   *  the same mutation the CivitAI site fires; calling it again un-likes).
   *  Requires OAuth (auth: true). Returns the raw tRPC result. */
  async toggleReaction(imageId, reaction = "Like") {
    return this._request({
      url: `${API}/trpc/reaction.toggle`,
      method: "POST",
      body: { json: { entityType: "image", entityId: imageId, reaction } },
      auth: true,
    });
  }

  // ── collections (the "likes folder") ────────────────────────────────────
  /** The signed-in user's image collections they can add to. */
  async getUserCollections() {
    const enc = encodeURIComponent(JSON.stringify({ json: { permissions: ["ADD"], type: "Image" } }));
    const data = await this._get(`${API}/trpc/collection.getAllUser?input=${enc}`, { auth: true });
    const j = data.result?.data?.json;
    const list = Array.isArray(j) ? j : j?.collections || [];
    return list.map((c) => ({ id: c.id, name: c.name, type: c.type }));
  }

  /** Create a new (private) image collection and return {id, name}. */
  async createCollection(name) {
    const data = await this._request({
      url: `${API}/trpc/collection.upsert`,
      method: "POST",
      body: { json: { name, type: "Image", read: "Private", write: "Private" } },
      auth: true,
    });
    const j = data.result?.data?.json || {};
    return { id: j.id, name: j.name || name };
  }

  /** Add (or remove) an image in a collection — the like's "folder" side. */
  async setImageInCollection(imageId, collectionId, on = true) {
    return this._request({
      url: `${API}/trpc/collection.saveItem`,
      method: "POST",
      body: {
        json: on
          ? { imageId, collections: [{ collectionId }], type: "Image" }
          : { imageId, collections: [], removeFromCollectionIds: [collectionId], type: "Image" },
      },
      auth: true,
    });
  }

  /** The likes feed. When [collectionId] is set, reads that COLLECTION instead
   *  of the `reactions:['Like']` filter — this matters: the web's ❤ saves into
   *  the user's likes collection, while image REACTIONS only hold in-app hearts
   *  (live-verified on mobile: reactions had 17 items, the collection 700+).
   *
   *  CURSOR QUIRK (live-verified): `nextCursor` is the id of the FIRST item of
   *  the NEXT page, but the server's keyset WHERE is a STRICT `id < cursor` for
   *  the Newest sort — echoing it back silently drops one item per page
   *  boundary. We continue from the id of the LAST item we received and treat
   *  the server cursor purely as a has-more flag. */
  async fetchFavorites({ levels = [1, 2, 4, 8, 16], cursor, types, collectionId, sort = "Newest", period = "AllTime" } = {}) {
    const input = {
      json: {
        period, sort,
        ...(collectionId ? { collectionId } : { reactions: ["Like"] }),
        browsingLevel: bitmask(levels), cursor: cursor ?? null, authed: true,
        limit: 100,
        ...(Array.isArray(types) && types.length ? { types } : {}),
      },
    };
    if (cursor == null) input.meta = { values: { cursor: ["undefined"] } };
    const enc = encodeURIComponent(JSON.stringify(input));
    const data = await this._get(`${API}/trpc/image.getInfinite?input=${enc}`, { auth: true });
    const j = data.result?.data?.json || {};
    const raw = j.items || [];
    const items = raw.map((x) => this._fromMeili(x));
    const next = j.nextCursor ?? null;
    if (next == null) return { items, nextCursor: null };
    // The id-cursor workaround (continue from the last item's id, dodging the
    // boundary-skip) is only valid for the Newest sort's strict `id < cursor`
    // keyset. Other sorts key off a different column, so echo the server's own
    // nextCursor for them instead.
    const lastRawId = Number(raw[raw.length - 1]?.id) || 0;
    const useIdCursor = sort === "Newest" && lastRawId > 0;
    return { items, nextCursor: useIdCursor ? String(lastRawId) : String(next) };
  }

  async fetchModels({ type, sort = "Most Downloaded", period = null, baseModels = [], levels = [1], limit = 100, cursor, query, username } = {}) {
    const base = new URLSearchParams({
      limit: String(limit), types: type,
      // A keyword search must not silently narrow itself to the last week:
      // CivitAI intersects query with period, so use AllTime unless the caller
      // explicitly selected a period in the UI.
      sort: normalizeModelSort(sort), period: normalizePeriod(period || (query ? "AllTime" : "Week")), // #459: clamp to enum
      nsfw: bitmask(levels) > 2 ? "true" : "false",
    });
    for (const b of baseModels) base.append("baseModels", b);
    // API QUIRK (live-verified on mobile): /v1/models returns an EMPTY page
    // when BOTH `query` and `username` are sent — so with a creator picked,
    // send only `username` and match the keyword client-side below.
    const clientFilter = !!(query && username);
    if (query && !username) base.set("query", query);
    if (username) base.set("username", username);
    const kw = clientFilter ? String(query).toLowerCase() : null;
    let next = cursor || null;
    let models = [];
    // Accumulated across hops, so a search that chased several thin pages
    // reports everything the level filter removed, not just the last page's.
    let hiddenByLevel = 0;
    // An empty page with a cursor is not the end of a search: /v1/models can
    // thin pages server-side, and keyword×creator additionally filters them
    // client-side. Chase a bounded number of continuable empty pages.
    for (let hop = 0; ; hop++) {
      const q = new URLSearchParams(base);
      if (next) q.set("cursor", next);
      const data = await this._get(`${API}/v1/models?${q.toString()}`);
      const raw = data.items || [];
      models = raw.map((x) => this._modelFromJson(x, levels)).filter(Boolean);
      // #712 — how many CivitAI returned that the BROWSING LEVEL removed.
      // Counted HERE, before the keyword filter below: a keyword miss is "no
      // match", not "hidden by your level", and conflating them would tell the
      // user to widen a filter that was never the reason.
      hiddenByLevel += raw.length - models.length;
      if (kw) models = models.filter((m) => (m.name || "").toLowerCase().includes(kw));
      next = data.metadata?.nextCursor || null;
      if (models.length || !next || hop >= 4) break;
    }
    // hiddenByLevel is what makes an empty grid ATTRIBUTABLE (#190/#375): the
    // favorites tab already distinguishes "filtered out" from "genuinely empty";
    // the model tabs reported neither, so a browsing level that removed every
    // result was indistinguishable from "nothing matched your search".
    return { models, nextCursor: next, hiddenByLevel };
  }

  async fetchModelDetail(modelId, { levels = [1] } = {}) {
    const j = await this._get(`${API}/v1/models/${modelId}`);
    return {
      id: j.id, name: j.name, type: j.type,
      versions: (j.modelVersions || []).map((v) => this._versionFromJson(v, levels)),
      creator: j.creator?.username || null, descriptionHtml: j.description || null,
      downloadCount: j.stats?.downloadCount, thumbsUp: j.stats?.thumbsUpCount,
      tags: j.tags || [],
    };
  }

  // ── creators (leaderboard tRPC + /v1/creators search) ────────────────────
  /** The site's creator leaderboard (civitai.com/leaderboard, "Creators"
   *  board) via tRPC — the public v1 API exposes NO leaderboard ordering
   *  (/v1/creators is join-date ordered), so this mirrors the website's own
   *  request. The endpoint intermittently 401s bare user agents; the proxy's
   *  browser-shaped headers usually pass, but callers must degrade gracefully
   *  (the picker shows "Top creators unavailable right now"). */
  async fetchTopCreators({ limit = 25 } = {}) {
    const enc = encodeURIComponent(JSON.stringify({ json: { id: "overall" } }));
    const data = await this._get(`${API}/trpc/leaderboard.getLeaderboard?input=${enc}`);
    const entries = data.result?.data?.json;
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const e of entries) {
      const username = e?.user?.username;
      if (!username || e?.user?.deletedAt != null) continue;
      const metric = (t) =>
        Array.isArray(e.metrics) ? e.metrics.find((m) => m?.type === t)?.value ?? null : null;
      out.push({
        username, position: e.position ?? null, score: e.score ?? null,
        downloads: metric("downloadCount"), thumbsUp: metric("thumbsUpCount"),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Search creators by (partial) username via the public /v1/creators API.
   *  Unranked (join-date order) — for ranked names use fetchTopCreators. */
  async searchCreators(query, { limit = 20 } = {}) {
    const trimmed = String(query || "").trim();
    if (!trimmed) return [];
    const q = new URLSearchParams({ query: trimmed, limit: String(limit) });
    const data = await this._get(`${API}/v1/creators?${q.toString()}`);
    return (data.items || [])
      .filter((j) => j && j.username)
      .map((j) => ({ username: j.username, modelCount: j.modelCount ?? 0 }));
  }

  async getGenerationData(imageId) {
    const enc = encodeURIComponent(JSON.stringify({ json: { id: imageId } }));
    const data = await this._get(`${API}/trpc/image.getGenerationData?input=${enc}`);
    const j = data.result?.data?.json || {};
    return {
      meta: j.meta || {},
      hasComfyWorkflow: j.meta?.comfy != null,
      resourceCount: (j.resources || []).length,
    };
  }

  /** Classify a parsed graph object.
   *  "ui"  — litegraph/canvas format (top-level `nodes` array): loadable.
   *  "api" — prompt format (numeric keys, each with `class_type`): runnable by
   *          the backend but NOT loadable onto the canvas (same test the
   *          panel's graph_load uses; there is no client-side converter).
   *  "unknown" — neither (includes the empty `workflow: {}` civitai emits). */
  static workflowFormat(g) {
    if (!g || typeof g !== "object" || Array.isArray(g)) return "unknown";
    if (Array.isArray(g.nodes)) return "ui";
    const keys = Object.keys(g);
    if (
      keys.length > 0 &&
      keys.every((k) => /^\d+$/.test(k)) &&
      keys.some((k) => g[k] && typeof g[k] === "object" && "class_type" in g[k])
    ) return "api";
    return "unknown";
  }

  /** Best embedded ComfyUI graph from generation meta → {graph, format} | null.
   *  Live shapes (2026-07, tRPC image.getGenerationData):
   *    meta.comfy = { prompt: <api-format obj>, workflow: <ui obj with nodes[]> }
   *    meta.comfy = { prompt: <api-format obj>, workflow: {} }   ← EMPTY workflow
   *  plus the legacy shape where meta.comfy (or its fields) is a JSON string.
   *  Prefers a real UI graph; falls back to the API prompt (savable, not
   *  loadable); returns null when nothing parses — the old comfyGraph returned
   *  the truthy-but-empty `{}` here and lit the ✓ badge for nothing. */
  static comfyGraphInfo(meta) {
    if (!meta || meta.comfy == null) return null;
    const parse = (v) => {
      if (typeof v !== "string") return v;
      try { return JSON.parse(v); } catch { return null; }
    };
    const c = parse(meta.comfy);
    if (!c || typeof c !== "object") return null;
    const candidates = ("workflow" in c || "prompt" in c)
      ? [parse(c.workflow), parse(c.prompt)]
      : [c];
    let api = null;
    for (const g of candidates) {
      const format = CivitaiClient.workflowFormat(g);
      if (format === "ui") return { graph: g, format };
      if (format === "api" && !api) api = g;
    }
    return api ? { graph: api, format: "api" } : null;
  }

  /** Parse the embedded ComfyUI graph from generation meta (prefer UI-format). */
  static comfyGraph(meta) {
    return CivitaiClient.comfyGraphInfo(meta)?.graph ?? null;
  }

  // ── version-file workflows (Workflows tab "load onto canvas") ───────────
  /** Files of a model version worth offering as canvas workflows: raw .json
   *  always; .zip only on Workflows-type models (live sweep of 844 versions:
   *  780 zips / 77 raw .json — but a zip on a Checkpoint is training data).
   *  The download API addresses files by (type, format), NOT id — duplicates
   *  on that key are unreachable, so they're deduped away. */
  static workflowFiles(version, modelType) {
    const out = [];
    const seen = new Set();
    for (const f of version?.files || []) {
      const name = (f.name || "").toLowerCase();
      const isJson = name.endsWith(".json");
      const isZip = name.endsWith(".zip");
      if (!isJson && !(isZip && modelType === "Workflows")) continue;
      if (f.sizeKB != null && f.sizeKB > 100 * 1024) continue; // proxy cap is 100MB
      const key = `${f.type || ""}|${f.format || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  }

  /** Download a model-version file's raw bytes via the same-origin proxy
   *  (which follows civitai's 307 to the signed CDN URL server-side and
   *  attaches the OAuth token when signed in). Throws Error with `.status`
   *  on HTTP failure — 401/403 means the file needs a signed-in account. */
  async downloadVersionFile(versionId, { type, format } = {}) {
    const q = new URLSearchParams({ versionId: String(versionId) });
    if (type) q.set("type", type);
    if (format) q.set("format", format);
    const res = await this.api.fetchApi(`/comfyui_mcp_panel/civitai/download?${q.toString()}`);
    if (!res.ok) {
      // #705, second call site with the same swallow: `civitai download 502` told
      // the user nothing, while the proxy's reply says exactly what happened —
      // {"error":"sign-in required to download this file"} for a gated file, and
      // text/plain reasons from its own guards ("redirect target not allowed",
      // "file too large"). Same bounded, attributed treatment as _request.
      const upstream = describeUpstreamFailure({
        status: res.status,
        statusText: res.statusText,
        bodyText: await _readErrorBody(res),
        label: tr("civitai.civitai_download", "CivitAI download"),
      });
      throw Object.assign(new Error(upstream.message), {
        status: res.status,
        detail: upstream.detail,
        retryable: upstream.retryable,
      });
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  // ── minimal zip reader (for workflow archives) ──────────────────────────
  // Civitai wraps workflow uploads in small zips whose local headers use data
  // descriptors (sizes = 0), so entries MUST be walked via the central
  // directory. No dependency: DEFLATE entries inflate through the browser's
  // native DecompressionStream("deflate-raw").
  //
  // Zip-bomb caps: workflow archives are KB-sized, so anything past these is
  // not a workflow zip. Cap violations throw errors tagged `.zipCap = true`
  // (they must surface to the user, unlike a single unparseable entry, which
  // is merely skipped). Tests inject smaller caps.
  static get ZIP_CAPS() {
    return {
      entries: 512,                  // central-directory records
      entryBytes: 32 * 1024 * 1024,  // uncompressed, per entry
      totalBytes: 96 * 1024 * 1024,  // uncompressed, whole archive
    };
  }
  static _zipCapError(msg) {
    return Object.assign(new Error(msg), { zipCap: true });
  }

  /** List entries: [{name, method, cSize, uSize, lfhOff}]. Throws if not a
   *  zip or past the entry-count cap. Records whose spans run past the buffer
   *  stop the walk; duplicates aimed at the same local header are dropped
   *  (a bomb trick: many directory records sharing one compressed blob). */
  static zipEntries(bytes, caps = CivitaiClient.ZIP_CAPS) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // EOCD signature scan from the tail (comment may pad up to 64KB).
    let eocd = -1;
    const min = Math.max(0, bytes.length - 65558);
    for (let i = bytes.length - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    const count = dv.getUint16(eocd + 10, true);
    if (count > caps.entries) {
      throw CivitaiClient._zipCapError(`zip has too many entries (${count} > ${caps.entries})`);
    }
    let off = dv.getUint32(eocd + 16, true);
    const entries = [];
    const seenOff = new Set();
    const td = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (off + 46 > bytes.length || dv.getUint32(off, true) !== 0x02014b50) break;
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const cmtLen = dv.getUint16(off + 32, true);
      const end = off + 46 + nameLen + extraLen + cmtLen;
      if (end > bytes.length) break; // record claims bytes past the buffer
      const lfhOff = dv.getUint32(off + 42, true);
      if (!seenOff.has(lfhOff)) {
        seenOff.add(lfhOff);
        entries.push({
          name: td.decode(bytes.subarray(off + 46, off + 46 + nameLen)),
          method: dv.getUint16(off + 10, true),
          cSize: dv.getUint32(off + 20, true),
          uSize: dv.getUint32(off + 24, true),
          lfhOff,
        });
      }
      off = end;
    }
    return entries;
  }

  /** Locate an entry's raw compressed bytes in the buffer. The read offset is
   *  the LOCAL header (the only place we actually seek to), and the span
   *  length is the central-directory `cSize` — but that length is
   *  bounds-checked against `bytes.length` here, so a lying cSize can't point
   *  the slice out of bounds (it throws "bad zip entry" instead). */
  static _entryData(bytes, entry) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const o = entry.lfhOff;
    if (o + 30 > bytes.length || dv.getUint32(o, true) !== 0x04034b50) {
      throw new Error("bad zip entry");
    }
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    const start = o + 30 + nameLen + extraLen;
    if (start + entry.cSize > bytes.length) throw new Error("bad zip entry");
    return bytes.subarray(start, start + entry.cSize);
  }

  /** Inflate (or pass through) an entry to raw bytes, enforcing `cap` with a
   *  STREAMING byte counter — chunks are summed as they arrive and the stream
   *  is CANCELLED the instant the running total exceeds `cap`, so a falsified
   *  central-directory size can't make us materialize a giant buffer first.
   *  No declared size (uSize/cSize) is trusted for the limit; the counter is.
   *  Returns { bytes, byteLength } (byteLength counts ACTUAL decoded bytes). */
  static async _readEntryBytes(bytes, entry, cap) {
    const data = CivitaiClient._entryData(bytes, entry);
    if (entry.method === 0) {
      // STORE: compressed == uncompressed, already fully present in-buffer and
      // bounded by cSize ≤ buffer; still enforce the cap.
      if (data.byteLength > cap) throw CivitaiClient._zipCapError("zip entry too large to unpack");
      return { bytes: data, byteLength: data.byteLength };
    }
    if (entry.method !== 8) throw new Error(`unsupported zip compression (method ${entry.method})`);
    if (typeof DecompressionStream !== "function") {
      throw new Error("this browser can't inflate zip archives");
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        // abort mid-stream — never accumulate past the cap
        try { await reader.cancel(); } catch { /* already torn down */ }
        throw CivitaiClient._zipCapError("zip entry too large to unpack");
      }
      chunks.push(value);
    }
    // Peak memory here is ~2× the cap: the retained `chunks` (bounded to ≤ cap,
    // since we abort the instant `total` crosses it) plus the single contiguous
    // `out` copy we assemble from them. Bounded either way — no unbounded
    // buffer, no full-archive materialization.
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return { bytes: out, byteLength: total };
  }

  /** Read one zipEntries() entry as text (stored or DEFLATE), enforcing the
   *  per-entry uncompressed cap with a streaming byte counter (see
   *  _readEntryBytes) — a lying header can't expand unbounded. */
  static async zipReadText(bytes, entry, caps = CivitaiClient.ZIP_CAPS) {
    const { bytes: raw } = await CivitaiClient._readEntryBytes(bytes, entry, caps.entryBytes);
    return new TextDecoder().decode(raw);
  }

  /** Extract every parseable .json graph from zip bytes →
   *  [{name, graph, format}] (format per workflowFormat, "ui" first).
   *  Cap breaches (entry count, per-entry size, aggregate size) THROW with a
   *  clear message; an individually unparseable entry is merely skipped. The
   *  aggregate counter sums ACTUAL decoded bytes (not UTF-16 string length, so
   *  multibyte UTF-8 can't slip past the byte cap) and the per-entry read
   *  aborts streaming past its own cap before this ever sees a giant buffer. */
  static async workflowsFromZip(bytes, caps = CivitaiClient.ZIP_CAPS) {
    const out = [];
    let total = 0;
    for (const e of CivitaiClient.zipEntries(bytes, caps)) {
      if (!/\.json$/i.test(e.name) || /\/$/.test(e.name)) continue;
      // Cap the per-entry read to whatever aggregate budget REMAINS, so the
      // streaming counter also enforces the aggregate mid-inflation — an entry
      // that alone fits its own cap but would blow the archive total aborts
      // without materializing. min() keeps the per-entry cap when budget > it.
      const remaining = caps.totalBytes - total;
      const perEntryCap = Math.min(caps.entryBytes, Math.max(0, remaining));
      let read;
      try {
        read = await CivitaiClient._readEntryBytes(bytes, e, perEntryCap);
      } catch (err) {
        if (err && err.zipCap) {
          // distinguish the aggregate breach for a clearer message
          throw remaining < caps.entryBytes
            ? CivitaiClient._zipCapError("archive unpacks too large")
            : err;
        }
        continue; // undecodable entry — skip, don't fail the zip
      }
      total += read.byteLength;
      let graph;
      try { graph = JSON.parse(new TextDecoder().decode(read.bytes)); }
      catch { continue; } // unparseable entry — skip
      const format = CivitaiClient.workflowFormat(graph);
      if (format === "unknown") continue;
      out.push({ name: e.name, graph, format });
    }
    out.sort((a, b) => (a.format === b.format ? 0 : a.format === "ui" ? -1 : 1));
    return out;
  }

  /** Ordered generation params for the info panel. */
  static params(meta) {
    if (!meta) return [];
    const val = (v) => (v && typeof v === "object" && v.inputs ? v.inputs.value ?? "" : v);
    const rows = [
      ["Model", meta.Model], ["sampler", meta.sampler], ["scheduler", meta.scheduler],
      ["steps", meta.steps], ["cfg", meta.cfgScale], ["seed", meta.seed],
      ["denoise", meta.denoise],
      ["size", meta.width && meta.height ? `${coerceMessageText(val(meta.width))}×${coerceMessageText(val(meta.height))}` : null],
    ];
    // coerceMessageText (not String) so a structured param value can never become
    // "[object Object]" in the info panel or the outbound share-with-agent caption (#276).
    return rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, coerceMessageText(val(v))]);
  }
}
