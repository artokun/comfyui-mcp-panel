// Unit tests for upstream-error propagation (issue #190).
//
// When the CivitAI proxy returns a non-2xx (e.g. 503 while model search is
// overloaded), CivitaiClient._request must THROW an Error that carries the
// upstream `status` — so the UI's fetch catch can record a distinct error state
// and panel_civitai_results can report it instead of an indistinguishable
// empty grid (total:0).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { CivitaiClient, CIVITAI_REQUEST_TIMEOUT_MS } from "../../web/js/cmcp-civitai.js";

function clientWith(response) {
  return new CivitaiClient({
    fetchApi: async () => response,
    apiURL: (p) => p,
  });
}

test("_request throws an error carrying the upstream status on 503", async () => {
  const client = clientWith({
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    json: async () => ({}),
  });
  await assert.rejects(
    () => client._request({ url: "https://civitai.com/api/v1/models" }),
    (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /503/);
      return true;
    },
  );
});

test("_request returns the normalized body on success", async () => {
  const client = clientWith({
    ok: true,
    status: 200,
    json: async () => ({ items: [1, 2, 3] }),
  });
  const out = await client._request({ url: "https://civitai.com/api/v1/models" });
  assert.deepEqual(out, { items: [1, 2, 3] });
});

// ---- #417: a hung proxy request is aborted so _loadMore can recover ----------
// Before the fix, _request awaited fetchApi with NO timeout/AbortSignal, so a
// proxy/upstream that never settled left the fetch pending forever — _loadMore
// never reached its catch/finally and panel_civitai_results stayed
// {loading:true, total:0, error:null} indefinitely. The client-side abort budget
// converts that hang into a thrown timeout the existing catch surfaces.

