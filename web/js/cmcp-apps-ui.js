// Micro-Apps modal — "My Apps" grid, convert/register flows, app detail with
// one-click runs. Follows the cmcp-civitai-ui.js conventions: overlay mounts
// on document.body, CSS injected into document.head, all user text via
// textContent (no HTML injection surface), explicit close() handle.
//
// ctx (from the panel monolith):
//   getApp()           — the live ComfyUI app object (graph, graphToPrompt)
//   uploadBlobToInput  — (blob, name) => Promise<{filename, subfolder, type}|null>
//                        (LOCAL ComfyUI /upload/image — the local run path)
//   uploadMedia        — (blob, name) => Promise<media_uploaded frame> over the
//                        bridge; writes to the CONNECTED ComfyUI (pod) input/
//   callTool           — (tool, args, opts) => Promise<tool_result> (P2: RunPod)
//   getRunpodTarget    — () => last comfyui_target frame (P2: honest host)
//
// hideWorkflow is BEST-EFFORT obfuscation, and the UI says so wherever it is
// offered — see the hide toggle copy. True protection = hosted runs (P5).

import { AppBuilder, AppsClient, RegistryClient } from "./cmcp-apps.js";
import { confirmModal, promptModal, formModal, toast, openSubModal as openSubModalBase } from "./cmcp-modal.js";
import { chipRow, makeFilterButton, openFilterPanel } from "./cmcp-filter.js";
import { tr } from "./lib/i18n.js";

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
/* The unified side-panel shell (cmcp-sidepanel-ui.js) owns the overlay + card
   sizing; .cmcp-apps-modal is only the active-tab alias now — no sizing here, or
   its !important max-width would leak onto the shared shell (shrinking the card
   on the Apps tab + breaking docked-fill). Keep only the flex-column layout. */
.cmcp-apps-modal{display:flex;flex-direction:column;}
.cmcp-apps-body{display:flex;flex-direction:column;gap:0.7rem;min-height:0;flex:1;}
.cmcp-apps-toolbar{display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;}
.cmcp-apps-toolbar .spacer{flex:1;}
/* Buttons: primary pops, everything else reads as a quiet secondary so the
   hierarchy is legible (matches the CivitAI tab's chip/button vocabulary). */
