/**
 * #887 — prove that workflow_open's active binding survived the frontend's
 * asynchronous tab/canvas transition before releasing the open guard.
 *
 * The workflow store can briefly expose the requested tab as active while the
 * frontend is still completing the tab switch. A synchronous read at reply
 * time can therefore be true, followed by workflow_list seeing the previous
 * canvas. Poll for a short, bounded stability window so the open either returns
 * after a real event-loop turn with a stable target, or fails closed.
 */

const DEFAULT_BUDGET_MS = 1200;
const DEFAULT_POLL_MS = 50;
const DEFAULT_STABLE_MS = 100;

/** Same bound as the object-identity settle. The tmp: reconnect race is a
 *  verification lag, not a second-long restore. */
export const TMP_OPEN_ROUTING_BUDGET_MS = DEFAULT_BUDGET_MS;
export const TMP_OPEN_ROUTING_POLL_MS = DEFAULT_POLL_MS;

const TMP_OPEN_SELECTOR_RE =
  /^tmp:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `panel_open_workflow` was asked for an unsaved per-tab handle. */
export function isUnsavedTmpOpenSelector(value) {
  return typeof value === "string" && TMP_OPEN_SELECTOR_RE.test(value);
}

const defaultNow = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for `target` to remain the active workflow for `stableMs`.
 *
 * A missing/throwing active read or comparator is UNKNOWN, never a mismatch.
 * The helper also never throws: the caller owns the operation's fail-closed
 * error path, while this function only classifies the observation.
 *
 * @returns {Promise<{
 *   status: "settled"|"different"|"unknown",
 *   active?: unknown,
 *   reason?: string
 * }>}
 */
export async function settleOpenedWorkflowActive({
  target,
  readActive,
  sameWorkflowObject,
  wait = defaultWait,
  now = defaultNow,
  budgetMs = DEFAULT_BUDGET_MS,
  pollMs = DEFAULT_POLL_MS,
  stableMs = DEFAULT_STABLE_MS,
} = {}) {
  if (!target || typeof readActive !== "function" || typeof sameWorkflowObject !== "function") {
    return { status: "unknown", reason: "active binding probe was unavailable" };
  }

  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
  const poll = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 1;
  const stable = Number.isFinite(stableMs) && stableMs >= 0 ? stableMs : 0;
  const maxAttempts = Math.max(1, Math.ceil(budget / poll) + 1);
  let started;
  try {
    started = now();
  } catch {
    return { status: "unknown", reason: "active binding clock was unreadable" };
  }

  let targetSince = null;
  let lastObservation = { status: "unknown", reason: "no active binding observation" };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let current;
    let observedAt;
    try {
      current = readActive();
      observedAt = now();
    } catch {
      targetSince = null;
      lastObservation = { status: "unknown", reason: "active workflow was unreadable" };
    }

    if (observedAt !== undefined) {
      if (!current) {
        targetSince = null;
        lastObservation = { status: "unknown", reason: "active workflow was unreadable" };
      } else {
        let isTarget;
        try {
          isTarget = sameWorkflowObject(current, target) === true;
        } catch {
          isTarget = null;
        }
        if (isTarget === true) {
          if (targetSince === null) targetSince = observedAt;
          if (observedAt - targetSince >= stable) {
            return { status: "settled", active: current };
          }
          lastObservation = { status: "unknown", reason: "active workflow was not stable yet" };
        } else if (isTarget === false) {
          targetSince = null;
          lastObservation = { status: "different", active: current };
        } else {
          targetSince = null;
          lastObservation = { status: "unknown", reason: "active workflow comparison failed" };
        }
      }
    }

    let currentTime;
    try {
      currentTime = now();
    } catch {
      return { status: "unknown", reason: "active binding clock was unreadable" };
    }
    if (currentTime - started >= budget || attempt + 1 >= maxAttempts) break;
    try {
      await wait(Math.min(poll, Math.max(0, budget - (currentTime - started))));
    } catch {
      return { status: "unknown", reason: "active binding wait failed" };
    }
  }

  return lastObservation.status === "different"
    ? lastObservation
    : { status: "unknown", reason: lastObservation.reason ?? "active workflow did not settle" };
}

/**
 * #2022 — wait until the live active workflow's EXISTING routing key equals the
 * requested `tmp:<uuid>`.
 *
 * Object-identity settle can miss immediately after reconnect: the restored tab
 * is briefly unreadable, or `sameWorkflowObject` cannot yet see the tracker.
 * The switch already ran; failing closed on that race is the reported
 * false-negative. A missing/throwing read is UNKNOWN, never a mismatch. The
 * caller MUST pass a non-minting `workflowTabId` — minting a fresh tmp: handle
 * on a restored object would invent a different key and fail a working switch.
 *
 * @returns {Promise<{
 *   status: "settled"|"different"|"unknown",
 *   active?: unknown,
 *   routingKey?: string|null,
 *   reason?: string
 * }>}
 */
