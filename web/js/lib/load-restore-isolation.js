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
