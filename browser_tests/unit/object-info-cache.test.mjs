// #716 — one /object_info fetch per BURST of widget writes, not one per write.
//
// Reported: 29 `panel_set_widget` calls meant 29 full `/object_info` downloads. Measured
// elsewhere in this repo on a 63-pack install (#767): 5,413,770 bytes / 167 ms each. That
// is ~157MB of redundant transfer to edit text fields on nodes that did not change.
//
// `now` is injected throughout, so these are deterministic. A cache test that waits on a
// real clock is a slow test that eventually becomes a flaky one.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OBJECT_INFO_CACHE_TTL_MS,
  // #1161 — the timeout arm returns the outcome WRAPPER so the refusal can state its
  // cause; the tests assert that shape rather than a bare null.
  CACHE_OUTCOME,
  createObjectInfoCache,
} from "../../web/js/lib/object-info-cache.js";

const DEFS = { KSampler: {}, CLIPTextEncode: {} };
const clock = (start = 1000) => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
};

test("#716: a burst of reads costs ONE fetch", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let fetches = 0;
  const fetchDefs = async () => {
    fetches += 1;
    return DEFS;
  };
  for (let i = 0; i < 29; i++) assert.equal(await cache.read(fetchDefs), DEFS);
  assert.equal(fetches, 1, "29 widget writes, one download — the whole point of the issue");
});

test("#716: concurrent misses coalesce onto one request", async () => {
  // Without this, a burst arriving faster than the fetch completes still issues one
  // request per caller — the reported symptom, merely moved.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let fetches = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const fetchDefs = async () => {
    fetches += 1;
    await gate;
    return DEFS;
  };
  const all = Promise.all([cache.read(fetchDefs), cache.read(fetchDefs), cache.read(fetchDefs)]);
  release();
  assert.deepEqual(await all, [DEFS, DEFS, DEFS]);
  assert.equal(fetches, 1);
});

test("#716: the entry expires, so a write is never authorized against an ancient map", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let fetches = 0;
  const fetchDefs = async () => {
    fetches += 1;
    return DEFS;
  };
  await cache.read(fetchDefs);
  c.advance(OBJECT_INFO_CACHE_TTL_MS - 1);
  await cache.read(fetchDefs);
  assert.equal(fetches, 1, "still inside the window");
  c.advance(2);
  await cache.read(fetchDefs);
  assert.equal(fetches, 2, "past the window it re-fetches");
});

test("#716: invalidate() drops it immediately", async () => {
  // This is what makes a TTL safe to have. A refresh/install/reconnect KNOWS the schema
  // may have moved; expiring only on time would serve a stale map right after the one
  // event most likely to have changed it.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let fetches = 0;
  const fetchDefs = async () => {
    fetches += 1;
    return DEFS;
  };
  await cache.read(fetchDefs);
  cache.invalidate();
  await cache.read(fetchDefs);
  assert.equal(fetches, 2);
  assert.equal(cache.peek().cached, true);
});

test("#716: a failed or empty fetch is NOT cached", async () => {
  // Caching a null/empty would pin the fence's fail-closed state for the whole TTL,
  // turning one transient failure into a second and a half of refused writes.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let fetches = 0;
  const results = [null, {}, DEFS];
  const fetchDefs = async () => results[fetches++];
  assert.equal(await cache.read(fetchDefs), null);
  assert.equal(cache.peek().cached, false);
  assert.deepEqual(await cache.read(fetchDefs), {});
  assert.equal(cache.peek().cached, false);
  assert.equal(await cache.read(fetchDefs), DEFS);
  assert.equal(cache.peek().cached, true);
  assert.equal(fetches, 3, "each failure re-fetched rather than being remembered");
});

test("#716: a throwing fetch propagates and leaves nothing cached", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  await assert.rejects(() => cache.read(async () => { throw new Error("Failed to fetch"); }), /Failed to fetch/);
  assert.equal(cache.peek().cached, false, "the fence must keep failing closed, not read a ghost");
  // …and the in-flight slot must be released, or every later read hangs on a dead promise.
  assert.equal(await cache.read(async () => DEFS), DEFS);
});

test("#716: the window is short enough to be about a burst, not about a session", async () => {
  // Long enough to cover an agent's run of edits, far too short to span a user installing
  // a pack and then editing widgets.
  assert.ok(OBJECT_INFO_CACHE_TTL_MS >= 500, "too short and a burst still re-downloads");
  assert.ok(OBJECT_INFO_CACHE_TTL_MS <= 5000, "too long and the payload stops being 'fresh' in any useful sense");
});

test("#716: an invalidation retires an ALREADY-RUNNING fetch", async () => {
  // codex: clearing only the stored value left an in-flight request able to repopulate it
  // afterwards. A refresh could register new definitions while an older response quietly
  // restored the pre-change map for another full TTL — the fence then authorizing against
  // a schema that had already been replaced.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = cache.read(async () => {
    await gate;
    return { OldType: {} };
  });
  cache.invalidate();
  release();
  assert.deepEqual(await slow, { OldType: {} }, "whoever awaited it still gets their answer");
  assert.equal(cache.peek().cached, false, "but it must NOT have repopulated the cache");
});

