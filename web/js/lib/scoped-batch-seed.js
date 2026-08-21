/**
 * #988 — a SCOPED batch repeats the same seed, so every item after the first is
 * served from ComfyUI's cache and returns identical pixels.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7, by capturing the outgoing /prompt
 * bodies behind an interceptor that answered them locally (nothing queued):
 *
 *   app.queuePrompt(0, 3, undefined)   -> seeds 0, 275253667108059, 219005225600584
 *   app.queuePrompt(0, 3, ["<id>"])    -> seeds 0, 0, 0
 *
 * MEASURED IN BOTH WIDGET-CONTROL MODES, because ComfyUI can install the control's
 * mutation as either `beforeQueued` or `afterQueued` and only one had been observed
 * (codex). Flipping `Comfy.WidgetControlMode` and repeating the capture:
 *
 *   mode "after"  scoped [0,0,0]   unscoped [0, 1052866786709601, 413884900582428]
 *   mode "before" scoped [0,0,0]   unscoped [267357841888133, 145435791190359, 43867923644491]
 *
 * The scoped batch repeats in BOTH, so the warning does not need gating on the setting.
 * (The unscoped difference is the setting doing its job: "before" randomizes the first
 * item too, "after" sends the value you set and advances from there.)
 *
 * That is ComfyUI's OWN queue loop, called directly with no panel code in the path.
 * Passing the scope as the third argument stops it advancing `control_after_generate`
 * between batch items — a partial execution skips the queue-time widget hooks. The
 * panel is only the thing that passes that argument.
 *
 * It also explains why the reporter's own fix failed: looping with batch:1 separates
 * the dispatches in time, but the advance is not time-dependent. It never runs on this
 * path, so no amount of sequencing was going to trigger it.
 *
 * WHAT THIS MODULE DOES: detect the combination before dispatch and say so. It does not
 * rewrite seeds. Doing that would mean reimplementing the frontend's widget semantics
 * (`increment`/`decrement`/`randomize` differ, and each has a range), on the one path
 * where the panel already has to repair the request body — and this codebase has been
 * burned by re-deriving frontend behaviour before. It is computed BEFORE dispatch, so
 * it describes the state the prompts were built from — but the prompts ARE submitted by
 * the time anyone reads it, so the remedy it offers is interrupting the queue, not
 * preventing it.
 */

import { isControlAfterGenerateWidget } from "./control-after-generate.js";
import { upstreamClosure } from "./partial-run-prune.js";
import { buildNodeExecutionId } from "./subgraph-scope.js";

/**
 * Values of `control_after_generate` that mean "change this between runs".
 *
 * `increment-wrap` is here because ComfyUI ships it and it advances like the rest
 * (codex) — the report only names `randomize`, and warning on that alone would have
 * left a mode silently broken. `fixed` is the only standard non-advancing value, so it
 * is the only one that legitimately repeats.
 */
const ADVANCING = new Set(["randomize", "increment", "decrement", "increment-wrap"]);

/**
 * The value widget a control governs, resolved the way `findRepeatingControlWidgets`
 * resolves it — LINK first, adjacency as a labelled fallback.
 *
 * ONE resolver, two callers (the #988 warning and the #1998 drive), because they must
 * never disagree about which widget a control governs: the warning names it and the
 * drive OBSERVES it, so a divergence would report movement on one widget while
 * describing another. Returns `{ widget, source }`, or `{ widget: null, source: null }`
 * when neither signal identifies one — blaming the wrong value widget is worse than
 * naming none.
 *
 * The link points VALUE -> CONTROL, not the other way round: ComfyUI attaches the
 * control to the VALUE widget's `linkedWidgets`.
 */
function governedValueWidget(widgets, control, index) {
  const owner = widgets.find((cand) => {
    try {
      return Array.isArray(cand?.linkedWidgets) && cand.linkedWidgets.includes(control);
    } catch {
      return false;
    }
  });
  if (owner && typeof owner.name === "string") return { widget: owner, source: "linked" };
  const prev = index > 0 ? widgets[index - 1] : null;
  if (prev && typeof prev.name === "string") return { widget: prev, source: "adjacent" };
  return { widget: null, source: null };
}

/**
 * Widgets whose value an unscoped batch would have advanced between items, and which
 * a scoped batch will therefore repeat.
 *
 * Returns `[{ node_id, node_type, widget, mode, paired_widget }]` — `paired_widget` is
 * the value widget the control governs (conventionally the one immediately before it,
 * which is how ComfyUI pairs `seed` with `control_after_generate`), reported only when
 * it can be identified. Purely observational: nothing is written.
 *
 * Fully defensive — a malformed node or a throwing accessor reduces what is found,
 * never throws. A warning must not be able to take down the run it is about.
 */
