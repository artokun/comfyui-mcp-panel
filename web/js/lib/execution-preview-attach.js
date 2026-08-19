/**
 * #1286 — execution image previews must stay on the node that emitted them.
 *
 * ComfyUI's frontend keys `app.nodeOutputs` / `app.nodePreviewImages` by
 * `String(node.id)` and `onDrawBackground` then plants `$$canvas-image-preview`
 * on ANY node whose key has images. After a live-canvas add/remove, that key
 * can be a newly created ConditioningConcat (or any non-image node): the
 * executed / b_preview frame was stored under the last-assigned id, or a
 * reused id still held the previous run's images. The node grows from ~46px
 * to ~266px and query_graph reports the pseudo-widget.
 *
 * The panel cannot stop ComfyUI writing the store. It CAN (a) wipe inherited
 * store entries when a node is created or removed, and (b) after a run, strip
 * preview state from every node that cannot emit an image.
 */

export const CANVAS_IMAGE_PREVIEW_WIDGET = "$$canvas-image-preview";

/** Hosts ComfyUI itself treats as canvas-image-preview nodes. */
const PREVIEW_HOST_TYPES = new Set([
  "KSampler",
  "KSamplerAdvanced",
  "PreviewImage",
  "SaveImage",
  "GLSLShader",
]);

const IMAGE_OUTPUT_TYPES = new Set(["IMAGE", "MASK", "LATENT"]);
const IMAGE_WIDGET_NAMES = /^(image|images|mask|video)$/i;

function outputStoreKeys(nodeId) {
  if (nodeId == null) return [];
  const keys = [String(nodeId)];
  if (typeof nodeId === "number") {
    keys.push(nodeId);
  } else {
    const n = Number(nodeId);
    if (Number.isFinite(n) && String(n) === String(nodeId)) keys.push(n);
  }
  return keys;
}

function storeHasImages(bag, nodeId) {
  if (!bag) return false;
  for (const key of outputStoreKeys(nodeId)) {
    const entry = bag[key];
    if (Array.isArray(entry) && entry.length) return true;
    if (entry?.images?.length) return true;
  }
  return false;
}

/**
 * True when this node is a legitimate host for an execution image preview.
 * ConditioningConcat (CONDITIONING only, no image widget) is not.
 */
export function nodeAcceptsExecutionImagePreview(node) {
  if (!node || typeof node !== "object") return false;
  if (PREVIEW_HOST_TYPES.has(String(node.type || ""))) return true;
  if (node.constructor?.nodeData?.output_node) return true;
  if (node.previewMediaType === "image" || node.previewMediaType === "video") return true;
  if (Array.isArray(node.outputs)) {
    for (const out of node.outputs) {
      if (IMAGE_OUTPUT_TYPES.has(String(out?.type || ""))) return true;
    }
  }
  if (Array.isArray(node.widgets)) {
    for (const w of node.widgets) {
      const name = w?.name;
      if (typeof name !== "string" || name === CANVAS_IMAGE_PREVIEW_WIDGET) continue;
      if (IMAGE_WIDGET_NAMES.test(name)) return true;
    }
  }
  return false;
}

/** Drop `app.nodeOutputs` / `app.nodePreviewImages` entries for one id. */
export function clearStoredExecutionOutputs(stores, nodeId) {
  if (!stores || nodeId == null) return false;
  let cleared = false;
  for (const key of outputStoreKeys(nodeId)) {
    for (const bag of [stores.nodeOutputs, stores.nodePreviewImages]) {
      if (bag && Object.prototype.hasOwnProperty.call(bag, key)) {
        delete bag[key];
        cleared = true;
      }
    }
  }
  return cleared;
}

function removePreviewWidget(node) {
  const widgets = node?.widgets;
  if (!Array.isArray(widgets)) return false;
  let removed = false;
  for (let i = widgets.length - 1; i >= 0; i--) {
    if (widgets[i]?.name !== CANVAS_IMAGE_PREVIEW_WIDGET) continue;
    try {
      widgets[i].onRemove?.();
    } catch {
      /* widget already detached */
    }
    widgets.splice(i, 1);
    removed = true;
  }
  return removed;
}

