import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isVueNodesEnabled,
  vueNodesActive,
  computeFitTransform,
  cssViewport,
  scopeChanged,
} from "../../web/js/lib/screenshot-capture.js";

// ---- isVueNodesEnabled (#335/#329/#189 renderer detection) -----------------

test("isVueNodesEnabled: true only when the setting is strictly true", () => {
  assert.equal(isVueNodesEnabled((id) => (id === "Comfy.VueNodes.Enabled" ? true : undefined)), true);
  assert.equal(isVueNodesEnabled(() => false), false);
  assert.equal(isVueNodesEnabled(() => undefined), false);
  // non-boolean truthy must not count (avoids false positives)
  assert.equal(isVueNodesEnabled(() => "true"), false);
  assert.equal(isVueNodesEnabled(() => 1), false);
});

test("isVueNodesEnabled: swallows a throwing/missing getter", () => {
  assert.equal(isVueNodesEnabled(undefined), false);
  assert.equal(isVueNodesEnabled(() => { throw new Error("no store"); }), false);
});

// ---- vueNodesActive (live-flag preference; #335 async-setter finding) -------

test("vueNodesActive: prefers the live LiteGraph.vueNodesMode flag over the setting", () => {
  // Live flag wins even when it disagrees with the persisted setting — this is
  // the flag the synchronous draw path reads and the one we save/restore.
  assert.equal(vueNodesActive(() => true, { vueNodesMode: false }), false);
  assert.equal(vueNodesActive(() => false, { vueNodesMode: true }), true);
});

test("vueNodesActive: falls back to the setting when no LiteGraph flag is present", () => {
  assert.equal(vueNodesActive(() => true, null), true);
  assert.equal(vueNodesActive(() => false, {}), false); // flag absent -> setting
  assert.equal(vueNodesActive(() => true, undefined), true);
});

// ---- computeFitTransform (#335 CSS-vs-device-pixel framing) -----------------

test("computeFitTransform: CSS-pixel viewport frames the whole graph (round-trip)", () => {
  // A 1000x600 graph at origin, 60px pad, in an 800x600 CSS viewport.
  const boundsX = 0, boundsY = 0, boundsW = 1000, boundsH = 600;
  const viewCssW = 800, viewCssH = 600, pad = 60;
  const { scale, offsetX, offsetY } = computeFitTransform({
    boundsX, boundsY, boundsW, boundsH, viewCssW, viewCssH, pad,
  });
  // world -> screen: s = (world + offset) * scale
  const leftPad = boundsX;
  const screenLeft = (leftPad + offsetX) * scale;
  const screenRight = (boundsX + boundsW + offsetX) * scale;
  // padded content fits inside the viewport with >= pad*scale margin on the tight axis
  assert.ok(screenLeft >= 0 - 1e-6, `left in view: ${screenLeft}`);
  assert.ok(screenRight <= viewCssW + 1e-6, `right in view: ${screenRight}`);
  const screenBottom = (boundsY + boundsH + offsetY) * scale;
  assert.ok(screenBottom <= viewCssH + 1e-6, `bottom in view: ${screenBottom}`);
});

test("computeFitTransform: passing device pixels (DPR) would over-zoom vs CSS pixels", () => {
  // The bug: fit computed against the backing store (CSS * dpr) yields a scale
  // dpr-times too large. This test pins that the CSS-pixel path is dpr-invariant.
  const base = { boundsX: 0, boundsY: 0, boundsW: 1000, boundsH: 600, pad: 60 };
  const cssFit = computeFitTransform({ ...base, viewCssW: 800, viewCssH: 600 });
  const deviceFit = computeFitTransform({ ...base, viewCssW: 1600, viewCssH: 1200 }); // dpr=2 backing store
  // The old code used backing-store dims -> ~2x the correct scale.
  assert.ok(deviceFit.scale > cssFit.scale * 1.9, "device-px scale is ~dpr larger");
  assert.ok(Math.abs(deviceFit.scale - cssFit.scale * 2) < 1e-6, "exactly dpr larger");
});

test("computeFitTransform: clamps to maxScale for tiny graphs", () => {
  const { scale } = computeFitTransform({
    boundsX: 0, boundsY: 0, boundsW: 50, boundsH: 50, viewCssW: 800, viewCssH: 600, pad: 60, maxScale: 1.5,
  });
  assert.equal(scale, 1.5);
});

// ---- cssViewport ------------------------------------------------------------

test("cssViewport: prefers clientWidth/clientHeight (true CSS px)", () => {
  const cv = { clientWidth: 800, clientHeight: 600, width: 1600, height: 1200 };
  assert.deepEqual(cssViewport(cv, 2), { viewCssW: 800, viewCssH: 600 });
});

test("cssViewport: falls back to backing store / dpr when client dims are 0", () => {
  const cv = { clientWidth: 0, clientHeight: 0, width: 1600, height: 1200 };
  assert.deepEqual(cssViewport(cv, 2), { viewCssW: 800, viewCssH: 600 });
});

// ---- scopeChanged (#237) ----------------------------------------------------

test("scopeChanged: detects a switched graph reference", () => {
  const root = { name: "root" }, sub = { name: "sub" };
  assert.equal(scopeChanged(root, sub), true);
  assert.equal(scopeChanged(root, root), false);
});

test("scopeChanged: false when either side is missing (nothing to restore)", () => {
  const g = {};
  assert.equal(scopeChanged(null, g), false);
  assert.equal(scopeChanged(g, null), false);
  assert.equal(scopeChanged(null, null), false);
});
