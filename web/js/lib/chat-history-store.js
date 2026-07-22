// Durable chat-history storage for the Agent Panel.
//
// IndexedDB is the canonical browser store. A small localStorage shadow remains
// for instant startup and backward compatibility with pre-v2 panel builds.

import { isThreadInScope } from "./workflow-chat-identity.js";
export { isThreadInScope };

export const CHAT_HISTORY_SCHEMA = 2;
export const CHAT_HISTORY_DB = "comfyui-mcp-panel-history";
export const CHAT_HISTORY_STATE_KEY = "state";

const DEFAULT_THREADS_KEY = "comfyui-mcp.panel.threads";
const DEFAULT_META_KEY = "comfyui-mcp.panel.historyMeta";
const LOCAL_SHADOW_THREADS = 20;
const LOCAL_SHADOW_MESSAGES = 200;

function finiteTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeTimestampMaps(...maps) {
  const merged = {};
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    for (const [key, value] of Object.entries(map)) {
      merged[key] = Math.max(finiteTs(merged[key]), finiteTs(value));
    }
  }
  return merged;
}

export function normalizeThread(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
  const msgs = Array.isArray(raw.msgs) ? raw.msgs.filter((m) => m && typeof m === "object") : [];
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
        activeByScope: {
          ...(older.activeByScope && typeof older.activeByScope === "object" ? older.activeByScope : {}),
          ...(newer.activeByScope && typeof newer.activeByScope === "object" ? newer.activeByScope : {}),
        },
        // Aliases are additive; a newer path entry naturally wins on collision.
        workflowAliases: {
          ...(older.workflowAliases && typeof older.workflowAliases === "object" ? older.workflowAliases : {}),
          ...(newer.workflowAliases && typeof newer.workflowAliases === "object" ? newer.workflowAliases : {}),
        },
        deletedThreads: {
          ...mergeTimestampMaps(older.deletedThreads, newer.deletedThreads),
        },
      };
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
      byId.set(next.id, { ...older, ...overlay, msgs: mergeThreadMessages(older, newer) });
    }
  }
  const deletedThreads =
    meta.deletedThreads && typeof meta.deletedThreads === "object" ? meta.deletedThreads : {};
  const threads = [...byId.values()]
    .filter((thread) => finiteTs(deletedThreads[thread.id]) < finiteTs(thread.updatedAt || thread.ts))
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
      activeByScope:
        meta.activeByScope && typeof meta.activeByScope === "object" ? meta.activeByScope : {},
      workflowAliases:
        meta.workflowAliases && typeof meta.workflowAliases === "object" ? meta.workflowAliases : {},
      deletedThreads,
    },
  };
}

function openDb(indexedDb) {
  if (!indexedDb || typeof indexedDb.open !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDb.open(CHAT_HISTORY_DB, CHAT_HISTORY_SCHEMA);
    } catch {
      resolve(null);
      return;
    }
    // The schema number is also the IndexedDB version: every future bump fires
    // this callback. Structural store/index migrations belong here; record-shape
    // migration remains app-layer normalization in mergeHistorySnapshots().
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
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

async function idbMergeWrite(indexedDb, snapshot) {
  const db = await openDb(indexedDb);
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const tx = db.transaction("snapshots", "readwrite");
      const store = tx.objectStore("snapshots");
      const get = store.get(CHAT_HISTORY_STATE_KEY);
      let merged = snapshot;
      get.onsuccess = () => {
        merged = mergeHistorySnapshots(get.result, snapshot);
        store.put(merged, CHAT_HISTORY_STATE_KEY);
      };
      get.onerror = () => store.put(snapshot, CHAT_HISTORY_STATE_KEY);
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
    this._writePromise = Promise.resolve(null);
    this._lastCommitted = null;
  }

  readLocal() {
    try {
      const threads = JSON.parse(this.storage?.getItem(this.threadsKey) ?? "[]");
      const meta = JSON.parse(this.storage?.getItem(this.metaKey) ?? "{}");
      return mergeHistorySnapshots({ threads: Array.isArray(threads) ? threads : [], meta });
    } catch {
      return mergeHistorySnapshots({ threads: [], meta: {} });
    }
  }

  async load() {
    const local = this.readLocal();
    const indexed = await idbRead(this.indexedDb);
    const merged = mergeHistorySnapshots(local, indexed);
    // Migration is automatic: once loaded, the full merged set is promoted to
    // IndexedDB while a small legacy shadow remains for older panel builds.
    this.persist(merged.threads, merged.meta);
    return merged;
  }

  persist(threads, meta = {}) {
    const snapshot = mergeHistorySnapshots({ threads, meta });
    try {
      const shadow = snapshot.threads
        .slice(-LOCAL_SHADOW_THREADS)
        .map((t) => ({ ...t, msgs: t.msgs.slice(-LOCAL_SHADOW_MESSAGES) }));
      this.storage?.setItem(this.threadsKey, JSON.stringify(shadow));
      this.storage?.setItem(this.metaKey, JSON.stringify(snapshot.meta));
    } catch {
      // IndexedDB remains canonical when localStorage is unavailable or full.
    }
    // Start the atomic merge immediately. Chat records are low-frequency and a
    // debounce creates an avoidable shutdown window in which the local shadow
    // exists but IndexedDB has not started its transaction yet.
    this._writePromise = this._writePromise
      .catch(() => null)
      .then(() => idbMergeWrite(this.indexedDb, snapshot))
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
      if (event?.key !== this.threadsKey && event?.key !== this.metaKey) return;
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
