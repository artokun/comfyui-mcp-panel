// panel#1192 — `graph_add_node`'s bounds are each defensible alone and do not compose.
//
// Serialized on one add they sum past the 30,000 ms window `panel_add_node` relays this
// command in, so the worst case was a bare `Panel tab … did not reply to "graph_add_node"
// within 30000 ms` — a message that names nothing and offers no remedy — instead of the
// worded, retryable refusal each of those bounds exists to produce.
//
// The term that dominates is the one a caller cannot shrink: `refresh(freshDefs)` goes
// through `makeRefreshCoalescer`, which waits for any in-flight run before starting its own.
// On the scenario this add is most likely to meet — a ComfyUI restart, which is exactly when
// a reconnect-triggered refresh is already running — that wait is on a run that ALREADY
// STARTED under someone else's deadline.
//
// THE HARNESS runs the SHIPPED `graph_add_node` body, extracted from the panel source and
// given injected collaborators, and wires the REAL coalescer to a REAL in-flight run — the
// same technique as add-node-socket-proof-scope.test.mjs. A helper-level test cannot reach
// this defect: `makeCommandBudget` and `makeRefreshCoalescer` are individually correct, and
// the bug lives entirely in whether the call site threads one into the other.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { makeRefreshCoalescer, REFRESH_JOIN_ABANDONED } from "../../web/js/lib/refresh-coalesce.js";
import { makeCommandBudget } from "../../web/js/lib/command-budget.js";
import {
  applyCurrentDefWidgetValues,
  driftedRequiredInputNames,
  missingRequiredWidgetMaterializations,
  registeredSocketTypes,
  unavailableRequiredWidgetMessage,
  unavailableRequiredWidgetReport,
} from "../../web/js/lib/node-widget-materialization.js";
import {
  assertAddNodeResolvableRefreshing,
  isRegisteredNodeType,
} from "../../web/js/lib/node-resolve.js";
import { fetchSingleNodeDef } from "../../web/js/lib/single-node-def.js";
import {
  describeUnmaterializedRequiredWidgets,
  snapshotBackendDef,
} from "../../web/js/lib/add-node-widget-guard.js";
import {
  NODE_DEFS_FETCH_TIMEOUT_MS,
  NODE_DEFS_NO_ANSWER,
  WIDEN_SOCKET_PROOF_TIMEOUT_MS,
  monotonicNow,
  widenSocketProofBudget,
} from "./_panel-constants.mjs";
import { clearInheritedExecutionPreview } from "../../web/js/lib/execution-preview-attach.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const addNodeMatch = panelSrc.match(
  /\n {2}async graph_add_node\(\{ class_type, pos, title \}\) \{[\s\S]*?\n {2}\},/,
);
assert.ok(addNodeMatch, "could not locate graph_add_node in panel source");

const awaitWidgetsMatch = panelSrc.match(
  /\nasync function awaitRequiredCustomWidgetRegistration\([\s\S]*?\n\}/,
);
assert.ok(awaitWidgetsMatch, "could not locate awaitRequiredCustomWidgetRegistration");

const placementMatch = panelSrc.match(/\nfunction placementFor\(graph, pos\) \{[\s\S]*?\n\}/);
assert.ok(placementMatch, "could not locate placementFor");

const boundedMatch = panelSrc.match(/\nasync function boundedGetNodeDefs\([\s\S]*?\n\}/);
assert.ok(boundedMatch, "could not locate boundedGetNodeDefs in panel source");

// The SHIPPED refusal, built from source rather than restated. A hand-copied sentence here
// would let the real one drift into naming a remedy that cannot work while this file stayed
// green — which is the failure mode the message itself exists to prevent.
const busyMatch = panelSrc.match(/const addNodeRefreshBusyMessage = [\s\S]*?;\r?\n/);
assert.ok(busyMatch, "could not locate addNodeRefreshBusyMessage in panel source");
const addNodeRefreshBusyMessage = new Function(
  "ADD_NODE_COMMAND_BUDGET_MS",
  `${busyMatch[0]}
   return addNodeRefreshBusyMessage;`,
)(25000);

/** A tiny deferred so a test can hold the in-flight refresh open until it chooses. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The backend's schema. `NewNode` is the freshly installed class the add is asking for. */
function backendObjectInfo() {
  return {
    ExistingNode: {
      name: "ExistingNode",
      input: { required: { seed: ["INT", { default: 0, min: 0, max: 10 }] } },
      output: ["IMAGE"],
    },
    NewNode: {
      name: "NewNode",
      input: { required: { count: ["INT", { default: 1, min: 0, max: 8 }] } },
      output: ["IMAGE"],
    },
  };
}

