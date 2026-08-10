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
