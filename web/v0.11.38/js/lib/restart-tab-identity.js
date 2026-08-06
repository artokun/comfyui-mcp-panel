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
 */
export function createRestartTabIdentity({
  storage = globalThis.sessionStorage,
  locks = globalThis.navigator?.locks,
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  let memoryFallback;
  let resolved;
  let resolving;
  let releaseLease;

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
    })();
    return resolving;
  }

  return { resolve, fallback, releaseForTests: () => releaseLease?.() };
}

/** Send the real hello only after restart identity exclusivity is complete. */
export async function sendBridgeHello({ socket, isCurrent, resolveTabIdentity, makePayload }) {
  const tabSessionId = await resolveTabIdentity();
  if (!isCurrent()) return false;
  socket.send(JSON.stringify(makePayload(tabSessionId)));
  return true;
}
