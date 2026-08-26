// #1790 recurrence — exercise the shipped workflow_list boundary through the
// carrier split seen during reconnect: activeWorkflowRef() has the raw
// ComfyWorkflow while openWorkflows has its Vue proxy. The same unsaved tab must
// produce one routing handle, remain the sole active list entry, and keep doing
// so across the four production probe reads used by the orchestrator.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { rawWorkflowObject } from "../../web/js/lib/workflow-chat-identity.js";
import { savedWorkflowHandle } from "../../web/js/lib/bridge-route.js";
import { dedupeWorkflowTabRecords } from "../../web/js/lib/session-rebind.js";

const PANEL_JS = join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js");
const PANEL_SRC = readFileSync(PANEL_JS, "utf8");
const WORKFLOW_UUID = "11111111-1111-4111-8111-111111111111";

function balancedBlock(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `missing source marker: ${marker}`);
  const open = src.indexOf("{", start + marker.length);
  assert.notEqual(open, -1, `missing opening brace: ${marker}`);
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
    if (ch === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unterminated source block: ${marker}`);
}

function functionSource(name) {
  const marker = `function ${name}(`;
  const start = PANEL_SRC.indexOf(marker);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const open = PANEL_SRC.indexOf("{", start + marker.length);
  assert.notEqual(open, -1, `missing opening brace: ${name}`);
  return PANEL_SRC.slice(start, open) + balancedBlock(PANEL_SRC, marker);
}

function workflowListSource() {
  const marker = "async workflow_list()";
  return `async function workflow_list()${balancedBlock(PANEL_SRC, marker)}`;
}

function buildWorkflowList({ activeWorkflow, openWorkflows, workflowUuids }) {
  const bundle = `
    const WORKFLOW_UUID_FIELD = "workflow_uuid";
    const _tempWorkflowInstanceIds = new WeakMap();
    const _priorTempWorkflowIds = new WeakMap();
    ${rawWorkflowObject.toString()}
    function workflowObjectUuid(wf) {
      return workflowUuids.get(rawWorkflowObject(wf));
    }
    ${functionSource("savedWorkflowPath")}
    ${functionSource("tempWorkflowInstanceId")}
    ${functionSource("setTempWorkflowInstanceId")}
    ${functionSource("priorTempWorkflowId")}
    ${functionSource("setPriorTempWorkflowId")}
    ${functionSource("workflowTabId")}
    ${functionSource("isCanonicalWorkflowInstanceUuid")}
    ${functionSource("establishedWorkflowReplyIdentity")}
    ${functionSource("liveWorkflowListActive")}
    ${functionSource("workflowDiskIdentityPath")}
    ${workflowListSource()}
    return workflow_list;
  `;
  return new Function(
    "app",
    "activeWorkflowRef",
    "workflowUuids",
    "crypto",
    "savedWorkflowHandle",
    "dedupeWorkflowTabRecords",
    "comfyBackendIsDown",
    "postReconnectSettleWindow",
    "nodeDefRefreshInFlight",
    "postReconnectBindingProofEpoch",
    "backendReconnectEpoch",
    "waitForReconnectHandshakeBeforeOpen",
    "workflowListReadinessRefusalError",
    "activeWorkflowPossiblyStale",
    "activeWorkflowResyncEpoch",
    "backendReconnectedAt",
    "monotonicNow",
    "summarizeOpenReceipt",
    "latestOpenReceipt",
    "openReceipts",
    "lateWorkflowSaveReceipts",
    "backendSocketReplyFields",
    "getWorkflowTitle",
    bundle,
  )(
    { extensionManager: { workflow: { openWorkflows } } },
    () => activeWorkflow,
    workflowUuids,
    globalThis.crypto,
    savedWorkflowHandle,
    dedupeWorkflowTabRecords,
    () => false,
    () => false,
    null,
    0,
    0,
    async ({ needsWait, isReady }) => (needsWait() && isReady() ? "ready" : "ready"),
    (reason) => new Error(reason),
    () => false,
    0,
    null,
    () => 1_000,
    () => null,
    () => null,
    [],
    () => [],
    () => ({}),
    () => "Unsaved Workflow",
  );
}

test("#1790 production boundary: raw active + proxy list preserves one unsaved identity across four probes", async () => {
  const raw = {
    path: undefined,
    filename: undefined,
    key: "Unsaved Workflow",
    isPersisted: false,
    isTemporary: true,
  };
  const proxy = {
    __v_raw: raw,
    path: undefined,
    filename: undefined,
    key: "Unsaved Workflow",
    isPersisted: false,
    isTemporary: true,
  };
  const workflowUuids = new WeakMap([[raw, WORKFLOW_UUID]]);
  const workflowList = buildWorkflowList({
    activeWorkflow: raw,
    openWorkflows: [proxy],
    workflowUuids,
  });

  assert.notEqual(raw, proxy, "the reconnect carrier split must be a real proxy/raw split");
  assert.equal(rawWorkflowObject(proxy), raw);
  const handles = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const reply = await workflowList();
    assert.equal(reply.active.workflow_uuid, WORKFLOW_UUID);
    assert.equal(reply.workflows.length, 1);
    assert.equal(reply.workflows[0].active, true, `probe ${attempt + 1} must mark the live row active`);
    assert.equal(reply.active.routing_key, reply.workflows[0].routing_key);
    assert.equal(reply.active.key, reply.workflows[0].key);
    handles.push(reply.active.routing_key);
  }
  assert.equal(new Set(handles).size, 1, "repeated corroboration reads must not churn the tmp handle");
});
