
// #1854 — the intrinsic captured ONCE at module load. Invoking through a
// per-call property lookup on the function object would read an overrideable
// own property, so a shadowed one could throw before the original ran; this
// reads nothing off the target at call time.
const rawApply = Reflect.apply;
// Keep a batch=1 graph_run tied to the exact ComfyUI queue item it created.
//
// ComfyUI's queuePrompt() pushes an item and, when another item is already being
// processed, returns before that item is serialized. The later queue loop pops
// that item, runs its queue-time hooks, and only then calls graphToPrompt(). A
// prompt captured before the queue call therefore cannot simply replace that
// later serializer: doing so skips the hooks that are part of the real queue
// ordering. Instead this shim temporarily restores the graph state captured by
// this run before the queue loop starts, lets the real hooks and serializer run,
// and restores the live state as soon as serialization finishes.

const SNAPSHOT_STATE = Symbol.for("comfyui-mcp.graphToPromptRunSnapshots");
const SNAPSHOT_QUEUE_POP = Symbol.for("comfyui-mcp.graphToPromptRunSnapshotQueuePop");
const SNAPSHOT_QUEUE_PROMPT = Symbol.for("comfyui-mcp.graphToPromptRunSnapshotQueuePrompt");
const SNAPSHOT_HOOK = Symbol.for("comfyui-mcp.graphToPromptRunSnapshotHook");

function cloneValue(value) {
  if (value === null || typeof value !== "object") return { ok: true, value };
  if (typeof structuredClone === "function") {
    try {
      return { ok: true, value: structuredClone(value) };
    } catch {
      // Some extension widget values are host objects. Do not guess at a clone
      // for those: leaving the real queue path untouched is safer than restoring
      // an incomplete value and silently changing the prompt.
    }
  }
  return { ok: false, value: null };
}

function copyStoredValue(value) {
  const cloned = cloneValue(value);
  return cloned.ok ? cloned.value : value;
}

function forEachGraph(rootGraph, visit) {
  const stack = [rootGraph];
  const seen = new Set();
  while (stack.length) {
    const graph = stack.pop();
    if (!graph || seen.has(graph)) continue;
    seen.add(graph);
    visit(graph);
    for (const node of graph._nodes ?? graph.nodes ?? []) {
      const subgraph = node?.subgraph;
      if (subgraph) stack.push(subgraph);
    }
  }
}

function captureWidgetState(rootGraph) {
  const records = [];
  let supported = true;
  let hasHooks = false;
  forEachGraph(rootGraph, (graph) => {
    for (const node of graph._nodes ?? graph.nodes ?? []) {
      for (const widget of node?.widgets ?? []) {
        if (typeof widget?.beforeQueued === "function") hasHooks = true;
        if (!widget || !("value" in widget)) continue;
        const cloned = cloneValue(widget.value);
        if (!cloned.ok) {
          supported = false;
          continue;
        }
        records.push({ widget, snapshot: cloned.value });
      }
    }
  });
  return { supported, records, hasHooks };
}

function captureLiveState(records) {
  const live = [];
  for (const record of records) {
    const cloned = cloneValue(record.widget.value);
    if (!cloned.ok) return null;
    live.push({ widget: record.widget, value: cloned.value });
  }
  return live;
}

function restoreState(records, key) {
  for (const record of records ?? []) {
    record.widget.value = copyStoredValue(record[key]);
  }
}

function removeEntryFromState(state, entry) {
  const index = state.entries.indexOf(entry);
  if (index >= 0) state.entries.splice(index, 1);
  if (entry.item && state.itemEntries.get(entry.item) === entry) {
    state.itemEntries.delete(entry.item);
  }
  if (state.active === entry) state.active = null;
}

function removeQueuedItem(state, entry) {
  if (!entry?.item || !Array.isArray(state.queueItems)) return false;
  const index = state.queueItems.indexOf(entry.item);
  if (index < 0) return false;
  state.queueItems.splice(index, 1);
  entry.removed = true;
  return true;
}

function abortEntry(state, entry) {
  if (!entry) return false;
  entry.cancelled = true;
  removeQueuedItem(state, entry);
  if (entry.prepared && !entry.consumed && state.active === entry) {
    // If a wrapper rejected after ComfyUI had already popped the item, the
    // queue loop may still reach graphToPrompt. Restore the live graph now but
    // keep the cancelled active entry in place so serializer throws rather than
    // posting the live graph as this failed run.
    if (entry.liveState) restoreState(entry.liveState, "value");
    return true;
  }
  removeEntryFromState(state, entry);
  return true;
}

function prepareEntry(state, entry) {
  if (!entry || entry.cancelled || entry.prepared) return;
  entry.prepared = true;
  if (!entry.graphState?.supported) return;
  const live = captureLiveState(entry.graphState.records);
  if (!live) {
    entry.graphState = null;
    return;
  }
  entry.liveState = live;
  restoreState(entry.graphState.records, "snapshot");
}

