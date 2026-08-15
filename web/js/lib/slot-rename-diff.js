/**
 * #636 — report user RENAMES of slots and promoted subgraph widgets in the
 * MANUAL CANVAS CHANGES block.
 *
 * The readers already surface a renamed slot's display `label` alongside its
 * addressable `name`. The turn-start diff did not: it compared node add/remove,
 * `mode`, `title`, `widgets_values` and links, and nothing else. So a session
 * where the user renamed a subgraph's promoted widgets to `Filename` / `project?`
 * / `project` reported only an unrelated widget VALUE change
 * (`MiniMax_H3 -> MM3`) and said nothing about the renames — which, in the
 * reporter's words, "reinforced the wrong conclusion" that the renames had not
 * stuck. They had; a screenshot was the only thing that settled it.
 *
 * A rename is a real, intentional edit that changes what the user sees on the
 * canvas while leaving the addressable name untouched. Reporting the value
 * change but not the rename is the worst of both: it proves the diff was
 * running, so its silence reads as evidence of absence.
 *
 * MATCHED BY NAME, NOT INDEX. `name` is the addressable identity and is exactly
 * what a rename leaves alone; slot order is not stable across an edit that adds
 * or removes a slot, so index-matching would report a spurious rename for every
 * slot after an insertion.
 */

/** The display label a serialized slot carries, or null when it has none.
 *  A label equal to the name is not a rename — ComfyUI writes the label
 *  redundantly in some paths, and reporting that as a change would emit a line
 *  for an edit the user never made. */
function slotLabel(slot) {
  if (!slot || typeof slot !== "object") return null;
  const label = slot.label;
  if (typeof label !== "string" || label === "") return null;
  return label === slot.name ? null : label;
}

/** Index a serialized slot array by name. Unnamed slots are skipped: without a
 *  stable identity a rename cannot be attributed to one. */
function byName(slots) {
  const out = new Map();
  if (!Array.isArray(slots)) return out;
  for (const slot of slots) {
    const name = slot?.name;
    if (typeof name !== "string" || !name) continue;
    if (!out.has(name)) out.set(name, slot); // first wins; duplicates are ambiguous
  }
  return out;
}

function describe(label) {
  return label == null ? "(default)" : `"${label}"`;
}

/**
 * Rename lines for one node between two serialized snapshots.
 *
 * @param {object} prev serialized node BEFORE
 * @param {object} curr serialized node AFTER
 * @param {string} nodeLabel the caller's already-formatted `id type "title"` prefix
 * @returns {string[]} zero or more `• <node>: input "name" renamed …` lines
 *
 * Only slots present in BOTH snapshots are compared: a slot that just appeared
 * or vanished is an add/remove, already reported as a wiring or node change, and
 * announcing it as a rename would be wrong.
 */
export function slotRenameLines(prev, curr, nodeLabel) {
  const lines = [];
  for (const [kind, key] of [
    ["input", "inputs"],
    ["output", "outputs"],
  ]) {
    const before = byName(prev?.[key]);
    const after = byName(curr?.[key]);
    for (const [name, currSlot] of after) {
      const prevSlot = before.get(name);
      if (!prevSlot) continue;
      const a = slotLabel(prevSlot);
      const b = slotLabel(currSlot);
      if (a === b) continue;
      // The addressable name is repeated deliberately: a rename changes what the
      // user sees, NOT what panel_set_widget / panel_connect must address, and an
      // agent that switches to the new label would start failing.
      lines.push(
        `• ${nodeLabel}: ${kind} "${name}" renamed ${describe(a)} → ${describe(b)} ` +
          `(display only — still addressed as "${name}")`,
      );
    }
  }
  return lines;
}
