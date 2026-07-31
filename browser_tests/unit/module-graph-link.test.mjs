/**
 * MODULE-GRAPH LINK smoke test (P0 guard).
 *
 * `node --check <file>.mjs` validates SYNTAX only — it does NOT resolve cross-module
 * imports, so a panel `import { foo } from "./lib/x.js"` where `x.js` never exports
 * `foo` passes --check yet FAILS to link at load time, breaking the ENTIRE panel (no
 * write can run). This test mirrors the panel's actual NAMED imports from the lib
 * modules this fix touches: if any named export is missing/renamed, THIS test file
 * itself fails to link and `node --test` reports it — catching the break before load.
 *
 * The named imports below MUST stay in lockstep with comfyui-mcp-panel.js's imports
 * from these modules (and set-widget.js's imports from widget-write.js/node-resolve.js).
 */
import test from "node:test";
import assert from "node:assert/strict";

// --- Mirror comfyui-mcp-panel.js imports (the panel's own module edges) -------------
import {
  isStaleAssetCandidate,
  reapplyDefsToLiveNodes,
  refreshComboOptionsFromDefs,
} from "../../web/js/lib/asset-staleness.js";
import { assertAddNodeResolvableRefreshing } from "../../web/js/lib/node-resolve.js";
import { runSetWidget } from "../../web/js/lib/set-widget.js";

// --- Mirror set-widget.js imports (the fix's internal module edges) -----------------
import {
  applyWidgetWrite,
  WidgetWriteError,
  resolvePromotedInnerTarget,
  followPromotionToConcrete,
} from "../../web/js/lib/widget-write.js";
import {
  preflightSetWidgetTarget,
  assertResolvedTargetRegistered,
  assertTypeAgainstFreshBackend,
} from "../../web/js/lib/node-resolve.js";

test("panel ↔ asset-staleness.js module edge links (incl. refreshComboOptionsFromDefs — P0)", () => {
  assert.equal(typeof isStaleAssetCandidate, "function");
  assert.equal(typeof reapplyDefsToLiveNodes, "function");
  assert.equal(typeof refreshComboOptionsFromDefs, "function");
});

test("panel ↔ node-resolve.js / set-widget.js module edges link", () => {
  assert.equal(typeof assertAddNodeResolvableRefreshing, "function");
  assert.equal(typeof runSetWidget, "function");
});

test("set-widget.js ↔ widget-write.js / node-resolve.js module edges link", () => {
  assert.equal(typeof applyWidgetWrite, "function");
  assert.equal(typeof WidgetWriteError, "function");
  assert.equal(typeof resolvePromotedInnerTarget, "function");
  assert.equal(typeof followPromotionToConcrete, "function");
  assert.equal(typeof preflightSetWidgetTarget, "function");
  assert.equal(typeof assertResolvedTargetRegistered, "function");
  assert.equal(typeof assertTypeAgainstFreshBackend, "function");
});
