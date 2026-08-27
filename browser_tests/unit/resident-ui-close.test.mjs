// #1952 / #1960 — agent path to shed resident renderer UI.
//
// The training wizard, CivitAI browser, live A2UI cards and painted media
// cards could only ACCUMULATE. The user-facing ✕ already called handle.close()
// / resolve(null); these tests drive the shipped functions the bridge now
// uses so a long session can actually drop that state.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  closeSidePanelHandle,
  dismissLiveA2uiCard,
  dismissAllLiveA2uiCards,
  unloadChatMediaCards,
} from "../../web/js/lib/resident-ui-close.js";

const panelSrc = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const sideSrc = readFileSync(new URL("../../web/js/cmcp-sidepanel-ui.js", import.meta.url), "utf8");
const trainSrc = readFileSync(new URL("../../web/js/cmcp-training-ui.js", import.meta.url), "utf8");
const civitaiSrc = readFileSync(new URL("../../web/js/cmcp-civitai-ui.js", import.meta.url), "utf8");

function fakeHandle({ tab = "training" } = {}) {
  let open = true;
  const teardowns = [];
  return {
    teardowns,
    close() {
      if (!open) return;
      open = false;
      for (const fn of teardowns) fn();
    },
    isOpen: () => open,
    activeTab: () => tab,
  };
}

// ── side panel ─────────────────────────────────────────────────────────────

test("#1952 closeSidePanelHandle closes an open handle and reports the active tab", () => {
  const h = fakeHandle({ tab: "training" });
  let torn = 0;
  h.teardowns.push(() => { torn += 1; });
  const r = closeSidePanelHandle(h);
  assert.deepEqual(r, { ok: true, closed: true, tab: "training" });
  assert.equal(h.isOpen(), false);
  assert.equal(torn, 1, "close must run the same teardown the user ✕ runs");
});

test("#1952 closeSidePanelHandle is idempotent — already-closed is success, not an error", () => {
  const h = fakeHandle({ tab: "civitai" });
  assert.equal(closeSidePanelHandle(h).closed, true);
  assert.deepEqual(closeSidePanelHandle(h), { ok: true, closed: false, tab: null });
  assert.deepEqual(closeSidePanelHandle(null), { ok: true, closed: false, tab: null });
  assert.deepEqual(closeSidePanelHandle({}), { ok: true, closed: false, tab: null });
});

test("#1952 closing the civitai-active panel still sheds training content sitting in the same shell", () => {
  // The unified shell keeps visited tabs in `contents` until close(). A close
  // gated on the active tab would leave the TRAINING pane resident — the
  // surface that was in the foreground at the #1960 kill.
  const h = fakeHandle({ tab: "civitai" });
  const shed = { training: false, civitai: false };
  h.teardowns.push(() => { shed.training = true; shed.civitai = true; });
  const r = closeSidePanelHandle(h);
  assert.equal(r.tab, "civitai");
  assert.equal(shed.training, true);
  assert.equal(shed.civitai, true);
});

// ── A2UI cards ─────────────────────────────────────────────────────────────

function fakeCard(id, { resolved = false } = {}) {
  let isResolved = resolved;
  const el = {
    removed: false,
    remove() { this.removed = true; },
  };
  const rec = { cardId: id, resolved, spec: { title: id } };
  const handle = {
    cardId: id,
    el,
    isResolved: () => isResolved,
    resolve(choice) {
      if (isResolved) return;
      isResolved = true;
      rec.choice = choice;
    },
  };
  return { handle, rec, el };
}

test("#1952 dismissLiveA2uiCard resolves, drops the registry entry, and detaches the node", () => {
  const live = new Map();
  const a = fakeCard("a2ui-1");
  live.set("a2ui-1", a);
  const r = dismissLiveA2uiCard(live, "a2ui-1");
  assert.equal(r.ok, true);
  assert.equal(r.dismissed, true);
  assert.equal(r.card_id, "a2ui-1");
  assert.equal(a.handle.isResolved(), true);
  assert.equal(a.rec.resolved, true);
  assert.equal(a.rec.choice, null, "dismiss is resolve(null) — no agent message");
  assert.equal(a.el.removed, true);
  assert.equal(live.has("a2ui-1"), false);
});

