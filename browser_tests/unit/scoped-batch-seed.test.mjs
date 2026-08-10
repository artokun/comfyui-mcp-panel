/**
 * #988 — a SCOPED batch repeats the same seed, so every item after the first is served
 * from ComfyUI's cache and returns identical pixels.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7 by capturing the outgoing /prompt bodies
 * behind an interceptor that answered them locally — nothing queued, no GPU time:
 *
 *   app.queuePrompt(0, 3, undefined)  -> seeds 0, 275253667108059, 219005225600584
 *   app.queuePrompt(0, 3, ["<id>"])   -> seeds 0, 0, 0
 *
 * ComfyUI's own queue loop, called directly with no panel code in the path. A partial
 * execution skips the queue-time widget hooks, so `control_after_generate` never
 * advances. The panel reports it rather than rewriting seeds — see the module header.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  findRepeatingControlWidgets,
  scopedBatchSeedNote,
} from "../../web/js/lib/scoped-batch-seed.js";

/** The real KSampler widget order: the control sits immediately after the value. */
const ksampler = (id, mode) => ({
  id,
  type: "KSampler",
  widgets: [
    { name: "seed", value: 0 },
    { name: "control_after_generate", value: mode },
    { name: "steps", value: 20 },
  ],
});

test("#988 an advancing control is found, with the value widget it governs", () => {
  const found = findRepeatingControlWidgets([ksampler(42, "randomize")]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    node_id: "42",
    node_type: "KSampler",
    widget: "control_after_generate",
    mode: "randomize",
    paired_widget: "seed",
  });
});

test("#988 increment and decrement repeat too — randomize is not the only affected mode", () => {
  for (const mode of ["increment", "decrement"]) {
    assert.equal(findRepeatingControlWidgets([ksampler(1, mode)]).length, 1, mode);
  }
});

test("#988 `fixed` is NEVER reported — repeating is what it asks for", () => {
  assert.deepEqual(findRepeatingControlWidgets([ksampler(1, "fixed")]), []);
});

test("#988 a node with no control widget is not a finding", () => {
  const plain = { id: 2, type: "EmptyLatentImage", widgets: [{ name: "width", value: 512 }] };
  assert.deepEqual(findRepeatingControlWidgets([plain]), []);
});

test("#988 the paired widget is reported only when it EXISTS — never guessed", () => {
  // A control with nothing before it: the value it governs cannot be identified, and
  // naming the wrong widget would be worse than naming none.
  const odd = { id: 3, type: "Weird", widgets: [{ name: "control_after_generate", value: "randomize" }] };
  const found = findRepeatingControlWidgets([odd]);
  assert.equal(found.length, 1);
  assert.equal("paired_widget" in found[0], false);
});

test("#988 the collector is total — malformed input yields fewer findings, never a throw", () => {
  const hostile = {
    id: 4,
    get widgets() {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => findRepeatingControlWidgets([hostile, ksampler(5, "randomize")]));
  assert.deepEqual(
    findRepeatingControlWidgets([hostile, ksampler(5, "randomize")]).map((f) => f.node_id),
    ["5"],
    "one bad node costs its own entry, not the whole diagnosis",
  );
  for (const bad of [null, undefined, "nope", [null], [{}], [{ widgets: "x" }]]) {
    assert.deepEqual(findRepeatingControlWidgets(bad), []);
  }
});

test("#988 the note fires ONLY for the reported combination", () => {
  const controls = findRepeatingControlWidgets([ksampler(42, "randomize")]);
  assert.equal(scopedBatchSeedNote(controls, 1), "", "a batch of one repeats nothing");
  assert.equal(scopedBatchSeedNote([], 3), "", "no advancing control, nothing to say");
  assert.equal(scopedBatchSeedNote(null, 3), "");
  assert.ok(scopedBatchSeedNote(controls, 3).length > 0, "scoped batch > 1 with an advancing control");
});

test("#988 the note names the nodes, the cause, and the two things that DO work", () => {
  const note = scopedBatchSeedNote(findRepeatingControlWidgets([ksampler(42, "randomize")]), 3);
  assert.match(note, /^EVERY ITEM OF THIS BATCH WILL USE THE SAME/, "the consequence first");
  assert.match(note, /node 42 \(KSampler\) seed=randomize/, "which widget on which node");
  assert.match(note, /1\.48\.7/, "attributes the behaviour to the build it was measured on");
  assert.match(note, /batch_count:1/, "workaround one");
  assert.match(note, /drop to_node_id/, "workaround two");
  // Two claims it must NOT make.
  assert.match(note, /not something the panel chose/, "the cause is the frontend's queue loop");
  assert.match(note, /does not rewrite your seeds/, "and the panel says what it declined to do");
});

test("#988 the note caps its list but says how many it left out", () => {
  const many = Array.from({ length: 9 }, (_, i) => ksampler(i, "randomize"));
  const note = scopedBatchSeedNote(findRepeatingControlWidgets(many), 2);
  assert.match(note, /and 4 more/, "a truncated list must not read as the whole list");
});
