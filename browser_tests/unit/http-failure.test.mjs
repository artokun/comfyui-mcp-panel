// comfyui-mcp#828 (recurrence 2026-08-21) — a panel executor must never paste a
// response body into the agent's tool result, and `free_vram` must report the
// backend-socket fact the panel already knows.
//
// The report: on a remote target behind Cloudflare, immediately after a ComfyUI
// restart while the tab's backend socket was reconnecting, `panel_free_vram`
// surfaced the ENTIRE Cloudflare 502 error document. In the same state
// `panel_graph_outline` reported `backend_socket:"reconnecting"` — because a
// `graph_*` command reaches the dispatcher branch that consults
// `comfyBackendIsDown()`, and `free_vram` does not.
//
// What is locked here:
//   1. The classifier NAMES what answered and never ships the document.
//   2. It never asserts the socket state it was not told (the #796
//      unknown-collapse discipline: an unpassed fact stays unsaid).
//   3. It never claims the operation did or did not run.
//   4. ADOPTION IS COUNTED, not spot-checked. Every site in the shipped bundle
//      that captures a response body is enumerated, and none of them may
//      interpolate that body into an Error unless it goes through
//      `describeHttpFailure`. A per-site test passes while a NEW bypass ships;
//      the count is what fails. The scanner is itself verified against the
//      pre-fix `free_vram` source, so a scanner that silently stopped matching
//      cannot report a clean sweep.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  classifyHttpFailure,
  describeHttpFailure,
  describeHttpStatus,
  httpBodyPrefix,
  scrubSecretShapedText,
  HTTP_FAILURE_BODY_PREFIX_CAP,
} from "../../web/js/lib/http-failure.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** The reported document, in the shape Cloudflare actually serves it. */
const CLOUDFLARE_502 = `<!DOCTYPE html>
<html class="no-js" lang="en-US">
<head>
<title>comfy.example.net | 502: Bad gateway</title>
<meta charset="UTF-8" />
<meta name="robots" content="noindex, nofollow" />
<link rel="stylesheet" id="cf_styles-css" href="/cdn-cgi/styles/main.css" />
<style>body{font-family:system-ui}.cf-error-details{padding:0}</style>
<script>window.__CF$cv$params={r:'9c7fd0a1e4b23f10',t:'MTc2NzIyMzYwMC4wMDAwMDA='};</script>
</head>
<body>
<div id="cf-wrapper"><div id="cf-error-details">
<h1><span>Bad gateway</span><span class="code-label">Error code 502</span></h1>
<div>Visit <a href="https://www.cloudflare.com/5xx-error-landing">cloudflare.com</a> for more information.</div>
<p><span>Cloudflare Ray ID: <strong>9c7fd0a1e4b23f10</strong></span>
<span id="cf-footer-item-ip">Your IP: 203.0.113.42</span>
<span>Performance &amp; security by <a href="https://www.cloudflare.com/">Cloudflare</a></span></p>
</div></div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// 1. The classification
// ---------------------------------------------------------------------------

test("a Cloudflare 502 page is classified as a proxy error, not as ComfyUI", () => {
  assert.equal(
    classifyHttpFailure({ status: 502, contentType: "text/html; charset=UTF-8", body: CLOUDFLARE_502 }),
    "proxy-error",
  );
});

test("body evidence outranks status: a gateway page that links a sign-in stays a proxy error", () => {
  const nginxWithLoginFooter = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head>
    <body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx/1.24.0</center>
    <p>Need access? <a href="/login">Sign in</a></p></body></html>`;
  assert.equal(classifyHttpFailure({ status: 502, body: nginxWithLoginFooter }), "proxy-error");
});

test("a sign-in page on a 200 is a login gate", () => {
  const sso = `<!DOCTYPE html><html><head><title>Sign in</title></head><body>
    <form action="/login"><input type="password" name="password"></form></body></html>`;
  assert.equal(classifyHttpFailure({ status: 200, body: sso }), "login");
});

test("a plain-text 500 is NOT blamed on a proxy — it can be ComfyUI itself", () => {
  const kind = classifyHttpFailure({ status: 500, contentType: "text/plain", body: "CUDA out of memory" });
  assert.equal(kind, "not-json");
  const msg = describeHttpFailure({
    what: "free VRAM",
    route: "POST /free",
    status: 500,
    contentType: "text/plain",
    body: "CUDA out of memory",
  });
  assert.doesNotMatch(msg, /did not come from ComfyUI/);
  assert.match(msg, /CUDA out of memory/);
});

