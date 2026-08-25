// Regression coverage for #1810. These tests execute the shipped panel callbacks
// extracted from web/js/comfyui-mcp-panel.js. A parallel helper-only model would miss
// the production ordering that swaps SESSION_KEY/re-hello while a turn is live.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createBridgeOutageTracker,
  createComfyBackendOutageTracker,
} from "../../web/js/lib/session-rebind.js";

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
const SETTLE_CANCELLED_SWAP = methodSource("function settlePendingDedicatedWorkflowSwapAfterCancellation() {");
const NOTE_DEDICATED_HELLO = methodSource("function noteDedicatedWorkflowHello(context) {");
const ON_ACK = methodSource("onAck(ack) {");
const END_TURN_LOCALLY = methodSource("function endTurnLocally() {");
const THINKING_SAFETY = methodSource("function onThinkingSafety() {");

const CHAT_SCOPE_MODE = methodSource("function chatScopeMode(backend) {");
const HISTORY_SCOPE = methodSource("function historyScopeFollowsPanel() {");

function productionHistoryScopeFor(backend) {
  const chatScopeMode = new Function(`${CHAT_SCOPE_MODE}\nreturn chatScopeMode;`)();
  return new Function(
    "chatScopeMode",
    "connectedBackend",
    "selectedBackend",
    `${HISTORY_SCOPE}\nreturn historyScopeFollowsPanel;`,
  )(chatScopeMode, backend, backend);
}

function buildWorkflowChanged({ working, backend = "grok" } = {}) {
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
    productionHistoryScopeFor(backend),
    working,
    (...args) => deferred.push(args),
  );
  return { onWorkflowMaybeChanged, deferred, wf };
}

test("#1810 production workflow poll defers a dedicated session swap during the calling turn", () => {
  assert.equal(productionHistoryScopeFor("grok")(), false);
  assert.equal(productionHistoryScopeFor("claude")(), true);
  const { onWorkflowMaybeChanged, deferred, wf } = buildWorkflowChanged({ working: true, backend: "grok" });

  onWorkflowMaybeChanged();

  assert.deepEqual(deferred, [[wf, "wf:new-workflow.json", "new-workflow.json"]]);
  // The real branch returns before the legacy SESSION_KEY/re-hello/session-load
  // block. The injected defer callback is the only operation it is allowed to make.
});

test("#1810 production scope state keeps non-Grok providers panel-owned", () => {
  assert.equal(productionHistoryScopeFor("claude")(), true);
});

function buildDedicatedSwap({ pending = true, working = false, existing = true } = {}) {
  const events = [];
  const state = { pending, ackPending: { token: "swap-1", landed: true }, thread: existing ? { id: "new-chat", sessionId: "session-new" } : null };
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
    `${COMPLETE_DEDICATED_SWAP}\n${SETTLE_CANCELLED_SWAP}\nreturn { completeDedicatedWorkflowSessionSwap, settlePendingDedicatedWorkflowSwapAfterCancellation, state: () => ({ pendingDedicatedWorkflowSwap, dedicatedWorkflowSwapAckPending, thread }) };`,
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
  return { complete: complete.completeDedicatedWorkflowSessionSwap, settle: complete.settlePendingDedicatedWorkflowSwapAfterCancellation, state: complete.state, events };
}

test("#1810 terminal production swap binds the dedicated session only after the turn ends", () => {
  const { complete, state, events } = buildDedicatedSwap();

  assert.equal(complete({ announce: true }), true);
  assert.deepEqual(state(), { pendingDedicatedWorkflowSwap: false, dedicatedWorkflowSwapAckPending: null, thread: { id: "new-chat", sessionId: "session-new" } });
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

  assert.equal(complete(), false);
  assert.deepEqual(events, []);
});

function buildHelloCorrelation(pending = { token: "swap-1", landed: false }) {
  return new Function(
    "dedicatedWorkflowSwapAckPending",
    `${NOTE_DEDICATED_HELLO}\nreturn { noteDedicatedWorkflowHello, state: () => dedicatedWorkflowSwapAckPending };`,
  )(pending);
}

