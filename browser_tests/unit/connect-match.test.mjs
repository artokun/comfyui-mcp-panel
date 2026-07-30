/**
 * Unit tests for web/js/lib/connect-match.js — run with `node --test`.
 *
 * These drive autoMatchSlots() / resolveExplicitSlot(), the SAME functions
 * graph_connect delegates to, so the handler's real slot-resolution path is
 * exercised — not a parallel reimplementation.
 *
 * Covers the graph_connect edge-case fixes:
 *   #351 — a numeric slot index that arrives JSON-stringified ("0") resolves as
 *          an INDEX, not a slot NAMED "0"; a valid IMAGE→IMAGE connects instead
 *          of failing with the generic "no compatible pair" diagnostic.
 *   #169 — auto-match never silently clobbers an OCCUPIED dynamic wildcard ("*")
 *          input when no free wildcard slot exists yet; an explicit to_input
 *          still replaces deliberately.
 * Plus the invariant that genuinely incompatible types stay refused (#204).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  autoMatchSlots,
  resolveExplicitSlot,
  isTypeCompatible,
  isWildcardSlotType,
  slotDiagnostic,
} from "../../web/js/lib/connect-match.js";

// VHS_LoadVideo-shaped origin: IMAGE output at index 0, plus non-IMAGE outputs.
function loadVideoNode() {
  return {
    id: 5414,
    type: "VHS_LoadVideo",
    outputs: [
      { name: "IMAGE", type: "IMAGE" },
      { name: "frame_count", type: "INT" },
      { name: "audio", type: "AUDIO" },
      { name: "video_info", type: "VHS_VIDEOINFO" },
    ],
  };
}

// ImageToMask-shaped target: an empty IMAGE input + a combo/widget input.
function imageToMaskNode() {
  return {
    id: 5377,
    type: "ImageToMask",
    inputs: [
      { name: "image", type: "IMAGE", link: null },
      { name: "channel", type: "COMBO", widget: true, link: null },
    ],
  };
}

// ---- #351: numeric-string index resolves as an index, not a name -----------

test("#351: resolveExplicitSlot treats a numeric STRING '0' as an index", () => {
  const outputs = loadVideoNode().outputs;
  assert.deepEqual(resolveExplicitSlot(outputs, "0"), { index: 0 });
  assert.deepEqual(resolveExplicitSlot(outputs, 0), { index: 0 });
  assert.deepEqual(resolveExplicitSlot(outputs, "3"), { index: 3 });
});

test("#351: a numeric-string index still range-checks", () => {
  const outputs = loadVideoNode().outputs; // length 4
  assert.deepEqual(resolveExplicitSlot(outputs, "9"), { error: "range" });
});

test("#351: a genuine slot NAME still resolves by name", () => {
  const outputs = loadVideoNode().outputs;
  assert.deepEqual(resolveExplicitSlot(outputs, "frame_count"), { index: 1 });
  assert.deepEqual(resolveExplicitSlot(outputs, "nope"), { error: "name" });
});

test("#351: a slot literally NAMED '0' is still reachable by name (name-first)", () => {
  // The string-as-name contract is preserved: an exact name match wins over the
  // numeric-index fallback, so a slot named "0" is not shadowed by index 0.
  const outputs = [
    { name: "IMAGE", type: "IMAGE" },
    { name: "0", type: "MASK" },
  ];
  assert.deepEqual(resolveExplicitSlot(outputs, "0"), { index: 1 }); // the NAMED "0"
});

test("#351: from_output='0' → to_input='image' connects a valid IMAGE→IMAGE", () => {
  const origin = loadVideoNode();
  const target = imageToMaskNode();
  // The exact reproduction: from_output arrives as the STRING "0". Before the
  // fix this was read as a slot NAMED "0" (miss) → threw the generic diagnostic.
  const m = autoMatchSlots(origin, target, "0", "image");
  assert.equal(m.outIdx, 0);
  assert.equal(m.inIdx, 0);
});

test("#351: restore a just-removed link with from_output='0', to_input auto", () => {
  const origin = loadVideoNode();
  const target = imageToMaskNode();
  const m = autoMatchSlots(origin, target, "0", null);
  assert.equal(m.outIdx, 0);
  assert.equal(m.inIdx, 0); // the empty IMAGE input, not the combo/widget
  assert.deepEqual(m.autoMatched, ["to_input"]);
});

test("#351: the failure diagnostic uses name-first resolution for from_output", () => {
  // A slot literally named "0" (type MASK) vs index 0 (type IMAGE): the tail must
  // describe the NAMED slot's type (MASK), consistent with resolveExplicitSlot.
  const origin = {
    id: 3,
    type: "Weird",
    outputs: [
      { name: "IMAGE", type: "IMAGE" },
      { name: "0", type: "MASK" },
    ],
  };
  const target = { id: 4, type: "T", inputs: [{ name: "x", type: "LATENT", link: null }] };
  const msg = slotDiagnostic(origin, target, { from_output: "0", to_input: "x" });
  assert.match(msg, /accepts type MASK/);
  assert.doesNotMatch(msg, /accepts type IMAGE/);
});

// ---- #204 invariant: incompatible types stay refused -----------------------

test("#204: an INT output auto-matched to an IMAGE-only target is still refused", () => {
  const origin = {
    id: 1,
    type: "IntSource",
    outputs: [{ name: "value", type: "INT" }],
  };
  const target = imageToMaskNode(); // only IMAGE (+ combo widget) inputs
  // Auto-match (both sides) must find NO compatible pair — INT≠IMAGE, INT≠COMBO.
  assert.throws(() => autoMatchSlots(origin, target, null, null), /accepts type INT|Could not connect/);
});

test("#204: isTypeCompatible keeps IMAGE≠MASK incompatible, IMAGE=IMAGE exact", () => {
  assert.equal(isTypeCompatible("IMAGE", "IMAGE"), 2);
  assert.equal(isTypeCompatible("IMAGE", "MASK"), 0);
  // union input "IMAGE,MASK" accepts an IMAGE output (any-segment match)
  assert.ok(isTypeCompatible("IMAGE", "IMAGE,MASK") > 0);
  // combo never matches via wildcard
  assert.equal(isTypeCompatible("*", "COMBO"), 0);
});

// ---- #169: don't clobber an occupied dynamic wildcard input -----------------

function bypasserNode(inputs) {
  return { id: 900, type: "Fast Bypasser (rgthree)", inputs };
}
function sourceNode() {
  return { id: 42, type: "CheckpointLoader", outputs: [{ name: "MODEL", type: "MODEL" }] };
}

test("#169: isWildcardSlotType flags '*' but not a typed / type-less input", () => {
  assert.equal(isWildcardSlotType("*"), true);
  assert.equal(isWildcardSlotType("IMAGE"), false);
  assert.equal(isWildcardSlotType(undefined), false);
});

test("#169: a FREE wildcard is used instead of the occupied one (no clobber)", () => {
  const target = bypasserNode([
    { name: "input_0", type: "*", link: 7 }, // occupied controller link
    { name: "input_1", type: "*", link: null }, // fresh empty wildcard
  ]);
  const m = autoMatchSlots(sourceNode(), target, "0", null);
  assert.equal(m.inIdx, 1); // free slot chosen, occupied one preserved
});

test("#169: NO free wildcard → refuse non-destructively (don't replace occupied *)", () => {
  const target = bypasserNode([
    { name: "input_0", type: "*", link: 7 }, // the ONLY wildcard, occupied
  ]);
  // Before the fix, auto-match picked input_0 and returned replaced_link,
  // silently dropping the earlier controller connection.
  assert.throws(
    () => autoMatchSlots(sourceNode(), target, "0", null),
    /occupied dynamic wildcard/,
  );
});

test("#169: an EXPLICIT to_input still replaces an occupied wildcard deliberately", () => {
  const target = bypasserNode([{ name: "input_0", type: "*", link: 7 }]);
  const m = autoMatchSlots(sourceNode(), target, "0", 0);
  assert.equal(m.inIdx, 0);
  assert.deepEqual(m.autoMatched, []);
});

test("#169: a typed occupied input (reconnect) is NOT blocked by the wildcard guard", () => {
  // A normal typed reconnect (e.g. replacing KSampler.model) must still work via
  // auto-match — the guard is wildcard-only.
  const target = {
    id: 5,
    type: "KSampler",
    inputs: [{ name: "model", type: "MODEL", link: 3 }],
  };
  const m = autoMatchSlots(sourceNode(), target, "0", null);
  assert.equal(m.inIdx, 0);
});
