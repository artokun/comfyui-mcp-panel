// Unit tests for web/js/lib/session-rebind.js — the frontend half of the
// session/tab-rebind cluster (#278, #334, #296, #291, #207, #332, #310).
// Run with `node --test browser_tests/unit/*.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
// #1138 adds one structural test (the call site's polarity), which the rest of this
// pure-logic file does not need.
import { readFileSync } from "node:fs";

import {
  shouldResumeAfterComfyReconnect,
  shouldReadvertiseAfterComfyRestart,
  createRestartReadvertiseController,
  createComfyBackendOutageTracker,
  shouldRehelloAfterCommand,
  shouldNudgeAfterMidTaskReconnect,
  createBridgeOutageTracker,
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

test("#570/#718: hello ALWAYS advertises both workflow-stamp fences so the orchestrator can safely allow graph edits", () => {
  // A current build fences at dispatch AND immediately before an async graph write.
  // Both flags must ride every hello (not gated behind optional fields), so the
  // server never treats this build like an older unsafe bundle.
  assert.equal(buildHelloPayload({ tabId: "t" }).enforces_workflow_stamp, true);
  assert.equal(buildHelloPayload({ tabId: "t" }).enforces_workflow_stamp_at_write, true);
  assert.equal(buildHelloPayload({ tabId: "t" }).enforces_expected_node_type_at_write, true);
  assert.equal(
    buildHelloPayload({ tabId: "wf:x.json", title: "x", backend: "codex" }).enforces_workflow_stamp,
    true,
  );
  assert.equal(
    buildHelloPayload({ tabId: "wf:x.json", title: "x", backend: "codex" }).enforces_workflow_stamp_at_write,
    true,
  );
  assert.equal(
    buildHelloPayload({ tabId: "wf:x.json", title: "x", backend: "codex" }).enforces_expected_node_type_at_write,
    true,
  );
});

test("#709: hello carries the browser-tab identity separately from workflow routing", () => {
  const frame = buildHelloPayload({ tabId: "wf:shared.json", tabSessionId: "browser-tab-a" });
  assert.equal(frame.tab_id, "wf:shared.json");
  assert.equal(frame.tab_session_id, "browser-tab-a");
  assert.equal("tab_session_id" in buildHelloPayload({ tabId: "wf:shared.json" }), false);
  assert.equal("tab_session_id" in buildHelloPayload({ tabId: "wf:shared.json", tabSessionId: "   " }), false);
});

test("#570: the durable per-instance workflow uuid rides the hello when present", () => {
  // Lets the orchestrator key an UNSAVED workflow's resume on a globally-unique id
  // that survives the tmp:<uuid> tab-id churn — so a same-title sibling can't
  // cross-resume its conversation (the reopened #570 residual).
  const frame = buildHelloPayload({ tabId: "tmp:abc", title: "Unsaved Workflow", workflowUuid: "wf-uuid-1" });
  assert.equal(frame.workflow_uuid, "wf-uuid-1");
});

test("#570: workflow_uuid is omitted (never blank) when unknown, so old behavior stands", () => {
  assert.equal("workflow_uuid" in buildHelloPayload({ tabId: "t" }), false);
  assert.equal("workflow_uuid" in buildHelloPayload({ tabId: "t", workflowUuid: "   " }), false);
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

// ── #1138: a mid-task "you dropped" nudge needs a drop to have happened ──────
//
// The nudge injects a user message and writes to the durable transcript. Both are false,
// and the injection is harmful, unless the orchestrator really died: telling a working
// agent to resume makes it restart or duplicate what it is doing.
//
// The gap heuristic was right; the sentinel's arithmetic betrayed it. The drop stamp was
// 0 until the bridge socket CLOSED, and `Date.now() - 0` is ~56 years — the longest
// possible gap, read as the strongest possible evidence of a real restart. So the guard
// was inverted exactly where it mattered: the better established that nothing dropped, the
// more confidently it nudged. Reachable on a live socket because `ready` repeats on one and
// #310 re-advertises after every successful free_vram.
//
// #1145 restated the predicate's input as a MEASURED OUTAGE rather than a timestamp to
// subtract from `now` (see the module note). The #1138 rule is unchanged and still locked
// below — "no drop was recorded" is now the honest value 0 instead of a sentinel that
// subtracted like 1970.

test("#1138: NEVER dropped must not nudge, however long the session has run", () => {
  // The reported shape: a live socket, a re-advertise, a ready ack, and no drop anywhere.
  // The old guard subtracted the 0 sentinel from a real clock and passed on ~56 years;
  // an unmeasured outage is now simply 0 ms, which cannot be mistaken for a long one.
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: 0 }), false);
  for (const noDrop of [undefined, null, 0, -1, NaN, Infinity, "0", "30000", {}]) {
    assert.equal(
      shouldNudgeAfterMidTaskReconnect({ outageMs: noDrop }),
      false,
      `no measured outage must never nudge: ${JSON.stringify(noDrop)}`,
    );
  }
  assert.equal(shouldNudgeAfterMidTaskReconnect(), false, "no arguments must not nudge");
});

test("#1138: a REAL restart still nudges — the fix must not disable the feature", () => {
  // The behaviour #278/#588 rely on: a long outage is a real restart.
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: 30_000 }), true);
  // Exactly at the boundary counts as real (>= minOutageMs), so the threshold is not
  // silently exclusive.
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: 6000 }), true);
});

test("#1138: a FAST reconnect after a real drop still does not nudge", () => {
  // The pre-existing half of the rule, preserved: a sidebar remount or a brief WS blip
  // means the orchestrator never died, so the turn kept running.
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: 1 }), false);
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: 5999 }), false);
});

test("#1138: a NEGATIVE duration is not evidence of a long outage", () => {
  // A wall-clock adjustment must not read as an ancient drop — the same class of mistake
  // as the 0 sentinel, one step along.
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: -60_000 }), false);
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: -1 }), false);
  // …and an unreadable threshold decides nothing either.
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: 30_000, minOutageMs: NaN }), false);
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: 30_000, minOutageMs: "6s" }), false);
});

