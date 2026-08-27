// #1961 / #1962 — live CivitAI pane read. The agent must observe the painted
// grid (the authenticated surface, including RED content the public API never
// serves), not a re-fetch of models. These tests drive the shipped helpers the
// bridge dispatches; a fake screenshot or an items[] payload is not a pass.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PANE_READ_SOURCE,
  readCivitaiGridCards,
  readPaneOverlayPresence,
  captureLivePanePreview,
  readLiveCivitaiPane,
  readCivitaiPaneHandle,
} from "../../web/js/lib/pane-read.js";

const panelSrc = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const civitaiSrc = readFileSync(new URL("../../web/js/cmcp-civitai-ui.js", import.meta.url), "utf8");
const sideSrc = readFileSync(new URL("../../web/js/cmcp-sidepanel-ui.js", import.meta.url), "utf8");

function card({
  id,
  kind = "media",
  foot = "",
  rating = "PG",
  badge = "",
  gated = false,
  highlighted = false,
  src = null,
  hidden = false,
  connected = true,
  imgComplete = true,
  imgSize = 64,
} = {}) {
  const classes = ["cmcp-cv-card"];
  if (gated) classes.push("cmcp-cv-gated");
  if (highlighted) classes.push("cmcp-agent-glow");
  const img = src && !gated
    ? {
      tagName: "IMG",
      src,
      complete: imgComplete,
      naturalWidth: imgComplete ? imgSize : 0,
      naturalHeight: imgComplete ? imgSize : 0,
      width: imgComplete ? imgSize : 0,
      height: imgComplete ? imgSize : 0,
    }
    : null;
  const children = {
    ".cmcp-cv-cardfoot": foot ? { textContent: foot } : null,
    ".cmcp-cv-rating": rating ? { textContent: rating } : null,
    ".cmcp-cv-badge": badge ? { textContent: badge } : null,
    img,
  };
  const el = {
    className: classes.join(" "),
    classList: { contains: (c) => classes.includes(c) },
    dataset: { id: String(id), kind },
    style: hidden ? { display: "none" } : {},
    isConnected: connected,
    querySelector(sel) { return children[sel] || null; },
  };
  return el;
}

function gridOf(cards, { connected = true } = {}) {
  return {
    isConnected: connected,
    style: {},
    querySelectorAll(sel) {
      if (sel !== ".cmcp-cv-card") return [];
      return cards;
    },
  };
}

test("#1961 readCivitaiGridCards reports painted cards, not an API payload", () => {
  const a = card({
    id: "2731187", kind: "model", foot: "Moody Krea 2 Mix\nSDXL · ⬇ 12",
    rating: "X", badge: "Checkpoint", src: "/comfyui_mcp_panel/civitai/media?id=2731187",
  });
  const b = card({
    id: "9", kind: "media", foot: "@alice  ♥ 4", rating: "XXX", gated: true,
  });
  const rows = readCivitaiGridCards(gridOf([a, b]));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "2731187");
  assert.equal(rows[0].kind, "model");
  assert.equal(rows[0].gated, false);
  assert.equal(rows[0].src, "/comfyui_mcp_panel/civitai/media?id=2731187");
  assert.match(rows[0].foot, /Moody Krea 2 Mix/);
  assert.equal(rows[1].gated, true);
  assert.equal(rows[1].src, null, "gated cards withhold the sample URL the grid itself withholds");
  assert.equal(rows[1].rating, "XXX");
});

test("#1961 hidden or detached cards are not the user's view", () => {
  const hidden = card({ id: "1", src: "/t/1", hidden: true });
  const detached = card({ id: "2", src: "/t/2", connected: false });
  const shown = card({ id: "3", src: "/t/3", foot: "@shown" });
  assert.deepEqual(readCivitaiGridCards(gridOf([hidden, detached, shown])).map((r) => r.id), ["3"]);
  assert.deepEqual(readCivitaiGridCards(gridOf([shown], { connected: false })), []);
  assert.deepEqual(readCivitaiGridCards(null), []);
});

