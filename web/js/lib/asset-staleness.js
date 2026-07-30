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
 * Look a node up by a single id segment. ComfyUI supports arbitrary STRING node
 * ids (UUID-like), so we must NOT coerce to Number blindly (that would turn a
 * UUID into NaN and never match). Try the raw segment first; only fall back to a
 * numeric lookup for an all-digits segment, since some LiteGraph builds key
 * `_nodes_by_id` by number.
 */
function getNodeBySegment(graph, seg) {
  if (!graph?.getNodeById) return null;
  let node = graph.getNodeById(seg) ?? null;
  if (!node && /^\d+$/.test(seg)) node = graph.getNodeById(Number(seg)) ?? null;
  return node;
}

/**
 * Resolve a possibly subgraph-scoped node id ("6051:1913", a plain 42, or a
 * string/UUID id) against the ROOT graph, walking one hop per ':' segment through
 * `.subgraph`. Returns the node or null.
 */
export function findNodeByScopedId(rootGraph, scopedId) {
  const parts = String(scopedId ?? "")
    .split(":")
    .filter((p) => p !== "");
  if (!parts.length) return null;
  let graph = rootGraph;
  for (let i = 0; i < parts.length; i++) {
    const node = getNodeBySegment(graph, parts[i]);
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
 * file resolves against the node's live combo options (it appeared on disk).
 * Anything else keeps it reported — genuine misses always survive.
 *
 * The combo-membership check is ONLY trusted when `trustCombo` is true — i.e.
 * after a CONFIRMED successful node-def/combo refresh. A combo populated at page
 * load can be STALE (still listing a since-deleted file); trusting it then would
 * SUPPRESS a genuine `isMissing:true` candidate, which we must never do. Without
 * a confirmed refresh we fall back to over-reporting via the still-referenced
 * check alone.
 */
export function isStaleAssetCandidate(rootGraph, candidate, { trustCombo = false } = {}) {
  const nodeId = candidate?.nodeId;
  const file = candidate?.name;
  const widgetName = candidate?.widgetName;
  if (!assetCandidateStillReferenced(rootGraph, nodeId, file)) return true;
  if (trustCombo && assetCandidateResolvesLive(rootGraph, nodeId, file, widgetName)) return true;
  return false;
}

// Input types that ComfyUI renders as a WIDGET rather than a connection socket.
// A combo (the type spec is an array of option values) is also a widget.
const WIDGET_INPUT_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

/**
 * True when an object_info input SPEC (`[type, config?]`) is rendered as a widget
 * — i.e. it maps to a positional entry in the node's `widgets` array. Connection
 * inputs (MODEL, CLIP, LATENT, IMAGE, …) and any input forced to a socket
 * (`config.forceInput` / `config.widget === false`) are NOT widgets and must be
 * excluded when counting/ordering widgets (codex WS-3 round-2 finding #3).
 */
export function isWidgetInputSpec(spec) {
  const arr = Array.isArray(spec) ? spec : [spec];
  const type = arr[0];
  const config = arr[1];
  if (config && typeof config === "object") {
    if (config.forceInput) return false;
    if (config.widget === false) return false;
  }
  if (Array.isArray(type)) return true; // combo: option list as the type
  return WIDGET_INPUT_TYPES.has(String(type ?? "").toUpperCase());
}

/**
 * Ordered WIDGET-input names for a node definition (`node.constructor.nodeData`):
 * required inputs then optional, honoring `input_order` when present, and
 * EXCLUDING connection-only inputs so the count lines up with the node's
 * positional `widgets` array. LTXICLoRALoaderModelOnly = connection `model` +
 * widgets `lora_name`,`strength_model` → ["lora_name","strength_model"].
 */
export function orderedWidgetInputNames(nodeData) {
  const input = nodeData?.input;
  if (!input) return [];
  const req = input.required && typeof input.required === "object" ? input.required : {};
  const opt = input.optional && typeof input.optional === "object" ? input.optional : {};
  const order = nodeData?.input_order;
  const reqNames =
    order && Array.isArray(order.required) ? order.required : Object.keys(req);
  const optNames =
    order && Array.isArray(order.optional) ? order.optional : Object.keys(opt);
  const ordered = [...reqNames, ...optNames];
  return ordered.filter((name) => {
    const spec = name in req ? req[name] : name in opt ? opt[name] : undefined;
    return spec !== undefined && isWidgetInputSpec(spec);
  });
}

/**
 * Repair positional `UNKNOWN`/`UNKNOWN_n` widget placeholders in place by mapping
 * them to the node's definition widget-input order — but ONLY in the unambiguous
 * case where the def's widget-input count equals the widget count, so a mismatch
 * never mis-assigns. Fails open (leaves names untouched) otherwise.
 *
 * `freshDef` lets a post-restart refresh pass the CURRENT def straight in: an
 * already-loaded node keeps its old constructor after registerNodesFromDefs (each
 * registration makes a new class), so `node.constructor.nodeData` alone is stale
 * or absent for exactly the nodes that need repairing. Falls back to the
 * constructor's nodeData when no fresh def is supplied.
 * Returns true if it renamed at least one widget.
 */
export function reconcileUnknownWidgetNames(node, freshDef) {
  try {
    const widgets = node?.widgets;
    if (!Array.isArray(widgets) || !widgets.length) return false;
    if (!widgets.some((w) => UNKNOWN_WIDGET_RE.test(w?.name ?? ""))) return false;
    const ordered = orderedWidgetInputNames(freshDef ?? node.constructor?.nodeData);
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

/**
 * Every graph reachable from a root graph, including nested subgraphs (one entry
 * per `.subgraph` on any node). Used to sweep ALL live node instances after a
 * def refresh, not just the root canvas.
 */
export function collectAllGraphs(rootGraph) {
  const out = [];
  const seen = new Set();
  const stack = [rootGraph];
  while (stack.length) {
    const g = stack.pop();
    if (!g || seen.has(g)) continue;
    seen.add(g);
    out.push(g);
    for (const node of g._nodes ?? []) {
      if (node?.subgraph) stack.push(node.subgraph);
    }
  }
  return out;
}

/**
 * After a node-def refresh, re-apply the fresh definitions to ALREADY-LOADED node
 * instances (finding #3): registerNodesFromDefs mints a NEW class per type, so
 * existing instances keep their old/generic constructor and would otherwise never
 * see the updated schema. For each live node we (a) stamp the fresh def onto its
 * type-specific constructor's `nodeData` so schema reads are current, and (b)
 * reconcile any UNKNOWN widget placeholders using the fresh def directly (works
 * even when the instance sits on a generic fallback constructor with no nodeData).
 * `defsByType` is the `class_type → def` map from api.getNodeDefs(). Returns the
 * number of nodes whose UNKNOWN widgets were repaired. Fully defensive.
 */
export function reapplyDefsToLiveNodes(rootGraph, defsByType) {
  let repaired = 0;
  if (!defsByType) return repaired;
  try {
    for (const graph of collectAllGraphs(rootGraph)) {
      for (const node of graph._nodes ?? []) {
        const type = node?.type ?? node?.comfyClass;
        const def = type ? defsByType[type] : null;
        if (!def) continue;
        // Stamp only onto a TYPE-SPECIFIC constructor (already carries nodeData
        // for this type) — never onto a shared generic/unknown fallback class,
        // which would corrupt every other unknown node.
        const ctor = node.constructor;
        if (ctor && ctor.nodeData) {
          try {
            ctor.nodeData = def;
          } catch {
            /* frozen / non-writable — skip */
          }
        }
        if (reconcileUnknownWidgetNames(node, def)) repaired++;
      }
    }
  } catch {
    /* best-effort sweep */
  }
  return repaired;
}
