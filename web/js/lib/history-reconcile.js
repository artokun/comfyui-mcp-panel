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
