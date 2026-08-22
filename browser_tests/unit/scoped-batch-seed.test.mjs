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
  driveControlHooksAcrossScopedBatch,
  nodesInPartialExecutionScope,
  scopedBatchDriveNote,
  findRgthreeSeedNodes,
  rgthreeFixedSeedNote,
  repeatingRgthreeSeeds,
  rgthreeQueueTimeSeedInput,
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
  // #1565 — the unscoped dispatch is BOUNDED by the command budget now, so the literal is
  // no longer a bare `await`. The anchor follows the call; the ordering property it guards
  // is unchanged, and the assertion below pins that it is still the bounded call.
  const dispatch = src.indexOf("app.queuePrompt(0, batch, undefined)");
  assert.match(
    src.slice(Math.max(0, dispatch - 200), dispatch + 200),
    /Promise\.resolve\(\s*queuePromptWithGraphToPromptSnapshot\([\s\S]*?app\.queuePrompt\(0, batch, undefined\)/,
    "the unscoped dispatch must stay bounded — an unbounded one hangs past the relay window",
  );
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

// ---------------------------------------------------------------------------
// #1124 — the same measured rgthree behaviour, read by the #556 drift guard.
//
// The guard stamps the graph before dispatch and compares it against the POSTED
// body. rgthree substitutes the seed AFTER that stamp, inside its own
// api.queuePrompt patch, and carries no `beforeQueued` hook for the guard to
// notice — so every scoped run on a workflow with an armed Seed (rgthree) was
// refused as "the graph CHANGED". This helper is what tells the guard which
// single input to stop hashing.
// ---------------------------------------------------------------------------

test("#1124 — an ARMED rgthree seed names the input rgthree will rewrite", () => {
  for (const sentinel of [-1, -2, -3]) {
    assert.equal(rgthreeQueueTimeSeedInput(rgthreeSeed(47, sentinel)), "seed", `sentinel ${sentinel}`);
  }
});

test("#1124 — a FIXED rgthree seed excludes NOTHING, so a mid-window edit to it is still drift", () => {
  // The gate, in the same direction as collectVolatileInputs' `value === "fixed"`
  // rule for the stock control_after_generate carrier. `getSeedToUse()` returns a
  // non-sentinel `inputSeed` unchanged, so the body carries exactly what the stamp
  // saw — nothing mutates, and dropping it from the hash would blind the guard to
  // a real edit for no benefit.
  assert.equal(rgthreeQueueTimeSeedInput(rgthreeSeed(47, 12345)), null);
  assert.equal(rgthreeQueueTimeSeedInput(rgthreeSeed(47, 0)), null);
});

test("#1124 — ARMED is the gate, NOT `varies`: a degenerate random range still substitutes", () => {
  // The distinction that a reviewer will reach for, so it is pinned here.
  // findRgthreeSeedNodes reports `varies: false` for an armed node whose
  // randomMin/randomMax admit one value — correct for the #1339 warning, wrong
  // for the drift guard. Such a node still REPLACES the -1 sentinel in the body
  // with that single value, so the input still differs between the two
  // serializations and must still be excluded. Keying this on `varies` would have
  // left exactly the degenerate-range workflows refused.
  const degenerate = { ...rgthreeSeed(47, -1), properties: { randomMin: 5, randomMax: 5 } };
  assert.equal(findRgthreeSeedNodes([degenerate])[0].varies, false, "the #1339 warning says it repeats");
  assert.equal(rgthreeQueueTimeSeedInput(degenerate), "seed", "…and the drift guard still excludes it");
});

test("#1124 — a MUTED or BYPASSED node substitutes nothing, so it excludes nothing", () => {
  // rgthree: `if (this.mode === LiteGraph.NEVER || this.mode === 4) return;`
  for (const mode of [2, 4]) {
    assert.equal(rgthreeQueueTimeSeedInput({ ...rgthreeSeed(47, -1), mode }), null, `mode ${mode}`);
  }
  assert.equal(rgthreeQueueTimeSeedInput({ ...rgthreeSeed(47, -1), mode: 0 }), "seed");
});

test("#1124 — a LOOK-ALIKE foreign node whose type merely CONTAINS 'rgthree' and 'seed' is NOT excluded", () => {
  // The defect this exact-type match exists to prevent (codex r1 P2). The #1339
  // scan's predicate is two substring tests, so all of these satisfy it — and each
  // carries a `seed` widget armed with a real rgthree sentinel, so every other gate
  // in the function passes too. If the exclusion used that predicate, these nodes'
  // seeds would be dropped from BOTH hashes despite installing no queue-time
  // rewrite, and a genuine deferred edit to one would bypass the #556 guard
  // silently, for every scoped run on that graph.
  const lookAlikes = [
    "Seed Generator (rgthree-style)",
    "rgthree Seed Helper",
    "Advanced Seed (rgthree compatible)",
    "seed (rgthree)", // lowercase — not the registered type
    "Seed (rgthree) ", // trailing space — not the registered type
  ];
  for (const type of lookAlikes) {
    const node = { id: 47, type, mode: 0, widgets: [{ name: "seed", value: -1 }] };
    // It DOES satisfy the loose #1339 predicate — that is what makes it dangerous…
    assert.equal(findRgthreeSeedNodes([node]).length, 1, `${type} matches the loose #1339 scan`);
    // …and it must STILL be fully drift-covered.
    assert.equal(rgthreeQueueTimeSeedInput(node), null, `${type} must NOT be excluded`);
  }
  // The registered type, unchanged, still is.
  assert.equal(rgthreeQueueTimeSeedInput(rgthreeSeed(47, -1)), "seed");
});

test("#1124 — the #1339 warning predicate is deliberately NOT tightened along with the exclusion", () => {
  // The two callers want opposite failure directions, so the split is the point:
  // over-warning is noise, over-excluding is lost drift coverage. Pinned so a
  // later "consolidate these two predicates" cleanup has to read the reason first.
  const variant = { id: 47, type: "Seed Generator (rgthree-style)", mode: 0, widgets: [{ name: "seed", value: 12345 }] };
  assert.equal(findRgthreeSeedNodes([variant]).length, 1, "#1339 still warns generously");
  assert.equal(rgthreeQueueTimeSeedInput(variant), null, "#1124 still excludes strictly");
});

test("#1124 — foreign seed nodes and malformed nodes exclude NOTHING (fail toward detecting drift)", () => {
  // The over-broad direction is the dangerous one here: a false exclusion silently
  // drops an input from the drift check for every run on that graph. These are the
  // same real /object_info types the #1339 scan is guarded against claiming.
  for (const type of ["SeedNode", "LatentBatchSeedBehavior", "SeedVR2Conditioning"]) {
    assert.equal(rgthreeQueueTimeSeedInput({ id: 1, type, widgets: [{ name: "seed", value: -1 }] }), null, type);
  }
  assert.equal(rgthreeQueueTimeSeedInput(ksampler(53, "randomize")), null);
  assert.equal(rgthreeQueueTimeSeedInput(null), null);
  assert.equal(rgthreeQueueTimeSeedInput({}), null);
  assert.equal(rgthreeQueueTimeSeedInput({ type: "Seed (rgthree)" }), null, "no widgets ⇒ no exclusion");
  assert.equal(rgthreeQueueTimeSeedInput(rgthreeSeed(47, "not-a-number")), null);
  // A throwing accessor must not escape onto the dispatch path.
  const hostile = { type: "Seed (rgthree)", get widgets() { throw new Error("boom"); } };
  assert.equal(rgthreeQueueTimeSeedInput(hostile), null);
});

/**
 * #1339 round 2 — THE ARRAY AND THE SENTENCE DISAGREED.
 *
 * The shipped fix computed the prose with `varies === false` and the structured
 * `fixed_seed_nodes` field with `armed === false`. Those agree for a concrete seed and
 * DISAGREE for the armed-but-degenerate node the note itself calls the confusing case —
 * so a run against one returned a sentence naming node 649 beside `fixed_seed_nodes: []`.
 * A program reads the array; only a human reads the sentence.
 */
test("#1339 r2 — an ARMED, degenerate node is in the ARRAY, not only in the prose", () => {
  const degenerate = { ...rgthreeSeed(649, -1), properties: { randomMin: 5, randomMax: 5 } };
  const found = findRgthreeSeedNodes([degenerate]);
  // Precondition: this is the shape the two predicates disagreed on.
  assert.equal(found[0].armed, true);
  assert.equal(found[0].varies, false);

  const note = rgthreeFixedSeedNote(found, 10);
  assert.notEqual(note, "", "the prose names it");
  // THE REGRESSION. Pre-fix this was `[]` — `seeds.filter(s => s.armed === false)`.
  const repeating = repeatingRgthreeSeeds(found);
  assert.equal(repeating.length, 1, "the array must name it too");
  assert.equal(repeating[0].node_id, "649");
  // …and the entry still carries WHICH of the two ways it repeats, so collapsing the
  // predicate did not collapse the distinction a reader needs.
  assert.equal(repeating[0].armed, true);
  assert.match(repeating[0].degenerate_range, /randomMin=5, randomMax=5/);
});

test("#1339 r2 — INVARIANT: every node the note names is in the array, and vice versa", () => {
  // The contract, stated as one property rather than a list of cases: the field is only
  // attached when the note is non-empty, so an empty array beside a note is a guaranteed
  // contradiction — never a "no findings" answer.
  const cases = [
    ["fixed", [rgthreeSeed(649, 12345)]],
    ["armed+degenerate", [{ ...rgthreeSeed(649, -1), properties: { randomMin: 5, randomMax: 5 } }]],
    ["armed+degenerate by step", [{
      ...rgthreeSeed(650, -1),
      properties: { randomMin: 0, randomMax: 5 },
      widgets: [{ name: "seed", value: -1, options: { step: 100 } }],
    }]],
    ["armed+healthy", [rgthreeSeed(649, -1)]],
    ["mixed", [rgthreeSeed(700, -1), rgthreeSeed(701, 999), { ...rgthreeSeed(702, -2), properties: { randomMin: 7, randomMax: 7 } }]],
    ["none", [ksampler(53, "randomize")]],
  ];
  for (const [label, nodes] of cases) {
    const found = findRgthreeSeedNodes(nodes);
    const note = rgthreeFixedSeedNote(found, 10);
    const repeating = repeatingRgthreeSeeds(found);
    assert.equal(Boolean(note), repeating.length > 0, `${label}: note and array must agree on WHETHER`);
    // …and on WHICH. Every id the sentence mentions is in the array.
    for (const s of found) {
      const named = note.includes(`node ${s.node_id}`);
      assert.equal(named, repeating.some((r) => r.node_id === s.node_id), `${label}: node ${s.node_id}`);
    }
  }
  // The armed+healthy case must be silent on BOTH channels, or the fix traded a missing
  // warning for a false one.
  const healthy = findRgthreeSeedNodes([rgthreeSeed(649, -1)]);
  assert.equal(rgthreeFixedSeedNote(healthy, 10), "");
  assert.deepEqual(repeatingRgthreeSeeds(healthy), []);
});

test("#1339 r2 — repeatingRgthreeSeeds is total: malformed input yields [], never a throw", () => {
  for (const bad of [null, undefined, "nodes", 7, {}]) assert.deepEqual(repeatingRgthreeSeeds(bad), []);
  assert.deepEqual(repeatingRgthreeSeeds([null, undefined, {}]), [], "no `varies` ⇒ not a finding");
});

test("#1339 r2 source guard: the CALL SITE uses the shared predicate, not its own filter", () => {
  // A helper-level test cannot see this: the assignment lives in the monolith, and the
  // ONLY thing that made the two disagree was the call site rolling its own filter. So
  // assert on the source, and on EVERY assignment rather than the first — a second path
  // attaching the field is exactly how this comes back.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const sites = [...src.matchAll(/fixed_seed_nodes\s*=\s*([^\n;]+)/g)].map((m) => m[1].trim());
  assert.ok(sites.length > 0, "the field is no longer assigned anywhere — has it been renamed?");
  for (const rhs of sites) {
    assert.match(rhs, /^repeatingRgthreeSeeds\(/, `fixed_seed_nodes must come from the shared predicate, got: ${rhs}`);
    assert.doesNotMatch(rhs, /\barmed\b/, `the armed-only filter is the #1339 r2 regression: ${rhs}`);
  }
  // It has to be imported to be callable — a bare reference would be a ReferenceError
  // that only a live panel would surface.
  assert.match(src, /import \{[^}]*\brepeatingRgthreeSeeds\b[^}]*\} from "\.\/lib\/scoped-batch-seed\.js"/s);
});


// ---------------------------------------------------------------------------
// #1998 - the panel DRIVES ComfyUI's own control hooks across a scoped batch.
//
// THE DOUBLE BELOW IS A PORT, NOT AN INVENTION. Every branch is taken from the
// pinned frontend's own TypeScript, recovered from the sourcemaps that ship inside
// comfyui_frontend_package 1.49.6:
//
//   src/scripts/widgets.ts       valueControl.beforeQueued/afterQueued, the
//                                Comfy.WidgetControlMode split, HAS_EXECUTED
//   src/scripts/valueControl.ts  `if (params.isPartialExecution) return undefined`
//                                `if (mode === 'fixed') return undefined`
//                                computeNextNumberValue: += step / -= step / random
//   src/scripts/app.ts           the batch loop: beforeQueued -> graphToPrompt ->
//                                POST -> afterQueued, once per item
//
// It is checked against the LIVE rig: driving the real frontend through the real
// app.queuePrompt with the outgoing /prompt bodies captured behind an interceptor
// (ComfyUI 0.33.2 / frontend 1.49.6) produced
//
//   scoped   randomize -> 12345, 12345, 12345, 12345
//   scoped   increment -> 12345, 12345, 12345, 12345
//   unscoped increment -> 12345, 12346, 12347, 12348
//   scoped   increment + this drive -> 12345, 12346, 12347, 12348
//
// which is exactly what the assertions below say.
// ---------------------------------------------------------------------------

/** A value widget plus its frontend-shaped control combo, wired the way ComfyUI wires them. */
function controlledSeedNode(id, mode, { runBefore = false, startAt = 12345, linkFed = false } = {}) {
  const seed = { name: "seed", value: startAt, type: "number", options: { min: 0, max: 1e15, step2: 1 } };
  const control = {
    name: "control_after_generate",
    value: mode,
    // The AUTHORITATIVE frontend shape: serialize:false + canvasOnly:true + the mode
    // option list. isControlAfterGenerateWidget keys on exactly this.
    options: {
      serialize: false,
      canvasOnly: true,
      values: ["fixed", "increment", "decrement", "randomize"],
    },
  };
  seed.linkedWidgets = [control];
  let hasExecuted = false;
  const applyWidgetControl = (isPartialExecution) => {
    // widgets.ts applyWidgetControl: a governed input fed by a LINK is skipped on
    // EVERY path - the value that executes comes from the link, not the widget.
    if (linkFed) return;
    // valueControl.ts nextValueForLinkedTarget - ComfyUI_frontend #8774.
    if (isPartialExecution) return;
    // valueControl.ts computeNextControlledValue.
    if (control.value === "fixed") return;
    if (control.value === "increment" || control.value === "increment-wrap") seed.value += 1;
    else if (control.value === "decrement") seed.value -= 1;
    else if (control.value === "randomize") seed.value = Math.floor(Math.random() * 1e15);
  };
  control.beforeQueued = ({ isPartialExecution } = {}) => {
    if (runBefore) {
      if (hasExecuted) applyWidgetControl(isPartialExecution);
      hasExecuted = true;
    }
  };
  control.afterQueued = ({ isPartialExecution } = {}) => {
    if (!runBefore) applyWidgetControl(isPartialExecution);
  };
  return { id, type: "KSampler", widgets: [seed, control, { name: "steps", value: 20 }] };
}

/** app.ts's batch loop, reduced to the part that decides what each prompt carries.
 *  `readNodeId` names which node's seed to report — defaulting to the first node is
 *  fine for a one-branch fixture and silently reports `undefined` for a graph whose
 *  first node is a loader, which is how two of these tests first went green-looking. */
function queueBatch(nodes, { batchCount, isPartialExecution, readNodeId = null }) {
  const seedOf = (n) => (n.widgets ?? []).find((w) => w.name === "seed")?.value;
  const pick = () =>
    readNodeId == null
      ? seedOf(nodes[0])
      : seedOf(nodes.find((n) => String(n.id) === String(readNodeId)) ?? { widgets: [] });
  const posted = [];
  for (let i = 0; i < batchCount; i++) {
    for (const n of nodes) for (const w of n.widgets ?? []) w.beforeQueued?.({ isPartialExecution });
    posted.push(pick());
    for (const n of nodes) for (const w of n.widgets ?? []) w.afterQueued?.({ isPartialExecution });
  }
  return posted;
}

test("#1998 the double reproduces the bug: a scoped batch posts one seed four times", () => {
  const nodes = [controlledSeedNode(42, "randomize")];
  assert.deepEqual(queueBatch(nodes, { batchCount: 4, isPartialExecution: true }), [12345, 12345, 12345, 12345]);
});

test("#1998 the double reproduces the WORKING case: an unscoped batch advances", () => {
  const nodes = [controlledSeedNode(42, "increment")];
  assert.deepEqual(queueBatch(nodes, { batchCount: 4, isPartialExecution: false }), [12345, 12346, 12347, 12348]);
});

test("#1998 DRIVEN, a scoped randomize batch posts four different seeds", () => {
  const nodes = [controlledSeedNode(42, "randomize")];
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  const seeds = queueBatch(nodes, { batchCount: 4, isPartialExecution: true });
  drive.restore();
  assert.equal(new Set(seeds).size, 4, `expected four distinct seeds, got ${JSON.stringify(seeds)}`);
  assert.equal(seeds[0], 12345, "the FIRST item still carries the seed the user can see");
});

test("#1998 DRIVEN, a scoped increment batch matches the unscoped sequence exactly", () => {
  const scoped = [controlledSeedNode(42, "increment")];
  const drive = driveControlHooksAcrossScopedBatch(scoped);
  const driven = queueBatch(scoped, { batchCount: 4, isPartialExecution: true });
  drive.restore();
  const unscoped = queueBatch([controlledSeedNode(42, "increment")], { batchCount: 4, isPartialExecution: false });
  assert.deepEqual(driven, unscoped);
  assert.deepEqual(driven, [12345, 12346, 12347, 12348]);
});

test("#1998 DRIVEN, decrement runs backwards - the panel does no seed arithmetic of its own", () => {
  const nodes = [controlledSeedNode(42, "decrement")];
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  const seeds = queueBatch(nodes, { batchCount: 4, isPartialExecution: true });
  drive.restore();
  assert.deepEqual(seeds, [12345, 12344, 12343, 12342]);
});

test("#1998 `fixed` still repeats - and it is ComfyUI that refuses, not a panel branch", () => {
  const nodes = [controlledSeedNode(42, "fixed")];
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  // The control IS armed. If the panel skipped `fixed` itself, this would be empty and
  // the identical seeds below would prove nothing about who decided.
  assert.equal(drive.armed.length, 1, "the fixed control must still be driven");
  assert.equal(drive.armed[0].mode, "fixed");
  const seeds = queueBatch(nodes, { batchCount: 4, isPartialExecution: true });
  drive.restore();
  assert.deepEqual(seeds, [12345, 12345, 12345, 12345], "a fixed control must submit N identical prompts");
  assert.equal(scopedBatchDriveNote(drive.observe(), 4), "", "and nothing is said about it");
});

test("#1998 `fixed` repeats in Comfy.WidgetControlMode 'before' too", () => {
  const nodes = [controlledSeedNode(42, "fixed", { runBefore: true })];
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  const seeds = queueBatch(nodes, { batchCount: 4, isPartialExecution: true });
  drive.restore();
  assert.deepEqual(seeds, [12345, 12345, 12345, 12345]);
});

test("#1998 the drive works in Comfy.WidgetControlMode 'before' as well as 'after'", () => {
  const nodes = [controlledSeedNode(42, "increment", { runBefore: true })];
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  const seeds = queueBatch(nodes, { batchCount: 4, isPartialExecution: true });
  drive.restore();
  // 'before' skips the first execution (HAS_EXECUTED), so the advance starts on item 2 -
  // identical to what an unscoped 'before' run does.
  assert.deepEqual(seeds, [12345, 12346, 12347, 12348]);
});

test("#1998 restore() puts #8774 back - a later scoped run repeats again", () => {
  const nodes = [controlledSeedNode(42, "randomize")];
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  const driven = queueBatch(nodes, { batchCount: 2, isPartialExecution: true });
  drive.restore();
  assert.equal(new Set(driven).size, 2);
  const after = queueBatch(nodes, { batchCount: 3, isPartialExecution: true });
  assert.equal(new Set(after).size, 1, "an UNDRIVEN scoped run must behave exactly as ComfyUI ships it");
});

test("#1998 restore() is idempotent and survives a widget whose graph vanished", () => {
  const nodes = [controlledSeedNode(42, "randomize")];
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  drive.restore();
  assert.doesNotThrow(() => drive.restore());
});

test("#1998 a third-party beforeQueued hook that is NOT a control is left alone", () => {
  let calls = [];
  const node = {
    id: 7,
    type: "SomePack",
    widgets: [
      {
        name: "populated_text",
        value: "x",
        options: { serialize: true },
        beforeQueued: (o) => calls.push(o),
        afterQueued: (o) => calls.push(o),
      },
    ],
  };
  const drive = driveControlHooksAcrossScopedBatch([node]);
  assert.deepEqual(drive.armed, [], "only value-control combos are driven");
  queueBatch([node], { batchCount: 2, isPartialExecution: true });
  drive.restore();
  assert.ok(
    calls.every((o) => o.isPartialExecution === true),
    "a foreign hook must still be told the truth about the run it is in",
  );
});

test("#1998 a control detected by OPTION SHAPE is driven even when it is renamed", () => {
  const nodes = [controlledSeedNode(42, "increment")];
  nodes[0].widgets[1].name = "seed_behavior";
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  assert.equal(drive.armed.length, 1, "a name test would have dropped this one");
  const seeds = queueBatch(nodes, { batchCount: 3, isPartialExecution: true });
  drive.restore();
  assert.deepEqual(seeds, [12345, 12346, 12347]);
});

test("#1998 observe() reports what the widget DID, not what the drive asked for", () => {
  const nodes = [controlledSeedNode(42, "randomize"), controlledSeedNode(43, "randomize", { linkFed: true })];
  const drive = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 3 });
  queueBatch(nodes, { batchCount: 3, isPartialExecution: true });
  const seen = drive.observe();
  drive.restore();
  const byNode = Object.fromEntries(seen.map((o) => [o.node_id, o]));
  assert.equal(byNode["42"].advanced, true);
  assert.equal(byNode["42"].governed, "seed");
  assert.equal(byNode["42"].governed_source, "linked");
  assert.equal(byNode["43"].advanced, false, "a link-fed target is skipped by ComfyUI on every path");
  assert.equal(byNode["43"].observed, true, "and we DID watch it - `observed` is not `advanced`");
});

