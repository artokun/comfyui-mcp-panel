/**
 * comfyui-mcp#1460 — `panel_load_workflow` put pack nodes on the canvas, several were
 * UNREGISTERED, and `graph_run` queued anyway and failed obscurely server-side.
 *
 * ## What is actually wrong, measured on the rig
 *
 * `graphToPrompt` INCLUDES a node whose type the frontend cannot resolve, emitting it
 * with `class_type: undefined`. The prompt therefore leaves the browser carrying an
 * entry the server cannot possibly execute, and the failure surfaces as a validation
 * error about a node the caller never knowingly added.
 *
 * ## Why this checks the SERIALIZED prompt, not the canvas
 *
 * The first version walked `graph._nodes` and probed `/object_info/<type>` for each
 * distinct type. Review found that refuses runs that would have SUCCEEDED, which is
 * strictly worse than the bug: virtual and frontend-only nodes (Note, Reroute,
 * PrimitiveNode, MarkdownNote, and any extension's own display node) have no
 * `/object_info` entry at all, yet `graphToPrompt` correctly drops or rewrites them.
 * A canvas full of legitimate reroutes would have been declared unrunnable.
 *
 * Reading the serialized prompt instead removes that entire class of error, because it
 * asks the only question that matters: is there an entry in the payload we are about
 * to POST that the server cannot execute? Everything the frontend resolves, virtualises
 * or omits has already been resolved, virtualised or omitted by the time we look.
 *
 * It also removes three problems the probing version had and could not fix:
 *   - one sequential HTTP round trip per distinct type on every run (uncached)
 *   - a 200-type cap that silently skipped the tail of a large graph
 *   - a stale snapshot: the probe read the canvas while the run serialized separately
 *
 * There is now no network, no cap, and no second source of truth — the bytes inspected
 * are the bytes that would have been sent.
 */

/** A serialized entry the server cannot execute: no usable `class_type`. */
function unrunnable(entry) {
  const ct = entry?.class_type;
  return typeof ct !== "string" || ct.trim() === "";
}

/**
 * Node ids in `prompt` that carry no usable `class_type`.
 *
 * `prompt` is the object `graphToPrompt()` produces (its `output` map, or the whole
 * result — both shapes are accepted, because callers differ across frontend versions).
 * Returns `[]` for anything unrecognisable: this gates a RUN, so an input it cannot
 * read must never become a refusal.
 */
export function unrunnableNodeIds(prompt) {
  const map = prompt?.output && typeof prompt.output === "object" ? prompt.output : prompt;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const ids = [];
  for (const [id, entry] of Object.entries(map)) {
    if (entry && typeof entry === "object" && unrunnable(entry)) ids.push(String(id));
  }
  return ids;
}

/**
 * #1582 — did `graphToPrompt()` fail to produce anything we can reason about?
 *
 * A DIFFERENT question from `unrunnableNodeIds`, and the whole defect is that the two were
 * conflated. That one asks "which entries in this prompt are unrunnable?" and answers `[]`
 * for a result that does not exist — correctly, because a thing that is not there has no
 * unrunnable entries. The pre-flight then read `[]` as "the graph is fine" and handed an
 * undefined result to ComfyUI's `queuePrompt`, which dereferences `.workflow` on it and
 * throws `Cannot read properties of undefined (reading 'workflow')`.
 *
 * Absence of evidence, read as evidence of absence.
 *
 * A usable result must carry an `output` OBJECT. An empty one is fine — an empty graph
 * serializes to no nodes and is not this failure.
 */
export function graphToPromptUnusable(built) {
  if (!built || typeof built !== "object" || Array.isArray(built)) return true;
  const output = built.output;
  return !output || typeof output !== "object" || Array.isArray(output);
}

/**
 * #1582 — every node type in the workflow the frontend cannot resolve, ROOT-SCOPED.
 *
 * Serialization is root-scoped: `graphToPrompt` walks the whole workflow, including every
 * nested subgraph, whichever one the user happens to be looking at. Naming the offenders
 * from the CURRENTLY VIEWED graph therefore misses them whenever the missing pack lives in
 * a subgraph — or lives at the root while the user is inside one — leaving the generic
 * refusal on exactly the large workflows this matters most for (review). The reported graph
 * has 317 nodes.
 *
 * Bounded and cycle-safe: a `seen` set over graph objects, so a subgraph that references an
 * ancestor cannot spin, and a depth cap in case something exotic slips past that.
 */
