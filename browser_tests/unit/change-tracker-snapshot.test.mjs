import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  deferChangeTrackerSnapshot,
  flushPendingChangeTrackerSnapshot,
  trackerCaptureSuppressed,
} from "../../web/js/lib/change-tracker-snapshot.js";

test("#581 defers the captured tracker snapshot and preserves its receiver", () => {
  let queued = null;
  let delay = null;
  let calls = 0;
  const tracker = {
    checkState() {
      assert.equal(this, tracker, "checkState must run on the tracker from the completed edit");
      calls += 1;
    },
  };

  assert.equal(
    deferChangeTrackerSnapshot(tracker, (callback, ms) => {
      queued = callback;
      delay = ms;
    }, () => {}, owns(tracker)),
    true,
  );
  assert.equal(calls, 0, "the expensive serialization cannot run before the reply path returns");
  assert.equal(delay, 0);
  queued();
  assert.equal(calls, 1);
});

test("#581 ignores unavailable trackers and swallows a deferred teardown failure", () => {
  assert.equal(deferChangeTrackerSnapshot(null), false);
  let queued = null;
  assert.equal(
    deferChangeTrackerSnapshot({ checkState() { throw new Error("workflow disposed"); } }, (callback) => {
      queued = callback;
    }),
    true,
  );
  assert.doesNotThrow(() => queued());
});

test("#581 wires the deferred snapshot after delivering a successful command reply", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");
  const capture = source.indexOf("changeTrackerToSnapshot =");
  // #1095 — matched on the leading arguments, not the exact arity. The claim here is about
  // ORDER (capture → deliver → defer the snapshot); pinning the full call made it fail when
  // the in-flight mark became a fourth argument, which is a passing assertion breaking for a
  // reason unrelated to what it checks.
  const deliver = source.slice(capture).search(/if \(deliverReply\(reply, msg\.cmd, superseded[,)]/);
  const deliverAt = deliver === -1 ? -1 : capture + deliver;
  // panel#1563 r2 — matched WITHOUT the closing paren, for the reason stated above: the
  // claim is about ORDER, and the call grew a fourth argument (the ownership predicate
  // that stops an orphaned retry chain). Pinning the arity again would break a passing
  // assertion for a reason unrelated to what it checks.
  const defer = source.indexOf("deferChangeTrackerSnapshot(changeTrackerToSnapshot", deliverAt);
  assert.ok(capture >= 0, "successful executor path captures its tracker");
  assert.ok(deliverAt > capture, "reply delivery follows the successful executor");
  assert.ok(defer > deliverAt, "snapshot is scheduled only after the reply is delivered");
});

test("#1723 flush runs the pending capture synchronously and cancels its timer", () => {
  let calls = 0;
  const tracker = { checkState() { calls += 1; } };
  let queued = null;
  let cancelled = null;
  const schedule = (callback) => {
    queued = callback;
    return "timer-1";
  };
  const cancel = (timer) => {
    cancelled = timer;
  };

  assert.equal(deferChangeTrackerSnapshot(tracker, schedule, cancel), true);
  // The burst's next command arrives before the timer phase: the capture has not run.
  assert.equal(calls, 0);
  assert.equal(flushPendingChangeTrackerSnapshot(tracker), true);
  assert.equal(calls, 1, "the fence's next observation sees the refreshed state");
  assert.equal(cancelled, "timer-1", "the deferred timer is cancelled so the capture runs once");
  // Nothing remains pending; a second flush is a no-op.
  assert.equal(flushPendingChangeTrackerSnapshot(tracker), false);
  assert.equal(calls, 1);
});

