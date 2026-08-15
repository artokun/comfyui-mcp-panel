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
 * WHY THIS READS THE GRAPH AND NOT A PROMPT (codex rounds 2-5, four rejected designs):
 *
 * The obvious version intersects "output under a disabled ancestor" with the prompt
 * that was actually queued, so a build which excludes them correctly stays silent.
 * Every way of getting that prompt failed:
 *   - a second `app.graphToPrompt()` compiles a DIFFERENT prompt from the one sent,
 *     and is not read-only (it runs virtual-node applyToGraph and every widget's
 *     serializeValue);
 *   - reading the outgoing POST body fixes that, but an UNSCOPED run carries no queue
 *     mark, so a concurrent post from the UI or another extension is indistinguishable
 *     from this run's. A foreign workflow whose keys collide (`5:4:3` is not rare)
 *     would then be reported as containing THIS graph's muted outputs — a false
 *     statement about someone else's prompt, which no `ownership: "unknown"` field
 *     repairs.
 *
 * So the claim is made about the thing that CAN be established: the live graph. The
 * cost is honest and stated in the note — on a build that fixes nested wrapper modes
 * this warns about a run that was fine. That direction over-warns; the alternative
 * asserts something false. This issue exists because a wrong quiet answer cost the
 * reporter 18 minutes, so the bias goes toward saying too much.
 *
 * `disabledOutputsInPrompt` remains exported: it is how the browser measurement above
 * was taken, and how anyone re-measuring on another build should check it.
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
 * `exec_id` is the colon-joined chain of wrapper ids ending in the node's own id —
 * the same NodeExecutionId ComfyUI's flattened prompt uses as its key ("5:4:3"), and
 * the same shape run-to-node already targets.
 *
 * Filtered to OUTPUT nodes — the execution roots. See the note at the leaf.
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
          // `depth` is this wrapper's INDEX IN THE PATH, recorded because node ids are
          // graph-LOCAL and therefore not unique across levels (codex: root wrapper 7
          // containing muted wrapper 7 gives path "7:7:9", and comparing bare ids
          // mistook the inner one for the top-level wrapper and suppressed a real
          // offender). Position is unambiguous where an id is not.
          name
            ? [...disabledAncestors, { id: String(node.id), mode: node.mode, state: name, depth: path.length }]
            : disabledAncestors,
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
      // A disabled TOP-LEVEL wrapper is honoured — measured, and it is the ordinary
      // way people switch a branch off. Warning about it would fire on healthy
      // everyday workflows, which is how a warning gets ignored. When the wrapper at
      // path position 0 is the disabled one, ComfyUI has already excluded everything
      // below it and there is nothing to report.
      //
      // Tested by DEPTH, never by id: ids are graph-local, so an inner wrapper can
      // legitimately share an id with the root-level one and a bare comparison would
      // suppress a genuine offender (codex).
      //
      // This is the one place upstream's behaviour is encoded rather than observed,
      // and it is encoded in the SUPPRESSING direction: if a future build stops
      // honouring the top level too, this under-reports rather than cries wolf.
      if (disabledAncestors.some((a) => a.depth === 0)) continue;
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
 * Of the outputs with a disabled ancestor, the ones present in a compiled prompt.
 *
 * Kept because it is the exact predicate the browser measurement used, and it is how
 * anyone re-measuring this on another build should check it: compile a prompt for the
 * graph and intersect. It is deliberately NOT wired into `panel_run` — see the module
 * header for why no prompt available at run time can be attributed safely.
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
    `This workflow has ${n} OUTPUT node${n === 1 ? "" : "s"} inside a NESTED ${states.join("/")} ` +
      `subgraph — ${which}${more}. On the build measured for this ` +
      `(ComfyUI 0.31.1 / frontend 1.48.7) a subgraph wrapper’s mute/bypass is applied only at the ` +
      `TOP level of a workflow: a wrapper nested inside another subgraph is IGNORED, so outputs ` +
      `under one render anyway. That is what #985 reports — one active source subgraph and two ` +
      `muted, all three rendered, 18m44s.` +
      ` This is read from the GRAPH, not from the prompt that was queued, and it says so because ` +
      `the difference matters: on a build that applies nested wrapper modes correctly, this ` +
      `warns about a run that was fine. It is deliberately biased that way — a whole-graph run ` +
      `hands prompt construction to ComfyUI, the panel neither builds nor rewrites it, and a ` +
      `wrong QUIET answer is what made this expensive. Verify against your own build by ` +
      `compiling a prompt and checking whether these ids are in it.` +
      ` Check the queue: interrupt if this is not what you intended, then render just the branch ` +
      `you want with panel_run’s to_node_id, which scopes execution correctly.`
  );
}
