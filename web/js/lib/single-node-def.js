/**
 * panel#767 — every `panel_add_node` re-downloads the ENTIRE node schema.
 *
 * `#458` made the fresh `/object_info` the sole authority for "does the backend
 * still provide this type", and it is right to: a stale registry keeps positives
 * for packs that have since been uninstalled. But the fetch it uses is the whole
 * document, and on a real install that is not small. Measured on the rig
 * (ComfyUI 0.30.2, 63 custom-node packs):
 *
 *     GET /object_info              5,413,770 bytes   167 ms
 *     GET /object_info/KSampler         3,246 bytes   1.2 ms
 *
 * 1,667x smaller, 135x faster. Ten `panel_add_node` calls in a burst therefore
 * pull ~54 MB and, once the coalescer serialises the payload-carrying refreshes
 * behind each other, blow through the 30 s reply deadline — the exact failure in
 * the report, where the adds then landed anyway and left "ghost" nodes behind a
 * timeout that had already been reported as failure.
 *
 * ComfyUI answers per class, and answers ABSENCE as `{}` with HTTP 200 (verified
 * against `LTXVImgToVideoConditionOnly`, a type that install does not have). So
 * `hasOwnProperty(defs, class_type)` — the authority test #458 performs — behaves
 * identically on the single-class response.
 *
 * The fast path is taken only when it can CONFIRM the type: a live response that
 * actually contains the class. Every other outcome — an empty `{}`, a non-200, a
 * body that will not parse, an older ComfyUI without the route, a network failure
 * — returns null and the caller falls through to the full fetch it does today,
 * unchanged. A confirmation is the one answer that cannot be wrong in the
 * dangerous direction: refusals, removal verdicts and history checks are all
 * still decided by the existing code on the existing payload.
 *
 * THIS ANSWERS ONE QUESTION, NOT EVERY QUESTION THE FULL PAYLOAD ANSWERS.
 *
 * That heading used to read "this cannot change a verdict, only the cost of reaching
 * one", and #821 is the bug that sentence licensed. It is true of the question this
 * route is FOR — `hasOwnProperty(defs, class_type)`, which is about one class and reads
 * identically either way. It is false of every question that quantifies over the whole
 * install, and the caller was asking one: `registeredSocketTypes(freshDefs)` collects the
 * output datatypes of ALL installed nodes to prove an input is a link socket. Fed a
 * single-class map it can only see this class's own outputs, so a custom datatype produced
 * by a SIBLING (SeedVR2LoadDiTModel -> `SEEDVR2_DIT`) reads as unproven and the node is
 * refused with "no installed node outputs SEEDVR2_DIT" — while that very node sits on the
 * canvas. The reply is not wrong; the question asked of it was.
 *
 * So: reuse this payload for per-class facts. Anything that ranges over the install needs
 * the whole schema, and the caller must know which one it is holding.
 *
 * The caller additionally gates this on the type ALREADY BEING REGISTERED in
 * LiteGraph, which matters for a reason that is not about speed:
 * `assertAddNodeResolvableRefreshing` passes its `freshDefs` to
 * `refreshComfyNodeDefs()` when a type needs registering, and handing a
 * single-class payload to a whole-schema refresh could deregister everything
 * else. Under that gate the resolver's refresh branch is unreachable, so a
 * partial payload can never get there — the hazard is removed by construction
 * rather than by remembering not to trip it.
 */

/** Absence is `{}` with HTTP 200 on this route, not a 404. */
export function singleDefConfirms(body, classType) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return Object.prototype.hasOwnProperty.call(body, classType);
}

/**
 * The live error scan needs to distinguish a class the server answered as absent
 * from a per-class route that did not answer. The add-node fast path deliberately
 * collapses both to null so it can fall through to its whole-schema authority; the
 * read path cannot do that because null currently reads as "node type not found".
 */
export const SINGLE_NODE_INFO_OUTCOME = Symbol.for("comfyui-mcp.singleNodeInfoOutcome");

export async function fetchSingleNodeInfo(classType, fetchApi, signal) {
  const unknown = () => ({ [SINGLE_NODE_INFO_OUTCOME]: true, kind: "unknown" });
  if (typeof classType !== "string" || classType === "") return unknown();
  if (typeof fetchApi !== "function") return unknown();
  try {
    const route = `/object_info/${encodeURIComponent(classType)}`;
    const response = signal ? await fetchApi(route, { signal }) : await fetchApi(route);
    if (!response || (typeof response.status === "number" && (response.status < 200 || response.status >= 300))) {
      return unknown();
    }
    const body = typeof response.json === "function" ? await response.json() : null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return unknown();
    if (singleDefConfirms(body, classType)) {
      return { [SINGLE_NODE_INFO_OUTCOME]: true, kind: "present", body };
    }
    // ComfyUI's per-class route answers a missing class as an empty 200 object.
    // A non-empty body naming some other class is a malformed/proxy response, not
    // evidence about the requested class.
    let empty = false;
    try {
      empty = Object.keys(body).length === 0;
    } catch {
      return unknown();
    }
    return empty
      ? { [SINGLE_NODE_INFO_OUTCOME]: true, kind: "absent" }
      : unknown();
  } catch {
    return unknown();
  }
}

/**
 * Ask the backend about ONE node type.
 *
 * @param {string} classType
 * @param {(route: string, options?: { signal?: AbortSignal }) => Promise<{ status?: number, json?: () => Promise<unknown> }>} fetchApi
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} the defs object when it CONFIRMS the type,
 *   null in every other case — including every kind of doubt.
 */
export async function fetchSingleNodeDef(classType, fetchApi, signal) {
  const outcome = await fetchSingleNodeInfo(classType, fetchApi, signal);
  return outcome.kind === "present" ? outcome.body : null;
}