test("#1138: the guard is INVERSION-SENSITIVE, unlike a source scan", () => {
  // #1096's review proved by mutation that a token-presence source scan stays green when
  // the guard is inverted. This asserts the two sides disagree, so an inverted or dropped
  // condition cannot pass: the never-dropped case and the real-restart case must differ.
  const neverDropped = shouldNudgeAfterMidTaskReconnect({ outageMs: 0 });
  const realRestart = shouldNudgeAfterMidTaskReconnect({ outageMs: 30_000 });
  assert.notEqual(
    neverDropped,
    realRestart,
    "if these ever agree, the guard has stopped distinguishing no-drop from a real restart",
  );
  assert.equal(neverDropped, false);
  assert.equal(realRestart, true);
});

test("#1138 wiring: the call site NEGATES the predicate and returns", () => {
  // The predicate is tested by behaviour above; this covers the one thing a pure test
  // cannot see — that the call site consults it in the right POLARITY. Dropping the
  // negation would invert the fix into "nudge only when nothing dropped", which is worse
  // than the original bug. An exact-substring claim on purpose: #1096's review proved by
  // mutation that loose token-presence scans over this file assert nothing at all.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.ok(
    src.includes(
      "if (!shouldNudgeAfterMidTaskReconnect({ outageMs: bridgeOutage.outageMs() })) return;",
    ),
    "the ready-ack mid-task branch must NEGATE the predicate and read the measured outage",
  );
  // The reverted sessionStorage twin must not return without its own review: every
  // confirmed leak on this branch came from persisting that timestamp.
  assert.doesNotMatch(src, /BRIDGE_DOWN_AT_KEY/, "the persisted drop timestamp stays reverted");
  // #1145 — and the tracker measures on the MONOTONIC clock. This is the one part a
  // behavioural test over the module cannot see: the tracker's own default is
  // `Date.now()` (it must stay usable standalone), so which clock the PANEL measures
  // with is decided at the construction site and nowhere else. reconnect-staleness.js
  // already fixed this rule for elapsed-window state after a prior review; a wall clock
  // here lets an NTP/DST correction inside a reconnect invent or erase an outage.
  assert.ok(
    src.includes("createBridgeOutageTracker({ now: monotonicNow })"),
    "the panel's outage tracker must measure on the monotonic clock",
  );
  // #1145 — and the two WRITE sites, not just the read. The tracker's behaviour is
  // covered above, but a tracker nothing feeds answers 0 forever and every one of these
  // tests still passes: deleting `noteBridgeClosed()` from the close handler silently
  // restores "no drop was ever recorded", which is the bug #1138 fixed. Each site is
  // pinned by exact substring for #1096's reason — loose token scans over this file
  // assert nothing.
  for (const [site, snippet] of [
    ["the socket close handler must open the outage", "bridgeOutage.noteBridgeClosed();"],
    ["a concluded death must open one too (#1168)", "bridgeOutage.noteAgentGone();"],
    ["the models handshake must close it", "bridgeOutage.noteHandshake();"],
    ["a turn start must scope the evidence to that turn", "bridgeOutage.noteTurnStarted();"],
  ]) {
    assert.ok(src.includes(snippet), site);
  }
  // The WEDGE-death path is a FOURTH write site and is pinned separately, at the end of
  // this file (#1168). It is not listed here because it is not a close: a wedged
  // orchestrator holds its socket open and never fires one, so the event it records is
  // the panel's own conclusion rather than a socket transition. Two earlier attempts to
  // pin it here were removed with the code they described — the negative half scanned
  // stop()/setUrl()/destroy() for a literal `bridgeOutage.`, while the design it claimed
  // to reject put the stamp in a shared helper CALLED from those bodies, so it would
  // have passed against the very regression it named. #1168's pin counts the call
  // instead, which a wrapper cannot evade.
});

// ── #1145: the interval must be the OUTAGE, not one backoff step ─────────────
//
// `connect()` assigns `sock` before the connection resolves, so a REFUSED attempt during
// a restart is still the active socket and runs the close handler in full. The old code
// re-stamped the drop time there, and with backoff doubling from RECONNECT_BASE_MS the
// retries land near t=1s/3s/7s/15s — so the successful attempt was separated from the
// previous failed close by only THAT attempt's delay. The guard weighed one backoff step,
// and a genuine restart returning inside ~7s measured ~4s and lost its nudge: the session
// resumed with full context and no pending turn, leaving the agent idle after exactly the
// event the nudge exists for.
//
// These drive the tracker through the real ORDER of events, which is the only way to see
// it: no single call distinguishes "the drop" from "the third refused retry".

/** A tracker over a hand-driven clock: `clock.t` is the wall time it reads. */
function trackerAt(t0 = 1_700_000_000_000) {
  const clock = { t: t0 };
  return { clock, tracker: createBridgeOutageTracker({ now: () => clock.t }) };
}

test("#1145: refused retries during a restart must not reset the outage clock", () => {
  // The reported sequence, to scale: the bridge drops, three reconnect attempts are
  // refused at the backoff delays, and the fourth connects — a 7s outage.
  const { clock, tracker } = trackerAt();
  const t0 = clock.t;
  tracker.noteTurnStarted(); // a turn is in flight; this is the mid-task case
  tracker.noteBridgeClosed(); // t=0 — the real drop
  for (const t of [1000, 3000]) {
    clock.t = t0 + t;
    tracker.noteBridgeClosed(); // a REFUSED attempt closes exactly like a drop
  }
  clock.t = t0 + 7000;
  tracker.noteHandshake(); // the attempt at ~7s connects

  assert.equal(
    tracker.outageMs(),
    7000,
    "the measured interval must be the whole outage, not the last backoff step",
  );
  assert.equal(
    shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }),
    true,
    "a genuine restart that returns in ~7s must keep its nudge",
  );
});

