import test from "node:test";
import assert from "node:assert/strict";

import {
  captureRunDispatchIdentity,
  compareRunDispatchIdentity,
  downgradeUnstableRunResult,
} from "../../web/js/lib/run-dispatch-identity.js";

const identity = (overrides = {}) =>
  captureRunDispatchIdentity({
    routeId: "route-a",
    routeReady: true,
    workflowUuid: "workflow-a",
    reconnectEpoch: 4,
    targetId: "10:7",
    ...overrides,
  });

test("run dispatch identity treats an unchanged route/workflow/target as stable", () => {
  const before = identity();
  const after = identity();
  assert.deepEqual(compareRunDispatchIdentity(before, after), {
    stable: true,
    changed: [],
    before,
    after,
  });
});

test("run dispatch identity reports reconnect, route, workflow, target, and readiness changes", () => {
  const result = compareRunDispatchIdentity(
    identity(),
    identity({
      routeId: "route-b",
      routeReady: false,
      workflowUuid: "workflow-b",
      reconnectEpoch: 5,
      targetId: "11:8",
    }),
  );
  assert.equal(result.stable, false);
  assert.deepEqual(result.changed, [
    "reconnect",
    "bridge route",
    "workflow",
    "run target",
    "route readiness",
  ]);
});

test("an unreadable identity is not a wildcard", () => {
  const result = compareRunDispatchIdentity(identity(), identity({ routeId: null }));
  assert.equal(result.stable, false);
  assert.deepEqual(result.changed, ["bridge route"]);
});

test("route readiness is required for a live identity", () => {
  const result = compareRunDispatchIdentity(identity(), captureRunDispatchIdentity({ routeReady: false }));
  assert.equal(result.stable, false);
  assert.deepEqual(result.changed, ["reconnect", "bridge route", "workflow", "run target", "route readiness"]);
});

test("an unstable scoped receipt keeps queued_prompt_ids while removing queued:true", () => {
  const result = downgradeUnstableRunResult(
    { queued: true, queued_prompt_ids: ["scoped-1", "scoped-2"], complete: false },
    compareRunDispatchIdentity(identity(), identity({ reconnectEpoch: 5 })),
  );
  assert.equal(result.queued, undefined);
  assert.equal(result.queued_unknown, true);
  assert.deepEqual(result.queued_prompt_ids, ["scoped-1", "scoped-2"]);
  assert.equal(result.prompt_id, "scoped-1");
  assert.deepEqual(result.prompt_ids, ["scoped-1", "scoped-2"]);
});
