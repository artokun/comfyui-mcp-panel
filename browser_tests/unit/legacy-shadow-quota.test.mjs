import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChatHistoryStore,
  boundShadowBytes,
  CHAT_HISTORY_SCHEMA,
  CHAT_HISTORY_DB_VERSION,
  CHAT_HISTORY_LEGACY_STORE,
} from "../../web/js/lib/chat-history-store.js";

// #861 — the panel's localStorage shadow kept every `legacyShadow` thread in full,
// every message, forever, in a ~5MB budget it does not own alone. localStorage is
// per-ORIGIN and the panel shares http://localhost:8188 with ComfyUI, so those bytes
// are bytes ComfyUI's own saveDraft() cannot have. Past a point ComfyUI starts
// showing "Failed to save workflow draft", Comfy.Workflow.DraftIndex.v2 stops
// persisting, and every open workflow tab is gone on browser restart — with a clean
// backend log and nothing pointing at the panel.
//
// The retention was not careless: the schema-3 fence keeps these threads out of
// IndexedDB, so the shadow was their ONLY copy and capping it would have been
// deleting transcripts. These pin the order the fix depends on — durable home first,
// bound second, fail closed if the home is unavailable.

// ── a fake IndexedDB, because the failure lives in the durable path ────────

function createFakeIndexedDb({ failWrites = false, missingLegacyStore = false } = {}) {
  const state = { failWrites, failStore: null, failDelete: false };
  const stores = new Map([["snapshots", new Map()]]);
  if (!missingLegacyStore) stores.set(CHAT_HISTORY_LEGACY_STORE, new Map());
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    close() {},
    transaction(name, mode) {
      const data = stores.get(name);
      if (!data) throw new Error(`no store ${name}`);
      const tx = { oncomplete: null, onerror: null, onabort: null };
      let doomed = false;
      const settle = () => {
        queueMicrotask(() => {
          if ((state.failWrites || state.failStore === name || doomed) && mode === "readwrite") tx.onabort?.();
          else tx.oncomplete?.();
        });
      };
      tx.objectStore = () => ({
        get(key) {
          const req = {};
          queueMicrotask(() => { req.result = data.get(key); req.onsuccess?.(); });
          return req;
        },
        getAll() {
          const req = {};
          queueMicrotask(() => { req.result = [...data.values()]; req.onsuccess?.(); });
          return req;
        },
        delete(key) {
          // A delete can fail where a small put still lands — a bulk delete and a
          // one-key marker are not the same transaction cost.
          if (state.failDelete) doomed = true;
          else if (!state.failWrites && state.failStore !== name) data.delete(key);
          const req = {};
          queueMicrotask(() => req.onsuccess?.());
          settle();
          return req;
        },
        clear() {
          if (!state.failWrites && state.failStore !== name) data.clear();
          const req = {};
          queueMicrotask(() => req.onsuccess?.());
          settle();
          return req;
        },
        put(value, key) {
          if (!state.failWrites && state.failStore !== name) data.set(key, value);
          const req = {};
          queueMicrotask(() => req.onsuccess?.());
          settle();
          return req;
        },
      });
      if (mode !== "readwrite") settle();
      return tx;
    },
  };
  return {
    _stores: stores,
    _state: state,
    open() {
      const req = {};
      queueMicrotask(() => { req.result = db; req.onsuccess?.(); });
      return req;
    },
  };
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

const legacyThread = (id, ts, size = 50) => ({
  id,
  schemaVersion: CHAT_HISTORY_SCHEMA,
  legacyShadow: true,
  ts,
  updatedAt: ts,
  msgs: [{ id: `${id}-m`, role: "user", text: "x".repeat(size) }],
});

// ── the version decoupling, which is load-bearing ──────────────────────────

test("the IDB version is NOT the record schema version", () => {
  // These were one constant. The fence is `snapshot.schemaVersion >= CHAT_HISTORY_SCHEMA`,
  // so bumping the number to add an object store would have made every stored
  // schemaVersion:3 snapshot read as UNFENCED — reopening the pre-v3 merge path on
  // every existing install, as a side effect of a structural migration.
  assert.equal(CHAT_HISTORY_SCHEMA, 3, "the record schema must not move for a store migration");
  assert.ok(CHAT_HISTORY_DB_VERSION > CHAT_HISTORY_SCHEMA, "the store migration needs its own number");
});

