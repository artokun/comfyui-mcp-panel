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
// panel#1563/#1564 — the SECOND way this same funnel loses a graph, and it needs no
// crossed identity at all: the state it serializes can simply be BEHIND the canvas.
//
// `ComfyWorkflow.save()` writes `JSON.stringify(this.activeState)` — the ChangeTracker
// snapshot, never the live root — and `workflowService.saveWorkflow` refreshes that
// snapshot first by calling `changeTracker.prepareForSave()` → `captureCanvasState()`.
// That capture returns EARLY AND SILENTLY while a graph is loading, while an undo is
// restoring, or inside an open change transaction. When it does, the save proceeds on
// the stale snapshot and the file loses whatever the canvas gained since.
//
// MEASURED on the live rig (ComfyUI 0.33.2, comfyui-frontend 1.49.6, one suppression
// window held open): panel_create_group added group 2 to the canvas, the following
// panel_graph_outline was refused `[root-shape-mismatch] ... both the workflow and the
// live canvas report 6 node(s), but the canvas does not reproduce the workflow's own
// state`, panel_save_workflow answered `{"saved": true}`, and the file on disk came
// back with ONE group. Reported success, work gone — the same shape as #1667, reached
// without any identity crossing.
//
// So the guard also refuses a write whose state is PROVABLY stale, on two conjuncts,
// both required:
//
//   * upstream POSITIVELY says the pre-save capture was skipped (its own
//     `changeCount` / `_restoringState` / `isLoadingGraph` conditions), and
//   * the live root does not reproduce the state about to be written.
//
// Neither alone: a suppressed capture on a canvas that already equals the snapshot
// loses nothing, and a content difference alone cannot be told from ordinary tracker
// lag on a frontend whose fields this panel does not recognise. Requiring both keeps
// an unknown frontend on today's behaviour instead of refusing every save on it.
//
// Dependency-light: path normalization is imported; the store reads stay in the caller.
// Unit-testable with plain fixtures.

import { normalizedWorkflowPath } from "./workflow-chat-identity.js";

export const SAVE_PATH_GUARD_REASON = Object.freeze({
  STAMPED_PATH_FOREIGN: "stamped_path_foreign",
  STALE_SNAPSHOT: "stale_snapshot",
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
 * @param {boolean} [input.snapshotIsStale] panel#1563 — true only when the caller has
 *   BOTH observations: upstream positively reports the pre-save capture was skipped,
 *   AND the live root of this (active) workflow does not reproduce the state about to
 *   be serialized. Absent/false → allow, exactly as before.
 * @returns {{allow: true} | {allow: false, reason: string, destinationPath: string, stampedPath?: string}}
 */
export function decideWorkflowSaveVerdict({
  destinationPath,
  destinationPersisted = false,
  stampedPath = null,
  stampedPathOwnedByOther = false,
  snapshotIsStale = false,
} = {}) {
  // panel#1563 — ordered FIRST, and deliberately NOT gated on `destinationPersisted`.
  // Overwriting an existing file with a stale snapshot destroys the old content, but a
  // FIRST save that writes a stale snapshot is the same lost work reported as success:
  // the user is told their canvas is on disk when part of it is not. Both refuse.
  if (snapshotIsStale) {
    return {
      allow: false,
      reason: SAVE_PATH_GUARD_REASON.STALE_SNAPSHOT,
      destinationPath,
    };
  }
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
  if (verdict?.reason === SAVE_PATH_GUARD_REASON.STALE_SNAPSHOT) {
    return new Error(
      `REFUSED to save: the state this save would write to "${dest}" is BEHIND the live ` +
        `canvas, so the file would be missing changes the canvas already has. ComfyUI saves ` +
        `the ChangeTracker snapshot rather than the graph on screen, and it refreshes that ` +
        `snapshot first — but that refresh is skipped while a workflow is loading, while an ` +
        `undo is restoring, or inside an open change transaction, and one of those is true ` +
        `right now. NOTHING was written; the canvas is intact. This clears by itself once the ` +
        `load/undo/transaction finishes — wait a moment and save again. If it persists, ` +
        `reload the ComfyUI tab (panel_reload) and re-open the workflow ` +
        `(panel_open_workflow); do NOT close the tab first, closing discards the canvas that ` +
        `holds the only copy of those changes (panel#1563).`,
    );
  }
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