function restoreCompactSize(node) {
  if (typeof node.computeSize !== "function") return;
  try {
    const size = node.computeSize();
    if (typeof node.setSize === "function") node.setSize(size);
    else if (Array.isArray(node.size) && Array.isArray(size) && size.length >= 2) {
      node.size[0] = size[0];
      node.size[1] = size[1];
    }
  } catch {
    /* size restore is best-effort */
  }
}

/**
 * Strip execution preview state from one node (imgs, images, the pseudo-widget,
 * and any store entries keyed by its id). Used for misattached hosts after a run.
 */
export function stripNodeExecutionPreview(node, stores) {
  if (!node) return false;
  let changed = false;
  if (node.imgs != null) {
    node.imgs = undefined;
    changed = true;
  }
  if (node.images != null) {
    node.images = undefined;
    changed = true;
  }
  if (node.preview != null) {
    node.preview = undefined;
    changed = true;
  }
  if (removePreviewWidget(node)) changed = true;
  if (stores && node.id != null && clearStoredExecutionOutputs(stores, node.id)) {
    changed = true;
  }
  if (changed) restoreCompactSize(node);
  return changed;
}

/**
 * A newly created node must not inherit leftover store entries at its id
 * (the id may have belonged to a removed SaveImage/PreviewImage). Does NOT
 * clear `node.imgs` — LoadImage may already be hydrating from its filename.
 */
export function clearInheritedExecutionPreview(node, stores) {
  if (!node) return false;
  let changed = false;
  if (stores && node.id != null && clearStoredExecutionOutputs(stores, node.id)) {
    changed = true;
  }
  if (removePreviewWidget(node)) {
    restoreCompactSize(node);
    changed = true;
  }
  return changed;
}

function moveStoredOutputs(stores, fromId, toId) {
  if (!stores || fromId == null || toId == null) return false;
  const toKey = String(toId);
  let moved = false;
  for (const fromKey of outputStoreKeys(fromId)) {
    if (stores.nodeOutputs && stores.nodeOutputs[fromKey]?.images?.length && !storeHasImages(stores.nodeOutputs, toId)) {
      stores.nodeOutputs[toKey] = stores.nodeOutputs[fromKey];
      moved = true;
    }
    if (
      stores.nodePreviewImages &&
      Array.isArray(stores.nodePreviewImages[fromKey]) &&
      stores.nodePreviewImages[fromKey].length &&
      !storeHasImages(stores.nodePreviewImages, toId)
    ) {
      stores.nodePreviewImages[toKey] = stores.nodePreviewImages[fromKey];
      moved = true;
    }
  }
  return moved;
}

/**
 * After a run: re-home stolen image outputs onto `preferNodeId` when that node
 * is a real host, then strip preview state from every non-host.
 *
 * @returns {{ stripped: number, rehomed: boolean }}
 */
export function stripMisattachedExecutionPreviews({
  graph,
  nodeOutputs,
  nodePreviewImages,
  preferNodeId,
} = {}) {
  const nodes = graph?._nodes ?? graph?.nodes ?? [];
  const stores = { nodeOutputs, nodePreviewImages };
  let rehomed = false;

  if (preferNodeId != null) {
    const prefer = nodes.find((n) => n && String(n.id) === String(preferNodeId));
    if (prefer && nodeAcceptsExecutionImagePreview(prefer)) {
      const preferHas =
        storeHasImages(nodeOutputs, preferNodeId) || storeHasImages(nodePreviewImages, preferNodeId);
      if (!preferHas) {
        for (const node of nodes) {
          if (!node || String(node.id) === String(preferNodeId)) continue;
          if (nodeAcceptsExecutionImagePreview(node)) continue;
          if (moveStoredOutputs(stores, node.id, preferNodeId)) rehomed = true;
        }
      }
    }
  }

  let stripped = 0;
  for (const node of nodes) {
    if (!node || nodeAcceptsExecutionImagePreview(node)) continue;
    const hasPreview =
      node.imgs != null ||
      node.images != null ||
      node.preview != null ||
      (Array.isArray(node.widgets) &&
        node.widgets.some((w) => w?.name === CANVAS_IMAGE_PREVIEW_WIDGET)) ||
      storeHasImages(nodeOutputs, node.id) ||
      storeHasImages(nodePreviewImages, node.id);
    if (!hasPreview) continue;
    if (stripNodeExecutionPreview(node, stores)) stripped += 1;
  }
  return { stripped, rehomed };
}
