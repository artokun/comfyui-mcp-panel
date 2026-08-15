import { test } from "node:test";
import assert from "node:assert/strict";
import { probeConsoleRoute, UNBUILT_ROUTE_TITLE } from "../../web/js/lib/console-route-probe.js";

/**
 * #703 — the Prompts button opened a console page that was never built, showing
 * {"ok":false,"error":"not_found"} in a new tab.
 *
 * The asymmetry is the whole design: a 404 is EVIDENCE the route is missing;
 * everything else is not. So most of these tests assert that the button stays
 * ENABLED — removing a working button because a probe flaked is worse than the
 * 404 this fixes.
 */

test("a definitive 404 marks the route unavailable", () => {
  return probeConsoleRoute("http://c/prompts", { fetchImpl: async () => ({ status: 404 }) }).then(
    (r) => {
      assert.equal(r.available, false);
      assert.equal(r.reason, "not-found");
    },
  );
});

test("a served route is available", async () => {
  const r = await probeConsoleRoute("http://c/prompts", { fetchImpl: async () => ({ status: 200 }) });
  assert.equal(r.available, true);
});

test("a NETWORK failure leaves it available — a flaky probe must not remove a working button", async () => {
  // The load-bearing negative. If this ever flips to unavailable, a transient
  // console blip silently deletes a working feature from the UI.
  const r = await probeConsoleRoute("http://c/prompts", {
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(r.available, true);
  assert.equal(r.reason, "probe-failed");
});

test("a timeout leaves it available", async () => {
  const r = await probeConsoleRoute("http://c/prompts", {
    fetchImpl: (_u, opts) =>
      new Promise((_res, rej) => {
        opts?.signal?.addEventListener?.("abort", () => rej(new Error("aborted")));
      }),
    timeoutMs: 20,
  });
  assert.equal(r.available, true);
});

test("a response with no usable status leaves it available", async () => {
  for (const bad of [null, undefined, {}, { status: "404" }]) {
    const r = await probeConsoleRoute("http://c/prompts", { fetchImpl: async () => bad });
    assert.equal(r.available, true, `status ${JSON.stringify(bad)} is not evidence of absence`);
  }
});

test("other 4xx/5xx do NOT mark it unavailable — only 404 is evidence", async () => {
  for (const status of [401, 403, 500, 502, 503]) {
    const r = await probeConsoleRoute("http://c/prompts", { fetchImpl: async () => ({ status }) });
    assert.equal(r.available, true, `status ${status} must not disable the button`);
  }
});

test("a missing url or fetch resolves to available rather than throwing", async () => {
  assert.equal((await probeConsoleRoute("")).available, true);
  assert.equal((await probeConsoleRoute(null)).available, true);
  assert.equal((await probeConsoleRoute("http://c/x", { fetchImpl: null })).available, true);
});

test("the disabled tooltip blames the build, not the running server", () => {
  assert.match(UNBUILT_ROUTE_TITLE, /isn't available in this build/i);
  assert.ok(!/error|failed|broken/i.test(UNBUILT_ROUTE_TITLE), "must not imply a fault");
});
