// Coalesces overlapping node-def refreshes so a caller-supplied FRESH /object_info
// payload is never DROPPED by joining an OLDER in-flight refresh (#289 P2).
//
// The panel keeps a SINGLE in-flight refresh promise so concurrent triggers (a
// websocket reconnect + a graph_add_node) don't stampede registerNodesFromDefs.
// The naive "if in-flight, return it" dedupe silently drops a newer payload:
// graph_add_node fetches fresh /object_info (containing a just-installed NewNode)
// and calls refresh(freshDefs), but if a reconnect refresh carrying an OLDER
// payload is already running, joining it leaves NewNode unregistered and the add
// re-check fails — a false "unknown node type" for a genuinely-installed node.
//
// This coordinator fixes that: with NO payload, joining the in-flight refresh is
// enough. With a payload, it WAITS for the in-flight refresh to settle, THEN runs a
// fresh refresh that registers the newer payload — so the payload is never dropped.
//
//   getInFlight / setInFlight : accessors for the shared single-flight promise slot
//                               (module-level in the panel).
//   runRegister(preloadedDefs) : performs the actual (idempotent) registration; its
//                                own cleanup must NOT clear the slot — the coalescer
//                                owns the slot lifecycle.
export function makeRefreshCoalescer({ getInFlight, setInFlight, runRegister }) {
  return async function refresh(preloadedDefs) {
    const current = getInFlight();
    if (current) {
      try {
        await current;
      } catch {
        /* the in-flight refresh failed — fall through and run our own */
      }
      // No specific payload to guarantee ⇒ joining the settled refresh is enough.
      if (preloadedDefs == null) return;
      // Otherwise fall through: register the NEWER payload now the older run settled,
      // so a freshly-installed node's defs are not dropped (#289 P2).
    }
    const p = (async () => {
      try {
        return await runRegister(preloadedDefs);
      } finally {
        // Clear the slot only if it still points at THIS run (a later run may have
        // already replaced it).
        if (getInFlight() === p) setInFlight(null);
      }
    })();
    setInFlight(p);
    return p;
  };
}
