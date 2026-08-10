/**
 * #954 — a transient /object_info failure is not a refusal.
 *
 * Reported: after a restart-related operation, `panel_refresh_nodes` came back
 * `{refreshed:false, reason:"object_info_fetch_failed", detail:"Failed to fetch"}` while
 * `list_local_models` succeeded moments later against the same server. One attempt landing
 * inside a reconnect window produced a permanent-sounding verdict for a condition that
 * clears on its own — and the remedy it printed ("check that the ComfyUI server process is
 * still running") sends the user after a server that was never down.
 *
 * The startup baseline seed already retries getNodeDefs for exactly this reason. The
 * refresh path did not, so the same flake was survivable at page load and fatal to a tool
 * call.
 *
 * BOUNDED, because this blocks a tool call: three attempts, 800ms of added WAITING at most.
 * That bounds the backoff, not the total — the three requests can each take as long as the
 * network makes them (codex). What it buys is that a blip costs under a second of sleeping. Long enough to cross a reconnect blip, short enough that a genuinely dead
 * backend still answers quickly with the honest failure rather than hanging the agent.
 */

/** Waits between attempts. Two entries = three attempts. */
export const OBJECT_INFO_RETRY_DELAYS_MS = [200, 600];

/**
 * Is this result worth another attempt?
 *
 * An empty or non-object payload counts as a failure, not as "the server has no nodes".
 * ComfyUI always defines nodes; an empty map means the response was not the one asked for
 * — the same rule the startup seed applies (`Object.keys(defs).length > 0`). Treating it as
 * success would poison the registration path with a definition set that omits everything.
 */
export function objectInfoLooksTransient(defs) {
  return !defs || typeof defs !== "object" || Object.keys(defs).length === 0;
}

/**
 * Fetch node definitions, retrying a transient failure.
 *
 * @param {() => Promise<any>} getDefs the frontend's `api.getNodeDefs`, already bound
 * @param {{delays?: number[], sleep?: (ms: number) => Promise<void>}} [opts]
 *   `sleep` is injectable so tests run instantly and deterministically instead of
 *   depending on real timers.
 * @returns {Promise<any>} the definitions
 * @throws the LAST error, when every attempt threw — so the caller's verdict still reports
 *   `object_info_fetch_failed` with a real `detail`, exactly as before. Retrying must not
 *   convert a genuine outage into a different, vaguer failure.
 */
export async function fetchNodeDefsWithRetry(getDefs, { delays = OBJECT_INFO_RETRY_DELAYS_MS, sleep } = {}) {
  const wait = typeof sleep === "function" ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const steps = Array.isArray(delays) ? delays : OBJECT_INFO_RETRY_DELAYS_MS;
  let lastError;
  let lastValue;
  for (let attempt = 0; attempt <= steps.length; attempt++) {
    try {
      const defs = await getDefs();
      if (!objectInfoLooksTransient(defs)) return defs;
      lastValue = defs;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    if (attempt < steps.length) await wait(steps[attempt]);
  }
  // Every attempt finished and none produced usable definitions.
  if (lastError !== undefined) throw lastError;
  // Exhausted on empty rather than on a throw: hand the empty payload back so the caller
  // classifies it exactly as it did before this retry existed. Inventing an error here
  // would change a verdict the caller already words carefully.
  return lastValue;
}
