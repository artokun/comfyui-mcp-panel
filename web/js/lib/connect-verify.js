// Post-mutation link-persistence verification for graph_connect (#397).
//
// LiteGraph's `LGraphNode.connect(outIdx, target, inIdx)` can return a TRUTHY link
// object at the moment of the call and yet leave NO persisted link on the live
// graph — e.g. when the target input is a WIDGET-backed pseudo-input (rgthree/Impact
// nodes like ImpactSwitch expose `select` as an INT widget, not a real socket) that
// the node reverts or restructures away synchronously, or a dynamic-input node that
// re-slots on connect and drops the just-created link. The panel used to report a
// full success (with a `type`) purely on that truthy return, so panel_connect
// FALSELY claimed a persisted wire that isn't on the graph (ImpactSwitch.select),
// while an identical Reroute→select on a real socket (LatentSwitch) did persist.
//
// This module is the single source of truth for "did the link ACTUALLY land". It is
// pure (no DOM / no ComfyUI globals — the graph + nodes are passed in) so it drives
// the SAME check under unit test that production runs.

/**
 * True only when `link` is a REAL, persisted connection on `graph`:
 *   - the link object carries an id AND
 *   - `graph.links[link.id]` still exists (not reverted/removed) AND
 *   - the target input at `inIdx` actually references THAT link id.
 *
 * Fails CLOSED (returns false) on any missing/mismatched piece, so a phantom link is
 * never reported as connected. `graph.links` may be an array or a plain object keyed
 * by id in different LiteGraph builds — both are read by index/key access.
 */
export function isLinkPersisted(graph, target, inIdx, link) {
  const linkId = link?.id;
  if (linkId == null) return false;
  const links = graph?.links;
  if (!links) return false;
  const stored = typeof links.get === "function" ? links.get(linkId) : links[linkId];
  if (stored == null) return false;
  const input = target?.inputs?.[inIdx];
  if (!input) return false;
  // The input's `link` must reference the SAME link id we just created. (A widget
  // pseudo-input that was reverted has `link == null`; a re-slotted node points the
  // slot at a different/absent link.)
  return input.link === linkId;
}

/**
 * Best-effort removal of the DANGLING remnant of a FAILED connect attempt so the graph
 * is left clean (no half-link the next serialize would trip over). Removes the link ID
 * ONLY when it is the debris of the attempt we just made — the stored link still claims
 * to target the EXACT (target node, input slot) we tried, yet that input does not
 * back-reference it. If a dynamic node RE-SLOTTED the link to a DIFFERENT input (the
 * stored link's target points elsewhere), that is a LEGITIMATE connection and is NEVER
 * deleted — deleting it would destroy a real wire the node deliberately moved. Fully
 * defensive; never throws. Takes the same (graph, target, inIdx, link) the persistence
 * check used so the "is this our debris?" decision is grounded in the live link store.
 */
export function removePhantomLink(graph, target, inIdx, link) {
  const linkId = link?.id;
  if (linkId == null || !graph) return;
  try {
    const links = graph.links;
    if (!links) return;
    const stored = typeof links.get === "function" ? links.get(linkId) : links[linkId];
    // Nothing stored under this id ⇒ the connect was fully reverted; nothing to clean up.
    if (stored == null) return;
    // The stored link must still point at the SLOT we attempted; only then is an
    // unreferenced input the signature of our dangling attempt. LLink exposes
    // target_id/target_slot (array-form links use [3]/[4]).
    const targetId = stored.target_id ?? stored[3];
    const targetSlot = stored.target_slot ?? stored[4];
    const sameSlot =
      String(targetId) === String(target?.id) && Number(targetSlot) === Number(inIdx);
    const inputReferencesIt = target?.inputs?.[inIdx]?.link === linkId;
    // Re-slotted elsewhere (not our slot) OR actually attached ⇒ a real link; keep it.
    if (!sameSlot || inputReferencesIt) return;
    if (typeof graph.removeLink === "function") {
      graph.removeLink(linkId);
      return;
    }
    if (typeof links.delete === "function") links.delete(linkId);
    else if (Object.prototype.hasOwnProperty.call(links, linkId)) delete links[linkId];
  } catch {
    /* best-effort cleanup — the honest failure is reported regardless */
  }
}

/**
 * True when `input` is a WIDGET-BACKED input slot (rendered as a widget, not a plain
 * socket) — the class of target that most often accepts a transient link but does not
 * persist it. Used only to enrich the honest-failure message so the caller is told
 * WHY (set the value with panel_set_widget, or convert the widget to a real input in
 * the UI first). Detection is by LiteGraph's `input.widget` backlink.
 */
export function isWidgetBackedInput(input) {
  return !!(input && input.widget);
}

