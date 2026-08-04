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

// ---- #599: browser→proxy transport failures ("Failed to fetch", no status) --
// A bare TypeError from fetch means no HTTP response came back from the
// ComfyUI-side proxy — CivitAI is not the cause. The proxy call is always a
// POST, which Chrome won't self-retry on a stale keep-alive connection, so the
// client does ONE retry for idempotent specs (GETs, plus the read-only Meili
// multi-search POST, which is flagged idempotent at the call site), then throws
// a CLASSIFIED transport error (kind:"transport", status:null) naming the real
// failed hop — never the browser's bare "Failed to fetch" alone.

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
      // The reason, not just the state: the failed hop is browser→ComfyUI
      // proxy, and the original browser text is preserved for diagnosis.
      assert.match(err.message, /browser→ComfyUI hop/);
      assert.match(err.message, /Failed to fetch/);
      assert.match(err.message, /not an empty result/);
      return true;
    },
  );
  assert.equal(calls, 2); // one bounded retry, then give up
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
