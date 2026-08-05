// Pure read helpers for the graph query/outline tools (panel_query_graph /
// panel_graph_outline). Kept side-effect-free and dependency-free so they can be
// unit-tested in isolation (browser_tests/unit/graph-read.test.mjs) and mirror the
// orchestrator's headless engine (comfyui-mcp src/services/graph-query.ts).
//
// Two correctness fixes live here:
//   #607 — a widget whose SAME-NAMED input is link-connected is DRIVEN BY THE LINK
//          at execution; its stored value is stale. linkDrivenWidgets() surfaces
//          which widgets are overridden (and by whom) so a read can flag the stale
//          value instead of reporting it as if it were effective.
//   #609 — one oversized widget blob (ResolutionMaster presets JSON,
//          LTXDirector.timeline_data, VHS videopreview…) or several nodes can blow
//          the whole max_chars budget, returning `shown:0` for a node you asked for
//          by id. capSummaryWidgets() bounds each value; isLineProtected() keeps the
//          FIRST match and any explicitly-requested id renderable regardless.

/** Per-widget-value character cap for the `detail` projection (#609). Big enough
 *  to identify a value, small enough that one blob can't starve a whole query. */
export const WIDGET_VALUE_CAP = 2048;

// #809: the REAL clamps for panel_query_graph / panel_graph_outline, exported so every
// remedy string below quotes a ceiling the runtime actually enforces. A hint that names
// a ceiling nobody honours sends the caller at a value that is silently clamped, which
// reads back to them as "this tool cannot do it".
export const LIMIT_CEILING = 200;
export const MAX_CHARS_CEILING = 60000;
export const MAX_CHARS_FLOOR = 500;
/** Widget values are clipped to this in the `compact` projection (a FIXED cap). */
export const COMPACT_VALUE_CLIP = 60;

/**
 * #809 (codex gate): "raise `X` up to N" is ITSELF a dead retry when the caller is
 * already at N, and "raise `X`" with no ceiling leaves them guessing how far. Both cost
 * the round trip this issue exists to prevent. One helper so every marker — inline or
 * tail — states the same true thing. Mirrors the orchestrator twin in graph-query.ts.
 */
export function raiseOrCeiling(param, inForce, ceiling) {
  return typeof inForce === "number" && inForce >= ceiling
    ? `\`${param}\` is already at its ceiling of ${ceiling}`
    : `raise \`${param}\` (up to ${ceiling})`;
}

/** Map of widget-name → { node_id, output_slot } for every input on `node` that is
 *  connected by a link. A widget whose name matches such an input is driven by that
 *  link at execution — its stored `w.value` is stale (#607). Never throws. */
export function linkDrivenWidgets(node) {
  const links = node?.graph?.links ?? {};
  const out = {};
  for (const inp of node?.inputs ?? []) {
    if (!inp || inp.link == null || typeof inp.name !== "string") continue;
    const l = links[inp.link];
    if (!l) continue;
    // Support both object links ({origin_id,origin_slot}) and array links [id,os,...].
    const originId = l.origin_id ?? l[1];
    const originSlot = l.origin_slot ?? l[2];
    if (originId == null) continue;
    out[inp.name] = { node_id: originId, output_slot: originSlot ?? 0 };
  }
  return out;
}

/** Restrict a full link-driven map to only the names that are actually WIDGETS on
 *  the node (a link-connected input with no matching widget is a normal input,
 *  already shown under `inputs`). `widgetNames` is any iterable of names. */
export function drivenWidgetsFor(node, widgetNames) {
  const all = linkDrivenWidgets(node);
  const names = widgetNames instanceof Set ? widgetNames : new Set(widgetNames ?? []);
  const out = {};
  for (const name of Object.keys(all)) if (names.has(name)) out[name] = all[name];
  return out;
}

/** A concise, human-readable annotation for a link-driven widget, e.g.
 *  "[⚠ link-driven #85.0]". `src` is a { node_id, output_slot } entry. */
export function drivenTag(src) {
  if (!src) return "";
  return ` [⚠ link-driven #${src.node_id}.${src.output_slot}]`;
}

/** Bound a single widget value by its ESCAPED (JSON-serialized) size (#609), so the
 *  bound holds regardless of content — control chars ( ) and lone surrogates
 *  escape to 6 chars each, not 2. Returns the value unchanged when it already fits;
 *  otherwise the longest head prefix whose encoding fits `cap`, with an honest marker
 *  naming how many raw chars were dropped. */
