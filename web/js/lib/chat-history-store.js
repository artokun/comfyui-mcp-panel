// Durable chat-history storage for the Agent Panel.
//
// IndexedDB is the canonical browser store. A small localStorage shadow remains
// for instant startup and backward compatibility with pre-v2 panel builds.

import { isThreadInScope } from "./workflow-chat-identity.js";
export { isThreadInScope };

export const CHAT_HISTORY_SCHEMA = 3;
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
const DEFAULT_MAX_TOMBSTONES = 512;
const DEFAULT_MAX_METADATA_OPS = 512;
const BROADCAST_CHANNEL_NAME = "comfyui-mcp-panel-history-v3";
const LEGACY_IDLESS_SOURCE = Symbol("legacy-idless-source");
const THREAD_FIELDS = [
  "sessionId",
  "todos",
  "workflowKey",
  "workflowTitle",
  "provider",
  "model",
  "effort",
  "pinned",
  "title",
];
const INVALID_FIELD_VALUE = Symbol("invalid-thread-field-value");
const THREAD_STRING_LIMITS = {
  sessionId: 512,
  workflowKey: 512,
  workflowTitle: 240,
  provider: 80,
  model: 200,
  effort: 40,
  title: 160,
};
const MAX_TODOS = 100;
const MAX_TODO_TEXT = 2000;

function finiteTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasIdlessMessages(threads) {
  return (Array.isArray(threads) ? threads : []).some((thread) =>
    (Array.isArray(thread?.msgs) ? thread.msgs : []).some((message) =>
      !message || typeof message.id !== "string" || !message.id));
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function stableHash(value) {
  const input = String(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
}

function normalizeRevision(value, fallbackUpdatedAt = 0, fallbackWriterId = "legacy", fallbackSequence = 0) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value.revision && typeof value.revision === "object" ? value.revision : value)
    : null;
  const updatedAt = finiteTs(source?.updatedAt) || finiteTs(fallbackUpdatedAt);
  if (!updatedAt) return null;
  const writerId = typeof source?.writerId === "string" && source.writerId
    ? source.writerId
    : fallbackWriterId;
  const sequenceValue = Number(source?.sequence ?? fallbackSequence);
  const sequence = Number.isSafeInteger(sequenceValue) && sequenceValue >= 0 ? sequenceValue : 0;
  return { updatedAt, writerId, sequence };
}

function compareRevisions(left, right) {
  const a = normalizeRevision(left);
  const b = normalizeRevision(right);
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  if (a.writerId !== b.writerId) return a.writerId < b.writerId ? -1 : 1;
  if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
  return 0;
}

function legacyRevision(value, updatedAt) {
  return normalizeRevision(null, updatedAt || 1, `legacy-${stableHash(canonicalJson(value))}`, 0);
}

function normalizeMessage(message, threadId, ordinal) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const id = typeof message.id === "string" && message.id
    ? message.id
    : `legacy-${stableHash(`${threadId}:${ordinal}:${canonicalJson(message)}`)}`;
  const createdAt = finiteTs(message.createdAt) || finiteTs(message.ts) || 1;
  const updatedAt = finiteTs(message.updatedAt) || createdAt;
  const revision = normalizeRevision(
    message.revision || message,
    updatedAt,
    `legacy-${stableHash(`${threadId}:${id}:${canonicalJson(message)}`)}`,
  );
  const createdRevision = normalizeRevision(
    message.createdRevision,
    createdAt,
    `created-${stableHash(`${threadId}:${id}`)}`,
  );
  return { ...message, id, createdAt, updatedAt, revision, createdRevision };
}

function normalizeMessages(threadId, messages) {
  const normalized = [];
  for (const [ordinal, message] of (Array.isArray(messages) ? messages : []).entries()) {
    const next = normalizeMessage(message, threadId, ordinal);
    if (next) normalized.push(next);
  }
  return normalized;
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

function normalizeExplicitRevision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const updatedAt = finiteTs(value.updatedAt);
  const writerId = typeof value.writerId === "string" ? value.writerId.trim() : "";
  const sequence = Number(value.sequence);
  if (
    !updatedAt || !writerId || writerId.length > 200 ||
    !Number.isSafeInteger(sequence) || sequence < 0
  ) return null;
  return { updatedAt, writerId, sequence };
}

