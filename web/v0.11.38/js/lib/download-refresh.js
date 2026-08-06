// Pure helper for issue #396 — freshly downloaded models must become SELECTABLE
// on the live canvas without a manual reload / ComfyUI restart.
//
// The orchestrator broadcasts a `download_progress` frame to the panel: an array
// of rows, each { id?, name?, status } where status is "downloading" | "done" |
// "error" (src/orchestrator/index.ts pollDownloads). When a model download
// COMPLETES its file lands in models/<type>/…, but the live loader combo option
// lists (VAELoader.vae_name, LoraLoaderModelOnly.lora_name, …) were populated
// from /object_info at page-load and stay stale until something re-registers the
// node defs — so a just-downloaded file looks "not a valid option" until reload.
//
// This helper detects the once-per-download moment a row transitions into the
// terminal DONE state, so the panel can trigger a non-destructive object_info
// re-register + refreshComboInNodes exactly once per completed download. Kept
// standalone (no browser globals) so the transition logic is unit-testable under
// `node --test`.

/** A stable identity for a download row: prefer `id` (the orchestrator keys rows
 *  off `row.id ?? full`), else the `name`. Undefined for a shapeless row. */
function rowKey(row) {
  if (!row || typeof row !== "object") return undefined;
  if (typeof row.id === "string" && row.id) return row.id;
  if (typeof row.name === "string" && row.name) return row.name;
  return undefined;
}

/**
 * Reconcile a fresh `download_progress` rows array against the set of download
 * ids ALREADY counted as done, to find newly-completed downloads. Pure — does not
 * mutate `seen`. Returns:
 *   - nextSeen: the reconciled Set the caller should keep — every id present on
 *     THIS frame with status "done" (a lingering done row stays tracked so it
 *     never re-fires; an id that has disappeared is dropped, so a later
 *     RE-download of the same target can fire again); and
 *   - newlyDone: the ids that reached status "done" on this frame and were not in
 *     `seen` — non-empty ⇒ the caller should refresh combos ONCE (regardless of
 *     how many ids: the refresh itself is coalesced single-flight).
 *
 * Only "done" is a model-landed terminal — an "error" row produced no new file,
 * so it never appears in nextSeen and never triggers a refresh.
 */
export function reconcileCompletedDownloads(rows, seen) {
  const prev = seen instanceof Set ? seen : new Set();
  const nextSeen = new Set();
  const newlyDone = [];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || row.status !== "done") continue;
      const key = rowKey(row);
      if (!key) continue;
      nextSeen.add(key);
      if (!prev.has(key)) newlyDone.push(key);
    }
  }
  return { nextSeen, newlyDone };
}
