// #635 — refresh_nodes must say WHY it is not fresh, and what to do about it.
//
// The pre-fix reply was {ok:true, refreshed:false} on every failure shape —
// backend unreachable, /object_info empty, combo API absent, combo refresh
// threw — indistinguishable from a no-op. These tests pin the verdict's reason
// token per failure shape AND that the reply carries an actionable remedy.
//
// The verdict logic is tested as the pure lib function; the SHIPPING executor
// is extracted from the panel monolith and driven with doubles, so deleting
// the reason/remedy wiring in the panel fails these tests.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchNodeDefsWithRetry, OBJECT_INFO_RETRY_DELAYS_MS } from "../../web/js/lib/object-info-retry.js";
import { withTimeout } from "../../web/js/lib/bounded-step.js";

// #1180 — READ from the panel, never restated. Shared with the other harnesses that
// rebuild shipped functions, so one copy of a constant cannot drift from another.
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
// The refresh shares #954's schedule rather than forking it; a timeout is declined by
// `shouldRetry` instead of by shortening the schedule for everyone.
const NODE_DEFS_RETRY_DELAYS_MS = OBJECT_INFO_RETRY_DELAYS_MS;
const makeBoundedGetNodeDefs = (apiValue) => (timeoutMs = NODE_DEFS_FETCH_TIMEOUT_MS) =>
  typeof apiValue?.getNodeDefs !== "function"
    ? Promise.resolve(null)
    : withTimeout(
        Promise.resolve().then(() => apiValue.getNodeDefs()).then((value) => ({ value }), (err) => ({ err })),
        timeoutMs,
        () => NODE_DEFS_NO_ANSWER,
      ).then((settled) => {
        if (settled === NODE_DEFS_NO_ANSWER) return NODE_DEFS_NO_ANSWER;
        if ("err" in settled) throw settled.err;
        return settled.value;
      });

/** #716 — records invalidate() calls so a test can assert the refresh drops the cache. */
let cacheInvalidations = 0;
const cacheSpy = { invalidate: () => { cacheInvalidations += 1; }, read: async (f) => f() };

/** #1223 — the last-observed-schema snapshot the refresh run also clears and re-records. */
let snapshotClears = 0;
const snapshotRecords = [];
const snapshotSpy = {
  clear: () => { snapshotClears += 1; },
  record: (defs, opts) => { snapshotRecords.push({ defs, opts }); return true; },
};

import {
  describeNodeDefRefresh,
  NODE_DEF_REFRESH_REASONS,
} from "../../web/js/lib/node-def-refresh.js";
import { comboRebuildCovered } from "../../web/js/lib/asset-staleness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// The pure verdict function
// ---------------------------------------------------------------------------

test("#635: a fully successful run is refreshed with no failure fields", () => {
  const v = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    defsRegistered: true,
    comboApiPresent: true,
    comboRan: true,
  });
  assert.deepEqual(v, { refreshed: true, reason: "refreshed" });
});

test("#635: app unavailable is its own reason with a reload remedy", () => {
  const v = describeNodeDefRefresh({
    appAvailable: false,
    defsObtained: false,
    comboApiPresent: false,
    comboRan: false,
  });
  assert.equal(v.refreshed, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.APP_UNAVAILABLE);
  assert.match(v.remedy, /reload the ComfyUI tab/i);
});

test("#635: /object_info unobtained (no throw) is distinguished from a fetch failure", () => {
  const v = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: false,
    comboApiPresent: true,
    comboRan: false,
  });
  assert.equal(v.refreshed, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.OBJECT_INFO_UNAVAILABLE);
  assert.match(v.remedy, /retry/i);

  const thrown = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: false,
    comboApiPresent: true,
    comboRan: false,
    phase: "fetch",
    thrown: new Error("fetch failed"),
  });
  assert.equal(thrown.refreshed, false);
  assert.equal(thrown.reason, NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED);
  assert.match(thrown.detail, /fetch failed/, "the underlying error rides along as detail");
});

test("#635: a throw during registration is not misreported as a fetch failure", () => {
  const v = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    comboApiPresent: false,
    comboRan: false,
    phase: "register",
    thrown: new Error("boom"),
  });
  assert.equal(v.refreshed, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.REGISTER_FAILED);
  assert.match(v.remedy, /re-register/i);
});

test("#635: the stuck case from the issue — combo API absent — says defs DID register and combos refresh on reload", () => {
  const v = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    defsRegistered: true,
    comboApiPresent: false,
    comboRan: false,
  });
  assert.equal(v.refreshed, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.COMBO_API_ABSENT);
  // The remedy must not read as "nothing happened": the defs WERE re-registered.
  assert.match(v.remedy, /WERE re-registered/);
  assert.match(v.remedy, /reload/i);
});

test("#635: registration is claimed ONLY when the call observably ran (codex r2 P1)", () => {
  // No registration API at all → its own reason, never a silent refreshed:true
  // (codex r3), and never a fabricated "WERE re-registered".
  const v = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    defsRegistered: false, // registerNodesFromDefs absent on this frontend
    comboApiPresent: false,
    comboRan: false,
  });
  assert.equal(v.refreshed, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.REGISTER_API_ABSENT);
  assert.doesNotMatch(v.remedy, /WERE re-registered/, "no fabricated registration claim");
  assert.match(v.remedy, /NOT registered/);
  assert.match(v.remedy, /reload the ComfyUI tab/i);

  const combosRan = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    defsRegistered: false,
    comboApiPresent: true,
    comboRan: true,
  });
  assert.equal(combosRan.reason, NODE_DEF_REFRESH_REASONS.REGISTER_API_ABSENT);
  assert.match(combosRan.remedy, /combo dropdown lists WERE refreshed/, "a true partial success is still said");

  const thrown = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    defsRegistered: false,
    comboApiPresent: true,
    comboRan: false,
    phase: "combo",
    thrown: new Error("boom"),
  });
  assert.doesNotMatch(thrown.remedy, /WERE re-registered/);
  assert.match(thrown.remedy, /NOT registered/);
});

test("#635: a throwing combo refresh is distinguished from an absent combo API", () => {
  const v = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    defsRegistered: true,
    comboApiPresent: true,
    comboRan: false,
    phase: "combo",
    thrown: new Error("combo exploded"),
  });
  assert.equal(v.refreshed, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.COMBO_REFRESH_FAILED);
  assert.match(v.remedy, /WERE re-registered/);
  assert.match(v.detail, /combo exploded/);
});

test("#635: a present-but-not-run combo API with no throw fails closed, never claims fresh", () => {
  const v = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    defsRegistered: true,
    comboApiPresent: true,
    comboRan: false,
  });
  assert.equal(v.refreshed, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.COMBO_REFRESH_FAILED);
});

