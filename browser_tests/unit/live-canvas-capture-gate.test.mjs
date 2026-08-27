// #1911 — live-canvas capture must not skip silently when Pinia `$subscribe`
// cannot be installed.
//
// THE REPORT. `activePointerProof` begins with `activePointerWatchAvailable &&`.
// That flag is true only when `getPiniaStore("workflow")?.$subscribe` returns a
// stop handle. On a frontend where any of those miss, TARGET `checkState()` is
// skipped with no other branch — the same value as "the watcher saw a move".
// #1215's remaining recurrence: SOURCE widget values survive onto the new canvas
// because nothing flushed or disclosed.
//
// THE FIX. A shipped helper either installs the watch on the workflow service
// itself (it IS the Pinia store) or, if that also fails, captures already-current
// via the pre-watch proof / skips a switch capture and DISCLOSES. SOURCE flush
// stays ungated — that is the #1295 inverse of #1215 and must not be weakened.
//
// These tests drive the SHIPPED helper, then pin that `workflow_open` actually
// calls it. `$subscribe` absent + silent skip fails them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  decideLiveCanvasCapture,
  installActivePointerWatch,
  POINTER_WATCH_UNAVAILABLE_NOTICE,
} from "../../web/js/lib/live-canvas-capture-gate.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

function piniaStore() {
  const subscribers = [];
  return {
    subscribers,
    $subscribe(observer) {
      subscribers.push(observer);
      return () => {
        const index = subscribers.indexOf(observer);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Behaviour of the shipped helper
// ---------------------------------------------------------------------------

test("#1911: watch available + pointer proof + source proof captures and stays quiet", () => {
  const decision = decideLiveCanvasCapture({
    watchAvailable: true,
    openLoaded: false,
    captureSourceProof: true,
    pointerProof: true,
    pointerMovedThisOpen: true,
  });
  assert.equal(decision.capture, true);
  assert.equal(decision.disclose, false);
  assert.equal(decision.reason, "pointer-proof");
  assert.equal(decision.notice, undefined);
});

test("#1911: watch available + unproven pointer skips capture without pretending the watch is missing", () => {
  const decision = decideLiveCanvasCapture({
    watchAvailable: true,
    captureSourceProof: true,
    pointerProof: false,
    pointerMovedThisOpen: true,
  });
  assert.equal(decision.capture, false);
  assert.equal(decision.disclose, false);
  assert.equal(decision.reason, "unproven-pointer");
});

test("#1911: $subscribe absent + tab switch does NOT capture TARGET (that is the #1215 poison) and DISCLOSES", () => {
  const decision = decideLiveCanvasCapture({
    watchAvailable: false,
    captureSourceProof: true, // "bound" after a move — the #1639 hole if trusted
    pointerProof: false,
    pointerMovedThisOpen: true,
  });
  assert.equal(decision.capture, false, "a switch without a watcher must not write SOURCE's canvas into TARGET");
  assert.equal(decision.disclose, true, "silent skip is the bug");
  assert.equal(decision.reason, "watch-unavailable-switch");
  assert.equal(decision.notice, POINTER_WATCH_UNAVAILABLE_NOTICE);
  assert.match(decision.notice, /\$subscribe/);
  assert.match(decision.notice, /panel_graph_outline/);
  assert.match(decision.notice, /panel_load_workflow/);
  assert.match(decision.notice, /REPLACES the canvas/);
});

test("#1911: $subscribe absent + already-current still captures via the pre-watch proof, and names the gap", () => {
  const decision = decideLiveCanvasCapture({
    watchAvailable: false,
    captureSourceProof: true,
    pointerProof: false,
    pointerMovedThisOpen: false,
  });
  assert.equal(decision.capture, true, "already-current is the #874 proof this path used before the watcher");
  assert.equal(decision.disclose, true);
  assert.equal(decision.reason, "watch-unavailable-already-current");
  assert.equal(decision.notice, POINTER_WATCH_UNAVAILABLE_NOTICE);
});

test("#1911: $subscribe absent + already-current + foreign source does not capture", () => {
  const decision = decideLiveCanvasCapture({
    watchAvailable: false,
    captureSourceProof: false,
    pointerProof: false,
    pointerMovedThisOpen: false,
  });
  assert.equal(decision.capture, false);
  assert.equal(decision.disclose, true);
  assert.equal(decision.reason, "watch-unavailable-unproven-source");
});

test("#1911: a just-loaded disk state is never overwritten, watch or not", () => {
  const watched = decideLiveCanvasCapture({
    watchAvailable: true,
    openLoaded: true,
    captureSourceProof: true,
    pointerProof: true,
    pointerMovedThisOpen: false,
  });
  assert.equal(watched.capture, false);
  assert.equal(watched.disclose, false);
  assert.equal(watched.reason, "loaded-from-disk");

  const unwatched = decideLiveCanvasCapture({
    watchAvailable: false,
    openLoaded: true,
    captureSourceProof: true,
    pointerProof: false,
    pointerMovedThisOpen: true,
  });
  assert.equal(unwatched.capture, false);
  assert.equal(unwatched.disclose, true);
  assert.equal(unwatched.reason, "loaded-from-disk");
});

test("#1911: installActivePointerWatch uses the Pinia store when $subscribe returns a stop handle", () => {
  const store = piniaStore();
  const observer = () => {};
  const installed = installActivePointerWatch(observer, [store]);
  assert.equal(installed.available, true);
  assert.equal(typeof installed.stop, "function");
  assert.equal(store.subscribers.length, 1);
  installed.stop();
  assert.equal(store.subscribers.length, 0);
});

test("#1911: installActivePointerWatch falls back to the workflow service when Pinia lookup misses", () => {
  const service = piniaStore();
  const observer = () => {};
  const installed = installActivePointerWatch(observer, [null, service]);
  assert.equal(installed.available, true, "the workflow service IS the Pinia store");
  assert.equal(service.subscribers.length, 1);
  installed.stop();
});

test("#1911: installActivePointerWatch is unavailable — not silently true — when no store exposes $subscribe", () => {
  const installed = installActivePointerWatch(() => {}, [null, {}, { $subscribe: "nope" }]);
  assert.equal(installed.available, false);
  assert.equal(installed.stop, null);
});

test("#1911: $subscribe that does not return a stop handle does not count as installed", () => {
  const installed = installActivePointerWatch(() => {}, [
    { $subscribe: () => undefined },
    { $subscribe: () => "not-a-function" },
  ]);
  assert.equal(installed.available, false);
});

test("#1911: a throwing $subscribe falls through to the next candidate", () => {
  const service = piniaStore();
  const installed = installActivePointerWatch(() => {}, [
    {
      $subscribe() {
        throw new Error("pinia exploded");
      },
    },
    service,
  ]);
  assert.equal(installed.available, true);
  assert.equal(service.subscribers.length, 1);
});

// ---------------------------------------------------------------------------
// Wiring — deleting the call in workflow_open must fail these
// ---------------------------------------------------------------------------

test("#1911: workflow_open imports and calls the shipped capture-gate helper", () => {
  assert.match(
    SRC,
    /import \{\s*decideLiveCanvasCapture,\s*installActivePointerWatch,\s*POINTER_WATCH_UNAVAILABLE_NOTICE,\s*\} from "\.\/lib\/live-canvas-capture-gate\.js"/,
    "the shipped helper must be imported, not inlined",
  );
  assert.match(SRC, /installActivePointerWatch\(observeActivePointer/);
  assert.match(SRC, /getPiniaStore\("workflow"\)/);
  assert.match(
    SRC,
    /installActivePointerWatch\(observeActivePointer,\s*\[\s*getPiniaStore\("workflow"\),\s*s,\s*\]\)/,
    "Pinia lookup first, then the workflow service object as the proven fallback",
  );
  assert.match(SRC, /decideLiveCanvasCapture\(\{/);
  assert.match(SRC, /watchAvailable:\s*activePointerWatchAvailable/);
  assert.match(SRC, /pointerMovedThisOpen/);
});

test("#1911: SOURCE flush is NOT gated on the Pinia watch — that is the #1215/#1295 invariant", () => {
  const flushAt = SRC.indexOf("await flushSourceCanvasBeforeSwitch({");
  const openAt = SRC.indexOf("await s.openWorkflow(target);");
  assert.notEqual(flushAt, -1, "the source flush must exist");
  assert.notEqual(openAt, -1);
  assert.ok(flushAt < openAt, "the flush must run while SOURCE is still the active pointer");

  const flushCall = SRC.slice(flushAt, SRC.indexOf("});", flushAt) + 3);
  assert.match(flushCall, /source:\s*activeBefore/, "the flush target is the outgoing tab");
  assert.doesNotMatch(
    flushCall,
    /activePointerWatchAvailable/,
    "gating SOURCE flush on the watcher would reintroduce #1215",
  );

  const beforeFlush = SRC.slice(Math.max(0, flushAt - 500), flushAt);
  assert.doesNotMatch(
    beforeFlush,
    /if\s*\(\s*activePointerWatchAvailable/,
    "SOURCE flush must not sit behind a watch-available branch",
  );
});

test("#1911: a missing watcher is named on the success reply, not swallowed", () => {
  const keyAt = SRC.indexOf("pointer_watch_unavailable:");
  assert.notEqual(keyAt, -1, "the caller must be told $subscribe could not be installed");
  assert.match(SRC.slice(Math.max(0, keyAt - 250), keyAt), /\.\.\.\(pointerWatchUnavailable/);
  assert.match(SRC, /POINTER_WATCH_UNAVAILABLE_NOTICE/);
  assert.match(SRC, /if \(!activePointerWatchAvailable\) pointerWatchUnavailable = true/);
});

test("#1911: TARGET capture still requires the #1215 already-current / not-foreign proof", () => {
  const gateAt = SRC.indexOf("const captureBinding = describeLiveCanvasBinding(target);");
  assert.notEqual(gateAt, -1);
  const captureAt = SRC.indexOf("await target.changeTracker?.checkState?.()", gateAt);
  assert.notEqual(captureAt, -1);
  const gate = SRC.slice(gateAt, captureAt);
  assert.match(gate, /pointerMovedThisOpen = !sameWorkflowObject\(activeBefore, target\)/);
  assert.match(gate, /!pointerMovedThisOpen/);
  assert.match(gate, /captureBinding !== "foreign"/);
  assert.match(gate, /decideLiveCanvasCapture/);
  assert.doesNotMatch(
    gate,
    /if \(captureBinding !== "foreign"\)/,
    '"not foreign" alone was the #1215 hole — the missing-watch path must not bring it back',
  );
});
