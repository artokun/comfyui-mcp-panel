/**
 * #1998 — restore a dropped partial-execution target on the 1.41.21 queuePrompt
 * path without bypassing live wrappers.
 *
 * Native ComfyApp.queuePrompt is `(number, batchCount, queueNodeIds)` and later
 * calls `api.queuePrompt(number, prompt, { partialExecutionTargets })`. Custom
 * nodes often replace either method with a two-argument wrapper, so the target
 * never reaches that call. ComfyUI itself documents the same hijack for extra
 * `api.queuePrompt` parameters (auth lives on a field, not an argument).
 *
 * This adapter does not replace those wrappers. For the duration of one scoped
 * dispatch it:
 *   1. forwards the third argument through the live `app.queuePrompt` /
 *      `api.queuePrompt` functions via apply;
 *   2. writes the resolved target onto a queue item that still lacks
 *      `queueNodeIds` when native 1.41.21 pops it after a two-arg app wrapper
 *      returned;
 *   3. injects `partialExecutionTargets` when `api.queuePrompt` is invoked
 *      with this run's queue mark and no usable options object.
 *
 * Request-body repair stays the last fallback for a wrapper that captured the
 * native function and never calls through with the third argument.
 */

const rawApply = Reflect.apply;
const hasOwn = Object.prototype.hasOwnProperty;
const getPrototypeOf = Object.getPrototypeOf;
const QUEUE_ITEMS_ADAPTER = Symbol("cmcp-queue-prompt-scope-adapter");

function readProp(obj, name) {
  try {
    return obj ? obj[name] : undefined;
  } catch {
    return undefined;
  }
}

function isUsableProto(proto) {
  return !!proto && proto !== Object.prototype && proto !== Function.prototype && proto !== Array.prototype;
}

function markOf(opts) {
  try {
    const n = Number(opts?.queueMarkRef?.mark ?? opts?.queueMark);
    return Number.isFinite(n) ? n : NaN;
  } catch {
    return NaN;
  }
}

function sameMark(number, opts) {
  const expected = markOf(opts);
  if (!Number.isFinite(expected)) return false;
  const got = Number(number);
  return Number.isFinite(got) && got === expected;
}

function usableTargets(targets) {
  return Array.isArray(targets) && targets.length ? targets : null;
}

/**
 * Build the api.queuePrompt options object for this run. Unknown keys are
 * copied when `options` is already a plain object, so a wrapper that also
 * carries previewMethod / intent is not stripped.
 *
 * @param {unknown} options
 * @param {string[]} targets
 */
export function mergeQueuePromptScopeOptions(options, targets) {
  const execIds = usableTargets(targets);
  const base = {};
  if (options && typeof options === "object" && !Array.isArray(options)) {
    try {
      for (const key of Object.keys(options)) {
        base[key] = options[key];
      }
    } catch {
      // Hostile keys still get the execution target below.
    }
  }
  if (execIds && (!Array.isArray(base.partialExecutionTargets) || !base.partialExecutionTargets.length)) {
    base.partialExecutionTargets = execIds;
  }
  return base;
}

function restoreQueueNodeIds(item, targets, opts) {
  const execIds = usableTargets(targets);
  if (!execIds || !item || typeof item !== "object") return;
  try {
    if (!sameMark(item.number, opts)) return;
    const existing = item.queueNodeIds;
    if (Array.isArray(existing) && existing.length) return;
    item.queueNodeIds = execIds;
  } catch {
    // A throwing item must not break the real push.
  }
}

function wrapOwnOrProto(obj, name, adapt) {
  if (!obj) return null;
  let current;
  try {
    current = obj[name];
  } catch {
    return null;
  }
  if (typeof current !== "function") return null;
  let hadOwn;
  try {
    hadOwn = hasOwn.call(obj, name);
  } catch {
    return null;
  }
  const adapted = function adaptedQueuePrompt(...args) {
    return adapt(current, this, args);
  };
  try {
    obj[name] = adapted;
  } catch {
    return null;
  }
  return () => {
    try {
      if (hadOwn) obj[name] = current;
      else delete obj[name];
    } catch {
      // Restore is best-effort; the scoped run is already finished.
    }
  };
}

