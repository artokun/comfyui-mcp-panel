/**
 * #1181 — a frontend-only VIRTUAL value source (the canvas PrimitiveNode) wired
 * INTO a promoted subgraph input never reaches the prompt.
 *
 * Reported on ComfyUI 0.32.0 / frontend 1.48.7: a PrimitiveNode connected to a
 * promoted STRING input on a subgraph showed the new value on the canvas, and
 * panel_query_graph reported the subgraph input as link-driven — but
 * `app.graphToPrompt` DROPS the virtual node, so the link carries nothing
 * across the subgraph boundary and the inner node's STORED widget value is what
 * serialized. The execution succeeded silently with the old prompt and reused
 * cached conditioning: canvas state and actual execution prompt disagreed. The
 * reporter verified the counterpart too — a BACKEND PrimitiveStringMultiline
 * wired the same way appears in the execution graph and drives the value.
 *
 * A whole-graph `panel_run` hands prompt construction to ComfyUI's own
 * `app.queuePrompt`, so the panel does not build this prompt and cannot carry
 * the value across the boundary itself. What it CAN do is stop being silent —
 * and stop asserting the opposite of the truth, which is what the read path did
 * before this issue: `linkDrivenWidgets` flags any link-connected widget as
 * "OVERRIDDEN by a link at run time — the stored value is stale, NOT what
 * executes", which is exactly backwards when the link's origin is a virtual
 * node the prompt compiler drops.
 *
 * WHY THE TARGET IS A SUBGRAPH CONTAINER: a top-level PrimitiveNode feeding an
 * ORDINARY node works — graphToPrompt resolves the primitive's value into the
 * consumer's widget. The value is lost only at the subgraph boundary, where the
 * promoted input's inner consumers are rewired to an origin that no longer
 * exists in the prompt. So `virtualFedInputs` fires on container inputs only.
 *
 * Read-only and dependency-free, like graph-read.js / muted-subgraph-outputs.js,
 * so it can be unit-tested in isolation
 * (browser_tests/unit/virtual-source-promotion.test.mjs). Nothing here mutates
 * the graph: pushing the primitive's value into the inner widget during a read
 * or a run is exactly the silent-mutation class #979/#233 forbid.
 */

/**
 * True when `node` is a frontend-only VIRTUAL value source whose output cannot
 * reach the serialized prompt: ComfyUI's graphToPrompt drops it, so a link from
 * it carries nothing.
 *
 * Two positive shapes, both deliberately narrow:
 *   1. type "PrimitiveNode" — the reported, verified case. The broader
 *      FRONTEND_ONLY_NODE_TYPES allowlist is NOT reused wholesale: Note has no
 *      outputs, a Reroute relays whatever is upstream (fine when the upstream
 *      is real), and KJNodes' Get/Set bus is resolved BY graphToPrompt — calling
 *      any of those "carries nothing" would be a false claim.
 *   2. any OTHER litegraph virtual node (`isVirtualNode === true`) that is not a
 *      subgraph container and has NO connected input to forward — whatever it
 *      displays lives only in the frontend. A subgraph container is excluded
 *      explicitly: it is virtual too, but its outputs are COMPUTED from real
 *      inner nodes and serialize normally.
 */
export function isNonSerializingValueSource(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "PrimitiveNode") return true;
  if (node.isVirtualNode === true && !node.subgraph) {
    return !(node.inputs ?? []).some((i) => i?.link != null);
  }
  return false;
}

/** Resolve a node by id inside `graph`, tolerating both live-graph shapes. */
function nodeById(graph, id) {
  if (!graph || id == null) return null;
  if (typeof graph.getNodeById === "function") return graph.getNodeById(id) ?? null;
  const nodes = Array.isArray(graph._nodes) ? graph._nodes : Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes.find((n) => String(n?.id) === String(id)) ?? null;
}

/**
 * Map of input-name → { node_id, output_slot, origin_type } for every input on a
 * SUBGRAPH CONTAINER whose link origin is a non-serializing virtual source —
 * i.e. a promoted input that LOOKS fed but receives nothing at queue time.
 *
 * Keyed by input name so it composes with `linkDrivenWidgets`/`drivenWidgetsFor`
 * (same key space). `graph` defaults to `node.graph`; the graph walker passes it
 * explicitly because a container found mid-walk may not carry a back-pointer.
 * Never throws: a malformed link or missing origin yields fewer entries.
 */
