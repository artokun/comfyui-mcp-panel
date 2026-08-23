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
  applyIdeogram4PromptBuilderWrite,
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
  assert.match(src, /import \{[\s\S]*classifyIdeogram4PromptBuilderWrite,[\s\S]*applyIdeogram4PromptBuilderWrite,[\s\S]*ideogram4PromptBuilderRefusal,[\s\S]*\} from "\.\/lib\/ideogram4-prompt-builder\.js";/);

  const handler = src.slice(src.indexOf("async graph_set_widget("));
  assert.ok(handler.startsWith("async graph_set_widget("), "graph_set_widget handler not found");
  const guardAt = handler.indexOf("classifyIdeogram4PromptBuilderWrite(node, widget)");
  const writeAt = handler.indexOf("await runSetWidget(");
  assert.ok(guardAt > 0, "the guard is not called from graph_set_widget");
  assert.ok(writeAt > 0, "runSetWidget call site not found in graph_set_widget");
  assert.ok(guardAt < writeAt, "the guard must run BEFORE runSetWidget");
  assert.match(handler.slice(guardAt, writeAt), /throw new Error\(ideogram4PromptBuilderRefusal\(widget, node\.id\)\)/);
});

function editorFixture({ boxes = [], importLink = null, importMode = "when empty", originMode = 0 } = {}) {
  const node = {
    id: 217,
    type: TYPE,
    _boxes: boxes.map((box) => ({ ...box })),
    _stylePalette: ["#112233"],
    inputs: [{ name: "import_json", link: importLink }],
    graph: {
      links: importLink == null ? {} : { [importLink]: { origin_id: 91 } },
      getNodeById: () => ({ mode: originMode }),
    },
    widgets: [
      { name: "high_level_description", value: "existing subject" },
      { name: "background", value: "existing background" },
      { name: "style", value: "photo" },
      { name: "style.photo", value: "film still" },
      { name: "aesthetics", value: "grainy" },
      { name: "lighting", value: "soft" },
      { name: "medium", value: "35mm" },
      { name: "import_mode", value: importMode },
      { name: "style_palette_data", value: "[\"#112233\"]" },
      {
        name: IDEOGRAM4_ELEMENTS_WIDGET,
        value: "",
        // KJNodes returns an empty string, rather than JSON [], for an empty editor.
        serializeValue: () => (node._boxes.length ? JSON.stringify(node._boxes) : ""),
      },
    ],
  };
  node.onExecuted = (message) => {
    const caption = JSON.parse(message.caption[0]);
    const elements = caption.compositional_deconstruction.elements;
    node._boxes = elements.map((element) => {
      const [ymin, xmin, ymax, xmax] = element.bbox ?? [30, 30, 170, 250];
      return {
        x: xmin / 1000,
        y: ymin / 1000,
        w: (xmax - xmin) / 1000,
        h: (ymax - ymin) / 1000,
        type: element.type,
        text: element.text || "",
        desc: element.desc || "",
        palette: element.color_palette || [],
        ...(element.bbox ? {} : { nobbox: true }),
      };
    });
    node._stylePalette = caption.style_description?.color_palette ?? [];
  };
  return node;
}

test("#1650: elements_data rehydrates the live editor and verifies the serialized regions", () => {
  const node = editorFixture({
    boxes: [{ x: 0, y: 0, w: 0.2, h: 0.2, type: "obj", text: "", desc: "old" }],
  });
  node.widgets.find((w) => w.name === "style_palette_data").value = "[\"#abcdef\"]";
  const calls = [];
  const result = applyIdeogram4PromptBuilderWrite(
    node,
    JSON.stringify([
      {
        x: 0.1,
        y: 0.2,
        w: 0.3,
        h: 0.4,
        type: "text",
        text: "NEW",
        desc: "new region",
        palette: ["#abcdef"],
        locked: true,
      },
    ]),
    {
      beforeChange: () => calls.push("before"),
      afterChange: () => calls.push("after"),
      setDirty: () => calls.push("dirty"),
    },
  );
  assert.deepEqual(calls, ["before", "after", "dirty"]);
  assert.deepEqual(result.ideogram4_prompt_builder, {
    node_id: 217,
    widget: "elements_data",
    driven: true,
    editor_driven: true,
    previous_regions: 1,
    regions: 1,
    verified: true,
  });
  assert.equal(node._boxes[0].text, "NEW");
  assert.equal(node._boxes[0].locked, true, "editor-only lock state survives the import route");
  assert.equal(node.widgets.find((w) => w.name === IDEOGRAM4_ELEMENTS_WIDGET).value, JSON.stringify(node._boxes));
  assert.equal(node.widgets.find((w) => w.name === "high_level_description").value, "existing subject");
  assert.deepEqual(node._stylePalette, ["#abcdef"], "the live hidden palette value is preserved");
});

