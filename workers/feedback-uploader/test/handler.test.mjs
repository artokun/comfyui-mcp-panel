// End-to-end handler tests under plain node --test: Node 18+ ships the same
// Request/Response/fetch/crypto Web APIs the Workers runtime exposes, so the
// module Worker's fetch() runs as-is — with globalThis.fetch stubbed to stand
// in for S3.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const ENV = {
  S3_BUCKET: "test-bucket",
  S3_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const payload = () => ({
  schema: "comfyui-mcp.feedback/1",
  verdict: "good",
  transcript: [{ role: "user", text: "hello" }],
  versions: { panel: "0.8.2" },
});

const post = (body, headers = {}) =>
  new Request("https://collector.example.com/", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const realFetch = globalThis.fetch;
let putCalls;
beforeEach(() => {
  putCalls = [];
  globalThis.fetch = async (url, init) => {
    putCalls.push({ url: String(url), init });
    return new Response("", { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("happy path: validates, signs, PUTs to S3, answers 200", async () => {
  const res = await worker.fetch(post(payload()), ENV);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(putCalls.length, 1);
  const { url, init } = putCalls[0];
  assert.match(url, /^https:\/\/test-bucket\.s3\.us-east-1\.amazonaws\.com\/feedback\/\d{4}\/\d{2}\/\d{2}\/good-[0-9a-f-]{36}\.json$/);
  assert.equal(init.method, "PUT");
  assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  const stored = JSON.parse(init.body);
  assert.equal(stored.verdict, "good");
  assert.ok(stored.received_at); // server-side timestamp added
  assert.ok(!("email" in stored));
});

test("S3_ENDPOINT switches to path-style addressing (R2/MinIO)", async () => {
  const res = await worker.fetch(post(payload()), {
    ...ENV,
    S3_ENDPOINT: "https://accountid.r2.cloudflarestorage.com/",
  });
  assert.equal(res.status, 200);
  assert.match(putCalls[0].url, /^https:\/\/accountid\.r2\.cloudflarestorage\.com\/test-bucket\/feedback\//);
});

test("rejects non-POST and answers OPTIONS preflight with CORS", async () => {
  const get = await worker.fetch(new Request("https://c.example.com/", { method: "GET" }), ENV);
  assert.equal(get.status, 405);
  const opt = await worker.fetch(new Request("https://c.example.com/", { method: "OPTIONS" }), ENV);
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
  assert.match(opt.headers.get("access-control-allow-methods"), /POST/);
  assert.equal(putCalls.length, 0);
});

test("ALLOWED_ORIGINS restricts CORS to the listed origins", async () => {
  const env = { ...ENV, ALLOWED_ORIGINS: "http://127.0.0.1:8188, http://localhost:8188" };
  const ok = await worker.fetch(
    new Request("https://c.example.com/", { method: "OPTIONS", headers: { origin: "http://localhost:8188" } }),
    env,
  );
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:8188");
  const nope = await worker.fetch(
    new Request("https://c.example.com/", { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
    env,
  );
  assert.equal(nope.headers.get("access-control-allow-origin"), null);
});

test("answers 503 until bucket/region/credentials are provisioned", async () => {
  const res = await worker.fetch(post(payload()), { S3_REGION: "us-east-1" });
  assert.equal(res.status, 503);
  assert.equal(putCalls.length, 0); // nothing ever leaves before config
});

test("rejects malformed JSON and invalid payloads without touching S3", async () => {
  const bad = await worker.fetch(post("{nope"), ENV);
  assert.equal(bad.status, 400);
  const invalid = await worker.fetch(post({ verdict: "meh", transcript: [] }), ENV);
  assert.equal(invalid.status, 400);
  const details = await invalid.json();
  assert.ok(Array.isArray(details.details));
  assert.equal(putCalls.length, 0);
});

test("caps the body size (declared and actual)", async () => {
  const declared = await worker.fetch(post(payload(), { "content-length": String(10_000_000) }), ENV);
  assert.equal(declared.status, 413);
  const big = { ...payload(), why: "x".repeat(1_100_000) };
  const actual = await worker.fetch(post(big), ENV);
  assert.equal(actual.status, 413);
  assert.equal(putCalls.length, 0);
});

test("maps S3 failures to 502 without leaking details", async () => {
  globalThis.fetch = async () => new Response("<Error>AccessDenied…</Error>", { status: 403 });
  const res = await worker.fetch(post(payload()), ENV);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(!JSON.stringify(body).includes("AccessDenied"));
});
