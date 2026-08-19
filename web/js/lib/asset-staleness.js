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

import { parseAnnotatedFilepath } from "./input-asset.js";

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
 * Resolve a store locator only when its node is part of the graph currently
 * being reported. A nested node id is local to its subgraph, so attaching a
 * `<subgraphUuid>:<localId>` reason directly by string leaves the visible node
 * looking source-free and can incorrectly classify its red outline as stale.
 *
 * Identity (rather than just a matching local id) matters here: different
 * subgraphs may both contain node `7`. Returning null for a node outside the
 * visible graph deliberately leaves the caller's original locator untouched,
 * avoiding a false attribution in the wrong scope.
 */
export function findVisibleNodeByScopedId(rootGraph, visibleNodes, scopedId) {
  const node = findNodeByScopedId(rootGraph, scopedId);
  return node && Array.isArray(visibleNodes) && visibleNodes.includes(node) ? node : null;
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
 *
 * The store's `widgetName` can blame the WRONG widget: a save corrupted by a
 * node-signature change (widget-shift) records the filename under an unrelated
 * widget like `control_after_generate`, whose combo can never contain a filename.
 * After the agent/user repairs the node, the file lives in a DIFFERENT widget
 * (e.g. `upscale_model_name`) — the same widget that keeps the candidate alive
 * via assetCandidateStillReferenced's node-wide scan. So once the named-widget
 * check fails, every widget whose CURRENT value literally holds the file is
 * consulted too: kept by a node-WIDE check must mean clearable by a node-wide
 * check, or a fully-fixed node reports a phantom missing model until reload
 * (#569). The widened clear path stays fail-closed — it reads only combos the
 * caller has gated as TRUSTED (fresh /object_info), and a genuinely-absent file
 * is never offered by a fresh combo, so no genuine miss can be suppressed.
 *
 * Annotated values (`file.png [input]`/`[output]`/`[temp]`, #743) are classified
 * with parseAnnotatedFilepath BEFORE any combo probing: an `[output]`/`[temp]`
 * value resolves against a root the input combo NEVER enumerates, so the combo
 * has no verdict on it at all — it fails CLOSED here and is left to the #743
 * /view server probe. Only an UNANNOTATED value (exact raw membership) or an
 * `[input]`-annotated one (its stripped bare name) may be combo-cleared: both
 * resolve against the very input root the combo enumerates.
 */
export function assetCandidateResolvesLive(rootGraph, nodeId, file, widgetName) {
  try {
    if (nodeId == null || !file) return false;
    const node = findNodeByScopedId(rootGraph, nodeId);
    if (!node || !Array.isArray(node.widgets)) return false;
    // Annotation classification comes FIRST (codex P1): a value that parses as
    // [output]/[temp]-annotated resolves as its STRIPPED name in the output/temp
    // root via folder_paths.annotated_filepath. A combo entry that literally
    // ends with "[output]"/"[temp]" is just a weird input-root filename — even
    // an EXACT-looking hit proves nothing about the annotated value, so it must
    // never clear the candidate. Those stay flagged for the #743 /view probe.
    const parsed = parseAnnotatedFilepath(file);
    if (parsed.annotated && parsed.type !== "input") return false;
    // EXACT membership only. A subfolder-registered model (Impact Subpack's
    // `segm/yolov8m-seg.pt`, #407) is listed by /object_info with the SAME separator
    // the widget value carries, so an exact match resolves it once the combo is
    // trusted (the get_errors authoritative refresh) — no separator normalization,
    // which on POSIX could equate a literal-backslash filename with a distinct
    // forward-slash one and SUPPRESS a genuine miss. For an unannotated value
    // parsed.name === file (the raw exact match); for an [input]-annotated one
    // the stripped bare name is adjudicable because it resolves against the very
    // input root the combo enumerates — and the RAW annotated string is NOT
    // checked: a literal `foo.png [input]` combo entry is a weird filename, not
    // proof that `foo.png` exists.
    const comboHasFile = (w) => {
      if (!w) return false;
      const raw = w.options?.values;
      const list = typeof raw === "function" ? raw(w, node) : raw;
      return Array.isArray(list) && list.includes(parsed.name);
    };
    const named = widgetName
      ? node.widgets.find((x) => x?.name === widgetName)
      : node.widgets.find((x) => Array.isArray(x?.options?.values));
    if (comboHasFile(named)) return true;
    // Widget-shift repair (#569): the blamed widget's own combo can never hold
    // the file, so also consult the widgets whose CURRENT value literally carries
    // it — exactly the widgets assetCandidateStillReferenced's node-wide scan
    // keeps this candidate alive for. A widget still referencing a genuinely
    // missing file is NOT offered by its fresh combo, so it still flags.
    for (const w of node.widgets) {
      if (w === named) continue;
      if (w?.value === file && comboHasFile(w)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * True when a LiteGraph `has_errors` red flag on `nodeId` is NO LONGER justified —
 * neither the live missing-asset collector nor the last validation map still blames
 * that node — so the stale red outline may be cleared (#418). After panel_set_widget
 * repoints a widget from a missing asset to a valid one, `assetCandidateStillReferenced`
 * already drops the missing candidate, but LiteGraph's boolean `has_errors` is sticky
 * and keeps painting the node red with an empty `reasons: []`. Callers clear the flag
 * only when this returns true.
 *
 * `missingItems` is the flat list of `{ node_id }` from collectMissingAssets (models +
 * media). Validation errors come from `nodeErrorsMaps` — an ARRAY of independent
 * `{ [id]: { errors: [...] } }` maps (e.g. `app.lastNodeErrors` AND the execution-error
 * Pinia store, which can each blame a node the other does not). They are checked with
 * OR semantics — a live error in ANY map keeps the flag — deliberately NOT shallow-
 * merged: a merge would let one map's EMPTY `{id:{errors:[]}}` overwrite another map's
 * live entry and wrongly clear a genuine error (codex round-2 P0). `nodeErrorsMap`
 * (singular) is still accepted for one-map callers/tests. `resolvesToNode(scopedId)` is
 * an optional predicate that returns true when a candidate's (possibly SCOPED/nested)
 * node id resolves to the SAME live node whose flag is being tested — needed because a
 * nested candidate id never string-equals the inner node's local id. Fails toward KEEPING
 * the flag (returns false) on any doubt, so a genuinely-errored node is never de-flagged.
 */
export function nodeRedFlagIsStale(
  nodeId,
  { missingItems = [], nodeErrorsMap = null, nodeErrorsMaps = null, resolvesToNode = null } = {},
) {
  try {
    if (nodeId == null) return false;
    const id = String(nodeId);
    const stillMissing = (Array.isArray(missingItems) ? missingItems : []).some((it) => {
      if (it?.node_id == null) return false;
      // Direct id match is enough for a root node; a NESTED candidate is keyed by a
      // SCOPED locator ("6105:6077" / "<subgraphUUID>:6077") that never string-equals
      // the inner node's own local id, so `resolvesToNode` (which resolves the locator
      // and compares object identity) must catch it — otherwise a still-missing nested
      // asset would slip past and wrongly clear the flag (codex round-3 P0).
      if (String(it.node_id) === id) return true;
      return typeof resolvesToNode === "function" ? resolvesToNode(it.node_id) === true : false;
    });
    if (stillMissing) return false;
    const maps = Array.isArray(nodeErrorsMaps)
      ? nodeErrorsMaps
      : nodeErrorsMap
        ? [nodeErrorsMap]
        : [];
    const stillInvalid = maps.some((mp) => {
      const errs = mp?.[id]?.errors;
      return Array.isArray(errs) && errs.length > 0;
    });
    return !stillInvalid;
  } catch {
    return false;
  }
}

/**
 * Conservatively union independent frontend validation maps. ComfyUI can clear
 * `app.lastNodeErrors` while the execution-error store still holds the live
 * rejection, so choosing the app map with `??` can falsely report a clean
 * graph. Entries for the same node retain errors from both sources; malformed
 * entries are preserved rather than used as evidence that no error exists.
 */
export function combineNodeErrorMaps(nodeErrorsMaps) {
  const combined = {};
  const maps = Array.isArray(nodeErrorsMaps) ? nodeErrorsMaps : [];
  for (const map of maps) {
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [id, entry] of Object.entries(map)) {
      if (!Object.hasOwn(combined, id)) {
        combined[id] = entry;
        continue;
      }
      const previous = combined[id];
      if (previous === entry) continue;
      const previousObject = previous && typeof previous === "object" && !Array.isArray(previous);
      const entryObject = entry && typeof entry === "object" && !Array.isArray(entry);
      if (!previousObject || !entryObject) {
        // An unexpected entry shape cannot prove the earlier source is clear.
        // Keep the first one; the map remains non-empty and thus conservative.
        continue;
      }
      const previousErrors = Array.isArray(previous.errors) ? previous.errors : [];
      const entryErrors = Array.isArray(entry.errors) ? entry.errors : [];
      const errors = [...previousErrors];
      for (const error of entryErrors) {
        if (!errors.includes(error)) errors.push(error);
      }
      combined[id] = {
        ...previous,
        ...entry,
        ...(Array.isArray(previous.errors) || Array.isArray(entry.errors) ? { errors } : {}),
      };
    }
  }
  return Object.keys(combined).length ? combined : null;
}

/**
 * Return visual LiteGraph red outlines that have no current source-confirmed
 * explanation. A saved workflow can retain `has_errors` from an older run even
 * though both error sources have since been cleared. Those outlines are useful
 * diagnostic hints, but must not inflate `graph_get_errors.errored_count`.
 *
 * This intentionally only classifies when BOTH raw execution sources are
 * absent. If either source exists, keep the old conservative behavior: an
 * unexplained outline remains an error rather than being silently downgraded.
 * `reasons` may be the command's Map or a plain id-keyed object for tests.
 */
export function collectUnexplainedRedOutlines(
  nodes,
  reasons,
  { nodeErrors = null, lastExecFailure = null } = {},
) {
  if (nodeErrors || lastExecFailure || !Array.isArray(nodes)) return [];
  const reasonsFor = (nodeId) => {
    const key = String(nodeId);
    return reasons instanceof Map ? reasons.get(key) : reasons?.[key];
  };
  return nodes.filter((node) => node?.has_errors && !(reasonsFor(node.id)?.length));
}

/**
 * Return the direct graph neighbours connected to `node`. Native
 * `convertToSubgraph()` rewires precisely these surviving root-graph nodes to
 * the new wrapper, but does not re-adjudicate LiteGraph's sticky `has_errors`
 * bit (#516). Supports both live `LLink` records and serialized link tuples;
 * malformed graph shapes simply produce no candidates.
 */
export function collectLinkedNeighborNodeIds(node, links) {
  const out = new Set();
  try {
    const lookup = (id) => {
      if (id == null || !links) return null;
      return typeof links.get === "function" ? links.get(id) ?? null : links[id] ?? null;
    };
    const originId = (link) => link?.origin_id ?? link?.[1];
    const targetId = (link) => link?.target_id ?? link?.[3];
    for (const input of node?.inputs ?? []) {
      const id = originId(lookup(input?.link));
      if (id != null) out.add(id);
    }
    for (const output of node?.outputs ?? []) {
      for (const linkId of output?.links ?? []) {
        const id = targetId(lookup(linkId));
        if (id != null) out.add(id);
      }
    }
  } catch {
    // Best effort only: a malformed graph must never make a conversion fail.
  }
  return out;
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

/**
 * Correct the missing-model `directory` for an Impact-Subpack UltralyticsDetectorProvider
 * model so it points at the RIGHT bbox/segm subfolder (#487).
 *
 * `UltralyticsDetectorProvider.model_name` draws its combo from TWO separately-registered
 * folders — `ultralytics/bbox` and `ultralytics/segm` — and the combo VALUE authoritatively
 * carries the subfolder as a prefix (`bbox/…` or `segm/…`). ComfyUI's missing-model store,
 * however, reports a SINGLE default directory for the input (observed: `ultralytics/bbox`)
 * regardless of the value's prefix, so a missing `segm/…` model is mis-reported as belonging
 * in `models/ultralytics/bbox`; downloading there leaves the node red because the loader
 * resolves `segm/…` through `models/ultralytics/segm`.
 *
 * Given the store's `directory` and the missing `file` (the combo value), return the CORRECTED
 * directory: when the directory is an ultralytics folder (`ultralytics`, `ultralytics/bbox`,
 * or `ultralytics/segm`) AND the file carries a `bbox/`/`segm/` prefix, force the subfolder to
 * match that prefix. Every other case — a non-ultralytics directory (checkpoints, loras, …),
 * a null directory, or a file with no recognizable prefix — is passed through UNCHANGED, so
 * non-ultralytics missing-asset resolution never regresses. Pure + fully defensive.
 */
export function resolveMissingModelDirectory(directory, file) {
  try {
    if (directory == null) return directory;
    const dir = String(directory).replace(/\\/g, "/").replace(/\/+$/, "");
    // Only touch the known ultralytics folders so nothing else can be rewritten.
    if (!/^ultralytics(\/(bbox|segm))?$/i.test(dir)) return directory;
    const m = /^\s*(bbox|segm)\//i.exec(String(file ?? "").replace(/\\/g, "/"));
    if (!m) return directory;
    return `ultralytics/${m[1].toLowerCase()}`;
  } catch {
    return directory;
  }
}

/**
 * Blame each LIVE node whose type is one of the uninstalled `missingNodeTypes`. The
 * missing-nodes store only yields type NAMES; on their own they never land on a node,
 * so a red "node type not installed" node — INCLUDING a bypassed/muted one that
 * LiteGraph may not flag `has_errors` — otherwise vanishes from graph_get_errors,
 * which then reports a falsely-clean state that contradicts the sidebar's own
 * load-time MISSING ASSETS warning (#399). This maps the type names back onto the
 * actual node ids so each such node surfaces with a `missing_node_type` reason.
 * Iterates EVERY node regardless of mode (bypass/mute never filtered). Returns
 * `[{ nodeId, type }, ...]`. Fully defensive — a malformed node/list yields fewer
 * (never throws).
 */
export function collectMissingNodeTypeReasons(nodes, missingNodeTypes) {
  const out = [];
  try {
    if (!Array.isArray(nodes) || !nodes.length) return out;
    const set = new Set(Array.isArray(missingNodeTypes) ? missingNodeTypes : []);
    if (!set.size) return out;
    for (const n of nodes) {
      const t = n?.type ?? n?.comfyClass;
      if (t != null && set.has(t)) out.push({ nodeId: n.id, type: t });
    }
  } catch {
    /* best-effort — partial mapping is better than none */
  }
  return out;
}

/**
 * True when a `graph_get_errors` RESULT payload represents a genuinely CLEAN graph —
 * no per-node validation errors, no execution failure, no errored nodes, AND no
 * missing-asset surface of ANY kind (models / media / node-types / node-count /
 * stale placeholders left after a class registered — #1332). Every
 * consumer that summarizes the result — the command-summary label, banners, etc. —
 * must derive "errors vs none" from THIS, so a missing-asset-ONLY result (e.g. a red or
 * BYPASSED uninstalled node, #399/#356) is never labelled "none" while its own payload
 * carries a populated missing_* / errored_count field. Fully defensive: an absent or
 * non-object result is treated as clean.
 */
export function graphErrorsResultIsClean(result) {
  if (!result || typeof result !== "object") return true;
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  return (
    !result.node_errors &&
    !result.last_execution_error &&
    !(Number(result.errored_count) > 0) &&
    !len(result.missing_models) &&
    !len(result.missing_media) &&
    !len(result.missing_node_types) &&
    !(Number(result.missing_node_count) > 0) &&
    !len(result.stale_placeholders) &&
    !result.requires_reload &&
    // #984 — the #745 LIVE scan was added to the payload after this helper was
    // written and never folded in, so a result carrying `unavailable_widget_values`
    // was still labelled "Checked errors — none". Every entry there is a widget
    // value the server does not offer (a file it does not have, or a value outside
    // the options it publishes) — the node fails on it at queue time either way.
    !len(result.unavailable_widget_values)
  );
}

// #984 — a field separator for the overlap-join keys below. Written as an ESCAPE, never
// as a literal control byte: a raw 0x1f in shipped source trips the repo's own guard
// (and the Registry's scanners), which is exactly how this was caught.
/**
 * #984 — an INJECTIVE key for the overlap join below.
 *
 * A delimiter is not enough, whichever byte it is. `"\x1f"` only moves the control
 * character from the source file to runtime, and a POSIX filename may legally contain
 * it: `(node "1", file "x\x1fy")` and `(node "1", widget "x", value "y")` then produce
 * the same key, and a real live-scan finding is discarded as a phantom duplicate
 * (codex round 2). `JSON.stringify` of an array of strings escapes every field, so
 * distinct tuples cannot collide. The leading tag keeps the two key SHAPES apart too.
 *
 * Suppressing a finding is precisely the failure this issue is about, so the join
 * fails toward counting: anything it cannot key is reported rather than merged.
 */
const joinKey = (tag, ...parts) => JSON.stringify([tag, ...parts.map((p) => String(p))]);

/**
 * #984 — the counts a `graph_get_errors` summary label should show, with the OVERLAP
 * between the two detection halves removed.
 *
 * The load-time stores and the #745 live scan frequently find the SAME defect: an
 * absent model file is both a `missing_models` entry and an `unavailable_widget_values`
 * entry (measured — three absent UNET files appeared in both). Adding the lists gives
 * six findings for three problems. Two corroborating signals are not two defects.
 *
 * So `unavailable` counts only what the load-time surfaces did NOT already report, on
 * the (node, widget, value) it names. `missing_node_types`/`missing_node_count` have no
 * widget-level identity and cannot overlap, so they stay in `missingAssets` untouched.
 *
 * KNOWN, deliberate limit: node ids are compared as written. `"7"` and `7` merge, but a
 * subgraph locator `"<uuid>:7"` on one side and a bare `7` on the other do NOT — the
 * two producers do not canonicalize locators between them, and guessing an equivalence
 * would merge findings on genuinely different nodes. Splitting over-reports; merging
 * hides. This splits.
 *
 * `unchecked` is reported SEPARATELY and is never a finding: the scan leaves something
 * unjudged on nearly every call, and counting that as an error would make a quiet label
 * unreachable on a healthy canvas. It exists so a caller can decline to say "none" when
 * the check was not complete — no positive findings is not the same as a clean result.
 */
export function graphErrorsFindingCounts(result) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const r = result && typeof result === "object" ? result : {};
  const models = arr(r.missing_models);
  const media = arr(r.missing_media);
  // How precisely a store entry identifies its finding decides what it may absorb
  // (codex round 2 — the first version added the widget-less key ALWAYS, so a store
  // miss on `unet_name` swallowed a distinct live finding for `config_name` on the
  // same node carrying the same filename, which can be two different faults).
  //
  //   named   — the store told us the widget: absorbs only that widget
  //   unnamed — the store could not: absorbs any widget on that node, since there is
  //             no identity to distinguish them by
  //   anyFile — every store entry by (node, file), consulted ONLY when the LIVE entry
  //             is the one that cannot name a widget
  const named = new Set();
  const unnamed = new Set();
  const anyFile = new Set();
  for (const m of [...models, ...media]) {
    const node = m?.node_id ?? null;
    const file = m?.file ?? null;
    if (node == null || file == null) continue;
    anyFile.add(joinKey("nf", node, file));
    if (m?.widget != null) named.add(joinKey("nwf", node, m.widget, file));
    else unnamed.add(joinKey("nf", node, file));
  }
  const unavailable = arr(r.unavailable_widget_values).filter((u) => {
    const node = u?.id ?? null;
    const value = u?.value ?? null;
    if (node == null || value == null) return true; // no identity to join on → count it
    if (u?.widget == null) return !anyFile.has(joinKey("nf", node, value));
    if (unnamed.has(joinKey("nf", node, value))) return false;
    return !named.has(joinKey("nwf", node, u.widget, value));
  }).length;
  return {
    erroredNodes: Number(r.errored_count) || 0,
    missingAssets:
      models.length +
      media.length +
      arr(r.missing_node_types).length +
      (Number(r.missing_node_count) || 0) +
      arr(r.stale_placeholders).length,
    unavailable,
    // #1357 — DISTINCT nodes, not entries. This feeds a pill that literally reads
    // "{count} nodes could not be checked", and since #1357 one node can put
    // several entries in that list: a widget value the server's combo has no
    // authority over is reported per VALUE, so three nested LoadImage paths on one
    // node used to render as "3 nodes". The list itself still carries every entry
    // with its own reason; only the node COUNT is counted as nodes.
    unchecked: new Set(
      arr(r.unchecked_nodes).map((u, i) => (u?.id == null ? `#${i}` : `id:${String(u.id)}`)),
    ).size,
  };
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
/**
 * Update a SINGLE node's COMBO widget option lists in place from an already-fetched
 * /object_info payload (`class_type -> def`), WITHOUT a second network round-trip
 * (#458 P2). The stale-combo set_widget retry re-validates a just-staged value (a
 * downloaded model / uploaded image / staged output) against the AUTHORITATIVE list;
 * that list is already in the /object_info the fresh-backend type gate just fetched,
 * so we reuse it here instead of calling ComfyUI's refreshComboInNodes() (which
 * re-fetches /object_info internally). ComfyUI's /object_info encodes a combo as an
 * input spec whose first element is the array of options: `input[.required|.optional]
 * [name] = [[opt, ...], {config}]`. Only ARRAY-backed combos are refreshed; a dynamic
 * `options.values` FUNCTION is left untouched (it computes its own list). Returns the
 * number of widgets whose option list was refreshed. Fully defensive.
 *
 * `defTypeKey` overrides which /object_info class_type the def is looked up under —
 * REQUIRED for a nested/promoted write, where the widget being mutated lives on an
 * intermediate VIRTUAL SubgraphNode (absent from /object_info) but its authoritative
 * options come from the ULTIMATE CONCRETE backend type (#458 nested combo-refresh).
 * The concrete type must be resolved through the promotion chain, never the virtual
 * intermediate `node.type`. Defaults to the node's own type for direct writes.
 *
 * `widgetNameMap` (optional { nodeWidgetName -> defWidgetName }) bridges a RENAMED
 * promotion: a nested promotion can rename the widget at each level, so the widget
 * being mutated (`nodeWidgetName`) may not match the concrete def's input name — the
 * map supplies the concrete-def key to look its options up under (#458×#366). Widgets
 * not in the map fall back to their own name.
 */
/**
 * The authoritative option list a def spec publishes, or NULL when this spec does not
 * carry one. Never guesses: a caller that gets null has learned that it cannot rebuild
 * this widget, which is a different thing from a widget that is not a combo.
 *
 * MEASURED against a live ComfyUI 0.33 /object_info (848 types), because the V1 shape was
 * the only one this file handled and it is now the MINORITY:
 *
 *     [[opt, ...], config?]                    V1, 61 inputs   — the historical shape
 *     ["COMBO", { options: [opt, ...] }]       V2, 467 inputs  — silently skipped before
 *     ["COMBO", { remote: { route } }]         V2 remote, 1    — the list is a separate
 *                                              fetch; the frontend shows "Loading…" until
 *                                              it lands, so there is nothing to copy
 *     ["COMFY_DYNAMICCOMBO_V3", { options: [{ key, inputs }] }]   120 inputs — the keys
 *                                              select SUB-INPUTS to materialize; copying
 *                                              the keys alone would publish a list this
 *                                              file cannot honour
 *
 * The last two return null on purpose. `refreshComboOptionsFromDefs` counts them as
 * SKIPPED rather than treating "I did not rebuild it" as "there was nothing to rebuild".
 */
export function authoritativeComboValues(spec) {
  if (!Array.isArray(spec)) return null;
  // V1 — the first element IS the option array.
  if (Array.isArray(spec[0])) return spec[0];
  // V2 — a "COMBO" type string, options under the config object.
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return spec[1].options;
  return null;
}

/**
 * Whether this input is a COMBO whose list this file could not derive — a remote V2, a
 * dynamic V3, or a shape published after this was written. Asked only when
 * `authoritativeComboValues` already returned null.
 *
 * TWO independent signals, because neither sees the whole set. A remote V2 arrives before
 * its list does, so the live widget's `options.values` is `undefined` and only the SPEC
 * betrays it; a shape this file has never heard of may not say "COMBO" anywhere, and only
 * the live widget — already presenting an array of options — betrays that.
 */
function isUnrebuiltComboWidget(spec, widget) {
  const declaredCombo = Array.isArray(spec) && typeof spec[0] === "string" && /COMBO/.test(spec[0]);
  return declaredCombo || Array.isArray(widget?.options?.values);
}

export function refreshComboOptionsFromDefs(node, defsByType, defTypeKey, widgetNameMap, mergedInputs, stats = null) {
  let refreshed = 0;
  if (!node || !defsByType) return refreshed;
  try {
    const type = defTypeKey ?? node.type ?? node.comfyClass;
    const def = type ? defsByType[type] : null;
    if (!def) return refreshed;
    // #1193 — the merged map may be supplied by a caller sweeping MANY nodes, so a graph of
    // N nodes of the same type spreads its inputs once rather than N times. This function is
    // O(inputs) per call and #1193 measured the register/reapply phase at 3.97s of a 9s run;
    // rebuilding combos there must not add a fresh spread per node.
    const inputs = mergedInputs ?? { ...(def.input?.required ?? {}), ...(def.input?.optional ?? {}) };
    for (const w of node.widgets ?? []) {
      if (w?.name == null) continue;
      const defKey = (widgetNameMap && widgetNameMap[w.name]) ?? w.name;
      const spec = inputs[defKey];
      if (!spec) continue;
      // Never clobber a dynamic (function) option source — it derives its own list, and
      // `assetCandidateResolvesLive` invokes it, so nothing here is stale for want of a
      // rebuild. Not counted as skipped for the same reason.
      if (typeof w.options?.values === "function") continue;
      const values = authoritativeComboValues(spec);
      if (values === null) {
        // NOT SILENTLY. A combo whose list this file cannot derive is the case #1193's
        // disclosure must not claim: the caller decides whether the lists are current
        // from this count, and a skip that went unrecorded read as "nothing to do".
        if (stats && isUnrebuiltComboWidget(spec, w)) {
          stats.combosSkipped = (stats.combosSkipped ?? 0) + 1;
        }
        continue;
      }
      if (!w.options || typeof w.options !== "object") w.options = {};
      w.options.values = values.slice();
      refreshed++;
    }
  } catch {
    /* best-effort — a malformed def just means the retry falls back to failing closed */
  }
  return refreshed;
}

/** Merged `{...required, ...optional}` per TYPE, built at most once per sweep (#1193). */
function mergedInputsFor(def, cache, type) {
  if (cache.has(type)) return cache.get(type);
  const merged = { ...(def.input?.required ?? {}), ...(def.input?.optional ?? {}) };
  cache.set(type, merged);
  return merged;
}

/**
 * Is this input spec a combo whose authoritative option list came back EMPTY?
 *
 * A combo's spec is `[[opt, ...], config?]`. An empty first element is the backend saying
 * "this widget has no valid values" — which is a real answer (#507/#1133: a server with zero
 * checkpoints), not a panel failure. It is worth DISCLOSING and never worth refusing over.
 */
function isEmptyComboSpec(spec) {
  const first = Array.isArray(spec) ? spec[0] : undefined;
  return Array.isArray(first) && first.length === 0;
}

/**
 * #1172 — the combos whose AUTHORITATIVE list is empty, for the types actually on the graph.
 *
 * Computed from the `/object_info` payload the caller already holds, deliberately NOT by
 * re-reading widgets after `app.refreshComboInNodes()` resolves. #1193 wants to stop waiting
 * on that call; a disclosure that depended on it would tie this answer to the one await it is
 * trying to drop, and would report nothing at all if the call were ever abandoned mid-flight.
 *
 * Scoped to types PRESENT on the graph. The backend may publish dozens of empty combos for
 * packs the user is not using, and reporting those would bury the one node that matters —
 * the same "say only what was observed to matter" rule `describeUploadFailure` follows.
 *
 * @returns {Array<{type: string, widget: string}>} sorted, de-duplicated
 */
export function emptyComboListsOnGraph(rootGraph, defsByType) {
  const found = new Map();
  if (!defsByType) return [];
  try {
    const cache = new Map();
    for (const graph of collectAllGraphs(rootGraph)) {
      for (const node of graph._nodes ?? []) {
        const type = node?.type ?? node?.comfyClass;
        const def = type ? defsByType[type] : null;
        if (!def) continue;
        const inputs = mergedInputsFor(def, cache, type);
        for (const [widget, spec] of Object.entries(inputs)) {
          if (!isEmptyComboSpec(spec)) continue;
          found.set(`${type}::${widget}`, { type, widget });
        }
      }
    }
  } catch {
    /* best-effort — a malformed def means we disclose less, never that we refuse */
  }
  return [...found.values()].sort((a, b) => a.type.localeCompare(b.type) || a.widget.localeCompare(b.widget));
}

/**
 * #1172 — what to tell the agent when the backend's own list came back empty.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: name a cause, or predict what another command will do.
 * The same rule `describeUploadFailure` states for #756, and a first version of this note
 * broke it twice. It said "the backend is not finding it: check that server's model paths,
 * then restart ComfyUI" — an INFERENCE. An empty list is equally a node whose combo the
 * CLIENT populates, a pack that publishes an empty enum deliberately, or a server with
 * genuinely zero of that asset. And it said "setting one of these widgets will be refused",
 * which is simply FALSE: `set-widget.js` treats an authoritative empty list as unknowable
 * and PERFORMS the write, reporting `empty_option_list: true` (#507/#1133). That sentence
 * would have talked an agent out of a write that succeeds.
 *
 * So it reports the observation and the one thing that genuinely follows from it — that a
 * second refresh returns the same payload, because the refresh is not what is empty.
 */
export function emptyComboNote(empties) {
  if (!Array.isArray(empties) || !empties.length) return "";
  const shown = empties.slice(0, 6).map((e) => `${e.type}.${e.widget}`).join(", ");
  const more = empties.length > 6 ? `, and ${empties.length - 6} more` : "";
  return (
    `${empties.length} combo widget${empties.length === 1 ? "" : "s"} on this graph ` +
    `${empties.length === 1 ? "has" : "have"} an EMPTY list of valid values in the definitions ` +
    `the backend just published: ${shown}${more}. The refresh itself succeeded — this empty ` +
    `list is what /object_info answered. Why the list is empty ` +
    `is NOT established here: it may be an asset the server has none of, a combo this node ` +
    `populates client-side, or a pack that publishes an empty list deliberately. A write to ` +
    `one of these is still permitted and reports empty_option_list, but nothing can verify ` +
    `the value against a list the backend did not provide.`
  );
}

/**
 * Whether a sweep's stats amount to "every live combo list on this graph is now the one
 * `/object_info` just published". #1193's disclosure and the shared combo-trust flag both
 * ask this, so they cannot drift apart by asking it differently.
 *
 * THREE ways to be false, and the third is the one that bit: no stats at all (the sweep
 * never ran — no payload, no graph), `completed` false (it stopped part way), or
 * `combosSkipped` non-zero (it finished, and left combo lists it could not derive exactly
 * as stale as it found them). Reading only `completed` granted the claim over a graph of
 * V2 combos that were never touched — and on ComfyUI 0.33 V2 is 467 of 529 combo inputs,
 * so that was the normal case, not an edge one.
 */
export function comboRebuildCovered(stats) {
  if (!stats || stats.completed !== true) return false;
  return (stats.combosSkipped ?? 0) === 0;
}

/**
 * Stamp fresh defs onto live node INSTANCES, rebuild their combo option lists, and repair
 * UNKNOWN widget names. Returns the number of nodes whose widget names were repaired.
 *
 * `stats`, when given, is filled in with what this sweep OBSERVABLY did — `nodesSwept`,
 * `combosRebuilt`, `combosSkipped` (combo widgets whose authoritative list this file could
 * not derive: a remote V2, a dynamic V3, a shape published after this was written), and
 * `completed` (set only after every graph was walked to the end).
 *
 * #1193 reads it, and reads BOTH: a caller may treat the live combo lists as rebuilt from
 * `defsByType` only when the sweep it ran actually finished AND skipped nothing. Those are
 * separate facts — a finished sweep that skipped a combo has left that widget's list
 * exactly as stale as it found it — so they are reported separately rather than folded
 * into one boolean the caller cannot take apart.
 */
export function reapplyDefsToLiveNodes(rootGraph, defsByType, stats = null) {
  let repaired = 0;
  if (!defsByType) return repaired;
  try {
    // #1193 — one merged input map per TYPE for the whole sweep, not one per node. This
    // removes the per-node spread; it does NOT make the sweep free. Rebuilding still walks
    // every widget and copies each authoritative array, which is work the sweep did not do
    // before. Stated rather than claimed safe: it has not been measured against #1193's
    // 3.97s register/reapply figure.
    const mergedCache = new Map();
    for (const graph of collectAllGraphs(rootGraph)) {
      for (const node of graph._nodes ?? []) {
        const type = node?.type ?? node?.comfyClass;
        const def = type ? defsByType[type] : null;
        if (!def) continue;
        // #1172 — REBUILD THE COMBO OPTION ARRAYS HERE.
        //
        // This sweep stamped `ctor.nodeData` and reconciled UNKNOWN widget names but never
        // touched `options.values`, even though `refreshComboOptionsFromDefs` — which does
        // exactly that — sits thirty lines above and was called only from the set_widget
        // path. Rebuilding was delegated entirely to `app.refreshComboInNodes()`, whose
        // per-node effect the panel never observes and never verifies, so a newly added
        // CheckpointLoaderSimple kept an empty `ckpt_name` list while `refresh_nodes`
        // answered `refreshed: true`. Doing it here also makes the panel's combo state
        // correct independently of whether that frontend call is waited on at all, which is
        // a partial answer to #1193.
        //
        // It is safe to run alongside the frontend call: `refreshComboOptionsFromDefs`
        // skips a dynamic (function) option source and writes the same values
        // `/object_info` just published.
        const rebuilt = refreshComboOptionsFromDefs(
          node,
          defsByType,
          type,
          undefined,
          mergedInputsFor(def, mergedCache, type),
          // #1193 — the same object, so a combo this file could not rebuild is counted
          // into `combosSkipped` at the widget that was skipped rather than inferred
          // later from a total.
          stats,
        );
        if (stats) {
          stats.nodesSwept = (stats.nodesSwept ?? 0) + 1;
          stats.combosRebuilt = (stats.combosRebuilt ?? 0) + rebuilt;
        }
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
    // #1193 — the LAST statement inside the try, so `completed` means every graph was
    // walked to the end. The sweep is best-effort and swallows its own throw below; a
    // caller that treats a PARTIAL sweep as authoritative would be trusting combo lists
    // that were never rebuilt. Set here, the flag cannot say "yes" for a sweep that
    // stopped early — and stays absent, which is neither yes nor no, when it did.
    if (stats) stats.completed = true;
  } catch {
    /* best-effort sweep */
  }
  return repaired;
}