test("#1145: the old per-attempt stamp would have measured one step and lost the nudge", () => {
  // The counterfactual, asserted rather than described: had the final refused close reset
  // the clock (the defect), the interval would have been 7000-3000=4000ms — under the 6s
  // threshold, so no nudge. This is what must never come back.
  const lastBackoffStep = 7000 - 3000;
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: lastBackoffStep }), false);
  assert.notEqual(
    shouldNudgeAfterMidTaskReconnect({ outageMs: 7000 }),
    shouldNudgeAfterMidTaskReconnect({ outageMs: lastBackoffStep }),
    "outage and backoff-step must not agree, or the regression is invisible",
  );
});

test("#1145: a genuinely fast reconnect still measures fast", () => {
  // The other half of the rule: measuring the outage must not turn every blip into a
  // restart. One close, reconnected in 2s, is still a blip.
  const { clock, tracker } = trackerAt();
  tracker.noteBridgeClosed();
  clock.t += 2000;
  tracker.noteHandshake();
  assert.equal(tracker.outageMs(), 2000);
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), false);
});

test("#1145: a handshake that ended NO outage inherits nothing", () => {
  // `ready`/`models` repeat on a LIVE socket — #310 re-advertises after every successful
  // free_vram. A re-advertise must record nothing rather than adopting the previous
  // outage; adopting it is how a settled drop gets reported as "your connection dropped".
  const { clock, tracker } = trackerAt();
  tracker.noteBridgeClosed();
  clock.t += 30_000;
  tracker.noteHandshake(); // a real 30s outage ends
  assert.equal(tracker.outageMs(), 30_000);

  clock.t += 600_000; // ten quiet minutes on the same live socket
  tracker.noteHandshake(); // a free_vram re-advertise draws a fresh handshake
  assert.equal(
    tracker.outageMs(),
    30_000,
    "a re-advertise must not restate the elapsed time as a NEW outage",
  );
  assert.equal(tracker.isDown(), false);
});

test("#1145: an outage that ended BEFORE this turn is not this turn's evidence", () => {
  // #1138 fixed a stale 0 reading as ~56 years. A stale POSITIVE duration is the same
  // defect one step along: a real 30s outage, settled two turns ago, must not be re-read
  // by a `ready` that merely repeats on the live socket during the turn running now.
  const { clock, tracker } = trackerAt();
  tracker.noteBridgeClosed();
  clock.t += 30_000;
  tracker.noteHandshake();
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), true);

  clock.t += 300_000;
  tracker.noteTurnStarted(); // a NEW turn begins — the old outage is not about it
  assert.equal(tracker.outageMs(), 0);
  assert.equal(
    shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }),
    false,
    "a settled outage must not nudge a turn that started after it",
  );
});

test("#1145: a drop DURING the turn is still this turn's evidence", () => {
  // The complement of the test above — turn-scoping must not swallow the case the nudge
  // exists for. A turn starts, THEN the bridge drops for 30s and comes back.
  const { clock, tracker } = trackerAt();
  tracker.noteTurnStarted();
  clock.t += 5000;
  tracker.noteBridgeClosed();
  clock.t += 30_000;
  tracker.noteHandshake();
  assert.equal(tracker.outageMs(), 30_000);
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), true);
});

test("#1145: a fresh tracker has seen no outage", () => {
  // The #1138 case at the source: a page load / panel mount that never saw a drop reports
  // 0, not a sentinel that subtracts like 1970.
  const { tracker } = trackerAt();
  assert.equal(tracker.outageMs(), 0);
  assert.equal(tracker.isDown(), false);
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), false);
});

test("#1145: a backwards clock cannot manufacture or corrupt an outage", () => {
  // A wall-clock adjustment mid-outage must not yield a negative duration, and an
  // unreadable clock must withhold the nudge rather than invent one — a missed nudge
  // leaves an idle agent, an invented one derails a working agent.
  const { clock, tracker } = trackerAt();
  tracker.noteBridgeClosed();
  clock.t -= 60_000; // the clock jumps backwards during the outage
  tracker.noteHandshake();
  assert.equal(tracker.outageMs(), 0);

  const broken = createBridgeOutageTracker({ now: () => NaN });
  broken.noteBridgeClosed();
  broken.noteHandshake();
  assert.equal(broken.outageMs(), 0);
  assert.equal(broken.isDown(), false, "an untimed outage must still be closed out");
});

test("#1145: a `ready` ack that beats the models handshake still measures the outage", () => {
  // THE ORDERING THIS NEARLY GOT WRONG. The reader is the ready ack, and ready does not
  // wait for the handshake that closes an outage: the orchestrator pushes its models
  // frame from an async continuation (`void ensureModels(backend).then(…)`) while the
  // ready ack goes out synchronously once hello is processed. For any backend whose
  // model discovery costs a probe, ready arrives FIRST — so at read time the outage is
  // still open. Reporting the last CLOSED outage there would answer 0 and swallow the
  // nudge on exactly the real restart this issue exists to restore.
  const { clock, tracker } = trackerAt();
  tracker.noteTurnStarted();
  tracker.noteBridgeClosed(); // ComfyUI restarts
  clock.t += 30_000; // socket is back and hello processed; models still discovering
  assert.equal(tracker.isDown(), true, "the handshake has not closed the outage yet");
  assert.equal(
    tracker.outageMs(),
    30_000,
    "an outage still in progress must read live, not as the last closed one",
  );
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), true);

  // …and the models frame landing moments later agrees, rather than revising it.
  clock.t += 40;
  tracker.noteHandshake();
  assert.equal(tracker.outageMs(), 30_040);
});

test("#1145: a LIVE reading still measures the outage, not the last backoff step", () => {
  // The live path must not be a back door to the original defect: refused retries during
  // the outage must leave its start alone here too.
  const { clock, tracker } = trackerAt();
  const t0 = clock.t;
  tracker.noteTurnStarted();
  tracker.noteBridgeClosed();
  for (const t of [1000, 3000]) {
    clock.t = t0 + t;
    tracker.noteBridgeClosed(); // refused attempts
  }
  clock.t = t0 + 7000; // the ready ack arrives before models
  assert.equal(tracker.outageMs(), 7000, "live reading measures the outage, not 7000-3000");
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), true);
});

