// Unit tests for #705 — CivitAI errors must carry the UPSTREAM RESPONSE BODY.
//
// The defect: a user searched "min" on the LoRA tab and got, repeatedly,
//     CivitAI error: CivitAI API 503: Service Unavailable
// A bare status reads as QUERY-SPECIFIC ("my search is broken") and sent the
// reporter hunting for a bug in our code. It was a CivitAI-side outage of their
// model-search backend, and their API said so in the response body:
//     {"error":"Model search is temporarily overloaded — please retry."}
// The Python proxy forwards that body verbatim with the upstream status; the
// browser client then threw it away and built its Error from status/statusText
// alone. Every bit of diagnostic value the proxy carried was lost at the last hop.
//
// The bar these tests hold: the user must be able to tell an outage on the OTHER
// side of the wire from a bug on ours — without the message ever pretending to a
// cause it does not have.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { CivitaiClient, CIVITAI_REQUEST_TIMEOUT_MS } from "../../web/js/cmcp-civitai.js";

// Control characters, written as escapes on purpose: a literal control byte in
// a source file makes it git-BINARY and unreviewable.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A response double shaped like the one `fetchApi` hands back for a non-2xx
 *  proxy reply: the body is readable exactly once, via text(). */
function errorResponse(status, statusText, bodyText) {
  return { ok: false, status, statusText, text: async () => bodyText };
}

const clientReturning = (response) =>
  new CivitaiClient({ fetchApi: async () => response, apiURL: (p) => p });

const rejectionFrom = async (client, spec = { url: "https://civitai.red/api/v1/models" }) => {
  try {
    await client._request(spec);
  } catch (e) {
    return e;
  }
  throw new Error("expected _request to reject");
};

// ── the reporter's exact failure ────────────────────────────────────────────

test("#705: a 503 whose JSON body carries an `error` string surfaces that string", async () => {
  const client = clientReturning(
    errorResponse(503, "Service Unavailable",
      '{"error":"Model search is temporarily overloaded — please retry."}'),
  );
  const err = await rejectionFrom(client);
  // The regression this issue is about: the message must NOT be the bare status.
  assert.notEqual(err.message, "CivitAI API 503: Service Unavailable");
  // The actionable sentence CivitAI put in the body reaches the user…
  assert.match(err.message, /Model search is temporarily overloaded — please retry\./);
  // …attributed, so it reads as CivitAI's words and not as ours.
  assert.match(err.message, /CivitAI said/);
  // …and is available separately for the UI / the agent-facing error state.
  assert.equal(err.detail, "Model search is temporarily overloaded — please retry.");
  // The status still classifies the failure for existing callers (#190).
  assert.equal(err.status, 503);
});

test("#705: nested JSON error shapes (error.message, tRPC error.json.message) are read too", async () => {
  for (const [body, want] of [
    ['{"error":{"message":"rate limit exceeded for this key"}}', "rate limit exceeded for this key"],
    ['{"error":{"json":{"message":"UNAUTHORIZED"}}}', "UNAUTHORIZED"],
    ['{"message":"upstream timeout talking to the search index"}', "upstream timeout talking to the search index"],
    ['{"error":{"issues":[{"message":"Invalid enum value for sort"}]}}', "Invalid enum value for sort"],
  ]) {
    const err = await rejectionFrom(clientReturning(errorResponse(500, "Internal Server Error", body)));
    assert.equal(err.detail, want, body);
    assert.ok(err.message.includes(want), `message should quote ${want}`);
  }
});

// ── body shapes that must NOT be dumped or over-claimed ─────────────────────

test("#705: an HTML error page is REPORTED, never dumped into the message", async () => {
  const html =
    "<!DOCTYPE html><html><head><title>503 Service Temporarily Unavailable</title>" +
    "<style>body{font:14px sans-serif}</style></head><body><h1>Error 503</h1>" +
    "<p>Ray ID: 8f2a11c0abcdef</p></body></html>";
  const err = await rejectionFrom(clientReturning(errorResponse(503, "Service Unavailable", html)));
  // Dumping markup into a user-facing string is its own misleading-error bug.
  assert.doesNotMatch(err.message, /</, "no markup may reach the message");
  assert.doesNotMatch(err.message, /DOCTYPE|Ray ID/i);
  // It still says MORE than the bare status: the shape of what came back.
  assert.notEqual(err.message, "CivitAI API 503: Service Unavailable");
  assert.match(err.message, /HTML/i);
  // …without claiming a cause it does not have.
  assert.match(err.message, /no machine-readable/i);
  assert.equal(err.detail, "", "an HTML page yields no quotable upstream detail");
});