export function capWidgetValue(value, cap = WIDGET_VALUE_CAP, maxChars = Infinity) {
  if (value == null) return value;
  const isString = typeof value === "string";
  const s = isString ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  if (typeof s !== "string") return value;
  if (JSON.stringify(s).length <= cap) return value;
  // #809: name the lever that ACTUALLY applies. capSummaryWidgets() tightens the
  // per-value cap to the char budget only when the budget is the smaller of the two, so
  // `cap < WIDGET_VALUE_CAP` ⟺ max_chars is what cut this value and raising it helps. At
  // the FIXED 2048 cap raising max_chars does nothing, and saying so stops the caller
  // burning a retry on a parameter that cannot move this.
  const remedy =
    cap < WIDGET_VALUE_CAP
      ? `over the \`max_chars\` budget; ${raiseOrCeiling("max_chars", maxChars, MAX_CHARS_CEILING)}`
      : `at the ${WIDGET_VALUE_CAP}-char per-widget cap, which \`max_chars\` does not raise`;
  const marker = (dropped) => `…(+${dropped} chars cut ${remedy})`;
  // Binary-search the longest raw prefix whose ESCAPED length fits, reserving EXACTLY
  // the marker's own worst-case size (its digit count is bounded by s.length) rather
  // than a fixed 40 — a longer, more useful marker must not be able to breach `cap`.
  const target = Math.max(2, cap - marker(s.length).length);
  let lo = 0;
  let hi = s.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (JSON.stringify(s.slice(0, mid)).length <= target) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return `${s.slice(0, best)}${marker(s.length - best)}`;
}

/** Clip a KEY/name to a small bound (#609) — node/widget/input names are short
 *  identifiers, but a pathological graph shouldn't be able to blow the line via a key. */
function capKey(key, cap = 128) {
  const k = String(key);
  return k.length <= cap ? k : `${k.slice(0, cap)}…`;
}

/** Serialized (JSON-escaped) size of one `"key":value,` widget entry — the ACTUAL
 *  contribution to the line, so escape-heavy strings (quotes/newlines) don't slip the
 *  budget. */
function entrySize(key, value) {
  let vLen;
  try { vLen = JSON.stringify(value)?.length ?? 0; } catch { vLen = String(value).length; }
  return JSON.stringify(String(key)).length + vLen + 2; // "key": value ,
}

/** Return a shallow clone of a summarizeNode() result whose `widgets` are bounded
 *  (#609): each value is clipped, AND the total serialized widgets size is kept under
 *  `totalCap` by DROPPING overflow widgets (keeping valid JSON) with an elision
 *  marker — so even a node with many oversized widgets can't blow the char budget.
 *  When a budget is set, the per-value cap is tightened to it so even the single
 *  retained widget respects `totalCap`. At least one widget always survives. The
 *  original summary is not mutated. */
export function capSummaryWidgets(summary, cap = WIDGET_VALUE_CAP, totalCap = Infinity) {
  if (!summary || typeof summary !== "object" || !summary.widgets) return summary;
  // capWidgetValue bounds the ESCAPED size exactly, so the per-value cap can be the
  // budget itself (minus a small reserve for the key + JSON framing).
  const perValueCap = Number.isFinite(totalCap) ? Math.min(cap, Math.max(1, totalCap - 256)) : cap;
  const entries = Object.entries(summary.widgets);
  const widgets = {};
  let used = 0;
  let omitted = 0;
  let changed = false;
  for (let i = 0; i < entries.length; i++) {
    const [rawKey, v] = entries[i];
    const k = capKey(rawKey);
    if (k !== rawKey) changed = true;
    const capped = capWidgetValue(v, perValueCap, totalCap);
    if (capped !== v) changed = true;
    const size = entrySize(k, capped);
    // Keep at least one widget, then stop once the total would exceed the budget.
    if (Number.isFinite(totalCap) && Object.keys(widgets).length > 0 && used + size > totalCap) {
      omitted = entries.length - i;
      changed = true;
      break;
    }
    widgets[k] = capped;
    used += size;
  }
  // #809: backtick the lever (so the schema-driven remedy test can see it) and state
  // how many remain — the caller needs "how much is left", not just "some".
  if (omitted > 0)
    widgets["…"] =
      `${omitted} more widget(s) cut by the \`max_chars\` budget; ` +
      raiseOrCeiling("max_chars", totalCap, MAX_CHARS_CEILING);
  return changed ? { ...summary, widgets } : summary;
}

