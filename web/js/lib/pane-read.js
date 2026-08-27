// Live CivitAI pane read (#1961, #1962).
//
// The agent must see what the USER sees in the docked pane. That is the
// authenticated grid currently painted in the renderer — including CivitAI RED
// content the public REST API never serves. Re-fetching models from the API is
// therefore not a substitute: a card the grid is showing and a card the API
// would return are different sets.
//
// These helpers inspect the live overlay/grid DOM (and the pane's own in-memory
// state that painted it). They never call CivitAI. Overlay presence is reported
// as a boolean only; lightbox internals are a separate contract (#1964).

export const PANE_READ_SOURCE = "live-pane";

const DEFAULT_LIMIT = 40;
const PREVIEW_MAX_CARDS = 6;
const PREVIEW_CELL = 96;

function clampLimit(limit) {
  const n = Number(limit);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : DEFAULT_LIMIT;
}

function classHas(el, name) {
  if (!el) return false;
  if (el.classList && typeof el.classList.contains === "function") {
    try { return !!el.classList.contains(name); } catch { /* fall through */ }
  }
  const cls = typeof el.className === "string" ? el.className : "";
  return (` ${cls} `).includes(` ${name} `);
}

function textOf(el) {
  if (!el) return "";
  const t = el.textContent;
  return typeof t === "string" ? t.replace(/\s+/g, " ").trim() : "";
}

function childByClass(el, cls) {
  if (!el || typeof el.querySelector !== "function") return null;
  try { return el.querySelector(`.${cls}`); } catch { return null; }
}

function isPainted(el) {
  if (!el) return false;
  if (el.isConnected === false) return false;
  const display = el.style && el.style.display;
  if (display === "none") return false;
  return true;
}

/**
 * Cards currently painted in the CivitAI grid. Source of truth is the live
 * `.cmcp-cv-card` nodes, not an items[] payload and not a network call.
 */
export function readCivitaiGridCards(grid, { limit = DEFAULT_LIMIT } = {}) {
  const lim = clampLimit(limit);
  if (!grid || typeof grid.querySelectorAll !== "function" || !isPainted(grid)) {
    return [];
  }
  let nodes;
  try { nodes = grid.querySelectorAll(".cmcp-cv-card"); } catch { return []; }
  const rows = [];
  for (const card of nodes || []) {
    if (!isPainted(card)) continue;
    const id = card.dataset && card.dataset.id != null ? String(card.dataset.id) : "";
    if (!id) continue;
    const gated = classHas(card, "cmcp-cv-gated");
    const highlighted = classHas(card, "cmcp-agent-glow");
    const img = typeof card.querySelector === "function" ? card.querySelector("img") : null;
    const src = !gated && img && typeof img.src === "string" && img.src ? img.src : null;
    rows.push({
      id,
      kind: (card.dataset && card.dataset.kind) || "media",
      foot: textOf(childByClass(card, "cmcp-cv-cardfoot")) || null,
      rating: textOf(childByClass(card, "cmcp-cv-rating")) || null,
      badge: textOf(childByClass(card, "cmcp-cv-badge")) || null,
      gated,
      highlighted,
      src,
      el: card,
    });
    if (rows.length >= lim) break;
  }
  return rows;
}

/** Overlay presence only. Lightbox body/media are #1964. */
export function readPaneOverlayPresence(root) {
  if (!root || typeof root.querySelector !== "function") {
    return { lightbox: false };
  }
  let lb = null;
  try { lb = root.querySelector(".cmcp-cv-lb"); } catch { lb = null; }
  return { lightbox: !!(lb && isPainted(lb)) };
}

/**
 * Contact-sheet preview of thumbs ALREADY decoded in the live grid.
 *
 * Draws the painted <img> elements. Does not fetch URLs, does not sample
 * gated cards, and does not fall back to the ComfyUI canvas. Missing canvas
 * support or no decoded thumbs is `captured:false` with a reason — never a
 * blank PNG that could be mistaken for "the pane is empty".
 */
