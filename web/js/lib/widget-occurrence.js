// ADDRESSING ONE OF SEVERAL WIDGETS THAT SHARE A NAME (#2143).
//
// `duplicateWidgetRows` (#1402, widget-rows.js) reports every widget that shares a name
// with another, each with a stable `index` and its own display `label`. Its own doc comment
// states the consequence plainly: "widgets are addressed by NAME, and a repeated name
// cannot be addressed unambiguously at all". That was true of the WRITE side too, and it is
// the whole defect this module closes: the read advertised an address the write could not
// take.
//
// The reported shape is an rgthree Fast Groups Bypasser matching two groups. It renders one
// toggle row PER MATCHED GROUP and names every one of them `RGTHREE_TOGGLE_AND_NAV`:
//
//   duplicate_widgets: { RGTHREE_TOGGLE_AND_NAV: [
//     { index: 0, label: "Enable VRAM optimizations 1", value: { toggled: true } },
//     { index: 1, label: "Enable VRAM optimizations 2", value: { toggled: true } } ] }
//
// `panel_set_widget {widget: "RGTHREE_TOGGLE_AND_NAV"}` resolved with
// `widgets.find(w => w.name === wanted)` — the FIRST occurrence, silently, with nothing in
// the reply naming which of the two rows was hit. The second group's toggle had no address
// at all, and on a Bypasser that row's callback is what changes the modes of the group's
// nodes, so "which occurrence" is a real graph mutation, not a cosmetic detail.
//
// TWO ADDRESSES ARE ADDED, both carried by the EXISTING `widget` string — no new tool
// argument, so no schema change on the comfyui-mcp side (#754 makes every panel_* schema
// `.strict()`, and an unknown key would simply be rejected):
//
//   "NAME[i]"   the i-th occurrence of NAME, counting in the same canvas order
//               `duplicate_widgets` reports. Composes with #560 sub-field addressing:
//               "NAME[1].toggled" is the `toggled` field of occurrence 1.
//   "LABEL"     the display label an occurrence carries, when exactly one widget on the
//               node carries it. This is the address the reporter actually reached for.
//
// EXACT-NAME-FIRST IS PRESERVED, for the same reason #560's dotted split preserves it: a
// widget whose own name is literally `foo[1]` still wins, and the bracket is only ever
// interpreted when NO widget carries the requested string. Likewise the label route runs
// LAST — after every name-based route, including the #524 case-insensitive fallback — so
// every address that resolved before this change resolves to the identical widget.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it never invents an occurrence. An out-of-range index
// and an ambiguous label are both LOUD refusals that name the valid addresses, never a
// silent fall back to occurrence 0 — which is the defect, not the remedy.
//
// Dependency-free beyond `displayLabel` (no DOM, no LiteGraph). Unit-testable with plain
// fixtures, and resolved against the SAME `node.widgets` order `duplicateWidgetRows` reads.

import { displayLabel } from "./slot-labels.js";

/** Thrown for an address that PARSED but cannot be honoured (out-of-range index, ambiguous
 *  label). Distinct from "did not resolve", which returns null and leaves the caller's
 *  existing missing-widget refusal in charge. */
export class WidgetAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = "WidgetAddressError";
  }
}

/** `node.widgets` as an array, never throwing on a hostile getter. */
function widgetsOf(node) {
  try {
    const widgets = node?.widgets;
    return Array.isArray(widgets) ? widgets : [];
  } catch {
    return [];
  }
}

