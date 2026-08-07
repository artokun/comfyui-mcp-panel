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
