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
import { withTimeout } from "./bounded-step.js";

export const CACHE_OUTCOME = Symbol.for("comfyui-mcp.objectInfoOutcome");

/** How long a fetched payload may be reused. */
export const OBJECT_INFO_CACHE_TTL_MS = 1500;

/**
 * #1161 — how long a read will WAIT for a fetch before giving up on THIS call.
 *
 * Unbounded was the P1: after a ComfyUI restart the tab can hold a half-open connection,
 * so `getNodeDefs()` never settles. `graph_set_widget` (and `graph_remove_widget`) consult
 * /object_info before writing, so it alone parked forever — every other command on the
 * same tab answered instantly, which is exactly how the report reads.
 *
 * The coalescing below is what made it permanent rather than transient: a hung request
 * stays in the `inflight` slot, so every later read JOINS the same dead promise instead
 * of issuing its own. Nothing settles it, so nothing clears it, and the command is broken
 * for the rest of the session.
 *
 * This is the same hazard the startup seed already bounds, in the same words: "a request
 * that never settles (a hung/half-open connection) would otherwise block the awaiting
 * tool FOREVER. Bounding the wait converts that hang into the correct outcome." Matching
 * that 8s deliberately — the two waits are the same decision about the same endpoint, and
 * a reader comparing them should not have to wonder why they differ.
 */
export const OBJECT_INFO_READ_WAIT_MS = 8000;

/**
 * @param {{ttlMs?: number, now?: () => number}} [opts] `now` is injectable so tests do not
 *   depend on wall-clock timing, which is how a cache test becomes a flaky test.
 */
export function createObjectInfoCache({
  ttlMs = OBJECT_INFO_CACHE_TTL_MS,
  now = () => Date.now(),
  waitMs = OBJECT_INFO_READ_WAIT_MS,
  // Injectable so the bound can be tested without a real 8s wait — the same reason `now`
  // is injectable. A test that sleeps for the timeout is a slow test that eventually
  // becomes a flaky one.
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
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

  // #1161 — the timeout note, built once. It is the whole reason the bound returns the
  // #982 wrapper rather than a bare null: without a stated cause both call sites compute
  // an empty failure list, and the refusal tells the user to hand-check a backend that
  // answers /object_info perfectly well.
  const timedOutOutcome = () => ({
    [CACHE_OUTCOME]: true,
    defs: null,
    failures: [
      `/object_info did not answer within ${waitMs}ms, so this call stopped waiting. The ` +
        `request is still running; retry shortly. The backend may be healthy.`,
    ],
  });

  /**
   * Hand a caller the in-flight request, but never let it wait forever.
   *
   * Applied to EVERY caller — issuer and joiner alike — because the bound belongs where a
   * promise is handed out, not where it is created. The first attempt at #1161 bounded
   * only the issuer, so every concurrent reader still parked on the raw promise, and the
   * burst case the bug was actually reported on was unfixed.
   *
   * Uses the repo's ONE bounded-step primitive rather than a second timeout helper, whose
   * header says exactly why: "A second timeout helper written alongside the first is how
   * this repo keeps producing near-duplicate bugs." Two hand-rolled attempts here proved
   * it. Its at-most-once contract is what stops a joiner receiving a payload this call
   * already gave up on, and it never rejects, so a throwing timer cannot reinstate the
   * unbounded wait it exists to remove.
   *
   * IT ONLY STOPS THE CALLER WAITING. It does not retire the request, and that is the
   * whole correction: an earlier version cleared the inflight slot and advanced the
   * generation, which discarded the fetch's own late payload and converted a merely SLOW
   * backend — a remote or tunnelled ComfyUI, a 5MB /object_info still loading custom
   * nodes — into a permanent refusal, measurably worse than the bug. Leaving the request
   * alone keeps every existing invariant: one fetch per burst, the late payload cached for
   * the next call, and staleness still governed by invalidate()'s generation bump.
   */
  // NOT a bare `withTimeout(request, …)`. That helper NEVER rejects by contract — a
  // rejected promise degrades through `onTimeout()` exactly as a timeout does — and this
  // cache must keep propagating a failed fetch. Three #716 tests pin that, and they caught
  // the regression: without this, a network error that fails instantly would be reported
  // to the user as "/object_info did not answer within 8000ms", which is simply false.
  //
  // So the outcome is REIFIED before it is bounded and unwrapped after: the helper still
  // provides the settle-at-most-once and never-hang guarantees, while rejection stays a
  // rejection and only a real timeout produces the timeout outcome.
  const REJECTED = Symbol("object-info-read-rejected");
  const boundRead = (request) =>
    withTimeout(
      request.then(
        (v) => ({ v }),
        (e) => ({ [REJECTED]: e }),
      ),
      waitMs,
      () => ({ timedOut: true }),
      { setTimer, clearTimer },
    ).then((r) => {
      if (r && r.timedOut) return timedOutOutcome();
      if (r && REJECTED in r) throw r[REJECTED];
      return r.v;
    });

  return {
    /**
     * Read through the cache.
     *
     * @param {() => Promise<any>} fetchDefs the real fetch
     */
    async read(fetchDefs) {
      if (value !== null && now() - at < ttlMs) return value;
      // Join a concurrent miss — but ONLY one issued under the current generation. Without
      // that check an invalidation could be overtaken by the very request it was meant to
      // retire. Coalescing matters: a burst arriving faster than the fetch completes would
      // otherwise still issue one request per caller, which is the reported symptom moved.
      // #1161 — a JOINER is bounded too. The first version of this fix installed the bound
      // only below, on the path that ISSUES the request, so this early return handed every
      // concurrent caller the raw unbounded promise and the P1 survived for exactly the
      // case that matters: #716 built this cache for BURSTS of widget writes, so after a
      // restart the issuing call gave up at the bound while every overlapping call parked
      // until the orchestrator's 30s timeout. The bound belongs where a promise is handed
      // to a caller, not where it is created.
      if (inflight && inflightGeneration === generation) return boundRead(inflight);
      const issuedAt = generation;
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
      return boundRead(request);
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