test("#1723 flush refuses a tracker that does not own the pending snapshot", () => {
  let callsA = 0;
  const trackerA = { checkState() { callsA += 1; } };
  const trackerB = { checkState() { assert.fail("tracker B must never be captured by A's snapshot"); } };
  let queued = null;
  let live = false;
  const schedule = (callback) => {
    queued = callback;
    live = true;
    return "timer-A";
  };
  const cancel = (timer) => {
    if (timer === "timer-A") live = false;
  };
  assert.equal(deferChangeTrackerSnapshot(trackerA, schedule, cancel), true);

  // A tab switch in the window. A's capture is never run against B's tracker — that
  // refusal is #1723's and is unchanged.
  assert.equal(flushPendingChangeTrackerSnapshot(trackerB), false);
  assert.equal(callsA, 0);
  // panel#1563 r2 — and A's timer is DISARMED, not left deferred. This flush is called
  // with the active workflow's tracker, so a record for another tracker is stranded:
  // when it fired it would serialize B's canvas into A's snapshot, and a later save of
  // A would write B's graph over A's file. #1723's original "stays deferred" was the
  // hazard, not a feature — upstream refuses a non-active tracker's capture anyway.
  assert.equal(live, false, "the stranded record's timer must be cancelled");
  assert.equal(flushPendingChangeTrackerSnapshot(trackerA), false, "the record is gone, not merely skipped");
  assert.equal(callsA, 0, "nothing was captured for A after it lost the canvas");
  // A null tracker is not evidence that anything was stranded: nothing to disarm.
  assert.equal(flushPendingChangeTrackerSnapshot(null), false);
  assert.equal(typeof queued, "function");
});

test("#1723 a stale timer must not clear a NEWER pending record", () => {
  const tracker = { checkState() {} };
  let first = null;
  let second = null;
  deferChangeTrackerSnapshot(tracker, (callback) => { first = callback; });
  deferChangeTrackerSnapshot(tracker, (callback) => { second = callback; });
  // The first timer fires after the second defer replaced the record: the second
  // record must survive so a flush can still consume it.
  first();
  assert.equal(flushPendingChangeTrackerSnapshot(tracker), true);
  second(); // idempotent no-op capture; must not throw.
});

test("#1723 prefers captureCanvasState over the deprecated checkState", () => {
  let current = 0;
  let legacy = 0;
  const tracker = {
    captureCanvasState() { current += 1; },
    checkState() { legacy += 1; },
  };
  let queued = null;
  assert.equal(deferChangeTrackerSnapshot(tracker, (callback) => { queued = callback; }), true);
  assert.equal(flushPendingChangeTrackerSnapshot(tracker), true);
  assert.equal(current, 1);
  assert.equal(legacy, 0, "the deprecated name is only a fallback");
});

test("#1723 defers and flushes on a tracker that only has captureCanvasState", () => {
  let calls = 0;
  const tracker = { captureCanvasState() { calls += 1; } };
  let queued = null;
  assert.equal(
    deferChangeTrackerSnapshot(tracker, (callback) => { queued = callback; }, () => {}, owns(tracker)),
    true,
    "a current-frontend tracker must still queue — checkState-only support leaves the fingerprint stale forever",
  );
  queued();
  assert.equal(calls, 1);
});

test("#1723 flush swallows a capture failure like the deferred path does", () => {
  const tracker = { checkState() { throw new Error("workflow disposed"); } };
  deferChangeTrackerSnapshot(tracker, () => {});
  assert.doesNotThrow(() => flushPendingChangeTrackerSnapshot(tracker));
  assert.equal(flushPendingChangeTrackerSnapshot(tracker), false, "a consumed record stays consumed");
});

test("#1723 wires the flush BEFORE the graph-binding fence in the dispatch path", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");
  const flush = source.indexOf("flushPendingChangeTrackerSnapshot(");
  const fence = source.indexOf("assertGraphBoundToActiveWorkflow(graph, rootGraph, graphCommandBindingBar(msg.cmd))");
  assert.ok(flush >= 0, "the dispatch path flushes a pending tracker snapshot");
  assert.ok(fence > flush, "the flush lands before the binding fence reads the tracker");
});

// ---------------------------------------------------------------------------
// panel#1563/#1564 — a capture upstream SILENTLY skips.
// ---------------------------------------------------------------------------

/** Upstream's own shape, reduced to what decides this: `captureCanvasState()` returns
 *  early — no throw, no value — while a suppression window is open, and only replaces
 *  `activeState` when it actually runs and the canvas moved. */
/** A POSITIVE ownership answer: the store names THIS tracker as the active one. */
const owns = (tracker) => (candidate) => candidate === tracker;

function upstreamTracker({ suppressed = false } = {}) {
  return {
    activeState: { nodes: [], generation: 0 },
    changeCount: suppressed ? 1 : 0,
    _restoringState: false,
    calls: 0,
    captureCanvasState() {
      this.calls += 1;
      if (this._restoringState || this.changeCount > 0) return; // the silent early return
      this.activeState = { nodes: [], generation: this.activeState.generation + 1 };
    },
  };
}

