// panel#701(2) — a commanded frontend reload that never happens must say so.
//
// Reproduced on released builds: panel_reload({scope:"frontend"}) returned
// "soft reload (frontend) scheduled", the orchestrator logged
// `panel tab disconnected`, the page never navigated (no cmcpReload param), and
// the socket never came back. ComfyUI's unsaved-work beforeunload had cancelled
// the navigation after the browser began tearing the socket down, leaving a modal
// waiting for a click nobody knew about.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  armReloadBlockedNotice,
  runAgentFrontendReload,
  reloadBlockedMessage,
  RELOAD_BLOCKED_AFTER_MS,
  unsavedReloadBlockers,
  reloadWouldBeBlockedMessage,
  reloadBlockerUnreadableMessage,
} from "../../web/js/lib/reload-blocked.js";
import { commandFingerprint, createCommandDedupeLedger } from "../../web/js/lib/command-dedupe.js";
import { createRehelloGate, routeIsStale } from "../../web/js/lib/rehello-gate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** Capture the scheduled callback instead of waiting on a real clock. */
function fakeTimer() {
  const calls = [];
  return { setTimer: (fn, ms) => (calls.push({ fn, ms }), calls.length), calls };
}

function extractFunctionSource(source, marker, endMarker = null) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `could not locate ${marker}`);
  if (endMarker) {
    const end = source.indexOf(endMarker, start);
    assert.notEqual(end, -1, `could not locate the end of ${marker}`);
    return source.slice(start, end + 2);
  }
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `could not locate the body of ${marker}`);
  let depth = 1;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open + 1; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === "*" && n === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && n === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`could not close ${marker}`);
}

const CREATE_BRIDGE_CLIENT = extractFunctionSource(
  readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n"),
  "function createBridgeClient(",
  "\n}\n\n// ---------------------------------------------------------------------------\n// Panel DOM",
);

class CommandReplySocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = CommandReplySocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    CommandReplySocket.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  send(raw) {
    if (this.readyState !== CommandReplySocket.OPEN) throw new Error("socket is not open");
    this.sent.push(JSON.parse(raw));
  }

  open() {
    this.readyState = CommandReplySocket.OPEN;
    this.listeners.get("open")?.();
  }

  receive(frame) {
    const event = { data: JSON.stringify(frame) };
    void this.listeners.get("message")?.(event);
  }

  close() {
    if (this.readyState === CommandReplySocket.CLOSED) return;
    this.readyState = CommandReplySocket.CLOSED;
    this.listeners.get("close")?.();
  }
}

