/**
 * #1114 — resolving a subgraph boundary-rail slot by NAME or INDEX.
 *
 * `panel_connect({ from_node_id: -10, from_output: 4, … })` inside a subgraph
 * created a NEW rail input literally named "4" instead of reusing rail output 4.
 * The reply even said `exposed` rather than `connected`, because the caller read
 * "no such slot" and fell through to graph_expose_subgraph_input. The rail then
 * permanently carried a bogus input, which also appeared as a junk slot on the
 * parent subgraph node.
 *
 * The lookup gated its INDEX branch on `typeof ref === "number"`, and MCP argument
 * coercion delivers `from_output: 4` as the string "4". So the index was never
 * tried, the name lookup found nothing, and the caller minted a slot. A lookup that
 * failed closed would have been a refusal; this one edited the user's subgraph.
 *
 * Extracted here so the rule is testable directly: the same defect in the id
 * validator earlier (#1425) was only caught because the decision had somewhere to
 * be asserted from.
 */

/**
 * A slot INDEX from a number or a canonical numeric string, else null.
 *
 * Deliberately strict: "4" yes; " 4 ", "4.0", "0x4", "-1" and leading-zero forms
 * like "04"/"007" no — those are names, not indices. A loose
 * parse would turn a mistyped NAME into a silent index hit on an unrelated slot —
 * connecting to the wrong input, which is worse than the visible junk slot this
 * fixes.
 */
export function railSlotIndex(ref) {
  if (typeof ref === "number") {
    // isSafeInteger, not isInteger: 2**53 is an "integer" that cannot index
    // anything meaningfully, and it slipped through until a test asked.
    return Number.isSafeInteger(ref) && ref >= 0 ? ref : null;
  }
  // CANONICAL, not merely digits (codex review): /^\d+$/ accepts "04" and "007",
  // so a caller passing a name-shaped "007" with no slot of that name would have
  // been silently connected to index 7 — the same class of silent wrong-target
  // this fix exists to remove, in a narrower window.
  if (typeof ref !== "string" || !/^(?:0|[1-9]\d*)$/.test(ref)) return null;
  const n = Number(ref);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The existing rail slot `ref` names, or null — and a THROW when it could be two.
 *
 * There is NO precedence between name and index, and saying "name first" would
 * describe one that does not exist: when both match the SAME slot the order cannot
 * matter, and when they match DIFFERENT slots this refuses rather than picking
 * (codex review). A mutation swapping the two proved it — it changed nothing,
 * which is the only honest reading of code that has no ordering left. A rail whose slots are digit-named out
 * of index order — `[{name:"1"}, {name:"0"}]` — makes `from_output: 1` mean either
 * the slot called "1" (index 0) or index 1 (called "0"), and the wire cannot tell
 * which the caller meant: MCP coercion flattens the number 4 and the string "4" to
 * the same value before this is reached.
 *
 * Guessing there is a silent connection to the wrong input, which is the failure
 * class this whole fix exists to remove. A refusal is recoverable and says what to
 * do; a wrong link is neither.
 */
export function findExistingRailSlot(slots, ref) {
  if (ref == null) return null;
  const list = slots ?? [];
  const name = String(ref).toLowerCase();
  const byName = list.find((s) => s?.name?.toLowerCase() === name) ?? null;
  const idx = railSlotIndex(ref);
  const byIndex = idx !== null && idx < list.length ? list[idx] : null;
  if (byName && byIndex && byName !== byIndex) {
    const namedIdx = list.indexOf(byName);
    throw new Error(
      `"${ref}" is ambiguous on this boundary rail: a slot is NAMED "${byName.name}" ` +
        `(at index ${namedIdx}), and index ${idx} is a different slot ` +
        `(named "${byIndex.name ?? "unnamed"}"). This rail has digit-named slots that do not ` +
        `sit at the matching index, and nothing here can tell which one you meant — the value ` +
        `arrives as a string either way. Rename the digit-named slot to something that is not ` +
        `a number, and this becomes unambiguous for every caller.`,
    );
  }
  // Whichever matched; they cannot disagree by the time we are here.
  return byName ?? byIndex;
}