export function virtualFedInputs(node, graph = node?.graph) {
  const out = {};
  if (!node?.subgraph) return out;
  const links = graph?.links ?? {};
  for (const inp of node.inputs ?? []) {
    if (!inp || inp.link == null || typeof inp.name !== "string") continue;
    const l = links[inp.link];
    if (!l) continue;
    // Support both object links ({origin_id,origin_slot}) and array links [id,os,...].
    const originId = l.origin_id ?? l[1];
    const originSlot = l.origin_slot ?? l[2];
    if (originId == null) continue;
    const origin = nodeById(graph, originId);
    if (!isNonSerializingValueSource(origin)) continue;
    out[inp.name] = {
      node_id: originId,
      output_slot: originSlot ?? 0,
      origin_type: typeof origin.type === "string" ? origin.type : null,
    };
  }
  return out;
}

/**
 * Walk every graph level, depth-first, and return one finding per promoted
 * subgraph input fed by a non-serializing virtual source. Used by `graph_run`
 * to say at QUEUE time that a run will ignore the canvas value.
 *
 * The cycle guard is PATH-LOCAL (a new Set per branch), matching
 * collectDisabledAncestorOutputs: one subgraph definition can be instanced more
 * than once, and a global visited set would consume the shared definition on
 * the first instance and miss the second. Fully defensive — a diagnostic must
 * never take down the run it describes.
 */
export function collectVirtualSourceFeeds(rootGraph) {
  const found = [];
  const walk = (graph, seenOnPath) => {
    if (!graph || seenOnPath.has(graph)) return;
    const nextSeen = new Set(seenOnPath);
    nextSeen.add(graph);
    const nodes = Array.isArray(graph._nodes) ? graph._nodes : Array.isArray(graph.nodes) ? graph.nodes : [];
    for (const node of nodes) {
      if (!node || node.id == null) continue;
      if (node.subgraph) {
        const fed = virtualFedInputs(node, graph);
        for (const [name, src] of Object.entries(fed)) {
          found.push({
            subgraph_node_id: String(node.id),
            subgraph_title: typeof node.title === "string" ? node.title : null,
            input_name: name,
            origin_id: String(src.node_id),
            origin_type: src.origin_type,
          });
        }
        walk(node.subgraph, nextSeen);
      }
    }
  };
  try {
    walk(rootGraph, new Set());
  } catch {
    /* partial findings beat none; never throw out of a diagnostic */
  }
  return found;
}

/**
 * The queue-time sentence. States what happens (the source is dropped, the
 * STORED inner value executes), that the panel is not the one deciding it, the
 * build it was measured on, and the remedy the reporter verified — a BACKEND
 * primitive carries the value across the same boundary.
 */
export function virtualSourceNote(feeds) {
  if (!Array.isArray(feeds) || feeds.length === 0) return "";
  const n = feeds.length;
  const which = feeds
    .slice(0, 5)
    .map(
      (f) =>
        `${f.origin_type ?? "virtual node"} #${f.origin_id} → subgraph #${f.subgraph_node_id} input "${f.input_name}"`,
    )
    .join("; ");
  const more = n > 5 ? `; and ${n - 5} more` : "";
  return (
    `This workflow feeds ${n} promoted subgraph input${n === 1 ? "" : "s"} from a frontend-only ` +
      `VIRTUAL node — ${which}${more}. On the build this was measured on (ComfyUI 0.32.0 / ` +
      `frontend 1.48.7) the prompt compiler DROPS that source: the value on the link does NOT ` +
      `reach the prompt, and each inner node's STORED widget value is what executes — the run ` +
      `renders the OLD value while the canvas shows the new one, and nothing in the run says so ` +
      `(#1181). This is read from the GRAPH, not from the queued prompt — the panel does not build ` +
      `that prompt and cannot carry the value across the boundary — so on a build that resolves ` +
      `virtual sources through subgraph inputs this warns about a run that was fine. To make the ` +
      `canvas value take effect, replace the virtual source with a BACKEND node (e.g. ` +
      `PrimitiveStringMultiline, verified by the reporter), or set the inner node's widget directly.`
  );
}

/**
 * The outline/compact-row counterpart of `drivenTag` for a widget whose link
 * origin is a non-serializing virtual source. The plain tag ("link-driven")
 * means "the stored value is stale, the link overrides it" — true for a real
 * source, exactly backwards for this one, so it needs its own words.
 */
export function virtualSourceTag(src) {
  if (!src) return "";
  return ` [⚠ virtual source #${src.node_id}.${src.output_slot} — NOT serialized; the stored value is what executes]`;
}