// ── the byte bound ─────────────────────────────────────────────────────────

test("a snapshot already under budget is returned untouched", () => {
  const snap = { threads: [legacyThread("a", 1)] };
  const out = boundShadowBytes(snap, { maxBytes: 1_000_000, evictableIds: new Set(["a"]) });
  assert.equal(out.snapshot, snap, "the common case must not rebuild the snapshot");
  assert.deepEqual(out.evicted, []);
});

test("it evicts OLDEST first, and only down to the budget", () => {
  // A shadow exists for instant startup; the newest chats are the ones a user comes
  // back to, so they are the last to go.
  const threads = [legacyThread("old", 1, 400), legacyThread("mid", 2, 400), legacyThread("new", 3, 400)];
  const out = boundShadowBytes({ threads }, {
    maxBytes: 1000,
    evictableIds: new Set(["old", "mid", "new"]),
  });
  assert.ok(out.evicted.includes("old"), "the oldest must go first");
  assert.ok(!out.evicted.includes("new"), "the newest must survive");
  assert.ok(out.serialized.length <= 1000, `still over budget: ${out.serialized.length}`);
});

test("the result ACTUALLY fits, across many shapes and budgets", () => {
  // The eviction count comes from a per-thread cost estimate, and the claim is that
  // the estimate can only overshoot downward (it ignores the comma each removal also
  // frees). "Usually right" is not a bound, so assert the invariant over a spread of
  // thread sizes and budgets rather than one hand-picked case.
  for (const size of [10, 200, 5000]) {
    for (const count of [3, 40]) {
      for (const maxBytes of [50, 900, 5000]) {
        const threads = Array.from({ length: count }, (_, i) => legacyThread(`t${i}`, i, size));
        const out = boundShadowBytes({ threads }, {
          maxBytes,
          evictableIds: new Set(threads.map((t) => t.id)),
        });
        const label = `size=${size} count=${count} max=${maxBytes}`;
        // The floor: an empty thread list still serializes to a few bytes, so a
        // budget below that cannot be met by eviction alone.
        const floor = JSON.stringify({ threads: [] }).length;
        assert.ok(
          out.serialized.length <= Math.max(maxBytes, floor),
          `over budget (${label}): ${out.serialized.length}`,
        );
        assert.equal(
          JSON.stringify(out.snapshot).length,
          out.serialized.length,
          `the returned bytes must BE the returned snapshot (${label})`,
        );
      }
    }
  }
});

test("it does not over-evict — a thread that fits is kept", () => {
  // The other half of the estimate's honesty. Overshooting downward is safe but not
  // free: every thread dropped is one the user does not see on next startup.
  const threads = [legacyThread("old", 1, 100), legacyThread("new", 2, 100)];
  const full = JSON.stringify({ threads }).length;
  const out = boundShadowBytes({ threads }, {
    maxBytes: full - 1,
    evictableIds: new Set(["old", "new"]),
  });
  assert.deepEqual(out.evicted, ["old"], "one eviction was enough; the second is waste");
});

test("NOTHING is evicted without a durable receipt — fail closed", () => {
  // This is the whole reason a byte cap alone would have been wrong. An unbounded
  // shadow is a quota bug; deleting the only copy of a transcript to fix it is worse.
  const threads = Array.from({ length: 20 }, (_, i) => legacyThread(`t${i}`, i, 500));
  for (const evictable of [undefined, new Set()]) {
    const out = boundShadowBytes({ threads }, { maxBytes: 100, evictableIds: evictable });
    assert.deepEqual(out.evicted, [], "an unproven thread must never be dropped");
    assert.equal(out.snapshot.threads.length, 20);
  }
});

