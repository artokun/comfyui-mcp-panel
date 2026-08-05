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
 * intended link: the node id set and the set of real (non-floating) links.
 * Ids are string-normalized — subgraph node ids can be strings while link
 * endpoints may carry them as numbers, and Map keys / legacy record keys
 * differ in type across litegraph builds.
 *
 * Returns `{ nodeIds: Set<string>, links: Map<string, linkView> }` where
 * linkView is `{ id, origin_id, origin_slot, target_id, target_slot }`.
 */
export function snapshotGraphState(graph) {
  const nodeIds = new Set();
  for (const n of graph?._nodes ?? []) {
    if (n?.id != null) nodeIds.add(String(n.id));
  }
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

/**
 * Describe the link currently feeding `node`'s input `inIdx`, or null when the
 * input is not connected. Captured BEFORE the mutation: on a SubgraphNode the
 * disconnect can remove the boundary slot and shift the inputs array, so any
 * slot read taken afterwards may describe a DIFFERENT input. `node_id`/`output`
 * name the wire's former source (symmetric with graph_connect's replaced_link).
 */
export function describeInputLink(graph, node, inIdx) {
  const linkId = node?.inputs?.[inIdx]?.link;
  if (linkId == null) return null;
  const link = getLinkRecord(graph, linkId);
  const origin = link ? graph?.getNodeById?.(link.origin_id) : null;
  return {
    linkId,
    node_id: link?.origin_id,
    output: origin?.outputs?.[link?.origin_slot]?.name ?? link?.origin_slot,
    output_index: link?.origin_slot,
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
