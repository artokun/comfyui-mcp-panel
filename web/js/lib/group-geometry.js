// Pure geometry helpers for LiteGraph GROUP membership.
//
// LiteGraph groups do NOT own their nodes. Membership is purely GEOMETRIC: a
// node belongs to a group when its bounding box overlaps the group's bounding
// box. Several ComfyUI frontend builds leave LGraphGroup._nodes stale or empty
// after programmatic bounds / pos / paste changes, so the panel must recompute
// membership from LIVE node + group geometry on every read rather than trust the
// cached _nodes array (issues #287, #305, #311, #312).
//
// These functions are intentionally dependency-free (no LiteGraph, no DOM) so
// they can be unit-tested with plain object fixtures.

/** [x, y, w, h] for a node — prefer litegraph's boundingRect (includes title). */
export function nodeFocusBounds(node) {
  // Accept plain arrays AND typed arrays (current ComfyUI Rectangle is a
  // Float32Array subclass): any indexable of length 4 with a non-zero extent.
  const br = node.boundingRect;
  if (br && br.length === 4 && (br[2] || br[3])) {
    return [br[0], br[1], br[2], br[3]];
  }
  const w = node.size?.[0] ?? 200;
  const h = node.size?.[1] ?? 100;
  return [node.pos[0], node.pos[1] - 30, w, h + 30]; // title bar renders above pos
}

/** [x, y, w, h] that wraps the given nodes, padded for the group + node titles. */
export function boundsAroundNodes(nodes, pad = 30, titlePad = 70) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const x = n.pos?.[0] ?? 0;
    const y = n.pos?.[1] ?? 0;
    const w = n.size?.[0] ?? 200;
    const h = n.size?.[1] ?? 100;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  if (!Number.isFinite(minX)) return [100, 100, 400, 300];
  return [minX - pad, minY - titlePad, maxX - minX + pad * 2, maxY - minY + titlePad + pad];
}

/** Current [x,y,w,h] of a group box, or null if not finite. */
export function groupBoundsOf(g) {
  const b = g?._bounding ?? [g?.pos?.[0], g?.pos?.[1], g?.size?.[0], g?.size?.[1]];
  const x = Number(b?.[0]), y = Number(b?.[1]), w = Number(b?.[2]), h = Number(b?.[3]);
  return [x, y, w, h].every(Number.isFinite) ? [x, y, w, h] : null;
}

/**
 * LIVE geometric membership of a LiteGraph group.
 *
 * Recomputes from the CURRENT node + group geometry (overlap test, mirroring
 * LiteGraph's own overlapBounding) instead of trusting the cached g._nodes.
 * Best-effort calls g.recomputeInsideNodes?.() first to keep LiteGraph's own
 * cache (used by convertToSubgraph / canvas selection) in sync, but never
 * depends on its result.
 *
 * NOTE (dense-layout limitation, #297): because membership is purely geometric,
 * ANY unrelated node whose box overlaps the group rectangle IS a member — there
 * is no per-node ownership to exclude it. Callers creating a group around a
 * specific node set must report requested-vs-actual honestly.
 */
export function groupMemberNodes(graph, g) {
  try { g?.recomputeInsideNodes?.(); } catch { /* build-specific; ignore */ }
  const gb = groupBoundsOf(g);
  if (!gb) return [];
  const [gx, gy, gw, gh] = gb;
  return (graph?._nodes ?? []).filter((n) => {
    const [nx, ny, nw, nh] = nodeFocusBounds(n);
    // Inclusive overlap, matching LiteGraph's overlapBounding (edge contact counts).
    return nx <= gx + gw && nx + nw >= gx && ny <= gy + gh && ny + nh >= gy;
  });
}

/**
 * Compare the node ids actually enclosed (geometric) against the ids the caller
 * asked to group. Returns { requested, members, extra, missing } so a create
 * handler can warn honestly in dense layouts (#297) instead of reporting a
 * misleading success.
 */
export function classifyRequestedMembership(requestedIds, memberIds) {
  const req = new Set(requestedIds);
  const members = new Set(memberIds);
  return {
    requested: [...requestedIds],
    members: [...memberIds],
    extra: memberIds.filter((id) => !req.has(id)),
    missing: requestedIds.filter((id) => !members.has(id)),
  };
}
