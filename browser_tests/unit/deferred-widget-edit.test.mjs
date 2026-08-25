// #1716 — the explicit safe widget deferral path.
//
// The helper tests prove the queue semantics. The production-path tests below
// also extract and execute the shipped `defer_until_idle` branch from
// GRAPH_TOOL_EXECUTORS.graph_set_widget, so a helper that is never wired into
// the real command cannot make this suite green.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createDeferredWidgetEditQueue,
  deferredWidgetQueueCounts,
  isSafeDeferredWidgetValue,
  sameDeferredWidgetValue,
} from "../../web/js/lib/deferred-widget-edit.js";
import { resolvePromotedInnerTarget } from "../../web/js/lib/widget-write.js";

const panelSource = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const scopedBatchSeedSource = readFileSync(
  new URL("../../web/js/lib/scoped-batch-seed.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

test("#1716 queue status requires both running and pending lists", () => {
  assert.deepEqual(deferredWidgetQueueCounts({ queue_running: [1], queue_pending: [2, 3] }), {
    running: 1,
    pending: 2,
  });
  assert.equal(deferredWidgetQueueCounts({ queue_running: [], queue_pending: [] }).running, 0);
  assert.equal(deferredWidgetQueueCounts({ queue_running: [] }), null);
});

test("#1716 helper waits for a fully idle queue, then applies in order", async () => {
  let now = 100;
  const timers = [];
  let queue = { queue_running: ["p1"], queue_pending: [] };
  const applied = [];
  const settled = [];
  const edits = createDeferredWidgetEditQueue({
    readQueue: async () => queue,
    now: () => now,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    onSettled: (outcome) => settled.push(outcome),
  });

  const first = edits.enqueue({
    node_id: 3,
    widget: "text",
    expected_value: "old",
    value: "new",
    readCurrent: () => ({ ok: true, value: "old" }),
    apply: async () => {
      applied.push("first");
      return { value: "new" };
    },
  });
  const second = edits.enqueue({
    node_id: 3,
    widget: "text",
    expected_value: "old",
    value: "later",
    readCurrent: () => ({ ok: true, value: "old" }),
    apply: async () => {
      applied.push("second");
      return { value: "later" };
    },
  });
  assert.equal(edits.pending(), 2);
  assert.equal(timers.length, 1, "the queue uses one shared poll timer");

  timers.shift()();
  await Promise.resolve();
  assert.deepEqual(applied, [], "a running render keeps both edits parked");
  assert.equal(edits.pending(), 2);

  queue = { queue_running: [], queue_pending: [] };
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, ["first", "second"]);
  assert.equal(edits.pending(), 0);
  assert.deepEqual(settled.map((row) => [row.receipt, row.status]), [
    [first.receipt, "applied"],
    [second.receipt, "applied"],
  ]);
  edits.close();
});

test("#1716 helper refuses a changed expected value without calling apply", async () => {
  const timers = [];
  let applied = 0;
  let outcome;
  const edits = createDeferredWidgetEditQueue({
    readQueue: async () => ({ queue_running: [], queue_pending: [] }),
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    onSettled: (row) => {
      outcome = row;
    },
  });
  edits.enqueue({
    node_id: 3,
    widget: "text",
    expected_value: "old",
    value: "new",
    readCurrent: () => ({ ok: true, value: "user changed" }),
    apply: async () => {
      applied += 1;
    },
  });
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(applied, 0);
  assert.equal(outcome.status, "refused");
  assert.match(outcome.error, /changed while the edit was deferred/);
  edits.close();
});

test("#1716 overlapping drains apply each parked edit at most once", async () => {
  const timers = [];
  const applied = [];
  let releaseApply;
  const applyGate = new Promise((resolve) => {
    releaseApply = resolve;
  });
  const edits = createDeferredWidgetEditQueue({
    readQueue: async () => ({ queue_running: [], queue_pending: [] }),
    setTimer: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: () => {},
  });

  for (const label of ["first", "second"]) {
    edits.enqueue({
      node_id: 3,
      widget: label,
      expected_value: "old",
      value: "new",
      readCurrent: async () => ({ ok: true, value: "old" }),
      apply: async () => {
        applied.push(label);
        await applyGate;
      },
    });
  }

  const timer = timers.shift();
  timer();
  timer();
  await new Promise((resolve) => setImmediate(resolve));
  releaseApply();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(applied, ["first", "second"]);
  assert.equal(edits.pending(), 0);
  edits.close();
});

function buildProductionDeferredSafety() {
  const safetyStart = panelSource.indexOf("function deferredWidgetSafetyReason(");
  const safetyEnd = panelSource.indexOf("\n\nconst GRAPH_TOOL_EXECUTORS", safetyStart);
  assert.ok(safetyStart >= 0 && safetyEnd > safetyStart, "shipped safety classifier not found");
  const safety = new Function(
    "isSafeDeferredWidgetValue",
    "sameDeferredWidgetValue",
    "resolvePromotedInnerTarget",
    "classifyMiniMaxH3DirectorWrite",
    "classifyLtxTimelineWrite",
    "classifyPromptRelayTimelineWrite",
    "classifyRgthreeFastGroupsWrite",
    "classifyIdeogram4PromptBuilderWrite",
    "classifyMiniMaxH3PromptBuilderWrite",
    `${panelSource.slice(safetyStart, safetyEnd)}\nreturn deferredWidgetSafetyReason;`,
  )(
    isSafeDeferredWidgetValue,
    sameDeferredWidgetValue,
    resolvePromotedInnerTarget,
    () => null,
    () => null,
    () => null,
    () => null,
    () => null,
    () => null,
  );

  const handlerStart = panelSource.indexOf("  async graph_set_widget({", safetyEnd);
  const branchEnd = panelSource.indexOf("    const enforceDeferredExpected", handlerStart);
  assert.ok(handlerStart >= 0 && branchEnd > handlerStart, "shipped graph_set_widget branch not found");
  const branch = `${panelSource.slice(handlerStart, branchEnd)}\n    throw new Error("fallthrough");\n  }`;
  return { safety, branch };
}

function runProductionDeferredBranch({ node, queuePayload, expected = "old", value = "new" }) {
  const { safety, branch } = buildProductionDeferredSafety();
  let currentQueuePayload = queuePayload;
  const timers = [];
  const applyCalls = [];
  const graph = {
    _nodes: [node],
    getNodeById: (id) => (id === node.id ? node : null),
  };
  const deferredQueue = createDeferredWidgetEditQueue({
    readQueue: async () => currentQueuePayload,
    setTimer: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: () => {},
  });
  const executor = new Function(
    "SET_WIDGET_COMMAND_BUDGET_MS",
    "makeCommandBudget",
    "monotonicNow",
    "getGraphCtx",
    "resolveNode",
    "classifyMiniMaxH3DirectorWrite",
    "miniMaxH3DirectorPromptRefusal",
    "deferredWidgetSafetyReason",
    "deferredWidgetQueueCounts",
    "readQueueForDeferredWidgetEdit",
    "getDeferredWidgetEditQueue",
    "sameDeferredWidgetValue",
    "GRAPH_TOOL_EXECUTORS",
    `const executors = { ${branch} }; return executors.graph_set_widget;`,
  )(
    30_000,
    () => ({ bounded: (fn) => fn, remaining: () => 30_000 }),
    () => 0,
    () => ({ app: {}, graph, rootGraph: graph, LG: {} }),
    (g, id) => g.getNodeById(id),
    () => null,
    () => "refused",
    safety,
    deferredWidgetQueueCounts,
    async () => queuePayload,
    () => deferredQueue,
    sameDeferredWidgetValue,
    {
      graph_set_widget: async (args) => {
        applyCalls.push(args);
        node.widgets[0].value = value;
        return { applied: true };
      },
    },
  );
  return {
    executor,
    deferredQueue,
    timers,
    applyCalls,
    setQueue: (next) => {
      currentQueuePayload = next;
    },
    call: () => executor({
      node_id: node.id,
      widget: "text",
      value,
      expected_value: expected,
      defer_until_idle: true,
    }),
  };
}

test("#1716 production graph_set_widget parks a safe scalar edit while render is running", async () => {
  const node = { id: 7, type: "KSampler", widgets: [{ name: "text", value: "old" }] };
  const run = runProductionDeferredBranch({
    node,
    queuePayload: { queue_running: ["render-1"], queue_pending: [] },
  });
  const result = await run.call();
  assert.equal(result.deferred, true);
  assert.equal(result.status, "waiting_for_queue_idle");
  assert.equal(run.deferredQueue.pending(), 1);
  assert.equal(node.widgets[0].value, "old", "parking the edit must not mutate the live graph");
  run.deferredQueue.close();
});

test("#1716 production graph_set_widget replays the parked edit after the queue drains", async () => {
  const node = { id: 7, type: "KSampler", widgets: [{ name: "text", value: "old" }] };
  const run = runProductionDeferredBranch({
    node,
    queuePayload: { queue_running: ["render-1"], queue_pending: [] },
  });
  const parked = await run.call();
  assert.equal(parked.deferred, true);
  assert.equal(run.timers.length, 1);

  run.setQueue({ queue_running: [], queue_pending: [] });
  run.timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(node.widgets[0].value, "new");
  assert.equal(run.applyCalls.length, 1, "the production executor must be called once at drain");
  assert.equal(run.applyCalls[0].defer_replay, true);
  assert.equal(run.deferredQueue.pending(), 0);
  run.deferredQueue.close();
});

test("#1716 production graph_set_widget refuses callback-driven widgets before parking", async () => {
  const node = {
    id: 7,
    type: "CustomPrompt",
    widgets: [{ name: "text", value: "old", callback: () => {} }],
  };
  const run = runProductionDeferredBranch({
    node,
    queuePayload: { queue_running: ["render-1"], queue_pending: [] },
  });
  await assert.rejects(run.call(), /callback-driven mutation/);
  assert.equal(run.deferredQueue.pending(), 0);
  assert.equal(node.widgets[0].value, "old");
  run.deferredQueue.close();
});

test("#1716 production classifier refuses afterQueued-only widgets", async () => {
  assert.match(scopedBatchSeedSource, /widget\.beforeQueued\?\./);
  assert.match(scopedBatchSeedSource, /executeWidgetsCallback\(queuedNodes, ['"]afterQueued['"]/);
  const node = {
    id: 7,
    type: "CustomPrompt",
    widgets: [{ name: "text", value: "old", afterQueued: () => {} }],
  };
  const run = runProductionDeferredBranch({
    node,
    queuePayload: { queue_running: ["render-1"], queue_pending: [] },
  });
  await assert.rejects(run.call(), /queue-time or composite behavior/);
  assert.equal(run.deferredQueue.pending(), 0);
  assert.equal(node.widgets[0].value, "old");
  run.deferredQueue.close();
});

test("#1716 production classifier refuses generic promoted subgraph scalar routes", async () => {
  const node = {
    id: 7,
    type: "SubgraphNode",
    subgraph: { _nodes: [] },
    inputs: [{ name: "text", _subgraphSlot: { name: "text", linkIds: [] } }],
    widgets: [{ name: "text", value: "old" }],
  };
  const run = runProductionDeferredBranch({
    node,
    queuePayload: { queue_running: ["render-1"], queue_pending: [] },
  });
  await assert.rejects(run.call(), /promoted\/subgraph route/);
  assert.equal(run.deferredQueue.pending(), 0);
  assert.equal(node.widgets[0].value, "old");
  run.deferredQueue.close();
});

test("#1716 production classifier still permits an ordinary safe scalar widget", () => {
  const { safety } = buildProductionDeferredSafety();
  assert.equal(
    safety({ type: "KSampler", widgets: [{ name: "text", value: "old" }] }, "text", "new", "old"),
    null,
  );
});

test("#1716 production graph_set_widget refuses a stale expected value", async () => {
  const node = { id: 7, type: "KSampler", widgets: [{ name: "text", value: "current" }] };
  const run = runProductionDeferredBranch({
    node,
    queuePayload: { queue_running: ["render-1"], queue_pending: [] },
    expected: "old",
  });
  await assert.rejects(run.call(), /changed before it could be deferred/);
  assert.equal(run.deferredQueue.pending(), 0);
  run.deferredQueue.close();
});