// codex gate round 1, both P1s: this helper runs on ANY not-ok response, unlike
// the orchestrator's json-guard which only runs after a JSON parse has already
// failed. A JSON body must therefore end the question before any status rule.

test("a ComfyUI 503 with a JSON body is NOT blamed on a gateway", () => {
  const body = '{"error":"busy"}';
  assert.equal(classifyHttpFailure({ status: 503, body }), "json-error");
  const msg = describeHttpFailure({
    what: "free VRAM",
    route: "POST /free",
    status: 503,
    contentType: "application/json",
    body,
  });
  assert.doesNotMatch(msg, /did not come from ComfyUI/i);
  assert.doesNotMatch(msg, /reverse proxy|gateway-class/i);
  assert.match(msg, /JSON error document saying: busy/);
});

test("a ComfyUI 401 with a JSON body is NOT blamed on an identity proxy", () => {
  const body = '{"error":"Unauthorized"}';
  assert.equal(classifyHttpFailure({ status: 401, body }), "json-error");
  const msg = describeHttpFailure({ what: "free VRAM", route: "POST /free", status: 401, body });
  assert.doesNotMatch(msg, /did not come from ComfyUI/i);
  assert.doesNotMatch(msg, /identity proxy|sign-in|SSO/i);
  assert.match(msg, /Unauthorized/);
});

// codex gate round 2, P1: ComfyUI runs on aiohttp, whose OWN default error page
// is `<html><head><title>502 Bad Gateway</title>…`. Neither a gateway-class
// status nor bare markup identifies a proxy.
test("aiohttp's own error page is not attributed to a proxy that is not there", () => {
  for (const body of [
    "<html><body>error</body></html>",
    "<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>",
  ]) {
    const msg = describeHttpFailure({ what: "free VRAM", route: "POST /free", status: 502, body });
    assert.doesNotMatch(
      msg,
      /did not come from ComfyUI/i,
      `generic HTML must not name a responder: ${body.slice(0, 40)}`,
    );
    assert.match(msg, /\b502\b/);
  }
  // A body that NAMES one still does.
  const nginx = "<html><head><title>502</title></head><body><center>nginx/1.24.0</center></body></html>";
  assert.match(describeHttpFailure({ what: "free VRAM", route: "POST /free", status: 502, body: nginx }),
    /did not come from ComfyUI/i);
});

// codex gate: a generic sign-in page identifies an auth gate, not a RESPONDER.
// An operator's own auth layer in front of ComfyUI serves exactly such a page.
test("a generic sign-in page does not name a responder; a product does", () => {
  const generic =
    '<html><head><title>Sign in</title></head><body><form action="/login">' +
    '<input type="password" name="password"></form></body></html>';
  const msgGeneric = describeHttpFailure({ what: "free VRAM", route: "POST /free", status: 401, body: generic });
  assert.equal(classifyHttpFailure({ status: 401, body: generic }), "login", "still classified as an auth gate");
  assert.doesNotMatch(msgGeneric, /did not come from ComfyUI/i);
  assert.match(msgGeneric, /does not distinguish them/i);

  const named = generic.replace("Sign in", "Sign in with Okta");
  const msgNamed = describeHttpFailure({ what: "free VRAM", route: "POST /free", status: 401, body: named });
  assert.match(msgNamed, /did not come from ComfyUI/i);
  assert.match(msgNamed, /does name an identity product/i);
});

test("a line-wrapped credential does not leak its continuation", () => {
  const wrapped =
    "Authorization: Bearer aaaaaaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbbbbbb rejected";
  const scrubbed = scrubSecretShapedText(wrapped);
  assert.doesNotMatch(scrubbed, /aaaaaaaaaaaaaaaaaaaa/);
  assert.doesNotMatch(scrubbed, /bbbbbbbbbbbbbbbbbbbb/, "the wrapped continuation leaked");
  // …and through the body path, where whitespace collapsing happens too.
  const viaBody = httpBodyPrefix(`<html><body>invalid request: ${wrapped}</body></html>`);
  assert.doesNotMatch(viaBody, /bbbbbbbbbbbbbbbbbbbb/);
  // Ordinary prose after a labelled value keeps its words.
  // An ADDRESS label is not a secret and stays bounded, so the page's own footer
  // survives next to it.
  assert.match(
    scrubSecretShapedText("Your IP: 203.0.113.42 Performance & security by Cloudflare"),
    /Performance & security by Cloudflare/,
  );
});

