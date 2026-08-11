/**
 * #646 — a duplicate delivery must not wait forever on an executor that never settles.
 *
 * The newest report in that thread is the first ABOVE the previous fix line (panel 0.11.78
 * vs 0.11.42 for #677), and its shape is commands TIMING OUT WITH NO REPLY — which is a
 * different failure from commands being refused.
 *
 * The mechanism: the rid ledger records a command IN-FLIGHT at `begin()` and completes it at
 * `settleRid()`. In-flight entries are never evicted, deliberately — dropping an unsettled
 * command would let its replay double-apply a mutation. So an executor that never returns
 * leaves a redelivery awaiting a promise that can never resolve, and the panel sends nothing.
 *
 * What is bounded is the DUPLICATE's wait. The original entry is never settled by this:
 * answering "failed" for a command that may still be running is how a caller retries into the
 * double-apply the ledger exists to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

/** Brace-balanced, anchored past the parameter list — see the note in
 *  active-workflow-provenance.test.mjs about the naive `indexOf("{")` form. */
function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = src.indexOf(") {", start) + 2;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const buildHelper = () => {
  const fn = namedFunctionSource(SRC, "awaitDuplicateReply");
  assert.ok(fn, "awaitDuplicateReply not found");
  const margin = SRC.match(/const DUPLICATE_AWAIT_MARGIN_MS = (\d+);/);
  assert.ok(margin, "DUPLICATE_AWAIT_MARGIN_MS not found");
  // Rebuilt with a tiny margin so a millisecond-scale caller deadline still leaves a budget.
  return new Function(`const DUPLICATE_AWAIT_MARGIN_MS = 5; ${fn}; return awaitDuplicateReply;`)();
};

test("#646 a settled original is returned UNCHANGED — the bound never rewrites a real reply", async () => {
  const awaitDuplicateReply = buildHelper();
  const settled = { rid: "orig", ok: true, result: { node_id: 7 } };
  assert.equal(await awaitDuplicateReply(settled, "dup", 50), settled, "same object, not a copy");
  // And an in-flight one that DOES settle in time still wins the race.
  const soon = new Promise((r) => setTimeout(() => r(settled), 1));
  assert.equal(await awaitDuplicateReply(soon, "dup", 50), settled);
});

test("#646 an original that never settles yields an HONEST reply instead of silence", async () => {
  const awaitDuplicateReply = buildHelper();
  const never = new Promise(() => {}); // the stranded in-flight entry
  const reply = await awaitDuplicateReply(never, "dup-rid", 25);

  assert.equal(reply.rid, "dup-rid", "correlated to the DUPLICATE's rid, which is what the caller waits on");
  assert.equal(reply.ok, false);
  // The two things the caller must not conclude: that it failed, or that it should retry.
  assert.match(reply.error, /STILL RUNNING/);
  assert.match(reply.error, /DO NOT RETRY/);
  assert.match(reply.error, /nothing was applied twice/);
  // ...and what they can actually do about it.
  assert.match(reply.error, /Read the graph to see whether it took effect/);
  // It must never claim the command failed — it did not, it has not finished.
  assert.ok(!/failed|error occurred/i.test(reply.error.replace(/DO NOT RETRY/, "")));
});

test("#646 the ORIGINAL entry is never settled by the bound", async () => {
  // The property that keeps the double-apply guarantee: the helper races against the promise
  // it was handed and cannot resolve it. If a timeout could settle the ledger entry, a caller
  // told "failed" would retry while the first mutation was still in flight.
  const awaitDuplicateReply = buildHelper();
  let settledWith = null;
  const never = new Promise((resolve) => {
    // Nothing calls this — the point is that the helper does not either.
    settledWith = resolve;
  });
  await awaitDuplicateReply(never, "dup", 25);
  assert.ok(typeof settledWith === "function", "the original's resolver was captured");
  // Still pending: racing it again with a short timer must time out a second time.
  const again = await awaitDuplicateReply(never, "dup2", 25);
  assert.equal(again.rid, "dup2");
  assert.equal(again.ok, false);
});

