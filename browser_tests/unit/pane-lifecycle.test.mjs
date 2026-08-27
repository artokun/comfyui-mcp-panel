// #1961 — dock/undock remaining after #1952's close/dismiss.
//
// Close sheds the shell. The agent still could not undock a pane that
// open_civitai docks by default. These tests drive the shipped setDocked path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { setSidePanelDocked } from "../../web/js/lib/pane-lifecycle.js";

const panelSrc = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const sideSrc = readFileSync(new URL("../../web/js/cmcp-sidepanel-ui.js", import.meta.url), "utf8");

function fakeHandle({ open = true, tab = "civitai", docked = true } = {}) {
  let isOpen = open;
  let isDocked = docked;
  const calls = [];
  return {
    calls,
    isOpen: () => isOpen,
    activeTab: () => tab,
    isDocked: () => isDocked,
    setDocked(want) {
      calls.push(want);
      const changed = isDocked !== want;
      isDocked = want;
      return { ok: true, open: isOpen, changed, docked: isDocked, centered: !isDocked, tab };
    },
    close() { isOpen = false; },
  };
}

test("#1961 setSidePanelDocked undocks an open docked pane", () => {
  const h = fakeHandle({ docked: true, tab: "civitai" });
  const r = setSidePanelDocked(h, false);
  assert.deepEqual(r, { ok: true, open: true, changed: true, docked: false, centered: true, tab: "civitai" });
  assert.deepEqual(h.calls, [false]);
  assert.equal(h.isDocked(), false);
});

test("#1961 setSidePanelDocked re-docks an undocked pane", () => {
  const h = fakeHandle({ docked: false, tab: "training" });
  const r = setSidePanelDocked(h, true);
  assert.equal(r.docked, true);
  assert.equal(r.changed, true);
  assert.equal(r.tab, "training");
  assert.deepEqual(h.calls, [true]);
});

test("#1961 setSidePanelDocked is idempotent on an already-docked pane", () => {
  const h = fakeHandle({ docked: true });
  h.setDocked = (want) => {
    h.calls.push(want);
    return { ok: true, open: true, changed: false, docked: true, centered: false, tab: "civitai" };
  };
  const r = setSidePanelDocked(h, true);
  assert.equal(r.changed, false);
  assert.equal(r.docked, true);
});

test("#1961 a missing or closed handle is success, not an error", () => {
  assert.deepEqual(setSidePanelDocked(null, false), {
    ok: true, open: false, changed: false, docked: false, tab: null,
  });
  assert.deepEqual(setSidePanelDocked({}, true), {
    ok: true, open: false, changed: false, docked: false, tab: null,
  });
  const closed = fakeHandle({ open: false });
  assert.deepEqual(setSidePanelDocked(closed, false), {
    ok: true, open: false, changed: false, docked: false, tab: null,
  });
  assert.deepEqual(closed.calls, [], "closed handle must not enter setDocked");
});

test("#1961 omitting docked is a caller error, not a silent no-op", () => {
  assert.throws(() => setSidePanelDocked(fakeHandle(), undefined), /docked: true or false/);
  assert.throws(() => setSidePanelDocked(fakeHandle(), "yes"), /docked: true or false/);
});

test("#1961 the panel imports and dispatches civitai_set_dock / training_set_dock on the shell, not the active tab", () => {
  assert.match(
    panelSrc,
    /import \{\s*setSidePanelDocked,\s*\} from "\.\/lib\/pane-lifecycle\.js"/,
  );
  assert.match(panelSrc, /msg\.cmd === "civitai_set_dock"/);
  assert.match(panelSrc, /msg\.cmd === "training_set_dock"/);
  assert.match(panelSrc, /if \(msg\.cmd === "civitai_set_dock"\)/);
  assert.match(panelSrc, /if \(msg\.cmd === "training_set_dock"\)/);
  assert.match(panelSrc, /return setSidePanelDocked\(_sidePanelHandle, msg\.docked\)/);
  assert.match(sideSrc, /setDocked,/);
  assert.match(sideSrc, /const setDocked = \(docked\) => \{/);
  // Same reason close is not gated: the dock mode is the SHELL's, and training
  // content stays resident while CivitAI is the active tab.
  const facade = sideSrc.slice(sideSrc.indexOf("const setDocked"), sideSrc.indexOf("const civitai"));
  assert.doesNotMatch(facade, /_driveOf/);
});
