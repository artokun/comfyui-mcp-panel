/**
 * #1956 — panel_free_vram success must say which branch ran and include the
 * occupancy numbers the shipped path actually has. `{freed:true}` alone is the
 * misleading receipt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  freeVramSuccessResult,
  readVramOccupancy,
  vramOccupancyFromStats,
} from "../../web/js/lib/vram-occupancy.js";
import { describeHttpFailure } from "../../web/js/lib/http-failure.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const MB = 1024 * 1024;
const stats = (usedMb, totalMb = 16384) => ({
  devices: [
    {
      name: "cuda:0 NVIDIA GeForce RTX 5080",
      vram_total: totalMb * MB,
      vram_free: (totalMb - usedMb) * MB,
    },
  ],
});

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const methodStart = panelSrc.indexOf("async free_vram()");
assert.ok(methodStart > 0, "free_vram executor not found");
const methodEnd = panelSrc.indexOf("\n  },", methodStart);
const methodSrc = panelSrc.slice(methodStart, methodEnd + 4);

function realFreeVram({ fetchApi, backendDown = false }) {
  const factory = new Function(
    "api",
    "describeHttpFailure",
    "comfyBackendIsDown",
    "readVramOccupancy",
    "freeVramSuccessResult",
    `const executors = { ${methodSrc} };\nreturn executors.free_vram;`,
  );
  const api = { fetchApi };
  return factory(api, describeHttpFailure, () => backendDown, readVramOccupancy, freeVramSuccessResult).call({});
}

test("#1956 occupancy parser reports used/free/total MB", () => {
  const rows = vramOccupancyFromStats(stats(4096, 16384));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vram_used_mb, 4096);
  assert.equal(rows[0].vram_free_mb, 12288);
  assert.equal(rows[0].vram_total_mb, 16384);
});

test("#1956 verified before/after includes freed_mb and the branch name", () => {
  const result = freeVramSuccessResult({
    before: vramOccupancyFromStats(stats(8000)),
    after: vramOccupancyFromStats(stats(1200)),
  });
  assert.equal(result.freed, true);
  assert.equal(result.unload_models, true);
  assert.equal(result.free_memory, true);
  assert.equal(result.branch, "verified_system_stats");
  assert.equal(result.occupancy.before_mb, 8000);
  assert.equal(result.occupancy.after_mb, 1200);
  assert.equal(result.occupancy.freed_mb, 6800);
});

test("#1956 missing occupancy is an honest bare /free receipt, still success", () => {
  const result = freeVramSuccessResult({});
  assert.equal(result.freed, true);
  assert.equal(result.branch, "bare_free_receipt");
  assert.equal(result.occupancy, undefined);
  assert.match(result.note, /\/system_stats/);
  assert.match(result.note, /no MB/);
});

test("#1956 readVramOccupancy swallows a miss rather than throwing", async () => {
  assert.equal(await readVramOccupancy(null), null);
  assert.equal(await readVramOccupancy(async () => jsonRes({}, 500)), null);
  assert.equal(
    await readVramOccupancy(async () => {
      throw new Error("Failed to fetch");
    }),
    null,
  );
});

test("#1956 shipped free_vram reports verified occupancy on a healthy /system_stats", async () => {
  const calls = [];
  const fetchApi = async (path, init) => {
    calls.push({ path, method: init?.method });
    if (path === "/system_stats") {
      const used = calls.filter((c) => c.path === "/free").length ? 500 : 4000;
      return jsonRes(stats(used));
    }
    if (path === "/free") return jsonRes({ success: true });
    throw new Error(`unexpected ${path}`);
  };
  const result = await realFreeVram({ fetchApi });
  assert.equal(result.freed, true);
  assert.equal(result.branch, "verified_system_stats");
  assert.equal(result.occupancy.before_mb, 4000);
  assert.equal(result.occupancy.after_mb, 500);
  assert.equal(result.occupancy.freed_mb, 3500);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/system_stats", "/free", "/system_stats"],
  );
});

test("#1956 shipped free_vram still succeeds when /system_stats is down — bare receipt", async () => {
  const fetchApi = async (path) => {
    if (path === "/system_stats") return jsonRes({}, 404);
    if (path === "/free") return jsonRes({ success: true });
    throw new Error(`unexpected ${path}`);
  };
  const result = await realFreeVram({ fetchApi });
  assert.equal(result.freed, true);
  assert.equal(result.branch, "bare_free_receipt");
  assert.match(result.note, /bare|not re-read|no MB/i);
});

test("#1956 shipped free_vram still fails closed on a not-ok /free", async () => {
  const fetchApi = async (path) => {
    if (path === "/system_stats") return jsonRes(stats(1000));
    if (path === "/free") return jsonRes({ error: "nope" }, 502);
    throw new Error(`unexpected ${path}`);
  };
  await assert.rejects(() => realFreeVram({ fetchApi }), /free VRAM|502/);
});

test("#1956 WIRING: free_vram returns freeVramSuccessResult, not a bare {freed:true}", () => {
  assert.match(methodSrc, /freeVramSuccessResult\(/);
  assert.doesNotMatch(
    methodSrc,
    /return \{ freed: true, unload_models: true, free_memory: true \}/,
  );
});
