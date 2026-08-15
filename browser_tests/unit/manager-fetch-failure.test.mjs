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
  // Bound the window by the function's OWN catch block rather than a byte count: a
  // fixed 1600 silently excluded the throw once #423 added a comment above it, which
  // reads as "the wiring is gone" when the wiring is fine. Ending at `if (!res) {`
  // keeps every assertion below scoped to the catch, which is the point of the window.
  const endOfCatch = src.indexOf("if (!res) {", at);
  assert.ok(endOfCatch > at, "managerV2's catch must be followed by the no-response check");
  const body = src.slice(at, endOfCatch);
  assert.match(body, /try \{/, "the fetch is inside a try");
  // #423 wrapped this throw in markManagerUnreachable() so the Manager fallback ladder
  // can see a transport failure without reading its wording. What #1472 guarantees is
  // unchanged and still asserted: the message is built by managerFetchFailureMessage
  // from the ROUTE, and the original error survives as `cause`. Only the wrapper is
  // tolerated — a bare `throw err`, or a message built any other way, still fails.
  assert.match(body, /new Error\(managerFetchFailureMessage\(route, err\), \{ cause: err \}\)/);
  // An abort is the CALLER's own doing — relabelling it as a transport failure would
  // tell them the server never saw a request they themselves cancelled.
  assert.match(body, /if \(err\?\.name === "AbortError"\) throw err;/);
  // The original error survives as `cause`, so the stack is not lost.
  assert.match(body, /\{ cause: err \}/);
});

test("#1472 a transport error carrying detail is still classified", () => {
  // Round 2 of review: patterns anchored at BOTH ends dropped every real-world variant
  // that appends a URL or an error code, losing the explanation this file exists to
  // give. Start-anchoring keeps them.
  for (const s of [
    "Failed to fetch: http://127.0.0.1:8188/api/v2/manager/queue/task",
    "NetworkError when attempting to fetch resource.",
    "Load failed (kCFErrorDomainCFNetwork:-1005)",
    "net::ERR_CONNECTION_REFUSED at /api",
    "connection refused by peer",
  ]) {
    assert.equal(isTransportFailure(new Error(s)), true, s);
  }
});

test("#1472 'fetch failed' stays EXACT because a prefix match collides", () => {
  // undici's message is short enough that a real Manager rejection begins with it.
  // Where a prefix is ambiguous, exactness wins; where it is not, tolerance wins.
  assert.equal(isTransportFailure(new Error("fetch failed")), true);
  assert.equal(isTransportFailure(new Error("fetch failed for upstream registry")), false);
});

test("#1472 WIRING: the source comment no longer claims a re-send verdict", () => {
  // The comment beside the call still said this "decides whether a re-send is safe"
  // after the message stopped saying so — contradictory guidance that would reintroduce
  // the unsafe advice on the next edit. Review caught it.
  const src = readFileSync(join(ROOT, "web/js/comfyui-mcp-panel.js"), "utf8");
  assert.equal((src.match(/decides whether a re-send is safe/g) ?? []).length, 0);
  const at = src.indexOf("comfyui-mcp#1472 — a THROW here reached the caller");
  assert.ok(at > 0);
  const block = src.slice(at, at + 900);
  assert.ok(
    /establishes neither delivery nor[\s\S]{0,12}non-delivery/.test(block),
    "the comment must say the rejection establishes neither",
  );
});
