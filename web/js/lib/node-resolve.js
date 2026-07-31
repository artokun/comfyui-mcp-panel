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

/** True when `type` is registered in the live LiteGraph registry object
 *  (LG.registered_node_types). */
export function isRegisteredNodeType(registry, type) {
  if (!registry || typeof type !== "string") return false;
  return Object.prototype.hasOwnProperty.call(registry, type);
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
    `Unknown node type "${class_type}" — check the exact class_type via panel_search_nodes`,
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
 *      regardless of any stale registry entry.
 *   3. If the backend DOES define it → ensure LiteGraph can construct it: if the
 *      page-load registry predates it, `refresh` (re-register the fresh defs) and
 *      re-check; if it still can't be registered, fail closed rather than let
 *      LiteGraph mint a placeholder.
 *   4. If a fresh-oracle IS wired but /object_info is UNAVAILABLE (fetch rejected /
 *      returned nothing) → FAIL CLOSED with a "cannot verify against backend" error.
 *      We must NOT fall back to the stale registry: a transient fetch failure would
 *      otherwise authorize a since-removed type (#458/P1-2). Only a caller that
 *      wires NO fresh-oracle at all degrades to the registry-only guard.
 *
 *   getRegistry        : () => the LIVE registry object (re-invoked after refresh).
 *   getFreshObjectInfo : optional async () => the CURRENT /object_info map (keyed by
 *                        class_type), or null when it can't be fetched.
 *   refresh            : optional async (defs?) => re-register node defs into the
 *                        registry; receives the already-fetched defs to avoid a
 *                        second /object_info round-trip.
 */
export async function assertAddNodeResolvableRefreshing(getRegistry, class_type, opts = {}) {
  const { getFreshObjectInfo, refresh } = opts;
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
      throw new Error(
        `cannot verify node type "${class_type}" against the ComfyUI backend ` +
          `(object_info is unavailable — the backend is unreachable or the fetch failed). ` +
          `Refusing to add rather than trust a possibly-stale node cache (#458). Reconnect ComfyUI and retry.`,
      );
    }
    // AUTHORITATIVE: does the LIVE backend provide this type right now?
    if (!Object.prototype.hasOwnProperty.call(freshDefs, class_type)) {
      // Not defined by the current backend (never installed, or its pack was
      // removed). Fail closed even if a stale registry entry survives (#458/P1-C).
      throw new Error(
        `Unknown node type "${class_type}" — the ComfyUI backend does not provide it ` +
          `(not installed, or its pack was removed). Check the exact class_type via panel_search_nodes`,
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
 *   - fetch unavailable (null/non-object) ⇒ "cannot verify against backend"; and
 *   - type absent from the fresh map ⇒ "backend does not provide" (removed pack).
 * Never authorizes from the stale registry. Pure — no side effects — so the caller
 * can run it on the exact target it is about to mutate, before any mutation.
 */
export function assertTypeAgainstFreshBackend(freshDefs, type, nodeId = "(unknown)") {
  const label = typeof type === "string" ? ` ("${type}")` : "";
  if (!freshDefs || typeof freshDefs !== "object") {
    throw new Error(
      `Cannot set widget on node ${nodeId}${label}: cannot verify the node type against the ` +
        `ComfyUI backend (object_info is unavailable — the backend is unreachable or the fetch ` +
        `failed). Refusing to write rather than trust a possibly-stale node cache (#458). ` +
        `Reconnect ComfyUI and retry.`,
    );
  }
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(freshDefs, type)) {
    throw new Error(
      `Cannot set widget on node ${nodeId}${label}: the ComfyUI backend does not provide node ` +
        `type "${type}" (not installed, or its pack was removed) — refusing to write to a node ` +
        `the live backend no longer defines (#458). Check the exact class_type via panel_search_nodes.`,
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