export async function settleOpenedTmpRoutingKey({
  requestedKey,
  readActive,
  workflowTabId,
  wait = defaultWait,
  now = defaultNow,
  budgetMs = TMP_OPEN_ROUTING_BUDGET_MS,
  pollMs = TMP_OPEN_ROUTING_POLL_MS,
} = {}) {
  if (
    !isUnsavedTmpOpenSelector(requestedKey) ||
    typeof readActive !== "function" ||
    typeof workflowTabId !== "function"
  ) {
    return { status: "unknown", reason: "tmp routing-key probe was unavailable" };
  }

  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
  const poll = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 1;
  const maxAttempts = Math.max(1, Math.ceil(budget / poll) + 1);
  let started;
  try {
    started = now();
  } catch {
    return { status: "unknown", reason: "tmp routing-key clock was unreadable" };
  }

  let lastObservation = { status: "unknown", reason: "no tmp routing-key observation" };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let current;
    try {
      current = readActive();
    } catch {
      lastObservation = { status: "unknown", reason: "active workflow was unreadable" };
      current = undefined;
    }

    if (current !== undefined) {
      if (!current) {
        lastObservation = { status: "unknown", reason: "active workflow was unreadable" };
      } else {
        let routingKey = null;
        try {
          const read = workflowTabId(current);
          routingKey = typeof read === "string" && read ? read : null;
        } catch {
          routingKey = null;
        }
        if (!routingKey) {
          lastObservation = { status: "unknown", reason: "active routing key was unreadable" };
        } else if (routingKey === requestedKey) {
          return { status: "settled", active: current, routingKey };
        } else {
          lastObservation = { status: "different", active: current, routingKey };
        }
      }
    }

    let currentTime;
    try {
      currentTime = now();
    } catch {
      return { status: "unknown", reason: "tmp routing-key clock was unreadable" };
    }
    if (currentTime - started >= budget || attempt + 1 >= maxAttempts) break;
    try {
      await wait(Math.min(poll, Math.max(0, budget - (currentTime - started))));
    } catch {
      return { status: "unknown", reason: "tmp routing-key wait failed" };
    }
  }

  return lastObservation.status === "different"
    ? lastObservation
    : { status: "unknown", reason: lastObservation.reason ?? "tmp routing key did not settle" };
}

/**
 * #2022 — fail closed on an APPLIED tmp: open only when a positive observation
 * names a different routing key. Unreadable object identity, or an object-level
 * "different" without routing-key confirmation, is the reconnect race — not a
 * failed switch.
 */
export function appliedTmpOpenShouldFailClosed({ routingSettle } = {}) {
  return routingSettle?.status === "different";
}

/**
 * Run the active-binding probe as one owned reload-guard step.
 *
 * A superseding open may replace the guard while the timer-backed probe is
 * waiting. In that case the result is not allowed to authorize this open,
 * even if its last active read happened to name the target.
 */
async function settleOwnedOpenProbe(runProbe, { beginStep, ownsStep, endStep } = {}) {
  let started = false;
  try {
    started = typeof beginStep === "function" && beginStep() === true;
  } catch {
    started = false;
  }
  if (!started) {
    return { status: "superseded", reason: "active binding step was not owned" };
  }

  try {
    const result = await runProbe();
    let stillOwns = false;
    try {
      stillOwns = typeof ownsStep === "function" && ownsStep() === true;
    } catch {
      stillOwns = false;
    }
    return stillOwns
      ? result
      : { status: "superseded", reason: "active binding step lost ownership" };
  } catch {
    return { status: "unknown", reason: "active binding probe failed" };
  } finally {
    try {
      endStep?.();
    } catch {
      // Guard cleanup is best-effort; the production token remains owner-checked.
    }
  }
}

export async function settleOwnedOpenedWorkflowActive({
  beginStep,
  ownsStep,
  endStep,
  ...probeOptions
} = {}) {
  return settleOwnedOpenProbe(() => settleOpenedWorkflowActive(probeOptions), {
    beginStep,
    ownsStep,
    endStep,
  });
}

export async function settleOwnedOpenedTmpRoutingKey({
  beginStep,
  ownsStep,
  endStep,
  ...probeOptions
} = {}) {
  return settleOwnedOpenProbe(() => settleOpenedTmpRoutingKey(probeOptions), {
    beginStep,
    ownsStep,
    endStep,
  });
}