test("a protected thread is never evicted, even when it IS durable", () => {
  // Losing the transcript on screen to save space is not a trade a user would
  // recognise as help.
  const threads = [legacyThread("live", 1, 900), legacyThread("other", 2, 900)];
  const out = boundShadowBytes({ threads }, {
    maxBytes: 200,
    evictableIds: new Set(["live", "other"]),
    protectedIds: new Set(["live"]),
  });
  assert.ok(!out.evicted.includes("live"), "the protected thread must survive");
  assert.ok(out.evicted.includes("other"));
});

test("a thread with no usable id is never evicted", () => {
  const threads = [{ ts: 1, msgs: [] }, legacyThread("real", 2, 900)];
  const out = boundShadowBytes({ threads }, { maxBytes: 50, evictableIds: new Set(["real"]) });
  assert.deepEqual(out.evicted, ["real"]);
});

// ── the durable home, end to end ───────────────────────────────────────────

test("legacy threads get a durable home, and the shadow can then be bounded", async () => {
  const indexedDb = createFakeIndexedDb();
  const storage = createMemoryStorage();
  const evictions = [];
  const store = new ChatHistoryStore({
    storage,
    indexedDb,
    maxShadowBytes: 2000,
    onShadowEvict: (ids) => evictions.push(...ids),
  });
  const threads = Array.from({ length: 12 }, (_, i) => legacyThread(`L${i}`, i + 1, 400));
  store.persist(threads, {});
  await store._writePromise;

  const durable = [...indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).keys()];
  assert.equal(durable.length, 12, "every legacy thread must reach the legacy store");

  // Second persist: the receipts now exist, so the shadow may shed bytes.
  store.persist(threads, {});
  await store._writePromise;
  const written = JSON.parse(storage.getItem("comfyui-mcp.panel.historySnapshot"));
  assert.ok(JSON.stringify(written).length <= 2000, "the shadow must respect the byte budget");
  assert.ok(evictions.length > 0, "eviction must be observable, not silent");
});

test("an unreachable legacy store leaves the shadow unbounded rather than lossy", async () => {
  // Private browsing, disabled IDB, a failed upgrade. The threads still have no
  // durable home, so today's behaviour is the correct behaviour.
  const storage = createMemoryStorage();
  const store = new ChatHistoryStore({ storage, indexedDb: null, maxShadowBytes: 500 });
  const threads = Array.from({ length: 10 }, (_, i) => legacyThread(`L${i}`, i + 1, 400));
  store.persist(threads, {});
  await store._writePromise;
  const written = JSON.parse(storage.getItem("comfyui-mcp.panel.historySnapshot"));
  assert.equal(written.threads.length, 10, "no legacy thread may be dropped without a durable copy");
});

test("a legacy store that ABORTS the write grants no receipt", async () => {
  // Individual puts succeed against a transaction that later aborts on quota.
  // Reporting that as durable is exactly what would license deleting the other copy.
  const indexedDb = createFakeIndexedDb({ failWrites: true });
  const storage = createMemoryStorage();
  const store = new ChatHistoryStore({ storage, indexedDb, maxShadowBytes: 500 });
  const threads = Array.from({ length: 8 }, (_, i) => legacyThread(`L${i}`, i + 1, 400));
  store.persist(threads, {});
  await store._writePromise;
  assert.equal(store._durableLegacy.size, 0, "an aborted transaction is not a receipt");
  const written = JSON.parse(storage.getItem("comfyui-mcp.panel.historySnapshot"));
  assert.equal(written.threads.length, 8, "…so nothing may be evicted");
});

test("a database without the legacy store grants no receipt either", async () => {
  // An upgrade that was blocked by another tab leaves an older DB shape live.
  const indexedDb = createFakeIndexedDb({ missingLegacyStore: true });
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb, maxShadowBytes: 500 });
  store.persist([legacyThread("L0", 1, 900)], {});
  await store._writePromise;
  assert.equal(store._durableLegacy.size, 0);
});

