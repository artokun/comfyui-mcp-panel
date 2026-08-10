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
export function findRepeatingControlWidgets(nodes) {
  const found = [];
  if (!Array.isArray(nodes)) return found;
  for (const node of nodes) {
    try {
      const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
      for (let i = 0; i < widgets.length; i++) {
        const w = widgets[i];
        const name = typeof w?.name === "string" ? w.name : null;
        if (name !== "control_after_generate") continue;
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
        let pairedName = null;
        let pairedSource = null;
        const owner = widgets.find((cand) => {
          try {
            return Array.isArray(cand?.linkedWidgets) && cand.linkedWidgets.includes(w);
          } catch {
            return false;
          }
        });
        const ownerName = typeof owner?.name === "string" ? owner.name : null;
        if (ownerName) {
          pairedName = ownerName;
          pairedSource = "linked";
        } else {
          const prev = i > 0 ? widgets[i - 1] : null;
          const adjacent = typeof prev?.name === "string" ? prev.name : null;
          if (adjacent) {
            pairedName = adjacent;
            pairedSource = "adjacent";
          }
        }
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
