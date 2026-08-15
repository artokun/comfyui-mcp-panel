/**
 * layout-engine.js — pure, dependency-free dependency-aware node layout.
 *
 * This module is a self-contained port of the FL-MCP `layout_engine.js` core
 * (DFS topological sort, depth = max(input depths) + 1, cumulative column
 * widths) with four fixes layered on top:
 *
 *   1. Reroute awareness — a Reroute node inherits `depth(input) + 0.5` in a
 *      slim half-column and is centered between its endpoints, so reroute
 *      chains don't double the horizontal span.
 *   2. Barycenter ordering — within each column, nodes are ordered by the mean
 *      row-index of their upstream neighbours, cutting link crossings.
 *   3. Subset overlap resolution — the laid-out block anchors at its original
 *      bounding-box top-left, then a single vertical push-apart pass shifts the
 *      WHOLE block below any collision with untouched `obstacles` (which are
 *      never moved).
 *   4. Clusters — `opts.clusters` collapses a set of member nodes into a single
 *      rigid super-node; members translate rigidly by the super-node delta.
 *
 * It is intentionally free of any ComfyUI / LiteGraph imports (unlike FL-MCP's
 * `import { app } from ".../app.js"`) so it can be unit-tested under plain
 * `node --test` and can never break ComfyUI's extension loader with side
 * effects. The panel bundle imports `computeLayout` and feeds it a plain
 * snapshot built from the live graph.
 *
 * @module layout-engine
 */

/** Base GAPS between nodes (not including node size), before the multiplier. */
export const BASE_GAP = Object.freeze({ h: 50, v: 30 });

const VALID_MODES = new Set(["flow_horizontal", "flow_vertical", "grid"]);

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** A node is a reroute if it is explicitly flagged or is a LiteGraph Reroute. */
function isReroute(n) {
  return n.reroute === true || n.type === "Reroute";
}

function normalizeNode(n) {
  return {
    id: n.id,
    type: n.type ?? null,
    x: Number.isFinite(n.x) ? Number(n.x) : 0,
    y: Number.isFinite(n.y) ? Number(n.y) : 0,
    width: Number.isFinite(n.width) && n.width > 0 ? Number(n.width) : 200,
    height: Number.isFinite(n.height) && n.height > 0 ? Number(n.height) : 100,
    pinned: !!n.pinned,
    collapsed: !!n.collapsed,
    reroute: isReroute(n),
  };
}