test("#1998 the note names what advanced and warns about what did not", () => {
  const nodes = [controlledSeedNode(42, "randomize"), controlledSeedNode(43, "increment", { linkFed: true })];
  const drive = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 4 });
  queueBatch(nodes, { batchCount: 4, isPartialExecution: true });
  const note = scopedBatchDriveNote(drive.observe(), 4);
  drive.restore();
  assert.match(note, /node 42 \(KSampler\) seed=randomize/);
  assert.match(note, /did NOT move/);
  assert.match(note, /node 43 \(KSampler\) seed=increment/);
  assert.match(note, /#8774/, "the note must name the upstream behaviour it is working around");
});

test("#1998 the note is silent for a batch of one and for a graph of only fixed controls", () => {
  const nodes = [controlledSeedNode(42, "randomize")];
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  queueBatch(nodes, { batchCount: 1, isPartialExecution: true });
  assert.equal(scopedBatchDriveNote(drive.observe(), 1), "");
  drive.restore();
  assert.equal(scopedBatchDriveNote([{ mode: "fixed", advanced: false, node_id: "1" }], 4), "");
});

test("#1998 the drive never throws on a malformed graph", () => {
  assert.doesNotThrow(() => driveControlHooksAcrossScopedBatch(null));
  assert.doesNotThrow(() => driveControlHooksAcrossScopedBatch([null, {}, { widgets: null }, { widgets: [null] }]));
  assert.deepEqual(driveControlHooksAcrossScopedBatch(undefined).armed, []);
});