test("#1563 upstream's three suppression conditions are read; an unknown tracker is NOT suppressed", () => {
  assert.equal(trackerCaptureSuppressed({ changeCount: 1 }), true);
  assert.equal(trackerCaptureSuppressed({ _restoringState: true }), true);
  class Loading {}
  Loading.isLoadingGraph = true;
  assert.equal(trackerCaptureSuppressed(new Loading()), true);
  // POSITIVE evidence only: a tracker whose fields this panel cannot read must not put
  // the retry chain into a spin. (The destructive close path's `captureWasSuppressed`
  // deliberately answers the other way; see its comment.)
  assert.equal(trackerCaptureSuppressed({}), false);
  assert.equal(trackerCaptureSuppressed(null), false);
  assert.equal(trackerCaptureSuppressed({ changeCount: 0, _restoringState: false }), false);
  // TRUTHY, not `=== true`. `captureWasSuppressed` (#882, the destructive close path)
  // delegates here and read these flags as truthy before the refactor; a strict identity
  // check would silently narrow that fail-closed guard.
  assert.equal(trackerCaptureSuppressed({ _restoringState: 1 }), true);
  class LoadingTruthy {}
  LoadingTruthy.isLoadingGraph = 1;
  assert.equal(trackerCaptureSuppressed(new LoadingTruthy()), true);
});

test("#1563 a SWALLOWED deferred capture is retried until upstream stops skipping it", () => {
  const tracker = upstreamTracker({ suppressed: true });
  const queue = [];
  deferChangeTrackerSnapshot(tracker, (cb, ms) => {
    queue.push({ cb, ms });
    return queue.length;
  }, () => {}, owns(tracker));

  queue.shift().cb(); // first attempt: swallowed
  assert.equal(tracker.activeState.generation, 0, "upstream skipped it");
  assert.ok(queue.length > 0, "a swallowed capture must leave a retry armed — otherwise the snapshot is stranded behind the canvas forever");

  queue.shift().cb(); // still suppressed
  assert.equal(tracker.activeState.generation, 0);
  assert.ok(queue.length > 0);

  tracker.changeCount = 0; // the transient window closes
  queue.shift().cb();
  assert.equal(tracker.activeState.generation, 1, "the snapshot catches up once upstream allows it");
  assert.equal(queue.length, 0, "a landed capture arms nothing further");
});

test("#1563 the retry chain is BOUNDED — a window that never closes cannot spin forever", () => {
  const tracker = upstreamTracker({ suppressed: true });
  const queue = [];
  deferChangeTrackerSnapshot(tracker, (cb) => {
    queue.push(cb);
    return queue.length;
  }, () => {}, owns(tracker));
  let fired = 0;
  while (queue.length && fired < 50) {
    queue.shift()();
    fired += 1;
  }
  assert.equal(queue.length, 0, "the chain terminates");
  assert.ok(fired <= 10, `bounded attempts, got ${fired}`);
  assert.equal(tracker.activeState.generation, 0, "nothing was captured — that is what the save guard then refuses on");
});

test("#1563 a NO-CHANGE capture is not retried — an unchanged snapshot is the clean-tab case", () => {
  const tracker = upstreamTracker();
  tracker.captureCanvasState = function () {
    this.calls += 1; // ran, saw no difference, left activeState alone
  };
  const queue = [];
  deferChangeTrackerSnapshot(tracker, (cb) => {
    queue.push(cb);
    return queue.length;
  }, () => {}, owns(tracker));
  queue.shift()();
  assert.equal(tracker.calls, 1);
  assert.equal(queue.length, 0, "an unchanged snapshot on a readable, unsuppressed tracker is not a swallowed call");
});

// ---------------------------------------------------------------------------
// panel#1563 r2 — THE ORPHANED CHAIN. A capture serializes the GLOBAL live canvas
// into THIS tracker's `activeState`, so a chain that outlives its workflow does not
// just waste a timer: it writes whatever canvas is on screen now into the snapshot of
// the workflow that armed it, and a later save of that workflow persists the wrong
// graph over its file. The retry window is exactly where that became reachable —
// `isLoadingGraph` is a CLASS STATIC, so an orphaned record reads "suppressed" for the
// whole of the NEXT workflow's load and then fires the moment that load completes.
// ---------------------------------------------------------------------------

