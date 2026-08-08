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
  const body = src.slice(i, i + 2600);
  const guard = body.indexOf("isRegisteredNodeType(LG?.registered_node_types");
  const call = body.indexOf("fetchSingleNodeDef(class_type");
  assert.ok(guard > 0, "the registered-type gate must be present");
  assert.ok(call > guard, "…and the single-class fetch must sit INSIDE it");
  // The full fetch must still be there as the fallback, unchanged.
  assert.match(body, /api\?\.getNodeDefs === "function" \? await api\.getNodeDefs\(\) : null/);
  // And the snapshot must be taken on BOTH paths — #700 turns on it.
  assert.equal(
    (body.match(/snapshotBackendDef\(freshDefs, class_type\)/g) ?? []).length,
    2,
    "both the fast and full paths must snapshot the backend def before any refresh mutates it",
  );
});
