/**
 * #2203 — recover a prompt_id when POST /prompt throws after the request left.
 *
 * A thrown fetch ("Failed to fetch") is indistinguishable from a reset while
 * reading the 200. The panel used to stop there: no prompt_id, and no honest
 * "safe to retry". This module stamps a client-generated id onto extra_data
 * BEFORE the request leaves, then reconciles that id (or, for a scoped run, the
 * unique queue-position mark) against GET /queue and GET /history.
 *
 * extra_data is NOT extra_pnginfo: the token is a sibling so saved images do
 * not embed it. Unknown extra_data keys are stored verbatim by ComfyUI and
 * come back on the queue tuple `[number, prompt_id, prompt, extra_data, outputs]`.
 */

export const DISPATCH_ID_FIELD = "cmcp_dispatch_id";

export function mintDispatchId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `cmcp-d-${crypto.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  return `cmcp-d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeId(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function readDispatchIdFromExtraData(extra) {
  if (!isPlainObject(extra)) return null;
  return normalizeId(extra[DISPATCH_ID_FIELD]);
}

/**
 * Return a new /prompt JSON string with `extra_data.cmcp_dispatch_id` set.
 * Null when the body cannot be stamped without dropping other fields.
 */
export function stampPromptDispatchId(bodyText, dispatchId) {
  const id = normalizeId(dispatchId);
  if (!id || typeof bodyText !== "string") return null;
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isPlainObject(body)) return null;
  const extra = body.extra_data;
  if (extra != null && !isPlainObject(extra)) return null;
  let text;
  try {
    text = JSON.stringify({
      ...body,
      extra_data: { ...(extra ?? {}), [DISPATCH_ID_FIELD]: id },
    });
  } catch {
    return null;
  }
  try {
    const check = JSON.parse(text);
    if (readDispatchIdFromExtraData(check?.extra_data) !== id) return null;
  } catch {
    return null;
  }
  return text;
}

/**
 * Stamp onto a fetchApi options object in place when possible so callers that
 * compare options by reference (verbatim-forward tests) keep seeing the same
 * object. extra_data is additive; prompt/number/targets are untouched.
 */
export function stampPromptDispatchOptions(options, dispatchId) {
  const stamped = stampPromptDispatchId(options?.body, dispatchId);
  if (stamped == null || stamped === options?.body) return options;
  if (options && typeof options === "object") {
    try {
      options.body = stamped;
      return options;
    } catch {
      return { ...options, body: stamped };
    }
  }
  return { ...(options ?? {}), body: stamped };
}

export function extraDataFromQueueRow(item) {
  if (Array.isArray(item) && item.length >= 4 && isPlainObject(item[3])) return item[3];
  if (isPlainObject(item) && isPlainObject(item.extra_data)) return item.extra_data;
  return null;
}

export function promptIdFromQueueRow(item) {
  if (Array.isArray(item)) return normalizeId(item[1]);
  if (isPlainObject(item)) return normalizeId(item.prompt_id);
  return null;
}

export function queueNumberFromRow(item) {
  if (Array.isArray(item) && typeof item[0] === "number" && Number.isFinite(item[0])) return item[0];
  if (isPlainObject(item) && typeof item.number === "number" && Number.isFinite(item.number)) {
    return item.number;
  }
  return null;
}

export function extraDataFromHistoryEntry(entry) {
  if (!isPlainObject(entry)) return null;
  if (isPlainObject(entry.extra_data)) return entry.extra_data;
  const prompt = entry.prompt;
  if (Array.isArray(prompt) && prompt.length >= 4 && isPlainObject(prompt[3])) return prompt[3];
  if (isPlainObject(prompt) && isPlainObject(prompt.extra_data)) return prompt.extra_data;
  return null;
}

export function promptIdFromHistoryEntry(key, entry) {
  if (isPlainObject(entry)) {
    if (Array.isArray(entry.prompt)) {
      const fromTuple = normalizeId(entry.prompt[1]);
      if (fromTuple) return fromTuple;
    }
    const fromField = normalizeId(entry.prompt_id);
    if (fromField) return fromField;
  }
  return normalizeId(key);
}