test("#417: _request throws a timeout error when the proxy never settles", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let aborted = false;
    const client = new CivitaiClient({
      fetchApi: (_path, opts) =>
        new Promise((_resolve, reject) => {
          // Real fetch rejects with an AbortError when its signal fires.
          opts.signal.addEventListener("abort", () => {
            aborted = true;
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
      apiURL: (p) => p,
    });
    const pending = client._request({ url: "https://civitai.com/api/v1/models" });
    // Advance past the abort budget — fires the timeout → controller.abort().
    mock.timers.tick(CIVITAI_REQUEST_TIMEOUT_MS + 1);
    await assert.rejects(
      () => pending,
      (err) => {
        assert.match(err.message, /timed out after \d+ seconds/i);
        assert.notEqual(err.name, "AbortError"); // AbortError is converted, not leaked
        return true;
      },
    );
    assert.equal(aborted, true);
  } finally {
    mock.timers.reset();
  }
});

// ---- #599: transport failures ("Failed to fetch", no HTTP status) -----------
// A bare TypeError from fetch establishes exactly one thing: the browser
// obtained NO HTTP response. It does not identify which leg failed and it does
// NOT rule CivitAI out — a request that reached ComfyUI whose own upstream
// CivitAI call then failed rejects identically. So the thrown error must report
// the cause as UNDETERMINED and list candidates, never assert one hop.
// The proxy call is always a POST, which Chrome won't self-retry on a stale
// keep-alive connection, so the client does ONE retry for idempotent specs
// (GETs, plus the read-only Meili multi-search POST, which is flagged
// idempotent at the call site), then throws a CLASSIFIED transport error
// (kind:"transport", status:null) carrying the FULL attempt trail.

test("#599: a transient transport failure on an idempotent request is retried once", async () => {
  let calls = 0;
  const client = new CivitaiClient({
    fetchApi: async () => {
      calls++;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => ({ items: [1, 2, 3] }) };
    },
    apiURL: (p) => p,
  });
  const out = await client._request({ url: "https://civitai.red/api/v1/models" });
  assert.deepEqual(out, { items: [1, 2, 3] });
  assert.equal(calls, 2); // first attempt failed at transport, retry succeeded
});

test("#599: a persistent transport failure throws a classified transport error", async () => {
  let calls = 0;
  const client = new CivitaiClient({
    fetchApi: async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    },
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client._request({ url: "https://civitai.red/api/v1/models" }),
    (err) => {
      assert.equal(err.kind, "transport");
      assert.equal(err.status, null); // no HTTP response ever existed
      // The observation is preserved…
      assert.match(err.message, /Failed to fetch/);
      // …and the one thing that IS established: no HTTP status came back, so
      // this cannot be read as a confirmed empty result.
      assert.match(err.message, /not a confirmed empty result/);
      return true;
    },
  );
  assert.equal(calls, 2); // one bounded retry, then give up
});

// The defect this repo keeps re-growing: an opaque bucket narrated as a CAUSE.
// "Failed to fetch" is the browser's single bucket for network failure, CORS,
// a blocked request, DNS, offline and abort. The rejection below happens AFTER
// the request reached ComfyUI — ComfyUI's own upstream CivitAI call failed and
// no response made it back — and it is byte-identical to a ComfyUI-unreachable
// rejection. The error must therefore say the hop is UNDETERMINED and must NOT
// tell the user CivitAI has been excluded, or they rule out the actual cause.
test("#599: a rejection that occurred AFTER reaching ComfyUI is reported as undetermined, not as 'not a CivitAI error'", async () => {
  const client = new CivitaiClient({
    fetchApi: async () => {
      // ComfyUI accepted the request and its OWN upstream CivitAI call failed;
      // the response connection dropped before any status reached the browser.
      throw new TypeError("Failed to fetch");
    },
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client._request({ url: "https://civitai.red/api/v1/models" }),
    (err) => {
      // States the cause is not established…
      assert.match(err.message, /could NOT be determined/);
      // …explicitly does not exclude CivitAI, and names it as a live candidate.
      assert.match(err.message, /does not rule CivitAI out/);
      assert.match(err.message, /ComfyUI did reach CivitAI/);
      // …and never asserts a single hop as the diagnosis.
      assert.doesNotMatch(err.message, /not a CivitAI error/i);
      assert.doesNotMatch(err.message, /failed at the browser→ComfyUI hop/i);
      return true;
    },
  );
});

// Never destroy evidence before it can be reported: attempt 1 can carry the
// actionable error and attempt 2 an unrelated one. If only the retry's message
// survives, the diagnosis of an intermittent failure is lost.
test("#599: the retry does not discard the first attempt's error", async () => {
  let calls = 0;
  const client = new CivitaiClient({
    fetchApi: async () => {
      calls++;
      if (calls === 1) throw new TypeError("blocked by a browser extension");
      throw new TypeError("NetworkError when attempting to fetch resource");
    },
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client._request({ url: "https://civitai.red/api/v1/models" }),
    (err) => {
      // BOTH failures are reported, and which is which is unambiguous.
      assert.match(err.message, /attempt 1 failed with: blocked by a browser extension/);
      assert.match(err.message, /the retry then failed with: NetworkError when attempting to fetch resource/);
      // The original error object itself survives for programmatic callers.
      assert.equal(err.cause?.message, "blocked by a browser extension");
      return true;
    },
  );
  assert.equal(calls, 2);
});

// The evidence rule holds on EVERY final throw, not just the transport one.
// If attempt 1 dies at transport and the retry comes back with an upstream
// status, the throw happens outside the retry catch — the first rejection (an
// extension blocking the request, a dropped connection) must not be silently
// replaced by an unrelated 503.
test("#599: an upstream status on the RETRY still reports the first attempt's transport error", async () => {
  let calls = 0;
  const client = new CivitaiClient({
    fetchApi: async () => {
      calls++;
      if (calls === 1) throw new TypeError("blocked by a browser extension");
      return { ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) };
    },
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client._request({ url: "https://civitai.red/api/v1/models" }),
    (err) => {
      assert.equal(err.status, 503); // the upstream status is still classified correctly
      assert.match(err.message, /503/);
      assert.match(err.message, /blocked by a browser extension/);
      assert.equal(err.cause?.message, "blocked by a browser extension");
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("#599: an unparseable body on the RETRY still reports the first attempt's transport error", async () => {
  let calls = 0;
  const parseError = new SyntaxError("Unexpected token < in JSON");
  const client = new CivitaiClient({
    fetchApi: async () => {
      calls++;
      if (calls === 1) throw new TypeError("blocked by a browser extension");
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw parseError;
        },
      };
    },
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client._request({ url: "https://civitai.red/api/v1/models" }),
    (err) => {
      assert.match(err.message, /Unexpected token/);
      assert.match(err.message, /blocked by a browser extension/);
      assert.equal(err.cause?.message, "blocked by a browser extension");
      // res was ok, so there is no upstream error status to claim.
      assert.equal(err.status, undefined);
      // Attaching attempt 1's evidence must not destroy the RETRY's evidence:
      // the parse error keeps its identity, its class and its stack. Rebuilding
      // it as a plain Error would be the same evidence loss in the other
      // direction.
      assert.equal(err, parseError, "the original parse error object is thrown, not a copy");
      assert.ok(err instanceof SyntaxError);
      assert.equal(err.name, "SyntaxError");
      assert.ok(err.stack, "the parse error's own stack survives");
      return true;
    },
  );
});

test("#599: an existing cause on the retry's error is never overwritten", async () => {
  let calls = 0;
  const inner = new Error("the real underlying parse problem");
  const parseError = new SyntaxError("bad body", { cause: inner });
  const client = new CivitaiClient({
    fetchApi: async () => {
      calls++;
      if (calls === 1) throw new TypeError("blocked by a browser extension");
      return { ok: true, status: 200, json: async () => { throw parseError; } };
    },
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client._request({ url: "https://civitai.red/api/v1/models" }),
    (err) => {
      assert.equal(err.cause, inner, "a pre-existing cause is evidence too");
      // …and attempt 1 is still reported, via the message.
      assert.match(err.message, /blocked by a browser extension/);
      return true;
    },
  );
});

// A first-attempt-free failure must be left exactly as it was — no invented
// trail, no invented cause (guards the fix against overshooting).
test("#599: a plain upstream error with no prior attempt is unchanged", async () => {
  const client = new CivitaiClient({
    fetchApi: async () => ({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) }),
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client._request({ url: "https://civitai.red/api/v1/models" }),
    (err) => {
      assert.equal(err.message, "CivitAI API 503: Service Unavailable");
      assert.equal(err.cause, undefined);
      return true;
    },
  );
});

// Same evidence rule when the retry is cut short by the #417 abort budget
// rather than by another transport rejection.
test("#599: a timeout after a failed first attempt still reports that first error", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    const client = new CivitaiClient({
      fetchApi: (_path, opts) => {
        calls++;
        if (calls === 1) return Promise.reject(new TypeError("blocked by a browser extension"));
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      },
      apiURL: (p) => p,
    });
    const pending = client._request({ url: "https://civitai.red/api/v1/models" });
    await Promise.resolve(); // let attempt 1 reject and attempt 2 start
    mock.timers.tick(CIVITAI_REQUEST_TIMEOUT_MS + 1);
    await assert.rejects(
      () => pending,
      (err) => {
        assert.match(err.message, /timed out after \d+ seconds/i);
        assert.match(err.message, /blocked by a browser extension/);
        assert.equal(err.cause?.message, "blocked by a browser extension");
        return true;
      },
    );
  } finally {
    mock.timers.reset();
  }
});

test("#599: a transport failure on a non-idempotent (POST) request is NOT retried", async () => {
  // reaction.toggle / collection writes must never be double-fired: a retry
  // could silently apply the mutation twice.
  let calls = 0;
  const client = new CivitaiClient({
    fetchApi: async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    },
    apiURL: (p) => p,
  });
  await assert.rejects(
    () =>
      client._request({
        url: "https://civitai.red/api/trpc/reaction.toggle",
        method: "POST",
        body: { json: { entityType: "image", entityId: 1, reaction: "Like" } },
      }),
    (err) => err.kind === "transport",
  );
  assert.equal(calls, 1);
});

test("#599: a READ issued as a POST (Meili multi-search) IS retried when flagged idempotent", async () => {
  // Idempotency is a property of the operation, not the HTTP method: keyword
  // media search goes through MeiliSearch's multi-search, a read-only POST.
  let calls = 0;
  const client = new CivitaiClient({
    fetchApi: async () => {
      calls++;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => ({ results: [{ hits: [] }] }) };
    },
    apiURL: (p) => p,
  });
  const out = await client.searchMedia("wan");
  assert.deepEqual(out, []);
  assert.equal(calls, 2, "the flagged read-only POST must get the same one retry as a GET");
});

test("#599: every read path routes through the same-origin proxy (no direct cross-origin fetch)", async () => {
  // The browser must never call a CivitAI host directly (CORS + bot-gate
  // headers) — every network call goes through /comfyui_mcp_panel/civitai/*.
  const seen = [];
  const client = new CivitaiClient({
    fetchApi: async (path) => {
      seen.push(path);
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    },
    apiURL: (p) => p,
  });
  await client.fetchModels({ type: "Checkpoint", query: "wan" });
  await client.fetchFeed({});
  await client.searchMedia("wan");
  assert.ok(seen.length >= 3);
  for (const p of seen) assert.equal(p, "/comfyui_mcp_panel/civitai/api");
});
