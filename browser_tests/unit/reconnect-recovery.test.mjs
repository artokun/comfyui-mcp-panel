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
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  watchPostReconnectSettle,
  graphMutationReconnectGate,
  reconnectRefusalError,
  readReconnectRefusal,
  backendSocketIsDown,
  classifyBackendStatusEvent,
  describeGraphMutationReadiness,
  WS_OPEN,
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

// ---------------------------------------------------------------------------
// #1325 — sticky down-flag vs live socket
// ---------------------------------------------------------------------------

test("#1325: a flagged-down socket that is still OPEN is not down", () => {
  // ComfyUI's `_pollQueue` dispatches status(null) on a failed /prompt while a
  // long Wan render blocks the backend. The websocket never left OPEN.
  assert.equal(backendSocketIsDown({ flaggedDown: true, socketReadyState: WS_OPEN }), false);
});

test("#1325: a flagged-down socket that is not OPEN is down", () => {
  assert.equal(backendSocketIsDown({ flaggedDown: true, socketReadyState: 0 }), true, "CONNECTING");
  assert.equal(backendSocketIsDown({ flaggedDown: true, socketReadyState: 2 }), true, "CLOSING");
  assert.equal(backendSocketIsDown({ flaggedDown: true, socketReadyState: 3 }), true, "CLOSED");
  assert.equal(backendSocketIsDown({ flaggedDown: true }), true, "unknown readyState fails closed");
});

test("#1325: an unflagged socket is never down, even if readyState is missing", () => {
  assert.equal(backendSocketIsDown({ flaggedDown: false, socketReadyState: 3 }), false);
  assert.equal(backendSocketIsDown({}), false);
});

test("#1325: a real status payload is the backend talking", () => {
  assert.equal(
    classifyBackendStatusEvent({ detail: { exec_info: { queue_remaining: 0 } }, socketReadyState: 3 }),
    "alive",
  );
});

test("#1325: a null status while the socket is OPEN is a busy poll, not a drop", () => {
  assert.equal(classifyBackendStatusEvent({ detail: null, socketReadyState: WS_OPEN }), "ignore");
  assert.equal(classifyBackendStatusEvent({ detail: undefined, socketReadyState: WS_OPEN }), "ignore");
});

test("#1325: a null status while the socket is not OPEN is a lost connection", () => {
  assert.equal(classifyBackendStatusEvent({ detail: null, socketReadyState: 3 }), "lost");
  assert.equal(classifyBackendStatusEvent({ detail: null }), "lost", "unknown readyState fails closed");
});

test("#1325: binding status distinguishes canvas identity from backend readiness", () => {
  const down = describeGraphMutationReadiness({
    flaggedDown: true,
    socketReadyState: 3,
    canvasBinding: "bound",
  });
  assert.equal(down.graph_binding, "reconnecting");
  assert.equal(down.canvas_binding, "bound", "the canvas is still this workflow's");
  assert.equal(down.backend_socket, "reconnecting");
  assert.equal(down.mutations_ready, false);
  assert.match(down.backend_socket_note, /reload the ComfyUI page or restart ComfyUI/);

  const up = describeGraphMutationReadiness({
    flaggedDown: true,
    socketReadyState: WS_OPEN,
    canvasBinding: "bound",
  });
  assert.equal(up.graph_binding, "bound");
  assert.equal(up.backend_socket, "up");
  assert.equal(up.mutations_ready, true);
  assert.equal(up.backend_socket_note, undefined);
});

test("#1325: a live execution after a Wan render must not stay gated", () => {
  // The shipped path: flag armed by a busy-poll null status, socket still OPEN.
  assert.equal(
    graphMutationReconnectGate({
      cmd: "graph_set_widget",
      backendDown: backendSocketIsDown({ flaggedDown: true, socketReadyState: WS_OPEN }),
    }),
    null,
    "OPEN socket + sticky flag must not refuse the mutation",
  );
  const stillDown = graphMutationReconnectGate({
    cmd: "graph_set_widget",
    backendDown: backendSocketIsDown({ flaggedDown: true, socketReadyState: 3 }),
  });
  assert.equal(stillDown?.code, "backend-reconnecting");
});

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

