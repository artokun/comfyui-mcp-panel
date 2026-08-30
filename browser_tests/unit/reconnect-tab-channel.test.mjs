// #2030 — after panel_restart_comfyui the backend can be healthy
// (`server_ready:true`) while this tab's workflow command channel is still the
// pre-restart mapping (`panel_tab_reconnected:false`). `workflow_list` then
// times out (6000 ms), `panel_set_workflow_target({mode:"current"})` cannot
// read canvas identity, and mutations stay fenced. Unsaved in-memory edits
// exist, so the repair must re-register THIS tab — never reload or reopen.
//
// Distinct from #1999: that restores a Desktop process. This restores the
// tab command channel of a tab that stayed loaded.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  TAB_CHANNEL_REREGISTER_STEPS_MS,
  TAB_CHANNEL_WATCH_MAX_ATTEMPTS,
  shouldReregisterWorkflowTabChannel,
  watchReconnectTabChannel,
  ensureWorkflowTabChannel,
} from "../../web/js/lib/reconnect-tab-channel.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const instantSleep = () => Promise.resolve();

function recordSleep() {
  const slept = [];
  return {
    slept,
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
}

function handlerBody(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return "";
  const after = start + sig.length;
  const m = src.slice(after).match(/\n {2}(?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  return src.slice(start, m ? after + m.index : src.length);
}

// ---------------------------------------------------------------------------
// shouldReregisterWorkflowTabChannel
// ---------------------------------------------------------------------------

test("#2030: server ready + bridge up + stale tab channel → re-register this tab", () => {
  assert.equal(
    shouldReregisterWorkflowTabChannel({
      serverReady: true,
      bridgeConnected: true,
      channelReadyForEpoch: false,
    }),
    true,
  );
});

test("#2030: a channel already ready for this epoch is not re-registered", () => {
  assert.equal(
    shouldReregisterWorkflowTabChannel({
      serverReady: true,
      bridgeConnected: true,
      channelReadyForEpoch: true,
    }),
    false,
  );
});

test("#2030: server not ready → never re-register (the backend cycle is still in flight)", () => {
  assert.equal(
    shouldReregisterWorkflowTabChannel({
      serverReady: false,
      bridgeConnected: true,
      channelReadyForEpoch: false,
    }),
    false,
  );
});

test("#2030: bridge down → never, the socket-open hello owns recovery", () => {
  assert.equal(
    shouldReregisterWorkflowTabChannel({
      serverReady: true,
      bridgeConnected: false,
      channelReadyForEpoch: false,
    }),
    false,
  );
});

test("#2030: an in-flight re-register is one-shot, not a hello storm", () => {
  assert.equal(
    shouldReregisterWorkflowTabChannel({
      serverReady: true,
      bridgeConnected: true,
      channelReadyForEpoch: false,
      alreadyInFlight: true,
    }),
    false,
  );
});

test("#2030: unreadable inputs fail closed", () => {
  for (const input of [
    {},
    { serverReady: true },
    { serverReady: "true", bridgeConnected: true },
    { serverReady: true, bridgeConnected: 1, channelReadyForEpoch: false },
  ]) {
    assert.equal(shouldReregisterWorkflowTabChannel(input), false);
  }
});

// ---------------------------------------------------------------------------
// watchReconnectTabChannel — the reconnect watchdog
// ---------------------------------------------------------------------------

test("#2030 watchdog: a stale channel is re-registered and stops once ready", async () => {
  let ready = false;
  let graphLoads = 0;
  let opens = 0;
  const reregisters = [];
  const outcome = await watchReconnectTabChannel({
    isCurrent: () => true,
    serverReady: () => true,
    channelReady: () => ready,
    reregister: async () => {
      reregisters.push("hello");
      ready = true;
      return true;
    },
    loadWorkflow: () => {
      graphLoads += 1;
    },
    openWorkflow: () => {
      opens += 1;
    },
    sleep: instantSleep,
    firstDelayMs: 0,
    stepsMs: [0],
  });
  assert.equal(outcome, "ready");
  assert.deepEqual(reregisters, ["hello"]);
  assert.equal(graphLoads, 0, "unsaved in-memory graph must not be reloaded");
  assert.equal(opens, 0, "re-register must not reopen the workflow from disk");
});

test("#2030 watchdog: retries until the hello lands, then stops", async () => {
  let ready = false;
  let hellos = 0;
  const outcome = await watchReconnectTabChannel({
    isCurrent: () => true,
    serverReady: () => true,
    channelReady: () => ready,
    reregister: async () => {
      hellos += 1;
      if (hellos >= 2) ready = true;
      return hellos >= 2;
    },
    sleep: instantSleep,
    stepsMs: [0, 0, 0],
  });
  assert.equal(outcome, "ready");
  assert.equal(hellos, 2);
});

test("#2030 watchdog: a throwing re-register is 'not yet', never a graph load", async () => {
  let ready = false;
  let hellos = 0;
  const outcome = await watchReconnectTabChannel({
    isCurrent: () => true,
    serverReady: () => true,
    channelReady: () => ready,
    reregister: async () => {
      hellos += 1;
      if (hellos < 2) throw new Error("hello lease not ready");
      ready = true;
      return true;
    },
    sleep: instantSleep,
    stepsMs: [0, 0],
  });
  assert.equal(outcome, "ready");
  assert.equal(hellos, 2);
});

test("#2030 watchdog: a newer reconnect supersedes the older watch", async () => {
  let current = true;
  let hellos = 0;
  const outcome = await watchReconnectTabChannel({
    isCurrent: () => current,
    serverReady: () => true,
    channelReady: () => false,
    reregister: async () => {
      hellos += 1;
      current = false;
      return true;
    },
    sleep: instantSleep,
    stepsMs: [0, 0],
  });
  assert.equal(outcome, "superseded");
  assert.equal(hellos, 1, "a superseded watch must not keep greeting");
});

test("#2030 watchdog: a server that is not ready yet waits without re-registering", async () => {
  let up = false;
  let ready = false;
  let hellos = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slept = [];
  const pending = watchReconnectTabChannel({
    isCurrent: () => true,
    serverReady: () => up,
    channelReady: () => ready,
    reregister: async () => {
      hellos += 1;
      ready = true;
      return true;
    },
    sleep: async (ms) => {
      slept.push(ms);
      if (slept.length === 1) await gate;
    },
    stepsMs: [5, 7],
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(hellos, 0, "do not hello into a backend that is still down");
  up = true;
  release();
  const outcome = await pending;
  assert.equal(outcome, "ready");
  assert.equal(hellos, 1);
  assert.equal(slept[0], 5);
});

test("#2030 watchdog: the loop is bounded even if the channel never comes up", async () => {
  let hellos = 0;
  const outcome = await watchReconnectTabChannel({
    isCurrent: () => true,
    serverReady: () => true,
    channelReady: () => false,
    reregister: async () => {
      hellos += 1;
      return false;
    },
    sleep: instantSleep,
    stepsMs: [0, 0, 0, 0],
    maxAttempts: 3,
  });
  assert.equal(outcome, "exhausted");
  assert.equal(hellos, TAB_CHANNEL_WATCH_MAX_ATTEMPTS);
});

test("#2030 watchdog: cadence matches the shipped reconnect handshake budget", () => {
  assert.deepEqual([...TAB_CHANNEL_REREGISTER_STEPS_MS], [400, 900, 1600]);
});

// ---------------------------------------------------------------------------
// ensureWorkflowTabChannel — panel_set_workflow_target({mode:"current"})
// ---------------------------------------------------------------------------

test("#2030 ensure: an already-ready channel is a no-op", async () => {
  let hellos = 0;
  const outcome = await ensureWorkflowTabChannel({
    serverReady: true,
    bridgeConnected: true,
    channelReady: () => true,
    reregister: async () => {
      hellos += 1;
      return true;
    },
  });
  assert.equal(outcome, "ready");
  assert.equal(hellos, 0);
});

test("#2030 ensure: server_ready + stale channel forces one safe re-register", async () => {
  let ready = false;
  let hellos = 0;
  let loads = 0;
  const outcome = await ensureWorkflowTabChannel({
    serverReady: true,
    bridgeConnected: true,
    channelReady: () => ready,
    reregister: async () => {
      hellos += 1;
      ready = true;
      return true;
    },
    loadWorkflow: () => {
      loads += 1;
    },
    sleep: instantSleep,
    stepsMs: [0],
  });
  assert.equal(outcome, "ready");
  assert.equal(hellos, 1);
  assert.equal(loads, 0, "forcing current-target recovery must preserve the in-memory graph");
});

test("#2030 ensure: a stale channel that never comes up times out without loading disk", async () => {
  let loads = 0;
  const { slept, sleep } = recordSleep();
  const outcome = await ensureWorkflowTabChannel({
    serverReady: true,
    bridgeConnected: true,
    channelReady: () => false,
    reregister: async () => true,
    loadWorkflow: () => {
      loads += 1;
    },
    sleep,
  });
  assert.equal(outcome, "timeout");
  assert.deepEqual(slept, [...TAB_CHANNEL_REREGISTER_STEPS_MS]);
  assert.equal(loads, 0);
});

test("#2030 ensure: server not ready does not force a hello", async () => {
  let hellos = 0;
  const outcome = await ensureWorkflowTabChannel({
    serverReady: false,
    bridgeConnected: true,
    channelReady: () => false,
    reregister: async () => {
      hellos += 1;
      return true;
    },
  });
  assert.equal(outcome, "not-ready");
  assert.equal(hellos, 0);
});

test("#2030 ensure: live functions are sampled, not frozen at entry", async () => {
  let up = false;
  let connected = false;
  let ready = false;
  let hellos = 0;
  const pending = ensureWorkflowTabChannel({
    serverReady: () => up,
    bridgeConnected: () => connected,
    channelReady: () => ready,
    reregister: async () => {
      hellos += 1;
      ready = true;
      return true;
    },
    sleep: instantSleep,
    stepsMs: [0],
  });
  up = true;
  connected = true;
  const outcome = await pending;
  assert.equal(outcome, "ready");
  assert.equal(hellos, 1);
});

// ---------------------------------------------------------------------------
// Production wiring — the tests above pass against a helper the panel never
// calls. These fail if the reconnect/re-register hook is deleted.
// ---------------------------------------------------------------------------

test("#2030 wiring: the panel imports and calls the shipped reconnect/re-register functions", () => {
  assert.match(
    SRC,
    /shouldReregisterWorkflowTabChannel,\s*\n\s*watchReconnectTabChannel,\s*\n\s*ensureWorkflowTabChannel,/,
    "the panel must import the shipped #2030 helpers by name",
  );
  assert.match(SRC, /from "\.\/lib\/reconnect-tab-channel\.js"/);
  assert.match(SRC, /function kickReconnectTabChannelWatch\(/);
  assert.match(SRC, /kickReconnectTabChannelWatch\(backendReconnectEpoch\)/);
  assert.match(SRC, /await ensureWorkflowTabChannel\(\{/);
});

test("#2030 wiring: the watchdog is kicked from the backend reconnected listener, beside the settle watch", () => {
  const start = SRC.indexOf('api.addEventListener("reconnected"');
  assert.notEqual(start, -1);
  const block = SRC.slice(start, SRC.indexOf("    });", start + 80) + 6);
  assert.match(block, /kickPostReconnectSettleWatch\(backendReconnectEpoch\)/);
  assert.match(
    block,
    /kickReconnectTabChannelWatch\(backendReconnectEpoch\)/,
    "the tab-channel watchdog must run on the same reconnect that arms the settle watch",
  );
  assert.ok(
    block.indexOf("kickPostReconnectSettleWatch") < block.indexOf("kickReconnectTabChannelWatch"),
    "binding settle is independent; tab-channel re-register follows it",
  );
  assert.doesNotMatch(
    block,
    /openWorkflow\(|loadGraphData\(|workflow_open\(/,
    "the reconnect listener must not reload the unsaved graph",
  );
});

test("#2030 wiring: the watchdog re-registers with rehello, never a workflow load", () => {
  const start = SRC.indexOf("function kickReconnectTabChannelWatch(");
  assert.notEqual(start, -1);
  const next = SRC.indexOf("\nfunction ", start + 1);
  const body = SRC.slice(start, next > 0 ? next : start + 2500);
  assert.match(body, /watchReconnectTabChannel\(\{/);
  assert.match(
    body,
    /send: \(\) => liveBridgeClient\?\.rehello\?\.\(\)/,
    "re-register must be THIS tab's current hello, the same identity sendHello already derives",
  );
  assert.doesNotMatch(body, /openWorkflow\(|loadGraphData\(|syncWorkflows\(/);
  assert.match(
    body,
    /ssGet\(REBOOT_KEY\)/,
    "an agent-triggered panel_restart_comfyui must still re-register when the outage clock missed",
  );
  assert.match(body, /shouldReadvertiseAfterComfyRestart\(\{/, "a measured restart-length outage still authorises the watch");
  assert.match(
    body,
    /tabChannelReadyEpoch = epoch/,
    "a benign blip must keep the existing command channel, not mint a second hello",
  );
});

test("#2030 wiring: workflow_list (set_workflow_target current) forces a safe re-register when the channel is stale", () => {
  const body = handlerBody(SRC, "async workflow_list()");
  const ensureAt = body.indexOf("await ensureWorkflowTabChannel({");
  const waitAt = body.indexOf("await waitForReconnectHandshakeBeforeOpen({");
  const serviceAt = body.indexOf("const s = app?.extensionManager?.workflow;");
  assert.notEqual(ensureAt, -1, "workflow_list must force tab-channel re-register");
  assert.notEqual(waitAt, -1, "the #1785 handshake wait stays");
  assert.notEqual(serviceAt, -1);
  assert.ok(ensureAt < waitAt, "re-register the command channel before waiting on canvas identity");
  assert.ok(ensureAt < serviceAt, "do not publish a list before the channel has been asked to re-register");
  assert.match(
    body,
    /send: \(\) => liveBridgeClient\?\.rehello\?\.\(\)/,
    "current-target recovery must re-hello THIS tab, not open another workflow",
  );
  assert.doesNotMatch(body.slice(0, waitAt), /openWorkflow\(|loadGraphData\(/);
});

test("#2030 wiring: a landed hello stamps this reconnect epoch so the watchdog stops", () => {
  assert.match(SRC, /tabChannelReadyEpoch = backendReconnectEpoch/);
  assert.match(
    SRC,
    /onHelloLanded:\s*\(ctx\)\s*=>\s*\{[\s\S]*?tabChannelReadyEpoch = backendReconnectEpoch;[\s\S]*?noteDedicatedWorkflowHello\(ctx\)/,
    "hello-landed must mark the command channel ready for this epoch without dropping the dedicated-workflow ack",
  );
});

test("#2030 wiring: #1999 Desktop restore is not this path", () => {
  const start = SRC.indexOf("function kickReconnectTabChannelWatch(");
  const next = SRC.indexOf("\nfunction ", start + 1);
  const body = SRC.slice(start, next > 0 ? next : start + 2500);
  assert.doesNotMatch(body, /restartCore|restartApp|relaunchApp|Desktop/);
});
