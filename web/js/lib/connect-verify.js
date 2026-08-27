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

import { snapshotGraphState } from "./disconnect-verify.js";

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

/**
 * Collateral-damage verdict for graph_connect (artokun/comfyui-mcp#2380).
 *
 * Every other check on the connect path is scoped to the TWO endpoints the command
 * named: findLandedInboundLink scans the target inbound links, isLinkPersisted reads
 * the target slot, describeTitleRewrites covers origin and target. So a connect that
 * displaces wiring on a THIRD node returned a clean {connected: ...} payload and the
 * caller only discovered it in a later panel_query_graph. #2380 reports exactly that,
 * with two inputs on an untargeted node re-pointed and nothing in any reply saying so.
 *
 * graph_disconnect has carried this check since #668, where a disconnect on a
 * SubgraphNode DELETED two unrelated nodes while reporting plain success. Same class,
 * same remedy: snapshot before, compare after, DISCLOSE what actually changed.
 *
 * Two changes are legitimate and must not be reported as collateral:
 *   - replacedLinkId: the wire that was on the target input. LiteGraph drops it on
 *     reconnect by design, and the reply already names it as replaced_link.
 *   - intendedLinkIds: the link this connect created. A dynamic-input pack can
 *     re-slot it during onConnectionsChange, and the re-slotted wire may carry a
 *     DIFFERENT id than the one connect() returned, so the caller passes both the
 *     returned id and whatever findLandedInboundLink actually found.
 *
 * Everything else that appeared or vanished is collateral. This states observed facts
 * only and never narrates a cause: a pack removing one of its own input slots from
 * inside onConnectionsChange legitimately drops a link, and that is still something
 * the caller needs told rather than something this module can attribute.
 *
 * Returns { ok, missingNodes, addedNodes, collateralRemovedLinks, collateralAddedLinks }.
 * Pure: the graph is passed in, so production and unit test drive the same check.
 */
/**
 * #2380 — the node-side view of the wiring: which link id each input slot names.
 *
 * A third merge-gate P1. `snapshotGraphState` records the LINK STORE, and the store and
 * the node slots are two independent views: a pack can leave every link record byte-
 * identical while swapping `inputs[i].link` on a bystander node, and execution then
 * follows the slot, not the store. The verdict read ok:true on a graph wired to the
 * wrong source — which is the report's own symptom, an input fed from somewhere nobody
 * named.
 *
 * Captured separately rather than by widening snapshotGraphState, which graph_disconnect
 * has shipped against since #668; changing what that returns would alter a verified
 * path this fix has no business touching.
 */
export function snapshotInputSlotLinks(graph) {
  const out = new Map();
  const walk = (g, prefix) => {
    for (const n of g?._nodes ?? []) {
      if (n?.id == null) continue;
      const path = prefix + String(n.id);
      (n.inputs ?? []).forEach((inp, i) => {
        // RAW, not String()-normalised (gate P1). litegraph's `_links` is a NUMBER-keyed
        // Map and its `links` proxy binds Map.prototype.get straight through, so a key of
        // "7" MISSES a record stored under 7 (#1425). Normalising here made `7` and "7"
        // compare equal, so a hook that retyped an untargeted slot's id left the wire
        // unresolvable while the verdict read ok:true. Identity against the intended and
        // replaced ids is normalised at the comparison instead, where it is needed.
        if (inp?.link != null) out.set(`${path}#${i}`, inp.link);
      });
      if (n?.subgraph && Array.isArray(n.subgraph._nodes)) walk(n.subgraph, `${path}>`);
    }
  };
  walk(graph, "");
  return out;
}

