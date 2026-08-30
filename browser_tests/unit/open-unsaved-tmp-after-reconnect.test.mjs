// #2022 — panel_open_workflow of a listed unsaved tmp: tab immediately after
// reconnect applied the switch but returned a hard error because it could not
// immediately prove the active workflow. ~7s later panel_list_workflows showed
// active_confirmed:true and last_open.applied:true for the same command.
//
// That is a verification race / false-negative, not a failed switch. When the
// open already applied a tmp: key, wait/recheck the live routing key before
// failing, and if it is still unreadable return the applied receipt rather than
// throwing. Tests below fail on the old throw-on-unknown path.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  appliedTmpOpenShouldFailClosed,
  isUnsavedTmpOpenSelector,
  settleOpenedTmpRoutingKey,
  settleOwnedOpenedTmpRoutingKey,
  settleOwnedOpenedWorkflowActive,
} from "../../web/js/lib/settle-open-active.js";
import {
  graphRootMatchesState,
  graphRootWorkflowUuidMatches,
  graphRootWorkflowUuidMismatches,
} from "../../web/js/lib/graph-binding.js";
import {
  decideLiveCanvasCapture,
  installActivePointerWatch,
  POINTER_WATCH_UNAVAILABLE_NOTICE,
} from "../../web/js/lib/live-canvas-capture-gate.js";
import {
  workflowOpenReadinessRefusalError,
  readWorkflowOpenReadinessRefusal,
} from "../../web/js/lib/reconnect-recovery.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const TMP_KEY = "tmp:11ce5a34-0a2a-4b62-9bbc-731f6f1460be";

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
  };
}

test("#2022 tmp: selector is only a canonical unsaved handle", () => {
  assert.equal(isUnsavedTmpOpenSelector(TMP_KEY), true);
  assert.equal(isUnsavedTmpOpenSelector("tmp:not-a-uuid"), false);
  assert.equal(isUnsavedTmpOpenSelector("workflows/a.json"), false);
  assert.equal(isUnsavedTmpOpenSelector("Unsaved Workflow"), false);
  assert.equal(isUnsavedTmpOpenSelector(null), false);
});

test("#2022 fail-closed only on a POSITIVE routing-key mismatch", () => {
  assert.equal(appliedTmpOpenShouldFailClosed({ routingSettle: { status: "different" } }), true);
  assert.equal(appliedTmpOpenShouldFailClosed({ routingSettle: { status: "unknown" } }), false);
  assert.equal(appliedTmpOpenShouldFailClosed({ routingSettle: { status: "settled" } }), false);
  assert.equal(appliedTmpOpenShouldFailClosed({ routingSettle: { status: "superseded" } }), false);
  assert.equal(appliedTmpOpenShouldFailClosed({}), false);
});

test("#2022 delayed tmp: routing-key proof settles instead of failing closed", async () => {
  const clock = fakeClock();
  const target = { routingKey: TMP_KEY };
  let active = null;
  const result = await settleOpenedTmpRoutingKey({
    requestedKey: TMP_KEY,
    readActive: () => active,
    workflowTabId: (wf) => wf?.routingKey ?? null,
    wait: async (ms) => {
      await clock.wait(ms);
      if (clock.now() >= 50) active = target;
    },
    now: clock.now,
    budgetMs: 200,
    pollMs: 25,
  });
  assert.equal(result.status, "settled");
  assert.equal(result.routingKey, TMP_KEY);
  assert.ok(clock.now() >= 50, "the probe must wait rather than fail the first unreadable read");
});

test("#2022 an unreadable tmp: routing key stays unknown, never different", async () => {
  const clock = fakeClock();
  const result = await settleOpenedTmpRoutingKey({
    requestedKey: TMP_KEY,
    readActive: () => null,
    workflowTabId: () => {
      throw new Error("must not mint");
    },
    wait: clock.wait,
    now: clock.now,
    budgetMs: 40,
    pollMs: 20,
  });
  assert.equal(result.status, "unknown");
  assert.equal(appliedTmpOpenShouldFailClosed({ routingSettle: result }), false);
});

