// Preserve the prompt captured by a graph_run until ComfyUI's queue processor
// serializes that item. ComfyUI returns from queuePrompt immediately when its
// processor is already busy, but serializes the queued item later from the
// live graph. A panel command must not let that deferred serialization observe
// the next deliberate-sweep mutation.

const SNAPSHOT_STATE = Symbol.for("comfyui-mcp.graphToPromptRunSnapshots");

/**
 * Install one app-level snapshot shim. ComfyUI's queue is LIFO, so
 * reservations are consumed from the end as queue items are popped. Calls
 * without a reservation retain the original serializer behaviour.
 */
export function installGraphToPromptSnapshotBarrier(app) {
  if (!app || typeof app.graphToPrompt !== "function") return null;
  if (app[SNAPSHOT_STATE]) return app[SNAPSHOT_STATE];

  const original = app.graphToPrompt.bind(app);
  const state = { pending: [], original };
  app.graphToPrompt = function runSnapshotGraphToPrompt(graph, ...rest) {
    const entry = state.pending.pop();
    if (entry) {
      entry.consumed = true;
      return Promise.resolve(entry.prompt);
    }
    return original(graph, ...rest);
  };
  Object.defineProperty(app, SNAPSHOT_STATE, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return state;
}

/** Run a live preflight without consuming a deferred queue-item reservation. */
export function withoutGraphToPromptSnapshot(app, invoke) {
  const state = app?.[SNAPSHOT_STATE];
  if (state?.original) return state.original();
  return invoke?.();
}

/** Reserve a prompt for the next deferred queue-item serialization. */
export function reserveGraphToPromptSnapshot(app, prompt) {
  const state = app?.[SNAPSHOT_STATE];
  if (!state) return null;
  const entry = { prompt, consumed: false };
  state.pending.push(entry);
  return entry;
}

/**
 * Remove a reservation only if queuePrompt failed before consuming it. A busy
 * queue returns before consuming its item, so a successful `false` result must
 * leave the reservation installed for the later processor pass.
 */
export function releaseGraphToPromptSnapshot(app, entry) {
  if (!entry?.consumed) {
    const pending = app?.[SNAPSHOT_STATE]?.pending;
    const index = pending?.indexOf(entry) ?? -1;
    if (index >= 0) {
      pending.splice(index, 1);
      return true;
    }
  }
  return false;
}
