// #584 — measuring what five fixes assumed.
//
// The recurring symptom is a tab running stale panel JS while its version check
// reads healthy. Every fix so far has been built on a hypothesis about the
// browser cache that nobody measured, because the only way to measure it was to
// ask a wedged user to open DevTools — which never comes back.
//
// The page already knows. PerformanceResourceTiming records, per module fetch,
// whether bytes crossed the wire. This is the classifier for that, and its whole
// job is to be trustworthy in the one direction that matters: it must never
// report "fresh" when what actually happened is "could not tell". Reporting a
// false all-clear is what would send the sixth attempt back down the same path.

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyEntry,
  describeModuleCache,
  readModuleCacheSummary,
  summarizeModuleCache,
} from "../../web/js/lib/module-cache-report.js";

const BASE = "/extensions/comfyui-mcp-panel/";
const url = (p) => `http://127.0.0.1:8188${BASE}${p}`;

/** A resource entry as the browser reports one. */
function entry(p, { transferSize = 4096, decodedBodySize = 12000, responseStatus = 200, initiatorType = "script" } = {}) {
  return { name: url(p), transferSize, decodedBodySize, responseStatus, initiatorType };
}
const fromCache = (p) => entry(p, { transferSize: 0 });

test("bytes on the wire is a network fetch; a decoded body with none is cache", () => {
  assert.equal(classifyEntry(entry("js/comfyui-mcp-panel.js")), "network");
  assert.equal(classifyEntry(fromCache("js/comfyui-mcp-panel.js")), "cached");
});

test("UNKNOWN is a distinct answer — the API not saying is not 'it was fresh'", () => {
  // Sizes are not guaranteed to be exposed.
  assert.equal(classifyEntry({ name: url("js/a.js") }), "unknown");
  assert.equal(classifyEntry({ name: url("js/a.js"), transferSize: 0 }), "unknown");
  // transferSize 0 AND no decoded body is the cross-origin/opaque shape, which
  // is byte-identical to a cache hit. Calling it "cached" would invent evidence.
  assert.equal(classifyEntry(entry("js/a.js", { transferSize: 0, decodedBodySize: 0 })), "unknown");
});

test("a healthy page reads all-network — and must not warn", () => {
  const s = summarizeModuleCache([entry("js/comfyui-mcp-panel.js"), entry("js/lib/bundle-version.js")]);
  assert.equal(s.verdict, "all-network");
  assert.equal(s.total, 2);
  assert.equal(s.cached, 0);
  // The claim is bounded to what the buffer can support (codex review): "every
  // module STILL IN THE BUFFER", never "every module".
  assert.match(describeModuleCache(s), /STILL IN THE BUFFER was fetched/);
  assert.ok(!/Every module was fetched/.test(describeModuleCache(s)), "an unbounded claim");
});

test("MIXED is the finding this issue is missing — some modules stale, version healthy", () => {
  // The exact shape that defeats a single version check: the module carrying
  // PANEL_VERSION is fresh, a sibling is not.
  const s = summarizeModuleCache([
    entry("js/comfyui-mcp-panel.js"),
    fromCache("js/lib/graph-write-fence.js"),
    fromCache("js/cmcp-apps.js"),
  ]);
  assert.equal(s.verdict, "mixed");
  assert.equal(s.cached, 2);
  const msg = describeModuleCache(s);
  // States what it OBSERVED and what that makes possible — not the conclusion.
  // Cache provenance is not content equality: a cached module can be identical to
  // the served one, so "this page is running a MIXTURE of versions" asserted more
  // than the evidence carries (codex review).
  assert.match(msg, /makes version skew POSSIBLE/);
  assert.match(msg, /not proof of it/);
  assert.ok(!/is running a MIXTURE of versions/.test(msg), "overstated conclusion");
  // …and it names WHICH ones, because that is what a follow-up needs.
  assert.match(msg, /js\/lib\/graph-write-fence\.js/);
});