test("a short all-letter wrapped fragment is consumed too", () => {
  // codex gate: shape cannot separate the TAIL of a token from a word — both can
  // be four letters. The SEPARATOR is the evidence: a newline right after a
  // credential value is a wrap, a space is a word break.
  const wrapped = "Authorization: Bearer abcdefghijklmnopqrst\nuvwx";
  const scrubbed = scrubSecretShapedText(wrapped);
  assert.doesNotMatch(scrubbed, /abcdefghijklmnopqrst/);
  assert.doesNotMatch(scrubbed, /uvwx/, "the short wrapped fragment leaked");
  assert.doesNotMatch(httpBodyPrefix(`<html><body>${wrapped}</body></html>`), /uvwx/);
});

// codex gate: shape cannot bound a secret's VALUE at all — a password contains
// characters no credential alphabet lists, and can contain spaces. A SECRET
// label therefore takes the rest of its line, and the wrapped continuation too.
test("a secret label fails closed to the end of its line", () => {
  for (const [input, mustNotContain] of [
    ["password:p@ssword", "p@ss"],
    ["password: my secret", "my secret"],
    ["Set-Cookie: session=abc123; Path=/; HttpOnly", "abc123"],
    ["api_key: sk!live!8fbc 21aa 77de", "77de"],
  ]) {
    const out = scrubSecretShapedText(input);
    assert.doesNotMatch(out, new RegExp(mustNotContain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), input);
    assert.match(out, /«redacted»/, input);
  }
  // A label WITHOUT a delimiter is prose and is left completely alone — that is
  // what keeps the prefix worth printing.
  assert.equal(scrubSecretShapedText("Authorization required"), "Authorization required");
  assert.equal(scrubSecretShapedText("auth failed for user"), "auth failed for user");
  assert.equal(scrubSecretShapedText("Bearer token required"), "Bearer token required");
  // …and so is an nginx upstream line, the most useful token on such a page.
  const upstream = "connect() failed while connecting to upstream: http://127.0.0.1:8188/free";
  assert.equal(scrubSecretShapedText(upstream), upstream);
});

test("the body prefix is cut on code points, never inside a surrogate pair", () => {
  const emoji = "🧪".repeat(HTTP_FAILURE_BODY_PREFIX_CAP + 40);
  const prefix = httpBodyPrefix(emoji);
  assert.doesNotMatch(prefix, /�/, "a replacement character means the cut split a pair");
  assert.equal([...prefix].length, HTTP_FAILURE_BODY_PREFIX_CAP + 1); // + the ellipsis
});

test("a status-only verdict asserts nothing about WHO answered", () => {
  // A bare 502 with no page is equally consistent with ComfyUI crashing
  // mid-response; a bare 403 with no page is equally consistent with ComfyUI
  // behind the operator's own auth layer.
  for (const status of [502, 403]) {
    const msg = describeHttpFailure({ what: "free VRAM", route: "POST /free", status, body: "" });
    assert.doesNotMatch(
      msg,
      /did not come from ComfyUI/i,
      `status ${status} with no body must not name a responder`,
    );
    assert.match(msg, new RegExp(String(status)));
  }
  // …while a page that CARRIES the markers still does.
  assert.match(cloudflareMessage(), /did not come from ComfyUI/i);
});

test("a declared text/html that is not markup does not become an HTML verdict", () => {
  assert.equal(
    classifyHttpFailure({ status: 500, contentType: "text/html", body: "boom" }),
    "not-json",
  );
});

// ---------------------------------------------------------------------------
// 2. The message: honest, bounded, and free of the document
// ---------------------------------------------------------------------------

function cloudflareMessage(extra = {}) {
  return describeHttpFailure({
    what: "free VRAM",
    route: "POST /free",
    status: 502,
    statusText: "Bad Gateway",
    contentType: "text/html; charset=UTF-8",
    body: CLOUDFLARE_502,
    outcomeUnknownNote:
      "Nothing in this response shows models were unloaded, and nothing in it shows they were not — the outcome is genuinely UNKNOWN, so the safe working assumption is that the unload did not happen. /free is idempotent, so re-issuing it once ComfyUI answers again cannot double-apply anything and is the right next step.",
    ...extra,
  });
}

test("the proxy document never reaches the caller", () => {
  const msg = cloudflareMessage();
  assert.doesNotMatch(msg, /<!DOCTYPE/i, "the document leaked");
  assert.doesNotMatch(msg, /<\/?(html|head|body|div|span|script|style|link|meta)\b/i, "markup leaked");
  assert.doesNotMatch(msg, /203\.0\.113\.42/, "the client IP leaked");
});

