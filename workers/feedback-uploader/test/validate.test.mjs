import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFeedback, MAX_BODY_BYTES } from "../src/validate.js";

const good = () => ({
  schema: "comfyui-mcp.feedback/1",
  id: "0b6e8a4e-1111-2222-3333-444455556666",
  timestamp: "2026-07-15T00:00:00.000Z",
  verdict: "good",
  why: "nailed it",
  versions: { model: "gemma4:e4b", panel: "0.8.2", mcp: null, backend: "ollama", comfyui: "1.19.9" },
  transcript: [
    { role: "user", text: "make an image" },
    { role: "agent", text: "done" },
  ],
});

test("accepts the documented payload and echoes the sanitized shape", () => {
  const r = validateFeedback(good());
  assert.equal(r.ok, true);
  assert.equal(r.feedback.verdict, "good");
  assert.equal(r.feedback.why, "nailed it");
  assert.equal(r.feedback.versions.model, "gemma4:e4b");
  assert.equal(r.feedback.versions.mcp, null);
  assert.equal(r.feedback.transcript.length, 2);
});

test("rejects a missing or unknown verdict", () => {
  for (const verdict of [undefined, "meh", 1, null]) {
    const r = validateFeedback({ ...good(), verdict });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("verdict")));
  }
});

test("rejects a missing/empty/malformed transcript", () => {
  for (const transcript of [undefined, [], "hi", [{ noRole: true }], [null]]) {
    const r = validateFeedback({ ...good(), transcript });
    assert.equal(r.ok, false, JSON.stringify(transcript));
    assert.ok(r.errors.some((e) => e.includes("transcript")));
  }
});

test("rejects non-object bodies and wrong schema tags", () => {
  assert.equal(validateFeedback(null).ok, false);
  assert.equal(validateFeedback([1, 2]).ok, false);
  assert.equal(validateFeedback("x").ok, false);
  const r = validateFeedback({ ...good(), schema: "something-else/9" });
  assert.equal(r.ok, false);
});

test("unknown top-level fields are dropped from the stored object", () => {
  const r = validateFeedback({ ...good(), email: "x@y.z", hostname: "mybox", extra: 1 });
  assert.equal(r.ok, true);
  assert.ok(!("email" in r.feedback));
  assert.ok(!("hostname" in r.feedback));
  assert.ok(!("extra" in r.feedback));
});

test("optional fields degrade to null; why is capped", () => {
  const r = validateFeedback({ verdict: "bad", transcript: [{ role: "user", text: "x" }] });
  assert.equal(r.ok, true);
  assert.equal(r.feedback.id, null);
  assert.deepEqual(r.feedback.versions, { model: null, panel: null, mcp: null, backend: null, comfyui: null });
  assert.ok(!("why" in r.feedback));
  const long = validateFeedback({ ...good(), why: "y".repeat(10_000) });
  assert.equal(long.ok, true);
  assert.equal(long.feedback.why.length, 4_000);
});

test("body cap constant is sane (>= the panel's transcript cap)", () => {
  assert.ok(MAX_BODY_BYTES >= 700_000);
});
