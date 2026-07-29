// Unit tests for upstream-error propagation (issue #190).
//
// When the CivitAI proxy returns a non-2xx (e.g. 503 while model search is
// overloaded), CivitaiClient._request must THROW an Error that carries the
// upstream `status` — so the UI's fetch catch can record a distinct error state
// and panel_civitai_results can report it instead of an indistinguishable
// empty grid (total:0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CivitaiClient } from "../../web/js/cmcp-civitai.js";

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
