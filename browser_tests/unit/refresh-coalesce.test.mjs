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