function makeComfy() {
  const widgets = {
    INT(node, name, spec) {
      const w = { name, type: "number", value: spec?.[1]?.default ?? 0, options: spec?.[1] ?? {} };
      node.widgets.push(w);
      return { widget: w };
    },
  };
  const graph = {
    _nodes: [],
    add(n) {
      n.id = this._nodes.length + 1;
      this._nodes.push(n);
    },
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
  };
  const LG = {
    registered_node_types: {},
    createNode(type) {
      const nodeData = LG.registered_node_types[type]?.nodeData;
      if (!nodeData) return null;
      const node = { type, title: type, pos: [0, 0], size: [200, 100], widgets: [], inputs: [] };
      for (const [name, spec] of Object.entries(nodeData.input?.required ?? {})) {
        const ctor = widgets[String(spec?.[0])];
        if (ctor) ctor(node, name, spec);
        else node.inputs.push({ name, type: spec?.[0] });
      }
      return node;
    },
  };
  const app = {
    graph,
    widgets,
    registerNodesFromDefs(defs) {
      for (const [type, nodeData] of Object.entries(defs ?? {})) {
        LG.registered_node_types[type] = { nodeData, comfyClass: type };
      }
    },
  };
  return { app, LG, graph, widgets };
}

/**
 * Build the SHIPPED `graph_add_node` with the REAL coalescer behind it.
 *
 * `budgetMs`/`reserveMs` are injected small so these tests run in milliseconds rather than
 * waiting out the shipped 25s. Same code, same arithmetic, shorter deadline — the shipped
 * NUMBERS are pinned separately, against the relay window, in single-node-def.test.mjs.
 */
function realGraphAddNode({
  comfy,
  getNodeDefs,
  // A promise the PAYLOAD-LESS (reconnect) run waits on before it registers anything, or
  // null for "no refresh is in flight". Held open, it is the reported scenario: a ComfyUI
  // restart, whose reconnect refresh is still running when the add arrives.
  holdInFlight = null,
  budgetMs = 400,
  reserveMs = 120,
  registrationMs = 200,
  overrides = {},
} = {}) {
  const c = comfy ?? makeComfy();
  const { app, LG, graph } = c;
  const context = { app, LG, graph, rootGraph: graph, workflow: { uuid: "wf" } };

  const api = {
    getNodeDefs: getNodeDefs ?? (async () => backendObjectInfo()),
    async fetchApi(route) {
      const cls = decodeURIComponent(String(route).replace("/object_info/", ""));
      const all = backendObjectInfo();
      const body = Object.prototype.hasOwnProperty.call(all, cls) ? { [cls]: all[cls] } : {};
      return { status: 200, json: async () => body };
    },
  };

  // The REAL single-flight coordinator, over a real slot, with a real in-flight run when the
  // test supplies one. Stubbing this away would remove the term the whole issue is about.
  let inFlight = null;
  const runs = [];
  const refreshComfyNodeDefs = makeRefreshCoalescer({
    getInFlight: () => inFlight,
    setInFlight: (p) => {
      inFlight = p;
    },
    runRegister: async (defs) => {
      runs.push(defs);
      // The reconnect run — the one with no payload — is the one a test can hold open.
      if (defs == null && holdInFlight) await holdInFlight;
      app.registerNodesFromDefs(defs ?? (await api.getNodeDefs()));
      return true;
    },
    withTimeout,
  });
  // A refresh someone else started — a websocket reconnect, a finished install — already
  // holding the slot when the add arrives.
  const inFlightStarted = holdInFlight ? refreshComfyNodeDefs(undefined) : null;

  const deps = {
    captureGraphMutationContext: () => context,
    revalidateGraphMutationContext: () => context,
    getGraphCtx: () => context,
    app,
    awaitObjectInfoHistorySeed: async () => {},
    recordObjectInfoTypes: (defs) => defs,
    objectInfoHistory: { wasTypeEverDefined: () => false },
    objectInfoSnapshot: { record: () => true, clear: () => {} },
    backendReconnectEpoch: 0,
    readPackImportFailures: async () => [],
    api,
    refreshComfyNodeDefs,
    summarizeNode: (node) => ({ id: node.id, type: node.type }),
    assertAddNodeResolvableRefreshing,
    driftedRequiredInputNames,
    registeredSocketTypes,
    missingRequiredWidgetMaterializations,
    applyCurrentDefWidgetValues,
    unavailableRequiredWidgetReport,
    unavailableRequiredWidgetMessage,
    snapshotBackendDef,
    isRegisteredNodeType,
    fetchSingleNodeDef,
    describeUnmaterializedRequiredWidgets,
    NODE_DEFS_NO_ANSWER,
    WIDEN_SOCKET_PROOF_TIMEOUT_MS,
    widenSocketProofBudget,
    monotonicNow,
    NODE_DEFS_FETCH_TIMEOUT_MS,
    withTimeout,
    makeCommandBudget,
    REFRESH_JOIN_ABANDONED,
    addNodeRefreshBusyMessage,
    clearInheritedExecutionPreview,
    OBJECT_INFO_SEED_WAIT_MS: 8000,
    ADD_NODE_COMMAND_BUDGET_MS: budgetMs,
    ADD_NODE_POST_REFRESH_RESERVE_MS: reserveMs,
    ...overrides,
  };

  if (!("boundedGetNodeDefs" in deps)) {
    const build = new Function(
      "api",
      "withTimeout",
      "NODE_DEFS_NO_ANSWER",
      "NODE_DEFS_FETCH_TIMEOUT_MS",
      `${boundedMatch[0]}
       return boundedGetNodeDefs;`,
    );
    deps.boundedGetNodeDefs = (timeoutMs) =>
      build(deps.api, withTimeout, NODE_DEFS_NO_ANSWER, NODE_DEFS_FETCH_TIMEOUT_MS)(timeoutMs);
  }

  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `${awaitWidgetsMatch[0]}
     ${placementMatch[0]}
     const CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS = ${registrationMs};
     const CUSTOM_WIDGET_REGISTRATION_POLL_MS = 5;
     const executors = {${addNodeMatch[0]}};
     return executors.graph_add_node;`,
  );
  return {
    graph_add_node: factory(...names.map((n) => deps[n])),
    comfy: c,
    runs,
    inFlightStarted,
  };
}

