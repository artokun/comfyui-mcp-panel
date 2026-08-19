// Coalesces overlapping node-def refreshes so a caller-supplied FRESH /object_info
// payload is never DROPPED by joining an OLDER in-flight refresh (#289 P2).
//
// The panel keeps a SINGLE in-flight refresh promise so concurrent triggers (a
// websocket reconnect + a graph_add_node) don't stampede registerNodesFromDefs.
// The naive "if in-flight, return it" dedupe silently drops a newer payload:
// graph_add_node fetches fresh /object_info (containing a just-installed NewNode)
// and calls refresh(freshDefs), but if a reconnect refresh carrying an OLDER
// payload is already running, joining it leaves NewNode unregistered and the add
// re-check fails — a false "unknown node type" for a genuinely-installed node.
//
// This coordinator fixes that: with NO payload, joining the in-flight refresh is
// enough. With a payload, it WAITS for the in-flight refresh to settle, THEN runs a
// fresh refresh that registers the newer payload — so the payload is never dropped.
//
// A payload-less `force:true` refresh (#396) is the third case. A no-payload
// refresh triggered by a state change that JUST happened — e.g. a model download
// completing — cannot simply join an in-flight run, because that run's
// /object_info FETCH may have started BEFORE the change and so won't reflect it.
// Joining it would report success while the new file is still absent from the
// combos. So a forced call GUARANTEES a fresh registration whose fetch begins
// AFTER the current run settles. Multiple forced calls that arrive during one
// in-flight run coalesce into a SINGLE trailing run (no /object_info stampede).
//
// #1192 / #1351 — A CALLER MAY BOUND ITS OWN WAIT. That wait is the whole invocation,
// not just the join.
//
// Every branch above begins with `await current` — a wait on a run that ALREADY STARTED,
// under a deadline someone else took. A caller cannot retroactively shorten that run, and
// nothing here pretends to: `opts.joinMs` never cancels work already in flight. The run
// keeps going, registers whatever it fetched, and clears the slot exactly as before.
//
// #1192 bounded the JOIN. That was not enough. With a payload the join is followed by
// THIS caller's own `startRun`, and `joinMs` used to ignore that second wait. Measured:
// a 280 ms bound, join landing inside it, then the own run adding 2,251 ms (8.0×). With
// shipped numbers a join can end at 20,000 ms and the own run then adds ~13,000 ms
// (NODE_DEFS_RUN_BUDGET_MS plus the deliberately-unbounded local work) — ~33 s against
// the 30 s relay window, with every per-step bound respected. So `joinMs` is a deadline
// for this invocation: the join, then whatever remains for the run this caller starts.
// The run is not cancelled (nothing here can cancel it); the caller stops WAITING.
//
// WHAT AN ABANDONED JOIN MUST NOT DO is start a run anyway. The whole reason this
// coordinator exists is that two concurrent `registerNodesFromDefs` passes stampede; a
// caller that has just given up waiting for one is the last thing that should launch a
// second. So the payload is DROPPED and `REFRESH_JOIN_ABANDONED` is returned — which reads
// as a regression of #289 P2 until the caller's half is read with it: `graph_add_node` does
// not proceed on that value, it REFUSES IN WORDS and says to retry. Dropping a payload
// while refusing is safe; dropping one while claiming success is the bug #289 was about.
//
// An abandoned OWN RUN is the other half. The join already settled, so starting the run
// is not a stampede — the slot is free and the payload is the one this caller brought.
// The run is started, occupies the slot, and keeps registering; only this caller's wait
// ends. Retry then joins a run that is already registering the class it asked for.

/**
 * Returned when the caller stopped WAITING — either for a refresh someone else started,
 * or for a run this caller started that did not finish inside what `joinMs` had left.
 *
 * A distinct value rather than `undefined`, because `undefined` is already what a
 * successful plain join resolves to and the two demand opposite handling — one means "the
 * defs you wanted are registered", the other means "nobody registered anything for you".
 */
export const REFRESH_JOIN_ABANDONED = Symbol("refresh-join-abandoned");

/**
 * Wait for `current` to SETTLE (either way), for at most `joinMs`.
 *
 * Resolves true when it settled, false when the wait was abandoned. Reified before
 * bounding for the reason `boundedGetNodeDefs` reifies: `withTimeout` degrades a rejection
 * through `onTimeout()` exactly as it does a timeout, so bounding `current` directly would
 * report an in-flight run that FAILED as one that never answered — and this coordinator has
 * always treated a failed in-flight run as a settled one (the caller then runs its own).
 *
 * `joinMs <= 0` abandons WITHOUT awaiting. It must never reach `withTimeout`, which reads a
 * non-positive `ms` as NO BOUND — a budget expressed at exactly the moment it ran out would
 * otherwise restore the unbounded wait.
 */
async function joinBounded(current, joinMs, withTimeout) {
  if (joinMs === null) {
    try {
      await current;
    } catch {
      /* a failed in-flight run is a settled one */
    }
    return true;
  }
  if (!(joinMs > 0)) return false;
  return withTimeout(
    Promise.resolve(current).then(
      () => true,
      () => true,
    ),
    joinMs,
    () => false,
  );
}

/**
 * Wait for a run THIS caller started (or a shared trailing run), for at most `ms`.
 *
 * Distinct from `joinBounded`: the run already belongs to this invocation (or to #396's
 * trailing guarantee), so a timeout does not cancel it and does not prevent it occupying
 * the slot. The caller stops waiting and says so. `ms <= 0` must not reach `withTimeout`,
 * which reads a non-positive bound as NO BOUND.
 *
 * A rejecting run still rejects: #608 reads the verdict a forced refresh resolves, and a
 * bound on the wait must not quietly turn that into a success. Only the abandonment is new.
 */