export function findRepeatingControlWidgets(nodes, { skip = null } = {}) {
  const found = [];
  if (!Array.isArray(nodes)) return found;
  for (const node of nodes) {
    try {
      const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
      for (let i = 0; i < widgets.length; i++) {
        const w = widgets[i];
        const name = typeof w?.name === "string" ? w.name : null;
        if (name !== "control_after_generate") continue;
        // #1998 — a control the DRIVE armed is already accounted for by the drive's own
        // observation note, and warning "this batch WILL reuse it" beside that would be
        // the contradiction this option exists to prevent. Identity, not id: two nodes in
        // different subgraphs can share `node.id`, so matching on ids would silence the
        // wrong widget. Absent/empty skip ⇒ byte-identical to the shipped behaviour.
        if (skip && skip.has(w)) continue;
        const mode = typeof w.value === "string" ? w.value : null;
        // `fixed` is the one setting that WANTS the same value every time, so a scoped
        // batch repeating it is correct and must not be warned about.
        if (!mode || !ADVANCING.has(mode)) continue;
        // Prefer the widget's own LINKAGE when the frontend provides it (codex).
        // Adjacency is only a UI-insertion convention: custom nodes, promoted widgets
        // and widget-mutating extensions need not preserve it, and blaming the wrong
        // value widget is worse than naming none. Adjacency stays as a LABELLED
        // fallback — `paired_widget_source` says which was used, so a reader knows how
        // much to trust it.
        // The link points VALUE -> CONTROL, not the other way round (codex): ComfyUI
        // attaches the control to the VALUE widget's `linkedWidgets`. Reading it off
        // the control found nothing in the ordinary core case and fell through to
        // adjacency, so the authoritative signal was never actually being used.
        // ONE resolver, shared with the #1998 drive so the widget this warning NAMES is
        // the widget that drive OBSERVES (governedValueWidget, above).
        const paired = governedValueWidget(widgets, w, i);
        const pairedName = paired.widget ? paired.widget.name : null;
        const pairedSource = paired.source;
        found.push({
          node_id: node?.id != null ? String(node.id) : null,
          node_type: node?.type ?? null,
          widget: name,
          mode,
          ...(pairedName ? { paired_widget: pairedName, paired_widget_source: pairedSource } : {}),
        });
      }
    } catch {
      /* one unreadable node costs its own entry, never the whole diagnosis */
    }
  }
  return found;
}

/**
 * The disclosure. Empty unless this is genuinely the reported combination: a SCOPED
 * run, a batch of more than one, and at least one advancing control widget.
 */
export function scopedBatchSeedNote(controls, batchCount) {
  if (!Array.isArray(controls) || !controls.length) return "";
  if (!(Number(batchCount) > 1)) return "";
  const which = controls
    .slice(0, 5)
    .map((c) => `node ${c.node_id}${c.node_type ? ` (${c.node_type})` : ""} ${c.paired_widget ?? "value"}=${c.mode}`)
    .join("; ");
  const more = controls.length > 5 ? `, and ${controls.length - 5} more` : "";
  // CONDITIONAL, not absolute (codex). The scan walks every graph level, while a scoped
  // run executes only what feeds `to_node_id` — so a control on a branch this run never
  // reaches would otherwise be described as certainly repeating. The panel cannot
  // cheaply derive the executed set from here, so it says "the ones its scope reaches"
  // and admits it is listing all of them.
  return (
    `THIS BATCH WILL REUSE THE SAME ${controls.length === 1 ? "VALUE" : "VALUES"} for any of ` +
    `these controls its scope actually reaches: ${which}${more}. A run scoped with to_node_id ` +
    `is a PARTIAL execution, and ComfyUI does not advance control_after_generate between the ` +
    `items of one — measured on frontend 1.48.7 by comparing the submitted prompts, where an ` +
    `unscoped batch of 3 sent three different seeds and a scoped batch of 3 sent the same seed ` +
    `three times. A control that repeats can produce duplicate prompts, cache hits and repeated ` +
    `output files — though not necessarily: another extension's queue-time hook may still vary a ` +
    `prompt independently, so this says what WILL repeat, not that every later prompt is ` +
    `identical (#988). Every such control in ` +
    `the workflow is listed because the panel cannot tell from here which ones this scope ` +
    `reaches; one outside the executed branch is harmless. This is the frontend's queue ` +
    `behaviour, not something the panel chose, and the panel does not rewrite your values to ` +
    `work around it. The prompts are ALREADY QUEUED — interrupt them if this is not what you ` +
    `wanted. For different results: run batch_count:1 several times, setting the value ` +
    `yourself between runs, or drop to_node_id so the run is unscoped and ComfyUI advances it.`
  );
}

/**
 * #1339 — the same surprise, from a node this module could not see.
 *
 * A reporter ran `batch_count: 10` against a workflow whose seed comes from an rgthree
 * Seed node set to "Randomize Each Time", got ten identical images, and was told
 * `queued: true` with ten prompt ids and nothing else. The disclosure above could not
 * fire, because rgthree DELETES the widget it looks for:
 *
 *     // Grab the already available widgets, and remove the built-in control_after_generate
 *     } else if (w.name === "control_after_generate") { this.widgets.splice(i, 1); }
 *
 * A live `Seed (rgthree)` node carries `seed` plus three buttons and nothing else. So the
 * most widely used custom seed node was invisible to the one warning about repeated seeds.
 *
 * WHAT IT DOES *NOT* SAY, and this is the point. It does not claim an rgthree seed repeats
 * because the batch is scoped. MEASURED, driving rgthree's own handler three times on a
 * node armed with the sentinel:
 *
 *     posted seeds  1028465986822020, 98533269447704, 557498712106716   (all differ)
 *     widget after each call: -1 (still armed)
 *
 * …and a scoped batch of 3 was measured to call `api.queuePrompt` THREE times, so that
 * handler fires per item. rgthree substitutes in its own `api.queuePrompt` patch rather
 * than in the queue-time widget hooks a partial execution skips — so it is not subject to
 * the #988 mechanism at all. Extending the warning above to cover it would have been a
 * confident, checkable, WRONG sentence.
 *
 * What actually decides whether these ten renders differ is whether the node is ARMED:
 * rgthree only substitutes when the seed widget holds one of its sentinels. A concrete
 * number means every item of the batch uses that number — correct behaviour, and exactly
 * what identical outputs look like from the outside.
 */

/** rgthree's sentinels: -1 random, -2 increment, -3 decrement (`src_web/comfyui/seed.ts`). */
const RGTHREE_SPECIAL_SEEDS = new Map([
  [-1, "randomize"],
  [-2, "increment"],
  [-3, "decrement"],
]);

/** A node is one of rgthree's seed nodes if it says so and carries the seed widget. */
function isRgthreeSeedNode(node) {
  const type = typeof node?.type === "string" ? node.type : "";
  return /rgthree/i.test(type) && /seed/i.test(type);
}

