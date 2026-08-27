// #1295 — a dynamically added node must survive workflow switch + reconnect.
//
// THE REPORT. After installing Impact Pack and restarting ComfyUI, the live
// workflow still contained the expected 31 nodes but the dynamically added
// ImpactWildcardProcessor (id 49) was absent. The panel had also reported a
// workflow identity/reconnect race after restart. Same family as #1215/#1267:
// the switch's capture writes the WRONG tab, and the outgoing tab's tracker
// never received the extra node, so reconnect restores 31.
//
// THE CAUSE. ComfyUI snapshots on user input only. `panel_add_node` lands the
// node on the live canvas, then defers the tracker snapshot until after the
// reply (#581). `workflow_open` then moves the pointer and repaints TARGET from
// TARGET's `activeState`. It used to capture into TARGET (the #1215 poison);
// after that skip, nothing flushed SOURCE while SOURCE was still active.
// SOURCE's tracker stayed at 31 nodes. Reconnect restores SOURCE from that
// tracker. Node 49 is gone.
//
// THE FIX is the inverse of #1215, not a weakening of it: flush SOURCE's live
// canvas into SOURCE's tracker BEFORE `openWorkflow` moves the pointer.
// These tests drive the SHIPPED helper, then pin that `workflow_open` actually
// calls it on `activeBefore` before the switch. Deleting either fails them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { flushSourceCanvasBeforeSwitch } from "../../web/js/lib/flush-source-before-switch.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const ORIGINAL_NODES = Array.from({ length: 31 }, (_, i) => ({
  id: i + 1,
  type: i === 0 ? "CheckpointLoaderSimple" : `Node${i + 1}`,
}));
const ADDED = { id: 49, type: "ImpactWildcardProcessor" };

const clone = (v) => JSON.parse(JSON.stringify(v));

function makeSource(nodes) {
  return {
    path: "workflows/source.json",
    isModified: false,
    changeTracker: { activeState: { nodes: clone(nodes), links: [] } },
  };
}

function makeTarget() {
  return {
    path: "workflows/target.json",
    isModified: false,
    changeTracker: { activeState: { nodes: [{ id: 1, type: "Note" }], links: [] } },
  };
}

/** Models `captureCanvasIntoTracker`: serialize the LIVE canvas into SOURCE. */
function capturingFrom(liveCanvas) {
  const calls = [];
  const captureCanvasIntoTracker = (wf) => {
    calls.push(wf);
    wf.changeTracker.activeState = clone(liveCanvas);
    wf.isModified = true;
    return { verdict: "captured" };
  };
  return { captureCanvasIntoTracker, calls };
}

function ids(state) {
  return (state?.nodes ?? []).map((n) => n.id);
}

// ---------------------------------------------------------------------------
// Behaviour of the shipped helper
// ---------------------------------------------------------------------------

test("#1295: a dynamically added node on the live canvas lands in SOURCE's tracker before the switch", async () => {
  const source = makeSource(ORIGINAL_NODES);
  const target = makeTarget();
  const liveCanvas = { nodes: [...clone(ORIGINAL_NODES), ADDED], links: [] };
  const { captureCanvasIntoTracker, calls } = capturingFrom(liveCanvas);

  const result = await flushSourceCanvasBeforeSwitch({
    source,
    target,
    sameWorkflowObject: (a, b) => a === b,
    describeLiveCanvasBinding: () => "unknown",
    captureCanvasIntoTracker,
  });

  assert.equal(result.flushed, true);
  assert.equal(result.verdict, "captured");
  assert.equal(calls.length, 1, "exactly one capture");
  assert.equal(calls[0], source, "the capture must write SOURCE, never TARGET");
  assert.ok(
    ids(source.changeTracker.activeState).includes(49),
    "ImpactWildcardProcessor id 49 must be in SOURCE's tracker before the switch",
  );
  assert.equal(source.changeTracker.activeState.nodes.length, 32);
  assert.equal(source.isModified, true, "the extra node is unsaved work, not a clean tab");
  assert.equal(
    target.changeTracker.activeState.nodes.length,
    1,
    "#1215: TARGET's state must not be rewritten by this flush",
  );
});

