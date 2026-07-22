// Durable chat-history storage for the Agent Panel.
//
// IndexedDB is the canonical browser store. A small localStorage shadow remains
// for instant startup and backward compatibility with pre-v2 panel builds.

import { isThreadInScope } from "./workflow-chat-identity.js";
export { isThreadInScope };

export const CHAT_HISTORY_SCHEMA = 2;
export const CHAT_HISTORY_DB = "comfyui-mcp-panel-history";
export const CHAT_HISTORY_STATE_KEY = "state";
export const CHAT_HISTORY_LOCAL_SNAPSHOT_KEY = "comfyui-mcp.panel.historySnapshot";

const DEFAULT_THREADS_KEY = "comfyui-mcp.panel.threads";
const DEFAULT_META_KEY = "comfyui-mcp.panel.historyMeta";
const DEFAULT_MAX_THREADS = 500;
const DEFAULT_MAX_MESSAGES = 5000;
const LOCAL_SHADOW_THREADS = 20;
const LOCAL_SHADOW_MESSAGES = 200;
const IDB_OPEN_TIMEOUT_MS = 2000;

function finiteTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeMap() {
  return Object.create(null);
}

function mergeTimestampMaps(...maps) {
  const merged = safeMap();
  for (const map of maps) {
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map)) {
      const revision = finiteTs(value);
      if (typeof key !== "string" || !key || !revision) continue;
      merged[key] = Math.max(finiteTs(merged[key]), revision);
    }
  }
  return merged;
}

function normalizeMetadataOperation(operation, fallbackValue, fallbackUpdatedAt) {
  if (operation && typeof operation === "object" && !Array.isArray(operation)) {
    const updatedAt = finiteTs(operation.updatedAt);
    const deleted = operation.deleted;
    const coherent =
      deleted === true
        ? operation.value == null
        : deleted === false && operation.value != null;
    if (!updatedAt || !coherent) return null;
    return {
      value: deleted ? null : cloneJson(operation.value),
      deleted,
      updatedAt,
    };
  }
  const updatedAt = finiteTs(fallbackUpdatedAt);
  if (!updatedAt || fallbackValue == null) return null;
  return {
    value: cloneJson(fallbackValue),
    deleted: false,
    updatedAt,
  };
}

function normalizeMetadataOperations(operations, values, fallbackUpdatedAt) {
  const normalized = safeMap();
  const seen = new Set();
  if (operations && typeof operations === "object" && !Array.isArray(operations)) {
    for (const [key, operation] of Object.entries(operations)) {
      if (typeof key !== "string" || !key) continue;
      seen.add(key);
      const valid = normalizeMetadataOperation(operation, null, fallbackUpdatedAt);
      if (valid) normalized[key] = valid;
    }
  }
  if (values && typeof values === "object" && !Array.isArray(values)) {
    for (const [key, value] of Object.entries(values)) {
      if (typeof key !== "string" || !key || seen.has(key)) continue;
      const valid = normalizeMetadataOperation(null, value, fallbackUpdatedAt);
      if (valid) normalized[key] = valid;
    }
  }
  return normalized;
}

function mergeMetadataOperationMaps(current, incoming) {
  const merged = safeMap();
  for (const [key, operation] of Object.entries(current || {})) merged[key] = operation;
  for (const [key, operation] of Object.entries(incoming || {})) {
    const previous = merged[key];
    const previousAt = finiteTs(previous?.updatedAt);
    const incomingAt = finiteTs(operation?.updatedAt);
    // Deletion wins an exact-time tie so a concurrent stale value cannot revive
    // a pointer/alias merely because two tabs happened to mutate in one clock tick.
    if (
      !previous ||
      incomingAt > previousAt ||
      (incomingAt === previousAt && (operation.deleted === true || previous.deleted !== true))
    ) {
      merged[key] = operation;
    }
  }
  return merged;
}

function materializeMetadataOperations(operations) {
  const values = safeMap();
  for (const [key, operation] of Object.entries(operations || {})) {
    if (operation?.deleted !== true && operation?.value != null) values[key] = operation.value;
  }
  return values;
}

