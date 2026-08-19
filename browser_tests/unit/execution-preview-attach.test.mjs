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
  recordExecutionPreviewOwner,
  holdsStolenExecutionPreview,
  executionPreviewOwnerLedger,
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

// ---------------------------------------------------------------------------
// #1374 — the sweep gated on node TYPE, so an image-capable victim of id reuse
// (VAEDecode / ImageScale / EmptyLatentImage) kept the previous occupant's
// preview. Ownership is now proven per id, per emitting node object.
// ---------------------------------------------------------------------------

/** The store entry ComfyUI writes for an emitting node, as ONE object identity. */
function outputEntry(filename = "ComfyUI_00001_.png") {
  return { images: [{ filename, type: "output", subfolder: "" }] };
}

function imageCapableNode(type, id) {
  const outputs =
    type === "EmptyLatentImage" ? [{ name: "LATENT", type: "LATENT" }] : [{ name: "IMAGE", type: "IMAGE" }];
  return {
    id,
    type,
    size: [210, 266],
    widgets: [previewWidget()],
    imgs: [{ src: "/view?filename=ComfyUI_00001_.png" }],
    images: [{ filename: "ComfyUI_00001_.png", type: "output" }],
    outputs,
    computeSize() { return [210, 46]; },
    setSize(size) { this.size = size; },
  };
}

/**
 * Run 1: `save` emits at `id` and the store entry is recorded as its own.
 * Returns the ledger and the exact entry object the store holds.
 */
function runOneEmission(id, owners) {
  const save = saveImageNode(id);
  const entry = outputEntry();
  const nodeOutputs = { [String(id)]: entry };
  const graph = { _nodes: [save] };
  stripMisattachedExecutionPreviews({
    graph,
    nodeOutputs,
    nodePreviewImages: {},
    preferNodeId: id,
    owners,
  });
  return { save, entry, nodeOutputs };
}

for (const victimType of ["VAEDecode", "ImageScale", "EmptyLatentImage"]) {
  test(`#1374: ${victimType} inheriting a reused id does NOT keep the emitter's preview`, () => {
    const owners = new Map();
    const { entry, nodeOutputs } = runOneEmission(9, owners);

    // ComfyUI's own paste / undo / load reuses id 9 for a DIFFERENT node. The panel
    // never sees that edit, so the store entry SaveImage emitted is still sitting there.
    const victim = imageCapableNode(victimType, 9);
    const graph = { _nodes: [victim] };
    const { stripped } = stripMisattachedExecutionPreviews({
      graph,
      nodeOutputs,
      nodePreviewImages: {},
      owners,
    });

    assert.equal(stripped, 1, `${victimType} kept a preview it never emitted`);
    assert.equal(victim.imgs, undefined);
    assert.equal(victim.widgets.some((w) => w.name === CANVAS_IMAGE_PREVIEW_WIDGET), false);
    assert.equal(nodeOutputs["9"], undefined);
    assert.deepEqual(victim.size, [210, 46]);
    assert.equal(entry.images.length, 1, "the emitter's own entry object is not mutated");
  });
}

test("#1374: the emitting node keeps its own preview across later sweeps", () => {
  const owners = new Map();
  const { save, nodeOutputs } = runOneEmission(9, owners);
  const graph = { _nodes: [save] };

  // execution_success backstop, then a later run's sweep — the owner never loses it.
  stripMisattachedExecutionPreviews({ graph, nodeOutputs, nodePreviewImages: {}, owners });
  stripMisattachedExecutionPreviews({ graph, nodeOutputs, nodePreviewImages: {}, owners });

  assert.ok(save.imgs?.length, "the node that emitted was stripped");
  assert.ok(nodeOutputs["9"]?.images?.length);
});

test("#1374: a same-type recreate/undo at the same id keeps the preview ComfyUI re-plants", () => {
  const owners = new Map();
  const { nodeOutputs } = runOneEmission(9, owners);

  // "Fix node (recreate)" and ChangeTracker undo both hand back a NEW object at the
  // same id, and ComfyUI deliberately re-plants the preview from the surviving store
  // entry. Stripping there would delete a preview the frontend means to show.
  const recreated = saveImageNode(9);
  const graph = { _nodes: [recreated] };
  const { stripped } = stripMisattachedExecutionPreviews({
    graph,
    nodeOutputs,
    nodePreviewImages: {},
    owners,
  });

  assert.equal(stripped, 0);
  assert.ok(recreated.imgs?.length);
  assert.ok(nodeOutputs["9"]?.images?.length);
});

test("#1374: a REPLACED store entry is not judged — restored /history outputs survive", () => {
  const owners = new Map();
  const { nodeOutputs } = runOneEmission(9, owners);

  // ComfyUI's queue "Load" does loadGraphData() (which clean()s the stores) and then
  // repopulates app.nodeOutputs from the job payload: brand-new node objects AND
  // brand-new entry objects. Nothing here is evidence of a steal.
  nodeOutputs["9"] = outputEntry("restored_00007_.png");
  const restored = imageCapableNode("VAEDecode", 9);
  const graph = { _nodes: [restored] };
  const { stripped } = stripMisattachedExecutionPreviews({
    graph,
    nodeOutputs,
    nodePreviewImages: {},
    owners,
  });

  assert.equal(stripped, 0);
  assert.ok(restored.imgs?.length);
  assert.ok(nodeOutputs["9"]?.images?.length);
});