/**
 * Can this node's random draw produce more than one value?
 *
 * Only meaningful for an ARMED node — a fixed seed does not draw at all. Unreadable
 * properties are treated as the DEFAULTS rgthree itself falls back to (`|| 0` and
 * `|| 1125899906842624` in `generateRandomSeed`), because that is what the node will
 * actually use, not as "unknown".
 */
function rgthreeRandomRange(node, seedWidget) {
  let min = 0;
  let max = 1125899906842624;
  let step = 1;
  try {
    const props = node?.properties ?? {};
    min = Number(props.randomMin || 0);
    max = Number(props.randomMax || 1125899906842624);
    step = Number(seedWidget?.options?.step) || 1;
  } catch {
    /* the defaults above are what rgthree would use anyway */
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) {
    return { varies: true, reason: null };
  }
  // THE STEP IS PART OF THE CONDITION, and `min >= max` alone missed it. rgthree draws:
  //
  //     const randomRange = (randomMax - randomMin) / (step / 10);
  //     let seed = Math.floor(Math.random() * randomRange) * (step / 10) + randomMin;
  //
  // so when `randomRange <= 1`, `Math.floor(Math.random() * randomRange)` is always 0 and
  // every draw returns `randomMin`. Measured: min=0, max=5, step=100 gives ONE distinct
  // value across 200 draws while min < max looks perfectly healthy. A range check that
  // ignores the step reports that node as varying, which is the silence this whole fix is
  // about.
  const range = (max - min) / (step / 10);
  if (!(range > 1)) {
    return {
      varies: false,
      reason:
        `its random range is randomMin=${min}, randomMax=${max}` +
        (step !== 1 ? ` at step ${step}` : "") +
        `, which admits a single value`,
    };
  }
  return { varies: true, reason: null };
}

/**
 * rgthree seed nodes in this graph, and whether each will vary across a batch.
 *
 * Returns `[{ node_id, node_type, seed, armed, mode }]` — `armed` is the whole answer:
 * true means rgthree swaps a fresh value into every submitted prompt, false means the
 * concrete number in the widget is used for every item.
 *
 * Defensive for the same reason as the scan above: a warning must not be able to take
 * down the run it is about.
 */
export function findRgthreeSeedNodes(nodes) {
  const found = [];
  if (!Array.isArray(nodes)) return found;
  for (const node of nodes) {
    try {
      if (!isRgthreeSeedNode(node)) continue;
      // MUTED / BYPASSED nodes are not participating, and rgthree's own handler returns
      // early for exactly these two modes:
      //
      //     if (this.mode === LiteGraph.NEVER || this.mode === 4) return;
      //
      // So it substitutes nothing, the node contributes nothing, and naming it would point
      // the user at a node that is not in the run — noise in a warning whose whole value is
      // naming the right one. (LiteGraph: 2 = NEVER/mute, 4 = bypass.)
      if (node?.mode === 2 || node?.mode === 4) continue;
      const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
      const seedWidget = widgets.find((w) => w?.name === "seed");
      if (!seedWidget) continue;
      // NO LINK GUARD HERE, and that is deliberate — I added one and it was wrong.
      //
      // For an ordinary node, a seed converted to an input makes the widget value stale.
      // Not for this one: rgthree's queue handler OVERWRITES the outgoing seed from its own
      // widget regardless of any link —
      //
      //     const seedToUse = this.getSeedToUse();               // reads seedWidget.value
      //     outputInputs[this.seedWidget.name || "seed"] = seedToUse;
      //
      // (`src_web/comfyui/seed.ts`, the `comfy-api-queue-prompt-before` handler.) So the
      // widget IS what gets submitted, and declining on a link suppressed the warning for a
      // linked node whose widget holds a fixed number — a MISSED warning, which is the
      // original bug rather than a new false claim (codex).
      const raw = Number(seedWidget.value);
      if (!Number.isFinite(raw)) continue;
      const mode = RGTHREE_SPECIAL_SEEDS.get(raw) ?? null;
      // ARMED IS NOT THE SAME AS VARYING (codex P2). rgthree's random range is a pair of
      // node PROPERTIES the user can edit:
      //
      //     const randomMin = Number(this.properties["randomMin"] || 0);
      //     const randomMax = Number(this.properties["randomMax"] || 1125899906842624);
      //     const randomRange = (randomMax - randomMin) / (step / 10);
      //     let seed = Math.floor(Math.random() * randomRange) * (step / 10) + randomMin;
      //     if (SPECIAL_SEEDS.includes(seed)) seed = 0;
      //
      // A range that admits one value — min >= max — makes every "random" draw the same
      // number, and a degenerate range landing on a sentinel is coerced to 0. So an armed
      // node with randomMin === randomMax submits the SAME seed every item while looking
      // armed. Silence there would recreate the exact surprise this warning exists for.
      const range = rgthreeRandomRange(node, seedWidget);
      const varies = mode !== null && range.varies;
      found.push({
        node_id: node?.id != null ? String(node.id) : null,
        node_type: node?.type ?? null,
        seed: raw,
        armed: mode !== null,
        varies,
        ...(mode ? { mode } : {}),
        ...(mode !== null && !range.varies ? { degenerate_range: range.reason } : {}),
      });
    } catch {
      /* one unreadable node costs its own entry, never the whole diagnosis */
    }
  }
  return found;
}

/**
 * Node types whose queue-time prompt rewrite has actually been MEASURED — the
 * capability claim behind the #1124 drift exclusion, stated as data.
 *
 * EXACT registered type, not a substring test, and the set holds exactly what has
 * been verified. `Seed (rgthree)` is the type on the live instance this repo's
 * fixtures were taken from; nothing else has been observed rewriting the prompt in
 * an `api.queuePrompt` patch, so nothing else is listed. Adding a type here is a
 * claim that THAT node substitutes at queue time — it must be measured first, not
 * guessed from a plausible-looking name.
 */
const RGTHREE_QUEUE_REWRITING_SEED_TYPES = new Set(["Seed (rgthree)"]);

