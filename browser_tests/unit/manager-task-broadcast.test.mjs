// artokun/comfyui-mcp#1606 — `panel_install_node` on a legacy ComfyUI-Manager 3.x
// returned `queued: true, pending: true` with no failure, `panel_node_queue_status`
// then reported an EMPTY IDLE QUEUE, and the pack was absent. Nothing anywhere
// said why, so the reporter fell back to a manual source install.
//
// #1539 gave install the Manager's own verdict by reading
// /v2/manager/queue/history?ui_id=. Released 3.x registers no such route, so
// there it reads nothing — and the record is not merely unexposed, it is
// DELETED. From ComfyUI-Manager 3.41's glob/manager_server.py, `task_worker`:
//
//     PromptServer.instance.send_sync("cm-queue-status",
//         {'status': 'done', 'nodepack_result': nodepack_result, …})
//     nodepack_result = {}
//     task_queue = queue.Queue()
//
// `queue/status` derives done_count from `len(nodepack_result)`, so the line
// AFTER the broadcast is what makes total/done/in_progress read 0 — the
// reporter's empty idle queue is produced by the task finishing. The broadcast
// is therefore the only statement of the outcome that ever exists, and a panel
// living in the ComfyUI page is already a client of it (`send_sync` with no sid
// goes to every client; ComfyUI-Manager's own UI reads it the same way).
//
// These tests pin: the frame's meaning, the bounded log that keeps it, that the
// REAL verifier reaches it and turns it into a failure verdict, that it is
// correlated by ui_id so a neighbour's failure is never borrowed, and that the
// queue poll reports it instead of an idle-looking silence.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as ManagerInstall from "../../web/js/lib/manager-install.js";
const {
  classifyInstallOutcome,
  collectInProgressTasks,
  collectRecentTaskFailures,
  createManagerQueueWatch,
  createManagerTaskResultLog,
  dialectServesTaskHistory,
  looksLikeTaskHistory,
  parseTaskHistoryItem,
  queueDrained,
  queueEventFailureReason,
  queueEventTaskResults,
  silentQueueStallNote,
  taskFailureReason,
  taskHistoryBlindNote,
  unlistedGitUrlAdvice,
} = ManagerInstall;

const UI_ID = "u-1606";
const TARGET = "comfyui-reactor"; // the reporter's pack, a plain registry id
// What 3.41's `do_install` returns when `resolve_node_spec` comes back None —
// verbatim from its source, and the class of message that was being thrown away.
const REASON = "Cannot resolve install target: 'comfyui-reactor@latest'";

/** The drain frame 3.41 broadcasts, with our task's outcome in it. */
const doneFrame = (results) => ({
  status: "done",
  nodepack_result: results,
  model_result: {},
  total_count: Object.keys(results).length,
  done_count: Object.keys(results).length,
});

/** The per-task frame it emits BEFORE that one. Names the task; says nothing
 *  about how it went. */
const IN_PROGRESS_FRAME = {
  status: "in_progress",
  target: UI_ID,
  ui_target: "nodepack_manager",
  total_count: 1,
  done_count: 0,
};

/** What /manager/queue/status answers once the worker has cleared its map —
 *  the reporter's "empty idle queue", which reads as positively DRAINED. */
const EMPTIED = { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false };
/** The pack is NOT in the installed list — the install never happened. */
const INSTALLED_LIST = { "some-other-pack": { ver: "1.0", cnr_id: "some-other-pack" } };

// ---------------------------------------------------------------------------
// The frame's meaning
// ---------------------------------------------------------------------------

test("#1606: the drain frame's per-task result is extracted, keyed by ui_id", () => {
  const results = queueEventTaskResults(doneFrame({ [UI_ID]: REASON, other: "success" }));
  assert.deepEqual(results, [
    { ui_id: UI_ID, result: REASON },
    { ui_id: "other", result: "success" },
  ]);
});

test("#1606: an in_progress frame carries NO outcome", () => {
  // It names the task that just finished but never says how it went. Reading it
  // as a result would record every task with an unknown outcome — and unknown is
  // indistinguishable from a failure string here.
  assert.deepEqual(queueEventTaskResults(IN_PROGRESS_FRAME), []);
});

