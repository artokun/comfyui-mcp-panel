import { collectNodeOutputMedia, mergeWithheldMedia } from "./node-output-media.js";

// Parse a ComfyUI `/history/<prompt_id>` entry into a terminal completion batch.
//
// The run-completion tracker keys delivery on live WS lifecycle events
// (execution_start → executed → execution_success). If the connection drops
// while a prompt is in flight, the terminal signal (execution_success) can be
// MISSED entirely, or the composed completion frame can be dropped by a bridge
// that's momentarily down — either way the run finishes with NO completion
// delivered and its status is unknowable (#370).
//
// `/history/<prompt_id>` is the authoritative server-side record of a finished
// prompt: its full `outputs` and a terminal `status`. On reconnect we reconcile
// each still-pending prompt_id against it to recover the outcome and deliver the
// completion exactly once. This module owns ONLY the pure parse; the tracker owns
// the reconcile orchestration (fetch + dedupe + deliver).

/**
 * @param {object|null} entry  The per-prompt value from `/history/<id>` — i.e.
 *   `historyResponse[promptId]`, shape `{ outputs:{[nodeId]:{images?,gifs?,videos?,…}},
 *   status:{status_str?, completed?} }`. Pass `null` when absent. Extra keys
 *   ending in images/gifs/videos (CompareFrames `a_images`/`b_images`) are
 *   counted on `withheld` and never copied into `images`/`videos` (#1934).
 * @param {object}   [opts]
 * @param {(m:object)=>boolean} [opts.isVideo]  Classifies an output ref as video
 *   (else still image), matching the live path's classification.
 * @param {() => number} [opts.now]  Clock (epoch ms) used ONLY to reject a
 *   timestamp implausibly far in the future. Injectable for tests.
 * @returns {null | { terminal:boolean, status:("success"|"error"|"interrupted"|"unknown"),
 *   images:object[], videos:{m:object,nodeId:string}[],
 *   withheld:({ count:number, keys:string[], types:string[] }|null),
 *   startedAt:(number|null), finishedAt:(number|null) }}
 *   `null` when there's no usable entry. `startedAt`/`finishedAt` are epoch ms
 *   recovered from the entry's own lifecycle messages, or null when this entry
 *   records no trustworthy value (see historyMessageTimeMs).
 */
export function parseHistoryEntry(entry, { isVideo, now = () => Date.now() } = {}) {
  if (!entry || typeof entry !== "object") return null;

  const status = entry.status && typeof entry.status === "object" ? entry.status : {};
  const statusStr = typeof status.status_str === "string" ? status.status_str : null;
  const completedFlag = status.completed === true;
  const messages = Array.isArray(status.messages) ? status.messages : [];

  // ComfyUI records a manually stopped render as status_str:"error" plus an
  // execution_interrupted lifecycle message. That is a terminal cancellation,
  // not an execution failure: get_history action:"diagnose" makes the same
  // distinction. An actual
  // execution_error wins if an unusual record carries both markers.
  const hasMessage = (name) => messages.some((message) => Array.isArray(message) && message[0] === name);
  const hasExecutionError = hasMessage("execution_error");
  const isInterrupted =
    !hasExecutionError &&
    (hasMessage("execution_interrupted") || statusStr === "interrupted" || statusStr === "cancelled" || statusStr === "canceled");

  // Terminal ONLY when ComfyUI marks the prompt done. `status_str:"error"` is a
  // terminal failure; `status_str:"success"` or `completed:true` is a terminal
  // success. Anything else (still running, or an entry without a terminal status)
  // is NOT reconcilable yet — leave it pending so a later reconnect retries.
  const isError = !isInterrupted && statusStr === "error";
  const isSuccess = !isError && !isInterrupted && (statusStr === "success" || completedFlag);
  const terminal = isError || isSuccess || isInterrupted;

  const images = [];
  const videos = [];
  let withheld = null;
  const outputs = entry.outputs && typeof entry.outputs === "object" ? entry.outputs : {};
  for (const [nodeId, out] of Object.entries(outputs)) {
    if (!out || typeof out !== "object") continue;
    const collected = collectNodeOutputMedia(out);
    withheld = mergeWithheldMedia(withheld, collected.withheld);
    for (const m of collected.deliverable) {
      if (typeof isVideo === "function" && isVideo(m)) videos.push({ m, nodeId: String(nodeId) });
      else images.push(m);
    }
  }

  // #1199 — the run's OWN times, so a completion recovered from history can report
  // when it actually rendered instead of when the recovery happened. Read here
  // because this is the only place the raw entry is in scope.
  const nowMs = typeof now === "function" ? now() : Date.now();
  const startedAt = historyMessageTimeMs(messages, "execution_start", nowMs);
  const finishedAt = historyMessageTimeMs(messages, "execution_success", nowMs);

  return {
    terminal,
    status: isError ? "error" : isInterrupted ? "interrupted" : isSuccess ? "success" : "unknown",
    images,
    videos,
    withheld,
    startedAt,
    finishedAt,
  };
}

