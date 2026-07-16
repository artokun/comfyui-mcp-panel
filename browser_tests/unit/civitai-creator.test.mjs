// Unit tests for the CivitAI creator filter plumbing (cmcp-civitai.js):
// Meili escaping order, the /v1/models query×username API quirk, leaderboard
// parsing, /v1/creators search shaping, and username threading into every
// query the explorer makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CivitaiClient, DEFAULT_FILTERS, filtersDirty } from "../../web/js/cmcp-civitai.js";

/** Client whose proxy calls are captured; each call resolves `payload`. */
const stub = (payload) => {
  const calls = [];
  const client = new CivitaiClient({
    fetchApi: async (_path, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, json: async () => payload };
    },
    apiURL: (p) => p,
  });
  return { client, calls };
};

test("escapeMeili escapes backslashes FIRST, then quotes", () => {
  // the other order would re-escape the quote escaping and let a trailing
  // backslash break out of the quoted filter string
  assert.equal(CivitaiClient.escapeMeili('a\\b"c'), 'a\\\\b\\"c');
  assert.equal(CivitaiClient.escapeMeili('end\\'), "end\\\\");
  assert.equal(CivitaiClient.escapeMeili('"'), '\\"');
  assert.equal(CivitaiClient.escapeMeili("plain"), "plain");
});

test("filters: username participates in defaults + dirtiness", () => {
  assert.equal(DEFAULT_FILTERS.username, null);
  assert.equal(filtersDirty({ ...DEFAULT_FILTERS }), false);
  assert.equal(filtersDirty({ ...DEFAULT_FILTERS, username: "someone" }), true);
});

test("fetchFeed threads username into /v1/images", async () => {
  const { client, calls } = stub({ items: [], metadata: {} });
  await client.fetchFeed({ username: "artist" });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/images");
  assert.equal(url.searchParams.get("username"), "artist");
  calls.length = 0;
  await client.fetchFeed({});
  assert.equal(new URL(calls[0].url).searchParams.has("username"), false);
});

test("searchMedia adds an escaped user.username Meili filter", async () => {
  const { client, calls } = stub({ results: [{ hits: [] }] });
  await client.searchMedia("cat", { username: 'we"ird\\name' });
  const filter = calls[0].body.queries[0].filter;
  assert.ok(filter.includes('user.username = "we\\"ird\\\\name"'),
    JSON.stringify(filter));
  calls.length = 0;
  await client.searchMedia("cat", {});
  assert.ok(!calls[0].body.queries[0].filter.some((f) => f.startsWith("user.username")));
});

test("fetchModels QUIRK: query+username sends only username, filters keyword client-side", async () => {
  const item = (name) => ({
    id: 1, name, type: "LORA",
    modelVersions: [{ baseModel: "SDXL 1.0", images: [{ url: "u1", nsfwLevel: 1 }], files: [] }],
  });
  const { client, calls } = stub({ items: [item("Anime Style"), item("Realism Pack")], metadata: {} });
  const page = await client.fetchModels({ type: "LORA", query: "anime", username: "artist" });
  const url = new URL(calls[0].url);
  // both together return an empty page server-side — query must NOT be sent
  assert.equal(url.searchParams.has("query"), false);
  assert.equal(url.searchParams.get("username"), "artist");
  assert.deepEqual(page.models.map((m) => m.name), ["Anime Style"]);
});

test("fetchModels without username still sends query server-side", async () => {
  const { client, calls } = stub({ items: [], metadata: {} });
  await client.fetchModels({ type: "LORA", query: "anime" });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("query"), "anime");
  assert.equal(url.searchParams.has("username"), false);
});

test("fetchTopCreators parses the leaderboard tRPC shape", async () => {
  const entry = (username, position, extra = {}) => ({
    position, score: position * 100,
    user: { username, ...extra },
    metrics: [
      { type: "downloadCount", value: 12345 },
      { type: "thumbsUpCount", value: 678 },
    ],
  });
  const { client } = stub({
    result: { data: { json: [
      entry("alpha", 1),
      entry("gone", 2, { deletedAt: "2026-01-01" }), // dropped
      { position: 3, user: {} },                      // no username — dropped
      entry("beta", 4),
    ] } },
  });
  const top = await client.fetchTopCreators({ limit: 25 });
  assert.deepEqual(top.map((c) => c.username), ["alpha", "beta"]);
  assert.equal(top[0].position, 1);
  assert.equal(top[0].downloads, 12345);
  assert.equal(top[0].thumbsUp, 678);
});

test("fetchTopCreators degrades to [] on an unexpected payload", async () => {
  const { client } = stub({ result: { data: { json: { error: "nope" } } } });
  assert.deepEqual(await client.fetchTopCreators(), []);
});

test("searchCreators shapes /v1/creators and short-circuits empty queries", async () => {
  const { client, calls } = stub({ items: [
    { username: "alpha", modelCount: 3 },
    { username: "", modelCount: 1 }, // dropped
    { username: "beta" },
  ] });
  const out = await client.searchCreators("  alp  ");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/creators");
  assert.equal(url.searchParams.get("query"), "alp");
  assert.deepEqual(out, [
    { username: "alpha", modelCount: 3 },
    { username: "beta", modelCount: 0 },
  ]);
  calls.length = 0;
  assert.deepEqual(await client.searchCreators("   "), []);
  assert.equal(calls.length, 0); // no network call for a blank query
});
