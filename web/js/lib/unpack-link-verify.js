/**
 * comfyui-mcp#1665 — `panel_unpack_subgraph` silently DROPPED external links whose
 * parent-graph targets were widget-converted inputs (`length`) or dynamic/optional
 * inputs (`values.a`, `ref_audios.ref_audio_0`), and left them HALF-BROKEN: the
 * target slot came back `connected_from: null` while the source output still
 * reported `links: 1` (a one-sided ghost that even serialized to disk). The tool
 * returned a plain success payload, so nothing told the caller the graph it just
 * mutated would render wrong.
 *
 * comfyui-mcp#2887 — the #1665 check only COUNTED surviving live wires from the
 * external source. litegraph still rewires by slot INDEX, and after MiniMax-style
 * autogrow rebuilds (`ref_images.ref_image_0`, `ref_videos.ref_video_0`) that
 * index no longer names the same child. An IMAGE feed can land on `ref_videos`
 * while the count still matches — a silent scramble, not a drop. This module now
 * snapshots interior consumers/producers by NAME + TYPE (the dynamic namespace
 * and child), reseats a misplaced live wire onto that unique identity, and treats
 * a non-unique or type-mismatched landing as dropped so the unpack rolls back.
 *
 * WHY IT HAPPENS: litegraph's `unpackSubgraph` rewires the rails' external links by
 * slot INDEX. Slot indices shift during the unpack (the measured report: node 136
 * gained a new dynamic `ref_audio_1` slot), and widget-backed / dynamic inputs are
 * re-slotted or skipped entirely — the link is never re-created on the target, but
 * the id lingers on the source output's link list. When the link IS recreated, it
 * may be attached to whichever slot currently occupies that index.
 *
 * WHAT THIS MODULE DOES: snapshots the subgraph node's EXTERNAL link set BEFORE the
 * unpack (endpoints resolved to slot NAMES, not indices, because indices shift), and
 * after the unpack re-resolves every expected link against the LIVE link table. A
 * link counts as restored only when the stored link AND the target input's
 * back-reference agree (the ghost above fails exactly that check — same test as
 * connect-verify's isLinkPersisted) AND, when the interior identity was readable,
 * the wire sits on that named slot with a compatible type. What cannot be proven
 * present (or uniquely identified) is reported as dropped so the caller can refuse
 * loudly instead of reporting a corrupt success.
 *
 * Pure (no DOM / no ComfyUI globals — graph + nodes are passed in) so the SAME check
 * runs under unit test and in production. Fully defensive; never throws — an
 * unreadable piece lands in `unverifiable` rather than breaking the unpack report.
 * A readable-but-ambiguous interior identity is DROPPED, not unverifiable: guessing
 * the child would be the scramble this exists to stop.
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
 * Slot index of `name` only when that name is UNIQUE on `slots`. Duplicates are
 * unpairable — returning the first hit would reseat onto a coin-flip child.
 */
function uniqueSlotIndexByName(slots, name) {
  if (typeof name !== "string" || !Array.isArray(slots)) return -1;
  const lower = name.toLowerCase();
  let found = -1;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]?.name?.toLowerCase() !== lower) continue;
    if (found !== -1) return -1;
    found = i;
  }
  return found;
}

function slotTypeOf(slot, fallback) {
  const t = slot?.type ?? fallback;
  if (typeof t === "string") return t;
  if (t == null) return null;
  return String(t);
}

/** Compatible when either side is missing/wildcard, equal, or shares a union member. */
function typesCompatible(a, b) {
  if (a == null || b == null) return true;
  const left = String(a).toUpperCase();
  const right = String(b).toUpperCase();
  if (left === right) return true;
  if (left === "*" || right === "*" || left === "0" || right === "0") return true;
  const as = left.split(",").map((s) => s.trim()).filter(Boolean);
  const bs = right.split(",").map((s) => s.trim()).filter(Boolean);
  return as.some((x) => bs.includes(x));
}

