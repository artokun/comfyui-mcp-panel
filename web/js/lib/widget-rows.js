// WIDGET ROWS THAT SHARE ONE NAME (#1402).
//
// Every structured read reports a node's widgets as a name-keyed object:
//
//     const widgets = {};
//     for (const w of node.widgets ?? []) widgets[w.name] = w.value;
//
// That shape assumes widget names are UNIQUE. They are not. rgthree's Fast Groups
// Bypasser/Muter names EVERY group-toggle row `RGTHREE_TOGGLE_AND_NAV`, so a node
// rendering N toggle rows reports exactly ONE entry — the last one wins and the rest
// vanish without trace.
//
// The damage is not that the read is lossy, it is that the read looks HEALTHY. A
// reporter added a Fast Groups Bypasser matching two groups, the canvas rendered two
// rows, and every `panel_query_graph {fields:'detail'}` came back with a single tidy
// `RGTHREE_TOGGLE_AND_NAV` entry and a single `widget_labels` entry. On the strength of
// that read they told the user the node's DATA was correct and only the canvas draw was
// stale — the exact opposite of the truth — and shipped a fix that could not work. The
// collapsed map gave no hint that more than one widget had contributed to it, so there
// was no way to detect the real state short of asking for a screenshot.
//
// The correction is ADDITIVE and strictly OBSERVED, for the same reason #636's was:
//   * the name-keyed map stays exactly as it is. It is what panel_set_widget addresses
//     and what every existing caller parses; re-shaping it to an array would break them
//     all to fix a case that most nodes never hit.
//   * a duplicate report is emitted ONLY when a name is genuinely carried by more than
//     one widget. A node with unique widget names — which is nearly all of them — reads
//     byte-identical to before, so this costs nothing on the common path.
//   * nothing is inferred or de-duplicated. Every occurrence is reported, in the array
//     order the canvas renders, including occurrences whose value and label are equal.
//     Two identical rows ARE the bug in the reported case; collapsing them here would
//     reintroduce it one layer up.
//
// Extracted so the derivation is unit-tested against the SAME code summarizeNode runs.

import { displayLabel } from "./slot-labels.js";
import { redactWidgetValue } from "./widget-secret-redaction.js";

/**
 * Map of widget NAME → every widget carrying that name, for names carried by MORE THAN
 * ONE widget, and only those. Empty object when every name is unique, so a caller can
 * omit the key entirely rather than emit an empty map on every node.
 *
 * Each occurrence reports:
 *   * `index` — position in `node.widgets`, i.e. the order the canvas renders the rows.
 *     Positional only: widgets are addressed by NAME, and a repeated name cannot be
 *     addressed unambiguously at all, which is itself worth knowing.
 *   * `label` — the display label this occurrence carries, when it carries a distinct
 *     one (#636 rules, via displayLabel). Omitted when it carries none. The occurrences
 *     of one name routinely carry DIFFERENT labels — the rgthree toggle rows are named
 *     alike and labelled per group — and the name-keyed `widget_labels` map can hold
 *     only one of them.
 *   * `value` — this occurrence's own agent-facing value; credential-shaped values are
 *     redacted, while ordinary values remain as stored.
 *
 * Occurrences are in canvas order, so the LAST entry for a name is the one the
 * name-keyed `widgets` map ended up holding; the earlier ones are what it dropped.
 *
 * The name filter matches the name-keyed map's own (`typeof w.name === "string"`), so
 * this reports duplicates of exactly the names that map can collapse — no more, no less.
 *
 * Accumulated in a Map and materialised with Object.fromEntries, NOT by assigning into
 * a plain object: a widget name is arbitrary third-party data, and `bucket["__proto__"]`
 * reads back Object.prototype rather than a missing key, so the obvious
 * `(out[name] ??= []).push(…)` THROWS on a node with two widgets named `__proto__`,
 * `constructor` or `toString`. A read that throws is worse than the collapsed read this
 * replaces — it takes the whole node's detail with it. Object.fromEntries creates a
 * genuine own property for every key, including those.
 */
export function duplicateWidgetRows(node) {
  const named = [];
  const widgets = node?.widgets ?? [];
  for (let i = 0; i < widgets.length; i++) {
    const w = widgets[i];
    if (w && typeof w.name === "string") named.push({ index: i, widget: w });
  }
  const counts = new Map();
  for (const { widget } of named) counts.set(widget.name, (counts.get(widget.name) ?? 0) + 1);
  const out = new Map();
  for (const { index, widget } of named) {
    if ((counts.get(widget.name) ?? 0) < 2) continue;
    const label = displayLabel(widget);
    if (!out.has(widget.name)) out.set(widget.name, []);
    out.get(widget.name).push({
      index,
      ...(label != null ? { label } : {}),
      value: redactWidgetValue(widget.name, widget.value),
    });
  }
  return Object.fromEntries(out);
}
