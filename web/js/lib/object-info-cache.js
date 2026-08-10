/**
 * #716 — one /object_info fetch per BURST of widget writes, not per write.
 *
 * Reported: 29 `panel_set_widget` calls on one workflow meant 29 full `/object_info`
 * downloads, because the fence's `getFreshObjectInfo` calls `api.getNodeDefs()` every time.
 * Measured elsewhere in this repo on a 63-pack install (#767): `GET /object_info` is
 * 5,413,770 bytes / 167 ms. Twenty-nine of those is ~157 MB of redundant transfer to edit
 * text fields on nodes that did not change between calls.
 *
 * WHY NOT THE PER-CLASS ROUTE `/object_info/<Type>`, which #767 used for `panel_add_node`:
 * `set_widget` authorizes TWO types for a subgraph promoted write — the node's own and the
 * inner promoted node's — and it fetches BEFORE resolving which target it is writing to.
 * A single-class payload would answer the first question and read the second as absent,
 * refusing a legitimate write. That is #821 exactly: the reply is not wrong, the question
 * asked of it was. So this keeps the whole payload and shortens only how often it is
 * re-fetched.
 *
 * WHAT THIS DOES NOT WEAKEN. Every caller still receives the SAME whole-schema map, so no
 * question changes scope and no verdict changes meaning. What changes is age: a write may
 * be authorized against a map fetched up to `ttlMs` ago rather than milliseconds ago. That
 * is a difference of degree, not of kind — the payload is already stale the instant it
 * arrives, and a pack uninstalled 1ms after a fetch was never covered by the old code
 * either. The fence's guarantee is "authorized against a recently-observed backend", not
 * "atomic with the backend".
 *
 * The TTL is therefore deliberately short — long enough to cover an agent's burst of edits,
 * far too short to span a user installing a pack and then editing widgets.
 *
 * INVALIDATION IS EXPLICIT, and it is the part that makes the TTL safe to have at all.
 * Anything that KNOWS the schema changed — a node-def refresh, an install, a reconnect —
 * drops the entry, so the next read re-fetches. A cache that could only expire on time
 * would serve a stale map right after the one event most likely to change it.
 */

/** How long a fetched payload may be reused. */
export const OBJECT_INFO_CACHE_TTL_MS = 1500;

/**
 * @param {{ttlMs?: number, now?: () => number}} [opts] `now` is injectable so tests do not
 *   depend on wall-clock timing, which is how a cache test becomes a flaky test.
 */
export function createObjectInfoCache({ ttlMs = OBJECT_INFO_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  let value = null;
  let at = 0;
  let inflight = null;

  return {
    /**
     * Read through the cache.
     *
     * @param {() => Promise<any>} fetchDefs the real fetch
     */
    async read(fetchDefs) {
      if (value !== null && now() - at < ttlMs) return value;
      // COALESCE concurrent misses onto one request. Without this, a burst that arrives
      // faster than the fetch completes still issues one request per caller — which is the
      // reported symptom, merely moved.
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const defs = await fetchDefs();
          // Only a USABLE payload is cached. Caching a null/empty would pin the fence's
          // fail-closed state for the whole TTL, turning one transient failure into a
          // second and a half of refusals.
          if (defs && typeof defs === "object" && Object.keys(defs).length > 0) {
            value = defs;
            at = now();
          }
          return defs;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    /** Drop the entry — for anything that KNOWS the schema may have changed. */
    invalidate() {
      value = null;
      at = 0;
    },

    /** Test/diagnostic view. Never used to make a decision. */
    peek() {
      return { cached: value !== null, ageMs: value === null ? null : now() - at };
    },
  };
}
