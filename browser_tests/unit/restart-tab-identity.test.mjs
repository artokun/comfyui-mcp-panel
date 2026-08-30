import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildHelloPayload } from "../../web/js/lib/session-rebind.js";
import { createRestartTabIdentity, sendBridgeHello } from "../../web/js/lib/restart-tab-identity.js";

class FakeLocks {
  held = new Set();

  request(name, _options, callback) {
    if (this.held.has(name)) return Promise.resolve(callback(null));
    this.held.add(name);
    return Promise.resolve(callback({ name })).finally(() => this.held.delete(name));
  }
}

class DelayedDenyThenGrantLocks extends FakeLocks {
  calls = 0;
  denyFirst;

  request(name, options, callback) {
    this.calls++;
    if (this.calls === 1) {
      return new Promise((resolve) => {
        this.denyFirst = () => resolve(callback(null));
      });
    }
    return super.request(name, options, callback);
  }
}

function copiedStorage(value) {
  let stored = value;
  return {
    getItem: () => stored,
    setItem: (_key, next) => { stored = next; },
  };
}

test("#709: storage failure keeps one in-memory identity across actual hello reconnects", async () => {
  const locks = new FakeLocks();
  const storage = {
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
  };
  const identity = createRestartTabIdentity({ storage, locks, randomUUID: () => "memory-tab" });
  const sent = [];
  const socket = { send: (frame) => sent.push(JSON.parse(frame)) };
  const makePayload = (tabSessionId) => buildHelloPayload({ tabId: "wf:shared.json", tabSessionId });

  await sendBridgeHello({ socket, isCurrent: () => true, resolveTabIdentity: identity.resolve, makePayload });
  await sendBridgeHello({ socket, isCurrent: () => true, resolveTabIdentity: identity.resolve, makePayload });
  assert.deepEqual(sent.map((frame) => frame.tab_session_id), ["memory-tab", "memory-tab"]);
  identity.releaseForTests();
});

test("#709: a duplicated sessionStorage candidate rotates under an exclusive lease before hello", async () => {
  const locks = new FakeLocks();
  const original = createRestartTabIdentity({
    storage: copiedStorage("copied-browser-tab"),
    locks,
    randomUUID: () => "original-rotation",
  });
  const duplicate = createRestartTabIdentity({
    storage: copiedStorage("copied-browser-tab"),
    locks,
    randomUUID: () => "duplicate-rotation",
  });
  const [originalId, duplicateId] = await Promise.all([original.resolve(), duplicate.resolve()]);
  assert.equal(originalId, "copied-browser-tab");
  assert.equal(duplicateId, "duplicate-rotation");
  assert.notEqual(originalId, duplicateId);
  original.releaseForTests();
  duplicate.releaseForTests();
});

