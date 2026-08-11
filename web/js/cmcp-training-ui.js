// LoRA Training modal — the panel's dataset-gather → label → launch → monitor
// wizard for the local trainer (ai-toolkit in a GPU Docker container, driven by
// the comfyui-mcp train_* tools). Parity target for the mobile app's Training
// tab; the Character card is functional (FLUX.1-dev), the rest are P2 previews.
//
// Backend channels (both already existed):
//  - ctx.callTool(tool, args, {timeout}) — cid-correlated call_tool over the
//    orchestrator bridge (train_* tools; whitelisted server-side).
//  - /comfyui_mcp_panel/training/* — same-origin py routes for structured
//    output listing, image-ref → absolute-path resolution, and serving
//    training-sample images from the rig's training root.

import { openSidePanel } from "./cmcp-sidepanel-ui.js";
import { tr } from "./lib/i18n.js";

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    /* The unified side-panel shell (cmcp-sidepanel-ui.js) owns the overlay + dock
       + slide + Escape; this keeps only the .cmcp-tr-* wizard body CSS. The
       .cmcp-modal.cmcp-tr-modal sizing rule is the active-tab alias. */
    .cmcp-modal.cmcp-tr-modal { width: min(94vw, 960px); max-width: none;
      max-height: min(92vh, 880px); padding: 0; gap: 0; overflow: hidden;
      display: flex; flex-direction: column; }
    .cmcp-tr-body { flex: 1; overflow-y: auto; min-height: 0; padding-bottom: 1rem; }
    .cmcp-tr-head { display:flex; align-items:center; gap:.75rem; padding:1rem 1.25rem .5rem;
      border-bottom: 1px solid var(--p-content-border-color, #3f3f46); }
    .cmcp-tr-head h2 { margin:0; font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.2923); flex:1; }
    .cmcp-tr-close { background:none; border:none; color:inherit; cursor:pointer; font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.3538); opacity:.7; }
    .cmcp-tr-close:hover { opacity:1; }
    .cmcp-tr-seg { display:flex; gap:0; margin:.75rem 1.25rem; border:1px solid var(--p-surface-500,#555); border-radius:999px; overflow:hidden; width:fit-content; flex:none; }
    .cmcp-tr-seg button { border:none; background:transparent; color:inherit; padding:.4rem .9rem; cursor:pointer; font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0462); display:flex; align-items:center; gap:.4rem; }
    .cmcp-tr-seg button.active { background: var(--p-surface-700,#3f3f46); }
    .cmcp-tr-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:.75rem; padding:0 1.25rem 1rem; }
    @media (max-width: 640px) { .cmcp-tr-grid { grid-template-columns:repeat(2,1fr); } }
    .cmcp-tr-card { background:var(--p-surface-800,#27272a); border:1px solid var(--p-surface-600,#3f3f46); border-radius:12px; padding:.75rem; display:flex; flex-direction:column; gap:.45rem; }
    .cmcp-tr-card.active { border-color: var(--p-primary-color,#94a3b8); }
    .cmcp-tr-icon { aspect-ratio:1.6; border-radius:10px; background:color-mix(in srgb, currentColor 8%, transparent); display:flex; align-items:center; justify-content:center; font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.9692); opacity:.8; }
    .cmcp-tr-card select { background:var(--p-surface-900,#18181b); color:inherit; border:1px solid var(--p-surface-600,#52525b); border-radius:6px; padding:.25rem .4rem; font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9846); width:100%; }
    .cmcp-tr-card h3 { margin:0; font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.1077); }
    .cmcp-tr-card p { margin:0; font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96); opacity:.65; line-height:1.35; flex:1; }
    .cmcp-tr-badge { align-self:flex-start; font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8862); padding:.1rem .5rem; border-radius:999px; background:color-mix(in srgb, currentColor 10%, transparent); opacity:.75; }
    .cmcp-tr-badge.ok { background: color-mix(in srgb, #22c55e 18%, transparent); opacity:1; }
    .cmcp-tr-badge.err { background: color-mix(in srgb, #ef4444 18%, transparent); opacity:1; }
    .cmcp-tr-badge.warn { background: color-mix(in srgb, #eab308 18%, transparent); opacity:1; }
    .cmcp-tr-foot { padding:0 1.25rem 1rem; font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9846); opacity:.55; }
    .cmcp-tr-section { padding: .25rem 1.25rem; display:flex; flex-direction:column; gap:.6rem; }
    .cmcp-tr-row { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }
    .cmcp-tr-row > label { font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9846); opacity:.75; min-width:6.5rem; }
    .cmcp-tr-input, .cmcp-tr-section input[type=text], .cmcp-tr-section input[type=number] {
      background:var(--p-surface-800,#27272a); border:1px solid var(--p-surface-600,#52525b);
      border-radius:8px; padding:.45rem .7rem; color:inherit; font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0462); flex:1; min-width:0; }
    .cmcp-tr-hint { font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9231); opacity:.55; margin:0; }
    .cmcp-tr-btn { background:var(--p-surface-700,#3f3f46); border:1px solid var(--p-surface-600,#52525b);
      color:inherit; border-radius:8px; padding:.45rem .9rem; cursor:pointer; font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0462); }
    .cmcp-tr-btn:hover { filter:brightness(1.2); }
    .cmcp-tr-btn:disabled { opacity:.45; cursor:not-allowed; }
    .cmcp-tr-btn.primary { background:var(--p-primary-color,#64748b); border-color:transparent; color:#fff; }
    .cmcp-tr-btn.danger { background: color-mix(in srgb, #ef4444 25%, transparent); }
    .cmcp-tr-pickgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:.5rem; max-height:38vh; overflow-y:auto; padding:.25rem; }
    .cmcp-tr-pick { position:relative; aspect-ratio:1; border-radius:8px; overflow:hidden; cursor:pointer; border:2px solid transparent; background:var(--p-surface-900,#18181b); }
    .cmcp-tr-pick img { width:100%; height:100%; object-fit:cover; display:block; }
    .cmcp-tr-pick.sel { border-color: var(--p-primary-color,#94a3b8); }
    .cmcp-tr-pick .mark { position:absolute; top:4px; right:4px; background:rgba(0,0,0,.65); border-radius:999px; width:20px; height:20px; display:flex; align-items:center; justify-content:center; font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8615); }
    .cmcp-tr-pick.sel .mark { background:var(--p-primary-color,#64748b); color:#fff; }
    .cmcp-tr-drop { border:2px dashed var(--p-surface-600,#52525b); border-radius:12px; padding:1.5rem; text-align:center; opacity:.8; cursor:pointer; }
    .cmcp-tr-drop.over { border-color: var(--p-primary-color,#94a3b8); opacity:1; }
    .cmcp-tr-tray { display:flex; gap:.4rem; flex-wrap:wrap; }
    .cmcp-tr-chip { position:relative; width:44px; height:44px; border-radius:6px; background-size:cover; background-position:center; }
    .cmcp-tr-chip button { position:absolute; top:-6px; right:-6px; width:16px; height:16px; border-radius:999px; border:none; background:#ef4444; color:#fff; font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8); line-height:1; cursor:pointer; }
    .cmcp-tr-labelgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:.75rem; }
    .cmcp-tr-labelitem { background:var(--p-surface-800,#27272a); border-radius:10px; padding:.5rem; display:flex; flex-direction:column; gap:.4rem; }
    .cmcp-tr-labelitem .thumb { aspect-ratio:1; border-radius:8px; background-size:cover; background-position:center; }
    .cmcp-tr-labelitem textarea { background:var(--p-surface-900,#18181b); border:1px solid var(--p-surface-600,#52525b); border-radius:6px; color:inherit; font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96); padding:.35rem .5rem; resize:vertical; min-height:2.6rem; width:100%; box-sizing:border-box; }
    .cmcp-tr-steps { display:flex; gap:.35rem; margin:.6rem 1.25rem 0; flex:none; }
    .cmcp-tr-steps span { font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8862); padding:.15rem .6rem; border-radius:999px; background:color-mix(in srgb, currentColor 8%, transparent); opacity:.55; }
    .cmcp-tr-steps span.on { opacity:1; background:var(--p-surface-700,#3f3f46); }
    .cmcp-tr-progress { height:10px; border-radius:999px; background:var(--p-surface-800,#27272a); overflow:hidden; }
    .cmcp-tr-progress > div { height:100%; background:var(--p-primary-color,#64748b); transition:width .4s; }
    .cmcp-tr-log { background:var(--p-surface-900,#18181b); border-radius:8px; padding:.5rem .7rem; font-family:monospace; font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8862); max-height:140px; overflow-y:auto; white-space:pre-wrap; word-break:break-all; opacity:.85; }
    .cmcp-tr-samples { display:flex; gap:.5rem; flex-wrap:wrap; }
    .cmcp-tr-samples img { width:120px; height:120px; object-fit:cover; border-radius:8px; cursor:pointer; }
    .cmcp-tr-jobrow { display:flex; align-items:center; gap:.6rem; padding:.5rem .25rem; border-bottom:1px solid var(--p-surface-700,#3f3f46); cursor:pointer; }
    .cmcp-tr-jobrow:hover { background:color-mix(in srgb, currentColor 4%, transparent); }
    .cmcp-tr-jobrow .name { flex:1; font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0462); }
    .cmcp-tr-jobrow .meta { font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9231); opacity:.6; }
    .cmcp-tr-preflight { display:flex; gap:1rem; flex-wrap:wrap; font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96); }
    .cmcp-tr-preflight span b { font-weight:600; }
    /* Agent-driven "glow" — shared class name with the CivitAI modal; generic here
       so it applies to step chips + field wrappers, not just cards. */
    .cmcp-agent-glow { outline: 2px solid var(--p-green-400,#4ade80);
      box-shadow: 0 0 0 2px var(--p-green-400,#4ade80), 0 0 16px 2px rgba(74,222,128,.6);
      border-radius: 8px; animation: cmcp-glow 1.4s ease-in-out infinite; }
    @keyframes cmcp-glow { 50% { box-shadow: 0 0 0 3px var(--p-green-400,#4ade80),
      0 0 24px 6px rgba(74,222,128,.9); } }
  `;
  document.head.appendChild(style);
}

// Getters, not values — see the note in cmcp-sidepanel-ui.js. Module scope runs before the
// catalog loads, so a plain `tr(...)` here captures English permanently. `desc` needs the
// same treatment as `title` for exactly the same reason; the model names inside `models`
// are identifiers, not prose, and are deliberately NOT translated.
const FLOWS = [
  { get title() { return tr("training_ui.image_character", "Image Character"); }, icon: "pi-user", models: ["FLUX.1-dev"], get desc() { return tr("training_ui.train_a_person_or_character_into_an", "Train a person or character into an image model."); }, live: true },
  { get title() { return tr("training_ui.image_edit", "Image Edit"); }, icon: "pi-pencil", models: ["Qwen Edit 2509"], get desc() { return tr("training_ui.teach_an_edit_model_your_custom_transformation", "Teach an edit model your custom transformation."); } },
  { get title() { return tr("training_ui.image_style", "Image Style"); }, icon: "pi-palette", models: ["Krea2", "Flux2", "ZImg"], get desc() { return tr("training_ui.capture_an_art_style_you_can_apply", "Capture an art style you can apply to any prompt."); } },
  { get title() { return tr("training_ui.image_slider", "Image Slider"); }, icon: "pi-sliders-h", models: ["Krea2", "Flux2", "ZImg"], get desc() { return tr("training_ui.a_concept_slider_with_adjustable_strength", "A concept slider with adjustable strength."); } },
  { get title() { return tr("training_ui.video_character", "Video Character"); }, icon: "pi-video", models: ["LTX 2.3", "Wan 2.2"], get desc() { return tr("training_ui.bring_a_character_into_video_generation", "Bring a character into video generation."); } },
  { get title() { return tr("training_ui.video_action", "Video Action"); }, icon: "pi-forward", models: ["LTX 2.3", "Wan 2.2"], get desc() { return tr("training_ui.teach_a_motion_or_action_to_a", "Teach a motion or action to a video model."); } },
];

const PRESETS = {
  smoke: { get label() { return tr("training_ui.smoke_test", "Smoke test"); }, params: { steps: 200, saveEvery: 100, sampleEvery: 100, resolution: [512] }, get note() { return tr("training_ui.10_min_on_a_4090_proves_the", "~10 min on a 4090 — proves the pipeline, not a usable LoRA."); } },
  standard: { get label() { return tr("training_ui.standard", "Standard"); }, params: { steps: 2000, lr: 1e-4, rank: 16, resolution: [512, 768, 1024], saveEvery: 250, sampleEvery: 250, quantize: true }, get note() { return tr("training_ui.1_2_h_on_a_4090_the", "~1–2 h on a 4090. The real thing."); } },
  custom: { get label() { return tr("training_ui.custom", "Custom"); }, params: null, get note() { return tr("training_ui.edit_every_parameter_yourself", "Edit every parameter yourself."); } },
};

/** The rig's GPU ("RTX 4090 24GB") from ComfyUI's /system_stats — the panel
 *  runs on the ComfyUI origin, so this always reaches the right instance. */
async function fetchGpuLabel(api) {
  try {
    const res = await (api?.fetchApi ? api.fetchApi("/system_stats") : fetch("/system_stats"));
    const data = await res.json();
    const d = data?.devices?.[0];
    if (!d) return null;
    let name = String(d.name || "")
      .replace(/^\w+:\d+\s+/, "")
      .split(" : ")[0]
      .replace("NVIDIA GeForce ", "")
      .replace("NVIDIA ", "")
      .trim();
    if (!name || name.toLowerCase() === "mps") name = "Apple Silicon";
    const gb = Math.round((d.vram_total || 0) / (1024 * 1024 * 1024));
    return gb > 0 ? `${name} ${gb}GB` : name;
  } catch {
    return null;
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * callTool envelope → parsed JSON (train_* tools return text-wrapped JSON).
 *
 * The `throw new Error(...)` strings in here — and in the drive* handlers at the bottom of
 * this file — are deliberately NOT translated. They have two audiences: the UI renders them
 * inside a translated wrapper ("Could not load jobs: {error}"), but the agent-drive bridge
 * also relays them verbatim to the agent, and to whatever issue report the user pastes them
 * into. A locale-dependent error string makes the agent's behaviour and every bug report
 * depend on the user's language setting, which costs more than the half-translated sentence
 * it buys. If that trade is ever revisited, revisit it for BOTH sites at once.
 */
async function callJson(ctx, tool, args, opts) {
  if (!ctx.callTool) throw new Error("panel bridge not connected — start the comfyui-mcp orchestrator");
  const res = await ctx.callTool(tool, args, opts);
  const text = (res?.result || []).map((c) => c?.text || "").join("").trim();
  if (!res || res.ok === false) {
    // The bridge flags MCP errors with ok:false but KEEPS the tool's own
    // content — prefer the actionable tool message (JSON error, root message,
    // or plain text) over the generic bridge one (codex finding).
    let msg = res?.error || `${tool} failed`;
    if (text) {
      try {
        const errData = JSON.parse(text);
        if (errData?.error?.message) msg = errData.error.message;
        else if (errData?.message) msg = errData.message;
        else msg = text;
      } catch {
        msg = text; // plain-text tool error (e.g. dataset rejection)
      }
    }
    throw new Error(msg);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${tool} returned unexpected output`);
  }
  if (data && data.ok === false) {
    throw new Error(data.error?.message || `${tool} failed`);
  }
  return data;
}

function apiUrl(ctx, path) {
  // Route through ComfyUI's API base (supports non-root base-path deployments);
  // fall back to root-relative when the api helper isn't around (codex finding).
  try {
    if (ctx.api?.apiURL) return ctx.api.apiURL(path);
  } catch { /* fall through */ }
  return path;
}

async function apiFetch(ctx, path, opts) {
  if (ctx.api?.fetchApi) return ctx.api.fetchApi(path, opts);
  return fetch(apiUrl(ctx, path), opts);
}

function viewUrl(ctx, ref) {
  const q = new URLSearchParams({ filename: ref.filename, type: ref.type || "output" });
  if (ref.subfolder) q.set("subfolder", ref.subfolder);
  return apiUrl(ctx, `/view?${q.toString()}`);
}

function sampleUrl(ctx, path) {
  return apiUrl(ctx, `/comfyui_mcp_panel/training/file?path=${encodeURIComponent(path)}`);
}

function sanitizeNameClient(name) {
  const cleaned = String(name || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  // Dot-only names ("."/"..") fall back server-side ("dataset"/"lora") — reject
  // them here so the launched name can't silently diverge from the reviewed one.
  if (!cleaned || /^\.+$/.test(cleaned)) return "";
  return cleaned;
}

/**
 * Relative age for job/dataset rows.
 *
 * Counted, even though the English abbreviations ("5m ago") never inflect: the abbreviation
 * is an English choice, and a translator who spells the unit out — ru "{count} день" vs
 * "дня" vs "дней" — needs the plural slots to exist. Passing `{ count }` creates them; a
 * plain `{n}` would leave that translator with nowhere to put the other three forms.
 */
function fmtAgo(iso) {
  const t = Date.parse(iso || "");
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return tr("training_ui.seconds_ago", { one: "{count}s ago", other: "{count}s ago" }, { count: Math.floor(s) });
  if (s < 3600) return tr("training_ui.minutes_ago", { one: "{count}m ago", other: "{count}m ago" }, { count: Math.floor(s / 60) });
  if (s < 86400) return tr("training_ui.hours_ago", { one: "{count}h ago", other: "{count}h ago" }, { count: Math.floor(s / 3600) });
  return tr("training_ui.days_ago", { one: "{count}d ago", other: "{count}d ago" }, { count: Math.floor(s / 86400) });
}

// INTERPOLATION ORDER MATTERS — a file-wide rule, not a note about any one declaration.
// Read it before adding a multi-var tr() call anywhere below.
//
// tr() substitutes `{name}` holes one variable at a time, in the order the vars object
// declares them, over the string it has built so far. So a value that itself contains
// `{something}` is re-scanned by every substitution that comes AFTER it. A user whose
// trigger word is literally "{rank}" would otherwise see the LoRA rank rendered where
// their trigger word belongs. The rule this file follows: any value the USER can type
// (trigger words, file names) goes LAST in the vars object, after every internal value.
// Single-variable calls are safe by construction and need no ordering care.

const STATUS_BADGE = { running: "ok", queued: "warn", completed: "ok", failed: "err", cancelled: "warn" };

/**
 * Display text for a job status. The raw value stays the backend's enum everywhere it is
 * USED as data (STATUS_BADGE lookups, the `terminal` test, wiz.job) — this only translates
 * what is shown, because an English "running" sitting inside an otherwise Korean sentence
 * is exactly the defect this whole change exists to remove. An unrecognised status falls
 * through unchanged rather than rendering blank.
 */
const statusLabel = (status) => ({
  running: tr("training_ui.status_running", "running"),
  queued: tr("training_ui.status_queued", "queued"),
  completed: tr("training_ui.status_completed", "completed"),
  failed: tr("training_ui.status_failed", "failed"),
  cancelled: tr("training_ui.status_cancelled", "cancelled"),
}[status] ?? status);

/** The four wizard step chips. A FUNCTION, not a const array, for the same reason FLOWS
 *  uses getters: module scope runs at import time, before the catalog loads, so a frozen
 *  array would render English forever. Called fresh by every show(). */
const stepNames = () => [
  tr("training_ui.1_dataset", "1 · Dataset"),
  tr("training_ui.2_label", "2 · Label"),
  tr("training_ui.3_launch", "3 · Launch"),
  tr("training_ui.4_monitor", "4 · Monitor"),
];

/** Content-provider factory for the LoRA Training tab of the unified side panel.
 *  The shell owns the overlay/header/✕/dock/Escape; this builds the wizard body +
 *  the agent-drive surface. The shared search filters the outputs grid on the
 *  Dataset step (decision B); it's hidden everywhere else. */
export function createTrainingContent(ctx = {}, shell, opts = {}) {
  injectCss();
  const modal = shell.modal; // for data-ref query + highlight scoping

  let pollTimer = null;
  let pollGen = 0;
  let closed = false;
  // train_doctor generation: every doctor request captures the current value;
  // only the NEWEST completion may write wiz.podInfo, so a slow stale doctor
  // can't resurrect a pod that a later check found gone (codex finding).
  let doctorGen = 0;
  let _started = false;
  // Shared-search → outputs filename filter (decision B). outputsTabActive gates
  // whether the search shows at all (the Upload sub-tab has nothing to filter).
  let outputsFilter = "";
  let outputsTabActive = false;
  let repaintOutputs = null; // renderOutputs' paint(), so onSearch can re-run it
  const stopPolling = () => {
    pollGen++; // invalidate any in-flight poll response
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  };
  // close() closes the WHOLE side panel; teardown() (run by the shell) does the
  // async cleanup — parity with the old close() minus the DOM/dock/Escape/slide
  // that the shell now owns.
  const close = () => { try { shell.close(); } catch { /* already gone */ } };
  function teardown() {
    if (closed) return; // idempotent
    closed = true;
    stopPolling();
    wiz.launchGen++; // a pending launch's continuation self-discards (codex finding)
    wiz.uploadGen++;
  }

  // Wizard state (one character-LoRA job being configured/tracked). Held at
  // modal scope so it survives view navigation: launching/uploadsPending MUST
  // outlive individual renders (codex findings: double-launch via Back, stale
  // upload tracking across gather re-entry).
  const wiz = {
    datasetName: "",
    trigger: "",
    images: [], // { ref: {filename, subfolder, type}, thumb, caption }
    preset: "standard",
    params: { ...PRESETS.standard.params },
    customParams: undefined,
    jobId: null,
    job: null,
    launching: false,
    launchError: null,
    target: "local",
    podInfo: null,
    uploadsPending: 0,
    /** Reuse-a-staged-dataset mode (Jobs/Datasets → "Train again"): when set,
     *  the Launch step skips the gather/label staging and calls train_start
     *  directly with this datasetPath. { name, datasetPath, trigger?, params? } */
    reuseDataset: null,
    /** Dataset name open in the detail view (Datasets → row). */
    datasetDetail: null,
    /** Generations: bumped on launch/reset so a stale async continuation (an
     *  in-flight launch or upload batch from a PREVIOUS wizard run) can't
     *  mutate the new run's state (codex findings). */
    launchGen: 0,
    uploadGen: 0,
    // Agent-drive: the ordered set of data-ref targets to glow. The wizard
    // rebuilds its body on every show(view), so this OUTLIVES a render and is
    // re-applied after each one (see reapplyHighlight).
    highlightRefs: [],
  };
  /** Reset the configuration fields for a genuinely NEW run (Jobs → "New
   *  character LoRA") — a fresh run must not silently reuse the previous
   *  dataset (codex finding). Bumps both generations so stale continuations
   *  self-discard. REFUSED while a launch is in flight: the backend may still
   *  start that container, and resetting would orphan it from this modal
   *  (and invite a second GPU job alongside it). */
  function resetWizardConfig() {
    if (wiz.launching) return false;
    wiz.datasetName = "";
    wiz.trigger = "";
    wiz.images = [];
    wiz.preset = "standard";
    wiz.params = { ...PRESETS.standard.params };
    wiz.customParams = undefined;
    wiz.jobId = null;
    wiz.job = null;
    wiz.launchError = null;
    // Reset the target selection too — a stale target:"pod" from a prior run,
    // paired with a fresh train_doctor that reports no pod, would leave the
    // switch unrendered but Launch disabled against the retained pod target
    // (dead-end until modal reopen; codex finding). The Launch step re-derives
    // the live pod availability from a fresh train_doctor.
    wiz.target = "local";
    wiz.podInfo = null;
    wiz.uploadsPending = 0;
    wiz.launchGen++;
    wiz.uploadGen++;
    wiz.reuseDataset = null; // a fresh run stages its own dataset
    return true;
  }

  /** The refusal every "start a new run" entry point shows when resetWizardConfig()
   *  declines (Flows/Jobs/Datasets/Monitor each guard on it). ONE key for four call
   *  sites — the same sentence extracted four times would ask translators to write it
   *  four times and let the four copies drift apart. */
  const launchInFlightMsg = () => tr(
    "training_ui.a_launch_is_still_in_flight_let",
    "A launch is still in flight — let it settle (or cancel it from Jobs) before starting a new run.",
  );

  /** Collision-free rerun name (codex finding: a fixed "-r2" suffix silently
   *  overwrites the previous rerun's LoRA — the name IS the .safetensors
   *  basename). Bumps -rN past every existing job sharing the base name. */
  async function uniqueRerunName(base) {
    try {
      const d = await callJson(ctx, "train_start", { action: "status" }, { timeout: 30000 });
      const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${esc}-r(\\d+)$`);
      let max = 1;
      for (const j of d.jobs || []) {
        const m = re.exec(j.name || "");
        if (m) max = Math.max(max, Number(m[1]));
      }
      return `${base}-r${max + 1}`;
    } catch {
      return `${base}-r2`;
    }
  }

  // Jobs + Datasets buttons → shell subnav (via subnavExtras). The shell owns the ✕/title.
  const jobsBtn = el("button", "cmcp-tr-btn", tr("training_ui.jobs", "Jobs"));
  jobsBtn.style.flex = "none";
  const datasetsBtn = el("button", "cmcp-tr-btn", tr("training_ui.datasets", "Datasets"));
  datasetsBtn.style.flex = "none";

  // Step chips (carry data-ref) + the wizard body, mounted into the shell's
  // .cmcp-cv-body scroll surface.
  const stepsBar = el("div", "cmcp-tr-steps");
  const body = el("div", "cmcp-tr-body");

  // Stable step namespace (audit item 7): refs survive the body rebuild every
  // show(view) because they're regenerated deterministically per render.
  const STEP_REFS = ["dataset", "label", "launch", "monitor"];
  function setSteps(names, current) {
    stepsBar.textContent = "";
    stepsBar.style.display = names ? "" : "none";
    (names || []).forEach((n, i) => {
      const s = el("span", i === current ? "on" : null, n);
      if (STEP_REFS[i]) s.dataset.ref = `step:${STEP_REFS[i]}`;
      stepsBar.appendChild(s);
    });
  }

  /** Re-apply the agent's ordered highlight set after a render (the body is
   *  rebuilt every show(view), so refs must be re-stamped THEN re-glowed). */
  function reapplyHighlight() {
    for (const c of modal.querySelectorAll(".cmcp-agent-glow")) c.classList.remove("cmcp-agent-glow");
    for (const ref of wiz.highlightRefs) {
      const node = modal.querySelector(`[data-ref="${CSS.escape(String(ref))}"]`);
      if (node) node.classList.add("cmcp-agent-glow");
    }
  }

  let currentView = "flows";
  function show(view) {
    if (closed) return;
    currentView = view;
    stopPolling();
    // Leaving/re-entering any view resets the outputs-filter binding; renderOutputs
    // re-arms it. The shell re-evaluates search visibility at the end.
    outputsTabActive = false;
    repaintOutputs = null;
    body.textContent = "";
    if (view === "flows") { setSteps(null); renderFlows(); }
    else if (view === "jobs") { setSteps(null); renderJobs(); }
    else if (view === "datasets") { setSteps(null); renderDatasets(); }
    else if (view === "dataset-detail") { setSteps(null); renderDatasetDetail(); }
    else if (view === "wizard-1") { setSteps(stepNames(), 0); renderGather(); }
    else if (view === "wizard-2") { setSteps(stepNames(), 1); renderLabel(); }
    else if (view === "wizard-3") { setSteps(stepNames(), 2); renderLaunch(); }
    else if (view === "wizard-4") { setSteps(stepNames(), 3); renderMonitor(); }
    // Re-glow after the new view's DOM exists (renderers can be async but stamp
    // their static refs synchronously; async content re-applies on its own).
    reapplyHighlight();
    try { shell.syncSearch(); } catch { /* not mounted yet */ }
  }

  jobsBtn.onclick = () => show("jobs");
  datasetsBtn.onclick = () => show("datasets");

  // ---------------------------------------------------------------- flows ---
  function renderFlows() {
    const grid = el("div", "cmcp-tr-grid");
    for (const f of FLOWS) {
      const card = el("div", `cmcp-tr-card${f.live ? " active" : ""}`);
      const icon = el("div", "cmcp-tr-icon");
      const i = el("i", `pi ${f.icon}`);
      icon.appendChild(i);
      const select = document.createElement("select");
      for (const m of f.models) {
        const o = document.createElement("option");
        o.textContent = m;
        select.appendChild(o);
      }
      if (f.live) select.disabled = true;
      const h = el("h3", null, f.title);
      const p = el("p", null, f.desc);
      if (f.live) {
        const b = el("span", "cmcp-tr-badge ok", tr("training_ui.local_ready", "Local · ready"));
        const start = el("button", "cmcp-tr-btn primary", tr("training_ui.start", "Start"));
        start.onclick = () => {
          if (!resetWizardConfig()) { alert(launchInFlightMsg()); return; }
          show("wizard-1");
        };
        card.append(icon, select, h, p, b, start);
      } else {
        const b = el("span", "cmcp-tr-badge", tr("training_ui.coming_soon_p2", "Coming soon (P2)"));
        card.append(icon, select, h, p, b);
      }
      grid.appendChild(card);
    }
    const foot = el("div", "cmcp-tr-foot",
      tr("training_ui.character_loras_train_on_this_rig_ai",
        "Character LoRAs train on this rig (ai-toolkit in a GPU container, FLUX.1-dev) — or on a connected RunPod pod via the Local/Pod switch on the Launch step. Style / edit / slider / video flows land in P2."));
    body.append(grid, foot);
  }

  // --------------------------------------------------------------- gather ---
  let backendChecked = false;
  let backendCapable = false;
  /** One-time capability gate: train_* tools only exist on an orchestrator
   *  running the trainer release (mcp PR #237+). Older orchestrators reject
   *  call_tool — detect that at wizard entry instead of letting the user walk
   *  into a doomed launch (codex finding). */
  async function checkBackendCapable() {
    if (backendChecked) return backendCapable;
    try {
      await callJson(ctx, "train_start", { action: "list_flows" }, { timeout: 15000 });
      backendCapable = true;
    } catch {
      backendCapable = false;
    }
    backendChecked = true;
    return backendCapable;
  }

  function renderGather() {
    const sec = el("div", "cmcp-tr-section");
    // Capability gate (async): swap in a blocking notice when the orchestrator
    // predates the trainer.
    checkBackendCapable().then((capable) => {
      syncNext();
      if (capable) return;
      sec.textContent = "";
      const card = el("div", "cmcp-tr-card");
      card.append(el("h3", null, tr("training_ui.trainer_backend_not_available", "Trainer backend not available")));
      card.append(el("p", null,
        tr("training_ui.the_connected_orchestrator_doesn_t_expose_the",
          "The connected orchestrator doesn't expose the train_* tools — it needs to run the comfyui-mcp release that includes the LoRA trainer (PR #237 or later), and the panel's bridge must point at it. Upgrade/restart the orchestrator, then reopen this wizard.")));
      const back2 = el("button", "cmcp-tr-btn", tr("training_ui.back_flows", "← Flows"));
      back2.onclick = () => show("flows");
      card.append(back2);
      sec.appendChild(card);
    });

    const nameRow = el("div", "cmcp-tr-row");
    nameRow.append(el("label", null, tr("training_ui.dataset_name", "Dataset name")));
    const nameInput = el("input", null);
    nameInput.type = "text";
    nameInput.dataset.ref = "field:dataset_name";
    nameInput.placeholder = tr("training_ui.e_g_aria_character", "e.g. aria_character");
    nameInput.value = wiz.datasetName;
    nameInput.oninput = () => { wiz.datasetName = nameInput.value; syncNext(); };
    nameRow.appendChild(nameInput);

    const trigRow = el("div", "cmcp-tr-row");
    trigRow.append(el("label", null, tr("training_ui.trigger_word", "Trigger word")));
    const trigInput = el("input", null);
    trigInput.type = "text";
    trigInput.dataset.ref = "field:trigger";
    trigInput.placeholder = tr("training_ui.e_g_ohwx_a_rare_token_not", "e.g. ohwx — a rare token, not a real word");
    trigInput.value = wiz.trigger;
    trigInput.oninput = () => { wiz.trigger = trigInput.value.trim(); };
    trigRow.appendChild(trigInput);
    sec.append(nameRow, trigRow, el("p", "cmcp-tr-hint",
      tr("training_ui.10_30_varied_images_of_the_subject",
        "10–30 varied images of the subject work best (angles, lighting, backgrounds). The trigger word goes in every caption.")));

    // Source tabs. NOTE for the next editor: `el("button", "active", …)` puts the CLASS in
    // the second slot — only the THIRD argument is display text.
    const tabs = el("div", "cmcp-tr-seg");
    tabs.style.margin = "0";
    const outTab = el("button", "active", tr("training_ui.from_outputs", "From outputs"));
    const upTab = el("button", null, tr("training_ui.upload", "Upload"));
    tabs.append(outTab, upTab);
    const tabBody = el("div");
    sec.append(tabs, tabBody);

    // Selection tray.
    const trayLabel = el("p", "cmcp-tr-hint");
    const tray = el("div", "cmcp-tr-tray");
    const nav = el("div", "cmcp-tr-row");
    nav.style.marginTop = ".4rem";
    const back = el("button", "cmcp-tr-btn", tr("training_ui.back_flows", "← Flows"));
    back.onclick = () => show("flows");
    const next = el("button", "cmcp-tr-btn primary", tr("training_ui.next_label_captions", "Next: label captions →"));
    next.onclick = () => show("wizard-2");
    nav.append(back, next);
    sec.append(trayLabel, tray, nav);
    body.appendChild(sec);

    function syncTray() {
      // Counted strings pass `{ count }` and an OBJECT fallback, even where English says
      // the same thing for one and many: the plural slots are what let ko collapse to a
      // single form and ru take its four, which no `n === 1` test in here could get right.
      // The advice half is a SEPARATE, uncounted key rather than a second full sentence
      // duplicated across every plural category — ru would otherwise need the whole
      // sentence written four times here and four more times below, and the eight copies
      // would drift.
      if (!wiz.images.length) {
        trayLabel.textContent = tr("training_ui.nothing_selected_yet", "Nothing selected yet.");
      } else {
        const selected = tr("training_ui.n_selected", { one: "{count} selected", other: "{count} selected" }, { count: wiz.images.length });
        trayLabel.textContent = wiz.images.length < 6
          ? `${selected} ${tr("training_ui.add_more_for_a_usable_lora", "— add more for a usable LoRA (10–30 recommended)")}`
          : selected;
      }
      tray.textContent = "";
      wiz.images.forEach((img, idx) => {
        const chip = el("div", "cmcp-tr-chip");
        chip.style.backgroundImage = `url("${img.thumb}")`;
        const x = el("button", null, "×");
        x.title = tr("training_ui.remove", "Remove");
        x.onclick = () => { wiz.images.splice(idx, 1); syncTray(); syncNext(); if (refreshGridSel) refreshGridSel(); };
        chip.appendChild(x);
        tray.appendChild(chip);
      });
    }

    function syncNext() {
      // Also gated on the backend capability check: until train_start
      // (action:"list_flows") resolves, advancing is blocked (codex finding: the gate was bypassable
      // while pending).
      next.disabled = !backendCapable || wiz.uploadsPending > 0 || !(wiz.images.length >= 1 && sanitizeNameClient(wiz.datasetName));
      // "upload(s)" becomes a real plural here: the parenthesised-s dodge exists only
      // because English had no plural machinery at this call site, and it translates
      // badly (many languages have no such shorthand).
      next.title = !backendCapable && !backendChecked ? tr("training_ui.checking_trainer_backend", "Checking trainer backend…")
        : wiz.uploadsPending > 0
          ? tr("training_ui.waiting_for_n_uploads",
              { one: "Waiting for {count} upload…", other: "Waiting for {count} uploads…" },
              { count: wiz.uploadsPending })
          : "";
    }

    // Outputs tab. The filename filter is the shell's shared search box
    // (decision B) — no local input; paint() reads `outputsFilter`.
    let refreshGridSel = null;
    async function renderOutputs() {
      tabBody.textContent = "";
      outputsTabActive = true;
      try { shell.searchEl.value = outputsFilter; } catch { /* not mounted */ }
      try { shell.syncSearch(); } catch { /* not mounted */ }
      const grid = el("div", "cmcp-tr-pickgrid");
      const status = el("p", "cmcp-tr-hint", tr("training_ui.loading_recent_outputs", "Loading recent outputs…"));
      tabBody.append(status, grid);
      let images = [];
      try {
        const res = await apiFetch(ctx, "/comfyui_mcp_panel/training/list-outputs?limit=120");
        const data = await res.json();
        images = data.images || [];
        status.textContent = images.length ? "" : tr("training_ui.no_output_images_found_generate_something_first", "No output images found — generate something first, or use Upload.");
      } catch (e) {
        status.textContent = tr("training_ui.could_not_list_outputs", "Could not list outputs: {error}", { error: e.message || e });
        return;
      }
      const isSel = (img) => wiz.images.some((w) => w.ref.filename === img.filename && (w.ref.subfolder || "") === (img.subfolder || "") && w.ref.type === "output");
      function paint() {
        grid.textContent = "";
        const pat = outputsFilter.trim().toLowerCase();
        for (const img of images) {
          if (pat && !img.filename.toLowerCase().includes(pat)) continue;
          const cell = el("div", "cmcp-tr-pick");
          const url = viewUrl(ctx, { filename: img.filename, subfolder: img.subfolder, type: "output" });
          // <img loading=lazy> — CSS backgrounds would eagerly decode ALL ~120
          // full-res outputs at once (codex finding: hundreds of MB, stalled modal).
          const thumb = document.createElement("img");
          thumb.loading = "lazy";
          thumb.src = url;
          thumb.alt = img.filename;
          cell.appendChild(thumb);
          if (isSel(img)) cell.classList.add("sel");
          const mark = el("div", "mark", isSel(img) ? "✓" : "+");
          cell.appendChild(mark);
          cell.title = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
          cell.onclick = () => {
            const at = wiz.images.findIndex((w) => w.ref.filename === img.filename && (w.ref.subfolder || "") === (img.subfolder || "") && w.ref.type === "output");
            if (at >= 0) wiz.images.splice(at, 1);
            else wiz.images.push({ ref: { filename: img.filename, subfolder: img.subfolder || undefined, type: "output" }, thumb: url, caption: "" });
            syncTray(); syncNext(); paint();
          };
          grid.appendChild(cell);
        }
        refreshGridSel = paint;
        repaintOutputs = paint; // the shared search re-runs this via onSearch
      }
      paint();
    }

    // Upload tab.
    function renderUpload() {
      tabBody.textContent = "";
      const drop = el("div", "cmcp-tr-drop", tr("training_ui.drop_images_here_or_click_to_browse", "Drop images here, or click to browse"));
      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = "image/png,image/jpeg,image/webp";
      picker.multiple = true;
      picker.style.display = "none";
      const status = el("p", "cmcp-tr-hint");
      tabBody.append(drop, picker, status);
      // Per-file upload deadline. uploadBlobToInput has no abort path (it
      // swallows errors and returns null, but a request that never settles
      // hangs its promise forever) — so race it against a timer. Without this,
      // ONE hung upload left uploadsPending > 0 permanently and deadlocked
      // wizard navigation (codex finding). A late success after the timeout is
      // simply discarded — the file is reported failed and can be re-added.
      const UPLOAD_TIMEOUT_MS = 30000;
      function withTimeout(promise, ms, label) {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s: ${label}`)), ms);
          promise.then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); },
          );
        });
      }
      // Magic-byte sniff: the extension regex alone happily uploads any file
      // renamed to .png (codex finding). Cheap 12-byte header check for the
      // three accepted formats; on read failure fall back to trusting the
      // extension (sniffing is a guard, not a gate on flaky File APIs).
      async function looksLikeImage(f) {
        try {
          const b = new Uint8Array(await f.slice(0, 12).arrayBuffer());
          const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
          const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
          const webp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
            && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
          return png || jpg || webp;
        } catch {
          return true;
        }
      }
      async function addFiles(files) {
        if (!ctx.uploadBlobToInput) { status.textContent = tr("training_ui.upload_unavailable_no_bridge_helper", "Upload unavailable (no bridge helper)."); return; }
        // Track the batch: Next stays disabled until every upload settles, so a
        // user can't advance mid-batch and silently lose/re-caption the files
        // still in flight (codex finding).
        const batch = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
        const skipped = files.length - batch.length;
        const failed = [];
        const notImage = [];
        const gen = wiz.uploadGen;
        wiz.uploadsPending += batch.length;
        syncNext();
        for (const f of batch) {
          // The file NAME is user-supplied, so it is substituted last (see fmtAgo's note).
          status.textContent = tr("training_ui.uploading_added", "Uploading {name}… ({added} added)", { added: wiz.images.length, name: f.name });
          try {
            if (!(await looksLikeImage(f))) { notImage.push(f.name); continue; }
            const ref = await withTimeout(
              ctx.uploadBlobToInput(f, f.name.replace(/[^a-zA-Z0-9._-]+/g, "_")),
              UPLOAD_TIMEOUT_MS,
              f.name,
            );
            if (gen !== wiz.uploadGen) return; // wizard was reset mid-batch — discard
            if (!ref) { failed.push(f.name); continue; }
            wiz.images.push({ ref: { filename: ref.filename, subfolder: ref.subfolder, type: "input" }, thumb: viewUrl(ctx, { ...ref, type: "input" }), caption: "" });
          } catch {
            // Timeout (or an unexpected reject) — record and MOVE ON so the
            // rest of the batch still uploads and the pending count settles.
            if (gen !== wiz.uploadGen) return;
            failed.push(f.name);
          } finally {
            // Only settle the counter when the batch still belongs to the
            // current wizard run (a reset zeroed it already).
            if (gen === wiz.uploadGen) wiz.uploadsPending -= 1;
            syncTray(); syncNext();
          }
        }
        // Batch summary PERSISTS (codex finding: per-file errors were cleared
        // by the next success, hiding an incomplete dataset).
        const parts = [];
        if (skipped) {
          parts.push(tr("training_ui.n_skipped_wrong_extension",
            { one: "{count} skipped (png/jpg/webp only)", other: "{count} skipped (png/jpg/webp only)" },
            { count: skipped }));
        }
        if (notImage.length) {
          parts.push(tr("training_ui.n_skipped_not_a_real_image",
            { one: "{count} skipped (not a real png/jpg/webp): {names}", other: "{count} skipped (not a real png/jpg/webp): {names}" },
            { count: notImage.length, names: notImage.join(", ") }));
        }
        if (failed.length) {
          parts.push(tr("training_ui.n_failed",
            { one: "{count} FAILED: {names}", other: "{count} FAILED: {names}" },
            { count: failed.length, names: failed.join(", ") }));
        }
        status.textContent = parts.join(" · ");
        status.style.color = failed.length || notImage.length ? "#ef4444" : "";
      }
      drop.onclick = () => picker.click();
      picker.onchange = () => addFiles([...picker.files]);
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = () => drop.classList.remove("over");
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles([...e.dataTransfer.files]); };
    }

    outTab.onclick = () => { outTab.classList.add("active"); upTab.classList.remove("active"); renderOutputs(); };
    upTab.onclick = () => {
      upTab.classList.add("active"); outTab.classList.remove("active");
      // Upload has nothing to filter — hide the shared search.
      outputsTabActive = false; repaintOutputs = null;
      try { shell.syncSearch(); } catch { /* not mounted */ }
      renderUpload();
    };
    renderOutputs();
    syncTray();
    syncNext();
  }

  // ---------------------------------------------------------------- label ---
  function renderLabel() {
    const sec = el("div", "cmcp-tr-section");
    const bulk = el("div", "cmcp-tr-row");
    const prefixBtn = el("button", "cmcp-tr-btn", tr(
      "training_ui.prefix_to_all", 'Prefix "{trigger}" to all',
      // The user's own trigger token is never translated; only the stand-in word is.
      { trigger: wiz.trigger || tr("training_ui.trigger", "trigger") },
    ));
    prefixBtn.onclick = () => {
      const t = wiz.trigger.trim();
      if (!t) return;
      wiz.images.forEach((img) => {
        const c = img.caption.trim();
        if (!c) img.caption = t;
        else if (!c.toLowerCase().startsWith(t.toLowerCase())) img.caption = `${t} ${c}`;
      });
      paint();
    };
    const applyAllBtn = el("button", "cmcp-tr-btn", tr("training_ui.apply_first_caption_to_all", "Apply first caption to all"));
    applyAllBtn.onclick = () => {
      const first = (wiz.images[0]?.caption || "").trim();
      if (!first) return;
      wiz.images.forEach((img) => { img.caption = first; });
      paint();
    };
    const clearBtn = el("button", "cmcp-tr-btn", tr("training_ui.clear_all", "Clear all"));
    clearBtn.onclick = () => { wiz.images.forEach((img) => { img.caption = ""; }); paint(); };
    bulk.append(prefixBtn, applyAllBtn, clearBtn);
    const countHint = el("p", "cmcp-tr-hint");
    const grid = el("div", "cmcp-tr-labelgrid");
    const nav = el("div", "cmcp-tr-row");
    const back = el("button", "cmcp-tr-btn", tr("training_ui.back_dataset", "← Dataset"));
    back.onclick = () => show("wizard-1");
    const next = el("button", "cmcp-tr-btn primary", tr("training_ui.next_review_launch", "Next: review & launch →"));
    next.onclick = () => show("wizard-3");
    nav.append(back, next);
    sec.append(bulk, countHint, grid, nav);
    body.appendChild(sec);

    function syncHint() {
      const captioned = wiz.images.filter((i) => i.caption.trim()).length;
      countHint.textContent = tr("training_ui.captioned_caption_what_changes_between_images",
        "{captioned}/{total} captioned — caption what CHANGES between images (pose, setting, clothing); the trigger word covers identity. Empty captions fall back to the trigger word.",
        { captioned, total: wiz.images.length });
    }
    function paint() {
      grid.textContent = "";
      wiz.images.forEach((img) => {
        const item = el("div", "cmcp-tr-labelitem");
        // Stable per-image ref (audit item 7): key off subfolder+filename (the
        // selection identity), NOT the array index (which shifts on removal) and
        // NOT filename alone (a/foo.png and b/foo.png would collide — codex).
        const fn = img.ref?.filename;
        const imgId = fn ? (img.ref?.subfolder ? `${img.ref.subfolder}/${fn}` : fn) : null;
        if (imgId) item.dataset.ref = `caption:${imgId}`;
        const thumb = el("div", "thumb");
        thumb.style.backgroundImage = `url("${img.thumb}")`;
        const ta = document.createElement("textarea");
        ta.placeholder = wiz.trigger ? `${wiz.trigger} …` : tr("training_ui.caption", "caption…");
        ta.value = img.caption;
        ta.oninput = () => { img.caption = ta.value; syncHint(); };
        item.append(thumb, ta);
        grid.appendChild(item);
      });
      syncHint();
    }
    paint();
  }

  // --------------------------------------------------------------- launch ---
  function renderLaunch() {
    const sec = el("div", "cmcp-tr-section");
    const captioned = wiz.images.filter((i) => i.caption.trim()).length;
    // Reuse mode (Jobs/Datasets → "Train again"): the set is already staged —
    // say so up front, with an escape back to the full wizard (codex-style
    // honesty: the launch below will NOT re-stage anything).
    if (wiz.reuseDataset) {
      const reuseBox = el("div", "cmcp-tr-card active");
      const rd = wiz.reuseDataset;
      reuseBox.append(el("p", null,
        tr("training_ui.reusing_staged_dataset_already_captioned_and_staged",
          'Reusing staged dataset "{name}" — already captioned and staged, so Launch starts training immediately (nothing is re-gathered or re-labeled).',
          { name: rd.name })));
      const changeBtn = el("button", "cmcp-tr-btn", tr("training_ui.use_a_different_dataset", "Use a different dataset"));
      changeBtn.onclick = () => { wiz.reuseDataset = null; show("wizard-1"); };
      reuseBox.appendChild(changeBtn);
      sec.appendChild(reuseBox);
    }
    // Live summary (rank updates with preset switches + custom edits).
    const summaryHint = el("p", "cmcp-tr-hint");
    const syncSummary = () => {
      const effRank = wiz.preset === "custom" ? (wiz.customParams?.rank ?? 16) : (PRESETS[wiz.preset].params?.rank ?? 16);
      // The optional trigger clause is its own key rather than two near-identical variants
      // of each sentence — a translator who has to reorder the clause can move `{trigger}`
      // wherever their grammar wants it.
      const trigger = wiz.trigger
        ? tr("training_ui.trigger_clause", ', trigger "{trigger}"', { trigger: wiz.trigger })
        : "";
      // `trigger` holds the user's own token and therefore comes LAST in both vars objects
      // (interpolation-order note near fmtAgo) — otherwise a trigger word of "{rank}" would
      // be overwritten by the rank on the following substitution.
      summaryHint.textContent = wiz.reuseDataset
        ? tr("training_ui.job_name_new_run_of_staged_set",
            'Job name "{name}" (new run of staged set "{set}"){trigger}. Model: FLUX.1-dev (quantized, rank {rank}).',
            { name: sanitizeNameClient(wiz.datasetName), set: wiz.reuseDataset.name, rank: effRank, trigger })
        : tr("training_ui.dataset_images_with_custom_captions_model_flux",
            'Dataset "{name}" — {images} images, {captioned} with custom captions{trigger}. Model: FLUX.1-dev (quantized, rank {rank}).',
            { name: sanitizeNameClient(wiz.datasetName), images: wiz.images.length, captioned, rank: effRank, trigger });
    };
    syncSummary();
    sec.append(summaryHint);

    // Presets.
    const presetSeg = el("div", "cmcp-tr-seg");
    presetSeg.style.margin = "0";
    const presetNote = el("p", "cmcp-tr-hint");
    const customBox = el("div", "cmcp-tr-row");
    // Initialize visibility from the CURRENT preset and seed fields from the
    // user's saved custom edits (codex finding: navigating away and back used
    // to silently reseed defaults and submit them).
    customBox.style.display = wiz.preset === "custom" ? "" : "none";
    const customFields = {};
    // Assigned once the launch button exists (below); persist() calls it during
    // seeding too, so start with a no-op.
    let syncLaunchEnabled = () => {};
    // Strict full-token parsers — parseInt/parseFloat truncate ("2000oops" →
    // 2000), which would submit a value the user can't see (codex finding).
    const parseIntStrict = (v) => (/^\d+$/.test(v.trim()) ? parseInt(v.trim(), 10) : NaN);
    const parseLrStrict = (v) => (/^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim()) ? parseFloat(v.trim()) : NaN);
    const parseResStrict = (v) => {
      const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
      return parts.length && parts.every((p) => /^\d+$/.test(p) && parseInt(p, 10) > 0) ? parts.map((p) => parseInt(p, 10)) : null;
    };
    // Sane ceilings for free-form custom params (#104): the Custom preset
    // accepts any number, so a typo (steps=10^9, rank=100000, resolution=100000)
    // starts a doomed/OOM BILLED run. Mirrored by the backend train_start
    // schema's max constraints in comfyui-mcp — this is the friendly gate,
    // that one is the hard wall.
    const PARAM_MAX = { steps: 100000, lr: 1, rank: 1024, resolution: 4096 };
    const PARAM_MIN = { resolution: 64 };
    const inBounds = (key, n) => Number.isFinite(n) && n > 0 && n <= PARAM_MAX[key];
    const resInBounds = (list) => !!list && list.every((r) => r >= PARAM_MIN.resolution && r <= PARAM_MAX.resolution);
    // `key` is the WIRE name (train_start's schema) and stays English; `label` is the
    // visible caption and does not. Built inside the render, so a plain tr() is correct
    // here — unlike FLOWS/PRESETS at module scope, this runs long after the catalog loads.
    for (const [key, label] of [
      ["steps", tr("training_ui.steps", "Steps")],
      ["lr", tr("training_ui.learning_rate", "Learning rate")],
      ["rank", tr("training_ui.lora_rank", "LoRA rank")],
      ["resolution", tr("training_ui.resolutions_comma", "Resolutions (comma)")],
    ]) {
      const l = el("label", null, label);
      l.style.minWidth = "auto";
      const inp = el("input", null);
      inp.type = "text";
      inp.dataset.ref = `param:${key}`;
      inp.style.flex = "0 1 110px";
      inp.title = key === "resolution"
        ? tr("training_ui.each_min_max", "each {min}–{max}", { min: PARAM_MIN.resolution, max: PARAM_MAX.resolution })
        : tr("training_ui.max_value", "max {max}", { max: PARAM_MAX[key] });
      const saved = wiz.customParams?.[key];
      inp.value = saved !== undefined
        ? (key === "resolution" ? saved.join(",") : String(saved))
        : (key === "resolution" ? "512,768,1024" : String(PRESETS.standard.params[key] ?? ""));
      customFields[key] = inp;
      const persist = () => {
        wiz.customParams = wiz.customParams || {};
        if (key === "resolution") {
          const list = parseResStrict(inp.value);
          if (resInBounds(list)) wiz.customParams.resolution = list;
          else delete wiz.customParams.resolution;
        } else {
          const n = key === "lr" ? parseLrStrict(inp.value) : parseIntStrict(inp.value);
          if (inBounds(key, n)) wiz.customParams[key] = n;
          else delete wiz.customParams[key];
        }
        syncLaunchEnabled();
      };
      inp.oninput = () => { persist(); syncSummary(); };
      persist(); // capture the seeded values too
      customBox.append(l, inp);
    }
    function syncCustomValidity() {
      // Launch is blocked while a custom field is visibly invalid — submitting a
      // stale previously-valid value the user no longer sees would silently
      // change an expensive run (codex finding).
      if (wiz.preset !== "custom") return true;
      return ["steps", "lr", "rank"].every((k) => {
        const n = k === "lr" ? parseLrStrict(customFields[k].value) : parseIntStrict(customFields[k].value);
        return inBounds(k, n);
      }) && resInBounds(parseResStrict(customFields.resolution.value));
    }
    for (const key of Object.keys(PRESETS)) {
      const b = el("button", key === wiz.preset ? "active" : null, PRESETS[key].label);
      b.onclick = () => {
        wiz.preset = key;
        [...presetSeg.children].forEach((c) => c.classList.remove("active"));
        b.classList.add("active");
        customBox.style.display = key === "custom" ? "" : "none";
        presetNote.textContent = PRESETS[key].note;
        // Hidden custom fields can't be invalid — recompute the launch gate
        // (codex finding: switching off Custom left a stale disable).
        syncLaunchEnabled();
        syncSummary();
      };
      presetSeg.appendChild(b);
    }
    presetNote.textContent = PRESETS[wiz.preset].note;
    sec.append(presetSeg, presetNote, customBox);

    // Preflight. Launch stays disabled until the doctor resolves — a pending
    // call that eventually reports a remote (non-local) ComfyUI must not leave
    // a clickable window for a doomed launch (codex finding).
    let preflightState = "pending"; // pending | local | remote | failed
    // Target-switch buttons, hoisted so syncLaunchEnabled can lock them while a
    // launch is in flight — a mid-launch target switch must not change what the
    // job runs on (codex finding).
    let targetBtns = [];
    const pre = el("div", "cmcp-tr-preflight");
    pre.append(el("span", null, tr("training_ui.preflight_checking", "Preflight: checking…")));
    sec.append(pre);
    const gpuLine = el("p", "cmcp-tr-hint");
    sec.append(gpuLine);
    // The GPU model name itself is an identifier ("RTX 4090 24GB") — only the label around
    // it is translated.
    fetchGpuLabel(ctx.api).then((gpu) => { if (gpu) gpuLine.textContent = tr("training_ui.local_gpu", "Local GPU: {gpu}", { gpu }); });
    const myDoctorGen = ++doctorGen;
    callJson(ctx, "train_doctor", { action: "doctor" }, { timeout: 180000 }).then((d) => {
      // A newer doctor (e.g. driveSetTarget's preflight) superseded this one —
      // don't let a stale completion overwrite wiz.podInfo or rebuild the switch.
      if (myDoctorGen !== doctorGen) return;
      const dd = d.data || {};
      wiz.podInfo = dd.pod && dd.pod.status === "RUNNING" ? dd.pod : null;
      // Re-derive target from the FRESH doctor result: if no pod (or its SSH
      // dropped), the switch below won't render, so a retained target:"pod"
      // would strand Launch disabled. Fall back to local (codex finding).
      if (!wiz.podInfo || !wiz.podInfo.ssh) wiz.target = "local";
      // Local ⇄ Pod switch — only when a RUNNING pod is connected (connector).
      if (wiz.podInfo) {
        const pod = wiz.podInfo;
        const targetSeg = el("div", "cmcp-tr-seg");
        targetSeg.style.margin = "0";
        const localBtn = el("button", wiz.target !== "pod" ? "active" : null, tr("training_ui.local_docker", "Local (docker)"));
        localBtn.dataset.ref = "target:local";
        const podBtn = el("button", wiz.target === "pod" ? "active" : null,
          tr("training_ui.pod", "Pod ({pod})", { pod: `${pod.name || pod.id}${pod.gpu ? ` · ${pod.gpu}` : ""}` }));
        podBtn.dataset.ref = "target:pod";
        if (!pod.ssh) podBtn.title = tr("training_ui.pod_has_no_working_ssh_endpoint", "pod has no working SSH endpoint");
        localBtn.onclick = () => { wiz.target = "local"; localBtn.classList.add("active"); podBtn.classList.remove("active"); syncLaunchEnabled(); syncSummary(); };
        podBtn.onclick = () => {
          if (!pod.ssh) return;
          wiz.target = "pod";
          podBtn.classList.add("active");
          localBtn.classList.remove("active");
          syncLaunchEnabled();
          syncSummary();
        };
        targetSeg.append(localBtn, podBtn);
        targetBtns = [localBtn, podBtn];
        // A launch may already be in flight when the doctor resolves (the user
        // can leave and return) — lock immediately if so.
        if (wiz.launching) targetBtns.forEach((b) => { b.disabled = true; });
        pre.before(targetSeg);
        const podNote = el("p", "cmcp-tr-hint",
          tr("training_ui.pod_training_runs_ai_toolkit_natively_on",
            `Pod training runs ai-toolkit natively ON the pod (no docker there). Fresh pods need a one-time bootstrap (~10 min) — run train_doctor (action:"bootstrap") (or ask the agent) once; it persists on the pod's volume. The pod bills GPU-time while it's up.`));
        pre.after(podNote);
      }
      pre.textContent = "";
      // Built as DOM nodes rather than an innerHTML template. Same markup, but the label is
      // now translated text, and interpolating catalog strings into innerHTML would make a
      // locale file an HTML-injection surface for no benefit — `<b>` is the only tag here.
      // The colon gets its own key because CJK writes it as "："; the SPACE after it lives
      // in code, so a translator's editor trimming the value can't glue "docker:" to the ✓.
      // Keys are prefixed `preflight_` deliberately: "image" alone would reach a translator
      // as one context-free word and be read as "picture" rather than "the Docker image".
      for (const [label, ok] of [
        [tr("training_ui.preflight_docker", "docker"), dd.docker],
        [tr("training_ui.preflight_gpu", "gpu"), dd.gpu],
        [tr("training_ui.preflight_image", "image"), dd.image],
        [tr("training_ui.preflight_hf_token", "hf token"), dd.hfTokenSet],
      ]) {
        const s = el("span", null, `${tr("training_ui.preflight_label", "{label}:", { label })} `);
        const mark = el("b", null, ok ? "✓" : "✗");
        mark.style.color = ok ? "#22c55e" : "#ef4444";
        s.appendChild(mark);
        pre.appendChild(s);
      }
      // `h` is the backend's own hint text — passed through, never translated here.
      (dd.hints || []).forEach((h) => sec.appendChild(el("p", "cmcp-tr-hint", `⚠ ${h}`)));
      if (dd.localFs === false) {
        preflightState = "remote";
        sec.appendChild(el("p", "cmcp-tr-hint",
          tr("training_ui.the_orchestrator_targets_a_remote_comfyui_dataset",
            "⚠ The orchestrator targets a REMOTE ComfyUI — dataset staging and the LoRA handoff need a ComfyUI local to the orchestrator's machine; launching from here would fail at staging. Point the orchestrator at this local ComfyUI first.")));
      } else if (!dd.docker || !dd.gpu || !dd.image) {
        // Missing prerequisites guarantee a rejected/failed run — keep Launch
        // disabled until the doctor passes (codex finding).
        preflightState = "prereq";
      } else {
        preflightState = "local";
      }
      syncLaunchEnabled();
      // The target buttons (target:pod / target:local) render HERE, after the
      // synchronous show() reapply — re-glow so an agent highlight of a target
      // that predates the doctor still lands.
      reapplyHighlight();
    }).catch((e) => {
      // Doctor unreachable/unavailable: train_start does its own docker+image
      // preflight server-side and reports honestly, so don't block on this.
      preflightState = "failed";
      syncLaunchEnabled();
      pre.textContent = "";
      // `e.message || e` matches every sibling catch in this file — a non-Error rejection
      // would otherwise render "Preflight unavailable: undefined".
      pre.appendChild(el("span", null, tr("training_ui.preflight_unavailable", "Preflight unavailable: {error}", { error: e.message || e })));
    });

    // Launch.
    const err = el("p", "cmcp-tr-hint");
    err.style.color = "#ef4444";
    // Persisted across renders: a failure that lands while the user is on a
    // different view is shown when they return here (codex finding).
    if (wiz.launchError) err.textContent = wiz.launchError;
    const nav = el("div", "cmcp-tr-row");
    const back = el("button", "cmcp-tr-btn", tr("training_ui.back_label", "← Label"));
    back.onclick = () => show("wizard-2");
    const launch = el("button", "cmcp-tr-btn primary", tr("training_ui.launch_training", "Launch training"));
    nav.append(back, launch);
    sec.append(err, nav);
    body.appendChild(sec);

    syncLaunchEnabled = () => {
      // Pod target: docker/gpu/image are irrelevant — the gate is a working pod
      // SSH endpoint (plus the custom-param check).
      const podReady = wiz.target === "pod" && !!wiz.podInfo?.ssh;
      // Dataset readiness shares the ONE _readiness() source with the gather Next
      // button + gotoStep, so an agent set_field that invalidates the name (or
      // otherwise breaks readiness) while already ON this step disables Launch
      // instead of leaving the gate bypassed (codex finding).
      const r = _readiness();
      const datasetReady = r.backendCapable && r.nameOk && r.hasImages && r.uploadsSettled;
      launch.disabled = wiz.launching
        || !datasetReady
        || (wiz.target === "pod" ? !podReady : preflightState !== "local" && preflightState !== "failed")
        || !syncCustomValidity();
      if (wiz.launching) launch.textContent = tr("training_ui.launching", "Launching…");
      else launch.textContent = wiz.target === "pod"
        ? tr("training_ui.launch_on_pod", "Launch on pod")
        : tr("training_ui.launch_training", "Launch training");
      // Freeze the target choice while launching — the submitted job runs on the
      // target that was selected at click time (codex finding).
      targetBtns.forEach((b) => { b.disabled = wiz.launching; });
    };
    syncLaunchEnabled();

    launch.onclick = async () => {
      err.textContent = "";
      if (!syncCustomValidity()) {
        err.textContent = tr("training_ui.fix_the_custom_parameters_first_every_field", "Fix the custom parameters first — every field needs a positive value.");
        return;
      }
      // Modal-scoped lock: navigating Back/Jobs and returning must NOT allow a
      // second launch while this one is mid-flight (codex finding).
      const gen = ++wiz.launchGen;
      wiz.launching = true;
      wiz.launchError = null;
      syncLaunchEnabled();
      // Snapshot the FULL launch configuration up front (codex finding): the
      // user can navigate and edit while the async resolve/stage/start is in
      // flight — the submitted job must be exactly what was reviewed at click
      // time, not a mix of old paths and new captions/settings.
      const snapTrigger = wiz.trigger || undefined;
      // Freeze the target at click time — the target buttons are locked during
      // the launch, but snapshot regardless so train_start below runs on the
      // reviewed target, never a live wiz.* that a race could have moved.
      const snapTarget = wiz.target;
      const snapPodId = snapTarget === "pod" && wiz.podInfo ? wiz.podInfo.id : undefined;
      const snap = {
        name: sanitizeNameClient(wiz.datasetName),
        trigger: snapTrigger,
        target: snapTarget,
        podId: snapPodId,
        images: wiz.images.map((i) => {
          let caption = i.caption.trim();
          // The UI tells users the trigger belongs in EVERY caption — enforce it
          // at snapshot time too (defaultCaption only covers empty ones, so a
          // hand-written caption could otherwise omit it and waste a run on a
          // LoRA unassociated with the token; codex finding).
          if (caption && snapTrigger && !caption.toLowerCase().startsWith(snapTrigger.toLowerCase())) {
            caption = `${snapTrigger} ${caption}`;
          }
          return { ref: { ...i.ref }, caption: caption || undefined };
        }),
        params: wiz.reuseDataset
          // Reuse mode: carry EVERY effective param from the source job
          // (batchSize/saveEvery/sampleEvery/quantize aren't custom-editable —
          // dropping them silently changed the rerun, codex finding). The 4
          // custom fields override on top; a named preset is a deliberate
          // switch away from the job's settings.
          ? (wiz.preset === "custom"
              ? { ...wiz.reuseDataset.params, ...(wiz.customParams || {}) }
              : { ...PRESETS[wiz.preset].params })
          : (wiz.preset === "custom"
              ? (Object.keys(wiz.customParams || {}).length ? { ...wiz.customParams } : undefined)
              : { ...PRESETS[wiz.preset].params }),
      };
      try {
        let datasetPath;
        if (wiz.reuseDataset) {
          // Reuse-a-staged-dataset mode (Jobs/Datasets → "Train again"): the
          // set is already staged with captions — skip resolve + re-staging
          // entirely and train straight from it.
          datasetPath = wiz.reuseDataset.datasetPath;
          if (gen !== wiz.launchGen) return;
        } else {
          // 1) Resolve image refs → host paths.
          const res = await apiFetch(ctx, "/comfyui_mcp_panel/training/resolve-paths", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ images: snap.images.map((i) => i.ref) }),
          });
          const resolved = (await res.json()).paths || [];
          if (gen !== wiz.launchGen) return; // superseded BEFORE any side effect
          const bad = resolved.filter((r) => r.error);
          if (bad.length) throw new Error(`${bad.length} image(s) could not be resolved: ${bad[0].error}`);
          // 2) Stage dataset.
          const items = resolved.map((r, i) => ({ path: r.path, caption: snap.images[i].caption }));
          const prep = await callJson(ctx, "train_prepare_dataset", { action: "prepare", name: snap.name, items, defaultCaption: snap.trigger }, { timeout: 60000 });
          if (gen !== wiz.launchGen) return; // superseded after staging, before launch
          datasetPath = prep.datasetPath;
        }
        // 3) Launch.
        const started = await callJson(ctx, "train_start", {
          action: "start",
          name: snap.name, flow: "character", model: "flux1-dev",
          datasetPath, trigger: snap.trigger, params: snap.params,
          target: snap.target,
          ...(snap.target === "pod" && snap.podId ? { pod_id: snap.podId } : {}),
        }, { timeout: 120000 });
        if (gen !== wiz.launchGen) return; // a newer launch/reset superseded this one
        wiz.jobId = started.job.id;
        wiz.job = started.job;
        wiz.launching = false;
        // Success must be VISIBLE: take the user to the new run's monitor
        // regardless of where they wandered mid-launch (codex finding).
        show("wizard-4");
      } catch (e) {
        if (gen !== wiz.launchGen) return; // stale handler — new run owns the state
        wiz.launching = false;
        wiz.launchError = e.message || String(e);
        // Failures must also be visible when the user left the launch step.
        if (currentView === "wizard-3") {
          err.textContent = wiz.launchError;
        } else {
          alert(tr("training_ui.training_launch_failed", "Training launch failed: {error}", { error: wiz.launchError }));
        }
        syncLaunchEnabled();
      }
    };
  }

  // -------------------------------------------------------------- monitor ---
  /** Persistent badge node — updated in place (replaceWith would detach it on
   *  the first poll and leave every later status invisible; codex finding). */
  function setBadge(badgeEl, job) {
    // Accepts the whole job so the live monitor shows the same pod-aware badge
    // as the Jobs list (codex finding: the monitor previously passed job.status
    // only, so a pod run never showed "· pod" while it was running).
    const status = job && typeof job === "object" ? job.status : job;
    const onPod = job && typeof job === "object" && job.target === "pod";
    // `status` stays the raw enum for the class lookup on the next line; only the rendered
    // text goes through statusLabel().
    const shown = statusLabel(status);
    badgeEl.textContent = onPod ? tr("training_ui.status_on_pod", "{status} · pod", { status: shown }) : shown;
    badgeEl.className = `cmcp-tr-badge ${STATUS_BADGE[status] || ""}`;
    badgeEl.title = onPod ? tr("training_ui.trained_on_a_runpod_pod", "Trained on a RunPod pod") : "";
  }

  function jobStatusBadge(job) {
    const b = el("span", `cmcp-tr-badge ${STATUS_BADGE[job.status] || ""}`, job.status);
    setBadge(b, job);
    return b;
  }

  function renderMonitor() {
    // Monotonic generation: bumps on every monitor (re)entry AND on stopPolling,
    // so a slow in-flight response from a previous monitor view is dropped
    // instead of overwriting the new one (codex finding).
    const myGen = ++pollGen;
    const sec = el("div", "cmcp-tr-section");
    const headRow = el("div", "cmcp-tr-row");
    const nameEl = el("h3", null, wiz.job?.name || wiz.jobId || tr("training_ui.untitled_job", "job"));
    nameEl.style.margin = "0";
    const badge = el("span", "cmcp-tr-badge", "…");
    headRow.append(nameEl, badge);
    const barWrap = el("div", "cmcp-tr-progress");
    const bar = el("div");
    bar.style.width = "0%";
    barWrap.appendChild(bar);
    const statLine = el("p", "cmcp-tr-hint");
    const samplesLabel = el("p", "cmcp-tr-hint");
    const samples = el("div", "cmcp-tr-samples");
    const logBox = el("div", "cmcp-tr-log");
    const resultBox = el("div", "cmcp-tr-section");
    resultBox.style.padding = "0";
    // Settings used + the dataset this job trained on (and a one-tap rerun) —
    // loaded once from train_start (action:"job_config") (the ai-toolkit config it consumed).
    const metaBox = el("div", "cmcp-tr-section");
    metaBox.style.padding = "0";
    const nav = el("div", "cmcp-tr-row");
    const cancelBtn = el("button", "cmcp-tr-btn danger", tr("training_ui.cancel_run", "Cancel run"));
    const jobsNavBtn = el("button", "cmcp-tr-btn", tr("training_ui.all_jobs", "All jobs"));
    jobsNavBtn.onclick = () => show("jobs");
    nav.append(cancelBtn, jobsNavBtn);
    sec.append(headRow, barWrap, statLine, samplesLabel, samples, metaBox, resultBox, logBox, nav);
    body.appendChild(sec);

    (async () => {
      if (!wiz.jobId) return;
      try {
        const cfg = await callJson(ctx, "train_start", { action: "job_config", id: wiz.jobId }, { timeout: 30000 });
        // Do NOT gate on pollGen: a terminal status stopPolling()s (bumping the
        // generation) and would discard a perfectly good config response —
        // settings/dataset/train-again must still render for completed jobs
        // (codex finding). The only real guards: modal open, still on Monitor.
        if (closed || currentView !== "wizard-4") return;
        const p = cfg.params || {};
        const bits = [
          p.steps != null ? `${p.steps} steps` : null,
          p.lr != null ? `lr ${p.lr}` : null,
          p.rank != null ? `rank ${p.rank}` : null,
          Array.isArray(p.resolution) ? `res ${p.resolution.join("/")}` : null,
          p.batchSize != null ? `batch ${p.batchSize}` : null,
          p.saveEvery != null ? `save ${p.saveEvery}` : null,
          p.sampleEvery != null ? `sample ${p.sampleEvery}` : null,
          p.quantize != null ? (p.quantize ? "quantize on" : "quantize off") : null,
        ].filter(Boolean);
        metaBox.textContent = "";
        // `bits` above are built from the train_start parameter names (steps / lr / rank /
        // res / batch / save / sample / quantize), which the unit spec keeps in English as
        // wire vocabulary. That leaves a little English prose riding along with them —
        // "quantize on/off", the trailing "steps" — which is a deliberate consequence of
        // that rule, not an oversight: splitting each bit into label + value to translate
        // three words would make a compact one-line settings summary unreadable. Only the
        // wrapper is translated.
        if (bits.length) metaBox.append(el("p", "cmcp-tr-hint", tr("training_ui.settings", "Settings: {settings}", { settings: bits.join(" · ") })));
        if (cfg.datasetPath) {
          const dsName = cfg.datasetPath.replace(/\\/g, "/").split("/").pop();
          const dsRow = el("div", "cmcp-tr-row");
          const dsLink = el("button", "cmcp-tr-btn", tr("training_ui.dataset_link", "Dataset: {name}", { name: dsName }));
          dsLink.title = tr("training_ui.see_the_labeled_set_this_job_trained",
            "{path} — see the labeled set this job trained on", { path: cfg.datasetPath });
          dsLink.onclick = () => { wiz.datasetDetail = dsName; show("dataset-detail"); };
          const againBtn = el("button", "cmcp-tr-btn", tr("training_ui.train_again", "Train again"));
          againBtn.title = tr("training_ui.run_another_job_from_this_dataset_settings", "Run another job from this dataset + settings");
          againBtn.onclick = async () => {
            if (!resetWizardConfig()) { alert(launchInFlightMsg()); return; }
            await checkBackendCapable(); // a Jobs-first entry may never have probed (codex)
            wiz.reuseDataset = { name: dsName, datasetPath: cfg.datasetPath, params: p };
            wiz.datasetName = await uniqueRerunName(cfg.name);
            if (cfg.trigger) wiz.trigger = cfg.trigger;
            wiz.preset = "custom";
            wiz.customParams = {};
            for (const k of ["steps", "lr", "rank", "resolution"]) if (p[k] != null) wiz.customParams[k] = p[k];
            show("wizard-3");
          };
          dsRow.append(dsLink, againBtn);
          metaBox.appendChild(dsRow);
        }
      } catch { /* config view is best-effort decoration */ }
    })();

    let lastStep = null;
    let lastStepAt = null;

    cancelBtn.onclick = async () => {
      if (!wiz.jobId) return;
      if (!confirm(tr("training_ui.cancel_this_training_run_saved_checkpoints_stay",
        "Cancel this training run? Saved checkpoints stay in the job's output dir; no LoRA is handed off."))) return;
      cancelBtn.disabled = true;
      try {
        await callJson(ctx, "train_start", { action: "cancel", id: wiz.jobId }, { timeout: 60000 });
      } catch (e) {
        alert(e.message || String(e));
      } finally {
        cancelBtn.disabled = false;
      }
    };

    async function poll() {
      if (!wiz.jobId || myGen !== pollGen) return;
      try {
        const d = await callJson(ctx, "train_start", { action: "status", id: wiz.jobId }, { timeout: 30000 });
        if (myGen !== pollGen) return; // view changed while the request was out
        const job = d.job;
        wiz.job = job;
        setBadge(badge, job);
        const p = job.progress || {};
        if (p.totalSteps) {
          const pct = Math.min(100, Math.round(((p.step || 0) / p.totalSteps) * 100));
          bar.style.width = `${pct}%`;
          let eta = "";
          if (p.step !== undefined && lastStep !== null && p.step > lastStep) {
            const perSec = (Date.now() - lastStepAt) / (p.step - lastStep);
            const left = Math.round(((p.totalSteps - p.step) * perSec) / 1000);
            // "12m 30s" is an abbreviated duration, not prose — kept out of the key so a
            // translator localises "~{time} left" without having to rebuild the clock.
            if (left > 5) {
              const time = `${Math.floor(left / 60)}m${left % 60 ? ` ${left % 60}s` : ""}`;
              eta = tr("training_ui.eta_left", "~{time} left", { time });
            }
          }
          if (p.step !== lastStep) { lastStep = p.step; lastStepAt = Date.now(); }
          // Assembled from independent segments joined by a separator this code owns, rather
          // than one template with " · loss {loss}" style clauses baked into the catalog.
          // Those clauses would carry LOAD-BEARING leading whitespace, and a translation
          // tool that trims (most do) would silently glue "step 40/200" to "· loss 0.42"
          // with nothing in the i18n gate able to see it — it compares placeholders, not
          // spacing. Renders identically to the template it replaced.
          const parts = [tr("training_ui.step_of_total", "step {step}/{total}", { step: p.step ?? "—", total: p.totalSteps })];
          if (p.loss !== undefined) parts.push(tr("training_ui.loss", "loss {loss}", { loss: Number(p.loss).toFixed(4) }));
          if (eta) parts.push(eta);
          parts.push(tr("training_ui.updated_ago", "updated {ago}", { ago: fmtAgo(job.updatedAt) }));
          statLine.textContent = parts.join(" · ");
        } else {
          statLine.textContent = tr("training_ui.model_download_dataset_caching_can_take_several",
            "{status} — model download / dataset caching can take several minutes on first run · updated {ago}",
            { status: statusLabel(job.status), ago: fmtAgo(job.updatedAt) });
        }
        const s = p.samples || [];
        if (s.length) {
          samplesLabel.textContent = tr("training_ui.latest_samples", "Latest samples:");
          samples.textContent = "";
          for (const sp of s) {
            const img = document.createElement("img");
            img.src = sampleUrl(ctx, sp);
            img.onclick = () => window.open(sampleUrl(ctx, sp), "_blank");
            samples.appendChild(img);
          }
        } else {
          samplesLabel.textContent = job.status === "running"
            ? tr("training_ui.samples_appear_here_as_the_run_produces", "Samples appear here as the run produces them.")
            : "";
        }
        logBox.textContent = (job.log || []).slice(-8).join("\n") || tr("training_ui.no_log_yet", "(no log yet)");
        logBox.scrollTop = logBox.scrollHeight;
        const terminal = ["completed", "failed", "cancelled"].includes(job.status);
        cancelBtn.style.display = terminal ? "none" : "";
        resultBox.textContent = "";
        if (job.status === "completed") {
          stopPolling();
          const card = el("div", "cmcp-tr-card active");
          card.append(el("h3", null, tr("training_ui.lora_ready", "LoRA ready ✓")));
          // LoraLoaderModelOnly and FLUX.1-dev are node/model identifiers — they stay put
          // inside the sentence; the user's own trigger token likewise. The separating
          // space is concatenated here rather than led with inside the catalog value.
          const prompt = job.trigger
            ? ` ${tr("training_ui.and_prompt_with", 'and prompt with "{trigger}"', { trigger: job.trigger })}`
            : "";
          // `prompt` carries the user's trigger word, so it is substituted LAST — see the
          // interpolation-order note near fmtAgo.
          card.append(el("p", null, tr("training_ui.in_the_lora_picker_now_load_it",
            "{path} — in the LoRA picker now. Load it with LoraLoaderModelOnly on FLUX.1-dev{prompt}.",
            { path: job.result?.loraRelPath || tr("training_ui.copied_to_models_loras", "copied to models/loras"), prompt })));
          resultBox.appendChild(card);
        } else if (job.status === "failed") {
          stopPolling();
          const card = el("div", "cmcp-tr-card");
          card.append(el("h3", null, tr("training_ui.run_failed", "Run failed")));
          card.append(el("p", null, (job.error || "").slice(0, 600)));
          resultBox.appendChild(card);
        } else if (job.status === "cancelled") {
          stopPolling();
        }
      } catch (e) {
        if (myGen === pollGen) {
          statLine.textContent = tr("training_ui.status_poll_failed_bridge_retrying",
            "status poll failed (bridge?) — retrying… ({error})", { error: e.message || e });
        }
      } finally {
        // Chained (never overlapping) scheduling: the next poll starts only
        // after this one settles — a slow bridge can't stack up requests or
        // resolve them out of order (codex finding). stopPolling() bumps the
        // generation, so terminal/navigation paths never reschedule.
        if (myGen === pollGen) pollTimer = setTimeout(poll, 5000);
      }
    }
    poll();
  }

  // ------------------------------------------------------------- datasets ---
  /** Staged datasets (the labeled sets from prepare) — see what you trained
   *  on, and run another job from the same set. */
  async function renderDatasets() {
    const sec = el("div", "cmcp-tr-section");
    const topRow = el("div", "cmcp-tr-row");
    const backBtn = el("button", "cmcp-tr-btn", tr("training_ui.all_jobs", "All jobs"));
    backBtn.onclick = () => show("jobs");
    topRow.appendChild(backBtn);
    const list = el("div");
    list.append(el("p", "cmcp-tr-hint", tr("training_ui.loading_datasets", "Loading datasets…")));
    sec.append(topRow, list);
    body.appendChild(sec);
    let datasets = [];
    try {
      const d = await callJson(ctx, "train_prepare_dataset", { action: "list" }, { timeout: 30000 });
      datasets = d.datasets || [];
    } catch (e) {
      list.textContent = "";
      list.append(el("p", "cmcp-tr-hint", tr("training_ui.could_not_load_datasets", "Could not load datasets: {error}", { error: e.message || e })));
      return;
    }
    list.textContent = "";
    if (!datasets.length) {
      list.append(el("p", "cmcp-tr-hint", tr("training_ui.no_staged_datasets_yet_gather_images_in", "No staged datasets yet — gather images in a new character LoRA run.")));
      return;
    }
    for (const ds of datasets) {
      const row = el("div", "cmcp-tr-jobrow");
      row.dataset.ref = `dataset:${ds.name}`;
      const name = el("span", "name", ds.name);
      // The hand-rolled `image${n === 1 ? "" : "s"}` is exactly what the plural fallback
      // replaces: it is right in English and wrong in ko (no plural) and ru (four forms).
      const meta = el("span", "meta",
        tr("training_ui.n_images_captioned_modified",
          { one: "{count} image · {captioned} captioned · {ago}", other: "{count} images · {captioned} captioned · {ago}" },
          { count: ds.imageCount, captioned: ds.captionedCount, ago: fmtAgo(ds.modified) }));
      row.append(name, meta);
      row.onclick = () => { wiz.datasetDetail = ds.name; show("dataset-detail"); };
      list.appendChild(row);
    }
    reapplyHighlight(); // rows landed async, after show()'s initial glow pass
  }

  /** One staged dataset: thumb grid + captions + "train with this dataset". */
  async function renderDatasetDetail() {
    const name = wiz.datasetDetail;
    const sec = el("div", "cmcp-tr-section");
    const topRow = el("div", "cmcp-tr-row");
    const backBtn = el("button", "cmcp-tr-btn", tr("training_ui.all_datasets", "All datasets"));
    backBtn.onclick = () => show("datasets");
    topRow.appendChild(backBtn);
    const head = el("h3", null, name || tr("training_ui.untitled_dataset", "dataset"));
    head.style.margin = "0";
    const sub = el("p", "cmcp-tr-hint", tr("training_ui.loading", "Loading…"));
    const grid = el("div", "cmcp-tr-samples");
    sec.append(topRow, head, sub, grid);
    body.appendChild(sec);
    let d;
    try {
      d = await callJson(ctx, "train_prepare_dataset", { action: "detail", name }, { timeout: 30000 });
    } catch (e) {
      sub.textContent = tr("training_ui.could_not_load_dataset", "Could not load dataset: {error}", { error: e.message || e });
      return;
    }
    sub.textContent = tr("training_ui.n_images_captioned_path",
      { one: "{count} image · {captioned} captioned · {path}", other: "{count} images · {captioned} captioned · {path}" },
      { count: d.imageCount, captioned: d.captionedCount, path: d.datasetPath });
    grid.textContent = "";
    // Thumbs ride train_prepare_dataset (action:"file") for inline bytes — NOT
    // the /training/file py route: that route only serves files under the
    // PANEL's own training roots, so an orchestrator-side dataset path 403/404s
    // there (codex finding). Bounded and tunnel-safe by design.
    const imgUrl = async (file) => {
      try {
        const res = await ctx.callTool("train_prepare_dataset", { action: "file", path: `${d.datasetPath}/${file}` }, { timeout: 30000 });
        const img = (res?.result || []).find((c) => c?.type === "image" && c.data && c.mimeType);
        return img ? `data:${img.mimeType};base64,${img.data}` : null;
      } catch {
        return null;
      }
    };
    for (const it of d.items || []) {
      const cell = el("div");
      cell.style.maxWidth = "180px";
      const cap = el("p", "cmcp-tr-hint", it.caption || tr("training_ui.no_caption", "(no caption)"));
      cap.style.fontSize = "11px";
      cell.appendChild(cap);
      grid.appendChild(cell);
      imgUrl(it.file).then((url) => {
        if (!url) return;
        const img = document.createElement("img");
        img.src = url;
        img.style.width = "100%";
        img.style.borderRadius = "6px";
        cell.insertBefore(img, cap);
        reapplyHighlight();
      });
    }
    reapplyHighlight(); // async content landed after show()'s initial glow pass
    // Train again with THIS staged set: skip the gather/label staging entirely
    // (train_start takes datasetPath directly). Prefill a distinct job name so
    // the new run can't silently overwrite the previous LoRA.
    const trainBtn = el("button", "cmcp-tr-btn primary", tr("training_ui.train_with_this_dataset", "Train with this dataset"));
    trainBtn.dataset.ref = "train_with_dataset";
    trainBtn.onclick = async () => {
      if (!resetWizardConfig()) { alert(launchInFlightMsg()); return; }
      await checkBackendCapable(); // a Datasets-first entry may never have probed (codex)
      wiz.reuseDataset = { name: d.name, datasetPath: d.datasetPath };
      wiz.datasetName = await uniqueRerunName(d.name);
      show("wizard-3");
    };
    sec.appendChild(trainBtn);
  }

  // ----------------------------------------------------------------- jobs ---
  async function renderJobs() {
    const sec = el("div", "cmcp-tr-section");
    const topRow = el("div", "cmcp-tr-row");
    const newBtn = el("button", "cmcp-tr-btn primary", tr("training_ui.new_character_lora", "New character LoRA"));
    newBtn.onclick = () => {
      if (!resetWizardConfig()) { alert(launchInFlightMsg()); return; }
      show("wizard-1");
    };
    topRow.appendChild(newBtn);
    const list = el("div");
    list.append(el("p", "cmcp-tr-hint", tr("training_ui.loading_jobs", "Loading jobs…")));
    sec.append(topRow, list);
    body.appendChild(sec);
    let jobs = [];
    try {
      const d = await callJson(ctx, "train_start", { action: "status" }, { timeout: 30000 });
      jobs = d.jobs || [];
    } catch (e) {
      list.textContent = "";
      list.append(el("p", "cmcp-tr-hint", tr("training_ui.could_not_load_jobs", "Could not load jobs: {error}", { error: e.message || e })));
      return;
    }
    list.textContent = "";
    if (!jobs.length) {
      list.append(el("p", "cmcp-tr-hint", tr("training_ui.no_training_runs_yet", "No training runs yet.")));
      return;
    }
    for (const job of jobs) {
      const row = el("div", "cmcp-tr-jobrow");
      const name = el("span", "name", job.name);
      const meta = el("span", "meta",
        `${job.model}${job.progress?.totalSteps ? ` · ${job.progress.step ?? 0}/${job.progress.totalSteps}` : ""} · ${fmtAgo(job.createdAt)}`);
      row.append(name, meta, jobStatusBadge(job));
      row.onclick = () => { wiz.jobId = job.id; wiz.job = job; show("wizard-4"); };
      list.appendChild(row);
    }
  }

  // ── agent-driven handle (parity with the CivitAI modal) ────────────────────
  // Drives the existing wizard state; every method returns a small plain object
  // or throws. set_field is an explicit per-field ALLOWLIST — never an arbitrary
  // wiz[name]= assignment (audit item 6/11). No dynamic exec (YARA safe).
  const _STEP_VIEW = { 1: "wizard-1", 2: "wizard-2", 3: "wizard-3", 4: "wizard-4" };
  function _assertOpen() { if (closed) throw new Error("training wizard not open"); }
  function _stepNum() {
    const m = /^wizard-(\d)$/.exec(currentView);
    return m ? Number(m[1]) : null;
  }
  /** Readiness signals — the SINGLE source both getState() reports and
   *  gotoStep() enforces (so the agent's view of "can I advance?" matches what
   *  the wizard actually gates on, mirroring the gather Next button). */
  function _readiness() {
    return {
      backendCapable, backendChecked,
      nameOk: !!sanitizeNameClient(wiz.datasetName),
      uploadsSettled: wiz.uploadsPending === 0,
      // A staged set being reused IS dataset readiness (codex finding: the
      // reuse flow jumps straight to Launch with wiz.images empty — requiring
      // gathered images here dead-ended it).
      hasImages: wiz.images.length >= 1 || !!wiz.reuseDataset,
      hasJob: !!wiz.jobId,
    };
  }
  function driveGetState() {
    return {
      isOpen: !closed, view: currentView, step: _stepNum(), target: wiz.target,
      datasetName: wiz.datasetName, trigger: wiz.trigger,
      preset: wiz.preset, images: wiz.images.length,
      launching: !!wiz.launching, jobId: wiz.jobId || null,
      podAvailable: !!(wiz.podInfo && wiz.podInfo.ssh),
      docked: shell.isDocked(),
      highlighted: wiz.highlightRefs.slice(),
      readiness: _readiness(),
    };
  }
  function driveSetField(name, value) {
    _assertOpen();
    switch (name) {
      case "datasetName": wiz.datasetName = String(value ?? ""); break;
      case "trigger": wiz.trigger = String(value ?? "").trim(); break;
      case "preset":
        if (!PRESETS[value]) throw new Error(`unknown preset "${value}"`);
        wiz.preset = value;
        if (PRESETS[value].params) wiz.params = { ...PRESETS[value].params };
        break;
      case "target": return driveSetTarget(value);
      default: throw new Error(`unknown field "${name}" (allowed: datasetName, trigger, preset, target)`);
    }
    // Reflect the change in the live inputs by re-rendering the current step.
    if (currentView) show(currentView);
    return { ok: true, name, value: wiz[name] };
  }
  async function driveGotoStep(step) {
    _assertOpen();
    const view = _STEP_VIEW[Number(step)] || (step === "flows" || step === "jobs" ? step : null);
    if (!view) throw new Error(`invalid step "${step}" (expected 1-4, "flows", or "jobs")`);
    const n = Number(step);
    // Entering a wizard step ENFORCES the same prerequisites as the Next button
    // (codex finding: gotoStep previously bypassed them). Label/Launch/Monitor
    // all require the dataset to be ready; Monitor also needs a live job.
    if (n >= 2 && n <= 4) {
      const capable = await checkBackendCapable();
      _assertOpen();
      if (!capable) throw new Error("trainer backend unavailable — the orchestrator doesn't expose the train_* tools");
      const r = _readiness();
      if (!r.nameOk) throw new Error("set a valid dataset name before advancing");
      if (!r.hasImages) throw new Error("add at least one image before advancing");
      if (!r.uploadsSettled) throw new Error(`wait for ${wiz.uploadsPending} upload(s) to settle before advancing`);
    }
    if (n === 4 && !wiz.jobId) throw new Error("no training job to monitor — launch one first");
    show(view);
    return { view: currentView, step: _stepNum() };
  }
  async function driveSetTarget(target) {
    _assertOpen();
    if (target !== "local" && target !== "pod") throw new Error(`invalid target "${target}" (expected "local" or "pod")`);
    if (target === "pod") {
      // Await a CURRENT preflight — never trust a possibly-stale wiz.podInfo. A
      // versioned doctor means only the newest completion may decide (codex).
      const myDoctorGen = ++doctorGen;
      let dd;
      try { dd = (await callJson(ctx, "train_doctor", { action: "doctor" }, { timeout: 180000 })).data || {}; }
      catch (e) { throw new Error("pod preflight failed: " + (e.message || e)); }
      _assertOpen();
      // If a NEWER doctor superseded ours mid-flight, our result is stale and
      // must NOT accept — reading the shared wiz.podInfo here could let an older
      // SSH-ready value pass a preflight whose own (no-pod) result should fail.
      // Reject and let the agent retry against the current check (codex finding).
      if (myDoctorGen !== doctorGen) throw new Error("pod preflight was superseded — retry");
      wiz.podInfo = dd.pod && dd.pod.status === "RUNNING" ? dd.pod : null;
      if (!(wiz.podInfo && wiz.podInfo.ssh)) throw new Error("no connected pod with a working SSH endpoint");
    }
    wiz.target = target;
    if (currentView === "wizard-3") show("wizard-3"); // re-derive Launch enablement
    return { target: wiz.target };
  }
  /** Highlight data-ref nodes (REPLACEMENT semantics). Persists the ordered set
   *  in wiz so it re-applies after each render (the body rebuilds per view). */
  function driveHighlight(refs) {
    _assertOpen();
    wiz.highlightRefs = (Array.isArray(refs) ? refs : (refs != null ? [refs] : [])).map((x) => String(x));
    reapplyHighlight();
    let first = null, hit = 0;
    const missing = [];
    for (const ref of wiz.highlightRefs) {
      const node = modal.querySelector(`[data-ref="${CSS.escape(ref)}"]`);
      if (node) { if (!first) first = node; hit++; }
      else missing.push(ref);
    }
    if (first) first.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return { highlighted: hit, missing };
  }
  function driveClearHighlight() {
    _assertOpen();
    wiz.highlightRefs = [];
    for (const c of modal.querySelectorAll(".cmcp-agent-glow")) c.classList.remove("cmcp-agent-glow");
    return { ok: true };
  }

  // ── content provider (the shell owns the chrome; this owns the body) ──────
  return {
    key: "training",
    // Getters, matching TABS in cmcp-sidepanel-ui.js. This object outlives a single render
    // (the shell holds it and re-reads searchPlaceholder on every syncSearch), so a plain
    // value would freeze whatever the catalog said when the tab was first opened.
    get label() { return tr("training_ui.training", "Training"); },
    icon: "pi-bolt", driveKind: "training",
    // Search filters the outputs grid on the Dataset step only (decision B).
    hasSearch: () => currentView === "wizard-1" && outputsTabActive,
    get searchPlaceholder() { return tr("training_ui.filter_outputs_by_filename", "Filter outputs by filename…"); },
    subnavExtras: () => [jobsBtn, datasetsBtn],
    mount(bodyEl) { bodyEl.append(stepsBar, body); },
    onActivate() {
      // First activation lands on Flows; every re-activation RE-ENTERS the
      // current view so its renderer rebinds to the freshly re-mounted DOM — and
      // in particular the Monitor poll re-arms (renderMonitor bumps pollGen +
      // poll()) after having been stopped on deactivate. All field state lives in
      // `wiz`, so a re-render is lossless (inputs re-seed from wiz).
      if (!_started) { _started = true; show("flows"); }
      else show(currentView);
    },
    // Halt the monitor poll while the tab is hidden — otherwise it keeps writing
    // to the DOM the shell detached on switch (frozen monitor after a round-trip).
    onDeactivate() { stopPolling(); },
    onSearch(value) {
      outputsFilter = value;
      if (repaintOutputs) repaintOutputs();
    },
    update: () => {},
    teardown,
    drive: {
      getState: driveGetState, setField: driveSetField, gotoStep: driveGotoStep,
      setTarget: driveSetTarget, highlight: driveHighlight, clearHighlight: driveClearHighlight,
    },
  };
}

/** Thin back-compat wrapper: opens the unified side panel on the Training tab. */
export function openTrainingModal(ctx = {}, opts = {}) {
  return openSidePanel(ctx, { tab: "training", dock: opts.dock, onClose: opts.onClose });
}
