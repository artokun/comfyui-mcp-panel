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
import { readFileSync } from "node:fs";

import {
  findRepeatingControlWidgets,
  scopedBatchSeedNote,
  findRgthreeSeedNodes,
  rgthreeFixedSeedNote,
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
    paired_widget_source: "adjacent",
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
  assert.match(note, /^THIS BATCH WILL REUSE THE SAME/, "the consequence first");
  assert.match(note, /node 42 \(KSampler\) seed=randomize/, "which widget on which node");
  assert.match(note, /1\.48\.7/, "attributes the behaviour to the build it was measured on");
  assert.match(note, /batch_count:1/, "workaround one");
  assert.match(note, /drop to_node_id/, "workaround two");
  // Two claims it must NOT make.
  assert.match(note, /not something the panel chose/, "the cause is the frontend queue loop");
  // codex: the scan is workflow-wide but the run is scoped, so the claim is conditional.
  assert.match(note, /any of these controls its scope actually reaches/, "conditional, not absolute");
  assert.match(note, /ALREADY QUEUED/, "and it does not pretend the caller can still prevent it");
  assert.match(note, /does not rewrite your values/, "and the panel says what it declined to do");
});

test("#988 the note caps its list but says how many it left out", () => {
  const many = Array.from({ length: 9 }, (_, i) => ksampler(i, "randomize"));
  const note = scopedBatchSeedNote(findRepeatingControlWidgets(many), 2);
  assert.match(note, /and 4 more/, "a truncated list must not read as the whole list");
});

test("#988 (codex): `increment-wrap` advances too and must be warned about", () => {
  // ComfyUI ships it. The report only names randomize, and warning on that alone would
  // have left a mode silently broken.
  assert.equal(findRepeatingControlWidgets([ksampler(1, "increment-wrap")]).length, 1);
});

test("#988 (codex): LINKAGE beats adjacency for naming the governed widget", () => {
  // Adjacency is a UI-insertion convention custom nodes need not preserve, so the
  // source of the pairing is reported and linkage wins when the frontend supplies it.
  // The link points VALUE -> CONTROL, which is the direction ComfyUI actually uses.
  // An earlier version of this test attached `linkedWidgets` to the CONTROL and passed
  // against code reading it the same wrong way — so it validated the wrong shape and
  // the authoritative signal was never really exercised.
  const control = { name: "control_after_generate", value: "randomize" };
  const node = {
    id: 7,
    type: "Custom",
    widgets: [
      { name: "not_the_seed", value: 1 },
      { name: "real_seed", value: 5, linkedWidgets: [control] },
      control,
    ],
  };
  const found = findRepeatingControlWidgets([node]);
  assert.equal(found[0].paired_widget, "real_seed");
  assert.equal(found[0].paired_widget_source, "linked");
});

test("#988 (codex) source guard: the scan runs BEFORE dispatch, not after", () => {
  // Measuring afterwards described a run already submitted while the note claimed it
  // let the caller cancel — a remedy it could not offer.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const scan = src.indexOf("repeatingControls = findRepeatingControlWidgets(");
  const dispatch = src.indexOf("await app.queuePrompt(0, batch, undefined)");
  const scopedDispatch = src.indexOf("runScopeResult = await dispatchScopedRun({");
  assert.ok(scan > 0, "the pre-dispatch scan must exist");
  assert.ok(scan < dispatch && scan < scopedDispatch, "and precede BOTH dispatch paths");
});

test("#988 (codex r3): the warning is NOT gated on Comfy.WidgetControlMode — measured in both", () => {
  // ComfyUI can install the control's mutation as beforeQueued OR afterQueued, and only
  // one mode had been observed. Flipping `Comfy.WidgetControlMode` on the live install
  // and repeating the prompt-body capture:
  //
  //   mode "after"   scoped [0,0,0]   unscoped [0, 1052866786709601, 413884900582428]
  //   mode "before"  scoped [0,0,0]   unscoped [267357841888133, 145435791190359, 43867923644491]
  //
  // The scoped batch repeats in BOTH, so a mode-dependent gate would add a branch that
  // is never taken — and gating on a setting the panel cannot see would have been
  // guesswork. This pins that the detector deliberately ignores the setting.
  const controls = findRepeatingControlWidgets([ksampler(42, "randomize")]);
  assert.equal(controls.length, 1, "detection does not consult any widget-control-mode setting");
  const note = scopedBatchSeedNote(controls, 3);
  assert.doesNotMatch(note, /WidgetControlMode|beforeQueued|afterQueued/, "and makes no claim about it");
});

