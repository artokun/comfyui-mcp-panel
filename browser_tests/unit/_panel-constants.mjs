// #1180 — the panel's module-scope constants, READ from its source, for harnesses that
// rebuild shipped functions in a synthetic scope.
//
// Not a convenience. These harnesses are what actually EXERCISE the code that uses these
// numbers, so a hardcoded copy here keeps passing no matter what the panel says — a test
// agreeing with itself rather than with the thing it tests. That trap has been fixed three
// times on this issue alone (the widen divisor, `const attempts = 2`, and a literal `[200]`
// left behind after the schedule moved), which is why it now lives in one place.
//
// Filename is underscore-prefixed so `node --test browser_tests/unit/*.test.mjs` does not
// try to run it as a suite.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { makeCommandBudget } from "../../web/js/lib/command-budget.js";
import { REFRESH_JOIN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
import { NODE_DEF_REFRESH_REASONS } from "../../web/js/lib/node-def-refresh.js";
import { clearInheritedExecutionPreview } from "../../web/js/lib/execution-preview-attach.js";
import { sanitizeNodeAuxId } from "../../web/js/lib/aux-id-sanitize.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { OBJECT_INFO_DEADLINE_MS } from "../../web/js/lib/object-info-oracle.js";
import { COMBO_REFRESH_NEVER_RAN } from "../../web/js/lib/set-widget.js";

export const PANEL_SRC = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
);

/**
 * Pull a number out of the panel source, or say clearly that it has moved.
 *
 * Throws rather than returning NaN: a NaN bound silently disables comparisons and the
 * harness would go on "passing" against a constant it never found.
 */
export function readPanelNumber(re, what) {
  const m = PANEL_SRC.match(re);
  if (!m) throw new Error(`${what} is no longer findable in the panel source — update this harness`);
  return Number(m[1]);
}

export const CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS = readPanelNumber(
  /const CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS = (\d+);/,
  "the registration deadline",
);

/**
 * #1192 — the divisor is a NAMED constant now, because the widen's bound is no longer a
 * fixed number: it is that fraction of whatever deadline the registration wait actually
 * received, which under a command budget can be far less than the 5000ms standalone one.
 * Still read from source rather than restated, for the reason above.
 */
export const WIDEN_SOCKET_PROOF_DIVISOR = readPanelNumber(
  /const WIDEN_SOCKET_PROOF_DIVISOR = (\d+);/,
  "the widen divisor",
);

/** Derived exactly as the panel derives it, divisor included, so the two cannot drift. */
export const WIDEN_SOCKET_PROOF_TIMEOUT_MS = Math.floor(
  CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS / WIDEN_SOCKET_PROOF_DIVISOR,
);

/** #1192 — the whole-command deadline `graph_add_node` takes on its first line. */
export const ADD_NODE_COMMAND_BUDGET_MS = readPanelNumber(
  /const ADD_NODE_COMMAND_BUDGET_MS = (\d+);/,
  "the add_node command budget",
);

/** #1404 — the whole-command deadline `refresh_nodes` hands the coalescer as `joinMs`. */
export const REFRESH_NODES_COMMAND_BUDGET_MS = readPanelNumber(
  /const REFRESH_NODES_COMMAND_BUDGET_MS = (\d+);/,
  "the refresh_nodes command budget",
);

/**
 * #1404 — every module binding the `refresh_nodes` executor closes over, BESIDES the
 * `refreshComfyNodeDefs` each harness supplies its own double for.
 *
 * THREE harnesses rebuild that executor in a synthetic scope (node-def-refresh,
 * refresh-graph-guard, refresh-nodes-command-budget), so a new free identifier in it throws
 * `ReferenceError` in all three at once — which is exactly how adding the budget was found.
 * Collected here for the same reason `addNodeCommandBudgetDeps` exists: so the next binding
 * is added once rather than three times.
 *
 * The REAL values — the symbol and the reason vocabulary are imported and the number is read
 * from the panel source — so no harness can pass against a value the panel no longer holds.
 */
