// Unit tests for web/js/lib/refresh-coalesce.js — the node-def refresh coalescer.
// The load-bearing property (#289 P2): a caller-supplied FRESH payload must NEVER be
// dropped by joining an OLDER in-flight refresh.
import test from "node:test";
import assert from "node:assert/strict";

import { makeRefreshCoalescer, REFRESH_JOIN_ABANDONED, REFRESH_RUN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
// #1192 — the REAL bounding primitive, so `opts.joinMs` is exercised rather than stubbed.
import { withTimeout } from "../../web/js/lib/bounded-step.js";

// A tiny deferred so a test can hold a refresh "in flight" until it chooses.
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// Build a coalescer over a module-like single slot, recording every payload that
// runRegister actually registered.
function makeHarness(runImpl, { wireTimeout = true } = {}) {
  let inFlight = null;
  const registered = [];
  const coalescer = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    runRegister: async (defs) => {
      registered.push(defs);
      if (runImpl) await runImpl(defs);
    },
    // #1192 — wired by default, because the panel wires it. `wireTimeout: false` is how the
    // "an unwired coalescer waits unbounded" test drives the omission deliberately.
    ...(wireTimeout ? { withTimeout } : {}),
  });
  return { coalescer, registered, getInFlight: () => inFlight };
}

test("#289 P2: a fresh payload is NOT dropped when an OLDER refresh is in flight", async () => {
  // Gate the first (older, payload-less reconnect) refresh so it stays in flight
  // while the second call arrives with a NEW payload.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async (defs) => {
    if (defs == null) await gate.promise; // the older reconnect refresh blocks here
  });

  const older = coalescer(); // no payload — the reconnect refresh, now in flight
  const NEW_DEFS = { NewNode: { input: { required: {} } } };
  const withPayload = coalescer(NEW_DEFS); // graph_add_node's fresh payload

  // Let the older refresh finish; the payload call must then run its OWN refresh.
  gate.resolve();
  await older;
  await withPayload;

  assert.ok(
    registered.includes(NEW_DEFS),
    "the fresh payload was registered (not dropped by joining the older refresh)",
  );
});

test("a payload-less call while a refresh is in flight simply JOINS it (no extra run)", async () => {
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async () => {
    await gate.promise;
  });

  const first = coalescer(); // in flight
  const second = coalescer(); // no payload ⇒ joins, does not start a new run

  gate.resolve();
  await Promise.all([first, second]);

  assert.equal(registered.length, 1, "only ONE registration ran for two payload-less calls");
});

test("a single call registers its payload and clears the in-flight slot", async () => {
  const { coalescer, registered, getInFlight } = makeHarness();
  const DEFS = { A: {} };
  await coalescer(DEFS);
  assert.deepEqual(registered, [DEFS], "registered the supplied payload");
  assert.equal(getInFlight(), null, "in-flight slot cleared after settle");
});

test("#396 a FORCED payload-less call while a refresh is in flight runs a TRAILING fresh run", async () => {
  // The download-completion case: an unrelated refresh (e.g. reconnect) is in
  // flight when a model finishes; its /object_info fetch predates the new file, so
  // a plain join would miss it. force:true must guarantee a second (trailing) run.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async () => {
    if (registered.length === 1) await gate.promise; // hold ONLY the first run in flight
  });

  const inflight = coalescer(); // unrelated refresh, now in flight (held by gate)
  const forced = coalescer(undefined, { force: true }); // download completion

  gate.resolve();
  await Promise.all([inflight, forced]);

  assert.equal(registered.length, 2, "the forced call ran its OWN trailing refresh, not just a join");
});

test("#396 many FORCED calls during one in-flight run coalesce into ONE trailing run", async () => {
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async () => {
    if (registered.length === 1) await gate.promise;
  });

  const inflight = coalescer(); // held in flight
  const f1 = coalescer(undefined, { force: true });
  const f2 = coalescer(undefined, { force: true });
  const f3 = coalescer(undefined, { force: true });

  gate.resolve();
  await Promise.all([inflight, f1, f2, f3]);

  assert.equal(registered.length, 2, "three forced calls collapsed to a single trailing run");
});

