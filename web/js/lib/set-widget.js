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
// Post-write, inside the same synchronous boundary (#1282, #1932): refresh the
// node's dynamic input slots via its own "Update inputs"-style control when it
// exposes one, and rebuild generated custom-widget rows that view hidden
// backend widgets — disclosed on the success result, never thrown over a
// verified write.
// After that stretch returns, #1922 waits for a frontend flush (microtask + rAF)
// and re-reads the written widget: a just-added primitive can pass the immediate
// check and then be cleared by Vue mount / widget-store init. The first write is
// re-applied once after that overwrite; if it still does not hold, the call
// refuses instead of reporting success.

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
import { isTypeScopedObjectInfo } from "./scoped-object-info.js";
import { linkDrivenWidgets, drivenTag } from "./graph-read.js";
import { refreshDynamicInputsAfterWrite } from "./dynamic-inputs-refresh.js";
import { refreshCustomGeneratedWidgetsAfterWrite } from "./custom-generated-widgets-refresh.js";
import { REFRESH_JOIN_ABANDONED } from "./refresh-coalesce.js";
import {
  uploadInputConfig,
  uploadInputAccepts,
  addComboOption,
  serverDeclaresEmptyComboOptions,
  serverDeclaresRemoteComboOptions,
} from "./input-asset.js";

/**
 * Fire an undo-history hook that can never escape.
 *
 * Mirrors widget-write.js's own `safeBefore`/`safeAfter`: history bookkeeping is best-effort,
 * and a throwing `graph.onBeforeChange` / `onAfterChange` must never decide the outcome it is
 * merely bracketing. Used around the created-target cleanup, where an escaping OPEN would
 * skip the cleanup entirely (leaving the row and the row name it spent) and an escaping CLOSE
 * would replace the refusal the caller actually needs to read.
 */
function safeHistoryHook(hook) {
  try {
    hook?.();
  } catch {
    /* history hook is best-effort */
  }
}

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

/**
 * #1418 — what the panel's refreshCombos returns instead of REFRESH_JOIN_ABANDONED when the
 * abandoned wait STARTED NOTHING: the command's budget was already spent before the recovery
 * could begin (the seed wait and the authorization /object_info are drawn against it too),
 * so no node-def refresh is running and none is coming. REFRESH_JOIN_ABANDONED alone cannot
 * say this — the coalescer returns it both for "stopped waiting on a run that is still
 * going" and for "joinMs was already non-positive with an empty slot", and the refusal below
 * must not claim a refresh is running in the second case. The coalescer is deliberately NOT
 * changed to return this itself: graph_add_node reads REFRESH_JOIN_ABANDONED and its wording
 * is out of scope here, so the distinction is made by THIS command's wrapper, from the same
 * two facts the coalescer's decision is made from (the slot, and the bound), read BEFORE the
 * call so the two can never disagree.
 */
export const COMBO_REFRESH_NEVER_RAN = Symbol("combo-refresh-never-ran");

/**
 * #1922 — wait until a just-added node's frontend widget store has had a chance
 * to initialize.
 *
 * Vue DOM widgets (PrimitiveStringMultiline `value` is one) capture their empty
 * default at setup and write it back on mount, which lands on a microtask plus
 * the next animation frame. The immediate post-write check in applyWidgetWrite
 * therefore reports success, and a later init replaces the value with "".
 *
 * This is the smallest wait that observes that overwrite: one microtask, then
 * one animation frame when the host has rAF, then another microtask so a mount
 * that itself queues work is visible. No rAF in Node tests → two microtasks,
 * so existing runSetWidget tests do not hang or grow a timer.
 */
export function awaitFrontendWidgetFlush() {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => queueMicrotask(resolve));
      } else {
        queueMicrotask(resolve);
      }
    });
  });
}

function widgetValuesMatch(expected, actual) {
  if (
    (expected !== null && typeof expected === "object") ||
    (actual !== null && typeof actual === "object")
  ) {
    try {
      return JSON.stringify(expected) === JSON.stringify(actual);
    } catch {
      return false;
    }
  }
  return Object.is(expected, actual);
}

/**
 * #1413/#1418 — the refusal for a stale-combo recovery that never revalidated the value.
 *
 * RECOVERABLE BY CONSTRUCTION, and worded to say so — the same shape as #1192's
 * addNodeRefreshBusyMessage. What it must NOT say is "not a valid option": the revalidation
 * never completed, so this refusal cannot tell a genuinely-invalid value from one a refresh
 * would have accepted — and claiming the former is how a retryable busy reads as a permanent
 * rejection.
 *
 * `refreshStillRunning` is the panel's VERIFIED statement about the coalescer's slot, not a
 * guess (#1418): TRUE means a run is occupying it and still registering the very list this
 * write needs, so the retry joins work in progress. FALSE means the budget was spent before
 * the recovery could start and NO refresh is running — the retry rests on what is true in
 * that state: it re-enters the recovery with a fresh budget. Naming only the first state is
 * the false claim #1409 had to correct in refresh_nodes' own verdict ("a detail naming only
 * the first is flatly wrong on an uncontended big install").
 */
