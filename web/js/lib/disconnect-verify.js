// Pre/post-mutation verification for graph_disconnect (#668).
//
// `node.disconnectInput(inIdx)` is documented as "remove the link on this input",
// but on a SubgraphNode the frontend can cascade far beyond that: #668 observed
// three panel_disconnect calls on a subgraph node's inputs DELETE two unrelated
// nodes — a LoadImage two hops upstream and a downstream SaveVideo consuming the
// subgraph's output — while every call returned a plain success payload. The exact
// frontend mechanism is unconfirmed (a boundary-slot removal shifting the inputs
// array is one lead); what is certain is that the panel assumed disconnectInput
// only drops one wire and never checked.
//
// This module fixes the PROPERTY, mirroring the #397 connect honesty pattern
// (connect-verify.js): the panel snapshots the graph's node set and link set
// BEFORE the call, re-reads them AFTER, and refuses to report a bare success when
// anything beyond the intended link changed. Because the destruction has already
// happened when verification fails, the caller DISCLOSES loudly (exactly which
// nodes/links changed, undo remedy) rather than refusing — refusing after the
// fact would report failure for a disconnect that may have landed and invite a
// destructive retry.
//
// Scope of the snapshot, deliberately asymmetric:
//   - NODE SETS are tracked RECURSIVELY into descendant subgraphs (ids qualified
//     by the subgraph-node path, "105>12"): a disconnect can never legitimately
//     delete a node anywhere, interior or not, so every deletion is reported.
//   - LINK SETS are tracked for the CURRENT graph only. A disconnect of the
//     last external wire to a subgraph boundary slot may legitimately prune that
//     slot and its INTERIOR rail links — flagging those would fail ordinary,
//     correct use. Collateral link loss in the graph the caller is looking at
//     is never legitimate, so there it fails. The panel discloses a changed
//     boundary-slot shape via its own warning, which covers the legitimate
//     interior case.
//
// Pure (no DOM / no ComfyUI globals — graph + nodes are passed in) so the unit
// tests drive the SAME check production runs.

// litegraph's sentinel for the unassigned end of a FLOATING link (a mid-drag
// stub). Floating links are transient UI state, not graph wires, so they are
// excluded from the before/after link diff — their appearance/disappearance is
// not a mutation worth failing on.
const UNASSIGNED_NODE_ID = -1;

/** Read a link record by id from either the modern Map (`_links`) or the
 *  back-compat record/proxy (`links`). Returns undefined when absent. */
