/**
 * #1443 — a LiteGraph mutation is not a visible-canvas mutation.
 *
 * `graph.setDirtyCanvas` only walks `graph.list_of_graphcanvas`. After a Vue
 * remount or canvas swap that list can omit the canvas the user is looking at,
 * so `panel_edit_node` / `panel_edit_group` / `panel_remove_group` report
 * success and `panel_graph_outline` (which reads the graph object) agrees,
 * while the pixels do not move. ComfyUI frontend 1.49's Vue node renderer also
 * draws node bodies from a layout store keyed on `graph._version` /
 * `layoutVersion`, which a raw `setDirtyCanvas` never bumps.
 *
 * Notify the ACTIVE canvas (the one getGraphCtx named), bump the revision Vue
 * watches, and re-sync a layout store when one is reachable. The mutation
 * already happened; this is the receipt that the visible canvas was told.
 */

/** Named in the reply when the graph changed but the visible canvas did not ack. */
export const VISIBLE_CANVAS_ACK_NOTE =
  "The graph was mutated, but the visible canvas did not acknowledge the edit — " +
  "panel_graph_outline already reflects the new graph, the pixels may not have moved. " +
  "Reload the ComfyUI tab if the canvas still shows the previous layout.";

/**
 * Locate the frontend layout store, if this build exposes one. The Vue node
 * renderer keeps positions there; `initializeFromLiteGraph` is the public
 * refresh. Never required — older frontends have no store.
 *
 * @param {{ graph?: any, canvas?: any, piniaStores?: Iterable<any> | Map<any, any> }} [input]
 */
export function findLayoutStore({ graph, canvas, piniaStores } = {}) {
  const candidates = [
    graph?.layoutStore,
    canvas?.layoutStore,
    canvas?.graph?.layoutStore,
    graph?.primaryCanvas?.layoutStore,
  ];
  // Pinia `_s` is a Map (id → store). Arrays also have `.values()`. Prefer
  // that so a Map is not iterated as [key, value] pairs.
  if (piniaStores && typeof piniaStores.values === "function") {
    for (const store of piniaStores.values()) candidates.push(store);
  } else if (piniaStores && typeof piniaStores[Symbol.iterator] === "function") {
    for (const store of piniaStores) candidates.push(store);
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate.initializeFromLiteGraph === "function") return candidate;
  }
  return null;
}

/**
 * @param {{ graph?: any, canvas?: any, layoutStore?: any }} [input]
 * @returns {{ version: number | null, layoutVersion: number | null, geometryVersion: number | null }}
 */