// ── The reader: which errors are ENTITLED to publish a refusal ──────────────
//
// Review, P0: the first version of the reply builder tested `err?.cmcpRefusal`
// — an unqualified property read. That answers "something set this", when the
// question a retry depends on is "the GATE set this, before the executor ran".
// They differ in exactly the case that costs a graph: an error thrown AFTER a
// write, carrying the property by inheritance or assignment, published as
// applied:false and retried into a duplicate node.
//
// These run the reader; they are not source scans.

test("#1529 reader: a genuine gate refusal is published", () => {
  const err = reconnectRefusalError(graphMutationReconnectGate({ cmd: "graph_run", backendDown: true }));
  assert.deepEqual(readReconnectRefusal(err), {
    code: "backend-reconnecting",
    applied: false,
    stage: "pre-executor",
    retryable: true,
  });
});

test("#1529 mint: only the GATE's own return value may be minted", () => {
  // Re-review, P0: the mint used to accept any object of the right shape, which
  // made it an unrestricted authority — a call site added AFTER a write could
  // hand it a literal and publish "nothing was applied" about a write that had
  // already landed. The retry then duplicates the node.
  const handBuilt = {
    code: "backend-reconnecting",
    message: "looks exactly like the real thing",
    applied: false,
    stage: "pre-executor",
    retryable: true,
  };
  assert.throws(() => reconnectRefusalError(handBuilt), /only be minted from graphMutationReconnectGate/);
  // A COPY of a genuine refusal is not the genuine refusal either — the brand is
  // on the object, so spreading it does not carry the authority.
  const real = graphMutationReconnectGate({ cmd: "graph_run", backendDown: true });
  assert.throws(() => reconnectRefusalError({ ...real }), /only be minted/);
  for (const junk of [null, undefined, "backend-reconnecting", 42, []]) {
    assert.throws(() => reconnectRefusalError(junk), TypeError, String(junk));
  }
  // …and the genuine one still mints.
  assert.equal(readReconnectRefusal(reconnectRefusalError(real))?.code, "backend-reconnecting");
});

test("#1529 mint: the gate only produces a refusal when it actually REFUSES", () => {
  // The property that makes gate-provenance meaningful: there is no way to get a
  // branded object out of the gate on the clean path, so a minted error implies
  // an instability signal was live.
  assert.equal(graphMutationReconnectGate({ cmd: "graph_run" }), null);
  assert.throws(() => reconnectRefusalError(graphMutationReconnectGate({ cmd: "graph_run" })), TypeError);
});

test("#1529 reader: a FOREIGN error with a perfect-looking payload is refused", () => {
  // The forged case. Every field is exactly right; the only thing missing is
  // that this gate did not mint it — which is the whole claim.
  const impostor = new Error("added the node, then the socket died");
  impostor.cmcpRefusal = {
    code: "backend-reconnecting",
    applied: false,
    stage: "pre-executor",
    retryable: true,
  };
  assert.equal(readReconnectRefusal(impostor), null);
});

test("#1529 reader: an INHERITED payload is refused (prototype pollution)", () => {
  // The accidental version, and the reason this is a WeakSet and not a marker
  // property: one assignment to Error.prototype would otherwise make every
  // error in the page — including a post-write failure — read as retryable.
  const polluted = { code: "backend-reconnecting", applied: false, stage: "pre-executor", retryable: true };
  Object.defineProperty(Error.prototype, "cmcpRefusal", {
    value: polluted,
    configurable: true,
    enumerable: false,
  });
  try {
    const midWriteFailure = new Error("node added, then the tab went away");
    assert.equal(midWriteFailure.cmcpRefusal, polluted, "the pollution really is visible on the error");
    assert.equal(readReconnectRefusal(midWriteFailure), null, "and the reader still refuses it");
    // A MINTED error must still work while the prototype is polluted, and must
    // publish its OWN payload rather than the inherited one.
    const real = reconnectRefusalError(graphMutationReconnectGate({ cmd: "graph_run", bindingSettleWindow: true }));
    assert.equal(readReconnectRefusal(real)?.code, "post-reconnect-settling");
  } finally {
    delete Error.prototype.cmcpRefusal;
  }
  assert.equal("cmcpRefusal" in Error.prototype, false, "the test cleaned up after itself");
});

