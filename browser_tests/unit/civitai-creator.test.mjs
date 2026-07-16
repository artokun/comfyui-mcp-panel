// Unit tests for the CivitAI creator filter plumbing (cmcp-civitai.js):
// Meili escaping order, the /v1/models query×username API quirk, leaderboard
// parsing, /v1/creators search shaping, and username threading into every
// query the explorer makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CivitaiClient, DEFAULT_FILTERS, filtersDirty } from "../../web/js/cmcp-civitai.js";

/** Client whose proxy calls are captured. `payload` may be a single response
 *  (every call resolves it) or an array consumed one per call (last repeats). */
const stub = (payload) => {
  const calls = [];
  const pages = Array.isArray(payload) ? [...payload] : null;
  const client = new CivitaiClient({
    fetchApi: async (_path, opts) => {
      calls.push(JSON.parse(opts.body));
      const body = pages ? (pages.length > 1 ? pages.shift() : pages[0]) : payload;
      return { ok: true, json: async () => body };
    },
    apiURL: (p) => p,
  });
  return { client, calls };
};

/** A minimal /v1/models item whose cover survives _modelFromJson at PG. */
const modelItem = (name) => ({
  id: 1, name, type: "LORA",
  modelVersions: [{ baseModel: "SDXL 1.0", images: [{ url: "u1", nsfwLevel: 1 }], files: [] }],
});

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
  const { client, calls } = stub({ items: [modelItem("Anime Style"), modelItem("Realism Pack")], metadata: {} });
  const page = await client.fetchModels({ type: "LORA", query: "anime", username: "artist" });
  const url = new URL(calls[0].url);
  // both together return an empty page server-side — query must NOT be sent
  assert.equal(url.searchParams.has("query"), false);
  assert.equal(url.searchParams.get("username"), "artist");
  assert.deepEqual(page.models.map((m) => m.name), ["Anime Style"]);
  assert.equal(calls.length, 1); // matched on page one — no chase
});

test("fetchModels default path is ONE request — even on an empty page with a cursor", async () => {
  // no creator filter → no page-chasing, identical to pre-creator behavior
  const empty = { items: [], metadata: { nextCursor: "c2" } };
  {
    const { client, calls } = stub(empty);
    const page = await client.fetchModels({ type: "LORA" });
    assert.equal(calls.length, 1);
    assert.equal(page.nextCursor, "c2");
  }
  {
    const { client, calls } = stub(empty);
    await client.fetchModels({ type: "LORA", query: "anime" }); // keyword only
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).searchParams.get("query"), "anime");
  }
  {
    const { client, calls } = stub(empty);
    await client.fetchModels({ type: "LORA", username: "artist" }); // creator only
    assert.equal(calls.length, 1);
  }
});

test("fetchModels keyword×creator chases past client-side-emptied pages", async () => {
  const { client, calls } = stub([
    { items: [modelItem("Realism Pack")], metadata: { nextCursor: "c2" } }, // filtered to zero
    { items: [modelItem("Anime Style")], metadata: { nextCursor: "c3" } },  // match — stop
  ]);
  const page = await client.fetchModels({ type: "LORA", query: "anime", username: "artist" });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("cursor"), "c2"); // hop used the page-1 cursor
  assert.deepEqual(page.models.map((m) => m.name), ["Anime Style"]);
  assert.equal(page.nextCursor, "c3"); // resumes AFTER the matched page
});

test("fetchModels keyword×creator chase is capped (initial + 4 hops)", async () => {
  const { client, calls } = stub({
    items: [modelItem("Realism Pack")], // never matches "anime"
    metadata: { nextCursor: "again" },
  });
  const page = await client.fetchModels({ type: "LORA", query: "anime", username: "artist" });
  assert.equal(calls.length, 5);
  assert.deepEqual(page.models, []);
  assert.equal(page.nextCursor, "again"); // caller can keep going explicitly
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
