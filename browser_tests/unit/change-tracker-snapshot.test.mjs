import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { deferChangeTrackerSnapshot } from "../../web/js/lib/change-tracker-snapshot.js";

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
  const deliver = source.indexOf("if (deliverReply(reply, msg.cmd, superseded))", capture);
  const defer = source.indexOf("deferChangeTrackerSnapshot(changeTrackerToSnapshot)", deliver);
  assert.ok(capture >= 0, "successful executor path captures its tracker");
  assert.ok(deliver > capture, "reply delivery follows the successful executor");
  assert.ok(defer > deliver, "snapshot is scheduled only after the reply is delivered");
});
