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
// #1680 — an acknowledgement caller can opt into the opposite behavior with
// `joinInFlight:true`: when a forced, payload-less call finds an existing run,
// it subscribes to that run instead of queueing a trailing one. The opt-in is
// deliberately narrow so freshness-triggered forced callers keep #396's
// guarantee.
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
 * defs you wanted are registered", the other means "the caller stopped waiting while the
 * run was still responsible for registering them".
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
 * `abandonBeforeLocalWork` also lets a caller stop at the explicit handoff immediately
 * before a run begins synchronous schema work; the run itself is not cancelled.
 */
async function waitForRun(
  runHandle,
  ms,
  withTimeout,
  abandonBeforeLocalWork = false,
  allowEarlyResult = false,
) {
  const run = runHandle.promise;
  // Use the run's own early result, not the completion-chain result. The latter is a
  // one-shot promise that can resolve to this run before a reconnect attaches its forced
  // successor; the synchronous successor check below then keeps that stale observation
  // fail-closed.
  const earlyResult = allowEarlyResult ? (runHandle.earlyResult ?? runHandle.result) : null;
  if (ms === null) return earlyResult ? Promise.race([run, earlyResult]) : run;
  // An abandoned wait is not a reason to turn the run's failure into an unhandled rejection.
  run.catch(() => {});
  earlyResult?.catch(() => {});
  if (!(ms > 0)) return REFRESH_JOIN_ABANDONED;
  const runOutcome = Promise.resolve(run).then(
    (value) => ({ value, source: "run" }),
    (err) => ({ err, source: "run" }),
  );
  const observedOutcome = earlyResult
    ? Promise.race([
        runOutcome,
        Promise.resolve(earlyResult).then(
          (value) => ({ value, source: "early" }),
          (err) => ({ err, source: "early" }),
        ),
      ])
    : runOutcome;
  const settled = await withTimeout(
    abandonBeforeLocalWork
      ? Promise.race([
          observedOutcome,
          runHandle.beforeLocalWork.then(() => ({ beforeLocalWork: true })),
        ])
      : observedOutcome,
    ms,
    () => null,
  );
  if (settled === null) return REFRESH_JOIN_ABANDONED;
  if (settled?.beforeLocalWork === true) return REFRESH_JOIN_ABANDONED;
  if ("err" in settled) throw settled.err;
  // A forced reconnect successor may have been attached after the early promise resolved
  // but before this bounded caller resumed. The old verdict is no longer authoritative;
  // return the existing retryable status rather than reporting schema-ready over a queued
  // post-reconnect run. If the successor settled first, `runOutcome` above already wins and
  // forwards its result.
  if (settled.source === "early" && runHandle.hasSuccessor?.()) return REFRESH_JOIN_ABANDONED;
  return settled.value;
}

