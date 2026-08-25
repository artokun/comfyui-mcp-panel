// #1795 — closing a refused/unsaved ACTIVE workflow must not leave the shared
// canvas and route identity pointing at the unloaded tab.
//
// This is intentionally a production-path wiring test. The browser regression
// drives the real executor against ComfyUI; this companion keeps the critical
// ordering and fail-closed postcondition visible in the unit gate, so a future
// edit cannot silently move the repair behind the return or weaken its proof.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

function handlerBody(src, sig) {
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `${sig} must exist`);
  const after = start + sig.length;
  const next = src.slice(after).match(/\n {2}(?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  return src.slice(start, next ? after + next.index : src.length);
}

const CLOSE = handlerBody(SRC, "async workflow_close({");

test("#1795: unsaved-workflow refusal remains before any destructive close", () => {
  const closeAt = CLOSE.indexOf("await s.closeWorkflow(target);");
  const dirtyRefusalAt = CLOSE.indexOf("if (target.isModified && !force)");
  const captureRefusalAt = CLOSE.indexOf('if ((verdict === "failed" || verdict === "unverified") && !force)');
  assert.ok(captureRefusalAt >= 0, "capture uncertainty must still refuse without force");
  assert.ok(dirtyRefusalAt >= 0, "the ordinary unsaved-change refusal must still exist");
  assert.ok(closeAt > captureRefusalAt, "capture refusal must precede close");
  assert.ok(closeAt > dirtyRefusalAt, "unsaved-change refusal must precede close");
});

test("#1795: an active close snapshots identity and recovers through the production open path", () => {
  const closeAt = CLOSE.indexOf("await s.closeWorkflow(target);");
  const snapshotAt = CLOSE.indexOf("const activeBeforeClose = activeWorkflowRef()", 0);
  const recoveryAt = CLOSE.indexOf("const openAfterClose =", closeAt);
  const openPathAt = CLOSE.indexOf("GRAPH_TOOL_EXECUTORS.workflow_open({ path: replacementRoutingKey })", recoveryAt);
  const finalProofAt = CLOSE.indexOf("const activeAfterRebind = activeWorkflowRef();", openPathAt);
  assert.ok(snapshotAt >= 0 && snapshotAt < closeAt, "active identity must be captured before close");
  assert.ok(recoveryAt > closeAt, "successor selection must happen after close");
  assert.ok(openPathAt > recoveryAt, "successor selection must use the production workflow_open path");
  assert.ok(finalProofAt > openPathAt, "close success must be checked after the rebind completes");
  assert.match(CLOSE, /!sameWorkflowObject\(workflow, target\)/, "the closed object must never be selected as its own successor");
  assert.match(CLOSE, /activeIdentity\.routingKey !== replacementRoutingKey/, "the route identity must be checked");
  assert.match(CLOSE, /activeBinding !== "bound"/, "a stale/unproven graph binding must refuse success");
});

test("#1795: a post-close recovery failure is not reported as binding success or blindly retryable", () => {
  assert.match(CLOSE, /The close was applied, but the active\/graph binding is UNVERIFIED/);
  assert.match(CLOSE, /do NOT retry[\s\S]*workflow_close/);
  assert.match(CLOSE, /workflow_uuid: activeIdentity\.uuid/);
  assert.match(CLOSE, /routing_key: activeIdentity\.routingKey/);
  // The internal rebind must not reuse the close command's rid as an open receipt.
  assert.match(CLOSE, /GRAPH_TOOL_EXECUTORS\.workflow_open\(\{ path: replacementRoutingKey \}\)/);
  assert.doesNotMatch(CLOSE, /workflow_open\(\{ path: replacementRoutingKey, rid/);
});
