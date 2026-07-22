// CivitAI browser modal for the panel — a browser port of the mobile app's
// civitai_browse_screen / viewer / filter sheet. Opens from the (formerly parked)
// "Civitai" toolbar button, and can be opened BY the agent pre-seeded with a query
// + filters (cmd: open_civitai). Every network call goes through CivitaiClient →
// the same-origin proxy. Actions are mute-aware: un-muted hands the pick to the
// agent (share-with-agent), muted downloads directly via call_tool.
//
// The monolith injects a `ctx` so this module never reaches into panel internals:
//   ctx = { api, root, callTool, sendUserMessage, uploadBlobToInput,
//           bringChatForward, isMuted, marked, DOMPurify,
//           graphIsDirty, loadGraph }   // canvas access for "load onto canvas"

import {
  CivitaiClient, DEFAULT_FILTERS, LEVELS, PERIODS, IMAGE_SORTS, MODEL_SORTS,
  BASE_MODELS, ACTIVE_BASE_MODELS, prepareQuery, matchesBaseModel,
  filtersDirty, bitmask, parseCreatorQuery,
} from "./cmcp-civitai.js";

const TABS = [
  { key: "images", label: "Images", icon: "pi-image", media: "image" },
  { key: "videos", label: "Videos", icon: "pi-video", media: "video" },
  { key: "checkpoints", label: "Checkpoints", icon: "pi-box", model: "Checkpoint" },
  { key: "loras", label: "LoRAs", icon: "pi-sliders-h", model: "LORA" },
  { key: "workflows", label: "Workflows", icon: "pi-share-alt", model: "Workflows" },
  { key: "favorites", label: "Favorites", icon: "pi-heart", media: "image", fav: true },
];

const SUBFOLDER = {
  LORA: "loras", Workflows: "workflows", TextualInversion: "embeddings",
  VAE: "vae", Controlnet: "controlnet", Checkpoint: "checkpoints",
};

// The "default likes folder": a CivitAI collection every like is also saved
// into (and removed from on unlike). Picked in the account sheet; persisted
// locally as {id, name}.
const LIKES_COLLECTION_KEY = "comfyui-mcp.civitai.likesCollection";
function likesCollection() {
  try { return JSON.parse(localStorage.getItem(LIKES_COLLECTION_KEY)) || null; }
  catch { return null; }
}
function setLikesCollection(c) {
  try {
    if (c && c.id) localStorage.setItem(LIKES_COLLECTION_KEY, JSON.stringify({ id: c.id, name: c.name }));
    else localStorage.removeItem(LIKES_COLLECTION_KEY);
  } catch { /* non-persistent is fine */ }
}

/** The collection the likes feed reads from: the picked "likes collection"
 *  when set, else a one-time auto-detect persisted for next time (the web's ❤
 *  saves into a COLLECTION — reactions only hold in-app hearts, so reading
 *  reactions alone showed a handful while the collection held the real
 *  hundreds). Null → the reactions fallback. */
async function resolveLikesCollectionId(client) {
  const cur = likesCollection();
  if (cur?.id) return cur.id;
  try {
    const all = await client.getUserCollections();
    if (!all.length) return null;
    const byName = all.filter((c) => /fav|like/i.test(c.name || ""));
    const pick = byName[0] || (all.length === 1 ? all[0] : null);
    if (!pick) return null;
    setLikesCollection(pick); // the ❤ mirror + this feed now share one collection
    return pick.id;
  } catch {
    return null; // never block the tab on this lookup
  }
}

