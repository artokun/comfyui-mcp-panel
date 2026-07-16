// CivitAI browser modal for the panel — a browser port of the mobile app's
// civitai_browse_screen / viewer / filter sheet. Opens from the (formerly parked)
// "Civitai" toolbar button, and can be opened BY the agent pre-seeded with a query
// + filters (cmd: open_civitai). Every network call goes through CivitaiClient →
// the same-origin proxy. Actions are mute-aware: un-muted hands the pick to the
// agent (share-with-agent), muted downloads directly via call_tool.
//
// The monolith injects a `ctx` so this module never reaches into panel internals:
//   ctx = { api, root, callTool, sendUserMessage, uploadBlobToInput,
//           bringChatForward, isMuted, marked, DOMPurify }

import {
  CivitaiClient, DEFAULT_FILTERS, LEVELS, PERIODS, IMAGE_SORTS, MODEL_SORTS,
  BASE_MODELS, filtersDirty, bitmask,
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
  .cmcp-cv-lb-muted { font-size: .74rem; color: var(--p-text-muted-color,#a1a1aa); }
  .cmcp-cv-lb-prompt { font-size: .78rem; white-space: pre-wrap; word-break: break-word;
    background: var(--p-surface-950,#111); border-radius: 8px; padding: .5rem;
    max-height: 14rem; overflow-y: auto; }
  .cmcp-cv-lb-params { display: grid; grid-template-columns: max-content 1fr; gap: .15rem .6rem;
    font-size: .74rem; }
  .cmcp-cv-lb-params .k { color: var(--p-text-muted-color,#a1a1aa); }
  @media (max-width: 760px) { .cmcp-cv-lb { flex-direction: column; }
    .cmcp-cv-lb-side { flex: 0 0 45%; max-width: none; border-left: none;
      border-top: 1px solid var(--p-content-border-color,#3f3f46); } }
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

/** Open (or focus) the CivitAI modal. opts = {query, tab, filters, browsingLevels}. */
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
    signedIn: false, localNames: new Set(), localLoaded: false,
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
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  // header
  const head = el("div", "cmcp-cv-head");
  const tabsWrap = el("div", "cmcp-cv-tabs");
  const search = el("input", "cmcp-cv-search");
  search.placeholder = "Search CivitAI…";
  search.value = state.query;
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.query = search.value.trim(); reload(); }
  });
  const filterBtn = el("button", "cmcp-cv-iconbtn");
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
  head.append(tabsWrap, search, filterBtn, acctBtn, closeBtn);

  // body
  const body = el("div", "cmcp-cv-body");
  const progress = el("div", "cmcp-cv-progress");
  const grid = el("div", "cmcp-cv-grid");
  const sentinel = el("div", "cmcp-cv-loading");
  body.append(progress, grid, sentinel);
  body.addEventListener("scroll", () => {
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 600) loadMore();
  });

  modal.append(head, body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function syncTabs() {
    for (const b of tabsWrap.children) b.classList.toggle("active", b._key === state.tab);
    search.style.display = isModelTab() ? "none" : "";
    filterDot.style.display = filtersDirty(state.filters) ? "" : "none";
  }

  // ── data ───────────────────────────────────────────────────────────────
  function setLoading(on) { state.loading = on; progress.classList.toggle("on", on); }

  async function reload() {
    state.items = []; state.models = []; state.cursor = null; state.done = false;
    grid.innerHTML = ""; syncTabs();
    await loadMore();
  }

  async function loadMore() {
    if (state.loading || state.done) return;
    const req = ++state.reqId;
    setLoading(true);
    sentinel.textContent = "Loading…";
    try {
      const f = state.filters;
      const levels = f.browsingLevels;
      const t = tabDef();
      if (t.fav) {
        if (!state.signedIn) { sentinel.textContent = "Sign in to see your favorites."; setLoading(false); return; }
        const page = await client.fetchFavorites({ levels, cursor: state.cursor });
        if (req !== state.reqId) return;
        state.cursor = page.nextCursor; state.done = !page.nextCursor;
        appendItems(page.items);
      } else if (t.model) {
        if (!state.localLoaded) await refreshLocalModels(); // for "in library" marks
        const page = await client.fetchModels({
          type: t.model, sort: f.modelSort, period: f.period,
          baseModels: f.baseModels, levels, cursor: state.cursor,
        });
        if (req !== state.reqId) return;
        state.cursor = page.nextCursor; state.done = !page.nextCursor;
        appendModels(page.models);
      } else if (state.query) {
        const items = await client.searchMedia(state.query, { type: t.media, levels, offset: state.items.length });
        if (req !== state.reqId) return;
        state.done = items.length === 0;
        appendItems(items);
      } else {
        const page = await client.fetchFeed({ type: t.media, period: f.period, sort: f.imageSort, levels, cursor: state.cursor });
        if (req !== state.reqId) return;
        state.cursor = page.nextCursor; state.done = !page.nextCursor;
        appendItems(page.items);
      }
      sentinel.textContent = state.done ? "" : "";
    } catch (e) {
      sentinel.textContent = "CivitAI error: " + (e.message || e);
    } finally {
      if (req === state.reqId) setLoading(false);
    }
  }

  function appendItems(items) {
    for (const it of items) {
      state.items.push(it);
      const idx = state.items.length - 1;
      grid.appendChild(mediaCard(it, idx));
    }
  }
  function appendModels(models) {
    for (const m of models) { state.models.push(m); grid.appendChild(modelCard(m)); }
  }

  // ── cards ─────────────────────────────────────────────────────────────
  function mediaCard(it, idx) {
    const card = el("div", "cmcp-cv-card");
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
    card.addEventListener("click", () => openViewer(idx));
    return card;
  }

  function modelCard(m) {
    const card = el("div", "cmcp-cv-card");
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
  function openViewer(startIdx) {
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
    const closeLb = () => { lb.remove(); document.removeEventListener("keydown", onKey, true); };
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
      side.appendChild(el("div", "cmcp-cv-lb-title",
        `${it.type === "video" ? "🎬" : "🖼"} ${it.author ? "@" + it.author : "CivitAI " + it.type}`));
      side.appendChild(el("div", "cmcp-cv-lb-muted",
        `♥ ${it.reactions || 0} · ${idx + 1} / ${state.items.length}${state.done ? "" : "+"}`));

      const actions = el("div", "cmcp-cv-actions");
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
        const graph = CivitaiClient.comfyGraph(gen.meta);
        if (graph) {
          const saveBtn = el("button", "cmcp-btn", "Save workflow");
          saveBtn.addEventListener("click", () => saveWorkflow(it, graph));
          actions.appendChild(saveBtn);
        }
        genBox.innerHTML = "";
        genBox.appendChild(el("div", "cmcp-cv-lb-muted",
          graph ? "✓ Embedded ComfyUI workflow" : "No embedded workflow"));
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
  }

  // ── generation info + share/save (mute-aware) ────────────────────────
  async function showGenInfo(it) {
    const sheet = openSubModal("Generation info");
    sheet.body.appendChild(el("div", "cmcp-cv-loading", "Loading…"));
    let gen;
    try { gen = await client.getGenerationData(it.id); }
    catch (e) { sheet.body.innerHTML = ""; sheet.body.appendChild(el("div", null, "No data: " + e.message)); return; }
    sheet.body.innerHTML = "";
    const graph = CivitaiClient.comfyGraph(gen.meta);
    sheet.body.appendChild(el("div", null, graph ? "✓ Embedded ComfyUI workflow" : "No embedded workflow"));

    const actions = el("div", "cmcp-cv-actions");
    const shareBtn = el("button", "cmcp-btn cmcp-btn-primary",
      ctx.isMuted() ? "Save reference to inputs" : "Share with agent");
    shareBtn.addEventListener("click", () => shareImage(it, gen));
    actions.appendChild(shareBtn);
    if (graph) {
      const saveBtn = el("button", "cmcp-btn", "Save workflow");
      saveBtn.addEventListener("click", () => saveWorkflow(it, graph));
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
    } catch (e) { toast("Share failed: " + e.message); }
  }

  async function saveWorkflow(it, graph) {
    try {
      const res = await ctx.callTool("save_workflow",
        { filename: `civitai_${it.id}.json`, workflow: graph }, { timeout: 60000 });
      toast(res.ok ? "Workflow saved to your machine." : "Save failed: " + (res.error || "?"));
    } catch (e) { toast("Save failed: " + e.message); }
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
      if (have) {
        const note = el("span", null, "You already have this file locally.");
        note.style.cssText = "font-size:.72rem;color:#4ade80;align-self:center";
        dl.appendChild(note);
      }
      detailBody.appendChild(dl);
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
  // The whole sheet re-renders after every change: a chip click must flip its
  // own highlight immediately (the original wired a `toggleFilters._rerender`
  // hook that was never defined, so chips looked completely dead — field
  // report: "I press them, nothing happens").
  function toggleFilters() {
    const sheet = openSubModal("Filters");
    const update = () => { syncTabs(); reload(); };

    const renderSheet = () => {
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
      for (const b of f.baseModels) {
        const pill = el("button", "cmcp-cv-chip on", b + "  ✕");
        pill.addEventListener("click", () => {
          f.baseModels = f.baseModels.filter((x) => x !== b);
          renderSheet(); update();
        });
        pills.appendChild(pill);
      }
      const bmSearch = el("input", "cmcp-cv-search"); bmSearch.placeholder = "Filter base models…";
      const bmList = el("div", "cmcp-cv-frow");
      bmSearch.addEventListener("input", () => {
        const q = bmSearch.value.toLowerCase();
        bmList.innerHTML = "";
        if (!q) return;
        for (const b of BASE_MODELS.filter((x) => x.toLowerCase().includes(q)).slice(0, 12)) {
          const chip = el("button", "cmcp-cv-chip", b);
          chip.addEventListener("click", () => {
            if (!f.baseModels.includes(b)) f.baseModels.push(b);
            renderSheet(); update();
          });
          bmList.appendChild(chip);
        }
      });
      wrap.append(pills, bmSearch, bmList);

      const reset = el("button", "cmcp-btn", "Reset filters");
      reset.addEventListener("click", () => {
        state.filters = {
          ...DEFAULT_FILTERS,
          baseModels: [...DEFAULT_FILTERS.baseModels],
          browsingLevels: [...DEFAULT_FILTERS.browsingLevels],
        };
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
      await ctx.api.fetchApi("/comfyui_mcp_panel/civitai/oauth/logout", { method: "POST" });
      await refreshAuth(); toast("Signed out of CivitAI.");
      return;
    }
    try {
      const r = await ctx.api.fetchApi("/comfyui_mcp_panel/civitai/oauth/start?origin=" + encodeURIComponent(location.origin));
      const { authorize_url } = await r.json();
      window.open(authorize_url, "_blank", "width=520,height=720");
      // poll for completion
      let tries = 0;
      const iv = setInterval(async () => {
        await refreshAuth();
        if (state.signedIn || ++tries > 120) {
          clearInterval(iv);
          if (state.signedIn) { toast("Signed in to CivitAI."); if (tabDef().fav) reload(); }
        }
      }, 2000);
    } catch (e) { toast("Sign-in failed: " + e.message); }
  }

  // ── sub-modal + toast helpers ────────────────────────────────────────
  function openSubModal(title) {
    const ov = el("div", "cmcp-cv-overlay"); ov.style.zIndex = "10001";
    const m = el("div", "cmcp-modal"); m.style.maxWidth = "40rem"; m.style.width = "min(40rem, 92vw)";
    m.style.maxHeight = "85vh"; m.style.overflowY = "auto";
    const head2 = el("div", "cmcp-modal-title", title);
    const x = el("button", "cmcp-cv-iconbtn"); x.innerHTML = '<i class="pi pi-times"></i>';
    x.style.cssText = "position:absolute;top:.5rem;right:.5rem";
    const b = el("div"); m.style.position = "relative";
    const close2 = () => ov.remove();
    x.addEventListener("click", close2);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) close2(); });
    m.append(head2, x, b); ov.appendChild(m); document.body.appendChild(ov);
    return { body: b, close: close2 };
  }

  function toast(msg) {
    const t = el("div", null, msg);
    t.style.cssText = "position:absolute;bottom:1rem;left:50%;transform:translateX(-50%);" +
      "background:var(--p-surface-800,#27272a);color:#fafafa;padding:.5rem .8rem;border-radius:8px;" +
      "z-index:80;font-size:.8rem;box-shadow:0 4px 16px rgba(0,0,0,.5)";
    modal.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── go ───────────────────────────────────────────────────────────────
  syncTabs();
  refreshAuth();
  reload();
  return { close, focus: () => search.focus() };
}