// ---------------------------------------------------------------------------
// #1272 — the SAME question asked on the THROW path.
//
// `isLinkPersisted` above needs the link object `connect()` RETURNED. When
// `connect()` THROWS there is no return value, and the panel used to let the
// exception escape — reporting failure for a connect whose link had already
// landed. That is not hypothetical: LiteGraph writes the link and only THEN
// runs the nodes' hooks.
//
//   LGraphNode.connectSlots (ComfyUI_frontend 1.48.7, LGraphNode.ts ~2938+):
//     graph._links.set(link.id, link)
//     output.links.push(link.id)
//     targetInput.link = link.id
//     graph.trigger("node:slot-links:changed", …)   <-- can throw
//     this.onConnectionsChange?.(OUTPUT, …)          <-- can throw
//     inputNode.onConnectionsChange?.(INPUT, …)      <-- can throw
//
//   SubgraphOutput.connect / SubgraphInput.connect (subgraph/*.ts): identical
//   ordering — `subgraph._links.set` + `linkIds` + `slot.link` are written
//   first, `node.onConnectionsChange?.()` runs last.
//
// So EVERY hook that can throw runs AFTER the link is fully persisted. A throw
// therefore carries no information about whether the wire exists, and the only
// honest verdict comes from reading the live graph back. These helpers do that
// with the SAME fail-closed strength as `isLinkPersisted`: a link counts only
// when the store holds it AND the slot that should own it back-references that
// exact id.
//
// They deliberately do NOT promise permanence — like `isLinkPersisted`, they
// describe the instant right after the call (see #992). "Did it land at all"
// is the question here, and that one they can answer.
// ---------------------------------------------------------------------------

/**
 * The link stored under `linkId`, or null.
 *
 * **`linkId` MUST be the RAW id, never stringified.** The live store is
 * `_links: Map<LinkId, LLink>` with `LinkId = number`, wrapped in a Proxy whose
 * methods are bound straight through — so `links.get` IS `Map.prototype.get`, and
 * `Map.get("7")` MISSES a key of `7`. `graph.getLink(id)` is `_links.get(id)` and
 * misses identically, so the fallback cannot rescue a stringified id either. A
 * helper that normalised ids to strings before reaching here returned "no link"
 * for every link on a real graph — a fully persisted wire read as absent. The
 * ONLY place an id may be stringified is set membership, which is why that lives
 * in `linkIdExclusionSet` below and nowhere else.
 *
 * `graph.links` is an array in some LiteGraph builds and the Map-backed Proxy in
 * current ComfyUI ones; both, plus `getLink`, are tried defensively — a reader
 * that throws would turn a verdict into a second failure.
 */
export function readStoredLink(graph, linkId) {
  if (linkId == null || !graph) return null;
  try {
    const links = graph.links;
    if (links) {
      const stored = typeof links.get === "function" ? links.get(linkId) : links[linkId];
      if (stored != null) return stored;
    }
    if (typeof graph.getLink === "function") return graph.getLink(linkId) ?? null;
  } catch {
    /* an unreadable store is "no link", never a thrown verdict */
  }
  return null;
}

/**
 * Link ids currently back-referenced by `node`'s INPUT slots — **RAW**, exactly as
 * the slots hold them, so they stay usable as store keys (see `readStoredLink`).
 */
export function inputLinkIds(node) {
  const ids = [];
  for (const input of node?.inputs ?? []) {
    if (input?.link != null) ids.push(input.link);
  }
  return ids;
}

/**
 * Link ids currently held by a subgraph boundary-rail slot — **RAW**, for the same
 * reason: `findLandedRailLink` iterates these and feeds each one to the link store,
 * so stringifying here made every rail lookup miss.
 */
export function railSlotLinkIds(railSlot) {
  const ids = [];
  for (const id of railSlot?.linkIds ?? []) {
    if (id != null) ids.push(id);
  }
  return ids;
}

/**
 * The one place link ids are stringified: an exclusion SET for the "did THIS call
 * add it?" question.
 *
 * Membership has to survive a number/string mismatch, while a store lookup must
 * NOT — `Map.get("7")` misses a key of `7`. Those two requirements are opposites,
 * and collapsing them into one "ids as strings" helper is precisely how a working
 * rail verdict became a 100% false negative. Keeping the string form to this
 * function, and reading the store only with raw ids, is what keeps them apart.
 *
 * Takes ANY iterable of ids — an array, or a Set a caller already built. Callers
 * must NOT skip this on the grounds that they already hold a Set: a Set of RAW
 * numbers passed straight through is a set whose `has(String(id))` never matches,
 * so every exclusion silently evaporates and a PRE-EXISTING link gets credited to
 * the current call. Normalising unconditionally is idempotent (a Set of strings
 * re-normalises to itself) and costs one pass over a handful of ids.
 */
export function linkIdExclusionSet(ids) {
  const set = new Set();
  for (const id of ids ?? []) if (id != null) set.add(String(id));
  return set;
}

