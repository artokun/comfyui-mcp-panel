/**
 * comfyui-mcp-panel#886 — `panel_open_workflow` reported an UNCONFIRMED failure even
 * though the binding was correct.
 *
 * Measured on the rig: loading a persisted workflow REGENERATES link identity inside
 * `definitions.subgraphs` (`state.lastLinkId` 2092 -> 2106) without changing anything
 * a user would call a difference. The binding check saw the `definitions` surface
 * differ and refused, so a correct binding was reported as unproven.
 *
 * comfyui-mcp#1706 — the SECOND rewrite the same frontend applies to the same surface,
 * and the reason this file no longer says "link renumbering" in its name.
 *
 * MEASURED on the rig (frontend 1.48.7, ComfyUI 0.33.1, real templates loaded in a real
 * browser, payload vs `app.graph.serialize()`), `LGraph.prototype.configure` runs, for
 * the ROOT graph only:
 *
 *   const reserved = new Set()
 *   for (const n of this._nodes)            reserved.add(numericNodeId(n.id))
 *   for (const sg of this.subgraphs.values()) for (const n of sg.nodes) reserved.add(...)
 *   for (const n of nodesData ?? [])        if (typeof n.id === "number") reserved.add(n.id)
 *   const dedup = this.isRootGraph ? deduplicateSubgraphNodeIds(subgraphs, reserved, this.state, nodesData) : undefined
 *
 * `deduplicateSubgraphNodeIds` walks each definition's `nodes` IN ORDER and, for any node
 * whose id is already reserved, allocates a fresh id from `state.lastNodeId + 1`, then
 * patches that definition's `links` (`origin_id`/`target_id`) and its promoted `widgets`
 * (`id`) through the same map. So a workflow whose definition node ids collide with its
 * OWN root node ids — or with an earlier definition's, six definitions each numbering
 * their nodes 76/77/78 collide with each other — comes back with different node ids
 * inside `definitions` and an identical graph.
 *
 * The isolating measurement, on `templates-6-key-frames.json` and
 * `video_wan2_2_14B_s2v.json`: take the workflow the frontend itself serialized (which
 * reopens BYTE-IDENTICALLY, definitions included), force its definition node ids to
 * collide, reopen. The ENTIRE definitions difference is then, and only:
 *
 *   /subgraphs/#/nodes/#/id                        the relabeling
 *   /subgraphs/#/links/#/origin_id, /target_id     patched through the same map
 *   /subgraphs/#/nodes/#/order                     LiteGraph's recomputed exec index
 *   /subgraphs/#/state/lastNodeId    196 -> 214    the counter that allocated them
 *
 * — and the root `nodes` surface is unchanged (0 differing paths). That is exactly the
 * shape comfyui-mcp#1706 reports: identity confirmed, 26 nodes matching, `definitions`
 * the only differing surface.
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
 *
 * Node IDS may be reassigned too (#1706), and that is a strictly stronger claim, so it
 * is proven rather than tolerated: a RELABELING is admitted only when there is a single
 * injective map that carries the payload's definition onto the live one — same node
 * count, same node ORDER, same type at every position, every other field of every node
 * deep-equal, and every link endpoint and promoted-widget reference equal AFTER the map
 * is applied. A node that vanished, a retyped node, a changed widget value, a re-wired
 * link, a renamed port: none of those survive that, because none of them is a
 * relabeling. And the account is granted only to a caller that hands over the ROOT
 * nodes, because a node id inside a definition is also referenced from OUTSIDE it —
 * see `rootNodesReferenceRemappedId`.
 */

/** Fields inside a subgraph definition that renumbering may touch AT ALL. Anything
 *  outside this set must be deep-equal. `inputs`/`outputs` are deliberately NOT here:
 *  they are the subgraph's interface ports, and renaming or retyping one is a semantic
 *  change to the graph (review found the earlier version waving them through). */
const RENUMBER_FIELDS = new Set(["links", "state", "nodes"]);

/** #1706 — with a NODE-id relabeling, `widgets` joins them: `patchPromotedWidgets`
 *  rewrites each promoted widget's `id` through the same map. It is not waived — the
 *  entries are compared under the map, and everything but `id` must be deep-equal. */
