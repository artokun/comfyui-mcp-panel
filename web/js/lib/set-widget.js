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
import { linkDrivenWidgets, drivenTag } from "./graph-read.js";
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
    // #982 — what the /object_info oracle observed on its last attempt, so an
    // unavailable-schema refusal can name the routes it tried instead of asserting a
    // cause it never established.
    describeObjectInfoFailure,
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
    // #1223 × #1126 — WHERE the schema `getFreshObjectInfo` answered with actually came
    // from. Read as a FUNCTION, at the moment of decision, because the answer is only known
    // AFTER the oracle has run.
    //
    //   "live"        the server answered this call's own request and nothing retired it
    //   "cache"        #716's ≤1.5s burst cache answered, or this call joined another's
    //                  in-flight request — nobody asked the server just now
    //   "reconnected"  this call DID issue the request, but the backend reconnected before it
    //                  resolved, so the payload describes a ComfyUI process that has since
    //                  been replaced
    //   "retired"      this call DID issue the request, but an `invalidate()` — a refresh, a
    //                  pack install, a download completing — retired it mid-flight. The panel
    //                  itself superseded that schema; a list it declares empty may have been
    //                  filled by the very refresh that retired it
    //   "snapshot"     #1223's last-observed schema stood in while both live probes were
    //                  silent. NOTE it is a detached map of TYPE NAMES ONLY — see the
    //                  fallback below for why that makes it unable to answer this question
    //                  at all, rather than merely answering it staleley
    //   "none"         nothing was established
    //
    // The first four are ONE answer from object-info-cache.js, which owns the generation
    // counter that retires requests and decides how each read is served. They are emphatically
    // NOT four conditions for a caller to assemble: that was tried, and four review rounds
    // each found another way a response could fail to be live while the reconstructed test
    // still said it was. A retirement mechanism added to that file is classified by that file.
    //
    // Only the #1126 blind-write fallback consults it, and it must: that fallback's entire
    // justification is "the SERVER authoritatively declares this input's option list empty",
    // and only "live" is the server answering. Every other value is the server's PAST word,
    // retained across a window in which nobody re-asked — a snapshot across a disconnection
    // (#1223), a cache entry across ≤1.5s of a write burst (#716), a response the backend
    // was replaced underneath, a response the panel's own refresh superseded. Options change
    // without a reconnect and without a cache drop (a model downloaded while the node's own
    // live callback stays unreadable), so any stale `[]` would authorize an unvalidated write
    // against a list that is no longer empty.
    //
    // Defaults to "live" when unwired, which is the pre-#716/#1223 world every other caller
    // and test still models: an oracle with no cache and no snapshot branch could only ever
    // have fetched. The panel threads the fact rather than letting this infer it — only the
    // oracle knows which branch answered.
    schemaProvenance,
    // #1126 — force a genuinely LIVE re-read on the last-resort blind-write path, bypassing
    // the #716 burst cache. Deliberately NOT "invalidate, then re-read": that spelling is
    // global, so two writes reaching this path together each retired the other's just-issued
    // request (one caller refusing another's valid write), and nothing coalesced, so a burst
    // paid for one multi-megabyte /object_info per caller. The capability now names the
    // OUTCOME the ladder needs — a fresh answer — and leaves the cache to decide how to get
    // one without disturbing anybody else.
    refetchObjectInfoLive,
  } = {},
) {
  // Never re-derived, and never cached: the oracle may not have run yet when this closure is
  // built, and a caller that answers differently per call is answering about a different
  // fetch. A non-function is the unwired default ("live", see above); a THROWING one, or one
  // answering something unrecognized, is UNKNOWN provenance — which fails CLOSED for the one
  // branch that asks, because nothing established must never read as the server answering.
  const readSchemaProvenance = () => {
    if (typeof schemaProvenance !== "function") return "live";
    try {
      const p = schemaProvenance();
      return p === "live" ||
        p === "cache" ||
        p === "reconnected" ||
        p === "retired" ||
        p === "snapshot" ||
        p === "none"
        ? p
        : "unknown";
    } catch {
      return "unknown";
    }
  };
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
  // #1126 — is the promotion NESTED (outer → intermediate subgraph → … → concrete), as
  // opposed to a single hop straight to the concrete node? Keyed on exactly what
  // followPromotionToConcrete's own `while (node && node.subgraph)` loop keys on, so the
  // two can never disagree about whether the chain continues past the immediate target.
  // Read only by the #1126 unreadable fallback; see its refusal for why it matters.
  let nestedPromotion = false;
  if (promotedButUnresolvable) {
    authTarget = null;
  } else if (isResolvedPromotion) {
    nestedPromotion = Boolean(promotedResolution.target?.node?.subgraph);
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
      describeObjectInfoFailure,
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
  // #1126 — the ONE place a WidgetWriteError becomes a `panel_set_widget refused …` message.
  //
  // That frame asserts something beyond the wrapped message: that this was a REFUSAL, so
  // nothing was applied and the caller may retry or give up freely. Every pre-mutation
  // validation error satisfies that. `partialWrite` does not — it is raised AFTER the graph
  // was mutated and the rollback failed to restore it — and reporting it as a refusal tells
  // the caller "nothing happened" about a graph that is now in a partial state, which is the
  // exact class of false report this whole change exists to eliminate. It propagates verbatim
  // so the caller reads the partial-state warning the write itself wrote, undiluted.
  const refusalFrame = (err, after = "") =>
    err?.partialWrite
      ? err
      : new Error(
          `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type})${after}: ` +
            `${err.message}`,
        );

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
  // #1087 — a DIRECT write to a widget that is LINK-DRIVEN does not reach the render.
  //
  // The reported case: an inner subgraph node whose `steps` is driven from a promoted
  // parent rail. Writing it directly reported a clean success — `{previous:14, value:10}` —
  // and the queue still sampled at 14, because the rail's value is what serializes. A
  // silent wrong OUTPUT, not a cosmetic gap.
  //
  // Detection reuses `linkDrivenWidgets`, the SAME read `panel_graph_outline` already marks
  // these widgets with. That is the whole reason this can be added safely: the information
  // was demonstrably available and simply not consulted here. Nothing new walks the graph,
  // and no new write path is introduced — `widget-write.js`'s fail-closed object-identity
  // rules are untouched.
  //
  // THE FALSE POSITIVE TO AVOID, and what actually avoids it. On the working PARENT→inner
  // path the inner widget is ALSO link-driven (from the subgraph input rail), so a check
  // aimed at the WRITE TARGET would fire on exactly the writes that are correct — the ones
  // already reporting `parent_widget_synced: true`.
  //
  // What prevents that is reading `node` — the node the CALLER ADDRESSED — rather than
  // `authTarget`. A parent-addressed promoted write asks the question of the SubgraphNode,
  // whose host input carries `_widget`/`_subgraphSlot` and no `link`, so it is not
  // link-driven and nothing warns. (An externally-linked host input, the one case where the
  // parent DOES carry a link, already fails closed in resolveHostPromotedWidgets and never
  // reaches here.)
  //
  // The `isResolvedPromotion` check below is therefore belt-and-braces, and is REDUNDANT
  // today — verified by mutation: removing it leaves the parent-path test green. It is kept
  // because it states the intent at the point of decision, and because it is what would
  // still hold if this ever moved to the resolved target. Not described as load-bearing,
  // since it is not.
  //
  // WARNS rather than refuses, per the report's own preference order. Setting an inner
  // widget is a legitimate thing to want — it is the subgraph's stored default — so
  // refusing would block real work to prevent a misunderstanding. What was missing is the
  // truth about what serializes.
  const linkDrivenWarning = () => {
    if (isResolvedPromotion) return null;
    const src = linkDrivenWidgets(node)?.[writeTargetWidgetName ?? widgetName];
    if (!src) return null;
    const name = writeTargetWidgetName ?? widgetName;
    return (
      `The write SUCCEEDED and was verified, but it will NOT change the render: widget ` +
      `"${name}" on node ${node?.id} is link-driven${drivenTag(src)}, so the value arriving ` +
      `on that link is what serializes at queue time and this stored value is ignored. When ` +
      `the link comes from a promoted subgraph input, set the widget on the ENCLOSING ` +
      `subgraph node instead (panel_exit_subgraph, then panel_set_widget there) — that path ` +
      `syncs both and reports parent_widget_synced.`
    );
  };
  const withWarning = (result) => {
    try {
      // Checked FIRST: "this write does not reach the render at all" outranks "it will be
      // overwritten after the next generation", and the two can both be true on a seed.
      const driven = linkDrivenWarning();
      if (driven) return { ...result, warning: driven };
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
      throw refusalFrame(err);
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
          throw refusalFrame(retryErr, " after refreshing combo options");
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
          throw refusalFrame(confErr, " after confirming the uploaded asset exists on the server");
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

    // #1126 UNREADABLE OPTION LIST — the sibling of the #507 branch above, and decided
    // the same way: from what the panel OBSERVED, never from a caller's assertion or a
    // guess about the node.
    //
    // A dynamic combo's options come from `options.values(widget)`, which is the node's
    // OWN callback: it can mutate the widget and it can fail. When it fails, nothing was
    // ever compared to anything — yet the write was refused, and after the ladder gave up
    // that refusal reached the user as a statement about their VALUE. A node whose runtime
    // handler takes an absolute path had the path refused as though the path were wrong,
    // and the only workaround left was copying the file into ComfyUI's input directory.
    //
    // The two conditions mirror #507's exactly, and both are observations:
    //
    //   1. The rejection really WAS the unreadable case (`err.unreadableOptions`, set
    //      solely by that branch) — never a "not a valid option" miss against a list that
    //      WAS read, which stays refused so a typo'd model name is still caught (#240).
    //   2. The freshly-fetched /object_info does not publish a list for this input either
    //      (serverDeclaresEmptyComboOptions). If the server DOES publish one, the valid
    //      set is knowable after all and a blind write would be unjustified — the live
    //      callback failing is not licence to ignore an authoritative list. Keyed on the
    //      ULTIMATE CONCRETE type + concrete input name, exactly like the probes above.
    //
    // It runs LAST, so a merely-transient callback failure has already been re-read by the
    // refresh and a server-confirmable upload asset already confirmed.
    if (latest?.unreadableOptions) {
      const comboDefInput = concreteWidgetName ?? writeTargetWidgetName ?? widgetName;
      // #1126 — a NESTED promotion is refused rather than blind-written, and this is the
      // deliberate choice between the two defensible options.
      //
      // The rejection being answered describes the IMMEDIATE promoted projection. On a
      // nested chain the value is ultimately driven into a DEEPER concrete widget that this
      // path never read — and that widget's own client-populated list may be perfectly
      // readable, in which case the fallback's premise ("the valid set is not knowable from
      // here") is simply false and a live list was available all along.
      //
      // Refusing beats validating the concrete widget here. Validating it would mean running
      // membership at another level on a last-resort path, against a dynamic source with the
      // same never-read-twice and stateful-callback hazards the sibling cross-check already
      // documents — new blind-write surface in the one place least able to carry it. A
      // refusal is recoverable and names the shape; a wrong blind write into a nested chain
      // lands on a serializing rail. The direct and single-hop promoted cases, where the
      // widget that was read IS the one the value drives, are unaffected.
      //
      // Decided FIRST, ahead of everything below. The chain shape is already known and NO
      // schema can make this writable, so establishing evidence for it is pure cost — and on
      // a non-live provenance that cost is a cache drop plus a multi-megabyte /object_info
      // re-fetch, paid to answer a question whose answer cannot change the outcome.
      if (nestedPromotion) {
        throw new Error(
          `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}): ` +
            `${latest.message} This is a NESTED promotion — the value is driven through one ` +
            `or more intermediate subgraphs to a deeper concrete widget — and the unreadable ` +
            `list observed here belongs to the intermediate projection, not to that concrete ` +
            `widget, whose own option list may be readable. The panel will not write a value ` +
            `nothing validated through a chain it has not checked end to end (#1126). Set the ` +
            `widget on the concrete node directly (panel_enter_subgraph to reach it), or fix ` +
            `the node's option callback so the list can be read.`,
        );
      }
      // #1223/#716 × #1126 — ESTABLISH THE EVIDENCE BEFORE TESTING IT, because condition 2
      // says "the SERVER declares this input's list empty" and only a LIVE read establishes
      // that. Three different layers can answer with something else, and the shape test alone
      // cannot tell them apart:
      //
      //   * "cache" — #716's ≤1.5s burst cache (or a joined in-flight read). It CAN answer the
      //     question, but with the server's word from up to a TTL ago; nobody asked during
      //     this call.
      //   * "reconnected" — this call did issue the request, but the backend reconnected before
      //     it resolved. object-info-cache deliberately still hands a retired response to its
      //     original waiter, and objectInfoSnapshot.record refuses to file it as evidence for
      //     exactly that reason. A schema describing the process that has been REPLACED must
      //     not authorize a blind write against the replacement's option lists.
      //   * "snapshot" — #1223's last-observed schema. This one cannot answer the question at
      //     ALL: what it stores is a DETACHED MAP OF TYPE NAMES, every value the shared frozen
      //     EMPTY_DEF with no `input` at all (the detachment is deliberate — retaining the
      //     payload would let a beforeRegisterNodeDef hook launder frontend-mutated defs back
      //     as backend evidence, and it would pin ~5.4MB per connection). So
      //     serverDeclaresEmptyComboOptions is ALWAYS false against a snapshot. It can say
      //     whether a TYPE exists; it can say nothing whatever about an input's option list.
      //
      // Options change without a reconnect and without a cache drop — a model downloaded while
      // this node's own live callback keeps failing — so any of these would authorize an
      // unvalidated write against a list that is no longer empty.
      //
      // So: RE-ASK before deciding. This is the last resort on a rare path, and one request is
      // a far better trade than either refusing a legitimate write (which is what a cache hit
      // would cause for writes 2..N of an ordinary burst — the exact multi-widget case this
      // fix exists to serve) or writing blind. `refetchObjectInfoLive` bypasses only the stored
      // entry and coalesces concurrent rereads, so it cannot be answered by the very entry that
      // made this uncertain AND cannot retire another writer's in-flight request.
      //
      // READ HERE, not earlier. The provenance was established before `refreshCombos` and the
      // upload probe were awaited, and both of those can supersede it — a refresh, an install,
      // a download completing, a reconnect. A verdict is a statement about a moment, so it is
      // asked at the moment it is used, on the near side of every await that could expire it.
      let provenance = readSchemaProvenance();
      let authDefs = freshDefs ?? undefined;
      // What the STALE evidence claimed, captured before it is replaced — the difference
      // between "the server publishes a list, as it always did" and "the stale schema said
      // empty and the live one disagrees" is the whole point of re-asking, and it cannot be
      // recovered after `authDefs` is overwritten.
      const staleDeclaredEmpty = serverDeclaresEmptyComboOptions(authDefs, authTarget?.type, comboDefInput);
      let reAsked = false;
      if (provenance !== "live" && typeof refetchObjectInfoLive === "function") {
        try {
          const reread = await refetchObjectInfoLive();
          if (reread) {
            authDefs = reread;
            reAsked = true;
          }
        } catch {
          /* the re-ask failed; provenance stays non-live and the refusals below fire */
        }
        provenance = readSchemaProvenance();
      }
      if (serverDeclaresEmptyComboOptions(authDefs, authTarget?.type, comboDefInput)) {
        // Fails closed: no live declaration, no blind write. The user is told WHICH fact is
        // missing and which layer withheld it, because "refresh and retry" is only actionable
        // if they know it is the schema — not their value — that could not be established.
        //
        // "snapshot" cannot reach here: its detached name-only map fails the shape test above,
        // so it is answered by its own branch below, which says something true about it rather
        // than calling a map that holds no lists "stale".
        if (provenance !== "live") {
          throw new Error(
            `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}): ` +
              `${latest.message} The panel could have written it unvalidated — this widget's ` +
              `option list could not be READ, and that is normally enough when /object_info ` +
              `also declares the input's list empty — but that "empty" did not come from the ` +
              `server answering now: ` +
              (provenance === "cache"
                ? `it came from the panel's short-lived /object_info burst cache (#716), and ` +
                  `re-asking the server did not produce a live answer either. Retry in a moment.`
                : provenance === "reconnected"
                  ? `the backend RECONNECTED while that /object_info request was in flight, so ` +
                    `the answer describes a ComfyUI process that has since been replaced — and ` +
                    `a restart is the one event that changes what the server publishes. Retry.`
                  : provenance === "retired"
                    ? `the panel REFRESHED the node definitions while that /object_info request ` +
                      `was in flight (a pack install, a model download completing, or an ` +
                      `explicit refresh), so the answer was superseded before it arrived — and ` +
                      `the very refresh that superseded it may be what filled this list. Retry.`
                    : `the schema provenance could not be established at all, and nothing ` +
                      `established must not read as the server answering. Reconnect to ComfyUI ` +
                      `and retry.`) +
              ` Options can change without a reconnect, so a stale empty list is not evidence ` +
              `the valid set is unknowable.`,
          );
        }
        let set;
        try {
          // BOTH acceptances, and the empty one is not incidental. `options.values` is a
          // callback: a stateful one can throw on the initial read and on the refreshed read,
          // then return `[]` on this final invocation. With only the unreadable acceptance
          // enabled, coercion would fall through to the #507 empty-list branch, raise a
          // RETRYABLE `emptyOptions` rejection, and refuse — telling the caller "the server's
          // option list may simply be stale, refreshing it before deciding" at the end of a
          // ladder that has already refreshed it, about the one transition that is unambiguously
          // valid. By this line the LIVE server schema has ALREADY confirmed the list empty for
          // this input, which is exactly #507's own precondition, so an empty final read is a
          // weaker observation of the same fact — not a new doubt.
          //
          // Which acceptance actually admitted the value is still decided at COERCION time and
          // reported from there, so the disclosure below names what happened rather than what
          // this call hoped for: an empty final read discloses `empty_option_list` (and carries
          // #507's rail label-adoption rule, correctly, because an empty list really does admit
          // any scalar), an unreadable one discloses `option_list_unreadable`.
          set = write({ acceptUnreadableComboOptions: true, acceptEmptyComboOptions: true });
        } catch (unreadableErr) {
          // A validation refusal from THIS attempt (a non-string value, a rail whose own
          // list is real and lacks the value) must arrive framed like every other refusal:
          // with the tool name, the widget, and the node. Unframed, the retry the caller was
          // invited to make answers `Value 640 is not a valid option…` with nothing saying
          // where it came from. Anything that is not a validation refusal — a partial write,
          // or anything that is not a WidgetWriteError at all — propagates UNCHANGED rather
          // than being reworded; `refusalFrame` enforces the partial-write half.
          if (unreadableErr instanceof WidgetWriteError) {
            throw refusalFrame(unreadableErr, " after finding the combo's option list unreadable");
          }
          throw unreadableErr;
        }
        return withWarning({
          set,
          ...(typeof refreshCombos === "function" ? { refreshed: true } : {}),
          // A stateful callback that finally answered `[]` landed on #507's acceptance instead,
          // and that is reported as #507 reports it — the same field the branch above returns,
          // so one outcome has one name wherever it is reached from.
          ...(set?.empty_option_list ? { empty_option_list: true } : {}),
          // The COERCION-TIME verdict, never re-derived: a stateful options callback can
          // succeed on the final attempt, and the value would then have been validated by
          // ordinary membership — claiming an unchecked write there would be false.
          ...(set?.option_list_unreadable
            ? {
                option_list_unreadable: true,
                ...(set.promoted_rail_validated ? { promoted_rail_validated: true } : {}),
                // Scoped to the widget the claim is actually about. A promoted write also
                // mutates the parent rail, and when that rail's list IS readable the sibling
                // cross-check compares the value against it and only proceeds on membership —
                // so a flat "nothing checked it" was false in exactly the case where the most
                // checking happened. The two sentences are chosen by DATA the write emitted,
                // never by re-deriving what the cross-check did.
                option_list_unreadable_note:
                  `Written WITHOUT validation against THIS widget's own option list, because that ` +
                  `list could NOT BE READ — not because the value was checked and passed. ` +
                  `Observed on the widget: ` +
                  `${set.option_list_unreadable_detail ?? "its option list could not be READ"}. ` +
                  `The server's own /object_info declares this input's option list EMPTY, so the ` +
                  `valid set is not knowable from the widget itself (#1126). ` +
                  (set.promoted_rail_validated
                    ? `It was NOT written entirely unchecked: this promoted write also mutates the ` +
                      `parent subgraph's rail widget, whose option list WAS readable and DOES ` +
                      `contain this value — the write proceeded only because that list vouched for ` +
                      `it. The rail is what serializes at queue time, so the value is a real option ` +
                      `there. `
                    : `Nothing compared your value to anything. `) +
                  `If the node rejects it at runtime that is the node's answer, not a panel ` +
                  `refusal to retry around. The graph now holds a value this widget's own option ` +
                  `list does not vouch for, so a later reader — including the ComfyUI dropdown ` +
                  `itself — may show it as out-of-range.`,
              }
            : {}),
        });
      }
      // The shape test said the server does NOT declare this input's list empty — but when the
      // only schema available is #1223's snapshot, that "no" is not the server publishing a
      // list. It is a map that holds TYPE NAMES ONLY answering a question about an INPUT, and
      // it would answer "no" for every input on every node in existence.
      //
      // CHOSEN BEHAVIOUR: a snapshot can NEVER authorize this fallback. Not "sometimes, if it
      // happens to say empty" — it structurally cannot say empty, so there is no case to gate.
      // The alternative (teach the snapshot to retain option lists) was rejected outright: the
      // detachment is #1223's defence against beforeRegisterNodeDef mutating defs in place, and
      // re-attaching payloads to widen a last-resort blind write would trade a real integrity
      // guarantee for a convenience on the rarest path in the ladder.
      //
      // What it gets instead is an honest refusal. Falling through to the generic end-of-ladder
      // message would tell the caller only that their combo could not be read, sending them to
      // look at their value while the actual cause is a silent backend — the exact
      // misattribution this whole change exists to stop.
      if (provenance === "snapshot") {
        throw new Error(
          `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}): ` +
            `${latest.message} The panel could have written it unvalidated if /object_info ` +
            `declared this input's option list empty — but the live schema probe went silent, ` +
            `so the only schema available is the LAST-OBSERVED one (#1223), which is stored as ` +
            `a detached map of TYPE NAMES ONLY. It can say whether this node type still exists; ` +
            `it holds no option lists at all, so it cannot establish that the valid set is ` +
            `unknowable. Reconnect to ComfyUI (or wait for the backend to answer /object_info ` +
            `again) and retry.`,
        );
      }
      // The stale evidence said EMPTY and the live re-ask disagrees: the server does publish a
      // list for this input after all. That is exactly the hole the re-ask exists to find, and
      // it is worth its own message — the generic refusal below would report only that the
      // widget's own callback failed, sending the caller to look at their value while the
      // actionable fact is that a real list exists and they can pick from it.
      if (reAsked && staleDeclaredEmpty) {
        throw new Error(
          `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}): ` +
            `${latest.message} The schema that appeared to declare this input's option list ` +
            `empty was not fetched live, and the live re-read NO LONGER declares it empty — ` +
            // What was actually observed is a NEGATIVE: `serverDeclaresEmptyComboOptions`
            // returned false. That is true when the server publishes a real list, and equally
            // true when the re-read does not describe this input (or this type) at all. Saying
            // "the server DOES publish a list" picked one of those and asserted it as fact,
            // which is the same over-claim this change exists to remove, committed by the
            // message written to explain it. So the refusal states the observation and names
            // the possibilities rather than choosing one.
            `either it now publishes a real option list for this input, or it no longer ` +
            `describes this input at all. Either way the premise for an unvalidated write ` +
            `("the server itself says the valid set is empty") no longer holds. Refresh the ` +
            `node definitions and retry, fix the node's option callback so the list can be ` +
            `read, or set a value the server's list contains.`,
        );
      }
    }

    // No recovery succeeded — refuse honestly with the freshest rejection. The rejection's
    // own message says WHICH observation it rests on: a list that was read and does not
    // contain the value, or a list that could not be read at all. Nothing is appended
    // here suggesting a retry, because at this point there is no argument the caller can
    // add that changes the answer — the decision is the panel's observation, not theirs.
    throw new Error(
      `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type})` +
        `${typeof refreshCombos === "function" ? " after refreshing combo options" : ""}: ${latest.message}`,
    );
  }
}
