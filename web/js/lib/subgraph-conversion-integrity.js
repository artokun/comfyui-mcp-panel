/**
 * comfyui-mcp#1571 — `panel_subgraph_group` reported a clean conversion, and every
 * later run of that workflow failed.
 *
 * ## What was measured
 *
 * The reported graph is `packs/krea2-combo`. Node 192 is `RBG_Smart_Seed_Variance`
 * with `mode: 4` (BYPASS), one input `conditioning` carrying `link: 505`, and one
 * output feeding two KSamplers (links 473/474). Wrapping the surrounding group with
 * `panel_subgraph_group` produced subgraph node 302 and reported success. The next
 * `panel_run` failed with:
 *
 *     No link found in parent graph for id [302:192] slot [0] conditioning
 *
 * That string comes from ComfyUI_frontend itself — `ExecutableNodeDTO.resolveInput`,
 * read out of the shipped 1.48.7 bundle:
 *
 *     const i = this.inputs.at(slot)
 *     if (!i) throw new SlotIndexError(...)
 *     if (i.linkId == null) return                       // unconnected: fine
 *     const link = this.graph.getLink(i.linkId)
 *     if (!link) throw new InvalidLinkError(
 *       `No link found in parent graph for id [${this.id}] slot [${slot}] ${i.name}`)
 *
 * `this.graph` there is the node's OWN graph — for a node that now lives inside a
 * subgraph, that is the Subgraph. So the failure states one precise fact: an input
 * still references a link id that does not exist in the graph the node is now in.
 *
 * ## Why the panel has to look
 *
 * The conversion is `LGraph.convertToSubgraph`, which is the frontend's code, not
 * ours — and it does not verify its own output. `getBoundaryLinks` skips any input
 * link it cannot resolve (`console.warn('Failed to resolve link ID […]')` and
 * `continue`), and `mapSubgraphInputsAndLinks` skips a whole connection group whose
 * first resolved connection has no `input`, while the reconnect loop that follows
 * indexes `subgraphNode.inputs[i - 1]` off a counter incremented for EVERY group. A
 * node can therefore be cloned into the new subgraph carrying an input link id that
 * was never written into the new subgraph's link table.
 *
 * We cannot stop the frontend doing that. We can stop reporting it as a success. The
 * cost of not looking is the whole of #1571: the tool said "subgraph created", the
 * corruption was invisible until the next run, and the run's error named a flattened
 * id (`[302:192]`) that has no connection to the tool call that caused it.
 *
 * ## Which dangling inputs are actually FATAL (codex gate, P1)
 *
 * The first version refused on every dangling input, and that over-refuses. A dangling
 * reference only breaks serialization if the serializer ever RESOLVES that input, and
 * `graphToPrompt` (executionUtil.ts, same 1.48.7 bundle) skips whole nodes first:
 *
 *     for (const node of nodeDtoMap.values()) {
 *       if (node.isVirtualNode || node.mode === NEVER || node.mode === BYPASS) continue
 *       for (const [i, input] of node.inputs.entries()) node.resolveInput(i)
 *
 * So a MUTED (`mode === 2`) node is never asked for its inputs at all — and
 * `resolveOutput` returns immediately for it too ("Muted nodes produce no output"), so
 * its consumers do not reach through it either. A muted node with a dangling input
 * queues perfectly well. Refusing on it would un-ship the tool for a graph that runs.
 *
 * A BYPASSED node is skipped by that loop as well, and is reached only THROUGH its
 * consumers: `resolveOutput` calls `_getBypassSlotIndex(slot, type)`, which picks ONE
 * input per output slot — the same-index input if its type is compatible, else the
 * first exact type match, else the first compatible one — and resolves only that. Its
 * other inputs are never touched. #1571's node is bypassed and its one CONDITIONING
 * input is exactly the slot that selection lands on, which is why it broke.
 *
 * `bypassResolvedInputSlots` reproduces that selection. It cannot reproduce
 * `LiteGraph.isValidConnection` without importing litegraph, so it treats a wildcard
 * (`*` or empty) as compatible and otherwise requires the type strings to match — a
 * conservative reading that can only ever select FEWER slots than the frontend does,
 * which is the safe direction for a check that refuses.
 *
 * ## Three tiers
 *
 *  - DANGLING INPUT THE SERIALIZER REACHES — fatal. The exact condition `resolveInput`
 *    throws on, on a node the serializer provably visits. This refuses.
 *  - DANGLING INPUT IT DOES NOT REACH — reported, never fatal. Harmless today, and it
 *    breaks the moment the node is un-muted or rewired, so it is worth saying out loud.
 *  - DISCONNECTED BOUNDARY INPUT — reported, never fatal. Every input slot on a fresh
 *    subgraph node exists BECAUSE an external link fed it, so an unconnected one right
 *    after conversion is anomalous (it is what the `!output || !outputNode` branch
 *    above leaves behind). But "anomalous" is not "provably broken", and a false
 *    positive must cost a line of text, not a refused mutation.
 *
 * Everything here fails toward SILENCE on an input it cannot read. This gates the
 * report of a mutation that already happened; a graph shape we do not recognise must
 * never become a refusal.
 */