test("#1145: a never-dropped bridge reads 0 live, not the age of the session", () => {
  // The #1138 case against the live path: with no outage open, the live branch must not
  // engage at all. If it measured from a 0 start it would report the whole session as an
  // outage — the ~56-year sentinel bug, reintroduced through the new reading.
  const { clock, tracker } = trackerAt();
  clock.t += 3_600_000; // an hour of uptime, never a drop
  assert.equal(tracker.isDown(), false);
  assert.equal(tracker.outageMs(), 0);
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), false);
});

// ── #1163: a turn start CLOSES the outage, it does not merely zero the total ──
//
// Zeroing alone left `startedAt` running across the turn boundary, so an outage that
// began before the turn was still measured from before the turn existed. Reachable
// because sendUserMessage needs only an OPEN socket, not a handshake, and the socket
// reopens well before the `models` frame — so a user can type into the gap and have the
// reply nudged as though their connection had just dropped.

test("#1163: a turn started during an open outage is not charged with it", () => {
  // The reported sequence. Bridge drops; the socket is back but unhandshaken; the user
  // sends a message; the late handshake must NOT measure from before that turn.
  const { clock, tracker } = trackerAt();
  tracker.noteBridgeClosed(); // t=0, the real drop
  clock.t += 5000; // socket reopens; `models` still pending
  tracker.noteTurnStarted(); // the user's new message draws turn:working
  assert.equal(tracker.isDown(), false, "a frame from the orchestrator ends the outage");
  assert.equal(tracker.outageMs(), 0);

  clock.t += 30_000; // the models frame finally lands
  tracker.noteHandshake();
  assert.equal(tracker.outageMs(), 0, "the pre-turn drop must not be measured here");
  assert.equal(
    shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }),
    false,
    "a turn the user just started must never be told its connection dropped",
  );
});

test("#1163: any turn start during an outage ends it — a working agent is never nudged", () => {
  // Deliberately stated as the TRACKER's contract, not as a claim about frame ordering.
  // An earlier version of this test asserted that a surviving orchestrator's re-announce
  // beats the `ready` ack; the panel guarantees no such ordering, so that test pinned an
  // assumption rather than a behaviour. What is true without any ordering assumption:
  // whenever a turn start is seen, a turn is in flight, and the nudge exists only to
  // rescue an IDLE agent — so from that moment there is nothing to rescue. If the ack
  // arrives FIRST the outage still stands and the nudge fires, which is correct too:
  // nothing had yet said a turn was running.
  const { clock, tracker } = trackerAt();
  tracker.noteTurnStarted(); // turn begins
  tracker.noteBridgeClosed(); // ComfyUI bounces, orchestrator survives
  clock.t += 30_000;
  tracker.noteTurnStarted(); // the surviving turn re-announces on reconnect
  assert.equal(
    shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }),
    false,
    "a turn that never died must not be told to resume",
  );
});

test("#1163: an orchestrator that DIED still nudges — no re-announce arrives first", () => {
  // The complement, so the fix cannot be satisfied by never nudging: a dead orchestrator
  // has no live turn to re-announce, so nothing closes the outage before the ready ack.
  const { clock, tracker } = trackerAt();
  tracker.noteTurnStarted();
  tracker.noteBridgeClosed();
  clock.t += 30_000;
  tracker.noteHandshake(); // only the handshake arrives — no turn:working
  assert.equal(tracker.outageMs(), 30_000);
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), true);
});

test("#1163: a drop AFTER the turn start is still measured in full", () => {
  // Closing on a turn start must not blunt the live path: a drop that happens after the
  // turn begins is entirely this turn's, including when read before the handshake.
  const { clock, tracker } = trackerAt();
  tracker.noteTurnStarted();
  clock.t += 1000;
  tracker.noteBridgeClosed();
  clock.t += 20_000;
  assert.equal(tracker.outageMs(), 20_000, "live read, ready ahead of models");
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), true);
});

test("#1145: a second outage measures itself, not the gap since the first", () => {
  // The outage must close cleanly, or the NEXT drop measures from the previous one's
  // start and every later reconnect reads as a longer and longer restart.
  const { clock, tracker } = trackerAt();
  tracker.noteBridgeClosed();
  clock.t += 30_000;
  tracker.noteHandshake();

  clock.t += 600_000;
  tracker.noteTurnStarted();
  tracker.noteBridgeClosed(); // a SECOND, brief outage
  clock.t += 1500;
  tracker.noteHandshake();
  assert.equal(tracker.outageMs(), 1500, "the second outage is 1.5s, not 10 minutes");
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), false);
});

// ── #1168: a WEDGED orchestrator's death OPENS an outage of its own ───────────
//
// The outage clock is started by the socket `close` listener, and a wedged orchestrator
// never fires one: it holds the connection open and answers nothing. So the outage the
// death caused is not merely mismeasured, it is never opened at all — and when the wedged
// process finally dies the clock starts from THAT moment, so a user who restarts it
// promptly measures the restart. Minutes with no agent behind the socket are weighed as a
// three-second blip and the turn is never resumed.
//
// The fix opens the outage where the panel CONCLUDES the death. What it deliberately does
// not do is exempt that death from the threshold — a first draft passed the conclusion to
// the predicate and let it outrank the clock, and review showed that nudges a live agent
// whenever the conclusion is wrong (a socket stale under a sleep / NAT idle-kill presents
// identically). The interval remains the sole gate; #1168 only makes sure it is measured
// from when the agent stopped answering rather than from when its process finally exited.

