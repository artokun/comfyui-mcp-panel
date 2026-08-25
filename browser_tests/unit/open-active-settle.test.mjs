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
    `with (sandbox) {\n${RELOAD_GUARD_SOURCE[0]}\n${methodSource}\n` +
      `return { method: ${methodName}, guard: () => activeWorkflowReloadGuard(), ` +
      `proofs: () => ({ active: activeWorkflowResyncEpoch, post: postReconnectBindingProofEpoch }) };\n}`,
  );
  const scope = new Proxy(environment, {
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : globalThis[key];
    },
  });
  return factory(scope);
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
