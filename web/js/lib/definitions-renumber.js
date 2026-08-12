/**
 * comfyui-mcp-panel#886 — `panel_open_workflow` reported an UNCONFIRMED failure even
 * though the binding was correct.
 *
 * Measured on the rig: loading a persisted workflow REGENERATES link identity inside
 * `definitions.subgraphs` (`state.lastLinkId` 2092 -> 2106) without changing anything
 * a user would call a difference. The binding check saw the `definitions` surface
 * differ and refused, so a correct binding was reported as unproven.
 *
 * ## The danger this file has to respect
 *
 * This predicate feeds the guard that decides whether the panel's graph writes are
 * allowed to land. Its two error directions are NOT symmetric:
 *
 *   - too strict  -> a false refusal. Annoying, recoverable, visible.
 *   - too lenient -> writes applied to the WRONG graph. Silent, and destroys work.
 *
 * A first version of this file was refused by review for being too lenient in exactly
 * that way: it waived whole fields (`links`, `inputs`, `outputs`) without comparing
 * them, so a re-wired link or a renamed subgraph port read as "only renumbering". Two
 * P0s. Everything below is written to fail CLOSED — anything it cannot fully account
 * for returns false, which the caller reads as "not proven", never as "changed".
 *
 * ## What renumbering actually is
 *
 * Link IDS are reassigned; link TOPOLOGY is not. So a difference is renumbering only if
 * every link still connects the same origin node+slot to the same target node+slot, in
 * the same quantity — and every other surface is byte-identical. Identity is compared
 * by POSITION-INDEPENDENT endpoint signature, never by id.
 */

/** Fields inside a subgraph definition that renumbering may touch AT ALL. Anything
 *  outside this set must be deep-equal. `inputs`/`outputs` are deliberately NOT here:
 *  they are the subgraph's interface ports, and renaming or retyping one is a semantic
 *  change to the graph (review found the earlier version waving them through). */
const RENUMBER_FIELDS = new Set(["links", "state", "nodes"]);

/** The `state` counters renumbering may advance. Everything else in `state` is
 *  structural (how many nodes/groups the subgraph has ever had) and must match. */
const RENUMBER_STATE_KEYS = new Set(["lastLinkId", "lastRerouteId"]);

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Deep equality that cannot throw and cannot recurse forever.
 *
 * The earlier version compared with `JSON.stringify`, which throws on a cyclic
 * structure — turning a "not proven" answer into an exception on the guard path.
 * Depth-bounded, cycle-aware, and key-order independent.
 */
function deepEqual(a, b, seen = new Set(), depth = 0) {
  if (a === b) return true;
  // Cycles are caught by `seen` below; this bound only stops pathological nesting from
  // blowing the stack. 64 was too tight — review noted a legitimately deep but acyclic
  // definition (nested widgets_values) would compare false and cause a FALSE REFUSAL on
  // a valid large workflow. Raised well past anything a real graph produces.
  if (depth > 512) return false;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  // A cycle on either side means we cannot decide; fail closed rather than loop.
  if (seen.has(a) || seen.has(b)) return false;
  seen.add(a);
  seen.add(b);
  try {
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      return a.every((v, i) => deepEqual(v, b[i], seen, depth + 1));
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k], seen, depth + 1),
    );
  } finally {
    seen.delete(a);
    seen.delete(b);
  }
}

