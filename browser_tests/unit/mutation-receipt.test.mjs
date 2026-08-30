/**
 * #2116 — a graph_set_widget that applies after the caller timeout must leave a
 * rid-correlated receipt, and retry_of must resolve that outcome without a
 * second mutation.
 *
 * These drive the SHIPPED createMutationReceiptStore / resolveLateMutationReply
 * / awaitSetWidgetAck (onLateSuccess) functions, plus the panel wiring that
 * actually stores and replays them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createMutationReceiptStore,
  resolveLateMutationReply,
  LATE_MUTATION_RECEIPT_TTL_MS,
  MAX_LATE_MUTATION_RECEIPTS,
} from "../../web/js/lib/mutation-receipt.js";
import { awaitSetWidgetAck } from "../../web/js/lib/set-widget.js";
import { commandFingerprint } from "../../web/js/lib/command-dedupe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8");
const SET_WIDGET_SRC = readFileSync(join(HERE, "../../web/js/lib/set-widget.js"), "utf8");

const APPLIED = {
  applied: true,
  set: { node_id: 42, widget: "text", value: "done" },
};

function fireableTimers() {
  const timers = [];
  return {
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    fire: () => {
      assert.equal(timers.length, 1, "the outer wait must arm a timeout");
      timers[0]();
    },
  };
}

test("#2116 store: an applied receipt is replayable by request id", () => {
  const store = createMutationReceiptStore();
  const fingerprint = commandFingerprint({
    cmd: "graph_set_widget",
    node_id: 42,
    widget: "text",
    value: "done",
  });
  store.remember("r1", APPLIED, { fingerprint });
  const hit = store.lookup("r1", fingerprint);
  assert.equal(hit.rid, "r1");
  assert.equal(hit.cmd, "graph_set_widget");
  assert.equal(hit.result.set.value, "done");
  assert.deepEqual(store.lookup("missing"), undefined);
});

test("#2116 store: an unapplied timeout is not persisted", () => {
  const store = createMutationReceiptStore();
  store.remember("r1", { applied: false, error: "unknown" });
  store.remember("r2", { error: "did not reply" });
  store.remember("", APPLIED);
  store.remember(null, APPLIED);
  assert.equal(store.list().length, 0);
});

test("#2116 store: a mismatched fingerprint is a miss, not a wrong-command replay", () => {
  const store = createMutationReceiptStore();
  store.remember("r1", APPLIED, { fingerprint: "fp-a" });
  assert.equal(store.lookup("r1", "fp-b"), undefined, "different work must not receive this receipt");
  assert.equal(store.lookup("r1", "fp-a").result.set.value, "done");
});

test("#2116 store: oldest receipts are evicted and expired receipts are pruned", () => {
  let now = 1000;
  const store = createMutationReceiptStore({
    ttlMs: 100,
    maxEntries: 2,
    now: () => now,
  });
  store.remember("r1", { applied: true, set: { value: 1 } });
  store.remember("r2", { applied: true, set: { value: 2 } });
  store.remember("r3", { applied: true, set: { value: 3 } });
  assert.deepEqual(
    store.list().map((r) => r.rid),
    ["r2", "r3"],
    "the cap drops the oldest settled receipt",
  );
  now = 1000 + 101;
  assert.equal(store.list().length, 0, "TTL prune drops expired receipts");
});

test("#2116 resolveLateMutationReply: retry_of returns the original receipt under the retry rid", () => {
  const store = createMutationReceiptStore();
  const fingerprint = "fp-widget";
  store.remember("r1", APPLIED, { fingerprint });
  const resolved = resolveLateMutationReply(
    store,
    { rid: "r2", retry_of: "r1", cmd: "graph_set_widget" },
    fingerprint,
  );
  assert.equal(resolved.retryOfHit, true);
  assert.equal(resolved.reply.rid, "r2");
  assert.equal(resolved.reply.ok, true);
  assert.equal(resolved.reply.result.set.value, "done");
});

test("#2116 resolveLateMutationReply: same-rid replay uses the stored receipt", () => {
  const store = createMutationReceiptStore();
  store.remember("r1", APPLIED, { fingerprint: "fp" });
  const resolved = resolveLateMutationReply(store, { rid: "r1", cmd: "graph_set_widget" }, "fp");
  assert.equal(resolved.retryOfHit, false);
  assert.equal(resolved.reply.rid, "r1");
  assert.equal(resolved.reply.result.applied, true);
});

test("#2116 resolveLateMutationReply: unknown or mismatched tokens do not suppress execution", () => {
  const store = createMutationReceiptStore();
  store.remember("r1", APPLIED, { fingerprint: "fp-a" });
  assert.equal(
    resolveLateMutationReply(store, { rid: "r2", retry_of: "r-unknown" }, "fp-a"),
    undefined,
  );
  assert.equal(
    resolveLateMutationReply(store, { rid: "r2", retry_of: "r1" }, "fp-other"),
    undefined,
    "a fingerprint mismatch must not replay the original write's receipt",
  );
});

test("#2116 awaitSetWidgetAck: a write that applies after the ack timeout emits a late receipt", async () => {
  let resolveWrite;
  const write = new Promise((resolve) => {
    resolveWrite = resolve;
  });
  const clock = fireableTimers();
  const late = [];
  const pending = awaitSetWidgetAck(write, {
    node: { id: 42, widgets: [{ name: "text", value: "old" }] },
    widget: "text",
    requested: "done",
    timeoutMs: 80,
    delivered: true,
    timers: clock,
    onLateSuccess: (result) => late.push(result),
  });
  clock.fire();
  const early = await Promise.race([
    pending.then(() => "answered", () => "answered"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 20)),
  ]);
  assert.equal(early, "still waiting", "an unlanded write must keep waiting, not invent unknown");
  assert.equal(late.length, 0, "no receipt until the original write applies");
  resolveWrite({ set: { node_id: 42, widget: "text", value: "done" } });
  const out = await pending;
  assert.equal(out.applied, true);
  assert.equal(out.set.value, "done");
  assert.ok(late.length >= 1, "the late apply must be persisted");
  assert.equal(late[late.length - 1].applied, true);
  assert.equal(late[late.length - 1].set.value, "done");
});

test("#2116 retry_of resolves the late receipt without a duplicate mutation", async () => {
  const store = createMutationReceiptStore();
  const fingerprint = commandFingerprint({
    cmd: "graph_set_widget",
    node_id: 42,
    widget: "text",
    value: "done",
  });
  let applied = 0;
  const execute = async () => {
    applied += 1;
    return { ...APPLIED };
  };

  async function deliver(msg) {
    const fp = commandFingerprint(msg);
    const late = resolveLateMutationReply(store, msg, fp);
    if (late) return { reply: late.reply, executed: false };
    const result = await execute();
    store.remember(msg.rid, result, { fingerprint: fp });
    return { reply: { rid: msg.rid, ok: true, result }, executed: true };
  }

  const first = await deliver({
    rid: "r1",
    cmd: "graph_set_widget",
    node_id: 42,
    widget: "text",
    value: "done",
  });
  assert.equal(first.executed, true);
  assert.equal(applied, 1);

  const retry = await deliver({
    rid: "r2",
    retry_of: "r1",
    cmd: "graph_set_widget",
    node_id: 42,
    widget: "text",
    value: "done",
  });
  assert.equal(retry.executed, false, "retry_of must not run the writer again");
  assert.equal(applied, 1, "the mutation is still applied exactly once");
  assert.equal(retry.reply.rid, "r2");
  assert.equal(retry.reply.ok, true);
  assert.equal(retry.reply.result.set.value, "done");
});

test("#2116 constants match the save-receipt window", () => {
  assert.equal(LATE_MUTATION_RECEIPT_TTL_MS, 10 * 60 * 1000);
  assert.equal(MAX_LATE_MUTATION_RECEIPTS, 32);
});

test("#2116 wiring: graph_set_widget persists late receipts and retry_of replays them", () => {
  const start = PANEL_SRC.indexOf("async graph_set_widget({");
  const end = PANEL_SRC.indexOf("\n  // artokun/comfyui-mcp#938", start);
  assert.ok(start >= 0, "graph_set_widget handler not found");
  assert.ok(end > start, "graph_set_widget handler boundary not found");
  const handler = PANEL_SRC.slice(start, end);
  assert.match(handler, /onLateSuccess:/);
  assert.match(handler, /lateMutationReceipts\.remember\(requestId,/);

  assert.match(SET_WIDGET_SRC, /onLateSuccess: opts\.onLateSuccess/);
  assert.match(SET_WIDGET_SRC, /noteLateSuccess/);

  const fpAt = PANEL_SRC.indexOf("const fingerprint = commandFingerprint(msg);");
  const blockEnd = PANEL_SRC.indexOf("\n        try {", fpAt);
  const block = PANEL_SRC.slice(fpAt, blockEnd);
  assert.match(
    block,
    /const lateMutation = resolveLateMutationReply\(lateMutationReceipts, msg, fingerprint\);/,
  );
  assert.match(block, /priorRidReply = lateMutation\.reply;/);
  assert.match(block, /retryOfHit = lateMutation\.retryOfHit;/);

  assert.match(PANEL_SRC, /late_mutation_receipts: lateMutationReceiptsList,/);
  assert.match(
    PANEL_SRC,
    /lateMutationReceipts\.remember\(msg\.rid, reply\.result/,
  );
  assert.match(PANEL_SRC, /from "\.\/lib\/mutation-receipt\.js"/);
});