test("#396 a FORCED call with NO refresh in flight runs immediately (leading edge)", async () => {
  const { coalescer, registered, getInFlight } = makeHarness();
  await coalescer(undefined, { force: true });
  assert.equal(registered.length, 1, "forced call ran once");
  assert.equal(getInFlight(), null, "in-flight slot cleared after settle");
});

test("a payload call still runs even if the in-flight refresh REJECTS", async () => {
  const gate = deferred();
  let first = true;
  const { coalescer, registered } = makeHarness(async () => {
    if (first) {
      first = false;
      await gate.promise;
      throw new Error("older refresh failed");
    }
  });

  const older = coalescer(); // will reject
  const NEW_DEFS = { NewNode: {} };
  const withPayload = coalescer(NEW_DEFS);

  gate.resolve();
  await older.catch(() => {});
  await withPayload;

  assert.ok(registered.includes(NEW_DEFS), "the payload was registered despite the older refresh failing");
});

// #608: panel_refresh_nodes' frontend executor (refresh_nodes) awaits a FORCED
// no-payload refresh and reports its freshness verdict back to the tool. The
// executor is `refreshComfyNodeDefs(undefined, { force:true })` -> `{ refreshed:
// !!verdict }`, so the coalescer MUST resolve a forced refresh to runRegister's
// OWN return value (registerComfyNodeDefs returns true only when it authoritatively
// fetched /object_info AND refreshed combos). If the coalescer swallowed that
// value, panel_refresh_nodes would always report refreshed:false and an agent
// couldn't tell a real refresh from a no-op after upload_image action:"stage".
test("#608: a forced (no-payload) refresh resolves to runRegister's freshness verdict", async () => {
  let verdict = true;
  const { coalescer } = makeHarnessReturning(() => verdict);

  assert.equal(await coalescer(undefined, { force: true }), true, "forced refresh forwards a true verdict");

  verdict = false;
  assert.equal(await coalescer(undefined, { force: true }), false, "forced refresh forwards a false verdict");
});

test("#608: a forced refresh queued BEHIND an in-flight run resolves to the trailing run's verdict", async () => {
  const gate = deferred();
  let verdict = false;
  const { coalescer } = makeHarnessReturning(async (defs) => {
    if (defs == null) {
      // First (in-flight) run blocks; its stale verdict must NOT be what the
      // trailing forced call reports.
      await gate.promise;
    }
    return verdict;
  });

  const inflight = coalescer(); // holds the slot
  const forced = coalescer(undefined, { force: true }); // must run its OWN trailing pass
  verdict = true; // the authoritative post-change fetch now sees the new asset
  gate.resolve();

  await inflight;
  assert.equal(await forced, true, "the trailing forced refresh reports its own fresh verdict, not the stale join");
});

// Harness variant whose runRegister RETURNS a value (the freshness verdict), so a
// test can assert what a caller (refresh_nodes) receives from the coalescer.
function makeHarnessReturning(verdictImpl) {
  let inFlight = null;
  const coalescer = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    runRegister: async (defs) => {
      const v = verdictImpl(defs);
      return v && typeof v.then === "function" ? await v : v;
    },
    withTimeout,
  });
  return { coalescer };
}

// ── #1192: a caller may bound its own WAIT, and only that ────────────────────
//
// Every branch above begins with `await current` — a wait on a run that ALREADY STARTED
// under someone else's deadline. `graph_add_node` meets that wait on the scenario it is
// most likely to fail on (a ComfyUI restart, when a reconnect refresh is already running),
// and a full run costs ~9s of bounded waiting plus ~4s of deliberately-unbounded local
// work. Unbounded, that single term consumes most of the add's 25s command budget before
// its own registration has begun, and the reply misses the 30s relay window entirely — so
// the user gets `did not reply to "graph_add_node"`, which names nothing, instead of the
// worded refusal every bound on that path exists to produce.