/** Same keys, and every key outside `allowed` deep-equal. */
function differsOnlyIn(a, b, allowed) {
  if (!isObj(a) || !isObj(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (allowed.has(k)) continue;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * A link's ENDPOINTS, ignoring its id.
 *
 * Litegraph serializes a link as either an array
 * `[id, originId, originSlot, targetId, targetSlot, type]` or an object. Both shapes
 * appear across frontend versions, so both are read; an unrecognised shape returns
 * null, which fails the comparison closed.
 */
function linkEndpoints(link) {
  // JSON of a TUPLE, not a delimiter-joined string. Review found the delimiter form
  // collides: origin ("a:0>b", "c") and origin ("a", "0>b:c") both render as
  // `a:0>b:c`, so two distinct wirings compared equal — on the guard that decides
  // whether writes land. A tuple cannot be reassociated.
  //
  // Wrapped because it must never THROW on a hostile shape: an id like
  // { toString: null, valueOf: null } makes String() throw, and an exception here
  // would escape the guard instead of failing closed. null means "cannot read",
  // which the caller treats as not-proven.
  const encode = (parts) => {
    try {
      return JSON.stringify(parts);
    } catch {
      return null;
    }
  };
  if (Array.isArray(link)) {
    if (link.length < 5) return null;
    const [, oId, oSlot, tId, tSlot, type] = link;
    return encode([oId, oSlot, tId, tSlot, type ?? null]);
  }
  if (isObj(link)) {
    const o = link.origin_id ?? link.originId;
    const os = link.origin_slot ?? link.originSlot;
    const t = link.target_id ?? link.targetId;
    const ts = link.target_slot ?? link.targetSlot;
    if (o === undefined || t === undefined) return null;
    return encode([o, os ?? null, t, ts ?? null, link.type ?? null]);
  }
  return null;
}

/**
 * Do two link collections describe the SAME wiring, differing only in ids?
 *
 * Compared as multisets of endpoint signatures, so order is irrelevant and a duplicate
 * connection is not silently collapsed. Any link whose shape cannot be read fails the
 * whole comparison — this is the surface the earlier version waived entirely, and it is
 * where a re-wire would hide.
 */
function linksDifferOnlyById(a, b) {
  const listA = Array.isArray(a) ? a : a == null ? [] : null;
  const listB = Array.isArray(b) ? b : b == null ? [] : null;
  if (listA === null || listB === null) return false;
  if (listA.length !== listB.length) return false;
  const count = (list) => {
    const m = new Map();
    for (const l of list) {
      const sig = linkEndpoints(l);
      if (sig === null) return null;
      m.set(sig, (m.get(sig) ?? 0) + 1);
    }
    return m;
  };
  const ma = count(listA);
  const mb = count(listB);
  if (!ma || !mb || ma.size !== mb.size) return false;
  for (const [sig, n] of ma) if (mb.get(sig) !== n) return false;
  return true;
}

/** Identity of a node inside a definition. Requires BOTH id and type: a node missing
 *  either cannot be matched, and guessing would let an unmatched node pass. */
function nodeKey(n) {
  const id = n?.id;
  const type = n?.type;
  if (id === undefined || id === null) return null;
  if (typeof type !== "string" || !type) return null;
  return `${typeof id}:${String(id)}|${type}`;
}

/**
 * Index nodes by identity, refusing on duplicates.
 *
 * The earlier version built a Map and let a later entry overwrite an earlier one, so
 * two nodes sharing a key could hide a change in the one that was overwritten (review).
 * A duplicate key means the set is not addressable, so the answer is "cannot tell".
 */
function indexNodes(list) {
  if (!Array.isArray(list)) return null;
  const m = new Map();
  for (const n of list) {
    const k = nodeKey(n);
    if (k === null || m.has(k)) return null;
    m.set(k, n);
  }
  return m;
}

/** Nodes match as a set, and each node differs at most in the link ids its slots
 *  reference. Slot COUNTS and every non-link field must be identical. */
function nodesDifferOnlyInLinkRefs(a, b) {
  const ia = indexNodes(a);
  const ib = indexNodes(b);
  if (!ia || !ib || ia.size !== ib.size) return false;
  // ORDER matters, and review was right to insist: LiteGraph node order can carry
  // execution and draw ordering, so a reordered array is not the same subgraph. Set
  // equality alone would have accepted it. Renumbering does not reorder nodes — the
  // measured case preserves order exactly — so requiring it costs nothing real and
  // closes a way for a different graph to pass.
  const ka = [...ia.keys()];
  const kb = [...ib.keys()];
  if (ka.some((k, i) => k !== kb[i])) return false;
  for (const [k, na] of ia) {
    const nb = ib.get(k);
    if (!nb) return false;
    if (!differsOnlyIn(na, nb, new Set(["inputs", "outputs"]))) return false;
    // Slot arrays may differ ONLY in the link ids they carry.
    for (const side of ["inputs", "outputs"]) {
      const sa = na[side];
      const sb = nb[side];
      if (sa == null && sb == null) continue;
      if (!Array.isArray(sa) || !Array.isArray(sb) || sa.length !== sb.length) return false;
      for (let i = 0; i < sa.length; i += 1) {
        if (!differsOnlyIn(sa[i], sb[i], new Set(["link", "links", "_layoutElement"]))) return false;
        // The link REFERENCES may be renumbered, but their COUNT may not change:
        // a slot that gained or lost a connection is a re-wire, not a renumber.
        const la = sa[i]?.links;
        const lb = sb[i]?.links;
        if (Array.isArray(la) !== Array.isArray(lb)) return false;
        if (Array.isArray(la) && la.length !== lb.length) return false;
        const oneA = sa[i]?.link;
        const oneB = sb[i]?.link;
        if ((oneA == null) !== (oneB == null)) return false;
      }
    }
  }
  return true;
}

/** One subgraph definition, compared. */
function definitionDiffersOnlyByRenumber(a, b) {
  if (!isObj(a) || !isObj(b)) return false;
  if (!differsOnlyIn(a, b, RENUMBER_FIELDS)) return false;
  if (!linksDifferOnlyById(a.links, b.links)) return false;
  if (!nodesDifferOnlyInLinkRefs(a.nodes ?? [], b.nodes ?? [])) return false;
  if (!differsOnlyIn(a.state ?? {}, b.state ?? {}, RENUMBER_STATE_KEYS)) return false;
  return true;
}

/**
 * Do two `definitions` blocks differ ONLY by link renumbering?
 *
 * Returns false for anything it cannot fully account for. The caller reads false as
 * "not proven" and refuses — which is the safe direction.
 */
export function definitionsDifferOnlyByLinkRenumber(a, b) {
  // ONE guard at the boundary, rather than one per risky call. Review found throws
  // escaping from places the inner wrappers did not cover — Object.keys on a Proxy
  // whose ownKeys trap throws, a throwing property getter, a link Proxy read before
  // the JSON encode. Chasing each site is a losing game: the honest statement is that
  // NOTHING in here may escape, because an exception on this path takes out the guard
  // that decides whether writes land instead of answering "not proven".
  try {
    return compareDefinitions(a, b);
  } catch {
    return false;
  }
}

function compareDefinitions(a, b) {
  // Shape check FIRST, before any identity shortcut. `undefined === undefined` is not
  // evidence of anything: two sides we cannot read must fail closed, not compare equal.
  if (!isObj(a) || !isObj(b)) return false;
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k !== "subgraphs") {
      if (!deepEqual(a[k], b[k])) return false;
      continue;
    }
    const sa = a.subgraphs;
    const sb = b.subgraphs;
    if (sa == null && sb == null) continue;
    // Subgraphs appear as an array or a keyed map depending on version.
    const listA = Array.isArray(sa) ? sa : isObj(sa) ? Object.entries(sa) : null;
    const listB = Array.isArray(sb) ? sb : isObj(sb) ? Object.entries(sb) : null;
    if (listA === null || listB === null || listA.length !== listB.length) return false;
    if (Array.isArray(sa) !== Array.isArray(sb)) return false;
    if (Array.isArray(sa)) {
      for (let i = 0; i < listA.length; i += 1) {
        if (!definitionDiffersOnlyByRenumber(listA[i], listB[i])) return false;
      }
    } else {
      const mapB = new Map(listB);
      if (mapB.size !== listA.length) return false;
      for (const [key, defA] of listA) {
        if (!mapB.has(key)) return false;
        if (!definitionDiffersOnlyByRenumber(defA, mapB.get(key))) return false;
      }
    }
  }
  return true;
}
