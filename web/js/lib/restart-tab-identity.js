// Browser-tab identity for #709 restart readiness. sessionStorage supplies a
// reload-stable candidate, but duplicated browser tabs can copy it. We therefore
// require an origin-wide Web Locks lease before ever advertising that candidate.

export const RESTART_TAB_ID_STORAGE_KEY = "comfyui-mcp.panel.tabSessionId";
const LOCK_PREFIX = "comfyui-mcp.panel.restart-tab-identity.v1:";

function nonBlank(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve an identity suitable for certifying that the browser tab which
 * received a restart is the one which reconnected. A returned ID is backed by
 * an exclusive Web Locks lease held for this page's lifetime. If that cannot be
 * acquired, return undefined so the hello omits the identity and MCP readiness
 * fails closed. There is intentionally no timeout-as-proof fallback.
 *
 * A SUCCESS is cached for the life of the page. A FAILURE is retryable (#654):
 * once `retryBackoffMs` has elapsed, the next resolve() runs a fresh lease
 * attempt, so a tab that lost a transient contention window re-registers
 * without a manual browser refresh once the lease becomes acquirable.
 */
export function createRestartTabIdentity({
  storage = globalThis.sessionStorage,
  locks = globalThis.navigator?.locks,
  randomUUID = () => globalThis.crypto.randomUUID(),
  now = () => Date.now(),
  retryBackoffMs = 5000,
} = {}) {
  let memoryFallback;
  let resolved;
  let resolving;
  let releaseLease;
  // #654 — the timestamp of the last FAILED resolution. A failed resolve used to
  // be cached for the LIFE of the page (the settled `resolving` promise was never
  // cleared), so one contested lease window wedged the tab's registration until a
  // manual browser refresh — even after the contending tab closed and the lease
  // became acquirable. A failure is now retryable once per backoff window.
  // `null` (not 0) is the never-failed sentinel: a failure recorded at timestamp
  // 0 must still count as a failure (codex gate r2).
  let lastFailureAt = null;

  const fallback = () => (memoryFallback ??= randomUUID());
  const read = () => {
    try {
      return nonBlank(storage?.getItem(RESTART_TAB_ID_STORAGE_KEY));
    } catch {
      return undefined;
    }
  };
  const write = (value) => {
    try {
      storage?.setItem(RESTART_TAB_ID_STORAGE_KEY, value);
    } catch {
      // Storage-disabled pages may still use their stable in-memory candidate,
      // but only for this loaded page and only with an acquired lock lease.
    }
  };

  async function acquire(candidate) {
    if (!locks || typeof locks.request !== "function") return false;
    let settle;
    const acquired = new Promise((resolve) => { settle = resolve; });
    try {
      void locks.request(
        LOCK_PREFIX + candidate,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            settle(false);
            return;
          }
          // Keep the lease until the browser page unloads. The resolver does
          // not expose release: an early release could let a duplicate tab
          // certify itself with the copied identity while this page is live.
          await new Promise((resolve) => {
            releaseLease = resolve;
            settle(true);
          });
        },
      ).catch(() => settle(false));
      return await acquired;
    } catch {
      return false;
    }
  }

  async function resolve() {
    if (resolved) return resolved;
    if (resolving) return resolving;
    // #654 — a FAILED resolution is not a life sentence: the lease may become
    // acquirable later (the contending duplicate tab closed), and nothing else
    // re-runs this resolver, so refusing to retry here is what forced the manual
    // browser refresh. Re-attempt at most once per backoff window; inside the
    // window, fail closed with the same undefined the first failure returned.
    if (lastFailureAt != null && now() - lastFailureAt < retryBackoffMs) return undefined;
    resolving = (async () => {
      let candidate = read() ?? fallback();
      write(candidate);
      // The existing storage candidate can be held by a duplicated browser
      // tab. Rotate only after failed exclusivity, and require a NEW positive
      // lease before accepting the replacement too.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await acquire(candidate)) {
          resolved = candidate;
          return resolved;
        }
        candidate = randomUUID();
        write(candidate);
      }
      return undefined;
    })()
      // A REJECTED attempt (a lock manager whose request promise rejects, a
      // throwing randomUUID) must degrade to the same retryable failure as a
      // refused lease — never a cached rejection every later caller re-throws
      // (that was the page-lifetime wedge all over again, codex gate P1).
      .catch(() => undefined)
      // Stamp the failure INSIDE the chain, BEFORE the slot is cleared: a caller
      // arriving between the clear and the stamp would otherwise see neither
      // and start a fresh attempt, bypassing the backoff (codex gate r2).
      .then((outcome) => {
        if (outcome === undefined) lastFailureAt = now();
        return outcome;
      })
      // Clear the in-flight slot so a LATER call may retry after a failure (a
      // success is cached in `resolved`, which short-circuits above).
      .finally(() => {
        resolving = null;
      });
    return resolving;
  }

  return { resolve, fallback, releaseForTests: () => releaseLease?.() };
}

/** Send the real hello only after restart identity exclusivity is complete. */
export async function sendBridgeHello({ socket, isCurrent, resolveTabIdentity, makePayload }) {
  const tabSessionId = await resolveTabIdentity();
  if (!isCurrent()) return false;
  // #640 — makePayload REFUSES (returns null) when this browser tab's bridge
  // route could not be established. A hello is what REGISTERS the route, and
  // registering one this tab cannot claim exclusively is the whole defect: the
  // bridge keeps one connection per tab id, so the second hello takes the route
  // over and the agent's commands land on the other tab's canvas. Refuse before
  // dispatch rather than disclose after it. Returning false also keeps the
  // caller from advancing the agent-session epoch for a hello that never left.
  const payload = makePayload(tabSessionId);
  if (!payload) return false;
  socket.send(JSON.stringify(payload));
  return true;
}
