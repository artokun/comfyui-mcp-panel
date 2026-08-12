// comfyui-mcp#1472 — panel_install_node failed with bare "Failed to fetch".
//
// The reporter got that string and nothing else: no endpoint, no status, no body, so
// the install could not be diagnosed from the tool result. There genuinely is no
// status or body — "Failed to fetch" means the request never completed — but the
// ROUTE existed and was thrown away, as was the fact that this is a transport failure
// rather than a Manager rejection. Those decide whether a re-send is safe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isTransportFailure,
  managerFetchFailureMessage,
} from "../../web/js/lib/manager-fetch-failure.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("#1472 the reporter's error now names the route", () => {
  const msg = managerFetchFailureMessage("manager/queue/task", new TypeError("Failed to fetch"));
  assert.match(msg, /\/v2\/manager\/queue\/task/);
  assert.match(msg, /Failed to fetch/); // the original is preserved, not replaced
});

test("#1472 it says WHY there is no status or body, instead of omitting them", () => {
  // Silence here reads as "the tool forgot to include them". The truth is that they
  // do not exist, and saying so stops the next person looking for them.
  const msg = managerFetchFailureMessage("manager/queue/task", new TypeError("Failed to fetch"));
  assert.match(msg, /TRANSPORT failure/);
  assert.match(msg, /no HTTP status\s+or response body to report/);
});

test("#1472 it distinguishes 'never saw it' from 'rejected it'", () => {
  // The distinction the reporter asked for, and the one that decides a retry: a
  // request the server never received is safe to re-send; a rejection is not.
  const msg = managerFetchFailureMessage("manager/queue/task", new TypeError("Failed to fetch"));
  assert.match(msg, /never saw this request/);
  assert.match(msg, /nothing was considered and nothing was applied/i);
  assert.match(msg, /safe to re-send/);
});

test("#1472 it names plausible causes without asserting one", () => {
  const msg = managerFetchFailureMessage("manager/queue/task", new TypeError("Failed to fetch"));
  assert.match(msg, /stopped or\s+restarted/);
  assert.match(msg, /lost its connection/);
  assert.match(msg, /blocked by a proxy/);
  // "Likely causes" — it must not claim to know which.
  assert.doesNotMatch(msg, /because ComfyUI (is|has) (stopped|down)\b/);
});

test("#1472 an UNRECOGNISED error is not relabelled as transport", () => {
  // Claiming "the server never saw it" about an error we cannot classify would
  // authorise a re-send on a guess — the opposite of the point.
  const msg = managerFetchFailureMessage("manager/queue/task", new Error("boom"));
  assert.match(msg, /failed: boom/);
  assert.doesNotMatch(msg, /TRANSPORT failure/);
  assert.doesNotMatch(msg, /safe to re-send/);
});

test("#1472 transport detection covers the real browser strings", () => {
  for (const s of ["Failed to fetch", "NetworkError when attempting to fetch resource", "Load failed", "fetch failed", "connection refused"]) {
    assert.equal(isTransportFailure(new Error(s)), true, s);
  }
  for (const s of ["boom", "A security error has occurred", "500 Internal Server Error"]) {
    assert.equal(isTransportFailure(new Error(s)), false, s);
  }
});

test("#1472 a missing message still yields a usable error", () => {
  for (const bad of [undefined, null, new Error("")]) {
    const msg = managerFetchFailureMessage("manager/queue/task", bad);
    assert.match(msg, /\/v2\/manager\/queue\/task/);
    assert.match(msg, /no message/);
  }
});

test("#1472 WIRING: managerV2 translates a throw and passes an abort through", () => {
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.match(src, /import \{ managerFetchFailureMessage \} from "\.\/lib\/manager-fetch-failure\.js";/);
  const at = src.indexOf("async function managerV2(");
  assert.ok(at > 0, "managerV2 must exist");
  const body = src.slice(at, at + 1600);
  assert.match(body, /try \{/, "the fetch is inside a try");
  assert.match(body, /throw new Error\(managerFetchFailureMessage\(route, err\), \{ cause: err \}\)/);
  // An abort is the CALLER's own doing — relabelling it as a transport failure would
  // tell them the server never saw a request they themselves cancelled.
  assert.match(body, /if \(err\?\.name === "AbortError"\) throw err;/);
  // The original error survives as `cause`, so the stack is not lost.
  assert.match(body, /\{ cause: err \}/);
});
