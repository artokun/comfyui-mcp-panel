// Unit tests for the search bar's GitHub-style "@creator" syntax
// (parseCreatorQuery in cmcp-civitai.js): "@bab0zi cyberpunk city rain" →
// creator=bab0zi, search="cyberpunk city rain" — plus the escaping edges when
// the parsed username flows into the Meili filter via searchMedia.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CivitaiClient, parseCreatorQuery } from "../../web/js/cmcp-civitai.js";

test("@name + terms → creator filter + remaining search terms", () => {
  assert.deepEqual(parseCreatorQuery("@bab0zi cyberpunk city rain"),
    { username: "bab0zi", query: "cyberpunk city rain" });
});

test("@name anywhere in the string is picked up, terms keep their order", () => {
  assert.deepEqual(parseCreatorQuery("cyberpunk @bab0zi city rain"),
    { username: "bab0zi", query: "cyberpunk city rain" });
  assert.deepEqual(parseCreatorQuery("cyberpunk city rain @bab0zi"),
    { username: "bab0zi", query: "cyberpunk city rain" });
});

test("@name alone (no terms) just sets the filter", () => {
  assert.deepEqual(parseCreatorQuery("@bab0zi"), { username: "bab0zi", query: "" });
  assert.deepEqual(parseCreatorQuery("  @bab0zi  "), { username: "bab0zi", query: "" });
});

test("no @token → no creator, text passes through", () => {
  assert.deepEqual(parseCreatorQuery("cyberpunk city rain"),
    { username: null, query: "cyberpunk city rain" });
  assert.deepEqual(parseCreatorQuery(""), { username: null, query: "" });
  assert.deepEqual(parseCreatorQuery("   "), { username: null, query: "" });
  assert.deepEqual(parseCreatorQuery(null), { username: null, query: "" });
  assert.deepEqual(parseCreatorQuery(undefined), { username: null, query: "" });
});

test("FIRST @token wins; later @tokens are consumed, not searched literally", () => {
  assert.deepEqual(parseCreatorQuery("@alpha @beta neon"),
    { username: "alpha", query: "neon" });
});

test("a lone '@' is not a creator token — it stays in the search text", () => {
  assert.deepEqual(parseCreatorQuery("@"), { username: null, query: "@" });
  assert.deepEqual(parseCreatorQuery("@ cyberpunk"), { username: null, query: "@ cyberpunk" });
});

test("mid-word @ (emails, handles-in-prose) is NOT creator syntax", () => {
  assert.deepEqual(parseCreatorQuery("mail me@example.com please"),
    { username: null, query: "mail me@example.com please" });
});

test("whitespace runs collapse; token boundaries are any whitespace", () => {
  assert.deepEqual(parseCreatorQuery("  @bab0zi   cyberpunk\tcity \n rain "),
    { username: "bab0zi", query: "cyberpunk city rain" });
});

test("username is returned RAW — quotes/backslashes survive for escapeMeili", () => {
  const parsed = parseCreatorQuery('@we"ird\\name cat');
  assert.equal(parsed.username, 'we"ird\\name');
  assert.equal(parsed.query, "cat");
});

test("parsed username flows into searchMedia's Meili filter escaped", async () => {
  const calls = [];
  const client = new CivitaiClient({
    fetchApi: async (_path, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ results: [{ hits: [] }] }) };
    },
    apiURL: (p) => p,
  });
  const parsed = parseCreatorQuery('@we"ird\\name cyberpunk rain');
  await client.searchMedia(parsed.query, { username: parsed.username });
  const q = calls[0].body.queries[0];
  // per Meili docs, q + filter combine in ONE request: the filter narrows the
  // candidate set, the multi-term q ranks within it
  assert.equal(q.q, "cyberpunk rain");
  assert.ok(q.filter.includes('user.username = "we\\"ird\\\\name"'), JSON.stringify(q.filter));
});
