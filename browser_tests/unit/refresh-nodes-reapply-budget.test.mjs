// panel#1758: a large /object_info can finish just before panel_refresh_nodes observes the
// shared run, then synchronous schema registration begins. The acknowledgement must join
// that production refresh through registration/reapply and return its settled verdict, while
// the single-flight run remains the only owner of the mutation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fetchNodeDefsWithRetry, OBJECT_INFO_RETRY_DELAYS_MS } from "../../web/js/lib/object-info-retry.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { makeRefreshCoalescer, REFRESH_JOIN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
import { fetchWholeObjectInfo, TRANSPORT_OUTCOME } from "../../web/js/lib/object-info-oracle.js";
import { reconcileCompletedDownloads } from "../../web/js/lib/download-refresh.js";
import { describeNodeDefRefresh, NODE_DEF_REFRESH_REASONS } from "../../web/js/lib/node-def-refresh.js";
import {
  collectAllGraphs,
  comboRebuildCovered,
  isStaleAssetCandidate as isStaleAssetCandidateLib,
  reapplyDefsToLiveNodes,
  resolveMissingModelDirectory,
} from "../../web/js/lib/asset-staleness.js";
import { withoutFrontendVirtualTypes } from "../../web/js/lib/frontend-virtual-nodes.js";
import { createVerifiedNodeDefCache } from "../../web/js/lib/verified-node-def-cache.js";

