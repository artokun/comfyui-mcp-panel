// #2108 — a connect that silently OVERWRITES an unrelated link.
//
// The reporter repaired two invalid links on a live canvas. Each panel_connect
// reported success and also moved a wire it never named: "node 20 output 0 ->
// node 23 input 5 moved to the new link", then a different one on the next
// repair, until SamplerCustom was receiving MASK/VAE/SAMPLER in the wrong inputs.
// The #2380 collateral detector saw it and said so, which is why there is a
// report at all — but seeing it is not preventing it.
//
// THE MECHANISM, read out of the shipped frontend rather than guessed at. Every
// site that mints a link does this shape:
//
//     let o = toLinkId(Number(graph.state.lastLinkId) + 1);
//     graph.state.lastLinkId = o;
//     let s = new LLink(o, ...);
//     graph._links.set(s.id, s);
//
// `_links` is a Map and `set` REPLACES. So the moment `state.lastLinkId` sits
// below an id that is actually present, the next connect mints a colliding id and
// the bystander's record is replaced by the new one — which reads exactly as "an
// existing link moved to the new link". It also explains why each successive
// repair displaced a DIFFERENT wire: the counter keeps walking through ids that
// are already taken.
//
// A graph reaches that state by being loaded from something that did not carry a
// correct `last_link_id`: an API/prompt graph has no such field at all (panel#2011
// made that path loadable), and a hand-edited or third-party-exported workflow can
// carry one that is simply wrong.
//
// The repair is the frontend's OWN idiom. Its state-merge does
// `lastLinkId = max(lastLinkId, incoming)`; this does the same against the ids the
// graph actually holds, immediately before a mutation that is about to allocate.
// Nothing is renumbered and no link is touched — only the counter moves, and only
// upwards.

/**
 * Every link id currently present in a graph, whichever container it uses.
 *
 * `_links` is a Map on current frontends and a plain object on older ones; both
 * shapes ship in the wild and a subgraph's `_links` can differ from its parent's.
 * Ids are numbers today and `toLinkId` brands them, so compare numerically and
 * ignore anything that is not a finite number rather than coercing.
 */
export function collectLinkIds(links) {
  const out = [];
  if (!links) return out;
  const push = (raw) => {
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  };
  if (typeof links.keys === "function" && typeof links.get === "function") {
    for (const key of links.keys()) push(key);
    return out;
  }
  if (typeof links === "object") {
    for (const key of Object.keys(links)) push(key);
  }
  return out;
}

/**
 * The highest link id a graph holds, or null when it holds none.
 *
 * Reads the ids in the store AND each link record's own `id`. They can disagree:
 * a record re-keyed without its `id` being updated leaves the higher number
 * reachable only through the record, and allocating past the store's key alone
 * would still collide with it.
 */
export function highestLinkId(graph) {
  const ids = collectLinkIds(graph?._links);
  const links = graph?._links;
  if (links && typeof links.values === "function") {
    for (const link of links.values()) {
      const n = Number(link?.id);
      if (Number.isFinite(n)) ids.push(n);
    }
  } else if (links && typeof links === "object") {
    for (const key of Object.keys(links)) {
      const n = Number(links[key]?.id);
      if (Number.isFinite(n)) ids.push(n);
    }
  }
  if (ids.length === 0) return null;
  return ids.reduce((a, b) => (b > a ? b : a));
}

/**
 * Raise a graph's link-id counter above every id it already holds.
 *
 * Returns what happened so a caller can disclose it — a graph that needed this
 * was already in a state where an earlier connect may have overwritten something,
 * and that is worth saying rather than silently repairing.
 *
 * Safety: the counter only ever moves UP. A graph whose counter is already ahead
 * is left untouched, so this cannot renumber, cannot free an id for reuse, and
 * cannot make a well-formed graph worse. A graph with no links and no counter is
 * left alone too — there is nothing to collide with.
 */
export function ensureLinkIdHeadroom(graph) {
  if (!graph) return { adjusted: false };
  const highest = highestLinkId(graph);
  if (highest === null) return { adjusted: false };
  const currentRaw = graph.last_link_id;
  const current = Number(currentRaw);
  const known = Number.isFinite(current) ? current : null;
  if (known !== null && known >= highest) return { adjusted: false };
  try {
    graph.last_link_id = highest;
  } catch {
    // A frozen or accessor-less graph is not one we can repair; the caller still
    // gets `adjusted: false` and behaves exactly as it did before this existed.
    return { adjusted: false };
  }
  // Confirm the write LANDED. `last_link_id` is an accessor on the current
  // frontend (it forwards to `state.lastLinkId`), and a shape that silently
  // swallows the assignment must not be reported as repaired.
  const after = Number(graph.last_link_id);
  if (!Number.isFinite(after) || after < highest) return { adjusted: false };
  return { adjusted: true, from: known, to: highest };
}