test("#1563 r2 WIRING: the dispatch path supplies trackerStillOwnsCanvas, and it demands POSITIVE ownership", () => {
  // The helper tests above inject a predicate by hand, so they stay green even if
  // production stops passing one — the argument is a one-line wiring change, and this is
  // the only thing that can see it go missing. The predicate itself is sliced from the
  // panel source and DRIVEN, so its answer is pinned rather than its spelling.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");
  const at = source.indexOf("deferChangeTrackerSnapshot(changeTrackerToSnapshot");
  assert.ok(at > 0, "the dispatch path defers the tracker snapshot");
  assert.match(
    source.slice(at, at + 200),
    /deferChangeTrackerSnapshot\(\s*changeTrackerToSnapshot\s*,[^)]*trackerStillOwnsCanvas/,
    "the defer must carry the ownership predicate, or an orphaned retry chain can capture another workflow's canvas",
  );

  const fnAt = source.indexOf("function trackerStillOwnsCanvas(tracker) {");
  assert.ok(fnAt > 0, "the predicate must be a named function, not an inline closure");
  const fnEnd = source.indexOf("\n}", fnAt);
  const slice = source.slice(fnAt, fnEnd + 2);
  const build = (activeWorkflow) =>
    new Function("activeWorkflowRef", `${slice}\nreturn trackerStillOwnsCanvas;`)(() => activeWorkflow);

  const tracker = { captureCanvasState() {} };
  const other = { captureCanvasState() {} };
  assert.equal(build({ changeTracker: tracker })(tracker), true, "the owning tracker keeps its licence");
  assert.equal(build({ changeTracker: other })(tracker), false, "another workflow's tracker has none");
  // THE POINT: an unreadable store is NOT permission. During a tab switch or a close the
  // store answers null while the canvas on screen is already someone else's, and a
  // capture then writes that canvas into this tracker's state — which a later save
  // persists over its own file.
  assert.equal(build(null)(tracker), false, "a null active workflow must never license a capture");
  assert.equal(build(undefined)(tracker), false);
  assert.equal(build({})(tracker), false, "an active workflow with no tracker proves nothing");
});

test("#1563 r2 the retry chain STOPS once its tracker no longer owns the canvas", () => {
  const trackerA = upstreamTracker({ suppressed: true });
  const queue = [];
  let ownsCanvas = true;
  deferChangeTrackerSnapshot(
    trackerA,
    (cb, ms) => {
      queue.push({ cb, ms });
      return queue.length;
    },
    () => {},
    (tracker) => tracker === trackerA && ownsCanvas,
  );

  queue.shift().cb(); // swallowed while A still owns the canvas: the chain continues
  assert.ok(queue.length > 0, "a swallowed capture on the OWNING tracker still retries");

  // Workflow B opens. A's tracker keeps reading "suppressed" (isLoadingGraph is a class
  // static), and when the load finishes the canvas on screen is B's.
  ownsCanvas = false;
  trackerA.changeCount = 0; // the window closes — WITHOUT the ownership check this captures
  queue.shift().cb();

  assert.equal(
    trackerA.activeState.generation,
    0,
    "the orphaned chain must NOT capture: that write would stamp workflow B's canvas into workflow A's snapshot",
  );
  assert.equal(queue.length, 0, "and the chain ends rather than asking again");
});

test("#1563 r2 an ownership question that THROWS is not a licence to write", () => {
  const tracker = upstreamTracker({ suppressed: true });
  const queue = [];
  deferChangeTrackerSnapshot(
    tracker,
    (cb) => {
      queue.push(cb);
      return queue.length;
    },
    () => {},
    () => {
      throw new Error("workflow store torn down mid-reload");
    },
  );
  tracker.changeCount = 0;
  queue.shift()();
  assert.equal(tracker.activeState.generation, 0, "unreadable ownership must not capture");
  assert.equal(queue.length, 0);
});

test("#1563 r3 a caller that supplies NO ownership predicate captures NOTHING, and says so", async () => {
  // r2 asserted the opposite — "no predicate ⇒ behaves as before" — and that assertion
  // WAS the P1: with no way to establish ownership the module cannot know whose canvas
  // it is about to serialize, and "as before" was the unguarded write. Fail closed.
  // A FRESH module instance: the disclosure is deliberately once-per-session, so
  // asserting it against the shared import would pass or fail on test ORDER.
  const fresh = await import(`../../web/js/lib/change-tracker-snapshot.js?r3=${Date.now()}`);
  const tracker = upstreamTracker();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const queue = [];
    fresh.deferChangeTrackerSnapshot(tracker, (cb) => {
      queue.push(cb);
      return queue.length;
    }, () => {});
    queue.shift()();
    assert.equal(tracker.calls, 0, "an unestablished owner may not authorise a capture");
    assert.equal(queue.length, 0, "and the chain does not keep asking");
  } finally {
    console.warn = realWarn;
  }
  // Failing closed silently is how a missing guard survives a release (#1667).
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /without an ownership predicate/);
});

