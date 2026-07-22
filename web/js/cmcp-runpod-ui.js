// RunPod control panel — the in-panel modal for the first-party RunPod backend.
//
// Renders the live pod status (broadcast by the orchestrator's runpod-watch as
// `runpod_status` frames) and the honest host indicator (`comfyui_target`), and
// drives the pod lifecycle + the local⇄pod switch through the whitelisted
// runpod_* tools over the bridge's callTool (no agent turn needed):
//   deploy → connect → render on the pod → stop → back to local → reconnect.
//
// The pod runs OUR template, so once connected the agent installs the user's
// exact custom nodes / LoRAs and downloads models → full canvas parity remotely.
//
// ctx (from the panel monolith):
//   root        — element to mount the overlay into
//   callTool    — (tool, args, opts) => Promise<tool_result frame>
//   getStatus   — () => last runpod_status frame (or null)
//   getTarget   — () => last comfyui_target frame (or null)
//   openUrl     — (url) => void  (open a link in a new tab)
//
// Pod control inspired by gpu-cli.sh (https://gpu-cli.sh) — a cloud-GPU CLI
// worth checking out; this backend is our own (runs the user's real canvas).

const GPU_CLI_URL = "https://gpu-cli.sh";

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
.cmcp-rp-modal{max-width:min(480px,92vw)!important;width:auto;}
.cmcp-rp-body{display:flex;flex-direction:column;gap:0.75rem;min-width:min(440px,90vw);max-width:520px;}
.cmcp-rp-host{display:flex;align-items:center;gap:0.5rem;padding:0.55rem 0.7rem;border-radius:8px;
  font-size:0.85rem;font-weight:600;border:1px solid var(--p-content-border-color,#3f3f46);}
.cmcp-rp-host.local{background:rgba(34,197,94,0.10);color:#22c55e;border-color:rgba(34,197,94,0.35);}
.cmcp-rp-host.pod{background:rgba(59,130,246,0.12);color:#60a5fa;border-color:rgba(59,130,246,0.40);}
.cmcp-rp-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:0 0 auto;}
.cmcp-rp-card{border:1px solid var(--p-content-border-color,#3f3f46);border-radius:8px;padding:0.7rem;
  display:flex;flex-direction:column;gap:0.35rem;font-size:0.82rem;}
.cmcp-rp-row{display:flex;justify-content:space-between;gap:0.75rem;}
.cmcp-rp-row .k{opacity:0.6;}
.cmcp-rp-row .v{font-variant-numeric:tabular-nums;text-align:right;}
.cmcp-rp-warn{color:#f59e0b;}
.cmcp-rp-actions{display:flex;flex-wrap:wrap;gap:0.4rem;}
.cmcp-rp-actions .cmcp-btn{flex:1 1 auto;min-width:96px;}
.cmcp-rp-connect{display:flex;gap:0.4rem;}
.cmcp-rp-connect input,.cmcp-rp-podselect{flex:1 1 auto;min-width:0;padding:0.4rem 0.55rem;border-radius:6px;
  border:1px solid var(--p-content-border-color,#3f3f46);background:var(--p-inputtext-background,#18181b);
  color:inherit;font-size:0.82rem;}
.cmcp-rp-connect input{font-family:ui-monospace,monospace;}
.cmcp-rp-podselect{cursor:pointer;}
.cmcp-rp-refresh{flex:0 0 auto;min-width:auto;padding:0.4rem 0.6rem;}
.cmcp-rp-log{font-size:0.78rem;opacity:0.85;min-height:1.1em;white-space:pre-wrap;word-break:break-word;}
.cmcp-rp-log.busy{opacity:0.6;}
.cmcp-rp-log.err{color:#f87171;}
.cmcp-rp-credit{font-size:0.7rem;opacity:0.5;}
.cmcp-rp-credit a{color:inherit;}
.cmcp-rp-muted{font-size:0.75rem;opacity:0.6;}
/* Agent-drive/manual side-dock (parity with the CivitAI + Training modals):
   anchor the card to the canvas side OPPOSITE the Agent pane, drop the backdrop,
   let clicks pass THROUGH the overlay so chat stays interactive; only the card
   catches pointer events. Bumped above the canvas (z 10000) to match. Slides in
   via translateX; the close() path reverses it before detaching. The base
   .cmcp-modal-overlay (panel monolith CSS, always loaded) styles the centered
   fallback — this only overrides the docked case, so centered opens are
   unchanged. */
.cmcp-modal-overlay.cmcp-docked{position:fixed;display:block;padding:0;background:transparent;
  pointer-events:none;z-index:10000;}
.cmcp-modal-overlay.cmcp-docked .cmcp-rp-modal{position:fixed;pointer-events:auto;
  width:auto;max-width:none!important;height:auto;max-height:none;overflow-y:auto;
  border-radius:0;box-shadow:-8px 0 32px rgba(0,0,0,.45);
  transform:translateX(24px);opacity:0;transition:transform .28s ease,opacity .28s ease;}
.cmcp-modal-overlay.cmcp-docked.cmcp-dock-in .cmcp-rp-modal{transform:translateX(0);opacity:1;}
`;
  const el = document.createElement("style");
  el.textContent = css;
  // The overlay mounts on document.body (see openRunpodModal), which is OUTSIDE
  // any panel ShadowRoot — so the CSS must live in document.head, not the shadow
  // root, or shadow-DOM hosts would render the modal unstyled. Inject into head
  // unconditionally.
  document.head.appendChild(el);
}

/** Pull human text out of a tool_result frame (result = MCP content array). */
function toolText(res) {
  if (!res) return "";
  if (res.error) return String(res.error);
  const r = res.result;
  if (Array.isArray(r)) return r.map((c) => (c && c.text) || "").join("");
  if (r && Array.isArray(r.content)) return r.content.map((c) => (c && c.text) || "").join("");
  if (typeof r === "string") return r;
  return res.ok === false ? "The action failed." : "Done.";
}

function fmtUptime(sec) {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtCountdown(sec) {
  if (sec == null) return null;
  if (sec <= 0) return "now";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function openRunpodModal(ctx, opts = {}) {
  const { root, callTool, getStatus, getTarget, openUrl } = ctx;
  injectStyle();

  const overlay = document.createElement("div");
  overlay.className = "cmcp-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "cmcp-modal cmcp-rp-modal";
  const title = document.createElement("div");
  title.className = "cmcp-modal-title";
  title.textContent = "RunPod — cloud GPU for this session";

  const body = document.createElement("div");
  body.className = "cmcp-rp-body";

  // Host indicator (honest: where renders run right now).
  const host = document.createElement("div");
  host.className = "cmcp-rp-host";
  const hostDot = document.createElement("span");
  hostDot.className = "cmcp-rp-dot";
  const hostText = document.createElement("span");
  host.append(hostDot, hostText);

  // Live pod status card.
  const card = document.createElement("div");
  card.className = "cmcp-rp-card";

  // Pod picker row: a dropdown of the account's pods (humans pick by name, not id),
  // with a manual-ID fallback + a refresh. Populated from runpod_list_pods.
  const connectRow = document.createElement("div");
  connectRow.className = "cmcp-rp-connect";
  const podSelect = document.createElement("select");
  podSelect.className = "cmcp-rp-podselect";
  podSelect.append(new Option("Loading pods…", ""));
  const refreshBtn = mkBtn("↻");
  refreshBtn.title = "Refresh pod list";
  refreshBtn.classList.add("cmcp-rp-refresh");
  const connectBtn = mkBtn("Connect", "primary");
  connectRow.append(podSelect, refreshBtn, connectBtn);

  // Manual-ID row (hidden unless "paste a pod ID…" is chosen in the dropdown).
  const manualRow = document.createElement("div");
  manualRow.className = "cmcp-rp-connect";
  manualRow.style.display = "none";
  const podInput = document.createElement("input");
  podInput.type = "text";
  podInput.placeholder = "paste pod id (from console.runpod.io)";
  podInput.spellcheck = false;
  manualRow.append(podInput);
  // Enter in the manual-ID field connects, matching the primary button.
  podInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      connectBtn.click();
    }
  });
  podSelect.addEventListener("change", () => {
    manualRow.style.display = podSelect.value === "__manual__" ? "flex" : "none";
    if (podSelect.value === "__manual__") podInput.focus();
  });

  // Action buttons.
  const actions = document.createElement("div");
  actions.className = "cmcp-rp-actions";
  const startBtn = mkBtn("Start");
  const stopBtn = mkBtn("Stop");
  const localBtn = mkBtn("Use Local");
  const deployBtn = mkBtn("Deploy new pod", "primary");
  actions.append(startBtn, stopBtn, localBtn, deployBtn);

  const linkRow = document.createElement("div");
  linkRow.className = "cmcp-rp-muted";
  const linkBtn = document.createElement("a");
  linkBtn.href = "#";
  linkBtn.textContent = "New RunPod user? Open the deploy link (supports the project via referral) ↗";
  linkBtn.style.color = "inherit";
  linkRow.append(linkBtn);

  const log = document.createElement("div");
  log.className = "cmcp-rp-log";

  const credit = document.createElement("div");
  credit.className = "cmcp-rp-credit";
  credit.innerHTML = `Pod control inspired by <a href="${GPU_CLI_URL}" target="_blank" rel="noopener">gpu-cli.sh</a>.`;

  const btnRow = document.createElement("div");
  btnRow.className = "cmcp-modal-btns";
  const doneBtn = mkBtn("Close", "primary");
  btnRow.append(doneBtn);

  body.append(host, card, connectRow, manualRow, actions, linkRow, log, credit);
  modal.append(title, body, btnRow);
  overlay.append(modal);
  // Mount the overlay on <body>, NOT the panel root: the ComfyUI sidebar clips
  // its descendants, so a root-mounted overlay would be squeezed into the narrow
  // panel (buttons + status values cut off). On body it's a true viewport-centered
  // modal at its full width.
  document.body.appendChild(overlay);

  // ── state + rendering ──────────────────────────────────────────────────────
  let busy = false;
  let closed = false;
  let tick = null;
  let _onDockResize = null; // window-resize fallback when ctx.watchDock is absent
  let _dockDispose = null;  // ResizeObserver+listener disposer from ctx.watchDock

  // ── docked mode (parity with the CivitAI + Training modals) ──────────────────
  // Geometry from the host (ctx.dockGeometry owns pane/canvas measurement +
  // left/right detection); three states detached(hide)/centered/docked. See the
  // CivitAI modal for the full rationale. When opts.dock is unset this is inert
  // and the modal stays the plain centered overlay it always was.
  applyDock.centered = false;
  function applyDock() {
    if (!opts.dock) { setCentered(); return; }
    const geo = _dockGeometry();
    if (geo && geo.status === "detached") { overlay.style.display = "none"; return; }
    overlay.style.display = "";
    if (geo && geo.status === "docked" && window.innerWidth >= 900) {
      overlay.classList.add("cmcp-docked");
      modal.style.left = `${Math.round(geo.left)}px`;
      modal.style.top = `${Math.round(geo.top)}px`;
      modal.style.right = `${Math.round(geo.right)}px`;
      modal.style.bottom = `${Math.round(geo.bottom)}px`;
      applyDock.centered = false;
    } else { setCentered(); }
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
    if (typeof ctx.watchDock === "function") {
      try { _dockDispose = ctx.watchDock(applyDock); } catch { _dockDispose = null; }
    }
    if (!_dockDispose) { _onDockResize = () => applyDock(); window.addEventListener("resize", _onDockResize); }
    // Slide-in on the next frame so the transition runs from the initial state.
    requestAnimationFrame(() => overlay.classList.add("cmcp-dock-in"));
  }

  function setLog(text, kind) {
    log.textContent = text || "";
    log.className = "cmcp-rp-log" + (kind ? " " + kind : "");
  }

  // The pod a lifecycle action targets: the one being watched (connected), else
  // the dropdown selection, else a manually-pasted id.
  function selectedPodId() {
    if (podSelect.value === "__manual__") return podInput.value.trim() || null;
    return podSelect.value || null;
  }
  function currentPodId() {
    const s = getStatus?.();
    return (s && s.watching && s.pod_id) || selectedPodId();
  }
  // The pod currently being watched (connected), or null. Stop targets ONLY this
  // one: Stop is enabled solely for a watched RUNNING pod, so it must never fall
  // back to a different pod the user merely typed/selected in the dropdown.
  function watchedPodId() {
    const s = getStatus?.();
    return (s && s.watching && s.pod_id) || null;
  }

  // Populate the dropdown from runpod_list_pods (humans pick by name, not id).
  async function loadPods(preselect) {
    try {
      const res = await callTool("runpod_list_pods", {});
      const txt = toolText(res);
      const rows = [];
      const re = /\*\*(.+?)\*\*\s*`([a-z0-9]+)`\s*—\s*(\S+)([^\n]*)/gi;
      let m;
      while ((m = re.exec(txt))) {
        const gpu = (m[4].match(/·\s*([^·$]+?)(?:\s*·|\s*$)/) || [])[1];
        rows.push({ name: m[1].trim(), id: m[2], status: m[3], gpu: gpu ? gpu.trim() : "" });
      }
      const want = preselect || selectedPodId();
      podSelect.innerHTML = "";
      podSelect.append(new Option(rows.length ? "— select a pod —" : "no pods yet — deploy one below", ""));
      for (const r of rows) {
        podSelect.append(new Option(`${r.name} — ${r.status}${r.gpu ? " · " + r.gpu : ""}`, r.id));
      }
      podSelect.append(new Option("＋ paste a pod ID…", "__manual__"));
      if (want && rows.some((r) => r.id === want)) podSelect.value = want;
      else if (rows.length === 1) podSelect.value = rows[0].id;
    } catch (err) {
      podSelect.innerHTML = "";
      podSelect.append(new Option("couldn't list pods", ""));
      podSelect.append(new Option("＋ paste a pod ID…", "__manual__"));
    }
    manualRow.style.display = podSelect.value === "__manual__" ? "flex" : "none";
  }
  refreshBtn.addEventListener("click", () => loadPods());

  function render() {
    if (closed) return;
    const s = getStatus?.() || null;
    const t = getTarget?.() || null;
    // Honesty: only claim "on pod" when the orchestrator's comfyui_target frame
    // actually says so. Without a target frame the render destination is unknown
    // — and runpod_watch broadcasts pod status WITHOUT retargeting, so a watched
    // RUNNING pod does NOT mean renders go there. Default to local when unknown.
    const onPod = !!(t && !t.is_local);

    // Host banner.
    host.classList.toggle("local", !onPod);
    host.classList.toggle("pod", onPod);
    if (onPod && s && s.watching) {
      const bits = [s.name || s.pod_id || "RunPod pod"];
      if (s.gpu) bits.push(s.gpu);
      if (s.cost_per_hr != null) bits.push(`$${Number(s.cost_per_hr).toFixed(3)}/hr`);
      hostText.textContent = "Rendering on RunPod · " + bits.join(" · ");
    } else if (onPod) {
      hostText.textContent = "Rendering on a remote pod";
    } else {
      hostText.textContent = "Rendering locally · this machine";
    }

    // Status card.
    card.innerHTML = "";
    if (s && s.watching && s.pod_id) {
      addRow(card, "Pod", `${s.name || "(unnamed)"}  ${s.pod_id}`);
      addRow(card, "Status", s.status || "—");
      if (s.gpu) addRow(card, "GPU", s.gpu);
      if (s.cost_per_hr != null) addRow(card, "Cost", `$${Number(s.cost_per_hr).toFixed(3)}/hr`);
      if (s.uptime_seconds != null) addRow(card, "Uptime", fmtUptime(s.uptime_seconds));
      if (s.gpu_util != null) addRow(card, "GPU / VRAM", `${s.gpu_util}% / ${s.vram_util ?? "—"}%`);
      if (s.comfyui_url) addRow(card, "ComfyUI", s.comfyui_url, true);
      const cd = fmtCountdown(s.autostop_in_seconds);
      if (cd && s.autostop_minutes) {
        addRow(card, "Auto-stop", `idle — stops in ${cd}`, false, "cmcp-rp-warn");
      } else if (s.autostop_minutes) {
        addRow(card, "Auto-stop", `after ${s.autostop_minutes}m idle`);
      }
    } else {
      const empty = document.createElement("div");
      empty.className = "cmcp-rp-muted";
      empty.textContent =
        "No pod being watched. Deploy a new pod, or paste a pod ID and Connect. " +
        "The pod runs our template, so the agent can set up your exact nodes, LoRAs and models on it.";
      card.append(empty);
    }

    // Button enablement.
    const running = !!(s && s.watching && s.status === "RUNNING");
    const haveWatched = !!(s && s.watching && s.pod_id);
    startBtn.disabled = busy || (haveWatched && running);
    stopBtn.disabled = busy || !running;
    localBtn.disabled = busy || !onPod;
    deployBtn.disabled = busy;
    connectBtn.disabled = busy;
  }

  // Re-render the idle countdown every second while a status frame is live.
  tick = setInterval(() => {
    const s = getStatus?.();
    if (s && s.watching && s.autostop_in_seconds != null) render();
  }, 1000);

  async function run(label, fn) {
    if (busy) return false;
    busy = true;
    render();
    setLog(label + "…", "busy");
    let ok = false;
    try {
      const res = await fn();
      if (closed) return false;
      const txt = toolText(res);
      ok = !(res && res.ok === false);
      setLog(txt, ok ? "" : "err");
    } catch (err) {
      if (!closed) setLog((err && err.message) || String(err), "err");
    } finally {
      busy = false;
      if (!closed) render();
    }
    return ok;
  }

  connectBtn.addEventListener("click", () => {
    const id = selectedPodId();
    if (!id) {
      setLog("Pick a pod from the list first (or deploy a new one).", "err");
      return;
    }
    run("Connecting to " + id, () => callTool("runpod_pod_connect", { pod_id: id }));
  });
  startBtn.addEventListener("click", () => {
    const id = currentPodId();
    if (!id) {
      setLog("No pod selected — paste a pod ID, or Deploy a new one.", "err");
      return;
    }
    run("Starting " + id, () => callTool("runpod_pod_start", { pod_id: id }));
  });
  stopBtn.addEventListener("click", () => {
    const id = watchedPodId();
    if (!id) return;
    run("Stopping " + id, () => callTool("runpod_pod_stop", { pod_id: id }));
  });
  localBtn.addEventListener("click", () => {
    run("Switching to local ComfyUI", () => callTool("runpod_use_local", {}));
  });
  // Confirm must be two DISTINCT human decisions, not one gesture. Arming opens
  // a short cool-down that ignores confirm clicks (rapid double-click), and a
  // keydown guard suppresses held-key autorepeat entirely — a held Enter fires
  // repeated click events, and time-elapsed alone would let one through once the
  // cool-down passes. A fresh discrete click, or a fresh Enter/Space keypress
  // (repeat=false), after the cool-down still confirms.
  const DEPLOY_ARM_COOLDOWN_MS = 600;
  let deployArmedAt = 0;
  let deployArmGen = 0; // bumped each arming so a stale disarm timer is inert
  // Swallow the activation an auto-repeating Enter/Space would synthesize, so a
  // held key can never produce the confirming click. Discrete presses pass.
  deployBtn.addEventListener("keydown", (e) => {
    if (e.repeat && (e.key === "Enter" || e.key === " " || e.key === "Spacebar")) {
      e.preventDefault();
    }
  });
  deployBtn.addEventListener("click", () => {
    // Deploying bills GPU-time immediately — confirm once inline.
    if (deployBtn.dataset.armed !== "1") {
      deployBtn.dataset.armed = "1";
      deployArmedAt = Date.now();
      const gen = ++deployArmGen;
      deployBtn.textContent = "Deploy — this bills. Click to confirm";
      setLog("A new pod bills per running GPU-second (~$0.30–0.70/hr). It idle-auto-stops; Stop ends GPU billing (disk storage still bills until you terminate the pod in the console).", "");
      setTimeout(() => {
        // Only disarm the arming that scheduled this timer — a newer arm (e.g.
        // after a deploy completes and re-arms) must not be cleared by an old one.
        if (deployBtn.dataset.armed === "1" && deployArmGen === gen) {
          deployBtn.dataset.armed = "0";
          deployBtn.textContent = "Deploy new pod";
        }
      }, 5000);
      return;
    }
    // Ignore a confirm that lands inside the cool-down (a double-click is not a
    // second human decision). Keep it armed so a real click still works.
    if (Date.now() - deployArmedAt < DEPLOY_ARM_COOLDOWN_MS) return;
    deployArmGen++; // invalidate the pending disarm timer for this arming
    deployBtn.dataset.armed = "0";
    deployBtn.textContent = "Deploy new pod";
    run("Deploying a new pod", () => callTool("runpod_pod_create", {}, { timeout: 120000 })).then((ok) => {
      if (ok) loadPods(); // show the new pod in the dropdown
    });
  });
  linkBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      const res = await callTool("runpod_deploy_link", {});
      const txt = toolText(res);
      const m = txt.match(/https?:\/\/console\.runpod\.io\/deploy\S+/);
      if (m && openUrl) openUrl(m[0]);
      else if (m) window.open(m[0], "_blank", "noopener");
      else setLog(txt, "");
    } catch (err) {
      setLog((err && err.message) || String(err), "err");
    }
  });

  const close = () => {
    if (closed) return; // idempotent
    closed = true;
    if (tick) { clearInterval(tick); tick = null; }
    if (_onDockResize) { window.removeEventListener("resize", _onDockResize); _onDockResize = null; }
    if (_dockDispose) { try { _dockDispose(); } catch { /* best effort */ } _dockDispose = null; }
    slideOutThenRemove(overlay);
  };
  doneBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  // Load the pod dropdown on open, preselecting the watched pod (or opts.pod_id).
  const s0 = getStatus?.();
  void loadPods((s0 && s0.watching && s0.pod_id) || opts.pod_id);

  render();

  return {
    close,
    /** Called by the panel when a new runpod_status / comfyui_target frame arrives. */
    update() {
      render();
    },
    isOpen: () => !closed,
  };
}

/** Slide/fade the panel out before detaching (parity across the three
 *  side-panels). Docked: reverse the translateX slide-in (drop cmcp-dock-in);
 *  centered/narrow: a plain opacity fade — no horizontal slide. The DOM is
 *  removed after the transition window (jsdom fires no transitionend, so a fixed
 *  timer drives it). Idempotent — remove() on a detached node is a no-op. */
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

function mkBtn(label, variant) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cmcp-btn" + (variant === "primary" ? " cmcp-btn-primary" : "");
  b.textContent = label;
  return b;
}
function addRow(parent, k, v, mono, vClass) {
  const row = document.createElement("div");
  row.className = "cmcp-rp-row";
  const kk = document.createElement("span");
  kk.className = "k";
  kk.textContent = k;
  const vv = document.createElement("span");
  vv.className = "v" + (vClass ? " " + vClass : "");
  if (mono) vv.style.fontFamily = "ui-monospace,monospace";
  vv.textContent = v;
  row.append(kk, vv);
  parent.append(row);
}