/**
 * #1124 — the input rgthree will REWRITE in the outgoing prompt, or null when it
 * rewrites nothing. Returns the input NAME so the caller can build a per-node
 * exclusion pair; the drift guard (run-scope-guard.js) is the only consumer.
 *
 * WHY IT LIVES IN THIS MODULE rather than in the guard. Almost everything it needs
 * is already measured and written down HERE — the sentinel set, the mute/bypass
 * early-return, and the quoted handler line that says WHICH input gets overwritten.
 * Restating any of that next to the guard would create a second copy of a measured
 * fact about someone else's pack, and the two would drift the first time rgthree
 * changed. The guard imports; nothing is duplicated. (The node-type match is the
 * one thing this function does NOT share with the #1339 scan — see below.)
 *
 * WHAT IT IS FOR. The #556 drift guard stamps the graph before dispatch and
 * compares that stamp against the POSTED body. Its only volatility signal was
 * `typeof w.beforeQueued === "function"` — and rgthree does not use that hook at
 * all. It SPLICES OUT the `control_after_generate` widget the frontend would have
 * hung the hook on (see the #1339 block above) and substitutes the seed inside its
 * own `api.queuePrompt` patch instead, after our stamp and before the fetch. So the
 * stamp recorded `-1`, the body carried a fresh random, and every scoped run on a
 * workflow containing an armed Seed (rgthree) was refused as "the workflow graph
 * CHANGED" with `47 seed` named as the differing entry — permanently, because the
 * widget stays armed at `-1` and each retry draws a different number (#1124).
 *
 * ARMED IS THE GATE, AND `varies` IS DELIBERATELY NOT.
 * `findRgthreeSeedNodes` reports `varies: false` for an armed node whose
 * randomMin/randomMax admit a single value — the right answer for the #1339
 * warning, and the WRONG one here. Such a node still SUBSTITUTES: it replaces the
 * `-1` sentinel in the body with that single value (or with 0, when the degenerate
 * draw lands on a sentinel). The input therefore still changes between the two
 * serializations, so it is still volatile. Keying this on `varies` would have left
 * exactly the degenerate-range workflows refused, which is the bug.
 *
 * A NON-ARMED NODE EXCLUDES NOTHING, mirroring the `value === "fixed"` gate the
 * stock control_after_generate carrier already uses in collectVolatileInputs. A
 * concrete seed is submitted verbatim (`getSeedToUse` returns `inputSeed` when it
 * is not a sentinel), so the input does not mutate at queue time and MUST stay
 * drift-covered — a mid-window user edit to a fixed seed is real drift and is still
 * refused. Same for a MUTED or BYPASSED node: rgthree's handler returns early for
 * both, so it substitutes nothing.
 *
 * IT DOES NOT SHARE `isRgthreeSeedNode` WITH THE #1339 WARNING, and that is a
 * deliberate split rather than an oversight (codex r1 P2). That predicate is two
 * substring tests — `/rgthree/i && /seed/i` — so a foreign custom node whose type
 * happens to contain both words, carrying a `seed` widget holding -1/-2/-3, would
 * have had its seed dropped from BOTH hashes despite installing no queue-time
 * rewrite at all. A real deferred edit to that node would then sail past the #556
 * guard. The two callers want OPPOSITE failure directions, so one predicate cannot
 * serve both:
 *
 *   #1339 (warning)      a false positive is NOISE — one extra sentence about a
 *                        node that may not repeat. A false NEGATIVE is the bug
 *                        that issue was filed for (a missed warning), so a loose,
 *                        generous match is the right trade there and is left
 *                        exactly as it was.
 *   #1124 (drift guard)  a false positive SILENTLY REMOVES drift coverage for the
 *                        life of every scoped run on that graph. Fail-closed is
 *                        the only acceptable direction, so the match is an exact
 *                        registered type from a measured set.
 *
 * Tightening the shared predicate would have traded a real #1339 regression (a
 * genuinely-rgthree seed node with a variant type going unwarned) for a cosmetic
 * saving of one constant. So the warning heuristic stays; the exclusion is strict.
 *
 * Defensive like the rest of this module: an unreadable node yields null (no
 * exclusion), which fails TOWARD detecting drift.
 */
export function rgthreeQueueTimeSeedInput(node) {
  try {
    if (!RGTHREE_QUEUE_REWRITING_SEED_TYPES.has(node?.type)) return null;
    // rgthree: `if (this.mode === LiteGraph.NEVER || this.mode === 4) return;`
    if (node?.mode === 2 || node?.mode === 4) return null;
    const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
    const seedWidget = widgets.find((w) => w?.name === "seed");
    if (!seedWidget) return null;
    const raw = Number(seedWidget.value);
    if (!Number.isFinite(raw)) return null;
    // Only a sentinel makes `getSeedToUse()` draw a NEW number; anything else is
    // returned unchanged and lands in the body exactly as the stamp saw it.
    if (!RGTHREE_SPECIAL_SEEDS.has(raw)) return null;
    // The handler writes `outputInputs[this.seedWidget.name || "seed"]`, and the
    // widget was found BY that name, so the rewritten input is this one.
    return seedWidget.name;
  } catch {
    return null;
  }
}