test("ALL-CACHED points outside the panel, and says so", () => {
  const s = summarizeModuleCache([fromCache("js/comfyui-mcp-panel.js"), fromCache("js/lib/a.js")]);
  assert.equal(s.verdict, "all-cached");
  const msg = describeModuleCache(s);
  // ComfyUI sets no-store on every .js, so a wholly-cached pack means something
  // in between is not passing it. Naming the suspects is the actionable part.
  assert.match(msg, /no-store on every \.js/);
  assert.match(msg, /proxy, tunnel, or Desktop's server/);
});

test("no measurement is reported as no measurement, never as fresh", () => {
  for (const nothing of [null, undefined, []]) {
    const s = summarizeModuleCache(nothing);
    assert.equal(s.verdict, "unknown");
    assert.match(describeModuleCache(s), /could not be measured/);
    assert.match(describeModuleCache(s), /not evidence that they were fresh/);
  }
});

test("counts only OUR modules — the page is full of other people's", () => {
  const foreign = {
    name: "http://127.0.0.1:8188/extensions/some-other-pack/js/x.js",
    transferSize: 0,
    decodedBodySize: 900,
    initiatorType: "script",
  };
  const s = summarizeModuleCache([entry("js/comfyui-mcp-panel.js"), foreign]);
  assert.equal(s.total, 1, "another pack's cached module must not be reported as ours");
  assert.equal(s.verdict, "all-network");
});

test("carries the server's status codes — a 304 is the other way to serve stale", () => {
  const s = summarizeModuleCache([
    entry("js/a.js", { responseStatus: 200 }),
    entry("js/b.js", { transferSize: 0, responseStatus: 304 }),
  ]);
  assert.equal(s.statuses[200], 1);
  assert.equal(s.statuses[304], 1);
  assert.match(describeModuleCache(s), /status .*304/);
});

test("the sample list is bounded — a wedged page has 112 of these", () => {
  const many = Array.from({ length: 60 }, (_, i) => fromCache(`js/lib/m${i}.js`));
  const s = summarizeModuleCache(many);
  assert.equal(s.total, 60);
  assert.ok(s.cachedUrls.length <= 12, `listed ${s.cachedUrls.length}`);
});

test("reading the live document never throws, whatever the API does", () => {
  assert.equal(readModuleCacheSummary(null).verdict, "unknown");
  assert.equal(readModuleCacheSummary({}).verdict, "unknown");
  const hostile = {
    getEntriesByType() {
      throw new Error("Resource Timing is disabled");
    },
  };
  assert.equal(readModuleCacheSummary(hostile).verdict, "unknown");
  // And the real shape, through the same door.
  const perf = { getEntriesByType: (t) => (t === "resource" ? [fromCache("js/a.js")] : []) };
  assert.equal(readModuleCacheSummary(perf).verdict, "all-cached");
});

// ── WIRING ────────────────────────────────────────────────────────────────
// The measurement is worthless if it is never taken. Both call sites are pinned
// at source: the module is not importable under Node (it is the panel bundle).
test("WIRING: the CURRENT-version path takes the measurement", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(
    src,
    /import \{ describeModuleCache, readModuleCacheSummary \} from "\.\/lib\/module-cache-report\.js";/,
  );

  const heal = src.slice(src.indexOf("async function healStaleBundleIfNeeded()"));
  const body = heal.slice(0, heal.indexOf("\n}\n"));
  // THE POINT OF THE CHANGE: the check runs on the `current` branch — the one
  // that used to return silently. Wiring it only to the already-stale paths
  // would add nothing, since those already warn.
  const currentBranch = body.slice(body.indexOf('if (staleness === "current")'));
  assert.ok(
    currentBranch.includes("readModuleCacheSummary()"),
    "the blind spot is the `current` branch — it must be measured there",
  );
  assert.ok(currentBranch.includes('cache.verdict === "mixed"'), "skew must be what triggers it");
  // A healthy page must stay silent, or the warning trains people to ignore it.
  assert.ok(
    !currentBranch.includes('cache.verdict === "all-network"'),
    "an all-network page must not warn",
  );
});

