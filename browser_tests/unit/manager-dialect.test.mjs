// Unit tests for #605: the Manager dialect cache must not stay stale after a
// backend restart swaps Manager generations (3.x ↔ pip v4) under a live tab.
// Covers the pure retry ladder (dialectRetryTarget) directly, then drives the
// REAL panel source (managerProbe / detectManagerDialect / reProbeManagerDialect
// / managerGet / nodes_install / graph_update_node) extracted from
// comfyui-mcp-panel.js against stubbed transports — the same extraction pattern
// manager-install.test.mjs uses, so a missing binding or a deleted heal fails
// here instead of in the browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyManager404 } from "../../web/js/lib/manager-404.js";

import * as ManagerInstall from "../../web/js/lib/manager-install.js";
const {
  dialectRetryTarget,
  isManagerRouteMissing,
  isManagerUnreachable,
  isMethodNotAllowed,
  legacyUpdateBody,
  assertBatchOk,
  classifyUpdateOutcome,
  taskFailureReason,
} = ManagerInstall;

const UNREACHABLE = "ComfyUI-Manager not reachable (is the built-in Manager enabled?)";
const QUEUE_STATUS = { total_count: 0, done_count: 0, is_processing: false };

/** The error managerCall/managerV2 throw for a PROVEN route-level rejection
 *  (HTTP 404): the same message, tagged managerRouteMissing. Mutations may be
 *  re-sent on this and ONLY this (codex P0). */
const routeMissing = () => Object.assign(new Error(UNREACHABLE), { managerRouteMissing: true });

function readPanelSource() {
  const panelPath = fileURLToPath(
    new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  );
  return readFileSync(panelPath, "utf8");
}

function pick(src, re, name) {
  const m = src.match(re);
  assert.ok(m, `could not locate ${name} in panel source`);
  return m[0];
}

const okJson = (payload) => ({ ok: true, text: async () => JSON.stringify(payload) });
const notFound = () => ({ ok: false, status: 404, text: async () => "" });

// ---------------------------------------------------------------------------
// Pure retry ladder (#605)
// ---------------------------------------------------------------------------

test("dialectRetryTarget: a CHANGED fresh probe wins (stale cache after a restart)", () => {
  assert.equal(dialectRetryTarget("legacy", "v2"), "v2", "stale legacy → live v4 (#605)");
  assert.equal(dialectRetryTarget("legacy", "v2-batch"), "v2-batch");
  assert.equal(dialectRetryTarget("v2", "legacy"), "legacy", "stale v2 → live 3.x");
  assert.equal(dialectRetryTarget("v2-batch", "v2"), "v2");
});

test("dialectRetryTarget: re-probe agrees (or Manager silent) → legacy last resort for pip dialects (#485)", () => {
  assert.equal(dialectRetryTarget("v2", "v2"), "legacy");
  assert.equal(dialectRetryTarget("v2-batch", "v2-batch"), "legacy");
  assert.equal(dialectRetryTarget("v2", null), "legacy");
  assert.equal(dialectRetryTarget("v2-batch", null), "legacy");
});

test("dialectRetryTarget: legacy-on-legacy has no fallback left (null → surface the original error)", () => {
  assert.equal(dialectRetryTarget("legacy", "legacy"), null);
  assert.equal(dialectRetryTarget("legacy", null), null);
});

test("isManagerRouteMissing: ONLY the proven-404 marker qualifies a mutation retry (codex P0)", () => {
  assert.equal(isManagerRouteMissing(routeMissing()), true, "the tagged 404");
  // The SAME message without the marker is the ambiguous no-response case —
  // it must NOT authorize re-sending a mutation.
  assert.equal(isManagerRouteMissing(new Error(UNREACHABLE)), false);
  assert.equal(isManagerRouteMissing(new Error("Manager manager/queue/install: HTTP 404")), false);
  assert.equal(isManagerRouteMissing(new Error("Manager x: HTTP 405")), false);
  assert.equal(isManagerRouteMissing(null), false);
  assert.equal(isManagerRouteMissing(undefined), false);
  // ...while the broad GET-fallback predicate still matches the message shape.
  assert.equal(isManagerUnreachable(new Error(UNREACHABLE)), true);
});

/** #423 (review P1) — build managerV2/managerCall over a fetchApi that REJECTS. */
function buildTransportsOverRejectingFetch(thrown) {
  const src = readPanelSource();
  const factory = new Function(
    "api",
    "classifyManager404",
    "markManagerUnreachable",
    "managerFetchFailureMessage",
    "MANAGER_FETCH_TIMEOUT_MS",
    "AbortSignal",
    `${pick(src, /function anyAbortSignal\(signals\) \{[\s\S]*?\n\}/, "anyAbortSignal")}
${pick(src, /async function managerV2\(route, \{ method = "GET", body, signal \} = \{\}\) \{[\s\S]*?\n\}/, "managerV2")}
${pick(src, /async function managerCall\(route, \{ method = "GET", body, signal \} = \{\}\) \{[\s\S]*?\n\}/, "managerCall")}
return { managerV2, managerCall };`,
  );
  return factory(
    {
      fetchApi: async () => {
        throw thrown;
      },
    },
    classifyManager404,
    ManagerInstall.markManagerUnreachable,
    (route, err) => `Manager ${route} could not be delivered: ${err?.message}`,
    15000,
    AbortSignal,
  );
}

// #423, second blind spot (review P1). A REJECTED fetch — as opposed to a null response —
// escaped the ladder twice over: managerV2 wrapped it untagged, and managerCall had no
// catch at all, so "Failed to fetch" propagated raw. Neither wording has ever matched the
// gate, so a transport failure skipped the legacy retry AND the /object_info fallback that
// exists for exactly this case.
test("managerV2/managerCall tag a REJECTED fetch — but never as route-missing", async () => {
  const { managerV2: mv2, managerCall: mcall } = buildTransportsOverRejectingFetch(
    new TypeError("Failed to fetch"),
  );
  for (const call of [mv2, mcall]) {
    const err = await call("customnode/installed").then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof Error, "must reject with an Error");
    assert.ok(isManagerUnreachable(err), "the idempotent-GET fallback ladder must see it");
    // The safety boundary, and the reason tagging this is allowed at all: a rejection
    // proves nothing about delivery, so it must never authorize re-sending a MUTATION.
    assert.equal(isManagerRouteMissing(err), false, "a rejection is not a proven 404");
  }
});