/** Axis-aligned bounding box [x, y, w, h] wrapping the given nodes. */
function bboxOf(nodes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function avg(list) {
  if (!list.length) return 0;
  let s = 0;
  for (const v of list) s += v;
  return s / list.length;
}

/**
 * Compute non-overlapping positions for a graph snapshot.
 *
 * @param {object} snapshot
 * @param {Array<{id:*,type?:string,x:number,y:number,width:number,height:number,pinned?:boolean,collapsed?:boolean,reroute?:boolean}>} snapshot.nodes
 *        Candidate nodes to lay out. Pinned nodes are reported in `skipped` and
 *        never moved.
 * @param {Array<{from:*,to:*}>} [snapshot.edges]  Directed edges (data flow).
 * @param {Array<{id:*,memberIds:*[],bounds?:*,collapsed?:boolean}>} [snapshot.groups]
 *        Present for parity with the executor; unused by the engine directly
 *        (grouping arrives as `opts.clusters`).
 * @param {object} [opts]
 * @param {"flow_horizontal"|"flow_vertical"|"grid"} [opts.mode="flow_horizontal"]
 * @param {number} [opts.spacing=1] 0.25–4 multiplier on {@link BASE_GAP}.
 * @param {"start"|"center"} [opts.align="start"] Cross-axis alignment.
 * @param {"bbox"|"origin"|[number,number]} [opts.anchor="bbox"] Where the moved
 *        block's top-left lands.
 * @param {Array<{id:*,memberIds:*[]}>} [opts.clusters] Rigid super-nodes.
 * @param {Array<{x:number,y:number,width:number,height:number}>} [opts.obstacles]
 *        Untouched node boxes the moved block must not overlap (push-apart).
 * @returns {{positions: Map<*,[number,number]>, columns: number, skipped: Array<{node_id:*,reason:string}>, columnOf: Map<*,number>}}
 */
export function computeLayout(snapshot, opts = {}) {
  const mode = opts.mode || "flow_horizontal";
  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `Unknown layout mode "${mode}" (flow_horizontal | flow_vertical | grid)`,
    );
  }
  const spacing = clamp(opts.spacing ?? 1, 0.25, 4);
  const align = opts.align === "center" ? "center" : "start";
  const gap = { h: BASE_GAP.h * spacing, v: BASE_GAP.v * spacing };

  const skipped = [];
  const movable = [];
  for (const raw of snapshot.nodes ?? []) {
    const n = normalizeNode(raw);
    if (n.pinned) skipped.push({ node_id: n.id, reason: "pinned" });
    else movable.push(n);
  }

  const positions = new Map();
  const columnOf = new Map();
  if (movable.length === 0) {
    return { positions, columns: 0, skipped, columnOf };
  }

  const nodeById = new Map(movable.map((n) => [n.id, n]));

  // ---- Build layout UNITS (single nodes + rigid clusters) -----------------
  const clusterOf = new Map(); // nodeId -> unit id
  const units = [];
  const unitById = new Map();

  for (const cl of opts.clusters ?? []) {
    const members = (cl.memberIds ?? [])
      .map((id) => nodeById.get(id))
      .filter(Boolean);
    if (!members.length) continue;
    const bb = bboxOf(members);
    const uid = `cluster:${cl.id}`;
    const unit = {
      id: uid,
      isCluster: true,
      members,
      width: bb.w,
      height: bb.h,
      origX: bb.x,
      origY: bb.y,
      reroute: false,
      x: 0,
      y: 0,
    };
    units.push(unit);
    unitById.set(uid, unit);
    for (const m of members) clusterOf.set(m.id, uid);
  }
  for (const n of movable) {
    if (clusterOf.has(n.id)) continue;
    const unit = {
      id: n.id,
      isCluster: false,
      members: [n],
      width: n.width,
      height: n.height,
      origX: n.x,
      origY: n.y,
      reroute: n.reroute,
      x: 0,
      y: 0,
    };
    units.push(unit);
    unitById.set(n.id, unit);
  }

  const unitIdForNode = (nodeId) =>
    clusterOf.has(nodeId)
      ? clusterOf.get(nodeId)
      : nodeById.has(nodeId)
        ? nodeId
        : undefined;

  // ---- Edges between units (dedup, drop self + non-movable endpoints) ------
  const inputs = new Map(units.map((u) => [u.id, []]));
  const seenEdge = new Set();
  for (const e of snapshot.edges ?? []) {
    const fu = unitIdForNode(e.from);
    const tu = unitIdForNode(e.to);
    if (fu === undefined || tu === undefined || fu === tu) continue;
    // JSON-encoded, not delimiter-joined. This key used to be built with a literal
    // NUL separator, which made git treat the whole file as BINARY (no reviewable
    // diff); a "|" join fixes that but is not injective — node ids are arbitrary
    // strings, so ("a|b","c") and ("a","b|c") would dedup to one edge and silently
    // drop a real layout constraint. Encoding the boundary removes both problems.
    const key = JSON.stringify([String(fu), String(tu)]);
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    inputs.get(tu).push(fu);
  }
  const hasEdges = seenEdge.size > 0;

  // Axis abstraction: "main" = the flow axis (columns), "cross" = stacking.
  const horizontal = mode !== "flow_vertical"; // grid handled separately below
  const levelSize = (u) => (horizontal ? u.width : u.height);
  const stackSize = (u) => (horizontal ? u.height : u.width);
  const origCross = (u) => (horizontal ? u.origY : u.origX);
  const mainGap = horizontal ? gap.h : gap.v;
  const crossGap = horizontal ? gap.v : gap.h;

  if (mode === "grid") {
    layoutGrid(units, gap);
    for (const u of units) columnOf.set(u.id, u._gridCol ?? 0);
  } else {
    // ---- Depth (column) assignment ----------------------------------------
    const depth = new Map();
    if (!hasEdges) {
      // No-edge fallback: a flat sequence, one unit per column, so nothing
      // piles into column 0 (FL-MCP's documented all-in-column-0 pitfall).
      const ordered = units
        .slice()
        .sort((a, b) => origCross(a) - origCross(b) || cmpId(a.id, b.id));
      ordered.forEach((u, i) => depth.set(u.id, i));
    } else {
      const inProgress = new Set();
      const dep = (uid) => {
        if (depth.has(uid)) return depth.get(uid);
        if (inProgress.has(uid)) return 0; // cycle: break with depth 0
        inProgress.add(uid);
        const ins = inputs.get(uid) ?? [];
        let base = -1;
        for (const iu of ins) base = Math.max(base, dep(iu));
        const u = unitById.get(uid);
        let d;
        if (ins.length === 0) d = 0;
        else d = u.reroute ? base + 0.5 : base + 1;
        inProgress.delete(uid);
        depth.set(uid, d);
        return d;
      };
      for (const u of units) dep(u.id);
    }

    // Distinct depth values -> ordered level indices (reroute half-columns
    // sit between integer columns).
    const sortedDepths = [...new Set(depth.values())].sort((a, b) => a - b);
    const levelIndex = new Map(sortedDepths.map((d, i) => [d, i]));
    const levelUnits = sortedDepths.map(() => []);
    for (const u of units) {
      const li = levelIndex.get(depth.get(u.id));
      levelUnits[li].push(u);
      columnOf.set(u.id, li);
    }

    // ---- Barycenter ordering within each column ---------------------------
    const rowIndex = new Map();
    for (let li = 0; li < levelUnits.length; li++) {
      const arr = levelUnits[li];
      if (li === 0) {
        arr.sort((a, b) => origCross(a) - origCross(b) || cmpId(a.id, b.id));
      } else {
        const bary = new Map();
        for (const u of arr) {
          const idxs = (inputs.get(u.id) ?? [])
            .map((iu) => rowIndex.get(iu))
            .filter((v) => v != null);
          bary.set(u.id, idxs.length ? avg(idxs) : Number.POSITIVE_INFINITY);
        }
        arr.sort(
          (a, b) =>
            bary.get(a.id) - bary.get(b.id) ||
            origCross(a) - origCross(b) ||
            cmpId(a.id, b.id),
        );
      }
      arr.forEach((u, i) => rowIndex.set(u.id, i));
    }

    // ---- Main-axis (column) offsets ---------------------------------------
    const levelMain = [];
    let m = 0;
    for (let li = 0; li < levelUnits.length; li++) {
      levelMain[li] = m;
      let thickness = 0;
      for (const u of levelUnits[li]) thickness = Math.max(thickness, levelSize(u));
      const isRerouteLevel = levelUnits[li].every((u) => u.reroute);
      m += thickness + (isRerouteLevel ? mainGap / 2 : mainGap);
    }

    // ---- Cross-axis (stacking) positions ----------------------------------
    for (let li = 0; li < levelUnits.length; li++) {
      const arr = levelUnits[li];
      let total = 0;
      for (const u of arr) total += stackSize(u);
      total += crossGap * Math.max(0, arr.length - 1);
      let c = align === "center" ? -total / 2 : 0;
      for (const u of arr) {
        setUnitPos(u, horizontal, levelMain[li], c);
        c += stackSize(u) + crossGap;
      }
    }

    // ---- Reroute vertical centering between endpoints ---------------------
    // Done after stacking so neighbour centers are known. Reroutes are slim and
    // typically alone in their half-column, so re-centering rarely collides.
    for (const u of units) {
      if (!u.reroute) continue;
      const neighbours = [];
      for (const iu of inputs.get(u.id) ?? []) neighbours.push(unitById.get(iu));
      for (const other of units) {
        if ((inputs.get(other.id) ?? []).includes(u.id)) neighbours.push(other);
      }
      const centers = neighbours
        .filter(Boolean)
        .map((nb) => crossCenter(nb, horizontal));
      if (!centers.length) continue;
      const target = avg(centers) - stackSize(u) / 2;
      if (horizontal) u.y = target;
      else u.x = target;
    }
  }

  // ---- Anchor the moved block -------------------------------------------
  const raw = unitsBBox(units);
  const anchor = resolveAnchor(opts.anchor, movable);
  let dx = anchor[0] - raw.x;
  let dy = anchor[1] - raw.y;
  for (const u of units) {
    u.x += dx;
    u.y += dy;
  }

  // ---- Subset overlap resolution (push the block down past obstacles) -----
  const obstacles = opts.obstacles ?? [];
  if (obstacles.length) {
    const block = unitsBBox(units);
    let shift = 0;
    for (const ob of obstacles) {
      const oy = Number(ob.y) || 0;
      const ox = Number(ob.x) || 0;
      const ow = Number(ob.width) || 0;
      const oh = Number(ob.height) || 0;
      const overlapsX = block.x < ox + ow && block.x + block.w > ox;
      const overlapsY = block.y < oy + oh && block.y + block.h > oy;
      if (overlapsX && overlapsY) shift = Math.max(shift, oy + oh - block.y);
    }
    if (shift > 0) for (const u of units) u.y += shift;
  }

  // ---- Expand units -> per-node positions --------------------------------
  for (const u of units) {
    if (u.isCluster) {
      const cdx = u.x - u.origX;
      const cdy = u.y - u.origY;
      for (const mNode of u.members) {
        positions.set(mNode.id, [
          Math.round(mNode.x + cdx),
          Math.round(mNode.y + cdy),
        ]);
        columnOf.set(mNode.id, columnOf.get(u.id) ?? 0);
      }
    } else {
      positions.set(u.members[0].id, [Math.round(u.x), Math.round(u.y)]);
    }
  }

  const columns =
    mode === "grid"
      ? Math.max(...[...columnOf.values(), 0]) + 1
      : new Set([...columnOf.values()].filter((v) => Number.isInteger(v))).size;

  return { positions, columns, skipped, columnOf };
}