/** Hard-clip an assembled COMPACT (plain-string) line to `maxChars` (#609). The
 *  protected first match bypasses the running budget, so without this a node with
 *  thousands of small widgets could emit an unbounded first line. Plain string, so a
 *  tail ellipsis is safe (unlike detail's JSON, which is bounded via capSummaryWidgets). */
export function clipLine(line, maxChars) {
  if (!Number.isFinite(maxChars) || line.length <= maxChars) return line;
  // #809: a bare "…" told the caller nothing. Say how much was cut and name the lever
  // (raising max_chars genuinely lifts THIS cut). The reserve is the marker's own
  // worst-case size, so the clipped line still respects maxChars.
  const marker = (dropped) =>
    `…(+${dropped} chars over \`max_chars\`; ${raiseOrCeiling("max_chars", maxChars, MAX_CHARS_CEILING)})`;
  const keep = Math.max(0, maxChars - marker(line.length).length);
  return line.slice(0, keep) + marker(line.length - keep);
}

/** Final guard for a DETAIL (JSON) line (#609): if a node's fully-capped detail STILL
 *  exceeds `maxChars` — a high-fan-in / many-slot node whose inputs/outputs the
 *  per-field caps don't touch — replace it with a bounded, VALID-JSON stub carrying
 *  the essentials + guidance. The row is never dropped (shown stays ≥ 1) but can't
 *  flood: every rendered line is ≤ maxChars. `stub` is a small object {id, type, …}. */
export function fitDetailLine(line, stub, maxChars) {
  if (!Number.isFinite(maxChars) || line.length <= maxChars) return line;
  // Clip the stub's OWN fields too — a graph may carry an arbitrarily long node id or
  // type, which would otherwise blow even the stub past the budget.
  const clipF = (v) => (typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…` : v);
  const safe = {
    id: clipF(stub?.id),
    type: clipF(stub?.type),
    ...(stub?.title != null ? { title: clipF(stub.title) } : {}),
  };
  const s = JSON.stringify({
    ...safe,
    detail_omitted: `full detail is ${line.length} chars > \`max_chars\` ${maxChars}; ${raiseOrCeiling("max_chars", maxChars, MAX_CHARS_CEILING)} to read this node`,
  });
  if (s.length <= maxChars) return s;
  // Absurdly small budget: a minimal fixed-shape row (id clipped hard) that still identifies the node.
  return JSON.stringify({ id: typeof safe.id === "string" ? safe.id.slice(0, 40) : safe.id, detail_omitted: "raise `max_chars`" });
}

/** Whether a line must render regardless of the remaining char budget (#609): ONLY
 *  the FIRST match, so a non-empty match never yields `shown:0` (the reported
 *  single-id failure). Deliberately does NOT exempt every requested id — that would
 *  disable the max_chars token bound for a large `ids` list. At most one line (the
 *  first, itself per-value capped) can exceed the budget, keeping output bounded. */
export function isLineProtected(shownSoFar) {
  return shownSoFar === 0;
}

/**
 * Build the truncation-tail advice (#609, rewritten for #809).
 *
 * `limit` and `max_chars` are DIFFERENT cuts with OPPOSITE remedies: raising `limit`
 * on a char-budget cut only makes the overflow worse. The pre-#809 tail listed both
 * ("raise limit/max_chars") and left the caller to guess which one applied — and the
 * orchestrator twin listed only `limit`, which is outright wrong on the budget path.
 * Name the cap that ACTUALLY fired, with its REAL ceiling, and say plainly that the
 * other one will not help, so nobody can burn a retry proving "the tool can't do this".
 *
 * `truncatedBy` is "limit" | "max_chars"; `caps` carries the values in force.
 */
export function truncationTail(shown, matchedCount, hasExplicitIds, truncatedBy, caps = {}) {
  const at = (v) => (typeof v === "number" && Number.isFinite(v) ? `=${v}` : "");
  const byLimit = truncatedBy === "limit";
  const inForce = byLimit ? caps.limit : caps.maxChars;
  const ceiling = byLimit ? LIMIT_CEILING : MAX_CHARS_CEILING;
  const param = byLimit ? "limit" : "max_chars";
  // "raise X up to N" is itself a dead retry at N (codex gate) — at the ceiling the
  // remedy has to switch to what is actually left.
  const raise =
    typeof inForce === "number" && inForce >= ceiling
      ? `\`${param}\` is already at its ceiling of ${ceiling}, so raising it is not an option`
      : `raise \`${param}\` up to ${ceiling}`;
  const other = byLimit
    ? "`max_chars` is not the constraint here."
    : "Raising `limit` will not help.";
  const narrow = hasExplicitIds
    ? "request fewer `ids` at once"
    : 'narrow with `types`/`where`/`ids`/`depth`, or count with `group_by`:"type"';
  const cutBy = `\`${param}\`${at(inForce)}${!byLimit && hasExplicitIds ? " (per-field values are already capped)" : ""}`;
  const subject = hasExplicitIds ? " requested node(s)" : "";
  return `\n… truncated at ${shown} of ${matchedCount}${subject} by ${cutBy} — ${raise}, or ${narrow}. ${other}`;
}

