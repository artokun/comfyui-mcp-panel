/**
 * #1998 — test that attachControlRepetitionNote adds repeating_controls_note
 * and batch_controls_note to a partially_queued result.
 *
 * This test directly exercises the helper function extracted from graph_run's
 * two early-return paths. It MUST fail when the attachment logic is removed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  attachControlRepetitionNote,
} from "../../web/js/lib/partial-queue-result.js";
import {
  scopedBatchSeedNote,
  scopedBatchDriveNote,
} from "../../web/js/lib/scoped-batch-seed.js";

/**
 * Test: repeating_controls_note is attached when there are repeating controls.
 * This MUST fail if the `result.repeating_controls_note = repeatingNote` line is removed.
 */
test("#1998: attachControlRepetitionNote attaches repeating_controls_note when controls repeat", () => {
  const result = {
    queued: true,
    complete: false,
    partially_queued: true,
    queued_count: 2,
    queued_prompt_ids: ["id-1", "id-2"],
    incomplete_reason: "some reason",
  };

  const repeatingControls = [
    {
      node_id: "42",
      node_type: "KSampler",
      widget: "control_after_generate",
      mode: "randomize",
      paired_widget: "seed",
      paired_widget_source: "adjacent",
    },
  ];

  const batch = 4;

  attachControlRepetitionNote(result, null, repeatingControls, batch, scopedBatchDriveNote, scopedBatchSeedNote);

  // The KEY assertion: repeating_controls_note MUST be in the result
  assert.ok("repeating_controls_note" in result, "repeating_controls_note field must be attached");
  assert.ok(result.repeating_controls_note, "repeating_controls_note must not be empty");
  assert.match(String(result.repeating_controls_note), /BATCH WILL REUSE/, "note must mention seed repetition");
  assert.deepEqual(result.repeating_controls, repeatingControls, "repeating_controls must also be attached");
});

/**
 * Test: batch_controls_note is attached when the drive has observations.
 * This MUST fail if the `result.batch_controls_note = driveNote` line is removed.
 */
test("#1998: attachControlRepetitionNote attaches batch_controls_note when drive has observations", () => {
  const result = {
    queued: true,
    complete: false,
    partially_queued: true,
    queued_count: 3,
  };

  const controlDriveObservations = [
    {
      node_id: "42",
      node_type: "KSampler",
      mode: "increment",
      advanced: true,
      attributable: true,
      control: "control_after_generate",
      from: 12345,
      to: 12348,
    },
  ];

  const batch = 3;

  attachControlRepetitionNote(result, controlDriveObservations, [], batch, scopedBatchDriveNote, scopedBatchSeedNote);

  // The KEY assertion: batch_controls_note MUST be in the result
  assert.ok("batch_controls_note" in result, "batch_controls_note field must be attached");
  assert.ok(result.batch_controls_note, "batch_controls_note must not be empty");
  assert.deepEqual(result.batch_controls, controlDriveObservations, "batch_controls must also be attached");
});

/**
 * Test: both notes are attached when both controls repeat and drive has observations.
 */
test("#1998: attachControlRepetitionNote attaches both notes when applicable", () => {
  const result = {
    queued: true,
    complete: false,
    partially_queued: true,
    queued_count: 4,
  };

  const repeatingControls = [
    {
      node_id: "42",
      node_type: "KSampler",
      widget: "control_after_generate",
      mode: "increment",
      paired_widget: "seed",
    },
  ];

  const controlDriveObservations = [
    {
      node_id: "42",
      node_type: "KSampler",
      mode: "increment",
      advanced: true,
      attributable: true,
      control: "control_after_generate",
      from: 12345,
      to: 12349,
    },
  ];

  const batch = 4;

  attachControlRepetitionNote(result, controlDriveObservations, repeatingControls, batch, scopedBatchDriveNote, scopedBatchSeedNote);

  // Both notes MUST be present
  assert.ok("repeating_controls_note" in result, "repeating_controls_note must be attached");
  assert.ok("batch_controls_note" in result, "batch_controls_note must be attached");
  assert.ok(result.repeating_controls_note, "repeating_controls_note must not be empty");
  assert.ok(result.batch_controls_note, "batch_controls_note must not be empty");
  assert.deepEqual(result.repeating_controls, repeatingControls, "repeating_controls must be attached");
  assert.deepEqual(result.batch_controls, controlDriveObservations, "batch_controls must be attached");
});

/**
 * Test: no notes attached when drive handled all controls and no observations.
 */
test("#1998: attachControlRepetitionNote does not attach notes when not needed", () => {
  const result = {
    queued: true,
    complete: false,
    partially_queued: true,
    queued_count: 2,
  };

  const batch = 2;

  attachControlRepetitionNote(result, null, [], batch, scopedBatchDriveNote, scopedBatchSeedNote);

  // No notes should be added
  assert.equal("repeating_controls_note" in result, false, "repeating_controls_note should not be attached when no controls repeat");
  assert.equal("batch_controls_note" in result, false, "batch_controls_note should not be attached when no observations");
  assert.equal("repeating_controls" in result, false, "repeating_controls should not be attached");
  assert.equal("batch_controls" in result, false, "batch_controls should not be attached");
});

/**
 * Test: no notes for batch_count === 1 (no repetition possible).
 */
test("#1998: attachControlRepetitionNote does not attach repeating note for batch_count === 1", () => {
  const result = {
    queued: true,
    complete: false,
    partially_queued: true,
    queued_count: 1,
  };

  const repeatingControls = [
    {
      node_id: "42",
      node_type: "KSampler",
      widget: "control_after_generate",
      mode: "randomize",
      paired_widget: "seed",
    },
  ];

  const batch = 1;

  attachControlRepetitionNote(result, null, repeatingControls, batch, scopedBatchDriveNote, scopedBatchSeedNote);

  // Single-batch has no repetition, so no note
  assert.equal("repeating_controls_note" in result, false, "no note for single-item batch");
});