/** `LGraphEventMode.NEVER` — muted. Produces no output and is never asked for inputs. */
const MODE_NEVER = 2;
/** `LGraphEventMode.BYPASS` — resolved THROUGH by consumers, one input per output slot. */
const MODE_BYPASS = 4;

/** Litegraph compares slot types as strings; `*` and `""` are the wildcards. */
function normType(type) {
  if (type == null) return "";
  return String(type).trim().toUpperCase();
}

function typesConnect(a, b) {
  const A = normType(a);
  const B = normType(b);
  if (!A || !B || A === "*" || B === "*") return true;
  return A === B;
}

/**
 * The input slot indices a BYPASSED node would actually resolve, mirroring
 * `ExecutableNodeDTO._getBypassSlotIndex` per output slot.
 *
 * Only outputs that are CONNECTED are considered: nothing asks an unconnected output
 * for a value, so no input is reached through it. Deliberately conservative — see the
 * module header on why selecting too few is the safe direction here.
 */
export function bypassResolvedInputSlots(node) {
  const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
  const outputs = Array.isArray(node?.outputs) ? node.outputs : [];
  const used = new Set();
  for (const [slot, output] of outputs.entries()) {
    if (!Array.isArray(output?.links) || !output.links.length) continue;
    const type = normType(output?.type);
    // "Any type short circuit - match slot ID, fallback to first slot".
    if (!type || type === "*") {
      used.add(slot < inputs.length ? slot : 0);
      continue;
    }
    // "Prefer input with the same slot ID".
    if (inputs[slot] && typesConnect(inputs[slot].type, type)) {
      used.add(slot);
      continue;
    }
    // "use exact match first", then the first compatible one.
    const exact = inputs.findIndex((input) => normType(input?.type) === type);
    if (exact !== -1) {
      used.add(exact);
      continue;
    }
    const first = inputs.findIndex((input) => typesConnect(input?.type, type));
    if (first !== -1) used.add(first);
  }
  return used;
}

/**
 * Would `graphToPrompt` resolve this input, and therefore throw on it?
 *
 * `bypassSlots` is {@link bypassResolvedInputSlots} for this node, computed once by the
 * caller. Anything unrecognisable answers `true` only for the ordinary case: a node with
 * no `mode` at all is an ordinary node, and ordinary nodes have every input resolved.
 */
function serializerReachesInput(node, slot, bypassSlots) {
  if (node?.isVirtualNode === true) return false;
  const mode = node?.mode;
  if (mode === MODE_NEVER) return false;
  if (mode === MODE_BYPASS) return bypassSlots.has(slot);
  return true;
}

/**
 * The set of link ids present in `graph`, or `null` when the link table cannot be
 * read at all.
 *
 * `null` is the whole safety property: an unfamiliar frontend, or a graph object we
 * were handed by mistake, must produce NO findings rather than a graph-wide "every
 * link is missing". Live litegraph uses a `Map`; the serialized form is an array of
 * either `[id, origin_id, origin_slot, target_id, target_slot, type]` tuples or
 * `{id, …}` objects; some builds expose a plain object keyed by id. All four are
 * accepted, anything else is unreadable.
 */
