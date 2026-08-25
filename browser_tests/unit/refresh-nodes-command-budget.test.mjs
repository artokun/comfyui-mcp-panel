// panel#1680 — `panel_refresh_nodes` must observe an already-running node-definition refresh
// instead of queueing a second forced run behind it. The command is an acknowledgement
// surface: it joins the existing single-flight promise up to its command budget, returns the
// completed freshness verdict when that promise settles, and reports a bounded retryable
// status when it does not. When no run exists, it still starts its own forced refresh.
//
// THE HARNESS RUNS THE SHIPPED `refresh_nodes` BODY, extracted from the panel source and
// given injected collaborators, over the REAL coalescer with a REAL in-flight run — the same
// technique as add-node-command-budget.test.mjs, and for the same reason. A helper-level test
// cannot reach the whole defect: the coalescer's opt-in join and the existing budget are
// individually testable, but only an assertion on THAT CALL SITE can prove that
// `refresh_nodes` both opts into joining and preserves its idle forced-refresh behavior.
// Every production-path case below therefore drives the extracted executor rather than
// relying on a helper-only test.
import test from "node:test";
import assert from "node:assert/strict";

import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { makeRefreshCoalescer } from "../../web/js/lib/refresh-coalesce.js";
import { NODE_DEF_REFRESH_REASONS } from "../../web/js/lib/node-def-refresh.js";
import {
  collectAllGraphs,
  isStaleAssetCandidate as isStaleAssetCandidateLib,
  resolveMissingModelDirectory,
} from "../../web/js/lib/asset-staleness.js";
import { withoutFrontendVirtualTypes } from "../../web/js/lib/frontend-virtual-nodes.js";
import { refreshMissingAssetTrust } from "../../web/js/lib/missing-asset-refresh.js";
import {
  PANEL_SRC,
  ADD_NODE_COMMAND_BUDGET_MS,
  REFRESH_NODES_COMMAND_BUDGET_MS,
  REFRESH_NODES_EXECUTOR_DEPS,
} from "./_panel-constants.mjs";

const refreshNodesMatch = PANEL_SRC.match(/\n {2}async refresh_nodes\(\) \{[\s\S]*?\n {2}\},/);
assert.ok(refreshNodesMatch, "could not locate refresh_nodes in panel source");

function extractPanelFn(sig) {
  const start = PANEL_SRC.indexOf(sig);
  assert.notEqual(start, -1, `${sig} not found in the panel source`);
  const open = PANEL_SRC.indexOf(") {", start) + 1;
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

function extractPanelEvent(event) {
  const start = PANEL_SRC.indexOf(`api.addEventListener("${event}"`);
  assert.notEqual(start, -1, `${event} listener not found in the panel source`);
  const next = PANEL_SRC.indexOf("api.addEventListener(", start + 1);
  return PANEL_SRC.slice(start, next === -1 ? PANEL_SRC.length : next);
}

// Execute the shipped local wrapper and collector together. This keeps the regression at
// the production consumer boundary: a refresh verdict changes the trust supplied to the
// same `collectMissingAssets` body graph_get_errors and validationBanner use.
const STALE_ASSET_BODY = extractPanelFn("function isStaleAssetCandidate(c, trustComboOverride) {");
const COLLECTOR_BODY = extractPanelFn("function collectMissingAssets(trustComboOverride) {");
const WITH_REFRESH_TIMEOUT_BODY = extractPanelFn("function withRefreshTimeout(promise, timeoutMs) {");
const productionWithRefreshTimeout = new Function(
  `${WITH_REFRESH_TIMEOUT_BODY}; return withRefreshTimeout;`,
)();

function makeProductionMissingAssetCollector({ stores, rootGraph }) {
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

/** A tiny deferred so a test can hold the in-flight refresh open until it chooses. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Build the SHIPPED `refresh_nodes` with the REAL coalescer behind it.
 *
 * `budgetMs` is injected small so these tests run in milliseconds rather than waiting out the
 * shipped 25 s. Same code, same arithmetic, shorter deadline — the shipped NUMBER is pinned
 * separately, against the relay window, at the bottom of this file.
 *
 * `holdFirstRun` is a promise the FIRST run waits on before it registers anything. That run
 * is the one this panel starts for itself — a reconnect, a finished download, or the
 * missing-asset check that an upload triggers — and it is holding the coalescer's slot when
 * the tool call arrives. Held open, it is the reported scenario exactly.
 */
function realRefreshNodes({
  holdFirstRun = null,
  // Whether the held run is started BEFORE the tool call (someone else's, holding the slot)
  // or left for the tool call to start itself (nothing in flight — the uncontended case).
  startInFlight = true,
  budgetMs = 150,
  verdicts = [{ refreshed: true, reason: "refreshed" }],
  runHook = null,
} = {}) {
  let inFlight = null;
  const runs = [];
  const refreshComfyNodeDefs = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    runRegister: async (_defs, _runOpts, control) => {
      const index = runs.length;
      runs.push(index);
      if (index === 0 && holdFirstRun) await holdFirstRun;
      if (runHook) return runHook({ index, control });
      return verdicts[Math.min(index, verdicts.length - 1)];
    },
    withTimeout,
  });
  // A refresh THIS PANEL started — not the tool call — already holding the slot.
  const inFlightStarted =
    holdFirstRun && startInFlight ? refreshComfyNodeDefs(undefined, { force: true }) : null;

  const deps = {
    refreshComfyNodeDefs,
    // Every other binding from the one place that holds them, so this harness picks up a
    // new one automatically — then the budget, injected small, LAST so it wins.
    ...REFRESH_NODES_EXECUTOR_DEPS,
    REFRESH_NODES_COMMAND_BUDGET_MS: budgetMs,
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const executors = {${refreshNodesMatch[0]}};
     return executors.refresh_nodes;`,
  );
  return {
    refresh_nodes: factory(...names.map((n) => deps[n])),
    refreshComfyNodeDefs,
    getInFlight: () => inFlight,
    runs,
    inFlightStarted,
  };
}

/**
 * Await `run()` but FAIL LOUDLY rather than hang if the budget never reaches the coalescer.
 *
 * Without the fix this call resolves only once the held run releases, which is the whole
 * defect — and a test that simply awaited it would sit there being slow instead of red. The
 * elapsed time is returned so the caller can assert the bound was the thing that ended it.
 */
async function withWatchdog(run, ms, what) {
  let timer;
  const startedAt = Date.now();
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} — waited ${ms}ms`)), ms);
  });
  try {
    const value = await Promise.race([run(), watchdog]);
    return { value, elapsed: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRunCount(built, count) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (built.runs.length >= count) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`refresh did not start run ${count}`);
}