test("#1168: a wedge that no close ever reported still resumes the turn", () => {
  // The reported sequence, to scale. A turn is in flight; the orchestrator wedges with
  // its socket OPEN, so nothing closes. The panel spends its full redial ladder (~60s)
  // establishing that nothing answers, then concludes. The user reads the hint, restarts
  // the agent by hand, and the fresh one is up three seconds after the old port frees.
  const { clock, tracker } = trackerAt();
  tracker.noteTurnStarted();
  clock.t += 60_000; // the redial ladder — an open socket, no `models`, no close
  tracker.noteAgentGone(); // the panel concludes the agent behind it is gone
  clock.t += 120_000; // the user reads the hint and restarts it out-of-band
  tracker.noteBridgeClosed(); // the wedged process finally dies as it is replaced
  clock.t += 3000; // the fresh orchestrator binds the port…
  tracker.noteHandshake(); // …and handshakes

  assert.equal(
    tracker.outageMs(),
    123_000,
    "the outage runs from the death the panel concluded, not from the process exit",
  );
  assert.equal(
    shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }),
    true,
    "a turn a wedge interrupted must be resumed",
  );
});

test("#1168: the counterfactual — measuring from the process exit loses the nudge", () => {
  // What main does with the same sequence, asserted rather than described: with nothing
  // recording the death, the first close is the wedged process finally exiting, and the
  // interval is the three-second RESTART. Under the threshold, no nudge, turn stranded.
  // If these two ever agree the fix has become invisible.
  const { clock, tracker } = trackerAt();
  tracker.noteTurnStarted();
  clock.t += 60_000;
  clock.t += 120_000; // …no noteAgentGone(): the wedge goes unrecorded
  tracker.noteBridgeClosed();
  clock.t += 3000;
  tracker.noteHandshake();
  assert.equal(tracker.outageMs(), 3000);
  assert.equal(
    shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }),
    false,
    "this is the bug — three minutes with no agent read as a blip",
  );
});

test("#1168: a conclusion the panel got WRONG must not nudge a live agent", () => {
  // The finding that rejected the first draft, kept as a regression test. The panel
  // cannot tell "the orchestrator died" from "my own socket went stale while it kept
  // working": a half-open TCP after a laptop sleep, a NAT idle-kill or a VPN flap all
  // present as an open socket answering nothing, so the give-up ladder concludes a death
  // that never happened. The orchestrator is alive and mid-turn, and answers again as
  // soon as the stale socket is torn down.
  //
  // Nothing here relies on frame ORDERING. The earlier draft's safety argument did — it
  // assumed a surviving turn's re-announce beats the `ready` ack — and this file already
  // records (see the #1163 test above) that the panel guarantees no such thing. The
  // elapsed interval is what makes this safe, which is why the conclusion opens an outage
  // instead of bypassing the threshold.
  const { clock, tracker } = trackerAt();
  tracker.noteTurnStarted();
  clock.t += 60_000;
  tracker.noteAgentGone(); // concluded — wrongly
  clock.t += 1000;
  tracker.noteBridgeClosed(); // the OS finally tears the stale TCP down
  clock.t += 1500;
  tracker.noteHandshake(); // the SAME, still-alive orchestrator answers
  assert.equal(tracker.outageMs(), 2500);
  assert.equal(
    shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }),
    false,
    "an agent that never stopped working must not be told to start over",
  );
});

test("#1168: a concluded death does not restart a clock already running", () => {
  // The give-up ladder can be reached with an outage already open (the terminal
  // `disconnected` caller gets there through its own failed retries). Re-stamping would
  // discard everything before it — the #1145 backoff-step defect through a new door — so
  // the first opener wins here exactly as it does for a close.
  const { clock, tracker } = trackerAt();
  tracker.noteTurnStarted();
  tracker.noteBridgeClosed(); // t=0, the drop
  clock.t += 20_000; // reconnect patience runs out
  tracker.noteAgentGone(); // the same latch, reached from the disconnected caller
  clock.t += 2000;
  tracker.noteHandshake();
  assert.equal(tracker.outageMs(), 22_000, "the outage keeps its original start");
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }), true);
});

test("#1168: a turn start still closes an outage a conclusion opened", () => {
  // Turn-scoping must reach the new opener too, or a wedge concluded before this turn
  // would be re-read as this turn's evidence — the #1145/#1163 defect one door along.
  const { clock, tracker } = trackerAt();
  tracker.noteAgentGone();
  clock.t += 600_000;
  tracker.noteTurnStarted(); // a brand-new turn the user just typed
  assert.equal(tracker.isDown(), false, "a turn start ends the outage, whoever opened it");
  assert.equal(tracker.outageMs(), 0);
  assert.equal(
    shouldNudgeAfterMidTaskReconnect({ outageMs: tracker.outageMs() }),
    false,
    "a settled wedge must not nudge a turn that started after it",
  );
});

test("#1168: an unreadable clock cannot manufacture a death", () => {
  // Same safe direction noteBridgeClosed takes: with no readable clock the outage is not
  // opened at all, so the nudge is withheld rather than invented.
  const broken = createBridgeOutageTracker({ now: () => NaN });
  broken.noteAgentGone();
  assert.equal(broken.isDown(), false);
  assert.equal(broken.outageMs(), 0);
  assert.equal(shouldNudgeAfterMidTaskReconnect({ outageMs: broken.outageMs() }), false);
});

