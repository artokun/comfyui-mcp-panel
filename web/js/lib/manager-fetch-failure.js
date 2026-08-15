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
 * fact that no usable response arrived at all. That is different from Manager
 * rejecting the call: a rejection means Manager considered the request and said no.
 *
 * It does NOT mean Manager never saw it. That inference is wrong and this file used to
 * make it here — a CORS-blocked reply, a connection dropped after delivery, and a
 * proxy that failed after forwarding are indistinguishable from the browser, and in
 * each of them the request may well have been received and applied.
 *
 * ## Why that distinction is load-bearing, and how far it actually goes
 *
 * A rejection means Manager considered the request and said no; a transport failure
 * means the browser never got a usable response. Those need different next steps, and
 * collapsing both into "Failed to fetch" leaves the caller unable to choose.
 *
 * But it does NOT license "safe to re-send", which is what the first cut of this file
 * said. Review was right to kill it: "Failed to fetch" proves only that JAVASCRIPT
 * received no usable response. A CORS-blocked reply, a connection dropped after the
 * request was delivered, or a proxy that failed after forwarding all look identical
 * from here — and in every one of those the server may already have installed,
 * deleted, or queued the thing. Telling the caller to retry would duplicate the
 * mutation.
 *
 * So this says what is known (no response arrived, so there is no status or body) and
 * what is NOT known (whether the server acted), and points at the one thing that can
 * settle it: looking at the state before retrying. Naming the uncertainty is the whole
 * value; a confident wrong remedy here costs a duplicated install or a second delete.
 */

/** Is this the browser's transport-level failure (no response ever arrived)? */
export function isTransportFailure(err) {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).trim();
  // ANCHORED, and deliberately so. Review found the original substring test would
  // reclassify a Manager-ORIGINATED rejection that merely mentions one of these
  // phrases — "Package validation failed: NetworkError in dependency metadata", or
  // "fetch failed for upstream registry" — as "no response arrived". That is the
  // dangerous direction: it would attach transport advice to a request the server
  // considered and refused.
  //
  // The browser's own transport errors ARE these strings, not sentences containing
  // them, so anchoring costs nothing real. An unrecognised shape falls through to the
  // caller's own message, which is the honest outcome for an error we cannot classify.
  return TRANSPORT_MESSAGES.some((re) => re.test(msg));
}

/**
 * The messages browsers produce when no usable response arrived.
 *
 * Anchored at the START, not at both ends — an earlier version claimed in a comment to
 * tolerate appended detail while every pattern demanded an exact match, so a real
 * transport error carrying a URL or a reason fell through and lost the explanation this
 * file exists to give. (Review caught the comment contradicting the code.)
 *
 * Start-anchoring is what makes the safety hold: the dangerous case is a
 * Manager-ORIGINATED rejection that MENTIONS one of these phrases mid-sentence
 * ("Package validation failed: NetworkError in dependency metadata", "Install aborted:
 * connection refused by the pack's own installer"). Those do not BEGIN with it.
 *
 * `fetch failed` stays exact, and only it: undici's message is short enough that
 * "fetch failed for upstream registry" — a real Manager rejection shape — would
 * otherwise match. Where a prefix is ambiguous, exactness wins; where it is not,
 * tolerance wins.
 */
const TRANSPORT_MESSAGES = [
  /^failed to fetch\b/i, // Chrome
  /^networkerror when attempting to fetch resource\b/i, // Firefox
  /^load failed\b/i, // Safari
  /^fetch failed\.?$/i, // undici / Node — EXACT: a prefix match collides (see above)
  /^net::err_[a-z_]+\b/i, // Chromium net-stack text, seen via some wrappers
  /^(?:econnrefused|connection refused)\b/i,
];

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
    `TRANSPORT failure — no usable response reached the browser — so there is no HTTP ` +
    `status or response body to report (comfyui-mcp#1472). Likely causes are ComfyUI ` +
    `having stopped or restarted, the tab having lost its connection, or the Manager ` +
    `routes being blocked by a proxy. IMPORTANT: this does NOT establish that the server ` +
    `never received the request. A reply blocked by CORS, a connection dropped after ` +
    `delivery, and a proxy that failed after forwarding all look exactly like this, and ` +
    `in each of them the operation may already have been applied. Before retrying a ` +
    `MUTATING call (install, update, delete, queue), check the current state first — a ` +
    `blind retry can apply it twice. A read-only call is safe to repeat.`
  );
}
