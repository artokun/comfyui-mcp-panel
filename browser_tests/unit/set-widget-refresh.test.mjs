/**
 * Unit tests for the STALE-COMBO refresh-before-validate recovery in
 * web/js/lib/set-widget.js — run with `node --test`.
 *
 * These drive runSetWidget(), the SAME async unit graph_set_widget delegates to,
 * so the production path is exercised (not a parallel reimplementation). The
 * `refreshCombos` callback stands in for the live frontend refresh
 * (refreshComfyNodeDefs → object_info re-register + refreshComboInNodes), which
 * mutates the widget's option list IN PLACE.
 *
 * Cluster fixed: #338 (downloaded model), #317 / #284 (staged output), #288
 * (uploaded image into an EMPTY LoadImage combo), #299 (ControlNet loader), #304.
 *
 * Invariants under test:
 *   1. A value ABSENT from the stale combo but PRESENT after an authoritative
 *      refresh is accepted on a single revalidation (was rejected before).
 *   2. A genuinely-invalid value (still absent AFTER refresh) is STILL rejected —
 *      #240 strictness is preserved; refresh cannot make a bad value sneak in.
 *   3. Only COMBO rejections trigger the refresh; a numeric type mismatch fails
 *      closed immediately without any refresh attempt.
 *   4. refresh is attempted AT MOST ONCE.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";

// A registry whose entries have no `nodeData` so the placeholder cross-check in
// assertResolvedTargetRegistered is skipped (registeredDef undefined) while the
// type still resolves as registered.
const REGISTRY = { LoadImage: {}, ControlNetLoader: {}, KSampler: {} };

function makeNode(type, widget) {
  return { id: 105, type, widgets: [widget] };
}

test("stale combo: a just-staged value ABSENT at first is accepted after refresh (#317/#284/#338)", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png", "old_b.png"] }, value: "old_a.png" };
  const node = makeNode("LoadImage", widget);
  let refreshCalls = 0;
  const refreshCombos = async () => {
    refreshCalls += 1;
    // Authoritative source now lists the newly-staged file — mutate in place.
    widget.options.values = ["old_a.png", "old_b.png", "ICEDTEA_scene_bg_inpaint_01.png"];
  };

  const res = await runSetWidget(node, "image", "ICEDTEA_scene_bg_inpaint_01.png", {
    registry: REGISTRY,
    refreshCombos,
  });

  assert.equal(res.set.value, "ICEDTEA_scene_bg_inpaint_01.png");
  assert.equal(res.refreshed, true);
  assert.equal(widget.value, "ICEDTEA_scene_bg_inpaint_01.png");
  assert.equal(refreshCalls, 1, "refresh must be attempted exactly once");
});

test("EMPTY LoadImage combo (0 options) accepts the uploaded file after refresh (#288)", async () => {
  const widget = { name: "image", type: "combo", options: { values: [] }, value: "" };
  const node = makeNode("LoadImage", widget);
  const refreshCombos = async () => {
    widget.options.values = ["wan_reference_woman.png"];
  };

  const res = await runSetWidget(node, "image", "wan_reference_woman.png", {
    registry: REGISTRY,
    refreshCombos,
  });
  assert.equal(res.set.value, "wan_reference_woman.png");
});

test("ControlNetLoader stale 3-item list accepts the 4th model after refresh (#299)", async () => {
  const widget = {
    name: "control_net_name",
    type: "combo",
    options: { values: ["a.safetensors", "b.safetensors", "c.safetensors"] },
    value: "a.safetensors",
  };
  const node = { id: 18, type: "ControlNetLoader", widgets: [widget] };
  const refreshCombos = async () => {
    widget.options.values.push("mistoLine_rank256.safetensors");
  };
  const res = await runSetWidget(node, "control_net_name", "mistoLine_rank256.safetensors", {
    registry: REGISTRY,
    refreshCombos,
  });
  assert.equal(res.set.value, "mistoLine_rank256.safetensors");
});

test("GENUINELY-invalid value is STILL rejected after refresh (keeps #240 strictness)", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = makeNode("LoadImage", widget);
  let refreshCalls = 0;
  const refreshCombos = async () => {
    refreshCalls += 1;
    // Refresh adds OTHER files but NOT the requested one — a real typo/bad value.
    widget.options.values = ["old_a.png", "some_other.png"];
  };

  await assert.rejects(
    () =>
      runSetWidget(node, "image", "does_not_exist_anywhere.png", {
        registry: REGISTRY,
        refreshCombos,
      }),
    (err) =>
      err instanceof Error &&
      /refused/.test(err.message) &&
      /after refreshing combo options/.test(err.message) &&
      /not a valid option/.test(err.message),
  );
  assert.equal(widget.value, "old_a.png", "must not mutate on a genuinely-invalid value");
  assert.equal(refreshCalls, 1, "refresh attempted exactly once, then fails closed");
});

test("without a refreshCombos injection, a stale-combo miss fails closed (no silent accept)", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = makeNode("LoadImage", widget);
  await assert.rejects(
    () => runSetWidget(node, "image", "new.png", { registry: REGISTRY }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
});

test("a NON-combo failure (numeric type mismatch) never triggers a refresh", async () => {
  const widget = { name: "steps", type: "INT", value: 20 };
  const node = { id: 3, type: "KSampler", widgets: [widget] };
  let refreshCalls = 0;
  const refreshCombos = async () => {
    refreshCalls += 1;
  };
  await assert.rejects(
    () => runSetWidget(node, "steps", "euler", { registry: REGISTRY, refreshCombos }),
    (err) => err instanceof Error && /not a number/.test(err.message),
  );
  assert.equal(refreshCalls, 0, "numeric mismatch must fail closed without refreshing");
});

test("a valid value on the FIRST try does not call refresh at all", async () => {
  const widget = { name: "image", type: "combo", options: { values: ["a.png", "b.png"] }, value: "a.png" };
  const node = makeNode("LoadImage", widget);
  let refreshCalls = 0;
  const res = await runSetWidget(node, "image", "b.png", {
    registry: REGISTRY,
    refreshCombos: async () => {
      refreshCalls += 1;
    },
  });
  assert.equal(res.set.value, "b.png");
  assert.equal(res.refreshed, undefined);
  assert.equal(refreshCalls, 0);
});
