// #1286 — after a live-canvas add + run, ComfyUI plants $$canvas-image-preview
// on a ConditioningConcat (or any non-image node) whose id received the
// executed / b_preview store entry. These tests drive the SHIPPED helpers in
// web/js/lib/execution-preview-attach.js and pin the panel call sites so the
// wiring cannot be dropped.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CANVAS_IMAGE_PREVIEW_WIDGET,
  nodeAcceptsExecutionImagePreview,
  clearStoredExecutionOutputs,
  stripNodeExecutionPreview,
  clearInheritedExecutionPreview,
  stripMisattachedExecutionPreviews,
} from "../../web/js/lib/execution-preview-attach.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL = join(__dirname, "..", "..", "web", "js", "comfyui-mcp-panel.js");
const panelSrc = readFileSync(PANEL, "utf8");

function previewWidget() {
  return { name: CANVAS_IMAGE_PREVIEW_WIDGET, value: "", onRemove() { this.removed = true; } };
}

function concatNode(id = 73) {
  return {
    id,
    type: "ConditioningConcat",
    size: [153, 266],
    widgets: [previewWidget()],
    imgs: [{ src: "/view?filename=ComfyUI_00001_.png" }],
    images: [{ filename: "ComfyUI_00001_.png", type: "output" }],
    outputs: [{ name: "CONDITIONING", type: "CONDITIONING" }],
    computeSize() { return [153, 46]; },
    setSize(size) { this.size = size; },
  };
}

function saveImageNode(id = 9) {
  return {
    id,
    type: "SaveImage",
    constructor: { nodeData: { output_node: true } },
    widgets: [previewWidget()],
    imgs: [{ src: "/view?filename=ComfyUI_00001_.png" }],
    images: [{ filename: "ComfyUI_00001_.png", type: "output" }],
    outputs: [],
  };
}

test("#1286: ConditioningConcat does not accept an execution image preview", () => {
  assert.equal(
    nodeAcceptsExecutionImagePreview({
      type: "ConditioningConcat",
      outputs: [{ type: "CONDITIONING" }],
      widgets: [],
    }),
    false,
  );
});

test("#1286: SaveImage / PreviewImage / KSampler / LoadImage do accept previews", () => {
  assert.equal(nodeAcceptsExecutionImagePreview({ type: "SaveImage", constructor: { nodeData: { output_node: true } } }), true);
  assert.equal(nodeAcceptsExecutionImagePreview({ type: "PreviewImage" }), true);
  assert.equal(nodeAcceptsExecutionImagePreview({ type: "KSampler", outputs: [{ type: "LATENT" }] }), true);
  assert.equal(
    nodeAcceptsExecutionImagePreview({
      type: "LoadImage",
      widgets: [{ name: "image", value: "x.png" }],
    }),
    true,
  );
});

test("#1286: stripMisattachedExecutionPreviews removes the preview from ConditioningConcat and keeps SaveImage", () => {
  const concat = concatNode(73);
  const save = saveImageNode(9);
  const nodeOutputs = {
    "9": { images: [{ filename: "ComfyUI_00001_.png", type: "output" }] },
    "73": { images: [{ filename: "ComfyUI_00001_.png", type: "output" }] },
  };
  const nodePreviewImages = { "73": ["blob:stolen"] };

  const result = stripMisattachedExecutionPreviews({
    graph: { _nodes: [save, concat] },
    nodeOutputs,
    nodePreviewImages,
    preferNodeId: 9,
  });

  assert.equal(result.stripped, 1);
  assert.equal(concat.imgs, undefined);
  assert.equal(concat.images, undefined);
  assert.equal(concat.widgets.some((w) => w.name === CANVAS_IMAGE_PREVIEW_WIDGET), false);
  assert.deepEqual(concat.size, [153, 46]);
  assert.equal(nodeOutputs["73"], undefined);
  assert.equal(nodePreviewImages["73"], undefined);
  assert.ok(nodeOutputs["9"]?.images?.length);
  assert.equal(save.imgs.length, 1);
  assert.equal(save.widgets.some((w) => w.name === CANVAS_IMAGE_PREVIEW_WIDGET), true);
});

test("#1286: stolen outputs with no SaveImage store entry are re-homed onto the emitting node", () => {
  const concat = concatNode(73);
  const save = saveImageNode(9);
  save.imgs = undefined;
  save.images = undefined;
  const nodeOutputs = {
    "73": { images: [{ filename: "final.png", type: "output" }] },
  };

  const result = stripMisattachedExecutionPreviews({
    graph: { _nodes: [save, concat] },
    nodeOutputs,
    nodePreviewImages: {},
    preferNodeId: "9",
  });

  assert.equal(result.rehomed, true);
  assert.equal(nodeOutputs["9"]?.images?.[0]?.filename, "final.png");
  assert.equal(nodeOutputs["73"], undefined);
  assert.equal(concat.imgs, undefined);
});