test("#1295: reconnect restore from the flushed tracker still has the added node", async () => {
  // The reconnect half: ComfyUI restores open tabs from ChangeTracker state, not
  // from the live canvas (that object is gone). If the flush did not land, this
  // restore is 31 nodes and id 49 is unrecoverable.
  const source = makeSource(ORIGINAL_NODES);
  const liveCanvas = { nodes: [...clone(ORIGINAL_NODES), ADDED], links: [] };
  const { captureCanvasIntoTracker } = capturingFrom(liveCanvas);

  await flushSourceCanvasBeforeSwitch({
    source,
    target: makeTarget(),
    sameWorkflowObject: (a, b) => a === b,
    describeLiveCanvasBinding: () => "bound",
    captureCanvasIntoTracker,
  });

  const restoredAfterReconnect = clone(source.changeTracker.activeState);
  assert.ok(
    restoredAfterReconnect.nodes.some((n) => n.id === 49 && n.type === "ImpactWildcardProcessor"),
    "the reconnect restore must still carry ImpactWildcardProcessor id 49",
  );
  assert.equal(restoredAfterReconnect.nodes.length, 32);
});

test("#1295: WITHOUT the flush, reconnect restore loses the added node — that is the bug", () => {
  const source = makeSource(ORIGINAL_NODES);
  const liveCanvas = { nodes: [...clone(ORIGINAL_NODES), ADDED], links: [] };
  // No flush. The switch discards the live canvas; reconnect reads the tracker.
  assert.equal(liveCanvas.nodes.length, 32, "the canvas DID hold the extra node");
  const restoredAfterReconnect = clone(source.changeTracker.activeState);
  assert.equal(restoredAfterReconnect.nodes.length, 31);
  assert.ok(
    !restoredAfterReconnect.nodes.some((n) => n.id === 49),
    "the unflushed tracker is the 31-node report",
  );
});

test("#1295: already-current (no pointer move) does not recapture — #874's target capture owns that", async () => {
  const source = makeSource(ORIGINAL_NODES);
  let captures = 0;
  const result = await flushSourceCanvasBeforeSwitch({
    source,
    target: source,
    sameWorkflowObject: (a, b) => a === b,
    describeLiveCanvasBinding: () => "bound",
    captureCanvasIntoTracker: () => {
      captures += 1;
      return { verdict: "captured" };
    },
  });
  assert.equal(result.flushed, false);
  assert.equal(result.reason, "already-current");
  assert.equal(captures, 0);
});

test("#1295: a FOREIGN canvas is not imported into SOURCE — that is the #1215 poison the other way", async () => {
  const source = makeSource(ORIGINAL_NODES);
  let captures = 0;
  const result = await flushSourceCanvasBeforeSwitch({
    source,
    target: makeTarget(),
    sameWorkflowObject: (a, b) => a === b,
    describeLiveCanvasBinding: () => "foreign",
    captureCanvasIntoTracker: () => {
      captures += 1;
      return { verdict: "captured" };
    },
  });
  assert.equal(result.flushed, false);
  assert.equal(result.reason, "foreign");
  assert.equal(captures, 0);
  assert.equal(source.changeTracker.activeState.nodes.length, 31, "SOURCE's tracker is untouched");
});

test("#1295: an untagged ('unknown') source MUST flush — that is the Persist=false restart case", async () => {
  const source = makeSource(ORIGINAL_NODES);
  const liveCanvas = { nodes: [...clone(ORIGINAL_NODES), ADDED], links: [] };
  const { captureCanvasIntoTracker } = capturingFrom(liveCanvas);
  const result = await flushSourceCanvasBeforeSwitch({
    source,
    target: makeTarget(),
    sameWorkflowObject: (a, b) => a === b,
    describeLiveCanvasBinding: () => "unknown",
    captureCanvasIntoTracker,
  });
  assert.equal(result.flushed, true);
  assert.ok(ids(source.changeTracker.activeState).includes(49));
});

test("#1295: a pending capture is awaited — otherwise the switch races the snapshot", async () => {
  const source = makeSource(ORIGINAL_NODES);
  const liveCanvas = { nodes: [...clone(ORIGINAL_NODES), ADDED], links: [] };
  let resolveSettled;
  const settled = new Promise((resolve) => {
    resolveSettled = resolve;
  });
  const pending = flushSourceCanvasBeforeSwitch({
    source,
    target: makeTarget(),
    sameWorkflowObject: (a, b) => a === b,
    describeLiveCanvasBinding: () => "bound",
    captureCanvasIntoTracker: (wf) => {
      queueMicrotask(() => {
        wf.changeTracker.activeState = clone(liveCanvas);
        resolveSettled("captured");
      });
      return { verdict: "pending", settled };
    },
  });
  const result = await pending;
  assert.equal(result.flushed, true);
  assert.equal(result.verdict, "captured");
  assert.ok(ids(source.changeTracker.activeState).includes(49));
});

