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
  // …with the CONSTANT, not a literal. withTimeout treats a non-positive ms as NO bound, so
  // passing 0 here silently restores the hang while every other assertion still holds —
  // verified: that mutation survived until this line existed.
  // #1192 — …and that constant is now CAPPED by the command's remaining budget, because it
  // is not the only bound on this path. A timed-out fast path falls through to the
  // whole-schema fetch, so the two are additive.
  assert.match(
    body,
    /fetchSingleNodeDef\(class_type[\s\S]{0,400}?budget\.bounded\(NODE_DEFS_FETCH_TIMEOUT_MS\)/,
    "the fast path must be bounded by the named constant, capped by the command budget",
  );
  assert.ok(guard > 0, "the registered-type gate must be present");
  assert.ok(call > guard, "…and the single-class fetch must sit INSIDE it");
  // The full fetch must still be there as the fallback. #1180 bounded it — a half-open
  // connection after a restart hung `graph_add_node` here — so the shape is now the
  // bounded call rather than a bare `await api.getNodeDefs()`. What this pins is that the
  // WHOLE-schema fallback still exists behind the gate, which is the safety property; the
  // literal it used to match was incidental to that.
  // #1192 — the fallback now takes the SAME 10s bound `graph_set_widget`'s oracle gives the
  // identical request, capped by what the command has left. It used to take the default,
  // which read as agreement with set_widget only by coincidence.
  assert.match(
    body,
    /await boundedGetNodeDefs\(budget\.bounded\(NODE_DEFS_FETCH_TIMEOUT_MS\)\)/,
    "the whole-schema fallback must still be there, bounded by the command budget",
  );
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

test("#1180: a whole refresh RUN, not each phase, is what fits the budget", () => {
  // Per-phase bounds do not compose, and this test used to help hide that. It checked the
  // fetch phase's arithmetic in isolation while the same branch gave the combo phase a
  // separate 10s bound, so a run cost roughly 19.8s and a forced refresh — which
  // makeRefreshCoalescer guarantees pays the in-flight run AND its own, serially — cost
  // about 39.6s. Past the 20s read default and the 30s command budget both, with every
  // assertion here green.
  //
  // It also computed its own `const attempts = 2` rather than reading the shipped
  // schedule, so restoring three attempts changed nothing it asserted. A test that
  // recomputes a value cannot see that value change.
  const src = readFileSync(PANEL_JS, "utf8");
  const num = (re, what) => {
    const m = src.match(re);
    assert.ok(m, `${what} must be findable in the panel source`);
    return Number(m[1]);
  };
  const single = num(/const NODE_DEFS_FETCH_TIMEOUT_MS = (\d+);/, "the single-call bound");
  const run = num(/const NODE_DEFS_RUN_BUDGET_MS = (\d+);/, "the run budget");

  // TWO runs, not one. A forced panel_refresh_nodes waits for the in-flight run and then
  // starts its own, so a refresh issued just after a reconnect pays both, serially.
  // 20000 is the orchestrator's ui-bridge read default. It is NOT read from this repo:
  // the panel used to carry a BRIDGE_READ_DEFAULT_MS copy of it that nothing consumed, so
  // this assertion compared the panel against the panel and could never have caught the
  // drift it appeared to guard. The real value lives in comfyui-mcp; if it changes there,
  // nothing in this repo will notice, and saying so is more honest than a local mirror.
  const READ_DEFAULT_MS = 20000;
  assert.ok(
    run * 2 < READ_DEFAULT_MS,
    `two serialized refresh runs cost ${run * 2}ms against a ${READ_DEFAULT_MS}ms read default`,
  );

  // Every bounded phase must draw from that ONE deadline rather than carry its own number.
  assert.match(
    src,
    /let runDeadline = monotonicNow\(\) \+ NODE_DEFS_RUN_BUDGET_MS;/,
    "the run must take a deadline once, before any phase starts",
  );
  // …and give back what the UNBOUNDED local work took, or that work spends the deadline
  // rather than merely escaping it. Without this, a slow install (#610 measured the whole
  // refresh at ~14.5s, mostly registration) reaches the combo phase with the budget gone,
  // falls to the 1ms floor, and abandons a HEALTHY combo refresh — reporting
  // combo_refresh_failed on every panel_refresh_nodes and leaving
  // nodeDefsRefreshConfirmed false, which is what reopens #610's false 'model still
  // missing'. The budget is an allowance for WAITING, not for computing.
  assert.match(
    src,
    /runDeadline \+= monotonicNow\(\) - localWorkStartedAt;/,
    "the unbounded register/reapply phases must not spend the waiting budget",
  );
  const localStart = src.indexOf("const localWorkStartedAt = monotonicNow();");
  const giveBack = src.indexOf("runDeadline += monotonicNow() - localWorkStartedAt;");
  assert.ok(localStart > 0 && giveBack > localStart, "the clock must stop before the local work and restart after it");
  // The window must cover ALL the local work, not an arbitrary slice of it.
  // `recordObjectInfoTypes` walks every type in the payload (4304 on this rig) — CPU work
  // of exactly the kind the give-back exists to exclude. It sat OUTSIDE the window in the
  // first version of this fix, so one arbitrary slice of computing still spent the waiting
  // budget, which is the rule this test exists to keep unambiguous.
  const record = src.indexOf("recordObjectInfoTypes(defs);", localStart - 2000);
  assert.ok(
    record > localStart && record < giveBack,
    "the payload walk is local work and must be inside the excluded window",
  );
  const reapply = src.indexOf("reapplyDefsToLiveNodes(rootGraph, defs, comboRebuild)", localStart);
  assert.ok(reapply > localStart && reapply < giveBack, "…and so is the live-node reapply");
  assert.ok(
    giveBack < src.indexOf('phase = "combo";', localStart),
    "…and be handed back BEFORE the combo phase reads what is left",
  );
  assert.match(
    src,
    /boundedGetNodeDefs\(nodeDefsBudgetLeft\(runDeadline, NODE_DEFS_FETCH_SHARE\)\)/,
    "the fetch phase must draw its bound from the run deadline",
  );
  // #1193 read the bound into a variable so the refusal can name it. The property this
  // pins is unchanged and now pinned in two halves: the bound is COMPUTED from what the
  // fetch phase left, and that computed value is the one actually ARMED — a constant
  // substituted at either end fails here.
  assert.match(
    src,
    /comboWaitMs = nodeDefsBudgetLeft\(runDeadline\);/,
    "the combo phase must draw from what the fetch phase left, not from a constant",
  );
  assert.match(
    src,
    // `\s*`, never `\n\s*`: this reads the WORKING copy, which is CRLF on a Windows
    // checkout and LF on CI, and a pattern anchored to a bare \n passes on one and fails
    // on the other for no behavioural reason.
    /\s*comboWaitMs,\s*\(\) => COMBO_NO_ANSWER/,
    "…and the value it computed is the bound it arms",
  );
  // A monotonic clock, like every other elapsed measurement in this panel: a wall-clock
  // jump mid-run must not hand a phase a negative or enormous remainder.
  // Positive, and scoped to the one function. An earlier version of this assertion swept
  // from here to registerComfyNodeDefs and tripped over monotonicNow's OWN definition,
  // which names Date.now() as its documented fallback — a test failing on the correct code
  // because the window it read was wider than the claim it was making.
  const budgetFn = src.slice(
    src.indexOf("function nodeDefsBudgetLeft("),
    src.indexOf("\n}", src.indexOf("function nodeDefsBudgetLeft(")),
  );
  assert.match(budgetFn, /deadline - monotonicNow\(\)/, "the budget must be measured on the monotonic clock");
  assert.match(budgetFn, /Math\.max\(1,/, "a spent budget must yield 1ms, never a non-positive ms that arms no bound");

  // The SHARE is a real fraction: a fetch phase allowed the whole run leaves the combo
  // phase the 1ms floor, which is the hang arriving through the mechanism meant to stop it.
  const share = (() => {
    const m = src.match(/const NODE_DEFS_FETCH_SHARE = (\d+) \/ (\d+);/);
    assert.ok(m, "the fetch share must be stated as a ratio");
    return Number(m[1]) / Number(m[2]);
  })();
  assert.ok(share > 0 && share < 1, `the fetch phase must get a FRACTION of the run, saw ${share}`);
  // …and a USABLE remainder, not merely a nonzero one. `share < 1` alone passed 999/1000,
  // which leaves the combo phase 9ms of a 9000ms run — arithmetically a fraction, and in
  // practice the 1ms floor and an instant timeout on every call. The combo phase is one
  // request against the same backend the fetch just used, so it needs the same order of
  // time, not a rounding error.
  const comboLeft = run * (1 - share);
  assert.ok(
    comboLeft >= 1000,
    `the combo phase is left ${Math.round(comboLeft)}ms of a ${run}ms run — too little to answer in`,
  );

  // #1193 — this remainder is NOT topped up by a floor, and that is deliberate. A floor
  // fires only when the fetch was slow, and `refreshComboInNodes()` re-fetches
  // /object_info from that same slow backend (measured: +3000ms per /object_info took the
  // combo phase from 555ms to 3318ms), so a floor sized from a WARM measurement does not
  // cover the case it fires in — while one sized to cover it would put two serialized runs
  // past the bridge's 20s read. The combo phase's ABANDONMENT is disclosed instead.
  assert.doesNotMatch(
    src,
    /NODE_DEFS_COMBO_FLOOR_MS/,
    "a floor under the combo remainder lets a run exceed NODE_DEFS_RUN_BUDGET_MS, which breaks " +
      "the 2-runs-inside-the-20s-read property this budget is sized on",
  );

  // #954's SCHEDULE, SHARED not forked — read from the retry module, never restated.
  assert.match(
    src,
    /const NODE_DEFS_RETRY_DELAYS_MS = OBJECT_INFO_RETRY_DELAYS_MS;/,
    "forking the schedule is what cut #954's bridging window from 800ms to 200ms",
  );
  // …and a timeout is declined by the CALLER, which is what makes sharing it safe.
  assert.match(src, /shouldRetry: \(\) => !lastAttemptTimedOut/, "an abandoned attempt must not be retried");
  assert.ok(
    run <= single,
    `a whole run cannot be given more than the single-call bound (${run}ms vs ${single}ms)`,
  );
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
    /const WIDEN_SOCKET_PROOF_TIMEOUT_MS = Math\.floor\(\s*CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS \/ WIDEN_SOCKET_PROOF_DIVISOR,?\s*\)/,
    "the widen's bound must be derived from the registration deadline",
  );
  // READ the divisor from source. Computing it here makes the test agree with itself
  // rather than with the panel: changing the shipped `/ 2` to `/ 1` — which makes the
  // widen exactly as long as the wait it runs inside — survived until this did.
  const divisor = Number((src.match(/const WIDEN_SOCKET_PROOF_DIVISOR = (\d+);/) || [])[1]);
  assert.ok(divisor >= 2, `the widen must get a FRACTION of its caller's deadline, saw /${divisor}`);
  const widen = Math.floor(registration / divisor);
  assert.ok(widen > 0 && widen < registration, `the widen bound must fit inside ${registration}ms, got ${widen}`);

  // #1192 — the SAME fraction, of whatever deadline the wait actually got.
  //
  // The pin moved from a constant to a derivation because the constant stopped being the
  // truth. Under a command budget the registration wait can be a few hundred ms, and a
  // widen still taking a fixed 2500ms of it is this issue's own defect one level down: a
  // bound sized against a number its caller no longer has. `widenSocketProofBudget` keeps
  // the ratio; the ratio is what the paragraph above is actually about.
  const share = src.slice(
    src.indexOf("function widenSocketProofBudget("),
    src.indexOf("\n}", src.indexOf("function widenSocketProofBudget(")),
  );
  assert.ok(share.length > 0, "the widen's share of its caller's deadline must be findable");
  assert.match(
    share,
    /whole \/ WIDEN_SOCKET_PROOF_DIVISOR/,
    "the widen must take the same FRACTION of the deadline it actually runs under",
  );
  assert.match(
    share,
    /Math\.max\(1,/,
    "a spent budget must yield 1ms, never a non-positive ms that arms no bound at all",
  );
  assert.match(
    share,
    /CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS/,
    "…and a caller that names no deadline must fall back to #580's own",
  );

  // …and the widen must actually use it rather than the generic node-defs bound.
  assert.match(
    src,
    /widened = await widenSocketProof\(widenSocketProofBudget\(wait\)\)/,
    "the registration wait must hand the widen its share of the deadline it actually got",
  );
  assert.match(
    src,
    /boundedGetNodeDefs\(\s*widenMs > 0 \? widenMs : WIDEN_SOCKET_PROOF_TIMEOUT_MS,?\s*\)/,
    "the widen must use the bound it was handed, not the 10s single-call one",
  );
});

/**
 * #1385 — every argument list `name(` is called with in `src`, one entry per CALL SITE.
 *
 * A single regex over a function body cannot do this job: it answers "is this written
 * SOMEWHERE in here", and a body with two call sites keeps answering yes after one of them
 * is unwired. Returning the sites separately is what lets each be asserted on its own, and
 * what makes a THIRD site — the shape of defect that keeps recurring here — visible the day
 * it is written rather than the day it breaks.
 *
 * A balanced-paren scan rather than a regex because the calls span lines and nest parens
 * (`budget.remaining()`). Quoted text is skipped so a paren inside a string cannot mis-slice
 * a call; the scan throws rather than guessing if the parens do not balance.
 */
function callArgumentLists(src, name) {
  const opener = `${name}(`;
  const lists = [];
  for (let at = src.indexOf(opener); at >= 0; at = src.indexOf(opener, at + 1)) {
    // `foo.refreshComfyNodeDefs(` / `myRefreshComfyNodeDefs(` are different functions.
    if (/[A-Za-z0-9_$.]/.test(src[at - 1] ?? "")) continue;
    let depth = 0;
    let quote = null;
    let i = at + opener.length - 1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) break;
    }
    assert.ok(depth === 0 && i < src.length, `unbalanced parentheses after ${opener}`);
    lists.push(src.slice(at + opener.length, i));
  }
  return lists;
}

