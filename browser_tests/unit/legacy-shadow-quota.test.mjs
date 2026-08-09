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
  const stores = new Map([["snapshots", new Map()]]);
  if (!missingLegacyStore) stores.set(CHAT_HISTORY_LEGACY_STORE, new Map());
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    close() {},
    transaction(name, mode) {
      const data = stores.get(name);
      if (!data) throw new Error(`no store ${name}`);
      const tx = { oncomplete: null, onerror: null, onabort: null };
      const settle = () => {
        queueMicrotask(() => {
          if (failWrites && mode === "readwrite") tx.onabort?.();
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
        put(value, key) {
          if (!failWrites) data.set(key, value);
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
  assert.equal(store._durableLegacyIds.size, 0, "an aborted transaction is not a receipt");
  const written = JSON.parse(storage.getItem("comfyui-mcp.panel.historySnapshot"));
  assert.equal(written.threads.length, 8, "…so nothing may be evicted");
});

test("a database without the legacy store grants no receipt either", async () => {
  // An upgrade that was blocked by another tab leaves an older DB shape live.
  const indexedDb = createFakeIndexedDb({ missingLegacyStore: true });
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb, maxShadowBytes: 500 });
  store.persist([legacyThread("L0", 1, 900)], {});
  await store._writePromise;
  assert.equal(store._durableLegacyIds.size, 0);
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
  assert.equal(store._durableLegacyIds.size, 1, "precondition: a receipt exists");

  store.indexedDb = null; // the store goes away mid-session (tab upgrade, private mode)
  const read = await store.readCanonical();
  assert.ok(read, "an unreachable legacy store must not fail the whole read");
  assert.equal(store._durableLegacyIds.size, 0, "unknown is not proof of durability");
});

test("an EMPTY legacy store is not the same as an unreachable one", async () => {
  // The other side of that distinction: genuinely empty is authoritative, and must
  // not be mistaken for a failure that would keep stale receipts alive.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store._durableLegacyIds = new Set(["stale"]);
  await store.readCanonical();
  assert.equal(store._durableLegacyIds.has("stale"), false, "an empty store proves 'stale' is not durable");
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