test("#1606: an unrecognised payload adds nothing", () => {
  for (const junk of [null, undefined, "done", 7, [], {}, { status: "done" }, { status: "done", nodepack_result: [] }]) {
    assert.deepEqual(queueEventTaskResults(junk), [], `should ignore ${JSON.stringify(junk)}`);
  }
});

test("#1606: 'update-main' stores the whole record — its .msg is the result", () => {
  // 3.41 stores `msg['msg']` for kind 'update' but the bare {msg,url,title} dict
  // for 'update-main'.
  const results = queueEventTaskResults(
    doneFrame({ [UI_ID]: { msg: "An error occurred while updating 'X'.", url: "u", title: "X" } }),
  );
  assert.deepEqual(results, [{ ui_id: UI_ID, result: "An error occurred while updating 'X'." }]);
});

test("#1606: the success vocabulary is not a failure; anything else IS the reason", () => {
  for (const ok of ["success", "skip", "skipped", "SUCCESS", " success ", "success-stable-v0.3.40"]) {
    assert.equal(queueEventFailureReason(ok), null, `${ok} is a success`);
  }
  assert.equal(queueEventFailureReason(REASON), REASON);
  // Never manufactures a verdict from something it cannot read.
  for (const unknown of [null, undefined, "", "   ", 42, {}]) {
    assert.equal(queueEventFailureReason(unknown), null);
  }
});

// ---------------------------------------------------------------------------
// The log that keeps it
// ---------------------------------------------------------------------------

test("#1606: a captured failure is readable by the ui_id that submitted it", () => {
  const log = createManagerTaskResultLog();
  log.note(UI_ID, { target: TARGET, kind: "install" });
  assert.equal(log.record(doneFrame({ [UI_ID]: REASON })), 1);
  assert.equal(log.failureFor(UI_ID), REASON);
  assert.deepEqual(log.recentFailures(), [
    { ui_id: UI_ID, kind: "install", id: TARGET, result: REASON },
  ]);
});

test("#1606: a neighbouring task's failure is never attributed to ours", () => {
  const log = createManagerTaskResultLog();
  log.note(UI_ID, { target: TARGET, kind: "install" });
  log.record(doneFrame({ "someone-elses-task": REASON, [UI_ID]: "success" }));
  assert.equal(log.failureFor(UI_ID), null, "our task succeeded");
  assert.equal(log.failureFor("someone-elses-task"), REASON, "theirs is still reported");
});

test("#1606: a later SUCCESS for the same pack retires the earlier failure", () => {
  // Otherwise a reinstall that worked leaves the defeat sitting in the log and
  // the next poll reports a failure that has already been undone.
  const log = createManagerTaskResultLog();
  log.note("first", { target: TARGET, kind: "install" });
  log.record(doneFrame({ first: REASON }));
  assert.equal(log.recentFailures().length, 1);
  log.note("second", { target: TARGET, kind: "install" });
  log.record(doneFrame({ second: "success" }));
  assert.deepEqual(log.recentFailures(), [], "the pack installed — nothing to report");
  // A DIFFERENT pack succeeding must not clear it.
  const other = createManagerTaskResultLog();
  other.note("a", { target: TARGET });
  other.record(doneFrame({ a: REASON }));
  other.note("b", { target: "another-pack" });
  other.record(doneFrame({ b: "success" }));
  assert.equal(other.recentFailures().length, 1);
});

test("#1606: a stale capture ages out of the poll surface", () => {
  let now = 1_000_000;
  const log = createManagerTaskResultLog({ now: () => now });
  log.note(UI_ID, { target: TARGET });
  log.record(doneFrame({ [UI_ID]: REASON }));
  assert.equal(log.recentFailures({ maxAgeMs: 60_000 }).length, 1);
  now += 61_000;
  assert.deepEqual(log.recentFailures({ maxAgeMs: 60_000 }), [], "too old to be what a poll is asking about");
  // The ui_id-correlated read is NOT age-bounded: an install verifying its own
  // task asks about a result it is waiting for right now.
  assert.equal(log.failureFor(UI_ID), REASON);
});