test("a thread evicted from the shadow comes BACK from the legacy store", async () => {
  // The point of the durable home. If eviction were one-way this would be data loss
  // with extra steps.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb, maxShadowBytes: 600 });
  const threads = Array.from({ length: 6 }, (_, i) => legacyThread(`L${i}`, i + 1, 300));
  store.persist(threads, {});
  await store._writePromise;
  store.persist(threads, {});
  await store._writePromise;

  const reader = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const read = await reader.readCanonical();
  const ids = new Set((read?.threads || []).map((t) => t.id));
  for (const thread of threads) {
    assert.ok(ids.has(thread.id), `${thread.id} must be recoverable from the legacy store`);
  }
  // Every restored thread must come back STILL FLAGGED. Dropping the flag would
  // launder pre-v3 content — messages with no ids, re-hashed ordinals — straight
  // through the schema-3 fence into canonical on the next persist, which is the
  // exact resurrection the quarantine exists to prevent. (Written as an explicit
  // count, not `every(t => !t.x || t.x === true)`: that predicate is true for
  // `false` and can never fail.)
  const restoredIds = new Set(threads.map((t) => t.id));
  const restored = (read?.threads || []).filter((t) => restoredIds.has(t.id));
  assert.equal(restored.length, threads.length);
  for (const thread of restored) {
    assert.equal(thread.legacyShadow, true, `${thread.id} must stay quarantined`);
  }
});

test("an unreachable store on READ revokes the receipts rather than assuming empty", async () => {
  // `idbReadLegacy` returns null for unreachable and [] for empty, and the
  // difference decides whether transcripts may be evicted. Reading unreachable as
  // empty would both crash on the null and, worse, let a later write believe threads
  // were already durable when nothing had been read at all.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1)], {});
  await store._writePromise;
  assert.equal(store._durableLegacy.size, 1, "precondition: a receipt exists");

  store.indexedDb = null; // the store goes away mid-session (tab upgrade, private mode)
  const read = await store.readCanonical();
  assert.ok(read, "an unreachable legacy store must not fail the whole read");
  assert.equal(store._durableLegacy.size, 0, "unknown is not proof of durability");
});

test("an EMPTY legacy store is not the same as an unreachable one", async () => {
  // The other side of that distinction: genuinely empty is authoritative, and must
  // not be mistaken for a failure that would keep stale receipts alive.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store._durableLegacy = new Map([["stale", "x"]]);
  await store.readCanonical();
  assert.equal(store._durableLegacy.has("stale"), false, "an empty store proves 'stale' is not durable");
});

test("the migration is idempotent — re-running it overwrites in place", async () => {
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const threads = [legacyThread("L0", 1), legacyThread("L1", 2)];
  store.persist(threads, {});
  await store._writePromise;
  for (let i = 0; i < 3; i += 1) {
    await store.readCanonical();
  }
  assert.equal(
    indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).size,
    2,
    "repeated migration must not duplicate records",
  );
});

test("ordinary threads are not evictable until CANONICAL has accepted them", async () => {
  // The shadow is a cache of canonical — but only once canonical exists. Before the
  // IndexedDB merge lands, and on any install where IndexedDB is unavailable, the
  // shadow is the only copy of ordinary threads too, and the same rule has to apply
  // to them as to legacy ones.
  const storage = createMemoryStorage();
  const store = new ChatHistoryStore({ storage, indexedDb: null, maxShadowBytes: 400 });
  const ordinary = Array.from({ length: 6 }, (_, i) => ({
    id: `O${i}`,
    schemaVersion: CHAT_HISTORY_SCHEMA,
    ts: i + 1,
    updatedAt: i + 1,
    msgs: [{ id: `O${i}-m`, role: "user", text: "y".repeat(300) }],
  }));
  store.persist(ordinary, {});
  await store._writePromise;
  const written = JSON.parse(storage.getItem("comfyui-mcp.panel.historySnapshot"));
  assert.equal(written.threads.length, 6, "no ordinary thread may be dropped with no canonical copy");
});

// ── codex P1: an id is not a receipt for CONTENT ───────────────────────────

