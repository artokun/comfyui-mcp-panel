/**
 * comfyui-mcp#1665 — `panel_unpack_subgraph` silently DROPPED external links whose
 * parent-graph targets were widget-converted inputs (`length`) or dynamic/optional
 * inputs (`values.a`, `ref_audios.ref_audio_0`), and left them HALF-BROKEN: the
 * target slot came back `connected_from: null` while the source output still
 * reported `links: 1` (a one-sided ghost that even serialized to disk). The tool
 * returned a plain success payload, so nothing told the caller the graph it just
 * mutated would render wrong.
 *
 * WHY IT HAPPENS: litegraph's `unpackSubgraph` rewires the rails' external links by
 * slot INDEX. Slot indices shift during the unpack (the measured report: node 136
 * gained a new dynamic `ref_audio_1` slot), and widget-backed / dynamic inputs are
 * re-slotted or skipped entirely — the link is never re-created on the target, but
 * the id lingers on the source output's link list.
 *
 * WHAT THIS MODULE DOES: snapshots the subgraph node's EXTERNAL link set BEFORE the
 * unpack (endpoints resolved to slot NAMES, not indices, because indices shift), and
 * after the unpack re-resolves every expected link against the LIVE link table. A
 * link counts as restored only when the stored link AND the target input's
 * back-reference agree (the ghost above fails exactly that check — same test as
 * connect-verify's isLinkPersisted). What cannot be proven present is reported as
 * dropped so the caller can refuse loudly instead of reporting a corrupt success.
 *
 * Pure (no DOM / no ComfyUI globals — graph + nodes are passed in) so the SAME check
 * runs under unit test and in production. Fully defensive; never throws — an
 * unreadable piece lands in `unverifiable` rather than breaking the unpack report.
 */

/** All stored link objects on `graph` — `graph.links` is a Map in current LiteGraph
 *  builds and a plain object/array in older ones; both are read here. */
function storedLinks(graph) {
  const links = graph?.links;
  if (!links) return [];
  try {
    if (typeof links.values === "function") return Array.from(links.values());
    return Object.values(links);
  } catch {
    return [];
  }
}

/** One stored link by id (Map `.get` or key/index access). */
function readLink(graph, id) {
  const links = graph?.links;
  if (links == null || id == null) return null;
  try {
    return typeof links.get === "function" ? (links.get(id) ?? null) : (links[id] ?? null);
  } catch {
    return null;
  }
}

/** LLink field access — object form (`origin_id`) or array form (`[1]`). */
const linkId = (l) => l?.id ?? l?.[0];
const linkOriginId = (l) => l?.origin_id ?? l?.[1];
const linkOriginSlot = (l) => l?.origin_slot ?? l?.[2];
const linkTargetId = (l) => l?.target_id ?? l?.[3];
const linkTargetSlot = (l) => l?.target_slot ?? l?.[4];

function getNode(graph, id) {
  try {
    return id != null && typeof graph?.getNodeById === "function" ? graph.getNodeById(id) : null;
  } catch {
    return null;
  }
}

/** Case-insensitive slot-index lookup by name (mirrors the panel's resolveSlot). */
function slotIndexByName(slots, name) {
  if (typeof name !== "string" || !Array.isArray(slots)) return -1;
  const lower = name.toLowerCase();
  return slots.findIndex((s) => s?.name?.toLowerCase() === lower);
}

/**
 * Count LIVE links out of (`nodeId`, `outIdx`) — live means the stored link exists
 * AND its target input back-references the same link id. The one-sided ghost of
 * #1665 (stored + on the origin's list, but the target input is `link: null`) is
 * NOT live, which is exactly what makes it detectable here.
 */
function liveLinkCountFrom(graph, nodeId, outIdx) {
  let count = 0;
  for (const stored of storedLinks(graph)) {
    if (stored == null) continue;
    if (String(linkOriginId(stored)) !== String(nodeId)) continue;
    if (Number(linkOriginSlot(stored)) !== Number(outIdx)) continue;
    const target = getNode(graph, linkTargetId(stored));
    if (target?.inputs?.[linkTargetSlot(stored)]?.link === linkId(stored)) count += 1;
  }
  return count;
}

/**
 * Snapshot every external link touching `subgraphNode` (the wrapper in the PARENT
 * graph), endpoints named by slot NAME so the post-unpack check is immune to the
 * slot-index shifting that causes #1665.
 *
 * Returns `{ links, unverifiable }`:
 *  - `links` entries are `{ kind: "in", rail, source: {node_id, slot, name}, consumers, baseline }`
 *    (external SOURCE → subgraph input rail) or `{ kind: "out", rail, target: {node_id, slot, name} }`
 *    (subgraph output rail → external TARGET).
 *  - `unverifiable` entries are links whose endpoints could not even be READ — a
 *    pre-existing dangling/corrupt link the unpack did not cause. They are disclosed
 *    but must not force a refusal (the loss, if any, predates this call).
 */
