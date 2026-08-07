/**
 * #690(5) — bound `panel_list_subgraphs`.
 *
 * Every other panel read tool is explicitly token-bounded (query_graph,
 * graph_outline, find_nodes). This one was not: an install with the bundled
 * global blueprints returned all 90 entries with full display names and
 * descriptions in a single response.
 *
 * BOUNDING A READ CAN CREATE A WORSE BUG THAN IT FIXES, and that shapes the whole
 * design here. A tool that quietly returns 25 of 90 is a silent-omission defect —
 * an agent concludes a blueprint does not exist and rebuilds it by hand, which is
 * exactly the class of "reads as success" failure the rest of this codebase keeps
 * removing. So:
 *
 *   • `count` keeps its existing meaning — the TOTAL in the library — and never
 *     shrinks to the number returned. A caller comparing count to the array length
 *     can always see the difference.
 *   • `truncated` is only ever `true` when entries were actually withheld, and it
 *     comes with the exact number and how to reach them.
 *   • filtering reports `matched` separately from `count`, so "3 of 90 matched" is
 *     distinguishable from "the library only has 3".
 *
 * The default limit is generous on purpose: this is a library of user-authored
 * blueprints, not an unbounded graph, and most installs have few enough that
 * nothing is ever withheld.
 */

/** Big enough that a typical library returns whole, small enough that the bundled
 *  global set cannot dominate a context window. */
export const SUBGRAPH_LIST_DEFAULT_LIMIT = 40;
const MAX_LIMIT = 500;
/** Descriptions are free-form and can be paragraphs; the name/type are what a
 *  caller needs to act (panel_add_subgraph takes them), so only the prose clips. */
const DESCRIPTION_CLIP = 200;

function clip(text, max = DESCRIPTION_CLIP) {
  if (typeof text !== "string") return text ?? null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Coerce a caller-supplied limit into range. A non-number, NaN or <= 0 falls back
 *  to the default rather than returning nothing — a caller fumbling the parameter
 *  should not get an empty library that reads as "you have no blueprints". */
export function normalizeSubgraphLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return SUBGRAPH_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Case-insensitive substring over the fields a caller would search by. */
function matchesFilter(bp, needle) {
  if (!needle) return true;
  const hay = `${bp?.name ?? ""}\n${bp?.display_name ?? ""}\n${bp?.description ?? ""}`;
  return hay.toLowerCase().includes(needle);
}

/**
 * @param {Array<object>} blueprints  every blueprint in the library
 * @param {{filter?: string, limit?: number}} [opts]
 * @returns {{count:number, blueprints:Array<object>, matched?:number,
 *            returned?:number, truncated?:true, note?:string}}
 *   `count` is ALWAYS the library total. `matched` appears only when a filter was
 *   applied. `truncated`/`note` appear only when entries were actually withheld.
 */
export function boundSubgraphList(blueprints, { filter, limit } = {}) {
  const all = Array.isArray(blueprints) ? blueprints : [];
  const needle = typeof filter === "string" && filter.trim() ? filter.trim().toLowerCase() : "";
  const matched = needle ? all.filter((bp) => matchesFilter(bp, needle)) : all;
  const cap = normalizeSubgraphLimit(limit);
  const shown = matched.slice(0, cap).map((bp) => ({ ...bp, description: clip(bp?.description) }));

  const out = { count: all.length, blueprints: shown };
  if (needle) out.matched = matched.length;
  if (matched.length > shown.length) {
    out.returned = shown.length;
    out.truncated = true;
    out.note =
      `Showing ${shown.length} of ${matched.length}${needle ? " matching" : ""} blueprint(s)` +
      `${needle ? "" : ` (library total ${all.length})`}. ` +
      `The rest were NOT returned — do not conclude a blueprint is absent from this list. ` +
      `Narrow with \`filter\` (matches name, display name and description) or raise \`limit\`.`;
  }
  return out;
}