test("#635: every non-fresh verdict carries BOTH a reason and a remedy", () => {
  const cases = [
    { appAvailable: false, defsObtained: false, comboApiPresent: false, comboRan: false },
    { appAvailable: true, defsObtained: false, comboApiPresent: true, comboRan: false },
    { appAvailable: true, defsObtained: false, comboApiPresent: false, comboRan: false, phase: "fetch", thrown: new Error("x") },
    { appAvailable: true, defsObtained: true, comboApiPresent: false, comboRan: false },
    { appAvailable: true, defsObtained: true, comboApiPresent: true, comboRan: false },
    { appAvailable: true, defsObtained: true, comboApiPresent: true, comboRan: false, phase: "combo", thrown: new Error("x") },
    { appAvailable: true, defsObtained: true, comboApiPresent: false, comboRan: false, phase: "register", thrown: new Error("x") },
  ];
  for (const input of cases) {
    const v = describeNodeDefRefresh(input);
    assert.equal(v.refreshed, false);
    assert.ok(typeof v.reason === "string" && v.reason.length > 0, "reason present");
    assert.ok(typeof v.remedy === "string" && v.remedy.length > 0, `remedy present for ${v.reason}`);
  }
});

// ---------------------------------------------------------------------------
// The SHIPPING refresh_nodes executor, extracted and driven with doubles
// ---------------------------------------------------------------------------

function buildRefreshNodes(refreshImpl) {
  const start = SRC.indexOf("async refresh_nodes()");
  assert.notEqual(start, -1, "refresh_nodes executor not found in the panel source");
  // Balanced-brace extraction from the signature's opening brace (comments and
  // strings skipped), so the slice is exactly the executor — not the trailing
  // comma or the next executor's doc comment.
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
  // #1404 — every OTHER module binding the executor closes over, from the one place that
  // holds them (REFRESH_NODES_EXECUTOR_DEPS), so a new one is added once for all three
  // harnesses rather than three times.
  const extra = Object.entries(REFRESH_NODES_EXECUTOR_DEPS);
  const factory = new Function(
    "refreshComfyNodeDefs",
    ...extra.map(([name]) => name),
    `return (${body.replace(/^async refresh_nodes\(\)/, "async function refresh_nodes()")});`,
  );
  return factory(refreshImpl, ...extra.map(([, value]) => value));
}

test("#635: the shipping executor returns reason + remedy when the refresh is not fresh", async () => {
  const refresh_nodes = buildRefreshNodes(async () => ({
    refreshed: false,
    reason: "combo_api_absent",
    remedy: "reload the tab",
  }));
  const reply = await refresh_nodes();
  assert.equal(reply.ok, true);
  assert.equal(reply.refreshed, false);
  assert.equal(reply.reason, "combo_api_absent", "the verdict's reason reaches the reply");
  assert.equal(reply.remedy, "reload the tab", "the verdict's remedy reaches the reply");
});

test("#635: the shipping executor surfaces the detail when the verdict carries one", async () => {
  const refresh_nodes = buildRefreshNodes(async () => ({
    refreshed: false,
    reason: "object_info_fetch_failed",
    detail: "(fetch failed)",
    remedy: "retry later",
  }));
  const reply = await refresh_nodes();
  assert.equal(reply.refreshed, false);
  assert.equal(reply.detail, "(fetch failed)");
});

test("#635: the shipping executor reports a clean success with no failure fields", async () => {
  const refresh_nodes = buildRefreshNodes(async () => ({ refreshed: true, reason: "refreshed" }));
  const reply = await refresh_nodes();
  assert.deepEqual(reply, { ok: true, refreshed: true });
});

test("#635: an undefined verdict (coalesced away) still yields a reason and a remedy, never a bare false", async () => {
  const refresh_nodes = buildRefreshNodes(async () => undefined);
  const reply = await refresh_nodes();
  assert.equal(reply.refreshed, false);
  assert.equal(reply.reason, "unknown");
  assert.ok(reply.remedy.length > 0, "a remedy is present even when the verdict itself is missing");
});