function staleComboRefreshRefusalMessage(refreshStillRunning) {
  const state = refreshStillRunning
    ? "the authoritative refresh that would have re-read the list — a node-def refresh " +
      "started by a ComfyUI reconnect, a finished install, or another tool call — was still " +
      "running when this command's time budget ran out waiting for it, so the revalidation " +
      "did NOT complete. That refresh is still running and is registering exactly the list " +
      "this write needs, so RETRY in a few seconds — this normally succeeds on the next " +
      "attempt, joining the work already in progress."
    : "the authoritative refresh that would have re-read the list never started: this " +
      "command's time budget was already spent (on the startup schema seed and the " +
      "authorization /object_info read) before the recovery could run. No node-def refresh " +
      "is running and none is coming. RETRY re-enters the recovery with a fresh budget and " +
      "normally succeeds once those reads answer faster — if this recurs, the schema read " +
      "itself is the slow part.";
  return (
    "the value is not in this combo's current option list, and " +
    state +
    " This refusal cannot tell a genuinely-invalid value from one the refresh would have " +
    "accepted. NOTHING WAS WRITTEN and nothing was changed. If it keeps happening, call " +
    "panel_refresh_nodes once and wait for it to report, then retry the write."
  );
}

/**
 * #1560 — the COMPLETE set of class types this write is about to be authorized against,
 * derived from the GRAPH with no schema and no I/O.
 *
 * This is what makes a type-scoped `/object_info` read answer the RIGHT question. The three
 * guards below ask about exactly these:
 *
 *   - `assertTypeAgainstFreshBackend` on the ULTIMATE CONCRETE target's type;
 *   - `assertMutatedNodeAuthorized` on the OUTER subgraph node's type;
 *   - `assertMutatedNodeAuthorized` on EVERY intermediate container's type;
 *   - and the #612 not-promoted diagnosis, on the outer node's type again.
 *
 * MEASURED, not reasoned: driving the real helpers on the nested A→B→KSampler shape the #458
 * suite uses returns SubgraphA / SubgraphB / KSampler with nothing fetched. That is the
 * "TWO types for a promoted write" the oracle's header warns about, named up front instead of
 * discovered after the fetch.
 *
 * A SUPERSET IS SAFE; A SUBSET IS A REFUSAL, NEVER A WRONG ANSWER. An extra type costs one
 * ~3KB request. A missing one is a type the returned map was not asked to cover, and reading
 * it throws rather than reporting it absent — which is the #716/#821 failure this exists to
 * make impossible.
 */
