/**
 * comfyui-mcp#1472 — `panel_install_node` failed with bare "Failed to fetch".
 *
 * The reporter got exactly that string and nothing else: no endpoint, no status, no
 * body, so the install could not be diagnosed from the tool result at all.
 *
 * ## Why there is no status or body to report
 *
 * "Failed to fetch" is what the browser throws when the request never COMPLETED —
 * blocked, refused, DNS, a dropped connection, a CORS rejection. There is no HTTP
 * response, so status and body do not exist. An error that promises them here would
 * be inventing them.
 *
 * What DOES exist, and was being thrown away, is which route was attempted and the
 * fact that this is a transport failure rather than a Manager rejection. Those are
 * different problems with different next steps: a rejection means Manager considered
 * the request and said no; a transport failure means Manager never saw it.
 *
 * ## Why that distinction is load-bearing
 *
 * A mutation that never reached the server may be safely re-sent. One that was
 * rejected must not be blindly retried. Collapsing both into "Failed to fetch" leaves
 * the caller unable to choose — which is precisely what the reporter asked for.
 */

/** Is this the browser's transport-level failure (no response ever arrived)? */
export function isTransportFailure(err) {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /failed to fetch|networkerror|load failed|fetch failed|err_network|connection refused/i.test(
    msg,
  );
}

/**
 * What to say when a Manager call threw before any response arrived.
 *
 * `route` is the path that was attempted (without the `/v2/` prefix the caller adds).
 */
export function managerFetchFailureMessage(route, err) {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const path = `/v2/${String(route ?? "").replace(/^\/+/, "")}`;
  if (!isTransportFailure(err)) {
    // Not a transport failure — keep whatever it actually was, plus the route it was
    // attempted against. Never relabel an error whose shape is not recognised.
    return `ComfyUI-Manager request to ${path} failed: ${raw || "no message"}.`;
  }
  return (
    `ComfyUI-Manager request to ${path} did not complete: ${raw || "no message"}. This is a ` +
    `TRANSPORT failure — the browser could not reach the server — so there is no HTTP status ` +
    `or response body to report, and ComfyUI-Manager never saw this request ` +
    `(comfyui-mcp#1472). That is different from Manager rejecting it: nothing was ` +
    `considered and nothing was applied. Likely causes are ComfyUI having stopped or ` +
    `restarted, the browser tab having lost its connection, or the Manager routes being ` +
    `blocked by a proxy. Check ComfyUI is running and the tab is connected, then retry — ` +
    `a request the server never received is safe to re-send.`
  );
}