/**
 * #1339 — the same surprise from a node #988's scan cannot see.
 *
 * The widget shape here is taken from a LIVE `Seed (rgthree)` instance created in the
 * browser, not from what the node looks like in my head: rgthree removes
 * `control_after_generate` and leaves `seed` plus three buttons.
 */
const rgthreeSeed = (id, seedValue) => ({
  id,
  type: "Seed (rgthree)",
  widgets: [
    { name: "seed", value: seedValue },
    { name: "🎲 Randomize Each Time", value: "" },
    { name: "🎲 New Fixed Random", value: "" },
    { name: "USE_LAST_SEED", value: "okay" },
  ],
});

test("#1339 — an rgthree seed node is invisible to the control_after_generate scan", () => {
  // The defect, stated as a test: this is why the reporter got no warning at all.
  assert.deepEqual(findRepeatingControlWidgets([rgthreeSeed(649, 12345)]), []);
  // …and the new scan does see it.
  assert.equal(findRgthreeSeedNodes([rgthreeSeed(649, 12345)]).length, 1);
});

test("#1339 — a FIXED rgthree seed is reported for a batch > 1", () => {
  const found = findRgthreeSeedNodes([rgthreeSeed(649, 12345)]);
  assert.deepEqual(found, [
    { node_id: "649", node_type: "Seed (rgthree)", seed: 12345, armed: false, varies: false },
  ]);
  const note = rgthreeFixedSeedNote(found, 10);
  assert.match(note, /ALL 10 ITEMS/);
  assert.match(note, /node 649/);
  assert.match(note, /12345/);
  // The remedy is the button that arms it, named exactly as the node shows it.
  assert.match(note, /Randomize Each Time/);
});

test("#1339 — an ARMED rgthree seed says NOTHING", () => {
  // The direction that matters most. Measured: driving rgthree's handler three times with
  // the sentinel posts three DIFFERENT seeds, and a scoped batch calls api.queuePrompt
  // once per item — so an armed node genuinely varies, and warning about it would be a
  // confident wrong sentence. This is also why the #988 note is not simply reused here.
  for (const [sentinel, mode] of [
    [-1, "randomize"],
    [-2, "increment"],
    [-3, "decrement"],
  ]) {
    const found = findRgthreeSeedNodes([rgthreeSeed(649, sentinel)]);
    assert.deepEqual(found, [
      { node_id: "649", node_type: "Seed (rgthree)", seed: sentinel, armed: true, varies: true, mode },
    ]);
    assert.equal(rgthreeFixedSeedNote(found, 10), "");
  }
});

test("#1339 — a LINKED seed is still read from the widget, because rgthree overwrites it", () => {
  // I added a guard here that declined when the seed was converted to an input, reasoning
  // that the widget value would be stale. That is true of an ordinary node and FALSE of
  // this one: rgthree's queue handler writes `outputInputs[seed] = getSeedToUse()` from
  // its own widget regardless of any link. Declining suppressed the warning for a linked
  // node holding a fixed number — a MISSED warning, which is the original bug rather than
  // a new false claim (codex probe 2).
  const driven = { ...rgthreeSeed(649, 12345), inputs: [{ name: "seed", link: 42 }] };
  const found = findRgthreeSeedNodes([driven]);
  assert.equal(found.length, 1);
  assert.equal(found[0].varies, false);
  assert.match(rgthreeFixedSeedNote(found, 10), /node 649/);
});

