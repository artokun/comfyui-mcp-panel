/**
 * #716 — one /object_info fetch per BURST of widget writes, not one per write.
 *
 * Reported: 29 `panel_set_widget` calls meant 29 full `/object_info` downloads, because the
 * fence's `getFreshObjectInfo` calls `api.getNodeDefs()` every time. Measured elsewhere in
 * this repo on a 63-pack install (#767): 5,413,770 bytes / 167 ms each. That is ~157MB of
 * redundant transfer to edit text fields on nodes that did not change between calls.
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
 * question changes scope. What changes is age: a write may be authorized against a map
 * fetched up to `ttlMs` ago. The fence's guarantee is "authorized against a recently
 * observed backend", not "atomic with the backend" — the payload is already stale the
 * instant it arrives.
 *
 * BUT AGE IS THE WHOLE POINT OF THE FENCE, so the invalidation has to be airtight, and two
 * ways it was not are the reason this file reads the way it does (codex):
 *
 *   1. A refresh that FAILS is exactly when the schema is most likely to have moved. If the
 *      cache were dropped only after a successful refresh, a failed one would leave the old
 *      entry authorizing writes for the rest of the TTL — where the old code would have
 *      fetched and failed closed. So the caller invalidates when a refresh STARTS.
 *   2. `invalidate()` clearing only the stored value left an already-running fetch able to
 *      repopulate it afterwards, and a later read able to join that pre-invalidation
 *      request. A refresh could then register new definitions while an older in-flight
 *      response restored the pre-change map for another full TTL. A generation counter
 *      makes both impossible: an invalidation retires every request issued before it.
 *
 * COVERAGE, audited and NOT claimed to be exhaustive. `registerComfyNodeDefs` — which drops
 * this cache — runs on reconnect, on the `refresh_nodes` tool, after a panel-driven Manager
 * install, on download completion, and on the combo-refresh path. Between them those cover
 * every schema change the PANEL causes or observes.
 *
 * The gap is a change made entirely outside the panel: a user uninstalling a pack through
 * ComfyUI's own Manager UI while an agent is mid-burst. Nothing tells the panel, so a widget
 * write in the following ≤1.5s could be authorized against a map that still lists the
 * removed type. Note the direction — an INSTALL is harmless here (a type missing from the
 * cached map is refused, which fails closed); only a REMOVAL can authorize something it
 * should not, and only for that window, and only for a write to that exact type.
 *
 * That is a real widening of an existing race, not a new class of hole: without this cache
 * the same uninstall could land between the fetch and the write. It is recorded here rather
 * than waved past, because the honest version is "the window grew from milliseconds to
 * ≤1.5s for out-of-panel removals", and someone weighing the TTL later needs that sentence.
 */

/**
 * The tag that marks a loader's return value as an OUTCOME WRAPPER rather than the
 * schema itself.
 *
 * A structural `"defs" in value` test would collide with a real node type named
 * `defs` (codex): a bare schema containing one would be misread as a wrapper, and that
 * single definition would become the cached schema. A Symbol cannot appear in JSON, so
 * only a producer that deliberately tagged its result can be mistaken for one.
 */
