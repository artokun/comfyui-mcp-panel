// Unit tests for #364: panel_update_node must report a REAL failure when the
// ComfyUI-Manager update task actually failed, instead of a blind queued:true.
// The aggregate /v2/manager/queue/status endpoint marks a CRASHED do_update
// "done" (it still counts toward done_count), so the authoritative verdict lives
// in the per-task history (/v2/manager/queue/history). These tests exercise the
// pure interpretation helpers (web/js/lib/manager-install.js) against the exact
// wire shapes the live Manager v4 emits (data_models: OperationResult =
// success|failed|skipped|error|skip; TaskExecutionStatus = {status_str, completed,
// messages}; the worker records status_str="error" + messages=[exc] on a crash).
import test from "node:test";
import assert from "node:assert/strict";

import {
  taskFailureReason,
  taskSucceeded,
  parseTaskHistoryItem,
  collectRecentTaskFailures,
  classifyUpdateOutcome,
} from "../../web/js/lib/manager-install.js";

// The exact record the worker writes on the #364 crash: do_update raised
// AttributeError, so the worker's except-branch calls task_done with
// status_str="error" and the exception text in messages.
const CRASH_ITEM = {
  ui_id: "u-crash",
  client_id: "comfyui-mcp-panel",
  kind: "update",
  result: "Exception: ('update', QueueTaskItem(...))",
  status: {
    status_str: "error",
    completed: true,
    messages: [
      "Exception: 'InstallPackParams' object has no attribute 'node_name'",
    ],
  },
  params: { node_name: "ComfyUI-GGUF", id: "ComfyUI-GGUF" },
};

const SUCCESS_ITEM = {
  ui_id: "u-ok",
  kind: "update",
  result: "success",
  status: { status_str: "success", completed: true, messages: [] },
  params: { node_name: "ComfyUI-GGUF" },
};

const SKIP_ITEM = {
  ui_id: "u-skip",
  kind: "update",
  result: "skip",
  status: { status_str: "skip", completed: true, messages: [] },
  params: { node_name: "ComfyUI-GGUF" },
};

test("taskFailureReason surfaces the crash reason ONLY for a failure terminal", () => {
  assert.equal(
    taskFailureReason(CRASH_ITEM),
    "Exception: 'InstallPackParams' object has no attribute 'node_name'",
  );
  // failed status with no messages falls back to result, then a generic reason.
  assert.equal(
    taskFailureReason({ status: { status_str: "failed" }, result: "boom" }),
    "boom",
  );
  assert.match(
    taskFailureReason({ status: { status_str: "failed" } }),
    /reported the task as failed/,
  );
  // Never a false failure: success / skip / running / unknown / junk ⇒ null.
  assert.equal(taskFailureReason(SUCCESS_ITEM), null);
  assert.equal(taskFailureReason(SKIP_ITEM), null);
  assert.equal(taskFailureReason({ status: { status_str: "success" } }), null);
  assert.equal(taskFailureReason(null), null);
  assert.equal(taskFailureReason({}), null);
  assert.equal(taskFailureReason("done"), null);
});

test("taskSucceeded is true ONLY for success/skip terminals", () => {
  assert.equal(taskSucceeded(SUCCESS_ITEM), true);
  assert.equal(taskSucceeded(SKIP_ITEM), true);
  assert.equal(taskSucceeded({ status: { status_str: "skipped" } }), true);
  assert.equal(taskSucceeded(CRASH_ITEM), false);
  assert.equal(taskSucceeded({ status: { status_str: "error" } }), false);
  assert.equal(taskSucceeded(null), false);
  assert.equal(taskSucceeded({}), false);
});

test("parseTaskHistoryItem handles the ui_id-queried single-item shape", () => {
  // ui_id-queried: server returns { history: <item> } (the item itself).
  const resp = { history: CRASH_ITEM };
  assert.equal(parseTaskHistoryItem(resp, "u-crash"), CRASH_ITEM);
  // A mismatched embedded ui_id is rejected (defensive).
  assert.equal(parseTaskHistoryItem(resp, "someone-else"), null);
});

test("parseTaskHistoryItem handles the map-keyed shape and absence", () => {
  const resp = { history: { "u-crash": CRASH_ITEM, "u-ok": SUCCESS_ITEM } };
  assert.equal(parseTaskHistoryItem(resp, "u-crash"), CRASH_ITEM);
  assert.equal(parseTaskHistoryItem(resp, "u-ok"), SUCCESS_ITEM);
  // Task not yet recorded (still running) ⇒ { history: {} } ⇒ null.
  assert.equal(parseTaskHistoryItem({ history: {} }, "u-crash"), null);
  assert.equal(parseTaskHistoryItem(null, "u-crash"), null);
});

// ---- The #364 regression: a failed update MUST NOT report success ----------

test("classifyUpdateOutcome reports FAILURE for the crashed do_update task", () => {
  const item = parseTaskHistoryItem({ history: CRASH_ITEM }, "u-crash");
  const outcome = classifyUpdateOutcome({
    item,
    status: { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
    target: "ComfyUI-GGUF",
    dialect: "v2",
  });
  assert.equal(outcome.state, "failed");
  // The Manager-side reason is surfaced verbatim.
  assert.match(outcome.message, /FAILED/);
  assert.match(outcome.message, /no attribute 'node_name'/);
  assert.match(outcome.message, /ComfyUI-GGUF/);
});

test("classifyUpdateOutcome reports SUCCESS for a real success (no false failure)", () => {
  for (const item of [SUCCESS_ITEM, SKIP_ITEM]) {
    const outcome = classifyUpdateOutcome({ item, target: "ComfyUI-GGUF", dialect: "v2" });
    assert.equal(outcome.state, "updated");
  }
});

test("classifyUpdateOutcome stays UNVERIFIED (never a false failure) when inconclusive", () => {
  // Task not yet terminal / legacy Manager without /v2 history / unknown shape.
  for (const item of [null, undefined, {}, { status: { status_str: "in_progress" } }]) {
    const outcome = classifyUpdateOutcome({ item, target: "ComfyUI-GGUF", dialect: "legacy" });
    assert.equal(outcome.state, "unverified");
    assert.match(outcome.message, /could NOT be confirmed/);
    assert.doesNotMatch(outcome.message, /FAILED/);
  }
});

test("collectRecentTaskFailures extracts only failures from a mixed history map", () => {
  const hist = {
    history: {
      "u-ok": SUCCESS_ITEM,
      "u-skip": SKIP_ITEM,
      "u-crash": CRASH_ITEM,
    },
  };
  const failures = collectRecentTaskFailures(hist);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].ui_id, "u-crash");
  assert.equal(failures[0].kind, "update");
  assert.equal(failures[0].id, "ComfyUI-GGUF");
  assert.match(failures[0].result, /no attribute 'node_name'/);
  // Empty / malformed history ⇒ no failures (best-effort, never throws).
  assert.deepEqual(collectRecentTaskFailures({ history: {} }), []);
  assert.deepEqual(collectRecentTaskFailures(null), []);
});