test("an aborted Manager fetch is still the caller's own — never an unreachable verdict", async () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const { managerV2: mv2, managerCall: mcall } = buildTransportsOverRejectingFetch(abort);
  for (const call of [mv2, mcall]) {
    const err = await call("customnode/installed").then(
      () => null,
      (e) => e,
    );
    assert.equal(err, abort, "passes through unchanged");
    assert.notEqual(err.managerTransportUnreachable, true, "and is never tagged");
  }
});

// The marker itself is minted by the REAL transports — extract them and prove:
// a 404 response tags the error; a no-response (null) failure does NOT.
test("managerV2/managerCall tag a 404 as managerRouteMissing, never the no-response case", async () => {
  const src = readPanelSource();
  // #706 — the extracted functions now depend on the classifyManager404 helper,
  // so it is injected the same way `api` is. Injecting the REAL implementation
  // (not a stub) keeps this a real-source harness.
  const factory = new Function(
    "api",
    "classifyManager404",
    // #423 — the transports now TAG their no-response throw so the fallback ladder
    // recognises it without reading the (translated) message. Real implementation,
    // same as classifyManager404.
    "markManagerUnreachable",
    "managerFetchFailureMessage",
    "MANAGER_FETCH_TIMEOUT_MS",
    "AbortSignal",
    `${pick(src, /function anyAbortSignal\(signals\) \{[\s\S]*?\n\}/, "anyAbortSignal")}
${pick(src, /async function managerV2\(route, \{ method = "GET", body, signal \} = \{\}\) \{[\s\S]*?\n\}/, "managerV2")}
${pick(src, /async function managerCall\(route, \{ method = "GET", body, signal \} = \{\}\) \{[\s\S]*?\n\}/, "managerCall")}
return { managerV2, managerCall };`,
  );
  for (const res of [
    { status: 404, ok: false, text: async () => "" }, // route not registered → proven rejection
    null, // no response → ambiguous
  ]) {
    const { managerV2: mv2, managerCall: mcall } = factory(
      { fetchApi: async () => res },
      classifyManager404,
      ManagerInstall.markManagerUnreachable,
      (route, err) => `Manager ${route} could not be delivered: ${err?.message}`,
      15000,
      AbortSignal,
    );
    for (const call of [mv2, mcall]) {
      const err = await call("manager/queue/status").then(
        () => null,
        (e) => e,
      );
      assert.ok(err, "must throw");
      assert.match(err.message, /not reachable/);
      assert.equal(
        isManagerRouteMissing(err),
        res !== null && res.status === 404,
        `marker only for the proven 404 (res=${JSON.stringify(res)})`,
      );
      // #423 — whichever way it failed, the fallback ladder must be able to SEE it
      // without reading the sentence. The 404 branch carries managerRouteMissing;
      // the no-response branch is tagged by the transport itself. A translated
      // message disarmed every rung of the ladder for 11 of 12 shipped locales.
      assert.ok(
        isManagerRouteMissing(err) || err.managerTransportUnreachable === true,
        `structurally recognisable (res=${JSON.stringify(res)})`,
      );
    }
  }

  // #706 — the ONE 404 that must NOT carry the marker: legacy Manager 3.x
  // answers a security-gated operation with 404 + a refusal body. A handler ran
  // and said no, so authorizing a #605 mutation re-send would re-submit an
  // install the Manager already rejected.
  {
    const secRes = {
      status: 404,
      ok: false,
      text: async () => "A security error has occurred. Please check the terminal logs",
    };
    const { managerV2: mv2, managerCall: mcall } = factory(
      { fetchApi: async () => secRes },
      classifyManager404,
      ManagerInstall.markManagerUnreachable,
      (route, err) => `Manager ${route} could not be delivered: ${err?.message}`,
      15000,
      AbortSignal,
    );
    for (const call of [mv2, mcall]) {
      const err = await call("manager/queue/install").then(
        () => null,
        (e) => e,
      );
      assert.ok(err, "must throw");
      assert.equal(isManagerRouteMissing(err), false, "a security refusal must not authorize a re-send");
      assert.ok(!/not reachable/i.test(err.message), "must not claim the Manager is unreachable");
      assert.match(err.message, /security gate/i);
    }
  }

  // A 404 whose body cannot be read stays route-missing (pre-#706 behaviour) —
  // we may not claim a refusal we cannot evidence.
  {
    const brokenBody = {
      status: 404,
      ok: false,
      text: async () => {
        throw new Error("stream already consumed");
      },
    };
    const { managerV2: mv2 } = factory(
      { fetchApi: async () => brokenBody },
      classifyManager404,
      ManagerInstall.markManagerUnreachable,
      (route, err) => `Manager ${route} could not be delivered: ${err?.message}`,
      15000,
      AbortSignal,
    );
    const err = await mv2("manager/queue/status").then(
      () => null,
      (e) => e,
    );
    assert.ok(err, "must throw");
    assert.equal(isManagerRouteMissing(err), true, "unreadable body falls back to route-missing");
  }
});

// ---------------------------------------------------------------------------
// Real-source harness: cache + detection + re-probe + managerGet
// ---------------------------------------------------------------------------

