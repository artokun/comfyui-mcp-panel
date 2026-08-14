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
  reconnectRefusalError,
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
  const { message: msg } = graphMutationReconnectGate({ cmd: "graph_set_widget", backendDown: true });
  assert.match(msg, /\[backend-reconnecting\]/);
  assert.match(msg, /"graph_set_widget"/, "the refusal names the command it refused");
  assert.match(msg, /NOT applied — nothing changed/, "the refusal is honest that nothing ran");
  assert.match(msg, /Retry/, "the remedy is actionable from the caller's state");
});

test("#646: the unproven-binding window refuses and names the escalate-after-30s remedy", () => {
  const { message: msg } = graphMutationReconnectGate({ cmd: "graph_add_node", bindingSettleWindow: true });
  assert.match(msg, /\[post-reconnect-settling\]/);
  assert.match(msg, /NOT applied — nothing changed/);
  assert.match(msg, /panel_open_workflow/, "the persistent case names the proven-rebind remedy");
});

test("#646: backend-down takes precedence over the settle window (both true)", () => {
  const { message: msg, code } = graphMutationReconnectGate({
    cmd: "graph_run",
    backendDown: true,
    bindingSettleWindow: true,
  });
  assert.match(msg, /\[backend-reconnecting\]/);
  assert.equal(code, "backend-reconnecting", "the CODE agrees with the message, not just the prose");
});

// ── #1529: the refusal is STRUCTURE, not a sentence ─────────────────────────
//
// The property a retry depends on — "the executor did not run" — was previously
// only stated in prose. A reader that matched the text to decide a retry was safe
// was reverted as a P0: acknowledged panel errors travel as arbitrary text, so a
// genuine MID-WRITE failure can contain the same words, and being wrong there
// double-applies a graph mutation. These tests fence the field, not the wording.

test("#1529: every refusal carries applied:false / pre-executor / retryable", () => {
  for (const args of [
    { cmd: "graph_set_widget", backendDown: true },
    { cmd: "graph_add_node", bindingSettleWindow: true },
    { cmd: "graph_run", backendDown: true, bindingSettleWindow: true },
  ]) {
    const refusal = graphMutationReconnectGate(args);
    assert.equal(refusal.applied, false, JSON.stringify(args));
    assert.equal(refusal.stage, "pre-executor", JSON.stringify(args));
    assert.equal(refusal.retryable, true, JSON.stringify(args));
    assert.equal(typeof refusal.code, "string");
    assert.ok(refusal.code.length > 0, "a refusal without a code is not machine-readable");
  }
});

test("#1529: the two codes are DISTINCT — a reader can tell the cases apart", () => {
  // They differ in remedy (wait for the socket vs re-prove the binding), so a
  // reader that collapsed them would retry the wrong one forever.
  assert.notEqual(
    graphMutationReconnectGate({ cmd: "graph_run", backendDown: true }).code,
    graphMutationReconnectGate({ cmd: "graph_run", bindingSettleWindow: true }).code,
  );
});

test("#1529: NO refusal still means null — the gate did not become truthy-always", () => {
  // The direction that would be catastrophic: an object is truthy, so if the
  // clean path started returning one, EVERY graph mutation would refuse.
  assert.equal(graphMutationReconnectGate({ cmd: "graph_run" }), null);
  assert.equal(graphMutationReconnectGate({ cmd: "graph_run", backendDown: false }), null);
  assert.equal(graphMutationReconnectGate(), null);
});

test("#1529: reconnectRefusalError keeps the message and attaches the structure", () => {
  const refusal = graphMutationReconnectGate({ cmd: "graph_set_widget", backendDown: true });
  const err = reconnectRefusalError(refusal);
  assert.ok(err instanceof Error, "it must still be throwable/catchable as an Error");
  assert.equal(err.message, refusal.message, "the human-readable text is UNCHANGED from before");
  assert.deepEqual(err.cmcpRefusal, {
    code: "backend-reconnecting",
    applied: false,
    stage: "pre-executor",
    retryable: true,
  });
});

test("#1529: the structure does not collide with Error's own fields", () => {
  // Deliberately a namespaced property: `code` and `message` on an Error already
  // mean other things to other catch blocks in the panel, and quietly changing
  // what `err.code` means is the collision that surfaces months later.
  const err = reconnectRefusalError(graphMutationReconnectGate({ cmd: "graph_run", backendDown: true }));
  assert.equal(err.code, undefined, "Error.code is left alone");
  assert.equal(err.applied, undefined);
  assert.equal(err.retryable, undefined);
});

// ── The wiring: the field only helps if it REACHES the reply ────────────────
//
// TESTED below: both call sites throw the structured error, and the wire-reply
// builder publishes it.
//
// NOT TESTED, MEASURED by reading — the throw survives the trip. A catch between
// a call site and the reply that rebuilt the Error would strip `cmcpRefusal`
// silently, leaving `error` intact and the field simply absent: a no-op that
// looks exactly like success. The file has 211 `throw new Error(`, of which four
// rebuild from a caught error — lines ~5570 (manager fetch), ~10933 (graph JSON
// parse), ~14653 (rename), ~16288 (canvas draw) — and none is on a path from
// either gate. The one rethrow that IS on a command path (~13479, workflow_new)
// is `throw err instanceof Error ? err : new Error(…)`, which preserves identity
// and therefore the property.
//
// A brace-counting "is there an enclosing catch" scan was written and REMOVED:
// its function-boundary heuristic silently bound the wrong slice and reported a
// clean answer for a function 1500 lines away. Same lesson as #1478 — a wiring
// scan that mis-bounds is worse than a note, because it reports PASS.

test("#1529 wiring: both gate call sites throw the STRUCTURED error", () => {
  // A call site left on `new Error(gate)` would stringify the object to
  // "[object Object]" — the gate's own message lost AND no field published.
  assert.equal(
    (SRC.match(/if \(reconnectGate\) throw reconnectRefusalError\(reconnectGate\);/g) ?? []).length,
    2,
    "both graph-mutation entry points throw the structured refusal",
  );
  assert.doesNotMatch(
    SRC,
    /throw new Error\(reconnectGate\)/,
    "no call site may still throw the bare gate value",
  );
});

test("#1529 wiring: the reply builder publishes `refusal` and leaves `error` alone", () => {
  // Anchored on the WIRE-REPLY builder specifically. `coerceMessageText(err…)`
  // appears at 14 sites in this file — journal entries (noteOpenAttempt) and UI
  // toasts among them — and the first occurrence is a workflow_new journal write,
  // not this. An anchor that matched the wrong one passed its assertions against
  // unrelated text, which is how a wiring test goes vacuous.
  const start = SRC.indexOf("reply = {\n            rid: msg.rid,\n            ok: false,");
  assert.notEqual(start, -1, "the acknowledged-error WIRE reply builder is still recognisable");
  const block = SRC.slice(start, start + 900);
  assert.match(block, /error: coerceMessageText\(err\?\.message \?\? err\),/, "the text reply is intact");
  assert.match(
    block,
    /\.\.\.\(err\?\.cmcpRefusal \? \{ refusal: err\.cmcpRefusal \} : \{\}\)/,
    "the structured refusal rides along on the reply",
  );
  // Additive: the spread is CONDITIONAL, so an ordinary error's reply has no
  // `refusal` key at all — a reader keying on presence cannot be fooled by an
  // unrelated failure.
  assert.match(block, /err\?\.cmcpRefusal \?/, "absent on every error that is not this gate's");
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