export const REFRESH_NODES_EXECUTOR_DEPS = Object.freeze({
  REFRESH_JOIN_ABANDONED,
  NODE_DEF_REFRESH_REASONS,
  REFRESH_NODES_COMMAND_BUDGET_MS,
  // #1562 — the RUN allowance the executor now hands the coalescer. Adding it here is what
  // keeps the three harnesses that rebuild `refresh_nodes` working; leaving it out throws
  // ReferenceError in all three at once, which is the signal this collection exists for.
  get REFRESH_NODES_RUN_BUDGET_MS() {
    return REFRESH_NODES_RUN_BUDGET_MS;
  },
});

/** #1413 — the whole-command deadline `graph_set_widget` takes on its first line. */
export const SET_WIDGET_COMMAND_BUDGET_MS = readPanelNumber(
  /const SET_WIDGET_COMMAND_BUDGET_MS = (\d+);/,
  "the set_widget command budget",
);

/** #1413 — what a widget write still has to do after the stale-combo refresh, held back. */
export const SET_WIDGET_POST_REFRESH_RESERVE_MS = readPanelNumber(
  /const SET_WIDGET_POST_REFRESH_RESERVE_MS = (\d+);/,
  "the set_widget post-refresh reserve",
);

export const NODE_DEFS_FETCH_TIMEOUT_MS = readPanelNumber(
  /const NODE_DEFS_FETCH_TIMEOUT_MS = (\d+);/,
  "the single-call fetch bound",
);

export const NODE_DEFS_RUN_BUDGET_MS = readPanelNumber(
  /const NODE_DEFS_RUN_BUDGET_MS = (\d+);/,
  "the refresh run budget",
);

/** The fetch phase's share of a run, read as the RATIO the panel states it as. */
export const NODE_DEFS_FETCH_SHARE = (() => {
  const m = PANEL_SRC.match(/const NODE_DEFS_FETCH_SHARE = (\d+) \/ (\d+);/);
  if (!m) throw new Error("the panel no longer states NODE_DEFS_FETCH_SHARE as a ratio");
  return Number(m[1]) / Number(m[2]);
})();

/**
 * #1562 — the run budget `refresh_nodes` derives, EVALUATED FROM THE PANEL'S OWN
 * EXPRESSION.
 *
 * Not `readPanelNumber`: the panel does not state a literal, it states a derivation
 * (`REFRESH_NODES_COMMAND_BUDGET_MS / NODE_DEFS_FETCH_SHARE`), and the property the tests
 * assert is about that derivation. Restating it here would make the harness agree with
 * itself — the exact trap this file's header records — so the expression is lifted out of
 * the source and evaluated against the two inputs, both of which are themselves read from
 * the panel.
 */
export const REFRESH_NODES_RUN_BUDGET_MS = (() => {
  const m = PANEL_SRC.match(/const REFRESH_NODES_RUN_BUDGET_MS = ([^;]*);/);
  if (!m) {
    throw new Error("REFRESH_NODES_RUN_BUDGET_MS is no longer findable in the panel source");
  }
  // eslint-disable-next-line no-new-func
  const value = new Function(
    "REFRESH_NODES_COMMAND_BUDGET_MS",
    "NODE_DEFS_FETCH_SHARE",
    `return ${m[1]};`,
  )(REFRESH_NODES_COMMAND_BUDGET_MS, NODE_DEFS_FETCH_SHARE);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`the panel's REFRESH_NODES_RUN_BUDGET_MS expression evaluated to ${value}`);
  }
  return value;
})();

/**
 * The panel's sentinel for "this call did not answer", mirrored so a rebuilt executor
 * compares against the same value its injected `boundedGetNodeDefs` resolves.
 */
export const NODE_DEFS_NO_ANSWER = Symbol("node-defs-timeout");

/** The combo refresh's three outcomes, mirrored for the same reason. */
export const COMBO_OK = Symbol("combo-refreshed");
export const COMBO_NO_ANSWER = Symbol("combo-timeout");

/** The clock the panel measures elapsed time on — never Date.now. */
export const monotonicNow = () => performance.now();

/** What is left of a run's budget, derived the way the panel derives it. */
export function nodeDefsBudgetLeft(deadline, share = 1) {
  return Math.max(1, Math.floor((deadline - monotonicNow()) * share));
}

