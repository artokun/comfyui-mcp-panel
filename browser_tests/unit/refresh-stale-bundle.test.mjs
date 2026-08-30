/**
 * #2027 — panel_refresh_nodes must not clear last-known schema on a stale bundle.
 *
 * Reported: the live tab ran panel 0.15.123 while the installed pack was 0.15.124.
 * On a large custom-node install, panel_refresh_nodes returned object_info_fetch_failed
 * and cleared the last-known schema. The next panel_set_widget saw /models/checkpoints
 * listing the new file while the stale /object_info combo still exposed only four old
 * options. The on-disk pack already had the large-refresh budget; the open tab did not.
 *
 * These tests drive the SHIPPED registerComfyNodeDefs (the function that retires schema)
 * and the shipped refresh_nodes executor. Unfixed: a version mismatch still attempts
 * the refresh and fences/clears the snapshot, answering refreshed:false without
 * stale_bundle. Fixed: stale_bundle + Ctrl+Shift+R, schema left untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  describeStaleBundleRefresh,
  NODE_DEF_REFRESH_REASONS,
  describeNodeDefRefresh,
} from "../../web/js/lib/node-def-refresh.js";
import { comboRebuildCovered } from "../../web/js/lib/asset-staleness.js";
import { fetchNodeDefsWithRetry, OBJECT_INFO_RETRY_DELAYS_MS } from "../../web/js/lib/object-info-retry.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";
import { fetchWholeObjectInfo, TRANSPORT_OUTCOME } from "../../web/js/lib/object-info-oracle.js";
import { createObjectInfoSnapshot } from "../../web/js/lib/object-info-snapshot.js";
import { createObjectInfoCache } from "../../web/js/lib/object-info-cache.js";
import { createVerifiedNodeDefCache } from "../../web/js/lib/verified-node-def-cache.js";
import {
  COMBO_NO_ANSWER,
  COMBO_OK,
  NODE_DEFS_FETCH_SHARE,
  NODE_DEFS_FETCH_TIMEOUT_MS,
  NODE_DEFS_NO_ANSWER,
  NODE_DEFS_RUN_BUDGET_MS,
  REFRESH_NODES_EXECUTOR_DEPS,
  monotonicNow,
  nodeDefsBudgetLeft,
} from "./_panel-constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");

const SCHEMA = { CheckpointLoaderSimple: { input: { required: { ckpt_name: ["COMBO", { options: ["old.safetensors"] }] } } } };
const SILENCE = [
  { route: "client", kind: TRANSPORT_OUTCOME.NO_ANSWER },
  { route: "http", kind: TRANSPORT_OUTCOME.NO_ANSWER },
];
const EPOCH = 7;

function stored(snap, defs = SCHEMA, epoch = EPOCH, generation = 0) {
  return snap.record(defs, {
    observedAtEpoch: epoch,
    currentEpoch: epoch,
    observedAtGeneration: generation,
    currentGeneration: generation,
    whole: true,
  });
}

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

function buildRegisterComfyNodeDefs({
  apiValue,
  objectInfoSnapshot,
  verifiedNodeDefCache = createVerifiedNodeDefCache(),
  objectInfoCache = createObjectInfoCache(),
  refuseStaleBundleRefresh = async () => null,
} = {}) {
  const body = extractFunction("async function registerComfyNodeDefs(");
  const factory = new Function(
    "app",
    "api",
    "recordObjectInfoTypes",
    "reapplyDefsToLiveNodes",
    "comboRebuildCovered",
    "describeNodeDefRefresh",
    "NODE_DEF_REFRESH_REASONS",
    "fetchNodeDefsWithRetry",
    "withTimeout",
    "NODE_DEFS_NO_ANSWER",
    "COMBO_OK",
    "COMBO_NO_ANSWER",
    "NODE_DEFS_FETCH_TIMEOUT_MS",
    "NODE_DEFS_RUN_BUDGET_MS",
    "NODE_DEFS_FETCH_SHARE",
    "fetchWholeObjectInfo",
    "nodeDefsBudgetLeft",
    "monotonicNow",
    "NODE_DEFS_RETRY_DELAYS_MS",
    "objectInfoCache",
    "objectInfoSnapshot",
    "verifiedNodeDefCache",
    "initialBackendReconnectEpoch",
    "comfyBackendSocketDown",
    "TRANSPORT_OUTCOME",
    "refuseStaleBundleRefresh",
    `const boundedGetNodeDefs = async (ms = NODE_DEFS_FETCH_TIMEOUT_MS) => {
       if (typeof api?.getNodeDefs !== "function") return null;
       const settled = await withTimeout(
         Promise.resolve().then(() => api.getNodeDefs()).then((value) => ({ value }), (err) => ({ err })),
         ms,
         () => NODE_DEFS_NO_ANSWER,
       );
       if (settled === NODE_DEFS_NO_ANSWER) return NODE_DEFS_NO_ANSWER;
       if ("err" in settled) throw settled.err;
       return settled.value;
     };
     let backendReconnectEpoch = initialBackendReconnectEpoch;
     let nodeDefsRefreshConfirmed = false;
     ${body}
     return { registerComfyNodeDefs };`,
  );
  return factory(
    { graph: null, registerNodesFromDefs: async () => {}, refreshComboInNodes: async () => {} },
    apiValue,
    () => ({}),
    () => {},
    comboRebuildCovered,
    describeNodeDefRefresh,
    NODE_DEF_REFRESH_REASONS,
    (getDefs, opts) => fetchNodeDefsWithRetry(getDefs, { ...opts, sleep: async () => {} }),
    withTimeout,
    NODE_DEFS_NO_ANSWER,
    COMBO_OK,
    COMBO_NO_ANSWER,
    NODE_DEFS_FETCH_TIMEOUT_MS,
    NODE_DEFS_RUN_BUDGET_MS,
    NODE_DEFS_FETCH_SHARE,
    fetchWholeObjectInfo,
    nodeDefsBudgetLeft,
    monotonicNow,
    OBJECT_INFO_RETRY_DELAYS_MS,
    objectInfoCache,
    objectInfoSnapshot,
    verifiedNodeDefCache,
    EPOCH,
    false,
    TRANSPORT_OUTCOME,
    refuseStaleBundleRefresh,
  );
}

function buildRefreshNodes(refreshImpl, extra = {}) {
  const start = SRC.indexOf("async refresh_nodes()");
  assert.notEqual(start, -1, "refresh_nodes executor not found");
  const open = SRC.indexOf("{", start);
  let depth = 0;
  let end = -1;
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
    if (ch === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  assert.notEqual(end, -1, "could not bound the refresh_nodes executor body");
  const body = SRC.slice(start, end + 1);
  const deps = { ...REFRESH_NODES_EXECUTOR_DEPS, ...extra };
  const extraEntries = Object.entries(deps);
  const factory = new Function(
    "refreshComfyNodeDefs",
    ...extraEntries.map(([name]) => name),
    `return (${body.replace(/^async refresh_nodes\(\)/, "async function refresh_nodes()")});`,
  );
  return factory(refreshImpl, ...extraEntries.map(([, value]) => value));
}

function wrapSnapshot(snapshot) {
  let beginReplacementCalls = 0;
  let clearCalls = 0;
  const originalBegin = snapshot.beginReplacement.bind(snapshot);
  const originalClear = snapshot.clear.bind(snapshot);
  snapshot.beginReplacement = () => {
    beginReplacementCalls += 1;
    return originalBegin();
  };
  snapshot.clear = () => {
    clearCalls += 1;
    return originalClear();
  };
  return {
    snapshot,
    get beginReplacementCalls() {
      return beginReplacementCalls;
    },
    get clearCalls() {
      return clearCalls;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure verdict
// ---------------------------------------------------------------------------

test("#2027 equal versions are not a stale-bundle refusal", () => {
  assert.equal(describeStaleBundleRefresh({ running: "0.15.124", installed: "0.15.124" }), null);
});

test("#2027 a missing probe is unknown — fail open, never invent stale_bundle", () => {
  assert.equal(describeStaleBundleRefresh({ running: "0.15.123", installed: null }), null);
  assert.equal(describeStaleBundleRefresh({ running: "0.15.123", installed: "" }), null);
  assert.equal(describeStaleBundleRefresh({ running: "", installed: "0.15.124" }), null);
  assert.equal(describeStaleBundleRefresh({}), null);
});

test("#2027 a version mismatch is stale_bundle with a Ctrl+Shift+R remedy", () => {
  const v = describeStaleBundleRefresh({ running: "0.15.123", installed: "0.15.124" });
  assert.equal(v.refreshed, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.STALE_BUNDLE);
  assert.equal(v.reason, "stale_bundle");
  assert.equal(v.running, "0.15.123");
  assert.equal(v.installed, "0.15.124");
  assert.match(v.remedy, /Ctrl\+Shift\+R/);
  assert.match(v.remedy, /0\.15\.123/);
  assert.match(v.remedy, /0\.15\.124/);
  assert.match(v.remedy, /last-known schema was left unchanged/i);
});

// ---------------------------------------------------------------------------
// SHIPPED registerComfyNodeDefs — the function that would otherwise clear schema
// ---------------------------------------------------------------------------

test("#2027 SHIPPED: a stale bundle returns stale_bundle and preserves last-known schema", async () => {
  const snapshot = createObjectInfoSnapshot();
  const verifiedNodeDefCache = createVerifiedNodeDefCache();
  assert.equal(stored(snapshot), true);
  const wrapped = wrapSnapshot(snapshot);
  const generationBefore = verifiedNodeDefCache.generation();
  let fetchCalls = 0;
  const staleVerdict = describeStaleBundleRefresh({ running: "0.15.123", installed: "0.15.124" });
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    objectInfoSnapshot: snapshot,
    verifiedNodeDefCache,
    refuseStaleBundleRefresh: async () => staleVerdict,
    apiValue: {
      getNodeDefs: async () => {
        fetchCalls += 1;
        throw new Error("Failed to fetch");
      },
    },
  });

  const verdict = await registerComfyNodeDefs(undefined);

  assert.equal(verdict.refreshed, false);
  assert.equal(verdict.reason, "stale_bundle", "must not report object_info_fetch_failed over a stale tab");
  assert.match(verdict.remedy, /Ctrl\+Shift\+R/);
  assert.equal(fetchCalls, 0, "must not attempt the large /object_info refresh");
  assert.equal(wrapped.beginReplacementCalls, 0, "must not fence the last-known schema");
  assert.equal(wrapped.clearCalls, 0, "must not clear the last-known schema");
  assert.equal(verifiedNodeDefCache.generation(), generationBefore, "must not retire per-class proof");
  const fallback = snapshot.authorize({
    epoch: EPOCH,
    generation: generationBefore,
    socketDown: false,
    outcomes: SILENCE,
  });
  assert.ok(fallback.defs?.CheckpointLoaderSimple, "the last-known schema remains usable for the next widget write");
});

test("#2027 SHIPPED: a current bundle still attempts refresh (fail-open on match)", async () => {
  const snapshot = createObjectInfoSnapshot();
  stored(snapshot);
  const wrapped = wrapSnapshot(snapshot);
  let fetchCalls = 0;
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    objectInfoSnapshot: snapshot,
    refuseStaleBundleRefresh: async () => null,
    apiValue: {
      getNodeDefs: async () => {
        fetchCalls += 1;
        throw new Error("Failed to fetch");
      },
    },
  });

  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(fetchCalls > 0, true, "a current bundle still fetches");
  assert.notEqual(verdict.reason, "stale_bundle");
  assert.equal(verdict.refreshed, false);
  assert.ok(wrapped.beginReplacementCalls > 0, "a current-bundle refresh still fences while it runs");
});

test("#2027 SHIPPED refuseStaleBundleRefresh compares PANEL_VERSION to the installed marker", async () => {
  const body = extractFunction("async function refuseStaleBundleRefresh(");
  const factory = new Function(
    "api",
    "PANEL_VERSION",
    "describeStaleBundleRefresh",
    `${body}; return refuseStaleBundleRefresh;`,
  );
  let versionRoute = 0;
  const probe = factory(
    {
      fetchApi: async (route, init) => {
        versionRoute += 1;
        assert.equal(route, "/comfyui_mcp_panel/version");
        assert.equal(init?.cache, "no-store");
        return { ok: true, json: async () => ({ version: "0.15.124" }) };
      },
    },
    "0.15.123",
    describeStaleBundleRefresh,
  );
  const stale = await probe();
  assert.equal(versionRoute, 1);
  assert.equal(stale.reason, "stale_bundle");
  assert.equal(stale.running, "0.15.123");
  assert.equal(stale.installed, "0.15.124");
  assert.match(stale.remedy, /Ctrl\+Shift\+R/);

  const current = await factory(
    { fetchApi: async () => ({ ok: true, json: async () => ({ version: "0.15.124" }) }) },
    "0.15.124",
    describeStaleBundleRefresh,
  )();
  assert.equal(current, null, "equal versions fail open into the refresh");

  const unknown = await factory(
    { fetchApi: async () => ({ ok: false }) },
    "0.15.123",
    describeStaleBundleRefresh,
  )();
  assert.equal(unknown, null, "an unreadable probe must not invent stale_bundle");
});

test("#2027 wiring: registerComfyNodeDefs asks the stale-bundle gate before beginReplacement", () => {
  const body = extractFunction("async function registerComfyNodeDefs(");
  const gateAt = body.indexOf("refuseStaleBundleRefresh");
  const fenceAt = body.indexOf("objectInfoSnapshot.beginReplacement");
  assert.notEqual(gateAt, -1, "the shipped refresh must consult refuseStaleBundleRefresh");
  assert.notEqual(fenceAt, -1, "the schema fence is still the start-of-run effect");
  assert.ok(gateAt < fenceAt, "stale-bundle detection must run before the last-known schema is fenced");
});

// ---------------------------------------------------------------------------
// SHIPPED refresh_nodes — the command reply the agent actually reads
// ---------------------------------------------------------------------------

test("#2027 SHIPPED: refresh_nodes forwards stale_bundle instead of object_info_fetch_failed", async () => {
  const snapshot = createObjectInfoSnapshot();
  stored(snapshot);
  const wrapped = wrapSnapshot(snapshot);
  const refresh_nodes = buildRefreshNodes(async () =>
    describeStaleBundleRefresh({ running: "0.15.123", installed: "0.15.124" }),
  );

  const reply = await refresh_nodes();
  assert.equal(reply.ok, true);
  assert.equal(reply.refreshed, false);
  assert.equal(reply.reason, "stale_bundle");
  assert.match(reply.remedy, /Ctrl\+Shift\+R/);
  assert.equal(wrapped.clearCalls, 0, "forwarding the verdict must not clear last-known schema");
  assert.ok(
    snapshot.authorize({ epoch: EPOCH, generation: 0, socketDown: false, outcomes: SILENCE }).defs
      ?.CheckpointLoaderSimple,
  );
});