test("#1295: a throwing capture never blocks the switch", async () => {
  const source = makeSource(ORIGINAL_NODES);
  const result = await flushSourceCanvasBeforeSwitch({
    source,
    target: makeTarget(),
    sameWorkflowObject: (a, b) => a === b,
    describeLiveCanvasBinding: () => {
      throw new Error("oracle exploded");
    },
    captureCanvasIntoTracker: () => {
      throw new Error("serialize failed");
    },
  });
  assert.equal(result.flushed, false);
  assert.equal(result.reason, "failed");
});

test("#1295: no source (nothing was active) is a no-op, not a throw", async () => {
  const result = await flushSourceCanvasBeforeSwitch({
    source: null,
    target: makeTarget(),
    sameWorkflowObject: (a, b) => a === b,
    describeLiveCanvasBinding: () => "bound",
    captureCanvasIntoTracker: () => {
      throw new Error("must not capture");
    },
  });
  assert.equal(result.flushed, false);
  assert.equal(result.reason, "no-source");
});

test("#1295: sameWorkflowObject, not `===`, decides already-current (proxied workflow objects)", async () => {
  const source = makeSource(ORIGINAL_NODES);
  const targetProxy = { ...source };
  let captures = 0;
  const result = await flushSourceCanvasBeforeSwitch({
    source,
    target: targetProxy,
    sameWorkflowObject: () => true,
    describeLiveCanvasBinding: () => "bound",
    captureCanvasIntoTracker: () => {
      captures += 1;
      return { verdict: "captured" };
    },
  });
  assert.equal(result.flushed, false);
  assert.equal(result.reason, "already-current");
  assert.equal(captures, 0);
});

// ---------------------------------------------------------------------------
// Wiring — deleting the call in workflow_open must fail these
// ---------------------------------------------------------------------------

test("#1295: workflow_open flushes SOURCE (activeBefore) BEFORE openWorkflow moves the pointer", () => {
  assert.match(
    SRC,
    /import \{\s*flushSourceCanvasBeforeSwitch\s*\} from "\.\/lib\/flush-source-before-switch\.js"/,
    "the shipped helper must be imported, not inlined",
  );

  const snapAt = SRC.indexOf("const activeBefore = activeWorkflowRef();");
  const flushAt = SRC.indexOf("await flushSourceCanvasBeforeSwitch({");
  const openAt = SRC.indexOf("await s.openWorkflow(target);");
  assert.notEqual(snapAt, -1, "the pre-switch pointer must still be snapshotted (#1215)");
  assert.notEqual(flushAt, -1, "the source flush must exist");
  assert.notEqual(openAt, -1, "openWorkflow is what moves the pointer");
  assert.ok(snapAt < flushAt, "activeBefore is captured before the flush reads it");
  assert.ok(flushAt < openAt, "the flush must run while SOURCE is still the active pointer");

  const call = SRC.slice(flushAt, SRC.indexOf("});", flushAt) + 3);
  assert.match(call, /source:\s*activeBefore/, "the flush target is the outgoing tab");
  assert.doesNotMatch(
    call,
    /source:\s*target/,
    "flushing TARGET would be the #1215 poison",
  );
  assert.match(call, /describeLiveCanvasBinding/, "foreign canvases must still skip");
  assert.match(call, /captureCanvasIntoTracker/, "the flush uses the proven capture helper");
  assert.match(call, /sameWorkflowObject/, "already-current is object identity, not path text");
});

test("#1295: the #1215 TARGET capture gate still skips an untagged switch — this flush does not reopen it", () => {
  const gateAt = SRC.indexOf("const captureBinding = describeLiveCanvasBinding(target);");
  assert.notEqual(gateAt, -1, "#1215's target capture gate must remain");
  const flushAt = SRC.indexOf("await flushSourceCanvasBeforeSwitch({");
  assert.ok(flushAt < gateAt, "source flush is BEFORE the switch; target capture is AFTER");
  const gate = SRC.slice(gateAt, SRC.indexOf("await target.changeTracker?.checkState?.()", gateAt));
  assert.match(gate, /!pointerMovedThisOpen/);
  assert.match(gate, /captureBinding !== "foreign"/);
  assert.doesNotMatch(
    gate,
    /if \(captureBinding !== "foreign"\)/,
    '"not foreign" alone was the #1215 hole — the source flush must not bring it back',
  );
});