test("#1810 only the deliberate hello can arm the dedicated ready-ack guard", () => {
  const hello = buildHelloCorrelation();
  hello.noteDedicatedWorkflowHello({ dedicatedWorkflowSwap: "other-swap" });
  assert.equal(hello.state(), null, "an unrelated hello invalidates the pending correlation");

  const deliberate = buildHelloCorrelation();
  deliberate.noteDedicatedWorkflowHello({ dedicatedWorkflowSwap: "swap-1" });
  assert.deepEqual(deliberate.state(), { token: "swap-1", landed: true });

  const afterReady = buildHelloCorrelation({ token: "swap-1", landed: true, ready: true });
  afterReady.noteDedicatedWorkflowHello();
  assert.deepEqual(
    afterReady.state(),
    { token: "swap-1", landed: true, ready: true },
    "an unrelated re-hello after the tagged ready must not consume the recovery guard",
  );
});

function buildAck({ outageMs = 0, rebootPending = false, swapLanded = true, swapPending = true } = {}) {
  const mids = new Map([
    ["mid", "1"],
    ["reboot", rebootPending ? "1" : null],
    ["soft", null],
    ["pending-reset", null],
  ]);
  const sent = [];
  const clock = { value: 1000 };
  const bridgeOutage = createBridgeOutageTracker({ now: () => clock.value });
  const startBridgeOutage = (durationMs) => {
    bridgeOutage.noteBridgeClosed();
    clock.value = 1000 + durationMs;
  };
  const finishBridgeReconnect = () => bridgeOutage.noteHandshake();
  if (outageMs > 0) {
    startBridgeOutage(outageMs);
    finishBridgeReconnect();
  }
  let swapAckPending = swapPending ? { token: "swap-1", landed: swapLanded } : null;
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
    bridgeOutage,
    ({ outageMs: measured }) => measured >= 6000,
    () => {},
    () => {},
  );
  return {
    onAck,
    sent,
    mids,
    startBridgeOutage,
    finishBridgeReconnect,
    get swapAckPending() { return swapAckPending; },
    rebootHandlerCalls: () => rebootHandlerCalls,
  };
}

test("#1810 ready from the deliberate session rebind does not inject a false resume turn", () => {
  const ack = buildAck();
  ack.onAck({ kind: "ready" });
  assert.deepEqual(ack.sent, []);
  assert.equal(ack.mids.get("mid"), "1", "the live turn marker remains armed until turn:done");
});

test("#1810 tagged ready then unrelated ready preserves recovery until a real outage reconnect", () => {
  const ack = buildAck();

  // The first ready is the deliberately tagged dedicated-session rebind.
  ack.onAck({ kind: "ready" });
  // A later live-socket re-hello (the free_vram/self-heal shape) is unrelated.
  ack.onAck({ kind: "ready" });
  assert.deepEqual(ack.sent, []);
  assert.equal(ack.mids.get("mid"), "1", "an unrelated healthy ready cannot consume MID_TASK_KEY");
  assert.deepEqual(ack.swapAckPending, { token: "swap-1", landed: true, ready: true });

  // Only the ready that closes a measured outage may enter the existing recovery path.
  ack.startBridgeOutage(7000);
  ack.finishBridgeReconnect();
  ack.onAck({ kind: "ready" });
  assert.equal(ack.mids.get("mid"), null);
  assert.equal(ack.sent.length, 1);
  assert.equal(ack.sent[0][0], "user");
  assert.match(ack.sent[0][1], /agent connection dropped mid-task/);
  assert.doesNotMatch(ack.sent[0][1], /ComfyUI was restarted/);
});

test("#1810 a normal uncorrelated live re-hello preserves an in-flight recovery marker", () => {
  const ack = buildAck({ swapPending: false });
  ack.onAck({ kind: "ready" });
  assert.deepEqual(ack.sent, [], "a normal re-hello must not inject a resume turn");
  assert.equal(ack.mids.get("mid"), "1", "the marker remains for a later real outage");
});

