// panel#767 — every panel_add_node re-downloaded the ENTIRE node schema.
//
// #458 made the fresh /object_info the sole authority for "does the backend still
// provide this type", which is right — a stale registry keeps positives for packs
// that have since been uninstalled. But it fetched the whole document. Measured on
// the rig (ComfyUI 0.30.2, 63 custom-node packs):
//
//     GET /object_info            5,413,770 bytes   167 ms
//     GET /object_info/KSampler       3,246 bytes   1.2 ms
//
// A burst of ten adds pulled ~54 MB, the payload-carrying refreshes serialised
// behind each other, and the 30 s reply deadline expired — after which the adds
// landed anyway, which is where the report's "ghost" nodes came from.
//
// The rule this file exists to hold: the fast path may only ever CONFIRM. Every
// other outcome falls through to the full fetch, so no refusal, removal verdict or
// history check is ever decided on the smaller payload.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchSingleNodeDef, singleDefConfirms } from "../../web/js/lib/single-node-def.js";
import { OBJECT_INFO_RETRY_DELAYS_MS } from "../../web/js/lib/object-info-retry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** A fetchApi double. Records routes so "did it ask for one class?" is checkable. */
function fakeApi({ status = 200, body = undefined, throws = false, json } = {}) {
  const routes = [];
  const fetchApi = async (route) => {
    routes.push(route);
    if (throws) throw new Error("network down");
    return {
      status,
      json: json ?? (async () => body),
    };
  };
  fetchApi.routes = routes;
  return fetchApi;
}

test("#767 it asks for exactly the one class, url-encoded", async () => {
  const api = fakeApi({ body: { "Power Lora Loader (rgthree)": { input: {} } } });
  const got = await fetchSingleNodeDef("Power Lora Loader (rgthree)", api);
  assert.ok(got, "a body containing the class is a confirmation");
  assert.deepEqual(api.routes, ["/object_info/Power%20Lora%20Loader%20(rgthree)"]);
});

test("#767 a confirmation returns the defs, shaped like the full document", async () => {
  // The caller feeds this straight to hasOwnProperty(defs, class_type) — the same
  // authority test #458 runs against the whole schema — so the shape must match.
  const body = { KSampler: { input: { required: {} } } };
  const got = await fetchSingleNodeDef("KSampler", fakeApi({ body }));
  assert.ok(Object.prototype.hasOwnProperty.call(got, "KSampler"));
});

test("#767 ABSENCE is {} with HTTP 200 on this route, and is NOT a verdict", async () => {
  // Verified against the live rig: /object_info/LTXVImgToVideoConditionOnly — a type
  // that install does not have — answers 200 with `{}`, not 404. Returning null
  // sends the caller to the full fetch, where the existing removal/history logic
  // decides. Concluding "removed" here would be this codebase's own defect class:
  // an observation collapsed into a definite negative.
  const got = await fetchSingleNodeDef("LTXVImgToVideoConditionOnly", fakeApi({ body: {} }));
  assert.equal(got, null);
});

test("#767 every kind of DOUBT returns null, never a conclusion", async () => {
  // An older ComfyUI without the route.
  assert.equal(await fetchSingleNodeDef("KSampler", fakeApi({ status: 404, body: {} })), null);
  // A proxy sign-in page: 200, but not our document.
  assert.equal(await fetchSingleNodeDef("KSampler", fakeApi({ status: 200, body: "<html>" })), null);
  // A body that will not parse.
  assert.equal(
    await fetchSingleNodeDef("KSampler", fakeApi({ json: async () => { throw new Error("bad json"); } })),
    null,
  );
  // The request itself failed.
  assert.equal(await fetchSingleNodeDef("KSampler", fakeApi({ throws: true })), null);
  // A response carrying a DIFFERENT class than the one asked for.
  assert.equal(await fetchSingleNodeDef("KSampler", fakeApi({ body: { LoadImage: {} } })), null);
  // Arrays and nulls are not documents.
  assert.equal(await fetchSingleNodeDef("KSampler", fakeApi({ body: [] })), null);
  assert.equal(await fetchSingleNodeDef("KSampler", fakeApi({ body: null })), null);
});

