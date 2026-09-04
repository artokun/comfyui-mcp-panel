// comfyui-mcp-panel#2249 — switch fence latched after a delivered workflow_open.
//
// MCP already acks delivery and keeps the instance fence fail-closed. The remaining
// hole is panel `activeWorkflowReloadGuard`: a settle/safe-repaint step in flight is
// immune to the 30s age-out, so graph_outline / workflow_list / mode:current were
// refused for 86s–2m+ after the open had already applied, with no correlated reply.
// #1264 bounded the post-open rAF; that did not unlatch a later pending settle.
//
// These tests drive the SHIPPED predicate (not a mock of it) and the wiring in the
// bundle. Fail on the unfixed latch; leftover previous-tab graph stays refused.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  frontendActiveMatchesAppliedOpen,
  switchFenceRefusesCommand,
} from "../../web/js/lib/switch-fence.js";
import {
  commandIsCanvasTargetless,
  commandTargetsActiveWorkflow,
} from "../../web/js/lib/workflow-chat-identity.js";
import {
  graphCommandBindingBar,
  graphRootUnprovenAgainstActiveState,
  resolveGraphBindingVerdict,
} from "../../web/js/lib/graph-binding.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const PENDING_GUARD = { token: 1, key: "wf:target.json", since: 1_000_000, pending: 1 };

test("#2249 workflow_list is exempt from the switch fence the same way it is from the instance fence", () => {
  assert.equal(commandIsCanvasTargetless("workflow_list"), true);
  assert.equal(
    switchFenceRefusesCommand({ cmd: "workflow_list", guard: PENDING_GUARD }),
    false,
    "the recovery probe must run while a settle step is still pending",
  );
  assert.equal(
    commandTargetsActiveWorkflow({
      cmd: "workflow_list",
      commandUuid: "stale-uuid",
      activeUuid: "live-uuid",
    }),
    true,
  );
});

test("#2249 UNFIXED LATCH: graph_outline / graph_query stay refused until the open is delivered", () => {
  for (const cmd of ["graph_outline", "graph_query", "graph_set_widget", "workflow_save"]) {
    assert.equal(
      switchFenceRefusesCommand({ cmd, guard: PENDING_GUARD }),
      true,
      `${cmd} must not run mid-switch before the open receipt is applied`,
    );
  }
});

test("#2249 a delivered open whose frontend already names the target unlatches dispatch", () => {
  for (const cmd of ["graph_outline", "graph_query", "graph_set_widget"]) {
    assert.equal(
      switchFenceRefusesCommand({
        cmd,
        guard: PENDING_GUARD,
        openReceiptApplied: true,
        frontendActiveMatchesAppliedOpen: true,
      }),
      false,
      `${cmd} must not stay latched through later settle/safe-repaint`,
    );
  }
});

test("#2249 a receipt for a different workflow, or an unapplied one, stays fail-closed", () => {
  assert.equal(
    switchFenceRefusesCommand({
      cmd: "graph_outline",
      guard: PENDING_GUARD,
      openReceiptApplied: true,
      frontendActiveMatchesAppliedOpen: false,
    }),
    true,
  );
  assert.equal(
    switchFenceRefusesCommand({
      cmd: "graph_outline",
      guard: PENDING_GUARD,
      openReceiptApplied: false,
      frontendActiveMatchesAppliedOpen: true,
    }),
    true,
    "frontend active matching without an applied receipt is the #433 restore shape",
  );
});

test("#2249 frontendActiveMatchesAppliedOpen correlates path/routing key, never filename", () => {
  const receipt = {
    applied: true,
    requested: "target.json",
    resolved: { path: "user/target.json", filename: "Unsaved Workflow", routing_key: "wf:user/target.json" },
  };
  assert.equal(
    frontendActiveMatchesAppliedOpen({
      receipt,
      activePath: "user/target.json",
      activeRoutingKey: "wf:user/target.json",
    }),
    true,
  );
  assert.equal(
    frontendActiveMatchesAppliedOpen({
      receipt,
      activePath: "user/other.json",
      activeRoutingKey: "wf:user/other.json",
    }),
    false,
  );
  assert.equal(
    frontendActiveMatchesAppliedOpen({
      receipt: { ...receipt, applied: false },
      activePath: "user/target.json",
      activeRoutingKey: "wf:user/target.json",
    }),
    false,
  );
  assert.equal(
    frontendActiveMatchesAppliedOpen({
      receipt: {
        applied: true,
        requested: "Unsaved Workflow",
        resolved: { path: null, filename: "Unsaved Workflow", routing_key: "tmp:aaa" },
      },
      activePath: null,
      activeRoutingKey: "tmp:bbb",
    }),
    false,
    "shared unsaved filename must not unlatch a different instance",
  );
});

