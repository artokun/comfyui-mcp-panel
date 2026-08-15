// #654 — a FAILED restart-tab-identity resolution must not wedge the page for
// its lifetime.
//
// createRestartTabIdentity.resolve() used to cache its settled promise
// FOREVER: one contested lease window (a duplicated tab holding the identity,
// or a lease request that rejected) meant every later hello reused the cached
// `undefined`, the route stayed refused, and the tab never re-registered with
// the agent until a manual browser refresh — even after the contending tab
// closed and the lease became acquirable.
//
// The fix: a failure is retryable once per backoff window; a success stays
// cached for the page's life. These tests drive the real resolver with a
// controllable lock manager and a controllable clock — deleting either half
// (the retry, or the backoff) fails a test.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createRestartTabIdentity } from "../../web/js/lib/restart-tab-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

/** A lock manager whose grants are externally controllable. */
class ContendedLocks {
  constructor() {
    this.blocked = false;
    this.calls = 0;
    this.held = new Set();
  }

  request(name, _options, callback) {
    this.calls += 1;
    if (this.blocked || this.held.has(name)) return Promise.resolve(callback(null));
    this.held.add(name);
    return Promise.resolve(callback({ name })).finally(() => this.held.delete(name));
  }
}

function fakeStorage(seed) {
  let stored = seed;
  return {
    getItem: () => stored,
    setItem: (_k, v) => {
      stored = v;
    },
  };
}

test("#654: a failed resolve is retried after the backoff and can then succeed", async () => {
  const locks = new ContendedLocks();
  locks.blocked = true;
  let clock = 1000;
  let rotations = 0;
  const identity = createRestartTabIdentity({
    storage: fakeStorage("candidate-a"),
    locks,
    randomUUID: () => `rotated-${(rotations += 1)}`,
    now: () => clock,
    retryBackoffMs: 5000,
  });

  // First resolve: 3 lease attempts, all refused → undefined (fail closed).
  assert.equal(await identity.resolve(), undefined);
  assert.equal(locks.calls, 3);

  // Inside the backoff window: NO new lease attempt — the failure is fresh.
  assert.equal(await identity.resolve(), undefined);
  assert.equal(locks.calls, 3, "the backoff suppresses an immediate re-attempt");

  // Past the backoff, still contended: a genuine new attempt (3 more calls).
  clock += 5001;
  assert.equal(await identity.resolve(), undefined);
  assert.equal(locks.calls, 6, "a retry actually re-runs the lease");

  // The contention clears (the duplicate tab closed): the NEXT retry succeeds
  // WITHOUT a browser refresh — this is the #654 re-registration path.
  locks.blocked = false;
  clock += 5001;
  const id = await identity.resolve();
  assert.ok(typeof id === "string" && id.length > 0, "the lease was acquired on retry");

  // A success is cached for the page's life — no further lease traffic.
  const callsAfterSuccess = locks.calls;
  assert.equal(await identity.resolve(), id);
  assert.equal(locks.calls, callsAfterSuccess, "a resolved identity is never re-leased");
});

test("#654: a first-try success is cached and never re-attempted", async () => {
  const locks = new ContendedLocks();
  const identity = createRestartTabIdentity({
    storage: fakeStorage("candidate-a"),
    locks,
    randomUUID: () => "rotated",
    now: () => 0,
    retryBackoffMs: 5000,
  });
  const id = await identity.resolve();
  assert.equal(id, "candidate-a");
  assert.equal(locks.calls, 1);
  assert.equal(await identity.resolve(), "candidate-a");
  assert.equal(locks.calls, 1, "no re-lease after success");
});

test("#654: concurrent callers share one in-flight resolution", async () => {
  const locks = new ContendedLocks();
  const identity = createRestartTabIdentity({
    storage: fakeStorage("candidate-a"),
    locks,
    randomUUID: () => "rotated",
    now: () => 0,
    retryBackoffMs: 5000,
  });
  const [a, b] = await Promise.all([identity.resolve(), identity.resolve()]);
  assert.equal(a, "candidate-a");
  assert.equal(b, "candidate-a");
  assert.equal(locks.calls, 1, "two concurrent resolves ran ONE lease attempt");
});

test("#654: with no lock manager at all, resolve fails closed (and stays retryable)", async () => {
  let clock = 1000;
  const identity = createRestartTabIdentity({
    storage: fakeStorage("candidate-a"),
    // `{}` — not undefined: undefined would fall back to the DEFAULT
    // (globalThis.navigator?.locks), which Node ≥22 actually provides. A
    // request-less object models the plain-http LAN frontend where the Web
    // Locks API is absent (secure-context-only).
    locks: {},
    randomUUID: () => "rotated",
    now: () => clock,
    retryBackoffMs: 5000,
  });
  assert.equal(await identity.resolve(), undefined, "no lock manager → no identity claim");
  clock += 5001;
  assert.equal(await identity.resolve(), undefined, "a retry still fails closed without locks");
});

