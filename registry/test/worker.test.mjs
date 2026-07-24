// Registry worker tests — the real fetch handler (registry/src/worker.js)
// driven against a fake D1 (node:sqlite behind D1's prepare/bind API) and a
// fake R2 (Map). Covers publish → list/sort/search → star/unstar → detail →
// bundle → ran → report, plus the hidden-app and ownership guards.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import worker from "../src/worker.js";
import { buildListQuery, creatorIdFor, parseCursor, slugify } from "../src/core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Minimal D1 API over node:sqlite (prepare → bind → first/all/run). */
class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    const sql = readFileSync(path.join(__dirname, "..", "migrations", "0001_init.sql"), "utf8");
    this.db.exec(sql);
  }
  prepare(sql) {
    const db = this.db;
    return {
      bind(...params) {
        const stmt = db.prepare(sql);
        return {
          first: async () => stmt.get(...params) ?? null,
          all: async () => ({ results: stmt.all(...params) }),
          run: async () => {
            const info = stmt.run(...params);
            return { meta: { changes: info.changes } };
          },
        };
      },
    };
  }
}

class FakeR2 {
  constructor() {
    this.map = new Map();
  }
  async put(key, body) {
    this.map.set(key, body);
  }
  async get(key) {
    if (!this.map.has(key)) return null;
    return { body: this.map.get(key) };
  }
}

let env;
before(() => {
  env = { DB: new FakeD1(), BUNDLES: new FakeR2() };
});

const KEY = "ab".repeat(32);
const APP_ID = "123e4567-e89b-42d3-a456-426614174000";

function publishBody(over = {}) {
  return {
    creator_key: KEY,
    creator_name: "Tester",
    app: {
      id: APP_ID,
      name: "Portrait Studio",
      description: "one-tap portraits",
      hide_workflow: false,
      nsfw: false,
      app_mode: { inputs: [{ nodeId: 6, widget: "text" }], outputs: [] },
      deps: {},
      ...over.app,
    },
    prompt: { 6: { class_type: "CLIPTextEncode", inputs: { text: "x" } } },
    workflow: { nodes: [], links: [] },
    ...over,
  };
}

const post = (path, body) =>
  worker.fetch(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }), env);
const get = (path) => worker.fetch(new Request(`http://x${path}`), env);

test("slugify", () => {
  assert.equal(slugify("My Cool App!"), "my-cool-app");
  assert.equal(slugify(""), "app");
  assert.equal(slugify("  --x--  "), "x");
});

test("creatorIdFor hashes the key (key never stored)", async () => {
  const id = await creatorIdFor(KEY);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.notEqual(id, KEY);
});

test("publish → detail → list → search → star → unstar → bundle → ran → report", async () => {
  // publish
  let res = await post("/v1/apps", publishBody());
  assert.equal(res.status, 200);
  const published = await res.json();
  assert.equal(published.slug, "tester/portrait-studio");
  assert.equal(published.version, 1);

  // update bumps version, keeps stars
  res = await post("/v1/apps", publishBody({ app: { id: APP_ID, name: "Portrait Studio", version: 2 } }));
  assert.equal((await res.json()).version, 2);

  // wrong creator can't update
  res = await post("/v1/apps", publishBody({ creator_key: "cd".repeat(32) }));
  assert.equal(res.status, 403);

  // detail by id and by slug
  res = await get(`/v1/apps/${APP_ID}`);
  assert.equal(res.status, 200);
  const detail = (await res.json()).app;
  assert.equal(detail.name, "Portrait Studio");
  assert.equal(detail.stars, 0);
  res = await get("/v1/apps/by-slug/tester/portrait-studio");
  assert.equal(res.status, 200);

  // list (new) + search
  res = await get("/v1/apps?sort=new");
  let list = (await res.json()).apps;
  assert.equal(list.length, 1);
  res = await get("/v1/apps?q=portrait");
  assert.equal((await res.json()).apps.length, 1);
  res = await get("/v1/apps?q=nomatch");
  assert.equal((await res.json()).apps.length, 0);
  res = await get("/v1/apps?creator=tester");
  assert.equal((await res.json()).apps.length, 1);

  // star then unstar (idempotent per key)
  res = await post(`/v1/apps/${APP_ID}/star`, { star_key: "user-1" });
  assert.equal(res.status, 200);
  await post(`/v1/apps/${APP_ID}/star`, { star_key: "user-1" }); // dup = no-op
  await post(`/v1/apps/${APP_ID}/star`, { star_key: "user-2" });
  assert.equal(((await (await get(`/v1/apps/${APP_ID}`)).json()).app).stars, 2);
  // /starred reflects each key's own state
  assert.equal((await (await get(`/v1/apps/${APP_ID}/starred?key=user-1`)).json()).starred, true);
  assert.equal((await (await get(`/v1/apps/${APP_ID}/starred?key=nobody`)).json()).starred, false);
  await post(`/v1/apps/${APP_ID}/unstar`, { star_key: "user-2" });
  assert.equal(((await (await get(`/v1/apps/${APP_ID}`)).json()).app).stars, 1);

  // stars sort
  res = await get("/v1/apps?sort=stars");
  assert.equal((await res.json()).apps[0].stars, 1);

  // bundle round-trips manifest + prompt + workflow
  res = await get(`/v1/apps/${APP_ID}/bundle`);
  assert.equal(res.status, 200);
  const bundle = await res.json();
  assert.equal(bundle.manifest.id, APP_ID);
  assert.ok(bundle.workflow);
  assert.ok(bundle.prompt["6"]);

  // ran: one per marker per day
  await post(`/v1/apps/${APP_ID}/ran`, { star_key: "user-1" });
  await post(`/v1/apps/${APP_ID}/ran`, { star_key: "user-1" });
  assert.equal(((await (await get(`/v1/apps/${APP_ID}`)).json()).app).runs, 1);

  // report
  res = await post(`/v1/apps/${APP_ID}/report`, { reason: "spam" });
  assert.equal(res.status, 200);
});

