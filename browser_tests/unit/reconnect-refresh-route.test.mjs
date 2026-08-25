// #1787 — exercise the shipped panel_refresh_nodes wrapper at the command
// boundary. A helper-only test would not prove that route readiness is checked
// before the coalescer is allowed to fetch/register node definitions.
import test from "node:test";
import assert from "node:assert/strict";

import { PANEL_SRC, REFRESH_NODES_EXECUTOR_DEPS } from "./_panel-constants.mjs";

const refreshNodesMatch = PANEL_SRC.match(/\n {2}async refresh_nodes\(\) \{[\s\S]*?\n {2}\},/);
assert.ok(refreshNodesMatch, "could not locate refresh_nodes in panel source");

function buildRefreshNodes(awaitActiveRouteRegistration) {
  let refreshCalls = 0;
  const deps = {
    ...REFRESH_NODES_EXECUTOR_DEPS,
    awaitActiveRouteRegistration,
    refreshComfyNodeDefs: async () => {
      refreshCalls += 1;
      return { refreshed: true, reason: "refreshed" };
    },
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const executors = {${refreshNodesMatch[0]}};
     return executors.refresh_nodes;`,
  );
  return {
    refresh_nodes: factory(...names.map((name) => deps[name])),
    get refreshCalls() {
      return refreshCalls;
    },
  };
}

test("#1787 refresh_nodes waits for the active route before starting the production refresh", async () => {
  let release;
  const routeReady = new Promise((resolve) => {
    release = resolve;
  });
  const built = buildRefreshNodes(() => routeReady);
  const pending = built.refresh_nodes();

  await Promise.resolve();
  assert.equal(built.refreshCalls, 0, "node definitions must not be fetched while route registration is pending");

  release();
  const result = await pending;
  assert.equal(result.refreshed, true);
  assert.equal(built.refreshCalls, 1, "the refresh starts exactly once after the route becomes ready");
});

test("#1787 a route-readiness refusal is fail-closed before the refresh consumer runs", async () => {
  const built = buildRefreshNodes(async () => {
    throw new Error("route registration not ready");
  });

  await assert.rejects(built.refresh_nodes(), /route registration not ready/);
  assert.equal(built.refreshCalls, 0, "a failed handoff must not fetch or register node definitions");
});

test("#1787 production wiring keeps the readiness gate ahead of refreshComfyNodeDefs", () => {
  const refreshBody = refreshNodesMatch[0];
  assert.match(refreshBody, /await awaitActiveRouteRegistration\(\);[\s\S]*refreshComfyNodeDefs/);
  assert.match(PANEL_SRC, /route_registration_readiness/);
  assert.match(PANEL_SRC, /routeRegistrationReadinessRefusalError/);
});
