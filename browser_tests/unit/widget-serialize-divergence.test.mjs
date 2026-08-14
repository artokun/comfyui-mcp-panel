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
function builderNode({ serialized, value = '[{"subject":"Margot Robbie portrait"}]' }) {
  const widget = {
    name: "elements_data",
    type: "text",
    // The widget starts holding the OLD content — the write is what clears it to "[]".
    // A fixture that already held "[]" requests no change at all, and the check
    // (correctly) stays silent for that.
    value,
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
    value: "[{\"subject\":\"old\"}]",
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

test("#1569 a TRANSFORMING serializeValue is not mistaken for a stuck one", () => {
  // The reason this compares BEFORE against AFTER rather than against the requested value.
  // Plenty of legitimate serializers do not return `value`: a combo emitting an index, a
  // seed widget emitting a number for a string control. Comparing against what was written
  // would fail every one of those — turning working writes into refusals, which is far
  // worse than the bug.
  const options = ["euler", "dpmpp_2m", "ddim"];
  const widget = {
    name: "sampler_name",
    type: "combo",
    value: "euler",
    // A combo is validated against its declared options before any write, so the fixture
    // has to carry them — without this it refuses for an unrelated reason and proves
    // nothing about serialization.
    options: { values: options },
    // Serializes the INDEX, never the label.
    serializeValue() {
      return options.indexOf(this.value);
    },
  };
  const node = { id: 11, type: "KSampler", widgets: [widget], properties: {} };
  applyWidgetWrite(node, "sampler_name", "ddim", { registry: { KSampler: {} } });
  assert.equal(widget.value, "ddim", "a transforming serializer must not block the write");
  assert.equal(widget.serializeValue(), 2, "and it still serializes its own way");
});

test("#1569 a write that requests NO change is never flagged", () => {
  // Re-writing the current value serializes identically by definition. Flagging that would
  // fail idempotent writes, which callers make constantly when reconciling a graph.
  const widget = {
    name: "elements_data",
    type: "text",
    value: "[]",
    serializeValue: () => '[{"subject":"whatever"}]',
  };
  const node = { id: 12, type: "Ideogram4PromptBuilderKJ", widgets: [widget], properties: {} };
  applyWidgetWrite(node, "elements_data", "[]", {
    registry: { Ideogram4PromptBuilderKJ: {} },
  });
  assert.equal(widget.value, "[]");
});

test("#1569 the message says setting it again will not help, and what to do instead", () => {
  // The remedy is the point of the whole change. "It failed" sends the user back to
  // re-setting the widget — which is exactly the loop the reporter spent three attempts in.
  const { node } = builderNode({ serialized: '[{"subject":"stale"}]' });
  const message = (() => {
    try {
      write(node, "elements_data", "[]");
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  })();
  assert.match(message, /again will not help|will not help/i);
  assert.match(message, /CLIPTextEncode|another way|ComfyUI UI/i);
});

test("#1569 a serializer that becomes UNREADABLE after the write is not a verdict", () => {
  // Isolates the AFTER guard from the BEFORE guard. A serializer that throws on both sides
  // never reaches the after-check, so deleting it left that case passing — while this one,
  // where a clean before-sample is followed by a throwing after-sample, is exactly when a
  // missing guard invents a divergence out of no evidence.
  let calls = 0;
  const widget = {
    name: "elements_data",
    type: "text",
    value: '[{"subject":"old"}]',
    serializeValue() {
      calls += 1;
      if (calls > 1) throw new Error("state torn down by the write");
      return "sampled-before";
    },
  };
  const node = { id: 13, type: "Ideogram4PromptBuilderKJ", widgets: [widget], properties: {} };
  applyWidgetWrite(node, "elements_data", "[]", {
    registry: { Ideogram4PromptBuilderKJ: {} },
  });
  assert.equal(widget.value, "[]", "no clean AFTER sample means no evidence, not a failure");
});

test("#1569 a serializer that only APPEARS after the write is not a verdict", () => {
  // The mirror case, isolating the BEFORE guard: no serializer when sampled, one installed
  // by the widget's callback. There is nothing to compare against, so nothing may be claimed.
  const widget = {
    name: "elements_data",
    type: "text",
    value: '[{"subject":"old"}]',
    callback() {
      widget.serializeValue = () => "appeared";
    },
  };
  const node = { id: 14, type: "Ideogram4PromptBuilderKJ", widgets: [widget], properties: {} };
  applyWidgetWrite(node, "elements_data", "[]", {
    registry: { Ideogram4PromptBuilderKJ: {} },
  });
  assert.equal(widget.value, "[]");
});

test("#1569 a THROWING serializeValue ACCESSOR is not a verdict either", () => {
  // Reading the property can itself throw. That is not the serializer disagreeing — it
  // never ran — so it must read as "no evidence", exactly like a throwing call.
  const widget = {
    name: "elements_data",
    type: "text",
    value: '[{"subject":"old"}]',
  };
  Object.defineProperty(widget, "serializeValue", {
    get() {
      throw new Error("poisoned accessor");
    },
    configurable: true,
  });
  const node = { id: 15, type: "Ideogram4PromptBuilderKJ", widgets: [widget], properties: {} };
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
    value: "[{\"subject\":\"old\"}]",
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