/** #809: clip() for the COMPACT projection, reporting whether it actually cut — so ONE
 *  footer note can name the lever (`fields`:"detail") instead of leaving a bare "…" on
 *  every value. The 60-char clip itself is FIXED; no parameter raises it. */
export function clipCompactValue(v, n = COMPACT_VALUE_CLIP) {
  const s = String(typeof v === "string" ? v : JSON.stringify(v) ?? "").replace(/\s+/g, " ");
  return s.length > n ? { text: s.slice(0, n - 1) + "…", clipped: true } : { text: s, clipped: false };
}

/** #809: the one-line footer for compact rows whose values were clipped. */
export function compactClipNote(count) {
  if (!count) return "";
  return `\n(${count} widget value(s) clipped to ${COMPACT_VALUE_CLIP} chars by \`fields\`:"compact" — read fuller values with \`fields\`:"detail", which caps values at ${WIDGET_VALUE_CAP} chars.)`;
}

// ---------------------------------------------------------------------------
// #809: panel_graph_outline's budget — degrade by RESOLUTION, never by coverage.
// ---------------------------------------------------------------------------
//
// The outline exists so an agent can UNDERSTAND a whole graph; a budget that stopped
// partway would defeat that outright. Half a map is not a smaller map: an agent handed
// the first 200 of 690 nodes cannot tell what it is missing and will reason confidently
// about a graph it has seen a third of. So every rung below still describes the WHOLE
// graph, and the ladder sheds DETAIL:
//
//   0 "full"     — every node, widgets + wiring (today's outline)
//   1 "no_values"— every node, widget NAMES only (values are the bulk of the bytes)
//   2 "no_widgets" — every node, id/type/title/mode/group + wiring
//   3 "ids_only" — every node, id + type only, wiring dropped
//   4 "groups"   — per-group counts and representative types; the floor
//
// If even rung 4 does not fit, that is a REFUSAL with a stated reason, not a partial
// dump — see outlineFloorRefusal().
export const OUTLINE_MAX_CHARS_FLOOR = MAX_CHARS_FLOOR;
export const OUTLINE_MAX_CHARS_DEFAULT = 24000;
export const OUTLINE_MAX_CHARS_CEILING = MAX_CHARS_CEILING;

/** The ladder, most detailed first. Exported for the panel executor and its tests. */
export const OUTLINE_DETAIL_LEVELS = ["full", "no_values", "no_widgets", "ids_only", "groups"];

/** Clamp an outline budget to the SAME window panel_query_graph uses. */
export function clampOutlineMaxChars(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return OUTLINE_MAX_CHARS_DEFAULT;
  return Math.min(Math.max(Math.floor(n), OUTLINE_MAX_CHARS_FLOOR), OUTLINE_MAX_CHARS_CEILING);
}

/** The banner that rides ON the outline itself when a rung below "full" was used. It
 *  must state the TRUE shape (counts are always real) and the lever, because the
 *  outline string is often the only part of the reply a model reads closely. */
export function outlineDegradeBanner({ level, nodeCount, groupCount, maxChars }) {
  const why = {
    no_values: "widget VALUES dropped (names kept)",
    no_widgets: "widgets dropped entirely (wiring kept)",
    ids_only: "reduced to id + type per node (wiring dropped)",
    groups: "collapsed to a per-group summary",
  }[level];
  if (!why) return "";
  return (
    `⚠ REDUCED DETAIL (${level}): ${why}, to fit \`max_chars\`=${maxChars}. ` +
    `COVERAGE IS COMPLETE — all ${nodeCount} node(s) and ${groupCount} group(s) are represented and these counts are exact; ` +
    `nothing was cut off the end. ` +
    (maxChars >= OUTLINE_MAX_CHARS_CEILING
      ? `\`max_chars\` is already at its ceiling of ${OUTLINE_MAX_CHARS_CEILING}, so this is the most detail one call can carry — `
      : `Raise \`max_chars\` up to ${OUTLINE_MAX_CHARS_CEILING} for more detail, or `) +
    `read specific nodes with panel_query_graph {ids:[…], fields:'detail'}.`
  );
}

