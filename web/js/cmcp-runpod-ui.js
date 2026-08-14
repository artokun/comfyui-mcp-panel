// RunPod control panel — the in-panel modal for the first-party RunPod backend.
//
// Renders the live pod status (broadcast by the orchestrator's runpod-watch as
// `runpod_status` frames) and the honest host indicator (`comfyui_target`), and
// drives the pod lifecycle + the local⇄pod switch through the whitelisted
// `runpod` tool over the bridge's callTool, with no agent turn needed:
//   deploy → connect → render on the pod → stop → back to local → reconnect.
//
// 0.50.0 slice 8 folded eleven runpod_* tools into two action-parameterized
// names: `runpod` (create/start/stop/status/list/connect/use_local/deploy_link)
// and `runpod_watch` (watch/unwatch/troubleshoot). Every call below therefore
// passes an `action` — the tool name alone no longer says what it does, and a
// call with the name but no action is refused server-side rather than defaulted.
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

import { isImeComposing } from "./lib/ime.js";
import { tr } from "./lib/i18n.js";

const GPU_CLI_URL = "https://gpu-cli.sh";

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const css = `
.cmcp-rp-modal{max-width:min(480px,92vw)!important;width:auto;}
.cmcp-rp-body{display:flex;flex-direction:column;gap:0.75rem;min-width:min(440px,90vw);max-width:520px;}
.cmcp-rp-host{display:flex;align-items:center;gap:0.5rem;padding:0.55rem 0.7rem;border-radius:8px;
  font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0462);font-weight:600;border:1px solid var(--p-content-border-color,#3f3f46);}
.cmcp-rp-host.local{background:rgba(34,197,94,0.10);color:#22c55e;border-color:rgba(34,197,94,0.35);}
.cmcp-rp-host.pod{background:rgba(59,130,246,0.12);color:#60a5fa;border-color:rgba(59,130,246,0.40);}
.cmcp-rp-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:0 0 auto;}
.cmcp-rp-card{border:1px solid var(--p-content-border-color,#3f3f46);border-radius:8px;padding:0.7rem;
  display:flex;flex-direction:column;gap:0.35rem;font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0092);}
.cmcp-rp-row{display:flex;justify-content:space-between;gap:0.75rem;}
.cmcp-rp-row .k{opacity:0.6;}
.cmcp-rp-row .v{font-variant-numeric:tabular-nums;text-align:right;}
.cmcp-rp-warn{color:#f59e0b;}
.cmcp-rp-actions{display:flex;flex-wrap:wrap;gap:0.4rem;}
.cmcp-rp-actions .cmcp-btn{flex:1 1 auto;min-width:96px;}
.cmcp-rp-connect{display:flex;gap:0.4rem;}
.cmcp-rp-connect input,.cmcp-rp-podselect{flex:1 1 auto;min-width:0;padding:0.4rem 0.55rem;border-radius:6px;
  border:1px solid var(--p-content-border-color,#3f3f46);background:var(--p-inputtext-background,#18181b);
  color:inherit;font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0092);}
.cmcp-rp-connect input{font-family:ui-monospace,monospace;}
.cmcp-rp-podselect{cursor:pointer;}
.cmcp-rp-refresh{flex:0 0 auto;min-width:auto;padding:0.4rem 0.6rem;}
.cmcp-rp-log{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.96);opacity:0.85;min-height:1.1em;white-space:pre-wrap;word-break:break-word;}
.cmcp-rp-log.busy{opacity:0.6;}
.cmcp-rp-log.err{color:#f87171;}
.cmcp-rp-credit{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.8615);opacity:0.5;}
.cmcp-rp-credit a{color:inherit;}
.cmcp-rp-muted{font-size:calc(var(--cmcp-fs, 0.8125rem) * 0.9231);opacity:0.6;}
/* The unified side-panel shell (cmcp-sidepanel-ui.js) owns the overlay + dock +
   slide; the Local tab centers this body in the shared card. */
.cmcp-rp-title{font-weight:600;font-size:calc(var(--cmcp-fs, 0.8125rem) * 1.0462);}
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
  // Only reached when the frame carried no text of its own; the tool's own prose is
  // the orchestrator's to translate, these two are ours.
  return res.ok === false
    ? tr("runpod_ui.the_action_failed", "The action failed.")
    : tr("runpod_ui.done", "Done.");
}

/**
 * Durations are built from SINGLE-unit pieces, each pluralised on its own `count`,
 * and then joined by a translatable pattern.
 *
 * A combined "{hours}h {minutes}m" key cannot be pluralised at all: `tr` carries one
 * `count` per string, and that string has two numbers. Splitting gives every unit the
 * plural category its language actually uses — Russian needs 1 минута / 2 минуты /
 * 5 минут, which no shared form covers — while `duration_pair` still lets a
 * translation reorder or re-punctuate the pair.
 *
 * The English `one` and `other` forms are identical because "h"/"m"/"s" are
 * abbreviations that do not inflect. They are still written out as a plural pair so a
 * translator who spells the unit out has both forms to fill in; collapsing them to a
 * plain string would silently deny that.
 */
const hoursText = (n) => tr("runpod_ui.duration_hours", { one: "{count}h", other: "{count}h" }, { count: n });
const minutesText = (n) => tr("runpod_ui.duration_minutes", { one: "{count}m", other: "{count}m" }, { count: n });
const secondsText = (n) => tr("runpod_ui.duration_seconds", { one: "{count}s", other: "{count}s" }, { count: n });
const joinDuration = (first, second) => tr("runpod_ui.duration_pair", "{first} {second}", { first, second });

function fmtUptime(sec) {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? joinDuration(hoursText(h), minutesText(m)) : minutesText(m);
}
function fmtCountdown(sec) {
  if (sec == null) return null;
  if (sec <= 0) return tr("runpod_ui.now", "now");
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? joinDuration(minutesText(m), secondsText(s)) : secondsText(s);
}

/**
 * "$0.690/hr". The currency symbol and the three-decimal format are deliberately NOT
 * translated: RunPod bills in USD and quotes three decimals, so re-rendering that as a
 * local currency or a local decimal separator would misstate what the user is charged.
 * Only the "per hour" unit is translatable.
 */
function fmtCost(perHr) {
  return tr("runpod_ui.cost_per_hour", "${cost}/hr", { cost: Number(perHr).toFixed(3) });
}

/** Content-provider factory for the Local/RunPod tab of the unified side panel.
 *  The shell owns the overlay/dock/close; this builds the centered control body.
 *  hasSearch:false, drive:null; update() re-renders on runpod_status frames. */
export function createLocalContent(ctx, shell, opts = {}) {
  const { callTool, getStatus, getTarget, openUrl } = ctx;
  injectStyle();

  const body = document.createElement("div");
  body.className = "cmcp-rp-body";
  // Center the control body in the shared card (was a viewport-centered modal).
  body.style.margin = "1rem auto";
  const title = document.createElement("div");
  title.className = "cmcp-rp-title";
  title.textContent = tr("runpod_ui.runpod_cloud_gpu_for_this_session", "RunPod — cloud GPU for this session");

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
  // with a manual-ID fallback + a refresh. Populated from `runpod` action:"list".
  const connectRow = document.createElement("div");
  connectRow.className = "cmcp-rp-connect";
  const podSelect = document.createElement("select");
  podSelect.className = "cmcp-rp-podselect";
  podSelect.append(new Option(tr("runpod_ui.loading_pods", "Loading pods…"), ""));
  // "↻" is a glyph, not prose — nothing to translate, and the accessible name is the
  // `title` below.
  const refreshBtn = mkBtn("↻");
  refreshBtn.title = tr("runpod_ui.refresh_pod_list", "Refresh pod list");
  refreshBtn.classList.add("cmcp-rp-refresh");
  const connectBtn = mkBtn(tr("runpod_ui.connect", "Connect"), "primary");
  connectRow.append(podSelect, refreshBtn, connectBtn);

  // Manual-ID row (hidden unless "paste a pod ID…" is chosen in the dropdown).
  const manualRow = document.createElement("div");
  manualRow.className = "cmcp-rp-connect";
  manualRow.style.display = "none";
  const podInput = document.createElement("input");
  podInput.type = "text";
  podInput.placeholder = tr("runpod_ui.paste_pod_id_from_console_runpod_io", "paste pod id (from console.runpod.io)");
  podInput.spellcheck = false;
  manualRow.append(podInput);
  // Enter in the manual-ID field connects, matching the primary button.
  podInput.addEventListener("keydown", (e) => {
    if (isImeComposing(e)) return; // don't connect on a CJK IME commit Enter (#385)
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
  const startBtn = mkBtn(tr("runpod_ui.start", "Start"));
  const stopBtn = mkBtn(tr("runpod_ui.stop", "Stop"));
  const localBtn = mkBtn(tr("runpod_ui.use_local", "Use Local"));
  const deployBtn = mkBtn(tr("runpod_ui.deploy_new_pod", "Deploy new pod"), "primary");
  actions.append(startBtn, stopBtn, localBtn, deployBtn);

  const linkRow = document.createElement("div");
  linkRow.className = "cmcp-rp-muted";
  const linkBtn = document.createElement("a");
  linkBtn.href = "#";
  linkBtn.textContent = tr("runpod_ui.new_runpod_user_open_the_deploy_link", "New RunPod user? Open the deploy link (supports the project via referral) ↗");
  linkBtn.style.color = "inherit";
  linkRow.append(linkBtn);

  const log = document.createElement("div");
  log.className = "cmcp-rp-log";

  const credit = document.createElement("div");
  credit.className = "cmcp-rp-credit";
  // Assembled from nodes instead of one innerHTML string. The anchor — href, target,
  // rel="noopener" — is built here, so the only thing a catalog entry contributes is
  // text; no translation can put markup into the DOM, and no translator can break the
  // link by mistyping a tag. `{link}` is a POSITION marker, not a `vars` value (it is
  // deliberately not passed to tr, so it survives interpolation and we split on it):
  // languages order "inspired by X" differently, and a fixed prose-then-link split
  // would force our word order on all of them.
  const creditLink = document.createElement("a");
  creditLink.href = GPU_CLI_URL;
  creditLink.target = "_blank";
  creditLink.rel = "noopener";
  creditLink.textContent = "gpu-cli.sh";
  const creditParts = tr(
    "runpod_ui.pod_control_inspired_by_link",
    "Pod control inspired by {link}.",
  ).split("{link}");
  // A translation that dropped {link} yields a single part; append the anchor anyway
  // rather than silently losing the attribution.
  credit.append(creditParts[0], creditLink, ...creditParts.slice(1));

  body.append(title, host, card, connectRow, manualRow, actions, linkRow, log, credit);

  // ── state + rendering ──────────────────────────────────────────────────────
  let busy = false;
  let closed = false;
  let tick = null;

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

  // Populate the dropdown from `runpod` action:"list" (humans pick by name, not id).
  async function loadPods(preselect) {
    try {
      const res = await callTool("runpod", { action: "list" });
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
      podSelect.append(
        new Option(
          rows.length
            ? tr("runpod_ui.select_a_pod", "— select a pod —")
            : tr("runpod_ui.no_pods_yet_deploy_one_below", "no pods yet — deploy one below"),
          "",
        ),
      );
      for (const r of rows) {
        // Untranslated on purpose: every piece is RunPod's own data — the pod name the
        // user typed, the API's status enum (RUNNING/EXITED), and the GPU model.
        podSelect.append(new Option(`${r.name} — ${r.status}${r.gpu ? " · " + r.gpu : ""}`, r.id));
      }
      podSelect.append(new Option(tr("runpod_ui.paste_a_pod_id", "＋ paste a pod ID…"), "__manual__"));
      if (want && rows.some((r) => r.id === want)) podSelect.value = want;
      else if (rows.length === 1) podSelect.value = rows[0].id;
    } catch (err) {
      podSelect.innerHTML = "";
      podSelect.append(new Option(tr("runpod_ui.couldn_t_list_pods", "couldn't list pods"), ""));
      podSelect.append(new Option(tr("runpod_ui.paste_a_pod_id", "＋ paste a pod ID…"), "__manual__"));
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
      // `s.name` / `s.pod_id` / `s.gpu` are RunPod's own values and stay verbatim; only
      // the last-resort label when the frame carries neither is ours to translate.
      const bits = [s.name || s.pod_id || tr("runpod_ui.runpod_pod", "RunPod pod")];
      if (s.gpu) bits.push(s.gpu);
      if (s.cost_per_hr != null) bits.push(fmtCost(s.cost_per_hr));
      hostText.textContent = tr("runpod_ui.rendering_on_runpod", "Rendering on RunPod · ") + bits.join(" · ");
    } else if (onPod) {
      hostText.textContent = tr("runpod_ui.rendering_on_a_remote_pod", "Rendering on a remote pod");
    } else {
      hostText.textContent = tr("runpod_ui.rendering_locally_this_machine", "Rendering locally · this machine");
    }

    // Status card.
    card.innerHTML = "";
    if (s && s.watching && s.pod_id) {
      // addRow(parent, LABEL, VALUE, mono, vClass): args 2 and 3 are rendered text and
      // are translated; the trailing "cmcp-rp-warn" below is a CSS CLASS and must not be.
      // Values that come off the wire (pod id, status enum, GPU model, the ComfyUI URL)
      // stay verbatim — only the labels and our own prose are translated.
      addRow(card, tr("runpod_ui.pod", "Pod"), `${s.name || tr("runpod_ui.unnamed", "(unnamed)")}  ${s.pod_id}`);
      addRow(card, tr("runpod_ui.status", "Status"), s.status || "—");
      if (s.gpu) addRow(card, tr("runpod_ui.gpu", "GPU"), s.gpu);
      if (s.cost_per_hr != null) addRow(card, tr("runpod_ui.cost", "Cost"), fmtCost(s.cost_per_hr));
      if (s.uptime_seconds != null) addRow(card, tr("runpod_ui.uptime", "Uptime"), fmtUptime(s.uptime_seconds));
      if (s.gpu_util != null) addRow(card, tr("runpod_ui.gpu_vram", "GPU / VRAM"), `${s.gpu_util}% / ${s.vram_util ?? "—"}%`);
      // "ComfyUI" is the product's name, not a word — it is the same in every locale.
      if (s.comfyui_url) addRow(card, "ComfyUI", s.comfyui_url, true);
      const cd = fmtCountdown(s.autostop_in_seconds);
      if (cd && s.autostop_minutes) {
        addRow(
          card,
          tr("runpod_ui.auto_stop", "Auto-stop"),
          tr("runpod_ui.idle_stops_in", "idle — stops in {time}", { time: cd }),
          false,
          "cmcp-rp-warn",
        );
      } else if (s.autostop_minutes) {
        addRow(
          card,
          tr("runpod_ui.auto_stop", "Auto-stop"),
          // Counted, so it takes `count` and a plural pair — this is the one duration
          // string that is prose rather than an abbreviation, so it is the one most
          // likely to be spelled out ("after 1 minute idle") in translation.
          tr(
            "runpod_ui.after_minutes_idle",
            { one: "after {count}m idle", other: "after {count}m idle" },
            { count: s.autostop_minutes },
          ),
        );
      }
    } else {
      const empty = document.createElement("div");
      empty.className = "cmcp-rp-muted";
      empty.textContent = tr(
        "runpod_ui.no_pod_being_watched_deploy_a_new",
        "No pod being watched. Deploy a new pod, or paste a pod ID and Connect. " +
          "The pod runs our template, so the agent can set up your exact nodes, LoRAs and models on it.",
      );
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
  // Re-render the idle countdown every second while a status frame is live —
  // only while the Local tab is active (started/stopped by the shell).
  function startTick() {
    if (tick) return;
    tick = setInterval(() => {
      const s = getStatus?.();
      if (s && s.watching && s.autostop_in_seconds != null) render();
    }, 1000);
  }
  function stopTick() { if (tick) { clearInterval(tick); tick = null; } }

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
      setLog(tr("runpod_ui.pick_a_pod_from_the_list_first", "Pick a pod from the list first (or deploy a new one)."), "err");
      return;
    }
    // The pod id is a var, not concatenation: a language that puts the object first
    // needs to move it, which "prefix + id" would not allow.
    run(tr("runpod_ui.connecting_to_pod", "Connecting to {id}", { id }), () =>
      callTool("runpod", { action: "connect", pod_id: id }),
    );
  });
  startBtn.addEventListener("click", () => {
    const id = currentPodId();
    if (!id) {
      setLog(tr("runpod_ui.no_pod_selected_paste_a_pod_id", "No pod selected — paste a pod ID, or Deploy a new one."), "err");
      return;
    }
    // PRE-EXISTING, not a consolidation regression: the orchestrator's direct-call
    // admission refuses `start` (and `create` below) because both put a pod into a
    // BILLING state, and a confirmation-less mirrored/foreign tab must not be able
    // to spend money. Both names were dropped from the whitelist in core #278, long
    // before slice 8 — so these two buttons already returned "not permitted"; only
    // the wording of the refusal changes here. Making them work again is a product
    // decision (route through an agent turn, or scope admission to a confirmed
    // click), deliberately NOT taken in this migration step.
    run(tr("runpod_ui.starting_pod", "Starting {id}", { id }), () =>
      callTool("runpod", { action: "start", pod_id: id }),
    );
  });
  stopBtn.addEventListener("click", () => {
    const id = watchedPodId();
    if (!id) return;
    run(tr("runpod_ui.stopping_pod", "Stopping {id}", { id }), () =>
      callTool("runpod", { action: "stop", pod_id: id }),
    );
  });
  localBtn.addEventListener("click", () => {
    run(tr("runpod_ui.switching_to_local_comfyui", "Switching to local ComfyUI"), () =>
      callTool("runpod", { action: "use_local" }),
    );
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
      deployBtn.textContent = tr("runpod_ui.deploy_this_bills_click_to_confirm", "Deploy — this bills. Click to confirm");
      // The price range is USD, as RunPod quotes it — a translated panel must not
      // restate someone's bill in a currency they are not charged in.
      setLog(
        tr(
          "runpod_ui.a_new_pod_bills_per_running_gpu",
          "A new pod bills per running GPU-second (~$0.30–0.70/hr). It idle-auto-stops; Stop ends GPU billing (disk storage still bills until you terminate the pod in the console).",
        ),
        "",
      );
      setTimeout(() => {
        // Only disarm the arming that scheduled this timer — a newer arm (e.g.
        // after a deploy completes and re-arms) must not be cleared by an old one.
        if (deployBtn.dataset.armed === "1" && deployArmGen === gen) {
          deployBtn.dataset.armed = "0";
          deployBtn.textContent = tr("runpod_ui.deploy_new_pod", "Deploy new pod");
        }
      }, 5000);
      return;
    }
    // Ignore a confirm that lands inside the cool-down (a double-click is not a
    // second human decision). Keep it armed so a real click still works.
    if (Date.now() - deployArmedAt < DEPLOY_ARM_COOLDOWN_MS) return;
    deployArmGen++; // invalidate the pending disarm timer for this arming
    deployBtn.dataset.armed = "0";
    deployBtn.textContent = tr("runpod_ui.deploy_new_pod", "Deploy new pod");
    run(tr("runpod_ui.deploying_a_new_pod", "Deploying a new pod"), () =>
      callTool("runpod", { action: "create" }, { timeout: 120000 }),
    ).then((ok) => {
      if (ok) loadPods(); // show the new pod in the dropdown
    });
  });
  linkBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      const res = await callTool("runpod", { action: "deploy_link" });
      const txt = toolText(res);
      const m = txt.match(/https?:\/\/console\.runpod\.io\/deploy\S+/);
      if (m && openUrl) openUrl(m[0]);
      else if (m) window.open(m[0], "_blank", "noopener");
      else setLog(txt, "");
    } catch (err) {
      setLog((err && err.message) || String(err), "err");
    }
  });

  // Load the pod dropdown once, preselecting the watched pod (or opts.pod_id).
  let _loaded = false;
  function loadOnce() {
    if (_loaded) return;
    _loaded = true;
    const s0 = getStatus?.();
    void loadPods((s0 && s0.watching && s0.pod_id) || opts.pod_id);
  }

  return {
    key: "local", label: tr("runpod_ui.runpod", "RunPod"), icon: "pi-server", driveKind: null,
    hasSearch: false, drive: null,
    subnavExtras: () => [],
    mount(bodyEl) { bodyEl.appendChild(body); render(); },
    onActivate() { startTick(); loadOnce(); render(); },
    onDeactivate() { stopTick(); },
    // RunPod status / comfyui_target frames → re-render (no-op unless mounted).
    update() { if (!closed) render(); },
    teardown() { closed = true; stopTick(); },
  };
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
