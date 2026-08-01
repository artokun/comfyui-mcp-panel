// The OBSERVED-BACKEND-HISTORY trust root for the #458 write/add guards, extracted so
// the exact fail-closed rules are unit-testable instead of living as loose module state
// in the 20k-line panel bundle.
//
// WHAT IT IS: the session-scoped set of every node class_type that has appeared in ANY
// backend /object_info response during this session. A type ABSENT from the CURRENT
// /object_info that was EVER seen here is a REMOVED backend node (pack uninstalled) and
// must be refused — a client husk cannot un-see what the backend already reported. A type
// NEVER seen is genuinely frontend-only (Note/MarkdownNote/Reroute/…) and may be exempted.
// This is the one signal the guards' client-side allowlist and provenance markers cannot
// forge, so the whole frontend-only exemption in node-resolve.js rests on it.
//
// THE TWO FAIL-CLOSED RULES (both learned from adversarial review):
//
//   1. UNSEEDED ⇒ CLOSED. Until at least one authoritative /object_info observation has
//      been recorded as a BASELINE, "never seen" means nothing, so wasTypeEverDefined
//      reports EVERY absent-from-current type as removed. A failed seed therefore never
//      opens a hole; it only refuses more.
//
//   2. BASELINE LOST ⇒ LATCHED CLOSED FOR THE SESSION. Once the STARTUP baseline is
//      missed — the seed failed, or a tool bounded its wait and gave up — there is a
//      window we never observed, and NO later observation can prove a type was "never
//      defined earlier this session": the removal may have happened inside that window.
//      So after loseBaseline() nothing may mark the history seeded, not even a successful
//      reconnect/refresh_nodes re-register. Reloading the tab is what re-establishes a
//      real baseline. (Without this latch: startup fetch hangs → pack removed during the
//      wait → a later fetch installs the POST-removal map as the baseline → a
//      provenance-stripped husk squatting a reserved allowlisted name reads "never seen"
//      and is exempted — the exact hole the ever-seen gate exists to close.)
//
// recordTypes() is deliberately NOT latched: recording can only ever ADD evidence that a
// type existed, which can only ever make the gate refuse MORE. Only the "this history is
// trustworthy enough to conclude never-seen" claim is latched.

export function createObjectInfoHistory() {
  const seen = new Set();
  let seeded = false;
  let baselineLost = false;

  return {
    /** Record every class_type in a real /object_info payload. Returns `defs` unchanged
     *  so it can wrap a fetch inline. A null/non-object payload records nothing. */
    recordTypes(defs) {
      if (defs && typeof defs === "object") {
        for (const key of Object.keys(defs)) seen.add(key);
      }
      return defs;
    },

    /** Promote the recorded history to a trustworthy BASELINE. A no-op once the baseline
     *  has been lost — that is rule 2, and it is the whole point of this module. */
    markSeeded() {
      if (baselineLost) return false;
      seeded = true;
      return true;
    },

    /** Latch: we reached a guard without a trustworthy baseline. IRREVERSIBLE, and it
     *  also DEMOTES any existing baseline, so the invariant is the simple one — any
     *  admitted observation gap closes the gate for the session, no case analysis about
     *  which side of the gap the baseline fell on. In practice the panel only calls this
     *  when the history is already unseeded (the waiter returns early when it is seeded),
     *  so a healthy session never reaches it. */
    loseBaseline() {
      baselineLost = true;
      seeded = false;
    },

    /** The oracle the #458 guards inject. TRUE ⇒ "treat as defined earlier this session",
     *  which for a type absent from the CURRENT /object_info means REMOVED ⇒ refuse. */
    wasTypeEverDefined(type) {
      return !seeded || seen.has(type);
    },

    get seeded() {
      return seeded;
    },
    get baselineLost() {
      return baselineLost;
    },
    /** Test/diagnostic view of the recorded set. */
    has(type) {
      return seen.has(type);
    },
  };
}