test("#1962 an items[] / API payload cannot populate visible — only the painted grid can", () => {
  const apiItems = [
    { id: 111, name: "from the public API", coverUrl: "https://civitai.com/x" },
  ];
  const out = readLiveCivitaiPane({
    open: true,
    showing: true,
    shellTab: "civitai",
    grid: gridOf([]),
    state: { tab: "models", query: "moody", items: apiItems, models: apiItems },
  });
  assert.equal(out.source, PANE_READ_SOURCE);
  assert.equal(out.count, 0);
  assert.deepEqual(out.visible, []);
  assert.equal(out.tab, "models");
  assert.equal(out.query, "moody");
});

test("#1961 a closed pane is an empty live read, not a throw and not leftover cards", () => {
  const leftover = card({ id: "keep", src: "/t/keep", connected: false });
  const out = readLiveCivitaiPane({
    open: false,
    showing: true,
    grid: gridOf([leftover], { connected: false }),
    state: { tab: "images", query: "stale", items: [{ id: "keep" }] },
  });
  assert.equal(out.open, false);
  assert.equal(out.showing, false);
  assert.equal(out.source, PANE_READ_SOURCE);
  assert.deepEqual(out.visible, []);
});

test("#1961 switching the shell away from CivitAI reports showing:false even if the grid still holds cards", () => {
  const painted = card({ id: "5", src: "/t/5", highlighted: true });
  const out = readLiveCivitaiPane({
    open: true,
    showing: false,
    shellTab: "training",
    docked: true,
    grid: gridOf([painted]),
    state: { tab: "images", query: "sdxl", signedIn: true },
  });
  assert.equal(out.open, true);
  assert.equal(out.showing, false);
  assert.equal(out.shell_tab, "training");
  assert.equal(out.docked, true);
  assert.equal(out.authenticated, true);
  assert.deepEqual(out.visible, []);
  assert.deepEqual(out.highlighted, []);
});

test("#1961 a showing pane returns live query box, glow, overlay presence, and no lightbox internals", () => {
  const glow = card({ id: "7", src: "/proxy/7", highlighted: true, foot: "@bob  ♥ 1" });
  const other = card({ id: "8", src: "/proxy/8", foot: "@cara  ♥ 2" });
  const overlay = {
    querySelector(sel) { return sel === ".cmcp-cv-lb" ? { isConnected: true, style: {} } : null; },
  };
  const out = readLiveCivitaiPane({
    open: true,
    showing: true,
    shellTab: "civitai",
    docked: true,
    grid: gridOf([glow, other]),
    searchEl: { value: "@alice sdxl" },
    overlay,
    state: {
      tab: "images",
      query: "sdxl",
      loading: false,
      done: true,
      signedIn: true,
      error: null,
      filters: { browsingLevels: [1, 16] },
    },
  });
  assert.equal(out.showing, true);
  assert.equal(out.query, "sdxl");
  assert.equal(out.query_box, "@alice sdxl");
  assert.deepEqual(out.browsingLevels, [1, 16]);
  assert.deepEqual(out.highlighted, ["7"]);
  assert.equal(out.visible.length, 2);
  assert.equal(out.overlay.lightbox, true);
  assert.equal(Object.keys(out.overlay).join(","), "lightbox", "lightbox internals are #1964 — presence only");
  assert.equal("title" in out.overlay, false);
  assert.equal("prompt" in out.overlay, false);
});

test("#1961 overlay presence is false when no lightbox node is painted", () => {
  assert.deepEqual(readPaneOverlayPresence(null), { lightbox: false });
  assert.deepEqual(readPaneOverlayPresence({ querySelector: () => null }), { lightbox: false });
  assert.deepEqual(
    readPaneOverlayPresence({ querySelector: () => ({ isConnected: false }) }),
    { lightbox: false },
  );
});

