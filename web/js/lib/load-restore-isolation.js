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
 */
export function installNodeConfigureIsolation(LG) {
  const proto = LG?.LGraphNode?.prototype;
  if (!proto || typeof proto.configure !== "function") return null;
  const original = proto.configure;
  const failures = [];
  let active = true;
  const wrapped = function (info) {
    if (!active) return original.call(this, info);
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
 * on the canvas is not byte-reproducible from the payload, and states its reason:
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
 * first, for #1260. This records the second. Together they answer the question the
 * comment says cannot be answered: **did any part of this restore abort?**
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
 */
export function installGraphConfigureWatch(LG) {
  const proto = LG?.LGraph?.prototype;
  if (!proto || typeof proto.configure !== "function") return null;
  const original = proto.configure;
  const throws = [];
  let active = true;
  const wrapped = function (...args) {
    if (!active) return original.apply(this, args);
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
 * `true`  — every wrap was installed AND nothing threw: the restore ran to the end.
 * `false` — something threw. The partial-load hypothesis is LIVE for this load.
 * `null`  — at least one wrap could not be installed, so the question was never
 *           asked. Unknown, and the caller must treat it as such: a load that
 *           could not be watched proves nothing about whether it completed.
 *
 * The null case is the point. Collapsing "nothing threw" and "nobody looked" into
 * one boolean is the exact defect this whole family is about, one level down.
 */
export function loadRestoreCompleted({ nodeIsolation, graphWatch } = {}) {
  if (!nodeIsolation || !graphWatch) return null;
  const nodeFailures = Array.isArray(nodeIsolation.failures) ? nodeIsolation.failures : null;
  const graphThrows = Array.isArray(graphWatch.throws) ? graphWatch.throws : null;
  if (!nodeFailures || !graphThrows) return null;
  return nodeFailures.length === 0 && graphThrows.length === 0;
}
