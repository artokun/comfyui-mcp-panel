/**
 * #572 recurrence — a scoped run-to-node false-refuses as `graph CHANGED`
 * after a finished subgraph edit (activate nested samplers, exit, then run).
 *
 * The shipped stamp used to run immediately, so a leftover nested `model`
 * link (`135:29 model`) that rematerialises on the next turn / next
 * graphToPrompt was treated as a user edit. These tests drive
 * `dispatchScopedRun` — the same orchestration the panel run path runs —
 * and must fail on that false reject while still refusing a real edit (#556).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  dispatchScopedRun,
  graphStampBusy,
  graphStampRevision,
  sameGraphStampRevision,
} from "../../web/js/lib/run-scope-guard.js";

function jsonResponse(status, obj) {
  return {
    status,
    clone() {
      return { json: async () => JSON.parse(JSON.stringify(obj)) };
    },
    text: async () => JSON.stringify(obj),
  };
}

function makeServer(responder) {
  const calls = [];
  const fetchApi = async (route, options) => {
    calls.push({ route, options });
    return responder ? responder(route, options) : jsonResponse(200, { prompt_id: `srv-${calls.length}` });
  };
  fetchApi.calls = calls;
  return fetchApi;
}

const promptPost = (body) => [
  "/prompt",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  },
];

function keepAlive() {
  const ka = setInterval(() => {}, 25);
  return () => clearInterval(ka);
}

function frontendBody({ output, number, targets = null }) {
  const body = { prompt: output, client_id: "x" };
  if (targets) body.partial_execution_targets = targets;
  if (number != 0) body.number = number;
  return body;
}

// Nested KSampler inside subgraph instance 135 — leftover widget `model`
// vs the rematerialised incoming link after subgraph-exit settle.
const STALE_OUTPUT = {
  "135:3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  "135:29": { class_type: "KSampler", inputs: { model: "model.safetensors", seed: 1, steps: 20 } },
  "34": { class_type: "PreviewImage", inputs: { images: ["135:29", 0] } },
};
const SETTLED_OUTPUT = {
  "135:3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  "135:29": { class_type: "KSampler", inputs: { model: ["135:3", 0], seed: 1, steps: 20 } },
  "34": { class_type: "PreviewImage", inputs: { images: ["135:29", 0] } },
};

function queueFromPrompt(app, apiTarget) {
  return async (number, _batch, arg) => {
    const targets = Array.isArray(arg) ? arg : arg?.queueNodeIds;
    const queued = await app.graphToPrompt();
    const body = frontendBody({
      output: queued.output,
      number,
      targets: targets?.length ? targets : null,
    });
    app.posted.push(body);
    await apiTarget.fetchApi(...promptPost(body));
    return true;
  };
}

test("#572 graphStampRevision: unreadables are idle; a live transaction is busy", () => {
  assert.equal(graphStampBusy(graphStampRevision({})), false);
  assert.equal(graphStampBusy(graphStampRevision({ graph: {} })), false);
  const busy = graphStampRevision({
    graph: { changeTracker: { changeCount: 1 }, last_change_time: 4 },
  });
  assert.equal(graphStampBusy(busy), true);
  assert.equal(busy.changeCount, 1);
  assert.equal(busy.extra, 4);
  const idle = graphStampRevision({
    graph: { changeTracker: { changeCount: 0 }, last_change_time: 4 },
  });
  assert.equal(graphStampBusy(idle), false);
  assert.equal(sameGraphStampRevision(busy, idle), false);
});

test("#572 settle: a pending subgraph-exit transaction is not a user edit — the scoped run dispatches", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const graph = {
      last_change_time: 1,
      changeTracker: { changeCount: 1, _restoringState: false },
      _nodes: [],
    };
    const app = {
      graph,
      rootGraph: graph,
      queueItems: [],
      posted: [],
      graphToPrompt: async () => ({
        output: structuredClone(graph.changeTracker.changeCount > 0 ? STALE_OUTPUT : SETTLED_OUTPUT),
        workflow: {},
      }),
    };
    app.queuePrompt = async (number, batch, arg) => {
      await new Promise((r) => setTimeout(r, 0));
      return queueFromPrompt(app, apiTarget)(number, batch, arg);
    };
    setTimeout(() => {
      graph.changeTracker.changeCount = 0;
      graph.last_change_time = 2;
    }, 0);
    const ids = [];
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["34"], batch: 1, toNodeId: 34, verifyTimeoutMs: 500,
      onPromptId: (p) => ids.push(p),
    });
    assert.equal(result.outcome, "dispatched", "the leftover nested model link is settle, not drift");
    assert.equal(result.verified, 1);
    assert.deepEqual(ids, ["srv-1"]);
    assert.equal(server.calls.length, 1, "the scoped prompt reached ComfyUI once");
    const posted = JSON.parse(server.calls[0].options.body);
    assert.deepEqual(posted.partial_execution_targets, ["34"]);
    assert.deepEqual(posted.prompt["135:29"].inputs.model, ["135:3", 0]);
  } finally {
    stop();
  }
});

test("#572 restamp: the first graphToPrompt rematerialising 135:29 model is OUR dispatch", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const graph = { last_change_time: 1, _nodes: [] };
    let calls = 0;
    const app = {
      graph,
      rootGraph: graph,
      queueItems: [],
      posted: [],
      graphToPrompt: async () => {
        calls += 1;
        if (calls === 1) {
          graph.last_change_time = 2;
          return { output: structuredClone(STALE_OUTPUT), workflow: {} };
        }
        return { output: structuredClone(SETTLED_OUTPUT), workflow: {} };
      },
    };
    app.queuePrompt = queueFromPrompt(app, apiTarget);
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["34"], batch: 1, toNodeId: 34, verifyTimeoutMs: 500,
    });
    assert.equal(result.outcome, "dispatched", "a stale first serialization is restamped, not refused");
    assert.equal(server.calls.length, 1);
    assert.deepEqual(
      JSON.parse(server.calls[0].options.body).prompt["135:29"].inputs.model,
      ["135:3", 0],
    );
    assert.ok(calls >= 2, "the settled serialization was the one hashed");
  } finally {
    stop();
  }
});

test("#572 graph_changed retry: a stale stamp whose refused body already matches the idle canvas dispatches once", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    let calls = 0;
    const app = {
      graph: { _nodes: [] },
      queueItems: [],
      posted: [],
      graphToPrompt: async () => {
        calls += 1;
        return {
          output: structuredClone(calls === 1 ? STALE_OUTPUT : SETTLED_OUTPUT),
          workflow: {},
        };
      },
    };
    app.queuePrompt = queueFromPrompt(app, apiTarget);
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["34"], batch: 1, toNodeId: 34, verifyTimeoutMs: 500,
    });
    assert.equal(result.outcome, "dispatched", "the in-command restamp closes the false graph CHANGED");
    assert.equal(server.calls.length, 1, "the first drifted post never left; the settled one did");
    const posted = JSON.parse(server.calls[0].options.body);
    assert.deepEqual(posted.partial_execution_targets, ["34"]);
    assert.deepEqual(posted.prompt["135:29"].inputs.model, ["135:3", 0]);
    assert.equal(result.error, undefined);
  } finally {
    stop();
  }
});

test("#572 #556: a real nested-model rewire after the stamp still refuses and queues nothing", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = {
      graph: { _nodes: [] },
      queueItems: [],
      posted: [],
      graphToPrompt: async () => ({ output: structuredClone(SETTLED_OUTPUT), workflow: {} }),
      queuePrompt: async (number, _batch, arg) => {
        const targets = Array.isArray(arg) ? arg : arg?.queueNodeIds;
        const output = structuredClone(SETTLED_OUTPUT);
        output["135:29"].inputs.model = ["99", 0];
        const body = frontendBody({
          output, number, targets: targets?.length ? targets : null,
        });
        app.posted.push(body);
        await apiTarget.fetchApi(...promptPost(body));
        return true;
      },
    };
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["34"], batch: 1, toNodeId: 34, verifyTimeoutMs: 500,
    });
    assert.equal(result.outcome, "refused", "a genuine rewire is still drift");
    assert.match(result.error, /graph CHANGED/i);
    assert.match(result.error, /135:29 model/);
    assert.match(result.error, /Nothing was queued/);
    assert.match(result.error, /#556/);
    assert.equal(server.calls.length, 0, "the edited workflow never left the tab");
  } finally {
    stop();
  }
});

test("#572 #556: a sibling seed edit is still refused — settle does not license other drift", async () => {
  const stop = keepAlive();
  try {
    const server = makeServer();
    const apiTarget = { fetchApi: server };
    const app = {
      graph: { _nodes: [] },
      queueItems: [],
      posted: [],
      graphToPrompt: async () => ({ output: structuredClone(SETTLED_OUTPUT), workflow: {} }),
      queuePrompt: async (number, _batch, arg) => {
        const targets = Array.isArray(arg) ? arg : arg?.queueNodeIds;
        const output = structuredClone(SETTLED_OUTPUT);
        output["135:29"].inputs.seed = 99;
        const body = frontendBody({
          output, number, targets: targets?.length ? targets : null,
        });
        await apiTarget.fetchApi(...promptPost(body));
        return true;
      },
    };
    const result = await dispatchScopedRun({
      app, apiTarget, execIds: ["34"], batch: 1, toNodeId: 34, verifyTimeoutMs: 500,
    });
    assert.equal(result.outcome, "refused", "settle does not license a sibling user edit");
    assert.match(result.error, /graph CHANGED/i);
    assert.match(result.error, /135:29 seed/);
    assert.doesNotMatch(result.error, /135:29 model/);
    assert.equal(server.calls.length, 0);
  } finally {
    stop();
  }
});
