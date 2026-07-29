/**
 * Pure helpers for reconciling the ComfyUI frontend's LOAD-TIME snapshots against
 * the live graph — extracted from comfyui-mcp-panel.js so they can be unit-tested
 * without a browser. No DOM / no ComfyUI globals: every input is passed in.
 *
 * Two stale-state classes are handled:
 *   1. Missing-asset candidates (`missingModel`/`missingMedia` Pinia stores) are
 *      populated ONCE at workflow load and never re-evaluated, so a file the user
 *      or agent has since fixed (set_widget) or that has since appeared on disk
 *      (download + restart) keeps getting reported missing. (#196/#223/#203/#185/#181)
 *   2. Widgets deserialized as positional `UNKNOWN`/`UNKNOWN_n` placeholders when
 *      the class def wasn't matched at load, even though the live def names them. (#199)
 */

const UNKNOWN_WIDGET_RE = /^UNKNOWN(_\d+)?$/;

/**
 * Resolve a possibly subgraph-scoped node id ("6051:1913", or plain 42) against
 * the ROOT graph, walking one hop per ':' segment through `.subgraph`. Returns
 * the node or null.
 */
export function findNodeByScopedId(rootGraph, scopedId) {
  const parts = String(scopedId ?? "")
    .split(":")
    .filter((p) => p !== "");
  if (!parts.length) return null;
  let graph = rootGraph;
  for (let i = 0; i < parts.length; i++) {
    const node = graph?.getNodeById?.(Number(parts[i])) ?? null;
    if (!node) return null;
    if (i === parts.length - 1) return node;
    graph = node.subgraph ?? null;
  }
  return null;
}

/**
 * Keep a candidate only if some widget on the node STILL literally holds that
 * filename. Fails OPEN (returns true / "still referenced") on any unexpected
 * shape, so the worst case is over-reporting and a real miss is never swallowed.
 */
export function assetCandidateStillReferenced(rootGraph, nodeId, file) {
  try {
    if (nodeId == null || !file) return true;
    const node = findNodeByScopedId(rootGraph, nodeId);
    if (!node || !Array.isArray(node.widgets) || !node.widgets.length) return true;
    return node.widgets.some((w) => w?.value === file);
  } catch {
    return true;
  }
}

/**
 * True when the candidate's filename IS an accepted value on the live node widget
 * combo — i.e. the server already knows the file and the store entry is stale.
 * Fails CLOSED (returns false / "keep it") on any unexpected shape, so a genuinely
 * missing model is never silently swallowed.
 */
export function assetCandidateResolvesLive(rootGraph, nodeId, file, widgetName) {
  try {
    if (nodeId == null || !file) return false;
    const node = findNodeByScopedId(rootGraph, nodeId);
    if (!node || !Array.isArray(node.widgets)) return false;
    const w = widgetName
      ? node.widgets.find((x) => x?.name === widgetName)
      : node.widgets.find((x) => Array.isArray(x?.options?.values));
    if (!w) return false;
    const raw = w.options?.values;
    const list = typeof raw === "function" ? raw(w, node) : raw;
    return Array.isArray(list) && list.includes(file);
  } catch {
    return false;
  }
}

/**
 * A missing-asset store candidate is stale (should NOT be reported) when either
 * no widget still references the file (the value was changed to a fix) OR the
 * file now resolves against the node's live combo options (it appeared on disk).
 * Anything else keeps it reported — genuine misses always survive.
 */
export function isStaleAssetCandidate(rootGraph, candidate) {
  const nodeId = candidate?.nodeId;
  const file = candidate?.name;
  const widgetName = candidate?.widgetName;
  if (!assetCandidateStillReferenced(rootGraph, nodeId, file)) return true;
  if (assetCandidateResolvesLive(rootGraph, nodeId, file, widgetName)) return true;
  return false;
}

/**
 * Ordered widget-input names for a node definition (`node.constructor.nodeData`):
 * required inputs then optional, honoring `input_order` when present.
 */
export function orderedWidgetInputNames(nodeData) {
  const input = nodeData?.input;
  if (!input) return [];
  const req =
    input.required && typeof input.required === "object"
      ? Object.keys(input.required)
      : [];
  const opt =
    input.optional && typeof input.optional === "object"
      ? Object.keys(input.optional)
      : [];
  const order = nodeData?.input_order;
  if (order && (Array.isArray(order.required) || Array.isArray(order.optional))) {
    return [...(order.required ?? req), ...(order.optional ?? opt)];
  }
  return [...req, ...opt];
}

/**
 * Repair positional `UNKNOWN`/`UNKNOWN_n` widget placeholders in place by mapping
 * them to the node's live definition widget-input order — but ONLY in the
 * unambiguous case where the def's widget-input count equals the widget count, so
 * a mismatch never mis-assigns. Fails open (leaves names untouched) otherwise.
 * Returns true if it renamed at least one widget.
 */
export function reconcileUnknownWidgetNames(node) {
  try {
    const widgets = node?.widgets;
    if (!Array.isArray(widgets) || !widgets.length) return false;
    if (!widgets.some((w) => UNKNOWN_WIDGET_RE.test(w?.name ?? ""))) return false;
    const ordered = orderedWidgetInputNames(node.constructor?.nodeData);
    if (ordered.length !== widgets.length) return false;
    let changed = false;
    widgets.forEach((w, i) => {
      if (w && UNKNOWN_WIDGET_RE.test(w.name ?? "") && ordered[i]) {
        w.name = ordered[i];
        changed = true;
      }
    });
    return changed;
  } catch {
    return false;
  }
}
