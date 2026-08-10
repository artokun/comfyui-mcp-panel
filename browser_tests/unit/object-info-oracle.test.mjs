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

import { fetchWholeObjectInfo, objectInfoOracleFailureNote } from "../../web/js/lib/object-info-oracle.js";

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
  assert.match(panel, /describeObjectInfoFailure: \(\) => objectInfoOracleFailureNote/, "and can report what failed");
  // The burst cache still wraps it: two transports must not become two fetches per write.
  assert.match(panel, /await objectInfoCache\.read\(async \(\) => \{/, "still read through the #716 cache");
});

test("#982 (codex) the fallback is consulted ONLY when the client returned nothing usable", () => {
  // If `api.getNodeDefs()` ever narrows the schema, the raw route would be the broader
  // answer — so the fallback must never be able to override an answer the client gave.
  const src = readFileSync(new URL("../../web/js/lib/object-info-oracle.js", import.meta.url), "utf8");
  const clientBlock = src.slice(src.indexOf("if (typeof getNodeDefs === \"function\")"), src.indexOf("// SECOND TRANSPORT"));
  assert.match(
    clientBlock,
    /if \(usableDefs\(defs\)\) return \{ \[CACHE_OUTCOME\]: true, defs, failures \};/,
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