test("#1192: graph_add_node's serialized bounds FIT the command budget", () => {
  // The predecessor of this test asserted the OPPOSITE — that this path exceeds the budget —
  // and said so in its own failure message: "If that is genuinely fixed, close #1192 and
  // replace this with the assertion that it FITS." This is that replacement.
  //
  // WHAT CHANGED IS NOT THE ARITHMETIC, and that distinction is the whole fix. The
  // individual bounds are UNCHANGED and their naive sum is still past the relay window. A
  // fix that made them add up by shrinking each one would have bought the budget with false
  // refusals on healthy installs — the direction this repo has regressed in before, and the
  // direction the notes at every one of these constants warn about. What changed is that
  // they no longer ADD: each is capped by ONE deadline taken at the top of the command, so
  // the path costs that deadline rather than the sum.
  const src = readFileSync(PANEL_JS, "utf8");
  const num = (re, what) => {
    const m = src.match(re);
    assert.ok(m, `${what} must be findable`);
    return Number(m[1]);
  };
  const single = num(/const NODE_DEFS_FETCH_TIMEOUT_MS = (\d+);/, "the single-call fetch bound");
  const run = num(/const NODE_DEFS_RUN_BUDGET_MS = (\d+);/, "the refresh run budget");
  const registration = num(/const CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS = (\d+);/, "the registration deadline");
  const seed = num(/const OBJECT_INFO_SEED_WAIT_MS = (\d+);/, "the baseline seed wait");
  const budget = num(/const ADD_NODE_COMMAND_BUDGET_MS = (\d+);/, "the command budget");

  // The relay window this must fit inside. 30000 is what comfyui-mcp's `panel_add_node`
  // passes as an explicit reply timeout (`OBJECT_INFO_REFRESH_ACK_TIMEOUT_MS`), NOT the
  // 20000 ui-bridge read default — which applies to neither this command nor refresh_nodes
  // nor graph_set_widget, all three of which are relayed at 30000. It is NOT read from this
  // repo, and saying so is more honest than a local mirror: the panel once carried a
  // BRIDGE_READ_DEFAULT_MS copy that nothing consumed, so the assertion compared the panel
  // against the panel and could never have caught the drift it appeared to guard.
  const RELAY_WINDOW_MS = 30000;
  assert.ok(budget > 0, "the command budget must be a positive number of milliseconds");
  assert.ok(
    budget < RELAY_WINDOW_MS,
    `the command budget (${budget}ms) must fit inside the ${RELAY_WINDOW_MS}ms relay window`,
  );
  // …with real slack, not by a millisecond: the reply still has to be composed, serialized
  // and pushed through the websocket after the last step returns.
  assert.ok(
    RELAY_WINDOW_MS - budget >= 5000,
    `only ${RELAY_WINDOW_MS - budget}ms of slack between the command budget and the relay window`,
  );

  // The naive sum, still computed, because it is what the cap exists to defeat.
  //
  // ALREADY REGISTERED: the seed wait, then the fast path, which on a hang times out and
  // falls through to the whole-schema fetch — they compose rather than exclude each other,
  // because a timeout is doubt and doubt takes the full fetch. No refresh: the type is
  // registered.
  const registeredPath = seed + single + single + registration;
  // A run's worst-case WAITING is its budget, full stop. It was `run + floor` while the
  // combo phase carried NODE_DEFS_COMBO_FLOOR_MS; #1193 removed that floor on measurement
  // (it fires only when the fetch was slow, and refreshComboInNodes re-fetches from that
  // same slow backend), so this term shrinks rather than grows. The command budget caps
  // what the add PAYS either way, not what a run inside it may cost.
  const runWait = run;
  // NOT REGISTERED: no fast path (it is gated on already-registered), then the whole-schema
  // fetch, then the resolver hands the payload to refreshComfyNodeDefs — which waits for
  // any in-flight run and then performs its own, so the run wait is paid twice.
  const unregisteredPath = seed + single + runWait + runWait + registration;
  const naiveSum = Math.max(registeredPath, unregisteredPath);
  // The tracked-ceiling ratchet this replaces was scoped "while #1192 is open" and said to
  // swap in the FITS assertion once the fix landed. This is that assertion: the naive sum
  // must STILL exceed the budget (the bounds were capped, not shrunk — a sum under the
  // budget would mean the cap is decorative and the shrink bought it with false refusals),
  // and the assertions below pin that the cap is wired at every step.
  assert.ok(
    naiveSum > budget,
    `the per-step bounds sum to ${naiveSum}ms, which no longer exceeds the ${budget}ms budget — ` +
      "if that is because the bounds were SHRUNK rather than capped, the cap has become " +
      "decorative and the shrink bought the budget with false refusals on healthy installs. " +
      "Re-read the notes at each constant before changing this.",
  );

  // No SINGLE step may be given more than the whole command. A step that could is one that
  // reaches the relay window on its own, which is the condition this issue is about.
  for (const [what, ms] of [
    ["the baseline seed wait", seed],
    ["the single-call fetch bound", single],
    ["the refresh run budget", run],
    // #1193 — a run's worst-case wait IS its budget now that the combo phase carries no
    // floor over it. Kept as its own row anyway: it is the term a future floor would grow,
    // and this is the place that growth has to be seen.
    ["a refresh run's worst-case wait", runWait],
    ["the registration deadline", registration],
  ]) {
    assert.ok(ms <= budget, `${what} (${ms}ms) is larger than the whole command budget (${budget}ms)`);
  }

  // ── The cap is WIRED, at every step, read from the shipped source ─────────────
  //
  // These are the assertions that fail when the fix is removed. Everything above passes
  // whether or not a single call site consults the budget.
  const at = src.indexOf("  async graph_add_node({ class_type, pos, title }) {");
  assert.ok(at > 0, "graph_add_node must be findable in the panel source");
  const body = src.slice(at, src.indexOf("\n  async graph_", at + 10));

  // Taken ONCE, before the first step, on the monotonic clock — like every other elapsed
  // measurement in this panel. On the wall clock an NTP correction mid-command either
  // refuses an add that did nothing wrong or extends it past the window it exists to fit.
  assert.match(
    body,
    /const budget = makeCommandBudget\(ADD_NODE_COMMAND_BUDGET_MS, monotonicNow\);/,
    "the command must take ONE deadline, before any step, on the monotonic clock",
  );

  // Every step draws from it. Named individually rather than counted, so adding a step
  // cannot silently satisfy a total.
  const wired = [
    [/await awaitObjectInfoHistorySeed\(budget\.bounded\(OBJECT_INFO_SEED_WAIT_MS\)\)/, "the baseline seed wait"],
    [
      /fetchSingleNodeDef\(class_type[\s\S]{0,400}?budget\.bounded\(NODE_DEFS_FETCH_TIMEOUT_MS\)/,
      "the single-class fast path",
    ],
    [/await boundedGetNodeDefs\(budget\.bounded\(NODE_DEFS_FETCH_TIMEOUT_MS\)\)/, "the whole-schema fetch"],
    // The fifth wait — the coalescer join — is NOT a row here. #1385: it has two call sites,
    // so a body-wide match is satisfied by whichever one is left. It is pinned per call site
    // below instead.
    [/budget\.bounded\(CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS\)/, "the custom-widget registration wait"],
  ];
  for (const [re, what] of wired) {
    assert.match(body, re, `${what} must draw its bound from the command budget`);
  }

  // …and NO step may still name one of those constants raw. This is what catches a bound
  // added to this path LATER: the failure mode is not that an existing site regresses, it is
  // that the sixth site nobody thought about is written the way the first five used to be.
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const name of [
    "OBJECT_INFO_SEED_WAIT_MS",
    "NODE_DEFS_FETCH_TIMEOUT_MS",
    "CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS",
  ]) {
    const total = (stripped.match(new RegExp(name, "g")) ?? []).length;
    const capped = (stripped.match(new RegExp(`budget\\.bounded\\(${name}\\)`, "g")) ?? []).length;
    assert.equal(
      total,
      capped,
      `${name} appears ${total} time(s) in graph_add_node but only ${capped} are capped by the command budget`,
    );
  }

  // ── THE FIFTH WAIT: EVERY coalescer call, not "one of them somewhere" ─────────
  //
  // #1385 — this used to be one more row in `wired`, a single `assert.match` for
  // `joinMs: budget.remaining() - ADD_NODE_POST_REFRESH_RESERVE_MS` anywhere in the body.
  // There are TWO calls carrying it — the resolver's join and #1242's forced drift recovery —
  // so unwrapping either left the other satisfying the regex and the pin passed over a
  // half-unwired file. Verified by mutation in BOTH directions on the shipped source: with
  // one call's `joinMs` deleted this test still passed in ~2s, either way round.
  //
  // That is the worst wait in this command to lose quietly. Its absence does not fail a
  // test, it HANGS — deleting the resolver's `joinMs` left add-node-command-budget.test.mjs
  // running until an external cap killed it, and `npm run test:unit` passes no
  // --test-timeout, so node:test buffered the whole file's output and printed nothing at
  // all. A named assertion here is what turns that into a sentence.
  //
  // ENUMERATED, not counted: "there are 2" goes stale the moment a third call site is
  // written unbounded, which is this same defect in a new place. Every call the body makes
  // must carry the bound, however many there turn out to be.
  const coalescerCalls = callArgumentLists(stripped, "refreshComfyNodeDefs");
  assert.ok(
    coalescerCalls.length >= 2,
    `graph_add_node should still make both coalescer calls (the resolver's join and #1242's ` +
      `forced drift recovery); found ${coalescerCalls.length} — if one was deliberately ` +
      "removed, say which here rather than lowering the floor",
  );
  coalescerCalls.forEach((args, i) => {
    assert.match(
      args,
      /joinMs: budget\.remaining\(\) - ADD_NODE_POST_REFRESH_RESERVE_MS/,
      `refreshComfyNodeDefs call ${i + 1} of ${coalescerCalls.length} in graph_add_node does ` +
        "not draw its join bound from the command budget — unbounded, that call waits out a " +
        `run started under someone else's deadline. Its arguments: ${args.trim()}`,
    );
  });

  // The reserve is DERIVED from the step it protects, not picked, so the two cannot drift.
  assert.match(
    src,
    /const ADD_NODE_POST_REFRESH_RESERVE_MS = CUSTOM_WIDGET_REGISTRATION_TIMEOUT_MS;/,
    "the post-refresh reserve must be derived from the wait it holds time back for",
  );

  // The coalescer's join can only be bounded if the panel WIRED the bounding primitive into
  // it. A one-line wiring omission is invisible to the coalescer's own unit tests — those
  // inject their own — and silently restores the unbounded wait this issue is about.
  const wiredAt = src.indexOf("const refreshComfyNodeDefs = makeRefreshCoalescer({");
  assert.ok(wiredAt > 0, "the panel's coalescer construction must be findable");
  const coalescer = src.slice(wiredAt, src.indexOf("});", wiredAt));
  assert.match(coalescer, /\n\s*withTimeout,/, "the panel's coalescer must be wired with the bounding primitive");
});

