// panel#779 — the panel rendered BLANK on ComfyUI frontend 1.50.x, and it was ours.
//
// `installSidebarTabGuard` removes our root when another sidebar tab is active.
// It identified the active tab from the selected button's CSS classes. ComfyUI
// 1.50 moved the id into an attribute — diffed from the shipped bundles:
//
//     1.47.12   class: I(e.id + `-tab-button`)
//     1.50.3    "data-testid": `${e.id}-tab-button`      (the class is gone)
//
// So the lookup found nothing, returned null, and the guard read that as "some
// OTHER tab is active" — removing `.cmcp-root` the instant render() attached it.
// The observer watches class changes on the toolbar, so selecting our tab was
// itself the trigger. A new user was blocked on first install with no error.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  readActiveSidebarTab,
  shouldDetachPanelRoot,
} from "../../web/js/lib/active-sidebar-tab.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const OURS = "comfyui-mcp.agent";

/** A rail button double. `attrs` is what getAttribute sees. */
function button({ classes = [], attrs = {} } = {}) {
  return {
    classList: classes,
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
  };
}

/** How 1.50.3 marks the selected button. */
const modern = (id) =>
  button({
    classes: ["side-bar-button", "side-bar-button-selected", "p-button"],
    attrs: { "data-testid": `${id}-tab-button` },
  });

/** How 1.47.12 marked it. */
const legacy = (id) =>
  button({ classes: ["side-bar-button", "side-bar-button-selected", `${id}-tab-button`] });

test("#779 the 1.50 shape (data-testid) is read", () => {
  assert.deepEqual(readActiveSidebarTab(modern(OURS)), { state: "id", id: OURS });
  assert.deepEqual(readActiveSidebarTab(modern("workflows")), { state: "id", id: "workflows" });
});

test("#779 the pre-1.50 shape (class) still works", () => {
  // Both generations must work — users are spread across them, and a fix that
  // traded one break for another would be no fix at all.
  assert.deepEqual(readActiveSidebarTab(legacy(OURS)), { state: "id", id: OURS });
  assert.deepEqual(readActiveSidebarTab(legacy("queue")), { state: "id", id: "queue" });
});

test("#779 an id containing a DOT survives — ours does", () => {
  // "comfyui-mcp.agent" is not a valid CSS class selector, which is why the guard
  // reads classList rather than querying. The dot must not be mangled either way.
  assert.equal(readActiveSidebarTab(modern(OURS)).id, "comfyui-mcp.agent");
  assert.equal(readActiveSidebarTab(legacy(OURS)).id, "comfyui-mcp.agent");
});

test("#779 no selection at all is NONE, not unknown", () => {
  // Genuinely nothing selected: our content should detach. That is an
  // observation, and it stays actionable.
  assert.deepEqual(readActiveSidebarTab(null), { state: "none" });
  assert.deepEqual(readActiveSidebarTab(undefined), { state: "none" });
  assert.equal(shouldDetachPanelRoot({ state: "none" }, OURS), true);
});

test("#779 a selected-but-UNIDENTIFIABLE button is UNKNOWN", () => {
  // This is the 1.50 case, and the whole bug. A button is selected and carries
  // no marker we recognise.
  const mystery = button({ classes: ["side-bar-button", "side-bar-button-selected"] });
  assert.deepEqual(readActiveSidebarTab(mystery), { state: "unknown" });
  // A future frontend that renames the suffix lands here too.
  const renamed = button({
    classes: ["side-bar-button-selected"],
    attrs: { "data-testid": "workflows-sidebar-item" },
  });
  assert.deepEqual(readActiveSidebarTab(renamed), { state: "unknown" });
});

test("#779 UNKNOWN never destroys — the fix that matters", () => {
  // "I cannot tell which tab is active" is not "it is not ours" (#796). Getting
  // this wrong is what turned a moved DOM marker into a blank panel for a new
  // user, with no error anywhere.
  assert.equal(shouldDetachPanelRoot({ state: "unknown" }, OURS), false);
});

test("#779 a provably different tab still detaches", () => {
  // The guard has a real job — a stray panel lingering over someone else's tab
  // is what it exists to prevent. Failing safe must not disable it.
  assert.equal(shouldDetachPanelRoot({ state: "id", id: "workflows" }, OURS), true);
  assert.equal(shouldDetachPanelRoot({ state: "id", id: OURS }, OURS), false);
});

test("#779 a bare suffix is not an id", () => {
  // "-tab-button" with nothing before it names no tab; treating "" as an id
  // would make it unequal to ours and detach.
  const bare = button({ classes: ["side-bar-button-selected", "-tab-button"] });
  assert.deepEqual(readActiveSidebarTab(bare), { state: "unknown" });
  const bareAttr = button({
    classes: ["side-bar-button-selected"],
    attrs: { "data-testid": "-tab-button" },
  });
  assert.deepEqual(readActiveSidebarTab(bareAttr), { state: "unknown" });
});

test("#779 data-testid WINS when both are present", () => {
  // A transitional build could carry both. The attribute is the current source
  // of truth, so it decides.
  const both = button({
    classes: ["side-bar-button-selected", "stale-id-tab-button"],
    attrs: { "data-testid": `${OURS}-tab-button` },
  });
  assert.deepEqual(readActiveSidebarTab(both), { state: "id", id: OURS });
});

test("#779 a button with no getAttribute does not throw", () => {
  // This runs inside a MutationObserver on ComfyUI's toolbar. A throw there is
  // silent and would leave the guard dead.
  const odd = { classList: ["side-bar-button-selected", `${OURS}-tab-button`] };
  assert.deepEqual(readActiveSidebarTab(odd), { state: "id", id: OURS });
  assert.deepEqual(readActiveSidebarTab({}), { state: "unknown" });
});

test("#779 WIRING: the guard uses the three-state read, not a class lookup", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(
    src,
    /import \{ readActiveSidebarTab, shouldDetachPanelRoot \} from "\.\/lib\/active-sidebar-tab\.js"/,
  );
  const i = src.indexOf("function installSidebarTabGuard(");
  assert.ok(i > 0, "the guard must be findable");
  const body = src.slice(i, src.indexOf("\n}", i));
  assert.match(body, /readActiveSidebarTab\(document\.querySelector\("\.side-bar-button-selected"\)\)/);
  assert.match(body, /if \(!shouldDetachPanelRoot\(active, tabId\)\) return;/);
  // The discredited lookup must be gone, not merely bypassed.
  assert.doesNotMatch(body, /classList\].*endsWith\("-tab-button"\)/);
  assert.doesNotMatch(body, /activeTabId\(\) === tabId/);
});
