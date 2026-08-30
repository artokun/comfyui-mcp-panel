/**
 * #2007 — graph_outline used a stale workflow instance after the active tab
 * changed identity while keeping the same workflow name.
 *
 * Bind to instance A, reload/replace the tab so the same named workflow is
 * served by instance B, then call graph_outline from the session binding:
 * the dispatch fence compared the old stamp to the live uuid and refused
 * before reading. The error was correct; the recovery it demanded
 * (`panel_set_workflow_target({mode:"current"})`) was a round-trip for a
 * command that can only ever inspect the live canvas.
 *
 * Classified reads now follow the live instance (and restamp the command so
 * later checks in the same dispatch agree). Mutations stay fail-closed until
 * an explicit rebind. The fence predicate itself is unchanged — this is a
 * dispatch-site recovery after the mismatch is observed, and it still
 * re-advertises so the orchestrator cache can catch up.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  graphCommandMayMutateWorkflow,
  staleReadMayFollowLiveCanvas,
} from "../../web/js/lib/graph-binding.js";
import { commandTargetsActiveWorkflow } from "../../web/js/lib/workflow-chat-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const INSTANCE_A = "f0380091-0a28-4e12-9754-7f6967f41637";
const INSTANCE_B = "249fed9b-dd21-4c61-a5eb-8a13e38c3327";

const CLASSIFIED_READS = [
  "graph_outline",
  "graph_query",
  "graph_get_state",
  "graph_find_nodes",
  "graph_get_errors",
];

const MUTATIONS = [
  "graph_add_node",
  "graph_set_widget",
  "graph_remove_node",
  "workflow_save",
];

// ---------------------------------------------------------------------------
// The predicate — fail-closed except for a classified read with two readable,
// differing stamps.
// ---------------------------------------------------------------------------

test("#2007 graph_outline follows a live instance that replaced the stamped one", () => {
  assert.equal(
    staleReadMayFollowLiveCanvas({
      cmd: "graph_outline",
      commandUuid: INSTANCE_A,
      activeUuid: INSTANCE_B,
    }),
    true,
  );
});

test("#2007 every classified read follows; every mutation stays refused", () => {
  for (const cmd of CLASSIFIED_READS) {
    assert.equal(graphCommandMayMutateWorkflow(cmd), false, cmd);
    assert.equal(
      staleReadMayFollowLiveCanvas({
        cmd,
        commandUuid: INSTANCE_A,
        activeUuid: INSTANCE_B,
      }),
      true,
      cmd,
    );
  }
  for (const cmd of MUTATIONS) {
    assert.equal(graphCommandMayMutateWorkflow(cmd), true, cmd);
    assert.equal(
      staleReadMayFollowLiveCanvas({
        cmd,
        commandUuid: INSTANCE_A,
        activeUuid: INSTANCE_B,
      }),
      false,
      cmd,
    );
  }
});

test("#2007 an unknown command is a mutation and cannot follow", () => {
  assert.equal(
    staleReadMayFollowLiveCanvas({
      cmd: "graph_some_future_command",
      commandUuid: INSTANCE_A,
      activeUuid: INSTANCE_B,
    }),
    false,
  );
});

test("#2007 matching stamps are not a follow — there is nothing to recover", () => {
  assert.equal(
    staleReadMayFollowLiveCanvas({
      cmd: "graph_outline",
      commandUuid: INSTANCE_B,
      activeUuid: INSTANCE_B,
    }),
    false,
  );
});

test("#2007 an UNSTAMPED read still fails closed (#718)", () => {
  for (const commandUuid of [undefined, null, "", "   "]) {
    assert.equal(
      staleReadMayFollowLiveCanvas({
        cmd: "graph_outline",
        commandUuid,
        activeUuid: INSTANCE_B,
      }),
      false,
      `commandUuid=${JSON.stringify(commandUuid)}`,
    );
  }
});

test("#2007 an UNREADABLE live identity still fails closed (#186)", () => {
  for (const activeUuid of [undefined, null, "", "   "]) {
    assert.equal(
      staleReadMayFollowLiveCanvas({
        cmd: "graph_outline",
        commandUuid: INSTANCE_A,
        activeUuid,
      }),
      false,
      `activeUuid=${JSON.stringify(activeUuid)}`,
    );
  }
});

test("#2007 the fence predicate itself is unchanged — reads stay fenced", () => {
  // The recovery is a dispatch-site follow AFTER the mismatch is observed, not
  // an exemption. Widening activeWorkflowFenceApplies would also skip the
  // re-hello that refreshes the orchestrator cache.
  const stale = { commandUuid: INSTANCE_A, activeUuid: INSTANCE_B };
  assert.equal(commandTargetsActiveWorkflow({ cmd: "graph_outline", ...stale }), false);
  assert.equal(commandTargetsActiveWorkflow({ cmd: "graph_add_node", ...stale }), false);
});

// ---------------------------------------------------------------------------
// Dispatch wiring — the shipping `if` block, not a re-implementation.
// ---------------------------------------------------------------------------

function runDispatchFence(msg, { activeUuid, onMismatch = () => {}, onMove = () => {} } = {}) {
  const start = SRC.indexOf("const dispatchCommandUuid = msg?.[WORKFLOW_UUID_FIELD];");
  assert.notEqual(start, -1, "dispatch fence start marker missing");
  const end = SRC.indexOf(
    "// #349: UUID fencing proves the command was issued for the active",
    start,
  );
  assert.notEqual(end, -1, "dispatch fence end marker missing");
  const slice = SRC.slice(start, end);
  assert.match(
    slice,
    /staleReadMayFollowLiveCanvas\(/,
    "the shipping fence must consult the follow predicate",
  );
  const factory = new Function(
    "msg",
    "commandTargetsActiveWorkflow",
    "staleReadMayFollowLiveCanvas",
    "workflowStableUuid",
    "WORKFLOW_UUID_FIELD",
    "noteActiveWorkflowMove",
    "noteWorkflowInstanceMismatch",
    "workflowInstanceMismatchMessage",
    "targetsNonActive",
    "activeWorkflowMoves",
    slice,
  );
  factory(
    msg,
    commandTargetsActiveWorkflow,
    staleReadMayFollowLiveCanvas,
    () => activeUuid,
    "workflow_uuid",
    onMove,
    onMismatch,
    ({ commandUuid, activeUuid: live }) =>
      `workflow instance mismatch: command issued for workflow instance ${commandUuid}, ` +
      `but the tab routed to has reported active workflow ${live}`,
    false,
    { describeLast: () => null },
  );
}

test("#2007 dispatch: a stale graph_outline restamps to the live instance and runs", () => {
  const msg = { cmd: "graph_outline", workflow_uuid: INSTANCE_A };
  let hellos = 0;
  let moves = 0;
  runDispatchFence(msg, {
    activeUuid: INSTANCE_B,
    onMismatch: () => {
      hellos += 1;
    },
    onMove: () => {
      moves += 1;
    },
  });
  assert.equal(msg.workflow_uuid, INSTANCE_B, "the command now names the live canvas");
  assert.equal(hellos, 1, "the mismatch still re-advertises so later mutations can rebind");
  assert.equal(moves, 1, "the observed move is still recorded");
});

test("#2007 dispatch: a stale MUTATION still refuses", () => {
  const msg = { cmd: "graph_add_node", workflow_uuid: INSTANCE_A };
  let hellos = 0;
  assert.throws(
    () =>
      runDispatchFence(msg, {
        activeUuid: INSTANCE_B,
        onMismatch: () => {
          hellos += 1;
        },
      }),
    /workflow instance mismatch/,
  );
  assert.equal(msg.workflow_uuid, INSTANCE_A, "a refused write must not be restamped");
  assert.equal(hellos, 1, "the refusal still re-advertises");
});

test("#2007 dispatch: classified reads follow; writes do not", () => {
  for (const cmd of CLASSIFIED_READS) {
    const msg = { cmd, workflow_uuid: INSTANCE_A };
    runDispatchFence(msg, { activeUuid: INSTANCE_B });
    assert.equal(msg.workflow_uuid, INSTANCE_B, cmd);
  }
  for (const cmd of MUTATIONS) {
    const msg = { cmd, workflow_uuid: INSTANCE_A };
    assert.throws(
      () => runDispatchFence(msg, { activeUuid: INSTANCE_B }),
      /workflow instance mismatch/,
      cmd,
    );
    assert.equal(msg.workflow_uuid, INSTANCE_A, cmd);
  }
});

test("#2007 dispatch: a matching stamp is a no-op", () => {
  const msg = { cmd: "graph_outline", workflow_uuid: INSTANCE_B };
  let hellos = 0;
  runDispatchFence(msg, {
    activeUuid: INSTANCE_B,
    onMismatch: () => {
      hellos += 1;
    },
  });
  assert.equal(msg.workflow_uuid, INSTANCE_B);
  assert.equal(hellos, 0, "agreement must not fire the mismatch recovery");
});

test("#2007 dispatch: an unstamped outline still refuses", () => {
  const msg = { cmd: "graph_outline" };
  assert.throws(
    () => runDispatchFence(msg, { activeUuid: INSTANCE_B }),
    /workflow instance mismatch/,
  );
});

test("#2007 the throw is the ELSE of the follow, not an unconditional refusal", () => {
  // Deleting the follow gate, or throwing before consulting it, re-breaks the
  // first graph_outline after a tab instance change. Anchored on the dispatch
  // fence, not the mutation-boundary assert — that site still refuses writes.
  const start = SRC.indexOf("const dispatchCommandUuid = msg?.[WORKFLOW_UUID_FIELD];");
  const end = SRC.indexOf(
    "// #349: UUID fencing proves the command was issued for the active",
    start,
  );
  const region = SRC.slice(start, end);
  const followAt = region.indexOf("staleReadMayFollowLiveCanvas(");
  const throwAt = region.indexOf("throw new Error(");
  assert.ok(followAt !== -1, "dispatch must consult the follow predicate");
  assert.ok(throwAt > followAt, "the refusal throw must come after the follow gate");
  assert.match(region, /else\s*\{/, "the throw is the follow's else, not a second independent refusal");
});
