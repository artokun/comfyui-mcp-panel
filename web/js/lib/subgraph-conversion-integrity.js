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

/* ===========================================================================
 * #1463 — a conversion that THROWS must say whether the graph changed.
 *
 * Everything above answers "the conversion RETURNED — is what it produced sound?".
 * This half answers the question that was never asked: `convertToSubgraph` threw,
 * so what is on the canvas now?
 *
 * ## What was measured
 *
 * Driven in a real browser against the ComfyUI on this machine, root graph `1→2→3→4`
 * wired in a chain, converting the middle pair `[2, 3]` with node 1's `graph`
 * back-reference cleared:
 *
 *     nodes before: 1,2,3,4        subgraph definitions: 0
 *     → convertToSubgraph throws "Attempted to access LGraph reference that was
 *       null or undefined."
 *     nodes after:  1,4,5          subgraph definitions: 1
 *     node 5 is the new subgraph node; its input link is `null`
 *
 * Nodes 2 and 3 are GONE, a subgraph definition is registered, and the wrapper the
 * conversion got as far as creating was never wired back to node 1 — and the only
 * thing the caller was told is the bare frontend message. #1463's reporter read that
 * as "no other side effects" and retried three times.
 *
 * The same message is also reachable with the graph barely touched — the frontend
 * throws out of `disconnectInput`/`disconnectOutput` too, which run before the removal
 * loop — so the caller's correct next move differs completely between two failures that
 * read identically. Measure it instead of guessing.
 *
 * ## What "unchanged" may NOT be claimed from (gate P1)
 *
 * The first version of this said "the graph is UNCHANGED … nothing to undo" whenever the
 * selected nodes were still present and no definition had been registered. That is a
 * POSITIVE claim from two surfaces, and it is false wherever the mutation happened on a
 * third:
 *
 *   - `LGraph.convertToSubgraph` is a plain instance-assignable method, and extensions
 *     replace it. cg-use-everywhere sets `app.graph.convertToSubgraph` to a wrapper that
 *     calls `convert_to_links(...)` — real link mutation — then delegates, then calls
 *     `mods.restorer()` OUTSIDE a `finally`. Any throw from the delegate leaves the
 *     injected links behind, with every node and definition exactly where it was.
 *   - The measured, unwrapped order inside `_convertToSubgraphImpl` is
 *     `createSubgraph` (definition registered) BEFORE the `disconnectInput` loop. So a
 *     detached SELECTED node does NOT throw with the canvas untouched: driven in a
 *     browser through `LGraph.prototype.convertToSubgraph` (bypassing the installed
 *     wrapper), `nodes 1,2,3,4 → 1,2,3,4` but `subgraph defs 0 → 1`. The definition
 *     count is what catches that, and this file must keep counting it.
 *
 * So the confident verdict is gated on there being nothing unobserved: node presence,
 * the definition count and the link-table size all readable and all identical, AND no
 * wrapper installed on the graph (detected as `convertToSubgraph` being an OWN property
 * of the instance — verified true on this install, where the method also exists on the
 * prototype). Anything else is reported as UNKNOWN, which is weaker but true.
 *
 * ## Why `node.graph == null` is the one condition worth naming
 *
 * `NullGraphError` is thrown by litegraph wherever a node is asked to do graph work
 * while its own `graph` back-reference is unset. On the conversion path that is
 * reachable for a node the graph still lists — `LGraph.remove` sets `node.graph = null`
 * BEFORE it splices the node out of `_nodes`, and `node.graph` is a plain settable
 * property any extension can clear. A SELECTED node in that state throws at
 * `disconnectInput`, after a definition has been registered; a boundary NEIGHBOUR in
 * that state throws in the reconnect loop, after the selected nodes have been removed —
 * the destructive case measured above. Both were reproduced in-browser, which is why
 * the pre-flight refuses on either rather than only on the selection.
 * ========================================================================= */