test("#646 the handler keeps the statement shape #508 and #694 pin", () => {
  // The seam is the whole design: the bound lives in a helper that returns an ORDINARY reply,
  // so the handler still has one await followed by the existing rid-rewrite and send. An
  // earlier attempt put a still-in-flight BRANCH in that region and failed both guards —
  // correctly, since #508 exists so a superseded early-return cannot precede the reply write.
  assert.match(SRC, /dupReply = await awaitDuplicateReply\(priorRidReply, msg\.rid, msg\.timeout_ms\);/);
  const at = SRC.indexOf("dupReply = await awaitDuplicateReply");
  const after = SRC.slice(at, at + 700);
  // No branch introduced between the await and the reply write.
  assert.ok(!/DUPLICATE_STILL_IN_FLIGHT/.test(SRC), "no sentinel branch survives");
  assert.match(after, /const outReply = retryOfHit \? \{ \.\.\.dupReply, rid: msg\.rid \} : dupReply;/);
});

test("#646 NO GUESS: with no deadline in the frame, the await is exactly as unbounded as before", async () => {
  // The defect that killed the first version: a fixed 25s bound could not rescue a caller who
  // gives up at 20s, and a lower one would report "still running" for a merely slow command.
  // The panel cannot see the caller's deadline — the orchestrator computes it
  // (ui-bridge.ts:3632) and does not put it in the frame (:4003) — so absent that field this
  // must change NOTHING rather than guess.
  const awaitDuplicateReply = buildHelper();
  const never = new Promise(() => {});
  const raced = await Promise.race([
    awaitDuplicateReply(never, "dup", undefined).then(() => "answered"),
    new Promise((r) => setTimeout(() => r("still waiting"), 40)),
  ]);
  assert.equal(raced, "still waiting", "no deadline → no bound → today's behaviour");
  for (const bad of [null, 0, -1, NaN, "20000", {}]) {
    const r = await Promise.race([
      awaitDuplicateReply(never, "dup", bad).then(() => "answered"),
      new Promise((res) => setTimeout(() => res("still waiting"), 30)),
    ]);
    assert.equal(r, "still waiting", `unusable deadline ${String(bad)} must not synthesize a bound`);
  }
});

test("#646 the bound is the CALLER's deadline minus a margin, not a number of our own", () => {
  assert.match(SRC, /const DUPLICATE_AWAIT_MARGIN_MS = \d+;/);
  assert.ok(!/DUPLICATE_AWAIT_MS/.test(SRC), "no fixed bound survives");
  assert.match(SRC, /callerTimeoutMs - DUPLICATE_AWAIT_MARGIN_MS/);
  // Reads the frame's field, so it activates the moment the orchestrator sends it.
  assert.match(SRC, /msg\.timeout_ms/);
});

test("#646 (codex) a deadline AT OR BELOW the margin is still bounded", async () => {
  // The gap this closes: a 1000ms timeout is neither absent nor invalid, so falling through
  // to unbounded would leave the caller with silence exactly where they give up soonest.
  // Below the margin the budget is half the deadline, which still lands before it.
  const awaitDuplicateReply = buildHelper(); // margin 5ms in the rebuilt copy
  const never = new Promise(() => {});
  for (const deadline of [4, 5, 2]) {
    const reply = await Promise.race([
      awaitDuplicateReply(never, "dup", deadline),
      new Promise((r) => setTimeout(() => r("still waiting"), 60)),
    ]);
    assert.notEqual(reply, "still waiting", `deadline ${deadline}ms must still produce a reply`);
    assert.equal(reply.ok, false);
    assert.equal(reply.rid, "dup");
  }
});

test("#646 (codex) the ask_user claim is scoped to whose contract it is", () => {
  // The comment used to assert that ask_user/request_secret "carry long or absent deadlines".
  // Nothing in this file establishes that — there is no command-specific guard here — so it
  // now names the orchestrator as the party that holds that contract.
  assert.match(SRC, /That is the\s*\r?\n?\s*\/\/ ORCHESTRATOR's contract, not something this file enforces or can verify/);
});
