// Regression coverage for #1810. These tests execute the shipped panel callbacks
// extracted from web/js/comfyui-mcp-panel.js. A parallel helper-only model would miss
// the production ordering that swaps SESSION_KEY/re-hello while a turn is live.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createComfyBackendOutageTracker } from "../../web/js/lib/session-rebind.js";

const PANEL_PATH = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const PANEL = readFileSync(PANEL_PATH, "utf8").replace(/\r\n/g, "\n");

function methodSource(signature) {
  const start = PANEL.indexOf(signature);
  assert.notEqual(start, -1, `missing production callback ${signature}`);
  const bodyStart = PANEL.indexOf(") {", start);
  assert.notEqual(bodyStart, -1, `missing body for production callback ${signature}`);
  const open = bodyStart + 1;
  let depth = 0;
  for (let i = open; i < PANEL.length; i += 1) {
    if (PANEL[i] === "{") depth += 1;
    if (PANEL[i] === "}" && --depth === 0) return PANEL.slice(start, i + 1);
  }
  assert.fail(`unbalanced production callback ${signature}`);
}

const WORKFLOW_CHANGED = methodSource("function onWorkflowMaybeChanged() {");
const COMPLETE_DEDICATED_SWAP = methodSource("function completeDedicatedWorkflowSessionSwap(");
const ON_ACK = methodSource("onAck(ack) {");

function buildWorkflowChanged({ working, followsPanel = false } = {}) {
  const deferred = [];
  const wf = { key: "new-workflow.json", filename: "new-workflow.json" };
  const onWorkflowMaybeChanged = new Function(
    "activeWorkflowRef",
    "workflowTabId",
    "currentWorkflowId",
    "historyScopeFollowsPanel",
    "agentWorking",
    "deferDedicatedWorkflowSwitch",
    `${WORKFLOW_CHANGED}\nreturn onWorkflowMaybeChanged;`,
  )(
    () => wf,
    () => "wf:new-workflow.json",
    "wf:old-workflow.json",
    () => followsPanel,
    working,
    (...args) => deferred.push(args),
  );
  return { onWorkflowMaybeChanged, deferred, wf };
}

test("#1810 production workflow poll defers a dedicated session swap during the calling turn", () => {
  const { onWorkflowMaybeChanged, deferred, wf } = buildWorkflowChanged({ working: true });

  onWorkflowMaybeChanged();

  assert.deepEqual(deferred, [[wf, "wf:new-workflow.json", "new-workflow.json"]]);
  // The real branch returns before the legacy SESSION_KEY/re-hello/session-load
  // block. The injected defer callback is the only operation it is allowed to make.
});

function buildDedicatedSwap({ pending = true, working = false, existing = true } = {}) {
  const events = [];
  const state = { pending, ackPending: true, thread: existing ? { id: "new-chat", sessionId: "session-new" } : null };
  const complete = new Function(
    "historyScopeFollowsPanel",
    "agentWorking",
    "pendingDedicatedWorkflowSwap",
    "dedicatedWorkflowSwapAckPending",
    "workflowStorageKey",
    "threadForWorkflow",
    "ssSet",
    "SESSION_KEY",
    "rehelloForWorkflow",
    "loadThread",
    "thread",
    "CURRENT_THREAD_KEY",
    "resetFeed",
    "client",
    "getWorkflowTitle",
    "appendSystem",
    "tr",
    "refreshContextRingForScope",
    `${COMPLETE_DEDICATED_SWAP}\nreturn { completeDedicatedWorkflowSessionSwap, state: () => ({ pendingDedicatedWorkflowSwap, dedicatedWorkflowSwapAckPending, thread }) };`,
  )(
    () => false,
    working,
    state.pending,
    state.ackPending,
    () => "new-workflow.json",
    () => state.thread,
    (key, value) => events.push(["storage", key, value]),
    "comfyui-mcp.panel.sessionId",
    (sessionId) => events.push(["rehello", sessionId]),
    (threadValue) => events.push(["load", threadValue.id]),
    state.thread,
    "comfyui-mcp.panel.currentThreadId",
    () => events.push(["reset"]),
    { armContext: () => events.push(["context"]) },
    () => "new-workflow.json",
    (text) => events.push(["system", text]),
    (_key, fallback) => fallback,
    () => events.push(["refresh"]),
  );
  return { complete, events };
}

test("#1810 terminal production swap binds the dedicated session only after the turn ends", () => {
  const { complete, events } = buildDedicatedSwap();

  assert.equal(complete.completeDedicatedWorkflowSessionSwap({ announce: true }), true);
  assert.deepEqual(complete.state(), { pendingDedicatedWorkflowSwap: false, dedicatedWorkflowSwapAckPending: false, thread: { id: "new-chat", sessionId: "session-new" } });
  assert.deepEqual(events, [
    ["storage", "comfyui-mcp.panel.sessionId", "session-new"],
    ["rehello", "session-new"],
    ["load", "new-chat"],
    ["system", "Switched workflow tab — this chat is dedicated to the new workflow after the previous turn finished."],
    ["refresh"],
  ]);
});