/** Read a link table in any of the shapes {@link readLinkIds} accepts, by id. */
function linkLookup(links) {
  if (!links) return () => null;
  if (typeof links.get === "function") return (id) => (id == null ? null : (links.get(id) ?? null));
  if (Array.isArray(links)) {
    const byId = new Map();
    for (const link of links) {
      if (Array.isArray(link)) {
        if (link[0] != null) byId.set(String(link[0]), link);
      } else if (link && typeof link === "object" && link.id != null) {
        byId.set(String(link.id), link);
      }
    }
    return (id) => (id == null ? null : (byId.get(String(id)) ?? null));
  }
  if (typeof links === "object") return (id) => (id == null ? null : (links[id] ?? null));
  return () => null;
}

const linkOriginId = (link) => link?.origin_id ?? (Array.isArray(link) ? link[1] : undefined);

/**
 * Ids of the nodes FEEDING `node` — its upstream producers.
 *
 * Deliberately not "everything wired to it" (gate r5 P1). Direction decides whether a
 * detached neighbour is fatal, and only the upstream side is, read out of the installed
 * frontend's own sourcemapped litegraph:
 *
 *   - Upstream: the reconnect is `outputNode.connectSlots(output, subgraphNode, …)`
 *     (`LGraph.ts`), where `outputNode` is the OUTSIDE producer — and `connectSlots`
 *     opens with `const { graph } = this; if (!graph) throw new NullGraphError()`
 *     (`LGraphNode.ts`). A detached producer therefore throws, after the selected nodes
 *     have already been removed. That is #1463's destructive case, and the one measured
 *     in the browser.
 *   - Downstream: the reconnect is `subgraphNode.connectSlots(output, inputNode, …)` —
 *     `this` is the freshly added wrapper, whose graph is set. Nothing reads the
 *     consumer's `graph`: `disconnectOutput` dereferences only `this.graph` and writes
 *     `target.inputs[slot].link = null`, and `connectSlots`' one call into the consumer,
 *     `inputNode.disconnectInput(...)`, is gated on that same link being non-null, which
 *     `disconnectOutput` has already cleared. A detached consumer converts fine.
 *
 * Sweeping both directions and refusing on either would block a conversion the frontend
 * completes — a worse outcome than the bug, in the exact pathological state this feature
 * exists for.
 *
 * Takes a prepared `lookup` rather than the link table, so a caller sweeping a whole
 * selection indexes a serialized (array) table once instead of once per node.
 */
function upstreamProducerIds(node, lookup) {
  const ids = new Set();
  for (const input of Array.isArray(node?.inputs) ? node.inputs : []) {
    const id = linkOriginId(lookup(input?.link));
    if (id != null) ids.add(id);
  }
  return ids;
}

/** Does the conversion ever ask this node to disconnect anything?
 *
 *  A SELECTED node is only dereferenced through `disconnectInput`/`disconnectOutput`,
 *  and both are reached per-link — `LGraph.remove` calls them only for slots that carry
 *  one. A detached node with no links at all converts cleanly (measured: two detached,
 *  unlinked nodes wrap without error), so refusing it would be over-refusal. */
function carriesAnyLink(node) {
  for (const input of Array.isArray(node?.inputs) ? node.inputs : []) {
    if (input?.link != null) return true;
  }
  for (const output of Array.isArray(node?.outputs) ? node.outputs : []) {
    if (Array.isArray(output?.links) && output.links.length) return true;
  }
  return false;
}

