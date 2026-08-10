/**
 * #985 — output nodes that ComfyUI queues even though an ancestor subgraph wrapper
 * is muted or bypassed.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7 (the reporter's exact versions), with
 * a two-level nesting whose innermost subgraph holds a PreviewImage:
 *
 *   root-level wrapper MUTE(2)     -> nested output correctly EXCLUDED from the prompt
 *   nested wrapper     MUTE(2)     -> nested output still IN the prompt
 *   nested wrapper     BYPASS(4)   -> nested output still IN the prompt
 *
 * So only the ROOT-level wrapper's mode reaches prompt construction; a wrapper one
 * level down is ignored. The reporter paid 18m44s of GPU time for that: one active
 * source subgraph and two muted ones, and all three rendered.
 *
 * A whole-graph `panel_run` hands prompt construction to ComfyUI's own
 * `app.queuePrompt`, so the panel does not build this prompt and cannot quietly fix
 * it. What it CAN do is stop being silent about it — which is the actual reported
 * harm, since the run reported success while doing something no one asked for.
 *
 * The check is a MEASUREMENT, never a reimplementation of ComfyUI's rules: it names
 * the outputs that have a disabled ancestor AND are present in the compiled prompt.
 * If a future frontend excludes them properly, the intersection is empty and the
 * panel says nothing — no version sniffing, and nothing to un-teach later.
 */

/** LiteGraph node modes that mean "do not execute this node". */
export const MODE_MUTE = 2; // LiteGraph.NEVER
export const MODE_BYPASS = 4;

/** Human name for a disabled mode; null when the mode runs normally. */
export function disabledModeName(mode) {
  if (mode === MODE_MUTE) return "muted";
  if (mode === MODE_BYPASS) return "bypassed";
  return null;
}

/**
 * Walk every graph level, depth-first, and return one entry per OUTPUT node that has
 * at least one disabled (muted/bypassed) subgraph wrapper among its ancestors.
 *
 * `execId` is the colon-joined chain of wrapper ids ending in the node's own id —
 * the same NodeExecutionId ComfyUI's flattened prompt uses as its key ("5:4:3"), and
 * the same shape run-to-node already targets.
 *
 * `isOutputNode` is injected so this stays pure and testable; the caller passes the
 * panel's existing output-node predicate rather than a second copy of that rule.
 *
 * Fully defensive: a malformed node, a subgraph cycle, or a missing `_nodes` array
 * yields fewer entries, never a throw — a diagnostic must not be able to take down
 * the run it is describing. Depth is bounded for the same reason.
 */
export function collectDisabledAncestorOutputs(rootGraph, isOutputNode, { maxDepth = 32 } = {}) {
  const found = [];
  if (typeof isOutputNode !== "function") return found;
  const seen = new WeakSet();

  const walk = (graph, path, disabledAncestors, depth) => {
    if (!graph || depth > maxDepth) return;
    if (typeof graph === "object") {
      if (seen.has(graph)) return; // a subgraph cycle must not spin
      seen.add(graph);
    }
    const nodes = Array.isArray(graph._nodes) ? graph._nodes : Array.isArray(graph.nodes) ? graph.nodes : [];
    for (const node of nodes) {
      if (!node || node.id == null) continue;
      const nodePath = [...path, String(node.id)];
      const sub = node.subgraph;
      if (sub) {
        // A wrapper. Its own mode joins the ancestor chain for everything inside.
        const name = disabledModeName(node.mode);
        walk(
          sub,
          nodePath,
          name ? [...disabledAncestors, { id: String(node.id), mode: node.mode, state: name }] : disabledAncestors,
          depth + 1,
        );
        continue;
      }
      if (!disabledAncestors.length) continue;
      let isOutput = false;
      try {
        isOutput = !!isOutputNode(node);
      } catch {
        isOutput = false; // an unjudgeable node is not reported as a finding
      }
      if (!isOutput) continue;
      // The NEAREST disabled ancestor is the one a reader acts on — it is the wrapper
      // whose switch they flipped.
      const nearest = disabledAncestors[disabledAncestors.length - 1];
      found.push({
        exec_id: nodePath.join(":"),
        node_id: String(node.id),
        type: node.type ?? null,
        disabled_ancestor: nearest.id,
        disabled_ancestor_state: nearest.state,
        disabled_ancestor_depth: disabledAncestors.length,
      });
    }
  };

  try {
    walk(rootGraph, [], [], 0);
  } catch {
    /* partial findings beat none; never throw out of a diagnostic */
  }
  return found;
}

/**
 * Of the outputs with a disabled ancestor, the ones ComfyUI actually put in the
 * compiled prompt — i.e. the ones that really are about to run.
 *
 * This intersection is the whole point: it reports the DEFECT, not the rule. An
 * output correctly excluded by prompt construction never appears here, so a frontend
 * that honours nested wrapper modes silences this automatically.
 */
export function disabledOutputsInPrompt(promptOutput, disabledOutputs) {
  if (!promptOutput || typeof promptOutput !== "object" || !Array.isArray(disabledOutputs)) return [];
  const keys = new Set(Object.keys(promptOutput));
  return disabledOutputs.filter((o) => o && keys.has(String(o.exec_id)));
}

/**
 * The sentence the agent acts on. States what will happen, that the panel is not the
 * one deciding it, and the one thing that does work — the reporter verified that
 * targeting the nested output directly isolates the branch correctly.
 */
export function disabledOutputsNote(offenders) {
  if (!Array.isArray(offenders) || offenders.length === 0) return "";
  const n = offenders.length;
  const states = [...new Set(offenders.map((o) => o.disabled_ancestor_state))].sort();
  const which = offenders
    .slice(0, 5)
    .map((o) => `${o.exec_id}${o.type ? ` (${o.type})` : ""} under ${o.disabled_ancestor_state} subgraph ${o.disabled_ancestor}`)
    .join("; ");
  const more = n > 5 ? `; and ${n - 5} more` : "";
  return (
    `WILL RUN ANYWAY: ${n} output node${n === 1 ? "" : "s"} ${n === 1 ? "sits" : "sit"} inside a ` +
    `${states.join("/")} subgraph, and ComfyUI queued ${n === 1 ? "it" : "them"} regardless — ` +
    `${which}${more}. ComfyUI's prompt construction only applies a subgraph wrapper's ` +
    `mute/bypass at the TOP level of the workflow; a wrapper nested inside another ` +
    `subgraph is ignored. A whole-graph run hands prompt construction to ComfyUI, so the ` +
    `panel cannot exclude these without changing what you asked to run — it reports them ` +
    `instead. To render only the branch you want, run to that branch's output node ` +
    `(panel_run with to_node_id), which scopes execution correctly. Interrupt now if this ` +
    `is not what you intended.`
  );
}