test("an EDITED legacy thread is rewritten, and is not evictable until it is", async () => {
  // The receipt was a set of ids. A legacy thread written once and then edited —
  // renamed, pinned, a message tombstoned — was filtered out of every later write as
  // "already durable" while the stored copy stayed at the old version. The shadow
  // would then evict the NEW version against a receipt for the OLD one, report
  // legacyComplete: true, and clear the dirty flag. That is this whole change's own
  // failure mode, one level down.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const original = legacyThread("L0", 1, 40);
  store.persist([original], {});
  await store._writePromise;
  const storedFirst = indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).get("L0");
  assert.equal(storedFirst.msgs[0].text.length, 40);

  const edited = { ...original, updatedAt: 99, title: "renamed", msgs: [{ id: "L0-m", role: "user", text: "z".repeat(900) }] };
  store.persist([edited], {});
  await store._writePromise;
  const storedSecond = indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).get("L0");
  assert.equal(storedSecond.msgs[0].text.length, 900, "the edit must reach the durable copy");
  assert.equal(storedSecond.title, "renamed");
});

test("a stale receipt does not license eviction", async () => {
  // The receipt must be checked against the thread ABOUT to be evicted, not against
  // the name of a thread stored at some point in the past.
  const indexedDb = createFakeIndexedDb();
  const storage = createMemoryStorage();
  const store = new ChatHistoryStore({ storage, indexedDb, maxShadowBytes: 300 });
  const threads = [legacyThread("L0", 1, 400), legacyThread("L1", 2, 400)];
  store.persist(threads, {});
  await store._writePromise;
  // Forge a receipt whose fingerprint cannot match, exactly as a post-write edit
  // would leave it.
  store._durableLegacy.set("L0", "not-the-current-content");
  store.persist(threads, {});
  await store._writePromise;
  const written = JSON.parse(storage.getItem("comfyui-mcp.panel.historySnapshot"));
  // L0 was rewritten (its fingerprint did not match) and so becomes legitimately
  // durable again — the point is that it was never evicted on the forged receipt.
  assert.ok(
    indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).has("L0"),
    "a mismatched fingerprint must trigger a rewrite, not an eviction",
  );
  assert.ok(written, "the shadow must still have been written");
});

// ── codex P1: deletes must not undo themselves ─────────────────────────────

test("a TOMBSTONED legacy thread is deleted from the store", async () => {
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const threads = [legacyThread("L0", 1), legacyThread("L1", 2)];
  store.persist(threads, {});
  await store._writePromise;
  assert.equal(indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).size, 2);

  store.persist([threads[1]], { deletedThreads: { L0: { updatedAt: 500, writerId: 'tab-x', sequence: 1 } } });
  await store._writePromise;
  assert.equal(
    indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).has("L0"),
    false,
    "a deleted transcript must leave the durable store too",
  );
});

test("a tombstoned thread is not restored, even if the delete has not landed", async () => {
  // The durable delete can fail (unreachable store, quota). The restore path must
  // hold the line on its own, or an unreachable store resurrects a delete.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1)], {});
  await store._writePromise;
  assert.ok(indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).has("L0"));

  const reader = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const restored = await reader._restoreLegacyShadow({
    threads: [],
    meta: { deletedThreads: { L0: { updatedAt: 500, writerId: 'tab-x', sequence: 1 } } },
  });
  assert.equal(
    (restored.threads || []).some((t) => t.id === "L0"),
    false,
    "a tombstoned transcript must not come back",
  );
});

test("an EVICTED (not deleted) thread still comes back", async () => {
  // The other side of that rule. Absent-from-snapshot is what an eviction looks like
  // too, so honouring tombstones must not turn into deleting on absence.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1)], {});
  await store._writePromise;

  const reader = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const restored = await reader._restoreLegacyShadow({ threads: [], meta: {} });
  assert.equal((restored.threads || []).some((t) => t.id === "L0"), true);
});

test("clearAll empties the legacy store", async () => {
  // clearAll is the user saying delete everything. A legacy store that survives it
  // hands every cleared transcript back on the next load.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1), legacyThread("L1", 2)], {});
  await store._writePromise;
  assert.equal(indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).size, 2);

  await store.clearAll([], {});
  await store._writePromise;
  assert.equal(
    indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).size,
    0,
    "cleared transcripts must not survive in the legacy store",
  );
  assert.equal(store._durableLegacy.size, 0, "…nor may their receipts");
});