export function readLinkIds(graph) {
  const links = graph?.links;
  if (!links) return null;
  const ids = new Set();
  if (links instanceof Map) {
    for (const key of links.keys()) ids.add(String(key));
    return ids;
  }
  if (Array.isArray(links)) {
    for (const link of links) {
      if (Array.isArray(link)) {
        if (link[0] != null) ids.add(String(link[0]));
      } else if (link && typeof link === "object" && link.id != null) {
        ids.add(String(link.id));
      }
    }
    return ids;
  }
  if (typeof links === "object") {
    for (const key of Object.keys(links)) ids.add(String(key));
    return ids;
  }
  return null;
}

/**
 * Every input in `graph` that references a link id the graph's own link table does
 * not contain.
 *
 * Each entry carries `fatal`: whether `graphToPrompt` actually resolves that input and
 * would therefore throw `InvalidLinkError` on it (see the module header — muted nodes,
 * virtual nodes and a bypassed node's unselected inputs are never reached). Only the
 * fatal ones may refuse; the rest are worth reporting and nothing more.
 *
 * ONE LEVEL ONLY, on purpose. `convertToSubgraph` clones nodes into the graph it just
 * created; a nested subgraph NODE that moved inside brings its own definition along
 * untouched, and that definition is shared with every other instance of it. Walking
 * into it would attribute a pre-existing problem to this conversion.
 *
 * Returns `[]` for an unreadable graph or an unreadable link table.
 */
export function danglingInputLinks(graph) {
  const known = readLinkIds(graph);
  if (!known) return [];
  const nodes = Array.isArray(graph?._nodes)
    ? graph._nodes
    : Array.isArray(graph?.nodes)
      ? graph.nodes
      : null;
  if (!nodes) return [];
  const found = [];
  for (const node of nodes) {
    const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
    if (!inputs.length) continue;
    // Computed once per node, and only for the mode that needs it.
    const bypassSlots = node?.mode === MODE_BYPASS ? bypassResolvedInputSlots(node) : EMPTY_SLOTS;
    for (const [slot, input] of inputs.entries()) {
      const link = input?.link;
      if (link == null) continue;
      if (known.has(String(link))) continue;
      found.push({
        node_id: node?.id ?? null,
        node_type: typeof node?.type === "string" ? node.type : null,
        slot,
        name: typeof input?.name === "string" ? input.name : null,
        link_id: link,
        // #1571's node was bypassed, and that is not incidental: a bypassed node is
        // resolved THROUGH at serialization time, so its dangling input is reached
        // by its consumers even though the node itself contributes no prompt entry.
        bypassed: node?.mode === MODE_BYPASS,
        muted: node?.mode === MODE_NEVER,
        fatal: serializerReachesInput(node, slot, bypassSlots),
      });
    }
  }
  return found;
}

const EMPTY_SLOTS = new Set();

/** The subset of {@link danglingInputLinks} that provably breaks serialization. */
export function fatalDanglingInputLinks(graph) {
  return danglingInputLinks(graph).filter((entry) => entry.fatal);
}

/**
 * Input slots on the freshly created subgraph NODE that nothing in the parent graph
 * feeds.
 *
 * Advisory only (see the header). Returns `[]` for anything unreadable.
 */
export function disconnectedBoundaryInputs(subgraphNode) {
  const inputs = Array.isArray(subgraphNode?.inputs) ? subgraphNode.inputs : null;
  if (!inputs) return [];
  const found = [];
  for (const [slot, input] of inputs.entries()) {
    if (!input || typeof input !== "object") continue;
    if (input.link != null) continue;
    found.push({
      slot,
      name: typeof input.name === "string" ? input.name : null,
      type: typeof input.type === "string" ? input.type : null,
    });
  }
  return found;
}