test("#1192: an add that gave up waiting for someone else's refresh says so, and says retry", () => {
  // The resolver SWALLOWS a refresh throw by design — its post-refresh registry re-check is
  // what decides go/no-go — so the reason an add ran out of budget cannot reach the user
  // through the resolver's own wording, which says "the node-def refresh failed — reload the
  // ComfyUI tab and retry". That advice is wrong here in the expensive direction: the
  // refresh did NOT fail, it is still running and about to register the very class being
  // asked for. Same class of defect as #663 and #852 — a refusal naming a remedy that cannot
  // work costs more than the refusal itself.
  const src = readFileSync(PANEL_JS, "utf8");
  const at = src.indexOf("  async graph_add_node({ class_type, pos, title }) {");
  const body = src.slice(at, src.indexOf("\n  async graph_", at + 10));

  // Recovered through a FLAG and the live registry — two structured conditions — never by
  // matching the resolver's prose. Reading a decision off an error message is how this repo
  // authorizes things it should not.
  assert.match(
    body,
    /if \(outcome === REFRESH_JOIN_ABANDONED\) refreshJoinAbandoned = true;/,
    "the abandoned join must be recorded as a flag, not inferred from an error string",
  );
  assert.match(
    body,
    /if \(refreshJoinAbandoned && !isRegisteredNodeType\(LG\?\.registered_node_types \?\? \{\}, class_type\)\)/,
    "…and re-worded only when the class is ALSO still unregistered — the in-flight run may have landed",
  );
  assert.ok(
    !/refreshJoinAbandoned[\s\S]{0,300}?err\?*\.message/.test(body),
    "the budget refusal must never be decided by reading the resolver's message",
  );

  // The wording itself must state that nothing was added, and that a retry is the remedy.
  //
  // Anchored with `\r?\n`, not `\n`. The working tree is CRLF, so a bare `;\n` matches
  // NOWHERE, `indexOf` returns -1, and `slice(at, -1)` silently hands back most of the file
  // — which then contains "reload" for a hundred unrelated reasons and the assertion below
  // fails on correct code. The mirror-image version of that mistake (an anchor that misses
  // and reads as a caught mutation) is recorded in #1188.
  const msg = (src.match(/const addNodeRefreshBusyMessage =[\s\S]*?;\r?\n/) || [])[0];
  assert.ok(msg, "the busy refusal's wording must be findable");
  assert.match(msg, /NOTHING WAS ADDED/, "the refusal must say the graph was not touched");
  assert.match(msg, /RETRY/, "…and that a retry is the remedy, because the in-flight run is registering these defs");
  assert.ok(
    !/reload/i.test(msg),
    "…and must NOT send the user to reload the tab, which throws away canvas state for a refresh that is working",
  );
});