export function verifyConnect(
  graph,
  before,
  { intendedLinkIds = [], replacedLinkId, beforeSlots, intendedSlots } = {},
) {
  const after = snapshotGraphState(graph);
  const replacedId = replacedLinkId != null ? String(replacedLinkId) : null;
  const intended = new Set(
    (Array.isArray(intendedLinkIds) ? intendedLinkIds : [intendedLinkIds])
      .filter((id) => id != null)
      .map((id) => String(id)),
  );

  const missingNodes = [...(before?.nodeIds ?? [])].filter((id) => !after.nodeIds.has(id));
  const addedNodes = [...after.nodeIds].filter((id) => !(before?.nodeIds?.has(id) ?? false));

  const collateralRemovedLinks = [];
  for (const [id, view] of before?.links ?? []) {
    if (!after.links.has(id) && id !== replacedId) collateralRemovedLinks.push(view);
  }
  const collateralAddedLinks = [];
  for (const [id, view] of after.links) {
    if (!(before?.links?.has(id) ?? false) && !intended.has(id)) collateralAddedLinks.push(view);
  }

  // A link that keeps its ID but MOVES is invisible to the two set comparisons above,
  // and it is the shape artokun/comfyui-mcp#2380 actually reports: two inputs on an
  // untargeted node ended up fed from different sources. If LiteGraph (or a pack's
  // onConnectionsChange) rewrites a link record in place, `before` and `after` both
  // contain that id, so neither the removed nor the added list sees it and the verdict
  // came back ok:true with nothing to disclose — the verifier missing the very defect it
  // was written for. Compare the ENDPOINTS of every surviving link, not just the id set.
  //
  // The intended and replaced ids are exempt for the same reasons they are above: the
  // link this connect created may be re-slotted by a dynamic pack, and the wire it
  // displaced is already reported as `replaced_link`.
  const sameEndpoints = (a, b) =>
    String(a.origin_id) === String(b.origin_id) &&
    Number(a.origin_slot) === Number(b.origin_slot) &&
    String(a.target_id) === String(b.target_id) &&
    Number(a.target_slot) === Number(b.target_slot);
  const collateralMovedLinks = [];
  for (const [id, was] of before?.links ?? []) {
    // `replacedId` is exempt: connect displaces that wire by design and the reply names it.
    // `intended` is deliberately NOT exempt here, and that is the second gate P1 on this
    // fix. Exempting it by id meant an id REUSE — LiteGraph handing the new link an id a
    // different wire already held — silently destroyed that wire while the verdict read
    // ok:true. Executed proof: before `7: 99->1`, after `7: 2->3`, intendedLinkIds [7];
    // the old 99->1 simply vanished with nothing disclosed. That is the link-id-reuse
    // hypothesis #2380's reporter raised, and the exemption was hiding exactly it.
    //
    // A genuinely NEW link cannot appear in `before`, so declining to exempt intended ids
    // here costs a correct connect nothing: the only way an intended id is already present
    // is that it was reused, and then the previous occupant really is gone.
    // The replaced wire is exempt because connect DROPS it. If it did not drop — the id
    // survives with new endpoints — then it was REUSED, and exempting it unconditionally
    // hid an endpoint reassignment onto an untargeted node (gate P1). Exempt it only
    // where it actually landed on the slot this connect addressed.
    const survivor = after.links.get(id);
    if (id === replacedId) {
      if (!survivor) continue;
      const landedOn = `${survivor.target_id}#${survivor.target_slot}`;
      if (intendedSlots === undefined || intendedSlots.has(landedOn)) continue;
    }
    const now = after.links.get(id);
    if (now && !sameEndpoints(was, now)) collateralMovedLinks.push({ before: was, after: now });
  }

  // #2380 — the node-side comparison. Only meaningful when the caller captured slots
  // alongside the store; an older call site that did not passes `beforeSlots` undefined
  // and this contributes nothing rather than inventing a finding.
  const collateralReslottedInputs = [];
  if (beforeSlots instanceof Map) {
    const afterSlots = snapshotInputSlotLinks(graph);
    // Every slot named by EITHER snapshot, so the three transitions are covered:
    // link->link (a reslot), link->null (an input emptied) and null->link (an input
    // filled). Iterating only `beforeSlots` and skipping an absent `now` missed the
    // last two entirely — a fifth gate P1, and a hole in code this same change added.
    const slotKeys = new Set([...beforeSlots.keys(), ...afterSlots.keys()]);
    for (const slot of slotKeys) {
      const wasLink = beforeSlots.get(slot) ?? null;
      const nowLink = afterSlots.get(slot) ?? null;
      // Strict, so a retype (7 -> "7") reads as the change it is. Nothing legitimately
      // retypes an untargeted slot across a single connect, so this cannot false-positive
      // on a bystander the connect never touched.
      if (nowLink === wasLink) continue;
      // The link this connect made (or the one it displaced) landing on a slot is the
      // expected outcome, not bystander damage.
            // Location-aware, not id-only (gate P1). Exempting an intended id wherever it
        // appeared meant a hook could assign that id to an UNTARGETED node's input and
        // the verdict stayed ok:true — hiding the very rewiring this exists to catch.
        // The exemption now applies only on the slot the connect actually addressed;
        // an intended id landing anywhere else is collateral.
        const isAddressedSlot = intendedSlots === undefined || intendedSlots.has(slot);
        if (
          nowLink !== null &&
          isAddressedSlot &&
          (intended.has(String(nowLink)) || String(nowLink) === replacedId)
        ) {
          continue;
        }
      if (wasLink !== null && String(wasLink) === replacedId) continue;
      collateralReslottedInputs.push({ slot, before: wasLink, after: nowLink });
    }
  }

  const ok =
    collateralReslottedInputs.length === 0 &&
    missingNodes.length === 0 &&
    addedNodes.length === 0 &&
    collateralRemovedLinks.length === 0 &&
    collateralAddedLinks.length === 0 &&
    collateralMovedLinks.length === 0;
  return {
    ok,
    missingNodes,
    addedNodes,
    collateralRemovedLinks,
    collateralAddedLinks,
    collateralMovedLinks,
    collateralReslottedInputs,
  };
}

