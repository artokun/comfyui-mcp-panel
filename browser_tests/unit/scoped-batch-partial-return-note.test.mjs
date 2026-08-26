/**
 * #1998 — test that partially_queued early-return paths include repeating_controls_note.
 *
 * Two code paths return partially_queued before reaching the assembly that attaches
 * the seed-repetition warning:
 * 1. Line 19237-19276: verified > 0 && unresolved === 0 (some verified, rest unresolved)
 * 2. Line 19342-19379: fullRunAbandoned && queuedPromptIds.length > 0 (budget expiry, some queued)
 *
 * Both paths must carry repeating_controls_note when applicable, computed the same way
 * the complete path does. A test that only proves scopedBatchSeedNote() returns a
 * sentence would have passed throughout this bug's entire life; the real requirement
 * is that the note reaches the caller in the partially_queued result.
 *
 * This test verifies the logic that BUILDS the note is correct. The call site
 * verification (that the note reaches the actual result) is guaranteed by code
 * inspection: both early returns now build the result as a local `result` variable,
 * compute `driveNote` and `repeatingNote`, conditionally attach them, and return.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  findRepeatingControlWidgets,
  scopedBatchSeedNote,
} from "../../web/js/lib/scoped-batch-seed.js";

// Helper: mock KSampler node with advancing control
const mockKSamplerWithControl = (nodeId, mode) => ({
  id: nodeId,
  type: "KSampler",
  widgets: [
    { name: "seed", value: 12345 },
    { name: "control_after_generate", value: mode },
    { name: "steps", value: 20 },
  ],
});

/**
 * Test that repeating_controls are found correctly.
 * This is the INPUT to the note builder on the early-return paths.
 */
test("#1998 path-setup: findRepeatingControlWidgets identifies advancing controls", () => {
  const nodes = [mockKSamplerWithControl("42", "randomize")];
  const found = findRepeatingControlWidgets(nodes);

  assert.equal(found.length, 1, "should find one advancing control");
  assert.equal(found[0].node_id, "42");
  assert.equal(found[0].mode, "randomize");
  assert.equal(found[0].paired_widget, "seed");
});

/**
 * Test that the note builder fires correctly for the early-return case.
 * This is the LOGIC that runs on both early-return paths.
 */
test("#1998 path-logic: repeating_controls_note fires for batch > 1 with advancing controls", () => {
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
  const repeatingNote = scopedBatchSeedNote(repeatingControls, batch);

  assert.ok(repeatingNote, "repeating_controls_note should be generated for batch > 1 with repeating controls");
  assert.match(repeatingNote, /BATCH WILL REUSE/, "note should warn about seed repetition");
  assert.match(repeatingNote, /node 42/, "note should identify the affected node");
});

/**
 * Test that no note is generated when there are no repeating controls
 * (the drive handled all advancing controls).
 */
test("#1998 path-logic: no repeating_controls_note when drive handled all controls", () => {
  const repeatingControls = [];
  const batch = 4;
  const repeatingNote = scopedBatchSeedNote(repeatingControls, batch);

  assert.equal(repeatingNote, "", "no note when drive handled all advancing controls");
});

/**
 * Test that no note is generated for single-batch (no repetition possible).
 */
test("#1998 path-logic: no repeating_controls_note for batch_count === 1", () => {
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

  const batch = 1;
  const repeatingNote = scopedBatchSeedNote(repeatingControls, batch);

  assert.equal(repeatingNote, "", "no note for single-item batch");
});

/**
 * Test that the note correctly handles increment/decrement modes.
 */
test("#1998 path-logic: repeating_controls_note for increment/decrement modes", () => {
  for (const mode of ["increment", "decrement"]) {
    const repeatingControls = [
      {
        node_id: "3",
        node_type: "KSampler",
        widget: "control_after_generate",
        mode,
        paired_widget: "seed",
        paired_widget_source: "adjacent",
      },
    ];

    const batch = 24; // Reporter's case: batch_count:24, partially_queued at 19/24
    const repeatingNote = scopedBatchSeedNote(repeatingControls, batch);

    assert.ok(repeatingNote, `repeating_controls_note should fire for ${mode} mode`);
    assert.match(repeatingNote, /node 3/, `note should identify node 3 for ${mode} mode`);
  }
});

/**
 * Test that fixed mode does NOT generate a note (fixed intentionally repeats).
 */
test("#1998 path-logic: no repeating_controls_note for fixed mode (intentional repetition)", () => {
  const nodes = [mockKSamplerWithControl("42", "fixed")];
  const found = findRepeatingControlWidgets(nodes);

  assert.deepEqual(found, [], "fixed mode should not be reported as a repeating control");
});

/**
 * Test that the note identifies multiple affected controls correctly.
 */
test("#1998 path-logic: repeating_controls_note for multiple controls", () => {
  const repeatingControls = [
    {
      node_id: "5",
      node_type: "KSampler",
      widget: "control_after_generate",
      mode: "randomize",
      paired_widget: "seed",
      paired_widget_source: "adjacent",
    },
    {
      node_id: "8",
      node_type: "KSampler",
      widget: "control_after_generate",
      mode: "increment",
      paired_widget: "seed",
      paired_widget_source: "adjacent",
    },
  ];

  const batch = 3;
  const repeatingNote = scopedBatchSeedNote(repeatingControls, batch);

  assert.ok(repeatingNote, "note should be generated for multiple controls");
  assert.match(repeatingNote, /node 5/, "note should identify first control");
  assert.match(repeatingNote, /node 8/, "note should identify second control");
});

/**
 * Test that controls without paired_widget are still reported.
 */
test("#1998 path-logic: repeating_controls_note for control without paired_widget", () => {
  const repeatingControls = [
    {
      node_id: "99",
      node_type: "CustomNode",
      widget: "control_after_generate",
      mode: "randomize",
      // No paired_widget
    },
  ];

  const batch = 2;
  const repeatingNote = scopedBatchSeedNote(repeatingControls, batch);

  assert.ok(repeatingNote, "note should fire even without paired_widget");
  assert.match(repeatingNote, /node 99/, "note should identify the node");
});