// ---------------------------------------------------------------------------
// 1. The reported shape: a run already in flight, and the tool call subscribed to it.
// ---------------------------------------------------------------------------

test("#1695: reconnect queues a successor and refresh_nodes refuses while that successor runs", async () => {
  const reconnected = extractPanelEvent("reconnected");
  assert.match(
    reconnected,
    /refreshComfyNodeDefs\(undefined,\s*\{\s*force:\s*true\s*\}\)\.catch/,
    "the production reconnect path must force a trailing refresh",
  );

  const staleGate = deferred();
  const successorGate = deferred();
  const built = realRefreshNodes({
    holdFirstRun: staleGate.promise,
    budgetMs: 25,
    runHook: async ({ index }) => {
      if (index === 1) await successorGate.promise;
      return { refreshed: true, reason: "refreshed" };
    },
  });

  // This is the exact coalescer call the shipped reconnected listener makes. It must queue
  // one post-reconnect run behind the stale pre-restart promise.
  const reconnectRefresh = built.refreshComfyNodeDefs(undefined, { force: true });
  staleGate.resolve();
  await waitForRunCount(built, 2);

  const { value } = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "refresh_nodes did not return while the post-reconnect successor was held",
  );
  assert.equal(value.ok, true);
  assert.equal(value.refreshed, false);
  assert.equal(value.reason, NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING);
  assert.notEqual(built.getInFlight(), null, "the successor remains the live refresh promise");

  successorGate.resolve();
  await reconnectRefresh;
  const retry = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "refresh_nodes retry did not observe the settled post-reconnect refresh",
  );
  assert.deepEqual(retry.value, { ok: true, refreshed: true });
  assert.equal(built.runs.length, 3, "the retry starts only after the successor has settled");
  await built.inFlightStarted?.catch(() => {});
});

test("#1695: refresh_nodes follows multiple forced successors before reporting success", async () => {
  const run0Gate = deferred();
  const run1Gate = deferred();
  const run2Gate = deferred();
  let lastCompletedRun = -1;
  const built = realRefreshNodes({
    holdFirstRun: run0Gate.promise,
    budgetMs: 150,
    runHook: async ({ index }) => {
      if (index === 1) await run1Gate.promise;
      if (index === 2) await run2Gate.promise;
      lastCompletedRun = index;
      return { refreshed: true, reason: "refreshed" };
    },
  });

  // Reproduce the restart lifecycle exactly: run1 is queued behind run0, the acknowledgement
  // starts while that successor is pending, and run2 is queued after run1 becomes current.
  const run1 = built.refreshComfyNodeDefs(undefined, { force: true });
  const acknowledgement = built.refresh_nodes();
  run0Gate.resolve();
  await waitForRunCount(built, 2);
  const run2 = built.refreshComfyNodeDefs(undefined, { force: true });
  run1Gate.resolve();
  await waitForRunCount(built, 3);

  const first = await withWatchdog(
    () => acknowledgement,
    1500,
    "refresh_nodes reported neither the chained in-flight status nor success",
  );
  assert.equal(first.value.reason, NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING);
  assert.equal(lastCompletedRun, 1, "run2 is still held when the bounded acknowledgement returns");
  assert.notEqual(built.getInFlight(), null, "the second forced successor still owns the slot");

  // The prescribed retry joins run2 while it is still live. Releasing run2 must complete that
  // same chain, rather than making the retry falsely refuse or start a fourth run.
  const retry = built.refresh_nodes();
  run2Gate.resolve();
  const second = await withWatchdog(
    () => retry,
    1500,
    "refresh_nodes retry did not observe the settled second successor",
  );
  assert.deepEqual(second.value, { ok: true, refreshed: true });
  assert.equal(lastCompletedRun, 2);
  assert.equal(built.runs.length, 3, "the retry completes the existing successor chain");
  await run1;
  await run2;
  await built.inFlightStarted?.catch(() => {});
});