export function captureLivePanePreview(visibleCards, {
  blind = false,
  createElement,
  maxCards = PREVIEW_MAX_CARDS,
  cell = PREVIEW_CELL,
} = {}) {
  if (blind) return { captured: false, withheld: true, reason: "blind" };

  const cap = Number.isFinite(maxCards) && maxCards > 0 ? Math.min(Math.floor(maxCards), 12) : PREVIEW_MAX_CARDS;
  const size = Number.isFinite(cell) && cell > 0 ? Math.min(Math.floor(cell), 256) : PREVIEW_CELL;
  const imgs = [];
  for (const row of Array.isArray(visibleCards) ? visibleCards : []) {
    if (!row || row.gated) continue;
    const el = row.el;
    const img = el && typeof el.querySelector === "function" ? el.querySelector("img") : null;
    if (!img || typeof img.src !== "string" || !img.src) continue;
    if (img.complete === false) continue;
    const w = Number(img.naturalWidth) || Number(img.width) || 0;
    const h = Number(img.naturalHeight) || Number(img.height) || 0;
    if (w < 1 || h < 1) continue;
    imgs.push(img);
    if (imgs.length >= cap) break;
  }
  if (!imgs.length) return { captured: false, reason: "no-decoded-thumbs" };

  const make =
    typeof createElement === "function"
      ? createElement
      : (typeof document !== "undefined" && typeof document.createElement === "function"
        ? (tag) => document.createElement(tag)
        : null);
  if (!make) return { captured: false, reason: "no-canvas" };

  let canvas;
  try { canvas = make("canvas"); } catch { canvas = null; }
  if (!canvas || typeof canvas.getContext !== "function") {
    return { captured: false, reason: "no-canvas" };
  }
  const cols = Math.min(4, imgs.length);
  const rows = Math.ceil(imgs.length / cols);
  canvas.width = cols * size;
  canvas.height = rows * size;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.drawImage !== "function") {
    return { captured: false, reason: "no-canvas" };
  }
  let drawn = 0;
  imgs.forEach((img, i) => {
    const x = (i % cols) * size;
    const y = Math.floor(i / cols) * size;
    try {
      ctx.drawImage(img, x, y, size, size);
      drawn += 1;
    } catch { /* tainted / detached */ }
  });
  if (!drawn) return { captured: false, reason: "draw-failed" };
  if (typeof canvas.toDataURL !== "function") return { captured: false, reason: "no-canvas" };
  let dataUrl;
  try { dataUrl = canvas.toDataURL("image/png"); } catch {
    return { captured: false, reason: "tainted-canvas" };
  }
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
    return { captured: false, reason: "empty-capture" };
  }
  const comma = dataUrl.indexOf(",");
  return {
    captured: true,
    source: PANE_READ_SOURCE,
    mimeType: "image/png",
    width: canvas.width,
    height: canvas.height,
    cards: drawn,
    image: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
  };
}

function copyLevels(filters) {
  const levels = filters && Array.isArray(filters.browsingLevels) ? filters.browsingLevels : null;
  return levels ? levels.map((n) => n) : null;
}

/**
 * What the live CivitAI pane is showing right now.
 *
 * `items` / API payloads are ignored: `visible` is populated only from painted
 * grid cards. A closed or hidden pane returns `open`/`showing` honestly and an
 * empty `visible` list — leftover detached cards are not the user's view.
 */
export function readLiveCivitaiPane({
  open = false,
  showing = false,
  shellTab = null,
  docked = false,
  grid = null,
  searchEl = null,
  overlay = null,
  document: doc = null,
  state = null,
  limit = DEFAULT_LIMIT,
  includePreview = false,
  blind = false,
  createElement = undefined,
} = {}) {
  const isOpen = !!open;
  const isShowing = isOpen && !!showing && isPainted(grid);
  const visible = isShowing ? readCivitaiGridCards(grid, { limit }) : [];
  const overlayRoot = overlay || doc || null;
  const out = {
    ok: true,
    open: isOpen,
    showing: isShowing,
    source: PANE_READ_SOURCE,
    surface: "civitai",
    shell_tab: shellTab ?? null,
    docked: !!docked,
    tab: state && typeof state.tab === "string" ? state.tab : null,
    query: state && typeof state.query === "string" ? state.query : null,
    query_box: searchEl && typeof searchEl.value === "string" ? searchEl.value : null,
    loading: !!(state && state.loading),
    done: !!(state && state.done),
    authenticated: !!(state && state.signedIn),
    error: (state && state.error) || null,
    browsingLevels: copyLevels(state && state.filters),
    highlighted: isShowing ? visible.filter((c) => c.highlighted).map((c) => c.id) : [],
    overlay: readPaneOverlayPresence(overlayRoot),
    visible: visible.map(({ el, ...rest }) => rest),
    count: visible.length,
  };
  if (includePreview) {
    out.preview = isShowing
      ? captureLivePanePreview(visible, { blind, createElement })
      : { captured: false, reason: isOpen ? "pane-not-showing" : "pane-closed" };
  }
  return out;
}

/**
 * Read through the side-panel handle. A missing/closed handle is an empty
 * live-pane result, not a throw — absence is the observation.
 */
export function readCivitaiPaneHandle(handle, opts = {}) {
  if (handle && typeof handle.readCivitai === "function") {
    return handle.readCivitai(opts);
  }
  const open = !!(handle && typeof handle.isOpen === "function" && handle.isOpen());
  return readLiveCivitaiPane({
    open,
    showing: false,
    shellTab: handle && typeof handle.activeTab === "function" ? handle.activeTab() : null,
    docked: !!(handle && typeof handle.isDocked === "function" && handle.isDocked()),
    ...opts,
  });
}