test("#1952 dismissLiveA2uiCard throws the same no-live-card error ui_update uses", () => {
  const live = new Map();
  assert.throws(
    () => dismissLiveA2uiCard(live, "gone"),
    /no live card "gone" \(already resolved, dismissed, or from a previous view\)/,
  );
  assert.throws(
    () => dismissLiveA2uiCard(live, ""),
    /no live card/,
  );
});

test("#1952 dismissAllLiveA2uiCards sheds every live card and does not throw on empty", () => {
  const live = new Map();
  const a = fakeCard("a");
  const b = fakeCard("b");
  live.set("a", a);
  live.set("b", b);
  const r = dismissAllLiveA2uiCards(live);
  assert.equal(r.dismissed, 2);
  assert.deepEqual(r.card_ids, ["a", "b"]);
  assert.equal(live.size, 0);
  assert.equal(a.el.removed && b.el.removed, true);
  const empty = dismissAllLiveA2uiCards(new Map());
  assert.deepEqual(empty, { ok: true, dismissed: 0, card_ids: [], recs: [] });
});

// ── media cards ────────────────────────────────────────────────────────────

test("#1952 unloadChatMediaCards clears src, revokes blob URLs, and detaches the card", () => {
  const revoked = [];
  const img = {
    tagName: "IMG",
    src: "blob:http://127.0.0.1/media",
    currentSrc: "blob:http://127.0.0.1/media",
    removeAttribute(k) { if (k === "src") this.src = ""; },
  };
  const card = {
    removed: false,
    querySelectorAll(sel) { return sel.includes("img") ? [img] : []; },
    remove() { this.removed = true; },
  };
  const log = { querySelectorAll(sel) { return sel === ".cmcp-imgcard" ? [card] : []; } };
  const r = unloadChatMediaCards(log, { revokeObjectURL: (u) => revoked.push(u) });
  assert.equal(r.unloaded, 1);
  assert.deepEqual(revoked, ["blob:http://127.0.0.1/media"]);
  assert.equal(img.src, "");
  assert.equal(card.removed, true);
});

test("#1952 unloadChatMediaCards is a no-op on a missing log", () => {
  assert.deepEqual(unloadChatMediaCards(null), { ok: true, unloaded: 0 });
});

// ── dispatcher wiring (the real bridge path, not a parallel copy) ──────────

test("#1952 the panel imports and dispatches the shipped close/dismiss functions", () => {
  assert.match(
    panelSrc,
    /import \{\s*closeSidePanelHandle,\s*dismissLiveA2uiCard,\s*dismissAllLiveA2uiCards,\s*unloadChatMediaCards,\s*\} from "\.\/lib\/resident-ui-close\.js"/,
  );
  assert.match(panelSrc, /msg\.cmd === "training_close"/);
  assert.match(panelSrc, /msg\.cmd === "civitai_close"/);
  assert.match(panelSrc, /msg\.cmd === "ui_dismiss"/);
  assert.match(panelSrc, /if \(msg\.cmd === "training_close"\) return closeSidePanelHandle\(_sidePanelHandle\)/);
  assert.match(panelSrc, /if \(msg\.cmd === "civitai_close"\) return closeSidePanelHandle\(_sidePanelHandle\)/);
  assert.match(panelSrc, /onUiDismiss\(msg\) \{/);
  assert.match(panelSrc, /dismissLiveA2uiCard\(liveA2uiCards, msg\.card_id/);
  assert.match(panelSrc, /dismissAllLiveA2uiCards\(liveA2uiCards/);
  assert.match(panelSrc, /unloadChatMediaCards\(log\)/);
});

test("#1952 close is on the training and civitai drive surfaces, and the shell facade does not gate it on the active tab", () => {
  assert.match(trainSrc, /close: driveClose/);
  assert.match(civitaiSrc, /close: driveClose/);
  assert.match(sideSrc, /close: closeResident/);
  assert.match(sideSrc, /const closeResident = \(\) => closeSidePanelHandle\(/);
  // _driveOf throws "training wizard not open" when another tab is active.
  // close must not go through it — training content stays resident until the
  // shell tears down, which is the #1960 case (training open, then another tab).
  const facadeClose = sideSrc.slice(sideSrc.indexOf("const closeResident"), sideSrc.indexOf("const civitai"));
  assert.doesNotMatch(facadeClose, /_driveOf/);
});