test("#1810 real bridge outage still reaches the existing mid-turn recovery nudge", () => {
  const ack = buildAck({ outageMs: 7000 });
  ack.onAck({ kind: "ready" });
  assert.equal(ack.sent.length, 1, "the existing recovery user message is preserved");
  assert.equal(ack.sent[0][0], "user");
  assert.match(ack.sent[0][1], /agent connection dropped mid-task/);
  assert.doesNotMatch(ack.sent[0][1], /ComfyUI was restarted/);
});

test("#1810 an unlanded deliberate hello cannot suppress real outage recovery", () => {
  const ack = buildAck({ outageMs: 7000, swapLanded: false });
  ack.onAck({ kind: "ready" });
  assert.equal(ack.sent.length, 1);
  assert.equal(ack.sent[0][0], "user");
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

function buildCancellationSettlement() {
  const built = buildDedicatedSwap({ existing: false });
  return {
    settle: built.settle,
    state: () => {
      const current = built.state();
      return {
        pendingDedicatedWorkflowSwap: current.pendingDedicatedWorkflowSwap,
        dedicatedWorkflowSwapAckPending: current.dedicatedWorkflowSwapAckPending,
      };
    },
  };
}

function buildEndTurnForCancellation(settle) {
  const events = [];
  const endTurnLocally = new Function(
    "agentWorking",
    "localEndAt",
    "Date",
    "ssSet",
    "MID_TASK_KEY",
    "settlePendingDedicatedWorkflowSwapAfterCancellation",
    "hideThinking",
    `${END_TURN_LOCALLY}\nreturn endTurnLocally;`,
  )(
    true,
    null,
    { now: () => 1234 },
    (key, value) => events.push(["storage", key, value]),
    "mid",
    () => {
      events.push(["settle"]);
      settle();
    },
    () => events.push(["hide"]),
  );
  return { endTurnLocally, events };
}

for (const input of ["Escape", "Ctrl+C"]) {
  test(`#1810 ${input} cancellation settles the pending dedicated swap`, () => {
    const settlement = buildCancellationSettlement();
    const { endTurnLocally, events } = buildEndTurnForCancellation(settlement.settle);
    endTurnLocally();
    assert.deepEqual(events, [["storage", "mid", null], ["settle"], ["hide"]]);
    assert.deepEqual(settlement.state(), { pendingDedicatedWorkflowSwap: false, dedicatedWorkflowSwapAckPending: null });
  });
}

test("#1810 safety-timeout cancellation settles the pending dedicated swap", () => {
  const settlement = buildCancellationSettlement();
  const events = [];
  const onThinkingSafety = new Function(
    "thinkingSafety",
    "Date",
    "lastActivityAt",
    "MAX_SILENT_TURN_MS",
    "agentWorking",
    "thinkingEl",
    "showThinking",
    "THINKING_SAFETY_MS",
    "setTimeout",
    "ssSet",
    "MID_TASK_KEY",
    "settlePendingDedicatedWorkflowSwapAfterCancellation",
    "hideThinking",
    `${THINKING_SAFETY}\nreturn onThinkingSafety;`,
  )(
    "timer",
    { now: () => 10_000 },
    0,
    100,
    true,
    {},
    () => {},
    120_000,
    () => "timer",
    (key, value) => events.push(["storage", key, value]),
    "mid",
    () => {
      events.push(["settle"]);
      settlement.settle();
    },
    () => events.push(["hide"]),
  );
  onThinkingSafety();
  assert.deepEqual(events, [["storage", "mid", null], ["settle"], ["hide"]]);
  assert.deepEqual(settlement.state(), { pendingDedicatedWorkflowSwap: false, dedicatedWorkflowSwapAckPending: null });
});

test("#1810 production interrupt wiring routes Esc and Ctrl+C through endTurnLocally", () => {
  const start = PANEL.indexOf("function onInterruptKeydown(ev) {");
  const end = PANEL.indexOf("\n  }\n  document.addEventListener(\"keydown\", onInterruptKeydown", start);
  assert.ok(start >= 0 && end > start);
  const body = PANEL.slice(start, end);
  assert.match(body, /const isCopy = .*ev\.key === \"c\"/s);
  assert.match(body, /const isEsc = ev\.key === \"Escape\"/);
  assert.match(body, /endTurnLocally\(\);/);
});