test("the message length does not grow with the body — a 500 KB page is not a context bomb", () => {
  // The invariant is INDEPENDENCE, not "shorter than this fixture": a real
  // Cloudflare page is kilobytes and an SPA index.html can be megabytes, so
  // comparing against one small sample would pass while the body still rode along.
  const huge = CLOUDFLARE_502.replace("</body>", `<p>${"padding ".repeat(80000)}</p></body>`);
  assert.ok(huge.length > 500_000, "fixture must actually be large");
  const small = cloudflareMessage({ backendReconnecting: true });
  const large = cloudflareMessage({ body: huge, backendReconnecting: true });
  // Bounded ABSOLUTELY: fixed prose + one capped prefix, whatever the body was.
  assert.ok(large.length < 2000, `message was ${large.length} chars for a ${huge.length}-char body`);
  // And bounded RELATIVELY: 500 KB of extra body may move the message by at most
  // the ellipsis the cap adds, never by the padding itself.
  assert.ok(
    Math.abs(large.length - small.length) <= 4,
    `500 KB of body moved the message by ${large.length - small.length} chars`,
  );
  assert.doesNotMatch(large, /padding padding/);
});

test("the failure is NAMED, not swallowed", () => {
  const msg = cloudflareMessage();
  assert.match(msg, /Failed to free VRAM/);
  assert.match(msg, /POST \/free/);
  assert.match(msg, /\b502\b/);
  assert.match(msg, /reverse proxy or gateway/i);
  // A prefix of the page is still carried — it is what lets a human recognise
  // the page that answered.
  assert.match(msg, /Body starts:/);
  assert.match(msg, /502: Bad gateway|Bad gateway/i);
});

test("it never claims the free ran, or that it did not", () => {
  const msg = cloudflareMessage();
  assert.doesNotMatch(msg, /\bfreed\b/i, "it must not report a success it did not observe");
  assert.match(msg, /the outcome is genuinely UNKNOWN/);
  assert.match(msg, /whether the request reached ComfyUI at all is not established/i);
  assert.match(msg, /idempotent/);
});

test("the reconnecting state is stated only when it was OBSERVED", () => {
  const unknown = cloudflareMessage(); // backendReconnecting omitted
  assert.doesNotMatch(
    unknown,
    /reconnect/i,
    "an unpassed socket fact must stay unsaid — inferring it from a 502 is the same wrong diagnosis, reversed",
  );

  const down = cloudflareMessage({ backendReconnecting: true });
  assert.match(down, /backend socket is ALSO down/i);
  assert.match(down, /backend_socket:"reconnecting"/);

  const up = cloudflareMessage({ backendReconnecting: false });
  assert.match(up, /backend socket is currently OPEN/i);
  assert.doesNotMatch(up, /ALSO down/i);
});

test("an empty body is its own observation, not a generic parse complaint", () => {
  const msg = describeHttpFailure({ what: "free VRAM", route: "POST /free", status: 504, body: "" });
  assert.match(msg, /Body starts: \(empty\)/);
  assert.match(msg, /\b504\b/);
});

test("the body prefix is bounded and single-line", () => {
  const prefix = httpBodyPrefix(CLOUDFLARE_502);
  assert.ok(prefix.length <= HTTP_FAILURE_BODY_PREFIX_CAP + 1, `prefix was ${prefix.length} chars`);
  assert.doesNotMatch(prefix, /[\r\n]/);
  // <script>/<style> contents are dropped whole, not tag-stripped.
  assert.doesNotMatch(prefix, /font-family|__CF\$cv\$params/);
});

test("credential-shaped text in a reflecting gateway's page is scrubbed", () => {
  const reflected =
    "<html><body>Invalid request: Authorization: Bearer sk-live-8fbc21aa77de4931b0c5e6f1a2d3 rejected " +
    "for token=Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FybHk=</body></html>";
  const prefix = httpBodyPrefix(reflected);
  assert.doesNotMatch(prefix, /sk-live-8fbc21aa77de4931b0c5e6f1a2d3/);
  assert.doesNotMatch(prefix, /Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FybHk=/);
  assert.match(prefix, /«redacted»/);
  assert.doesNotMatch(scrubSecretShapedText("api_key=abc123def456"), /abc123def456/);
});

test("percent-encoded authorization material is scrubbed as one credential", () => {
  const reflected = "Authorization: Bearer abc%2Fdef%3Dghi";
  const scrubbed = scrubSecretShapedText(reflected);
  assert.doesNotMatch(scrubbed, /abc%2Fdef%3Dghi/);
  assert.doesNotMatch(scrubbed, /%2Fdef%3Dghi/);
  assert.match(scrubbed, /Authorization: «redacted»/);
});