test("#1168 WIRING: the death is recorded where the panel EARNS the conclusion", () => {
  // Replaces the NOTE this file carried while the gap was unfixed. The two attempts that
  // failed differed from this one only in WHERE they stamped, so placement is the fix —
  // and it is the one thing the behavioural tests above cannot see.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const CALL = "bridgeOutage.noteAgentGone();";

  // Exactly one site, for #1096's reason: a loose scan asserts nothing, and the old
  // negative scan this replaces would have PASSED against the design it named (it
  // searched the teardown bodies for a literal `bridgeOutage.`, while the design it
  // rejected put the stamp in a shared helper those bodies call). Counting the call
  // itself cannot be evaded that way — a wrapper still has to contain this line, and
  // the body check below then fails.
  assert.equal(
    src.split(CALL).length - 1,
    1,
    "a death must be concluded in exactly one place — teardowns and redials cannot",
  );

  const at = src.indexOf("function showExternalHintOnce()");
  assert.ok(at > 0, "showExternalHintOnce must exist");
  const rest = src.slice(at);
  const end = rest.indexOf("\n  function ", 1);
  const body = rest.slice(0, end > 0 ? end : 2000);
  assert.ok(body.includes(CALL), "the death is recorded where 'no agent is listening' latches");

  // …and AFTER both reasons the conclusion might not be earned yet: #1136's fallback
  // dial (a configured URL that outlived its process is not a dead agent) and the latch
  // itself. Recording above the fallback's early `return` is the same over-claim #1136
  // moved this latch to avoid, and is how attempt 2 went wrong one layer up.
  assert.ok(
    body.indexOf("bridgeFallbackPlan({") < body.indexOf(CALL),
    "the fallback must be tried before any death is concluded",
  );
  assert.ok(
    body.indexOf("externalHintShown = true;") < body.indexOf(CALL),
    "the death is concluded exactly when the hint becomes true, not before",
  );

  // And the conclusion must NOT be handed to the predicate as a second input. The first
  // draft did exactly that and was rejected: it let a conclusion the panel cannot verify
  // bypass the threshold, nudging a live agent whenever a stale socket looked like a
  // death. The elapsed interval stays the sole gate.
  assert.ok(
    src.includes(
      "if (!shouldNudgeAfterMidTaskReconnect({ outageMs: bridgeOutage.outageMs() })) return;",
    ),
    "the nudge must be decided on the measured outage alone, never on the raw conclusion",
  );
});

// ---- #654 re-advertise the tab after a ComfyUI restart --------------------
//
// The report: `panel_restart_comfyui` confirms the server cycle
// (`saw_down:true`, `confirmed_cycle:true`, `server_ready:true`) and the tab is
// never usable again — the reply's tab-reconnected and graph-tools-ready flags
// both stay false, and every graph call answers `Connected: none` until the
// browser tab is reloaded by hand.
//
// The panel re-registers its bridge route ONLY by sending a `hello`, and on this
// path nothing sent one: the pack is pure-frontend, so the orchestrator survives
// the restart, the bridge socket never closes, no socket `open` handler runs,
// and `connectAgent()` early-returns on an already-OPEN socket. The orchestrator
// waits for a strictly NEWER hello generation that can never arrive.

test("#654: bridge UP + a real restart-length outage → re-advertise the route", () => {
  assert.equal(
    shouldReadvertiseAfterComfyRestart({ bridgeConnected: true, outageMs: 26_000 }),
    true,
  );
});

test("#654: bridge DOWN → never, whatever the outage — the socket's own open-hello owns it", () => {
  // Firing here as well is two greetings and two `ready` acks for one outage,
  // which is #1138's false-nudge-into-a-live-session harm.
  assert.equal(
    shouldReadvertiseAfterComfyRestart({ bridgeConnected: false, outageMs: 26_000 }),
    false,
  );
});

test("#654: a benign WS blip is NOT a restart", () => {
  // ComfyUI fires `reconnected` for viewing an asset, checking an image, a tab
  // refocus. The elapsed interval is the only thing that separates those from a
  // restart, so a short one must not re-greet a working agent.
  assert.equal(shouldReadvertiseAfterComfyRestart({ bridgeConnected: true, outageMs: 800 }), false);
  assert.equal(
    shouldReadvertiseAfterComfyRestart({ bridgeConnected: true, outageMs: 5999 }),
    false,
  );
  assert.equal(shouldReadvertiseAfterComfyRestart({ bridgeConnected: true, outageMs: 6000 }), true);
});

test("#1785: a stale restart marker cannot authorize a positive short outage", () => {
  for (const outageMs of [800, 0, undefined, NaN, Infinity, "800"]) {
    assert.equal(
      shouldReadvertiseAfterComfyRestart({
        bridgeConnected: true,
        outageMs,
        restartConfirmed: true,
      }),
      false,
      `stale marker must not bypass the duration gate for outage ${String(outageMs)}`,
    );
  }
});

test("#654: an unmeasured outage is not evidence of a restart", () => {
  // Absent, zero, negative and unreadable all mean "no outage was measured" —
  // never "a long one". A missed re-advertise leaves the tab exactly as it is
  // today; an invented one re-greets a live agent, so this fails closed.
  for (const outageMs of [undefined, 0, -1, NaN, Infinity, "26000", null]) {
    assert.equal(
      shouldReadvertiseAfterComfyRestart({ bridgeConnected: true, outageMs }),
      false,
      `outageMs ${String(outageMs)} must not authorise a re-advertise`,
    );
  }
  assert.equal(
    shouldReadvertiseAfterComfyRestart({
      bridgeConnected: true,
      outageMs: 26_000,
      minOutageMs: NaN,
    }),
    false,
  );
});

test("#654: a hello that already landed during the outage suppresses the re-advertise", () => {
  // The bridge dropped and reconnected FIRST: its socket-open hello already
  // re-registered the tab, so this one would be the redundant second greeting.
  assert.equal(
    shouldReadvertiseAfterComfyRestart({
      bridgeConnected: true,
      outageMs: 26_000,
      helloLandedSinceOutage: true,
    }),
    false,
  );
});

test("#654: one-shot per outage — a repeated `reconnected` does not re-greet", () => {
  assert.equal(
    shouldReadvertiseAfterComfyRestart({
      bridgeConnected: true,
      outageMs: 26_000,
      alreadyReadvertised: true,
    }),
    false,
  );
});

