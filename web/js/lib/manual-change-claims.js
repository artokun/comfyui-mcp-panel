// #1498 — reconcile what the MANUAL CANVAS CHANGES block CLAIMED against the live
// graph, at the moment a graph read actually runs.
//
// ## The defect
//
// The turn-start block and a graph read are TWO READINGS TAKEN AT DIFFERENT
// MOMENTS. The block is built from one `rootGraph.serialize()` when the user's
// message is sent; `graph_outline` / `graph_query` walk the live nodes later, when
// the model gets round to calling them. Measured on the shipped frontend
// (1.49.6), a node's `widgets_values[i]` is exactly `widgets[i].value` at the
// instant of that serialize — so the two surfaces CANNOT disagree about a widget
// at the same moment. When they do disagree, the value changed in between: the
// user is sitting in ComfyUI and can keep editing (or a node's own callback can
// normalize the value back) while the model works.
//
// Nothing said so. The block asserted its state in the present tense and the
// orchestrator prompt calls it ground truth, so the reporter's session read a
// widget change the block announced, saw the very next live read report the OLD
// value, and filed it as two panel surfaces holding inconsistent state. Both
// readings were correct; only their as-of was missing, and the model had been
// told the older one wins.
//
// ## What this does
//
// The banner records the (node, widget, value) triples it ASSERTED. A later read
// re-checks just those triples against the live graph and, when one no longer
// holds, says so in-band with both values. The read is the newer observation, so
// it is the one that stands — the rider exists to make that ordering visible
// instead of leaving the model to adjudicate a contradiction it cannot date.
//
// Deliberately CONSERVATIVE — it must never invent a supersession:
//   • the node must still resolve, and carry EXACTLY ONE widget of that name.
//     A missing node or a repeated name (rgthree's `RGTHREE_TOGGLE_AND_NAV`
//     rows, panel#1402) cannot be compared without picking a row, and picking
//     one is how a wrong-target claim gets made.
//   • a widget the PANEL itself wrote this turn is dropped from the claim set by
//     the caller — the model changed it, so a difference there is its own edit
//     and reporting it as the user's would be a fabrication.
//   • the claims carry the workflow identity they were taken under; the caller
//     refuses to reconcile across a switch.
//
// Pure + side-effect-free so the whole decision is unit-testable without a DOM.

/** Rider cap. The block itself already shows at most 40 lines; a read only needs
 *  enough to establish THAT the canvas moved on and which widgets it moved. */
export const SUPERSEDED_CAP = 8;

/** Per-value display clip, matching the outline's own 60-char widget clip so a
 *  long prompt cannot make this rider the biggest thing in the reply. */
const VALUE_CLIP = 60;

function clipValue(v) {
  const s = String(typeof v === "string" ? v : (JSON.stringify(v) ?? "")).replace(/\s+/g, " ");
  return s.length > VALUE_CLIP ? s.slice(0, VALUE_CLIP - 3) + "…" : s;
}

/** Structural equality over the scalars a widget claim can carry. `JSON.stringify`
 *  because a claim's value came from a serialized snapshot and the live one comes
 *  off the widget: `1` and `1` compare equal, `"1"` and `1` do not, which is the
 *  distinction a combo/int disagreement turns on. */
function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The live value of the ONE widget named `name` on `node`, or `{ resolved:false }`
 * when there is no such widget or more than one carries the name.
 *
 * Reads `node.widgets` by NAME — the same key `summarizeNode` and the outline use
 * — so the comparison is against the value those readers would report, not against
 * a positional index the readers never consult.
 */
export function liveWidgetValue(node, name) {
  const rows = (node?.widgets ?? []).filter((w) => w && w.name === name);
  if (rows.length !== 1) return { resolved: false };
  return { resolved: true, value: rows[0].value };
}

/**
 * Which of `claims` the live graph no longer agrees with.
 *
 * @param {Array<{node_id: any, node_type?: string, widget: string, reported: any}>} claims
 * @param {(nodeId: any) => any} resolveNode live node for a claim's id, or null
 * @param {number} cap  maximum rows returned
 * @returns {{rows: Array, checked: number, differing: number}}
 *   `rows` is capped; `differing` is the true count so the note can say when it cut.
 */
export function reconcileWidgetClaims(claims, resolveNode, cap = SUPERSEDED_CAP) {
  const rows = [];
  let checked = 0;
  let differing = 0;
  for (const c of Array.isArray(claims) ? claims : []) {
    if (!c || typeof c.widget !== "string" || !c.widget) continue;
    let node = null;
    try {
      node = resolveNode(c.node_id);
    } catch {
      node = null;
    }
    // A node that no longer resolves is not evidence of a superseded VALUE — it was
    // removed, which the next turn's block reports as a removal in its own right.
    if (!node) continue;
    const live = liveWidgetValue(node, c.widget);
    if (!live.resolved) continue;
    checked += 1;
    if (sameValue(live.value, c.reported)) continue;
    differing += 1;
    if (rows.length >= cap) continue;
    rows.push({
      node_id: c.node_id,
      ...(c.node_type ? { node_type: c.node_type } : {}),
      widget: c.widget,
      reported: clipValue(c.reported),
      now: clipValue(live.value),
    });
  }
  return { rows, checked, differing };
}

/**
 * The in-band sentence that rides with the rows. States the ORDERING, because that
 * is the whole finding: the block is a turn-START reading and this read is newer,
 * so the read wins. Without that the two numbers are just a contradiction.
 */
export function supersededNote({ rows, differing } = {}) {
  const shown = Array.isArray(rows) ? rows.length : 0;
  if (!shown) return "";
  const cut =
    typeof differing === "number" && differing > shown
      ? ` (showing ${shown} of ${differing})`
      : "";
  return (
    `The "MANUAL CANVAS CHANGES" block at the start of this turn reported the value under ` +
    `\`reported\`; the canvas now holds \`now\`${cut}. That block is a reading taken when the ` +
    `user's message was sent — THIS read is newer, so \`now\` is what is on the canvas and what ` +
    `will execute. The user can keep editing while you work, and a node's own callback can ` +
    `normalize a value back, so a difference here is the canvas moving on, not a failed edit. ` +
    `Do not re-apply the reported value unless the user asks for it.`
  );
}