test("#1998 CALL SITE: the drive is installed on the SCOPED path, and restored in a finally", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  // It has to be imported to be callable - a bare reference is a ReferenceError that
  // only a live panel would surface.
  assert.match(
    src,
    /import \{[^}]*\bdriveControlHooksAcrossScopedBatch\b[^}]*\} from "\.\/lib\/scoped-batch-seed\.js"/s,
    "driveControlHooksAcrossScopedBatch must be imported",
  );
  const install = src.indexOf("driveControlHooksAcrossScopedBatch(");
  const scopedDispatch = src.indexOf("runScopeResult = await dispatchScopedRun({");
  const unscopedDispatch = src.indexOf("await app.queuePrompt(0, batch, undefined)");
  assert.ok(install > 0, "the drive is never installed - the fix is not wired in");
  assert.ok(install < scopedDispatch, "it must be armed BEFORE the scoped dispatch it wraps");
  assert.ok(
    install > unscopedDispatch,
    "it must sit in the SCOPED branch: the unscoped path already advances and must not be touched",
  );
  // The restore has to be unconditional. A throw out of dispatchScopedRun that left the
  // hooks wrapped would keep advancing controls on the user's later single previews.
  //
  // The window runs from the INSTALL, not from the dispatch, and is generous: #1565 added
  // a `budget` argument plus its rationale between the two, and a window measured from the
  // dispatch stopped reaching the `finally` — a green-to-red that was purely about how much
  // comment sat in between.
  const tail = src.slice(install, install + 6000);
  assert.match(tail, /\}\s*finally\s*\{[\s\S]{0,900}?controlDrive\?\.restore\(\)/, "restore must run in a finally around the dispatch");
  // Gated on batch > 1: a scoped run of one keeps upstream #8774 behaviour. Assert on
  // the ARGUMENT EXPRESSION, not on a window of surrounding source - a window matched
  // the word "batch > 1" in the comment above the call and let a dropped gate survive.
  // Since gate P1-1 the gate rides on the SCOPE RESOLUTION that feeds the drive, so the
  // expression to read is that assignment, not the drive call itself.
  const scopeAssign = src.slice(src.indexOf("const inScope =", install - 600));
  const scopeExpr = scopeAssign.slice(0, scopeAssign.indexOf(";") + 1);
  assert.match(
    scopeExpr,
    /batch > 1\s*\?/,
    `the override must be gated on batch > 1, got: ${scopeExpr}`,
  );
});