/**
 * The link that a node→node connect actually left behind, or null.
 *
 * Scans `target`'s inputs (NOT just the requested one — a dynamic-input node
 * may re-slot the link to the slot it materialised, which is exactly what
 * #1272's ImpactSwitch does) for a slot whose `link` back-reference resolves to
 * a stored link originating at `origin` output `outIdx`.
 *
 * `excludeIds` are the ids observed BEFORE the mutation. A link already present
 * beforehand is NOT evidence this call landed — without that exclusion a connect
 * that threw before doing anything would be credited with a wire someone else
 * made, which is the "two states, one answer" defect this whole check exists to
 * remove. Returns `{ linkId, inputIndex }`.
 */
export function findLandedInboundLink(graph, origin, outIdx, target, excludeIds) {
  const originId = origin?.id;
  if (originId == null || !target) return null;
  const skip = linkIdExclusionSet(excludeIds);
  const inputs = target.inputs ?? [];
  for (let i = 0; i < inputs.length; i++) {
    const linkId = inputs[i]?.link;
    if (linkId == null || skip.has(String(linkId))) continue;
    const stored = readStoredLink(graph, linkId);
    if (stored == null) continue;
    const storedOrigin = stored.origin_id ?? stored[1];
    const storedOriginSlot = stored.origin_slot ?? stored[2];
    if (String(storedOrigin) !== String(originId)) continue;
    if (Number(storedOriginSlot) !== Number(outIdx)) continue;
    return { linkId, inputIndex: i };
  }
  return null;
}

/**
 * True only when `link` (the object a rail `connect()` RETURNED) is persisted on
 * `railSlot`: the rail slot lists that exact id AND the stored link joins it to
 * `node` at `slotIdx`. The rail-branch analogue of `isLinkPersisted` — #397 was
 * adopted at the node→node call site only, so the two rail branches reported
 * success on LiteGraph's truthy return alone.
 *
 * `side` is "output" for the OUTPUT rail (node output → rail; the link's ORIGIN
 * is the node) and "input" for the INPUT rail (rail → node input; the link's
 * TARGET is the node).
 */
export function isRailLinkPersisted(graph, railSlot, node, slotIdx, side, link) {
  const linkId = link?.id;
  if (linkId == null) return false;
  // Membership tolerates a number/string mismatch; the STORE read then uses the
  // id the slot itself holds, raw.
  const onSlot = railSlotLinkIds(railSlot).find((id) => String(id) === String(linkId));
  if (onSlot == null) return false;
  return railLinkJoins(readStoredLink(graph, onSlot), node, slotIdx, side);
}

/**
 * The NEW link a rail connect left behind, or null — the throw-path counterpart
 * of `isRailLinkPersisted` (no returned link to key on). Same fail-closed
 * strength: the id must be on the rail slot, resolve in the store, and join
 * `node`/`slotIdx`; ids present before the mutation are excluded so a pre-existing
 * wire is never credited to this call. Returns `{ linkId }`.
 */
export function findLandedRailLink(graph, railSlot, node, slotIdx, side, excludeIds) {
  const skip = linkIdExclusionSet(excludeIds);
  for (const linkId of railSlotLinkIds(railSlot)) {
    // String() on the MEMBERSHIP side only — `linkId` itself stays raw for the
    // store read on the next line.
    if (skip.has(String(linkId))) continue;
    if (railLinkJoins(readStoredLink(graph, linkId), node, slotIdx, side)) return { linkId };
  }
  return null;
}

/** Does `stored` join `node` at `slotIdx` on the given rail `side`? */
function railLinkJoins(stored, node, slotIdx, side) {
  if (stored == null || node?.id == null) return false;
  const nodeId = side === "input" ? (stored.target_id ?? stored[3]) : (stored.origin_id ?? stored[1]);
  const nodeSlot =
    side === "input" ? (stored.target_slot ?? stored[4]) : (stored.origin_slot ?? stored[2]);
  return String(nodeId) === String(node.id) && Number(nodeSlot) === Number(slotIdx);
}

/**
 * The disclosure attached to a connect that THREW but whose link IS on the live
 * graph — shared by graph_connect's three branches and by the two
 * graph_expose_subgraph_* paths, so it names no particular reply key. The verdict
 * itself comes from the post-state check; this states that plainly, quotes the
 * throw verbatim rather than hiding it, and tells the caller not to retry — the
 * retry is what turns this false negative into duplicated or torn-down wiring.
 * `extra` carries a site-specific observation (e.g. the node re-slotted the link)
 * and is omitted when there is nothing extra to say.
 */
export function landedAfterThrowWarning(err, extra = "") {
  return (
    `the ComfyUI frontend threw while applying this connect (${err?.message ?? err}) but the live ` +
    `graph shows the link IS present, so the result above reflects the live graph rather ` +
    `than the exception (#1272). ` +
    (extra ? `${extra} ` : "") +
    `Do NOT retry this connect — a retry would duplicate or tear down wiring that is already ` +
    `correct. The node that threw may have been left mid-reshape, so re-read it with ` +
    `panel_query_graph before wiring anything else to it.`
  );
}