const RENUMBER_FIELDS_WITH_NODE_IDS = new Set(["links", "state", "nodes", "widgets"]);

/** The `state` counters renumbering may advance. Everything else in `state` is
 *  structural (how many nodes/groups the subgraph has ever had) and must match. */
const RENUMBER_STATE_KEYS = new Set(["lastLinkId", "lastRerouteId"]);

/** #1706 — `lastNodeId` is the counter `findNextAvailableId` allocates the new ids
 *  from, so a node relabeling cannot happen without it moving. It is admitted ONLY
 *  when a relabeling was actually found (see `anyRelabel`), and only FORWARD:
 *  a counter that went backwards is not an allocation. */
const RENUMBER_STATE_KEYS_WITH_NODE_IDS = new Set(["lastLinkId", "lastRerouteId", "lastNodeId"]);

/** #1706 — `order` is LiteGraph's recomputed execution index, never authored directly
 *  (the same reading `COSMETIC_NODE_FIELDS` in graph-binding.js already takes for root
 *  nodes), and the relabeling perturbs it. Admitted only alongside a relabeling, and
 *  only once the wiring it is derived FROM has been proven identical under the map. */
const NODE_FIELDS_WITH_NODE_IDS = new Set(["id", "order", "inputs", "outputs"]);

const NODE_FIELDS_LINK_RENUMBER_ONLY = new Set(["inputs", "outputs"]);

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
 *
 * `mapNodeId` (#1706) is applied to the endpoint NODE ids only, and only on the payload
 * side, so that a relabeled definition's wiring is compared against the payload's
 * wiring THROUGH the relabeling rather than against a renamed graph.
 */
function linkEndpoints(link, mapNodeId) {
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
  const mapped = (id) => {
    if (typeof mapNodeId !== "function") return id;
    try {
      return mapNodeId(id);
    } catch {
      return id;
    }
  };
  if (Array.isArray(link)) {
    if (link.length < 5) return null;
    const [, oId, oSlot, tId, tSlot, type] = link;
    return encode([mapped(oId), oSlot, mapped(tId), tSlot, type ?? null]);
  }
  if (isObj(link)) {
    const o = link.origin_id ?? link.originId;
    const os = link.origin_slot ?? link.originSlot;
    const t = link.target_id ?? link.targetId;
    const ts = link.target_slot ?? link.targetSlot;
    if (o === undefined || t === undefined) return null;
    return encode([mapped(o), os ?? null, mapped(t), ts ?? null, link.type ?? null]);
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
function linksDifferOnlyById(a, b, mapNodeId) {
  const listA = Array.isArray(a) ? a : a == null ? [] : null;
  const listB = Array.isArray(b) ? b : b == null ? [] : null;
  if (listA === null || listB === null) return false;
  if (listA.length !== listB.length) return false;
  const count = (list, map) => {
    const m = new Map();
    for (const l of list) {
      const sig = linkEndpoints(l, map);
      if (sig === null) return null;
      m.set(sig, (m.get(sig) ?? 0) + 1);
    }
    return m;
  };
  const ma = count(listA, mapNodeId);
  const mb = count(listB, undefined);
  if (!ma || !mb || ma.size !== mb.size) return false;
  for (const [sig, n] of ma) if (mb.get(sig) !== n) return false;
  return true;
}

/**
 * The RELABELING itself: payload node id -> live node id, read POSITIONALLY (#1706).
 *
 * Positional is what the frontend does — `remapNodeIds` walks `definition.nodes` in
 * order and mutates each node's id in place, so array order is preserved exactly
 * (measured: sent [78, 77, 76] came back [182, 183, 184], same positions). It is also
 * the only reading that can be checked: matching by id is impossible when the ids are
 * the thing that moved.
 *
 * Returns null — "cannot tell", which fails closed — when the node arrays are not
 * addressable as a relabeling at all: different lengths, a missing id or type, a type
 * that changed at some position, or an id repeated on either side. An id repeated on
 * the payload side would need to map to two live ids (not a function); one repeated on
 * the live side would collapse two nodes into one (not injective). Both are the
 * "duplicate identities are not addressable" refusal #886 already made.
 */
function buildNodeIdMap(nodesA, nodesB) {
  if (!Array.isArray(nodesA) || !Array.isArray(nodesB)) return null;
  if (nodesA.length !== nodesB.length) return null;
  const map = new Map();
  const usedTargets = new Set();
  for (let i = 0; i < nodesA.length; i += 1) {
    const na = nodesA[i];
    const nb = nodesB[i];
    if (!isObj(na) || !isObj(nb)) return null;
    const from = na.id;
    const to = nb.id;
    if (from === undefined || from === null || to === undefined || to === null) return null;
    // Type is REQUIRED and must match at the position: an id reused for a different
    // type is a different node however the count reads (#886's `nodeKey`), and a
    // relabeling never changes what a node IS.
    //
    // The two lines are NOT equivalent, and only the first can be killed by mutation.
    // REQUIRING a type is load-bearing: without it two typeless nodes pair up, and a
    // definition of typeless nodes whose ids moved would read as a relabeling (#886's
    // "a node missing an id or type refuses" pins exactly that). The EQUALITY check
    // deliberately overlaps `differsOnlyIn` in `nodesDifferOnlyInLinkRefs`, which
    // compares `type` on every pair a few lines later and refuses first — measured by
    // mutation: deleting this line kills no test. It stays because this function's
    // answer is "is this pairing a relabeling at all", and that question has to be
    // answerable here: `anyRelabel` is decided from these maps in pass 1 and widens
    // what EVERY OTHER definition may differ in. A later change to the field
    // comparison must not silently take that with it.
    if (typeof na.type !== "string" || !na.type) return null;
    if (na.type !== nb.type) return null;
    let keyFrom;
    let keyTo;
    try {
      keyFrom = String(from);
      keyTo = String(to);
    } catch {
      return null;
    }
    // A "did not move" has to be an ACTUAL non-move. `mapRelabelsAnything` reads the map
    // by string key, so `78` -> `"78"` would register as the identity — and once ANY
    // definition in the block relabels, `id` is an allowed field, and a definition whose
    // ids only changed TYPE would then go completely unchecked. Refuse instead: an id
    // whose dialect changed is not something this file has characterised, and refusing
    // reproduces the pre-#1706 answer for it exactly.
    if (keyFrom === keyTo && from !== to) return null;
    if (map.has(keyFrom) || usedTargets.has(keyTo)) return null;
    map.set(keyFrom, to);
    usedTargets.add(keyTo);
  }
  return map;
}

/** Did this map actually move anything? An identity map is the #886 case, and must not
 *  buy the wider `#1706` allowances (`order`, `widgets`, `state.lastNodeId`). */
function mapRelabelsAnything(map) {
  if (!map) return false;
  for (const [from, to] of map) {
    let keyTo;
    try {
      keyTo = String(to);
    } catch {
      return true;
    }
    if (from !== keyTo) return true;
  }
  return false;
}

/** Nodes match as a set, and each node differs at most in the link ids its slots
 *  reference — plus, when a relabeling is in play, its own `id` (already pinned by the
 *  map) and its recomputed `order`. Slot COUNTS and every other field must be
 *  identical. */
function nodesDifferOnlyInLinkRefs(a, b, { relabeled } = {}) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  // ORDER matters, and review was right to insist: LiteGraph node order can carry
  // execution and draw ordering, so a reordered array is not the same subgraph. The
  // positional pairing below IS that requirement — a reordered array pairs a node
  // against a different one, which `buildNodeIdMap` already refused on type, and
  // which the field comparison refuses on everything else.
  const allowedNodeFields = relabeled ? NODE_FIELDS_WITH_NODE_IDS : NODE_FIELDS_LINK_RENUMBER_ONLY;
  for (let i = 0; i < a.length; i += 1) {
    const na = a[i];
    const nb = b[i];
    if (!differsOnlyIn(na, nb, allowedNodeFields)) return false;
    // `id` is in `allowedNodeFields` when relabeled, and needs no separate check here:
    // the PAIRING IS THE MAP. `buildNodeIdMap` walked these same two arrays in this same
    // order and recorded `String(na.id) -> nb.id` for this position, and refused if
    // either side repeated an id — so `map.get(String(na.id)) === nb.id` holds by
    // construction. A check restating it would assert nothing (measured by mutation:
    // deleting one killed no test), and a check that asserts nothing is worse than no
    // check, because it reads like a guard. What actually pins the id is the map itself,
    // and the link/widget comparisons below, which are the only places the new ids are
    // allowed to be USED.
    // Slot arrays may differ ONLY in the link ids they carry.
    for (const side of ["inputs", "outputs"]) {
      const sa = na[side];
      const sb = nb[side];
      if (sa == null && sb == null) continue;
      if (!Array.isArray(sa) || !Array.isArray(sb) || sa.length !== sb.length) return false;
      for (let s = 0; s < sa.length; s += 1) {
        if (!differsOnlyIn(sa[s], sb[s], new Set(["link", "links", "_layoutElement"]))) return false;
        // The link REFERENCES may be renumbered, but their COUNT may not change:
        // a slot that gained or lost a connection is a re-wire, not a renumber.
        const la = sa[s]?.links;
        const lb = sb[s]?.links;
        if (Array.isArray(la) !== Array.isArray(lb)) return false;
        if (Array.isArray(la) && la.length !== lb.length) return false;
        const oneA = sa[s]?.link;
        const oneB = sb[s]?.link;
        if ((oneA == null) !== (oneB == null)) return false;
      }
    }
  }
  return true;
}

/**
 * Promoted widgets, under the relabeling (#1706).
 *
 * `patchPromotedWidgets` rewrites each entry's `id` — the definition node the widget is
 * promoted FROM — and nothing else. So the list must be the same length in the same
 * order, each entry's `id` must be exactly what the map says, and every other key must
 * be deep-equal. An entry whose `id` is not in the map must not have moved.
 */
function widgetsDifferOnlyByNodeId(a, b, map) {
  const listA = Array.isArray(a) ? a : a == null ? [] : null;
  const listB = Array.isArray(b) ? b : b == null ? [] : null;
  if (listA === null || listB === null) return false;
  if (listA.length !== listB.length) return false;
  for (let i = 0; i < listA.length; i += 1) {
    const wa = listA[i];
    const wb = listB[i];
    if (!isObj(wa) || !isObj(wb)) return false;
    if (!differsOnlyIn(wa, wb, new Set(["id"]))) return false;
    let key;
    try {
      key = String(wa.id);
    } catch {
      return false;
    }
    const expected = map?.has(key) ? map.get(key) : wa.id;
    if (!deepEqual(expected, wb.id)) return false;
  }
  return true;
}

/** `state`, under the relabeling: the allocation counter may only go FORWARD. */
function stateDiffersOnlyByCounters(a, b, relabeled) {
  const sa = a ?? {};
  const sb = b ?? {};
  const allowed = relabeled ? RENUMBER_STATE_KEYS_WITH_NODE_IDS : RENUMBER_STATE_KEYS;
  if (!differsOnlyIn(sa, sb, allowed)) return false;
  if (!relabeled) return true;
  if (deepEqual(sa.lastNodeId, sb.lastNodeId)) return true;
  // It MOVED, so it has to be an allocation: two numbers, advancing. Anything else
  // (a string, a missing side, a counter that went backwards) is not one.
  if (typeof sa.lastNodeId !== "number" || typeof sb.lastNodeId !== "number") return false;
  if (!Number.isFinite(sa.lastNodeId) || !Number.isFinite(sb.lastNodeId)) return false;
  return sb.lastNodeId >= sa.lastNodeId;
}

/** One subgraph definition, compared under an already-built relabeling. */
function definitionDiffersOnlyByRenumber(a, b, map, relabeled) {
  if (!isObj(a) || !isObj(b)) return false;
  if (!map) return false;
  const fields = relabeled ? RENUMBER_FIELDS_WITH_NODE_IDS : RENUMBER_FIELDS;
  if (!differsOnlyIn(a, b, fields)) return false;
  const mapNodeId = relabeled ? (id) => (map.has(String(id)) ? map.get(String(id)) : id) : undefined;
  if (!linksDifferOnlyById(a.links, b.links, mapNodeId)) return false;
  if (!nodesDifferOnlyInLinkRefs(a.nodes ?? [], b.nodes ?? [], { relabeled })) return false;
  if (relabeled && !widgetsDifferOnlyByNodeId(a.widgets, b.widgets, map)) return false;
  if (!stateDiffersOnlyByCounters(a.state, b.state, relabeled)) return false;
  return true;
}

/**
 * #1706 — a definition node id is referenced from OUTSIDE the `definitions` surface.
 *
 * A root subgraph-instance node promotes widgets from nodes INSIDE its definition, and
 * records that as `properties.proxyWidgets: [[definitionNodeId, widgetName], ...]`.
 * `deduplicateSubgraphNodeIds` returns rewritten `rootNodes` for exactly this — it runs
 * `patchProxyWidgets` over them as well as over the definitions.
 *
 * MEASURED (`templates-6-key-frames.json`, 5 root nodes promoting widgets, definition
 * ids forced to collide): that variant is NOT confined to `definitions`. The root
 * `nodes` surface came back differing on 10 paths — `inputs/#/widget` and
 * `widgets_values/#` — i.e. promoted widget VALUES were gone. Real loss, and it must
 * keep refusing.
 *
 * It would still keep refusing on the `nodes` surface alone, because the caller compares
 * that separately. But accounting for `definitions` here removes it from the UNEXPLAINED
 * set the weaker completed-load ground reads (#1588/#1283), and that ground does admit a
 * `widgets_values` difference. So the relabeling account refuses outright whenever a root
 * node promotes a widget from a node the relabeling touched: the one cross-surface
 * reference is not something this surface may vouch for.
 *
 * An unreadable `proxyWidgets` entry counts as referencing — "cannot tell" is not "no".
 * So does an id in a non-canonical numeric dialect: see the comparison below.
 * Keying on ONE spelling of an id is the defect class this repo keeps catching — a
 * String-keyed set does not see `"78.0"` as the node the frontend patches as 78.
 */
function rootNodesReferenceRemappedId(rootNodes, remappedFrom) {
  if (!Array.isArray(rootNodes)) return true;
  if (remappedFrom.size === 0) return false;
  // The same payload id, in every dialect this guard is willing to be sure about.
  // Comparing ONE spelling is what makes a key-matching guard miss (gate finding):
  // `78` and `"78.0"` are the same node to anything that reads the id numerically and
  // two different strings to anything that reads it textually, so a promoted widget
  // written `"78.0"` slipped past a String-keyed set while the load still broke it.
  const numericForms = new Set();
  for (const key of remappedFrom) {
    const n = Number(key);
    if (Number.isFinite(n)) numericForms.add(String(n));
  }
  for (const node of rootNodes) {
    const promoted = node?.properties?.proxyWidgets;
    if (promoted == null) continue;
    if (!Array.isArray(promoted)) return true;
    for (const entry of promoted) {
      if (!Array.isArray(entry) || entry.length === 0) return true;
      let key;
      try {
        key = String(entry[0]);
      } catch {
        return true;
      }
      if (remappedFrom.has(key)) return true;
      const asNumber = Number(key);
      if (Number.isFinite(asNumber) && numericForms.has(String(asNumber))) return true;
      // ...and one more reading, because `Number()` is not the only way an id gets
      // interpreted numerically. `Number("78abc")` is NaN while a leading-integer parse
      // is 78, so a text comparison AND a `Number()` comparison would both miss an entry
      // that some reader resolves to a node the relabeling moved.
      //
      // Deliberately NOT "refuse every non-canonical id": that was tried and it refuses
      // `"999999.0"`, which names nothing that moved. An over-broad guard is a
      // regression wearing a fix's clothes — this asks only whether the entry can be
      // read as one of the ids that ACTUALLY moved.
      const leading = /^\s*[+-]?\d+/.exec(key);
      if (!leading) continue;
      const asLeadingInt = Number(leading[0]);
      if (Number.isFinite(asLeadingInt) && numericForms.has(String(asLeadingInt))) return true;
    }
  }
  return false;
}

/**
 * Do two `definitions` blocks differ ONLY by the frontend's load-time renumbering —
 * of link ids (#886), of subgraph node ids (#1706), or of both?
 *
 * `rootNodes` is the PAYLOAD's root node array. It is required for the node-id account
 * and unused by the link-id one, so a caller that does not supply it gets byte-for-byte
 * the pre-#1706 answer: the new ground is granted only to a caller that hands over the
 * evidence it rests on.
 *
 * Returns false for anything it cannot fully account for. The caller reads false as
 * "not proven" and refuses — which is the safe direction.
 */
export function definitionsDifferOnlyByRenumber(a, b, options) {
  // ONE guard at the boundary, rather than one per risky call. Review found throws
  // escaping from places the inner wrappers did not cover — Object.keys on a Proxy
  // whose ownKeys trap throws, a throwing property getter, a link Proxy read before
  // the JSON encode. Chasing each site is a losing game: the honest statement is that
  // NOTHING in here may escape, because an exception on this path takes out the guard
  // that decides whether writes land instead of answering "not proven".
  try {
    return compareDefinitions(a, b, options);
  } catch {
    return false;
  }
}

/** The pairs of definitions to compare, or null if the two blocks are not even pairable
 *  (different count, different container shape, a key on one side only). */
function pairDefinitions(sa, sb) {
  if (sa == null && sb == null) return [];
  const listA = Array.isArray(sa) ? sa : isObj(sa) ? Object.entries(sa) : null;
  const listB = Array.isArray(sb) ? sb : isObj(sb) ? Object.entries(sb) : null;
  if (listA === null || listB === null || listA.length !== listB.length) return null;
  if (Array.isArray(sa) !== Array.isArray(sb)) return null;
  if (Array.isArray(sa)) return listA.map((defA, i) => [defA, listB[i]]);
  const mapB = new Map(listB);
  if (mapB.size !== listA.length) return null;
  const pairs = [];
  for (const [key, defA] of listA) {
    if (!mapB.has(key)) return null;
    pairs.push([defA, mapB.get(key)]);
  }
  return pairs;
}

function compareDefinitions(a, b, options) {
  // Shape check FIRST, before any identity shortcut. `undefined === undefined` is not
  // evidence of anything: two sides we cannot read must fail closed, not compare equal.
  if (!isObj(a) || !isObj(b)) return false;
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let pairs = [];
  for (const k of keys) {
    if (k !== "subgraphs") {
      if (!deepEqual(a[k], b[k])) return false;
      continue;
    }
    // Subgraphs appear as an array or a keyed map depending on version.
    const paired = pairDefinitions(a.subgraphs, b.subgraphs);
    if (paired === null) return false;
    pairs = paired;
  }
  // TWO PASSES, because the counter is SHARED. `state.lastNodeId` inside a serialized
  // definition is the ROOT graph's allocation counter (measured: all six definitions
  // reported the same 196 -> 214), so a definition that was NOT relabeled still shows it
  // moving as soon as ANY definition was. Deciding the allowance per definition would
  // therefore refuse the very case this exists for. Pass 1 establishes whether a
  // relabeling happened anywhere; pass 2 compares every definition under that answer.
  const maps = [];
  let anyRelabel = false;
  for (const [defA, defB] of pairs) {
    if (!isObj(defA) || !isObj(defB)) return false;
    const map = buildNodeIdMap(defA.nodes ?? [], defB.nodes ?? []);
    if (map === null) return false;
    maps.push(map);
    if (mapRelabelsAnything(map)) anyRelabel = true;
  }
  const remappedFrom = new Set();
  for (let i = 0; i < pairs.length; i += 1) {
    if (!definitionDiffersOnlyByRenumber(pairs[i][0], pairs[i][1], maps[i], anyRelabel)) return false;
    if (!anyRelabel) continue;
    for (const [from, to] of maps[i]) {
      let keyTo;
      try {
        keyTo = String(to);
      } catch {
        return false;
      }
      if (from !== keyTo) remappedFrom.add(from);
    }
  }
  if (!anyRelabel) return true;
  return !rootNodesReferenceRemappedId(options?.rootNodes, remappedFrom);
}