test("#716: a read after invalidation does not JOIN the retired request", async () => {
  // The other half of the same hole: joining a pre-invalidation request hands the caller
  // the very map the invalidation existed to discard.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let release;
  const gate = new Promise((r) => (release = r));
  const stale = cache.read(async () => {
    await gate;
    return { OldType: {} };
  });
  cache.invalidate();
  const fresh = await cache.read(async () => ({ NewType: {} }));
  assert.deepEqual(fresh, { NewType: {} }, "the new read must issue its own request");
  release();
  await stale;
  assert.deepEqual(cache.peek().cached, true);
  // And the retired request must not have overwritten the fresh entry on its way out.
  assert.deepEqual(await cache.read(async () => ({ ShouldNotBeCalled: {} })), { NewType: {} });
});

test("#716: every joined caller sees a failing fetch fail", async () => {
  // codex noted this was untested. A coalesced failure that resolved for some callers and
  // rejected for others would be a fence that authorizes for one write and refuses another
  // from the same request.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let release;
  const gate = new Promise((r) => (release = r));
  const fetchDefs = async () => {
    await gate;
    throw new Error("Failed to fetch");
  };
  const a = cache.read(fetchDefs);
  const b = cache.read(fetchDefs);
  const d = cache.read(fetchDefs);
  release();
  for (const p of [a, b, d]) await assert.rejects(() => p, /Failed to fetch/);
  assert.equal(cache.peek().cached, false);
});

test("#716: the shared payload cannot have type keys added or removed", async () => {
  // Shared identity is new (codex): writes used to each get their own object. A consumer
  // that mutated the map would contaminate every later authorization, and the dangerous
  // direction is adding a key — authorizing a type nobody installed.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  const defs = await cache.read(async () => ({ KSampler: {} }));
  assert.throws(() => {
    "use strict";
    defs.ForgedType = {};
  }, TypeError);
  assert.throws(() => {
    "use strict";
    delete defs.KSampler;
  }, TypeError);
  assert.deepEqual(Object.keys(defs), ["KSampler"]);
});

test("#716: a SYNCHRONOUSLY throwing fetch reports its own error and unblocks the cache", async () => {
  // codex: the finally referenced the promise binding it was being assigned to, so a
  // synchronous throw raised a temporal-dead-zone ReferenceError that REPLACED the real
  // error. Worse than the wrong message: the rejected promise was attached to the slot
  // afterwards, so every later read in the same generation joined a request that could only
  // ever reject.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  await assert.rejects(
    () =>
      cache.read(() => {
        throw new TypeError("synchronous boom");
      }),
    /synchronous boom/,
    "the caller must see its own error, not a ReferenceError about internals",
  );
  assert.equal(cache.peek().cached, false);
  // The slot must be free: a later read issues its own request and succeeds.
  assert.equal(await cache.read(async () => DEFS), DEFS);
  assert.equal(cache.peek().cached, true);
});

test("#716: a retired request cannot overwrite a newer value — deterministically", async () => {
  // codex asked for this as an explicit schedule rather than relying on a hanging test:
  // old request starts, invalidate, new request starts and succeeds, THEN the old one
  // resolves. The new value must survive.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let releaseOld;
  const oldGate = new Promise((r) => (releaseOld = r));
  const old = cache.read(async () => {
    await oldGate;
    return { OldType: {} };
  });
  cache.invalidate();
  assert.deepEqual(await cache.read(async () => ({ NewType: {} })), { NewType: {} });
  releaseOld();
  assert.deepEqual(await old, { OldType: {} }, "its own caller still gets its answer");
  assert.deepEqual(
    await cache.read(async () => ({ MustNotBeFetched: {} })),
    { NewType: {} },
    "the retired response must not have replaced the newer value",
  );
});


// ── #1161: a fetch that never settles must not park the tool ─────────────────
//
// The only open P1. After a ComfyUI restart the tab can hold a half-open connection, so
// getNodeDefs() never settles. graph_set_widget is the one command that consults
// /object_info before writing, so it alone hung — 30s timeouts on every node while every
// other command answered instantly — and coalescing made it permanent, because every
// later read joined the same dead promise.
//
// These never await a promise that may not settle: a test that detects its bug by hanging
// `node --test` (which has no default timeout) reports a wedged suite instead of naming
// the broken invariant. Every wait here is resolved by firing the injected timer, and the
// clock is injected too, matching the rest of this file.
function boundedCache({ waitMs = 8000, ttlMs = OBJECT_INFO_CACHE_TTL_MS } = {}) {
  const timers = new Set();
  const clock = { t: 1_000_000 };
  const cache = createObjectInfoCache({
    ttlMs,
    waitMs,
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
  });
  return {
    cache,
    clock,
    armed: () => timers.size,
    fireTimers: () => [...timers].forEach((t) => { timers.delete(t); t.fn(); }),
  };
}

const timedOut = (outcome) =>
  outcome && typeof outcome === "object" && outcome[CACHE_OUTCOME] === true && outcome.defs === null;

