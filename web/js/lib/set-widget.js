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
  collectPromotionIntermediates,
} from "./widget-write.js";
import { reconcileUnknownWidgetNames } from "./asset-staleness.js";
import {
  preflightSetWidgetTarget,
  assertResolvedTargetRegistered,
  assertTypeAgainstFreshBackend,
  assertMutatedNodeAuthorized,
  isVirtualSubgraphContainer,
  backendHistoryVerdict,
  freshBackendDefinesType,
} from "./node-resolve.js";
import { controlAfterGenerateWarning, controlEntryForWidget } from "./control-after-generate.js";
import {
  uploadInputConfig,
  uploadInputAccepts,
  addComboOption,
  serverDeclaresEmptyComboOptions,
} from "./input-asset.js";

/** A never-throwing rendering of an advisory failure. Used on the POST-WRITE path, where
 *  a second exception (a getter on `message`, a null throw) must not escape either. */
function coerceAdvisoryMessage(err) {
  try {
    const msg = err?.message;
    if (typeof msg === "string" && msg) return msg;
    return String(err);
  } catch {
    return "the reason could not be rendered";
  }
}

export async function runSetWidget(
  node,
  widgetName,
  value,
  {
    registry = {},
    getRegistry,
    getFreshObjectInfo,
    wasTypeEverDefined,
    resolveSource,
    canvas,
    beforeChange,
    afterChange,
    setDirty,
    // The graph command handler captures its bridge-owned workflow stamp at
    // dispatch. `runSetWidget` awaits fresh backend metadata before writing, so
    // it rechecks that stamp immediately before every possible write. This is
    // injected so the shared body stays browser-independent and its unit tests
    // exercise the exact production write boundary.
    assertTargetStillCurrent,
    refreshCombos,
    confirmServerAsset,
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
  //         One exception, still fail-closed: a GENUINE virtual subgraph container
  //         (POSITIVELY never-seen history AND absent from the fresh /object_info)
  //         with no promoted match is refused UP FRONT with the honest "not a promoted
  //         widget on this subgraph" diagnosis (#612) — its UUID type is never in
  //         /object_info, so the generic fresh-auth message ("backend does not provide
  //         node type <uuid>") misreports a benign not-promoted case as a removed pack.
  //         Both facts must be POSITIVE; see the branch below for why neither may be
  //         inferred from an absence of evidence.
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
    // #612: a GENUINE virtual subgraph container whose requested widget matched NO
    // promoted alias is a distinct, benign branch — the widget simply is not exposed
    // on the subgraph boundary (an inner node's widget that was never promoted; the
    // #512 recurrence is exactly this: a legacy proxyWidgets promotion of
    // control_after_generate that the current frontend QUARANTINED on load because a
    // canvas-only control widget has no connectable slot). Falling through to the
    // fresh-backend type check below would misdiagnose it as "the ComfyUI backend
    // does not provide node type <uuid>" — a subgraph node's type is its subgraph
    // UUID, NEVER in /object_info by design — sending the agent hunting a phantom
    // uninstalled pack. The refusal itself is unchanged (fail closed); only the
    // diagnosis is corrected, and it is a graph-local fact that needs no backend
    // oracle. The observed-history verdict is consulted FIRST: a container-shaped
    // node whose type the backend reported earlier this session is a REMOVED backend
    // node masquerading as a container and keeps the removed-type diagnosis below,
    // as does a bare `subgraph:{}` marker that is not a real container.
    //
    // TWO POSITIVE facts are required before this definite diagnosis may be asserted,
    // because "not a promoted widget on this SUBGRAPH" claims the node is a virtual-only
    // container — and getting that wrong refuses a legitimate write while handing the
    // caller a remedy that is actionable and WRONG (worse than a bare refusal):
    //
    //   1. The CURRENT /object_info was FETCHED and does NOT define this type. Two
    //      distinct facts, and both are needed. A backend-defined, subgraph-capable node
    //      ADDED AFTER the startup baseline is `never-seen` on its first observation, yet
    //      its type IS in the fresh defs this call already fetched — it is a real backend
    //      node writing its OWN widget directly, and the fresh-type authorization below
    //      is entitled to PERMIT it. And when the fetch FAILED there are no fresh defs at
    //      all: an unavailable map is not evidence the backend lacks the type, so the
    //      current-absence fact is simply not established and this diagnosis may not be
    //      asserted. That case falls through to the fresh-auth guard, which refuses with
    //      the accurate "object_info is unavailable — reconnect and retry".
    //   2. The history oracle POSITIVELY reports never-seen. `no-oracle` is the
    //      could-not-determine case BY DEFINITION — it establishes neither "never
    //      backend-defined" nor safe container identity (backendHistoryVerdict's own
    //      fail-closed contract) — so it must FALL THROUGH to the fresh-type
    //      authorization rather than short-circuit to a definite negative. That path
    //      still fails closed for a type the backend does not provide; it just stops
    //      asserting a container diagnosis nothing established.
    //
    // "Could not determine whether this is a promoted widget on a subgraph" is not
    // "determined it is not" — the same fold this cluster exists to correct.
    if (node?.subgraph && isVirtualSubgraphContainer(node)) {
      const containerVerdict = backendHistoryVerdict(node?.type, wasTypeEverDefined);
      // An UNAVAILABLE map is could-not-determine, NOT "the backend lacks this type" —
      // freshBackendDefinesType returns false for both, so the two must be told apart
      // here or an unreachable backend silently becomes positive evidence.
      const freshDefsUsable = !!freshDefs && typeof freshDefs === "object";
      const absentFromFreshBackend =
        freshDefsUsable && !freshBackendDefinesType(freshDefs, node?.type);
      if (containerVerdict === "never-seen" && absentFromFreshBackend) {
        const promoted = (node.widgets ?? [])
          .map((w) => w?.name)
          .filter((n) => typeof n === "string");
        throw new Error(
          `Cannot set widget on subgraph node ${node.id}: "${widgetName}" is not a promoted ` +
            `widget on this subgraph (promoted: ${promoted.length ? promoted.join(", ") : "none"}). ` +
            `Only promoted widgets are settable from outside a subgraph — panel_enter_subgraph ` +
            `and set it on the inner node directly, or promote it from inside the subgraph with ` +
            `panel_promote_widget first.`,
        );
      }
    }
    authTarget = node;
  }

  if (authTarget && typeof authTarget.type === "string") {
    // Pass the live registry so a genuine FRONTEND-ONLY node (rgthree Fast Bypasser,
    // Note, Reroute — registered + on the POSITIVE frontend-only allowlist, absent from
    // /object_info by design) is permitted when object_info was fetched, WITHOUT
    // reopening the #458 removed-type hole (a removed backend type — stale class WITH
    // nodeData OR a defless husk — is not allowlisted and is still refused; an
    // unavailable object_info still fails closed for everything). #475.
    assertTypeAgainstFreshBackend(freshDefs, authTarget.type, authTarget.id, {
      registry: liveRegistry(),
      node: authTarget,
      // #458 OBSERVED-BACKEND-HISTORY: a type ever reported by the backend this session
      // but absent from the current /object_info is a REMOVED backend node — refuse
      // (the non-forgeable trust root; client shape/name/markers cannot prove this).
      wasTypeEverDefined,
    });
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

  // #458 NESTED-INTERMEDIATE (found in adversarial review of #475): fresh-auth above
  // authorizes only the TERMINAL concrete node (authTarget), but applyWidgetWrite
  // actually MUTATES — and reports success on — the IMMEDIATE inner promoted node (its
  // widget) AND the OUTER subgraph parent (its rail/proxy widgets). For a NESTED
  // promotion the immediate inner is an INTERMEDIATE virtual node that is NOT the
  // terminal, and it was previously trusted merely for being "defless with subgraph
  // metadata" — the same defless≠safe mistake fixed at the terminal. Authorize EVERY
  // mutated node: absent from fresh /object_info is permitted ONLY as a provenance-clean
  // virtual-subgraph container (or frontend-only leaf), never a removed/stale backend
  // node masquerading with a subgraph field.
  //
  // #512: every call below passes promotionResolvedToAuthorizedConcrete — an HONEST
  // statement by control flow, never a guess: reaching this point means the promotion
  // was positively resolved (isResolvedPromotion) AND followPromotionToConcrete reached
  // a concrete backend node whose type assertTypeAgainstFreshBackend already authorized
  // (both throw above otherwise). A genuine UUID SubgraphNode whose class carries the
  // frontend's synthesized def markers (nodeData/comfyClass, stamped by design) is
  // therefore authorized through that verified inner target instead of the
  // provenance heuristic, which no longer discriminates containers; the ever-seen gate
  // inside the guard still refuses a mid-session-removed container type first.
  if (isResolvedPromotion) {
    // The OUTER subgraph parent (its rail/proxy widgets are mutated).
    assertMutatedNodeAuthorized(freshDefs, liveRegistry(), node, "outer subgraph", wasTypeEverDefined, {
      promotionResolvedToAuthorizedConcrete: true,
    });
    // EVERY intermediate virtual container the promotion is driven THROUGH — not just
    // the immediate inner. A deeper intermediate (A→B→C→concrete's C) is otherwise
    // never authorized, so a removed-backend node forwarded-through would be trusted.
    // Each must be present in fresh /object_info, or NEVER seen this session AND a
    // provenance-clean virtual container; a since-removed (ever-seen) type is refused.
    for (const intermediate of collectPromotionIntermediates(promotedResolution.target, resolveSource)) {
      if (intermediate !== authTarget) {
        assertMutatedNodeAuthorized(freshDefs, liveRegistry(), intermediate, "intermediate promoted", wasTypeEverDefined, {
          promotionResolvedToAuthorizedConcrete: true,
        });
      }
    }
  }

  // (1) Preflight the OUTER node before ANY mutation; decide whether reconcile
  //     may run (never on a placeholder; skipped for subgraph parents).
  const { reconcile } = preflightSetWidgetTarget(liveRegistry(), node);
  // Every mutation below belongs to the captured command's target. The fresh
  // backend oracle above can yield to a workflow switch, so do not let helper
  // repairs or recovery option changes mutate the stale graph before the main
  // widget write gets its own fence check (#718).
  const assertTargetStillCurrentNow = () => {
    if (typeof assertTargetStillCurrent === "function") assertTargetStillCurrent();
  };
  // (2) Repair positional UNKNOWN/UNKNOWN_n widget names against the live def so
  //     the caller's real widget name resolves (#199) — resolved direct node only.
  if (reconcile) {
    assertTargetStillCurrentNow();
    reconcileUnknownWidgetNames(node);
  }

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
  const write = (extra = {}) => {
    // No await follows this check before applyWidgetWrite, whose mutation is
    // synchronous. A workflow switch while the fresh-object-info fetch was in
    // flight therefore refuses before touching either canvas; retry and upload
    // recovery use this same boundary too.
    assertTargetStillCurrentNow();
    return applyWidgetWrite(node, widgetName, value, {
      resolveSource,
      canvas,
      beforeChange,
      afterChange,
      setDirty,
      assertTargetWritable: (targetNode) => assertResolvedTargetRegistered(liveRegistry(), targetNode),
      promotedResolution,
      ...extra,
    });
  };

  // #558: the value widget being written may be governed by a non-`fixed`
  // control_after_generate (seed randomize/increment/…), which SILENTLY overwrites
  // it after the next generation. Warn HONESTLY on success — the write "took", but it
  // will not hold — pointing at the exact control widget to make it stick. Computed on
  // the ULTIMATE CONCRETE node + its concrete widget name (where control_after_generate
  // actually lives): a nested promotion A→B→KSampler exposes `seed` on B virtually, but
  // the control combo is on KSampler — `authTarget`/`concreteWidgetName` follow the
  // promotion chain to it (both are the node itself for a direct write).
  //
  // #650 SCOPE: the remedy has to be executable from the scope the CALLER is in. When
  // the write went through a promotion, that concrete node is INSIDE the subgraph and
  // its id does not exist in the caller's graph — following the old unconditional
  // `panel_set_widget(node_id=<inner id>, …)` returned "No node with id 75 in the
  // current graph". The reachability below is not a guess: it is read off the SAME
  // resolution the write itself was driven through.
  const controlScopeFor = (entry) => {
    const warnNode = authTarget ?? resolvedTargetNode;
    // Direct write (or the concrete node IS the node the caller addressed): the control
    // widget is right there, and the plain form is already actionable.
    if (!isResolvedPromotion || warnNode === node) return {};
    const outerNodeId = node?.id;
    // Is the CONTROL widget itself promoted onto the outer node? Then it is settable
    // from this scope with no entering at all. Asked of the same resolver the write
    // used, so a positive answer is an observed promotion, never an assumption.
    // (Usually NO: ComfyUI marks control_after_generate canvasOnly, so it has no
    // connectable slot to promote — but a legacy proxyWidgets promotion can exist.)
    const controlPromotion = resolvePromotedInnerTarget(node, entry.control, resolveSource);
    if (controlPromotion?.promoted && controlPromotion.target) {
      const reached = followPromotionToConcrete(controlPromotion.target, resolveSource);
      if (reached?.node === warnNode && reached?.widget?.name === entry.control) {
        return { outerNodeId, promotedAs: entry.control };
      }
    }
    // Otherwise it is only reachable from INSIDE: enter the outer container, then every
    // nested container the promotion is driven through, in that order. The concrete
    // terminal is never an entry step (collectPromotionIntermediates excludes it).
    const enterPath = [
      outerNodeId,
      ...collectPromotionIntermediates(promotedResolution.target, resolveSource).map((n) => n?.id),
    ];
    return { outerNodeId, enterPath };
  };
  // The write has ALREADY LANDED and been verified by the time this runs. Everything
  // here is ADVISORY, and advisory work is still work that can fail: controlScopeFor
  // re-enters resolvePromotedInnerTarget / collectPromotionIntermediates, which call the
  // injected `resolveSource` — a malformed or control-only promotion link can throw
  // there. Letting that escape would report a COMPLETED, verified write as a failure,
  // and the caller would then "retry" a write that already happened. Refuse before the
  // action; DISCLOSE after it. So the advisory is computed inside a guard, and its
  // failure downgrades to a disclosed gap, never to a failed write.
  const withWarning = (result) => {
    try {
      const warnNode = authTarget ?? resolvedTargetNode;
      const warnWidget = concreteWidgetName ?? writeTargetWidgetName ?? widgetName;
      const entry = controlEntryForWidget(warnNode, warnWidget);
      if (!entry || entry.mode === "fixed") return result;
      const warning = controlAfterGenerateWarning(warnNode, warnWidget, controlScopeFor(entry));
      return warning ? { ...result, warning } : result;
    } catch (advisoryErr) {
      return {
        ...result,
        warning:
          `The write SUCCEEDED and was verified. The panel could not finish checking whether a ` +
          `control_after_generate governs this widget (${coerceAdvisoryMessage(advisoryErr)}), so ` +
          `treat that as UNKNOWN, not as "no control": if this is a seed or similar, read the node ` +
          `with panel_query_graph(fields:'detail') and check its control_after_generate before ` +
          `relying on the value holding across runs.`,
      };
    }
  };

  // #387 UPLOAD-ASSET fallback: a value rejected by the combo list even AFTER the
  // authoritative /object_info refresh may still be a VALID, loadable input asset the
  // server has on disk but /object_info never enumerates — specifically a LoadImage
  // image uploaded under a SUBFOLDER (ComfyUI's LoadImage.INPUT_TYPES lists only
  // TOP-LEVEL input files, yet load_image resolves a nested `subfolder/name.png`).
  // When the mutated widget is an UPLOAD input (per the fresh def's config flags) and
  // the injected probe CONFIRMS the file exists in the server's input directory, add
  // it to the live option list and revalidate ONCE. Gated to upload inputs AND to
  // server-confirmed files, so #240 strictness holds (never a blanket accept).
  const tryUploadAssetAccept = async () => {
    if (typeof confirmServerAsset !== "function") return false;
    const cfg = uploadInputConfig(
      freshDefs ?? undefined,
      authTarget?.type,
      concreteWidgetName ?? writeTargetWidgetName ?? widgetName,
    );
    if (!cfg) return false;
    // #240 strictness: a server-existence probe alone is too loose — `/view?type=input`
    // serves ANY input file, so accept ONLY a value whose extension is a loadable asset
    // of THIS input's upload kind (e.g. an image extension for an image_upload combo),
    // never a stray `.txt` the LoadImage combo would never list.
    if (!uploadInputAccepts(cfg, value)) return false;
    const uploadWidget = (resolvedTargetNode?.widgets ?? []).find(
      (w) => w?.name === (writeTargetWidgetName ?? widgetName),
    );
    if (!uploadWidget) return false;
    let exists = false;
    try {
      exists = await confirmServerAsset(value);
    } catch {
      exists = false;
    }
    if (!exists) return false;
    // confirmServerAsset may have yielded while the user changed canvases; do
    // not add an option to the captured widget after that switch (#718).
    assertTargetStillCurrentNow();
    return addComboOption(uploadWidget, value);
  };

  try {
    return withWarning({ set: write() });
  } catch (err) {
    // Only a COMBO rejection is EVER retryable — every other WidgetWriteError
    // (numeric/boolean/promotion/composite/stuck-check) fails closed immediately.
    if (!(err instanceof WidgetWriteError)) throw err;
    if (!err.combo) {
      throw new Error(
        `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}): ${err.message}`,
      );
    }

    // STALE-COMBO RECOVERY (#338/#317/#299/#288/#284/#304): a just-downloaded model /
    // TOP-LEVEL uploaded image / staged output / freshly installed pack the frontend
    // combo snapshot doesn't list yet. Pull the AUTHORITATIVE option list from the
    // connected server and revalidate EXACTLY ONCE, then fall back to the #387
    // upload-asset probe for a value the refreshed list still cannot contain.
    let latest = err;
    if (typeof refreshCombos === "function") {
      try {
        // Reuse the /object_info payload already fetched for type authorization so a
        // combo miss does not round-trip /object_info a SECOND time (#458 P2). Key the
        // options on the ULTIMATE CONCRETE type (authTarget) — a virtual intermediate is
        // absent from /object_info — and bridge a RENAMED nested promotion's widget name
        // to the concrete def input name (#366). A missing payload falls back to a full
        // refresh inside the injected callback.
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
        if (!(retryErr instanceof WidgetWriteError)) throw retryErr;
        // A NON-combo failure on the retry is terminal — fail closed loudly.
        if (!retryErr.combo) {
          throw new Error(
            `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}) ` +
              `after refreshing combo options: ${retryErr.message}`,
          );
        }
        // Still a combo miss after the refresh — keep the freshest reason and try the
        // upload-asset fallback below.
        latest = retryErr;
      }
    }

    // #387: server-confirmed upload asset (e.g. a subfolder-nested LoadImage image).
    if (await tryUploadAssetAccept()) {
      try {
        return withWarning({ set: write(), refreshed: true, server_confirmed: true });
      } catch (confErr) {
        if (confErr instanceof WidgetWriteError) {
          throw new Error(
            `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}) ` +
              `after confirming the uploaded asset exists on the server: ${confErr.message}`,
          );
        }
        throw confErr;
      }
    }

    // #507 DYNAMIC CLIENT-POPULATED COMBO, the LAST resort — deliberately after every
    // authoritative mechanism above has been tried and failed. Some custom nodes declare
    // a combo with an EMPTY option list on purpose (StarNodes' `"model": ((), {...})`
    // ⇒ /object_info reports `[[], {...}]`) and let the node's own frontend JS fill the
    // dropdown at runtime. `comboOptions()` returns `[]` — TRUTHY — so the "no readable
    // option list" guard never fired and `[].includes(value)` rejected EVERY value,
    // making the widget permanently unwritable by the agent.
    //
    // ZERO options means the option set is genuinely NOT KNOWABLE, which is not the same
    // as "no value is valid"; and #240's reason for strict membership (a number being
    // reinterpreted as an INDEX into a real list) cannot apply when there is no list to
    // index into. So take the value as written — but ONLY under two hard conditions:
    //
    //   1. The rejection really WAS the empty-list case (err.emptyOptions, set solely by
    //      that branch) — never a "not a valid option" miss against a real list.
    //   2. The freshly-fetched /object_info AUTHORITATIVELY declares this input's option
    //      list EMPTY (serverDeclaresEmptyComboOptions). The LIVE widget alone is not
    //      enough (codex round-2, SEVERE): a widget whose `options.values` is a FUNCTION
    //      is deliberately never clobbered by the combo refresh, so a dynamic source that
    //      returns [] right now would look "empty" even while the server publishes a real
    //      list — and an off-list value would be written. Keyed on the ULTIMATE CONCRETE
    //      type + its concrete input name, exactly like the #387 probe above, so a renamed
    //      nested promotion still looks the right def input up.
    //
    // It also runs LAST, so a merely-STALE empty list is refreshed first and a
    // server-confirmable upload asset is confirmed first. NOT wrapped in a catch: this is
    // a real write attempt, and a genuine failure from it (a rejected value, a partial/
    // rolled-back write) must propagate UNCHANGED rather than be masked by the earlier
    // combo rejection.
    if (
      latest?.emptyOptions &&
      serverDeclaresEmptyComboOptions(
        freshDefs ?? undefined,
        authTarget?.type,
        concreteWidgetName ?? writeTargetWidgetName ?? widgetName,
      )
    ) {
      return withWarning({
        set: write({ acceptEmptyComboOptions: true }),
        ...(typeof refreshCombos === "function" ? { refreshed: true } : {}),
        empty_option_list: true,
      });
    }

    // No recovery succeeded — refuse honestly with the freshest rejection.
    throw new Error(
      `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type})` +
        `${typeof refreshCombos === "function" ? " after refreshing combo options" : ""}: ${latest.message}`,
    );
  }
}