test("#1529 reader: a MINTED error that lost its own payload cannot borrow one", () => {
  // The case the own-property check exists for, and the only one where it is
  // load-bearing — mutation testing showed that deleting the check otherwise
  // kills nothing, because the mint check already rejects foreign errors.
  //
  // The sequence is narrow but real: something strips unknown properties off an
  // error (a sanitizer before logging is the usual culprit), and the prototype
  // carries a payload. Without the own check the error is still MINTED, so the
  // reader would fall through to the inherited object and publish a refusal
  // sourced from something the gate never wrote.
  const err = reconnectRefusalError(graphMutationReconnectGate({ cmd: "graph_run", backendDown: true }));
  delete err.cmcpRefusal;
  Object.defineProperty(Error.prototype, "cmcpRefusal", {
    value: { code: "backend-reconnecting", applied: false, stage: "pre-executor", retryable: true },
    configurable: true,
    writable: true,
    enumerable: false,
  });
  try {
    assert.ok(err.cmcpRefusal, "the inherited payload really is reachable on this error");
    assert.equal(readReconnectRefusal(err), null, "but it is not this gate's, so it is not published");
  } finally {
    delete Error.prototype.cmcpRefusal;
  }
});

test("#1529 reader: a minted error whose payload was TAMPERED with is refused", () => {
  // Minting happens at throw time; the payload is a mutable object on a mutable
  // error, so being minted does not prove it was unmodified at catch time.
  for (const tamper of [
    (p) => { p.applied = true; },
    (p) => { p.stage = "post-executor"; },
    (p) => { p.retryable = false; },
    (p) => { p.code = "something-else"; },
    (p) => { delete p.code; },
  ]) {
    const err = reconnectRefusalError(graphMutationReconnectGate({ cmd: "graph_run", backendDown: true }));
    tamper(err.cmcpRefusal);
    assert.equal(readReconnectRefusal(err), null, tamper.toString());
  }
});

test("#1529 reader: a minted error whose payload was REPLACED wholesale is refused", () => {
  const err = reconnectRefusalError(graphMutationReconnectGate({ cmd: "graph_run", backendDown: true }));
  err.cmcpRefusal = { code: "backend-reconnecting", applied: false, stage: "pre-executor", retryable: true };
  // Still an own property and still perfectly shaped — but no longer the object
  // the gate built. Identity is what is checked, so this is accepted; the test
  // records that deliberately, because the WeakSet brands the ERROR, not the
  // payload, and an attacker-shaped payload on a minted error can only come from
  // code that already holds the gate's own error object.
  assert.deepEqual(readReconnectRefusal(err)?.code, "backend-reconnecting");
});

test("#1529 reader: the published object is FRESH — extras do not ride to the wire", () => {
  const err = reconnectRefusalError(graphMutationReconnectGate({ cmd: "graph_run", backendDown: true }));
  err.cmcpRefusal.smuggled = { token: "sensitive" };
  const published = readReconnectRefusal(err);
  assert.deepEqual(Object.keys(published).sort(), ["applied", "code", "retryable", "stage"]);
  assert.notEqual(published, err.cmcpRefusal, "a fresh object, not the caught payload");
});

