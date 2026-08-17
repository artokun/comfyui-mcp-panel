// #1667 P0 — DATA LOSS: a stale-canvas tab persisted the WRONG graph over a live file.
//
// The reported loss: a tab whose canvas held workflow A's graph (mounted there by the
// crossed-identity failure tracked as #1639) was persisted by the FRONTEND's own save
// path — autosave / Ctrl+S / the reconnect-restore flow — over an unrelated workflow's
// .json on disk. No panel command was involved, so the panel's own save fence (#708
// wrong-canvas guard, which gates panel_save_workflow) never saw the write. The file's
// original 31-node graph was destroyed.
//
// The evidence the file itself kept: the recovered graph's `extra.comfyui_mcp` block
// carried a `workflow_path` naming a THIRD workflow — the stamp and the destination
// disagreed, and nothing checked that before writing.
//
// So the save funnel is now guarded: before a workflow is persisted IN PLACE over an
// existing file, the identity stamp embedded in the very state about to be serialized
// (`changeTracker.activeState.extra.comfyui_mcp.workflow_path`) is compared against the
// destination path. A stamp that positively names a DIFFERENT, still-existing workflow
// is proof the content is foreign to the file it is about to overwrite, and the write
// is REFUSED — fail closed, nothing on disk is touched.
//
// WHAT THIS DOES NOT DECIDE (deliberately — a guard that refuses on a guess is a
// wrong-graph refusal of its own):
//
//   * No stamp, or no path field in it → allowed. The stamp is written by the panel's
//     own load/open wrappers; a canvas that never carried one proves nothing in either
//     direction, and blocking every unstamped save would break ordinary ComfyUI use
//     for exactly the users the fork failed to install for.
//   * Stamped path equals the destination → allowed (that is the common, healthy case).
//   * Stamped path differs but no longer names a live workflow record → allowed. That
//     is what RENAME residue looks like: the file moved, the in-memory stamp still
//     names the old path, and the canvas genuinely belongs to the destination.
//   * The destination is a never-persisted (temporary) record → allowed. No existing
//     file is overwritten, so there is nothing to destroy; this is also what keeps a
//     legitimate Save-As copy — which inherits the source's stamp — saveable.
//
// The one deliberate false positive: a file the USER duplicated on disk and opened
// under the copy's name carries the source's stamp, so its first in-place save is
// refused. That refusal is recoverable (the message names the re-bind that heals it);
// the overwrite it exists to prevent is not.
//
// Dependency-light: path normalization is imported; the store reads stay in the caller.
// Unit-testable with plain fixtures.

import { normalizedWorkflowPath } from "./workflow-chat-identity.js";

export const SAVE_PATH_GUARD_REASON = Object.freeze({
  STAMPED_PATH_FOREIGN: "stamped_path_foreign",
});

/**
 * Decide whether an in-place workflow save may proceed.
 *
 * @param {object} input
 * @param {string|null|undefined} input.destinationPath path the save will write to
 *   (the workflow record's own `path`).
 * @param {boolean} [input.destinationPersisted] true when the destination is an
 *   existing, non-temporary record — i.e. the write OVERWRITES an on-disk file.
 *   Absent/false → nothing to destroy → allow.
 * @param {string|null|undefined} input.stampedPath the `workflow_path` stamped in the
 *   state about to be serialized, or null when absent/unreadable.
 * @param {boolean} [input.stampedPathOwnedByOther] true when the workflow store still
 *   has a record at `stampedPath` that is NOT the workflow being saved.
 * @returns {{allow: true} | {allow: false, reason: string, destinationPath: string, stampedPath: string}}
 */
export function decideWorkflowSaveVerdict({
  destinationPath,
  destinationPersisted = false,
  stampedPath = null,
  stampedPathOwnedByOther = false,
} = {}) {
  if (!destinationPersisted) return { allow: true };
  const dest = normalizedWorkflowPath(destinationPath);
  const stamped = normalizedWorkflowPath(stampedPath);
  if (!dest || !stamped || dest === stamped) return { allow: true };
  if (!stampedPathOwnedByOther) return { allow: true };
  return {
    allow: false,
    reason: SAVE_PATH_GUARD_REASON.STAMPED_PATH_FOREIGN,
    destinationPath,
    stampedPath,
  };
}

/**
 * The refusal a blocked save throws. States what was compared, what was NOT written,
 * both readings of the evidence (stale canvas vs deliberate copy), and the recovery.
 * Deliberately does not claim which reading is true — the panel cannot tell them apart;
 * it can only refuse to guess with the user's file.
 */
export function workflowSaveRefusalError(verdict) {
  const dest = typeof verdict?.destinationPath === "string" && verdict.destinationPath
    ? verdict.destinationPath
    : "this workflow's file";
  const stamped = typeof verdict?.stampedPath === "string" && verdict.stampedPath
    ? verdict.stampedPath
    : "a different workflow";
  return new Error(
    `REFUSED to save: the canvas about to overwrite "${dest}" is stamped as belonging to ` +
      `"${stamped}" (extra.comfyui_mcp.workflow_path), which is a different workflow that ` +
      `still exists. Writing it would replace that file's content with a graph that does not ` +
      `belong to it — this is the #1667 stale-canvas data-loss guard, and NOTHING was written. ` +
      `Either this tab's canvas is stale (mounted from another workflow — reload the file from ` +
      `disk before losing it), or you deliberately built this content under a copied identity. ` +
      `If the canvas really is what you want in "${dest}", re-bind the tab first — open the ` +
      `workflow via panel_open_workflow so its identity is re-verified against the file — then ` +
      `save again.`,
  );
}