test("#1192: a payload join that outlives joinMs is ABANDONED, not waited out", async () => {
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async (defs) => {
    if (defs == null) await gate.promise; // the in-flight reconnect refresh never lands
  });

  const older = coalescer(); // holds the slot, gated open
  const NEW_DEFS = { NewNode: {} };
  const started = Date.now();
  const outcome = await coalescer(NEW_DEFS, { joinMs: 25 });

  assert.equal(outcome, REFRESH_JOIN_ABANDONED, "the caller stopped waiting and said so");
  assert.ok(Date.now() - started < 1000, "…at the bound, not when the in-flight run eventually settles");
  // The load-bearing half: it must NOT have started a competing run. Two concurrent
  // registerNodesFromDefs passes are the stampede this coordinator exists to prevent, and a
  // caller that has just given up waiting for one is the last thing that should launch a
  // second.
  assert.deepEqual(registered, [undefined], "no second run was started alongside the one still going");

  gate.resolve();
  await older;
});

test("#1192: a join that lands INSIDE joinMs still registers the fresh payload (#289 P2 intact)", async () => {
  // The bound must not become a way to drop payloads on a healthy machine. This is the case
  // the reported scenario actually hits most of the time — the in-flight run finishes, and
  // the add's own registration goes ahead exactly as before the bound existed.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async (defs) => {
    if (defs == null) await gate.promise;
  });

  const older = coalescer();
  const NEW_DEFS = { NewNode: {} };
  const withPayload = coalescer(NEW_DEFS, { joinMs: 5000 });
  gate.resolve();
  await older;
  await withPayload;

  assert.ok(registered.includes(NEW_DEFS), "the fresh payload was registered, bound or no bound");
});

test("#1192: an in-flight run that REJECTS is a SETTLED join, not an abandoned one", async () => {
  // `withTimeout` degrades a rejection through onTimeout exactly as it does a timeout, so
  // bounding `current` directly would report a run that FAILED as one that never answered —
  // and this coordinator has always treated a failed in-flight run as settled, with the
  // caller then running its own. Reifying before bounding is what keeps that true.
  const gate = deferred();
  let first = true;
  const { coalescer, registered } = makeHarness(async () => {
    if (first) {
      first = false;
      await gate.promise;
      throw new Error("older refresh failed");
    }
  });

  const older = coalescer();
  const NEW_DEFS = { NewNode: {} };
  const withPayload = coalescer(NEW_DEFS, { joinMs: 5000 });
  gate.resolve();
  await older.catch(() => {});
  const outcome = await withPayload;

  assert.notEqual(outcome, REFRESH_JOIN_ABANDONED, "a rejection is an ANSWER, not a stall");
  assert.ok(registered.includes(NEW_DEFS), "…so the payload still ran, as it always has");
});

test("#1192: a joinMs of 0 or less abandons IMMEDIATELY — it never means 'no bound'", async () => {
  // `withTimeout` reads a non-positive ms as NO BOUND. A budget expressed literally at the
  // moment it ran out would therefore restore the unbounded wait — the hang arriving through
  // the mechanism meant to prevent it. #1188 recorded this trap; it is checked here because
  // graph_add_node computes joinMs by SUBTRACTION and can legitimately reach a negative.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async (defs) => {
    if (defs == null) await gate.promise; // never settles
  });

  const older = coalescer();
  for (const joinMs of [0, -1, -7500]) {
    assert.equal(
      await coalescer({ NewNode: {} }, { joinMs }),
      REFRESH_JOIN_ABANDONED,
      `joinMs=${joinMs} must abandon at once, not wait forever`,
    );
  }
  assert.deepEqual(registered, [undefined], "…and must not start a run either");

  gate.resolve();
  await older;
});

