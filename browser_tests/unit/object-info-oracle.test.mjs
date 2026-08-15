/**
 * #982 — `panel_set_widget` refused a write with "object_info is unavailable — the
 * backend is unreachable or the fetch failed" while the reporter's ComfyUI was healthy
 * and `/object_info/VAELoader` answered on the same machine. Reads worked,
 * `panel_set_workflow_target` reported bound, and `panel_refresh_nodes` answered
 * `ok:true, refreshed:false`.
 *
 * Two separate problems in that one sentence:
 *
 *   1. ONE TRANSPORT — the oracle only ever asked `api.getNodeDefs()`, so a frontend
 *      client that fails after a restart made a reachable backend read as unreachable.
 *   2. A DISJUNCTION INSTEAD OF AN OBSERVATION — "unreachable or the fetch failed" names
 *      two causes and establishes neither, and the first half is what sent the reporter
 *      checking a backend that was fine.
 *
 * The oracle now asks the SAME question by a second route before giving up, and records
 * what each attempt actually did so the refusal can say it. The per-class
 * `/object_info/<Type>` route is deliberately NOT used as the fallback: `set_widget`
 * authorizes two types for a promoted write and fetches before resolving which target it
 * writes to, so a single-class payload answers one question and reads the other as absent
 * (#716/#821). The fallback changes the transport, never the question.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  fetchWholeObjectInfo,
  objectInfoOracleFailureNote,
  // The SHIPPED budget, so a test cannot pass against a value the panel does not use.
  OBJECT_INFO_DEADLINE_MS,
  outcomeKind,
  TRANSPORT_SENTINELS,
} from "../../web/js/lib/object-info-oracle.js";

const SCHEMA = { KSampler: { input: {} }, VAELoader: { input: {} } };
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test("#982 the client route answers: the fallback is never reached", async () => {
  let fetched = 0;
  const { defs, failures } = await fetchWholeObjectInfo({
    getNodeDefs: async () => SCHEMA,
    fetchApi: async () => {
      fetched += 1;
      return okResponse(SCHEMA);
    },
  });
  assert.deepEqual(defs, SCHEMA);
  assert.deepEqual(failures, []);
  assert.equal(fetched, 0, "a working first route must not cost a second request");
});

test("#982 the reported case: the client THROWS and the HTTP route answers", async () => {
  const { defs, failures } = await fetchWholeObjectInfo({
    getNodeDefs: async () => {
      throw new Error("Failed to fetch");
    },
    fetchApi: async (route) => {
      assert.equal(route, "/object_info", "the fallback asks the WHOLE schema, not one class");
      return okResponse(SCHEMA);
    },
  });
  assert.deepEqual(defs, SCHEMA, "a reachable backend is no longer read as unreachable");
  assert.equal(failures.length, 1);
  assert.match(failures[0], /api\.getNodeDefs\(\) threw: Failed to fetch/, "and what failed is recorded verbatim");
});

test("#982 (codex r2) an EMPTY map from the client is its ANSWER — the fallback is not consulted", async () => {
  // A client that deliberately filters could express deny-all as `{}`. Asking the raw
  // route then would overrule it with a broader schema, which is the one direction this
  // fallback must never move. `{}` therefore fails closed WITHOUT a second attempt.
  let fetched = 0;
  const { defs, failures } = await fetchWholeObjectInfo({
    getNodeDefs: async () => ({}),
    fetchApi: async () => {
      fetched += 1;
      return okResponse(SCHEMA);
    },
  });
  assert.equal(defs, null, "fail closed on the answer the client gave");
  assert.equal(fetched, 0, "the raw route is never asked to overrule it");
  assert.match(failures[0], /EMPTY schema — treated as its answer, not as an absence/);
});

test("#982 a client that returned NOTHING leaves the question open, and the fallback answers", async () => {
  for (const nothing of [null, undefined, "nope", 42]) {
    const { defs, failures } = await fetchWholeObjectInfo({
      getNodeDefs: async () => nothing,
      fetchApi: async () => okResponse(SCHEMA),
    });
    assert.deepEqual(defs, SCHEMA, `client returned ${String(nothing)}`);
    assert.match(failures[0], /returned no usable schema/);
  }
});
test("#982 both routes failing yields NO defs and names both", async () => {
  const { defs, failures } = await fetchWholeObjectInfo({
    getNodeDefs: async () => null,
    fetchApi: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(defs, null, "fail closed — the fence refuses on a null payload");
  assert.equal(failures.length, 2);
  assert.match(failures[0], /api\.getNodeDefs\(\) returned no usable schema/);
  assert.match(failures[1], /GET \/object_info was not OK \(status 503\)/);
});

test("#982 a missing capability is itself recorded, not silently skipped", async () => {
  const noClient = await fetchWholeObjectInfo({ fetchApi: async () => okResponse(SCHEMA) });
  assert.deepEqual(noClient.defs, SCHEMA);
  assert.match(noClient.failures[0], /api\.getNodeDefs is not a function/);

  const nothing = await fetchWholeObjectInfo({});
  assert.equal(nothing.defs, null);
  assert.equal(nothing.failures.length, 2, "both absences are named");
  assert.match(nothing.failures[1], /no fetchApi is wired/);
});

test("#982 a body that will not parse is a failure, never a partial answer", async () => {
  const { defs, failures } = await fetchWholeObjectInfo({
    getNodeDefs: async () => null,
    fetchApi: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }),
  });
  assert.equal(defs, null);
  assert.match(failures[1], /GET \/object_info threw: Unexpected token/);
});

test("#982 an ARRAY is not a schema", async () => {
  const { defs } = await fetchWholeObjectInfo({ getNodeDefs: async () => [1, 2, 3], fetchApi: null });
  assert.equal(defs, null, "a non-map payload cannot answer 'does the backend define this type'");
});

test("#982 the note lists what was tried, and says nothing when nothing was recorded", () => {
  assert.equal(objectInfoOracleFailureNote([]), "", "a clean run adds no hollow clause");
  assert.equal(objectInfoOracleFailureNote(null), "");
  assert.equal(objectInfoOracleFailureNote(undefined), "");
  const one = objectInfoOracleFailureNote(["api.getNodeDefs() threw: boom"]);
  assert.match(one, /Tried one route: api\.getNodeDefs\(\) threw: boom\./);
  const two = objectInfoOracleFailureNote(["a", "b"]);
  assert.match(two, /Tried 2 routes: a; b\./);
});

test("#982 source guard: the refusal states an observation, and the panel wires both routes", () => {
  const resolve = readFileSync(new URL("../../web/js/lib/node-resolve.js", import.meta.url), "utf8");
  assert.match(resolve, /no usable \/object_info schema was obtained/, "what was observed");
  assert.ok(
    !/object_info is unavailable — the backend is unreachable or the fetch\s*\n?\s*\* *failed/.test(resolve),
    "the disjunction that asserted an unreachable backend is gone from the set_widget refusal",
  );
  const panel = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(panel, /fetchWholeObjectInfo\(\{/, "the panel asks through the two-transport oracle");
  // #1223 wrapped this across lines to append the snapshot's ineligibility reason AFTER
  // the route note — deliberately outside `failures`, so "Tried N routes" stays honest.
  assert.match(
    panel,
    /describeObjectInfoFailure: \(\) =>\s*objectInfoOracleFailureNote\(oracleFailures\)/,
    "and can report what failed",
  );
  // The burst cache still wraps it: two transports must not become two fetches per write.
  // Either entry point satisfies that — #1126 added `readWithProvenance` so the cache can
  // also report whether the answer it served is LIVE, and the set_widget/remove_widget routes
  // take that form. What this asserts is the property the issue cares about: the oracle is
  // reached THROUGH the cache, never called directly.
  assert.match(
    panel,
    /await objectInfoCache\.read(WithProvenance)?\(\s*async \(\) =>/,
    "still read through the #716 cache",
  );
  assert.doesNotMatch(
    panel,
    /^\s*const outcome = await fetchWholeObjectInfo\(/m,
    "and never around it",
  );
});

test("#982 (codex) the fallback is consulted ONLY when the client returned nothing usable", () => {
  // If `api.getNodeDefs()` ever narrows the schema, the raw route would be the broader
  // answer — so the fallback must never be able to override an answer the client gave.
  const src = readFileSync(new URL("../../web/js/lib/object-info-oracle.js", import.meta.url), "utf8");
  const clientBlock = src.slice(src.indexOf("if (typeof getNodeDefs === \"function\")"), src.indexOf("// SECOND TRANSPORT"));
  assert.match(
    clientBlock,
    /if \(usableDefs\(defs\)\) return \{ \[CACHE_OUTCOME\]: true, defs, failures, outcomes \};/,
    "a usable client answer returns",
  );
  // …and the measured equivalence is recorded rather than assumed.
  assert.match(src, /MEASURED on ComfyUI 0\.31\.1 \/ frontend 1\.48\.7/, "the comparison is on the record");
  assert.match(src, /That is\s*\n? \* evidence, not a contract/, "and its limit is stated");
});

test("#982 (codex) untrusted failure text is flattened and capped", () => {
  const nasty = "line one\nline two\r\nthird\u0007bell " + "x".repeat(500);
  const note = objectInfoOracleFailureNote([nasty]);
  assert.ok(!note.includes("\n") && !note.includes("\r"), "no newline can forge structure in the reply");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(note), "no control characters survive");
  assert.ok(note.length < 400, `capped, got ${note.length}`);
  assert.match(note, /truncated/, "and the truncation is disclosed rather than silent");
});

test("#982 (codex) a thrown value's own words are flattened at the source", async () => {
  const { failures } = await fetchWholeObjectInfo({
    getNodeDefs: async () => {
      throw new Error("first\nsecond\ttab");
    },
    fetchApi: null,
  });
  assert.equal(failures[0].includes("\n"), false);
  assert.match(failures[0], /first second tab/);
});

test("#982 (codex) the observed failures are PER-REQUEST, not module state", () => {
  // A concurrent refresh or a second widget write would otherwise overwrite the record
  // between one request's failed fetch and its refusal, so the message would name routes
  // another call tried. The variable lives in the handler's own scope.
  const panel = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const handler = panel.slice(panel.indexOf("async graph_set_widget({"));
  const body = handler.slice(0, handler.indexOf("\n  async "));
  assert.match(body, /let oracleFailures = \[\];/, "declared inside the handler");
  assert.match(body, /oracleFailures = defs \? \[\] : \(outcome\?\.failures \?\? \[\]\);/, "written there");
  assert.match(body, /objectInfoOracleFailureNote\(oracleFailures\)/, "and read there");
  assert.ok(
    !/lastObjectInfoOracleFailures/.test(panel),
    "no module-scope record survives — that is the cross-request race",
  );
});

test("#982 (codex) a control character cannot forge structure at either boundary", () => {
  const nasty = "a\u0000b\u001fc\u007fd\u009fe";
  assert.match(objectInfoOracleFailureNote([nasty]), /a b c d e/, "collapsed, not stripped into a run-on");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(objectInfoOracleFailureNote([nasty])));
});

test("#982 (codex r2) a JOINED read still learns which routes were tried", async () => {
  // The burst cache coalesces concurrent reads: only the producer runs the loader. If the
  // loader returned bare defs, a second widget write joining a FAILED read would refuse
  // while naming no routes at all. The OUTCOME rides through the cache instead.
  const { createObjectInfoCache } = await import("../../web/js/lib/object-info-cache.js");
  const cache = createObjectInfoCache();
  let loaderRuns = 0;
  const load = async () => {
    loaderRuns += 1;
    await new Promise((r) => setTimeout(r, 5));
    return fetchWholeObjectInfo({ getNodeDefs: async () => null, fetchApi: async () => ({ ok: false, status: 502 }) });
  };
  const [a, b] = await Promise.all([cache.read(load), cache.read(load)]);
  assert.equal(loaderRuns, 1, "the second read joined the first");
  for (const outcome of [a, b]) {
    assert.equal(outcome.defs, null, "both fail closed");
    assert.equal(outcome.failures.length, 2, "and both can name the routes");
    assert.match(outcome.failures[1], /status 502/);
  }
  assert.equal(cache.peek().cached, false, "a failed outcome is never cached — the wrapper must not fool it");
});

test("#982 (codex r2) a SUCCESSFUL outcome still caches, and the payload is what gets stored", async () => {
  const { createObjectInfoCache } = await import("../../web/js/lib/object-info-cache.js");
  const cache = createObjectInfoCache();
  let runs = 0;
  const load = async () => {
    runs += 1;
    return fetchWholeObjectInfo({ getNodeDefs: async () => SCHEMA, fetchApi: null });
  };
  const first = await cache.read(load);
  const second = await cache.read(load);
  assert.equal(runs, 1, "the second read came from the cache");
  assert.deepEqual(first.defs, SCHEMA);
  assert.deepEqual(second.defs, SCHEMA);
  assert.equal(cache.peek().cached, true);
});

test("#982 (codex r2) the note caps HOW MANY routes it names, and says how many it dropped", () => {
  const many = Array.from({ length: 9 }, (_, i) => `route ${i} failed`);
  const note = objectInfoOracleFailureNote(many);
  assert.match(note, /Tried 9 routes/, "the count is honest");
  assert.match(note, /and 5 more not shown/, "a truncated list must not read as the whole list");
  assert.ok(note.length < 400, `bounded, got ${note.length}`);
});

test("#982 (codex r2) a value that cannot be stringified yields text, never a throw", () => {
  const hostile = {
    toString() {
      throw new Error("nope");
    },
  };
  assert.doesNotThrow(() => objectInfoOracleFailureNote([hostile]));
  assert.match(objectInfoOracleFailureNote([hostile]), /an unprintable value/);
  assert.doesNotThrow(() => objectInfoOracleFailureNote([Symbol("s")]));
});

test("#982 (codex r3) a node type literally named `defs` is not mistaken for an outcome wrapper", async () => {
  // A structural `"defs" in value` test collided with a real schema key: a bare map
  // containing a node type called `defs` would have been unwrapped, and that single
  // definition would have become the cached schema. The tag is a Symbol, which JSON
  // cannot carry, so only a deliberate producer can be read as a wrapper.
  const { createObjectInfoCache, CACHE_OUTCOME } = await import("../../web/js/lib/object-info-cache.js");
  const cache = createObjectInfoCache();
  // The node named `defs` carries an EMPTY definition, which is what makes the two rules
  // differ observably: a structural test would take `{}` as the payload, judge it
  // unusable, and decline to cache a perfectly good schema — reinstating the full
  // re-fetch per write that #716 exists to prevent.
  const schemaWithDefsNode = { defs: {}, KSampler: { input: {} } };
  let loads = 0;
  const load = async () => {
    loads += 1;
    return schemaWithDefsNode;
  };
  assert.deepEqual(await cache.read(load), schemaWithDefsNode, "a bare schema comes back whole");
  assert.deepEqual(await cache.read(load), schemaWithDefsNode);
  assert.equal(loads, 1, "the second read was served from the cache — the schema WAS stored");
  assert.equal(cache.peek().cached, true);

  // A genuinely tagged outcome still unwraps.
  const tagged = createObjectInfoCache();
  const outcome = { [CACHE_OUTCOME]: true, defs: schemaWithDefsNode, failures: [] };
  assert.deepEqual(await tagged.read(async () => outcome), outcome);
  assert.equal(tagged.peek().cached, true);
});

test("#982 (codex r4) blank entries: the slice-first order is documented, not accidental", () => {
  // Slicing before sanitizing is what bounds the work, and for the inputs this module
  // produces (every recorded attempt is non-empty) the two orders agree. They do NOT
  // agree for arbitrary caller input, and this pins the behaviour that follows from the
  // order actually chosen, so nobody reads the surviving mutant as "it makes no difference".
  assert.equal(objectInfoOracleFailureNote(["", "", "", "", "x"]), "", "four blanks consume the window");
  assert.match(objectInfoOracleFailureNote(["x", "", "", "", ""]), /Tried 5 routes: x \(and 1 more not shown\)\./);
});

// ── #1161: a transport that never ANSWERS must not park the whole oracle ─────
//
// The P1. After a ComfyUI restart the tab can hold a half-open connection, so
// `api.getNodeDefs()` never settles — it does not throw, it simply never answers. Both
// awaits here were unbounded, so the oracle parked on the first transport and the second
// route — added by #982 for exactly this failure — was never asked. Every command that
// consults it hung until its caller timed out at 30s.
//
// The bound is not a way to fail faster. Its point is that the SECOND route usually
// answers, so the write SUCCEEDS. That is why it belongs here and not around the cache,
// where three attempts on #1178 could only choose how to give up.
//
// Timers are injected and fired by hand, so nothing here waits on a real clock and a
// regression fails with a named assertion rather than wedging `node --test`.
//
// THE CLOCK ADVANCES WHEN A TIMER FIRES, and that is not a detail. The first version of
// this harness fired the injected timer while leaving `now()` at 0, so every test ran with
// the full budget still unspent — a state production CANNOT reach, since a timer armed for
// `ms` only fires once `ms` has passed. Under that harness the flagship test below passed
// while the shipped code never issued the fallback at all (`fetchApi` call count 0). The
// clock is therefore owned here and moved by `fire()`, so a test cannot assert an outcome
// the real clock would not produce.
function harness() {
  const timers = new Set();
  const armedMs = [];
  let clock = 0;
  return {
    timers: {
      setTimer: (fn, ms) => { const t = { fn, ms }; timers.add(t); armedMs.push(ms); return t; },
      clearTimer: (t) => timers.delete(t),
    },
    now: () => clock,
    armed: () => timers.size,
    armedMs: () => armedMs.slice(),
    at: () => clock,
    fire: () => {
      const due = [...timers];
      // Firing a timer means its full duration elapsed — the longest one pins the clock.
      clock += due.reduce((max, t) => Math.max(max, t.ms), 0);
      due.forEach((t) => { timers.delete(t); t.fn(); });
    },
  };
}
const DEFS_1161 = { KSampler: {} };
// Never await an oracle call unbounded: node --test has no default timeout, so a
// regression would wedge the suite instead of naming itself. The previous branch was
// caught doing exactly this.
const settled = (p, what) =>
  Promise.race([
    p,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} never settled — a transport was not bounded`)), 250),
    ),
  ]);
// Let the oracle reach its next await and arm THAT timer before firing. A macrotask
// flushes every pending microtask, which counting ticks does not reliably do — an earlier
// draft fired the response timer before it had unwrapped and timed out the wrong stage.
const tick = () => new Promise((r) => setTimeout(r, 0));
const never = () => new Promise(() => {});

test("#1161: a hung client route falls through to the fallback, which ANSWERS", async () => {
  // The whole point: not a faster refusal — a successful write.
  const h = harness();
  let fetchCalls = 0;
  const out = fetchWholeObjectInfo({
    getNodeDefs: never,
    fetchApi: async () => { fetchCalls += 1; return { ok: true, json: async () => DEFS_1161 }; },
    deadlineMs: 6000,
    timers: h.timers,
    now: h.now,
  });
  await tick();
  h.fire(); // the client route gives up, and the clock moves to when it did
  const result = await settled(out, "the oracle call");
  // ASSERT THE REQUEST WAS ACTUALLY SENT, not merely that the outcome looks right. This is
  // the fact the earlier version of this branch got wrong while its suite stayed green: the
  // client route consumed the entire shared budget, so the fallback was skipped unsent
  // (call count 0) and the refusal then named a route nothing had contacted. An outcome
  // assertion alone cannot see that; a call count can.
  assert.equal(fetchCalls, 1, "the fallback must be ISSUED — a reserved floor is what guarantees it");
  assert.deepEqual(result.defs, DEFS_1161, "the fallback answered, so the caller is authorized");
  assert.match(result.failures.join(" | "), /api\.getNodeDefs\(\) did not answer within its \d+ms share of the 6000ms budget/);
});

test("#1161: no route is ever REPORTED as timing out when it was never sent", async () => {
  // #982's original defect was a refusal naming a cause it had not established. A step
  // reached with no budget left must say so in its own words rather than borrow the
  // timeout's, or the fix reintroduces the bug it was written to remove.
  // A zero budget is the one input that still reaches this branch, now that the floor
  // makes a hung client route unable to starve the fallback. It is a REAL path — the
  // caller injects the budget — and it pins the wording for whatever else reaches it.
  let fetchCalls = 0;
  const result = await fetchWholeObjectInfo({
    getNodeDefs: never,
    fetchApi: async () => { fetchCalls += 1; return { ok: true, json: async () => DEFS_1161 }; },
    deadlineMs: 0,
  });
  const note = result.failures.join(" | ");
  assert.equal(fetchCalls, 0, "this test only means something if the route really was skipped");
  assert.equal(result.defs, null, "and nothing unasked-for is authorized");
  assert.doesNotMatch(note, /did not answer within/, "an unsent request cannot have failed to answer");
  assert.match(note, /GET \/object_info was not attempted/, "…it reports what actually happened instead");
  assert.match(note, /api\.getNodeDefs\(\) was not attempted/, "both routes speak for themselves");
});

test("#1161: the fallback's budget is a FLOOR, not merely what the first step left over", async () => {
  // Subtracting a reserve makes the fallback depend on the client route finishing on time.
  // Measured: at small deadlines the per-step overhead alone overran the subtraction and
  // the fallback was skipped again — the exact defect being fixed, back by another door.
  // Taking the max() instead makes the guarantee independent of the first step entirely.
  for (const deadlineMs of [5, 10, 50, 200]) {
    let fetchCalls = 0;
    const result = await fetchWholeObjectInfo({
      getNodeDefs: never,
      fetchApi: async () => { fetchCalls += 1; return { ok: true, json: async () => DEFS_1161 }; },
      deadlineMs,
    });
    assert.equal(fetchCalls, 1, `deadlineMs=${deadlineMs}: the fallback must still be issued`);
    assert.deepEqual(result.defs, DEFS_1161, `deadlineMs=${deadlineMs}: and its answer used`);
  }
});

test("#1161: the timeout is reported as a timeout, not as a throw", async () => {
  // withTimeout never rejects by contract, so a naive wrap would collapse "it threw" into
  // "it timed out" and the refusal would name the wrong cause — the trap that bit #1178.
  const h = harness();
  const out = fetchWholeObjectInfo({
    getNodeDefs: async () => { throw new Error("client exploded"); },
    fetchApi: never,
    deadlineMs: 6000,
    timers: h.timers,
    now: h.now,
  });
  await tick();
  h.fire();
  const result = await settled(out, "the oracle call");
  const note = result.failures.join(" | ");
  assert.match(note, /api\.getNodeDefs\(\) threw: client exploded/, "a throw keeps its own cause");
  assert.match(note, /GET \/object_info did not answer within its \d+ms share of the 6000ms budget/, "…and a hang keeps its own");
});

test("#1161: both transports hanging still returns, and names both", async () => {
  const h = harness();
  const out = fetchWholeObjectInfo({ getNodeDefs: never, fetchApi: never, deadlineMs: 6000, timers: h.timers, now: h.now });
  await tick();
  h.fire();
  await tick();
  h.fire();
  const result = await settled(out, "the oracle call");
  assert.equal(result.defs, null, "nothing answered, so nothing is authorized — still fail-closed");
  assert.equal(result.failures.length, 2, "each route reports for itself");
  for (const f of result.failures) assert.match(f, /did not answer within its \d+ms share of the 6000ms budget/);
});

test("#1161: a hung BODY is bounded too — the response is not the body", async () => {
  // res.json() is a second I/O step and was inside the try/catch the bound replaced. A 5MB
  // schema over a half-open connection can stall after the headers arrive.
  const h = harness();
  const out = fetchWholeObjectInfo({
    getNodeDefs: async () => null,
    fetchApi: async () => ({ ok: true, json: never }),
    deadlineMs: 6000,
    timers: h.timers,
    now: h.now,
  });
  await tick();
  h.fire();
  const result = await settled(out, "the oracle call");
  assert.equal(result.defs, null);
  assert.match(result.failures.join(" | "), /body did not arrive within its \d+ms share of the 6000ms budget/);
});

test("#1161: a healthy client route is untouched by the bound", async () => {
  const h = harness();
  const result = await fetchWholeObjectInfo({
    getNodeDefs: async () => DEFS_1161,
    fetchApi: () => { throw new Error("must not be consulted"); },
    deadlineMs: 6000,
    timers: h.timers,
    now: h.now,
  });
  assert.deepEqual(result.defs, DEFS_1161);
  assert.deepEqual(result.failures, [], "a route that answers records no failure");
  assert.equal(h.armed(), 0, "and leaves no timer armed");
});

test("#1161: the SHIPPED budget is a real bound, sized for the payload not a ping", async () => {
  // Every other #1161 test injects its own budget, so none of them would notice the
  // shipped constant being set to 0 — which disables the bound entirely by withTimeout's
  // contract and reinstates the P1 with a green suite. Review caught that gap twice.
  assert.ok(OBJECT_INFO_DEADLINE_MS > 0, "a non-positive budget disables the bound");
  // WHAT THE MEASUREMENT IS. The bounded work is one GET of the whole document: 5,413,770
  // bytes / 167ms on a 63-pack install (#767), cited independently in object-info-cache.js
  // and single-node-def.js, and measured live at ~450ms on a 4304-type install. The ~14.5s
  // figure from #610 measures "/object_info + combo refresh" — the download PLUS
  // registerNodesFromDefs plus rebuilding every combo widget — which this oracle does not
  // do. An earlier revision of this file asserted 14.5s here as the download time, and
  // three review rounds then cited that assertion back as the repo's measurement.
  //
  // So the floor is set against the real figure with room to spare: the smallest share any
  // single step gets is half the deadline, which must still clear the measured download by
  // a wide margin rather than merely exceed it.
  assert.ok(
    OBJECT_INFO_DEADLINE_MS / 2 >= 5000,
    "a step's own share must clear the ~167ms measured download by a wide margin, not merely exceed it",
  );
  // …and it must still land inside the bridge's 30s command timeout, so the caller sees
  // this oracle's own answer rather than a bare timeout with no routes named.
  assert.ok(OBJECT_INFO_DEADLINE_MS < 30000, "past the command budget the refusal never reaches the caller");
});

test("#1161: an unreadable response is a failure, never a rejection", async () => {
  // The contract this module states two screens up: "every failure path returns defs:
  // null". Replacing the try/catch with a bound re-protected only the awaits, so reading
  // `ok`/`status` off a proxied or lazily-evaluated response rejected instead. Two callers
  // await this with no try/catch of their own.
  const hostile = { get ok() { throw new Error("wrapped api"); } };
  const result = await fetchWholeObjectInfo({
    getNodeDefs: async () => null,
    fetchApi: async () => hostile,
    deadlineMs: 6000,
  });
  assert.equal(result.defs, null);
  assert.match(result.failures.join(" | "), /unreadable response: wrapped api/);
});

test("#1161: a payload whose own shape cannot be inspected is a failure, never a rejection", async () => {
  // Object.keys invokes a Proxy's ownKeys trap, which can throw — same contract, different
  // entry point, and also proven against main by the review.
  const trapped = new Proxy({}, { ownKeys() { throw new Error("proxy"); } });
  const result = await fetchWholeObjectInfo({
    getNodeDefs: async () => trapped,
    fetchApi: async () => ({ ok: true, json: async () => ({ KSampler: {} }) }),
    deadlineMs: 6000,
  });
  // Nothing rejected — that is the contract this asserts, and the whole point.
  //
  // The OUTCOME is `defs: null` rather than the fallback's schema, and that is correct
  // rather than a shortfall: an uninspectable object still satisfies the "is an object,
  // is not an array" test, so it takes the deliberate-empty branch and is treated as the
  // client's own answer. That is the direction this module already chose for an empty
  // map — the fallback must never widen an answer the client gave — and it fails closed,
  // which is the safe reading of "I could not tell what it said".
  assert.equal(result.defs, null);
});

test("#1161: the budget is shared, so three steps cannot each spend it", async () => {
  // A per-step bound multiplies: three 6s bounds is an 18s worst case nobody chose,
  // stacked on the 8s startup seed wait. One budget makes the worst case one number.
  //
  // But SHARING ALONE IS NOT ENOUGH, which is the correction this test now carries. A
  // purely first-come budget lets step one take all of it, and then the fallback — the
  // entire reason this oracle exists — is skipped rather than merely hurried. So the
  // invariant has two halves: the total never exceeds the deadline, AND no single step can
  // reduce a later one to nothing.
  const h = harness();
  const out = fetchWholeObjectInfo({
    getNodeDefs: never,
    fetchApi: never,
    deadlineMs: 6000,
    timers: h.timers,
    now: h.now,
  });
  await tick();
  h.fire(); // the client route hangs for everything it was given
  await tick();
  const budgets = h.armedMs();
  assert.ok(budgets.length >= 2, "both transports were bounded");
  assert.ok(budgets[0] <= 3000, "the first step may not take more than its share");
  assert.ok(budgets[1] > 0, "the fallback is left a real budget — a zero here is the P1 back");
  h.fire();
  const result = await settled(out, "the oracle call");
  assert.equal(result.defs, null);
  assert.equal(result.failures.length, 2, "each route reports for itself");
  assert.ok(h.at() <= 6000, "and the whole question still costs no more than the one deadline");
});

test("#1161: the reserve holds when the client route hangs for its FULL share", async () => {
  // The production shape of the P1, at the shipped constant rather than a test one: a
  // half-open socket that never settles. The fallback must still be sent.
  const h = harness();
  let fetchCalls = 0;
  const out = fetchWholeObjectInfo({
    getNodeDefs: never,
    fetchApi: async () => { fetchCalls += 1; return { ok: true, json: async () => DEFS_1161 }; },
    deadlineMs: OBJECT_INFO_DEADLINE_MS,
    timers: h.timers,
    now: h.now,
  });
  await tick();
  h.fire();
  const result = await settled(out, "the oracle call");
  assert.equal(fetchCalls, 1, "the shipped budget must reserve room for the fallback too");
  assert.deepEqual(result.defs, DEFS_1161);
});

test("#1161: a status that cannot be STRINGIFIED is a failure, never a rejection", async () => {
  // Guarding the property READ was not enough: `${responseStatus}` interpolates it below
  // the try, and `Object.create(null)` has no toString to convert with. Proven by running
  // this input against the previous commit, which rejected with a TypeError where two
  // callers have no catch of their own.
  const result = await fetchWholeObjectInfo({
    getNodeDefs: async () => null,
    fetchApi: async () => ({ ok: false, status: Object.create(null) }),
  });
  assert.equal(result.defs, null);
  assert.match(result.failures.join(" | "), /GET \/object_info was not OK/);
});

test("#1161: a thrown value that cannot be stringified is a failure, never a rejection", async () => {
  // describeFailure called String(err) OUTSIDE every guard, so a rejection value with a
  // throwing toString escaped the module — the same contract break by a third entry point.
  // The sanitizer already handled this; the defect was stringifying before reaching it.
  const result = await fetchWholeObjectInfo({
    getNodeDefs: async () => { throw { toString() { throw new Error("unprintable"); } }; },
    fetchApi: async () => ({ ok: true, json: async () => DEFS_1161 }),
  });
  // And because it is only a FAILURE, the fallback still runs and the write is authorized.
  assert.deepEqual(result.defs, DEFS_1161, "a hostile error value must not cost the user their answer");
  assert.match(result.failures.join(" | "), /api\.getNodeDefs\(\) threw: \(an unprintable value\)/);
});

test("#1161: a refusal quotes the budget the step ACTUALLY got, not the whole deadline", async () => {
  // Browser-verified against a live 4304-type install: the client route is capped at half
  // the deadline, but the message quoted the deadline — telling the reader it had waited
  // 20000ms when it had waited 10000ms. Naming a number that was never spent is the same
  // defect as #982's "unreachable or the fetch failed": a refusal asserting what it did
  // not establish. Both numbers appear, so the share and the whole are each readable.
  const h = harness();
  const out = fetchWholeObjectInfo({
    getNodeDefs: never,
    fetchApi: never,
    deadlineMs: 6000,
    timers: h.timers,
    now: h.now,
  });
  await tick();
  h.fire();
  await tick();
  h.fire();
  const result = await settled(out, "the oracle call");
  const client = result.failures.find((f) => f.startsWith("api.getNodeDefs()"));
  assert.match(client, /within its 3000ms share of the 6000ms budget/, "half the deadline, said plainly");
  assert.doesNotMatch(client, /within the 6000ms budget/, "the un-spent whole must not be quoted as the wait");
});

test("#1161: a timer that fires LATE cannot starve the fallback", async () => {
  // Chrome clamps hidden-tab timers to ~1/min after five minutes backgrounded; laptop
  // sleep/resume and an NTP forward jump do the same. `spent()` clamps a BACKWARD jump but
  // must not clamp a forward one — that would be lying about elapsed time — so the timer
  // can fire long after its bound and leave the deadline already overrun.
  //
  // Under a subtracted reserve that produced fetchApi call count 0: the P1 exactly, in a
  // tab that was merely in the background. The floor is what makes it survivable, because
  // the fallback's budget stops depending on when the first step finished.
  for (const lateBy of [0, 10_000, 60_000, 600_000]) {
    const pending = [];
    let clock = 0;
    const timers = {
      setTimer: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; },
      clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    };
    let calls = 0;
    const out = fetchWholeObjectInfo({
      getNodeDefs: never,
      fetchApi: async () => { calls += 1; return { ok: true, json: async () => DEFS_1161 }; },
      deadlineMs: OBJECT_INFO_DEADLINE_MS,
      timers,
      now: () => clock,
    });
    for (let i = 0; i < 8 && pending.length; i++) {
      await tick();
      const t = pending.shift();
      if (!t) break;
      clock += t.ms + lateBy; // the timer fires late, and the clock says so
      t.fn();
    }
    const result = await settled(out, `the oracle call (lateBy=${lateBy})`);
    assert.equal(calls, 1, `lateBy=${lateBy}: the fallback must still be issued`);
    assert.deepEqual(result.defs, DEFS_1161, `lateBy=${lateBy}: and its answer used`);
  }
});

test("#1161: an injected clock that THROWS cannot reject out of this module", async () => {
  // The structural version of an invariant that three previous designs asserted in prose
  // and none actually held. Each of those tried to make an untrustworthy `Date.now()` safe:
  // clamping negative readings refunded everything spent (one call ran ~50s against a 20s
  // deadline); a high-water ratchet only sampled at step boundaries, and its test passed
  // with AND without it; charging measured elapsed let a stalled clock refund real time.
  //
  // A clock that THROWS must not cost the caller their answer. The accounting DOES read a
  // clock now — on `performance.now()`, which is monotonic — but `now` is an injected seam,
  // and this module's header promises every failure path returns `defs: null` to two
  // callers that await it with no catch of their own.
  const exploding = () => { throw new Error("the clock is not to be trusted"); };
  const granted = [];
  const result = await fetchWholeObjectInfo({
    getNodeDefs: async () => null,
    fetchApi: async () => ({ ok: true, json: async () => DEFS_1161 }),
    deadlineMs: 20000,
    now: exploding,
    timers: { setTimer: (fn, ms) => { granted.push(ms); return { fn, ms }; }, clearTimer: () => {} },
  });
  assert.deepEqual(result.defs, DEFS_1161, "a hostile clock cannot cost the user their answer");
  assert.ok(
    granted.reduce((a, b) => a + b, 0) <= 20000,
    `granted ${granted.join("+")}ms against a 20000ms budget`,
  );
});

test("#1161: a hung route is CAPPED at its share; a fast one hands the rest back", async () => {
  // BOTH halves matter, and each was broken on its own during this issue.
  //
  // The CAP stops a hung client route consuming the budget and starving the fallback — the
  // original P1, fetchApi call count 0. The RECLAIM stops a client route that answers
  // instantly from spending 10s it never used: charging the full grant there was a shipped
  // regression that refused a 5.4MB payload at 5.5s which both the parent and main
  // delivered at 7.5s.
  const granted = [];
  const armed = [];
  const timers = {
    setTimer: (fn, ms) => { granted.push(ms); const t = { fn, ms }; armed.push(t); return t; },
    clearTimer: (t) => { const i = armed.indexOf(t); if (i >= 0) armed.splice(i, 1); },
  };
  const out = fetchWholeObjectInfo({
    getNodeDefs: never,
    fetchApi: async () => ({ ok: true, json: async () => DEFS_1161 }),
    deadlineMs: OBJECT_INFO_DEADLINE_MS,
    timers,
  });
  await tick();
  armed.shift().fn(); // only the CLIENT route hangs; the fallback answers normally
  const result = await settled(out, "the oracle call");
  assert.deepEqual(result.defs, DEFS_1161, "the fallback still answers after the cap fires");
  assert.equal(granted[0], 10000, "the client route is capped at its half — this is the P1 fix");
  assert.ok(granted[1] <= 10000, `the fallback got ${granted[1]}ms, which cannot exceed what was left`);
  assert.ok(granted[1] > 0, "and it is a real budget, not a token one");

  // Now the reclaim: a client route that answers immediately must cost almost nothing.
  const fast = [];
  await fetchWholeObjectInfo({
    getNodeDefs: async () => null,
    fetchApi: async () => ({ ok: true, json: async () => DEFS_1161 }),
    deadlineMs: OBJECT_INFO_DEADLINE_MS,
    timers: { setTimer: (fn, ms) => { fast.push(ms); return { fn, ms }; }, clearTimer: () => {} },
  });
  assert.equal(fast.length, 3, "client route, response and body are each bounded");
  assert.equal(fast[0], 10000, "the cap on the client route is unchanged");
  assert.ok(fast[1] > 9000, `the response kept ${fast[1]}ms the client route did not use`);
  // Bound tightly enough to SEE the share: with BODY_SHARE at 1 the body keeps what the
  // response left (~20s); at 0.5 it would keep ~10s, which a looser bound accepted — that
  // mutation survived the suite until this assertion was tightened.
  assert.ok(fast[2] > 15000, `the body kept ${fast[2]}ms — main gave it ~19.5s, not 5s or 10s`);
  for (const [i, ms] of fast.entries()) assert.ok(ms > 0, `step ${i} was granted ${ms}ms`);
});

test("#1161: on a clock that ADVANCES, real elapsed stays inside the budget", async () => {
  // The previous version of this test summed only FIRED timer durations, so it could not
  // see the overrun it was named for: a step that ANSWERS costs real time too, and that
  // time went uncounted. Here each answering step advances the clock by exactly what it
  // took, so the reclaim is charged against real work.
  //
  // WHAT IS AND IS NOT GUARANTEED. The cap alone bounds a hung step. The reclaim depends on
  // the clock telling the truth about an answering one — which is what `performance.now()`
  // guarantees, and why it is the default rather than a preference.
  let clock = 0;
  const armed = [];
  const timers = {
    setTimer: (fn, ms) => { const t = { fn, ms }; armed.push(t); return t; },
    clearTimer: (t) => { const i = armed.indexOf(t); if (i >= 0) armed.splice(i, 1); },
  };
  const took = (ms, value) => async () => { clock += ms; return value; };

  // Three honest, slow steps: 18s of real work inside a 20s budget must ANSWER, and must
  // not add up past the budget on the way.
  const slow = await fetchWholeObjectInfo({
    getNodeDefs: took(6000, null),
    fetchApi: took(6000, { ok: true, json: took(6000, DEFS_1161) }),
    deadlineMs: 20000,
    timers,
    now: () => clock,
  });
  assert.deepEqual(slow.defs, DEFS_1161, "18s of honest work inside a 20s budget must ANSWER");
  assert.ok(clock <= 20000, `ran ${clock}ms against a 20000ms budget`);

  // A hung client route, then a slow-but-working fallback: the cap fires and what is left
  // is still enough to answer.
  clock = 0;
  armed.length = 0;
  const out = fetchWholeObjectInfo({
    getNodeDefs: never,
    fetchApi: took(300, { ok: true, json: took(4000, DEFS_1161) }),
    deadlineMs: 20000,
    timers,
    now: () => clock,
  });
  await tick();
  const t = armed.shift();
  clock += t.ms; // the client route hung for exactly as long as it was allowed to
  t.fn();
  const hung = await settled(out, "the oracle call");
  assert.deepEqual(hung.defs, DEFS_1161, "the P1 case still recovers");
  assert.ok(clock <= 20000, `ran ${clock}ms against a 20000ms budget`);
});

test("#1161: a non-finite budget cannot poison the arithmetic", async () => {
  // `deadlineMs: Infinity` made `consumed` infinite, `budget - consumed` NaN, and every
  // later grant NaN — and `Math.max(0, NaN)` is NaN rather than 0, so the fallback was
  // SKIPPED ENTIRELY (call count 0) on an input the unbounded original handled fine.
  //
  // The first fix normalised such a budget to zero, which merely relocated the damage: the
  // oracle then attempted nothing at all. A value that cannot be a budget takes the shipped
  // default instead, so a caller passing garbage still gets a working oracle.
  for (const deadlineMs of [Infinity, -Infinity, NaN, undefined]) {
    let calls = 0;
    const result = await fetchWholeObjectInfo({
      getNodeDefs: async () => null,
      fetchApi: async () => { calls += 1; return { ok: true, json: async () => DEFS_1161 }; },
      deadlineMs,
    });
    assert.equal(calls, 1, `deadlineMs=${String(deadlineMs)}: the fallback must still be ISSUED`);
    assert.deepEqual(result.defs, DEFS_1161, `deadlineMs=${String(deadlineMs)}: and answer`);
  }
  // An explicit non-positive NUMBER is a real choice, and is obeyed rather than overridden.
  for (const deadlineMs of [0, -1]) {
    let calls = 0;
    const result = await fetchWholeObjectInfo({
      getNodeDefs: async () => null,
      fetchApi: async () => { calls += 1; return { ok: true, json: async () => DEFS_1161 }; },
      deadlineMs,
    });
    assert.equal(calls, 0, `deadlineMs=${deadlineMs}: nothing may be attempted`);
    assert.equal(result.defs, null, "…and nothing is authorized");
    assert.match(result.failures.join(" | "), /was not attempted/, "…and it says so plainly");
  }
});

test("#1161: outcomeKind names all four outcomes, including both Symbols", () => {
  // The share-based budget makes "not-tried" unreachable through the public function on a
  // usable budget — every step is reserved a share, so none can be starved to a zero grant.
  // The branch is still live code, and an untested branch here does not misbehave quietly:
  // `"err" in outcome` on a Symbol is a TypeError out of a module documented to always
  // resolve, which two callers await with no catch. That bug shipped once during this issue
  // when a patch replaced a branch instead of adding beside it, so the demux is pinned here
  // directly rather than through a path that can stop reaching it.
  assert.equal(outcomeKind({ err: new Error("boom") }), "threw");
  assert.equal(outcomeKind({ value: { KSampler: {} } }), "value");
  assert.equal(outcomeKind({ value: undefined }), "value", "an undefined payload is still an answer");
  assert.equal(outcomeKind({ err: undefined }), "threw", "presence of `err`, not its truthiness");
  // Both sentinels are Symbols, and neither may reach the `in` test.
  for (const sentinel of TRANSPORT_SENTINELS) {
    const kind = outcomeKind(sentinel);
    assert.ok(kind === "not-tried" || kind === "no-answer", `a sentinel must be named, got ${kind}`);
  }
});

test("#1161: a refusal quotes the budget in force, not the argument it was given", async () => {
  // Reverting the three failure strings from `${budget}` to `${deadlineMs}` survived the
  // whole suite. It matters because the two now DIFFER: a value that cannot be a budget is
  // replaced by the default, and a refusal saying "within its 10000ms share of the
  // Infinityms budget" states something that was never true.
  const result = await fetchWholeObjectInfo({
    getNodeDefs: () => new Promise(() => {}),
    fetchApi: () => new Promise(() => {}),
    deadlineMs: Infinity,
    timers: { setTimer: (fn) => { fn(); return {}; }, clearTimer: () => {} },
  });
  const note = result.failures.join(" | ");
  assert.match(note, new RegExp(`share of the ${OBJECT_INFO_DEADLINE_MS}ms budget`), "the budget actually in force");
  assert.doesNotMatch(note, /Infinity/, "never the uninterpretable argument");
});

test("#1161: a tiny budget still ISSUES the fallback rather than attempting nothing", async () => {
  // `Math.floor(left * share)` truncates to 0 on a small budget, and a zero grant is not a
  // short wait — it is the step never being attempted. Verified before the fix: deadlineMs
  // of 1 or 2 gave fetchApi call count 0, the exact signature this change exists to remove.
  for (const deadlineMs of [2, 3, 5, 50]) {
    let calls = 0;
    await fetchWholeObjectInfo({
      getNodeDefs: async () => null,
      fetchApi: async () => { calls += 1; return { ok: true, json: async () => DEFS_1161 }; },
      deadlineMs,
    });
    assert.equal(calls, 1, `deadlineMs=${deadlineMs}: the fallback must still be issued`);
  }
  // At 1ms there is genuinely nothing to divide across three steps. It must still fail
  // CLOSED and, critically, must not claim a budget was "already spent" when none was.
  const one = await fetchWholeObjectInfo({ getNodeDefs: async () => null, fetchApi: async () => ({ ok: true }), deadlineMs: 1 });
  assert.equal(one.defs, null);
  assert.doesNotMatch(one.failures.join(" | "), /already spent/, "nothing had been spent when the first step ran");
});

test("#1161: an explicitly NULL timers object is not a rejection", async () => {
  // `timers: null` is not `timers: undefined`, and only the latter reaches withTimeout's own
  // default — an explicit null read `.setTimer` off null and rejected out of a module whose
  // header promises every failure path returns `defs: null`, to callers with no catch.
  const result = await fetchWholeObjectInfo({
    getNodeDefs: async () => null,
    fetchApi: async () => ({ ok: true, json: async () => DEFS_1161 }),
    timers: null,
  });
  assert.deepEqual(result.defs, DEFS_1161);
});

test("#1161: a forward clock jump during a step cannot starve the steps after it", async () => {
  // The reclaim charges what a step actually used, which means a clock that leaps FORWARD
  // mid-step reports a spend far larger than the grant that step was even allowed. Without
  // clamping to the grant, that overcharge exhausts the budget and the fallback is skipped
  // — the fetchApi-call-count-0 signature again, arriving through the reclaim rather than
  // through the cap. `performance.now()` should never do this, but `now` is injectable and
  // the Date.now fallback exists, so the clamp is what makes the direction safe.
  let calls = 0;
  let reading = 0;
  const result = await fetchWholeObjectInfo({
    // Answers immediately, but the clock leaps a billion ms while it does.
    getNodeDefs: async () => { reading = 1e9; return null; },
    fetchApi: async () => { calls += 1; return { ok: true, json: async () => DEFS_1161 }; },
    deadlineMs: 20000,
    now: () => reading,
  });
  assert.equal(calls, 1, "the fallback must still be issued — a step cannot spend more than it was granted");
  assert.deepEqual(result.defs, DEFS_1161);
});

test("#1161: a clock returning a non-number cannot reject out of this module", async () => {
  // Guarding the clock CALL was not enough: `readClock() - startedStep` is its own
  // operation, and it throws for a Symbol ("Cannot convert a Symbol value to a number") and
  // for a null-prototype object. This is the third time in this issue a guarded read was
  // undone by an unguarded use of the same value, after `${responseStatus}` and
  // `String(err)` — so the reading is normalised at the source instead.
  for (const now of [() => Symbol("t"), () => Object.create(null), () => 1n, () => "later", () => ({}), () => null]) {
    const result = await fetchWholeObjectInfo({
      getNodeDefs: async () => null,
      fetchApi: async () => ({ ok: true, json: async () => DEFS_1161 }),
      now,
    });
    assert.deepEqual(result.defs, DEFS_1161, `now returning ${String(typeof now())} must not cost the answer`);
  }
});

test("#1161: the DEFAULT clock is the monotonic one — the property everything rests on", () => {
  // Nothing pinned this: swapping the default to Date.now left the whole suite green, while
  // being the single choice the current design depends on. Every scenario that broke the
  // three earlier clock-based designs — an NTP step, a DST or manual change, a VM
  // suspend/resume, a frozen reading — is a WALL-CLOCK hazard specifically.
  //
  // A source guard, in the idiom this suite already uses for the #982 refusal wording,
  // because the choice is a default the tests otherwise always override.
  const src = readFileSync(new URL("../../web/js/lib/object-info-oracle.js", import.meta.url), "utf8");
  // Pin the ARM, not merely the appearance of the identifier. "performance.now" also occurs
  // in the rationale comment and in the capability check just above the selection, so the
  // first version of this guard — a bare match on that identifier — stayed true for the
  // exact mutation its own comment names, and was vacuous.
  assert.match(src, /\?\s*\(\)\s*=>\s*performance\.now\(\)/, "the default arm must BE the monotonic clock");
  // Strip comments before counting Date.now uses: the first filter only skipped lines
  // STARTING with a marker, so a trailing same-line comment counted as a use.
  //
  // SPLIT ON /\r?\n/. This file is CRLF, so a line ends "…\r" — and `//.*$` never matches
  // there, because `.` excludes the carriage return and `$` sits after it. The strip
  // silently did nothing and the assertion failed on unmutated source.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ""));
  const dateNowUses = code.filter((l) => /Date\.now\(\)/.test(l));
  assert.equal(dateNowUses.length, 1, `Date.now may appear only as the last-resort fallback, found: ${dateNowUses.join(" | ")}`);
  assert.match(dateNowUses[0], /=>\s*Date\.now\(\)/, "and only as the fallback arm of the clock selection");
});

test("#1161: an unreadable elapsed reading charges the FULL grant, never zero", () => {
  // The documented conservative direction. Flipping this arm to charge 0 left the suite
  // green, so a clock that cannot be read would have silently handed every later step a
  // fresh budget — the refund defect that produced the ~50s overruns.
  const src = readFileSync(new URL("../../web/js/lib/object-info-oracle.js", import.meta.url), "utf8");
  assert.match(
    src,
    /Number\.isFinite\(spent\) && spent >= 0 \? Math\.min\(spent, grant\) : grant/,
    "unmeasurable elapsed must fall back to the whole grant, not to nothing",
  );
});

test("#1161: a budget beyond the timer's range takes the default, and does not park", async () => {
  // setTimeout coerces a delay above 2^31-1 to 1ms, so an over-range budget hands every step
  // a grant whose timer fires immediately — the bound silently becoming no bound.
  //
  // CLAMPING to 2^31-1 was the first fix and was worse: it turns the nonsense input into a
  // ~24.8-day grant, so a hung client route PARKS instead of failing fast. Measured on real
  // timers at deadlineMs 5e9, the clamped version never returned at all with fetchApi call
  // count 0 — the canonical #1161 signature, reintroduced by a guard written to prevent it.
  // Both halves are pinned here so neither fix can be undone in favour of the other.
  for (const deadlineMs of [2 ** 31, 5e9, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
    const granted = [];
    let calls = 0;
    const result = await fetchWholeObjectInfo({
      getNodeDefs: async () => null,
      fetchApi: async () => { calls += 1; return { ok: true, json: async () => DEFS_1161 }; },
      deadlineMs,
      timers: { setTimer: (fn, ms) => { granted.push(ms); return { fn, ms }; }, clearTimer: () => {} },
    });
    assert.equal(calls, 1, `deadlineMs=${deadlineMs}: the fallback is still issued`);
    assert.deepEqual(result.defs, DEFS_1161);
    assert.equal(
      granted[0],
      OBJECT_INFO_DEADLINE_MS / 2,
      `deadlineMs=${deadlineMs}: an unusable budget must take the DEFAULT, not a multi-day clamp`,
    );
  }
  // A hung route on an over-range budget must fail fast rather than park for days.
  {
    let calls = 0;
    const refused = await fetchWholeObjectInfo({
      getNodeDefs: () => new Promise(() => {}),
      fetchApi: async () => { calls += 1; return { ok: true, json: async () => DEFS_1161 }; },
      deadlineMs: 5e9,
      timers: { setTimer: (fn) => { fn(); return {}; }, clearTimer: () => {} },
    });
    // Timers fire immediately here, so every step times out by construction — the point is
    // not that it answers, but that it REACHES the fallback and reports, rather than sitting
    // on a multi-day grant with the raw route never contacted.
    assert.equal(calls, 1, "the fallback is reached instead of the call parking");
    assert.equal(refused.defs, null, "with every timer firing at once nothing can answer");
    assert.match(
      refused.failures.join(" | "),
      new RegExp(`share of the ${OBJECT_INFO_DEADLINE_MS}ms budget`),
      "and the refusal quotes the budget actually in force, not a nine-digit one",
    );
  }
  // A budget AT the ceiling is expressible, so it is honoured rather than overridden.
  {
    const granted = [];
    await fetchWholeObjectInfo({
      getNodeDefs: async () => null,
      fetchApi: async () => ({ ok: true, json: async () => DEFS_1161 }),
      deadlineMs: 2 ** 31 - 1,
      timers: { setTimer: (fn, ms) => { granted.push(ms); return { fn, ms }; }, clearTimer: () => {} },
    });
    assert.equal(granted[0], Math.floor((2 ** 31 - 1) / 2), "an expressible budget is the caller's to choose");
  }
});

test("#1161: a hung step really is charged, so it cannot leave the next one the whole budget", async () => {
  // Deleting the timeout charge entirely left the whole suite green — including the test
  // rewritten specifically to see that overrun. The observable consequence is simple: if a
  // hung client route costs nothing, the fallback draws the FULL budget rather than what is
  // left, and the total is no longer bounded by anything.
  const granted = [];
  const armed = [];
  const out = fetchWholeObjectInfo({
    getNodeDefs: never,
    fetchApi: async () => ({ ok: true, json: async () => DEFS_1161 }),
    deadlineMs: 20000,
    timers: {
      setTimer: (fn, ms) => { granted.push(ms); const t = { fn, ms }; armed.push(t); return t; },
      clearTimer: (t) => { const i = armed.indexOf(t); if (i >= 0) armed.splice(i, 1); },
    },
    now: () => 0, // a clock that reveals nothing: only the timeout charge can bound this
  });
  await tick();
  armed.shift().fn();
  await settled(out, "the oracle call");
  assert.equal(granted[0], 10000, "the client route's share");
  assert.ok(
    granted[1] <= 10000,
    `the fallback was granted ${granted[1]}ms — a hung step that costs nothing leaves the budget unspent`,
  );
});

test("#1161: BOTH fallback shares are pinned, not just the body's", async () => {
  // BODY_SHARE was re-pinned after it survived a mutation; FALLBACK_RESPONSE_SHARE was left
  // free, and 0.5 -> 0.9 survived the suite. Pin the response's share the same way, on the
  // path where the client route has already spent its half so the arithmetic is unambiguous.
  const granted = [];
  const armed = [];
  const out = fetchWholeObjectInfo({
    getNodeDefs: never,
    fetchApi: async () => ({ ok: true, json: async () => DEFS_1161 }),
    deadlineMs: 20000,
    timers: {
      setTimer: (fn, ms) => { granted.push(ms); const t = { fn, ms }; armed.push(t); return t; },
      clearTimer: (t) => { const i = armed.indexOf(t); if (i >= 0) armed.splice(i, 1); },
    },
    now: () => 0,
  });
  await tick();
  armed.shift().fn(); // the client route burns its 10s
  await settled(out, "the oracle call");
  assert.equal(granted[1], 5000, "the response takes half of what the client route left, not more");
});

test("#1161: a Number-coercible clock keeps the reclaim, it does not silently disable it", async () => {
  // Demanding `typeof === "number"` rejected every clock the subtraction itself would have
  // accepted — a Date, or a numeric string — so those charged the full grant and the
  // reclaim vanished, restoring the 10000/5000/5000 shape that round 8 proved refuses
  // payloads main serves. The guard must coerce exactly as the arithmetic would.
  for (const make of [
    () => { let t = 0; return () => new Date((t += 100)); },
    () => { let t = 0; return () => String((t += 100)); },
    () => { let t = 0; return () => (t += 100); },
  ]) {
    const granted = [];
    await fetchWholeObjectInfo({
      getNodeDefs: async () => null,
      fetchApi: async () => ({ ok: true, json: async () => DEFS_1161 }),
      deadlineMs: 20000,
      now: make(),
      timers: { setTimer: (fn, ms) => { granted.push(ms); return { fn, ms }; }, clearTimer: () => {} },
    });
    assert.ok(granted[2] > 15000, `the body kept ${granted[2]}ms — the reclaim must survive this clock`);
  }
});