test("#1650: an empty region list clears the editor without requiring an import wire", () => {
  const node = editorFixture({
    boxes: [{ x: 0, y: 0, w: 0.2, h: 0.2, type: "obj", text: "", desc: "old" }],
  });
  const result = applyIdeogram4PromptBuilderWrite(node, "[]");
  assert.equal(result.ideogram4_prompt_builder.previous_regions, 1);
  assert.equal(result.ideogram4_prompt_builder.regions, 0);
  assert.deepEqual(node._boxes, []);
});

test("#1650: always-mode import_json remains authoritative", () => {
  const node = editorFixture({ importLink: 7, importMode: "always", boxes: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] });
  assert.throws(
    () => applyIdeogram4PromptBuilderWrite(node, "[]"),
    /live import_json connection.*authoritative/,
  );
  assert.equal(node._boxes.length, 1, "the ambiguous write does not touch the editor");
});

test("#1650: when-empty import_json permits replacement while local regions exist", () => {
  const node = editorFixture({ importLink: 7, boxes: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] });
  const result = applyIdeogram4PromptBuilderWrite(node, "[]");
  assert.equal(result.ideogram4_prompt_builder.verified, true);
  assert.deepEqual(node._boxes, []);
});

test("#1650: muted import_json links do not block local editor writes", () => {
  const node = editorFixture({ importLink: 7, importMode: "always", originMode: 2, boxes: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] });
  const result = applyIdeogram4PromptBuilderWrite(node, "[]");
  assert.equal(result.ideogram4_prompt_builder.verified, true);
  assert.deepEqual(node._boxes, []);
});

test("#1650: nobbox regions retain unplaced semantics through rehydration", () => {
  const node = editorFixture({ boxes: [{ x: 0, y: 0, w: 0.2, h: 0.2 }] });
  const result = applyIdeogram4PromptBuilderWrite(node, JSON.stringify([
    { x: 0.5, y: 0.5, w: 0.1, h: 0.1, nobbox: true, desc: "unplaced" },
  ]));
  assert.equal(result.ideogram4_prompt_builder.verified, true);
  assert.equal(node._boxes[0].nobbox, true);
  assert.equal(node._boxes[0].desc, "unplaced");
});

test("#1650: incompatible callback failures roll back the editor", () => {
  const node = editorFixture({ boxes: [{ x: 0, y: 0, w: 0.2, h: 0.2, desc: "old" }] });
  const before = JSON.stringify(node._boxes);
  node.onExecuted = () => { node._boxes = [{ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }]; };
  assert.throws(() => applyIdeogram4PromptBuilderWrite(node, "[]"), /did not rehydrate/);
  assert.equal(JSON.stringify(node._boxes), before);
});

test("#1650: palette mismatches are not reported as verified", () => {
  const node = editorFixture({ boxes: [{ x: 0, y: 0, w: 0.2, h: 0.2, palette: ["#00f"] }] });
  const before = JSON.stringify(node._boxes);
  node.onExecuted = () => { node._boxes = [{ x: 0, y: 0, w: 0.2, h: 0.2, palette: ["#00f"] }]; };
  assert.throws(
    () => applyIdeogram4PromptBuilderWrite(node, JSON.stringify([
      { x: 0, y: 0, w: 0.2, h: 0.2, palette: ["#f00"] },
    ])),
    /did not rehydrate/,
  );
  assert.equal(JSON.stringify(node._boxes), before);
});

test("#1650: malformed region input is rejected before opening an undo step", () => {
  const node = editorFixture();
  let before = 0;
  assert.throws(
    () => applyIdeogram4PromptBuilderWrite(node, JSON.stringify([{ x: 0, y: 0, w: 2, h: 0.1 }]), { beforeChange: () => before++ }),
    /outside the normalized/,
  );
  assert.equal(before, 0);
});
