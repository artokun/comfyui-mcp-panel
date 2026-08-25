/**
 * Keep a chat scroll surface pinned while contained message roots settle.
 *
 * `content-visibility: auto` can first expose a direct child using its
 * contain-intrinsic-size and then replace that estimate with the real height.
 * A single requestAnimationFrame sees the estimate, not necessarily the final
 * transcript geometry. ResizeObserver is the runtime signal for that reveal;
 * MutationObserver makes sure newly appended message roots are observed too.
 *
 * This helper owns no chat policy: callers decide whether following is allowed.
 * When the user has scrolled up, schedule() is a no-op and the caller keeps its
 * existing new-message affordance.
 */

const defaultRequestFrame = (fn) =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 16);

export function createChatScrollStabilizer({
  log,
  shouldStick = () => true,
  requestFrame = defaultRequestFrame,
  ResizeObserverCtor = typeof ResizeObserver === "function" ? ResizeObserver : null,
  MutationObserverCtor = typeof MutationObserver === "function" ? MutationObserver : null,
} = {}) {
  if (!log) return { schedule() {}, observeAll() {}, dispose() {} };

  let disposed = false;
  let framePending = false;
  let resizeObserver = null;
  let mutationObserver = null;

  const canStick = () => {
    try {
      return !disposed && shouldStick();
    } catch {
      return false;
    }
  };

  const observeChild = (child) => {
    if (!resizeObserver || !child || child === log || child.classList?.contains?.("cmcp-empty")) return;
    try {
      resizeObserver.observe(child);
    } catch {
      // A detached or hostile DOM node must not break chat rendering.
    }
  };

  const observeAll = () => {
    for (const child of log.children || []) observeChild(child);
  };

  const scrollNow = () => {
    framePending = false;
    if (!canStick()) return;
    try {
      log.scrollTop = log.scrollHeight;
    } catch {
      // The panel may be detaching while a layout callback is in flight.
    }
  };

  const schedule = () => {
    if (!canStick()) return;
    // This also covers a direct child appended before a MutationObserver
    // delivery, and is cheap because ResizeObserver de-duplicates targets.
    observeAll();
    if (framePending) return;
    framePending = true;
    try {
      requestFrame(scrollNow);
    } catch {
      // Preserve the old best-effort scroll behavior if the host's frame API
      // is unavailable or throws during teardown.
      scrollNow();
    }
  };

  try {
    if (typeof ResizeObserverCtor === "function") {
      resizeObserver = new ResizeObserverCtor(() => schedule());
    }
  } catch {
    resizeObserver = null;
  }

  try {
    if (typeof MutationObserverCtor === "function") {
      mutationObserver = new MutationObserverCtor((records) => {
        let added = false;
        for (const record of records || []) {
          for (const child of record.addedNodes || []) {
            observeChild(child);
            added = true;
          }
        }
        if (added) schedule();
      });
      mutationObserver.observe(log, { childList: true });
    }
  } catch {
    mutationObserver = null;
  }

  observeAll();

  return {
    schedule,
    observeAll,
    dispose() {
      disposed = true;
      try { resizeObserver?.disconnect(); } catch { /* already detached */ }
      try { mutationObserver?.disconnect(); } catch { /* already detached */ }
      resizeObserver = null;
      mutationObserver = null;
    },
  };
}
