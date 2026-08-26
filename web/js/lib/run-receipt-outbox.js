// Exact graph_run prompt receipts are control metadata, not agent events. Keep
// them at-least-once across a closed/stale bridge route; the MCP side deduplicates
// by run rid + prompt id before opening an idempotent completion ticket.

export const RUN_RECEIPT_RETRY_MS = 250;
export const RUN_RECEIPT_TTL_MS = 60_000;
export const RUN_RECEIPT_MAX_ENTRIES = 256;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Mount-independent receipt delivery. The transport is replaceable so an old
 * graph_run callback can enqueue into the new mount after a remount, while the
 * target route captured at dispatch prevents that receipt being sent to a
 * different workflow tab.
 */
export function createRunReceiptOutbox({
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
  retryMs = RUN_RECEIPT_RETRY_MS,
  ttlMs = RUN_RECEIPT_TTL_MS,
  maxEntries = RUN_RECEIPT_MAX_ENTRIES,
} = {}) {
  const pending = new Map();
  let transport = null;
  let retryTimer = null;

  const keyFor = (routeId, runRid, promptId) => `${routeId}\u0000${runRid}\u0000${promptId}`;

  function clearRetry() {
    if (retryTimer === null) return;
    try {
      clearTimer(retryTimer);
    } catch {
      // A stale timer can only wake an empty/updated queue; keep delivery alive.
    }
    retryTimer = null;
  }

  function scheduleRetry() {
    if (retryTimer !== null || !pending.size || !transport) return;
    try {
      retryTimer = setTimer(() => {
        retryTimer = null;
        flush();
      }, retryMs);
    } catch {
      // A timer source is not guaranteed in the test shell. The next route
      // notification or enqueue remains an explicit retry opportunity.
      retryTimer = null;
    }
  }

  function flush() {
    if (!pending.size) {
      clearRetry();
      return;
    }
    if (!transport) return;
    const current = now();
    for (const [key, entry] of pending) {
      if (current - entry.createdAt > ttlMs) {
        pending.delete(key);
        continue;
      }
      let liveRoute = "";
      try {
        liveRoute = text(transport.routeId?.());
      } catch {
        liveRoute = "";
      }
      // A live route id is not enough while a workflow re-advertise is parked:
      // sendFrame can write a stamped frame before the socket's binding has
      // caught up. The bridge supplies this readiness fence for the real
      // transport; test/minimal transports may omit it.
      let routeReady = true;
      try {
        routeReady = transport.ready?.() !== false;
      } catch {
        routeReady = false;
      }
      // Never send an old dispatch's receipt on a replacement workflow route.
      if (!routeReady || !liveRoute || liveRoute !== entry.routeId) continue;
      let sent = false;
      try {
        sent = transport.sendFrame?.({
          type: "run_receipt",
          run_rid: entry.runRid,
          prompt_id: entry.promptId,
          ...(entry.completionKey ? { completion_key: entry.completionKey } : {}),
        }) === true;
      } catch {
        sent = false;
      }
      // sendFrame's true means bytes reached the currently open socket. False
      // means closed/no-route/stale-route; retain and retry. Duplicate frames
      // are harmless because the server map merges prompt ids by rid.
      if (sent) pending.delete(key);
    }
    if (pending.size) scheduleRetry();
    else clearRetry();
  }

  return {
    enqueue(runRid, promptId, routeId, completionKey = null) {
      const rid = text(runRid);
      const pid = text(promptId);
      const route = text(routeId);
      if (!rid || !pid || !route) return false;
      const key = keyFor(route, rid, pid);
      if (!pending.has(key)) {
        if (pending.size >= maxEntries) {
          const oldest = pending.keys().next();
          if (!oldest.done) pending.delete(oldest.value);
        }
        pending.set(key, {
          routeId: route,
          runRid: rid,
          promptId: pid,
          ...(typeof completionKey === "string" && completionKey.trim()
            ? { completionKey: completionKey.trim() }
            : {}),
          createdAt: now(),
        });
      }
      flush();
      return !pending.has(key);
    },
    setTransport(next) {
      transport = next && typeof next === "object" ? next : null;
      if (!transport) {
        clearRetry();
        return;
      }
      flush();
    },
    notifyRouteReady() {
      flush();
    },
    pendingSize() {
      return pending.size;
    },
    clearPending() {
      pending.clear();
      clearRetry();
    },
  };
}