export function readCanvasRevision({ graph, canvas, layoutStore } = {}) {
  const version = numberOrNull(graph?._version ?? graph?.revision);
  const store = layoutStore ?? findLayoutStore({ graph, canvas });
  return {
    version,
    layoutVersion: numberOrNull(store?.layoutVersion),
    geometryVersion: numberOrNull(store?.nodeGeometryVersion),
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Push live LiteGraph geometry into a layout store. Returns whether the store
 * accepted a refresh, not whether pixels moved.
 *
 * @param {any} store
 * @param {any} graph
 */
export function syncLayoutStoreFromGraph(store, graph) {
  if (!store || typeof store.initializeFromLiteGraph !== "function") return false;
  const nodes = Array.isArray(graph?._nodes) ? graph._nodes : [];
  const payload = [];
  for (const node of nodes) {
    if (!node || node.id == null) continue;
    payload.push({
      id: node.id,
      pos: [Number(node.pos?.[0]) || 0, Number(node.pos?.[1]) || 0],
      size: [Number(node.size?.[0]) || 0, Number(node.size?.[1]) || 0],
    });
  }
  try {
    store.initializeFromLiteGraph(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-assign each node's pos/size so a Vue layout-store setter runs. Direct
 * in-place writes (`node.pos[0] = x`) skip LGraphNode.pos's setter, which is
 * what commits the move to the frontend layout store. Assignment is the
 * public API; a throw on one node must not abort the rest.
 *
 * @param {any} graph
 * @returns {number} nodes whose geometry was re-committed
 */
export function recommitNodeLayouts(graph) {
  const nodes = graph?._nodes;
  if (!Array.isArray(nodes)) return 0;
  let committed = 0;
  for (const node of nodes) {
    if (!node) continue;
    try {
      const pos = node.pos;
      if (pos && pos.length >= 2) node.pos = [Number(pos[0]), Number(pos[1])];
      const size = node.size;
      if (size && size.length >= 2) {
        if (typeof node.setSize === "function") node.setSize([Number(size[0]), Number(size[1])]);
        else node.size = [Number(size[0]), Number(size[1])];
      }
      committed += 1;
    } catch {
      /* one hostile node must not abort the rest */
    }
  }
  return committed;
}

/**
 * Did the visible canvas (or the revision Vue paints from) move?
 *
 * Dirty flags are the LiteGraph receipt. A version/layoutVersion bump is the
 * Vue-nodes receipt. Invoking `canvas.setDirty` is itself a receipt when the
 * canvas has no dirty_* flags to read.
 */
export function visibleCanvasWasNotified({
  canvas,
  before,
  after,
  dirtyInvoked = false,
} = {}) {
  if (canvas?.dirty_canvas === true || canvas?.dirty_bgcanvas === true) return true;
  if (dirtyInvoked) return true;
  if (after?.version != null && before?.version != null && after.version !== before.version) {
    return true;
  }
  if (
    after?.layoutVersion != null &&
    before?.layoutVersion != null &&
    after.layoutVersion !== before.layoutVersion
  ) {
    return true;
  }
  if (
    after?.geometryVersion != null &&
    before?.geometryVersion != null &&
    after.geometryVersion !== before.geometryVersion
  ) {
    return true;
  }
  return false;
}

/**
 * Tell the visible canvas about an already-applied graph mutation.
 *
 * @param {{
 *   graph?: any,
 *   canvas?: any,
 *   layoutStore?: any,
 *   piniaStores?: Iterable<any> | Map<any, any>,
 *   vueNodes?: boolean,
 * }} [input]
 * @returns {{ notified: boolean, before: object, after: object }}
 */
export function ackVisibleCanvasMutation({
  graph,
  canvas,
  layoutStore,
  piniaStores,
  vueNodes = false,
} = {}) {
  const store = layoutStore ?? findLayoutStore({ graph, canvas, piniaStores });
  const before = readCanvasRevision({ graph, canvas, layoutStore: store });

  try {
    graph?.setDirtyCanvas?.(true, true);
  } catch {
    /* graph-list dirty is best-effort; the active canvas is the one that matters */
  }

  let dirtyInvoked = false;
  try {
    if (typeof canvas?.setDirty === "function") {
      canvas.setDirty(true, true);
      dirtyInvoked = true;
    }
  } catch {
    /* a throwing canvas must not hide the version bump below */
  }

  try {
    graph?.incrementVersion?.();
  } catch {
    /* older frontends have no incrementVersion */
  }
  try {
    graph?.change?.();
  } catch {
    /* on_change listeners are best-effort */
  }

  const vue = vueNodes === true;
  if (store) syncLayoutStoreFromGraph(store, graph);
  if (vue) recommitNodeLayouts(graph);

  const after = readCanvasRevision({ graph, canvas, layoutStore: store });
  return {
    notified: visibleCanvasWasNotified({ canvas, before, after, dirtyInvoked }),
    before,
    after,
  };
}

/**
 * Merge the ack into a mutation result. Happy-path shape is unchanged when the
 * canvas acknowledged. A miss is DISCLOSED rather than turned into a refusal:
 * the graph already changed, and a false "nothing was applied" invites a
 * destructive retry.
 *
 * @param {any} result
 * @param {{ notified?: boolean } | null | undefined} ack
 */
export function withVisibleCanvasAck(result, ack) {
  if (!ack || ack.notified !== false) return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { result, canvas_ack: false, canvas_ack_note: VISIBLE_CANVAS_ACK_NOTE };
  }
  return { ...result, canvas_ack: false, canvas_ack_note: VISIBLE_CANVAS_ACK_NOTE };
}
