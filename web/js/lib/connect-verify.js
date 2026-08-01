// Post-mutation link-persistence verification for graph_connect (#397).
//
// LiteGraph's `LGraphNode.connect(outIdx, target, inIdx)` can return a TRUTHY link
// object at the moment of the call and yet leave NO persisted link on the live
// graph — e.g. when the target input is a WIDGET-backed pseudo-input (rgthree/Impact
// nodes like ImpactSwitch expose `select` as an INT widget, not a real socket) that
// the node reverts or restructures away synchronously, or a dynamic-input node that
// re-slots on connect and drops the just-created link. The panel used to report a
// full success (with a `type`) purely on that truthy return, so panel_connect
// FALSELY claimed a persisted wire that isn't on the graph (ImpactSwitch.select),
// while an identical Reroute→select on a real socket (LatentSwitch) did persist.
//
// This module is the single source of truth for "did the link ACTUALLY land". It is
// pure (no DOM / no ComfyUI globals — the graph + nodes are passed in) so it drives
// the SAME check under unit test that production runs.

/**
 * True only when `link` is a REAL, persisted connection on `graph`:
 *   - the link object carries an id AND
 *   - `graph.links[link.id]` still exists (not reverted/removed) AND
 *   - the target input at `inIdx` actually references THAT link id.
 *
 * Fails CLOSED (returns false) on any missing/mismatched piece, so a phantom link is
 * never reported as connected. `graph.links` may be an array or a plain object keyed
 * by id in different LiteGraph builds — both are read by index/key access.
 */
export function isLinkPersisted(graph, target, inIdx, link) {
  const linkId = link?.id;
  if (linkId == null) return false;
  const links = graph?.links;
  if (!links) return false;
  const stored = typeof links.get === "function" ? links.get(linkId) : links[linkId];
  if (stored == null) return false;
  const input = target?.inputs?.[inIdx];
  if (!input) return false;
  // The input's `link` must reference the SAME link id we just created. (A widget
  // pseudo-input that was reverted has `link == null`; a re-slotted node points the
  // slot at a different/absent link.)
  return input.link === linkId;
}

/**
 * Best-effort removal of a NON-persisted phantom link so a failed connect leaves the
 * graph clean (no dangling half-link the next serialize would trip over). Fully
 * defensive: tries the graph's own removeLink, else clears a matching stored entry.
 * Never throws.
 */
export function removePhantomLink(graph, link) {
  const linkId = link?.id;
  if (linkId == null || !graph) return;
  try {
    if (typeof graph.removeLink === "function") {
      graph.removeLink(linkId);
      return;
    }
    const links = graph.links;
    if (!links) return;
    if (typeof links.delete === "function") links.delete(linkId);
    else if (Object.prototype.hasOwnProperty.call(links, linkId)) delete links[linkId];
  } catch {
    /* best-effort cleanup — the honest failure is reported regardless */
  }
}

/**
 * True when `input` is a WIDGET-BACKED input slot (rendered as a widget, not a plain
 * socket) — the class of target that most often accepts a transient link but does not
 * persist it. Used only to enrich the honest-failure message so the caller is told
 * WHY (set the value with panel_set_widget, or convert the widget to a real input in
 * the UI first). Detection is by LiteGraph's `input.widget` backlink.
 */
export function isWidgetBackedInput(input) {
  return !!(input && input.widget);
}
