// Robust wrapper around litegraph's `graph.remove(node)` (#420).
//
// `graph.remove(node)` disconnects the node's links first. On some litegraph builds
// (older/classic ComfyUI frontends, or classic-litegraph custom nodes such as VHS /
// rgthree) the disconnect path resolves the FAR END of a link via
// `graph.getNodeById(link.target_id/origin_id)` and then calls a method on it
// (`findInputSlot`, etc.). During rapid batched removals (deleting many linked nodes
// in one turn) that far-end lookup can momentarily return something that is NOT a
// proper LGraphNode — a half-removed node, a foreign/plain object — so the call
// throws `t.findInputSlot is not a function` and the whole removal aborts. The same
// call succeeds on a retry a moment later once the link state settles.
//
// Recovery, ONLY for that recognized link-disconnect crash (see isLinkDisconnectCrash
// — any other error, e.g. a node's own onRemoved() throwing, propagates so we never
// retry-and-duplicate its side effects or mask it as success):
//   Sever every non-rail link still referencing this node at the RECORD level
//   (severNodeLinks) — deleting the store record and clearing the far-end's mirror
//   slot ref with a plain property write, NEVER a far-end method call and NEVER
//   litegraph's own disconnect. This is deliberate: re-running litegraph's disconnect
//   would re-fire the far-end onConnectionsChange hook that may itself have thrown the
//   crash, invoking it twice. With every non-rail link already gone, the retried
//   `graph.remove` has nothing left to disconnect, so it cannot re-enter the throwing
//   far-end path or re-fire any far-end disconnect hook. Rail links (ids -10 / -20, or
//   graph.inputNode/outputNode) are LEFT for litegraph's rail-aware retry and the
//   caller's boundary pruning; a real-node far end has its mirror cleared; a
//   genuinely-missing (non-rail) far end just has its record dropped (no orphan).
//   Then retry `graph.remove(node)` once; a genuine second failure propagates.
//
// Operates only on the passed graph/node, so it is unit-testable with a mock graph
// that reproduces the throw-then-succeed behavior.

// LiteGraph subgraph boundary rail node ids (mirror of the main panel file). Rails are
// deliberately absent from graph._nodes_by_id, so getNodeById can't resolve them.
const SUBGRAPH_INPUT_RAIL_ID = -10;
const SUBGRAPH_OUTPUT_RAIL_ID = -20;

/** True when two litegraph node ids refer to the same node, tolerant of a
 *  number-vs-string id representation (subgraph ids can be strings). */
function sameNodeId(a, b) {
  return a === b || (a != null && b != null && String(a) === String(b));
}

/** True when a node id refers to a subgraph boundary rail (by the reserved rail ids
 *  or by matching this graph's live inputNode/outputNode). Rail links must be left
 *  for litegraph's rail-aware path + the caller's boundary pruning, never nuked. */
function isRailId(graph, id) {
  if (id == null) return false;
  if (sameNodeId(id, SUBGRAPH_INPUT_RAIL_ID) || sameNodeId(id, SUBGRAPH_OUTPUT_RAIL_ID))
    return true;
  // Match the panel's rail-node resolution, which supports both the public
  // inputNode/outputNode and the private _inputNode/_outputNode variants
  // (web/js/lib/subgraph-scope.js resolveRailNode).
  const inId = (graph?.inputNode ?? graph?._inputNode)?.id;
  const outId = (graph?.outputNode ?? graph?._outputNode)?.id;
  return (inId != null && sameNodeId(id, inId)) || (outId != null && sameNodeId(id, outId));
}

/** Read a link record by id from either the modern Map (`_links`) or the
 *  back-compat record/proxy (`links`). Returns undefined when absent. */
function getLinkRecord(graph, id) {
  if (id == null) return undefined;
  const map = graph?._links;
  if (map && typeof map.get === "function") return map.get(id);
  const rec = graph?.links;
  return rec ? rec[id] : undefined;
}

/** Delete a link record from whichever store the graph uses. Never throws.
 *
 *  Prefers the record's OWN `LLink.disconnect(network)` when present: in modern
 *  litegraph that primitive not only deletes the store record but also removes the
 *  link id from every reroute and clears its layout-store entry — and it touches NO
 *  far-end node method, so it's safe on the crash-recovery path. Raw store deletion
 *  is the fallback for legacy record stores (and test mocks) with no such method. */
function dropLinkRecord(graph, id, link) {
  if (link && typeof link.disconnect === "function") {
    try {
      link.disconnect(graph); // deletes the record + cleans reroutes/layout, far-end-free
      return;
    } catch {
      // fall through to raw deletion
    }
  }
  if (id == null) return;
  try {
    const map = graph?._links;
    if (map && typeof map.delete === "function") {
      map.delete(id); // the back-compat `links` proxy mirrors `_links`
      return;
    }
    const rec = graph?.links;
    if (rec && typeof rec === "object") delete rec[id];
  } catch {
    // Best effort — a link we can't delete just becomes a harmless dangling id that
    // renders as no wire; the retry still removes the node.
  }
}