test("#1606: the log is bounded — a tab open for days cannot grow it without limit", () => {
  const log = createManagerTaskResultLog({ limit: 3 });
  for (let i = 0; i < 10; i += 1) log.record(doneFrame({ [`u-${i}`]: REASON }));
  assert.equal(log.size(), 3);
  assert.equal(log.failureFor("u-9"), REASON, "the newest is kept");
  assert.equal(log.failureFor("u-0"), null, "the oldest was evicted");
});

// ---------------------------------------------------------------------------
// Real-source harness: the ACTUAL waitForQueueDrain + verifyInstalled, extracted
// from comfyui-mcp-panel.js. Driving the real source is the point — a
// helper-only test passes just as happily with the call site never passing
// `capturedFailure` at all.
// ---------------------------------------------------------------------------

function readPanelSource() {
  return readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  );
}

function pick(src, re, name) {
  const m = src.match(re);
  assert.ok(m, `could not locate ${name} in panel source`);
  return m[0];
}

function buildVerifyInstalled({ routes, calls = [], managerTaskResults }) {
  const src = readPanelSource();
  const get = async (route) => {
    calls.push(route);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (route.startsWith(prefix)) {
        const out = typeof handler === "function" ? handler(route) : handler;
        if (out instanceof Error) throw out;
        return out;
      }
    }
    throw new Error(`unstubbed route: ${route}`);
  };
  const deps = {
    managerGet: get,
    managerV2: get,
    managerCall: get,
    queueDrained,
    taskFailureReason,
    parseTaskHistoryItem,
    classifyInstallOutcome,
    managerTaskResults,
    MANAGER_FETCH_TIMEOUT_MS: 15000,
    INSTALL_VERIFY_BUDGET_MS: 4000,
    AbortSignal,
    setTimeout,
  };
  const factory = new Function(
    ...Object.keys(deps),
    `${pick(src, /function boundedDelay\(ms, deadline\) \{[\s\S]*?\n\}/, "boundedDelay")}
${pick(src, /async function waitForQueueDrain\(\{[\s\S]*?\n\}/, "waitForQueueDrain")}
${pick(src, /async function verifyInstalled\(target, dialect, \{[\s\S]*?\n\}/, "verifyInstalled")}
return { verifyInstalled, waitForQueueDrain };`,
  );
  return factory(...Object.values(deps));
}

/** The legacy Manager as the reporter met it: no history route at all, a queue
 *  that has emptied itself, and the pack absent. */
const LEGACY_ROUTES = {
  "manager/queue/history": new Error("Manager manager/queue/history: HTTP 404"),
  "manager/queue/status": EMPTIED,
  "customnode/installed": INSTALLED_LIST,
};

test("#1606: the reported case — a legacy install now reports the Manager's OWN reason", async () => {
  const log = createManagerTaskResultLog();
  log.note(UI_ID, { target: TARGET, kind: "install" });
  // The broadcast the panel heard while the install was queued.
  log.record(doneFrame({ [UI_ID]: REASON }));

  const calls = [];
  const { verifyInstalled } = buildVerifyInstalled({
    calls,
    routes: LEGACY_ROUTES,
    managerTaskResults: log,
  });
  const outcome = await verifyInstalled(TARGET, "legacy", { budgetMs: 4000, ui_id: UI_ID });

  // BEFORE: "unverified" — which nodes_install returns as queued:true,
  // installed:false, verified:false, pending:true. Exactly the reporter's reply.
  assert.equal(outcome.state, "failed");
  assert.ok(outcome.message.includes(REASON), "the caller gets the Manager's real reason");
  assert.match(outcome.message, /install FAILED/);
  assert.doesNotMatch(outcome.message, /could NOT be confirmed/, "a verdict, not a hedge");
  assert.ok(
    !calls.some((r) => r.startsWith("customnode/installed")),
    "a settled verdict should not spend budget on evidence that cannot change it",
  );
});

test("#1606: WITHOUT the capture the same install is only 'unverified' (the bug)", async () => {
  // The mutation check for the test above: an empty log is the pre-fix world.
  const { verifyInstalled } = buildVerifyInstalled({
    routes: LEGACY_ROUTES,
    managerTaskResults: createManagerTaskResultLog(),
  });
  const outcome = await verifyInstalled(TARGET, "legacy", { budgetMs: 4000, ui_id: UI_ID });
  assert.equal(outcome.state, "unverified");
  assert.doesNotMatch(outcome.message, /install FAILED/);
});

