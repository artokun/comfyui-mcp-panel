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
 * THIS CANNOT CHANGE A VERDICT, ONLY THE COST OF REACHING ONE.
 *
 * The fast path is taken only when it can CONFIRM the type: a live response that
 * actually contains the class. Every other outcome — an empty `{}`, a non-200, a
 * body that will not parse, an older ComfyUI without the route, a network failure
 * — returns null and the caller falls through to the full fetch it does today,
 * unchanged. A confirmation is the one answer that cannot be wrong in the
 * dangerous direction: refusals, removal verdicts and history checks are all
 * still decided by the existing code on the existing payload.
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
 * Ask the backend about ONE node type.
 *
 * @param {string} classType
 * @param {(route: string) => Promise<{ status?: number, json?: () => Promise<unknown> }>} fetchApi
 * @returns {Promise<object|null>} the defs object when it CONFIRMS the type,
 *   null in every other case — including every kind of doubt.
 */
export async function fetchSingleNodeDef(classType, fetchApi) {
  if (typeof classType !== "string" || classType === "") return null;
  if (typeof fetchApi !== "function") return null;
  let body;
  try {
    const res = await fetchApi(`/object_info/${encodeURIComponent(classType)}`);
    // A non-2xx is not evidence of anything about the type — an older build
    // without this route answers 404, and a proxy sign-in page answers 200 with
    // HTML. Both must reach the full fetch, not a conclusion.
    if (!res || (typeof res.status === "number" && (res.status < 200 || res.status >= 300))) {
      return null;
    }
    body = typeof res.json === "function" ? await res.json() : null;
  } catch {
    // Network failure, abort, unparseable body. All of them mean "I did not find
    // out", and this returns the value that says exactly that.
    return null;
  }
  return singleDefConfirms(body, classType) ? body : null;
}
