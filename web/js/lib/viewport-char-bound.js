/**
 * #845 — `panel_view_nodes_in_viewport` returned **135,531 characters across 5,662
 * lines** for a caller inspecting ONE node in a 175-node workflow, tripping the
 * harness token guard.
 *
 * The tool was not unbounded — it caps at `MAX_STATE_NODES` (100) nodes. It was
 * bounded by the WRONG UNIT. A 100-node cap says nothing about size when each node
 * summarizes to ~1.3k characters, so the cap can be honoured exactly and still emit
 * 135k characters. `panel_query_graph` is bounded by `max_chars` for precisely this
 * reason; this tool had no character budget and took no parameters at all, so a
 * caller could not ask for less. (The reporter's `node_ids:["42"]` was silently
 * dropped for the same reason — the handler accepts no arguments.)
 *
 * TRUNCATION MUST STAY VISIBLE. Every count in the reply keeps describing the
 * WORKFLOW, not the payload: `in_view_count` remains how many nodes are actually on
 * screen, so comparing it to `nodes.length` always reveals the difference. A read
 * that quietly returns 12 of 87 is a silent-omission bug wearing a smaller token
 * count — worse than the flood it replaces, because the caller stops looking.
 *
 * The budget is applied per node, in view order, and stops at the first node that
 * would exceed it. Nodes are not partially serialized: half a node summary is not a
 * smaller answer, it is a malformed one.
 */

/** Generous enough that an ordinary viewport (a handful of nodes) is never clipped,
 *  small enough that a full 100-node screen cannot flood a context window. Chosen
 *  against the reported case: 135k became the problem, ~24k is a readable page. */
export const VIEWPORT_DEFAULT_MAX_CHARS = 24000;
const MIN_MAX_CHARS = 2000;
const MAX_MAX_CHARS = 200000;

/** Coerce a caller-supplied budget into range. A non-number or nonsense value falls
 *  back to the default rather than to zero: a caller fumbling the parameter must not
 *  receive an empty viewport that reads as "nothing is on screen". */
export function normalizeViewportMaxChars(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return VIEWPORT_DEFAULT_MAX_CHARS;
  return Math.min(Math.max(Math.floor(n), MIN_MAX_CHARS), MAX_MAX_CHARS);
}

/**
 * Take nodes in view order until the character budget is spent.
 *
 * @param {Array<object>} summaries already-summarized nodes, in view order
 * @param {number} maxChars budget (already normalized)
 * @returns {{kept: Array<object>, keptChars: number, droppedForChars: number}}
 */
export function boundByChars(summaries, maxChars) {
  const list = Array.isArray(summaries) ? summaries : [];
  const kept = [];
  let used = 0;
  for (const s of list) {
    let size;
    try {
      size = JSON.stringify(s)?.length ?? 0;
    } catch {
      size = 0; // an unserializable summary is the caller's problem, not a reason to stop
    }
    // Always admit the FIRST node even if it alone exceeds the budget: returning an
    // empty viewport for one large node would report "nothing here" about a node the
    // user is looking at.
    if (kept.length > 0 && used + size > maxChars) break;
    kept.push(s);
    used += size;
  }
  return { kept, keptChars: used, droppedForChars: list.length - kept.length };
}

/**
 * The truncation fields for the reply, or `{}` when nothing was withheld.
 *
 * `inViewCount` stays the true on-screen count in the caller's payload; this only
 * describes what was omitted and how to get it.
 */
export function viewportTruncation({ inViewCount, keptCount, nodeCap, maxChars }) {
  if (keptCount >= inViewCount) return {};
  const byCap = inViewCount > nodeCap;
  return {
    truncated: true,
    returned: keptCount,
    truncation_hint:
      `Showing ${keptCount} of ${inViewCount} node(s) currently in view` +
      (byCap ? ` (node cap ${nodeCap})` : ` (character budget ${maxChars})`) +
      `. The rest were NOT returned — do not read this as the viewport being empty of them. ` +
      `Zoom in so fewer nodes are on screen, raise \`max_chars\` (up to ${MAX_MAX_CHARS}), ` +
      `or read specific nodes by id with panel_query_graph {ids:[…], fields:'detail'}.`,
  };
}