test("#1998 a control the drive ARMED is described once, by the drive - never also by #988", () => {
  // This used to assert a source-level ternary that suppressed #988's note whenever the
  // observation array existed. Gate P1-2 showed that was the defect, not the invariant:
  // an empty (or off-scope-only) array silenced a control that really did repeat. The
  // invariant it was reaching for is behavioural and is now asserted as such - a control
  // gets EXACTLY ONE description, and which one depends on whether it was armed.
  const armed = [controlledSeedNode(42, "randomize")];
  const drive = driveControlHooksAcrossScopedBatch(armed, { batchCount: 4 });
  queueBatch(armed, { batchCount: 4, isPartialExecution: true });
  // The caller subtracts the ATTRIBUTED set, not merely the armed one (gate r2 P1-A).
  const uncovered = findRepeatingControlWidgets(armed, { skip: drive.attributedWidgets() });
  const driveNote = scopedBatchDriveNote(drive.observe(), 4);
  drive.restore();
  assert.deepEqual(uncovered, [], "an armed control must not also be named by #988");
  assert.equal(scopedBatchSeedNote(uncovered, 4), "", "so #988 has nothing to say about it");
  assert.match(driveNote, /node 42/, "and the drive note is the one that describes it");
});
// ---------------------------------------------------------------------------
// #1998 gate P1-1 - the drive must be confined to the partial-execution scope.
//
// REPRODUCED ON THE RIG before it was fixed, with a two-branch graph and
// `graph_run { batch_count: 4, to_node_id: 9 }` (posts captured, nothing queued):
//
//   partial_execution_targets  ["9"] on all four posts
//   node 3  (in scope)   seed widget 707000 -> 707004
//   node 13 (OFF scope)  seed widget 808000 -> 808004     <-- never executed
//
// and after the fix, same run:
//
//   node 3   posted 707000,707001,707002,707003   widget -> 707004
//   node 13  posted 808000,808000,808000,808000   widget  = 808000 (untouched)
// ---------------------------------------------------------------------------

