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
 * @param {{delays?: number[], sleep?: (ms: number) => Promise<void>,
 *          shouldRetry?: (err: any) => boolean}} [opts]
 *   `sleep` is injectable so tests run instantly and deterministically instead of
 *   depending on real timers.
 *
 *   `shouldRetry` exists because #1180 gave callers a way to fail that costs something.
 *   This schedule was sized for attempts that fail INSTANTLY — a connection refused while
 *   the backend restarts — where another attempt is free: no bytes moved, so spreading
 *   three of them over 800ms only widens the window a blip can hide in. An attempt
 *   abandoned by a TIMEOUT is the opposite: `withTimeout` does not cancel, so the first
 *   attempt is still downloading the whole document while the second starts, and each
 *   retry makes the link it is retrying on slower. One schedule cannot serve both, and
 *   picking a single compromise number for them is how this issue's earlier attempt lost
 *   #954's case. The caller says which kind of failure it just saw.
 * @returns {Promise<any>} the definitions
 * @throws the LAST error, when every attempt threw — so the caller's verdict still reports
 *   `object_info_fetch_failed` with a real `detail`, exactly as before. Retrying must not
 *   convert a genuine outage into a different, vaguer failure.
 */
export async function fetchNodeDefsWithRetry(
  getDefs,
  { delays = OBJECT_INFO_RETRY_DELAYS_MS, sleep, shouldRetry } = {},
) {
  const wait = typeof sleep === "function" ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const steps = Array.isArray(delays) ? delays : OBJECT_INFO_RETRY_DELAYS_MS;
  const retryable = typeof shouldRetry === "function" ? shouldRetry : () => true;
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
      // Stop NOW, not after sleeping: a failure the caller calls un-retryable is one whose
      // work is still running, and waiting only lets it overlap whatever comes next.
      if (!retryable(err)) throw err;
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