test("#1810 does not complete the dedicated swap while the turn is still working", () => {
  const { complete, events } = buildDedicatedSwap({ working: true });

  assert.equal(complete.completeDedicatedWorkflowSessionSwap(), false);
  assert.deepEqual(events, []);
});

function buildAck({ outageMs = 0, rebootPending = false } = {}) {
  const mids = new Map([
    ["mid", "1"],
    ["reboot", rebootPending ? "1" : null],
    ["soft", null],
    ["pending-reset", null],
  ]);
  const sent = [];
  let swapAckPending = true;
  let rebootHandlerCalls = 0;
  const onAck = new Function(
    "cmcpOauthOnAck",
    "onRebootResumeReceipt",
    "markReceived",
    "markRead",
    "ack",
    "readyAckCanPromoteBackend",
    "connectedBackend",
    "piBackendsReadinessReceived",
    "backendReady",
    "readinessFromOrchestrator",
    "anyReady",
    "onboard",
    "renderBackendChips",
    "knownBackends",
    "PENDING_SESSION_RESET_KEY",
    "ssGet",
    "ssSet",
    "historyMeta",
    "currentHistoryScopeKey",
    "resolvePanelPointer",
    "client",
    "REBOOT_KEY",
    "handleRebootResumeAck",
    "SOFT_RELOAD_KEY",
    "MID_TASK_KEY",
    "appendSystem",
    "tr",
    "dedicatedWorkflowSwapAckPending",
    "bridgeOutage",
    "shouldNudgeAfterMidTaskReconnect",
    "showThinking",
    "pinTurnOwnerAtDispatch",
    `const callbacks = { ${ON_ACK} };\nreturn callbacks.onAck;`,
  )(
    () => {},
    () => {},
    () => {},
    () => {},
    undefined,
    () => false,
    null,
    false,
    {},
    false,
    false,
    {},
    () => {},
    [],
    "pending-reset",
    (key) => mids.get(key) ?? null,
    (key, value) => mids.set(key, value),
    {},
    () => "workflow:new",
    () => ({ activeId: null, cleared: false }),
    { sendFrame: (frame) => sent.push(["frame", frame]), sendUserMessage: (message) => { sent.push(["user", message]); return true; } },
    "reboot",
    () => { rebootHandlerCalls += 1; return true; },
    "soft",
    "mid",
    () => {},
    (_key, fallback) => fallback,
    swapAckPending,
    { outageMs: () => outageMs },
    ({ outageMs: measured }) => measured >= 6000,
    () => {},
    () => {},
  );
  return { onAck, sent, mids, get swapAckPending() { return swapAckPending; }, rebootHandlerCalls: () => rebootHandlerCalls };
}

test("#1810 ready from the deliberate session rebind does not inject a false resume turn", () => {
  const ack = buildAck();
  ack.onAck({ kind: "ready" });
  assert.deepEqual(ack.sent, []);
  assert.equal(ack.mids.get("mid"), "1", "the live turn marker remains armed until turn:done");
});

test("#1810 real bridge outage still reaches the existing mid-turn recovery nudge", () => {
  const ack = buildAck({ outageMs: 7000 });
  ack.onAck({ kind: "ready" });
  assert.equal(ack.sent.length, 1, "the existing recovery user message is preserved");
  assert.equal(ack.sent[0][0], "user");
  assert.match(ack.sent[0][1], /agent connection dropped mid-task/);
  assert.doesNotMatch(ack.sent[0][1], /ComfyUI was restarted/);
});

test("#1810 explicit REBOOT_KEY recovery remains authoritative over the swap guard", () => {
  const ack = buildAck({ rebootPending: true });
  ack.onAck({ kind: "ready" });
  assert.equal(ack.rebootHandlerCalls(), 1);
  assert.deepEqual(ack.sent, []);
});

test("#1810 real ComfyUI saw_down/up evidence remains distinct from a live rebind", () => {
  let now = 1000;
  const outage = createComfyBackendOutageTracker({ now: () => now });
  outage.noteDown(4);
  now = 8000;
  outage.noteUp();
  assert.equal(outage.outageMs(), 7000);
  assert.equal(outage.helloBaseline(), 4);

  const benign = createComfyBackendOutageTracker({ now: () => now });
  benign.noteUp();
  assert.equal(benign.outageMs(), 0, "an up event without saw_down is not a restart cycle");
});
