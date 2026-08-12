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
 * Name the offending nodes using the live graph, which still knows their types.
 *
 * The serialized entry has lost the type — that is precisely why it is unrunnable — so
 * the canvas is consulted for LABELS ONLY, never to decide whether to refuse. A node
 * the graph cannot name still counts; it is reported by id.
 */
export function describeUnrunnable(ids, liveNodes) {
  const byId = new Map();
  for (const n of Array.isArray(liveNodes) ? liveNodes : []) {
    if (n && n.id != null) byId.set(String(n.id), n);
  }
  return ids.map((id) => {
    const n = byId.get(id);
    const type = typeof n?.type === "string" && n.type ? n.type : null;
    return { id, type };
  });
}

/**
 * The refusal for a run whose prompt carries nodes the server cannot execute.
 *
 * Prefixed `NOT queued:` so the caller can tell a refusal from an incidental error in
 * the same block, and so it is unmistakable that nothing was sent.
 */
export function missingNodeRunRefusal(offenders) {
  const list = (Array.isArray(offenders) ? offenders : []).map((o) =>
    o?.type ? `${o.type} (node ${o.id})` : `node ${o.id}`,
  );
  const shown = list.slice(0, 12);
  const more = list.length > shown.length ? `, and ${list.length - shown.length} more` : "";
  const plural = list.length === 1 ? "" : "s";
  return (
    `NOT queued: ${list.length} node${plural} in this workflow cannot be executed by the ` +
    `server — ${shown.join(", ")}${more}. Their node types are not registered on this ` +
    `ComfyUI, so the prompt was built with no class_type for them and would have failed ` +
    `validation after being queued (comfyui-mcp#1460). Nothing was sent and the queue is ` +
    `untouched. This usually means a custom-node pack is missing or failed to load: ` +
    `install the pack that provides these types (list_packs / install_custom_node), ` +
    `restart ComfyUI so the frontend registers them, then run again. If you expected ` +
    `these nodes to be optional, delete or bypass them first — a bypassed node is ` +
    `dropped during serialization and will not trip this check.`
  );
}
