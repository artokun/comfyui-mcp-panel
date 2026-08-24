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
import { CACHE_OUTCOME, OBJECT_INFO_CACHE_TTL_MS, createObjectInfoCache } from "../../web/js/lib/object-info-cache.js";
import { fetchWholeObjectInfo } from "../../web/js/lib/object-info-oracle.js";
import { noBackendAnswerEstablished } from "../../web/js/lib/object-info-snapshot.js";

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
  for (let i = 0; i < 29; i++) assert.deepEqual(await cache.read(fetchDefs), DEFS);
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

test("#1709: replace retires old cache entries and late in-flight responses", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  await cache.read(async () => ({ OldType: {} }));
  c.advance(OBJECT_INFO_CACHE_TTL_MS + 1);

  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const stale = cache.read(async () => {
    await gate;
    return { OldType: {} };
  });
  const replacement = {
    NewType: { input: { required: { count: ["INT", { default: 1 }] } } },
  };
  assert.equal(cache.replace(replacement), true, "a definitive non-empty map replaces the old authority");
  replacement.NewType.input.required.count[1].default = 999;
  release();
  await stale;

  let refetched = false;
  const cachedReplacement = await cache.read(async () => {
    refetched = true;
    return { Unexpected: {} };
  });
  assert.equal(cachedReplacement.NewType.input.required.count[1].default, 1, "nested hook mutation is detached");
  assert.equal(Object.isFrozen(cachedReplacement.NewType.input.required.count[1]), true, "nested data is frozen");
  assert.equal(Object.isFrozen(cachedReplacement.NewType.input.required.count), true, "arrays are frozen");
  assert.equal(refetched, false, "the replacement remains the current burst entry");
  assert.equal(cache.replace({}), false, "an empty response is not an authority replacement");
  assert.equal(
    (await cache.read(async () => ({ Unexpected: {} }))).NewType.input.required.count[1].default,
    1,
  );
});

test("#1709: ordinary read deep-detaches nested outcome schemas", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  const source = {
    KSampler: { input: { required: { count: ["INT", { default: 1 }] } } },
  };
  const outcome = {
    [CACHE_OUTCOME]: true,
    defs: source,
    failures: ["fallback unavailable"],
    outcomes: [{ route: "client" }],
  };

  const returned = await cache.read(async () => outcome);
  returned.defs.KSampler.input.required.count[1].default = 999;
  const cached = await cache.read(async () => ({ Unexpected: {} }));

  assert.equal(cached[CACHE_OUTCOME], true, "the cache keeps the outcome wrapper tag");
  assert.deepEqual(cached.failures, ["fallback unavailable"], "diagnostics survive the detached copy");
  assert.equal(cached.defs.KSampler.input.required.count[1].default, 1);
  assert.equal(Object.isFrozen(cached.defs.KSampler.input.required.count[1]), true);
  assert.equal(Object.isFrozen(cached.defs.KSampler.input.required.count), true);
});

test("#1709: readFresh deep-detaches nested schemas and does not cache an empty answer", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  const source = {
    KSampler: { input: { required: { count: ["INT", { default: 1 }] } } },
  };
  const returned = await cache.readFresh(async () => source);
  returned.value.KSampler.input.required.count[1].default = 999;

  let ordinaryFetches = 0;
  const cached = await cache.read(async () => {
    ordinaryFetches += 1;
    return { Unexpected: {} };
  });
  assert.equal(ordinaryFetches, 0, "the fresh non-empty response remains the cache entry");
  assert.equal(cached.KSampler.input.required.count[1].default, 1);
  assert.equal(Object.isFrozen(cached.KSampler.input.required.count[1]), true);
  assert.equal(Object.isFrozen(cached.KSampler.input.required.count), true);

  cache.invalidate();
  assert.equal(
    (await cache.readFresh(async () => null)).value,
    null,
    "an unavailable forced read reaches its caller",
  );
  assert.equal(cache.peek().cached, false, "an unavailable forced read is not cached");
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
  await cache.read(async () => ({ KSampler: {} }));
  const defs = await cache.read(async () => ({ Unexpected: {} }));
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

// ── #1126: this file answers "is this response LIVE", because it is the only thing that ──
// can. Callers used to reconstruct it from whether their loader body had run, and four
// review rounds each found another way that proxy was wrong: a served cache hit, a joined
// read, a reconnect landing mid-flight, and an invalidate() retiring the request. All four
// are decided here, from state this file owns.

const prov = async (cache, fetchDefs, opts) => (await cache.readWithProvenance(fetchDefs, opts)).provenance;

test("#1126: an ISSUED request that nothing retired is live", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  const got = await cache.readWithProvenance(async () => DEFS, { stamp: () => 3 });
  assert.equal(got.value, DEFS);
  assert.equal(got.provenance, "live");
  assert.equal(got.provenanceNow(), "live", "and still live when re-asked, nothing having moved");
});