test("#1192: a coalescer with NO withTimeout wired waits unbounded, exactly as it always did", async () => {
  // The safe direction for a wiring mistake to fail in: a panel that forgot to inject the
  // primitive keeps today's behaviour instead of abandoning every join at once, which would
  // break every add. Safe is not the same as noticed — the panel's CALL SITE is pinned
  // separately in single-node-def.test.mjs, because this degradation is silent.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(
    async (defs) => {
      if (defs == null) await gate.promise;
    },
    { wireTimeout: false },
  );

  const older = coalescer();
  const NEW_DEFS = { NewNode: {} };
  const withPayload = coalescer(NEW_DEFS, { joinMs: 10 });

  // Give the bound every chance to fire if it were armed.
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(registered, [undefined], "still waiting on the in-flight run — no bound was applied");

  gate.resolve();
  await older;
  assert.notEqual(await withPayload, REFRESH_JOIN_ABANDONED, "an unwired join is a plain, unbounded join");
  assert.ok(registered.includes(NEW_DEFS));
});

test("#1192: a non-finite joinMs is treated as NO bound, never as an armed one", async () => {
  // A caller computing joinMs from an unset budget can produce Infinity or NaN, and both
  // reach `withTimeout` as "no bound" anyway. Rejecting them at the door keeps that
  // accidental behaviour from being load-bearing.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async (defs) => {
    if (defs == null) await gate.promise;
  });

  const older = coalescer();
  const pending = [
    coalescer({ A: {} }, { joinMs: Number.POSITIVE_INFINITY }),
    coalescer({ B: {} }, { joinMs: Number.NaN }),
  ];
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(registered, [undefined], "both are still waiting on the in-flight run");

  gate.resolve();
  await older;
  for (const p of pending) assert.notEqual(await p, REFRESH_JOIN_ABANDONED);
});

test("#1192: a plain (payload-less) join can be bounded too, and reports it", async () => {
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async () => {
    await gate.promise;
  });

  const older = coalescer();
  assert.equal(await coalescer(undefined, { joinMs: 25 }), REFRESH_JOIN_ABANDONED);
  assert.equal(registered.length, 1, "a bounded plain join still starts nothing of its own");

  gate.resolve();
  await older;
});

test("#1192: a bounded FORCED caller stops waiting but does not cancel #396's trailing run", async () => {
  // The trailing run is a guarantee made to every forced caller, not to this one. A caller
  // that gives up must not take it away from the others — so the run stays queued and still
  // executes, and only this caller's wait ends.
  const gate = deferred();
  const registered = [];
  let inFlight = null;
  const coalescer = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    runRegister: async (defs) => {
      registered.push(defs);
      if (registered.length === 1) await gate.promise; // hold ONLY the first run
    },
    withTimeout,
  });

  const held = coalescer(); // in flight, gated
  const patient = coalescer(undefined, { force: true }); // no bound
  assert.equal(await coalescer(undefined, { force: true, joinMs: 25 }), REFRESH_JOIN_ABANDONED);

  gate.resolve();
  await Promise.all([held, patient]);
  assert.equal(registered.length, 2, "the trailing run still ran for the caller that kept waiting");
});

test("#1192: a bounded FORCED join that lands still forwards the trailing run's verdict (#608)", async () => {
  // #608 reads the freshness verdict off a forced refresh. Bounding the WAIT must not turn a
  // real verdict into a fabricated one — only an abandonment is new.
  const gate = deferred();
  let verdict = false;
  const { coalescer } = makeHarnessReturning(async (defs) => {
    if (defs == null) await gate.promise;
    return verdict;
  });

  const inflight = coalescer();
  const forced = coalescer(undefined, { force: true, joinMs: 5000 });
  verdict = true;
  gate.resolve();
  await inflight;
  assert.equal(await forced, true, "the trailing run's own verdict, not a stand-in");
});

// ── #1351: the caller's OWN run is a wait too, and runMs bounds it ──────────
//
// #1192 bounded the JOIN — the wait on a run someone else started. A join that SUCCEEDS is
// where the unbounded term began: the caller's own run then costs the run budget's bounded
// waiting PLUS the deliberately-unbounded registerNodesFromDefs local work, and the two
// summed past the 30,000 ms relay window. `opts.runMs` bounds the wait on the caller's own
// run, measured from the CALL so the join's cost is subtracted from it rather than added.

