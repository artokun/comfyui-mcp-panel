import { test } from "node:test";
import assert from "node:assert/strict";

import { coerceMessageText, buttonReplyText } from "../../web/js/lib/chat-serialize.js";

test("strings pass through unchanged", () => {
  assert.equal(coerceMessageText("hello"), "hello");
  assert.equal(coerceMessageText(""), "");
});

test("null/undefined become empty string", () => {
  assert.equal(coerceMessageText(null), "");
  assert.equal(coerceMessageText(undefined), "");
});

test("primitives coerce with String()", () => {
  assert.equal(coerceMessageText(42), "42");
  assert.equal(coerceMessageText(true), "true");
});

test("a plain object never renders as [object Object] (#219/#176/#175/#168)", () => {
  const out = coerceMessageText({ foo: 1, bar: 2 });
  assert.notEqual(out, "[object Object]");
  assert.equal(out, '{"foo":1,"bar":2}');
});

test("known string field is extracted from a card reply object (#219)", () => {
  assert.equal(coerceMessageText({ reply: "Yes" }), "Yes");
  assert.equal(coerceMessageText({ label: "Click me" }), "Click me");
  assert.equal(coerceMessageText({ value: "v" }), "v");
});

test("string-field priority prefers reply/text over value", () => {
  assert.equal(coerceMessageText({ value: "v", text: "t", reply: "r" }), "r");
  assert.equal(coerceMessageText({ value: "v", text: "t" }), "t");
});

test("structured backend error object extracts a readable message (#176)", () => {
  assert.equal(
    coerceMessageText({ error: "Individual quota reached." }),
    "Individual quota reached.",
  );
  assert.equal(coerceMessageText({ message: "boom" }), "boom");
});

test("empty string fields are skipped in favor of JSON", () => {
  const out = coerceMessageText({ reply: "", code: 1 });
  assert.notEqual(out, "[object Object]");
  assert.equal(out, '{"reply":"","code":1}');
});

test("cyclic / unserializable objects degrade to empty string, never [object Object]", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const out = coerceMessageText(cyclic);
  assert.notEqual(out, "[object Object]");
  assert.equal(out, "");
});

// buttonReplyText is the A2UI Button click chokepoint — the value it returns is
// exactly what ctx.choose()/sendCardReply() forward into user_message.text, so
// these assertions exercise the real #219 regression path (a button click must
// emit a STRING, never "[object Object]").
test("a normal string Button reply passes through (#219)", () => {
  assert.equal(buttonReplyText({ reply: "Approve" }), "Approve");
});

test("a Button click always yields a string, even for an object reply (#219)", () => {
  const out = buttonReplyText({ reply: { unexpected: "object" } });
  assert.equal(typeof out, "string");
  assert.notEqual(out, "[object Object]");
});

test("a SUBMIT button with an object reply does NOT bake [object Object] into the fields template (#219)", () => {
  const fields = [
    { name: "email", read: () => "a@b.com" },
    { name: "note", read: () => "hi" },
  ];
  const out = buttonReplyText({ reply: { bad: 1 }, submit: true }, fields);
  assert.equal(typeof out, "string");
  assert.ok(!out.includes("[object Object]"), `got: ${out}`);
  assert.ok(out.includes("email: a@b.com"));
  assert.ok(out.includes("note: hi"));
});

test("falls back to label when reply is absent", () => {
  assert.equal(buttonReplyText({ label: "Cancel" }), "Cancel");
});
