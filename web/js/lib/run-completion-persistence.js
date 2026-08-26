// Persisted panel_run completion metadata is a recovery ledger, not a hint.
// Only restore rows whose redundant route/session/prompt fields agree with the
// opaque completion key, and never replay a foreign workflow route through the
// route that happens to be active after a remount.

const MAX_COMPLETION_KEY_LENGTH = 512;
const MAX_COMPLETION_METADATA_ENTRIES = 256;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate the current completion-key wire shape:
 *   [workflow route, agent conversation session, prompt id, queue nonce]
 *
 * The nonce is what distinguishes a genuinely reused ComfyUI prompt id. An
 * older three-part key is not safe to adopt as the current shape because doing
 * so would erase that generation fence.
 */
export function parseRunCompletionIdentity(value) {
  const raw = text(value);
  if (!raw || raw.length > MAX_COMPLETION_KEY_LENGTH) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const routeId = text(parsed[0]);
    const promptId = text(parsed[2]);
    const nonce = text(parsed[3]);
    const sessionId = parsed[1] == null ? null : text(parsed[1]);
    if (!routeId || !promptId || !nonce || (parsed[1] != null && !sessionId)) return null;
    return { completionKey: raw, routeId, sessionId, promptId, nonce };
  } catch {
    return null;
  }
}

/** True only when a keyed completion is leaving on the route named by its key. */
export function runCompletionKeyMatchesRoute(completionKey, activeRouteId) {
  const identity = parseRunCompletionIdentity(completionKey);
  return !!identity && identity.routeId === text(activeRouteId);
}

/**
 * True only when a keyed completion belongs to the exact live route/session.
 * A route can stay unchanged while the agent conversation changes, so route
 * equality alone is not a sufficient send fence.
 */
export function runCompletionKeyMatchesContext(
  completionKey,
  activeRouteId,
  activeSessionId,
) {
  const identity = parseRunCompletionIdentity(completionKey);
  const routeId = text(activeRouteId);
  const sessionId = activeSessionId == null ? null : text(activeSessionId);
  return !!identity && identity.routeId === routeId && identity.sessionId === sessionId;
}

/** Normalize and cross-check rows read from sessionStorage. */
export function normalizeRunCompletionMetadata(
  entries,
  { maxEntries = MAX_COMPLETION_METADATA_ENTRIES } = {},
) {
  if (!Array.isArray(entries)) return [];
  const safeLimit = Math.max(0, Math.floor(Number(maxEntries) || 0));
  if (safeLimit === 0) return [];
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const identity = parseRunCompletionIdentity(entry.completionKey);
    const promptId = text(entry.promptId);
    const routeId = text(entry.routeId);
    const sessionId = entry.sessionId == null ? null : text(entry.sessionId);
    if (
      !identity ||
      !promptId ||
      !routeId ||
      (entry.sessionId != null && !sessionId) ||
      identity.promptId !== promptId ||
      identity.routeId !== routeId ||
      identity.sessionId !== sessionId ||
      seen.has(identity.completionKey)
    ) {
      continue;
    }
    seen.add(identity.completionKey);
    out.push({
      promptId,
      completionKey: identity.completionKey,
      routeId,
      sessionId,
    });
    if (out.length >= safeLimit) break;
  }
  return out;
}

/**
 * The identity of a restore CONTEXT: the workflow route plus the agent
 * conversation a set of rows belongs to. Rows are adopted by CONTEXT rather than
 * one at a time, so "has this mount already taken these rows" is a single
 * comparison that cannot drift row by row.
 */
export function runCompletionContextKey(routeId, sessionId) {
  const route = text(routeId);
  const session = sessionId == null ? null : text(sessionId);
  return JSON.stringify([route, session]);
}

/**
 * The rows that no ADOPTED context owns — the set to merge back on every write.
 *
 * This replaces a mount-time `partitionRunCompletionMetadata(...).deferred`
 * snapshot. That snapshot is frozen and the live route is not: the moment a
 * mount adopts a second route's rows (because the user switched the canvas
 * without remounting), the snapshot still calls those rows foreign and merges
 * them into every later write — resurrecting rows the tracker has since retired,
 * so a later mount replays a completion the agent was already given.
 *
 * Re-reading storage here is what keeps "foreign" a live question. A row is
 * foreign because NOTHING in this mount owns it, never because of where the
 * route happened to be at the instant the panel mounted.
 */
export function selectDeferredRunCompletionMetadata(entries, adoptedContextKeys) {
  const adopted =
    adoptedContextKeys instanceof Set ? adoptedContextKeys : new Set(adoptedContextKeys || []);
  return normalizeRunCompletionMetadata(entries).filter(
    (entry) => !adopted.has(runCompletionContextKey(entry.routeId, entry.sessionId)),
  );
}

/**
 * Split persisted rows at remount. Only the active workflow route is safe to
 * reconcile now; foreign rows remain durable for a later mount of their route.
 *
 * #1839 — "a later mount" was the load-bearing assumption, and it is wrong: the
 * route moves under a LIVE mount every time the user switches workflow tab, with
 * no remount at all. So this is not a once-per-mount computation. Callers re-run
 * it against the route that is live at the MOMENT OF RESTORE (see
 * `rehydrateRunCompletionForLiveRoute` in the panel) and record what they took
 * with `runCompletionContextKey`. Re-computing is the fix; widening what counts
 * as current would replay a row onto a canvas the user is not looking at, which
 * is worse than the bug this partition exists to prevent.
 */
export function partitionRunCompletionMetadata(entries, activeRouteId, activeSessionId) {
  const routeId = text(activeRouteId);
  const sessionId = activeSessionId == null ? null : text(activeSessionId);
  const current = [];
  const deferred = [];
  for (const entry of normalizeRunCompletionMetadata(entries)) {
    (routeId && entry.routeId === routeId && entry.sessionId === sessionId ? current : deferred).push(entry);
  }
  return { current, deferred };
}

/** Merge the live tracker's snapshot with untouched foreign-route rows. */
export function mergeRunCompletionMetadata(current, deferred) {
  return normalizeRunCompletionMetadata([
    ...(Array.isArray(current) ? current : []),
    ...(Array.isArray(deferred) ? deferred : []),
  ]);
}
