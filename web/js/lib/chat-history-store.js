// Durable chat-history storage for the Agent Panel.
//
// IndexedDB is the canonical browser store. A small localStorage shadow remains
// for instant startup and backward compatibility with pre-v2 panel builds.

import { isThreadInScope } from "./workflow-chat-identity.js";
export { isThreadInScope };

export const CHAT_HISTORY_SCHEMA = 3;

/**
 * The IndexedDB version, DELIBERATELY SEPARATE from the record schema (#861).
 *
 * These were one constant, and the coupling was a trap: the fence at
 * `mergeUnderCanonicalCheckpoint` is `snapshot.schemaVersion >= CHAT_HISTORY_SCHEMA`,
 * so bumping the number to add an object store would have made every already-stored
 * `schemaVersion: 3` snapshot read as UNFENCED — reopening the pre-v3 merge path the
 * fence exists to close, on every existing install, as a side effect of a structural
 * migration that has nothing to do with record shape.
 *
 * A store migration and a record-shape migration are different events. They now have
 * different numbers, and only this one may be bumped to create or alter a store.
 */
export const CHAT_HISTORY_DB_VERSION = 4;
export const CHAT_HISTORY_DB = "comfyui-mcp-panel-history";
export const CHAT_HISTORY_STATE_KEY = "state";
/** Object store holding quarantined pre-v3 transcripts — see LEGACY_STORE below. */
export const CHAT_HISTORY_LEGACY_STORE = "legacy";
export const CHAT_HISTORY_LOCAL_SNAPSHOT_KEY = "comfyui-mcp.panel.historySnapshot";
export const CHAT_HISTORY_MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const CHAT_HISTORY_EXPORT_FORMAT = "comfyui-agent-panel-chat-history";
/** ComfyUI's own draft-index key on the shared origin (#1305). */
export const COMFY_DRAFT_INDEX_KEY = "Comfy.Workflow.DraftIndex.v2";

const DEFAULT_THREADS_KEY = "comfyui-mcp.panel.threads";
const DEFAULT_META_KEY = "comfyui-mcp.panel.historyMeta";
const DEFAULT_MAX_THREADS = 500;
const DEFAULT_MAX_MESSAGES = 5000;
const LOCAL_SHADOW_THREADS = 20;
const LOCAL_SHADOW_MESSAGES = 200;
/**
 * A ceiling on what the panel may occupy in localStorage (#861).
 *
 * `localStorage` is per-ORIGIN, and the panel shares `http://localhost:8188` with
 * ComfyUI. There is no per-extension budget: bytes the panel takes are bytes
 * ComfyUI's own `saveDraft()` cannot have. When it loses that race the user sees
 * "Failed to save workflow draft", `Comfy.Workflow.DraftIndex.v2` stops persisting,
 * and every open workflow tab is gone on browser restart — with a clean backend log
 * and nothing pointing at the panel.
 *
 * ~1.5MB of a typical 5MB origin budget. Not tuned to a measurement, because the
 * budget is a browser-and-origin variable we cannot read: it is chosen to leave
 * ComfyUI the clear majority of the origin, on the principle that a guest should
 * not be the reason the host fails.
 */
const LOCAL_SHADOW_MAX_BYTES = 1_500_000;
const IDB_OPEN_TIMEOUT_MS = 2000;
const DEFAULT_MAX_TOMBSTONES = 512;
const DEFAULT_MAX_METADATA_OPS = 512;
const DEFAULT_MAX_WORKFLOW_VERSIONS = 20;
const MAX_WORKFLOW_SNAPSHOT_BYTES = 300_000;
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

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

export function isQuotaExceededError(error) {
  if (!error) return false;
  return error.name === "QuotaExceededError"
    || error.name === "NS_ERROR_DOM_QUOTA_REACHED"
    || error.code === 22
    || error.code === 1014;
}

/**
 * Write one localStorage key, and if the origin is already full, drop THIS key
 * first so a shrink can land (#1305).
 *
 * Browsers measure remaining quota BEFORE freeing the value being replaced.
 * That is why #861's bounded `setItem` still threw on an already-over-budget
 * origin: the new payload was smaller, but not smaller than the leftover
 * headroom, so the huge pre-0.11.57 shadow never moved. Removing the key
 * first is the only way a guest can give the host its bytes back.
 *
 * On a failed retry the previous value is restored when we still have it —
 * this must not become a delete of someone else's key (the draft-index probe
 * uses the same helper).
 */
export function writeLocalStorageItem(storage, key, value) {
  writeLocalStorageItem.lastError = null;
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch (error) {
    writeLocalStorageItem.lastError = error;
    if (!isQuotaExceededError(error)) return false;
    let previous = null;
    try { previous = storage.getItem(key); } catch { /* ignore */ }
    try { storage.removeItem(key); } catch { /* ignore */ }
    try {
      storage.setItem(key, value);
      writeLocalStorageItem.lastError = null;
      return true;
    } catch (retry) {
      writeLocalStorageItem.lastError = retry;
      if (previous != null) {
        try { storage.setItem(key, previous); } catch { /* best-effort restore */ }
      }
      return false;
    }
  }
}

export function measurePanelShadowBytes(storage, keys) {
  if (!storage) return 0;
  let total = 0;
  for (const key of keys) {
    try {
      const raw = storage.getItem(key);
      if (typeof raw === "string") total += raw.length;
    } catch { /* ignore */ }
  }
  return total;
}

/**
 * Can ComfyUI still persist `Comfy.Workflow.DraftIndex.v2`? (#1305)
 *
 * Writes the EXISTING value back when one is present, so this is not a
 * rewrite of the user's drafts. A missing key gets a tiny probe that is
 * removed again. Never clears any other origin key.
 */
export function probeDraftIndexWrite(storage) {
  if (!storage) return false;
  let previous;
  try {
    previous = storage.getItem(COMFY_DRAFT_INDEX_KEY);
  } catch {
    return false;
  }
  const payload = previous == null ? "{\"v\":2}" : previous;
  const wrote = writeLocalStorageItem(storage, COMFY_DRAFT_INDEX_KEY, payload);
  if (previous == null && wrote) {
    try { storage.removeItem(COMFY_DRAFT_INDEX_KEY); } catch { /* probe only */ }
  }
  return wrote;
}

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

function normalizeWorkflowVersions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return Object.create(null);
  const versions = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const hash = String(value.hash || key || "").trim().slice(0, 64);
    if (!hash) continue;
    const normalized = {
      hash,
      capturedAt: finiteTs(value.capturedAt),
      nodeCount: Math.max(0, Math.min(1_000_000, Math.floor(Number(value.nodeCount) || 0))),
    };
    for (const [field, limit] of [
      ["workflowKey", 512],
      ["title", 240],
      ["path", 1024],
    ]) {
      if (typeof value[field] === "string" && value[field]) {
        normalized[field] = value[field].slice(0, limit);
      }
    }
    if (value.snapshot && typeof value.snapshot === "object") {
      try {
        const encoded = JSON.stringify(value.snapshot);
        if (utf8ByteLength(encoded) <= MAX_WORKFLOW_SNAPSHOT_BYTES) {
          normalized.snapshot = JSON.parse(encoded);
        }
      } catch {
        // Invalid/cyclic snapshots retain their lightweight version metadata.
      }
    }
    versions.push(normalized);
  }
  versions.sort((a, b) => b.capturedAt - a.capturedAt || a.hash.localeCompare(b.hash));
  const result = Object.create(null);
  for (const version of versions.slice(0, DEFAULT_MAX_WORKFLOW_VERSIONS)) {
    const previous = result[version.hash];
    if (!previous || version.capturedAt >= previous.capturedAt) result[version.hash] = version;
  }
  return result;
}

