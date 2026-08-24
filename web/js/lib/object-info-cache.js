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
 * re-fetched — and it still does; nothing in this file caches anything but a whole map.
 *
 * #1560 QUALIFIES THE "BEFORE RESOLVING" HALF of that reason without changing what this file
 * does. On an install whose whole map never lands inside any budget, the fence now has a
 * LAST-RESORT type-scoped read (`scoped-object-info.js`) issued BELOW the promotion
 * resolution, so it can name the outer node, every intermediate AND the concrete target
 * rather than one of them, and the map it hands back THROWS for anything else instead of
 * reading it as absent. That read deliberately does NOT come through this cache: a partial
 * map stored here would be handed to the next caller as if it were whole, which is #821 with
 * a longer fuse.
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
 * Clone the JSON-shaped schema into a private graph and freeze every level. The panel hands
 * direct whole responses to frontend registration hooks, which are allowed to mutate their
 * input; the cache must never retain those mutations as backend authority.
 */
function cloneAndFreeze(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior) return prior;
  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError("object_info schema is unreadable");
  }
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new TypeError("object_info schema is unreadable");
    }
    if (!descriptor?.enumerable) continue;
    Object.defineProperty(clone, key, {
      value: cloneAndFreeze(value[key], seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Object.freeze(clone);
}

function cloneForCache(value) {
  try {
    return { ok: true, value: cloneAndFreeze(value) };
  } catch {
    // Preserve the loader's result for its current caller, but do not retain an unreadable
    // graph as a cache authority. This keeps ordinary/readFresh failure semantics unchanged.
    return { ok: false, value: null };
  }
}

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
  // #1126 — the FORCED-reread slot, separate from `inflight` on purpose. A forced read must
  // not be satisfiable by the ordinary slot (which may be serving a pre-bypass request), and
  // ordinary reads must not be able to join a forced one and mistake it for their own. Holds
  // `{ promise, issuedAt, id }` so a joiner can be classified against the generation the
  // request it rides was actually issued under.
  let freshInflight = null;
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
   * @typedef {"live"|"cache"|"reconnected"|"retired"|"unknown"} Provenance
   *
   * @param {() => Promise<any>} fetchDefs the real fetch
   * @param {{stamp?: () => unknown}} [opts] `stamp` is an opaque caller-owned token read at
   *   ISSUANCE and again at delivery — the panel passes its backend-reconnect epoch. This
   *   file never interprets it; it only reports whether it moved. Kept opaque on purpose:
   *   the cache has no business knowing what a reconnect IS, only that the caller has a
   *   fact that must not have changed underneath the request.
   * @returns {Promise<{value: any, provenance: Provenance, provenanceNow: () => Provenance}>}
   *   `provenance` is the verdict AT DELIVERY — a historical fact that never changes.
   *   `provenanceNow()` recomputes it on every call, and a caller that awaits anything before
   *   acting must use that one: definitions can be refreshed, installed, or reconnected during
   *   those awaits, and each of those moves state the classification reads.
   */
  async function readInternal(fetchDefs, stamp) {
    const readStamp = typeof stamp === "function" ? stamp : null;
    // SERVED from the stored payload: nobody asked the server during this call.
    if (value !== null && now() - at < ttlMs) return { value, ...notLive("cache") };
    // Join a concurrent miss — but ONLY one issued under the current generation. Without
    // that check an invalidation could be overtaken by the very request it was meant to
    // retire. Coalescing matters: a burst arriving faster than the fetch completes would
    // otherwise still issue one request per caller, which is the reported symptom moved.
    //
    // A JOINED read is "cache" for the same reason a served one is: this call did not issue
    // the request, so it cannot vouch for when it was issued or for what has happened since.
    if (inflight && inflightGeneration === generation) return { value: await inflight, ...notLive("cache") };
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
          // Round-6, and the same rule the forced path applies: a response that spanned a
          // RECONNECT describes a backend process that no longer exists. The generation check
          // above does not cover it — a reconnect can advance the stamp without bumping the
          // generation — and storing it would serve the dead process's schema to every reader
          // for the rest of the TTL. The response is still RETURNED to the caller that awaited
          // it (correctly labelled "reconnected"); it is only refused a place in the cache.
          stampSurvived({ readStamp, issuedStamp, stampUnreadable }) &&
          payload &&
          typeof payload === "object" &&
          Object.keys(payload).length > 0
        ) {
          // Store a private frozen graph, including the outcome wrapper and its enumerable
          // symbol tag. The loader's mutable result still goes to this caller unchanged,
          // while later cache readers cannot mutate nested schema authority through it.
          const cached = cloneForCache(defs);
          if (cached.ok) {
            value = cached.value;
            at = now();
          }
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
    return { value: resolved, ...verdict(issuedAt, issuedStamp, readStamp, stampUnreadable) };
  }

  /**
   * The verdict, and a way to ask for it AGAIN later.
   *
   * `provenance` is the classification at delivery. `provenanceNow()` recomputes it from
   * scratch on every call, and that difference is the point: a verdict is a statement about a
   * MOMENT, and it expires. A consumer that reads /object_info, then awaits a combo refresh
   * and an upload probe, and only then decides something — as set-widget's recovery ladder
   * does — is holding a classification that was true when computed and need not be by the
   * time it is used. Definitions can be refreshed, installed, or reconnected during those
   * awaits, and every one of those moves state this function reads.
   *
   * Same lesson #1223 records for its snapshot: provenance describes the CONNECTION, not the
   * bytes, so it has to be re-asked rather than remembered.
   */
  function verdict(issuedAt, issuedStamp, readStamp, stampUnreadableAtIssue) {
    const classify = () => {
      let stampUnreadable = stampUnreadableAtIssue;
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
      return stampUnreadable
        ? "unknown"
        : readStamp && currentStamp !== issuedStamp
          ? "reconnected"
          : issuedAt !== generation
            ? "retired"
            : "live";
    };
    return { provenance: classify(), provenanceNow: classify };
  }

  /** A served or joined read: not live now, and no later moment can make it so. */
  const notLive = (why) => ({ provenance: why, provenanceNow: () => why });

  /**
   * Did the connection the REQUEST was issued on survive to now?
   *
   * Used to gate STORING a payload, not just labelling it. A response that spans a reconnect
   * describes a backend process that no longer exists, and caching it would serve that dead
   * process's schema to every reader for the rest of the TTL — turning one badly-timed
   * response into a second and a half of them. The generation check beside it does not cover
   * this: a reconnect can advance the stamp WITHOUT bumping the generation, which is exactly
   * the gap that made a joiner report "live" below.
   *
   * Fails closed: an unreadable stamp establishes nothing, so nothing is stored.
   */
  function stampSurvived(rec) {
    if (rec.stampUnreadable) return false;
    if (!rec.readStamp) return true;
    try {
      return rec.readStamp() === rec.issuedStamp;
    } catch {
      return false;
    }
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
     * Force a genuinely fresh read: bypass the STORED ENTRY only, and coalesce concurrent
     * forced rereads onto one request.
     *
     * This exists because the obvious spelling — `invalidate()` then `read()` — is wrong in
     * two ways when more than one caller needs it at once, and #1126 hit both:
     *
     *   1. `invalidate()` is GLOBAL and retires everything in flight. Two writes reaching the
     *      last-resort path together would each invalidate; the second one retires the FIRST
     *      one's freshly issued request, so a perfectly valid write is handed "retired" and
     *      refuses. One caller breaking another is not a cache policy.
     *   2. Nothing coalesces, so a burst issues one multi-megabyte /object_info per caller —
     *      the exact symptom #716 exists to prevent, reintroduced on the recovery path.
     *
     * So this drops the stored value WITHOUT touching the generation or the ordinary in-flight
     * slot, and keeps its own slot that concurrent forced readers join. A joiner may reach
     * "live" — unlike on the ordinary path — because the request it rides was issued by a
     * forced read and bypassed the TTL by construction, which is the one thing an ordinary
     * joiner cannot vouch for.
     *
     * That is a claim about the PAYLOAD's age and nothing more. Every joiner is still judged
     * against the REQUEST's issuance stamp, held on the record, because a request cannot
     * vouch for a CONNECTION that changed after it was issued — see the note at the return.
     */
    async readFresh(fetchDefs, { stamp } = {}) {
      const readStamp = typeof stamp === "function" ? stamp : null;
      // Join a forced reread already running under the CURRENT generation. One issued under
      // an older generation is retired and must not be joined — that is what `invalidate()`
      // means, and this method deliberately does not weaken it.
      let record = freshInflight && freshInflight.issuedAt === generation ? freshInflight : null;
      if (!record) {
        const issuedAt = generation;
        const requestId = ++requestSeq;
        // The issuance facts live ON THE RECORD, not in this call's scope — see the classify
        // note below. A joiner must be judged against when the request it rides was ISSUED,
        // and only the record knows that.
        const rec = { issuedAt, id: requestId, readStamp, issuedStamp: null, stampUnreadable: false, promise: null };
        if (readStamp) {
          try {
            rec.issuedStamp = readStamp();
          } catch {
            rec.stampUnreadable = true;
          }
        }
        rec.promise = (async () => {
          // Yield first, for the same reason the ordinary path does: a synchronously throwing
          // fetchDefs must not run the finally before the slot below is assigned.
          await null;
          try {
            const defs = await fetchDefs();
            const payload = defs && typeof defs === "object" && defs[CACHE_OUTCOME] === true ? defs.defs : defs;
            // A forced read produces the freshest payload there is, so it is stored for
            // everyone — under the same still-current-generation and usable-payload guards
            // the ordinary path applies, and never caching a failure. Plus the stamp: a
            // response that spanned a reconnect describes a process that is gone, and
            // storing it would hand that dead schema to every reader for the whole TTL.
            if (
              issuedAt === generation &&
              stampSurvived(rec) &&
              payload &&
              typeof payload === "object" &&
              Object.keys(payload).length > 0
            ) {
              const cached = cloneForCache(defs);
              if (cached.ok) {
                value = cached.value;
                at = now();
              }
            }
            return defs;
          } finally {
            if (freshInflight && freshInflight.id === requestId) freshInflight = null;
          }
        })();
        record = rec;
        freshInflight = rec;
      }
      const resolved = await record.promise;
      // Classified against the RECORD's issuance stamp, never this caller's.
      //
      // This is the round-6 defect, and it is the round-5 lesson one level down. `readFresh`
      // reports "live" to a joiner because the request it rides bypassed the TTL — true, but
      // the TTL is about the PAYLOAD's age and the stamp is about the CONNECTION. A forced
      // read issued on epoch A, a reconnect, then a second caller reaching here on epoch B:
      // capturing the stamp per-caller compared B to B and called a response from the
      // REPLACED backend live. Reachable whenever the reconnect-triggered node-def refresh
      // coalesces with one already running, so `invalidate()` never fires and the generation
      // never moves — and it would let the unreadable-combo fallback blind-write an off-list
      // value against the old process's schema.
      //
      // A request cannot vouch for a connection that changed after it was issued, however
      // fresh its payload is. Same delivery-time-vs-now distinction `provenanceNow` exists
      // for, applied to WHICH moment the comparison is anchored at.
      if (readStamp && !record.readStamp) {
        // This caller wants reconnect detection on a request issued by one that did not, so
        // the issuance epoch was never recorded and cannot be reconstructed. Nothing
        // established, so nothing may read as live.
        return { value: resolved, ...notLive("unknown") };
      }
      return { value: resolved, ...verdict(record.issuedAt, record.issuedStamp, record.readStamp, record.stampUnreadable) };
    },

    /**
     * Replace the stored whole schema with a known-current payload.
     *
     * Direct whole-schema readers do not come through `readWithProvenance`, but their
     * definitive answer must still retire the burst entry and any request issued before
     * that answer. This is an atomic replacement: the generation moves before the value is
     * exposed, so a late old response cannot overwrite the new authority.
     *
     * Empty/unusable values are deliberately ignored. An unavailable or timed-out read is
     * not authoritative and must not turn into an invalidation merely because a caller
     * tried to publish it.
     */
    replace(next) {
      if (!next || typeof next !== "object" || Array.isArray(next)) return false;
      let keys;
      try {
        keys = Object.keys(next);
      } catch {
        return false;
      }
      if (keys.length === 0) return false;
      let frozen;
      try {
        // Keep the caller's response mutable for downstream registration hooks. The
        // ordinary loader may cache an outcome wrapper, while direct whole readers hand
        // their map to graph registration after publishing it here; cloning the complete
        // graph prevents this cache from altering the registration contract or retaining
        // nested hook mutations.
        frozen = cloneAndFreeze(next);
      } catch {
        return false;
      }
      generation += 1;
      // Retire requests issued against the replaced map. They remain awaitable by their
      // original callers, but cannot join or repopulate this cache after this point.
      inflight = null;
      inflightGeneration = -1;
      inflightId = 0;
      freshInflight = null;
      value = frozen;
      at = now();
      return true;
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
      // The forced slot is retired by the same bump — a reread issued before an invalidation
      // is exactly as superseded as an ordinary one, and leaving it joinable would let the
      // recovery path hand out an answer this invalidation was raised to discard.
      freshInflight = null;
    },

    /** Test/diagnostic view. Never used to make a decision. */
    peek() {
      return { cached: value !== null, ageMs: value === null ? null : now() - at, generation };
    },
  };
}
