import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  settleOpenedWorkflowActive,
  settleOwnedOpenedWorkflowActive,
} from "../../web/js/lib/settle-open-active.js";
import { settleOpenedWorkflowReadable } from "../../web/js/lib/settle-open-readable.js";
import {
  graphMutationReconnectGate,
  workflowOpenReadinessRefusalError,
  readWorkflowOpenReadinessRefusal,
} from "../../web/js/lib/reconnect-recovery.js";
import { activeWorkflowPossiblyStale } from "../../web/js/lib/reconnect-staleness.js";
import { classifyPinnedTarget } from "../../web/js/lib/workflow-chat-identity.js";
import {
  decideLiveCanvasCapture,
  installActivePointerWatch,
  POINTER_WATCH_UNAVAILABLE_NOTICE,
} from "../../web/js/lib/live-canvas-capture-gate.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const sameWorkflowObject = (a, b) => a === b;

// Evaluate the REAL inline ownership/generation block from the panel. The lifecycle
// test below drives the same guard, generation advance, proof invalidation, and
// downstream gates that production callers use; it is not a second implementation.
const RELOAD_GUARD_SOURCE = SRC.match(
  /let workflowReloadGuard = null;[\s\S]*?function activeWorkflowReloadGuard\(\) \{[\s\S]*?\n\}/,
);
assert.ok(RELOAD_GUARD_SOURCE, "could not locate the production reload guard block");

function realReloadGuard({ now, reconnectEpoch = 4 } = {}) {
  const factory = new Function(
    "Date",
    "backendReconnectEpoch",
    "activeWorkflowResyncEpoch",
    "postReconnectBindingProofEpoch",
    `${RELOAD_GUARD_SOURCE[0]}\nreturn { acquireWorkflowReloadGuard, releaseWorkflowReloadGuard, ` +
      `beginWorkflowReloadStep, endWorkflowReloadStep, ownsWorkflowReloadGuard, ` +
      `activeWorkflowReloadGuard, nextWorkflowBindingGeneration, invalidateWorkflowBindingProof, ` +
      `stampProof: (epoch) => { activeWorkflowResyncEpoch = epoch; postReconnectBindingProofEpoch = epoch; }, ` +
      `proofs: () => ({ activeWorkflowResyncEpoch, postReconnectBindingProofEpoch }) };`,
  );
  return factory(
    { now: () => now.t },
    reconnectEpoch,
    reconnectEpoch,
    reconnectEpoch,
  );
}