// ---- helpers --------------------------------------------------------------

function cmpId(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function setUnitPos(u, horizontal, main, cross) {
  if (horizontal) {
    u.x = main;
    u.y = cross;
  } else {
    u.x = cross;
    u.y = main;
  }
}

function crossCenter(u, horizontal) {
  return horizontal ? u.y + u.height / 2 : u.x + u.width / 2;
}

function unitsBBox(units) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const u of units) {
    minX = Math.min(minX, u.x);
    minY = Math.min(minY, u.y);
    maxX = Math.max(maxX, u.x + u.width);
    maxY = Math.max(maxY, u.y + u.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function resolveAnchor(anchor, movable) {
  if (Array.isArray(anchor) && anchor.length === 2) {
    return [Number(anchor[0]) || 0, Number(anchor[1]) || 0];
  }
  if (anchor === "origin") return [0, 0];
  // "bbox" (default): keep the moved set's original top-left in place.
  const bb = bboxOf(movable);
  return [bb.x, bb.y];
}

/** Grid layout: ceil(sqrt(n)) columns of uniform cells, edges ignored. */
function layoutGrid(units, gap) {
  const n = units.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  let cw = 0;
  let ch = 0;
  for (const u of units) {
    cw = Math.max(cw, u.width);
    ch = Math.max(ch, u.height);
  }
  const ordered = units
    .slice()
    .sort((a, b) => a.origY - b.origY || a.origX - b.origX || cmpId(a.id, b.id));
  ordered.forEach((u, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    u.x = col * (cw + gap.h);
    u.y = row * (ch + gap.v);
  });
  // Tag a "column" per unit for reporting parity with flow modes.
  ordered.forEach((u, i) => {
    u._gridCol = i % cols;
  });
}