test("#635: the shipping registerComfyNodeDefs returns its verdict through the panel wiring", () => {
  // Wiring scan: the register function must build its return through
  // describeNodeDefRefresh (delete the call and this fails), and the shared
  // global must keep its boolean semantics for the trust gate.
  const start = SRC.indexOf("async function registerComfyNodeDefs(");
  assert.notEqual(start, -1);
  const rest = SRC.slice(start);
  const m = rest.match(/\n}\n/);
  const body = rest.slice(0, m.index);
  assert.match(body, /return describeNodeDefRefresh\(\{/, "the run verdict is returned");
  assert.match(
    body,
    /nodeDefsRefreshConfirmed = !didThrow && !!defs && \(comboRan \|\| comboAbandonedAfterRebuild\);/,
    "the shared global stays a strict boolean, and #1193 admits the panel's OWN completed " +
      "combo rebuild as the second way the live lists became current",
  );
  // #1193 — the two inputs must stay SEPARATE all the way to the verdict. Merging them
  // into one flag would make an abandoned-but-locally-rebuilt run indistinguishable from
  // a confirmed one, which is the distinction the disclosure exists to carry.
  assert.match(body, /comboRebuiltLocally: comboAbandonedAfterRebuild,/, "the verdict is told which one held");
  // #1193 — the disclosure is gated on the sweep having COVERED the graph, never on it
  // merely having finished. `comboRebuild.completed` alone is true for a sweep that walked
  // past every V2 combo on the graph, and granting the claim there suppresses a genuine
  // missing asset. The predicate lives beside the sweep so both readers ask it the same way.
  assert.match(body, /if \(comboAbandoned && comboRebuildCovered\(comboRebuild\)\) \{/, "the disclosure demands a COVERED sweep");
  assert.doesNotMatch(body, /comboAbandoned && comboRebuild\.completed/, "…never `completed` on its own");
  assert.match(body, /comboRan,/, "the frontend call's own outcome is still passed separately");
});

// ---------------------------------------------------------------------------
// The SHIPPING registerComfyNodeDefs, extracted and driven end-to-end with
// doubles (codex gate r3: the verdict unit tests + executor extraction alone
// did not prove the real registration function produces those verdicts)
// ---------------------------------------------------------------------------

/** Balanced-brace extraction of a top-level function by its declaration marker. */
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

// #1180 — ONE builder. Two more copies of this 12-argument factory used to sit inline in
// the tests below, differing only in the recorder they passed, and adding a collaborator
// meant remembering all three. It did not get remembered: the combo sentinels landed here
// and the copies threw ReferenceError.
function buildRegisterComfyNodeDefs({
  appValue,
  apiValue,
  timers,
  now,
  recordObjectInfoTypes = () => ({}),
  reapplyDefsToLiveNodes = () => {},
}) {
  const body = extractFunction("async function registerComfyNodeDefs(");
  const factory = new Function(
    "app",
    "api",
    "recordObjectInfoTypes",
    "reapplyDefsToLiveNodes",
    "comboRebuildCovered",
    "describeNodeDefRefresh",
    // #954 — the REAL retry, not a stub. The shipping function now fetches through it, and
    // a harness that substituted a pass-through would stop proving what this file exists to
    // prove: that the shipped code produces these verdicts.
    "fetchNodeDefsWithRetry",
    "withTimeout",
    "NODE_DEFS_NO_ANSWER",
    "COMBO_OK",
    "COMBO_NO_ANSWER",
    "NODE_DEFS_FETCH_TIMEOUT_MS",
    "NODE_DEFS_RUN_BUDGET_MS",
    "NODE_DEFS_FETCH_SHARE",
    "nodeDefsBudgetLeft",
    "monotonicNow",
    "NODE_DEFS_RETRY_DELAYS_MS",
    "objectInfoCache",
    // #1223 — the snapshot the run retires and re-records, and the connection epoch a
    // recording is stamped with. Both are module state in the panel, so the extracted
    // body throws ReferenceError without them.
    "objectInfoSnapshot",
    "backendReconnectEpoch",
    `// #1180 — defined HERE, from the api this scope already has, so each factory site
     // gets its own stub without threading a helper through every call.
     const boundedGetNodeDefs = async (ms = NODE_DEFS_FETCH_TIMEOUT_MS) => {
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
     let nodeDefsRefreshConfirmed = false;
     ${body}
     return { registerComfyNodeDefs, getConfirmed: () => nodeDefsRefreshConfirmed };`,
  );
  return factory(
    appValue,
    apiValue,
    recordObjectInfoTypes,
    reapplyDefsToLiveNodes,
    comboRebuildCovered,
    describeNodeDefRefresh,
    // No real waiting: the delays are the shipped ones, the sleep is not.
    // #1180 — the SHIPPED options, not just the shipped helper. Omitting `delays` let the
    // helper fall back to its own default, so every test here ran a schedule the refresh
    // path does not use: the harness proved a retry that production never performs.
    (getDefs, opts) => fetchNodeDefsWithRetry(getDefs, { ...opts, sleep: async () => {} }),
    // #1180 — the shipped primitive, told which clock to use, so the combo tests can make
    // the bound FIRE without the suite waiting ten real seconds for it.
    timers ? (pr, ms, onT) => withTimeout(pr, ms, onT, timers) : withTimeout,
    NODE_DEFS_NO_ANSWER,
    COMBO_OK,
    COMBO_NO_ANSWER,
    NODE_DEFS_FETCH_TIMEOUT_MS,
    NODE_DEFS_RUN_BUDGET_MS,
    NODE_DEFS_FETCH_SHARE,
      // #1193 — ONE clock for the deadline and the arithmetic that reads it. The shared
    // helper reads the REAL monotonicNow; a fake-clock deadline measured against it is a
    // different bound than the one the panel arms (its own nodeDefsBudgetLeft shares the
    // panel's clock). Without the override the shared helper is passed through unchanged.
    now ? (deadline, share = 1) => Math.max(1, Math.floor((deadline - now()) * share)) : nodeDefsBudgetLeft,
    now ?? monotonicNow,
    NODE_DEFS_RETRY_DELAYS_MS,
    // #716 — the shipping function drops the widget-write burst cache after a successful
    // fetch. A spy, so the harness can prove that happens rather than merely tolerate it.
    cacheSpy,
    // #1223 — a spy, so a test can prove the run retires the last-observed schema and
    // re-records only a payload it fetched itself.
    snapshotSpy,
    7,
  );
}

const FULL_APP = {
  graph: null,
  registerNodesFromDefs: async () => {},
  refreshComboInNodes: async () => {},
};

test("#635: the shipping register run with no obtainable /object_info reports object_info_unavailable", async () => {
  const { registerComfyNodeDefs, getConfirmed } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: { getNodeDefs: async () => null },
  });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, false);
  assert.equal(verdict.reason, "object_info_unavailable", "the common no-defs case names its cause");
  assert.match(verdict.remedy, /retry/i);
  assert.equal(getConfirmed(), false, "the shared trust global stays false");
});

test("#635: the shipping register run end-to-end success reports refreshed", async () => {
  const { registerComfyNodeDefs, getConfirmed } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
  });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.deepEqual(verdict, { refreshed: true, reason: "refreshed" });
  assert.equal(getConfirmed(), true);
});

test("#635: the shipping run on a combo-API-absent frontend claims registration only because it RAN", async () => {
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    appValue: { graph: null, registerNodesFromDefs: async () => {} }, // no refreshComboInNodes
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
  });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.reason, "combo_api_absent");
  assert.match(verdict.remedy, /WERE re-registered/, "registration did run here, so the claim is true");
});

test("#635: the shipping run on a registerNodesFromDefs-absent frontend does NOT claim registration", async () => {
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    appValue: { graph: null, refreshComboInNodes: async () => {} }, // no registerNodesFromDefs
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
  });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, false);
  assert.equal(verdict.reason, "register_api_absent");
  assert.doesNotMatch(verdict.remedy, /WERE re-registered/, "no fabricated registration claim");
  assert.match(verdict.remedy, /NOT registered/);
  assert.match(verdict.remedy, /combo dropdown lists WERE refreshed/, "the combo half did run — disclosed");
});

test("#635: the shipping run attributes a getNodeDefs throw to the fetch, with detail", async () => {
  const { registerComfyNodeDefs, getConfirmed } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: {
      getNodeDefs: async () => {
        throw new Error("fetch failed");
      },
    },
  });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.reason, "object_info_fetch_failed");
  assert.match(verdict.detail, /fetch failed/);
  assert.equal(getConfirmed(), false);
});

test("#635: a pre-registration throw must not claim registration was attempted (codex r4)", () => {
  const recordThrew = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    defsRegistered: false,
    comboApiPresent: true,
    comboRan: false,
    phase: "record",
    thrown: new Error("history exploded"),
  });
  assert.equal(recordThrew.reason, NODE_DEF_REFRESH_REASONS.REGISTER_FAILED);
  assert.match(recordThrew.remedy, /BEFORE registration was attempted/);
  assert.doesNotMatch(recordThrew.remedy, /re-registering the node definitions failed/);

  const reapplyThrew = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    defsRegistered: true, // registration DID run — reapply failed after it
    comboApiPresent: true,
    comboRan: false,
    phase: "reapply",
    thrown: new Error("live node rejected the def"),
  });
  assert.equal(reapplyThrew.reason, NODE_DEF_REFRESH_REASONS.REGISTER_FAILED);
  assert.match(reapplyThrew.remedy, /WERE re-registered/, "true here — registration ran before the throw");
  assert.match(reapplyThrew.remedy, /live canvas nodes failed/);
});

