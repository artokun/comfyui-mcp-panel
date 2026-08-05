// #663 / #646 — the post-reconnect settle watch and the graph-mutation gate.
//
// #663: the `reconnected` handler used to only bump the epoch — nothing
// re-proved the canvas binding, so the settle window ran its full 30s in the
// healthy case and a never-settling restore hard-refused until a manual
// open/reload. The watch re-proves the binding with the same evidence bar a
// graph read runs and closes the binding window early on proof.
//
// #646: nothing gated graph mutations on the post-restart state, so a mutation
// could dispatch into a dying socket (OUTCOME UNKNOWN) or onto a canvas the
// restore was about to rebuild. The gate refuses graph mutations while the
// backend socket is down or the binding is unproven inside the window.
//
// The loop and the gate are tested as pure lib functions; the panel WIRING is
// pinned by source scans that fail if the wiring is deleted.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  watchPostReconnectSettle,
  graphMutationReconnectGate,
} from "../../web/js/lib/reconnect-recovery.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const instantSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// watchPostReconnectSettle
// ---------------------------------------------------------------------------

test("#663: the watch proves on the first poll and stamps the proof exactly once", async () => {
  let provenCalls = 0;
  const outcome = await watchPostReconnectSettle({
    isCurrent: () => true,
    windowOpen: () => true,
    proveBinding: () => true,
    markProven: () => {
      provenCalls += 1;
    },
    sleep: instantSleep,
    firstDelayMs: 0,
  });
  assert.equal(outcome, "proven");
  assert.equal(provenCalls, 1);
});

test("#663: a binding that settles on the third poll is proven on the third", async () => {
  let polls = 0;
  const outcome = await watchPostReconnectSettle({
    isCurrent: () => true,
    windowOpen: () => true,
    proveBinding: () => {
      polls += 1;
      return polls >= 3;
    },
    markProven: () => {},
    sleep: instantSleep,
    firstDelayMs: 0,
  });
  assert.equal(outcome, "proven");
  assert.equal(polls, 3);
});

test("#663: a THROWING proof probe is 'not yet', never 'proven' — the watch outlives it", async () => {
  let polls = 0;
  let provenCalls = 0;
  const outcome = await watchPostReconnectSettle({
    isCurrent: () => true,
    windowOpen: () => true,
    proveBinding: () => {
      polls += 1;
      if (polls < 3) throw new Error("getGraphCtx: graph not available");
      return true;
    },
    markProven: () => {
      provenCalls += 1;
    },
    sleep: instantSleep,
    firstDelayMs: 0,
  });
  assert.equal(outcome, "proven");
  assert.equal(provenCalls, 1);
  assert.equal(polls, 3);
});

test("#663: a watch superseded by a newer reconnect never stamps its stale proof", async () => {
  let currentChecks = 0;
  let provenCalls = 0;
  const outcome = await watchPostReconnectSettle({
    // Current on entry and at the poll, superseded by the time the proof lands.
    isCurrent: () => {
      currentChecks += 1;
      return currentChecks < 2;
    },
    windowOpen: () => true,
    proveBinding: () => true,
    markProven: () => {
      provenCalls += 1;
    },
    sleep: instantSleep,
    firstDelayMs: 0,
  });
  assert.equal(outcome, "superseded");
  assert.equal(provenCalls, 0, "a stale watch must not close the NEW epoch's window");
});

test("#663: a window closed externally (explicit open/new, or expiry) stops the watch", async () => {
  let provenCalls = 0;
  const outcome = await watchPostReconnectSettle({
    isCurrent: () => true,
    windowOpen: () => false,
    proveBinding: () => true,
    markProven: () => {
      provenCalls += 1;
    },
    sleep: instantSleep,
    firstDelayMs: 0,
  });
  assert.equal(outcome, "closed");
  assert.equal(provenCalls, 0);
});

test("#663: a restore that NEVER settles is bounded — the watch exhausts and proves nothing", async () => {
  let polls = 0;
  let provenCalls = 0;
  const outcome = await watchPostReconnectSettle({
    isCurrent: () => true,
    windowOpen: () => true,
    proveBinding: () => {
      polls += 1;
      return false;
    },
    markProven: () => {
      provenCalls += 1;
    },
    sleep: instantSleep,
    firstDelayMs: 0,
    maxPolls: 5,
  });
  assert.equal(outcome, "exhausted");
  assert.equal(polls, 5, "the loop is bounded even if the window predicate never closes");
  assert.equal(provenCalls, 0, "an unsettled restore is never reported as proven");
});

// ---------------------------------------------------------------------------
// graphMutationReconnectGate
// ---------------------------------------------------------------------------

test("#646: no instability signal → no gate", () => {
  assert.equal(
    graphMutationReconnectGate({ cmd: "graph_set_widget", backendDown: false, bindingSettleWindow: false }),
    null,
  );
});

test("#646: backend down refuses with a retryable, nothing-applied message naming the command", () => {
  const msg = graphMutationReconnectGate({ cmd: "graph_set_widget", backendDown: true });
  assert.match(msg, /\[backend-reconnecting\]/);
  assert.match(msg, /"graph_set_widget"/, "the refusal names the command it refused");
  assert.match(msg, /NOT applied — nothing changed/, "the refusal is honest that nothing ran");
  assert.match(msg, /Retry/, "the remedy is actionable from the caller's state");
});