function buildCommandReplyClient(onReload) {
  CommandReplySocket.instances = [];
  const storage = new Map();
  const noop = () => {};
  const routeRef = { current: "panel-route-1830" };
  const bridgeOutage = { noteHandshake: noop, noteBridgeClosed: noop };
  const lostReplies = { list: () => [], size: () => 0, summaries: () => [], replace: noop, record: noop };
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const webWindow = { localStorage, dispatchEvent: noop };
  const env = new Proxy(
    {
      WebSocket: CommandReplySocket,
      DEFAULT_BRIDGE_URL: "ws://bridge.test",
      RECONNECT_BASE_MS: 1000,
      RECONNECT_MAX_MS: 15000,
      STORAGE_KEY_BACKEND: "backend",
      window: webWindow,
      location: { protocol: "http:", href: "http://panel.test/" },
      document: { addEventListener: noop, removeEventListener: noop, querySelector: () => null },
      MutationObserver: class { observe() {} disconnect() {} },
      loadBridgeUrl: () => "ws://bridge.test",
      saveBridgeUrl: noop,
      bridgeRouteId: () => routeRef.current,
      tabRouteIdentity: { adopt: noop, settled: () => true },
      describeRefusedRoute: () => "route unavailable",
      routeIsStale,
      createRehelloGate,
      monotonicNow: () => performance.now(),
      buildHelloPayload: ({ tabId } = {}) => ({ type: "hello", tab_id: tabId ?? routeRef.current }),
      sendBridgeHello: async ({ socket, isCurrent, makePayload }) => {
        if (!isCurrent()) return false;
        const payload = makePayload("tab-session-1830");
        if (!payload) return false;
        socket.send(JSON.stringify(payload));
        return true;
      },
      createRestartTabIdentity: () => ({ resolve: async () => "tab-session-1830" }),
      bridgeOutage,
      lostReplies,
      pruneAttempts: (items) => items,
      shouldReRegister: () => false,
      reRegisterExhaustedHint: () => "re-register exhausted",
      describeUndeliveredReply: () => "undelivered",
      lsSet: (key, value) => (value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value)),
      lsGet: (key) => localStorage.getItem(key),
      SESSION_ORDERED_FRAMES: new Set(),
      AGENT_SESSION_RESET_FRAMES: new Set(),
      AGENT_MUTED: false,
      AGENT_BLIND: false,
      commandFingerprint,
      createCommandDedupeLedger,
      commandRidLedger: createCommandDedupeLedger(),
      coerceMessageText: (value) => (value == null ? "" : typeof value === "string" ? value : String(value)),
      isAbandonedInteractive: () => false,
      abandonedInteractiveError: () => "abandoned",
      readReconnectRefusal: () => null,
      readWorkflowListReadinessRefusal: () => null,
      readWorkflowOpenReadinessRefusal: () => null,
      readRouteRegistrationReadinessRefusal: () => null,
      markOpenReceiptReplySent: noop,
      openReceipts: [],
      deferChangeTrackerSnapshot: noop,
      trackerStillOwnsCanvas: () => true,
      getWorkflowTitle: () => "Untitled",
      comfyuiUrlForAgent: () => "http://comfy.test",
      localComfyuiPathForAgent: () => null,
      workflowStableUuid: () => "workflow-1830",
      PANEL_VERSION: "test",
      VENDORED_VOCABULARY_HASH: "test",
      onCommand: noop,
      onCommandReceived: noop,
      onModels: noop,
      onLog: noop,
    },
    {
      has: () => true,
      get(target, key) {
        if (key in target) return target[key];
        if (key in globalThis) return globalThis[key];
        return noop;
      },
    },
  );
  const create = new Function("env", `with (env) { return (${CREATE_BRIDGE_CLIENT}); }`)(env);
  const client = create({
    onStatus: noop,
    onSay: noop,
    onStream: noop,
    onLog: noop,
    onReload,
    onModels: noop,
    onBridgeClosed: noop,
  });
  return { client, socket: () => CommandReplySocket.instances.at(-1) };
}

test("#701 the notice fires only if the page SURVIVED the deadline", () => {
  const said = [];
  const t = fakeTimer();
  armReloadBlockedNotice({ notify: (m) => said.push(m), setTimer: t.setTimer });
  assert.equal(said.length, 0, "nothing is said at arm time");
  assert.equal(t.calls[0].ms, RELOAD_BLOCKED_AFTER_MS);
  t.calls[0].fn();
  assert.equal(said.length, 1, "surviving the deadline is the evidence");
});

test("#701 a successful reload says NOTHING — the page is gone", () => {
  // The real mechanism: the document is destroyed and the callback never runs.
  // Modelled by a stillHere that reports the page died, which is also the guard
  // against speaking about a page that no longer exists.
  const said = [];
  const t = fakeTimer();
  armReloadBlockedNotice({ notify: (m) => said.push(m), stillHere: () => false, setTimer: t.setTimer });
  t.calls[0].fn();
  assert.equal(said.length, 0);
});

test("#701 it says NOT YET rather than declaring failure", () => {
  // The one false-positive risk is a navigation slower than the deadline. The
  // wording has to survive that case being wrong.
  const msg = reloadBlockedMessage();
  assert.match(msg, /has NOT happened yet/);
  assert.doesNotMatch(msg, /reload failed|could not reload|reload was refused/i);
});

