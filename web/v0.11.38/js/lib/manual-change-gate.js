// Decide how the manual-canvas-change tracker should treat its baseline (the graph
// the agent left at its last turn end) versus the CURRENT live graph, before it
// injects a "MANUAL CANVAS CHANGES since your last turn" delta into the agent's
// input.
//
// The baseline is only a trustworthy diff target within ONE continuous session
// binding for the SAME workflow:
//
//   • Session boundary (#369): a reconnect / session resume / reload bumps the
//     session epoch. Across that boundary the canvas may have been rebound or
//     reloaded (or the live read is a mid-reload transient), so a baseline captured
//     in an EARLIER epoch must NOT be diffed — doing so misattributes reload churn
//     as manual edits (the reported symptom: a "100+ nodes removed" notice that the
//     very next live graph read contradicts).
//
//   • Workflow identity (#348/#198): if the bound workflow's stable identity has
//     provably CHANGED, a different workflow is on the canvas (tab switch) — emit a
//     switch notice, never a bogus per-node delta.
//
//   • Unknown identity: if either side's identity can't be resolved, we can't
//     confirm it's the same workflow, so a diff is untrustworthy — reseed silently
//     rather than assert a false delta.
//
// Pure + side-effect-free so the decision is unit-testable in isolation; the caller
// performs the reseed / banner emission based on the returned action.
//
// Returns one of:
//   { action: "diff" }             — same epoch AND confirmed-same identity → diff.
//   { action: "reseed" }           — stale epoch or unknown identity → adopt current
//                                     graph as the new baseline, emit NO banner.
//   { action: "workflow-changed" } — identity provably differs → emit switch notice
//                                     and reseed.
export function classifyManualChangeBaseline({
  hasBaseline,
  baselineKey,
  baselineEpoch,
  currentKey,
  currentEpoch,
}) {
  // No baseline yet (fresh session, or a prior reseed cleared it) — nothing to diff.
  if (!hasBaseline) return { action: "reseed" };

  // A session boundary (reconnect / resume / reload) was crossed since the baseline
  // was captured. The baseline predates the current binding and cannot be trusted as
  // "the graph at the agent's last turn end" — discard it rather than diff (#369).
  // A non-finite epoch on EITHER side (missing / NaN — an uninitialized or corrupted
  // stamp) is itself untrustworthy, so treat it as a boundary too (note Object.is
  // would wrongly report NaN===NaN and undefined===undefined as a match).
  if (!Number.isFinite(baselineEpoch) || !Number.isFinite(currentEpoch))
    return { action: "reseed" };
  if (baselineEpoch !== currentEpoch) return { action: "reseed" };

  // Identity provably DIFFERENT (both known, and unequal) → a different workflow is
  // bound (the user switched tabs). Emit the switch notice, never a false per-node
  // delta between two unrelated graphs (#348/#198).
  if (baselineKey != null && currentKey != null && currentKey !== baselineKey)
    return { action: "workflow-changed" };

  // Identity UNKNOWN on either side → we cannot confirm the baseline and the live
  // graph are the same workflow, so a diff is untrustworthy. Reseed silently (#369).
  if (baselineKey == null || currentKey == null) return { action: "reseed" };

  // Same epoch AND confirmed-same identity → the diff is meaningful.
  return { action: "diff" };
}