const SRC = readFileSync(fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");

function extractFunction(marker) {
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1, `${marker} not found`);
  const open = SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    const ch = SRC[i];
    if (ch === "/" && SRC[i + 1] === "/") { i = SRC.indexOf("\n", i + 2); if (i < 0) break; continue; }
    if (ch === "/" && SRC[i + 1] === "*") { i = SRC.indexOf("*/", i + 2); if (i < 0) break; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      for (i += 1; i < SRC.length; i += 1) { if (SRC[i] === "\\") { i += 1; continue; } if (SRC[i] === q) break; }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unterminated function: ${marker}`);
}

const NODE_DEFS_NO_ANSWER = Symbol("node-defs-timeout");
const COMBO_OK = Symbol("combo-refreshed");
const COMBO_NO_ANSWER = Symbol("combo-timeout");
const monotonicNow = () => performance.now();
const nodeDefsBudgetLeft = (deadline, share = 1) => Math.max(1, Math.floor((deadline - monotonicNow()) * share));
const cacheSpy = { invalidate: () => {}, replace: () => true, read: async (f) => f() };
const snapshotSpy = { clear: () => {}, record: () => true };
const COMMAND_BUDGET = 2500;
const FETCH_MS = 2080;
const BLOCK_MS = 1500;

function buildRun({
  appValue,
  apiValue,
  reapplyDefsToLiveNodesImpl = () => {},
  withTimeoutImpl = withTimeout,
  runBudgetMs = 9000,
}) {
  const body = extractFunction("async function registerComfyNodeDefs(");
  const names = [
    "app", "api", "recordObjectInfoTypes", "reapplyDefsToLiveNodes", "comboRebuildCovered",
    "describeNodeDefRefresh", "NODE_DEF_REFRESH_REASONS", "fetchNodeDefsWithRetry", "withTimeout", "NODE_DEFS_NO_ANSWER",
    "COMBO_OK", "COMBO_NO_ANSWER", "NODE_DEFS_FETCH_TIMEOUT_MS", "NODE_DEFS_RUN_BUDGET_MS",
    "NODE_DEFS_FETCH_SHARE", "fetchWholeObjectInfo", "nodeDefsBudgetLeft", "monotonicNow",
    "NODE_DEFS_RETRY_DELAYS_MS", "objectInfoCache", "objectInfoSnapshot", "verifiedNodeDefCache", "backendReconnectEpoch",
    "comfyBackendSocketDown",
    "TRANSPORT_OUTCOME",
  ];
  const vals = {
    app: appValue, api: apiValue,
    recordObjectInfoTypes: () => ({}),
    reapplyDefsToLiveNodes: reapplyDefsToLiveNodesImpl,
    comboRebuildCovered,
    describeNodeDefRefresh,
    NODE_DEF_REFRESH_REASONS,
    fetchNodeDefsWithRetry: (g, o) => fetchNodeDefsWithRetry(g, { ...o, sleep: async () => {} }),
    withTimeout: withTimeoutImpl,
    NODE_DEFS_NO_ANSWER, COMBO_OK, COMBO_NO_ANSWER,
    NODE_DEFS_FETCH_TIMEOUT_MS: 10000,
    NODE_DEFS_RUN_BUDGET_MS: runBudgetMs,
    NODE_DEFS_FETCH_SHARE: 2 / 3,
    fetchWholeObjectInfo,
    nodeDefsBudgetLeft, monotonicNow,
    NODE_DEFS_RETRY_DELAYS_MS: OBJECT_INFO_RETRY_DELAYS_MS,
    objectInfoCache: cacheSpy,
    objectInfoSnapshot: snapshotSpy,
    verifiedNodeDefCache: createVerifiedNodeDefCache(),
    backendReconnectEpoch: 7,
    comfyBackendSocketDown: false,
    TRANSPORT_OUTCOME,
  };
  const factory = new Function(...names, `
    const boundedGetNodeDefs = async (ms = NODE_DEFS_FETCH_TIMEOUT_MS) => {
      if (typeof api?.getNodeDefs !== "function") return null;
      const settled = await withTimeout(
        Promise.resolve().then(() => api.getNodeDefs()).then((value) => ({ value }), (err) => ({ err })),
        ms, () => NODE_DEFS_NO_ANSWER,
      );
      if (settled === NODE_DEFS_NO_ANSWER) return NODE_DEFS_NO_ANSWER;
      if ("err" in settled) throw settled.err;
      return settled.value;
    };
    let nodeDefsRefreshConfirmed = false;
    ${body}
    return { registerComfyNodeDefs, getConfirmed: () => nodeDefsRefreshConfirmed };`);
  return factory(...names.map((n) => vals[n]));
}

const refreshNodesMatch = SRC.match(/\n {2}async refresh_nodes\(\) \{[\s\S]*?\n {2}\},/);
assert.ok(refreshNodesMatch, "refresh_nodes not found");

function buildRefreshNodes({ refreshComfyNodeDefs, commandBudget = COMMAND_BUDGET }) {
  const deps = {
    refreshComfyNodeDefs,
    REFRESH_JOIN_ABANDONED,
    NODE_DEF_REFRESH_REASONS,
    REFRESH_NODES_COMMAND_BUDGET_MS: commandBudget,
    REFRESH_NODES_RUN_BUDGET_MS: Math.ceil(commandBudget / (2 / 3)),
  };
  const names = Object.keys(deps);
  const factory = new Function(...names, `const executors = {${refreshNodesMatch[0]}}; return executors.refresh_nodes;`);
  return factory(...names.map((n) => deps[n]));
}

// The late-mutation regression drives the same production collector that consumes the shared
// trust bit. Keeping this extraction beside the real register/coalescer harness prevents a
// helper-only assertion from missing a stale combo read at the consumer boundary.
const STALE_ASSET_BODY = extractFunction("function isStaleAssetCandidate(c, trustComboOverride) {");
const COLLECTOR_BODY = extractFunction("function collectMissingAssets(trustComboOverride) {");
function buildProductionCollector({ stores, rootGraph }) {
  const factory = new Function(
    "getPiniaStore",
    "isStaleAssetCandidateLib",
    "resolveMissingModelDirectory",
    "withoutFrontendVirtualTypes",
    "collectAllGraphs",
    "getGraphCtx",
    `let nodeDefsRefreshConfirmed = false;
     ${STALE_ASSET_BODY}
     ${COLLECTOR_BODY}
     return {
       collectMissingAssets,
       setRefreshConfirmed: (value) => { nodeDefsRefreshConfirmed = value === true; },
     };`,
  );
  return factory(
    (name) => stores[name],
    isStaleAssetCandidateLib,
    resolveMissingModelDirectory,
    withoutFrontendVirtualTypes,
    collectAllGraphs,
    () => ({ rootGraph }),
  );
}

function busyBlock(ms) {
  const end = performance.now() + ms;
  // eslint-disable-next-line no-empty
  while (performance.now() < end) {}
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const ON_DOWNLOADS_BODY = extractFunction("onDownloads(list)");

function buildOnDownloads(refreshComfyNodeDefs) {
  const factory = new Function(
    "reconcileCompletedDownloads",
    "refreshComfyNodeDefs",
    "renderDownloads",
    `let seenDoneDownloads = new Set();
     const executors = {${ON_DOWNLOADS_BODY}};
     return executors.onDownloads;`,
  );
  return factory(reconcileCompletedDownloads, refreshComfyNodeDefs, () => {});
}

async function withWatchdog(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("#1758: refresh_nodes joins through production registration and reapply", async () => {
  // Scaled from the report: the /object_info response lands before the synchronous
  // registration/reapply phase, which blocks the event loop. A joined acknowledgement must
  // still return the completed refresh rather than converting that handoff into
  // refresh_still_running.
  const TYPES = 5635;
  const defs = {};
  for (let i = 0; i < TYPES; i += 1) defs[`Type${i}`] = { input: {}, output: [] };

  let fetchCalls = 0;
  let registrationCalls = 0;
  let activeRegistrations = 0;
  let maxConcurrentRegistrations = 0;
  const appValue = {
    graph: null,
    registerNodesFromDefs: async () => {
      registrationCalls += 1;
      activeRegistrations += 1;
      maxConcurrentRegistrations = Math.max(maxConcurrentRegistrations, activeRegistrations);
      busyBlock(BLOCK_MS);
      activeRegistrations -= 1;
    },
    refreshComboInNodes: async () => {},
  };
  const apiValue = {
    getNodeDefs: () => {
      const delay = fetchCalls++ === 0 ? FETCH_MS : 0;
      return new Promise((resolve) => setTimeout(() => resolve(defs), delay));
    },
  };

  let inFlight = null;
  const { registerComfyNodeDefs: run } = buildRun({ appValue, apiValue });
  const coalescer = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => { inFlight = p; },
    runRegister: run,
    withTimeout,
  });
  const refresh_nodes = buildRefreshNodes({ refreshComfyNodeDefs: coalescer });

  const startedAt = performance.now();
  const reply = await refresh_nodes();
  const elapsed = performance.now() - startedAt;

  assert.ok(
    elapsed >= BLOCK_MS,
    `the acknowledgement must observe production local work before replying; elapsed ${Math.round(elapsed)}ms`,
  );
  assert.deepEqual(
    { ok: reply.ok, refreshed: reply.refreshed },
    { ok: true, refreshed: true },
  );
  assert.equal(
    registrationCalls,
    1,
    "the joined acknowledgement must wait for registerNodesFromDefs/reapply to finish",
  );
  assert.equal(maxConcurrentRegistrations, 1, "registration passes must remain single-flight");
  assert.equal(inFlight, null, "the joined production refresh returns the slot to idle");
});

test("#1695: late combo work is fenced before reconnect successor and collector trust", async () => {
  const firstCombo = deferred();
  const secondCombo = deferred();
  const firstComboStarted = deferred();
  const secondComboStarted = deferred();
  const comboWidget = {
    name: "model",
    value: "fresh.safetensors",
    options: { values: [] },
  };
  let comboRuns = 0;
  let valuesAtSecondStart = null;
  const appValue = {
    graph: null,
    registerNodesFromDefs: async () => {},
    refreshComboInNodes: () => {
      comboRuns += 1;
      if (comboRuns === 1) {
        firstComboStarted.resolve();
        return firstCombo.promise.then(() => {
          comboWidget.options.values = ["late-old.safetensors"];
        });
      }
      valuesAtSecondStart = [...comboWidget.options.values];
      secondComboStarted.resolve();
      return secondCombo.promise.then(() => {
        comboWidget.options.values = ["fresh.safetensors"];
      });
    },
  };
  const apiValue = { getNodeDefs: async () => ({ SomeNode: {} }) };
  // The first timeout call is the bounded /object_info read; the second is the combo
  // observation. Make only the latter time out immediately so the real production function
  // registers a deferred completion while its frontend promise remains live.
  let boundedCalls = 0;
  const productionTimeout = (promise, ms, onTimeout) => {
    boundedCalls += 1;
    return boundedCalls % 2 === 0 ? Promise.resolve(onTimeout()) : withTimeout(promise, ms, onTimeout);
  };
  const built = buildRun({
    appValue,
    apiValue,
    withTimeoutImpl: productionTimeout,
    runBudgetMs: 100,
  });
  let inFlight = null;
  const coalescer = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => { inFlight = p; },
    runRegister: built.registerComfyNodeDefs,
    withTimeout,
  });
  const refresh_nodes = buildRefreshNodes({ refreshComfyNodeDefs: coalescer, commandBudget: 25 });
  const candidate = {
    nodeId: 7,
    name: "fresh.safetensors",
    widgetName: "model",
    directory: "checkpoints",
    isMissing: true,
  };
  const rootGraph = {
    _nodes: [{ id: 7, widgets: [comboWidget] }],
    getNodeById: (id) => (id === 7 || String(id) === "7" ? { id: 7, widgets: [comboWidget] } : null),
  };
  const collector = buildProductionCollector({
    stores: {
      missingModel: { missingModelCandidates: [candidate] },
      missingMedia: { missingMediaCandidates: [] },
      missingNodesError: { hasMissingNodes: false, missingNodeCount: 0, missingNodesError: [] },
    },
    rootGraph,
  });

  const firstReplyPromise = refresh_nodes();
  await firstComboStarted.promise;
  const reconnect = coalescer(undefined, { force: true });
  const firstReply = await firstReplyPromise;
  assert.equal(firstReply.reason, "refresh_still_running", "the command reports status, not false success");
  assert.equal(comboRuns, 1, "the first combo operation owns the refresh");
  assert.equal(inFlight !== null, true, "the late combo keeps the coalescer slot occupied");
  collector.setRefreshConfirmed(built.getConfirmed());
  assert.equal(collector.collectMissingAssets().models.length, 1, "pending combo trust stays fail-closed");

  const retry = refresh_nodes();
  firstCombo.resolve();
  await secondComboStarted.promise;
  assert.deepEqual(
    valuesAtSecondStart,
    ["late-old.safetensors"],
    "the successor starts only after the predecessor's late mutation settles",
  );
  assert.equal(comboRuns, 2, "reconnect coalesces to one successor, not an overlapping retry");
  collector.setRefreshConfirmed(built.getConfirmed());
  assert.equal(collector.collectMissingAssets().models.length, 1, "successor pending state stays untrusted");

  secondCombo.resolve();
  const retryReply = await retry;
  await reconnect;
  assert.equal(retryReply.refreshed, true, "a retry after settlement receives the stable completion verdict");
  assert.equal(built.getConfirmed(), true, "shared combo trust opens only after the successor settles");
  assert.deepEqual(comboWidget.options.values, ["fresh.safetensors"]);
  collector.setRefreshConfirmed(built.getConfirmed());
  assert.equal(collector.collectMissingAssets().models.length, 0, "collectMissingAssets sees only the settled successor");
  assert.equal(inFlight, null, "the fenced lifecycle returns to idle");
});

test("#1736: download completion upgrades a queued no-skip refresh and recovers", async () => {
  const firstFetch = deferred();
  const recoveryFetch = deferred();
  const defs = {
    TestLoader: {
      input: { required: { model: [["fresh.safetensors"], {}] } },
    },
  };
  const comboWidget = { name: "model", options: { values: ["stale.safetensors"] } };
  const rootGraph = {
    _nodes: [{ type: "TestLoader", widgets: [comboWidget], constructor: {} }],
  };
  let fetches = 0;
  let comboCalls = 0;
  let backgroundPhase = true;
  const appValue = {
    graph: rootGraph,
    registerNodesFromDefs: async () => {},
    refreshComboInNodes: () => {
      comboCalls += 1;
      if (comboCalls === 1) return Promise.resolve();
      return backgroundPhase ? new Promise(() => {}) : Promise.resolve();
    },
  };
  const apiValue = {
    getNodeDefs: async () => {
      fetches += 1;
      if (fetches === 1) await firstFetch.promise;
      if (fetches === 3) await recoveryFetch.promise;
      return defs;
    },
  };
  const built = buildRun({
    appValue,
    apiValue,
    reapplyDefsToLiveNodesImpl: reapplyDefsToLiveNodes,
    runBudgetMs: 100,
  });
  let inFlight = null;
  const refreshComfyNodeDefs = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (value) => { inFlight = value; },
    runRegister: built.registerComfyNodeDefs,
    withTimeout,
  });
  const refresh_nodes = buildRefreshNodes({ refreshComfyNodeDefs, commandBudget: 150 });

  const current = refreshComfyNodeDefs(undefined, { force: true });
  const reconnect = refreshComfyNodeDefs(undefined, { force: true });
  const onDownloads = buildOnDownloads(refreshComfyNodeDefs);
  onDownloads([{ id: "d1", status: "downloading" }]);
  onDownloads([{ id: "d1", status: "done" }]);
  const acknowledgement = refresh_nodes();
  firstFetch.resolve();

  const reply = await withWatchdog(acknowledgement, "panel_refresh_nodes stayed stuck");
  await withWatchdog(Promise.all([current, reconnect]), "concurrent refresh completion stayed stuck");
  backgroundPhase = false;
  assert.deepEqual(reply, {
    ok: true,
    refreshed: true,
    combo_refresh_confirmed: false,
    combo_refresh_note:
      "Node definitions WERE re-registered from a fresh /object_info, and the panel rebuilt every " +
      "combo widget's option list on the live graph from that same payload. The frontend's duplicate " +
      "refreshComboInNodes() call was skipped because those lists are already current.",
  });
  assert.equal(comboCalls, 1, "download completion upgrades the queued run before its duplicate frontend refresh");
  assert.deepEqual(comboWidget.options.values, ["fresh.safetensors"]);
  assert.equal(inFlight, null, "the concurrent completion releases the shared slot");

  const recoveryRun = refreshComfyNodeDefs(undefined, { force: true });
  const recoveredPromise = refresh_nodes();
  recoveryFetch.resolve();
  const recovered = await withWatchdog(recoveredPromise, "refresh_nodes did not recover after completion");
  await withWatchdog(recoveryRun, "the recovery refresh did not complete");
  assert.equal(recovered.ok, true);
  assert.equal(recovered.refreshed, true);
  assert.equal(comboCalls, 2, "recovery may use the normal frontend confirmation path");
  assert.equal(inFlight, null, "the recovery run also returns the slot to idle");
});

test("#1562: a later bounded caller upgrades an already-queued trailing run", async () => {
  const hold = deferred();
  let runNumber = 0;
  let localWorkStarted = 0;
  let inFlight = null;
  const coalescer = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => { inFlight = p; },
    runRegister: async (_defs, _opts, control) => {
      const number = ++runNumber;
      if (number === 1) await hold.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await control.beforeLocalWork?.();
      if (number === 2) localWorkStarted += 1;
      busyBlock(100);
    },
    withTimeout,
  });

  const first = coalescer(undefined, { force: true });
  // The unbounded download/reconnect-style force caller queues the shared
  // trailing run without asking it to yield.
  const unboundedTrailing = coalescer(undefined, { force: true });
  // refresh_nodes arrives while that trailing run is still queued and upgrades
  // it before its fetch/local-work handoff begins.
  const bounded = coalescer(undefined, {
    force: true,
    joinMs: 1000,
    abandonBeforeLocalWork: true,
  });

  hold.resolve();
  const outcome = await bounded;
  assert.equal(outcome, REFRESH_JOIN_ABANDONED);
  assert.equal(localWorkStarted, 0, "the bounded caller must return before trailing local work");

  await first;
  await unboundedTrailing;
  assert.equal(localWorkStarted, 1, "the upgraded trailing run still completes its registration");
});
