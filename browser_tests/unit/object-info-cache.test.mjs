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
import { OBJECT_INFO_CACHE_TTL_MS, createObjectInfoCache } from "../../web/js/lib/object-info-cache.js";

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