test("#1563 r3 an UNANSWERABLE ownership question abandons the chain", () => {
  // The shape codex caught at the call site: `activeWorkflowRef()` answers null both
  // when nothing is active and when the lookup failed. Neither is "still yours".
  for (const answer of [null, undefined, 0, "", NaN]) {
    const tracker = upstreamTracker({ suppressed: true });
    const queue = [];
    deferChangeTrackerSnapshot(tracker, (cb) => {
      queue.push(cb);
      return queue.length;
    }, () => {}, () => answer);
    queue.shift()();
    assert.equal(tracker.calls, 0, `answer ${String(answer)} must not authorise a capture`);
    assert.equal(queue.length, 0, `answer ${String(answer)} must not leave a chain armed`);
  }
});

test("#1563 r3 a TRUTHY-but-not-true answer is still not permission", () => {
  // `=== true` deliberately, not truthiness: a predicate returning an object (a
  // workflow record, say) is answering a different question than the one asked.
  const tracker = upstreamTracker({ suppressed: true });
  const queue = [];
  deferChangeTrackerSnapshot(tracker, (cb) => {
    queue.push(cb);
    return queue.length;
  }, () => {}, () => ({ changeTracker: tracker }));
  queue.shift()();
  assert.equal(tracker.calls, 0);
  assert.equal(queue.length, 0);
});

test("#1563 r2 a NEW defer cancels the previous record's armed chain", () => {
  const trackerA = upstreamTracker({ suppressed: true });
  const trackerB = upstreamTracker();
  const cancelled = [];
  let id = 0;
  const schedule = (cb) => {
    id += 1;
    return { id, cb };
  };
  deferChangeTrackerSnapshot(trackerA, schedule, (timer) => cancelled.push(timer?.id));
  deferChangeTrackerSnapshot(trackerB, schedule, (timer) => cancelled.push(timer?.id));
  assert.deepEqual(cancelled, [1], "replacing the pending marker must also disarm the record it replaced");
});

test("#1563 r2 a flush for a DIFFERENT tracker cancels the stranded chain", () => {
  // The flush is called with the ACTIVE workflow's tracker before every graph command,
  // so a pending record for another tracker is provably stranded.
  const trackerA = upstreamTracker({ suppressed: true });
  const trackerB = upstreamTracker();
  const queue = [];
  let cancelled = 0;
  deferChangeTrackerSnapshot(trackerA, (cb) => {
    queue.push(cb);
    return queue.length;
  }, () => {
    cancelled += 1;
  });
  queue.length = 0;

  assert.equal(flushPendingChangeTrackerSnapshot(trackerB), false, "a foreign tracker is never flushed");
  assert.equal(cancelled, 1, "and the stranded record is disarmed rather than left to fire on B's canvas");
  assert.equal(flushPendingChangeTrackerSnapshot(trackerA), false, "the stranded record is gone, not merely skipped");
});

test("#1563 a flush upstream swallows keeps the record PENDING for the next command", () => {
  const tracker = upstreamTracker({ suppressed: true });
  const queue = [];
  const schedule = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  deferChangeTrackerSnapshot(tracker, schedule, () => {});
  queue.length = 0; // the fence's flush pre-empts the timer

  assert.equal(flushPendingChangeTrackerSnapshot(tracker), true);
  assert.equal(tracker.activeState.generation, 0, "the flush was swallowed too");
  assert.ok(queue.length > 0, "the swallowed flush must re-arm rather than consume the record");
  // The record is still THIS tracker's, so the next command's flush can still take it.
  tracker.changeCount = 0;
  assert.equal(flushPendingChangeTrackerSnapshot(tracker), true);
  assert.equal(tracker.activeState.generation, 1);
  assert.equal(flushPendingChangeTrackerSnapshot(tracker), false, "a LANDED flush consumes the record");
});
