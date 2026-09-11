import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finishThoughtStream, createProcessPresentation } from "../../web/js/lib/dsh-transcript.js";

test("thought-only segments close without an empty assistant commit", () => {
  const removed = [];
  const state = { commitText: null, thinkBody: { textContent: "" }, thinkTarget: "reasoning", thinkShown: 0,
    el: { classList: { remove: value => removed.push(value) } }, replyEl: { classList: { remove: value => removed.push(value) } } };
  const streams = new Map([["first", state]]), animating = new Set([state]);
  let collapsed = false;
  assert.equal(finishThoughtStream("first", streams, animating, () => collapsed = true, "Thinking"), true);
  assert.equal(state.thinkBody.textContent, "reasoning");
  assert.equal(streams.size, 0); assert.equal(animating.size, 0); assert(collapsed);
  assert.deepEqual(removed, ["streaming", "streaming-cursor"]);
  assert.equal(finishThoughtStream("first", streams, animating, () => {}, "Thinking"), false);
});

test("a pending text commit is not discarded as thought-only", () => {
  const state = { commitText: "answer", thinkBody: {} };
  assert.equal(finishThoughtStream("a", new Map([["a", state]]), new Set(), () => assert.fail(), ""), false);
});

test("process markers work before or after a typewriter commit and never mark the final answer", () => {
  for (const markFirst of [true, false]) {
    const wrapped = [], changed = [], process = createProcessPresentation(el => wrapped.push(el), entry => changed.push(entry));
    const entry = { text: "checking" }, final = { text: "done" }, element = {};
    if (markFirst) process.mark("progress");
    process.register("progress", element, entry);
    if (!markFirst) process.mark("progress");
    process.register("final", {}, final);
    assert.equal(entry.executionProcess, true); assert.equal(final.executionProcess, undefined);
    assert.equal(changed.length, 1); assert.equal(wrapped[0], element);
    process.mark("progress"); assert.equal(changed.length, 1);
  }
});

test("reset prevents a stale marker from changing a new feed", () => {
  const process = createProcessPresentation(() => assert.fail(), () => assert.fail());
  process.mark("same-id"); process.clear(); process.register("same-id", {}, {});
});

test("the shipping renderer wires segment completion, persistence and session-scoped usage", () => {
  const source = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert(source.includes('msg.phase === "think_end"'));
  assert(source.includes('msg.phase === "process"'));
  assert(source.includes("processPresentation.register(s.id, s.el, entry)"));
  assert(source.includes("if (m.executionProcess === true) wrapExecutionProcess(element)"));
  assert(source.includes("s.session_id !== thread?.sessionId"));
  assert(source.includes('ssSet(`${persistKey}:usage`, JSON.stringify(usage))'));
});
