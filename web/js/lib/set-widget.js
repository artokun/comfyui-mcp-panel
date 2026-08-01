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

import {
  applyWidgetWrite,
  WidgetWriteError,
  resolvePromotedInnerTarget,
  followPromotionToConcrete,
} from "./widget-write.js";
import { reconcileUnknownWidgetNames } from "./asset-staleness.js";
import {
  preflightSetWidgetTarget,
  assertResolvedTargetRegistered,
  assertTypeAgainstFreshBackend,
} from "./node-resolve.js";
import { controlAfterGenerateWarning } from "./control-after-generate.js";

export async function runSetWidget(
  node,
  widgetName,
  value,
  {
    registry = {},
    getRegistry,
    getFreshObjectInfo,
    resolveSource,
    canvas,
    beforeChange,
    afterChange,
    setDirty,
    refreshCombos,
  } = {},
) {
  const liveRegistry = () => (typeof getRegistry === "function" ? getRegistry() : registry);

  // (0) FRESH-BACKEND TYPE AUTHORIZATION (#458 set_widget gap, found in review of
  //     #375). graph_add_node authorizes its class_type against the CURRENT backend
  //     /object_info; graph_set_widget must do the SAME for the type of the node the
  //     write ACTUALLY MUTATES, because the LiteGraph registry KEEPS A STALE POSITIVE
  //     for an uninstalled pack when the browser tab was never reloaded after a
  //     ComfyUI restart. Without this, a since-removed type ("GoneNode") sails through
  //     the registry-only guard and the write reports a fabricated SUCCESS against a
  //     backend that no longer defines it.
  //
  //     The fresh /object_info oracle is REQUIRED, never optional: authorizing from
  //     the stale registry when it is absent would REOPEN exactly this false-success
  //     hole (a stale-positive GoneNode would be written and reported as success). So
  //     a missing oracle FAILS CLOSED here, matching graph_add_node's fail-closed
  //     contract — the panel always wires it (getFreshObjectInfo below).
  if (typeof getFreshObjectInfo !== "function") {
    throw new Error(
      `Cannot set widget on node ${node?.id}${typeof node?.type === "string" ? ` ("${node.type}")` : ""}: ` +
        `cannot verify the node type against the ComfyUI backend — no /object_info oracle is wired. ` +
        `Refusing to write from a possibly-stale node registry (#458).`,
    );
  }

  //     Fetch the CURRENT /object_info ONCE and resolve any promoted target ONCE —
  //     the SAME resolution is threaded into applyWidgetWrite, so authorization and
  //     the write hit the IDENTICAL target and no relink during the await can swap an
  //     authorized live node for a stale GoneNode (no TOCTOU). The resolved-target
  //     type is then authorized BEFORE preflight/reconcile/coercion so a removed/
  //     unverifiable type is refused before a single side effect:
  //       * DIRECT node → its own type.
  //       * PROMOTED subgraph widget (positively resolved) → the ULTIMATE CONCRETE
  //         backend node's type, following the promotion chain through any NESTED
  //         SubgraphNodes (A → B → KSampler). A virtual subgraph-id type is absent
  //         from /object_info, so authorizing an INTERMEDIATE virtual node would
  //         wrongly refuse a valid nested write — the chain is TRAVERSED to the
  //         concrete node, and only that concrete type is authorized (still fail
  //         closed if it is genuinely removed).
  //       * A truthy `subgraph` field with NO promoted match is NOT a real promoted
  //         write — it writes the node's OWN widget, so it must fresh-authorize its
  //         OWN type exactly like a direct node. A stale/removed type must never be
  //         exempted just because it carries a `subgraph` field (#458 subgraph-shaped
  //         bypass): otherwise a removed GoneNode with `subgraph:{}` + its own widget
  //         would skip fresh-auth and the stale registry guard would fabricate success.
  let freshDefs = null;
  try {
    freshDefs = await getFreshObjectInfo();
  } catch {
    freshDefs = null;
  }

  // Resolve the promoted inner target ONCE (PURE — no coercion/mutation). Threaded
  // into applyWidgetWrite so the write never re-resolves to a different node.
  const promotedResolution = node?.subgraph
    ? resolvePromotedInnerTarget(node, widgetName, resolveSource)
    : null;
  const isResolvedPromotion = !!(
    promotedResolution &&
    promotedResolution.promoted &&
    promotedResolution.target
  );
  // The node whose widget the write will actually mutate: the IMMEDIATE resolved inner
  // node for a positively-resolved promoted write, else the node itself (direct write,
  // OR a subgraph-shaped node with no promoted match writing its own widget). Threaded
  // into applyWidgetWrite so the write never re-resolves.
  const resolvedTargetNode = isResolvedPromotion ? promotedResolution.target.node : node;
  const promotedButUnresolvable = !!(promotedResolution && promotedResolution.promoted && !promotedResolution.target);
  // The node whose TYPE to fresh-authorize. For a promoted write, follow the promotion
  // chain through any NESTED SubgraphNodes to the ULTIMATE CONCRETE backend node and
  // authorize THAT type (a virtual intermediate subgraph type is never in /object_info
  // and must be traversed, not authorized). A promoted-but-UNRESOLVABLE write has no
  // reachable target and fails closed as a WidgetWriteError downstream.
  let authTarget;
  // For the stale-combo retry: the widget being MUTATED (on the immediate write target)
  // and the ULTIMATE CONCRETE widget name whose /object_info options are authoritative.
  // Nested promotions can RENAME the widget at each level (#366), so the mutated widget's
  // name may differ from the concrete def's input name — this map bridges them (#458).
  const writeTargetWidgetName = isResolvedPromotion ? promotedResolution.target.widget?.name : undefined;
  let concreteWidgetName;
  if (promotedButUnresolvable) {
    authTarget = null;
  } else if (isResolvedPromotion) {
    const concrete = followPromotionToConcrete(promotedResolution.target, resolveSource);
    if (concrete.node && !concrete.node.subgraph && typeof concrete.node.type === "string") {
      // Reached a genuine concrete backend node WITH a real type string — authorize it.
      // (assertTypeAgainstFreshBackend below then always runs for a promoted write.)
      authTarget = concrete.node;
      concreteWidgetName = concrete.widget?.name;
    } else {
      // The chain did NOT reach a verifiable concrete backend node: an unresolvable/
      // stale deeper link ({node:null}), a terminal virtual own-widget, a cycle, OR a
      // terminal node with NO string type. We cannot authorize such a target against
      // /object_info, and the reused resolution would let the write mutate the IMMEDIATE
      // virtual node behind only the registry guard (which trusts defless virtual
      // subgraph nodes). FAIL CLOSED before any mutation — never treat a virtual/
      // unresolved/typeless target as a verified concrete node (#458).
      throw new Error(
        `Cannot set widget on node ${node?.id} (promoted "${widgetName}"): the promotion ` +
          `chain could not be resolved to a concrete backend node the ComfyUI backend ` +
          `defines (nested/stale/ambiguous promotion) — refusing to write rather than ` +
          `trust a possibly-stale node (#458).`,
      );
    }
  } else {
    authTarget = node;
  }

  if (authTarget && typeof authTarget.type === "string") {
    assertTypeAgainstFreshBackend(freshDefs, authTarget.type, authTarget.id);
  }

  // #458 stale-INSTANCE guard on the ULTIMATE CONCRETE node. applyWidgetWrite runs the
  // registered/stale-placeholder check (assertResolvedTargetRegistered) only on the
  // IMMEDIATE write target — for a NESTED promotion that is the intermediate VIRTUAL
  // SubgraphNode (defless/trusted), so the concrete backend instance we ultimately drive
  // through the chain is never instance-checked there. A STALE generic placeholder (its
  // type is registered but constructor.nodeData is missing — the workflow was loaded
  // while ComfyUI was down) would then be mutated behind a fresh TYPE auth that only
  // proves the type is live, not that THIS instance is real. Check the concrete instance
  // here, before any mutation. (Skipped when the concrete node IS the immediate write
  // target — single-level/direct — since applyWidgetWrite already checks it.)
  if (isResolvedPromotion && authTarget && authTarget !== resolvedTargetNode) {
    assertResolvedTargetRegistered(liveRegistry(), authTarget);
  }

  // (1) Preflight the OUTER node before ANY mutation; decide whether reconcile
  //     may run (never on a placeholder; skipped for subgraph parents).
  const { reconcile } = preflightSetWidgetTarget(liveRegistry(), node);
  // (2) Repair positional UNKNOWN/UNKNOWN_n widget names against the live def so
  //     the caller's real widget name resolves (#199) — resolved direct node only.
  if (reconcile) reconcileUnknownWidgetNames(node);

  // (3) applyWidgetWrite owns the whole write: for a PARENT SubgraphNode it
  // resolves a PROMOTED widget to its ACTUAL inner (node, widget) and writes
  // THERE (#233); it validates the value against the target's declared type
  // (#240) and verifies the write stuck exactly. The injected assertTargetWritable
  // runs on the RESOLVED target BEFORE coercion/mutation, so a placeholder is
  // refused before any side effect (#458). promotedResolution is reused so the
  // write lands on the exact inner node the fresh oracle authorized.
  // The full (possibly dotted) widgetName is passed through UNCHANGED (#560): sub-field
  // addressing ("lora_1.on") is resolved EXACT-NAME-FIRST inside applyWidgetWrite /
  // resolveWidgetWrite — a real widget whose own name contains a dot still wins, and a
  // dotted form is only interpreted when no exact widget matches — so the split can
  // never silently misroute to a different widget.
  const write = () =>
    applyWidgetWrite(node, widgetName, value, {
      resolveSource,
      canvas,
      beforeChange,
      afterChange,
      setDirty,
      assertTargetWritable: (targetNode) => assertResolvedTargetRegistered(liveRegistry(), targetNode),
      promotedResolution,
    });

  // #558: the value widget being written may be governed by a non-`fixed`
  // control_after_generate (seed randomize/increment/…), which SILENTLY overwrites
  // it after the next generation. Warn HONESTLY on success — the write "took", but it
  // will not hold — pointing at the exact control widget to make it stick. Computed on
  // the ULTIMATE CONCRETE node + its concrete widget name (where control_after_generate
  // actually lives): a nested promotion A→B→KSampler exposes `seed` on B virtually, but
  // the control combo is on KSampler — `authTarget`/`concreteWidgetName` follow the
  // promotion chain to it (both are the node itself for a direct write).
  const withWarning = (result) => {
    const warnNode = authTarget ?? resolvedTargetNode;
    const warnWidget = concreteWidgetName ?? writeTargetWidgetName ?? widgetName;
    const warning = controlAfterGenerateWarning(warnNode, warnWidget);
    return warning ? { ...result, warning } : result;
  };

  try {
    return withWarning({ set: write() });
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
        // Reuse the /object_info payload already fetched for type authorization so a
        // combo miss does not round-trip /object_info a SECOND time (#458 P2): the
        // production refreshCombos refreshes THIS target's combo options from the
        // passed defs instead of calling refreshComboInNodes (which re-fetches). The
        // resolved WRITE target (the intermediate inner node for a nested promotion) is
        // the node whose widget is mutated, but its authoritative options must be keyed
        // on the ULTIMATE CONCRETE type (authTarget) — a virtual intermediate is absent
        // from /object_info, so keying on it would refresh nothing and reject a valid
        // just-staged value (#458 nested combo-refresh). A RENAMED nested promotion also
        // needs the mutated widget's name bridged to the concrete def's input name (#366
        // rename support). When defs are unavailable it falls back to a full refresh.
        const comboNameMap =
          writeTargetWidgetName && concreteWidgetName
            ? { [writeTargetWidgetName]: concreteWidgetName }
            : undefined;
        await refreshCombos(freshDefs ?? undefined, resolvedTargetNode, authTarget?.type, comboNameMap);
      } catch {
        /* refresh best-effort; fall through to re-raise the original rejection */
      }
      try {
        return withWarning({ set: write(), refreshed: true });
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