// ---------------------------------------------------------------------------
// 1. The reported composition: the join alone would exhaust the command.
// ---------------------------------------------------------------------------

test("#1192: an add refuses IN WORDS when the in-flight refresh would eat the whole budget", async () => {
  // Held open, so the add's `refresh(freshDefs)` genuinely waits on a run it did not start
  // and cannot shorten — the term the whole issue is about, exercised through the real
  // coalescer rather than modelled.
  const gate = deferred();
  const comfy = makeComfy();
  const built = realGraphAddNode({
    comfy,
    holdInFlight: gate.promise,
    budgetMs: 400,
    reserveMs: 120,
  });

  const started = Date.now();
  await assert.rejects(
    () => built.graph_add_node({ class_type: "NewNode" }),
    (err) => {
      // The SHIPPED wording, not a paraphrase.
      assert.equal(err.message, addNodeRefreshBusyMessage("NewNode"));
      return true;
    },
    "an add whose budget went on someone else's refresh must refuse, in words",
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `refused in ${elapsed}ms — it must give up at the bound, not wait the run out`);

  // NOTHING was added. The alternative to refusing is adding a node whose class may not be
  // registered, which is #458's fabricated placeholder.
  assert.equal(comfy.graph._nodes.length, 0, "the graph was not touched");

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
});

test("#1192: the refusal names a remedy that WORKS — retry, not a tab reload", async () => {
  // #663/#852: a refusal that sends the caller to the wrong recovery costs more than the
  // refusal itself. The resolver's own message here is "the node-def refresh failed — reload
  // the ComfyUI tab", which is wrong twice over: the refresh did not fail, and reloading
  // throws away the user's canvas state for a condition that clears on its own.
  const msg = addNodeRefreshBusyMessage("NewNode");
  assert.match(msg, /NOTHING WAS ADDED/, "the caller must know the graph is untouched before it retries");
  assert.match(msg, /RETRY/, "…and that a retry is the remedy");
  assert.ok(!/reload/i.test(msg), "…and must not be told to reload the tab");
  assert.match(msg, /panel_refresh_nodes/, "…with a concrete escalation if retrying keeps failing");
});

