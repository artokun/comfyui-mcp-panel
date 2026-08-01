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

test("#417: a non-abort fetch rejection still propagates unchanged", async () => {
  const client = new CivitaiClient({
    fetchApi: async () => {
      throw new TypeError("Failed to fetch");
    },
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client._request({ url: "https://civitai.com/api/v1/models" }),
    /Failed to fetch/,
  );
});
