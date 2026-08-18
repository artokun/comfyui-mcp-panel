/**
 * Unit tests for #1269 — one panel bundle per page.
 *
 * Two installs of the pack (a git clone at custom_nodes/comfyui-mcp-panel AND a
 * Manager install at custom_nodes/comfyui-agent-panel) load two bundles into the
 * same page; both connect and hello under the same workflow tab ids, and the
 * stale copy's version-less, fence-less hello can own the connection the
 * orchestrator routes to — so a CURRENT install sees graph writes refused as
 * "this tab advertised NO panel version", and a hard refresh cannot help. These
 * lock the module-scope arbitration (newer copy wins, older stands down loudly)
 * and the setup()-time backstop for copies too old to carry the guard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  arbitratePanelCopy,
  countExtensionsNamed,
  describeDuplicatePanelCopies,
  describeUnguardedDuplicatePanelCopy,
  installDirFromBundleUrl,
  PANEL_EXTENSION_NAME,
} from "../../web/js/lib/duplicate-panel-guard.js";

test("arbitratePanelCopy: the only copy claims the page and stays active", () => {
  const registry = {};
  const a = arbitratePanelCopy({ registry, self: { version: "0.15.1", url: "/extensions/comfyui-mcp-panel/x.js" } });
  assert.equal(a.outcome, "sole");
  assert.equal(a.active(), true);
  assert.equal(a.prior, null);
});

test("arbitratePanelCopy: a NEWER later copy takes over and stands the older one down", () => {
  const registry = {};
  const older = arbitratePanelCopy({ registry, self: { version: "0.11.43", url: "/extensions/comfyui-agent-panel/x.js" } });
  assert.equal(older.outcome, "sole");
  const newer = arbitratePanelCopy({ registry, self: { version: "0.15.1", url: "/extensions/comfyui-mcp-panel/x.js" } });
  assert.equal(newer.outcome, "took-over");
  assert.equal(newer.active(), true);
  assert.deepEqual(newer.prior, { version: "0.11.43", url: "/extensions/comfyui-agent-panel/x.js" });
  // The older copy's flag moved AFTER its own arbitration — the setup()-time
  // re-check exists for exactly this ordering, and it names WHO took over.
  assert.equal(older.active(), false);
  assert.deepEqual(older.supersededBy(), { version: "0.15.1", url: "/extensions/comfyui-mcp-panel/x.js" });
  // The registry now names the newer copy, so a THIRD copy arbitrates against it.
  const third = arbitratePanelCopy({ registry, self: { version: "0.14.0", url: "/extensions/third/x.js" } });
  assert.equal(third.outcome, "stood-down");
});

test("arbitratePanelCopy: an older or equal later copy stands down; the first claim keeps the page", () => {
  const registry = {};
  const first = arbitratePanelCopy({ registry, self: { version: "0.15.1", url: "/extensions/comfyui-agent-panel/x.js" } });
  const older = arbitratePanelCopy({ registry, self: { version: "0.11.43", url: "/extensions/comfyui-mcp-panel/x.js" } });
  assert.equal(older.outcome, "stood-down");
  assert.equal(older.active(), false);
  assert.equal(first.active(), true);
  const equal = arbitratePanelCopy({ registry, self: { version: "0.15.1", url: "/extensions/elsewhere/x.js" } });
  assert.equal(equal.outcome, "stood-down");
  assert.equal(first.active(), true);
});

test("arbitratePanelCopy: a malformed prior claim is claimable, not a silencer", () => {
  const registry = { __comfyuiMcpPanelGuard: { noVersion: true } };
  const a = arbitratePanelCopy({ registry, self: { version: "0.15.1", url: "/extensions/comfyui-mcp-panel/x.js" } });
  assert.equal(a.outcome, "sole");
  assert.equal(a.active(), true);
});

test("arbitratePanelCopy: a throwing prior standDown does not keep the newer copy off the page", () => {
  const registry = {
    __comfyuiMcpPanelGuard: {
      version: "0.11.43",
      url: "/extensions/old/x.js",
      standDown: () => { throw new Error("broken"); },
    },
  };
  const newer = arbitratePanelCopy({ registry, self: { version: "0.15.1", url: "/extensions/comfyui-mcp-panel/x.js" } });
  assert.equal(newer.outcome, "took-over");
  assert.equal(newer.active(), true);
});

test("installDirFromBundleUrl: names the custom_nodes directory the bundle was served from", () => {
  assert.equal(
    installDirFromBundleUrl("http://127.0.0.1:8188/extensions/comfyui-agent-panel/comfyui-mcp-panel.js"),
    "comfyui-agent-panel",
  );
  assert.equal(installDirFromBundleUrl("/extensions/comfyui-mcp-panel/comfyui-mcp-panel.js"), "comfyui-mcp-panel");
  assert.equal(installDirFromBundleUrl("not-a-bundle-url"), null);
  assert.equal(installDirFromBundleUrl(undefined), null);
});

test("describeDuplicatePanelCopies: names BOTH install directories and the remedy", () => {
  const msg = describeDuplicatePanelCopies({
    outcome: "stood-down",
    self: { version: "0.11.43", url: "http://x/extensions/comfyui-mcp-panel/comfyui-mcp-panel.js" },
    prior: { version: "0.15.1", url: "http://x/extensions/comfyui-agent-panel/comfyui-mcp-panel.js" },
  });
  assert.match(msg, /comfyui-mcp-panel/);
  assert.match(msg, /comfyui-agent-panel/);
  assert.match(msg, /0\.11\.43/);
  assert.match(msg, /0\.15\.1/);
  assert.match(msg, /standing down/);
  assert.match(msg, /Remove one of the two panel installs/);
  const takeover = describeDuplicatePanelCopies({
    outcome: "took-over",
    self: { version: "0.15.1", url: "/extensions/comfyui-mcp-panel/x.js" },
    prior: { version: "0.11.43", url: "/extensions/comfyui-agent-panel/x.js" },
  });
  assert.match(takeover, /newer copy is taking over/);
});

test("describeUnguardedDuplicatePanelCopy: names the cause without claiming the other copy's version", () => {
  const msg = describeUnguardedDuplicatePanelCopy({
    self: { version: "0.15.1", url: "/extensions/comfyui-mcp-panel/x.js" },
  });
  assert.match(msg, /another copy of the panel pack is registered/);
  assert.match(msg, /comfyui-mcp-panel/);
  assert.match(msg, /0\.15\.1/);
  assert.match(msg, /remove it, and restart/);
});

test("countExtensionsNamed: our own registration is one; above one is a duplicate pack", () => {
  assert.equal(countExtensionsNamed(undefined, PANEL_EXTENSION_NAME), 0);
  assert.equal(countExtensionsNamed([], PANEL_EXTENSION_NAME), 0);
  assert.equal(countExtensionsNamed([{ name: PANEL_EXTENSION_NAME }], PANEL_EXTENSION_NAME), 1);
  assert.equal(
    countExtensionsNamed(
      [{ name: PANEL_EXTENSION_NAME }, { name: "other.ext" }, { name: PANEL_EXTENSION_NAME }, null],
      PANEL_EXTENSION_NAME,
    ),
    2,
  );
});

// The wiring is browser plumbing (module scope / registration / setup), so its
// safety INVARIANTS are pinned at source level, in the style of the #584
// healer pins in bundle-version.test.mjs:
//   - the arbitration runs at MODULE SCOPE (before any registration polling),
//     or two copies can both register before either arbitrates;
//   - registration honors the verdict BEFORE wrapping the app or registering;
//   - setup() re-checks (a later-evaluated newer copy can stand this one down
//     after it registered) and runs the guardless-duplicate backstop.
test("#1269 wiring invariants: module-scope arbitration, guarded registration, setup() re-check", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const arbitration = src.indexOf("const panelCopyArbitration = arbitratePanelCopy({");
  assert.notEqual(arbitration, -1, "the copy arbitration runs at module scope");
  const registration = src.indexOf("function registerExtensionWhenReady(");
  assert.ok(arbitration < registration, "the arbitration precedes registration polling");
  const guard = src.indexOf("if (!panelCopyArbitration.active()) return notePanelCopyStandDown();", registration);
  assert.ok(guard !== -1 && guard < src.indexOf("installCreateBoundaryFork(app);", registration),
    "a stood-down copy returns before wrapping the app or registering");
  const setupAt = src.indexOf("async setup() {");
  const setupRecheck = src.indexOf("if (panelCopyGuardBlocksSetup(app)) return;", setupAt);
  assert.ok(setupRecheck !== -1, "setup() re-checks the arbitration — it can move after registration");
  const helper = src.indexOf("function panelCopyGuardBlocksSetup(");
  const backstop = src.indexOf("countExtensionsNamed(comfyApp?.extensions, PANEL_EXTENSION_NAME)", helper);
  assert.ok(backstop !== -1, "the guardless-duplicate backstop lives in the setup() gate");
  assert.ok(
    backstop > src.indexOf("if (!panelCopyArbitration.active()) {", helper),
    "the backstop runs only for the copy that survived arbitration",
  );
});