test("#709: actual hello sender waits for a definitive delayed lock verdict; no timeout can certify the copy", async () => {
  const locks = new DelayedDenyThenGrantLocks();
  const identity = createRestartTabIdentity({
    storage: copiedStorage("copied-browser-tab"),
    locks,
    randomUUID: () => "rotated-after-denial",
  });
  const sent = [];
  const socket = { send: (frame) => sent.push(JSON.parse(frame)) };
  const pending = sendBridgeHello({
    socket,
    isCurrent: () => true,
    resolveTabIdentity: identity.resolve,
    makePayload: (tabSessionId) => buildHelloPayload({ tabId: "wf:shared.json", tabSessionId }),
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sent.length, 0, "no hello before the lock manager gives a positive lease");
  locks.denyFirst();
  await pending;
  assert.equal(sent[0].tab_session_id, "rotated-after-denial");
  identity.releaseForTests();
});

test("#2104: absent Web Locks still publishes a page-lifetime connection identity", async () => {
  // Web Locks is secure-context-only. A bound live canvas on plain-http LAN
  // (the #2104 reporter: graph_binding bound, panel_query_graph succeeded)
  // has no lock manager. Omitting tab_session_id made MCP refuse promoted
  // subgraph widget writes as "the panel connection identity was unavailable"
  // before graph_set_widget dispatch. A page-lifetime id is not restart-proof
  // (it does not survive reload), but it is a usable connection identity.
  const identity = createRestartTabIdentity({
    storage: copiedStorage("possibly-copied"),
    locks: null,
    randomUUID: () => "page-instance-tab",
  });
  const sent = [];
  await sendBridgeHello({
    socket: { send: (frame) => sent.push(JSON.parse(frame)) },
    isCurrent: () => true,
    resolveTabIdentity: identity.resolve,
    makePayload: (tabSessionId) => buildHelloPayload({ tabId: "wf:shared.json", tabSessionId }),
  });
  await sendBridgeHello({
    socket: { send: (frame) => sent.push(JSON.parse(frame)) },
    isCurrent: () => true,
    resolveTabIdentity: identity.resolve,
    makePayload: (tabSessionId) => buildHelloPayload({ tabId: "wf:shared.json", tabSessionId }),
  });
  assert.deepEqual(
    sent.map((frame) => frame.tab_session_id),
    ["page-instance-tab", "page-instance-tab"],
    "a bound canvas without Web Locks must still advertise connection identity",
  );
});

test("#2104: a request-less lock object (plain-http LAN) still advertises tab_session_id", async () => {
  const identity = createRestartTabIdentity({
    storage: copiedStorage("copied-browser-tab"),
    // Node ≥22 provides navigator.locks; `{}` models a non-secure origin
    // where the API is absent rather than contended.
    locks: {},
    randomUUID: () => "lan-page-instance",
  });
  const sent = [];
  await sendBridgeHello({
    socket: { send: (frame) => sent.push(JSON.parse(frame)) },
    isCurrent: () => true,
    resolveTabIdentity: identity.resolve,
    makePayload: (tabSessionId) => buildHelloPayload({ tabId: "wf:shared.json", tabSessionId }),
  });
  assert.equal(sent[0].tab_session_id, "lan-page-instance");
});

test("#2104: a present lock manager that refuses every lease still omits tab_session_id", async () => {
  const identity = createRestartTabIdentity({
    storage: copiedStorage("copied-browser-tab"),
    locks: { request: (_name, _options, callback) => Promise.resolve(callback(null)) },
    randomUUID: () => "unused-rotation",
  });
  const sent = [];
  await sendBridgeHello({
    socket: { send: (frame) => sent.push(JSON.parse(frame)) },
    isCurrent: () => true,
    resolveTabIdentity: identity.resolve,
    makePayload: (tabSessionId) => buildHelloPayload({ tabId: "wf:shared.json", tabSessionId }),
  });
  assert.equal(
    "tab_session_id" in sent[0],
    false,
    "fail closed only when identity is actually unavailable (exclusivity unproven)",
  );
});

test("#709: a rejected Web Locks request also omits identity instead of hanging or trusting storage", async () => {
  const identity = createRestartTabIdentity({
    storage: copiedStorage("possibly-copied"),
    locks: { request: () => Promise.reject(new Error("locks unavailable")) },
    randomUUID: () => "unused",
  });
  assert.equal(await identity.resolve(), undefined);
});

test("#709: the live bridge sender awaits the leased identity helper, never getTabId directly", () => {
  const source = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  // #1095 — the PAYLOAD builder. `sendHello` in front of it is the gate that holds a
  // re-advertise until in-flight commands have replied, and contains none of this.
  const start = source.indexOf("function advertiseHello() {");
  assert.notEqual(start, -1, "could not locate the hello payload builder");
  const body = source.slice(start, source.indexOf("\n  }", start));
  assert.match(body, /sendBridgeHello\(/);
  assert.match(body, /resolveTabIdentity: \(\) => restartTabIdentity\.resolve\(\)/);
  assert.match(body, /tabSessionId,/);
  assert.doesNotMatch(body, /tabSessionId:\s*getTabId\(\)/);
});