function finishEntry(state, entry) {
  if (!entry?.liveState) {
    removeEntryFromState(state, entry);
    return;
  }
  // Do not overwrite a value changed while the asynchronous serializer was
  // running. Values still equal to the queue-time state belong to this
  // temporary restore and can safely return to the live graph's prior state.
  for (const [index, record] of entry.graphState.records.entries()) {
    if (Object.is(record.widget.value, entry.queueValues?.[index])) {
      record.widget.value = copyStoredValue(entry.liveState[index].value);
    }
  }
  removeEntryFromState(state, entry);
}

function queueItemsOf(app) {
  try {
    return Array.isArray(app?.queueItems) ? app.queueItems : null;
  } catch {
    return null;
  }
}

function installQueuePopObserver(app, state) {
  const queueItems = queueItemsOf(app);
  if (!queueItems || queueItems[SNAPSHOT_QUEUE_POP]) return queueItems;
  const originalPop = queueItems.pop;
  if (typeof originalPop !== "function") return null;
  const pop = function snapshotQueuePop(...args) {
    const item = originalPop.apply(this, args);
    const entry = item && state.itemEntries.get(item);
    state.active = entry ?? null;
    if (entry) {
      installHookObservers(app, state, app.rootGraph ?? app.graph);
      prepareEntry(state, entry);
    }
    return item;
  };
  try {
    Object.defineProperty(queueItems, SNAPSHOT_QUEUE_POP, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    queueItems.pop = pop;
  } catch {
    return null;
  }
  state.queueItems = queueItems;
  return queueItems;
}

function installHookObservers(app, state, rootGraph) {
  forEachGraph(rootGraph, (graph) => {
    for (const node of graph._nodes ?? graph.nodes ?? []) {
      for (const widget of node?.widgets ?? []) {
        if (!widget || typeof widget.beforeQueued !== "function") continue;
        const marker = widget.beforeQueued[SNAPSHOT_HOOK];
        if (marker?.state === state) continue;
        const original = widget.beforeQueued;
        const wrapped = function snapshotBeforeQueued(...args) {
          const entry = state.active;
          if (!entry || entry.cancelled) return original.apply(this, args);
          entry.inHook = true;
          try {
            return original.apply(this, args);
          } finally {
            entry.inHook = false;
          }
        };
        try {
          Object.defineProperty(wrapped, SNAPSHOT_HOOK, {
            value: { state, original },
            configurable: false,
            enumerable: false,
            writable: false,
          });
          widget.beforeQueued = wrapped;
        } catch {
          // A frozen extension widget is left on the real queue path. It cannot
          // be observed safely, so this shim must not make it queue differently.
        }
      }
    }
  });
}

function isQueueLoopSerializerCall(state, graph, argumentCount) {
  // ComfyUI_frontend 1.48.7 calls graphToPrompt(this.rootGraph) from the queue
  // loop. A foreign app.graphToPrompt() can run after beforeQueued while that
  // loop is between its hook and serializer calls; it may observe the temporary
  // queue state, but it must not consume the exact-item reservation.
  if (argumentCount === 0 || graph == null) return false;
  try {
    const rootGraph = state.app?.rootGraph;
    if (rootGraph) return graph === rootGraph;
  } catch {
    // Fall through to the legacy graph property when rootGraph is unavailable.
  }
  try {
    return graph === state.app?.graph;
  } catch {
    return false;
  }
}

function associateQueueItem(state, entry, beforeLength) {
  const queueItems = state.queueItems ?? queueItemsOf(state.app);
  if (!queueItems) return false;
  // ComfyUI pushes exactly one item synchronously at the start of queuePrompt,
  // before its first await. Restrict the association to items added by this
  // invocation; a later global reservation cannot be stolen by another caller.
  const added = queueItems.slice(Math.max(0, beforeLength));
  const item = added.length ? added[added.length - 1] : null;
  if (!item || typeof item !== "object") return false;
  entry.item = item;
  state.itemEntries.set(item, entry);
  return true;
}

function installQueuePromptObserver(app, state) {
  if (typeof app?.queuePrompt !== "function") return false;
  if (app[SNAPSHOT_QUEUE_PROMPT]) return true;
  // #1854 — see configure-app-mode.js. EARLY binding is load-bearing here:
  // this captures the pre-patch function, and app.queuePrompt is replaced on
  // the next line. Resolving the property at call time instead would re-enter
  // the wrapper below and recurse forever.
  const queuePromptFn = app.queuePrompt;
  const original = (...a) => rawApply(queuePromptFn, app, a);
  app.queuePrompt = function snapshotQueuePrompt(...args) {
    const entry = state.claiming;
    const queueItems = queueItemsOf(app);
    const beforeLength = queueItems?.length ?? 0;
    // Only the queuePrompt call made by queuePromptWithGraphToPromptSnapshot
    // owns this reservation. Events dispatched synchronously by the frontend's
    // queuePrompt must not let a nested foreign queuePrompt inherit the claim.
    state.claiming = null;
    let result;
    try {
      result = original(...args);
      if (entry) associateQueueItem(state, entry, beforeLength);
    } catch (error) {
      if (entry) abortEntry(state, entry);
      throw error;
    }
    if (!entry || !result || typeof result.then !== "function") return result;
    return Promise.resolve(result).catch((error) => {
      abortEntry(state, entry);
      throw error;
    });
  };
  Object.defineProperty(app, SNAPSHOT_QUEUE_PROMPT, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  installQueuePopObserver(app, state);
  return true;
}

/**
 * Install one app-level queue-item association and graph serializer shim.
 * ComfyUI's queueItems are private in TypeScript but are an ordinary array at
 * runtime on the supported frontend. If a build hides that array, the shim
 * deliberately declines to substitute a prompt rather than risk consuming a
 * reservation belonging to another serializer call.
 */
export function installGraphToPromptSnapshotBarrier(app) {
  if (!app || typeof app.graphToPrompt !== "function") return null;
  if (app[SNAPSHOT_STATE]) return app[SNAPSHOT_STATE];

  // #1854 — early binding is load-bearing; see the note above.
  const graphToPromptFn = app.graphToPrompt;
  const original = (...a) => rawApply(graphToPromptFn, app, a);
  const state = {
    app,
    original,
    entries: [],
    itemEntries: new WeakMap(),
    claiming: null,
    active: null,
    queueItems: null,
  };
  app.graphToPrompt = function runSnapshotGraphToPrompt(graph, ...rest) {
    const entry = state.active;
    if (!entry || entry.consumed) return original(graph, ...rest);
    if (entry.cancelled) {
      state.active = null;
      finishEntry(state, entry);
      throw new Error("graph_run queue item was cancelled after queuePrompt failed");
    }

    // A serializer called synchronously by a queue hook is not the queue loop's
    // serializer. It must see the temporary queue state but must not consume the
    // exact-item association needed by the call that follows the hook loop.
    if (entry.inHook || !isQueueLoopSerializerCall(state, graph, arguments.length)) {
      return original(graph, ...rest);
    }

    entry.consumed = true;
    state.active = null;
    if (entry.cancelled) {
      finishEntry(state, entry);
      throw new Error("graph_run queue item was cancelled after queuePrompt failed");
    }
    if (entry.graphState?.records.length === 0 && !entry.graphState.hasHooks) {
      const prompt = copyStoredValue(entry.prompt);
      finishEntry(state, entry);
      return Promise.resolve(prompt);
    }
    if (!entry.graphState?.supported) {
      const result = original(graph, ...rest);
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).finally(() => finishEntry(state, entry));
      }
      finishEntry(state, entry);
      return result;
    }

    entry.queueValues = entry.graphState.records.map((record) => record.widget.value);
    let result;
    try {
      // This is the real ComfyUI serializer, after its beforeQueued and promoted
      // queue hooks. The preflight prompt is only used when no restorable widget
      // state exists; it is never substituted for a hooked serialization.
      result = original(graph, ...rest);
    } catch (error) {
      finishEntry(state, entry);
      throw error;
    }
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).finally(() => finishEntry(state, entry));
    }
    finishEntry(state, entry);
    return result;
  };
  Object.defineProperty(app, SNAPSHOT_STATE, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  installQueuePromptObserver(app, state);
  return state;
}

