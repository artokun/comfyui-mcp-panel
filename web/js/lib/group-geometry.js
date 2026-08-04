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
  const moved = [];
  const stuck = [];
  const attempted = [];
  for (const n of members ?? []) {
    const px = Number(n?.pos?.[0]);
    const py = Number(n?.pos?.[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      if (n) stuck.push(n);
      continue;
    }
    attempted.push([n, px, py]);
    const landedExactly = writePoint(n, "pos", px + dx, py + dy);
    // Sync the cached rect UNCONDITIONALLY. A write can miss its target and still
    // RELOCATE the node (a setter that snaps or clamps): refreshing only on an
    // exact landing would leave that node's cached rect describing where it used
    // to be, and every geometric membership read afterwards — which prefers the
    // cached rect — would place it in the group it has actually left. The refresh
    // is a delta from the pre-write position, so it is correct wherever the node
    // ended up, including "did not move at all".
    refreshNodeArea(n, [px, py]);
    (landedExactly ? moved : stuck).push(n);
  }
  return { moved, stuck, undo: () => restoreNodePositions(attempted) };
}

/** Keep a node's cached rect in step with a restore, then say whether the node
 *  is back where it started. */
function restoreNodePosition(n, px, py) {
  const cur = [Number(n?.pos?.[0]), Number(n?.pos?.[1])];
  const ok = writePoint(n, "pos", px, py);
  refreshNodeArea(n, cur);
  return ok;
}

/**
 * Put every ATTEMPTED node back at the exact coordinates it had before the move,
 * whether its write landed, landed somewhere else, or did not land at all.
 *
 * Undoing by the inverse delta is not good enough: a build whose setter clamps or
 * snaps leaves the node at a THIRD position, which writePoint correctly reports
 * as not-landed — and an undo that only walked the `moved` list would leave that
 * node displaced while the caller announced that nothing had moved. Restoring
 * absolutely, over the whole attempted set, is what makes that announcement true.
 *
 * Returns the nodes that could NOT be put back. A restore can fail for the same
 * reasons a move can (a constrained setter may accept the new coordinates and
 * refuse the old ones), and a caller that announces "nothing was moved" without
 * looking at this list is making exactly the unverified claim this whole change
 * exists to stop.
 */
function restoreNodePositions(attempted) {
  const failed = [];
  for (const [n, px, py] of attempted ?? []) {
    if (!restoreNodePosition(n, px, py)) failed.push(n);
  }
  return failed;
}

/**
 * Is `actual` the value a write of `want` was supposed to leave behind?
 *
 * EXACT equality — with one narrowly scoped exception: when the destination is
 * literally a Float32Array (older LiteGraph builds back node positions and group
 * bounds with one), it physically cannot hold an arbitrary double, so the value
 * it does hold, `Math.fround(want)`, is the write succeeding. Pass float32 only
 * after checking the actual container.
 *
 * Deliberately NOT a relative tolerance. Slack proportional to the coordinate
 * accepts an arbitrarily large error at a large coordinate — which means
 * reporting a write that did nothing, or that a build snapped/clamped somewhere
 * else, as a completed move. Now that an unmovable child aborts the whole group
 * move, this predicate decides between a truthful refusal and a fabricated
 * success, so it gets no free slack.
 */
export function samePoint(actual, want, float32 = false) {
  if (!Number.isFinite(actual) || !Number.isFinite(want)) return false;
  if (actual === want) return true;
  return float32 && actual === Math.fround(want);
}

/** Is this point/quad container a 32-bit float array (which cannot hold an
 *  arbitrary double)? */
function isFloat32(container) {
  return typeof Float32Array !== "undefined" && container instanceof Float32Array;
}

/**
 * Did the group's box actually end up as [x, y] — and, when `w`/`h` are given,
 * with those dimensions?
 *
 * The size half is not decoration. A group box is written component by component
 * (setGroupBounds assigns x, y, w AND h), so a clamping setter or a throw partway
 * through the quad can leave the box at the right corner with the wrong size, or
 * put the corner back while the size stays corrupted. Verifying only the top-left
 * would call both of those a completed move — and, worse, would let a rollback
 * report "nothing was moved" over a box whose dimensions no longer match what the
 * user had.
 */
export function groupBoxIsAt(g, x, y, w, h) {
  const after = groupBoundsOf(g);
  if (!after) return false;
  const f32 = isFloat32(g?._bounding);
  if (!samePoint(after[0], x, f32) || !samePoint(after[1], y, f32)) return false;
  if (w != null && !samePoint(after[2], w, f32)) return false;
  if (h != null && !samePoint(after[3], h, f32)) return false;
  return true;
}