/** Enumerate [id, record] pairs from either the Map store or the legacy record. */
function linkEntries(graph) {
  const map = graph?._links;
  if (map && typeof map.forEach === "function" && typeof map.get === "function") {
    return [...map.entries()];
  }
  const rec = graph?.links;
  if (rec && typeof rec === "object") {
    return Object.keys(rec).map((k) => [rec[k]?.id ?? k, rec[k]]);
  }
  return [];
}

/** Sever one link whose ORIGIN is this node (far end = the link's TARGET input).
 *  Returns true when severed; false when LEFT because the far end is a rail. */
function severOutgoing(graph, link, id) {
  const targetId = link?.target_id;
  if (isRailId(graph, targetId)) return false; // rail → leave for boundary machinery
  const far = graph?.getNodeById?.(targetId);
  if (far != null) {
    try {
      const slot = far?.inputs?.[link?.target_slot];
      if (slot && slot.link === link.id) slot.link = null; // plain write, no far-end method
    } catch {
      /* far end unusable — drop the record regardless */
    }
  }
  // Real node (mirror cleared), broken non-node culprit, or genuinely-missing node —
  // all non-rail: drop the record so the retry can't re-enter the throwing path and
  // no orphan is left behind.
  dropLinkRecord(graph, id, link);
  return true;
}

/** Sever one link whose TARGET is this node (far end = the link's ORIGIN output).
 *  Returns true when severed; false when LEFT because the far end is a rail. */
function severIncoming(graph, link, id) {
  const originId = link?.origin_id;
  if (isRailId(graph, originId)) return false; // rail → leave for boundary machinery
  const far = graph?.getNodeById?.(originId);
  if (far != null) {
    try {
      const links = far?.outputs?.[link?.origin_slot]?.links;
      if (Array.isArray(links)) {
        const i = links.indexOf(link.id);
        if (i !== -1) links.splice(i, 1); // array splice, no far-end method
      }
    } catch {
      /* far end unusable — drop the record regardless */
    }
  }
  dropLinkRecord(graph, id, link);
  return true;
}

/**
 * Sever the non-rail links still touching `node` by manipulating link records
 * directly, never calling a method on a far-end node. Exported for testing.
 *
 * Two passes because this runs AFTER an aborted mid-disconnect `graph.remove`:
 *  1) SLOT PASS — walk this node's own slot refs; sever each non-rail link and keep
 *     any rail link id in place for litegraph's rail-aware retry.
 *  2) STORE SWEEP — enumerate the link store for records whose origin/target is this
 *     node but whose slot ref the aborted remove already nulled (otherwise
 *     unreachable), and sever the non-rail ones.
 */
export function severNodeLinks(graph, node) {
  // --- Pass 1: this node's own slot refs ---
  for (const out of node?.outputs ?? []) {
    if (!Array.isArray(out?.links)) continue;
    const kept = [];
    for (const id of [...out.links]) {
      const link = getLinkRecord(graph, id);
      if (!link) continue; // unknown/dangling id → drop from the slot
      if (!severOutgoing(graph, link, id)) kept.push(id); // rail → keep
    }
    out.links = kept.length ? kept : null; // litegraph's empty-output convention
  }
  for (const inp of node?.inputs ?? []) {
    const id = inp?.link;
    if (id == null) continue;
    const link = getLinkRecord(graph, id);
    if (!link) {
      inp.link = null; // dangling id → clear
      continue;
    }
    if (severIncoming(graph, link, id)) inp.link = null;
    // else: rail origin — leave inp.link for litegraph's rail-aware retry
  }

  // --- Pass 2: store sweep for records the slot pass could not reach ---
  const nodeId = node?.id;
  if (nodeId == null) return;
  for (const [id, link] of linkEntries(graph)) {
    if (!link) continue;
    if (sameNodeId(link.origin_id, nodeId)) severOutgoing(graph, link, id);
    else if (sameNodeId(link.target_id, nodeId)) severIncoming(graph, link, id);
  }
}

/** #713 — the far-end SLOT MIRROR WRITE variant. Same disconnect phase and same
 *  cause as the method-call variant above: while clearing the far end's mirror of a
 *  link litegraph writes `farNode.inputs[slot].link = null` /
 *  `farNode.outputs[slot].links = …`, and during a rapid batched removal of LINKED
 *  nodes a sibling removal can tear that slot array out from under it, so the
 *  indexed slot reads `undefined`/`null` and the property write throws.
 *
 *  Kept as narrow as the method-call form by requiring the `link`/`links` property
 *  NAME: an unrelated undefined-write ("… (setting 'foo')") is not recoverable.
 *
 *  Both V8 phrasings are matched. Current V8 (Chrome ≥ 91) says
 *  `Cannot set properties of undefined (setting 'link')` — the exact text in the
 *  #713 report — while older Chromium/Electron builds say
 *  `Cannot set property 'link' of undefined`. Panels do run on old embedded
 *  Chromium, and recognizing only the modern phrasing there would reopen the same
 *  hole this fixes.
 *
 *  KNOWN LIMIT, deliberately not papered over: SpiderMonkey ("o.inputs[3] is
 *  undefined") and JavaScriptCore ("undefined is not an object") do not name the
 *  property at all, so this variant cannot be recognized narrowly on those engines
 *  and is left unrecovered rather than matched by a broad pattern that would swallow
 *  unrelated TypeErrors. */
