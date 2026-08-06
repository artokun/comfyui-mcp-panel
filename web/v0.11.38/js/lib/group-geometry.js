// Pure geometry helpers for LiteGraph GROUP membership.
//
// LiteGraph groups do NOT own their nodes. Membership is purely GEOMETRIC: a
// node belongs to a group when the group's bounding box contains the CENTRE
// point of the node's bounding box — the exact rule ComfyUI's @comfyorg/litegraph
// applies in LGraphGroup.recomputeInsideNodes (containsCentre → isInRect), so the
// panel's reported members match what the user sees on the canvas (issue #497).
// Several ComfyUI frontend builds leave LGraphGroup._nodes stale or empty after
// programmatic bounds / pos / paste changes (and never recompute when a MEMBER
// node moves — only when the GROUP is created/moved/resized), so the panel must
// recompute membership from LIVE node + group geometry on every read rather than
// trust the cached _nodes array (issues #287, #305, #311, #312, #497).
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

/**
 * Keep a node's cached boundingRect in lockstep with a programmatic position
 * write. LiteGraph only refreshes boundingRect during its own render pass, so
 * right after `node.pos = ...` the cached rect still describes the PRE-MOVE
 * footprint — and because nodeFocusBounds (and LiteGraph's own
 * recomputeInsideNodes → containsCentre) PREFER boundingRect, geometric group
 * membership would then be computed against stale geometry (#355).
 *
 * `prevPos` is the node's [x, y] BEFORE the write. We first let the engine
 * recompute via its own updateArea() (authoritative in a real ComfyUI/LiteGraph
 * build); if that method is absent, throws, or leaves the cached rect at its old
 * origin, we translate the rect by exactly the position delta — a pure move
 * shifts the bounding-box origin by the same amount, so this correction is exact
 * and build-independent. Dependency-free (no LiteGraph, no DOM) so it is
 * unit-testable with plain object fixtures.
 */
