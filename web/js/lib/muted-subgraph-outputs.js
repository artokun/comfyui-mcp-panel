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
 * Walk every graph level, depth-first, and return one entry per node that has at
 * least one disabled (muted/bypassed) subgraph wrapper among its ancestors.
 *
 * `exec_id` is the colon-joined chain of wrapper ids ending in the node's own id —
 * the same NodeExecutionId ComfyUI's flattened prompt uses as its key ("5:4:3"), and
 * the same shape run-to-node already targets.
 *
 * This deliberately does NOT filter to "output nodes": see the note at the leaf.
 * The caller intersects with the prompt that was actually submitted, and that is the
 * only thing entitled to decide what runs.
 *
 * Fully defensive: a malformed node, a subgraph cycle, or a missing `_nodes` array
 * yields fewer entries, never a throw — a diagnostic must not be able to take down
 * the run it is describing.
 */
export function collectDisabledAncestorOutputs(rootGraph) {
  const found = [];

  // Visited is PATH-LOCAL, not global (codex NO-SHIP: a global WeakSet is a
  // false negative in exactly this incident class). One subgraph DEFINITION can be
  // instanced more than once — wrapper A active and wrapper B muted, both pointing
  // at the same `S` — and a global set consumes `S` on the first visit, so every
  // offender under B disappears. ComfyUI's own traversal is path-local for the same
  // reason: each instance is expanded separately and gets its own execution-id path.
  // A path-local set still terminates a genuine CYCLE (a subgraph reachable from
  // itself), which is the only thing the guard needs to do, and it needs no
  // arbitrary depth cap — a cap would silently stop diagnosing a legal deep graph.
  const walk = (graph, path, disabledAncestors, seenOnPath) => {
    if (!graph || seenOnPath.has(graph)) return;
    const nextSeen = new Set(seenOnPath);
    nextSeen.add(graph);
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
          nextSeen,
        );
        continue;
      }
      if (!disabledAncestors.length) continue;
      // Only OUTPUT nodes (codex NO-SHIP round 2). Presence in the submitted prompt
      // is NOT execution: the backend picks execution ROOTS from output nodes and
      // then runs what those roots depend on, so an unconnected KSampler inside a
      // muted wrapper is serialized into the body and never runs. Reporting it as
      // "will run" would be exactly the kind of false claim this issue is about,
      // pointed the other way.
      //
      // The known limit, stated rather than hidden: this uses ComfyUI's own
      // `nodeData.output_node` convention, so a custom node the server treats as an
      // output while advertising it differently would be MISSED. That direction is
      // an under-report of a defect that is already happening, never a false alarm
      // about a healthy graph.
      if (!node?.constructor?.nodeData?.output_node) continue;
      // The NEAREST disabled ancestor is the one a reader acts on — the wrapper
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
    walk(rootGraph, [], [], new Set());
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
  // Says what HAPPENED, not what was prevented (codex NO-SHIP: the prompt is already
  // accepted by the time this is read, so any wording implying the panel stopped it
  // — or could have — is false). The remedy is therefore interruption, and the
  // scoped re-run, not a promise.
  return (
    `IN AN ACCEPTED PROMPT: ${n} OUTPUT node${n === 1 ? "" : "s"} inside a ${states.join("/")} ` +
    `subgraph ${n === 1 ? "is" : "are"} an execution root in a prompt the server accepted ` +
    `during this run's queue call — ${which}${more}. Read from the request body itself, not ` +
    `re-derived. Two things are deliberately NOT claimed: that this panel_run posted that ` +
    `prompt (a concurrent queue action from the UI or another extension goes through the ` +
    `same window, and there is no mark on an unscoped run to tell them apart), and that ` +
    `these nodes will finish — an accepted root can still be interrupted, fail, or be ` +
    `served from cache. What IS established is that they are roots rather than dependencies, ` +
    `so nothing else has to reference them for them to execute. On the build measured for ` +
    `this (ComfyUI 0.31.1 / frontend 1.48.7) a subgraph wrapper's mute/bypass is applied ` +
    `only at the TOP level of the workflow and a wrapper nested inside another subgraph is ` +
    `ignored; whether other builds differ has not been measured here. A whole-graph run ` +
    `hands prompt construction to ComfyUI, so the panel did not build this prompt and does ` +
    `not silently rewrite what you asked to run — it reports it. Check the queue now: ` +
    `interrupt if this is not what you intended, then render just the branch you want with ` +
    `panel_run's to_node_id, which scopes execution correctly.`
  );
}
