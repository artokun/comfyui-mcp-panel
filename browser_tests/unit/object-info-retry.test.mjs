// #954 — a transient /object_info failure must not be reported as a refusal.
//
// Reported: right after a restart-related operation, `panel_refresh_nodes` returned
// `{refreshed:false, reason:"object_info_fetch_failed", detail:"Failed to fetch"}` while
// `list_local_models` succeeded moments later against the same server. One attempt into a
// reconnect window produced a permanent-sounding verdict, with a remedy telling the user to
// check that the ComfyUI process was still running — a process that was never down.
//
// `sleep` is injected throughout so these run instantly and deterministically. A retry test
// that depends on real timers is a slow test that eventually becomes a flaky one.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OBJECT_INFO_RETRY_DELAYS_MS,
  fetchNodeDefsWithRetry,
  objectInfoLooksTransient,
} from "../../web/js/lib/object-info-retry.js";

const DEFS = { KSampler: {}, CheckpointLoaderSimple: {} };
const noSleep = async () => {};

test("#954: a first-attempt success does not wait at all", () => {
  // The overwhelmingly common case. A retry that costs latency when nothing is wrong is a
  // regression for every caller.
  let slept = 0;
  return fetchNodeDefsWithRetry(async () => DEFS, { sleep: async (ms) => { slept += ms; } }).then((defs) => {
    assert.equal(defs, DEFS);
    assert.equal(slept, 0);
  });
});

test("#954: a transient throw is retried and the later success is returned", async () => {
  // The reported case: the fetch fails inside a reconnect window and works moments later.
  let calls = 0;
  const defs = await fetchNodeDefsWithRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return DEFS;
    },
    { sleep: noSleep },
  );
  assert.equal(defs, DEFS);
  assert.equal(calls, 2, "it must actually re-attempt, not swallow the error");
});

test("#954: a genuine outage still reports the ORIGINAL error", async () => {
  // Retrying must not convert a real failure into a different, vaguer one — the caller
  // words `object_info_fetch_failed` and its `detail` from exactly this error.
  let calls = 0;
  await assert.rejects(
    () =>
      fetchNodeDefsWithRetry(
        async () => {
          calls += 1;
          throw new TypeError("Failed to fetch");
        },
        { sleep: noSleep },
      ),
    /Failed to fetch/,
  );
  assert.equal(calls, OBJECT_INFO_RETRY_DELAYS_MS.length + 1, "bounded: every attempt, then stop");
});

test("#954: the LAST error wins, not the first", async () => {
  // A backend coming up can fail differently on the way — the caller should see the state
  // it ended in, which is the one its remedy has to address.
  const errs = ["Failed to fetch", "503 Service Unavailable", "connection reset"];
  let i = 0;
  await assert.rejects(
    () => fetchNodeDefsWithRetry(async () => { throw new Error(errs[i++]); }, { sleep: noSleep }),
    /connection reset/,
  );
});

test("#954: an empty payload is a failure, not 'the server has no nodes'", async () => {
  // ComfyUI always defines nodes; an empty map means the response was not the one asked
  // for. Treating it as success would register a definition set that omits everything.
  assert.equal(objectInfoLooksTransient({}), true);
  assert.equal(objectInfoLooksTransient(null), true);
  assert.equal(objectInfoLooksTransient("nope"), true);
  assert.equal(objectInfoLooksTransient(DEFS), false);

  let calls = 0;
  const defs = await fetchNodeDefsWithRetry(
    async () => {
      calls += 1;
      return calls < 3 ? {} : DEFS;
    },
    { sleep: noSleep },
  );
  assert.equal(defs, DEFS);
  assert.equal(calls, 3);
});

test("#954: exhausting on EMPTY returns the payload rather than inventing an error", async () => {
  // The caller already classifies an empty result carefully. Throwing here would replace a
  // verdict it words precisely with one it never wrote.
  const out = await fetchNodeDefsWithRetry(async () => ({}), { sleep: noSleep });
  assert.deepEqual(out, {});
});