/** Return metadata with a versioned set/delete operation for one keyed value. */
export function updateMetadataEntry(meta, mapName, key, value, updatedAt = Date.now()) {
  const opsName = mapName === "activeByScope"
    ? "activeOps"
    : mapName === "workflowAliases"
      ? "aliasOps"
      : null;
  if (!opsName || typeof key !== "string" || !key) return meta;
  const revision = finiteTs(updatedAt) || Date.now();
  const values = safeMap();
  for (const [existingKey, existingValue] of Object.entries(meta?.[mapName] || {})) {
    values[existingKey] = existingValue;
  }
  const deleted = value == null;
  if (deleted) delete values[key];
  else values[key] = value;
  return {
    ...(meta && typeof meta === "object" ? meta : {}),
    updatedAt: Math.max(finiteTs(meta?.updatedAt), revision),
    [mapName]: values,
    [opsName]: Object.assign(safeMap(), meta?.[opsName] || {}, {
      [key]: { value: deleted ? null : value, deleted, updatedAt: revision },
    }),
  };
}

export function normalizeThread(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
  const deletedMessages = mergeTimestampMaps(raw.deletedMessages);
  const msgs = Array.isArray(raw.msgs)
    ? raw.msgs.filter(
      (message) =>
        message &&
        typeof message === "object" &&
        !(typeof message.id === "string" && Object.hasOwn(deletedMessages, message.id)),
    )
    : [];
  const ts = finiteTs(raw.ts) || finiteTs(raw.createdAt) || Date.now();
  const createdAt = finiteTs(raw.createdAt) || ts;
  const updatedAt = finiteTs(raw.updatedAt) || ts;
  return {
    ...raw,
    id: raw.id,
    schemaVersion: CHAT_HISTORY_SCHEMA,
    createdAt,
    updatedAt,
    ts: updatedAt,
    msgs,
    deletedMessages,
    pinned: raw.pinned === true,
    title: typeof raw.title === "string" ? raw.title.slice(0, 160) : undefined,
    workflowKey: typeof raw.workflowKey === "string" ? raw.workflowKey : "panel:global",
    workflowTitle: typeof raw.workflowTitle === "string" ? raw.workflowTitle.slice(0, 240) : undefined,
    provider: typeof raw.provider === "string" ? raw.provider : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    effort: typeof raw.effort === "string" ? raw.effort : undefined,
  };
}

export function selectThreadForScope(threads, meta, scopeKey) {
  const candidates = (Array.isArray(threads) ? threads : [])
    .filter((thread) => isThreadInScope(thread, scopeKey))
    .sort((a, b) => finiteTs(b.updatedAt || b.ts) - finiteTs(a.updatedAt || a.ts));
  const activeId = meta?.activeByScope?.[scopeKey];
  if (!activeId && meta?.activeOps?.[scopeKey]?.deleted === true) return null;
  return candidates.find((thread) => thread.id === activeId) || candidates[0] || null;
}

/** Select the panel-owned conversation without changing its workflowKey. The
 *  global id lives only in metadata; each thread keeps its ride-along workflow
 *  provenance for archive grouping. Legacy snapshots without that pointer
 *  recover the most recently updated conversation. */
export function selectPanelThread(threads, meta) {
  const candidates = [...(Array.isArray(threads) ? threads : [])]
    .sort((a, b) => finiteTs(b?.updatedAt || b?.ts) - finiteTs(a?.updatedAt || a?.ts));
  const activeId = meta?.activeByScope?.["panel:global"];
  if (!activeId && meta?.activeOps?.["panel:global"]?.deleted === true) return null;
  return candidates.find((thread) => thread?.id === activeId) || candidates[0] || null;
}

/** Choose the durable conversation for reload without replacing a conversation
 * already selected by this browser tab. In per-workflow mode that preferred
 * pointer is still subject to the strict workflow scope guard. */
export function selectRestoreThread(
  threads,
  meta,
  { panelOwned = true, scopeKey = null, preferredThreadId = null } = {},
) {
  const preferred = preferredThreadId
    ? (Array.isArray(threads) ? threads : []).find((candidate) => candidate?.id === preferredThreadId)
    : null;
  if (preferred && (panelOwned || isThreadInScope(preferred, scopeKey))) return preferred;
  return panelOwned
    ? selectPanelThread(threads, meta)
    : selectThreadForScope(threads, meta, scopeKey);
}

/** Apply a strict recency cap without evicting conversations that are still
 * bound to a browser tab or durable active-scope pointer. Protected ids are
 * ordered by priority; remaining capacity is filled with the newest threads. */