// A timestamp more than this far AHEAD of our clock is not a finish time we can
// trust — it is clock skew between ComfyUI's host and ours, or a counter that
// isn't an epoch at all. Rejected rather than used: a "finished" stamp in the
// future computes to a NEGATIVE age, which would present a days-old render as
// one that just landed — precisely the #1199 defect this extraction prevents.
const FUTURE_SKEW_TOLERANCE_MS = 60_000;

/**
 * Read a lifecycle message's `timestamp` from `status.messages` as epoch ms.
 *
 * ComfyUI records each execution message as `[name, data]` where `data.timestamp`
 * is the moment it fired. Which UNIT depends on the ComfyUI version — some builds
 * write epoch seconds, others milliseconds — so the magnitude decides, mirroring
 * `normalizeEpochMs` in comfyui-mcp (`src/services/job-history.ts`) so both repos
 * mean the same thing by "the run's real completion time".
 *
 * Scans rather than taking the first match positionally: a malformed duplicate
 * message must not shadow a well-formed one later in the list.
 *
 * @param {any[]} messages  `entry.status.messages` (already array-guarded).
 * @param {string} name     Lifecycle message name, e.g. "execution_success".
 * @param {number} nowMs    Our clock, for the future-skew rejection.
 * @returns {number|null}   Epoch ms, or null when no trustworthy value exists.
 */
function historyMessageTimeMs(messages, name, nowMs) {
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== name) continue;
    const data = message[1];
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    const ms = normalizeEpochMs(data.timestamp);
    if (ms === null) continue;
    if (Number.isFinite(nowMs) && ms > nowMs + FUTURE_SKEW_TOLERANCE_MS) continue;
    return ms;
  }
  return null;
}

// Epoch SECONDS or MILLISECONDS by magnitude. Anything below the seconds
// threshold (a relative counter, 0, a duration) is not an epoch at all ⇒ null.
function normalizeEpochMs(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  if (ts > 1_000_000_000_000) return ts; // already epoch ms
  if (ts > 1_000_000_000) return ts * 1000; // epoch seconds
  return null;
}

/**
 * Is `promptId` present in ComfyUI's `/queue` (running OR pending)?
 *
 * STRICT, mirroring the strict-null /history discipline: a definitive "absent"
 * (`false`) is returned ONLY when BOTH `queue_running` AND `queue_pending` are
 * well-formed ARRAYS and neither contains the id. If the payload is missing, not
 * an object, or EITHER field is absent / not an array / malformed, the answer is
 * UNCERTAIN → `null` (the reconciler then treats the prompt as "running" and never
 * gives up). Only a positively-confirmed absence permits give-up (codex P1).
 *
 * Queue rows are `[number, prompt_id, prompt, extra_data, outputs]`; some builds
 * use `{prompt_id}` objects — both forms are matched.
 *
 * @param {any} queueJson  Parsed body of `GET /queue`.
 * @param {string} promptId
 * @returns {boolean|null}  true present · false definitively absent · null uncertain
 */