function buildDialectHarness({ fetchApi, managerCall, managerV2, AbortSignalImpl = AbortSignal }) {
  const src = readPanelSource();
  const factory = new Function(
    "api",
    "managerCall",
    "managerV2",
    "isManagerUnreachable",
    "markManagerUnreachable",
    "dialectRetryTarget",
    "MANAGER_FETCH_TIMEOUT_MS",
    "AbortSignal",
    `let managerDialectCache = null;
${pick(src, /function looksLikeQueueStatus\(s\) \{[\s\S]*?\n\}/, "looksLikeQueueStatus")}
${pick(src, /function anyAbortSignal\(signals\) \{[\s\S]*?\n\}/, "anyAbortSignal")}
${pick(src, /async function managerProbe\(route, \{ signal \} = \{\}\) \{[\s\S]*?\n\}/, "managerProbe")}
${pick(src, /async function detectManagerDialect\(\{ signal \} = \{\}\) \{[\s\S]*?\n\}/, "detectManagerDialect")}
${pick(src, /function invalidateManagerDialectCache\(\) \{[\s\S]*?\n\}/, "invalidateManagerDialectCache")}
${pick(src, /async function reProbeManagerDialect\(\{ signal \} = \{\}\) \{[\s\S]*?\n\}/, "reProbeManagerDialect")}
${pick(src, /async function managerGet\(route, \{ signal \} = \{\}\) \{[\s\S]*?\n\}/, "managerGet")}
return { managerGet, getDialectCache: () => managerDialectCache };`,
  );
  return factory(
    { fetchApi },
    managerCall,
    managerV2,
    isManagerUnreachable,
    ManagerInstall.markManagerUnreachable,
    dialectRetryTarget,
    15000,
    AbortSignalImpl,
  );
}

/** A fake backend whose Manager generation can be swapped mid-test (the
 *  restart). `mode`: "legacy" (3.x), "v4" (pip normal), "down" (mid-restart). */
function fakeBackend(modeRef) {
  const probes = [];
  const fetchApi = async (route) => {
    probes.push(route);
    const mode = modeRef.mode;
    if (mode === "legacy") {
      return route === "/manager/queue/status" ? okJson(QUEUE_STATUS) : notFound();
    }
    if (mode === "v4") {
      if (route === "/v2/manager/queue/status") return okJson(QUEUE_STATUS);
      if (route === "/v2/manager/is_legacy_manager_ui") return okJson({ is_legacy_manager_ui: false });
      return notFound();
    }
    return notFound(); // "down" — nothing answers
  };
  return { fetchApi, probes };
}

test("#605: stale 'legacy' cache self-heals to v4 after a backend restart (the issue's repro)", async () => {
  const modeRef = { mode: "legacy" };
  const { fetchApi, probes } = fakeBackend(modeRef);
  const calls = [];
  const managerCall = async (route) => {
    calls.push(["legacy", route]);
    if (modeRef.mode !== "legacy") throw new Error(UNREACHABLE); // v4 dropped the 3.x routes
    return { servedBy: "legacy", route };
  };
  const managerV2 = async (route) => {
    calls.push(["v2", route]);
    if (modeRef.mode !== "v4") throw new Error(UNREACHABLE);
    return { servedBy: "v4", route };
  };
  const h = buildDialectHarness({ fetchApi, managerCall, managerV2 });

  // 1. On the 3.x backend the list routes legacy and caches "legacy".
  const first = await h.managerGet("customnode/installed?mode=default");
  assert.equal(first.servedBy, "legacy");
  assert.equal(h.getDialectCache(), "legacy");

  // 2. The backend RESTARTS to pip v4 with the tab alive — the stale cache
  // routes the GET at /customnode/installed, which 404s. The heal must
  // invalidate, re-probe the LIVE backend, and re-issue the SAME route on /v2.
  modeRef.mode = "v4";
  const healed = await h.managerGet("customnode/installed?mode=default");
  assert.equal(healed.servedBy, "v4", "the re-probed dialect must serve the list");
  assert.equal(healed.route, "customnode/installed?mode=default", "same route, re-issued");
  assert.equal(h.getDialectCache(), "v2", "the live verdict is re-pinned");
  assert.deepEqual(
    calls.filter(([d]) => d === "legacy").length,
    2, // phase 1 + the one route-level rejection in phase 2
    "the stale attempt is the ONLY extra legacy call",
  );

  // 3. A later call uses the re-pinned dialect directly — no re-probe storm.
  const probeCount = probes.length;
  const third = await h.managerGet("manager/queue/status");
  assert.equal(third.servedBy, "v4");
  assert.equal(probes.length, probeCount, "no re-probe once the cache is truthful");
});

test("#605: re-probe that AGREES falls back to the legacy absolute route (#423 hybrid preserved)", async () => {
  const modeRef = { mode: "v4" };
  const { fetchApi } = fakeBackend(modeRef);
  const calls = [];
  // The hybrid shape: /v2 probe answers, but the /v2 DATA GET 404s while the
  // absolute legacy route serves fine.
  const managerV2 = async (route) => {
    calls.push(["v2", route]);
    throw new Error(UNREACHABLE);
  };
  const managerCall = async (route) => {
    calls.push(["legacy", route]);
    return { servedBy: "legacy", route };
  };
  const h = buildDialectHarness({ fetchApi, managerCall, managerV2 });
  const res = await h.managerGet("customnode/installed?mode=default");
  assert.equal(res.servedBy, "legacy", "the legacy absolute route is the last resort");
  assert.equal(res.route, "customnode/installed?mode=default");
  assert.deepEqual(calls.map(([d]) => d), ["v2", "legacy"], "one routed attempt, one fallback");
});

test("#605: a non-unreachable error propagates WITHOUT a re-probe (not a dialect signal)", async () => {
  const modeRef = { mode: "v4" };
  const { fetchApi, probes } = fakeBackend(modeRef);
  let legacyCalls = 0;
  const managerV2 = async () => {
    throw new Error("Manager manager/queue/status: HTTP 500");
  };
  const managerCall = async () => {
    legacyCalls += 1;
    throw new Error(UNREACHABLE);
  };
  const h = buildDialectHarness({ fetchApi, managerCall, managerV2 });
  await assert.rejects(() => h.managerGet("manager/queue/status"), /HTTP 500/);
  const probeCount = probes.length;
  await assert.rejects(() => h.managerGet("manager/queue/status"), /HTTP 500/);
  assert.equal(probes.length, probeCount, "a 500 must not buy a re-probe");
  assert.equal(legacyCalls, 0, "a 500 must not fall back to legacy");
});