test("#1161: a fetch that never settles is bounded instead of parking the caller", async () => {
  const { cache, fireTimers } = boundedCache();
  const read = cache.read(() => new Promise(() => {})); // half-open socket
  fireTimers();
  const outcome = await read;
  assert.ok(timedOut(outcome), "the read gives up on THIS call rather than hanging");
  // The refusal must say WHY: a bare null makes the caller's note misdiagnose a hung read
  // as an unreachable backend, naming a route list it never printed.
  assert.match(String(outcome.failures?.[0] ?? ""), /did not answer within 8000ms/);
});

test("#1161: a JOINER is bounded too — the burst case the bug was reported on", async () => {
  // The defect the first attempt shipped: read() returned the in-flight promise BEFORE the
  // bound was installed, so only the issuing call was bounded and every overlapping call
  // parked until the orchestrator's 30s timeout. #716 built this cache for bursts, so that
  // is the case that matters most.
  const { cache, fireTimers, armed } = boundedCache();
  const issuer = cache.read(() => new Promise(() => {}));
  const joinerA = cache.read(() => new Promise(() => {}));
  const joinerB = cache.read(() => new Promise(() => {}));
  assert.equal(armed(), 3, "every caller must arm its own bound, not just the issuer");
  fireTimers();
  for (const [name, p] of [["issuer", issuer], ["joinerA", joinerA], ["joinerB", joinerB]]) {
    assert.ok(timedOut(await p), `${name} must give up rather than park`);
  }
});

test("#1161: the abandoned request is retired, so the next read issues a fresh one", async () => {
  const { cache, fireTimers } = boundedCache();
  let calls = 0;
  const first = cache.read(() => { calls++; return new Promise(() => {}); });
  fireTimers();
  assert.ok(timedOut(await first));
  assert.equal(calls, 1);
  const defs = { KSampler: {} };
  const second = await cache.read(() => { calls++; return Promise.resolve(defs); });
  assert.equal(calls, 2, "the next read must not join the dead request");
  assert.deepEqual(second, defs, "…and it recovers as soon as the backend answers");
});

test("#1161: an abandoned request cannot overwrite a NEWER schema", async () => {
  // The generation must advance when the slot is abandoned. Releasing it alone left the
  // abandoned request still matching `issuedAt === generation`, so a late pre-restart
  // payload could overwrite a newer one and re-stamp its TTL — a write authorized against
  // a pack that was uninstalled during the restart, reported as success (#458).
  const { cache, clock, fireTimers } = boundedCache();
  let releaseStale;
  const stale = new Promise((resolve) => { releaseStale = resolve; });
  const first = cache.read(() => stale);
  fireTimers();
  assert.ok(timedOut(await first));

  const fresh = { KSampler: {} };
  assert.deepEqual(await cache.read(() => Promise.resolve(fresh)), fresh);

  releaseStale({ GoneNode: {}, KSampler: {} }); // the pre-restart map lands late
  await stale;
  await new Promise((r) => setTimeout(r, 0));

  clock.t += 1; // still inside the TTL of the FRESH value
  let refetched = 0;
  const after = await cache.read(() => { refetched++; return Promise.resolve({}); });
  assert.equal(refetched, 0, "the fresh value is still cached");
  assert.deepEqual(after, fresh, "the retired request must not have overwritten it");
});

test("#1161: a payload that lands WHILE we wait is used, not refused", async () => {
  // Refusing here would tell the user to reconnect ComfyUI at the exact moment the panel
  // holds a fresh authoritative schema.
  const { cache, fireTimers } = boundedCache();
  const pending = cache.read(() => new Promise(() => {}));
  cache.invalidate();
  const defs = { KSampler: {} };
  assert.deepEqual(await cache.read(() => Promise.resolve(defs)), defs);
  fireTimers();
  assert.deepEqual(await pending, defs, "the waiting read must use the payload that arrived");
});

test("#1161: a healthy fetch and a rejection are both unaffected by the bound", async () => {
  const { cache } = boundedCache();
  const defs = { KSampler: {} };
  assert.deepEqual(await cache.read(() => Promise.resolve(defs)), defs);
  const other = boundedCache().cache;
  await assert.rejects(other.read(() => Promise.reject(new Error("backend down"))), /backend down/);
});

test("#1161: a throwing timer degrades to no bound, never to a failed read", async () => {
  const defs = { KSampler: {} };
  const cache = createObjectInfoCache({
    waitMs: 8000,
    setTimer: () => { throw new Error("no timers here"); },
    clearTimer: () => {},
  });
  assert.deepEqual(await cache.read(() => Promise.resolve(defs)), defs);
});

test("#1161: the timer is cleared when the fetch wins the race", async () => {
  // Without the cleanup an 8s timer is left armed for every read — invisible in behaviour
  // and exactly the kind of thing no assertion notices.
  const { cache, armed } = boundedCache();
  await cache.read(() => Promise.resolve({ KSampler: {} }));
  assert.equal(armed(), 0, "a settled read must leave no timer armed");
});