/**
 * The scanned nodes that WILL submit the same seed for every item of a batch.
 *
 * THE PROSE AND THE STRUCTURED FIELD MUST BE ONE PREDICATE, and they were two.
 * `rgthreeFixedSeedNote` selected on `varies === false`, while the caller that
 * attaches `fixed_seed_nodes` to the run result selected on `armed === false` —
 * and those disagree on exactly the case the #1339 warning exists for. An ARMED
 * node whose randomMin/randomMax (or step) admit a single value is `armed: true,
 * varies: false`, so it was NAMED in the sentence and MISSING from the array.
 * Because the caller only attaches the field when the note is non-empty, that is
 * not a hypothetical: a run against an armed-but-degenerate node returned
 * `fixed_seed_note` saying "ALL 10 ITEMS OF THIS BATCH WILL USE THE SAME SEED
 * from node 649" next to `fixed_seed_nodes: []`.
 *
 * A caller branching on the ARRAY — which is the one a program should read, and the
 * one #1339's own diagnostic loop asks a reporter to check — therefore concluded
 * nothing was wrong, in the single case the shipped fix describes as the confusing
 * one ("you did press the button and it still repeats"). Reading the sentence
 * instead is not a fix: prose is evidence for a human, never a field to branch on.
 *
 * `varies === false` is the correct predicate, so it lives here once and both
 * consumers call it. `armed` stays ON each entry (with `degenerate_range` beside it)
 * so a reader can still tell the two ways a seed repeats apart — what is removed is
 * the ability for the two answers to disagree.
 *
 * NOT SHARED WITH `rgthreeQueueTimeSeedInput` (#1124), deliberately: that one gates
 * on `armed` because a degenerate-range node still SUBSTITUTES and so is still
 * volatile for the drift hash. Same nodes, opposite question — see its own note.
 */
export function repeatingRgthreeSeeds(seeds) {
  if (!Array.isArray(seeds)) return [];
  // `varies === false` covers BOTH ways an rgthree seed repeats: a concrete number in the
  // widget, and an armed node whose random range admits one value. Keying on `armed`
  // alone missed the second (codex P2) — and an armed-but-degenerate node is the more
  // confusing of the two, because the user did press the button.
  return seeds.filter((s) => s && s.varies === false);
}

/**
 * The disclosure for a batch whose rgthree seed is FIXED.
 *
 * Silent when the node is armed, because then it genuinely varies per item and there is
 * nothing to warn about — saying something anyway would be the noise that trains people to
 * ignore the useful case. Silent for a batch of one, where "every item uses this seed" is
 * not a surprise.
 *
 * Unlike the scoped-batch note, this does NOT depend on the run being scoped: a fixed seed
 * repeats in an unscoped batch too.
 */
export function rgthreeFixedSeedNote(seeds, batchCount) {
  if (!Array.isArray(seeds) || !(Number(batchCount) > 1)) return "";
  const repeating = repeatingRgthreeSeeds(seeds);
  if (!repeating.length) return "";
  const which = repeating
    .slice(0, 5)
    .map((s) => {
      const where = `node ${s.node_id}${s.node_type ? ` (${s.node_type})` : ""}`;
      return s.armed
        ? `${where} is armed to ${s.mode}, but ${s.degenerate_range}`
        : `${where} seed=${s.seed}`;
    })
    .join("; ");
  const more = repeating.length > 5 ? `, and ${repeating.length - 5} more` : "";
  const anyFixed = repeating.some((s) => !s.armed);
  const anyDegenerate = repeating.some((s) => s.armed);
  return (
    `ALL ${batchCount} ITEMS OF THIS BATCH WILL USE THE SAME SEED from ${which}${more}. ` +
    (anyFixed
      ? `An rgthree Seed node only produces a new value per item while it is ARMED — its ` +
        `seed widget holding -1 (randomize), -2 (increment) or -3 (decrement) — and a ` +
        `concrete number is submitted verbatim every time. `
      : "") +
    (anyDegenerate
      ? `An armed node still repeats when its randomMin/randomMax properties admit a ` +
        `single value, which is why pressing the button did not help. `
      : "") +
    `That is the node behaving as configured, not a fault: identical seeds mean identical ` +
    `prompts, which ComfyUI can answer from cache, so the renders can come back ` +
    `pixel-identical (#1339). ` +
    (anyFixed ? `Press "🎲 Randomize Each Time" on the node to arm it` : "") +
    (anyFixed && anyDegenerate ? `, and widen ` : anyDegenerate ? `Widen ` : "") +
    (anyDegenerate ? `randomMin/randomMax in its node properties` : "") +
    `. This is reported, not repaired — the panel does not rewrite your seeds.`
  );
}

