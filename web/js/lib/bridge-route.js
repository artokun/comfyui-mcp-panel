// Per-browser-tab BRIDGE ROUTE identity (#640).
//
// The bridge delivers a frame to a browser tab by the `tab_id` that tab helloed
// with: ui-bridge keeps ONE connection per tab id, so a second hello carrying an
// id that is already registered TAKES OVER the route. The panel's saved-workflow
// handle is path-only (`wf:<path>`), so two browser tabs showing the same file
// helloed with the SAME id — the later one silently stole the route, and the
// agent's commands were delivered to the other tab's canvas. The workflow-UUID
// instance fence caught the ones that carry a UUID to check; that is the LAST
// line of defence, not the first, and it never sees a command that carries none.
//
// A route therefore has to name the TAB, not the file. This module owns that id
// and the rule for when it may be used: an id is usable only once it has been
// ESTABLISHED, and an unestablished identity REFUSES the route rather than
// falling back to the path. A path fallback would re-create the collision in
// exactly the case where the tab's identity is hardest to pin down.
//
// Deliberately NOT the same thing as the panel's workflow handle. The handle
// (`wf:<path>` / `tmp:<uuid>`, reported as `routing_key`) names a workflow
// WITHIN one tab and is resolved only against that tab's own open workflows, so
// a path is an unambiguous handle there. The route names the tab on the wire.

const ROUTE_PREFIX = "wf:";
const ROUTE_SEP = ":";

