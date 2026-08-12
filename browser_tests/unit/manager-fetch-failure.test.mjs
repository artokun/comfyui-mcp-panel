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

test("#1472 it does NOT claim the server never received the request", () => {
  // The first cut said exactly that, and review killed it. "Failed to fetch" proves
  // only that JAVASCRIPT got no usable response: a CORS-blocked reply, a connection
  // dropped after delivery, and a proxy that failed after forwarding are
  // indistinguishable from here, and in each the mutation may already have applied.
  const msg = managerFetchFailureMessage("manager/queue/task", new TypeError("Failed to fetch"));
  assert.doesNotMatch(msg, /never saw this request/);
  assert.doesNotMatch(msg, /nothing was considered and nothing was applied/i);
  assert.doesNotMatch(msg, /safe to re-send/);
});

test("#1472 it names the uncertainty and what settles it", () => {
  const msg = managerFetchFailureMessage("manager/queue/task", new TypeError("Failed to fetch"));
  assert.match(msg, /does NOT establish that the server\s+never received the request/);
  assert.match(msg, /may already have been applied/);
  // The one action that can actually resolve it.
  assert.match(msg, /check the current state first/);
  assert.match(msg, /can apply it twice/);
});

test("#1472 a read-only call is still marked repeatable", () => {
  // Refusing to distinguish at all would make every failure look dangerous, which is
  // its own wrong answer.
  const msg = managerFetchFailureMessage("manager/queue/task", new TypeError("Failed to fetch"));
  assert.match(msg, /read-only call is safe to repeat/);
});

test("#1472 a Manager REJECTION mentioning a transport word is not reclassified", () => {
  // The dangerous direction review found: an unanchored substring test would attach
  // "no response arrived" advice to a request the server considered and refused.
  for (const m of [
    "Package validation failed: NetworkError in dependency metadata",
    "fetch failed for upstream registry",
    "Install aborted: connection refused by the pack's own installer",
  ]) {
    assert.equal(isTransportFailure(new Error(m)), false, m);
    const msg = managerFetchFailureMessage("manager/queue/task", new Error(m));
    assert.doesNotMatch(msg, /TRANSPORT failure/);
    assert.match(msg, /failed: /);
  }
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
  // The real strings each engine produces, as the WHOLE message.
  for (const s of [
    "Failed to fetch",
    "NetworkError when attempting to fetch resource",
    "Load failed",
    "fetch failed",
    "net::ERR_CONNECTION_REFUSED",
    "connection refused",
    "  Failed to fetch  ", // whitespace from a wrapper must not defeat it
  ]) {
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
