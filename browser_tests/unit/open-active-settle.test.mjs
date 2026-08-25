import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  settleOpenedWorkflowActive,
  settleOwnedOpenedWorkflowActive,
} from "../../web/js/lib/settle-open-active.js";
import { graphMutationReconnectGate } from "../../web/js/lib/reconnect-recovery.js";
import { activeWorkflowPossiblyStale } from "../../web/js/lib/reconnect-staleness.js";
import { classifyPinnedTarget } from "../../web/js/lib/workflow-chat-identity.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const sameWorkflowObject = (a, b) => a === b;

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
    /const invalidEpoch = backendReconnectEpoch - 1[\s\S]*postReconnectBindingProofEpoch = invalidEpoch/,
    "workflow_open retires both proof epochs before the immediate consumers run",
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
    /rebindFailed && workflowOpenGeneration <= openGeneration[\s\S]*invalidEpoch/,
    "a failed open cannot invalidate a newer open generation's proof",
  );
  assert.match(
    SRC.slice(probeAt, releaseAt),
    /rebindFailed = new Error\([\s\S]*active canvas/,
    "an unstable result follows the fail-closed rebind path",
  );
});