test("#605: Manager answering NO dialect surfaces the ORIGINAL error and leaves the cache empty", async () => {
  const modeRef = { mode: "legacy" };
  const { fetchApi } = fakeBackend(modeRef);
  const managerCall = async (route) => {
    if (modeRef.mode !== "legacy") throw new Error(UNREACHABLE);
    return { servedBy: "legacy", route };
  };
  const managerV2 = async (route) => ({ servedBy: "v4", route });
  const h = buildDialectHarness({ fetchApi, managerCall, managerV2 });

  await h.managerGet("manager/queue/status"); // seeds cache "legacy"
  assert.equal(h.getDialectCache(), "legacy");

  // Mid-restart: nothing answers any dialect. The stale attempt's OWN error is
  // the one with the operation's context — the detection failure must not
  // replace it.
  modeRef.mode = "down";
  await assert.rejects(
    () => h.managerGet("manager/queue/status"),
    (err) => {
      assert.equal(err.message, UNREACHABLE, "the original routed error surfaces");
      return true;
    },
  );
  assert.equal(h.getDialectCache(), null, "a failed re-probe never re-pins the stale value");

  // When the backend comes back as v4, the empty cache re-probes and heals.
  modeRef.mode = "v4";
  const healed = await h.managerGet("manager/queue/status");
  assert.equal(healed.servedBy, "v4");
  assert.equal(h.getDialectCache(), "v2");
});

// A fetch stub whose promise settles ONLY via the caller's abort signal — but
// backed by a real (ref'd) setTimeout fallback so the test process's event loop
// stays alive on Node versions where AbortSignal.timeout's timer is unref'd
// (CI runs Node 22; without this, pending tests get "event loop has already
// resolved"). If the abort wiring regresses, the 2s fallback fails the test
// with a clear message instead of a runner-level cancellation.
function hangingUntilAbort(opts) {
  return new Promise((_, reject) => {
    const hung = setTimeout(() => reject(new Error("probe never aborted (hung)")), 2000);
    const onAbort = () => {
      clearTimeout(hung);
      reject(new Error("This operation was aborted"));
    };
    if (opts?.signal?.aborted) return onAbort();
    opts?.signal?.addEventListener("abort", onAbort);
  });
}

test("#605 codex r4: a cache-MISS entry detection is bounded by the caller's signal too", async () => {
  // Fresh cache: EVERY probe hangs until its signal fires. A managerGet under a
  // tight caller budget must fail fast, not stack 15s probes.
  const fetchApi = (_route, opts) => hangingUntilAbort(opts);
  const h = buildDialectHarness({
    fetchApi,
    managerCall: async () => ({}),
    managerV2: async () => ({}),
  });
  const start = Date.now();
  await assert.rejects(
    () => h.managerGet("manager/queue/history?ui_id=x", { signal: AbortSignal.timeout(150) }),
    /aborted mid-probe/,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `entry detection must abort with the caller's signal (took ${elapsed}ms)`);
  assert.equal(h.getDialectCache(), null, "an aborted detection caches nothing");
});

test("#605 codex r4: an aborted legacy-UI sub-probe is never pinned as a 'v2' verdict", async () => {
  // The /v2 status probe answers, but the is_legacy_manager_ui probe hangs
  // until the caller's signal fires. Detection must bail WITHOUT caching —
  // committing "v2" here would misroute v2-batch mutations to the task route
  // (which 405s on legacy-UI builds).
  const fetchApi = (route, opts) => {
    if (route === "/v2/manager/queue/status") return Promise.resolve(okJson(QUEUE_STATUS));
    return hangingUntilAbort(opts);
  };
  const h = buildDialectHarness({
    fetchApi,
    managerCall: async () => ({}),
    managerV2: async () => ({}),
  });
  await assert.rejects(
    () => h.managerGet("manager/queue/status", { signal: AbortSignal.timeout(150) }),
    /aborted mid-probe/,
  );
  assert.equal(h.getDialectCache(), null, "no verdict from a partial reading");
});

test("#605 codex r5: the heal works on a runtime WITHOUT AbortSignal.any (fallback combiner)", async () => {
  // A frontend with AbortSignal.timeout but no AbortSignal.any: a missing API
  // here would be swallowed inside managerProbe and silently disable the heal —
  // the exact #605 false "not reachable". The fallback combiner must keep the
  // whole flow working (and bounded).
  const NoAnyAbortSignal = {
    timeout: (ms) => AbortSignal.timeout(ms),
    // no .any
  };
  const modeRef = { mode: "legacy" };
  const { fetchApi } = fakeBackend(modeRef);
  const managerCall = async (route) => {
    if (modeRef.mode !== "legacy") throw routeMissing();
    return { servedBy: "legacy", route };
  };
  const managerV2 = async (route) => ({ servedBy: "v4", route });
  const h = buildDialectHarness({
    fetchApi,
    managerCall,
    managerV2,
    AbortSignalImpl: NoAnyAbortSignal,
  });

  await h.managerGet("customnode/installed?mode=default"); // seeds "legacy"
  assert.equal(h.getDialectCache(), "legacy");

  modeRef.mode = "v4"; // the restart — stale cache, 3.x routes 404
  const healed = await h.managerGet("customnode/installed?mode=default");
  assert.equal(healed.servedBy, "v4", "the heal works without AbortSignal.any");
  assert.equal(h.getDialectCache(), "v2");
});

test("#605 codex r3: the managerGet re-probe aborts with the CALLER's signal (waitForUpdateResult budget)", async () => {
  // Phase 1 seeds a cached dialect with answering probes; phase 2's probes HANG
  // until their signal fires. The routed GET 404s fast (a proven route-level
  // rejection mid-restart) — the heal's re-probe must abort with the caller's
  // remaining budget, not stack 15s probes past it.
  let hanging = false;
  const fetchApi = (route, opts) => {
    if (!hanging) {
      return Promise.resolve(route === "/manager/queue/status" ? okJson(QUEUE_STATUS) : notFound());
    }
    return hangingUntilAbort(opts);
  };
  const managerCall = async (route) => {
    if (hanging) throw routeMissing();
    return { servedBy: "legacy", route };
  };
  const managerV2 = async () => {
    throw routeMissing();
  };
  const h = buildDialectHarness({ fetchApi, managerCall, managerV2 });
  await h.managerGet("manager/queue/status"); // seeds cache "legacy"
  assert.equal(h.getDialectCache(), "legacy");

  hanging = true;
  const start = Date.now();
  await assert.rejects(
    () => h.managerGet("manager/queue/history?ui_id=x", { signal: AbortSignal.timeout(150) }),
    /not reachable/i,
  );
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed < 5000,
    `the re-probe must abort with the caller's signal, not stack 15s probes (took ${elapsed}ms)`,
  );
});

