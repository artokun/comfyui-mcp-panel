// #1260 — one node's restore must not abort the rest of the load.
//
// LiteGraph restores a serialized graph in passes: every node is CREATED
// first, then each node is configured in `nodes` order through the PROTOTYPE's
// `LGraphNode.prototype.configure`, and only afterwards are links and groups
// applied. A node whose configure THROWS — the reported case is Impact-Pack's
// FaceDetailer, whose widgets are built asynchronously by its JS extension, so
// the widget list is incomplete when the serialized values are applied —
// aborts that whole sequence: every later node stays at construction defaults
// (pos [10,10], default widgets), and links and groups are never applied. The
// load then reports a clean success over a graph that cannot queue.
//
// The throw belongs to ONE node, so it is contained to that node: while a
// panel-initiated load runs, `configure` is wrapped so a throw is RECORDED and
// the sequence continues — links, groups, and every other node restore
// normally. The caller retries the recorded nodes once after the load (the
// asynchronously-built widgets usually exist by then) and discloses any that
// still fail, instead of reporting a clean success.

function errorText(err) {
  if (err instanceof Error && err.message) return err.message;
  try {
    return String(err);
  } catch {
    return "an unprintable error";
  }
}

/**
 * Contain per-node `configure` throws for the duration of one load.
 *
 * Returns null when isolation is impossible (no LiteGraph / LGraphNode /
 * prototype configure) — the caller then loads exactly as before, with no
 * containment and nothing recorded, which is the pre-fix behaviour and never
 * worse than it.
 *
 * Otherwise returns `{ failures, restore }`. `failures` accumulates one entry
 * per throwing configure: `{ id, type, error, info }`, where `info` is the
 * serialized node data the retry pass needs and must NOT be serialized into a
 * tool result. `restore()` deactivates the wrapper and puts the original back
 * — but only when this wrapper is still the installed one: a second isolation
 * (or the frontend) may have chained on top, and restoring over that would
 * silently drop THEIR wrapper. A deactivated wrapper left in a chain is a
 * pass-through, so every restore order stays correct.
 *
 * The handle also reports `entered`: how many times the wrapper actually RAN
 * while active. Installed is not entered — a frontend whose nodes do not resolve
 * `configure` through `LGraphNode.prototype` leaves this at 0 while every field
 * above still reads like a clean load. It is a DIAGNOSTIC here and nothing gates
 * on it; `loadRestoreCompleted` explains why the graph-level count is the one
 * that licenses the verdict and this one must not.
 */
export function installNodeConfigureIsolation(LG) {
  const proto = LG?.LGraphNode?.prototype;
  if (!proto || typeof proto.configure !== "function") return null;
  const original = proto.configure;
  const failures = [];
  let active = true;
  let entered = 0;
  const wrapped = function (info) {
    if (!active) return original.call(this, info);
    entered += 1;
    try {
      return original.call(this, info);
    } catch (err) {
      failures.push({
        id: info?.id ?? this?.id ?? null,
        type: info?.type ?? this?.type ?? null,
        error: errorText(err),
        info: info ?? null,
      });
      return undefined;
    }
  };
  proto.configure = wrapped;
  return {
    failures,
    get entered() {
      return entered;
    },
    restore() {
      active = false;
      if (proto.configure === wrapped) proto.configure = original;
    },
  };
}

/**
 * One best-effort re-application of each node whose configure threw during the
 * load, AFTER the load has settled — a node whose widgets are built
 * asynchronously (the FaceDetailer shape) commonly configures cleanly by then.
 * Each retry is isolated too: a node that throws again is disclosed with the
 * NEW error, never retried further by this pass.
 *
 * A recorded failure whose node never landed on the graph (creation failed
 * too, not just configure) cannot be retried; it is disclosed with
 * `retry: "node-not-on-graph"` so the caller does not confuse "restore threw
 * again" with "there is nothing to restore onto".
 */
export function retryNodeRestores(graph, failures) {
  const restored = [];
  const failed = [];
  for (const failure of failures ?? []) {
    const node =
      failure?.id != null && typeof graph?.getNodeById === "function"
        ? graph.getNodeById(failure.id)
        : null;
    if (!node || !failure.info || typeof node.configure !== "function") {
      failed.push({
        id: failure?.id ?? null,
        type: failure?.type ?? null,
        error: failure?.error ?? "unknown",
        retry: "node-not-on-graph",
      });
      continue;
    }
    try {
      node.configure(failure.info);
      restored.push({ id: failure.id, type: failure.type });
    } catch (err) {
      failed.push({ id: failure.id, type: failure.type, error: errorText(err) });
    }
  }
  return { restored, failed };
}

