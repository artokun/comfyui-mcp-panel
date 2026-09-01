import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  captureRunDispatchIdentity,
  compareRunDispatchIdentity,
  downgradeUnstableRunResult,
} from "../../web/js/lib/run-dispatch-identity.js";

const PANEL_SRC = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const identity = (overrides = {}) =>
  captureRunDispatchIdentity({
    routeId: "route-a",
    routeReady: true,
    routeIdentityProven: true,
    workflowUuid: "11111111-1111-4111-8111-111111111111",
    workflowIdentityProven: true,
    backendSocketState: "available",
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
      workflowUuid: "22222222-2222-4222-8222-222222222222",
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

test("equal absent route identities are never stable", () => {
  const result = compareRunDispatchIdentity(
    identity({ routeId: null, routeIdentityProven: true }),
    identity({ routeId: null, routeIdentityProven: true }),
  );
  assert.equal(result.stable, false);
  assert.deepEqual(result.changed, ["bridge route unavailable"]);
});

test("route readiness is required for a live identity", () => {
  const result = compareRunDispatchIdentity(identity(), identity({ routeReady: false }));
  assert.equal(result.stable, false);
  assert.deepEqual(result.changed, ["route readiness"]);
});

test("a local dispatch may omit the bridge route without weakening other identity fences", () => {
  const result = compareRunDispatchIdentity(
    identity({ routeId: null, routeReady: false, routeIdentityProven: false }),
    identity({ routeId: null, routeReady: false, routeIdentityProven: false }),
    { requireBridgeRoute: false },
  );
  assert.equal(result.stable, true);
});

test("a local dispatch still rejects a workflow handoff while the bridge is absent", () => {
  const result = compareRunDispatchIdentity(
    identity({ routeId: null, routeReady: false, routeIdentityProven: false }),
    identity({
      routeId: null,
      routeReady: false,
      routeIdentityProven: false,
      workflowUuid: "22222222-2222-4222-8222-222222222222",
    }),
    { requireBridgeRoute: false },
  );
  assert.equal(result.stable, false);
  assert.deepEqual(result.changed, ["workflow"]);
});

test("equal socket-down identities are never stable", () => {
  const result = compareRunDispatchIdentity(
    identity({ backendSocketState: "down" }),
    identity({ backendSocketState: "down" }),
  );
  assert.equal(result.stable, false);
  assert.deepEqual(result.changed, ["backend socket down"]);
});

test("an unknown socket state is never stable", () => {
  const result = compareRunDispatchIdentity(
    identity({ backendSocketState: "unknown" }),
    identity({ backendSocketState: "unknown" }),
  );
  assert.equal(result.stable, false);
  assert.deepEqual(result.changed, ["backend socket unavailable"]);
});

test("legacy false/false socket observations are normalized to unknown", () => {
  const result = compareRunDispatchIdentity(
    identity({ backendSocketState: null, backendSocketDown: false }),
    identity({ backendSocketState: null, backendSocketDown: false }),
  );
  assert.equal(result.stable, false);
  assert.equal(result.before.backendSocketState, "unknown");
  assert.equal(result.after.backendSocketState, "unknown");
  assert.deepEqual(result.changed, ["backend socket unavailable"]);
});

test("equal absent or invalid workflow identities are never stable", () => {
  for (const workflowUuid of [null, "not-a-uuid"]) {
    const result = compareRunDispatchIdentity(
      identity({ workflowUuid, workflowIdentityProven: true }),
      identity({ workflowUuid, workflowIdentityProven: true }),
    );
    assert.equal(result.stable, false, workflowUuid ?? "null workflow identity");
    assert.deepEqual(result.changed, ["workflow identity unavailable"]);
  }
});

test("an explicitly ambiguous workflow owner is never stable", () => {
  const result = compareRunDispatchIdentity(
    identity(),
    identity({ workflowIdentityAmbiguous: true }),
  );
  assert.equal(result.stable, false);
  assert.deepEqual(result.changed, ["workflow identity ambiguous"]);
});

test("the production identity provider publishes proof, not a swallowed null UUID", () => {
  const start = PANEL_SRC.indexOf("const panelRunDispatchIdentity =");
  const end = PANEL_SRC.indexOf("  const panelRunReceiptTransport", start);
  assert.ok(start >= 0 && end > start, "the production identity provider is still present");
  const provider = PANEL_SRC.slice(start, end);
  assert.match(provider, /let routeReady = false;/);
  assert.match(provider, /let routeIdentityProven = false;/);
  assert.match(provider, /routeIdentityProven = typeof routeId === "string"/);
  assert.match(provider, /const transportState = backendSocketTransportState\(/);
  assert.match(provider, /backendSocketState = comfyBackendSocketDown === true \? "down" : transportState/);
  assert.match(provider, /backendSocketState,/);
  assert.match(provider, /const probe = probeActiveWorkflow\(\);/);
  assert.match(provider, /const candidate =/);
  assert.match(provider, /workflowObjectUuid\(workflow\)/);
  assert.match(provider, /workflowIdentityProven = true;/);
  assert.match(provider, /workflowIdentityAmbiguous/);
  assert.match(provider, /isCanonicalWorkflowInstanceUuid\(candidate\)/);
  assert.doesNotMatch(provider, /workflowUuid = workflowStableUuid\(\);/);
});

test("the local /run route exemption is a private capability, not bridge input", () => {
  assert.match(PANEL_SRC, /const LOCAL_GRAPH_RUN_TOKEN = Symbol\("local graph run"\);/);
  assert.match(PANEL_SRC, /const localRun = arguments\[0\]\?\.\[LOCAL_GRAPH_RUN_TOKEN\] === true;/);
  assert.match(
    PANEL_SRC,
    /const localArgs = cmd === "graph_run" \? \{ \.\.\.args, \[LOCAL_GRAPH_RUN_TOKEN\]: true \} : args;/,
  );
  assert.match(PANEL_SRC, /requireBridgeRoute: !localRun/);
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
