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
export function capWidgetValue(value, cap = WIDGET_VALUE_CAP) {
  if (value == null) return value;
  const isString = typeof value === "string";
  const s = isString ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  if (typeof s !== "string") return value;
  if (JSON.stringify(s).length <= cap) return value;
  // Binary-search the longest raw prefix whose ESCAPED length fits, reserving room
  // for the marker (itself plain ASCII, so its escaped size ≈ its length).
  const target = Math.max(2, cap - 40);
  let lo = 0;
  let hi = s.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (JSON.stringify(s.slice(0, mid)).length <= target) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return `${s.slice(0, best)}…(+${s.length - best} chars, truncated)`;
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
    const capped = capWidgetValue(v, perValueCap);
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
  if (omitted > 0) widgets["…"] = `${omitted} widget(s) omitted (exceeded budget); raise max_chars`;
  return changed ? { ...summary, widgets } : summary;
}

/** Hard-clip an assembled COMPACT (plain-string) line to `maxChars` (#609). The
 *  protected first match bypasses the running budget, so without this a node with
 *  thousands of small widgets could emit an unbounded first line. Plain string, so a
 *  tail ellipsis is safe (unlike detail's JSON, which is bounded via capSummaryWidgets). */
export function clipLine(line, maxChars) {
  if (!Number.isFinite(maxChars) || line.length <= maxChars) return line;
  return line.slice(0, Math.max(0, maxChars - 1)) + "…";
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
    detail_omitted: `full detail is ${line.length} chars > max_chars ${maxChars}; raise max_chars to read this node`,
  });
  if (s.length <= maxChars) return s;
  // Absurdly small budget: a minimal fixed-shape row (id clipped hard) that still identifies the node.
  return JSON.stringify({ id: typeof safe.id === "string" ? safe.id.slice(0, 40) : safe.id, detail_omitted: "raise max_chars" });
}

/** Whether a line must render regardless of the remaining char budget (#609): ONLY
 *  the FIRST match, so a non-empty match never yields `shown:0` (the reported
 *  single-id failure). Deliberately does NOT exempt every requested id — that would
 *  disable the max_chars token bound for a large `ids` list. At most one line (the
 *  first, itself per-value capped) can exceed the budget, keeping output bounded. */
export function isLineProtected(shownSoFar) {
  return shownSoFar === 0;
}

/** Build the truncation-tail advice (#609). When the caller passed explicit `ids`,
 *  "narrow with ids" is a dead end — advise raising max_chars / fewer ids instead. */
export function truncationTail(shown, matchedCount, hasExplicitIds) {
  if (hasExplicitIds) {
    return `\n… truncated at ${shown} of ${matchedCount} — requested nodes exceed max_chars (per-field values are already capped); raise max_chars or request fewer ids at once.`;
  }
  return `\n… truncated at ${shown} of ${matchedCount} — narrow with types/where/ids/depth, use group_by:"type", or raise limit/max_chars.`;
}