test("#1126: a verdict EXPIRES — provenanceNow re-answers, it does not replay", async () => {
  // The round-5 defect, and a different species from the four before it. Those asked "what
  // KIND of response is this"; this asks "is that still TRUE". set-widget reads /object_info,
  // then awaits a combo refresh and an upload probe, and only then decides — so a
  // classification computed at delivery can expire mid-ladder while the stored string keeps
  // insisting the answer is live.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let epoch = 1;
  const got = await cache.readWithProvenance(async () => DEFS, { stamp: () => epoch });
  assert.equal(got.provenance, "live", "live at the moment it was delivered");

  // …a refresh/install/download lands while the caller is awaiting something else.
  cache.invalidate();
  assert.equal(got.provenance, "live", "the DELIVERED verdict is a historical fact and does not mutate");
  assert.equal(got.provenanceNow(), "retired", "but asking again tells the truth about now");

  // …and a reconnect is likewise visible only by re-asking.
  const c2 = clock();
  const cache2 = createObjectInfoCache({ now: c2.now });
  let epoch2 = 1;
  const got2 = await cache2.readWithProvenance(async () => DEFS, { stamp: () => epoch2 });
  assert.equal(got2.provenanceNow(), "live");
  epoch2 = 2;
  assert.equal(got2.provenanceNow(), "reconnected");
});

test("#1126: a SERVED or JOINED read cannot become live later either", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  await cache.read(async () => DEFS);
  const served = await cache.readWithProvenance(async () => DEFS, { stamp: () => 1 });
  assert.equal(served.provenance, "cache");
  assert.equal(served.provenanceNow(), "cache", "no later moment turns a TTL hit into the server answering");
});

test("#1126: a SERVED cache hit and a JOINED read are both 'cache' — neither asked the server", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  assert.equal(await prov(cache, async () => DEFS), "live", "the first read issues");
  // Served from the stored payload, still inside the TTL.
  assert.equal(await prov(cache, async () => DEFS), "cache", "the second is served");

  // …and a JOINED read: it never runs its own loader, so it cannot vouch for when the
  // request it is riding on was issued.
  const c2 = clock();
  const cache2 = createObjectInfoCache({ now: c2.now });
  let release;
  const gate = new Promise((r) => (release = r));
  const first = cache2.readWithProvenance(async () => {
    await gate;
    return DEFS;
  });
  const joined = cache2.readWithProvenance(async () => {
    throw new Error("a joined read must never run its own loader");
  });
  release();
  assert.equal((await first).provenance, "live");
  assert.equal((await joined).provenance, "cache", "riding another call's request is not asking");
});

test("#1126: an invalidate() DURING the request retires it — 'retired', not live", async () => {
  // The fourth way, and the one a healthy backend hits most: registerComfyNodeDefs drops
  // this cache on a refresh, a pack install, or a download completing. The generation moves
  // WITHOUT the reconnect epoch moving, so an epoch test alone still calls this live — while
  // the very refresh that retired the response may be what filled the option list.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let release;
  const gate = new Promise((r) => (release = r));
  const pending = cache.readWithProvenance(
    async () => {
      await gate;
      return DEFS;
    },
    { stamp: () => 5 }, // the epoch never moves — only the generation does
  );
  cache.invalidate();
  release();
  const got = await pending;
  assert.equal(got.value, DEFS, "the original waiter still gets its answer, as this file promises");
  assert.equal(got.provenance, "retired", "…but it is not evidence of what the server publishes now");
});

test("#1126: a stamp that MOVES mid-flight is 'reconnected', and outranks a retirement", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let epoch = 1;
  let release;
  const gate = new Promise((r) => (release = r));
  const pending = cache.readWithProvenance(
    async () => {
      await gate;
      return DEFS;
    },
    { stamp: () => epoch },
  );
  epoch = 2;
  // A reconnect typically ALSO drops the cache. The more specific cause is reported, because
  // "the backend process was replaced" and "the panel refreshed the defs" need different advice.
  cache.invalidate();
  release();
  assert.equal((await pending).provenance, "reconnected");
});