test("#1351: an own run that outlives runMs is ABANDONED — but the run is NOT dropped", async () => {
  // The shape the issue measured: the join succeeded, the caller's own run is the slow one.
  // The caller must stop waiting AND the payload must still be registered — the slot is
  // free once the join settles, so starting the run stampedes nothing, and the caller's
  // retry is meant to find the class registered.
  const { coalescer, registered, getInFlight } = makeHarness(
    () => new Promise((r) => setTimeout(r, 200)), // the caller's own run is slow
  );
  const NEW_DEFS = { NewNode: {} };
  const started = Date.now();

  const outcome = await coalescer(NEW_DEFS, { runMs: 25 });

  assert.equal(outcome, REFRESH_RUN_ABANDONED, "the caller stopped waiting and said so");
  assert.ok(Date.now() - started < 1000, "…at the bound, not when the run eventually finishes");
  assert.ok(getInFlight(), "the run is STILL IN THE SLOT — the payload was not dropped");

  // The run completes in the background and registers the payload for the retry.
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(registered, [NEW_DEFS], "the abandoned run still registered the payload");
  assert.equal(getInFlight(), null, "…and cleared the slot when it settled");
});

test("#1351: an own run that lands INSIDE runMs resolves to the run's own value", async () => {
  // The bound must not become a way to lose verdicts on a healthy machine: a run that
  // finishes in time resolves exactly as the unbounded path does.
  const { coalescer } = makeHarnessReturning(() => true);
  const NEW_DEFS = { NewNode: {} };
  assert.equal(await coalescer(NEW_DEFS, { runMs: 5000 }), true, "the run's verdict, not a stand-in");
});

test("#1351: the JOIN's cost is SUBTRACTED from runMs — the two cannot sum to twice it", async () => {
  // The composition the issue is about: joinMs and runMs handed the same remaining budget
  // must not add up. Here the join takes ~60ms of a 100ms runMs, so the caller's own run
  // gets only what is left (~40ms) and is abandoned — a runMs measured from the run's
  // start would have let it wait the full 100ms on top.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async (defs) => {
    if (defs == null) {
      // The in-flight run someone else started: settles after ~60ms.
      await new Promise((r) => setTimeout(r, 60));
      return;
    }
    await gate.promise; // the caller's own run never lands within the test
  });

  const older = coalescer(); // in flight for ~60ms
  const NEW_DEFS = { NewNode: {} };
  const started = Date.now();
  const outcome = await coalescer(NEW_DEFS, { joinMs: 5000, runMs: 100 });

  assert.equal(outcome, REFRESH_RUN_ABANDONED, "the leftover after the join was not enough for the run");
  const waited = Date.now() - started;
  assert.ok(waited < 150, `total wait (${waited}ms) tracked runMs from the CALL, not joinMs + runMs`);
  assert.ok(waited >= 55, "…and the join really did consume most of it first");

  gate.resolve();
  await older;
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(registered.includes(NEW_DEFS), "the payload still registered once the run settled");
});

test("#1351: a runMs of 0 or less starts the run but does not WAIT for it", async () => {
  // graph_add_node computes runMs by subtraction and can legitimately reach a negative.
  // `withTimeout` reads a non-positive ms as NO BOUND, so a spent budget expressed
  // literally would restore the unbounded wait at exactly the moment it ran out — the
  // #1188 trap, arriving through the run this time. The run still STARTS: the slot is
  // free and the payload must not be dropped; only the wait is abandoned.
  const { coalescer, registered } = makeHarness(() => new Promise((r) => setTimeout(r, 50)));

  for (const runMs of [0, -1, -20000]) {
    assert.equal(
      await coalescer({ [`N${runMs}`]: {} }, { runMs }),
      REFRESH_RUN_ABANDONED,
      `runMs=${runMs} must abandon the wait at once, not wait forever`,
    );
    // Let this run settle before the next call, so each iteration meets the LEADING edge
    // rather than joining the previous still-running one.
    await new Promise((r) => setTimeout(r, 80));
  }
  assert.equal(registered.length, 3, "…and every one of those runs still started");
});

