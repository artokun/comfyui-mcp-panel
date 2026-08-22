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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
  waitForReconnectHandshakeBeforeOpen,
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

test("panel ↔ node-def-refresh.js / canvas-navigation.js / reconnect-recovery.js edges link (#635/#619/#663/#646/#1641)", () => {
  assert.equal(typeof describeNodeDefRefresh, "function");
  assert.equal(typeof confirmCanvasNavigation, "function");
  assert.equal(typeof watchPostReconnectSettle, "function");
  assert.equal(typeof waitForReconnectHandshakeBeforeOpen, "function");
  assert.equal(typeof graphMutationReconnectGate, "function");
});

test("panel ↔ disconnect-verify.js module edge links (#668)", () => {
  assert.equal(typeof snapshotGraphState, "function");
  assert.equal(typeof describeInputLink, "function");
  assert.equal(typeof verifyDisconnect, "function");
});

/**
 * The half this file's header says --check DOES cover — except that it only covers it
 * when the file is checked AS A MODULE, and nothing in the repo was doing that.
 *
 * The panel is served to the browser as an ES module (`type="module"`). `node --check
 * web/js/comfyui-mcp-panel.js` parses a bare `.js` as CommonJS and reports OK on source
 * that no browser can load — which is exactly how an `import` statement inserted INSIDE
 * another import's specifier list shipped on this branch, taking the entire panel down
 * with `SyntaxError: Unexpected reserved word` at module scope. Nothing else caught it:
 * every unit test reads the source as TEXT or evals a slice of it, and Playwright cannot
 * run without a live ComfyUI.
 *
 * So: check it the way the browser reads it. The copy is what makes the check a MODULE
 * parse rather than a script parse; without the .mjs extension this test would pass over
 * the very defect it exists to catch.
 */
test("the panel bundle parses as an ES MODULE, which is how the browser loads it", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js");
  const asModule = join(mkdtempSync(join(tmpdir(), "cmcp-parse-")), "panel.mjs");
  writeFileSync(asModule, readFileSync(src));
  const res = spawnSync(process.execPath, ["--check", asModule], { encoding: "utf8" });
  rmSync(dirname(asModule), { recursive: true, force: true });
  assert.equal(res.status, 0, `panel is not a parseable ES module:\n${res.stderr}`);
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