test("an edit whose durable rewrite FAILS leaves the thread unevictable", async () => {
  // The case that separates an id receipt from a content receipt. A receipt exists
  // (the thread was stored once), the thread is then edited, and the rewrite cannot
  // land. An id-only gate would evict the new version against the old copy — which
  // is precisely the loss the fingerprint exists to prevent. Nothing else in the
  // suite reaches this, because the rewrite normally refreshes the receipt first.
  const indexedDb = createFakeIndexedDb();
  const storage = createMemoryStorage();
  const store = new ChatHistoryStore({ storage, indexedDb, maxShadowBytes: 400 });
  const original = legacyThread("L0", 1, 30);
  const filler = legacyThread("L1", 2, 30);
  store.persist([original, filler], {});
  await store._writePromise;
  assert.equal(store._durableLegacy.size, 2, "precondition: both are durable");

  indexedDb._state.failWrites = true; // quota, or a store that went away
  const edited = { ...original, updatedAt: 99, msgs: [{ id: "L0-m", role: "user", text: "z".repeat(900) }] };
  store.persist([edited, filler], {});
  await store._writePromise;

  const written = JSON.parse(storage.getItem("comfyui-mcp.panel.historySnapshot"));
  const kept = (written.threads || []).find((t) => t.id === "L0");
  assert.ok(kept, "the edited thread must stay in the shadow — its durable copy is stale");
  assert.equal(kept.msgs[0].text.length, 900, "…and it must be the EDITED version that stayed");
});

// ── codex round 2 ──────────────────────────────────────────────────────────

test('a same-length, same-timestamp edit ("foo" -> "bar") is still detected', async () => {
  // The exact collision codex named. updatedAt + message count + serialized length
  // are all identical across this edit, so the earlier fingerprint passed it as
  // unchanged and the shadow would evict the new text against the old copy. For a
  // durability gate "probably unchanged" is not a category.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const before = { ...legacyThread("L0", 7), msgs: [{ id: "m", role: "user", text: "foo" }] };
  store.persist([before], {});
  await store._writePromise;
  assert.equal(indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).get("L0").msgs[0].text, "foo");

  const after = { ...before, msgs: [{ id: "m", role: "user", text: "bar" }] };
  assert.equal(JSON.stringify(before).length, JSON.stringify(after).length, "precondition: same length");
  assert.equal(before.updatedAt, after.updatedAt, "precondition: same timestamp");
  store.persist([after], {});
  await store._writePromise;
  assert.equal(
    indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).get("L0").msgs[0].text,
    "bar",
    "the durable copy must follow a same-size edit",
  );
});

test("a tombstone deletes ONLY its own record, never a neighbour's", async () => {
  // The guard's real job. `mergeHistorySnapshots` already resolves tombstone-vs-live
  // before this pass runs — a tombstoned id is dropped from the snapshot, so it is
  // never simultaneously "live" here — which makes the id-not-in-liveIds check
  // defence in depth rather than the primary decision. What must hold regardless is
  // that a delete driven by one tombstone cannot reach past it.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1), legacyThread("L1", 2), legacyThread("L2", 3)], {});
  await store._writePromise;
  assert.equal(indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).size, 3);

  store.persist([legacyThread("L0", 1), legacyThread("L2", 3)], {
    deletedThreads: { L1: { updatedAt: 500, writerId: "t", sequence: 1 } },
  });
  await store._writePromise;
  const keys = [...indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).keys()].sort();
  assert.deepEqual(keys, ["L0", "L2"], "only the tombstoned record may go");
});

test("the delete pass skips any id still present as a live thread", async () => {
  // The guard itself, exercised directly: ids can be reused and a tombstone can lose
  // a causal merge, and deleting by id alone would take the live record with it.
  // Driven through _restoreLegacyShadow-independent state so the merge cannot quietly
  // resolve the conflict first.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1)], {});
  await store._writePromise;
  store._pendingLegacyDeletes.add("L0"); // a delete that never landed
  // …but L0 is live again in this write.
  store.persist([legacyThread("L0", 90)], {});
  await store._writePromise;
  assert.ok(
    indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).has("L0"),
    "a live thread's record must survive an outstanding delete for the same id",
  );
});