function mergeWorkflowVersions(...maps) {
  const combined = Object.create(null);
  for (const map of maps) {
    for (const [hash, version] of Object.entries(normalizeWorkflowVersions(map))) {
      const previous = combined[hash];
      // A version carrying its restorable graph outranks bare metadata for the same
      // capture (#861). The local shadow strips payloads from what canonical already
      // holds, and the shadow merges AFTER canonical — without this guard the
      // stripped copy would launder the durable payload away on the next load. The
      // hash is content-addressed, so same hash is the same graph: keeping the
      // payload-carrier loses nothing.
      const dropsPayload = previous?.snapshot !== undefined && version.snapshot === undefined;
      if (!previous || (version.capturedAt >= previous.capturedAt && !dropsPayload)) {
        combined[hash] = version;
      }
    }
  }
  return normalizeWorkflowVersions(combined);
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

function boundedMetadataValues(values, operations, limit, fallbackRevision) {
  const entries = Object.entries(values || {});
  if (entries.length <= limit) return [Object.assign(safeMap(), values || {}), []];
  entries.sort((left, right) =>
    compareRevisions(
      operationRevision(operations?.[left[0]]) || fallbackRevision,
      operationRevision(operations?.[right[0]]) || fallbackRevision,
    ) || left[0].localeCompare(right[0]),
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
  const originalMetadataOps = {
    activeOps: meta.activeOps,
    aliasOps: meta.aliasOps,
  };
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
  const fallbackMetadataRevision =
    normalizeCheckpoint(meta).revision ||
    normalizeRevision(null, finiteTs(meta.updatedAt) || 1, "metadata-baseline");
  for (const [valuesName, opsName] of [
    ["activeByScope", "activeOps"],
    ["workflowAliases", "aliasOps"],
  ]) {
    const [kept, dropped] = boundedMetadataValues(
      meta[valuesName],
      originalMetadataOps[opsName],
      operationLimit,
      fallbackMetadataRevision,
    );
    meta[valuesName] = kept;
    for (const [key] of dropped) {
      droppedRevisions.push(
        operationRevision(originalMetadataOps[opsName]?.[key]) || fallbackMetadataRevision,
      );
    }
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
    workflowVersions: normalizeWorkflowVersions(raw.workflowVersions),
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

/** The legacy shared selection key. Rounds 1-2 of mcp#884 kept ONE pointer for
 *  every backend under this key; the orchestrator keys its session per backend
 *  (orchestrator::<backend>, mcp#897), so the panel pointer now carries the
 *  same axis ("panel:backend:<id>") and this key remains a read-only migration
 *  fallback. */
export const LEGACY_PANEL_SCOPE = "panel:global";

const PANEL_BACKEND_PREFIX = "panel:backend:";

/** The selection-pointer key for ONE backend. The orchestrator keys its session
 *  `orchestrator::<backend>` (mcp#897), so the panel pointer carries the same
 *  axis. Exported so the panel and the backend-switch path build the key the
 *  same way rather than each interpolating their own. */
export function panelScopeKeyForBackend(backend) {
  return `${PANEL_BACKEND_PREFIX}${backend || "claude"}`;
}

/** The backend a panel scope key names, or null when it is not a backend key
 *  (the legacy shared key, or a retired workflow scope). */
export function backendOfScopeKey(scopeKey) {
  if (typeof scopeKey !== "string" || !scopeKey.startsWith(PANEL_BACKEND_PREFIX)) return null;
  return scopeKey.slice(PANEL_BACKEND_PREFIX.length) || null;
}

/**
 * Can `backend` claim this thread on the UPGRADE path?
 *
 * mcp#884 fork rule. A pre-upgrade snapshot has one shared `panel:global`
 * pointer and no per-backend keys, so every backend's key falls back to the
 * SAME thread id — Claude and Codex both resolve one thread, `loadThread`
 * scrubs its foreign session, and `record()` rewrites its provider on every
 * append. Two backends then share and corrupt one transcript. This hits every
 * existing user on their first upgrade, so the legacy route is forked here
 * instead: a thread is claimable only by the backend that actually owns it.
 *
 * `provider` is that ownership stamp — `record()` writes it on mint and on
 * every append, so any thread carrying messages carries a provider.
 *
 * A thread with NO provider FAILS CLOSED (nobody auto-adopts it). Fail-open is
 * exactly the collision above, and the cost of failing closed is bounded and
 * non-destructive: nothing is deleted, the conversation stays in history and
 * opens through the picker like any archived one. The common single-backend
 * upgrade is unaffected — that user's thread carries their provider and is
 * adopted normally.
 */
function threadClaimableByBackend(thread, backend) {
  if (!backend) return true;
  const provider = thread?.provider;
  return typeof provider === "string" && provider ? provider === backend : false;
}

/** Resolve the panel-owned selection pointer for one backend scope.
 *
 *  Returns { key, activeId, revision, cleared }:
 *  - key: the scope key the pointer was found under (backend key, or the
 *    legacy shared key when the backend key has never been written),
 *  - activeId: the selected thread id, or null,
 *  - revision: the causal revision of the selection op (null when the op was
 *    compacted into the checkpoint baseline),
 *  - cleared: true when the pointer was DELIBERATELY cleared (new chat) — an
 *    absent pointer is not a clear.
 *
 *  A backend key that has been written (value or clear) never falls back to
 *  the legacy key: migration is one-way per backend. */
export function resolvePanelPointer(meta, scopeKey = LEGACY_PANEL_SCOPE) {
  const keys = scopeKey === LEGACY_PANEL_SCOPE ? [scopeKey] : [scopeKey, LEGACY_PANEL_SCOPE];
  for (const key of keys) {
    const values = meta?.activeByScope;
    const operation = meta?.activeOps?.[key];
    const hasValue = values != null && typeof values === "object" && Object.hasOwn(values, key) &&
      values[key] != null;
    if (hasValue) {
      return { key, activeId: values[key], revision: operationRevision(operation), cleared: false };
    }
    if (operation) {
      return {
        key,
        activeId: operation.deleted === true ? null : (operation.value ?? null),
        revision: operationRevision(operation),
        cleared: operation.deleted === true || operation.value == null,
      };
    }
  }
  return { key: scopeKey, activeId: null, revision: null, cleared: false };
}

/** Select the panel-owned conversation for one backend without changing any
 *  thread's workflowKey. The selection id lives only in metadata; each thread
 *  keeps its ride-along workflow provenance for archive grouping. Legacy
 *  snapshots without any pointer recover the most recently updated
 *  conversation.
 *
 *  This is the ONE definition of "the conversation" per backend (mcp#884/#897):
 *  the agent session is orchestrator-scoped per backend, so every tab — cold
 *  restore and cross-tab sync alike — must resolve the same thread from the
 *  same shared state, under the same backend key.
 *
 *  Stale-pointer guard (the mcp#884 upgrade path) — SELECTION evidence only:
 *  the retired per-workflow mode recorded every selection as a workflow-scoped
 *  active op, so a pre-upgrade snapshot where the user kept conversing in
 *  workflow mode carries workflow:* ops NEWER than the abandoned panel
 *  pointer. The newest selection op that still resolves to a live thread wins.
 *  Message timestamps are deliberately NOT evidence: an imported archive, a
 *  straggler write, or a skewed clock can carry newer messages without any
 *  user selection, and must not move the shared conversation (gate P0-3).
 *  Other backends' panel keys are not evidence either — their selection is
 *  their own conversation, not this backend's. */
export function selectPanelThread(threads, meta, { scopeKey = LEGACY_PANEL_SCOPE } = {}) {
  const candidates = [...(Array.isArray(threads) ? threads : [])]
    .sort((a, b) => finiteTs(b?.updatedAt || b?.ts) - finiteTs(a?.updatedAt || a?.ts));
  const pointer = resolvePanelPointer(meta, scopeKey);
  if (pointer.cleared && pointer.activeId == null) return null;
  // THE UPGRADE FORK (see threadClaimableByBackend). Evidence written under THIS
  // backend's own key is per-backend by construction and needs no gate. Every
  // other route into a thread here is SHARED across backends and would hand the
  // same id to all of them:
  //   - the legacy `panel:global` pointer (pointer.key !== scopeKey),
  //   - the no-pointer recency fallback below,
  //   - the retired workflow-scoped selection ops, which were never per-backend.
  const backend = backendOfScopeKey(scopeKey);
  const claimable = (thread) => threadClaimableByBackend(thread, backend);
  const pointerIsOwn = pointer.key === scopeKey;
  const pointedRaw = candidates.find((thread) => thread?.id === pointer.activeId) || null;
  // A pointer this backend wrote itself names its own conversation whatever the
  // provider stamp says (a thread legitimately changes provider when the user
  // switches backends while it is open); only the shared routes are forked.
  const pointed = pointedRaw && (pointerIsOwn || claimable(pointedRaw)) ? pointedRaw : null;
  // The recency fallback is ALWAYS forked for a backend scope — including when
  // this backend's own pointer named a thread that has since been deleted, or
  // it would grab whatever another backend most recently used.
  if (!pointed) return candidates.find(claimable) || null;
  let latest = { revision: pointer.revision, threadId: pointed.id };
  for (const [key, operation] of Object.entries(meta?.activeOps || {})) {
    // Only RETIRED-mode (workflow/path/tmp scoped) selection ops compete; every
    // panel:* key is either this pointer or another backend's conversation.
    if (typeof key !== "string" || key.startsWith("panel:")) continue;
    if (!operation || operation.deleted === true || operation.value == null) continue;
    const target = candidates.find((thread) => thread?.id === operation.value && claimable(thread));
    if (!target) continue;
    const revision = operationRevision(operation);
    if (compareRevisions(revision, latest.revision) > 0) {
      latest = { revision, threadId: target.id };
    }
  }
  return candidates.find((thread) => thread.id === latest.threadId) || pointed;
}

/** Choose the durable conversation for reload. Panel-owned (the only shipping
 * mode since mcp#884): the SHARED per-backend selection is authoritative for
 * every tab — honoring a tab-local preference over it would let a reloading
 * tab render a conversation the backend's single session (mcp#897) is no
 * longer in. `scopeKey` is the backend selection key ("panel:backend:<id>");
 * the tab pointer only bridges legacy snapshots that predate the shared
 * pointer, where nothing else records what this tab had open. In per-workflow
 * mode the preferred pointer is still subject to the strict scope guard. */
export function selectRestoreThread(
  threads,
  meta,
  { panelOwned = true, scopeKey = null, preferredThreadId = null } = {},
) {
  const preferred = preferredThreadId
    ? (Array.isArray(threads) ? threads : []).find((candidate) => candidate?.id === preferredThreadId)
    : null;
  if (panelOwned) {
    const panelScope = scopeKey || LEGACY_PANEL_SCOPE;
    const pointer = resolvePanelPointer(meta, panelScope);
    const pointerResolves = pointer.activeId != null &&
      (Array.isArray(threads) ? threads : []).some((candidate) => candidate?.id === pointer.activeId);
    const deliberateClear = pointer.cleared && pointer.activeId == null;
    // A DANGLING pointer (names a thread that no longer exists — eviction race,
    // partial merge) carries no information about which conversation the
    // backend session is in; the tab that was just using one is better
    // evidence there.
    if (pointerResolves || deliberateClear) {
      return selectPanelThread(threads, meta, { scopeKey: panelScope });
    }
    return preferred || selectPanelThread(threads, meta, { scopeKey: panelScope });
  }
  if (preferred && isThreadInScope(preferred, scopeKey)) return preferred;
  return selectThreadForScope(threads, meta, scopeKey);
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
        {
          ...older,
          ...overlay,
          msgs,
          deletedMessages,
          workflowVersions: mergeWorkflowVersions(
            older.workflowVersions,
            newer.workflowVersions,
          ),
        },
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

/** Build a canonical empty-history checkpoint without discarding workflow
 * identity aliases. Advancing the generation fences every older browser tab:
 * a stale pre-clear snapshot cannot republish a thread that no longer exists in
 * this empty baseline. Alias operations are folded into the new checkpoint
 * baseline because they identify workflows, not transcripts. */
export function createHistoryResetSnapshot(snapshot, revision = null) {
  const normalized = mergeHistorySnapshots(snapshot);
  const resetRevision = normalizeExplicitRevision(revision) ||
    normalizeRevision(null, Date.now(), "history-clear", 0);
  const previousCheckpoint = normalizeCheckpoint(normalized.meta);
  const workflowAliases = safeMap();
  for (const [path, value] of Object.entries(normalized.meta?.workflowAliases || {})) {
    workflowAliases[path] = value;
  }
  return {
    schemaVersion: CHAT_HISTORY_SCHEMA,
    updatedAt: resetRevision.updatedAt,
    threads: [],
    meta: {
      ...(normalized.meta || {}),
      updatedAt: resetRevision.updatedAt,
      checkpoint: {
        generation: previousCheckpoint.generation + 1,
        revision: resetRevision,
      },
      activeByScope: safeMap(),
      activeOps: safeMap(),
      deletedThreads: safeMap(),
      workflowAliases,
      aliasOps: safeMap(),
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
  // A legacy-idless snapshot can't merge into a fenced canonical (its messages
  // have no ids, so a stale pre-v3 tab could resurrect deleted content). But
  // rejecting it wholesale must not ERASE data the user legitimately owns:
  // shadow-only threads are carried forward flagged `legacyShadow` — they stay
  // in the local shadow (visible, scope-disabled) and are excluded from the
  // canonical write in idbMergeWrite. Threads that already exist canonically
  // are covered by the canonical copy, not duplicated.
  let quarantined = [];
  if (canonicalFenced) {
    const canonicalIds = new Set(
      (Array.isArray(canonicalBaseline?.threads) ? canonicalBaseline.threads : [])
        .map((thread) => thread?.id)
        .filter(Boolean),
    );
    // Whole-snapshot quarantine: the flag exists because a stale pre-v3 writer
    // re-hashes shifted ordinals, so NOTHING in a flagged snapshot can be
    // deduped safely (persist() assigns ids BEFORE this point — checking
    // message ids here would wrongly admit them). Canonical-covered threads
    // are excluded: the canonical copy wins and must not be duplicated.
    quarantined = untrusted
      .filter((snapshot) => snapshot?.[LEGACY_IDLESS_SOURCE] === true)
      .flatMap((snapshot) => (Array.isArray(snapshot?.threads) ? snapshot.threads : []))
      .filter((thread) => thread && typeof thread.id === "string" && thread.id && !canonicalIds.has(thread.id))
      .map((thread) => normalizeThread({ ...thread, legacyShadow: true }))
      .filter(Boolean);
  }
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
  const merged = mergeHistorySnapshots(
    canonicalBaseline,
    ...accepted.map(withoutCheckpoint),
  );
  if (quarantined.length) {
    const existingIds = new Set(merged.threads.map((thread) => thread.id));
    merged.threads = [
      ...merged.threads,
      ...quarantined.filter((thread) => !existingIds.has(thread.id)),
    ];
  }
  return merged;
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

export function parseHistoryImport(value) {
  let parsed = value;
  if (typeof value === "string") {
    if (utf8ByteLength(value) > CHAT_HISTORY_MAX_IMPORT_BYTES) {
      throw new Error("Chat history import exceeds the 25 MB limit");
    }
    parsed = JSON.parse(value);
  }
  if (Array.isArray(parsed)) parsed = { threads: parsed, meta: {} };
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.threads)) {
    throw new Error("Not a ComfyUI Agent Panel history export");
  }
  if (parsed.format != null && parsed.format !== CHAT_HISTORY_EXPORT_FORMAT) {
    throw new Error("Not a ComfyUI Agent Panel history export");
  }
  const schemaVersion = Number(parsed.schemaVersion);
  if (Number.isFinite(schemaVersion) && schemaVersion > CHAT_HISTORY_SCHEMA) {
    throw new Error(
      `Chat history schema ${schemaVersion} is newer than this panel supports (${CHAT_HISTORY_SCHEMA})`,
    );
  }
  return {
    schemaVersion: CHAT_HISTORY_SCHEMA,
    threads: parsed.threads.map(portableThread).filter(Boolean),
    // Keep every validated portable alias through parsing so importPayload can
    // account for (and report) entries skipped by the local metadata cap.
    meta: {
      workflowAliases: portableWorkflowAliases(
        parsed.meta?.workflowAliases,
        Number.MAX_SAFE_INTEGER,
      ),
    },
  };
}

function portableWorkflowAliases(raw, limit = DEFAULT_MAX_METADATA_OPS) {
  const aliases = safeMap();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return aliases;
  let count = 0;
  for (const [rawPath, rawUuid] of Object.entries(raw)) {
    if (count >= limit) break;
    if (typeof rawPath !== "string" || !rawPath || rawPath.length > 1024) continue;
    if (typeof rawUuid !== "string" || !rawUuid || rawUuid.length > 512) continue;
    aliases[rawPath] = rawUuid;
    count += 1;
  }
  return aliases;
}

function portableMessage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const message = cloneJson(raw);
  delete message.revision;
  delete message.createdRevision;
  return message;
}

/** Produce the portable transcript shape used by export and import.
 *
 * Session ids and causal bookkeeping are browser-local implementation details:
 * carrying them to another installation can resume the wrong provider session,
 * while a foreign checkpoint/tombstone can delete unrelated local history.
 */
function portableThread(raw) {
  const normalized = normalizeThread(raw);
  if (!normalized) return null;
  const thread = {
    id: normalized.id,
    schemaVersion: CHAT_HISTORY_SCHEMA,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    ts: normalized.ts,
    msgs: normalized.msgs.map(portableMessage).filter(Boolean),
    workflowKey: normalized.workflowKey,
    workflowTitle: normalized.workflowTitle,
    provider: normalized.provider,
    model: normalized.model,
    effort: normalized.effort,
    pinned: normalized.pinned,
    title: normalized.title,
    todos: normalized.todos,
    workflowVersions: normalized.workflowVersions,
  };
  return Object.fromEntries(Object.entries(thread).filter(([, field]) => field !== undefined));
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
      request = indexedDb.open(CHAT_HISTORY_DB, CHAT_HISTORY_DB_VERSION);
    } catch {
      finish(null);
      return;
    }
    // CHAT_HISTORY_DB_VERSION — NOT the record schema (#861). Structural
    // store/index migrations belong here; record-shape migration remains app-layer
    // normalization in mergeHistorySnapshots().
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots");
      // #861 — LEGACY_STORE. Quarantined pre-v3 transcripts had no durable home:
      // the schema-3 fence keeps them out of the canonical snapshot, so the
      // localStorage shadow was their ONLY copy and had to retain them in full,
      // forever, in a budget shared with ComfyUI.
      //
      // The fence's reason does not reach here. It exists because legacy messages
      // carry no ids and a stale pre-v3 writer re-hashes shifted ordinals, so
      // nothing flagged can be DEDUPED INTO CANONICAL safely. This store is not
      // canonical and nothing merges it — records go in keyed by thread id and come
      // back out as the same quarantined threads. Storing them durably reopens none
      // of that reasoning, and it is what lets the shadow finally be bounded.
      if (!db.objectStoreNames.contains(CHAT_HISTORY_LEGACY_STORE)) {
        db.createObjectStore(CHAT_HISTORY_LEGACY_STORE);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // #861 — GET OUT OF THE WAY OF AN UPGRADE. Adding the legacy store made this
      // the first version bump the panel has ever shipped, and a bump is the moment
      // multiple tabs stop being free: an open connection at the old version BLOCKS
      // another tab's upgrade until it closes. Without this the second ComfyUI tab
      // waits out the open timeout, gets null, and reports IndexedDB unavailable —
      // on a database that is merely busy. Caught by conversation-persistence, which
      // opens a second tab on the same origin: green serially, red in parallel.
      //
      // Connections here are short-lived (every caller closes in a finally), so
      // closing on demand costs at most one in-flight read, which the caller already
      // treats as "unavailable" and retries.
      try {
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            // Already closing; the upgrade proceeds either way.
          }
        };
      } catch {
        // A connection that will not take the handler still works for this read.
      }
      finish(db);
    };
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

/**
 * Evict threads from the localStorage shadow until it fits a byte budget (#861).
 *
 * Count limits alone could not bound this: `LOCAL_SHADOW_THREADS`/`_MESSAGES` never
 * applied to legacy threads, and even for ordinary ones 20 threads x 200 messages is
 * a count, not a size — one transcript full of pasted workflow JSON outweighs
 * hundreds of short ones. The quota that actually broke ComfyUI is measured in bytes,
 * so the bound has to be too.
 *
 * ONLY `evictableIds` may be dropped. Everything in the shadow that is not durable
 * somewhere else is off limits, because this is an eviction from a CACHE for
 * everything that has a canonical copy and a DELETION for everything that does not.
 * `protectedIds` (the live thread, and anything the caller is mid-write on) is never
 * evicted even when durable — losing the transcript on screen to save space is not a
 * trade a user would recognise as help.
 *
 * Oldest first, because a shadow exists for instant startup and the newest chats are
 * the ones a user comes back to.
 *
 * Returns the snapshot unchanged when it already fits, so the common case pays one
 * serialization and nothing else.
 *
 * @param {{threads?: Array}} localSnapshot
 * @param {{maxBytes?: number, evictableIds?: Set<string>, protectedIds?: Set<string>}} opts
 * @returns {{snapshot: object, serialized: string, evicted: string[]}}
 */
export function boundShadowBytes(localSnapshot, { maxBytes, evictableIds, protectedIds } = {}) {
  const serialize = (snap) => JSON.stringify(snap);
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity;
  let serialized = serialize(localSnapshot);
  if (serialized.length <= limit) return { snapshot: localSnapshot, serialized, evicted: [] };

  // Array OR Set. `protectedThreadIds` travels this file as an ARRAY (see
  // retainBoundedThreads), and a `?.has` on it is silently `undefined` — which would
  // have made every protected thread evictable rather than throwing anywhere a test
  // could see it. Normalize instead of trusting the caller's shape.
  const asSet = (value) => (value instanceof Set
    ? value
    : new Set(Array.isArray(value) ? value : []));
  const protectedSet = asSet(protectedIds);
  const evictableSet = asSet(evictableIds);

  const threads = Array.isArray(localSnapshot.threads) ? localSnapshot.threads : [];
  const canEvict = (thread) => {
    const id = thread?.id;
    if (typeof id !== "string" || !id) return false;
    if (protectedSet.has(id)) return false;
    // An empty evictable set means nothing has been PROVEN durable. Fail closed: an
    // unbounded shadow is a quota bug, and deleting an only-copy transcript to fix
    // it is a worse one.
    return evictableSet.has(id);
  };

  // Cost each thread once. Re-serializing the whole snapshot per eviction is
  // quadratic exactly when it matters — the reported install had a legacy set large
  // enough to exhaust the origin — so evict against the estimate, then verify.
  const order = threads
    .filter(canEvict)
    .map((thread) => ({ id: thread.id, ts: finiteTs(thread.updatedAt || thread.ts), cost: serialize(thread).length }))
    .sort((a, b) => a.ts - b.ts);

  const evicted = [];
  let projected = serialized.length;
  for (const candidate of order) {
    if (projected <= limit) break;
    evicted.push(candidate.id);
    projected -= candidate.cost;
  }
  if (!evicted.length) return { snapshot: localSnapshot, serialized, evicted: [] };

  const dropped = new Set(evicted);
  const snapshot = { ...localSnapshot, threads: threads.filter((thread) => !dropped.has(thread.id)) };
  serialized = serialize(snapshot);
  // No verify-and-evict-more pass, and that is a claim rather than an omission:
  // dropping a thread removes its own serialization AND the comma separating it, so
  // the real saving is always at least `cost`. The estimate therefore UNDER-counts
  // what each eviction buys — it can overshoot the budget downward, never leave it
  // exceeded. An earlier draft carried a "finish the job exactly" loop here; no
  // input could reach it, and a guard nothing can trigger reads as protection to the
  // next person while protecting nothing. The invariant is pinned by test instead.
  return { snapshot, serialized, evicted };
}

/**
 * Hashes of the workflow versions whose restorable graph payload a snapshot is PROVEN
 * to hold, per thread id (#861 recurrence).
 *
 * A thread carries up to 20 versions x 300KB of serialized graph INSIDE its own
 * record, and the live thread is protected from eviction — so while those payloads
 * sit in the localStorage shadow, the byte bound above cannot hold. That is exactly
 * the reported case: a long chat on a frequently edited graph re-wedged the shared
 * origin quota even with the cap in place, and ComfyUI's saveDraft() failed again.
 *
 * The hash is content-addressed, so a hash present in the canonical record — WITH
 * its snapshot — is the whole proof that the shadow's copy of that payload is a
 * cache. This is the receipt that licenses stripping it there.
 */
function versionPayloadReceipts(snapshot) {
  const receipts = new Map();
  for (const thread of Array.isArray(snapshot?.threads) ? snapshot.threads : []) {
    if (typeof thread?.id !== "string" || !thread.id) continue;
    for (const [hash, version] of Object.entries(thread.workflowVersions || {})) {
      if (version && typeof version === "object" && version.snapshot !== undefined) {
        let held = receipts.get(thread.id);
        if (!held) receipts.set(thread.id, (held = new Set()));
        held.add(hash);
      }
    }
  }
  return receipts;
}

/**
 * The shadow copy of a thread with its canonical-durable version payloads reduced to
 * metadata (#861 recurrence). The version LIST survives — hash, capturedAt, node
 * count, title — so startup paint and the history UI are unchanged; only the
 * restorable graph leaves, and only for versions the receipt proves canonical holds.
 * The in-memory thread is never touched: any later canonical write re-supplies every
 * payload from it, so a stripped shadow cannot become the only copy. Versions with
 * no receipt keep their payload — fail closed, exactly like an un-receipted legacy
 * thread keeping its place in the shadow.
 */
function stripDurableVersionPayloads(thread, receipts) {
  const held = receipts.get(thread?.id);
  const versions = thread?.workflowVersions;
  if (!held || !versions || typeof versions !== "object") return thread;
  let changed = false;
  const kept = Object.create(null);
  for (const [hash, version] of Object.entries(versions)) {
    if (held.has(hash) && version && typeof version === "object" && version.snapshot !== undefined) {
      const { snapshot: _dropped, ...metadata } = version;
      kept[hash] = metadata;
      changed = true;
    } else {
      kept[hash] = version;
    }
  }
  return changed ? { ...thread, workflowVersions: kept } : thread;
}

/**
 * Read every quarantined pre-v3 transcript out of the legacy store (#861).
 *
 * Returns `null` — NOT `[]` — when the store cannot be reached. The difference is
 * load-bearing: an empty store means "there are none", and an unreachable one means
 * "unknown". Only the first licenses bounding the localStorage shadow; treating the
 * second as empty would drop transcripts whose durable copy we merely failed to read.
 */
async function idbReadLegacy(indexedDb) {
  const db = await openDb(indexedDb);
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains(CHAT_HISTORY_LEGACY_STORE)) return null;
    return await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(CHAT_HISTORY_LEGACY_STORE, "readonly");
      } catch {
        resolve(null);
        return;
      }
      const req = tx.objectStore(CHAT_HISTORY_LEGACY_STORE).getAll();
      req.onsuccess = () => resolve(
        // Structural, not by key: the marker is the record that carries an `ids` list
        // and no thread `id`. Callers already require a string id, but saying so here
        // means one place decides what is a transcript.
        Array.isArray(req.result)
          ? req.result.filter((record) => record && typeof record.id === "string" && record.id)
          : null,
      );
      req.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Put every legacy thread into the legacy store, keyed by thread id (#861).
 *
 * ONE record per thread rather than one blob: a single oversized transcript then
 * cannot block the rest from becoming durable, and a re-run overwrites in place
 * instead of appending — so the migration is idempotent and can safely run on every
 * read until it succeeds.
 *
 * Returns THE IDS IT STORED, or null if the transaction did not complete — not a
 * bare boolean. The caller grants receipts from this, and a boolean let it grant one
 * for a thread this function had filtered out (a colliding reserved key), i.e. a
 * receipt for something that was never written.
 *
 * `oncomplete`, not the last `onsuccess`: individual puts succeed against a
 * transaction that later aborts on quota, and reporting that as durable is what would
 * license deleting the only other copy.
 */
/**
 * What a legacy record must match for its stored copy to stand in for the live one
 * (#861, codex P1).
 *
 * `_durableLegacyIds` was a set of IDS, and an id is not a receipt for CONTENT. A
 * legacy thread that was written once and then EDITED — renamed, pinned, a message
 * tombstoned — was filtered out of every later write as "already durable" while the
 * stored copy stayed at the old version. The shadow would then evict the new version
 * on the strength of a receipt for the old one, report `legacyComplete: true`, and
 * clear the dirty flag. That is the data loss this whole change exists to avoid,
 * reintroduced one level down.
 *
 * A DIGEST OF THE CONTENT, not a description of it (codex). An earlier draft used
 * updatedAt + message count + serialized length, and codex was right that this is not
 * a receipt: `"foo"` -> `"bar"` inside one message keeps all three identical, and
 * `Date.now()` is not a monotonic per-edit revision, so a same-millisecond edit slips
 * through and the shadow evicts the new text against the old copy. For a durability
 * gate, "probably unchanged" is not a category.
 *
 * 64 bits of FNV-1a over the serialized thread — the same construction the panel
 * already uses for media ids. It reads the whole record, so it cannot miss an edit
 * the way a length can; it is not cryptographic, which does not matter here because
 * the adversary is an accident, not an attacker.
 */
function legacyFingerprint(thread) {
  if (!thread || typeof thread !== "object") return "";
  let serialized;
  try {
    serialized = JSON.stringify(thread);
  } catch {
    // Uncloneable/circular: return "" so it never matches a receipt and the thread
    // stays unevictable. Fail closed.
    return "";
  }
  if (typeof serialized !== "string") return "";
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < serialized.length; i += 1) {
    const code = serialized.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = Math.imul(b ^ code, 16777619) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * A reserved key inside the legacy store holding ids whose delete has not landed
 * (#861, codex r3).
 *
 * The retry intent used to live only in memory, and codex was right that a reload
 * loses it: `meta.deletedThreads` is capped, so if the tombstone ages out before any
 * retry the record is absent from both tombstone sources AND from the new tab's empty
 * pending set — never retried, and free to restore.
 *
 * It lives in the `snapshots` store, NOT beside the transcripts (codex r5). Sharing a
 * key space with records keyed by THREAD ID is only safe while no thread id can equal
 * the marker key, and ids are normally minted by crypto.randomUUID() but an IMPORTED
 * history can carry anything. Refusing to store such a thread guards new writes and
 * does nothing about a database that already holds one. `snapshots` is keyed by fixed
 * names, so the collision cannot arise in either direction — a better answer than a
 * guard that only covers one of them.
 */
const LEGACY_PENDING_DELETES_KEY = "__cmcp_legacy_pending_deletes";

/** Coerce a stored delete record into `{pending, deleted}` of clean string ids.
 *  Tolerates the absent case and any shape a partial write could leave. */
function normalizeDeleteRecord(raw) {
  const clean = (v) => (Array.isArray(v) ? v.filter((id) => typeof id === "string" && id) : []);
  return { pending: clean(raw?.pending), deleted: clean(raw?.deleted) };
}

/**
 * Read the durable delete record: `{pending, deleted}` (#861, codex r6).
 *
 * TWO lists, and the second is why this is a fence rather than a hint. Removing an
 * id once its delete landed left a window codex named: a stale tab that starts its
 * write AFTER the removal sees nothing and puts the record back, with no intent
 * anywhere to remove it again. The canonical tombstone does not cover this —
 * verified, and it is the reason the window exists: a legacy thread was never IN
 * canonical, so compaction prunes a tombstone that has no thread to point at.
 *
 * A permanently retained `deleted` list would be unbounded for ordinary threads.
 * It is not here, and that is a property of what these records ARE: `legacyShadow`
 * threads are pre-v3 content, migrated once and never created again, so the set of
 * ids that can ever appear is closed and finite. The list cannot outgrow the
 * transcripts it is about.
 */
async function idbReadDeleteRecord(indexedDb) {
  const empty = { pending: [], deleted: [] };
  const db = await openDb(indexedDb);
  if (!db) return empty;
  try {
    if (!db.objectStoreNames.contains("snapshots")) return empty;
    return await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction("snapshots", "readonly");
      } catch {
        resolve(empty);
        return;
      }
      const req = tx.objectStore("snapshots").get(LEGACY_PENDING_DELETES_KEY);
      req.onsuccess = () => resolve(normalizeDeleteRecord(req.result));
      req.onerror = () => resolve(empty);
      tx.onabort = () => resolve(empty);
    });
  } catch {
    return empty;
  } finally {
    db.close();
  }
}

/**
 * Merge into the durable delete record, in ONE transaction (codex r4/r6).
 *
 * NOT a whole-list overwrite. Two tabs both retrying is ordinary: tab A finishes
 * `L0` and writes `[]` while tab B's delete of `L1` fails and writes `[L1]`. If A's
 * stale `[]` lands last it erases B's durable intent, B closes, `L1`'s capped
 * tombstone ages out, and the whole reload hole is back. Reading and writing inside
 * the same readwrite transaction makes the merge atomic against the other tab.
 *
 * Best effort: a store that will not take the marker is a store that will not be
 * taking new records either, and the in-memory set still drives retries here.
 */
async function idbMergeDeleteRecord(indexedDb, { pending = [], deleted = [] } = {}) {
  const toPend = pending.filter((id) => typeof id === "string" && id);
  const toDelete = deleted.filter((id) => typeof id === "string" && id);
  if (!toPend.length && !toDelete.length) return true;
  const db = await openDb(indexedDb);
  if (!db) return false;
  try {
    if (!db.objectStoreNames.contains("snapshots")) return false;
    return await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction("snapshots", "readwrite");
      } catch {
        resolve(false);
        return;
      }
      const store = tx.objectStore("snapshots");
      let req;
      try {
        req = store.get(LEGACY_PENDING_DELETES_KEY);
      } catch {
        resolve(false);
        return;
      }
      req.onsuccess = () => {
        const held = normalizeDeleteRecord(req.result);
        // A landed delete MOVES its id from pending to deleted; it never just
        // disappears. Disappearing is what left the post-removal window.
        const done = new Set([...held.deleted, ...toDelete]);
        const owed = [...new Set([...held.pending, ...toPend])].filter((id) => !done.has(id));
        try {
          if (owed.length || done.size) {
            store.put({ pending: owed, deleted: [...done] }, LEGACY_PENDING_DELETES_KEY);
          } else {
            store.delete(LEGACY_PENDING_DELETES_KEY);
          }
        } catch {
          // The transaction settles below either way.
        }
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Delete legacy records by key — used for tombstoned threads (#861, codex P1). */
async function idbDeleteLegacy(indexedDb, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id))];
  if (!list.length) return true;
  const db = await openDb(indexedDb);
  if (!db) return false;
  try {
    if (!db.objectStoreNames.contains(CHAT_HISTORY_LEGACY_STORE)) return null;
    return await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(CHAT_HISTORY_LEGACY_STORE, "readwrite");
      } catch {
        resolve(false);
        return;
      }
      const store = tx.objectStore(CHAT_HISTORY_LEGACY_STORE);
      try {
        for (const id of list) store.delete(id);
      } catch {
        resolve(false);
        return;
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * Empty the legacy store (#861, codex P1).
 *
 * `clearAll` is the user saying delete everything. Without this the legacy store
 * would survive the reset and `_restoreLegacyShadow` would hand every cleared
 * transcript back on the next load — a delete that undoes itself, which is worse
 * than one that fails loudly.
 */
async function idbClearLegacy(indexedDb) {
  const db = await openDb(indexedDb);
  if (!db) return false;
  try {
    if (!db.objectStoreNames.contains(CHAT_HISTORY_LEGACY_STORE)) return true;
    return await new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(CHAT_HISTORY_LEGACY_STORE, "readwrite");
      } catch {
        resolve(false);
        return;
      }
      try {
        tx.objectStore(CHAT_HISTORY_LEGACY_STORE).clear();
      } catch {
        resolve(false);
        return;
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch {
    return false;
  } finally {
    db.close();
  }
}

async function idbWriteLegacy(indexedDb, threads) {
  const list = Array.isArray(threads)
    ? threads.filter((t) => t && typeof t.id === "string" && t.id)
    : [];
  // `[]`, not `true` (codex r5). Callers do `new Set(written || [])`, and
  // `new Set(true)` THROWS — so a history whose only legacy thread was refused for
  // colliding with the reserved key would have broken restoration outright, in the
  // uncaught restore path. A fail-closed input has to fail closed all the way down.
  if (!list.length) return [];
  const db = await openDb(indexedDb);
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains(CHAT_HISTORY_LEGACY_STORE)) return null;
    if (!db.objectStoreNames.contains("snapshots")) return null;
    return await new Promise((resolve) => {
      let tx;
      try {
        // BOTH stores, ONE transaction (codex r5). Another tab can be mid-delete:
        // B records a pending delete of L1, A completes it, and a third tab still
        // holding L1 as live writes it straight back — leaving a record with no
        // outstanding intent to remove it again. Reading the marker inside the same
        // transaction as the put makes that interleaving unobservable.
        tx = db.transaction([CHAT_HISTORY_LEGACY_STORE, "snapshots"], "readwrite");
      } catch {
        resolve(null);
        return;
      }
      let written = [];
      let req;
      try {
        req = tx.objectStore("snapshots").get(LEGACY_PENDING_DELETES_KEY);
      } catch {
        resolve(null);
        return;
      }
      req.onsuccess = () => {
        const held = normalizeDeleteRecord(req.result);
        // Both lists. `pending` covers a delete still in flight; `deleted` covers
        // one that already landed, which is the window a stale tab writes into —
        // it starts after the id was cleared, sees nothing, and puts the record
        // back with no intent anywhere to remove it again.
        const fenced = new Set([...held.pending, ...held.deleted]);
        const allowed = list.filter((thread) => !fenced.has(thread.id));
        try {
          const store = tx.objectStore(CHAT_HISTORY_LEGACY_STORE);
          for (const thread of allowed) store.put(thread, thread.id);
          written = allowed.map((thread) => thread.id);
        } catch {
          written = [];
        }
      };
      tx.oncomplete = () => resolve(written);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } catch {
    return null;
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
      // legacyShadow threads never enter canonical (the schema-3 fence). But
      // the RESOLVED snapshot must keep them — persist() rewrites the local
      // shadow from this result, and a canonical-only result would erase the
      // very threads the quarantine exists to retain (codex finding).
      const withoutLegacyShadow = (snap) =>
        snap && Array.isArray(snap.threads)
          ? { ...snap, threads: snap.threads.filter((thread) => !thread?.legacyShadow) }
          : snap;
      let merged = compactSnapshot(boundedSnapshot(withoutCheckpoint(snapshot), limits), limits);
      get.onsuccess = () => {
        const mergeResult = mergeUnderCanonicalCheckpoint(get.result, snapshot);
        merged = compactSnapshot(
          boundedSnapshot(mergeResult, limits),
          limits,
        );
        store.put(withoutLegacyShadow(merged), CHAT_HISTORY_STATE_KEY);
      };
      get.onerror = () => store.put(withoutLegacyShadow(merged), CHAT_HISTORY_STATE_KEY);
      tx.oncomplete = () => resolve(merged);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

async function idbResetHistory(indexedDb, snapshot, createReset) {
  const db = await openDb(indexedDb);
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const tx = db.transaction("snapshots", "readwrite");
      const store = tx.objectStore("snapshots");
      const get = store.get(CHAT_HISTORY_STATE_KEY);
      let reset = null;
      const replace = (canonical) => {
        const merged = mergeUnderCanonicalCheckpoint(canonical, snapshot);
        reset = createReset(merged);
        store.put(reset, CHAT_HISTORY_STATE_KEY);
      };
      get.onsuccess = () => replace(get.result);
      get.onerror = () => replace(null);
      tx.oncomplete = () => resolve(reset);
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
    // #861 — observability for the byte bound. Evicting from the shadow is normal
    // and lossless once a thread is durable, but it is not nothing, and a store that
    // silently shrinks what it shows is how the panel got into this in the first
    // place: usage nobody could see, failing somewhere else.
    this.onShadowEvict = typeof options.onShadowEvict === "function" ? options.onShadowEvict : null;
    this.maxShadowBytes = Number.isFinite(options.maxShadowBytes)
      ? options.maxShadowBytes
      : LOCAL_SHADOW_MAX_BYTES;
    this.lastDraftHeadroomOk = null;
    this.lastShadowBytes = 0;
    /**
     * What the legacy store has ACCEPTED, as id -> content fingerprint (#861).
     *
     * The receipt that licenses evicting a legacy thread from the shadow. Empty
     * until a legacy write completes, which is the fail-closed default: with no
     * durable copy proven, nothing legacy is evictable and the shadow behaves
     * exactly as it does today. A quota bug is worth fixing; it is not worth
     * deleting the only copy of someone's transcripts to fix.
     *
     * A FINGERPRINT, not just an id (codex P1). An id-only receipt says a thread by
     * that name was stored once; it does not say the stored copy is the one about to
     * be evicted. An edited legacy thread would otherwise be dropped from the shadow
     * against a receipt for its previous version.
     */
    this._durableLegacy = new Map();
    /**
     * Legacy ids whose durable DELETE has not landed yet (#861, codex).
     *
     * `meta.deletedThreads` is capped, so a tombstone ages out. A delete that failed
     * while its tombstone was still live would then stop being retried and the record
     * would come back on the next load. This remembers the intent independently of
     * the map that expires, and also suppresses the restore in the meantime.
     */
    this._pendingLegacyDeletes = new Set();
    /** Legacy ids this session has already deleted, so a still-live tombstone does
     *  not re-issue the same no-op delete on every persist. */
    this._legacyDeletesDone = new Set();
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
      // A genuinely new thread needs a CAUSAL creation stamp: without one,
      // normalization synthesizes createdRevision from createdAt, which a
      // future-dated checkpoint then classifies as pre-checkpoint and drops
      // (the whole fresh conversation vanishes on merge/reload — codex finding).
      if (!thread.createdRevision) thread.createdRevision = revision;
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
    // Same causal-creation guarantee as threads: a checkpoint at/ahead of wall
    // clock must not read this genuinely-new message as pre-checkpoint.
    if (!message.createdRevision) message.createdRevision = revision;
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
      // Same dual condition as persist(): raw idlessness (pre-v3 shadows) and
      // legacyShadow (already-fenced content) both keep the snapshot fenced.
      if (hasIdlessMessages(local.threads) || local.threads.some((t) => t?.legacyShadow === true)) {
        normalized[LEGACY_IDLESS_SOURCE] = true;
      }
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
    const withLegacy = await this._restoreLegacyShadow(merged);
    this._observeSnapshot(withLegacy);
    return withLegacy;
  }

  /**
   * Re-attach durably-stored legacy transcripts, and migrate any that are still
   * shadow-only (#861).
   *
   * Runs on every canonical read, deliberately. The migration is a `put` per thread
   * keyed by id, so re-running it overwrites in place and costs nothing once
   * everything is durable — which means a browser that was in private mode, or out
   * of quota, or mid-upgrade on the first attempt simply succeeds on a later one
   * rather than needing a one-shot migration flag that can be wrong.
   *
   * Reading returns `null` when the store is UNREACHABLE and `[]` when it is empty.
   * Only the empty case may clear the durable receipts; treating unreachable as
   * empty would revoke the licence to evict — harmless — but treating it as
   * authoritative would let a later write believe threads were already durable when
   * they were not.
   */
  async _restoreLegacyShadow(snapshot) {
    const stored = await idbReadLegacy(this.indexedDb);
    // Durable retry intent first (codex r3): a delete that failed in a PREVIOUS tab
    // must keep being retried and must keep being suppressed, even after its
    // tombstone has aged out of the capped map.
    const deleteRecord = await idbReadDeleteRecord(this.indexedDb);
    for (const id of deleteRecord.pending) this._pendingLegacyDeletes.add(id);
    const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
    if (stored === null) {
      // Unreachable. Keep whatever the shadow gave us and prove nothing durable.
      this._durableLegacy = new Map();
      return snapshot;
    }
    // `idbReadLegacy` is the one place that decides what counts as a transcript, so
    // nothing here re-checks for a string id. Duplicating that test would make the
    // real guard untestable — remove it and every assertion still passes — which is
    // how a decorative check ends up reading as protection.
    this._durableLegacy = new Map(
      stored.map((thread) => [thread.id, legacyFingerprint(thread)]),
    );
    // The stored copy is additive: a thread the shadow already lost to a byte
    // eviction comes back here, which is the whole point of giving it a home.
    const known = new Set(threads.map((thread) => thread?.id).filter(Boolean));
    // A tombstoned thread must NOT come back (codex P1). The delete-from-store pass
    // in persist() is the durable half; this is the half that holds even when that
    // write has not landed yet — an unreachable store must not resurrect a delete.
    const tombstoned = new Set([
      ...Object.keys(snapshot?.meta?.deletedThreads || {}),
      // …anything whose durable delete has not landed yet, whose tombstone may
      // already have aged out of the capped map above…
      ...this._pendingLegacyDeletes,
      // …and anything already deleted for good. Without this a record another tab
      // put back after the delete landed would be restored as live history.
      ...deleteRecord.deleted,
    ]);
    const restored = stored
      .filter((thread) => !known.has(thread.id))
      .filter((thread) => !tombstoned.has(thread.id))
      .map((thread) => ({ ...thread, legacyShadow: true }));
    // Anything flagged in the shadow but not yet durable gets its home now.
    const pending = threads.filter(
      (thread) => thread?.legacyShadow === true && thread?.id
        && this._durableLegacy.get(thread.id) !== legacyFingerprint(thread),
    );
    if (pending.length) {
      const written = await idbWriteLegacy(this.indexedDb, pending);
      const stored = new Set(written || []);
      for (const thread of pending) {
        if (stored.has(thread.id)) this._durableLegacy.set(thread.id, legacyFingerprint(thread));
      }
    }
    if (!restored.length) return snapshot;
    const all = [...threads, ...restored].sort(
      (a, b) => finiteTs(a.updatedAt || a.ts) - finiteTs(b.updatedAt || b.ts),
    );
    return { ...snapshot, threads: all };
  }

  _writeLocalSnapshot(snapshot, protectedThreadIds, { canonicalDurable = false } = {}) {
    // legacyShadow threads are excluded from IndexedDB by the schema fence, so
    // the local shadow is their only copy. Preserve every such thread and all
    // of its messages. A storage-quota failure is surfaced instead of claiming
    // that a truncated only-copy transcript was saved durably.
    const sourceThreads = Array.isArray(snapshot.threads) ? snapshot.threads : [];
    const legacyThreads = sourceThreads.filter((thread) => thread?.legacyShadow === true);
    const ordinaryThreads = sourceThreads.filter((thread) => thread?.legacyShadow !== true);
    const boundedOrdinary = retainBoundedThreads(
      ordinaryThreads,
      LOCAL_SHADOW_THREADS,
      protectedThreadIds,
    ).map((thread) => ({
      ...thread,
      msgs: thread.msgs.slice(-LOCAL_SHADOW_MESSAGES),
    }));
    // #861 recurrence — shed workflow-version PAYLOADS the canonical record is proven
    // to hold before the byte bound is measured. Without this the bound cannot hold:
    // the versions ride inside the live thread, and the live thread is protected from
    // eviction. When this write follows the canonical merge, the snapshot itself is
    // the receipt; otherwise the last committed canonical state is. No receipt — the
    // first persist of a session, or any install where IndexedDB is unavailable — and
    // every payload stays, because then the shadow is still their only copy.
    const payloadReceipts = versionPayloadReceipts(canonicalDurable ? snapshot : this._lastCommitted);
    const shadow = [
      ...boundedOrdinary.map((thread) => stripDurableVersionPayloads(thread, payloadReceipts)),
      ...legacyThreads,
    ]
      .sort((a, b) => finiteTs(a.updatedAt || a.ts) - finiteTs(b.updatedAt || b.ts));
    // #861 — the byte bound. Everything here is a CACHE of something durable except
    // legacy threads, which are durable only once the legacy store has accepted
    // them. `_durableLegacy` is that receipt (id -> content fingerprint), and it is
    // the entire licence to
    // evict: with no receipt the set is empty, nothing legacy is evictable, and the
    // shadow keeps today's unbounded behaviour rather than deleting an only copy.
    const evictableIds = new Set();
    // Ordinary threads are a cache of CANONICAL — but only once canonical has
    // actually accepted them. Before the IndexedDB merge lands (and on any install
    // where IndexedDB is unavailable) the shadow is their only copy too, so the same
    // rule applies to them as to legacy ones: no durable copy, no eviction.
    if (canonicalDurable) {
      for (const thread of boundedOrdinary) if (thread?.id) evictableIds.add(thread.id);
    }
    for (const thread of legacyThreads) {
      if (thread?.id && this._durableLegacy?.get(thread.id) === legacyFingerprint(thread)) {
        evictableIds.add(thread.id);
      }
    }
    const bounded = boundShadowBytes(
      { ...snapshot, threads: shadow },
      { maxBytes: this.maxShadowBytes, evictableIds, protectedIds: protectedThreadIds },
    );
    const localSnapshot = bounded.snapshot;
    const keptThreads = Array.isArray(localSnapshot.threads) ? localSnapshot.threads : [];
    if (bounded.evicted.length) this.onShadowEvict?.(bounded.evicted, bounded.serialized.length);
    const shadowById = new Map(keptThreads.map((thread) => [thread.id, thread]));
    const complete = snapshot.threads.length === keptThreads.length &&
      snapshot.threads.every((thread) =>
        shadowById.get(thread.id)?.msgs?.length === thread.msgs.length);
    // A legacy thread missing from the shadow is only acceptable if the legacy store
    // holds it. This is what keeps `legacyComplete` honest — and it is the reason a
    // byte cap alone would have been wrong: without the receipt this reports false,
    // `result.ok` stays false, `_dirtyWrite` is retained, and every later persist
    // fires onPersistenceError forever against a state that can never fit.
    const legacyComplete = legacyThreads.every((thread) =>
      shadowById.has(thread.id) || this._durableLegacy?.get(thread.id) === legacyFingerprint(thread));
    const shadowKeys = [this.snapshotKey, this.threadsKey, this.metaKey];
    const dropDuplicateKeys = () => {
      // The two-key shadow is a cache of the atomic snapshot (and of IndexedDB
      // once canonicalDurable). Dropping it is not a delete of user data — it
      // is how an already-full origin gets the headroom ComfyUI needs (#1305).
      // Never run this without a durable copy: the caller gates on
      // canonicalDurable.
      try { this.storage?.removeItem(this.threadsKey); } catch { /* ignore */ }
      try { this.storage?.removeItem(this.metaKey); } catch { /* ignore */ }
    };
    const measure = () => {
      this.lastShadowBytes = measurePanelShadowBytes(this.storage, shadowKeys);
      return this.lastShadowBytes;
    };

    let snapshotOk = writeLocalStorageItem(this.storage, this.snapshotKey, bounded.serialized);
    if (!snapshotOk && canonicalDurable) {
      dropDuplicateKeys();
      snapshotOk = writeLocalStorageItem(this.storage, this.snapshotKey, bounded.serialized);
    }
    if (!snapshotOk) {
      this.lastShadowWriteOk = false;
      this.lastShadowError = writeLocalStorageItem.lastError
        || new Error("localStorage shadow write failed");
      this.onShadowError?.(this.lastShadowError);
      measure();
      return { committed: false, complete: false, legacyComplete: false };
    }
    this.lastShadowWriteOk = true;
    this.lastShadowError = null;

    const threadsJson = JSON.stringify(keptThreads);
    const metaJson = JSON.stringify(snapshot.meta ?? {});
    const totalIfDuplicated = bounded.serialized.length + threadsJson.length + metaJson.length;
    if (canonicalDurable && totalIfDuplicated > this.maxShadowBytes) {
      // The byte bound was on the snapshot alone, so writing threads+meta
      // again doubled the panel's share and left ComfyUI no room. Once
      // canonical holds the transcripts, the two-key copy is the leftover
      // occupancy #1305 is about — drop it rather than keep a second 1.5MB.
      dropDuplicateKeys();
    } else {
      writeLocalStorageItem(this.storage, this.threadsKey, threadsJson);
      writeLocalStorageItem(this.storage, this.metaKey, metaJson);
    }
    measure();
    return { committed: true, complete, legacyComplete };
  }

  persist(threads, meta = {}, options = {}) {
    if (this._closed) return this._lastCommitted || mergeHistorySnapshots({ threads, meta });
    const freshSnapshot = mergeHistorySnapshots({ threads, meta });
    // Flag on raw idlessness (legacy pre-v3 writers) AND on legacyShadow threads
    // (already-fenced content): normalization assigns ids BEFORE this point, so
    // without the legacyShadow check a quarantined thread would launder through
    // the fence into canonical on the very next persist.
    if (hasIdlessMessages(threads) ||
        (Array.isArray(threads) && threads.some((t) => t?.legacyShadow === true))) {
      freshSnapshot[LEGACY_IDLESS_SOURCE] = true;
    }
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
    const shadowWrite = this._writeLocalSnapshot(snapshot, protectedThreadIds);
    // Start the atomic merge immediately. Chat records are low-frequency and a
    // debounce creates an avoidable shutdown window in which the local shadow
    // exists but IndexedDB has not started its transaction yet.
    this._writePromise = this._writePromise
      .catch(() => null)
      .then(() => idbMergeWrite(this.indexedDb, snapshot, limits))
      // #861 — give the quarantined transcripts their durable home BEFORE the
      // shadow is rewritten. Order is the safety property: the receipt earned here
      // is what `_writeLocalSnapshot` consults to decide whether a legacy thread may
      // be evicted, so a write that fails simply leaves it unevictable rather than
      // dropping the only copy. Never rejects — a legacy store that cannot be
      // reached must not take the canonical write down with it.
      .then(async (merged) => {
        const legacy = (Array.isArray(merged?.threads) ? merged.threads : snapshot.threads || [])
          .filter((thread) => thread?.legacyShadow === true && thread?.id);
        // Fingerprint, not id (codex P1): an EDITED legacy thread must be rewritten,
        // or the shadow would evict the new version against a receipt for the old.
        const stale = legacy.filter(
          (thread) => this._durableLegacy.get(thread.id) !== legacyFingerprint(thread),
        );
        if (stale.length) {
          try {
            const written = await idbWriteLegacy(this.indexedDb, stale);
            if (written) {
              // Only what it actually stored. A thread it refused (a colliding
              // reserved key) must not collect a receipt it cannot honour.
              const stored = new Set(written);
              for (const thread of stale) {
                if (stored.has(thread.id)) {
                  this._durableLegacy.set(thread.id, legacyFingerprint(thread));
                }
              }
            }
          } catch {
            // Unreachable legacy store: nothing becomes evictable. Fail closed.
          }
        }
        // A DELETED legacy thread must LEAVE the store, or the next load hands it
        // straight back (codex P1). Driven by the tombstone map, never by 'absent
        // from the snapshot' — absent is also exactly what a byte eviction looks
        // like, and deleting on that would erase the threads this store exists to
        // keep.
        // BOTH sides. Canonical compaction can prune a tombstone whose thread is
        // already gone from canonical — verified: the merged snapshot came back with
        // an empty deletedThreads while the write that carried the delete still had
        // it. Reading only the merged copy would leave the durable record behind and
        // the next load would hand the deleted transcript back.
        // BOTH sources, not merged-or-snapshot. Canonical NEVER contains legacyShadow
        // threads (idbMergeWrite strips them), so a live-id set read from `merged`
        // alone is empty for exactly the threads this delete pass operates on — and
        // the guard would protect nothing.
        const liveIds = new Set(
          [
            ...(Array.isArray(merged?.threads) ? merged.threads : []),
            ...(Array.isArray(snapshot?.threads) ? snapshot.threads : []),
          ]
            .map((thread) => thread?.id)
            .filter((id) => typeof id === "string" && id),
        );
        const tombstoned = [...new Set([
          ...this._pendingLegacyDeletes,
          ...Object.keys(merged?.meta?.deletedThreads || {}),
          ...Object.keys(snapshot?.meta?.deletedThreads || {}),
        ])]
          // Never delete an id a LIVE thread is using (codex). A tombstone is a
          // statement about the thread that HELD an id, and ids can be reused or a
          // tombstone can lose a causal merge to a newer live version. Deleting by id
          // alone would take the live record with it.
          .filter((id) => !liveIds.has(id))
          // NOT gated on holding a receipt. A freshly opened tab has no receipts
          // until it reads, and gating on them meant it would skip a delete another
          // tab had left owing — the correctness gap an optimization bought. Deleting
          // an absent key is a no-op, so the only cost is a wasted key, and
          // `_legacyDeletesDone` keeps that to once per id per session.
          .filter((id) => !this._legacyDeletesDone.has(id));
        if (tombstoned.length) {
          // INTENT FIRST, then the delete (codex r7). A delete that succeeds on its
          // first attempt would otherwise never have been in `pending`, leaving an
          // unfenced interval between the record going away and the post-success
          // write recording it as deleted — a stale tab writing into that gap has
          // nothing to refuse it. Recording the intent up front makes the gap
          // impossible rather than short: the fence exists before the record does
          // not.
          try {
            await idbMergeDeleteRecord(this.indexedDb, { pending: tombstoned });
          } catch {
            // Best effort. The delete below still runs; the in-memory set still
            // drives retries in this tab.
          }
          let deleted = false;
          try {
            deleted = await idbDeleteLegacy(this.indexedDb, tombstoned);
          } catch {
            deleted = false;
          }
          if (deleted) {
            for (const id of tombstoned) {
              this._durableLegacy.delete(id);
              this._pendingLegacyDeletes.delete(id);
              this._legacyDeletesDone.add(id);
            }
          } else {
            // Remember it OURSELVES rather than trusting the tombstone to still be
            // there next time (codex). meta.deletedThreads is capped at
            // DEFAULT_MAX_TOMBSTONES, so an old tombstone ages out — and a delete that
            // failed while its tombstone was still live would then stop being retried,
            // leaving the record to be restored on the next load. A delete the user
            // asked for is retried until it lands.
            for (const id of tombstoned) this._pendingLegacyDeletes.add(id);
          }
          // Mirror the intent into the store so it survives a reload (codex r3).
          // In-memory alone loses the retry when the tab closes, and if the capped
          // tombstone map has aged the id out by the time a new tab looks, nothing
          // ever retries and the record can restore.
          //
          // The DELTA, never the whole set (codex r4): another tab's outstanding
          // delete must not be erased by this tab writing a list that predates it.
          try {
            await idbMergeDeleteRecord(this.indexedDb, {
              // A landed delete is recorded PERMANENTLY, not erased (codex r6): a
              // stale tab writing after the erase saw nothing and put the record
              // back. Bounded by construction — legacyShadow ids are a closed set.
              pending: deleted ? [] : tombstoned,
              deleted: deleted ? tombstoned : [],
            });
          } catch {
            // Best effort: the in-memory set still drives retries in this tab.
          }
        }
        return merged;
      })
      .then((merged) => {
        let postMergeShadowWrite = null;
        let draftHeadroom = null;
        if (merged) {
          this._lastCommitted = merged;
          this._observeSnapshot(merged);
          postMergeShadowWrite = this._writeLocalSnapshot(merged, protectedThreadIds, {
            canonicalDurable: true,
          });
          // After the shadow has been given a chance to shrink, ask whether
          // ComfyUI can still write its draft index. A failed probe is not a
          // failed history persist — do not dirty the write — but it is the
          // remaining #1305 failure, and it must be named rather than left
          // as ComfyUI's "Failed to save workflow draft" with no pointer.
          draftHeadroom = probeDraftIndexWrite(this.storage);
          this.lastDraftHeadroomOk = draftHeadroom;
          if (!draftHeadroom) {
            this.onPersistenceError?.({
              ok: true,
              code: "history-draft-headroom-unavailable",
              retryable: true,
              shadowCommitted: Boolean(postMergeShadowWrite?.committed),
              canonicalCommitted: true,
              panelBytes: this.lastShadowBytes,
            });
          }
          try {
            this._broadcastChannel?.postMessage({ type: "history-changed", writerId: this.writerId });
          } catch {
            // localStorage events remain available when the channel is blocked.
          }
        }
        const shadowOnlyComplete = !merged && shadowWrite.committed && shadowWrite.complete;
        const hasShadowOnlyLegacy = Boolean(
          merged?.threads?.some((thread) => thread?.legacyShadow === true),
        );
        const legacyShadowCommitted = !hasShadowOnlyLegacy ||
          shadowWrite.legacyComplete ||
          postMergeShadowWrite?.legacyComplete;
        const canonicalComplete = Boolean(merged) && legacyShadowCommitted;
        const anyShadowCommitted = shadowWrite.committed ||
          Boolean(postMergeShadowWrite?.committed);
        const result = {
          ok: Boolean(canonicalComplete || shadowOnlyComplete),
          shadowCommitted: anyShadowCommitted,
          canonicalCommitted: Boolean(merged),
          retryable: !canonicalComplete && !shadowOnlyComplete,
          code: merged && !legacyShadowCommitted
            ? "history-legacy-shadow-unavailable"
            : !merged
            ? shadowWrite.committed && !shadowWrite.complete
              ? "history-canonical-unavailable-shadow-truncated"
              : !shadowWrite.committed
                ? "history-persistence-unavailable"
                : null
            : null,
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

  /** Remove every transcript as one canonical checkpoint. This deliberately
   * does not delete the IndexedDB database: doing so would also erase workflow
   * aliases and would let a stale open tab recreate the old snapshot. */
  async clearAll(threads, meta = {}) {
    if (this._closed) {
      return {
        ok: false,
        canonicalCommitted: false,
        shadowCommitted: false,
        retryable: false,
        code: "history-store-closed",
      };
    }
    const localSnapshot = this._dirtyWrite
      ? mergeHistorySnapshots(this._dirtyWrite.snapshot, { threads, meta })
      : mergeHistorySnapshots({ threads, meta });
    this._observeSnapshot(localSnapshot);
    this._writePromise = this._writePromise
      .catch(() => null)
      .then(() => idbResetHistory(this.indexedDb, localSnapshot, (canonical) => {
        this._observeSnapshot(canonical);
        return createHistoryResetSnapshot(canonical, this.nextRevision());
      }))
      // #861 — clearAll is the user saying DELETE EVERYTHING, so the legacy store has
      // to go too. Without this the reset leaves those records behind and
      // `_restoreLegacyShadow` hands every cleared transcript back on the next load: a
      // delete that undoes itself.
      //
      // The outcome is CARRIED, not swallowed (codex). The canonical reset has already
      // happened by the time this runs, so a failed legacy clear cannot be undone —
      // but it must not be reported as a completed clear either, or the user is told
      // their transcripts are gone and then meets them again after a reload.
      .then(async (reset) => {
        if (!reset) return { reset, legacyCleared: true };
        let legacyCleared = false;
        try {
          legacyCleared = await idbClearLegacy(this.indexedDb);
        } catch {
          legacyCleared = false;
        }
        if (legacyCleared) {
          // The clear removed the pending-delete marker along with everything else,
          // which is correct: there is nothing left to owe a delete to.
          this._durableLegacy = new Map();
          this._pendingLegacyDeletes = new Set();
          this._legacyDeletesDone = new Set();
        }
        return { reset, legacyCleared };
      })
      .then(({ reset, legacyCleared }) => {
        if (!reset) {
          return {
            ok: false,
            canonicalCommitted: false,
            shadowCommitted: false,
            retryable: true,
            code: "history-clear-canonical-unavailable",
          };
        }
        this._lastCommitted = reset;
        this._dirtyWrite = null;
        this._observeSnapshot(reset);
        const shadowWrite = this._writeLocalSnapshot(reset, []);
        try {
          this._broadcastChannel?.postMessage({
            type: "history-reset",
            writerId: this.writerId,
            generation: reset.meta?.checkpoint?.generation || 0,
          });
        } catch {
          // localStorage events remain available when the channel is blocked.
        }
        return {
          // Canonical really was reset, so this is not a failed clear — but it is
          // not a COMPLETE one either while quarantined transcripts are still in
          // the legacy store (codex). Reported rather than swallowed, and
          // retryable, because a later clear can finish the job.
          ok: legacyCleared,
          canonicalCommitted: true,
          shadowCommitted: shadowWrite.committed,
          retryable: !legacyCleared,
          code: legacyCleared ? null : "history-clear-legacy-unavailable",
          snapshot: reset,
        };
      });
    return this._writePromise;
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
      notify();
    };
    const onBroadcast = (event) => {
      if (
        !["history-changed", "history-reset"].includes(event?.data?.type) ||
        event.data.writerId === this.writerId
      ) return;
      notify();
    };
    let active = true;
    // A read started before unsubscribe must not deliver into a dead panel —
    // a slow IDB read can otherwise fire the stale listener AFTER a replacement
    // panel mounted (it would clear shared session keys / push new_session on
    // behalf of a delete that panel already handled — codex finding).
    const notify = () => {
      void this.readCanonical().then((snapshot) => {
        if (active) listener(snapshot);
      });
    };
    eventTarget?.addEventListener?.("storage", onStorage);
    this._broadcastChannel?.addEventListener?.("message", onBroadcast);
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

  exportPayload(threads, meta = {}) {
    const snapshot = mergeHistorySnapshots({ threads, meta });
    return {
      format: CHAT_HISTORY_EXPORT_FORMAT,
      schemaVersion: CHAT_HISTORY_SCHEMA,
      exportedAt: new Date().toISOString(),
      threads: snapshot.threads.map(portableThread).filter(Boolean),
      // Workflow identity aliases are portable provenance. Active pointers,
      // provider sessions, tombstones, checkpoints, and CRDT operations are not:
      // importing those browser-local records could switch or delete local chats.
      meta: {
        workflowAliases: portableWorkflowAliases(snapshot.meta?.workflowAliases),
      },
    };
  }

  importPayload(value, currentThreads = [], currentMeta = {}) {
    const incoming = parseHistoryImport(value);
    const current = mergeHistorySnapshots({ threads: currentThreads, meta: currentMeta });
    const currentById = new Map(current.threads.map((thread) => [thread.id, thread]));
    const deletedThreadIds = new Set(Object.keys(current.meta?.deletedThreads || {}));
    const newThreadIds = new Set(
      incoming.threads
        .map((thread) => thread.id)
        .filter((id) => !deletedThreadIds.has(id) && !currentById.has(id)),
    );
    const retainedCount = current.threads.length;
    if (retainedCount + newThreadIds.size > this.maxThreads) {
      const error = new Error(
        `Import needs ${newThreadIds.size} new chat slot(s), but only ` +
        `${Math.max(0, this.maxThreads - retainedCount)} of ${this.maxThreads} are available. ` +
        "Delete or export older chats first; no history was changed.",
      );
      error.code = "history-import-thread-limit";
      throw error;
    }
    const incomingMessageIds = new Map();
    for (const source of incoming.threads) {
      if (deletedThreadIds.has(source.id)) continue;
      const ids = incomingMessageIds.get(source.id) || new Set();
      for (const message of source.msgs || []) {
        if (typeof message?.id === "string" && message.id) ids.add(message.id);
      }
      incomingMessageIds.set(source.id, ids);
    }
    for (const [threadId, ids] of incomingMessageIds) {
      const existingIds = new Set(
        (currentById.get(threadId)?.msgs || []).map((message) => message.id),
      );
      let additions = 0;
      for (const id of ids) if (!existingIds.has(id)) additions += 1;
      if (existingIds.size + additions <= this.maxMessages) continue;
      const error = new Error(
        `Import needs ${additions} new message slot(s) in chat ${threadId}, but only ` +
        `${Math.max(0, this.maxMessages - existingIds.size)} of ${this.maxMessages} are available. ` +
        "Start a new chat or remove older entries first; no history was changed.",
      );
      error.code = "history-import-message-limit";
      throw error;
    }

    this._observeSnapshot(current);
    const rebased = [];
    const importedVersionState = new Map();

    for (const source of incoming.threads) {
      const existing = currentById.get(source.id);
      const thread = existing
        ? cloneJson(existing)
        : {
          id: source.id,
          schemaVersion: CHAT_HISTORY_SCHEMA,
          createdAt: finiteTs(source.createdAt) || Date.now(),
          updatedAt: 0,
          ts: 0,
          msgs: [],
          deletedMessages: safeMap(),
          workflowVersions: safeMap(),
        };

      if (!existing) {
        const creation = this.nextRevision();
        thread.createdRevision = creation;
        thread.updatedAt = creation.updatedAt;
        thread.ts = creation.updatedAt;
      }

      const messages = new Map(
        (Array.isArray(thread.msgs) ? thread.msgs : []).map((message) => [message.id, message]),
      );
      for (const sourceMessage of source.msgs || []) {
        const previous = messages.get(sourceMessage.id);
        // Import is add-only for colliding ids. A portable archive can extend a
        // known conversation, but can never replace an existing local message.
        if (previous) continue;
        const message = portableMessage(sourceMessage);
        if (!message) continue;
        this.touchMessage(message);
        messages.set(message.id, message);
        thread.updatedAt = Math.max(finiteTs(thread.updatedAt), finiteTs(message.updatedAt));
      }
      thread.msgs = [...messages.values()].sort(
        (left, right) =>
          finiteTs(left.createdAt || left.ts) - finiteTs(right.createdAt || right.ts) ||
          String(left.id).localeCompare(String(right.id)),
      );
      if (existing) {
        const versions = Object.assign(safeMap(), thread.workflowVersions || {});
        let versionState = importedVersionState.get(source.id);
        if (!versionState) {
          versionState = {
            hashes: new Set(Object.keys(versions)),
            remaining: Math.max(
              0,
              DEFAULT_MAX_WORKFLOW_VERSIONS - Object.keys(versions).length,
            ),
          };
          importedVersionState.set(source.id, versionState);
        }
        for (const [hash, version] of Object.entries(source.workflowVersions || {})) {
          if (!versionState.remaining || versionState.hashes.has(hash)) continue;
          versions[hash] = version;
          versionState.hashes.add(hash);
          versionState.remaining -= 1;
        }
        thread.workflowVersions = versions;
      } else {
        thread.workflowVersions = mergeWorkflowVersions(source.workflowVersions);
      }

      // A colliding thread id is add-only: every local field wins, even when the
      // archive carries future timestamps or raw field tombstones. Only a
      // genuinely new thread materializes portable archive metadata.
      if (!existing) {
        const fields = {
          workflowKey: source.workflowKey,
          workflowTitle: source.workflowTitle,
          pinned: source.pinned,
          title: source.title,
          todos: source.todos,
          provider: source.provider,
          model: source.model,
          effort: source.effort,
        };
        this.reviseThread(thread, fields);
      }
      thread.updatedAt = Math.max(finiteTs(thread.updatedAt), finiteTs(thread.createdAt));
      thread.ts = thread.updatedAt;
      rebased.push(thread);
    }

    const baseThreads = current.threads;
    let meta = current.meta;
    const localAliases = portableWorkflowAliases(
      meta?.workflowAliases,
      Number.MAX_SAFE_INTEGER,
    );
    let availableAliases = Math.max(
      0,
      this.maxMetadataOps - Object.keys(localAliases).length,
    );
    let importedAliasCount = 0;
    let skippedAliasCount = 0;
    for (const [path, workflowUuid] of Object.entries(incoming.meta?.workflowAliases || {})) {
      if (Object.hasOwn(localAliases, path)) continue;
      if (!availableAliases) {
        skippedAliasCount += 1;
        continue;
      }
      meta = updateMetadataEntry(meta, "workflowAliases", path, workflowUuid, this.nextRevision());
      localAliases[path] = workflowUuid;
      availableAliases -= 1;
      importedAliasCount += 1;
    }

    const merged = mergeHistorySnapshots(
      { threads: baseThreads, meta },
      { threads: rebased, meta: {} },
    );
    return {
      ...merged,
      importedCount: incoming.threads.length,
      importedAliasCount,
      skippedAliasCount,
    };
  }

}