test("#1192: the abandoned add does NOT start a competing registration run", async () => {
  // Two concurrent registerNodesFromDefs passes are the stampede makeRefreshCoalescer exists
  // to prevent. A caller that has just given up waiting for one is the last thing that
  // should launch a second — so the fresh payload is DROPPED, which is safe only because the
  // caller refuses rather than claiming success. (#289 P2 forbids dropping a payload while
  // reporting success, not dropping one while refusing.)
  const gate = deferred();
  const comfy = makeComfy();
  const built = realGraphAddNode({ comfy, holdInFlight: gate.promise, budgetMs: 400, reserveMs: 120 });

  await built.graph_add_node({ class_type: "NewNode" }).catch(() => {});
  assert.deepEqual(built.runs, [undefined], "only the in-flight reconnect run ever started");

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
});

// ---------------------------------------------------------------------------
// 2. The healthy paths, which the bound must not narrow.
// ---------------------------------------------------------------------------

test("#1192: an in-flight refresh that lands in time still lets the add through", async () => {
  // The bound must not become a way to refuse adds on a machine doing nothing wrong. This is
  // what the reported scenario actually hits most of the time.
  const comfy = makeComfy();
  const landing = sleep(20); // the reconnect run finishes well inside the add's join budget
  const built = realGraphAddNode({ comfy, holdInFlight: landing, budgetMs: 4000, reserveMs: 120 });

  const { added } = await built.graph_add_node({ class_type: "NewNode" });
  assert.equal(added.type, "NewNode", "the add succeeded");
  assert.equal(comfy.graph._nodes.length, 1);
  await built.inFlightStarted;
});

test("#1192: with NO refresh in flight the add pays nothing for the join at all", async () => {
  const comfy = makeComfy();
  const built = realGraphAddNode({ comfy, budgetMs: 4000 });
  const started = Date.now();
  const { added } = await built.graph_add_node({ class_type: "NewNode" });
  assert.equal(added.type, "NewNode");
  assert.ok(Date.now() - started < 500, "a healthy add is not slowed by a bound it never reaches");
});

test("#1192: an ALREADY-registered class takes the fast path and never reaches the refresh", async () => {
  // #780's saving, preserved: the budget must not have made the cheap path pay for the
  // expensive one's protection.
  const comfy = makeComfy();
  comfy.app.registerNodesFromDefs({ ExistingNode: backendObjectInfo().ExistingNode });
  let wholeReads = 0;
  const built = realGraphAddNode({
    comfy,
    budgetMs: 4000,
    getNodeDefs: async () => {
      wholeReads += 1;
      return backendObjectInfo();
    },
  });
  const { added } = await built.graph_add_node({ class_type: "ExistingNode" });
  assert.equal(added.type, "ExistingNode");
  assert.equal(wholeReads, 0, "the whole schema was never re-downloaded");
  assert.deepEqual(built.runs, [], "…and no refresh run was needed");
});

// ---------------------------------------------------------------------------
// 3. The budget reaches the LAST step too, and says so when it does.
// ---------------------------------------------------------------------------

test("#1192: a /object_info read that eats the budget leaves the add a bound, not a hang", async () => {
  // The whole-schema fetch draws `budget.bounded(NODE_DEFS_FETCH_TIMEOUT_MS)`. With the
  // command nearly spent that is a small number, and the add fails closed on the path an
  // unreadable schema already takes — rather than parking on a 10s bound the command cannot
  // afford.
  const comfy = makeComfy();
  const built = realGraphAddNode({
    comfy,
    budgetMs: 200,
    getNodeDefs: () => new Promise(() => {}), // half-open: never answers, never fails
  });
  const started = Date.now();
  await assert.rejects(
    () => built.graph_add_node({ class_type: "NewNode" }),
    /object_info is unavailable|cannot verify node type/,
    "a schema that never answers must produce the unreadable-schema refusal",
  );
  assert.ok(Date.now() - started < 3000, "…at the command's bound, not at the standalone 10s one");
});

