// #1480 — `panel_install_node` queued comfyui_controlnet_aux, then
// `panel_node_queue_status` kept returning Manager's
// `{total_count:1, done_count:12, in_progress_count:1, is_processing:true}`
// for over two minutes with no completion, no failure, and no install log.
// The panel was forwarding that payload as-is (correct) and never timing a
// silent in_progress (the reporting gap): a poll that repeats the same counts
// forever reads as "still working".
//
// These tests pin: the fingerprint of a processing status, the watch that
// times an unchanged fingerprint, the stall note that does not claim failure,
// and that the REAL `nodes_queue_status` — extracted from the panel — names
// the stall on the reporter's payload while leaving Manager's counts attached.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as ManagerInstall from "../../web/js/lib/manager-install.js";
const {
  QUEUE_SILENT_STALL_MS,
  collectInProgressTasks,
  collectRecentTaskFailures,
  createManagerQueueWatch,
  createManagerTaskResultLog,
  dialectServesTaskHistory,
  looksLikeTaskHistory,
  queueIsProcessing,
  queueProgressFingerprint,
  silentQueueStallNote,
  taskHistoryBlindNote,
  unlistedGitUrlAdvice,
} = ManagerInstall;

/** The exact status the reporter polled, including the odd done_count > total. */
const REPORTER_STATUS = {
  total_count: 1,
  done_count: 12,
  in_progress_count: 1,
  pending_count: 0,
  is_processing: true,
};
const IDLE = { total_count: 0, done_count: 0, in_progress_count: 0, is_processing: false };
const TARGET = "comfyui_controlnet_aux";
const UI_ID = "u-1480";

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

