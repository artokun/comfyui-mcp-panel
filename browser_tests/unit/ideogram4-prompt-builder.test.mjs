/**
 * comfyui-mcp#1569 — a write to `elements_data` on `Ideogram4PromptBuilderKJ` is refused,
 * because it cannot reach the render.
 *
 * Established from the pack's own source (comfyui-kjnodes
 * `web/js/ideogram4_prompt_builder.js`), not from the report: the widget installs a
 * `serializeValue()` that returns `JSON.stringify(node._boxes)` and never reads
 * `widget.value`, and ComfyUI's `graphToPrompt` queues `serializeValue()` when a widget
 * defines one. `serialize()` then refreshes the widget FROM `node._boxes` on every editor
 * commit, and `onConfigure` prefers the node's own saved blob over the widget on reload.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyIdeogram4PromptBuilderWrite,
  ideogram4PromptBuilderRefusal,
  IDEOGRAM4_PROMPT_BUILDER_TYPE,
  IDEOGRAM4_ELEMENTS_WIDGET,
} from "../../web/js/lib/ideogram4-prompt-builder.js";

const TYPE = IDEOGRAM4_PROMPT_BUILDER_TYPE;

/** A live node shaped like the pack builds it: the elements widget carries its own
 *  serializer, the prompt fields do not. Mirrors the widget set in the krea2-combo
 *  workflow that the report was filed against. */
const builderNode = ({ withSerializer = true } = {}) => ({
  id: 217,
  type: TYPE,
  widgets: [
    { name: "high_level_description", value: "old subject" },
    { name: "background", value: "old background" },
    { name: "style", value: "photo" },
    { name: "style_palette_data", value: "[]" },
    {
      name: IDEOGRAM4_ELEMENTS_WIDGET,
      value: '[{"type":"obj","desc":"Margot Robbie portrait"}]',
      ...(withSerializer ? { serializeValue: () => "[]" } : {}),
    },
  ],
});

test("#1569: the reported write is classified derived", () => {
  assert.equal(classifyIdeogram4PromptBuilderWrite(builderNode(), IDEOGRAM4_ELEMENTS_WIDGET), "derived");
  // A composite sub-field addresses the same widget and must not slip past the guard.
  assert.equal(classifyIdeogram4PromptBuilderWrite(builderNode(), "elements_data.0"), "derived");
});

test("#1569: the node's ORDINARY prompt fields stay writable", () => {
  // These are plain string widgets with no serializer of their own, which is exactly why
  // the reporter's new strings DID apply. Refusing them would block real work.
  for (const w of ["high_level_description", "background", "style", "aesthetics", "lighting", "medium"]) {
    assert.equal(classifyIdeogram4PromptBuilderWrite(builderNode(), w), null, w);
  }
});

test("#1569: style_palette_data is deliberately NOT refused", () => {
  // The pack installs `serializeValue` on the elements widget and on no other, so this
  // write DOES reach the queue for the run at hand. It is fragile — the next editor
  // interaction refreshes it from `node._stylePalette` — but a write that reaches the
  // render must not be refused.
  assert.equal(classifyIdeogram4PromptBuilderWrite(builderNode(), "style_palette_data"), null);
});

test("#1569: `elements_data` on an UNRELATED node type is untouched", () => {
  const other = { id: 3, type: "SomeOtherNode", widgets: [{ name: "elements_data", value: "[]", serializeValue: () => "[]" }] };
  assert.equal(classifyIdeogram4PromptBuilderWrite(other, "elements_data"), null);
});

test("#1569: the guard is gated on the SERIALIZER, so it cannot outlive its proof", () => {
  // The override is the fact that makes the write dead. A later KJNodes build that drops it
  // and honours the assignment must stop being refused, with no change to this module.
  assert.equal(
    classifyIdeogram4PromptBuilderWrite(builderNode({ withSerializer: false }), IDEOGRAM4_ELEMENTS_WIDGET),
    null,
  );
});

