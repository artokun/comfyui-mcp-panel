/**
 * #886 — a `definitions` difference that is ONLY link renumbering.
 *
 * ## Measured, not inferred
 *
 * Diffing a real saved workflow's raw disk JSON against its serialized state after
 * load (`Anima Wojak Batch.json`, 4 subgraph definitions, panel 0.14.14 / frontend
 * 1.48.7):
 *
 *   - node count, node ids and node types inside each subgraph: IDENTICAL
 *   - the only differing node field: `inputs` — and each entry's `localized_name`,
 *     `name` and `type` are byte-identical, so what moved is the link reference
 *   - `links`: differ
 *   - `state.lastLinkId`: 2092 -> 2106
 *
 * The frontend regenerates link identity inside subgraph definitions when it loads a
 * workflow. Nothing semantic moves — same nodes, same ids, same types, same topology.
 *
 * ## Why this exists
 *
 * `graphRootReproducesStateContent` refuses any surface other than `nodes`, so a
 * faithful open of ANY workflow containing subgraphs reported CONTENT_UNVERIFIED:
 * binding proven, node comparison perfect, refused on a surface nobody had
 * characterised. That is #886, and it is why the node-geometry allowlist (which made
 * the `nodes` surface tolerant) did not close it — the difference is not in `nodes`.
 *
 * ## Why it is this narrow
 *
 * The guard's failure mode is a wrong-graph open reported as SUCCESS (#968), so
 * "tolerate `definitions`" is not available. This tolerates one named normalisation
 * and nothing else: a node added, removed, retyped, or a changed widget value still
 * fails, exactly as before. Same discipline as the node-geometry rule — name the
 * normalisation, admit only it.
 */

/** Fields inside a subgraph definition that link renumbering is allowed to move.
 *  `nodes` is here because node slots carry the link references that get rewritten —
 *  it is NOT waved through: `nodesDifferOnlyInLinkRefs` then checks every node field
 *  and every slot, so the only thing that may actually differ is the link id. */
const RENUMBER_FIELDS = new Set(["links", "state", "inputs", "outputs", "nodes"]);

/** The `state` counters renumbering may advance. Everything else in `state` is
 *  structural (how many nodes/groups the subgraph has ever had) and must match. */
const RENUMBER_STATE_KEYS = new Set(["lastLinkId", "lastRerouteId"]);

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Same keys, and every key outside `allowed` deep-equal. */
function differsOnlyIn(a, b, allowed) {
  if (!isObj(a) || !isObj(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (allowed.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

/** The node SET and TYPES must be identical — that is the part that makes this safe.
 *  Ids are compared as strings because a definition may carry either. */
function sameNodeIdentity(a, b) {
  const list = (d) => (Array.isArray(d?.nodes) ? d.nodes : null);
  const an = list(a);
  const bn = list(b);
  if (!an || !bn || an.length !== bn.length) return false;
  const key = (n) => `${String(n?.id)}|${String(n?.type)}`;
  const as = an.map(key).sort();
  const bs = bn.map(key).sort();
  return as.every((v, i) => v === bs[i]);
}

/** Every node's fields match except `inputs`/`outputs`, whose entries match except
 *  for their link references. A changed widget value or a moved node still fails. */
function nodesDifferOnlyInLinkRefs(a, b) {
  const byId = (d) => new Map((d.nodes ?? []).map((n) => [String(n?.id), n]));
  const bm = byId(b);
  for (const an of a.nodes ?? []) {
    const bn = bm.get(String(an?.id));
    if (!bn) return false;
    if (!differsOnlyIn(an, bn, new Set(["inputs", "outputs"]))) return false;
    for (const side of ["inputs", "outputs"]) {
      const ai = Array.isArray(an[side]) ? an[side] : [];
      const bi = Array.isArray(bn[side]) ? bn[side] : [];
      if (ai.length !== bi.length) return false;
      for (let i = 0; i < ai.length; i++) {
        // `link`/`links` are the regenerated identity; everything else about the
        // slot (name, localized_name, type, widget, shape) must be unchanged.
        if (!differsOnlyIn(ai[i], bi[i], new Set(["link", "links", "slot_index"]))) return false;
      }
    }
  }
  return true;
}

/**
 * Is the whole `definitions` difference explained by link renumbering?
 *
 * Returns false for anything it cannot fully account for — an unreadable shape, a
 * different subgraph set, a changed node set, a moved widget value. The caller must
 * treat false as "not proven", never as "changed".
 */
export function definitionsDifferOnlyByLinkRenumber(a, b) {
  if (a === undefined && b === undefined) return false; // nothing to explain
  if (!isObj(a) || !isObj(b)) return false;
  // Only `subgraphs` is understood; a future key appearing here must NOT be waved
  // through by a rule written before it existed.
  if (!differsOnlyIn(a, b, new Set(["subgraphs"]))) return false;

  const as = Array.isArray(a.subgraphs) ? a.subgraphs : null;
  const bs = Array.isArray(b.subgraphs) ? b.subgraphs : null;
  if (!as || !bs || as.length !== bs.length) return false;

  const bById = new Map(bs.map((d) => [String(d?.id), d]));
  for (const ad of as) {
    const bd = bById.get(String(ad?.id));
    if (!bd) return false;
    if (!differsOnlyIn(ad, bd, RENUMBER_FIELDS)) return false;
    if (!sameNodeIdentity(ad, bd)) return false;
    if (!nodesDifferOnlyInLinkRefs(ad, bd)) return false;
    if (!differsOnlyIn(ad.state ?? {}, bd.state ?? {}, RENUMBER_STATE_KEYS)) return false;
  }
  return true;
}