/**
 * Did the graph restore RUN TO COMPLETION? (panel#1283 family)
 *
 * ## Why this observation has to exist
 *
 * `resolveOpenRebindVerdict` refuses to report an open applied whenever the graph
 * on the canvas is not byte-reproducible from the payload. Its reason, as that comment
 * read BEFORE this observation existed (it now points here instead):
 *
 *   "LiteGraph creates every node (with its id and type) and THEN configures each
 *    one, and `loadGraphData` catches a `configure()` failure and returns. A throw
 *    in that second pass leaves the complete node id/type set, the links, and the
 *    panel's marker over nodes that silently LOST their widget values and
 *    properties. That is byte-for-byte the same observation as 'the loader
 *    normalized the widget values', and no discriminator available to the panel
 *    separates them."
 *
 * MEASURED against the frontend source (`LGraph.prototype.configure`, the same
 * build #1260 was measured on): that account is exactly right, and it is
 * exhaustive. The node pass is
 *
 *     for (const [id, nodeData] of nodeDataMap) {
 *       const node = this.getNodeById(toNodeId(id))
 *       node?.configure(nodeData)          // <- no try/catch
 *     }
 *
 * with no try/catch anywhere between it and `loadGraphData`'s own. So the ONLY way
 * the feared partial load can present is a THROW — out of a node's `configure`, or
 * out of `LGraph.prototype.configure` itself (its later passes: floating links,
 * reroute validation, groups, execution order, proxy-widget migration).
 *
 * Both are observable. `installNodeConfigureIsolation` above already records the
 * first, for #1260. This records the second. Together they answer the question that
 * comment said could not be answered: **did any part of this restore abort?**
 *
 * ## Why the pair is exhaustive and the node wrap alone is not
 *
 * `installNodeConfigureIsolation` wraps `LGraphNode.prototype.configure`, and the
 * frontend's `ComfyNode.prototype.configure` runs BEFORE it and calls `super`. A
 * ComfyNode configure that throws before reaching super therefore never enters that
 * wrapper — it escapes the node loop instead, which aborts `LGraph.prototype.configure`
 * itself. That is the throw THIS wrap records. The same holds one level down: a
 * `Subgraph.configure` that throws before `super.configure` aborts the ROOT
 * `LGraph.configure` call that invoked it, which is wrapped.
 *
 * So every abort lands in exactly one of the two records: contained by the node
 * wrapper, or observed escaping into the graph one. Neither alone would be enough to
 * license anything.
 *
 * That is a POSITIVE observation, not a widened tolerance. It never says a
 * difference is benign; it says the load did not stop early, which is the one
 * hypothesis the refusal rests on.
 *
 * ## What it does NOT change
 *
 * Behaviour. The wrapper records the throw and RE-THROWS it, so every caller sees
 * precisely what it saw before — including `loadGraphData`'s own catch. An
 * observation that altered control flow would be measuring something other than
 * what production does.
 *
 * Returns null when the wrap is impossible (no LiteGraph / LGraph / prototype
 * configure). The caller must read null as UNKNOWN — never as "nothing threw" —
 * because a frontend this cannot instrument is exactly one whose restore it cannot
 * vouch for.
 *
 * ## INSTALLED is not ENTERED — why the handle counts `entered`
 *
 * Wrapping a prototype method proves the method exists. It does NOT prove the
 * restore went THROUGH it. On a frontend where the root graph stops resolving
 * `configure` via `LGraph.prototype` — an own-property `configure` on the graph
 * instance, or a subclass whose `configure` does not call `super` — the wrap
 * installs, is never entered, and `throws` stays empty for the whole load. An
 * empty `throws` then means either "nothing threw" or "nothing was watched", and
 * those are the two states this module exists to keep apart. A genuinely partial
 * load would be waved through as normalization, which is precisely the harm the
 * observation was added to prevent.
 *
 * So `entered` counts every call that reached the ACTIVE wrapper (a deactivated
 * one is a pass-through and counts nothing — an entry after `restore()` is not
 * evidence about the load). `entered === 0` means the question was never asked,
 * and `loadRestoreCompleted` folds it to UNKNOWN.
 */
