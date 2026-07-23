// Unified side-panel shell (issue #124) — ONE tabbed overlay that hosts the four
// former sidebar modals (Civitai / Apps / Training / Local-RunPod) as tabs. It
// owns everything that used to be duplicated 4× — the overlay, header + tab bar,
// the single filter/search row, the top-right ✕, the agent-drive side-dock
// (applyDock / setCentered / _dockGeometry / watchDock), the slide-out exit, and
// Escape/backdrop close — and delegates the body of the active tab to a
// content-provider.
//
// Class vocabulary is Civitai's, VERBATIM (cmcp-cv-overlay / cmcp-modal /
// cmcp-cv-head / cmcp-cv-tabs·tab / cmcp-cv-subnav / cmcp-cv-search /
// cmcp-cv-iconbtn / cmcp-docked·dock-in) so the docked CSS + the agent-drive
// Playwright spec keep working unchanged. The active tab also carries a legacy
// ALIAS class (cmcp-civitai-modal / cmcp-tr-modal / cmcp-apps-modal) so the
// existing per-surface specs and -cv-*/-tr-*/-apps-* body CSS still resolve.
//
// A content-provider is `{ key, label, icon, hasSearch, searchPlaceholder,
// mount(bodyEl), onSearch(v,opts), subnavExtras(), drive, driveKind, update(),
// onActivate(), onDeactivate(), teardown(), escapeBlocked() }`.

import { createCivitaiContent } from "./cmcp-civitai-ui.js";
import { createAppsContent } from "./cmcp-apps-ui.js";
import { createTrainingContent } from "./cmcp-training-ui.js";
import { createLocalContent } from "./cmcp-runpod-ui.js";

// key → content factory + tab presentation. Order = tab-bar order.
const TABS = [
  { key: "civitai", label: "CivitAI", icon: "pi-images", factory: createCivitaiContent },
  { key: "apps", label: "Apps", icon: "pi-th-large", factory: createAppsContent },
  { key: "training", label: "Training", icon: "pi-bolt", factory: createTrainingContent },
  { key: "local", label: "RunPod", icon: "pi-server", factory: createLocalContent },
];
// Legacy per-surface alias classes applied to the modal while that tab is active.
const ALIAS = { civitai: "cmcp-civitai-modal", training: "cmcp-tr-modal", apps: "cmcp-apps-modal" };