test("#1192: a registration wait cut short by the budget SAYS it was, and says retry first", async () => {
  // The message this wait throws tells the user to reload the tab and that "retrying alone
  // will not fix it" — right for an extension that failed to load, and exactly wrong for a
  // wait that was cut short by a command already running late, where a retry gets the full
  // window. Without the note, the budget would manufacture a confident wrong diagnosis.
  const comfy = makeComfy();
  // A required input whose declared type has no registered widget and no installed producer:
  // the guard waits for a constructor that will never appear.
  const schema = {
    NewNode: {
      name: "NewNode",
      input: { required: { thing: ["MYSTERY_T", { default: 1 }] } },
      output: ["IMAGE"],
    },
  };
  const built = realGraphAddNode({
    comfy,
    budgetMs: 260,
    reserveMs: 0,
    // 400, not 200: the wait must end at the BUDGET's remainder (~60ms after the fetch), so
    // the standalone timeout has to sit far enough past it that a wait which ignores the
    // budget and takes its full window is unambiguously late — 180ms of fetch plus 400ms of
    // wait is more than double the whole command.
    registrationMs: 400,
    getNodeDefs: async () => {
      await sleep(180); // most of the command spent before the wait even begins
      return schema;
    },
  });

  const started = Date.now();
  await assert.rejects(
    () => built.graph_add_node({ class_type: "NewNode" }),
    (err) => {
      assert.match(err.message, /had no widget after/, "…still the #695 report, with its causes");
      assert.match(err.message, /this wait was cut short/, "the truncation must be disclosed");
      assert.match(err.message, /RETRY FIRST/, "…and the retry must outrank the reload advice");
      return true;
    },
  );
  // The MESSAGE assertions above pass even when the wait ignores the budget it was handed —
  // `cutShort` is computed from the same `wait` the mutation bypasses — so the truncation
  // itself is asserted on the clock: the refusal must land near the budget's remainder, not
  // after the wait's full standalone window. A wait that took its own 400ms after a 180ms
  // fetch has spent more than two command budgets.
  assert.ok(
    Date.now() - started < 400,
    "the wait must end at the budget's remainder, not run out its full standalone window",
  );
});

test("#1192: a registration wait that got its FULL window says nothing about a budget", async () => {
  // The note must not appear on a wait that was not truncated — a disclosure that fires
  // every time is one nobody reads, and it would send a genuine extension failure chasing a
  // budget that was never the cause.
  const comfy = makeComfy();
  const schema = {
    NewNode: {
      name: "NewNode",
      input: { required: { thing: ["MYSTERY_T", { default: 1 }] } },
      output: ["IMAGE"],
    },
  };
  const built = realGraphAddNode({
    comfy,
    budgetMs: 8000,
    registrationMs: 120,
    getNodeDefs: async () => schema,
  });

  await assert.rejects(
    () => built.graph_add_node({ class_type: "NewNode" }),
    (err) => {
      assert.match(err.message, /had no widget after/);
      assert.ok(!/cut short/.test(err.message), "an untruncated wait must not claim a budget cut it");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 4. The whole point: the command lands inside its window.
// ---------------------------------------------------------------------------

test("#1192: every step stalling at once still replies inside the command budget", async () => {
  // The composition, end to end. Before this fix each of these stalls took its own full
  // bound and they ADDED — ~41s against a 30s relay window — so the reply never left the
  // tab. Now they draw on one deadline, so the command reports SOMETHING in time, which is
  // the property the relay actually needs.
  const comfy = makeComfy();
  const gate = deferred(); // the reconnect run never lands
  const BUDGET_MS = 500;
  const built = realGraphAddNode({
    comfy,
    holdInFlight: gate.promise,
    budgetMs: BUDGET_MS,
    reserveMs: 100,
    registrationMs: 200,
    getNodeDefs: async () => {
      await sleep(150);
      return backendObjectInfo();
    },
    overrides: {
      // A baseline seed that never settles on its own: bounded at the command's remainder,
      // so it costs what the command can afford and no more.
      awaitObjectInfoHistorySeed: (waitMs) =>
        new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(waitMs ?? 8000, 8000)))),
    },
  });

  const started = Date.now();
  const outcome = await built.graph_add_node({ class_type: "NewNode" }).then(
    (v) => ({ ok: v }),
    (err) => ({ err }),
  );
  const elapsed = Date.now() - started;

  assert.ok(outcome.err, "with every step stalled the add must refuse rather than succeed");
  // Generous against the budget, because the unbounded local work this deliberately cannot
  // interrupt is real and the CI box is shared. The number that matters is that it is a
  // small multiple of the budget rather than the ~41s sum of the individual bounds.
  assert.ok(
    elapsed < BUDGET_MS * 6,
    `the add took ${elapsed}ms against a ${BUDGET_MS}ms budget — the bounds are adding again`,
  );

  gate.resolve();
  await built.inFlightStarted?.catch(() => {});
});
