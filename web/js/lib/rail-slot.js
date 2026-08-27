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
/**
 * #1953 — panel_connect to a raw rail id used to silently AUTO-EXPOSE.
 *
 * `panel_connect({ from_node_id: 2, from_output: "LATENT", to_node_id: -20 })`
 * inside a subgraph returned `{ exposed: { name: "LATENT", … } }` and minted a
 * new boundary slot. panel_expose_subgraph_output documents "do NOT
 * panel_connect to a guessed rail node id"; panel_unexpose_subgraph_output
 * documents that a rail_node_id "is forwarded to the panel, which REFUSES it".
 * The refusal did not exist — a typo'd to_node_id that happened to hit a rail
 * mutated the subgraph's public interface with no error.
 *
 * Connecting to an EXISTING named rail slot is still a connect (the slot is
 * already on the boundary). This refusal is only the fallthrough that used to
 * call graph_expose_subgraph_* — the caller must use the expose tool instead.
 *
 * Throws rather than returning a message: a fallthrough that "handles" the
 * Error object would re-introduce the silent mutate.
 *
 * @param {number|string} ref  the to_node_id / from_node_id that resolved as a rail
 * @param {"input"|"output"} side
 * @returns {never}
 */
export function refuseConnectToRawRail(ref, side) {
  const tool =
    side === "input" ? "panel_expose_subgraph_input" : "panel_expose_subgraph_output";
  const what = side === "input" ? "input" : "output";
  throw new Error(
    `Id ${ref} is a rail_node_id — the synthetic id of the WHOLE ${side} RAIL, not of a ` +
      `slot on it. panel_connect REFUSES it: do NOT panel_connect to a guessed rail node id. ` +
      `Use ${tool} with the interior node + the ${what} you want exposed. Nothing was exposed.`,
  );
}

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

/**
 * #1969 — after subgraph.removeInput/removeOutput splices a non-last rail slot,
 * host SubgraphNode slots shift in lockstep but remaining parent-graph links
 * keep the OLD origin_slot/target_slot. Readers (query/outline) look at
 * `node.inputs[i].link` and still see a wire; graphToPrompt uses the link
 * record's slot index and reports `Required input is missing`.
 *
 * Sync survivors to the live positional index. Do NOT disconnect/reconnect:
 * #668 saw a SubgraphNode disconnect cascade delete unrelated nodes. Idempotent
 * if the frontend already reindexed. Never throws — the unexpose has landed.
 */
export function reindexHostRailLinks(rootGraph, subgraph, side, removedIndex) {
  if (!rootGraph || !subgraph || (side !== "input" && side !== "output")) return;
  if (!Number.isInteger(removedIndex) || removedIndex < 0) return;
  try {
    const stack = [{ graph: rootGraph, nodes: rootGraph._nodes ?? [] }];
    while (stack.length) {
      const frame = stack.pop();
      const graph = frame?.graph;
      for (const node of frame?.nodes ?? []) {
        if (!node) continue;
        if (node.subgraph === subgraph) {
          if (side === "input") reindexHostInputLinks(node, graph, removedIndex);
          else reindexHostOutputLinks(node, graph, removedIndex);
        }
        if (node.subgraph?._nodes?.length) {
          stack.push({ graph: node.subgraph, nodes: node.subgraph._nodes });
        }
      }
    }
  } catch {
    /* a landed unexpose must not become a throw because a host walk failed */
  }
}

function readHostGraphLink(node, graph, linkId) {
  if (linkId == null) return null;
  const stores = [node?.graph, graph];
  for (const g of stores) {
    if (!g) continue;
    try {
      if (typeof g.getLink === "function") {
        const stored = g.getLink(linkId);
        if (stored != null) return stored;
      }
      const links = g.links;
      if (!links) continue;
      const stored = typeof links.get === "function" ? links.get(linkId) : links[linkId];
      if (stored != null) return stored;
    } catch {
      /* try the next store */
    }
  }
  return null;
}

function linkEndpointId(link, role) {
  if (link == null) return null;
  if (Array.isArray(link)) return role === "origin" ? link[1] : link[3];
  return role === "origin" ? (link.origin_id ?? link.originId) : (link.target_id ?? link.targetId);
}

function setLinkSlotIndex(link, role, index) {
  const prop = role === "origin" ? "origin_slot" : "target_slot";
  const arrIdx = role === "origin" ? 2 : 4;
  if (Array.isArray(link)) {
    if (link.length > arrIdx) link[arrIdx] = index;
    if (Object.prototype.hasOwnProperty.call(link, prop)) link[prop] = index;
    return;
  }
  if (link && typeof link === "object") link[prop] = index;
}

function reindexHostInputLinks(node, graph, removedIndex) {
  const inputs = node?.inputs;
  if (!Array.isArray(inputs)) return;
  for (let i = removedIndex; i < inputs.length; i++) {
    const linkId = inputs[i]?.link;
    if (linkId == null) continue;
    const link = readHostGraphLink(node, graph, linkId);
    if (!link) continue;
    const targetId = linkEndpointId(link, "target");
    if (targetId == null || String(targetId) !== String(node.id)) continue;
    setLinkSlotIndex(link, "target", i);
  }
}

function reindexHostOutputLinks(node, graph, removedIndex) {
  const outputs = node?.outputs;
  if (!Array.isArray(outputs)) return;
  for (let i = removedIndex; i < outputs.length; i++) {
    for (const linkId of outputs[i]?.links ?? []) {
      if (linkId == null) continue;
      const link = readHostGraphLink(node, graph, linkId);
      if (!link) continue;
      const originId = linkEndpointId(link, "origin");
      if (originId == null || String(originId) !== String(node.id)) continue;
      setLinkSlotIndex(link, "origin", i);
    }
  }
}