let _cssInjected = false;
function injectCss() {
  if (_cssInjected) return;
  _cssInjected = true;
  const css = `
  .cmcp-cv-overlay { position: fixed; inset: 0; z-index: 10000; display: flex;
    align-items: center; justify-content: center; padding: 1.5rem; background: rgba(0,0,0,.6); }
  /* The unified card. container-type makes it the query container so a NARROW
     docked panel collapses the tab labels even on a wide screen. */
  .cmcp-modal.cmcp-sidepanel { width: min(1150px, 94vw); max-width: none; height: 90vh;
    max-height: 90vh; padding: 0; gap: 0; overflow: hidden; container-type: inline-size; }
  .cmcp-cv-head { display: flex; align-items: center; gap: .5rem; padding: .6rem .7rem;
    border-bottom: 1px solid var(--p-content-border-color, #3f3f46); flex-wrap: wrap; }
  .cmcp-cv-tabs { display: flex; gap: .25rem; flex-wrap: wrap; }
  .cmcp-sp-title { font-weight: 600; font-size: .85rem; color: var(--p-text-color, #fafafa); padding: 0 .25rem; }
  .cmcp-cv-tab { display: inline-flex; align-items: center; gap: .3rem; padding: .3rem .55rem;
    border-radius: 8px; border: 1px solid transparent; background: transparent;
    color: var(--p-text-muted-color, #a1a1aa); cursor: pointer; font-size: .8rem; }
  /* Active tab uses the ComfyUI/PrimeVue theme primary so it inverts correctly in
     light + dark (precedent: .cmcp-btn primary). */
  .cmcp-cv-tab.active { background: var(--p-primary-color, #3a7bd5);
    color: var(--p-primary-contrast-color, #fff); border-color: transparent; }
  .cmcp-cv-subnav { display: flex; align-items: center; gap: .4rem; padding: .45rem .7rem;
    border-bottom: 1px solid var(--p-content-border-color, #3f3f46); flex-wrap: wrap; }
  .cmcp-cv-search { flex: 1 1 8rem; min-width: 6rem; padding: .35rem .5rem; border-radius: 8px;
    background: var(--p-surface-950, #111); border: 1px solid var(--p-content-border-color, #3f3f46);
    color: var(--p-text-color, #fafafa); }
  .cmcp-cv-iconbtn { position: relative; background: transparent; border: 1px solid var(--p-content-border-color,#3f3f46);
    color: var(--p-text-color,#fafafa); border-radius: 8px; padding: .35rem .5rem; cursor: pointer; }
  .cmcp-cv-dot { position: absolute; top: -3px; right: -3px; width: 8px; height: 8px; border-radius: 50%;
    background: var(--p-primary-color, #3a7bd5); }
  .cmcp-cv-body { position: relative; flex: 1; overflow-y: auto; padding: .6rem; }
  .cmcp-cv-frow { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; }
  .cmcp-cv-chip { padding: .25rem .5rem; border-radius: 999px; font-size: .75rem; cursor: pointer;
    border: 1px solid var(--p-content-border-color,#3f3f46); background: transparent; color: var(--p-text-color,#fafafa); }
  .cmcp-cv-chip.on { background: var(--p-primary-color,#3a7bd5); border-color: transparent; color:#fff; }
  /* Agent-driven "glow" — shared across every surface (steps, cards, fields). */
  .cmcp-agent-glow { outline: 2px solid var(--p-green-400,#4ade80);
    box-shadow: 0 0 0 2px var(--p-green-400,#4ade80), 0 0 16px 2px rgba(74,222,128,.6);
    border-radius: 8px; animation: cmcp-glow 1.4s ease-in-out infinite; }
  @keyframes cmcp-glow { 50% { box-shadow: 0 0 0 3px var(--p-green-400,#4ade80),
    0 0 24px 6px rgba(74,222,128,.9); } }
  /* Agent-driven side-dock: anchor to the canvas side opposite the Agent pane,
     drop the dim backdrop, let clicks pass THROUGH the overlay so chat stays
     interactive; only the card catches pointer events. Slides in via translateX;
     close() reverses it before detaching. Below the lightbox (z 10002). */
  .cmcp-cv-overlay.cmcp-docked { display: block; padding: 0; background: transparent;
    pointer-events: none; }
  .cmcp-cv-overlay.cmcp-docked .cmcp-modal { position: fixed; pointer-events: auto;
    width: auto; max-width: none; height: auto; max-height: none; border-radius: 0;
    box-shadow: -8px 0 32px rgba(0,0,0,.45); transform: translateX(24px); opacity: 0;
    transition: transform .28s ease, opacity .28s ease; }
  .cmcp-cv-overlay.cmcp-docked.cmcp-dock-in .cmcp-modal { transform: translateX(0); opacity: 1; }
  /* Responsive tab bar (container query): a narrow docked panel collapses to
     icon-only tabs even on a wide screen. */
  @container (max-width: 400px) {
    .cmcp-cv-tab span { position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip-path: inset(50%); white-space: nowrap; }
    .cmcp-cv-tab { padding: .3rem .45rem; }
  }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/** Slide/fade the panel out before detaching (shared exit). Docked: reverse the
 *  translateX slide-in (drop cmcp-dock-in); centered/narrow: a plain opacity
 *  fade. The DOM is removed after the transition window (jsdom fires no
 *  transitionend, so a fixed timer drives it). Idempotent. */
const DOCK_SLIDE_OUT_MS = 240;
function slideOutThenRemove(overlay) {
  const docked = overlay.classList.contains("cmcp-docked");
  overlay.style.pointerEvents = "none";
  if (docked) {
    overlay.classList.remove("cmcp-dock-in");
  } else {
    overlay.style.transition = "opacity .18s ease";
    overlay.style.opacity = "0";
  }
  setTimeout(() => { try { overlay.remove(); } catch { /* already gone */ } }, DOCK_SLIDE_OUT_MS);
}

/**
 * Open the unified side-panel. Returns a single self-invalidating handle:
 *   { close, focus, isOpen, update, switchTab, activeTab, civitai:{…}, training:{…} }
 * The civitai/training facades delegate to the ACTIVE content's `drive`; if the
 * active tab isn't that surface they throw the legacy "…not open" message the
 * bridge expects.
 *
 * opts = { tab, tabOpts:{civitai?,apps?,training?,local?}, dock, onClose }.
 */
export function openSidePanel(ctx = {}, opts = {}) {
  injectCss();
  const tabOpts = opts.tabOpts || {};
  const initialKey = TABS.some((t) => t.key === opts.tab) ? opts.tab : "civitai";

  // ── DOM skeleton ───────────────────────────────────────────────────────────
  const overlay = el("div", "cmcp-cv-overlay");
  const modal = el("div", "cmcp-modal cmcp-sidepanel");
  const head = el("div", "cmcp-cv-head");
  // The four TOOLBAR buttons ARE the tabs (host toggles their active state via
  // onTabChange); the panel header just names the active surface + carries the ✕.
  const titleEl = el("div", "cmcp-sp-title");
  const closeBtn = el("button", "cmcp-cv-iconbtn");
  closeBtn.innerHTML = '<i class="pi pi-times"></i>';
  closeBtn.title = "Close";
  closeBtn.style.marginLeft = "auto";
  head.append(titleEl, closeBtn);

  const subnav = el("div", "cmcp-cv-subnav");
  const searchEl = el("input", "cmcp-cv-search");
  // type=search (not text) so a visible shared box never collides with a tab
  // body's own input[type=text] fields (e.g. training's dataset-name/trigger,
  // which specs locate positionally).
  searchEl.type = "search";
  searchEl.placeholder = "Search…";
  const extras = el("div", "cmcp-cv-frow"); // content-provided subnav content
  extras.style.flex = "1 1 auto";
  subnav.append(searchEl, extras);

  const body = el("div", "cmcp-cv-body");

  modal.append(head, subnav, body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // ── lifecycle state ─────────────────────────────────────────────────────────
  let isOpen = true;
  let activeKey = null;
  const contents = new Map(); // key → content instance (lazy)
  let _onEscape = null;
  let _onDockResize = null;
  let _dockDispose = null;

  const close = () => {
    if (!isOpen) return; // idempotent
    isOpen = false;
    if (_onEscape) { document.removeEventListener("keydown", _onEscape); _onEscape = null; }
    if (_onDockResize) { window.removeEventListener("resize", _onDockResize); _onDockResize = null; }
    if (_dockDispose) { try { _dockDispose(); } catch { /* best effort */ } _dockDispose = null; }
    for (const c of contents.values()) { try { c.teardown?.(); } catch { /* already gone */ } }
    slideOutThenRemove(overlay);
    try { opts.onClose?.(); } catch { /* host bookkeeping only */ }
  };
  // In docked mode the overlay is click-through, so a backdrop mousedown never
  // fires; the header ✕ / Escape are the dismissals. Centered keeps backdrop-close.
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  closeBtn.addEventListener("click", close);
  _onEscape = (e) => {
    if (e.key !== "Escape") return;
    // Yield to a content-owned stacked layer (the Civitai lightbox / sub-modals).
    const active = contents.get(activeKey);
    if (active && typeof active.escapeBlocked === "function") {
      try { if (active.escapeBlocked()) return; } catch { /* fall through to close */ }
    }
    e.stopPropagation();
    close();
  };
  document.addEventListener("keydown", _onEscape);

  // ── docked mode ─────────────────────────────────────────────────────────────
  applyDock.centered = false;
  function applyDock() {
    if (!opts.dock) { setCentered(); return; }
    const geo = _dockGeometry();
    if (geo?.status === "detached") { overlay.style.display = "none"; return; }
    overlay.style.display = "";
    if (geo?.status === "docked" && window.innerWidth >= 900) {
      overlay.classList.add("cmcp-docked");
      modal.style.left = `${Math.round(geo.left)}px`;
      modal.style.top = `${Math.round(geo.top)}px`;
      modal.style.right = `${Math.round(geo.right)}px`;
      modal.style.bottom = `${Math.round(geo.bottom)}px`;
      applyDock.centered = false;
    } else {
      setCentered();
    }
  }
  function setCentered() {
    overlay.classList.remove("cmcp-docked");
    overlay.style.display = "";
    modal.style.left = modal.style.right = modal.style.top = modal.style.bottom = "";
    applyDock.centered = true;
  }
  function _dockGeometry() {
    if (typeof ctx.dockGeometry === "function") {
      try { const g = ctx.dockGeometry(); if (g) return g; } catch { /* fall through */ }
    }
    try {
      const root = ctx.root;
      if (root && !root.isConnected) return { status: "detached" };
      const pane = root?.closest?.(".side-bar-panel") || root?.closest?.("[class*='sidebar']") || root;
      const pr = pane?.getBoundingClientRect?.();
      if (!pr || pr.width < 1 || pr.height < 1) return { status: "centered" };
      const vw = window.innerWidth, vh = window.innerHeight;
      const paneOnLeft = (pr.left + pr.right) / 2 < vw / 2;
      const left = paneOnLeft ? Math.max(0, pr.right) : 0;
      const right = paneOnLeft ? 0 : Math.max(0, vw - pr.left);
      if (vw - left - right < 320) return { status: "centered" };
      return { status: "docked", left, right, top: Math.max(0, pr.top), bottom: Math.max(0, vh - pr.bottom) };
    } catch { return { status: "centered" }; }
  }

  // ── shared search row ────────────────────────────────────────────────────────
  function syncSearch() {
    const c = contents.get(activeKey);
    const has = c ? (typeof c.hasSearch === "function" ? c.hasSearch() : !!c.hasSearch) : false;
    searchEl.style.display = has ? "" : "none";
    if (has && c) searchEl.placeholder = c.searchPlaceholder || "Search…";
  }
  searchEl.addEventListener("input", () => {
    const c = contents.get(activeKey);
    if (c && typeof c.onSearch === "function") c.onSearch(searchEl.value, {});
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const c = contents.get(activeKey);
    if (c && typeof c.onSearch === "function") c.onSearch(searchEl.value, { enter: true });
  });

  // ── the object handed to content providers ───────────────────────────────────
  const shell = {
    ctx, overlay, modal, body, searchEl, subnav, extras, head,
    close, applyDock, syncSearch,
    isDocked: () => overlay.classList.contains("cmcp-docked") && !applyDock.centered,
    isCentered: () => applyDock.centered,
  };

  // ── tab bar + activation ─────────────────────────────────────────────────────
  function ensureContent(key) {
    if (contents.has(key)) return contents.get(key);
    const def = TABS.find((t) => t.key === key);
    const inst = def.factory(ctx, shell, tabOpts[key] || {});
    contents.set(key, inst);
    return inst;
  }
  /** Activate a tab: deactivate the prior one, clear the body/subnav, mount the
   *  next, then re-dock WITHOUT replaying the slide-in. */
  function activate(key, { reseed = null } = {}) {
    if (!isOpen) return null;
    if (activeKey === key) {
      const cur = contents.get(key);
      if (reseed && cur && typeof cur.reseed === "function") { try { cur.reseed(reseed); } catch { /* ignore */ } }
      return cur;
    }
    const prev = contents.get(activeKey);
    if (prev && typeof prev.onDeactivate === "function") { try { prev.onDeactivate(); } catch { /* ignore */ } }
    body.textContent = "";
    extras.textContent = "";
    for (const a of Object.values(ALIAS)) modal.classList.remove(a);
    activeKey = key;
    const def = TABS.find((t) => t.key === key);
    titleEl.textContent = def ? def.label : "";
    if (ALIAS[key]) modal.classList.add(ALIAS[key]);
    // The toolbar buttons are the tab bar — tell the host to reflect the active one.
    try { opts.onTabChange?.(key); } catch { /* host toolbar sync only */ }
    const inst = ensureContent(key);
    const ex = typeof inst.subnavExtras === "function" ? inst.subnavExtras() : null;
    for (const n of (ex || [])) if (n) extras.appendChild(n);
    inst.mount(body);
    if (reseed && typeof inst.reseed === "function") { try { inst.reseed(reseed); } catch { /* ignore */ } }
    syncSearch();
    if (typeof inst.onActivate === "function") { try { inst.onActivate(); } catch { /* ignore */ } }
    applyDock(); // re-dock (no slide replay: cmcp-dock-in stays set)
    return inst;
  }

  // ── go: mount the initial tab, then wire the dock + slide-in ──────────────────
  activate(initialKey);
  if (opts.dock) {
    applyDock();
    if (typeof ctx.watchDock === "function") {
      try { _dockDispose = ctx.watchDock(applyDock); } catch { _dockDispose = null; }
    }
    if (!_dockDispose) { _onDockResize = () => applyDock(); window.addEventListener("resize", _onDockResize); }
    requestAnimationFrame(() => overlay.classList.add("cmcp-dock-in"));
  }

  // ── agent-drive facade ───────────────────────────────────────────────────────
  function _driveOf(kind, legacyMsg, method, args) {
    const c = contents.get(activeKey);
    if (!isOpen || !c || c.driveKind !== kind || !c.drive || typeof c.drive[method] !== "function") {
      throw new Error(legacyMsg);
    }
    return c.drive[method](...args);
  }
  const civitai = {
    getResults: (a) => _driveOf("civitai", "civitai browser not open", "getResults", [a]),
    highlight: (ids, o) => _driveOf("civitai", "civitai browser not open", "highlight", [ids, o]),
    clearHighlight: () => _driveOf("civitai", "civitai browser not open", "clearHighlight", []),
    switchTab: (t) => _driveOf("civitai", "civitai browser not open", "switchTab", [t]),
    search: (a) => _driveOf("civitai", "civitai browser not open", "search", [a]),
    openLightbox: (id, o) => _driveOf("civitai", "civitai browser not open", "openLightbox", [id, o]),
    getState: () => _driveOf("civitai", "civitai browser not open", "getState", []),
  };
  const training = {
    getState: () => _driveOf("training", "training wizard not open", "getState", []),
    setField: (n, v) => _driveOf("training", "training wizard not open", "setField", [n, v]),
    gotoStep: (s) => _driveOf("training", "training wizard not open", "gotoStep", [s]),
    setTarget: (t) => _driveOf("training", "training wizard not open", "setTarget", [t]),
    highlight: (r) => _driveOf("training", "training wizard not open", "highlight", [r]),
    clearHighlight: () => _driveOf("training", "training wizard not open", "clearHighlight", []),
  };

  return {
    close,
    isOpen: () => isOpen,
    activeTab: () => activeKey,
    focus: () => { try { if (searchEl.style.display !== "none") searchEl.focus(); } catch { /* detached */ } },
    // RunPod status frames → re-render the active content (no-op unless Local).
    update: () => { const c = contents.get(activeKey); if (c && typeof c.update === "function") { try { c.update(); } catch { /* ignore */ } } },
    // Switch the top-level tab (host uses this when the panel is already open).
    switchTab: (key, reseed) => { activate(key, { reseed }); return { tab: activeKey }; },
    civitai,
    training,
  };
}
