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
 *
 * #1332 is the other half of the same measurement. After a restart that really did
 * register the class (a fresh `panel_add_node` of that type succeeds), `panel_get_errors`
 * must not keep listing it under `missing_node_types`. The type is not missing. Leftover
 * placeholders stay a finding — they move to `stale_placeholders` / `requires_reload` —
 * so the canvas is never declared clean over a dead node. The store is still not cleared.
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
 *
 * KNOWN FALSE NEGATIVE, deliberately (codex r2). Requiring membership in the load-time
 * record means a genuine placeholder whose miss the frontend did NOT record is missed —
 * the gate is not a proof that such a node cannot exist, only a refusal to guess. That
 * is the safe direction: under-reporting costs a diagnosis, while the over-reporting it
 * replaced sent people reloading workflows that were fine.
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
 * Says exactly what the predicate established (this page can instantiate the class now),
 * what it did not (these nodes are still placeholders), and the one thing that fixes it.
 * Empty when nothing is stale, so an ordinary refresh stays quiet.
 */
export function stalePlaceholderNote(stale) {
  if (!Array.isArray(stale) || !stale.length) return "";
  const types = [...new Set(stale.map((s) => s.type))];
  const which = types.slice(0, 6).join(", ");
  const more = types.length > 6 ? `, and ${types.length - 6} more` : "";
  // EVERY CLAIM HERE IS ONE THE PREDICATE ESTABLISHES (codex r2/r3). The predicate is
  // exactly `!!LiteGraph.registered_node_types[type]` — an ENTRY in the client registry.
  // Not that the definition is current, not that this refresh registered it, not that
  // `createNode` would succeed (a constructor can be present and still throw), and
  // nothing about what the backend would do with the prompt. Earlier drafts claimed all
  // four in turn.
  return (
    `${types.length} class${types.length === 1 ? "" : "es"} ` +
    `that ${types.length === 1 ? "was" : "were"} recorded as missing when this workflow loaded ` +
    `${types.length === 1 ? "is" : "are"} NOW registered in this page's client node registry ` +
    `(${which}${more}). But ${stale.length} node${stale.length === 1 ? "" : "s"} already ` +
    `on the canvas ${stale.length === 1 ? "is" : "are"} still a PLACEHOLDER: registering a class ` +
    // PER-NODE vs MEASURED-ONCE (codex r4). The only thing tested on each reported node
    // is the absence of `constructor.nodeData`. "No widgets" came from the one live
    // instance that was instrumented, so it is attributed to that measurement rather
    // than asserted of every node in the list.
    `does not rehydrate nodes that were created while it was unknown. Each of these carries no ` +
    `class definition; on the instance measured for #981 that also meant no widgets and no ` +
    `title. They were never ` +
    `rebuilt against the class, so do not rely on ${stale.length === 1 ? "it" : "them"} ` +
    // "Reload" alone is ambiguous (codex) — a browser refresh restores whatever the
    // frontend last autosaved, which is not reliably the graph on screen. The remedy is
    // stated as the two steps it actually is: persist the graph, then reopen THAT
    // workflow, so the rebuild reads a document whose contents are known.
    // ATTEMPT, not guarantee (codex r4): the same registry entry that makes a reload
    // worth trying does not prove `createNode` will succeed.
    `at queue time. To ATTEMPT a rebuild against the registered class: SAVE the ` +
    `workflow, then reload/reopen that saved workflow (#981) — the entry in the registry is ` +
    `what makes that worth trying, not a guarantee the class constructs cleanly. The save is ` +
    `the load-bearing ` +
    `step — the rebuild reads the stored document, so anything not saved is not rebuilt, and ` +
    `a plain browser refresh restores whatever the frontend last autosaved rather than the ` +
    `graph in front of you.`
  );
}

/**
 * #1332 — drop types the live CLIENT registry can instantiate from a load-time
 * missing-node-type list.
 *
 * The store is never re-evaluated after a ComfyUI restart that registered the class
 * (stale-placeholders.js measured that). A type that is NOW in `LiteGraph.registered_node_types`
 * is not missing — `panel_add_node` of that class succeeds — so leaving it on
 * `missing_node_types` is the stale answer. Unknown registration status keeps the type
 * reported (fail closed). Order-preserving. A missing/non-function lookup is treated as
 * "cannot prove registered" and returns the input list unchanged.
 */
export function withoutClientRegisteredTypes(types, isClientRegistered) {
  if (!Array.isArray(types) || !types.length) return Array.isArray(types) ? types : [];
  if (typeof isClientRegistered !== "function") return types;
  const out = [];
  for (const t of types) {
    let registered = false;
    try {
      registered = !!isClientRegistered(t);
    } catch {
      registered = false;
    }
    if (!registered) out.push(t);
  }
  return out;
}

/**
 * True when at least one recorded missing type is NOT in the client registry — the
 * condition that makes a forced `/object_info` refresh worth paying for before
 * `panel_get_errors` adjudicates. All-registered (or an unreadable lookup) is false:
 * the filter above can drop those types without a fetch, and a 14s refresh on a
 * permanently-missing type is the same cost the missing-model path already accepts,
 * but only while something is still actually unregistered.
 */
export function anyRecordedTypeUnregistered(types, isClientRegistered) {
  if (!Array.isArray(types) || !types.length) return false;
  if (typeof isClientRegistered !== "function") return false;
  for (const t of types) {
    try {
      if (!isClientRegistered(t)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * #1332 — one decision for the two answers `panel_get_errors` must not mix:
 *
 *   stillMissing       — types the client registry still cannot instantiate
 *   stalePlaceholders  — already-placed nodes of a NOW-registered type that
 *                        were never rehydrated (#981)
 *
 * The recorded list is the load-time snapshot (after the virtual-node filter).
 * Placeholders are detected against that full snapshot, not against `stillMissing`,
 * because a type that just registered is exactly the one whose leftover nodes
 * need the save+reopen disclosure.
 */
export function adjudicateRecordedMissingNodeTypes(recordedTypes, nodes, isClientRegistered) {
  const recorded = Array.isArray(recordedTypes) ? recordedTypes : [];
  return {
    stillMissing: withoutClientRegisteredTypes(recorded, isClientRegistered),
    stalePlaceholders: findStalePlaceholders(nodes, {
      recordedMissingTypes: recorded,
      isClientRegistered,
    }),
  };
}
