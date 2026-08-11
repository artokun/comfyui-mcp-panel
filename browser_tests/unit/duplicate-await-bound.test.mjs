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
  const ms = SRC.match(/const DUPLICATE_AWAIT_MS = (\d+);/);
  assert.ok(ms, "DUPLICATE_AWAIT_MS not found");
  // Rebuilt with a tiny bound so the timeout path is testable in milliseconds.
  return new Function(`const DUPLICATE_AWAIT_MS = 20; ${fn}; return awaitDuplicateReply;`)();
};

test("#646 a settled original is returned UNCHANGED — the bound never rewrites a real reply", async () => {
  const awaitDuplicateReply = buildHelper();
  const settled = { rid: "orig", ok: true, result: { node_id: 7 } };
  assert.equal(await awaitDuplicateReply(settled, "dup"), settled, "same object, not a copy");
  // And an in-flight one that DOES settle in time still wins the race.
  const soon = new Promise((r) => setTimeout(() => r(settled), 1));
  assert.equal(await awaitDuplicateReply(soon, "dup"), settled);
});

test("#646 an original that never settles yields an HONEST reply instead of silence", async () => {
  const awaitDuplicateReply = buildHelper();
  const never = new Promise(() => {}); // the stranded in-flight entry
  const reply = await awaitDuplicateReply(never, "dup-rid");

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
  await awaitDuplicateReply(never, "dup");
  assert.ok(typeof settledWith === "function", "the original's resolver was captured");
  // Still pending: racing it again with a short timer must time out a second time.
  const again = await awaitDuplicateReply(never, "dup2");
  assert.equal(again.rid, "dup2");
  assert.equal(again.ok, false);
});

test("#646 the handler keeps the statement shape #508 and #694 pin", () => {
  // The seam is the whole design: the bound lives in a helper that returns an ORDINARY reply,
  // so the handler still has one await followed by the existing rid-rewrite and send. An
  // earlier attempt put a still-in-flight BRANCH in that region and failed both guards —
  // correctly, since #508 exists so a superseded early-return cannot precede the reply write.
  assert.match(SRC, /dupReply = await awaitDuplicateReply\(priorRidReply, msg\.rid\);/);
  const at = SRC.indexOf("dupReply = await awaitDuplicateReply");
  const after = SRC.slice(at, at + 700);
  // No branch introduced between the await and the reply write.
  assert.ok(!/DUPLICATE_STILL_IN_FLIGHT/.test(SRC), "no sentinel branch survives");
  assert.match(after, /const outReply = retryOfHit \? \{ \.\.\.dupReply, rid: msg\.rid \} : dupReply;/);
});

test("#646 the bound is longer than a fast reply and shorter than silence", () => {
  const ms = Number(SRC.match(/const DUPLICATE_AWAIT_MS = (\d+);/)[1]);
  // Above the orchestrator's short command timeouts (6s was in the report), so a merely SLOW
  // duplicate still receives the real reply rather than this notice...
  assert.ok(ms > 6000, `bound ${ms}ms must exceed a short command timeout`);
  // ...and at or under the long ones (20s in the report), so a wedged executor produces an
  // error rather than the silence this fixes.
  assert.ok(ms >= 20000 && ms <= 30000, `bound ${ms}ms must land in the wedge-detecting range`);
});
