/**
 * #690(6) — say what a failed rename actually means.
 *
 * `panel_rename_workflow` onto an existing name surfaced the frontend's raw
 * transport error:
 *
 *     Failed to rename file 'workflows/PANEL-TEST-B.json': 409 Conflict
 *
 * The refusal is CORRECT — a rename must not clobber another workflow — but an
 * HTTP status is not a reason. An agent reading "409 Conflict" cannot tell a name
 * collision (retry with a different name) from a permissions or path problem
 * (retrying with any name will fail the same way), so it either guesses or gives
 * up on a condition the user can fix in one step.
 *
 * Only the CONFLICT case is rewritten, and only when the status is unambiguous.
 * Every other failure keeps its original text: inventing a friendly explanation
 * for a status this cannot interpret would replace a true-but-terse message with
 * a confident wrong one, which is worse.
 */

/** A 409 from the userdata move endpoint means the destination already exists. */
const CONFLICT_RE = /\b409\b|\bconflict\b/i;

/**
 * @param {unknown} err       the error thrown by the frontend's renameWorkflow
 * @param {string}  toName    the destination basename (no directory, no .json)
 * @returns {string} the message to surface
 */
export function describeRenameFailure(err, toName) {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const text = raw || "the rename failed";
  if (!CONFLICT_RE.test(text)) return text;
  const named = typeof toName === "string" && toName ? `"${toName}"` : "that name";
  return (
    `a workflow named ${named} already exists — rename is refused rather than overwriting it. ` +
    `Pick a different name, or close/delete the existing one first. ` +
    `Nothing was changed. (${text})`
  );
}
