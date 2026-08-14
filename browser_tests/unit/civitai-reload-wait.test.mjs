import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  awaitReloadWithin,
  classifyHighlightOutcome,
  RELOAD_WAIT_BUDGET_MS,
} from "../../web/js/lib/civitai-reload-wait.js";

/**
 * comfyui-mcp#1520 — `driveGetResults` and `driveHighlight` awaited
 * `state.activeReloadPromise` with no bound. That promise wraps a CivitAI fetch,
 * so the panel's reply deadline was set by a third party: on a slow or 503-ing
 * CivitAI the orchestrator's bridge timed out and the caller got an error
 * carrying no information, from a panel that was working perfectly.
 *
 * These pin the adapter's semantics. It is a thin wrapper over the shared
 * `withTimeout` primitive, which is itself well covered — but the ORDER of its
 * two transforms is easy to invert, and inverting it produces a
 * plausible-looking wrong answer rather than a crash.
 *
 * This imports the SAME module cmcp-civitai-ui.js imports. An earlier version
 * mirrored the adapter's source into this file because the UI module pulls in
 * the DOM on import; that tests a copy and lets the copy drift, so the adapter
 * was extracted to lib/ instead.
 */

/** Fires the armed timer on demand, so no test has to sleep for a real budget. */
function manualTimers() {
  let fire = null;
  let armed = false;
  let didClear = false;
  return {
    timers: {
      setTimer: (fn) => {
        fire = fn;
        armed = true;
        return 1;
      },
      clearTimer: () => {
        didClear = true;
        fire = null;
      },
    },
    expire: () => {
      assert.ok(fire, "no timer was armed — the bound is not in effect");
      fire();
    },
    /** True only if a timer was actually armed AND later cleared. */
    cleared: () => armed && didClear,
  };
}

test("a reload that settles in budget reports settled", async () => {
  assert.equal(await awaitReloadWithin(Promise.resolve("page1"), 12000), true);
});

test("no reload in flight is settled, not pending", async () => {
  // `state.activeReloadPromise` is null whenever nothing is loading. Reporting
  // that as pending would make every quiet read look like a stalled fetch.
  assert.equal(await awaitReloadWithin(null, 12000), true);
});

test("a reload that outruns the budget reports pending, and does so promptly", async () => {
  const { timers, expire } = manualTimers();
  const never = new Promise(() => {}); // the 503-and-retry case
  const p = awaitReloadWithin(never, 12000, timers);
  expire();
  assert.equal(await p, false);
});

test("a FAILED reload is settled, not pending — the ordering that is easy to invert", async () => {
  // withTimeout routes a rejection to the same fallback as a timeout, which is
  // right for a step that yielded no result and wrong here: a failed fetch DID
  // finish. It surfaces to the caller as `state.error`. Calling it pending would
  // tell the agent to re-read and wait for an answer that already arrived.
  //
  // Passing the raw rejected promise to withTimeout is what produces the wrong
  // answer, so this fails if the `.then(() => true, () => true)` is dropped.
  const { timers } = manualTimers();
  assert.equal(await awaitReloadWithin(Promise.reject(new Error("503")), 12000, timers), true);
});

test("a rejected reload never escapes as an unhandled rejection", async () => {
  // The drive methods have no try/catch around this call any more; the original
  // code did (`try { await … } catch {}`). If the adapter let a rejection
  // through, the failure would be a broken command, not a wrong field.
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await awaitReloadWithin(Promise.reject(new Error("boom")), 12000, manualTimers().timers);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(seen, [], "a reload rejection escaped the adapter");
});

test("the budget stays clear of the orchestrator's 20s bridge bound", () => {
  // If the budget ever meets or exceeds the bound, this whole change stops
  // doing anything: the bridge times out first and the caller is back to an
  // error carrying no information, with every test above still green.
  assert.ok(RELOAD_WAIT_BUDGET_MS > 0, "a non-positive budget disables the bound entirely");
  assert.ok(
    RELOAD_WAIT_BUDGET_MS <= 15000,
    `budget ${RELOAD_WAIT_BUDGET_MS}ms leaves too little headroom under the 20s bridge bound`,
  );
});

test("a superseded highlight is reported as superseded even when the budget also expired", () => {
  // The case that matters, and the one the first version of this change got
  // wrong: BOTH conditions hold. A slow reload outran the budget *and* the grid
  // moved on underneath it.
  //
  // Precedence must be `superseded`, because the two answers ask for different
  // things. `pending` says "these ids are still good, ask again" — and here they
  // are not: they belong to the previous search and cannot match. Answering
  // pending sends the agent back to re-issue ids that are guaranteed to miss,
  // and hides a bail-out path that predates the bound.
  assert.equal(
    classifyHighlightOutcome({ revChanged: true, reloadSettled: false }),
    "superseded",
  );
});

test("each highlight outcome is reachable on its own", () => {
  assert.equal(classifyHighlightOutcome({ revChanged: true, reloadSettled: true }), "superseded");
  assert.equal(classifyHighlightOutcome({ revChanged: false, reloadSettled: false }), "pending");
  assert.equal(classifyHighlightOutcome({ revChanged: false, reloadSettled: true }), "install");
});

test("BOTH drive methods actually go through the bound", async () => {
  // Reachability, not behaviour. Everything above proves the helper works; none
  // of it proves cmcp-civitai-ui.js calls it. Deleting either call site leaves
  // this file entirely green, and the bug comes straight back.
  const src = await readFile(new URL("../../web/js/cmcp-civitai-ui.js", import.meta.url), "utf8");

  const bounded = src.match(/awaitReloadWithin\(state\.activeReloadPromise, RELOAD_WAIT_BUDGET_MS\)/g);
  assert.equal(bounded?.length, 2, "expected driveGetResults AND driveHighlight to use the bound");

  // The original unbounded await must be gone. A call site that kept it would
  // satisfy the count above and still hand the deadline to CivitAI.
  assert.equal(
    /await state\.activeReloadPromise/.test(src),
    false,
    "an unbounded `await state.activeReloadPromise` is still present",
  );
});

test("a reload that wins the race clears the armed timer", async () => {
  // The panel is long-lived and these two commands are polled. A bound that
  // armed a timer per call and never cleared the ones it did not need would
  // accumulate them for as long as the tab is open.
  //
  // This replaced a test that asserted a late fulfilment could not change an
  // already-returned answer. That one could not fail: a settled promise cannot
  // re-resolve, so it was restating the promise contract. Review caught it.
  const { timers, cleared } = manualTimers();
  assert.equal(await awaitReloadWithin(Promise.resolve("page1"), 12000, timers), true);
  assert.equal(cleared(), true, "the timer armed for the bound was left pending");
});