/**
 * Nodes involved in this conversion that the graph OWNS but that do not point back at
 * it — the state that provably throws `NullGraphError` out of `convertToSubgraph`.
 *
 * Two roles only, and each carries its own consequence, because they fail DIFFERENTLY
 * and the refusal has to say which. Read out of the shipped bundle's `LGraph.ts` on this
 * install: `createSubgraph` @1792 → `disconnectInput` @1807 → `for (const node of nodes)
 * this.remove(node)` @1817 → `this.add(subgraphNode)` @1858. A detached node in the
 * SELECTION throws at 1807 — a definition is already registered, nothing is removed yet.
 * A detached upstream PRODUCER survives that loop and throws in the reconnect that
 * follows 1858, by which point the selected nodes are gone and the wrapper exists
 * unwired.
 *
 * A detached downstream CONSUMER is deliberately absent: the conversion never reads its
 * `graph`, so refusing on it would block a conversion the frontend completes. See
 * {@link upstreamProducerIds} for that trace, and {@link carriesAnyLink} for the
 * matching narrowing on the selection side.
 *
 * Ownership is proved by NODE identity (`getNodeById(id)` returns this very object),
 * never by graph identity. `node.graph !== graph` would read a Vue proxy of the live
 * root as a foreign graph and refuse every conversion on a reactive frontend — the
 * same proxy/raw duality as #558. Only a NULLISH back-reference counts, because only
 * that is unambiguous: the graph lists the node, the node denies the graph.
 *
 * Returns `[]` for anything unreadable — a graph this cannot inspect must fall through
 * to the conversion, not be refused by it.
 */
export function detachedConversionNodes(graph, nodes) {
  const selection = Array.isArray(nodes) ? nodes : [];
  if (!selection.length) return [];
  if (typeof graph?.getNodeById !== "function") return [];
  const owns = (node) => node?.id != null && graph.getNodeById(node.id) === node;
  const lookup = linkLookup(graph?.links);
  const found = [];
  const seen = new Set();
  const consider = (node, role) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (!owns(node)) return;
    if (node.graph != null) return;
    // A selected node is only dereferenced per-link; an unlinked one converts cleanly.
    if (role === "selected" && !carriesAnyLink(node)) return;
    found.push({ id: node.id, role });
  };
  // Selection first, so a node that is both selected and someone's producer is reported
  // once, under the role whose consequence lands first.
  for (const node of selection) consider(node, "selected");
  for (const node of selection) {
    for (const id of upstreamProducerIds(node, lookup)) consider(graph.getNodeById(id), "producer");
  }
  return found;
}

/** The pre-flight refusal. Raised BEFORE `convertToSubgraph` is called, so it is the
 *  one report in this file that can promise the canvas is untouched.
 *
 *  It names the consequence PER ROLE. A single sentence for both was wrong for one of
 *  them (gate r3 P1): a detached selected node throws before the removal loop, so
 *  "after it has already removed the nodes you selected" described a state that path
 *  never reaches, while the state it DOES leave — a registered subgraph definition —
 *  went unmentioned. */
export function detachedConversionRefusal({ what, detached }) {
  const bad = Array.isArray(detached) ? detached : [];
  const idsOf = (role) =>
    bad.filter((entry) => entry?.role === role).map((entry) => entry?.id);
  const picked = idsOf("selected");
  const producers = idsOf("producer");
  const listing = [];
  if (picked.length) {
    listing.push(
      `node${picked.length === 1 ? "" : "s"} ${picked.join(", ")} in your selection`,
    );
  }
  if (producers.length) {
    listing.push(
      `node${producers.length === 1 ? "" : "s"} ${producers.join(", ")} feeding it`,
    );
  }
  const who = listing.length ? listing.join(", and ") : `node(s) ${bad.map((e) => e?.id).join(", ")}`;
  // What the frontend would leave behind, stated only for the roles actually present.
  const consequence = [];
  if (picked.length) {
    consequence.push(
      `a detached node in the SELECTION makes it throw at disconnectInput, which runs after ` +
        `it has already registered a subgraph definition — so you would be left with a ` +
        `definition on the workflow and no node to show for it`,
    );
  }
  if (producers.length) {
    consequence.push(
      `a detached node FEEDING the selection makes it throw later still, in the reconnect ` +
        `pass, by which point the nodes you selected are gone and the wrapper it built is ` +
        `sitting there wired to nothing`,
    );
  }
  return (
    `${what} was NOT run and the graph is unchanged. The graph lists ${who}, but ` +
    `${bad.length === 1 ? "it does" : "they do"} not reference it back (node.graph is ` +
    `unset), and ComfyUI's convertToSubgraph throws "Attempted to access LGraph reference ` +
    `that was null or undefined." on exactly that (comfyui-mcp-panel#1463). Where it throws ` +
    `decides what you are left with: ${consequence.join("; ")}. Refusing here is what keeps ` +
    `either from happening. This is a stale canvas, not a bad selection: it follows a ` +
    `ComfyUI restart, or an extension detaching a node without removing it. Reload the ` +
    `ComfyUI page to rebuild the graph (save first — panel_save_workflow), then retry. ` +
    // NOT "every other panel tool keeps working meanwhile" (gate r4): a detached node
    // throws out of the disconnect paths too, so that would be another claim wider than
    // anything measured here — the exact habit this file exists to break.
    `Tools that never ask this node to do graph work are unaffected, but anything that ` +
    `disconnects or removes it can hit the same throw.`
  );
}