test("#1790: a failed async rehello does not consume the outage watermark", async () => {
  const controller = createRestartReadvertiseController();
  let sends = 0;
  const send = () => (++sends === 1 ? false : true);
  const current = () => true;

  assert.equal(
    await controller.attempt({ outageSeq: 1, reconnectEpoch: 1, isCurrent: current, send }),
    false,
  );
  assert.equal(controller.isReadvertised(1), false);

  // A later production reconnect attempt is allowed to retry because the
  // first promise never proved that a hello reached the orchestrator.
  assert.equal(
    await controller.attempt({ outageSeq: 1, reconnectEpoch: 1, isCurrent: current, send }),
    true,
  );
  assert.equal(controller.isReadvertised(1), true);
  assert.equal(sends, 2);
});

test("#1790: duplicate reconnect events join an in-flight hello", async () => {
  const controller = createRestartReadvertiseController();
  let resolve;
  let sends = 0;
  const first = controller.attempt({
    outageSeq: 1,
    reconnectEpoch: 1,
    isCurrent: () => true,
    send: () => {
      sends += 1;
      return new Promise((r) => { resolve = r; });
    },
  });
  const duplicate = controller.attempt({
    outageSeq: 1,
    reconnectEpoch: 1,
    isCurrent: () => true,
    send: () => {
      sends += 1;
      return true;
    },
  });
  assert.strictEqual(duplicate, first);
  assert.equal(controller.isReadvertised(1), true, "in-flight is a duplicate guard, not landed proof");
  assert.equal(sends, 1);
  resolve(true);
  assert.equal(await duplicate, true);
  assert.equal(controller.isReadvertised(1), true);
});

test("#1790: a late hello from an older reconnect epoch cannot mint current proof", async () => {
  const controller = createRestartReadvertiseController();
  let epoch = 1;
  let resolve;
  const attempt = controller.attempt({
    outageSeq: 1,
    reconnectEpoch: 1,
    isCurrent: () => epoch === 1,
    send: () => new Promise((r) => { resolve = r; }),
  });

  epoch = 2;
  resolve(true);
  assert.equal(await attempt, true, "the transport did send, but its proof is stale");
  assert.equal(controller.isReadvertised(1), false);
});

test("#654 INVARIANT: the re-advertise and the #278 resume can never both fire", () => {
  // The whole reason this is a separate predicate is that #278's
  // `if (bridgeConnected) return false` must stay exactly as strict. Enumerate
  // the cross product rather than reasoning about it: a guard that is present,
  // correct in isolation and comparing the wrong pair is this repo's most
  // expensive recurring defect.
  for (const bridgeConnected of [true, false]) {
    for (const outageMs of [0, 800, 26_000]) {
      for (const rebootPending of [true, false]) {
        for (const hasResumableSession of [true, false]) {
          const resume = shouldResumeAfterComfyReconnect({
            bridgeConnected,
            rebootPending,
            hasResumableSession,
          });
          const readvertise = shouldReadvertiseAfterComfyRestart({ bridgeConnected, outageMs });
          assert.ok(
            !(resume && readvertise),
            `both fired for bridgeConnected=${bridgeConnected} outageMs=${outageMs}`,
          );
        }
      }
    }
  }
});

// ---- #654 the backend outage tracker --------------------------------------

test("#654 tracker: the FIRST down signal owns the outage — later ones do not reset it", () => {
  // The defect this exists to prevent is a SEQUENCE, so drive one. ComfyUI
  // announces a drop as `reconnecting` AND as a null `status` payload, and a
  // frontend emits several across a restart. Re-stamping on each measures the
  // gap between the last two instead of the restart — #1145 exactly.
  let clock = 1000;
  const t = createComfyBackendOutageTracker({ now: () => clock });
  t.noteDown(3);
  clock = 5000;
  t.noteDown(3); // a second `reconnecting`
  clock = 20_000;
  t.noteDown(3); // a null `status` payload
  clock = 27_000;
  t.noteUp();
  assert.equal(t.outageMs(), 26_000, "the outage is measured from the FIRST signal");
  assert.equal(t.seq(), 1, "three signals, one outage");
});

test("#654 tracker: a reconnect that ended no outage records nothing", () => {
  // It must not inherit the previous outage as if it were its own — the rule the
  // bridge tracker's `noteHandshake` already follows for a re-advertise on a
  // live socket.
  let clock = 1000;
  const t = createComfyBackendOutageTracker({ now: () => clock });
  t.noteDown(0);
  clock = 30_000;
  t.noteUp();
  assert.equal(t.outageMs(), 29_000);
  clock = 40_000;
  t.noteUp(); // a `reconnected` with no drop before it
  assert.equal(t.outageMs(), 0, "an unopened outage measures nothing, not the last one");
});

test("#654 tracker: a near-zero start is a REAL reading, not 'no outage'", () => {
  // performance.now()'s origin is page load, so a drop moments after load
  // genuinely stamps ~0. A falsy-0 sentinel would read that as "no outage open",
  // every later signal would re-stamp it, and the restart would measure one
  // backoff step (#1138's sentinel-sharing-a-value-with-real-data defect).
  let clock = 0;
  const t = createComfyBackendOutageTracker({ now: () => clock });
  t.noteDown(0);
  clock = 500;
  t.noteDown(0); // must NOT re-stamp
  clock = 26_000;
  t.noteUp();
  assert.equal(t.outageMs(), 26_000);
});

test("#654 tracker: reads LIVE while open, so listener order cannot change the answer", () => {
  // Two listeners on one `reconnected` event, registered at different times: the
  // module-scope one closes the outage, the panel's reads it. Both orders must
  // agree, or the fix works only when the listeners happen to be registered in
  // one particular sequence.
  let clock = 1000;
  const t = createComfyBackendOutageTracker({ now: () => clock });
  t.noteDown(0);
  clock = 27_000;
  const readBeforeClose = t.outageMs();
  t.noteUp();
  const readAfterClose = t.outageMs();
  assert.equal(readBeforeClose, 26_000);
  assert.equal(readAfterClose, 26_000);
});