test("#1529 reader: non-errors and ordinary failures answer null", () => {
  for (const v of [null, undefined, 0, "", "backend-reconnecting", {}, new Error("boom"), [], Symbol("x")]) {
    assert.equal(readReconnectRefusal(v), null, String(typeof v));
  }
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
  const start = SRC.indexOf("reply = { rid: msg.rid, ok: true, result };\n        } catch (err) {");
  assert.notEqual(start, -1, "the acknowledged-error WIRE reply builder is still recognisable");
  const block = SRC.slice(start, start + 1800);
  assert.match(block, /reply = \{\n\s+rid: msg\.rid,\n\s+ok: false,/, "…and this is its failure branch");
  assert.match(block, /error: coerceMessageText\(err\?\.message \?\? err\),/, "the text reply is intact");
  assert.match(
    block,
    /\.\.\.\(reconnectRefusal \? \{ refusal: reconnectRefusal \} : \{\}\)/,
    "the structured refusal rides along on the reply",
  );
  // Through the READER, never the raw property — that distinction is the P0.
  assert.match(block, /const reconnectRefusal = readReconnectRefusal\(err\);/);
});

test("#1529 audit: NO shipped module touches the raw property outside a comment", () => {
  // Re-review, P2: the first version of this asserted `doesNotMatch(SRC,
  // /refusal: err\.cmcpRefusal/)` — one spelling, in one file. `const r =
  // err?.cmcpRefusal`, `err["cmcpRefusal"]`, an alias, or a second reply path in
  // another module all slipped past it while it reported PASS.
  //
  // The exact form instead: the token may appear ONLY in reconnect-recovery.js
  // (which owns it), and anywhere else only inside a comment. Line-level, so no
  // tokenizer is needed and it cannot mis-bound a slice — the failure that got a
  // brace-counting version of this deleted.
  const dir = fileURLToPath(new URL("../../web/js/", import.meta.url));
  const offenders = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      if (full.replace(/\\/g, "/").endsWith("lib/reconnect-recovery.js")) continue; // the owner
      const text = readFileSync(full, "utf8");
      text.split("\n").forEach((line, i) => {
        if (!line.includes("cmcpRefusal")) return;
        // A comment may name it — but only a line that is ENTIRELY comment.
        // `/* compat */ reply.refusal = err.cmcpRefusal;` starts with a block
        // opener and is executable code (review r3), so a leading-token test
        // alone would wave it through.
        const isWholeLineComment =
          /^\s*(\/\/|\*)/.test(line) || (/^\s*\/\*/.test(line) && !/\*\/\s*\S/.test(line));
        if (isWholeLineComment) return;
        offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk(dir);
  assert.deepEqual(
    offenders,
    [],
    "every consumer must go through readReconnectRefusal, which checks provenance;\n" +
      "a raw read publishes an inherited or post-write payload as safe-to-retry",
  );
});

test("#1529 audit: the mint has exactly the two known, PRE-EXECUTOR call sites", () => {
  // Gate-provenance stops a FORGED refusal but not a genuine one raised late: a
  // caller could invoke the gate after a write and throw its refusal. Nothing in
  // the type system can see that, so the remaining guarantee is positional, and
  // this is what pins it — a third call site fails here and has to be justified.
  //
  // The two that exist: revalidateGraphMutationContext's preflight (before
  // getGraphCtx, before any write) and the dispatch gate (before the executor).
  // Counts every REFERENCE to the identifier, not `name(` — `(reconnectRefusalError)(gate)`,
  // `const mint = reconnectRefusalError`, or a re-export all read as zero call
  // sites to a `name\(` regex while adding one (review r3). Three references:
  // the import binding, and the two throws.
  const refs = [...SRC.matchAll(/\breconnectRefusalError\b/g)].length;
  assert.equal(refs, 3, "a new mint reference must be reviewed for 'is this before the executor?'");
  // …and the two that exist are still the throws, not something else.
  assert.equal([...SRC.matchAll(/throw reconnectRefusalError\(reconnectGate\);/g)].length, 2);
});

// NOT PROVABLE HERE, and stated rather than implied: none of the above shows
// that either call site is still PRE-EXECUTOR. Moving an existing mint below a
// graph write keeps every count in this file unchanged (review r3), and no
// source scan decides it — "has this dispatch written yet" is runtime state.
//
// What the counts buy is that the set cannot GROW silently, which is the way a
// post-write mint would realistically arrive. The two sites carry the argument
// at the call itself: revalidateGraphMutationContext's gate runs before
// getGraphCtx and before any write, and the dispatch gate runs before the
// executor. Both comments say so, and both are load-bearing for `applied:false`.

test("#1529 wiring: the reply is serialized WHOLE, not projected to a field list", () => {
  // The reviewer's P2: a send boundary that rebuilt the frame as {rid, ok, error}
  // would drop `refusal` silently — the tests above would all still pass while
  // the contract was gone. Asserted on the actual send.
  assert.match(SRC, /thisSock\.send\(JSON\.stringify\(reply\)\)/, "the whole reply object goes to the wire");
});

// ---------------------------------------------------------------------------
// Panel wiring (source scans — deleting the wiring fails these)
// ---------------------------------------------------------------------------

test("#663 wiring: the 'reconnected' listener kicks the settle watch for the NEW epoch", () => {
  const start = SRC.indexOf('api.addEventListener("reconnected"');
  assert.notEqual(start, -1);
  const next = SRC.indexOf("api.addEventListener(", start + 1);
  const block = SRC.slice(start, next === -1 ? SRC.length : next);
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
    /graphMutationReconnectGate\(\{[\s\S]*?backendDown: comfyBackendIsDown\(\),[\s\S]*?bindingSettleWindow: postReconnectBindingSettleWindow\(\)/,
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
  // #1641 added a third stamp: the open's pre-load handshake wait, when it
  // proves the restored canvas is already bound. Still TOCTOU-guarded; still
  // only these two executors.
  assert.equal(stamps.length, 3, "workflow_new, workflow_open success, and the #1641 handshake wait");
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
    /graphMutationReconnectGate\(\{[\s\S]*?backendDown: comfyBackendIsDown\(\),[\s\S]*?bindingSettleWindow: postReconnectBindingSettleWindow\(\)/,
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

test("#1325 wiring: a null status only arms the flag when the live socket is not OPEN", () => {
  const start = SRC.indexOf('api.addEventListener("status"');
  assert.notEqual(start, -1);
  const block = SRC.slice(start, start + 1600);
  assert.match(block, /classifyBackendStatusEvent\(\{/, "the status handler classifies before arming");
  assert.match(block, /statusKind === "alive"/, "a real queue payload clears a stale flag");
  assert.match(block, /statusKind === "lost"/, "only a lost-connection null arms the gate");
  assert.match(block, /noteComfyBackendAlive\(\)/, "alive status un-sticks the mutation guard");
});

test("#1325 wiring: a live execution frame un-sticks the mutation guard", () => {
  for (const ev of ["execution_start", "execution_success", "executed", "progress"]) {
    const start = SRC.indexOf(`api.addEventListener("${ev}"`);
    assert.notEqual(start, -1, `${ev} listener is still wired`);
    const block = SRC.slice(start, start + 280);
    assert.match(block, /noteComfyBackendAlive\(\)/, `${ev} is proof the backend is talking`);
  }
});

test("#1325 wiring: binding-status replies publish backend readiness, not just canvas identity", () => {
  assert.match(SRC, /function backendSocketReplyFields\(/);
  assert.match(
    SRC,
    /outline,[\s\S]{0,400}?\.\.\.backendSocketReplyFields\(activeWorkflowRef\(\)\)/,
    "graph_outline discloses backend readiness beside the readable canvas",
  );
  assert.match(
    SRC,
    /\.\.\.backendSocketReplyFields\(active\),/,
    "workflow_list discloses it on the bound-tab reply",
  );
  assert.match(
    SRC,
    /\.\.\.backendSocketReplyFields\(target\),/,
    "workflow_open (set_workflow_target current) discloses it",
  );
});