/**
 * #1192 — the widen's share of whatever deadline the registration wait actually got,
 * derived the way the panel derives it. Rebuilt harnesses name this in their scope because
 * `awaitRequiredCustomWidgetRegistration` calls it.
 */
export function widenSocketProofBudget(deadlineMs) {
  const whole =
    Number.isFinite(deadlineMs) && deadlineMs > 0
      ? deadlineMs
      : CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS;
  return Math.max(1, Math.floor(whole / WIDEN_SOCKET_PROOF_DIVISOR));
}

/** How long a graph tool waits for the startup baseline seed. */
export const OBJECT_INFO_SEED_WAIT_MS = readPanelNumber(
  /const OBJECT_INFO_SEED_WAIT_MS = (\d+);/,
  "the baseline seed wait",
);

/**
 * #1192 — every module binding the command budget added to `graph_add_node`, in ONE place.
 *
 * Three harnesses rebuild that executor in a synthetic scope, so a new free identifier in
 * it throws `ReferenceError` in all three at once — which the resolver then catches and
 * reports as "object_info is unavailable", i.e. a wrong-cause failure in every one of them.
 * Collected here so the next binding is added once rather than three times, and so no
 * harness can quietly acquire a stale copy of one.
 *
 * The REAL implementations wherever they exist: `makeCommandBudget` and
 * `REFRESH_JOIN_ABANDONED` are imported, and the numbers are read from the panel source, so
 * a harness cannot pass against a value the panel no longer holds.
 */
export function addNodeCommandBudgetDeps() {
  return {
    // #1286 — graph_add_node now names this after graph.add. The shipped
    // implementation is a no-op when the new id has no leftover store entries.
    clearInheritedExecutionPreview,
    // #1411 — graph_add_node now sanitizes the fresh node's aux_id after
    // graph.add. The REAL helper: a valid hint passes through untouched, an
    // invalid one is dropped, and either way the add proceeds.
    sanitizeNodeAuxId,
    makeCommandBudget,
    ADD_NODE_COMMAND_BUDGET_MS,
    // Derived exactly as the panel derives it.
    ADD_NODE_POST_REFRESH_RESERVE_MS: CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS,
    OBJECT_INFO_SEED_WAIT_MS,
    REFRESH_JOIN_ABANDONED,
    widenSocketProofBudget,
    // A STUB, and labelled as one. These three harnesses are about #821/#1223/#620, none of
    // which reaches this branch. The shipped wording is pinned in single-node-def.test.mjs
    // and the behaviour that produces it is exercised in add-node-command-budget.test.mjs;
    // a hand-copied sentence here would just be a third place for it to drift.
    addNodeRefreshBusyMessage: (classType) =>
      `HARNESS STUB refusal for "${classType}" — the shipped wording lives in the panel.`,
  };
}

/**
 * #1413 — every module binding the command budget added to `graph_set_widget`, in ONE
 * place, for the same reason addNodeCommandBudgetDeps exists: harnesses that rebuild that
 * executor in a synthetic scope throw ReferenceError on a new free identifier, and each
 * would otherwise grow its own copy of these. The REAL implementations where they exist
 * (`makeCommandBudget`, `withTimeout`, the symbols, and the numbers read from the panel
 * source or imported from the lib that owns them), so a harness cannot pass against a
 * value the panel no longer holds.
 *
 * #1418 widened the budget's reach inside the handler: the seed wait and the oracle read
 * are now capped with `budget.bounded(...)`, the upload probe is wrapped in `withTimeout`,
 * and the recovery's refusal distinguishes "still running" from "never ran" on a second
 * token. `nodeDefRefreshInFlight` is deliberately NOT here: it is the coalescer's live
 * slot, a piece of mutable module state each harness must wire to its own slot double —
 * a shared snapshot of it would be stale by construction.
 */
export function setWidgetCommandBudgetDeps() {
  return {
    makeCommandBudget,
    SET_WIDGET_COMMAND_BUDGET_MS,
    SET_WIDGET_POST_REFRESH_RESERVE_MS,
    monotonicNow,
    withTimeout,
    OBJECT_INFO_SEED_WAIT_MS,
    OBJECT_INFO_DEADLINE_MS,
    REFRESH_JOIN_ABANDONED,
    COMBO_REFRESH_NEVER_RAN,
  };
}