test("#2022 a different live routing key is a real mismatch", async () => {
  const clock = fakeClock();
  const result = await settleOpenedTmpRoutingKey({
    requestedKey: TMP_KEY,
    readActive: () => ({ routingKey: "tmp:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    workflowTabId: (wf) => wf.routingKey,
    wait: clock.wait,
    now: clock.now,
    budgetMs: 20,
    pollMs: 10,
  });
  assert.equal(result.status, "different");
  assert.equal(appliedTmpOpenShouldFailClosed({ routingSettle: result }), true);
});

test("#2022 routing-key probe must not treat a minted handle as evidence", async () => {
  const clock = fakeClock();
  let minted = 0;
  const result = await settleOpenedTmpRoutingKey({
    requestedKey: TMP_KEY,
    readActive: () => ({}),
    workflowTabId: () => {
      minted += 1;
      return minted === 1 ? null : "tmp:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    },
    wait: clock.wait,
    now: clock.now,
    budgetMs: 20,
    pollMs: 10,
  });
  assert.notEqual(result.status, "settled", "a freshly minted tmp: id is not the listed tab");
});

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

const RELOAD_GUARD_SOURCE = SRC.match(
  /let workflowReloadGuard = null;[\s\S]*?function activeWorkflowReloadGuard\(\) \{[\s\S]*?\n\}/,
);
assert.ok(RELOAD_GUARD_SOURCE, "could not locate the production reload guard block");
const PINIA_STORE_HELPER_SOURCE = balancedFrom(SRC, "function getPiniaStore(id)");

function productionOpen(environment) {
  const signature = "async workflow_open({";
  const sigStart = SRC.indexOf(signature);
  assert.notEqual(sigStart, -1, "workflow_open not found");
  const bodyBrace = SRC.indexOf(") {", sigStart) + 1;
  const methodSource = balancedFrom(SRC, signature, bodyBrace).replace(
    /^async workflow_open\(/,
    "async function workflow_open(",
  );
  const factory = new Function(
    "sandbox",
    `with (sandbox) {\n${RELOAD_GUARD_SOURCE[0]}\n${PINIA_STORE_HELPER_SOURCE}\n${methodSource}\n` +
      `return { method: workflow_open, proofs: () => ({ active: activeWorkflowResyncEpoch, post: postReconnectBindingProofEpoch }) };\n}`,
  );
  const sandbox = {
    decideLiveCanvasCapture,
    installActivePointerWatch,
    POINTER_WATCH_UNAVAILABLE_NOTICE,
    workflowOpenReadinessRefusalError,
    readWorkflowOpenReadinessRefusal,
    graphRootMatchesState,
    graphRootWorkflowUuidMatches,
    graphRootWorkflowUuidMismatches,
    isUnsavedTmpOpenSelector,
    appliedTmpOpenShouldFailClosed,
    settleOwnedOpenedWorkflowActive,
    settleOwnedOpenedTmpRoutingKey,
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

function tmpOpenEnvironment({ routingSettle, objectSettle = { status: "unknown" } }) {
  const target = {
    path: "Unsaved Workflow",
    filename: "Unsaved Workflow",
    isPersisted: false,
    isTemporary: true,
    isModified: false,
    routingKey: TMP_KEY,
    changeTracker: { activeState: { nodes: [], links: [], groups: [], last_node_id: 0 } },
  };
  const receipts = [];
  const root = { _nodes: [], extra: {}, serialize: () => ({ nodes: [], links: [], groups: [] }) };
  let active = target;
  const uuid = "c2512bcc-6a89-4b9f-a58c-ff48a2eb7e95";
  return {
    target,
    receipts,
    environment: {
      backendReconnectEpoch: 4,
      activeWorkflowResyncEpoch: 3,
      postReconnectBindingProofEpoch: 3,
      app: {
        rootGraph: root,
        graph: root,
        canvas: {},
        loadGraphData: async () => {},
        extensionManager: {
          workflow: {
            openWorkflows: [target],
            workflows: [],
            getWorkflowByPath: () => null,
            openWorkflow: async () => {
              active = target;
            },
          },
        },
      },
      activeWorkflowRef: () => active,
      sameWorkflowObject: (a, b) => a === b,
      workflowTabId: () => TMP_KEY,
      readExistingWorkflowTabId: (wf) => wf?.routingKey ?? null,
      workflowRecordMatchesSelector: (_w, sel) => sel === TMP_KEY,
      waitForReconnectHandshakeBeforeOpen: async () => "ready",
      comfyBackendIsDown: () => false,
      postReconnectBindingSettleWindow: () => false,
      nodeDefRefreshInFlight: null,
      flushSourceCanvasBeforeSwitch: async () => {},
      claimActiveWorkflowMove: () => {},
      acquireCanvasInteractionLock: () => "lock",
      releaseCanvasInteractionLock: () => {},
      MOVE_CAUSES: { OPEN_EXECUTOR: "workflow_open" },
      settleOpenedWorkflowTarget: async () => ({ target, loaded: false }),
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
      clearSpuriousOpenModified: async () => {},
      withDeadline: async (promise) => promise,
      staleReadFlight: { run: (_key, start) => start() },
      workflowDiskContent: async () => null,
      canvasFileDivergence: () => null,
      OPEN_DISK_READ_BUDGET_MS: 1,
      describeRepaintSourceBinding: () => "unknown",
      graphRootCarriesOpenProof: () => true,
      graphRootWorkflowUuidMatches: () => true,
      graphRootReproducesStateContent: () => ({ proven: true, presentationOnly: false, normalizedOnly: false, exact: true }),
      describeGraphStateDifference: () => ({ comparable: true, surfaces: [], accountedSurfaces: [], nodeDifference: null }),
      openContentDifferenceIsDefinitionsOnly: () => false,
      resolveOpenRebindVerdict: () => ({ status: "proven" }),
      describeOpenRebindOutcome: () => "",
      OPEN_REBIND_STATUS: { PROVEN: "proven", CONTENT_UNVERIFIED: "content-unverified", UNPROVEN: "unproven" },
      GRAPH_TOOL_EXECUTORS: { graph_outline: () => ({ node_count: 0, outline: "", detail_level: "full" }) },
      settleOpenedWorkflowReadable: async () => ({ status: "settled-readable" }),
      settleOwnedOpenedWorkflowActive: async () => objectSettle,
      settleOwnedOpenedTmpRoutingKey: async () => routingSettle,
      noteOpenAttempt: (entry) => {
        receipts.push(entry);
        return { seq: receipts.length, ...entry };
      },
      backendSocketReplyFields: () => ({}),
      activeWorkflowUuidForOpenReply: () => uuid,
      describeOpenActiveBinding: ({ targetRoutingKey, activeRoutingKey }) => ({
        active_routing_key: activeRoutingKey ?? null,
        active_matches_target: targetRoutingKey && activeRoutingKey ? targetRoutingKey === activeRoutingKey : null,
      }),
      canvasFileDivergenceNote: () => null,
      failOpenRebindUnknown: (error) => error,
      coerceMessageText: (value) => String(value ?? ""),
      workflowObjectUuid: () => uuid,
      workflowStableUuid: () => uuid,
      WORKFLOW_META_NAMESPACE: "comfyui_mcp",
      WORKFLOW_UUID_FIELD: "workflow_uuid",
      WORKFLOW_PATH_FIELD: "workflow_path",
      OPEN_PROOF_FIELD: "open_proof",
    },
  };
}

test("#2022 production workflow_open succeeds when tmp: routing key lands after an unknown object settle", async () => {
  const { receipts, environment } = tmpOpenEnvironment({
    objectSettle: { status: "unknown", reason: "active workflow was unreadable" },
    routingSettle: { status: "settled", routingKey: TMP_KEY },
  });
  const panel = productionOpen(environment);
  const result = await panel.method({ path: TMP_KEY, rid: "rid-2022-settled" });
  assert.equal(result.routing_key, TMP_KEY);
  assert.equal(result.opened.path, null, "a tmp: open must not report a native unsaved path as a filename alias");
  assert.equal(result.opened.filename, null);
  assert.equal(result.opened.routing_key, TMP_KEY);
  assert.equal(receipts.at(-1)?.applied, true);
  assert.deepEqual(panel.proofs(), { active: 4, post: 4 });
});

test("#2022 production workflow_open does not throw when an applied tmp: switch is still unreadable", async () => {
  const { receipts, environment } = tmpOpenEnvironment({
    objectSettle: { status: "unknown", reason: "active workflow was unreadable" },
    routingSettle: { status: "unknown", reason: "active routing key was unreadable" },
  });
  const panel = productionOpen(environment);
  const result = await panel.method({ path: TMP_KEY, rid: "rid-2022-unknown" });
  assert.equal(result.routing_key, TMP_KEY);
  assert.equal(result.opened.path, null);
  assert.equal(receipts.at(-1)?.applied, true, "the switch applied; do not journal a failure");
  assert.equal(receipts.at(-1)?.error, undefined);
  assert.deepEqual(
    panel.proofs(),
    { active: 4, post: 3 },
    "list confirmation may close; the mutation gate stays closed until the bind is proven",
  );
});

test("#2022 production workflow_open still fails closed on a different tmp: routing key", async () => {
  const { receipts, environment } = tmpOpenEnvironment({
    objectSettle: { status: "unknown" },
    routingSettle: { status: "different", routingKey: "tmp:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  });
  const panel = productionOpen(environment);
  await assert.rejects(
    () => panel.method({ path: TMP_KEY, rid: "rid-2022-different" }),
    /did not leave the requested workflow as the stable active canvas/,
  );
  assert.equal(receipts.at(-1)?.applied, "unknown");
});

test("#2022 wiring: workflow_open rechecks tmp: routing key before the hard error", () => {
  const openAt = SRC.indexOf("async workflow_open({ path, rid }) {");
  const objectSettleAt = SRC.indexOf("const activeSettle = await settleOwnedOpenedWorkflowActive({", openAt);
  const tmpSettleAt = SRC.indexOf("tmpRoutingSettle = await settleOwnedOpenedTmpRoutingKey({", openAt);
  const failAt = SRC.indexOf("throw failOpenRebindUnknown(rebindFailed);", openAt);
  const openedAt = SRC.indexOf("opened: {", tmpSettleAt);
  assert.ok(objectSettleAt > openAt);
  assert.ok(tmpSettleAt > objectSettleAt, "the routing-key recheck follows the object settle");
  assert.ok(failAt > tmpSettleAt, "do not throw before the tmp: recheck");
  assert.match(
    SRC.slice(tmpSettleAt, failAt),
    /readExistingWorkflowTabId/,
    "the recheck must read existing tmp: handles, never mint a new one",
  );
  assert.match(
    SRC.slice(tmpSettleAt, failAt),
    /tmpOpenAppliedUnproven/,
    "an applied tmp: open that is still unreadable must not take the hard-error path",
  );
  assert.match(
    SRC.slice(openedAt, openedAt + 500),
    /openedForTmp \? null : target\.path/,
    "tmp: replies must not publish a native unsaved path as opened.path",
  );
});

test("#2022 wiring: panel imports the shipped tmp: helpers, not a local copy", () => {
  assert.match(
    SRC,
    /import \{[\s\S]*?appliedTmpOpenShouldFailClosed,[\s\S]*?isUnsavedTmpOpenSelector,[\s\S]*?settleOwnedOpenedTmpRoutingKey,[\s\S]*?settleOwnedOpenedWorkflowActive,[\s\S]*?\} from "\.\/lib\/settle-open-active\.js"/,
  );
});
