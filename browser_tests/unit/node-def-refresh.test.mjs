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
import { fetchNodeDefsWithRetry } from "../../web/js/lib/object-info-retry.js";

/** #716 — records invalidate() calls so a test can assert the refresh drops the cache. */
let cacheInvalidations = 0;
const cacheSpy = { invalidate: () => { cacheInvalidations += 1; }, read: async (f) => f() };

import {
  describeNodeDefRefresh,
  NODE_DEF_REFRESH_REASONS,
} from "../../web/js/lib/node-def-refresh.js";

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
  const factory = new Function(
    "refreshComfyNodeDefs",
    `return (${body.replace(/^async refresh_nodes\(\)/, "async function refresh_nodes()")});`,
  );
  return factory(refreshImpl);
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
    /nodeDefsRefreshConfirmed = !didThrow && !!defs && comboRan;/,
    "the shared global stays a strict boolean (concurrent-run trust gate unchanged)",
  );
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

function buildRegisterComfyNodeDefs({ appValue, apiValue }) {
  const body = extractFunction("async function registerComfyNodeDefs(");
  const factory = new Function(
    "app",
    "api",
    "recordObjectInfoTypes",
    "reapplyDefsToLiveNodes",
    "describeNodeDefRefresh",
    // #954 — the REAL retry, not a stub. The shipping function now fetches through it, and
    // a harness that substituted a pass-through would stop proving what this file exists to
    // prove: that the shipped code produces these verdicts.
    "fetchNodeDefsWithRetry",
    "objectInfoCache",
    `let nodeDefsRefreshConfirmed = false;
     ${body}
     return { registerComfyNodeDefs, getConfirmed: () => nodeDefsRefreshConfirmed };`,
  );
  return factory(
    appValue,
    apiValue,
    () => ({}),
    () => {},
    describeNodeDefRefresh,
    // No real waiting: the delays are the shipped ones, the sleep is not.
    (getDefs) => fetchNodeDefsWithRetry(getDefs, { sleep: async () => {} }),
    // #716 — the shipping function drops the widget-write burst cache after a successful
    // fetch. A spy, so the harness can prove that happens rather than merely tolerate it.
    cacheSpy,
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
  const body = extractFunction("async function registerComfyNodeDefs(");
  const factory = new Function(
    "app",
    "api",
    "recordObjectInfoTypes",
    "reapplyDefsToLiveNodes",
    "describeNodeDefRefresh",
    // #954 — the REAL retry, not a stub. The shipping function now fetches through it, and
    // a harness that substituted a pass-through would stop proving what this file exists to
    // prove: that the shipped code produces these verdicts.
    "fetchNodeDefsWithRetry",
    "objectInfoCache",
    `let nodeDefsRefreshConfirmed = false;
     ${body}
     return { registerComfyNodeDefs };`,
  );
  const { registerComfyNodeDefs: registerWithThrowingRecorder } = factory(
    {
      graph: null,
      registerNodesFromDefs: async () => {
        registerCalls += 1;
      },
      refreshComboInNodes: async () => {},
    },
    { getNodeDefs: async () => ({ SomeNode: {} }) },
    () => {
      throw new Error("history exploded");
    },
    () => {},
    describeNodeDefRefresh,
    // No real waiting: the shipped delays, an instant sleep.
    (getDefs) => fetchNodeDefsWithRetry(getDefs, { sleep: async () => {} }),
    // #716 — the shipping function drops the widget-write burst cache after a successful
    // fetch. A spy, so the harness can prove that happens rather than merely tolerate it.
    cacheSpy,
  );
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
  const body = extractFunction("async function registerComfyNodeDefs(");
  const factory = new Function(
    "app",
    "api",
    "recordObjectInfoTypes",
    "reapplyDefsToLiveNodes",
    "describeNodeDefRefresh",
    // #954 — the REAL retry, not a stub. The shipping function now fetches through it, and
    // a harness that substituted a pass-through would stop proving what this file exists to
    // prove: that the shipped code produces these verdicts.
    "fetchNodeDefsWithRetry",
    "objectInfoCache",
    `let nodeDefsRefreshConfirmed = false;
     ${body}
     return { registerComfyNodeDefs, getConfirmed: () => nodeDefsRefreshConfirmed };`,
  );
  const { registerComfyNodeDefs, getConfirmed } = factory(
    {
      graph: null,
      registerNodesFromDefs: async () => {},
      refreshComboInNodes: async () => {},
    },
    { getNodeDefs: async () => ({ SomeNode: {} }) },
    () => {
      throw null; // a falsy throw — must still read as a failed run
    },
    () => {},
    describeNodeDefRefresh,
    // No real waiting: the shipped delays, an instant sleep.
    (getDefs) => fetchNodeDefsWithRetry(getDefs, { sleep: async () => {} }),
    // #716 — the shipping function drops the widget-write burst cache after a successful
    // fetch. A spy, so the harness can prove that happens rather than merely tolerate it.
    cacheSpy,
  );
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