/** A two-branch prompt map: 3 -> 9 and 13 -> 19, sharing loader 4. */
const twoBranchPrompt = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: {} },
  "3": { class_type: "KSampler", inputs: { model: ["4", 0] } },
  "9": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
  "13": { class_type: "KSampler", inputs: { model: ["4", 0] } },
  "19": { class_type: "SaveImage", inputs: { images: ["13", 0] } },
};

const twoBranchGraph = () => ({
  _nodes: [
    { id: 4, type: "CheckpointLoaderSimple", widgets: [] },
    controlledSeedNode(3, "increment", { startAt: 707000 }),
    { id: 9, type: "SaveImage", widgets: [] },
    controlledSeedNode(13, "increment", { startAt: 808000 }),
    { id: 19, type: "SaveImage", widgets: [] },
  ],
});

test("#1998 P1-1 the scope is the upstream closure of the target, nothing else", () => {
  const g = twoBranchGraph();
  const ids = nodesInPartialExecutionScope(g, twoBranchPrompt, ["9"])
    .map((n) => String(n.id))
    .sort();
  assert.deepEqual(ids, ["3", "4", "9"], "node 13 and node 19 are not in this run");
});

test("#1998 P1-1 an OFF-SCOPE control is never armed, and its widget is untouched", () => {
  const g = twoBranchGraph();
  const inScope = nodesInPartialExecutionScope(g, twoBranchPrompt, ["9"]);
  const drive = driveControlHooksAcrossScopedBatch(inScope);
  const seeds = queueBatch(g._nodes, { batchCount: 4, isPartialExecution: true, readNodeId: 3 });
  drive.restore();
  const seedOf = (id) => g._nodes.find((n) => n.id === id).widgets.find((w) => w.name === "seed").value;
  assert.deepEqual(seeds, [707000, 707001, 707002, 707003], "the IN-scope control still advances");
  assert.equal(seedOf(13), 808000, "the OFF-scope control must not be mutated at all");
  assert.deepEqual(
    drive.observe().map((o) => o.node_id),
    ["3"],
    "and it must not be reported as advanced either",
  );
});