let _cssInjected = false;
function injectCss() {
  if (_cssInjected) return;
  _cssInjected = true;
  const css = `
  .cmcp-cv-overlay { position: fixed; inset: 0; z-index: 10000; display: flex;
    align-items: center; justify-content: center; padding: 1.5rem; background: rgba(0,0,0,.6); }
  .cmcp-civitai-modal { width: min(1150px, 94vw); max-width: none; height: 90vh;
    max-height: 90vh; padding: 0; gap: 0; overflow: hidden; }
  .cmcp-cv-head { display: flex; align-items: center; gap: .5rem; padding: .6rem .7rem;
    border-bottom: 1px solid var(--p-content-border-color, #3f3f46); flex-wrap: wrap; }
  .cmcp-cv-tabs { display: flex; gap: .25rem; flex-wrap: wrap; }
  .cmcp-cv-tab { display: inline-flex; align-items: center; gap: .3rem; padding: .3rem .55rem;
    border-radius: 8px; border: 1px solid transparent; background: transparent;
    color: var(--p-text-muted-color, #a1a1aa); cursor: pointer; font-size: .8rem; }
  .cmcp-cv-tab.active { background: var(--p-surface-800, #27272a);
    color: var(--p-text-color, #fafafa); border-color: var(--p-content-border-color, #3f3f46); }
  .cmcp-cv-search { flex: 1 1 8rem; min-width: 6rem; padding: .35rem .5rem; border-radius: 8px;
    background: var(--p-surface-950, #111); border: 1px solid var(--p-content-border-color, #3f3f46);
    color: var(--p-text-color, #fafafa); }
  .cmcp-cv-iconbtn { position: relative; background: transparent; border: 1px solid var(--p-content-border-color,#3f3f46);
    color: var(--p-text-color,#fafafa); border-radius: 8px; padding: .35rem .5rem; cursor: pointer; }
  .cmcp-cv-dot { position: absolute; top: -3px; right: -3px; width: 8px; height: 8px; border-radius: 50%;
    background: var(--p-primary-color, #3a7bd5); }
  .cmcp-cv-body { position: relative; flex: 1; overflow-y: auto; padding: .6rem; }
  .cmcp-cv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: .5rem; }
  .cmcp-cv-card { position: relative; border-radius: 10px; overflow: hidden; cursor: pointer;
    background: var(--p-surface-900, #18181b); aspect-ratio: .72; }
  .cmcp-cv-card img, .cmcp-cv-card video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cmcp-cv-cardfoot { position: absolute; left: 0; right: 0; bottom: 0; padding: .3rem .4rem;
    font-size: .7rem; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.75)); }
  .cmcp-cv-badge { position: absolute; top: .3rem; left: .3rem; background: rgba(0,0,0,.6); color:#fff;
    font-size: .6rem; padding: .1rem .3rem; border-radius: 4px; }
  .cmcp-cv-add { position: absolute; top: .3rem; right: .3rem; background: rgba(0,0,0,.55); color:#fff;
    border: none; border-radius: 6px; width: 24px; height: 24px; cursor: pointer; }
  .cmcp-cv-owned { position: absolute; top: .3rem; right: .3rem; background: rgba(34,197,94,.92);
    color: #04120a; font-size: .6rem; font-weight: 700; padding: .12rem .35rem; border-radius: 4px; }
  .cmcp-cv-loading { text-align: center; padding: 1rem; color: var(--p-text-muted-color,#a1a1aa); }
  .cmcp-cv-progress { position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: var(--p-primary-color, #3a7bd5); opacity: .0; transition: opacity .2s; }
  .cmcp-cv-progress.on { opacity: 1; animation: cmcp-cv-pulse 1s ease-in-out infinite; }
  @keyframes cmcp-cv-pulse { 0%,100%{opacity:.3} 50%{opacity:1} }
  .cmcp-cv-filters { display: flex; flex-direction: column; gap: .7rem; }
  .cmcp-cv-frow { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; }
  .cmcp-cv-chip { padding: .25rem .5rem; border-radius: 999px; font-size: .75rem; cursor: pointer;
    border: 1px solid var(--p-content-border-color,#3f3f46); background: transparent; color: var(--p-text-color,#fafafa); }
  .cmcp-cv-chip.on { background: var(--p-primary-color,#3a7bd5); border-color: transparent; color:#fff; }
  .cmcp-cv-flabel { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em;
    color: var(--p-text-muted-color,#a1a1aa); width: 100%; }
  .cmcp-cv-detail img, .cmcp-cv-detail video { border-radius: 8px; }
  .cmcp-cv-actions { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .5rem; }
  .cmcp-cv-wfstatus { margin-top: .5rem; padding: .45rem .6rem; border-radius: 8px; font-size: .78rem;
    line-height: 1.35; background: var(--p-surface-800,#27272a); color: var(--p-text-color,#fafafa);
    border: 1px solid var(--p-content-border-color,#3f3f46); }
  .cmcp-cv-wfstatus.warn { border-color: #d97706; color: #fcd34d; }
  .cmcp-cv-wfstatus.err { border-color: #dc2626; color: #fca5a5; }
  .cmcp-cv-viewer { position: absolute; inset: 0; z-index: 5; background: rgba(0,0,0,.94);
    display: flex; align-items: center; justify-content: center; }
  .cmcp-cv-viewer img, .cmcp-cv-viewer video { max-width: 100%; max-height: 100%; object-fit: contain; }
  .cmcp-cv-vtop { position: absolute; top: .5rem; right: .5rem; display: flex; gap: .4rem; z-index: 6; }
  .cmcp-cv-triggers { display: flex; flex-wrap: wrap; gap: .3rem; margin: .4rem 0; }
  .cmcp-cv-trigger { font-size: .72rem; padding: .15rem .4rem; border-radius: 6px;
    background: var(--p-surface-800,#27272a); color: var(--p-text-color,#fafafa); }
  .cmcp-cv-lb { position: fixed; inset: 0; z-index: 10002; display: flex;
    background: rgba(0,0,0,.96); outline: none; }
  .cmcp-cv-lb-stage { position: relative; flex: 1 1 auto; display: flex;
    align-items: center; justify-content: center; min-width: 0; }
  .cmcp-cv-lb-stage img, .cmcp-cv-lb-stage video { max-width: 100%; max-height: 100vh; object-fit: contain; }
  .cmcp-cv-lb-side { flex: 0 0 380px; max-width: 44vw; overflow-y: auto; padding: 1rem;
    background: var(--p-surface-900, #18181b); border-left: 1px solid var(--p-content-border-color,#3f3f46);
    color: var(--p-text-color,#fafafa); display: flex; flex-direction: column; gap: .6rem; }
  .cmcp-cv-lb-nav { position: absolute; top: 50%; transform: translateY(-50%);
    background: rgba(0,0,0,.5); border: none; color: #fff; border-radius: 999px;
    width: 40px; height: 40px; cursor: pointer; font-size: 1rem; z-index: 3; }
  .cmcp-cv-lb-nav:hover { background: rgba(0,0,0,.8); }
  .cmcp-cv-lb-close { position: absolute; top: .6rem; right: .6rem; z-index: 3; }
  .cmcp-cv-lb-title { font-size: .9rem; font-weight: 600; display: flex; align-items: center;
    gap: .5rem; padding-right: 2.2rem; }
  .cmcp-cv-like { margin-left: auto; }
  .cmcp-cv-like.on { color: #f43f5e; border-color: #f43f5e; }
  .cmcp-cv-subnav { display: flex; align-items: center; gap: .4rem; padding: .45rem .7rem;
    border-bottom: 1px solid var(--p-content-border-color, #3f3f46); }
  .cmcp-cv-cardlike { position: absolute; top: .3rem; right: .3rem; z-index: 2;
    background: rgba(0,0,0,.55); border: none; color: #fff; border-radius: 8px;
    width: 28px; height: 28px; cursor: pointer; display: none; align-items: center;
    justify-content: center; }
  .cmcp-cv-card:hover .cmcp-cv-cardlike { display: inline-flex; }
  .cmcp-cv-cardlike.on { display: inline-flex; color: #f43f5e; }
  .cmcp-cv-searching { position: absolute; inset: 0; z-index: 4; display: flex;
    align-items: center; justify-content: center; backdrop-filter: blur(4px);
    background: rgba(0,0,0,.35); }
  .cmcp-cv-spinner { width: 42px; height: 42px; border-radius: 50%;
    border: 3px solid rgba(255,255,255,.25); border-top-color: var(--p-primary-color,#3a7bd5);
    animation: cmcp-cv-spin .8s linear infinite; }
  @keyframes cmcp-cv-spin { to { transform: rotate(360deg); } }
  .cmcp-cv-lb-muted { font-size: .74rem; color: var(--p-text-muted-color,#a1a1aa); }
  .cmcp-cv-creators { display: flex; flex-direction: column; gap: .2rem; width: 100%;
    max-height: 13rem; overflow-y: auto; }
  .cmcp-cv-creator { display: flex; align-items: baseline; gap: .5rem; padding: .3rem .5rem;
    border-radius: 8px; border: 1px solid var(--p-content-border-color,#3f3f46);
    background: transparent; color: var(--p-text-color,#fafafa); cursor: pointer;
    text-align: left; font-size: .78rem; }
  .cmcp-cv-creator:hover { background: var(--p-surface-800,#27272a); }
  .cmcp-cv-creator .sub { margin-left: auto; font-size: .68rem; flex-shrink: 0;
    color: var(--p-text-muted-color,#a1a1aa); }
  .cmcp-cv-dd { position: relative; width: 100%; }
  .cmcp-cv-ddpanel { position: absolute; z-index: 6; left: 0; right: 0; top: calc(100% + .25rem);
    display: none; flex-direction: column; gap: .1rem; padding: .25rem;
    max-height: min(20rem, 50vh); overflow-y: auto; border-radius: 8px;
    background: var(--p-surface-900,#18181b);
    border: 1px solid var(--p-content-border-color,#3f3f46);
    box-shadow: 0 8px 24px rgba(0,0,0,.45); }
  .cmcp-cv-dd.open .cmcp-cv-ddpanel { display: flex; }
  .cmcp-cv-ddlist, .cmcp-cv-ddgroupwrap { display: flex; flex-direction: column; gap: .1rem; }
  .cmcp-cv-ddgroup { font-size: .64rem; text-transform: uppercase; letter-spacing: .05em;
    color: var(--p-text-muted-color,#a1a1aa); padding: .35rem .5rem .15rem; }
  .cmcp-cv-ddopt { display: flex; align-items: center; gap: .45rem; padding: .3rem .5rem;
    border: none; border-radius: 6px; background: transparent; cursor: pointer;
    color: var(--p-text-color,#fafafa); font-size: .78rem; text-align: left; width: 100%; }
  .cmcp-cv-ddopt:hover, .cmcp-cv-ddopt.active { background: var(--p-surface-800,#27272a); }
  .cmcp-cv-ddopt .tick { width: .9rem; flex-shrink: 0; opacity: 0; }
  .cmcp-cv-ddopt.on .tick { opacity: 1; color: var(--p-primary-color,#3a7bd5); }
  .cmcp-cv-ddempty { padding: .4rem .5rem; font-size: .74rem;
    color: var(--p-text-muted-color,#a1a1aa); }
  .cmcp-cv-ddfoot { position: sticky; bottom: -.25rem; display: flex; align-items: center;
    justify-content: space-between; gap: .5rem; margin-top: .15rem; padding: .35rem .5rem;
    font-size: .72rem; color: var(--p-text-muted-color,#a1a1aa);
    background: var(--p-surface-900,#18181b);
    border-top: 1px solid var(--p-content-border-color,#3f3f46); }
  .cmcp-cv-ddclear { background: transparent; border: none; cursor: pointer; font-size: .72rem;
    padding: 0; color: var(--p-primary-color,#3a7bd5); }
  .cmcp-cv-lb-prompt { font-size: .78rem; white-space: pre-wrap; word-break: break-word;
    background: var(--p-surface-950,#111); border-radius: 8px; padding: .5rem;
    max-height: 14rem; overflow-y: auto; }
  .cmcp-cv-lb-params { display: grid; grid-template-columns: max-content 1fr; gap: .15rem .6rem;
    font-size: .74rem; }
  .cmcp-cv-lb-params .k { color: var(--p-text-muted-color,#a1a1aa); }
  @media (max-width: 760px) { .cmcp-cv-lb { flex-direction: column; }
    .cmcp-cv-lb-side { flex: 0 0 45%; max-width: none; border-left: none;
      border-top: 1px solid var(--p-content-border-color,#3f3f46); } }
  /* Agent-driven "glow" — the modal highlights the cards the agent points at. */
  .cmcp-cv-card.cmcp-agent-glow { outline: 2px solid var(--p-green-400,#4ade80);
    box-shadow: 0 0 0 2px var(--p-green-400,#4ade80), 0 0 16px 2px rgba(74,222,128,.6);
    animation: cmcp-glow 1.4s ease-in-out infinite; }
  @keyframes cmcp-glow { 50% { box-shadow: 0 0 0 3px var(--p-green-400,#4ade80),
    0 0 24px 6px rgba(74,222,128,.9); } }
  /* Agent-driven side-dock: anchor to the sidebar's right edge (measured in JS),
     drop the dim backdrop and let clicks pass THROUGH the overlay so chat stays
     interactive; only the modal card itself catches pointer events. Slide-in via
     the first translateX transition in the codebase. Kept below the lightbox
     (z 10002) so the lightbox still overlays. */
  .cmcp-cv-overlay.cmcp-docked { display: block; padding: 0; background: transparent;
    pointer-events: none; }
  .cmcp-cv-overlay.cmcp-docked .cmcp-civitai-modal { position: fixed; pointer-events: auto;
    width: auto; max-width: none; height: auto; max-height: none; border-radius: 0;
    box-shadow: -8px 0 32px rgba(0,0,0,.45); transform: translateX(24px); opacity: 0;
    transition: transform .28s ease, opacity .28s ease; }
  .cmcp-cv-overlay.cmcp-docked.cmcp-dock-in .cmcp-civitai-modal { transform: translateX(0); opacity: 1; }
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

/** Slide/fade the panel out before detaching (shared exit for the three docked
 *  side-panels). Docked: reverse the translateX slide-in (drop cmcp-dock-in) so
 *  the card slides back out; centered/narrow: a plain opacity fade — no
 *  horizontal slide. The DOM is removed after the transition window (jsdom fires
 *  no transitionend, so a fixed timer drives it). Idempotent — remove() on an
 *  already-detached node is a no-op. */
const DOCK_SLIDE_OUT_MS = 240;
function slideOutThenRemove(overlay) {
  const docked = overlay.classList.contains("cmcp-docked");
  overlay.style.pointerEvents = "none";
  if (docked) {
    overlay.classList.remove("cmcp-dock-in"); // card returns to translateX(24px)/opacity 0
  } else {
    overlay.style.transition = "opacity .18s ease";
    overlay.style.opacity = "0";
  }
  setTimeout(() => { try { overlay.remove(); } catch { /* already gone */ } }, DOCK_SLIDE_OUT_MS);
}

/** Fail-CLOSED dirty check for the load-onto-canvas overwrite confirm: any
 *  uncertainty (missing getter, non-boolean answer, a throw) counts as DIRTY
 *  so the user gets asked — never silently clobber an unsaved canvas.
 *  Exported for unit tests. */
export function graphDirtyForConfirm(ctx) {
  try {
    if (typeof ctx?.graphIsDirty !== "function") return true;
    const d = ctx.graphIsDirty();
    return typeof d === "boolean" ? d : true;
  } catch {
    return true;
  }
}

/** Serialize result rows — `state.items` (media) or `state.models` (models) —
 *  to the agent's `civitai_results` contract shape: id, kind, title, creator,
 *  baseModel/type, stats, prompt, and media URL(s). Metadata + URLs ONLY — never
 *  image bytes (the agent reasons from text; the human clicks to view). Pure and
 *  exported for unit tests. `limit` is clamped to [1, 200]. */
export const CIVITAI_PROMPT_CAP = 600; // chars — bound the agent's token budget
function _capPrompt(p) {
  if (typeof p !== "string" || !p) return p || null;
  return p.length > CIVITAI_PROMPT_CAP ? p.slice(0, CIVITAI_PROMPT_CAP) + "…" : p;
}
export function serializeCivitaiResults(source, { model = false, limit = 20, loading = false } = {}) {
  const n = Number(limit);
  const lim = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : 20;
  const rows = Array.isArray(source) ? source : [];
  const items = rows.slice(0, lim).map((x) => model ? {
    id: x.id, kind: "model", title: x.name || null, creator: x.creator || null,
    baseModel: x.baseModel || null, type: x.type || null,
    stats: { downloadCount: x.downloadCount ?? null, thumbsUp: x.thumbsUp ?? null },
    prompt: null, urls: x.coverUrl ? [x.coverUrl] : [],
  } : {
    id: x.id, kind: x.type === "video" ? "video" : "image",
    title: null, creator: x.author || null,
    baseModel: x.modelName || null, type: x.type || null,
    stats: { reactions: x.reactions ?? null },
    prompt: _capPrompt(x.prompt), // bounded — token budget (audit item 3)
    urls: [x.thumbnailUrl, x.fullUrl].filter(Boolean),
  });
  return { items, total: rows.length, loading: !!loading };
}

/** Open (or focus) the CivitAI modal. opts = {query, tab, filters, browsingLevels, dock, onClose}. */
export function openCivitaiModal(ctx, opts = {}) {
  injectCss();
  const client = new CivitaiClient(ctx.api);

  // ── state ────────────────────────────────────────────────────────────────
  const state = {
    tab: opts.tab && TABS.some((t) => t.key === opts.tab) ? opts.tab : "images",
    query: opts.query || "",
    // Deep-copy the array fields: DEFAULT_FILTERS is frozen but freeze is
    // shallow — spreading shares its arrays, and the level/base-model toggles
    // mutate in place (push/splice), which would corrupt the module default.
    filters: {
      ...DEFAULT_FILTERS,
      ...(opts.filters || {}),
      baseModels: [...(opts.filters?.baseModels ?? DEFAULT_FILTERS.baseModels)],
      browsingLevels: [...(opts.filters?.browsingLevels ?? DEFAULT_FILTERS.browsingLevels)],
    },
    items: [], models: [], cursor: null, loading: false, done: false, reqId: 0,
    searchSeq: 0, // searching-overlay ownership (see reload)
    signedIn: false, localNames: new Set(), localLoaded: false,
    favType: "all", // favorites sub-filter: all | image | video
    // Agent-drive: a render generation bumped on every reload/tab/filter so a
    // highlight that survives the await knows whether it's stale, and the
    // highlight target set (ids, in input order) that appendItems/appendModels
    // re-applies as later pages stream in on scroll.
    renderRev: 0,
    highlightSet: new Set(),
    highlightOrder: [],
    // The in-flight first-page reload / current page load, so drive methods can
    // truly await the modal settling.
    activeReloadPromise: null,
    activeLoadPromise: null,
  };
  if (Array.isArray(opts.browsingLevels) && opts.browsingLevels.length) {
    state.filters = { ...state.filters, browsingLevels: [...opts.browsingLevels] };
  }
  const tabDef = () => TABS.find((t) => t.key === state.tab);
  const isModelTab = () => !!tabDef().model;

  // ── overlay (full-viewport, mounted on <body> so it isn't confined to the
  // narrow panel sidebar) ────────────────────────────────────────────────────
  const overlay = el("div", "cmcp-cv-overlay");
  const modal = el("div", "cmcp-modal cmcp-civitai-modal");
  // Self-invalidating handle: isOpen flips false on the FIRST close() and every
  // drive method asserts it, so a stale reference held past close throws instead
  // of poking a detached grid. onClose lets the host compare-and-null its stored
  // handle. close() is idempotent and tears down EVERY async/listener owned here.
  let isOpen = true;
  let _onDockResize = null;   // window-resize fallback when ctx.watchDock is absent
  let _dockDispose = null;    // ResizeObserver+listener disposer from ctx.watchDock
  let _oauthPollIv = null;    // sign-in completion poll (accountFlow)
  let _onEscape = null;       // document Escape → close
  let _activeLightboxClose = null; // openViewer's teardown (owns its own doc keydown listener)
  const close = () => {
    if (!isOpen) return;      // idempotent
    isOpen = false;
    state.reqId++;            // invalidate any in-flight fetch (its guarded finally no-ops)
    state.activeReloadPromise = null;
    state.activeLoadPromise = null;
    try { clearTimeout(searchTimer); } catch { /* not armed */ }
    if (_oauthPollIv) { clearInterval(_oauthPollIv); _oauthPollIv = null; }
    // The lightbox is body-mounted with its OWN document keydown listener — a
    // programmatic reopen would otherwise strand it (+ its listener) above the
    // new modal (codex finding). Tear it down through this one path.
    if (_activeLightboxClose) { try { _activeLightboxClose(); } catch { /* already gone */ } _activeLightboxClose = null; }
    try { closeSubModals(); } catch { /* already gone */ }
    if (_onEscape) { document.removeEventListener("keydown", _onEscape); _onEscape = null; }
    if (_onDockResize) { window.removeEventListener("resize", _onDockResize); _onDockResize = null; }
    if (_dockDispose) { try { _dockDispose(); } catch { /* best effort */ } _dockDispose = null; }
    // Slide/fade the card out, THEN detach (parity with the Training + RunPod
    // side-panels). isOpen already flipped above, so drive methods + re-close are
    // inert during the ~240ms exit; host bookkeeping (onClose) still runs now.
    slideOutThenRemove(overlay);
    try { opts.onClose?.(); } catch { /* host bookkeeping only */ }
  };
  // In docked mode the overlay itself is click-through (pointer-events:none), so a
  // backdrop mousedown never fires here — the header ✕ / Escape are the dismissals.
  // Centered mode keeps the backdrop-click-to-close affordance.
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  // Base modals had no Escape handler (audit item 9): add one that funnels through
  // close(), but yield to a stacked lightbox / sub-modal so Escape peels the top.
  _onEscape = (e) => {
    if (e.key !== "Escape") return;
    if (_subModals.size > 0) return;
    if (document.querySelector(".cmcp-cv-lb")) return;
    e.stopPropagation();
    close();
  };
  document.addEventListener("keydown", _onEscape);

  // header
  const head = el("div", "cmcp-cv-head");
  const tabsWrap = el("div", "cmcp-cv-tabs");
  // Search lives in the SUBNAV under the tabs (every tab gets it) — debounced
  // 500ms; while the debounced search request is in flight the grid sits under
  // a blur overlay with a spinner. Favorites search filters client-side (the
  // tRPC favorites feed has no text query), everything else hits Meili/REST.
  const search = el("input", "cmcp-cv-search");
  search.placeholder = "Search CivitAI…";
  search.value = state.query;
  let searchTimer = null;
  // The @token displayed in the search box ALWAYS owns the creator filter:
  // setCreator mirrors every creator change (sheet picker, pill ✕, reset,
  // "See more from") into the box as an @token, so deleting that token must
  // clear the filter no matter where it came from — ownership is "the token
  // is displayed", not "who typed it" (codex round-3: a sheet-picked creator's
  // mirrored token previously didn't own the filter, making deletion
  // history-dependent). setCreator is the ONE mutation point outside
  // applySearch.
  let creatorFromSearch = false;
  function setCreator(name) {
    const f = state.filters;
    f.username = name ? String(name) : null;
    creatorFromSearch = !!name; // displayed token == owned token, always
    // Rewrite only the qualifier part of the box; keep the user's terms.
    const { query } = parseCreatorQuery(search.value);
    search.value = f.username ? `@${f.username}${query ? " " + query : " "}` : query;
  }
  const applySearch = () => {
    const { creator, query } = parseCreatorQuery(search.value);
    const f = state.filters;
    let changed = query !== state.query;
    if (creator) {
      if (f.username !== creator) { f.username = creator; changed = true; }
      creatorFromSearch = true;
    } else if (creatorFromSearch && f.username) {
      f.username = null;
      creatorFromSearch = false;
      changed = true;
    }
    if (!changed) return;
    state.query = query;
    syncTabs();
    reload({ searching: true });
  };
  // Finding: a pre-seeded opts.query may carry an @qualifier (the agent's
  // open_civitai can pass one) — reconcile it into the filter BEFORE the
  // first reload instead of searching for the literal token.
  {
    const seeded = parseCreatorQuery(state.query);
    if (seeded.creator) {
      state.filters.username = seeded.creator;
      creatorFromSearch = true;
      state.query = seeded.query;
    }
  }
  /** "See more from @creator" — set the creator filter and reflect it in the
   *  search box as an @token (the box is the source of truth for it). The
   *  favorites tab has no creator param, so it jumps to Images. */
  function seeMoreFromCreator(name, { toModelTab = false } = {}) {
    if (!name) return;
    state.query = "";
    search.value = "";
    setCreator(name);
    if (tabDef().fav) state.tab = toModelTab ? state.tab : "images";
    syncTabs();
    reload({ searching: true });
  }
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 500);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(searchTimer); applySearch(); }
  });
  const filterBtn = el("button", "cmcp-cv-iconbtn");
  // First of the three right-side actions (filters ⚙ / account 👤 / close ✕):
  // margin-left:auto pushes this trio to the right edge while the tab row stays
  // left-aligned in the flex header.
  filterBtn.style.marginLeft = "auto";
  filterBtn.innerHTML = '<i class="pi pi-sliders-h"></i>';
  const filterDot = el("span", "cmcp-cv-dot"); filterDot.style.display = "none";
  filterBtn.appendChild(filterDot);
  filterBtn.addEventListener("click", () => toggleFilters());
  const acctBtn = el("button", "cmcp-cv-iconbtn");
  acctBtn.innerHTML = '<i class="pi pi-user"></i>';
  acctBtn.title = "CivitAI account";
  acctBtn.addEventListener("click", () => accountFlow());
  const closeBtn = el("button", "cmcp-cv-iconbtn");
  closeBtn.innerHTML = '<i class="pi pi-times"></i>';
  closeBtn.addEventListener("click", close);

  for (const t of TABS) {
    const b = el("button", "cmcp-cv-tab");
    b.innerHTML = `<i class="pi ${t.icon}"></i><span>${t.label}</span>`;
    b.addEventListener("click", () => { state.tab = t.key; syncTabs(); reload(); });
    b._key = t.key;
    tabsWrap.appendChild(b);
  }
  head.append(tabsWrap, filterBtn, acctBtn, closeBtn);

  // subnav: search (all tabs) + favorites media-type chips
  const subnav = el("div", "cmcp-cv-subnav");
  const favChips = el("div", "cmcp-cv-frow");
  for (const [label, val] of [["All", "all"], ["Images", "image"], ["Videos", "video"]]) {
    const chip = el("button", "cmcp-cv-chip", label);
    chip._fv = val;
    chip.addEventListener("click", () => {
      if (state.favType === val) return;
      state.favType = val;
      syncTabs();
      reload();
    });
    favChips.appendChild(chip);
  }
  subnav.append(search, favChips);

  // body
  const body = el("div", "cmcp-cv-body");
  const progress = el("div", "cmcp-cv-progress");
  const grid = el("div", "cmcp-cv-grid");
  const sentinel = el("div", "cmcp-cv-loading");
  body.append(progress, grid, sentinel);
  body.addEventListener("scroll", () => {
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 600) loadMore();
  });

  const searchOverlay = el("div", "cmcp-cv-searching");
  searchOverlay.appendChild(el("div", "cmcp-cv-spinner"));
  searchOverlay.style.display = "none";
  body.appendChild(searchOverlay);

  modal.append(head, subnav, body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // ── docked mode (agent-driven) ─────────────────────────────────────────────
  // Dock into the canvas area OPPOSITE the Agent pane (which may be docked left
  // OR right) so chat stays visible + interactive. Geometry comes from the host
  // (ctx.dockGeometry: it owns the ComfyUI pane/canvas measurement and the
  // left/right detection), so this module stays ComfyUI-agnostic. Three states:
  //  - detached  → the Agent tab was switched away; the body-mounted modal is
  //    orphaned, so HIDE it (don't float centered over an unrelated screen).
  //  - centered  → no eligible anchor (missing/zero-size/too-small/narrow window)
  //  - docked    → anchored rect from the host.
  applyDock.centered = false;
  function applyDock() {
    if (!opts.dock) { setCentered(); return; }
    const geo = _dockGeometry();
    if (geo?.status === "detached") {
      overlay.style.display = "none";
      return;
    }
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
  /** Host geometry, with a self-contained fallback (single-pane / no host help /
   *  tests): measure ctx.root's pane and dock to the wider viewport side. */
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
  if (opts.dock) {
    applyDock();
    // Watch pane + canvas (splitter drags don't fire window-resize) via the host;
    // fall back to a bare window-resize listener when the host can't help.
    if (typeof ctx.watchDock === "function") {
      try { _dockDispose = ctx.watchDock(applyDock); } catch { _dockDispose = null; }
    }
    if (!_dockDispose) { _onDockResize = () => applyDock(); window.addEventListener("resize", _onDockResize); }
    // Slide-in on the next frame so the transition runs from the initial state.
    requestAnimationFrame(() => overlay.classList.add("cmcp-dock-in"));
  }

  function syncTabs() {
    for (const b of tabsWrap.children) b.classList.toggle("active", b._key === state.tab);
    favChips.style.display = tabDef().fav ? "" : "none";
    for (const c of favChips.children) c.classList.toggle("on", c._fv === state.favType);
    filterDot.style.display = filtersDirty(state.filters) ? "" : "none";
  }

  // ── data ───────────────────────────────────────────────────────────────
  function setLoading(on) { state.loading = on; progress.classList.toggle("on", on); }

  // Public reload: stores the in-flight promise so drive methods can await the
  // first page settling, and returns it.
  function reload(opts2 = {}) {
    const p = _reload(opts2);
    state.activeReloadPromise = p;
    return p;
  }
  async function _reload({ searching = false } = {}) {
    // Invalidate any page load already IN FLIGHT: its response belongs to the
    // OLD tab/query/filters and must not repopulate the just-cleared grid (nor
    // leave its cursor behind). The stale request's guarded `finally` won't
    // clear the loading flag anymore, so reset it here too.
    state.reqId++;
    // New render generation: any highlight awaiting the previous load is now
    // stale, and the target set is cleared so it can't re-apply to fresh cards.
    state.renderRev++;
    state.highlightSet = new Set();
    state.highlightOrder = [];
    setLoading(false);
    state.items = []; state.models = []; state.cursor = null; state.done = false;
    grid.innerHTML = ""; syncTabs();
    // Overlay ownership: only the NEWEST reload may hide the searching
    // spinner — a superseded reload's finally must not kill the overlay of
    // the search that replaced it (same generation pattern as the grid).
    const mySearch = ++state.searchSeq;
    if (searching) searchOverlay.style.display = "";
    try {
      await loadMore();
    } finally {
      if (mySearch === state.searchSeq) searchOverlay.style.display = "none";
    }
  }

  function loadMore() {
    const p = _loadMore();
    state.activeLoadPromise = p;
    return p;
  }
  async function _loadMore() {
    if (state.loading || state.done) return;
    const req = ++state.reqId;
    setLoading(true);
    sentinel.textContent = "Loading…";
    // keyword × creator on model tabs matches client-side (API quirk — see
    // fetchModels): even after its bounded page-chase a load can come back
    // empty with more pages left. That must not dead-end the list — the
    // scroll sentinel only re-fires when the grid grows.
    let stalled = false;
    try {
      const f = state.filters;
      const levels = f.browsingLevels;
      const t = tabDef();
      if (t.fav) {
        if (!state.signedIn) { sentinel.textContent = "Sign in to see your favorites."; setLoading(false); return; }
        // The favorites feed is still browsing-level gated by the ACTIVE filter:
        // fetchFavorites defaults to ALL levels, so an agent-driven session that
        // clamped the levels (no NSFW consent) would otherwise leak R/X/XXX here
        // (security: codex finding). Pass the same clamped set as every other
        // feed. The subnav chips narrow by type; the feed reads the likes
        // COLLECTION (auto-detected) — reactions only hold in-app hearts; see
        // resolveLikesCollectionId.
        const colId = await resolveLikesCollectionId(client);
        if (req !== state.reqId) return;
        const page = await client.fetchFavorites({
          cursor: state.cursor,
          levels,
          ...(colId ? { collectionId: colId } : {}),
          ...(state.favType !== "all" ? { types: [state.favType] } : {}),
        });
        if (req !== state.reqId) return;
        state.cursor = page.nextCursor; state.done = !page.nextCursor;
        // Dedup on id: the feed pages by "last item id" (see the client's
        // cursor quirk) — if CivitAI ever flips its keyset comparison to
        // inclusive, the boundary item would come back twice.
        // The favorites feed has no text query — search filters client-side.
        const seen = new Set(state.items.map((i) => i.id));
        const q = state.query.toLowerCase();
        const fresh = page.items.filter((it) => !seen.has(it.id) &&
          (!q || (it.prompt || "").toLowerCase().includes(q) ||
            (it.author || "").toLowerCase().includes(q)));
        appendItems(fresh);
        stalled = !fresh.length && !state.done && !!q;
      } else if (t.model) {
        if (!state.localLoaded) await refreshLocalModels(); // for "in library" marks
        const page = await client.fetchModels({
          type: t.model, sort: f.modelSort, period: f.period,
          baseModels: f.baseModels, levels, cursor: state.cursor,
          ...(state.query ? { query: state.query } : {}),
          ...(f.username ? { username: f.username } : {}),
        });
        if (req !== state.reqId) return;
        state.cursor = page.nextCursor; state.done = !page.nextCursor;
        appendModels(page.models);
        stalled = !page.models.length && !state.done;
      } else if (state.query) {
        const items = await client.searchMedia(state.query, {
          type: t.media, levels, offset: state.items.length,
          ...(f.username ? { username: f.username } : {}),
        });
        if (req !== state.reqId) return;
        state.done = items.length === 0;
        appendItems(items);
      } else {
        const page = await client.fetchFeed({
          type: t.media, period: f.period, sort: f.imageSort, levels, cursor: state.cursor,
          ...(f.username ? { username: f.username } : {}),
        });
        if (req !== state.reqId) return;
        state.cursor = page.nextCursor; state.done = !page.nextCursor;
        appendItems(page.items);
      }
      if (stalled) {
        // Explicit affordance instead of a silent dead end.
        sentinel.textContent = "";
        const more = el("button", "cmcp-btn", "No matches yet — keep searching");
        more.addEventListener("click", () => loadMore());
        sentinel.appendChild(more);
      } else if (state.done && !grid.children.length) {
        sentinel.textContent = "No results.";
      } else {
        sentinel.textContent = "";
        // Under-filled top-up (every tab): a page that doesn't overflow the
        // body leaves the scroll sentinel unreachable — no scroll event can
        // ever fire the next page, so the list silently dead-ends after one
        // short load. Chase the next page until the body can scroll (or the
        // feed is exhausted / a stall affordance takes over).
        if (!state.done && req === state.reqId &&
            body.scrollHeight <= body.clientHeight + 40) {
          setTimeout(() => { if (req === state.reqId) loadMore(); }, 0);
        }
      }
    } catch (e) {
      if (req === state.reqId) sentinel.textContent = "CivitAI error: " + (e.message || e);
    } finally {
      if (req === state.reqId) setLoading(false);
    }
  }

  // Re-apply the agent's highlight to a freshly-appended card: a highlight can
  // target an id that only lands on a LATER page (scroll), so the glow must be
  // (re)applied as cards stream in — not just at the moment highlight() ran.
  function _applyGlowIfTargeted(card, id) {
    if (state.highlightSet.has(String(id))) card.classList.add("cmcp-agent-glow");
  }
  function appendItems(items) {
    for (const it of items) {
      if (tabDef().fav && !_liked.has(it.id)) _liked.set(it.id, true);
      state.items.push(it);
      const idx = state.items.length - 1;
      const card = mediaCard(it, idx);
      _applyGlowIfTargeted(card, it.id);
      grid.appendChild(card);
    }
  }
  function appendModels(models) {
    for (const m of models) {
      state.models.push(m);
      const card = modelCard(m);
      _applyGlowIfTargeted(card, m.id);
      grid.appendChild(card);
    }
  }

  // ── cards ─────────────────────────────────────────────────────────────
  function mediaCard(it, idx) {
    const card = el("div", "cmcp-cv-card");
    card.dataset.id = String(it.id);
    card.dataset.kind = "media";
    // Both image and video cards show a still (video thumbnailUrl is a jpeg
    // poster); hover on a video swaps in the muted transcoded clip.
    const img = document.createElement("img");
    img.loading = "lazy"; img.src = it.thumbnailUrl;
    img.addEventListener("error", () => { card.style.display = "none"; });
    card.appendChild(img);
    if (it.type === "video") {
      card.appendChild(el("span", "cmcp-cv-badge", "▶"));
      let vid = null;
      card.addEventListener("mouseenter", () => {
        if (vid) return;
        vid = document.createElement("video");
        vid.src = it.fullUrl; vid.muted = true; vid.loop = true; vid.playsInline = true;
        vid.autoplay = true;
        card.appendChild(vid);
        vid.play().catch(() => {});
      });
      card.addEventListener("mouseleave", () => { if (vid) { vid.remove(); vid = null; } });
    }
    const foot = el("div", "cmcp-cv-cardfoot", `${it.author ? "@" + it.author : ""}  ♥ ${it.reactions || 0}`);
    card.appendChild(foot);
    {
      // Hover like — no need to open the lightbox to react. Shares _liked with
      // the lightbox heart; stays visible while lit so likes are scannable.
      // Signed out? The heart doubles as a sign-in button.
      const likeBtn = el("button", "cmcp-cv-cardlike");
      const paintLike = () => {
        const on = _liked.get(it.id) === true;
        likeBtn.classList.toggle("on", on);
        likeBtn.innerHTML = `<i class="pi ${on ? "pi-heart-fill" : "pi-heart"}"></i>`;
        likeBtn.title = !state.signedIn ? "Sign in to CivitAI to like" : on ? "Unlike on CivitAI" : "Like on CivitAI";
      };
      paintLike();
      card.addEventListener("mouseenter", paintLike); // resync after lightbox toggles
      likeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!state.signedIn) { toast("Sign in to CivitAI to like — opening sign-in…"); accountFlow(); return; }
        void toggleLike(it, paintLike);
      });
      card.appendChild(likeBtn);
    }
    card.addEventListener("click", () => openViewer(idx));
    return card;
  }

  function modelCard(m) {
    const card = el("div", "cmcp-cv-card");
    card.dataset.id = String(m.id);
    card.dataset.kind = "model";
    const img = document.createElement("img");
    img.loading = "lazy"; img.src = m.coverUrl;
    img.addEventListener("error", () => { card.style.display = "none"; });
    card.append(img, el("span", "cmcp-cv-badge", m.type));
    if (owned(m.fileName)) card.appendChild(el("span", "cmcp-cv-owned", "✓ In library"));
    const foot = el("div", "cmcp-cv-cardfoot", `${m.name}\n${m.baseModel || ""} · ⬇ ${m.downloadCount ?? "?"}`);
    foot.style.whiteSpace = "pre-line";
    card.appendChild(foot);
    card.addEventListener("click", () => openModelDetail(m));
    return card;
  }

  // ── viewer: full-screen LIGHTBOX — media on the left, details on the right.
  // Mounted on <body> (above the browser modal) so it truly fills the screen.
  // Generation info loads asynchronously into the side pane and is cached per
  // item, so paging through the feed doesn't refetch.
  const _genCache = new Map();
  // Liked-state per image id, session-scoped. The feed payloads don't carry the
  // viewer's own reactions, so this starts from what we know (everything on the
  // Favorites tab IS liked) and tracks toggles optimistically from there.
  const _liked = new Map();

  /** Toggle a like (optimistic, with revert), then mirror it into the default
   *  likes collection when one is picked. A 403 means the stored token predates
   *  the current OAuth scopes -- tell the user to re-sign-in instead of failing
   *  mutely. */
  async function toggleLike(it, paint) {
    const next = !(_liked.get(it.id) === true);
    _liked.set(it.id, next); paint();
    try {
      await client.toggleReaction(it.id);
    } catch (e) {
      _liked.set(it.id, !next); paint();
      const msg = String(e.message || e);
      toast(msg.includes("403")
        ? "CivitAI permissions changed -- use the account button to sign out and back in."
        : "Like failed: " + msg);
      return;
    }
    const col = likesCollection();
    if (col?.id) {
      client.setImageInCollection(it.id, col.id, next).catch((e) =>
        toast(`Couldn't update collection "${col.name}": ` + (e.message || e)));
    }
  }

  function openViewer(startIdx) {
    // At-most-one lightbox: tear down any prior one (and its document keydown
    // listener) before opening a new one, so a second open without an
    // intervening close can't strand the older listener (codex finding).
    if (_activeLightboxClose) { try { _activeLightboxClose(); } catch { /* already gone */ } _activeLightboxClose = null; }
    let idx = startIdx;
    let renderSeq = 0;
    const lb = el("div", "cmcp-cv-lb");
    lb.tabIndex = -1; // focusable → receives key events
    const stage = el("div", "cmcp-cv-lb-stage");
    const side = el("div", "cmcp-cv-lb-side");
    const mk = (icon, fn, title) => {
      const b = el("button", "cmcp-cv-iconbtn"); b.innerHTML = `<i class="pi ${icon}"></i>`;
      if (title) b.title = title; b.addEventListener("click", fn); return b;
    };
    const closeLb = () => {
      lb.remove();
      document.removeEventListener("keydown", onKey, true);
      if (_activeLightboxClose === closeLb) _activeLightboxClose = null;
    };
    // Track the live lightbox so the modal's unified close() can dismiss it (and
    // remove its listener) on a programmatic reopen (codex finding).
    _activeLightboxClose = closeLb;
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeLb(); }
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.stopPropagation(); step(1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.stopPropagation(); step(-1); }
    };
    const prevBtn = el("button", "cmcp-cv-lb-nav", "‹"); prevBtn.style.left = ".6rem";
    const nextBtn = el("button", "cmcp-cv-lb-nav", "›"); nextBtn.style.right = ".6rem";
    prevBtn.addEventListener("click", () => step(-1));
    nextBtn.addEventListener("click", () => step(1));
    const closeBtn2 = mk("pi-times", closeLb, "Close (Esc)");
    closeBtn2.classList.add("cmcp-cv-lb-close");

    async function genFor(it) {
      if (_genCache.has(it.id)) return _genCache.get(it.id);
      const gen = await client.getGenerationData(it.id);
      _genCache.set(it.id, gen);
      return gen;
    }

    const render = () => {
      const seq = ++renderSeq;
      const it = state.items[idx];
      if (!it) return;
      // left: the media itself
      stage.innerHTML = "";
      if (it.type === "video") {
        const vid = document.createElement("video");
        vid.src = it.fullUrl; vid.controls = true; vid.autoplay = true; vid.loop = true;
        vid.playsInline = true;
        stage.appendChild(vid);
      } else {
        const img = document.createElement("img"); img.src = it.fullUrl; stage.appendChild(img);
      }
      stage.append(prevBtn, nextBtn, closeBtn2);
      prevBtn.style.display = idx <= 0 ? "none" : "";

      // right: identity + actions immediately, generation info when it arrives
      side.innerHTML = "";
      const titleRow = el("div", "cmcp-cv-lb-title");
      titleRow.appendChild(el("span", null,
        `${it.type === "video" ? "🎬" : "🖼"} ${it.author ? "@" + it.author : "CivitAI " + it.type}`));
      {
        // Like toggle — the same tRPC mutation the CivitAI site fires
        // (reaction.toggle; calling it again un-likes). Optimistic flip,
        // reverted with a toast on failure. Favorites-tab items start lit;
        // signed out, the heart doubles as a sign-in button.
        if (!_liked.has(it.id) && tabDef().fav) _liked.set(it.id, true);
        const likeBtn = el("button", "cmcp-cv-iconbtn cmcp-cv-like");
        const paintLike = () => {
          const on = _liked.get(it.id) === true;
          likeBtn.classList.toggle("on", on);
          likeBtn.innerHTML = `<i class="pi ${on ? "pi-heart-fill" : "pi-heart"}"></i>`;
          likeBtn.title = !state.signedIn ? "Sign in to CivitAI to like" : on ? "Unlike on CivitAI" : "Like on CivitAI";
        };
        paintLike();
        likeBtn.addEventListener("click", () => {
          if (!state.signedIn) { toast("Sign in to CivitAI to like — opening sign-in…"); accountFlow(); return; }
          void toggleLike(it, paintLike);
        });
        titleRow.appendChild(likeBtn);
      }
      side.appendChild(titleRow);
      side.appendChild(el("div", "cmcp-cv-lb-muted",
        `♥ ${it.reactions || 0} · ${idx + 1} / ${state.items.length}${state.done ? "" : "+"}`));

      const actions = el("div", "cmcp-cv-actions");
      if (it.author) {
        const moreBtn = el("button", "cmcp-btn", `See more from @${it.author}`);
        moreBtn.addEventListener("click", () => {
          closeLb();
          seeMoreFromCreator(it.author);
        });
        actions.appendChild(moreBtn);
      }
      side.appendChild(actions);
      const genBox = el("div");
      genBox.appendChild(el("div", "cmcp-cv-lb-muted", "Loading generation info…"));
      side.appendChild(genBox);

      genFor(it).then((gen) => {
        if (seq !== renderSeq) return; // user already paged on
        // actions need the gen payload (caption/workflow), so they land here
        const shareBtn = el("button", "cmcp-btn cmcp-btn-primary",
          ctx.isMuted() ? "Save reference to inputs" : "Share with agent");
        shareBtn.addEventListener("click", () => shareImage(it, gen));
        actions.appendChild(shareBtn);
        const wf = CivitaiClient.comfyGraphInfo(gen.meta);
        if (wf) {
          if (wf.format === "ui") {
            const loadBtn = el("button", "cmcp-btn", "Load onto canvas");
            loadBtn.title = "Replace the current canvas with this post's embedded ComfyUI workflow (Ctrl+Z undoes it).";
            loadBtn.addEventListener("click", () => { void loadOntoCanvas(wf.graph, closeLb); });
            actions.appendChild(loadBtn);
          }
          const saveBtn = el("button", "cmcp-btn", "Save workflow");
          saveBtn.addEventListener("click", () => saveWorkflow(it, wf.graph));
          actions.appendChild(saveBtn);
        }
        genBox.innerHTML = "";
        genBox.appendChild(el("div", "cmcp-cv-lb-muted",
          !wf ? "No embedded workflow"
          : wf.format === "ui" ? "✓ Embedded ComfyUI workflow"
          : "Embedded graph is API-format only — it can't load onto the canvas, but Save keeps its JSON."));
        if (gen.meta?.prompt) {
          genBox.appendChild(el("div", "cmcp-cv-flabel", "Prompt"));
          genBox.appendChild(el("div", "cmcp-cv-lb-prompt", gen.meta.prompt));
        }
        if (gen.meta?.negativePrompt) {
          genBox.appendChild(el("div", "cmcp-cv-flabel", "Negative"));
          genBox.appendChild(el("div", "cmcp-cv-lb-prompt", gen.meta.negativePrompt));
        }
        const params = CivitaiClient.params(gen.meta);
        if (params.length) {
          genBox.appendChild(el("div", "cmcp-cv-flabel", "Parameters"));
          const grid2 = el("div", "cmcp-cv-lb-params");
          for (const [k, val] of params) {
            grid2.appendChild(el("span", "k", k));
            grid2.appendChild(el("span", null, String(val)));
          }
          genBox.appendChild(grid2);
        }
      }).catch((e) => {
        if (seq !== renderSeq) return;
        genBox.innerHTML = "";
        genBox.appendChild(el("div", "cmcp-cv-lb-muted", "No generation data: " + (e.message || e)));
        // sharing works without gen data — caption just has no settings
        const shareBtn = el("button", "cmcp-btn cmcp-btn-primary",
          ctx.isMuted() ? "Save reference to inputs" : "Share with agent");
        shareBtn.addEventListener("click", () => shareImage(it, { meta: {} }));
        actions.appendChild(shareBtn);
      });
    };
    const step = (d) => {
      idx = Math.max(0, Math.min(state.items.length - 1, idx + d));
      if (idx >= state.items.length - 3) loadMore().then(() => {
        // arriving items extend the counter — refresh it without a full rerender
        if (state.items[idx]) render();
      });
      render();
    };
    stage.addEventListener("wheel", (e) => { step(e.deltaY > 0 ? 1 : -1); }, { passive: true });
    stage.addEventListener("mousedown", (e) => { if (e.target === stage) closeLb(); });
    document.addEventListener("keydown", onKey, true);
    lb.append(stage, side);
    document.body.appendChild(lb);
    lb.focus();
    render();
    // Opened ON one of the last items: step() hasn't run yet, so without this
    // the viewer dead-ends until the first navigation (mobile-parity fix).
    if (startIdx >= state.items.length - 3) {
      loadMore().then(() => { if (state.items[idx]) render(); });
    }
  }

  // ── generation info + share/save (mute-aware) ────────────────────────
  async function showGenInfo(it) {
    const sheet = openSubModal("Generation info");
    sheet.body.appendChild(el("div", "cmcp-cv-loading", "Loading…"));
    let gen;
    try { gen = await client.getGenerationData(it.id); }
    catch (e) { sheet.body.innerHTML = ""; sheet.body.appendChild(el("div", null, "No data: " + e.message)); return; }
    sheet.body.innerHTML = "";
    const wf = CivitaiClient.comfyGraphInfo(gen.meta);
    sheet.body.appendChild(el("div", null,
      !wf ? "No embedded workflow"
      : wf.format === "ui" ? "✓ Embedded ComfyUI workflow"
      : "Embedded graph is API-format only — it can't load onto the canvas, but Save keeps its JSON."));

    const actions = el("div", "cmcp-cv-actions");
    const shareBtn = el("button", "cmcp-btn cmcp-btn-primary",
      ctx.isMuted() ? "Save reference to inputs" : "Share with agent");
    shareBtn.addEventListener("click", () => shareImage(it, gen));
    actions.appendChild(shareBtn);
    if (wf) {
      if (wf.format === "ui") {
        const loadBtn = el("button", "cmcp-btn", "Load onto canvas");
        loadBtn.title = "Replace the current canvas with this example's embedded ComfyUI workflow (Ctrl+Z undoes it).";
        loadBtn.addEventListener("click", () => { void loadOntoCanvas(wf.graph); });
        actions.appendChild(loadBtn);
      }
      const saveBtn = el("button", "cmcp-btn", "Save workflow");
      saveBtn.addEventListener("click", () => saveWorkflow(it, wf.graph));
      actions.appendChild(saveBtn);
    }
    sheet.body.appendChild(actions);

    for (const [k, val] of CivitaiClient.params(gen.meta)) {
      const row = el("div"); row.style.cssText = "font-size:.78rem;margin-top:.2rem";
      row.textContent = `${k}: ${val}`;
      sheet.body.appendChild(row);
    }
    if (gen.meta?.prompt) {
      const p = el("div"); p.style.cssText = "font-size:.78rem;margin-top:.5rem;white-space:pre-wrap";
      p.textContent = "Prompt: " + gen.meta.prompt; sheet.body.appendChild(p);
    }
  }

  function buildCaption(gen) {
    const m = gen.meta || {};
    const lines = [
      "Recreate this CivitAI example as closely as you can — match the reference and use these settings (use our local model if we have it, else download it first):",
      "",
    ];
    if (m.prompt) lines.push("Prompt: " + m.prompt);
    if (m.negativePrompt) lines.push("Negative: " + m.negativePrompt);
    for (const [k, v] of CivitaiClient.params(m)) lines.push(`${k}: ${v}`);
    return lines.join("\n");
  }

  async function shareImage(it, gen) {
    try {
      const blob = await (await fetch(it.fullUrl)).blob();
      const name = `civitai_ref_${it.id}.${it.type === "video" ? "mp4" : "jpeg"}`;
      const ref = await ctx.uploadBlobToInput(blob, name);
      if (ctx.isMuted()) {
        toast(`Saved ${name} to ComfyUI inputs.`);
      } else {
        const caption = buildCaption(gen);
        ctx.sendUserMessage(
          `${caption}\n\nThe reference is uploaded to the ComfyUI input/ folder as \`${ref.filename}\` — use it as the target to match.`,
          undefined, [ref],
        );
        ctx.bringChatForward();
        toast("Shared with the agent.");
      }
      // Hand-off is done (either variant) — close the explorer so the chat/agent
      // is visible. Only on SUCCESS; a failed share (below) leaves it open to
      // retry. The toast is body-mounted (survives the close) so the confirmation
      // stays on screen. close() is idempotent + tears down the lightbox/sheets.
      close();
    } catch (e) { toast("Share failed: " + e.message); }
  }

  async function saveWorkflow(it, graph) {
    try {
      const res = await ctx.callTool("save_workflow",
        { filename: `civitai_${it.id}.json`, workflow: graph }, { timeout: 60000 });
      toast(res.ok ? "Workflow saved to your machine." : "Save failed: " + (res.error || "?"));
    } catch (e) { toast("Save failed: " + e.message); }
  }

  // ── load a UI-format workflow onto the live canvas ───────────────────
  /** Confirm-if-dirty (fail-closed — see graphDirtyForConfirm), then load via
   *  the bridge's undoable graph_load path (snapshot → await loadGraphData →
   *  checkState — one load = one Ctrl+Z step). Success is only announced —
   *  and the explorer only closed — after the awaited load actually landed;
   *  `beforeClose` runs first (e.g. the lightbox, which isn't a sub-modal).
   *  Returns true when it loaded. */
  async function loadOntoCanvas(graph, beforeClose) {
    if (typeof ctx.loadGraph !== "function") {
      toast("This panel build can't load onto the canvas.");
      return false;
    }
    if (graphDirtyForConfirm(ctx) && !window.confirm(
      "Load this workflow onto the canvas?\n\n" +
      "Your current workflow has unsaved changes that will be replaced (Ctrl+Z undoes the load).",
    )) return false;
    let res;
    try {
      res = await ctx.loadGraph(graph);
    } catch (e) {
      toast("Couldn't load workflow: " + (e.message || e));
      return false;
    }
    // Defend against a silent no-op: if the load reported zero nodes the graph
    // didn't actually land — don't dismiss the explorer as if it succeeded.
    if (!res || !res.node_count) {
      toast("The workflow loaded empty (0 nodes) — nothing was placed on the canvas.");
      return false;
    }
    if (beforeClose) { try { beforeClose(); } catch { /* already gone */ } }
    closeSubModals();
    close();
    toast(`Workflow loaded onto the canvas — ${res.node_count} node${res.node_count === 1 ? "" : "s"}. Ctrl+Z undoes it.`);
    return true;
  }

  /** Download a model-version workflow file (raw .json or civitai's zip
   *  wrapper), extract the UI-format graph(s), and load onto the canvas —
   *  with a picker when an archive holds several. Reports progress and EVERY
   *  failure through `opts.setStatus` (an inline line in the detail sheet) as
   *  well as a toast, and NEVER closes the sheet on failure — only a genuine
   *  canvas load (via loadOntoCanvas) dismisses the explorer. */
  async function loadVersionWorkflow(version, file, opts = {}) {
    const setStatus = opts.setStatus || (() => {});
    const say = (msg, kind = "err") => { setStatus(msg, kind); toast(msg); };
    setStatus("Fetching workflow…", "info");
    let bytes;
    try {
      bytes = await client.downloadVersionFile(version.id, file);
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        // Some workflow files are gated (the proxy returns 401 when civitai
        // redirects the download to /login). The account button is the way in;
        // offer it right here so the hint is actionable, not just informative.
        say(state.signedIn
          ? "CivitAI refused this download — this file may need early access or a purchase. Try the account (👤) button to re-check your sign-in."
          : "This workflow is gated — sign in to CivitAI (the account 👤 button) to download it, then try again.", "warn");
        if (!state.signedIn && opts.signIn) {
          setStatus("This workflow is gated — opening CivitAI sign-in…", "warn");
          try { opts.signIn(); } catch { /* account flow unavailable */ }
        }
      } else {
        say("Download failed: " + (e.message || e));
      }
      return;
    }
    let candidates;
    try {
      if (/\.zip$/i.test(file.name || "")) {
        candidates = await CivitaiClient.workflowsFromZip(bytes);
      } else {
        const graph = JSON.parse(new TextDecoder().decode(bytes));
        const format = CivitaiClient.workflowFormat(graph);
        candidates = format === "unknown" ? [] : [{ name: file.name, graph, format }];
      }
    } catch (e) {
      // A gated file can slip through as an HTML page the proxy couldn't tag;
      // "not a zip" then really means "we got a login page, not the file".
      const notZip = /not a zip/i.test(String(e.message || e));
      say(notZip
        ? "Couldn't read the download — CivitAI may require sign-in for this file (account 👤 button)."
        : "Couldn't read the workflow file: " + (e.message || e), notZip ? "warn" : "err");
      return;
    }
    const uis = candidates.filter((c) => c.format === "ui");
    if (!uis.length) {
      say(candidates.length
        ? "This file only holds an API-format graph — it can't load as an editable canvas workflow. Ask the agent to run it instead."
        : "No ComfyUI workflow found in that file.", "warn");
      return;
    }
    setStatus("", "info"); // clear before a successful load closes the explorer
    if (uis.length === 1) { await loadOntoCanvas(uis[0].graph); return; }
    // several workflows in one archive — let the user pick
    const picker = openSubModal("Pick a workflow to load");
    const list = el("div", "cmcp-cv-creators");
    list.style.maxHeight = "24rem";
    for (const c of uis) {
      const b = el("button", "cmcp-cv-creator");
      b.appendChild(el("span", null, c.name));
      b.appendChild(el("span", "sub", `${c.graph.nodes.length} nodes`));
      b.addEventListener("click", () => { void loadOntoCanvas(c.graph); });
      list.appendChild(b);
    }
    picker.body.appendChild(list);
  }

  // ── model detail ─────────────────────────────────────────────────────
  async function openModelDetail(m) {
    const sheet = openSubModal(m.name);
    sheet.body.appendChild(el("div", "cmcp-cv-loading", "Loading…"));
    let detail;
    try { detail = await client.fetchModelDetail(m.id, { levels: state.filters.browsingLevels }); }
    catch (e) { sheet.body.innerHTML = ""; sheet.body.appendChild(el("div", null, "Error: " + e.message)); return; }
    sheet.body.innerHTML = "";
    let version = detail.versions[0];

    const versionRow = el("div", "cmcp-cv-frow");
    const renderBody = () => {
      detailBody.innerHTML = "";
      if (version.trainedWords.length) {
        const tw = el("div", "cmcp-cv-triggers");
        for (const w of version.trainedWords) tw.appendChild(el("span", "cmcp-cv-trigger", w));
        detailBody.appendChild(tw);
      }
      const dl = el("div", "cmcp-cv-actions");
      const have = owned(version.fileName);
      const dlBtn = el("button", "cmcp-btn cmcp-btn-primary",
        have ? "✓ In library — re-download"
             : (ctx.isMuted() ? "Download to my machine" : "Ask agent to download"));
      dlBtn.addEventListener("click", () => pickModel(detail, version));
      dl.appendChild(dlBtn);
      // Workflow files (.json, or the zip wrapper civitai puts around Workflows
      // uploads) can load straight onto the canvas — the community ask. An
      // inline status line under the buttons reports progress/errors right in
      // the sheet (a toast alone was easy to miss / hid behind this overlay).
      const wfFiles = CivitaiClient.workflowFiles(version, detail.type);
      const wfStatus = el("div", "cmcp-cv-wfstatus");
      wfStatus.style.display = "none";
      const setStatus = (msg, kind = "info") => {
        if (!msg) { wfStatus.style.display = "none"; wfStatus.textContent = ""; return; }
        wfStatus.style.display = "";
        wfStatus.className = "cmcp-cv-wfstatus " + kind;
        wfStatus.textContent = msg;
      };
      for (const f of wfFiles) {
        const b = el("button", "cmcp-btn",
          wfFiles.length > 1 ? `Load onto canvas — ${f.name}` : "Load workflow onto canvas");
        const size = f.sizeKB != null
          ? (f.sizeKB >= 1024 ? (f.sizeKB / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(f.sizeKB)) + " KB")
          : null;
        b.title = `Download ${f.name}${size ? ` (${size})` : ""} and load it onto the canvas (Ctrl+Z undoes it).`;
        b.addEventListener("click", () => { void loadVersionWorkflow(version, f, { setStatus, signIn: () => accountFlow() }); });
        dl.appendChild(b);
      }
      if (have) {
        const note = el("span", null, "You already have this file locally.");
        note.style.cssText = "font-size:.72rem;color:#4ade80;align-self:center";
        dl.appendChild(note);
      }
      if (detail.creator) {
        const moreBtn = el("button", "cmcp-btn", `See more from @${detail.creator}`);
        moreBtn.addEventListener("click", () => {
          sheet.close();
          seeMoreFromCreator(detail.creator, { toModelTab: true });
        });
        dl.appendChild(moreBtn);
      }
      detailBody.appendChild(dl);
      if (wfFiles.length) detailBody.appendChild(wfStatus);
      if (version.descriptionHtml || detail.descriptionHtml) {
        const desc = el("div", "cmcp-cv-detail");
        desc.style.cssText = "font-size:.78rem;margin-top:.5rem";
        // CivitAI descriptions are HTML — sanitize and render directly.
        desc.innerHTML = ctx.DOMPurify.sanitize(version.descriptionHtml || detail.descriptionHtml || "");
        detailBody.appendChild(desc);
      }
      // official examples
      if (version.examples.length) {
        const carousel = el("div", "cmcp-cv-grid"); carousel.style.marginTop = ".5rem";
        version.examples.slice(0, 12).forEach((ex) => {
          const c = el("div", "cmcp-cv-card");
          const img = document.createElement("img"); img.loading = "lazy"; img.src = ex.thumbnailUrl;
          c.appendChild(img);
          c.addEventListener("click", () => showGenInfo(ex));
          carousel.appendChild(c);
        });
        detailBody.appendChild(el("div", "cmcp-cv-flabel", "Examples"));
        detailBody.appendChild(carousel);
      }
    };
    if (detail.versions.length > 1) {
      detail.versions.forEach((v) => {
        const chip = el("button", "cmcp-cv-chip", v.name || `v${v.id}`);
        chip.addEventListener("click", () => {
          version = v;
          for (const c of versionRow.children) c.classList.toggle("on", c._v === v.id);
          renderBody();
        });
        chip._v = v.id;
        if (v.id === version.id) chip.classList.add("on");
        versionRow.appendChild(chip);
      });
      sheet.body.appendChild(versionRow);
    }
    const detailBody = el("div");
    sheet.body.appendChild(detailBody);
    renderBody();
  }

  async function pickModel(detail, version) {
    const subfolder = SUBFOLDER[detail.type] || "checkpoints";
    if (ctx.isMuted()) {
      toast("Downloading…");
      try {
        const res = await ctx.callTool("download_civitai_model",
          { model_id: detail.id, model_version_id: version.id, target_subfolder: subfolder },
          { timeout: 20 * 60000 });
        toast(res.ok ? "Downloaded to your machine." : "Download failed: " + (res.error || "?"));
      } catch (e) { toast("Download error: " + e.message); }
    } else {
      ctx.sendUserMessage(
        `Please download the CivitAI ${detail.type} "${detail.name}"` +
        (version.name ? ` (version "${version.name}")` : "") +
        ` — model_id ${detail.id}, version ${version.id} — into ${subfolder}, then we'll use it.`);
      ctx.bringChatForward();
      toast("Asked the agent to download it.");
    }
  }

  // ── filters ──────────────────────────────────────────────────────────
  // Top-creators leaderboard for the Creator picker, cached for the modal's
  // lifetime (the board changes daily — a session-stale list is fine here).
  let _topCreators = null;
  async function topCreators() {
    if (!_topCreators) _topCreators = await client.fetchTopCreators();
    return _topCreators;
  }
  const compactCount = (n) =>
    n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
    : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K"
    : String(n);

  // The whole sheet re-renders after every change: a chip click must flip its
  // own highlight immediately (the original wired a `toggleFilters._rerender`
  // hook that was never defined, so chips looked completely dead — field
  // report: "I press them, nothing happens").
  function toggleFilters() {
    // Creator-lookup generation counter + debounce timer — live OUTSIDE
    // renderSheet so a re-render can't resurrect a stale in-flight response
    // (debounce race), and so a timer armed before a re-render can be
    // cancelled instead of firing against the torn-down sheet (which would
    // bump crReq and strand the new sheet on "Looking up creators…").
    let crReq = 0;
    let crTimer = null;
    // Closing the sheet (✕ / backdrop) tears the picker down for good:
    // cancel the pending debounce and invalidate any lookup already in
    // flight so its completion early-returns instead of touching the
    // detached nodes.
    const sheet = openSubModal("Filters", () => {
      clearTimeout(crTimer); crTimer = null;
      crReq++;
    });
    const update = () => { syncTabs(); reload(); };

    const renderSheet = () => {
      clearTimeout(crTimer); crTimer = null; // pending lookups target dead nodes
      const f = state.filters;
      sheet.body.innerHTML = "";
      const wrap = el("div", "cmcp-cv-filters");

      const chipRow = (label, options, isOn, onToggle) => {
        wrap.appendChild(el("div", "cmcp-cv-flabel", label));
        const row = el("div", "cmcp-cv-frow");
        for (const o of options) {
          const chip = el("button", "cmcp-cv-chip", o.label);
          if (isOn(o.value)) chip.classList.add("on");
          chip.addEventListener("click", () => { onToggle(o.value); renderSheet(); update(); });
          row.appendChild(chip);
        }
        wrap.appendChild(row);
      };

      chipRow("Time period", PERIODS.map((p) => ({ label: p, value: p })),
        (v) => f.period === v, (v) => { f.period = v; });
      const sorts = isModelTab() ? MODEL_SORTS : IMAGE_SORTS;
      chipRow("Sort", sorts.map((s) => ({ label: s, value: s })),
        (v) => (isModelTab() ? f.modelSort : f.imageSort) === v,
        (v) => { if (isModelTab()) f.modelSort = v; else f.imageSort = v; });
      // browsing levels — ALL selectable, no sign-in gate
      chipRow("Browsing level", LEVELS.map((l) => ({ label: l.label, value: l.level })),
        (v) => f.browsingLevels.includes(v),
        (v) => {
          const i = f.browsingLevels.indexOf(v);
          if (i >= 0) f.browsingLevels.splice(i, 1); else f.browsingLevels.push(v);
          if (f.browsingLevels.length === 0) f.browsingLevels.push(1);
        });

      // base model omni-search
      wrap.appendChild(el("div", "cmcp-cv-flabel", "Base model"));
      const pills = el("div", "cmcp-cv-frow");
      // Rebuilt in place rather than via renderSheet(), so toggling a model
      // does not tear down the dropdown mid-selection (see toggleModel).
      const syncPills = () => {
        pills.textContent = "";
        for (const b of f.baseModels) {
          const pill = el("button", "cmcp-cv-chip on", b + "  ✕");
          pill.addEventListener("click", () => {
            f.baseModels = f.baseModels.filter((x) => x !== b);
            syncPills(); renderOpts(); update();
          });
          pills.appendChild(pill);
        }
      };
      // The control this replaces was a bare text input that rendered NOTHING
      // until you typed and then showed only the first 12 hits — so the ~90
      // base models were undiscoverable: you had to already know a family's
      // exact Civitai spelling ("ZImageTurbo", "Wan Video 2.2 I2V-A14B") to
      // reach it. This opens the full list on focus, filters as you type, and
      // caps nothing; the retired half is kept but sunk below the families
      // Civitai still accepts uploads for, since those return almost nothing.
      const dd = el("div", "cmcp-cv-dd");
      const ddId = `cmcp-cv-bm-${Math.random().toString(36).slice(2, 8)}`;
      const bmSearch = el("input", "cmcp-cv-search");
      bmSearch.placeholder = "Search base models…";
      bmSearch.setAttribute("role", "combobox");
      bmSearch.setAttribute("aria-expanded", "false");
      bmSearch.setAttribute("aria-controls", ddId);
      bmSearch.setAttribute("aria-autocomplete", "list");
      bmSearch.autocomplete = "off";
      // bmPanel is the visual popup container. The listbox lives INSIDE it and
      // owns only option/group children (a listbox may not own the group-label
      // divs, the empty notice, or the Clear button) — those siblings sit in the
      // panel, outside the listbox, which is rebuilt each render.
      const bmPanel = el("div", "cmcp-cv-ddpanel");
      let bmOpts = [];   // the option buttons currently rendered, in view order
      let bmActive = -1; // keyboard cursor

      const setActive = (i) => {
        if (bmOpts[bmActive]) bmOpts[bmActive].classList.remove("active");
        bmActive = i < 0 || i >= bmOpts.length ? -1 : i;
        const cur = bmOpts[bmActive];
        if (cur) {
          cur.classList.add("active");
          cur.scrollIntoView({ block: "nearest" });
          bmSearch.setAttribute("aria-activedescendant", cur.id);
        } else {
          bmSearch.removeAttribute("aria-activedescendant");
        }
      };
      const closeDd = () => {
        dd.classList.remove("open");
        bmSearch.setAttribute("aria-expanded", "false");
        setActive(-1);
      };
      const toggleModel = (b) => {
        const i = f.baseModels.indexOf(b);
        if (i >= 0) f.baseModels.splice(i, 1); else f.baseModels.push(b);
        // Update the chip row and the option ticks IN PLACE. Calling
        // renderSheet() here rebuilds the whole sheet, which destroys this
        // input and its text — so picking "Wan Video 2.5 T2V" out of a "wan 2.5"
        // search would close the list and clear the query, and reaching the
        // I2V sibling right below it meant retyping the search. In a
        // multi-select the second pick is the common case, not the rare one.
        syncPills();
        renderOpts();
        update();
      };

      const renderOpts = () => {
        const query = prepareQuery(bmSearch.value);
        bmPanel.innerHTML = "";
        bmOpts = [];
        // The listbox owns ONLY options (grouped under role="group"); it is
        // rebuilt each render but keeps the stable ddId so aria-controls and
        // aria-activedescendant keep resolving.
        const listbox = el("div", "cmcp-cv-ddlist");
        listbox.id = ddId;
        listbox.setAttribute("role", "listbox");
        listbox.setAttribute("aria-multiselectable", "true");
        listbox.setAttribute("aria-label", "Base model");
        bmPanel.appendChild(listbox);
        const hits = BASE_MODELS.filter((x) => matchesBaseModel(x, query));
        const groups = [
          ["Current", hits.filter((x) => ACTIVE_BASE_MODELS.has(x))],
          ["Legacy", hits.filter((x) => !ACTIVE_BASE_MODELS.has(x))],
        ];
        for (const [label, items] of groups) {
          if (!items.length) continue;
          // A listbox may only own option/group children — so each labelled
          // section is a role="group" (named via aria-label), not a bare div.
          const group = el("div", "cmcp-cv-ddgroupwrap");
          group.setAttribute("role", "group");
          group.setAttribute("aria-label", label);
          const heading = el("div", "cmcp-cv-ddgroup", label);
          heading.setAttribute("aria-hidden", "true"); // group's aria-label already names it
          group.appendChild(heading);
          for (const b of items) {
            const on = f.baseModels.includes(b);
            const opt = el("button", "cmcp-cv-ddopt" + (on ? " on" : ""));
            opt.type = "button";
            opt.id = `${ddId}-o${bmOpts.length}`;
            opt.setAttribute("role", "option");
            opt.setAttribute("aria-selected", on ? "true" : "false");
            opt.appendChild(el("span", "tick", "✓"));
            opt.appendChild(el("span", null, b));
            // mousedown, not click: the input's blur would close the panel and
            // detach the button before a click ever lands on it. Left button
            // ONLY — mousedown fires for every button, so without this guard a
            // right-click meant to open a context menu silently toggles the
            // filter under the cursor.
            opt.addEventListener("mousedown", (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              toggleModel(b);
            });
            group.appendChild(opt);
            bmOpts.push(opt);
          }
          listbox.appendChild(group);
        }
        if (!bmOpts.length) {
          // Not an option — belongs in the panel, outside the listbox.
          bmPanel.appendChild(el("div", "cmcp-cv-ddempty", `No base model matches “${bmSearch.value.trim()}”.`));
        }
        // Selected-count + clear, matching what ComfyUI's own multi-select
        // shows. With the list scrolled or filtered the chips above can be out
        // of view, so without this there is no way to tell how many filters are
        // live — or to drop them without hunting each one down.
        if (f.baseModels.length) {
          const foot = el("div", "cmcp-cv-ddfoot");
          foot.appendChild(el("span", null,
            `${f.baseModels.length} selected`));
          const clear = el("button", "cmcp-cv-ddclear", "Clear");
          clear.type = "button";
          // Left button only — right-clicking "Clear" would otherwise wipe every
          // selected model before the context menu even appeared.
          clear.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            f.baseModels.length = 0;
            syncPills(); renderOpts(); update();
          });
          foot.appendChild(clear);
          bmPanel.appendChild(foot);
        }
        setActive(-1);
      };
      const openDd = () => {
        renderOpts();
        dd.classList.add("open");
        bmSearch.setAttribute("aria-expanded", "true");
      };

      bmSearch.addEventListener("focus", openDd);
      bmSearch.addEventListener("input", () => { renderOpts(); dd.classList.add("open"); });
      bmSearch.addEventListener("blur", closeDd);
      bmSearch.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          // Escape MUST stop here. The sheet is mounted inside ComfyUI's own
          // document, so an un-stopped Escape closes the whole filter sheet
          // (and reaches the canvas) — dismissing the dropdown would throw
          // away the user's other filter edits with it.
          if (dd.classList.contains("open")) { e.preventDefault(); e.stopPropagation(); closeDd(); }
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (!dd.classList.contains("open")) { openDd(); return; }
          if (!bmOpts.length) return;
          const next = e.key === "ArrowDown"
            ? (bmActive + 1) % bmOpts.length
            : (bmActive <= 0 ? bmOpts.length : bmActive) - 1;
          setActive(next);
          return;
        }
        if (e.key === "Enter" && bmActive >= 0) {
          e.preventDefault();
          bmOpts[bmActive].dispatchEvent(new MouseEvent("mousedown"));
        }
      });
      dd.append(bmSearch, bmPanel);
      syncPills(); // paint the chips for models already selected on this sheet
      wrap.append(pills, dd);

      // creator — single-select async search. Empty field shows the site's
      // TOP-CREATORS leaderboard (ranked, with stats); typing runs a debounced
      // (300ms) /v1/creators username search. Picking one threads `username`
      // through every feed/search/model query; no selection = everyone.
      wrap.appendChild(el("div", "cmcp-cv-flabel", "Creator"));
      if (tabDef().fav) {
        // Favorites are "images YOU liked", from every creator — the tRPC
        // favorites feed has no creator param, so render the filter visibly
        // inert here instead of silently no-oping.
        const box = el("div", "cmcp-cv-frow");
        box.style.opacity = ".6";
        if (f.username) {
          const pill = el("button", "cmcp-cv-chip on", f.username + "  ✕");
          pill.title = "Remove creator filter";
          pill.addEventListener("click", () => { setCreator(null); renderSheet(); update(); });
          box.appendChild(pill);
        }
        box.appendChild(el("div", "cmcp-cv-lb-muted",
          "Ignored on the Favorites tab — favorites are the images you liked, from every creator."));
        wrap.appendChild(box);
      } else {
        const crPills = el("div", "cmcp-cv-frow");
        if (f.username) {
          const pill = el("button", "cmcp-cv-chip on", f.username + "  ✕");
          pill.title = "Remove creator filter";
          pill.addEventListener("click", () => { setCreator(null); renderSheet(); update(); });
          crPills.appendChild(pill);
        }
        const crSearch = el("input", "cmcp-cv-search");
        crSearch.placeholder = f.username
          ? "Switch creator…"
          : "All creators — search, or pick from the top";
        const crNote = el("div", "cmcp-cv-lb-muted");
        crNote.style.display = "none";
        const crList = el("div", "cmcp-cv-creators");
        const renderMatches = (matches) => {
          crList.innerHTML = "";
          for (const c of matches) {
            const b = el("button", "cmcp-cv-creator");
            b.appendChild(el("span", null,
              c.position != null ? `#${c.position}  ${c.username}` : c.username));
            const sub = c.position != null
              ? [
                  c.downloads != null ? compactCount(c.downloads) + " downloads" : null,
                  c.thumbsUp != null ? compactCount(c.thumbsUp) + " likes" : null,
                ].filter(Boolean).join(" · ")
              : `${c.modelCount ?? 0} model${(c.modelCount ?? 0) === 1 ? "" : "s"}`;
            if (sub) b.appendChild(el("span", "sub", sub));
            b.addEventListener("click", () => {
              setCreator(c.username);
              renderSheet(); update();
            });
            crList.appendChild(b);
          }
        };
        const loadMatches = () => {
          if (!crSearch.isConnected) return; // sheet closed or re-rendered
          // Direct calls (the focus path) must also cancel a pending debounce
          // tick, or the same text fires a second, redundant lookup.
          clearTimeout(crTimer); crTimer = null;
          const req = ++crReq;
          const cq = crSearch.value.trim();
          crNote.style.display = ""; crNote.textContent = "Looking up creators…";
          (cq ? client.searchCreators(cq) : topCreators())
            .then((matches) => {
              if (req !== crReq) return; // a newer lookup owns the list
              renderMatches(matches);
              crNote.style.display = matches.length ? "none" : "";
              crNote.textContent = cq
                ? "No creators match."
                : "Top creators unavailable right now.";
            })
            .catch(() => {
              // The leaderboard tRPC intermittently 401s bare user agents —
              // degrade to a note without breaking the rest of the sheet.
              if (req !== crReq) return;
              crList.innerHTML = "";
              crNote.style.display = "";
              crNote.textContent = cq
                ? "Creator search failed — try again."
                : "Top creators unavailable right now.";
            });
        };
        crSearch.addEventListener("input", () => {
          crReq++; // invalidate lookups in flight for the previous text NOW
          clearTimeout(crTimer);
          crTimer = setTimeout(loadMatches, 300);
        });
        crSearch.addEventListener("focus", () => {
          if (!crList.children.length) loadMatches();
        });
        wrap.append(crPills, crSearch, crNote, crList);
      }

      const reset = el("button", "cmcp-btn", "Reset filters");
      reset.addEventListener("click", () => {
        state.filters = {
          ...DEFAULT_FILTERS,
          baseModels: [...DEFAULT_FILTERS.baseModels],
          browsingLevels: [...DEFAULT_FILTERS.browsingLevels],
        };
        setCreator(null); // also strips a stale @token from the search box
        renderSheet(); update();
      });
      wrap.appendChild(reset);

      sheet.body.appendChild(wrap);
    };
    renderSheet();
  }

  // ── local model index ("in library" marks) ──────────────────────────
  async function refreshLocalModels() {
    try {
      const res = await ctx.callTool("list_local_models", {}, { timeout: 15000 });
      const text = (res.result || []).map((b) => (b && b.text) || "").join("\n");
      state.localNames = CivitaiClient.parseLocalNames(text);
    } catch { /* no marks if the call fails */ }
    state.localLoaded = true;
  }
  function owned(fileName) {
    if (!fileName || !state.localNames.size) return false;
    const n = fileName.toLowerCase();
    return state.localNames.has(n) || state.localNames.has(n.replace(/\.[a-z0-9]+$/, ""));
  }

  // ── account / OAuth ──────────────────────────────────────────────────
  async function refreshAuth() {
    try {
      const r = await ctx.api.fetchApi("/comfyui_mcp_panel/civitai/oauth/status");
      state.signedIn = (await r.json()).signed_in;
    } catch { state.signedIn = false; }
    acctBtn.style.color = state.signedIn ? "var(--p-primary-color,#3a7bd5)" : "";
  }
  async function accountFlow() {
    await refreshAuth();
    if (state.signedIn) {
      // Account sheet: the "default likes folder" (a CivitAI collection every
      // like also lands in) + sign out. Signed-in no longer instant-signs-out.
      const sheet = openSubModal("CivitAI account");
      const wrap = el("div", "cmcp-cv-filters");
      wrap.appendChild(el("div", null, "Signed in ✓"));
      wrap.appendChild(el("div", "cmcp-cv-flabel", "Default likes collection"));
      wrap.appendChild(el("div", "cmcp-cv-lb-muted",
        "Every like is also saved into this collection on your CivitAI account (and removed when you unlike)."));
      const row = el("div", "cmcp-cv-frow");
      const sel = document.createElement("select");
      sel.className = "cmcp-cv-search";
      sel.disabled = true;
      sel.appendChild(new Option("Loading collections…", ""));
      const newBtn = el("button", "cmcp-btn", "+ New…");
      row.append(sel, newBtn);
      wrap.appendChild(row);
      let colCache = [];
      const fillSelect = () => {
        sel.innerHTML = "";
        sel.appendChild(new Option("(none — likes only)", ""));
        const cur = likesCollection();
        for (const c of colCache) {
          const o = new Option(c.name, String(c.id));
          if (cur && cur.id === c.id) o.selected = true;
          sel.appendChild(o);
        }
        sel.disabled = false;
      };
      client.getUserCollections()
        .then((cols) => { colCache = cols; fillSelect(); })
        .catch((e) => {
          sel.innerHTML = "";
          sel.appendChild(new Option("Couldn't load collections", ""));
          if (String(e.message || e).includes("403")) {
            wrap.appendChild(el("div", "cmcp-cv-lb-muted",
              "Your sign-in predates the collection permissions — sign out and back in to grant them."));
          }
        });
      sel.addEventListener("change", () => {
        const c = colCache.find((x) => String(x.id) === sel.value);
        setLikesCollection(c || null);
        toast(c ? `Likes will also go to "${c.name}".` : "Likes won't be added to a collection.");
      });
      newBtn.addEventListener("click", async () => {
        const name = window.prompt("Name for the new CivitAI collection:");
        if (!name || !name.trim()) return;
        newBtn.disabled = true;
        try {
          const c = await client.createCollection(name.trim());
          colCache.push(c);
          fillSelect();
          sel.value = String(c.id);
          setLikesCollection(c);
          toast(`Created "${c.name}" — it's now your likes collection.`);
        } catch (e) {
          toast("Create failed: " + (e.message || e));
        } finally {
          newBtn.disabled = false;
        }
      });
      const out = el("button", "cmcp-btn", "Sign out");
      out.addEventListener("click", async () => {
        await ctx.api.fetchApi("/comfyui_mcp_panel/civitai/oauth/logout", { method: "POST" });
        await refreshAuth(); sheet.close(); toast("Signed out of CivitAI.");
      });
      wrap.appendChild(out);
      sheet.body.appendChild(wrap);
      return;
    }
    try {
      const r = await ctx.api.fetchApi("/comfyui_mcp_panel/civitai/oauth/start?origin=" + encodeURIComponent(location.origin));
      const { authorize_url } = await r.json();
      window.open(authorize_url, "_blank", "width=520,height=720");
      // poll for completion — tracked so close() can cancel a pending sign-in.
      let tries = 0;
      if (_oauthPollIv) clearInterval(_oauthPollIv);
      _oauthPollIv = setInterval(async () => {
        if (!isOpen) { clearInterval(_oauthPollIv); _oauthPollIv = null; return; }
        await refreshAuth();
        // Re-check AFTER the await: close() may have fired during the fetch, and
        // the continuation must not toast/reload a torn-down modal (codex finding).
        if (!isOpen) { if (_oauthPollIv) { clearInterval(_oauthPollIv); _oauthPollIv = null; } return; }
        if (state.signedIn || ++tries > 120) {
          clearInterval(_oauthPollIv); _oauthPollIv = null;
          if (state.signedIn) { toast("Signed in to CivitAI."); if (tabDef().fav) reload(); }
        }
      }, 2000);
    } catch (e) { toast("Sign-in failed: " + e.message); }
  }

  // ── sub-modal + toast helpers ────────────────────────────────────────
  // Open sub-modal closers, so a successful canvas load can dismiss every
  // stacked sheet (detail → gen-info → picker) in one sweep.
  const _subModals = new Set();
  function closeSubModals() {
    for (const c of [..._subModals]) { try { c(); } catch { /* already gone */ } }
  }
  function openSubModal(title, onClose) {
    const ov = el("div", "cmcp-cv-overlay"); ov.style.zIndex = "10001";
    const m = el("div", "cmcp-modal"); m.style.maxWidth = "40rem"; m.style.width = "min(40rem, 92vw)";
    m.style.maxHeight = "85vh"; m.style.overflowY = "auto";
    const head2 = el("div", "cmcp-modal-title", title);
    const x = el("button", "cmcp-cv-iconbtn"); x.innerHTML = '<i class="pi pi-times"></i>';
    x.style.cssText = "position:absolute;top:.5rem;right:.5rem";
    const b = el("div"); m.style.position = "relative";
    // Every close path (✕ button, backdrop click, sheet.close()) funnels here,
    // so a caller-supplied teardown runs no matter how the sheet is dismissed.
    const close2 = () => { _subModals.delete(close2); ov.remove(); if (onClose) onClose(); };
    _subModals.add(close2);
    x.addEventListener("click", close2);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close2(); });
    m.append(head2, x, b); ov.appendChild(m); document.body.appendChild(ov);
    return { body: b, close: close2 };
  }

  function toast(msg, { ms = 3500 } = {}) {
    const t = el("div", null, msg);
    // ALWAYS mount on <body> above every overlay — sub-modals (10001), the
    // lightbox (10002) and the workflow picker sit above the base modal, and a
    // toast rendered inside `modal` (z-index 80) was hidden behind them, so a
    // gated-download hint or a load error read as "nothing happened". A fixed,
    // top-of-stack toast is visible no matter which sheet is open (or if the
    // whole explorer just closed after a successful load).
    t.style.cssText = "position:fixed;bottom:1.25rem;left:50%;transform:translateX(-50%);" +
      "max-width:min(38rem,90vw);text-align:center;background:var(--p-surface-800,#27272a);" +
      "color:#fafafa;padding:.55rem .9rem;border-radius:8px;z-index:10060;font-size:.82rem;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.5)";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ── agent-driven handle ────────────────────────────────────────────────
  // Post-open control surface: the same inner state/functions the UI drives,
  // exposed so the bridge (and through it the agent) can switch tabs, re-search,
  // read results (metadata + URLs only — never image bytes), and glow-highlight
  // the interesting cards. Every method awaits the modal settling, throws on a
  // closed handle, and returns a small plain object; no dynamic exec (YARA safe).
  function _assertOpen() { if (!isOpen) throw new Error("civitai browser not open"); }
  async function driveSwitchTab(key) {
    _assertOpen();
    if (!TABS.some((t) => t.key === key)) throw new Error(`unknown tab "${key}"`);
    if (state.tab !== key) { state.tab = key; syncTabs(); await reload(); }
    else syncTabs();
    return { tab: state.tab, renderRev: state.renderRev };
  }
  async function driveSearch({ query, filters, browsingLevels } = {}) {
    _assertOpen();
    // Atomic normalize: fold filters, then query→(creator,text) in one shot so a
    // half-applied state never reaches reload.
    if (filters && typeof filters === "object") {
      state.filters = {
        ...state.filters, ...filters,
        baseModels: Array.isArray(filters.baseModels) ? [...filters.baseModels] : state.filters.baseModels,
        browsingLevels: Array.isArray(filters.browsingLevels) ? [...filters.browsingLevels] : state.filters.browsingLevels,
      };
    }
    // NSFW browsing levels arrive already server-clamped (mcp strips adult
    // levels without consent). Defense-in-depth: the client has no NSFW gate, so
    // drop any level ∉ the known enum {1,2,4,8,16} before applying — never let a
    // malformed/unknown level reach the query. Omitted → leave the filter as-is.
    const lvlSrc = Array.isArray(browsingLevels) ? browsingLevels
      : (filters && Array.isArray(filters.browsingLevels) ? filters.browsingLevels : null);
    if (lvlSrc) {
      const KNOWN = new Set(LEVELS.map((l) => l.level));
      const clean = [...new Set(lvlSrc.map(Number).filter((n) => KNOWN.has(n)))];
      state.filters = { ...state.filters, browsingLevels: clean.length ? clean : [1] };
    }
    if (typeof query === "string") {
      search.value = query;
      const parsed = parseCreatorQuery(query);
      state.query = parsed.query;
      if (parsed.creator) setCreator(parsed.creator); // normalizes @token + username
      else if (creatorFromSearch && state.filters.username) { setCreator(null); }
    }
    clearTimeout(searchTimer); // cancel the 500ms debounce so it can't double-fire
    syncTabs();
    // FORCE a reload even when the text is unchanged (a re-search is an explicit
    // agent intent, unlike applySearch's typing-debounce dedupe) — but resolve on
    // DISPATCH, not on fetch completion (#282): awaiting the cold first fetch
    // (modal still docking) blew the 10s ctx.call bridge timeout and cost the
    // agent several retry turns. reload() tracks its own promise
    // (state.activeReloadPromise) for drive methods that need the first page, and
    // _loadMore swallows fetch errors into the sentinel (never rejects), so the
    // dropped promise is safe. _reload's reqId/renderRev bumps run SYNCHRONOUSLY
    // (before its first await), so state.renderRev below is already the new
    // generation. The agent reads the data via panel_civitai_results
    // (loading/done flags) — the metadata-poll design.
    void reload({ searching: true });
    return { tab: state.tab, query: state.query, creator: state.filters.username || null, renderRev: state.renderRev, dispatched: true };
  }
  function driveGetResults({ limit = 20 } = {}) {
    _assertOpen();
    const model = isModelTab();
    const source = model ? state.models : state.items;
    const ser = serializeCivitaiResults(source, { model, limit, loading: state.loading });
    return {
      ...ser, // { items, total, loading }
      count: ser.items.length,
      done: !!state.done,
      renderRev: state.renderRev,
      truncated: source.length > ser.items.length,
    };
  }
  /** Highlight a set of ids (REPLACEMENT semantics). Awaits the in-flight
   *  first-page load so a highlight issued before results land still lands.
   *  Persists the set so later pages glow as they stream in (see appendItems). */
  async function driveHighlight(ids, { kind } = {}) { // eslint-disable-line no-unused-vars
    _assertOpen();
    const list = (Array.isArray(ids) ? ids : (ids != null ? [ids] : [])).map((x) => String(x));
    const rev = state.renderRev;
    try { await state.activeReloadPromise; } catch { /* fetch error surfaces elsewhere */ }
    _assertOpen();
    if (state.renderRev !== rev) {
      // A reload/tab/filter superseded this highlight while we awaited: these ids
      // belonged to the OLD search and MUST NOT be installed on the new
      // generation (they'd glow same-id cards from a different query). Bail
      // without touching the current set — the agent can re-issue against the
      // new results (codex finding).
      return { highlighted: 0, missing: list, renderRev: state.renderRev, superseded: true };
    }
    // Replacement: strip the prior set, install the new one, then paint.
    driveClearHighlight();
    state.highlightOrder = [...list];
    state.highlightSet = new Set(list);
    let first = null, hit = 0;
    const missing = [];
    for (const id of list) { // input order → first found scrolls into view
      const card = grid.querySelector(`.cmcp-cv-card[data-id="${CSS.escape(id)}"]`);
      if (card) { card.classList.add("cmcp-agent-glow"); if (!first) first = card; hit++; }
      else missing.push(id);
    }
    if (first) first.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return { highlighted: hit, missing, renderRev: state.renderRev };
  }
  function driveClearHighlight() {
    _assertOpen();
    state.highlightSet = new Set();
    state.highlightOrder = [];
    for (const c of grid.querySelectorAll(".cmcp-cv-card.cmcp-agent-glow")) c.classList.remove("cmcp-agent-glow");
    return { ok: true };
  }
  /** Open the lightbox for a card. Dispatch by KIND: media → openViewer(index)
   *  (index-addressed); model → openModelDetail (model tabs leave state.items
   *  empty, so an index lookup there is meaningless). */
  function driveOpenLightbox(id, { kind } = {}) {
    _assertOpen();
    const wantModel = kind === "model" || (kind == null && isModelTab());
    if (wantModel) {
      const m = state.models.find((x) => String(x.id) === String(id));
      if (!m) throw new Error(`no model card for id ${id}`);
      openModelDetail(m);
      return { opened: "model", id };
    }
    const i = state.items.findIndex((x) => String(x.id) === String(id));
    if (i < 0) throw new Error(`no media card for id ${id}`);
    openViewer(i);
    return { opened: "media", id };
  }
  function driveGetState() {
    return {
      isOpen, tab: state.tab, loading: !!state.loading, done: !!state.done,
      renderRev: state.renderRev, docked: !applyDock.centered && overlay.classList.contains("cmcp-docked"),
      highlighted: state.highlightOrder.slice(),
    };
  }

  // ── go ───────────────────────────────────────────────────────────────
  syncTabs();
  refreshAuth();
  reload();
  return {
    close, focus: () => search.focus(),
    switchTab: driveSwitchTab, search: driveSearch, getResults: driveGetResults,
    highlight: driveHighlight, clearHighlight: driveClearHighlight,
    openLightbox: driveOpenLightbox, getState: driveGetState,
  };
}