function wrapQueueItemsPop(app, targets, opts, restores, seen) {
  let items;
  try {
    items = app?.queueItems;
  } catch {
    return;
  }
  if (!Array.isArray(items) || seen.has(items)) return;
  if (readProp(items, QUEUE_ITEMS_ADAPTER)) {
    seen.add(items);
    return;
  }
  // Native 1.41.21 reads queueNodeIds from the popped item. Wrapping pop — not
  // push — keeps a deferred item untouched until the processor actually runs it.
  const restore = wrapOwnOrProto(items, "pop", (original, thisArg, args) => {
    const item = rawApply(original, thisArg ?? items, args);
    restoreQueueNodeIds(item, targets, opts);
    return item;
  });
  if (!restore) return;
  seen.add(items);
  try {
    Object.defineProperty(items, QUEUE_ITEMS_ADAPTER, {
      value: true,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch {
    // Symbol tag is a de-dupe aid, not required for correctness.
  }
  restores.push(() => {
    try {
      delete items[QUEUE_ITEMS_ADAPTER];
    } catch {
      /* ignore */
    }
    restore();
  });
}

function wrapQueuePrompt(obj, targets, opts, restores, seen, itemSeen, kind) {
  if (!obj || typeof obj !== "object" || seen.has(obj)) return;
  seen.add(obj);
  const restore = wrapOwnOrProto(obj, "queuePrompt", (original, thisArg, args) => {
    const recv = thisArg ?? obj;
    if (kind === "app") {
      wrapQueueItemsPop(recv, targets, opts, restores, itemSeen);
      if (sameMark(args[0], opts) && args[2] == null) {
        return rawApply(original, recv, [args[0], args[1], targets, ...args.slice(3)]);
      }
      return rawApply(original, recv, args);
    }
    if (sameMark(args[0], opts)) {
      const merged = mergeQueuePromptScopeOptions(args[2], targets);
      return rawApply(original, recv, [args[0], args[1], merged, ...args.slice(3)]);
    }
    return rawApply(original, recv, args);
  });
  if (restore) restores.push(restore);
  try {
    const proto = getPrototypeOf(obj);
    if (isUsableProto(proto)) wrapQueuePrompt(proto, targets, opts, restores, seen, itemSeen, kind);
  } catch {
    // Prototype walk is optional.
  }
}

/**
 * Install the scoped-run adapter. Returns a restore function that is safe to
 * call more than once and must run even when queuePrompt throws.
 *
 * @param {{app?: object, api?: object, extraApis?: unknown[], targets?: string[], queueMark?: number, queueMarkRef?: {mark: number}}} opts
 * @returns {() => void}
 */
export function installQueuePromptScopeAdapter(opts = {}) {
  const targets = usableTargets(opts.targets);
  const restores = [];
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (let i = restores.length - 1; i >= 0; i--) {
      try {
        restores[i]();
      } catch {
        // Each restore is independent so one hostile setter cannot skip the rest.
      }
    }
  };
  if (!targets) return restore;

  const seenApp = new Set();
  const seenApi = new Set();
  const seenItems = new Set();
  wrapQueuePrompt(opts.app, targets, opts, restores, seenApp, seenItems, "app");
  wrapQueueItemsPop(opts.app, targets, opts, restores, seenItems);
  wrapQueuePrompt(opts.api, targets, opts, restores, seenApi, seenItems, "api");
  wrapQueuePrompt(readProp(opts.app, "api"), targets, opts, restores, seenApi, seenItems, "api");
  const extra = Array.isArray(opts.extraApis) ? opts.extraApis : [];
  for (const api of extra) {
    if (api && api !== opts.api) wrapQueuePrompt(api, targets, opts, restores, seenApi, seenItems, "api");
  }
  return restore;
}