function buildQueueStatus({ dialect, routes, managerTaskResults, managerQueueWatch, now }) {
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
    managerQueueWatch:
      managerQueueWatch ??
      createManagerQueueWatch({ now: now ?? (() => Date.now()) }),
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

// ---------------------------------------------------------------------------
// The fingerprint of a processing status
// ---------------------------------------------------------------------------

test("#1480: the reporter's payload is processing, an idle queue is not", () => {
  assert.equal(queueIsProcessing(REPORTER_STATUS), true);
  assert.equal(queueIsProcessing(IDLE), false);
  assert.equal(queueIsProcessing(null), false);
  assert.equal(queueIsProcessing({}), false);
});

test("#1480: unchanged counts share a fingerprint; a moved count does not", () => {
  const a = queueProgressFingerprint(REPORTER_STATUS);
  const b = queueProgressFingerprint({ ...REPORTER_STATUS });
  assert.equal(typeof a, "string");
  assert.equal(a, b);
  assert.notEqual(
    a,
    queueProgressFingerprint({ ...REPORTER_STATUS, done_count: 13 }),
    "a done_count bump is progress, not a stall",
  );
  assert.equal(queueProgressFingerprint(IDLE), null);
});

test("#1480: the same in_progress repeating past the stall window is a stall", () => {
  let now = 1_000_000;
  const watch = createManagerQueueWatch({ now: () => now, stallMs: QUEUE_SILENT_STALL_MS });
  const first = watch.observe(REPORTER_STATUS);
  assert.equal(first.processing, true);
  assert.equal(first.stalled, false);
  assert.equal(first.silent_ms, 0);

  now += QUEUE_SILENT_STALL_MS + 5_000;
  const later = watch.observe(REPORTER_STATUS);
  assert.equal(later.processing, true);
  assert.equal(later.stalled, true);
  assert.equal(later.silent_ms, QUEUE_SILENT_STALL_MS + 5_000);
  assert.equal(later.fingerprint, first.fingerprint);
});

test("#1480: a count change resets the silent clock", () => {
  let now = 1_000_000;
  const watch = createManagerQueueWatch({ now: () => now, stallMs: QUEUE_SILENT_STALL_MS });
  watch.observe(REPORTER_STATUS);
  now += QUEUE_SILENT_STALL_MS - 1_000;
  watch.observe({ ...REPORTER_STATUS, done_count: 13 });
  now += 2_000;
  const after = watch.observe({ ...REPORTER_STATUS, done_count: 13 });
  assert.equal(after.stalled, false, "progress within the window is not a stall");
  assert.equal(after.silent_ms, 2_000);
});

test("#1480: a drained queue clears the watch", () => {
  let now = 1_000_000;
  const watch = createManagerQueueWatch({ now: () => now, stallMs: QUEUE_SILENT_STALL_MS });
  watch.observe(REPORTER_STATUS);
  now += QUEUE_SILENT_STALL_MS + 1;
  assert.equal(watch.observe(IDLE).stalled, false);
  assert.equal(watch.observe(IDLE).processing, false);
});

test("#1480: the stall note does not claim the install failed", () => {
  const note = silentQueueStallNote({ silent_ms: QUEUE_SILENT_STALL_MS });
  assert.match(note, /SAME in_progress/);
  assert.match(note, /panel_list_nodes/);
  assert.doesNotMatch(note, /install FAILED/i);
  assert.doesNotMatch(note, /\bfailed\b/i);
});

test("#1480: history in_progress items are collected by id, not as failures", () => {
  const history = {
    history: {
      [UI_ID]: {
        ui_id: UI_ID,
        kind: "install",
        params: { id: TARGET },
        status: { status_str: "in_progress", completed: false, messages: [] },
      },
      other: {
        ui_id: "other",
        kind: "update",
        params: { id: "comfyui-mcp-panel" },
        status: { status_str: "error", completed: true, messages: ["stale"] },
      },
    },
  };
  assert.deepEqual(collectInProgressTasks(history), [
    { ui_id: UI_ID, kind: "install", id: TARGET },
  ]);
  assert.equal(collectRecentTaskFailures(history).length, 1);
});

// ---------------------------------------------------------------------------
// Real-source harness: the poll the reporter made
// ---------------------------------------------------------------------------

test("#1480: the poll the reporter made now names the silent stall", async () => {
  let now = 1_000_000;
  const watch = createManagerQueueWatch({ now: () => now, stallMs: QUEUE_SILENT_STALL_MS });
  const queueStatus = buildQueueStatus({
    dialect: "v2",
    routes: {
      "manager/queue/status": REPORTER_STATUS,
      "manager/queue/history": {
        history: {
          [UI_ID]: {
            ui_id: UI_ID,
            kind: "install",
            params: { id: TARGET },
            status: { status_str: "in_progress", completed: false, messages: [] },
          },
        },
      },
    },
    managerTaskResults: createManagerTaskResultLog(),
    managerQueueWatch: watch,
  });

  const first = await queueStatus();
  assert.deepEqual(first.status, REPORTER_STATUS, "Manager's counts stay attached");
  assert.equal(first.queue_liveness.stalled, false);
  assert.deepEqual(first.in_progress, [{ ui_id: UI_ID, kind: "install", id: TARGET }]);
  assert.equal(first.failure_reporting, "complete");
  assert.equal(first.note, undefined, "a fresh in_progress is not a stall yet");

  now += QUEUE_SILENT_STALL_MS + 5_000;
  const later = await queueStatus();
  assert.deepEqual(later.status, REPORTER_STATUS, "still Manager's payload, not a rewritten failure");
  assert.equal(later.queue_liveness.stalled, true);
  assert.equal(later.queue_liveness.silent_ms, QUEUE_SILENT_STALL_MS + 5_000);
  assert.match(later.note, /SAME in_progress/);
  assert.match(later.note, /panel_list_nodes/);
  assert.doesNotMatch(later.note, /\bfailed\b/i);
  assert.deepEqual(later.in_progress, [{ ui_id: UI_ID, kind: "install", id: TARGET }]);
});

test("#1480: a first poll of a busy queue is not a stall", async () => {
  const queueStatus = buildQueueStatus({
    dialect: "v2",
    routes: {
      "manager/queue/status": REPORTER_STATUS,
      "manager/queue/history": { history: {} },
    },
    managerTaskResults: createManagerTaskResultLog(),
  });
  const out = await queueStatus();
  assert.equal(out.queue_liveness.stalled, false);
  assert.equal(out.queue_liveness.silent_ms, 0);
  assert.equal(out.note, undefined);
});

test("#1480: an idle queue still has no stall fields", async () => {
  const queueStatus = buildQueueStatus({
    dialect: "v2",
    routes: {
      "manager/queue/status": IDLE,
      "manager/queue/history": { history: {} },
    },
    managerTaskResults: createManagerTaskResultLog(),
  });
  const out = await queueStatus();
  assert.equal(out.queue_liveness, undefined);
  assert.equal(out.in_progress, undefined);
  assert.equal(out.note, undefined);
  assert.equal(out.failure_reporting, "complete");
});

test("#1480: nodes_queue_status observes the watch on the real path", () => {
  const src = readPanelSource();
  const method = pick(src, /  async nodes_queue_status\(\) \{[\s\S]*?\n  \},/, "nodes_queue_status");
  assert.match(method, /managerQueueWatch\.observe\(status\)/);
  assert.match(method, /silentQueueStallNote/);
  assert.match(method, /collectInProgressTasks/);
});
