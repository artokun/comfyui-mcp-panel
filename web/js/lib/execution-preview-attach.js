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
 *
 * #1374 — (b) alone gates on what a node TYPE could ever show, so an
 * image-capable victim (VAEDecode, ImageScale, EmptyLatentImage) that inherits a
 * reused id keeps the previous occupant's preview. Types cannot answer "did THIS
 * node emit?", so the sweep also keeps a small ownership ledger: every `executed`
 * frame names an id, and we remember which node OBJECT held that id plus the exact
 * store entry it received. A later occupant of the same id is judged stolen only on
 * positive evidence -- the very same entry object, under a different node object of
 * a different type. Anything weaker (a replaced entry from a new run or a restored
 * history payload, a same-type recreate/undo whose preview ComfyUI means to restore)
 * is not judged at all and falls back to the type gate.
 *
 * That WIDENS who the sweep looks at (image-capable hosts are no longer exempt), so
 * it deliberately NARROWS what it does to them. An image-capable host owns image
 * state of its own -- LoadImage hydrates `node.imgs` from its filename widget and
 * carries the same `$$canvas-image-preview` widget -- and none of that belongs to the
 * inherited entry. Only state ComfyUI derived FROM the stolen entry is evicted, which
 * is decidable: `unsafeUpdatePreviews` assigns `this.images = output.images` by
 * reference, so `node.images === record.output.images` is exactly "what is on screen
 * is the stolen entry". When that does not hold, only the leftover store entry goes.
 *
 * Known gaps, deliberately not closed here. Both leave an image-capable victim to the
 * pre-existing type gate, which is where it already was, so neither is a regression:
 *
 *   - Ownership is seeded from `executed`, so a node whose only output is `b_preview`
 *     latent frames (a KSampler mid-run) never enters the ledger and is judged by type
 *     alone. Seeding it would mean attributing on `executing` -- ownership from
 *     "started" rather than "emitted" -- a different rule than this issue asks for.
 *   - A gifs/videos-only emitter (VHS_VideoCombine) has no `output.images` for the
 *     frontend to alias, so there is no identity to test and `rendered` is false: the
 *     inherited entry is dropped but a stale animation on an image-capable victim is
 *     not. Deciding that one needs content matching, which is weaker evidence than
 *     anything else here rests on.
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

/** The raw store value at `nodeId`, whatever its shape (identity matters, not content). */
function storeEntry(bag, nodeId) {
  if (!bag || nodeId == null) return undefined;
  for (const key of outputStoreKeys(nodeId)) {
    if (bag[key] !== undefined) return bag[key];
  }
  return undefined;
}

/**
 * #1374 — id -> the node object that was proven to own the store entry at that id,
 * with the exact entry objects it received. Keyed by id because that is the only
 * thing ComfyUI keys previews by; identity-checked because an id is reusable and a
 * type is not proof of anything.
 */
const executionPreviewOwners = new Map();

/** Test seam: the process-wide ledger the panel's call sites use. */
export function executionPreviewOwnerLedger() {
  return executionPreviewOwners;
}

/**
 * Record that `node` owns whatever the stores currently hold at its id. Called for
 * the id an `executed` frame named -- the one piece of per-run evidence ComfyUI
 * gives us about which node actually emitted.
 */
export function recordExecutionPreviewOwner(owners, node, stores) {
  if (!owners || !node || node.id == null) return false;
  owners.set(String(node.id), {
    node,
    type: String(node.type || ""),
    output: storeEntry(stores?.nodeOutputs, node.id),
  });
  return true;
}

/**
 * The ownership record proving this node's id holds an entry a DIFFERENT node -- of a
 * different type -- was credited with, or null. That is a stolen preview: the id was
 * reused (ComfyUI's own paste/undo/load, paths the panel does not hook) while the
 * emitter's entry stayed behind.
 *
 * Deliberately silent when the evidence is weaker:
 *   - no record for this id                  -> nothing was ever proven to emit here
 *   - the entry was replaced                 -> a new run, or restored /history outputs
 *   - the new occupant has the SAME type     -> a recreate/undo whose preview ComfyUI
 *                                               means to re-plant from the store
 */
function stolenExecutionPreviewRecord(owners, node, stores) {
  if (!owners || !node || node.id == null) return null;
  const record = owners.get(String(node.id));
  if (!record || record.node === node) return null;
  if (record.type === String(node.type || "")) return null;
  if (record.output === undefined) return null;
  return storeEntry(stores?.nodeOutputs, node.id) === record.output ? record : null;
}

/** Boolean form of {@link stolenExecutionPreviewRecord}. */
export function holdsStolenExecutionPreview(owners, node, stores) {
  return stolenExecutionPreviewRecord(owners, node, stores) != null;
}

