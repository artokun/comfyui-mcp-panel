/**
 * Unit tests for web/js/lib/get-errors-budget.js — run with `node --test`.
 *
 * Covers the #610/#589 budget invariants:
 *   - the refresh cap covers the observed slow-install /object_info (#610);
 *   - the TOTAL elective-wait budget stays under the orchestrator's 20 s
 *     ui-bridge read timeout so graph_get_errors can never go silent past it
 *     on a live tab (#589);
 *   - sequential steps consuming the shared budget can never sum past it;
 *   - an exhausted budget or a broken clock yields 0 ⇒ the step is SKIPPED
 *     and fails closed (over-report), never a hung call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  GET_ERRORS_TOTAL_BUDGET_MS,
  GET_ERRORS_REFRESH_CAP_MS,
  GET_ERRORS_STEP_CAP_MS,
  getErrorsStepBudgetMs,
} from "../../web/js/lib/get-errors-budget.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_SOURCE = readFileSync(
  join(__dirname, "..", "..", "web", "js", "comfyui-mcp-panel.js"),
  "utf8",
);

// The orchestrator side of this invariant: BRIDGE_READ_DEFAULT_TIMEOUT_MS in
// comfyui-mcp's services/ui-bridge.ts. Duplicated as a literal on purpose —
// if EITHER side moves, this test forces the relationship to be re-examined.
const ORCHESTRATOR_READ_TIMEOUT_MS = 20000;

test("the total budget stays under the orchestrator's 20 s read timeout (#589)", () => {
  assert.ok(
    GET_ERRORS_TOTAL_BUDGET_MS < ORCHESTRATOR_READ_TIMEOUT_MS,
    `total budget ${GET_ERRORS_TOTAL_BUDGET_MS} must leave reply margin under the bridge's ${ORCHESTRATOR_READ_TIMEOUT_MS} ms`,
  );
});

test("the refresh cap covers the observed ~14.5 s slow-install /object_info (#610)", () => {
  // #610 measured ~14.5 s for a forced /object_info + combo refresh on a real
  // Windows install; the old 4000 ms cap fired first and kept verified models
  // reporting missing. The cap must exceed that observation.
  assert.ok(GET_ERRORS_REFRESH_CAP_MS > 14500);
  // …but can never exceed the total budget it is charged against.
  assert.ok(GET_ERRORS_REFRESH_CAP_MS <= GET_ERRORS_TOTAL_BUDGET_MS);
});

test("a first step gets its full cap", () => {
  assert.equal(getErrorsStepBudgetMs(0, GET_ERRORS_REFRESH_CAP_MS), GET_ERRORS_REFRESH_CAP_MS);
  assert.equal(getErrorsStepBudgetMs(0, GET_ERRORS_STEP_CAP_MS), GET_ERRORS_STEP_CAP_MS);
});

test("a step is clamped to the REMAINING budget near the end", () => {
  // 16 s elapsed of the 18 s total ⇒ only 2 s left for a 4 s-capped probe.
  assert.equal(getErrorsStepBudgetMs(16000, GET_ERRORS_STEP_CAP_MS), 2000);
});

test("an exhausted or overrun budget yields 0 (step skipped, fail closed)", () => {
  assert.equal(getErrorsStepBudgetMs(GET_ERRORS_TOTAL_BUDGET_MS, GET_ERRORS_STEP_CAP_MS), 0);
  assert.equal(getErrorsStepBudgetMs(GET_ERRORS_TOTAL_BUDGET_MS + 1, GET_ERRORS_STEP_CAP_MS), 0);
});

test("a broken clock (non-finite / negative elapsed) yields 0, not free budget", () => {
  assert.equal(getErrorsStepBudgetMs(NaN, GET_ERRORS_STEP_CAP_MS), 0);
  assert.equal(getErrorsStepBudgetMs(Infinity, GET_ERRORS_STEP_CAP_MS), 0);
  assert.equal(getErrorsStepBudgetMs(-5, GET_ERRORS_STEP_CAP_MS), 0);
});

test("a non-positive step cap yields 0", () => {
  assert.equal(getErrorsStepBudgetMs(0, 0), 0);
  assert.equal(getErrorsStepBudgetMs(0, NaN), 0);
});

test("SEQUENTIAL consumption of the shared budget can never sum past it (#610+#589)", () => {
  // Simulate graph_get_errors' elective steps in order — refresh race, then
  // /system_stats, then the /view probe batch — each taking its full granted
  // budget, and assert the total wait never exceeds GET_ERRORS_TOTAL_BUDGET_MS.
  let elapsed = 0;
  const take = (cap) => {
    const granted = getErrorsStepBudgetMs(elapsed, cap);
    elapsed += granted;
    return granted;
  };
  const refresh = take(GET_ERRORS_REFRESH_CAP_MS);
  const stats = take(GET_ERRORS_STEP_CAP_MS);
  const probes = take(GET_ERRORS_STEP_CAP_MS);
  assert.equal(refresh, GET_ERRORS_REFRESH_CAP_MS, "refresh gets its full raised cap first");
  assert.equal(
    stats,
    GET_ERRORS_TOTAL_BUDGET_MS - GET_ERRORS_REFRESH_CAP_MS,
    "the stats probe is clamped to the remainder of the shared budget",
  );
  assert.equal(probes, 0, "the media probes are skipped once the budget is spent");
  assert.ok(elapsed <= GET_ERRORS_TOTAL_BUDGET_MS);
  assert.ok(
    elapsed < ORCHESTRATOR_READ_TIMEOUT_MS,
    `worst-case in-panel elective wait ${elapsed} must beat the bridge timeout`,
  );
});

// Source guard: the constants above are only meaningful while graph_get_errors
// actually spends them. A revert to the old flat 4 s constant — or a call site
// that stops PASSING the budget (an unwired constant still greps) — must fail
// the build, not slip through (a fix on one branch was once silently reverted
// by a later bulk rewrite; codex gate: token presence ≠ wiring).
test("graph_get_errors spends the shared budget and the old 4 s constant is gone (#610/#589)", () => {
  assert.ok(
    !PANEL_SOURCE.includes("GET_ERRORS_REFRESH_TIMEOUT_MS"),
    "the old flat GET_ERRORS_REFRESH_TIMEOUT_MS constant must not reappear",
  );
  assert.match(
    PANEL_SOURCE,
    /errorsStepBudget\(GET_ERRORS_REFRESH_CAP_MS\)/,
    "the refresh wait must be computed from the shared budget",
  );
  assert.match(
    PANEL_SOURCE,
    /refreshMissingAssetTrust\(\{[\s\S]*?refreshBudgetMs,[\s\S]*?withRefreshTimeout,[\s\S]*?\}\)/,
    "the graph_get_errors refresh seam must RECEIVE the shared budget and timeout",
  );
  assert.match(
    PANEL_SOURCE,
    /filterServerConfirmedInputSubfolderMedia\(\s*assets\.media,\s*\(\)\s*=>/,
    "the nested-media probe must RECEIVE the remaining-budget thunk (the default thunk ignores the shared budget)",
  );
});