test("#705: an empty body says so plainly instead of inventing a cause", async () => {
  const err = await rejectionFrom(clientReturning(errorResponse(503, "Service Unavailable", "")));
  assert.match(err.message, /CivitAI API 503: Service Unavailable/);
  assert.match(err.message, /no detail/i);
  assert.equal(err.detail, "");
  // Nothing invented: an empty body must not grow a fabricated reason.
  assert.doesNotMatch(err.message, /overloaded|search is down|rate limit/i);
});

test("#705: a plain-text (non-JSON, non-HTML) body IS quoted", async () => {
  const err = await rejectionFrom(clientReturning(errorResponse(502, "Bad Gateway", "upstream read error")));
  assert.equal(err.detail, "upstream read error");
  assert.ok(err.message.includes("upstream read error"));
});

// ── WHOSE words are these? ──────────────────────────────────────────────────
// Attributing the panel proxy's own guard rails to CivitAI would be the same
// misattribution #705 is about, pointed the other way. py/civitai_proxy.py tags
// the bodies it authors with `source`; an untagged body is CivitAI's.

test("#705: an unmarked body is attributed to CivitAI", async () => {
  const err = await rejectionFrom(
    clientReturning(errorResponse(503, "Service Unavailable", '{"error":"Model search is overloaded"}')),
  );
  assert.match(err.message, /CivitAI said/);
  assert.doesNotMatch(err.message, /panel's CivitAI proxy said/);
});

test("#705: a body the panel's OWN proxy authored is not narrated as CivitAI's words", async () => {
  const err = await rejectionFrom(
    clientReturning(
      errorResponse(502, "Bad Gateway",
        '{"error":"CivitAI redirected the download to a host this proxy will not follow",' +
        '"source":"comfyui-mcp-panel","retryable":false}'),
    ),
  );
  assert.match(err.message, /panel's CivitAI proxy said/);
  assert.doesNotMatch(err.message, /CivitAI said/);
  assert.equal(err.detail, "CivitAI redirected the download to a host this proxy will not follow");
});

test("#705: a proxy guard's PERMANENT refusal is never sold as a transient outage", async () => {
  // Codex gate P2. upstreamFailureClass(502) says "transient", but the 502 here
  // is OURS: the redirect allow-list refused, and it will refuse identically
  // forever. Advising a retry would be the wrong-advice half of this very issue.
  const err = await rejectionFrom(
    clientReturning(
      errorResponse(502, "Bad Gateway",
        '{"error":"CivitAI redirected the download to a host this proxy will not follow",' +
        '"source":"comfyui-mcp-panel","retryable":false}'),
    ),
  );
  assert.equal(err.retryable, false);
  assert.doesNotMatch(err.message, /retrying shortly may succeed/i);
  assert.match(err.message, /will not help/i);
  // And it must not put words in CivitAI's mouth about what CivitAI did.
  assert.doesNotMatch(err.message, /CivitAI failed this request on its own side/);
});

test("#705: a proxy failure the proxy calls RETRYABLE keeps the retry advice", async () => {
  const err = await rejectionFrom(
    clientReturning(
      errorResponse(502, "Bad Gateway",
        '{"error":"could not reach CivitAI: connection reset",' +
        '"source":"comfyui-mcp-panel","retryable":true}'),
    ),
  );
  assert.equal(err.retryable, true);
  assert.match(err.message, /retrying shortly may succeed/i);
  assert.match(err.message, /panel's CivitAI proxy/);
});

test("#705: a proxy-authored 401 still points at sign-in, not at the proxy", async () => {
  // Whoever produced the body, the ACTION for a 401 is the same.
  const err = await rejectionFrom(
    clientReturning(
      errorResponse(401, "Unauthorized",
        '{"error":"sign-in required to download this file",' +
        '"source":"comfyui-mcp-panel","retryable":false}'),
    ),
  );
  assert.match(err.message, /sign in|sign-in|signed-in/i);
  assert.equal(err.retryable, false);
});

test("#705: a proxy body with no readable message is not attributed to CivitAI either", async () => {
  // Codex gate round 3: the "JSON with no error message" note hardcoded CivitAI,
  // so a marked body that carried no readable message described OUR reply as
  // CivitAI's while the advice beside it named the proxy.
  const err = await rejectionFrom(
    clientReturning(
      errorResponse(502, "Bad Gateway", '{"source":"comfyui-mcp-panel","retryable":false}'),
    ),
  );
  assert.doesNotMatch(err.message, /CivitAI's response body/);
  assert.match(err.message, /panel's CivitAI proxy returned JSON with no error message/);
  assert.equal(err.retryable, false);
});

test("#705: an UNMARKED body with no readable message is still attributed to CivitAI", async () => {
  const err = await rejectionFrom(clientReturning(errorResponse(502, "Bad Gateway", '{"traceId":"x"}')));
  assert.match(err.message, /CivitAI's response body was JSON with no error message/);
});

test("#705: a quote without terminal punctuation does not run into the advice", async () => {
  const err = await rejectionFrom(clientReturning(errorResponse(429, "Too Many Requests", '{"error":"slow down"}')));
  assert.ok(err.message.includes("“slow down”."), err.message);
});

test("#705: JSON with no recognizable message field reports the shape, not the blob", async () => {
  const err = await rejectionFrom(
    clientReturning(errorResponse(500, "Internal Server Error", '{"traceId":"abc","meta":{"a":1,"b":[2,3]}}')),
  );
  assert.equal(err.detail, "");
  assert.match(err.message, /no error message/i);
  assert.doesNotMatch(err.message, /traceId|\{|\}/);
});

// ── transient vs terminal: the ADVICE differs, and getting it wrong misleads ─

test("#705: a 503 is transient — retrying is worth advising", async () => {
  const err = await rejectionFrom(clientReturning(errorResponse(503, "Service Unavailable", "")));
  assert.match(err.message, /retry/i);
  assert.equal(err.retryable, true);
});

test("#705: a 429 is transient too", async () => {
  const err = await rejectionFrom(clientReturning(errorResponse(429, "Too Many Requests", '{"error":"slow down"}')));
  assert.match(err.message, /retry/i);
  assert.equal(err.retryable, true);
});

test("#705: a 400 is TERMINAL — it must never be dressed up as 'retry shortly'", async () => {
  // #459: CivitAI ZodError-rejects an out-of-enum sort/period with a hard 400.
  // Telling the user to retry an unchanged malformed query is wrong guidance.
  const err = await rejectionFrom(
    clientReturning(errorResponse(400, "Bad Request", '{"error":"Invalid enum value. Expected Newest | Oldest"}')),
  );
  assert.equal(err.retryable, false);
  assert.match(err.detail, /Invalid enum value/);
  assert.match(err.message, /not help/i);
  assert.doesNotMatch(err.message, /retry shortly|retrying shortly/i);
});

test("#705: a 404 is terminal as well", async () => {
  const err = await rejectionFrom(clientReturning(errorResponse(404, "Not Found", "")));
  assert.equal(err.retryable, false);
  assert.doesNotMatch(err.message, /retrying shortly/i);
});

test("#705: 401/403 point at sign-in rather than at retrying", async () => {
  for (const status of [401, 403]) {
    const err = await rejectionFrom(clientReturning(errorResponse(status, "Unauthorized", "")));
    assert.equal(err.retryable, false, `status ${status}`);
    assert.match(err.message, /sign in|signed-in|sign-in/i, `status ${status}`);
    assert.doesNotMatch(err.message, /retrying shortly/i, `status ${status}`);
  }
});

// ── the body is untrusted, arbitrary-length text going into the UI ───────────

test("#705: an oversized body is capped, with the truncation visible", async () => {
  const long = "A".repeat(20000);
  const err = await rejectionFrom(
    clientReturning(errorResponse(500, "Internal Server Error", JSON.stringify({ error: long }))),
  );
  assert.ok(err.detail.length < 400, `detail was ${err.detail.length} chars`);
  assert.ok(err.detail.endsWith("…"), "truncation must be visible, not silent");
  assert.ok(err.message.length < 700, `message was ${err.message.length} chars`);
});

test("#705: newlines and control bytes are flattened out of the message", async () => {
  const nasty = "line one\nline two\r\n\tindented \u001b[31mred";
  const err = await rejectionFrom(
    clientReturning(errorResponse(500, "Internal Server Error", JSON.stringify({ error: nasty }))),
  );
  // A one-line error card must stay one line, and no control byte (ANSI escapes
  // included) may ride an untrusted body into the UI or the console.
  assert.doesNotMatch(err.message, CONTROL_CHARS);
  assert.doesNotMatch(err.detail, CONTROL_CHARS);
  assert.match(err.detail, /line one line two indented/);
});

test("#705: a credential echoed back by the upstream is never re-displayed", async () => {
  // The proxy injects the CivitAI OAuth bearer server-side. An upstream that
  // echoes the request's auth header into its error body must not turn our own
  // error card (or the ComfyUI console) into a token leak.
  // NOTE: the values below are deliberately NOT real-token-shaped secrets.
  const body = JSON.stringify({
    error: "rejected request with Authorization: Bearer notarealtokenvaluenotarealtoken",
  });
  const err = await rejectionFrom(clientReturning(errorResponse(401, "Unauthorized", body)));
  assert.doesNotMatch(err.message, /notarealtokenvalue/);
  assert.doesNotMatch(err.detail, /notarealtokenvalue/);
  assert.match(err.detail, /redacted/i);
});

test("#705: a Basic credential is redacted too — the scheme must not smuggle it through", async () => {
  // Codex gate P2: the labelled-secret pattern could not step over an auth
  // SCHEME, so "Authorization: Basic <base64>" walked straight through while
  // Bearer was caught. Value below is base64 of a well-known RFC example pair.
  const body = JSON.stringify({
    error: "rejected: Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
  });
  const err = await rejectionFrom(clientReturning(errorResponse(401, "Unauthorized", body)));
  assert.doesNotMatch(err.message, /QWxhZGRpbjpvcGVu/);
  assert.doesNotMatch(err.detail, /QWxhZGRpbjpvcGVu/);
  assert.match(err.detail, /redacted/i);
});

test("#705: ordinary prose containing 'token' or 'API key' is NOT redacted away", async () => {
  // Over-redaction destroys the actionable message — the failure mode this whole
  // change exists to remove. Short, wordy values must survive untouched.
  for (const msg of [
    "Your token expired, please sign in again",
    "Invalid API key provided",
    "authorization required for this endpoint",
  ]) {
    const err = await rejectionFrom(
      clientReturning(errorResponse(401, "Unauthorized", JSON.stringify({ error: msg }))),
    );
    assert.equal(err.detail, msg);
  }
});

test("#705: a proxy body that does NOT declare retryability claims neither outcome", async () => {
  // Codex gate round 2. A proxy older than this panel JS sends `source` without
  // `retryable`. Falling back to the status would read OUR 502 as CivitAI's and
  // print "the panel's proxy said …" immediately followed by "CivitAI failed
  // this on its own side" — two contradictory claims in one sentence.
  const err = await rejectionFrom(
    clientReturning(
      errorResponse(502, "Bad Gateway", '{"error":"redirect blocked","source":"comfyui-mcp-panel"}'),
    ),
  );
  assert.equal(err.retryable, null);
  assert.doesNotMatch(err.message, /CivitAI failed this request on its own side/);
  assert.doesNotMatch(err.message, /retrying shortly may succeed/i);
  assert.doesNotMatch(err.message, /will not help/i);
  assert.match(err.message, /came from the panel's CivitAI proxy/);
});

test("#705: a `retryable` field on a body we did NOT author is ignored", async () => {
  // Only the panel's own proxy gets to declare this; an upstream body claiming
  // `retryable` must not steer our advice.
  const err = await rejectionFrom(
    clientReturning(errorResponse(400, "Bad Request", '{"error":"nope","retryable":true}')),
  );
  assert.equal(err.retryable, false);
  assert.match(err.message, /CivitAI said/);
  assert.match(err.message, /will not help/i);
});

test("#705: content dropped by the redaction window is never silently lost", async () => {
  // Codex gate round 2: redaction SHRINKS text, so a body that overflowed the
  // window can land back under the cap and skip the truncation marker — the
  // reader sees a message that looks whole while the real cause sat past the
  // window. Three long token runs, then the actual reason.
  const raw =
    `token=${"A".repeat(900)} token=${"B".repeat(900)} token=${"C".repeat(900)} ` +
    "the actual cause was a schema migration";
  const err = await rejectionFrom(
    clientReturning(errorResponse(500, "Internal Server Error", JSON.stringify({ error: raw }))),
  );
  assert.doesNotMatch(err.detail, /AAAA|BBBB|CCCC/, "the credential runs are still redacted");
  assert.ok(err.detail.endsWith("…"), `truncation must stay visible: ${err.detail}`);
});

test("#705: redaction of a huge hostile body stays fast (bounded window)", async () => {
  // The /api cap allows megabytes through, and the credential patterns have
  // adjacent overlapping quantifiers. Redacting the whole body would be wasted
  // polynomial work on text that is discarded by the cap regardless.
  const hostile = "token" + " ".repeat(200000) + "=".repeat(200000);
  const started = Date.now();
  const err = await rejectionFrom(
    clientReturning(errorResponse(500, "Internal Server Error", JSON.stringify({ error: hostile }))),
  );
  assert.ok(Date.now() - started < 2000, "redaction must not blow up on a large body");
  assert.ok(err.detail.length <= 240);
});

test("#705: a JWT-shaped string in the body is redacted even without a label", async () => {
  const jwtish = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub3RyZWFsIn0.notarealsignaturehere";
  const err = await rejectionFrom(
    clientReturning(errorResponse(500, "Internal Server Error", JSON.stringify({ error: `sent ${jwtish} upstream` }))),
  );
  assert.doesNotMatch(err.message, /eyJ/);
  assert.doesNotMatch(err.detail, /eyJ/);
});

// ── reading the body must never MASK the failure it is describing ───────────

test("#705: a body that cannot be read still yields the status message", async () => {
  const err = await rejectionFrom(
    clientReturning({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => {
        throw new TypeError("body stream already read");
      },
    }),
  );
  assert.match(err.message, /CivitAI API 503: Service Unavailable/);
  assert.equal(err.status, 503);
  assert.equal(err.detail, "");
  // The read failure is OUR problem, not something to narrate as CivitAI's.
  assert.doesNotMatch(err.message, /body stream already read/);
});

test("#705: a body that NEVER SETTLES must not turn a known 503 into a hang", async () => {
  // Codex gate P1. Headers can arrive and the body then never finish. Reading it
  // after the #417 abort budget was cleared would leave _request pending
  // forever — _loadMore never reaching its catch/finally, the grid frozen on
  // {loading:true, total:0, error:null}: the exact defect #417 removed,
  // reintroduced by the fix for #705. The read happens INSIDE the budget, so the
  // abort fires, the body read is abandoned, and the status is still reported.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const client = new CivitaiClient({
      fetchApi: async (_path, opts) => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        // Real fetch errors a pending body read when its signal aborts.
        text: () =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => {
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      }),
      apiURL: (p) => p,
    });
    const pending = client._request({ url: "https://civitai.red/api/v1/models" });
    await Promise.resolve(); // let the fetch resolve and the body read start
    mock.timers.tick(CIVITAI_REQUEST_TIMEOUT_MS + 1);
    await assert.rejects(pending, (e) => {
      assert.equal(e.status, 503);
      assert.match(e.message, /CivitAI API 503: Service Unavailable/);
      assert.equal(e.detail, "");
      return true;
    });
  } finally {
    mock.timers.reset();
  }
});

test("#705: a response with no text() at all degrades to the status message", async () => {
  const err = await rejectionFrom(clientReturning({ ok: false, status: 503, statusText: "Service Unavailable" }));
  assert.match(err.message, /CivitAI API 503: Service Unavailable/);
  assert.equal(err.detail, "");
});

// ── the success path is untouched ───────────────────────────────────────────

test("#705: a 2xx still returns the normalized body and never touches text()", async () => {
  let textCalls = 0;
  const client = new CivitaiClient({
    fetchApi: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [1, 2, 3] }),
      text: async () => {
        textCalls++;
        return "{}";
      },
    }),
    apiURL: (p) => p,
  });
  assert.deepEqual(await client._request({ url: "https://civitai.red/api/v1/models" }), { items: [1, 2, 3] });
  assert.equal(textCalls, 0, "the success path must not read the body twice");
});

