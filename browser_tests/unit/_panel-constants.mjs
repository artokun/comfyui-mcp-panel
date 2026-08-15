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

/** Derived exactly as the panel derives it, divisor included, so the two cannot drift. */
export const WIDEN_SOCKET_PROOF_TIMEOUT_MS = Math.floor(
  CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS /
    readPanelNumber(
      /WIDEN_SOCKET_PROOF_TIMEOUT_MS = Math\.floor\(CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS \/ (\d+)\)/,
      "the widen divisor",
    ),
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
