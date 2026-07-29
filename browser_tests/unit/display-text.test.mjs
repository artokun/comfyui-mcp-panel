import { test } from "node:test";
import assert from "node:assert/strict";
import { toDisplayText } from "../../web/js/lib/display-text.js";

test("passes plain strings through unchanged", () => {
  assert.equal(toDisplayText("hello"), "hello");
  assert.equal(toDisplayText(""), "");
});

test("nullish coerces to empty string, not the literal 'null'/'undefined'", () => {
  assert.equal(toDisplayText(null), "");
  assert.equal(toDisplayText(undefined), "");
});

test("primitives stringify readably", () => {
  assert.equal(toDisplayText(42), "42");
  assert.equal(toDisplayText(true), "true");
});

test("structured backend failure never renders as [object Object] (#176)", () => {
  const out = toDisplayText({
    error: "Individual quota reached. Please upgrade your subscription to increase your limits.",
  });
  assert.equal(out, "Individual quota reached. Please upgrade your subscription to increase your limits.");
  assert.ok(!out.includes("[object Object]"));
});

test("prefers a message field, then serializes unknown objects as JSON", () => {
  assert.equal(toDisplayText({ message: "boom" }), "boom");
  const json = toDisplayText({ code: 1, kind: "quota" });
  assert.ok(!json.includes("[object Object]"));
  assert.deepEqual(JSON.parse(json), { code: 1, kind: "quota" });
});

test("unwraps a nested { error: { message } } payload", () => {
  assert.equal(toDisplayText({ error: { message: "nested detail" } }), "nested detail");
});

test("Error instances render their message", () => {
  assert.equal(toDisplayText(new Error("kaboom")), "kaboom");
});

test("a cyclic object degrades to a constructor hint, never [object Object]", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const out = toDisplayText(cyclic);
  assert.ok(!out.includes("[object Object]"));
});