// ---------------------------------------------------------------------------
// Wiring guards: the lifecycle invalidation + both mutation paths
// ---------------------------------------------------------------------------

test("#605: the backend 'reconnected' listener invalidates the dialect cache", () => {
  const src = readPanelSource();
  const m = src.match(/addEventListener\("reconnected"[\s\S]*?\}\s*\);/);
  assert.ok(m, "could not locate the reconnected listener");
  assert.ok(
    m[0].includes("invalidateManagerDialectCache()"),
    "a backend restart (socket re-established) must drop the cached dialect",
  );
});

test("#605: nodes_install re-probes the dialect on an unreachable submit before retrying", () => {
  const src = readPanelSource();
  const m = src.match(/async nodes_install\(args\) \{[\s\S]*?\n  \},\r?\n/);
  assert.ok(m, "could not locate nodes_install");
  assert.ok(m[0].includes("reProbeManagerDialect"), "nodes_install must re-probe on unreachable");
  assert.ok(m[0].includes("dialectRetryTarget"), "nodes_install must pick the retry via the ladder");
});

test("#605: graph_update_node re-probes on unreachable and never re-sends a landed enqueue", () => {
  const src = readPanelSource();
  const m = src.match(/async graph_update_node\(\{ id, version, channel, mode \}\) \{[\s\S]*?\n  \},\r?\n/);
  assert.ok(m, "could not locate graph_update_node");
  assert.ok(m[0].includes("reProbeManagerDialect"), "graph_update_node must re-probe on unreachable");
  assert.ok(m[0].includes("dialectRetryTarget"), "graph_update_node must pick the retry via the ladder");
  assert.ok(m[0].includes("enqueued"), "the retry must be gated on the enqueue NOT having landed");
});

// ---------------------------------------------------------------------------
// Real-source harness: graph_update_node (the mutation path)
// ---------------------------------------------------------------------------

function buildGraphUpdateNode(deps) {
  const src = readPanelSource();
  const methodSrc = pick(
    src,
    /async graph_update_node\(\{ id, version, channel, mode \}\) \{[\s\S]*?\n  \},\r?\n/,
    "graph_update_node",
  );
  const factory = new Function(
    ...Object.keys(deps),
    `const handlers = { ${methodSrc} };\nreturn handlers.graph_update_node;`,
  );
  return factory(...Object.values(deps));
}

function graphUpdateDeps(overrides) {
  return {
    detectManagerDialect: async () => "legacy",
    resolveManagerUpdateTarget: async (id) => id,
    crypto: { randomUUID: () => "u-1" },
    api: { clientId: "c-1" },
    legacyUpdateBody,
    managerCall: async () => {
      throw new Error(UNREACHABLE);
    },
    managerV2: async () => ({}),
    isMethodNotAllowed,
    assertBatchOk,
    isManagerUnreachable,
    isManagerRouteMissing,
    dialectRetryTarget,
    // #367 — the panel records a dialect the LIVE backend demonstrated by completing an
    // enqueue on it. Harmless here; asserted directly in its own test below.
    noteManagerDialectDowngrade: () => {},
    reProbeManagerDialect: async () => "v2",
    waitForUpdateResult: async () => ({
      item: { ui_id: "u-1", status: { status_str: "success", completed: true, messages: [] } },
      status: QUEUE_STATUS,
    }),
    classifyUpdateOutcome,
    // #1320 — finalizeUpdate reads the log only on a generic Manager failure.
    // Dialect tests stub waitForUpdateResult to a success, so these stay quiet.
    isGenericManagerUpdateError: () => false,
    readUpdateTraceback: async () => null,
    taskFailureReason,
    ...overrides,
  };
}

test("#605: graph_update_node with a stale 'legacy' cache re-probes and updates through live v4", async () => {
  const calls = [];
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      managerCall: async (route) => {
        calls.push(["legacy", route]);
        throw routeMissing(); // the restarted v4 backend dropped the 3.x routes (proven 404)
      },
      managerV2: async (route) => {
        calls.push(["v2", route]);
        return {};
      },
    }),
  );
  const res = await update({ id: "some-pack" });
  assert.equal(res.updated, true, "the v4 task success is reported");
  assert.equal(res.verified, true);
  assert.equal(res.dialect, "v2", "the result names the dialect the update ACTUALLY used");
  assert.deepEqual(
    calls,
    [
      ["legacy", "manager/queue/update"], // the route-level rejection — nothing ran
      ["v2", "manager/queue/task"], // the healed re-enqueue
      ["v2", "manager/queue/start"],
    ],
    "exactly one enqueue lands, on the live dialect",
  );
});

test("codex P0: an AMBIGUOUS enqueue failure (no response) never re-sends the update", async () => {
  const calls = [];
  let reprobes = 0;
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      detectManagerDialect: async () => "legacy",
      managerCall: async (route) => {
        calls.push(route);
        // Same "not reachable" TEXT as a 404 but NO marker: a lost response
        // says nothing about whether the POST landed.
        throw new Error(UNREACHABLE);
      },
      reProbeManagerDialect: async () => {
        reprobes += 1;
        return "v2";
      },
    }),
  );
  await assert.rejects(() => update({ id: "some-pack" }), /not reachable/);
  assert.deepEqual(calls, ["manager/queue/update"], "the ambiguous POST is not re-sent anywhere");
  assert.equal(reprobes, 0, "no re-probe, no retry, no second dialect");
});