// #1562 — A CALLER MAY ALSO STATE THE RUN'S OWN ALLOWANCE (`opts.runBudgetMs`), which is a
// different quantity from `joinMs` and was missing.
//
// `joinMs` bounds how long THIS caller WAITS. It says nothing about how long the run it
// starts may SPEND, and the run's own default is sized for a refresh that happens as a
// sub-step of something else. When the wait is the longer of the two the run always dies
// first, and `REFRESH_JOIN_ABANDONED` — the retryable "it is still going, join it" verdict
// this coordinator exists to be able to give — becomes unreachable for the slow installs it
// was built for. Passing the value through changes nothing for a caller that omits it.
//
// FORWARDED, NEVER INTERPRETED: this stays a pure coordinator, so the value is handed to
// `runRegister` as-is and every check of it belongs there.
//
// THE TRAILING RUN IS SHARED, so it keeps the allowance of the caller that QUEUED it — the
// same asymmetry `joinMs` already documents one paragraph up, and for the same reason: the
// run is #396's guarantee to whoever else is waiting, and a later caller cannot retroactively
// re-budget work that has started.
//
//   getInFlight / setInFlight : accessors for the shared single-flight promise slot
//                               (module-level in the panel).
//   runRegister(preloadedDefs, runOpts, runControl) : performs the actual (idempotent)
//                                registration; its own cleanup must NOT clear the slot —
//                                the coalescer owns the slot lifecycle. `runOpts` is the
//                                caller's `{ runBudgetMs, preloadedWholeSchema,
//                                skipDuplicateComboRefresh }`, forwarded verbatim. `runControl`
//                                carries the pre-local-work handoff used by a bounded caller,
//                                plus `deferCompletion(promise)` for work that may outlive
//                                the register function's observation budget but still owns
//                                shared refresh state, and `publishEarlyResult(result)` for
//                                an optional terminal observation before that deferred work
//                                releases the slot.
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
  const startRun = (preloadedDefs, runOpts, abandonBeforeLocalWork) => {
    let yieldBeforeLocalWork = !!abandonBeforeLocalWork;
    let nextCompletion = null;
    let deferredCompletion = null;
    let earlyResultResolve;
    let earlyResultPublished = false;
    const earlyResult = new Promise((resolve) => {
      earlyResultResolve = resolve;
    });
    let announceBeforeLocalWork;
    const beforeLocalWork = new Promise((resolve) => {
      announceBeforeLocalWork = resolve;
    });
    let announced = false;
    const runControl = {
      beforeLocalWork: () => {
        if (!announced) {
          announced = true;
          announceBeforeLocalWork();
        }
        // Resolving the signal alone is not enough: its reaction is a microtask, and the
        // next synchronous registration call could block the tab before that reaction runs.
        // The production run awaits this one macrotask when a caller asked for the early
        // verdict, giving the caller's structured reply a chance to compose first.
        return yieldBeforeLocalWork
          ? new Promise((resolve) => setTimeout(resolve, 0))
          : undefined;
      },
      // A bounded phase may stop observing an operation that still mutates shared frontend
      // state. Keep this run's slot occupied until that operation settles; otherwise a
      // successor can overlap the late mutation and make its verdict/trust non-authoritative.
      deferCompletion: (completionPromise) => {
        const next = Promise.resolve(completionPromise);
        deferredCompletion = deferredCompletion ? deferredCompletion.then(() => next) : next;
        return next;
      },
      // A refresh may have a terminal schema verdict while a late frontend mutation still
      // owns the single-flight slot. Publish that observation separately: callers may opt
      // into the verdict, but the completion promise remains fenced until the mutation ends.
      publishEarlyResult: (result) => {
        if (earlyResultPublished) return;
        earlyResultPublished = true;
        earlyResultResolve(result);
      },
    };
    const p = (async () => {
      try {
        let result = await runRegister(preloadedDefs, runOpts, runControl);
        if (deferredCompletion) {
          const deferredResult = await deferredCompletion;
          // A deferred completion may provide the authoritative post-mutation verdict. Keep
          // the ordinary register result only for the legacy no-result form.
          if (deferredResult !== undefined) result = deferredResult;
        }
        return result;
      } finally {
        // Clear the slot only if it still points at THIS run (a later run may have
        // already replaced it).
        if (getInFlight() === p) setInFlight(null);
      }
    })();
    // A bounded refresh_nodes caller can arrive after this run was created by
    // an unbounded force-trigger (download/reconnect). Keep the handoff
    // upgradeable until the run reaches it; once local synchronous work starts,
    // no later caller can safely interrupt that JavaScript turn.
    const requestEarlyYield = () => {
      yieldBeforeLocalWork = true;
      nextCompletion?.requestEarlyYield?.();
    };
    const hasSuccessor = () => nextCompletion !== null;
    const attachNextCompletion = (next) => {
      nextCompletion = next;
      if (yieldBeforeLocalWork) next?.requestEarlyYield?.();
    };
    // A forced freshness caller may queue one trailing run while this run is still active.
    // Keep that successor in the acknowledgement handle's completion chain: joining only
    // `p` can report the older /object_info generation as complete while the fresh combo
    // rebuild is still pending (#1682). The chain is bounded once by the caller, so it cannot
    // turn a queued refresh into an unbounded acknowledgement wait.
    const completion = p.then(
      (value) => (nextCompletion ? nextCompletion.promise : value),
      (err) => (nextCompletion ? nextCompletion.promise : Promise.reject(err)),
    );
    const observedCompletion = earlyResult.then(
      (value) => (nextCompletion ? nextCompletion.result : value),
      (err) => (nextCompletion ? nextCompletion.result : Promise.reject(err)),
    );
    // The completion chain is an optional observation handle. Mark its rejection handled
    // until an acknowledgement caller elects to await it; the original run promise still
    // preserves the caller-visible rejection semantics for ordinary/coalesced paths.
    completion.catch(() => {});
    observedCompletion.catch(() => {});
    const handle = {
      promise: p,
      result: earlyResult,
      earlyResult,
      beforeLocalWork,
      requestEarlyYield,
      hasSuccessor,
    };
    handle.completion = {
      promise: completion,
      result: observedCompletion,
      earlyResult,
      requestEarlyYield,
      hasSuccessor,
    };
    handle.attachNextCompletion = attachNextCompletion;
    p.beforeLocalWork = beforeLocalWork;
    p.requestEarlyYield = requestEarlyYield;
    p.result = earlyResult;
    p.earlyResult = earlyResult;
    p.hasSuccessor = hasSuccessor;
    p.completion = handle.completion;
    p.attachNextCompletion = attachNextCompletion;
    setInFlight(p);
    return handle;
  };
  return async function refresh(preloadedDefs, opts) {
    const force = !!(opts && opts.force);
    // #1680 — panel_refresh_nodes forces a refresh when idle, but an already-running
    // node-def refresh is the completion it needs to observe. This does not alter the
    // default forced-refresh contract above; only callers that explicitly opt in join
    // the current run instead of creating a trailing one.
    const joinInFlight = !!(opts && opts.joinInFlight);
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
    // #1562 — the caller's RUN allowance, forwarded to every `startRun` below. Built here,
    // once, so no branch can start a run under a different budget than its siblings.
    const runOpts =
      opts &&
      (Number.isFinite(opts.runBudgetMs) ||
        opts.preloadedWholeSchema === true ||
        opts.skipDuplicateComboRefresh === true)
        ? {
            ...(Number.isFinite(opts.runBudgetMs) ? { runBudgetMs: opts.runBudgetMs } : {}),
            ...(opts.preloadedWholeSchema === true ? { preloadedWholeSchema: true } : {}),
            ...(opts.skipDuplicateComboRefresh === true ? { skipDuplicateComboRefresh: true } : {}),
          }
        : undefined;
    // #1758 — `joinInFlight` is the acknowledgement contract used by
    // panel_refresh_nodes. If the slot is empty at the exact call boundary, this invocation
    // becomes the refresh owner; it must still wait through its own registration/reapply
    // handoff rather than returning refresh_still_running merely because it was asked to
    // join when possible. Other bounded callers retain the explicit early-handoff behavior.
    const abandonBeforeLocalWork =
      !!(opts && opts.abandonBeforeLocalWork) && !joinInFlight;
    const remaining = () => (joinMs === null ? null : joinMs - (Date.now() - startedAt));
    const current = getInFlight();
    if (current) {
      // No payload, not forced ⇒ joining the settled refresh is enough.
      if (preloadedDefs == null && (!force || joinInFlight)) {
        // #1680 — an unbounded refresh may still be waiting at the explicit handoff before
        // synchronous registration. Ask it to yield BEFORE arming/waiting on this bounded
        // acknowledgement, so its local work cannot consume the acknowledgement's deadline.
        // The opt-in is intentionally limited to this join path; default forced callers still
        // queue the trailing freshness run below.
        const joined = joinInFlight ? current.completion ?? current : current;
        if (joinInFlight) {
          current.requestEarlyYield?.();
          joined.requestEarlyYield?.();
        }
        const joinedPromise = joined.promise ?? joined;
        if (joinInFlight && opts?.allowEarlyResult === true) {
          try {
            return await waitForRun(joined, joinMs, withTimeout, false, true);
          } catch {
            // Preserve #1680's fail-closed joined-run behavior for a run that rejected
            // before publishing its optional terminal observation.
            return;
          }
        }
        if (!(await joinBounded(joinedPromise, joinMs, withTimeout))) return REFRESH_JOIN_ABANDONED;
        // #1680 — an acknowledgement caller needs the run's freshness verdict, not just
        // proof that the promise settled. Ordinary payload-less joins intentionally retain
        // their historical undefined result because their callers only use the completion
        // as a synchronization point.
        if (joinInFlight) {
          try {
            return await joinedPromise;
          } catch {
            // A failed joined run is settled but has no freshness verdict. Preserve the
            // fail-closed undefined result so the caller reports a non-fresh outcome.
            return;
          }
        }
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
        return waitForRun(
          startRun(preloadedDefs, runOpts, abandonBeforeLocalWork),
          remaining(),
          withTimeout,
          abandonBeforeLocalWork,
        );
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
      // #1562 — a bounded refresh_nodes call may arrive after an unbounded force caller
      // already started the current run or queued the shared trailing run. Upgrade both
      // handles before waiting so either run yields at the explicit pre-local-work handoff.
      if (abandonBeforeLocalWork) {
        current.requestEarlyYield?.();
        trailing?.requestEarlyYield?.();
      }
      if (!trailing) {
        let earlyYieldRequested = abandonBeforeLocalWork;
        let queuedRunOpts = runOpts;
        let queuedHandle = null;
        const queued = (async () => {
          try {
            await current;
          } catch {
            /* the in-flight refresh failed — run our own anyway */
          }
          trailing = null;
          queuedHandle = startRun(undefined, queuedRunOpts, earlyYieldRequested);
          return queuedHandle;
        })();
        trailing = {
          // Follow the successor's own completion chain. A forced refresh can queue another
          // successor after this one starts; exposing only the raw promise would let an older
          // acknowledgement report success while that later run is still in flight.
          promise: queued.then((handle) => handle.completion?.promise ?? handle.promise),
          result: queued.then((handle) => handle.completion?.result ?? handle.result),
          earlyResult: queued.then((handle) => handle.completion?.earlyResult ?? handle.result),
          hasSuccessor: () => queuedHandle?.hasSuccessor?.() === true,
          beforeLocalWork: queued.then((handle) => handle.beforeLocalWork),
          requestEarlyYield: () => {
            earlyYieldRequested = true;
          },
          // #1736 — a later forced caller may carry the skip option that the queued
          // successor needs before it starts. Preserve the first caller's budget/options,
          // then monotonically add this freshness optimization; once the successor starts,
          // `trailing` is cleared and its run options are immutable.
          upgradeRunOpts: (nextRunOpts) => {
            if (nextRunOpts?.skipDuplicateComboRefresh !== true) return;
            queuedRunOpts = { ...(queuedRunOpts ?? {}), skipDuplicateComboRefresh: true };
          },
        };
        current.attachNextCompletion?.(trailing);
      } else {
        // #1736 — the trailing run is shared, but its options are not frozen until the
        // queued successor begins. A download completion arriving after a no-skip forced
        // caller must still upgrade that successor to skip the duplicate frontend call.
        trailing.upgradeRunOpts?.(runOpts);
      }
      return waitForRun(
        trailing,
        joinMs,
        withTimeout,
        abandonBeforeLocalWork,
        opts?.allowEarlyResult === true,
      );
    }
    // #1351 — nothing in flight, so `joinMs` has no join to bound. It still bounds THIS
    // run: the 8.0× measurement was a 2,251 ms own run against a 280 ms bound with the
    // join landing (or never starting) inside it. A bound already spent starts nothing —
    // the same as an abandoned join, and for the same `withTimeout` trap.
    if (joinMs !== null && !(joinMs > 0)) return REFRESH_JOIN_ABANDONED;
    return waitForRun(
      startRun(preloadedDefs, runOpts, abandonBeforeLocalWork),
      joinMs,
      withTimeout,
      abandonBeforeLocalWork,
      opts?.allowEarlyResult === true,
    );
  };
}
