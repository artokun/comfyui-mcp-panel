/**
 * #1273 — cg-use-everywhere (UE) materialises its broadcast links into the
 * prompt AT QUEUE TIME, so the run-to-node graph stamp (#556) could never
 * match on a UE graph: the pre-dispatch serialization (the panel's direct
 * `app.graphToPrompt()` call) has NO UE links, the POST body has them all,
 * and every scoped run was refused as "the graph CHANGED" — on an untouched
 * canvas, with the retry failing identically.
 *
 * THE MECHANISM (read from the pack's own source, chrisgoringe/cg-use-everywhere
 * @ main, js/use_everywhere.js + js/use_everywhere_graph_analysis.js +
 * js/use_everywhere_apply.js; the field report on #1273 is the live
 * observation — every differing entry was a UE broadcast target):
 *
 *  - UE patches `app.graphToPrompt` AND `app.queuePrompt`. Its graphToPrompt
 *    wrapper calls the ORIGINAL unchanged UNLESS `shared.in_queuePrompt` is
 *    set (its queuePrompt patch sets it) or the user enabled
 *    "Use Everywhere.Options.always_modify_graph". So the panel's stamp call
 *    gets the unmodified graph while the dispatch serializes the modified one
 *    — the mismatch is deterministic, not a race.
 *  - Inside queuePrompt, `GraphAnalyser.call_function_with_modified_graph`
 *    adds a REAL link for every broadcast (`convert_to_links`), serializes,
 *    then restores the canvas. The added links are exactly the pack's own
 *    analysis record, which it maintains on every graph (root and each
 *    subgraph) as `graph.extra.ue_links`: entries of
 *    `{ downstream, downstream_slot, upstream, upstream_slot, controller, type }`
 *    where downstream/slot name an UNCONNECTED input on a live non-UE node —
 *    including a SUBGRAPH INSTANCE's input-panel slot, and including the
 *    subgraph OUTPUT panel (the io node's id is -20; the input io node is -10,
 *    per the pack's own constants).
 *
 * WHAT THIS MODULE DOES: turn that record into the "execId inputName" pairs
 * the content hash must treat as queue-time volatile — the THIRD volatility
 * signal in collectVolatileInputs, beside beforeQueued hooks (#572) and
 * rgthree's prompt rewrite (#1124). Because the injection IS the record (an
 * unchanged graph injects exactly these links), excluding exactly these pairs
 * from BOTH canons makes the stamp stable on UE graphs without weakening
 * drift detection anywhere else: a mid-window edit to any other input still
 * mismatches, and an edit that rewires the graph changes what the post body
 * carries OUTSIDE this set (or inside it, the same tolerated-residual class
 * as rgthree's — disclosed via `volatileInputs` → the run result's
 * drift_coverage note, never silent).
 *
 * ROUTING, because a flattened API prompt has no io nodes:
 *
 *  - downstream = an ordinary node: the pair is that node's input name at
 *    downstream_slot, at the graph's own execId prefix ("103:22 clip").
 *  - downstream = a SUBGRAPH INSTANCE's input-panel slot: the injected outer
 *    link makes every INNER consumer of that panel slot resolvable, so the
 *    pairs are the inner consumers' inputs ("103:48 anything" — a UE sender
 *    fed from the panel — is how this shows up), recursing when a consumer
 *    is itself a subgraph instance.
 *  - downstream = -20 (this graph is a subgraph and the broadcast targets
 *    its OUTPUT panel): the injected inner link resolves on the OUTER
 *    consumers of the instance's matching output slot, so the pairs live in
 *    the PARENT graph at the parent's prefix.
 *
 * Anything that cannot be mapped from the live graph (a stale record naming a
 * deleted node/slot, a dead link, an io pass-through) contributes NO pair —
 * fail toward detecting drift, exactly like a hook node that can't be
 * resolved: the worst case is the pre-#1273 refusal on that graph, never a
 * blind pass. Never throws: this runs on the stamp path, where a throw would
 * fail every scoped run closed.
 */

/** The io-node ids cg-use-everywhere's own source compares against. */
const UE_SUBGRAPH_INPUT_ID = -10;
const UE_SUBGRAPH_OUTPUT_ID = -20;

/**
 * Subgraph nesting is shallow by construction, but this walk does NOT dedup by
 * graph object — a shared subgraph DEFINITION must be walked once per INSTANCE
 * (the pairs carry the instance's execId prefix, and the -20 routing depends
 * on the specific instance node) — so a depth bound is the cycle guard.
 */
const MAX_UE_WALK_DEPTH = 16;

const entryId = (prefix, id) => (prefix ? `${prefix}:${id}` : String(id));

