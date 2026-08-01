// Unit tests for web/js/lib/session-rebind.js — the frontend half of the
// session/tab-rebind cluster (#278, #334, #296, #291, #207, #332, #310).
// Run with `node --test browser_tests/unit/*.mjs`.

import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldResumeAfterComfyReconnect,
  shouldRehelloAfterCommand,
  planSoftReloadRecovery,
  performSoftReloadRecovery,
  isTransientReconnectError,
  retryDuringReconnect,
  workflowTabKey,
  dedupeWorkflowTabRecords,
  resolveLoadGraphArgs,
  buildHelloPayload,
} from "../../web/js/lib/session-rebind.js";

// ---- #278 post-reboot resume guard ----------------------------------------

test("#278: a live bridge never bounces, whatever the markers say", () => {
  assert.equal(
    shouldResumeAfterComfyReconnect({
      bridgeConnected: true,
      rebootPending: true,
      autoConnect: true,
      hasResumableSession: true,
    }),
    false,
  );
});

test("#278: reboot marker present + bridge down → resume (pre-existing behavior)", () => {
  assert.equal(
    shouldResumeAfterComfyReconnect({ bridgeConnected: false, rebootPending: true }),
    true,
  );
});

test("#278 REGRESSION: reboot marker LOST but a resumable session survives → resume", () => {
  // This is the bug: the old guard returned early (no REBOOT_KEY / AUTOCONNECT_KEY)
  // and stranded the live workflow conversation as "Connected: none".
  assert.equal(
    shouldResumeAfterComfyReconnect({
      bridgeConnected: false,
      rebootPending: false,
      autoConnect: false,
      hasResumableSession: true,
    }),
    true,
  );
});

test("#278: nothing to resume + bridge down → stay idle", () => {
  assert.equal(shouldResumeAfterComfyReconnect({ bridgeConnected: false }), false);
});

// ---- #310 rehello after free_vram -----------------------------------------

test("#310: a successful free_vram re-advertises the tab", () => {
  assert.equal(shouldRehelloAfterCommand("free_vram", { ok: true }), true);
});

test("#310: a FAILED free_vram does not rehello", () => {
  assert.equal(shouldRehelloAfterCommand("free_vram", { ok: false }), false);
});

test("#310: other commands never trigger the free_vram rehello", () => {
  assert.equal(shouldRehelloAfterCommand("graph_add_node", { ok: true }), false);
  assert.equal(shouldRehelloAfterCommand("free_vram", undefined), false);
});

// ---- #332 transient reconnect-window retry --------------------------------

test("#332: classifies a bare transport error as transient", () => {
  assert.equal(isTransientReconnectError(new TypeError("Failed to fetch")), true);
  assert.equal(isTransientReconnectError("NetworkError when attempting to fetch"), true);
  assert.equal(isTransientReconnectError(new Error("socket hang up")), true);
});

test("#332: a real HTTP error is NOT transient (must propagate unchanged)", () => {
  assert.equal(isTransientReconnectError(new Error("Manager customnode/installed: HTTP 500")), false);
  assert.equal(isTransientReconnectError(new Error("ComfyUI-Manager not reachable")), false);
});

test("#332: retries a transient failure then succeeds, with backoff", async () => {
  const sleeps = [];
  let calls = 0;
  const result = await retryDuringReconnect(
    async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("Failed to fetch");
      return { installed: ["a", "b"] };
    },
    { baseDelayMs: 10, sleep: async (ms) => sleeps.push(ms) },
  );
  assert.deepEqual(result, { installed: ["a", "b"] });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]); // exponential, only between attempts
});

test("#332: a persistent transient failure is reworded AND preserves the cause", async () => {
  const original = new TypeError("Failed to fetch");
  await assert.rejects(
    retryDuringReconnect(async () => { throw original; }, {
      attempts: 3,
      sleep: async () => {},
    }),
    (err) => {
      assert.match(err.message, /not reachable right now/i);
      assert.match(err.message, /may still be reconnecting/i);
      assert.match(err.message, /Failed to fetch/); // original text preserved
      assert.equal(err.cause, original); // type/stack preserved via cause
      return true;
    },
  );
});