function writeTargetSlot(stored, nodeId, index) {
  if (!stored || typeof stored !== "object") return;
  try {
    if (Array.isArray(stored)) {
      stored[3] = nodeId;
      stored[4] = index;
      return;
    }
    stored.target_id = nodeId;
    stored.target_slot = index;
  } catch {
    /* best-effort retarget */
  }
}

function interiorLinkStoreKind(subgraph) {
  if (!subgraph || typeof subgraph !== "object") return null;
  try {
    if (typeof subgraph.getLink === "function") return "getLink";
  } catch {
    /* fall through */
  }
  try {
    if (subgraph._links) return "_links";
  } catch {
    /* fall through */
  }
  try {
    if (subgraph.links) return "links";
  } catch {
    /* fall through */
  }
  return null;
}

function readInteriorLink(subgraph, id) {
  if (!subgraph || id == null) return null;
  try {
    if (typeof subgraph.getLink === "function") {
      const stored = subgraph.getLink(id);
      if (stored != null) return stored;
    }
  } catch {
    /* try maps */
  }
  try {
    for (const links of [subgraph._links, subgraph.links]) {
      if (!links) continue;
      const stored = typeof links.get === "function" ? links.get(id) : links[id];
      if (stored != null) return stored;
    }
  } catch {
    return null;
  }
  return null;
}