/**
 * The "execId inputName" pairs cg-use-everywhere's queue-time link
 * materialisation can add to the serialized prompt of `rootGraph`, per its
 * own `extra.ue_links` record on each graph (see the module header).
 *
 * @param {object|null} rootGraph  The live root graph (app.graph).
 * @returns {Set<string>}          Pairs in collectVolatileInputs' format.
 */
export function ueQueueTimeLinkPairs(rootGraph) {
  const pairs = new Set();
  const addPair = (execId, name) => {
    if (name != null) pairs.add(`${execId} ${String(name)}`);
  };
  const nodeById = (graph, id) => {
    for (const n of graph?._nodes ?? []) {
      if (n != null && String(n.id) === String(id)) return n;
    }
    return null;
  };
  // Live litegraph exposes graph.links as an id-keyed object (the shape the
  // pack itself indexes); tolerate a Map-shaped build rather than misreading it.
  const linkById = (graph, lid) => {
    const links = graph?.links;
    if (!links) return null;
    if (typeof links.get === "function") return links.get(lid) ?? null;
    return links[lid] ?? null;
  };
  const linkIdsOf = (slot) => {
    const ids = slot?.linkIds;
    if (!ids) return [];
    return Array.isArray(ids) ? ids : [...ids];
  };

  // Every inner consumer of a subgraph INPUT panel slot: these inputs gain a
  // resolvable link once an outer link (real or UE-injected) feeds the slot.
  const addInputPanelConsumers = (subgraph, slotIndex, prefix, depth) => {
    if (!subgraph || depth <= 0) return;
    for (const lid of linkIdsOf(subgraph.inputNode?.slots?.[slotIndex])) {
      const link = linkById(subgraph, lid);
      if (!link) continue;
      // An io pass-through (target -20) routes outward again — not mappable
      // from here without the parent chain, so it stays drift-covered.
      const target = nodeById(subgraph, link.target_id);
      if (!target) continue;
      const execId = entryId(prefix, target.id);
      addPair(execId, target.inputs?.[link.target_slot]?.name);
      if (target.subgraph) addInputPanelConsumers(target.subgraph, link.target_slot, execId, depth - 1);
    }
  };

  const walk = (graph, prefix, parent, depth) => {
    if (!graph || depth <= 0) return;
    try {
      const ueLinks = graph.extra?.ue_links;
      if (Array.isArray(ueLinks)) {
        for (const entry of ueLinks) {
          if (!entry) continue;
          const slot = entry.downstream_slot;
          if (String(entry.downstream) === String(UE_SUBGRAPH_OUTPUT_ID)) {
            // A broadcast into THIS subgraph's output panel resolves on the
            // outer consumers of the instance's matching output slot. The
            // root graph has no instance — nothing routes outward from it.
            if (!parent) continue;
            const out = parent.instanceNode?.outputs?.[slot];
            for (const lid of Array.isArray(out?.links) ? out.links : []) {
              const link = linkById(parent.graph, lid);
              if (!link) continue;
              const target = nodeById(parent.graph, link.target_id);
              if (!target) continue;
              const execId = entryId(parent.prefix, target.id);
              addPair(execId, target.inputs?.[link.target_slot]?.name);
              if (target.subgraph) addInputPanelConsumers(target.subgraph, link.target_slot, execId, depth - 1);
            }
            continue;
          }
          // (Input io node -10 is never a downstream: the pack only analyses
          // UNCONNECTED inputs of live non-UE nodes, plus the output panel.)
          if (String(entry.downstream) === String(UE_SUBGRAPH_INPUT_ID)) continue;
          const downstream = nodeById(graph, entry.downstream);
          // A stale record names a node that no longer exists — but then the
          // injection can't happen either, so nothing needs excluding.
          if (!downstream) continue;
          const execId = entryId(prefix, downstream.id);
          addPair(execId, downstream.inputs?.[slot]?.name);
          if (downstream.subgraph) {
            // A broadcast into a subgraph INSTANCE's input-panel slot routes
            // to every inner consumer of that slot once injected.
            addInputPanelConsumers(downstream.subgraph, slot, execId, depth - 1);
          }
        }
      }
    } catch {
      // A malformed record must not take down the stamp path: whatever could
      // not be read simply stays drift-covered (the pre-#1273 behaviour).
    }
    for (const node of graph._nodes ?? []) {
      if (node?.subgraph && node.id != null) {
        walk(node.subgraph, entryId(prefix, node.id), { graph, instanceNode: node, prefix }, depth - 1);
      }
    }
  };

  walk(rootGraph, "", null, MAX_UE_WALK_DEPTH);
  return pairs;
}