test("#1569: an ABSENT widget is not classified", () => {
  // The ordinary write path already reports an unresolved widget, and that message is more
  // accurate than this one would be.
  assert.equal(classifyIdeogram4PromptBuilderWrite({ id: 1, type: TYPE, widgets: [] }, IDEOGRAM4_ELEMENTS_WIDGET), null);
  assert.equal(classifyIdeogram4PromptBuilderWrite({ id: 1, type: TYPE }, IDEOGRAM4_ELEMENTS_WIDGET), null);
});

test("#1569: a THROWING serializeValue accessor fails closed", () => {
  const node = { id: 7, type: TYPE, widgets: [{ name: IDEOGRAM4_ELEMENTS_WIDGET }] };
  Object.defineProperty(node.widgets[0], "serializeValue", {
    get() {
      throw new Error("poisoned accessor");
    },
  });
  // Unreadable is not evidence the override is gone, and this is already the node type and
  // widget the pack derives — so it must not hand back the silent success.
  assert.equal(classifyIdeogram4PromptBuilderWrite(node, IDEOGRAM4_ELEMENTS_WIDGET), "derived");
});

test("#1569: malformed inputs are classified null, never thrown on", () => {
  assert.equal(classifyIdeogram4PromptBuilderWrite(null, IDEOGRAM4_ELEMENTS_WIDGET), null);
  assert.equal(classifyIdeogram4PromptBuilderWrite(undefined, IDEOGRAM4_ELEMENTS_WIDGET), null);
  assert.equal(classifyIdeogram4PromptBuilderWrite(builderNode(), null), null);
  assert.equal(classifyIdeogram4PromptBuilderWrite(builderNode(), 42), null);
});

test("#1569: the refusal names the mechanism and a remedy that works", () => {
  const msg = ideogram4PromptBuilderRefusal(IDEOGRAM4_ELEMENTS_WIDGET, 217);
  assert.match(msg, /panel_set_widget cannot drive "elements_data" on Ideogram4PromptBuilderKJ node 217/);
  // The mechanism, so the caller does not retry the write three times.
  assert.match(msg, /serializeValue/);
  assert.match(msg, /#1569/);
  // The remedies. `import_json` is the node's own programmatic entry point (declared
  // force_input in its INPUT_TYPES), and the CLIPTextEncode bypass is the reporter's own
  // verified workaround.
  assert.match(msg, /import_json/);
  assert.match(msg, /CLIPTextEncode/);
  // It must not read as "this node is unwritable".
  assert.match(msg, /still writable/);
});

test("#1569: the guard is WIRED into graph_set_widget, ahead of the generic write path", () => {
  // A helper-only suite stays green when the call site is deleted, which is the whole
  // failure this asserts against. The refusal has to run BEFORE runSetWidget, or the write
  // lands and reports success before anyone asks whether it can reach the render.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /import \{\s*classifyIdeogram4PromptBuilderWrite,\s*ideogram4PromptBuilderRefusal,\s*\} from "\.\/lib\/ideogram4-prompt-builder\.js";/);

  const handler = src.slice(src.indexOf("async graph_set_widget("));
  assert.ok(handler.startsWith("async graph_set_widget("), "graph_set_widget handler not found");
  const guardAt = handler.indexOf("classifyIdeogram4PromptBuilderWrite(node, widget)");
  const writeAt = handler.indexOf("await runSetWidget(");
  assert.ok(guardAt > 0, "the guard is not called from graph_set_widget");
  assert.ok(writeAt > 0, "runSetWidget call site not found in graph_set_widget");
  assert.ok(guardAt < writeAt, "the guard must run BEFORE runSetWidget");
  assert.match(handler.slice(guardAt, writeAt), /throw new Error\(ideogram4PromptBuilderRefusal\(widget, node\.id\)\)/);
});