/**
 * Write an [x, y] point property and REPORT whether the write actually landed.
 *
 * Frontends back these points with three different shapes and a single write
 * strategy silently loses on at least one of them:
 *   - a plain array (assignment and in-place both work);
 *   - a typed-array VIEW (current builds expose LGraphNode.pos as a Float64Array
 *     subarray of the node's boundingRect) — `Array.isArray` is FALSE for it, so
 *     a guard written for plain arrays skipped every node on those builds and the
 *     group box moved alone: exactly the #408 symptom the move was meant to fix;
 *   - an accessor pair whose getter returns a COPY, where an in-place write is
 *     silently dropped, or a getter with NO setter, where assignment throws in a
 *     strict-mode ES module.
 *
 * WHICH WRITE GOES FIRST DEPENDS ON THE PROPERTY, and both orders are wrong for
 * the other kind:
 *   - An ACCESSOR with a setter (current ComfyUI's LGraphNode.pos) must be
 *     ASSIGNED. Its setter does more than store two numbers — it commits the move
 *     to the frontend's layout store — and a setter writes into the array it
 *     already owns, so assignment does not replace anything. Poking the array
 *     directly moves the canvas while the layout store keeps the old coordinates.
 *   - A plain DATA property holding a typed-array VIEW (into the node's bounding
 *     rect) must be written IN PLACE. Assigning a fresh array there replaces the
 *     view: right coordinates, silently severed aliasing, and every later write
 *     through that view stops reaching the node.
 * So the property is inspected once and the write that respects it goes first;
 * the other stays as a fallback (a getter that returns a COPY drops an in-place
 * write; a getter with no setter throws on assignment in a strict-mode module).
 *
 * Returning the verdict is the point — the caller must never report a move it did
 * not make.
 */
export function writePoint(owner, key, x, y) {
  const landed = () => {
    const point = owner?.[key];
    const f32 = isFloat32(point);
    return samePoint(Number(point?.[0]), x, f32) && samePoint(Number(point?.[1]), y, f32);
  };
  const assign = () => {
    try {
      owner[key] = [x, y];
    } catch {
      /* accessor with no setter — strict-mode assignment throws */
    }
  };
  const inPlace = () => {
    const point = owner?.[key];
    if (!point || point.length < 2) return;
    try {
      point[0] = x;
      point[1] = y;
    } catch {
      /* frozen/read-only point */
    }
  };
  const [first, second] = hasSetter(owner, key) ? [assign, inPlace] : [inPlace, assign];
  first();
  if (landed()) return true;
  second();
  return landed();
}

/** Does writing `owner[key]` run a SETTER (rather than replacing a data
 *  property)? Walks the prototype chain, because LiteGraph defines its geometry
 *  accessors on the class prototype, not on each instance. */
function hasSetter(owner, key) {
  for (let o = owner; o != null; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return typeof d.set === "function";
  }
  return false;
}

/**
 * Does box `outer` fully enclose box `inner`? Mirrors @comfyorg/litegraph's
 * `containsRect`, INCLUDING its deliberate exclusion of two identical rects:
 * coincident boxes are peers, not parent/child, so neither one drags the other.
 */
export function containsBounds(outer, inner) {
  if (!outer || !inner) return false;
  const [ax, ay, aw, ah] = outer;
  const [bx, by, bw, bh] = inner;
  const aRight = ax + aw;
  const aBottom = ay + ah;
  const bRight = bx + bw;
  const bBottom = by + bh;
  if (ax === bx && ay === by && aRight === bRight && aBottom === bBottom) return false;
  return ax <= bx && ay <= by && aRight >= bRight && aBottom >= bBottom;
}

/**
 * Groups NESTED inside `g` — every OTHER group whose box is fully contained in
 * g's box. This mirrors LiteGraph's own child-group rule (containsRect in
 * LGraphGroup.recomputeInsideNodes), which is FULL containment for groups even
 * though membership for NODES is centre-in-rect: a merely overlapping neighbour
 * is not a child and must not be dragged along.
 *
 * Needed because the panel reimplements the group move instead of calling
 * g.move() (whose cached children are stale/empty on affected builds, #287/#311/
 * #312). Reimplementing only the NODE half moved the outer box and its nodes but
 * stranded every inner group box over the space the nodes just vacated — the
 * "nodes that looked grouped no longer are" half of #408, and a divergence from
 * the documented "like dragging the group header" contract.
 */
export function nestedGroupsOf(graph, g) {
  const outer = groupBoundsOf(g);
  if (!outer) return [];
  return (graph?._groups ?? []).filter((other) => {
    if (!other || other === g) return false;
    const inner = groupBoundsOf(other);
    return !!inner && containsBounds(outer, inner);
  });
}