function normalizeThreadFieldValue(field, value) {
  if (value == null) return null;
  if (field === "pinned") return typeof value === "boolean" ? value : INVALID_FIELD_VALUE;
  if (field === "todos") {
    if (!Array.isArray(value)) return INVALID_FIELD_VALUE;
    const todos = [];
    for (const item of value.slice(0, MAX_TODOS)) {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.text !== "string") continue;
      const status = item.status === "active" || item.status === "done" ? item.status : "pending";
      todos.push({ text: item.text.slice(0, MAX_TODO_TEXT), status });
    }
    return todos;
  }
  const limit = THREAD_STRING_LIMITS[field];
  if (limit) return typeof value === "string" ? value.slice(0, limit) : INVALID_FIELD_VALUE;
  return INVALID_FIELD_VALUE;
}

function normalizeThreadDeletion(operation) {
  const legacyAt = finiteTs(operation);
  if (legacyAt) {
    const revision = legacyRevision(null, legacyAt);
    return { value: null, deleted: true, updatedAt: revision.updatedAt, revision };
  }
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
  const normalized = operation.deleted === true
    ? normalizeMetadataOperation(operation, null, 0)
    : null;
  if (normalized?.deleted === true) return normalized;
  // Schema-3 builds briefly wrote a bare causal revision here. Accept that
  // transitional shape, but always materialize the canonical delete operation.
  const revision = normalizeRevision(operation);
  return revision
    ? { value: null, deleted: true, updatedAt: revision.updatedAt, revision }
    : null;
}

function mergeThreadDeletionMaps(...maps) {
  const merged = safeMap();
  for (const map of maps) {
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map)) {
      if (typeof key !== "string" || !key) continue;
      const operation = normalizeThreadDeletion(value);
      if (!operation) continue;
      if (!merged[key] || compareRevisions(operation.revision, merged[key].revision) > 0) {
        merged[key] = operation;
      }
    }
  }
  return merged;
}

