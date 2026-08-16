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
 * A BYPASSED or VIRTUAL node is skipped by that loop too, and is reached only THROUGH
 * its consumers — and THAT is not decidable from here. Three rounds of the review gate
 * killed three successive attempts to decide it:
 *
 *   1. `_getBypassSlotIndex(slot, type)` is driven by the CONSUMER's type, not the
 *      output's: `resolveOutput(link.origin_slot, type ?? input.type)`. A wildcard
 *      consumer short-circuits the whole type check and selects the same-index input
 *      whatever its type is.
 *   2. A connected output whose only consumer is itself muted reaches nothing.
 *   3. `LiteGraph.isValidConnection` accepts comma-delimited union types (`IMAGE,MASK`),
 *      which a string comparison does not.
 *
 * Each fix was a closer approximation of the resolver, and each one was still wrong,
 * because an approximation of a resolver is not the resolver. The honest position is
 * that reachability THROUGH a bypassed node cannot be established from outside
 * ComfyUI's own resolver, and this module does not claim to establish it.
 *
 * The obvious alternative — call `app.graphToPrompt()` and see whether it throws —
 * is deliberately NOT taken. It runs `applyToGraph()` on every virtual node, so
 * probing with it mutates the graph as a side effect of asking a question about it.
 * A diagnostic must not do that.
 *
 * ## Three tiers
 *
 *  - DANGLING INPUT ON AN ORDINARY NODE — fatal, and provably so with no modelling at
 *    all: the loop above resolves EVERY input of a node it does not skip, with no type
 *    matching and no consumer analysis. This refuses.
 *  - DANGLING INPUT ON A SKIPPED NODE (muted, bypassed, virtual) — reported, never
 *    fatal. Real corruption, reachability unknown. #1571's own node is in this tier, and
 *    that is the right answer: the report gives the caller the node, slot and link at
 *    the moment of the conversion, which is exactly what they lacked, without asserting
 *    a verdict this code cannot support.
 *  - DISCONNECTED BOUNDARY INPUT — reported, never fatal. Every input slot on a fresh
 *    subgraph node exists BECAUSE an external link fed it, so an unconnected one right
 *    after conversion is anomalous (it is what the `!output || !outputNode` branch
 *    above leaves behind). But "anomalous" is not "provably broken", and a false
 *    positive must cost a line of text, not a refused mutation.
 *
 * The authoritative fatal verdict already exists and comes from the only component that
 * can give it: when the run is attempted, ComfyUI's serializer either throws or does
 * not, and #1571's other half makes that error visible verbatim instead of discarding
 * it. This module's job is to say what the conversion DID, at the moment it did it.
 *
 * Everything here fails toward SILENCE on an input it cannot read. This gates the
 * report of a mutation that already happened; a graph shape we do not recognise must
 * never become a refusal.
 */

/** `LGraphEventMode.NEVER` — muted. Produces no output and is never asked for inputs. */
const MODE_NEVER = 2;
/** `LGraphEventMode.BYPASS` — resolved THROUGH by consumers, one input per output slot. */
const MODE_BYPASS = 4;

/**
 * Is this node one `graphToPrompt` resolves EVERY input of?
 *
 * A direct read of the skip list in executionUtil.ts and nothing more — no type
 * matching, no consumer analysis, no model of the resolver. `true` means the
 * serializer provably reaches every input on this node; `false` means only that it
 * does not reach them THAT way, never that they are safe.
 *
 * A node with no `mode` at all is an ordinary node: ordinary nodes have every input
 * resolved, which is the answer that makes an unrecognised shape err toward reporting
 * a real break rather than hiding one.
 */
function serializerResolvesEveryInput(node) {
  if (node?.isVirtualNode === true) return false;
  const mode = node?.mode;
  return mode !== MODE_NEVER && mode !== MODE_BYPASS;
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
 * Every entry is real corruption. `certainly_reached` says whether `graphToPrompt`
 * PROVABLY resolves that input — true only for a node the serializer does not skip, in
 * which case it resolves every input unconditionally. `false` does NOT mean safe: it
 * means the input is reached only through a consumer chain this module deliberately
 * does not model (see the header). Only `certainly_reached` entries may refuse.
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
    const reached = serializerResolvesEveryInput(node);
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
        // Why the serializer skips the node, when it does — the caller needs this to
        // judge the finding, and #1571's own node is `bypassed`.
        bypassed: node?.mode === MODE_BYPASS,
        muted: node?.mode === MODE_NEVER,
        virtual: node?.isVirtualNode === true,
        certainly_reached: reached,
      });
    }
  }
  return found;
}