test("#654: a lock manager whose request REJECTS degrades to the same retryable failure, not a cached rejection", async () => {
  // codex gate: the rejected-promise path used to skip the failure bookkeeping
  // entirely, leaving every later caller to re-throw the SAME cached rejection —
  // the page-lifetime wedge wearing a different hat.
  const locks = {
    calls: 0,
    request() {
      this.calls += 1;
      return Promise.reject(new Error("lock manager exploded"));
    },
  };
  let clock = 1000;
  const identity = createRestartTabIdentity({
    storage: fakeStorage("candidate-a"),
    locks,
    randomUUID: () => "rotated",
    now: () => clock,
    retryBackoffMs: 5000,
  });
  assert.equal(await identity.resolve(), undefined, "a rejecting lock request fails closed");
  assert.equal(locks.calls, 3, "the three bounded attempts ran");
  // The rejection is NOT cached: inside the backoff the answer is a quiet
  // undefined; past it, a fresh attempt runs (and can succeed once the manager
  // recovers).
  assert.equal(await identity.resolve(), undefined);
  assert.equal(locks.calls, 3, "inside the backoff: no new attempt, no re-thrown rejection");
  clock += 5001;
  assert.equal(await identity.resolve(), undefined);
  assert.equal(locks.calls, 6, "past the backoff: a genuine fresh attempt");
});

test("#654: a THROWING resolver step fails closed and stays retryable — the rejection is never cached", async () => {  // The IIFE rejects only when a step OUTSIDE acquire's own try/catch throws
  // (randomUUID is the reachable one). Without the rejection→undefined degrade
  // the first resolve re-throws here; without the slot clear, the third call
  // returns the stale settled promise and no fresh lease attempt runs.
  const locks = new ContendedLocks();
  locks.blocked = true;
  let clock = 1000;
  const identity = createRestartTabIdentity({
    storage: fakeStorage("candidate-a"),
    locks,
    randomUUID: () => {
      throw new Error("no entropy");
    },
    now: () => clock,
    retryBackoffMs: 5000,
  });
  assert.equal(await identity.resolve(), undefined, "a throwing randomUUID fails closed");
  assert.equal(locks.calls, 1, "one refused lease attempt before the throw");
  assert.equal(await identity.resolve(), undefined, "the failure is served quietly, not re-thrown");
  assert.equal(locks.calls, 1, "no new attempt inside the backoff");
  clock += 5001;
  assert.equal(await identity.resolve(), undefined);
  assert.equal(locks.calls, 2, "a FRESH attempt runs after the backoff — the slot was cleared");
});

// ---------------------------------------------------------------------------
// Panel wiring: the refused-hello re-registration path (source scans —
// deleting the wiring fails these)
// ---------------------------------------------------------------------------

test("#654: a failure recorded at timestamp 0 still counts as a failure (null sentinel, codex r2)", async () => {
  const locks = new ContendedLocks();
  locks.blocked = true;
  const identity = createRestartTabIdentity({
    storage: fakeStorage("candidate-a"),
    locks,
    randomUUID: () => "rotated",
    now: () => 0, // a legitimate clock reading — must not read as "never failed"
    retryBackoffMs: 5000,
  });
  assert.equal(await identity.resolve(), undefined);
  assert.equal(locks.calls, 3);
  assert.equal(await identity.resolve(), undefined);
  assert.equal(locks.calls, 3, "a failure at t=0 still arms the backoff");
});

test("#654 wiring: a hello refused for want of a route schedules a bounded re-hello", () => {
  // The refusal site inside sendHello's makePayload: describeRefusedRoute is
  // the disclosure; the retry is the recovery.
  const refusalAt = SRC.indexOf("describeRefusedRoute({ settled: tabRouteIdentity.settled() })");
  assert.notEqual(refusalAt, -1, "the route-refusal disclosure site exists");
  const block = SRC.slice(refusalAt, refusalAt + 700);
  assert.match(
    block,
    /scheduleRouteRefusalRetry\(\)/,
    "the refusal schedules a re-hello — the lease can free up while this socket stays open",
  );
});

test("#654 wiring: the retry is BOUNDED and re-runs the (now retryable) identity resolve", () => {
  const start = SRC.indexOf("function scheduleRouteRefusalRetry()");
  assert.notEqual(start, -1);
  const body = SRC.slice(start, start + 900);
  assert.match(body, /routeRefusalRetries >= ROUTE_REFUSAL_RETRY_MAX/, "bounded — no hot loop against a live duplicate tab");
  assert.match(body, /void sendHello\(\)/, "the retry is a fresh hello, which re-resolves the identity");
});

test("#654 wiring: a landed hello or a fresh socket replenishes the retry budget", () => {
  const resets = SRC.match(/routeRefusalRetries = 0;/g) ?? [];
  assert.ok(resets.length >= 2, "reset on BOTH a landed hello and a fresh socket open");
});
