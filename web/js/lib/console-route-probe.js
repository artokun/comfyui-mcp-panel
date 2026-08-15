/**
 * #703 — decide whether the orchestrator's console actually serves a route,
 * before offering a button that opens it.
 *
 * The connection popover's "Prompts" button opens `<console>/prompts`, a page
 * that was never built: the orchestrator registers no `/prompts` page route and
 * no `/api/prompts` data route. Clicking it opened a new tab showing
 * `{"ok":false,"error":"not_found"}`, which reads like the running server is
 * broken rather than like a feature that does not exist yet.
 *
 * FAILS BACK TO AVAILABLE, deliberately. Only a definitive 404 disables the
 * button. A network error, a timeout, an opaque response or an unreachable
 * console all resolve to "available", because none of them is evidence the route
 * is missing — and disabling a working button because the probe itself failed
 * would be a false refusal, which is the worse error. The 404 page is a nuisance;
 * a button that vanishes on a flaky probe is a bug report.
 *
 * FORWARD-COMPATIBLE. The day the console starts serving `/prompts`, the probe
 * stops returning 404 and the button starts working with no further change.
 */

/** Probe timeout. Short: this runs while a popover is being built, and a slow
 *  console must not delay the UI. Expiry resolves to "available" per above. */
const PROBE_TIMEOUT_MS = 2500;

/**
 * @returns {Promise<{available: boolean, reason: string}>}
 *   `available:false` ONLY on a definitive 404.
 */
export async function probeConsoleRoute(url, { fetchImpl, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof url !== "string" || !url) return { available: true, reason: "no-url" };
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { available: true, reason: "no-fetch" };

  let timer = null;
  try {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    if (ctrl && typeof setTimeout === "function") {
      timer = setTimeout(() => {
        try {
          ctrl.abort();
        } catch {
          /* aborting is best-effort */
        }
      }, timeoutMs);
    }
    const res = await doFetch(url, {
      method: "GET",
      credentials: "same-origin",
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    // No response object at all tells us nothing about the route.
    if (!res || typeof res.status !== "number") return { available: true, reason: "no-status" };
    if (res.status === 404) return { available: false, reason: "not-found" };
    return { available: true, reason: `status-${res.status}` };
  } catch {
    // Aborted, offline, CORS, DNS — none of these is evidence of a missing route.
    return { available: true, reason: "probe-failed" };
  } finally {
    if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer);
  }
}

/** The tooltip for a button whose console page this build does not serve. Says
 *  what is true (not built here) rather than implying a fault in the server. */
export const UNBUILT_ROUTE_TITLE =
  "The prompt editor isn't available in this build — this orchestrator doesn't serve the prompts console page yet.";