export function installGraphConfigureWatch(LG) {
  const proto = LG?.LGraph?.prototype;
  if (!proto || typeof proto.configure !== "function") return null;
  const original = proto.configure;
  const throws = [];
  let active = true;
  let entered = 0;
  const wrapped = function (...args) {
    if (!active) return original.apply(this, args);
    // BEFORE the try. This counts ENTRY, not success: a call that throws was
    // still watched, and a counter incremented on the way out would read 0 for
    // exactly the aborted load this watch exists to see.
    entered += 1;
    try {
      return original.apply(this, args);
    } catch (err) {
      throws.push(errorText(err));
      // RE-THROWN. This is an observer, not an isolation: swallowing here would
      // change what `loadGraphData` sees and what the canvas ends up holding.
      throw err;
    }
  };
  proto.configure = wrapped;
  return {
    throws,
    get entered() {
      return entered;
    },
    restore() {
      active = false;
      // Only when this wrapper is still the installed one — the same rule
      // `installNodeConfigureIsolation` follows, so a nested install/restore in
      // either order never drops somebody else's wrapper.
      if (proto.configure === wrapped) proto.configure = original;
    },
  };
}

/**
 * Fold the two observations into ONE answer with THREE states.
 *
 * `true`  — the graph restore RAN THROUGH the watch and nothing threw: it ran to
 *           the end.
 * `false` — something threw. The partial-load hypothesis is LIVE for this load.
 * `null`  — the question was never asked. Either a wrap could not be installed, or
 *           it was installed on a method the restore never called. Unknown, and the
 *           caller must treat it as such: a load that could not be watched proves
 *           nothing about whether it completed.
 *
 * The null case is the point. Collapsing "nothing threw" and "nobody looked" into
 * one boolean is the exact defect this whole family is about, one level down.
 *
 * ## Why `graphWatch.entered` gates the verdict
 *
 * The first cut of this fold asked only whether both handles EXIST and neither
 * recorded anything. Existence is an answer about the prototype, not about the
 * load: install on a method nothing calls and both records stay empty, which is
 * byte-identical to a clean restore. That is the same two-states-one-answer fold
 * one level further down, and no test could see it, because a test that drives the
 * wrappers always enters them.
 *
 * An ABSENT or non-numeric count is unknown too, not a pass. A handle that cannot
 * say whether it ran has not established that it ran.
 *
 * ## Why `nodeIsolation.entered` does NOT, and must not
 *
 * Two reasons, and they point the same way.
 *
 * 1. Zero node configures is a LEGITIMATE completed restore — an empty workflow,
 *    or one whose nodes all failed to construct. Gating on it would answer UNKNOWN
 *    for loads that demonstrably ran to the end: a false negative manufactured by
 *    the guard, which is the fix being worse than the bug.
 * 2. It is not needed. The node wrapper is a CONTAINMENT, and the graph watch is
 *    the backstop underneath it: a node whose `configure` never routes through
 *    `LGraphNode.prototype` still throws INTO `LGraph.prototype.configure`'s node
 *    loop, which has no try/catch of its own — so the abort escapes into the graph
 *    watch and is recorded there. An unentered node wrapper loses containment for
 *    that node; it does not lose the OBSERVATION. An unentered graph watch loses
 *    the observation outright, which is why only that one may answer null.
 */
export function loadRestoreCompleted({ nodeIsolation, graphWatch } = {}) {
  if (!nodeIsolation || !graphWatch) return null;
  const nodeFailures = Array.isArray(nodeIsolation.failures) ? nodeIsolation.failures : null;
  const graphThrows = Array.isArray(graphWatch.throws) ? graphWatch.throws : null;
  if (!nodeFailures || !graphThrows) return null;
  // INSTALLED IS NOT ENTERED. An empty `throws` off a watch the restore never
  // reached is "nobody looked", and it must not read as "nothing threw".
  const graphEntered = graphWatch.entered;
  // `>= 1` and not `< 1`: NaN fails every comparison, so a `< 1` test would let it
  // through as "entered" — the same fold, hiding in an operator.
  if (typeof graphEntered !== "number" || !(graphEntered >= 1)) return null;
  return nodeFailures.length === 0 && graphThrows.length === 0;
}
