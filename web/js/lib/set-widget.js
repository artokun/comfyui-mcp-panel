// The COMPLETE graph_set_widget handler body as a shared, driveable unit (#458).
//
// Extracted so the unit tests exercise the SAME ordering production runs — the
// test path IS the production path. The panel's GRAPH_TOOL_EXECUTORS.graph_set_widget
// only resolves the live graph/node/registry and delegates here; the tests call
// runSetWidget directly with fixtures. A future change that moved reconciliation
// above the preflight, or dropped the resolved-target guard, would therefore fail
// a test instead of silently regressing.
//
// Ordering contract (all three steps are load-bearing for #458):
//   1. preflightSetWidgetTarget — refuse a DIRECT placeholder/type-less node
//      BEFORE any mutation; a subgraph parent skips reconcile (its write targets
//      an inner node, guarded downstream).
//   2. reconcileUnknownWidgetNames — repair UNKNOWN widget names in place, ONLY
//      on a genuinely-resolved direct node (never a placeholder).
//   3. applyWidgetWrite with the resolved-target registry guard, which runs
//      BEFORE value coercion and any mutation/callback.

import { applyWidgetWrite, WidgetWriteError } from "./widget-write.js";
import { reconcileUnknownWidgetNames } from "./asset-staleness.js";
import { preflightSetWidgetTarget, assertResolvedTargetRegistered } from "./node-resolve.js";

export async function runSetWidget(
  node,
  widgetName,
  value,
  { registry = {}, resolveSource, canvas, beforeChange, afterChange, setDirty, refreshCombos } = {},
) {
  // (1) Preflight the OUTER node before ANY mutation; decide whether reconcile
  //     may run (never on a placeholder; skipped for subgraph parents).
  const { reconcile } = preflightSetWidgetTarget(registry, node);
  // (2) Repair positional UNKNOWN/UNKNOWN_n widget names against the live def so
  //     the caller's real widget name resolves (#199) — resolved direct node only.
  if (reconcile) reconcileUnknownWidgetNames(node);

  // (3) applyWidgetWrite owns the whole write: for a PARENT SubgraphNode it
  // resolves a PROMOTED widget to its ACTUAL inner (node, widget) and writes
  // THERE (#233); it validates the value against the target's declared type
  // (#240) and verifies the write stuck exactly. The injected assertTargetWritable
  // runs on the RESOLVED target BEFORE coercion/mutation, so a placeholder is
  // refused before any side effect (#458).
  const write = () =>
    applyWidgetWrite(node, widgetName, value, {
      resolveSource,
      canvas,
      beforeChange,
      afterChange,
      setDirty,
      assertTargetWritable: (targetNode) => assertResolvedTargetRegistered(registry, targetNode),
    });

  try {
    return { set: write() };
  } catch (err) {
    // STALE-COMBO RECOVERY (#338/#317/#299/#288/#284/#304): the ONLY retryable
    // failure is a COMBO value rejected against the widget's CURRENT option list
    // — a just-downloaded model / uploaded image / staged output / freshly
    // installed pack that the frontend combo snapshot doesn't list yet. When a
    // refresh source is injected, pull the AUTHORITATIVE option list from the
    // connected server (object_info + refreshComboInNodes, in place) and
    // revalidate EXACTLY ONCE. This keeps #240's strictness intact: the retry
    // validates against the FRESH list, so a genuinely-invalid value (still
    // absent after refresh) is rejected, and no other error class is retried.
    if (err instanceof WidgetWriteError && err.combo && typeof refreshCombos === "function") {
      try {
        await refreshCombos();
      } catch {
        /* refresh best-effort; fall through to re-raise the original rejection */
      }
      try {
        return { set: write(), refreshed: true };
      } catch (retryErr) {
        if (retryErr instanceof WidgetWriteError) {
          throw new Error(
            `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}) ` +
              `after refreshing combo options: ${retryErr.message}`,
          );
        }
        throw retryErr;
      }
    }
    if (err instanceof WidgetWriteError) {
      throw new Error(
        `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}): ${err.message}`,
      );
    }
    throw err;
  }
}