test("hidden apps carry no workflow — and the API refuses one", async () => {
  const hiddenId = "223e4567-e89b-42d3-a456-426614174001";
  // hidden + workflow = rejected
  let res = await post("/v1/apps", publishBody({ app: { id: hiddenId, name: "Secret", hide_workflow: true } }));
  assert.equal(res.status, 400);
  // hidden without workflow = fine, bundle has no workflow key
  const body = publishBody({ app: { id: hiddenId, name: "Secret", hide_workflow: true } });
  delete body.workflow;
  res = await post("/v1/apps", body);
  assert.equal(res.status, 200);
  const bundle = await (await get(`/v1/apps/${hiddenId}/bundle`)).json();
  assert.equal(bundle.workflow, undefined);
  assert.ok(bundle.prompt);
});

test("publish validation", async () => {
  assert.equal((await post("/v1/apps", { creator_key: "nope" })).status, 401);
  assert.equal((await post("/v1/apps", { creator_key: KEY })).status, 400);
  assert.equal((await post("/v1/apps", publishBody({ app: { id: "not-a-uuid", name: "x" } }))).status, 400);
  assert.equal((await post("/v1/apps", publishBody({ app: { id: APP_ID, name: " " } }))).status, 400);
});

test("buildListQuery: cursor pagination is stable", () => {
  const page1 = buildListQuery({ sort: "new", limit: 2 });
  const page2 = buildListQuery({ sort: "new", limit: 2, cursor: { v: 123, id: "abc" } });
  assert.match(page1.sql, /ORDER BY created_at DESC, id LIMIT \?/);
  assert.match(page2.sql, /created_at < \?/);
  // trending uses the score subquery
  const trending = buildListQuery({ sort: "trending", cursor: { v: 5, id: "x" } });
  assert.match(trending.sql, /AS score/);
  assert.match(trending.sql, /score < \?/);
});

test("parseCursor round-trips and rejects garbage", () => {
  assert.equal(parseCursor(null), null);
  assert.equal(parseCursor("!!!"), null);
  const raw = btoa(JSON.stringify({ v: 3, id: "x" }));
  assert.deepEqual(parseCursor(raw), { v: 3, id: "x" });
});

test("CORS: preflight answered, every response carries allow-origin", async () => {
  const pre = await worker.fetch(new Request("http://x/v1/apps", { method: "OPTIONS" }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const res = await get("/v1/apps");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("publish: oversized bodies are rejected before parsing", async () => {
  const huge = JSON.stringify({ creator_key: KEY, app: { id: APP_ID, name: "x".padEnd(20 * 1024 * 1024, "x") } });
  const res = await worker.fetch(
    new Request("http://x/v1/apps", { method: "POST", body: huge }),
    env,
  );
  assert.equal(res.status, 413);
});

test("pricing_json: invalid values rejected at publish, defensive at read", async () => {
  const res = await post("/v1/apps", publishBody({ app: { id: "423e4567-e89b-42d3-a456-426614174003", name: "Priced", pricing_json: "{not json" } }));
  assert.equal(res.status, 400);
  // A legacy bad value in the DB must not 500 the list (defensive parse).
  await env.DB.prepare(
    "INSERT INTO apps (id, slug, creator_id, creator_name, name, description, version, hide_workflow, nsfw, hosted_only, pricing_json, star_count, run_count, hidden, created_at, updated_at) VALUES ('bad-price', 'x/bad', 'c', 'x', 'Bad', '', 1, 0, 0, 0, '{oops', 0, 0, 0, 1, 1)",
  ).bind().run();
  const list = await (await get("/v1/apps?limit=100")).json();
  assert.ok(list.apps.find((a) => a.id === "bad-price"));
});
