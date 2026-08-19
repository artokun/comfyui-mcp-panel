// Unit tests for web/js/lib/refresh-coalesce.js — the node-def refresh coalescer.
// The load-bearing property (#289 P2): a caller-supplied FRESH payload must NEVER be
// dropped by joining an OLDER in-flight refresh.
import test from "node:test";
import assert from "node:assert/strict";

import { makeRefreshCoalescer, REFRESH_JOIN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
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

// ── #1351: joinMs bounds the invocation, not just the join ───────────────────
//
// #1192 capped the wait on a run someone else started. The residual is the run THIS
// caller starts AFTER that join lands: `joinMs` used to ignore it, so a join that
// succeeded near its bound still paid a full own run (~13 s of waiting + unbounded
// local work) and missed the 30 s relay window with every per-step bound green.
// Measured at 8.0× (2,251 ms against a 280 ms bound) during the #1342/#1349 gate.

test("#1351: a join that lands still bounds the run that follows it", async () => {
  const joinGate = deferred();
  const ownGate = deferred();
  const { coalescer, registered } = makeHarness(async (defs) => {
    if (defs == null) await joinGate.promise;
    else await ownGate.promise; // this caller's own run never lands on its own
  });

  const older = coalescer();
  const NEW_DEFS = { NewNode: {} };
  const started = Date.now();
  const withPayload = coalescer(NEW_DEFS, { joinMs: 80 });
  // The join SUCCEEDS — the residual is not an abandoned join. The own run is what
  // used to be waited out unbounded.
  joinGate.resolve();
  await older;

  const outcome = await withPayload;
  assert.equal(outcome, REFRESH_JOIN_ABANDONED, "the caller stopped waiting on its own run");
  assert.ok(
    Date.now() - started < 500,
    "…at what joinMs had left, not when the own run eventually settles",
  );
  // The join settled, so starting the run is not a stampede. The payload is in the
  // slot and will register; only this caller's wait ended.
  assert.ok(registered.includes(NEW_DEFS), "the own run started after the join settled");

  ownGate.resolve();
});

test("#1351: with nothing in flight, joinMs still bounds THIS run", async () => {
  // The 8.0× measurement: no meaningful join, a 280 ms bound, a 2,251 ms own run.
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async () => {
    await gate.promise;
  });

  const NEW_DEFS = { NewNode: {} };
  const started = Date.now();
  const outcome = await coalescer(NEW_DEFS, { joinMs: 40 });

  assert.equal(outcome, REFRESH_JOIN_ABANDONED, "a bound with no join to spend still expires");
  assert.ok(Date.now() - started < 400, "…at the bound, not when the run eventually settles");
  assert.ok(registered.includes(NEW_DEFS), "the run was started; only the wait ended");

  gate.resolve();
});

test("#1351: an own run that lands INSIDE the remaining bound still registers (#289 P2 intact)", async () => {
  const gate = deferred();
  const { coalescer, registered } = makeHarness(async (defs) => {
    if (defs == null) await gate.promise;
  });

  const older = coalescer();
  const NEW_DEFS = { NewNode: {} };
  const withPayload = coalescer(NEW_DEFS, { joinMs: 5000 });
  gate.resolve();
  await older;
  const outcome = await withPayload;

  assert.notEqual(outcome, REFRESH_JOIN_ABANDONED, "a healthy own run is not abandoned");
  assert.ok(registered.includes(NEW_DEFS), "the fresh payload was registered, bound or no bound");
});

test("#1351: abandoning the wait on an own run does not cancel it", async () => {
  // withTimeout does not cancel. The run keeps occupying the slot and registering, so a
  // retry joins work already in flight rather than starting a competing pass.
  const ownGate = deferred();
  const { coalescer, registered, getInFlight } = makeHarness(async (defs) => {
    if (defs != null) await ownGate.promise;
  });

  const NEW_DEFS = { NewNode: {} };
  assert.equal(await coalescer(NEW_DEFS, { joinMs: 40 }), REFRESH_JOIN_ABANDONED);
  assert.ok(getInFlight(), "the own run is still in the slot after this caller gave up");

  ownGate.resolve();
  await getInFlight();
  assert.ok(registered.includes(NEW_DEFS), "…and it still registered the payload");
});

test("#1351: a forced run with nothing in flight is bounded too", async () => {
  const gate = deferred();
  const { coalescer } = makeHarness(async () => {
    await gate.promise;
  });

  const started = Date.now();
  assert.equal(
    await coalescer(undefined, { force: true, joinMs: 40 }),
    REFRESH_JOIN_ABANDONED,
  );
  assert.ok(Date.now() - started < 400, "force:true is not a way around the bound");
  gate.resolve();
});
