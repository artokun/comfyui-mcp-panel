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
  filtersDirty, bitmask, parseCreatorQuery, levelLabel,
} from "./cmcp-civitai.js";
import { summarizeSearchFilters } from "./lib/civitai-search-echo.js";
import {
  awaitReloadWithin,
  classifyHighlightOutcome,
  RELOAD_WAIT_BUDGET_MS,
} from "./lib/civitai-reload-wait.js";
import { openSidePanel } from "./cmcp-sidepanel-ui.js";
import { openSubModal as openSubModalBase, toast } from "./cmcp-modal.js";
import { chipRow as filterChipRow, makeFilterButton } from "./cmcp-filter.js";
import { coerceMessageText } from "./lib/chat-serialize.js";
import { isImeComposing } from "./lib/ime.js";
import { tr } from "./lib/i18n.js";

// `label` is a GETTER: this array is built at module scope, which runs at IMPORT time —
// before setup() awaits loadCatalog() — so a plain value would freeze the English fallback
// forever and no translation could ever render. Deferring the lookup to read-time fixes it
// without touching a single consumer.
const TABS = [
  { key: "images", get label() { return tr("civitai_ui.images", "Images"); }, icon: "pi-image", media: "image" },
  { key: "videos", get label() { return tr("civitai_ui.videos", "Videos"); }, icon: "pi-video", media: "video" },
  { key: "checkpoints", get label() { return tr("civitai_ui.checkpoints", "Checkpoints"); }, icon: "pi-box", model: "Checkpoint" },
  { key: "loras", get label() { return tr("civitai_ui.loras", "LoRAs"); }, icon: "pi-sliders-h", model: "LORA" },
  { key: "workflows", get label() { return tr("civitai_ui.workflows", "Workflows"); }, icon: "pi-share-alt", model: "Workflows" },
  { key: "favorites", get label() { return tr("civitai_ui.favorites", "Favorites"); }, icon: "pi-heart", media: "image", fav: true },
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
  // Shared-chrome rules (.cmcp-cv-overlay / .cmcp-modal.cmcp-sidepanel / -head /
  // -tabs / -tab / -search / -iconbtn / -dot / -body / -subnav + the docked rules)
  // now live in the shell (cmcp-sidepanel-ui.js). This block keeps ONLY Civitai's
  // body CSS so the -cv-* card/lightbox/filter styles still resolve.
  const css = `
  .cmcp-cv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: .5rem; }
  .cmcp-cv-card { position: relative; border-radius: 10px; overflow: hidden; cursor: pointer;
    background: var(--p-surface-900, #18181b); aspect-ratio: .72; }
  .cmcp-cv-card img, .cmcp-cv-card video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cmcp-cv-cardfoot { position: absolute; left: 0; right: 0; bottom: 0; padding: .3rem .4rem;
    font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.8615); color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.75)); }
  .cmcp-cv-badge { position: absolute; top: .3rem; left: .3rem; background: rgba(0,0,0,.6); color:#fff;
    font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.7385); padding: .1rem .3rem; border-radius: 4px; }
  /* Rating badge (top-right), colour-coded by browsing level. */
  .cmcp-cv-rating { position: absolute; top: .3rem; right: .3rem; z-index: 2; color:#fff;
    font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.7138); font-weight: 700; letter-spacing: .02em; padding: .1rem .32rem;
    border-radius: 4px; text-shadow: 0 1px 2px rgba(0,0,0,.55); }
  .cmcp-cv-rating--pg   { background: #16a34a; } /* PG    → green  */
  .cmcp-cv-rating--pg13 { background: #2563eb; } /* PG-13 → blue   */
  .cmcp-cv-rating--r    { background: #ea580c; } /* R     → orange */
  .cmcp-cv-rating--x    { background: #dc2626; } /* X     → red    */
  .cmcp-cv-rating--xxx  { background: #dc2626; } /* XXX   → red    */
  /* Gated favorites: black card in place of withheld media, rating centered. */
  .cmcp-cv-card.cmcp-cv-gated { background: #000; }
  .cmcp-cv-lb-stage.cmcp-cv-gated { background: #000; }
  .cmcp-cv-gatedlabel { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: rgba(0,0,0,.6); color: #fff; font-weight: 700; font-size: calc(var(--cmcp-fs, 0.8125rem) * 1.1692); letter-spacing: .06em;
    padding: .28rem .6rem; border-radius: 6px; border: 1px solid var(--p-content-border-color,#3f3f46);
    pointer-events: none; }
  .cmcp-cv-lb-stage .cmcp-cv-gatedlabel { font-size: calc(var(--cmcp-fs, 0.8125rem) * 2.4615); padding: .5rem 1.2rem; }
  .cmcp-cv-add { position: absolute; top: .3rem; right: .3rem; background: rgba(0,0,0,.55); color:#fff;
    border: none; border-radius: 6px; width: 24px; height: 24px; cursor: pointer; }
  .cmcp-cv-owned { position: absolute; top: .3rem; right: .3rem; background: rgba(34,197,94,.92);
    color: #04120a; font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.7385); font-weight: 700; padding: .12rem .35rem; border-radius: 4px; }
  .cmcp-cv-loading { text-align: center; padding: 1rem; color: var(--p-text-muted-color,#a1a1aa); }
  .cmcp-cv-progress { position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: var(--p-primary-color, #3a7bd5); opacity: .0; transition: opacity .2s; }
  .cmcp-cv-progress.on { opacity: 1; animation: cmcp-cv-pulse 1s ease-in-out infinite; }
  @keyframes cmcp-cv-pulse { 0%,100%{opacity:.3} 50%{opacity:1} }
  .cmcp-cv-filters { display: flex; flex-direction: column; gap: .7rem; }
  .cmcp-cv-frow { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; }
  .cmcp-cv-chip { padding: .25rem .5rem; border-radius: 999px; font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.9231); cursor: pointer;
    border: 1px solid var(--p-content-border-color,#3f3f46); background: transparent; color: var(--p-text-color,#fafafa); }
  .cmcp-cv-chip.on { background: var(--p-primary-color,#3a7bd5); border-color: transparent; color:#fff; }
  .cmcp-cv-flabel { font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.8615); text-transform: uppercase; letter-spacing: .04em;
    color: var(--p-text-muted-color,#a1a1aa); width: 100%; }
  .cmcp-cv-detail img, .cmcp-cv-detail video { border-radius: 8px; }
  .cmcp-cv-actions { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .5rem; }
  .cmcp-cv-wfstatus { margin-top: .5rem; padding: .45rem .6rem; border-radius: 8px; font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.96);
    line-height: 1.35; background: var(--p-surface-800,#27272a); color: var(--p-text-color,#fafafa);
    border: 1px solid var(--p-content-border-color,#3f3f46); }
  .cmcp-cv-wfstatus.warn { border-color: #d97706; color: #fcd34d; }
  .cmcp-cv-wfstatus.err { border-color: #dc2626; color: #fca5a5; }
  .cmcp-cv-viewer { position: absolute; inset: 0; z-index: 5; background: rgba(0,0,0,.94);
    display: flex; align-items: center; justify-content: center; }
  .cmcp-cv-viewer img, .cmcp-cv-viewer video { max-width: 100%; max-height: 100%; object-fit: contain; }
  .cmcp-cv-vtop { position: absolute; top: .5rem; right: .5rem; display: flex; gap: .4rem; z-index: 6; }
  .cmcp-cv-triggers { display: flex; flex-wrap: wrap; gap: .3rem; margin: .4rem 0; }
  .cmcp-cv-trigger { font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.8862); padding: .15rem .4rem; border-radius: 6px;
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
    width: 40px; height: 40px; cursor: pointer; font-size: calc(var(--cmcp-fs, 0.8125rem) * 1.2308); z-index: 3; }
  .cmcp-cv-lb-nav:hover { background: rgba(0,0,0,.8); }
  .cmcp-cv-lb-close { position: absolute; top: .6rem; right: .6rem; z-index: 3; }
  .cmcp-cv-lb-title { font-size: calc(var(--cmcp-fs, 0.8125rem) * 1.1077); font-weight: 600; display: flex; align-items: center;
    gap: .5rem; padding-right: 2.2rem; }
  .cmcp-cv-like { margin-left: auto; }
  .cmcp-cv-like.on { color: #f43f5e; border-color: #f43f5e; }
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
  .cmcp-cv-lb-muted { font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.9108); color: var(--p-text-muted-color,#a1a1aa); }
  .cmcp-cv-creators { display: flex; flex-direction: column; gap: .2rem; width: 100%;
    max-height: 13rem; overflow-y: auto; }
  .cmcp-cv-creator { display: flex; align-items: baseline; gap: .5rem; padding: .3rem .5rem;
    border-radius: 8px; border: 1px solid var(--p-content-border-color,#3f3f46);
    background: transparent; color: var(--p-text-color,#fafafa); cursor: pointer;
    text-align: left; font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.96); }
  .cmcp-cv-creator:hover { background: var(--p-surface-800,#27272a); }
  .cmcp-cv-creator .sub { margin-left: auto; font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.8369); flex-shrink: 0;
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
  .cmcp-cv-ddgroup { font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.7877); text-transform: uppercase; letter-spacing: .05em;
    color: var(--p-text-muted-color,#a1a1aa); padding: .35rem .5rem .15rem; }
  .cmcp-cv-ddopt { display: flex; align-items: center; gap: .45rem; padding: .3rem .5rem;
    border: none; border-radius: 6px; background: transparent; cursor: pointer;
    color: var(--p-text-color,#fafafa); font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.96); text-align: left; width: 100%; }
  .cmcp-cv-ddopt:hover, .cmcp-cv-ddopt.active { background: var(--p-surface-800,#27272a); }
  .cmcp-cv-ddopt .tick { width: .9rem; flex-shrink: 0; opacity: 0; }
  .cmcp-cv-ddopt.on .tick { opacity: 1; color: var(--p-primary-color,#3a7bd5); }
  .cmcp-cv-ddempty { padding: .4rem .5rem; font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.9108);
    color: var(--p-text-muted-color,#a1a1aa); }
  .cmcp-cv-ddfoot { position: sticky; bottom: -.25rem; display: flex; align-items: center;
    justify-content: space-between; gap: .5rem; margin-top: .15rem; padding: .35rem .5rem;
    font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.8862); color: var(--p-text-muted-color,#a1a1aa);
    background: var(--p-surface-900,#18181b);
    border-top: 1px solid var(--p-content-border-color,#3f3f46); }
  .cmcp-cv-ddclear { background: transparent; border: none; cursor: pointer; font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.8862);
    padding: 0; color: var(--p-primary-color,#3a7bd5); }
  .cmcp-cv-lb-prompt { font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.96); white-space: pre-wrap; word-break: break-word;
    background: var(--p-surface-950,#111); border-radius: 8px; padding: .5rem;
    max-height: 14rem; overflow-y: auto; }
  .cmcp-cv-lb-params { display: grid; grid-template-columns: max-content 1fr; gap: .15rem .6rem;
    font-size: calc(var(--cmcp-fs, 0.8125rem) * 0.9108); }
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

/** The one-line verdict on a post's embedded graph, shown in both the lightbox
 *  side pane and the standalone generation-info sheet. Factored out when these
 *  three strings were translated: the two copies were byte-identical, and three
 *  keys duplicated across two call sites is three chances for them to drift.
 *  A plain `tr()` is correct — this runs per render, long after the catalog loads. */
function embeddedWorkflowNote(wf) {
  if (!wf) return tr("civitai_ui.no_embedded_workflow", "No embedded workflow");
  if (wf.format === "ui") return tr("civitai_ui.embedded_comfyui_workflow", "✓ Embedded ComfyUI workflow");
  return tr("civitai_ui.embedded_graph_is_api_format_only_it",
    "Embedded graph is API-format only — it can't load onto the canvas, but Save keeps its JSON.");
}

/** Serialize result rows — `state.items` (media) or `state.models` (models) —
 *  to the agent's `civitai_results` contract shape: id, kind, title, creator,
 *  baseModel/type, stats, prompt, media URL(s), and `gated`. Metadata + URLs
 *  ONLY — never image bytes (the agent reasons from text + can fetch the sample
 *  thumbnail via the URLs; the human clicks to view). `gated` flags a result the
 *  grid BLURS (rating outside the enabled browsing levels) so a downstream vision
 *  consumer withholds its sample pixels — see mcp#623. Pure and exported for unit
 *  tests. `limit` is clamped to [1, 200]. */
export const CIVITAI_PROMPT_CAP = 600; // chars — bound the agent's token budget
function _capPrompt(p) {
  // Coerce a structured prompt so the outbound civitai_results contract never
  // carries a raw object (would reach the agent as "[object Object]") (#276).
  if (typeof p !== "string") p = coerceMessageText(p);
  if (!p) return null;
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
    // `gated` mirrors the grid's blur decision (mediaCard/lightbox: `x.gated ===
    // true || !<cover/thumb>`), so an agent-vision consumer (mcp#623) can withhold
    // the sample image for anything the human-facing UI renders as a blurred
    // placeholder — the NSFW/browsing-level gate is never bypassed downstream.
    gated: x.gated === true || !x.coverUrl,
  } : {
    id: x.id, kind: x.type === "video" ? "video" : "image",
    title: null, creator: x.author || null,
    baseModel: x.modelName || null, type: x.type || null,
    stats: { reactions: x.reactions ?? null },
    prompt: _capPrompt(x.prompt), // bounded — token budget (audit item 3)
    urls: [x.thumbnailUrl, x.fullUrl].filter(Boolean),
    gated: x.gated === true || !x.thumbnailUrl,
  });
  return { items, total: rows.length, loading: !!loading };
}

