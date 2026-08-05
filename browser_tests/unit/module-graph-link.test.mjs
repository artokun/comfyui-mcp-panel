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
import {
  primeModuleCache,
  resolveBundleStaleness,
  collectRelativeImportSpecifiers,
} from "../../web/js/lib/bundle-version.js";
import { commandIsCanvasIndependent } from "../../web/js/lib/workflow-chat-identity.js";
import { sealProvenRootBinding } from "../../web/js/lib/graph-binding.js";
import { composeShowMediaReply } from "../../web/js/lib/media-preview.js";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";
import { describeNodeDefRefresh } from "../../web/js/lib/node-def-refresh.js";
import { confirmCanvasNavigation } from "../../web/js/lib/canvas-navigation.js";
import {
  watchPostReconnectSettle,
  graphMutationReconnectGate,
} from "../../web/js/lib/reconnect-recovery.js";
import {
  snapshotGraphState,
  describeInputLink,
  verifyDisconnect,
} from "../../web/js/lib/disconnect-verify.js";

// --- Mirror the shared bounded-step edge (#648) --------------------------------------
// run-completion-frame.js and media-preview.js BOTH import withTimeout from here. If
// that export is renamed or dropped, the completion frame and every video preview stop
// linking — and neither has a syntax error to catch it.
import { withTimeout } from "../../web/js/lib/bounded-step.js";

test("panel ↔ bundle-version.js module edge links (#584/#611)", () => {
  assert.equal(typeof resolveBundleStaleness, "function");
  assert.equal(typeof primeModuleCache, "function");
  assert.equal(typeof collectRelativeImportSpecifiers, "function");
});

test("panel ↔ workflow-chat-identity.js / graph-binding.js new edges link (#601/#602)", () => {
  assert.equal(typeof commandIsCanvasIndependent, "function");
  assert.equal(typeof sealProvenRootBinding, "function");
});

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

test("panel ↔ media-preview.js / run-completion-frame.js ↔ bounded-step.js edges link (#648)", () => {
  assert.equal(typeof composeShowMediaReply, "function");
  assert.equal(typeof composeRunCompletionFrame, "function");
  assert.equal(typeof withTimeout, "function");
});

test("panel ↔ node-def-refresh.js / canvas-navigation.js / reconnect-recovery.js edges link (#635/#619/#663/#646)", () => {
  assert.equal(typeof describeNodeDefRefresh, "function");
  assert.equal(typeof confirmCanvasNavigation, "function");
  assert.equal(typeof watchPostReconnectSettle, "function");
  assert.equal(typeof graphMutationReconnectGate, "function");
});

test("panel ↔ disconnect-verify.js module edge links (#668)", () => {
  assert.equal(typeof snapshotGraphState, "function");
  assert.equal(typeof describeInputLink, "function");
  assert.equal(typeof verifyDisconnect, "function");
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