test("#1126: a THROWING stamp establishes nothing — 'unknown', never live", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  const got = await cache.readWithProvenance(async () => DEFS, {
    stamp: () => {
      throw new Error("epoch unreadable");
    },
  });
  assert.equal(got.value, DEFS);
  assert.equal(got.provenance, "unknown", "nothing established must not read as the server answering");
});

test("#1126: two concurrent readFresh callers COALESCE and neither retires the other", async () => {
  // The bug this replaces: `invalidate()` + `read()` per caller. Two writes reaching the
  // last-resort path together each invalidated; the second bumped the generation and retired
  // the FIRST one's just-issued request, so a valid write was handed "retired" and refused —
  // one caller breaking another. And nothing coalesced, so a burst meant one multi-megabyte
  // /object_info per caller, which is the symptom #716 exists to prevent.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  await cache.read(async () => ({ Stale: {} })); // something in the store to bypass
  let fetches = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const loader = async () => {
    fetches += 1;
    await gate;
    return DEFS;
  };
  const a = cache.readFresh(loader, { stamp: () => 7 });
  const b = cache.readFresh(loader, { stamp: () => 7 });
  release();
  const [ra, rb] = [await a, await b];
  assert.equal(fetches, 1, "one request for both — the burst does not multiply downloads");
  assert.equal(ra.value, DEFS);
  assert.equal(rb.value, DEFS);
  assert.equal(ra.provenance, "live", "the issuer gets a live answer");
  assert.equal(rb.provenance, "live", "and so does the joiner — it rode a forced read, not the TTL");
});

test("#1126: a JOINER on a reconnect-spanning forced read is NOT live", async () => {
  // The round-6 defect, and the round-5 lesson one level down. `readFresh` reports "live" to
  // a joiner because the request it rides bypassed the TTL — true of the PAYLOAD's age, and
  // irrelevant to the CONNECTION. Capturing the stamp per-caller compared the joiner's own
  // epoch to itself, so a response issued by the PREVIOUS backend process read as live.
  //
  // Reachable in production without any invalidate(): the reconnect-triggered node-def
  // refresh can coalesce with one already running, so the generation never moves. The
  // unreadable-combo fallback would then blind-write an off-list value against a schema
  // published by a backend that no longer exists.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let epoch = 1;
  let release;
  const gate = new Promise((r) => (release = r));
  // Issued on epoch 1.
  const issuer = cache.readFresh(async () => {
    await gate;
    return DEFS;
  }, { stamp: () => epoch });
  // …the backend process is replaced while that request is in flight…
  epoch = 2;
  // …and a second caller arrives, reading the CURRENT epoch as its own.
  const joiner = cache.readFresh(async () => DEFS, { stamp: () => epoch });
  release();
  const [ri, rj] = [await issuer, await joiner];
  assert.equal(ri.provenance, "reconnected", "the issuer sees its own stamp moved");
  assert.equal(
    rj.provenance,
    "reconnected",
    "and so must the joiner — it rode a request ISSUED on the replaced process",
  );
  assert.equal(rj.provenanceNow(), "reconnected", "…and re-asking does not launder it either");
  assert.equal(rj.value, DEFS, "the payload is still delivered; only its authority is denied");
});

test("#1126: a reconnect-spanning response is never STORED — by either path", async () => {
  // Labelling it is not enough. Caching a response from a replaced process would serve that
  // dead schema to every later reader for the whole TTL, as "cache" — so one badly-timed
  // response becomes a second and a half of them.
  for (const method of ["readFresh", "readWithProvenance"]) {
    const c = clock();
    const cache = createObjectInfoCache({ now: c.now });
    let epoch = 1;
    const got = await cache[method](
      async () => {
        epoch = 2; // the reconnect lands mid-fetch
        return DEFS;
      },
      { stamp: () => epoch },
    );
    assert.equal(got.provenance, "reconnected", `${method}: the caller is told`);
    // The next reader must go to the server rather than being served the dead schema.
    let refetched = false;
    const after = await cache.read(async () => {
      refetched = true;
      return { Fresh: {} };
    });
    assert.equal(refetched, true, `${method}: the reconnect-spanning payload was not cached`);
    assert.deepEqual(after, { Fresh: {} });
  }
});