test("WIRING: user-copied diagnostics carry the measurement", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const diag = src.slice(src.indexOf("--- comfyui-mcp panel diagnostics ---"));
  const block = diag.slice(0, diag.indexOf("].join("));
  assert.ok(
    block.includes("describeModuleCache(readModuleCacheSummary())"),
    "the diagnostics a user pastes into an issue must include it",
  );
});

// ── CODEX REVIEW FINDINGS ─────────────────────────────────────────────────
// Each of these was a way the diagnostic could report a FALSE ALL-CLEAR, which
// is the only failure mode that matters here: it would send a sixth attempt back
// down the path this module exists to close.

test("a 304 is a CACHE HIT — the exact mechanism this issue is about", () => {
  // A revalidation transfers headers, so transferSize is NONZERO while the body
  // comes from cache. Classifying by bytes alone called this "network" and would
  // have reported "not the HTTP cache" for a page built entirely of stale 304s —
  // which is the mechanism ComfyUI's own e0982a71 describes (aiohttp ETag from
  // mtime+size matches, 304, stale content served).
  const revalidated = entry("js/a.js", { transferSize: 380, decodedBodySize: 12000, responseStatus: 304 });
  assert.equal(classifyEntry(revalidated), "revalidated");

  const s = summarizeModuleCache([revalidated, entry("js/b.js", { responseStatus: 304, transferSize: 300 })]);
  assert.equal(s.verdict, "all-cached", "a page of 304s is cache-served, not fresh");
  assert.equal(s.revalidated, 2);
  assert.match(describeModuleCache(s), /304 revalidations, where an ETag matched/);
});

test("one 304 among fetches is MIXED, not all-network", () => {
  const s = summarizeModuleCache([
    entry("js/a.js"),
    entry("js/b.js", { responseStatus: 304, transferSize: 300 }),
  ]);
  assert.equal(s.verdict, "mixed");
});

test("a full timing buffer cannot be reported as completeness", () => {
  // The spec's floor is 250 entries and this page loads 112 panel modules on top
  // of ComfyUI's own. If the cached ones were evicted and the fetched ones
  // survived, the naive read is "everything was fetched".
  const many = Array.from({ length: 300 }, (_, i) => entry(`js/lib/m${i}.js`));
  const s = summarizeModuleCache(many);
  assert.equal(s.bufferMaybeFull, true);
  assert.equal(s.verdict, "all-network");
  assert.match(describeModuleCache(s), /may have been dropped and this list may be incomplete/);
});

test("a small buffer carries no truncation caveat", () => {
  const s = summarizeModuleCache([entry("js/a.js")]);
  assert.equal(s.bufferMaybeFull, false);
  assert.ok(!/may be incomplete/.test(describeModuleCache(s)));
});

test("a cached STYLESHEET must not manufacture a finding", () => {
  // Resource Timing reports a stylesheet and a `link rel=modulepreload` both as
  // "link", so filtering by initiatorType admitted CSS. Every module ComfyUI
  // auto-imports is a .js, so the URL decides.
  const css = {
    name: url("css/panel.css"),
    transferSize: 0,
    decodedBodySize: 4000,
    initiatorType: "link",
  };
  const s = summarizeModuleCache([entry("js/comfyui-mcp-panel.js"), css]);
  assert.equal(s.total, 1, "a cached CSS file is not a cached module");
  assert.equal(s.verdict, "all-network");
});

test("a query string does not hide a .js module", () => {
  const s = summarizeModuleCache([{ ...fromCache("js/a.js"), name: url("js/a.js?v=0.11.76") }]);
  assert.equal(s.total, 1);
  assert.equal(s.verdict, "all-cached");
});