test("#1961 captureLivePanePreview draws live decoded thumbs and never gated / unloaded ones", () => {
  const draws = [];
  const live = card({ id: "1", src: "/proxy/1", imgComplete: true });
  const gated = card({ id: "2", gated: true, src: "/secret" });
  const loading = card({ id: "3", src: "/proxy/3", imgComplete: false, imgSize: 0 });
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        drawImage(img, x, y, w, h) { draws.push({ src: img.src, x, y, w, h }); },
      };
    },
    toDataURL() { return "data:image/png;base64,Qk0="; },
  };
  const visible = readCivitaiGridCards(gridOf([live, gated, loading]));
  const preview = captureLivePanePreview(visible, {
    createElement: () => canvas,
    cell: 96,
  });
  assert.equal(preview.captured, true);
  assert.equal(preview.source, PANE_READ_SOURCE);
  assert.deepEqual(draws.map((d) => d.src), ["/proxy/1"]);
  assert.equal(preview.cards, 1);
  assert.equal(preview.image, "Qk0=");
});

test("#1961 captureLivePanePreview withholds under blind and refuses to invent a blank dump", () => {
  const rows = readCivitaiGridCards(gridOf([card({ id: "1", src: "/t/1" })]));
  assert.deepEqual(
    captureLivePanePreview(rows, { blind: true }),
    { captured: false, withheld: true, reason: "blind" },
  );
  assert.equal(captureLivePanePreview([], {}).reason, "no-decoded-thumbs");
  assert.equal(captureLivePanePreview(rows, {}).reason, "no-canvas");
});

test("#1961 include_preview on a hidden pane is pane-not-showing, not a canvas dump", () => {
  const out = readLiveCivitaiPane({
    open: true,
    showing: false,
    shellTab: "training",
    includePreview: true,
    grid: gridOf([card({ id: "1", src: "/t/1" })]),
  });
  assert.deepEqual(out.preview, { captured: false, reason: "pane-not-showing" });
});

test("#1961 readCivitaiPaneHandle uses the handle's live read and treats a missing handle as closed", () => {
  const closed = readCivitaiPaneHandle(null);
  assert.equal(closed.open, false);
  assert.equal(closed.showing, false);
  assert.equal(closed.source, PANE_READ_SOURCE);
  assert.deepEqual(closed.visible, []);

  let called = 0;
  const handle = {
    readCivitai(opts) {
      called += 1;
      return readLiveCivitaiPane({
        open: true,
        showing: true,
        shellTab: "civitai",
        grid: gridOf([card({ id: "42", src: "/t/42", foot: "live" })]),
        ...opts,
      });
    },
  };
  const live = readCivitaiPaneHandle(handle, { limit: 10 });
  assert.equal(called, 1);
  assert.equal(live.visible[0].id, "42");
});

test("#1961 the panel imports and dispatches the shipped live-pane read, not a results refetch", () => {
  assert.match(
    panelSrc,
    /import \{\s*readCivitaiPaneHandle,\s*\} from "\.\/lib\/pane-read\.js"/,
  );
  assert.match(panelSrc, /msg\.cmd === "civitai_read"/);
  assert.match(panelSrc, /if \(msg\.cmd === "civitai_read"\) return readCivitaiPaneHandle\(_sidePanelHandle/);
  assert.match(panelSrc, /includePreview: msg\.include_preview === true/);
  assert.match(panelSrc, /blind: AGENT_BLIND/);
  assert.match(civitaiSrc, /read: driveRead/);
  assert.match(civitaiSrc, /readLiveCivitaiPane\(/);
  assert.match(sideSrc, /readCivitai,/);
  assert.match(sideSrc, /const readCivitai = \(opts = \{\}\) => \{/);
  // Must not go through _driveOf — a training-active shell still has a CivitAI
  // pane to observe (showing:false), the way close does not gate on the tab.
  const facade = sideSrc.slice(sideSrc.indexOf("const readCivitai"), sideSrc.indexOf("const civitai"));
  assert.doesNotMatch(facade, /_driveOf/);
});
