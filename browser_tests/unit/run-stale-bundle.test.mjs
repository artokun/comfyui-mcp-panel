/**
 * #2252 — panel_run must not accept a run on a stale live bundle.
 *
 * Reported: a tab running panel 0.15.173 while 0.15.174 was installed accepted
 * panel_run, then silently dropped dispatch. Scoped and full runs produced no
 * prompt_id; ComfyUI never logged got prompt. One scoped attempt created a
 * pending item that the guard correctly removed after no dispatch was observed.
 *
 * Unfixed: graph_run proceeds into queuePrompt / dispatchScopedRun and the
 * agent sees queued_unknown with no hard-refresh requirement.
 * Fixed: stale_bundle + Ctrl+Shift+R before any dispatch; pending-item removal
 * on an unverified scoped run is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  describeStaleBundleRefresh,
  describeStaleBundleRun,
  NODE_DEF_REFRESH_REASONS,
} from "../../web/js/lib/node-def-refresh.js";
import { cancelPendingScopedQueueItem, QUEUE_ITEM_TAG } from "../../web/js/lib/run-scope-guard.js";
import { makeCommandBudget } from "../../web/js/lib/command-budget.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");
const SCOPE_SRC = readFileSync(join(HERE, "../../web/js/lib/run-scope-guard.js"), "utf8").replace(/\r\n/g, "\n");

const runMatch = SRC.match(/\n {2}async graph_run\(\{ batch_count, to_node_id \}\) \{[\s\S]*?\n {2}\},/);
assert.ok(runMatch, "could not locate graph_run in panel source");

function extractFunction(marker) {
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1, `${marker} not found`);
  const open = SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    const ch = SRC[i];
    if (ch === "/" && SRC[i + 1] === "/") {
      i = SRC.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && SRC[i + 1] === "*") {
      i = SRC.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < SRC.length; i += 1) {
        if (SRC[i] === "\\") {
          i += 1;
          continue;
        }
        if (SRC[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unterminated function: ${marker}`);
}

function buildGraphRun(overrides = {}) {
  let begun = 0;
  let dispatchCalls = 0;
  let queueCalls = 0;
  let ctxCalls = 0;
  const stats = {
    get begun() {
      return begun;
    },
    get dispatchCalls() {
      return dispatchCalls;
    },
    get queueCalls() {
      return queueCalls;
    },
    get ctxCalls() {
      return ctxCalls;
    },
  };
  const graph = { _nodes: [] };
  const app = {
    graph,
    queuePrompt: async () => {
      queueCalls += 1;
      return true;
    },
  };
  const deps = {
    RUN_COMMAND_BUDGET_MS: 2000,
    RUN_SERIALIZE_TIMEOUT_MS: 500,
    makeCommandBudget,
    monotonicNow: () => 0,
    LOCAL_GRAPH_RUN_TOKEN: Symbol("local"),
    runReceiptSender: null,
    runReceiptRouteRef: () => null,
    runReceiptSessionRef: () => null,
    panelRunOwnerRef: { current: {} },
    runCompletionRef: {
      beginPanelRun() {
        begun += 1;
        return "tok";
      },
      endPanelRun() {},
    },
    armRunReconcileSweepRef: () => {},
    runDispatchIdentityRef: () => ({ routeReady: true }),
    captureRunDispatchIdentity: (x) => x,
    refuseStaleBundleRun: async () => null,
    getGraphCtx() {
      ctxCalls += 1;
      return { app, graph, rootGraph: graph };
    },
    assertGraphBoundToActiveWorkflow() {},
    dispatchScopedRun: async () => {
      dispatchCalls += 1;
      return { outcome: "unverified", error: "stub" };
    },
    ...overrides,
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const executors = {${runMatch[0]}};
     return executors.graph_run;`,
  );
  return { graph_run: factory(...names.map((n) => deps[n])), stats, app };
}

// ---------------------------------------------------------------------------
// Pure verdict
// ---------------------------------------------------------------------------

test("#2252 equal versions are not a stale-bundle run refusal", () => {
  assert.equal(describeStaleBundleRun({ running: "0.15.174", installed: "0.15.174" }), null);
});

test("#2252 a missing probe is unknown — fail open, never invent stale_bundle for panel_run", () => {
  assert.equal(describeStaleBundleRun({ running: "0.15.173", installed: null }), null);
  assert.equal(describeStaleBundleRun({ running: "0.15.173", installed: "" }), null);
  assert.equal(describeStaleBundleRun({ running: "", installed: "0.15.174" }), null);
  assert.equal(describeStaleBundleRun({}), null);
});

test("#2252 a version mismatch is queued:false stale_bundle with a Ctrl+Shift+R remedy", () => {
  const v = describeStaleBundleRun({ running: "0.15.173", installed: "0.15.174" });
  assert.equal(v.queued, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.STALE_BUNDLE);
  assert.equal(v.reason, "stale_bundle");
  assert.equal(v.running, "0.15.173");
  assert.equal(v.installed, "0.15.174");
  assert.match(v.remedy, /Ctrl\+Shift\+R/);
  assert.match(v.remedy, /0\.15\.173/);
  assert.match(v.remedy, /0\.15\.174/);
  assert.match(v.remedy, /Nothing was queued/);
  assert.match(v.remedy, /panel_run/);
  assert.equal(v.error, v.remedy);
  assert.equal("queued_unknown" in v, false, "must not reuse the silent-drop acknowledgement");
});

// ---------------------------------------------------------------------------
// SHIPPED refuseStaleBundleRun
// ---------------------------------------------------------------------------

test("#2252 SHIPPED refuseStaleBundleRun maps the installed-pack probe onto a run refusal", async () => {
  const refreshBody = extractFunction("async function refuseStaleBundleRefresh(");
  const runBody = extractFunction("async function refuseStaleBundleRun(");
  const factory = new Function(
    "api",
    "PANEL_VERSION",
    "describeStaleBundleRefresh",
    "describeStaleBundleRun",
    `${refreshBody}; ${runBody}; return refuseStaleBundleRun;`,
  );
  let versionRoute = 0;
  const stale = await factory(
    {
      fetchApi: async (route, init) => {
        versionRoute += 1;
        assert.equal(route, "/comfyui_mcp_panel/version");
        assert.equal(init?.cache, "no-store");
        return { ok: true, json: async () => ({ version: "0.15.174" }) };
      },
    },
    "0.15.173",
    describeStaleBundleRefresh,
    describeStaleBundleRun,
  )();
  assert.equal(versionRoute, 1);
  assert.equal(stale.queued, false);
  assert.equal(stale.reason, "stale_bundle");
  assert.equal(stale.running, "0.15.173");
  assert.equal(stale.installed, "0.15.174");
  assert.match(stale.error, /Ctrl\+Shift\+R/);
  assert.match(stale.error, /Nothing was queued/);
  assert.equal("queued_unknown" in stale, false);

  const current = await factory(
    { fetchApi: async () => ({ ok: true, json: async () => ({ version: "0.15.174" }) }) },
    "0.15.174",
    describeStaleBundleRefresh,
    describeStaleBundleRun,
  )();
  assert.equal(current, null, "equal versions fail open into the run");

  const unknown = await factory(
    { fetchApi: async () => ({ ok: false }) },
    "0.15.173",
    describeStaleBundleRefresh,
    describeStaleBundleRun,
  )();
  assert.equal(unknown, null, "an unreadable probe must not invent stale_bundle");
});

// ---------------------------------------------------------------------------
// SHIPPED graph_run — the command that was silently dropping dispatch
// ---------------------------------------------------------------------------

test("#2252 SHIPPED: a stale bundle refuses panel_run before dispatch", async () => {
  const staleVerdict = describeStaleBundleRun({ running: "0.15.173", installed: "0.15.174" });
  const { graph_run, stats } = buildGraphRun({
    refuseStaleBundleRun: async () => staleVerdict,
    getGraphCtx() {
      throw new Error("getGraphCtx must not run on a stale bundle");
    },
    dispatchScopedRun: async () => {
      throw new Error("dispatchScopedRun must not run on a stale bundle");
    },
  });

  const scoped = await graph_run({ to_node_id: 9 });
  assert.equal(scoped.queued, false);
  assert.equal(scoped.reason, "stale_bundle");
  assert.match(scoped.error, /Ctrl\+Shift\+R/);
  assert.match(scoped.error, /0\.15\.173/);
  assert.match(scoped.error, /0\.15\.174/);
  assert.equal(stats.begun, 0, "must not begin a panel_run hold");
  assert.equal(stats.dispatchCalls, 0, "must not enter scoped dispatch");
  assert.equal(stats.queueCalls, 0, "must not call queuePrompt");
  assert.equal(stats.ctxCalls, 0, "must not construct a prompt on a stale tab");

  const full = await graph_run({});
  assert.equal(full.queued, false);
  assert.equal(full.reason, "stale_bundle");
  assert.equal(stats.begun, 0);
  assert.equal(stats.queueCalls, 0);
});

test("#2252 SHIPPED: a current bundle still reaches the graph (fail-open on match)", async () => {
  let ctxCalls = 0;
  const { graph_run } = buildGraphRun({
    refuseStaleBundleRun: async () => null,
    getGraphCtx() {
      ctxCalls += 1;
      throw new Error("stop-after-ctx");
    },
  });
  await assert.rejects(() => graph_run({}), /stop-after-ctx/);
  assert.equal(ctxCalls, 1, "a current bundle must still enter the run path");
});

test("#2252 wiring: graph_run asks the stale-bundle gate before beginPanelRun and dispatch", () => {
  const body = runMatch[0];
  const gateAt = body.indexOf("refuseStaleBundleRun");
  const beginAt = body.indexOf("dispatchRunCompletion?.beginPanelRun");
  const queueAt = body.indexOf("app.queuePrompt");
  const dispatchAt = body.indexOf("dispatchScopedRun");
  assert.notEqual(gateAt, -1, "graph_run must consult refuseStaleBundleRun");
  assert.notEqual(beginAt, -1, "the panel_run hold is still taken for a live dispatch");
  assert.notEqual(queueAt, -1, "the full-run queue call is still present");
  assert.notEqual(dispatchAt, -1, "scoped dispatch is still present");
  assert.ok(gateAt < beginAt, "stale-bundle detection must run before beginPanelRun");
  assert.ok(gateAt < queueAt, "stale-bundle detection must run before queuePrompt");
  assert.ok(gateAt < dispatchAt, "stale-bundle detection must run before dispatchScopedRun");
});

// ---------------------------------------------------------------------------
// Pending-item removal must stay fail-closed (the report's correct half)
// ---------------------------------------------------------------------------

test("#2252 wiring: dispatchScopedRun still fail-closed-removes an unverified pending item", () => {
  const timeoutCancel = SCOPE_SRC.indexOf("const cancel = cancelPendingScopedQueueItem(app, { runTag, queueMark: mark });");
  assert.notEqual(
    timeoutCancel,
    -1,
    "the scoped timeout path must still splice THIS run's tagged pending item",
  );
  const graphRun = runMatch[0];
  assert.match(
    graphRun,
    /dispatchScopedRun\(/,
    "graph_run must still hand scoped runs to dispatchScopedRun (where the removal lives)",
  );
});

test("#2252 cancelPendingScopedQueueItem still removes only the tagged pending item", () => {
  const runTag = Symbol("ours");
  const ours = { number: 7, batchCount: 1, queueNodeIds: ["9"] };
  ours.queueNodeIds[QUEUE_ITEM_TAG] = runTag;
  const foreign = { number: 7, batchCount: 1, queueNodeIds: ["9"] };
  const app = { queueItems: [foreign, ours] };
  const res = cancelPendingScopedQueueItem(app, { runTag, queueMark: 7 });
  assert.equal(res.accessible, true);
  assert.equal(res.removed, 1);
  assert.equal(app.queueItems.length, 1);
  assert.equal(app.queueItems[0], foreign);
});
