// #1569 — a widget write can land on the canvas and not reach the QUEUE.
//
// The reporter set every prompt field on an `Ideogram4PromptBuilderKJ`, including
// `elements_data` to `[]`. `panel_set_widget` reported success and `panel_query_graph`
// showed the new values — then `panel_run` produced the old subject.
//
// The panel already fires the widget's callback, so that is not the cause. ComfyUI does not
// queue `w.value`: `graphToPrompt` asks the widget for `serializeValue()` when it defines
// one, and a node that keeps its authoritative state elsewhere builds that from the state.
//
// ## Why this only DISCLOSES, and never checks
//
// The first version of this fix sampled `serializeValue()` before and after the write and
// failed when a real change left it identical. Review killed it against a real upstream
// node, on two independent grounds:
//
//   * CALLING IT HAS SIDE EFFECTS. `RecordAudio`'s serializer stops an active recording and
//     starts an upload. A before/after comparison would do that twice, to satisfy a
//     diagnostic.
//   * AND IT IS ASYNC there, so every call returns a fresh Promise — never comparable.
//
// A check that can fail a working write, or stop a user's recording, is worse than the bug
// it reports. So this asks only whether the widget defines its own serializer, never calls
// it, and attaches a note to the SUCCESS result.
import test from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite } from "../../web/js/lib/widget-write.js";

const NODE = "Ideogram4PromptBuilderKJ";
const registry = { [NODE]: {}, CLIPTextEncode: {}, KSampler: {} };
const write = (node, name, value) => applyWidgetWrite(node, name, value, { registry });

/** A prompt-builder-shaped widget: its own serializer, and a counter proving whether we
 *  ever call it. */
function builderNode({ value = '[{"subject":"Margot Robbie portrait"}]' } = {}) {
  const calls = { n: 0 };
  const widget = {
    name: "elements_data",
    type: "text",
    value,
    serializeValue() {
      calls.n += 1;
      return '[{"subject":"whatever the node kept"}]';
    },
  };
  return { node: { id: 7, type: NODE, widgets: [widget], properties: {} }, widget, calls };
}

test("#1569 a write on a self-serializing widget still SUCCEEDS", () => {
  // It must not become a failure. The widget genuinely accepted the value, and whether the
  // queue honours it cannot be established from here.
  const { node, widget } = builderNode();
  const result = write(node, "elements_data", "[]");
  assert.equal(widget.value, "[]");
  assert.ok(result, "the write returns a result rather than throwing");
});

test("#1569 …and carries a note saying the NODE decides what gets queued", () => {
  const { node } = builderNode();
  const result = write(node, "elements_data", "[]");
  const note = result.queue_value_note;
  assert.ok(note, "a self-serializing widget must disclose that the queue may differ");
  assert.match(note, /serializeValue/);
  assert.match(note, /queue/i);
  // The remedy is the point: without it the user re-sets the widget, which is the loop the
  // reporter spent three attempts in.
  assert.match(note, /will not help/i);
  assert.match(note, /CLIPTextEncode|ComfyUI UI/);
  // And it must not read as a failure, because nothing failed.
  assert.doesNotMatch(note, /refus|rolled back|did not retain/i);
});

test("#1569 the serializer is NEVER invoked", () => {
  // The load-bearing property. Upstream's RecordAudio stops a live recording and starts an
  // upload from inside its serializer; sampling it for a diagnostic is not acceptable.
  const { node, calls } = builderNode();
  write(node, "elements_data", "[]");
  assert.equal(calls.n, 0, "a diagnostic must not run the node's serializer");
});

test("#1569 an ASYNC serializer is handled by not calling it", () => {
  // The other half of the review finding: an async serializer returns a fresh Promise per
  // call, so any before/after comparison is meaningless. Not calling it makes the question
  // moot — and the write must still succeed, with the note.
  let called = 0;
  const widget = {
    name: "audioUI",
    type: "audioUI",
    value: "old.wav",
    async serializeValue() {
      called += 1;
      return "recorded.wav";
    },
  };
  const node = { id: 20, type: NODE, widgets: [widget], properties: {} };
  const result = applyWidgetWrite(node, "audioUI", "new.wav", { registry });
  assert.equal(widget.value, "new.wav");
  assert.equal(called, 0, "an async serializer is never awaited because it is never called");
  assert.ok(result.queue_value_note);
});

test("#1569 a widget with NO serializer says nothing", () => {
  // The overwhelmingly common case. A core widget serializes from `value`, so there is
  // nothing to disclose and the note would be pure noise.
  const widget = { name: "text", type: "text", value: "old" };
  const node = { id: 8, type: "CLIPTextEncode", widgets: [widget], properties: {} };
  const result = applyWidgetWrite(node, "text", "new", { registry });
  assert.equal(widget.value, "new");
  assert.equal(result.queue_value_note, undefined);
});

test("#1569 a write that requests NO change says nothing", () => {
  // Re-writing the current value cannot have gone stale, and callers make idempotent writes
  // constantly while reconciling a graph.
  const { node } = builderNode({ value: "[]" });
  const result = write(node, "elements_data", "[]");
  assert.equal(result.queue_value_note, undefined);
});

test("#1569 a THROWING serializeValue accessor is not an answer", () => {
  // Reading the property can itself throw. That is not "this widget self-serializes"; it is
  // no information, and it must not break a write that otherwise worked.
  const widget = { name: "elements_data", type: "text", value: "old" };
  Object.defineProperty(widget, "serializeValue", {
    get() {
      throw new Error("poisoned accessor");
    },
    configurable: true,
  });
  const node = { id: 15, type: NODE, widgets: [widget], properties: {} };
  const result = applyWidgetWrite(node, "elements_data", "[]", { registry });
  assert.equal(widget.value, "[]");
  assert.equal(result.queue_value_note, undefined);
});

test("#1569 the note is a SEPARATE field from write_warning", () => {
  // write_warning means something went wrong during the write. This means the write was
  // fine and the node owns what gets queued. Merging them would make a routine disclosure
  // read as a problem — and a real problem read as routine.
  const { node } = builderNode();
  const result = write(node, "elements_data", "[]");
  assert.ok(result.queue_value_note);
  assert.equal(result.write_warning, undefined);
});