test("#1126: an UNREADABLE stamp stores nothing either — nothing established, nothing pinned", async () => {
  // The storage rule has to fail closed for the same reason the classification does. If the
  // caller's own connection-identity could not be read, this response cannot be shown to
  // describe the CURRENT backend — so caching it would pin an unattributable schema for the
  // whole TTL and hand it to later readers as an ordinary "cache" hit. "Unknown" must cost
  // a re-fetch, never a stored answer nobody can vouch for.
  for (const method of ["readFresh", "readWithProvenance"]) {
    const c = clock();
    const cache = createObjectInfoCache({ now: c.now });
    const got = await cache[method](async () => DEFS, {
      stamp: () => {
        throw new Error("epoch unreadable");
      },
    });
    assert.equal(got.provenance, "unknown", `${method}: nothing established`);
    assert.equal(got.value, DEFS, `${method}: the payload still reaches its own caller`);
    let refetched = false;
    const after = await cache.read(async () => {
      refetched = true;
      return { Fresh: {} };
    });
    assert.equal(refetched, true, `${method}: the unattributable payload was not cached`);
    assert.deepEqual(after, { Fresh: {} });
  }
});

test("#1126: a joiner that wants reconnect detection on a stampless request gets UNKNOWN", async () => {
  // The issuance epoch was never recorded and cannot be reconstructed, so nothing is
  // established — and nothing established must never read as live.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let release;
  const gate = new Promise((r) => (release = r));
  const issuer = cache.readFresh(async () => {
    await gate;
    return DEFS;
  }); // no stamp
  const joiner = cache.readFresh(async () => DEFS, { stamp: () => 7 });
  release();
  await issuer;
  const rj = await joiner;
  assert.equal(rj.provenance, "unknown");
  assert.equal(rj.provenanceNow(), "unknown", "permanently — the issuance epoch is unrecoverable");
});

test("#1126: readFresh BYPASSES the stored entry without retiring anything in flight", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  // An ordinary read is in flight and must survive a concurrent forced reread untouched.
  let releaseOrdinary;
  const ordinaryGate = new Promise((r) => (releaseOrdinary = r));
  const ordinary = cache.readWithProvenance(
    async () => {
      await ordinaryGate;
      return { Ordinary: {} };
    },
    { stamp: () => 1 },
  );
  const forced = await cache.readFresh(async () => DEFS, { stamp: () => 1 });
  assert.equal(forced.provenance, "live");
  releaseOrdinary();
  const got = await ordinary;
  assert.deepEqual(got.value, { Ordinary: {} }, "its own caller still gets its answer");
  assert.equal(
    got.provenance,
    "live",
    "and it is NOT reported as retired — a forced reread is not an invalidation",
  );
});

test("#1126: readFresh actually re-fetches — the stored entry never satisfies it", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  await cache.read(async () => ({ Stale: {} }));
  assert.deepEqual(await cache.read(async () => DEFS), { Stale: {} }, "an ordinary read is served");
  const forced = await cache.readFresh(async () => DEFS, { stamp: () => 1 });
  assert.equal(forced.value, DEFS, "the forced read goes to the server anyway");
  // …and the fresher payload replaces the stored one, so later ordinary readers benefit.
  assert.deepEqual(await cache.read(async () => ({ MustNotBeFetched: {} })), DEFS);
});

test("#1126: an invalidate() retires a forced reread too — it must not be joined afterwards", async () => {
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  let fetches = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const first = cache.readFresh(
    async () => {
      fetches += 1;
      await gate;
      return { Old: {} };
    },
    { stamp: () => 1 },
  );
  cache.invalidate();
  // A caller arriving after the invalidation must NOT ride the retired request.
  const second = cache.readFresh(async () => DEFS, { stamp: () => 1 });
  release();
  assert.equal((await first).provenance, "retired", "the retired issuer is told so");
  assert.equal((await second).value, DEFS, "the later caller gets its own, current answer");
  assert.equal(fetches, 1, "…and the retired request was not re-run");
});