function normalizeMetadataOperation(operation, fallbackValue, fallbackUpdatedAt) {
  if (operation && typeof operation === "object" && !Array.isArray(operation)) {
    const hasExplicitRevision = Object.hasOwn(operation, "revision");
    const revision = hasExplicitRevision
      ? normalizeExplicitRevision(operation.revision)
      : legacyRevision(operation.value, finiteTs(operation.updatedAt));
    const deleted = operation.deleted;
    const coherent =
      deleted === true
        ? operation.value == null
        : deleted === false && operation.value != null;
    if (!revision || !coherent) return null;
    return {
      value: deleted ? null : cloneJson(operation.value),
      deleted,
      updatedAt: revision.updatedAt,
      revision,
    };
  }
  const updatedAt = finiteTs(fallbackUpdatedAt);
  if (!updatedAt || fallbackValue == null) return null;
  const revision = legacyRevision(fallbackValue, updatedAt);
  return {
    value: cloneJson(fallbackValue),
    deleted: false,
    updatedAt,
    revision,
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

function sanitizedMetadataValues(values, operations) {
  const sanitized = safeMap();
  for (const [key, value] of Object.entries(values || {})) sanitized[key] = value;
  for (const [key, operation] of Object.entries(operations || {})) {
    if (!normalizeMetadataOperation(operation, null, 0)) delete sanitized[key];
  }
  return sanitized;
}

function mergeMetadataOperationMaps(current, incoming) {
  const merged = safeMap();
  for (const [key, operation] of Object.entries(current || {})) merged[key] = operation;
  for (const [key, operation] of Object.entries(incoming || {})) {
    const previous = merged[key];
    const order = compareRevisions(operation?.revision || operation, previous?.revision || previous);
    if (
      !previous ||
      order > 0 ||
      (order === 0 && operation.deleted === true && previous.deleted !== true)
    ) {
      merged[key] = operation;
    }
  }
  return merged;
}

function materializeMetadataOperations(operations, base = null) {
  const values = safeMap();
  for (const [key, value] of Object.entries(base || {})) values[key] = value;
  for (const [key, operation] of Object.entries(operations || {})) {
    if (operation?.deleted === true || operation?.value == null) delete values[key];
    else values[key] = operation.value;
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
  const revision = normalizeRevision(updatedAt, Date.now(), "local", 0);
  const values = safeMap();
  for (const [existingKey, existingValue] of Object.entries(meta?.[mapName] || {})) {
    values[existingKey] = existingValue;
  }
  const deleted = value == null;
  if (deleted) delete values[key];
  else values[key] = value;
  return {
    ...(meta && typeof meta === "object" ? meta : {}),
    updatedAt: Math.max(finiteTs(meta?.updatedAt), revision.updatedAt),
    [mapName]: values,
    [opsName]: Object.assign(safeMap(), meta?.[opsName] || {}, {
      [key]: { value: deleted ? null : value, deleted, updatedAt: revision.updatedAt, revision },
    }),
  };
}

function normalizeThreadFieldOperations(raw, fallbackUpdatedAt) {
  const operations = safeMap();
  const source = raw?.fieldOps && typeof raw.fieldOps === "object" && !Array.isArray(raw.fieldOps)
    ? raw.fieldOps
    : null;
  for (const field of THREAD_FIELDS) {
    if (source && Object.hasOwn(source, field)) {
      const operation = normalizeMetadataOperation(source[field], null, 0);
      if (operation) {
        const value = operation.deleted ? null : normalizeThreadFieldValue(field, operation.value);
        if (operation.deleted || value !== INVALID_FIELD_VALUE) {
          operations[field] = { ...operation, value };
        }
      }
      continue;
    }
    let hasValue = Object.hasOwn(raw, field);
    let value = raw[field];
    if (field === "workflowKey" && !hasValue) {
      hasValue = true;
      value = "panel:global";
    }
    if (!hasValue || value == null) continue;
    value = normalizeThreadFieldValue(field, value);
    if (value === INVALID_FIELD_VALUE) continue;
    const revision = legacyRevision(value, fallbackUpdatedAt);
    operations[field] = {
      value: cloneJson(value),
      deleted: false,
      updatedAt: revision.updatedAt,
      revision,
    };
  }
  return operations;
}

function materializeThreadFields(thread, fieldOps) {
  const materialized = { ...thread, fieldOps };
  for (const field of THREAD_FIELDS) {
    const operation = fieldOps[field];
    if (operation) {
      if (operation.deleted === true) delete materialized[field];
      else materialized[field] = cloneJson(operation.value);
      continue;
    }
    const normalized = normalizeThreadFieldValue(field, materialized[field]);
    if (normalized === INVALID_FIELD_VALUE || normalized == null) delete materialized[field];
    else materialized[field] = cloneJson(normalized);
  }
  materialized.pinned = materialized.pinned === true;
  materialized.workflowKey = typeof materialized.workflowKey === "string"
    ? materialized.workflowKey
    : "panel:global";
  return materialized;
}

function normalizeCheckpoint(meta) {
  const generation = Number(meta?.checkpoint?.generation);
  const revision = normalizeExplicitRevision(meta?.checkpoint?.revision);
  return {
    generation: Number.isSafeInteger(generation) && generation > 0 && revision ? generation : 0,
    revision,
  };
}

function operationRevision(operation) {
  return normalizeRevision(operation?.revision || operation);
}

function boundedEntries(map, limit, revisionOf) {
  const entries = Object.entries(map || {});
  if (entries.length <= limit) return [map, []];
  entries.sort((left, right) =>
    compareRevisions(revisionOf(left[1]), revisionOf(right[1])) || left[0].localeCompare(right[0]),
  );
  const dropped = entries.slice(0, entries.length - limit);
  const kept = safeMap();
  for (const [key, value] of entries.slice(-limit)) kept[key] = value;
  return [kept, dropped];
}

function compactSnapshot(snapshot, { maxTombstones, maxMetadataOps }) {
  const tombstoneLimit = Math.max(1, Math.floor(Number(maxTombstones) || DEFAULT_MAX_TOMBSTONES));
  const operationLimit = Math.max(1, Math.floor(Number(maxMetadataOps) || DEFAULT_MAX_METADATA_OPS));
  const meta = { ...(snapshot.meta || {}) };
  const droppedRevisions = [];
  let changed = false;
  [meta.deletedThreads, changed] = (() => {
    const [kept, dropped] = boundedEntries(meta.deletedThreads, tombstoneLimit, operationRevision);
    for (const [, value] of dropped) droppedRevisions.push(operationRevision(value));
    return [kept, changed || dropped.length > 0];
  })();
  for (const name of ["activeOps", "aliasOps"]) {
    const [kept, dropped] = boundedEntries(meta[name], operationLimit, operationRevision);
    meta[name] = kept;
    for (const [, value] of dropped) droppedRevisions.push(operationRevision(value));
    if (dropped.length) changed = true;
  }
  const threads = snapshot.threads.map((thread) => {
    const [deletedMessages, dropped] = boundedEntries(thread.deletedMessages, tombstoneLimit, finiteTs);
    for (const [, value] of dropped) droppedRevisions.push(normalizeRevision(null, value, "tombstone"));
    if (dropped.length) changed = true;
    return dropped.length ? { ...thread, deletedMessages } : thread;
  });
  if (!changed) return { ...snapshot, threads, meta };
  const previous = normalizeCheckpoint(meta);
  let revision = previous.revision;
  for (const candidate of droppedRevisions) {
    if (compareRevisions(candidate, revision) > 0) revision = candidate;
  }
  meta.checkpoint = {
    generation: previous.generation + 1,
    revision: revision || normalizeRevision(null, Date.now(), "checkpoint"),
  };
  return { ...snapshot, threads, meta };
}

export function normalizeThread(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
  const deletedMessages = mergeTimestampMaps(raw.deletedMessages);
  const msgs = normalizeMessages(raw.id, raw.msgs)
    .filter(
      (message) =>
        message &&
        typeof message === "object" &&
        !(typeof message.id === "string" && Object.hasOwn(deletedMessages, message.id)),
    );
  const ts = finiteTs(raw.ts) || finiteTs(raw.createdAt) || Date.now();
  const createdAt = finiteTs(raw.createdAt) || ts;
  const updatedAt = finiteTs(raw.updatedAt) || ts;
  const fieldOps = normalizeThreadFieldOperations(raw, updatedAt);
  return materializeThreadFields({
    ...raw,
    id: raw.id,
    schemaVersion: CHAT_HISTORY_SCHEMA,
    createdAt,
    createdRevision: normalizeRevision(
      raw.createdRevision,
      createdAt,
      `created-${stableHash(raw.id)}`,
    ),
    updatedAt,
    ts: updatedAt,
    msgs,
    deletedMessages,
    title: typeof raw.title === "string" ? raw.title.slice(0, 160) : undefined,
    workflowTitle: typeof raw.workflowTitle === "string" ? raw.workflowTitle.slice(0, 240) : undefined,
    provider: typeof raw.provider === "string" ? raw.provider : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    effort: typeof raw.effort === "string" ? raw.effort : undefined,
  }, fieldOps);
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
  const byId = new Map();
  for (const message of [...oldMessages, ...newMessages]) {
    const previous = byId.get(message.id);
    if (!previous || compareRevisions(message.revision || message, previous.revision || previous) > 0) {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      finiteTs(a.createdAt || a.ts) - finiteTs(b.createdAt || b.ts) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/** Merge snapshots by thread id; the newest record wins without dropping fields
 *  added by an older copy (useful while migrating localStorage -> IndexedDB). */
export function mergeHistorySnapshots(...snapshots) {
  const usableSnapshots = snapshots.filter((snap) => snap && typeof snap === "object");
  let checkpointGeneration = 0;
  let checkpointRevision = null;
  for (const snap of usableSnapshots) {
    const checkpoint = normalizeCheckpoint(snap.meta);
    if (checkpoint.generation > checkpointGeneration) {
      checkpointGeneration = checkpoint.generation;
      checkpointRevision = checkpoint.revision;
    } else if (
      checkpoint.generation === checkpointGeneration &&
      compareRevisions(checkpoint.revision, checkpointRevision) > 0
    ) {
      checkpointRevision = checkpoint.revision;
    }
  }
  const checkpointThreadIds = new Set();
  const checkpointMessageIds = new Map();
  const checkpointActive = safeMap();
  const checkpointAliases = safeMap();
  if (checkpointGeneration) {
    for (const snap of usableSnapshots) {
      if (normalizeCheckpoint(snap.meta).generation !== checkpointGeneration) continue;
      for (const [key, value] of Object.entries(snap.meta?.activeByScope || {})) checkpointActive[key] = value;
      for (const [key, value] of Object.entries(snap.meta?.workflowAliases || {})) checkpointAliases[key] = value;
      for (const rawThread of Array.isArray(snap.threads) ? snap.threads : []) {
        if (!rawThread || typeof rawThread.id !== "string" || !rawThread.id) continue;
        checkpointThreadIds.add(rawThread.id);
        const ids = checkpointMessageIds.get(rawThread.id) || new Set();
        for (const message of Array.isArray(rawThread.msgs) ? rawThread.msgs : []) {
          if (typeof message?.id === "string" && message.id) ids.add(message.id);
        }
        checkpointMessageIds.set(rawThread.id, ids);
      }
    }
  }
  const byId = new Map();
  let meta = {};
  let activeOps = {};
  let aliasOps = {};
  let deletedThreads = {};
  let metaUpdatedAt = 0;
  let snapshotUpdatedAt = 0;
  for (const snap of usableSnapshots) {
    const snapCheckpoint = normalizeCheckpoint(snap.meta);
    const beforeCheckpoint = snapCheckpoint.generation < checkpointGeneration;
    const incomingUpdatedAt = Math.max(finiteTs(snap.updatedAt), finiteTs(snap.meta?.updatedAt));
    snapshotUpdatedAt = Math.max(snapshotUpdatedAt, incomingUpdatedAt);
    if (snap.meta && typeof snap.meta === "object") {
      const snapMeta = {
        ...snap.meta,
        activeByScope: sanitizedMetadataValues(snap.meta.activeByScope, snap.meta.activeOps),
        workflowAliases: sanitizedMetadataValues(snap.meta.workflowAliases, snap.meta.aliasOps),
      };
      const incomingNewer = incomingUpdatedAt >= metaUpdatedAt;
      const older = incomingNewer ? meta : snapMeta;
      const newer = incomingNewer ? snapMeta : meta;
      meta = {
        ...older,
        ...newer,
      };
      activeOps = mergeMetadataOperationMaps(
        activeOps,
        Object.fromEntries(Object.entries(normalizeMetadataOperations(
          snap.meta.activeOps,
          beforeCheckpoint ? null : snapMeta.activeByScope,
          incomingUpdatedAt || 1,
        )).filter(([, operation]) =>
          !beforeCheckpoint || compareRevisions(operation.revision, checkpointRevision) > 0)),
      );
      aliasOps = mergeMetadataOperationMaps(
        aliasOps,
        Object.fromEntries(Object.entries(normalizeMetadataOperations(
          snap.meta.aliasOps,
          beforeCheckpoint ? null : snapMeta.workflowAliases,
          incomingUpdatedAt || 1,
        )).filter(([, operation]) =>
          !beforeCheckpoint || compareRevisions(operation.revision, checkpointRevision) > 0)),
      );
      const acceptedDeletedThreads = beforeCheckpoint
        ? Object.fromEntries(Object.entries(snap.meta.deletedThreads || {}).filter(([, value]) =>
          compareRevisions(normalizeThreadDeletion(value)?.revision, checkpointRevision) > 0))
        : snap.meta.deletedThreads;
      deletedThreads = mergeThreadDeletionMaps(deletedThreads, acceptedDeletedThreads);
      metaUpdatedAt = Math.max(metaUpdatedAt, incomingUpdatedAt);
    }
    for (const candidate of Array.isArray(snap.threads) ? snap.threads : []) {
      const next = normalizeThread(candidate);
      if (!next) continue;
      if (
        beforeCheckpoint &&
        !checkpointThreadIds.has(next.id) &&
        compareRevisions(next.createdRevision, checkpointRevision) <= 0
      ) continue;
      if (beforeCheckpoint && checkpointMessageIds.has(next.id)) {
        const baselineIds = checkpointMessageIds.get(next.id);
        next.msgs = next.msgs.filter((message) =>
          baselineIds.has(message.id) || compareRevisions(message.createdRevision, checkpointRevision) > 0);
        next.deletedMessages = mergeTimestampMaps(Object.fromEntries(
          Object.entries(next.deletedMessages).filter(([, value]) =>
            finiteTs(value) > finiteTs(checkpointRevision?.updatedAt)),
        ));
      }
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
      const fieldOps = mergeMetadataOperationMaps(older.fieldOps, newer.fieldOps);
      byId.set(next.id, materializeThreadFields(
        { ...older, ...overlay, msgs, deletedMessages },
        fieldOps,
      ));
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
      checkpoint: checkpointGeneration
        ? { generation: checkpointGeneration, revision: checkpointRevision }
        : undefined,
      updatedAt: metaUpdatedAt,
      activeOps,
      aliasOps,
      activeByScope: materializeMetadataOperations(
        activeOps,
        checkpointGeneration ? checkpointActive : meta.activeByScope,
      ),
      workflowAliases: materializeMetadataOperations(
        aliasOps,
        checkpointGeneration ? checkpointAliases : meta.workflowAliases,
      ),
      deletedThreads,
    },
  };
}

function withoutCheckpoint(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const hadCheckpoint = snapshot.meta?.checkpoint != null;
  return {
    ...snapshot,
    meta: snapshot.meta && typeof snapshot.meta === "object"
      ? {
        ...snapshot.meta,
        checkpoint: undefined,
        // Materialized maps in a checkpointed shadow are baseline cache, not
        // fresh operations. The canonical record supplies that baseline.
        activeByScope: hadCheckpoint ? {} : snapshot.meta.activeByScope,
        workflowAliases: hadCheckpoint ? {} : snapshot.meta.workflowAliases,
      }
      : {},
  };
}

/** Merge an untrusted shadow/write intent under the baseline owned by IndexedDB.
 * Local checkpoints are deliberately removed even when they repeat the current
 * generation: only the canonical record may define which compacted records
 * existed at that generation. Newer causal operations still pass the normal
 * post-checkpoint filters. */
function mergeUnderCanonicalCheckpoint(canonical, ...untrusted) {
  const canonicalFenced = Number(canonical?.schemaVersion) >= CHAT_HISTORY_SCHEMA &&
    !hasIdlessMessages(canonical?.threads);
  const accepted = untrusted.filter((snapshot) =>
    !(canonicalFenced && snapshot?.[LEGACY_IDLESS_SOURCE] === true));
  let canonicalBaseline = canonical && typeof canonical === "object" ? canonical : null;
  if (!canonicalFenced) {
    // Before the one-way schema-3 fence, a pre-v3 tab writes a complete thread.
    // Replace matching legacy threads as a unit; UUID-unioning independently
    // hashed positions/content would duplicate shifted or edited messages.
    const legacyThreadIds = new Set(accepted
      .filter((snapshot) => snapshot?.[LEGACY_IDLESS_SOURCE] === true)
      .flatMap((snapshot) => (Array.isArray(snapshot?.threads) ? snapshot.threads : []))
      .map((thread) => thread?.id)
      .filter(Boolean));
    if (canonicalBaseline && legacyThreadIds.size) {
      canonicalBaseline = {
        ...canonicalBaseline,
        threads: (Array.isArray(canonicalBaseline.threads) ? canonicalBaseline.threads : [])
          .filter((thread) => !legacyThreadIds.has(thread?.id)),
      };
    }
  }
  return mergeHistorySnapshots(
    canonicalBaseline,
    ...accepted.map(withoutCheckpoint),
  );
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
      let merged = compactSnapshot(boundedSnapshot(withoutCheckpoint(snapshot), limits), limits);
      get.onsuccess = () => {
        merged = compactSnapshot(
          boundedSnapshot(mergeUnderCanonicalCheckpoint(get.result, snapshot), limits),
          limits,
        );
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
    this.maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
    this.maxMetadataOps = options.maxMetadataOps ?? DEFAULT_MAX_METADATA_OPS;
    this.onShadowError = typeof options.onShadowError === "function" ? options.onShadowError : null;
    this.onPersistenceError = typeof options.onPersistenceError === "function"
      ? options.onPersistenceError
      : null;
    this.lastShadowWriteOk = null;
    this.lastShadowError = null;
    this.writerId = options.writerId || globalThis.crypto?.randomUUID?.() || `writer-${Math.random().toString(16).slice(2)}`;
    this._revisionSequence = 0;
    this._lastRevisionAt = 0;
    this._observedRevision = null;
    this._writePromise = Promise.resolve(null);
    this._lastCommitted = null;
    this._dirtyWrite = null;
    this._closed = false;
    this._subscriptions = new Set();
    const channelFactory = options.broadcastChannelFactory || (
      globalThis.window === globalThis && typeof globalThis.BroadcastChannel === "function"
        ? (name) => new globalThis.BroadcastChannel(name)
        : null
    );
    try {
      this._broadcastChannel = channelFactory?.(BROADCAST_CHANNEL_NAME) || null;
    } catch {
      this._broadcastChannel = null;
    }
  }

  nextRevision(updatedAt = Date.now()) {
    const wallAt = finiteTs(updatedAt) || Date.now();
    const observedAt = finiteTs(this._observedRevision?.updatedAt);
    const floor = Math.max(this._lastRevisionAt, observedAt);
    const at = wallAt > floor ? wallAt : floor + 1;
    if (at !== this._lastRevisionAt) {
      this._lastRevisionAt = at;
      this._revisionSequence = 0;
    }
    this._revisionSequence += 1;
    const revision = { updatedAt: at, writerId: this.writerId, sequence: this._revisionSequence };
    this._observedRevision = revision;
    return revision;
  }

  _observeRevision(value) {
    const revision = normalizeRevision(value);
    if (revision && compareRevisions(revision, this._observedRevision) > 0) {
      this._observedRevision = revision;
      this._lastRevisionAt = Math.max(this._lastRevisionAt, revision.updatedAt);
    }
  }

  _observeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    this._observeRevision(snapshot.meta?.checkpoint?.revision);
    for (const operation of Object.values(snapshot.meta?.activeOps || {})) this._observeRevision(operation);
    for (const operation of Object.values(snapshot.meta?.aliasOps || {})) this._observeRevision(operation);
    for (const operation of Object.values(snapshot.meta?.deletedThreads || {})) this._observeRevision(operation);
    for (const thread of Array.isArray(snapshot.threads) ? snapshot.threads : []) {
      this._observeRevision(thread?.createdRevision);
      for (const operation of Object.values(thread?.fieldOps || {})) this._observeRevision(operation);
      for (const message of Array.isArray(thread?.msgs) ? thread.msgs : []) {
        this._observeRevision(message?.createdRevision);
        this._observeRevision(message?.revision || message);
      }
    }
  }

  reviseThread(thread, values, updatedAt = Date.now()) {
    if (!thread || typeof thread !== "object" || !values || typeof values !== "object") return thread;
    const fieldOps = Object.assign(safeMap(), thread.fieldOps || {});
    let newestAt = finiteTs(thread.updatedAt);
    for (const [field, value] of Object.entries(values)) {
      if (!THREAD_FIELDS.includes(field)) continue;
      const normalizedValue = value == null ? null : normalizeThreadFieldValue(field, value);
      if (normalizedValue === INVALID_FIELD_VALUE) continue;
      this._observeRevision(fieldOps[field]);
      const revision = this.nextRevision(updatedAt);
      const deleted = normalizedValue == null;
      fieldOps[field] = {
        value: deleted ? null : cloneJson(normalizedValue),
        deleted,
        updatedAt: revision.updatedAt,
        revision,
      };
      if (deleted) delete thread[field];
      else thread[field] = cloneJson(normalizedValue);
      newestAt = Math.max(newestAt, revision.updatedAt);
    }
    thread.fieldOps = fieldOps;
    thread.updatedAt = newestAt || Date.now();
    thread.ts = thread.updatedAt;
    return thread;
  }

  touchMessage(message, updatedAt = Date.now()) {
    if (!message || typeof message !== "object") return message;
    this._observeRevision(message.revision || message);
    const revision = this.nextRevision(updatedAt);
    message.updatedAt = revision.updatedAt;
    message.revision = revision;
    return message;
  }

  readLocal({ quarantineCheckpoint = false } = {}) {
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
      const local = { threads: Array.isArray(threads) ? threads : [], meta };
      const normalized = mergeHistorySnapshots(quarantineCheckpoint ? withoutCheckpoint(local) : local);
      if (hasIdlessMessages(local.threads)) normalized[LEGACY_IDLESS_SOURCE] = true;
      return normalized;
    } catch {
      return mergeHistorySnapshots({ threads: [], meta: {} });
    }
  }

  async load(options = {}) {
    const indexed = await idbRead(this.indexedDb);
    const local = this.readLocal({ quarantineCheckpoint: indexed != null });
    const merged = mergeUnderCanonicalCheckpoint(indexed, local);
    this._observeSnapshot(merged);
    // Migration is automatic: once loaded, the full merged set is promoted to
    // IndexedDB while a small legacy shadow remains for older panel builds.
    this.persist(merged.threads, merged.meta, options);
    return merged;
  }

  async readCanonical() {
    const indexed = await idbRead(this.indexedDb);
    const merged = mergeUnderCanonicalCheckpoint(
      indexed,
      this.readLocal({ quarantineCheckpoint: indexed != null }),
    );
    this._observeSnapshot(merged);
    return merged;
  }

  _writeLocalSnapshot(snapshot, protectedThreadIds) {
    const shadow = retainBoundedThreads(
      snapshot.threads,
      LOCAL_SHADOW_THREADS,
      protectedThreadIds,
    ).map((thread) => ({ ...thread, msgs: thread.msgs.slice(-LOCAL_SHADOW_MESSAGES) }));
    const localSnapshot = { ...snapshot, threads: shadow };
    try {
      this.storage?.setItem(this.snapshotKey, JSON.stringify(localSnapshot));
      this.lastShadowWriteOk = true;
      this.lastShadowError = null;
    } catch (error) {
      this.lastShadowWriteOk = false;
      this.lastShadowError = error;
      this.onShadowError?.(error);
      return false;
    }
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
    return true;
  }

  persist(threads, meta = {}, options = {}) {
    if (this._closed) return this._lastCommitted || mergeHistorySnapshots({ threads, meta });
    const freshSnapshot = mergeHistorySnapshots({ threads, meta });
    if (hasIdlessMessages(threads)) freshSnapshot[LEGACY_IDLESS_SOURCE] = true;
    const snapshot = this._dirtyWrite
      ? mergeHistorySnapshots(this._dirtyWrite.snapshot, freshSnapshot)
      : freshSnapshot;
    this._observeSnapshot(snapshot);
    const protectedThreadIds = [
      ...(Array.isArray(options.protectedThreadIds) ? options.protectedThreadIds : []),
      ...Object.values(snapshot.meta.activeByScope || {}),
    ];
    const limits = {
      maxThreads: options.maxThreads ?? this.maxThreads,
      maxMessages: options.maxMessages ?? this.maxMessages,
      maxTombstones: options.maxTombstones ?? this.maxTombstones,
      maxMetadataOps: options.maxMetadataOps ?? this.maxMetadataOps,
      protectedThreadIds,
    };
    const shadowCommitted = this._writeLocalSnapshot(snapshot, protectedThreadIds);
    // Start the atomic merge immediately. Chat records are low-frequency and a
    // debounce creates an avoidable shutdown window in which the local shadow
    // exists but IndexedDB has not started its transaction yet.
    this._writePromise = this._writePromise
      .catch(() => null)
      .then(() => idbMergeWrite(this.indexedDb, snapshot, limits))
      .then((merged) => {
        if (merged) {
          this._lastCommitted = merged;
          this._observeSnapshot(merged);
          this._writeLocalSnapshot(merged, protectedThreadIds);
          try {
            this._broadcastChannel?.postMessage({ type: "history-changed", writerId: this.writerId });
          } catch {
            // localStorage events remain available when the channel is blocked.
          }
        }
        const result = {
          ok: Boolean(merged || shadowCommitted),
          shadowCommitted,
          canonicalCommitted: Boolean(merged),
          retryable: !merged && !shadowCommitted,
          code: !merged && !shadowCommitted ? "history-persistence-unavailable" : null,
        };
        if (result.ok) {
          this._dirtyWrite = null;
        } else {
          // Neither durability layer accepted this state. Keep the complete
          // intent so the next persist can retry it after quota/IDB recovery.
          // No BroadcastChannel message is sent: peers must only invalidate
          // against a committed canonical revision.
          this._dirtyWrite = { snapshot, limits, protectedThreadIds };
          this.onPersistenceError?.(result);
        }
        return result;
      });
    return snapshot;
  }

  /** Watch the localStorage compatibility shadow. Browsers fire `storage` only
   *  in the other tabs, making it a cheap cross-tab invalidation channel while
   *  IndexedDB remains the full, atomically merged source of truth. */
  subscribe(listener, eventTarget = globalThis) {
    if (this._closed || typeof listener !== "function") return () => {};
    const onStorage = (event) => {
      if (
        event?.key !== this.snapshotKey &&
        event?.key !== this.threadsKey &&
        event?.key !== this.metaKey
      ) return;
      // Resolve through canonical IDB first so quarantined pre-v3 shadows never
      // transiently remount in another live panel.
      void this.readCanonical().then(listener);
    };
    const onBroadcast = (event) => {
      if (event?.data?.type !== "history-changed" || event.data.writerId === this.writerId) return;
      void this.readCanonical().then(listener);
    };
    eventTarget?.addEventListener?.("storage", onStorage);
    this._broadcastChannel?.addEventListener?.("message", onBroadcast);
    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      eventTarget?.removeEventListener?.("storage", onStorage);
      this._broadcastChannel?.removeEventListener?.("message", onBroadcast);
      this._subscriptions.delete(unsubscribe);
    };
    this._subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  async flush() {
    const result = await this._writePromise.catch((error) => ({
      ok: false,
      shadowCommitted: false,
      canonicalCommitted: false,
      retryable: true,
      code: "history-persistence-error",
      error: error?.message || String(error),
    }));
    return result == null || result.ok === true ? true : result;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    for (const unsubscribe of [...this._subscriptions]) unsubscribe();
    this._subscriptions.clear();
    try {
      this._broadcastChannel?.close?.();
    } catch {
      // Closing an already-detached native channel is harmless.
    }
    this._broadcastChannel = null;
  }

}