/** Number of entries in a link table of any accepted shape, or `null` if it cannot be
 *  counted. The live graph exposes a Map-like with a numeric `.size` (measured). */
function linkTableSize(graph) {
  const links = graph?.links;
  if (!links) return null;
  if (typeof links.size === "number") return links.size;
  if (Array.isArray(links)) return links.length;
  if (typeof links === "object") return Object.keys(links).length;
  return null;
}

/**
 * What of this conversion is still on the graph.
 *
 * Three surfaces, because two were not enough (see the header): the selected nodes, the
 * subgraph-definition count, and the size of the link table — that last one being the
 * only thing that sees a wrapper which rewires links and throws before undoing it.
 *
 * `present` is compared by node IDENTITY, not by id, so an id the frontend later
 * re-issues cannot read as "the node survived".
 *
 * `wrapped` records that something replaced `convertToSubgraph` on this graph OBJECT.
 * On a stock frontend the method lives on `LGraph.prototype`, so an own property means
 * an extension is in the call path and can mutate outside everything measured here. It
 * does not make the report wrong; it makes the confident verdict unavailable.
 */
export function conversionSnapshot(graph, nodes) {
  const present = [];
  const readable = typeof graph?.getNodeById === "function";
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.id == null) continue;
    if (!readable || graph.getNodeById(node.id) === node) present.push(node.id);
  }
  const definitions = graph?.subgraphs?.size;
  return {
    present,
    readable,
    definitions: typeof definitions === "number" ? definitions : null,
    links: linkTableSize(graph),
    wrapped: !!graph && Object.prototype.hasOwnProperty.call(graph, "convertToSubgraph"),
  };
}

/**
 * The report for a conversion that threw.
 *
 * It leads with the verdict the caller acts on — did the graph change? — because that,
 * not the frontend's wording, decides whether a retry is safe. The frontend's message
 * is carried through VERBATIM and quoted: it is the only greppable thing #1463's
 * reporter had, and dropping it would break every existing search for it.
 *
 * Three verdicts, and the ONLY confident one is the negative. "Changed" needs a single
 * piece of positive evidence; "unchanged" needs every surface readable, every surface
 * still, and nothing in the call path that could have moved a surface this cannot see.
 * Everything else is UNKNOWN — a weaker answer than the old bare exception in tone, but
 * unlike a false "nothing to undo" it never sends the caller the wrong way.
 */