test("#605: graph_update_node never re-enqueues after the task POST landed (start failure surfaces)", async () => {
  const calls = [];
  let reprobes = 0;
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      detectManagerDialect: async () => "v2",
      managerV2: async (route) => {
        calls.push(route);
        if (route === "manager/queue/start") throw routeMissing();
        return {};
      },
      reProbeManagerDialect: async () => {
        reprobes += 1;
        return "legacy";
      },
    }),
  );
  await assert.rejects(() => update({ id: "some-pack" }), /not reachable/);
  assert.deepEqual(calls, ["manager/queue/task", "manager/queue/start"], "no second task POST");
  assert.equal(reprobes, 0, "a landed enqueue is never re-probed for a retry");
});

test("#605: the legacy update POST landing is tracked too — a start failure after it never re-fires", async () => {
  const calls = [];
  let reprobes = 0;
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      detectManagerDialect: async () => "legacy",
      managerCall: async (route) => {
        calls.push(route);
        if (route === "manager/queue/start") throw routeMissing();
        return {};
      },
      reProbeManagerDialect: async () => {
        reprobes += 1;
        return "v2"; // a heal WOULD switch dialect — it must not get the chance
      },
    }),
  );
  await assert.rejects(() => update({ id: "some-pack" }), /not reachable/);
  assert.deepEqual(
    calls,
    ["manager/queue/update", "manager/queue/start"],
    "the landed legacy update is not re-sent",
  );
  assert.equal(reprobes, 0, "no re-probe once the update has landed");
});

test("#605: graph_update_node legacy-on-legacy unreachable surfaces the original error (no retry left)", async () => {
  const calls = [];
  let reprobes = 0;
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      detectManagerDialect: async () => "legacy",
      reProbeManagerDialect: async () => {
        reprobes += 1;
        return "legacy"; // the probe AGREES
      },
      managerCall: async (route) => {
        calls.push(route);
        throw routeMissing();
      },
    }),
  );
  await assert.rejects(
    () => update({ id: "some-pack" }),
    (err) => {
      assert.equal(err.message, UNREACHABLE);
      return true;
    },
  );
  assert.deepEqual(calls, ["manager/queue/update"], "the rejected enqueue is not repeated");
  assert.equal(reprobes, 1, "one re-probe, then the ladder gives up");
});

test("#424: a 405 on the /v2 envelope still lands on the legacy self-update route (via marker)", async () => {
  // #367 reordered the ladder to v2 → v2-batch → legacy. The legacy landing this test
  // exists for is unchanged; it is now reached after the batch route is TRIED, because a
  // 405 on `queue/task` makes v2-batch the candidate worth one POST on a backend whose
  // /v2 routes answer. It is only a candidate: here managerV2 405s every route, so the
  // batch rung is refused too, legacy wins, and nothing is cached.
  const calls = [];
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      detectManagerDialect: async () => "v2",
      managerV2: async (route) => {
        calls.push(["v2", route]);
        throw new Error(`Manager ${route}: HTTP 405`); // frontend catchall
      },
      managerCall: async (route) => {
        calls.push(["legacy", route]);
        return {};
      },
    }),
  );
  const res = await update({ id: "comfyui-manager" });
  assert.equal(res.via, "legacy-self-update", "the 405 fallback is named");
  assert.equal(res.dialect, "legacy", "the result names the dialect the update ACTUALLY used");
  assert.equal(res.pending, true, "a legacy update reports honest pending (no per-task history)");
  assert.deepEqual(
    calls,
    [
      ["v2", "manager/queue/task"], // method-rejected — nothing landed
      ["v2", "manager/queue/batch"], // #367 rung: also method-rejected here
      ["legacy", "manager/queue/update"],
      ["legacy", "manager/queue/start"],
    ],
  );
});

test("codex r2: a route-404 from the 405-fallback's legacy POST heals through the ladder", async () => {
  const calls = [];
  let mode = "legacy-ui-v4"; // 405s the /v2 task POST; serves legacy routes…
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      detectManagerDialect: async () => "v2",
      reProbeManagerDialect: async () => "v2", // …until the restart lands normal v4
      managerV2: async (route) => {
        calls.push(["v2", route]);
        if (mode === "legacy-ui-v4") throw new Error(`Manager ${route}: HTTP 405`);
        return {};
      },
      managerCall: async (route) => {
        calls.push(["legacy", route]);
        // The restart to normal v4 lands BEFORE the legacy fallback POST: the
        // 3.x routes are gone (proven 404, nothing ran).
        mode = "v4";
        throw routeMissing();
      },
    }),
  );
  const res = await update({ id: "comfyui-manager" });
  assert.equal(res.updated, true, "the healed v4 update is verified");
  assert.equal(res.dialect, "v2", "the result names the live dialect");
  assert.equal(res.via, undefined, "the legacy via marker is cleared after the heal");
  assert.deepEqual(
    calls,
    [
      ["v2", "manager/queue/task"], // 405 — nothing landed
      ["v2", "manager/queue/batch"], // #367 rung — 405 too on this build
      ["legacy", "manager/queue/update"], // 404 after the restart — nothing landed
      ["v2", "manager/queue/task"], // healed re-enqueue on the live v4
      ["v2", "manager/queue/start"],
    ],
    "exactly one update lands, on the live dialect",
  );
});

