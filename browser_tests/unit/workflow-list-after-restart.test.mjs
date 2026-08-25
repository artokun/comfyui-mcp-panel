// #1785 — workflow_list is the readiness fence used by
// panel_set_workflow_target({mode:"current"}). After a ComfyUI restart it must
// wait for a bounded, current live-identity proof, and refuse on uncertainty;
// it must not turn a pre-reconnect active pointer into targeting success.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  OPEN_RECONNECT_HANDSHAKE_STEPS_MS,
  waitForReconnectHandshakeBeforeOpen,
} from "../../web/js/lib/reconnect-recovery.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

function handlerBody(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return "";
  const after = start + sig.length;
  const m = src.slice(after).match(/\n {2}(?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  return src.slice(start, m ? after + m.index : src.length);
}

const LIST_BODY = handlerBody(SRC, "async workflow_list()");

function recordSleep() {
  const slept = [];
  return {
    slept,
    sleep: async (ms) => slept.push(ms),
  };
}

test("#1785 a workflow-list readiness miss times out on the shipped bounded wait", async () => {
  const { slept, sleep } = recordSleep();
  const outcome = await waitForReconnectHandshakeBeforeOpen({
    needsWait: () => true,
    isReady: () => false,
    sleep,
  });
  assert.equal(outcome, "timeout");
  assert.deepEqual(slept, [...OPEN_RECONNECT_HANDSHAKE_STEPS_MS]);
});

test("#1785 wiring: workflow_list waits before reading the service and refuses uncertainty", () => {
  const waitAt = LIST_BODY.indexOf("await waitForReconnectHandshakeBeforeOpen({");
  const serviceAt = LIST_BODY.indexOf("const s = app?.extensionManager?.workflow;");
  const finalLiveReadAt = LIST_BODY.lastIndexOf("const { active, activeIdentity } = liveWorkflowListActive();");

  assert.notEqual(waitAt, -1, "workflow_list must use the shipped reconnect wait");
  assert.notEqual(serviceAt, -1, "workflow_list must still read the workflow service");
  assert.notEqual(finalLiveReadAt, -1, "workflow_list must read the live active pair");
  assert.ok(waitAt < serviceAt, "do not publish a service snapshot before readiness");
  assert.ok(waitAt < finalLiveReadAt, "do not publish the active identity before readiness");
  assert.match(
    LIST_BODY,
    /if \(readiness === "timeout"\)[\s\S]*?throw workflowListReadinessRefusalError\(/,
    "a timeout must be a retryable refusal, not a successful list",
  );
});

test("#1785 wiring: readiness requires live identity plus the current binding proof", () => {
  assert.match(LIST_BODY, /comfyBackendIsDown\(\)/, "backend reconnect must remain unready");
  assert.match(LIST_BODY, /nodeDefRefreshInFlight != null/, "node refresh must remain unready");
  assert.match(LIST_BODY, /activeIdentity\?\.routingKey/, "routing identity must be established");
  assert.match(LIST_BODY, /activeIdentity\?\.uuid/, "workflow UUID must be established");
  assert.match(
    LIST_BODY,
    /postReconnectBindingProofEpoch < backendReconnectEpoch/,
    "a restored active pointer is not enough without the current binding proof",
  );
  assert.match(LIST_BODY, /postReconnectSettleWindow\(\)/, "the reconnect window must be epoch-aware");
});

test("#1785 wiring: the refusal is separate structured read-only evidence", () => {
  assert.match(SRC, /readWorkflowListReadinessRefusal\(err\)/);
  assert.match(
    SRC,
    /\.\.\.\(workflowListReadiness \? \{ workflow_list_readiness: workflowListReadiness \} : \{\}\)/,
    "the bridge must publish the readiness refusal without treating it as a graph refusal",
  );
  assert.match(SRC, /workflowListReadinessRefusals\.add\(error\)/);
});