.cmcp-apps-body .cmcp-btn{align-self:auto;padding:0.4rem 0.75rem;border-radius:8px;font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9846);}
.cmcp-apps-body .cmcp-btn:not(.primary):not(.danger){background:var(--p-surface-800,#27272a);
  color:var(--p-text-color,#fafafa);border:1px solid var(--p-content-border-color,#3f3f46);font-weight:500;}
.cmcp-apps-body .cmcp-btn:not(.primary):not(.danger):hover{border-color:var(--p-primary-color,#60a5fa);opacity:1;}
.cmcp-apps-body .cmcp-btn.primary{background:var(--p-button-primary-background,var(--p-primary-color,#3a7bd5));
  color:var(--p-primary-contrast-color,#fff);border:1px solid transparent;}
.cmcp-apps-body .cmcp-btn.danger{background:transparent;border:1px solid rgba(248,113,113,0.5);color:#f87171;font-weight:500;}
.cmcp-apps-body .cmcp-btn.danger:hover{background:rgba(248,113,113,0.12);border-color:#f87171;opacity:1;}
.cmcp-apps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:0.7rem;
  overflow-y:auto;min-height:120px;padding:0.1rem 0.1rem 0.6rem;align-content:start;}
.cmcp-app-card{border:1px solid var(--p-content-border-color,#3f3f46);border-radius:12px;overflow:hidden;cursor:pointer;
  background:var(--p-surface-900,#18181b);display:flex;flex-direction:column;
  transition:border-color .15s,transform .15s,box-shadow .15s;}
.cmcp-app-card:hover{border-color:var(--p-primary-color,#60a5fa);transform:translateY(-2px);
  box-shadow:0 6px 18px rgba(0,0,0,0.35);}
.cmcp-app-card .thumb{aspect-ratio:16/9;background:linear-gradient(135deg,#1b1b20,#0c0c0e) center/cover no-repeat;
  display:flex;align-items:center;justify-content:center;font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.9692);opacity:0.9;color:var(--p-text-muted-color,#a1a1aa);}
.cmcp-app-card .meta{padding:0.5rem 0.6rem 0.55rem;display:flex;flex-direction:column;gap:0.2rem;}
.cmcp-app-card .name{font-weight:600;font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0215);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cmcp-app-card .desc{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8738);line-height:1.35;opacity:0.62;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.cmcp-app-badges{display:flex;gap:0.3rem;margin-top:0.25rem;flex-wrap:wrap;}
.cmcp-app-badge{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.7631);padding:0.1rem 0.4rem;border-radius:99px;border:1px solid var(--p-content-border-color,#3f3f46);
  color:var(--p-text-muted-color,#a1a1aa);opacity:0.9;white-space:nowrap;}
.cmcp-app-badge.hidden-wf{border-color:rgba(245,158,11,0.5);color:#f59e0b;}
.cmcp-apps-empty{opacity:0.6;font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0462);line-height:1.5;padding:2.5rem 1rem;text-align:center;grid-column:1/-1;}
.cmcp-apps-more{grid-column:1/-1;justify-self:center;margin-top:0.4rem;}
.cmcp-apps-back{align-self:flex-start;}
.cmcp-apps-detail{display:flex;flex-direction:column;gap:0.8rem;overflow-y:auto;min-height:0;padding-bottom:0.4rem;}
.cmcp-apps-detail-head{display:flex;gap:0.8rem;align-items:flex-start;padding-bottom:0.7rem;
  border-bottom:1px solid var(--p-content-border-color,#3f3f46);}
.cmcp-apps-detail-head .thumb{width:104px;height:58px;flex:0 0 auto;border-radius:10px;
  background:linear-gradient(135deg,#1b1b20,#0c0c0e) center/cover no-repeat;
  display:flex;align-items:center;justify-content:center;font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.6);color:var(--p-text-muted-color,#a1a1aa);}
.cmcp-apps-detail-head .titles{flex:1;min-width:0;}
.cmcp-apps-detail-head h3{margin:0;font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.2923);}
.cmcp-apps-detail-head .desc{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96);opacity:0.7;margin-top:0.25rem;line-height:1.45;white-space:pre-wrap;}
.cmcp-apps-form{display:flex;flex-direction:column;gap:0.65rem;}
.cmcp-apps-field{display:flex;flex-direction:column;gap:0.28rem;}
.cmcp-apps-field>label{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8615);font-weight:600;opacity:0.8;text-transform:uppercase;letter-spacing:0.03em;}
.cmcp-apps-field input[type=text],.cmcp-apps-field input[type=number],.cmcp-apps-field textarea,.cmcp-apps-field select{
  padding:0.5rem 0.6rem;border-radius:8px;border:1px solid var(--p-content-border-color,#3f3f46);
  background:var(--p-surface-950,#111113);color:var(--p-text-color,#fafafa);font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0462);font-family:inherit;box-sizing:border-box;width:100%;}
.cmcp-apps-field input:focus,.cmcp-apps-field textarea:focus,.cmcp-apps-field select:focus{outline:none;border-color:var(--p-primary-color,#60a5fa);}
.cmcp-apps-field input[type=file]{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96);}
.cmcp-apps-field textarea{min-height:64px;resize:vertical;}
.cmcp-apps-hint{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8369);opacity:0.6;}
/* number-with-bounds slider + synced readout */
.cmcp-apps-sliderrow{display:flex;gap:0.6rem;align-items:center;}
.cmcp-apps-sliderrow input[type=range]{flex:1;min-width:0;accent-color:var(--p-primary-color,#60a5fa);}
.cmcp-apps-sliderval{flex:0 0 5.5rem;width:5.5rem;}
/* seed number + 🎲 randomize/fix toggle */
.cmcp-apps-seedrow{display:flex;gap:0.5rem;align-items:center;}
.cmcp-apps-seedrow input[type=number]{flex:1;min-width:0;}
.cmcp-apps-seedrow .cmcp-btn{flex:0 0 auto;padding:0.4rem 0.6rem;}
.cmcp-apps-field input[type=color]{width:3rem;height:2rem;padding:0.15rem;border-radius:8px;
  border:1px solid var(--p-content-border-color,#3f3f46);background:var(--p-surface-950,#111113);cursor:pointer;}
.cmcp-apps-runbar{display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;padding-top:0.15rem;}
.cmcp-apps-status{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9846);opacity:0.85;min-height:1.1em;flex:1 1 8rem;}
.cmcp-apps-status.err{color:#f87171;}
.cmcp-apps-outputs{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.5rem;}
.cmcp-apps-outputs:empty{display:none;}
.cmcp-apps-outputs img,.cmcp-apps-outputs video{width:100%;border-radius:10px;display:block;background:#0c0c0e;
  border:1px solid var(--p-content-border-color,#3f3f46);}
.cmcp-apps-outputs .text-out{grid-column:1/-1;font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9846);white-space:pre-wrap;background:rgba(255,255,255,0.04);
  border-radius:8px;padding:0.5rem 0.6rem;}
.cmcp-apps-pick{display:flex;flex-direction:column;gap:0.1rem;max-height:240px;overflow-y:auto;
  border:1px solid var(--p-content-border-color,#3f3f46);border-radius:10px;padding:0.5rem;background:var(--p-surface-950,#111113);}
.cmcp-apps-pick label{display:flex;gap:0.45rem;align-items:center;font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96);padding:0.22rem 0.3rem;
  border-radius:6px;cursor:pointer;transition:background .12s;}
.cmcp-apps-pick label:hover{background:rgba(255,255,255,0.05);}
.cmcp-apps-pick .grp{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8123);font-weight:700;opacity:0.6;margin:0.45rem 0 0.15rem;text-transform:uppercase;letter-spacing:0.05em;}
.cmcp-apps-pick .grp:first-child{margin-top:0.1rem;}
.cmcp-apps-warn{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9231);line-height:1.45;color:#f59e0b;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);
  border-radius:8px;padding:0.55rem 0.65rem;}
/* Fallback for danger buttons rendered outside .cmcp-apps-body (defensive). */
.cmcp-btn.danger{border-color:rgba(248,113,113,0.5);color:#f87171;}
/* ── Dependency side-panel (models + custom-node packs) ──────────────────── */
.cmcp-deps{display:flex;flex-direction:column;gap:0.75rem;border:1px solid var(--p-content-border-color,#3f3f46);
  border-radius:10px;padding:0.6rem 0.7rem;background:var(--p-surface-950,#111113);flex:0 0 260px;}
.cmcp-deps-sec{display:flex;flex-direction:column;}
.cmcp-deps-h{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8615);font-weight:700;opacity:0.8;text-transform:uppercase;letter-spacing:0.04em;
  padding-bottom:0.25rem;}
.cmcp-deps-row{display:flex;align-items:center;gap:0.6rem;padding:0.34rem 0.1rem;
  border-top:1px solid rgba(255,255,255,0.05);}
.cmcp-deps-row:first-of-type{border-top:none;}
.cmcp-deps-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:0.1rem;}
.cmcp-deps-name .n{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9846);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cmcp-deps-name .sub{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8123);opacity:0.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cmcp-deps-status{flex:0 0 auto;font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96);display:flex;align-items:center;gap:0.4rem;max-width:55%;
  justify-content:flex-end;text-align:right;}
.cmcp-deps-ok{color:var(--p-green-400,#4ade80);font-weight:600;white-space:nowrap;}
.cmcp-deps-status .cmcp-btn{padding:0.28rem 0.6rem;font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9108);}
.cmcp-deps-muted{opacity:0.6;font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9108);}
.cmcp-deps-err{color:#f87171;font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8862);}
.cmcp-deps-note{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8369);opacity:0.6;line-height:1.4;}
.cmcp-deps-spin{width:0.85rem;height:0.85rem;flex:0 0 auto;border:2px solid rgba(255,255,255,0.22);
  border-top-color:var(--p-primary-color,#60a5fa);border-radius:50%;display:inline-block;
  animation:cmcp-deps-spin 0.7s linear infinite;}
@keyframes cmcp-deps-spin{to{transform:rotate(360deg);}}
/* Detail layout (form + deps side-panel) + the title star icon. */
.cmcp-apps-main{display:flex;gap:1rem;align-items:flex-start;min-height:0;}
.cmcp-apps-main>.grow{flex:1;min-width:0;display:flex;flex-direction:column;gap:0.75rem;}
@media (max-width:720px){.cmcp-apps-main{flex-direction:column;}.cmcp-deps{flex:1 1 auto;width:100%;}}
.cmcp-apps-title-row{display:flex;align-items:center;gap:0.45rem;}
.cmcp-apps-starbtn{border:none;background:none;color:inherit;font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.2923);cursor:pointer;padding:0 0.1rem;line-height:1;}
.cmcp-apps-starbtn:hover{color:#facc15;}
.cmcp-apps-starbtn.starred{color:#facc15;}
.cmcp-apps-starbtn:disabled{opacity:0.4;cursor:default;}
.cmcp-apps-starcount{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96);opacity:0.7;}
`;
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeBtn(label, { primary = false, danger = false, title = "" } = {}) {
  const b = el("button", "cmcp-btn", label);
  b.type = "button";
  if (primary) b.classList.add("primary");
  if (danger) b.classList.add("danger");
  if (title) b.title = title;
  return b;
}

/** /view URL for a ComfyUI file reference. */
function viewUrl(ref) {
  const p = new URLSearchParams({
    filename: ref.filename || "",
    subfolder: ref.subfolder || "",
    type: ref.type || "output",
  });
  return `/view?${p.toString()}`;
}

/** Pull human text out of a bridge tool_result frame (result = MCP content array). */
function toolText(res) {
  if (!res) return "";
  if (res.error) return String(res.error);
  const r = res.result;
  if (Array.isArray(r)) return r.map((c) => (c && c.text) || "").join("");
  if (r && Array.isArray(r.content)) return r.content.map((c) => (c && c.text) || "").join("");
  if (typeof r === "string") return r;
  // These two land in a status line / an Error message the user reads, so they are
  // translated. Nothing PARSES them — every caller that parses (parseRequiredPacks,
  // parseModelList, resolveModelCandidate) works on the tool's own text, which only
  // exists when `r` is present and we returned above.
  return res.ok === false ? tr("apps_ui.the_action_failed", "The action failed.") : tr("apps_ui.done", "Done.");
}

// ── run-form model picker helpers ──────────────────────────────────────────

/** Map a model-loader widget name to a ComfyUI models subfolder (the
 *  list_local_models `model_type` enum) so the picker can scope its server
 *  query. Best effort — null means "list everything". */
const MODEL_DIR_BY_WIDGET = [
  [/ckpt|checkpoint/i, "checkpoints"],
  [/lora/i, "loras"],
  [/vae/i, "vae"],
  [/control_?net/i, "controlnet"],
  [/upscale/i, "upscale_models"],
  [/unet|diffusion/i, "diffusion_models"],
  [/clip|text_encoder/i, "text_encoders"],
  [/style/i, "style_models"],
  [/gligen/i, "gligen"],
  [/hypernet/i, "hypernetworks"],
  [/embed/i, "embeddings"],
];
function modelDirForWidget(widget) {
  for (const [re, dir] of MODEL_DIR_BY_WIDGET) if (re.test(String(widget || ""))) return dir;
  return null;
}

/** The connected server's current valid values for a widget, read from the
 *  ComfyUI frontend's object_info (defs are keyed by class_type, so they cover
 *  node types not currently on the canvas too). Null when unavailable. */
function liveWidgetChoices(getApp, nodeType, widget) {
  try {
    if (!nodeType) return null;
    const app = typeof getApp === "function" ? getApp() : null;
    const defs = app?.nodeManager?.defs || app?.extensions?.nodeDefs || app?.nodeDefs;
    const def = defs && defs[nodeType];
    const spec = def?.input?.required?.[widget] || def?.input?.optional?.[widget];
    const values = Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : null;
    return values ? values.map(String) : null;
  } catch {
    return null;
  }
}

/** Best-effort extraction of model filenames from a list_local_models
 *  tool_result (the bridge returns grouped JSON or prose). Filtered to real
 *  model-file extensions so a stray label can't pollute the picker. */
const _MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx|vae|pkl)$/i;
function parseModelList(res, dir) {
  const text = toolText(res);
  if (!text) return [];
  const cand = new Set();
  try {
    const j = JSON.parse(text);
    const src = dir && j && typeof j === "object" && !Array.isArray(j) && Array.isArray(j[dir]) ? j[dir] : j;
    // Collect every string anywhere in the structure, then extension-filter.
    JSON.stringify(src, (_k, v) => { if (typeof v === "string") cand.add(v); return v; });
  } catch {
    for (const line of text.split(/\r?\n/)) cand.add(line.trim());
  }
  return [...cand].filter((s) => _MODEL_EXT.test(s));
}

// ── dependency side-panel parsing helpers (pure) ────────────────────────────

/** Basename of a model path, lower-cased, for case-insensitive presence match. */
function depBasename(s) {
  return String(s || "").split(/[\\/]/).pop().trim().toLowerCase();
}

/** Set of present model basenames (lower-cased) from a list_local_models
 *  tool_result. Reuses parseModelList (grouped-JSON / prose tolerant). */
function presentModelBasenames(res) {
  const set = new Set();
  for (const p of parseModelList(res)) set.add(depBasename(p));
  return set;
}

/** Parse install_custom_node (action:"list") TEXT (formatInstalledNodes shape:
 *    "1. <module> [cnr:<id>, git:<aux>]\n   version: … | enabled")
 *  into a lower-cased Set of every identifier we can match a declared pack
 *  against — the module name plus any cnr / git ids. */
function parseInstalledNodeSet(text) {
  const set = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*\d+\.\s+(.+?)\s*(?:\[(.+)\])?\s*$/);
    if (!m) continue;
    const module = (m[1] || "").trim();
    if (module) set.add(module.toLowerCase());
    if (m[2]) {
      for (const part of m[2].split(",")) {
        const id = part.replace(/^\s*(?:cnr|git):/i, "").trim();
        if (id) {
          set.add(id.toLowerCase());
          // git ids arrive as "owner/Repo" — also index the repo tail.
          const tail = id.split("/").pop();
          if (tail) set.add(tail.toLowerCase());
        }
      }
    }
  }
  return set;
}

/** Parse list_packs (action:"extract_deps") TEXT — the "Required custom node packs"
 *  section only — into [{ pack, installed }]. Each line there is
 *  "- <pack>  — installed" or "- <pack>  — **NOT INSTALLED**" (em-dash U+2014).
 *  Returns { corePacksOnly: true } style via an empty array + a flag when the
 *  workflow needs no packs. */
function parseRequiredPacks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const packs = [];
  let inSection = false;
  let coreOnly = false;
  for (const line of lines) {
    if (/^###\s+Required custom node packs/i.test(line)) { inSection = true; continue; }
    if (inSection && /^#{2,3}\s+/.test(line)) break; // next heading ends the section
    if (/core\/built-in ComfyUI nodes\. No custom node packs required/i.test(line)) coreOnly = true;
    if (!inSection) continue;
    // Split on the em-dash separator; left side holds the pack name.
    const idx = line.indexOf("—");
    if (idx === -1) continue;
    const name = line.slice(0, idx).replace(/^\s*[-*]\s*/, "").trim();
    if (!name) continue;
    packs.push({ pack: name, installed: !/NOT\s+INSTALLED/i.test(line) });
  }
  return { packs, coreOnly };
}

/** Normalize an identifier for fuzzy pack matching (drop case + punctuation). */
function normId(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Is a declared pack/class_type present in a parseInstalledNodeSet() set?
 *  Exact lower-case first, then a punctuation-insensitive compare (best effort —
 *  the manifest may carry class_types, which don't 1:1 match pack module ids). */
function nodeInstalled(set, name) {
  const lc = String(name || "").toLowerCase();
  if (set.has(lc)) return true;
  const nn = normId(name);
  if (!nn) return false;
  for (const id of set) if (normId(id) === nn) return true;
  return false;
}

/** Does a node def's python_module identify a core/built-in ComfyUI node?
 *  Core defs load from "nodes" or "comfy_extras.*"; custom packs load from
 *  "custom_nodes.*". Unknown/missing modules are NOT treated as core. */
export function isCoreNodeModule(pythonModule) {
  const m = String(pythonModule || "");
  return m === "nodes" || m === "comfy_extras" || m.startsWith("comfy_extras.");
}

/** The connected frontend's live def for a class_type (same def sources as
 *  liveWidgetChoices). Null when the frontend doesn't expose defs or the
 *  class_type isn't registered on this server. */
function liveNodeDef(getApp, classType) {
  try {
    if (!classType) return null;
    const app = typeof getApp === "function" ? getApp() : null;
    const defs = app?.nodeManager?.defs || app?.extensions?.nodeDefs || app?.nodeDefs;
    return (defs && defs[classType]) || null;
  } catch { return null; }
}

/** Authoritative fallback for liveNodeDef: the connected server's per-class
 *  object_info route ({ "<class>": { …, python_module } }). Null on any miss
 *  (unregistered class_type, offline, non-JSON) — never throws. */
async function fetchNodeDef(classType) {
  try {
    if (!classType) return null;
    const res = await fetch(`/object_info/${encodeURIComponent(classType)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data[classType]) || null;
  } catch { return null; }
}

/** De-dupe [{pack,installed}] by pack name (case-insensitive); installed wins. */
function dedupePacks(packs) {
  const map = new Map();
  for (const p of packs) {
    if (!p || !p.pack) continue;
    const k = p.pack.toLowerCase();
    const prev = map.get(k);
    if (!prev) map.set(k, { pack: p.pack, installed: !!p.installed });
    else if (p.installed) prev.installed = true;
  }
  return [...map.values()];
}

/** Convert the LIVE canvas into an app bundle draft: prompt snapshot + UI
 *  workflow + candidate inputs/outputs (pre-selected from the frontend's
 *  APP-mode config when present, else the hint-type heuristic). Throws a
 *  readable error when the frontend can't serialize. */
async function draftFromCanvas(getApp) {
  const app = getApp();
  if (!app || typeof app.graphToPrompt !== "function") {
    throw new Error(tr("apps_ui.this_frontend_can_t_serialize_the_graph", "this frontend can't serialize the graph (graphToPrompt missing)"));
  }
  const gp = await app.graphToPrompt(); // { output, workflow }
  const workflow = gp.workflow || app.graph?.serialize?.();
  if (!workflow || !Array.isArray(workflow.nodes)) {
    throw new Error(tr("apps_ui.couldn_t_serialize_the_canvas_workflow", "couldn't serialize the canvas workflow"));
  }

  const imported = AppBuilder.findAppModeConfig(workflow);
  // Candidates come from the LIVE graph: serialized widgets_values are
  // positional and nameless; live nodes carry widget names/choices.
  const liveNodes = app.graph?._nodes || app.graph?.nodes || [];
  const inputs = [];
  const outputs = [];
  const seen = new Set();
  // Imported APP-mode selections are honored on ANY node type — the hint-type
  // filter only applies to the heuristic fallback. (codex finding: an app-mode
  // input on a custom node outside the hint set used to vanish silently.)
  const importedKeys = new Set((imported?.inputs || []).map((i) => `${i.nodeId}.${i.widget}`));
  for (const node of liveNodes) {
    const id = Number(node.id);
    if (!Number.isFinite(id)) continue;
    const nodeType = String(node.type || "");
    const outputKind = AppBuilder.outputKind(nodeType, node.constructor?.nodeData?.output_node === true);
    if (outputKind) {
      outputs.push({
        nodeId: id,
        kind: outputKind,
        label: `${node.title || node.type} #${id}`,
        checked: true,
      });
      continue;
    }
    const nodeHasImported = [...importedKeys].some((k) => Number(k.split(".")[0]) === id);
    if (!AppBuilder.isInputHint(nodeType) && !nodeHasImported) continue;
    // Only a CONNECTED widget-input makes a widget link-driven. Modern
    // frontends materialize an input socket (link: null) for EVERY widget —
    // treating mere presence as link-driven excluded every candidate on
    // current ComfyUI (found dogfooding: an EmptyImage offered zero inputs).
    const linkDriven = new Set(
      (Array.isArray(node.inputs) ? node.inputs : [])
        .filter((inp) => inp && inp.link != null && inp.widget && inp.widget.name)
        .map((inp) => inp.widget.name),
    );
    for (const w of Array.isArray(node.widgets) ? node.widgets : []) {
      if (!w || !w.name || linkDriven.has(w.name)) continue;
      if (w.type === "button" || w.type === "converted-widget") continue;
      const key = `${id}.${w.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = AppBuilder.classifyWidget(nodeType, w.name, w.value, w.type);
      const opts = w.options || {};
      const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
      // control_after_generate lives on a sibling combo widget for seed nodes;
      // its value ("randomize"/"fixed"/"increment"/…) seeds the 🎲 default.
      let seedBehavior;
      if (kind === "seed") {
        const ctrl = (Array.isArray(node.widgets) ? node.widgets : []).find(
          (x) => x && /control_after_generate/i.test(String(x.name || "")),
        );
        seedBehavior = typeof ctrl?.value === "string" ? ctrl.value : "randomize";
      }
      inputs.push({
        nodeId: id,
        widget: w.name,
        // nodeType lets the run-form model picker read the live /object_info
        // (defs[nodeType]) for the connected server's current choices.
        nodeType,
        label: `${node.title || node.type} #${id} · ${w.label || w.name}`,
        kind,
        choices: Array.isArray(opts.values) ? opts.values.map(String) : undefined,
        default: typeof w.value === "string" || typeof w.value === "number" || typeof w.value === "boolean" ? w.value : undefined,
        min: num(opts.min),
        max: num(opts.max),
        step: num(opts.step),
        ...(seedBehavior ? { seedBehavior } : {}),
        checked: true,
      });
    }
  }
  // The frontend's own APP-mode selection overrides the heuristic's checks
  // (its entries address widgets by real name).
  if (imported) {
    const wanted = new Set(imported.inputs.map((i) => `${i.nodeId}.${i.widget}`));
    for (const cand of inputs) cand.checked = wanted.has(`${cand.nodeId}.${cand.widget}`);
    if (imported.inputs.length) {
      const wantedOut = new Set(imported.outputs.map((o) => o.nodeId));
      for (const cand of outputs) cand.checked = wantedOut.size ? wantedOut.has(cand.nodeId) : cand.checked;
    }
  }
  return { prompt: gp.output, workflow, imported, inputs, outputs };
}

/** Content-provider factory for the Apps tab of the unified side panel. The
 *  shell owns the overlay/header/✕/dock/Escape; this builds the grid/convert/
 *  detail body. The My/Explore toggle is chips in the shared subnav (decision D);
 *  the shared search shows only on Explore. */
export function createAppsContent(ctx, shell, opts = {}) {
  const { getApp, uploadBlobToInput, callTool, getRunpodTarget } = ctx;
  const client = new AppsClient();
  const registry = new RegistryClient();
  injectStyle();

  const body = el("div", "cmcp-apps-body"); // content root (mounted in shell body)

  let closed = false;
  let pollTimer = null; // setTimeout id for the in-flight run poll
  // Run-poll pause/resume across tab switches: _hidden gates rescheduling,
  // _lastTick is the resume anchor, _polling guards against double-arming while a
  // tick is mid-flight.
  let _hidden = false;
  let _lastTick = null;
  let _polling = false;
  let _tab = "mine"; // "mine" | "explore"
  let _started = false;
  let exploreQuery = "";
  let exploreSort = "trending"; // Explore sort — the shared filter panel's Sort row
  let _exploreReload = null; // showExplore's load(), so onSearch can re-run it
  let _exploreTimer = null;
  // Stacked-sheet tracker (mirrors CivitAI's) so the filter panel joins the
  // Escape-gated close set — see escapeBlocked() below.
  const _subModals = new Set();

  // ── My / Explore toggle → chips in the shared subnav (decision D) ──────────
  const mineChip = el("button", "cmcp-cv-chip", tr("apps_ui.my_apps", "My Apps"));
  const exploreChip = el("button", "cmcp-cv-chip", tr("apps_ui.explore", "Explore"));

  // ── Shared filter affordance (P1c) — the SAME header filter button + chip
  // panel CivitAI uses (cmcp-filter.js). Sort-only for now; structured so
  // tag/category rows drop straight in as the catalogue grows. Shown on Explore
  // (My Apps has nothing to sort). Sort keys match RegistryClient.list.
  const APPS_SORTS = [
    { value: "trending", label: tr("apps_ui.trending", "Trending") },
    { value: "new", label: tr("apps_ui.newest", "Newest") },
    { value: "stars", label: tr("apps_ui.most_stars", "Most Stars") },
  ];
  const { btn: filterBtn, setActive: setFilterActive } =
    makeFilterButton({ onOpen: () => openAppsFilters(), title: tr("apps_ui.filter_apps", "Filter apps") });
  function syncFilterBtn() {
    filterBtn.style.display = _tab === "explore" ? "" : "none";
    setFilterActive(exploreSort !== "trending"); // "dirty" dot once sort != default
  }
  function openAppsFilters() {
    openFilterPanel({
      // Thread the tracker so Escape peels the sheet before it can close the panel.
      openModal: (title, onClose) => openSubModalBase(title, onClose, _subModals),
      title: tr("apps_ui.filter_apps", "Filter apps"),
      render: (wrap, rerender) => {
        chipRow(
          wrap, tr("apps_ui.sort", "Sort"), APPS_SORTS,
          (v) => exploreSort === v,
          (v) => {
            if (exploreSort === v) return;
            exploreSort = v;
            syncFilterBtn();
            rerender();                       // flip the pressed chip in the open sheet
            if (_exploreReload) _exploreReload(); // reload the feed behind it
          },
        );
        // Future rows (tags / categories) append here — same chipRow calls.
      },
    });
  }

  function syncChips() {
    mineChip.classList.toggle("on", _tab === "mine");
    exploreChip.classList.toggle("on", _tab === "explore");
    syncFilterBtn();
  }
  mineChip.addEventListener("click", () => {
    if (_tab === "mine") return;
    _tab = "mine"; syncChips(); shell.syncSearch(); showGrid().catch(showError);
  });
  exploreChip.addEventListener("click", () => {
    if (_tab === "explore") return;
    _tab = "explore"; syncChips(); shell.syncSearch(); showGrid().catch(showError);
  });

  // ── Grid view ────────────────────────────────────────────────────────────
  async function showGrid() {
    if (closed) return;
    syncChips();
    body.textContent = "";
    if (_tab === "mine") {
      const bar = el("div", "cmcp-apps-toolbar");
      const convertBtn = makeBtn(tr("apps_ui.convert_current_workflow", "＋ Convert current workflow"), {
        primary: true,
        title: tr("apps_ui.package_the_workflow_on_the_canvas_as", "Package the workflow on the canvas as a one-click app."),
      });
      convertBtn.addEventListener("click", () => showConvert().catch(showError));
      bar.append(convertBtn);
      body.append(bar);
    }
    if (_tab === "explore") return showExplore();
    return showMine();
  }

  async function showMine() {
    const grid = el("div", "cmcp-apps-grid");
    grid.append(el("div", "cmcp-apps-empty", tr("apps_ui.loading", "Loading…")));
    body.append(grid);

    let apps = [];
    try {
      apps = await client.list();
    } catch (e) {
      grid.textContent = "";
      grid.append(el("div", "cmcp-apps-empty", tr("apps_ui.couldn_t_load_apps", "Couldn't load apps: {error}", { error: e.message })));
      return;
    }
    if (closed) return;
    grid.textContent = "";
    if (!apps.length) {
      grid.append(
        el(
          "div",
          "cmcp-apps-empty",
          tr(
            "apps_ui.no_apps_yet_open_a_workflow_on",
            "No apps yet. Open a workflow on the canvas, then “Convert current workflow” to make your first one.",
          ),
        ),
      );
      return;
    }
    for (const app of apps) {
      const card = el("div", "cmcp-app-card");
      const thumb = el("div", "thumb", "▶");
      if (app.has_thumbnail) {
        thumb.style.backgroundImage = `url("${client.thumbnailUrl(app.id)}")`;
        thumb.textContent = "";
      }
      const meta = el("div", "meta");
      meta.append(el("div", "name", app.name || tr("apps_ui.untitled_app", "Untitled app")));
      if (app.description) meta.append(el("div", "desc", app.description));
      const badges = el("div", "cmcp-app-badges");
      if (app.hideWorkflow) badges.append(el("span", "cmcp-app-badge hidden-wf", tr("apps_ui.hidden_workflow", "hidden workflow")));
      // The slug itself is a registry identifier and stays verbatim; only the
      // "not published under a slug yet" placeholder is prose.
      if (app.published) badges.append(el("span", "cmcp-app-badge", `★ ${app.published.slug || tr("apps_ui.published", "published")}`));
      if (badges.childNodes.length) meta.append(badges);
      card.append(thumb, meta);
      card.addEventListener("click", () => showDetail(app.id).catch(showError));
      grid.append(card);
    }
  }

  // ── Explore view (the published registry) ────────────────────────────────

  async function showExplore() {
    if (!registry.configured) {
      body.append(
        el(
          "div",
          "cmcp-apps-empty",
          // The localStorage key is an identifier, so it is interpolated rather than
          // written into the translatable text — a translated key would silently
          // point the user at a setting that does not exist.
          tr(
            "apps_ui.no_registry_configured_set_localstorage_key_to",
            "No registry configured. Set localStorage key “{key}” to a deployed registry worker to explore published apps.",
            { key: "comfyui-mcp.panel.registryUrl" },
          ),
        ),
      );
      return;
    }
    const grid = el("div", "cmcp-apps-grid");
    // Sort lives in the shared header filter panel (openAppsFilters), not inline
    // chips — Explore reads the module-scoped exploreSort. Search is the shell's
    // shared box (shown only on Explore); its value is mirrored into exploreQuery
    // and re-runs load() via onSearch.
    async function load(append = false, cursor = "") {
      if (!append) {
        grid.textContent = "";
        grid.append(el("div", "cmcp-apps-empty", tr("apps_ui.loading", "Loading…")));
      }
      try {
        const res = await registry.list({ sort: exploreSort, q: exploreQuery.trim(), cursor });
        if (closed) return;
        if (!append) grid.textContent = "";
        renderCards(res.apps || [], res.next_cursor);
      } catch (e) {
        if (!append) {
          grid.textContent = "";
          grid.append(el("div", "cmcp-apps-empty", tr("apps_ui.registry_error", "Registry error: {error}", { error: e.message })));
        }
      }
    }
    function renderCards(apps, nextCursor) {
      grid.querySelector(".cmcp-apps-empty")?.remove();
      grid.querySelector(".cmcp-apps-more")?.remove();
      if (!apps.length && !grid.childNodes.length) {
        grid.append(el("div", "cmcp-apps-empty", tr("apps_ui.no_published_apps_match", "No published apps match.")));
        return;
      }
      for (const app of apps) {
        const card = el("div", "cmcp-app-card");
        const thumb = el("div", "thumb", "▶");
        thumb.style.backgroundImage = `url("${registry.thumbnailUrl(app.id)}")`;
        thumb.textContent = "";
        const meta = el("div", "meta");
        meta.append(el("div", "name", app.name || tr("apps_ui.untitled", "Untitled")));
        // "anonymous" is the creator NAME the publish flow stores and uploads, not a
        // label — translating it here would show a different author for the same
        // person depending on the reader's language.
        meta.append(el("div", "desc", tr("apps_ui.by", "by {creator}", { creator: app.creator || "anonymous" })));
        const badges = el("div", "cmcp-app-badges");
        badges.append(el("span", "cmcp-app-badge", `★ ${app.stars || 0}`));
        badges.append(
          el(
            "span",
            "cmcp-app-badge",
            tr("apps_ui.runs", { one: "▶ {count} run", other: "▶ {count} runs" }, { count: Number(app.runs) || 0 }),
          ),
        );
        if (app.hide_workflow) badges.append(el("span", "cmcp-app-badge hidden-wf", tr("apps_ui.hidden", "hidden")));
        meta.append(badges);
        card.append(thumb, meta);
        card.addEventListener("click", () => showRegistryDetail(app).catch(showError));
        grid.append(card);
      }
      if (nextCursor) {
        const more = makeBtn(tr("apps_ui.load_more", "Load more"));
        more.classList.add("cmcp-apps-more");
        more.addEventListener("click", () => load(true, nextCursor));
        grid.append(more);
      }
    }
    _exploreReload = () => load(); // onSearch (shared box) + filter panel re-run this
    body.append(grid);
    load();
  }

  // ── Dependency side-panel (shared by both detail views) ──────────────────

  /** Render the app's required models + custom-node packs, each with a green ✓
   *  (present/installed) or an action button (Download / Install). Downloads and
   *  installs run over the orchestrator bridge (callTool); their byte progress
   *  surfaces in the existing panel download tray (server-side), so we don't
   *  reimplement progress here — we just re-check presence after the call.
   *
   *  opts:
   *    models      — manifest.deps.models[]  (mixed shapes; older apps are sparse:
   *                  { name } only; convert-flow apps carry the full
   *                  { fileName, directory, source, sourceUrl, civitaiVersionId, … })
   *    customNodes — manifest.deps.customNodes[]  (class_type string | { pack })
   *    getWorkflow — () => Promise<apiPrompt|null>; the API-format prompt handed to
   *                  list_packs (action:"extract_deps") / download_model
   *                  (action:"resolve_missing"). Invoked
   *                  lazily, memoised — at most one bundle fetch even if both
   *                  sections need it.
   *
   *  Teardown-safe: alive() gates every post-await DOM write, so a late callTool
   *  never mutates a container the shell already detached / re-rendered. */
  function renderDepsPanel(container, { models = [], customNodes = [], getWorkflow } = {}) {
    const alive = () => !closed && container.isConnected;
    const mods = (Array.isArray(models) ? models : []).filter((m) => m && typeof m === "object");
    const packs = (Array.isArray(customNodes) ? customNodes : [])
      .map((c) => (typeof c === "string" ? c : (c && (c.pack || c.name)) || ""))
      .filter(Boolean);

    if (!mods.length && !packs.length) {
      container.append(
        el("div", "cmcp-deps-note", tr("apps_ui.this_app_declares_no_external_model_or", "This app declares no external model or node dependencies.")),
      );
      return;
    }

    const bridgeReady = typeof callTool === "function";
    const panel = el("div", "cmcp-deps");
    container.append(panel);

    // Lazy, memoised API-format prompt (used by both sections).
    let _wfP = null;
    const workflow = () => {
      if (!_wfP) {
        _wfP = Promise.resolve()
          .then(() => (typeof getWorkflow === "function" ? getWorkflow() : null))
          .catch(() => null);
      }
      return _wfP;
    };

    // spinner + label chip
    const spinning = (label) => {
      const wrap = el("span");
      wrap.append(el("span", "cmcp-deps-spin"), el("span", "cmcp-deps-muted", label));
      return wrap;
    };
    const okChip = (label) => el("span", "cmcp-deps-ok", label);

    // ── Models ──────────────────────────────────────────────────────────────
    if (mods.length) {
      const sec = el("div", "cmcp-deps-sec");
      const h = el("div", "cmcp-deps-h", tr("apps_ui.models", "Models ({total})", { total: mods.length }));
      sec.append(h);
      panel.append(sec);

      const rows = mods.map((m) => {
        const fname = m.fileName || m.name || m.file || "";
        const dir = m.directory || m.targetSubfolder || m.dir || "";
        const row = el("div", "cmcp-deps-row");
        const nameWrap = el("div", "cmcp-deps-name");
        nameWrap.append(el("div", "n", fname || tr("apps_ui.unnamed_model", "(unnamed model)")));
        if (dir) nameWrap.append(el("div", "sub", `models/${dir}/`));
        const status = el("div", "cmcp-deps-status");
        row.append(nameWrap, status);
        sec.append(row);
        return { m, fname, dir, row, status, present: false };
      });

      const syncModelHeader = () => {
        const done = rows.filter((r) => r.present).length;
        h.textContent = tr("apps_ui.models_installed", "Models ({done}/{total} installed)", { done, total: rows.length });
      };

      if (!bridgeReady) {
        for (const r of rows) {
          r.status.textContent = "";
          r.status.append(el("span", "cmcp-deps-muted", tr("apps_ui.connect_orchestrator", "connect orchestrator")));
        }
        sec.append(
          el(
            "div",
            "cmcp-deps-note",
            tr("apps_ui.connect_the_orchestrator_to_check_for_and", "Connect the orchestrator to check for and download models."),
          ),
        );
      } else {
        for (const r of rows) { r.status.append(spinning(tr("apps_ui.checking", "checking…"))); }
        (async () => {
          let present = new Set();
          try { present = presentModelBasenames(await callTool("list_local_models", { action: "list" })); }
          catch { /* offline / older bridge — treat as unknown */ }
          if (!alive()) return;
          for (const r of rows) {
            r.present = r.fname ? present.has(depBasename(r.fname)) : false;
            r.status.textContent = "";
            if (r.present) r.status.append(okChip(tr("apps_ui.installed", "✓ Installed")));
            else wireModelDownload(r);
          }
          syncModelHeader();
        })();
      }

      function wireModelDownload(r) {
        const btn = makeBtn(tr("apps_ui.download", "⬇ Download"), { primary: true });
        r.status.textContent = "";
        r.status.append(btn);
        const target = r.dir || "checkpoints";
        const show = (node) => { r.status.textContent = ""; r.status.append(node); };
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          show(spinning(tr("apps_ui.starting", "starting…")));
          try {
            const issued = await startModelDownload(r.m, r.fname, target);
            if (!alive()) return;
            if (!issued) { show(el("span", "cmcp-deps-muted", tr("apps_ui.no_download_link", "no download link"))); return; }
            // Big files won't have landed by the time the grace-window call
            // resolves — re-check once; if not present yet, point at the tray.
            const nowPresent = await recheckModel(r.fname);
            if (!alive()) return;
            if (nowPresent) { r.present = true; show(okChip(tr("apps_ui.installed", "✓ Installed"))); syncModelHeader(); }
            else show(el("span", "cmcp-deps-muted", tr("apps_ui.downloading_see_tray", "downloading… (see tray)")));
          } catch (e) {
            if (!alive()) return;
            show(el("span", "cmcp-deps-err", e && e.message ? e.message : tr("apps_ui.download_failed", "download failed")));
            btn.disabled = false;
          }
        });
      }
    }

    // ── Custom-node packs ─────────────────────────────────────────────────────
    if (packs.length) {
      const sec = el("div", "cmcp-deps-sec");
      const h = el("div", "cmcp-deps-h", tr("apps_ui.custom_nodes", "Custom nodes ({total})", { total: packs.length }));
      sec.append(h);
      panel.append(sec);

      if (!bridgeReady) {
        for (const c of packs) {
          const row = el("div", "cmcp-deps-row");
          const nameWrap = el("div", "cmcp-deps-name");
          nameWrap.append(el("div", "n", c)); // pack identifier — never translated
          const status = el("div", "cmcp-deps-status");
          status.append(el("span", "cmcp-deps-muted", tr("apps_ui.connect_orchestrator", "connect orchestrator")));
          row.append(nameWrap, status);
          sec.append(row);
        }
        sec.append(
          el(
            "div",
            "cmcp-deps-note",
            tr("apps_ui.connect_the_orchestrator_to_check_for_and_2", "Connect the orchestrator to check for and install custom-node packs."),
          ),
        );
      } else {
        const loading = el("div", "cmcp-deps-row");
        loading.append(spinning(tr("apps_ui.resolving_node_packs", "resolving node packs…")));
        sec.append(loading);
        (async () => {
          const resolved = await resolveNodePacks(packs);
          if (!alive()) return;
          loading.remove();
          if (!resolved.length) {
            h.textContent = tr("apps_ui.custom_nodes_0", "Custom nodes (0)");
            sec.append(el("div", "cmcp-deps-note", tr("apps_ui.no_custom_node_packs_required", "No custom-node packs required.")));
            return;
          }
          const rows = [];
          const syncNodeHeader = () => {
            const done = rows.filter((r) => r.installed).length;
            h.textContent = tr("apps_ui.custom_nodes_installed", "Custom nodes ({done}/{total} installed)", { done, total: rows.length });
          };
          for (const p of resolved) {
            const row = el("div", "cmcp-deps-row");
            const nameWrap = el("div", "cmcp-deps-name");
            nameWrap.append(el("div", "n", p.pack)); // pack identifier — never translated
            const status = el("div", "cmcp-deps-status");
            row.append(nameWrap, status);
            sec.append(row);
            const r = { pack: p.pack, installed: p.installed, row, status };
            rows.push(r);
            if (p.installed) status.append(okChip(tr("apps_ui.installed", "✓ Installed")));
            else wireNodeInstall(r, syncNodeHeader);
          }
          syncNodeHeader();
        })();
      }

      function wireNodeInstall(r, onChanged) {
        const btn = makeBtn(tr("apps_ui.install", "⬇ Install"), { primary: true });
        r.status.textContent = "";
        r.status.append(btn);
        const show = (node) => { r.status.textContent = ""; r.status.append(node); };
        btn.addEventListener("click", async () => {
          // Installing a custom node runs that pack's third-party code — gate it.
          const ok = await confirmModal({
            title: tr("apps_ui.install_custom_node_pack", "Install custom-node pack"),
            // One literal, not a concatenation: the extractor reads back only the first
            // string after the key, so a `"a" + "b"` fallback lands in the catalog
            // truncated — English still renders in full (it uses the fallback) while
            // every translated language silently loses the rest of the sentence.
            message: tr("apps_ui.install_custom_node_pack_this_downloads_and", "Install custom node pack “{pack}”?\n\nThis downloads and runs third-party code. ComfyUI may need to restart to load the new nodes.", { pack: r.pack }),
            confirmLabel: tr("apps_ui.install_2", "Install"),
          });
          if (!ok || !alive()) return;
          btn.disabled = true;
          show(spinning(tr("apps_ui.installing", "installing…")));
          try {
            const res = await callTool("install_custom_node", { action: "install", id: r.pack });
            if (!alive()) return;
            if (res && res.ok === false) throw new Error(toolText(res) || tr("apps_ui.install_failed", "install failed"));
            r.installed = true;
            show(okChip(tr("apps_ui.installed", "✓ Installed")));
            onChanged();
            toast(tr("apps_ui.installed_restart_comfyui_to_load_new_nodes", "Installed — restart ComfyUI to load new nodes."));
          } catch (e) {
            if (!alive()) return;
            show(el("span", "cmcp-deps-err", e && e.message ? e.message : tr("apps_ui.install_failed", "install failed")));
            btn.disabled = false;
          }
        });
      }
    }

    // ── bridge calls (closure over callTool + the memoised workflow thunk) ────

    /** Issue the right download call for a model. Returns true when a download
     *  was kicked off, false when no link could be resolved (disabled state).
     *  Throws on a tool-reported failure. */
    async function startModelDownload(m, fname, target) {
      const vid = m.civitaiVersionId || m.civitai_version_id;
      if (vid) return civitai(Number(vid), target);
      const url = m.sourceUrl || m.source_url || m.url;
      if (url) return direct(url, target, fname);
      // No pinned link on this (sparse/old) entry — ask the orchestrator to
      // resolve a candidate from the live workflow (best effort; markdown parse).
      const wf = await workflow();
      if (wf) {
        const cand = await resolveModelCandidate(wf, fname);
        if (cand && cand.versionId) return civitai(cand.versionId, target);
        if (cand && cand.url) return direct(cand.url, target, fname);
      }
      return false;

      async function civitai(versionId, subfolder) {
        const res = await callTool("download_model", { action: "download_civitai", model_version_id: versionId, target_subfolder: subfolder });
        if (res && res.ok === false) throw new Error(toolText(res) || tr("apps_ui.civitai_download_failed", "CivitAI download failed"));
        return true;
      }
      async function direct(u, subfolder, filename) {
        const res = await callTool("download_model", { action: "download", url: u, target_subfolder: subfolder, ...(filename ? { filename } : {}) });
        if (res && res.ok === false) throw new Error(toolText(res) || tr("apps_ui.download_failed", "download failed"));
        return true;
      }
    }

    /** Re-query list_local_models (action:"list") and report whether `fname` has landed. */
    async function recheckModel(fname) {
      if (!fname) return false;
      try { return presentModelBasenames(await callTool("list_local_models", { action: "list" })).has(depBasename(fname)); }
      catch { return false; }
    }

    /** Best-effort candidate parse from download_model (action:"resolve_missing")
     *  markdown. Finds the `### \`<name>\`` section for this file, then the first
     *  CivitAI version id (→ action:"download_civitai") or an http(s) URL
     *  (→ action:"download"). */
    async function resolveModelCandidate(wf, fname) {
      let text = "";
      try { text = toolText(await callTool("download_model", { action: "resolve_missing", workflow: wf })); }
      catch { return null; }
      if (!text) return null;
      const base = depBasename(fname);
      let inMatch = !base; // no filename → scan the whole doc
      for (const line of text.split(/\r?\n/)) {
        const hdr = line.match(/^###\s+`([^`]+)`/);
        if (hdr) { inMatch = depBasename(hdr[1]) === base; continue; }
        if (!inMatch) continue;
        // Second alternative tracks the tool's OWN prose, which 0.50.0 rewrote
        // from the retired standalone CivitAI-download name to `download_model
        // action:"download_civitai"`. It is a fallback for a line the first
        // pattern misses, so it stays keyed on whatever the tool emits today.
        const ver = line.match(/\(version\s+(\d{2,})\)/i) || line.match(/version\s+(\d{2,})\)?\s*(?:→|->)?\s*download_model\s+action:"download_civitai"/i);
        if (ver) return { versionId: Number(ver[1]) };
        const url = line.match(/https?:\/\/\S+/);
        if (url) return { url: url[0].replace(/[)\].,]+$/, "") };
      }
      return null;
    }

    /** Resolve the declared node deps to [{pack, installed}]. Preferred path:
     *  list_packs (action:"extract_deps") (maps class_type→pack + reports
     *  installed vs missing authoritatively). Fallback when the prompt is
     *  unavailable (e.g. hidden-workflow apps): the connected frontend's live
     *  node defs first — a registered core class_type (EmptyImage,
     *  PreviewImage, …) is not a custom pack at all and a registered custom one
     *  is already installed — then declared class_types vs install_custom_node
     *  (action:"list") (loose — see nodeInstalled) for whatever the live defs
     *  can't answer. */
    async function resolveNodePacks(declared) {
      const wf = await workflow();
      if (wf) {
        try {
          const { packs: parsed, coreOnly } = parseRequiredPacks(toolText(await callTool("list_packs", { action: "extract_deps", workflow: wf })));
          if (parsed.length) return dedupePacks(parsed);
          if (coreOnly) return [];
        } catch { /* fall through to the declared-list heuristic */ }
      }
      const resolved = [];
      const unknown = [];
      for (const c of declared) {
        const def = liveNodeDef(getApp, c) || await fetchNodeDef(c);
        if (!def) { unknown.push(c); continue; }
        if (isCoreNodeModule(def.python_module)) continue; // core node — no pack to install
        resolved.push({ pack: c, installed: true }); // registered live → its pack is present
      }
      if (unknown.length) {
        let installed = new Set();
        try { installed = parseInstalledNodeSet(toolText(await callTool("install_custom_node", { action: "list" }))); }
        catch { /* older/offline bridge — everything reads as unknown */ }
        for (const c of unknown) resolved.push({ pack: c, installed: installed.size ? nodeInstalled(installed, c) : false });
      }
      return dedupePacks(resolved);
    }
  }

  // ── Registry app detail (install view) ───────────────────────────────────

  /** Silent, idempotent install of a registry bundle as a local app. The
   *  registry id becomes the local id; an already-installed copy is left
   *  alone (its published marker is refreshed so Update-published works). */
  async function installRegistryBundle(regApp, bundle) {
    let thumbnail_b64;
    try {
      const res = await fetch(registry.thumbnailUrl(regApp.id));
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = "";
        for (const b of buf) bin += String.fromCharCode(b);
        thumbnail_b64 = btoa(bin);
      }
    } catch { /* no thumbnail — fine */ }
    try {
      await client.create({
        manifest: {
          ...bundle.manifest,
          source: { type: "registry", workflowUuid: null, registryId: regApp.id },
          published: { registryId: regApp.id, slug: regApp.slug, publishedVersion: regApp.version },
        },
        prompt: bundle.prompt,
        ...(bundle.workflow ? { workflow: bundle.workflow } : {}),
        ...(thumbnail_b64 ? { thumbnail_b64 } : {}),
      });
    } catch (e) {
      if (!/already exists/.test(e.message || "")) throw e;
      // Already installed — refresh the published marker so the detail's
      // update path tracks the registry version the user is looking at.
      try {
        await client.update(regApp.id, {
          manifest: { published: { registryId: regApp.id, slug: regApp.slug, publishedVersion: regApp.version } },
        });
      } catch { /* older copy without the app — proceed to detail anyway */ }
    }
  }

  /** Registry app view: NO install gate — the bundle installs silently on
   *  open and the local detail shows immediately (inputs right away). Deps
   *  are visible in the Requirements panel before the first run. */
  async function showRegistryDetail(regApp) {
    if (closed) return;
    body.textContent = "";
    const bar = el("div", "cmcp-apps-toolbar");
    const back = makeBtn(tr("apps_ui.explore_2", "← Explore"));
    back.addEventListener("click", () => { _tab = "explore"; showGrid().catch(showError); });
    bar.append(back);
    body.append(bar, el("div", "cmcp-apps-empty", tr("apps_ui.preparing", "Preparing…")));
    try {
      const bundle = await registry.bundle(regApp.id);
      await installRegistryBundle(regApp, bundle);
    } catch (e) {
      return showError(e);
    }
    await showDetail(regApp.id, regApp);
  }

  // ── Convert view ─────────────────────────────────────────────────────────

  async function showConvert() {
    const draft = await draftFromCanvas(getApp);
    if (closed) return;
    body.textContent = "";

    const bar = el("div", "cmcp-apps-toolbar");
    const back = makeBtn(tr("apps_ui.my_apps_2", "← My Apps"));
    back.classList.add("cmcp-apps-back");
    back.addEventListener("click", () => showGrid().catch(showError));
    bar.append(back);
    body.append(bar);

    if (draft.imported) {
      body.append(
        el(
          "div",
          "cmcp-apps-warn",
          tr(
            "apps_ui.this_workflow_already_has_a_comfyui_app",
            "This workflow already has a ComfyUI APP-mode config — its input/output selection is pre-checked below.",
          ),
        ),
      );
    }

    const form = el("div", "cmcp-apps-form");
    const nameField = el("div", "cmcp-apps-field");
    nameField.append(el("label", "", tr("apps_ui.app_name", "App name")));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 120;
    nameInput.placeholder = tr("apps_ui.e_g_studio_portrait", "e.g. Studio Portrait");
    nameField.append(nameInput);

    const descField = el("div", "cmcp-apps-field");
    descField.append(el("label", "", tr("apps_ui.description", "Description")));
    const descInput = document.createElement("textarea");
    descInput.placeholder = tr("apps_ui.what_does_this_app_do_what_do", "What does this app do? What do its inputs mean?");
    descField.append(descInput);

    const thumbField = el("div", "cmcp-apps-field");
    thumbField.append(el("label", "", tr("apps_ui.thumbnail_optional", "Thumbnail (optional)")));
    const thumbInput = document.createElement("input");
    thumbInput.type = "file";
    thumbInput.accept = "image/png,image/jpeg,image/webp";
    thumbField.append(thumbInput);

    const pick = el("div", "cmcp-apps-pick");
    pick.append(el("div", "grp", tr("apps_ui.inputs_the_endpoints_this_app_exposes", "Inputs — the endpoints this app exposes")));
    for (const cand of draft.inputs) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = cand.checked;
      cb.dataset.key = `${cand.nodeId}.${cand.widget}`;
      label.append(cb, document.createTextNode(`${cand.label} (${cand.kind})`));
      pick.append(label);
    }
    pick.append(el("div", "grp", tr("apps_ui.outputs_what_the_app_shows_after_a", "Outputs — what the app shows after a run")));
    for (const cand of draft.outputs) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = cand.checked;
      cb.dataset.out = String(cand.nodeId);
      label.append(cb, document.createTextNode(cand.label));
      pick.append(label);
    }

    const saveRow = el("div", "cmcp-apps-runbar");
    const saveBtn = makeBtn(tr("apps_ui.create_app", "Create app"), { primary: true });
    const status = el("span", "cmcp-apps-status");
    saveRow.append(saveBtn, status);
    form.append(nameField, descField, thumbField, pick, saveRow);
    body.append(form);

    saveBtn.addEventListener("click", async () => {
      status.classList.remove("err");
      const name = nameInput.value.trim();
      if (!name) {
        status.textContent = tr("apps_ui.name_the_app_first", "Name the app first.");
        status.classList.add("err");
        return;
      }
      const inputs = draft.inputs.filter(
        (c) => pick.querySelector(`input[data-key="${CSS.escape(`${c.nodeId}.${c.widget}`)}"]`)?.checked,
      );
      if (!inputs.length) {
        status.textContent = tr("apps_ui.expose_at_least_one_input_an_app", "Expose at least one input — an app with no endpoints is just a workflow.");
        status.classList.add("err");
        return;
      }
      const outputs = draft.outputs
        .filter((c) => pick.querySelector(`input[data-out="${c.nodeId}"]`)?.checked)
        .map(({ nodeId, kind }) => ({ nodeId, kind }));
      saveBtn.disabled = true;
      status.textContent = tr("apps_ui.saving", "Saving…");
      try {
        let thumbnail_b64;
        const file = thumbInput.files && thumbInput.files[0];
        if (file) {
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = "";
          for (const b of buf) bin += String.fromCharCode(b);
          thumbnail_b64 = btoa(bin);
        }
        const app = getApp();
        const knownTypes = new Set(Object.keys(app?.nodeManager?.defs || app?.extensions?.nodeDefs || {}));
        const manifest = AppBuilder.buildManifest({
          id: crypto.randomUUID(),
          name,
          description: descInput.value.trim(),
          appMode: {
            inputs: inputs.map(({ nodeId, widget, nodeType, label, kind, choices, default: def, min, max, step, seedBehavior }) => ({
              nodeId,
              widget,
              label,
              kind,
              ...(nodeType ? { nodeType } : {}),
              ...(choices ? { choices } : {}),
              ...(def !== undefined ? { default: def } : {}),
              ...(min !== undefined ? { min } : {}),
              ...(max !== undefined ? { max } : {}),
              ...(step !== undefined ? { step } : {}),
              ...(seedBehavior ? { seedBehavior } : {}),
            })),
            outputs,
            importedFromFrontend: !!draft.imported,
          },
          source: { type: draft.imported ? "app-mode" : "canvas", workflowUuid: null, registryId: null },
          deps: AppBuilder.depsFromPrompt(draft.prompt, knownTypes),
        });
        await client.create({ manifest, workflow: draft.workflow, prompt: draft.prompt, thumbnail_b64 });
        await showGrid();
      } catch (e) {
        status.textContent = e.message;
        status.classList.add("err");
        saveBtn.disabled = false;
      }
    });
  }

  // ── Detail view ──────────────────────────────────────────────────────────

  async function showDetail(id, regCtx = null) {
    const app = await client.get(id);
    if (closed) return;
    body.textContent = "";

    const bar = el("div", "cmcp-apps-toolbar");
    const back = makeBtn(regCtx ? tr("apps_ui.explore_2", "← Explore") : tr("apps_ui.my_apps_2", "← My Apps"));
    back.addEventListener("click", () => {
      if (regCtx) _tab = "explore";
      showGrid().catch(showError);
    });
    bar.append(back);
    body.append(bar);

    const detail = el("div", "cmcp-apps-detail");
    const head = el("div", "cmcp-apps-detail-head");
    const thumb = el("div", "thumb", "▶");
    if (app.has_thumbnail) {
      thumb.style.backgroundImage = `url("${client.thumbnailUrl(app.id)}")`;
      thumb.textContent = "";
    }
    const titles = el("div", "titles");
    // Title row: name + (registry apps) a star icon right beside it.
    const titleRow = el("div", "cmcp-apps-title-row");
    titleRow.append(el("h3", "", app.name || tr("apps_ui.untitled_app", "Untitled app")));
    if (regCtx) {
      const starBtn = el("button", "cmcp-apps-starbtn", "☆");
      starBtn.type = "button";
      starBtn.title = tr("apps_ui.star_this_app", "Star this app");
      const starCount = el("span", "cmcp-apps-starcount", String(regCtx.stars || 0));
      let starred = false;
      let count = Number(regCtx.stars || 0);
      const paint = () => {
        starBtn.textContent = starred ? "★" : "☆";
        starBtn.classList.toggle("starred", starred);
        starCount.textContent = String(count);
      };
      // No clicks until the real state arrives — a click while the lookup is
      // in flight would toggle from the WRONG initial value (star instead of
      // unstar, corrupting the count — codex finding).
      starBtn.disabled = true;
      registry.starred(regCtx.id).then((r) => {
        starred = !!r?.starred;
        paint();
      }).catch(() => {})
        .finally(() => {
          starBtn.disabled = false;
        });
      starBtn.addEventListener("click", async () => {
        starred = !starred;
        count = Math.max(0, count + (starred ? 1 : -1));
        paint();
        try {
          await registry.star(regCtx.id, starred);
        } catch { /* star is cosmetic — the count resyncs on next open */ }
      });
      paint();
      titleRow.append(starBtn, starCount);
    }
    titles.append(titleRow);
    if (regCtx) {
      // Three strings joined, not one sentence: the run count is a COUNTED string and
      // has to reach Intl.PluralRules on its own. Baked into a longer sentence the noun
      // is frozen at the English "runs", which is already wrong at 1 and gives a Russian
      // or Arabic translator no form to vary at all.
      titles.append(
        el(
          "div",
          "desc",
          [
            // "anonymous" is the stored creator name, not a label — see the Explore card.
            tr("apps_ui.by", "by {creator}", { creator: regCtx.creator || "anonymous" }),
            tr("apps_ui.runs_2", { one: "{count} run", other: "{count} runs" }, { count: Number(regCtx.runs) || 0 }),
            `v${regCtx.version || 1}`,
          ].join(" · "),
        ),
      );
    }
    if (app.description) titles.append(el("div", "desc", app.description));
    head.append(thumb, titles);
    detail.append(head);

    if (app.hideWorkflow) {
      detail.append(
        el(
          "div",
          "cmcp-apps-warn",
          tr("apps_ui.hidden_workflow_best_effort_the_node_graph", "Hidden workflow (best effort): the node graph was never stored with this app, so casual users can't open it — but anyone technical who runs this app can still intercept the prompt via ComfyUI's API. Real protection comes with hosted runs (coming soon)."),
        ),
      );
    }

    // Dependency side-panel — required models + node packs, each ✓ or an
    // action. ONE renderDepsPanel, mounted as the right-hand column of the
    // detail layout (the merge briefly had two: this one and a duplicate
    // after the form). The prompt (API snapshot) lives in the bundle, not the
    // detail record, so the node section fetches it lazily.
    const deps = app.deps || {};
    const hasDeps =
      (Array.isArray(deps.models) && deps.models.length > 0) ||
      (Array.isArray(deps.customNodes) && deps.customNodes.length > 0);
    const depsHost = el("div");

    // Generated input form.
    const form = el("div", "cmcp-apps-form");
    const fieldEls = new Map(); // "nodeId.widget" -> () => value | undefined
    for (const input of app.appMode?.inputs || []) {
      const key = `${input.nodeId}.${input.widget}`;
      const field = el("div", "cmcp-apps-field");
      field.append(el("label", "", input.label || key));
      let getter;
      if (input.kind === "image" || input.kind === "video") {
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = input.kind === "video" ? "video/*" : "image/*";
        field.append(fileInput);
        // Return the raw File — the RUN path decides where the bytes go
        // (local /upload/image, or the bridge's upload_media → the pod).
        getter = () => (fileInput.files && fileInput.files[0]) || undefined;
      } else if (input.kind === "model") {
        // A real, searchable picker — NEVER a bare textarea. Options come from
        // the connected server's live object_info first, the convert-time
        // choices next, and a bridge list_local_models query as a last resort.
        const inp = document.createElement("input");
        inp.type = "text";
        inp.autocomplete = "off";
        inp.placeholder = tr("apps_ui.pick_or_type_a_model", "Pick or type a model…");
        inp.className = "cmcp-apps-modelpick";
        const dl = document.createElement("datalist");
        dl.id = `cmcp-models-${key.replace(/[^\w-]/g, "_")}-${Math.random().toString(36).slice(2, 7)}`;
        inp.setAttribute("list", dl.id);
        const caption = el("div", "cmcp-apps-hint");
        const applyOptions = (list) => {
          const uniq = [...new Set(list.filter(Boolean).map(String))];
          dl.textContent = "";
          for (const v of uniq) {
            const o = document.createElement("option");
            o.value = v;
            dl.append(o);
          }
          // Counted string: the plural form is the CATALOG's job, not an inline
          // `=== 1 ? "" : "s"` — Korean has one form, Russian has four.
          caption.textContent = uniq.length
            ? tr(
                "apps_ui.models_available_type_to_filter",
                { one: "{count} model available — type to filter", other: "{count} models available — type to filter" },
                { count: uniq.length },
              )
            : tr("apps_ui.no_models_found_on_the_server_type", "No models found on the server — type a filename.");
          return uniq;
        };
        let known = applyOptions([
          ...(liveWidgetChoices(getApp, input.nodeType, input.widget) || []),
          ...(Array.isArray(input.choices) ? input.choices : []),
        ]);
        if (input.default !== undefined) inp.value = String(input.default);
        field.append(inp, dl, caption);
        getter = () => inp.value.trim() || undefined;
        // Augment from the CONNECTED server (best effort; the bridge may be
        // absent on a local-only session, in which case callTool resolves
        // undefined and this is a no-op).
        if (typeof callTool === "function") {
          const dir = modelDirForWidget(input.widget);
          Promise.resolve(callTool("list_local_models", { action: "list", ...(dir ? { model_type: dir } : {}) }))
            .then((res) => {
              const more = parseModelList(res, dir);
              if (more.length) known = applyOptions([...known, ...more]);
            })
            .catch(() => { /* offline / older bridge — keep the local options */ });
        }
      } else if (input.kind === "color") {
        const c = document.createElement("input");
        c.type = "color";
        const raw = typeof input.default === "string" ? input.default : "";
        c.value = /^#?[0-9a-fA-F]{6}$/.test(raw) ? (raw[0] === "#" ? raw : "#" + raw) : "#000000";
        field.append(c);
        getter = () => c.value;
      } else if (input.kind === "seed") {
        // Classic ComfyUI seed control: a number + a 🎲 randomize/fix toggle.
        const row = el("div", "cmcp-apps-seedrow");
        const num = document.createElement("input");
        num.type = "number";
        num.step = "1";
        num.min = "0";
        const init = input.default !== undefined ? Number(input.default) : 0;
        num.value = String(Number.isFinite(init) ? init : 0);
        let randomize = input.seedBehavior ? input.seedBehavior !== "fixed" : true;
        const rollSeed = () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        const dice = makeBtn("🎲");
        const syncDice = () => {
          dice.classList.toggle("primary", randomize);
          dice.title = randomize
            ? tr("apps_ui.seed_is_randomized_on_every_run_click", "Seed is randomized on every run — click to fix it")
            : tr("apps_ui.seed_is_fixed_click_to_randomize_each", "Seed is fixed — click to randomize each run");
        };
        dice.addEventListener("click", () => {
          randomize = !randomize;
          if (randomize) num.value = String(rollSeed());
          syncDice();
        });
        syncDice();
        row.append(num, dice);
        field.append(row);
        getter = () => {
          if (randomize) num.value = String(rollSeed());
          return num.value === "" ? undefined : Number(num.value);
        };
      } else if (input.kind === "combo" && Array.isArray(input.choices) && input.choices.length) {
        const sel = document.createElement("select");
        for (const c of input.choices) {
          const opt = document.createElement("option");
          opt.value = c;
          opt.textContent = c;
          sel.append(opt);
        }
        if (input.default !== undefined) sel.value = String(input.default);
        field.append(sel);
        getter = () => sel.value;
      } else if (input.kind === "number") {
        const hasRange = typeof input.min === "number" && typeof input.max === "number" && input.max > input.min;
        const step = typeof input.step === "number" && input.step > 0 ? String(input.step) : "";
        const num = document.createElement("input");
        num.type = "number";
        if (step) num.step = step;
        if (typeof input.min === "number") num.min = String(input.min);
        if (typeof input.max === "number") num.max = String(input.max);
        if (input.default !== undefined) num.value = String(input.default);
        if (hasRange) {
          // Slider + a synced numeric readout when the manifest carries bounds.
          const row = el("div", "cmcp-apps-sliderrow");
          const range = document.createElement("input");
          range.type = "range";
          range.min = String(input.min);
          range.max = String(input.max);
          if (step) range.step = step;
          num.classList.add("cmcp-apps-sliderval");
          const init = input.default !== undefined ? Number(input.default) : Number(input.min);
          range.value = String(Number.isFinite(init) ? init : input.min);
          if (input.default === undefined) num.value = range.value;
          range.addEventListener("input", () => { num.value = range.value; });
          num.addEventListener("input", () => { if (num.value !== "") range.value = num.value; });
          row.append(range, num);
          field.append(row);
        } else {
          field.append(num);
        }
        getter = () => (num.value === "" ? undefined : Number(num.value));
      } else if (input.kind === "toggle") {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!input.default;
        field.append(cb);
        getter = () => cb.checked;
      } else {
        const ta = document.createElement("textarea");
        if (input.default !== undefined) ta.value = String(input.default);
        field.append(ta);
        getter = () => ta.value;
      }
      fieldEls.set(key, getter);
      form.append(field);
    }

    const runRow = el("div", "cmcp-apps-runbar");
    const runBtn = makeBtn(tr("apps_ui.run", "▶ Run"), { primary: true, title: tr("apps_ui.queue_this_app_on_the_local_comfyui", "Queue this app on the local ComfyUI.") });
    const runpodBtn = makeBtn(tr("apps_ui.run_on_runpod", "☁ Run on RunPod"), {
      title: tr("apps_ui.queue_this_app_on_your_connected_runpod", "Queue this app on your connected RunPod pod (see the RunPod panel to connect one)."),
    });
    const status = el("span", "cmcp-apps-status");
    runRow.append(runBtn, runpodBtn, status);
    form.append(runRow);

    const outputs = el("div", "cmcp-apps-outputs");

    // ONE deps panel, right-hand column (declared above; registry installs see
    // it before their first run, replacing the old install-gate consent).
    const main = el("div", "cmcp-apps-main");
    const grow = el("div", "grow");
    grow.append(form, outputs);
    main.append(grow);
    if (hasDeps) {
      renderDepsPanel(depsHost, {
        models: deps.models,
        customNodes: deps.customNodes,
        getWorkflow: () => client.bundle(app.id).then((b) => (b && b.prompt) || null).catch(() => null),
      });
      main.append(depsHost);
    }
    detail.append(main);
    body.append(detail);

    // Management row (metadata edit, publish, hide, delete) — below the fold.
    const mgmt = el("div", "cmcp-apps-toolbar");
    const editBtn = makeBtn(tr("apps_ui.edit_info", "✎ Edit info"));
    const publishBtn = makeBtn(app.published ? tr("apps_ui.update_published", "⇪ Update published") : tr("apps_ui.publish", "⇪ Publish"), {
      title: tr("apps_ui.share_this_app_to_the_public_registry", "Share this app to the public registry (Explore tab). Hidden apps upload the run snapshot only — never the graph."),
    });
    const hideBtn = makeBtn(app.hideWorkflow ? tr("apps_ui.workflow_hidden", "🔒 Workflow hidden") : tr("apps_ui.hide_workflow", "🔓 Hide workflow"), {
      title: tr("apps_ui.best_effort_deletes_the_stored_node_graph", "Best effort: deletes the stored node graph so the app only carries the run snapshot. A technical user can still intercept it — see the warning above."),
    });
    const delBtn = makeBtn(tr("apps_ui.delete", "🗑 Delete"), { danger: true });
    mgmt.append(editBtn, publishBtn, hideBtn, delBtn);
    detail.append(mgmt);

    publishBtn.addEventListener("click", async () => {
      if (!registry.configured) {
        toast(
          tr(
            "apps_ui.no_registry_configured_yet_set_to_a",
            "No registry configured yet — set “{key}” to a deployed registry to publish.",
            { key: "comfyui-mcp.panel.registryUrl" },
          ),
        );
        return;
      }
      if (app.hideWorkflow) {
        const ok = await confirmModal({
          title: tr("apps_ui.publish_a_hidden_app", "Publish a hidden app?"),
          message: tr("apps_ui.publish_as_a_hidden_app_only_the", "Publish “{name}” as a HIDDEN app?\n\nOnly the run snapshot is uploaded — never the node graph. This is best-effort privacy, not security: anyone who runs the app can still intercept the prompt.", { name: app.name || tr("apps_ui.this_app", "this app") }),
          confirmLabel: tr("apps_ui.publish_hidden", "Publish hidden"),
        });
        if (!ok) return;
      }
      publishBtn.disabled = true;
      try {
        let creatorName = null;
        try { creatorName = localStorage.getItem("comfyui-mcp.panel.creatorName"); } catch {}
        if (!creatorName) {
          creatorName = await promptModal({
            title: tr("apps_ui.publish_to_the_registry", "Publish to the registry"),
            label: tr("apps_ui.creator_name", "Creator name"),
            // NOT translated: this value is stored and uploaded as the creator's name.
            // A localized default would publish the same person under a different
            // author string in every language.
            value: "anonymous",
            placeholder: "anonymous",
            submitLabel: tr("apps_ui.continue", "Continue"),
          });
          if (creatorName === null) { publishBtn.disabled = false; return; }
          creatorName = creatorName.trim() || "anonymous";
          try { localStorage.setItem("comfyui-mcp.panel.creatorName", creatorName); } catch {}
        }
        const bundle = await client.bundle(app.id);
        const result = await registry.publish({
          creatorName,
          app: {
            id: app.id,
            name: bundle.manifest.name,
            description: bundle.manifest.description || "",
            version: (app.published?.publishedVersion || 0) + 1,
            hide_workflow: !!app.hideWorkflow,
            nsfw: false,
            app_mode: bundle.manifest.appMode || { inputs: [], outputs: [] },
            deps: bundle.manifest.deps || {},
          },
          prompt: bundle.prompt,
          workflow: app.hideWorkflow ? undefined : bundle.workflow,
          thumbnail_b64: bundle.thumbnail_b64,
        });
        await client.update(app.id, {
          manifest: { published: { registryId: app.id, slug: result.slug, publishedVersion: result.version } },
        });
        await showDetail(app.id);
      } catch (e) {
        toast(tr("apps_ui.publish_failed", "Publish failed: {error}", { error: e.message }));
        publishBtn.disabled = false;
      }
    });

    editBtn.addEventListener("click", async () => {
      const vals = await formModal({
        title: tr("apps_ui.edit_app_info", "Edit app info"),
        submitLabel: tr("apps_ui.save", "Save"),
        fields: [
          { key: "name", label: tr("apps_ui.app_name", "App name"), value: app.name || "", maxLength: 120 },
          { key: "description", label: tr("apps_ui.description", "Description"), value: app.description || "", multiline: true, rows: 4 },
        ],
      });
      if (!vals) return;
      await client.update(app.id, { manifest: { name: vals.name.trim() || app.name, description: vals.description } });
      await showDetail(app.id);
    });

    hideBtn.disabled = !!app.hideWorkflow;
    hideBtn.addEventListener("click", async () => {
      const ok = await confirmModal({
        title: tr("apps_ui.hide_the_workflow", "Hide the workflow?"),
        message: tr("apps_ui.hide_the_workflow_for_this_deletes_the", "Hide the workflow for “{name}”?\n\nThis DELETES the stored node graph — the app keeps only its run snapshot and can't be edited as a workflow afterwards. Best-effort privacy, not security: anyone who runs the app can still intercept the prompt via ComfyUI's API.", { name: app.name || tr("apps_ui.this_app", "this app") }),
        confirmLabel: tr("apps_ui.hide_workflow_2", "Hide workflow"),
        danger: true,
      });
      if (!ok) return;
      await client.update(app.id, { manifest: { hideWorkflow: true } });
      await showDetail(app.id);
    });

    delBtn.addEventListener("click", async () => {
      const ok = await confirmModal({
        title: tr("apps_ui.delete_app", "Delete app"),
        message: tr("apps_ui.delete_this_can_t_be_undone", "Delete “{name}”? This can't be undone.", {
          name: app.name || tr("apps_ui.this_app", "this app"),
        }),
        confirmLabel: tr("apps_ui.delete_2", "Delete"),
        danger: true,
      });
      if (!ok) return;
      await client.remove(app.id);
      await showGrid();
    });

    /** Collect form values; image Files are handed to `uploadImage` (the run
     *  path picks WHERE the bytes go) and replaced by the returned input
     *  filename. */
    async function collectValues(uploadImage) {
      const values = {};
      for (const [key, getter] of fieldEls) {
        let v = await getter();
        if (v instanceof File) {
          if (!uploadImage) continue;
          v = await uploadImage(v);
        }
        if (v !== undefined) values[key] = v;
      }
      return values;
    }

    /** Local image transfer: same-origin /upload/image. */
    async function uploadImageLocal(f) {
      status.textContent = tr("apps_ui.uploading_image", "Uploading image…");
      const ref = await uploadBlobToInput(f, f.name);
      if (!ref) throw new Error(tr("apps_ui.image_upload_failed", "image upload failed"));
      return ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
    }

    /** Pod image transfer: the bridge's upload_media handler writes the bytes
     *  to the CONNECTED ComfyUI's input/ — i.e. the pod when we're on a pod.
     *  The remote name is uniquified per app+input: ComfyUI's /upload/image
     *  OVERWRITES on name collision, so two inputs sharing a basename (or a
     *  repeat run with "image.png") would otherwise silently swap in the last
     *  upload (codex finding). */
    async function uploadImageToPod(f) {
      if (typeof ctx.uploadMedia !== "function") {
        throw new Error(tr("apps_ui.pod_image_transfer_needs_a_newer_panel", "pod image transfer needs a newer panel bridge — update the orchestrator"));
      }
      const unique = `cmcp-app-${app.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}-${f.name}`;
      status.textContent = tr("apps_ui.transferring_to_the_pod", "Transferring {name} to the pod…", { name: f.name });
      const res = await ctx.uploadMedia(f, unique);
      if (!res || res.ok === false) throw new Error((res && res.error) || tr("apps_ui.pod_image_transfer_failed", "pod image transfer failed"));
      return res.name;
    }

    async function runApp() {
      runBtn.disabled = true;
      runpodBtn.disabled = true;
      status.classList.remove("err");
      status.textContent = tr("apps_ui.queueing", "Queueing…");
      outputs.textContent = "";
      try {
        const values = await collectValues(uploadImageLocal);
        const res = await client.run(app.id, values);
        const promptId = res.prompt_id;
        if (!promptId) throw new Error(tr("apps_ui.queue_returned_no_prompt_id", "queue returned no prompt_id"));
        status.textContent = tr("apps_ui.running", "Running…");
        await pollRun(promptId);
      } catch (e) {
        status.textContent = e.message;
        status.classList.add("err");
      } finally {
        runBtn.disabled = false;
        runpodBtn.disabled = false;
      }
    }

    async function pollRun(promptId) {
      const deadline = Date.now() + 30 * 60 * 1000;
      return new Promise((resolve) => {
        // Terminal: clear the resume anchor so a later re-activate can't restart
        // a finished run.
        const done = () => { _polling = false; _lastTick = null; resolve(); };
        const tick = async () => {
          if (closed) return done();
          _polling = true;
          try {
            const st = await client.runStatus(app.id, promptId);
            if (st.status === "done") {
              renderOutputs(st);
              return done();
            }
            status.textContent = st.status === "running" ? tr("apps_ui.running", "Running…") : tr("apps_ui.queued", "Queued…");
          } catch (e) {
            status.textContent = e.message;
            status.classList.add("err");
            return done();
          }
          if (Date.now() > deadline) {
            status.textContent = tr("apps_ui.timed_out_waiting_for_the_run_it", "Timed out waiting for the run — it may still finish; check ComfyUI's queue.");
            status.classList.add("err");
            return done();
          }
          _polling = false;
          // Paused while the Apps tab is hidden — onDeactivate cleared pollTimer,
          // and onActivate re-arms via _lastTick. The shell only detaches the
          // detail DOM (same nodes), so the resumed poll updates the right nodes.
          if (_hidden) { pollTimer = null; return; }
          pollTimer = setTimeout(tick, 2000);
        };
        _lastTick = tick; // resume anchor for re-activation
        tick();
      });
    }

    function renderOutputs(st) {
      const detailStatus = st.status_detail || {};
      const msgs = detailStatus.messages || [];
      const failed = msgs.some((m) => Array.isArray(m) && m[0] === "execution_error");
      status.textContent = failed
        ? tr("apps_ui.run_failed_see_comfyui_for_details", "Run failed — see ComfyUI for details.")
        : tr("apps_ui.done", "Done.");
      if (failed) status.classList.add("err");
      // Published app → report the run so registry trending works (fire and
      // forget; a popularity signal, never billing).
      if (!failed && app.published?.registryId && registry.configured) {
        registry.ran(app.published.registryId);
      }
      outputs.textContent = "";
      const wanted = new Set((app.appMode?.outputs || []).map((o) => String(o.nodeId)));
      for (const [nodeId, out] of Object.entries(st.outputs || {})) {
        if (wanted.size && !wanted.has(String(nodeId))) continue;
        const media = AppBuilder.collectRunMedia(out);
        for (const ref of media) {
          const url = viewUrl(ref);
          const isVideo = AppBuilder.isRunVideoRef(ref);
          const m = document.createElement(isVideo ? "video" : "img");
          m.src = url;
          if (isVideo) {
            m.controls = true;
            m.loop = true;
            m.muted = true;
            m.autoplay = true;
            m.playsInline = true;
          }
          outputs.append(m);
        }
        for (const t of out.text || []) {
          outputs.append(el("div", "text-out", typeof t === "string" ? t : JSON.stringify(t)));
        }
      }
      if (!outputs.childNodes.length && !failed) {
        outputs.append(
          el("div", "text-out", tr("apps_ui.run_finished_with_no_visible_outputs_on", "Run finished with no visible outputs on the selected output nodes.")),
        );
      }
    }

    runBtn.addEventListener("click", () => runApp());
    runpodBtn.addEventListener("click", () => runOnPod().catch((e) => {
      status.textContent = e.message;
      status.classList.add("err");
    }));

    /** One-click pod run: image inputs are transferred to the pod through the
     *  bridge's upload_media handler FIRST (it writes to the connected target),
     *  then the LOCAL apps route dry-patches the snapshot and the
     *  orchestrator's enqueue_workflow sends it to the pod. Deps pinned to a
     *  CivitAI version are pushed first (download_model action:"download_civitai"
     *  is whitelisted); anything unpinned is reported, not silently skipped. */
    async function runOnPod() {
      status.classList.remove("err");
      if (!callTool) {
        throw new Error(tr("apps_ui.orchestrator_not_connected_pod_runs_go_through", "Orchestrator not connected — pod runs go through the bridge."));
      }
      const target = typeof getRunpodTarget === "function" ? getRunpodTarget() : null;
      if (!target || target.is_local) {
        throw new Error(
          tr(
            "apps_ui.no_pod_connected_open_the_runpod_panel",
            "No pod connected — open the RunPod panel (cloud icon in the toolbar) to deploy or connect one first.",
          ),
        );
      }
      runpodBtn.disabled = true;
      runBtn.disabled = true;
      try {
        status.textContent = tr("apps_ui.preparing", "Preparing…");
        const values = await collectValues(uploadImageToPod);
        const dry = await client.run(app.id, values, { dry: true });
        const patched = dry.prompt;
        if (!patched) throw new Error(tr("apps_ui.couldn_t_build_the_prompt_snapshot", "couldn't build the prompt snapshot"));

        // Dependency push (best effort, CivitAI-pinned models only).
        const models = Array.isArray(app.deps?.models) ? app.deps.models : [];
        const pinned = models.filter((m) => m && m.civitaiVersionId);
        const unpinned = models.filter((m) => m && !m.civitaiVersionId);
        const custom = Array.isArray(app.deps?.customNodes) ? app.deps.customNodes : [];
        for (const m of pinned) {
          status.textContent = tr("apps_ui.pushing_model_to_pod", "Pushing model to pod: {name}…", { name: m.name });
          const res = await callTool("download_model", {
            action: "download_civitai",
            model_version_id: m.civitaiVersionId,
            target_subfolder: m.targetSubfolder || "checkpoints",
          });
          const text = toolText(res);
          if (res && res.ok === false) {
            throw new Error(tr("apps_ui.model_push_failed", "model push failed ({name}): {detail}", { name: m.name, detail: text }));
          }
        }

        status.textContent = tr("apps_ui.queueing_on_pod", "Queueing on pod…");
        const res = await callTool("enqueue_workflow", {
          action: "enqueue",
          workflow: patched,
          // The app's inputs ARE the user's choices — never re-roll their seed.
          disable_random_seed: true,
        });
        const text = toolText(res);
        let promptId = null;
        try {
          promptId = JSON.parse(text).prompt_id || null;
        } catch { /* tool returned prose */ }
        const notes = [];
        if (promptId) notes.push(tr("apps_ui.queued_on_pod_prompt_id", "queued on pod (prompt_id {id})", { id: promptId }));
        else notes.push(text || tr("apps_ui.queued_on_pod", "queued on pod"));
        // Model / pack names stay verbatim — they are filenames and pack ids.
        if (unpinned.length) {
          notes.push(
            tr("apps_ui.unpinned_models_the_pod_must_already_have", "⚠ unpinned models the pod must already have: {names}", {
              names: unpinned.map((m) => m.name).join(", "),
            }),
          );
        }
        if (custom.length) {
          notes.push(
            tr("apps_ui.custom_nodes_the_pod_must_already_have", "⚠ custom nodes the pod must already have: {names}", {
              names: custom.join(", "),
            }),
          );
        }
        notes.push(tr("apps_ui.progress_watch_comfyui_s_queue_pod_history", "Progress: watch ComfyUI's queue — pod history isn't mirrored back here."));
        status.textContent = notes.join(" · ");
      } finally {
        runpodBtn.disabled = false;
        runBtn.disabled = false;
      }
    }
  }

  function showError(e) {
    if (closed) return;
    body.textContent = "";
    const bar = el("div", "cmcp-apps-toolbar");
    const back = makeBtn(tr("apps_ui.my_apps_2", "← My Apps"));
    back.addEventListener("click", () => showGrid().catch(showError));
    bar.append(back);
    body.append(bar, el("div", "cmcp-apps-empty", e && e.message ? e.message : String(e)));
  }

  // Cross-tab hop seed (CivitAI's "Create App from workflow" → shell.switchTab
  // ("apps", { view: "convert" })): open straight into the convert view seeded
  // from the now-loaded canvas. Runs during activate BEFORE onActivate; setting
  // _started here suppresses onActivate's default showGrid so it can't clobber
  // the convert form.
  function reseed(o) {
    if (!o) return;
    if (o.view === "convert" || o.convert) {
      _tab = "mine";
      _started = true;
      syncChips();
      shell.syncSearch();
      showConvert().catch(showError);
    }
  }

  return {
    key: "apps", label: tr("apps_ui.apps", "Apps"), icon: "pi-th-large", driveKind: null,
    hasSearch: () => _tab === "explore",
    searchPlaceholder: tr("apps_ui.search_apps", "Search apps…"),
    subnavExtras: () => [mineChip, exploreChip, filterBtn],
    reseed,
    // Escape peels an open filter (or other stacked) sheet before it can close the
    // panel — mirrors CivitAI's escapeBlocked.
    escapeBlocked: () => _subModals.size > 0,
    mount(bodyEl) { bodyEl.appendChild(body); },
    onActivate() {
      _hidden = false;
      syncChips();
      if (!_started) { _started = true; showGrid().catch(showError); }
      // Re-arm a paused run poll (the detail DOM is preserved by the shell). The
      // _polling / !pollTimer guards prevent double-arming when a tick is still
      // mid-flight or already scheduled.
      else if (_lastTick && !_polling && !pollTimer) { pollTimer = setTimeout(_lastTick, 0); }
    },
    // Halt the in-flight run poll while hidden — it would otherwise keep polling +
    // writing to the DOM the shell detached on switch.
    onDeactivate() {
      _hidden = true;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    },
    // Shared search → Explore registry query (debounced), no-op on My Apps.
    onSearch(value) {
      exploreQuery = value;
      if (_tab !== "explore" || !_exploreReload) return;
      clearTimeout(_exploreTimer);
      _exploreTimer = setTimeout(() => { if (_exploreReload) _exploreReload(); }, 350);
    },
    update: () => {},
    teardown() {
      closed = true;
      if (pollTimer) clearTimeout(pollTimer); // pollTimer is a setTimeout id, not an interval
      if (_exploreTimer) clearTimeout(_exploreTimer);
    },
  };
}