test("#767 a non-2xx is not evidence, even when the body confirms", async () => {
  // Found by mutation: deleting the status check killed no test, because every
  // non-2xx fixture also had a non-confirming body — so the check was passing for
  // the wrong reason. The rule it actually encodes is that a request the server
  // said FAILED is not an observation about the node type, whatever bytes came
  // with it: a caching proxy answering 5xx from a stale entry, or an error page
  // that happens to carry JSON, must both reach the full fetch rather than
  // authorize an add on their own.
  const confirming = { KSampler: { input: { required: {} } } };
  assert.equal(await fetchSingleNodeDef("KSampler", fakeApi({ status: 500, body: confirming })), null);
  assert.equal(await fetchSingleNodeDef("KSampler", fakeApi({ status: 404, body: confirming })), null);
  assert.equal(await fetchSingleNodeDef("KSampler", fakeApi({ status: 302, body: confirming })), null);
  // …and 2xx with a confirming body is still the one accepted case.
  assert.ok(await fetchSingleNodeDef("KSampler", fakeApi({ status: 200, body: confirming })));
  assert.ok(await fetchSingleNodeDef("KSampler", fakeApi({ status: 204, body: confirming })));
});

test("#767 a missing capability is a no-op, not a throw", async () => {
  // This runs inside graph_add_node's fresh-oracle callback, and the resolver
  // catches everything that escapes it and reports "object_info is unavailable" —
  // so a throw here would surface as a FALSE refusal on a healthy backend.
  assert.equal(await fetchSingleNodeDef("KSampler", undefined), null);
  assert.equal(await fetchSingleNodeDef("", fakeApi({ body: { "": {} } })), null);
  assert.equal(await fetchSingleNodeDef(null, fakeApi({})), null);
});

test("#767 singleDefConfirms accepts only an own property on a real object", () => {
  assert.equal(singleDefConfirms({ KSampler: {} }, "KSampler"), true);
  assert.equal(singleDefConfirms({}, "KSampler"), false);
  assert.equal(singleDefConfirms(null, "KSampler"), false);
  assert.equal(singleDefConfirms([], "KSampler"), false);
  assert.equal(singleDefConfirms("KSampler", "KSampler"), false);
  // An inherited key is not the backend saying it has the type.
  assert.equal(singleDefConfirms(Object.create({ KSampler: {} }), "KSampler"), false);
});

