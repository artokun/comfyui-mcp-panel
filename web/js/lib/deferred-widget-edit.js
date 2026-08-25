// Explicit, fail-closed deferral for a safe widget edit (#1716).
//
// The MCP queue-busy fence still refuses ordinary graph mutations before they
// reach the panel. This module is the panel-side primitive for the one opt-in
// exception: a caller may schedule an absolute primitive widget value while
// ComfyUI is busy, provided the caller also supplies the value it observed.
// The request is applied only after BOTH queue lists are empty and the same
// graph, node, widget, and expected value are still present.

export const DEFERRED_WIDGET_EDIT_POLL_MS = 500;
export const DEFERRED_WIDGET_EDIT_MAX_WAIT_MS = 30 * 60 * 1000;

/** Only JSON scalar values have a simple, idempotent replay meaning here. */
export function isSafeDeferredWidgetValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
}

/** Equality for the scalar contract, including the distinction between -0 and 0. */
export function sameDeferredWidgetValue(left, right) {
  return Object.is(left, right);
}

export function deferredWidgetQueueCounts(value) {
  if (!value || typeof value !== "object") return null;
  const running = Array.isArray(value.queue_running) ? value.queue_running.length : null;
  const pending = Array.isArray(value.queue_pending) ? value.queue_pending.length : null;
  if (running === null || pending === null) return null;
  return { running, pending };
}

function defaultNow() {
  return Date.now();
}

/**
 * Build the small panel-local queue used by `graph_set_widget`'s opt-in
 * `defer_until_idle` path.
 *
 * Every callback is injected so the queue is executable in production and
 * deterministic in unit tests. A queue probe that is unreadable is UNKNOWN,
 * never idle; a target/readback mismatch is a definite refusal and is removed
 * without calling `apply`.
 */
export function createDeferredWidgetEditQueue({
  readQueue,
  now = defaultNow,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  pollMs = DEFERRED_WIDGET_EDIT_POLL_MS,
  maxWaitMs = DEFERRED_WIDGET_EDIT_MAX_WAIT_MS,
  onSettled = () => {},
} = {}) {
  if (typeof readQueue !== "function") throw new TypeError("readQueue is required");

  const entries = new Map();
  let sequence = 0;
  let timer = null;
  let closed = false;
  let inFlightDrain = null;

  function receiptId() {
    sequence += 1;
    return `widget-edit-${now()}-${sequence}`;
  }

  function settle(entry, outcome) {
    if (!entry || !entries.delete(entry.receipt)) return;
    entry.status = outcome.status;
    entry.outcome = outcome;
    try {
      onSettled({
        receipt: entry.receipt,
        node_id: entry.node_id,
        widget: entry.widget,
        ...outcome,
      });
    } catch {
      // A notification failure must not turn a settled edit into an unknown one.
    }
  }

  function schedule(delay = pollMs) {
    if (closed || timer !== null || entries.size === 0) return;
    timer = setTimer(() => {
      timer = null;
      void drain();
    }, Math.max(0, delay));
  }

  async function drainOnce() {
    if (closed || entries.size === 0) return;

    const currentTime = now();
    for (const entry of entries.values()) {
      if (currentTime - entry.created_at >= maxWaitMs) {
        settle(entry, {
          status: "expired",
          error: "the deferred widget edit waited too long for ComfyUI's queue to become idle",
        });
      }
    }
    if (entries.size === 0 || closed) return;

    let counts;
    try {
      counts = deferredWidgetQueueCounts(await readQueue());
    } catch {
      counts = null;
    }
    if (!counts || counts.running > 0 || counts.pending > 0) {
      schedule();
      return;
    }

    // Process in insertion order. Each entry performs its own target and
    // expected-value read, so two edits to the same widget cannot silently
    // overwrite one another after the first one lands.
    for (const entry of [...entries.values()]) {
      if (closed || !entries.has(entry.receipt)) return;
      let target;
      try {
        target = await entry.readCurrent();
      } catch {
        target = { ok: false, error: "the deferred widget edit target could not be read" };
      }
      if (!target?.ok) {
        settle(entry, {
          status: "refused",
          error: target?.error || "the deferred widget edit target is no longer current",
        });
        continue;
      }
      if (!sameDeferredWidgetValue(target.value, entry.expected_value)) {
        settle(entry, {
          status: "refused",
          error:
            "the widget changed while the edit was deferred; nothing was applied and the edit was not replayed",
        });
        continue;
      }
      try {
        const result = await entry.apply();
        settle(entry, { status: "applied", result });
      } catch (error) {
        settle(entry, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (entries.size) schedule(0);
  }

  // A timer callback can overlap an earlier async drain (and callers can also
  // trigger the callback twice in the same turn). Keep one drain authoritative
  // so every receipt is read, applied, and settled at most once. If the
  // overlapping callback consumed the pending timer while the first run was
  // still awaiting the queue probe, start one serialized follow-up afterward.
  function drain() {
    if (inFlightDrain) {
      const active = inFlightDrain;
      void active.then(
        () => {
          if (!closed && entries.size > 0 && timer === null) void drain();
        },
        () => {},
      );
      return active;
    }
    const run = drainOnce();
    inFlightDrain = run;
    void run.then(
      () => {
        if (inFlightDrain === run) inFlightDrain = null;
      },
      () => {
        if (inFlightDrain === run) inFlightDrain = null;
      },
    );
    return run;
  }

  function enqueue({ node_id, widget, expected_value, value, readCurrent, apply } = {}) {
    if (closed) throw new Error("deferred widget edit queue is closed");
    if (!isSafeDeferredWidgetValue(expected_value) || !isSafeDeferredWidgetValue(value)) {
      throw new Error("deferred widget edits require scalar expected_value and value fields");
    }
    if (typeof readCurrent !== "function" || typeof apply !== "function") {
      throw new TypeError("deferred widget edits require readCurrent and apply callbacks");
    }
    const receipt = receiptId();
    entries.set(receipt, {
      receipt,
      node_id,
      widget,
      expected_value,
      value,
      readCurrent,
      apply,
      created_at: now(),
      status: "queued",
    });
    schedule(0);
    return { deferred: true, receipt, status: "waiting_for_queue_idle" };
  }

  function close(reason = "the panel was replaced before the deferred edit could run") {
    closed = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    for (const entry of [...entries.values()]) {
      settle(entry, { status: "refused", error: reason });
    }
  }

  return {
    enqueue,
    close,
    pending: () => entries.size,
  };
}