test("#1680: refresh_nodes returns the completed verdict from an already-running refresh", async () => {
  const gate = deferred();
  const built = realRefreshNodes({ holdFirstRun: gate.promise, budgetMs: 500 });
  const pending = built.refresh_nodes();

  assert.equal(built.runs.length, 1, "the existing refresh owns the single-flight slot");
  gate.resolve();

  const { value } = await withWatchdog(
    () => pending,
    1500,
    "refresh_nodes did not return after the already-running refresh settled",
  );
  assert.deepEqual(value, { ok: true, refreshed: true });
  assert.equal(built.runs.length, 1, "joining the completion must not queue a trailing refresh");
  await built.inFlightStarted?.catch(() => {});
});

test("#1682: refresh_nodes waits through a queued freshness run before the missing-asset scan", async () => {
  const gate = deferred();
  const candidate = {
    nodeId: 7,
    name: "taeh3.safetensors",
    widgetName: "model",
    directory: "checkpoints",
    isMissing: true,
  };
  const node = {
    id: 7,
    widgets: [{ name: "model", value: "taeh3.safetensors", options: { values: [] } }],
  };
  const rootGraph = {
    _nodes: [node],
    getNodeById: (id) => node.id === id || String(node.id) === String(id) ? node : null,
  };
  const productionCollector = makeProductionMissingAssetCollector({
    stores: {
      missingModel: { missingModelCandidates: [candidate] },
      missingMedia: { missingMediaCandidates: [] },
      missingNodesError: { hasMissingNodes: false, missingNodeCount: 0, missingNodesError: [] },
    },
    rootGraph,
  });
  const built = realRefreshNodes({
    holdFirstRun: gate.promise,
    budgetMs: 500,
    runHook: async ({ index }) => {
      if (index === 1) node.widgets[0].options.values = ["taeh3.safetensors"];
      return { refreshed: index === 1, reason: index === 1 ? "refreshed" : "object_info_fetch_failed" };
    },
  });

  // The first run represents a refresh already started by a background missing-asset check.
  // The second is its forced trailing fetch, which is the one that can observe the file copied
  // into the configured model directory after the first /object_info request began.
  const trailing = built.refreshComfyNodeDefs(undefined, { force: true });
  const reply = built.refresh_nodes();
  gate.resolve();

  const { value } = await withWatchdog(
    () => reply,
    1500,
    "refresh_nodes did not observe the queued freshness run",
  );
  assert.equal(value.refreshed, true, "the acknowledgement reports the run that saw the new file");
  assert.equal(built.runs.length, 2, "the background refresh and its one trailing freshness run completed");
  productionCollector.setRefreshConfirmed(value.refreshed);
  const assets = productionCollector.collectMissingAssets();
  assert.equal(
    assets.models.length,
    0,
    "the shipped collectMissingAssets path clears the candidate from the refreshed combo",
  );
  assert.equal(assets.any, false, "the shipped collector reports no stale missing-asset error");
  await Promise.all([built.inFlightStarted, trailing]);
});