test("#701 it names the likely cause WITHOUT asserting it", () => {
  // This code cannot see which handler cancelled the unload — another pack or a
  // browser extension can register one too. Unsaved work is by far the likeliest
  // and is named as such, not as fact.
  const msg = reloadBlockedMessage();
  assert.match(msg, /almost certainly/);
  assert.match(msg, /unsaved workflows/);
  assert.doesNotMatch(msg, /because you have unsaved work\b/i);
});

test("#701 it tells the reader what to DO, in the browser", () => {
  const msg = reloadBlockedMessage();
  assert.match(msg, /Check the ComfyUI tab/);
  assert.match(msg, /confirm the prompt|confirm\s+the prompt/i);
  assert.match(msg, /save the modified workflows/);
});

test("#701 it warns that the connection may ALREADY have dropped", () => {
  // The socket teardown begins before the dialog resolves, so "the agent looks
  // disconnected" is expected here and would otherwise read as a second fault.
  assert.match(reloadBlockedMessage(), /may already have dropped/);
});

test("#701 a missing notify sink is a no-op, never a throw", () => {
  // This runs on the way out of the page; throwing here would be the worst
  // possible place to fail.
  assert.equal(armReloadBlockedNotice({}), null);
  assert.equal(armReloadBlockedNotice({ notify: "not a function" }), null);
});

test("#701 WIRING: armed BEFORE the navigation, in the frontend branch", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const i = src.indexOf("armReloadBlockedNotice({ notify:");
  const j = src.indexOf('u.searchParams.set("cmcpReload"', i);
  assert.ok(i !== -1, "the notice must be armed in the shipped source");
  assert.ok(j > i, "…and armed BEFORE location.replace, or the page may die first");
  // The MEMBER LIST is not the invariant — #701's guard imports two more names
  // from the same module. What must hold is that the notice comes from there.
  assert.match(src, /import \{[^}]*armReloadBlockedNotice[^}]*\} from "\.\/lib\/reload-blocked\.js"/);
});

// panel#701 defect (2) — reproduced on the rig: with 3 unsaved workflows open,
// panel_reload({scope:"frontend"}) reported "scheduled", the orchestrator logged
// `panel tab disconnected`, and then nothing happened. The page never navigated
// (no `cmcpReload` in the URL, unsaved `*` still in the title) and stopped
// accepting script injection at all.
//
// beforeunload is the mechanism, and the ORDER is what turns it into a wedge: the
// browser drops the socket first, THEN raises "Leave site?" — which nobody is
// there to answer during an agent-commanded reload. The tab is left with neither
// a reload nor a bridge, strictly worse than before the command.

test("#701 unsaved workflows are reported as reload blockers", () => {
  const blockers = unsavedReloadBlockers([
    { isModified: true, filename: "a.json" },
    { isModified: false, filename: "b.json" },
    { isModified: true, path: "workflows/c.json" },
  ])
  assert.deepEqual(blockers, ["a.json", "workflows/c.json"])
})

test("#701 an UNKNOWN modified flag is not treated as unsaved work", () => {
  // Refusing on an absent flag would make the reload unusable on any build that
  // does not expose the field — an unobserved edit is not an observed one.
  assert.deepEqual(unsavedReloadBlockers([{ filename: "a.json" }]), [])
  assert.deepEqual(unsavedReloadBlockers([{ isModified: undefined }]), [])
  assert.deepEqual(unsavedReloadBlockers([{ isModified: "yes" }]), [])
  assert.deepEqual(unsavedReloadBlockers(null), [])
  assert.deepEqual(unsavedReloadBlockers([]), [])
})

