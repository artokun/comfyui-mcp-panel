// ONE bounded-step primitive, shared by every panel path that must not be
// suspended by an I/O step that can fail to settle.
//
// Extracted (not re-written) from run-completion-frame.js, where it was private.
// The oversized-media preview path (#648) runs the SAME storyboard pipeline —
// sample frames, upload the sheet, HEAD its size — and therefore needs the SAME
// bound. A second timeout helper written alongside the first is how this repo
// keeps producing near-duplicate bugs, so there is one here and both callers
// import it.
//
// WHAT IT GUARANTEES
//
//   - The returned promise ALWAYS settles, and always fulfils: it never rejects.
//     A rejected `promise` degrades through `onTimeout()` exactly as a timeout
//     does, because both mean "the bounded step did not produce a result".
//   - It settles at most once. A late fulfilment after the bound has fired is
//     dropped, not raced against the fallback.
//   - The timer is cleared on settle, so a long-lived page cannot accumulate
//     pending timers per bounded step.
//   - A non-positive `ms` disables the bound and returns `promise` unchanged.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
//   It does not CANCEL the work it bounds. `buildVideoStoryboard` keeps decoding
//   and `uploadBlobToInput` keeps fetching after the bound fires; the bound only
//   stops the caller waiting on them. That is the intended contract — the caller
//   is composing a reply, not managing the pipeline's lifetime.
//
// EVERY GUARD IS ITSELF AN OPERATION THAT CAN FAIL
//
// `onTimeout()` and `clearTimer()` are injected, so both can throw. In the
// original private version a throw from either left the outer promise pending
// FOREVER — the exact failure the bound exists to prevent, reintroduced by the
// bound itself. Both are therefore called inside a catch here. When `onTimeout`
// throws there is no fallback value to report, so the step resolves `undefined`
// and the caller's own "no segment" branch handles it; that is strictly better
// than never resolving. This is the ONLY behavioural difference from the
// extracted original, and it cannot change any case where neither throws.

/**
 * Resolve `promise`, but if it has not settled within `ms`, resolve with
 * `onTimeout()` instead.
 *
 * @param {Promise<any>} promise      the bounded step
 * @param {number} ms                 wall-clock bound; <= 0 disables it
 * @param {() => any} onTimeout       fallback value factory (must be cheap + sync)
 * @param {{setTimer?:Function, clearTimer?:Function}} [timers] injectable for tests
 * @returns {Promise<any>} never rejects
 */
export function withTimeout(promise, ms, onTimeout, timers = {}) {
  // #1161 — READING the injected object is itself an operation that can fail, which is the
  // one case the note above missed while making exactly that argument about `onTimeout` and
  // `clearTimer`. A `timers` whose `setTimer` is a throwing getter, or a Proxy whose get
  // trap throws, threw HERE — synchronously, before the returned promise exists — so
  // `withTimeout` rejected out of a function whose contract three lines up says it never
  // does. Two panel commands await the oracle that calls this with no catch of their own.
  //
  // A `timers` that cannot be read is treated as one that was not supplied: the real timer
  // is used, which is the same answer as the default and always safe.
  let setTimer;
  let clearTimer;
  try {
    setTimer = timers?.setTimer;
    clearTimer = timers?.clearTimer;
  } catch {
    setTimer = undefined;
    clearTimer = undefined;
  }
  if (typeof setTimer !== "function") setTimer = (fn, delay) => setTimeout(fn, delay);
  if (typeof clearTimer !== "function") clearTimer = (t) => clearTimeout(t);
  if (!(ms > 0)) return promise;
  return new Promise((resolve) => {
    let settled = false;
    // Never let the fallback factory's own failure become "hangs forever".
    const fallback = () => {
      try {
        return onTimeout();
      } catch {
        return undefined;
      }
    };
    let t;
    let clear = clearTimer;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        clear(t);
      } catch {
        // A leaked timer is a leak; a throw here would be a wedge. Prefer the leak.
      }
      resolve(v);
    };
    const fire = () => {
      if (settled) return;
      settled = true;
      // Clear whichever timer we hold a handle for. In the arm-then-throw case
      // below this is the FALLBACK timer, fired by the leaked one — without this
      // both were left pending.
      try {
        clear(t);
      } catch {
        /* see done(): a leaked timer beats a wedge */
      }
      resolve(fallback());
    };
    try {
      t = setTimer(fire, ms);
    } catch {
      // An injected timer that cannot arm must not silently REMOVE the bound —
      // that turns "bounded, degrades" into "pending forever", which is the one
      // outcome this helper exists to prevent. Fall back to the platform timer
      // (and its matching clear, since the injected pair no longer owns it).
      //
      // Stated plainly: if `setTimer` ARMED a timer and then threw, THAT timer
      // is leaked — its handle was never returned, so nothing can clear it, and
      // there is no way to recover a handle a thrower never yielded. The result
      // is still correct (`fire` and `done` are both idempotent via `settled`),
      // and whichever of the two fires first now clears the other, so the cost
      // is exactly one stray timer rather than two.
      try {
        t = setTimeout(fire, ms);
        clear = (h) => clearTimeout(h);
      } catch {
        // No timer source at all. This step is genuinely UNBOUNDED — stated
        // rather than papered over — but the helper still never rejects: the
        // result arrives via the chain below if it ever arrives.
      }
    }
    promise.then(done, () => done(fallback()));
  });
}