test("#1351: an own run that REJECTS inside runMs still rejects for its caller", async () => {
  // A bound on the WAIT must not quietly turn a failed run into a success — only the
  // abandonment is new. The run's rejection has always propagated (`return startRun(...)`
  // did), and it still does.
  const { coalescer } = makeHarness(async () => {
    throw new Error("registerNodesFromDefs blew up");
  });
  await assert.rejects(coalescer({ A: {} }, { runMs: 5000 }), /blew up/);
});

test("#1351: an abandoned own run that LATER rejects does not go unhandled", async () => {
  // The caller has stopped listening by the time this run fails. Without the coalescer's
  // own catch that failure would be an unhandled rejection — which the node test runner
  // turns into a failure of THIS test, so a green run here is the assertion.
  let fail;
  const { coalescer } = makeHarness(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  assert.equal(await coalescer({ A: {} }, { runMs: 25 }), REFRESH_RUN_ABANDONED);
  fail(new Error("the abandoned run failed after the caller left"));
  await new Promise((r) => setTimeout(r, 50));
});

test("#1351: a run that outlives runMs while a JOIN was abandoned never starts (stampede rule intact)", async () => {
  // runMs also caps the JOIN (it bounds the call's TOTAL waiting). When the join is what
  // runs out, the answer is still REFRESH_JOIN_ABANDONED and still NO run is started —
  // the in-flight run holds the slot, and starting a second registerNodesFromDefs next to
  // it is the stampede this coordinator exists to prevent.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async (defs) => {
    if (defs == null) await gate.promise;
  });

  const older = coalescer(); // holds the slot, gated open
  const outcome = await coalescer({ NewNode: {} }, { runMs: 25 }); // no joinMs — runMs alone caps the join

  assert.equal(outcome, REFRESH_JOIN_ABANDONED, "a total bound spent on the join is a join abandonment");
  assert.deepEqual(registered, [undefined], "no competing run was started");

  gate.resolve();
  await older;
});

test("#1351: a coalescer with NO withTimeout wired ignores runMs, exactly as it does joinMs", async () => {
  // The safe direction for a wiring mistake to fail in: an unwired panel keeps today's
  // unbounded wait rather than abandoning every run at once.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(
    async () => {
      await gate.promise;
    },
    { wireTimeout: false },
  );

  const pending = coalescer({ A: {} }, { runMs: 10 });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(registered.length === 1, "the run started…");

  gate.resolve();
  assert.notEqual(await pending, REFRESH_RUN_ABANDONED, "…and the wait was unbounded, as before");
});

test("#1351: a non-finite runMs is treated as NO bound, never as an armed one", async () => {
  // Same guard as joinMs: a caller computing runMs from an unset budget can produce
  // Infinity or NaN, and both must not silently arm (or silently fire) the bound.
  const gate = deferred();
  const { coalescer } = makeHarness(async () => {
    await gate.promise;
  });

  const pending = [
    coalescer({ A: {} }, { runMs: Number.POSITIVE_INFINITY }),
    coalescer({ B: {} }, { runMs: Number.NaN }),
  ];
  await new Promise((r) => setTimeout(r, 40));

  gate.resolve();
  for (const p of pending) assert.notEqual(await p, REFRESH_RUN_ABANDONED);
});

test("#1351: a bounded FORCED caller on the LEADING edge stops waiting for its own run too", async () => {
  // The #1242 drift recovery calls force:true with NO refresh necessarily in flight, so it
  // lands here — the leading edge — where joinMs has nothing to bound. runMs is the bound
  // that reaches it, and the forced run still happens for everyone else.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async () => {
    await gate.promise;
  });

  const started = Date.now();
  const outcome = await coalescer(undefined, { force: true, runMs: 25 });
  assert.equal(outcome, REFRESH_RUN_ABANDONED, "the forced caller's wait on its own run is bounded");
  assert.ok(Date.now() - started < 1000, "…at the bound");
  assert.equal(registered.length, 1, "the forced run still started — only the wait ended");

  gate.resolve();
  await new Promise((r) => setTimeout(r, 20));
});