test("#332: a non-transient error propagates immediately without retrying", async () => {
  let calls = 0;
  await assert.rejects(
    retryDuringReconnect(async () => { calls += 1; throw new Error("HTTP 500"); }, { sleep: async () => {} }),
    /HTTP 500/,
  );
  assert.equal(calls, 1); // no retries for a real server error
});

// ---- #207 tab-record dedupe -----------------------------------------------

test("#207: stable key normalizes separators + .json, strips path-scheme, preserves case", () => {
  // separators + lowercase .json normalized; case PRESERVED (no Linux case collapse)
  assert.equal(workflowTabKey({ path: "Workflows\\I2V_00025-audio.json" }), "Workflows/I2V_00025-audio");
  // a wf: key unifies with the path form (wf: always denotes a saved path)
  assert.equal(workflowTabKey({ key: "wf:workflows/a.json" }), workflowTabKey({ path: "workflows/a.json" }));
  // even a ROOT-LEVEL saved key unifies with its path form
  assert.equal(workflowTabKey({ key: "wf:foo.json" }), workflowTabKey({ path: "foo.json" }));
  assert.equal(workflowTabKey({ key: "tmp:workflows/a.json" }), "workflows/a");
  // a bare filename is NOT a stable identity → "" (kept distinct, never deduped)
  assert.equal(workflowTabKey({ filename: "Foo.json" }), "");
  assert.equal(workflowTabKey(null), "");
});

test("#207: a pathless temp key keeps its scheme and never collides with a saved file", () => {
  // "tmp:foo" (an unsaved tab, no path) must NOT collapse into saved "foo.json".
  assert.equal(workflowTabKey({ key: "tmp:foo" }), "tmp:foo");
  const deduped = dedupeWorkflowTabRecords([{ key: "tmp:foo" }, { path: "foo.json" }]);
  assert.equal(deduped.length, 2);
});

test("#207: multiple filename-only unsaved tabs stay DISTINCT (no destructive merge)", () => {
  const deduped = dedupeWorkflowTabRecords([
    { filename: "Unsaved Workflow", active: false },
    { filename: "Unsaved Workflow", active: true },
    { filename: "foo" }, // must NOT collide with a saved foo.json
    { path: "foo.json" },
  ]);
  assert.equal(deduped.length, 4);
});

test("#207: case-sensitive .json strip does not merge case-distinct extensions", () => {
  // Foo.JSON is left intact (case-sensitive strip) so it can't merge with foo.json.
  assert.notEqual(workflowTabKey({ path: "Foo.JSON" }), workflowTabKey({ path: "foo.json" }));
});

test("#207: distinct-case filenames are NOT collapsed (case-sensitive FS safe)", () => {
  const deduped = dedupeWorkflowTabRecords([{ path: "workflows/Foo.json" }, { path: "workflows/foo.json" }]);
  assert.equal(deduped.length, 2);
});

test("#207: a path-form and a wf:-key-form of the same file dedupe together", () => {
  const deduped = dedupeWorkflowTabRecords([
    { key: "tmp:workflows/I2V.json", active: false },
    { path: "workflows/I2V.json", active: true },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].active, true);
});

test("#207: duplicate active records for the same file collapse to one", () => {
  const records = [
    { path: "workflows/I2V.json", key: "tmp:abc", active: true, persisted: false, modified: true },
    { path: "workflows/I2V.json", key: "wf:workflows/I2V.json", active: true, persisted: true, modified: false },
    { path: "workflows/I2V.json", active: false, persisted: true },
  ];
  const deduped = dedupeWorkflowTabRecords(records);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].active, true);
  assert.equal(deduped[0].persisted, true);
  assert.equal(deduped[0].modified, true); // OR-merged across the collapsed records
});