test("#767 WIRING: the fast path is gated on the type ALREADY being registered", () => {
  // Not an optimisation detail — a safety one. assertAddNodeResolvableRefreshing
  // hands `freshDefs` to refreshComfyNodeDefs() when a type still needs
  // registering, and a single-class payload reaching a whole-schema refresh could
  // deregister everything else. Under this gate that branch is unreachable.
  const src = readFileSync(PANEL_JS, "utf8");
  const i = src.indexOf("getFreshObjectInfo: async () => {");
  assert.ok(i > 0, "the fresh-oracle callback must be findable");
  // BOTH ENDS ANCHORED STRUCTURALLY. This used to slice a fixed 2,600 characters, so
  // adding a comment inside the callback pushed the second snapshotBackendDef out of the
  // window and failed the count below — a test breaking on prose rather than on behaviour.
  // The callback ends where the next key of the same object literal begins.
  const end = src.indexOf("refresh: (defs) =>", i);
  assert.ok(end > i, "the fresh-oracle callback must be followed by the refresh key");
  const body = src.slice(i, end);
  const guard = body.indexOf("isRegisteredNodeType(LG?.registered_node_types");
  // #1180 bounded this call too — it runs FIRST, so an unbounded fast path hung the add
  // before the bounded fallback was ever reached. The gate assertion is about WHERE the
  // single-class fetch sits, which the wrapping does not change.
  const call = body.indexOf("fetchSingleNodeDef(class_type");
  assert.match(
    body,
    /withTimeout\(\s*[\r\n]?\s*fetchSingleNodeDef\(class_type/,
    "the fast path must be bounded: it runs before the fallback and hangs the add on its own",
  );
  assert.ok(guard > 0, "the registered-type gate must be present");
  assert.ok(call > guard, "…and the single-class fetch must sit INSIDE it");
  // The full fetch must still be there as the fallback. #1180 bounded it — a half-open
  // connection after a restart hung `graph_add_node` here — so the shape is now the
  // bounded call rather than a bare `await api.getNodeDefs()`. What this pins is that the
  // WHOLE-schema fallback still exists behind the gate, which is the safety property; the
  // literal it used to match was incidental to that.
  assert.match(body, /await boundedGetNodeDefs\(\)/, "the whole-schema fallback must still be there");
  assert.match(
    body,
    /NODE_DEFS_NO_ANSWER \? null :/,
    "…and a call that never answers must degrade to 'no defs', not park the add",
  );
  // And the snapshot must be taken on BOTH paths — #700 turns on it.
  assert.equal(
    (body.match(/snapshotBackendDef\(freshDefs, class_type\)/g) ?? []).length,
    2,
    "both the fast and full paths must snapshot the backend def before any refresh mutates it",
  );
});

// ── #1180: the sibling call sites are BOUNDED ────────────────────────────────
//
// #1161 bounded the /object_info oracle, which fixed graph_set_widget. These three sites
// were left unbounded and still hung on the same half-open connection after a ComfyUI
// restart — the worse shape, because it makes the behaviour hard to report: setting a
// widget works, adding a node does not.
//
// Structural, for the reason #1166's and #1171's tests are: whether a call is bounded is a
// property of the call site, and these executors are rebuilt in synthetic scopes elsewhere
// rather than run whole here.
test("#1180: every getNodeDefs call that can hang a command is bounded", () => {
  const src = readFileSync(PANEL_JS, "utf8");

  // The bound exists, is a real number, and sits inside the bridge's 30s command budget so
  // the caller sees its own refusal rather than a bare timeout naming nothing.
  const ms = Number((src.match(/const NODE_DEFS_FETCH_TIMEOUT_MS = (\d+);/) || [])[1]);
  assert.ok(ms > 0, "the bound must be a positive number of milliseconds");
  assert.ok(ms < 30000, `the bound must stay inside the command budget, got ${ms}`);

  // Bounded through the repo's ONE primitive. A second timeout helper written alongside it
  // is what bounded-step.js's own header warns produces near-duplicate bugs.
  assert.match(src, /import \{ withTimeout \} from "\.\/lib\/bounded-step\.js"/);
  assert.match(src, /async function boundedGetNodeDefs\(/);

  // REIFIED before bounding. withTimeout degrades a rejection through onTimeout exactly as
  // it does a timeout, so wrapping the call directly collapses "it threw" into "it never
  // answered" — a first version did that and broke four tests pinning how a getNodeDefs
  // throw is attributed to the fetch.
  const helper = src.slice(src.indexOf("async function boundedGetNodeDefs("));
  const helperBody = helper.slice(0, helper.indexOf("\n}"));
  assert.match(helperBody, /\(value\) => \(\{ value \}\), \(err\) => \(\{ err \}\)/, "outcome reified");
  assert.match(helperBody, /if \("err" in settled\) throw settled\.err;/, "a throw keeps its own cause");

  // No UNBOUNDED await of getNodeDefs may remain on a command path. The startup baseline
  // seed is the one permitted site: nothing awaits it directly and awaitObjectInfoHistorySeed()
  // already bounds the wait, so it cannot hang a command.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ""));
  // BOTH hanging shapes, not just the awaited one. A broader "any call" match is wrong
  // here — it also catches the thunks handed to the /object_info oracle, which bounds them
  // itself, and an error string that merely names the function. What actually hangs a
  // command is awaiting the call, or chaining off it, without a bound.
  const awaited = code.filter((l) => /await api\??\.getNodeDefs\s*\(/.test(l));
  assert.equal(
    awaited.length,
    1,
    `only the startup seed may await getNodeDefs unbounded; found ${awaited.length}: ${awaited.map((l) => l.trim()).join(" | ")}`,
  );
  const chained = code.filter((l) => /api\??\.getNodeDefs\s*\(\s*\)\s*\.then\s*\(/.test(l));
  assert.deepEqual(
    chained,
    [],
    "a chained api.getNodeDefs().then(...) hangs exactly as an awaited one does, and must be bounded too",
  );
  const seedAt = src.indexOf("function seedObjectInfoHistory(");
  const seedBody = src.slice(seedAt, src.indexOf("\n}", seedAt));
  assert.match(seedBody, /await api\.getNodeDefs\(\)/, "…and that one site is the seed itself");
});

test("#1180: the RETRIED fetch's worst case stays inside the command budget", () => {
  // Found by asking what three attempts cost, not by review: fetchNodeDefsWithRetry makes
  // three attempts (two delays) and caps its own added waiting at 800ms. Reusing the
  // single-call 10s bound put the worst case at 3 x 10000 + 800 = 30,800ms — PAST the
  // bridge's 30s command timeout, so a fully hung connection would blow the budget and hand
  // the agent a bare timeout naming nothing. That is the #1161 symptom, reintroduced by the
  // fix for #1180.
  const src = readFileSync(PANEL_JS, "utf8");
  const single = Number((src.match(/const NODE_DEFS_FETCH_TIMEOUT_MS = (\d+);/) || [])[1]);
  const budget = Number((src.match(/const NODE_DEFS_RETRY_BUDGET_MS = (\d+);/) || [])[1]);
  assert.ok(budget > 0, "the retry sequence must have its own budget");

  // DERIVED from the retry module, not hardcoded, so the arithmetic cannot drift when the
  // retry schedule changes.
  assert.match(
    src,
    /OBJECT_INFO_RETRY_DELAYS_MS\.reduce\(/,
    "the per-attempt bound must be derived from the retry schedule itself",
  );
  const attempts = OBJECT_INFO_RETRY_DELAYS_MS.length + 1;
  const waiting = OBJECT_INFO_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  const perAttempt = Math.floor((budget - waiting) / attempts);
  assert.ok(perAttempt > 0, `each attempt must get a real bound, got ${perAttempt}ms`);
  assert.ok(
    perAttempt * attempts + waiting < 30000,
    `the retried worst case is ${perAttempt * attempts + waiting}ms, past the 30s command budget`,
  );
  // …and it must be SMALLER than the single-call bound, which is the whole point.
  assert.ok(perAttempt < single, "a retried attempt cannot be given the single-call bound");
  // The refresh site really uses it.
  assert.match(src, /boundedGetNodeDefs\(NODE_DEFS_ATTEMPT_TIMEOUT_MS\)/, "the refresh uses the derived bound");
});

test("#1180: the widen's bound fits INSIDE the registration deadline it runs under", () => {
  // `widenSocketProof` is awaited from inside `awaitRequiredCustomWidgetRegistration`,
  // whose deadline is `startedAt + CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS`. Given the
  // generic 10s node-defs bound — twice that — a timed-out widen consumes the ENTIRE
  // registration wait, and the add then reports unmaterialized widgets having never
  // actually polled for them. So the widen needs its own, smaller bound.
  const src = readFileSync(PANEL_JS, "utf8");
  const registration = Number(
    (src.match(/const CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS = (\d+);/) || [])[1],
  );
  assert.ok(registration > 0, "the registration deadline must be findable");

  // DERIVED from that deadline, not picked, so the two cannot drift apart.
  assert.match(
    src,
    /const WIDEN_SOCKET_PROOF_TIMEOUT_MS = Math\.floor\(CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS \/ \d+\)/,
    "the widen's bound must be derived from the registration deadline",
  );
  const widen = Math.floor(registration / 2);
  assert.ok(widen > 0 && widen < registration, `the widen bound must fit inside ${registration}ms, got ${widen}`);

  // …and the widen must actually use it rather than the generic node-defs bound.
  assert.match(
    src,
    /boundedGetNodeDefs\(WIDEN_SOCKET_PROOF_TIMEOUT_MS\)/,
    "the widen must use its own bound, not the 10s single-call one",
  );
});
