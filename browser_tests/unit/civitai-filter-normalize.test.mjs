// Unit tests for the #459 sort/period enum clamp in web/js/cmcp-civitai.js.
//
// CivitAI's REST list endpoints ZodError-reject any sort/period value outside
// their enum with a hard `400 Bad Request` that dead-ended the docked browser
// ("No data: CivitAI API 400"). The trigger class: a stale/renamed/cross-tab
// value reaching the wrong endpoint — most notably an IMAGE sort ("Most
// Reactions") landing on /v1/models, which only accepts MODEL sorts. The client
// now clamps sort+period to a supported value BEFORE dispatch. These tests
// assert the normalizers AND that fetchModels/fetchFeed actually dispatch a
// well-formed request no matter what the caller passes.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CivitaiClient,
  normalizeModelSort,
  normalizeImageSort,
  normalizePeriod,
  MODEL_SORTS,
  IMAGE_SORTS,
  PERIODS,
} from "../../web/js/cmcp-civitai.js";

test("normalizeModelSort clamps out-of-vocab / cross-tab values to the default", () => {
  // Cross-tab: an IMAGE sort is NOT a valid model sort → 400 on /v1/models.
  assert.equal(normalizeModelSort("Most Reactions"), "Most Downloaded");
  assert.equal(normalizeModelSort("Most Comments"), "Most Downloaded");
  assert.equal(normalizeModelSort("bogus"), "Most Downloaded");
  assert.equal(normalizeModelSort(undefined), "Most Downloaded");
  assert.equal(normalizeModelSort(null), "Most Downloaded");
  // Valid model sorts pass through untouched.
  for (const s of MODEL_SORTS) assert.equal(normalizeModelSort(s), s);
});

test("normalizeImageSort clamps out-of-vocab values to the default", () => {
  assert.equal(normalizeImageSort("Most Downloaded"), "Most Reactions"); // a MODEL sort on the image path
  assert.equal(normalizeImageSort("nope"), "Most Reactions");
  assert.equal(normalizeImageSort(undefined), "Most Reactions");
  for (const s of IMAGE_SORTS) assert.equal(normalizeImageSort(s), s);
});

test("normalizePeriod clamps out-of-vocab values to Week", () => {
  assert.equal(normalizePeriod("Forever"), "Week");
  assert.equal(normalizePeriod("alltime"), "Week"); // wrong case is not the enum value
  assert.equal(normalizePeriod(undefined), "Week");
  for (const p of PERIODS) assert.equal(normalizePeriod(p), p);
});

// Capture the exact URL the client would dispatch, without a real network call.
function captureClient() {
  const calls = [];
  const client = new CivitaiClient({
    fetchApi: async (_route, opts) => {
      const { url } = JSON.parse(opts.body);
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ items: [], metadata: {} }) };
    },
    apiURL: (p) => p,
  });
  return { client, calls };
}

test("fetchModels never dispatches an invalid model sort/period (the #459 400)", async () => {
  const { client, calls } = captureClient();
  // The exact failing shape: an image sort + a period, on the LoRA (model) tab.
  await client.fetchModels({ type: "LORA", sort: "Most Reactions", period: "Forever", levels: [1, 2, 4, 8, 16] });
  const u = new URL(calls[0]);
  assert.equal(u.searchParams.get("sort"), "Most Downloaded"); // clamped, not "Most Reactions"
  assert.equal(u.searchParams.get("period"), "Week"); // clamped, not "Forever"
});

test("fetchModels defaults a keyword search to AllTime but honors an explicit period", async () => {
  const { client, calls } = captureClient();
  await client.fetchModels({ type: "LORA", query: "game asset" });
  assert.equal(new URL(calls[0]).searchParams.get("period"), "AllTime");

  calls.length = 0;
  await client.fetchModels({ type: "LORA", query: "game asset", period: "Month" });
  assert.equal(new URL(calls[0]).searchParams.get("period"), "Month");

  calls.length = 0;
  await client.fetchModels({ type: "LORA" });
  assert.equal(new URL(calls[0]).searchParams.get("period"), "Week");
});

test("fetchFeed never dispatches an invalid image sort/period", async () => {
  const { client, calls } = captureClient();
  await client.fetchFeed({ type: "image", sort: "Most Downloaded", period: "Nope" });
  const u = new URL(calls[0]);
  assert.equal(u.searchParams.get("sort"), "Most Reactions"); // clamped from the model sort
  assert.equal(u.searchParams.get("period"), "Week");
});

test("valid filters are dispatched unchanged", async () => {
  const { client, calls } = captureClient();
  await client.fetchModels({ type: "LORA", sort: "Most Liked", period: "AllTime", levels: [1] });
  const u = new URL(calls[0]);
  assert.equal(u.searchParams.get("sort"), "Most Liked");
  assert.equal(u.searchParams.get("period"), "AllTime");
});
