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

test("#982 an EMPTY payload from the client is a failure, not an answer", async () => {
  // `{}` is an object, so a bare truthiness test would have accepted it and then reported
  // every type as removed — a fabricated verdict from an unusable payload.
  const { defs, failures } = await fetchWholeObjectInfo({
    getNodeDefs: async () => ({}),
    fetchApi: async () => okResponse(SCHEMA),
  });
  assert.deepEqual(defs, SCHEMA);
  assert.match(failures[0], /returned no usable schema \(an empty object\)/);
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