/** #809: even the FULL outline rung clips each widget value at a fixed 60 chars. That
 *  clip has no lever, so the note names the tool that carries fuller values instead of
 *  pretending `max_chars` would help — the outline's coverage claim is about NODES, and
 *  this keeps it from reading as a claim about VALUES too. */
/**
 * #809: ONE footer covering every fixed per-field clip in the outline — widget values
 * and titles alike. Per-field markers would be noise at 690 nodes; the count plus the
 * lever belongs here, once.
 *
 * "Read FULL values" would over-promise: panel_query_graph's detail projection has its
 * own fixed 2048-char per-widget cap (codex gate). Say "fuller, up to N".
 */
export function outlineValueClipNote(valueCount, titleCount = 0) {
  if (!valueCount && !titleCount) return "";
  const parts = [];
  if (valueCount) parts.push(`${valueCount} widget value(s) clipped to ${COMPACT_VALUE_CLIP} chars`);
  if (titleCount) parts.push(`${titleCount} title(s) clipped to ${OUTLINE_TITLE_CAP} chars`);
  return `\n\n(${parts.join(" and ")} — fixed outline caps that \`max_chars\` does not raise. Read fuller values with panel_query_graph {ids:[…], fields:'detail'}, which caps each value at ${WIDGET_VALUE_CAP} chars.)`;
}

/** Group/subgraph titles are user-controlled and unbounded. */
export const OUTLINE_TITLE_CAP = 120;

/** #809: group/subgraph/node TITLES are user-controlled and unbounded, so an outline
 *  built from them could breach `max_chars` no matter which rung the ladder chose (codex
 *  gate). Every title that reaches the outline goes through here first.
 *
 *  Returns `{ text, clipped }` rather than a bare string so the caller can COUNT the
 *  clips and raise the one footer above — a bare "…" per title would be exactly the
 *  signal-free marker this issue exists to remove. Two long titles sharing a 120-char
 *  prefix become indistinguishable in the per-node `group:` tag; group MEMBERSHIP is
 *  keyed by node id and is unaffected, and the GROUPS index still lists ids per group,
 *  so nothing downstream resolves a group by its displayed label. */
export function clipOutlineTitle(title, cap = OUTLINE_TITLE_CAP) {
  const s = String(title ?? "").replace(/\s+/g, " ");
  return s.length > cap ? { text: `${s.slice(0, cap)}…`, clipped: true } : { text: s, clipped: false };
}

/** When not even the group-level floor fits, refuse WITH the true shape rather than
 *  emitting a partial graph that reads as complete (#809). */
export function outlineFloorRefusal({ nodeCount, groupCount, maxChars, floorChars }) {
  // #809 (codex gate): raising to the ceiling is only a remedy if the ceiling could
  // actually hold the floor. On a graph whose per-group summary alone exceeds 60000,
  // "raise max_chars up to 60000" is a guaranteed second refusal — a dead retry inside
  // the message explaining the first one.
  const unreachable = Number.isFinite(floorChars) && floorChars > OUTLINE_MAX_CHARS_CEILING;
  const remedy = unreachable
    ? `Even \`max_chars\`'s ceiling of ${OUTLINE_MAX_CHARS_CEILING} could not hold it, so raising it will NOT produce an outline for this graph — read it in parts with panel_query_graph (filter by types/where, or by group member ids).`
    : maxChars >= OUTLINE_MAX_CHARS_CEILING
      ? `\`max_chars\` is already at its ceiling of ${OUTLINE_MAX_CHARS_CEILING}, so query a subset with panel_query_graph instead.`
      : `Raise \`max_chars\` (up to ${OUTLINE_MAX_CHARS_CEILING}), or query a subset with panel_query_graph.`;
  return (
    `⚠ CANNOT RENDER an outline within \`max_chars\`=${maxChars}: the smallest whole-graph ` +
    `form (a per-group summary) needs ~${floorChars} chars for this graph's ${nodeCount} node(s) ` +
    `and ${groupCount} group(s). A PARTIAL outline is deliberately NOT returned — it would look ` +
    `complete and it is not. ${remedy}`
  );
}