export function scopedAuthorizationTypes(node, promotedResolution, isResolvedPromotion, resolveSource) {
  const types = [];
  const push = (t) => {
    if (typeof t === "string" && t !== "" && !types.includes(t)) types.push(t);
  };
  push(node?.type);
  if (isResolvedPromotion) {
    // Both helpers walk injected, caller-supplied link data and can throw on a malformed or
    // cyclic promotion. An incomplete list must never be returned as though it were the whole
    // set, so a throw yields NOTHING and the scoped read is simply not attempted — the write
    // then refuses on the unchanged path below.
    try {
      push(followPromotionToConcrete(promotedResolution.target, resolveSource)?.node?.type);
      for (const intermediate of collectPromotionIntermediates(promotedResolution.target, resolveSource)) {
        push(intermediate?.type);
      }
    } catch {
      return [];
    }
  }
  return types;
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
    //   "scoped"       #1560's TYPE-SCOPED read stood in while both whole-map probes were
    //                  silent. It is the server answering NOW, but only about the handful of
    //                  types this write resolves to — so it can authorize a type and it
    //                  cannot answer anything that ranges over the install
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
    // #1560 — the LAST-RESORT, TYPE-SCOPED route: `(types) => { defs, covered, reason }`,
    // asking the backend about EXACTLY the class types this write is about to be authorized
    // against, one `/object_info/<Type>` request each.
    //
    // Consulted ONLY when the whole-map oracle AND #1223's snapshot have both produced
    // nothing — on a ~1023-model install the whole dump never lands inside any budget, so
    // the snapshot is never populated and every write refuses for the LIFE OF THE TAB.
    //
    // It is wired here rather than inside `getFreshObjectInfo` for a reason the oracle's own
    // header names: a per-class payload "answers one question and reads the other as absent
    // (#716/#821)", and the set of questions is only known once the promotion has been
    // resolved — which happens BELOW the fetch. By the time this is called the outer node,
    // every intermediate and the ultimate concrete target are all known, so the map can be
    // asked to cover all of them and to THROW for anything else (see scoped-object-info.js).
    //
    // The panel gates it on the SAME `noBackendAnswerEstablished` licence #1223's snapshot
    // uses, so a client that ANSWERED deny-all is never overruled by a broader per-class read.
    fetchScopedObjectInfo,
    // #757 — SYNCHRONOUS target preparation. Some write targets do not exist until
    // something creates them (an rgthree Power Lora Loader `lora_N` row is minted only by
    // the node's own method), and the creation is a graph MUTATION. Injected here, rather
    // than done by the caller before this function, so the mutation lands at the write
    // boundary below where NO await follows it — see the note at `write`.
    prepareWriteTarget,
    // #1922 — wait for the frontend widget store / Vue mount to finish before
    // treating a verified write as retained. Production uses awaitFrontendWidgetFlush;
    // unit tests inject a flush that reproduces the later empty overwrite.
    awaitFrontendWidgetFlush: awaitFrontendWidgetFlushInjected,
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
        p === "scoped" ||
        p === "none"
        ? p
        : "unknown";
    } catch {
      return "unknown";
    }
  };
  /**
   * The provenance of THE MAP THIS DECISION IS ABOUT — asked of the PAYLOAD first, and only
   * then of the stamp.
   *
   * `readSchemaProvenance` deliberately holds the QUESTION rather than an answer, because a
   * verdict computed before an await can be superseded during it (#1126). That is right for
   * the whole-map routes and WRONG for #1560's type-scoped one, because the ladder below
   * re-asks the panel for a live map: the re-ask re-enters the panel's shared
   * `readObjectInfo`, which re-stamps the provenance on EVERY exit path it has. So a FAILED
   * re-ask — the normal case on an install whose whole map never lands — overwrites "scoped"
   * with "none" while `authDefs` is still the scoped map. The branch keyed on "scoped" then
   * never fires, and what fires instead tells the caller the provenance could not be
   * established AT ALL and to reconnect: false twice over, since a type-scoped read did
   * answer, live, moments earlier, and reconnecting cannot help a backend whose whole map
   * never arrives. That is the misattribution class #982/#1223 exist to stop, committed by
   * the change written to extend them.
   *
   * #1223's OWN snapshot branch was dead code for the same reason once — `node-resolve.js`'s
   * suite records it — so this is that defect one field over, and the reason the answer is
   * not simply a second stamp captured earlier: a brand belongs to the very object being
   * ruled on, so when the re-ask DOES replace `authDefs` with a whole live map this answers
   * for the NEW payload with no flag anyone has to remember to clear.
   */
  const provenanceOf = (defs) => (isTypeScopedObjectInfo(defs) ? "scoped" : readSchemaProvenance());
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
  // The whole-schema reader may return a retired/reconnected payload to explain why the
  // request was superseded. That payload is not current authority: refuse it before any
  // type guard can mistake its old membership for a live backend answer. The explicit
  // wording keeps the provenance diagnosis actionable, while the panel's scoped fallback
  // remains unavailable because the superseded whole response did not establish current
  // silence.
  if (freshDefs && typeof schemaProvenance === "function") {
    const provenance = readSchemaProvenance();
    if (provenance === "reconnected") {
      throw new Error(
        `panel_set_widget refused "${widgetName}" on node ${node?.id}: the backend RECONNECTED ` +
          `while that /object_info request was in flight, so the answer describes a process ` +
          `that has since been replaced and did not come from the server answering now. ` +
          `Refusing to write rather than trust a possibly-stale node schema (#1126).`,
      );
    }
    if (provenance === "retired") {
      throw new Error(
        `panel_set_widget refused "${widgetName}" on node ${node?.id}: the panel REFRESHED ` +
          `the node definitions while that /object_info request was in flight, so the answer ` +
          `was superseded before it arrived and the refresh may be what filled this list. ` +
          `It did not come from the server answering now; refusing to write rather than trust ` +
          `a possibly-stale node schema (#1126).`,
      );
    }
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

  // #1560 — LAST RESORT: ask the backend about EXACTLY the types this write needs.
  //
  // Reached only when the whole-map oracle returned nothing AND #1223's snapshot could not
  // stand in — on the reported install that is EVERY call, forever, because the whole dump
  // never lands and so the snapshot is never populated. Reproduced by execution before this
  // was written: two hung whole-map routes, zero per-class requests ever issued, the widget
  // never written, the identical refusal 15,015 ms later on the second call.
  //
  // PLACED HERE, BELOW THE RESOLUTION, WHICH IS THE WHOLE POINT. The oracle's header rejects
  // the per-class route for this fence because "set_widget authorizes two types for a
  // promoted write and fetches BEFORE resolving which target it writes to, so a single-class
  // payload answers one question and reads the other as absent (#716/#821)". By this line the
  // promotion HAS been resolved — purely, with no schema and no I/O (measured: the real
  // resolution helpers produce SubgraphA / SubgraphB / KSampler for a nested A→B→KSampler
  // write with nothing fetched at all) — so the request can name all of them and the map it
  // returns THROWS for any type outside that set instead of reading it as absent.
  //
  // The primary fetch above deliberately did NOT move. Resolving before it was tried and
  // passes the whole unit suite, but it would make the resolution older by up to a full
  // budget on every healthy call to buy something only this path needs.
  //
  // WHAT THE AWAIT THIS ADDS DOES AND DOES NOT COST — stated exactly, because the first
  // version of this note claimed the scope trap guarded all of it, and it does not.
  //
  // The trap catches ONE of the two shapes: a promotion relinked mid-fetch that resolves
  // deeper to a concrete node of a DIFFERENT type asks the map about a type it was never
  // given, so it throws and the write refuses. A relink to a node of the SAME type is NOT
  // caught, and does not need to be — the type authorization is still true of the node
  // actually driven.
  //
  // What is genuinely older is `promotedResolution`, captured just above: `authTarget` and
  // every guard below are still computed AFTER this await, exactly as they are after the
  // whole-map fetch today, but the IMMEDIATE write target now predates one more await. So a
  // caller who re-promotes a widget during this window can have the write land on the node
  // the promotion pointed at when the command was resolved. That is a stale-target hazard,
  // never a fail-open of the #458 fence: whatever is written is still registry-checked
  // (`assertResolvedTargetRegistered`), still type-authorized against a live backend, and
  // still fenced to the active workflow (`assertTargetStillCurrent`, re-checked synchronously
  // inside `write` with no await after it).
  //
  // The window is this read alone — measured at 1.2 ms per class on this repo's own rig
  // (#767), 15 ms in the reproduction — on a path where the alternative is a refusal that
  // never succeeds. That is the trade, and it is taken deliberately.
  //
  // Skipped entirely for a promoted-but-unresolvable write: nothing consults freshDefs on
  // that path, so a request would only add latency to a refusal that is already decided.
  let scopedIneligibility = "";
  if (!freshDefs && !promotedButUnresolvable && typeof fetchScopedObjectInfo === "function") {
    let scoped = null;
    try {
      scoped = await fetchScopedObjectInfo(
        scopedAuthorizationTypes(node, promotedResolution, isResolvedPromotion, resolveSource),
      );
    } catch {
      // A last-resort route must never replace the refusal it was trying to avoid.
      scoped = null;
    }
    if (scoped && scoped.defs) freshDefs = scoped.defs;
    else if (scoped && typeof scoped.reason === "string" && scoped.reason) scopedIneligibility = scoped.reason;
  }
  // The refusal has to be able to say what the THIRD route did. Kept OUT of the transport
  // list `objectInfoOracleFailureNote` renders — that array is what the two whole-map routes
  // reported, and splicing a non-route entry into it makes a two-transport failure claim
  // three routes tried, which is #982's own defect.
  //
  // SAYS WHAT THIS SITE KNOWS, WHICH IS NOT WHETHER A REQUEST WAS ISSUED (#1573). All this
  // line has is a non-empty `reason`, meaning the type-scoped route produced no usable map;
  // the reason itself says why, and only SOME of the reasons involve a request. An earlier
  // wording led with "A type-scoped /object_info read was tried too", which asserted an
  // attempt on every one of them — REPRODUCED BY EXECUTION against the merged head: with the
  // panel's own unlicensed reason ("no whole-schema route was both CONTACTED and SILENT…")
  // the refusal claimed a read "was tried" while `perClassCalls()` was EMPTY, not one request
  // issued. That is the #982 shape — the clause after the dash self-corrects, but a reader
  // stops at the lead-in and goes looking for a request that never left. So the lead-in
  // reports the OUTCOME (it did not stand in) and lets the reason report the cause.
  //
  // The condition below is byte-for-byte what it was; nothing about WHEN this fires changed.
  const describeObjectInfoFailureWithScope = () => {
    let base = "";
    try {
      base = typeof describeObjectInfoFailure === "function" ? describeObjectInfoFailure() || "" : "";
    } catch {
      base = ""; // a diagnostic must never replace the refusal it is describing
    }
    if (!scopedIneligibility) return base;
    return `${base} A type-scoped /object_info read did not stand in for the whole-schema routes either — ${scopedIneligibility}.`;
  };
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
      describeObjectInfoFailure: describeObjectInfoFailureWithScope,
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
    // #757 — CREATE A MISSING TARGET HERE, INSIDE THE SAME SYNCHRONOUS STRETCH.
    //
    // A target that must be minted before it can be written (an rgthree `lora_N` row) used
    // to be created by the CALLER, before `runSetWidget` was even entered. That put a live
    // graph mutation on the far side of `await getFreshObjectInfo()`, and everything that
    // went wrong with this feature came from that one gap:
    //   - the row sat in the graph across a network request, so any ChangeTracker capture
    //     in that window recorded a transient row and split the command's undo in two;
    //   - a user hand-editing the node during the window could have their edit rolled back
    //     by a failure that had nothing to do with them — losing a manual edit is worse
    //     than the missing-widget refusal this feature exists to remove;
    //   - a concurrent command frame could write the row and be told it succeeded, only
    //     for the original call's rollback to delete it.
    // Placed here, none of those windows exist: `applyWidgetWrite` is synchronous, so
    // nothing — no other command frame, no user gesture, no user edit — can run between the
    // creation, the write and the undo below. The guards those three defects each needed
    // are removed rather than kept, because the interleaving they defended against is now
    // unreachable. (The one thing that DOES happen in between is applyWidgetWrite's own
    // history capture, which is the same one every ordinary write takes — see below.)
    //
    // AFTER the fence, so a workflow switch during the fetch refuses before the mutation.
    // Called once per attempt and expected to be idempotent: the stale-combo and upload
    // retries re-enter `write`, and by then the target it created already exists.
    //
    // THE CLEANUP GETS ITS OWN ENVELOPE, AND THE WRITE KEEPS ITS OWN VERIFICATION ORDER.
    //
    // An earlier version wrapped preparation, write and cleanup in ONE outer envelope so that
    // a refused creating write took no capture until the very end. That inverted something
    // load-bearing. `applyWidgetWrite` deliberately verifies AFTER its own afterChange has
    // fired — see widget-write.js: "an afterChange hook can itself re-stale a widget or
    // change the promotion topology, and that must be caught too". Nesting its envelope
    // inside another one means its close never reaches zero, so the CAPTURE — and every pack
    // `serializeValue` that the capture's serialization runs — happens after the last
    // verification. An rgthree loader in Separate Model & Clip mode rewrites
    // `strengthTwo: null` to 1 exactly there, and the creating path then reported plain
    // success for a value an EXISTING-row write would have reported as normalized.
    //
    // THE ASYMMETRY WAS THE TELL. Creation must report whatever an ordinary write reports for
    // the same value, and the only way it can is by being verified the same way. So
    // applyWidgetWrite is called with nothing wrapped around it, exactly as every other write
    // path calls it, and only the CLEANUP is bracketed.
    //
    // What the cleanup's own envelope buys is the sound half of that earlier finding: the
    // NEWEST capture is the graph as it really finished, instead of a row-present snapshot of
    // a command that was refused.
    //
    // WHAT IT DELIBERATELY DOES NOT BUY, because no write path can: a refused write is not a
    // no-op in the undo history. applyWidgetWrite captures its write, then captures its
    // rollback in a second envelope of its own, so an ORDINARY refused write already leaves
    // two snapshots a Ctrl+Z can step back into. A refused creating write now leaves three and
    // behaves the same way. Suppressing those intermediate captures is only reachable by
    // holding one envelope across the verification — i.e. by reintroducing the defect above.
    // Symmetry with the ordinary write is the property worth having; being better than the
    // shared write path is not on offer, and pretending otherwise is what cost a round.
    const prepared = typeof prepareWriteTarget === "function" ? prepareWriteTarget() : null;
    try {
      const set = applyWidgetWrite(node, widgetName, value, {
        resolveSource,
        canvas,
        beforeChange,
        afterChange,
        setDirty,
        assertTargetWritable: (targetNode) => assertResolvedTargetRegistered(liveRegistry(), targetNode),
        promotedResolution,
        ...extra,
      });
      // #1282 — REFRESH DYNAMIC INPUT SLOTS after the write, on the node the write
      // landed on, inside the SAME synchronous stretch (no await since the fence, so
      // the press cannot interleave with a workflow switch or another command frame).
      //
      // The write already fired the widget's own callback the way an interactive edit
      // does — with the canvas argument — and KJNodes' *Multi nodes take that exact
      // argument as the deliberate tell to SKIP their slot rebuild (scrubbing a count
      // must not reflow the node under the user's cursor; their `setupDynamicInputs`
      // rebuilds only on a bare, canvas-less invocation). Their deferred rebuild lives
      // behind the node's own "Update inputs" button, so a verified write to
      // `inputcount` reported success while image_3… never came into existence and
      // every follow-up read served the stale slot list. Pressing that control after
      // the write is the same gesture the interactive user performs, it is idempotent
      // (a no-op when the slots already match), and it is verified by its EFFECT —
      // a control that accepts the call and changes nothing is never reported as a
      // refresh. See lib/dynamic-inputs-refresh.js for the keying and why it is not
      // a node-type list.
      //
      // Runs AFTER applyWidgetWrite's own verification, so the write's verdict never
      // depends on the refresh; a refresh failure is DISCLOSED on the success result,
      // never thrown over a verified write. The press runs inside its own
      // before/afterChange bracket so the slot changes join the command's undo
      // history.
      const targetNode = resolvedTargetNode ?? node;
      const refresh = refreshDynamicInputsAfterWrite(targetNode, {
        canvas,
        beforeChange,
        afterChange,
        setDirty,
      });
      // #1932 — REBUILD GENERATED CUSTOM WIDGETS after the write. Deno Multi LoRA
      // (and the LTX sibling) hide the backend widgets panel_set_widget writes and
      // draw serialize:false custom rows on top. Their redraw() only dirties the
      // canvas, so active_loras 1→3 reported success while the visible rows/height
      // stayed at 1 until the subgraph was left and re-entered. Keyed on that
      // pattern, not a node-type list — see lib/custom-generated-widgets-refresh.js.
      // Same containment as the #1282 press: a rebuild failure is DISCLOSED on
      // the success result, never thrown over a verified write.
      const generated = refreshCustomGeneratedWidgetsAfterWrite(targetNode, {
        canvas,
        beforeChange,
        afterChange,
        setDirty,
      });
      let out = set;
      if (refresh?.failed) {
        out = {
          ...out,
          dynamic_inputs_refresh_failed: refresh.failed,
          ...(refresh.inputs ? { dynamic_inputs: refresh.inputs } : {}),
        };
      } else if (refresh?.refreshed) {
        out = { ...out, dynamic_inputs_refreshed: true, dynamic_inputs: refresh.inputs };
      }
      if (generated?.failed) {
        return {
          ...out,
          generated_widgets_refresh_failed: generated.failed,
          ...(generated.widgets ? { generated_widgets: generated.widgets } : {}),
        };
      }
      if (generated?.refreshed) {
        return { ...out, generated_widgets_refreshed: true, generated_widgets: generated.widgets };
      }
      return out;
    } catch (err) {
      // The write refused over a target this attempt had just created. Undo it in the same
      // synchronous stretch, so the graph the refusal is reported over is the graph the
      // command started from — and so a retry below starts from a clean node rather than
      // finding a row it would then decline to create again.
      if (prepared) {
        // BOTH HOOKS ARE BEST-EFFORT, mirroring widget-write's own safeBefore/safeAfter. A
        // graph whose onBeforeChange throws must not cost us the cleanup — the row AND the
        // row name it spent would be left behind while an error was returned. And a throwing
        // close must never replace the refusal that is the entire reason we are here: the
        // caller needs to know why its write was rejected, not that a history hook failed.
        safeHistoryHook(beforeChange);
        try {
          // An undo that could NOT put everything back RETURNS A STRING SAYING SO, and the
          // refusal carries it. Without this the caller hears only why the value was
          // rejected, while a resource the preparation consumed stays consumed — and the
          // obvious next move, retrying the corrected value under the same name, fails a
          // second time for a reason the first message never mentioned.
          //
          // Annotated IN PLACE rather than rethrown as a new error: the recovery paths below
          // dispatch on `instanceof WidgetWriteError` and on `.combo` / `.emptyOptions`, and
          // wrapping would strip all three and turn a retryable combo miss into a hard fail.
          const note = prepared.undo?.();
          if (typeof note === "string" && note && typeof err?.message === "string") {
            err.message = `${err.message} ${note}`;
          }
        } catch {
          /* an undo that fails must never replace the refusal that caused it */
        } finally {
          safeHistoryHook(afterChange);
        }
      }
      throw err;
    }
  };

  const flushFrontendWidgets =
    typeof awaitFrontendWidgetFlushInjected === "function"
      ? awaitFrontendWidgetFlushInjected
      : awaitFrontendWidgetFlush;

  function readLiveWritten(set) {
    // For an instance-scoped promoted write, the host rail selected during the
    // authorization pass is the value the frontend serializes. Do not re-find a
    // same-named widget by list order: a stale/link-driven projection can remain
    // in `node.widgets` during a promotion rebind and otherwise make retention
    // checking validate the wrong value after the real rail was updated (#366).
    const promotedRail =
      isResolvedPromotion &&
      set?.promoted_from?.value_scope === "instance"
        ? promotedResolution?.target?.parentWidget
        : null;
    if (promotedRail) {
      try {
        return { found: true, value: promotedRail.value };
      } catch {
        return { found: false, value: undefined };
      }
    }
    const hosts = [node, resolvedTargetNode, authTarget].filter(Boolean);
    const prefer = hosts.filter((host) => host.id === set?.node_id);
    const rest = hosts.filter((host) => host.id !== set?.node_id);
    for (const host of [...prefer, ...rest]) {
      const live = host.widgets?.find((candidate) => candidate?.name === set?.widget);
      if (live) return { found: true, value: live.value };
    }
    return { found: false, value: undefined };
  }

  function widgetStillHolds(set) {
    const live = readLiveWritten(set);
    return live.found && widgetValuesMatch(set?.value, live.value);
  }

  /**
   * #1922 — applyWidgetWrite verifies synchronously. A just-added primitive's
   * Vue/widget-store init can still replace the value on the next frame, so a
   * success here would be a lie. Wait for that flush; if the value vanished,
   * write once more (the init has now run, which is why the reporter's second
   * call stuck); if it still does not hold, refuse.
   */
  async function retainVerifiedWrite(set, rewrite) {
    await flushFrontendWidgets();
    assertTargetStillCurrentNow();
    if (widgetStillHolds(set)) return set;
    const retried = rewrite();
    await flushFrontendWidgets();
    assertTargetStillCurrentNow();
    if (widgetStillHolds(retried)) return retried;
    const live = readLiveWritten(retried);
    throw new WidgetWriteError(
      `Widget "${retried?.widget}" on node ${retried?.node_id} (${node?.type}) did not retain the ` +
        `requested value after the frontend widget store initialized: wrote ${JSON.stringify(retried?.value)} ` +
        `but it became ${JSON.stringify(live.found ? live.value : undefined)}. ` +
        `Nothing is being reported as success. Retry panel_set_widget now that the node is on the canvas.`,
    );
  }

  async function succeedWrite(extra = {}, extraResult = {}) {
    const set = await retainVerifiedWrite(write(extra), () => write(extra));
    return withWarning({ set, ...extraResult });
  }

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
    return await succeedWrite();
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
      // #1413 — the panel bounds this wait by the command's remaining budget, and a bound
      // that runs out is reported back as a STRUCTURED TOKEN (REFRESH_JOIN_ABANDONED), not
      // a throw — the catch below is the best-effort channel and would swallow one. The
      // in-flight refresh is not cancelled by the abandonment; only THIS caller's wait ends.
      // #1418 — COMBO_REFRESH_NEVER_RAN is the same abandonment with one fact flipped: the
      // budget was spent before the recovery could begin, so NO refresh is running. The
      // refusal below words the two states differently because the retry advice that is
      // true for one ("join the work in progress") is false for the other.
      let refreshAbandoned = null;
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
        const refreshOutcome = await refreshCombos(freshDefs ?? undefined, resolvedTargetNode, authTarget?.type, comboNameMap);
        if (refreshOutcome === REFRESH_JOIN_ABANDONED || refreshOutcome === COMBO_REFRESH_NEVER_RAN) {
          refreshAbandoned = refreshOutcome;
        }
      } catch {
        /* refresh best-effort; fall through to re-raise the original rejection */
      }
      // #1413 — the refresh never re-read the list, so the retry CANNOT be trusted: it
      // would re-fail against the same stale snapshot and the refusal would call the
      // value "not a valid option" — a false cause for a retryable busy, and the exact
      // report this issue exists to replace. Refuse IN WORDS instead, before the retry
      // and before the upload probe: the budget that ran out is the command's, and an
      // unbounded /view probe after it would reopen the relay-window overrun the bound
      // just closed. On the retry the refresh has usually landed, so the value then
      // takes the ordinary path — accepted against the fresh list, or probed, or refused
      // for a reason that is true. A PARTIAL first write is the one case that outranks
      // this wording: its own error reports a graph that could not be restored, and that
      // must propagate undiluted rather than be replaced by "nothing was written".
      if (refreshAbandoned) {
        throw refusalFrame(
          err.partialWrite
            ? err
            : new Error(staleComboRefreshRefusalMessage(refreshAbandoned === REFRESH_JOIN_ABANDONED)),
        );
      }
      try {
        return await succeedWrite({}, { refreshed: true });
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
        return await succeedWrite({}, { refreshed: true, server_confirmed: true });
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
      return await succeedWrite(
        { acceptEmptyComboOptions: true },
        {
          ...(typeof refreshCombos === "function" ? { refreshed: true } : {}),
          empty_option_list: true,
        },
      );
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
      let provenance = provenanceOf(freshDefs ?? undefined);
      let authDefs = freshDefs ?? undefined;
      // What the PRIOR evidence claimed, captured before it is replaced — the difference
      // between "the server publishes a list, as it always did" and "the schema in hand said
      // empty and the re-read disagrees" is the whole point of re-asking, and it cannot be
      // recovered after `authDefs` is overwritten.
      //
      // "PRIOR", NOT "STALE" (#1573). This used to be called `staleDeclaredEmpty`, and the
      // refusal it feeds told the caller the schema "was not fetched live". That premise
      // predates #1560: the gate above is `provenance !== "live"`, and "scoped" is not
      // "live" — but a type-scoped map WAS fetched live, per class, moments earlier. It is
      // about fewer types, never about older ones. REPRODUCED BY EXECUTION on the merged
      // head: a scoped map declaring this input's list empty, a whole-map re-ask that
      // publishes a real list, and the refusal below asserting the scoped read "was not
      // fetched live" while `/object_info/<Type>` sat in the issued-request list. All this
      // line establishes is WHICH schema said empty — the one held before the re-ask — so
      // that is all the name and the message may claim.
      const priorDeclaredEmpty = serverDeclaresEmptyComboOptions(authDefs, authTarget?.type, comboDefInput);
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
        provenance = provenanceOf(authDefs);
      }
      // #1560 — a TYPE-SCOPED map is the server answering NOW, but only about the handful of
      // types this write resolves to. It can authorize the node type; it even holds this
      // input's own option list. It still may not license the blind write: the whole-schema
      // probes went silent, so nothing establishes that the panel is looking at the CURRENT
      // install rather than at one class of it, and widening a last-resort unvalidated write
      // on a partial view of the schema is the one thing this route was built not to do.
      //
      // DECIDED HERE, ABOVE the empty-list shape test, and that placement is the fix rather
      // than a tidy-up. Below it this branch is unreachable in BOTH directions: when the
      // scoped map declares the list EMPTY the shape test fires first and refuses with a
      // message about a provenance that "could not be established at all" — false, a
      // type-scoped read answered — and when it declares a NON-empty list the ladder falls
      // through to the generic end-of-ladder refusal, which sends the caller to look at their
      // value while the actual cause is a backend whose whole map never lands. Verified by
      // execution, not by reading: with this branch deleted the whole suite stayed green,
      // which is what dead code looks like from inside a passing test run.
      // NARROWER THAN IT FIRST READ, deliberately. An earlier wording said a scoped map is
      // "not enough to license an unvalidated write, whether or not it shows this input's
      // list as empty" — and that over-claims, because #507's branch above DOES accept one.
      // The two cases are not the same observation and the asymmetry is correct:
      //
      //   - #507: the widget's OWN list read as EMPTY and the schema says empty too. Two
      //     agreeing observations, and the per-class def is the live server answer for this
      //     class — byte-identical to the whole map's entry for it (measured on 0.33.2). That
      //     branch already accepts `cache`/`reconnected`/`retired` whole maps, all of them
      //     older than this one.
      //   - HERE: the widget's own list could not be READ AT ALL, so the schema is the only
      //     witness there is. Standing in for the sole witness is a stronger claim than
      //     agreeing with a second one, and a partial view of the install may not make it.
      if (provenance === "scoped") {
        throw new Error(
          `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}): ` +
            `${latest.message} The panel could have written it unvalidated if a WHOLE ` +
            `/object_info declared this input's option list empty — but both whole-schema ` +
            `probes went silent, so the only schema available is a TYPE-SCOPED read (#1560) ` +
            `covering just the node types this write resolves to. That is enough to authorize ` +
            `the node type. It is not enough to stand in for a list the panel could not read ` +
            `at all, which is the one thing that would license THIS write. This is NOT a ` +
            `stale or unreadable schema and reconnecting need not help: wait for /object_info ` +
            `to answer as a whole again, then retry.`,
        );
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
          set = await retainVerifiedWrite(
            write({ acceptUnreadableComboOptions: true, acceptEmptyComboOptions: true }),
            () => write({ acceptUnreadableComboOptions: true, acceptEmptyComboOptions: true }),
          );
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
      // The evidence held BEFORE the re-ask said EMPTY and the re-ask disagrees: the server
      // does publish a list for this input after all. That is exactly the hole the re-ask
      // exists to find, and it is worth its own message — the generic refusal below would
      // report only that the widget's own callback failed, sending the caller to look at
      // their value while the actionable fact is that a real list exists and they can pick
      // from it.
      //
      // WHAT THE LEAD-IN MAY CLAIM (#1573). It used to say that schema "was not fetched
      // live". Since #1560 that is reachable and FALSE: a type-scoped map is fetched live,
      // per class, and is exactly the kind of schema that lands here. What this branch
      // actually establishes is that the schema which said empty has been REPLACED and the
      // replacement no longer says it — nothing about how the first one was obtained, which
      // is why the sentence no longer mentions it.
      if (reAsked && priorDeclaredEmpty) {
        throw new Error(
          `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type}): ` +
            `${latest.message} The schema that appeared to declare this input's option list ` +
            `empty has since been REPLACED, and the live re-read NO LONGER declares it empty — ` +
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

    // #1696 — a live remote combo can expose no local values while /object_info correctly says
    // that its source is a separate fetch. The generic `latest.message` below was written for
    // a stale local empty list and therefore tells the caller to refresh the same thing again,
    // while also claiming a fact the remote schema never established. Preserve the refusal, but
    // report the source and uncertainty that actually blocked validation.
    if (
      latest?.emptyOptions &&
      serverDeclaresRemoteComboOptions(
        freshDefs ?? undefined,
        authTarget?.type,
        concreteWidgetName ?? writeTargetWidgetName ?? widgetName,
      )
    ) {
      throw new Error(
        `panel_set_widget refused "${widgetName}" on node ${node?.id} (${node?.type})` +
          `${typeof refreshCombos === "function" ? " after refreshing combo options" : ""}: ` +
          `[combo_source=remote; option_list=unavailable; verdict=unknown] The server schema ` +
          `exposes a REMOTE option source for this input, so the valid option set is not ` +
          `currently enumerable by the panel. The requested value was not validated. ` +
          `NOTHING WAS WRITTEN. Make the remote model list available and retry.`,
      );
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