function widgetName(widget) {
  try {
    const name = widget?.name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

function widgetLabel(widget) {
  try {
    return displayLabel(widget);
  } catch {
    return null;
  }
}

/** Every widget carrying exactly `name`, in canvas order, with its position in
 *  `node.widgets` — the same `index` `duplicate_widgets` reports. */
function occurrencesOf(node, name) {
  const out = [];
  const widgets = widgetsOf(node);
  for (let i = 0; i < widgets.length; i++) {
    if (widgetName(widgets[i]) === name) out.push({ index: i, widget: widgets[i] });
  }
  return out;
}

/** The display label a row carries right now, or null. Exported so a REFUSAL can name what
 *  is at an index instead of what was expected there — the same reading `widgetAtOccurrence`
 *  compares against, so the message and the decision cannot disagree. */
export function occurrenceLabelOf(widget) {
  return widgetLabel(widget);
}

/**
 * THE ONE DEFINITION of what an occurrence address resolves to, so the write and the
 * readback cannot drift apart. `index` is a POSITION in `node.widgets` — the number
 * `duplicate_widgets` publishes — never an ordinal counted over same-named rows: the two
 * agree only when the duplicated name starts at widget 0, and disagreeing silently is how
 * the write lands on one row while the readback reports another (and, if that other row
 * happens to hold the requested value, acks an uncertain write as verified).
 *
 * Null unless the widget at that position still carries `name`. Beyond that, "is this
 * still the row that was addressed" is answered in the order of how much each answer
 * actually establishes, because the address is resolved before an await and used after it:
 *
 *   1. IDENTITY. `pin.widget` is the row object captured at resolution. If the object at
 *      this position is that object, this is definitively the same row — including when
 *      the rows carry no labels, or identical ones, where nothing else can tell them apart.
 *      If that object is still on the node but somewhere ELSE, the rows were REORDERED and
 *      the index is stale: null, so the write refuses rather than mutating a stranger.
 *   2. LABEL, and it must actually DISCRIMINATE. A rebuild that kept the same number of
 *      rows: a matching label says it put the same row back here, a different one says it
 *      did not — but a label shared by more than one same-named row says nothing at all,
 *      and neither does no label. Once the addressed OBJECT is gone, an inconclusive label
 *      is a REFUSAL, not a pass: the rows cannot be told apart, so writing one of them is a
 *      coin flip, and a coin flip that mutes the wrong group is this whole issue. The
 *      caller re-reads `duplicate_widgets` and addresses it again — cheap, and honest.
 *
 * A pin carrying only an `index` skips both (there is no object and no label to weigh) and
 * lands on name + position: the old behaviour, kept so a bare `{index}` stays usable in
 * fixtures and direct helper calls. Nothing the panel sends is that shape — it always pins
 * the row it resolved.
 *
 * The number of same-named rows is deliberately NOT a third test. It looks like independent
 * evidence and is not: when the label discriminates, the row it names IS the addressed row
 * however many siblings appeared beside it, so refusing on the count is a false refusal;
 * and when the label does not, step 2 has already refused.
 */
export function widgetAtOccurrence(node, name, index, pin = null) {
  if (!Number.isInteger(index) || index < 0) return null;
  const widgets = widgetsOf(node);
  const at = widgets[index];
  if (!at || widgetName(at) !== name) return null;
  const pinned = pin && typeof pin === "object" ? pin : null;
  const rebuilt = !!pinned?.widget && !widgets.includes(pinned.widget);
  if (pinned?.widget) {
    if (at === pinned.widget) return at;
    // The addressed row is still on the node, just not here: the rows were REORDERED and
    // this index is stale.
    if (!rebuilt) return null;
  }
  const sameName = occurrencesOf(node, name);
  if (pinned?.label != null && widgetLabel(at) !== pinned.label) return null;
  // The addressed row OBJECT is gone, so identity established nothing and the label is all
  // that is left. Require it to name exactly ONE of the rows sharing this name; otherwise
  // refuse rather than write whichever row happens to have landed here.
  //
  // `> 1` is the scope on purpose: with exactly one row left carrying the name there is no
  // wrong choice available — a bare-name write would reach that same widget — so refusing
  // would refuse an address that is not actually ambiguous.
  if (rebuilt && sameName.length > 1) {
    const labelNamesOneRow =
      pinned.label != null &&
      sameName.filter((entry) => widgetLabel(entry.widget) === pinned.label).length === 1;
    if (!labelNamesOneRow) return null;
  }
  return at;
}

/**
 * The occurrence report for a widget that has already been resolved: WHICH of the
 * same-named rows this is, and how many there are. Null when the name is unique on the
 * node (the overwhelmingly common shape), so a caller emits nothing rather than a
 * meaningless `{index: 0, of: 1}` on every ordinary write.
 *
 * `index` is the widget's position in `node.widgets` — the SAME number
 * `duplicate_widgets` publishes, and the same number `"NAME[i]"` takes, so the reply
 * round-trips straight back into an address. It is deliberately NOT a compact ordinal
 * counted over same-named rows only: those two numbers agree exactly when the duplicated
 * name starts at widget 0 and disagree silently otherwise, which would have made this
 * field and `duplicate_widgets` contradict each other on any node with a leading widget.
 * `of` is how many widgets share the name.
 *
 * Located by IDENTITY, never by name — the point is to report which of several identical
 * names was chosen, so a name lookup here would answer its own question wrong.
 */
export function widgetOccurrenceOf(node, widget, expectedName = null) {
  const name = widgetName(widget);
  if (name == null) return null;
  // #2143 — the reply that carries this also carries a `widget` NAME, and the two must
  // describe the same thing. A node's `onWidgetChanged` hook can RENAME the widget after the
  // write, while the reported name stays the pre-hook one (#1519); counting rows under the
  // new name would then publish `{index, of}` about a name the reply never mentions, and
  // replaying `oldName[index]` would address something else entirely. Caller passes the name
  // it is going to report; a widget that no longer carries it has no address under it.
  if (expectedName != null && name !== expectedName) return null;
  const same = occurrencesOf(node, name);
  if (same.length < 2) return null;
  const hit = same.find((entry) => entry.widget === widget);
  if (!hit) return null;
  const label = widgetLabel(widget);
  return { index: hit.index, of: same.length, ...(label != null ? { label } : {}) };
}

/** `"NAME[3]"` -> `{ base: "NAME", index: 3 }`; anything else -> null. The index is a plain
 *  non-negative decimal integer: no sign, no whitespace, no exponent, and bounded so a
 *  pathological `NAME[999999999999]` is a refusal about a range rather than an allocation. */
export function parseOccurrenceSelector(segment) {
  if (typeof segment !== "string") return null;
  const match = /^(.+)\[(\d{1,6})\]$/.exec(segment);
  if (!match) return null;
  const base = match[1];
  if (!base) return null;
  const index = Number(match[2]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { base, index };
}

/** The addresses that WOULD work, for a refusal that has to name them. Bounded so a node
 *  with many rows cannot turn one refusal into a wall of text. */
function describeOccurrences(name, occurrences, limit = 8) {
  const shown = occurrences.slice(0, limit).map(({ index, widget }) => {
    const label = widgetLabel(widget);
    return `"${name}[${index}]"${label != null ? ` (${label})` : ""}`;
  });
  const rest = occurrences.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");
}

/**
 * A one-line disclosure of every duplicated name on `node`, for the missing-widget
 * refusal. Empty string when no name repeats, so the refusal a node with unique widget
 * names produces is byte-identical to what it produced before.
 */
export function duplicateAddressHint(node) {
  const widgets = widgetsOf(node);
  const counts = new Map();
  for (const w of widgets) {
    const name = widgetName(w);
    if (name == null) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const duplicated = [...counts.keys()].filter((name) => counts.get(name) > 1);
  if (!duplicated.length) return "";
  const parts = duplicated.slice(0, 4).map((name) => describeOccurrences(name, occurrencesOf(node, name)));
  return (
    ` This node carries widgets that SHARE a name, so a bare name addresses only the first:` +
    ` ${parts.join("; ")}.` +
    ` Address one by occurrence ("NAME[1]", which composes with sub-fields as "NAME[1].field")` +
    ` or by its distinct display label. panel_query_graph's duplicate_widgets reports the same` +
    ` indexes and labels (#2143).`
  );
}

/**
 * The occurrence a parsed `NAME[i]` selector names, or null when NO widget on the node
 * carries `NAME` at all (so the caller can try its other routes). An index that names no
 * row of a name the node DOES carry is a loud refusal: falling back to another row is the
 * defect this module exists to remove.
 */
function pinnedOccurrence(node, selector) {
  const occurrences = occurrencesOf(node, selector.base);
  if (!occurrences.length) return null;
  const at = occurrences.find((entry) => entry.index === selector.index);
  if (at) return at;
  throw new WidgetAddressError(
    `Node ${node?.id} (${node?.type}) carries no widget named "${selector.base}" at index ` +
      `${selector.index}. The index is the widget's position in the node, the same one ` +
      `panel_query_graph's duplicate_widgets reports — valid here: ` +
      `${describeOccurrences(selector.base, occurrences)}. Nothing was written.`,
  );
}

/**
 * Resolve the caller's `widget` string to a CANONICAL widget name plus, when the caller
 * addressed a specific one of several same-named widgets, the occurrence to write.
 *
 * Returns null when nothing here applies — the string is not an occurrence selector and
 * matches no unique label — so the caller's existing resolution (exact name, #524
 * case-insensitive fallback, #560 dotted sub-field, and finally the missing-widget
 * refusal) runs completely unchanged.
 *
 * Returns `{ name, occurrence }` otherwise:
 *   * `name` is what every downstream name-keyed lookup, classifier and refusal should use
 *     — the widget's REAL name, never the selector or the label. This matters for more than
 *     tidiness: `classifyRgthreeFastGroupsWrite` and friends key on the widget NAME, so
 *     resolving a label here and passing the label onward would let a label address slip
 *     past a name-keyed safety refusal.
 *   * `occurrence` is `{ index, label, widget }` — or null, which is every address that is
 *     not explicitly occurrence-scoped, and so every call that existed before #2143.
 *       - `index` is the widget's position in `node.widgets`, the SAME number
 *         `duplicate_widgets` publishes, so a reported index pastes straight back.
 *       - `widget` is the row OBJECT, held only to be COMPARED — never written through, so
 *         it cannot become the stale-target hazard #458 is about. It is the definitive
 *         answer to "is this still the row I addressed", and the only one that works when
 *         the rows are indistinguishable by label.
 *       - `label` is the display label that row carried at resolution (null when it carries
 *         none). It is the FALLBACK for the case identity cannot cover: a rebuild that
 *         replaces the row objects but keeps the rows, which is what an rgthree Fast Groups
 *         node does whenever the groups it matches change.
 *     An index is a position, and a position is only as good as the list it indexes — the
 *     write happens after an `await getFreshObjectInfo()`. Carrying identity AND label lets
 *     the write tell "same row" from "a different row that moved into that slot".
 *
 * Throws WidgetAddressError for an address that parsed but cannot be honoured.
 */
export function resolveWidgetAddress(node, requested) {
  if (typeof requested !== "string" || requested === "") return null;
  const widgets = widgetsOf(node);
  if (!widgets.length) return null;
  const plain = (name) => ({ name, occurrence: null });
  const pin = (name, at) => ({
    name,
    occurrence: { index: at.index, label: widgetLabel(at.widget), widget: at.widget },
  });

  // 1. EXACT NAME on the whole string — brackets, dots and all. Never rewritten, and no
  //    occurrence is pinned: this is the address that already worked.
  if (occurrencesOf(node, requested).length) return plain(requested);

  // 2. OCCURRENCE SELECTOR on the WHOLE string, before any dotted split. A widget name may
  //    itself contain dots (#560 exists because of that, and #2140's DynamicCombo children
  //    are `format.codec.encoding.crf`), so splitting first would make a duplicated DOTTED
  //    name unaddressable: `foo.bar[1]` would look for a widget called `foo`, find none, and
  //    refuse — while duplicate_widgets happily reported two `foo.bar` rows. Ordered ahead of
  //    the dotted base for the same reason exact-name-first is: a widget that really is
  //    called `foo.bar` outranks splitting the string at `foo`.
  const wholeSelector = parseOccurrenceSelector(requested);
  if (wholeSelector) {
    const at = pinnedOccurrence(node, wholeSelector);
    if (at) return pin(wholeSelector.base, at);
  }

  const dot = requested.indexOf(".");
  const head = dot > 0 ? requested.slice(0, dot) : requested;
  const tail = dot > 0 ? requested.slice(dot) : "";

  // 3. EXACT NAME on the #560 dotted BASE — likewise already worked, likewise untouched.
  if (dot > 0 && occurrencesOf(node, head).length) return plain(requested);

  // 4. OCCURRENCE SELECTOR on the head segment: "NAME[1].field".
  const selector = dot > 0 ? parseOccurrenceSelector(head) : null;
  if (selector) {
    const at = pinnedOccurrence(node, selector);
    if (at) return pin(`${selector.base}${tail}`, at);
  }

  // 5. DISPLAY LABEL — last, and only for the WHOLE string, so it can never pre-empt a
  //    name-based route. Skipped when a name matches case-insensitively, which keeps the
  //    #524 fallback the thing that decides that case, exactly as it does today.
  const lowered = requested.toLowerCase();
  for (const w of widgets) {
    const name = widgetName(w);
    if (name != null && name.toLowerCase() === lowered) return null;
  }
  const labelled = widgets.filter((w) => widgetLabel(w) === requested);
  if (!labelled.length) return null;
  if (labelled.length > 1) {
    const names = labelled.map((w) => widgetName(w) ?? "(unnamed)");
    throw new WidgetAddressError(
      `Node ${node?.id} (${node?.type}) has ${labelled.length} widgets whose display label is ` +
        `"${requested}" (named ${[...new Set(names)].join(", ")}), so the label does not say which ` +
        `one you meant. Address it by occurrence instead — panel_query_graph's duplicate_widgets ` +
        `reports the index of each. Nothing was written.`,
    );
  }
  const name = widgetName(labelled[0]);
  if (name == null) return null;
  const occurrences = occurrencesOf(node, name);
  const at = occurrences.find((entry) => entry.widget === labelled[0]);
  if (!at) return null;
  // A label that names a UNIQUE widget still resolves through the ordinary name path —
  // pinning an occurrence there would put an index on a write that never needed one, and
  // needlessly cross the deferral gate below.
  return occurrences.length > 1 ? pin(name, at) : plain(name);
}