test("#635: the shipping run attributes a history-recording throw to BEFORE registration", async () => {
  let registerCalls = 0;
  const { registerComfyNodeDefs: registerWithThrowingRecorder } = buildRegisterComfyNodeDefs({
    appValue: {
      graph: null,
      registerNodesFromDefs: async () => {
        registerCalls += 1;
      },
      refreshComboInNodes: async () => {},
    },
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
    recordObjectInfoTypes: () => {
      throw new Error("history exploded");
    },
  });
  const verdict = await registerWithThrowingRecorder(undefined);
  assert.equal(verdict.reason, "register_failed");
  assert.match(verdict.remedy, /BEFORE registration was attempted/);
  assert.equal(registerCalls, 0, "registerNodesFromDefs was never reached");
});

test("#635: a FALSY thrown value still counts as a failure (codex r5)", () => {
  const v = describeNodeDefRefresh({
    appAvailable: true,
    defsObtained: true,
    defsRegistered: false,
    comboApiPresent: true,
    comboRan: false,
    phase: "record",
    didThrow: true,
    thrown: null, // `throw null` — the value carries nothing, the fact matters
  });
  assert.equal(v.refreshed, false);
  assert.equal(v.reason, NODE_DEF_REFRESH_REASONS.REGISTER_FAILED, "not misattributed to a missing API");
  assert.match(v.remedy, /BEFORE registration was attempted/);
  assert.equal(v.detail, undefined, "no detail to invent from a null throw");
});

test("#635: the shipping register run treats a falsy throw as a failure everywhere", async () => {
  const { registerComfyNodeDefs, getConfirmed } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
    recordObjectInfoTypes: () => {
      throw null; // a falsy throw — must still read as a failed run
    },
  });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, false);
  assert.equal(verdict.reason, "register_failed");
  assert.equal(getConfirmed(), false, "the shared trust flag must not latch true after a falsy throw");
});

test("#954: the shipping run survives a transient getNodeDefs throw", async () => {
  // The WIRING SEAM (codex). The retry helper has its own tests and the browser run proved
  // the whole path, but neither pins that registerComfyNodeDefs itself turns
  // first-throw/second-success into a refresh — which is the exact regression #954 reports.
  let calls = 0;
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: {
      getNodeDefs: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return { SomeNode: {} };
      },
    },
  });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, true, "a blip inside a reconnect window must not fail the refresh");
  assert.equal(calls, 2, "it re-attempted rather than swallowing the throw");
});

test("#954: a persistent getNodeDefs throw still reports the fetch failure it always did", async () => {
  // The other direction, and the one a retry can silently break: a genuine outage must keep
  // producing `object_info_fetch_failed` with a real detail, not a vaguer verdict.
  let calls = 0;
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: {
      getNodeDefs: async () => {
        calls += 1;
        throw new TypeError("Failed to fetch");
      },
    },
  });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, false);
  assert.equal(verdict.reason, "object_info_fetch_failed");
  assert.match(String(verdict.detail ?? ""), /Failed to fetch/);
  assert.equal(calls, 3, "bounded — it does not retry forever");
});

test("#716: a successful refresh DROPS the widget-write burst cache", async () => {
  // The TTL is only safe because anything that knows the schema moved drops the entry.
  // A refresh is exactly that event — it runs on refresh_nodes, on a completed install and
  // on reconnect. Without this the next widget write would be authorized against a map
  // taken before the very change that prompted the refresh.
  const before = cacheInvalidations;
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
  });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, true);
  assert.equal(cacheInvalidations, before + 1, "the burst cache must be dropped by a refresh");
});

test("#716: a FAILED refresh still drops the burst cache", async () => {
  // codex: invalidating only after a successful fetch left the pre-change map authorizing
  // writes for the rest of the TTL when the refresh failed — and a failed refresh is when
  // the schema is most likely to have moved. The old code would have fetched and failed
  // closed. So the drop happens when the run STARTS, whatever it goes on to do.
  const before = cacheInvalidations;
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: {
      getNodeDefs: async () => {
        throw new TypeError("Failed to fetch");
      },
    },
  });
  const verdict = await registerComfyNodeDefs(undefined);
  assert.equal(verdict.refreshed, false);
  assert.equal(verdict.reason, "object_info_fetch_failed");
  assert.equal(cacheInvalidations, before + 1, "a failed refresh must not leave a usable entry");
});