/**
 * #1998 - DRIVE ComfyUI's own control hooks across the items of a SCOPED batch.
 *
 * THE MECHANISM, read out of the pinned frontend's own source (comfyui_frontend_package
 * ships sourcemaps with sourcesContent, so this is the real TypeScript, not a guess).
 * ComfyUI runs its batch loop INSIDE one `app.queuePrompt(number, batchCount, scope)`
 * call and fires the queue-time widget hooks once per item (src/scripts/app.ts):
 *
 *     const isPartialExecution = !!queueNodeIds?.length
 *     for (let i = 0; i < batchCount; i++) {
 *       forEachNode(this.rootGraph, (node) => {
 *         for (const widget of node.widgets ?? []) widget.beforeQueued?.({ isPartialExecution })
 *         applyPromotedWidgetControl(node, 'beforeQueued', { isPartialExecution })
 *       })
 *       const p = await this.graphToPrompt(this.rootGraph)          // the body that is POSTed
 *       const res = await api.queuePrompt(number, p, { partialExecutionTargets: queueNodeIds })
 *       executeWidgetsCallback(queuedNodes, 'afterQueued', { isPartialExecution })
 *     }
 *
 * ...and src/scripts/valueControl.ts refuses to advance anything when that flag is set:
 *
 *     export function nextValueForLinkedTarget(params) {
 *       if (params.isPartialExecution) return undefined
 *
 * That refusal is deliberate upstream behaviour - ComfyUI_frontend PR #8774, "disable
 * control after generate during partial execution", merged 2026-02-11, so that queueing
 * selected output nodes while iterating does not churn the user's seed.
 *
 * MEASURED on ComfyUI 0.33.2 / frontend 1.49.6 by capturing the outgoing /prompt bodies
 * behind an interceptor that answered them locally - nothing queued, no GPU time:
 *
 *     unscoped  queuePrompt(0, 4, undefined)   randomize -> 4 distinct seeds
 *     unscoped  queuePrompt(0, 4, undefined)   increment -> 12345, 12346, 12347, 12348
 *     scoped    queuePrompt(0, 4, ["9"])       randomize -> 12345, 12345, 12345, 12345
 *     scoped    queuePrompt(0, 4, ["9"])       increment -> 12345, 12345, 12345, 12345
 *     scoped    4x queuePrompt(0, 1, ["9"])    randomize -> 12345, 12345, 12345, 12345
 *
 * THE LAST LINE IS THE ONE THAT DECIDES THE FIX. "Do what the Queue button does, N
 * times" does NOT work here: the refusal is keyed on the scope, not on the batch
 * position, so separating the dispatches changes nothing. (That is also why the #988
 * reporter's own loop-with-batch:1 patch failed after 114 green tests.) The only thing
 * that can make the value vary is the flag itself.
 *
 * SO WE PASS THE FLAG, AND NOTHING ELSE. This wraps each control widget's OWN
 * `beforeQueued`/`afterQueued` so they receive `isPartialExecution: false`, and the
 * frontend then does every remaining thing: `computeNextControlledValue` picks the next
 * value for randomize / increment / decrement / increment-wrap, honours min/max/step and
 * a combo's filter list, and - the case that breaks a naive fix - returns `undefined`
 * for `fixed`, so a fixed control still submits N identical prompts. There is no seed
 * arithmetic in this module and no mode table: `fixed` is protected by ComfyUI's own
 * `if (mode === 'fixed') return undefined`, not by a panel branch.
 *
 * SCOPE OF THE OVERRIDE. The caller installs this ONLY for a scoped run with
 * `batch_count > 1` - the one case where upstream's refusal turns "give me N renders"
 * into N byte-identical prompts that ComfyUI answers from cache while the tool reports N
 * successes. A scoped run of ONE is left exactly as #8774 made it.
 *
 * WHAT IT CANNOT REACH, stated so the note can never over-claim. `app.queuePrompt` also
 * calls `applyPromotedWidgetControl(node, phase, { isPartialExecution })` directly for a
 * subgraph host's PROMOTED widgets - a module function, not a widget property, so there
 * is nothing here to wrap and those still repeat. So do controls whose governed input is
 * fed by a LINK, which the frontend skips on every path. Neither is guessed at:
 * `observe()` reports what each governed widget ACTUALLY did across the batch, and
 * `scopedBatchDriveNote` warns about every advancing control that did not move.
 *
 * Returns `{ armed, restore, observe }`. Fully defensive, like the rest of this module:
 * an unreadable node costs its own entry, never the run.
 */

