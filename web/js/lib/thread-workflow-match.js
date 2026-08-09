/**
 * #694 — "Current workflow only" under-reported: two conversations created on the
 * same unsaved canvas, one row shown.
 *
 * Threads are stamped with the STORAGE key, `workflow:<stable uuid>`. On an unsaved
 * draft that uuid can be RE-MINTED between two records: `resolveUnsavedInstanceUuid`
 * fails CLOSED and mints a fresh uuid whenever the creation-boundary sanitizer is not
 * provably installed, because the embedded `graph.extra` uuid is copyable and adopting
 * it could cross-resume a different workflow's conversation (#570). Lost resume, never
 * wrong resume — correct, and it means two threads on one canvas can legitimately
 * carry different storage keys.
 *
 * THE STABLE IDENTIFIER ALREADY EXISTS. `workflowTabId()` for an unsaved workflow is
 * `_tempWorkflowInstanceIds.get(wf)` — keyed on the live workflow OBJECT and stable for
 * that object's lifetime (deliberately: a churning tmp: id would drive a re-hello
 * storm). A uuid re-mint does not change it. So a second, route-level stamp makes the
 * two threads recognizably the same workflow WITHOUT inferring lineage — which matters,
 * because guessing lineage wrong attaches another workflow's conversation to this one,
 * the exact failure the re-mint exists to prevent.
 *
 * SECONDARY, NEVER PRIMARY. `_tempWorkflowInstanceIds` is an in-memory WeakMap that does
 * not survive a reload, so a thread stamped ONLY with a route key would lose its match
 * entirely after a refresh — trading an under-report for a worse one. The durable uuid
 * stays the primary key; this only ADDS a way to match.
 *
 * Safe by construction, on the same authority the identity resolver already trusts:
 * a tmp: route id is per-live-object and a copy never shares the object, and a saved
 * route handle is the file path, which two tabs on the same file legitimately share —
 * and which the filter set already accepted before this change.
 */

/**
 * #847 — the two mitigations above each cover ONE axis, and a SAVE moves both at once.
 *
 * A first save migrates the tab's route id from `tmp:<uuid>` to `wf:<path>`, and the
 * same boundary re-mints the storage uuid. A thread recorded before the save is then
 * left holding neither of the live workflow's identity forms, and "Current workflow
 * only" hides a conversation the user had on the workflow they are looking at — same
 * tab, same canvas, minutes earlier. It reads as history loss, which is the one thing
 * a history pane must never appear to do.
 *
 * The panel does not have to GUESS that lineage: it already records it.
 * `_priorTempWorkflowIds` retains the first tmp: id ever minted for a live workflow
 * object, for that object's whole life, precisely "so a create-time pin survives the
 * tab's first save" — and `workflowRecordMatchesSelector` has always honoured it when
 * resolving a selector. This makes the history filter consult the same evidence
 * instead of being the one reader that ignores it. Nothing is inferred: the prior id
 * is keyed on the live object, and a copy never shares the object.
 *
 * LIMIT, stated rather than left to be discovered: `_priorTempWorkflowIds` is an
 * in-memory WeakMap, so this match does not survive a reload. A thread written before
 * a save and read after a refresh still falls back to today's behaviour. Closing that
 * needs the stamps REWRITTEN at the save boundary — a change to persisted history —
 * which is a bigger and separately reviewable step, not something to smuggle in here.
 *
 * @param {{storageKey?: string, routeId?: string, priorRouteId?: string}} forms
 * @returns {Set<string>} the identity forms a thread may legitimately match on
 */
export function currentWorkflowIdentityKeys({ storageKey, routeId, priorRouteId } = {}) {
  const keys = new Set();
  // Only real, non-empty strings. An `undefined` in the set can never match a
  // thread's stamp anyway, but a set that silently carries holes invites a later
  // reader to treat membership as meaningful when it is not.
  for (const form of [storageKey, routeId, priorRouteId]) {
    if (typeof form === "string" && form) keys.add(form);
  }
  return keys;
}

/**
 * Does `thread` belong to the workflow whose current identity forms are `currentKeys`?
 *
 * @param {{workflowKey?: string, workflowRouteKey?: string}} thread
 * @param {Set<string>} currentKeys  the live workflow's storage key AND route id
 * @returns {boolean}
 */
export function threadMatchesCurrentWorkflow(thread, currentKeys) {
  if (!thread || !currentKeys || typeof currentKeys.has !== "function") return false;
  // The durable key first — it is what survives a reload and what every existing
  // thread already carries.
  const storage = thread.workflowKey;
  if (typeof storage === "string" && storage && currentKeys.has(storage)) return true;
  // Then the route stamp, which survives a uuid re-mint within a session. Absent on
  // every thread written before this change, so an old thread simply falls back to
  // the behaviour it has today rather than mismatching.
  const route = thread.workflowRouteKey;
  return typeof route === "string" && route !== "" && currentKeys.has(route);
}

/**
 * Which previous route ids may this tab claim as ITS OWN past (#847)?
 *
 * A first save moves a tab from `tmp:<uuid>` to `wf:<path>`, and every thread stamped
 * with the old id has to follow or it drops out of "Current workflow only". The whole
 * difficulty is that `tmp:` -> `wf:` is ALSO the shape of a SWITCH from an unsaved
 * workflow A to an already-saved workflow B. An earlier cut could not tell them apart
 * and rewrote every one of A's threads to B's path — permanently attributing one
 * workflow's conversations to another (codex). That is worse than the bug being fixed,
 * and it is the failure this whole area exists to prevent.
 *
 * THE DISCRIMINATOR IS WHETHER THE OLD ID STILL NAMES AN OPEN TAB. A save CONSUMES the
 * tmp: identity — nothing answers to it afterwards. A switch leaves A open and still
 * answering. So a candidate is this tab's past only if no other open workflow claims it.
 *
 * FAILS CLOSED on an unreadable open list (`openRouteIds == null`): migrating on a guess
 * is how the cross-attribution happens, and the in-memory match covers the session
 * anyway. Returns a Set so the caller can test membership directly.
 *
 * @param {{newRouteId?: string, candidateRouteIds?: Array<string|null|undefined>,
 *          openRouteIds?: Set<string>|null}} input
 * @returns {Set<string>}
 */
export function migratableRouteIds({ newRouteId, candidateRouteIds, openRouteIds } = {}) {
  const out = new Set();
  // Only a SAVE produces a `wf:` id for this tab. Anything else is not a migration.
  if (typeof newRouteId !== "string" || !newRouteId.startsWith("wf:")) return out;
  // Unknown open set — refuse. See above.
  if (!(openRouteIds instanceof Set)) return out;
  for (const id of Array.isArray(candidateRouteIds) ? candidateRouteIds : []) {
    if (typeof id !== "string" || !id) continue;
    // Only an UNSAVED id can be a pre-save identity.
    if (!id.startsWith("tmp:")) continue;
    if (id === newRouteId) continue;
    // Still open under that id ⇒ a different workflow, not this tab's past.
    if (openRouteIds.has(id)) continue;
    out.add(id);
  }
  return out;
}