async function waitForRun(run, ms, withTimeout) {
  if (ms === null) return run;
  // An abandoned wait is not a reason to turn the run's failure into an unhandled rejection.
  run.catch(() => {});
  if (!(ms > 0)) return REFRESH_JOIN_ABANDONED;
  const settled = await withTimeout(
    Promise.resolve(run).then(
      (value) => ({ value }),
      (err) => ({ err }),
    ),
    ms,
    () => null,
  );
  if (settled === null) return REFRESH_JOIN_ABANDONED;
  if ("err" in settled) throw settled.err;
  return settled.value;
}

//   getInFlight / setInFlight : accessors for the shared single-flight promise slot
//                               (module-level in the panel).
//   runRegister(preloadedDefs) : performs the actual (idempotent) registration; its
//                                own cleanup must NOT clear the slot — the coalescer
//                                owns the slot lifecycle.
//   withTimeout                : the repo's ONE bounding primitive (bounded-step.js),
//                                injected rather than imported so this module stays a
//                                pure coordinator and a test can drive the clock. Omit it
//                                and `opts.joinMs` has nothing to bound with — so an
//                                unwired coalescer waits unbounded, exactly as it always
//                                did, rather than silently abandoning every join.
export function makeRefreshCoalescer({ getInFlight, setInFlight, runRegister, withTimeout }) {
  // The single queued trailing (forced, no-payload) run, or null when none is
  // pending. Coalesces any number of forced calls arriving during one in-flight run.
  let trailing = null;
  const startRun = (preloadedDefs) => {
    const p = (async () => {
      try {
        return await runRegister(preloadedDefs);
      } finally {
        // Clear the slot only if it still points at THIS run (a later run may have
        // already replaced it).
        if (getInFlight() === p) setInFlight(null);
      }
    })();
    setInFlight(p);
    return p;
  };
  return async function refresh(preloadedDefs, opts) {
    const force = !!(opts && opts.force);
    // #1192 — a bound only when the caller asked for one AND a primitive was wired. Both
    // halves matter: `Number.isFinite` rejects the `Infinity`/`NaN` a caller can compute
    // from an unset budget, and an unwired `withTimeout` must leave today's unbounded wait
    // rather than abandon every join at once.
    const joinMs =
      opts && Number.isFinite(opts.joinMs) && typeof withTimeout === "function"
        ? opts.joinMs
        : null;
    // #1351 — `joinMs` is a deadline for THIS invocation, taken once, so the join and the
    // run that follows it COMPOSE rather than add. Wall clock, matching `withTimeout`.
    const startedAt = joinMs === null ? 0 : Date.now();
    const remaining = () => (joinMs === null ? null : joinMs - (Date.now() - startedAt));
    const current = getInFlight();
    if (current) {
      // No payload, not forced ⇒ joining the settled refresh is enough.
      if (preloadedDefs == null && !force) {
        if (!(await joinBounded(current, joinMs, withTimeout))) return REFRESH_JOIN_ABANDONED;
        return;
      }
      // Payload present ⇒ wait for the in-flight run, then register the NEWER
      // payload so a freshly-installed node's defs are not dropped (#289 P2).
      if (preloadedDefs != null) {
        // #1192 — and if the wait is abandoned, the payload IS dropped. Starting our own
        // run here would put a second `registerNodesFromDefs` alongside one still going,
        // which is the stampede this coordinator exists to prevent. The caller refuses.
        if (!(await joinBounded(current, joinMs, withTimeout))) return REFRESH_JOIN_ABANDONED;
        // #1351 — the join settled, so starting our own run is not a stampede. What remains
        // of `joinMs` bounds the wait on THAT run. Wrapping join+run as one promise and
        // bounding it once would start the run after an abandoned join — the stampede.
        return waitForRun(startRun(preloadedDefs), remaining(), withTimeout);
      }
      // Forced, no payload ⇒ guarantee a fresh fetch AFTER the current run
      // settles; coalesce concurrent forced calls into ONE trailing run (#396).
      //
      // #1192 — the trailing run is SHARED, so `joinMs` bounds this caller's wait on it and
      // nothing else. A second forced caller with a longer budget still gets the same run;
      // one that gives up does not cancel it, and does not stop it from being queued. That
      // asymmetry is deliberate: the run is #396's guarantee to whoever else is waiting.
      // The queued promise already includes the trailing `startRun`, so this one bound
      // covers join AND run — the shape #1351 brings to the payload path as well.
      if (!trailing) {
        trailing = (async () => {
          try {
            await current;
          } catch {
            /* the in-flight refresh failed — run our own anyway */
          }
          trailing = null;
          return startRun(undefined);
        })();
      }
      return waitForRun(trailing, joinMs, withTimeout);
    }
    // #1351 — nothing in flight, so `joinMs` has no join to bound. It still bounds THIS
    // run: the 8.0× measurement was a 2,251 ms own run against a 280 ms bound with the
    // join landing (or never starting) inside it. A bound already spent starts nothing —
    // the same as an abandoned join, and for the same `withTimeout` trap.
    if (joinMs !== null && !(joinMs > 0)) return REFRESH_JOIN_ABANDONED;
    return waitForRun(startRun(preloadedDefs), joinMs, withTimeout);
  };
}