/**
 * Translate a group's box by (dx, dy), writing through whichever geometry the
 * build exposes — the `_bounding` quad (plain OR typed array, mutated in place)
 * or the pos/size pair — and REPORT whether the box actually ended up there.
 * Mirrors the panel's setGroupBounds write policy.
 */
export function placeGroupBox(g, x, y) {
  // A move must not change the SIZE. Capture it first and verify it survived, so
  // a build that resizes on reposition is reported as not-moved instead of
  // silently reshaping the user's group.
  const before = groupBoundsOf(g);
  const b = g?._bounding;
  if (b && b.length >= 4) {
    try {
      b[0] = x;
      b[1] = y;
    } catch {
      /* frozen quad — verified below */
    }
  } else {
    writePoint(g, "pos", x, y);
  }
  return groupBoxIsAt(g, x, y, before?.[2], before?.[3]);
}

export function translateGroupBox(g, dx, dy) {
  const before = groupBoundsOf(g);
  if (!before) return false;
  return placeGroupBox(g, before[0] + dx, before[1] + dy);
}

/** Translate several group boxes, reporting which ones actually moved and
 *  handing back an ABSOLUTE undo (see restoreNodePositions for why the inverse
 *  delta is not good enough). */
export function translateGroupBoxes(groups, dx, dy) {
  const moved = [];
  const stuck = [];
  const attempted = [];
  for (const g of groups ?? []) {
    const before = groupBoundsOf(g);
    if (!before) {
      if (g) stuck.push(g);
      continue;
    }
    attempted.push([g, before[0], before[1]]);
    (placeGroupBox(g, before[0] + dx, before[1] + dy) ? moved : stuck).push(g);
  }
  return {
    moved,
    stuck,
    /** Returns the boxes that could NOT be put back. */
    undo: () => attempted.filter(([g, x, y]) => !placeGroupBox(g, x, y)).map(([g]) => g),
  };
}

/** Every reroute point of a graph, across the Map / array / plain-object shapes
 *  different frontend builds expose on `graph.reroutes`. */
function allReroutes(graph) {
  const r = graph?.reroutes;
  if (!r) return [];
  if (typeof r.values === "function") return [...r.values()];
  if (Array.isArray(r)) return r;
  if (typeof r === "object") return Object.values(r);
  return [];
}

/**
 * Link reroute points whose position falls inside `bounds` — LiteGraph's own
 * rule for reroute children of a group (isPointInRect on the reroute position,
 * NOT a centre-of-box test, because a reroute IS a point).
 */
export function reroutesInside(graph, bounds) {
  if (!bounds) return [];
  const [x, y, w, h] = bounds;
  return allReroutes(graph).filter((r) => {
    const px = Number(r?.pos?.[0]);
    const py = Number(r?.pos?.[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
    return px >= x && px < x + w && py >= y && py < y + h;
  });
}

/**
 * Translate reroute points by (dx, dy), reporting which ones actually moved.
 * Without this a moved group leaves its wire elbows behind and the links
 * visibly snake back to where the group used to be.
 *
 * Prefers the engine's OWN `Reroute.move(dx, dy)` when the build exposes it, so
 * the frontend's reactive layout store records the change rather than only the
 * canvas seeing a mutated point — the same "use the engine primitive, then
 * verify" policy the panel already applies to node.setSize / graph.removeGroup.
 * The result is verified either way, so a build whose `move` has a different
 * signature (or none) is corrected by the direct point write, and a frozen point
 * is reported as stuck instead of throwing halfway through a group move.
 */
export function placeReroute(r, x, y) {
  const cx = Number(r?.pos?.[0]);
  const cy = Number(r?.pos?.[1]);
  if (typeof r?.move === "function" && Number.isFinite(cx) && Number.isFinite(cy)) {
    try {
      r.move(x - cx, y - cy);
    } catch {
      /* build-specific; the direct write below still gets it there */
    }
    const f32 = isFloat32(r?.pos);
    if (samePoint(Number(r?.pos?.[0]), x, f32) && samePoint(Number(r?.pos?.[1]), y, f32)) return true;
  }
  return writePoint(r, "pos", x, y);
}

export function moveReroutePoints(reroutes, dx, dy) {
  const moved = [];
  const stuck = [];
  const attempted = [];
  for (const r of reroutes ?? []) {
    const px = Number(r?.pos?.[0]);
    const py = Number(r?.pos?.[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      if (r) stuck.push(r);
      continue;
    }
    attempted.push([r, px, py]);
    (placeReroute(r, px + dx, py + dy) ? moved : stuck).push(r);
  }
  return {
    moved,
    stuck,
    /** Returns the reroutes that could NOT be put back. */
    undo: () => attempted.filter(([r, px, py]) => !placeReroute(r, px, py)).map(([r]) => r),
  };
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