function getSubgraphNode(subgraph, id) {
  try {
    if (id != null && typeof subgraph?.getNodeById === "function") {
      const node = subgraph.getNodeById(id);
      if (node) return node;
    }
  } catch {
    /* fall through */
  }
  try {
    const nodes = subgraph?._nodes ?? subgraph?.nodes;
    if (Array.isArray(nodes)) {
      return nodes.find((n) => String(n.id) === String(id)) ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function namedEndpoint(node, slots, slotIndex, fallbackType) {
  const slot = slots?.[slotIndex];
  const name = typeof slot?.name === "string" ? slot.name : null;
  if (!node || name == null) return null;
  return { node_id: node.id, name, type: slotTypeOf(slot, fallbackType) };
}

/**
 * Count LIVE links out of (`nodeId`, `outIdx`) — live means the stored link exists
 * AND its target input back-references the same link id. The one-sided ghost of
 * #1665 (stored + on the origin's list, but the target input is `link: null`) is
 * NOT live, which is exactly what makes it detectable here.
 */
function liveLinksFrom(graph, nodeId, outIdx) {
  const live = [];
  for (const stored of storedLinks(graph)) {
    if (stored == null) continue;
    if (String(linkOriginId(stored)) !== String(nodeId)) continue;
    if (Number(linkOriginSlot(stored)) !== Number(outIdx)) continue;
    const target = getNode(graph, linkTargetId(stored));
    if (target?.inputs?.[linkTargetSlot(stored)]?.link === linkId(stored)) live.push(stored);
  }
  return live;
}

function liveLinkCountFrom(graph, nodeId, outIdx) {
  return liveLinksFrom(graph, nodeId, outIdx).length;
}

/**
 * Interior consumers of a host input rail, named by the child slot (including a
 * dotted autogrow path). Only runs when the subgraph actually exposes a link
 * store — fixtures/frontends without one keep the count-only #1665 path.
 *
 * `unresolved` is true when the store exists but a consumer cannot be named
 * uniquely (missing record, unnamed slot). That is a refusal, not unverifiable.
 */
function snapshotInteriorConsumers(subgraphNode, railIndex) {
  const subgraph = subgraphNode?.subgraph;
  const railSlot = subgraph?.inputs?.[railIndex];
  const ids = Array.isArray(railSlot?.linkIds) ? railSlot.linkIds : [];
  const consumers = [];
  if (!ids.length || !interiorLinkStoreKind(subgraph)) {
    return { consumers, unresolved: false };
  }
  let unresolved = false;
  const seen = new Map();
  for (const lid of ids) {
    const stored = readInteriorLink(subgraph, lid);
    const targetId = stored ? linkTargetId(stored) : null;
    const targetSlot = stored ? linkTargetSlot(stored) : null;
    const target = getSubgraphNode(subgraph, targetId);
    const endpoint = namedEndpoint(target, target?.inputs, targetSlot, railSlot?.type);
    if (!endpoint) {
      unresolved = true;
      continue;
    }
    const key = `${String(endpoint.node_id)}\0${endpoint.name.toLowerCase()}`;
    if (seen.has(key)) {
      unresolved = true;
      continue;
    }
    seen.set(key, true);
    consumers.push(endpoint);
  }
  return { consumers, unresolved };
}

function snapshotInteriorProducer(subgraphNode, railIndex) {
  const subgraph = subgraphNode?.subgraph;
  const railSlot = subgraph?.outputs?.[railIndex];
  const ids = Array.isArray(railSlot?.linkIds) ? railSlot.linkIds : [];
  if (!ids.length || !interiorLinkStoreKind(subgraph)) {
    return { producer: null, unresolved: false };
  }
  let producer = null;
  for (const lid of ids) {
    const stored = readInteriorLink(subgraph, lid);
    const originId = stored ? linkOriginId(stored) : null;
    const originSlot = stored ? linkOriginSlot(stored) : null;
    const origin = getSubgraphNode(subgraph, originId);
    const endpoint = namedEndpoint(origin, origin?.outputs, originSlot, railSlot?.type);
    if (!endpoint) return { producer: null, unresolved: true };
    if (producer && (String(producer.node_id) !== String(endpoint.node_id) || producer.name.toLowerCase() !== endpoint.name.toLowerCase())) {
      return { producer: null, unresolved: true };
    }
    producer = endpoint;
  }
  return { producer, unresolved: false };
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
      const interior = snapshotInteriorConsumers(subgraphNode, i);
      links.push({
        kind: "in",
        rail,
        rail_type: slotTypeOf(slot, railSlot?.type),
        source: {
          node_id: originId,
          slot: originSlot,
          name,
          type: slotTypeOf(origin.outputs?.[originSlot]),
        },
        consumers,
        interior: interior.consumers,
        identity_unresolved: interior.unresolved,
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
        const producerSnap = snapshotInteriorProducer(subgraphNode, i);
        links.push({
          kind: "out",
          rail,
          target: {
            node_id: targetId,
            slot: targetSlot,
            name,
            type: slotTypeOf(target.inputs?.[targetSlot]),
          },
          producer: producerSnap.producer,
          identity_unresolved: producerSnap.unresolved,
        });
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
  if (e.kind === "in") {
    const interior = Array.isArray(e.interior) ? e.interior : [];
    if (interior.length) {
      const dest = interior.map((c) => `${c.node_id}.${c.name}`).join(", ");
      return `${e.source?.node_id}.${srcName} → ${dest} (via subgraph input "${e.rail}")`;
    }
    return `${e.source?.node_id}.${srcName} → subgraph input "${e.rail}" (fed ${e.consumers} interior node(s))`;
  }
  if (e.producer?.name) {
    return `${e.producer.node_id}.${e.producer.name} → ${e.target?.node_id}.${tgtName} (via subgraph output "${e.rail}")`;
  }
  return `subgraph output "${e.rail}" → ${e.target?.node_id}.${tgtName}`;
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

function originOutIndex(graph, e) {
  const origin = getNode(graph, e.source?.node_id);
  if (!origin) return null;
  let outIdx = slotIndexByName(origin.outputs, e.source?.name);
  if (outIdx === -1) outIdx = e.source?.slot;
  return outIdx == null ? null : outIdx;
}

function inboundConsumerRestored(graph, e, consumer, outIdx) {
  const target = getNode(graph, consumer.node_id);
  if (!target) return false;
  const inIdx = uniqueSlotIndexByName(target.inputs, consumer.name);
  if (inIdx === -1) return false;
  const slot = target.inputs[inIdx];
  if (!typesCompatible(slot?.type, consumer.type ?? e.rail_type ?? e.source?.type)) return false;
  const id = slot?.link;
  if (id == null) return false;
  const stored = readLink(graph, id);
  if (!stored) return false;
  return (
    String(linkOriginId(stored)) === String(e.source.node_id) &&
    Number(linkOriginSlot(stored)) === Number(outIdx) &&
    String(linkTargetId(stored)) === String(consumer.node_id) &&
    Number(linkTargetSlot(stored)) === Number(inIdx) &&
    slot.link === linkId(stored)
  );
}

function inboundHasScrambledSibling(graph, e, outIdx) {
  const expected = new Map();
  for (const consumer of e.interior ?? []) {
    const key = String(consumer.node_id);
    if (!expected.has(key)) expected.set(key, new Set());
    expected.get(key).add(String(consumer.name).toLowerCase());
  }
  for (const stored of liveLinksFrom(graph, e.source.node_id, outIdx)) {
    const tid = String(linkTargetId(stored));
    if (!expected.has(tid)) continue;
    const target = getNode(graph, linkTargetId(stored));
    const name = target?.inputs?.[linkTargetSlot(stored)]?.name;
    if (typeof name !== "string" || !expected.get(tid).has(name.toLowerCase())) return true;
  }
  return false;
}

/** External SOURCE → rail → interior consumer(s): the unpack should leave
 *  `baseline - 1 + consumers` live links from the source slot (the rail link itself
 *  is gone, one new live link per interior consumer). When interior identity was
 *  readable, each named child must hold that wire — a count match on the wrong
 *  dynamic slot is #2887, not a restore. */
function inboundRestored(graph, e) {
  if (e.identity_unresolved) return false;
  const outIdx = originOutIndex(graph, e);
  if (outIdx == null) return false;
  const interior = Array.isArray(e.interior) ? e.interior : [];
  if (interior.length) {
    return (
      interior.every((consumer) => inboundConsumerRestored(graph, e, consumer, outIdx)) &&
      !inboundHasScrambledSibling(graph, e, outIdx)
    );
  }
  const expected = Math.max(0, (e.baseline ?? 1) - 1) + (e.consumers ?? 1);
  return liveLinkCountFrom(graph, e.source.node_id, outIdx) >= expected;
}

/** Rail → external TARGET: the target node survives the unpack, so the check is
 *  name-based on its CURRENT inputs (indices may have shifted — that is the bug).
 *  The input must reference a stored link that agrees it targets this node/slot.
 *  When the interior producer was named, that origin must be the live source. */
function outboundRestored(graph, e) {
  if (e.identity_unresolved) return false;
  const target = getNode(graph, e.target?.node_id);
  if (!target) return false;
  const inIdx = uniqueSlotIndexByName(target.inputs, e.target?.name);
  if (inIdx === -1) return false; // name gone or duplicated — cannot prove survival
  const id = target.inputs?.[inIdx]?.link;
  if (id == null) return false;
  const stored = readLink(graph, id);
  if (!stored) return false;
  if (
    String(linkTargetId(stored)) !== String(e.target.node_id) ||
    Number(linkTargetSlot(stored)) !== Number(inIdx)
  ) {
    return false;
  }
  if (!typesCompatible(target.inputs[inIdx]?.type, e.target?.type)) return false;
  if (!e.producer) return true;
  const origin = getNode(graph, e.producer.node_id);
  if (!origin) return false;
  const outIdx = uniqueSlotIndexByName(origin.outputs, e.producer.name);
  if (outIdx === -1) return false;
  return (
    String(linkOriginId(stored)) === String(e.producer.node_id) &&
    Number(linkOriginSlot(stored)) === Number(outIdx) &&
    typesCompatible(origin.outputs?.[outIdx]?.type, e.producer.type)
  );
}

function clearSlotIfHolds(node, index, id) {
  try {
    const slot = node?.inputs?.[index];
    if (slot && slot.link === id) slot.link = null;
  } catch {
    /* skip a hostile slot */
  }
}

function reseatInbound(graph, e) {
  if (e.identity_unresolved) return 0;
  const interior = Array.isArray(e.interior) ? e.interior : [];
  if (!interior.length) return 0;
  const outIdx = originOutIndex(graph, e);
  if (outIdx == null) return 0;
  const live = liveLinksFrom(graph, e.source.node_id, outIdx);
  const used = new Set();
  let reseated = 0;
  for (const consumer of interior) {
    const target = getNode(graph, consumer.node_id);
    if (!target) continue;
    const inIdx = uniqueSlotIndexByName(target.inputs, consumer.name);
    if (inIdx === -1) continue;
    const dest = target.inputs[inIdx];
    if (!dest || !typesCompatible(dest.type, consumer.type ?? e.rail_type ?? e.source?.type)) continue;
    if (inboundConsumerRestored(graph, e, consumer, outIdx)) {
      const keep = dest.link;
      if (keep != null) used.add(String(keep));
      continue;
    }
    const candidate = live.find((stored) => {
      const id = linkId(stored);
      if (id == null || used.has(String(id))) return false;
      return String(linkTargetId(stored)) === String(consumer.node_id);
    });
    if (!candidate) continue;
    const candidateId = linkId(candidate);
    if (dest.link != null && dest.link !== candidateId) {
      const occupying = readLink(graph, dest.link);
      if (occupying && dest.link === linkId(occupying)) continue;
    }
    const fromIdx = Number(linkTargetSlot(candidate));
    if (fromIdx !== inIdx) clearSlotIfHolds(target, fromIdx, candidateId);
    dest.link = candidateId;
    writeTargetSlot(candidate, consumer.node_id, inIdx);
    used.add(String(candidateId));
    reseated += 1;
  }
  return reseated;
}

function reseatOutbound(graph, e) {
  if (e.identity_unresolved || !e.producer) return 0;
  const target = getNode(graph, e.target?.node_id);
  const origin = getNode(graph, e.producer.node_id);
  if (!target || !origin) return 0;
  const inIdx = uniqueSlotIndexByName(target.inputs, e.target.name);
  const outIdx = uniqueSlotIndexByName(origin.outputs, e.producer.name);
  if (inIdx === -1 || outIdx === -1) return 0;
  const dest = target.inputs[inIdx];
  if (!dest || !typesCompatible(dest.type, e.target.type ?? e.producer.type)) return 0;
  if (outboundRestored(graph, e)) return 0;
  const candidate = liveLinksFrom(graph, e.producer.node_id, outIdx).find(
    (stored) => String(linkTargetId(stored)) === String(e.target.node_id),
  );
  if (!candidate) return 0;
  const candidateId = linkId(candidate);
  if (dest.link != null && dest.link !== candidateId) {
    const occupying = readLink(graph, dest.link);
    if (occupying && dest.link === linkId(occupying)) return 0;
  }
  const fromIdx = Number(linkTargetSlot(candidate));
  if (fromIdx !== inIdx) clearSlotIfHolds(target, fromIdx, candidateId);
  dest.link = candidateId;
  writeTargetSlot(candidate, e.target.node_id, inIdx);
  return 1;
}

/**
 * Move live unpack wires that landed on the wrong index onto the unique named
 * identity snapshotted before the unpack. Never throws. Returns how many
 * endpoints were rewritten; verifyExternalLinks is still the verdict.
 */
export function reseatExternalLinksByIdentity(graph, snapshot) {
  let reseated = 0;
  try {
    for (const e of snapshot?.links ?? []) {
      try {
        reseated += e.kind === "in" ? reseatInbound(graph, e) : reseatOutbound(graph, e);
      } catch {
        /* one bad expected link must not abort the rest */
      }
    }
  } catch {
    return reseated;
  }
  return reseated;
}