test("#367: a v4 that 405s queue/task updates through BATCH, not legacy", async () => {
  // The reported backend: built-in Manager v4 whose /v2 GETs (installed/list/status)
  // all answer, but POST /v2/manager/queue/task returns 405. Detection reads
  // /v2/manager/is_legacy_manager_ui to split v2 from v2-batch, and this build does not
  // report a legacy UI — so it is classified "v2" and every attempt re-POSTs the one
  // route it refuses. Update was unusable with a working batch route sitting unused.
  const calls = [];
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      detectManagerDialect: async () => "v2",
      managerV2: async (route) => {
        calls.push(["v2", route]);
        if (route === "manager/queue/task") throw new Error(`Manager ${route}: HTTP 405`);
        return {}; // batch and start are served
      },
      managerCall: async (route) => {
        calls.push(["legacy", route]);
        throw routeMissing(); // a pip v4 does not serve the un-prefixed 3.x routes
      },
    }),
  );
  const res = await update({ id: "ComfyUI-LTXVideo", version: "nightly" });
  assert.equal(res.queued, true, "the update must be queued instead of erroring");
  assert.equal(res.dialect, "v2-batch", "and name the dialect it actually used");
  assert.equal(res.via, undefined, "this is not a legacy self-update");
  // Honest, and unchanged by this fix: the batch dialect exposes no per-task result,
  // so the outcome cannot be auto-verified. Queued-and-pending is the correct answer
  // for this backend — the bug was that it returned HTTP 405 instead of an answer.
  assert.equal(res.pending, true, "a batch update reports honest pending");
  assert.equal(res.verified, false);
  assert.deepEqual(
    calls,
    [
      ["v2", "manager/queue/task"], // 405 — method-rejected, nothing landed
      ["v2", "manager/queue/batch"], // the rung #367 adds
      ["v2", "manager/queue/start"],
    ],
    "it must never reach the legacy routes a pip v4 does not serve",
  );
});

test("#367: a dialect that WORKED is recorded so the refused route is not re-POSTed", async () => {
  // Detection got it wrong from the probe. What corrects it is not the 405 — that is
  // only a candidate — but the batch enqueue LANDING, which is what this fixture does.
  // Without recording that, every later call pays the refused POST again, which is what
  // "the tool immediately errors" looked like.
  const noted = [];
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      detectManagerDialect: async () => "v2",
      noteManagerDialectDowngrade: (d) => noted.push(d),
      managerV2: async (route) => {
        if (route === "manager/queue/task") throw new Error(`Manager ${route}: HTTP 405`);
        return {};
      },
    }),
  );
  await update({ id: "ComfyUI-LTXVideo" });
  assert.deepEqual(noted, ["v2-batch"], "a batch enqueue that LANDED must update the cached dialect");
});

test("#367: a build that refuses BOTH /v2 mutations caches nothing and lands on legacy", async () => {
  // The case that makes the cache write dangerous (codex): `queue/task` 405s, and so
  // does `batch`. Recording v2-batch on the first 405 would leave this backend — which
  // updates FINE on legacy — permanently cached at a route it refuses, re-paying that
  // POST on every later call. The heal only runs on a route-MISSING verdict, not a 405,
  // so nothing would clear it.
  const noted = [];
  const calls = [];
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      detectManagerDialect: async () => "v2",
      noteManagerDialectDowngrade: (d) => noted.push(d),
      managerV2: async (route) => {
        calls.push(["v2", route]);
        throw new Error(`Manager ${route}: HTTP 405`);
      },
      managerCall: async (route) => {
        calls.push(["legacy", route]);
        return {};
      },
    }),
  );
  const res = await update({ id: "comfyui-manager" });
  assert.equal(res.dialect, "legacy", "legacy is where this backend actually works");
  assert.deepEqual(noted, [], "a dialect that never worked must not be cached");
  assert.deepEqual(calls, [
    ["v2", "manager/queue/task"],
    ["v2", "manager/queue/batch"],
    ["legacy", "manager/queue/update"],
    ["legacy", "manager/queue/start"],
  ]);
});

test("#367: task 405 then batch 404 heals through the ladder rather than caching", async () => {
  // A 404 on batch is a route-level rejection, not a method one, so it takes the
  // existing re-probe ladder instead of the legacy rung. Either way nothing is cached
  // from a route that never ran an enqueue.
  const noted = [];
  const update = buildGraphUpdateNode(
    graphUpdateDeps({
      detectManagerDialect: async () => "v2",
      reProbeManagerDialect: async () => "legacy",
      noteManagerDialectDowngrade: (d) => noted.push(d),
      managerV2: async (route) => {
        if (route === "manager/queue/task") throw new Error(`Manager ${route}: HTTP 405`);
        throw routeMissing();
      },
      managerCall: async () => ({}),
    }),
  );
  const res = await update({ id: "comfyui-manager" });
  assert.equal(res.dialect, "legacy");
  assert.deepEqual(noted, [], "an enqueue that never landed must not be cached");
});

// ---------------------------------------------------------------------------
// Real-source harness: nodes_install (the mutation path)
// ---------------------------------------------------------------------------

function buildNodesInstall(deps) {
  const src = readPanelSource();
  const methodSrc = pick(src, /async nodes_install\(args\) \{[\s\S]*?\n  \},\r?\n/, "nodes_install");
  const factory = new Function(
    ...Object.keys(deps),
    `const handlers = { ${methodSrc} };\nreturn handlers.nodes_install;`,
  );
  return factory(...Object.values(deps));
}

function nodesInstallDeps(overrides) {
  return {
    installGitUrl: ManagerInstall.installGitUrl,
    buildInstallRequest: ManagerInstall.buildInstallRequest,
    detectManagerDialect: async () => "legacy",
    crypto: { randomUUID: () => "u-1" },
    api: { clientId: "c-1" },
    MANAGER_FETCH_TIMEOUT_MS: 15000,
    AbortSignal,
    managerV2: async () => ({}),
    managerCall: async () => ({}),
    isManagerUnreachable,
    isManagerRouteMissing,
    dialectRetryTarget,
    // #671: the command budget + stall classifier the extracted nodes_install
    // now closes over. A generous budget keeps these tests on their original
    // code paths (no stall translation); the budget behavior itself is covered
    // in manager-install.test.mjs. The classifier mirrors the production
    // isStallError: abort-primitive names + detect's own mid-probe abort ONLY —
    // never a message-regex that would swallow a real Manager verdict.
    NODES_INSTALL_COMMAND_BUDGET_MS: 25000,
    isStallError: (err) =>
      err?.name === "AbortError" ||
      err?.name === "TimeoutError" ||
      String(err?.message ?? "").startsWith("ComfyUI-Manager dialect detection was aborted mid-probe"),
    reProbeManagerDialect: async () => "v2",
    managerQueueControl: async () => {},
    verifyInstalled: async () => ({ state: "installed", status: QUEUE_STATUS }),
    // comfyui-mcp#1606 — the ui_id ↔ pack correlation the handler records so a
    // captured Manager failure can name what it was installing. A REAL log, so
    // a regression in that call surfaces here instead of hitting a no-op stub.
    managerTaskResults: ManagerInstall.createManagerTaskResultLog(),
    ...overrides,
  };
}

