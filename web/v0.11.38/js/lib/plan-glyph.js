// Plan-tray ("PLAN" box) icon selection — extracted as a pure function so the
// false-activity fix (issue #492) is unit-testable without a DOM.
//
// The agent's live plan is pushed via `set_todo` and PERSISTED on the thread, so
// whatever step was "active" when a turn ended stays "active" in the stored data.
// The tray must not paint that as a spinning ("working") glyph once the turn is
// over — the reporter saw the "PLAN" box "show activity when none is happening"
// (a circle widget that "continues turning") after the agent had stopped.
//
// Rule: a step only SPINS while the agent is actually working (`agentWorking`).
//   - done            → check    (pi-check-circle)
//   - active + working → spinner  (pi-spin pi-spinner)  ← real, live motion
//   - active + idle    → filled dot (pi-circle-fill)    ← "you are here", static
//   - pending          → hollow circle (pi-circle)
//
// Returns the PrimeIcons class string for the leading <i> of a todo row.
export function todoItemGlyph(status, agentWorking) {
  if (status === "done") return "pi-check-circle";
  if (status === "active") return agentWorking ? "pi-spin pi-spinner" : "pi-circle-fill";
  return "pi-circle";
}