// ── the OTHER call site with the same swallow: the download route ───────────

test("#705: downloadVersionFile carries the upstream reason and status", async () => {
  // The body below is the one py/civitai_proxy.py really sends for a gated file
  // (see _proxy_error / _is_auth_redirect); all of it was dropped for a bare
  // `civitai download 401`.
  const client = new CivitaiClient({
    fetchApi: async () =>
      errorResponse(401, "Unauthorized",
        '{"error":"sign-in required to download this file","source":"comfyui-mcp-panel","retryable":false}'),
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client.downloadVersionFile(1),
    (e) => {
      assert.equal(e.status, 401);
      assert.match(e.message, /401/);
      assert.ok(e.message.includes("sign-in required to download this file"));
      assert.equal(e.detail, "sign-in required to download this file");
      return true;
    },
  );
});

test("#705: a download blocked by the proxy's own guard names the guard, and names WHO blocked it", async () => {
  const client = new CivitaiClient({
    fetchApi: async () =>
      errorResponse(502, "Bad Gateway",
        '{"error":"CivitAI redirected the download to a host this proxy will not follow",' +
        '"source":"comfyui-mcp-panel","retryable":false}'),
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client.downloadVersionFile(1),
    (e) => {
      assert.ok(e.message.includes("this proxy will not follow"));
      assert.match(e.message, /panel's CivitAI proxy said/);
      // The guard is deterministic: retrying it unchanged can never work.
      assert.equal(e.retryable, false);
      return true;
    },
  );
});