test("#605: nodes_install with a stale 'legacy' cache re-probes and installs through live v4", async () => {
  const calls = [];
  const install = buildNodesInstall(
    nodesInstallDeps({
      managerCall: async (route) => {
        calls.push(["legacy", route]);
        throw routeMissing(); // the restarted v4 backend dropped the 3.x routes (proven 404)
      },
      managerV2: async (route) => {
        calls.push(["v2", route]);
        return {};
      },
    }),
  );
  const res = await install({ id: "some-pack" });
  assert.equal(res.installed, true);
  assert.equal(res.verified, true);
  assert.equal(res.dialect, "v2", "the result names the dialect the install ACTUALLY used");
  assert.deepEqual(
    calls,
    [
      ["legacy", "manager/queue/install"], // the route-level rejection — nothing enqueued
      ["v2", "manager/queue/task"], // the healed re-submit
    ],
    "exactly one submit lands, on the live dialect",
  );
});

test("codex P0: nodes_install never re-submits on an AMBIGUOUS (no-response) failure", async () => {
  const calls = [];
  let reprobes = 0;
  const install = buildNodesInstall(
    nodesInstallDeps({
      detectManagerDialect: async () => "legacy",
      managerCall: async (route) => {
        calls.push(route);
        throw new Error(UNREACHABLE); // unmarked: the POST may have landed
      },
      reProbeManagerDialect: async () => {
        reprobes += 1;
        return "v2";
      },
    }),
  );
  await assert.rejects(() => install({ id: "some-pack" }), /not reachable/);
  assert.deepEqual(calls, ["manager/queue/install"], "the ambiguous POST is not re-sent anywhere");
  assert.equal(reprobes, 0, "no re-probe, no retry, no second dialect");
});

test("#485 regression: a v2-batch unreachable submit still falls back to legacy when the re-probe agrees", async () => {
  const calls = [];
  const install = buildNodesInstall(
    nodesInstallDeps({
      detectManagerDialect: async () => "v2-batch",
      reProbeManagerDialect: async () => "v2-batch", // the probe AGREES (hybrid build)
      managerV2: async (route) => {
        calls.push(["v2", route]);
        throw routeMissing(); // hybrid: /v2 mutation routes not registered (proven 404)
      },
      managerCall: async (route) => {
        calls.push(["legacy", route]);
        return {};
      },
    }),
  );
  const res = await install({ id: "some-pack" });
  assert.equal(res.installed, true);
  assert.equal(res.dialect, "legacy", "the #485 legacy last resort still fires");
  assert.deepEqual(
    calls,
    [
      ["v2", "manager/queue/batch"],
      ["legacy", "manager/queue/install"],
    ],
    "one rejected batch submit, then the legacy absolute submit",
  );
});

test("#605: nodes_install legacy-on-legacy unreachable surfaces the original error (no retry left)", async () => {
  const calls = [];
  const install = buildNodesInstall(
    nodesInstallDeps({
      detectManagerDialect: async () => "legacy",
      reProbeManagerDialect: async () => "legacy",
      managerCall: async (route) => {
        calls.push(route);
        throw routeMissing();
      },
    }),
  );
  await assert.rejects(
    () => install({ id: "some-pack" }),
    (err) => {
      assert.equal(err.message, UNREACHABLE);
      return true;
    },
  );
  assert.deepEqual(calls, ["manager/queue/install"], "the rejected submit is not repeated");
});

// ── #920: a repository URL must reach Manager, not be reduced to an id ──────
//
// buildInstallRequest's v2 git branch sent `id: gitRepoName(url)` and dropped the URL, so
// a from-source install became a registry lookup and Manager answered:
//
//   Node 'ComfyUI-SolAttn_triton@nightly' not found in
//     [ManagerChannel.dev, ManagerDatabaseSource.cache]
//
// both sources being that branch's own channel:"dev" and mode:"cache" defaults.
//
// The field is read from Manager's installed model, not inferred:
//
//   class InstallPackParams(ManagerPackInfo):
//     repository: Optional[str] = Field(
//       None, description="GitHub repository URL (required if selected_version is nightly)")

const GIT_URL = "https://github.com/kijai/ComfyUI-SolAttn_triton.git";

test("#920: a repository-only nightly install carries the URL", () => {
  const req = ManagerInstall.buildInstallRequest("v2", { repository: GIT_URL, version: "nightly" }, "u-1");
  assert.equal(req.params.repository, GIT_URL, "the URL must reach Manager");
  assert.equal(req.params.selected_version, "nightly", "and nightly is what makes it required");
});

test("#920: the id stays the derived NAME, not the URL", () => {
  // Sending a URL as `id` made v4 silently mark the install done while doing nothing,
  // which is why it was derived. That behaviour is preserved — this only stops the URL
  // being discarded.
  const req = ManagerInstall.buildInstallRequest("v2", { repository: GIT_URL, version: "nightly" }, "u-1");
  assert.equal(req.params.id, "ComfyUI-SolAttn_triton");
  assert.notEqual(req.params.id, GIT_URL);
});

test("#920: a URL passed as `id` is carried too — same routing, either field", () => {
  const req = ManagerInstall.buildInstallRequest("v2", { id: GIT_URL, version: "nightly" }, "u-1");
  assert.equal(req.params.repository, GIT_URL);
  assert.equal(req.params.id, "ComfyUI-SolAttn_triton");
});

test("#920: a REGISTRY install is untouched — no repository field invented", () => {
  const req = ManagerInstall.buildInstallRequest("v2", { id: "comfyui-impact-pack", version: "1.2.3" }, "u-1");
  assert.equal(req.params.repository, undefined, "a non-git install must not carry one");
  assert.equal(req.params.id, "comfyui-impact-pack");
});
