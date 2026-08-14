// #1569 — a write can succeed on the WIDGET and still not reach the QUEUE.
//
// The reporter set every prompt field on an `Ideogram4PromptBuilderKJ`, including
// `elements_data` and `style_palette_data` to `[]`. `panel_set_widget` reported success and
// `panel_query_graph` showed the new values — then `panel_run` produced the *old* subject,
// because the node's execution state had not moved.
//
// The verification step is why that reads as success: it compares against `w.value`, which
// is what the UI shows. ComfyUI does not queue `w.value`. `graphToPrompt` asks the widget
// for `serializeValue()` when it defines one, and a custom node whose real state lives
// somewhere else derives that from the state — so the two diverge, and the divergence is
// invisible to a check that only ever reads one of them.
//
// This cannot fix the third-party node. What it can stop is reporting SUCCESS for a write
// that will not take effect: the tool must compare what it wrote against what will actually
// be sent, and say so when they differ.
import test from "node:test";
import assert from "node:assert/strict";

import { applyWidgetWrite } from "../../web/js/lib/widget-write.js";

/** A node whose widget SHOWS one value and SERIALIZES another — the shape of a custom
 *  prompt-builder that keeps its authoritative state outside the widget. */
function builderNode({ serialized }) {
  const widget = {
    name: "elements_data",
    type: "text",
    value: "[]",
    // What ComfyUI actually queues. Deliberately ignores `value`, exactly like a node that
    // rebuilds its payload from internal state a plain assignment never touched.
    serializeValue: () => serialized,
  };
  return {
    node: { id: 7, type: "Ideogram4PromptBuilderKJ", widgets: [widget], properties: {} },
    widget,
  };
}

const write = (node, name, value, opts = {}) =>
  applyWidgetWrite(node, name, value, {
    registry: { Ideogram4PromptBuilderKJ: {} },
    ...opts,
  });

test("#1569 a write whose SERIALIZED value diverges is not reported as success", () => {
  // The reported case: the widget takes the new value, the queue still sends the old one.
  const { node } = builderNode({ serialized: '[{"subject":"Margot Robbie portrait"}]' });
  let failed = false;
  let message = "";
  try {
    write(node, "elements_data", "[]");
  } catch (err) {
    failed = true;
    message = err instanceof Error ? err.message : String(err);
  }
  assert.ok(failed, "a write the queue will not honour must not report success");
  // It has to name the actual problem, or the user goes looking at their prompt text.
  assert.match(message, /serial/i);
  assert.match(message, /elements_data/);
});

test("#1569 the message says the CANVAS moved and the QUEUE did not", () => {
  const { node } = builderNode({ serialized: '[{"subject":"stale"}]' });
  const message = (() => {
    try {
      write(node, "elements_data", "[]");
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  })();
  // Both halves matter. "It failed" would send the user to re-set the widget, which is
  // exactly what they already did three times.
  assert.match(message, /queue|run|execut/i);
  assert.ok(
    /\[\]/.test(message) && /stale/.test(message),
    `both the written and the serialized value must appear: ${message}`,
  );
});

test("#1569 a widget with NO serializeValue is unaffected", () => {
  // The overwhelmingly common case. Core widgets serialize from `value`, so there is
  // nothing to compare and nothing may change about their behaviour.
  const widget = { name: "text", type: "text", value: "old" };
  const node = { id: 8, type: "CLIPTextEncode", widgets: [widget], properties: {} };
  applyWidgetWrite(node, "text", "new", { registry: { CLIPTextEncode: {} } });
  assert.equal(widget.value, "new");
});

test("#1569 a serializeValue that AGREES is a normal success", () => {
  // A custom node that honours the assignment must not start failing.
  const widget = {
    name: "elements_data",
    type: "text",
    value: "[]",
    serializeValue() {
      return this.value;
    },
  };
  const node = { id: 9, type: "Ideogram4PromptBuilderKJ", widgets: [widget], properties: {} };
  applyWidgetWrite(node, "elements_data", "[]", {
    registry: { Ideogram4PromptBuilderKJ: {} },
  });
  assert.equal(widget.value, "[]");
});

test("#1569 a THROWING serializeValue does not fail the write", () => {
  // The check is a diagnostic. A node whose serializer throws under inspection is a
  // different problem, and turning it into a failed write would break writes that work.
  const widget = {
    name: "elements_data",
    type: "text",
    value: "[]",
    serializeValue() {
      throw new Error("cannot serialize outside a queue pass");
    },
  };
  const node = { id: 10, type: "Ideogram4PromptBuilderKJ", widgets: [widget], properties: {} };
  applyWidgetWrite(node, "elements_data", "[]", {
    registry: { Ideogram4PromptBuilderKJ: {} },
  });
  assert.equal(widget.value, "[]");
});