test("#207: distinct workflows and blank/unsaved tabs are preserved", () => {
  const records = [
    { path: "workflows/A.json", active: true },
    { path: "workflows/B.json", active: false },
    { filename: "Unsaved Workflow" /* no path/key → distinct */ },
    {}, // fully blank
  ];
  const deduped = dedupeWorkflowTabRecords(records);
  assert.equal(deduped.length, 4);
});

test("#207: order is preserved (first occurrence wins its slot)", () => {
  const deduped = dedupeWorkflowTabRecords([
    { path: "a.json" },
    { path: "b.json" },
    { path: "a.json", modified: true },
  ]);
  assert.deepEqual(deduped.map((r) => r.path), ["a.json", "b.json"]);
  assert.equal(deduped[0].modified, true);
});

// ---- #207 / #334 load-into-active-tab args --------------------------------

test("#334: a load with an active workflow stays in the SAME tab (no Unsaved spawn)", () => {
  const wf = { path: "workflows/Cyberpunk.json", key: "wf:workflows/Cyberpunk.json" };
  const args = resolveLoadGraphArgs({ nodes: [] }, wf);
  assert.equal(args.length, 4);
  assert.equal(args[3], wf); // 4th arg associates the load with the existing tab
  assert.equal(args[1], true);
  assert.equal(args[2], true);
});

test("#334: a load onto a truly blank canvas falls back to a single-arg load", () => {
  const args = resolveLoadGraphArgs({ nodes: [] }, null);
  assert.deepEqual(args, [{ nodes: [] }]);
});

// ---- #296 / #291 session-init hello frame ---------------------------------

test("#296: hello advertises comfyui_path when a local workspace is known", () => {
  const frame = buildHelloPayload({
    tabId: "wf:workflows/x.json",
    title: "x",
    panelVersion: "0.11.19",
    backend: "codex",
    comfyuiUrl: "http://127.0.0.1:8188",
    comfyuiPath: "C:\\AI\\ComfyUI_windows_portable",
  });
  assert.equal(frame.type, "hello");
  assert.equal(frame.comfyui_path, "C:\\AI\\ComfyUI_windows_portable");
  assert.equal(frame.backend, "codex");
  assert.equal(frame.comfyui_url, "http://127.0.0.1:8188");
});

test("#296: comfyui_path is omitted (never blank) when unknown", () => {
  const frame = buildHelloPayload({ tabId: "t", comfyuiPath: "   " });
  assert.equal("comfyui_path" in frame, false);
  assert.equal(frame.backend, "claude"); // default provider
  assert.equal(frame.blind, false);
});

test("#296: resume rides the hello only when present", () => {
  assert.equal("resume" in buildHelloPayload({ tabId: "t" }), false);
  assert.equal(buildHelloPayload({ tabId: "t", resume: "sess-1" }).resume, "sess-1");
});

// ---- #379 soft-reload recovery: never leave the bridge dead -----------------

test("#379: a REFUSED reload (by-design 503) still reconnects, dropping the interlock", () => {
  // This pack's /reload returns { ok:false } — the orchestrator never stops.
  const plan = planSoftReloadRecovery({ ok: false, reachable: true });
  assert.equal(plan.accepted, false);
  assert.equal(plan.reconnect, true); // bridge MUST be restored — no wedge
  assert.equal(plan.keepResumeInterlock, false); // no respawn to interlock
});

test("#379: an unreachable reload POST still reconnects the dropped bridge", () => {
  const plan = planSoftReloadRecovery({ ok: true, reachable: false });
  assert.equal(plan.accepted, false);
  assert.equal(plan.reconnect, true);
  assert.equal(plan.keepResumeInterlock, false);
});