export function retainBoundedThreads(threads, limit, protectedThreadIds = []) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!max) return [];
  const ordered = [...(Array.isArray(threads) ? threads : [])]
    .filter((candidate) => candidate && typeof candidate.id === "string" && candidate.id)
    .sort((a, b) => finiteTs(a.updatedAt || a.ts) - finiteTs(b.updatedAt || b.ts));
  if (ordered.length <= max) return ordered;

  const available = new Set(ordered.map((candidate) => candidate.id));
  const protectedIds = [];
  const protectedSet = new Set();
  for (const id of Array.isArray(protectedThreadIds) ? protectedThreadIds : []) {
    if (typeof id !== "string" || !id || !available.has(id) || protectedSet.has(id)) continue;
    protectedIds.push(id);
    protectedSet.add(id);
    if (protectedIds.length === max) break;
  }

  const remaining = max - protectedIds.length;
  const newestIds = remaining
    ? ordered
      .filter((candidate) => !protectedSet.has(candidate.id))
      .slice(-remaining)
      .map((candidate) => candidate.id)
    : [];
  const keptIds = new Set([...protectedIds, ...newestIds]);
  return ordered.filter((candidate) => keptIds.has(candidate.id));
}

function mergeThreadMessages(older, newer) {
  const oldMessages = Array.isArray(older?.msgs) ? older.msgs : [];
  const newMessages = Array.isArray(newer?.msgs) ? newer.msgs : [];
  // Schema-v2 messages carry UUIDs. Unioning them makes append-only chat writes
  // safe when two tabs persist the same workflow between each other's reads.
  // Legacy messages had no ids, so retain the historical newest-snapshot rule
  // rather than guessing whether equal-looking entries are duplicates.
  const identified = [...oldMessages, ...newMessages].every(
    (message) => message && typeof message.id === "string" && message.id,
  );
  if (!identified) return newMessages;
  const byId = new Map();
  for (const message of [...oldMessages, ...newMessages]) {
    const previous = byId.get(message.id);
    if (!previous || finiteTs(message.updatedAt || message.createdAt) >= finiteTs(previous.updatedAt || previous.createdAt)) {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort(
    (a, b) => finiteTs(a.createdAt || a.ts) - finiteTs(b.createdAt || b.ts),
  );
}

/** Merge snapshots by thread id; the newest record wins without dropping fields
 *  added by an older copy (useful while migrating localStorage -> IndexedDB). */
export function mergeHistorySnapshots(...snapshots) {
  const byId = new Map();
  let meta = {};
  let activeOps = {};
  let aliasOps = {};
  let deletedThreads = {};
  let metaUpdatedAt = 0;
  let snapshotUpdatedAt = 0;
  for (const snap of snapshots) {
    if (!snap || typeof snap !== "object") continue;
    const incomingUpdatedAt = Math.max(finiteTs(snap.updatedAt), finiteTs(snap.meta?.updatedAt));
    snapshotUpdatedAt = Math.max(snapshotUpdatedAt, incomingUpdatedAt);
    if (snap.meta && typeof snap.meta === "object") {
      const incomingNewer = incomingUpdatedAt >= metaUpdatedAt;
      const older = incomingNewer ? meta : snap.meta;
      const newer = incomingNewer ? snap.meta : meta;
      meta = {
        ...older,
        ...newer,
      };
      activeOps = mergeMetadataOperationMaps(
        activeOps,
        normalizeMetadataOperations(snap.meta.activeOps, snap.meta.activeByScope, incomingUpdatedAt || 1),
      );
      aliasOps = mergeMetadataOperationMaps(
        aliasOps,
        normalizeMetadataOperations(snap.meta.aliasOps, snap.meta.workflowAliases, incomingUpdatedAt || 1),
      );
      deletedThreads = mergeTimestampMaps(deletedThreads, snap.meta.deletedThreads);
      metaUpdatedAt = Math.max(metaUpdatedAt, incomingUpdatedAt);
    }
    for (const candidate of Array.isArray(snap.threads) ? snap.threads : []) {
      const next = normalizeThread(candidate);
      if (!next) continue;
      const prev = byId.get(next.id);
      if (!prev) {
        byId.set(next.id, next);
        continue;
      }
      const newer = finiteTs(next.updatedAt) >= finiteTs(prev.updatedAt) ? next : prev;
      const older = newer === next ? prev : next;
      const overlay = Object.fromEntries(
        Object.entries(newer).filter(([, value]) => value !== undefined),
      );
      // normalizeThread supplies compatibility defaults for standalone legacy
      // records. During a partial merge those defaults must not erase richer
      // metadata already present in the older snapshot.
      if (newer === next && !Object.hasOwn(candidate, "workflowKey")) delete overlay.workflowKey;
      if (newer === next && !Object.hasOwn(candidate, "pinned")) delete overlay.pinned;
      const deletedMessages = mergeTimestampMaps(older.deletedMessages, newer.deletedMessages);
      const msgs = mergeThreadMessages(older, newer)
        .filter(
          (message) =>
            !(typeof message?.id === "string" && Object.hasOwn(deletedMessages, message.id)),
        );
      byId.set(next.id, { ...older, ...overlay, msgs, deletedMessages });
    }
  }
  const threads = [...byId.values()]
    .filter((thread) => !Object.hasOwn(deletedThreads, thread.id))
    .sort((a, b) => finiteTs(a.updatedAt) - finiteTs(b.updatedAt));
  const newestThreadAt = threads.reduce((max, thread) => Math.max(max, finiteTs(thread.updatedAt)), 0);
  return {
    schemaVersion: CHAT_HISTORY_SCHEMA,
    updatedAt: Math.max(snapshotUpdatedAt, newestThreadAt) || Date.now(),
    threads,
    meta: {
      activeByScope: {},
      workflowAliases: {},
      deletedThreads: {},
      ...meta,
      updatedAt: metaUpdatedAt,
      activeOps,
      aliasOps,
      activeByScope: materializeMetadataOperations(activeOps),
      workflowAliases: materializeMetadataOperations(aliasOps),
      deletedThreads,
    },
  };
}

function boundedSnapshot(snapshot, { maxThreads, maxMessages, protectedThreadIds = [] }) {
  const activeThreadIds = Object.values(snapshot?.meta?.activeByScope || {})
    .filter((id) => typeof id === "string" && id);
  const boundedThreads = retainBoundedThreads(
    snapshot?.threads,
    maxThreads,
    [...protectedThreadIds, ...activeThreadIds],
  );
  const messageLimit = Math.max(0, Math.floor(Number(maxMessages) || 0));
  return {
    ...snapshot,
    threads: boundedThreads.map((thread) => ({
      ...thread,
      msgs: messageLimit ? thread.msgs.slice(-messageLimit) : [],
    })),
  };
}

function openDb(indexedDb) {
  if (!indexedDb || typeof indexedDb.open !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    let settled = false;
    let timeout = null;
    const finish = (db) => {
      if (settled) {
        db?.close?.();
        return;
      }
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(db);
    };
    try {
      request = indexedDb.open(CHAT_HISTORY_DB, CHAT_HISTORY_SCHEMA);
    } catch {
      finish(null);
      return;
    }
    // The schema number is also the IndexedDB version: every future bump fires
    // this callback. Structural store/index migrations belong here; record-shape
    // migration remains app-layer normalization in mergeHistorySnapshots().
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots");
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish(null);
    // A blocked upgrade may still succeed after another tab closes its older
    // connection. Keep waiting; if it outlives the bound below, late success is
    // closed by finish() instead of leaking an unowned IDBDatabase.
    request.onblocked = () => {};
    timeout = setTimeout(() => finish(null), IDB_OPEN_TIMEOUT_MS);
  });
}

async function idbRead(indexedDb) {
  const db = await openDb(indexedDb);
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const tx = db.transaction("snapshots", "readonly");
      const req = tx.objectStore("snapshots").get(CHAT_HISTORY_STATE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

async function idbMergeWrite(indexedDb, snapshot, limits) {
  const db = await openDb(indexedDb);
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const tx = db.transaction("snapshots", "readwrite");
      const store = tx.objectStore("snapshots");
      const get = store.get(CHAT_HISTORY_STATE_KEY);
      let merged = boundedSnapshot(snapshot, limits);
      get.onsuccess = () => {
        merged = boundedSnapshot(mergeHistorySnapshots(get.result, snapshot), limits);
        store.put(merged, CHAT_HISTORY_STATE_KEY);
      };
      get.onerror = () => store.put(merged, CHAT_HISTORY_STATE_KEY);
      tx.oncomplete = () => resolve(merged);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

export class ChatHistoryStore {
  constructor(options = {}) {
    this.storage = options.storage ?? globalThis.localStorage;
    this.indexedDb = options.indexedDb ?? globalThis.indexedDB;
    this.threadsKey = options.threadsKey ?? DEFAULT_THREADS_KEY;
    this.metaKey = options.metaKey ?? DEFAULT_META_KEY;
    this.snapshotKey = options.snapshotKey ?? CHAT_HISTORY_LOCAL_SNAPSHOT_KEY;
    this.maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this._writePromise = Promise.resolve(null);
    this._lastCommitted = null;
  }

  readLocal() {
    const readJson = (key, fallback) => {
      try {
        const raw = this.storage?.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    };
    const atomic = readJson(this.snapshotKey, null);
    // Migrate legacy two-key shadows defensively: one corrupt half must not
    // discard the other valid half.
    const legacyThreads = readJson(this.threadsKey, []);
    const legacyMeta = readJson(this.metaKey, {});
    const atomicObject = atomic && typeof atomic === "object" ? atomic : null;
    const threads = Array.isArray(atomicObject?.threads)
      ? atomicObject.threads
      : legacyThreads;
    const meta = atomicObject?.meta && typeof atomicObject.meta === "object"
      ? atomicObject.meta
      : legacyMeta;
    try {
      return mergeHistorySnapshots({ threads: Array.isArray(threads) ? threads : [], meta });
    } catch {
      return mergeHistorySnapshots({ threads: [], meta: {} });
    }
  }

  async load(options = {}) {
    const local = this.readLocal();
    const indexed = await idbRead(this.indexedDb);
    const merged = mergeHistorySnapshots(local, indexed);
    // Migration is automatic: once loaded, the full merged set is promoted to
    // IndexedDB while a small legacy shadow remains for older panel builds.
    this.persist(merged.threads, merged.meta, options);
    return merged;
  }

  persist(threads, meta = {}, options = {}) {
    const snapshot = mergeHistorySnapshots({ threads, meta });
    const protectedThreadIds = [
      ...(Array.isArray(options.protectedThreadIds) ? options.protectedThreadIds : []),
      ...Object.values(snapshot.meta.activeByScope || {}),
    ];
    const limits = {
      maxThreads: options.maxThreads ?? this.maxThreads,
      maxMessages: options.maxMessages ?? this.maxMessages,
      protectedThreadIds,
    };
    const shadow = retainBoundedThreads(
      snapshot.threads,
      LOCAL_SHADOW_THREADS,
      protectedThreadIds,
    )
      .map((thread) => ({ ...thread, msgs: thread.msgs.slice(-LOCAL_SHADOW_MESSAGES) }));
    const localSnapshot = { ...snapshot, threads: shadow };
    let atomicWritten = false;
    try {
      this.storage?.setItem(this.snapshotKey, JSON.stringify(localSnapshot));
      atomicWritten = true;
    } catch {
      // IndexedDB remains canonical when localStorage is unavailable or full.
    }
    if (atomicWritten) {
      // Keep the pre-v2 keys as best-effort compatibility mirrors. Current code
      // always reads the atomic snapshot first, so a partial legacy write cannot
      // create a mixed generation for this implementation.
      try {
        this.storage?.setItem(this.threadsKey, JSON.stringify(shadow));
      } catch {
        // The atomic shadow is already committed.
      }
      try {
        this.storage?.setItem(this.metaKey, JSON.stringify(snapshot.meta));
      } catch {
        // The atomic shadow is already committed.
      }
    }
    // Start the atomic merge immediately. Chat records are low-frequency and a
    // debounce creates an avoidable shutdown window in which the local shadow
    // exists but IndexedDB has not started its transaction yet.
    this._writePromise = this._writePromise
      .catch(() => null)
      .then(() => idbMergeWrite(this.indexedDb, snapshot, limits))
      .then((merged) => {
        if (merged) this._lastCommitted = merged;
        return merged;
      });
    return snapshot;
  }

  /** Watch the localStorage compatibility shadow. Browsers fire `storage` only
   *  in the other tabs, making it a cheap cross-tab invalidation channel while
   *  IndexedDB remains the full, atomically merged source of truth. */
  subscribe(listener, eventTarget = globalThis) {
    if (!eventTarget?.addEventListener || typeof listener !== "function") return () => {};
    const onStorage = (event) => {
      if (
        event?.key !== this.snapshotKey &&
        event?.key !== this.threadsKey &&
        event?.key !== this.metaKey
      ) return;
      listener(this.readLocal());
    };
    eventTarget.addEventListener("storage", onStorage);
    return () => eventTarget.removeEventListener?.("storage", onStorage);
  }

  async flush() {
    await this._writePromise.catch(() => null);
    return true;
  }

}
