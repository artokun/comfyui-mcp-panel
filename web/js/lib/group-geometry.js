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
 *
 * NEVER THROWS. This runs AFTER a node's position has already been written, so a
 * throw here would escape from the middle of a group move — past the caller's
 * rollback, which only runs once the mover returns — and leak a moved node out
 * under an unrelated TypeError. A cached rect that will not accept the correction
 * is reported by the return value (false) instead, so the caller can treat that
 * node as stuck and refuse the whole move rather than discovering it mid-flight.
 * Returns true when the rect is in step with the node's live position.
 */
export function refreshNodeArea(node, prevPos) {
  // The whole body is contained, not just the writes: READING `boundingRect` or
  // `pos` can throw as easily as writing them (a disposed accessor, a revoked
  // proxy), and this function claims never to throw. A claimed contract that only
  // holds for the write half is the kind of guard that fails exactly when it is
  // needed — while the caller is mid-transaction and relying on a verdict.
  try {
    if (!node) return true;
    const rectBefore = node.boundingRect;
    const originBefore =
      rectBefore && rectBefore.length === 4 ? [rectBefore[0], rectBefore[1]] : null;
    try {
      node.updateArea?.();
    } catch {
      /* some builds need a canvas ctx; the delta-sync below still corrects it */
    }
    const br = node.boundingRect;
    if (!br || br.length !== 4) return true; // nothing cached ⇒ reads use live pos/size
    // Engine already moved the rect origin → trust its authoritative recompute.
    if (originBefore && (br[0] !== originBefore[0] || br[1] !== originBefore[1])) return true;
    if (!Array.isArray(prevPos) || prevPos.length !== 2) return true;
    const px = Number(prevPos[0]);
    const py = Number(prevPos[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return true;
    const dx = (node.pos?.[0] ?? 0) - px;
    const dy = (node.pos?.[1] ?? 0) - py;
    if (!dx && !dy) return true;
    const wantX = br[0] + dx;
    const wantY = br[1] + dy;
    try {
      br[0] = wantX;
      br[1] = wantY;
    } catch {
      /* frozen/read-only rect — reported below, never thrown mid-transaction */
    }
    return br[0] === wantX && br[1] === wantY;
  } catch {
    return false; // cannot be shown to be in step ⇒ the caller treats it as stuck
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

/**
 * Name an item for a HUMAN-READABLE message, and never throw doing it.
 *
 * `id` and `title` are the fields most likely to be exotic — proxies, getters,
 * reactive stores — and they are needed only for display. Nothing about restoring
 * geometry requires knowing what a node is called, so a message that cannot be
 * assembled must degrade to a plainer one rather than raise over a graph the
 * caller has just been told is intact. `String(x)` throws too (a throwing
 * toString/Symbol.toPrimitive), so even the coercion is contained.
 */
export function describeItem(kind, item) {
  // EVERY operation is inside the guard, including the template's coercion of
  // `kind` and the `String(id)` call. A totality contract that holds for most of
  // a function is the class of comment this codebase keeps getting burned by:
  // callers guard on the promise, not on the implementation.
  try {
    let text = "?";
    try {
      const id = item?.id;
      if (id != null) text = String(id);
    } catch {
      text = "unnamed";
    }
    return `${String(kind)} ${text}`;
  } catch {
    return "an item that could not be named";
  }
}

/** A comma-separated list of at most `max` item names, with an ellipsis when
 *  truncated. Total, for the same reason describeItem is — `slice`, the entry
 *  destructuring and `length` are all operations on a caller-supplied value, so
 *  they are inside the guard too. */
export function describeItems(pairs, max = 5) {
  try {
    const names = [];
    let count = 0;
    for (const entry of pairs ?? []) {
      if (count >= max) break;
      count += 1;
      try {
        names.push(describeItem(entry?.[0], entry?.[1]));
      } catch {
        names.push("an item that could not be named");
      }
    }
    let total = count;
    try {
      total = Number(pairs?.length);
    } catch {
      total = count;
    }
    return names.join(", ") + (Number.isFinite(total) && total > max ? ", …" : "");
  } catch {
    return "items that could not be named";
  }
}

/**
 * Render a thrown value as text without throwing again.
 *
 * The error path of the error path: a caught error may itself be an object whose
 * `message` getter throws (a throwing `title` on a group is enough to produce
 * one), and `String(error)` can throw for the same reason. If reading the cause
 * can defeat the handler that exists to report it, the caller receives a raw
 * failure for a move that COMPLETED — and re-issues it.
 */
export function describeThrown(error) {
  try {
    const message = error?.message;
    if (typeof message === "string") return message;
  } catch {
    /* fall through to the coercion attempt */
  }
  try {
    return String(error);
  } catch {
    return "an error whose message could not be read";
  }
}

/** [x, y, w, h] as finite numbers, or null if any component is not one. */
function finiteQuad(v) {
  const x = Number(v?.[0]), y = Number(v?.[1]), w = Number(v?.[2]), h = Number(v?.[3]);
  return [x, y, w, h].every(Number.isFinite) ? [x, y, w, h] : null;
}

/**
 * Current [x, y, w, h] of a group box, or null when the build exposes neither
 * usable form.
 *
 * The fallback to pos/size is on VALIDITY, not on `_bounding` being nullish. A
 * present-but-malformed `_bounding` (a half-initialised quad, a leftover from a
 * failed deserialize) used to short-circuit the `??` and make the whole group
 * read as unbounded — so a group carrying perfectly good finite pos/size was
 * refused as having no usable bounds. "Present" is not "usable".
 */
export function groupBoundsOf(g) {
  try {
    return groupBoundsTarget(g)?.bounds ?? null;
  } catch {
    return null; // a hostile/disposed accessor is "no usable bounds", not a throw
  }
}

/**
 * WHICH container currently holds this group's box, and what it says — the ONE
 * rule every reader and every partial writer must share.
 *
 * Chosen by VALIDITY, never by mere presence. A malformed `_bounding` (a
 * half-initialised quad, a leftover from a failed deserialize) must not capture
 * the write while the read falls through to pos/size: a translate that writes
 * only x/y into the malformed quad leaves it malformed, the read still returns
 * the unchanged pos/size, verification fails, and a perfectly movable group is
 * refused. Reading and writing have to agree on the container, so they ask the
 * same question here.
 *
 * Returns `{ kind: "bounding" | "possize", bounds: [x, y, w, h] }`, or null when
 * neither form is usable.
 */
export function groupBoundsTarget(g) {
  const fromQuad = finiteQuad(g?._bounding);
  if (fromQuad) return { kind: "bounding", bounds: fromQuad };
  const fromPosSize = finiteQuad([g?.pos?.[0], g?.pos?.[1], g?.size?.[0], g?.size?.[1]]);
  if (fromPosSize) return { kind: "possize", bounds: fromPosSize };
  return null;
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
 *
 * A COLLAPSED node is synced to its COLLAPSED footprint — the title pill LiteGraph
 * actually draws — not skipped and not given the full pos/size box. Skipping it
 * (the original #416 guard) kept its area from being overstated but left the rect
 * STALE, and membership is boundingRect-first: a collapsed node sitting inside a
 * group box while its cached rect claimed somewhere else was silently omitted from
 * the group (left behind by a move, reported as zero moved) or reported as newly
 * enclosed when it was not. Writing the pill keeps #416's guarantee — the area is
 * never overstated — while making the rect live. `forceCollapsed` still writes the
 * FULL footprint, which create-by-node_ids needs because it builds the box around
 * the node's full pos/size (#391).
 *
 * NEVER THROWS: this is called from read paths and from inside a group move, so a
 * frozen rect must be reported (false), never raised. Returns whether the cached
 * rect now matches the footprint it was asked to describe.
 */
export const COLLAPSED_TITLE_HEIGHT = 30;
export const COLLAPSED_PILL_WIDTH = 80; // LiteGraph.NODE_COLLAPSED_WIDTH

/** A finite, POSITIVE extent, or the given default. `Number(x) || d` is not
 *  enough: Infinity and -1 are both truthy, and an infinite (or negative) extent
 *  written into a cached rect makes the node a geometric member of every group —
 *  or of none — which is precisely the area overstatement the pill exists to
 *  avoid (#416). Zero is rejected for the same reason from the other side: a
 *  degenerate rect has no centre worth testing. `Number(null)` is 0, so a missing
 *  value lands here rather than sneaking through as a valid extent. */
function finiteExtent(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The rect a node's cached boundingRect SHOULD hold for its live pos/size, or
 * NULL when the node's position is not a finite point.
 *
 * Null rather than a substituted origin: a node whose position cannot be read as
 * a number has no knowable footprint, and writing a made-up [0, 0] would place it
 * in whatever group happens to sit at the origin. Callers turn null into "cannot
 * be determined", which is the honest answer.
 */
function wantedNodeArea(node, forceCollapsed = false) {
  const x = Number(node?.pos?.[0]);
  const y = Number(node?.pos?.[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const collapsed = !!node.flags?.collapsed && !forceCollapsed;
  const w = collapsed
    ? finiteExtent(node._collapsed_width, COLLAPSED_PILL_WIDTH)
    : finiteExtent(node.size?.[0], 200);
  const h = collapsed ? 0 : finiteExtent(node.size?.[1], 100);
  return [x, y - COLLAPSED_TITLE_HEIGHT, w, h + COLLAPSED_TITLE_HEIGHT]; // title above pos
}

/**
 * Does this node's cached rect describe where the node ACTUALLY is? A pure read.
 *
 * This, not "did my delta-write succeed", is the property that matters: a rect
 * that never had to move is already live, and reporting it as stuck would refuse
 * a perfectly good move (or invent a partial one during a rollback). True when
 * there is no cached rect at all, since reads then use live pos/size.
 */
export function nodeAreaIsLive(node) {
  try {
    const want = wantedNodeArea(node);
    if (!want) return false; // no knowable footprint ⇒ cannot be shown to be live
    const br = node?.boundingRect;
    if (!br || br.length !== 4) return true;
    return want.every((v, i) => br[i] === v);
  } catch {
    return false; // an unreadable node cannot be shown to be live
  }
}

/**
 * Did this node's cached boundingRect ORIGIN shift by (dx, dy)?
 *
 * Distinct from `nodeAreaIsLive`, which asks whether the WHOLE rect matches the
 * panel's generic `[x, y-30, w, h+30]` model. A custom node (Label (rgthree) and
 * anything else whose `updateArea()` draws past `size`) has a live, engine-
 * authoritative rect whose extents will NEVER match that model. Demanding the
 * generic footprint made `panel_move_group` refuse a group of those nodes after
 * their positions had already been written, while `panel_edit_node` — which never
 * asks this question — moved the same nodes fine (#1300).
 *
 * Membership is still rect-first: if the origin did not track the move, the next
 * geometric read would leave the node in the group it has actually left, so this
 * returns false and the caller treats the node as stuck (#408). Re-reads
 * `boundingRect` so a copying getter (writes to a throwaway) cannot fake a pass.
 *
 * `originBefore` is the `[x, y]` origin SNAPSHOTTED before the position write.
 * Null/missing means there was no cached rect to compare: a missing rect means
 * membership reads use live pos/size, and a rect that only appeared after the
 * write is the engine's answer for the NEW position. Either way the origin cannot
 * be stale from the old one, so a finite origin (or no rect at all) is enough.
 */
export function nodeAreaOriginTracks(node, originBefore, dx, dy) {
  try {
    const br = node?.boundingRect;
    if (!br || br.length !== 4) return true; // nothing cached ⇒ reads use live pos
    const f32 = isFloat32(br);
    if (!originBefore || originBefore.length !== 2) {
      const x = Number(br[0]);
      const y = Number(br[1]);
      return Number.isFinite(x) && Number.isFinite(y);
    }
    const ox = Number(originBefore[0]);
    const oy = Number(originBefore[1]);
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) return false;
    const wantDx = Number(dx);
    const wantDy = Number(dy);
    if (!Number.isFinite(wantDx) || !Number.isFinite(wantDy)) return false;
    return samePoint(Number(br[0]), ox + wantDx, f32) && samePoint(Number(br[1]), oy + wantDy, f32);
  } catch {
    return false; // an unreadable rect cannot be shown to have tracked
  }
}

export function syncNodeArea(node, forceCollapsed = false) {
  try {
    // Read the live geometry FIRST, even when there is no cached rect to write.
    // This is what makes the bulk sync a genuine readability pre-flight: a node
    // whose pos/size/flags accessors are hostile or disposed is reported here,
    // before groupMemberNodes touches it and raises a bare TypeError at a caller
    // who asked to move a group.
    const want = wantedNodeArea(node, forceCollapsed);
    if (!want) return false; // no knowable footprint ⇒ cannot be made live
    const br = node?.boundingRect;
    if (!br || br.length !== 4) return true;
    try {
      br[0] = want[0];
      br[1] = want[1];
      br[2] = want[2];
      br[3] = want[3];
    } catch {
      /* frozen/read-only rect — reported below, never thrown into a caller */
    }
    return want.every((v, i) => br[i] === v);
  } catch {
    // A hostile/disposed accessor (pos, size, flags, boundingRect) must be
    // REPORTED — this runs in read paths and in a move's pre-flight, where a raw
    // TypeError would replace a clean refusal.
    return false;
  }
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
 * makes the membership reflect the CURRENT layout. Collapsed nodes are synced to
 * their collapsed pill rather than skipped (see syncNodeArea). Dependency-free.
 *
 * NEVER THROWS. Returns `{ unsynced, undo }`: the nodes whose cached rect would
 * not accept the resync, and an undo that puts every rect this touched back
 * exactly as it found it (returning the ones it could not restore).
 *
 * The undo is not optional. Writing rects IS a mutation, and a caller that runs
 * this as a pre-flight and then refuses because one node failed would otherwise
 * have already changed every earlier node's cached geometry — with no way to take
 * it back — while telling the user NOTHING was moved. Moving a mutation earlier
 * does not stop it being a mutation: the pre-flight needs the same
 * contain-per-item-and-return-undo contract as the movers it precedes.
 *
 * `walkFailed` is that contract extended to the TRAVERSAL. Containing per item is
 * not enough while iterating `_nodes` can itself throw — a getter or a proxy can
 * die fetching the NEXT entry, after earlier rects have already been reconciled,
 * and a function that threw at that point would never return the undo those
 * writes need. The accumulator therefore lives outside the loop and the whole
 * walk is contained, so the caller always gets something it can roll back with.
 */
export function syncGraphNodeAreas(graph) {
  const unsynced = [];
  const attempted = [];
  let walkFailed = false;
  try {
    for (const n of graph?._nodes ?? []) {
      // SNAPSHOT FIRST, and never write what the snapshot could not capture. The
      // snapshot is itself inside the transaction: a rect whose `[1]` getter
      // throws once and then accepts every subsequent write would otherwise be
      // reconciled with NO undo recorded for it — and a later refusal would say
      // "NOTHING was moved" over a node it has no way to put back. You cannot undo
      // what you never recorded, so an uncapturable node is reported instead.
      let before = null;
      try {
        const br = n?.boundingRect;
        if (br && br.length === 4) before = [br[0], br[1], br[2], br[3]];
      } catch {
        unsynced.push(n);
        continue; // unreadable rect ⇒ no restore point ⇒ do not touch it
      }
      if (before) attempted.push([n, before]);
      if (!syncNodeArea(n)) unsynced.push(n);
    }
  } catch {
    // The traversal died. Whatever was reconciled before that point is still in
    // `attempted`, so the undo below is complete for everything actually written.
    walkFailed = true;
  }
  return {
    walkFailed,
    unsynced,
    undo: () => {
      const failed = [];
      for (const [n, before] of attempted) {
        try {
          const br = n?.boundingRect;
          if (!br || br.length !== 4) continue;
          try {
            br[0] = before[0];
            br[1] = before[1];
            br[2] = before[2];
            br[3] = before[3];
          } catch {
            /* frozen — reported below */
          }
          if (!before.every((v, i) => br[i] === v)) failed.push(n);
        } catch {
          failed.push(n);
        }
      }
      return failed;
    },
  };
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
    // Per-item containment. If this loop threw partway it would never RETURN its
    // undo, so everything it had already moved would be unrecoverable — the
    // caller's rollback cannot undo what it was never handed. Reading `pos` can
    // itself throw (a getter over a disposed/revoked proxy), so the read is inside
    // the guard too. A throwing item is stuck, exactly like an unwritable one.
    let px = Number.NaN;
    let py = Number.NaN;
    try {
      px = Number(n?.pos?.[0]);
      py = Number(n?.pos?.[1]);
    } catch {
      /* unreadable position ⇒ stuck below */
    }
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      if (n) stuck.push(n);
      continue;
    }
    attempted.push([n, px, py]);
    // Snapshot the cached origin BEFORE the write so the #1300 origin-tracks
    // check can delta-compare afterwards. A throwing accessor is "unreadable",
    // not "no rect": we cannot prove the origin tracked a value we never captured.
    let originBefore = null;
    let originReadable = false;
    try {
      const br = n?.boundingRect;
      if (br && br.length === 4) {
        const ox = Number(br[0]);
        const oy = Number(br[1]);
        if (Number.isFinite(ox) && Number.isFinite(oy)) {
          originBefore = [ox, oy];
          originReadable = true;
        }
      } else {
        originReadable = true; // no cached rect ⇒ membership reads use live pos
      }
    } catch {
      originReadable = false;
    }
    let landedExactly = false;
    try {
      landedExactly = writePoint(n, "pos", px + dx, py + dy);
    // Sync the cached rect UNCONDITIONALLY. A write can miss its target and still
    // RELOCATE the node (a setter that snaps or clamps): refreshing only on an
    // exact landing would leave that node's cached rect describing where it used
    // to be, and every geometric membership read afterwards — which prefers the
    // cached rect — would place it in the group it has actually left. The refresh
    // is a delta from the pre-write position, so it is correct wherever the node
    // ended up, including "did not move at all".
      // A rect that will not accept the correction makes the node STUCK, not an
      // exception: its live position and its cached rect would disagree, and
      // membership is rect-first, so leaving it "moved" would report it in a group
      // it is no longer in. refreshNodeArea never throws precisely so this decision
      // is made here rather than escaping past the caller's rollback. The verdict
      // is whether the rect ends up LIVE, not whether the delta-write happened: a
      // rect that was already right needs no write and is not stuck.
      refreshNodeArea(n, [px, py]);
      // panel#813 — A COLLAPSED MEMBER IS NOT A NODE THAT REFUSED TO MOVE.
      //
      // `nodeAreaIsLive` compares the cached rect against `wantedNodeArea`, which for a
      // collapsed node is the panel's PILL (`w = _collapsed_width || 80`, `h = 0`). The
      // engine's own `updateArea()` recompute — which `refreshNodeArea` above deliberately
      // TRUSTS as soon as it sees the origin move — writes the engine's extents instead. On
      // a collapsed node those two models disagree by construction, so the width comparison
      // failed for every collapsed member and the group move was refused AFTER their
      // positions had already been written. That is the report: four `size:[225,0]` nodes
      // called stuck, on a graph the reporter then repositioned one-by-one without trouble.
      //
      // So give the rect ONE MORE CHANCE to be put on the panel's convention before ruling,
      // using `syncNodeArea` — the very writer this move's own pre-flight
      // (`syncGraphNodeAreas`) already ran over every node moments earlier. Nothing new is
      // written that the pre-flight did not already write, and the forced value is the pill,
      // never the full box, so the #416 area-overstatement guarantee is untouched.
      //
      // THE #408 GUARD IS NOT RELAXED. A rect that genuinely cannot be corrected — frozen,
      // hostile accessor, disposed — makes `syncNodeArea` return false and the node is still
      // stuck, still refusing the whole move. That is the property #408 needs: membership is
      // rect-first, so a rect that cannot track its node would report it in a group it has
      // left. The question changes from "does the rect already agree" to "can the rect be
      // MADE to agree", which is the one the caller actually needs answered.
      //
      // TWO THINGS THE COLLAPSED CORRECTION IS DELIBERATELY NOT (both found in review):
      //
      // 1. IT IS NOT UNGATED. Only a COLLAPSED node gets the pill-force. An expanded
      //    node's `updateArea()` may authoritatively compute extents that legitimately
      //    differ from the generic `[x, y-30, size0, size1+30]` model — visible bounds
      //    that reach past `size`, on a custom node that draws outside its box. Forcing
      //    the generic footprint there would overwrite the engine's own answer and then
      //    report success, and rect-first membership would be wrong afterwards.
      //
      // 2. IT DOES NOT TRUST `syncNodeArea`'s OWN VERDICT ALONE. `boundingRect` can be an
      //    accessor whose getter returns a FRESH array on every read — a shape this file
      //    already documents for `pos` in `writePoint` ("a getter that returns a COPY, where
      //    an in-place write is silently dropped"). Against such a node `syncNodeArea`
      //    mutates and then verifies the throwaway copy it was handed, returns true, and the
      //    node's real rect never changed: the move would report the node moved while the
      //    next membership read still saw the old rect and dropped it from the group. So the
      //    verdict is re-read through `nodeAreaIsLive`, which fetches the property again.
      //
      // panel#1300 — AN EXPANDED MEMBER WITH CUSTOM EXTENTS IS NOT STUCK EITHER.
      //
      // The #813 review left expanded custom-extent nodes stuck rather than overwrite
      // their engine rect. That is the #1300 false refusal: `Label (rgthree)` (and any
      // decorative node that draws past `size`) lands the position write, `updateArea()`
      // shifts the origin by the same delta, and `nodeAreaIsLive` still fails because
      // width/height are not the generic model. `panel_edit_node` never asks that
      // question, so the same node moves fine one-by-one. The remedy is not to force
      // the generic footprint (that is the overwrite #813 correctly refused) — it is
      // to accept a rect whose ORIGIN tracked the move, extents and all.
      let isCollapsed = false;
      let flagsReadable = true;
      try {
        isCollapsed = !!n?.flags?.collapsed;
      } catch {
        // Unreadable flags ⇒ not eligible for the collapsed repair AND not eligible
        // for the #1300 origin-tracks path. We cannot tell a collapsed pill from a
        // custom-extent Label, so we cannot choose a verdict. Mutation reports
        // flipping this to `true` as a SURVIVOR, and it is an equivalent mutant rather
        // than a gap: `syncNodeArea` reads the same `flags` accessor through
        // `wantedNodeArea`, so it throws, is caught there, and returns false — the
        // node is stuck either way. Stated here so the next run does not re-chase
        // it; the BEHAVIOUR is pinned by "a node whose flags accessor THROWS is
        // stuck, not repaired".
        flagsReadable = false;
        isCollapsed = false;
      }
      if (isCollapsed) {
        if (!nodeAreaIsLive(n) && !(syncNodeArea(n) && nodeAreaIsLive(n))) {
          landedExactly = false;
        }
      } else if (!nodeAreaIsLive(n)) {
        if (!flagsReadable || !originReadable || !nodeAreaOriginTracks(n, originBefore, dx, dy)) {
          landedExactly = false;
        }
      }
    } catch {
      landedExactly = false;
    }
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
  // panel#813 — the VERDICT IS THE POSITION, not the cached rect.
  //
  // This used to return `ok && nodeAreaIsLive(n)`, which answers a different
  // question than the one the caller asks. `writePoint` already establishes the
  // thing that matters for a rollback: is the node back at the coordinates it
  // held before the move. `nodeAreaIsLive` asks whether the CACHED RECT agrees
  // with the node's live footprint — a separate property that can be false for
  // reasons entirely unrelated to this restore (a frozen/uncorrectable
  // boundingRect, or a rect stale from before the move ever started).
  //
  // Conflating them meant a node whose position was restored EXACTLY still
  // counted as unrestorable, and the caller reported "The graph is PARTIALLY
  // moved — N item(s) could NOT be put back" over a graph it had put back
  // perfectly. Verified directly against these functions: position restored to
  // its original coordinates, and still listed as failed. That is a false alarm
  // about data loss, told to a caller who cannot press Ctrl+Z — strictly worse
  // than saying nothing, because it implies damage that did not occur.
  //
  // The rect is still refreshed above (a stale rect would corrupt later
  // membership reads), and a rect that refuses correction is still caught where
  // it belongs — by the move's own pre-flight (syncGraphNodeAreas), which
  // refuses BEFORE any position is written. Nothing about rect health is lost;
  // it is simply no longer allowed to masquerade as a failed restore.
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
    // Per-item containment again: one unrestorable node must not stop the rest of
    // the rollback, and must be REPORTED rather than raised — a throw here would
    // replace the caller's carefully-worded refusal with a raw TypeError.
    let ok = false;
    try {
      ok = restoreNodePosition(n, px, py);
    } catch {
      ok = false;
    }
    if (!ok) failed.push(n);
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
  // Total, like every other guard here. groupBoundsOf is safe, but the follow-up
  // `g._bounding` read is a second touch of the same accessor — and this runs as
  // the verification step of a box write, AFTER the children have moved and
  // BEFORE the rollback. A throw there would escape the transaction through the
  // very check that exists to keep it honest.
  try {
    const after = groupBoundsOf(g);
    if (!after) return false;
    const f32 = isFloat32(g?._bounding);
    if (!samePoint(after[0], x, f32) || !samePoint(after[1], y, f32)) return false;
    if (w != null && !samePoint(after[2], w, f32)) return false;
    if (h != null && !samePoint(after[3], h, f32)) return false;
    return true;
  } catch {
    return false; // cannot be shown to be there ⇒ treated as not there
  }
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
 * not make. NEVER THROWS: even READING `owner[key]` can raise (a revoked Proxy,
 * a disposed accessor), and a write helper that raises would defeat every caller
 * that guards on its return value.
 */
export function writePoint(owner, key, x, y) {
  const landed = () => {
    try {
      const point = owner?.[key];
      const f32 = isFloat32(point);
      return samePoint(Number(point?.[0]), x, f32) && samePoint(Number(point?.[1]), y, f32);
    } catch {
      return false; // unreadable ⇒ cannot be shown to have landed
    }
  };
  const assign = () => {
    try {
      owner[key] = [x, y];
    } catch {
      /* accessor with no setter — strict-mode assignment throws */
    }
  };
  const inPlace = () => {
    try {
      const point = owner?.[key];
      if (!point || point.length < 2) return;
      point[0] = x;
      point[1] = y;
    } catch {
      /* frozen/read-only point, or an unreadable container */
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
 *  accessors on the class prototype, not on each instance.
 *
 *  Inspection is itself an operation that can fail: getPrototypeOf and
 *  getOwnPropertyDescriptor both THROW on a revoked Proxy. Falling back to
 *  "no setter" only picks the write ORDER, and writePoint tries the other way
 *  round anyway and verifies — so a failed inspection costs nothing and must not
 *  be allowed to raise out of a decision function. */
function hasSetter(owner, key) {
  try {
    for (let o = owner; o != null; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, key);
      if (d) return typeof d.set === "function";
    }
  } catch {
    /* uninspectable ⇒ treat as a data property; writePoint still tries both */
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
    // Same rule as reroutesInside: a box we cannot read is UNKNOWN, not "outside".
    // It rides along so it is classified stuck and the move is refused, rather
    // than being quietly left behind by a move that reports success.
    if (!inner) return !groupHasReadableBounds(other);
    return containsBounds(outer, inner);
  });
}

/** Could we read this group's geometry at all? Distinguishes "no usable bounds"
 *  (a well-formed object we can inspect) from "unreadable" (a hostile accessor). */
function groupHasReadableBounds(g) {
  try {
    void g?._bounding;
    void g?.pos?.[0];
    void g?.size?.[0];
    return true;
  } catch {
    return false;
  }
}

/**
 * Translate a group's box by (dx, dy), writing through whichever geometry the
 * build exposes — the `_bounding` quad (plain OR typed array, mutated in place)
 * or the pos/size pair — and REPORT whether the box actually ended up there.
 * Mirrors the panel's setGroupBounds write policy.
 */
export function placeGroupBox(g, x, y) {
  try {
    return placeGroupBoxUnsafe(g, x, y);
  } catch {
    return false; // never raised out of a move or its rollback
  }
}

function placeGroupBoxUnsafe(g, x, y) {
  // Write into the container the READ will come back from. Picking `_bounding`
  // merely because it has length 4 is how a malformed quad captured the write
  // while groupBoundsOf fell through to pos/size: this writes only x/y, so the
  // quad stays malformed, the read still returns the unchanged pos/size, and a
  // perfectly movable group is reported as refusing to move. groupBoundsTarget is
  // the one rule both sides ask.
  //
  // A move must not change the SIZE either — captured first and verified, so a
  // build that resizes on reposition is reported as not-moved rather than
  // silently reshaping the user's group.
  const target = groupBoundsTarget(g);
  if (!target) return false;
  const before = target.bounds;
  if (target.kind === "bounding") {
    const b = g._bounding;
    try {
      b[0] = x;
      b[1] = y;
    } catch {
      /* frozen quad — verified below */
    }
  } else {
    writePoint(g, "pos", x, y);
  }
  return groupBoxIsAt(g, x, y, before[2], before[3]);
}

export function translateGroupBox(g, dx, dy) {
  const before = groupBoundsOf(g);
  if (!before) return false;
  return placeGroupBox(g, before[0] + dx, before[1] + dy);
}

/**
 * Restore a group's FULL box — corner and size — and report whether it is really
 * back. placeGroupBox writes only the corner, which is right for a move but wrong
 * for an undo: if the forward write reshaped the box on the way through, putting
 * the corner back leaves the wrong size behind while the caller announces that
 * nothing was moved.
 */
function restoreGroupBox(g, quad) {
  const [x, y, w, h] = quad;
  try {
    // Unlike a translate, a restore writes all four components — so it can also
    // REPAIR a quad the forward pass left malformed. Write the quad when the
    // build has one at all (length 4 is enough here precisely because nothing is
    // left half-written), else the pos/size pair.
    const b = g?._bounding;
    if (b && b.length >= 4) {
      try {
        b[0] = x;
        b[1] = y;
        b[2] = w;
        b[3] = h;
      } catch {
        /* frozen quad — verified below */
      }
    } else {
      writePoint(g, "pos", x, y);
      writePoint(g, "size", w, h);
    }
    return groupBoxIsAt(g, x, y, w, h);
  } catch {
    return false; // a rollback reports, it never raises
  }
}

/** Translate several group boxes, reporting which ones actually moved and
 *  handing back an ABSOLUTE undo (see restoreNodePositions for why the inverse
 *  delta is not good enough). */
export function translateGroupBoxes(groups, dx, dy) {
  const moved = [];
  const stuck = [];
  const attempted = [];
  for (const g of groups ?? []) {
    let before = null;
    try {
      before = groupBoundsOf(g);
    } catch {
      /* unreadable bounds ⇒ stuck below */
    }
    if (!before) {
      if (g) stuck.push(g);
      continue;
    }
    attempted.push([g, before]);
    (placeGroupBox(g, before[0] + dx, before[1] + dy) ? moved : stuck).push(g);
  }
  return {
    moved,
    stuck,
    /** Returns the boxes that could NOT be put back. */
    undo: () => attempted.filter(([g, quad]) => !restoreGroupBox(g, quad)).map(([g]) => g),
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
    // Three cases, and only one of them is "outside":
    //  - the position cannot be READ at all (hostile/disposed accessor), or it is
    //    present but not finite ⇒ UNKNOWN. Unknown is not "outside": include it so
    //    it goes down the same path as any other item that will not accept a new
    //    position — reported stuck, whole move refused — rather than being quietly
    //    dropped while the group moves away from it.
    //  - no `pos` at all ⇒ not a positioned item; there is nothing to move and
    //    nothing to be wrong about.
    let pos;
    try {
      pos = r?.pos;
    } catch {
      return true;
    }
    if (pos == null || pos.length < 2) return false;
    let px;
    let py;
    try {
      px = Number(pos[0]);
      py = Number(pos[1]);
    } catch {
      return true;
    }
    if (!Number.isFinite(px) || !Number.isFinite(py)) return true;
    return px >= x && px < x + w && py >= y && py < y + h;
  });
}

/**
 * Can this reroute be repositioned SOUNDLY? A pure read — safe to call as a
 * pre-flight, before anything has been mutated.
 *
 * We must never learn what a build's `Reroute.move()` means by CALLING it. An
 * earlier version invoked `move(x - cx, y - cy)` assuming a relative API and then
 * "corrected" `r.pos` if the point ended up somewhere else. On a build where
 * `move(x, y)` is ABSOLUTE and also writes a reactive/persisted store, that
 * sequence is silent corruption: a reroute at [100,100] targeting [200,200] gets
 * move(100,100), the STORE records [100,100], the fallback fixes only the in-place
 * `pos` array to [200,200], verification passes, success is reported — and the
 * next render or save resurrects the wrong coordinate. Arity cannot tell the two
 * signatures apart, and a "no-op probe" of move(0,0) is a teleport on the absolute
 * build. There is no non-destructive way to find out, so we do not try.
 *
 * What IS sound is writing `pos` when that is an accessor: the setter is the
 * engine's own write path (current @comfyorg/litegraph defines `Reroute.pos` as a
 * get/set pair over its own Float64Array), so any store bookkeeping runs, with no
 * guess about anyone's signature. When `pos` is a plain slot AND the build also
 * exposes a `move()` we cannot characterise, the honest answer is "unknown": the
 * reroute is reported stuck and the whole move is refused with a remedy, rather
 * than moved on a coin-flip whose failure mode only shows up at save time.
 */
export function rerouteWriteIsSound(r) {
  try {
    if (hasSetter(r, "pos")) return true;
    // `typeof r.move` RUNS a getter, and a getter that throws would raise out of
    // the very inspection whose whole job is to decide without side effects. A
    // reroute we cannot even inspect is exactly the "unknown" this refuses on.
    return typeof r?.move !== "function";
  } catch {
    return false;
  }
}

/**
 * Put a reroute point at (x, y) and report whether it is really there. Only ever
 * writes `pos` — see rerouteWriteIsSound for why `move()` is never invoked.
 */
export function placeReroute(r, x, y) {
  // Never throws: it runs inside a group move (and inside that move's rollback),
  // so a hostile accessor must be reported as "did not move", not raised.
  try {
    if (!rerouteWriteIsSound(r)) return false;
    return writePoint(r, "pos", x, y);
  } catch {
    return false;
  }
}

/**
 * Snapshot every node position, every other group box, and every reroute on
 * the graph, then put them back. A box-only bounds write must not be a group
 * drag (#1306): some frontends couple `pos` / `_bounding` writes to
 * LGraphGroup.move(), which translates the cached `_children` set.
 *
 * The snapshot is the WHOLE graph, not just current geometric members. A stale
 * `_children` cache can still include nodes that have left the box, and those
 * would ride along if we only pinned the live members.
 *
 * NEVER THROWS. Restore is best-effort per item — one unrestorable node must
 * not stop the rest, and must not replace the caller's stated outcome with a
 * raw TypeError.
 */
export function holdGraphItemPositions(graph, exceptGroup) {
  const nodeSnap = [];
  try {
    for (const n of graph?._nodes ?? []) {
      try {
        const x = Number(n?.pos?.[0]);
        const y = Number(n?.pos?.[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) nodeSnap.push([n, x, y]);
      } catch {
        /* unreadable node — skip */
      }
    }
  } catch {
    /* walk failed — restore what we captured */
  }

  const groupSnap = [];
  try {
    for (const other of graph?._groups ?? []) {
      if (!other || other === exceptGroup) continue;
      try {
        const b = groupBoundsOf(other);
        if (b) groupSnap.push([other, b]);
      } catch {
        /* unreadable box — skip */
      }
    }
  } catch {
    /* walk failed */
  }

  const rerouteSnap = [];
  try {
    for (const r of allReroutes(graph)) {
      try {
        const x = Number(r?.pos?.[0]);
        const y = Number(r?.pos?.[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) rerouteSnap.push([r, x, y]);
      } catch {
        /* unreadable reroute — skip */
      }
    }
  } catch {
    /* walk failed */
  }

  return {
    restore() {
      restoreNodePositions(nodeSnap);
      for (const [g, quad] of groupSnap) {
        try {
          restoreGroupBox(g, quad);
        } catch {
          /* never raise from a restore */
        }
      }
      for (const [r, x, y] of rerouteSnap) {
        try {
          placeReroute(r, x, y);
        } catch {
          /* never raise from a restore */
        }
      }
    },
  };
}

/**
 * Translate reroute points by (dx, dy), reporting which ones actually moved.
 * Without this a moved group leaves its wire elbows behind and the links visibly
 * snake back to where the group used to be.
 */
export function moveReroutePoints(reroutes, dx, dy) {
  const moved = [];
  const stuck = [];
  const attempted = [];
  for (const r of reroutes ?? []) {
    let px = Number.NaN;
    let py = Number.NaN;
    try {
      px = Number(r?.pos?.[0]);
      py = Number(r?.pos?.[1]);
    } catch {
      /* unreadable point ⇒ stuck below */
    }
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