test("#646: the unproven-binding window refuses and names the escalate-after-30s remedy", () => {
  const msg = graphMutationReconnectGate({ cmd: "graph_add_node", bindingSettleWindow: true });
  assert.match(msg, /\[post-reconnect-settling\]/);
  assert.match(msg, /NOT applied — nothing changed/);
  assert.match(msg, /panel_open_workflow/, "the persistent case names the proven-rebind remedy");
});

test("#646: backend-down takes precedence over the settle window (both true)", () => {
  const msg = graphMutationReconnectGate({ cmd: "graph_run", backendDown: true, bindingSettleWindow: true });
  assert.match(msg, /\[backend-reconnecting\]/);
});

// ---------------------------------------------------------------------------
// Panel wiring (source scans — deleting the wiring fails these)
// ---------------------------------------------------------------------------

test("#663 wiring: the 'reconnected' listener kicks the settle watch for the NEW epoch", () => {
  const start = SRC.indexOf('api.addEventListener("reconnected"');
  assert.notEqual(start, -1);
  const block = SRC.slice(start, start + 1600);
  assert.match(block, /backendReconnectEpoch \+= 1/, "the epoch bump is intact (#433)");
  assert.match(
    block,
    /kickPostReconnectSettleWatch\(backendReconnectEpoch\)/,
    "the proactive re-proof watch is kicked for the epoch just bumped",
  );
});

test("#646 wiring: the backend-down flag tracks ComfyUI's own socket events", () => {
  const reconnecting = SRC.slice(
    SRC.indexOf('api.addEventListener("reconnecting"'),
    SRC.indexOf('api.addEventListener("reconnecting"') + 400,
  );
  assert.match(reconnecting, /comfyBackendSocketDown = true/, "backend going down arms the mutation gate");
  const reconnected = SRC.slice(
    SRC.indexOf('api.addEventListener("reconnected"'),
    SRC.indexOf('api.addEventListener("reconnected"') + 400,
  );
  assert.match(reconnected, /comfyBackendSocketDown = false/, "reconnect disarms it");
});

test("#646 wiring: the dispatch fence gates MUTATING graph commands through the shared gate", () => {
  const fenceStart = SRC.indexOf('msg.cmd.startsWith("graph_") && !commandIsCanvasIndependent(msg.cmd)');
  assert.notEqual(fenceStart, -1);
  const fence = SRC.slice(fenceStart, fenceStart + 2200);
  assert.match(fence, /graphCommandMayMutateWorkflow\(msg\.cmd\)/, "reads are NOT gated — mutations are");
  assert.match(
    fence,
    /graphMutationReconnectGate\(\{[\s\S]*?backendDown: comfyBackendSocketDown,[\s\S]*?bindingSettleWindow: postReconnectBindingSettleWindow\(\)/,
    "the gate reads both live signals",
  );
  assert.ok(
    fence.indexOf("graphMutationReconnectGate({") < fence.indexOf("getGraphCtx()"),
    "the gate fires BEFORE getGraphCtx — the probes can change the canvas (the rebind heal), which would falsify 'nothing changed' (codex r6)",
  );
});

test("#663 wiring: BOTH resync sites (open + new) stamp the binding proof, TOCTOU-guarded", () => {
  const stamps =
    SRC.match(/if \(backendReconnectEpoch === openedForEpoch\) postReconnectBindingProofEpoch = openedForEpoch;/g) ?? [];
  assert.equal(stamps.length, 2, "workflow_new AND workflow_open both stamp the proof");
});

test("#663/#646 wiring: the binding gate consults the #433 window AND the proof epoch, one invariant", () => {
  const start = SRC.indexOf("function postReconnectBindingSettleWindow()");
  assert.notEqual(start, -1);
  const body = SRC.slice(start, start + 400);
  assert.match(body, /postReconnectSettleWindow\(\)/);
  assert.match(body, /postReconnectBindingProofEpoch < backendReconnectEpoch/);
});

test("#618 regression: the binding verdict still receives the #433 settle window on every fenced command", () => {
  const start = SRC.indexOf("function assertGraphBoundToActiveWorkflow(");
  assert.notEqual(start, -1);
  const body = SRC.slice(start, SRC.indexOf("function stampGraphRootWorkflowUuid", start));
  assert.match(body, /postReconnectWindow: postReconnectSettleWindow\(\)/);
});

test("#646 wiring: the async write boundary re-checks the gate (a dispatch can span a backend drop)", () => {
  const start = SRC.indexOf("function revalidateGraphMutationContext(");
  assert.notEqual(start, -1);
  const body = SRC.slice(start, start + 1400);
  assert.match(
    body,
    /graphMutationReconnectGate\(\{[\s\S]*?backendDown: comfyBackendSocketDown,[\s\S]*?bindingSettleWindow: postReconnectBindingSettleWindow\(\)/,
    "the pre-write revalidation consults the same live signals",
  );
  assert.ok(
    body.indexOf("graphMutationReconnectGate({") < body.indexOf("getGraphCtx()"),
    "the gate fires BEFORE getGraphCtx — the probe can change the canvas (the rebind heal), which would falsify 'nothing changed' (codex r7)",
  );
  assert.ok(
    body.indexOf("graphMutationReconnectGate({") < body.indexOf("assertGraphBoundToActiveWorkflow("),
    "the gate fires BEFORE the write-boundary binding assert",
  );
});
