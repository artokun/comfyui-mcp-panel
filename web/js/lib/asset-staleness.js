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

// A canonical RFC-4122-shaped UUID, as ComfyUI mints for subgraph ids. The strict
// NodeLocatorId parse validates the first segment against this so a malformed or
// non-UUID first segment falls through to fail-open (keep reporting the miss),
// matching the frontend's own parseNodeLocatorId.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
 * Find a subgraph by its UUID anywhere in the graph hierarchy — mirrors the
 * ComfyUI frontend's own `findSubgraphByUuid`. Prefers the root graph's O(1)
 * `subgraphs` registry (a `uuid → Subgraph` Map on real LiteGraph builds), and
 * falls back to a recursive walk matching each nested `subgraph.id`. Returns the
 * subgraph or null.
 */
export function findSubgraphByUuid(graph, uuid, _seen = new WeakSet()) {
  if (!graph || uuid == null || _seen.has(graph)) return null;
  _seen.add(graph);
  const reg = graph.subgraphs;
  if (reg && typeof reg.get === "function") {
    const hit = reg.get(uuid);
    if (hit) return hit;
  }
  for (const node of graph._nodes ?? graph.nodes ?? []) {
    const sub = node?.subgraph;
    if (!sub || _seen.has(sub)) continue;
    if (String(sub.id) === String(uuid)) return sub;
    const found = findSubgraphByUuid(sub, uuid, _seen);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve a store candidate's node id — a ComfyUI **NodeLocatorId** — against the
 * ROOT graph. Two real shapes exist (see @/types/nodeIdentification):
 *   - a plain local id ("42" / a UUID-like string) → a node in the root graph;
 *   - "<subgraphUuid>:<localNodeId>" → a node inside a subgraph, where the FIRST
 *     segment is that subgraph's globally-unique UUID (registered on the root
 *     graph), NOT a host node id.
 *
 * The prior implementation walked one hop per ':' segment treating each segment
 * as a node id (`rootGraph.getNodeById(uuid)`), which never resolves a real
 * subgraph locator — so the missing-asset live cross-check failed OPEN and kept
 * reporting a subgraph asset as missing long after a widget/checkpoint/LoadImage
 * fix (#235 #247 #257 #352 #364). We now resolve the subgraph by UUID and read
 * the local node inside it. A purely-NUMERIC multi-segment id (legacy group-node
 * execution id, e.g. "6051:1913") keeps the old node-hop path for compatibility.
 *
 * Parsing is STRICT to preserve fail-open safety: a NodeLocatorId is EXACTLY two
 * segments (`<subgraphUUID>:<localNodeId>`) with a well-formed UUID first. Any
 * other subgraph-ish shape (3+ segments, an empty segment, a malformed UUID) is
 * unrecognized and returns null rather than guessing a node from first/last
 * segments — guessing could resolve the wrong node and SUPPRESS a genuine miss.
 * Returns the node or null (null → cross-check fails open, i.e. keeps reporting).
 */
export function findNodeByScopedId(rootGraph, scopedId) {
  const raw = String(scopedId ?? "");
  if (!raw) return null;
  // NOTE: split WITHOUT dropping empty segments, so "<uuid>::6077" (empty middle)
  // stays 3 parts and is rejected below rather than collapsing to a false 2-part.
  const parts = raw.split(":");
  if (parts.length === 1) return getNodeBySegment(rootGraph, parts[0]);

  const first = parts[0];
  // An all-digits first segment is a legacy group-node execution id; keep the
  // per-segment node-hop behaviour (any depth). Empty segments never match.
  if (/^\d+$/.test(first)) {
    let graph = rootGraph;
    for (let i = 0; i < parts.length; i++) {
      const node = getNodeBySegment(graph, parts[i]);
      if (!node) return null;
      if (i === parts.length - 1) return node;
      graph = node.subgraph ?? null;
      if (!graph) return null;
    }
    return null;
  }

  // A real NodeLocatorId is EXACTLY "<subgraphUUID>:<localNodeId>" — two
  // segments, a well-formed UUID first, a non-empty local id. Anything else
  // (extra segments, empty middle/local id, malformed UUID) is unrecognized:
  // return null so the cross-check fails OPEN and keeps reporting the miss.
  if (parts.length !== 2 || !UUID_RE.test(first) || parts[1] === "") return null;
  const sub = findSubgraphByUuid(rootGraph, first);
  if (!sub) return null;
  return getNodeBySegment(sub, parts[1]);
}

/**
 * True when `scopedId` is a RECOGNIZED locator shape — exactly the shapes
 * `findNodeByScopedId` knows how to resolve:
 *   - a single non-empty segment (plain local id / UUID-like);
 *   - an all-numeric first segment with 2+ segments (legacy group-node exec id);
 *   - EXACTLY "<subgraphUUID>:<localNodeId>" (well-formed UUID first, non-empty
 *     local id).
 * Any other shape (extra segments, empty segment, malformed UUID) is UNrecognized.
 *
 * This lets callers distinguish "the locator is understood but the node is not in
 * the active graph" (⇒ the candidate belongs to another workflow tab / was
 * removed ⇒ safe to drop for the active workflow — #316) from "the locator itself
 * is ambiguous" (⇒ must fail OPEN and keep reporting). Kept in lockstep with
 * `findNodeByScopedId`'s parse so the two never disagree.
 */
export function locatorIsRecognized(scopedId) {
  const raw = String(scopedId ?? "");
  if (!raw) return false;
  const parts = raw.split(":");
  if (parts.length === 1) return true;
  const first = parts[0];
  if (/^\d+$/.test(first)) return parts.every((p) => p !== "");
  return parts.length === 2 && UUID_RE.test(first) && parts[1] !== "";
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
 *
 * `scopeToActiveGraph` (default true) additionally drops a candidate whose
 * RECOGNIZED locator resolves to NO node in `rootGraph` — the missing-asset Pinia
 * stores are not cleared when the user switches workflow tabs, so a candidate from
 * a previously-open tab (or a since-deleted node) otherwise leaks into the active
 * workflow's errors (#316). This is guarded by `locatorIsRecognized`: an ambiguous
 * / unparseable locator is NEVER dropped this way and still fails OPEN via the
 * still-referenced check, so a genuine miss is never swallowed.
 */
export function isStaleAssetCandidate(
  rootGraph,
  candidate,
  { trustCombo = false, scopeToActiveGraph = true } = {},
) {
  const nodeId = candidate?.nodeId;
  const file = candidate?.name;
  const widgetName = candidate?.widgetName;
  // Cross-tab / removed-node scope check: a recognized locator that finds no node
  // in the active graph cannot be a red node in the active workflow → drop it.
  if (
    scopeToActiveGraph &&
    nodeId != null &&
    locatorIsRecognized(nodeId) &&
    findNodeByScopedId(rootGraph, nodeId) == null
  ) {
    return true;
  }
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