test("#379: an ACCEPTED reload keeps the resume interlock and reconnects", () => {
  // A pack that DOES own the orchestrator: reload accepted → keep SOFT_RELOAD_KEY
  // + guard so the fresh orchestrator binds and onAck resumes the conversation.
  const plan = planSoftReloadRecovery({ ok: true, reachable: true });
  assert.equal(plan.accepted, true);
  assert.equal(plan.reconnect, true);
  assert.equal(plan.keepResumeInterlock, true);
});

test("#379: reconnect is unconditional across every outcome (no dead-bridge path)", () => {
  for (const ok of [true, false]) {
    for (const reachable of [true, false]) {
      assert.equal(planSoftReloadRecovery({ ok, reachable }).reconnect, true);
    }
  }
  // Defaults are the safe path: refused + reconnect.
  const d = planSoftReloadRecovery();
  assert.equal(d.reconnect, true);
  assert.equal(d.keepResumeInterlock, false);
});

// ---- #419 soft-reload LIFECYCLE: a reload never leaves a bridge dead ---------
// #419 reported panel_reload leaving open sidebar tabs permanently disconnected.
// The fix guarantee is at the stop→start level: whatever the reload POST does,
// the dropped bridge is ALWAYS restarted. The pure planSoftReloadRecovery truth
// table (above) can't lock this, because softReload() does not branch on
// `reconnect` — it drives performSoftReloadRecovery(), which owns the sequence.
// These tests spy on ONE client's stop/start across every outcome, and — since
// the lifecycle is per-tab, state-free, and shares nothing — that same guarantee
// holds independently for each of N open tabs (no subset, or all, left dead).

// Drive the lifecycle with a spy client + injected postReload, returning the
// recorded stop/start order and which interlock branch ran.
async function runLifecycle(postReload) {
  const events = [];
  const client = {
    stop: () => events.push("stop"),
    start: () => events.push("start"),
  };
  let kept = false;
  let cleared = false;
  let noted = null;
  const result = await performSoftReloadRecovery({
    client,
    postReload,
    onKeepInterlock: () => {
      kept = true;
    },
    onClearInterlock: () => {
      cleared = true;
    },
    note: (outcome) => {
      noted = outcome;
    },
  });
  return { events, kept, cleared, noted, result };
}

test("#419: an ACCEPTED reload stops THEN restarts the bridge and keeps the interlock", async () => {
  const { events, kept, cleared, result } = await runLifecycle(async () => ({
    ok: true,
    reachable: true,
  }));
  assert.deepEqual(events, ["stop", "start"]); // bridge always restored
  assert.equal(kept, true);
  assert.equal(cleared, false);
  assert.equal(result.accepted, true);
  assert.equal(result.keepResumeInterlock, true);
});

test("#419: a REFUSED 503 reload stops THEN restarts the bridge and clears the interlock", async () => {
  const { events, kept, cleared, noted, result } = await runLifecycle(async () => ({
    ok: false, // by-design 503: reachable response, not ok
    reachable: true,
    startCommand: "node dist/index.js",
  }));
  assert.deepEqual(events, ["stop", "start"]); // NEVER left dead (the #379 wedge)
  assert.equal(kept, false);
  assert.equal(cleared, true);
  assert.equal(noted.error, undefined); // refused, not a transport error
  assert.equal(noted.startCommand, "node dist/index.js"); // manual-restart hint surfaced
  assert.equal(result.keepResumeInterlock, false);
});

test("#419: a THROWN/timed-out reload POST still stops THEN restarts the bridge", async () => {
  const { events, cleared, noted, result } = await runLifecycle(async () => {
    throw new Error("reload request timed out");
  });
  assert.deepEqual(events, ["stop", "start"]); // unreachable → still reconnects
  assert.equal(cleared, true);
  assert.equal(noted.error instanceof Error, true);
  assert.match(noted.error.message, /timed out/);
  assert.equal(result.accepted, false);
  assert.equal(result.keepResumeInterlock, false);
});