test("a FAILED delete is retried, even after its tombstone ages out", async () => {
  // meta.deletedThreads is capped, so a tombstone expires. A delete that failed while
  // its tombstone was live would otherwise stop being retried and the record would be
  // restored on the next load.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1), legacyThread("L1", 2)], {});
  await store._writePromise;

  indexedDb._state.failWrites = true;
  store.persist([legacyThread("L1", 2)], {
    deletedThreads: { L0: { updatedAt: 5, writerId: "t", sequence: 1 } },
  });
  await store._writePromise;
  assert.ok(store._pendingLegacyDeletes.has("L0"), "a failed delete must be remembered");
  assert.ok(indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).has("L0"), "precondition: still there");

  // The tombstone is GONE from meta now — aged out of the capped map.
  indexedDb._state.failWrites = false;
  store.persist([legacyThread("L1", 2)], {});
  await store._writePromise;
  assert.equal(
    indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).has("L0"),
    false,
    "the retry must land without the tombstone still being present",
  );
  assert.equal(store._pendingLegacyDeletes.has("L0"), false, "…and stop being pending");
});

test("a pending delete also suppresses the RESTORE while it is outstanding", async () => {
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1)], {});
  await store._writePromise;
  store._pendingLegacyDeletes.add("L0");
  const restored = await store._restoreLegacyShadow({ threads: [], meta: {} });
  assert.equal(
    (restored.threads || []).some((t) => t.id === "L0"),
    false,
    "a delete that has not landed must not be undone by a restore",
  );
});

test("clearAll REPORTS a legacy store it could not clear", async () => {
  // The canonical reset has already happened by then, so a failed legacy clear cannot
  // be undone — but reporting it as a completed clear tells the user their transcripts
  // are gone and then hands them back after a reload.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1)], {});
  await store._writePromise;

  // Fail ONLY the legacy store: a global failure would take the canonical reset
  // down first and we would be testing a different branch.
  indexedDb._state.failStore = CHAT_HISTORY_LEGACY_STORE;
  const result = await store.clearAll([], {});
  assert.equal(result.ok, false, "an incomplete clear must not report success");
  assert.equal(result.code, "history-clear-legacy-unavailable");
  assert.equal(result.retryable, true, "a later clear can finish the job");
  assert.equal(result.canonicalCommitted, true, "…while still reporting what DID happen");
});

test("clearAll reports success when the legacy store really was cleared", () => {
  // The other side, so the failure branch cannot be satisfied by always reporting bad.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1)], {});
  return store._writePromise
    .then(() => store.clearAll([], {}))
    .then((result) => {
      assert.equal(result.ok, true);
      assert.equal(result.code, null);
      assert.equal(indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).size, 0);
    });
});

test("a failed delete survives a RELOAD and is retried by the next tab", async () => {
  // codex r3. The retry intent used to live only in memory: close the tab and it was
  // gone. If `meta.deletedThreads` (capped at 512) had aged the id out by the time a
  // new tab looked, the record was absent from both tombstone sources AND from the
  // new tab's empty pending set — never retried, and free to restore. The intent now
  // lives in the legacy store, where nothing caps it.
  const indexedDb = createFakeIndexedDb();
  const first = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  first.persist([legacyThread("L0", 1), legacyThread("L1", 2)], {});
  await first._writePromise;

  // The DELETE fails; the small marker put still lands. That is the window this
  // exists for — a tab that closes before its retry.
  indexedDb._state.failDelete = true;
  first.persist([legacyThread("L1", 2)], {
    deletedThreads: { L0: { updatedAt: 5, writerId: "t", sequence: 1 } },
  });
  await first._writePromise;
  assert.ok(first._pendingLegacyDeletes.has("L0"), "precondition: the delete did not land");
  assert.ok(
    indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).has("L0"),
    "precondition: the record is still there",
  );

  // A NEW tab: fresh store object, empty in-memory state, and NO tombstone in meta.
  const next = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const restored = await next._restoreLegacyShadow({ threads: [], meta: {} });
  assert.equal(
    (restored.threads || []).some((t) => t.id === "L0"),
    false,
    "the reloaded tab must still suppress a delete it never saw a tombstone for",
  );
  assert.ok(next._pendingLegacyDeletes.has("L0"), "…and must inherit the retry intent");
});

