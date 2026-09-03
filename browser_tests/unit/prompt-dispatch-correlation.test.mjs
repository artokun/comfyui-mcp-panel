/**
 * #2203 — recover a prompt_id when POST /prompt throws after dispatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DISPATCH_ID_FIELD,
  extraDataFromHistoryEntry,
  extraDataFromQueueRow,
  matchDispatchPromptIds,
  mintDispatchId,
  promptIdFromHistoryEntry,
  promptIdFromQueueRow,
  recoverPromptIdAfterDispatch,
  stampPromptDispatchId,
  stampPromptDispatchOptions,
} from "../../web/js/lib/prompt-dispatch-correlation.js";

test("#2203 mintDispatchId is a cmcp-d- token", () => {
  const id = mintDispatchId();
  assert.match(id, /^cmcp-d-/);
  assert.notEqual(mintDispatchId(), id);
});

test("#2203 stampPromptDispatchId writes extra_data without touching prompt or pnginfo", () => {
  const body = {
    prompt: { "9": { class_type: "SaveImage", inputs: {} } },
    client_id: "x",
    extra_data: { extra_pnginfo: { workflow: { nodes: [1] } } },
    number: 42,
  };
  const stamped = stampPromptDispatchId(JSON.stringify(body), "cmcp-d-test");
  const parsed = JSON.parse(stamped);
  assert.equal(parsed.extra_data[DISPATCH_ID_FIELD], "cmcp-d-test");
  assert.deepEqual(parsed.extra_data.extra_pnginfo, { workflow: { nodes: [1] } });
  assert.deepEqual(parsed.prompt, body.prompt);
  assert.equal(parsed.number, 42);
});

test("#2203 stampPromptDispatchId refuses an unreadable or non-object extra_data", () => {
  assert.equal(stampPromptDispatchId("{", "cmcp-d-x"), null);
  assert.equal(stampPromptDispatchId(JSON.stringify({ prompt: {}, extra_data: [] }), "cmcp-d-x"), null);
  assert.equal(stampPromptDispatchId(JSON.stringify({ prompt: {} }), ""), null);
});

test("#2203 stampPromptDispatchOptions mutates the same options object", () => {
  const options = { method: "POST", body: JSON.stringify({ prompt: {} }) };
  const out = stampPromptDispatchOptions(options, "cmcp-d-same");
  assert.equal(out, options);
  assert.equal(JSON.parse(options.body).extra_data[DISPATCH_ID_FIELD], "cmcp-d-same");
});

test("#2203 queue tuple extra_data and prompt_id are read from both row shapes", () => {
  const extra = { [DISPATCH_ID_FIELD]: "cmcp-d-q" };
  const tuple = [3, "pid-1", { "1": {} }, extra, []];
  assert.equal(promptIdFromQueueRow(tuple), "pid-1");
  assert.deepEqual(extraDataFromQueueRow(tuple), extra);
  assert.equal(promptIdFromQueueRow({ prompt_id: "pid-2", extra_data: extra }), "pid-2");
  assert.deepEqual(extraDataFromQueueRow({ prompt_id: "pid-2", extra_data: extra }), extra);
});

test("#2203 history entry extra_data is read from the prompt tuple", () => {
  const extra = { [DISPATCH_ID_FIELD]: "cmcp-d-h" };
  const entry = { prompt: [1, "hist-1", {}, extra, []], outputs: {} };
  assert.deepEqual(extraDataFromHistoryEntry(entry), extra);
  assert.equal(promptIdFromHistoryEntry("hist-1", entry), "hist-1");
});

test("#2203 matchDispatchPromptIds recovers a unique queue row by dispatch id", () => {
  const extra = { [DISPATCH_ID_FIELD]: "cmcp-d-hit" };
  const found = matchDispatchPromptIds({
    queueJson: { queue_running: [[0, "run-9", {}, extra, []]], queue_pending: [] },
    historyJson: {},
    dispatchId: "cmcp-d-hit",
  });
  assert.deepEqual(found, { status: "recovered", promptId: "run-9", source: "dispatch_id" });
});

test("#2203 matchDispatchPromptIds recovers a unique history entry by dispatch id", () => {
  const extra = { [DISPATCH_ID_FIELD]: "cmcp-d-hist" };
  const found = matchDispatchPromptIds({
    queueJson: { queue_running: [], queue_pending: [] },
    historyJson: { "h-1": { prompt: [2, "h-1", {}, extra, []] } },
    dispatchId: "cmcp-d-hist",
  });
  assert.equal(found.status, "recovered");
  assert.equal(found.promptId, "h-1");
  assert.equal(found.source, "dispatch_id");
});

test("#2203 a unique queue mark is corroboration, NOT a receipt", () => {
  // The mark is shared by every prompt in a batch, and the counter restarts on a
  // page reload while ComfyUI history persists. So a single match can name an
  // earlier batch item, or a row from a previous session -- reporting a stale
  // prompt_id AND counting this failed post as observed. It is reported as a
  // match for the humans, but the VERDICT stays unknown until the marker is
  // unique per request (review of #2215).
  const found = matchDispatchPromptIds({
    queueJson: { queue_running: [], queue_pending: [[1073741822, "mark-id", {}, {}, []]] },
    historyJson: {},
    dispatchId: "cmcp-d-missing",
    queueMark: 1073741822,
  });
  assert.equal(found.status, "unknown");
  assert.equal(found.reason, "queue_mark_is_not_a_receipt");
  assert.equal(found.markMatch, "mark-id");
});

test("#2203 a FAILED queue/history read is not evidence of an empty one", () => {
  // A 500 whose body happens to be JSON used to read as a valid, empty map --
  // which with an empty queue produced "absent" and authorized a retry on the
  // strength of the server being broken (review of #2215).
  const found = matchDispatchPromptIds({
    queueJson: undefined,
    historyJson: {},
    dispatchId: "cmcp-d-missing",
    queueMark: 1073741822,
  });
  assert.equal(found.status, "unknown");
});

test("#2203 matchDispatchPromptIds never treats number 0 as a unique mark", () => {
  const found = matchDispatchPromptIds({
    queueJson: { queue_running: [[0, "user-queue", {}, {}, []]], queue_pending: [] },
    historyJson: {},
    dispatchId: "cmcp-d-missing",
    queueMark: 0,
  });
  assert.equal(found.status, "absent");
});

test("#2203 matchDispatchPromptIds is unknown when queue/history cannot be read", () => {
  const found = matchDispatchPromptIds({
    queueJson: { queue_running: "nope" },
    historyJson: null,
    dispatchId: "cmcp-d-x",
  });
  assert.equal(found.status, "unknown");
});

test("#2203 matchDispatchPromptIds is absent when both sides are well-formed and empty of the id", () => {
  const found = matchDispatchPromptIds({
    queueJson: { queue_running: [], queue_pending: [] },
    historyJson: {},
    dispatchId: "cmcp-d-gone",
  });
  assert.equal(found.status, "absent");
});

test("#2203 recoverPromptIdAfterDispatch polls until the row appears", async () => {
  let n = 0;
  const extra = { [DISPATCH_ID_FIELD]: "cmcp-d-late" };
  const fetchApi = async (route) => {
    n++;
    const path = String(route).split("?")[0];
    if (path.endsWith("/history")) return { json: async () => ({}) };
    if (n < 3) return { json: async () => ({ queue_running: [], queue_pending: [] }) };
    return { json: async () => ({ queue_running: [[1, "late-id", {}, extra, []]], queue_pending: [] }) };
  };
  const sleeps = [];
  const recovered = await recoverPromptIdAfterDispatch({
    fetchApi,
    dispatchId: "cmcp-d-late",
    delayMs: 5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(recovered.status, "recovered");
  assert.equal(recovered.promptId, "late-id");
  assert.ok(sleeps.length >= 1);
});

test("#2203 recoverPromptIdAfterDispatch stops immediately when both reads throw", async () => {
  let n = 0;
  const fetchApi = async () => {
    n++;
    throw new TypeError("Failed to fetch");
  };
  const recovered = await recoverPromptIdAfterDispatch({
    fetchApi,
    dispatchId: "cmcp-d-x",
    attempts: 4,
    delayMs: 50,
    sleep: async () => {
      throw new Error("sleep should not run after unreadable reads");
    },
  });
  assert.equal(recovered.status, "unknown");
  assert.equal(n, 3, "one /queue, /history?max_items=64, then /history, then stop");
});
