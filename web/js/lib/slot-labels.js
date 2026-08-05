// DISPLAY LABELS for widgets and slots (#636).
//
// A user can RENAME a subgraph's promoted widgets and boundary slots in the ComfyUI UI.
// The rename sets a DISPLAY LABEL; the programmatic NAME (the key panel_set_widget and
// panel_connect address) is unchanged. Every structured reader reported only the name,
// so a rename was invisible to the agent — which then told the user their renames "had
// not stuck" when the canvas plainly showed them. Only a screenshot resolved it.
//
// The correction is purely ADDITIVE and strictly OBSERVED:
//   * the NAME stays exactly where it was — it is the addressable identity, and moving
//     or overwriting it would break every caller that addresses widgets/slots by name;
//   * a `label` is emitted ONLY when the frontend actually carries one AND it DIFFERS
//     from the name. A label equal to the name is not a rename and carries no
//     information; emitting it anyway would make every node look renamed.
//   * nothing is inferred. No label observed ⇒ no `label` key, never a guessed or
//     prettified one — a fabricated label is exactly the failure this fixes, inverted.
//
// Extracted so the label derivation is unit-tested against the SAME code the panel's
// summarizeNode / describeRails run.

/**
 * The DISPLAY label carried by a widget or slot, or null when it carries none / when it
 * is identical to the programmatic name.
 *
 * `nameOverride` lets a caller supply the name the entry is REPORTED under when that
 * differs from the entry's own `name` (a subgraph boundary slot is reported under the
 * host input's name, while its label may live on the backing slot object).
 *
 * The label is TRIMMED before reporting, and the rename test is made on the trimmed
 * form. Surrounding whitespace is not something a user can see on the canvas or type
 * into a rename dialog deliberately, so treating " seed " as a rename of `seed` would
 * report a rename that did not happen — and reporting the untrimmed string would hand
 * the caller a label it cannot match against anything.
 */
export function displayLabel(entry, nameOverride) {
  const raw = entry?.label;
  if (typeof raw !== "string") return null;
  const label = raw.trim();
  if (!label) return null;
  const name = nameOverride != null ? nameOverride : entry?.name;
  if (typeof name === "string" && label === name) return null;
  return label;
}

/**
 * The label a SUBGRAPH BOUNDARY input carries. The rename may be recorded on the host
 * input itself or on the backing subgraph slot (`_subgraphSlot`), depending on frontend
 * version, so both are consulted — host input FIRST, since that is what renders on the
 * outer node the caller is looking at. Returns null when neither carries a distinct one.
 */
export function boundaryInputLabel(input) {
  return displayLabel(input) ?? displayLabel(input?._subgraphSlot, input?.name);
}

/**
 * Map of widget NAME → DISPLAY LABEL for every RENAMED widget on `node`, and only those.
 * Empty object when nothing is renamed, so a caller can omit the key entirely rather
 * than emit an empty map on every node.
 */
export function widgetLabelMap(node) {
  const out = {};
  for (const w of node?.widgets ?? []) {
    if (!w || typeof w.name !== "string") continue;
    const label = displayLabel(w);
    if (label != null) out[w.name] = label;
  }
  return out;
}
