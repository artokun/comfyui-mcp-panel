import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coerceMessageText,
  buttonReplyText,
  isDroppedAgentReplay,
  serializeContext,
} from "../../web/js/lib/chat-serialize.js";

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

// --- sidebar render of a completed OUTPUT payload (#238) --------------------
// The LIVE `say` handler now routes a structured payload through
// coerceMessageText before onSay/paintAgent, so a completed render/output
// object must serialize to readable text, never "[object Object]".
test("a completed output payload renders as readable text in the sidebar path (#238)", () => {
  const out = coerceMessageText({ caption: "portrait_00001.png", filename: "portrait_00001.png" });
  assert.notEqual(out, "[object Object]");
  assert.equal(out, "portrait_00001.png");
});

test("an output payload with no known label degrades to JSON, never [object Object] (#238)", () => {
  const out = coerceMessageText({ type: "output", images: [{ subfolder: "", node: 9 }] });
  assert.notEqual(out, "[object Object]");
  assert.ok(!out.includes("[object Object]"), `got: ${out}`);
  assert.ok(out.startsWith("{"), `expected JSON, got: ${out}`);
});

// --- persisted structured assistant message replay (#241) ------------------
// paintAgent(m.text) on history replay now re-normalizes through the SAME
// serializer, so a record whose `text` is a structured object rehydrates as
// readable text after reload/restart instead of "[object Object]".
test("a persisted structured assistant message rehydrates as readable text (#241)", () => {
  const record = { role: "agent", text: { text: "Here are your outputs." } };
  const out = coerceMessageText(record.text);
  assert.notEqual(out, "[object Object]");
  assert.equal(out, "Here are your outputs.");
});

test("a persisted codex-style content-parts assistant message replays as joined text (#241)", () => {
  const record = {
    role: "agent",
    text: { content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] },
  };
  const out = coerceMessageText(record.text);
  assert.notEqual(out, "[object Object]");
  assert.equal(out, "line one\nline two");
});

// --- replay drop decision (#241 codex round-1 follow-up) -------------------
// paintAgent drops a record on replay iff isDroppedAgentReplay(text) — ONLY an
// object that coerced to nothing. A genuinely-empty STRING is valid stored
// input and must still render its (empty) bubble.
test("a persisted empty-STRING assistant record is NOT dropped on replay (renders empty bubble) (#241)", () => {
  assert.equal(isDroppedAgentReplay(""), false);
  // and it coerces to "" so the empty bubble is what renders
  assert.equal(coerceMessageText(""), "");
});

test("a persisted structured object that coerces to '' IS dropped on replay (#241)", () => {
  // Only a value that coerces to "" is dropped — e.g. an unserializable/cyclic
  // object (the old "[object Object]" case). A serializable object like {} is
  // NOT dropped; it coerces to readable JSON ("{}") and renders.
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(isDroppedAgentReplay(cyclic), true);
  assert.equal(isDroppedAgentReplay({}), false);
  assert.equal(coerceMessageText({}), "{}");
});

test("a persisted structured object WITH readable text is NOT dropped (#241)", () => {
  assert.equal(isDroppedAgentReplay({ text: "hi" }), false);
  assert.equal(isDroppedAgentReplay({ content: [{ text: "hi" }] }), false);
});

test("null/undefined persisted text is dropped, never rendered as literal 'null' (#241)", () => {
  // These are non-string and carry no content; the pre-fix path rendered the
  // literal "null"/"undefined" via String(). Dropping is strictly better and
  // matches the predicate (a real empty STRING is the only empty kept).
  assert.equal(isDroppedAgentReplay(null), true);
  assert.equal(isDroppedAgentReplay(undefined), true);
});

// --- outbound user_message context serialization (#276) --------------------
// The composer passes context as a `{ workflow, subgraph }` OBJECT, but the
// orchestrator only reads STRING context (it prepends it above the user's
// text). The panel joins context parts into one string, so a raw object would
// coerce via Array.join to the literal "[object Object]" and land above EVERY
// message — the reported #276 symptom. serializeContext() must render readable
// text and NEVER "[object Object]".

// Reproduces the exact pre-fix coercion: joining an object context with the
// same [pending, context].join("\n\n") the bridge uses.
test("PRE-FIX repro: raw join of an object context yields [object Object] (#276)", () => {
  const context = { workflow: "My WF", subgraph: "Detailer" };
  const raw = [null, context].filter(Boolean).join("\n\n");
  assert.equal(raw, "[object Object]"); // this is the bug being fixed
});

test("an object context serializes to readable workflow/subgraph lines, never [object Object] (#276)", () => {
  const out = serializeContext({ workflow: "My WF", subgraph: "Detailer" });
  assert.notEqual(out, "[object Object]");
  assert.ok(!out.includes("[object Object]"), `got: ${out}`);
  assert.equal(out, "Workflow: My WF\nViewing subgraph: Detailer");
});

test("an object context with only a workflow renders a single line (#276)", () => {
  assert.equal(serializeContext({ workflow: "Base" }), "Workflow: Base");
});

test("the merged-context join used on the send path stays a clean string (#276)", () => {
  // Mirror bridge sendUserMessage: [pendingContext, serializeContext(context)]
  const pendingContext = null;
  const context = { workflow: "Base" };
  const merged =
    [pendingContext, serializeContext(context)].filter(Boolean).join("\n\n") || undefined;
  assert.equal(merged, "Workflow: Base");
  assert.ok(!String(merged).includes("[object Object]"));
});

test("a string context (transcript replay) passes through untouched (#276)", () => {
  const replay = "USER: hi\nASSISTANT: hello";
  assert.equal(serializeContext(replay), replay);
});

test("null/empty context serializes to '' so it drops out of the join (#276)", () => {
  assert.equal(serializeContext(null), "");
  assert.equal(serializeContext(undefined), "");
  assert.equal(serializeContext({}), "");
});

test("an unknown-shape object context degrades to JSON, never [object Object] (#276)", () => {
  const out = serializeContext({ foo: 1, bar: 2 });
  assert.notEqual(out, "[object Object]");
  assert.ok(!out.includes("[object Object]"), `got: ${out}`);
  assert.equal(out, '{"foo":1,"bar":2}');
});