export function unresolvedNodeTypes(rootGraph, registry) {
  const reg = registry && typeof registry === "object" ? registry : {};
  const out = new Set();
  const seen = new Set();
  const walk = (g, depth) => {
    if (!g || typeof g !== "object" || depth > 12 || seen.has(g)) return;
    seen.add(g);
    // Read each accessor ONCE. `_nodes` can be a getter, and testing it with isArray and
    // then reading it again invokes that getter twice — harmless here, but it makes "how
    // many times was this graph visited?" unanswerable, which is the property the cycle
    // guard is judged on.
    const own = g._nodes;
    const alt = own === undefined ? g.nodes : undefined;
    const nodes = Array.isArray(own) ? own : Array.isArray(alt) ? alt : [];
    for (const n of nodes) {
      const type = typeof n?.type === "string" ? n.type : null;
      if (type && !Object.prototype.hasOwnProperty.call(reg, type)) out.add(type);
      // A SubgraphNode carries its definition; both shapes appear across frontend versions.
      walk(n?.subgraph, depth + 1);
    }
    for (const sub of Array.isArray(g.subgraphs) ? g.subgraphs : []) walk(sub, depth + 1);
  };
  walk(rootGraph, 0);
  return [...out];
}

/**
 * The refusal for a graph that could not be serialized at all.
 *
 * Mirrors what the run-to-node path has always said (#556) so the two paths stop giving
 * wildly different answers to the same failure — the reporter learned the real cause only
 * because they happened to retry with `to_node_id`.
 *
 * `types` is the node types the frontend could not resolve, when we know them. When we do
 * NOT, this says so and stops: serialization can fail for reasons that have nothing to do
 * with missing packs, and naming one anyway sends the user to install something they
 * already have.
 */
export function unserializableGraphRefusal(types) {
  const list = [...new Set((Array.isArray(types) ? types : []).filter((t) => typeof t === "string" && t))];
  const shown = list.slice(0, 10);
  const more = list.length > shown.length ? `, and ${list.length - shown.length} more` : "";
  const cause = list.length
    ? `The frontend could not resolve these node types, which is the usual cause: ` +
      `${shown.join(", ")}${more}. Install the pack that provides them ` +
      `(list_packs / install_custom_node) and restart ComfyUI so the frontend registers ` +
      `them, or delete/bypass those nodes. `
    : `The panel could not identify which nodes are responsible, so this does not ` +
      `establish that a pack is missing — serialization can fail for other reasons. `;
  return (
    `NOT queued: this workflow could not be serialized into a prompt (graphToPrompt failed), ` +
    `so there was nothing to send. ${cause}` +
    `Nothing was queued and the queue is untouched. ` +
    `panel_get_errors lists the node types this ComfyUI does not recognise.`
  );
}

/**
 * Name the offending nodes using the live graph, which still knows their types.
 *
 * The serialized entry has lost the type — that is precisely why it is unrunnable — so
 * the canvas is consulted for LABELS ONLY, never to decide whether to refuse. A node
 * the graph cannot name still counts; it is reported by id.
 *
 * comfyui-mcp#1648 — `registry` (this page's `LiteGraph.registered_node_types`) is
 * consulted for the DIAGNOSIS only, never for the refusal. The refusal is still decided
 * entirely by the serialized prompt, exactly as before; this only lets the message tell
 * apart two states it used to collapse (see `missingNodeRunRefusal`).
 *
 * Each entry gains `registered: true | false` when a registry was supplied, and the key
 * is OMITTED entirely when it was not — a caller that cannot read the registry says
 * nothing about registration rather than claiming `false` for everything. A registry
 * object with no own keys is treated the same way: a page that registered NOTHING has
 * not observed anything about this type either.
 */
export function describeUnrunnable(ids, liveNodes, registry) {
  const byId = new Map();
  for (const n of Array.isArray(liveNodes) ? liveNodes : []) {
    if (n && n.id != null) byId.set(String(n.id), n);
  }
  let reg = null;
  try {
    if (registry && typeof registry === "object" && Object.keys(registry).length > 0) {
      reg = registry;
    }
  } catch {
    reg = null; // an unreadable registry is "unknown", never "not registered"
  }
  return ids.map((id) => {
    const n = byId.get(id);
    const type = typeof n?.type === "string" && n.type ? n.type : null;
    if (!reg) return { id, type };
    return {
      id,
      type,
      // A node the graph could not even name tells us nothing about registration.
      registered: type == null ? null : Object.prototype.hasOwnProperty.call(reg, type),
    };
  });
}

/** The escape hatch, kept identical in every branch: a caller with deliberately-optional
 *  nodes must never be stuck, and a bypassed node is dropped during serialization. */
const BYPASS_NOTE =
  `If you expected these nodes to be optional, delete or bypass them first — a bypassed ` +
  `node is dropped during serialization and will not trip this check.`;

/** Up to six distinct type names from a set of offenders, for a sentence. */
function typeList(offenders) {
  const types = [...new Set(offenders.map((o) => o?.type).filter((t) => typeof t === "string" && t))];
  if (!types.length) return "them";
  const shown = types.slice(0, 6).join(", ");
  return types.length > 6 ? `${shown}, and ${types.length - 6} more` : shown;
}