test("#1998 P1-1 FAIL-CLOSED: an unprovable scope yields null, and null arms nothing", () => {
  const g = twoBranchGraph();
  // A root that is not a key of the prompt map: the closure cannot be computed.
  assert.equal(nodesInPartialExecutionScope(g, twoBranchPrompt, ["404"]), null);
  assert.equal(nodesInPartialExecutionScope(g, null, ["9"]), null, "no prompt map means unprovable");
  assert.equal(nodesInPartialExecutionScope(g, twoBranchPrompt, []), null, "no roots means unprovable");
  assert.equal(nodesInPartialExecutionScope(null, twoBranchPrompt, ["9"]), null);
  // ...and arming with the caller's `?? []` fallback touches nothing.
  const drive = driveControlHooksAcrossScopedBatch(nodesInPartialExecutionScope(g, null, ["9"]) ?? []);
  assert.deepEqual(drive.armed, []);
  const seeds = queueBatch(g._nodes, { batchCount: 3, isPartialExecution: true, readNodeId: 3 });
  drive.restore();
  assert.deepEqual(seeds, [707000, 707000, 707000], "unprovable scope keeps ComfyUI's shipped behaviour");
});

test("#1998 P1-1 a full run (no targets) is not something this function narrows", () => {
  const g = twoBranchGraph();
  assert.equal(nodesInPartialExecutionScope(g, twoBranchPrompt, null), null);
});

test("#1998 P1-1 the prompt RESULT shape is accepted as well as its output map", () => {
  const g = twoBranchGraph();
  const ids = nodesInPartialExecutionScope(g, { output: twoBranchPrompt }, ["9"]).map((n) => String(n.id));
  assert.deepEqual(ids.sort(), ["3", "4", "9"]);
});

test("#1998 P1-1 nodesInPartialExecutionScope never throws on a malformed graph", () => {
  assert.doesNotThrow(() => nodesInPartialExecutionScope({ _nodes: [null, {}] }, twoBranchPrompt, ["9"]));
  assert.doesNotThrow(() => nodesInPartialExecutionScope({ _nodes: null }, twoBranchPrompt, ["9"]));
});

// ---------------------------------------------------------------------------
// #1998 gate P1-2 — an unarmed control keeps its repetition warning.
//
// REPRODUCED ON THE RIG: with the IN-SCOPE control carrying only `beforeQueued`,
// the four posts carried seed 707000 four times and `repeating_controls_note` was
// ABSENT — the reply reported neither the fix nor the warning. The observation
// array was NOT empty (an off-scope control had filled it), so an "is it empty"
// check would not have caught this. Coverage is per-WIDGET, not per-array.
//
// After the fix, same run: posts still 707000 x4 (a single-hook control cannot be
// driven), `batch_controls` absent (no false claim), `repeating_controls_note` present.
// ---------------------------------------------------------------------------

