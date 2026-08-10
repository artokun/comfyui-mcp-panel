/**
 * #981 — `panel_refresh_nodes` returns `{ok:true, refreshed:true}` and `panel_get_errors`
 * immediately still lists the same classes as missing, after the packs were installed
 * and ComfyUI restarted.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7. A workflow was loaded referencing a
 * class that did not exist, the class was then registered exactly as an install would
 * make it appear, and the already-placed node was re-read:
 *
 *   registered in LiteGraph : true
 *   node constructor title  : null      (unchanged)
 *   node constructor nodeData: false    (unchanged)
 *   node widgets            : []        (unchanged)
 *   missingNodesError store : still reports it
 *
 * So TWO things are stale, and the second is why the obvious fix is wrong:
 *
 *   1. the `missingNodesError` store is a LOAD-TIME snapshot the panel never clears —
 *      it exposes `removeMissingNodesByType`, and nothing in this codebase calls it;
 *   2. the already-instantiated node is NOT rehydrated by registering the class. It
 *      stays a placeholder with no definition and no widgets.
 *
 * Clearing the store alone would therefore trade one wrong answer for a worse one:
 * `panel_get_errors` would report clean while the canvas still holds a dead node that
 * fails at queue time. The reporter's own second option is the correct one — do not
 * claim a complete refresh when the placeholders did not come back — and this module
 * establishes exactly that condition.
 */

/**
 * Is this node a PLACEHOLDER — instantiated when its class was unknown, so it carries
 * no definition?
 *
 * The signal is the absence of `constructor.nodeData`, which is what ComfyUI attaches
 * when it registers a real class. Checked defensively: an unreadable node is not
 * claimed to be a placeholder, because reporting a healthy node as dead would send
 * someone reloading a workflow that was fine.
 */
export function isPlaceholderNode(node) {
  try {
    if (!node || typeof node !== "object") return false;
    return !node.constructor?.nodeData;
  } catch {
    return false;
  }
}

/**
 * Nodes that are STILL placeholders even though their class is now registered — the
 * exact state a refresh leaves behind, and the one a caller must not be told is clean.
 *
 * `isRegistered(type)` is injected so this stays pure; the caller passes a lookup over
 * the live registry or a fresh `/object_info`.
 *
 * Returns `[{ node_id, type }]`. A placeholder whose class is STILL absent is NOT
 * included: that one is genuinely missing, the existing `missing_node_types` reporting
 * already covers it, and nothing about it is stale.
 */
export function findStalePlaceholders(nodes, options) {
  const found = [];
  // `= {}` in the signature would only cover `undefined` — a caller that computed its
  // options and got `null` would take a TypeError out of a diagnostic, which is exactly
  // the failure this module exists to avoid.
  const { recordedMissingTypes, isClientRegistered } = options && typeof options === "object" ? options : {};
  if (!Array.isArray(nodes) || typeof isClientRegistered !== "function") return found;
  // MEMBERSHIP IN THE LOAD-TIME MISSING SNAPSHOT is the discriminator (codex), not the
  // absence of `nodeData`. Frontend-only nodes have no backend definition and no
  // `nodeData` at all — MEASURED: Note, Reroute, PrimitiveNode and MarkdownNote were ALL
  // reported by the first version, so a canvas with a single Note on it would have
  // demanded a reload after every refresh. Only a type the frontend actually recorded
  // as missing can have a placeholder that a reload would repair.
  const recorded =
    recordedMissingTypes instanceof Set
      ? recordedMissingTypes
      : new Set(Array.isArray(recordedMissingTypes) ? recordedMissingTypes : []);
  // Fast path only — `recorded.has(type)` below is the actual guard, and deleting this
  // line changes no behaviour (verified by mutation). It is kept so the common case,
  // where nothing was ever missing, does not walk the graph at all.
  if (!recorded.size) return found;
  for (const node of nodes) {
    try {
      if (!isPlaceholderNode(node)) continue;
      const type = typeof node.type === "string" ? node.type : null;
      if (!type || !recorded.has(type)) continue;
      let registered = false;
      try {
        // CLIENT registration, deliberately — /object_info proves the BACKEND has the
        // definition, which is not the same as this page being able to instantiate it
        // (codex). A reload only helps once the class exists here.
        registered = !!isClientRegistered(type);
      } catch {
        // Unknown registration status is not evidence the node is recoverable, and
        // claiming a reload would fix it would be a guess.
        continue;
      }
      if (!registered) continue;
      found.push({ node_id: node.id != null ? String(node.id) : null, type });
    } catch {
      /* one unreadable node costs its own entry, never the whole scan */
    }
  }
  return found;
}


/**
 * The disclosure a refresh must carry when it did not finish the job.
 *
 * Says what the refresh DID do (definitions are current), what it did not (these nodes
 * are still placeholders), and the one thing that fixes it. Empty when nothing is
 * stale, so an ordinary refresh stays quiet.
 */
export function stalePlaceholderNote(stale) {
  if (!Array.isArray(stale) || !stale.length) return "";
  const types = [...new Set(stale.map((s) => s.type))];
  const which = types.slice(0, 6).join(", ");
  const more = types.length > 6 ? `, and ${types.length - 6} more` : "";
  return (
    `The node definitions ARE now current — ${types.length} class${types.length === 1 ? "" : "es"} ` +
    `that ${types.length === 1 ? "was" : "were"} missing ${types.length === 1 ? "is" : "are"} ` +
    `registered (${which}${more}). But ${stale.length} node${stale.length === 1 ? "" : "s"} already ` +
    `on the canvas ${stale.length === 1 ? "is" : "are"} still a PLACEHOLDER: registering a class ` +
    `does not rehydrate nodes that were created while it was unknown — measured, they keep no ` +
    `definition and no widgets. They will still be reported as missing, and they will still fail ` +
    // "Reload" alone is ambiguous (codex) — a browser refresh restores whatever the
    // frontend last autosaved, which is not reliably the graph on screen. The remedy is
    // stated as the two steps it actually is: persist the graph, then reopen THAT
    // workflow, so the rebuild reads a document whose contents are known.
    `at queue time. To rebuild them against the definitions that are now present: SAVE the ` +
    `workflow, then reload/reopen that saved workflow (#981). The save is the load-bearing ` +
    `step — the rebuild reads the stored document, so anything not saved is not rebuilt, and ` +
    `a plain browser refresh restores whatever the frontend last autosaved rather than the ` +
    `graph in front of you.`
  );
}