/** Build the `state.error` object reported by panel_civitai_results (#190).
 *  The client throws Errors carrying an HTTP `status` for upstream CivitAI
 *  failures; a transport failure (#599) carries `kind:"transport"` and status
 *  null, meaning NO HTTP response was received and the failing hop is
 *  UNDETERMINED (it does not rule CivitAI out); a true empty result sets NO
 *  error at all. Pure and exported for unit tests. */
export function civitaiErrorState(e) {
  const status = e && typeof e.status === "number" ? e.status : null;
  return {
    status,
    message: coerceMessageText(e?.message ?? e),
    ...(typeof e?.kind === "string" ? { kind: e.kind } : {}),
    // #705: the upstream body's OWN words (already bounded, flattened and
    // credential-redacted by describeUpstreamFailure) and whether retrying can
    // help. The agent being able to report "CivitAI's model search is
    // overloaded — retry shortly" instead of "503" is the point of the issue;
    // both keys are omitted when absent so a transport/empty failure keeps its
    // existing shape and cannot be read as a claim about the upstream.
    ...(typeof e?.detail === "string" && e.detail ? { detail: e.detail } : {}),
    ...(typeof e?.retryable === "boolean" ? { retryable: e.retryable } : {}),
  };
}

/** Content-provider factory for the CivitAI browser tab of the unified side
 *  panel. Builds the grid/lightbox/filter body + the agent-drive surface; the
 *  shell (cmcp-sidepanel-ui.js) owns the overlay, header, tab bar, single search
 *  box, ✕, dock and Escape. opts = {query, tab, filters, browsingLevels}. */
