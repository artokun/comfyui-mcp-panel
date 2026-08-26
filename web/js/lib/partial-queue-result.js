/**
 * #1998 — assemble the repeating_controls_note and batch_controls_note fields
 * for a partially_queued result.
 *
 * Extracted so both early-return paths (lines 19237-19276 and 19342-19379 in
 * comfyui-mcp-panel.js) can reuse the same logic without duplication, and so the
 * attachment can be unit-tested directly.
 */

/**
 * Attach control-repetition fields to a partial queue result.
 *
 * @param {Object} result - the partially_queued result object (mutated in-place)
 * @param {Object} controlDriveObservations - from controlDrive.observe() or null
 * @param {Array} repeatingControls - from findRepeatingControlWidgets() or []
 * @param {number} batch - batch_count
 * @param {Function} scopedBatchDriveNote - imported builder
 * @param {Function} scopedBatchSeedNote - imported builder
 */
export function attachControlRepetitionNote(result, controlDriveObservations, repeatingControls, batch, scopedBatchDriveNote, scopedBatchSeedNote) {
  // #1998 — when the scoped batch was DRIVEN, report what the controls actually did
  // and do NOT also ship #988's "this batch WILL reuse the same values": that sentence
  // is what the drive stops being true, and two contradictory statements in one result
  // is worse than either alone. The #988 note stays in charge whenever the drive did
  // not run (arming threw, or a frontend with no hooks to wrap).
  const driveNote = scopedBatchDriveNote(controlDriveObservations, batch);
  if (driveNote) {
    result.batch_controls = controlDriveObservations;
    result.batch_controls_note = driveNote;
  }
  // #988 — attach the PRE-dispatch finding, now covering exactly the controls the drive
  // did NOT arm (gate P1-2). The subtraction happens at the arming site, before dispatch,
  // so this keeps #988's "computed BEFORE dispatch" property; what changed is that an
  // unarmed control keeps its warning instead of being silenced by an unrelated one.
  const repeatingNote = scopedBatchSeedNote(repeatingControls, batch);
  if (repeatingNote) {
    result.repeating_controls = repeatingControls;
    result.repeating_controls_note = repeatingNote;
  }
}
