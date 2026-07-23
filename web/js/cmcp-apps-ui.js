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

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
.cmcp-apps-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
  padding:1rem;background:rgba(0,0,0,0.45);}
.cmcp-apps-modal{max-width:min(860px,94vw)!important;width:100%;max-height:88vh;display:flex;flex-direction:column;}
.cmcp-apps-body{display:flex;flex-direction:column;gap:0.75rem;min-height:0;flex:1;}
.cmcp-apps-toolbar{display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;}
.cmcp-apps-toolbar .spacer{flex:1;}
.cmcp-apps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:0.75rem;overflow-y:auto;min-height:120px;}
.cmcp-app-card{border:1px solid var(--p-content-border-color,#3f3f46);border-radius:10px;overflow:hidden;cursor:pointer;
  background:var(--p-content-background,#18181b);display:flex;flex-direction:column;transition:border-color .15s;}
.cmcp-app-card:hover{border-color:var(--p-primary-color,#60a5fa);}
.cmcp-app-card .thumb{aspect-ratio:16/9;background:#0c0c0e center/cover no-repeat;display:flex;align-items:center;justify-content:center;
  font-size:1.6rem;opacity:0.85;}
.cmcp-app-card .meta{padding:0.5rem 0.6rem;display:flex;flex-direction:column;gap:0.15rem;}
.cmcp-app-card .name{font-weight:600;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cmcp-app-card .desc{font-size:0.72rem;opacity:0.65;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.cmcp-app-badges{display:flex;gap:0.3rem;margin-top:0.15rem;}
.cmcp-app-badge{font-size:0.62rem;padding:0.05rem 0.35rem;border-radius:99px;border:1px solid var(--p-content-border-color,#3f3f46);opacity:0.8;}
.cmcp-app-badge.hidden-wf{border-color:rgba(245,158,11,0.5);color:#f59e0b;}
.cmcp-apps-empty{opacity:0.6;font-size:0.85rem;padding:2rem 1rem;text-align:center;grid-column:1/-1;}
.cmcp-apps-back{align-self:flex-start;}
.cmcp-apps-detail{display:flex;flex-direction:column;gap:0.75rem;overflow-y:auto;min-height:0;}
.cmcp-apps-detail-head{display:flex;gap:0.75rem;align-items:flex-start;}
.cmcp-apps-detail-head .thumb{width:96px;height:54px;flex:0 0 auto;border-radius:8px;background:#0c0c0e center/cover no-repeat;
  display:flex;align-items:center;justify-content:center;font-size:1.3rem;}
.cmcp-apps-detail-head .titles{flex:1;min-width:0;}
.cmcp-apps-detail-head h3{margin:0;font-size:1rem;}
.cmcp-apps-detail-head .desc{font-size:0.78rem;opacity:0.7;margin-top:0.2rem;white-space:pre-wrap;}
.cmcp-apps-form{display:flex;flex-direction:column;gap:0.55rem;}
.cmcp-apps-field{display:flex;flex-direction:column;gap:0.2rem;}
.cmcp-apps-field>label{font-size:0.72rem;font-weight:600;opacity:0.75;}
.cmcp-apps-field input[type=text],.cmcp-apps-field input[type=number],.cmcp-apps-field textarea,.cmcp-apps-field select{
  padding:0.45rem 0.6rem;border-radius:6px;border:1px solid var(--p-content-border-color,#3f3f46);
  background:var(--p-inputtext-background,#18181b);color:inherit;font-size:0.85rem;font-family:inherit;}
.cmcp-apps-field textarea{min-height:64px;resize:vertical;}
.cmcp-apps-runbar{display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;}
.cmcp-apps-status{font-size:0.8rem;opacity:0.85;min-height:1.1em;}
.cmcp-apps-status.err{color:#f87171;}
.cmcp-apps-outputs{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.5rem;}
.cmcp-apps-outputs img,.cmcp-apps-outputs video{width:100%;border-radius:8px;display:block;background:#0c0c0e;}
.cmcp-apps-outputs .text-out{grid-column:1/-1;font-size:0.8rem;white-space:pre-wrap;background:rgba(255,255,255,0.04);
  border-radius:8px;padding:0.5rem 0.6rem;}
.cmcp-apps-pick{max-height:220px;overflow-y:auto;border:1px solid var(--p-content-border-color,#3f3f46);border-radius:8px;padding:0.4rem;}
.cmcp-apps-pick label{display:flex;gap:0.45rem;align-items:center;font-size:0.78rem;padding:0.15rem 0.2rem;cursor:pointer;}
.cmcp-apps-pick .grp{font-size:0.68rem;font-weight:700;opacity:0.6;margin:0.35rem 0 0.1rem;text-transform:uppercase;letter-spacing:0.04em;}
.cmcp-apps-warn{font-size:0.75rem;color:#f59e0b;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);
  border-radius:8px;padding:0.5rem 0.6rem;}
.cmcp-btn.danger{border-color:rgba(248,113,113,0.5);color:#f87171;}
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
  return res.ok === false ? "The action failed." : "Done.";
}

/** Convert the LIVE canvas into an app bundle draft: prompt snapshot + UI
 *  workflow + candidate inputs/outputs (pre-selected from the frontend's
 *  APP-mode config when present, else the hint-type heuristic). Throws a
 *  readable error when the frontend can't serialize. */
async function draftFromCanvas(getApp) {
  const app = getApp();
  if (!app || typeof app.graphToPrompt !== "function") {
    throw new Error("this frontend can't serialize the graph (graphToPrompt missing)");
  }
  const gp = await app.graphToPrompt(); // { output, workflow }
  const workflow = gp.workflow || app.graph?.serialize?.();
  if (!workflow || !Array.isArray(workflow.nodes)) {
    throw new Error("couldn't serialize the canvas workflow");
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
    const isOutput =
      node.constructor?.nodeData?.output_node === true ||
      /^(SaveImage|PreviewImage|SaveVideo|SaveAudio|PreviewAudio|ShowText|PreviewAsText)/.test(
        String(node.type || ""),
      );
    if (isOutput) {
      outputs.push({
        nodeId: id,
        kind: /^Show|^PreviewAs/.test(String(node.type || "")) ? "text" : "images",
        label: `${node.title || node.type} #${id}`,
        checked: true,
      });
      continue;
    }
    const nodeHasImported = [...importedKeys].some((k) => Number(k.split(".")[0]) === id);
    if (!AppBuilder.INPUT_HINT_TYPES.has(String(node.type || "")) && !nodeHasImported) continue;
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
      inputs.push({
        nodeId: id,
        widget: w.name,
        label: `${node.title || node.type} #${id} · ${w.label || w.name}`,
        kind: AppBuilder.classifyWidget(String(node.type || ""), w.name, w.value),
        choices: Array.isArray(w.options?.values) ? w.options.values.map(String) : undefined,
        default: typeof w.value === "string" || typeof w.value === "number" || typeof w.value === "boolean" ? w.value : undefined,
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


export function openAppsModal(ctx, opts = {}) {
  const { getApp, uploadBlobToInput, callTool, getRunpodTarget } = ctx;
  const client = new AppsClient();
  const registry = new RegistryClient();
  injectStyle();

  const overlay = el("div", "cmcp-apps-overlay");
  const modal = el("div", "cmcp-modal cmcp-apps-modal");
  const title = el("div", "cmcp-modal-title", "Apps");
  const body = el("div", "cmcp-apps-body");
  modal.append(title, body);
  overlay.appendChild(modal);

  let closed = false;
  let pollTimer = null;
  function close() {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    overlay.remove();
    opts.onClose && opts.onClose();
  }
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  window.addEventListener("keydown", onKey);
  const origClose = close;
  close = function () {
    window.removeEventListener("keydown", onKey);
    origClose();
  };

  // ── Grid view ────────────────────────────────────────────────────────────

  let _tab = "mine"; // "mine" | "explore"

  async function showGrid() {
    if (closed) return;
    body.textContent = "";
    const bar = el("div", "cmcp-apps-toolbar");
    const mineTab = makeBtn("My Apps", { primary: _tab === "mine" });
    const exploreTab = makeBtn("Explore", { primary: _tab === "explore" });
    mineTab.addEventListener("click", () => { _tab = "mine"; showGrid().catch(showError); });
    exploreTab.addEventListener("click", () => { _tab = "explore"; showGrid().catch(showError); });
    bar.append(mineTab, exploreTab);
    if (_tab === "mine") {
      const spacer = el("span", "spacer");
      const convertBtn = makeBtn("＋ Convert current workflow", {
        primary: true,
        title: "Package the workflow on the canvas as a one-click app.",
      });
      convertBtn.addEventListener("click", () => showConvert().catch(showError));
      bar.append(spacer, convertBtn);
    }
    body.append(bar);
    if (_tab === "explore") return showExplore();
    return showMine();
  }

  async function showMine() {
    const grid = el("div", "cmcp-apps-grid");
    grid.append(el("div", "cmcp-apps-empty", "Loading…"));
    body.append(grid);

    let apps = [];
    try {
      apps = await client.list();
    } catch (e) {
      grid.textContent = "";
      grid.append(el("div", "cmcp-apps-empty", `Couldn't load apps: ${e.message}`));
      return;
    }
    if (closed) return;
    grid.textContent = "";
    if (!apps.length) {
      grid.append(
        el(
          "div",
          "cmcp-apps-empty",
          "No apps yet. Open a workflow on the canvas, then “Convert current workflow” to make your first one.",
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
      meta.append(el("div", "name", app.name || "Untitled app"));
      if (app.description) meta.append(el("div", "desc", app.description));
      const badges = el("div", "cmcp-app-badges");
      if (app.hideWorkflow) badges.append(el("span", "cmcp-app-badge hidden-wf", "hidden workflow"));
      if (app.published) badges.append(el("span", "cmcp-app-badge", `★ ${app.published.slug || "published"}`));
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
          "No registry configured. Set localStorage key “comfyui-mcp.panel.registryUrl” to a deployed registry worker to explore published apps.",
        ),
      );
      return;
    }
    const controls = el("div", "cmcp-apps-toolbar");
    let sort = "trending";
    const sorts = [["trending", "Trending"], ["new", "New"], ["stars", "Most starred"]];
    const chips = new Map();
    const grid = el("div", "cmcp-apps-grid");
    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Search apps…";
    search.style.cssText =
      "flex:1;min-width:140px;padding:0.4rem 0.55rem;border-radius:6px;border:1px solid var(--p-content-border-color,#3f3f46);background:var(--p-inputtext-background,#18181b);color:inherit;font-size:0.82rem;";
    async function load(append = false, cursor = "") {
      if (!append) {
        grid.textContent = "";
        grid.append(el("div", "cmcp-apps-empty", "Loading…"));
      }
      try {
        const res = await registry.list({ sort, q: search.value.trim(), cursor });
        if (closed) return;
        if (!append) grid.textContent = "";
        renderCards(res.apps || [], res.next_cursor);
      } catch (e) {
        if (!append) {
          grid.textContent = "";
          grid.append(el("div", "cmcp-apps-empty", `Registry error: ${e.message}`));
        }
      }
    }
    function renderCards(apps, nextCursor) {
      grid.querySelector(".cmcp-apps-empty")?.remove();
      grid.querySelector(".cmcp-apps-more")?.remove();
      if (!apps.length && !grid.childNodes.length) {
        grid.append(el("div", "cmcp-apps-empty", "No published apps match."));
        return;
      }
      for (const app of apps) {
        const card = el("div", "cmcp-app-card");
        const thumb = el("div", "thumb", "▶");
        thumb.style.backgroundImage = `url("${registry.thumbnailUrl(app.id)}")`;
        thumb.textContent = "";
        const meta = el("div", "meta");
        meta.append(el("div", "name", app.name || "Untitled"));
        meta.append(el("div", "desc", `by ${app.creator || "anonymous"}`));
        const badges = el("div", "cmcp-app-badges");
        badges.append(el("span", "cmcp-app-badge", `★ ${app.stars || 0}`));
        badges.append(el("span", "cmcp-app-badge", `▶ ${app.runs || 0} runs`));
        if (app.hide_workflow) badges.append(el("span", "cmcp-app-badge hidden-wf", "hidden"));
        meta.append(badges);
        card.append(thumb, meta);
        card.addEventListener("click", () => showRegistryDetail(app).catch(showError));
        grid.append(card);
      }
      if (nextCursor) {
        const more = makeBtn("Load more");
        more.classList.add("cmcp-apps-more");
        more.addEventListener("click", () => load(true, nextCursor));
        grid.append(more);
      }
    }
    for (const [key, label] of sorts) {
      const chip = makeBtn(label, { primary: key === sort });
      chips.set(key, chip);
      chip.addEventListener("click", () => {
        sort = key;
        for (const [k, c] of chips) c.classList.toggle("primary", k === sort);
        load();
      });
      controls.append(chip);
    }
    let searchTimer = null;
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(), 350);
    });
    controls.append(search);
    body.append(controls, grid);
    load();
  }

  // ── Registry app detail (install view) ───────────────────────────────────

  async function showRegistryDetail(regApp) {
    if (closed) return;
    body.textContent = "";
    const bar = el("div", "cmcp-apps-toolbar");
    const back = makeBtn("← Explore");
    back.addEventListener("click", () => { _tab = "explore"; showGrid().catch(showError); });
    bar.append(back);
    body.append(bar);

    const detail = el("div", "cmcp-apps-detail");
    const head = el("div", "cmcp-apps-detail-head");
    const thumb = el("div", "thumb", "▶");
    thumb.style.backgroundImage = `url("${registry.thumbnailUrl(regApp.id)}")`;
    thumb.textContent = "";
    const titles = el("div", "titles");
    titles.append(el("h3", "", regApp.name || "Untitled"));
    titles.append(el("div", "desc", `by ${regApp.creator || "anonymous"} · ★ ${regApp.stars || 0} · ${regApp.runs || 0} runs · v${regApp.version || 1}`));
    if (regApp.description) titles.append(el("div", "desc", regApp.description));
    head.append(thumb, titles);
    detail.append(head);

    if (regApp.hide_workflow) {
      detail.append(
        el(
          "div",
          "cmcp-apps-warn",
          "Hidden workflow (best effort): the graph is never distributed with this app — but anyone technical " +
            "who runs it can still intercept the prompt via ComfyUI's API. Real protection comes with hosted runs (coming soon).",
        ),
      );
    }

    const actions = el("div", "cmcp-apps-runbar");
    const installBtn = makeBtn("⬇ Install", { primary: true });
    const starBtn = makeBtn("☆ Star");
    const status = el("span", "cmcp-apps-status");
    actions.append(installBtn, starBtn, status);
    detail.append(actions);
    body.append(detail);

    let starred = false;
    starBtn.addEventListener("click", async () => {
      starred = !starred;
      starBtn.textContent = starred ? "★ Starred" : "☆ Star";
      try {
        await registry.star(regApp.id, starred);
      } catch (e) {
        status.textContent = e.message;
        status.classList.add("err");
      }
    });

    installBtn.addEventListener("click", async () => {
      installBtn.disabled = true;
      status.classList.remove("err");
      try {
        status.textContent = "Fetching bundle…";
        const bundle = await registry.bundle(regApp.id);
        const deps = bundle.manifest?.deps || {};
        const models = Array.isArray(deps.models) ? deps.models : [];
        const nodes = Array.isArray(deps.customNodes) ? deps.customNodes : [];
        if (models.length || nodes.length) {
          const ok = window.confirm(
            `“${regApp.name}” needs:\n` +
              (models.length ? `\nModels (${models.length}):\n  ${models.map((m) => m.name || m).join("\n  ")}\n` : "") +
              (nodes.length ? `\nCustom nodes (${nodes.length}):\n  ${nodes.join("\n  ")}\n` : "") +
              "\nAnything missing must be installed before the app can run (ask the agent to install it, or install it yourself). Continue?",
          );
          if (!ok) {
            installBtn.disabled = false;
            status.textContent = "";
            return;
          }
        }
        status.textContent = "Installing…";
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
        _tab = "mine";
        await showDetail(regApp.id);
      } catch (e) {
        status.textContent = e.message.includes("already exists")
          ? "Already installed — find it in My Apps."
          : e.message;
        status.classList.add("err");
        installBtn.disabled = false;
      }
    });
  }

  // ── Convert view ─────────────────────────────────────────────────────────

  async function showConvert() {
    const draft = await draftFromCanvas(getApp);
    if (closed) return;
    body.textContent = "";

    const bar = el("div", "cmcp-apps-toolbar");
    const back = makeBtn("← My Apps");
    back.classList.add("cmcp-apps-back");
    back.addEventListener("click", () => showGrid().catch(showError));
    bar.append(back);
    body.append(bar);

    if (draft.imported) {
      body.append(
        el(
          "div",
          "cmcp-apps-warn",
          "This workflow already has a ComfyUI APP-mode config — its input/output selection is pre-checked below.",
        ),
      );
    }

    const form = el("div", "cmcp-apps-form");
    const nameField = el("div", "cmcp-apps-field");
    nameField.append(el("label", "", "App name"));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 120;
    nameInput.placeholder = "e.g. Studio Portrait";
    nameField.append(nameInput);

    const descField = el("div", "cmcp-apps-field");
    descField.append(el("label", "", "Description"));
    const descInput = document.createElement("textarea");
    descInput.placeholder = "What does this app do? What do its inputs mean?";
    descField.append(descInput);

    const thumbField = el("div", "cmcp-apps-field");
    thumbField.append(el("label", "", "Thumbnail (optional)"));
    const thumbInput = document.createElement("input");
    thumbInput.type = "file";
    thumbInput.accept = "image/png,image/jpeg,image/webp";
    thumbField.append(thumbInput);

    const pick = el("div", "cmcp-apps-pick");
    pick.append(el("div", "grp", "Inputs — the endpoints this app exposes"));
    for (const cand of draft.inputs) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = cand.checked;
      cb.dataset.key = `${cand.nodeId}.${cand.widget}`;
      label.append(cb, document.createTextNode(`${cand.label} (${cand.kind})`));
      pick.append(label);
    }
    pick.append(el("div", "grp", "Outputs — what the app shows after a run"));
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
    const saveBtn = makeBtn("Create app", { primary: true });
    const status = el("span", "cmcp-apps-status");
    saveRow.append(saveBtn, status);
    form.append(nameField, descField, thumbField, pick, saveRow);
    body.append(form);

    saveBtn.addEventListener("click", async () => {
      status.classList.remove("err");
      const name = nameInput.value.trim();
      if (!name) {
        status.textContent = "Name the app first.";
        status.classList.add("err");
        return;
      }
      const inputs = draft.inputs.filter(
        (c) => pick.querySelector(`input[data-key="${CSS.escape(`${c.nodeId}.${c.widget}`)}"]`)?.checked,
      );
      if (!inputs.length) {
        status.textContent = "Expose at least one input — an app with no endpoints is just a workflow.";
        status.classList.add("err");
        return;
      }
      const outputs = draft.outputs
        .filter((c) => pick.querySelector(`input[data-out="${c.nodeId}"]`)?.checked)
        .map(({ nodeId, kind }) => ({ nodeId, kind }));
      saveBtn.disabled = true;
      status.textContent = "Saving…";
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
            inputs: inputs.map(({ nodeId, widget, label, kind, choices, default: def }) => ({
              nodeId,
              widget,
              label,
              kind,
              ...(choices ? { choices } : {}),
              ...(def !== undefined ? { default: def } : {}),
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

  async function showDetail(id) {
    const app = await client.get(id);
    if (closed) return;
    body.textContent = "";

    const bar = el("div", "cmcp-apps-toolbar");
    const back = makeBtn("← My Apps");
    back.addEventListener("click", () => showGrid().catch(showError));
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
    titles.append(el("h3", "", app.name || "Untitled app"));
    if (app.description) titles.append(el("div", "desc", app.description));
    head.append(thumb, titles);
    detail.append(head);

    if (app.hideWorkflow) {
      detail.append(
        el(
          "div",
          "cmcp-apps-warn",
          "Hidden workflow (best effort): the node graph was never stored with this app, so casual users can't " +
            "open it — but anyone technical who runs this app can still intercept the prompt via ComfyUI's API. " +
            "Real protection comes with hosted runs (coming soon).",
        ),
      );
    }

    // Generated input form.
    const form = el("div", "cmcp-apps-form");
    const fieldEls = new Map(); // "nodeId.widget" -> () => value | undefined
    for (const input of app.appMode?.inputs || []) {
      const key = `${input.nodeId}.${input.widget}`;
      const field = el("div", "cmcp-apps-field");
      field.append(el("label", "", input.label || key));
      let getter;
      if (input.kind === "image") {
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        field.append(fileInput);
        // Return the raw File — the RUN path decides where the bytes go
        // (local /upload/image, or the bridge's upload_media → the pod).
        getter = () => (fileInput.files && fileInput.files[0]) || undefined;
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
        const num = document.createElement("input");
        num.type = "number";
        if (input.default !== undefined) num.value = String(input.default);
        field.append(num);
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
    const runBtn = makeBtn("▶ Run", { primary: true, title: "Queue this app on the local ComfyUI." });
    const runpodBtn = makeBtn("☁ Run on RunPod", {
      title: "Queue this app on your connected RunPod pod (see the RunPod panel to connect one).",
    });
    const status = el("span", "cmcp-apps-status");
    runRow.append(runBtn, runpodBtn, status);
    form.append(runRow);

    const outputs = el("div", "cmcp-apps-outputs");
    detail.append(form, outputs);
    body.append(detail);

    // Management row (metadata edit, publish, hide, delete) — below the fold.
    const mgmt = el("div", "cmcp-apps-toolbar");
    const editBtn = makeBtn("✎ Edit info");
    const publishBtn = makeBtn(app.published ? "⇪ Update published" : "⇪ Publish", {
      title: "Share this app to the public registry (Explore tab). Hidden apps upload the run snapshot only — never the graph.",
    });
    const hideBtn = makeBtn(app.hideWorkflow ? "🔒 Workflow hidden" : "🔓 Hide workflow", {
      title:
        "Best effort: deletes the stored node graph so the app only carries the run snapshot. " +
        "A technical user can still intercept it — see the warning above.",
    });
    const delBtn = makeBtn("🗑 Delete", { danger: true });
    mgmt.append(editBtn, publishBtn, hideBtn, delBtn);
    detail.append(mgmt);

    publishBtn.addEventListener("click", async () => {
      if (!registry.configured) {
        window.alert(
          "No registry configured yet. The registry worker isn't deployed — set localStorage " +
            "“comfyui-mcp.panel.registryUrl” to a deployed instance to publish.",
        );
        return;
      }
      if (app.hideWorkflow) {
        const ok = window.confirm(
          "Publish “" + (app.name || "this app") + "” as a HIDDEN app?\n\n" +
            "Only the run snapshot is uploaded — never the node graph. This is best-effort " +
            "privacy, not security: anyone who runs the app can still intercept the prompt. Continue?",
        );
        if (!ok) return;
      }
      publishBtn.disabled = true;
      try {
        let creatorName = null;
        try { creatorName = localStorage.getItem("comfyui-mcp.panel.creatorName"); } catch {}
        if (!creatorName) {
          creatorName = window.prompt("Publish under what creator name?", "anonymous");
          if (creatorName === null) return;
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
        window.alert(`Publish failed: ${e.message}`);
        publishBtn.disabled = false;
      }
    });

    editBtn.addEventListener("click", async () => {
      const name = window.prompt("App name", app.name || "");
      if (name === null) return;
      const description = window.prompt("Description", app.description || "");
      if (description === null) return;
      await client.update(app.id, { manifest: { name: name.trim() || app.name, description } });
      await showDetail(app.id);
    });

    hideBtn.disabled = !!app.hideWorkflow;
    hideBtn.addEventListener("click", async () => {
      const ok = window.confirm(
        "Hide the workflow for “" + (app.name || "this app") + "”?\n\n" +
          "This DELETES the stored node graph — the app keeps only its run snapshot and can't be " +
          "edited as a workflow afterwards. This is best-effort privacy, not security: anyone who " +
          "runs the app can still intercept the prompt via ComfyUI's API.\n\nContinue?",
      );
      if (!ok) return;
      await client.update(app.id, { manifest: { hideWorkflow: true } });
      await showDetail(app.id);
    });

    delBtn.addEventListener("click", async () => {
      if (!window.confirm(`Delete “${app.name || "this app"}”? This can't be undone.`)) return;
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
      status.textContent = "Uploading image…";
      const ref = await uploadBlobToInput(f, f.name);
      if (!ref) throw new Error("image upload failed");
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
        throw new Error("pod image transfer needs a newer panel bridge — update the orchestrator");
      }
      const unique = `cmcp-app-${app.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}-${f.name}`;
      status.textContent = `Transferring ${f.name} to the pod…`;
      const res = await ctx.uploadMedia(f, unique);
      if (!res || res.ok === false) throw new Error((res && res.error) || "pod image transfer failed");
      return res.name;
    }

    async function runApp() {
      runBtn.disabled = true;
      runpodBtn.disabled = true;
      status.classList.remove("err");
      status.textContent = "Queueing…";
      outputs.textContent = "";
      try {
        const values = await collectValues(uploadImageLocal);
        const res = await client.run(app.id, values);
        const promptId = res.prompt_id;
        if (!promptId) throw new Error("queue returned no prompt_id");
        status.textContent = "Running…";
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
        const tick = async () => {
          if (closed) return resolve();
          try {
            const st = await client.runStatus(app.id, promptId);
            if (st.status === "done") {
              renderOutputs(st);
              return resolve();
            }
            status.textContent = st.status === "running" ? "Running…" : "Queued…";
          } catch (e) {
            status.textContent = e.message;
            status.classList.add("err");
            return resolve();
          }
          if (Date.now() > deadline) {
            status.textContent = "Timed out waiting for the run — it may still finish; check ComfyUI's queue.";
            status.classList.add("err");
            return resolve();
          }
          pollTimer = setTimeout(tick, 2000);
        };
        tick();
      });
    }

    function renderOutputs(st) {
      const detailStatus = st.status_detail || {};
      const msgs = detailStatus.messages || [];
      const failed = msgs.some((m) => Array.isArray(m) && m[0] === "execution_error");
      status.textContent = failed ? "Run failed — see ComfyUI for details." : "Done.";
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
        const media = [...(out.images || []), ...(out.gifs || [])];
        for (const ref of media) {
          const url = viewUrl(ref);
          const isVideo = /webm|mp4|mov|gif/i.test(ref.filename || "");
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
        outputs.append(el("div", "text-out", "Run finished with no visible outputs on the selected output nodes."));
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
     *  CivitAI version are pushed first (download_civitai_model is
     *  whitelisted); anything unpinned is reported, not silently skipped. */
    async function runOnPod() {
      status.classList.remove("err");
      if (!callTool) throw new Error("Orchestrator not connected — pod runs go through the bridge.");
      const target = typeof getRunpodTarget === "function" ? getRunpodTarget() : null;
      if (!target || target.is_local) {
        throw new Error("No pod connected — open the RunPod panel (cloud icon in the toolbar) to deploy or connect one first.");
      }
      runpodBtn.disabled = true;
      runBtn.disabled = true;
      try {
        status.textContent = "Preparing…";
        const values = await collectValues(uploadImageToPod);
        const dry = await client.run(app.id, values, { dry: true });
        const patched = dry.prompt;
        if (!patched) throw new Error("couldn't build the prompt snapshot");

        // Dependency push (best effort, CivitAI-pinned models only).
        const models = Array.isArray(app.deps?.models) ? app.deps.models : [];
        const pinned = models.filter((m) => m && m.civitaiVersionId);
        const unpinned = models.filter((m) => m && !m.civitaiVersionId);
        const custom = Array.isArray(app.deps?.customNodes) ? app.deps.customNodes : [];
        for (const m of pinned) {
          status.textContent = `Pushing model to pod: ${m.name}…`;
          const res = await callTool("download_civitai_model", {
            model_version_id: m.civitaiVersionId,
            target_subfolder: m.targetSubfolder || "checkpoints",
          });
          const text = toolText(res);
          if (res && res.ok === false) throw new Error(`model push failed (${m.name}): ${text}`);
        }

        status.textContent = "Queueing on pod…";
        const res = await callTool("enqueue_workflow", {
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
        if (promptId) notes.push(`queued on pod (prompt_id ${promptId})`);
        else notes.push(text || "queued on pod");
        if (unpinned.length) notes.push(`⚠ unpinned models the pod must already have: ${unpinned.map((m) => m.name).join(", ")}`);
        if (custom.length) notes.push(`⚠ custom nodes the pod must already have: ${custom.join(", ")}`);
        notes.push("Progress: watch ComfyUI's queue — pod history isn't mirrored back here.");
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
    const back = makeBtn("← My Apps");
    back.addEventListener("click", () => showGrid().catch(showError));
    bar.append(back);
    body.append(bar, el("div", "cmcp-apps-empty", e && e.message ? e.message : String(e)));
  }

  document.body.appendChild(overlay);
  showGrid().catch(showError);

  return {
    close,
    isOpen: () => !closed,
    update: () => {},
    el: overlay,
  };
}