test("#1998 P1-2 a control with only ONE queue hook is not armed, and keeps its warning", () => {
  const nodes = [controlledSeedNode(42, "increment")];
  delete nodes[0].widgets[1].afterQueued;
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  assert.deepEqual(drive.armed, [], "both hooks are required - that is the frontend's own test");
  assert.equal(drive.armedWidgets.size, 0);
  const seeds = queueBatch(nodes, { batchCount: 4, isPartialExecution: true });
  drive.restore();
  assert.deepEqual(seeds, [12345, 12345, 12345, 12345], "so it still repeats...");
  const uncovered = findRepeatingControlWidgets(nodes, { skip: drive.armedWidgets });
  assert.equal(uncovered.length, 1, "an unarmed control keeps its repetition warning");
  assert.match(scopedBatchSeedNote(uncovered, 4), /node 42/);
});

test("#1998 P1-2 skip subtracts exactly the ARMED widgets, by identity not by id", () => {
  // Two nodes deliberately sharing an id, as a root node and a subgraph node can.
  const armedNode = controlledSeedNode(7, "randomize");
  const otherNode = controlledSeedNode(7, "randomize");
  const drive = driveControlHooksAcrossScopedBatch([armedNode]);
  const uncovered = findRepeatingControlWidgets([armedNode, otherNode], { skip: drive.armedWidgets });
  drive.restore();
  assert.equal(uncovered.length, 1, "matching on node_id would have silenced BOTH");
});

test("#1998 P1-2 no skip, or an empty one, leaves the shipped #988 scan untouched", () => {
  const nodes = [ksampler(42, "randomize")];
  const plain = findRepeatingControlWidgets(nodes);
  assert.deepEqual(findRepeatingControlWidgets(nodes, {}), plain);
  assert.deepEqual(findRepeatingControlWidgets(nodes, { skip: new Set() }), plain);
  assert.deepEqual(findRepeatingControlWidgets(nodes, { skip: null }), plain);
});

test("#1998 P1-1 CALL SITE: the drive is armed over the SCOPE, and null arms nothing", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(
    src,
    /import \{[^}]*\bnodesInPartialExecutionScope\b[^}]*\} from "\.\/lib\/scoped-batch-seed\.js"/s,
  );
  const install = src.indexOf("driveControlHooksAcrossScopedBatch(");
  const call = src.slice(Math.max(0, install - 400), install + 200);
  assert.match(
    call,
    /nodesInPartialExecutionScope\(rootGraph, preflightPrompt, partialTargets\)/,
    "the drive must be handed the partial-execution scope, not the whole workflow",
  );
  assert.match(call, /inScope \?\? \[\]/, "an unprovable scope must arm NOTHING, never the whole graph");
  assert.doesNotMatch(
    src.slice(install, install + 200),
    /collectAllGraphs/,
    "arming over every graph is gate P1-1",
  );
});

test("#1998 P1-2 CALL SITE: the #988 warning is subtracted by ATTRIBUTED widgets, not suppressed wholesale", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const sites = [...src.matchAll(/const repeatingNote = ([^\n;]+)/g)].map((m) => m[1].trim());
  assert.equal(sites.length, 1);
  assert.equal(
    sites[0],
    "scopedBatchSeedNote(repeatingControls, batch)",
    `the note must not be gated on the observation array existing, got: ${sites[0]}`,
  );
  // ARMED is not enough (gate r2 P1-A): a control whose hook calls came from another run
  // was being subtracted on the strength of that run's work. Only the ATTRIBUTED set may
  // silence #988's warning.
  assert.match(
    src,
    /const attributed = controlDrive\?\.attributedWidgets\?\.\(\) \?\? null;/,
    "the subtraction must come from what the drive can PROVE it owned",
  );
  assert.match(src, /\{ skip: attributed \}/, "and that set is what the scan skips");
  assert.doesNotMatch(
    src,
    /skip: controlDrive\.armedWidgets/,
    "subtracting the merely-armed set is gate r2 P1-A",
  );
  assert.match(
    src,
    /driveControlHooksAcrossScopedBatch\(inScope \?\? \[\], \{ batchCount: batch \}\)/,
    "the drive cannot attribute anything without the batch size",
  );
});

// ---------------------------------------------------------------------------
// #1998 gate r2 — the wrapper was unscoped in TIME, the way it had been unscoped
// in SPACE. Both reproduced by EXECUTING this module before either was fixed.
// ---------------------------------------------------------------------------

test("#1998 r2 P1-A an UNSCOPED queue inside our window is not ours: nothing is claimed", () => {
  // BEFORE: an unrelated unscoped batch of 3 during an armed drive produced
  //   observed:true advanced:true from 12345 to 12348 distinct:4
  // for a scoped batch that had not run a single item.
  const nodes = [controlledSeedNode(42, "increment")];
  const drive = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 4 });
  const foreign = queueBatch(nodes, { batchCount: 3, isPartialExecution: false });
  drive.restore();
  const o = drive.observe()[0];
  assert.deepEqual(foreign, [12345, 12346, 12347], "the other run is left completely alone");
  assert.equal(o.attributable, false, "its calls are not evidence about our batch");
  assert.equal(o.advanced, false, "so we claim no advancement");
  assert.equal(o.observed, false);
  assert.equal(scopedBatchDriveNote(drive.observe(), 4), "", "and the note says nothing about it");
});

