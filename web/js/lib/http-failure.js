// comfyui-mcp#828 (recurrence, 2026-08-21) — describe a ComfyUI HTTP route that
// answered NOT-OK, without pasting what answered into the agent's tool result.
//
// The report: on a remote target behind Cloudflare, immediately after a ComfyUI
// restart while the tab's backend socket was reconnecting, `panel_free_vram`
// surfaced the ENTIRE Cloudflare 502 error document — markup, Ray ID, client IP
// and all — because `free_vram` built its failure message as
//
//     `Failed to free VRAM: ${res.status} ${res.statusText} — ${await res.text()}`
//
// In the very same state `panel_graph_outline` reported `backend_socket:
// "reconnecting"`, because a `graph_*` command reaches the dispatcher branch that
// consults `comfyBackendIsDown()` (reconnect-recovery.js) and annotates its reply
// via `backendSocketReplyFields`. `free_vram` does not start with `graph_`, so it
// never enters that branch: it neither consults the socket fact the panel already
// knows nor has anything that looks at the response body. Two calls, one moment,
// one honest and one relaying a proxy's error page.
//
// ## What this module is, and is not
//
// It is the panel-side sibling of the orchestrator's `src/comfyui/json-guard.ts`
// (#1178), deliberately using the SAME classification vocabulary — `proxy-error`,
// `login`, `not-found`, `html-page`, `not-json` (plus `json-error`, which json-guard
// never needs because it only runs after a parse has already failed) — so the two
// runtimes name the
// same situation with the same word. It is NOT a second copy for its own sake:
// json-guard is Node/TypeScript inside the orchestrator process and cannot be
// reached from a browser executor, which is the only place that ever holds this
// `Response`. Anything added here should be added to json-guard's vocabulary too,
// and vice versa — one classification, two runtimes.
//
// ## The rules it follows
//
//   1. NEVER paste the body. A bounded, markup-stripped, secret-scrubbed prefix
//      is a diagnostic; the document is a context bomb and a credential risk
//      (json-guard's `bodyPrefixOf` records a gateway that REFLECTS the request
//      putting our own ComfyUI credential in the page it answers with).
//   2. NEVER swallow the failure. A body that is not the JSON this route
//      promises is information, and the status is always reported.
//   3. NEVER assert a cause the response does not carry. A status alone does not
//      prove who produced it, and the backend-socket state is stated only when
//      the caller passes the fact it observed — `undefined` says nothing.
//   4. NEVER claim the operation did or did not run, and never name a responder the
//      BODY does not name. ComfyUI runs on aiohttp, whose own error pages are HTML,
//      so neither a gateway-class status nor bare markup identifies a proxy.

/** Cap on the body prefix carried into a message. Diagnostic, not a document. */
export const HTTP_FAILURE_BODY_PREFIX_CAP = 200;

/** Reason phrases that add nothing beside the code they belong to. Mirrors
 *  json-guard's `describeStatus`: a CUSTOM phrase ("Origin warming up",
 *  "Backend read timeout") is often the most useful token in the response, a
 *  standard one is noise. */
const STANDARD_REASON_PHRASES = new Set([
  "ok",
  "bad request",
  "unauthorized",
  "forbidden",
  "not found",
  "method not allowed",
  "request timeout",
  "conflict",
  "payload too large",
  "unprocessable entity",
  "too many requests",
  "internal server error",
  "not implemented",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
]);

/** `502` or `503 Origin warming up` — the code, plus a reason phrase worth reading. */
export function describeHttpStatus(status, statusText) {
  const text = String(statusText ?? "").trim();
  if (!text) return String(status);
  if (STANDARD_REASON_PHRASES.has(text.toLowerCase())) return String(status);
  // A phrase is a short label, not a document; a long one is a body that escaped
  // into the status line. Scrubbed like the body — a hostile proxy writes this too.
  const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return `${status} ${scrubSecretShapedText(clipped)}`;
}

const REDACTED = "«redacted»";

