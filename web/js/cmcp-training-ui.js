// LoRA Training modal — a navigable COMING-SOON preview, parity with the
// mobile app's Training tab. Everything is intentionally inert placeholder
// UI: six training flows as cards (base-model dropdown + description), all
// badged "Coming soon", under a Local/Cloud switch previewing the two
// backends we plan to support (this rig vs a RunPod pod managed headlessly by
// our own trainer, built by decoding how Ostris' AI Toolkit drives the
// process). Same overlay treatment as the CivitAI browser modal.

let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .cmcp-tr-modal { max-width: 860px; width: min(92vw, 860px); }
    .cmcp-tr-head { display:flex; align-items:center; gap:.75rem; padding:1rem 1.25rem .5rem; }
    .cmcp-tr-head h2 { margin:0; font-size:1.05rem; flex:1; }
    .cmcp-tr-close { background:none; border:none; color:inherit; cursor:pointer; font-size:1.1rem; opacity:.7; }
    .cmcp-tr-close:hover { opacity:1; }
    .cmcp-tr-seg { display:flex; gap:0; margin:0 1.25rem .75rem; border:1px solid var(--p-surface-500,#555); border-radius:999px; overflow:hidden; width:fit-content; }
    .cmcp-tr-seg button { border:none; background:transparent; color:inherit; padding:.4rem .9rem; cursor:pointer; font-size:.85rem; display:flex; align-items:center; gap:.4rem; }
    .cmcp-tr-seg button.active { background: var(--p-surface-700,#3f3f46); }
    .cmcp-tr-token { margin:0 1.25rem .75rem; display:flex; flex-direction:column; gap:.25rem; }
    .cmcp-tr-token input { background:var(--p-surface-800,#27272a); border:1px solid var(--p-surface-600,#52525b); border-radius:8px; padding:.5rem .75rem; color:inherit; opacity:.55; }
    .cmcp-tr-token small { opacity:.6; }
    .cmcp-tr-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:.75rem; padding:0 1.25rem 1rem; }
    @media (max-width: 640px) { .cmcp-tr-grid { grid-template-columns:repeat(2,1fr); } }
    .cmcp-tr-card { background:var(--p-surface-800,#27272a); border:1px solid var(--p-surface-600,#3f3f46); border-radius:12px; padding:.75rem; display:flex; flex-direction:column; gap:.45rem; }
    .cmcp-tr-icon { aspect-ratio:1.6; border-radius:10px; background:color-mix(in srgb, currentColor 8%, transparent); display:flex; align-items:center; justify-content:center; font-size:1.6rem; opacity:.8; }
    .cmcp-tr-card select { background:var(--p-surface-900,#18181b); color:inherit; border:1px solid var(--p-surface-600,#52525b); border-radius:6px; padding:.25rem .4rem; font-size:.8rem; width:100%; }
    .cmcp-tr-card h3 { margin:0; font-size:.9rem; }
    .cmcp-tr-card p { margin:0; font-size:.78rem; opacity:.65; line-height:1.35; flex:1; }
    .cmcp-tr-badge { align-self:flex-start; font-size:.72rem; padding:.1rem .5rem; border-radius:999px; background:color-mix(in srgb, currentColor 10%, transparent); opacity:.75; }
    .cmcp-tr-foot { padding:0 1.25rem 1rem; font-size:.8rem; opacity:.55; }
  `;
  document.head.appendChild(style);
}

const FLOWS = [
  { title: "Image Character", icon: "pi-user", models: ["Krea2", "Flux2", "ZImg"], desc: "Train a person or character into an image model." },
  { title: "Image Edit", icon: "pi-pencil", models: ["Qwen Edit 2509"], desc: "Teach an edit model your custom transformation." },
  { title: "Image Style", icon: "pi-palette", models: ["Krea2", "Flux2", "ZImg"], desc: "Capture an art style you can apply to any prompt." },
  { title: "Image Slider", icon: "pi-sliders-h", models: ["Krea2", "Flux2", "ZImg"], desc: "A concept slider with adjustable strength." },
  { title: "Video Character", icon: "pi-video", models: ["LTX 2.3", "Wan 2.2"], desc: "Bring a character into video generation." },
  { title: "Video Action", icon: "pi-forward", models: ["LTX 2.3", "Wan 2.2"], desc: "Teach a motion or action to a video model." },
];

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

export function openTrainingModal(ctx = {}) {
  injectCss();
  const overlay = document.createElement("div");
  overlay.className = "cmcp-cv-overlay";
  const modal = document.createElement("div");
  modal.className = "cmcp-modal cmcp-tr-modal";
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  const head = document.createElement("div");
  head.className = "cmcp-tr-head";
  const title = document.createElement("h2");
  title.textContent = "LoRA Training";
  const badge = document.createElement("span");
  badge.className = "cmcp-tr-badge";
  badge.textContent = "Coming soon";
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmcp-tr-close";
  closeBtn.innerHTML = "&#10005;";
  closeBtn.title = "Close";
  closeBtn.onclick = close;
  head.append(title, badge, closeBtn);

  // Local / Cloud switch — cosmetic for now; Local shows the REAL GPU.
  const seg = document.createElement("div");
  seg.className = "cmcp-tr-seg";
  const localBtn = document.createElement("button");
  localBtn.className = "active";
  localBtn.textContent = "Local (your rig)";
  const cloudBtn = document.createElement("button");
  cloudBtn.textContent = "Cloud (RunPod)";
  seg.append(localBtn, cloudBtn);
  fetchGpuLabel(ctx.api).then((gpu) => {
    if (gpu) localBtn.textContent = `Local (${gpu})`;
  });

  const token = document.createElement("div");
  token.className = "cmcp-tr-token";
  token.hidden = true;
  const tokenInput = document.createElement("input");
  tokenInput.type = "password";
  tokenInput.placeholder = "RunPod API token";
  tokenInput.disabled = true;
  const tokenNote = document.createElement("small");
  tokenNote.textContent = "Coming soon — pods and training runs managed for you, headlessly.";
  token.append(tokenInput, tokenNote);

  localBtn.onclick = () => { localBtn.classList.add("active"); cloudBtn.classList.remove("active"); token.hidden = true; };
  cloudBtn.onclick = () => { cloudBtn.classList.add("active"); localBtn.classList.remove("active"); token.hidden = false; };

  const grid = document.createElement("div");
  grid.className = "cmcp-tr-grid";
  for (const f of FLOWS) {
    const card = document.createElement("div");
    card.className = "cmcp-tr-card";
    const icon = document.createElement("div");
    icon.className = "cmcp-tr-icon";
    const i = document.createElement("i");
    i.className = `pi ${f.icon}`;
    icon.appendChild(i);
    const select = document.createElement("select");
    for (const m of f.models) {
      const o = document.createElement("option");
      o.textContent = m;
      select.appendChild(o);
    }
    const h = document.createElement("h3");
    h.textContent = f.title;
    const p = document.createElement("p");
    p.textContent = f.desc;
    const b = document.createElement("span");
    b.className = "cmcp-tr-badge";
    b.textContent = "Coming soon";
    card.append(icon, select, h, p, b);
    grid.appendChild(card);
  }

  const foot = document.createElement("div");
  foot.className = "cmcp-tr-foot";
  foot.textContent = "LoRA training is on the roadmap — nothing here works yet.";

  modal.append(head, seg, token, grid, foot);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  return { close };
}
