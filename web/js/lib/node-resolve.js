// Node-type resolution guard for the graph WRITE tools (#458).
//
// The panel's write tools (graph_add_node / graph_set_widget) must resolve node
// types against the REAL LiteGraph registry that ComfyUI populates from
// /object_info — and FAIL LOUDLY when a type can't be resolved, exactly like the
// read tools hard-error. The bug this fixes: with ComfyUI's backend unreachable
// the node definitions never load, so:
//   * graph_add_node let LiteGraph mint a generic PLACEHOLDER node
//     (in0/out0/type '*', widgets {value:0,text:""}) and reported it as a real,
//     resolved add — byte-identical for every class_type asked for; and
//   * graph_set_widget then "set" a widget that placeholder does not really have.
// Net: an autonomous agent wires up and reports a workflow that does not exist,
// with every signal saying success. These pure predicates are the gate; they are
// extracted here so the SAME branching the handlers run is unit-testable.

// Well-known ComfyUI CORE node classes. Their presence in the live registry is a
// reliable signal that /object_info was fetched and the backend node definitions
// were registered. If NONE are present, the defs never loaded (the backend is
// unreachable), which we surface distinctly from a genuine unknown-type.
export const COMFY_CORE_SENTINEL_TYPES = [
  "KSampler",
  "CheckpointLoaderSimple",
  "CLIPTextEncode",
  "VAEDecode",
  "VAELoader",
  "EmptyLatentImage",
  "LoadImage",
  "SaveImage",
];

import { importFailureNote, relevantPackImportFailures } from "./pack-import-failures.js";
import { isFrontendVirtualRegisteredType } from "./virtual-registry.js";

/** True when `type` is registered in the live LiteGraph registry object
 *  (LG.registered_node_types). */
export function isRegisteredNodeType(registry, type) {
  if (!registry || typeof type !== "string") return false;
  return Object.prototype.hasOwnProperty.call(registry, type);
}

// RFC-4122 UUID — ComfyUI mints these as subgraph *type* ids. Backend class_types
// are human-readable names; a well-formed UUID is therefore not a missing pack.
export const SUBGRAPH_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isSubgraphUuidType(type) {
  return typeof type === "string" && SUBGRAPH_UUID_RE.test(type);
}