test("#1682: graph_get_errors refresh seam scans with the completed trailing combo", async () => {
  const gate = deferred();
  const node = {
    id: 7,
    widgets: [{ name: "model", value: "taeh3.safetensors", options: { values: [] } }],
  };
  const rootGraph = {
    _nodes: [node],
    getNodeById: (id) => node.id === id || String(node.id) === String(id) ? node : null,
  };
  const candidate = {
    nodeId: 7,
    name: "taeh3.safetensors",
    widgetName: "model",
    directory: "checkpoints",
    isMissing: true,
  };
  const productionCollector = makeProductionMissingAssetCollector({
    stores: {
      missingModel: { missingModelCandidates: [candidate] },
      missingMedia: { missingMediaCandidates: [] },
      missingNodesError: { hasMissingNodes: false, missingNodeCount: 0, missingNodesError: [] },
    },
    rootGraph,
  });
  const built = realRefreshNodes({
    holdFirstRun: gate.promise,
    budgetMs: 500,
    runHook: async ({ index }) => {
      if (index === 1) node.widgets[0].options.values = ["taeh3.safetensors"];
      return { refreshed: index === 1, reason: index === 1 ? "refreshed" : "object_info_fetch_failed" };
    },
  });

  // This is the exact refresh/scan boundary used by graph_get_errors. The first refresh
  // started before the scan cannot see the file; the forced call queues the one that can.
  const trustPromise = refreshMissingAssetTrust({
    refreshBudgetMs: 500,
    refreshComfyNodeDefs: built.refreshComfyNodeDefs,
    withRefreshTimeout: productionWithRefreshTimeout,
    getRefreshInFlight: built.getInFlight,
  });
  gate.resolve();

  const trusted = await withWatchdog(
    () => trustPromise,
    1500,
    "graph_get_errors refresh seam did not complete the trailing refresh",
  );
  assert.equal(trusted.value, true, "only the refresh that saw the new combo may grant trust");
  productionCollector.setRefreshConfirmed(trusted.value);
  const assets = productionCollector.collectMissingAssets();
  assert.equal(assets.models.length, 0, "graph_get_errors' shipped collector clears the stale error");
  assert.equal(assets.any, false, "the production scan is clean after the trailing refresh");
  assert.equal(built.runs.length, 2, "the graph error refresh used one trailing run");
  await built.inFlightStarted;
});

test("#1733: a fresh combo clears an API-uploaded root input, while a true miss remains", async () => {
  const node = {
    id: 41,
    widgets: [{ name: "image", value: "eyes_anchor_src.png", options: { values: [] } }],
  };
  const rootGraph = {
    _nodes: [node],
    getNodeById: (id) => node.id === id || String(node.id) === String(id) ? node : null,
  };
  const candidate = {
    nodeId: 41,
    name: "eyes_anchor_src.png",
    widgetName: "image",
    mediaType: "image",
    isMissing: true,
  };
  const productionCollector = makeProductionMissingAssetCollector({
    stores: {
      missingModel: { missingModelCandidates: [] },
      missingMedia: { missingMediaCandidates: [candidate] },
      missingNodesError: { hasMissingNodes: false, missingNodeCount: 0, missingNodesError: [] },
    },
    rootGraph,
  });
  assert.equal(productionCollector.collectMissingAssets().media.length, 1, "the page-load snapshot starts as missing");

  const built = realRefreshNodes({
    budgetMs: 500,
    runHook: async () => {
      // This is the fresh /object_info + combo-rebuild result after the API upload.
      node.widgets[0].options.values = [candidate.name];
      return { refreshed: true, reason: "refreshed" };
    },
  });
  const trusted = await refreshMissingAssetTrust({
    refreshBudgetMs: 500,
    refreshComfyNodeDefs: built.refreshComfyNodeDefs,
    withRefreshTimeout: productionWithRefreshTimeout,
    getRefreshInFlight: built.getInFlight,
  });
  assert.equal(trusted, true, "the banner may use only a completed authoritative refresh");
  productionCollector.setRefreshConfirmed(trusted);
  assert.equal(
    productionCollector.collectMissingAssets().media.length,
    0,
    "the refreshed root-level API-uploaded input is no longer falsely missing",
  );

  // A successful refresh must not become blanket amnesty: if the value is still
  // absent from the fresh combo, the original missing-media warning survives.
  node.widgets[0].options.values = [];
  assert.equal(productionCollector.collectMissingAssets().media.length, 1, "a true missing input remains reported");
});

test("#1733: validationBanner collects only after its awaited freshness verdict", () => {
  const body = extractPanelFn("async function validationBanner() {");
  const refreshAt = body.indexOf("await refreshMissingAssetTrust({");
  const collectAt = body.indexOf("const missing = collectMissingAssets(comboTrustedForQuery);");
  const refreshFenceAt = body.indexOf("let postRefreshRootGraph = null;");
  assert.ok(refreshAt >= 0, "validationBanner must await the authoritative missing-asset refresh");
  assert.ok(collectAt > refreshAt, "the load-time asset snapshot must be collected after refresh settles");
  assert.ok(refreshFenceAt > refreshAt && refreshFenceAt < collectAt, "the banner must fence a tab switch before collecting");
  assert.match(body, /getRefreshInFlight: \(\) => nodeDefRefreshInFlight/);
  assert.match(body, /comboTrustedForQuery = false/);
});