test("#701 a blocked reload names the tabs, the mechanism, and BOTH ways out", () => {
  const msg = reloadWouldBeBlockedMessage(["a.json", "b.json"])
  assert.match(msg, /Did NOT reload/)
  assert.match(msg, /a\.json, b\.json/)
  assert.match(msg, /drops this tab's bridge connection BEFORE/)
  assert.match(msg, /Nothing was changed/)
  assert.match(msg, /Save or close/)
  assert.match(msg, /Ctrl\+Shift\+R/)
})

test("#701 WIRING: only the AGENT path runs the reload decision before navigating", async () => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  )
  const i = src.indexOf('if (scope === "frontend")', src.indexOf("async function softReload("))
  assert.ok(i > 0)
  const block = src.slice(i, i + 3200)
  // The guard is gated on the commanded path — a user standing at the keyboard
  // can answer the dialog, so their reload must still proceed.
  assert.match(block, /if \(origin === "agent"\)[\s\S]{0,1200}runAgentFrontendReload/)
  // …and a refusal is thrown into the command reply rather than merely logged.
  const guardAt = block.indexOf("runAgentFrontendReload")
  const refusalAt = block.indexOf("if (!reloadResult.ok) throw new Error(reloadResult.error)")
  assert.ok(guardAt > 0 && refusalAt > guardAt, "the decision must feed the command refusal")
})