test("#1374: with no emission on record an image-capable node is left alone", () => {
  const owners = new Map();
  const decode = imageCapableNode("VAEDecode", 9);
  const nodeOutputs = { "9": outputEntry() };
  const { stripped } = stripMisattachedExecutionPreviews({
    graph: { _nodes: [decode] },
    nodeOutputs,
    nodePreviewImages: {},
    owners,
  });
  assert.equal(stripped, 0);
  assert.ok(decode.imgs?.length);
});

test("#1374: a stolen b_preview frame is swept too, not just executed outputs", () => {
  const owners = new Map();
  const ksampler = {
    id: 4,
    type: "KSampler",
    outputs: [{ name: "LATENT", type: "LATENT" }],
    widgets: [],
    computeSize() { return [270, 262]; },
    setSize(size) { this.size = size; },
  };
  const frame = ["data:image/png;base64,AAAA"];
  const nodePreviewImages = { "4": frame };
  stripMisattachedExecutionPreviews({
    graph: { _nodes: [ksampler] },
    nodeOutputs: {},
    nodePreviewImages,
    preferNodeId: 4,
    owners,
  });

  const victim = imageCapableNode("ImageScale", 4);
  victim.imgs = undefined;
  victim.images = undefined;
  const { stripped } = stripMisattachedExecutionPreviews({
    graph: { _nodes: [victim] },
    nodeOutputs: {},
    nodePreviewImages,
    owners,
  });
  assert.equal(stripped, 1);
  assert.equal(nodePreviewImages["4"], undefined);
});

test("#1374: the ledger stays graph-sized — records for vanished ids are pruned", () => {
  const owners = new Map();
  const { nodeOutputs } = runOneEmission(9, owners);
  assert.equal(owners.size, 1);

  // The node was removed and the panel's remove hook wiped its store entry: the
  // record now describes nothing, so it must not accumulate run after run.
  delete nodeOutputs["9"];
  stripMisattachedExecutionPreviews({
    graph: { _nodes: [] },
    nodeOutputs,
    nodePreviewImages: {},
    owners,
  });
  assert.equal(owners.size, 0);
});

test("#1374: holdsStolenExecutionPreview only fires on positive evidence", () => {
  const owners = new Map();
  const save = saveImageNode(9);
  const entry = outputEntry();
  const stores = { nodeOutputs: { "9": entry }, nodePreviewImages: {} };
  recordExecutionPreviewOwner(owners, save, stores);

  assert.equal(holdsStolenExecutionPreview(owners, save, stores), false, "the owner itself");
  assert.equal(
    holdsStolenExecutionPreview(owners, imageCapableNode("VAEDecode", 9), stores),
    true,
    "a different node of a different type on the same entry",
  );
  assert.equal(
    holdsStolenExecutionPreview(owners, imageCapableNode("VAEDecode", 11), stores),
    false,
    "a different id",
  );
  assert.equal(holdsStolenExecutionPreview(null, save, stores), false);
});

test("#1374: the PANEL's own call shape (no ledger argument) reaches the fix", () => {
  // The production call sites pass {graph, nodeOutputs, nodePreviewImages, preferNodeId}
  // and nothing else, so the module-level ledger is the one that must carry ownership
  // from one run to the next. Drive exactly that shape.
  executionPreviewOwnerLedger().clear();

  const save = saveImageNode(9);
  const entry = outputEntry();
  const nodeOutputs = { "9": entry };
  // onExecuted: `executed` named node 9.
  stripMisattachedExecutionPreviews({
    graph: { _nodes: [save] },
    nodeOutputs,
    nodePreviewImages: {},
    preferNodeId: 9,
  });
  // onExecutionSuccess backstop.
  stripMisattachedExecutionPreviews({
    graph: { _nodes: [save] },
    nodeOutputs,
    nodePreviewImages: {},
  });

  const victim = imageCapableNode("VAEDecode", 9);
  const { stripped } = stripMisattachedExecutionPreviews({
    graph: { _nodes: [victim] },
    nodeOutputs,
    nodePreviewImages: {},
  });

  assert.equal(stripped, 1);
  assert.equal(nodeOutputs["9"], undefined);
  executionPreviewOwnerLedger().clear();
});

test("#1374: onExecuted still hands the sweep the id that emitted", () => {
  // Without preferNodeId there is no per-run proof of emission and the ledger can
  // never be seeded, so the type gate would be the only gate again.
  const onExecuted = panelSrc.match(/function onExecuted\(ev\) \{[\s\S]*?\n {2}function onExecError/);
  assert.ok(onExecuted, "onExecuted body not found");
  assert.match(onExecuted[0], /stripMisattachedExecutionPreviews\(\{[\s\S]*?preferNodeId: nodeId/);
});
