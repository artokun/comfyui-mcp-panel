/**
 * Budget arithmetic for graph_get_errors' ELECTIVE server-verification waits
 * (#610/#589) — extracted from comfyui-mcp-panel.js so the invariant is
 * unit-testable without a browser. No DOM / no ComfyUI globals: every input is
 * passed in.
 *
 * The problem these constants balance:
 *
 *   - #610: the forced /object_info refresh get_errors awaits before trusting a
 *     combo to clear a resolved missing-model candidate takes ~14.5 s on a real
 *     Windows install. The old flat 4000 ms cap fired first, the freshness
 *     verdict came back FALSE, and two verified-on-disk models kept reporting
 *     missing. So the REFRESH cap must cover a slow-install /object_info.
 *
 *   - #589: the orchestrator answers panel_get_errors through the ui-bridge READ
 *     default of 20 000 ms (BRIDGE_READ_DEFAULT_TIMEOUT_MS in comfyui-mcp's
 *     services/ui-bridge.ts). graph_get_errors must NEVER stay silent past that
 *     — a "tab did not reply" timeout on a live tab strands the agent with no
 *     error surface at all. So the SUM of every elective wait inside one call
 *     (refresh race + /system_stats probe + /view media probes) must stay under
 *     the bridge budget. A single shared TOTAL budget, consumed as each step
 *     runs, is what guarantees that — independent per-step caps cannot (their
 *     sum can exceed the bridge budget, which is exactly what a raised refresh
 *     cap would otherwise cause).
 *
 * Every step that finds no budget left is SKIPPED, and every skip fails the way
 * this codebase always fails: CLOSED. A skipped refresh means the combo is
 * distrusted and raw missing-asset candidates stay reported; skipped media
 * probes keep every candidate. The worst outcome of an exhausted budget is
 * today's over-reporting staleness — never a swallowed genuine miss and never
 * a wedged tool call.
 */

/** Total elective-verification budget for ONE graph_get_errors call. Must stay
 *  below the orchestrator's 20 000 ms read timeout (see the header) with margin
 *  for reply delivery and for coarse timer granularity in a backgrounded tab. */
export const GET_ERRORS_TOTAL_BUDGET_MS = 18000;

/** Cap on the forced /object_info refresh wait. Raised from the old 4000 ms:
 *  the #610 field report measured ~14.5 s on a slow Windows install, so a cap
 *  below that reintroduces the false "still missing" verdict this fixes. An
 *  install whose refresh exceeds even this keeps the conservative stale report
 *  (distrust ⇒ over-report) instead of timing the tool out. */
export const GET_ERRORS_REFRESH_CAP_MS = 15000;

/** Cap on each smaller elective step (the /system_stats platform probe and the
 *  /view nested-media probes) — and the per-step cap the best-effort
 *  validationBanner path keeps using, since it answers to no bridge timeout. */
export const GET_ERRORS_STEP_CAP_MS = 4000;

/**
 * Milliseconds the NEXT elective step may consume, given how much of the total
 * budget is already gone. Returns the step's own cap clamped to the remaining
 * budget, or 0 when the budget is exhausted — 0 means SKIP the step (fail
 * closed, per the header). A non-finite or negative `elapsedMs` (a broken
 * clock) also yields 0: when the guard itself cannot measure, it must not hand
 * out budget it cannot account for.
 */
export function getErrorsStepBudgetMs(elapsedMs, stepCapMs, totalBudgetMs = GET_ERRORS_TOTAL_BUDGET_MS) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  if (!Number.isFinite(stepCapMs) || stepCapMs <= 0) return 0;
  const remaining = totalBudgetMs - elapsedMs;
  if (!(remaining > 0)) return 0;
  return Math.min(stepCapMs, remaining);
}