test("#1180: a real backend error outranks a synthesized timeout in the verdict", async () => {
  // fetchNodeDefsWithRetry rethrows the LAST error, so the caller's verdict names what
  // actually failed. Once a timeout can BE that last error, a genuine failure on attempt
  // one gets buried under "did not answer" from attempt three — and describeNodeDefRefresh's
  // remedy then blames the wrong thing, which is this codebase's own false-cause defect.
  //
  // A real error wins; a stall reports as a stall only when nothing better was learned.
  const src = SRC;
  // Anchored to the DECLARATION, not the call: the flag is declared just above the retry,
  // and a slice starting at the call misses it — the same fixed-window trap that has bitten
  // several tests in this repo, including two on this branch.
  const start = src.indexOf("let sawRealError = false;");
  assert.notEqual(start, -1, "the presence flag must be declared");
  const end = src.indexOf("registerComfyNodeDefs", start);
  const body = src.slice(start, end === -1 ? start + 1400 : end);
  assert.match(body, /lastRealError/, "a real error must be remembered");
  assert.match(
    body,
    /if \(sawRealError\) throw lastRealError;/,
    "…and preferred over the synthesized timeout",
  );
  // A SEPARATE FLAG: the error VALUE cannot double as the not-yet-set sentinel, or a
  // falsy throw is forgotten -- which this file already has a test about (codex r5).
  assert.match(body, /let sawRealError = false;/, "presence must not be inferred from the value");
  // The timeout message is still there for the case where nothing better was learned.
  assert.match(body, /did not answer within this refresh's remaining budget/);
});

test("#1180 EXECUTED: which error survives the retry, across every ordering", async () => {
  // MIRRORS the panel's loop rather than driving it, which is worth being plain about:
  // its value is enumerating many orderings cheaply, and the structural test above is what
  // ties the mirror to the source. The ordering that drives the SHIPPED executor is "a REAL
  // error survives a later stall" at the end of this file, on virtual timers.
  //
  // This one runs the real
  // retry loop and shows what a user would actually be told, because "the last error wins"
  // plus "a timeout can be an error" silently changes the verdict for orderings nobody
  // enumerated — and the remedy attached to that verdict blames a specific thing.
  const NO_ANSWER = Symbol("node-defs-timeout");
  const run = async (outcomes) => {
    let i = 0;
    // A separate flag, mirroring the panel: the error VALUE cannot double as the
    // not-yet-set sentinel, or a falsy throw is forgotten.
    let sawRealError = false;
    let lastRealError = null;
    try {
      return await fetchNodeDefsWithRetry(
        async () => {
          const o = outcomes[Math.min(i++, outcomes.length - 1)];
          let result;
          try {
            if (o === "throw") throw new Error("real backend error");
            if (o === "falsy") throw null; // a real failure whose VALUE is falsy
            result = o === "timeout" ? NO_ANSWER : { KSampler: {} };
          } catch (err) {
            sawRealError = true;
            lastRealError = err;
            throw err;
          }
          if (result === NO_ANSWER) {
            if (sawRealError) throw lastRealError;
            throw new Error("did not answer within the attempt bound");
          }
          return result;
        },
        { sleep: async () => {} },
      );
    } catch (e) {
      // e?.message, not e.message: the falsy-throw case below throws null, and reading
      // .message off it here would fail the test for the wrong reason — the same hazard the
      // panel guards against, met in the test that checks it.
      return `THREW: ${e?.message ?? String(e)}`;
    }
  };

  // A real failure always outranks a stall, whichever came first.
  assert.equal(await run(["throw", "timeout", "timeout"]), "THREW: real backend error");
  assert.equal(await run(["timeout", "throw", "timeout"]), "THREW: real backend error");
  assert.equal(await run(["throw", "throw", "throw"]), "THREW: real backend error");
  // Only when nothing better was learned does the stall get to speak for itself.
  assert.match(await run(["timeout", "timeout", "timeout"]), /did not answer/);
  // …and the retry still does its job: a transient stall or error must not cost the command.
  assert.deepEqual(await run(["timeout", "ok"]), { KSampler: {} });
  assert.deepEqual(await run(["throw", "ok"]), { KSampler: {} });
  // A FALSY throw is still a real failure, and must outrank the synthesized timeout —
  // inferring presence from the error's value would forget exactly these.
  assert.match(await run(["falsy", "timeout", "timeout"]), /THREW: /);
  assert.doesNotMatch(await run(["falsy", "timeout", "timeout"]), /did not answer/);
});

test("#1180: the shipped combo phase is bounded, and its outcomes stay apart", () => {
  // STRUCTURE ONLY. What this phase actually DOES under a hung combo is driven end-to-end
  // in the two tests below; this one pins the shape those tests would silently stop
  // covering if the bound were removed from the source they rebuild.
  //
  // It used to do more, and the more was vacuous: it built a LOCAL copy of the bounded
  // call and asserted against that, then hand-fed `describeNodeDefRefresh` a
  // `phase: "combo"` and concluded `combo_refresh_failed`. The shipped code was sending
  // `phase: "done"`, so the one scenario the test appeared to prove was a state the panel
  // never reached. A test may not supply the input whose production is the thing in doubt.
  const combo = SRC.slice(SRC.indexOf('phase = "combo";'), SRC.indexOf('if (!comboFailed) phase = "done";'));
  assert.ok(combo.length > 0, "could not locate the combo phase");
  assert.match(
    combo,
    /withTimeout\(\s*Promise\.resolve\(\)\s*\.then\(\(\) => a\.refreshComboInNodes\(\)\)/,
    "the combo refresh itself must be the bounded promise, not merely nearby",
  );
  assert.doesNotMatch(
    combo,
    /^\s*await a\.refreshComboInNodes\(\);\s*$/m,
    "a bare await here parks the run on the payload-carrying path, where no fetch bound applies",
  );
  // The three outcomes must stay distinguishable. Mapping a rejection to the same value as
  // a timeout is what let an instant combo error be reported as a ten-second stall.
  assert.match(combo, /=> COMBO_OK, \(err\) => \(\{ err \}\)\)/, "a throw must carry its cause, not become a boolean");
  assert.match(combo, /\(\) => COMBO_NO_ANSWER,/, "a timeout must be its own outcome");
  // …and a failure must still reach the browser console. Reifying the outcome took this
  // off the throwing path, and the catch below was the ONLY place that logged one — so the
  // sole record of a failed combo refresh for anyone not reading a tool reply went silent.
  assert.match(
    combo,
    /console\.warn\(/,
    "a combo failure that no longer throws must be logged where the throw used to be",
  );
  // …and the phase must not advance past `combo` when the combo failed, or the verdict
  // names the wrong cause entirely.
  assert.match(
    SRC,
    /if \(!comboFailed\) phase = "done";/,
    "an unconditional done here reports a combo failure as register_failed",
  );
  // …and the guard must read a FLAG, not the thrown value. `throw null` is a real failure,
  // so `if (!thrown)` let a falsy combo rejection advance the phase and vanish from the
  // verdict's `failed` test — #635's hole, reopened at a new site.
  assert.match(
    combo,
    /comboFailed = true;/,
    "a falsy combo rejection must still register as a failure",
  );
});

// ---------------------------------------------------------------------------
// #1180 — the COMBO phase's own bound.
//
// Bounding the FETCH phase first did not remove this stall, it moved it:
// `refreshComboInNodes()` issues its own /object_info, and the payload-carrying path
// (`graph_add_node`'s `refresh(freshDefs)`) hands the defs in and reaches the combo
// phase with the fetch bound never consulted at all.
//
// Driven with a `refreshComboInNodes` that NEVER settles, on virtual time, so three
// things a mutation can break independently are each stated separately:
//
//   1. a bound is actually ARMED, with the panel's own constant — passing 0 arms
//      nothing at all, because `withTimeout` treats a non-positive ms as no bound;
//   2. giving up is reported as `combo_refresh_failed`, not as a refresh;
//   3. the shared trust global stays FALSE.
//
// (3) is the one with teeth. That global is what lets callers suppress missing-asset
// candidates using the live combo lists, so a combo refresh that never answered being
// recorded as a completed one would suppress genuine misses using lists that were
// never refreshed — an over-report-safe design failing to the unsafe side.

/** Timers whose clock only moves when the test says so. */
function virtualTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimer(fn, ms) {
      const id = (seq += 1);
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    armed: () => [...pending.values()],
    fireAll() {
      for (const [id, t] of [...pending]) {
        pending.delete(id);
        t.fn();
      }
    },
    // Advance the clock to `limitMs`: fire every armed timer whose delay is within it,
    // so a test can let a 4846ms step COMPLETE without firing a 6000ms bound.
    fireUpTo(limitMs) {
      for (const [id, t] of [...pending]) {
        if (t.ms > limitMs) continue;
        pending.delete(id);
        t.fn();
      }
    },
  };
}

/** Fail — never hang — when a bound that should exist does not. `node --test` has no
 *  default per-test timeout, so an unbounded await here would stall the whole run
 *  instead of reporting the defect it was written to report. */
function orFail(promise, message, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      t.unref?.();
    }),
  ]);
}

