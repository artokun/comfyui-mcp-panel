/**
 * Unit tests for #584/#611 — stale panel bundle detection + module-cache priming.
 *
 * The pack on disk can be current while a browser tab keeps running a CACHED
 * older bundle (heuristic static-file caching survives restarts and plain
 * reloads); the stale bundle then advertises old/unknown capabilities and the
 * orchestrator's write fence refuses every mutation. These lock the verdict
 * (never reload on an unreadable probe) and the cache priming crawl (visits the
 * pack's whole static module graph with cache:"reload", stays inside the pack
 * dir, bounded and cycle-safe).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  collectRelativeImportSpecifiers,
  primeModuleCache,
  resolveBundleStaleness,
} from "../../web/js/lib/bundle-version.js";

test("resolveBundleStaleness: equal versions are current", () => {
  assert.equal(resolveBundleStaleness({ running: "0.11.39", installed: "0.11.39" }), "current");
});

test("resolveBundleStaleness: different versions are stale — upgrade AND downgrade", () => {
  assert.equal(resolveBundleStaleness({ running: "0.11.34", installed: "0.11.39" }), "stale");
  assert.equal(resolveBundleStaleness({ running: "0.11.39", installed: "0.11.34" }), "stale");
});

test("resolveBundleStaleness: a missing/malformed probe is UNKNOWN — never evidence for a reload", () => {
  assert.equal(resolveBundleStaleness({ running: "0.11.39", installed: null }), "unknown");
  assert.equal(resolveBundleStaleness({ running: "0.11.39", installed: undefined }), "unknown");
  assert.equal(resolveBundleStaleness({ running: "0.11.39", installed: "" }), "unknown");
  assert.equal(resolveBundleStaleness({ running: "0.11.39", installed: "   " }), "unknown");
  assert.equal(resolveBundleStaleness({ running: "0.11.39", installed: 123 }), "unknown");
  assert.equal(resolveBundleStaleness({ running: "", installed: "0.11.39" }), "unknown");
  assert.equal(resolveBundleStaleness({}), "unknown");
});

test("collectRelativeImportSpecifiers: static imports/exports, relative only", () => {
  const src = [
    `import { app } from "../../scripts/app.js";`, // relative but OUT of the pack dir: the CRAWLER excludes it, the collector reports it
    `import { marked } from "./vendor/marked.esm.js";`,
    `import { a } from "./lib/a.js";`,
    `import "./lib/side-effect.js";`,
    `export { b } from "../lib/b.js";`,
    `const lit = await import("./vendor/a2ui-lit.bundle.js");`, // literal dynamic import (the #584 mixed-bundle hole)
    `import(dynamicName);`, // non-literal: unparseable, skipped
    `import lit from "lit";`, // bare specifier: not ours, never reported
    `import{min}from"./minified.js";`, // minified static import — no whitespace (codex gate round 4)
    `export{re}from"./reexport.js";`, // minified re-export
    `const x = 1; // import { fake } from "./not-real.js" — inside a comment`,
  ].join("\n");
  const specs = collectRelativeImportSpecifiers(src);
  assert.deepEqual(
    specs.sort(),
    [
      "../../scripts/app.js",
      "../lib/b.js",
      "./lib/a.js",
      "./lib/side-effect.js",
      "./minified.js",
      "./reexport.js",
      "./vendor/a2ui-lit.bundle.js",
      "./vendor/marked.esm.js",
    ].sort(),
  );
  assert.deepEqual(collectRelativeImportSpecifiers(""), []);
  assert.deepEqual(collectRelativeImportSpecifiers(null), []);
});

// A fake module graph for the crawl: entry → lib/a → lib/b (+cycle back to a),
// entry → vendor/v, a DYNAMIC import of vendor/dyn, and an out-of-pack import
// that must NOT be fetched.
const GRAPH = {
  "https://host/extensions/pack/panel.js":
    `import { a } from "./lib/a.js";\nimport { v } from "./vendor/v.js";\nimport { app } from "../../scripts/app.js";\nconst d = await import("./vendor/dyn.js");`,
  "https://host/extensions/pack/lib/a.js":
    `import { b } from "./b.js";`,
  "https://host/extensions/pack/lib/b.js":
    `import { a } from "./a.js";`, // cycle
  "https://host/extensions/pack/vendor/v.js": `export const v = 1;`,
  "https://host/extensions/pack/vendor/dyn.js": `export const d = 1;`,
};

const fakeFetch =
  (graph, record, failUrls = new Set()) =>
  async (url, opts) => {
    record.push({ url, opts });
    if (failUrls.has(url) || !(url in graph)) return { ok: false, text: async () => "" };
    return { ok: true, text: async () => graph[url] };
  };

test("primeModuleCache: revalidates the whole in-pack module graph with cache:reload, cycle-safe", async () => {
  const calls = [];
  const result = await primeModuleCache({
    entryUrl: "https://host/extensions/pack/panel.js",
    fetchImpl: fakeFetch(GRAPH, calls),
  });
  assert.deepEqual(
    result.primed.sort(),
    [
      "https://host/extensions/pack/panel.js",
      "https://host/extensions/pack/lib/a.js",
      "https://host/extensions/pack/lib/b.js",
      "https://host/extensions/pack/vendor/v.js",
      "https://host/extensions/pack/vendor/dyn.js", // literal dynamic import — primed too
    ].sort(),
  );
  assert.deepEqual(result.failed, []);
  assert.equal(result.truncated, false);
  // Every fetch forced revalidation (the whole point — a normal reload reuses the stale cache entries).
  for (const c of calls) assert.equal(c.opts?.cache, "reload", `no cache:reload on ${c.url}`);
  // The out-of-pack core script is never fetched.
  assert.ok(
    !calls.some((c) => c.url.includes("/scripts/app.js")),
    "the crawl must stay inside the pack's web dir",
  );
  // Cycle: each module fetched exactly once.
  assert.equal(calls.length, 5);
});

test("primeModuleCache: a failed module is collected, not thrown — the caller decides", async () => {
  const calls = [];
  const result = await primeModuleCache({
    entryUrl: "https://host/extensions/pack/panel.js",
    fetchImpl: fakeFetch(GRAPH, calls, new Set(["https://host/extensions/pack/lib/a.js"])),
  });
  assert.deepEqual(result.failed, ["https://host/extensions/pack/lib/a.js"]);
  assert.ok(result.primed.includes("https://host/extensions/pack/panel.js"));
});

test("primeModuleCache: maxModules bounds the crawl and reports truncation", async () => {
  const calls = [];
  const result = await primeModuleCache({
    entryUrl: "https://host/extensions/pack/panel.js",
    fetchImpl: fakeFetch(GRAPH, calls),
    maxModules: 2,
  });
  assert.equal(result.truncated, true);
  assert.ok(calls.length <= 2);
});

test("primeModuleCache: a throwing fetch is collected as failed, never propagated", async () => {
  const result = await primeModuleCache({
    entryUrl: "https://host/extensions/pack/panel.js",
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(result.primed, []);
  assert.deepEqual(result.failed, ["https://host/extensions/pack/panel.js"]);
});

test("primeModuleCache: degenerate inputs are a no-op", async () => {
  assert.deepEqual(await primeModuleCache({}), { primed: [], failed: [], truncated: false });
  assert.deepEqual(await primeModuleCache({ entryUrl: "", fetchImpl: async () => null }), {
    primed: [],
    failed: [],
    truncated: false,
  });
});

// The healer itself is browser wiring (api/sessionStorage/location), so its
// safety INVARIANTS are pinned at source level (codex gate rounds 2-3):
//   - the reload-loop guard marker must be read back after ssSet — sessionStorage
//     can be unavailable, and reloading without the persisted marker loops forever;
//   - the automatic prime must be time-bounded — a hung module fetch must not
//     strand the guarded reload.
test("#584 healer invariants: loop-guard read-back and bounded prime are present in the panel source", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const arm = src.indexOf("ssSet(BUNDLE_HEAL_KEY, marker);");
  assert.notEqual(arm, -1, "the healer arms the loop guard");
  const readback = src.indexOf("ssGet(BUNDLE_HEAL_KEY) !== marker", arm);
  assert.ok(readback > arm, "the marker is read back after ssSet — no reload when the guard cannot persist");
  const healPrime = src.indexOf("primeModuleCache({", arm);
  assert.ok(healPrime > arm, "the healer primes the module cache");
  const race = src.lastIndexOf("Promise.race([", healPrime);
  assert.ok(race !== -1 && healPrime - race < 400, "the healer's prime is raced against a timeout");
  // Round 5: the probe deadline covers the BODY parse too — a response whose
  // json() never settles must not wedge setup() before registration. The pin
  // requires the timeout ENTRY, not just the race shape.
  const probeRace = src.match(
    /Promise\.race\(\[\s*probe,\s*new Promise\(\(resolve\) => setTimeout\(\(\) => resolve\(null\), \d+\)\)/,
  );
  assert.ok(probeRace, "the version probe (fetch AND body parse) is raced against a timeout entry");
  assert.ok(
    src.indexOf("return await res.json().catch(() => null);") < src.indexOf("Promise.race([\n      probe,"),
    "the body parse lives INSIDE the raced probe",
  );
  // Round 4: setup() must AWAIT the bounded probe BEFORE the panel becomes
  // available — a stale bundle that connects first would advertise its stale
  // capabilities and get fenced again inside the probe window.
  const healCall = src.indexOf("await healStaleBundleIfNeeded();");
  assert.ok(healCall !== -1, "setup awaits the staleness probe");
  assert.ok(
    healCall < src.indexOf("registerSidebarTab(tabSpec)"),
    "the probe settles before the sidebar tab registers (no stale-capability window)",
  );
});

// The setup()-time heal cannot fire for the scenario this issue keeps
// recurring with: a pack update + ComfyUI restart UNDER an already-open tab
// (panel_restart_comfyui, Manager reboot) — no page load happens, the tab
// keeps re-advertising its old version in every re-hello, and the write fence
// refuses every mutation while reads keep working. The panel already detects
// exactly that event (the "reconnected" listener invalidates the Manager
// dialect cache and node defs for the same reason); the version re-probe must
// ride the same signal.
test("#584 reconnect trigger: the reconnected listener re-probes the pack version", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // Anchor on the post-reconnect settle watch kick — unique to the listener
  // that owns the backend-restart invalidations.
  const kick = src.indexOf("kickPostReconnectSettleWatch(backendReconnectEpoch);");
  assert.notEqual(kick, -1, "the reconnected listener kicks the settle watch");
  const heal = src.indexOf("void healStaleBundleIfNeeded();", kick);
  assert.ok(heal !== -1 && heal - kick < 2000, "the version re-probe rides the same reconnect signal");
});

// A reconnect-triggered heal navigates without a user at the keyboard, so the
// healer's reload needs the same guards the commanded frontend reload got in
// #701 — and one more, because its loop-guard marker is armed BEFORE the
// navigation: a cancelled unload must not burn the tab's one heal attempt.
test("#584 healer navigation guards: unsaved-work refusal, socket-down defer, cancelled-unload recovery", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const healStart = src.indexOf("async function healStaleBundleIfNeeded()");
  assert.notEqual(healStart, -1);
  const body = src.slice(healStart, src.indexOf("\n}\n", healStart));

  // Unsaved work is detected BEFORE the marker is armed — a refused heal
  // leaves the marker un-armed so a later load/reconnect can still heal.
  const blockers = body.indexOf("unsavedReloadBlockers(app?.extensionManager?.workflow?.openWorkflows)");
  assert.notEqual(blockers, -1, "the healer consults the unsaved-work blockers");
  const arm = body.indexOf("ssSet(BUNDLE_HEAL_KEY, marker);");
  assert.ok(arm !== -1 && blockers < arm, "blockers are checked before the loop-guard marker is armed");

  // The probe + prime can span a NEW disconnect: a heal that finds the backend
  // socket down defers its navigation and UN-ARMS the marker, or the next
  // reconnect would read the attempt as spent and never retry.
  const prime = body.indexOf("primeModuleCache({");
  const socketDown = body.indexOf("if (comfyBackendIsDown())", prime);
  assert.ok(socketDown > prime, "the socket is re-checked after the prime, before navigating");
  const deferUnarm = body.indexOf("ssSet(BUNDLE_HEAL_KEY, null);", socketDown);
  assert.ok(
    deferUnarm !== -1 && deferUnarm < body.indexOf("window.location.replace", socketDown),
    "a deferred heal un-arms the marker so the next reconnect retries",
  );

  // The blocked-navigation notice is armed BEFORE navigating (same order as
  // the commanded reload path), and its fire-path un-arms the marker —
  // surviving the deadline proves the unload was cancelled, so the reload
  // never happened and the heal attempt must not be counted as spent.
  const notice = body.indexOf("armReloadBlockedNotice({");
  const navigate = body.indexOf("window.location.replace");
  assert.ok(notice !== -1 && notice < navigate, "the cancelled-navigation notice is armed before navigating");
  const noticeBlock = body.slice(notice, navigate);
  assert.ok(
    noticeBlock.includes("ssSet(BUNDLE_HEAL_KEY, null);"),
    "a provably-cancelled navigation returns the heal attempt",
  );
});