function subgraphRegistryHas(reg, type) {
  if (!reg || type == null) return false;
  try {
    if (typeof reg.has === "function" && reg.has(type)) return true;
    if (typeof reg.get === "function" && reg.get(type)) return true;
    if (
      typeof reg === "object" &&
      !Array.isArray(reg) &&
      Object.prototype.hasOwnProperty.call(reg, type)
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Positive proof the live workflow already holds this subgraph definition.
 *
 * Prefers the root graph's `subgraphs` registry (uuid → Subgraph Map on real
 * LiteGraph builds), then walks nested instances. Fail closed on anything
 * unreadable — a guess here would authorize LiteGraph to mint a placeholder.
 */
export function subgraphTypeIsLoaded(rootGraph, type) {
  if (!isSubgraphUuidType(type) || !rootGraph || typeof rootGraph !== "object") return false;
  try {
    if (subgraphRegistryHas(rootGraph.subgraphs, type)) return true;
    const seen = new WeakSet();
    const walk = (graph) => {
      if (!graph || typeof graph !== "object" || seen.has(graph)) return false;
      seen.add(graph);
      if (graph.id != null && String(graph.id) === type) return true;
      if (subgraphRegistryHas(graph.subgraphs, type)) return true;
      for (const node of graph._nodes ?? graph.nodes ?? []) {
        if (!node || typeof node !== "object") continue;
        if (typeof node.type === "string" && node.type === type) return true;
        const sub = node.subgraph;
        if (sub && (String(sub.id) === type || walk(sub))) return true;
      }
      return false;
    };
    return walk(rootGraph);
  } catch {
    return false;
  }
}

function subgraphDefinitionLoaded(class_type, opts) {
  if (!opts || typeof opts !== "object") return false;
  if (typeof opts.isLoadedSubgraphType === "function") {
    try {
      return opts.isLoadedSubgraphType(class_type) === true;
    } catch {
      return false;
    }
  }
  let root = null;
  try {
    root = typeof opts.getRootGraph === "function" ? opts.getRootGraph() : opts.getRootGraph;
  } catch {
    root = null;
  }
  return subgraphTypeIsLoaded(root, class_type);
}

/**
 * The refusal `assertAddNodeResolvableRefreshing` throws for a UUID class_type
 * that is not both loaded in the live workflow and registered in LiteGraph.
 * Exported so tests drive this wording rather than restating it.
 */
export function subgraphUuidAddRefusal(class_type, { loaded = false, registered = false } = {}) {
  const what =
    loaded && !registered
      ? `This workflow already has that subgraph definition loaded, but this tab has not ` +
        `registered the class LiteGraph needs to construct a new instance — copy an existing ` +
        `instance on the canvas rather than adding by type.`
      : `Subgraph definitions live in the workflow (or the subgraph library), never in ` +
        `/object_info. Copy an existing instance if one is on the canvas, or list library ` +
        `blueprints with panel_list_subgraphs and add with panel_add_subgraph.`;
  return (
    `Cannot add "${class_type}": it is a subgraph type, not a ComfyUI backend node — ` +
    `the backend never lists subgraph UUIDs in /object_info. ${what} ` +
    `Refusing to add rather than let LiteGraph mint an unresolved placeholder node (#1523).`
  );
}

/** True once ComfyUI's backend node definitions have been registered (i.e.
 *  /object_info loaded). False means the backend is unreachable / defs unloaded,
 *  so no Comfy class_type can be resolved and writes must fail rather than
 *  synthesize a placeholder. */
export function comfyNodeDefsLoaded(registry) {
  if (!registry) return false;
  return COMFY_CORE_SENTINEL_TYPES.some((t) =>
    Object.prototype.hasOwnProperty.call(registry, t),
  );
}

// POSITIVE allowlist of genuinely FRONTEND-ONLY / native node types — nodes that a
// frontend extension (or litegraph itself) registers WITHOUT any /object_info-derived
// backend def BY DESIGN. This is the load-bearing #458-safe marker: absence of
// `nodeData` ALONE is NOT a safe signal, because a REMOVED backend pack can leave a
// DEFLESS husk registered in the frontend (e.g. its JS registered a bare class, or a
// replacement stripped nodeData) — trusting "defless" there would fabricate success on
// a node the backend no longer defines (the exact #458 hole). Membership here is the
// POSITIVE signal that distinguishes a genuine frontend-native from a removed-backend
// husk. A type NOT on this list that is absent from fresh /object_info still FAILS
// CLOSED, even if its registered class is defless. New frontend-only nodes must be
// added here explicitly (safe default = refuse). rgthree's Power Lora Loader / Context
// are NOT here — they DO have backend defs, so a removed one must still fail closed.
export const FRONTEND_ONLY_NODE_TYPES = new Set([
  // ComfyUI / litegraph native frontend nodes (no backend def by design).
  "Note",
  "MarkdownNote",
  "Reroute",
  "PrimitiveNode",
  // rgthree FRONTEND-ONLY control nodes (bypass/mute toggles, labels, reroutes) — pure
  // litegraph, never enumerated by /object_info.
  "Fast Bypasser (rgthree)",
  "Fast Muter (rgthree)",
  "Fast Groups Bypasser (rgthree)",
  "Fast Groups Muter (rgthree)",
  "Label (rgthree)",
  "Reroute (rgthree)",
  "Node Collector (rgthree)",
  // KJNodes' frontend-only Get/Set bus nodes (also reported with rgthree installed):
  // registered purely by the pack's JS, absent from /object_info BY DESIGN (#496
  // recurrence). These are GENERIC names a backend pack could also use — a live
  // backend registration carries nodeData/comfyClass provenance and never reaches
  // this allowlist (hasBackendProvenance), and a mid-session removal is caught by
  // the ever-seen gate BEFORE the exemption is consulted.
  "SetNode",
  "GetNode",
]);

/**
 * #1956 — refusal for a registered frontend-virtual type that is deliberately
 * outside FRONTEND_ONLY_NODE_TYPES. Fail-closed (not addable); do not claim the
 * pack is missing. The rgthree names are derived from the allowlist so this
 * cannot drift from FRONTEND_ONLY_NODE_TYPES.
 */
export function frontendOnlyNotAllowlistedRefusal(class_type) {
  const allowlisted = [...FRONTEND_ONLY_NODE_TYPES]
    .filter((t) => t.endsWith("(rgthree)"))
    .sort();
  return (
    `Cannot add "${class_type}": it is a frontend-only type — the ComfyUI backend never ` +
    `provides it, so its absence from /object_info is expected (not a missing, removed, or ` +
    `failed-to-import pack) — but it is deliberately not addable. The panel's frontend-only ` +
    `allowlist covers ${allowlisted.join(", ")}. Refusing to add rather than mint a node ` +
    `the panel cannot drive.`
  );
}

/**
 * True for a genuinely FRONTEND-ONLY / native node type — one that is registered in
 * the live LiteGraph registry AND is on the POSITIVE frontend-only allowlist
 * (FRONTEND_ONLY_NODE_TYPES). These legitimately have NO /object_info entry, so a
 * set_widget on one must NOT be refused merely for being absent from the backend
 * registry (#475).
 *
 * #458 SAFETY (why the allowlist, not just "defless"): a REMOVED backend pack can
 * leave a DEFLESS husk registered in the frontend registry, so keying "safe to write"
 * SOLELY on the absence of `nodeData` would authorize a write to a node the backend no
 * longer defines — reopening the fail-closed hole. The exemption therefore requires
 * TWO independent positive signals, and any doubt fails closed:
 *   1. RESERVED-NAMESPACE ALLOWLIST membership — the type is one of a fixed set of
 *      ComfyUI/litegraph core built-ins (Note/Reroute/…) or vendor-namespaced frontend
 *      nodes ("… (rgthree)"). These names are reserved by convention, so a third-party
 *      backend pack does not legitimately register under them.
 *   2. NO BACKEND-REGISTRATION PROVENANCE on the class. ComfyUI's registerNodesFromDefs
 *      stamps BOTH `.nodeData` AND `.comfyClass` on every backend-derived class, so a
 *      class bearing EITHER marker came from a backend def (a live pack, or a removed
 *      pack whose stale class was not purged) and is NOT frontend-only — even if its
 *      name collides with the allowlist. Only a class with NEITHER marker (a genuine
 *      frontend/native registration) is exempted.
 * A removed-backend type is refused by (1) (its arbitrary pack name is not reserved)
 * and, when its stale class is retained, also by (2).
 */
/** True when a node CLASS carries ComfyUI backend-registration provenance —
 *  registerNodesFromDefs stamps BOTH `.nodeData` and `.comfyClass` on every
 *  backend-derived class, so EITHER marker proves the class came from a backend def
 *  (a live pack, or a removed pack's stale/unpurged class). A genuine frontend/native
 *  registration carries neither. */
export function hasBackendProvenance(ctor) {
  return !!(ctor && (ctor.nodeData || ctor.comfyClass));
}

export function isFrontendOnlyRegisteredType(registry, type) {
  if (!isRegisteredNodeType(registry, type)) return false;
  if (typeof type !== "string" || !FRONTEND_ONLY_NODE_TYPES.has(type)) return false;
  // Refuse anything carrying backend-registration provenance on the REGISTERED class.
  return !hasBackendProvenance(registry[type]);
}

/**
 * THE single frontend-only authorization predicate for the WHOLE #458 guard family
 * (#496). Every guard that may exempt a type from the "must be in fresh /object_info"
 * rule calls THIS — graph_add_node's assertAddNodeResolvableRefreshing, and
 * graph_set_widget's assertTypeAgainstFreshBackend + assertMutatedNodeAuthorized.
 *
 * WHY ONE HELPER: the exemption was previously spelled out inline, clause-for-clause,
 * in each set_widget guard and OMITTED entirely from the add_node guard — so
 * MarkdownNote/Note/Reroute were writable but NOT addable, and a future edit to one
 * copy would silently diverge from the other. #496 is exactly that drift. A single
 * predicate makes "which types are frontend-only" a one-place decision; a guard either
 * consults it or does not exempt at all.
 *
 * The decision is UNCHANGED from the set_widget spelling — it still requires BOTH
 * positive signals and fails closed on any doubt:
 *   1. the type is REGISTERED in the live LiteGraph registry AND on the reserved
 *      FRONTEND_ONLY_NODE_TYPES allowlist, with no backend provenance on the
 *      REGISTERED class (isFrontendOnlyRegisteredType); AND
 *   2. the write-target INSTANCE's own constructor carries no backend provenance
 *      either — a stale backend instance must not slip through under a bare native
 *      class of the same name. (`node` is omitted by add_node, where no instance
 *      exists yet; the class check in (1) still applies.)
 *
 * This is NEVER the sole gate: every caller runs the non-forgeable
 * OBSERVED-BACKEND-HISTORY check (isRemovedBackendType) FIRST, so a since-removed
 * pack is refused before this predicate is ever consulted.
 */
export function isAuthorizedFrontendOnlyType(registry, type, node) {
  if (!registry) return false;
  if (!isFrontendOnlyRegisteredType(registry, type)) return false;
  return !hasBackendProvenance(node?.constructor);
}

/**
 * The #458 OBSERVED-BACKEND-HISTORY gate, shared by the whole guard family (#496):
 * TRUE when the ComfyUI backend reported `type` in some /object_info EARLIER this
 * session but the CURRENT /object_info no longer lists it — i.e. its backend was
 * REMOVED (pack uninstalled/disabled), so any write/add must be refused.
 *
 * This is the NON-FORGEABLE trust root: a client-side husk cannot un-see what the
 * backend already reported, so it catches a removed pack even when it masquerades
 * under a reserved allowlisted name with no provenance markers. Callers apply it
 * BEFORE the frontend-only exemption. `wasTypeEverDefined` is injected by the panel
 * and itself fails closed while the session baseline is unseeded.
 */
/**
 * mcp#2000 — THE FRONTEND-ONLY EXEMPTION AS APPLIED ON THE UNAVAILABLE-/object_info PATH,
 * in ONE place for all three guards that need it. The clauses are identical to the ones
 * each guard applies when /object_info WAS fetched, and neither reads the fetched defs:
 * the ever-seen gate reads the session-history oracle (a timeout leaves it intact) and
 * isAuthorizedFrontendOnlyType reads the live registry. A frontend-only type is absent
 * from /object_info BY DESIGN, so a fetch that did not answer withheld nothing about it.
 *
 * WHY IT SWALLOWS: before mcp#2000 these guards threw their refusal WITHOUT consulting
 * anything, so nothing on that path could raise. Consulting two predicates first means a
 * hostile registry (a Proxy whose membership trap throws) or an oracle that raises would
 * surface a RAW error in place of the worded refusal — the change making something worse
 * that it did not have to. Measured, not theorised: all three guards leaked
 * "registry exploded" / "history oracle exploded" before this wrapper existed.
 * Any doubt returns false, which refuses — the #458 default, and the same idiom this file
 * already uses for readImportFailures and describeObjectInfoFailure ("a diagnostic that
 * throws must not replace the refusal it explains").
 *
 * One copy, three call sites, deliberately: three inline copies is the #496 drift.
 */
function frontendOnlyExemptionApplies(registry, type, node, wasTypeEverDefined) {
  try {
    return (
      backendHistoryVerdict(type, wasTypeEverDefined) === "never-seen" &&
      isAuthorizedFrontendOnlyType(registry, type, node)
    );
  } catch {
    return false;
  }
}

export function isRemovedBackendType(type, wasTypeEverDefined) {
  return backendHistoryVerdict(type, wasTypeEverDefined) === "removed";
}

/**
 * The sentinel an injected `wasTypeEverDefined` returns instead of `true` when it has NO
 * trustworthy session baseline at all (the panel never established one, or latched it as
 * lost). It is TRUTHY, so any consumer that merely tests for truth still fails CLOSED —
 * recognizing it only buys a HONEST error message. Without it every refusal in that state
 * claims "its backend was removed (pack uninstalled/disabled)", which for a MarkdownNote
 * is simply false and misdiagnoses a transient backend problem as a broken install —
 * exactly the misleading-error complaint #496 was filed about.
 */
export const HISTORY_UNSEEDED = "history-unseeded";

/**
 * The other no-baseline sentinel: the baseline has not ARRIVED yet (the /object_info fetch
 * is still in flight, or a caller bounded its wait on it). Also TRUTHY, so it fails closed
 * identically — but it is TEMPORARY and RECOVERABLE, and must be reported that way.
 *
 * Keeping it distinct from HISTORY_UNSEEDED is not cosmetic. Treating "hasn't loaded yet"
 * as "proven untrustworthy" turns ordinary latency into a permanent, session-long refusal
 * of every legitimate add/write — a THIRD false refusal on top of the two (#496, #507)
 * this guard family was fixed to stop making. A slow fetch must yield "retry in a moment",
 * never "reload the tab".
 */
export const HISTORY_PENDING = "history-pending";

/**
 * Classify a type against the observed-backend-history oracle. ONE shared classifier for
 * the whole guard family (#496), so all three guards agree on both the verdict and the
 * diagnosis they report:
 *   "pending"    — the baseline has not arrived YET ⇒ refuse, but say it is temporary and
 *                  to retry; the state clears itself when the fetch lands.
 *   "unseeded"   — the observation window closed with no data ⇒ refuse, and tell the user
 *                  to reload the tab rather than blame a missing pack.
 *   "removed"    — the backend reported this type earlier this session and does not now
 *                  ⇒ its pack was uninstalled/disabled ⇒ refuse.
 *   "never-seen" — genuinely never backend-defined this session ⇒ the frontend-only
 *                  exemption may be considered (it has its own further requirements).
 *   "no-oracle"  — no history oracle was injected at all. Treated as NOT never-seen, so
 *                  callers that require positive history evidence fail closed.
 * Every verdict except "never-seen" refuses, so a consumer that cannot tell them apart is
 * still safe — the distinction only buys an accurate diagnosis.
 */
/**
 * The single membership predicate for "the CURRENT /object_info positively defines this
 * type". ONE definition so every consumer agrees on what a live backend type is: the two
 * fresh-auth guards below, and the #612 not-promoted diagnosis in runSetWidget, which must
 * NOT claim a node is a virtual-only container when the fresh backend positively defines
 * its type. Returns false for an unavailable/unfetched `freshDefs` — absence of the map is
 * "could not determine", and every caller already fails closed on that separately.
 */
export function freshBackendDefinesType(freshDefs, type) {
  if (!freshDefs || typeof freshDefs !== "object") return false;
  if (typeof type !== "string") return false;
  return Object.prototype.hasOwnProperty.call(freshDefs, type);
}

export function backendHistoryVerdict(type, wasTypeEverDefined) {
  if (typeof wasTypeEverDefined !== "function" || typeof type !== "string") return "no-oracle";
  const seen = wasTypeEverDefined(type);
  if (seen === HISTORY_PENDING) return "pending";
  if (seen === HISTORY_UNSEEDED) return "unseeded";
  return seen ? "removed" : "never-seen";
}

/** The shared refusal for a baseline that simply has not ARRIVED yet — TEMPORARY, so it
 *  must read as "retry in a moment", never as "this node type can't be verified" or
 *  "reload the tab". Getting this wrong is what makes ordinary latency look like a broken
 *  install to the user. */
function pendingHistoryMessage(what) {
  return (
    `${what}: the panel is still loading this ComfyUI's node-type baseline (the ` +
    `/object_info fetch has not come back yet), so a genuinely frontend-only node cannot ` +
    `yet be told apart from one whose pack was removed. This is TEMPORARY — retry in a ` +
    `moment and it will resolve itself; no reload is needed. Refusing to write until the ` +
    `backend can be verified (#458).`
  );
}

/** The shared, honest refusal for a baseline that was never established at all. */
function unseededHistoryMessage(what) {
  return (
    `${what}: the panel has no trustworthy record of what this ComfyUI backend defined ` +
    `earlier this session (the /object_info baseline never loaded — the backend was ` +
    `unreachable at page load), so a genuinely frontend-only node cannot be told apart ` +
    `from one whose pack was removed. Reload the ComfyUI tab to re-establish the ` +
    `baseline, then retry. Refusing to write rather than guess (#458).`
  );
}

/**
 * Positive signal that `node` is a genuine VIRTUAL SUBGRAPH CONTAINER — a litegraph
 * SubgraphNode. Prefers the UPSTREAM identity markers ComfyUI_frontend's SubgraphNode
 * exposes (`isVirtualNode === true`, `isSubgraphNode()`), falling back to a REAL nested
 * graph (`.subgraph` exposing `_nodes`/`getNodeById`), NOT a bare `subgraph:{}` marker.
 *
 * NOTE: container SHAPE alone is client-forgeable and is NOT the fail-closed trust root
 * for #458 — the OBSERVED-BACKEND-HISTORY gate (wasTypeEverDefined) is. This is one
 * defense-in-depth signal (distinguishing a container from a leaf) layered on top.
 */
export function isVirtualSubgraphContainer(node) {
  if (!node) return false;
  if (node.isVirtualNode === true) return true;
  if (typeof node.isSubgraphNode === "function") {
    try {
      if (node.isSubgraphNode()) return true;
    } catch {
      /* fall through to the structural check */
    }
  }
  const sg = node.subgraph;
  if (!sg || typeof sg !== "object") return false;
  return Array.isArray(sg._nodes) || typeof sg.getNodeById === "function";
}

/**
 * Fresh-authorize a node whose OWN widget / projection is ACTUALLY MUTATED by a
 * graph_set_widget write — the OUTER subgraph parent (its rail/proxy widgets) and the
 * IMMEDIATE inner promoted node (its widget) — NOT just the terminal traversal target
 * (#458 nested-intermediate). A nested promotion mutates + reports success on the
 * INTERMEDIATE virtual node, which is never the terminal `authTarget`, so it must be
 * authorized independently.
 *
 * Fails CLOSED unless ONE of:
 *   - the type is PRESENT in fresh /object_info (a live backend node); OR
 *   - the type was NEVER seen in any /object_info this session (per wasTypeEverDefined,
 *     the OBSERVED-BACKEND-HISTORY trust root) AND is a positive frontend-only signal:
 *     a provenance-clean virtual subgraph container, or a frontend-only leaf.
 *
 * #458 EVER-SEEN GATE (the non-forgeable anchor): a type ABSENT from the CURRENT
 * /object_info that WAS EVER reported by the backend this session is a REMOVED backend
 * node → REFUSE. A client husk cannot un-see what the backend already reported, so this
 * catches every removed-backend case — including one masquerading as a container or a
 * pure-JS frontend class under a reserved allowlisted name — that client-side shape /
 * name / provenance markers cannot. The provenance + container-shape checks remain as
 * DEFENSE-IN-DEPTH for the never-seen case, never as the sole gate. A null/unavailable
 * fresh map fails closed.
 *
 * `opts.promotionResolvedToAuthorizedConcrete` (#512): set by the set_widget caller ONLY
 * when this exact node's promoted widget was POSITIVELY resolved through the subgraph
 * promotion mapping to a concrete inner node whose type the caller has ALREADY
 * fresh-authorized (and whose instance passed the stale-placeholder check) — i.e. the
 * verifiable oracle is the RESOLVED INNER TARGET, not the container's own markers. This
 * matters because current ComfyUI_frontend STAMPS a synthesized def (static nodeData +
 * comfyClass) on every subgraph node's registered class (registerSubgraphNodeDef), so a
 * genuine outer UUID SubgraphNode carries "backend provenance" BY DESIGN and the
 * provenance-clean check below false-fires on it, refusing a correct promoted write as
 * an "unverifiable virtual-subgraph node". The flag relaxes ONLY the provenance signal
 * for a container on POSITIVE never-seen history evidence — the ever-seen gate above
 * still refuses a mid-session-removed type first, and an unwired/unseeded/pending
 * oracle never reaches this branch.
 */
export function assertMutatedNodeAuthorized(freshDefs, registry, node, role = "target", wasTypeEverDefined, opts = {}) {
  const type = node?.type;
  const id = node?.id ?? "(unknown)";
  const label = typeof type === "string" ? ` ("${type}")` : "";
  if (!freshDefs || typeof freshDefs !== "object") {
    // mcp#2000 — same exemption, same terms, same reason as the add guard: neither
    // clause reads `freshDefs`, and for a frontend-only type a successful fetch would
    // have said nothing about it anyway. Kept in step with the two sibling guards
    // deliberately — one copy relaxed alone is the #496 drift all over again.
    if (frontendOnlyExemptionApplies(registry, type, node, wasTypeEverDefined)) return;
    throw new Error(
      `Cannot set widget on node ${id}${label}: cannot verify the ${role} node against the ` +
        `ComfyUI backend (object_info is unavailable). Refusing to write rather than trust a ` +
        `possibly-stale node cache (#458).`,
    );
  }
  // PRESENT in the fresh backend → a live node, authorized by presence.
  if (freshBackendDefinesType(freshDefs, type)) return;
  // ABSENT from fresh object_info. EVER-SEEN GATE: if the backend reported this type
  // earlier this session, its backend was REMOVED — refuse (non-forgeable, #458).
  const verdict = backendHistoryVerdict(type, wasTypeEverDefined);
  if (verdict === "pending") {
    throw new Error(pendingHistoryMessage(`Cannot set widget on node ${id}${label} (${role} node)`));
  }
  if (verdict === "unseeded") {
    throw new Error(unseededHistoryMessage(`Cannot set widget on node ${id}${label} (${role} node)`));
  }
  if (verdict === "removed") {
    throw new Error(
      `Cannot set widget on node ${id}${label}: the ${role} node type was defined by the ComfyUI ` +
        `backend earlier this session but is ABSENT from the current /object_info — its backend was ` +
        `removed (pack uninstalled/disabled). Refusing to write to a since-removed node (#458).`,
    );
  }
  // NEVER seen this session → genuinely frontend-only/native. Permit only with a
  // positive, provenance-clean signal (defense-in-depth on top of the ever-seen gate).
  const provenanceClean =
    !hasBackendProvenance(typeof type === "string" ? registry?.[type] : undefined) &&
    !hasBackendProvenance(node?.constructor);
  if (provenanceClean && isVirtualSubgraphContainer(node)) return;
  // #512: a genuine UUID SubgraphNode whose class carries the frontend's SYNTHESIZED
  // def markers (so provenanceClean is false BY DESIGN, see the docblock) is authorized
  // through its RESOLVED, already-fresh-authorized concrete inner target instead — but
  // only on POSITIVE never-seen history evidence. An unwired oracle ("no-oracle") fails
  // closed here exactly as before, and a "removed"/pending/unseeded verdict threw above.
  if (
    verdict === "never-seen" &&
    opts?.promotionResolvedToAuthorizedConcrete === true &&
    isVirtualSubgraphContainer(node)
  ) {
    return;
  }
  // SHARED frontend-only predicate (#496) — the identical decision assertTypeAgainstFreshBackend
  // and assertAddNodeResolvableRefreshing make, so the family cannot drift apart again.
  if (isAuthorizedFrontendOnlyType(registry, type, node)) return;
  throw new Error(
    `Cannot set widget on node ${id}${label}: the ${role} node is not defined by the ComfyUI ` +
      `backend and is not a verifiable frontend-only / virtual-subgraph node (a removed or ` +
      `unverifiable node type, or a backend node masquerading as a subgraph container) — ` +
      `refusing to write (#458).`,
  );
}

/**
 * Guard for graph_add_node: throw (mirroring the read-path hard error) when
 * `class_type` cannot be resolved against the live registry, distinguishing
 * "backend unreachable / defs not loaded" from "type genuinely unknown". Returns
 * nothing on success — the caller may then createNode(class_type) knowing it is a
 * real, registered type (never a fabricated placeholder).
 */
export function assertAddNodeResolvable(registry, class_type) {
  if (isRegisteredNodeType(registry, class_type)) return;
  if (!comfyNodeDefsLoaded(registry)) {
    throw new Error(
      `Cannot add "${class_type}": ComfyUI node definitions are not loaded ` +
        `(the backend is unreachable, or /object_info hasn't been fetched). ` +
        `Reconnect ComfyUI and retry — refusing to add an unresolved placeholder node.`,
    );
  }
  throw new Error(
    // create_workflow (action:"node_info") queries the live /object_info (node
    // CLASSES); panel_search_nodes searches installable Manager PACKS and can
    // never answer this (#741).
    `Unknown node type "${class_type}" — check the exact class_type via create_workflow (action:"node_info")`,
  );
}

/**
 * Async graph_add_node guard whose go/no-go decision is made against the CURRENT
 * backend /object_info — NOT the mutated LiteGraph registry (#289 + #458/P1-C).
 *
 * The registry is unreliable in BOTH directions after a pack change + restart:
 *   - it MISSES a freshly-installed pack's classes until /object_info is re-fetched
 *     and re-registered — so a correct class_type reads "Unknown" (#289); and
 *   - it KEEPS a STALE POSITIVE for an UNINSTALLED pack — an add-only refresh never
 *     purges the removed class, so `LG.registered_node_types.GoneNode` survives and
 *     the type would wrongly "add" against a backend that no longer provides it
 *     (violating the #458 fail-closed invariant).
 *
 * So the AUTHORITATIVE oracle is the freshly-fetched /object_info payload:
 *   1. Fetch fresh /object_info via `getFreshObjectInfo`.
 *   2. If the backend does NOT define the type → fail closed (unknown/removed),
 *      regardless of any stale registry entry. The ONE exemption (#496) is a genuine
 *      FRONTEND-ONLY type (Note/MarkdownNote/Reroute/… — never in /object_info by
 *      design), decided by the SAME shared predicate the graph_set_widget guards use
 *      (isAuthorizedFrontendOnlyType) and only AFTER the observed-backend-history gate
 *      (isRemovedBackendType) has ruled out a since-removed pack.
 *   3. If the backend DOES define it → ensure LiteGraph can construct it: if the
 *      page-load registry predates it, `refresh` (re-register the fresh defs) and
 *      re-check; if it still can't be registered, fail closed rather than let
 *      LiteGraph mint a placeholder.
 *   4. If a fresh-oracle IS wired but /object_info is UNAVAILABLE (fetch rejected /
 *      returned nothing) → FAIL CLOSED with a "cannot verify against backend" error.
 *      We must NOT fall back to the stale registry: a transient fetch failure would
 *      otherwise authorize a since-removed type (#458/P1-2). Only a caller that
 *      wires NO fresh-oracle at all degrades to the registry-only guard.
 *      THE ONE EXCEPTION (mcp#2000) is the SAME frontend-only exemption as step 2,
 *      applied on the same terms: a type absent from the session history oracle
 *      (which a timeout leaves intact) AND authorized by isAuthorizedFrontendOnlyType
 *      against the LIVE REGISTRY. Neither clause reads /object_info, and for a
 *      frontend-only type /object_info is empty by design — so a fetch that did not
 *      answer withheld nothing, and refusing on it was a false refusal, not a guard.
 *
 *   getRegistry        : () => the LIVE registry object (re-invoked after refresh).
 *   getFreshObjectInfo : optional async () => the CURRENT /object_info map (keyed by
 *                        class_type), or null when it can't be fetched.
 *   refresh            : optional async (defs?) => re-register node defs into the
 *                        registry; receives the already-fetched defs to avoid a
 *                        second /object_info round-trip.
 *   wasTypeEverDefined : (type) => did any /object_info this session report this type?
 *                        The #458 observed-backend-history trust root, shared with
 *                        graph_set_widget. REQUIRED for the frontend-only exemption:
 *                        omit it and NOTHING absent from fresh /object_info is ever
 *                        exempted (fail closed, pre-#496 behaviour).
 *   getRootGraph       : optional () => the live root graph. #1523 uses it (via
 *                        subgraphTypeIsLoaded) to recognize a UUID subgraph already
 *                        loaded in this workflow — those types are never in
 *                        /object_info, so the backend oracle alone cannot authorize
 *                        them. Omit it (and isLoadedSubgraphType) and a UUID is
 *                        still diagnosed as a subgraph rather than a missing pack,
 *                        but is not addable.
 *   isLoadedSubgraphType : optional (type) => boolean override for that lookup.
 */
export async function assertAddNodeResolvableRefreshing(getRegistry, class_type, opts = {}) {
  // #775 — `readImportFailures` is injected and awaited ONLY on the refusal path,
  // so a healthy add pays nothing for it.
  const { getFreshObjectInfo, refresh, wasTypeEverDefined, readImportFailures, readNodeMap } =
    opts;
  const readRegistry = () =>
    typeof getRegistry === "function" ? getRegistry() : getRegistry;

  // When a fresh-oracle capability is wired (the panel always wires it), the FRESH
  // /object_info is the ONLY authority. If it can't be consulted (fetch rejected /
  // returned nothing), we must FAIL CLOSED — NOT fall back to the stale registry,
  // which keeps positives for removed packs (a transient fetch failure would
  // otherwise authorize a since-uninstalled type, #458/P1-2).
  if (typeof getFreshObjectInfo === "function") {
    let freshDefs = null;
    try {
      freshDefs = await getFreshObjectInfo();
    } catch {
      freshDefs = null;
    }
    if (!freshDefs || typeof freshDefs !== "object") {
      // mcp#2000 — A FETCH THAT DID NOT ANSWER IS NOT EVIDENCE ABOUT A TYPE THE FETCH
      // COULD NEVER HAVE ANSWERED ABOUT. Failing closed here for EVERY type refused a
      // MarkdownNote on a healthy live canvas whose /object_info refresh had just timed
      // out, telling the reporter to "Reconnect ComfyUI" while ComfyUI was answering
      // fine. object-info-history.js already states this rule for its own latch — "ARM
      // THIS ONLY ON EVIDENCE, NEVER ON A TIMEOUT… latching on one would turn ordinary
      // latency into a permanent false refusal of every legitimate add/write" — and this
      // branch was breaking it.
      //
      // The exemption below is EXACTLY the one the fetched-defs path applies a few lines
      // down, and it is safe here because NOT ONE of its clauses reads `freshDefs`:
      //   - the #458 ever-seen gate reads the SESSION HISTORY oracle, which survives a
      //     timeout untouched (recordTypes(null) records nothing, and a timeout must
      //     never arm loseBaseline) — so the non-forgeable trust root that catches a
      //     removed pack squatting a reserved name is still fully in force; and
      //   - isAuthorizedFrontendOnlyType reads the LIVE REGISTRY (membership + reserved
      //     allowlist + no backend provenance), which is also precisely what
      //     LG.createNode needs, so an exempted add constructs a REAL node and cannot
      //     mint the #458 placeholder.
      // For a genuinely frontend-only type /object_info is empty BY DESIGN, so a
      // successful fetch would have added no information about it whatsoever. Every
      // other type — and every doubt, including a pending/unseeded/absent history
      // oracle — still fails closed on the message below, unchanged.
      //
      // Testing `=== "never-seen"` is what makes the ever-seen gate load-bearing here,
      // and it subsumes the sibling exemption's separate `typeof wasTypeEverDefined ===
      // "function"` clause: an unwired oracle classifies as "no-oracle", never
      // "never-seen". Spelling that clause out as well passed every test with it
      // deleted, so it is left out rather than kept as an untestable reassurance.
      if (frontendOnlyExemptionApplies(readRegistry(), class_type, undefined, wasTypeEverDefined)) {
        return;
      }
      throw new Error(
        `cannot verify node type "${class_type}" against the ComfyUI backend ` +
          `(object_info is unavailable — the backend is unreachable or the fetch failed). ` +
          `Refusing to add rather than trust a possibly-stale node cache (#458). Reconnect ComfyUI and retry.`,
      );
    }
    // AUTHORITATIVE: does the LIVE backend provide this type right now?
    if (!Object.prototype.hasOwnProperty.call(freshDefs, class_type)) {
      // #458 EVER-SEEN GATE (the non-forgeable trust root, applied FIRST — same order
      // as the set_widget guards): the backend reported this type earlier this session
      // but no longer does ⇒ its pack was REMOVED. Refuse, even under a reserved
      // allowlisted name, before the frontend-only exemption below is consulted.
      const verdict = backendHistoryVerdict(class_type, wasTypeEverDefined);
      if (verdict === "pending") {
        throw new Error(pendingHistoryMessage(`Cannot add "${class_type}"`));
      }
      if (verdict === "unseeded") {
        throw new Error(unseededHistoryMessage(`Cannot add "${class_type}"`));
      }
      if (verdict === "removed") {
        throw new Error(
          `Cannot add "${class_type}": the ComfyUI backend defined this node type earlier this ` +
            `session but it is ABSENT from the current /object_info — its backend was removed ` +
            `(pack uninstalled/disabled). Refusing to add a since-removed node type (#458).`,
        );
      }
      // #496 FRONTEND-ONLY EXEMPTION: Note / MarkdownNote / Reroute / PrimitiveNode and
      // the rgthree frontend control nodes are registered PURELY by the LiteGraph
      // frontend and are NEVER enumerated by /object_info BY DESIGN, so the fresh-backend
      // oracle can never authorize them and this guard failed CLOSED on a perfectly
      // healthy backend. graph_set_widget already exempted exactly this class of node;
      // add_node did not — the drift #496 reports. Both now call the SAME predicate
      // (isAuthorizedFrontendOnlyType), which requires live-registry membership, reserved
      // allowlist membership and a provenance-clean registered class. Registry membership
      // is also precisely what LG.createNode needs, so the caller can construct it.
      //
      // The exemption additionally REQUIRES the observed-backend-history oracle to be
      // WIRED (codex round-1, SEVERE): client-side name + provenance markers alone are
      // forgeable — a removed pack whose frontend class had its .nodeData/.comfyClass
      // stripped and which squats a reserved allowlisted name would otherwise be added
      // as a stale/generic node and reported as success. Only the non-forgeable
      // ever-seen gate can rule that out, so WITHOUT it there is no exemption at all
      // and every type absent from fresh /object_info fails closed exactly as before
      // this change. The panel always wires it; this makes add's exemption strictly
      // stronger than a bare allowlist check.
      if (
        typeof wasTypeEverDefined === "function" &&
        isAuthorizedFrontendOnlyType(readRegistry(), class_type)
      ) {
        return;
      }
      // #1296 — a type ON the frontend-only allowlist that is absent from the LIVE
      // REGISTRY is refused correctly, but the generic refusal below misdiagnoses WHY:
      // "not installed, its pack was removed, or its pack failed to import" sends the
      // user to reinstall a pack they already have (the reported case: rgthree-comfy
      // installed and verified, ComfyUI restarted — which does NOT reload the open
      // tab). A pack's frontend JS is fetched once at PAGE LOAD, so a pack installed
      // after this tab opened registers nothing here, and no /object_info refresh can
      // fix that — a frontend-only class never comes from the backend. Nothing the
      // server reports can confirm or deny a frontend-only type, so name the one
      // action that changes the outcome: RELOAD the ComfyUI tab. Only the never-seen
      // verdict may say this — a removed/unseeded/pending history keeps its own
      // honest message above, and an allowlisted name whose REGISTERED class carries
      // backend provenance (a name-collision husk) stays on the generic refusal.
      if (
        verdict === "never-seen" &&
        FRONTEND_ONLY_NODE_TYPES.has(class_type) &&
        !isRegisteredNodeType(readRegistry(), class_type)
      ) {
        throw new Error(
          `Cannot add "${class_type}": it is a frontend-only node type — the ComfyUI backend ` +
            `never provides it, so its absence from /object_info is expected — but it is NOT ` +
            `registered in this tab's live node registry. A pack's frontend JS is loaded once ` +
            `at page load, and restarting the ComfyUI server does NOT reload an already-open ` +
            `tab, so a pack installed after this tab opened registers nothing here. RELOAD the ` +
            `ComfyUI tab and retry. If it is still refused after a reload, the pack that provides ` +
            `it is not installed (or its frontend JS failed to load). Refusing to add rather than ` +
            `let LiteGraph mint an unresolved placeholder node (#458).`,
        );
      }
      // #1956 — a type the live registry PROVES frontend-virtual (isVirtualNode on a
      // probe instance) that is NOT on FRONTEND_ONLY_NODE_TYPES. The refusal is
      // correct — the allowlist is the only addable frontend-only set — but the
      // generic "Unknown node type / not installed / pack removed" below sends the
      // agent to reinstall a healthy pack. Bookmark (rgthree) is the reported case:
      // rgthree is installed, the type is absent from /object_info BY DESIGN.
      if (
        verdict === "never-seen" &&
        isFrontendVirtualRegisteredType(readRegistry(), class_type) &&
        !FRONTEND_ONLY_NODE_TYPES.has(class_type)
      ) {
        throw new Error(frontendOnlyNotAllowlistedRefusal(class_type));
      }
      // #1523 — a subgraph UUID is never in /object_info (registerSubgraphNodeDef
      // synthesizes the class locally from the workflow's definitions). Treating
      // that absence as "unknown backend node" then appending whichever pack
      // failed to import (ReActor, on the reporter's canvas) is the misdiagnosis:
      // no custom-node pack owns a UUID type. Loaded + registered ⇒ addable;
      // anything else gets subgraph-specific copy/library advice, never a pack
      // import note. The ever-seen gate above still refuses a type the backend
      // actually reported earlier this session.
      if (isSubgraphUuidType(class_type)) {
        const loaded = subgraphDefinitionLoaded(class_type, opts);
        const registered = isRegisteredNodeType(readRegistry(), class_type);
        if (
          typeof wasTypeEverDefined === "function" &&
          verdict === "never-seen" &&
          loaded &&
          registered
        ) {
          return;
        }
        throw new Error(subgraphUuidAddRefusal(class_type, { loaded, registered }));
      }
      // Not defined by the current backend (never installed, or its pack was
      // removed). Fail closed even if a stale registry entry survives (#458/P1-C).
      // #741: the pointer must be a tool that searches node CLASSES
      // (create_workflow action:"node_info", the live /object_info) —
      // panel_search_nodes searches Manager PACKS, which structurally cannot
      // resolve an exact class_type.
      // #775 — "not installed, or its pack was removed" is not the whole list, and
      // the missing entry is the one that makes the advice useless: a pack that IS
      // installed and FAILED TO IMPORT registers none of its nodes, so its types
      // are absent from /object_info exactly as if it were gone. Installing it
      // again cannot help. I walked into that dead end myself and filed a wrong
      // diagnosis from it (ComfyUI-LTXVideo, ImportError on a core rename).
      // #1447 — pass the live map and the requested type so a pack that currently
      // provides nodes (ReActorFaceSwap just added) is not named as the reason a
      // different type (VideoToImages) is missing.
      // #1523 — UUID types never reach here (handled above). Remaining failures
      // still do not prove ownership of the requested type.
      // #1544 — naming a failed pack is a CAUSAL claim, and the panel was making it
      // without evidence: `PreviewVideo` was refused with "coldinfire_fal_privacy
      // FAILED TO IMPORT" attached. ComfyUI-Manager's node map is the ownership
      // oracle (`readNodeMap`), and it is read ONLY once there is a surviving
      // failure to adjudicate — it is a ~1.4 MB payload, and a refusal with no
      // import failures must not pay for it.
      let failedNote = "";
      if (typeof readImportFailures === "function") {
        try {
          const failed = await readImportFailures();
          const noteOpts = { forType: class_type, liveDefs: freshDefs };
          if (
            typeof readNodeMap === "function" &&
            relevantPackImportFailures(failed, noteOpts).length > 0
          ) {
            try {
              noteOpts.nodeMap = await readNodeMap();
            } catch {
              // Manager unreachable/disabled: ownership stays unestablished, which
              // the note reports as exactly that rather than guessing a cause.
            }
          }
          failedNote = importFailureNote(failed, noteOpts);
        } catch {
          // A diagnostic that throws must not replace the refusal it explains.
        }
      }
      throw new Error(
        `Unknown node type "${class_type}" — the ComfyUI backend does not provide it ` +
          `(not installed, its pack was removed, or its pack failed to import). ` +
          `Check the exact class_type via create_workflow (action:"node_info")` +
          failedNote,
      );
    }
    // Backend HAS it. Make sure LiteGraph can construct it — refresh to register the
    // fresh defs when the page-load registry predates the install (#289), re-check.
    if (!isRegisteredNodeType(readRegistry(), class_type) && typeof refresh === "function") {
      try {
        await refresh(freshDefs);
      } catch {
        /* refresh best-effort — the post-refresh re-check decides go/no-go */
      }
    }
    if (isRegisteredNodeType(readRegistry(), class_type)) return;
    // Backend defines it but the frontend couldn't register it (refresh failed) —
    // fail closed rather than let LiteGraph mint an unresolved placeholder (#458).
    throw new Error(
      `Node type "${class_type}" exists on the ComfyUI backend but could not be registered in the ` +
        `frontend (node-def refresh failed) — reload the ComfyUI tab and retry. ` +
        `Refusing to add an unresolved placeholder node.`,
    );
  }

  // No fresh-oracle capability wired at all (a caller that does not supply
  // getFreshObjectInfo — not the panel): degrade to the registry-only guard, which
  // still fails closed for unknown types and names unreachable-vs-unknown (#458).
  assertAddNodeResolvable(readRegistry(), class_type);
}

/**
 * Fresh-backend authorization for graph_set_widget, applied to the type of the
 * ACTUAL RESOLVED write target (the inner promoted node for a subgraph write, or
 * the node's own for a direct write) — #458 set_widget gap, found in review of
 * #375. graph_add_node already authorizes its class_type against the CURRENT
 * /object_info; set_widget must do the SAME, because the LiteGraph registry keeps
 * a STALE POSITIVE for an uninstalled pack when the browser tab was never reloaded
 * after a ComfyUI restart. `freshDefs` is the freshly-fetched /object_info map (or
 * null/undefined when the fetch failed). FAILS CLOSED in both directions:
 *   - fetch unavailable (null/non-object) ⇒ "cannot verify against backend" — except
 *     for an authorized frontend-only type, which the fetch could not have spoken to
 *     either way (mcp#2000); and
 *   - type absent from the fresh map ⇒ "backend does not provide" (removed pack).
 * Never authorizes from the stale registry. Pure — no side effects — so the caller
 * can run it on the exact target it is about to mutate, before any mutation.
 *
 * FRONTEND-ONLY EXEMPTION (#475): when object_info IS available (a real map was
 * fetched) but the type is simply ABSENT from it, the type is still permitted iff it
 * is a genuine frontend-only / native registered type (isFrontendOnlyRegisteredType:
 * registered in the live registry AND on the POSITIVE frontend-only allowlist —
 * rgthree Fast Bypasser, Note, Reroute, …). Such a node's widget write is a reversible
 * frontend canvas edit and legitimately has no /object_info entry. This does NOT
 * reopen the #458 hole: a REMOVED backend node (whether it keeps a stale-positive
 * class WITH nodeData, or is left as a DEFLESS husk) is NOT on the allowlist and is
 * still refused. mcp#2000 — the exemption is NO LONGER scoped to "object_info was
 * fetched": it is applied on the unavailable path too, on identical terms, because
 * neither of its clauses reads `freshDefs` and a frontend-only type is absent from
 * /object_info BY DESIGN, so a fetch that did not answer withheld nothing about it.
 * Every OTHER type still fails closed on an unavailable map, exactly as before.
 *
 * `opts.registry` is the live LiteGraph registry used to recognize a frontend-only
 * type; `opts.node` is the actual write-target node whose OWN constructor is also
 * checked for backend provenance (a stale backend INSTANCE under a bare native class
 * of the same name must not slip through). Omit `registry` to keep the strict
 * backend-only behaviour.
 */
export function assertTypeAgainstFreshBackend(freshDefs, type, nodeId = "(unknown)", opts = {}) {
  const { registry, node, wasTypeEverDefined, describeObjectInfoFailure } = opts;
  const label = typeof type === "string" ? ` ("${type}")` : "";
  if (!freshDefs || typeof freshDefs !== "object") {
    // #982 — SAY WHAT HAPPENED, not a disjunction. "the backend is unreachable or the
    // fetch failed" names two causes and establishes neither, and the reporter went
    // checking a backend that was answering `/object_info/VAELoader` perfectly well while
    // reading this. When the oracle recorded what each route actually did, that is
    // appended; when it recorded nothing, the sentence stays as it was.
    let observed = "";
    try {
      observed = typeof describeObjectInfoFailure === "function" ? describeObjectInfoFailure() || "" : "";
    } catch {
      observed = ""; // a diagnostic must never replace the refusal it is describing
    }
    // mcp#2000 — see assertAddNodeResolvableRefreshing. The exemption is evaluated
    // BEFORE this refusal on exactly the terms the fetched-defs path below uses, and it
    // is placed after `describeObjectInfoFailure` deliberately: that oracle only builds
    // a diagnostic string, so an exempted write costs it nothing that matters and the
    // refusal it explains still reads identically for every type that is refused.
    if (frontendOnlyExemptionApplies(registry, type, node, wasTypeEverDefined)) return;
    throw new Error(
      `Cannot set widget on node ${nodeId}${label}: cannot verify the node type against the ` +
        `ComfyUI backend — no usable /object_info schema was obtained.${observed} ` +
        `Refusing to write rather than trust a possibly-stale node cache (#458). ` +
        `Reconnect ComfyUI and retry. If /object_info answers when you run it by hand, ` +
        `compare it with what each route above reported — one of them may have answered ` +
        `without returning a usable schema, which is a different fault from an ` +
        `unreachable backend (#982).`,
    );
  }
  if (!freshBackendDefinesType(freshDefs, type)) {
    // #458 EVER-SEEN GATE (the non-forgeable trust root): object_info WAS fetched but
    // lacks this type. If the backend reported this type EARLIER this session, its
    // backend was REMOVED (pack uninstalled) → refuse — even a pure-JS frontend class
    // registered under a reserved allowlisted name (MarkdownNote from a removed pack)
    // that carries no nodeData/comfyClass is caught here, because a client husk cannot
    // un-see what the backend already reported. This is what the client-side allowlist +
    // provenance markers CANNOT prove on their own.
    const verdict = backendHistoryVerdict(type, wasTypeEverDefined);
    if (verdict === "pending") {
      throw new Error(pendingHistoryMessage(`Cannot set widget on node ${nodeId}${label}`));
    }
    if (verdict === "unseeded") {
      throw new Error(unseededHistoryMessage(`Cannot set widget on node ${nodeId}${label}`));
    }
    if (verdict === "removed") {
      throw new Error(
        `Cannot set widget on node ${nodeId}${label}: node type "${type}" was defined by the ComfyUI ` +
          `backend earlier this session but is ABSENT from the current /object_info — its backend was ` +
          `removed (pack uninstalled/disabled). Refusing to write to a since-removed node (#458).`,
      );
    }
    // #475: NEVER seen this session → genuinely frontend-only/native. Allow a reserved-
    // namespace allowlisted node with NO backend provenance on the registered class OR
    // the write-target INSTANCE's own constructor (defense-in-depth on top of the
    // ever-seen gate). A removed backend node's arbitrary pack name is not allowlisted.
    // SHARED predicate (#496) — the same one assertMutatedNodeAuthorized and
    // assertAddNodeResolvableRefreshing use, so no copy can drift.
    if (isAuthorizedFrontendOnlyType(registry, type, node)) return;
    throw new Error(
      `Cannot set widget on node ${nodeId}${label}: the ComfyUI backend does not provide node ` +
        `type "${type}" (not installed, or its pack was removed) — refusing to write to a node ` +
        `the live backend no longer defines (#458). Check the exact class_type via create_workflow (action:"node_info").`,
    );
  }
}

/**
 * Guard for graph_set_widget, applied to the ACTUAL RESOLVED write target (the
 * inner promoted node for a subgraph write, or the node's own for a direct
 * write) — NOT the outer node. This is the load-bearing check: it must run on
 * whatever `applyWidgetWrite` is about to mutate, so a placeholder can't slip
 * through by being (or hosting) a subgraph.
 *
 * Fails CLOSED. A resolved target is writable ONLY when it has a string `type`
 * that is registered in the live registry. Anything else — no type, or a type
 * absent from the registry (an unresolved placeholder, whether it carries a
 * `subgraph` property or not; or a genuinely missing custom node) — is refused,
 * distinguishing "backend unreachable / defs not loaded" from "type not
 * registered". A REAL subgraph parent is exempted authentically: its promoted
 * widget resolves to a registered inner node, and THAT inner node is what gets
 * passed here and passes the registry check.
 *
 * #496 NOTE — this is the one member of the guard family that needs NO frontend-only
 * allowlist, so do NOT paste one here: its oracle is the LIVE LiteGraph REGISTRY, not
 * /object_info, and a frontend-only type IS registered there (that is what "frontend-
 * only" means). Note/MarkdownNote/Reroute therefore pass it already, and the
 * placeholder check below is explicitly written not to false-negative them. Only the
 * guards whose oracle is /object_info (assertAddNodeResolvableRefreshing,
 * assertTypeAgainstFreshBackend, assertMutatedNodeAuthorized) need the exemption, and
 * all three take it from the single shared isAuthorizedFrontendOnlyType predicate.
 */
export function assertResolvedTargetRegistered(registry, targetNode) {
  const type = targetNode?.type;
  const id = targetNode?.id ?? "(unknown)";
  if (typeof type !== "string" || !isRegisteredNodeType(registry, type)) {
    if (!comfyNodeDefsLoaded(registry)) {
      throw new Error(
        `Cannot set widget on node ${id}${type ? ` ("${type}")` : ""}: ComfyUI ` +
          `node definitions are not loaded (the backend is unreachable). Reconnect ` +
          `ComfyUI and retry — refusing to write to an unresolved placeholder node.`,
      );
    }
    throw new Error(
      `Cannot set widget on node ${id}: its type ${type ? `"${type}" is` : "is"} ` +
        `not registered on this ComfyUI (missing custom node, or an unresolved ` +
        `placeholder) — refusing to write to it.`,
    );
  }
  // The type IS registered — but the INSTANCE may still be a stale placeholder
  // (#458). A workflow loaded while ComfyUI's defs were unavailable creates node
  // instances on a GENERIC FALLBACK constructor with no nodeData; if the backend
  // later comes back and registers the type, the type-string check now passes yet
  // the instance still carries generic in0/out0/'*' slots and {value,text}
  // widgets. registerNodesFromDefs mints a NEW class per type, so a genuinely
  // resolved instance's own constructor carries the def while a stale placeholder
  // does not. So: if the REGISTERED class has a real def (nodeData) but THIS
  // instance's constructor does not, it is an unresolved placeholder — refuse.
  // (Native/defless types have no registered nodeData to compare and are trusted,
  // so this never false-negatives Note/Reroute/etc.)
  const registeredDef = registry?.[type]?.nodeData;
  const instanceDef = targetNode?.constructor?.nodeData;
  if (registeredDef && !instanceDef) {
    throw new Error(
      `Cannot set widget on node ${id} ("${type}"): the node is an unresolved ` +
        `placeholder — its live definition is missing even though the type is now ` +
        `registered (the workflow was loaded while ComfyUI was unavailable). ` +
        `Reload the workflow now that ComfyUI is reachable. Refusing to write.`,
    );
  }
}

/**
 * graph_set_widget handler prelude: decide whether the OUTER node may be MUTATED
 * (by reconcileUnknownWidgetNames, which RENAMES widgets in place) before the
 * write, and refuse a direct placeholder UP FRONT so NO pre-write mutation ever
 * touches an unresolved node (#458). Returns { reconcile }:
 *   - subgraph parent → { reconcile: false }: the write targets an INNER node
 *     (resolved + registry-checked inside applyWidgetWrite), and reconcile only
 *     renames the OUTER parent's own widgets — irrelevant to a promoted write, so
 *     it is skipped rather than risk mutating a fake `subgraph:{}` placeholder.
 *   - direct node → asserts it's a registered write target (throws otherwise),
 *     then { reconcile: true } so only a genuinely resolved node is repaired.
 */
export function preflightSetWidgetTarget(registry, node) {
  if (node?.subgraph) return { reconcile: false };
  assertResolvedTargetRegistered(registry, node);
  return { reconcile: true };
}