for (const [label, runHook, release] of [
  [
    "timeout",
    async ({ index }) => {
      if (index === 1) await release.promise;
      return { refreshed: index === 0, reason: index === 0 ? "refreshed" : "object_info_fetch_failed" };
    },
    deferred(),
  ],
  [
    "rejection",
    async ({ index }) => {
      if (index === 1) throw new Error("trailing refresh failed");
      return { refreshed: index === 0, reason: index === 0 ? "refreshed" : "object_info_fetch_failed" };
    },
    null,
  ],
]) {
  test(`#1682: graph_get_errors keeps a trailing ${label} fail-closed`, async () => {
    const gate = deferred();
    const node = {
      id: 7,
      widgets: [{ name: "model", value: "taeh3.safetensors", options: { values: [] } }],
    };
    const rootGraph = {
      _nodes: [node],
      getNodeById: (id) => node.id === id || String(node.id) === String(id) ? node : null,
    };
    const candidate = {
      nodeId: 7,
      name: "taeh3.safetensors",
      widgetName: "model",
      directory: "checkpoints",
      isMissing: true,
    };
    const productionCollector = makeProductionMissingAssetCollector({
      stores: {
        missingModel: { missingModelCandidates: [candidate] },
        missingMedia: { missingMediaCandidates: [] },
        missingNodesError: { hasMissingNodes: false, missingNodeCount: 0, missingNodesError: [] },
      },
      rootGraph,
    });
    const built = realRefreshNodes({ holdFirstRun: gate.promise, budgetMs: 500, runHook });
    const trustPromise = refreshMissingAssetTrust({
      refreshBudgetMs: 25,
      refreshComfyNodeDefs: built.refreshComfyNodeDefs,
      withRefreshTimeout: productionWithRefreshTimeout,
      getRefreshInFlight: built.getInFlight,
    });
    gate.resolve();

    const trusted = await withWatchdog(
      () => trustPromise,
      1500,
      `graph_get_errors trailing ${label} case did not return`,
    );
    assert.equal(trusted.value, false, `a trailing ${label} must not grant combo trust`);
    productionCollector.setRefreshConfirmed(trusted.value);
    const assets = productionCollector.collectMissingAssets();
    assert.equal(assets.models.length, 1, `a trailing ${label} keeps the raw missing candidate`);
    assert.equal(assets.any, true, `a trailing ${label} remains visible to graph_get_errors`);

    release?.resolve();
    await built.inFlightStarted?.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(built.getInFlight(), null, `the trailing ${label} eventually releases its slot`);
  });
}

test("#1680: refresh_nodes replies at its budget instead of waiting for the joined run", async () => {
  const gate = deferred();
  const built = realRefreshNodes({ holdFirstRun: gate.promise, budgetMs: 150 });

  const { value, elapsed } = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "refresh_nodes never replied: the command budget did not reach the in-flight completion",
  );

  assert.equal(value.ok, true, "nothing failed, so the command still succeeds");
  assert.equal(value.refreshed, false, "…but it must not claim a refresh it never confirmed");
  assert.ok(
    elapsed < 1000,
    `replied in ${elapsed}ms — the reply must be composed at the bound, not after the run`,
  );

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(built.runs.length, 1, "a timed-out join must not create a trailing refresh");
});

test("#1758: a joined acknowledgement waits through synchronous registration", async () => {
  const gate = deferred();
  const localWorkMs = 100;
  const built = realRefreshNodes({
    holdFirstRun: gate.promise,
    budgetMs: 500,
    runHook: async ({ control }) => {
      const handoff = control.beforeLocalWork?.();
      if (handoff) await handoff;
      const end = Date.now() + localWorkMs;
      while (Date.now() < end) {}
      return { refreshed: true, reason: "refreshed" };
    },
  });

  const pending = built.refresh_nodes();
  // Let the acknowledgement arm its one-millisecond join timer before releasing the
  // external refresh toward the synchronous section that used to block that timer.
  await Promise.resolve();
  gate.resolve();

  const { value, elapsed } = await withWatchdog(
    () => pending,
    500,
    "refresh_nodes did not join through the shared refresh's synchronous work",
  );
  assert.deepEqual(value, { ok: true, refreshed: true });
  assert.ok(
    elapsed >= localWorkMs,
    `replied in ${elapsed}ms instead of joining through ${localWorkMs}ms of local work`,
  );

  await built.inFlightStarted?.catch(() => {});
});

test("#1680: a settled joined non-fresh verdict is forwarded truthfully", async () => {
  const gate = deferred();
  const verdict = {
    refreshed: false,
    reason: NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED,
    remedy: "check that ComfyUI is running",
  };
  const built = realRefreshNodes({ holdFirstRun: gate.promise, budgetMs: 500, verdicts: [verdict] });
  const pending = built.refresh_nodes();

  gate.resolve();
  const { value } = await withWatchdog(
    () => pending,
    1500,
    "refresh_nodes did not return the joined non-fresh verdict",
  );
  assert.equal(value.refreshed, false);
  assert.equal(value.reason, verdict.reason);
  assert.equal(value.remedy, verdict.remedy);
  await built.inFlightStarted?.catch(() => {});
});