/** Let every already-resolved promise on the path settle, leaving only what genuinely
 *  cannot settle. Microtask turns, not wall-clock: nothing here waits on real time. */
async function drainMicrotasks(turns = 200) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

test("#1180 the combo phase arms a bound, using the panel's constant", async () => {
  const timers = virtualTimers();
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    appValue: {
      graph: null,
      registerNodesFromDefs: async () => {},
      refreshComboInNodes: () => new Promise(() => {}), // the half-open case: never settles
    },
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
    timers,
  });
  const running = registerComfyNodeDefs(undefined);
  await drainMicrotasks();
  const armed = timers.armed();
  // Exactly one: the fetch phase's bound must already have been CLEARED by its own
  // answer. Two here would mean a bound leaks per refresh on a long-lived page.
  assert.equal(armed.length, 1, `the combo phase must leave exactly one bound armed, saw ${armed.length}`);
  // The bound is what is LEFT of the run's budget, not a private allowance: the fetch
  // phase ran first and its cost comes out of the same total. So the assertion is a band,
  // and both edges matter — 0 or less arms nothing at all (withTimeout's non-positive
  // contract, which silently restores the hang), and anything above the run budget means
  // the phase is spending time the run has not got. #1193 left this REMAINDER alone — it
  // moved the abandonment's VERDICT instead of topping the remainder up — so the band
  // below is still the whole property.
  assert.ok(
    armed[0].ms > 0 && armed[0].ms <= NODE_DEFS_RUN_BUDGET_MS,
    `the combo bound must be the run's REMAINING budget, saw ${armed[0].ms}ms against a ${NODE_DEFS_RUN_BUDGET_MS}ms run`,
  );
  timers.fireAll();
  await orFail(running, "the combo phase never gave up: registerComfyNodeDefs is still awaiting refreshComboInNodes");
});

test("#1180 a combo refresh that never answers is NOT reported as a refresh", async () => {
  const timers = virtualTimers();
  const { registerComfyNodeDefs, getConfirmed } = buildRegisterComfyNodeDefs({
    appValue: {
      graph: null,
      registerNodesFromDefs: async () => {},
      refreshComboInNodes: () => new Promise(() => {}),
    },
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
    timers,
  });
  const running = registerComfyNodeDefs(undefined);
  await drainMicrotasks();
  timers.fireAll();
  const verdict = await orFail(running, "the combo phase never gave up");

  assert.equal(verdict.refreshed, false, "nothing refreshed the combo lists, so the reply must not say refreshed");
  assert.equal(verdict.reason, "combo_refresh_failed");
  // The accurate half of the outcome survives: registration DID happen above the combo phase.
  assert.match(verdict.remedy, /WERE re-registered/);
  assert.equal(
    getConfirmed(),
    false,
    "a combo refresh that never answered must not license trusting the combo lists to suppress missing assets",
  );
});

// ---------------------------------------------------------------------------
// #1193 — the combo phase's remainder can be too thin for a HEALTHY refresh.
//
// MEASURED, on a live rig (848 node types, ComfyUI frontend 1.48.7): getNodeDefs 211ms /
// refreshComboInNodes 555ms unthrottled; with every /object_info delayed 3000ms, 3156ms /
// 3318ms. `refreshComboInNodes()` RE-FETCHES /object_info, so its cost tracks the
// backend's latency — and the only case that starves its remainder is a fetch slow enough
// to spend its share, i.e. that same slow backend. No constant sized from the warm figure
// covers the case it fires in, which is why the fix is not a bigger number.
//
// What it is instead: since #1172 the reapply sweep rebuilds every live combo's
// options.values from the payload this run fetched, so an ABANDONED frontend call is a
// missing confirmation, not stale dropdowns.
// ---------------------------------------------------------------------------

/** The reapply sweep's contract, as `reapplyDefsToLiveNodes` fills it in: counts as it
 *  goes, `combosSkipped` for every combo whose list it could not derive, and `completed`
 *  only after every graph was walked. `asset-staleness.test.mjs` pins the REAL sweep
 *  against this same shape — including a V2 `["COMBO", {options}]` spec and the remote /
 *  dynamic shapes it must refuse — so these doubles cannot drift into a contract the
 *  shipped sweep does not honour. */
function sweepThatCompletes(combosRebuilt = 3) {
  return (_graph, _defs, stats) => {
    if (stats) {
      stats.nodesSwept = 2;
      stats.combosRebuilt = combosRebuilt;
      stats.combosSkipped = 0;
      stats.completed = true;
    }
    return 0;
  };
}
/** A sweep that stopped part way: it counted what it touched and never reached the flag. */
function sweepThatStopsPartWay() {
  return (_graph, _defs, stats) => {
    if (stats) stats.nodesSwept = 1;
    return 0;
  };
}
/** A sweep that FINISHED and still left combo lists untouched — a remote V2, a dynamic V3,
 *  or any shape published after this panel was written. `completed` is true; the graph is
 *  not covered. This is the state that made the first version of #1193 unsafe. */
function sweepThatFinishesButSkips(combosSkipped = 1) {
  return (_graph, _defs, stats) => {
    if (stats) {
      stats.nodesSwept = 2;
      stats.combosRebuilt = 1;
      stats.combosSkipped = combosSkipped;
      stats.completed = true;
    }
    return 0;
  };
}

const APP_WITH_GRAPH = {
  // No `serialize`, so #1275's graph guard stays inert — this test is about the combo
  // phase, and a guard needs collaborators the harness does not inject.
  graph: { _nodes: [] },
  registerNodesFromDefs: async () => {},
  refreshComboInNodes: () => new Promise(() => {}),
};