/**
 * Disclosure bullets for a not-ok verifyConnect verdict. Observed post-state facts
 * only, phrased the way the #668 disconnect bullets are so the two read alike.
 */
export function connectCollateralBullets(verdict) {
  const lines = [];
  if (verdict.missingNodes.length) {
    lines.push(
      `- node(s) ${verdict.missingNodes.join(", ")} were REMOVED from the graph during this connect`,
    );
  }
  if (verdict.addedNodes.length) {
    lines.push(`- node(s) ${verdict.addedNodes.join(", ")} APPEARED that were not there before`);
  }
  for (const l of verdict.collateralRemovedLinks) {
    lines.push(
      `- a link this connect did not target was REMOVED: node ${l.origin_id} output ${l.origin_slot} ` +
        `-> node ${l.target_id} input ${l.target_slot}`,
    );
  }
  for (const r of verdict.collateralReslottedInputs ?? []) {
    lines.push(
      `- an input this connect did not target now names a DIFFERENT link: ${r.slot} ` +
        `was link ${r.before}, is now link ${r.after} (the link records may be unchanged; ` +
        `execution follows the slot)`,
    );
  }
  for (const m of verdict.collateralMovedLinks ?? []) {
    // Reported as a MOVE rather than a remove+add pair: the id is the same record, and
    // saying "removed" of a link that is still there would send the reader looking for a
    // wire that exists (#2380).
    lines.push(
      `- a link this connect did not target was MOVED: node ${m.before.origin_id} output ` +
        `${m.before.origin_slot} -> node ${m.before.target_id} input ${m.before.target_slot} ` +
        `is now node ${m.after.origin_id} output ${m.after.origin_slot} -> node ` +
        `${m.after.target_id} input ${m.after.target_slot}`,
    );
  }
  for (const l of verdict.collateralAddedLinks) {
    lines.push(
      `- a link APPEARED that this connect did not create: node ${l.origin_id} output ${l.origin_slot} ` +
        `-> node ${l.target_id} input ${l.target_slot}`,
    );
  }
  return lines;
}

/** Warning sentence carrying the bullets. The wire the caller asked for DID land, so
 *  this must not read as a failed connect. */
export function connectCollateralWarning(bullets) {
  return (
    `this connect landed, but the live graph shows changes it did not ask for (#2380):` +
    `\n${bullets.join("\n")}\n` +
    `These are observed facts about the post-state, not a diagnosis: a node pack is free to ` +
    `re-wire its own slots from inside onConnectionsChange, and the panel cannot stop it. Do NOT ` +
    `restore anything from a stale picture: re-read with panel_graph_outline first, because ` +
    `correcting from a pre-connect mental model is itself a mutation. Ctrl+Z in the ComfyUI tab ` +
    `reverts this connect if you would rather start over.`
  );
}
