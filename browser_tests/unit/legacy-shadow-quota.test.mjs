import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ChatHistoryStore,
  boundShadowBytes,
  mergeHistorySnapshots,
  measurePanelShadowBytes,
  probeDraftIndexWrite,
  writeLocalStorageItem,
  CHAT_HISTORY_SCHEMA,
  CHAT_HISTORY_DB_VERSION,
  CHAT_HISTORY_LEGACY_STORE,
  CHAT_HISTORY_LOCAL_SNAPSHOT_KEY,
  COMFY_DRAFT_INDEX_KEY,
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
  // Keyed by store + key, and multi-store transactions, because the real one is both.
  // `idbWriteLegacy` spans `legacy` and `snapshots` in ONE transaction so it can see
  // the pending-delete marker while it writes; a fake that only understood a single
  // store name made that read as a bug in the change.
  const state = { failWrites, failStore: null, failDelete: false };
  const names = ["snapshots"];
  if (!missingLegacyStore) names.push(CHAT_HISTORY_LEGACY_STORE);
  const data = new Map();
  const at = (store, key) => store + " :: " + String(key);

  const db = {
    objectStoreNames: { contains: (name) => names.includes(name) },
    close() {},
    transaction(requested, mode) {
      const wanted = Array.isArray(requested) ? requested : [requested];
      for (const name of wanted) {
        if (!names.includes(name)) throw new Error("no object store " + name);
      }
      const tx = { oncomplete: null, onerror: null, onabort: null };
      let doomed = false;
      let settled = false;
      // Real IDB completes a transaction once its request queue drains, whether or not
      // anything was WRITTEN. The legacy write opens readwrite over two stores and can
      // legitimately issue only a get (every id was refused), so a fake that settled
      // solely on put/delete/clear hung forever instead of failing.
      const settle = () => {
        if (settled) return;
        settled = true;
        queueMicrotask(() => {
          const failing = state.failWrites ||
            wanted.some((name) => state.failStore === name) ||
            doomed;
          if (failing && mode === "readwrite") tx.onabort?.();
          else tx.oncomplete?.();
        });
      };
      const blocked = (name) => state.failWrites || state.failStore === name;
      tx.objectStore = (name = wanted[0]) => ({
        get(key) {
          const req = {};
          queueMicrotask(() => { req.result = data.get(at(name, key)); req.onsuccess?.(); });
          // Drain after the handler runs, so a readwrite transaction whose only
          // request is this get still completes — and so a put issued from inside
          // onsuccess is applied before the completion fires.
          queueMicrotask(() => queueMicrotask(settle));
          return req;
        },
        getAll() {
          const req = {};
          queueMicrotask(() => {
            req.result = [...data.entries()]
              .filter(([held]) => held.startsWith(name + " :: "))
              .map(([, value]) => value);
            req.onsuccess?.();
          });
          return req;
        },
        put(value, key) {
          if (!blocked(name)) data.set(at(name, key), value);
          const req = {};
          queueMicrotask(() => req.onsuccess?.());
          settle();
          return req;
        },
        delete(key) {
          // A delete can fail where a small put still lands — a bulk delete and a
          // one-key marker are not the same transaction cost.
          if (state.failDelete) doomed = true;
          else if (!blocked(name)) data.delete(at(name, key));
          const req = {};
          queueMicrotask(() => req.onsuccess?.());
          settle();
          return req;
        },
        clear() {
          if (!blocked(name)) {
            for (const held of [...data.keys()]) {
              if (held.startsWith(name + " :: ")) data.delete(held);
            }
          }
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
    _state: state,
    /** Records in one store, as a Map of key -> value, for assertions. */
    _store(name) {
      const out = new Map();
      for (const [held, value] of data.entries()) {
        if (held.startsWith(name + " :: ")) out.set(held.slice((name + " :: ").length), value);
      }
      return out;
    },
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

  const durable = [...indexedDb._store(CHAT_HISTORY_LEGACY_STORE).keys()];
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
    indexedDb._store(CHAT_HISTORY_LEGACY_STORE).size,
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
  const storedFirst = indexedDb._store(CHAT_HISTORY_LEGACY_STORE).get("L0");
  assert.equal(storedFirst.msgs[0].text.length, 40);

  const edited = { ...original, updatedAt: 99, title: "renamed", msgs: [{ id: "L0-m", role: "user", text: "z".repeat(900) }] };
  store.persist([edited], {});
  await store._writePromise;
  const storedSecond = indexedDb._store(CHAT_HISTORY_LEGACY_STORE).get("L0");
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
    indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"),
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
  assert.equal(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).size, 2);

  store.persist([threads[1]], { deletedThreads: { L0: { updatedAt: 500, writerId: 'tab-x', sequence: 1 } } });
  await store._writePromise;
  assert.equal(
    indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"),
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
  assert.ok(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"));

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
  assert.equal(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).size, 2);

  await store.clearAll([], {});
  await store._writePromise;
  assert.equal(
    indexedDb._store(CHAT_HISTORY_LEGACY_STORE).size,
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
  assert.equal(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).get("L0").msgs[0].text, "foo");

  const after = { ...before, msgs: [{ id: "m", role: "user", text: "bar" }] };
  assert.equal(JSON.stringify(before).length, JSON.stringify(after).length, "precondition: same length");
  assert.equal(before.updatedAt, after.updatedAt, "precondition: same timestamp");
  store.persist([after], {});
  await store._writePromise;
  assert.equal(
    indexedDb._store(CHAT_HISTORY_LEGACY_STORE).get("L0").msgs[0].text,
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
  assert.equal(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).size, 3);

  store.persist([legacyThread("L0", 1), legacyThread("L2", 3)], {
    deletedThreads: { L1: { updatedAt: 500, writerId: "t", sequence: 1 } },
  });
  await store._writePromise;
  const keys = [...indexedDb._store(CHAT_HISTORY_LEGACY_STORE).keys()].sort();
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
    indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"),
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
  assert.ok(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"), "precondition: still there");

  // The tombstone is GONE from meta now — aged out of the capped map.
  indexedDb._state.failWrites = false;
  store.persist([legacyThread("L1", 2)], {});
  await store._writePromise;
  assert.equal(
    indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"),
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
      assert.equal(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).size, 0);
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
    indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"),
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
  assert.equal(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"), false, "A's delete landed");

  // A third tab must still inherit B's intent.
  const tabC = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  await tabC._restoreLegacyShadow({ threads: [], meta: {} });
  assert.ok(
    tabC._pendingLegacyDeletes.has("L1"),
    "another tab's outstanding delete must survive an unrelated tab's completion",
  );
});

test("a thread id can never collide with the pending-delete marker", async () => {
  // The marker used to sit beside the transcripts, in a key space addressed by THREAD
  // ID. Refusing to store a colliding thread guarded new writes and did nothing about
  // a database that already held one (codex r5). The marker now lives in `snapshots`,
  // keyed by fixed names, so the collision cannot arise in either direction — which is
  // a better answer than a guard covering one of them.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const collide = { ...legacyThread("x", 1), id: "__cmcp_legacy_pending_deletes" };
  store.persist([collide, legacyThread("L1", 2)], {});
  await store._writePromise;

  // It is just a transcript now, stored under its own id, with nothing to clobber.
  const legacy = indexedDb._store(CHAT_HISTORY_LEGACY_STORE);
  assert.ok(Array.isArray(legacy.get("__cmcp_legacy_pending_deletes")?.msgs));
  assert.ok(store._durableLegacy.has("__cmcp_legacy_pending_deletes"), "and it is durable like any other");

  // A marker write cannot reach it: different store.
  indexedDb._state.failDelete = true;
  store.persist([legacyThread("L1", 2)], {
    deletedThreads: { gone: { updatedAt: 5, writerId: "t", sequence: 1 } },
  });
  await store._writePromise;
  indexedDb._state.failDelete = false;
  assert.ok(
    Array.isArray(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).get("__cmcp_legacy_pending_deletes")?.msgs),
    "a marker write must not be able to overwrite a transcript",
  );
});

test("the marker never appears in the transcript store", () => {
  // The property the relocation buys, stated directly.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1), legacyThread("L1", 2)], {});
  return store._writePromise
    .then(() => {
      indexedDb._state.failDelete = true;
      store.persist([legacyThread("L1", 2)], {
        deletedThreads: { L0: { updatedAt: 5, writerId: "t", sequence: 1 } },
      });
      return store._writePromise;
    })
    .then(() => {
      indexedDb._state.failDelete = false;
      assert.ok(store._pendingLegacyDeletes.has("L0"), "precondition: an intent was recorded");
      assert.equal(
        indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("__cmcp_legacy_pending_deletes"),
        false,
        "the marker must not be in the transcript store",
      );
      assert.ok(
        indexedDb._store("snapshots").has("__cmcp_legacy_pending_deletes"),
        "…it must be in snapshots, whose keys are fixed names",
      );
    });
});

test("a legacy write with nothing to store returns [] — never true", async () => {
  // Callers do `new Set(written || [])`, and `new Set(true)` THROWS — in the UNCAUGHT
  // restore path. A list that filters down to nothing has to come back as an empty
  // list, not as a bare success.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  // A legacyShadow thread with no usable id is filtered out by the writer, leaving it
  // with nothing to write.
  const unusable = { ...legacyThread("u", 1), id: 42 };
  store.persist([unusable], {});
  await store._writePromise;
  const read = await store.readCanonical();
  assert.ok(read, "restoration must survive a write list that filtered down to nothing");
});

test("the marker is filtered structurally, not by key name", async () => {
  // One place decides what a transcript is: a record with a string `id`.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1)], {});
  await store._writePromise;
  // Any non-thread record, whatever its key, must not surface as history.
  indexedDb._store(CHAT_HISTORY_LEGACY_STORE).set("some-other-meta", { ids: ["z"] });
  const reader = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const restored = await reader._restoreLegacyShadow({ threads: [], meta: {} });
  assert.deepEqual((restored.threads || []).map((t) => t.id), ["L0"]);
});

test("a stale write cannot cancel another tab's outstanding delete", async () => {
  // codex r5. Tab B records a pending delete of L1 that has not landed. A third tab,
  // still holding L1 as live from before, writes it back — and the harm is not that
  // the record exists (B's delete never removed it) but that the write would refresh
  // it and hand out a receipt, leaving a record nobody is still trying to remove.
  // The legacy write reads the marker inside the SAME transaction as the put, so an
  // id with an outstanding delete is refused.
  const indexedDb = createFakeIndexedDb();
  const owing = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  owing.persist([legacyThread("L1", 1, 30), legacyThread("L2", 2)], {});
  await owing._writePromise;

  indexedDb._state.failDelete = true;
  owing.persist([legacyThread("L2", 2)], {
    deletedThreads: { L1: { updatedAt: 5, writerId: "b", sequence: 1 } },
  });
  await owing._writePromise;
  indexedDb._state.failDelete = false;
  assert.ok(owing._pendingLegacyDeletes.has("L1"), "precondition: a delete is owed");
  assert.ok(indexedDb._store("snapshots").has("__cmcp_legacy_pending_deletes"), "…recorded durably");

  // A stale tab writes an UPDATED L1 back.
  const stale = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const updated = { ...legacyThread("L1", 1, 900), title: "stale rewrite" };
  stale.persist([updated, legacyThread("L2", 2)], {});
  await stale._writePromise;

  const stored = indexedDb._store(CHAT_HISTORY_LEGACY_STORE).get("L1");
  assert.notEqual(stored?.title, "stale rewrite", "the refused write must not land");
  assert.equal(stale._durableLegacy.has("L1"), false, "…and must not earn a receipt");
  assert.ok(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L2"), "the refusal must be per-id");
  // The intent survives, so the delete is still owed and still retried.
  const next = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  await next._restoreLegacyShadow({ threads: [], meta: {} });
  assert.ok(next._pendingLegacyDeletes.has("L1"), "a stale write must not cancel the delete");
});

test("a refused write grants no receipt for the refused id", async () => {
  // Receipts come from what the writer actually stored. Granting one for a thread it
  // declined would license evicting it from the shadow — the licence-to-delete this
  // whole change exists to withhold.
  const indexedDb = createFakeIndexedDb();
  const owing = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  owing.persist([legacyThread("L1", 1)], {});
  await owing._writePromise;
  indexedDb._state.failDelete = true;
  owing.persist([], { deletedThreads: { L1: { updatedAt: 5, writerId: "b", sequence: 1 } } });
  await owing._writePromise;
  indexedDb._state.failDelete = false;

  const stale = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  stale.persist([legacyThread("L1", 1)], {});
  await stale._writePromise;
  assert.equal(stale._durableLegacy.has("L1"), false, "no receipt for a refused write");
});

test("a stale write AFTER a completed delete is still refused", async () => {
  // codex r6, and the finding that made this a fence rather than a hint. The delete
  // lands and its id used to be REMOVED from the marker — so a stale tab starting its
  // write afterwards saw nothing and put the record straight back.
  //
  // I assumed the canonical tombstone covered this and tested that assumption first:
  // it does not, and the reason is instructive. A legacyShadow thread is never IN
  // canonical, so compaction prunes a tombstone that points at no thread. There is no
  // fence for a legacy delete other than this one.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1), legacyThread("L1", 2)], {});
  await store._writePromise;

  store.persist([legacyThread("L1", 2)], {
    deletedThreads: { L0: { updatedAt: 500, writerId: "a", sequence: 1 } },
  });
  await store._writePromise;
  assert.equal(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"), false, "the delete landed");
  const record = indexedDb._store("snapshots").get("__cmcp_legacy_pending_deletes");
  assert.deepEqual(record?.pending, [], "nothing is owed any more");
  assert.deepEqual(record?.deleted, ["L0"], "…but the deletion is remembered for good");

  // A stale tab that still believes L0 is live, persisting after all of that.
  const stale = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  stale.persist([legacyThread("L0", 1), legacyThread("L1", 2)], {});
  await stale._writePromise;
  assert.equal(
    indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"),
    false,
    "a completed delete must fence a later stale write",
  );
  assert.equal(stale._durableLegacy.has("L0"), false, "and grant it no receipt");

  // …and it is not restored as live history either.
  const next = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const restored = await next._restoreLegacyShadow({ threads: [], meta: {} });
  assert.equal((restored.threads || []).some((t) => t.id === "L0"), false);
});

test("the permanent deleted list is bounded by what legacy threads ARE", () => {
  // A never-pruned list of deleted ids would be an unbounded growth path — the exact
  // shape of the bug this whole change fixes. It is bounded here by construction, not
  // by a cap: legacyShadow threads are pre-v3 content, quarantined once and never
  // created again, so the set of ids that can ever enter it is closed and finite.
  //
  // Pinned as a source fact, because the day something starts MINTING legacyShadow
  // threads this reasoning silently stops being true. Exactly two sites may apply the
  // flag, and only one of them can introduce an id that was not already legacy:
  const src = readFileSync(new URL("../../web/js/lib/chat-history-store.js", import.meta.url), "utf8");
  const sites = src.match(/legacyShadow: true/g) || [];
  assert.equal(sites.length, 2, "a third site applying this flag needs this reasoning re-checked");

  // 1. the quarantine in mergeUnderCanonicalCheckpoint — the ONE minter, and it can
  //    only flag threads that already exist in a pre-v3 snapshot.
  const quarantine = src.slice(src.indexOf("function mergeUnderCanonicalCheckpoint"), src.indexOf("function idbRead"));
  assert.ok(
    quarantine.includes("normalizeThread({ ...thread, legacyShadow: true })"),
    "the quarantine must be the minting site",
  );
  // 2. the restore, which RE-flags records read back out of the legacy store. It can
  //    never introduce a new id: everything it flags was already in that store.
  const restore = src.slice(src.indexOf("async _restoreLegacyShadow"), src.indexOf("async persist") + 1 || undefined);
  assert.ok(
    restore.includes("...thread, legacyShadow: true"),
    "the restore must only re-flag what the store already held",
  );
});

test("a record that got past the writer is still not restored once deleted for good", async () => {
  // Defence in depth, and it needed a case to be worth keeping. The writer refuses
  // ids in the deleted list, so nothing on the normal path can produce this — but a
  // database written by a build without that fence, or any other writer to the same
  // store, can. Then the record exists AND the id is deleted for good, and only the
  // restore filter stands between it and coming back as live history.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1), legacyThread("L1", 2)], {});
  await store._writePromise;
  store.persist([legacyThread("L1", 2)], {
    deletedThreads: { L0: { updatedAt: 500, writerId: "a", sequence: 1 } },
  });
  await store._writePromise;
  assert.deepEqual(
    indexedDb._store("snapshots").get("__cmcp_legacy_pending_deletes")?.deleted,
    ["L0"],
    "precondition: deleted for good",
  );

  // Put the record back the way a fence-less writer would have.
  const revived = legacyThread("L0", 1);
  const db = await new Promise((resolve) => {
    const req = indexedDb.open();
    req.onsuccess = () => resolve(req.result);
  });
  await new Promise((resolve) => {
    const tx = db.transaction(CHAT_HISTORY_LEGACY_STORE, "readwrite");
    tx.objectStore(CHAT_HISTORY_LEGACY_STORE).put(revived, "L0");
    tx.oncomplete = () => resolve();
  });
  assert.ok(indexedDb._store(CHAT_HISTORY_LEGACY_STORE).has("L0"), "precondition: the record is back");

  const next = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const restored = await next._restoreLegacyShadow({ threads: [], meta: {} });
  assert.equal(
    (restored.threads || []).some((t) => t.id === "L0"),
    false,
    "a transcript deleted for good must not return as live history",
  );
});

test("the fence exists BEFORE the record stops existing", async () => {
  // codex r7. A delete that succeeds on its first attempt was never in `pending`, so
  // between the record going away and the post-success write recording it as deleted
  // there was an interval with nothing to refuse a stale write. The intent is recorded
  // up front, which makes the gap impossible rather than short.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([legacyThread("L0", 1), legacyThread("L1", 2)], {});
  await store._writePromise;

  // Fail ONLY the record delete, so the run stops with the intent recorded and the
  // record still present — the state that must already be fenced.
  indexedDb._state.failDelete = true;
  store.persist([legacyThread("L1", 2)], {
    deletedThreads: { L0: { updatedAt: 500, writerId: "a", sequence: 1 } },
  });
  await store._writePromise;
  indexedDb._state.failDelete = false;
  const record = indexedDb._store("snapshots").get("__cmcp_legacy_pending_deletes");
  assert.deepEqual(record?.pending, ["L0"], "the intent is durable before the delete lands");

  // A stale tab writing in exactly that window is already refused.
  const stale = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const rewritten = { ...legacyThread("L0", 1), title: "stale" };
  stale.persist([rewritten, legacyThread("L1", 2)], {});
  await stale._writePromise;
  assert.notEqual(
    indexedDb._store(CHAT_HISTORY_LEGACY_STORE).get("L0")?.title,
    "stale",
    "the pre-delete window must already be fenced",
  );

  // The ORDER is the fix, and it is only observable DURING the operation — an
  // interval no fake can interleave into. Both orderings leave the same end state,
  // so a runtime assertion here cannot fail for the right reason. Pin the order at
  // source instead: the intent write must precede the record delete.
  const src = readFileSync(new URL("../../web/js/lib/chat-history-store.js", import.meta.url), "utf8");
  const site = src.slice(src.indexOf("if (tombstoned.length) {"), src.indexOf("// Mirror the intent into the store"));
  const intentAt = site.indexOf("idbMergeDeleteRecord(this.indexedDb, { pending: tombstoned })");
  const deleteAt = site.indexOf("idbDeleteLegacy(this.indexedDb, tombstoned)");
  assert.ok(intentAt > 0, "the intent must be recorded up front");
  assert.ok(deleteAt > 0, "…and the record deleted after");
  assert.ok(intentAt < deleteAt, "the fence must exist before the record does not");
});

// ── the recurrence: version payloads ride INSIDE the protected thread ──────
//
// #861 shipped the byte bound, and the symptom came back anyway: a long chat on a
// frequently edited graph captures a workflow version (up to 300KB of serialized
// graph) on every user turn, twenty per thread, INSIDE the thread record. The live
// thread is protected from eviction, so whole-thread eviction could never reclaim
// those bytes — the shadow grew past the budget again, and ComfyUI's saveDraft()
// failed again on the shared origin. The fix keeps the version LIST in the shadow
// but strips the restorable payload once canonical is PROVEN to hold it — the same
// receipt discipline as the legacy eviction, one level down.

const ordinaryThreadWithVersions = (id, ts, versionCount, payloadSize) => ({
  id,
  schemaVersion: CHAT_HISTORY_SCHEMA,
  ts,
  updatedAt: ts,
  msgs: [{ id: `${id}-m`, role: "user", text: "hi" }],
  workflowVersions: Object.fromEntries(
    Array.from({ length: versionCount }, (_, i) => [
      `hash-${id}-${i}`,
      {
        hash: `hash-${id}-${i}`,
        capturedAt: ts + i,
        nodeCount: i + 1,
        snapshot: { pad: "g".repeat(payloadSize) },
      },
    ]),
  ),
});

test("version payloads leave the shadow once canonical holds them — the list stays", async () => {
  const indexedDb = createFakeIndexedDb();
  const storage = createMemoryStorage();
  // Budget below the payload total: without the strip the thread could only be
  // evicted whole or written oversized — the two failures this test must NOT see.
  const store = new ChatHistoryStore({ storage, indexedDb, maxShadowBytes: 3000 });
  const thread = ordinaryThreadWithVersions("T0", 1, 6, 800);
  store.persist([thread], {});
  await store._writePromise;

  // Second persist: the canonical receipts now exist, so the shadow may shed payloads.
  store.persist([thread], {});
  await store._writePromise;

  const written = JSON.parse(storage.getItem("comfyui-mcp.panel.historySnapshot"));
  assert.ok(
    JSON.stringify(written).length <= 3000,
    "the shadow must respect the byte budget even with the live thread protected",
  );
  const shadowThread = (written.threads || []).find((t) => t.id === "T0");
  assert.ok(shadowThread, "the thread itself must stay in the shadow");
  const versions = Object.values(shadowThread.workflowVersions || {});
  assert.equal(versions.length, 6, "the version LIST survives the strip");
  for (const version of versions) {
    assert.equal(version.snapshot, undefined, "a canonical-durable payload leaves the shadow");
    assert.ok(version.hash && Number.isFinite(version.capturedAt), "the metadata stays");
  }
});

test("version payloads STAY in the shadow while canonical has not accepted them", async () => {
  // IndexedDB unavailable (private mode, blocked, quota): the shadow is the only
  // copy of those graphs, and stripping them would be the data-loss path this whole
  // change is built to avoid. Fail closed means the budget loses, not the data.
  const storage = createMemoryStorage();
  const store = new ChatHistoryStore({ storage, indexedDb: null, maxShadowBytes: 500 });
  store.persist([ordinaryThreadWithVersions("T0", 1, 4, 800)], {});
  await store._writePromise;
  const written = JSON.parse(storage.getItem("comfyui-mcp.panel.historySnapshot"));
  const versions = Object.values(written.threads[0].workflowVersions || {});
  assert.equal(versions.length, 4);
  for (const version of versions) {
    assert.ok(version.snapshot, "no receipt, no strip — the only copy keeps its payload");
  }
});

test("a stripped shadow cannot launder the payload out of canonical on reload", async () => {
  // The strip makes the shadow metadata-only for durable versions, and the shadow
  // merges AFTER canonical on every load. If the merge let a bare-metadata record
  // displace the payload-carrier for the same hash, one reload would demote the
  // in-memory copy, and the next persist would write that demotion INTO canonical —
  // the durable graph gone, silently, exactly the failure a receipt exists to prevent.
  const indexedDb = createFakeIndexedDb();
  const storage = createMemoryStorage();
  const writer = new ChatHistoryStore({ storage, indexedDb });
  const thread = ordinaryThreadWithVersions("T0", 1, 3, 200);
  writer.persist([thread], {});
  await writer._writePromise;
  writer.persist([thread], {});
  await writer._writePromise;
  const written = JSON.parse(storage.getItem("comfyui-mcp.panel.historySnapshot"));
  assert.ok(
    Object.values(written.threads[0].workflowVersions).every((v) => v.snapshot === undefined),
    "precondition: the shadow really is stripped",
  );

  const reader = new ChatHistoryStore({ storage, indexedDb });
  const read = await reader.readCanonical();
  const restored = (read?.threads || []).find((t) => t.id === "T0");
  assert.ok(restored, "the thread must reload");
  for (const [hash, version] of Object.entries(thread.workflowVersions)) {
    assert.deepEqual(
      restored.workflowVersions?.[hash]?.snapshot,
      version.snapshot,
      `canonical's payload for ${hash} must survive the merge with the stripped shadow`,
    );
  }
});

test("a metadata-only version never displaces the payload-carrier for the same hash", () => {
  // The merge guard on its own, both argument orders: the hash is content-addressed,
  // so a record without the graph must never win over the record that has it.
  const withPayload = {
    threads: [{
      id: "T",
      schemaVersion: CHAT_HISTORY_SCHEMA,
      ts: 1,
      updatedAt: 1,
      msgs: [],
      workflowVersions: { h: { hash: "h", capturedAt: 10, nodeCount: 3, snapshot: { nodes: [] } } },
    }],
    meta: {},
  };
  const strippedThread = {
    id: "T",
    schemaVersion: CHAT_HISTORY_SCHEMA,
    ts: 2,
    updatedAt: 2,
    msgs: [],
    workflowVersions: { h: { hash: "h", capturedAt: 10, nodeCount: 3 } },
  };
  const shadowLast = mergeHistorySnapshots(withPayload, { threads: [strippedThread], meta: {} });
  assert.deepEqual(
    shadowLast.threads[0].workflowVersions.h.snapshot,
    { nodes: [] },
    "a stripped shadow merged after canonical must not drop the payload",
  );
  const shadowFirst = mergeHistorySnapshots({ threads: [strippedThread], meta: {} }, withPayload);
  assert.deepEqual(
    shadowFirst.threads[0].workflowVersions.h.snapshot,
    { nodes: [] },
    "…and the payload obviously survives the canonical-last order too",
  );
});

// ── #1305: an already-full origin still cannot take ComfyUI's draft ─────────
//
// #861 bounded the snapshot. #1318 stripped version payloads so the bound can
// hold. The symptom came back on 0.14.44 anyway, because neither change
// reclaimed a PREVIOUSLY over-budget origin:
//
//   1. Browsers measure remaining quota BEFORE freeing the value being
//      replaced, so setItem of a smaller snapshot still throws.
//   2. The two-key shadow (threads + historyMeta) is a second full copy of
//      the same cache, so even a successful bound left ~3MB of a 5MB origin
//      in panel keys and Comfy.Workflow.DraftIndex.v2 had nothing left.
//
// Do not clear the origin. Only panel keys that IndexedDB already holds may
// move, and a failed draft probe is a recovery message — not a wipe.

const THREADS_KEY = "comfyui-mcp.panel.threads";
const META_KEY = "comfyui-mcp.panel.historyMeta";
const SNAPSHOT_KEY = CHAT_HISTORY_LOCAL_SNAPSHOT_KEY;

function createQuotaStorage(maxBytes) {
  const map = new Map();
  const used = () => {
    let n = 0;
    for (const value of map.values()) n += String(value).length;
    return n;
  };
  class QuotaExceededError extends Error {
    constructor() {
      super("The quota has been exceeded.");
      this.name = "QuotaExceededError";
      this.code = 22;
    }
  }
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      const next = String(value);
      // Chrome: remaining is checked BEFORE the old value is freed. A rewrite
      // of a smaller payload still throws when leftover headroom is smaller
      // than the new payload — the #1305 failure.
      if (used() + next.length > maxBytes) throw new QuotaExceededError();
      map.set(key, next);
    },
    removeItem: (key) => { map.delete(key); },
    _map: map,
    _used: used,
  };
}

const preV1157Thread = (id, ts, size) => ({
  id,
  ts,
  updatedAt: ts,
  msgs: [{ id: `${id}-m`, role: "user", text: "x".repeat(size) }],
});

test("writeLocalStorageItem shrinks a key the naive setItem cannot replace", () => {
  const storage = createQuotaStorage(1000);
  storage.setItem("k", "a".repeat(800));
  assert.throws(() => storage.setItem("k", "b".repeat(400)), { name: "QuotaExceededError" });
  assert.equal(writeLocalStorageItem(storage, "k", "b".repeat(400)), true);
  assert.equal(storage.getItem("k").length, 400);
});

test("an over-budget pre-0.11.57 shadow leaves room for Comfy.Workflow.DraftIndex.v2", async () => {
  // The upgrade state the issue names: a 0.11.56-or-older install wrote every
  // transcript into `threads` + `historyMeta`, no historySnapshot, no bound.
  // Origin ~5MB. Panel keys already ~3.6MB. ComfyUI then cannot persist the
  // draft index, and #861's post-bound setItem cannot replace the huge key.
  const quota = 5_000_000;
  const storage = createQuotaStorage(quota);
  const threads = Array.from({ length: 24 }, (_, i) => preV1157Thread(`old-${i}`, i + 1, 140_000));
  storage.setItem(THREADS_KEY, JSON.stringify(threads));
  storage.setItem(META_KEY, JSON.stringify({ updatedAt: 1 }));
  const foreign = { keep: true, pad: "c".repeat(200) };
  storage.setItem("Comfy.Workflow.OpenTabs", JSON.stringify(foreign));
  assert.equal(storage.getItem(SNAPSHOT_KEY), null, "precondition: pre-0.11.57 has no atomic snapshot");
  assert.ok(storage._used() > 3_000_000, "precondition: the origin is already over the panel budget");

  const indexedDb = createFakeIndexedDb();
  const failures = [];
  const store = new ChatHistoryStore({
    storage,
    indexedDb,
    maxShadowBytes: 1_500_000,
    onPersistenceError: (failure) => failures.push(failure),
  });
  const local = store.readLocal();
  store.persist(local.threads, local.meta);
  assert.equal(await store.flush(), true, "history must persist");
  assert.equal(store.lastDraftHeadroomOk, true, "the draft-index probe must succeed after reclaim");
  assert.ok(
    store.lastShadowBytes <= 1_500_000,
    `panel shadow still over budget: ${store.lastShadowBytes}`,
  );
  assert.deepEqual(
    JSON.parse(storage.getItem("Comfy.Workflow.OpenTabs")),
    foreign,
    "a non-panel origin key must not be rewritten",
  );

  const draft = JSON.stringify({
    version: 2,
    workflows: { wf: { modified: true, pad: "d".repeat(80_000) } },
  });
  storage.setItem(COMFY_DRAFT_INDEX_KEY, draft);
  assert.equal(storage.getItem(COMFY_DRAFT_INDEX_KEY), draft, "ComfyUI must be able to persist the draft index");

  const reader = new ChatHistoryStore({ storage, indexedDb });
  const read = await reader.readCanonical();
  const ids = new Set((read?.threads || []).map((t) => t.id));
  for (const thread of threads) {
    assert.ok(ids.has(thread.id), `${thread.id} must still be recoverable from IndexedDB`);
  }
  assert.equal(
    failures.some((f) => f.code === "history-draft-headroom-unavailable"),
    false,
    "a successful reclaim must not nag",
  );
});

test("without IndexedDB the over-budget shadow is not deleted to make room", async () => {
  const storage = createQuotaStorage(5_000_000);
  const threads = Array.from({ length: 10 }, (_, i) => preV1157Thread(`only-${i}`, i + 1, 80_000));
  storage.setItem(THREADS_KEY, JSON.stringify(threads));
  storage.setItem(META_KEY, JSON.stringify({}));
  const store = new ChatHistoryStore({ storage, indexedDb: null, maxShadowBytes: 1_500_000 });
  store.persist(threads, {});
  await store.flush();
  const kept = JSON.parse(storage.getItem(THREADS_KEY) || "[]");
  assert.equal(kept.length, 10, "an only-copy transcript must stay when nothing is durable");
});

test("a draft probe that still fails is reported, and foreign keys stay", async () => {
  // After the panel has done everything it is allowed to, some other occupant
  // of the origin can still leave no room. The recovery is a message, not a
  // wipe of site data.
  const storage = createQuotaStorage(2_000_000);
  const hog = "z".repeat(1_999_996);
  storage.setItem("other-extension.blob", hog);
  const indexedDb = createFakeIndexedDb();
  const failures = [];
  const store = new ChatHistoryStore({
    storage,
    indexedDb,
    maxShadowBytes: 50_000,
    onPersistenceError: (failure) => failures.push(failure),
  });
  store.persist([preV1157Thread("T0", 1, 40)], {});
  assert.equal(await store.flush(), true, "history itself persisted");
  assert.equal(store.lastDraftHeadroomOk, false);
  assert.ok(
    failures.some((f) => f.code === "history-draft-headroom-unavailable"),
    "the remaining failure must be named",
  );
  assert.equal(storage.getItem("other-extension.blob"), hog, "foreign origin data is not cleared");
  assert.equal(probeDraftIndexWrite(storage), false);
});

test("measurePanelShadowBytes sums only the keys it is given", () => {
  const storage = createMemoryStorage();
  storage.setItem(THREADS_KEY, "aaa");
  storage.setItem(META_KEY, "bb");
  storage.setItem("ignore-me", "cccccccc");
  assert.equal(measurePanelShadowBytes(storage, [THREADS_KEY, META_KEY]), 5);
});
