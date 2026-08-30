/**
 * #2003 — live graph RPC recovers after a manual canvas edit.
 *
 * panel_graph_outline timed out three consecutive times after a PreviewImage
 * widget/canvas edit. The tab stayed registered; every retry was silence.
 *
 * Two panel-owned rules this file pins:
 *   * a hung READ must not pin retry_of to the original (mutations still must);
 *   * the recovery names panel_open_workflow, not a browser refresh and not
 *     panel_set_workflow_target.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  GRAPH_RPC_REBIND_ACTION,
  shouldJoinInFlightGraphReply,
  ledgerReplyIsInFlight,
  graphRpcTimeoutRecovery,
} from "../../web/js/lib/graph-rpc-liveness.js";
import { graphCommandMayMutateWorkflow } from "../../web/js/lib/graph-binding.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

test("#2003 a settled reply still joins — the ledger's idempotent path is unchanged", () => {
  assert.equal(
    shouldJoinInFlightGraphReply({ cmd: "graph_outline", priorInFlight: false }),
    true,
  );
  assert.equal(shouldJoinInFlightGraphReply({ cmd: "graph_add_node" }), true);
  assert.equal(shouldJoinInFlightGraphReply({}), true);
});

test("#2003 an in-flight READ does not join — retries execute fresh", () => {
  for (const cmd of ["graph_outline", "graph_query", "graph_get_state", "graph_get_errors"]) {
    assert.equal(graphCommandMayMutateWorkflow(cmd), false, cmd);
    assert.equal(
      shouldJoinInFlightGraphReply({ cmd, priorInFlight: true }),
      false,
      `${cmd} must not wait for a hung original`,
    );
  }
});

test("#2003 an in-flight MUTATION still joins — double-apply remains closed", () => {
  for (const cmd of ["graph_add_node", "graph_set_widget", "graph_remove_node", "graph_run"]) {
    assert.equal(graphCommandMayMutateWorkflow(cmd), true, cmd);
    assert.equal(
      shouldJoinInFlightGraphReply({ cmd, priorInFlight: true }),
      true,
      `${cmd} must still wait so a timeout-plus-retry cannot land twice`,
    );
  }
});

test("#2003 ledgerReplyIsInFlight is a thenable check, not a guess about the payload", () => {
  assert.equal(ledgerReplyIsInFlight(Promise.resolve({ ok: true })), true);
  assert.equal(ledgerReplyIsInFlight({ then: () => {} }), true);
  assert.equal(ledgerReplyIsInFlight({ rid: "r1", ok: true, result: {} }), false);
  assert.equal(ledgerReplyIsInFlight(undefined), false);
  assert.equal(ledgerReplyIsInFlight(null), false);
});

test("#2003 recovery names a canvas rebind, not a refresh or a session retarget", () => {
  assert.equal(GRAPH_RPC_REBIND_ACTION, "panel_open_workflow");
  const text = graphRpcTimeoutRecovery({ cmd: "graph_outline" });
  assert.match(text, /panel_open_workflow/);
  assert.match(text, /no browser refresh/);
  assert.match(text, /panel_set_workflow_target is NOT a remedy/);
  assert.match(text, /graph_outline/);
});

test("#2003 WIRING: hung-read retries fall through to a fresh executor", () => {
  assert.match(SRC, /import \{ shouldJoinInFlightGraphReply, ledgerReplyIsInFlight \} from "\.\/lib\/graph-rpc-liveness\.js";/);
  const skip = SRC.indexOf("!shouldJoinInFlightGraphReply({");
  assert.ok(skip >= 0, "the dispatch path must consult the join rule");
  const wait = SRC.indexOf("dupReply = await awaitDuplicateReply(priorRidReply, msg.rid, msg.timeout_ms);");
  assert.ok(wait > skip, "the skip must land before the unbounded duplicate wait");
  const clear = SRC.slice(skip, wait);
  assert.match(clear, /priorRidReply = undefined/);
  assert.match(clear, /retryOfHit = false/);
});

test("#2003 WIRING: tracker snapshot flush is mutation-only", () => {
  // The #1723 flush still runs before the mutation fence. A graph_outline must
  // not pay captureCanvasState — that serialize is what outlives the 20s window
  // after a PreviewImage/canvas edit.
  const gate = SRC.indexOf("if (msg.cmd.startsWith(\"graph_\") && !commandIsCanvasIndependent(msg.cmd))");
  assert.ok(gate >= 0, "the graph dispatch gate must exist");
  const fence = SRC.indexOf("assertGraphBoundToActiveWorkflow(graph, rootGraph, graphCommandBindingBar(msg.cmd))", gate);
  assert.ok(fence > gate, "the binding fence still runs for graph commands");
  const region = SRC.slice(gate, fence);
  const flush = region.indexOf("flushPendingChangeTrackerSnapshot(");
  assert.ok(flush >= 0, "mutations still flush");
  const mutate = region.lastIndexOf("if (graphCommandMayMutateWorkflow(msg.cmd))", flush);
  assert.ok(mutate >= 0 && mutate < flush, "the flush must sit inside the mutation branch");
});