test("#1680: the bounded status names the still-running refresh and its remedy", async () => {
  const gate = deferred();
  const built = realRefreshNodes({ holdFirstRun: gate.promise, budgetMs: 150 });

  const { value } = await withWatchdog(() => built.refresh_nodes(), 1500, "refresh_nodes never replied");

  // The STRUCTURED field is the load-bearing part. A caller must never have to parse prose to
  // decide it may re-issue a command, and "unknown" — what the generic branch produces for a
  // Symbol — would make a refresh that is still running indistinguishable from a fetch that
  // threw, which is the one distinction a caller deciding whether to retry actually needs.
  // THE LITERAL, not only the map lookup. The panel and this file read the token from the
  // SAME frozen map, so deleting the entry degrades both to `undefined` together and
  // `assert.equal(undefined, undefined)` passes — while the shipped reply carries
  // `reason: undefined`, which `JSON.stringify` DROPS, so the field a caller keys on
  // vanishes from the wire with all 67 tests in the three refresh harnesses still green.
  // Measured, not reasoned about: that mutation was run and killed nothing.
  assert.equal(value.reason, "refresh_still_running", "the WIRE token, spelled out");
  assert.equal(NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING, "refresh_still_running");
  assert.equal(value.reason, NODE_DEF_REFRESH_REASONS.REFRESH_STILL_RUNNING);
  assert.notEqual(value.reason, "unknown", "an abandoned wait is not an unknown failure");
  assert.match(value.remedy, /RETRY/, "…and the remedy is a retry");
  // A tab reload throws away canvas state, so it may only ever be the ESCALATION — named
  // after the retry, and conditioned on the retry not working. #852/#663: a refusal that
  // sends the caller to the wrong recovery costs more than the refusal itself.
  assert.ok(
    value.remedy.indexOf("RETRY") < value.remedy.search(/reload/i),
    "reload must come after the retry, never instead of it",
  );
  assert.match(value.remedy, /keeps reporting this[\s\S]*reload/i, "…and only if retrying fails");
  assert.match(
    value.detail,
    /[Nn]othing failed/,
    "the caller must know nothing was left half-done before it retries",
  );
  // The status remains compatible with the existing bounded own-run path: the same
  // structured token is used whether the command joined an existing run or started one.
  assert.match(value.detail, /something else started/, "the contended case");
  assert.match(value.detail, /own registration/, "…and this command's own run");

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
});

test("#1680: a timed-out joined refresh is not cancelled and a later call can refresh", async () => {
  // This is why the remedy is honest rather than hopeful, and it is also the reporter's
  // observation: the identical call succeeded on the second attempt. The coalescer does not
  // cancel what it stopped waiting for, so the retry pays for ONE run rather than two.
  const gate = deferred();
  const built = realRefreshNodes({
    holdFirstRun: gate.promise,
    budgetMs: 150,
    verdicts: [{ refreshed: true, reason: "refreshed" }],
  });

  const first = await withWatchdog(() => built.refresh_nodes(), 1500, "refresh_nodes never replied");
  assert.equal(first.value.refreshed, false);
  assert.notEqual(built.getInFlight(), null, "the run this call abandoned still holds the slot");

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(built.runs.length, 1, "the abandoned join did not start a competing refresh");

  const second = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "the retry the remedy prescribes never replied either",
  );
  assert.deepEqual(second.value, { ok: true, refreshed: true });
  assert.equal(built.runs.length, 2, "the later idle call starts exactly one new refresh");
});

test("#1695: repeated retries share one pending completion and eventually succeed", async () => {
  const lateCompletion = deferred();
  const built = realRefreshNodes({
    budgetMs: 25,
    runHook: async ({ control }) => {
      control.deferCompletion(
        lateCompletion.promise.then(() => ({ refreshed: true, reason: "refreshed" })),
      );
      return { refreshed: false, reason: "refresh_pending" };
    },
  });

  const first = await withWatchdog(() => built.refresh_nodes(), 1500, "first refresh did not report its status");
  assert.equal(first.value.reason, "refresh_still_running");
  const second = await withWatchdog(() => built.refresh_nodes(), 1500, "second retry did not report its status");
  assert.equal(second.value.reason, "refresh_still_running");
  assert.equal(built.runs.length, 1, "retries remain attached to the same production refresh");
  assert.notEqual(built.getInFlight(), null, "the deferred completion still owns the slot");

  lateCompletion.resolve();
  const settled = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "retry after the late completion did not receive success",
  );
  assert.equal(settled.value.refreshed, true, "the command eventually exposes the completed verdict");
  assert.equal(built.runs.length, 1, "settlement does not start a competing refresh");
  await built.inFlightStarted?.catch(() => {});
});