test("#1286: a KSampler live preview is not stripped", () => {
  const sampler = {
    id: 3,
    type: "KSampler",
    outputs: [{ type: "LATENT" }],
    widgets: [previewWidget()],
    imgs: [{ src: "blob:latent" }],
  };
  const nodeOutputs = { "3": { images: [{ filename: "preview.png", type: "temp" }] } };
  const result = stripMisattachedExecutionPreviews({
    graph: { _nodes: [sampler] },
    nodeOutputs,
    preferNodeId: 3,
  });
  assert.equal(result.stripped, 0);
  assert.equal(sampler.imgs.length, 1);
  assert.ok(nodeOutputs["3"]);
});

test("#1286: clearInheritedExecutionPreview drops leftover store entries on a newly added id", () => {
  const node = {
    id: 73,
    type: "ConditioningConcat",
    widgets: [previewWidget()],
    imgs: undefined,
  };
  const nodeOutputs = { "73": { images: [{ filename: "old-save.png", type: "output" }] } };
  const changed = clearInheritedExecutionPreview(node, { nodeOutputs, nodePreviewImages: {} });
  assert.equal(changed, true);
  assert.equal(nodeOutputs["73"], undefined);
  assert.equal(node.widgets.some((w) => w.name === CANVAS_IMAGE_PREVIEW_WIDGET), false);
});

test("#1286: clearInheritedExecutionPreview does not wipe a LoadImage's hydrating imgs", () => {
  const node = {
    id: 12,
    type: "LoadImage",
    widgets: [{ name: "image", value: "in.png" }],
    imgs: [{ src: "/view?filename=in.png" }],
  };
  const changed = clearInheritedExecutionPreview(node, { nodeOutputs: {}, nodePreviewImages: {} });
  assert.equal(changed, false);
  assert.equal(node.imgs.length, 1);
});

test("#1286: clearStoredExecutionOutputs accepts number or string ids", () => {
  const nodeOutputs = { 9: { images: [1] }, "73": { images: [2] } };
  assert.equal(clearStoredExecutionOutputs({ nodeOutputs }, "9"), true);
  assert.equal(nodeOutputs[9], undefined);
  assert.equal(clearStoredExecutionOutputs({ nodeOutputs }, 73), true);
  assert.equal(nodeOutputs["73"], undefined);
});

test("#1286: stripNodeExecutionPreview invokes the pseudo-widget onRemove", () => {
  const node = concatNode(73);
  const widget = node.widgets[0];
  stripNodeExecutionPreview(node, { nodeOutputs: { "73": { images: [1] } }, nodePreviewImages: {} });
  assert.equal(widget.removed, true);
  assert.equal(node.widgets.length, 0);
});

test("#1286: the panel imports and calls the shipped sanitizer on the add / remove / run paths", () => {
  assert.match(panelSrc, /from "\.\/lib\/execution-preview-attach\.js"/);
  assert.match(panelSrc, /clearInheritedExecutionPreview/);
  assert.match(panelSrc, /clearStoredExecutionOutputs/);
  assert.match(panelSrc, /stripMisattachedExecutionPreviews/);

  const addFn = panelSrc.match(/\n {2}async graph_add_node\(\{ class_type, pos, title \}\) \{[\s\S]*?\n {2}\},/);
  assert.ok(addFn, "graph_add_node body not found");
  assert.match(addFn[0], /clearInheritedExecutionPreview\(/);

  const removeFn = panelSrc.match(/\n {2}graph_remove_node\(\{ node_id \}\) \{[\s\S]*?\n {2}\},/);
  assert.ok(removeFn, "graph_remove_node body not found");
  assert.match(removeFn[0], /clearStoredExecutionOutputs\(/);

  assert.match(panelSrc, /function onExecuted\(/);
  const onExecuted = panelSrc.match(/function onExecuted\(ev\) \{[\s\S]*?\n {2}function onExecError/);
  assert.ok(onExecuted, "onExecuted body not found");
  assert.match(onExecuted[0], /stripMisattachedExecutionPreviews\(/);

  const onSuccess = panelSrc.match(/function onExecutionSuccess\(ev\) \{[\s\S]*?\n {2}function onExecutionStart/);
  assert.ok(onSuccess, "onExecutionSuccess body not found");
  assert.match(onSuccess[0], /stripMisattachedExecutionPreviews\(/);
});
