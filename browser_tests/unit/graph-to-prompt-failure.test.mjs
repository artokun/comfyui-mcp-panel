// #1582 — a full-graph run whose graph cannot be serialized fails with a bare TypeError.
//
// On a 317-node community workflow referencing packs that are not installed:
//
//   panel_run {}                      → "Cannot read properties of undefined (reading 'workflow')"
//   panel_run { to_node_id: 2934 }    → "the prompt could not be fingerprinted (graphToPrompt
//                                        failed) … Nothing was queued rather than risk a
//                                        full-graph execution (#556)."
//
// Same root cause, two very different answers. The first names nothing, reads like an internal
// panel crash, and gave the reporter no reason to suspect their graph — they only learned the
// truth by chance, retrying with `to_node_id`.
//
// The TypeError itself comes from ComfyUI's own `queuePrompt`, which dereferences `.workflow`
// on the `graphToPrompt()` result. Our pre-flight runs first and lets it through:
// `unrunnableNodeIds(undefined)` answers `[]` — no offenders — because a result that does not
// exist has no unrunnable entries in it. Absence of evidence, read as evidence of absence.
import test from "node:test";
import assert from "node:assert/strict";

import {
  unrunnableNodeIds,
  graphToPromptUnusable,
  unserializableGraphRefusal,
} from "../../web/js/lib/missing-node-preflight.js";

test("#1582 unrunnableNodeIds cannot speak for a result that does not exist", () => {
  // Not a defect in this function — it is answering a different question. Pinned so the
  // reason the pre-flight needs a SEPARATE check stays visible.
  assert.deepEqual(unrunnableNodeIds(undefined), []);
  assert.deepEqual(unrunnableNodeIds(null), []);
});

test("#1582 an absent or malformed graphToPrompt result is recognised", () => {
  for (const bad of [undefined, null, {}, { output: undefined }, { output: null }, "nope", 7]) {
    assert.equal(graphToPromptUnusable(bad), true, JSON.stringify(bad) ?? String(bad));
  }
});

test("#1582 a USABLE result is not flagged", () => {
  // The direction that would break every run: a healthy prompt must sail through. An empty
  // output object is legitimate (an empty graph), and is not this failure.
  for (const ok of [
    { output: { 1: { class_type: "KSampler", inputs: {} } }, workflow: {} },
    { output: {}, workflow: {} },
  ]) {
    assert.equal(graphToPromptUnusable(ok), false, JSON.stringify(ok));
  }
});

test("#1582 the refusal says WHAT failed and that nothing was queued", () => {
  const msg = unserializableGraphRefusal([]);
  // The two things the bare TypeError did not say.
  assert.match(msg, /graphToPrompt/);
  assert.match(msg, /nothing was queued|not queued/i);
  // And it must not read as a panel crash, which is what sent the reporter looking in the
  // wrong place.
  assert.doesNotMatch(msg, /Cannot read properties/);
});

test("#1582 the refusal NAMES the node types the frontend could not resolve", () => {
  // The reporter's item 2. "Serialization failed" still leaves them guessing which of the
  // 317 nodes is at fault; the panel already knows the unresolved types.
  const msg = unserializableGraphRefusal(["LCKreaSampler", "Florence2Run", "SAM_SmartInpainter"]);
  assert.match(msg, /LCKreaSampler/);
  assert.match(msg, /Florence2Run/);
  assert.match(msg, /SAM_SmartInpainter/);
});

test("#1582 with no types identified it still refuses, without inventing a cause", () => {
  // Serialization can fail for reasons other than a missing pack. Naming one anyway would
  // send the user to install something they already have.
  const msg = unserializableGraphRefusal([]);
  assert.doesNotMatch(msg, /missing (custom )?node|install the/i);
  assert.match(msg, /graphToPrompt/);
});

test("#1582 a long type list is bounded", () => {
  // The reported graph has ~35 LC* nodes alone. An unbounded list buries the instruction
  // underneath it.
  const many = Array.from({ length: 60 }, (_, i) => `LCNode${i}`);
  const msg = unserializableGraphRefusal(many);
  assert.ok(msg.length < 1200, `refusal must stay readable, was ${msg.length} chars`);
  assert.match(msg, /LCNode0/);
  assert.match(msg, /more|…|\.\.\./);
});
