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

/**
 * #1294 — resolving a boundary-rail slot for REMOVAL (unexpose).
 *
 * Removal is destructive — the interior wire and every parent-graph wire on the
 * host node's matching slot go with the slot — so the failure mode that matters
 * here is removing the WRONG one. This refuses rather than guesses:
 *
 *  - an unknown name/index is a refusal naming what IS on the rail, not a no-op
 *    "removed" (the pre-#930 failure shape: report a miss as something else);
 *  - an ambiguous digit-named slot throws out of findExistingRailSlot, same as a
 *    connect;
 *  - a NEGATIVE number is a rail_node_id (e.g. -20) — the synthetic id of the
 *    whole RAIL, never of a slot on it. It is rejected BY NAME, because silently
 *    indexing with it would remove an unrelated slot.
 */
export function resolveRailSlotForRemoval(slots, ref, side) {
  const list = slots ?? [];
  // A negative INTEGER, in either arrival form — MCP argument coercion flattens
  // the number -20 and the string "-20" to the same string before this is reached,
  // so the string form is the one that actually arrives over the wire.
  if ((typeof ref === "number" && ref < 0) || /^-\d+$/.test(String(ref))) {
    throw new Error(
      `"${ref}" is a rail_node_id — the synthetic id of the WHOLE ${side} RAIL, not of a ` +
        `slot on it (the rail node itself is not a removable slot). Pass the slot's NAME or ` +
        `index as panel_query_graph lists it under rails.${side}. Nothing was removed.`,
    );
  }
  // findExistingRailSlot throws the ambiguity refusal itself; a null here is a
  // clean miss.
  const slot = findExistingRailSlot(list, ref);
  if (slot) return slot;
  const names = list.map((s) => s?.name).filter(Boolean);
  throw new Error(
    `No ${side} boundary slot "${ref}" on this subgraph — nothing was removed. ` +
      `Available ${side} slots: ${names.join(", ") || "(none)"} ` +
      `(as panel_query_graph lists them under rails.${side}).`,
  );
}

/**
 * #1294 — how many PARENT-graph wires a boundary-slot removal takes with it:
 * the links on every host SubgraphNode's slot at `slotIndex` (one .link per
 * host input, a .links array per host output). Counted BEFORE the removal so
 * the reply can say what was dropped; the same subgraph can be instanced by
 * several host nodes (and nested), so the walk collects ALL of them.
 */
export function countHostRailLinks(rootGraph, subgraph, side, slotIndex) {
  if (!rootGraph || !subgraph) return 0;
  let count = 0;
  const stack = [...(rootGraph._nodes ?? [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.subgraph === subgraph) {
      if (side === "input") {
        if (node.inputs?.[slotIndex]?.link != null) count++;
      } else {
        count += node.outputs?.[slotIndex]?.links?.length ?? 0;
      }
    }
    if (node.subgraph?._nodes?.length) stack.push(...node.subgraph._nodes);
  }
  return count;
}
