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
 * burned by re-deriving frontend behaviour before. Naming the problem at queue time
 * lets the caller cancel instead of discovering it from identical outputs.
 */

/** Values of `control_after_generate` that mean "change this between runs". */
const ADVANCING = new Set(["randomize", "increment", "decrement"]);

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
        // ComfyUI places the control immediately AFTER the value it governs. Reported
        // only when that neighbour exists — a guess about which widget is affected
        // would be worse than saying nothing about it.
        const prev = i > 0 ? widgets[i - 1] : null;
        const pairedName = typeof prev?.name === "string" ? prev.name : null;
        found.push({
          node_id: node?.id != null ? String(node.id) : null,
          node_type: node?.type ?? null,
          widget: name,
          mode,
          ...(pairedName ? { paired_widget: pairedName } : {}),
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
  return (
    `EVERY ITEM OF THIS BATCH WILL USE THE SAME ${controls.length === 1 ? "VALUE" : "VALUES"}: ` +
    `${which}${more}. A run scoped with to_node_id is a PARTIAL execution, and ComfyUI does ` +
    `not advance control_after_generate between the items of one — measured on frontend ` +
    `1.48.7 by comparing the submitted prompts, where an unscoped batch of 3 sent three ` +
    `different seeds and a scoped batch of 3 sent the same seed three times. So items after ` +
    `the first are identical prompts, which ComfyUI answers from cache in a fraction of a ` +
    `second with the same output file (#988). This is the frontend's queue behaviour, not ` +
    `something the panel chose, and the panel does not rewrite your seeds to work around it. ` +
    `To get different results: run batch_count:1 several times setting the value yourself ` +
    `between runs, or drop to_node_id so the run is unscoped and ComfyUI advances it for you.`
  );
}