const SLOT_MIRROR_WRITE_RE =
  /Cannot set propert(?:y|ies) of (?:undefined|null) \(setting ['"](?:link|links)['"]\)|Cannot set property ['"](?:link|links)['"] of (?:undefined|null)/;

/** True for a recognized link-disconnect crash — a TypeError thrown by litegraph
 *  while it is tearing down the FAR END of a link during `graph.remove`. Two
 *  variants, same phase and same recovery:
 *
 *  (a) #420, the slot-LOOKUP method call: the far end resolves to something that is
 *      not a proper LGraphNode, so calling a slot lookup on it throws (minified:
 *      "t.findInputSlot is not a function"). Narrowed to findInputSlot /
 *      findOutputSlot, the only far-end lookups litegraph performs there.
 *  (b) #713, the slot-MIRROR WRITE — see SLOT_MIRROR_WRITE_RE above.
 *
 *  Both stay narrow so an unrelated TypeError is never treated as recoverable, and
 *  message shape is only the FIRST of safeRemoveNode's two guards: the crash must
 *  also have left residual links, which is what actually distinguishes a
 *  disconnect-phase crash from a post-disconnect hook error. (Recovery never re-runs
 *  litegraph's disconnect, so even if a custom hook threw one of these exact internal
 *  signatures, the retry does not re-invoke it — see safeRemoveNode.) */
export function isLinkDisconnectCrash(err) {
  if (!(err instanceof TypeError)) return false;
  const msg = String(err?.message ?? "");
  // (a) far-end slot-LOOKUP method invoked on something that isn't an LGraphNode.
  if (/is not a function/.test(msg) && /find(Input|Output)Slot/.test(msg)) return true;
  // (b) far-end slot MIRROR WRITE onto a slot that is already gone.
  return SLOT_MIRROR_WRITE_RE.test(msg);
}

/** True when `node` still has at least one link attached — via its own slot refs OR a
 *  record in the store. This is the version-independent discriminator for the #420
 *  disconnect-phase crash: litegraph fully disconnects every link BEFORE it fires
 *  onRemoved (in BOTH modern and classic builds — classic calls onRemoved before it
 *  splices the node out, so node-presence is NOT a reliable discriminator). So a crash
 *  thrown WHILE links remain is a disconnect-phase crash (safe to sever + retry),
 *  whereas a crash with NO links left came from a post-disconnect callback such as
 *  onRemoved (must propagate — retrying would re-run the hook / duplicate side
 *  effects or mask the failure). A node with no links can't hit the disconnect crash
 *  at all, so this never suppresses a genuine fix. */
export function nodeHasResidualLinks(graph, node) {
  for (const inp of node?.inputs ?? []) if (inp?.link != null) return true;
  for (const out of node?.outputs ?? [])
    if (Array.isArray(out?.links) && out.links.length) return true;
  const nodeId = node?.id;
  if (nodeId == null) return false;
  for (const [, link] of linkEntries(graph)) {
    if (link && (sameNodeId(link.origin_id, nodeId) || sameNodeId(link.target_id, nodeId)))
      return true;
  }
  return false;
}

/**
 * Remove `node` from `graph`, recovering from the intermittent litegraph
 * link-disconnect crash (#420). Returns `{ removed, recovered }`:
 *   - removed:   true once `graph.remove` completed without throwing.
 *   - recovered: true when the first attempt threw the recognized link-disconnect
 *                crash and the disconnect + retry path was used.
 * Any OTHER first-attempt error propagates unchanged (never retried). A genuine
 * second failure on the retry propagates too.
 */
export function safeRemoveNode(graph, node) {
  try {
    graph.remove(node);
    return { removed: true, recovered: false };
  } catch (err) {
    // Recover ONLY from the #420 link-disconnect crash. Two guards, because a node's
    // own onRemoved()/onConnectionsChange() hook could coincidentally throw the SAME
    // "…is not a function" TypeError:
    //   1) message shape (isLinkDisconnectCrash), and
    //   2) the node still has RESIDUAL LINKS. litegraph fully disconnects every link
    //      (where the #420 crash occurs) BEFORE firing onRemoved, in both modern and
    //      classic builds — so a disconnect-phase crash leaves links attached, whereas
    //      a post-disconnect hook error leaves none. Only the former is safe to sever +
    //      retry; a hook error with no links left must propagate (retrying would re-run
    //      the hook / duplicate side effects or mask the failure). Node-presence is NOT
    //      used: classic litegraph fires onRemoved before splicing the node out.
    if (!isLinkDisconnectCrash(err) || !nodeHasResidualLinks(graph, node)) throw err;
    // Sever residual non-rail links at the RECORD level (hook-free) — never re-running
    // litegraph's own disconnect, so no far-end disconnect hook is re-invoked — then
    // retry. With no non-rail links left, the retry can't re-enter the throwing path.
    severNodeLinks(graph, node);
    graph.remove(node); // a real second failure propagates
    return { removed: true, recovered: true };
  }
}
