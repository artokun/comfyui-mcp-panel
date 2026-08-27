// #1641 — the first panel_open_workflow of the already-active workflow after a
// ComfyUI restart must succeed (or wait for handshake) instead of a content
// mismatch / fence-not-cleared error that only a retry clears.
//
// THE REPORT. After a controlled restart, panel_list_workflows named the
// intended active workflow, then the first panel_open_workflow for that same
// path returned:
//
//   workflow_open RAN and the canvas IS bound … the graph on it does not match
//   the state that was loaded … FENCE: NOT cleared (active identity UNCONFIRMED
//   after reconnect handshake).
//
// The next retry succeeded without changing the workflow.
//
// THE MECHANISM. workflow_open is exempt from the #646 mutation gate (it is
// the documented recovery for a restore that never settles), so it ran during
// the post-restart window: backend socket still coming up, the node-def refresh
// kicked on `reconnected` still in flight, canvas binding not yet re-proven.
// loadGraphData then compared content against a canvas the restore was still
// rewriting. CONTENT_UNVERIFIED throws, publishes no workflow_uuid, and
// `active_confirmed` stays false until a successful open — so the orchestrator
// handshake cannot confirm either. Waiting HERE, before the freeze and the
// load, makes the first open the one that succeeds.
//
// Tests drive the shipped wait (`waitForReconnectHandshakeBeforeOpen`) — the
// function workflow_open now calls on this path — and pin the panel wiring so
// deleting the await, moving it past the freeze, or dropping a handshake
// signal fails here. Cadence is the shipped steps, never restated.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  OPEN_RECONNECT_HANDSHAKE_STEPS_MS,
  waitForReconnectHandshakeBeforeOpen,
  workflowOpenReadinessRefusalError,
  readWorkflowOpenReadinessRefusal,
} from "../../web/js/lib/reconnect-recovery.js";
import { installActivePointerWatch } from "../../web/js/lib/live-canvas-capture-gate.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

