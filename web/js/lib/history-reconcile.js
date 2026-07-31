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
 *   `historyResponse[promptId]`, shape `{ outputs:{[nodeId]:{images?,gifs?,videos?}},
 *   status:{status_str?, completed?} }`. Pass `null` when absent.
 * @param {object}   [opts]
 * @param {(m:object)=>boolean} [opts.isVideo]  Classifies an output ref as video
 *   (else still image), matching the live path's classification.
 * @returns {null | { terminal:boolean, status:("success"|"error"|"unknown"),
 *   images:object[], videos:{m:object,nodeId:string}[] }}
 *   `null` when there's no usable entry.
 */
export function parseHistoryEntry(entry, { isVideo } = {}) {
  if (!entry || typeof entry !== "object") return null;

  const status = entry.status && typeof entry.status === "object" ? entry.status : {};
  const statusStr = typeof status.status_str === "string" ? status.status_str : null;
  const completedFlag = status.completed === true;

  // Terminal ONLY when ComfyUI marks the prompt done. `status_str:"error"` is a
  // terminal failure; `status_str:"success"` or `completed:true` is a terminal
  // success. Anything else (still running, or an entry without a terminal status)
  // is NOT reconcilable yet — leave it pending so a later reconnect retries.
  const isError = statusStr === "error";
  const isSuccess = !isError && (statusStr === "success" || completedFlag);
  const terminal = isError || isSuccess;

  const images = [];
  const videos = [];
  const outputs = entry.outputs && typeof entry.outputs === "object" ? entry.outputs : {};
  for (const [nodeId, out] of Object.entries(outputs)) {
    if (!out || typeof out !== "object") continue;
    const media = [
      ...(Array.isArray(out.images) ? out.images : []),
      ...(Array.isArray(out.gifs) ? out.gifs : []),
      ...(Array.isArray(out.videos) ? out.videos : []),
    ];
    for (const m of media) {
      if (!m || !m.filename) continue;
      if (typeof isVideo === "function" && isVideo(m)) videos.push({ m, nodeId: String(nodeId) });
      else images.push(m);
    }
  }

  return {
    terminal,
    status: isError ? "error" : isSuccess ? "success" : "unknown",
    images,
    videos,
  };
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
      if (id === promptId) present = true;
    }
  };
  scan(running);
  scan(pending);
  if (present) return true; // a positive match is trustworthy regardless of other rows
  if (malformed) return null; // some row unreadable ⇒ can't trust "absent" ⇒ uncertain
  return false; // every row well-formed AND id absent ⇒ DEFINITIVE absence
}

// Extract a row's prompt_id: array rows are `[number, prompt_id, …]` (index 0 a
// number, index 1 a string), object rows are `{prompt_id: string}`. Anything that
// doesn't match a recognized shape is malformed ⇒ null (so it can't masquerade as
// a well-formed, id-absent row and enable a false "definitive absence").
function rowPromptId(item) {
  if (Array.isArray(item)) {
    return typeof item[0] === "number" && typeof item[1] === "string" ? item[1] : null;
  }
  if (item && typeof item === "object") {
    return typeof item.prompt_id === "string" ? item.prompt_id : null;
  }
  return null;
}