/**
 * Redact credential-shaped text by SHAPE, not by known value.
 *
 * The panel does not hold the orchestrator's credential list, and a proxy can
 * percent-encode, case-fold or line-wrap whatever it echoes, so a blocklist of
 * known values would miss the reflected form anyway. Two passes:
 *
 *   - a labelled secret (`token=…`, `Authorization: Bearer …`), where the LABEL
 *     is the evidence and the value goes whatever it looks like;
 *   - a long opaque run (32+ chars of a base64/hex/JWT alphabet), which is what
 *     an unlabelled key or session id looks like. 32 is deliberately above the
 *     length of the identifiers an error page legitimately prints (a Cloudflare
 *     Ray ID is 16–20) so a useful diagnostic is not redacted into uselessness.
 *
 * A DELIMITER (`:` or `=`) is required for every labelled rule. Allowing a bare
 * space would turn "Authorization required" into "Authorization: «redacted»" and
 * "auth failed" into "auth: «redacted»" — destroying the diagnosis in the name of
 * protecting it. The one unlabelled-but-unambiguous form, `Bearer <token>`, gets
 * its own rule.
 *
 * `/` is excluded from the opaque-run alphabet so an ordinary URL on the page
 * survives: with it in, `//www.cloudflare.com/5xx-error-landing` is a 38-char run
 * and collapses to a redaction marker. Real credentials still have a 32+ run of
 * the remaining alphabet between any slashes.
 *
 * ## Why a SECRET label takes the whole line
 *
 * Shape cannot bound a secret's value, and three gate rounds proved it one
 * character at a time: `Bearer aaaa…\nbbbb…` wrapped past the first whitespace,
 * `…mnopqrst\nuvwx` ended in four letters that no shape rule separates from a
 * word, and `password:p@ssword` contains a character no credential alphabet
 * includes. Each fix bought one case. So a SECRET label stops trying: everything
 * after the delimiter to the end of the line goes, plus any wrapped continuation
 * on the lines below (a wrap has no space before the break, so a following run of
 * credential characters is the same token).
 *
 * That is json-guard's rule too — fail closed, VISIBLY. The reader still sees
 * `password: «redacted»` and knows exactly what was withheld and where, which is
 * why an over-broad redaction here costs far less than one leaked credential in
 * text a user pastes into a public issue. The price is real and accepted:
 * `Authorization: this endpoint requires a key` loses its sentence.
 *
 * ADDRESS labels are NOT secrets and keep the bounded form. They exist for the
 * CDN convention of printing the viewer's own address ("Your IP: …", which the
 * reported Cloudflare 502 carries) — PII in text destined for a bug report, but
 * not a credential, so taking the rest of the line would eat the page's own
 * footer for nothing. A BARE address is left alone entirely: an nginx body's
 * `upstream: http://127.0.0.1:8188` is often the most useful token on the page.
 */
const SECRET_LABELS =
  "authorization|auth|bearer|token|access[-_]?token|api[-_]?key|apikey|secret|password|passwd|pwd" +
  "|session[-_]?id|sessionid|set-cookie|cookie";
const ADDRESS_LABELS = "your ip|client ip|remote ip|remote addr|x-forwarded-for";
/** A value that arrived LINE-WRAPPED continues on the next line with no space
 *  before the break, so the continuation line is the same token. Applied after
 *  a to-end-of-line secret redaction. */
const WRAP_CONT = `(?:[\\r\\n]+[ \\t]*[^\\r\\n]+)*`;

export function scrubSecretShapedText(text) {
  // To END OF LINE — see the docblock. `[^\r\n]*` deliberately admits every
  // character, including the `@`, `!` and spaces a real password contains.
  const secret = new RegExp(`\\b(${SECRET_LABELS})\\b\\s*[:=][^\\r\\n]*${WRAP_CONT}`, "gi");
  const scheme = new RegExp(`\\b(bearer|basic)\\s+\\S{8,}[^\\r\\n]*${WRAP_CONT}`, "gi");
  const address = new RegExp(
    `\\b(${ADDRESS_LABELS})\\b\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|\\S+)`,
    "gi",
  );
  return String(text ?? "")
    .replace(secret, (_m, label) => `${label}: ${REDACTED}`)
    .replace(scheme, (_m, s) => `${s} ${REDACTED}`)
    .replace(address, (_m, label) => `${label}: ${REDACTED}`)
    .replace(/[A-Za-z0-9_\-+=.]{32,}/g, REDACTED);
}

