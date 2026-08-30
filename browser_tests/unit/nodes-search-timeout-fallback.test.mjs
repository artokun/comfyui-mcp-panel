/**
 * #2099 — panel_search_nodes query "DaSiWa" waited out the 15s Manager budget
 * and returned supported:false / managerReachable:false / count:0, even when
 * DaSiWa_SeedControl was already loaded in /object_info.
 *
 * The shipped behaviour:
 *   1. A Manager command-budget abort still searches installed nodes via the
 *      injected /object_info map, with a signal that is NOT the aborted budget.
 *   2. A local hit is returned as installed-only (source: object_info). It is
 *      never dressed as a Manager catalogue row.
 *   3. A timeout miss is a retryable named reason, not an empty hang.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  searchNodesVia,
  parseObjectInfoSearch,
  MANAGER_SEARCH_TIMEOUT,
  OBJECT_INFO_SEARCH_FALLBACK_MS,
} from "../../web/js/lib/manager-install.js";

const PANEL = readFileSync(fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");

const UNREACHABLE = new Error("ComfyUI-Manager not reachable (is the built-in Manager enabled?)");

/** The reporter's missing class, plus a neighbour from the same pack. */
const DASIVA_OBJECT_INFO = {
  DaSiWa_SeedControl: {
    display_name: "DaSiWa Seed Control",
    category: "DaSiWa",
    description: "Seed control from ComfyUI-DaSiWa-Nodes",
    python_module: "custom_nodes.ComfyUI-DaSiWa-Nodes",
  },
  DaSiWa_NodeStatusSwitch: {
    display_name: "DaSiWa Node Status Switch",
    category: "DaSiWa",
    description: "",
    python_module: "custom_nodes.ComfyUI-DaSiWa-Nodes",
  },
  KSampler: { display_name: "KSampler", category: "sampling", description: "" },
};

function abortError(message = "Manager request aborted") {
  return Object.assign(new Error(message), { name: "AbortError" });
}

function hangingManagerGet() {
  return async (_route, { signal } = {}) =>
    new Promise((_, reject) => {
      let fallbackTimer;
      const abort = () => {
        clearTimeout(fallbackTimer);
        reject(abortError());
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      fallbackTimer = setTimeout(
        () => reject(new Error("test fallback fired before the internal budget")),
        250,
      );
    });
}

test("#2099 parseObjectInfoSearch locates DaSiWa_SeedControl for query DaSiWa", () => {
  const r = parseObjectInfoSearch(DASIVA_OBJECT_INFO, "DaSiWa", 15);
  assert.equal(r.count, 2);
  assert.equal(
    r.results.some((row) => row.id === "DaSiWa_SeedControl"),
    true,
  );
  assert.equal(r.results.every((row) => row.installed === true), true);
});

test("#2099 a Manager timeout still returns the installed DaSiWa_SeedControl hit", async () => {
  const budget = AbortSignal.timeout(25);
  let objectInfoCalls = 0;
  let objectInfoSignalAbortedAtCall = null;
  const managerCall = async () => {
    throw new Error("legacy fallback must not run after the search budget aborts");
  };
  const res = await searchNodesVia(hangingManagerGet(), managerCall, {
    query: "DaSiWa",
    objectInfoGet: async ({ signal } = {}) => {
      objectInfoCalls += 1;
      objectInfoSignalAbortedAtCall = signal?.aborted === true;
      return DASIVA_OBJECT_INFO;
    },
    budgetSignal: budget,
    timeoutMs: 25,
  });

  assert.equal(objectInfoCalls, 1, "timeout must still consult /object_info");
  assert.equal(
    objectInfoSignalAbortedAtCall,
    false,
    "the installed-node fallback must not inherit the aborted Manager budget",
  );
  assert.equal(res.supported, true);
  assert.equal(res.managerReachable, false);
  assert.equal(res.source, "object_info");
  assert.equal(res.installedOnly, true);
  assert.equal(res.managerTimedOut, true);
  assert.equal(res.catalogue_size, undefined, "must not invent a Manager catalogue");
  assert.equal(res.requested_mode, undefined);
  assert.ok(res.results.some((row) => row.id === "DaSiWa_SeedControl"));
  assert.equal(
    res.results.some((row) => row.id === "https://github.com/darksidewalker/ComfyUI-DaSiWa-Nodes"),
    false,
    "must not invent a Manager pack URL",
  );
  assert.match(res.message, /INSTALLED/i);
  assert.match(res.message, /not a Manager/i);
});

test("#2099 a Manager timeout with no installed match is a retryable named reason", async () => {
  const budget = AbortSignal.timeout(25);
  const managerCall = async () => {
    throw new Error("legacy fallback must not run after the search budget aborts");
  };
  const started = Date.now();
  const res = await searchNodesVia(hangingManagerGet(), managerCall, {
    query: "DaSiWa",
    objectInfoGet: async () => ({ KSampler: { display_name: "KSampler" } }),
    budgetSignal: budget,
    timeoutMs: 25,
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, `timeout miss must settle promptly, took ${elapsed} ms`);
  assert.equal(res.supported, false);
  assert.equal(res.managerReachable, false);
  assert.equal(res.count, 0);
  assert.deepEqual(res.results, []);
  assert.equal(res.retryable, true);
  assert.equal(res.reason_code, MANAGER_SEARCH_TIMEOUT);
  assert.match(res.reason, /timed out after 25 ms/);
  assert.match(res.message, /Retry/i);
  assert.equal(res.source, undefined, "a miss must not claim an object_info hit");
});

test("#2099 an unreachable Manager still locates DaSiWa_SeedControl locally", async () => {
  const boom = async () => {
    throw UNREACHABLE;
  };
  const res = await searchNodesVia(boom, boom, {
    query: "DaSiWa",
    objectInfoGet: async () => DASIVA_OBJECT_INFO,
  });
  assert.equal(res.supported, true);
  assert.equal(res.source, "object_info");
  assert.equal(res.installedOnly, true);
  assert.ok(res.results.some((row) => row.id === "DaSiWa_SeedControl"));
  assert.equal(res.managerTimedOut, undefined);
  assert.equal(res.catalogue_size, undefined);
});

test("#2099 OBJECT_INFO_SEARCH_FALLBACK_MS fits the remaining bridge slack", () => {
  // 15s Manager budget + this window must stay under the 20s read reply.
  assert.ok(OBJECT_INFO_SEARCH_FALLBACK_MS > 0);
  assert.ok(OBJECT_INFO_SEARCH_FALLBACK_MS <= 5000);
});

test("#2099 WIRING: nodes_search still goes through searchNodesVia with fetchObjectInfo", () => {
  const fnMatch = PANEL.match(/async nodes_search\(\{ query, limit \}\) \{[\s\S]*?\n  \},/);
  assert.ok(fnMatch, "could not locate the production nodes_search handler");
  assert.match(fnMatch[0], /return searchNodesVia\(managerGet, managerCall,/);
  assert.match(fnMatch[0], /objectInfoGet: fetchObjectInfo/);
  assert.match(fnMatch[0], /budgetSignal/);
});
