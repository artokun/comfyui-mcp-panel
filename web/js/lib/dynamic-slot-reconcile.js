/**
 * #2008 — a connect into a COMFY_AUTOGROW_V3 family can re-address later slots.
 *
 * MiniMaxH3ReferenceToVideo (and any Autogrow.TemplatePrefix node) exposes
 * children as dotted names: `ref_images.ref_image_4`. Connecting to one of
 * those names runs the family's onConnectionsChange, which inserts a new
 * sibling and shifts every later input — `ref_videos`, `ref_audios`, prompt,
 * width, height, length — to a new index. LiteGraph may also rewrite
 * `target_slot` on the surviving links, or a rebuild may copy links BY
 * POSITION onto the new array and land them on the wrong names.
 *
 * Logical identity for these slots is the NAME, not the index. The caller
 * addressed `ref_images.ref_image_4`; prompt is still prompt. This module
 * snapshots name→link before the connect, re-reads after, then:
 *
 *   - keeps the intended dotted-prefix slot's new link
 *   - restores every other surviving name's original link
 *   - retargets the stored link's `target_slot` to the live index
 *
 * It does NOT run for positional packs (ImpactSwitch `input1` / Easy-Use
 * `image0`). Those rename FROM POSITION on purpose; putting an old name back
 * would break the `select`/`index` contract (#1873). The gate is a dotted
 * name on the addressed slot (`family.child`).
 *
 * Never throws. A failed restore is left for the existing slots_rewritten /
 * collateral_changes riders; this must never turn a landed wire into a
 * reported failure (#1272).
 */

/** True for Autogrow-style children (`ref_images.ref_image_4`). */
export function isDynamicPrefixSlotName(name) {
  return typeof name === "string" && name.includes(".");
}

/** Family prefix (`ref_images` from `ref_images.ref_image_4`). */
export function dynamicPrefixFamily(name) {
  if (!isDynamicPrefixSlotName(name)) return null;
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : null;
}

function slotName(slot) {
  try {
    return typeof slot?.name === "string" ? slot.name : null;
  } catch {
    return null;
  }
}