function trimmed(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The saved-workflow HANDLE: `wf:<path>`.
 *
 * This names the workflow, not the tab, and it is deliberately still path-only:
 * it is resolved against ONE tab's own open workflows (as a selector) and read
 * by the orchestrator as the exact saved identity that authorizes a command-fence
 * refresh after an open. It is NOT a bridge route — see savedWorkflowRoute.
 *
 * It lives here so the panel spells the format exactly once. It previously had
 * two independent spellings, one on the dispatch side and one on the reply side,
 * and the reply's `active` flag is decided by comparing the two: had either been
 * changed alone, every workflow_list record would have reported active:false and
 * the agent would have been told no tab is active.
 */
export function savedWorkflowHandle(savedPath) {
  const path = trimmed(savedPath);
  return path ? ROUTE_PREFIX + path : null;
}

/**
 * Compose the bridge route for a SAVED workflow: `wf:<tabRouteId>:<path>`.
 *
 * Both halves must be present. With no established tab id there is no route,
 * and emitting the bare path instead is the collision this exists to prevent —
 * so this returns null (REFUSE) rather than degrade. A `:` inside the tab id is
 * refused too, so `<tab>:<path>` can never be read two different ways.
 */
export function savedWorkflowRoute(tabRouteId, savedPath) {
  const tab = trimmed(tabRouteId);
  const path = trimmed(savedPath);
  if (!tab || !path) return null;
  if (tab.includes(ROUTE_SEP)) return null;
  return ROUTE_PREFIX + tab + ROUTE_SEP + path;
}

/**
 * Holds this browser tab's route id.
 *
 * `adopt` is the ONLY way a value is ever recorded, and it is called with the
 * RESULT of the Web Locks lease the hello already awaits — never before it, and
 * never with a value the resolver has not actually returned. Three outcomes,
 * two of which are usable:
 *
 *  - a leased id ("exclusive"): the lock manager proved no other tab in this
 *    origin holds it, which is the only thing that also covers a DUPLICATED tab
 *    (browser tab duplication copies sessionStorage verbatim).
 *
 *  - a freshly minted, NEVER-PERSISTED id ("page-instance"), used only when Web
 *    Locks does not exist in this context at all. The panel deliberately
 *    supports ComfyUI served over plain http:// on a LAN, where
 *    `navigator.locks` is undefined because the API is secure-context-only —
 *    the same reason the panel ships a crypto.randomUUID polyfill (itself
 *    backed by crypto.getRandomValues, which is not secure-context gated).
 *    Refusing outright here would take every LAN panel offline.
 *
 *    It is minted per PAGE LOAD and written nowhere. That is what makes it
 *    safe: browser tab duplication copies sessionStorage verbatim, so the
 *    stored per-tab id is exactly the value two duplicated tabs would share —
 *    reading it here would have re-created the #640 collision in the one mode
 *    that cannot detect it. A value that has never left this page's heap cannot
 *    be copied into another tab.
 *
 *    The cost is route stability, not uniqueness: a reload mints a new id, so
 *    the orchestrator's tab-id-keyed session index misses and the conversation
 *    is restored by the panel's own `hello.resume` (sessionStorage) instead.
 *    Losing a resume is recoverable; delivering a command to the wrong canvas
 *    is not.
 *
 *  - no id: Web Locks IS present and refused every candidate. That is live
 *    contention — another tab in this origin holds the identity — so nothing is
 *    recorded and the route is REFUSED.
 *
 * Once established the id is frozen for the life of the page: the route keys the
 * tab's agent session on the orchestrator, and silently re-keying it mid-session
 * would strand that session behind a route nothing answers on.
 */
export function createTabRouteIdentity({ locksAvailable, mintPageInstanceId } = {}) {
  let established = null;
  let settled = false;

  return {
    /** Synchronous read. Null until an identity has ACTUALLY been established. */
    established: () => established,
    /** "exclusive" | "page-instance" | null — what the id above is backed by. */
    proof: () => established?.proof ?? null,
    /**
     * Has a lease attempt COMPLETED? Distinguishes "no identity yet, resolution
     * is still in flight" from "resolution finished and established nothing".
     * Both refuse the route, but only the second one knows why — and saying
     * "another tab holds your identity" while the lease is still pending would
     * state a cause that has not been determined.
     */
    settled: () => settled,

    /**
     * Record the identity for this page from a COMPLETED lease attempt.
     * Returns the established record, or null when it could not be established
     * (in which case nothing is recorded — callers must refuse to route).
     */
    adopt(leasedId) {
      // The caller reaches here only with a resolved lease result, so the
      // attempt is over whichever way it went.
      settled = true;
      if (established) return established;

      const leased = trimmed(leasedId);
      if (leased) {
        established = { id: leased, proof: "exclusive" };
        return established;
      }

      // No lease. Distinguish "the lock manager said no or could not answer"
      // from "this context has no lock manager at all" (capability absent).
      // Only the second may mint a page-instance id; the first is a failure to
      // establish and must refuse. A probe that throws is NOT evidence the API
      // is missing — "could not determine" is not "determined it is absent" —
      // so an unreadable probe is treated as present and refuses.
      let available = true;
      try {
        available = !!locksAvailable?.();
      } catch {
        available = true;
      }
      if (available) return null;

      let minted = null;
      try {
        minted = trimmed(mintPageInstanceId?.());
      } catch {
        minted = null;
      }
      if (!minted) return null;

      established = { id: minted, proof: "page-instance" };
      return established;
    },
  };
}

/**
 * Why a route was refused, for the panel's system log. Nothing was dispatched in
 * either case, so this is a refusal notice, not a disclosure of something done.
 *
 * `settled` separates the two states. Reporting contention while the lease is
 * still in flight would name a cause that has not been determined — "could not
 * determine which tab holds this identity" is not "another tab holds it".
 */
export function describeRefusedRoute({ settled = true } = {}) {
  if (!settled) {
    return (
      "This ComfyUI tab is still establishing its own bridge route, so the panel did NOT send " +
      "that — nothing ran. Retry in a moment. Sending on a route this tab has not established " +
      "yet could reach another browser tab's canvas."
    );
  }
  // What IS determined is that the lock manager did not grant this page an
  // exclusive identity. WHY it did not is not determined: contention with
  // another tab is the usual cause, but a lock request that rejects or throws
  // lands here identically. Report the outcome, offer the cause as the likely
  // one, and do not assert it.
  return (
    "This ComfyUI tab could not establish its own bridge route, so the panel did NOT register " +
    "with the agent and nothing has run. Most often another browser tab in this origin is " +
    "holding this tab's identity — close the duplicate tab, then reload this one and " +
    "reconnect. Registering anyway would share one route between two tabs, and the agent's " +
    "commands could run against the other tab's canvas."
  );
}