export function refreshNodeArea(node, prevPos) {
  if (!node) return;
  const rectBefore = node.boundingRect;
  const originBefore =
    rectBefore && rectBefore.length === 4 ? [rectBefore[0], rectBefore[1]] : null;
  try {
    node.updateArea?.();
  } catch {
    /* some builds need a canvas ctx; the delta-sync below still corrects it */
  }
  const br = node.boundingRect;
  if (!br || br.length !== 4) return;
  // Engine already moved the rect origin → trust its authoritative recompute.
  if (originBefore && (br[0] !== originBefore[0] || br[1] !== originBefore[1])) return;
  if (!Array.isArray(prevPos) || prevPos.length !== 2) return;
  const px = Number(prevPos[0]);
  const py = Number(prevPos[1]);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return;
  const dx = (node.pos?.[0] ?? 0) - px;
  const dy = (node.pos?.[1] ?? 0) - py;
  if (dx || dy) {
    br[0] += dx;
    br[1] += dy;
  }
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
 * Recomputes from the CURRENT node + group geometry instead of trusting the
 * cached g._nodes (which LiteGraph only refreshes when the GROUP moves, never
 * when a member node moves — the #497 stale-membership root cause). Membership
 * mirrors @comfyorg/litegraph's LGraphGroup.recomputeInsideNodes: a node is IN
 * the group when the group box contains the node bounding-box's CENTRE point
 * (containsCentre → isInRect), NOT when the two boxes merely overlap. A node
 * moved so its centre leaves the box is dropped even if an edge still pokes in —
 * matching what the user sees on the canvas. Best-effort calls
 * g.recomputeInsideNodes?.() first to keep LiteGraph's own cache (used by
 * convertToSubgraph / canvas selection) in sync, but never depends on its result.
 *
 * NOTE (dense-layout limitation, #297): membership is purely geometric, so ANY
 * unrelated node whose CENTRE falls within the group rectangle IS a member —
 * there is no per-node ownership to exclude it. Callers creating a group around a
 * specific node set must report requested-vs-actual honestly.
 */
export function groupMemberNodes(graph, g) {
  try { g?.recomputeInsideNodes?.(); } catch { /* build-specific; ignore */ }
  const gb = groupBoundsOf(g);
  if (!gb) return [];
  const [gx, gy, gw, gh] = gb;
  return (graph?._nodes ?? []).filter((n) => {
    const [nx, ny, nw, nh] = nodeFocusBounds(n);
    // Centre-in-rect, matching LiteGraph's containsCentre → isInRect: the centre
    // is inclusive on the min edges (>=) and exclusive on the max edges (<).
    const cx = nx + nw / 2;
    const cy = ny + nh / 2;
    return cx >= gx && cx < gx + gw && cy >= gy && cy < gy + gh;
  });
}

/**
 * Rewrite a node's cached boundingRect to match its CURRENT pos/size so a
 * geometric membership test taken RIGHT AFTER a programmatic group create
 * doesn't miss the node because its cached rect is stale from a previous render
 * or was never rendered at its live position (#391).
 *
 * The group box is built from pos/size (boundsAroundNodes) but membership is
 * tested against boundingRect-first (nodeFocusBounds); when the two disagree the
 * box visually wraps the node yet geometry excludes it, yielding an empty group.
 * Syncing the cached rect to the pos-based footprint (title band included, exactly
 * matching nodeFocusBounds' fallback) makes the two bases agree. No-op when there
 * is no cached rect — nodeFocusBounds already uses live pos/size in that case.
 * Mutates in place so it works on plain arrays AND typed-array rects (ComfyUI
 * Rectangle). Dependency-free for unit testing with plain object fixtures.
 */
export function syncNodeArea(node, forceCollapsed = false) {
  const br = node?.boundingRect;
  if (!br || br.length !== 4) return;
  // A COLLAPSED node's real footprint is just its title band (a small pill), not
  // its full pos/size. When syncing UNREQUESTED nodes in bulk (syncGraphNodeAreas,
  // used before a bounds/query membership read) overwriting a collapsed node's
  // cached rect with the full footprint would OVERSTATE its area and could wrongly
  // pull it into a nearby group box — so skip it and leave its (already-small)
  // rect to the engine (#416). But when the caller explicitly REQUESTED this node
  // (create-by-node_ids), force the sync: the group box is built around the node's
  // full pos/size (boundsAroundNodes), so its rect must match to be a member of its
  // own box — otherwise a requested collapsed node with a stale rect is dropped (#391).
  if (node.flags?.collapsed && !forceCollapsed) return;
  const w = node.size?.[0] ?? 200;
  const h = node.size?.[1] ?? 100;
  br[0] = node.pos?.[0] ?? 0;
  br[1] = (node.pos?.[1] ?? 0) - 30; // title bar renders above pos
  br[2] = w;
  br[3] = h + 30;
}

/**
 * Resync EVERY node's cached boundingRect to its live pos/size before a
 * geometric membership read that is NOT scoped to an explicit node set — i.e.
 * creating/querying a group by BOUNDS. move_node / move_group / auto_layout each
 * refresh the rect at their own write site, but nodes moved by paths the panel
 * does not own (paste, graph load, manual canvas drags) can still carry a stale
 * cached rect. Because bounds-derived membership tests every graph node's
 * boundingRect-first footprint (nodeFocusBounds), a single stale rect makes the
 * box wrap a node the geometry misses — or capture one that has moved away —
 * yielding the wrong node_ids (#416). Syncing all rects to live geometry first
 * makes the membership reflect the CURRENT layout. Collapsed nodes are left
 * untouched by syncNodeArea (see above). Dependency-free for unit testing.
 */
export function syncGraphNodeAreas(graph) {
  for (const n of graph?._nodes ?? []) syncNodeArea(n);
}

/**
 * Translate a group's geometric members by (dx, dy) AND keep each moved node's
 * cached boundingRect live, so the very next membership read (summarizeGroup /
 * graph_query) sees the moved footprint instead of the pre-move one.
 *
 * graph_move_group used to write node.pos directly and rely on a later render to
 * refresh boundingRect; because nodeFocusBounds (and LiteGraph's own
 * recomputeInsideNodes) PREFER the cached rect, membership computed right after
 * the move was tested against stale geometry — the box moved but its members
 * "stayed behind", and a follow-up panel_query_graph reported stale node_ids
 * (#408). refreshNodeArea shifts each rect by the exact move delta (mirroring the
 * move_node path, #355). `prevPos` is captured per node BEFORE its pos write so
 * the delta correction is exact and build-independent. Dependency-free.
 */
export function moveGroupMembers(members, dx, dy) {
  for (const n of members ?? []) {
    if (!n || !Array.isArray(n.pos)) continue;
    const prev = [n.pos[0], n.pos[1]];
    n.pos = [(n.pos[0] ?? 0) + dx, (n.pos[1] ?? 0) + dy];
    refreshNodeArea(n, prev);
  }
}

/**
 * Compare the node ids actually enclosed (geometric) against the ids the caller
 * asked to group. Returns { requested, members, extra, missing } so a create
 * handler can warn honestly in dense layouts (#297) instead of reporting a
 * misleading success.
 *
 * Ids are compared by their STRING form: requested ids arrive as numbers (the
 * tool schema is number[]) while live LiteGraph ids are strings ("9"), so a raw
 * Set/SameValueZero compare (9 !== "9") would put every id in BOTH extra and
 * missing on every call — the honest-reporting feature inverted (#566, #388).
 * Normalizing to a common key fixes that; the returned arrays keep each id's
 * ORIGINAL representation so callers see the ids in their native form.
 */
export function classifyRequestedMembership(requestedIds, memberIds) {
  const key = (id) => String(id);
  const reqKeys = new Set(requestedIds.map(key));
  const memberKeys = new Set(memberIds.map(key));
  return {
    requested: [...requestedIds],
    members: [...memberIds],
    extra: memberIds.filter((id) => !reqKeys.has(key(id))),
    missing: requestedIds.filter((id) => !memberKeys.has(key(id))),
  };
}