function readLink(graph, linkId) {
  if (linkId == null || !graph) return null;
  try {
    const links = graph.links;
    if (links) {
      const stored = typeof links.get === "function" ? links.get(linkId) : links[linkId];
      if (stored != null) return stored;
    }
    if (typeof graph.getLink === "function") return graph.getLink(linkId) ?? null;
    const map = graph._links;
    if (map && typeof map.get === "function") return map.get(linkId) ?? null;
  } catch {
    /* unreadable store is "no link" */
  }
  return null;
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

/**
 * Live input index of `name` on `node`, or -1. First match; duplicate names
 * are unpairable and the caller must treat that as "cannot reconcile".
 */
export function findSlotIndexByName(node, name) {
  if (typeof name !== "string" || !name) return -1;
  try {
    const inputs = node?.inputs;
    if (!Array.isArray(inputs)) return -1;
    for (let i = 0; i < inputs.length; i++) {
      if (slotName(inputs[i]) === name) return i;
    }
  } catch {
    return -1;
  }
  return -1;
}

/**
 * Snapshot one node's inputs as `{ name, index, link }` rows, BEFORE a connect.
 *
 * Duplicate names make pairing a guess — those snapshots are marked
 * `pairable: false` and reconcile becomes a no-op. Never throws.
 */
export function captureNamedSlotLinks(node) {
  const slots = [];
  const seen = new Set();
  let pairable = true;
  try {
    if (!node || typeof node !== "object" || !Array.isArray(node.inputs)) {
      return { node, slots, pairable: false };
    }
    for (let i = 0; i < node.inputs.length; i++) {
      const slot = node.inputs[i];
      let name = null;
      let link = null;
      try {
        name = slotName(slot);
        link = slot?.link ?? null;
      } catch {
        name = null;
        link = null;
      }
      if (name && seen.has(name)) pairable = false;
      if (name) seen.add(name);
      slots.push({ name, index: i, link });
    }
  } catch {
    return { node, slots: [], pairable: false };
  }
  return { node, slots, pairable };
}

function sameLink(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a === b;
}

function familyOf(name) {
  return dynamicPrefixFamily(name);
}

/**
 * Re-seat links on `node` so each surviving NAME keeps the wire it had before
 * the connect, except the intended dotted-prefix slot which keeps the new one.
 *
 * @returns {{ intendedName: string|null, intendedIndex: number, restored: number } | null}
 *   null when this connect is not a dotted-prefix address, or the snapshot
 *   cannot be paired honestly. `restored` is the number of names whose live
 *   link was written back.
 */
export function reconcileDynamicPrefixSlots({
  graph,
  node,
  before,
  intendedName,
  intendedLinkId,
  replacedLinkId,
} = {}) {
  try {
    if (!isDynamicPrefixSlotName(intendedName)) return null;
    if (!node || typeof node !== "object" || !Array.isArray(node.inputs)) return null;
    if (!before?.pairable || before.node !== node) return null;

    const liveByName = new Map();
    for (let i = 0; i < node.inputs.length; i++) {
      const name = slotName(node.inputs[i]);
      if (!name) continue;
      if (liveByName.has(name)) return null; // live duplicates — cannot pair
      liveByName.set(name, i);
    }

    let intendedIndex = liveByName.has(intendedName) ? liveByName.get(intendedName) : -1;
    if (intendedIndex < 0 && intendedLinkId != null) {
      const family = familyOf(intendedName);
      for (let i = 0; i < node.inputs.length; i++) {
        const name = slotName(node.inputs[i]);
        if (!name || familyOf(name) !== family) continue;
        if (node.inputs[i]?.link === intendedLinkId) {
          intendedIndex = i;
          intendedName = name;
          break;
        }
      }
    }

    if (intendedLinkId != null && intendedIndex >= 0) {
      const holder = node.inputs[intendedIndex];
      if (holder && holder.link !== intendedLinkId) {
        for (let i = 0; i < node.inputs.length; i++) {
          if (i === intendedIndex) continue;
          try {
            if (node.inputs[i]?.link === intendedLinkId) node.inputs[i].link = null;
          } catch {
            /* skip a hostile slot */
          }
        }
        holder.link = intendedLinkId;
        writeTargetSlot(readLink(graph, intendedLinkId), node.id, intendedIndex);
      } else if (holder?.link === intendedLinkId) {
        writeTargetSlot(readLink(graph, intendedLinkId), node.id, intendedIndex);
      }
    }

    let restored = 0;
    for (const row of before.slots) {
      if (!row?.name) continue;
      if (row.name === intendedName) continue;
      if (row.link != null && row.link === replacedLinkId) continue;
      const liveIndex = liveByName.get(row.name);
      if (liveIndex == null) continue;
      if (liveIndex === intendedIndex) continue;
      const live = node.inputs[liveIndex];
      if (!live) continue;
      let current;
      try {
        current = live.link ?? null;
      } catch {
        continue;
      }
      if (sameLink(current, row.link)) {
        if (row.link != null) writeTargetSlot(readLink(graph, row.link), node.id, liveIndex);
        continue;
      }
      if (row.link != null) {
        for (let i = 0; i < node.inputs.length; i++) {
          if (i === liveIndex || i === intendedIndex) continue;
          try {
            if (node.inputs[i]?.link === row.link) node.inputs[i].link = null;
          } catch {
            /* skip */
          }
        }
      }
      live.link = row.link;
      if (row.link != null) writeTargetSlot(readLink(graph, row.link), node.id, liveIndex);
      restored++;
    }

    return {
      intendedName: typeof intendedName === "string" ? intendedName : null,
      intendedIndex,
      restored,
    };
  } catch {
    return null;
  }
}