function handlerBody(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return "";
  const after = start + sig.length;
  const m = src.slice(after).match(/\n {2}(?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  return src.slice(start, m ? after + m.index : src.length);
}

const OPEN_BODY = handlerBody(SRC, "async workflow_open({");

function recordSleep() {
  const slept = [];
  return {
    slept,
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
}

// ---------------------------------------------------------------------------
// The shipped wait
// ---------------------------------------------------------------------------

test("#1641 a settled tab does not wait — the common path pays nothing", async () => {
  const { slept, sleep } = recordSleep();
  const outcome = await waitForReconnectHandshakeBeforeOpen({
    needsWait: () => false,
    isReady: () => true,
    sleep,
  });
  assert.equal(outcome, "ready");
  assert.deepEqual(slept, [], "no handshake in flight means no sleep");
});

test("#1641 a handshake that is already ready does not sleep", async () => {
  const { slept, sleep } = recordSleep();
  const outcome = await waitForReconnectHandshakeBeforeOpen({
    needsWait: () => true,
    isReady: () => true,
    sleep,
  });
  assert.equal(outcome, "ready");
  assert.deepEqual(slept, [], "the restored canvas is already bound — proceed");
});

test("#1641 the reporter's case: first probe unready, next probe ready — first open waits then proceeds", async () => {
  const { slept, sleep } = recordSleep();
  let probes = 0;
  const outcome = await waitForReconnectHandshakeBeforeOpen({
    needsWait: () => true,
    isReady: () => {
      probes += 1;
      return probes >= 2;
    },
    sleep,
  });
  assert.equal(outcome, "ready", "the first open must succeed once the handshake lands");
  assert.equal(slept.length, 1, "one retry, not the full budget");
  assert.equal(slept[0], OPEN_RECONNECT_HANDSHAKE_STEPS_MS[0]);
});

test("#1641 a handshake that never lands times out on the shipped steps — the open still proceeds", async () => {
  const { slept, sleep } = recordSleep();
  const outcome = await waitForReconnectHandshakeBeforeOpen({
    needsWait: () => true,
    isReady: () => false,
    sleep,
  });
  assert.equal(outcome, "timeout", "a restore that never settles must not hang the open");
  assert.deepEqual(slept, [...OPEN_RECONNECT_HANDSHAKE_STEPS_MS], "every shipped step is waited, none invented");
});

test("#1641 the window closing mid-wait is ready, not a timeout", async () => {
  const { slept, sleep } = recordSleep();
  let pending = true;
  const outcome = await waitForReconnectHandshakeBeforeOpen({
    needsWait: () => pending,
    isReady: () => false,
    sleep: async (ms) => {
      slept.push(ms);
      pending = false;
    },
  });
  assert.equal(outcome, "ready");
  assert.equal(slept.length, 1);
});

test("#1641 a throwing ready-probe is 'not yet', never 'ready'", async () => {
  const { slept, sleep } = recordSleep();
  let probes = 0;
  const outcome = await waitForReconnectHandshakeBeforeOpen({
    needsWait: () => true,
    isReady: () => {
      probes += 1;
      if (probes < 3) throw new Error("getGraphCtx: graph not available");
      return true;
    },
    sleep,
  });
  assert.equal(outcome, "ready");
  assert.equal(probes, 3);
  assert.equal(slept.length, 2);
});

test("#1641 a throwing needsWait does not stall the open", async () => {
  const { slept, sleep } = recordSleep();
  const outcome = await waitForReconnectHandshakeBeforeOpen({
    needsWait: () => {
      throw new Error("epoch unreadable");
    },
    isReady: () => false,
    sleep,
  });
  assert.equal(outcome, "ready");
  assert.deepEqual(slept, []);
});

test("#1641 missing probes are ready — the wait cannot invent a handshake", async () => {
  const outcome = await waitForReconnectHandshakeBeforeOpen({ sleep: async () => {} });
  assert.equal(outcome, "ready");
});

// ---------------------------------------------------------------------------
// Panel wiring — deleting the await, moving it past the freeze, or dropping a
// handshake signal fails these. The function under test is workflow_open.
// ---------------------------------------------------------------------------

test("#1641 wiring: workflow_open awaits the shipped handshake wait", () => {
  assert.match(
    OPEN_BODY,
    /await waitForReconnectHandshakeBeforeOpen\(\{/,
    "workflow_open must wait on the shipped handshake helper, not a private copy",
  );
});

test("#1641 wiring: the wait is BEFORE the freeze and BEFORE the load", () => {
  const waitAt = OPEN_BODY.indexOf("await waitForReconnectHandshakeBeforeOpen({");
  const freezeAt = OPEN_BODY.indexOf("acquireCanvasInteractionLock(canvasView)");
  const openAt = OPEN_BODY.indexOf("await s.openWorkflow(target);");
  const loadAt = OPEN_BODY.indexOf("await app.loadGraphData(repaintState, true, true, target);");
  assert.notEqual(waitAt, -1);
  assert.notEqual(freezeAt, -1);
  assert.notEqual(openAt, -1);
  assert.notEqual(loadAt, -1);
  assert.ok(waitAt < freezeAt, "do not hold the canvas lock across the handshake");
  assert.ok(waitAt < openAt, "do not switch tabs before the restore has a chance to land");
  assert.ok(waitAt < loadAt, "the content comparison must not run against a still-restoring canvas");
});

test("#1641 wiring: wasOpen / wasDirty are snapshotted AFTER the wait, BEFORE openWorkflow", () => {
  // The handshake wait can populate changeTracker as the restore finishes; capturing
  // wasOpen before that would treat a now-open tab as first-time. wasDirty still
  // has to beat openWorkflow, because that is the await that erases it.
  const waitAt = OPEN_BODY.indexOf("await waitForReconnectHandshakeBeforeOpen({");
  const wasOpenAt = OPEN_BODY.indexOf("const wasOpen = !!target.changeTracker;");
  const wasDirtyAt = OPEN_BODY.indexOf("const wasDirty = !!target.isModified;");
  const openAt = OPEN_BODY.indexOf("await s.openWorkflow(target);");
  assert.ok(waitAt < wasOpenAt && wasOpenAt < openAt);
  assert.ok(waitAt < wasDirtyAt && wasDirtyAt < openAt);
});

test("#1641 wiring: the wait reads every post-restart handshake signal", () => {
  const waitAt = OPEN_BODY.indexOf("await waitForReconnectHandshakeBeforeOpen({");
  const brace = OPEN_BODY.indexOf("{", waitAt);
  let depth = 0;
  let end = brace;
  for (let i = brace; i < OPEN_BODY.length; i += 1) {
    if (OPEN_BODY[i] === "{") depth += 1;
    if (OPEN_BODY[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const call = OPEN_BODY.slice(waitAt, end + 1);
  assert.match(call, /needsWait:/, "the wait must know when a handshake is in flight");
  assert.match(call, /isReady:/, "and when the open may compare content");
  assert.match(call, /comfyBackendIsDown\(\)/, "backend socket still down");
  assert.match(call, /postReconnectBindingSettleWindow\(\)/, "canvas binding not yet re-proven");
  assert.match(call, /nodeDefRefreshInFlight/, "node-def refresh kicked on reconnected still running");
  assert.match(
    call,
    /assertGraphBoundToActiveWorkflow\(graph, rootGraph, \{ includeBaselineReadGuard: true \}\)/,
    "a ready probe that can prove the binding uses the same bar as the settle watch",
  );
  assert.match(
    call,
    /postReconnectBindingProofEpoch = openedForEpoch/,
    "proving the binding here must stamp the epoch so the mutation gate opens",
  );
});

test("#1641 wiring: the panel imports the shipped helper, not a local copy", () => {
  assert.match(
    SRC,
    /import \{[\s\S]*?waitForReconnectHandshakeBeforeOpen,[\s\S]*?\} from "\.\/lib\/reconnect-recovery\.js"/,
  );
});

// ---------------------------------------------------------------------------
// #1914 — a handshake miss must refuse, not proceed into a delivered hang.
// ---------------------------------------------------------------------------

test("#1914 minted open-readiness refusal is applied:false and unforgeable", () => {
  const err = workflowOpenReadinessRefusalError("the restored canvas binding is not yet proven");
  const refusal = readWorkflowOpenReadinessRefusal(err);
  assert.deepEqual(refusal, {
    code: "reconnect-not-ready",
    ready: false,
    applied: false,
    stage: "pre-open",
    retryable: true,
  });
  assert.match(err.message, /did not start because the restored canvas binding is not yet proven/);
  assert.match(err.message, /canvas is unchanged/);
  assert.equal(
    readWorkflowOpenReadinessRefusal(new Error(err.message)),
    null,
    "a lookalike sentence is not a minted refusal",
  );
  assert.equal(readWorkflowOpenReadinessRefusal({ message: err.message }), null);
});

test("#1914 wiring: handshake timeout throws the shipped open-readiness refusal", () => {
  assert.match(
    OPEN_BODY,
    /const readiness = await waitForReconnectHandshakeBeforeOpen\(\{/,
    "workflow_open must observe the wait's ready/timeout verdict",
  );
  assert.match(
    OPEN_BODY,
    /if \(readiness === "timeout"\)[\s\S]*?throw failOpen\(workflowOpenReadinessRefusalError\(/,
    "a timeout must be a journaled retryable refusal, not freeze/load",
  );
  const waitAt = OPEN_BODY.indexOf("const readiness = await waitForReconnectHandshakeBeforeOpen({");
  const refuseAt = OPEN_BODY.indexOf("throw failOpen(workflowOpenReadinessRefusalError(");
  const freezeAt = OPEN_BODY.indexOf("acquireCanvasInteractionLock(canvasView)");
  const openAt = OPEN_BODY.indexOf("await s.openWorkflow(target);");
  assert.ok(waitAt < refuseAt, "the verdict is checked before any mutator step");
  assert.ok(refuseAt < freezeAt, "do not freeze a canvas the reconnect has not settled");
  assert.ok(refuseAt < openAt, "do not switch tabs after a handshake miss");
});

test("#1914 wiring: the refusal is separate structured pre-open evidence", () => {
  assert.match(SRC, /readWorkflowOpenReadinessRefusal\(err\)/);
  assert.match(
    SRC,
    /\.\.\.\(workflowOpenReadiness \? \{ workflow_open_readiness: workflowOpenReadiness \} : \{\}\)/,
    "the bridge must publish the open-readiness refusal without treating it as a graph refusal",
  );
  assert.match(
    SRC,
    /import \{[\s\S]*?workflowOpenReadinessRefusalError,[\s\S]*?readWorkflowOpenReadinessRefusal,[\s\S]*?\} from "\.\/lib\/reconnect-recovery\.js"/,
  );
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
      `return workflow_open;\n}`,
  );
  const sandbox = {
    installActivePointerWatch,
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

function deliveredOpenHangEnvironment({ handshake }) {
  const target = {
    path: "workflows/LTX-2.5_Director_CHUNKS_MODULAR_DEBUG.json",
    filename: "LTX-2.5_Director_CHUNKS_MODULAR_DEBUG.json",
    isModified: false,
    changeTracker: { activeState: { nodes: [], links: [] } },
  };
  const receipts = [];
  let opened = 0;
  let frozen = 0;
  const hang = () => new Promise(() => {});
  const app = {
    extensionManager: {
      workflow: {
        openWorkflows: [target],
        workflows: [],
        getWorkflowByPath: () => target,
        openWorkflow: async () => {
          opened += 1;
          return hang();
        },
      },
    },
  };
  return {
    target,
    receipts,
    counters: () => ({ opened, frozen }),
    environment: {
      backendReconnectEpoch: 4,
      app,
      activeWorkflowRef: () => target,
      sameWorkflowObject: (a, b) => a === b,
      workflowTabId: (workflow) => `wf:${workflow.path}`,
      workflowRecordMatchesSelector: () => true,
      waitForReconnectHandshakeBeforeOpen: async () => handshake,
      workflowOpenReadinessRefusalError,
      comfyBackendIsDown: () => false,
      postReconnectBindingSettleWindow: () => true,
      nodeDefRefreshInFlight: null,
      noteOpenAttempt: (entry) => {
        receipts.push(entry);
        return { seq: receipts.length, ...entry };
      },
      coerceMessageText: (value) => String(value ?? ""),
      acquireCanvasInteractionLock: () => {
        frozen += 1;
        return "lock-token";
      },
      flushSourceCanvasBeforeSwitch: hang,
      installActivePointerWatch,
    },
  };
}

test(
  "#1914 production workflow_open refuses a handshake miss instead of hanging after delivery",
  { timeout: 1500 },
  async () => {
    const { target, receipts, counters, environment } = deliveredOpenHangEnvironment({
      handshake: "timeout",
    });
    const workflow_open = productionOpen(environment);
    let err;
    try {
      await Promise.race([
        workflow_open({ path: target.path, rid: "rid-1914-timeout" }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("timeout-after-delivered-open")), 1000);
        }),
      ]);
    } catch (caught) {
      err = caught;
    }
    assert.ok(err, "an unsettled reconnect must not report a successful open");
    assert.notEqual(
      err.message,
      "timeout-after-delivered-open",
      "the shipped open must reply before the orchestrator's 15s delivery timeout",
    );
    assert.notEqual(err.message, "proceeded past handshake into freeze");
    const refusal = readWorkflowOpenReadinessRefusal(err);
    assert.equal(refusal?.code, "reconnect-not-ready");
    assert.equal(refusal?.applied, false, "nothing was frozen, switched, or loaded");
    assert.equal(refusal?.retryable, true);
    assert.equal(refusal?.stage, "pre-open");
    assert.equal(counters().opened, 0, "openWorkflow must not run after a handshake miss");
    assert.equal(counters().frozen, 0, "the canvas lock must not be taken after a handshake miss");
    assert.ok(receipts.length >= 1, "failOpen journals a rid-correlated negative receipt");
    assert.ok(receipts.every((entry) => entry.applied === false));
    assert.equal(receipts[0].rid, "rid-1914-timeout");
    assert.equal(receipts[0].cmd, "workflow_open");
  },
);

test("#1914 production workflow_open still proceeds once the handshake is ready", async () => {
  const { target, environment } = deliveredOpenHangEnvironment({ handshake: "ready" });
  environment.acquireCanvasInteractionLock = () => {
    throw new Error("proceeded past handshake into freeze");
  };
  const workflow_open = productionOpen(environment);
  await assert.rejects(
    () => workflow_open({ path: target.path, rid: "rid-1914-ready" }),
    /proceeded past handshake into freeze/,
    "a ready handshake must not be turned into a false refusal",
  );
});