/** `RBG_Smart_Seed_Variance node 192 (bypassed) input 0 "conditioning" → link 505` */
function describeDangling(entry) {
  const who = entry.node_type ? `${entry.node_type} node ${entry.node_id}` : `node ${entry.node_id}`;
  const slot = entry.name ? `input ${entry.slot} "${entry.name}"` : `input ${entry.slot}`;
  const mode = entry.bypassed ? " (bypassed)" : entry.muted ? " (muted)" : "";
  return `${who}${mode} ${slot} → link ${entry.link_id}`;
}

/** `input 0 "conditioning" (CONDITIONING)` */
function describeBoundary(entry) {
  const named = entry.name ? `input ${entry.slot} "${entry.name}"` : `input ${entry.slot}`;
  return entry.type ? `${named} (${entry.type})` : named;
}

const MAX_LISTED = 8;

function listOf(entries, describe) {
  const shown = entries.slice(0, MAX_LISTED).map(describe);
  const more = entries.length > shown.length ? `, and ${entries.length - shown.length} more` : "";
  return `${shown.join("; ")}${more}`;
}

/**
 * The refusal for a conversion that produced an unserializable subgraph.
 *
 * This is NOT `assertSubgraphNodeLanded`'s message and must not be confused with it.
 * There, nothing was created and the canvas is untouched. Here the subgraph EXISTS —
 * saying "nothing happened" would send the caller to retry and wrap the same nodes a
 * second time. The message therefore leads with what is on the canvas, then with what
 * is broken about it, then with the two recoveries.
 *
 * `dangling` is the FATAL subset only — the entries the serializer actually reaches.
 * `dormant` is the rest (muted/virtual/unselected bypass slots): broken in the same way
 * but not reached today, so it is context, never a reason. Listing the two together
 * without distinguishing them would overstate the damage on a graph that still runs.
 */
export function brokenConversionRefusal({ what, subgraphNodeId, dangling, disconnected, dormant }) {
  const bad = Array.isArray(dangling) ? dangling : [];
  const loose = Array.isArray(disconnected) ? disconnected : [];
  const quiet = Array.isArray(dormant) ? dormant : [];
  const plural = bad.length === 1 ? "" : "s";
  const boundary = loose.length
    ? `The new subgraph node also has ${loose.length} input slot(s) that nothing in the ` +
      `parent graph feeds — ${listOf(loose, describeBoundary)} — which is the outer half of ` +
      `the same broken boundary. `
    : "";
  const dormantNote = quiet.length
    ? `${quiet.length} further input(s) lost their link the same way but are NOT reached by ` +
      `the serializer today — ${listOf(quiet, describeDangling)} — because a muted or ` +
      `virtual node is skipped, and a bypassed node resolves only the input its output type ` +
      `selects. Those will break if the node is re-enabled or rewired. `
    : "";
  return (
    `${what} created subgraph node ${subgraphNodeId}, and it is on the canvas — but the ` +
    `conversion left it UNSERIALIZABLE, so this workflow cannot be run or queued as it ` +
    `stands. ${bad.length} input${plural} inside the new subgraph still reference${plural ? "" : "s"} ` +
    `a link that does not exist in it: ${listOf(bad, describeDangling)}. ComfyUI's own serializer ` +
    `throws on exactly this ("No link found in parent graph for id [${subgraphNodeId}:` +
    `${bad[0]?.node_id ?? "?"}] slot [${bad[0]?.slot ?? 0}]"), which is why the failure ` +
    `would otherwise have surfaced later, on the next run, naming an id that has no obvious ` +
    `connection to this call. ${boundary}${dormantNote}` +
    `The frontend's convertToSubgraph produced this; the panel is reporting it, not causing ` +
    `it (comfyui-mcp#1571). Nothing has been undone — the subgraph is still there. To ` +
    `recover: undo the conversion in ComfyUI (Ctrl+Z) and wrap a selection that does not ` +
    `cross that link, or enter the subgraph (panel_enter_subgraph) and reconnect the listed ` +
    `input(s) — panel_expose_subgraph_input can re-create the boundary slot, or delete the ` +
    `node that owns the input if it was bypassed and is not needed.`
  );
}