test("#1830 lifecycle: a clean command that becomes dirty during prime refuses visibly", async () => {
  let dirty = false;
  let blockerReads = 0;
  let navigations = 0;
  let armed = 0;
  let cleared = 0;
  const surfaced = [];
  const result = await runAgentFrontendReload({
    getBlockers: () => {
      blockerReads += 1;
      return dirty ? ["Untitled.json"] : [];
    },
    prime: async () => {
      assert.equal(dirty, false, "the command starts with a clean blocker snapshot");
      dirty = true;
    },
    clearSidebarReopen: () => {
      cleared += 1;
    },
    appendSystem: (message) => surfaced.push(message),
    armNotice: () => {
      armed += 1;
    },
    navigate: () => {
      navigations += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "post-prime");
  assert.match(result.error, /Did NOT reload/);
  assert.equal(blockerReads, 2, "the clean and post-prime snapshots both ran");
  assert.equal(navigations, 0, "a new edit during prime prevents navigation");
  assert.equal(armed, 0, "a refused command never arms the cancelled-navigation notice");
  assert.equal(cleared, 1, "the refused command clears its sidebar reopen marker");
  assert.deepEqual(surfaced, [result.error], "the same refusal is visible in the panel and command result");
});

test("#1830 lifecycle: the final pre-navigation fence refuses a new edit", async () => {
  let dirty = false;
  let reads = 0;
  let navigations = 0;
  const result = await runAgentFrontendReload({
    getBlockers: () => {
      reads += 1;
      const blockers = dirty ? ["Untitled.json"] : [];
      if (reads === 2) dirty = true;
      return blockers;
    },
    prime: async () => {},
    clearSidebarReopen: () => {},
    appendSystem: () => {},
    armNotice: () => {},
    navigate: () => {
      navigations += 1;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "pre-navigation");
  assert.equal(reads, 3, "the final snapshot ran after the post-prime snapshot");
  assert.equal(navigations, 0, "a new edit immediately before navigation is refused");
});

test("#1830 lifecycle: the bridge returns the post-prime refusal to the agent", async () => {
  let dirty = false;
  let navigations = 0;
  const surfaced = [];
  const onReload = async (scope) => {
    assert.equal(scope, "frontend");
    const decision = await runAgentFrontendReload({
      getBlockers: () => (dirty ? ["Untitled.json"] : []),
      prime: async () => {
        assert.equal(dirty, false, "the command begins from a clean workflow");
        dirty = true;
      },
      clearSidebarReopen: () => {},
      appendSystem: (message) => surfaced.push(message),
      armNotice: () => assert.fail("a refused reload must not arm the delayed notice"),
      navigate: () => {
        navigations += 1;
      },
    });
    if (!decision.ok) throw new Error(decision.error);
    return `soft reload (${scope}) scheduled`;
  };
  const built = buildCommandReplyClient(onReload);
  try {
    built.client.start();
    const socket = built.socket();
    socket.open();
    socket.receive({ type: "models", epoch: "epoch-1830", models: [] });
    await new Promise((resolve) => setImmediate(resolve));
    socket.receive({ rid: "reload-rid-1830", cmd: "soft_reload", scope: "frontend", epoch: "epoch-1830" });
    await new Promise((resolve) => setImmediate(resolve));
    const reply = socket.sent.find((frame) => frame.rid === "reload-rid-1830");
    assert.deepEqual(reply, {
      rid: "reload-rid-1830",
      ok: false,
      error: surfaced[0],
    });
    assert.match(reply.error, /Did NOT reload/);
    assert.equal(navigations, 0, "the refusal never navigates");
    assert.equal(surfaced.length, 1, "the panel records the same refusal returned to the agent");
  } finally {
    built.client.stop();
  }
});

test("#1830 WIRING: the frontend soft_reload awaits the decision and returns its refusal", async () => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  )
  const i = src.indexOf('msg.cmd === "soft_reload"')
  assert.ok(i > 0)
  const block = src.slice(i, i + 1800)
  assert.match(block, /if \(scope === "frontend"\)\s*\{\s*result = await onReload\(scope\)/)
  assert.match(block, /if \(result == null\) throw new Error\("The frontend reload did not produce a decision\."\)/)
  assert.match(block, /else \{[\s\S]*setTimeout\(\(\) => onReload\(scope\), 60\)/)
  assert.doesNotMatch(block, /setTimeout\(\(\) => onReload\(scope\), 60\)[\s\S]*if \(scope === "frontend"\)/)
})

// #1839 — a destructive reload used to fail OPEN when the blocker read threw.
// blockersNow() caught and returned [], and [] is the CLEAN signal that permits
// navigation — so an unreadable dirtiness state meant "nothing is dirty" and the
// tab navigated, discarding exactly the unsaved work the fence exists to protect.
// The #1830 reporter was saved by this refusal firing correctly, so the throw path
// is not theoretical.
for (const stage of ["initial", "post-prime", "pre-navigation"]) {
  test(`#1839: a blocker read that throws at the ${stage} fence refuses, never navigates`, async () => {
    let reads = 0;
    let navigations = 0;
    let armed = 0;
    const surfaced = [];
    // Throw only at the fence under test, so each gate is pinned on its own.
    const throwAt = { "initial": 1, "post-prime": 2, "pre-navigation": 3 }[stage];
    const result = await runAgentFrontendReload({
      getBlockers: () => {
        reads += 1;
        if (reads === throwAt) throw new Error("openWorkflows unavailable");
        return [];
      },
      prime: async () => {},
      clearSidebarReopen: () => {},
      appendSystem: (m) => surfaced.push(m),
      armNotice: () => { armed += 1; },
      navigate: () => { navigations += 1; },
    });
    assert.equal(result.ok, false, "an unreadable blocker state must not read as clean");
    assert.equal(result.stage, stage);
    assert.equal(navigations, 0, "nothing may navigate while dirtiness is UNKNOWN");
    assert.equal(armed, 0, "a refused command never arms the cancelled-navigation notice");
    // It must say what happened, not invent dirty workflows it never saw (#796).
    assert.equal(result.error, reloadBlockerUnreadableMessage());
    assert.match(result.error, /could not read/i);
    assert.doesNotMatch(result.error, /unsaved changes — /);
    assert.deepEqual(surfaced, [result.error]);
  });
}

test("#1839 control: a readable, clean blocker state still navigates", async () => {
  // Without this, the three cases above are satisfiable by refusing everything —
  // which would break every legitimate reload instead of fixing the fail-open.
  let navigations = 0;
  const result = await runAgentFrontendReload({
    getBlockers: () => [],
    prime: async () => {},
    clearSidebarReopen: () => {},
    appendSystem: () => {},
    armNotice: () => {},
    navigate: () => { navigations += 1; },
  });
  assert.equal(result.ok, true);
  assert.equal(navigations, 1);
});