test("the pending-delete marker is never mistaken for a transcript", async () => {
  // It lives in the same store as the threads. Every reader here requires a string
  // `id` on a record, so the marker is skipped — but that is a property worth pinning
  // rather than a coincidence to rediscover.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1), legacyThread("L1", 2)], {});
  await store._writePromise;
  indexedDb._state.failDelete = true;
  store.persist([legacyThread("L1", 2)], {
    deletedThreads: { L0: { updatedAt: 5, writerId: "t", sequence: 1 } },
  });
  await store._writePromise;
  indexedDb._state.failDelete = false;

  const reader = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const restored = await reader._restoreLegacyShadow({ threads: [], meta: {} });
  for (const thread of restored.threads || []) {
    assert.equal(typeof thread.id, "string");
    assert.ok(thread.id, "no record without an id may reach the transcript list");
    assert.ok(Array.isArray(thread.msgs), "…and every restored record must be a thread");
  }
  assert.equal(reader._durableLegacy.has("__cmcp_pending_deletes"), false, "the marker is not a receipt");
});

// ── codex r4 ───────────────────────────────────────────────────────────────

test("one tab finishing its delete does not erase another tab's pending intent", async () => {
  // The lost update codex named. Tab A finishes L0 and would write []; tab B's delete
  // of L1 failed and wrote [L1]. A whole-list overwrite from A erases B's durable
  // intent — then B closes, L1's capped tombstone ages out, and the reload hole is
  // back. The write is a merge inside one transaction, so A only removes what A
  // finished.
  const indexedDb = createFakeIndexedDb();
  const tabB = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  tabB.persist([legacyThread("L0", 1), legacyThread("L1", 2), legacyThread("L2", 3)], {});
  await tabB._writePromise;

  indexedDb._state.failDelete = true;
  tabB.persist([legacyThread("L0", 1), legacyThread("L2", 3)], {
    deletedThreads: { L1: { updatedAt: 5, writerId: "b", sequence: 1 } },
  });
  await tabB._writePromise;
  indexedDb._state.failDelete = false;
  assert.ok(tabB._pendingLegacyDeletes.has("L1"), "precondition: B owes a delete");

  // Tab A: never saw L1's tombstone, and finishes its OWN delete of L0.
  const tabA = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  tabA.persist([legacyThread("L2", 3)], {
    deletedThreads: { L0: { updatedAt: 9, writerId: "a", sequence: 1 } },
  });
  await tabA._writePromise;
  assert.equal(indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).has("L0"), false, "A's delete landed");

  // A third tab must still inherit B's intent.
  const tabC = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  await tabC._restoreLegacyShadow({ threads: [], meta: {} });
  assert.ok(
    tabC._pendingLegacyDeletes.has("L1"),
    "another tab's outstanding delete must survive an unrelated tab's completion",
  );
});

test("a thread whose id IS the reserved marker key is never stored", async () => {
  // Ids are normally crypto.randomUUID(), but an IMPORTED history can carry anything.
  // Storing it would have the thread and the marker overwrite each other.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const collide = { ...legacyThread("x", 1), id: "__cmcp_pending_deletes" };
  store.persist([collide, legacyThread("L1", 2)], {});
  await store._writePromise;
  const marker = indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).get("__cmcp_pending_deletes");
  assert.ok(!marker || !Array.isArray(marker.msgs), "a transcript must not occupy the marker key");
  assert.equal(
    store._durableLegacy.has("__cmcp_pending_deletes"),
    false,
    "…and it must not be granted a receipt, so it stays unevictable",
  );
});

test("the marker is filtered structurally, not by key name", async () => {
  // One place decides what a transcript is: a record with a string `id`.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1)], {});
  await store._writePromise;
  // Any non-thread record, whatever its key, must not surface as history.
  indexedDb._stores.get(CHAT_HISTORY_LEGACY_STORE).set("some-other-meta", { ids: ["z"] });
  const reader = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const restored = await reader._restoreLegacyShadow({ threads: [], meta: {} });
  assert.deepEqual((restored.threads || []).map((t) => t.id), ["L0"]);
});
