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

/** EXACT text equality of two serialized-workflow strings — the shared content-equality
 *  primitive for both the open-side staleness check and the save-side in-place-overwrite
 *  gate (#442). Deliberately NOT a JSON round-trip: `JSON.parse`→`JSON.stringify` collapses
 *  distinct valid JSON values (e.g. large integer seeds beyond 2^53 round to the same
 *  IEEE-754 double), which would let a genuinely-changed file compare EQUAL and either be
 *  reported fresh or authorize a destructive overwrite (codex P0). Byte-exact comparison
 *  errs only in the SAFE direction: a formatting-only difference is treated as "changed"
 *  (an over-cautious stale flag / a refused in-place save — never data loss). */
export function workflowContentEqual(a, b) {
  return typeof a === "string" && typeof b === "string" && a === b;
}

/** LOSSLESS byte-vs-text equality for the SAVE-side in-place-overwrite gate (#442
 *  defect 3). `Response.text()` silently CONSUMES a UTF-8 BOM, so a decoded-string
 *  compare treats `A` and `BOM+A` as equal — which would authorize a forced overwrite
 *  that clobbers an external BOM-bearing change (codex P0). This compares the disk file's
 *  RAW BYTES (`diskBytes`, a Uint8Array read via arrayBuffer — BOM preserved) against the
 *  UTF-8 encoding of the loaded baseline TEXT.
 *
 *  Why re-encoding the baseline is the right baseline here: ComfyUI writes workflow files
 *  as CANONICAL UTF-8 with NO BOM (JSON.stringify → verbatim POST body), so for ANY
 *  ComfyUI-written file the loaded bytes are exactly `TextEncoder().encode(originalContent)`
 *  — this reconstruction is EXACT. The only case it can't reconstruct is a file that was
 *  externally created WITH a BOM and then loaded (originalContent lost the BOM): there this
 *  returns false → the caller treats it as a CONFLICT and REFUSES, i.e. it FAILS CLOSED
 *  (never a false authorize). So it authorizes iff the on-disk bytes are byte-identical to
 *  a canonical encoding of what the tab loaded, and refuses on any deviation. */
export function diskBytesEqualText(diskBytes, baselineText) {
  if (typeof baselineText !== "string") return false;
  const bytes =
    diskBytes instanceof Uint8Array
      ? diskBytes
      : diskBytes && typeof diskBytes.byteLength === "number"
        ? new Uint8Array(diskBytes) // accept a raw ArrayBuffer too
        : null;
  if (!bytes) return false;
  const enc = new TextEncoder().encode(baselineText); // canonical UTF-8, no BOM
  if (enc.length !== bytes.length) return false;
  for (let i = 0; i < enc.length; i++) {
    if (enc[i] !== bytes[i]) return false;
  }
  return true;
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
 *   - `stale` is `true` when both texts are known and DIFFER (the file on disk is no
 *     longer what the tab loaded); `false` only when both are known and MATCH; and the
 *     string `"unknown"` when the tab was open but staleness could NOT be determined
 *     (disk unreadable / baseline missing). "unknown" must NEVER be reported as fresh —
 *     a transient read failure or a frontend without a content-read API would otherwise
 *     mask a genuine out-of-band change (codex P2).
 *   - `reload` is true only when `stale === true` AND there are no unsaved edits to
 *     clobber (isModified falsy) — a safe, lossless re-read.
 *
 *  A not-open tab is never stale (openWorkflow reads it fresh) ⇒ `{stale:false}`. */
export function decideOpenStaleness({
  wasOpen,
  isModified,
  onDiskContent,
  baselineContent,
} = {}) {
  if (!wasOpen) return { stale: false, reload: false };
  if (typeof onDiskContent !== "string" || typeof baselineContent !== "string") {
    // Open tab but we could not read disk or lack a baseline ⇒ cannot prove fresh.
    return { stale: "unknown", reload: false };
  }
  const stale = !workflowContentEqual(onDiskContent, baselineContent);
  if (!stale) return { stale: false, reload: false };
  // Stale. Re-read only when nothing unsaved would be lost; otherwise surface the
  // flag and let the caller force a fresh read (panel_load_workflow) if they choose.
  return { stale: true, reload: !isModified };
}
