// #442 — pure decision for how panel_open_workflow should treat an ALREADY-OPEN
// tab whose backing .json may have changed on disk out-of-band.
//
// Background: switching to an already-open workflow tab repaints from the tab's
// OWN in-memory buffer (changeTracker.activeState), never re-reading the file. So
// if the file was edited on disk after the tab loaded, the canvas silently keeps
// the pre-edit graph and the open reports a bland success (issue #442 defect 2).
//
// Detection is CONTENT-based, NOT mtime-based: the frontend's own file sync bumps a
// workflow's `lastModified` from listing metadata WITHOUT reloading the active tab's
// graph, so an mtime comparison can be silently defeated (and timestamp-preserving
// out-of-band writes evade it entirely). Comparing the on-disk bytes to the bytes the
// tab loaded (its baseline) is authoritative and immune to both.

/** Normalize a serialized-workflow string for comparison: trim, and (when it parses)
 *  round-trip through JSON so a pure reformat (e.g. a Python rewrite with indentation)
 *  isn't reported as a content change. Falls back to the trimmed raw text when the
 *  content isn't valid JSON. */
function normalizeWorkflowContent(text) {
  const s = String(text).trim();
  try {
    return JSON.stringify(JSON.parse(s));
  } catch {
    return s;
  }
}

/** Decide whether an already-open tab's buffer is stale relative to disk, and whether
 *  it is SAFE to re-read.
 *
 *  Inputs:
 *   - wasOpen:         the tab was already LOADED (has an in-memory graph) before this
 *                      open — the only case with a stale-buffer risk. A not-yet-open
 *                      tab is read fresh from disk by openWorkflow.
 *   - isModified:      the tab has UNSAVED in-memory edits (a reload would lose them).
 *   - onDiskContent:   the file's CURRENT on-disk text, or null/undefined if it could
 *                      not be read.
 *   - baselineContent: the text the tab LOADED from disk (its `originalContent`
 *                      baseline — updated on save), or null/undefined if unknown.
 *
 *  Returns `{ stale, reload }`:
 *   - `stale`  is true ONLY when both texts are known and DIFFER (the file on disk is
 *     no longer what the tab loaded).
 *   - `reload` is true only when it is stale AND there are no unsaved edits to clobber
 *     (isModified falsy) — a safe, lossless re-read.
 *
 *  Every indeterminate case (not open, either text unknown, identical) returns
 *  `{ stale:false, reload:false }` — never a false staleness signal and never an
 *  unsafe reload that could discard the user's unsaved edits. */
export function decideOpenStaleness({
  wasOpen,
  isModified,
  onDiskContent,
  baselineContent,
} = {}) {
  if (!wasOpen) return { stale: false, reload: false };
  if (typeof onDiskContent !== "string" || typeof baselineContent !== "string") {
    return { stale: false, reload: false };
  }
  const stale =
    normalizeWorkflowContent(onDiskContent) !== normalizeWorkflowContent(baselineContent);
  if (!stale) return { stale: false, reload: false };
  // Stale. Re-read only when nothing unsaved would be lost; otherwise surface the
  // flag and let the caller force a fresh read (panel_load_workflow) if they choose.
  return { stale: true, reload: !isModified };
}