test("#1339 — an ARMED node with a degenerate random range still repeats", () => {
  // codex P2. rgthree's randomMin/randomMax are node PROPERTIES the user can edit, and
  // `generateRandomSeed` draws inside them — so a range admitting one value returns that
  // value every time while the node looks armed. Silence there would recreate the exact
  // surprise this warning exists for, and it is the more confusing case: they DID press
  // the button.
  const degenerate = {
    ...rgthreeSeed(649, -1),
    properties: { randomMin: 5, randomMax: 5 },
  };
  const found = findRgthreeSeedNodes([degenerate]);
  assert.equal(found[0].armed, true);
  assert.equal(found[0].varies, false);
  const note = rgthreeFixedSeedNote(found, 10);
  assert.match(note, /armed to randomize/);
  assert.match(note, /randomMin=5, randomMax=5/);
  assert.match(note, /randomMin\/randomMax/);

  // A range that LOOKS healthy but cannot vary, because of the widget's step. rgthree
  // divides by step/10, so randomRange <= 1 makes every draw return randomMin — measured
  // as ONE distinct value across 200 draws at min=0, max=5, step=100, while `min < max`
  // says nothing is wrong. Found by working the probe rather than waiting to be told.
  const bigStep = {
    ...rgthreeSeed(650, -1),
    properties: { randomMin: 0, randomMax: 5 },
    widgets: [{ name: "seed", value: -1, options: { step: 100 } }],
  };
  assert.equal(findRgthreeSeedNodes([bigStep])[0].varies, false);
  assert.match(rgthreeFixedSeedNote(findRgthreeSeedNodes([bigStep]), 3), /at step 100/);

  // …and the same narrow range at the ORDINARY step still varies (50 distinct values).
  const okStep = {
    ...rgthreeSeed(651, -1),
    properties: { randomMin: 0, randomMax: 5 },
    widgets: [{ name: "seed", value: -1, options: { step: 1 } }],
  };
  assert.equal(findRgthreeSeedNodes([okStep])[0].varies, true);

  // A NORMAL range keeps its silence — the defaults, and an explicit wide range.
  for (const properties of [undefined, { randomMin: 0, randomMax: 1125899906842624 }]) {
    const ok = { ...rgthreeSeed(649, -1), ...(properties ? { properties } : {}) };
    assert.equal(findRgthreeSeedNodes([ok])[0].varies, true);
    assert.equal(rgthreeFixedSeedNote(findRgthreeSeedNodes([ok]), 10), "");
  }
});

test("#1339 — a MUTED or BYPASSED seed node is not named", () => {
  // rgthree's handler returns early for exactly these modes, so the node substitutes
  // nothing and contributes nothing. Naming it points the user at a node that is not in
  // the run, in a warning whose entire value is naming the right one.
  for (const mode of [2, 4]) {
    assert.deepEqual(findRgthreeSeedNodes([{ ...rgthreeSeed(649, 12345), mode }]), [], `mode ${mode}`);
  }
  // …and an ordinary mode (0 = ALWAYS) is still reported.
  assert.equal(findRgthreeSeedNodes([{ ...rgthreeSeed(649, 12345), mode: 0 }]).length, 1);
});

test("#1339 — silent for a batch of one, where a repeated seed is not a surprise", () => {
  const found = findRgthreeSeedNodes([rgthreeSeed(649, 12345)]);
  assert.equal(rgthreeFixedSeedNote(found, 1), "");
  assert.equal(rgthreeFixedSeedNote(found, undefined), "");
});

test("#1339 — other seed nodes are NOT claimed as rgthree", () => {
  // The over-broad direction: this scan must not start describing nodes it knows nothing
  // about, or it will confidently call a node "fixed" whose extension randomizes it by
  // some other mechanism — which is the exact error this whole issue is about.
  //
  // A KSampler alone does not test that: its type has no "seed" in it, so dropping the
  // rgthree requirement leaves it unmatched and the mutation survives. These are REAL node
  // types from this machine's /object_info that do contain "seed".
  const foreignSeed = (id, type) => ({
    id,
    type,
    widgets: [{ name: "seed", value: 12345 }],
  });
  for (const type of ["SeedNode", "LatentBatchSeedBehavior", "SeedVR2Conditioning"]) {
    assert.deepEqual(findRgthreeSeedNodes([foreignSeed(1, type)]), [], type);
  }
  assert.deepEqual(findRgthreeSeedNodes([ksampler(53, "randomize")]), []);
  assert.deepEqual(findRgthreeSeedNodes([ksampler(53, "fixed")]), []);
});

test("#1339 — survives malformed nodes without taking down the run", () => {
  assert.deepEqual(findRgthreeSeedNodes(null), []);
  assert.deepEqual(findRgthreeSeedNodes([null, {}, { type: "Seed (rgthree)" }]), []);
  // A seed widget that is not a number establishes nothing, so it is not reported as fixed.
  assert.deepEqual(findRgthreeSeedNodes([rgthreeSeed(1, "not-a-number")]), []);
  assert.equal(rgthreeFixedSeedNote(null, 5), "");
});