/**
 * A short, single-line, markup-free, secret-scrubbed prefix of a response body.
 *
 * `<script>`/`<style>` contents are dropped whole rather than tag-stripped: their
 * text is code, not a message, and a minified bundle would eat the entire cap
 * before the page said anything.
 */
export function httpBodyPrefix(body) {
  const raw = String(body ?? "");
  if (raw.trim() === "") return "(empty)";
  const text = scrubSecretShapedText(
    raw
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&(?:nbsp|bull|middot);/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'"),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "(no readable text)";
  // Sliced on CODE POINTS, not code units: a code-unit slice can end on a lone
  // high surrogate and put a replacement character in the message.
  const points = [...text];
  return points.length > HTTP_FAILURE_BODY_PREFIX_CAP
    ? `${points.slice(0, HTTP_FAILURE_BODY_PREFIX_CAP).join("")}…`
    : text;
}

/**
 * Markers that IDENTIFY a responder — vendor and server names only.
 *
 * The generic status phrases ("bad gateway", "gateway timeout", "error code
 * 502") were removed after codex gate round 2: ComfyUI runs on aiohttp, whose
 * OWN default error page is `<html><head><title>502 Bad Gateway</title>…`, so
 * matching the phrase attributed ComfyUI's own error document to a proxy that
 * was not there. A product name in the body is evidence; the English for the
 * status code is not.
 */
const PROXY_MARKERS =
  /\b(cloudflare|cf-ray|nginx|openresty|traefik|envoy|haproxy|varnish|squid|gunicorn|amazon cloudfront|akamai)\b/i;
/**
 * A sign-in page SHAPE. Enough to CLASSIFY the response as an auth gate; not
 * enough to say who runs it. An operator who put their own auth layer in front
 * of ComfyUI serves a page matching every one of these — which is exactly what
 * the `login` cause text already hedges (codex gate).
 */
const LOGIN_MARKERS =
  /(<input[^>]+type=["']?password|name=["']?password|\bsign[ -]?in\b|\blog[ -]?in\b|\bsso\b)/i;
/**
 * A NAMED identity product — the subset that actually identifies a responder,
 * and therefore the only login evidence allowed to carry an attribution.
 */
const LOGIN_VENDOR_MARKERS =
  /\b(cloudflare access|okta|auth0|keycloak|onelogin|ping ?identity|entra|azure ad|adfs|oauth2[-_ ]?proxy|authelia|authentik)\b/i;

function looksLikeHtml(body) {
  const head = String(body ?? "").trimStart().slice(0, 512).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || /<(html|head|body|div|title)\b/.test(head);
}

/** The body parsed as a JSON document, or null. */
function parsedJsonBody(body) {
  const text = String(body ?? "").trim();
  if (text === "" || !/^[[{"]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The message a JSON error document carries, under any of the keys this
 *  codebase's servers actually use. Bounded and scrubbed like any other body
 *  text — a JSON envelope is not a promise that the value is safe to print. */
function jsonErrorMessage(parsed) {
  if (parsed == null || typeof parsed !== "object") return "";
  for (const key of ["error", "message", "detail", "reason"]) {
    const v = parsed[key];
    if (typeof v === "string" && v.trim()) return httpBodyPrefix(v);
    if (v && typeof v === "object" && typeof v.message === "string" && v.message.trim()) {
      return httpBodyPrefix(v.message);
    }
  }
  return "";
}

/**
 * What answered instead of the ComfyUI HTTP API.
 *
 * A PARSING JSON BODY IS CHECKED FIRST, and it ends the question (codex gate,
 * round 1, both P1s). The orchestrator's `json-guard` only ever runs AFTER a
 * JSON parse has already failed; this helper is called on ANY not-ok response,
 * so it sees inputs json-guard never does. Without this branch a ComfyUI `503
 * {"error":"busy"}` or a `401 {"error":"Unauthorized"}` from ComfyUI's own auth
 * layer was classified by STATUS alone as a gateway page or an identity proxy,
 * and told the caller the answer "did not come from ComfyUI". Blaming a proxy
 * that is not there is the same wrong-diagnosis failure this issue is about.
 *
 * After that: BODY EVIDENCE OUTRANKS STATUS, and a confirmed proxy page outranks
 * a status-only auth guess — the same precedence json-guard settled on, for the
 * same reason: an nginx 502 whose footer links to a login page is the proxy
 * failure it is, not an auth gate.
 *
 * @returns {"json-error"|"proxy-error"|"login"|"not-found"|"html-page"|"not-json"}
 */
export function classifyHttpFailure({ status, body = "" } = {}) {
  // `contentType` is deliberately NOT read here. A declared type is a CLAIM; only
  // the body is evidence. The disagreement between the two is reported by
  // `causeOf`, which is where a claim belongs — as a remark, not a verdict.
  if (parsedJsonBody(body) !== null) return "json-error";
  const html = looksLikeHtml(body);
  const proxyPage = html && PROXY_MARKERS.test(body);
  const loginPage = html && LOGIN_MARKERS.test(body);
  const gatewayStatus = status === 502 || status === 503 || status === 504;
  if (proxyPage || (gatewayStatus && !loginPage)) return "proxy-error";
  if (loginPage || status === 401 || status === 403) return "login";
  if (status === 404 && html) return "not-found";
  if (html) return "html-page";
  return "not-json";
}

/**
 * True only when the BODY NAMES a responder that is not ComfyUI.
 *
 * Keyed on the marker, never on the kind and never on "the body is HTML" (codex
 * gate, rounds 1 and 2). A bare 502 with an empty body is equally consistent
 * with ComfyUI crashing mid-response; a bare 403 is equally consistent with
 * ComfyUI behind the operator's own auth layer; and a generic
 * `<html><body>error</body></html>` on a 502 is equally consistent with
 * aiohttp's own default error page, which ComfyUI serves. All of those still say
 * what was seen — they must not say where it came from.
 *
 * A PRODUCT NAME is such a naming — `cloudflare`, `nginx`, `okta`, `authelia`.
 * A generic sign-in FORM is not (codex gate): an operator's own auth layer in
 * front of ComfyUI serves a page matching every generic marker, so a password
 * field cannot carry the sentence either. Only a named product can.
 */
function answeredBySomethingElse(body) {
  if (!looksLikeHtml(body)) return false;
  return PROXY_MARKERS.test(String(body)) || LOGIN_VENDOR_MARKERS.test(String(body));
}

function causeOf(kind, status, body, contentType = "") {
  const claimsHtml = /\b(text\/html|application\/xhtml\+xml)\b/i.test(String(contentType));
  switch (kind) {
    case "json-error": {
      // The route answered with a JSON document, which is what the ComfyUI API
      // does when it rejects a request. Report the status and what it said; do
      // not speculate about who sent it.
      const said = jsonErrorMessage(parsedJsonBody(body));
      return said
        ? `the route answered with a JSON error document saying: ${said}`
        : "the route answered with a JSON document rather than the success this call expects; the status is what it is reporting";
    }
    case "proxy-error":
      return PROXY_MARKERS.test(String(body ?? ""))
        ? "a reverse proxy or gateway in front of ComfyUI returned its OWN error page (its markers are in the body) — the proxy is reachable but could not get an answer out of ComfyUI"
        : `a gateway-class status (${status}) came back without a page identifying who sent it. A reverse proxy typically answers this way when ComfyUI has crashed, is restarting, or is otherwise unreachable — but ComfyUI itself can answer a ${status} too, and nothing in this response distinguishes them`;
    case "login":
      return LOGIN_MARKERS.test(String(body ?? ""))
        ? "an authentication gate answered with a SIGN-IN PAGE rather than letting the request through. " +
          "An identity proxy such as Cloudflare Access or an SSO portal serves exactly this, and so does an " +
          "auth layer the operator put in front of ComfyUI themselves; the page does not distinguish them" +
          (LOGIN_VENDOR_MARKERS.test(String(body ?? "")) ? ", though it does name an identity product" : "")
        : `the request was rejected with ${status} and the body is not JSON; that is most often an identity proxy or sign-in gate in front of ComfyUI, though ComfyUI behind your own auth layer can return it too, and this response does not distinguish them`;
    case "not-found":
      return "whatever is answering this host does not serve that route at all — the usual candidates are a reverse proxy that forwards the ComfyUI UI but not its API routes, and a base URL pointing somewhere other than the ComfyUI API root";
    case "html-page":
      return "some HTTP responder other than the ComfyUI API answered this route with a web page; this body alone does not identify which. The usual candidates are the ComfyUI frontend's catch-all, a reverse proxy that forwards the UI but not the API, and a maintenance or WAF page";
    default:
      return String(body ?? "").trim() === ""
        ? `NOTHING was sent back — the response carried no body at all, so the ${status} status is the entire message, and it does not identify what produced it`
        : "the body is not markup and is not the JSON this route promises" +
            (claimsHtml
              ? ", although the response DECLARES itself text/html — the declaration and the body disagree, so neither settles what answered"
              : "") +
            "; it is consistent with ComfyUI itself answering an error, with a truncated response, and with a responder that is not the ComfyUI API, and nothing here distinguishes them";
  }
}

/**
 * The one place a panel executor turns a not-ok `Response` into agent-visible text.
 *
 * @param {{
 *   what: string,                  // what the caller was doing, e.g. "free VRAM"
 *   route: string,                 // e.g. "POST /free"
 *   status: number,
 *   statusText?: string,
 *   contentType?: string,
 *   body?: string,
 *   outcomeUnknownNote?: string,   // what the caller can say about its own operation
 *   backendReconnecting?: boolean, // ONLY pass the fact you observed; omit if unknown
 * }} o
 */
export function describeHttpFailure({
  what,
  route,
  status,
  statusText,
  contentType = "",
  body = "",
  outcomeUnknownNote = "",
  backendReconnecting,
} = {}) {
  const kind = classifyHttpFailure({ status, body });
  const parts = [
    `Failed to ${what}: ${route} answered ${describeHttpStatus(status, statusText)} — ${causeOf(kind, status, body, contentType)}.`,
  ];
  if (answeredBySomethingElse(body)) {
    parts.push(
      `This answer did not come from ComfyUI, so it reports on whatever produced it and NOT on the request: ` +
        `whether the request reached ComfyUI at all is not established here.`,
    );
  }
  if (outcomeUnknownNote) parts.push(outcomeUnknownNote);
  // #3 — state the socket only when the caller passed the fact it observed.
  // `undefined` is unknown and stays unsaid; inferring "reconnecting" from a 502
  // would be exactly the diagnosis this issue is about, pointed the other way.
  if (backendReconnecting === true) {
    parts.push(
      `This tab's ComfyUI backend socket is ALSO down right now (a restart or reconnect is in ` +
        `progress) — the same fact panel_graph_outline reports as backend_socket:"reconnecting". ` +
        `Wait for it to reconnect, then retry.`,
    );
  } else if (backendReconnecting === false) {
    parts.push(
      `This tab's ComfyUI backend socket is currently OPEN, so a restart/reconnect window does not ` +
        `explain this — look at whatever sits between this browser and ComfyUI.`,
    );
  }
  parts.push(
    `Content-Type: ${contentType ? scrubSecretShapedText(String(contentType)) : "(none)"}. ` +
      `Body starts: ${httpBodyPrefix(body)}`,
  );
  return parts.join(" ");
}
