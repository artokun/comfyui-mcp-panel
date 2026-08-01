// Unit tests for web/js/lib/refresh-coalesce.js — the node-def refresh coalescer.
// The load-bearing property (#289 P2): a caller-supplied FRESH payload must NEVER be
// dropped by joining an OLDER in-flight refresh.
import test from "node:test";
import assert from "node:assert/strict";

import { makeRefreshCoalescer } from "../../web/js/lib/refresh-coalesce.js";

// A tiny deferred so a test can hold a refresh "in flight" until it chooses.
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// Build a coalescer over a module-like single slot, recording every payload that
// runRegister actually registered.
function makeHarness(runImpl) {
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