test("#1606: a capture for ANOTHER task never fails this install", async () => {
  const log = createManagerTaskResultLog();
  log.note(UI_ID, { target: TARGET, kind: "install" });
  log.record(doneFrame({ "a-different-task": REASON }));
  const { verifyInstalled } = buildVerifyInstalled({
    routes: LEGACY_ROUTES,
    managerTaskResults: log,
  });
  const outcome = await verifyInstalled(TARGET, "legacy", { budgetMs: 4000, ui_id: UI_ID });
  assert.equal(outcome.state, "unverified", "our task has no verdict — do not borrow one");
});

test("#1606: a captured SUCCESS is not turned into a failure", async () => {
  const log = createManagerTaskResultLog();
  log.note(UI_ID, { target: TARGET, kind: "install" });
  log.record(doneFrame({ [UI_ID]: "success" }));
  const { verifyInstalled } = buildVerifyInstalled({
    routes: {
      ...LEGACY_ROUTES,
      "customnode/installed": { [TARGET]: { ver: "1.0", cnr_id: TARGET } },
    },
    managerTaskResults: log,
  });
  const outcome = await verifyInstalled(TARGET, "legacy", { budgetMs: 4000, ui_id: UI_ID });
  assert.equal(outcome.state, "installed");
});

test("#1606: a captured failure ends the wait even if the queue never drains", async () => {
  const log = createManagerTaskResultLog();
  log.note(UI_ID, { target: TARGET, kind: "install" });
  log.record(doneFrame({ [UI_ID]: REASON }));
  const { verifyInstalled } = buildVerifyInstalled({
    routes: { ...LEGACY_ROUTES, "manager/queue/status": { total_count: 3, done_count: 1, is_processing: true } },
    managerTaskResults: log,
  });
  const started = Date.now();
  const outcome = await verifyInstalled(TARGET, "legacy", { budgetMs: 8000, ui_id: UI_ID });
  assert.equal(outcome.state, "failed");
  assert.ok(Date.now() - started < 6000, "must return on the record, not burn the budget");
});

test("#1606: the v4 history read still works, and is not disturbed by an empty log", async () => {
  // The #1539 path must keep its behaviour on a build that DOES serve history.
  const V4_REASON = "Node 'x@nightly' not found in [ManagerChannel.dev, ManagerDatabaseSource.cache]";
  const { verifyInstalled } = buildVerifyInstalled({
    routes: {
      "manager/queue/history": {
        history: { ui_id: UI_ID, kind: "install", status: { status_str: "error", completed: true, messages: [V4_REASON] } },
      },
      "manager/queue/status": EMPTIED,
      "customnode/installed": INSTALLED_LIST,
    },
    managerTaskResults: createManagerTaskResultLog(),
  });
  const outcome = await verifyInstalled(TARGET, "v2", { budgetMs: 4000, ui_id: UI_ID, renameProne: true });
  assert.equal(outcome.state, "failed");
  assert.ok(outcome.message.includes(V4_REASON));
});

// ---------------------------------------------------------------------------
// The subscription — the one line that makes any of the above reachable
// ---------------------------------------------------------------------------

function buildSubscribe(log) {
  const src = readPanelSource();
  const factory = new Function(
    "managerTaskResults",
    "api",
    `${pick(src, /function subscribeManagerTaskResults\(target = api, log = managerTaskResults\) \{[\s\S]*?\n\}/, "subscribeManagerTaskResults")}
return subscribeManagerTaskResults;`,
  );
  return factory(log, null);
}

test("#1606: the subscription puts a real broadcast into the log", () => {
  const log = createManagerTaskResultLog();
  const subscribe = buildSubscribe(log);
  const listeners = new Map();
  const fakeApi = {
    addEventListener: (type, cb) => listeners.set(type, cb),
    emit: (type, detail) => listeners.get(type)?.({ detail }),
  };

  assert.equal(subscribe(fakeApi, log), true);
  assert.ok(listeners.has("cm-queue-status"), "ComfyUI only dispatches a type something REGISTERED for");

  log.note(UI_ID, { target: TARGET, kind: "install" });
  fakeApi.emit("cm-queue-status", doneFrame({ [UI_ID]: REASON }));
  assert.equal(log.failureFor(UI_ID), REASON);
  // A frame with nothing readable in it must not throw out of the listener.
  assert.doesNotThrow(() => fakeApi.emit("cm-queue-status", undefined));
});

