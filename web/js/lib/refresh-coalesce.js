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
// #1192 — A CALLER MAY BOUND ITS OWN WAIT, and that is the only thing it may bound.
//
// Every branch above begins with `await current` — a wait on a run that ALREADY STARTED,
// under a deadline someone else took. A caller cannot retroactively shorten that run, and
// nothing here pretends to: `opts.joinMs` bounds the CALLER'S WAIT and never the run. The
// run keeps going, registers whatever it fetched, and clears the slot exactly as before.
//
// This exists because the wait is a real term in a command's budget. `graph_add_node` meets
// it on the scenario it is most likely to fail on — a ComfyUI restart, which is precisely
// when a reconnect-triggered refresh is already in flight — and a full run costs ~9s of
// bounded waiting plus ~4s of deliberately-unbounded local work. Unbounded, that single
// term can consume most of the add's window before its own registration has begun.
//
// WHAT AN ABANDONED JOIN MUST NOT DO is start a run anyway. The whole reason this
// coordinator exists is that two concurrent `registerNodesFromDefs` passes stampede; a
// caller that has just given up waiting for one is the last thing that should launch a
// second. So the payload is DROPPED and `REFRESH_JOIN_ABANDONED` is returned — which reads
// as a regression of #289 P2 until the caller's half is read with it: `graph_add_node` does
// not proceed on that value, it REFUSES IN WORDS and says to retry. Dropping a payload
// while refusing is safe; dropping one while claiming success is the bug #289 was about.

/**
 * Returned when the caller stopped WAITING for a refresh someone else started.
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
        return startRun(preloadedDefs);
      }
      // Forced, no payload ⇒ guarantee a fresh fetch AFTER the current run
      // settles; coalesce concurrent forced calls into ONE trailing run (#396).
      //
      // #1192 — the trailing run is SHARED, so `joinMs` bounds this caller's wait on it and
      // nothing else. A second forced caller with a longer budget still gets the same run;
      // one that gives up does not cancel it, and does not stop it from being queued. That
      // asymmetry is deliberate: the run is #396's guarantee to whoever else is waiting.
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
      const queued = trailing;
      if (joinMs === null) return queued;
      // The trailing promise must not go unhandled when this caller stops waiting on it:
      // #396 guarantees the run to other waiters, and an abandoned wait is not a reason to
      // turn its failure into an unhandled rejection.
      queued.catch(() => {});
      // A budget already spent abandons WITHOUT awaiting — see joinBounded.
      if (!(joinMs > 0)) return REFRESH_JOIN_ABANDONED;
      const settled = await withTimeout(
        queued.then(
          (value) => ({ value }),
          (err) => ({ err }),
        ),
        joinMs,
        () => null,
      );
      if (settled === null) return REFRESH_JOIN_ABANDONED;
      // A forced refresh that REJECTS has always rejected for its caller (#608 reads the
      // verdict it resolves), and a bound on the wait must not quietly turn that into a
      // success. Only the abandonment is new.
      if ("err" in settled) throw settled.err;
      return settled.value;
    }
    return startRun(preloadedDefs);
  };
}
