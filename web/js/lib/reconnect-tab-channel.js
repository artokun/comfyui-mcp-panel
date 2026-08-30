// #2030 — after a ComfyUI backend restart the tab can sit on a live bridge
// socket whose workflow command channel is still the pre-restart mapping.
// `panel_restart_comfyui` then reports `server_ready:true` /
// `tab_reconnected:false`, `workflow_list` times out (6000 ms), and
// `panel_set_workflow_target({mode:"current"})` cannot read canvas identity.
// Mutations stay fenced. Unsaved in-memory edits exist, so the repair is a
// reconnect watchdog that re-registers THIS tab's current identity — the same
// hello the panel already sends on a workflow switch — without reloading or
// reopening the workflow.
//
// Distinct from #1999: that restores a Desktop process. This restores the tab
// command channel of a tab that stayed loaded.
//
// Pure + injected I/O so the loop is unit-testable with fakes; the panel wires
// `client.rehello()` and the live reconnect epoch.

/** Cadence matches the orchestrator's post-open handshake so a caller that
 *  already waited there is not paying a second, longer budget. */
export const TAB_CHANNEL_REREGISTER_STEPS_MS = Object.freeze([400, 900, 1600]);

/** Hard bound on watchdog hellos for one reconnect epoch. A wedge must never
 *  become a hello storm. */
export const TAB_CHANNEL_WATCH_MAX_ATTEMPTS = 3;

function isTrue(value) {
  return value === true;
}

function readFlag(value) {
  try {
    return typeof value === "function" ? value() === true : value === true;
  } catch {
    return false;
  }
}

/**
 * #2030 — may we re-register THIS tab's existing workflow command channel?
 *
 * True only when the backend is up, the bridge socket is live, and this
 * reconnect epoch has not yet landed a hello. That is
 * `server_ready:true` / `tab_reconnected:false`: ComfyUI is healthy, but
 * this tab's command channel is still the pre-restart mapping.
 *
 * Re-registering means re-hello of THIS tab's current identity. It must not
 * reload, reopen, or replace the in-memory graph (unsaved edits).
 */
export function shouldReregisterWorkflowTabChannel({
  serverReady = false,
  bridgeConnected = false,
  channelReadyForEpoch = false,
  alreadyInFlight = false,
} = {}) {
  if (!isTrue(serverReady)) return false;
  if (!isTrue(bridgeConnected)) return false;
  if (isTrue(channelReadyForEpoch)) return false;
  if (isTrue(alreadyInFlight)) return false;
  return true;
}

/**
 * After a backend cycle, retry re-registering the existing tab until the
 * command channel is ready for this epoch, a newer reconnect supersedes the
 * watch, or the budget is spent.
 *
 * `reregister` MUST be a hello of the current identity. Extra `loadWorkflow` /
 * `openWorkflow` hooks are accepted so tests can prove they are never called;
 * this function never invokes them.
 *
 * @returns {Promise<"ready"|"superseded"|"exhausted">}
 */
export async function watchReconnectTabChannel({
  isCurrent,
  serverReady,
  channelReady,
  reregister,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  firstDelayMs = 0,
  stepsMs = TAB_CHANNEL_REREGISTER_STEPS_MS,
  maxAttempts = TAB_CHANNEL_WATCH_MAX_ATTEMPTS,
} = {}) {
  const current = () => {
    try {
      return typeof isCurrent !== "function" || isCurrent() === true;
    } catch {
      return false;
    }
  };
  const ready = () => readFlag(channelReady);
  const up = () => {
    try {
      return typeof serverReady !== "function" || serverReady() === true;
    } catch {
      return false;
    }
  };

  const steps = Array.isArray(stepsMs) && stepsMs.length ? stepsMs : TAB_CHANNEL_REREGISTER_STEPS_MS;
  const limit = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : TAB_CHANNEL_WATCH_MAX_ATTEMPTS;
  let attempts = 0;

  const tick = async () => {
    if (!current()) return "superseded";
    if (ready()) return "ready";
    if (
      up() &&
      attempts < limit &&
      shouldReregisterWorkflowTabChannel({
        serverReady: true,
        bridgeConnected: true,
        channelReadyForEpoch: false,
        alreadyInFlight: false,
      })
    ) {
      attempts += 1;
      try {
        await Promise.resolve(typeof reregister === "function" ? reregister() : false);
      } catch {
        // A throwing hello is "not yet", never a reason to load the graph.
      }
      if (!current()) return "superseded";
      if (ready()) return "ready";
    }
    return null;
  };

  const initialDelay = Number(firstDelayMs);
  if (Number.isFinite(initialDelay) && initialDelay > 0) await sleep(initialDelay);
  else await Promise.resolve();

  let outcome = await tick();
  if (outcome) return outcome;

  for (const waitMs of steps) {
    const ms = Number(waitMs);
    if (Number.isFinite(ms) && ms > 0) await sleep(ms);
    else await Promise.resolve();
    outcome = await tick();
    if (outcome) return outcome;
  }
  if (!current()) return "superseded";
  return ready() ? "ready" : "exhausted";
}

/**
 * `panel_set_workflow_target({mode:"current"})` / `workflow_list` recovery:
 * if the server is up but this epoch's command channel is stale, force one
 * safe re-register of the existing tab, then wait until it is ready or the
 * bounded steps elapse.
 *
 * A timeout here is not a graph mutation: nothing was opened, reloaded, or
 * rebound. Callers decide whether to proceed with the local in-memory list.
 *
 * @returns {Promise<"ready"|"timeout"|"not-ready">}
 */
export async function ensureWorkflowTabChannel({
  serverReady,
  bridgeConnected,
  channelReady,
  reregister,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stepsMs = TAB_CHANNEL_REREGISTER_STEPS_MS,
} = {}) {
  // Yield so a caller that arms serverReady/bridgeConnected immediately after
  // invoking still has those flags sampled live, not frozen at call time.
  await Promise.resolve();

  const ready = () => readFlag(channelReady);
  if (ready()) return "ready";

  if (
    !shouldReregisterWorkflowTabChannel({
      serverReady: readFlag(serverReady),
      bridgeConnected: readFlag(bridgeConnected),
      channelReadyForEpoch: ready(),
    })
  ) {
    return ready() ? "ready" : "not-ready";
  }

  try {
    await Promise.resolve(typeof reregister === "function" ? reregister() : false);
  } catch {
    // A failed hello is not a reason to skip the wait — the channel may still come up.
  }
  if (ready()) return "ready";

  const steps = Array.isArray(stepsMs) && stepsMs.length ? stepsMs : TAB_CHANNEL_REREGISTER_STEPS_MS;
  for (const waitMs of steps) {
    const ms = Number(waitMs);
    if (Number.isFinite(ms) && ms > 0) await sleep(ms);
    else await Promise.resolve();
    if (ready()) return "ready";
  }
  return ready() ? "ready" : "timeout";
}