test("#1725: refresh_nodes returns the completed schema verdict while late combo work stays fenced", async () => {
  const lateCompletion = deferred();
  const terminal = {
    refreshed: true,
    reason: "refreshed",
    combo_refresh_confirmed: false,
    combo_refresh_note: "the frontend combo refresh is still settling",
  };
  const built = realRefreshNodes({
    budgetMs: 25,
    runHook: async ({ index, control }) => {
      // This is the production shape after /object_info and registration have completed:
      // the panel has a terminal schema verdict, but refreshComboInNodes() still owns a
      // shared frontend mutation and must remain behind the single-flight fence.
      if (index > 0) return { refreshed: true, reason: "refreshed" };
      control.publishEarlyResult?.(terminal);
      control.deferCompletion(lateCompletion.promise);
      return terminal;
    },
  });

  const first = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "refresh_nodes did not expose the completed schema verdict",
  );
  assert.deepEqual(first.value, {
    ok: true,
    refreshed: true,
    combo_refresh_confirmed: false,
    combo_refresh_note: terminal.combo_refresh_note,
  });
  assert.notEqual(built.getInFlight(), null, "late combo mutation remains fenced");
  assert.equal(built.runs.length, 1, "the terminal acknowledgement does not start a successor");

  lateCompletion.resolve({ refreshed: true, reason: "refreshed" });
  await new Promise((resolve) => setImmediate(resolve));
  const settled = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "retry after late combo completion did not settle",
  );
  assert.deepEqual(settled.value, { ok: true, refreshed: true });
  assert.equal(built.runs.length, 2, "a retry after settlement starts one fresh forced refresh");
});

test("#1725: an early verdict cannot outrun a reconnect successor queued in the next turn", async () => {
  const lateCompletion = deferred();
  const terminal = {
    refreshed: true,
    reason: "refreshed",
    combo_refresh_confirmed: false,
    combo_refresh_note: "the frontend combo refresh is still settling",
  };
  let built;
  let successorQueued = false;
  let successorRefresh;
  built = realRefreshNodes({
    budgetMs: 25,
    runHook: async ({ index, control }) => {
      if (index > 0) return { refreshed: true, reason: "refreshed" };
      control.publishEarlyResult?.(terminal);
      // Model the ComfyUI reconnected listener arriving after publication but before the
      // acknowledgement continuation composes its reply. The late combo mutation still
      // owns the slot, so this force call queues a successor rather than starting run 2.
      queueMicrotask(() => {
        successorQueued = true;
        successorRefresh = built.refreshComfyNodeDefs(undefined, { force: true });
      });
      control.deferCompletion(lateCompletion.promise);
      return terminal;
    },
  });

  const first = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "refresh_nodes returned before the reconnect successor race settled",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(successorQueued, true, "the reconnect successor was queued after publication");
  assert.equal(built.runs.length, 1, "the successor remains behind the fenced late mutation");
  assert.notEqual(built.getInFlight(), null, "the original late mutation still owns the slot");
  assert.equal(first.value.reason, "refresh_still_running");
  assert.equal(first.value.refreshed, false, "MCP must not receive an early schema-ready verdict");

  lateCompletion.resolve();
  await successorRefresh;
  assert.equal(built.runs.length, 2, "the queued successor starts only after the fence releases");
});

test("#1680: with no refresh in flight, refresh_nodes starts its own forced run", async () => {
  const built = realRefreshNodes({ startInFlight: false, budgetMs: 500 });
  const { value } = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "refresh_nodes did not start an idle refresh",
  );
  assert.deepEqual(value, { ok: true, refreshed: true });
  assert.equal(built.runs.length, 1, "an idle call starts one forced refresh");
});

test("#1404: an UNCONTENDED run that outlives the budget lands on the same named verdict", async () => {
  // The other half of the symbol, and the reason the detail names both runs. With nothing in
  // flight the coalescer takes the last branch — `waitForRun(startRun(…), joinMs)` — so the
  // budget can run out on a run this command started ITSELF, with no concurrency anywhere.
  // That is a big install's ordinary case, and a reply that blamed "something else" for it
  // would be a true-sounding statement about the wrong cause.
  const gate = deferred();
  // Held, but NOT pre-started: the slot is empty when the tool call arrives, so the run that
  // outlives the bound is the one this command started itself.
  const built = realRefreshNodes({ holdFirstRun: gate.promise, startInFlight: false, budgetMs: 150 });

  const { value, elapsed } = await withWatchdog(
    () => built.refresh_nodes(),
    1500,
    "an uncontended slow run never replied",
  );
  assert.equal(value.reason, "refresh_still_running");
  assert.equal(built.runs.length, 1, "there was never a second run — nothing else was in flight");
  assert.ok(elapsed < 1000, `replied in ${elapsed}ms — the bound must end this wait too`);

  gate.resolve();
});