/** Reserve the preflight prompt and graph state for one explicit queue call. */
export function reserveGraphToPromptSnapshot(app, prompt, graph) {
  const state = app?.[SNAPSHOT_STATE];
  if (!state) return null;
  const entry = {
    prompt,
    graphState: captureWidgetState(graph ?? app.graph ?? app.rootGraph ?? null),
    item: null,
    consumed: false,
    cancelled: false,
    prepared: false,
    liveState: null,
    queueValues: null,
    inHook: false,
  };
  state.entries.push(entry);
  installQueuePopObserver(app, state);
  return entry;
}

/** Execute this run's queuePrompt call while explicitly claiming its reservation. */
export function queuePromptWithGraphToPromptSnapshot(app, entry, invoke) {
  const state = app?.[SNAPSHOT_STATE];
  if (!state || !entry) return invoke?.();
  const previous = state.claiming;
  state.claiming = entry;
  try {
    const result = invoke?.();
    // A queuePrompt implementation that did not enqueue an observable item is
    // not safe to leave associated with a future graphToPrompt caller. The real
    // frontend pushes synchronously before its first await, so this is a failed
    // association rather than a deferred success.
    if (!entry.item) abortEntry(state, entry);
    return result;
  } catch (error) {
    abortEntry(state, entry);
    throw error;
  } finally {
    state.claiming = previous;
  }
}

/** Cancel a reservation and remove its exact queued item when it is still pending. */
export function releaseGraphToPromptSnapshot(app, entry) {
  const state = app?.[SNAPSHOT_STATE];
  if (!state || !entry) return false;
  return abortEntry(state, entry);
}
