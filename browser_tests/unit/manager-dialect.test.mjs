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

import * as ManagerInstall from "../../web/js/lib/manager-install.js";
const {
  dialectRetryTarget,
  isManagerRouteMissing,
  isManagerUnreachable,
  isMethodNotAllowed,
  legacyUpdateBody,
  assertBatchOk,
  classifyUpdateOutcome,
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

// The marker itself is minted by the REAL transports — extract them and prove:
// a 404 response tags the error; a no-response (null) failure does NOT.
test("managerV2/managerCall tag a 404 as managerRouteMissing, never the no-response case", async () => {
  const src = readPanelSource();
  const factory = new Function(
    "api",
    `${pick(src, /async function managerV2\(route, \{ method = "GET", body, signal \} = \{\}\) \{[\s\S]*?\n\}/, "managerV2")}
${pick(src, /async function managerCall\(route, \{ method = "GET", body, signal \} = \{\}\) \{[\s\S]*?\n\}/, "managerCall")}
return { managerV2, managerCall };`,
  );
  for (const res of [
    { status: 404, ok: false }, // route not registered → proven rejection
    null, // no response → ambiguous
  ]) {
    const { managerV2: mv2, managerCall: mcall } = factory({ fetchApi: async () => res });
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
    }
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
    reProbeManagerDialect: async () => "v2",
    waitForUpdateResult: async () => ({
      item: { ui_id: "u-1", status: { status_str: "success", completed: true, messages: [] } },
      status: QUEUE_STATUS,
    }),
    classifyUpdateOutcome,
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
      ["legacy", "manager/queue/update"], // 404 after the restart — nothing landed
      ["v2", "manager/queue/task"], // healed re-enqueue on the live v4
      ["v2", "manager/queue/start"],
    ],
    "exactly one update lands, on the live dialect",
  );
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