test("#954: the wait is bounded and ordered", async () => {
  // Bounded because this blocks a tool call: long enough to cross a reconnect blip, short
  // enough that a dead backend answers quickly with the honest failure.
  const slept = [];
  await assert.rejects(
    () => fetchNodeDefsWithRetry(async () => { throw new Error("x"); }, { sleep: async (ms) => slept.push(ms) }),
    /x/,
  );
  assert.deepEqual(slept, OBJECT_INFO_RETRY_DELAYS_MS);
  // Bounds the SLEEPING, not the tool call: the three requests themselves are unbounded
  // (codex). What this guarantees is that a blip costs under a second of waiting.
  assert.ok(slept.reduce((a, b) => a + b, 0) <= 1000, "total backoff must stay under a second");
  assert.deepEqual([...slept].sort((a, b) => a - b), slept, "backoff, not a fixed interval");
});

// ---------------------------------------------------------------------------
// #1180 — `shouldRetry`, and why this schedule needed one.
//
// #954 sized [200, 600] on attempts that fail INSTANTLY: a connection refused while the
// backend restarts costs nothing, so three attempts spread over 800ms only widen the
// window a blip can hide in. #1180 then introduced a failure that is NOT free — an attempt
// abandoned by a timeout, which `withTimeout` does not cancel, so it keeps downloading the
// whole document while the next attempt races it on the same link.
//
// The first attempt at reconciling those cut the schedule to a single 200ms delay for
// everyone, which protected the expensive case by taking 600ms off the cheap one — the
// exact window #954 was filed about. The decision belongs to the caller, per failure, and
// these tests hold the module to honouring it.

test("#1180: a failure the caller declines to retry stops the loop AT ONCE", async () => {
  let calls = 0;
  // COUNT the sleeps, do not sum their durations. Summing passed a mutation that slept
  // `wait(0)` before giving up — zero milliseconds, but still a turn spent waiting on an
  // attempt whose download is what the caller just declined to race.
  let sleeps = 0;
  await assert.rejects(
    () =>
      fetchNodeDefsWithRetry(
        async () => {
          calls += 1;
          throw new Error("did not answer");
        },
        { sleep: async () => { sleeps += 1; }, shouldRetry: () => false },
      ),
    /did not answer/,
    "the caller's own error must survive, not be replaced by a retry-shaped one",
  );
  assert.equal(calls, 1, "an un-retryable failure must not be attempted again");
  assert.equal(sleeps, 0, "…and must not SLEEP first: the abandoned work is still running");
});

test("#1180: declining applies per failure, not to the whole call", async () => {
  // The real predicate reads a flag the caller sets per attempt, so a run can retry a
  // cheap failure and then stop on an expensive one. A module that evaluated `shouldRetry`
  // once, or ignored it after the first true, would pass a cruder test than this.
  const outcomes = ["cheap", "expensive"];
  let calls = 0;
  let last = "";
  await assert.rejects(
    () =>
      fetchNodeDefsWithRetry(
        async () => {
          last = outcomes[calls] ?? "expensive";
          calls += 1;
          throw new Error(last);
        },
        { sleep: async () => {}, shouldRetry: () => last === "cheap" },
      ),
    /expensive/,
  );
  assert.equal(calls, 2, "it retried the cheap failure and stopped on the expensive one");
});

test("#1180: with no predicate, #954's behaviour is exactly unchanged", async () => {
  // The default must not quietly become 'stop on first failure' for callers that never
  // asked — #954's whole point is that one attempt is not a verdict.
  let calls = 0;
  const defs = await fetchNodeDefsWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("blip");
      return { SomeNode: {} };
    },
    { sleep: async () => {} },
  );
  assert.deepEqual(defs, { SomeNode: {} });
  assert.equal(calls, 3, "all three attempts remain available when the caller says nothing");
});
