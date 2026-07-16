/**
 * feedback.js — pure helpers for the "Share transcript" feedback feature.
 *
 * The panel offers a "Share transcript" action: the user rates the current
 * conversation ("this was good!" / "this was bad", plus an optional "why"),
 * and the FULL chat transcript + version info is POSTed to a maintainer-run
 * collector (a Cloudflare Worker that writes to S3 — see
 * workers/feedback-uploader/ in this repo). The labeled transcripts feed the
 * local-model fine-tune dataset.
 *
 * PRIVACY CONTRACT (enforced here, unit-tested in
 * browser_tests/unit/feedback.test.mjs):
 *   - No account identifiers are ever collected. The payload has no user id,
 *     no email, no hostname — only an anonymous random submission id.
 *   - Panel-internal credential material never leaves the machine: token-save
 *     cards are dropped from the transcript, bridge URLs (ws:// / wss://) are
 *     redacted, sensitive URL query values and recognizable API-key shapes
 *     are masked, and home-directory usernames in paths are stripped.
 *   - What the user themselves typed (and the agent replied) is included
 *     verbatim apart from the redactions above — that is the point of the
 *     feature, and the consent modal says so before anything uploads.
 *
 * This module is intentionally free of any ComfyUI / DOM / network imports so
 * it can be unit-tested under plain `node --test` and can never break the
 * extension loader with side effects. The panel bundle imports the builders
 * and does the actual fetch itself.
 *
 * @module feedback
 */

/** Payload schema tag — bump when the shape changes so the trainer can route. */
export const FEEDBACK_SCHEMA = "comfyui-mcp.feedback/1";

/** Hard cap on the serialized transcript (bytes of JSON, roughly chars).
 *  Newest messages win; a marker entry notes any trimming. Matches the
 *  collector Worker's 1 MiB body cap with generous headroom for the envelope. */
export const MAX_TRANSCRIPT_CHARS = 700_000;

/** Cap on the optional "why" free-text field. */
export const MAX_WHY_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