test("#1606: no api (panel loaded outside a live ComfyUI) is a no-op, not a crash", () => {
  const log = createManagerTaskResultLog();
  const subscribe = buildSubscribe(log);
  assert.equal(subscribe(null, log), false);
  assert.equal(subscribe({}, log), false);
});

test("#1606: setupListeners actually SUBSCRIBES, at panel load", () => {
  // The capture is one call in one function; a helper-level test cannot see it
  // missing. Assert on the source, inside setupListeners — not merely present
  // in the file — and at load rather than per-install, because a task that
  // fails fast drains before an install-time listener could exist.
  const src = readPanelSource();
  const setup = pick(src, /function setupListeners\(\) \{[\s\S]*?\r?\n\}/, "setupListeners");
  assert.match(setup, /subscribeManagerTaskResults\(\)/);
});

test("#1606: the install path correlates its ui_id and passes the captured read", () => {
  const src = readPanelSource();
  const install = pick(src, /  async nodes_install\(args\) \{[\s\S]*?\r?\n  \},/, "nodes_install");
  assert.match(install, /managerTaskResults\.note\(ui_id, \{ target/);
  const verify = pick(src, /async function verifyInstalled\(target, dialect, \{[\s\S]*?\n\}/, "verifyInstalled");
  assert.match(verify, /capturedFailure: ui_id \? \(\) => managerTaskResults\.failureFor\(ui_id\) : undefined/);
});

// ---------------------------------------------------------------------------
// The queue poll — where the reporter looked and found nothing
// ---------------------------------------------------------------------------

function buildQueueStatus({ dialect, routes, managerTaskResults }) {
  const src = readPanelSource();
  const get = async (route) => {
    for (const [prefix, handler] of Object.entries(routes)) {
      if (route.startsWith(prefix)) {
        const out = typeof handler === "function" ? handler(route) : handler;
        if (out instanceof Error) throw out;
        return out;
      }
    }
    throw new Error(`unstubbed route: ${route}`);
  };
  const deps = {
    detectManagerDialect: async () => dialect,
    managerGet: get,
    collectInProgressTasks,
    collectRecentTaskFailures,
    dialectServesTaskHistory,
    looksLikeTaskHistory,
    taskHistoryBlindNote,
    unlistedGitUrlAdvice,
    silentQueueStallNote,
    managerTaskResults,
    managerQueueWatch: createManagerQueueWatch(),
    CAPTURED_FAILURE_TTL_MS: 30 * 60 * 1000,
    MANAGER_FETCH_TIMEOUT_MS: 15000,
    AbortSignal,
  };
  const factory = new Function(
    ...Object.keys(deps),
    `const tools = {
${pick(src, /  async nodes_queue_status\(\) \{[\s\S]*?\n  \},/, "nodes_queue_status")}
};
return () => tools.nodes_queue_status();`,
  );
  return factory(...Object.values(deps));
}

test("#1606: the poll the reporter made now reports the failure it could not see", async () => {
  const log = createManagerTaskResultLog();
  log.note(UI_ID, { target: TARGET, kind: "install" });
  log.record(doneFrame({ [UI_ID]: REASON }));
  const queueStatus = buildQueueStatus({
    dialect: "legacy",
    routes: LEGACY_ROUTES,
    managerTaskResults: log,
  });

  const out = await queueStatus();
  assert.deepEqual(out.status, EMPTIED, "the queue really is idle and empty");
  assert.deepEqual(out.recent_failures, [
    { ui_id: UI_ID, kind: "install", id: TARGET, result: REASON },
  ]);
  assert.match(out.note, /FAILED/);
  assert.equal(out.failure_reporting, "partial", "real, but this build cannot promise the list is complete");
});

test("#1606: an idle legacy queue with nothing captured says so, instead of looking clean", async () => {
  const queueStatus = buildQueueStatus({
    dialect: "legacy",
    routes: LEGACY_ROUTES,
    managerTaskResults: createManagerTaskResultLog(),
  });
  const out = await queueStatus();
  assert.equal(out.failure_reporting, "unavailable");
  assert.match(out.note, /A FAILED TASK MAY NOT BE VISIBLE HERE/);
  assert.match(out.note, /panel_list_nodes/);
});

test("#1606: a v4 that served its history is reported as COMPLETE, with no hedge", async () => {
  const queueStatus = buildQueueStatus({
    dialect: "v2",
    routes: { "manager/queue/status": EMPTIED, "manager/queue/history": { history: {} } },
    managerTaskResults: createManagerTaskResultLog(),
  });
  const out = await queueStatus();
  assert.equal(out.failure_reporting, "complete");
  assert.equal(out.note, undefined, "nothing to warn about — the record was read and it was empty");
});

test("#1606: a v4 whose history read FAILED does not read as a clean queue", async () => {
  const queueStatus = buildQueueStatus({
    dialect: "v2",
    routes: {
      "manager/queue/status": EMPTIED,
      "manager/queue/history": new Error("Manager manager/queue/history: HTTP 500"),
    },
    managerTaskResults: createManagerTaskResultLog(),
  });
  const out = await queueStatus();
  assert.equal(out.failure_reporting, "unavailable");
  assert.match(out.note, /could not be read just now/);
});

test("#1606: ComfyUI's SPA index answering an absent route is not a readable history", () => {
  // An UNREGISTERED GET can answer 200 with HTML, and an empty body parses to
  // null — both would otherwise traverse to zero failures and be reported as
  // "nothing failed".
  assert.equal(looksLikeTaskHistory("<!DOCTYPE html><html>…"), false);
  assert.equal(looksLikeTaskHistory(null), false);
  assert.equal(looksLikeTaskHistory({}), false, "a bare {} says nothing about any queue");
  assert.equal(looksLikeTaskHistory({ history: {} }), true, "an empty envelope IS an answer");
  assert.equal(looksLikeTaskHistory([]), true);
  assert.equal(looksLikeTaskHistory({ history: { a: { ui_id: "a", kind: "install" } } }), true);
  assert.equal(
    looksLikeTaskHistory({ history: { ui_id: "a", kind: "install", status: { status_str: "error" } } }),
    true,
    "the single ui_id-queried record",
  );
});

test("#1606: a v4 failure served by history is not double-listed by the capture", async () => {
  const log = createManagerTaskResultLog();
  log.note(UI_ID, { target: TARGET, kind: "install" });
  log.record(doneFrame({ [UI_ID]: REASON }));
  const queueStatus = buildQueueStatus({
    dialect: "v2",
    routes: {
      "manager/queue/status": EMPTIED,
      "manager/queue/history": {
        history: {
          [UI_ID]: {
            ui_id: UI_ID,
            kind: "install",
            status: { status_str: "error", completed: true, messages: [REASON] },
            params: { id: TARGET },
          },
        },
      },
    },
    managerTaskResults: log,
  });
  const out = await queueStatus();
  assert.equal(out.recent_failures.length, 1, "one task, one entry");
  assert.equal(out.failure_reporting, "complete");
});

test("#1606: the blind note never asserts that anything failed", () => {
  for (const dialect of ["legacy", "v2-batch", "v2", undefined]) {
    const note = taskHistoryBlindNote(dialect);
    assert.match(note, /MAY NOT BE VISIBLE/);
    assert.doesNotMatch(note, /\bdid fail\b|\bhas failed\b/);
  }
  assert.match(taskHistoryBlindNote("legacy"), /deletes each task's result/);
  assert.match(taskHistoryBlindNote("v2"), /transient error/);
  // An unknown dialect must not borrow 3.x's explanation — we did not identify
  // the build, so we cannot state how it behaves.
  assert.match(taskHistoryBlindNote(undefined), /could not determine which ComfyUI-Manager/);
  assert.doesNotMatch(taskHistoryBlindNote(undefined), /deletes each task's result/);
  assert.equal(dialectServesTaskHistory("legacy"), false);
  assert.equal(dialectServesTaskHistory("v2-batch"), false);
  assert.equal(dialectServesTaskHistory("v2"), true);
});