/**
 * Evict a preview this node inherited with a reused id -- WITHOUT touching image state
 * that is its own. `stripNodeExecutionPreview` is wrong here: it wipes `node.imgs`
 * unconditionally, which for a LoadImage sitting on a reused id would delete the
 * thumbnail it hydrated from its own filename widget and collapse the node. That is the
 * same invariant `clearInheritedExecutionPreview` already protects.
 *
 * `node.images` is assigned `output.images` BY REFERENCE by `unsafeUpdatePreviews`, and
 * `node.imgs` is rendered from it, so array identity decides whether what is on screen
 * came from the stolen entry. If it did not, the entry is merely leftover in the store
 * and dropping it is the whole job.
 *
 * Scoped to `nodeOutputs` on purpose. The evidence is an entry in THAT store, and says
 * nothing about `nodePreviewImages` — a node sitting on a reused id may still be running
 * and painting its own live `b_preview` latent frames, which are not this entry's to
 * evict. `node.preview` is left for the same reason; the next latent frame repaints it.
 */
function evictInheritedExecutionPreview(node, stores, record) {
  const rendered =
    Array.isArray(record?.output?.images) && node.images === record.output.images;
  let changed = false;
  if (rendered) {
    if (node.imgs != null) {
      node.imgs = undefined;
      changed = true;
    }
    node.images = undefined;
    if (removePreviewWidget(node)) changed = true;
    changed = true;
    restoreCompactSize(node);
  }
  const outputs = stores?.nodeOutputs;
  if (outputs) {
    for (const key of outputStoreKeys(node.id)) {
      if (!Object.prototype.hasOwnProperty.call(outputs, key)) continue;
      delete outputs[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * Re-snapshot the entries of ids whose owner is still in place. The panel's sweep can
 * run before ComfyUI's own `executed` listener has written the store, so the snapshot
 * taken at record time may be a frame behind; refreshing on the later
 * `execution_success` sweep catches it up. Safe by construction -- an id whose owner
 * object is unchanged holds that owner's own output.
 */
function refreshExecutionPreviewOwners(owners, nodesById, stores) {
  for (const [key, record] of owners) {
    if (nodesById.get(key) !== record.node) continue;
    record.output = storeEntry(stores.nodeOutputs, key);
  }
}

/** Forget ids that no longer name a node or a store entry, so the ledger stays graph-sized. */
function pruneExecutionPreviewOwners(owners, nodesById, stores) {
  for (const key of [...owners.keys()]) {
    if (nodesById.has(key)) continue;
    if (storeEntry(stores.nodeOutputs, key) !== undefined) continue;
    owners.delete(key);
  }
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
 * is a real host, then strip preview state from every non-host -- plus (#1374)
 * every node provably holding an entry a DIFFERENT node emitted, which is the
 * only way an image-capable victim of id reuse gets swept at all.
 *
 * `preferNodeId` is the id an `executed` frame named, so it doubles as this run's
 * proof of emission and is what feeds the ownership ledger.
 *
 * @returns {{ stripped: number, rehomed: boolean }}
 */
export function stripMisattachedExecutionPreviews({
  graph,
  nodeOutputs,
  nodePreviewImages,
  preferNodeId,
  owners = executionPreviewOwners,
} = {}) {
  const nodes = graph?._nodes ?? graph?.nodes ?? [];
  const stores = { nodeOutputs, nodePreviewImages };
  let rehomed = false;

  const nodesById = new Map();
  for (const node of nodes) {
    if (node && node.id != null) nodesById.set(String(node.id), node);
  }
  if (owners) {
    refreshExecutionPreviewOwners(owners, nodesById, stores);
    if (preferNodeId != null) {
      const emitter = nodesById.get(String(preferNodeId));
      // Record BEFORE the strip loop: the node that just emitted owns this id now,
      // whatever it inherited a moment ago.
      if (emitter) recordExecutionPreviewOwner(owners, emitter, stores);
    }
  }

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
    if (!node) continue;
    // A type that COULD show an image is exempt only while nothing proves the image
    // it is showing belongs to someone else (#1374). Eviction is what that proof buys,
    // and it is deliberately NARROWER than the type gate's strip -- so it must not
    // replace it. A node that can never host a preview still falls through and gets
    // stripped in full; otherwise proving a ConditioningConcat's entry stolen would
    // leave it holding the very preview #1286 exists to remove.
    const stolen = owners ? stolenExecutionPreviewRecord(owners, node, stores) : null;
    let changed = false;
    if (stolen) {
      changed = evictInheritedExecutionPreview(node, stores, stolen);
      // The entry is gone; the record can no longer describe anything.
      owners.delete(String(node.id));
    }
    if (!nodeAcceptsExecutionImagePreview(node)) {
      const hasPreview =
        node.imgs != null ||
        node.images != null ||
        node.preview != null ||
        (Array.isArray(node.widgets) &&
          node.widgets.some((w) => w?.name === CANVAS_IMAGE_PREVIEW_WIDGET)) ||
        storeHasImages(nodeOutputs, node.id) ||
        storeHasImages(nodePreviewImages, node.id);
      if (hasPreview && stripNodeExecutionPreview(node, stores)) changed = true;
    }
    if (changed) stripped += 1;
  }
  if (owners) pruneExecutionPreviewOwners(owners, nodesById, stores);
  return { stripped, rehomed };
}