test("#654 tracker: the hello baseline is captured when the outage OPENS", () => {
  let clock = 1000;
  const t = createComfyBackendOutageTracker({ now: () => clock });
  t.noteDown(7);
  clock = 27_000;
  t.noteUp();
  assert.equal(t.helloBaseline(), 7);
  // A hello that landed during the outage (the bridge dropped and re-helloed
  // first) is therefore visible to the caller as a count above the baseline.
  assert.equal(9 > t.helloBaseline(), true);
  assert.equal(7 > t.helloBaseline(), false);
});

test("#654 tracker: an unreadable clock opens no outage and authorises nothing", () => {
  const t = createComfyBackendOutageTracker({ now: () => NaN });
  t.noteDown(0);
  t.noteUp();
  assert.equal(t.outageMs(), 0);
  assert.equal(t.seq(), 0, "no outage was opened, so no seq was consumed");
});

test("#654 tracker: a backwards clock cannot produce a negative duration", () => {
  let clock = 30_000;
  const t = createComfyBackendOutageTracker({ now: () => clock });
  t.noteDown(0);
  clock = 1000;
  t.noteUp();
  assert.equal(t.outageMs(), 0);
});

test("#654 wiring: the panel measures, feeds and consults the outage — every site", () => {
  // The predicate and the tracker are covered by behaviour above. This covers
  // what a pure test cannot see: that production actually reaches them. A
  // tracker nothing feeds answers 0 forever and every test above still passes —
  // deleting a single write site silently restores "no restart was ever
  // observed", which IS the bug. Exact substrings on purpose: #1096's review
  // proved by mutation that loose token scans over this file assert nothing.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  for (const [site, snippet] of [
    [
      "the tracker measures on the MONOTONIC clock (its own default is Date.now())",
      "const comfyBackendOutage = createComfyBackendOutageTracker({ now: monotonicNow });",
    ],
    [
      "the `reconnecting` listener opens the outage, carrying the landed-hello baseline",
      "comfyBackendOutage.noteDown(landedHelloCount); // #654 — open the outage clock on the FIRST down signal.",
    ],
    [
      "the null-`status` down signal opens it too — some frontends announce the drop only that way",
      "        comfyBackendOutage.noteDown(landedHelloCount);",
    ],
    [
      "the `reconnected` listener closes it",
      "comfyBackendOutage.noteUp(); // #654 — close the outage clock and record its duration.",
    ],
    [
      "a LANDED hello advances the count the baseline is compared against",
      "          landedHelloCount++;",
    ],
    [
      "the panel consults the predicate on the reconnect path",
      "      shouldReadvertiseAfterComfyRestart({",
    ],
    [
      "the one-shot state is keyed by the tracker's outage identity",
      "        alreadyReadvertised: comfyRestartReadvertise.isReadvertised(comfyBackendOutage.seq()),",
    ],
  ]) {
    assert.ok(src.includes(snippet), site);
  }
  assert.doesNotMatch(
    src,
    /restartConfirmed\s*:/,
    "the persisted reboot marker must not authorize a route re-hello for an uncorrelated outage",
  );
  // …and the branch RE-ADVERTISES. Asserted POSITIONALLY, not by presence: this
  // file already contains three other `client?.rehello?.()` calls (#607, #310,
  // #508), so a presence check stays green with THIS one deleted — the exact
  // mutation this assertion was rewritten to catch, and the "wiring tests must
  // check PATHS" lesson. It must be `rehello`, never `connectAgent()`, which
  // early-returns on an already-OPEN socket and so can never produce a hello.
  const claim = src.indexOf("      void comfyRestartReadvertise.attempt({");
  assert.notEqual(claim, -1);
  const branchEnd = src.indexOf("    // After ComfyUI comes back (backend-only reboot", claim);
  assert.notEqual(branchEnd, -1, "the #654 branch sits above the #278 resume commentary");
  const branch = src.slice(claim, branchEnd);
  assert.ok(
    branch.includes("send: () => client?.rehello?.(),"),
    "the #654 branch must re-advertise the route, and it must do so with rehello",
  );
  assert.ok(
    branch.includes("reconnectEpoch === backendReconnectEpoch && outageSeq === comfyBackendOutage.seq()"),
    "a late hello may not become proof for a newer reconnect epoch",
  );
  assert.doesNotMatch(
    branch,
    /connectAgent\(/,
    "connectAgent() cannot hello on an open socket — using it here is a no-op that looks like a fix",
  );
  // The re-advertise must sit BEFORE the resume gate, because that gate RETURNS
  // — placed after it, the branch this fix exists for is never reached.
  const readvertise = src.indexOf("shouldReadvertiseAfterComfyRestart({");
  const resume = src.indexOf("!shouldResumeAfterComfyReconnect({");
  assert.ok(readvertise !== -1 && resume !== -1);
  assert.ok(
    readvertise < resume,
    "the re-advertise must run before the resume gate's early return",
  );
});

test("#654: #278's guard is NOT relaxed to make room for this", () => {
  // The recurring way this cluster gets worse is by widening an existing guard
  // instead of adding a narrower action beside it. `if (bridgeConnected) return
  // false` is what stops a benign blip bouncing a live agent session.
  const lib = readFileSync(new URL("../../web/js/lib/session-rebind.js", import.meta.url), "utf8");
  const resumeStart = lib.indexOf("export function shouldResumeAfterComfyReconnect(");
  assert.notEqual(resumeStart, -1);
  // Bounded by the NEXT export, not by the first "\n}" — the signature's own
  // destructured-parameter brace closes before the body begins, so a slice that
  // stopped there would read an empty body and assert on nothing.
  const nextExport = lib.indexOf("\nexport function", resumeStart + 1);
  assert.notEqual(nextExport, -1);
  const body = lib.slice(resumeStart, nextExport);
  assert.ok(body.includes("if (bridgeConnected) return false;"), "#278's guard stands unchanged");
  // And `shouldRehelloAfterCommand` stays narrow — widening it to cover the
  // restart was the tempting wrong fix: at `comfy_reboot` reply time ComfyUI is
  // on its way DOWN, so a hello there reaches nothing.
  assert.equal(shouldRehelloAfterCommand("comfy_reboot", { ok: true }), false);
});
