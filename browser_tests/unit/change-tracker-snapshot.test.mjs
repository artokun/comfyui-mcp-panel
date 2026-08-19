import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  deferChangeTrackerSnapshot,
  flushPendingChangeTrackerSnapshot,
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
    }),
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
  const defer = source.indexOf("deferChangeTrackerSnapshot(changeTrackerToSnapshot)", deliverAt);
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
  assert.equal(deferChangeTrackerSnapshot(trackerA, (callback) => { queued = callback; }), true);

  // A tab switch in the window: the pending capture belongs to A and stays deferred.
  assert.equal(flushPendingChangeTrackerSnapshot(trackerB), false);
  assert.equal(flushPendingChangeTrackerSnapshot(null), false);
  assert.equal(callsA, 0);
  // The original timer still fires for A, exactly once.
  queued();
  assert.equal(callsA, 1);
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
    deferChangeTrackerSnapshot(tracker, (callback) => { queued = callback; }),
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
