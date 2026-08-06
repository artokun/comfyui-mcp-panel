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
// A payload-less `force:true` refresh (#396) is the third case. A no-payload
// refresh triggered by a state change that JUST happened — e.g. a model download
// completing — cannot simply join an in-flight run, because that run's
// /object_info FETCH may have started BEFORE the change and so won't reflect it.
// Joining it would report success while the new file is still absent from the
// combos. So a forced call GUARANTEES a fresh registration whose fetch begins
// AFTER the current run settles. Multiple forced calls that arrive during one
// in-flight run coalesce into a SINGLE trailing run (no /object_info stampede).
//
//   getInFlight / setInFlight : accessors for the shared single-flight promise slot
//                               (module-level in the panel).
//   runRegister(preloadedDefs) : performs the actual (idempotent) registration; its
//                                own cleanup must NOT clear the slot — the coalescer
//                                owns the slot lifecycle.
export function makeRefreshCoalescer({ getInFlight, setInFlight, runRegister }) {
  // The single queued trailing (forced, no-payload) run, or null when none is
  // pending. Coalesces any number of forced calls arriving during one in-flight run.
  let trailing = null;
  const startRun = (preloadedDefs) => {
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
  return async function refresh(preloadedDefs, opts) {
    const force = !!(opts && opts.force);
    const current = getInFlight();
    if (current) {
      // No payload, not forced ⇒ joining the settled refresh is enough.
      if (preloadedDefs == null && !force) {
        try {
          await current;
        } catch {
          /* the in-flight refresh failed — a plain join still just returns */
        }
        return;
      }
      // Payload present ⇒ wait for the in-flight run, then register the NEWER
      // payload so a freshly-installed node's defs are not dropped (#289 P2).
      if (preloadedDefs != null) {
        try {
          await current;
        } catch {
          /* fall through and run our own */
        }
        return startRun(preloadedDefs);
      }
      // Forced, no payload ⇒ guarantee a fresh fetch AFTER the current run
      // settles; coalesce concurrent forced calls into ONE trailing run (#396).
      if (!trailing) {
        trailing = (async () => {
          try {
            await current;
          } catch {
            /* the in-flight refresh failed — run our own anyway */
          }
          trailing = null;
          return startRun(undefined);
        })();
      }
      return trailing;
    }
    return startRun(preloadedDefs);
  };
}