// ---------------------------------------------------------------------------
// 2. What the bound must NOT break.
// ---------------------------------------------------------------------------

test("#1404: an uncontended refresh still reports its real verdict, disclosures included", async () => {
  // The bound is a deadline for waiting, not a shortcut past the answer. #981/#1172/#1193/#1275
  // each had to be forwarded through this executor's fixed object literal; a budget that
  // dropped one of them would re-silence exactly the disclosure it was added for.
  const built = realRefreshNodes({
    budgetMs: 5000,
    verdicts: [
      {
        refreshed: true,
        reason: "refreshed",
        requires_reload: true,
        stale_placeholders: ["LoadImage#7"],
        stale_placeholders_note: "note",
        empty_combo_lists: ["ckpt_name"],
        empty_combo_lists_note: "empty note",
        restored_nodes: ["3"],
        restored_nodes_note: "restored note",
        combo_refresh_confirmed: false,
        combo_refresh_note: "combo note",
      },
    ],
  });

  const { value } = await withWatchdog(() => built.refresh_nodes(), 2000, "refresh_nodes never replied");
  assert.equal(value.refreshed, true);
  assert.equal(value.requires_reload, true);
  assert.deepEqual(value.stale_placeholders, ["LoadImage#7"]);
  assert.deepEqual(value.empty_combo_lists, ["ckpt_name"]);
  assert.deepEqual(value.restored_nodes, ["3"]);
  assert.equal(value.combo_refresh_confirmed, false);
});

test("#1404: a run that genuinely FAILED still reports its own reason, not the new one", async () => {
  // The two states must stay distinguishable in BOTH directions. A budget that reported
  // `refresh_still_running` for a fetch that threw would send the caller to retry forever
  // against a backend that is down — the mirror image of the bug this fixes.
  const built = realRefreshNodes({
    budgetMs: 5000,
    verdicts: [
      {
        refreshed: false,
        reason: NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED,
        remedy: "check that ComfyUI is running",
      },
    ],
  });

  const { value } = await withWatchdog(() => built.refresh_nodes(), 2000, "refresh_nodes never replied");
  assert.equal(value.reason, NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED);
  assert.equal(value.remedy, "check that ComfyUI is running");
});

// ---------------------------------------------------------------------------
// 3. The shipped number, against the window it exists for.
// ---------------------------------------------------------------------------

test("#1404: the shipped budget leaves the relay window room to carry the reply", () => {
  // comfyui-mcp relays `refresh_nodes` at OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS = 30,000 ms. That
  // constant lives in the OTHER repo, so this asserts the property this repo can keep true:
  // the budget is the SAME number `graph_add_node` and `nodes_install` already derived against
  // that window, so the three cannot drift into disagreeing about what "too long" means.
  assert.equal(
    REFRESH_NODES_COMMAND_BUDGET_MS,
    ADD_NODE_COMMAND_BUDGET_MS,
    "the two commands relayed in the same window must hold the same budget",
  );
  assert.ok(
    REFRESH_NODES_COMMAND_BUDGET_MS > 0 && REFRESH_NODES_COMMAND_BUDGET_MS <= 25000,
    "a budget at or over the relay window would restore the bug it exists to prevent",
  );
});

test("#1404: the shipped call site passes the budget — the helper alone cannot prove this", () => {
  // `makeRefreshCoalescer` has accepted `joinMs` since #1192 and implements it correctly; the
  // whole of #1404 was that this one call site never passed it. A behavioural test drives the
  // extracted body, so it already covers the wiring — this is the same fact asserted where a
  // reviewer reading the diff will look for it, on the SOURCE.
  // #1562 — the same shape, now with the RUN allowance beside the JOIN. The two are
  // different quantities and both belong here: `joinMs` is how long this command WAITS,
  // `runBudgetMs` is how long the run it starts may SPEND, and a run that gives up first
  // makes the retryable `refresh_still_running` verdict below unreachable. The comment
  // between them is skipped by `[\s\S]*?`, deliberately — pinning prose is not the point —
  // but BOTH options are required by name.
  assert.match(
    refreshNodesMatch[0],
    /refreshComfyNodeDefs\(undefined, \{[\s\S]*?force: true,[\s\S]*?joinInFlight: true,[\s\S]*?joinMs: REFRESH_NODES_COMMAND_BUDGET_MS,[\s\S]*?runBudgetMs: REFRESH_NODES_RUN_BUDGET_MS,\s*\}\)/,
    "refresh_nodes must join an existing run, bound its wait, and state the run's allowance",
  );
  assert.match(
    refreshNodesMatch[0],
    /joinInFlight: true,[\s\S]*?abandonBeforeLocalWork: true,/,
    "refresh_nodes must give the coalescer its acknowledgement handoff contract (#1758)",
  );
});