test("#1998 r2 P1-A an unattributed control keeps #988's warning", () => {
  const nodes = [controlledSeedNode(42, "increment")];
  const drive = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 4 });
  queueBatch(nodes, { batchCount: 3, isPartialExecution: false }); // not ours
  drive.restore();
  assert.equal(drive.attributedWidgets().size, 0, "nothing may be subtracted");
  const uncovered = findRepeatingControlWidgets(nodes, { skip: drive.attributedWidgets() });
  assert.equal(uncovered.length, 1);
  assert.match(scopedBatchSeedNote(uncovered, 4), /node 42/);
});

test("#1998 r2 P1-A attribution is EXACT: one call too few or too many is not our batch", () => {
  for (const actual of [3, 5]) {
    const nodes = [controlledSeedNode(42, "increment")];
    const drive = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 4 });
    queueBatch(nodes, { batchCount: actual, isPartialExecution: true });
    drive.restore();
    assert.equal(drive.observe()[0].attributable, false, `batch of ${actual} against an expected 4`);
  }
  // …and the exact count does attribute.
  const nodes = [controlledSeedNode(42, "increment")];
  const drive = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 4 });
  queueBatch(nodes, { batchCount: 4, isPartialExecution: true });
  drive.restore();
  const o = drive.observe()[0];
  assert.equal(o.attributable, true);
  assert.equal(o.advanced, true);
  assert.equal(o.from, 12345);
  assert.equal(o.to, 12349);
});

test("#1998 r2 P1-A without a batch size the drive attributes NOTHING (fail closed)", () => {
  const nodes = [controlledSeedNode(42, "increment")];
  const drive = driveControlHooksAcrossScopedBatch(nodes);
  queueBatch(nodes, { batchCount: 4, isPartialExecution: true });
  drive.restore();
  assert.equal(drive.observe()[0].attributable, false, "a lenient default is how this bug happened");
  assert.equal(drive.attributedWidgets().size, 0);
});

test("#1998 r2 P1-B overlapping drives must not resurrect a stale wrapper", () => {
  // BEFORE: d2's restore wrote d1's wrapper back onto the widget and left it LIVE, so a
  // later single scoped preview advanced despite isPartialExecution:true —
  //   queueBatch(..., isPartialExecution: true) -> 12345, 12346, 12347
  const nodes = [controlledSeedNode(42, "increment")];
  const d1 = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 2 });
  const d2 = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 2 });
  d1.restore();
  d2.restore();
  const seeds = queueBatch(nodes, { batchCount: 3, isPartialExecution: true });
  assert.deepEqual(seeds, [12345, 12345, 12345], "a scoped run must NOT advance once every drive is done");
});

test("#1998 r2 P1-B restoring out of order is safe in either direction", () => {
  for (const reverse of [false, true]) {
    const nodes = [controlledSeedNode(42, "increment")];
    const a = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 2 });
    const b = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 2 });
    const order = reverse ? [b, a] : [a, b];
    for (const d of order) d.restore();
    assert.deepEqual(
      queueBatch(nodes, { batchCount: 2, isPartialExecution: true }),
      [12345, 12345],
      `restore order ${reverse ? "b,a" : "a,b"}`,
    );
  }
});

test("#1998 r2 P1-B a third party wrapping on top of us is never clobbered", () => {
  const nodes = [controlledSeedNode(42, "increment")];
  const drive = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 2 });
  const control = nodes[0].widgets[1];
  // Someone else wraps AFTER us and expects to stay in the chain.
  let foreignSaw = 0;
  const ours = control.afterQueued;
  control.afterQueued = function (opts) {
    foreignSaw += 1;
    return ours.call(this, opts);
  };
  const theirs = control.afterQueued;
  drive.restore();
  assert.equal(control.afterQueued, theirs, "our restore must not remove their wrapper");
  queueBatch(nodes, { batchCount: 2, isPartialExecution: true });
  assert.ok(foreignSaw > 0, "and theirs must still run");
  assert.equal(
    nodes[0].widgets[0].value,
    12345,
    "while ours, being retired, no longer advances a scoped run",
  );
});

test("#1998 r2 the #988 scan is invariant to the drive having run — so filtering it AFTER dispatch is safe", () => {
  // The caller subtracts post-dispatch. That is only legitimate because this scan reads
  // control MODES and node identity, and the drive moves the GOVERNED value widget.
  const nodes = [controlledSeedNode(42, "increment"), ksampler(7, "randomize")];
  const before = findRepeatingControlWidgets(nodes);
  const drive = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 3 });
  queueBatch(nodes, { batchCount: 3, isPartialExecution: true });
  drive.restore();
  assert.deepEqual(findRepeatingControlWidgets(nodes), before, "same entries before and after");
});

test("#1998 r2 P1-A the passthrough is what ignores a foreign run — not merely the call count", () => {
  // ISOLATION. The attribution check alone was masking this: a foreign batch of a
  // DIFFERENT size already fails the count, so removing the "is this a partial execution"
  // passthrough changed nothing observable. Give the foreign run EXACTLY the size this
  // drive expects, and only the passthrough can still tell the two apart.
  const nodes = [controlledSeedNode(42, "increment")];
  const drive = driveControlHooksAcrossScopedBatch(nodes, { batchCount: 4 });
  const foreign = queueBatch(nodes, { batchCount: 4, isPartialExecution: false });
  drive.restore();
  const o = drive.observe()[0];
  assert.deepEqual(foreign, [12345, 12346, 12347, 12348], "the unscoped run advances on its own");
  assert.equal(o.attributable, false, "an unscoped queue is provably not the run we override");
  assert.equal(o.advanced, false);
  assert.equal(drive.attributedWidgets().size, 0, "and it may not silence #988's warning");
});