export function queueMembership(queueJson, promptId) {
  // Defensive: a non-coercible lookup id is uncertain (never a definitive absence).
  // Ingestion normalizes ids to strings, so in practice this is always a string.
  const wantId = coerceLookupId(promptId);
  if (wantId === null) return null;
  if (!queueJson || typeof queueJson !== "object") return null;
  const running = queueJson.queue_running;
  const pending = queueJson.queue_pending;
  // Both containers MUST be arrays for any trustworthy verdict.
  if (!Array.isArray(running) || !Array.isArray(pending)) return null;
  let present = false;
  let malformed = false;
  const scan = (arr) => {
    for (const item of arr) {
      const id = rowPromptId(item);
      if (id == null) {
        // A row we can't read a prompt_id from taints the "absent" verdict — we
        // can't be sure this row isn't OUR prompt in an unrecognized shape.
        malformed = true;
        continue;
      }
      if (id === wantId) present = true;
    }
  };
  scan(running);
  scan(pending);
  if (present) return true; // a positive match is trustworthy regardless of other rows
  if (malformed) return null; // some row unreadable ⇒ can't trust "absent" ⇒ uncertain
  return false; // every row well-formed AND id absent ⇒ DEFINITIVE absence
}

/**
 * Extract the per-prompt entry from a `GET /history/<id>` response body, applying
 * the SAME strictness as queueMembership so a give-up needs a positively-confirmed
 * absence on BOTH sides.
 *
 * A well-formed /history response is a plain-object MAP keyed by prompt_id. Only
 * then can a MISSING key be trusted as a clean absence.
 *
 * @param {any} historyJson  Parsed body of `GET /history/<id>`.
 * @param {string} promptId
 * @returns {object|null|undefined}
 *   - the entry object when the map has the id with a usable record (reconciler
 *     parses it);
 *   - `null` when the body is a well-formed map that GENUINELY LACKS the id (its
 *     own key is absent) — a CLEAN ABSENCE, the only history state that can make
 *     give-up eligible;
 *   - `undefined` when the body is MALFORMED — `null`, an array, any non-object,
 *     OR the id's key is PRESENT but its value is null/undefined (a malformed
 *     present record, NOT confirmed absence) — i.e. UNCERTAIN (the reconciler
 *     treats undefined as "running", never gives up).
 */
export function historyEntryFor(historyJson, promptId) {
  // Defensive: a non-coercible lookup id is UNCERTAIN (undefined ⇒ "running"),
  // NEVER a clean absence — a give-up must never hinge on an unusable id. Ingestion
  // normalizes ids to strings, so in practice this is always a string.
  const wantId = coerceLookupId(promptId);
  if (wantId === null) return undefined;
  if (historyJson === null || typeof historyJson !== "object" || Array.isArray(historyJson)) {
    return undefined; // malformed body ⇒ uncertain, never a clean absence
  }
  // Distinguish a GENUINELY ABSENT own key (clean absence ⇒ null) from a PRESENT
  // key carrying a null/undefined value (a malformed present record ⇒ uncertain).
  // Only a truly-absent key is give-up eligible (codex P1).
  if (!Object.prototype.hasOwnProperty.call(historyJson, wantId)) {
    return null; // key absent ⇒ clean absence
  }
  const entry = historyJson[wantId];
  return entry == null ? undefined : entry; // present-but-null ⇒ uncertain
}

// Coerce a lookup prompt_id to a comparable STRING (ingestion already normalizes,
// this is belt-and-suspenders). A string or a finite number coerces; null/
// undefined/object/array/NaN/etc are non-coercible ⇒ null (uncertain lookup).
function coerceLookupId(id) {
  if (typeof id === "string") return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

// Extract a row's prompt_id from a recognized ComfyUI queue-row shape. A genuine
// array row is `[number(idx), prompt_id(string), prompt(dict), extra?, outputs?]`
// — the prompt DICT at index 2 must be present AND a real object (a truncated
// `[number, string]` row, or one whose index 2 is an ARRAY/primitive/null, is
// MALFORMED and must NOT masquerade as a valid id-absent row and enable a false
// "definitive absence"). An object row must carry a string `prompt_id`. Anything
// else ⇒ null (malformed).
function rowPromptId(item) {
  if (Array.isArray(item)) {
    return typeof item[0] === "number" && typeof item[1] === "string" && isPlainObject(item[2])
      ? item[1]
      : null;
  }
  // Object-row form `{prompt_id, …}` — NOT an array (arrays handled above), and the
  // prompt_id must be a string (an array/number/other ⇒ malformed ⇒ null).
  if (isPlainObject(item)) {
    return typeof item.prompt_id === "string" ? item.prompt_id : null;
  }
  return null;
}

// A non-null, NON-ARRAY object. Guards the `typeof [] === "object"` gotcha so an
// array can never pass where a real dict is required (codex P1).
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
