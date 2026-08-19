// Unit tests for web/js/lib/command-budget.js — ONE deadline for a whole panel command.
//
// #1192. The property under test is not "it subtracts correctly": it is that every way this
// can be WRONG fails toward a bound rather than away from one. `withTimeout` reads a
// non-positive `ms` as NO BOUND, so a budget that reports 0, a negative, NaN or Infinity to
// a caller silently removes the bound at exactly the moment the command is already too slow
// — the hang arriving through the mechanism meant to prevent it. That trap is recorded in
// #1188 and in #1180's `nodeDefsBudgetLeft`; this file is where it is checked for the third
// occurrence of the same primitive.
import test from "node:test";
import assert from "node:assert/strict";

import { makeCommandBudget } from "../../web/js/lib/command-budget.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";

/** A clock the test drives, so nothing here depends on wall-clock timing. */
function fakeClock(start = 1000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test("remaining() counts down from the total on the supplied clock", () => {
  const now = fakeClock();
  const budget = makeCommandBudget(25000, now);
  assert.equal(budget.totalMs, 25000);
  assert.equal(budget.remaining(), 25000);
  assert.equal(budget.spent(), 0);

  now.advance(4000);
  assert.equal(budget.remaining(), 21000);
  assert.equal(budget.spent(), 4000);
  assert.equal(budget.exhausted(), false);
});

test("bounded() hands out the SMALLER of what a step wants and what is left", () => {
  const now = fakeClock();
  const budget = makeCommandBudget(25000, now);

  // Plenty left ⇒ the step keeps its own bound. This is the healthy case, and it must not
  // be narrowed: shrinking a bound that had room is how a budget buys itself with false
  // refusals on a machine that was doing nothing wrong.
  assert.equal(budget.bounded(10000), 10000);

  now.advance(19000); // 6000 left
  assert.equal(budget.bounded(10000), 6000, "the command's remainder wins once it is the smaller");
  assert.equal(budget.bounded(1000), 1000, "…and a modest step is still not narrowed for no reason");
});

test("an EXHAUSTED budget yields 1ms — never a non-positive ms, which arms no bound at all", () => {
  const now = fakeClock();
  const budget = makeCommandBudget(25000, now);
  now.advance(25000);
  assert.equal(budget.exhausted(), true);
  assert.equal(budget.remaining(), 0);
  assert.equal(budget.bounded(10000), 1, "a spent budget times out immediately and truthfully");

  now.advance(60000); // deep into overrun
  assert.ok(budget.remaining() < 0, "remaining() reports the overrun honestly…");
  assert.equal(budget.bounded(10000), 1, "…but bounded() never passes a non-positive ms on");
});

test("the 1ms floor is not cosmetic: it is what keeps withTimeout ARMED", async () => {
  // The floor exists for exactly one consumer. Checked against the real primitive rather
  // than asserted as a number, because the number only matters through this behaviour.
  const now = fakeClock();
  const budget = makeCommandBudget(1000, now);
  now.advance(5000); // long spent

  const never = new Promise(() => {});
  assert.equal(
    await withTimeout(never, budget.bounded(10000), () => "degraded"),
    "degraded",
    "an exhausted budget must still produce a BOUND, not remove one",
  );
});

test("a step that names no bound of its own gets the remainder, never Infinity or NaN", () => {
  const now = fakeClock();
  const budget = makeCommandBudget(25000, now);
  now.advance(5000); // 20000 left

  for (const noBound of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "10000"]) {
    const ms = budget.bounded(noBound);
    assert.ok(
      Number.isFinite(ms) && ms > 0,
      `bounded(${String(noBound)}) produced ${ms}, which withTimeout would read as NO bound`,
    );
    assert.equal(ms, 20000, `bounded(${String(noBound)}) must fall back to the remainder`);
  }
});

test("a total that was never really set is ZERO, not infinity", () => {
  // Failing to infinity would silently restore the unbounded path — the reported bug —
  // whereas failing to zero refuses immediately and truthfully, which a caller can word.
  for (const bad of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, "25000"]) {
    const budget = makeCommandBudget(bad, fakeClock());
    assert.equal(budget.totalMs, 0, `a total of ${String(bad)} must not become an allowance`);
    assert.equal(budget.exhausted(), true);
    assert.equal(budget.bounded(10000), 1, "…and still hands out an armed bound, not a removed one");
  }
});

test("an unusable clock degrades to the platform one instead of throwing", async () => {
  // `graph_add_node` takes this budget on its FIRST line. A guard that threw here would
  // refuse every add on a page whose `performance` object is unusual — a guard causing the
  // outage it reports, which this repo has shipped before.
  const throwing = () => {
    throw new Error("no clock here");
  };
  for (const bad of [undefined, null, 42, throwing, () => Number.NaN]) {
    const budget = makeCommandBudget(50, bad);
    assert.ok(Number.isFinite(budget.remaining()), `clock ${String(bad)} must still yield a finite remainder`);
    assert.ok(budget.bounded(10) > 0);
  }
  // …and the platform fallback is a REAL clock, so the budget still expires.
  const budget = makeCommandBudget(20, undefined);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(budget.exhausted(), true, "the fallback clock must actually advance");
});

test("the clock does NOT stop: local work spends a command budget", () => {
  // The opposite of NODE_DEFS_RUN_BUDGET_MS, deliberately. A run budget is an allowance for
  // WAITING and pushes its deadline out across unbounded local work so that work escapes it.
  // The orchestrator measures wall clock from dispatch to reply, so a COMMAND budget must
  // CHARGE that work — otherwise it reports time the command does not have, and the reply
  // misses the relay window while the budget still claims to be healthy.
  const now = fakeClock();
  const budget = makeCommandBudget(25000, now);
  now.advance(4000); // registerNodesFromDefs, measured at 3972ms on this rig
  assert.equal(budget.remaining(), 21000, "unbounded local work still spends the command's window");
  assert.equal(budget.bounded(5000), 5000);
  now.advance(20000);
  assert.equal(budget.bounded(5000), 1000, "…so the steps after it get correspondingly less");
});