export function createCivitaiContent(ctx, shell, opts = {}) {
  injectCss();
  const client = new CivitaiClient(ctx.api);
  const { body } = shell;
  const search = shell.searchEl; // the shell's single search input

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
    // Distinguishing an empty grid from a FAILURE (agent-facing, issues #190/#375):
    //  error          — upstream fetch failed (e.g. { status:503, message }); an
    //                    empty grid is because the request failed, not "no matches".
    //  favoritesStatus — on the favorites tab: 'ok' | 'signed_out' |
    //                    'no_likes_collection' | 'filtered_out', so an empty
    //                    favorites feed is attributable rather than silent.
    error: null, favoritesStatus: null,
    favOut: [], // favorites outside the enabled levels, held for the catchall
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

  // Self-invalidating internal open flag: drive methods assert it and the shell
  // facade also gates on the active tab. teardown() (run by the shell's close)
  // tears down every async/listener owned here. close() closes the WHOLE side
  // panel — shareImage / loadOntoCanvas call it on success to reveal the chat.
  let isOpen = true;
  let _oauthPollIv = null;         // sign-in completion poll (accountFlow)
  let _activeLightboxClose = null; // openViewer's teardown (owns its own doc keydown listener)
  let searchTimer = null;
  const close = () => { try { shell.close(); } catch { /* already gone */ } };
  function teardown() {
    if (!isOpen) return;           // idempotent
    isOpen = false;
    state.reqId++;                 // invalidate any in-flight fetch (its guarded finally no-ops)
    state.activeReloadPromise = null;
    state.activeLoadPromise = null;
    try { clearTimeout(searchTimer); } catch { /* not armed */ }
    if (_oauthPollIv) { clearInterval(_oauthPollIv); _oauthPollIv = null; }
    // The lightbox is body-mounted with its OWN document keydown listener — tear
    // it down through this one path (codex finding).
    if (_activeLightboxClose) { try { _activeLightboxClose(); } catch { /* already gone */ } _activeLightboxClose = null; }
    try { closeSubModals(); } catch { /* already gone */ }
  }

  // The search box is the shell's single input (aliased `search`). The debounce +
  // creator-token parsing stay here; the shell dispatches keystrokes to onSearch.
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
  // The shell wires its single search input → onSearch (returned below); no
  // direct input/keydown listeners are attached here.
  // Header filter button + "dirty" dot via the shared filter helper (cmcp-filter.js)
  // — same DOM CivitAI always rendered (button.cmcp-cv-iconbtn + child span.cmcp-cv-dot,
  // margin-left:auto pushing the filter ⚙ + account 👤 pair to the subnav's right
  // edge, no title to stay byte-identical). setFilterActive lights the dot.
  const { btn: filterBtn, setActive: setFilterActive } =
    makeFilterButton({ onOpen: () => toggleFilters(), title: null });
  const acctBtn = el("button", "cmcp-cv-iconbtn");
  acctBtn.innerHTML = '<i class="pi pi-user"></i>';
  acctBtn.title = tr("civitai_ui.civitai_account", "CivitAI account");
  acctBtn.addEventListener("click", () => accountFlow());

  // Civitai sub-tabs (images / videos / checkpoints / …) — mounted in the shell
  // subnav via subnavExtras(). Reuse .cmcp-cv-tab so the themed active state +
  // the responsive container query apply here too.
  const subTabsWrap = el("div", "cmcp-cv-tabs");
  for (const t of TABS) {
    const b = el("button", "cmcp-cv-tab");
    // The label goes in as TEXT rather than through innerHTML. `lib/i18n.js` documents
    // that `tr()` "returns a string and never HTML, so it introduces no injection
    // path" — true of the helper, but only true of a call site that writes text, and
    // this was the one that wrote markup. `/i18n` merges EVERY installed pack's
    // main.json, so a label is a string another pack can influence. Same DOM as the
    // template it replaces: `el()` sets className and textContent.
    b.append(el("i", `pi ${t.icon}`), el("span", null, t.label));
    b.addEventListener("click", () => { state.tab = t.key; syncTabs(); reload(); });
    b._key = t.key;
    subTabsWrap.appendChild(b);
  }

  // Favorites media-type chips (shown only on the Favorites sub-tab).
  // Built INSIDE this function, which runs long after setup() awaited the catalog,
  // so a plain tr() is correct here — unlike module-scope TABS above, which needs
  // getters. "Images"/"Videos" reuse the sub-tab labels' keys: identical English.
  const favChips = el("div", "cmcp-cv-frow");
  for (const [label, val] of [
    [tr("civitai_ui.all", "All"), "all"],
    [tr("civitai_ui.images", "Images"), "image"],
    [tr("civitai_ui.videos", "Videos"), "video"],
  ]) {
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

  // Body content (appended into the shell's .cmcp-cv-body scroll surface on mount).
  const progress = el("div", "cmcp-cv-progress");
  const grid = el("div", "cmcp-cv-grid");
  const sentinel = el("div", "cmcp-cv-loading");
  const searchOverlay = el("div", "cmcp-cv-searching");
  searchOverlay.appendChild(el("div", "cmcp-cv-spinner"));
  searchOverlay.style.display = "none";
  // Infinite scroll: the shell body is the scroll surface. Wired on activate.
  const onBodyScroll = () => {
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 600) loadMore();
  };

  function syncTabs() {
    for (const b of subTabsWrap.children) b.classList.toggle("active", b._key === state.tab);
    favChips.style.display = tabDef().fav ? "" : "none";
    for (const c of favChips.children) c.classList.toggle("on", c._fv === state.favType);
    setFilterActive(filtersDirty(state.filters));
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
    state.error = null; state.favoritesStatus = null; // cleared per generation
    state.favOut = []; // favorites outside the enabled levels, held for the catchall
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
    sentinel.textContent = tr("civitai_ui.loading", "Loading…");
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
        if (!state.signedIn) {
          sentinel.textContent = tr("civitai_ui.sign_in_to_see_your_favorites", "Sign in to see your favorites.");
          // Distinct agent-facing status so an empty favorites feed isn't read as
          // "you have no favourites" when the real cause is a signed-out session (#375).
          state.favoritesStatus = "signed_out";
          setLoading(false); return;
        }
        // Fetch the WHOLE likes collection regardless of the browsing-level
        // mask, so a favorite whose rating is outside the enabled levels still
        // comes back instead of vanishing (the "Favorites shows 0 results"
        // bug). Those items render as BLACK PLACEHOLDER cards: their media URL
        // is never loaded, so no R/X/XXX imagery leaks even in a session with
        // no NSFW consent (the original codex finding) — only the rating label,
        // creator, and heart count show. `enabledMask` marks which items are
        // gated (rating not in the active levels) for the card renderer. The
        // subnav chips narrow by type; the feed reads the likes COLLECTION
        // (auto-detected) — reactions only hold in-app hearts; see
        // resolveLikesCollectionId.
        const enabledMask = bitmask(levels);
        const colId = await resolveLikesCollectionId(client);
        if (req !== state.reqId) return;
        // The likes collection couldn't be auto-detected (>1 collection, none
        // named fav/like) — the feed falls back to in-app reactions, which may
        // legitimately be empty. Flag it so the agent doesn't confidently report
        // "no favourites" when the real cause is an undetectable likes folder (#375).
        if (!colId) state.favoritesStatus = "no_likes_collection";
        const firstPage = state.cursor == null;
        // Favorites is a personal collection; the shared period default ("Week")
        // hides older likes → "no results". Fall back to All-Time when a period
        // empties the FIRST page, and remember it (state.favPeriod) so paging keeps
        // the same period. Still honors sort + the client-side filters below.
        let usePeriod = firstPage ? f.period : (state.favPeriod || f.period);
        const favArgs = (period, cursor) => ({
          cursor, levels: LEVELS.map((l) => l.level), sort: f.imageSort, period,
          ...(colId ? { collectionId: colId } : {}),
          ...(state.favType !== "all" ? { types: [state.favType] } : {}),
        });
        let page = await client.fetchFavorites(favArgs(usePeriod, state.cursor));
        if (req !== state.reqId) return;
        if (firstPage && (page.items?.length ?? 0) === 0 && usePeriod !== "AllTime") {
          usePeriod = "AllTime";
          page = await client.fetchFavorites(favArgs("AllTime", null));
          if (req !== state.reqId) return;
        }
        state.favPeriod = usePeriod;
        state.cursor = page.nextCursor; state.done = !page.nextCursor;
        // Dedup on id: the feed pages by "last item id" (see the client's
        // cursor quirk) — if CivitAI ever flips its keyset comparison to
        // inclusive, the boundary item would come back twice.
        // Favorites has no server-side text / base-model / creator filter — apply
        // the active filter panel client-side. image.getInfinite carries no prompt
        // text, so a text query matches the author or model name; the base-model
        // chips match the item's own baseModel; the @creator qualifier matches the
        // author. (A page emptied by these shows the manual "Load more" below.)
        const seen = new Set(state.items.map((i) => i.id));
        const q = state.query.toLowerCase();
        const bms = f.baseModels;
        const creator = f.username ? f.username.toLowerCase() : null;
        const favMatch = (it) => {
          const model = (it.modelName || "").toLowerCase();
          const author = (it.author || "").toLowerCase();
          if (q && !(author.includes(q) || model.includes(q) ||
                     (it.prompt || "").toLowerCase().includes(q))) return false;
          if (bms.length && !bms.some((b) => matchesBaseModel(it.modelName || "", b))) return false;
          if (creator && author !== creator) return false;
          return true;
        };
        const matched = page.items.filter((it) => !seen.has(it.id) && favMatch(it));
        // Show ONLY favorites whose rating is in the enabled levels; buffer the
        // rest. Catchall: if the exhausted feed has nothing in-level, fall back to
        // showing ALL matching favorites (out-of-level ones as gated placeholders)
        // so a strict level pick never dead-ends on an empty grid.
        const inLevel = [];
        for (const it of matched) {
          if (it.nsfwLevel & enabledMask) { it.gated = false; inLevel.push(it); }
          else state.favOut.push(it);
        }
        appendItems(inLevel);
        if (state.done && state.items.length === 0 && state.favOut.length) {
          for (const it of state.favOut) it.gated = true;
          appendItems(state.favOut);
          state.favOut = [];
        }
        const filtering = !!q || bms.length > 0 || !!creator;
        stalled = !inLevel.length && !state.done && (filtering || enabledMask !== 31);
        // Resolve the favorites status for the agent (unless a more specific one —
        // signed_out / no_likes_collection — was already set): everything got
        // filtered out by the active query/base-model/creator/level filters, vs. a
        // genuine empty collection ('ok'). Only decide 'filtered_out' once the feed
        // is exhausted with nothing shown but something WAS fetched-and-dropped.
        if (state.favoritesStatus == null) {
          if (state.done && state.items.length === 0) {
            state.favoritesStatus = filtering ? "filtered_out" : "ok";
          } else {
            state.favoritesStatus = "ok";
          }
        }
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
        // #712 — accumulate what the BROWSING LEVEL removed, so an empty model
        // grid is attributable the way an empty favorites feed already is
        // (#190/#375). Without this, a level that hid every result looked
        // identical to "nothing matched your search", and the docked browser
        // read as broken.
        state.hiddenByLevel = (state.hiddenByLevel || 0) + (page.hiddenByLevel || 0);
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
        const more = el("button", "cmcp-btn",
          tr("civitai_ui.no_matches_yet_keep_searching", "No matches yet — keep searching"));
        more.addEventListener("click", () => loadMore());
        sentinel.appendChild(more);
      } else if (state.done && !grid.children.length) {
        sentinel.textContent = tr("civitai_ui.no_results", "No results.");
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
      if (req === state.reqId) {
        sentinel.textContent = tr("civitai_ui.civitai_error", "CivitAI error: ") + (e.message || e);
        // Record the failure so the agent-facing panel_civitai_results can report
        // a distinct error state instead of an indistinguishable total:0 (#190);
        // kind:"transport" marks a failure where no HTTP response was received
        // at all; which hop failed is undetermined (#599, civitaiErrorState).
        state.error = civitaiErrorState(e);
      }
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
  const _RATING_CLASS = { PG: "pg", "PG-13": "pg13", R: "r", X: "x", XXX: "xxx" };
  function ratingBadge(nsfwLevel) {
    const label = levelLabel(nsfwLevel);
    const cls = _RATING_CLASS[label] || "pg";
    return el("span", `cmcp-cv-rating cmcp-cv-rating--${cls}`, label);
  }
  function mediaCard(it, idx) {
    const card = el("div", "cmcp-cv-card");
    card.dataset.id = String(it.id);
    card.dataset.kind = "media";
    card.appendChild(ratingBadge(it.nsfwLevel));
    // Gated (rating outside the enabled browsing levels) or no usable media:
    // render a BLACK placeholder with the rating label centered — never load
    // the thumbnail/clip — but keep every overlay (▶ for video, the ♥ heart
    // count + @creator foot, and the hover like button) so the card is still
    // scannable and likable.
    const gated = it.gated === true || !it.thumbnailUrl;
    if (gated) {
      card.classList.add("cmcp-cv-gated");
      if (it.type === "video") card.appendChild(el("span", "cmcp-cv-badge", "▶"));
      card.appendChild(el("span", "cmcp-cv-gatedlabel", levelLabel(it.nsfwLevel)));
    } else {
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
        likeBtn.title = !state.signedIn
          ? tr("civitai_ui.sign_in_to_civitai_to_like", "Sign in to CivitAI to like")
          : on
            ? tr("civitai_ui.unlike_on_civitai", "Unlike on CivitAI")
            : tr("civitai_ui.like_on_civitai", "Like on CivitAI");
      };
      paintLike();
      card.addEventListener("mouseenter", paintLike); // resync after lightbox toggles
      likeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!state.signedIn) {
          toast(tr("civitai_ui.sign_in_to_civitai_to_like_opening", "Sign in to CivitAI to like — opening sign-in…"));
          accountFlow();
          return;
        }
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
    if (owned(m.fileName)) card.appendChild(el("span", "cmcp-cv-owned", tr("civitai_ui.in_library", "✓ In library")));
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
        ? tr("civitai_ui.civitai_permissions_changed_use_the_account_button",
          "CivitAI permissions changed -- use the account button to sign out and back in.")
        : tr("civitai_ui.like_failed", "Like failed: {error}", { error: msg }));
      return;
    }
    const col = likesCollection();
    if (col?.id) {
      client.setImageInCollection(it.id, col.id, next).catch((e) =>
        toast(tr("civitai_ui.couldn_t_update_collection", "Couldn't update collection \"{name}\": {error}",
          { name: col.name, error: e.message || e })));
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
    const closeBtn2 = mk("pi-times", closeLb, tr("civitai_ui.close_esc", "Close (Esc)"));
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
      // left: the media itself — unless gated (rating outside the enabled
      // levels) or missing a URL, in which case the stage stays BLACK with the
      // rating label centered. No <img>/<video> is created, so no withheld
      // media loads; the side panel (creator, actions) is unaffected.
      stage.innerHTML = "";
      const gated = it.gated === true || !it.fullUrl;
      stage.classList.toggle("cmcp-cv-gated", gated);
      if (gated) {
        stage.appendChild(el("span", "cmcp-cv-gatedlabel", levelLabel(it.nsfwLevel)));
      } else if (it.type === "video") {
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
      // Anonymous posts fall back to "CivitAI <kind>". Two whole keys rather than
      // interpolating `it.type` — that field is the API's wire value ("image"/"video")
      // and splicing it into a translated sentence would leave an English word inside
      // a Korean title.
      const kindLabel = it.type === "video"
        ? tr("civitai_ui.civitai_video", "CivitAI video")
        : tr("civitai_ui.civitai_image", "CivitAI image");
      titleRow.appendChild(el("span", null,
        `${it.type === "video" ? "🎬" : "🖼"} ${it.author ? "@" + it.author : kindLabel}`));
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
          likeBtn.title = !state.signedIn
            ? tr("civitai_ui.sign_in_to_civitai_to_like", "Sign in to CivitAI to like")
            : on
              ? tr("civitai_ui.unlike_on_civitai", "Unlike on CivitAI")
              : tr("civitai_ui.like_on_civitai", "Like on CivitAI");
        };
        paintLike();
        likeBtn.addEventListener("click", () => {
          if (!state.signedIn) {
            toast(tr("civitai_ui.sign_in_to_civitai_to_like_opening", "Sign in to CivitAI to like — opening sign-in…"));
            accountFlow();
            return;
          }
          void toggleLike(it, paintLike);
        });
        titleRow.appendChild(likeBtn);
      }
      side.appendChild(titleRow);
      side.appendChild(el("div", "cmcp-cv-lb-muted",
        `♥ ${it.reactions || 0} · ${idx + 1} / ${state.items.length}${state.done ? "" : "+"}`));

      const actions = el("div", "cmcp-cv-actions");
      if (it.author) {
        const moreBtn = el("button", "cmcp-btn",
          tr("civitai_ui.see_more_from", "See more from @{creator}", { creator: it.author }));
        moreBtn.addEventListener("click", () => {
          closeLb();
          seeMoreFromCreator(it.author);
        });
        actions.appendChild(moreBtn);
      }
      side.appendChild(actions);
      const genBox = el("div");
      genBox.appendChild(el("div", "cmcp-cv-lb-muted",
        tr("civitai_ui.loading_generation_info", "Loading generation info…")));
      side.appendChild(genBox);

      genFor(it).then((gen) => {
        if (seq !== renderSeq) return; // user already paged on
        // actions need the gen payload (caption/workflow), so they land here
        const shareBtn = el("button", "cmcp-btn cmcp-btn-primary",
          ctx.isMuted() ? tr("civitai_ui.save_reference_to_inputs", "Save reference to inputs") : tr("civitai_ui.share_with_agent", "Share with agent"));
        shareBtn.addEventListener("click", () => shareImage(it, gen));
        actions.appendChild(shareBtn);
        const wf = CivitaiClient.comfyGraphInfo(gen.meta);
        if (wf) {
          if (wf.format === "ui") {
            const loadBtn = el("button", "cmcp-btn", tr("civitai_ui.load_onto_canvas", "Load onto canvas"));
            loadBtn.title = tr("civitai_ui.replace_the_current_canvas_with_this_post", "Replace the current canvas with this post's embedded ComfyUI workflow (Ctrl+Z undoes it).");
            loadBtn.addEventListener("click", () => { void loadOntoCanvas(wf.graph, closeLb); });
            actions.appendChild(loadBtn);
            // Same loadable-workflow condition as "Load onto canvas": load the graph,
            // then jump to the Apps tab's convert view seeded from the live canvas.
            const appBtn = el("button", "cmcp-btn", tr("civitai_ui.create_app_from_workflow", "Create App from workflow"));
            appBtn.title = tr("civitai_ui.load_this_workflow_onto_the_canvas_and", "Load this workflow onto the canvas and package it as a one-click app.");
            appBtn.addEventListener("click", () => {
              void createAppFromWorkflow(() => loadOntoCanvas(wf.graph, closeLb, { keepPanelOpen: true }));
            });
            actions.appendChild(appBtn);
          }
          const saveBtn = el("button", "cmcp-btn", tr("civitai_ui.save_workflow", "Save workflow"));
          saveBtn.addEventListener("click", () => saveWorkflow(it, wf.graph));
          actions.appendChild(saveBtn);
        }
        genBox.innerHTML = "";
        genBox.appendChild(el("div", "cmcp-cv-lb-muted", embeddedWorkflowNote(wf)));
        if (gen.meta?.prompt) {
          // Distinct from `civitai_ui.prompt` ("Prompt: "), which is a sentence prefix.
          genBox.appendChild(el("div", "cmcp-cv-flabel", tr("civitai_ui.prompt_label", "Prompt")));
          genBox.appendChild(el("div", "cmcp-cv-lb-prompt", gen.meta.prompt));
        }
        if (gen.meta?.negativePrompt) {
          genBox.appendChild(el("div", "cmcp-cv-flabel", tr("civitai_ui.negative", "Negative")));
          genBox.appendChild(el("div", "cmcp-cv-lb-prompt", gen.meta.negativePrompt));
        }
        const params = CivitaiClient.params(gen.meta);
        if (params.length) {
          genBox.appendChild(el("div", "cmcp-cv-flabel", tr("civitai_ui.parameters", "Parameters")));
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
        genBox.appendChild(el("div", "cmcp-cv-lb-muted",
          tr("civitai_ui.no_generation_data", "No generation data: {error}", { error: e.message || e })));
        // sharing works without gen data — caption just has no settings
        const shareBtn = el("button", "cmcp-btn cmcp-btn-primary",
          ctx.isMuted() ? tr("civitai_ui.save_reference_to_inputs", "Save reference to inputs") : tr("civitai_ui.share_with_agent", "Share with agent"));
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
    const sheet = openSubModal(tr("civitai_ui.generation_info", "Generation info"));
    sheet.body.appendChild(el("div", "cmcp-cv-loading", tr("civitai_ui.loading", "Loading…")));
    let gen;
    try { gen = await client.getGenerationData(it.id); }
    catch (e) {
      sheet.body.innerHTML = "";
      sheet.body.appendChild(el("div", null, tr("civitai_ui.no_data", "No data: {error}", { error: e.message })));
      return;
    }
    sheet.body.innerHTML = "";
    const wf = CivitaiClient.comfyGraphInfo(gen.meta);
    sheet.body.appendChild(el("div", null, embeddedWorkflowNote(wf)));

    const actions = el("div", "cmcp-cv-actions");
    const shareBtn = el("button", "cmcp-btn cmcp-btn-primary",
      ctx.isMuted() ? tr("civitai_ui.save_reference_to_inputs", "Save reference to inputs") : tr("civitai_ui.share_with_agent", "Share with agent"));
    shareBtn.addEventListener("click", () => shareImage(it, gen));
    actions.appendChild(shareBtn);
    if (wf) {
      if (wf.format === "ui") {
        const loadBtn = el("button", "cmcp-btn", tr("civitai_ui.load_onto_canvas", "Load onto canvas"));
        loadBtn.title = tr("civitai_ui.replace_the_current_canvas_with_this_example", "Replace the current canvas with this example's embedded ComfyUI workflow (Ctrl+Z undoes it).");
        loadBtn.addEventListener("click", () => { void loadOntoCanvas(wf.graph); });
        actions.appendChild(loadBtn);
      }
      const saveBtn = el("button", "cmcp-btn", tr("civitai_ui.save_workflow", "Save workflow"));
      saveBtn.addEventListener("click", () => saveWorkflow(it, wf.graph));
      actions.appendChild(saveBtn);
    }
    sheet.body.appendChild(actions);

    for (const [k, val] of CivitaiClient.params(gen.meta)) {
      const row = el("div"); row.style.cssText = "font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96);margin-top:.2rem";
      row.textContent = `${k}: ${val}`;
      sheet.body.appendChild(row);
    }
    if (gen.meta?.prompt) {
      const p = el("div"); p.style.cssText = "font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96);margin-top:.5rem;white-space:pre-wrap";
      p.textContent = tr("civitai_ui.prompt", "Prompt: ") + coerceMessageText(gen.meta.prompt); sheet.body.appendChild(p);
    }
  }

  // NOT translated, deliberately: every line below is a PROMPT addressed to the
  // agent, not UI copy. It is composed alongside English tool names and parameter
  // labels ("Prompt:", "Steps", "CFG scale" straight off CivitAI's payload), and
  // handing the model a half-translated instruction is a regression in the one
  // thing it has to get right. Same rule as the monolith's own reconnect nudges.
  // The human-facing confirmations around it (the toasts) ARE translated.
  function buildCaption(gen) {
    const m = gen.meta || {};
    const lines = [
      "Recreate this CivitAI example as closely as you can — match the reference and use these settings (use our local model if we have it, else download it first):",
      "",
    ];
    // Coerce prompt fields — a structured prompt/negative must not reach the
    // outbound share-with-agent caption as "[object Object]" (#276).
    if (m.prompt) lines.push("Prompt: " + coerceMessageText(m.prompt));
    if (m.negativePrompt) lines.push("Negative: " + coerceMessageText(m.negativePrompt));
    for (const [k, v] of CivitaiClient.params(m)) lines.push(`${k}: ${v}`);
    return lines.join("\n");
  }

  async function shareImage(it, gen) {
    try {
      const blob = await (await fetch(it.fullUrl)).blob();
      const name = `civitai_ref_${it.id}.${it.type === "video" ? "mp4" : "jpeg"}`;
      const ref = await ctx.uploadBlobToInput(blob, name);
      // #1188 — `uploadBlobToInput` answers null for EVERY failure, and neither branch below
      // checked. Muted, that announced "Saved {name} to ComfyUI inputs." for an upload that
      // wrote nothing; unmuted, `ref.filename` threw a TypeError whose message ("Cannot read
      // properties of null") told the user nothing about the upload. Pre-existing, but #1188
      // makes null reachable by a new route — a bounded upload that gives up now returns it
      // where the call previously hung — so the fabricated success is left no wider than it
      // was found. `close()` is deliberately not called: a failed share leaves the explorer
      // open to retry, exactly as the catch below does.
      if (!ref) {
        toast(tr("civitai_ui.share_failed", "Share failed: {error}", { error: name }));
        return;
      }
      if (ctx.isMuted()) {
        toast(tr("civitai_ui.saved_to_comfyui_inputs", "Saved {name} to ComfyUI inputs.", { name }));
      } else {
        const caption = buildCaption(gen);
        ctx.sendUserMessage(
          `${caption}\n\nThe reference is uploaded to the ComfyUI input/ folder as \`${coerceMessageText(ref.filename)}\` — use it as the target to match.`,
          undefined, [ref],
        );
        ctx.bringChatForward();
        toast(tr("civitai_ui.shared_with_the_agent", "Shared with the agent."));
      }
      // Hand-off is done (either variant) — close the explorer so the chat/agent
      // is visible. Only on SUCCESS; a failed share (below) leaves it open to
      // retry. The toast is body-mounted (survives the close) so the confirmation
      // stays on screen. close() is idempotent + tears down the lightbox/sheets.
      close();
    } catch (e) { toast(tr("civitai_ui.share_failed", "Share failed: {error}", { error: e.message })); }
  }

  async function saveWorkflow(it, graph) {
    try {
      const res = await ctx.callTool("save_workflow",
        { action: "save", filename: `civitai_${it.id}.json`, workflow: graph }, { timeout: 60000 });
      toast(res.ok
        ? tr("civitai_ui.workflow_saved_to_your_machine", "Workflow saved to your machine.")
        : tr("civitai_ui.save_failed", "Save failed: {error}", { error: res.error || "?" }));
    } catch (e) { toast(tr("civitai_ui.save_failed", "Save failed: {error}", { error: e.message })); }
  }

  // ── load a UI-format workflow onto the live canvas ───────────────────
  /** Confirm-if-dirty (fail-closed — see graphDirtyForConfirm), then load via
   *  the bridge's undoable graph_load path (snapshot → await loadGraphData →
   *  checkState — one load = one Ctrl+Z step). Success is only announced —
   *  and the explorer only closed — after the awaited load actually landed;
   *  `beforeClose` runs first (e.g. the lightbox, which isn't a sub-modal).
   *  `opts.keepPanelOpen` keeps the unified side-panel up after a successful land
   *  (the create-app-from-workflow hop needs to switch to the Apps tab rather than
   *  dismiss the explorer); the originating lightbox/sub-modal is still closed.
   *  Returns true when it loaded. */
  async function loadOntoCanvas(graph, beforeClose, opts = {}) {
    if (typeof ctx.loadGraph !== "function") {
      toast(tr("civitai_ui.this_panel_build_can_t_load_onto", "This panel build can't load onto the canvas."));
      return false;
    }
    // Two keys joined by the blank line rather than one key holding "\n\n": a
    // translator editing a single value is one stray keystroke away from losing the
    // paragraph break, and the question and the warning translate independently.
    if (graphDirtyForConfirm(ctx) && !window.confirm(
      tr("civitai_ui.load_this_workflow_onto_the_canvas", "Load this workflow onto the canvas?") + "\n\n" +
      tr("civitai_ui.your_current_workflow_has_unsaved_changes_that",
        "Your current workflow has unsaved changes that will be replaced (Ctrl+Z undoes the load)."),
    )) return false;
    let res;
    try {
      res = await ctx.loadGraph(graph);
    } catch (e) {
      toast(tr("civitai_ui.couldn_t_load_workflow", "Couldn't load workflow: {error}", { error: e.message || e }));
      return false;
    }
    // Defend against a silent no-op: if the load reported zero nodes the graph
    // didn't actually land — don't dismiss the explorer as if it succeeded.
    if (!res || !res.node_count) {
      toast(tr("civitai_ui.the_workflow_loaded_empty_0_nodes_nothing",
        "The workflow loaded empty (0 nodes) — nothing was placed on the canvas."));
      return false;
    }
    if (beforeClose) { try { beforeClose(); } catch { /* already gone */ } }
    closeSubModals();
    // keepPanelOpen: the create-app-from-workflow flow hops to the Apps tab next,
    // so the side-panel must stay up; a plain load closes the whole explorer.
    if (!opts.keepPanelOpen) close();
    // Counted: `{count}` drives Intl.PluralRules, so Russian gets one/few/many and
    // Korean a single form — neither is reachable from an inline `=== 1 ? "" : "s"`.
    toast(tr("civitai_ui.workflow_loaded", {
      one: "Workflow loaded onto the canvas — {count} node. Ctrl+Z undoes it.",
      other: "Workflow loaded onto the canvas — {count} nodes. Ctrl+Z undoes it.",
    }, { count: res.node_count }));
    return true;
  }

  /** "Create App from workflow": run `loadWorkflow` (a thunk that loads a UI-format
   *  graph onto the canvas with the panel kept open — reusing whichever existing
   *  load path the calling surface uses, so the dirty-confirm + undoable graph_load
   *  + empty-guard stay identical to that surface's plain "Load onto canvas"
   *  button), then hop to the Apps tab and open its convert view seeded from the
   *  now-loaded canvas. The loader resolves truthy only when the graph actually
   *  landed; on a failed/cancelled/gated load we stay put (the loader already
   *  toasted). Both the media lightbox and the model-detail surface share this. */
  async function createAppFromWorkflow(loadWorkflow) {
    const loaded = await loadWorkflow();
    if (!loaded) return; // load failed / was cancelled — stay put (toast already shown)
    try {
      if (typeof shell.switchTab === "function") shell.switchTab("apps", { view: "convert" });
      else toast(tr("civitai_ui.this_panel_build_can_t_open_the", "This panel build can't open the Apps tab."));
    } catch (e) {
      toast(tr("civitai_ui.couldn_t_open_the_apps_tab", "Couldn't open the Apps tab: {error}", { error: e.message || e }));
    }
  }

  /** Download a model-version workflow file (raw .json or civitai's zip
   *  wrapper), extract the UI-format graph(s), and load onto the canvas —
   *  with a picker when an archive holds several. Reports progress and EVERY
   *  failure through `opts.setStatus` (an inline line in the detail sheet) as
   *  well as a toast, and NEVER closes the sheet on failure — only a genuine
   *  canvas load (via loadOntoCanvas) dismisses the explorer. `opts.keepPanelOpen`
   *  threads through to loadOntoCanvas so the create-app-from-workflow hop keeps
   *  the side-panel up. Resolves truthy only when a graph actually landed (the
   *  single-file case, or a chosen entry from the multi-workflow picker). */
  async function loadVersionWorkflow(version, file, opts = {}) {
    const setStatus = opts.setStatus || (() => {});
    const say = (msg, kind = "err") => { setStatus(msg, kind); toast(msg); };
    setStatus(tr("civitai_ui.fetching_workflow", "Fetching workflow…"), "info");
    let bytes;
    try {
      bytes = await client.downloadVersionFile(version.id, file);
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        // Some workflow files are gated (the proxy returns 401 when civitai
        // redirects the download to /login). The account button is the way in;
        // offer it right here so the hint is actionable, not just informative.
        say(state.signedIn
          ? tr("civitai_ui.civitai_refused_this_download_this_file_may",
            "CivitAI refused this download — this file may need early access or a purchase. Try the account (👤) button to re-check your sign-in.")
          : tr("civitai_ui.this_workflow_is_gated_sign_in_to",
            "This workflow is gated — sign in to CivitAI (the account 👤 button) to download it, then try again."), "warn");
        if (!state.signedIn && opts.signIn) {
          setStatus(tr("civitai_ui.this_workflow_is_gated_opening_civitai_sign",
            "This workflow is gated — opening CivitAI sign-in…"), "warn");
          try { opts.signIn(); } catch { /* account flow unavailable */ }
        }
      } else {
        say(tr("civitai_ui.download_failed", "Download failed: {error}", { error: e.message || e }));
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
        ? tr("civitai_ui.couldn_t_read_the_download_civitai_may",
          "Couldn't read the download — CivitAI may require sign-in for this file (account 👤 button).")
        : tr("civitai_ui.couldn_t_read_the_workflow_file",
          "Couldn't read the workflow file: {error}", { error: e.message || e }), notZip ? "warn" : "err");
      return;
    }
    const uis = candidates.filter((c) => c.format === "ui");
    if (!uis.length) {
      say(candidates.length
        ? tr("civitai_ui.this_file_only_holds_an_api_format",
          "This file only holds an API-format graph — it can't load as an editable canvas workflow. Ask the agent to run it instead.")
        : tr("civitai_ui.no_comfyui_workflow_found_in_that_file",
          "No ComfyUI workflow found in that file."), "warn");
      return;
    }
    setStatus("", "info"); // clear before a successful load closes the explorer
    // keepPanelOpen threads through to every loadOntoCanvas call so the create-app
    // flow keeps the side-panel up (the detail sheet still closes). The resolved
    // boolean = "a graph actually landed", so createAppFromWorkflow hops only on a
    // real load.
    const keepPanelOpen = !!opts.keepPanelOpen;
    if (uis.length === 1) return await loadOntoCanvas(uis[0].graph, undefined, { keepPanelOpen });
    // several workflows in one archive — let the user pick.
    return await new Promise((resolve) => {
      let picking = false; // a pick is in flight — its closeSubModals teardown must not resolve false
      const picker = openSubModal(tr("civitai_ui.pick_a_workflow_to_load", "Pick a workflow to load"),
        () => { if (!picking) resolve(false); });
      const list = el("div", "cmcp-cv-creators");
      list.style.maxHeight = "24rem";
      for (const c of uis) {
        const b = el("button", "cmcp-cv-creator");
        b.appendChild(el("span", null, c.name));
        b.appendChild(el("span", "sub", tr("civitai_ui.n_nodes", {
          one: "{count} node", other: "{count} nodes",
        }, { count: c.graph.nodes.length })));
        b.addEventListener("click", () => {
          picking = true;
          loadOntoCanvas(c.graph, undefined, { keepPanelOpen }).then((ok) => {
            if (ok) resolve(true);
            else picking = false; // failed — let another pick (or a close) settle it
          });
        });
        list.appendChild(b);
      }
      picker.body.appendChild(list);
    });
  }

  // ── model detail ─────────────────────────────────────────────────────
  async function openModelDetail(m) {
    const sheet = openSubModal(m.name);
    sheet.body.appendChild(el("div", "cmcp-cv-loading", tr("civitai_ui.loading", "Loading…")));
    let detail;
    try { detail = await client.fetchModelDetail(m.id, { levels: state.filters.browsingLevels }); }
    catch (e) {
      sheet.body.innerHTML = "";
      sheet.body.appendChild(el("div", null, tr("civitai_ui.error", "Error: {error}", { error: e.message })));
      return;
    }
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
        have ? tr("civitai_ui.in_library_re_download", "✓ In library — re-download")
             : (ctx.isMuted()
               ? tr("civitai_ui.download_to_my_machine", "Download to my machine")
               : tr("civitai_ui.ask_agent_to_download", "Ask agent to download")));
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
          wfFiles.length > 1
            ? tr("civitai_ui.load_onto_canvas_named", "Load onto canvas — {name}", { name: f.name })
            : tr("civitai_ui.load_workflow_onto_canvas", "Load workflow onto canvas"));
        const size = f.sizeKB != null
          ? (f.sizeKB >= 1024 ? (f.sizeKB / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(f.sizeKB)) + " KB")
          : null;
        // Filename and size compose OUTSIDE the sentence: both are literals CivitAI
        // supplies, and a translator must be free to move `{file}` where their
        // grammar puts an object without also owning the "name (size)" formatting.
        const fileLabel = `${f.name}${size ? ` (${size})` : ""}`;
        b.title = tr("civitai_ui.download_and_load_it_onto_the_canvas",
          "Download {file} and load it onto the canvas (Ctrl+Z undoes it).", { file: fileLabel });
        b.addEventListener("click", () => { void loadVersionWorkflow(version, f, { setStatus, signIn: () => accountFlow() }); });
        dl.appendChild(b);
        // Same loadable-workflow condition as "Load onto canvas" (every wfFile is
        // loadable): load the SELECTED version's workflow with the panel kept open,
        // then hop to the Apps convert view seeded from the now-loaded canvas.
        const appB = el("button", "cmcp-btn",
          wfFiles.length > 1
            ? tr("civitai_ui.create_app_named", "Create App — {name}", { name: f.name })
            : tr("civitai_ui.create_app_from_workflow", "Create App from workflow"));
        appB.title = tr("civitai_ui.download_this_workflow_load_it_onto_the", "Download this workflow, load it onto the canvas, and package it as a one-click app.");
        appB.addEventListener("click", () => {
          void createAppFromWorkflow(
            () => loadVersionWorkflow(version, f, { setStatus, signIn: () => accountFlow(), keepPanelOpen: true }),
          );
        });
        dl.appendChild(appB);
      }
      if (have) {
        const note = el("span", null, tr("civitai_ui.you_already_have_this_file_locally", "You already have this file locally."));
        note.style.cssText = "font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8862);color:#4ade80;align-self:center";
        dl.appendChild(note);
      }
      if (detail.creator) {
        const moreBtn = el("button", "cmcp-btn",
          tr("civitai_ui.see_more_from", "See more from @{creator}", { creator: detail.creator }));
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
        desc.style.cssText = "font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96);margin-top:.5rem";
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
        detailBody.appendChild(el("div", "cmcp-cv-flabel", tr("civitai_ui.examples", "Examples")));
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
      toast(tr("civitai_ui.downloading", "Downloading…"));
      try {
        const res = await ctx.callTool("download_model",
          { action: "download_civitai", model_id: detail.id, model_version_id: version.id, target_subfolder: subfolder },
          { timeout: 20 * 60000 });
        toast(res.ok
          ? tr("civitai_ui.downloaded_to_your_machine", "Downloaded to your machine.")
          : tr("civitai_ui.download_failed", "Download failed: {error}", { error: res.error || "?" }));
      } catch (e) { toast(tr("civitai_ui.download_error", "Download error: {error}", { error: e.message })); }
    } else {
      // The request itself stays English — see buildCaption: it is a prompt for the
      // agent, carrying wire ids and the API's own `detail.type` ("Checkpoint"/"LORA").
      ctx.sendUserMessage(
        `Please download the CivitAI ${detail.type} "${detail.name}"` +
        (version.name ? ` (version "${version.name}")` : "") +
        ` — model_id ${detail.id}, version ${version.id} — into ${subfolder}, then we'll use it.`);
      ctx.bringChatForward();
      toast(tr("civitai_ui.asked_the_agent_to_download_it", "Asked the agent to download it."));
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
    const sheet = openSubModal(tr("civitai_ui.filters", "Filters"), () => {
      clearTimeout(crTimer); crTimer = null;
      crReq++;
    });
    const update = () => { syncTabs(); reload(); };

    const renderSheet = () => {
      clearTimeout(crTimer); crTimer = null; // pending lookups target dead nodes
      const f = state.filters;
      sheet.body.innerHTML = "";
      const wrap = el("div", "cmcp-cv-filters");

      // Delegates to the shared chip-row builder (cmcp-filter.js) — same DOM, same
      // click semantics (toggle → re-render the sheet so the pressed state flips,
      // then reload the feed behind it).
      const chipRow = (label, options, isOn, onToggle) =>
        filterChipRow(wrap, label, options, isOn, (v) => { onToggle(v); renderSheet(); update(); });

      // Only the ROW headings are translated. The chip labels are CivitAI's own query
      // values echoed back as their own label (`{ label: p, value: p }`) — translating
      // one would translate the other and send e.g. "주" as the `period` parameter.
      chipRow(tr("civitai_ui.time_period", "Time period"), PERIODS.map((p) => ({ label: p, value: p })),
        (v) => f.period === v, (v) => { f.period = v; });
      const sorts = isModelTab() ? MODEL_SORTS : IMAGE_SORTS;
      chipRow(tr("civitai_ui.sort", "Sort"), sorts.map((s) => ({ label: s, value: s })),
        (v) => (isModelTab() ? f.modelSort : f.imageSort) === v,
        (v) => { if (isModelTab()) f.modelSort = v; else f.imageSort = v; });
      // browsing levels — ALL selectable, no sign-in gate. `l.label` is a content-rating
      // code (PG / PG-13 / R / X / XXX); those are international and stay English.
      chipRow(tr("civitai_ui.browsing_level", "Browsing level"), LEVELS.map((l) => ({ label: l.label, value: l.level })),
        (v) => f.browsingLevels.includes(v),
        (v) => {
          const i = f.browsingLevels.indexOf(v);
          if (i >= 0) f.browsingLevels.splice(i, 1); else f.browsingLevels.push(v);
          if (f.browsingLevels.length === 0) f.browsingLevels.push(1);
        });

      // base model omni-search
      wrap.appendChild(el("div", "cmcp-cv-flabel", tr("civitai_ui.base_model", "Base model")));
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
      bmSearch.placeholder = tr("civitai_ui.search_base_models", "Search base models…");
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
        listbox.setAttribute("aria-label", tr("civitai_ui.base_model", "Base model"));
        bmPanel.appendChild(listbox);
        const hits = BASE_MODELS.filter((x) => matchesBaseModel(x, query));
        // Section headings, not values — the base-model NAMES inside each group are
        // CivitAI's own spellings and stay as-is.
        const groups = [
          [tr("civitai_ui.current", "Current"), hits.filter((x) => ACTIVE_BASE_MODELS.has(x))],
          [tr("civitai_ui.legacy", "Legacy"), hits.filter((x) => !ACTIVE_BASE_MODELS.has(x))],
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
          bmPanel.appendChild(el("div", "cmcp-cv-ddempty",
            tr("civitai_ui.no_base_model_matches", "No base model matches “{query}”.",
              { query: bmSearch.value.trim() })));
        }
        // Selected-count + clear, matching what ComfyUI's own multi-select
        // shows. With the list scrolled or filtered the chips above can be out
        // of view, so without this there is no way to tell how many filters are
        // live — or to drop them without hunting each one down.
        if (f.baseModels.length) {
          const foot = el("div", "cmcp-cv-ddfoot");
          // English has one form here; Russian and Arabic do not, so it is counted.
          foot.appendChild(el("span", null, tr("civitai_ui.n_selected", {
            one: "{count} selected", other: "{count} selected",
          }, { count: f.baseModels.length })));
          // Its OWN key, not the panel-wide `panel.clear`, even though the English is
          // identical. That key labels the credentials card's "clear this API key"
          // button; a translator seeing only that context can legitimately render it
          // ja "キーを消去" ("clear the key"), which would then mislabel THIS button —
          // which clears base-model filters. Sharing a key shares the context too.
          const clear = el("button", "cmcp-cv-ddclear", tr("civitai_ui.clear", "Clear"));
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
        // A composing CJK IME owns Enter/arrows/Escape to navigate and commit
        // its candidate window; don't hijack them to drive the dropdown (#385).
        if (isImeComposing(e)) return;
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
      wrap.appendChild(el("div", "cmcp-cv-flabel", tr("civitai_ui.creator", "Creator")));
      if (tabDef().fav) {
        // Favorites are "images YOU liked", from every creator — the tRPC
        // favorites feed has no creator param, so render the filter visibly
        // inert here instead of silently no-oping.
        const box = el("div", "cmcp-cv-frow");
        box.style.opacity = ".6";
        if (f.username) {
          const pill = el("button", "cmcp-cv-chip on", f.username + "  ✕");
          pill.title = tr("civitai_ui.remove_creator_filter", "Remove creator filter");
          pill.addEventListener("click", () => { setCreator(null); renderSheet(); update(); });
          box.appendChild(pill);
        }
        box.appendChild(el("div", "cmcp-cv-lb-muted",
          tr("civitai_ui.ignored_on_the_favorites_tab_favorites_are",
            "Ignored on the Favorites tab — favorites are the images you liked, from every creator.")));
        wrap.appendChild(box);
      } else {
        const crPills = el("div", "cmcp-cv-frow");
        if (f.username) {
          const pill = el("button", "cmcp-cv-chip on", f.username + "  ✕");
          pill.title = tr("civitai_ui.remove_creator_filter", "Remove creator filter");
          pill.addEventListener("click", () => { setCreator(null); renderSheet(); update(); });
          crPills.appendChild(pill);
        }
        const crSearch = el("input", "cmcp-cv-search");
        crSearch.placeholder = f.username
          ? tr("civitai_ui.switch_creator", "Switch creator…")
          : tr("civitai_ui.all_creators_search_or_pick_from_the", "All creators — search, or pick from the top");
        const crNote = el("div", "cmcp-cv-lb-muted");
        crNote.style.display = "none";
        const crList = el("div", "cmcp-cv-creators");
        const renderMatches = (matches) => {
          crList.innerHTML = "";
          for (const c of matches) {
            const b = el("button", "cmcp-cv-creator");
            b.appendChild(el("span", null,
              c.position != null ? `#${c.position}  ${c.username}` : c.username));
            // Counted, but the number the user READS is abbreviated ("1.2M"), and a
            // plural category can't be derived from that string. So `count` carries the
            // real total for Intl and `{n}` carries the abbreviation for display.
            //
            // Known residual, bounded and deliberate: once abbreviated, the category
            // follows the TRUE total, not the displayed numeral. `compactCount(1001)`
            // is "1K" while ru's rule for 1001 is `one`, so that row reads "1K
            // загрузка" where the displayed "1K" wants the genitive. Getting this
            // exactly right needs locale-aware compact formatting
            // (Intl.NumberFormat notation:"compact"), which would also change the
            // digits every existing row shows — a bigger change than this row is
            // worth. Every count below 1000 displays in full and is exactly right,
            // which is most creators; English is immune either way.
            const sub = c.position != null
              ? [
                  c.downloads != null
                    ? tr("civitai_ui.n_downloads", { one: "{n} download", other: "{n} downloads" },
                      { count: c.downloads, n: compactCount(c.downloads) })
                    : null,
                  c.thumbsUp != null
                    ? tr("civitai_ui.n_likes", { one: "{n} like", other: "{n} likes" },
                      { count: c.thumbsUp, n: compactCount(c.thumbsUp) })
                    : null,
                ].filter(Boolean).join(" · ")
              : tr("civitai_ui.n_models", { one: "{count} model", other: "{count} models" },
                { count: c.modelCount ?? 0 });
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
          crNote.style.display = ""; crNote.textContent = tr("civitai_ui.looking_up_creators", "Looking up creators…");
          (cq ? client.searchCreators(cq) : topCreators())
            .then((matches) => {
              if (req !== crReq) return; // a newer lookup owns the list
              renderMatches(matches);
              crNote.style.display = matches.length ? "none" : "";
              crNote.textContent = cq
                ? tr("civitai_ui.no_creators_match", "No creators match.")
                : tr("civitai_ui.top_creators_unavailable_right_now", "Top creators unavailable right now.");
            })
            .catch(() => {
              // The leaderboard tRPC intermittently 401s bare user agents —
              // degrade to a note without breaking the rest of the sheet.
              if (req !== crReq) return;
              crList.innerHTML = "";
              crNote.style.display = "";
              crNote.textContent = cq
                ? tr("civitai_ui.creator_search_failed_try_again", "Creator search failed — try again.")
                : tr("civitai_ui.top_creators_unavailable_right_now", "Top creators unavailable right now.");
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

      const reset = el("button", "cmcp-btn", tr("civitai_ui.reset_filters", "Reset filters"));
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
      const res = await ctx.callTool("list_local_models", { action: "list" }, { timeout: 15000 });
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
      const sheet = openSubModal(tr("civitai_ui.civitai_account", "CivitAI account"));
      const wrap = el("div", "cmcp-cv-filters");
      wrap.appendChild(el("div", null, tr("civitai_ui.signed_in", "Signed in ✓")));
      wrap.appendChild(el("div", "cmcp-cv-flabel", tr("civitai_ui.default_likes_collection", "Default likes collection")));
      wrap.appendChild(el("div", "cmcp-cv-lb-muted",
        tr("civitai_ui.every_like_is_also_saved_into_this",
          "Every like is also saved into this collection on your CivitAI account (and removed when you unlike).")));
      const row = el("div", "cmcp-cv-frow");
      const sel = document.createElement("select");
      sel.className = "cmcp-cv-search";
      sel.disabled = true;
      sel.appendChild(new Option(tr("civitai_ui.loading_collections", "Loading collections…"), ""));
      const newBtn = el("button", "cmcp-btn", tr("civitai_ui.new", "+ New…"));
      row.append(sel, newBtn);
      wrap.appendChild(row);
      let colCache = [];
      const fillSelect = () => {
        sel.innerHTML = "";
        sel.appendChild(new Option(tr("civitai_ui.none_likes_only", "(none — likes only)"), ""));
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
          sel.appendChild(new Option(tr("civitai_ui.couldn_t_load_collections", "Couldn't load collections"), ""));
          if (String(e.message || e).includes("403")) {
            wrap.appendChild(el("div", "cmcp-cv-lb-muted",
              tr("civitai_ui.your_sign_in_predates_the_collection_permissions",
                "Your sign-in predates the collection permissions — sign out and back in to grant them.")));
          }
        });
      sel.addEventListener("change", () => {
        const c = colCache.find((x) => String(x.id) === sel.value);
        setLikesCollection(c || null);
        toast(c
          ? tr("civitai_ui.likes_will_also_go_to", "Likes will also go to \"{name}\".", { name: c.name })
          : tr("civitai_ui.likes_won_t_be_added_to_a", "Likes won't be added to a collection."));
      });
      newBtn.addEventListener("click", async () => {
        const name = window.prompt(tr("civitai_ui.name_for_the_new_civitai_collection", "Name for the new CivitAI collection:"));
        if (!name || !name.trim()) return;
        newBtn.disabled = true;
        try {
          const c = await client.createCollection(name.trim());
          colCache.push(c);
          fillSelect();
          sel.value = String(c.id);
          setLikesCollection(c);
          toast(tr("civitai_ui.created_it_s_now_your_likes_collection",
            "Created \"{name}\" — it's now your likes collection.", { name: c.name }));
        } catch (e) {
          toast(tr("civitai_ui.create_failed", "Create failed: {error}", { error: e.message || e }));
        } finally {
          newBtn.disabled = false;
        }
      });
      // Its own key rather than `panel.sign_out` — see the note on civitai_ui.clear.
      // That one signs out of an AI provider; this one signs out of CivitAI, and the
      // two need not share a verb in every language.
      const out = el("button", "cmcp-btn", tr("civitai_ui.sign_out", "Sign out"));
      out.addEventListener("click", async () => {
        await ctx.api.fetchApi("/comfyui_mcp_panel/civitai/oauth/logout", { method: "POST" });
        await refreshAuth(); sheet.close();
        toast(tr("civitai_ui.signed_out_of_civitai", "Signed out of CivitAI."));
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
          if (state.signedIn) {
            toast(tr("civitai_ui.signed_in_to_civitai", "Signed in to CivitAI."));
            if (tabDef().fav) reload();
          }
        }
      }, 2000);
    } catch (e) { toast(tr("civitai_ui.sign_in_failed", "Sign-in failed: {error}", { error: e.message })); }
  }

  // ── sub-modal + toast helpers ────────────────────────────────────────
  // Open sub-modal closers, so a successful canvas load can dismiss every
  // stacked sheet (detail → gen-info → picker) in one sweep.
  const _subModals = new Set();
  function closeSubModals() {
    for (const c of [..._subModals]) { try { c(); } catch { /* already gone */ } }
  }
  // openSubModal + toast now live in the shared cmcp-modal.js (the Apps tab reuses
  // them). This wrapper threads Civitai's own `_subModals` tracker so the stacked
  // close-sweep + Escape gating stay byte-identical; `toast` is imported directly.
  function openSubModal(title, onClose) {
    return openSubModalBase(title, onClose, _subModals);
  }

  // ── agent-driven handle ────────────────────────────────────────────────
  // Post-open control surface: the same inner state/functions the UI drives,
  // exposed so the bridge (and through it the agent) can switch tabs, re-search,
  // read results (metadata + URLs only — never image bytes), and glow-highlight
  // the interesting cards. Every method awaits the modal settling, throws on a
  // closed handle, and returns a small plain object; no dynamic exec (YARA safe).
  function _assertOpen() { if (!isOpen) throw new Error("civitai browser not open"); }
  function driveSwitchTab(key) {
    _assertOpen();
    if (!TABS.some((t) => t.key === key)) throw new Error(`unknown tab "${key}"`);
    if (state.tab !== key) {
      state.tab = key; syncTabs();
      // Resolve on DISPATCH, not on fetch completion (#173): awaiting the full
      // reload (a cold first fetch, possibly while the ComfyUI tab is backgrounded)
      // blew the 10s ctx.call bridge timeout, so a tab switch that actually
      // succeeded surfaced to the agent as a timeout. reload() tracks its own
      // promise (state.activeReloadPromise) for drive methods that need the first
      // page, and _reload's reqId/renderRev bumps run synchronously before its
      // first await, so state.renderRev below is already the new generation. The
      // agent reads the loaded data via panel_civitai_results (loading/done flags).
      void reload();
      return { tab: state.tab, renderRev: state.renderRev, dispatched: true };
    }
    syncTabs();
    return { tab: state.tab, renderRev: state.renderRev, dispatched: false };
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
    // #691 — echo `filters` the way `tab`/`query`/`creator` are already echoed, so
    // the caller can tell "applied" from "silently dropped" instead of reading
    // `dispatched:true` as proof. summarizeSearchFilters also reports when a
    // requested modelSort is inert because CivitAI relevance-ranks keyword
    // searches — measured, not assumed; see that module for the evidence.
    return {
      tab: state.tab,
      query: state.query,
      creator: state.filters.username || null,
      ...summarizeSearchFilters({
        filters: state.filters,
        query: state.query,
        modelTab: !!tabDef().model,
      }),
      renderRev: state.renderRev,
      dispatched: true,
    };
  }
  async function driveGetResults({ limit = 20 } = {}) {
    _assertOpen();
    // Wait for an in-flight first page, exactly as driveHighlight does.
    //
    // panel#793 — without this, an agent that opens the browser and immediately
    // asks for results gets `{ count: 0, total: 0, loading: true }`. That is not
    // a lie, but it reads as "this search found nothing", and the agent has no
    // reason to poll: `civitai_highlight` issued at the same instant DOES wait
    // and DOES see the cards, so the two commands disagreed about whether any
    // results existed. Same open, same moment, different answer.
    //
    // `loading` is still reported below — this only removes the window where the
    // honest answer was available and we returned the empty one instead.
    //
    // Bounded since comfyui-mcp#1520: the wait is on CivitAI, so an unbounded
    // one hands our reply deadline to a third party and the caller gets a bridge
    // timeout carrying nothing. On expiry we answer with what we have —
    // `loading: true` plus `reloadPending: true` — which is the same honest
    // interim answer panel#793 was fine with, just arriving on time.
    const reloadSettled = await awaitReloadWithin(state.activeReloadPromise, RELOAD_WAIT_BUDGET_MS);
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
      // True when we gave up waiting on the in-flight fetch rather than seeing
      // it finish (#1520). Distinguishes "a reload is still running and I waited
      // as long as I safely could" from "loading just started" — both report
      // `loading: true`, but only the first means re-reading shortly is the
      // right move rather than a busy-poll.
      reloadPending: !reloadSettled,
      // Disambiguate an empty grid (issues #190/#375): `error` is a non-null
      // upstream failure (retry, don't narrow filters); `authenticated` reflects
      // the CivitAI session; on the favorites tab `favoritesStatus` explains an
      // empty feed (signed_out / no_likes_collection / filtered_out / ok).
      error: state.error || null,
      authenticated: !!state.signedIn,
      ...(tabDef().fav ? { favoritesStatus: state.favoritesStatus || "ok" } : {}),
      // #712 — the model tabs' half of the same rule. An empty model grid was
      // reported as `error: null, done: true`, indistinguishable from "nothing
      // matched" even when the browsing level had removed every result — which
      // is what made "0 results for any search" read as a broken browser.
      // Emitted only when the level actually removed something, so a genuine
      // no-match stays a clean empty result.
      ...(isModelTab() && state.hiddenByLevel
        ? {
            hiddenByBrowsingLevel: state.hiddenByLevel,
            levelFilterNote:
              `${state.hiddenByLevel} result(s) were removed by the current browsing level ` +
              `(${(state.filters?.browsingLevels || []).join(", ") || "default"}). ` +
              `They are not missing from CivitAI — widen browsingLevels to see them.`,
          }
        : {}),
    };
  }
  /** Highlight a set of ids (REPLACEMENT semantics). Awaits the in-flight
   *  first-page load so a highlight issued before results land still lands.
   *  Persists the set so later pages glow as they stream in (see appendItems). */
  async function driveHighlight(ids, { kind } = {}) { // eslint-disable-line no-unused-vars
    _assertOpen();
    const list = (Array.isArray(ids) ? ids : (ids != null ? [ids] : [])).map((x) => String(x));
    const rev = state.renderRev;
    // Bounded since comfyui-mcp#1520 — see RELOAD_WAIT_BUDGET_MS. On expiry we
    // install NOTHING and say so, following the `superseded` path directly
    // below: this function already establishes that returning `highlighted: 0`
    // with the set untouched is the right answer when it cannot safely act.
    //
    // Deliberately not installing late in the background. Today a bridge timeout
    // here is a false failure — the caller is told the command failed and the
    // glow lands anyway — and quietly applying after we reported `pending` would
    // keep exactly that confusion. The caller re-issues; `driveHighlight` clears
    // before installing, so a retry is idempotent.
    const reloadSettled = await awaitReloadWithin(state.activeReloadPromise, RELOAD_WAIT_BUDGET_MS);
    _assertOpen();
    // A reload/tab/filter can supersede this highlight while we wait: those ids
    // belonged to the OLD search and MUST NOT be installed on the new generation
    // (they'd glow same-id cards from a different query). The bounded wait adds
    // a second bail-out, and `superseded` takes precedence over `pending` — see
    // classifyHighlightOutcome, where that precedence is pinned.
    const outcome = classifyHighlightOutcome({
      revChanged: state.renderRev !== rev,
      reloadSettled,
    });
    if (outcome !== "install") {
      return {
        highlighted: 0,
        missing: list,
        renderRev: state.renderRev,
        [outcome]: true, // superseded | pending — bail without touching the set
      };
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
      renderRev: state.renderRev, docked: shell.isDocked(),
      highlighted: state.highlightOrder.slice(),
    };
  }

  // ── content provider (the shell owns the chrome; this owns the body) ──────
  let _started = false;
  return {
    key: "civitai", label: tr("civitai_ui.civitai", "Civitai"), icon: "pi-images", driveKind: "civitai",
    hasSearch: true, searchPlaceholder: tr("civitai_ui.search_civitai", "Search CivitAI…"),
    subnavExtras: () => [subTabsWrap, favChips, filterBtn, acctBtn],
    mount(bodyEl) {
      search.value = state.query;
      bodyEl.append(progress, grid, sentinel, searchOverlay);
    },
    // The shell dispatches every keystroke here; keep the 500ms debounce + the
    // creator-token parse (applySearch reads the shared box). Enter flushes.
    onSearch(_value, o = {}) {
      clearTimeout(searchTimer);
      if (o.enter) applySearch();
      else searchTimer = setTimeout(applySearch, 500);
    },
    onActivate() {
      body.addEventListener("scroll", onBodyScroll);
      if (!_started) { _started = true; syncTabs(); refreshAuth(); reload(); }
      else syncTabs();
    },
    onDeactivate() { body.removeEventListener("scroll", onBodyScroll); },
    // Re-open onto an already-mounted Civitai tab with a fresh query/filters
    // (host switches tabs on open_civitai while the panel is already up).
    reseed(o) {
      if (!o || !isOpen) return;
      if (o.tab) { try { driveSwitchTab(o.tab); } catch { /* ignore */ } }
      if (o.query != null || o.filters || o.browsingLevels) {
        try { driveSearch({ query: o.query, filters: o.filters, browsingLevels: o.browsingLevels }); } catch { /* ignore */ }
      }
    },
    teardown,
    // Escape peels the lightbox / a stacked sub-modal before it can close the panel.
    escapeBlocked: () => _subModals.size > 0 || !!document.querySelector(".cmcp-cv-lb"),
    drive: {
      switchTab: driveSwitchTab, search: driveSearch, getResults: driveGetResults,
      highlight: driveHighlight, clearHighlight: driveClearHighlight,
      openLightbox: driveOpenLightbox, getState: driveGetState,
    },
  };
}

/** Thin back-compat wrapper: opens the unified side panel on the Civitai tab.
 *  Returns the shell handle. */
export function openCivitaiModal(ctx, opts = {}) {
  const { query, tab, filters, browsingLevels, dock, onClose } = opts;
  return openSidePanel(ctx, {
    tab: "civitai",
    dock,
    onClose,
    tabOpts: { civitai: { query, tab, filters, browsingLevels } },
  });
}
