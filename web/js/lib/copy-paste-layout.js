/**
 * Copy/paste layout preservation (#1294).
 *
 * LiteGraph's clipboard only serializes groups that are IN the selection, and
 * `panel_copy_nodes(node_ids)` selects nodes only — so every group vanishes on
 * paste. Separately, some node types (rgthree Power Lora Loader and friends)
 * lose their unique `pos` across clone/configure, so same-type branch rows
 * collapse onto one paste coordinate.
 *
 * These helpers (1) collect groups whose members are fully selected, (2) patch
 * the clipboard payload with live positions + those groups, and (3) after paste
 * apply ONE translation to every landed node and recreate any group the
 * frontend dropped. Dependency-light (group-geometry only) so the algorithms
 * are unit-testable with plain object fixtures.
 */

import {
  groupBoundsOf,
  groupMemberNodes,
  writePoint,
  refreshNodeArea,
} from "./group-geometry.js";

/** A finite [x, y], or null. */
export function finitePoint(v) {
  const x = Number(v?.[0]);
  const y = Number(v?.[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** A finite [x, y, w, h], or null. */
export function finiteBounding(v) {
  const x = Number(v?.[0]);
  const y = Number(v?.[1]);
  const w = Number(v?.[2]);
  const h = Number(v?.[3]);
  return [x, y, w, h].every(Number.isFinite) ? [x, y, w, h] : null;
}

/** LiteGraph node vs group/reroute: nodes carry a string `type` and an id. */
export function isGraphNode(item) {
  return !!(item && item.id != null && typeof item.type === "string");
}

/** Group-shaped canvas item (has a box, is not a typed node). */
export function isGraphGroup(item) {
  if (!item || isGraphNode(item)) return false;
  if (item._bounding && item._bounding.length >= 4) return true;
  if (Array.isArray(item.bounding) && item.bounding.length >= 4) return true;
  return !!(item.pos && item.size && item.title != null);
}

/** Split a selection into nodes and groups. */
export function partitionSelection(items) {
  const nodes = [];
  const groups = [];
  for (const it of items ?? []) {
    if (isGraphNode(it)) nodes.push(it);
    else if (isGraphGroup(it)) groups.push(it);
  }
  return { nodes, groups };
}

/**
 * Groups whose EVERY geometric member is in `selectedIds` (and that have at
 * least one member). A group with a node outside the selection is skipped —
 * pasting it would enclose nodes that were not copied.
 */
export function groupsFullyCoveredBy(graph, selectedIds, memberOf = groupMemberNodes) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const out = [];
  for (const g of graph?._groups ?? []) {
    let members;
    try {
      members = memberOf(graph, g) ?? [];
    } catch {
      continue;
    }
    if (!members.length) continue;
    if (members.every((n) => ids.has(n.id))) out.push(g);
  }
  return out;
}

/** Live node positions/flags — never trust clone()/serialize() for these. */
export function snapshotNodeLayout(node) {
  const pos = finitePoint(node?.pos);
  let collapsed = false;
  try {
    collapsed = !!node?.flags?.collapsed;
  } catch {
    collapsed = false;
  }
  return {
    id: node?.id,
    type: typeof node?.type === "string" ? node.type : null,
    pos,
    ...(collapsed ? { flags: { collapsed: true } } : {}),
  };
}

/** Live group box + identity fields for clipboard inject / recreate. */
export function snapshotGroupLayout(graph, g, boundsOf = groupBoundsOf) {
  let bounding = null;
  try {
    bounding = finiteBounding(boundsOf(g)) ?? finiteBounding(g?._bounding) ??
      finiteBounding(g?.bounding) ??
      finiteBounding([g?.pos?.[0], g?.pos?.[1], g?.size?.[0], g?.size?.[1]]);
  } catch {
    bounding = null;
  }
  let collapsed = false;
  try {
    collapsed = !!g?.flags?.collapsed;
  } catch {
    collapsed = false;
  }
  return {
    id: g?.id,
    title: g?.title ?? "Group",
    color: g?.color,
    font_size: g?.font_size,
    bounding,
    ...(collapsed ? { flags: { collapsed: true } } : {}),
  };
}

/** Title + size: translation-invariant identity for matching copied vs pasted groups. */
export function groupLayoutKey(g) {
  const title = String(g?.title ?? "");
  const b = finiteBounding(g?.bounding) ?? finiteBounding(g?._bounding);
  const w = Math.round(Number(b?.[2]) || 0);
  const h = Math.round(Number(b?.[3]) || 0);
  return `${title}\0${w}x${h}`;
}

function clipboardGroupPayload(g) {
  const bounding = finiteBounding(g.bounding);
  if (!bounding) return null;
  return {
    title: g.title ?? "Group",
    bounding,
    ...(g.color != null ? { color: g.color } : {}),
    ...(Number.isFinite(g.font_size) ? { font_size: g.font_size } : {}),
    ...(g.flags ? { flags: { ...g.flags } } : {}),
    id: -1,
  };
}

/**
 * Nodes + fully-covered groups that a copy should serialize. Always unions
 * groups already in the selection with groups whose members are fully selected.
 */
export function collectCopySelection(graph, selectedItems) {
  const { nodes, groups: selectedGroups } = partitionSelection(selectedItems);
  const selectedIds = new Set(nodes.map((n) => n.id));
  const covered = groupsFullyCoveredBy(graph, selectedIds);
  const seen = new Set(selectedGroups);
  const groups = [...selectedGroups];
  for (const g of covered) {
    if (seen.has(g)) continue;
    seen.add(g);
    groups.push(g);
  }
  return { nodes, groups, items: [...nodes, ...groups] };
}

export function snapshotCopyLayout(graph, selection) {
  return {
    nodes: (selection?.nodes ?? []).map(snapshotNodeLayout),
    groups: (selection?.groups ?? []).map((g) => snapshotGroupLayout(graph, g)),
  };
}

// Live layout recorded at copy time, paired with the same fingerprint
// paste-report uses. Trusted only while the clipboard still holds our payload —
// a native Ctrl+C in between replaces the bytes and invalidates this snapshot.
let _layoutSnapshot = { nodes: [], groups: [] };
let _layoutFingerprint = null;

/** Record the live layout just copied. `fingerprint` is the raw clipboard. */
export function recordCopiedLayout(layout, fingerprint = null) {
  _layoutSnapshot = {
    nodes: [...(layout?.nodes ?? [])],
    groups: [...(layout?.groups ?? [])],
  };
  _layoutFingerprint = fingerprint;
  return _layoutSnapshot;
}

/** Test hook / explicit clear. */
export function clearCopiedLayout() {
  _layoutSnapshot = { nodes: [], groups: [] };
  _layoutFingerprint = null;
}

/**
 * The copy-time layout, but ONLY if `currentFingerprint` proves the clipboard
 * hasn't changed since it was recorded. Otherwise null (caller parses the
 * clipboard itself — native Ctrl+C must win).
 */
export function getVerifiedLayout(currentFingerprint) {
  if (
    _layoutFingerprint != null &&
    currentFingerprint != null &&
    currentFingerprint === _layoutFingerprint
  ) {
    return _layoutSnapshot;
  }
  return null;
}

function parseClipboardObject(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  return data;
}

/**
 * Rewrite a LiteGraph clipboard payload so every node carries its LIVE pos
 * (and collapsed flag) and fully-covered groups are present. Returns the
 * patched JSON string, or the original when the payload is unreadable.
 */
export function patchClipboardLayout(raw, layout) {
  const data = parseClipboardObject(raw);
  if (!data) return raw;
  const payload = Array.isArray(data)
    ? { nodes: data, links: [], groups: [] }
    : { ...data };
  payload.nodes = Array.isArray(payload.nodes) ? payload.nodes.map((n) => ({ ...n })) : [];
  payload.groups = Array.isArray(payload.groups) ? payload.groups.map((g) => ({ ...g })) : [];
  if (payload.links == null) payload.links = [];

  const byId = new Map();
  for (const n of layout?.nodes ?? []) {
    if (n?.id != null) byId.set(n.id, n);
  }
  for (const n of payload.nodes) {
    const live = byId.get(n.id);
    if (!live) continue;
    if (live.pos) n.pos = [live.pos[0], live.pos[1]];
    if (live.flags?.collapsed) {
      n.flags = { ...(n.flags || {}), collapsed: true };
    }
  }

  const existing = new Set(payload.groups.map(groupLayoutKey));
  for (const g of layout?.groups ?? []) {
    const key = groupLayoutKey(g);
    if (existing.has(key)) continue;
    const row = clipboardGroupPayload(g);
    if (!row) continue;
    payload.groups.push(row);
    existing.add(key);
  }
  return JSON.stringify(payload);
}

/** Nodes (with pos) + groups from a clipboard payload. */
export function parseClipboardLayout(raw) {
  const data = parseClipboardObject(raw);
  if (!data) return { nodes: [], groups: [] };
  const nodeList = Array.isArray(data) ? data : Array.isArray(data.nodes) ? data.nodes : [];
  const groupList = Array.isArray(data) ? [] : Array.isArray(data.groups) ? data.groups : [];
  const nodes = [];
  for (const n of nodeList) {
    if (!n || n.id == null || typeof n.type !== "string") continue;
    nodes.push({
      id: n.id,
      type: n.type,
      pos: finitePoint(n.pos),
      ...(n.flags?.collapsed ? { flags: { collapsed: true } } : {}),
    });
  }
  const groups = [];
  for (const g of groupList) {
    const bounding = finiteBounding(g?.bounding) ?? finiteBounding(g?._bounding);
    if (!bounding) continue;
    groups.push({
      id: g.id,
      title: g.title ?? "Group",
      color: g.color,
      font_size: g.font_size,
      bounding,
      ...(g.flags?.collapsed ? { flags: { collapsed: true } } : {}),
    });
  }
  return { nodes, groups };
}

/**
 * Pair clipboard nodes (in order, by type) with freshly pasted nodes.
 * Drops (unregistered types that never landed) are skipped on the clipboard side.
 */
export function pairCopiedToPasted(copied, pasted) {
  const unused = new Map();
  for (const n of pasted ?? []) {
    const t = n?.type;
    if (typeof t !== "string") continue;
    if (!unused.has(t)) unused.set(t, []);
    unused.get(t).push(n);
  }
  const pairs = [];
  for (const c of copied ?? []) {
    if (typeof c?.type !== "string") continue;
    const q = unused.get(c.type);
    if (!q || !q.length) continue;
    pairs.push({ copied: c, pasted: q.shift() });
  }
  return pairs;
}

/** Top-left of the copied layout (nodes + group boxes). */
export function layoutOrigin(nodes, groups) {
  let x = Infinity;
  let y = Infinity;
  for (const n of nodes ?? []) {
    const p = finitePoint(n?.pos);
    if (!p) continue;
    if (p[0] < x) x = p[0];
    if (p[1] < y) y = p[1];
  }
  for (const g of groups ?? []) {
    const b = finiteBounding(g?.bounding);
    if (!b) continue;
    if (b[0] < x) x = b[0];
    if (b[1] < y) y = b[1];
  }
  return Number.isFinite(x) ? [x, y] : [0, 0];
}

/** Caller `pos`, else the top-left of whatever actually landed. */
export function resolvePasteDest(explicitPos, pastedNodes) {
  if (Array.isArray(explicitPos) && explicitPos.length === 2) {
    const p = finitePoint(explicitPos);
    if (p) return p;
  }
  let x = Infinity;
  let y = Infinity;
  for (const n of pastedNodes ?? []) {
    const p = finitePoint(n?.pos);
    if (!p) continue;
    if (p[0] < x) x = p[0];
    if (p[1] < y) y = p[1];
  }
  return Number.isFinite(x) ? [x, y] : null;
}

export function translateBounding(bounding, translation) {
  const b = finiteBounding(bounding);
  if (!b) return null;
  const dx = Number(translation?.[0]) || 0;
  const dy = Number(translation?.[1]) || 0;
  return [b[0] + dx, b[1] + dy, b[2], b[3]];
}

function findMatchingGroup(pastedGroups, copied, used) {
  const key = groupLayoutKey(copied);
  for (const g of pastedGroups ?? []) {
    if (used.has(g)) continue;
    const live = {
      title: g.title,
      bounding: finiteBounding(g._bounding) ?? finiteBounding(g.bounding) ??
        finiteBounding([g.pos?.[0], g.pos?.[1], g.size?.[0], g.size?.[1]]),
    };
    if (groupLayoutKey(live) === key) return g;
  }
  return null;
}

function defaultWriteNodePos(node, x, y, prev) {
  const ok = writePoint(node, "pos", x, y);
  refreshNodeArea(node, prev);
  return ok;
}

function defaultPlaceGroup(group, bounding) {
  const b = finiteBounding(bounding);
  if (!b) return false;
  const box = group._bounding;
  if (box && box.length >= 4) {
    try {
      box[0] = b[0];
      box[1] = b[1];
      box[2] = b[2];
      box[3] = b[3];
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    group.pos = [b[0], b[1]];
    group.size = [b[2], b[3]];
    return true;
  } catch {
    return false;
  }
}

/**
 * After LiteGraph paste: restore each landed node to `copied.pos + translation`
 * and recreate any fully-copied group the frontend dropped. `translation` is
 * dest − origin so every node/group moves by the SAME delta — same-type rows
 * cannot collapse onto one coordinate.
 *
 * `hooks.createGroup(spec)` should add a group to the graph and return it.
 */
export function applyPastedLayout({
  pastedNodes,
  pastedGroups,
  layout,
  dest,
  hooks = {},
} = {}) {
  const copiedNodes = layout?.nodes ?? [];
  const copiedGroups = layout?.groups ?? [];
  const pairs = pairCopiedToPasted(copiedNodes, pastedNodes);
  const origin = layoutOrigin(copiedNodes, copiedGroups);
  const target = dest ?? resolvePasteDest(null, pastedNodes);
  const translation = target ? [target[0] - origin[0], target[1] - origin[1]] : [0, 0];
  const writeNode = hooks.writeNodePos ?? defaultWriteNodePos;
  const placeGroup = hooks.placeGroup ?? defaultPlaceGroup;

  let restored = 0;
  for (const { copied, pasted } of pairs) {
    if (!copied.pos || !pasted) continue;
    const nx = copied.pos[0] + translation[0];
    const ny = copied.pos[1] + translation[1];
    let prev = [Number.NaN, Number.NaN];
    try {
      prev = [Number(pasted.pos?.[0]), Number(pasted.pos?.[1])];
    } catch {
      /* unreadable — write still attempted */
    }
    if (writeNode(pasted, nx, ny, prev)) restored += 1;
    if (copied.flags?.collapsed) {
      try {
        pasted.flags = { ...(pasted.flags || {}), collapsed: true };
      } catch {
        /* ignore */
      }
    }
  }

  const used = new Set();
  const created = [];
  for (const cg of copiedGroups) {
    const want = translateBounding(cg.bounding, translation);
    if (!want) continue;
    const match = findMatchingGroup(pastedGroups, cg, used);
    if (match) {
      used.add(match);
      placeGroup(match, want);
      if (cg.flags?.collapsed) {
        try {
          match.flags = { ...(match.flags || {}), collapsed: true };
        } catch {
          /* ignore */
        }
      }
    } else if (typeof hooks.createGroup === "function") {
      const g = hooks.createGroup({
        title: cg.title,
        bounding: want,
        color: cg.color,
        font_size: cg.font_size,
        flags: cg.flags,
      });
      if (g) created.push(g);
    }
  }

  return {
    translation,
    restored_positions: restored,
    created_groups: created.length,
    pasted_group_count: (pastedGroups?.length ?? 0) + created.length,
    created,
  };
}