test("#1126: read() keeps its old contract — the payload, nothing else", async () => {
  // Every other consumer of this cache is untouched by the provenance work.
  const c = clock();
  const cache = createObjectInfoCache({ now: c.now });
  assert.equal(await cache.read(async () => DEFS), DEFS);
  // A FRESH cache: the one above now holds DEFS, so a second read would be served and the
  // loader below would never run — which is the cache working, not the contract under test.
  const c2 = clock();
  const failing = createObjectInfoCache({ now: c2.now });
  await assert.rejects(
    failing.read(async () => {
      throw new Error("boom");
    }),
    /boom/,
    "a rejection still propagates as itself, not as a verdict about itself",
  );
  // …and the same for the provenance form: an error has no provenance to report.
  await assert.rejects(
    failing.readWithProvenance(async () => {
      throw new Error("bang");
    }),
    /bang/,
  );
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

// ---------------------------------------------------------------------------
// #1178 — WHERE THE BOUND FOR #1161 LIVES, and why it may not live here.
//
// #1161 was the 30s hang: after a ComfyUI restart the tab can hold a half-open
// connection, so `api.getNodeDefs()` never settles and every `graph_set_widget`
// parked until the caller's timeout. Three attempts on #1178 put the bound in THIS
// file — on the burst cache's own read — and every one of them traded the hang for a
// refusal. #1179 shipped the answer instead: bound each TRANSPORT inside
// `fetchWholeObjectInfo`, so a hung client route falls through to the `GET
// /object_info` fallback #982 added for exactly this failure, and the write SUCCEEDS.
//
// A bound here cannot do that. It sits ABOVE the oracle, so it can only choose how to
// FAIL — and because it would have to be shorter than the oracle's deadline to fire at
// all, it pre-empts the fallback route before that route is ever asked. Measured on the
// #1178 branch against this same production loader shape: refused at 8003ms, where the
// shipped code answers with a usable schema at 10010ms.
//
// These three tests pin that outcome from the call site's side, so the next person to
// reach for a cache-level bound gets a failing test with the reason rather than a fourth
// rediscovery. Refs artokun/comfyui-mcp-panel#1161.
// ---------------------------------------------------------------------------

/** A transport that never settles — the half-open connection #1161 was reported on. */
const NEVER_SETTLES = () => new Promise(() => {});

/**
 * A deterministic scheduler for the oracle's injected `timers`/`now`.
 *
 * The clock advances ONLY when a timer fires, so `elapsed()` is the simulated time the
 * bound actually waited — which is the assertion that distinguishes "the oracle's bound
 * answered" from "something else did". A test that slept for a real 10s would be the slow
 * test this file's header warns about.
 */
function fakeSchedule() {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    timers: {
      setTimer: (fn, ms) => {
        const id = ++seq;
        pending.set(id, { at: t + ms, fn });
        return id;
      },
      clearTimer: (id) => pending.delete(id),
    },
    elapsed: () => t,
    /** Advance to the earliest armed timer and fire it. False when none is armed. */
    fireNext() {
      let pick = null;
      for (const [id, entry] of pending) if (pick === null || entry.at < pick.entry.at) pick = { id, entry };
      if (pick === null) return false;
      pending.delete(pick.id);
      t = pick.entry.at;
      pick.entry.fn();
      return true;
    },
  };
}

/**
 * Await `promise`, firing scheduled timers whenever it is not making progress on its own.
 *
 * NEVER awaits a promise that may not settle without also driving the clock forward, which
 * is what turns a broken bound into a FAILING test rather than a hung `node --test` run.
 */
async function settleWith(schedule, promise) {
  let done = false;
  let result;
  let failure;
  promise.then(
    (v) => {
      done = true;
      result = v;
    },
    (e) => {
      done = true;
      failure = e ?? new Error("rejected with a falsy value");
    },
  );
  for (let i = 0; i < 100 && !done; i++) {
    // Drain microtasks first: a step that answers on its own must not be charged a timer.
    for (let k = 0; k < 20 && !done; k++) await Promise.resolve();
    if (done) break;
    // NOTHING ARMED IS NOT THE SAME AS STUCK. The last bounded step clears its timer the
    // moment it settles, so the final turns of the chain run with an empty schedule — an
    // earlier version of this driver read that as "no progress possible" and failed a test
    // whose subject had in fact already answered. Give the chain a full macrotask before
    // concluding anything, and only then give up.
    if (!schedule.fireNext()) {
      await new Promise((resolve) => setImmediate(resolve));
      if (done) break;
      if (!schedule.fireNext()) break;
    }
  }
  assert.ok(done, "the read never settled — the bound the oracle installs did not fire");
  if (failure) throw failure;
  return result;
}

test("#1178/#1179: a hung client route still reaches the fallback THROUGH the burst cache", async () => {
  // The production loader shape, exactly as `graph_set_widget` and `graph_remove_widget`
  // build it: the whole-schema oracle, read through this cache. The client route never
  // answers; the HTTP route does. The write must be AUTHORIZED, not refused.
  const schedule = fakeSchedule();
  const cache = createObjectInfoCache({ now: clock().now });
  const deadlineMs = 1000;
  let httpCalls = 0;
  const outcome = await settleWith(
    schedule,
    cache.read(() =>
      fetchWholeObjectInfo({
        getNodeDefs: NEVER_SETTLES,
        fetchApi: async () => {
          httpCalls += 1;
          return { ok: true, status: 200, json: async () => ({ KSampler: {}, VAELoader: {} }) };
        },
        deadlineMs,
        timers: schedule.timers,
        now: schedule.now,
      }),
    ),
  );
  assert.equal(httpCalls, 1, "the fallback route #982 added must actually be asked");
  assert.deepEqual(Object.keys(outcome.defs ?? {}), ["KSampler", "VAELoader"], "and its answer must reach the fence");
  // ELAPSED, not merely the outcome: the answer arrives when the CLIENT ROUTE'S share of
  // the oracle budget runs out (half of it, per object-info-oracle.js), which is the proof
  // that the oracle's bound is what released this call. A cache-level bound would have to
  // fire before this to matter, and firing before this is precisely what skips the fallback.
  assert.equal(schedule.elapsed(), deadlineMs / 2, "released by the oracle's client-route bound");
});

test("#1178: the burst cache arms NO timer of its own — the bound belongs one layer down", async () => {
  // The decisive guard, written against the CALL rather than the source text so a rename
  // cannot slip past it. Re-introducing `withTimeout(...)` in `read()` — for the issuer or
  // for a joiner — arms a real timer here and fails this test with the reason.
  const realSetTimeout = globalThis.setTimeout;
  let armed = 0;
  globalThis.setTimeout = (...args) => {
    armed += 1;
    return realSetTimeout(...args);
  };
  try {
    const cache = createObjectInfoCache({ now: clock().now });
    let release;
    const gate = new Promise((r) => (release = r));
    const issuer = cache.read(async () => {
      await gate;
      return DEFS;
    });
    const joiner = cache.read(async () => DEFS); // coalesces onto the request above
    release();
    assert.equal(await issuer, DEFS);
    assert.equal(await joiner, DEFS, "a joiner gets the same answer, unbounded and unmodified");
    assert.equal(
      armed,
      0,
      "the cache must not bound its own read: a bound here can only pre-empt the oracle's " +
        "fallback route, which is how #1178's three attempts each turned the hang into a refusal",
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("#1178/#1223: a fully silent backend rides through the cache as SILENCE, not as an answer", async () => {
  // What the cache hands back when neither route answers has to stay the ORACLE's outcome,
  // tags and all. #1223's snapshot fallback is licensed on exactly that distinction, so a
  // cache that substituted a note of its own would disable the fallback for every caller AND
  // make the refusal name a cause that never happened — the #982 defect, committed one layer
  // up. (Measured on the #1178 branch: `outcomes` arrived null and the refusal read "the
  // backend ANSWERED the schema probe with something unusable", which it had not.)
  const schedule = fakeSchedule();
  const cache = createObjectInfoCache({ now: clock().now });
  const outcome = await settleWith(
    schedule,
    cache.read(() =>
      fetchWholeObjectInfo({
        getNodeDefs: NEVER_SETTLES,
        fetchApi: NEVER_SETTLES,
        deadlineMs: 1000,
        timers: schedule.timers,
        now: schedule.now,
      }),
    ),
  );
  // NO FABRICATED SUCCESS. The read is what AUTHORIZES the write, so it runs before any
  // mutation — a call that ends here refused without touching the graph, and says so.
  assert.equal(outcome.defs, null, "silence must never read as a usable schema");
  assert.ok(outcome.failures.length >= 2, "every route that did not answer is named");
  assert.equal(
    noBackendAnswerEstablished(outcome.outcomes),
    true,
    "the transport tags must survive the cache, or #1223's snapshot fallback is dead on this path",
  );
});