test("wrapped secret material with punctuation is scrubbed through the continuation", () => {
  const scrubbed = scrubSecretShapedText("password:p@ssword\\nanother@secret");
  assert.doesNotMatch(scrubbed, /p@ssword/);
  assert.doesNotMatch(scrubbed, /another@secret/);
  assert.equal(scrubbed, "password: «redacted»");
});

test("a standard reason phrase is dropped, a custom one is kept", () => {
  assert.equal(describeHttpStatus(502, "Bad Gateway"), "502");
  assert.equal(describeHttpStatus(503, "Origin warming up"), "503 Origin warming up");
  assert.equal(describeHttpStatus(502, ""), "502");
});

// ---------------------------------------------------------------------------
// 3. ADOPTION, COUNTED
// ---------------------------------------------------------------------------

/**
 * Every site in a source file that captures an HTTP response body, and whether
 * that captured value is interpolated into an `Error` message WITHOUT going
 * through `describeHttpFailure`.
 *
 * Deliberately a source scan and not a set of per-site unit tests: the defect
 * class here is a call site that never adopted the canonical mechanism, and a
 * per-site test cannot see a site nobody wrote a test for.
 */
export function scanBodyCaptureSites(src) {
  const sites = [];
  const CAPTURE = /(\w+)\s*=\s*await\s+[\w.?]+\.text\(\)/g;
  let m;
  while ((m = CAPTURE.exec(src)) !== null) {
    const ident = m[1];
    const line = src.slice(0, m.index).split("\n").length;
    // The reporting that follows a capture lives within a few statements of it.
    const window = src.slice(m.index, m.index + 1200);
    const errors = [...window.matchAll(/new Error\(/g)];
    let leaks = false;
    for (const e of errors) {
      // The Error's argument list, bounded by the same window.
      const arg = window.slice(e.index, e.index + 900);
      const interpolated = new RegExp(`\\$\\{[^}]*\\b${ident}\\b`).test(arg);
      if (interpolated && !/describeHttpFailure\(/.test(arg)) leaks = true;
    }
    sites.push({ ident, line, leaks, adopts: /describeHttpFailure\(/.test(window) });
  }
  return sites;
}

// The scanner's own known-positive: the pre-fix `free_vram`, verbatim. A scanner
// that stopped matching would otherwise report a clean sweep forever.
const PRE_FIX_FREE_VRAM = `
  async free_vram() {
    const res = await api.fetchApi("/free", { method: "POST" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(\`Failed to free VRAM: \${res.status} \${res.statusText}\${text ? \` — \${text}\` : ""}\`);
    }
    return { freed: true };
  },
`;

test("the scanner detects the defect it exists to detect", () => {
  const found = scanBodyCaptureSites(PRE_FIX_FREE_VRAM);
  assert.equal(found.length, 1, "the pre-fix capture must be seen");
  assert.equal(found[0].leaks, true, "the pre-fix raw-body interpolation must be flagged");
});

test("no shipped panel site interpolates a raw response body into an Error", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const sites = scanBodyCaptureSites(src);
  const leaking = sites.filter((s) => s.leaks);
  assert.deepEqual(
    leaking.map((s) => `line ${s.line} (${s.ident})`),
    [],
    "a response body reached an Error message raw — route it through describeHttpFailure()",
  );

  // The COUNT is the point. If this number moved, a site that reads a failed
  // response body was added or removed: decide whether it reports to the agent,
  // adopt describeHttpFailure() if it does, and update this number deliberately.
  assert.equal(
    sites.length,
    8,
    `body-capture sites moved from 8 to ${sites.length}:\n` +
      sites.map((s) => `  line ${s.line} — ${s.ident}${s.adopts ? " [adopts]" : ""}`).join("\n"),
  );

  const adopters = sites.filter((s) => s.adopts);
  assert.equal(adopters.length, 1, "exactly the free_vram failure path adopts the classifier today");
});

test("free_vram's CALL SITE adopts the classifier", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(
    src,
    /import \{ describeHttpFailure \} from "\.\/lib\/http-failure\.js";/,
    "the shipped bundle must import the classifier",
  );
  const start = src.indexOf("async free_vram()");
  assert.ok(start > 0, "free_vram executor not found");
  const body = src.slice(start, src.indexOf("\n  },", start));
  assert.match(body, /describeHttpFailure\(/, "free_vram must route its failure through the classifier");
  assert.match(
    body,
    /backendReconnecting:\s*comfyBackendIsDown\(\)/,
    "free_vram must pass the SAME live socket predicate the graph_* branch consults — that asymmetry is issue #828",
  );
  assert.doesNotMatch(
    body,
    /\$\{text\}/,
    "the raw body must not be interpolated anywhere in free_vram",
  );
});
