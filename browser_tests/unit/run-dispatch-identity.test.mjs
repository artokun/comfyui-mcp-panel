import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  backendSocketIsDown,
  backendSocketTransportState,
  WS_OPEN,
} from "../../web/js/lib/reconnect-recovery.js";
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
  // #2854 — must be the COMBINED predicate, not the raw sticky flag.
  assert.match(provider, /backendSocketState = comfyBackendIsDown\(\) \? "down" : transportState/);
  assert.doesNotMatch(provider, /backendSocketState = comfyBackendSocketDown === true/);
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

// #2854 - panel_run refused every dispatch for an hour while every other panel_*
// call on the same canvas succeeded and reported backend_socket "up".
//
// The provider decides backendSocketState. Driving that decision through the REAL
// helpers, both ways, separates the fix from the bug: the busted form reads the
// sticky flag alone; the fixed form asks comfyBackendIsDown(), whose rule is
// "flaggedDown + OPEN is a stale or busy-poll signal, not a down socket" (#1325).
const providerState = (decide, flaggedDown, socketReadyState) =>
  decide(flaggedDown, socketReadyState)
    ? "down"
    : backendSocketTransportState({ socketReadyState });

const FIXED = (flaggedDown, socketReadyState) =>
  backendSocketIsDown({ flaggedDown, socketReadyState });
const BUSTED = (flaggedDown) => flaggedDown === true;

test("#2854 a stale sticky flag over an OPEN socket does not refuse the dispatch", () => {
  const state = providerState(FIXED, true, WS_OPEN);
  assert.equal(state, "available", "flaggedDown + OPEN is stale, not down");
  const result = compareRunDispatchIdentity(
    identity({ backendSocketState: state }),
    identity({ backendSocketState: state }),
  );
  assert.equal(result.stable, true);
  assert.deepEqual(result.changed, []);
});

test("#2854 the pre-fix decision is what produced the permanent refusal", () => {
  const state = providerState(BUSTED, true, WS_OPEN);
  assert.equal(state, "down");
  const result = compareRunDispatchIdentity(
    identity({ backendSocketState: state }),
    identity({ backendSocketState: state }),
  );
  assert.equal(result.stable, false);
  assert.deepEqual(result.changed, ["backend socket down"]);
});

test("#2854 fail-closed directions are unchanged by the fix", () => {
  assert.equal(providerState(FIXED, true, 3), "down");
  assert.equal(providerState(FIXED, true, undefined), "down");
  assert.equal(providerState(FIXED, false, undefined), "unknown");
  assert.equal(providerState(FIXED, false, WS_OPEN), "available");
});