// Bridge/orchestrator endpoints ride ws:// or wss:// URLs (often carrying a
// ?token=…). Nothing about them is useful for training — drop them whole.
const RE_WS_URL = /\bwss?:\/\/[^\s"'<>)\]]+/gi;

// Sensitive query/fragment parameter VALUES inside any remaining URL-ish text
// (http(s) links to pods, consoles, pair landers, …). Keeps the URL readable,
// masks the credential.
const RE_SENSITIVE_PARAM =
  /([?&#](?:token|key|secret|signature|sig|apikey|api_key|access_token|auth|authorization|credential)s?=)[^&\s"'<>)\]]+/gi;

// "Bearer <credential>" in prose or quoted headers.
const RE_BEARER = /\b(bearer\s+)[a-z0-9._~+/=-]{8,}/gi;

// Bare "token=…" / "password: …" style assignments in prose, env snippets, or
// pasted config — not just inside URLs.
const RE_BARE_ASSIGN =
  /\b((?:token|secret|password|passwd|api_key|apikey|access_token)\s*[=:]\s*)[^\s"'&]+/gi;

// Recognizable API-key shapes (Anthropic, OpenAI, HuggingFace, GitHub, Slack,
// AWS access-key ids, Groq, Replicate, Google). Deliberately prefix-anchored
// so ordinary prose never matches.
const RE_KNOWN_SECRET =
  /\b(?:sk-ant-[a-z0-9_-]{8,}|sk-[a-z0-9_-]{16,}|hf_[a-z0-9]{16,}|gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,}|xox[abposr]-[a-z0-9-]{8,}|(?:akia|asia)[0-9a-z]{16}|gsk_[a-z0-9]{16,}|r8_[a-z0-9]{16,}|aiza[0-9a-z_-]{30,})\b/gi;

// Home-directory usernames in file-system paths (Windows and POSIX). The path
// tail is often useful signal ("…\models\checkpoints\x.safetensors"); only the
// username segment is identity, so only it is masked.
const RE_WIN_HOME = /([A-Za-z]:[\\/](?:Users|home)[\\/])([^\\/\s"'<>:|?*]+)/g;
const RE_POSIX_HOME = /(\/(?:home|Users)\/)([^/\s"'<>]+)/g;

/**
 * Redact credential material and identity fragments from one string.
 * Idempotent; never throws; non-strings pass through unchanged.
 * @param {unknown} text
 * @returns {unknown} the scrubbed string (or the input when not a string)
 */
export function scrubText(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(RE_WS_URL, "[bridge-url redacted]")
    .replace(RE_SENSITIVE_PARAM, "$1[redacted]")
    .replace(RE_BARE_ASSIGN, "$1[redacted]")
    .replace(RE_BEARER, "$1[redacted]")
    .replace(RE_KNOWN_SECRET, "[secret redacted]")
    .replace(RE_WIN_HOME, "$1[user]")
    .replace(RE_POSIX_HOME, "$1[user]");
}

// Record keys that are panel-internal plumbing, useless (or risky) to upload.
const DROP_KEYS = new Set(["mid", "rewindAnchor", "sessionId"]);

/** Deep-copy `value`, scrubbing every string and dropping plumbing keys. */
function deepScrub(value, depth = 0) {
  if (depth > 12) return undefined; // pathological nesting — cut it off
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) continue;
      const sv = deepScrub(v, depth + 1);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  }
  if (typeof value === "function") return undefined;
  return value;
}

/** True for thread records that must never upload at all: the in-chat token
 *  prompt cards (they render with the lock icon and hold masked credential
 *  previews — masked or not, they are credential UI, not conversation). */
function isSecretRecord(entry) {
  return !!entry && entry.role === "card" && entry.icon === "pi-lock";
}

/**
 * Turn the panel's persisted thread records into an upload-safe transcript:
 * token-prompt cards dropped, every string scrubbed, plumbing keys removed,
 * and the whole list size-capped from the OLD end (newest messages win).
 *
 * @param {unknown} msgs thread.msgs — [{role, text, …}] (see record() in the panel)
 * @param {{maxChars?: number}} [opts]
 * @returns {object[]} the scrubbed transcript, oldest first
 */
export function scrubTranscript(msgs, opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : MAX_TRANSCRIPT_CHARS;
  if (!Array.isArray(msgs)) return [];
  const clean = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    if (isSecretRecord(m)) continue;
    const scrubbed = deepScrub(m);
    if (scrubbed && typeof scrubbed.role === "string") clean.push(scrubbed);
  }
  // Budget from the end: keep the newest messages whole, drop the oldest.
  let used = 0;
  let start = clean.length;
  while (start > 0) {
    const cost = JSON.stringify(clean[start - 1]).length + 1;
    if (used + cost > maxChars) break;
    used += cost;
    start--;
  }
  const kept = clean.slice(start);
  if (start > 0) {
    kept.unshift({ role: "system", text: `[${start} earlier message(s) trimmed for size]` });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

function randomId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the arithmetic fallback below
  }
  // Non-secure-context fallback — uniqueness only, no identity.
  return `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function versionOrNull(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Build the complete upload payload. Pure: no network, no DOM. Throws
 * TypeError on an invalid verdict so a UI bug can't upload unlabeled data.
 *
 * @param {object} args
 * @param {"good"|"bad"} args.verdict user's rating
 * @param {string} [args.why] optional free-text reason
 * @param {unknown} args.msgs thread.msgs (raw panel records; scrubbed here)
 * @param {{model?: string, panel?: string, mcp?: string, backend?: string, comfyui?: string}} [args.versions]
 * @param {number} [args.now] epoch ms override (tests)
 * @returns {object} the JSON-serializable payload
 */
export function buildFeedbackPayload({ verdict, why, msgs, versions = {}, now } = {}) {
  if (verdict !== "good" && verdict !== "bad") {
    throw new TypeError(`verdict must be "good" or "bad", got ${JSON.stringify(verdict)}`);
  }
  const reason = typeof why === "string" ? scrubText(why.trim()).slice(0, MAX_WHY_CHARS) : "";
  return {
    schema: FEEDBACK_SCHEMA,
    id: randomId(),
    timestamp: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    verdict,
    ...(reason ? { why: reason } : {}),
    versions: {
      model: versionOrNull(versions.model),
      panel: versionOrNull(versions.panel),
      mcp: versionOrNull(versions.mcp),
      backend: versionOrNull(versions.backend),
      comfyui: versionOrNull(versions.comfyui),
    },
    transcript: scrubTranscript(msgs),
  };
}

// ---------------------------------------------------------------------------
// Modal state (pure, so the good/bad gating is unit-testable)
// ---------------------------------------------------------------------------

/**
 * Tiny state holder backing the Share-transcript modal: no verdict is
 * pre-selected, and submit stays disabled until the user explicitly picks
 * good or bad — unlabeled uploads are impossible by construction.
 * @returns {{ setVerdict(v: string): boolean, setWhy(t: string): void,
 *             verdict: "good"|"bad"|null, why: string, canSubmit: boolean }}
 */
export function createShareModalState() {
  let verdict = null;
  let why = "";
  return {
    /** @returns {boolean} whether the value was accepted */
    setVerdict(v) {
      if (v !== "good" && v !== "bad") return false;
      verdict = v;
      return true;
    },
    setWhy(t) {
      why = typeof t === "string" ? t : "";
    },
    get verdict() {
      return verdict;
    },
    get why() {
      return why;
    },
    get canSubmit() {
      return verdict === "good" || verdict === "bad";
    },
  };
}
