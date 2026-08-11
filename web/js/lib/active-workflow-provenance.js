// #968 — WHAT last moved the active workflow.
//
// Three reports describe the same shape: the fence reports bound to the requested workflow
// while graph commands keep hitting the previously active one — silent wrong-graph edits,
// and in one case a wrong-workflow RUN. They have not converged, and the reason is that
// after the fact a STALE binding and a FRESH one look identical: both are "the active
// workflow is X", with nothing recording how it came to be X.
//
// What was ruled out first, so this is not another guess:
//
//   * `panel_open_workflow` forces the canvas repaint itself and verifies it with a content
//     proof, and both of its skip paths fail CLOSED. `opened` + wrong-graph is not reachable
//     through the executor's own branches.
//   * The forced repaint predates every reported build, and the content proof shipped in
//     0.11.96 — while the report where `panel_run` queued the wrong workflow was on 0.11.98.
//     It had both protections and desynced anyway.
//
// So the binding is correct when it is made and something re-points the active tab
// afterwards. This module records which.
//
// DIAGNOSTIC ONLY. Nothing here decides whether a command may run; it changes no refusal
// into an acceptance. That is deliberate — this is the workflow fence's own failure mode,
// and widening trust on an unknown entry route is exactly how a refusal becomes a silent
// wrong-graph edit.
//
// Dependency-free (no DOM, no LiteGraph). Unit-testable with plain fixtures.

/** Causes the panel can attribute a move to. Anything else is `unknown`. */
export const MOVE_CAUSES = Object.freeze({
  /** The panel's own workflow_open executor, after its repaint and content proof. */
  OPEN_EXECUTOR: "open_executor",
  /** The panel created a workflow and switched to it. Declared but NOT yet claimed
   *  anywhere: `workflow_new` is reconstructed from source and rebuilt in isolation by
   *  #606/#708, so a claim cannot be inserted there without breaking twelve guards. */
  NEW_EXECUTOR: "new_executor",
  /** NO CLAIM was recorded for this move.
   *
   *  Deliberately NOT "external" (codex). "External" asserts the panel did not do it, and
   *  the panel cannot establish that: not every executor can claim, and one of #968's three
   *  reports entered the desync through `panel_new_workflow` specifically. A false
   *  EXCLUSION on a reported entry path is worse than no attribution — it would send the
   *  next investigator away from the panel at exactly the moment the panel was responsible.
   *
   *  `unknown` asserts nothing about who moved it, and still establishes the half that is
   *  always true and always useful: a binding taken before this move is stale. */
  UNKNOWN: "unknown",
});

const KNOWN = new Set(Object.values(MOVE_CAUSES));

/** Bounded: this is a diagnostic, and an unbounded log in a long session is a leak. */
const DEFAULT_CAP = 20;

/**
 * @param {{cap?: number}} [options]
 * @returns {{
 *   record(entry: object): object|null,
 *   last(): object|null,
 *   history(): object[],
 *   describeLast(): string|null,
 * }}
 */
export function createActiveWorkflowProvenance({ cap = DEFAULT_CAP } = {}) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_CAP;
  const entries = [];

  return {
    /**
     * Record one move. Returns the stored entry, or null if it was not usable — a caller
     * that cannot say WHERE the active workflow went has recorded nothing, and storing a
     * half-entry would make the log itself a source of false confidence.
     */
    record(entry) {
      if (!entry || typeof entry !== "object") return null;
      const to = typeof entry.to === "string" && entry.to ? entry.to : null;
      if (!to) return null;
      // An unrecognized cause is stored as UNKNOWN rather than dropped or trusted. The point
      // of the log is that a move HAPPENED; mislabelling it in either direction is worse than
      // recording it plainly — "panel did this" hides the case being hunted, and "panel did
      // not" falsely excludes it.
      const cause = KNOWN.has(entry.cause) ? entry.cause : MOVE_CAUSES.UNKNOWN;
      const stored = {
        cause,
        to,
        from: typeof entry.from === "string" && entry.from ? entry.from : null,
        at: Number.isFinite(entry.at) ? entry.at : 0,
        // Free-text detail from the call site (which executor, which reply). Bounded, and
        // never structured — nothing reads this to make a decision.
        detail: typeof entry.detail === "string" && entry.detail ? entry.detail.slice(0, 200) : null,
      };
      entries.push(stored);
      while (entries.length > limit) entries.shift();
      return stored;
    },

    last() {
      return entries.length ? entries[entries.length - 1] : null;
    },

    history() {
      // A copy: a diagnostic that a caller can mutate is a diagnostic that can lie.
      return entries.map((e) => ({ ...e }));
    },

    /**
     * One line for a refusal or a reply. Returns null when nothing was recorded — the
     * absence must read as "not known", never as "the panel moved it".
     */
    describeLast() {
      const e = entries.length ? entries[entries.length - 1] : null;
      if (!e) return null;
      // #968 r2 (codex P2) — `from` is the LAST OBSERVED workflow, not necessarily the
      // previous one: observations are taken at specific points, so several real switches
      // between them collapse into one transition. Say 'last seen as' rather than 'from',
      // which would assert an adjacency that was never established.
      const where = e.from ? `to ${e.to} (last seen as ${e.from})` : `to ${e.to}`;
      if (e.cause === MOVE_CAUSES.UNKNOWN) {
        return (
          `The active workflow last moved ${where}, and NO PANEL COMMAND CLAIMED IT. That does ` +
          `not prove the panel did not do it — not every executor can register a claim, so this ` +
          `covers a panel_new_workflow as well as a tab click, a reconnect restore, or a file ` +
          `reopened at a new path. What it does establish is that a binding taken before this ` +
          `move is stale.`
        );
      }
      const which = e.cause === MOVE_CAUSES.OPEN_EXECUTOR ? "panel_open_workflow" : "panel_new_workflow";
      return `The active workflow last moved ${where}, by ${which}${e.detail ? ` (${e.detail})` : ""}.`;
    },
  };
}
