/**
 * #636 (the "minor" item) — two readers disagreed about a widget value with nothing
 * in either payload to explain it.
 *
 * `panel_get_subgraph(173)` reported inner node 166 `value: "MiniMax_H3"` while
 * `panel_query_graph(ids:[173])` reported the parent instance `value: "MM3"`. Both
 * were correct and they describe different things:
 *
 *   • the inner nodes belong to the subgraph DEFINITION, and their widget values are
 *     the values stored in that definition;
 *   • the parent subgraph NODE carries the promoted widgets, whose values are this
 *     instance's — and an instance override is exactly how a reusable subgraph is
 *     meant to be parameterized.
 *
 * With no provenance on either side the difference reads as stale data, which is the
 * costly failure: an agent "fixes" a value that was never wrong, or re-reads in a
 * loop looking for the two to agree. They never will, and they should not.
 *
 * So `graph_get_subgraph` now carries the parent instance's promoted widget values
 * ALONGSIDE the definition's, and says which is which. One call, both facts, no
 * inference.
 *
 * NO GUESS ABOUT WHICH INNER WIDGET A PROMOTION FEEDS. The promotion mapping is not
 * reliably recoverable from the live objects across frontend versions, and a wrong
 * pairing would state a false override relationship — worse than the ambiguity being
 * fixed. Names are reported as they are; the caller compares them.
 */

/** Widget name → value for a node, skipping anything unnamed. Values are copied out
 *  by reference only (they are already plain widget values); no clipping happens here
 *  because the caller's existing summary caps already govern payload size. */
function widgetValues(node) {
  const out = {};
  for (const w of node?.widgets ?? []) {
    if (w && typeof w.name === "string" && w.name) out[w.name] = w.value;
  }
  return out;
}

/**
 * The instance-vs-definition provenance block for a `graph_get_subgraph` reply.
 *
 * @param {object} node the PARENT subgraph node (the instance)
 * @returns {{instance_widgets?: object, values_note?: string}}
 *   Empty when the instance promotes no widgets — there is then nothing that could
 *   diverge, and a note would be noise on every subgraph that has no parameters.
 */
export function subgraphValueProvenance(node) {
  const instance = widgetValues(node);
  if (!Object.keys(instance).length) return {};
  return {
    instance_widgets: instance,
    values_note:
      `The widget values on the inner nodes below belong to the subgraph DEFINITION. ` +
      `\`instance_widgets\` above are this instance's PROMOTED widget values (node ` +
      `${node?.id}), which is what the graph actually runs with where a promotion exists. ` +
      `A difference between the two is an intentional per-instance override, NOT stale ` +
      `data — do not "correct" it. panel_query_graph on this node reports the same ` +
      `instance values.`,
  };
}