test("#1193: an ABANDONED combo refresh over a completed local rebuild is disclosed, not failed", async () => {
  const timers = virtualTimers();
  const { registerComfyNodeDefs, getConfirmed } = buildRegisterComfyNodeDefs({
    appValue: APP_WITH_GRAPH,
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
    timers,
    reapplyDefsToLiveNodes: sweepThatCompletes(),
  });
  const running = registerComfyNodeDefs(undefined);
  await drainMicrotasks();
  timers.fireAll(); // the combo bound fires; refreshComboInNodes never answers
  const verdict = await orFail(running, "the combo phase never gave up");

  assert.equal(
    verdict.refreshed,
    true,
    "the dropdowns were rebuilt from this run's authoritative payload, so the reply must not " +
      "report them stale just because the frontend's own repeat of that work had not answered",
  );
  assert.equal(verdict.reason, "refreshed");
  assert.equal(
    verdict.combo_refresh_confirmed,
    false,
    "the missing confirmation is still SAID — refreshed:true alone would collapse it into a " +
      "run where refreshComboInNodes actually answered",
  );
  assert.match(verdict.combo_refresh_note, /had not answered when this run stopped waiting/);
  assert.match(verdict.combo_refresh_note, /it was given \d+ms/, "the bound it was given is named");
  assert.equal(
    getConfirmed(),
    true,
    "the trust flag stands for 'an authoritative payload was obtained AND the live lists were " +
      "rebuilt from it' — the panel's own completed sweep satisfies exactly that, and leaving it " +
      "false is what put the missing-asset scan back into over-report-safe mode (#610)",
  );
});

test("#1193: a combo refresh abandoned with NO completed rebuild still fails, and names the bound it was given", async () => {
  const timers = virtualTimers();
  const { registerComfyNodeDefs, getConfirmed } = buildRegisterComfyNodeDefs({
    appValue: APP_WITH_GRAPH,
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
    timers,
    reapplyDefsToLiveNodes: sweepThatStopsPartWay(),
  });
  const running = registerComfyNodeDefs(undefined);
  await drainMicrotasks();
  timers.fireAll();
  const verdict = await orFail(running, "the combo phase never gave up");

  assert.equal(verdict.refreshed, false, "nothing is known to have rebuilt the lists, so nothing may claim they are current");
  assert.equal(verdict.reason, "combo_refresh_failed");
  assert.equal(getConfirmed(), false);
  // Distinguishability: the refusal has to separate "starved down to a sliver by a slow
  // fetch" from "given the whole budget and hung anyway". Both used to produce the same
  // sentence, so neither the user nor a later reader could tell which had happened.
  assert.match(
    verdict.detail,
    new RegExp(`did not answer within the \\d+ms this refresh had left of its ${NODE_DEFS_RUN_BUDGET_MS}ms budget`),
    "the refusal names the bound this phase was actually given, and the budget it came out of",
  );
});

test("#1193: a sweep that FINISHED but skipped a combo does NOT license the disclosure", async () => {
  // The gate's finding, at the level that grants the trust. `refreshComboOptionsFromDefs`
  // handles the shapes it can derive a list from; a remote V2 or a dynamic V3 is walked
  // past — and `completed` is set either way, because the WALK finished. Reading only
  // `completed` claimed `refreshed: true` and set nodeDefsRefreshConfirmed over combo
  // lists that had never been touched, which SUPPRESSES a genuine missing model whose
  // deleted file is still sitting in the stale list (asset-staleness.test.mjs drives that
  // consequence end to end).
  //
  // So the panel asks `comboRebuildCovered`, which needs finished AND skipped-nothing.
  const timers = virtualTimers();
  const { registerComfyNodeDefs, getConfirmed } = buildRegisterComfyNodeDefs({
    appValue: APP_WITH_GRAPH,
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
    timers,
    reapplyDefsToLiveNodes: sweepThatFinishesButSkips(),
  });
  const running = registerComfyNodeDefs(undefined);
  await drainMicrotasks();
  timers.fireAll();
  const verdict = await orFail(running, "the combo phase never gave up");

  assert.equal(verdict.refreshed, false, "an uncovered graph must not be reported as refreshed");
  assert.equal(verdict.reason, "combo_refresh_failed");
  assert.equal(verdict.combo_refresh_confirmed, undefined, "and it must not carry the disclosure either");
  assert.equal(
    getConfirmed(),
    false,
    "trusting the live combos here is what suppresses a genuine missing asset — the one direction this must never fail in",
  );
});

test("#1193: a combo refresh that THREW is still a failure, whatever the local rebuild did", async () => {
  // The guard is on ABANDONMENT, not on "the combo phase did not succeed". A throw is the
  // frontend reporting that something is wrong — evidence — where a timeout is only the
  // absence of an answer. Broadening this to every non-success would swallow the first.
  const { registerComfyNodeDefs, getConfirmed } = buildRegisterComfyNodeDefs({
    appValue: {
      graph: { _nodes: [] },
      registerNodesFromDefs: async () => {},
      refreshComboInNodes: async () => {
        throw new Error("reloadNodeDefs blew up");
      },
    },
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
    reapplyDefsToLiveNodes: sweepThatCompletes(),
  });
  const verdict = await orFail(registerComfyNodeDefs(undefined), "the combo phase never settled");

  assert.equal(verdict.refreshed, false, "a throw is not a missing confirmation");
  assert.equal(verdict.reason, "combo_refresh_failed");
  assert.match(verdict.detail, /reloadNodeDefs blew up/);
  assert.equal(getConfirmed(), false);
});

test("#1193: the disclosure survives the refresh_nodes reply's field whitelist", async () => {
  // #981/#1172/#1275 each lost a verdict field here, because the refreshed:true branch is
  // a fixed object literal. A verdict-level test cannot see that: it passes while the
  // agent receives nothing.
  const refresh_nodes = buildRefreshNodes(async () => ({
    refreshed: true,
    reason: "refreshed",
    combo_refresh_confirmed: false,
    combo_refresh_note: "the frontend call had not answered",
  }));
  const reply = await refresh_nodes();
  assert.equal(reply.refreshed, true);
  assert.equal(reply.combo_refresh_confirmed, false, "dropped by the whitelist — the agent is told nothing");
  assert.equal(reply.combo_refresh_note, "the frontend call had not answered");
});

test("#1193: a confirmed run says nothing about a confirmation it did not miss", async () => {
  const refresh_nodes = buildRefreshNodes(async () => ({ refreshed: true, reason: "refreshed" }));
  const reply = await refresh_nodes();
  assert.equal(reply.refreshed, true);
  assert.ok(
    !("combo_refresh_confirmed" in reply),
    "the disclosure must appear only when there is something to disclose, or it becomes noise on every reply",
  );
});