export function snapshotExternalLinks(graph, subgraphNode) {
  const links = [];
  const unverifiable = [];
  if (!graph || !subgraphNode) return { links, unverifiable };
  try {
    const inputs = Array.isArray(subgraphNode.inputs) ? subgraphNode.inputs : [];
    for (let i = 0; i < inputs.length; i++) {
      const slot = inputs[i];
      if (slot?.link == null) continue;
      const rail = typeof slot?.name === "string" ? slot.name : `slot ${i}`;
      const stored = readLink(graph, slot.link);
      const originId = stored ? linkOriginId(stored) : null;
      const originSlot = stored ? linkOriginSlot(stored) : null;
      const origin = getNode(graph, originId);
      if (originId == null || originSlot == null || !origin) {
        unverifiable.push({ rail, reason: "the link into this rail could not be resolved before the unpack" });
        continue;
      }
      const name = origin.outputs?.[originSlot]?.name ?? null;
      // One rail link can FAN OUT to several interior consumers; the unpack should
      // recreate one live link per consumer in place of the single rail link, so the
      // post-check compares counts, not mere existence.
      let consumers = 1;
      const railSlot = subgraphNode.subgraph?.inputs?.[i];
      if (railSlot && Array.isArray(railSlot.linkIds)) consumers = railSlot.linkIds.length;
      links.push({
        kind: "in",
        rail,
        source: { node_id: originId, slot: originSlot, name },
        consumers,
        baseline: liveLinkCountFrom(graph, originId, originSlot),
      });
    }
    const outputs = Array.isArray(subgraphNode.outputs) ? subgraphNode.outputs : [];
    for (let i = 0; i < outputs.length; i++) {
      const slot = outputs[i];
      const rail = typeof slot?.name === "string" ? slot.name : `slot ${i}`;
      const linkIds = Array.isArray(slot?.links) ? slot.links : [];
      for (const id of linkIds) {
        const stored = readLink(graph, id);
        const targetId = stored ? linkTargetId(stored) : null;
        const targetSlot = stored ? linkTargetSlot(stored) : null;
        const target = getNode(graph, targetId);
        const name = target?.inputs?.[targetSlot]?.name ?? null;
        if (targetId == null || targetSlot == null || !target || name == null) {
          unverifiable.push({
            rail,
            reason: "the external target of this rail could not be named before the unpack",
          });
          continue;
        }
        links.push({ kind: "out", rail, target: { node_id: targetId, slot: targetSlot, name } });
      }
    }
  } catch {
    // A poisoned accessor on the wrapper must not break the unpack path; whatever was
    // gathered so far is still checked, and the gap is disclosed.
    unverifiable.push({ rail: "(unknown)", reason: "reading the subgraph's external links threw" });
  }
  return { links, unverifiable };
}

/** Human-readable one-liner for a dropped expected link (names, not indices). */
function describeExpected(e) {
  const srcName = e.source?.name ?? `slot ${e.source?.slot}`;
  const tgtName = e.target?.name ?? `slot ${e.target?.slot}`;
  return e.kind === "in"
    ? `${e.source?.node_id}.${srcName} → subgraph input "${e.rail}" (fed ${e.consumers} interior node(s))`
    : `subgraph output "${e.rail}" → ${e.target?.node_id}.${tgtName}`;
}

/**
 * Re-resolve every expected link from `snapshotExternalLinks` against the LIVE graph
 * after the unpack. Returns `{ restored, dropped, unverifiable }` — `dropped` holds
 * a named description per link that cannot be PROVEN present. Fail-closed per link:
 * a target whose slot name no longer resolves (dynamic re-slotting) counts as
 * dropped, because reporting it restored would be the silent corruption this exists
 * to stop.
 */
export function verifyExternalLinks(graph, snapshot) {
  const dropped = [];
  const unverifiable = [...(snapshot?.unverifiable ?? [])].map(
    (u) => `rail "${u.rail}": ${u.reason}`,
  );
  let restored = 0;
  for (const e of snapshot?.links ?? []) {
    let ok = false;
    try {
      ok = e.kind === "in" ? inboundRestored(graph, e) : outboundRestored(graph, e);
    } catch {
      ok = false;
    }
    if (ok) restored += 1;
    else dropped.push(describeExpected(e));
  }
  return { restored, dropped, unverifiable };
}

/** External SOURCE → rail → interior consumer(s): the unpack should leave
 *  `baseline - 1 + consumers` live links from the source slot (the rail link itself
 *  is gone, one new live link per interior consumer). */
function inboundRestored(graph, e) {
  const origin = getNode(graph, e.source?.node_id);
  if (!origin) return false;
  let outIdx = slotIndexByName(origin.outputs, e.source?.name);
  if (outIdx === -1) outIdx = e.source?.slot;
  if (outIdx == null) return false;
  const expected = Math.max(0, (e.baseline ?? 1) - 1) + (e.consumers ?? 1);
  return liveLinkCountFrom(graph, e.source.node_id, outIdx) >= expected;
}

/** Rail → external TARGET: the target node survives the unpack, so the check is
 *  name-based on its CURRENT inputs (indices may have shifted — that is the bug).
 *  The input must reference a stored link that agrees it targets this node/slot. */
function outboundRestored(graph, e) {
  const target = getNode(graph, e.target?.node_id);
  if (!target) return false;
  const inIdx = slotIndexByName(target.inputs, e.target?.name);
  if (inIdx === -1) return false; // name gone — cannot prove survival, fail closed
  const id = target.inputs?.[inIdx]?.link;
  if (id == null) return false;
  const stored = readLink(graph, id);
  if (!stored) return false;
  return (
    String(linkTargetId(stored)) === String(e.target.node_id) &&
    Number(linkTargetSlot(stored)) === Number(inIdx)
  );
}