function getLinkRecord(graph, id) {
  if (id == null) return undefined;
  const map = graph?._links;
  if (map && typeof map.get === "function") return map.get(id);
  const rec = graph?.links;
  return rec ? rec[id] : undefined;
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

/** True when the link is a floating mid-drag stub (one end unassigned). */
function linkIsFloating(link) {
  return (
    Number(link?.origin_id) === UNASSIGNED_NODE_ID ||
    Number(link?.target_id) === UNASSIGNED_NODE_ID
  );
}

/**
 * Snapshot the parts of `graph` a disconnect must never change beyond the one
 * intended link: the node id set (RECURSIVELY into descendant subgraphs — a
 * node deletion is never a legitimate disconnect side effect anywhere) and the
 * set of real (non-floating) links OF THIS GRAPH (interior link pruning by a
 * boundary-slot cascade is legitimate; see the module header). Ids are
 * string-normalized — subgraph node ids can be strings while link endpoints
 * may carry them as numbers, and Map keys / legacy record keys differ in type
 * across litegraph builds. Interior node ids are qualified by the subgraph-node
 * path ("105>12") so rail ids (-10/-20) and local id collisions across nested
 * graphs can never alias each other.
 *
 * Returns `{ nodeIds: Set<string>, links: Map<string, linkView> }` where
 * linkView is `{ id, origin_id, origin_slot, target_id, target_slot }`.
 */
export function snapshotGraphState(graph) {
  const nodeIds = new Set();
  collectNodeIds(graph, "", nodeIds);
  const links = new Map();
  for (const [id, link] of linkEntries(graph)) {
    if (!link || id == null || linkIsFloating(link)) continue;
    links.set(String(id), {
      id,
      origin_id: link.origin_id,
      origin_slot: link.origin_slot,
      target_id: link.target_id,
      target_slot: link.target_slot,
    });
  }
  return { nodeIds, links };
}

/** Recursively add "path-qualified" node ids: top-level ids plain, interior
 *  ids as "<subgraphNodeId>><innerId>" (deeper nesting extends the path). */
function collectNodeIds(graph, prefix, out) {
  for (const n of graph?._nodes ?? []) {
    if (n?.id == null) continue;
    const path = prefix + String(n.id);
    out.add(path);
    const inner = n?.subgraph;
    if (inner && Array.isArray(inner._nodes)) collectNodeIds(inner, `${path}>`, out);
  }
}

/**
 * Describe the link currently feeding `node`'s input `inIdx`, or null when the
 * input is not connected. Captured BEFORE the mutation: on a SubgraphNode the
 * disconnect can remove the boundary slot and shift the inputs array, so any
 * slot read taken afterwards may describe a DIFFERENT input. `node_id`/`output`
 * name the wire's former source (symmetric with graph_connect's replaced_link).
 *
 * A slot whose `link` id has NO record in the graph's link store is a DANGLING
 * reference, not a connection — null is returned so the caller's not-connected
 * refusal covers it (reporting a "removed" wire that never existed would
 * fabricate a mutation). The inverse is fine: the ORIGIN NODE may be gone while
 * its link record still exists, in which case the description falls back to the
 * origin slot index.
 */
export function describeInputLink(graph, node, inIdx) {
  const linkId = node?.inputs?.[inIdx]?.link;
  if (linkId == null) return null;
  const link = getLinkRecord(graph, linkId);
  if (!link) return null;
  const origin = graph?.getNodeById?.(link.origin_id);
  return {
    linkId,
    node_id: link.origin_id,
    output: origin?.outputs?.[link.origin_slot]?.name ?? link.origin_slot,
    output_index: link.origin_slot,
  };
}

/**
 * Verify that a disconnect did EXACTLY what was asked: the intended link is
 * gone (from the link store AND from every input slot of the target node — a
 * boundary-slot cascade can shift `node.inputs`, so the slot reference check
 * scans the whole array, never a fixed index) and NOTHING else changed.
 *
 * `before` is the snapshotGraphState taken pre-mutation; `intendedLinkId` is
 * the link that was on the target input pre-mutation.
 *
 * Returns `{ ok, intendedRemoved, missingNodes, addedNodes,
 * collateralRemovedLinks, addedLinks }` — the caller composes the honest
 * disclosure from whichever buckets are non-empty. `ok` is true only when the
 * intended link is fully gone and every other bucket is empty.
 */
export function verifyDisconnect(graph, node, before, intendedLinkId) {
  const after = snapshotGraphState(graph);
  const intendedId = intendedLinkId != null ? String(intendedLinkId) : null;

  const missingNodes = [...(before?.nodeIds ?? [])].filter((id) => !after.nodeIds.has(id));
  const addedNodes = [...after.nodeIds].filter((id) => !(before?.nodeIds?.has(id) ?? false));

  const collateralRemovedLinks = [];
  for (const [id, view] of before?.links ?? []) {
    if (!after.links.has(id) && id !== intendedId) collateralRemovedLinks.push(view);
  }
  const addedLinks = [];
  for (const [id, view] of after.links) {
    if (!(before?.links?.has(id) ?? false)) addedLinks.push(view);
  }

  const stillInStore = intendedId != null && after.links.has(intendedId);
  const stillReferenced =
    intendedId != null &&
    (node?.inputs ?? []).some((inp) => inp?.link != null && String(inp.link) === intendedId);
  const intendedRemoved = intendedId != null && !stillInStore && !stillReferenced;

  const ok =
    intendedRemoved &&
    missingNodes.length === 0 &&
    addedNodes.length === 0 &&
    collateralRemovedLinks.length === 0 &&
    addedLinks.length === 0;
  return { ok, intendedRemoved, missingNodes, addedNodes, collateralRemovedLinks, addedLinks };
}