test("#1180: a REAL error survives a later stall — the synthesized timeout must not speak for it", async () => {
  // Round 2 added a separate `sawRealError` flag rather than testing `lastRealError !==
  // null`, because `throw null` and `throw undefined` are failures a backend can really
  // produce — this file's own "#635: a FALSY thrown value still counts as a failure" exists
  // for that. The flag's PURPOSE went untested: replacing it with a null check passed the
  // entire suite, and the cost is a wrong remedy. A backend that refuses the connection and
  // is then merely slow would report "did not answer" instead of what actually happened, so
  // the user is sent after a timeout while the real cause goes unmentioned.
  const timers = virtualTimers();
  let calls = 0;
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: {
      getNodeDefs: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return new Promise(() => {}); // …and then the connection goes half-open
      },
    },
    timers,
  });
  const running = registerComfyNodeDefs(undefined);
  // Drain unconditionally rather than waiting for the first armed timer. `withTimeout` arms
  // its bound SYNCHRONOUSLY, before the promise it bounds has had a chance to reject, so
  // stopping at "a timer exists" catches attempt one's — and firing that one turns the very
  // real error this test is about into a stall, which is the outcome it exists to rule out.
  // Attempt one's timer is cleared when it rejects, so after the drain only attempt two's
  // is left.
  await drainMicrotasks(300);
  assert.equal(timers.armed().length, 1, "the second attempt must be bounded, and only it");
  timers.fireAll();
  const verdict = await orFail(running, "the retried fetch never gave up");

  assert.equal(verdict.reason, "object_info_fetch_failed");
  assert.match(
    verdict.detail,
    /Failed to fetch/,
    "the first REAL error must be what the verdict reports",
  );
  assert.doesNotMatch(
    verdict.detail,
    /did not answer/,
    "a synthesized timeout must not stand in for a failure the backend actually named",
  );
  assert.equal(calls, 2, "an abandoned attempt ends the loop — it is still downloading");
});

test("#1180: a FALSY throw is still a real error — the flag cannot be read off the value", async () => {
  // The end-to-end half of "#635: a FALSY thrown value still counts as a failure". `throw
  // null` and `throw undefined` are failures a backend can really produce, so deriving the
  // presence flag from the thrown VALUE (`sawRealError = !!err`) forgets them, and the
  // synthesized "did not answer" then speaks for a failure the backend actually named.
  //
  // Structural assertions could not see this: the declaration, the preference and the
  // message are all still there under that mutation. Only running the ordering shows it.
  const timers = virtualTimers();
  let calls = 0;
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: {
      getNodeDefs: async () => {
        calls += 1;
        if (calls === 1) throw null; // a real failure whose value is falsy
        return new Promise(() => {}); // …then the connection goes half-open
      },
    },
    timers,
  });
  const running = registerComfyNodeDefs(undefined);
  await drainMicrotasks(300);
  assert.equal(timers.armed().length, 1, "the second attempt must be bounded");
  timers.fireAll();
  const verdict = await orFail(running, "the retried fetch never gave up");

  assert.equal(verdict.reason, "object_info_fetch_failed");
  assert.equal(
    verdict.detail,
    undefined,
    "a null throw carries no detail to report — and must not be replaced by a timeout that did not happen",
  );
});

test("#1180: registerNodesFromDefs stays UNBOUNDED, deliberately", () => {
  // The one await on this path with no time limit, and it must stay that way. `withTimeout`
  // cannot cancel, so a bound would let the run continue with `defsRegistered = true` for a
  // registration still in progress and send reapplyDefsToLiveNodes at classes that have not
  // been minted — a corrupted registry reported as a good one.
  //
  // Checked against the frontend build this ComfyUI serves (comfyui-frontend-package
  // 1.48.7): ComfyUI's own `registerNodes()` awaits this same call during startup, so a
  // hook that hangs it has already hung the page's own load. There is nothing here for a
  // bound to rescue.
  //
  // Asserted because "add a bound" is the obvious-looking change, and it passes every other
  // test in this file.
  assert.match(
    SRC,
    /^\s*await a\.registerNodesFromDefs\(defs\);$/m,
    "the registration call must be awaited bare — see the comment above it before changing this",
  );
});

test("#1180: with two real errors before a stall, the LAST one is reported", async () => {
  // Which of several real errors reaches the user is a genuine degree of freedom, and it was
  // decided twice differently: `fetchNodeDefsWithRetry` rethrows the LAST error and says so
  // in its own test name, while the panel used to keep the FIRST. Two rules for one sequence,
  // neither of them exercised — swapping the panel to first-wins passed the whole suite.
  //
  // They agree now, on the module's rule: the most recent thing the backend said is the most
  // likely to still be true, and a user reading the remedy is acting on it now.
  const timers = virtualTimers();
  let calls = 0;
  const { registerComfyNodeDefs } = buildRegisterComfyNodeDefs({
    appValue: FULL_APP,
    apiValue: {
      getNodeDefs: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("connection refused");
        if (calls === 2) throw new TypeError("502 from the proxy");
        return new Promise(() => {}); // …and then it stops answering entirely
      },
    },
    timers,
  });
  const running = registerComfyNodeDefs(undefined);
  await drainMicrotasks(400);
  assert.equal(timers.armed().length, 1, "the third attempt must be bounded");
  timers.fireAll();
  const verdict = await orFail(running, "the retried fetch never gave up");

  assert.equal(verdict.reason, "object_info_fetch_failed");
  assert.match(verdict.detail, /502 from the proxy/, "the most recent real failure is the one to report");
  assert.doesNotMatch(verdict.detail, /connection refused/, "…not the one the backend has since moved on from");
  assert.equal(calls, 3, "both cheap failures were retried; the stall ended the loop");
});

test("#1180: a combo refresh that rejects with a FALSY value is still a failure", async () => {
  // #635's hole, reopened at the combo site. `if (!thrown) phase = "done"` reads the failure
  // off the thrown VALUE, and `throw null` / `throw undefined` are failures a backend can
  // really produce — so a falsy rejection advanced the phase to "done" and disappeared from
  // the verdict's `failed` test.
  //
  // The `!comboRan` backstop still names combo_refresh_failed, which is exactly why this was
  // invisible: the reason came out right while the phase was wrong. Asserting the phase is
  // what catches it, so this checks the remedy text that only the combo phase produces.
  const { registerComfyNodeDefs, getConfirmed } = buildRegisterComfyNodeDefs({
    appValue: {
      graph: null,
      registerNodesFromDefs: async () => {},
      refreshComboInNodes: async () => {
        throw null; // a real failure whose value carries nothing
      },
    },
    apiValue: { getNodeDefs: async () => ({ SomeNode: {} }) },
  });
  const verdict = await registerComfyNodeDefs(undefined);

  assert.equal(verdict.refreshed, false);
  assert.equal(verdict.reason, "combo_refresh_failed", "a falsy rejection is still a combo failure");
  assert.match(verdict.remedy, /combo lists/, "…and gets the combo remedy, not the registration one");
  assert.doesNotMatch(
    verdict.remedy,
    /re-registering the node definitions failed/,
    "registration succeeded here — blaming it is the defect this phase guard exists to prevent",
  );
  assert.equal(getConfirmed(), false, "an unrefreshed combo list must not be trusted");
});