export function driveControlHooksAcrossScopedBatch(nodes, { batchCount = null } = {}) {
  // EXPECTED INVOCATIONS. ComfyUI fires beforeQueued and afterQueued once each per batch
  // item, so a drive that owns the whole batch sees exactly `2 * batchCount` calls. Any
  // other number means something we did not dispatch also ran through these hooks (or a
  // rejected item cut the loop short), and `observe()` then refuses to claim anything —
  // see the attribution note there. Absent batchCount attributes NOTHING, deliberately:
  // a lenient default is how the previous version came to believe another run's work.
  const expected = Number.isFinite(batchCount) && batchCount > 0 ? 2 * batchCount : null;
  const armed = [];
  const armedWidgets = new Set();
  const restores = [];
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      try {
        const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
        for (let i = 0; i < widgets.length; i++) {
          const w = widgets[i];
          // DETECTED BY OPTION SHAPE, not by name (control-after-generate.js): a node def
          // may name its control widget anything, and a name test silently drops those.
          // BOTH hooks must be present - that is the frontend's own `isValueControlWidget`
          // test, and it keeps this away from third-party `beforeQueued` hooks which are
          // not controls and never asked for our flag.
          if (!isControlAfterGenerateWidget(w)) continue;
          if (typeof w.beforeQueued !== "function") continue;
          if (typeof w.afterQueued !== "function") continue;
          const paired = governedValueWidget(widgets, w, i);
          const target = paired.widget ?? null;
          const entry = {
            node_id: node?.id != null ? String(node.id) : null,
            node_type: node?.type ?? null,
            control: typeof w.name === "string" ? w.name : null,
            mode: typeof w.value === "string" ? w.value : null,
            ...(target ? { governed: target.name, governed_source: paired.source } : {}),
          };
          const seen = [];
          const record = () => {
            if (!target) return;
            try {
              seen.push(target.value);
            } catch {
              /* an unreadable value costs one sample, never the run */
            }
          };
          const before = w.beforeQueued;
          const after = w.afterQueued;
          // Sample the governed value on BOTH sides of every hook call, so `observe()`
          // reports the value this run actually carried rather than the change we asked
          // for. The FIRST sample is the value the first prompt was built from.
          const forced = (orig) =>
            function (opts) {
              // NOT OUR RUN — forward it untouched and record nothing (gate r2 P1-A).
              //
              // Two cases, and both used to be swallowed. A retired wrapper is one this
              // drive has already stood down from; and an invocation whose incoming flag is
              // not `true` is not a partial execution at all, so it is provably not the run
              // this override exists for — an unscoped queue that happened to land inside
              // our window. EXECUTED against this module before the fix: an unrelated
              // unscoped batch of 3 during an armed drive produced
              // `observed: true, advanced: true, from 12345 to 12348` for a scoped batch
              // that had not run a single item.
              if (state.retired || opts?.isPartialExecution !== true) return orig.call(this, opts);
              // COUNTED PER CALL, not per sample: `record()` fires on both sides of the
              // original, so counting samples would have meant "4 per item" while the
              // attribution check said 2. Counting the invocation itself is what the
              // expectation below is actually about.
              state.calls += 1;
              record();
              try {
                return orig.call(this, { ...opts, isPartialExecution: false });
              } finally {
                record();
              }
            };
          const state = { retired: false, calls: 0 };
          const wrappedBefore = forced(before);
          const wrappedAfter = forced(after);
          w.beforeQueued = wrappedBefore;
          w.afterQueued = wrappedAfter;
          armedWidgets.add(w);
          restores.push(() => {
            // RETIRE, NEVER CLOBBER — and this pair of lines is the whole of gate r2 P1-B.
            //
            // Overlapping drives each captured whatever was installed when THEY armed, so
            // the second's restore wrote the FIRST's wrapper back onto the widget and left
            // it there, live. EXECUTED against this module before the fix:
            //
            //   d1 = drive(nodes); d2 = drive(nodes); d1.restore(); d2.restore();
            //   queueBatch(nodes, { batchCount: 3, isPartialExecution: true })
            //     -> 12345, 12346, 12347     a SCOPED run advancing: #8774 broken for good
            //
            // Retiring FIRST and unconditionally makes this wrapper transparent however it
            // is later reached, so a copy left installed by someone else's restore is inert
            // rather than live. Unhooking only when OURS is still what is installed stops us
            // clobbering a third party who wrapped on top of us between arming and now.
            // Together they make nesting SAFE instead of forbidden — no exclusivity latch,
            // and therefore no way for one missed restore to disable the feature for the
            // life of the page. (The same rule run-scope-guard.js learned for its fetch
            // guards: a superseded guard is retired, never unhooked.) After the fix the
            // sequence above yields 12345, 12345, 12345.
            state.retired = true;
            if (w.beforeQueued === wrappedBefore) w.beforeQueued = before;
            if (w.afterQueued === wrappedAfter) w.afterQueued = after;
          });
          armed.push({ entry, seen, widget: w, state });
        }
      } catch {
        /* one unreadable node costs its own entry, never the whole dispatch */
      }
    }
  }
  // ONE predicate. `observe()` and `attributedWidgets()` answer the same question - "are
  // these samples this drive's own?" - and two copies of it is two chances to disagree
  // about whether a control may be subtracted from #988's warning.
  const isAttributable = (a) => expected != null && a.state?.calls === expected;
  return {
    armed: armed.map((a) => ({ ...a.entry })),
    /**
     * The armed widgets whose samples this drive can PROVE are its own — the only ones
     * the caller may subtract from #988's scan (gate r2 P1-A). An armed but unattributed
     * control keeps its repetition warning, because we do not know what it did.
     */
    attributedWidgets() {
      const out = new Set();
      for (const a of armed) if (isAttributable(a)) out.add(a.widget);
      return out;
    },
    /**
     * The control widget OBJECTS this drive wrapped — the exact set #988's scan must
     * skip, so a control the drive could not reach keeps its repetition warning
     * (#1998 gate P1-2). Identity rather than ids: `node.id` is not unique across
     * subgraphs, and silencing the wrong widget is the failure being fixed.
     */
    armedWidgets,
    /**
     * Put every hook back. Called from the caller's `finally`, so the override lasts
     * exactly the dispatch - a control left wrapped would keep advancing on the user's
     * own single scoped previews, which is the behaviour #8774 exists to prevent.
     * Idempotent: the first call drains the list, so a second restores nothing.
     */
    restore() {
      for (const r of restores.splice(0).reverse()) {
        try {
          r();
        } catch {
          /* a widget that vanished with its graph needs no restoring */
        }
      }
    },
    /**
     * What each governed widget ACTUALLY did across the batch — and only when this drive
     * can PROVE the samples are its own (gate r2 P1-A).
     *
     * ATTRIBUTION IS CHECKED, NOT ASSUMED. `2 * batchCount` invocations is exactly what
     * owning the whole batch looks like; any other count means either something we did not
     * dispatch ran through these hooks, or a rejected item cut ComfyUI's loop short. In
     * both cases this reports `attributable: false` and claims NOTHING — no advancement,
     * no repetition verdict — and the caller then leaves #988's warning in place for that
     * control. Saying "I cannot tell" is the whole point: the previous version said
     * "advanced" on another run's work.
     */
    observe() {
      return armed.map((entryRef) => {
        const { entry, seen } = entryRef;
        const attributable = isAttributable(entryRef);
        if (!attributable) {
          return { ...entry, attributable: false, observed: false, distinct_values: 0, advanced: false };
        }
        const keys = seen.map((v) =>
          typeof v === "object" && v !== null ? JSON.stringify(v) : `${typeof v}:${String(v)}`,
        );
        const distinct = new Set(keys).size;
        return {
          ...entry,
          attributable: true,
          observed: seen.length > 0,
          distinct_values: distinct,
          advanced: distinct > 1,
          ...(seen.length ? { from: seen[0], to: seen[seen.length - 1] } : {}),
        };
      });
    },
  };
}

/**
 * The disclosure for a scoped batch the panel DROVE (#1998).
 *
 * REPLACES `scopedBatchSeedNote` on that path rather than sitting beside it: that note
 * says the batch WILL reuse the same values, which is exactly what this drive stops
 * being true, and shipping both would put two contradictory sentences in one result.
 *
 * Silent for a batch of one, and silent when no advancing control was armed - a graph
 * carrying nothing but `fixed` controls has no surprise to report, and saying something
 * anyway is the noise that trains people to skip the useful case.
 */