export function queueNumberFromHistoryEntry(entry) {
  if (!isPlainObject(entry) || !Array.isArray(entry.prompt)) return null;
  const n = entry.prompt[0];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function usableQueueMark(queueMark) {
  return typeof queueMark === "number" && Number.isFinite(queueMark) && queueMark !== 0 && queueMark !== -1
    ? queueMark
    : null;
}

function addUnique(list, id) {
  if (id && !list.includes(id)) list.push(id);
}

/**
 * Reconcile a dispatch against already-fetched /queue and /history bodies.
 *
 * @returns {{status:"recovered", promptId:string, source:string} | {status:"absent"} | {status:"unknown", reason:string}}
 */
export function matchDispatchPromptIds({ queueJson, historyJson, dispatchId, queueMark = null } = {}) {
  const want = normalizeId(dispatchId);
  const mark = usableQueueMark(queueMark);
  const byId = [];
  const byMark = [];

  let queueOk = false;
  if (isPlainObject(queueJson)) {
    const running = queueJson.queue_running;
    const pending = queueJson.queue_pending;
    if (Array.isArray(running) && Array.isArray(pending)) {
      queueOk = true;
      for (const item of [...running, ...pending]) {
        const pid = promptIdFromQueueRow(item);
        if (!pid) continue;
        if (want && readDispatchIdFromExtraData(extraDataFromQueueRow(item)) === want) addUnique(byId, pid);
        if (mark != null && queueNumberFromRow(item) === mark) addUnique(byMark, pid);
      }
    }
  }

  let historyOk = false;
  if (isPlainObject(historyJson) && !Array.isArray(historyJson)) {
    historyOk = true;
    for (const [key, entry] of Object.entries(historyJson)) {
      const pid = promptIdFromHistoryEntry(key, entry);
      if (!pid) continue;
      if (want && readDispatchIdFromExtraData(extraDataFromHistoryEntry(entry)) === want) addUnique(byId, pid);
      if (mark != null && queueNumberFromHistoryEntry(entry) === mark) addUnique(byMark, pid);
    }
  }

  if (byId.length === 1) return { status: "recovered", promptId: byId[0], source: "dispatch_id" };
  if (byId.length > 1) return { status: "unknown", reason: "multiple_dispatch_id_matches" };
  // The queue mark is NOT a per-dispatch receipt. Every prompt in a batch shares
  // it, and the counter restarts on page reload while ComfyUI's history persists --
  // so a single match can name an earlier batch item or a row from a previous
  // session, reporting a stale prompt_id AND counting this failed post as observed.
  // A unique match is still worth reporting as corroboration, but it cannot be a
  // receipt, so it stays unknown until the marker is unique per request.
  if (byMark.length === 1) {
    return { status: "unknown", reason: "queue_mark_is_not_a_receipt", markMatch: byMark[0] };
  }
  if (byMark.length > 1) return { status: "unknown", reason: "multiple_queue_mark_matches" };
  if (queueOk && historyOk) return { status: "absent" };
  return { status: "unknown", reason: "unreadable_queue_or_history" };
}

async function readJson(fetchApi, route) {
  try {
    const res = await fetchApi(route);
    if (!res) return undefined;
    // A FAILED endpoint is not evidence of an empty one. A 500 /history whose body
    // happens to be JSON (`{error: ...}`) used to read as a valid, empty history
    // map -- which, with an empty queue, produced "absent" and authorized a retry
    // on the strength of the server being broken. Only a 2xx counts; anything else
    // leaves the verdict unknown.
    if (typeof res.ok === "boolean" && !res.ok) return undefined;
    if (typeof res.status === "number" && (res.status < 200 || res.status >= 300)) return undefined;
    if (typeof res.json === "function") return await res.json();
    // Test doubles (and some frontend wrappers) only expose clone().json(),
    // matching classifyRunResponse's read of the /prompt body.
    if (typeof res.clone === "function") {
      const cloned = res.clone();
      if (cloned && typeof cloned.json === "function") return await cloned.json();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * Poll /queue then /history for the stamped dispatch id (and optional unique
 * queue mark). A unique match is recovered; a well-formed miss after the poll
 * window is absent (safe to retry); anything else stays unknown.
 */
export async function recoverPromptIdAfterDispatch({
  fetchApi,
  dispatchId,
  queueMark = null,
  attempts = 4,
  delayMs = 40,
  sleep = defaultSleep,
} = {}) {
  if (typeof fetchApi !== "function") return { status: "unknown", reason: "no_fetch" };
  const n = Math.max(1, Math.min(8, Math.floor(Number(attempts)) || 4));
  const wait = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 40;
  let last = { status: "unknown", reason: "no_attempt" };
  for (let i = 0; i < n; i++) {
    if (i > 0 && wait > 0) {
      try {
        await sleep(wait);
      } catch {
        /* a sleep failure must not block the next read */
      }
    }
    const queueJson = await readJson(fetchApi, "/queue");
    let historyJson = await readJson(fetchApi, "/history?max_items=64");
    if (historyJson === undefined) historyJson = await readJson(fetchApi, "/history");
    if (queueJson === undefined && historyJson === undefined) {
      return { status: "unknown", reason: "unreadable_queue_or_history" };
    }
    last = matchDispatchPromptIds({ queueJson, historyJson, dispatchId, queueMark });
    if (last.status === "recovered") return last;
  }
  return last;
}