function balancedFrom(src, marker, openAt = null) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `missing marker: ${marker}`);
  const open = openAt ?? src.indexOf("{", start + marker.length);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < src.length; i += 1) {
        if (src[i] === "\\") {
          i += 1;
          continue;
        }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated block: ${marker}`);
}

const PINIA_STORE_HELPER_SOURCE = balancedFrom(SRC, "function getPiniaStore(id)");

// Execute a shipped executor body with the shipped reload guard and proof helper.
// The frontend-facing services are supplied by each lifecycle test, but the operation
// and its ownership/generation implementation are not re-created in the test.
function productionExecutor(methodName, environment) {
  const signature = `async ${methodName}({`;
  const sigStart = SRC.indexOf(signature);
  assert.notEqual(sigStart, -1, `${methodName} not found`);
  const bodyBrace = SRC.indexOf(") {", sigStart) + 1;
  const methodSource = balancedFrom(SRC, signature, bodyBrace).replace(
    new RegExp(`^async ${methodName}\\(`),
    `async function ${methodName}(`,
  );
  const factory = new Function(
    "sandbox",
    `with (sandbox) {\n${RELOAD_GUARD_SOURCE[0]}\n${PINIA_STORE_HELPER_SOURCE}\n${methodSource}\n` +
      `return { method: ${methodName}, guard: () => activeWorkflowReloadGuard(), ` +
      `proofs: () => ({ active: activeWorkflowResyncEpoch, post: postReconnectBindingProofEpoch }) };\n}`,
  );
  // Shipped #1911 helpers are the default so a production open eval drives the
  // same gate the panel imports. A test may still override them.
  const sandbox = {
    decideLiveCanvasCapture,
    installActivePointerWatch,
    POINTER_WATCH_UNAVAILABLE_NOTICE,
    workflowOpenReadinessRefusalError,
    readWorkflowOpenReadinessRefusal,
    ...environment,
  };
  const scope = new Proxy(sandbox, {
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : globalThis[key];
    },
  });
  return factory(scope);
}

function productionReadableOpenEnvironment({ readableAfterRetry, readableButMismatched = false }) {
  const previous = { path: "workflows/previous.json" };
  const target = {
    path: "workflows/target.json",
    filename: "target.json",
    isModified: false,
    activeState: {
      nodes: [{ id: 1, type: "KSampler", widgets_values: ["target-value"] }],
      links: [],
      groups: [],
      last_node_id: 1,
      extra: { comfyui_mcp: { workflow_uuid: "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95" } },
    },
  };
  const root = { _nodes: [], extra: {} };
  const uuid = "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95";
  let active = previous;
  let loads = 0;
  let outlines = 0;
  let contentProofs = 0;
  const app = {
    rootGraph: root,
    graph: root,
    canvas: {},
    loadGraphData: async (state) => {
      loads += 1;
      root.extra = state.extra;
      root._nodes = [
        {
          id: 1,
          type: "KSampler",
          widgets_values: [readableButMismatched ? "stale-value" : "target-value"],
        },
      ];
    },
    extensionManager: {
      workflow: {
        openWorkflows: [target],
        workflows: [],
        getWorkflowByPath: () => target,
        openWorkflow: async () => {
          active = target;
        },
      },
    },
  };
  const status = { PROVEN: "proven", CONTENT_UNVERIFIED: "content-unverified", UNPROVEN: "unproven" };
  return {
    target,
    counters: () => ({ loads, outlines, contentProofs }),
    environment: {
      backendReconnectEpoch: 4,
      activeWorkflowResyncEpoch: 4,
      postReconnectBindingProofEpoch: 4,
      app,
      activeWorkflowRef: () => active,
      sameWorkflowObject: (a, b) => a === b,
      workflowTabId: (workflow) => `wf:${workflow.path}`,
      WORKFLOW_META_NAMESPACE: "comfyui_mcp",
      WORKFLOW_UUID_FIELD: "workflow_uuid",
      WORKFLOW_PATH_FIELD: "workflow_path",
      OPEN_PROOF_FIELD: "open_proof",
      workflowObjectUuid: () => uuid,
      workflowStableUuid: () => uuid,
      workflowOwnsRootUuidTag: () => false,
      workflowUuidOwner: () => null,
      getWorkflowTitle: () => "Target",
      waitForReconnectHandshakeBeforeOpen: async () => {},
      comfyBackendIsDown: () => false,
      postReconnectBindingSettleWindow: () => false,
      nodeDefRefreshInFlight: null,
      flushSourceCanvasBeforeSwitch: async () => {},
      claimActiveWorkflowMove: () => {},
      acquireCanvasInteractionLock: () => null,
      releaseCanvasInteractionLock: () => {},
      MOVE_CAUSES: { OPEN_EXECUTOR: "workflow_open" },
      settleOpenedWorkflowTarget: async () => ({ target, loaded: false }),
      workflowRecordMatchesSelector: () => true,
      installNodeConfigureIsolation: () => ({ failures: [], restore: () => {} }),
      installGraphConfigureWatch: () => ({ restore: () => {} }),
      loadRestoreCompleted: () => true,
      retryNodeRestores: async () => ({ restored: [], failed: [], recovered: [] }),
      liteGraphGlobal: () => null,
      getGraphCtx: () => ({ graph: root, rootGraph: root }),
      describeLiveCanvasBinding: () => "unknown",
      applySavedNodePresentation: () => {},
      applySavedSubgraphHostWidgets: () => {},
      decideOpenStaleness: () => ({ stale: false, reload: false }),
      describeRepaintSourceBinding: () => "unknown",
      graphRootCarriesOpenProof: () => true,
      graphRootWorkflowUuidMatches: () => true,
      graphRootReproducesStateContent: ({ rootGraph, state }) => {
        contentProofs += 1;
        const liveValue = rootGraph?._nodes?.[0]?.widgets_values?.[0];
        const requestedValue = state?.nodes?.[0]?.widgets_values?.[0];
        return {
          proven: loads > 1 && liveValue === requestedValue,
          presentationOnly: false,
          normalizedOnly: false,
        };
      },
      describeGraphStateDifference: () => ({ comparable: true, surfaces: ["nodes"], accountedSurfaces: [], nodeDifference: null }),
      openContentDifferenceIsDefinitionsOnly: () => false,
      resolveOpenRebindVerdict: ({ contentMatches }) =>
        contentMatches ? { status: status.PROVEN } : { status: status.CONTENT_UNVERIFIED },
      describeOpenRebindOutcome: () => "content could not be verified",
      OPEN_REBIND_STATUS: status,
      GRAPH_TOOL_EXECUTORS: {
        graph_outline: () => {
          outlines += 1;
          return readableButMismatched || (readableAfterRetry && loads > 1)
            ? { node_count: 1, outline: "1 KSampler", detail_level: "full" }
            : null;
        },
      },
      settleOpenedWorkflowReadable,
      settleOwnedOpenedWorkflowActive,
      noteOpenAttempt: () => ({ seq: 1 }),
      backendSocketReplyFields: () => ({}),
      activeWorkflowUuidForOpenReply: () => uuid,
      describeOpenActiveBinding: () => ({ active_matches_target: true }),
      canvasFileDivergenceNote: () => null,
      failOpenRebindUnknown: (error) => error,
      coerceMessageText: (value) => String(value),
    },
  };
}

function workflowPiniaDocument(workflowStore) {
  return {
    getElementById: () => ({
      __vue_app__: { config: { globalProperties: { $pinia: { _s: new Map([["workflow", workflowStore]]) } } } },
    }),
    querySelector: () => null,
  };
}

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
  };
}

test("#887 production sequence rejects a delayed active-canvas reversion", async () => {
  const previous = { path: "workflows/previous.json" };
  const target = { path: "workflows/target.json" };
  let active = target;
  const probes = [];
  const clock = fakeClock();

  // This models the event that arrives after the store's synchronous active read but
  // before the command releases its open guard. The probe is the production caller's
  // actual read/comparison sequence, not a pure comparison-helper assertion.
  const result = await settleOpenedWorkflowActive({
    target,
    readActive: () => {
      probes.push(active);
      return active;
    },
    sameWorkflowObject,
    wait: async (ms) => {
      active = previous;
      await clock.wait(ms);
    },
    now: clock.now,
    budgetMs: 30,
    pollMs: 10,
    stableMs: 10,
  });

  assert.equal(result.status, "different");
  assert.equal(result.active, previous);
  assert.ok(probes.length >= 2, "the active binding was re-probed after the event-loop turn");
});

test("#887 delayed target activation is accepted only after a stable probe window", async () => {
  const previous = { path: "workflows/previous.json" };
  const target = { path: "workflows/target.json" };
  let active = previous;
  const clock = fakeClock();

  const result = await settleOpenedWorkflowActive({
    target,
    readActive: () => active,
    sameWorkflowObject,
    wait: async (ms) => {
      await clock.wait(ms);
      if (clock.now() >= 10) active = target;
    },
    now: clock.now,
    budgetMs: 50,
    pollMs: 5,
    stableMs: 10,
  });

  assert.equal(result.status, "settled");
  assert.equal(result.active, target);
});

test("#887 unreadable active state stays unknown", async () => {
  const clock = fakeClock();
  const target = { path: "workflows/target.json" };
  const result = await settleOpenedWorkflowActive({
    target,
    readActive: () => null,
    sameWorkflowObject,
    wait: clock.wait,
    now: clock.now,
    budgetMs: 10,
    pollMs: 5,
    stableMs: 0,
  });

  assert.equal(result.status, "unknown");
});

test("#1898 settles a readable outline after one normalization retry", async () => {
  const target = { path: "workflows/target.json" };
  let settleCalls = 0;
  let outlineCalls = 0;
  let retries = 0;

  const result = await settleOpenedWorkflowReadable({
    settleActive: async () => {
      settleCalls += 1;
      return { status: "settled", active: target };
    },
    readGraphOutline: async () => {
      outlineCalls += 1;
      return outlineCalls === 1 ? null : { node_count: 1, outline: "1 KSampler", detail_level: "full" };
    },
    retryNormalization: async () => {
      retries += 1;
      return true;
    },
  });

  assert.equal(result.status, "settled-readable");
  assert.equal(result.retried, true);
  assert.equal(retries, 1, "normalization is retried once");
  assert.equal(outlineCalls, 2, "the readable graph is re-probed after retry");
  assert.equal(settleCalls, 4, "identity is settled before retry and after the final probe");
});

test("#1898 keeps an unreadable or unproven graph outcome unknown", async () => {
  const target = { path: "workflows/target.json" };
  let retries = 0;
  const result = await settleOpenedWorkflowReadable({
    settleActive: async () => ({ status: "settled", active: target }),
    readGraphOutline: async () => null,
    retryNormalization: async () => {
      retries += 1;
      return true;
    },
  });

  assert.equal(result.status, "unknown");
  assert.equal(retries, 1, "an unreadable graph gets only the bounded retry");

  let identityRetries = 0;
  const identityUnknown = await settleOpenedWorkflowReadable({
    settleActive: async () => ({ status: "unknown", reason: "active workflow was unreadable" }),
    readGraphOutline: async () => ({ node_count: 1, outline: "1 KSampler", detail_level: "full" }),
    retryNormalization: async () => {
      identityRetries += 1;
      return true;
    },
  });
  assert.equal(identityUnknown.status, "unknown");
  assert.equal(identityRetries, 0, "an unreadable identity never authorizes normalization");
});

test("#887 a superseding open cannot turn an old settle result into success", async () => {
  const clock = fakeClock();
  const target = { path: "workflows/target.json" };
  let owns = true;
  let ended = 0;
  const result = await settleOwnedOpenedWorkflowActive({
    target,
    readActive: () => target,
    sameWorkflowObject,
    beginStep: () => true,
    ownsStep: () => owns,
    endStep: () => {
      ended += 1;
    },
    wait: async (ms) => {
      owns = false;
      await clock.wait(ms);
    },
    now: clock.now,
    budgetMs: 20,
    pollMs: 10,
    stableMs: 10,
  });

  assert.equal(result.status, "superseded");
  assert.equal(ended, 1, "the owned step always runs its cleanup");

  const notStarted = await settleOwnedOpenedWorkflowActive({
    target,
    readActive: () => target,
    sameWorkflowObject,
    beginStep: () => false,
    ownsStep: () => true,
    endStep: () => {
      ended += 1;
    },
    wait: clock.wait,
    now: clock.now,
    budgetMs: 10,
    pollMs: 5,
    stableMs: 0,
  });
  assert.equal(notStarted.status, "superseded");
  assert.equal(ended, 1, "a step that never acquired ownership has no cleanup to release");
});

test("#887 production lifecycle fences workflow_open/new supersession before immediate consumers", () => {
  const now = { t: 1_000_000 };
  const reconnectEpoch = 4;
  const guard = realReloadGuard({ now, reconnectEpoch });

  // The old open owns an awaited switch/probe. A newer workflow_new cannot replace
  // that live owner, because allowing both loads to settle would make their order
  // nondeterministic on the canvas.
  const oldOpenToken = guard.acquireWorkflowReloadGuard("workflow_open:old.json");
  const oldOpenGeneration = guard.nextWorkflowBindingGeneration();
  assert.equal(guard.beginWorkflowReloadStep(oldOpenToken), true);
  assert.equal(
    guard.acquireWorkflowReloadGuard("workflow_new"),
    null,
    "workflow_new must refuse while the open's mutating step is still in flight",
  );
  guard.endWorkflowReloadStep(oldOpenToken);
  guard.releaseWorkflowReloadGuard(oldOpenToken);

  // The new-tab operation then becomes the current binding generation and proves
  // itself. A late failure from the older open must not retire that proof.
  const newToken = guard.acquireWorkflowReloadGuard("workflow_new");
  const newGeneration = guard.nextWorkflowBindingGeneration();
  assert.equal(guard.beginWorkflowReloadStep(newToken), true);
  guard.stampProof(reconnectEpoch);
  guard.endWorkflowReloadStep(newToken);
  guard.releaseWorkflowReloadGuard(newToken);
  assert.equal(guard.invalidateWorkflowBindingProof(oldOpenGeneration), false);
  assert.deepEqual(guard.proofs(), {
    activeWorkflowResyncEpoch: reconnectEpoch,
    postReconnectBindingProofEpoch: reconnectEpoch,
  });

  // Conversely, a failure belonging to the current generation retires both proofs
  // before the same immediate workflow_list/pin/current-mode consumers run.
  assert.equal(guard.invalidateWorkflowBindingProof(newGeneration), true);
  const proof = guard.proofs();
  const activeConfirmed = !activeWorkflowPossiblyStale({
    reconnectEpoch,
    resyncEpoch: proof.activeWorkflowResyncEpoch,
    reconnectedAt: 100,
    now: 150,
  });
  const bindingSettleWindow = activeWorkflowPossiblyStale({
    reconnectEpoch,
    resyncEpoch: proof.activeWorkflowResyncEpoch,
    reconnectedAt: 100,
    now: 150,
  });
  assert.equal(activeConfirmed, false, "workflow_list must not trust retired active proof");
  assert.equal(classifyPinnedTarget("workflows/new.json", ["workflows/old.json"]), "mismatch");
  assert.equal(
    graphMutationReconnectGate({ cmd: "graph_set_widget", bindingSettleWindow })?.code,
    "post-reconnect-settling",
    "current-mode mutation must remain fail-closed until a fresh proof exists",
  );
});

test("#887 production workflow_open native failure retires proof before its negative reply", async () => {
  const previous = { path: "workflows/previous.json" };
  const target = { path: "workflows/target.json", filename: "target.json", isModified: false };
  const nativeError = new Error("native switch rejected after partial work");
  const journal = [];
  const panel = productionExecutor("workflow_open", {
    backendReconnectEpoch: 4,
    activeWorkflowResyncEpoch: 4,
    postReconnectBindingProofEpoch: 4,
    app: {
      canvas: {},
      extensionManager: {
        workflow: {
          openWorkflows: [target],
          workflows: [],
          getWorkflowByPath: () => target,
          openWorkflow: async () => {
            throw nativeError;
          },
        },
      },
    },
    activeWorkflowRef: () => previous,
    workflowTabId: (workflow) => `wf:${workflow.path}`,
    workflowStableUuid: () => "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95",
    noteOpenAttempt: (entry) => {
      journal.push(entry);
      return { seq: journal.length };
    },
    coerceMessageText: (value) => String(value),
    getWorkflowTitle: () => "Previous",
    waitForReconnectHandshakeBeforeOpen: async () => {},
    comfyBackendIsDown: () => false,
    postReconnectBindingSettleWindow: () => false,
    nodeDefRefreshInFlight: null,
    flushSourceCanvasBeforeSwitch: async () => {},
    claimActiveWorkflowMove: () => {},
    acquireCanvasInteractionLock: () => ({ token: 1 }),
    releaseCanvasInteractionLock: () => {},
    MOVE_CAUSES: { OPEN_EXECUTOR: "workflow_open" },
  });

  await assert.rejects(panel.method({ path: target.path, rid: "native-failure" }), nativeError);
  assert.deepEqual(panel.proofs(), {
    active: 3,
    post: 3,
  });
  assert.equal(panel.guard(), null, "native failure must release the production reload guard");
  assert.equal(journal.at(-1)?.applied, false, "the native failure remains a clean negative reply");
  assert.match(journal.at(-1)?.error ?? "", /native switch rejected/);
});

test("#1898 production workflow_open accepts a settled readable outline after normalization races", async () => {
  const { target, counters, environment } = productionReadableOpenEnvironment({ readableAfterRetry: true });
  const panel = productionExecutor("workflow_open", environment);

  const result = await panel.method({ path: target.path, rid: "readable-race" });

  assert.equal(result.opened.path, target.path);
  assert.equal(result.workflow_uuid, "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95");
  assert.deepEqual(
    counters(),
    { loads: 2, outlines: 2, contentProofs: 2 },
    "the production handler retries once, re-probes, and re-verifies graph content",
  );
  assert.equal(panel.guard(), null, "the readable outcome releases the production reload guard");
});

test("#1898 production workflow_open keeps a readable but mismatched graph unknown", async () => {
  const { target, counters, environment } = productionReadableOpenEnvironment({
    readableAfterRetry: false,
    readableButMismatched: true,
  });
  const panel = productionExecutor("workflow_open", environment);

  await assert.rejects(panel.method({ path: target.path, rid: "mismatched-readable-race" }), /content could not be verified/);
  assert.deepEqual(
    counters(),
    { loads: 1, outlines: 1, contentProofs: 2 },
    "readability cannot replace the final normalized node/value content proof",
  );
  assert.equal(panel.guard(), null, "the unknown outcome releases the production reload guard");
});

test("#1639 production workflow_open does not capture a stale previous canvas into a bare target tab", async () => {
  const uuid = "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95";
  const previous = { path: "workflows/previous.json" };
  const previousState = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: ["previous-value"] }],
    links: [],
    groups: [],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  const targetState = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: ["target-value"] }],
    links: [],
    groups: [],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  let active = previous;
  let captured = 0;
  let loadedValue;
  const root = {
    _nodes: [{ id: 1, type: "KSampler", widgets_values: ["previous-value"] }],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  const target = {
    path: "workflows/target.json",
    filename: "target.json",
    isModified: false,
    changeTracker: {
      activeState: structuredClone(targetState),
      checkState() {
        captured += 1;
        this.activeState = structuredClone(previousState);
      },
    },
  };
  const app = {
    rootGraph: root,
    graph: root,
    canvas: { graph: root },
    loadGraphData: async (state) => {
      loadedValue = state?.nodes?.[0]?.widgets_values?.[0];
      root.extra = state.extra;
      root._nodes = state.nodes.map((node) => ({ ...node }));
    },
    extensionManager: {
      workflow: {
        openWorkflows: [target],
        workflows: [],
        getWorkflowByPath: () => target,
        openWorkflow: async () => {
          active = target;
        },
      },
    },
  };
  const status = { PROVEN: "proven", CONTENT_UNVERIFIED: "content-unverified", UNPROVEN: "unproven" };
  const panel = productionExecutor("workflow_open", {
    backendReconnectEpoch: 4,
    activeWorkflowResyncEpoch: 4,
    postReconnectBindingProofEpoch: 4,
    app,
    activeWorkflowRef: () => active,
    sameWorkflowObject: (a, b) => a === b,
    workflowTabId: (workflow) => `wf:${workflow.path}`,
    WORKFLOW_META_NAMESPACE: "comfyui_mcp",
    WORKFLOW_UUID_FIELD: "workflow_uuid",
    WORKFLOW_PATH_FIELD: "workflow_path",
    OPEN_PROOF_FIELD: "open_proof",
    workflowObjectUuid: () => uuid,
    workflowStableUuid: () => uuid,
    workflowOwnsRootUuidTag: () => false,
    workflowUuidOwner: () => null,
    getWorkflowTitle: () => "Target",
    waitForReconnectHandshakeBeforeOpen: async () => {},
    comfyBackendIsDown: () => false,
    postReconnectBindingSettleWindow: () => false,
    nodeDefRefreshInFlight: null,
    flushSourceCanvasBeforeSwitch: async () => {},
    claimActiveWorkflowMove: () => {},
    acquireCanvasInteractionLock: () => null,
    releaseCanvasInteractionLock: () => {},
    MOVE_CAUSES: { OPEN_EXECUTOR: "workflow_open" },
    settleOpenedWorkflowTarget: async () => ({ target, loaded: false }),
    workflowRecordMatchesSelector: () => true,
    installNodeConfigureIsolation: () => ({ failures: [], restore: () => {} }),
    installGraphConfigureWatch: () => ({ restore: () => {} }),
    loadRestoreCompleted: () => true,
    retryNodeRestores: async () => ({ restored: [], failed: [], recovered: [] }),
    liteGraphGlobal: () => null,
    getGraphCtx: () => ({ graph: root, rootGraph: root }),
    // This is the regression input: a stale root UUID is not proof that the visible
    // canvas belongs to the target, but the old capture gate treated it as enough.
    describeLiveCanvasBinding: () => "bound",
    applySavedNodePresentation: () => {},
    applySavedSubgraphHostWidgets: () => {},
    decideOpenStaleness: () => ({ stale: false, reload: false }),
    describeRepaintSourceBinding: () => "unknown",
    graphRootCarriesOpenProof: () => true,
    graphRootWorkflowUuidMatches: () => true,
    graphRootReproducesStateContent: ({ rootGraph, state }) => ({
      proven: rootGraph?._nodes?.[0]?.widgets_values?.[0] === state?.nodes?.[0]?.widgets_values?.[0],
      presentationOnly: false,
      normalizedOnly: false,
    }),
    describeGraphStateDifference: () => ({ comparable: true, surfaces: ["nodes"], accountedSurfaces: [], nodeDifference: null }),
    openContentDifferenceIsDefinitionsOnly: () => false,
    resolveOpenRebindVerdict: ({ contentMatches }) =>
      contentMatches ? { status: status.PROVEN } : { status: status.CONTENT_UNVERIFIED },
    describeOpenRebindOutcome: () => "content could not be verified",
    OPEN_REBIND_STATUS: status,
    GRAPH_TOOL_EXECUTORS: { graph_outline: () => ({ node_count: 1, outline: "1 KSampler", detail_level: "full" }) },
    settleOpenedWorkflowReadable,
    settleOwnedOpenedWorkflowActive,
    noteOpenAttempt: () => ({ seq: 1 }),
    backendSocketReplyFields: () => ({}),
    activeWorkflowUuidForOpenReply: () => uuid,
    describeOpenActiveBinding: () => ({ active_matches_target: true }),
    canvasFileDivergenceNote: () => null,
    failOpenRebindUnknown: (error) => error,
    coerceMessageText: (value) => String(value),
  });

  const result = await panel.method({ path: "target.json", rid: "bare-stale-canvas" });

  assert.equal(result.opened.path, target.path);
  assert.equal(loadedValue, "target-value", "the production repaint must use the target state, not the previous canvas");
  assert.equal(captured, 0, "a moved active pointer is not proof that the stale visible root belongs to the target");
  assert.equal(panel.guard(), null, "the production open releases its reload guard");
});

test("#1639 production workflow_open remembers switch-away-and-back during an early await", async () => {
  const { target, environment } = productionReadableOpenEnvironment({ readableAfterRetry: true });
  const other = { path: "workflows/other.json" };
  let active = target;
  let captures = 0;
  const subscribers = [];
  const notifyStoreMutation = () => {
    for (const subscriber of [...subscribers]) subscriber();
  };
  const workflowStore = {
    $subscribe: (subscriber) => {
      subscribers.push(subscriber);
      return () => {
        const index = subscribers.indexOf(subscriber);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
  };
  target.changeTracker = {
    activeState: target.activeState,
    checkState() {
      captures += 1;
    },
  };
  environment.document = workflowPiniaDocument(workflowStore);
  environment.activeWorkflowRef = () => active;
  environment.describeLiveCanvasBinding = () => "bound";
  environment.flushSourceCanvasBeforeSwitch = async () => {};
  environment.waitForReconnectHandshakeBeforeOpen = async () => {
    // This is before the reload guard and native open. The endpoint is restored
    // before the await returns, so only the operation-local epoch can remember it.
    active = other;
    notifyStoreMutation();
    await Promise.resolve();
    active = target;
    notifyStoreMutation();
  };
  environment.app.extensionManager.workflow.openWorkflow = async () => {
    active = target;
  };

  const panel = productionExecutor("workflow_open", environment);
  const result = await panel.method({ path: target.path, rid: "early-switch-away-back" });

  assert.equal(result.opened.path, target.path);
  assert.equal(captures, 0, "an early switch excursion invalidates the endpoint-only proof");
  assert.equal(subscribers.length, 0, "the synchronous pointer watch is cleaned up after the open");
  assert.equal(panel.guard(), null, "the production open releases its reload guard");
  assert.equal(active, target);
});

test("#1639 production workflow_open rejects a one-way external switch during source flush", async () => {
  const { target, environment } = productionReadableOpenEnvironment({ readableAfterRetry: true });
  let active = environment.activeWorkflowRef();
  let captures = 0;
  const subscribers = [];
  const notifyStoreMutation = () => {
    for (const subscriber of [...subscribers]) subscriber();
  };
  const workflowStore = {
    $subscribe: (subscriber) => {
      subscribers.push(subscriber);
      return () => {
        const index = subscribers.indexOf(subscriber);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
  };
  target.changeTracker = {
    activeState: target.activeState,
    checkState() {
      captures += 1;
    },
  };
  environment.document = workflowPiniaDocument(workflowStore);
  environment.activeWorkflowRef = () => active;
  environment.describeLiveCanvasBinding = () => "bound";
  environment.flushSourceCanvasBeforeSwitch = async () => {
    // The flush runs before the command stakes its native-move claim. This external
    // one-way move must never authorize a later bound capture.
    active = target;
    notifyStoreMutation();
    await Promise.resolve();
  };
  environment.app.extensionManager.workflow.openWorkflow = async () => {
    active = target;
  };

  const panel = productionExecutor("workflow_open", environment);
  const result = await panel.method({ path: target.path, rid: "flush-one-way-switch" });

  assert.equal(result.opened.path, target.path);
  assert.equal(captures, 0, "a pre-native external move cannot authorize bound capture");
  assert.equal(subscribers.length, 0, "the synchronous pointer watch is cleaned up after the open");
  assert.equal(panel.guard(), null, "the production open releases its reload guard");
  assert.equal(active, target);
});

test("#1639 production workflow_open preserves proven-bound capture after a legitimate tab move", async () => {
  const { target, environment } = productionReadableOpenEnvironment({ readableAfterRetry: true });
  const previous = { path: "workflows/previous.json" };
  let active = previous;
  let captures = 0;
  const subscribers = [];
  const workflowStore = {
    $subscribe: (subscriber) => {
      subscribers.push(subscriber);
      return () => {
        const index = subscribers.indexOf(subscriber);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
  };
  target.changeTracker = {
    activeState: target.activeState,
    checkState() {
      captures += 1;
    },
  };
  environment.document = workflowPiniaDocument(workflowStore);
  environment.activeWorkflowRef = () => active;
  environment.describeLiveCanvasBinding = () => "bound";
  environment.app.extensionManager.workflow.openWorkflow = async () => {
    active = target;
  };

  const panel = productionExecutor("workflow_open", environment);
  const result = await panel.method({ path: target.path, rid: "proven-bound-capture" });

  assert.equal(result.opened.path, target.path);
  assert.equal(captures, 1, "a proven-bound canvas still captures node-written values after a tab move");
  assert.equal(subscribers.length, 0, "the synchronous pointer watch is cleaned up after the open");
  assert.equal(panel.guard(), null, "the production open releases its reload guard");
});

test("#1215 production workflow_open does not capture a still-mounted previous canvas even when the Pinia watch proves the tab move", async () => {
  const uuid = "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95";
  const previousState = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: ["previous-value"] }],
    links: [],
    groups: [],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  const targetState = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: ["target-value"] }],
    links: [],
    groups: [],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  let active;
  let captured = 0;
  let loadedValue;
  const subscribers = [];
  const workflowStore = {
    $subscribe: (subscriber) => {
      subscribers.push(subscriber);
      return () => {
        const index = subscribers.indexOf(subscriber);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
  };
  const root = {
    _nodes: [{ id: 1, type: "KSampler", widgets_values: ["previous-value"] }],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  const previous = {
    path: "workflows/previous.json",
    changeTracker: { activeState: structuredClone(previousState) },
  };
  active = previous;
  const target = {
    path: "workflows/target.json",
    filename: "target.json",
    isModified: false,
    changeTracker: {
      activeState: structuredClone(targetState),
      checkState() {
        captured += 1;
        this.activeState = structuredClone(previousState);
      },
    },
  };
  const app = {
    rootGraph: root,
    graph: root,
    canvas: { graph: root },
    loadGraphData: async (state) => {
      loadedValue = state?.nodes?.[0]?.widgets_values?.[0];
      root.extra = state.extra;
      root._nodes = state.nodes.map((node) => ({ ...node }));
    },
    extensionManager: {
      workflow: {
        openWorkflows: [target],
        workflows: [],
        getWorkflowByPath: () => target,
        openWorkflow: async () => {
          active = target;
        },
      },
    },
  };
  const status = { PROVEN: "proven", CONTENT_UNVERIFIED: "content-unverified", UNPROVEN: "unproven" };
  const panel = productionExecutor("workflow_open", {
    backendReconnectEpoch: 4,
    activeWorkflowResyncEpoch: 4,
    postReconnectBindingProofEpoch: 4,
    app,
    document: workflowPiniaDocument(workflowStore),
    activeWorkflowRef: () => active,
    sameWorkflowObject: (a, b) => a === b,
    workflowTabId: (workflow) => `wf:${workflow.path}`,
    WORKFLOW_META_NAMESPACE: "comfyui_mcp",
    WORKFLOW_UUID_FIELD: "workflow_uuid",
    WORKFLOW_PATH_FIELD: "workflow_path",
    OPEN_PROOF_FIELD: "open_proof",
    workflowObjectUuid: () => uuid,
    workflowStableUuid: () => uuid,
    workflowOwnsRootUuidTag: () => false,
    workflowUuidOwner: () => null,
    getWorkflowTitle: () => "Target",
    waitForReconnectHandshakeBeforeOpen: async () => {},
    comfyBackendIsDown: () => false,
    postReconnectBindingSettleWindow: () => false,
    nodeDefRefreshInFlight: null,
    flushSourceCanvasBeforeSwitch: async () => {},
    claimActiveWorkflowMove: () => {},
    acquireCanvasInteractionLock: () => null,
    releaseCanvasInteractionLock: () => {},
    MOVE_CAUSES: { OPEN_EXECUTOR: "workflow_open" },
    settleOpenedWorkflowTarget: async () => ({ target, loaded: false }),
    workflowRecordMatchesSelector: () => true,
    installNodeConfigureIsolation: () => ({ failures: [], restore: () => {} }),
    installGraphConfigureWatch: () => ({ restore: () => {} }),
    loadRestoreCompleted: () => true,
    retryNodeRestores: async () => ({ restored: [], failed: [], recovered: [] }),
    liteGraphGlobal: () => null,
    getGraphCtx: () => ({ graph: root, rootGraph: root }),
    describeLiveCanvasBinding: () => "bound",
    applySavedNodePresentation: () => {},
    applySavedSubgraphHostWidgets: () => {},
    decideOpenStaleness: () => ({ stale: false, reload: false }),
    describeRepaintSourceBinding: () => "unknown",
    graphRootCarriesOpenProof: () => true,
    graphRootWorkflowUuidMatches: () => true,
    graphRootReproducesStateContent: ({ rootGraph, state }) => ({
      proven: rootGraph?._nodes?.[0]?.widgets_values?.[0] === state?.nodes?.[0]?.widgets_values?.[0],
      presentationOnly: false,
      normalizedOnly: false,
    }),
    describeGraphStateDifference: () => ({ comparable: true, surfaces: ["nodes"], accountedSurfaces: [], nodeDifference: null }),
    openContentDifferenceIsDefinitionsOnly: () => false,
    resolveOpenRebindVerdict: ({ contentMatches }) =>
      contentMatches ? { status: status.PROVEN } : { status: status.CONTENT_UNVERIFIED },
    describeOpenRebindOutcome: () => "content could not be verified",
    OPEN_REBIND_STATUS: status,
    GRAPH_TOOL_EXECUTORS: { graph_outline: () => ({ node_count: 1, outline: "1 KSampler", detail_level: "full" }) },
    settleOpenedWorkflowReadable,
    settleOwnedOpenedWorkflowActive,
    noteOpenAttempt: () => ({ seq: 1 }),
    backendSocketReplyFields: () => ({}),
    activeWorkflowUuidForOpenReply: () => uuid,
    describeOpenActiveBinding: () => ({ active_matches_target: true }),
    canvasFileDivergenceNote: () => null,
    failOpenRebindUnknown: (error) => error,
    coerceMessageText: (value) => String(value),
  });

  const result = await panel.method({ path: "target.json", rid: "still-mounted-source" });

  assert.equal(result.opened.path, target.path);
  assert.equal(captured, 0, "a proven pointer move is not proof the still-mounted canvas belongs to TARGET");
  assert.equal(loadedValue, "target-value", "the repaint must use TARGET's tracker, not the previous canvas");
  assert.equal(root._nodes[0].widgets_values[0], "target-value");
  assert.equal(panel.guard(), null, "the production open releases its reload guard");
});

test("#1215 production workflow_open refuses when the load leaves the previous tab's widgets on the canvas", async () => {
  const uuid = "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95";
  const previousState = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: ["previous-value"] }],
    links: [],
    groups: [],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  const targetState = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: ["target-value"] }],
    links: [],
    groups: [],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  let active;
  const subscribers = [];
  const workflowStore = {
    $subscribe: (subscriber) => {
      subscribers.push(subscriber);
      return () => {
        const index = subscribers.indexOf(subscriber);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
  };
  const root = {
    _nodes: [{ id: 1, type: "KSampler", widgets_values: ["previous-value"] }],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  const previous = {
    path: "workflows/previous.json",
    changeTracker: { activeState: structuredClone(previousState) },
  };
  active = previous;
  const target = {
    path: "workflows/target.json",
    filename: "target.json",
    isModified: false,
    changeTracker: { activeState: structuredClone(targetState), checkState() {} },
  };
  const app = {
    rootGraph: root,
    graph: root,
    canvas: { graph: root },
    loadGraphData: async () => {
      // Related-workflow merge: same ids/types, previous widgets survive.
    },
    extensionManager: {
      workflow: {
        openWorkflows: [target],
        workflows: [],
        getWorkflowByPath: () => target,
        openWorkflow: async () => {
          active = target;
        },
      },
    },
  };
  const status = { PROVEN: "proven", CONTENT_UNVERIFIED: "content-unverified", UNPROVEN: "unproven" };
  const panel = productionExecutor("workflow_open", {
    backendReconnectEpoch: 4,
    activeWorkflowResyncEpoch: 4,
    postReconnectBindingProofEpoch: 4,
    app,
    document: workflowPiniaDocument(workflowStore),
    activeWorkflowRef: () => active,
    sameWorkflowObject: (a, b) => a === b,
    workflowTabId: (workflow) => `wf:${workflow.path}`,
    WORKFLOW_META_NAMESPACE: "comfyui_mcp",
    WORKFLOW_UUID_FIELD: "workflow_uuid",
    WORKFLOW_PATH_FIELD: "workflow_path",
    OPEN_PROOF_FIELD: "open_proof",
    workflowObjectUuid: () => uuid,
    workflowStableUuid: () => uuid,
    workflowOwnsRootUuidTag: () => false,
    workflowUuidOwner: () => null,
    getWorkflowTitle: () => "Target",
    waitForReconnectHandshakeBeforeOpen: async () => {},
    comfyBackendIsDown: () => false,
    postReconnectBindingSettleWindow: () => false,
    nodeDefRefreshInFlight: null,
    flushSourceCanvasBeforeSwitch: async () => {},
    claimActiveWorkflowMove: () => {},
    acquireCanvasInteractionLock: () => null,
    releaseCanvasInteractionLock: () => {},
    MOVE_CAUSES: { OPEN_EXECUTOR: "workflow_open" },
    settleOpenedWorkflowTarget: async () => ({ target, loaded: false }),
    workflowRecordMatchesSelector: () => true,
    installNodeConfigureIsolation: () => ({ failures: [], restore: () => {} }),
    installGraphConfigureWatch: () => ({ restore: () => {} }),
    loadRestoreCompleted: () => true,
    retryNodeRestores: async () => ({ restored: [], failed: [], recovered: [] }),
    liteGraphGlobal: () => null,
    getGraphCtx: () => ({ graph: root, rootGraph: root }),
    describeLiveCanvasBinding: () => "bound",
    applySavedNodePresentation: () => {},
    applySavedSubgraphHostWidgets: () => {},
    decideOpenStaleness: () => ({ stale: false, reload: false }),
    describeRepaintSourceBinding: () => "unknown",
    graphRootCarriesOpenProof: () => true,
    graphRootWorkflowUuidMatches: () => true,
    graphRootReproducesStateContent: ({ rootGraph, state }) => {
      const liveValue = rootGraph?._nodes?.[0]?.widgets_values?.[0];
      const requestedValue = state?.nodes?.[0]?.widgets_values?.[0];
      const proven = liveValue === requestedValue;
      return {
        proven,
        presentationOnly: false,
        normalizedOnly: !proven,
        normalizedFields: proven ? [] : ["widgets_values"],
      };
    },
    describeGraphStateDifference: () => ({
      comparable: true,
      surfaces: ["nodes"],
      accountedSurfaces: [],
      nodeDifference: { comparable: true, sameNodeSet: true, fields: ["widgets_values"] },
    }),
    openContentDifferenceIsDefinitionsOnly: () => false,
    resolveOpenRebindVerdict: ({ contentMatches }) =>
      contentMatches ? { status: status.PROVEN } : { status: status.CONTENT_UNVERIFIED },
    describeOpenRebindOutcome: () => "content could not be verified",
    OPEN_REBIND_STATUS: status,
    GRAPH_TOOL_EXECUTORS: { graph_outline: () => null },
    settleOpenedWorkflowReadable,
    settleOwnedOpenedWorkflowActive,
    noteOpenAttempt: () => ({ seq: 1 }),
    backendSocketReplyFields: () => ({}),
    activeWorkflowUuidForOpenReply: () => uuid,
    describeOpenActiveBinding: () => ({ active_matches_target: true }),
    canvasFileDivergenceNote: () => null,
    failOpenRebindUnknown: (error) => error,
    coerceMessageText: (value) => String(value),
  });

  await assert.rejects(
    panel.method({ path: "target.json", rid: "leftover-source-widgets" }),
    /content could not be verified/,
    "normalizedOnly must not publish TARGET's fence over the previous tab's widgets",
  );
  assert.equal(root._nodes[0].widgets_values[0], "previous-value", "the leftover canvas is still SOURCE");
  assert.equal(panel.guard(), null, "the refused open still releases its reload guard");
});

test("#1639 production workflow_open remembers a switch-away-and-back during an awaited open step", async () => {
  const uuid = "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95";
  const previous = { path: "workflows/previous.json" };
  const targetState = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: ["target-value"] }],
    links: [],
    groups: [],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  const previousState = {
    nodes: [{ id: 1, type: "KSampler", widgets_values: ["previous-value"] }],
    links: [],
    groups: [],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  let captures = 0;
  const target = {
    path: "workflows/target.json",
    filename: "target.json",
    isModified: false,
    changeTracker: {
      activeState: structuredClone(targetState),
      checkState() {
        captures += 1;
        this.activeState = structuredClone(previousState);
      },
    },
  };
  let active = target;
  let loadedValue;
  const subscribers = [];
  const notifyStoreMutation = () => {
    for (const subscriber of [...subscribers]) subscriber();
  };
  const workflowPiniaStore = {
    $subscribe: (subscriber) => {
      subscribers.push(subscriber);
      return () => {
        const index = subscribers.indexOf(subscriber);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
  };
  const document = {
    getElementById: () => ({
      __vue_app__: { config: { globalProperties: { $pinia: { _s: new Map([["workflow", workflowPiniaStore]]) } } } },
    }),
    querySelector: () => null,
  };
  const root = {
    _nodes: [{ id: 1, type: "KSampler", widgets_values: ["previous-value"] }],
    extra: { comfyui_mcp: { workflow_uuid: uuid } },
  };
  const app = {
    rootGraph: root,
    graph: root,
    canvas: { graph: root },
    loadGraphData: async (state) => {
      loadedValue = state?.nodes?.[0]?.widgets_values?.[0];
      root.extra = state.extra;
      root._nodes = state.nodes.map((node) => ({ ...node }));
    },
    extensionManager: {
      workflow: {
        openWorkflows: [target],
        workflows: [],
        getWorkflowByPath: () => target,
        openWorkflow: async () => {
          notifyStoreMutation();
        },
      },
    },
  };
  const status = { PROVEN: "proven", CONTENT_UNVERIFIED: "content-unverified", UNPROVEN: "unproven" };
  const panel = productionExecutor("workflow_open", {
    backendReconnectEpoch: 4,
    activeWorkflowResyncEpoch: 4,
    postReconnectBindingProofEpoch: 4,
    app,
    document,
    activeWorkflowRef: () => active,
    sameWorkflowObject: (a, b) => a === b,
    workflowTabId: (workflow) => `wf:${workflow.path}`,
    WORKFLOW_META_NAMESPACE: "comfyui_mcp",
    WORKFLOW_UUID_FIELD: "workflow_uuid",
    WORKFLOW_PATH_FIELD: "workflow_path",
    OPEN_PROOF_FIELD: "open_proof",
    workflowObjectUuid: () => uuid,
    workflowStableUuid: () => uuid,
    workflowOwnsRootUuidTag: () => false,
    workflowUuidOwner: () => null,
    getWorkflowTitle: () => "Target",
    waitForReconnectHandshakeBeforeOpen: async () => {},
    comfyBackendIsDown: () => false,
    postReconnectBindingSettleWindow: () => false,
    nodeDefRefreshInFlight: null,
    flushSourceCanvasBeforeSwitch: async () => {},
    claimActiveWorkflowMove: () => {},
    acquireCanvasInteractionLock: () => null,
    releaseCanvasInteractionLock: () => {},
    MOVE_CAUSES: { OPEN_EXECUTOR: "workflow_open" },
    settleOpenedWorkflowTarget: async () => {
      // The target was active at the operation's start, so the endpoint comparison
      // remains equal. The epoch must still remember this complete excursion.
      active = previous;
      notifyStoreMutation();
      active = target;
      notifyStoreMutation();
      await Promise.resolve();
      return { target, loaded: false };
    },
    workflowRecordMatchesSelector: () => true,
    installNodeConfigureIsolation: () => ({ failures: [], restore: () => {} }),
    installGraphConfigureWatch: () => ({ restore: () => {} }),
    loadRestoreCompleted: () => true,
    retryNodeRestores: async () => ({ restored: [], failed: [], recovered: [] }),
    liteGraphGlobal: () => null,
    getGraphCtx: () => ({ graph: root, rootGraph: root }),
    describeLiveCanvasBinding: () => "bound",
    applySavedNodePresentation: () => {},
    applySavedSubgraphHostWidgets: () => {},
    decideOpenStaleness: () => ({ stale: false, reload: false }),
    describeRepaintSourceBinding: () => "unknown",
    graphRootCarriesOpenProof: () => true,
    graphRootWorkflowUuidMatches: () => true,
    graphRootReproducesStateContent: ({ rootGraph, state }) => ({
      proven: rootGraph?._nodes?.[0]?.widgets_values?.[0] === state?.nodes?.[0]?.widgets_values?.[0],
      presentationOnly: false,
      normalizedOnly: false,
    }),
    describeGraphStateDifference: () => ({ comparable: true, surfaces: ["nodes"], accountedSurfaces: [], nodeDifference: null }),
    openContentDifferenceIsDefinitionsOnly: () => false,
    resolveOpenRebindVerdict: ({ contentMatches }) =>
      contentMatches ? { status: status.PROVEN } : { status: status.CONTENT_UNVERIFIED },
    describeOpenRebindOutcome: () => "content could not be verified",
    OPEN_REBIND_STATUS: status,
    GRAPH_TOOL_EXECUTORS: { graph_outline: () => ({ node_count: 1, outline: "1 KSampler", detail_level: "full" }) },
    settleOpenedWorkflowReadable,
    settleOwnedOpenedWorkflowActive,
    noteOpenAttempt: () => ({ seq: 1 }),
    backendSocketReplyFields: () => ({}),
    activeWorkflowUuidForOpenReply: () => uuid,
    describeOpenActiveBinding: () => ({ active_matches_target: true }),
    canvasFileDivergenceNote: () => null,
    failOpenRebindUnknown: (error) => error,
    coerceMessageText: (value) => String(value),
  });

  const result = await panel.method({ path: "target.json", rid: "switch-away-back" });

  assert.equal(result.opened.path, target.path);
  assert.equal(loadedValue, "target-value", "the repaint still uses the target state");
  assert.equal(captures, 0, "an intervening switch invalidates the endpoint-only capture proof");
  assert.equal(panel.guard(), null, "the production open releases its reload guard");
});

test("#887 production workflow_new unknown result retires proof before returning", async () => {
  const root = {
    _nodes: [],
    extra: {},
    serialize: () => ({ nodes: [], links: [], groups: [], last_node_id: 0 }),
  };
  const workflow = {
    isPersisted: false,
    isModified: false,
    changeTracker: { activeState: { nodes: [] } },
  };
  const journal = [];
  let stamps = 0;
  const panel = productionExecutor("workflow_new", {
    backendReconnectEpoch: 4,
    activeWorkflowResyncEpoch: 4,
    postReconnectBindingProofEpoch: 4,
    app: {
      rootGraph: root,
      graph: root,
      extensionManager: { command: { execute: async () => {} } },
    },
    activeWorkflowRef: () => workflow,
    workflowTabId: () => "tmp:new-tab",
    workflowStableUuid: () => "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95",
    noteOpenAttempt: (entry) => {
      journal.push(entry);
      return { seq: journal.length };
    },
    coerceMessageText: (value) => String(value),
    getWorkflowTitle: () => "Unsaved Workflow",
    graphRootProvenEmpty: () => true,
    activeWorkflowProvenEmpty: () => false,
    stampGraphRootWorkflowUuid: () => {
      stamps += 1;
    },
    isCanonicalWorkflowInstanceUuid: (value) => typeof value === "string" && value.length === 36,
  });

  const result = await panel.method({ rid: "unknown-new" });
  assert.equal(result.created, "unknown");
  assert.equal(result.empty, "unknown");
  assert.deepEqual(panel.proofs(), {
    active: 3,
    post: 3,
  });
  assert.equal(stamps, 0, "an unproven blank state must not stamp the root");
  assert.equal(panel.guard(), null, "unknown workflow_new must release the production reload guard");
  assert.equal(journal.at(-1)?.applied, true, "the tab creation receipt remains factual");
});

test("#887 failed open proof gates the immediate list, pin, and current-mode mutation", () => {
  const reconnectEpoch = 4;
  const reconnectedAt = 100;
  const now = 150;
  const invalidEpoch = reconnectEpoch - 1;
  const active = { path: "workflows/previous.json" };
  const target = { path: "workflows/target.json" };

  // This is the post-failure state written by workflow_open before it reports unknown.
  const activeConfirmed = !activeWorkflowPossiblyStale({
    reconnectEpoch,
    resyncEpoch: invalidEpoch,
    reconnectedAt,
    now,
  });
  const bindingSettleWindow =
    activeWorkflowPossiblyStale({
      reconnectEpoch,
      resyncEpoch: invalidEpoch,
      reconnectedAt,
      now,
    }) &&
    invalidEpoch < reconnectEpoch;
  const mutationRefusal = graphMutationReconnectGate({
    cmd: "graph_set_widget",
    bindingSettleWindow,
  });

  assert.equal(activeConfirmed, false, "immediate workflow_list cannot confirm stale active proof");
  assert.equal(classifyPinnedTarget(target.path, [active.path]), "mismatch");
  assert.equal(mutationRefusal?.code, "post-reconnect-settling");
  assert.match(
    SRC.slice(
      SRC.indexOf("const activeSettle = await settleOwnedOpenedWorkflowActive({"),
      SRC.indexOf("const liveActiveAtReply = (() => {"),
    ),
    /invalidateWorkflowBindingProof\(openGeneration\)/,
    "workflow_open retires both proof epochs through the shared generation fence",
  );
  assert.match(
    SRC,
    /function invalidateWorkflowBindingProof\(generation\) \{[\s\S]*const invalidEpoch = backendReconnectEpoch - 1[\s\S]*postReconnectBindingProofEpoch = invalidEpoch;/,
    "the shared failure helper invalidates both proof epochs only for the current generation",
  );
});

test("#887 workflow_open wires the settle probe before releasing its guards", () => {
  const openAt = SRC.indexOf("async workflow_open({ path, rid }) {");
  const probeAt = SRC.indexOf("const activeSettle = await settleOwnedOpenedWorkflowActive({", openAt);
  const repaintAt = SRC.indexOf("await app.loadGraphData(repaintState, true, true, target);", openAt);
  const releaseAt = SRC.indexOf("releaseWorkflowReloadGuard(reloadGuardToken);", probeAt);
  const failAt = SRC.indexOf("throw failOpenRebindUnknown(rebindFailed);", probeAt);
  const replyObservationAt = SRC.indexOf("const liveActiveAtReply = (() => {", openAt);

  assert.ok(openAt >= 0, "workflow_open production executor is present");
  assert.ok(repaintAt >= 0 && repaintAt < probeAt, "the probe follows the production repaint");
  assert.ok(probeAt > repaintAt, "workflow_open performs the active probe after its load/proof work");
  assert.ok(releaseAt > probeAt, "the probe runs before the reload guard is released");
  assert.ok(failAt > releaseAt, "the unstable result is surfaced after cleanup, not swallowed");
  assert.ok(replyObservationAt > releaseAt, "the success reply is composed only after the settle gate");
  assert.match(
    SRC.slice(probeAt, releaseAt),
    /beginStep: \(\) => beginWorkflowReloadStep\(reloadGuardToken\)[\s\S]*ownsStep: \(\) => ownsWorkflowReloadGuard\(reloadGuardToken\)/,
    "the production probe supplies ownership callbacks",
  );
  assert.match(
    SRC.slice(probeAt, releaseAt),
    /if \(openFailed \|\| rebindFailed\) \{[\s\S]*invalidateWorkflowBindingProof\(openGeneration\)/,
    "a failed or unknown open retires proof through the shared generation fence",
  );
  assert.match(
    SRC.slice(probeAt, releaseAt),
    /rebindFailed = new Error\([\s\S]*active canvas/,
    "an unstable result follows the fail-closed rebind path",
  );
});

test("#1911 production workflow_open without $subscribe captures already-current and discloses", async () => {
  const { target, environment } = productionReadableOpenEnvironment({ readableAfterRetry: true });
  let captures = 0;
  target.changeTracker = {
    activeState: target.activeState,
    checkState() {
      captures += 1;
    },
  };
  environment.activeWorkflowRef = () => target;
  environment.app.extensionManager.workflow.openWorkflow = async () => {};
  environment.describeLiveCanvasBinding = () => "bound";

  const panel = productionExecutor("workflow_open", environment);
  const result = await panel.method({ path: target.path, rid: "no-subscribe-already-current" });

  assert.equal(result.opened.path, target.path);
  assert.equal(
    captures,
    1,
    "already-current without a watcher still captures via the pre-watch proof — silent skip is the bug",
  );
  assert.equal(result.pointer_watch_unavailable, POINTER_WATCH_UNAVAILABLE_NOTICE);
  assert.equal(panel.guard(), null);
});

test("#1911 production workflow_open without $subscribe skips switch capture, still flushes SOURCE, and discloses", async () => {
  const { target, environment } = productionReadableOpenEnvironment({ readableAfterRetry: true });
  let captures = 0;
  let flushed = 0;
  target.changeTracker = {
    activeState: target.activeState,
    checkState() {
      captures += 1;
      throw new Error("switch capture without a watcher would be the #1215 poison");
    },
  };
  environment.flushSourceCanvasBeforeSwitch = async () => {
    flushed += 1;
  };
  environment.describeLiveCanvasBinding = () => "bound";

  const panel = productionExecutor("workflow_open", environment);
  const result = await panel.method({ path: target.path, rid: "no-subscribe-switch" });

  assert.equal(result.opened.path, target.path);
  assert.equal(
    flushed,
    1,
    "#1295 SOURCE flush must still run when the watcher cannot be installed",
  );
  assert.equal(
    captures,
    0,
    "a tab switch without a pointer watch must not capture TARGET from SOURCE's canvas",
  );
  assert.equal(result.pointer_watch_unavailable, POINTER_WATCH_UNAVAILABLE_NOTICE);
  assert.equal(panel.guard(), null);
});

test("#1911 production workflow_open uses the workflow service as $subscribe fallback", async () => {
  const { target, environment } = productionReadableOpenEnvironment({ readableAfterRetry: true });
  const previous = { path: "workflows/previous.json" };
  let active = previous;
  let captures = 0;
  const subscribers = [];
  target.changeTracker = {
    activeState: target.activeState,
    checkState() {
      captures += 1;
    },
  };
  environment.activeWorkflowRef = () => active;
  environment.describeLiveCanvasBinding = () => "bound";
  environment.app.extensionManager.workflow.$subscribe = (subscriber) => {
    subscribers.push(subscriber);
    return () => {
      const index = subscribers.indexOf(subscriber);
      if (index >= 0) subscribers.splice(index, 1);
    };
  };
  environment.app.extensionManager.workflow.openWorkflow = async () => {
    active = target;
  };

  const panel = productionExecutor("workflow_open", environment);
  const result = await panel.method({ path: target.path, rid: "service-subscribe-fallback" });

  assert.equal(result.opened.path, target.path);
  assert.equal(
    captures,
    1,
    "the workflow service $subscribe is a proven watch when Pinia lookup misses",
  );
  assert.equal(result.pointer_watch_unavailable, undefined);
  assert.equal(subscribers.length, 0, "the fallback watch is cleaned up after the open");
  assert.equal(panel.guard(), null);
});