/** The subset of {@link danglingInputLinks} that provably breaks serialization. */
export function fatalDanglingInputLinks(graph) {
  return danglingInputLinks(graph).filter((entry) => entry.certainly_reached);
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

/** `RBG_Smart_Seed_Variance node 192 (bypassed) input 0 "conditioning" -> link 505` */
function describeDangling(entry) {
  const who = entry.node_type ? `${entry.node_type} node ${entry.node_id}` : `node ${entry.node_id}`;
  const slot = entry.name ? `input ${entry.slot} "${entry.name}"` : `input ${entry.slot}`;
  const mode = entry.bypassed
    ? " (bypassed)"
    : entry.muted
      ? " (muted)"
      : entry.virtual
        ? " (virtual)"
        : "";
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

/** How the caller repairs either tier. Shared so the refusal and the warning cannot
 *  drift into offering different recoveries for the same corruption. */
function recoveryAdvice() {
  return (
    `The frontend's convertToSubgraph produced this; the panel is reporting it, not ` +
    `causing it (comfyui-mcp#1571). Nothing has been undone — the subgraph is still ` +
    `there. To recover: undo the conversion in ComfyUI (Ctrl+Z) and wrap a selection that ` +
    `does not cross that link, or enter the subgraph (panel_enter_subgraph) and reconnect ` +
    `the listed input(s) — panel_expose_subgraph_input can re-create the boundary slot, ` +
    `or delete the node that owns the input if it was bypassed and is not needed.`
  );
}

function boundaryNote(loose) {
  if (!loose.length) return "";
  return (
    `The new subgraph node also has ${loose.length} input slot(s) that nothing in the ` +
    `parent graph feeds — ${listOf(loose, describeBoundary)} — which is the outer ` +
    `half of the same broken boundary. `
  );
}

/**
 * The refusal for a conversion that PROVABLY produced an unserializable subgraph.
 *
 * This is NOT `assertSubgraphNodeLanded`'s message and must not be confused with it.
 * There, nothing was created and the canvas is untouched. Here the subgraph EXISTS —
 * saying "nothing happened" would send the caller to retry and wrap the same nodes a
 * second time. The message therefore leads with what is on the canvas, then with what
 * is broken about it, then with the recoveries.
 *
 * `dangling` is the `certainly_reached` subset ONLY. Anything whose reachability runs
 * through a consumer chain belongs in {@link brokenConversionWarning}, because this
 * message asserts the workflow cannot run, and that assertion has to be true.
 */
export function brokenConversionRefusal({ what, subgraphNodeId, dangling, disconnected }) {
  const bad = Array.isArray(dangling) ? dangling : [];
  const loose = Array.isArray(disconnected) ? disconnected : [];
  const plural = bad.length === 1 ? "" : "s";
  return (
    `${what} created subgraph node ${subgraphNodeId}, and it is on the canvas — but the ` +
    `conversion left it UNSERIALIZABLE, so this workflow cannot be run or queued as it ` +
    `stands. ${bad.length} input${plural} inside the new subgraph still ` +
    `reference${plural ? "" : "s"} a link that does not exist in it: ` +
    `${listOf(bad, describeDangling)}. Every one of those is on a node ComfyUI's serializer ` +
    `resolves unconditionally, and it throws on exactly this ` +
    `("No link found in parent graph for id [${subgraphNodeId}:${bad[0]?.node_id ?? "?"}] ` +
    `slot [${bad[0]?.slot ?? 0}]") — which is why the failure would otherwise have ` +
    `surfaced later, on the next run, naming an id that has no obvious connection to this ` +
    `call. ${boundaryNote(loose)}${recoveryAdvice()}`
  );
}

/**
 * The WARNING for corruption whose fatality this module cannot establish.
 *
 * Same defect, weaker claim. The links are provably gone; whether serialization trips
 * over them depends on a consumer chain that only ComfyUI's own resolver can walk (see
 * the header — three review rounds killed three attempts to walk it from here). So this
 * states what was measured, states plainly that the verdict is not ours to give, and
 * names the one thing that WILL give it: running the workflow.
 *
 * Returned on the SUCCESS payload, because the conversion did happen and the graph may
 * well be fine. It never refuses.
 */
export function brokenConversionWarning({ what, subgraphNodeId, dangling, disconnected }) {
  const bad = Array.isArray(dangling) ? dangling : [];
  const loose = Array.isArray(disconnected) ? disconnected : [];
  const plural = bad.length === 1 ? "" : "s";
  return (
    `${what} created subgraph node ${subgraphNodeId}, but the conversion also left ` +
    `${bad.length} input${plural} inside it referencing a link that does not exist there: ` +
    `${listOf(bad, describeDangling)}. Those links are gone — that part is measured. ` +
    `Whether it STOPS the workflow running is not something the panel can decide: ComfyUI ` +
    `skips muted, bypassed and virtual nodes when serializing and reaches them only ` +
    `through their consumers, and only its own resolver can walk that chain. So this is ` +
    `a warning, not a refusal, and the subgraph is reported as created. Run the workflow ` +
    `to get the authoritative answer — if it is fatal, ComfyUI will say ` +
    `"No link found in parent graph for id [${subgraphNodeId}:${bad[0]?.node_id ?? "?"}] ` +
    `slot [${bad[0]?.slot ?? 0}]" and the panel now passes that through verbatim. ` +
    `${boundaryNote(loose)}${recoveryAdvice()}`
  );
}