export function scopedBatchDriveNote(observations, batchCount) {
  if (!Array.isArray(observations) || !(Number(batchCount) > 1)) return "";
  // An UNATTRIBUTED control is described by neither half of this note: we do not know what
  // it did, so we neither announce an advance nor warn about a repeat. #988's warning keeps
  // it instead, because the caller does not subtract it from that scan (gate r2 P1-A).
  const advancingMode = observations.filter(
    (o) => o && ADVANCING.has(o.mode) && o.attributable !== false,
  );
  if (!advancingMode.length) return "";
  const moved = advancingMode.filter((o) => o.advanced);
  const stuck = advancingMode.filter((o) => !o.advanced);
  const describe = (o) =>
    `node ${o.node_id}${o.node_type ? ` (${o.node_type})` : ""} ${o.governed ?? o.control}=${o.mode}`;
  const list = (xs) => {
    const head = xs.slice(0, 5).map(describe).join("; ");
    return xs.length > 5 ? `${head}, and ${xs.length - 5} more` : head;
  };
  const parts = [];
  if (moved.length) {
    parts.push(
      `A run scoped with to_node_id is a PARTIAL execution, and ComfyUI does not advance ` +
        `control_after_generate between the items of one (ComfyUI_frontend #8774) - so a scoped ` +
        `batch would otherwise submit ${batchCount} byte-identical prompts and answer all but the ` +
        `first from cache, returning the SAME output file for every one. For this batch the panel ` +
        `ran ComfyUI's OWN control hooks once per item with the partial-execution flag cleared, ` +
        `and these advanced exactly as they would on an unscoped run: ${list(moved)}. The values ` +
        `are ComfyUI's: the panel does not compute seeds, it only passes the flag, so ` +
        `increment/decrement/increment-wrap and a combo's filter list behave as they do on the ` +
        `Queue button, and a control set to fixed still repeats on purpose (#1998).`,
    );
  }
  if (stuck.length) {
    parts.push(
      `${moved.length ? "" : `This scoped batch was driven with ComfyUI's own control hooks (#1998), but `}` +
        `these advancing controls did NOT move across the batch, so anything depending on them is ` +
        `identical for every item and can come back as a cache hit on the first output: ` +
        `${list(stuck)}. OBSERVED, not inferred - the panel read each governed widget on both ` +
        `sides of every hook call. The usual causes are a governed input fed by a LINK (ComfyUI ` +
        `skips the control on every path when the value comes from the link rather than the ` +
        `widget) and a widget PROMOTED to a subgraph host, which ComfyUI drives through ` +
        `applyPromotedWidgetControl - a module function rather than a widget property, so the ` +
        `cleared flag never reaches it. Set those values yourself between runs, or run the ` +
        `branch unscoped.`,
    );
  }
  return parts.join(" ");
}

/**
 * #1998 (gate P1-1) — the nodes a PARTIAL execution actually runs, or null when that
 * cannot be established.
 *
 * WHY THIS EXISTS. The drive was armed over `collectAllGraphs(rootGraph)` — every node
 * in the workflow. MEASURED on the rig with a two-branch graph (KSampler 3 -> SaveImage
 * 9, KSampler 13 -> SaveImage 19, both `increment`), running
 * `graph_run { batch_count: 4, to_node_id: 9 }`:
 *
 *     partial_execution_targets   ["9"] on all four posts
 *     node 3  (in scope)  seed widget 707000 -> 707004
 *     node 13 (OFF scope) seed widget 808000 -> 808004      <-- never executed
 *
 * Node 13 is not in the run. Advancing it silently rewrites a branch the user did not
 * run, and the drive then REPORTED it as `advanced: true`. That is a wrong-target
 * mutation of someone's workflow, and it is worse than the cache-hit this whole change
 * exists to fix, because the cache-hit was visible in the outputs and this is not. It
 * also inverts the justification for overriding ComfyUI_frontend #8774 in the first
 * place: that the user asked for N distinct renders OF THE SCOPE THEY NAMED.
 *
 * ONE CLOSURE, NOT A SECOND OPINION. The backward walk that decides what a run-to-node
 * executes already lives in `partial-run-prune.js` (#1511) and is what the #1871
 * pre-flight narrows on. This imports that verdict rather than restating it — two
 * answers to one question is two chances to disagree, and here disagreement means
 * either mutating an off-scope node or failing to advance an in-scope one.
 *
 * IT WORKS ON THE PROMPT MAP, so the caller must hand over the SAME serialization the
 * pre-flight already produced. Building a fresh one here would be a second compilation
 * of a graph that may have moved, and `graphToPrompt` is not read-only (#985).
 *
 * FAIL-CLOSED, DELIBERATELY. Null is returned — and the caller then arms NOTHING —
 * whenever the scope cannot be proven: no prompt map, roots that are not keys of it, or
 * a node whose execution id cannot be built (a stale/ghost subgraph). Arming nothing
 * degrades to ComfyUI's shipped behaviour (the batch repeats) AND leaves #988's warning
 * standing, so the caller is told the truth. Arming everything is the defect above.
 *
 * KNOWN LIMIT, stated rather than papered over: a node that carries a control but has no
 * entry in the prompt map — a frontend-only `PrimitiveNode` feeding a seed, a Reroute —
 * is not in the closure and is therefore NOT armed. Its control keeps #988's repetition
 * warning instead, which is the honest outcome; extending the closure to virtual nodes
 * would mean a second link-walk over litegraph, which is exactly the duplicate verdict
 * this function refuses to create.
 */
export function nodesInPartialExecutionScope(rootGraph, promptResult, targetIds) {
  try {
    if (!rootGraph) return null;
    const map =
      promptResult?.output && typeof promptResult.output === "object" ? promptResult.output : promptResult;
    const closure = upstreamClosure(map, targetIds);
    if (!closure) return null;
    const out = [];
    const seen = new Set();
    const stack = [rootGraph];
    while (stack.length) {
      const graph = stack.pop();
      if (!graph || seen.has(graph)) continue;
      seen.add(graph);
      for (const node of graph._nodes ?? []) {
        if (!node) continue;
        if (node.subgraph) stack.push(node.subgraph);
        if (node.id == null) continue;
        // The colon path ComfyUI itself keys a flattened prompt by, so `closure` (which
        // holds prompt keys) and this are the same namespace. A node that cannot be
        // placed makes the whole answer unprovable — see FAIL-CLOSED above.
        const execId = buildNodeExecutionId(rootGraph, graph, node.id);
        if (execId == null) return null;
        if (closure.has(execId)) out.push(node);
      }
    }
    return out;
  } catch {
    return null;
  }
}