test("#419: the bridge is restarted even if the interlock callback throws", async () => {
  // The hard guarantee: nothing between stop() and start() can strand the bridge.
  const events = [];
  const client = {
    stop: () => events.push("stop"),
    start: () => events.push("start"),
  };
  await performSoftReloadRecovery({
    client,
    postReload: async () => ({ ok: false, reachable: true }),
    onClearInterlock: () => {
      throw new Error("interlock callback blew up");
    },
    note: () => {
      throw new Error("note blew up (should not be reached — interlock threw first)");
    },
  });
  assert.deepEqual(events, ["stop", "start"]); // start() still fires from the finally
});

test("#419: the bridge is restarted even if the note callback throws (interlock ran)", async () => {
  // Distinct from above: onClearInterlock SUCCEEDS, then note throws — start() must
  // STILL fire (the note is a downstream best-effort effect).
  const events = [];
  const client = {
    stop: () => events.push("stop"),
    start: () => events.push("start"),
  };
  let cleared = false;
  await performSoftReloadRecovery({
    client,
    postReload: async () => ({ ok: false, reachable: true }),
    onClearInterlock: () => {
      cleared = true;
    },
    note: () => {
      throw new Error("note blew up");
    },
  });
  assert.equal(cleared, true); // the interlock effect DID run
  assert.deepEqual(events, ["stop", "start"]); // and the bridge still reconnected
});

test("#419: a THROWING plan() still stops THEN restarts the bridge (never rejects)", async () => {
  // The DI contract: nothing between stop() and start() — including a throwing
  // injected plan — may strand the bridge or reject the reload.
  const events = [];
  const client = {
    stop: () => events.push("stop"),
    start: () => events.push("start"),
  };
  let planCalled = false;
  const result = await performSoftReloadRecovery({
    client,
    postReload: async () => ({ ok: true, reachable: true }),
    plan: () => {
      planCalled = true;
      throw new Error("plan blew up");
    },
  });
  assert.equal(planCalled, true); // the injected plan WAS invoked (not bypassed)
  assert.deepEqual(events, ["stop", "start"]); // reconnect still guaranteed
  assert.equal(result.reconnect, true); // contract value survives a thrown plan
});

test("#419: a stop() that throws does NOT skip the reconnect", async () => {
  const events = [];
  const client = {
    stop: () => {
      events.push("stop-throw");
      throw new Error("socket close failed");
    },
    start: () => events.push("start"),
  };
  await performSoftReloadRecovery({
    client,
    postReload: async () => ({ ok: true, reachable: true }),
  });
  assert.deepEqual(events, ["stop-throw", "start"]); // start still reached
});

test("#419: beforeStart runs immediately BEFORE start (pre-extraction ordering)", async () => {
  // The caller clears its `reloading` re-entrancy flag in beforeStart; it MUST run
  // before the reconnect so the ordering matches the pre-extraction code.
  const events = [];
  const client = {
    stop: () => events.push("stop"),
    start: () => events.push("start"),
  };
  await performSoftReloadRecovery({
    client,
    postReload: async () => ({ ok: true, reachable: true }),
    beforeStart: () => events.push("beforeStart"),
  });
  assert.deepEqual(events, ["stop", "beforeStart", "start"]);
});

test("#419: N open tabs each independently reconnect — no subset left dead", async () => {
  // Each tab runs its OWN lifecycle on its OWN spy client with a DIFFERENT POST
  // outcome; the lifecycle shares no state, so every tab is restarted.
  const outcomes = [
    async () => ({ ok: true, reachable: true }), // accepted
    async () => ({ ok: false, reachable: true }), // by-design 503
    async () => {
      throw new Error("unreachable"); // POST never answered
    },
  ];
  const runs = await Promise.all(outcomes.map((p) => runLifecycle(p)));
  for (const r of runs) {
    assert.deepEqual(r.events, ["stop", "start"]); // this tab reconnected
    assert.equal(r.result.reconnect, true);
  }
});
