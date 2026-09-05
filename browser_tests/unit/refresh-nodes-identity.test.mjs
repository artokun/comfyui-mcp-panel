// #2026 — after panel_open_workflow bound UUID A, panel_refresh_nodes returned
// refreshed:true with viewing.workflow_uuid B on the same graph_identity, and
// the next graph_outline was refused by the workflow-instance fence. Drive the
// shipped awaitActiveRouteRegistration and refresh_nodes bodies: a helper-only
// test would not prove the executor snapshots the canvas it refreshed, or that
// the route gate rejects a ready route whose UUID is not the command-bound one.
import test from "node:test";
import assert from "node:assert/strict";

import { PANEL_SRC, REFRESH_NODES_EXECUTOR_DEPS } from "./_panel-constants.mjs";

function extractPanelFn(sig) {
  const start = PANEL_SRC.indexOf(sig);
  assert.notEqual(start, -1, `${sig} not found in the panel source`);
  const open = PANEL_SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < PANEL_SRC.length; i += 1) {
    const ch = PANEL_SRC[i];
    if (ch === "/" && PANEL_SRC[i + 1] === "/") {
      i = PANEL_SRC.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && PANEL_SRC[i + 1] === "*") {
      i = PANEL_SRC.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < PANEL_SRC.length; i += 1) {
        if (PANEL_SRC[i] === "\\") {
          i += 1;
          continue;
        }
        if (PANEL_SRC[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return PANEL_SRC.slice(start, i + 1);
  }
  throw new Error(`unterminated: ${sig}`);
}

const refreshNodesMatch = PANEL_SRC.match(/\n {2}async refresh_nodes\(\) \{[\s\S]*?\n {2}\},/);
assert.ok(refreshNodesMatch, "could not locate refresh_nodes in panel source");

const BOUND = {
  scope: "root",
  workflow_uuid: "uuid-A",
  graph_identity: "graph:same",
};
const STALE_SAME_GRAPH = {
  scope: "root",
  workflow_uuid: "uuid-B",
  graph_identity: "graph:same",
};
const SWITCHED = {
  scope: "root",
  workflow_uuid: "uuid-B",
  graph_identity: "graph:other",
};

function readyClient({ uuid = "uuid-A" } = {}) {
  return {
    isConnected: () => true,
    isRouteReady: () => true,
    waitForRouteReady: async () => true,
    uuid,
  };
}

function buildAwaitActiveRouteRegistration({
  client = readyClient(),
  workflowStableUuid = () => client.uuid,
} = {}) {
  const factory = new Function(
    "ROUTE_REGISTRATION_WAIT_STEPS_MS",
    "workflowStableUuid",
    `let liveBridgeClient = null;
     const routeRegistrationReadinessRefusals = new WeakSet();
     ${extractPanelFn("function routeRegistrationReadinessRefusalError")}
     ${extractPanelFn("function readRouteRegistrationReadinessRefusal")}
     ${extractPanelFn("function routeWorkflowUuidDiffers")}
     ${extractPanelFn("async function awaitActiveRouteRegistration")}
     return {
       awaitActiveRouteRegistration,
       setClient(next) { liveBridgeClient = next; },
       readRefusal: readRouteRegistrationReadinessRefusal,
     };`,
  );
  const built = factory(Object.freeze([0, 0]), workflowStableUuid);
  built.setClient(client);
  return built;
}

function routeRegistrationRefusalError(reason) {
  const detail =
    typeof reason === "string" && reason.trim()
      ? reason.trim()
      : "the active bridge route is still being registered";
  return new Error(
    "panel_refresh_nodes did not run because " +
      detail +
      ". Nothing was refreshed; retry after the reconnect settles.",
  );
}

function buildRefreshNodes({
  awaitActiveRouteRegistration = async () => {},
  refreshComfyNodeDefs,
  liveParseableViewingWitness,
  workflowStableUuid = () => BOUND.workflow_uuid,
} = {}) {
  let refreshCalls = 0;
  const deps = {
    ...REFRESH_NODES_EXECUTOR_DEPS,
    awaitActiveRouteRegistration,
    refreshComfyNodeDefs:
      refreshComfyNodeDefs ||
      (async () => {
        refreshCalls += 1;
        return { refreshed: true, reason: "refreshed" };
      }),
    liveParseableViewingWitness,
    workflowStableUuid,
    routeRegistrationReadinessRefusalError: routeRegistrationRefusalError,
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

test("#2026 awaitActiveRouteRegistration refuses a ready route whose UUID is not the command-bound instance", async () => {
  const built = buildAwaitActiveRouteRegistration({
    client: readyClient({ uuid: "uuid-B" }),
  });
  await assert.rejects(
    () => built.awaitActiveRouteRegistration("uuid-A"),
    (err) => {
      assert.match(err.message, /different workflow instance than the command-bound canvas/);
      assert.deepEqual(built.readRefusal(err), {
        code: "route-registration-not-ready",
        ready: false,
        applied: false,
        stage: "pre-refresh",
        retryable: true,
      });
      return true;
    },
  );
});

test("#2026 awaitActiveRouteRegistration accepts a ready route that still names the command-bound UUID", async () => {
  const built = buildAwaitActiveRouteRegistration({
    client: readyClient({ uuid: "uuid-A" }),
  });
  await built.awaitActiveRouteRegistration("uuid-A");
});

test("#2026 awaitActiveRouteRegistration still no-ops when the bridge is down", async () => {
  const built = buildAwaitActiveRouteRegistration({
    client: {
      isConnected: () => false,
      isRouteReady: () => false,
      uuid: "uuid-B",
    },
  });
  await built.awaitActiveRouteRegistration("uuid-A");
});

test("#2026 awaitActiveRouteRegistration refuses when the route's UUID moves while waiting to register", async () => {
  let uuid = "uuid-A";
  let ready = false;
  const client = {
    isConnected: () => true,
    isRouteReady: () => ready,
    waitForRouteReady: async () => {
      uuid = "uuid-B";
      ready = true;
      return true;
    },
  };
  const built = buildAwaitActiveRouteRegistration({
    client,
    workflowStableUuid: () => uuid,
  });
  await assert.rejects(
    () => built.awaitActiveRouteRegistration("uuid-A"),
    /different workflow instance than the command-bound canvas/,
  );
});

test("#2026 refresh_nodes publishes the snapshotted UUID when a stale workflow object remints the same graph", async () => {
  const views = [BOUND, STALE_SAME_GRAPH];
  const uuids = ["uuid-A", "uuid-B"];
  const built = buildRefreshNodes({
    liveParseableViewingWitness: () => views.shift() || STALE_SAME_GRAPH,
    workflowStableUuid: () => uuids.shift() || "uuid-B",
  });
  const result = await built.refresh_nodes();
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.viewing.workflow_uuid, "uuid-A");
  assert.equal(result.viewing.graph_identity, "graph:same");
});

test("#2026 refresh_nodes refuses instead of refreshed:true when the active route changes during refresh", async () => {
  const views = [BOUND, SWITCHED];
  const uuids = ["uuid-A", "uuid-B"];
  let refreshCalls = 0;
  const built = buildRefreshNodes({
    liveParseableViewingWitness: () => views.shift() || SWITCHED,
    workflowStableUuid: () => uuids.shift() || "uuid-B",
    refreshComfyNodeDefs: async () => {
      refreshCalls += 1;
      return { refreshed: true, reason: "refreshed" };
    },
  });
  await assert.rejects(
    () => built.refresh_nodes(),
    /changed to a different workflow instance while node definitions were refreshing/,
  );
  assert.equal(refreshCalls, 1, "the refresh may finish; the reply must not claim another UUID");
});

test("#2026 production refresh_nodes snapshots identity, gates the route on that UUID, and republishes it", () => {
  const refreshBody = refreshNodesMatch[0];
  assert.match(refreshBody, /liveParseableViewingWitness\(\)/);
  assert.match(refreshBody, /await awaitActiveRouteRegistration\([^)]+\);[\s\S]*refreshComfyNodeDefs/);
  assert.match(
    refreshBody,
    /refreshComfyNodeDefs[\s\S]*liveParseableViewingWitness\(\)/,
    "identity must be re-read after the refresh so a route change can be refused",
  );
  assert.match(refreshBody, /viewing: boundIdentity/);
});

test("#2257 production refresh_nodes recaptures the active tracker after a successful refresh", () => {
  const refreshBody = refreshNodesMatch[0];
  assert.match(
    refreshBody,
    /captureCanvasIntoTracker\(wf\)/,
    "refresh must recapture content identity so the next Save-As / graph read is not root-shape-mismatch",
  );
  assert.match(refreshBody, /sealProvenRootBinding\(/);
});