export function conversionThrowReport({ what, message, before, after }) {
  const raw = typeof message === "string" && message.trim() ? message.trim() : "(no message)";
  const beforeIds = Array.isArray(before?.present) ? before.present : [];
  const afterIds = Array.isArray(after?.present) ? after.present : [];
  const removed = beforeIds.filter((id) => !afterIds.includes(id));
  const num = (v) => (typeof v === "number" ? v : null);
  const addedDefs =
    num(before?.definitions) != null && num(after?.definitions) != null
      ? after.definitions - before.definitions
      : null;
  const linkDelta =
    num(before?.links) != null && num(after?.links) != null ? after.links - before.links : null;
  const tail =
    `The throw came from ComfyUI's own convertToSubgraph — the panel calls that method, it ` +
    `does not implement it, and extensions are free to replace it — so the wording quoted ` +
    `above is not necessarily litegraph's.`;

  // CHANGED — any one positive observation is enough, and each is stated as measured.
  const evidence = [];
  if (removed.length) {
    evidence.push(
      `${removed.length} of the ${beforeIds.length} node(s) you selected (${removed.join(", ")}) ` +
        `${removed.length === 1 ? "is" : "are"} already off the canvas`,
    );
  }
  if (addedDefs != null && addedDefs > 0) {
    evidence.push(`${addedDefs} subgraph definition(s) were registered`);
  }
  if (linkDelta != null && linkDelta !== 0) {
    evidence.push(`the link table went from ${before.links} to ${after.links} entries`);
  }
  if (evidence.length) {
    const halfBuilt = removed.length
      ? ` Whatever wrapper the conversion got as far as creating was never finished, so it ` +
        `can be sitting on the canvas wired to nothing.`
      : "";
    return (
      `${what} FAILED PART WAY THROUGH and the graph HAS CHANGED — do not retry blindly. ` +
      `${evidence.join("; ")}.${halfBuilt} ComfyUI's convertToSubgraph threw: "${raw}". Undo ` +
      `the conversion in ComfyUI (Ctrl+Z) or reload the workflow, then re-read the graph ` +
      `(panel_graph_outline) before doing anything else — what you passed may no longer ` +
      `describe the canvas. ${tail}`
    );
  }

  // What could have moved without this being able to see it. A confident "unchanged" is
  // only available when this list is empty.
  const blind = [];
  if (!before?.readable || !after?.readable) {
    blind.push("this frontend does not expose the node lookup the presence check needs");
  }
  if (num(before?.definitions) == null || num(after?.definitions) == null) {
    blind.push("its subgraph definitions could not be counted");
  }
  if (linkDelta == null) {
    blind.push("its link table could not be counted");
  }
  if (before?.wrapped || after?.wrapped) {
    blind.push(
      "an extension has replaced convertToSubgraph on this graph, and such a wrapper can " +
        "rewire links before delegating and throw before it undoes them",
    );
  }
  if (blind.length) {
    const measured =
      before?.readable && after?.readable
        ? `All ${beforeIds.length} node(s) you selected are still on the canvas. `
        : "";
    return (
      `${what} failed, and the panel could NOT establish whether the graph changed — treat ` +
      `the canvas as unknown rather than untouched. ${measured}What it cannot rule out: ` +
      `${blind.join("; ")}. ComfyUI's convertToSubgraph threw: "${raw}". Re-read the graph ` +
      `(panel_graph_outline) before retrying. ${tail}`
    );
  }

  // "nothing overrides it ON THIS GRAPH OBJECT" is exactly what `wrapped` measures, and
  // is all this may say: a patch applied to `LGraph.prototype` is invisible to an
  // own-property test, so the wider claim ("nothing has replaced convertToSubgraph")
  // would be false there — and an unverified sentence in a tool result gets quoted back
  // as a measurement. It costs nothing to say only the true one.
  return (
    `${what} failed and nothing the panel can read moved: all ${beforeIds.length} selected ` +
    `node(s) are still on the canvas, no subgraph definition was registered, the link table ` +
    `is unchanged at ${after.links} entries, and nothing on this graph object overrides ` +
    `ComfyUI's own convertToSubgraph. There is nothing to undo. ComfyUI's convertToSubgraph ` +
    `threw: "${raw}". A ` +
    `straight retry will hit the same thing; the selection itself is intact, so this is about ` +
    `the state of the canvas, not the nodes you named. Reloading the ComfyUI page rebuilds ` +
    `the graph and clears the stale-canvas form of this (save first — panel_save_workflow). ` +
    `${tail}`
  );
}