export const CACHE_OUTCOME = Symbol.for("comfyui-mcp.objectInfoOutcome");

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
  let inflightGeneration = -1;
  // Identity of the in-flight request, so the finally below can release the slot without
  // referring to a binding that may not be initialized yet.
  let inflightId = 0;
  let requestSeq = 0;
  // Bumped by every invalidation. A request carries the generation it was issued under and
  // is discarded if that no longer matches — which is what retires an in-flight fetch
  // rather than merely forgetting the value it will produce.
  let generation = 0;

  /**
   * Read through the cache AND classify the answer's provenance.
   *
   * WHY THIS LIVES HERE. Callers used to reconstruct "is this answer live" from the outside,
   * by observing whether their loader body had run. That proxy is not the question, and it
   * was wrong in three separate ways discovered one round at a time (#1126): a cache hit, a
   * response the backend reconnected underneath, and a response an `invalidate()` retired
   * mid-flight all ran the loader — or didn't — without the caller being able to tell. Each
   * fix bolted another condition onto a classifier the caller had to keep in sync with this
   * file's internals.
   *
   * So this file answers it instead, because it is the only thing that knows: it owns the
   * generation counter whose entire purpose is retiring in-flight requests, it decides
   * whether a read is served, joined, or issued, and it can compare the caller's own
   * issuance stamp across the await. A retirement mechanism added here in future is
   * classified here too, rather than silently reading as "live" at every call site.
   *
   * @param {() => Promise<any>} fetchDefs the real fetch
   * @param {{stamp?: () => unknown}} [opts] `stamp` is an opaque caller-owned token read at
   *   ISSUANCE and again at delivery — the panel passes its backend-reconnect epoch. This
   *   file never interprets it; it only reports whether it moved. Kept opaque on purpose:
   *   the cache has no business knowing what a reconnect IS, only that the caller has a
   *   fact that must not have changed underneath the request.
   * @returns {Promise<{value: any, provenance: "live"|"cache"|"reconnected"|"retired"|"unknown"}>}
   */
  async function readInternal(fetchDefs, stamp) {
    const readStamp = typeof stamp === "function" ? stamp : null;
    // SERVED from the stored payload: nobody asked the server during this call.
    if (value !== null && now() - at < ttlMs) return { value, provenance: "cache" };
    // Join a concurrent miss — but ONLY one issued under the current generation. Without
    // that check an invalidation could be overtaken by the very request it was meant to
    // retire. Coalescing matters: a burst arriving faster than the fetch completes would
    // otherwise still issue one request per caller, which is the reported symptom moved.
    //
    // A JOINED read is "cache" for the same reason a served one is: this call did not issue
    // the request, so it cannot vouch for when it was issued or for what has happened since.
    if (inflight && inflightGeneration === generation) return { value: await inflight, provenance: "cache" };
    const issuedAt = generation;
    // Captured AT ISSUANCE, exactly like `issuedAt` above and for exactly the same reason.
    // A stamp that THROWS establishes nothing, and nothing established must not be allowed
    // to read as "live" — so it degrades to "unknown", which every caller must fail closed on.
    let issuedStamp = null;
    let stampUnreadable = false;
    if (readStamp) {
      try {
        issuedStamp = readStamp();
      } catch {
        stampUnreadable = true;
      }
    }
    // An id captured BEFORE the promise exists, because `finally` must not name the
    // binding it is being assigned to: a fetchDefs() that throws SYNCHRONOUSLY runs the
    // finally before that assignment completes, and comparing against `request` there
    // raised a temporal-dead-zone ReferenceError that REPLACED the real error (codex).
    // It failed closed, but it lied about why.
    const requestId = ++requestSeq;
    const request = (async () => {
      // YIELD FIRST, and this is load-bearing rather than stylistic. A `fetchDefs()` that
      // throws SYNCHRONOUSLY would otherwise run the whole try/finally during this IIFE's
      // initial synchronous execution — before the slot below is assigned. The finally
      // would then fail to release a slot that had not been taken yet, and the rejected
      // promise would be attached immediately afterwards, so every later read in this
      // generation would join a permanently rejected request. One microtask makes the
      // ordering unconditional.
      await null;
      try {
        const defs = await fetchDefs();
        // Store only a USABLE payload from a still-current generation. Caching a
        // null/empty would pin the fence's fail-closed state for the whole TTL, turning
        // one transient failure into a second and a half of refused writes.
        // #982 — the loader may return either the schema map itself or an OUTCOME
        // wrapper `{ defs, failures }`, so a caller that JOINS an in-flight failed
        // read still receives the diagnostics of the attempt that actually ran. The
        // usability test therefore looks at the payload the fence will rule on, not at
        // the wrapper around it — a wrapper carrying `defs: null` has two keys and
        // would otherwise be cached as a success, pinning fail-closed for the TTL,
        // which is exactly what this file exists to prevent (codex).
        const payload = defs && typeof defs === "object" && defs[CACHE_OUTCOME] === true ? defs.defs : defs;
        if (
          issuedAt === generation &&
          payload &&
          typeof payload === "object" &&
          Object.keys(payload).length > 0
        ) {
          // SHARED IDENTITY IS NEW (codex): every write used to get its own object, and
          // now they share one. A consumer that mutated the map would contaminate every
          // later authorization instead of only its own call. Freezing the TOP LEVEL —
          // the level the fence's `hasOwnProperty(defs, type)` reads — makes adding or
          // removing a type key throw here and now, in a test or a dev console, rather
          // than silently authorizing a type nobody installed. Shallow on purpose: a
          // deep freeze of a 5MB schema on every fetch would cost more than the fetch
          // this exists to avoid, and per-class contents are not what the fence rules on.
          value = Object.freeze(defs);
          at = now();
        }
        return defs;
      } finally {
        // Release the slot only if it is still ours — a newer generation may have started
        // its own request while this one was in flight.
        if (inflightId === requestId) {
          inflight = null;
          inflightGeneration = -1;
          inflightId = 0;
        }
      }
    })();
    inflight = request;
    inflightGeneration = issuedAt;
    inflightId = requestId;
    // Classified only AFTER the request settles, because everything that can retire it
    // happens while it is in flight. A rejection propagates unchanged — an error has no
    // provenance to report and the caller must see the error, not a verdict about it.
    const resolved = await request;
    let currentStamp = null;
    if (readStamp && !stampUnreadable) {
      try {
        currentStamp = readStamp();
      } catch {
        stampUnreadable = true;
      }
    }
    // Order matters. A reconnect is the more specific and more actionable event — the
    // backend PROCESS was replaced, which is the one thing that changes what the server
    // publishes — and it can also have bumped the generation on its way through, so it is
    // reported in preference to the generic retirement it may have caused.
    const provenance = stampUnreadable
      ? "unknown"
      : readStamp && currentStamp !== issuedStamp
        ? "reconnected"
        : issuedAt !== generation
          ? "retired"
          : "live";
    return { value: resolved, provenance };
  }

  return {
    /**
     * Read through the cache. Unchanged contract: the payload only.
     *
     * @param {() => Promise<any>} fetchDefs the real fetch
     */
    async read(fetchDefs) {
      return (await readInternal(fetchDefs, null)).value;
    },

    /** Read through the cache and get this file's own verdict on the answer. See above. */
    async readWithProvenance(fetchDefs, { stamp } = {}) {
      return readInternal(fetchDefs, stamp);
    },

    /**
     * Drop the entry AND retire anything in flight — for anything that knows, or merely
     * suspects, that the schema may have changed.
     */
    invalidate() {
      value = null;
      at = 0;
      generation += 1;
      // Not awaited and not cancelled — it cannot be. Retiring it means its result can no
      // longer be stored or joined; whoever is already awaiting it still gets their answer.
      inflight = null;
      inflightGeneration = -1;
      inflightId = 0;
    },

    /** Test/diagnostic view. Never used to make a decision. */
    peek() {
      return { cached: value !== null, ageMs: value === null ? null : now() - at, generation };
    },
  };
}