test("#2249 leftover previous-tab graph is still refused after the switch token unlatches", () => {
  const nodes = Array.from({ length: 118 }, (_, i) => ({ id: i + 1, type: "KSampler" }));
  const rootGraph = { _nodes: nodes };
  assert.equal(
    graphRootUnprovenAgainstActiveState({
      liveNodeCount: 118,
      activeWorkflow: { changeTracker: { activeState: { nodes: "bad" } } },
      switchRepaintUnproven: true,
    }),
    true,
  );
  const verdict = resolveGraphBindingVerdict({
    graph: rootGraph,
    rootGraph,
    activeWorkflow: {},
    activeWorkflowUuid: "remove-bg-tab",
    liveNodeCount: 118,
    switchRepaintUnproven: true,
    ...graphCommandBindingBar("graph_outline"),
  });
  assert.equal(verdict?.reason, "root-state-unreadable");
});

test("#2249 dispatch consults the shipped predicate; ownership still ignores age-out while pending", () => {
  const guardAt = SRC.indexOf("const reloadGuard = activeWorkflowReloadGuard();");
  const execAt = SRC.indexOf("result = await executor(msg);");
  assert.ok(guardAt !== -1 && guardAt < execAt);
  const refusal = SRC.slice(guardAt, execAt);
  assert.match(refusal, /switchFenceRefusesCommand\(/);
  assert.match(refusal, /commandIsCanvasTargetless|frontendActiveMatchesAppliedOpen/);
  assert.match(refusal, /openReceiptApplied:/);
  assert.match(refusal, /was NOT applied — nothing changed\. Retry in a moment\./);
  assert.match(
    SRC,
    /typeof switchRepaintUnproven !== "undefined"/,
    "extracted leftover fences must still typeof-check the flag",
  );

  const reloadGuardMatch = SRC.match(
    /let workflowReloadGuard = null;[\s\S]*?function activeWorkflowReloadGuard\(\) \{[\s\S]*?\n\}/,
  );
  assert.ok(reloadGuardMatch, "could not locate the workflow reload guard block");
  const factory = new Function(
    "Date",
    `${reloadGuardMatch[0]}\nreturn { acquireWorkflowReloadGuard, beginWorkflowReloadStep, activeWorkflowReloadGuard };`,
  );
  const now = { t: 1_000_000 };
  const g = factory({ now: () => now.t });
  const token = g.acquireWorkflowReloadGuard("wf:target.json");
  assert.equal(g.beginWorkflowReloadStep(token), true);
  now.t += 120_000;
  const held = g.activeWorkflowReloadGuard();
  assert.ok(held, "ownership must still suspend age-out while a genuine step is in flight");
  assert.equal(held.token, token);
});

test("#2249 workflow_open journals the applied receipt before the safe-repaint await", () => {
  const openAt = SRC.indexOf("async workflow_open({ path, rid }) {");
  assert.ok(openAt > 0);
  const openBody = SRC.slice(openAt, SRC.indexOf("async workflow_close(", openAt));
  const settleAt = openBody.indexOf("if (openSettled.target && openSettled.target !== target) target = openSettled.target;");
  const earlyJournalAt = openBody.indexOf("applied: true,", settleAt);
  const leftoverAt = openBody.indexOf("if (pointerMovedThisOpen) switchRepaintUnproven = true;", settleAt);
  const repaintAt = openBody.indexOf("await app.loadGraphData(repaintState, true, true, target);");
  assert.ok(settleAt !== -1 && earlyJournalAt !== -1 && leftoverAt !== -1 && repaintAt !== -1);
  assert.ok(
    settleAt < leftoverAt && leftoverAt < earlyJournalAt && earlyJournalAt < repaintAt,
    "delivered open must be journaled (and leftover marked) before the hangable repaint",
  );
  assert.match(
    openBody.slice(settleAt, repaintAt),
    /sameWorkflowObject\(activeAfterSwitch, target\) === true/,
  );
});
