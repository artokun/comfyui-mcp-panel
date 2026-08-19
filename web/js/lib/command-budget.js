// ONE deadline for a whole panel COMMAND, so the bounded steps inside it COMPOSE.
//
// #1192 — `graph_add_node`'s bounds were each defensible alone and did not add up. Run in
// sequence on one add they summed to ~33s of bounded waiting (the issue's table omits the
// 8s baseline-seed wait, so the real figure is ~41s) against a 30,000 ms relay window, and
// the worst case was therefore a bare `did not reply to "graph_add_node" within 30000 ms`
// — a message that names nothing — instead of the worded, retryable refusals each of those
// bounds exists to produce.
//
// #671 already solved this shape once for `nodes_install`: one deadline taken at the top of
// the command, every phase drawing from what is left. This is that idea extracted so the
// next command does not have to reinvent it a third time.
//
// NOT A SECOND `withTimeout`. `bounded-step.js`'s header warns that a duplicate timeout
// helper is how this repo keeps producing near-duplicate bugs, and that warning is right —
// so this deliberately does not time anything. It computes ALLOWANCES; `withTimeout` still
// APPLIES every one of them. The two compose: `withTimeout(p, budget.bounded(OWN_MS), …)`.
//
// NOR A SECOND `nodeDefsBudgetLeft`. That one is a RUN budget — an allowance for the
// WAITING inside a single `registerComfyNodeDefs` pass, and its deadline is deliberately
// pushed out across `registerNodesFromDefs`/`reapplyDefsToLiveNodes` so unbounded local
// work escapes it rather than spends it. A COMMAND budget must do the opposite:
//
//   THE CLOCK NEVER STOPS. The orchestrator measures wall clock from dispatch to reply, so
//   local work spends the command's window whether or not this panel can interrupt it.
//   Pausing here would produce a budget that reports time it does not have.
//
// What follows from that, said plainly rather than left to be discovered: a command budget
// can only guarantee that the WAITING this panel controls stops. It cannot stop
// `registerNodesFromDefs` (3972 ms measured on this rig). What it does instead is charge
// that work to the command, so every step AFTER it gets correspondingly less and the reply
// still leaves the tab inside the window — which is the property the relay actually needs.

/** The platform's monotonic clock, used when a caller supplies no readable one. */
function defaultNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Take a deadline `totalMs` from now, and hand out what is left of it.
 *
 * @param {number} totalMs the whole command's allowance
 * @param {() => number} [now] monotonic clock; the panel passes its own `monotonicNow`
 *
 * MONOTONIC, like every other elapsed-time measurement in this panel. On the wall clock an
 * NTP correction or a VM resume mid-command either exhausts the budget instantly — refusing
 * an add that had done nothing wrong — or extends it far past the relay window, which is
 * the failure the budget exists to prevent.
 *
 * A `now` that is not callable, or that throws when read, is treated as one that was not
 * supplied: the platform clock is used. A guard that THROWS here would be a guard causing
 * the outage it reports — `graph_add_node` takes this budget on its first line, so a throw
 * would refuse every add on a page whose `performance` object is unusual.
 */
export function makeCommandBudget(totalMs, now) {
  let clock;
  try {
    clock = typeof now === "function" ? now : defaultNow;
  } catch {
    clock = defaultNow;
  }
  const read = () => {
    let t;
    try {
      t = clock();
    } catch {
      t = defaultNow();
    }
    return Number.isFinite(t) ? t : defaultNow();
  };
  // A non-finite or non-positive total is a budget that was never really set. Treat it as
  // zero rather than as infinity: a command with no allowance refuses immediately and
  // truthfully, where an infinite one silently restores the unbounded path.
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0;
  const startedAt = read();
  const deadline = startedAt + total;

  const remaining = () => deadline - read();

  return {
    /** The allowance this budget was created with. */
    totalMs: total,
    /** How long the command has been running, on the monotonic clock. */
    spent: () => read() - startedAt,
    /** What is left. MAY BE NEGATIVE — callers that need to know it ran out ask for that. */
    remaining,
    /** Has the command's window closed? */
    exhausted: () => remaining() <= 0,
    /**
     * The bound for a step that would like `ms`, capped by what the command has left.
     *
     * NEVER RETURNS A NON-POSITIVE NUMBER, and that is the load-bearing part.
     * `withTimeout` treats `ms <= 0` as NO BOUND, so an exhausted budget expressed
     * literally would REMOVE the bound at exactly the moment the command is already too
     * slow — the hang arriving through the mechanism meant to prevent it. #1188 recorded
     * that trap; #1180's `nodeDefsBudgetLeft` has the same 1 ms floor for the same reason.
     * A spent budget yields 1 ms, which times out immediately and truthfully, and the
     * caller then asks `exhausted()` to word the refusal correctly.
     *
     * A `ms` that is not a positive finite number means the caller states no bound of its
     * own, so it gets the whole remainder. Never `Infinity`, never NaN — both of those
     * reach `withTimeout` as "no bound".
     */
    bounded: (ms) => {
      const left = remaining();
      const want = Number.isFinite(ms) && ms > 0 ? ms : left;
      return Math.max(1, Math.floor(Math.min(want, left)));
    },
  };
}