/**
 * The refusal for a run whose prompt carries nodes the server cannot execute.
 *
 * Prefixed `NOT queued:` so the caller can tell a refusal from an incidental error in
 * the same block, and so it is unmistakable that nothing was sent.
 *
 * ## comfyui-mcp#1648 — the refusal was right and the remedy was wrong
 *
 * The reporter installed KJNodes, restarted ComfyUI, and was told by this message to
 * install the pack and restart ComfyUI. They had. The refusal itself was correct — their
 * companion report (panel#1284, same rig) shows ComfyUI's OWN missing-nodes store naming
 * `GetNode`/`SetNode`, so those nodes really were placeholders and the run really would
 * have failed validation. What was wrong is that this text named ONE cause for a state
 * that has two, and named the one they had already ruled out:
 *
 *   1. the pack is not installed; or
 *   2. the pack IS installed and the SERVER is fine, but THIS BROWSER TAB never loaded
 *      the pack's frontend JS — those scripts are fetched when the ComfyUI page loads, so
 *      a server restart does not put new node classes into an already-open tab.
 *
 * Case 2 is the whole story for a FRONTEND-ONLY node type (the Get/Set bus, rgthree's
 * canvas-only toggles): it never appears in /object_info at all, so no amount of asking
 * the server distinguishes "not installed" from "installed, tab is stale". The one thing
 * that does distinguish them is THIS PAGE's own litegraph registry, which is what
 * `describeUnrunnable` now reads. When it has no class for the type, "reload the tab"
 * is a remedy the old text never offered.
 *
 * With no registry reading available the message is byte-identical to before — an
 * unobserved registry must not become a claim about one.
 */
export function missingNodeRunRefusal(offenders) {
  const all = Array.isArray(offenders) ? offenders : [];
  const list = all.map((o) => (o?.type ? `${o.type} (node ${o.id})` : `node ${o.id}`));
  const shown = list.slice(0, 12);
  const more = list.length > shown.length ? `, and ${list.length - shown.length} more` : "";
  const plural = list.length === 1 ? "" : "s";
  const head =
    `NOT queued: ${list.length} node${plural} in this workflow cannot be executed by the ` +
    `server — ${shown.join(", ")}${more}. `;
  const tail =
    `so the prompt was built with no class_type for them and would have failed ` +
    `validation after being queued (comfyui-mcp#1460). Nothing was sent and the queue is ` +
    `untouched. `;

  const observed = all.filter((o) => typeof o?.registered === "boolean");
  const unregistered = observed.filter((o) => o.registered === false);

  // Nothing was observed about this page's registry — say exactly what was said before.
  if (!observed.length) {
    return (
      head +
      `Their node types are not registered on this ComfyUI, ` +
      tail +
      `This usually means a custom-node pack is missing or failed to load: ` +
      `install the pack that provides these types (list_packs / install_custom_node), ` +
      `restart ComfyUI so the frontend registers them, then run again. ` +
      BYPASS_NOTE
    );
  }

  if (unregistered.length) {
    return (
      head +
      `This page has no node class registered for ${typeList(unregistered)}, ` +
      tail +
      `TWO different things produce that, and they need different fixes. ` +
      `(1) The pack is not installed — install it (list_packs / install_custom_node) and ` +
      `restart ComfyUI. ` +
      `(2) The pack IS installed and the server is fine, but THIS BROWSER TAB never loaded ` +
      `its frontend JS: a pack's scripts are fetched when the ComfyUI page loads, so ` +
      `installing a pack and restarting the server does NOT add its node classes to a tab ` +
      `that was already open — RELOAD the ComfyUI tab. If you have already installed the ` +
      `pack and restarted ComfyUI, do that first. ` +
      `Case (2) is the only possibility for a FRONTEND-ONLY node type (KJNodes' Get/Set ` +
      `bus, rgthree's Label and Fast Groups toggles): those never appear in /object_info ` +
      `at all, so nothing the server reports can confirm or deny them. ` +
      BYPASS_NOTE
    );
  }

  // Every type this page WAS ASKED ABOUT is registered here, so a reload changes nothing
  // for those. Only what the serializer observed is asserted: it takes an entry's
  // class_type from the node's own `comfyClass`, and it omits a node entirely when that
  // node reports `isVirtualNode` — so an entry that arrived with neither came from a
  // registered class that has no backend node behind it and does not declare itself
  // virtual. Nothing is claimed about which pack is at fault or how to repair it.
  //
  // SCOPED to the offenders the graph could name. A node the canvas could not name has an
  // unknown type, so nothing was established about it and the sentence must not sweep it
  // in — that would be a claim of "nothing is missing" built on a node never looked at.
  const unnamed = all.length - observed.length;
  return (
    head +
    `This page DOES have a node class registered for ${typeList(observed)}, so reloading ` +
    `will not change those — but the serializer still emitted no class_type for them, ` +
    tail +
    `An entry's class_type comes from the node's own comfyClass, and a node that reports ` +
    `isVirtualNode is left out of the prompt entirely; these did neither, so the registered ` +
    `class has no backend node behind it and does not declare itself virtual. That is a ` +
    `problem in the pack's own frontend node rather than anything this ComfyUI is missing. ` +
    (unnamed
      ? `The other ${unnamed} node${unnamed === 1 ? "" : "s"} could not be named from the ` +
        `canvas, so nothing is established about ${unnamed === 1 ? "it" : "them"}. `
      : "") +
    BYPASS_NOTE
  );
}
