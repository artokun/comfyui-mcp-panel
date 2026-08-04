// Regression guard for #588: every successful bridge reconnect used to append
// "Connected to ws://… — waiting for the panel agent…" to the DURABLE chat
// transcript (onLog → appendSystem), because markConnected()/start()/setUrl()
// reset the `loggedWaiting` throttle. During a ComfyUI/orchestrator restart the
// same transient line flooded the chat once per reconnect cycle, even though
// connection recovery was working normally and the status pill already shows
// the transient state.
//
// The load-bearing invariants locked here:
//   * the socket-open handler never writes the transient "waiting for the
//     panel agent" line to the transcript (the pill owns that state);
//   * the pill still flips to "connecting" on open (the state is not hidden);
//   * a genuinely WEDGED open socket (no agent handshake inside the window)
//     still surfaces its distinct warning — the transient-line removal must
//     not silence real wedge reporting;
//   * the `loggedWaiting` throttle bookkeeping is gone entirely (a resettable
//     throttle IS the flood — every reset re-arms exactly one transcript line).
//
// The callback depends on the real browser/ComfyUI environment, so inspect the
// shipped handler source directly (the panel's established wiring test
// pattern, cf. bridge-disconnect.test.mjs) rather than substitute a different
// implementation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

function panelSource() {
  return readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");
}

function socketOpenHandler() {
  const source = panelSource();
  const start = source.indexOf('thisSock.addEventListener("open", () => {');
  assert.notEqual(start, -1, "could not locate the bridge socket open handler");
  const end = source.indexOf("\n    });", start);
  assert.notEqual(end, -1, "could not locate the end of the open handler");
  return source.slice(start, end);
}

test("#588: a socket (re)open never writes the transient waiting line to the transcript", () => {
  const handler = socketOpenHandler();
  assert.doesNotMatch(
    handler,
    /onLog\(\s*[`"'][\s\S]{0,300}?waiting for the panel agent/,
    "the transient waiting state must not be appended to the durable chat transcript",
  );
  assert.doesNotMatch(
    handler,
    /appendSystem\([^)]*waiting for the panel agent/s,
    "the transient waiting state must not reach the transcript by any other path",
  );
});

test("#588: the status pill still communicates the transient connecting state", () => {
  const handler = socketOpenHandler();
  assert.match(
    handler,
    /emitStatus\("connecting"\)/,
    "removing the transcript line must not hide the state from the status pill",
  );
});

test("#588: a wedged open socket still warns (transient-line removal ≠ silence)", () => {
  const handler = socketOpenHandler();
  assert.match(
    handler,
    /no panel agent responded/,
    "the handshake-timeout wedge warning is a REAL state and must survive",
  );
});

test("#588: the resettable loggedWaiting throttle is gone (a reset re-arms the flood)", () => {
  assert.doesNotMatch(
    panelSource(),
    /\bloggedWaiting\b/,
    "the throttle that let every reconnect cycle re-log the line must be removed, not re-tuned",
  );
});
