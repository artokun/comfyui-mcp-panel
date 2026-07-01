// =============================================================================
// ComfyUI Agent Panel — sidebar driven by an autonomous background agent.
//
// Shipped as a UI-only custom node pack (served via WEB_DIRECTORY). The panel
// connects to the loopback WebSocket bridge owned by the comfyui-mcp panel
// orchestrator, started with:
//
//     npx -y comfyui-mcp --panel-orchestrator
//
// The AGENT is a background Claude Agent SDK session the orchestrator spawns
// per tab, running on the user's Claude SUBSCRIPTION — there are NO LLM API
// keys anywhere in this path, and the user's interactive Claude session stays
// free. The agent drives the graph through the bridge; the bridge forwards each
// rid-correlated command here, where a fixed allowlist of executors mutates the
// open LiteGraph graph. Messages the user types below travel the other way:
// panel → bridge → background agent.
//
// Wire protocol (mirrors node-lab's mcp/protocol.ts):
//   inbound  { rid, cmd, ...args }  → execute → reply { rid, ok, result }
//                                              or    { rid, ok:false, error }
//   inbound  { type: "say", text }  → render an agent bubble (no reply)
//   outbound { type: "user_message", text }
//
// All graph mutations are wrapped in beforeChange/afterChange so ComfyUI's
// native Ctrl+Z undoes agent edits exactly like the user's own.
//
// V1→V2 MIGRATION: registration uses `app.registerExtension(...)` (app imported
// from /scripts/app.js) +
// `app.extensionManager.registerSidebarTab(...)`, and the executors touch
// `app.graph` / `LiteGraph` directly. When `@comfyorg/extension-api` ships,
// the equivalents are `defineExtension()`, `defineSidebarTab()`, and
// `NodeHandle`/`WidgetHandle`. v1 call sites are tagged `// TODO(v2):`.
// =============================================================================

// `app` / `api` are resolved LAZILY (not via a static `import "/scripts/app.js"`).
// On Vite/Rolldown frontends, extension modules are evaluated alphabetically-early
// — before `window.comfyAPI.app` is populated — so a static import of the app.js
// shim can throw synchronously and deadlock the module loader. We grab them from
// window.comfyAPI once it's ready instead (see registerExtensionWhenReady at the
// bottom). Deferral approach contributed by @FreesoSaiFared.
import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.js";

let app = null;
let api = null;

// Execution-error capture so graph_get_errors can report the most recent failure
// even if it predates the agent's question. Wired once `api` is ready (via
// setupListeners, called from registerExtensionWhenReady). execution_start clears
// state for the new run.
let lastExecutionError = null;
function setupListeners() {
  if (!api) return;
  try {
    api.addEventListener("execution_error", (ev) => {
      lastExecutionError = { ...(ev.detail ?? {}), ts: new Date().toISOString() };
    });
    api.addEventListener("execution_start", () => {
      lastExecutionError = null;
    });
  } catch {
    // api unavailable — graph_get_errors reports null.
  }
}

// ---------------------------------------------------------------------------
// localStorage-backed settings.
// ---------------------------------------------------------------------------
const STORAGE_KEY_BRIDGE = "comfyui-mcp.panel.bridgeUrl";
// The agent backend the user last picked ("claude" | "codex"). Drives which chip
// is highlighted in the connection settings. Default "claude" keeps the existing
// no-pick behavior.
const STORAGE_KEY_BACKEND = "comfyui-mcp.panel.backend";
// The panel orchestrator owns a DEDICATED bridge port (9180) — so a stray
// process in another session can never sit on the panel's port and produce a
// "connected but no agent" lie.
const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:9180";
const LEGACY_BRIDGE_URL = "ws://127.0.0.1:9101"; // old shared default — migrate off it
// Per-backend DEFAULT bridge ports: the panel orchestrator binds a DEDICATED port
// per backend (claude 9180, codex 9181) so two backends never collide. The Settings
// "Bridge URL" is PER-BACKEND (a map, like model/effort) and each backend's value
// seeds the default URL for that backend. A per-backend DEFAULT must NOT count as a
// "manual override" (so /connect's bridge_url still applies) — only a user-typed
// NON-default URL overrides (see connectAgent.manualOverride).
const DEFAULT_BRIDGE_URL_BY_BACKEND = {
  claude: "ws://127.0.0.1:9180",
  codex: "ws://127.0.0.1:9181",
  gemini: "ws://127.0.0.1:9182",
};
function defaultBridgeUrlFor(backend) {
  return DEFAULT_BRIDGE_URL_BY_BACKEND[backend] || DEFAULT_BRIDGE_URL;
}

function loadBridgeUrl() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY_BRIDGE);
    // Migrate anyone pinned to the old shared 9101 default onto the new port.
    if (!saved || saved === LEGACY_BRIDGE_URL) return DEFAULT_BRIDGE_URL;
    return saved;
  } catch {
    return DEFAULT_BRIDGE_URL;
  }
}

function saveBridgeUrl(url) {
  try {
    window.localStorage.setItem(STORAGE_KEY_BRIDGE, url);
  } catch {
    // localStorage unavailable — session-scoped settings only.
  }
}

// Per-TAB session id: sessionStorage is scoped to the tab and survives
// reloads, so each ComfyUI tab keeps a stable identity on the bridge while
// two tabs never collide. (localStorage would be shared across tabs.)
const TAB_ID_KEY = "comfyui-mcp.panel.tabSessionId";
function getTabId() {
  try {
    let id = window.sessionStorage.getItem(TAB_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem(TAB_ID_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// Per-tab agent session id + which thread this tab is showing. sessionStorage
// is tab-scoped and survives reload — exactly what "restore the last session on
// reload" needs, without two tabs clobbering each other.
const SESSION_KEY = "comfyui-mcp.panel.sessionId";
const CURRENT_THREAD_KEY = "comfyui-mcp.panel.currentThreadId";
// Set when the agent triggers a ComfyUI restart, so that after ComfyUI comes
// back the panel respawns the orchestrator, resumes the agent session, and
// nudges it to continue — making install→restart→continue autonomous. Survives
// a page reload (sessionStorage) in case the restart reloads the frontend.
const REBOOT_KEY = "comfyui-mcp.panel.rebootResume";
// Set while a soft reload (orchestrator respawn, no ComfyUI restart) is in
// flight. Value is the trigger origin ("agent" | "user") so that after the
// fresh orchestrator reconnects we resume the session and — only for an
// agent-triggered reload mid-task — nudge it to continue. Survives the bridge
// drop via sessionStorage.
const SOFT_RELOAD_KEY = "comfyui-mcp.panel.softReloadResume";
// Set while the agent is mid-turn (working), cleared when the turn finishes. If
// the connection drops while it's set — an UNEXPECTED bounce (another agent
// rebooting ComfyUI, a crash, an SDK self-heal) — the reconnect nudges the
// resumed session to continue where it left off. The REBOOT/SOFT_RELOAD cases
// (deliberate, agent-known) are handled first and clear this so we don't double-nudge.
const MID_TASK_KEY = "comfyui-mcp.panel.midTaskResume";
// Wall-clock (ms) of the last bridge drop — module-scoped so it survives panel
// remounts. A FAST reconnect (panel swap / WS blip; orchestrator alive) vs a
// SLOW one (real ComfyUI restart; orchestrator died + respawned) is how we tell
// a spurious bounce from a real one — only the slow case fires the resume nudge.
let lastBridgeDownAt = 0;
// One-shot flag set right before a frontend (page) reload WE trigger, so that
// after the reload we re-activate our own sidebar tab. ComfyUI restores the
// last active tab BEFORE our extension re-registers it, so it can't reopen ours
// on its own — we do it once registration is back.
const SIDEBAR_REOPEN_KEY = "comfyui-mcp.panel.reopenSidebar";
/** Our sidebar tab id — referenced by both the opener and the registration. */
const SIDEBAR_TAB_ID = "comfyui-mcp.agent";

/**
 * Best-effort: make our sidebar tab the active one. ComfyUI exposes this a few
 * different ways across versions, so try them in order and stop at the first
 * that takes. No-op if it's already active.
 */
function openSidebarTab() {
  const em = (typeof app !== "undefined" && app) ? app.extensionManager : null;
  if (!em) return false;
  const store = em.sidebarTab || em;
  const active = () => store.activeSidebarTabId ?? em.activeSidebarTabId;
  try {
    if (active() === SIDEBAR_TAB_ID) return true; // already open — nothing to do
    // Prefer an IDEMPOTENT set (never closes the tab); fall back to toggle only
    // after confirming our tab isn't the active one (so toggle can't close it).
    if (typeof em.setActiveSidebarTab === "function") em.setActiveSidebarTab(SIDEBAR_TAB_ID);
    else { try { store.activeSidebarTabId = SIDEBAR_TAB_ID; } catch { /* not writable */ } }
    if (active() === SIDEBAR_TAB_ID) return true;
    if (typeof store.toggleSidebarTab === "function") store.toggleSidebarTab(SIDEBAR_TAB_ID);
    else if (typeof em.toggleSidebarTab === "function") em.toggleSidebarTab(SIDEBAR_TAB_ID);
    else em.command?.execute?.(`Workspace.ToggleSidebarTab.${SIDEBAR_TAB_ID}`);
    return active() === SIDEBAR_TAB_ID;
  } catch (e) {
    console.warn("[comfyui-mcp-panel] couldn't open sidebar tab:", e);
    return false;
  }
}

function ssGet(key) {
  try {
    return window.sessionStorage.getItem(key) || null;
  } catch {
    return null;
  }
}
function ssSet(key, val) {
  try {
    if (val == null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, val);
  } catch {
    // sessionStorage unavailable — resume/restore degrade to off.
  }
}

// Sticky auto-connect: once the user has connected, the panel auto-reconnects
// (respawning the orchestrator if it died, e.g. after a ComfyUI reboot) on every
// open — until they explicitly Disconnect. localStorage so it survives a full
// frontend reload, not just a tab session.
const AUTOCONNECT_KEY = "comfyui-mcp.panel.autoConnect";
function lsGet(key) {
  try {
    return window.localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}
function lsSet(key, val) {
  try {
    if (val == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, val);
  } catch {
    // localStorage unavailable — auto-connect degrades to manual Connect.
  }
}

// ---------------------------------------------------------------------------
// ComfyUI Settings dialog integration.
//
// We register a `settings: [...]` block on app.registerExtension (same API
// rgthree/KJNodes/VHS/cg-use-everywhere use) so the panel's user-facing DEFAULTS
// live in ComfyUI's standard Settings dialog (persisted to comfy.settings.json).
// These SEED the panel's existing localStorage-backed runtime (selectedBackend,
// prefs.model/effort, bridge URL, auto-connect) on load, and live changes in the
// dialog push into the open panel via `panelHooks`. The in-composer pickers write
// BACK to the settings so the two never drift. SECRET tokens are NOT stored here
// (never plaintext in comfy.settings.json) — their settings are BUTTONS that drive
// the existing secure request_secret flow into the orchestrator's secure store.
// ---------------------------------------------------------------------------
const SETTING_BACKEND = "comfyui-mcp.defaultBackend";
// Default model/effort are now PER-BACKEND (one independent setting each per
// provider), so the Claude group never resets/repopulates the Codex group on a
// switch and vice-versa — that interdependence is what caused the prior storms.
// The ACTIVE backend (SETTING_BACKEND) decides which group seeds the runtime.
const SETTING_MODEL = {
  claude: "comfyui-mcp.defaultModel.claude",
  codex: "comfyui-mcp.defaultModel.codex",
  gemini: "comfyui-mcp.defaultModel.gemini",
};
const SETTING_EFFORT = {
  claude: "comfyui-mcp.defaultEffort.claude",
  codex: "comfyui-mcp.defaultEffort.codex",
  gemini: "comfyui-mcp.defaultEffort.gemini",
};
// Pre-grouping single-key settings (a returning user upgrading from the single
// "Default model"/"Default reasoning effort" had these). Migrated ONCE into the
// Claude group (the default backend) so an upgrade never loses the saved choice.
const LEGACY_SETTING_MODEL = "comfyui-mcp.defaultModel";
const LEGACY_SETTING_EFFORT = "comfyui-mcp.defaultEffort";
// Per-backend Bridge URL (a map, like SETTING_MODEL/SETTING_EFFORT). Each backend
// keeps its OWN bridge URL so switching to Codex doesn't leave the panel dialing
// Claude's port — the "Reconnect won't recover after a switch" bug.
const SETTING_BRIDGE_URL = {
  claude: "comfyui-mcp.bridgeUrl.claude",
  codex: "comfyui-mcp.bridgeUrl.codex",
  gemini: "comfyui-mcp.bridgeUrl.gemini",
};
// Pre-per-backend single Bridge URL key — migrated ONCE into the Claude group so a
// returning user's custom port isn't lost (runs in the groups-migration block).
const LEGACY_SETTING_BRIDGE_URL = "comfyui-mcp.bridgeUrl";
const SETTING_AUTOCONNECT = "comfyui-mcp.autoConnect";
const SETTING_FOCUS_FOLLOW = "comfyui-mcp.zoomToAction";
const SETTING_STALL_S = "comfyui-mcp.stallWarningSeconds";
const SETTING_REMOTE_URL = "comfyui-mcp.remoteComfyuiUrl";
const SETTING_TOKEN_CIVITAI = "comfyui-mcp.setCivitaiToken";
const SETTING_TOKEN_HF = "comfyui-mcp.setHuggingfaceToken";
// One-time flag: on first load with this feature, push the user's EXISTING
// localStorage choices INTO the settings (so the dialog reflects reality and an
// upgrade never silently resets a returning user's backend/model/effort/url).
// After that, the settings are canonical and seed the runtime on each open.
const SETTINGS_SEEDED_KEY = "comfyui-mcp.panel.settingsSeeded";
// One-time flag: migrate the pre-grouping single Default-model/effort into the
// per-backend groups (runs independently of SETTINGS_SEEDED_KEY).
const SETTINGS_GROUPS_MIGRATED_KEY = "comfyui-mcp.panel.settingsGroupsMigrated";
// Section (sub-category) labels for the grouped Settings dialog, per backend.
const BACKEND_SECTION = { claude: "Claude", codex: "ChatGPT (Codex)", gemini: "Gemini" };
// Backend display names at module scope (the Settings dialog's render-fns live
// outside buildPanel's closure, so they need their own copy).
const BACKEND_TEXT = { claude: "Claude", codex: "ChatGPT", gemini: "Gemini" };
// The allowlisted secure-store keys (mirrors the orchestrator's #59 allowlist).
const SECRET_SET_AT_PREFIX = "comfyui-mcp.panel.secretSetAt.";

// Hooks the OPEN panel registers so the Settings dialog can drive the running
// panel live. Null when no panel is mounted (settings still persist via ComfyUI;
// buildPanel re-seeds from them on the next open). Every applier is idempotent
// (no-ops when the value already matches) so a setSetting→onChange echo can't loop.
const panelHooks = {
  applyBackend: null, // (id)
  applyModel: null, // (id)
  applyEffort: null, // (id|"")
  applyBridgeUrl: null, // (url)
  applyAutoConnect: null, // (bool)
  applyStallConfig: null, // () — push the live render-stall threshold to the orchestrator
  requestSecret: null, // (envKey, friendly)
};
// Best-effort guard so a setSetting() we make while seeding/syncing doesn't bounce
// back through onChange and re-drive the panel (the idempotent appliers also guard).
let suppressSettingOnChange = false;
// ComfyUI fires every setting's onChange when it APPLIES PERSISTED SETTINGS AT
// STARTUP — not just on real user edits. Those load-time callbacks must NOT drive
// side effects: a persisted Auto-connect/Bridge-URL would call connectAgent() and
// race the sticky-autoconnect path, and with the bridge's one-socket-per-tab policy
// each new socket closes the other → a ~1s reconnect storm. So onChange appliers
// stay disarmed until the panel has mounted AND made its single initial connect
// decision; only genuine post-load user edits in the Settings dialog take effect.
let settingsArmed = false;

// Per-backend FETCHED model catalog PUBLISHED for the Settings dialog's
// per-backend "Default model" dropdowns. Those <select>s render at MODULE scope
// (via the settings `type:()=>HTMLElement` render-fns, outside buildPanel's
// closure), so the open panel keeps this current as each backend connects, and
// it survives a panel unmount (last value) so the dialog can still offer the
// right list. Each backend's list is INDEPENDENT — a Claude connect only ever
// touches modelsByBackend.claude, so the Codex dropdown never repopulates from a
// Claude switch (and vice-versa). That independence is the whole point of groups.
const settingsBackendState = {
  modelsByBackend: {}, // backend id -> presentable model rows (last fetched)
};
// References to the dialog's live per-backend model <select>s, set by their
// render-fns when the dialog opens, so a freshly-arrived catalog can repaint the
// matching backend's dropdown in place (a render-fn setting has no static options
// to re-key). Keyed by backend; null when that group isn't mounted.
const settingsModelSelectEls = { claude: null, codex: null, gemini: null };
// Disabled placeholder <option> value — mapped to "" (Auto) if ever selected so
// it can never persist as a bogus model id.
const SETTINGS_PLACEHOLDER = "__cmcp_placeholder__";

/** Which backend the Settings dialog currently treats as ACTIVE — the persisted
 *  Default-backend (claude/codex), defaulting to claude. Used to decide whether a
 *  per-backend group's edit should drive the LIVE panel (only the active group does). */
function currentSettingsBackend() {
  const b = getSetting(SETTING_BACKEND);
  return b === "codex" || b === "gemini" ? b : "claude";
}
/** Fetched model rows for `backend` (the same presentable catalog the composer
 *  picker uses), or null when none is cached (backend never connected this session). */
function settingsModelsFor(backend) {
  const rows = settingsBackendState.modelsByBackend[backend];
  return Array.isArray(rows) && rows.length ? rows : null;
}
/** A styled <select> matching the settings dialog's inputs. */
function makeSettingSelect() {
  const sel = document.createElement("select");
  sel.className = "p-inputtext p-component";
  sel.style.cssText =
    "padding:0.3rem 0.5rem;border-radius:6px;border:1px solid var(--p-surface-500,#555);" +
    "background:var(--p-surface-900,#18181b);color:var(--p-text-color,#e4e4e7);font-size:0.8rem;min-width:14rem;";
  return sel;
}
/** (Re)populate a backend's Default-model <select>: an "Auto" option, then that
 *  backend's FETCHED models; a saved-but-absent model id is kept SELECTABLE only
 *  when there's no live catalog (backend not connected) so the choice isn't lost —
 *  when a fetched catalog exists and lacks the id it's shown DISABLED and the
 *  selection snaps to Auto (never re-sent as an invalid model). Fully INDEPENDENT
 *  per backend: only reads SETTING_MODEL[backend] + modelsByBackend[backend]. */
function populateModelSelect(sel, backend) {
  if (!sel) return;
  const rows = settingsModelsFor(backend);
  const saved = getSetting(SETTING_MODEL[backend]) || "";
  sel.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto (let the agent pick)";
  sel.appendChild(auto);
  const seen = new Set([""]);
  if (rows) {
    for (const m of rows) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.small ? `${m.label} — ${m.small}` : m.label;
      sel.appendChild(o);
      seen.add(m.id);
    }
  } else {
    const hint = document.createElement("option");
    hint.value = SETTINGS_PLACEHOLDER;
    hint.disabled = true;
    hint.textContent = `Connect to ${BACKEND_TEXT[backend] || backend} to load its models`;
    sel.appendChild(hint);
  }
  if (saved && !seen.has(saved)) {
    const o = document.createElement("option");
    o.value = saved;
    if (rows) {
      o.disabled = true;
      o.textContent = `${saved} (not available for this backend)`;
    } else {
      o.textContent = `${saved} (saved)`;
      seen.add(saved);
    }
    sel.appendChild(o);
  }
  sel.value = seen.has(saved) ? saved : "";
}
/** Build the static effort-combo options for `backend` ("Model default" + that
 *  backend's fixed scale). Each group's combo is static — no dynamic remap needed
 *  since the groups are separate (no shared dropdown to flip on a switch). */
function effortComboOptions(backend) {
  const scale = BACKEND_EFFORTS[backend] || ALL_EFFORTS;
  return [
    { value: "", text: "Model default" },
    ...scale.map((id) => ({ value: id, text: effortMeta(id).label })),
  ];
}

function getSetting(id) {
  try {
    return app?.ui?.settings?.getSettingValue?.(id);
  } catch {
    return undefined;
  }
}
function setSetting(id, value) {
  try {
    suppressSettingOnChange = true;
    app?.ui?.settings?.setSettingValue?.(id, value);
  } catch {
    // settings store unavailable — settings just won't persist this change.
  } finally {
    suppressSettingOnChange = false;
  }
}

// Drive the secure token flow from a Settings button. Reuses the SAME masked
// secure input the agent's panel_request_secret tool already opens — the pasted
// value rides the existing request_secret bridge command straight into the
// orchestrator's secure store (#59 → setComfyuiSecret → 0600 panel-secrets.json),
// so the raw token NEVER lands in comfy.settings.json or chat history. Opens the
// Agent sidebar tab first (mounting the panel if needed) and retries briefly until
// the live panel's hook is ready.
function triggerSecret(envKey, friendly) {
  openSidebarTab();
  const go = () => {
    if (panelHooks.requestSecret) {
      panelHooks.requestSecret(envKey, friendly);
      return true;
    }
    return false;
  };
  if (go()) return;
  let tries = 0;
  const t = setInterval(() => {
    if (go()) {
      clearInterval(t);
      return;
    }
    // Retry exhausted: the panel never mounted / its hook never appeared (e.g. the
    // Agent tab was never opened, or it failed to mount). Don't silently no-op —
    // tell the user how to recover instead of leaving the button dead (P2 b).
    if (++tries > 25) {
      clearInterval(t);
      try {
        window.alert(
          `Open the Agent panel, connect, then set the ${friendly} token again.`,
        );
      } catch {
        /* alert unavailable (headless/embedded) — nothing else to do */
      }
    }
  }, 150);
}

// Stall-warning threshold (seconds) from the panel setting, clamped to a sane
// range — sent on connect so the orchestrator (COMFYUI_MCP_STALL_S) warns the
// agent once a render has made no progress for this long. null when unset/invalid
// (the orchestrator then keeps its own 180s default).
function stallSettingSeconds() {
  const v = Number(getSetting(SETTING_STALL_S));
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.min(3600, Math.max(15, Math.round(v)));
}

// Optional remote ComfyUI URL (panel setting). Blank → drive the local ComfyUI.
// Sent on every /connect so the orchestrator spawns its MCP against the remote
// server; validated + normalized server-side in __init__.py (_coerce_comfyui_url).
function remoteUrlSetting() {
  const v = getSetting(SETTING_REMOTE_URL);
  return typeof v === "string" ? v.trim() : "";
}

// Build the settings list registered on the extension. Defined as a function so
// it can close over the module-level hooks/helpers above.
function panelSettingsList() {
  const cat = (sub, name) => ["Comfy MCP Agent", sub, name];
  // A BUTTON-type setting: ComfyUI supports a custom `type` render function that
  // returns an HTMLElement (cg-use-everywhere uses the same trick for its About
  // row). We render a button + a masked set/not-set indicator.
  const tokenSetting = (id, envKey, friendly, sortOrder) => ({
    id,
    name: `${friendly} token`,
    category: cat("API tokens", friendly),
    sortOrder,
    tooltip:
      `Securely store your ${friendly} API token. Opens the Agent panel's masked secure input; the value goes ` +
      `straight to the agent's secure store on the orchestrator — it is NEVER written to ComfyUI settings, logs, ` +
      `or chat history. The Agent must be connected (click Connect in the panel first).`,
    type: () => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;align-items:center;gap:0.5rem;";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "p-button p-component";
      btn.textContent = `Set ${friendly} token…`;
      btn.style.cssText =
        "padding:0.3rem 0.7rem;border-radius:6px;border:1px solid var(--p-surface-500,#555);" +
        "background:var(--p-primary-color,#3a7bd5);color:#fff;cursor:pointer;font-size:0.8rem;white-space:nowrap;";
      const status = document.createElement("span");
      status.style.cssText = "font-size:0.72rem;opacity:0.8;";
      const refresh = () => {
        const at = lsGet(SECRET_SET_AT_PREFIX + envKey);
        if (at) {
          const d = new Date(Number(at));
          status.textContent = Number.isFinite(d.getTime())
            ? `🔒 set ${d.toLocaleDateString()}`
            : "🔒 set";
          status.style.color = "var(--p-green-400,#4ade80)";
        } else {
          status.textContent = "not set";
          status.style.color = "var(--p-text-muted-color,#a1a1aa)";
        }
      };
      refresh();
      btn.addEventListener("click", () => {
        triggerSecret(envKey, friendly);
        // The actual "set" marker is written when the masked input resolves with a
        // value; refresh shortly after so the indicator reflects a completed entry.
        setTimeout(refresh, 1500);
        setTimeout(refresh, 8000);
      });
      wrap.append(btn, status);
      return wrap;
    },
  });

  // ORDERING. ComfyUI's Settings dialog (SettingDialog.vue → sortedGroups) orders
  // the SECTIONS within a category by the MAX `sortOrder` of their settings,
  // DESCENDING (ties broken alphabetically by label), and the rows WITHIN a section
  // by `sortOrder` DESCENDING. So higher number = earlier. We assign DESCENDING
  // values to force About → General → Claude → ChatGPT (Codex) → API tokens — the
  // Star/About section is given the HIGHEST sortOrder of all so it renders at the
  // very TOP, then General (backend selector first), then the two backend groups,
  // then API tokens LAST — NOT the alphabetical default.
  // (Verified against the installed comfyui_frontend_package SettingDialog.vue.)
  // Section MAX sortOrder: About 200 > General 150 > Claude 130 > Codex 110 > Gemini 90 > tokens 20.
  //
  // A per-backend "Default model" — a render-fn DROPDOWN of the FETCHED models for
  // THAT backend (the same catalog the composer picker shows). Static `combo`s
  // can't be repopulated, hence the custom render-fn. Each group is INDEPENDENT and
  // STATIC: the Claude group only reads/writes the Claude setting + Claude catalog,
  // the Codex group only the Codex ones — neither resets the other on a switch.
  // "Auto" clears the forced model. We gate the LIVE applier on settingsArmed AND
  // on this being the ACTIVE backend's group (a non-active group's edit only
  // persists; it must not drive the running agent).
  const modelSetting = (backend, sortOrder) => ({
    id: SETTING_MODEL[backend],
    name: "Default model",
    category: cat(BACKEND_SECTION[backend], "Default model"),
    sortOrder,
    tooltip:
      `Default model for the ${BACKEND_TEXT[backend]} background agent, chosen from the models fetched for ` +
      `${BACKEND_TEXT[backend]} (the same list the panel's model picker shows). 'Auto' lets the agent pick. ` +
      `Changing the model in the panel updates this too. Until you connect to ${BACKEND_TEXT[backend]} this may ` +
      `show only 'Auto' + your saved choice.`,
    type: () => {
      const sel = makeSettingSelect();
      populateModelSelect(sel, backend);
      sel.addEventListener("change", () => {
        let v = sel.value === SETTINGS_PLACEHOLDER ? "" : sel.value;
        // Never persist/send a model that isn't in this backend's known fetched
        // catalog (a stale cross-backend id) — snap to Auto instead.
        if (v) {
          const rows = settingsModelsFor(backend);
          if (rows && !rows.some((m) => m.id === v)) {
            v = "";
            sel.value = "";
          }
        }
        setSetting(SETTING_MODEL[backend], v);
        // Drive the live panel ONLY for the ACTIVE backend's group.
        if (settingsArmed && backend === currentSettingsBackend()) {
          panelHooks.applyModel?.(v);
        }
      });
      settingsModelSelectEls[backend] = sel;
      return sel;
    },
  });
  // A per-backend "Default reasoning effort" — a STATIC combo of THAT backend's
  // fixed scale (Claude: low–max; Codex: none–xhigh; Gemini: no effort control).
  // No dynamic remap needed since the groups are separate. Drives the live panel
  // only for the active group.
  const effortSetting = (backend, sortOrder) => ({
    id: SETTING_EFFORT[backend],
    name: "Default reasoning effort",
    category: cat(BACKEND_SECTION[backend], "Default reasoning effort"),
    sortOrder,
    tooltip:
      ((BACKEND_EFFORTS[backend] || ALL_EFFORTS).length
        ? `Default reasoning effort for the ${BACKEND_TEXT[backend]} agent, from its scale ` +
          `(${backend === "codex" ? "none–xhigh" : "low–max"}). 'Model default' leaves it unset.`
        : `${BACKEND_TEXT[backend]} exposes no reasoning-effort control; leave this at 'Model default'.`),
    type: "combo",
    options: effortComboOptions(backend),
    defaultValue: "",
    onChange: (v) => {
      if (suppressSettingOnChange || !settingsArmed) return;
      if (backend === currentSettingsBackend()) panelHooks.applyEffort?.(v);
    },
  });
  // A per-backend "Bridge URL" — each backend has its OWN orchestrator port
  // (claude 9180, codex 9181), so the URL must be per-backend or a switch to Codex
  // leaves Reconnect dialing Claude's 9180. The value seeds the default URL for that
  // backend; /connect's returned bridge_url still applies. Drives the live panel
  // (a reconnect) only for the ACTIVE backend's group — a non-active group's edit
  // just persists, it never retargets the running bridge.
  const bridgeUrlSetting = (backend, sortOrder) => ({
    id: SETTING_BRIDGE_URL[backend],
    name: "Bridge URL",
    category: cat(BACKEND_SECTION[backend], "Bridge URL"),
    sortOrder,
    tooltip:
      `WebSocket URL of the ${BACKEND_TEXT[backend]} panel orchestrator bridge. Default ` +
      `${defaultBridgeUrlFor(backend)}. Only change this if you run the ${BACKEND_TEXT[backend]} ` +
      `orchestrator on a non-default port.`,
    type: "text",
    defaultValue: defaultBridgeUrlFor(backend),
    onChange: (v) => {
      if (suppressSettingOnChange || !settingsArmed) return;
      if (backend === currentSettingsBackend()) panelHooks.applyBridgeUrl?.(v);
    },
  });

  return [
    // ---- About (renders FIRST — highest sortOrder of ALL) ----
    {
      // A link row — "⭐ Star on GitHub". Render-fn type (same custom-HTMLElement
      // trick as the token buttons); no persisted value.
      id: "comfyui-mcp.starGithub",
      name: "Star on GitHub",
      category: cat("About", "Star on GitHub"),
      sortOrder: 200,
      tooltip:
        "Enjoying the ComfyUI Agent Panel? A GitHub star genuinely helps. Opens the repo in a new tab.",
      type: () => {
        const a = document.createElement("a");
        a.href = "https://github.com/artokun/comfyui-mcp-panel";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "⭐ Star comfyui-mcp-panel on GitHub";
        a.style.cssText =
          "display:inline-flex;align-items:center;gap:0.4rem;padding:0.3rem 0.7rem;border-radius:6px;" +
          "border:1px solid var(--p-surface-500,#555);background:var(--p-surface-800,#27272a);" +
          "color:var(--p-text-color,#e4e4e7);text-decoration:none;font-size:0.8rem;white-space:nowrap;";
        return a;
      },
    },
    // ---- General (backend selector is the first row) ----
    {
      id: SETTING_BACKEND,
      name: "Default agent backend",
      category: cat("General", "Default agent backend"),
      sortOrder: 150,
      tooltip:
        "Which background agent the panel connects to by default. Claude runs on your Claude subscription; " +
        "ChatGPT runs on your Codex (ChatGPT) account; Gemini runs on your Google (Gemini) login. Seeds the " +
        "panel's backend (and which group below seeds the runtime); you can still switch live in the model " +
        "picker (a live switch is session-only and does NOT change this default).",
      type: "combo",
      options: [
        { value: "claude", text: "Claude" },
        { value: "codex", text: "ChatGPT" },
        { value: "gemini", text: "Gemini" },
      ],
      defaultValue: "claude",
      onChange: (v) => {
        if (suppressSettingOnChange || !settingsArmed) return;
        panelHooks.applyBackend?.(v);
      },
    },
    {
      id: SETTING_AUTOCONNECT,
      name: "Auto-connect on load",
      category: cat("General", "Auto-connect on load"),
      sortOrder: 145,
      tooltip:
        "Automatically connect the agent (starting the local orchestrator) when the panel opens, without clicking Connect. " +
        "Off by default — the orchestrator is otherwise only started by an explicit Connect click.",
      type: "boolean",
      defaultValue: false,
      onChange: (v) => {
        if (suppressSettingOnChange || !settingsArmed) return;
        panelHooks.applyAutoConnect?.(!!v);
      },
    },
    {
      id: SETTING_STALL_S,
      name: "Render stall warning (seconds)",
      category: cat("General", "Render stall warning (seconds)"),
      sortOrder: 142,
      tooltip:
        "How long a ComfyUI render may make NO progress before the agent is warned its render looks stalled/wedged " +
        "(e.g. an OOM-stuck sampler step) and is told to cancel/restart rather than queue another run. Video steps " +
        "are legitimately slow, so keep this generous. Default 180s; range 15–3600. Applies when the orchestrator " +
        "next starts — Disconnect then Connect (or /restart) to change it for a running agent.",
      type: "number",
      attrs: { min: 15, max: 3600, step: 5 },
      defaultValue: 180,
      onChange: () => {
        if (suppressSettingOnChange || !settingsArmed) return;
        // Push the new threshold to a live orchestrator (set_config) so it applies
        // without a reconnect; also sent on connect and forwarded on spawn via env.
        panelHooks.applyStallConfig?.();
      },
    },
    {
      id: SETTING_REMOTE_URL,
      name: "Remote ComfyUI URL (advanced)",
      category: cat("General", "Remote ComfyUI URL (advanced)"),
      sortOrder: 143,
      tooltip:
        "Point the AGENT at a remote ComfyUI instead of this machine — e.g. a RunPod pod at " +
        "https://xxxxxxxx-8188.proxy.runpod.net. Leave BLANK to drive the local ComfyUI (default). " +
        "When set, the agent's tools (queue, models, history, uploads) target the remote server, and " +
        "local-only tools (download_model / installer packs / model scans) are disabled. Applies when " +
        "the orchestrator next starts — Disconnect then Connect to change it. Your live canvas still " +
        "follows whichever ComfyUI you opened in the browser.",
      type: "text",
      defaultValue: "",
      onChange: () => {
        // No live apply: the URL is baked into the orchestrator's MCP at spawn, so
        // it takes effect on the next Connect (Disconnect → Connect).
      },
    },
    {
      id: SETTING_FOCUS_FOLLOW,
      name: "Zoom to agent edits",
      category: cat("General", "Zoom to agent edits"),
      sortOrder: 140,
      tooltip:
        "When the agent changes a node's value, smoothly zoom the canvas to that node (with padding) so you watch " +
        "the change land, then zoom back out to fit the whole graph once edits go quiet. Scoped to value edits — " +
        "wiring and node placement don't move the view. On by default; turn off to keep the canvas still.",
      type: "boolean",
      defaultValue: true,
      onChange: (v) => {
        if (suppressSettingOnChange || !settingsArmed) return;
        // Turning it off mid-burst: drop any pending zoom-back-out.
        if (!v && fitBackTimer) {
          clearTimeout(fitBackTimer);
          fitBackTimer = null;
        }
      },
    },
    // ---- Claude (Default model, Default reasoning effort, Bridge URL) ----
    modelSetting("claude", 130),
    effortSetting("claude", 125),
    bridgeUrlSetting("claude", 120),
    // ---- ChatGPT (Codex) (Default model, Default reasoning effort, Bridge URL) ----
    modelSetting("codex", 110),
    effortSetting("codex", 105),
    bridgeUrlSetting("codex", 100),
    // ---- Gemini (Default model, Default reasoning effort, Bridge URL) ----
    modelSetting("gemini", 90),
    effortSetting("gemini", 85),
    bridgeUrlSetting("gemini", 80),
    // ---- API tokens (LAST) ----
    tokenSetting(SETTING_TOKEN_CIVITAI, "CIVITAI_API_TOKEN", "CivitAI", 20),
    tokenSetting(SETTING_TOKEN_HF, "HUGGINGFACE_TOKEN", "HuggingFace", 15),
  ];
}

// ---------------------------------------------------------------------------
// Model + effort picker. The orchestrator passes these to the Agent SDK
// (Options.model / Options.effort), so the panel can actually drive them now —
// model switches live, an effort change restarts the (resumed) session.
//
// The real catalog is NOT hardcoded: the orchestrator probes the SDK
// (query.supportedModels()) — the only model-enumeration that works on the
// subscription lane — and pushes a `models` frame with each model's
// `supportedEffortLevels`. The list below is only a fallback for when the
// probe hasn't answered yet (or failed).
// ---------------------------------------------------------------------------
const FALLBACK_MODELS = [
  { value: "opus", displayName: "Opus", description: "most capable", supportsEffort: true },
];
// Friendly copy for known effort ids; unknown ids fall back to a capitalized id.
const EFFORT_META = {
  none: { label: "None", small: "no reasoning" },
  minimal: { label: "Minimal", small: "fastest" },
  low: { label: "Low", small: "quick" },
  medium: { label: "Medium", small: "default" },
  high: { label: "High", small: "thorough" },
  xhigh: { label: "Extra high", small: "deep" },
  max: { label: "Max", small: "exhaustive" },
};
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Per-provider reasoning-effort scales. Claude and Codex (ChatGPT) accept
// DIFFERENT levels, so the dropdown must offer the valid set for the connected
// backend — and a chosen level must survive a provider switch by mapping to the
// nearest valid level for the target (the orchestrator backends do the same
// mapping server-side; this keeps the picker honest about what's selectable).
//   • Claude: low | medium | high | xhigh | max
//   • Codex:  none | minimal | low | medium | high | xhigh
//   • Gemini: (none) — the gemini CLI (run via `gemini --acp`) exposes no
//     user-facing reasoning-effort levels, so the effort selector is hidden for
//     it (empty scale → effortsForModel returns [], intersecting any model-
//     reported levels down to none). The orchestrator maps effort server-side.
const BACKEND_EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh"],
  gemini: [],
};
// Ordered low→high across BOTH scales, for nearest-level mapping on a switch.
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Snap `effort` to the nearest level present in `list` by EFFORT_ORDER rank.
 *  Shared levels pass through 1:1; an off-list source snaps to the closest by
 *  ordered rank (ties prefer the lower level). Returns `effort` unchanged when
 *  falsy; returns undefined when `list` is EMPTY (no effort control). */
function nearestInList(effort, list) {
  if (!effort) return effort;
  if (!Array.isArray(list) || !list.length) return undefined;
  if (list.includes(effort)) return effort;
  const srcRank = EFFORT_ORDER.indexOf(effort);
  if (srcRank < 0) return list[0];
  let best = list[0];
  let bestDist = Infinity;
  for (const v of list) {
    const d = Math.abs(EFFORT_ORDER.indexOf(v) - srcRank);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

/** Normalize a ModelInfo list (or the fallback) to picker rows. `efforts`:
 *  an array of effort ids, or null when the model supports effort but didn't
 *  enumerate levels, or [] when it has no effort control. */
function normalizeModels(list) {
  return (Array.isArray(list) ? list : []).map((m) => {
    let efforts;
    if (Array.isArray(m.supportedEffortLevels)) efforts = m.supportedEffortLevels;
    else if (m.supportsEffort) efforts = null; // unknown → offer the standard set
    else efforts = []; // no effort control
    const desc = typeof m.description === "string" ? m.description : "";
    return {
      id: m.value,
      label: m.displayName || m.value,
      small: desc.length > 28 ? desc.slice(0, 27) + "…" : desc,
      efforts,
    };
  });
}
function effortMeta(id) {
  return EFFORT_META[id] ?? { label: id.charAt(0).toUpperCase() + id.slice(1), small: "" };
}

// Show the clean family aliases (Opus / Sonnet / Haiku): drop the synthetic
// "default", and drop pinned version ids (claude-*) that just duplicate an
// alias (e.g. claude-opus-4-8 vs the "opus" alias — same model). Falls back
// gracefully if that would empty the list.
function presentableModels(rows) {
  const aliases = rows.filter((r) => r.id !== "default" && !/^claude-/.test(r.id));
  if (aliases.length) return aliases;
  const noDefault = rows.filter((r) => r.id !== "default");
  return noDefault.length ? noDefault : rows;
}
// Pre-select Opus when the user hasn't chosen.
function pickDefaultModel(rows) {
  return (rows.find((r) => /opus/i.test(r.id)) ?? rows[0])?.id;
}
const PREFS_KEY = "comfyui-mcp.panel.prefs";
function loadPrefs() {
  try {
    const p = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}");
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}
function savePrefs(prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable — prefs are session-only.
  }
}
function modelLabel(catalog, id) {
  return catalog.find((m) => m.id === id)?.label ?? id ?? "Claude";
}

/** A readable auto name for grounding an unsaved workflow. */
function autoWorkflowName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `Untitled ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** True when `name` is a placeholder rather than a name the user/agent chose.
 *  ComfyUI's brand-new temporary tabs are pathed "Unsaved Workflow.json" (and
 *  "Unsaved Workflow (2).json", …); our own grounding auto-name is
 *  "Untitled <timestamp>". Anything else is a real, deliberate name (e.g. set
 *  via rename_workflow) and must NOT be clobbered by a fresh auto-name on save. */
function isDefaultWorkflowName(name) {
  const n = String(name || "").trim();
  return !n || /^Unsaved Workflow\b/i.test(n) || /^Untitled\b/.test(n);
}

/** Programmatically save the active workflow — NO Save/Rename dialog. Uses the
 *  workflow STORE's saveWorkflow() (which calls workflow.save({force}); the
 *  dialog only comes from the Comfy.SaveWorkflow *command* path). If the
 *  workflow was never saved (or a `name` is given), it's renamed first so it
 *  lands as a real, named file. Best-effort + feature-detected. Returns the
 *  saved name, or null if it couldn't save. */
async function programmaticSave(name) {
  const svc = app?.extensionManager?.workflow;
  const wf = svc?.activeWorkflow;
  if (!wf) throw new Error("no active workflow to save");
  const wasUnsaved = wf.isTemporary === true || wf.isPersisted === false;
  // Respect a name the workflow ALREADY carries. A workflow can be unsaved yet
  // already named — e.g. rename_workflow set its title/path but it hasn't hit
  // disk. In that case auto-naming would clobber the user's chosen name, so we
  // only mint a fresh auto-name for a genuinely placeholder ("Unsaved Workflow"
  // / "Untitled …") workflow. A named-but-unsaved workflow saves in place.
  const currentName = (wf.filename || "").replace(/\.json$/i, "").trim();
  const needsAutoName = wasUnsaved && isDefaultWorkflowName(currentName);
  // Rename FIRST when we want a specific/auto name, so it persists under that
  // name (renameWorkflow does the store bookkeeping; path needs the prefix).
  const desired = (name ? String(name) : needsAutoName ? autoWorkflowName() : "")
    .replace(/\.json$/i, "")
    .trim();
  if (desired && typeof svc.renameWorkflow === "function") {
    const target = `workflows/${desired}.json`;
    if (wf.path !== target) {
      try {
        await svc.renameWorkflow(wf, target);
      } catch {
        /* keep going — we'll still save under the current name */
      }
    }
  }
  if (typeof svc.saveWorkflow === "function") await svc.saveWorkflow(wf);
  else if (typeof wf.save === "function") await wf.save();
  else throw new Error("workflow save API unavailable on this frontend");
  return desired || wf.filename || getWorkflowTitle();
}

/** If the open workflow was never saved to disk, save it (no dialog) so the
 *  agent works from a grounded file. Best-effort. Returns the saved name or null. */
async function groundUnsavedWorkflow() {
  try {
    const wf = app?.extensionManager?.workflow?.activeWorkflow;
    if (!wf || (wf.isPersisted !== false && wf.isTemporary !== true)) return null;
    return await programmaticSave();
  } catch {
    return null; // best-effort — never block the chat on a save hiccup
  }
}

/** Resolve on the next animation frame (or a short timer when rAF is absent) so
 *  a just-loaded graph can finish rendering / capturing state before we read it. */
function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/** Opening a workflow must NOT leave it flagged modified. ComfyUI re-serializes
 *  the graph on load, then the change tracker compares that re-serialized state
 *  against the differently-formatted on-disk JSON (via a graphChanged capture
 *  that fires AFTER openWorkflow resolves) — a spurious diff that flips a
 *  freshly-opened, unedited workflow to modified:true, which later blocks an
 *  unforced close. Re-baseline the tracker to the just-loaded graph so a clean
 *  open stays modified:false. This mirrors what the frontend's own save() does
 *  (changeTracker.reset(); isModified = false), minus the disk write — opening
 *  from disk means the loaded graph already IS the saved state. Best-effort +
 *  feature-detected; never throws. */
async function clearSpuriousOpenModified(wf) {
  if (!wf) return;
  try {
    // Wait for the load's post-render state capture to settle, otherwise we'd
    // re-baseline before the spurious modification is recorded.
    await nextFrame();
    const ct = wf.changeTracker;
    // Bring activeState up to date with the loaded graph, then make that the
    // baseline so initialState === activeState (graphEqual → not modified).
    ct?.captureCanvasState?.();
    ct?.reset?.();
    if (wf.isModified === true) {
      try {
        wf.isModified = false; // settable flag on current builds
      } catch {
        /* getter-only on older builds — reset() above already re-baselined */
      }
    }
  } catch (err) {
    console.warn(
      "[comfyui-mcp-panel] could not clear post-open modified flag:",
      err?.message ?? err,
    );
  }
}

/** Call the BUILT-IN ComfyUI Manager v2 API (the same surface the "Extensions"
 *  UI uses via useComfyManagerService). Because the panel runs inside the
 *  frontend, api.fetchApi resolves the identical URL the UI hits — so this works
 *  against the bundled Desktop Manager without the MCP/cm-cli path. */
async function managerV2(route, { method = "GET", body } = {}) {
  const res = await api.fetchApi(`/v2/${route}`, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res || res.status === 404) {
    throw new Error("ComfyUI-Manager not reachable (is the built-in Manager enabled?)");
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.message) msg = j.message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Manager ${route}: ${msg}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

/** Build a ComfyUI /view URL for an output image descriptor. */
function imageViewUrl(img) {
  const qs = new URLSearchParams({
    filename: img.filename ?? "",
    subfolder: img.subfolder ?? "",
    type: img.type ?? "output",
  }).toString();
  const path = `/view?${qs}`;
  try {
    return typeof api?.apiURL === "function" ? api.apiURL(path) : path;
  } catch {
    return path;
  }
}

// ---- Media metadata helpers ------------------------------------------------
// Used to enrich the `executed` agent_event note (and a structured `metadata`
// field) with render context: file size, pixel dimensions, render duration, etc.
// Every gatherer is RESILIENT — it resolves to null on any failure and never
// throws, so a flaky HEAD / decode can't drop the agent_event itself.

/** Humanize a byte count → "1.8 MB" / "640 KB". Returns null for unknown. */
function humanizeBytes(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(1)} ${u[i]}`;
}

/** Format a render duration (ms) → "3.1s" / "42s" / "3m 6s". Null if invalid. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/** Local wall-clock time the run finished, e.g. "11:13:07". */
function formatClock(date) {
  try {
    return date.toLocaleTimeString();
  } catch {
    return null;
  }
}

/** HEAD an image's /view URL and read Content-Length. Resolves bytes or null.
 *  Bounded by an AbortController timeout so a stalled HEAD can never delay the
 *  run-finished agent_event (metadata is best-effort; the frame must always send). */
async function fetchImageBytes(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    if (!res || !res.ok) return null;
    const len = res.headers.get("content-length");
    if (!len) return null;
    const n = parseInt(len, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Load an Image() from a /view URL to read natural pixel dimensions. Resolves
 *  {w,h} or null. Bounded by a timeout so a stuck decode can't hang the flush. */
function fetchImageDimensions(url) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), 8000);
      img.onload = () =>
        finish(img.naturalWidth && img.naturalHeight
          ? { w: img.naturalWidth, h: img.naturalHeight }
          : null);
      img.onerror = () => finish(null);
      img.src = url;
    } catch {
      resolve(null);
    }
  });
}

// ---- VIDEO → STORYBOARD (contact sheet) config -----------------------------
// When a VIDEO output lands the panel can't show the agent the raw .mp4 (the
// vision path only accepts images), so it samples frames in-browser and composes
// a single contact-sheet PNG the agent CAN see. Tunable constants:
const STORYBOARD = {
  COLS: 5, // grid columns
  ROWS: 4, // grid rows  → COLS*ROWS = frame count (default 20, i.e. "2×5"-style sheet)
  CELL_W: 256, // px width of each cell (height derives from video aspect)
  GAP: 6, // px gap between cells
  PAD: 8, // px outer padding
  LABEL: true, // draw a small frame-index label in each cell
  HEAD: 0.05, // skip the first 5% (likely black/fade-in)
  TAIL: 0.95, // stop at 95% (likely black/fade-out)
  SEEK_TIMEOUT_MS: 4000, // per-frame seek guard
  META_TIMEOUT_MS: 15000, // loadedmetadata guard
};
function storyboardFrameCount() {
  return Math.max(1, STORYBOARD.COLS * STORYBOARD.ROWS);
}

/** Await a one-shot media event (e.g. 'seeked', 'loadedmetadata') with a timeout
 *  guard so a wedged decode can't hang the storyboard pipeline forever. */
function awaitMediaEvent(el, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      el.removeEventListener(name, onEv);
      clearTimeout(timer);
      ok ? resolve() : reject(err);
    };
    const onEv = () => finish(true);
    const timer = setTimeout(() => finish(false, new Error(`${name} timeout`)), timeoutMs);
    el.addEventListener(name, onEv, { once: true });
  });
}

/**
 * Build a contact-sheet/storyboard PNG from a same-origin video URL by sampling
 * N frames evenly across HEAD..TAIL of its duration and tiling them into a grid.
 * Same-origin /view means the canvas is NOT tainted, so toBlob works. Returns a
 * PNG Blob, or null if the video can't be decoded/sampled. Never throws.
 */
async function buildVideoStoryboard(url) {
  const video = document.createElement("video");
  video.muted = true;
  video.setAttribute("muted", "");
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  // Keep it off-layout but attached so some browsers actually decode/seek.
  video.style.cssText = "position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);

  const cleanup = () => {
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch {
      /* best-effort */
    }
    video.remove();
  };

  try {
    await awaitMediaEvent(video, "loadedmetadata", STORYBOARD.META_TIMEOUT_MS);
    const duration = Number(video.duration);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!isFinite(duration) || duration <= 0 || !vw || !vh) return null;

    const n = storyboardFrameCount();
    const cellW = STORYBOARD.CELL_W;
    const cellH = Math.max(1, Math.round((cellW * vh) / vw));
    const cols = STORYBOARD.COLS;
    const rows = STORYBOARD.ROWS;
    const gap = STORYBOARD.GAP;
    const pad = STORYBOARD.PAD;

    const canvas = document.createElement("canvas");
    canvas.width = pad * 2 + cols * cellW + (cols - 1) * gap;
    canvas.height = pad * 2 + rows * cellH + (rows - 1) * gap;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#111114";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Evenly-spaced timestamps across HEAD..TAIL (skip likely-black head/tail).
    const lo = duration * STORYBOARD.HEAD;
    const hi = duration * STORYBOARD.TAIL;
    const span = Math.max(0, hi - lo);

    let painted = 0;
    for (let i = 0; i < n; i += 1) {
      const t = n === 1 ? duration / 2 : lo + (span * i) / (n - 1);
      try {
        video.currentTime = Math.min(Math.max(0, t), Math.max(0, duration - 0.01));
        await awaitMediaEvent(video, "seeked", STORYBOARD.SEEK_TIMEOUT_MS);
      } catch {
        continue; // skip a frame that won't seek; keep building the rest
      }
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = pad + col * (cellW + gap);
      const y = pad + row * (cellH + gap);
      try {
        ctx.drawImage(video, x, y, cellW, cellH);
        painted += 1;
      } catch {
        continue; // a single bad frame shouldn't kill the sheet
      }
      if (STORYBOARD.LABEL) {
        ctx.font = "10px monospace";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(x + 2, y + 2, 22, 13);
        ctx.fillStyle = "#e6e6e6";
        ctx.fillText(String(i + 1).padStart(2, "0"), x + 4, y + 4);
      }
    }
    if (!painted) return null;

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob || null;
  } catch {
    return null; // decode/seek/metadata failure → caller falls back to video-only
  } finally {
    cleanup();
  }
}

/** Current workflow title for this tab. */
function getWorkflowTitle() {
  // document.title is "<name> - ComfyUI" with a leading "*" when unsaved.
  const t = document.title.replace(/ - ComfyUI$/, "").replace(/^\*/, "").trim();
  return t || "untitled";
}

// ---------------------------------------------------------------------------
// Graph-edit executor — the client side of the agent's panel_* tools.
//
// Fixed allowlist of mutations against the open LiteGraph graph. Every entry
// returns a JSON-serializable result object; failures throw and the error
// string rides back to the agent so it can self-correct. All mutations are
// sandwiched in beforeChange/afterChange for native undo integration.
//
// TODO(v2): replace direct app.graph / LiteGraph access with NodeHandle /
// WidgetHandle from @comfyorg/extension-api once it ships.
// ---------------------------------------------------------------------------

const MAX_STATE_NODES = 100;

function getGraphCtx() {
  // app.canvas.graph is the graph the user is LOOKING at — the root graph or
  // an opened subgraph — so reads and edits target what's on screen.
  const graph = app?.canvas?.graph ?? app?.graph;
  const LG = window.LiteGraph ?? globalThis.LiteGraph;
  if (!app || !graph || !LG) {
    throw new Error("ComfyUI graph is not available (app.graph / LiteGraph missing)");
  }
  return { app, graph, rootGraph: app.graph, canvas: app.canvas, LG };
}

/** Reach a Pinia store by id. Pinia attaches itself as `$pinia` on the Vue app's
 *  globalProperties; the Vue app instance hangs off its mount element (#vue-app)
 *  as `__vue_app__`; `_s` is pinia's id→store map. Returns null if unavailable. */
function getPiniaStore(id) {
  try {
    const el = document.getElementById("vue-app") || document.querySelector("[id*='vue']");
    const pinia = el?.__vue_app__?.config?.globalProperties?.$pinia;
    return pinia?._s?.get?.(id) ?? null;
  } catch {
    return null;
  }
}

/** Reach ComfyUI's subgraph widget-promotion store (id "promotion"; methods
 *  promote/demote/isPromoted) — the state that exposes an inner subgraph widget
 *  on the parent SubgraphNode. */
function getPromotionStore() {
  const store = getPiniaStore("promotion");
  if (!store || typeof store.promote !== "function") {
    throw new Error("widget-promotion unavailable on this ComfyUI frontend (no 'promotion' store)");
  }
  return store;
}

/** Reach ComfyUI's subgraph-blueprint store (id "subgraph"). Exposes
 *  publishSubgraph(name?), getBlueprint(type), subgraphBlueprints (saved defs),
 *  and typePrefix ("SubgraphBlueprint.") — the save/list/load surface for reusable
 *  subgraphs. */
function getSubgraphStore() {
  const store = getPiniaStore("subgraph");
  if (!store || typeof store.publishSubgraph !== "function") {
    throw new Error(
      "subgraph blueprints unavailable on this ComfyUI frontend (no 'subgraph' store)",
    );
  }
  return store;
}

function uniqueSubgraphInputName(subgraph, baseName) {
  const names = new Set((subgraph?.inputs ?? []).map((input) => input?.name).filter(Boolean));
  if (!names.has(baseName)) return baseName;
  let i = 1;
  while (names.has(`${baseName}_${i}`)) i++;
  return `${baseName}_${i}`;
}

function uniqueSubgraphOutputName(subgraph, baseName) {
  const names = new Set((subgraph?.outputs ?? []).map((output) => output?.name).filter(Boolean));
  if (!names.has(baseName)) return baseName;
  let i = 1;
  while (names.has(`${baseName}_${i}`)) i++;
  return `${baseName}_${i}`;
}

/** Find the parent SubgraphNode that hosts a given Subgraph instance (searching
 *  from root through nested subgraphs), so its promoted views can be refreshed
 *  after a boundary I/O change. Returns null if it can't be located. */
function findSubgraphHostNode(subgraph) {
  const root = app?.graph;
  if (!root || !subgraph) return null;
  const stack = [...(root._nodes ?? [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.subgraph === subgraph) return node;
    if (node.subgraph?._nodes?.length) stack.push(...node.subgraph._nodes);
  }
  return null;
}

function getWidgetSlot(node, widget) {
  if (typeof node.getSlotFromWidget === "function") return node.getSlotFromWidget(widget);
  return (node.inputs ?? []).find((input) => input?.widget?.name === widget.name);
}

function resolveSubgraphLink(subgraph, linkId) {
  const link =
    typeof subgraph?.getLink === "function"
      ? subgraph.getLink(linkId)
      : (subgraph?.links ?? []).find((entry) => Number(entry?.id ?? entry?.[0]) === Number(linkId));
  if (!link) return null;
  if (typeof link.resolve === "function") return link.resolve(subgraph);

  const originId = link.origin_id ?? link[1];
  const originSlot = link.origin_slot ?? link[2];
  const targetId = link.target_id ?? link[3];
  const targetSlot = link.target_slot ?? link[4];
  const inputNode = subgraph.getNodeById?.(targetId);
  const outputNode = subgraph.getNodeById?.(originId);
  return {
    inputNode,
    input: inputNode?.inputs?.[targetSlot],
    outputNode,
    output: outputNode?.outputs?.[originSlot],
  };
}

function sourceForSubgraphInput(subgraphNode, subgraphInput) {
  for (const linkId of subgraphInput?.linkIds ?? []) {
    const resolved = resolveSubgraphLink(subgraphNode.subgraph, linkId);
    const inputNode = resolved?.inputNode;
    const targetInput = resolved?.input;
    if (!inputNode || !targetInput) continue;
    const targetWidget =
      typeof inputNode.getWidgetFromSlot === "function"
        ? inputNode.getWidgetFromSlot(targetInput)
        : inputNode.widgets?.find((widget) => widget?.name === targetInput.widget?.name);
    return {
      sourceNodeId: String(inputNode.id),
      sourceWidgetName: targetWidget?.name ?? targetInput.name,
    };
  }
  return null;
}

function findPromotedHostInput(subgraphNode, source) {
  return (subgraphNode.inputs ?? []).find((input) => {
    const subgraphInput = input?._subgraphSlot;
    if (!subgraphInput) return false;
    const linkedSource = sourceForSubgraphInput(subgraphNode, subgraphInput);
    return (
      linkedSource?.sourceNodeId === source.sourceNodeId &&
      linkedSource.sourceWidgetName === source.sourceWidgetName
    );
  });
}

function promoteWidgetByLink(subgraphNode, sourceNode, sourceWidget) {
  const subgraph = subgraphNode.subgraph;
  if (!subgraph || typeof subgraph.addInput !== "function") {
    throw new Error("link-only promotion unavailable on this frontend (missing subgraph.addInput)");
  }

  const source = { sourceNodeId: String(sourceNode.id), sourceWidgetName: sourceWidget.name };
  if (findPromotedHostInput(subgraphNode, source)) return { changed: false };

  const sourceSlot = getWidgetSlot(sourceNode, sourceWidget);
  if (!sourceSlot) {
    throw new Error(`Widget "${sourceWidget.name}" is not backed by a connectable input slot`);
  }

  const inputName = uniqueSubgraphInputName(subgraph, sourceWidget.name);
  const inputType = String(sourceSlot.type ?? sourceWidget.type ?? "*");
  const subgraphInput = subgraph.addInput(inputName, inputType);
  subgraphInput.label = sourceSlot.label;

  const link =
    typeof subgraphInput.connect === "function" ? subgraphInput.connect(sourceSlot, sourceNode) : null;

  if (!link) {
    subgraph.removeInput?.(subgraphInput);
    throw new Error(`Could not link subgraph input "${inputName}" to widget "${sourceWidget.name}"`);
  }

  const hostInput = (subgraphNode.inputs ?? []).find((input) => input?._subgraphSlot === subgraphInput);
  if (hostInput) hostInput.label = sourceSlot.label;
  subgraphNode.invalidatePromotedViews?.();
  return { changed: true, input: inputName };
}

function demoteWidgetByLink(subgraphNode, source) {
  const hostInput = findPromotedHostInput(subgraphNode, source);
  const subgraphInput = hostInput?._subgraphSlot;
  if (!subgraphInput) return { changed: false };

  if (hostInput.link != null && typeof subgraphInput.disconnect === "function") {
    subgraphInput.disconnect();
  } else if (typeof subgraphNode.subgraph?.removeInput === "function") {
    subgraphNode.subgraph.removeInput(subgraphInput);
  } else {
    throw new Error("link-only demotion unavailable on this frontend (missing subgraph.removeInput)");
  }

  subgraphNode.invalidatePromotedViews?.();
  return { changed: true, input: hostInput.name ?? subgraphInput.name };
}

function refreshPromotedParents(parents, canvas) {
  for (const parent of parents) {
    parent.computeSize?.(parent.size);
    parent.setDirtyCanvas?.(true, true);
  }
  canvas?.setDirty?.(true, true);
}

/** Where is the user looking right now — root graph or inside a subgraph? */
function describeActiveGraph(graph) {
  if (!app?.graph || graph === app.graph) return { scope: "root" };
  const owner = (app.graph._nodes ?? []).find((n) => n.subgraph === graph);
  return {
    scope: "subgraph",
    owner_node_id: owner?.id ?? null,
    title: owner?.title ?? graph?.name ?? "subgraph",
  };
}

// ---- per-turn graph snapshots (rollback foundation, #44) -------------------
// Before each turn that may edit the graph, capture the ROOT workflow JSON so a
// whole turn's worth of agent edits can be reverted to a known-good point in one
// step (ComfyUI's Ctrl+Z is per-operation; this is per-turn). Bounded ring,
// correlated to the message id that started the turn. In-memory for this session.
const GRAPH_SNAPSHOTS_MAX = 25;
const graphSnapshots = []; // [{ mid, ts, label, data }], oldest → newest

function captureGraphSnapshot(mid, label) {
  try {
    const data = getGraphCtx().rootGraph.serialize();
    graphSnapshots.push({ mid, ts: Date.now(), label: (label || "").slice(0, 80), data });
    while (graphSnapshots.length > GRAPH_SNAPSHOTS_MAX) graphSnapshots.shift();
  } catch {
    // graph unavailable — this turn just won't have a restore point.
  }
}

// Restore the canvas to a given snapshot. Returns the snapshot, or null on fail.
function restoreSnapshot(snap) {
  if (!snap) return null;
  try {
    // Deep-clone so the stored snapshot isn't mutated by the live graph after load.
    getGraphCtx().app.loadGraphData(JSON.parse(JSON.stringify(snap.data)));
    return snap;
  } catch {
    return null;
  }
}

// Restore the canvas to the most recent pre-turn snapshot (undo the last turn's edits).
function revertGraphToLastSnapshot() {
  return restoreSnapshot(graphSnapshots[graphSnapshots.length - 1]);
}

// ---- manual-edit awareness --------------------------------------------------
// At each turn END we snapshot the graph the agent left behind (lastAgentGraph).
// When the user sends their next message we diff the LIVE graph against it — any
// difference is a MANUAL edit (the agent only acts during its own turn) — and
// prepend a compact change-list to the agent's input so it isn't caught unaware
// of edits the user made by hand (a bypassed node, a tweaked widget, a rewire).
let lastAgentGraph = null;

const MODE_NAME = { 0: "active", 2: "mute", 4: "bypass" };
const modeName = (m) => MODE_NAME[m] ?? `mode${m ?? 0}`;
// Serialized link = [id, origin_id, origin_slot, target_id, target_slot, type].
// Compare by ENDPOINTS (link ids churn on every edit), not by id.
const linkKey = (l) => `${l[1]}:${l[2]}->${l[3]}:${l[4]}`;
function widgetName(liveGraph, nodeId, i) {
  try {
    const w = liveGraph?.getNodeById?.(Number(nodeId))?.widgets?.[i];
    if (w && w.name) return w.name;
  } catch {}
  return `#${i}`;
}
function shortVal(v) {
  const s = String(typeof v === "string" ? v : (JSON.stringify(v) ?? "")).replace(/\s+/g, " ");
  return s.length > 40 ? s.slice(0, 37) + "…" : s;
}

// Diff two serialized root graphs (prev → curr) into compact, LLM-readable lines.
// Reports node add/remove, mode (bypass/mute) changes, widget-value changes, title
// changes, and connection add/remove. Ignores pure moves/resizes/recolors (noise).
function diffGraphsForAgent(prev, curr, liveGraph) {
  if (!prev || !curr) return [];
  const lines = [];
  const P = new Map((prev.nodes || []).map((n) => [n.id, n]));
  const C = new Map((curr.nodes || []).map((n) => [n.id, n]));
  const label = (n) => `${n.id} ${n.type}${n.title && n.title !== n.type ? ` "${n.title}"` : ""}`;
  for (const [id, n] of C) if (!P.has(id)) lines.push(`+ added ${label(n)}`);
  for (const [id, n] of P) if (!C.has(id)) lines.push(`− removed ${label(n)}`);
  for (const [id, c] of C) {
    const p = P.get(id);
    if (!p) continue;
    if ((c.mode ?? 0) !== (p.mode ?? 0))
      lines.push(`• ${label(c)}: mode ${modeName(p.mode)} → ${modeName(c.mode)}`);
    if ((p.title || "") !== (c.title || ""))
      lines.push(`• ${id}: title "${p.title ?? ""}" → "${c.title ?? ""}"`);
    const pv = p.widgets_values, cv = c.widgets_values;
    if (JSON.stringify(pv) !== JSON.stringify(cv)) {
      if (Array.isArray(pv) && Array.isArray(cv)) {
        for (let i = 0; i < Math.max(pv.length, cv.length); i++) {
          if (JSON.stringify(pv[i]) === JSON.stringify(cv[i])) continue;
          if ((cv[i] && typeof cv[i] === "object") || (pv[i] && typeof pv[i] === "object")) continue; // skip nested preview blobs
          lines.push(`• ${label(c)}: ${widgetName(liveGraph, id, i)} ${shortVal(pv[i])} → ${shortVal(cv[i])}`);
        }
      } else {
        lines.push(`• ${label(c)}: widgets changed`);
      }
    }
  }
  const PL = new Set((prev.links || []).map(linkKey));
  const CL = new Set((curr.links || []).map(linkKey));
  for (const l of curr.links || []) if (!PL.has(linkKey(l))) lines.push(`+ wire ${l[1]} → ${l[3]} (${l[5] || "?"})`);
  for (const l of prev.links || []) if (!CL.has(linkKey(l))) lines.push(`− wire ${l[1]} → ${l[3]} (${l[5] || "?"})`);
  return lines;
}

// Build the banner to prepend to a user turn (empty string when nothing changed).
// Consumes the baseline (resets it to the current graph) so the same edits aren't
// re-reported if the user sends twice without the agent acting in between.
function manualChangeBanner() {
  if (!lastAgentGraph) return "";
  let curr, live;
  try {
    live = getGraphCtx().rootGraph;
    curr = live.serialize();
  } catch {
    return "";
  }
  const lines = diffGraphsForAgent(lastAgentGraph, curr, live);
  lastAgentGraph = curr;
  if (!lines.length) return "";
  const MAX = 40;
  const shown = lines.slice(0, MAX);
  const more = lines.length > MAX ? `\n  …and ${lines.length - MAX} more change(s)` : "";
  return (
    `⟳ MANUAL CANVAS CHANGES since your last turn — the user edited the graph directly:\n  ` +
    shown.join("\n  ") +
    more +
    `\nTreat the canvas as being in THIS state now (it overrides what you remember); ` +
    `re-read with panel_graph_outline if the changes are substantial.\n\n`
  );
}

// Restore the canvas to the snapshot captured before the message with this mid
// (the per-message rollback). Returns the snapshot or null.
function revertGraphSnapshotByMid(mid) {
  for (let i = graphSnapshots.length - 1; i >= 0; i--) {
    if (graphSnapshots[i].mid === mid) return restoreSnapshot(graphSnapshots[i]);
  }
  return null;
}

/** Summarize one LiteGraph node for the agent — id, type, title, widget
 *  values, and input link sources. Deliberately NOT the full serialization
 *  (positions, colors, internal state) to keep token cost low. */
function summarizeNode(node) {
  const widgets = {};
  for (const w of node.widgets ?? []) {
    if (w && typeof w.name === "string") widgets[w.name] = w.value;
  }
  const inputs = (node.inputs ?? []).map((inp, i) => {
    let from = null;
    if (inp.link != null) {
      const link = node.graph?.links?.[inp.link];
      if (link) from = { node_id: link.origin_id, output_slot: link.origin_slot };
    }
    return { slot: i, name: inp.name, type: inp.type, connected_from: from };
  });
  const outputs = (node.outputs ?? []).map((out, i) => ({
    slot: i,
    name: out.name,
    type: out.type,
    links: out.links?.length ?? 0,
  }));
  // True RENDERED footprint height for layout. node.size[1] is the BODY only
  // (slots + widgets); the title BAR renders ~30px ABOVE node.pos and isn't in it,
  // so stacking by size[1] overlaps each node by a header. litegraph's getBounding
  // returns the full box (title + body, or just the title when collapsed) — stack
  // with THIS (`full_height`), not size[1].
  let fullHeight = null;
  try {
    if (typeof node.getBounding === "function") {
      const bb = node.getBounding(new Float32Array(4));
      if (bb && bb.length >= 4 && Number.isFinite(bb[3])) fullHeight = Math.round(bb[3]);
    }
  } catch {
    /* fall through to the estimate below */
  }
  if (fullHeight == null && node.size) {
    fullHeight = node.flags && node.flags.collapsed ? 30 : Math.round(node.size[1] + 30);
  }
  const summary = {
    id: node.id,
    type: node.type,
    title: node.title,
    pos: node.pos ? [Math.round(node.pos[0]), Math.round(node.pos[1])] : null,
    size: node.size ? [Math.round(node.size[0]), Math.round(node.size[1])] : null,
    ...(fullHeight != null ? { full_height: fullHeight } : {}),
    ...(node.flags && node.flags.collapsed ? { collapsed: true } : {}),
    // Execution mode — only emitted when NOT active so bypassed/muted nodes are
    // clearly visible to the agent (LiteGraph: 2 = mute, 4 = bypass, 0 = active).
    ...(node.mode ? { mode: { 2: "mute", 4: "bypass" }[node.mode] ?? `mode_${node.mode}` } : {}),
    ...(node.color ? { color: node.color } : {}),
    ...(node.bgcolor ? { bgcolor: node.bgcolor } : {}),
    // OUTPUT nodes (SaveImage/PreviewImage/SaveVideo/…) are the only valid
    // targets for panel_run's to_node_id ("run to node" partial execution).
    ...(node.constructor?.nodeData?.output_node ? { is_output: true } : {}),
    widgets,
    inputs,
    outputs,
  };
  // Subgraphs summarize SHALLOWLY — boundary slots + widgets only, plus an
  // inner node count. Drill in with graph_get_subgraph when needed.
  if (node.subgraph) {
    summary.is_subgraph = true;
    summary.subgraph_node_count =
      node.subgraph._nodes?.length ?? node.subgraph.nodes?.length ?? 0;
  }
  return summary;
}

/** The node TYPE's human description (from its ComfyUI node def), used by
 *  graph_find_nodes so the agent can search/filter on what a node does. Empty
 *  string when the frontend doesn't carry a description for this type. */
function nodeDescription(node) {
  return String(node?.constructor?.nodeData?.description ?? node?.description ?? "");
}

function resolveNode(graph, nodeId) {
  const node = graph.getNodeById(Number(nodeId));
  if (!node) throw new Error(`No node with id ${nodeId} in the current graph`);
  return node;
}

// ---- Subgraph boundary rails (input/output proxy nodes) -------------------
// LiteGraph: subgraph.inputNode.id === SUBGRAPH_INPUT_ID (-10),
//            subgraph.outputNode.id === SUBGRAPH_OUTPUT_ID (-20).
// These rail nodes are NOT in graph._nodes_by_id, so resolveNode/getNodeById
// cannot find them — rail-aware executors use resolveRail instead.
const SUBGRAPH_INPUT_RAIL_ID = -10;
const SUBGRAPH_OUTPUT_RAIL_ID = -20;
const RAIL_INPUT_ALIASES = new Set(["input", "input_rail", "inputs", "in"]);
const RAIL_OUTPUT_ALIASES = new Set(["output", "output_rail", "outputs", "out"]);

/** Resolve a node-id reference to a subgraph boundary rail, by the rail node's
 *  real id (-10 / -20) or by an alias ("input"/"output"/..). Returns
 *  { rail: "input"|"output", node } or null when it isn't a rail reference. */
function resolveRail(graph, ref) {
  const inNode = graph?.inputNode ?? null;
  const outNode = graph?.outputNode ?? null;
  if (typeof ref === "string") {
    const key = ref.trim().toLowerCase();
    if (RAIL_INPUT_ALIASES.has(key)) return inNode ? { rail: "input", node: inNode } : null;
    if (RAIL_OUTPUT_ALIASES.has(key)) return outNode ? { rail: "output", node: outNode } : null;
  }
  const num = Number(ref);
  if (Number.isFinite(num)) {
    if (inNode && (Number(inNode.id) === num || num === SUBGRAPH_INPUT_RAIL_ID))
      return { rail: "input", node: inNode };
    if (outNode && (Number(outNode.id) === num || num === SUBGRAPH_OUTPUT_RAIL_ID))
      return { rail: "output", node: outNode };
  }
  return null;
}

/** Detect rail INTENT independent of whether rails actually exist on the active
 *  graph — i.e. the reference is clearly meant to be a boundary rail (an alias,
 *  or the reserved rail ids -10/-20). Returns "input"|"output"|null. Used to give
 *  a clear error when a rail endpoint is used at the ROOT graph (no rails). */
function railIntent(ref) {
  if (typeof ref === "string") {
    const key = ref.trim().toLowerCase();
    if (RAIL_INPUT_ALIASES.has(key)) return "input";
    if (RAIL_OUTPUT_ALIASES.has(key)) return "output";
  }
  const num = Number(ref);
  if (Number.isFinite(num)) {
    if (num === SUBGRAPH_INPUT_RAIL_ID) return "input";
    if (num === SUBGRAPH_OUTPUT_RAIL_ID) return "output";
  }
  return null;
}

/** True when a rail slot reference means "make a NEW exposed slot" rather than
 *  reusing an existing one (empty string / "new" / "empty" / "+" / null). */
function isEmptyRailSlotRef(ref) {
  if (ref == null) return true;
  if (typeof ref !== "string") return false;
  const k = ref.trim().toLowerCase();
  return k === "" || k === "new" || k === "empty" || k === "+";
}

/** Find an EXISTING rail slot (SubgraphInput/SubgraphOutput) by name or index,
 *  or null if none matches. */
function findExistingRailSlot(slots, ref) {
  if (ref == null) return null;
  if (typeof ref === "number" && Number.isInteger(ref)) {
    return ref >= 0 && ref < (slots?.length ?? 0) ? slots[ref] : null;
  }
  const name = String(ref).toLowerCase();
  return (slots ?? []).find((s) => s?.name?.toLowerCase() === name) ?? null;
}

// ---- Group boxes (LiteGraph LGraphGroup) helpers --------------------------

/** Resolve a group box by id (with an index fallback for graphs whose groups
 *  don't carry ids). */
function resolveGroup(graph, groupId) {
  const groups = graph._groups ?? [];
  let g = groups.find((gr) => gr && gr.id === groupId);
  if (!g && typeof groupId === "number" && groupId >= 0 && groupId < groups.length) g = groups[groupId];
  if (!g) throw new Error(`No group with id ${groupId} in the current graph`);
  return g;
}

/** Next free group id — groups aren't always assigned one by the frontend. */
function nextGroupId(graph) {
  const ids = (graph._groups ?? []).map((g) => g.id).filter((n) => typeof n === "number");
  return (ids.length ? Math.max(...ids) : 0) + 1;
}

/** Set a group's box, preferring its _bounding array (most portable). */
function setGroupBounds(group, [x, y, w, h]) {
  if (group._bounding && group._bounding.length >= 4) {
    group._bounding[0] = x;
    group._bounding[1] = y;
    group._bounding[2] = w;
    group._bounding[3] = h;
  } else {
    group.pos = [x, y];
    group.size = [w, h];
  }
}

/** [x, y, w, h] that wraps the given nodes, padded for the group + node titles. */
function boundsAroundNodes(nodes, pad = 30, titlePad = 70) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const x = n.pos?.[0] ?? 0;
    const y = n.pos?.[1] ?? 0;
    const w = n.size?.[0] ?? 200;
    const h = n.size?.[1] ?? 100;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  if (!Number.isFinite(minX)) return [100, 100, 400, 300];
  return [minX - pad, minY - titlePad, maxX - minX + pad * 2, maxY - minY + titlePad + pad];
}

/** Compact JSON-friendly view of a group box. */
function summarizeGroup(graph, g) {
  const b = g._bounding ?? [g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.size?.[0] ?? 0, g.size?.[1] ?? 0];
  // LiteGraph groups do NOT own their nodes — membership is purely geometric
  // (which nodes sit inside the group box). Recompute it so the agent gets the
  // actual member node_ids (to wrap a group into a subgraph, toggle it as a unit,
  // etc.) instead of reconstructing membership from coordinates by hand.
  g.recomputeInsideNodes?.();
  const memberIds = (g._nodes ?? []).map((n) => n.id);
  return {
    id: g.id != null ? g.id : (graph._groups ?? []).indexOf(g),
    title: g.title ?? "",
    color: g.color ?? null,
    bounding: [Math.round(b[0]), Math.round(b[1]), Math.round(b[2]), Math.round(b[3])],
    node_count: memberIds.length,
    node_ids: memberIds,
  };
}

/** Resolve a group by numeric id (matching summarizeGroup's id) or a
 *  case-insensitive title substring. Returns the LGraphGroup or null.
 *  (Distinct from resolveGroup() above, which is id-only and throws.) */
function resolveGroupRef(graph, ref) {
  const groups = graph._groups ?? [];
  if (ref == null || ref === "") return null;
  const asNum = Number(ref);
  if (Number.isFinite(asNum) && String(ref).trim() !== "") {
    const byId = groups.find((g, i) => (g.id != null ? g.id : i) === asNum);
    if (byId) return byId;
  }
  const lc = String(ref).toLowerCase();
  return groups.find((g) => String(g.title ?? "").toLowerCase().includes(lc)) ?? null;
}

/** Dependency order (Kahn topological sort) so a reader following the list
 *  top→down follows the data flow: sources first, sinks last. Nodes left out by
 *  a cycle (shouldn't happen in a ComfyUI DAG) are appended in original order. */
function topoSortNodes(nodes, links) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) {
    for (const inp of n.inputs ?? []) {
      if (inp.link == null) continue;
      const l = links[inp.link];
      if (!l || !byId.has(l.origin_id)) continue;
      adj.get(l.origin_id).push(n.id);
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
    }
  }
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out = [];
  const seen = new Set();
  // Index cursor instead of queue.shift() — shift() is O(n), making Kahn's loop
  // O(n^2) on large/flat graphs; cursor keeps it linear.
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id));
    for (const m of adj.get(id) ?? []) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if ((indeg.get(m) ?? 0) <= 0) queue.push(m);
    }
  }
  for (const n of nodes) if (!seen.has(n.id)) out.push(n);
  return out;
}

/** Describe a subgraph's input/output "rail" nodes (the boundary I/O proxies)
 *  so layouts can sit nodes next to them instead of floating away, AND so the
 *  agent can wire internal nodes to/from the rails. Reports each rail node's id
 *  + its connectable slots:
 *   - the INPUT rail (`subgraph.inputNode`, id -10) hands OUTPUT slots to internal
 *     node inputs — listed under `provides_outputs`.
 *   - the OUTPUT rail (`subgraph.outputNode`, id -20) accepts INPUT slots from
 *     internal node outputs — listed under `accepts_inputs`.
 *  `has_empty_slot` reflects the trailing "+" slot that adds a NEW exposed I/O.
 *  The exact rail property name varies across ComfyUI versions, so probe likely ones. */
function describeRails(sub) {
  const xy = (n) => (n?.pos ? [Math.round(n.pos[0]), Math.round(n.pos[1])] : null);
  const wh = (n) => (n?.size ? [Math.round(n.size[0]), Math.round(n.size[1])] : null);
  const inNode = sub.inputNode ?? sub._inputNode ?? null;
  const outNode = sub.outputNode ?? sub._outputNode ?? null;
  const slotList = (slots) =>
    (slots ?? []).map((s, i) => ({ index: i, name: s?.name ?? null, type: s?.type ?? null }));
  return {
    input: inNode
      ? {
          rail_node_id: inNode.id,
          pos: xy(inNode),
          size: wh(inNode),
          provides_outputs: slotList(sub.inputs),
          has_empty_slot: !!inNode.emptySlot,
          aliases: ["input", "input_rail"],
        }
      : null,
    output: outNode
      ? {
          rail_node_id: outNode.id,
          pos: xy(outNode),
          size: wh(outNode),
          accepts_inputs: slotList(sub.outputs),
          has_empty_slot: !!outNode.emptySlot,
          aliases: ["output", "output_rail"],
        }
      : null,
  };
}

/** Resolve a slot reference (name string or numeric index) to an index in
 *  the given slot array. Names are matched case-insensitively. */
function resolveSlot(slots, ref, kind) {
  if (typeof ref === "number" && Number.isInteger(ref)) {
    if (ref < 0 || ref >= (slots?.length ?? 0)) {
      throw new Error(`${kind} slot index ${ref} out of range (node has ${slots?.length ?? 0})`);
    }
    return ref;
  }
  const name = String(ref).toLowerCase();
  const idx = (slots ?? []).findIndex((s) => s?.name?.toLowerCase() === name);
  if (idx === -1) {
    const names = (slots ?? []).map((s) => s?.name).join(", ");
    throw new Error(`No ${kind} slot named "${ref}" (available: ${names || "none"})`);
  }
  return idx;
}

/** Place a new node: explicit [x, y], else cascade right from the last node
 *  in the graph so repeated adds don't stack at the origin. */
function placementFor(graph, pos) {
  if (Array.isArray(pos) && pos.length === 2) return [Number(pos[0]), Number(pos[1])];
  const nodes = graph._nodes ?? [];
  const last = nodes[nodes.length - 1];
  if (last?.pos) return [last.pos[0] + (last.size?.[0] ?? 200) + 60, last.pos[1]];
  return [100, 100];
}

// The currently-mounted panel root (set by buildPanel). Used by canvas "fit" to
// measure how much of the canvas the open sidebar panel overlays.
let activePanelRoot = null;

const GRAPH_TOOL_EXECUTORS = {
  graph_get_state() {
    const { graph, rootGraph } = getGraphCtx();
    const nodes = (graph._nodes ?? []).slice(0, MAX_STATE_NODES).map(summarizeNode);
    const groups = (graph._groups ?? []).map((g) => summarizeGroup(graph, g));
    const inSubgraph = graph !== rootGraph;
    return {
      viewing: describeActiveGraph(graph),
      node_count: graph._nodes?.length ?? 0,
      truncated: (graph._nodes?.length ?? 0) > MAX_STATE_NODES,
      nodes,
      ...(groups.length ? { groups } : {}),
      ...(inSubgraph ? { rails: describeRails(graph) } : {}),
    };
  },

  // A compact, dependency-ordered TEXT outline of the open graph — built to be
  // read top→down by an LLM (sources first, sinks last). Each node is one block:
  //   id  Type "title" [mode] [OUTPUT] · group:X   widget=value …
  //      ← inputs as source_node.output_name
  //      → outputs as target_node.input_name
  // Far cheaper to read than the full JSON state, and shows the WIRING (which the
  // raw node dump makes you reconstruct). Read-only.
  graph_outline() {
    const { graph } = getGraphCtx();
    const nodes = graph._nodes ?? [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = graph.links ?? {};

    // Geometric group membership → node id → group titles, plus a title→ids index.
    const groups = graph._groups ?? [];
    const groupOf = new Map();
    const groupLines = [];
    for (const g of groups) {
      g.recomputeInsideNodes?.();
      const ids = (g._nodes ?? []).map((n) => n.id);
      const tag = { 2: " [mute]", 4: " [bypass]" }[g.mode] ?? "";
      groupLines.push(`  "${g.title ?? ""}"${tag} → ${ids.join(",") || "(empty)"}`);
      for (const id of ids) {
        if (!groupOf.has(id)) groupOf.set(id, []);
        groupOf.get(id).push(g.title ?? "");
      }
    }

    const fmtVal = (v) => {
      const s = String(typeof v === "string" ? v : JSON.stringify(v) ?? "").replace(/\s+/g, " ");
      return s.length > 60 ? s.slice(0, 57) + "…" : s;
    };
    const modeTag = (n) => ({ 2: " [mute]", 4: " [bypass]" }[n.mode] ?? "");
    const outTag = (n) => (n.constructor?.nodeData?.output_node ? " [OUTPUT]" : "");

    const lines = [];
    for (const n of topoSortNodes(nodes, links)) {
      const title = n.title && n.title !== n.type ? ` "${n.title}"` : "";
      const grps = groupOf.get(n.id);
      const groupTag = grps?.length ? ` · group:${grps.join("/")}` : "";
      const widgets = (n.widgets ?? [])
        .filter((w) => w && typeof w.name === "string")
        .map((w) => `${w.name}=${fmtVal(w.value)}`)
        .join(" ");
      lines.push(
        `${n.id}  ${n.type}${title}${modeTag(n)}${outTag(n)}${groupTag}${widgets ? "  " + widgets : ""}`,
      );
      const ins = (n.inputs ?? [])
        .map((inp) => {
          if (inp.link == null) return null;
          const l = links[inp.link];
          if (!l) return null;
          const src = byId.get(l.origin_id);
          return `${l.origin_id}.${src?.outputs?.[l.origin_slot]?.name ?? l.origin_slot}`;
        })
        .filter(Boolean);
      if (ins.length) lines.push(`     ← ${ins.join(", ")}`);
      const outs = [];
      for (const out of n.outputs ?? []) {
        for (const lid of out.links ?? []) {
          const l = links[lid];
          if (!l) continue;
          const tgt = byId.get(l.target_id);
          outs.push(`${l.target_id}.${tgt?.inputs?.[l.target_slot]?.name ?? l.target_slot}`);
        }
      }
      if (outs.length) lines.push(`     → ${outs.join(", ")}`);
    }

    const va = describeActiveGraph(graph);
    const viewingStr = va && va.scope === "subgraph" ? `subgraph "${va.title ?? ""}"` : (va?.scope ?? "root");
    const header = `${nodes.length} nodes · ${groups.length} group(s) · viewing: ${viewingStr}`;
    const outline =
      header +
      (groupLines.length ? `\n\nGROUPS (title → member node ids):\n${groupLines.join("\n")}` : "") +
      `\n\nNODES (data flows top→down; ← inputs from, → outputs to):\n${lines.join("\n")}`;

    return {
      node_count: nodes.length,
      group_count: groups.length,
      viewing: describeActiveGraph(graph),
      outline,
    };
  },

  // Pinpoint nodes in the graph the user is viewing WITHOUT dumping the whole
  // thing. Searches EVERY node (not capped like graph_get_state), applies the
  // filters, and returns only matches — each the same rich summary as
  // graph_get_state plus the node's `description` and a `matched_on` list saying
  // why it hit. Targeted filters (type/title/input/output/widget/widget_value/
  // is_output/is_subgraph/mode) are ANDed; the free-text `query` ORs across
  // type, title, description, widget names+values, and port names+types.
  graph_find_nodes({
    query,
    type,
    title,
    input,
    output,
    widget,
    widget_value,
    is_output,
    is_subgraph,
    mode,
    limit,
  } = {}) {
    const { graph } = getGraphCtx();
    const cap = Math.min(Math.max(Number(limit ?? 40), 1), 200);
    const lc = (s) => String(s ?? "").toLowerCase();
    // Safe stringify for widget values — a BigInt or circular/custom value would
    // throw in JSON.stringify and fail the whole find call; fall back to String().
    const safeJson = (v) => {
      try {
        return JSON.stringify(v) ?? String(v);
      } catch {
        return String(v);
      }
    };
    const has = (v) => typeof v === "string" && v.trim() !== "";
    const modeNum = mode ? { active: 0, mute: 2, bypass: 4 }[mode] : undefined;
    const q = has(query) ? lc(query) : null;

    const nodes = graph._nodes ?? [];
    const matches = [];
    for (const node of nodes) {
      const summary = summarizeNode(node);
      const desc = nodeDescription(node);
      const widgetEntries = Object.entries(summary.widgets ?? {});
      const matchedOn = [];

      // Targeted filters — ANDed. Every one provided must hit, or skip the node.
      if (has(type)) {
        if (!lc(node.type).includes(lc(type))) continue;
        matchedOn.push(`type:${node.type}`);
      }
      if (has(title)) {
        if (!lc(node.title).includes(lc(title))) continue;
        matchedOn.push(`title:${node.title}`);
      }
      if (has(input)) {
        const hit = (node.inputs ?? []).find(
          (i) => lc(i.name).includes(lc(input)) || lc(i.type).includes(lc(input)),
        );
        if (!hit) continue;
        matchedOn.push(`input:${hit.name}(${hit.type})`);
      }
      if (has(output)) {
        const hit = (node.outputs ?? []).find(
          (o) => lc(o.name).includes(lc(output)) || lc(o.type).includes(lc(output)),
        );
        if (!hit) continue;
        matchedOn.push(`output:${hit.name}(${hit.type})`);
      }
      if (has(widget)) {
        const hit = widgetEntries.find(([n]) => lc(n).includes(lc(widget)));
        if (!hit) continue;
        matchedOn.push(`widget:${hit[0]}`);
      }
      if (has(widget_value)) {
        const hit = widgetEntries.find(([, v]) => lc(safeJson(v)).includes(lc(widget_value)));
        if (!hit) continue;
        matchedOn.push(`widget_value:${hit[0]}=${String(hit[1]).slice(0, 60)}`);
      }
      if (is_output === true && !summary.is_output) continue;
      if (is_output === false && summary.is_output) continue;
      if (is_subgraph === true && !summary.is_subgraph) continue;
      if (is_subgraph === false && summary.is_subgraph) continue;
      if (modeNum !== undefined && (node.mode ?? 0) !== modeNum) continue;

      // Free-text query — ORed across every searchable field. matched_on records
      // which fields hit so the agent sees WHY a node matched.
      if (q) {
        const hits = [];
        if (lc(node.type).includes(q)) hits.push(`type:${node.type}`);
        if (lc(node.title).includes(q)) hits.push(`title:${node.title}`);
        if (lc(desc).includes(q)) hits.push("description");
        for (const [n, v] of widgetEntries) {
          if (lc(n).includes(q)) hits.push(`widget:${n}`);
          else if (lc(safeJson(v)).includes(q))
            hits.push(`widget_value:${n}=${String(v).slice(0, 60)}`);
        }
        for (const i of node.inputs ?? [])
          if (lc(i.name).includes(q) || lc(i.type).includes(q)) hits.push(`input:${i.name}(${i.type})`);
        for (const o of node.outputs ?? [])
          if (lc(o.name).includes(q) || lc(o.type).includes(q)) hits.push(`output:${o.name}(${o.type})`);
        if (!hits.length) continue;
        matchedOn.push(...hits);
      }

      matches.push({
        ...summary,
        ...(desc ? { description: desc.slice(0, 240) } : {}),
        ...(matchedOn.length ? { matched_on: matchedOn } : {}),
      });
      if (matches.length >= cap) break;
    }

    return {
      viewing: describeActiveGraph(graph),
      total: nodes.length,
      count: matches.length,
      truncated: matches.length >= cap,
      matches,
    };
  },

  graph_get_subgraph({ node_id }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const sub = node.subgraph;
    if (!sub) throw new Error(`Node ${node.id} (${node.type}) is not a subgraph`);
    const inner = [...(sub._nodes ?? sub.nodes ?? [])];
    return {
      subgraph_of: { node_id: node.id, title: node.title },
      node_count: inner.length,
      truncated: inner.length > MAX_STATE_NODES,
      nodes: inner.slice(0, MAX_STATE_NODES).map(summarizeNode),
    };
  },

  graph_add_node({ class_type, pos, title }) {
    const { graph, LG } = getGraphCtx();
    if (!class_type || typeof class_type !== "string") {
      throw new Error("class_type (string) is required");
    }
    const node = LG.createNode(class_type);
    if (!node) {
      throw new Error(
        `Unknown node type "${class_type}" — check the exact class_type via panel_get_graph or panel_search_nodes`,
      );
    }
    graph.beforeChange();
    try {
      node.pos = placementFor(graph, pos);
      if (title && typeof title === "string") node.title = title;
      graph.add(node);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { added: summarizeNode(node) };
  },

  graph_remove_node({ node_id }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const summary = summarizeNode(node);
    graph.beforeChange();
    try {
      graph.remove(node);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { removed: summary };
  },

  graph_clear() {
    const { graph } = getGraphCtx();
    const nodes = [...(graph._nodes ?? [])];
    // Remove node-by-node inside ONE beforeChange/afterChange pair rather
    // than graph.clear(): the whole wipe becomes a single Ctrl+Z step.
    graph.beforeChange();
    try {
      for (const node of nodes) graph.remove(node);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { cleared: nodes.length };
  },

  // Load a COMPLETE workflow onto the live canvas in one shot (replaces the
  // current graph), so a ready pack/template graph lands without recreating it
  // node-by-node. Mirrors restoreSnapshot's app.loadGraphData(...) path.
  graph_load({ graph: incoming } = {}) {
    const { app } = getGraphCtx();
    // Accept a JSON string or an object.
    let data = incoming;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (err) {
        throw new Error(`graph is not valid JSON: ${err?.message ?? err}`);
      }
    }
    if (!data || typeof data !== "object") {
      throw new Error("graph (object or JSON string) is required");
    }
    // Validate UI/litegraph format. The live canvas loads UI-format graphs
    // (top-level `nodes` array); API/prompt format (top-level numeric keys, each
    // an object with `class_type`) is NOT loadable here.
    if (!Array.isArray(data.nodes)) {
      const keys = Object.keys(data);
      const looksLikeApi =
        keys.length > 0 &&
        keys.every((k) => /^\d+$/.test(k)) &&
        keys.some((k) => data[k] && typeof data[k] === "object" && "class_type" in data[k]);
      if (looksLikeApi) {
        throw new Error(
          "workflow is in API/prompt format; provide the UI workflow JSON (the pack workflow.json is UI format)",
        );
      }
      throw new Error(
        "graph is not a UI workflow (missing a `nodes` array). Provide the UI workflow JSON.",
      );
    }
    if (typeof app.loadGraphData !== "function") {
      throw new Error("app.loadGraphData is unavailable on this frontend");
    }
    // Deep-clone so the loaded graph can't be mutated by, nor mutate, the source.
    const clone = JSON.parse(JSON.stringify(data));
    // Sanitize node metadata that ComfyUI's workflow zod schema rejects, so an
    // imperfect pack/template still loads instead of erroring out. `aux_id` must be
    // 'github-user/repo-name' (or absent) — packs/exports sometimes carry a bare
    // node name (e.g. "GetNode"/"SetNode"); drop those invalid install-hints rather
    // than let the whole load fail validation.
    const AUX_ID_RE = /^[^/\s]+\/[^/\s]+$/;
    let auxSanitized = 0;
    const sanitizeNodes = (nodes) => {
      for (const n of nodes || []) {
        const aux = n?.properties?.aux_id;
        if (aux != null && !(typeof aux === "string" && AUX_ID_RE.test(aux))) {
          delete n.properties.aux_id;
          auxSanitized++;
        }
      }
    };
    sanitizeNodes(clone.nodes);
    // Recurse into subgraph DEFINITIONS — their inner nodes (e.g. KJNodes
    // Get/Set) carry the same malformed aux_id and would fail validation too.
    for (const sg of clone.definitions?.subgraphs ?? []) sanitizeNodes(sg.nodes);
    // Snapshot the current graph FIRST so the load is undoable via the per-turn
    // revert (double-Esc / revert), like every other graph edit this turn.
    captureGraphSnapshot(null, "before graph_load");
    app.loadGraphData(clone);
    return {
      loaded: true,
      node_count: clone.nodes.length,
      ...(auxSanitized ? { aux_id_sanitized: auxSanitized } : {}),
    };
  },

  graph_connect({ from_node_id, from_output, to_node_id, to_input }) {
    const { graph } = getGraphCtx();

    // Rail tolerance: when an endpoint is a subgraph boundary rail (by real id
    // -10/-20 or alias "input"/"output"/..), route to the boundary I/O logic
    // instead of throwing "No node with id". Normal node-to-node connect below
    // is unchanged.
    const fromRail = resolveRail(graph, from_node_id);
    const toRail = resolveRail(graph, to_node_id);

    if (toRail?.rail === "output") {
      // internal node OUTPUT -> subgraph OUTPUT rail.
      const node = resolveNode(graph, from_node_id);
      const outIdx = resolveSlot(node.outputs, from_output ?? 0, "output");
      const outputSlot = node.outputs[outIdx];
      const existing = isEmptyRailSlotRef(to_input)
        ? null
        : findExistingRailSlot(graph.outputs, to_input);
      if (existing && typeof existing.connect === "function") {
        graph.beforeChange?.();
        let link;
        try {
          link = existing.connect(outputSlot, node);
        } finally {
          graph.afterChange?.();
        }
        if (!link) {
          throw new Error(
            `connect refused — node ${node.id} output "${outputSlot?.name ?? outIdx}" ` +
              `(${outputSlot?.type}) is not compatible with subgraph output "${existing.name}" (${existing.type})`,
          );
        }
        graph.setDirtyCanvas?.(true, true);
        findSubgraphHostNode(graph)?.invalidatePromotedViews?.();
        return {
          connected: {
            from: { node_id: node.id, output: outputSlot?.name ?? outIdx },
            to: { subgraph_output: existing.name },
          },
        };
      }
      return GRAPH_TOOL_EXECUTORS.graph_expose_subgraph_output({
        from_node_id,
        from_output,
        name: typeof to_input === "string" && !isEmptyRailSlotRef(to_input) ? to_input : undefined,
      });
    }

    if (fromRail?.rail === "input") {
      // subgraph INPUT rail -> internal node INPUT.
      const node = resolveNode(graph, to_node_id);
      const inIdx = resolveSlot(node.inputs, to_input ?? 0, "input");
      const inputSlot = node.inputs[inIdx];
      const existing = isEmptyRailSlotRef(from_output)
        ? null
        : findExistingRailSlot(graph.inputs, from_output);
      if (existing && typeof existing.connect === "function") {
        graph.beforeChange?.();
        let link;
        try {
          link = existing.connect(inputSlot, node);
        } finally {
          graph.afterChange?.();
        }
        if (!link) {
          throw new Error(
            `connect refused — subgraph input "${existing.name}" (${existing.type}) is not ` +
              `compatible with node ${node.id} input "${inputSlot?.name ?? inIdx}" (${inputSlot?.type})`,
          );
        }
        graph.setDirtyCanvas?.(true, true);
        findSubgraphHostNode(graph)?.invalidatePromotedViews?.();
        return {
          connected: {
            from: { subgraph_input: existing.name },
            to: { node_id: node.id, input: inputSlot?.name ?? inIdx },
          },
        };
      }
      return GRAPH_TOOL_EXECUTORS.graph_expose_subgraph_input({
        to_node_id,
        to_input,
        name:
          typeof from_output === "string" && !isEmptyRailSlotRef(from_output) ? from_output : undefined,
      });
    }

    if (fromRail?.rail === "output") {
      throw new Error(
        'cannot connect FROM the output rail — set from_node_id to an internal node and to_node_id to "output"',
      );
    }
    if (toRail?.rail === "input") {
      throw new Error(
        'cannot connect TO the input rail — set from_node_id to "input" and to_node_id to an internal node',
      );
    }

    // Rail INTENT without resolvable rails: the endpoint is clearly a rail
    // reference (alias or id -10/-20) but the active graph has none — i.e. we're
    // at the root graph. Fail clearly instead of falling through to the normal
    // node path (which would throw the confusing "No node with id output").
    const fromIntent = railIntent(from_node_id);
    const toIntent = railIntent(to_node_id);
    if ((fromIntent && !fromRail) || (toIntent && !toRail)) {
      const ref = toIntent && !toRail ? to_node_id : from_node_id;
      throw new Error(
        `Rail endpoint "${ref}" is only valid inside a subgraph — enter the subgraph first ` +
          `(graph_enter_subgraph), then expose I/O with graph_expose_subgraph_output / graph_expose_subgraph_input.`,
      );
    }

    const origin = resolveNode(graph, from_node_id);
    const target = resolveNode(graph, to_node_id);
    const outIdx = resolveSlot(origin.outputs, from_output ?? 0, "output");
    const inIdx = resolveSlot(target.inputs, to_input ?? 0, "input");
    graph.beforeChange();
    let link;
    try {
      link = origin.connect(outIdx, target, inIdx);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    if (!link) {
      throw new Error(
        `connect refused — output "${origin.outputs?.[outIdx]?.name}" (${origin.outputs?.[outIdx]?.type}) ` +
          `is not compatible with input "${target.inputs?.[inIdx]?.name}" (${target.inputs?.[inIdx]?.type})`,
      );
    }
    return {
      connected: {
        from: { node_id: origin.id, output: origin.outputs?.[outIdx]?.name ?? outIdx },
        to: { node_id: target.id, input: target.inputs?.[inIdx]?.name ?? inIdx },
      },
    };
  },

  graph_disconnect({ node_id, input }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const inIdx = resolveSlot(node.inputs, input ?? 0, "input");
    graph.beforeChange();
    try {
      node.disconnectInput(inIdx);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return {
      disconnected: { node_id: node.id, input: node.inputs?.[inIdx]?.name ?? inIdx },
    };
  },

  graph_set_widget({ node_id, widget, value }) {
    const { app, graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const w = (node.widgets ?? []).find(
      (cand) => cand?.name?.toLowerCase() === String(widget).toLowerCase(),
    );
    if (!w) {
      const names = (node.widgets ?? []).map((cand) => cand?.name).join(", ");
      throw new Error(
        `Node ${node.id} (${node.type}) has no widget "${widget}" (available: ${names || "none"})`,
      );
    }
    graph.beforeChange();
    const previous = w.value;
    try {
      w.value = value;
      // Fire the widget's own callback so combo/number side effects run —
      // the same path a manual UI edit takes.
      w.callback?.(value, app.canvas, node, node.pos, undefined);
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return {
      set: { node_id: node.id, widget: w.name, previous, value: w.value },
    };
  },

  graph_move_node({ node_id, pos }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    if (!Array.isArray(pos) || pos.length !== 2) throw new Error("pos must be [x, y]");
    const previous = [node.pos[0], node.pos[1]];
    graph.beforeChange();
    try {
      node.pos = [Number(pos[0]), Number(pos[1])];
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { moved: { node_id: node.id, from: previous, to: [node.pos[0], node.pos[1]] } };
  },

  graph_canvas({ action, node_id, dx, dy, scale }) {
    const { graph, canvas } = getGraphCtx();
    if (!canvas?.ds) throw new Error("Canvas is not available");
    const ds = canvas.ds;
    switch (action) {
      case "center_on_node": {
        const node = resolveNode(graph, node_id);
        if (typeof canvas.centerOnNode === "function") {
          canvas.centerOnNode(node);
        } else {
          ds.offset[0] =
            -node.pos[0] - (node.size?.[0] ?? 0) / 2 + canvas.canvas.width / ds.scale / 2;
          ds.offset[1] =
            -node.pos[1] - (node.size?.[1] ?? 0) / 2 + canvas.canvas.height / ds.scale / 2;
        }
        break;
      }
      case "fit": {
        const nodes = graph._nodes ?? [];
        if (!nodes.length) throw new Error("Graph is empty — nothing to fit");
        // Bounding box of all nodes (prefer litegraph's boundingRect, which
        // includes titles; fall back to pos/size).
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const n of nodes) {
          const br = n.boundingRect;
          let x, y, w0, h0;
          if (Array.isArray(br) && br.length === 4 && (br[2] || br[3])) {
            [x, y, w0, h0] = br;
          } else {
            x = n.pos[0];
            y = n.pos[1] - 30; // title bar renders above pos
            w0 = n.size?.[0] ?? 200;
            h0 = (n.size?.[1] ?? 100) + 30;
          }
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + w0);
          maxY = Math.max(maxY, y + h0);
        }
        const bounds = [minX, minY, maxX - minX, maxY - minY];
        // Panel-aware: the open sidebar panel overlays part of the canvas, so
        // widen the fit bounds on the panel's side — the graph then lands in the
        // VISIBLE area instead of behind the panel (fit otherwise frames the
        // FULL canvas, which sits behind the panel overlay).
        try {
          const cEl = canvas.canvas;
          const pr = activePanelRoot?.isConnected ? activePanelRoot.getBoundingClientRect() : null;
          const cr = cEl?.getBoundingClientRect?.();
          if (pr && cr && pr.width > 0 && cr.width > 0) {
            const panelOnLeft = (pr.left + pr.right) / 2 < (cr.left + cr.right) / 2;
            const inset = panelOnLeft ? Math.max(0, pr.right - cr.left) : Math.max(0, cr.right - pr.left);
            if (inset > 8 && inset < cr.width * 0.9) {
              const extra = bounds[2] * (cr.width / (cr.width - inset) - 1);
              bounds[2] += extra;
              if (panelOnLeft) bounds[0] -= extra; // pad the panel (left) side; right panel grows bounds to the right
            }
          }
        } catch {
          // measurement unavailable — fall back to a plain full-canvas fit
        }
        // SMOOTH animated zoom-to-fit when supported (matches the native
        // "Fit view" easing); fall back to an instant set otherwise.
        if (typeof canvas.animateToBounds === "function") {
          canvas.animateToBounds(bounds, { duration: 400 });
          return { canvas: { action, animated: true } };
        }
        const pad = 60;
        const el = canvas.canvas;
        const w = bounds[2] + pad * 2;
        const h = bounds[3] + pad * 2;
        const next = Math.min(el.width / w, el.height / h, 1.5);
        ds.scale = next;
        ds.offset[0] = -bounds[0] + pad + (el.width / next - w) / 2;
        ds.offset[1] = -bounds[1] + pad + (el.height / next - h) / 2;
        break;
      }
      case "pan":
        ds.offset[0] += Number(dx ?? 0);
        ds.offset[1] += Number(dy ?? 0);
        break;
      case "zoom": {
        const s = Number(scale);
        if (!(s > 0.05 && s <= 4)) throw new Error("scale must be in (0.05, 4]");
        ds.scale = s;
        break;
      }
      default:
        throw new Error(`Unknown canvas action "${action}"`);
    }
    canvas.setDirty(true, true);
    return {
      canvas: { action, scale: ds.scale, offset: [ds.offset[0], ds.offset[1]] },
    };
  },

  async graph_run({ batch_count, to_node_id }) {
    const { app } = getGraphCtx();
    if (typeof app.queuePrompt !== "function") {
      throw new Error("app.queuePrompt is unavailable on this frontend");
    }
    const batch = Number(batch_count ?? 1);

    // "Run to node" = ComfyUI partial execution. The server keeps an OUTPUT node
    // (SaveImage/PreviewImage/SaveVideo/…) as an execution root only when its id
    // is in partial_execution_targets, then walks back through that node's
    // dependencies — so only that branch renders. A non-output node can't be a
    // root (the prompt would have "no outputs"), and an output node nested in a
    // subgraph needs a path-style NodeExecutionId we don't build yet — reject
    // both with guidance instead of silently running the whole graph. Stays
    // undefined for a normal full run (byte-identical to the prior behaviour).
    let partialTargets;
    if (to_node_id != null) {
      const node = app.graph?.getNodeById?.(Number(to_node_id));
      if (!node) {
        return {
          queued: false,
          error:
            `node ${to_node_id} is not on the root graph — run-to-node targets a ` +
            `root-level output node (output nodes inside subgraphs aren't supported yet)`,
        };
      }
      // isOutputNode mirrors ComfyUI's util: node.constructor.nodeData.output_node.
      if (!node.constructor?.nodeData?.output_node) {
        return {
          queued: false,
          error:
            `node ${to_node_id} (${node.type}) is not an output node — "run to node" can ` +
            `only target an output node such as SaveImage, PreviewImage, or SaveVideo. Pick the ` +
            `output node at the end of the branch you want to render (is_output:true in panel_get_graph).`,
        };
      }
      partialTargets = [String(to_node_id)];
    }

    // app.queuePrompt(number, batchCount, queueNodeIds) — the 3rd arg becomes the
    // request's partial_execution_targets (queue-service signature; ComfyUI 0.26.2).
    await app.queuePrompt(0, batch, partialTargets);
    // queuePrompt swallows validation failures into lastNodeErrors.
    const nodeErrors =
      app.lastNodeErrors && Object.keys(app.lastNodeErrors).length ? app.lastNodeErrors : null;
    if (nodeErrors) return { queued: false, node_errors: nodeErrors };
    return {
      queued: true,
      batch_count: batch,
      ...(partialTargets ? { ran_to_node: Number(to_node_id) } : {}),
    };
  },

  graph_get_errors() {
    const { app } = getGraphCtx();
    const nodeErrors =
      app.lastNodeErrors && Object.keys(app.lastNodeErrors).length ? app.lastNodeErrors : null;
    return {
      last_execution_error: lastExecutionError,
      node_errors: nodeErrors,
      ...(lastExecutionError || nodeErrors
        ? {}
        : { note: "no errors recorded since the last execution start" }),
    };
  },

  async workflow_save({ name } = {}) {
    // Fully programmatic — no Save/Rename dialog. Auto-names a never-saved
    // workflow; saves in place otherwise.
    const saved = await programmaticSave(name);
    return { saved: true, workflow: saved };
  },

  async workflow_save_as({ name }) {
    if (!name || typeof name !== "string") throw new Error("name (string) is required");
    const saved = await programmaticSave(name);
    return { saved: true, workflow: saved };
  },

  // --- Workflow tabs: new / list / open / switch / rename / close ----------
  // Uses ComfyUI's workflow service. "New workflow" opens a NEW TAB and never
  // touches the current graph (graph_clear is ONLY for clearing the open one).
  workflow_list() {
    const s = app?.extensionManager?.workflow;
    if (!s) throw new Error("workflow service unavailable on this frontend");
    const active = s.activeWorkflow;
    const brief = (w) => ({
      path: w.path,
      filename: w.filename,
      key: w.key,
      active: !!active && (w === active || w.key === active.key),
      modified: !!w.isModified,
      persisted: !!w.isPersisted,
    });
    return {
      active: active ? { path: active.path, filename: active.filename, key: active.key } : null,
      open: (s.openWorkflows ?? []).map(brief),
    };
  },

  async workflow_new() {
    const mgr = app?.extensionManager;
    if (!mgr?.command?.execute) throw new Error("command service unavailable");
    // Comfy.NewBlankWorkflow opens a fresh TAB — the current workflow is untouched.
    await mgr.command.execute("Comfy.NewBlankWorkflow");
    return { created: true, active: getWorkflowTitle() };
  },

  async workflow_open({ path }) {
    const s = app?.extensionManager?.workflow;
    if (!s?.openWorkflow) throw new Error("workflow service unavailable");
    const find = () => {
      const all = [...(s.openWorkflows ?? []), ...(s.workflows ?? [])];
      return (
        (typeof s.getWorkflowByPath === "function" && path && s.getWorkflowByPath(path)) ||
        all.find(
          (w) =>
            w &&
            (w.path === path ||
              w.filename === path ||
              w.key === path ||
              (w.filename && w.filename.replace(/\.json$/i, "") === path)),
        )
      );
    };
    let target = find();
    // The frontend's workflow list is CACHED, so a just-saved/staged file (e.g. a
    // downloaded example) won't appear until the store re-reads the workflows dir.
    // If the first search misses, REFRESH the store and search again so a freshly
    // staged file is found + opened natively (no need for a separate refresh call).
    if (!target && typeof s.syncWorkflows === "function") {
      try {
        await s.syncWorkflows();
      } catch (err) {
        console.warn("[comfyui-mcp-panel] syncWorkflows failed:", err?.message ?? err);
      }
      target = find();
    }
    if (!target) {
      throw new Error(
        `no workflow matching "${path}" — it isn't among the saved/open workflows even after a refresh. ` +
          `For a file outside the workflows folder, load it with panel_load_workflow path:<file>.`,
      );
    }
    await s.openWorkflow(target);
    // Opening alone must not dirty the tab (a spurious post-load change-tracker
    // diff otherwise flips it to modified:true and blocks an unforced close).
    await clearSpuriousOpenModified(target);
    return {
      opened: { path: target.path, filename: target.filename },
      modified: !!target.isModified,
    };
  },

  async workflow_rename({ name, path }) {
    const s = app?.extensionManager?.workflow;
    if (!s?.renameWorkflow) throw new Error("rename unavailable on this frontend");
    if (!name) throw new Error("name is required");
    const all = [...(s.openWorkflows ?? []), ...(s.workflows ?? [])];
    const target = path
      ? all.find((w) => w && (w.path === path || w.filename === path || w.key === path))
      : s.activeWorkflow;
    if (!target) throw new Error("no target workflow");
    const clean = name.replace(/\.json$/i, "");
    const slash = target.path ? target.path.lastIndexOf("/") : -1;
    const dir = slash >= 0 ? target.path.slice(0, slash + 1) : "workflows/";
    await s.renameWorkflow(target, `${dir}${clean}.json`);
    return { renamed: { to: `${clean}.json` } };
  },

  async workflow_close({ path, force }) {
    const s = app?.extensionManager?.workflow;
    if (!s?.closeWorkflow) throw new Error("close unavailable on this frontend");
    const target = path
      ? (s.openWorkflows ?? []).find(
          (w) => w && (w.path === path || w.filename === path || w.key === path),
        )
      : s.activeWorkflow;
    if (!target) throw new Error("no target workflow");
    // Guard against data loss: don't silently close a workflow with unsaved
    // changes (closeWorkflow bypasses the UI's save prompt). Save first.
    if (target.isModified && !force) {
      throw new Error(
        `"${target.filename || target.path}" has unsaved changes — save it first (panel_save_workflow) before closing, or pass force:true to discard.`,
      );
    }
    await s.closeWorkflow(target);
    return { closed: { path: target.path } };
  },

  // --- Subgraphs: select nodes + group into a subgraph ---------------------
  graph_select_nodes({ node_ids }) {
    const { graph, canvas } = getGraphCtx();
    if (!canvas) throw new Error("canvas unavailable");
    const ns = (Array.isArray(node_ids) ? node_ids : [])
      .map((id) => graph.getNodeById(Number(id)))
      .filter(Boolean);
    if (!ns.length) throw new Error("no matching nodes to select");
    if (typeof canvas.selectItems === "function") canvas.selectItems(ns);
    else if (typeof canvas.selectNodes === "function") canvas.selectNodes(ns);
    else throw new Error("selection API unavailable");
    canvas.setDirty?.(true, true);
    return { selected: ns.map((n) => n.id) };
  },

  graph_create_subgraph({ node_ids }) {
    const { graph, canvas } = getGraphCtx();
    if (typeof graph.convertToSubgraph !== "function") {
      throw new Error("convertToSubgraph unavailable on this frontend");
    }
    const ns = (Array.isArray(node_ids) ? node_ids : [])
      .map((id) => graph.getNodeById(Number(id)))
      .filter(Boolean);
    if (!ns.length) throw new Error("provide node_ids to group into a subgraph");
    if (typeof canvas.selectItems === "function") canvas.selectItems(ns);
    else if (typeof canvas.selectNodes === "function") canvas.selectNodes(ns);
    graph.beforeChange?.();
    let res;
    try {
      res = graph.convertToSubgraph(canvas.selectedItems);
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    return {
      subgraph: {
        node_id: res?.node?.id ?? null,
        name: res?.subgraph?.name ?? null,
        from_nodes: ns.map((n) => n.id),
      },
    };
  },

  // Wrap an existing GROUP's nodes into a subgraph in one step. Resolves the
  // group (by id or title), recomputes its geometric membership, then runs the
  // same convertToSubgraph path as graph_create_subgraph. This is how a region
  // like a "REPLACEMENT MODE" group becomes one toggleable subgraph node.
  graph_subgraph_group({ group }) {
    const { graph, canvas } = getGraphCtx();
    if (typeof graph.convertToSubgraph !== "function") {
      throw new Error("convertToSubgraph unavailable on this frontend");
    }
    const g = resolveGroupRef(graph, group);
    if (!g) {
      throw new Error(
        `no group matching "${group}" — list groups via panel_get_graph (each has id, title, node_ids)`,
      );
    }
    g.recomputeInsideNodes?.();
    const ns = [...(g._nodes ?? [])];
    if (!ns.length) {
      throw new Error(`group "${g.title}" has no nodes inside its box to wrap into a subgraph`);
    }
    if (typeof canvas.selectItems === "function") canvas.selectItems(ns);
    else if (typeof canvas.selectNodes === "function") canvas.selectNodes(ns);
    graph.beforeChange?.();
    let res;
    try {
      res = graph.convertToSubgraph(canvas.selectedItems);
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    return {
      subgraph: {
        node_id: res?.node?.id ?? null,
        name: res?.subgraph?.name ?? null,
        from_group: g.title ?? null,
        from_nodes: ns.map((n) => n.id),
      },
    };
  },

  // --- Subgraph boundary I/O: wire internal nodes to the input/output rails --
  // Run while INSIDE a subgraph (the active graph IS the Subgraph). Mirrors
  // promoteWidgetByLink (subgraph.addInput + SubgraphInput.connect) for the
  // OUTPUT side via subgraph.addOutput + SubgraphOutput.connect.
  // Ref: ComfyUI_frontend LGraph.ts addOutput ~2970 / addInput ~2948;
  //      SubgraphOutput.connect(slot, node) ~line 34; SubgraphInput.connect(slot, node) ~line 48.

  // Take an internal node's OUTPUT and expose it as a subgraph OUTPUT.
  graph_expose_subgraph_output({ from_node_id, from_output, name }) {
    const { graph, canvas } = getGraphCtx();
    const subgraph = graph;
    if (typeof subgraph.addOutput !== "function" || !subgraph.outputNode) {
      throw new Error(
        "graph_expose_subgraph_output must be run INSIDE a subgraph (no subgraph.addOutput on the active graph)",
      );
    }
    const node = resolveNode(subgraph, from_node_id);
    const outIdx = resolveSlot(node.outputs, from_output ?? 0, "output");
    const outputSlot = node.outputs[outIdx];

    // Idempotent-ish: reuse an existing subgraph output already fed by this slot.
    const existing = (subgraph.outputs ?? []).find((o) =>
      (o?.linkIds ?? []).some((linkId) => {
        const link = subgraph.getLink?.(linkId);
        return (
          link && Number(link.origin_id) === Number(node.id) && Number(link.origin_slot) === outIdx
        );
      }),
    );
    if (existing) {
      return {
        exposed: {
          name: existing.name,
          type: existing.type,
          slot: subgraph.outputs.indexOf(existing),
          reused: true,
          from: { node_id: node.id, output: outputSlot?.name ?? outIdx },
        },
      };
    }

    const outputName = uniqueSubgraphOutputName(subgraph, name || outputSlot?.name || "output");
    const outputType = String(outputSlot?.type ?? "*");
    subgraph.beforeChange?.();
    let subgraphOutput;
    let link;
    try {
      subgraphOutput = subgraph.addOutput(outputName, outputType);
      subgraphOutput.label = outputSlot?.label;
      link =
        typeof subgraphOutput.connect === "function"
          ? subgraphOutput.connect(outputSlot, node)
          : null;
      if (!link) {
        subgraph.removeOutput?.(subgraphOutput);
        throw new Error(
          `Could not link node ${node.id} output "${outputSlot?.name ?? outIdx}" (${outputType}) to a new subgraph output`,
        );
      }
    } finally {
      subgraph.afterChange?.();
    }
    findSubgraphHostNode(subgraph)?.invalidatePromotedViews?.();
    subgraph.setDirtyCanvas?.(true, true);
    canvas?.setDirty?.(true, true);
    return {
      exposed: {
        name: outputName,
        type: outputType,
        slot: subgraph.outputs.indexOf(subgraphOutput),
        on_host_subgraph_node: true,
        from: { node_id: node.id, output: outputSlot?.name ?? outIdx },
      },
    };
  },

  // Expose the input rail as a subgraph INPUT feeding an internal node's INPUT.
  graph_expose_subgraph_input({ to_node_id, to_input, name }) {
    const { graph, canvas } = getGraphCtx();
    const subgraph = graph;
    if (typeof subgraph.addInput !== "function" || !subgraph.inputNode) {
      throw new Error(
        "graph_expose_subgraph_input must be run INSIDE a subgraph (no subgraph.addInput on the active graph)",
      );
    }
    const node = resolveNode(subgraph, to_node_id);
    const inIdx = resolveSlot(node.inputs, to_input ?? 0, "input");
    const inputSlot = node.inputs[inIdx];

    // Idempotent-ish: reuse an existing subgraph input already feeding this slot.
    const existing = (subgraph.inputs ?? []).find((s) =>
      (s?.linkIds ?? []).some((linkId) => {
        const link = subgraph.getLink?.(linkId);
        return (
          link && Number(link.target_id) === Number(node.id) && Number(link.target_slot) === inIdx
        );
      }),
    );
    if (existing) {
      return {
        exposed: {
          name: existing.name,
          type: existing.type,
          slot: subgraph.inputs.indexOf(existing),
          reused: true,
          to: { node_id: node.id, input: inputSlot?.name ?? inIdx },
        },
      };
    }

    const inputName = uniqueSubgraphInputName(subgraph, name || inputSlot?.name || "input");
    const inputType = String(inputSlot?.type ?? "*");
    subgraph.beforeChange?.();
    let subgraphInput;
    let link;
    try {
      subgraphInput = subgraph.addInput(inputName, inputType);
      subgraphInput.label = inputSlot?.label;
      link =
        typeof subgraphInput.connect === "function" ? subgraphInput.connect(inputSlot, node) : null;
      if (!link) {
        subgraph.removeInput?.(subgraphInput);
        throw new Error(
          `Could not link a new subgraph input to node ${node.id} input "${inputSlot?.name ?? inIdx}" (${inputType})`,
        );
      }
    } finally {
      subgraph.afterChange?.();
    }
    findSubgraphHostNode(subgraph)?.invalidatePromotedViews?.();
    subgraph.setDirtyCanvas?.(true, true);
    canvas?.setDirty?.(true, true);
    return {
      exposed: {
        name: inputName,
        type: inputType,
        slot: subgraph.inputs.indexOf(subgraphInput),
        on_host_subgraph_node: true,
        to: { node_id: node.id, input: inputSlot?.name ?? inIdx },
      },
    };
  },

  // Dissolve a subgraph: inline its interior nodes into the parent + rewire
  // external links. node_id is the SubgraphNode in the CURRENT (parent) graph.
  // Ref: ComfyUI_frontend LGraph.ts unpackSubgraph ~1932 (wraps its own
  // beforeChange/afterChange) and _unpackSubgraphImpl ~1950.
  graph_unpack_subgraph({ node_id }) {
    const { graph, canvas } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    if (!node.subgraph) {
      throw new Error(`Node ${node.id} (${node.type}) is not a subgraph`);
    }
    if (typeof graph.unpackSubgraph !== "function") {
      throw new Error("unpackSubgraph is unavailable on this ComfyUI frontend");
    }
    const before = new Set((graph._nodes ?? []).map((n) => n.id));
    // unpackSubgraph wraps its own beforeChange/afterChange for undo, so don't
    // nest another pair here.
    graph.unpackSubgraph(node, { skipMissingNodes: true });
    const newNodeIds = (graph._nodes ?? []).filter((n) => !before.has(n.id)).map((n) => n.id);
    graph.setDirtyCanvas?.(true, true);
    canvas?.setDirty?.(true, true);
    return {
      unpacked: {
        node_id,
        new_node_ids: newNodeIds,
        node_count: newNodeIds.length,
      },
    };
  },

  // ---- Copy / paste (cross-workflow MERGE) ---------------------------------
  // LiteGraph's clipboard PERSISTS across workflow switches, so copying from one
  // workflow and pasting into another MERGES the copied nodes in. copyToClipboard
  // /pasteFromClipboard are the same APIs the native Ctrl+C / Ctrl+V use.

  // Copy nodes to the litegraph clipboard. With node_ids: select them first; with
  // no ids: copy the current canvas selection. The clipboard survives a workflow
  // switch, so the next graph_paste_nodes can drop them into a DIFFERENT workflow.
  graph_copy_nodes({ node_ids } = {}) {
    const { graph, canvas } = getGraphCtx();
    if (!canvas) throw new Error("canvas unavailable");
    if (typeof canvas.copyToClipboard !== "function") {
      throw new Error("copyToClipboard unavailable on this frontend");
    }
    if (Array.isArray(node_ids) && node_ids.length) {
      const resolved = node_ids.map((id) => ({ id, node: graph.getNodeById(Number(id)) }));
      const missing = resolved.filter((r) => !r.node).map((r) => r.id);
      // Fail loudly on any unknown id rather than silently copying a partial subset
      // (the agent would think it grabbed everything).
      if (missing.length) {
        throw new Error(`node_ids not found in the current graph: ${missing.join(", ")}`);
      }
      const ns = resolved.map((r) => r.node);
      if (typeof canvas.selectItems === "function") canvas.selectItems(ns);
      else if (typeof canvas.selectNodes === "function") canvas.selectNodes(ns);
    }
    const selected = canvas.selectedItems;
    const count = selected?.size ?? (Array.isArray(selected) ? selected.length : 0);
    if (!count) {
      throw new Error("nothing selected to copy — pass node_ids or select nodes first");
    }
    canvas.copyToClipboard(selected);
    return { copied: count };
  },

  // Paste the litegraph clipboard onto the CURRENT graph. Snapshots node ids
  // before/after so the freshly-pasted node ids can be returned. connect_inputs
  // false (default) drops a disconnected copy; pos places the paste anchor.
  graph_paste_nodes({ pos, connect_inputs } = {}) {
    const { graph, canvas } = getGraphCtx();
    if (!canvas) throw new Error("canvas unavailable");
    if (typeof canvas.pasteFromClipboard !== "function") {
      throw new Error("pasteFromClipboard unavailable on this frontend");
    }
    const before = new Set((graph._nodes ?? []).map((n) => n.id));
    const options = { connectInputs: connect_inputs ?? false };
    if (Array.isArray(pos) && pos.length === 2) options.position = [Number(pos[0]), Number(pos[1])];
    graph.beforeChange?.();
    try {
      canvas.pasteFromClipboard(options);
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    const pasted = (graph._nodes ?? [])
      .filter((n) => !before.has(n.id))
      .map((n) => summarizeNode(n));
    return { pasted_count: pasted.length, pasted_node_ids: pasted.map((n) => n.id), pasted };
  },

  // ---- Subgraph blueprints (SAVE / LIST / ADD reusable subgraphs) -----------
  // A SubgraphNode can be published to the user's blueprint LIBRARY as a reusable
  // node type "SubgraphBlueprint.<name>". Saved blueprints can be dropped into ANY
  // workflow. Backed by the Pinia "subgraph" store (publishSubgraph/getBlueprint/
  // subgraphBlueprints). publishSubgraph(name) skips the name dialog when given a
  // name, so this runs fully programmatically.

  // Publish a subgraph node to the library. node_id selects the subgraph node
  // first (else the current single selection must be a subgraph node). name is the
  // blueprint name (defaults to the node's title). No dialog when name is given.
  async graph_save_subgraph({ node_id, name } = {}) {
    const { graph, canvas } = getGraphCtx();
    if (!canvas) throw new Error("canvas unavailable");
    const store = getSubgraphStore();
    let target = null;
    if (node_id != null) {
      target = graph.getNodeById(Number(node_id));
      if (!target) throw new Error(`No node with id ${node_id} in the current graph`);
      if (!target.subgraph) {
        throw new Error(`Node ${node_id} (${target.type}) is not a subgraph node`);
      }
      if (typeof canvas.select === "function") {
        canvas.selectedItems?.clear?.();
        canvas.select(target);
      } else if (typeof canvas.selectItems === "function") {
        canvas.selectItems([target]);
      }
    } else {
      const selected = [...(canvas.selectedItems ?? [])];
      if (selected.length === 1 && selected[0]?.subgraph) target = selected[0];
      if (!target) {
        throw new Error(
          "select a single subgraph node (or pass node_id) before saving it to the library",
        );
      }
    }
    const finalName =
      typeof name === "string" && name.trim() ? name.trim() : target.title || "Subgraph";
    const fullType = `${store.typePrefix ?? "SubgraphBlueprint."}${finalName}`;
    // publishSubgraph() pops a confirmOverwrite() dialog on a name COLLISION — which
    // would hang this programmatic call waiting for UI. Preflight and refuse with a
    // clear error instead (the agent picks a new name).
    if ((store.subgraphBlueprints ?? []).some((d) => d?.name === fullType)) {
      throw new Error(
        `a subgraph blueprint named "${finalName}" already exists — choose a different name (programmatic overwrite isn't supported)`,
      );
    }
    await store.publishSubgraph(finalName);
    return { saved: { name: finalName, from_node_id: target.id, type: fullType } };
  },

  // List saved subgraph blueprints. Each is addable via graph_add_subgraph(name)
  // or graph_add_node(type). Read-only.
  graph_list_subgraphs() {
    const store = getSubgraphStore();
    const prefix = store.typePrefix ?? "SubgraphBlueprint.";
    const defs = store.subgraphBlueprints ?? [];
    const blueprints = [...defs].map((d) => {
      const type = d?.name ?? "";
      return {
        name: type.startsWith(prefix) ? type.slice(prefix.length) : type,
        type,
        display_name: d?.display_name ?? null,
        description: d?.description ?? null,
        is_global: d?.isGlobal === true,
      };
    });
    return { count: blueprints.length, blueprints };
  },

  // Add a saved subgraph blueprint to the current graph by name (or full type).
  // Blueprints are NOT created via LiteGraph.createNode — they deserialize their
  // stored {nodes, subgraphs} via canvas._deserializeItems (mirrors the frontend's
  // addNodeOnGraph blueprint path), so this is a dedicated tool.
  graph_add_subgraph({ name, pos } = {}) {
    const { graph, canvas } = getGraphCtx();
    if (!canvas || typeof canvas._deserializeItems !== "function") {
      throw new Error("canvas._deserializeItems unavailable on this frontend");
    }
    if (!name || typeof name !== "string") throw new Error("name (blueprint name or type) is required");
    const store = getSubgraphStore();
    const prefix = store.typePrefix ?? "SubgraphBlueprint.";
    const type = name.startsWith(prefix) ? name : `${prefix}${name}`;
    if (typeof store.getBlueprint !== "function") {
      throw new Error("subgraph store does not expose getBlueprint on this frontend");
    }
    let bp;
    try {
      bp = store.getBlueprint(type);
    } catch (err) {
      throw new Error(
        `No saved subgraph blueprint "${name}" (${err?.message ?? err}). List them with graph_list_subgraphs.`,
      );
    }
    const position = placementFor(graph, pos);
    const before = new Set((graph._nodes ?? []).map((n) => n.id));
    graph.beforeChange?.();
    let results;
    try {
      results = canvas._deserializeItems(
        { nodes: bp.nodes, subgraphs: bp.definitions?.subgraphs },
        { position },
      );
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    if (!results) throw new Error("failed to add subgraph blueprint");
    // Confirm a node actually landed — don't report a fake success if deserialize
    // produced nothing (mirrors the frontend, which throws when no node resolves).
    const added = (graph._nodes ?? []).find((n) => !before.has(n.id));
    if (!added) {
      throw new Error("subgraph blueprint deserialized but no new node resolved on the canvas");
    }
    return { added: summarizeNode(added), from_blueprint: type };
  },

  // ---- Group boxes (LiteGraph LGraphGroup) ----------------------------------
  // The labeled, colored rectangles. Visual organizers ONLY — distinct from
  // subgraphs (which nest nodes). All undoable via beforeChange/afterChange.

  // Create a group. Pass node_ids to auto-wrap them, else bounds [x,y,w,h],
  // else a default box near the last node.
  graph_create_group({ title, node_ids, bounds, color, font_size }) {
    const { graph, LG } = getGraphCtx();
    const GroupCls = LG.LGraphGroup;
    if (typeof GroupCls !== "function") throw new Error("LGraphGroup unavailable on this frontend");
    const group = new GroupCls(typeof title === "string" && title ? title : "Group");
    let bbox;
    if (Array.isArray(node_ids) && node_ids.length) {
      const ns = node_ids.map((id) => graph.getNodeById(Number(id))).filter(Boolean);
      if (!ns.length) throw new Error("none of the given node_ids exist in the current graph");
      bbox = boundsAroundNodes(ns);
    } else if (Array.isArray(bounds) && bounds.length === 4) {
      bbox = bounds.map(Number);
    } else {
      bbox = [...placementFor(graph), 400, 300];
    }
    if (color != null) group.color = String(color);
    if (Number.isFinite(font_size)) group.font_size = Number(font_size);
    graph.beforeChange();
    try {
      setGroupBounds(group, bbox);
      graph.add(group);
      if (group.id == null) group.id = nextGroupId(graph);
      group.recomputeInsideNodes?.();
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { group: summarizeGroup(graph, group) };
  },

  // Move a group's box to [x,y]; by default the contained nodes move with it
  // (move_nodes:false moves only the box).
  graph_move_group({ group_id, pos, move_nodes }) {
    const { graph } = getGraphCtx();
    const g = resolveGroup(graph, group_id);
    const b = g._bounding ?? [g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, 0, 0];
    const dx = Number(pos[0]) - b[0];
    const dy = Number(pos[1]) - b[1];
    graph.beforeChange();
    try {
      if (move_nodes !== false && typeof g.move === "function") {
        g.recomputeInsideNodes?.();
        g.move(dx, dy, false); // moves the box AND the nodes inside it
      } else {
        setGroupBounds(g, [Number(pos[0]), Number(pos[1]), b[2], b[3]]);
      }
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { group: summarizeGroup(graph, g) };
  },

  // Edit a group's title / color / font_size / bounds — only the fields passed.
  graph_edit_group({ group_id, title, color, font_size, bounds }) {
    const { graph } = getGraphCtx();
    const g = resolveGroup(graph, group_id);
    graph.beforeChange();
    try {
      if (typeof title === "string") g.title = title;
      if (color != null) g.color = String(color);
      if (Number.isFinite(font_size)) g.font_size = Number(font_size);
      if (Array.isArray(bounds) && bounds.length === 4) setGroupBounds(g, bounds.map(Number));
      g.recomputeInsideNodes?.();
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { group: summarizeGroup(graph, g) };
  },

  // Remove a group box (the nodes inside are NOT deleted).
  graph_remove_group({ group_id }) {
    const { graph } = getGraphCtx();
    const g = resolveGroup(graph, group_id);
    const summary = summarizeGroup(graph, g);
    graph.beforeChange();
    try {
      if (typeof graph.removeGroup === "function") graph.removeGroup(g);
      else if (typeof graph.remove === "function") graph.remove(g);
      else {
        const i = (graph._groups ?? []).indexOf(g);
        if (i >= 0) graph._groups.splice(i, 1);
      }
    } finally {
      graph.afterChange();
    }
    graph.setDirtyCanvas(true, true);
    return { removed: summary };
  },

  // Rename a node's TITLE (the label on its header) — distinct from widget values.
  graph_set_title({ node_id, title }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const previous = node.title;
    graph.beforeChange?.();
    try {
      node.title = String(title ?? "");
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    return { node_id: node.id, previous, title: node.title };
  },

  // Collapse (minimize) or expand a node. `collapsed` defaults to true.
  graph_set_node_collapsed({ node_id, collapsed }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const want = collapsed !== false;
    graph.beforeChange?.();
    try {
      const isCollapsed = !!(node.flags && node.flags.collapsed);
      if (isCollapsed !== want) {
        if (typeof node.collapse === "function") node.collapse();
        else {
          node.flags = node.flags || {};
          node.flags.collapsed = want;
        }
      }
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    return { node_id: node.id, collapsed: !!(node.flags && node.flags.collapsed) };
  },

  // Set a node's title-bar color and/or body color. Pass a `preset` name from
  // LiteGraph's palette (red, brown, green, blue, pale_blue, cyan, purple,
  // yellow, black) for matched title+body colors, or explicit `color` (title)
  // and/or `bgcolor` (body) hex strings. Pass null for a field to clear it.
  graph_set_node_color({ node_id, color, bgcolor, preset }) {
    const { graph, LG } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    graph.beforeChange?.();
    try {
      if (preset != null) {
        const LGC = LG?.LGraphCanvas ?? window.LGraphCanvas ?? globalThis.LGraphCanvas;
        const presets = LGC?.node_colors;
        const p = presets && presets[preset];
        if (!p) {
          throw new Error(
            `unknown color preset "${preset}" (available: ${presets ? Object.keys(presets).join(", ") : "none"})`,
          );
        }
        node.color = p.color;
        node.bgcolor = p.bgcolor;
      } else {
        if (color === null) delete node.color;
        else if (color != null) node.color = String(color);
        if (bgcolor === null) delete node.bgcolor;
        else if (bgcolor != null) node.bgcolor = String(bgcolor);
      }
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    return { node_id: node.id, color: node.color ?? null, bgcolor: node.bgcolor ?? null };
  },

  // Set a node's execution MODE: "active" (runs normally), "bypass" (the node is
  // skipped but its inputs pass through to its outputs — LiteGraph mode 4), or
  // "mute" (the node and everything downstream of it is skipped — mode 2). Also
  // accepts the raw numeric LiteGraph modes 0/2/4 defensively. Undo-able like the
  // other graph_set_node_* edits.
  graph_set_node_mode({ node_id, mode }) {
    const { graph } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const MODE_TO_NUM = { active: 0, bypass: 4, mute: 2 };
    const NUM_TO_MODE = { 0: "active", 2: "mute", 4: "bypass" };
    let target;
    if (typeof mode === "number" || (typeof mode === "string" && /^\d+$/.test(mode.trim()))) {
      const n = Number(mode);
      if (!(n in NUM_TO_MODE)) {
        throw new Error(`invalid mode ${mode} (valid: "active", "bypass", "mute" or 0/2/4)`);
      }
      target = n;
    } else {
      const key = String(mode ?? "").toLowerCase();
      if (!(key in MODE_TO_NUM)) {
        throw new Error(`invalid mode "${mode}" (valid: "active", "bypass", "mute")`);
      }
      target = MODE_TO_NUM[key];
    }
    const prevNum = typeof node.mode === "number" ? node.mode : 0;
    const previous_mode = NUM_TO_MODE[prevNum] ?? prevNum;
    graph.beforeChange?.();
    try {
      node.mode = target;
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    return { node_id: node.id, mode: NUM_TO_MODE[target], previous_mode };
  },

  // Render the CURRENT graph view (root graph or the open subgraph) to a PNG and
  // return it as base64 so the agent can SEE the layout. Temporarily fits the
  // whole graph (nodes + groups) into the canvas, draws synchronously, captures,
  // then restores the user's view. Output is capped to ~1600px wide.
  graph_screenshot({ padding } = {}) {
    const { graph, canvas } = getGraphCtx();
    const cv = canvas?.canvas;
    const ds = canvas?.ds;
    if (!cv || typeof cv.toDataURL !== "function" || !ds) {
      throw new Error("canvas not available for screenshot");
    }
    const nodes = graph._nodes ?? [];
    const groups = graph._groups ?? [];
    if (!nodes.length && !groups.length) throw new Error("nothing to screenshot (empty graph)");
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      const br = n.boundingRect;
      let x;
      let y;
      let w0;
      let h0;
      if (Array.isArray(br) && br.length === 4 && (br[2] || br[3])) {
        [x, y, w0, h0] = br;
      } else {
        x = n.pos?.[0] ?? 0;
        y = (n.pos?.[1] ?? 0) - 30; // title bar renders above pos
        w0 = n.size?.[0] ?? 200;
        h0 = (n.size?.[1] ?? 100) + 30;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w0);
      maxY = Math.max(maxY, y + h0);
    }
    for (const g of groups) {
      const b = g._bounding;
      if (b && b.length >= 4) {
        minX = Math.min(minX, b[0]);
        minY = Math.min(minY, b[1]);
        maxX = Math.max(maxX, b[0] + b[2]);
        maxY = Math.max(maxY, b[1] + b[3]);
      }
    }
    const bounds = [minX, minY, maxX - minX, maxY - minY];
    const pad = Number.isFinite(padding) ? Number(padding) : 60;
    const saved = { scale: ds.scale, ox: ds.offset[0], oy: ds.offset[1] };
    let dataUrl;
    let outW = cv.width;
    let outH = cv.height;
    try {
      const w = bounds[2] + pad * 2;
      const h = bounds[3] + pad * 2;
      const next = Math.min(cv.width / w, cv.height / h, 1.5);
      ds.scale = next;
      ds.offset[0] = -bounds[0] + pad + (cv.width / next - w) / 2;
      ds.offset[1] = -bounds[1] + pad + (cv.height / next - h) / 2;
      canvas.draw(true, true); // synchronous redraw at the fitted transform
      const MAXW = 1600;
      if (cv.width > MAXW) {
        const s = MAXW / cv.width;
        const off = document.createElement("canvas");
        off.width = Math.round(cv.width * s);
        off.height = Math.round(cv.height * s);
        off.getContext("2d").drawImage(cv, 0, 0, off.width, off.height);
        dataUrl = off.toDataURL("image/png");
        outW = off.width;
        outH = off.height;
      } else {
        dataUrl = cv.toDataURL("image/png");
      }
    } finally {
      ds.scale = saved.scale;
      ds.offset[0] = saved.ox;
      ds.offset[1] = saved.oy;
      canvas.setDirty?.(true, true);
      canvas.draw?.(true, true);
    }
    const comma = dataUrl.indexOf(",");
    return {
      image: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
      mimeType: "image/png",
      width: outW,
      height: outH,
      viewing: describeActiveGraph(graph),
    };
  },

  // Navigate INTO a subgraph node so the canvas (and therefore every graph_*
  // editor) targets its inner graph — the way to read/edit nodes inside a
  // subgraph. Pair with graph_exit_subgraph to return to the root.
  graph_enter_subgraph({ node_id }) {
    const { graph, canvas } = getGraphCtx();
    const node = resolveNode(graph, node_id);
    const sub = node.subgraph;
    if (!sub) throw new Error(`Node ${node.id} (${node.type}) is not a subgraph`);
    if (typeof canvas.openSubgraph !== "function") {
      throw new Error("subgraph navigation unavailable on this frontend");
    }
    canvas.openSubgraph(sub, node);
    canvas.setDirty?.(true, true);
    return { entered: node.id, viewing: describeActiveGraph(getGraphCtx().graph) };
  },

  // Leave the current subgraph and return to the root graph.
  graph_exit_subgraph() {
    const { graph, canvas, rootGraph } = getGraphCtx();
    if (graph === rootGraph) return { viewing: { scope: "root" }, note: "already at root" };
    if (typeof canvas.setGraph !== "function") {
      throw new Error("subgraph navigation unavailable on this frontend");
    }
    canvas.setGraph(graph.rootGraph ?? rootGraph);
    canvas.setDirty?.(true, true);
    return { viewing: describeActiveGraph(getGraphCtx().graph) };
  },

  // Reposition a subgraph's input/output RAIL (the boundary I/O node). Must run
  // INSIDE the subgraph (graph_enter_subgraph first). Lets a layout place the
  // input rail just left of the first column and the output rail just right of
  // the last one, so boundary wires stay short — read current rail positions
  // from graph_get_state's `rails` field.
  graph_move_rail({ rail, pos }) {
    const { graph, rootGraph } = getGraphCtx();
    if (graph === rootGraph) {
      throw new Error("graph_move_rail must run INSIDE a subgraph — call graph_enter_subgraph first");
    }
    const node =
      rail === "input" ? (graph.inputNode ?? graph._inputNode) :
      rail === "output" ? (graph.outputNode ?? graph._outputNode) :
      null;
    if (!node) throw new Error(`subgraph has no "${rail}" rail — use rail "input" or "output"`);
    if (!Array.isArray(pos) || pos.length !== 2) throw new Error("pos must be [x, y]");
    graph.beforeChange?.();
    try {
      node.pos = [Number(pos[0]), Number(pos[1])];
    } finally {
      graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    return { rail, pos: [Math.round(node.pos[0]), Math.round(node.pos[1])] };
  },

  // Promote (or demote) an INNER subgraph widget so it appears on the PARENT
  // SubgraphNode — the thing you couldn't do before. Must be called while INSIDE
  // the subgraph (graph_enter_subgraph first): node_id is an inner node, widget
  // is one of its widget names. Mirrors the "Promote Widget" context-menu action
  // via the frontend's promotion store. Pass demote:true to un-promote.
  graph_promote_widget({ node_id, widget, demote }) {
    const { graph, canvas, rootGraph } = getGraphCtx();
    if (graph === rootGraph) {
      throw new Error(
        "Enter the subgraph first (graph_enter_subgraph) — promotion exposes an INNER widget on the parent node.",
      );
    }
    const node = resolveNode(graph, node_id);
    const widgets = node.widgets ?? [];
    const w = widgets.find((x) => x && x.name === widget);
    if (!w) {
      const names = widgets.map((x) => x?.name).filter(Boolean);
      throw new Error(
        `Node ${node.id} (${node.type}) has no widget "${widget}". Available: ${names.join(", ") || "(none)"}`,
      );
    }
    // The parent SubgraphNode instance(s) embedding this subgraph (root-level
    // search, same as describeActiveGraph). The widget is exposed on these.
    const parents = (rootGraph._nodes ?? []).filter((n) => n.subgraph === graph);
    if (!parents.length) {
      throw new Error("Could not locate the parent subgraph node for the open subgraph.");
    }
    const source = { sourceNodeId: String(node.id), sourceWidgetName: w.name };
    const action = demote ? "demote" : "promote";
    let strategy = "link-only";
    graph.beforeChange?.();
    try {
      try {
        let changed = false;
        for (const p of parents) {
          const result = demote ? demoteWidgetByLink(p, source) : promoteWidgetByLink(p, node, w);
          changed = changed || result.changed;
        }
        if (demote && !changed) throw new Error("link-only promoted input not found");
      } catch (linkErr) {
        const store = getPromotionStore();
        strategy = "legacy-store";
        for (const p of parents) {
          const rootGraphId = p.rootGraph?.id ?? rootGraph?.id;
          store[action](rootGraphId, p.id, source);
        }
      }
      refreshPromotedParents(parents, canvas);
    } finally {
      graph.afterChange?.();
    }
    return {
      [demote ? "demoted" : "promoted"]: w.name,
      from_node: node.id,
      on_subgraph_nodes: parents.map((p) => p.id),
      strategy,
    };
  },

  // --- Custom-node management via the BUILT-IN ComfyUI Manager (/v2 API) ----
  async nodes_search({ query, limit }) {
    const data = await managerV2("customnode/getmappings?mode=cache");
    const q = String(query ?? "").toLowerCase();
    const out = [];
    const push = (id, title, desc) => {
      if (!id) return;
      const hay = `${id} ${title ?? ""} ${desc ?? ""}`.toLowerCase();
      if (!q || hay.includes(q)) {
        out.push({ id, title: title ?? id, description: String(desc ?? "").slice(0, 160) });
      }
    };
    if (Array.isArray(data)) {
      for (const p of data) push(p.id ?? p.reference ?? p.title, p.title, p.description);
    } else if (data && typeof data === "object") {
      // getmappings is keyed by repo/url → [ [classNames…], { title, description, … } ]
      for (const [key, val] of Object.entries(data)) {
        const meta = Array.isArray(val) ? val[1] : val;
        push(meta?.id ?? meta?.title ?? key, meta?.title, meta?.description);
      }
    }
    const max = Math.min(Number(limit) || 15, 40);
    return { count: out.length, results: out.slice(0, max) };
  },

  async nodes_list() {
    return { installed: await managerV2("customnode/installed") };
  },

  async nodes_install({ id, version, repository, channel, mode, selected_version }) {
    if (!id && !repository) {
      throw new Error("id (registry id or author/repo) or repository (git URL) is required");
    }
    const sel = selected_version || version || (repository ? "nightly" : "latest");
    const params = {
      id: id ?? repository,
      version: version || (sel === "nightly" ? "nightly" : "latest"),
      selected_version: sel,
      ...(repository ? { repository } : {}),
      mode: mode || "remote",
      channel: channel || "default",
    };
    const ui_id = crypto.randomUUID();
    const client_id = api.clientId ?? api.initialClientId ?? "comfyui-mcp-panel";
    await managerV2("manager/queue/task", {
      method: "POST",
      body: { kind: "install", params, ui_id, client_id },
    });
    await managerV2("manager/queue/start", { method: "POST" });
    return {
      queued: true,
      ui_id,
      id: params.id,
      note: "Install queued. Poll nodes_queue_status; a ComfyUI restart (comfy_reboot) is usually required to load new nodes.",
    };
  },

  // Update an ALREADY-INSTALLED pack to latest/nightly via the built-in Manager.
  // Mirrors nodes_install but uses the Manager's "update" task kind. The Manager
  // identifies the installed pack by `node_name` (its pack id / dir name); we
  // also pass selected_version so 'nightly' pulls the newest commit. Returns the
  // queued ui_id so panel_node_queue_status can poll the same queue.
  async graph_update_node({ id, version, channel, mode }) {
    if (!id) throw new Error("id (installed pack name/dir or registry id) is required");
    const sel = version === "nightly" ? "nightly" : "latest";
    const params = {
      // The Manager's update task keys off node_name; include id too for
      // correlation parity with install (harmless if the server ignores it).
      node_name: id,
      id,
      selected_version: sel,
      version: sel,
      mode: mode || "remote",
      channel: channel || "default",
    };
    const ui_id = crypto.randomUUID();
    const client_id = api.clientId ?? api.initialClientId ?? "comfyui-mcp-panel";
    await managerV2("manager/queue/task", {
      method: "POST",
      body: { kind: "update", params, ui_id, client_id },
    });
    await managerV2("manager/queue/start", { method: "POST" });
    return {
      queued: true,
      ui_id,
      id,
      version: sel,
      note: "Update queued. Poll nodes_queue_status; a ComfyUI restart (comfy_reboot) is usually required to load the updated node.",
    };
  },

  async nodes_queue_status() {
    return { status: await managerV2("manager/queue/status") };
  },

  async comfy_reboot({ force } = {}) {
    // Restart the ComfyUI server (to load newly installed nodes). ComfyUI and the
    // orchestrator go down briefly; the panel auto-reconnects + resumes after.
    // GUARD: a reboot ABORTS any in-progress/queued generation. Don't silently kill
    // a render the user is waiting on — check the queue first and refuse (with a
    // clear message the agent relays) unless force:true.
    if (!force) {
      try {
        const res = await api.fetchApi("/queue");
        const q = await res.json();
        const running = q?.queue_running?.length ?? 0;
        const pending = q?.queue_pending?.length ?? 0;
        if (running > 0 || pending > 0) {
          return {
            rebooting: false,
            blocked_busy: true,
            queue_running: running,
            queue_pending: pending,
            message:
              `NOT rebooting — ComfyUI is busy (${running} generating, ${pending} queued). A reboot would ABORT the in-progress render. ` +
              `Tell the user a generation is running and either wait for it to finish (poll get_queue / panel_node_queue_status) ` +
              `or, only if they confirm they want to kill it, call again with force:true.`,
          };
        }
      } catch {
        // Queue probe failed (ComfyUI unreachable / no /queue) — fall through and
        // reboot; don't block a needed restart on a flaky probe.
      }
    }
    // Fire the reboot. IMPORTANT: a "successful" reboot usually looks like a
    // FAILED fetch. The bundled Desktop Manager handler calls exit(0) the instant
    // it accepts POST /v2/manager/reboot — the process dies before sending any HTTP
    // response, so fetch rejects with "Failed to fetch". Because this panel runs
    // INSIDE the live ComfyUI frontend, the server was demonstrably up a moment
    // ago, so a dropped connection here means the reboot fired (not that the
    // endpoint is unreachable). Treat that as success and let the auto-reconnect/
    // resume flow take over. Try the canonical v2 route first, then the legacy
    // GET route for older Manager builds; a real Response that is 404/non-OK means
    // "wrong route on this build" → try the next; 403 means Manager security
    // blocked it (a real, actionable failure). On total failure we RETURN a
    // structured error (rebooting:false) rather than throw, so the agent is told
    // accurately AND the auto-resume flag is not armed.
    const candidates = [
      { route: "/v2/manager/reboot", method: "POST" },
      { route: "/manager/reboot", method: "GET" },
    ];
    const errors = [];
    for (const { route, method } of candidates) {
      try {
        const res = await api.fetchApi(route, { method });
        if (res && res.ok) return { rebooting: true, endpoint: route, method };
        if (res && res.status === 403) {
          return {
            rebooting: false,
            error:
              "ComfyUI-Manager refused the reboot (HTTP 403): rebooting requires the Manager " +
              "security level to be 'middle' or below. Ask the user to lower it in ComfyUI-Manager " +
              "settings, then retry. ComfyUI was NOT restarted.",
          };
        }
        // 404 / other non-OK: this route isn't the one on this build — try next.
        errors.push(`${method} ${route} → HTTP ${res ? res.status : "no response"}`);
      } catch {
        // Connection dropped mid-request = server going down = reboot initiated.
        return {
          rebooting: true,
          endpoint: route,
          method,
          note: "connection dropped (server going down) — reboot initiated",
        };
      }
    }
    return {
      rebooting: false,
      error:
        "Could not reach any ComfyUI-Manager reboot endpoint — ComfyUI was NOT restarted " +
        "(is the built-in Manager enabled?). Tried: " +
        errors.join("; "),
    };
  },
  async free_vram() {
    // Unload all resident models + free cached VRAM via ComfyUI's standard /free
    // endpoint (the same one the "Unload Models"/"Free memory" menu uses). Used to
    // unwedge a stuck/OOM ComfyUI when a cancel left memory pinned — no restart.
    const res = await api.fetchApi("/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to free VRAM: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
    }
    return { freed: true, unload_models: true, free_memory: true };
  },
};

// ---------------------------------------------------------------------------
// Edit focus-follow: when the agent changes a node's WIDGET VALUE, smoothly dart
// the viewport to that node (with 50% padding) so the user watches the change
// land. Scoped to value edits only (not wiring or placement), which kept the
// view from moving around too much. After the edits go quiet, the view
// animates back to a full fit so the whole graph is visible again. Pure
// eye-candy; on by default, toggled by the "Zoom to agent edits" setting
// (Settings → Comfy MCP Agent → General).
// ---------------------------------------------------------------------------

const FOCUS_PAD_PCT = 0.5; // 50% padding around the focused node(s)
const FOCUS_ANIM_MS = 350; // smooth dart duration
const FIT_BACK_MS = 5000; // idle delay before zooming back out to the full fit

function focusFollowEnabled() {
  // Prefer the registered ComfyUI setting (Settings → Comfy MCP Agent →
  // "Zoom to agent edits", default ON). Fall back to the legacy localStorage
  // flag while the setting isn't registered yet (early load), then default ON.
  const v = getSetting(SETTING_FOCUS_FOLLOW);
  if (typeof v === "boolean") return v;
  try {
    return localStorage.getItem("cmcp:focus-follow") !== "0";
  } catch {
    return true;
  }
}

// Per-command extractor for the node id an edit targets. Deliberately ONLY
// widget VALUE edits — not wiring (connect/disconnect), not placement
// (add/move/remove), not mode/title/color — those moved the view around too
// much. Structural ops still get the gentle debounced fit via AUTOFIT_CMDS.
const FOCUS_TARGETS = {
  graph_set_widget: (m) => [m.node_id],
};

/** [x, y, w, h] for a node — prefer litegraph's boundingRect (includes title). */
function nodeFocusBounds(node) {
  const br = node.boundingRect;
  if (Array.isArray(br) && br.length === 4 && (br[2] || br[3])) {
    return [br[0], br[1], br[2], br[3]];
  }
  const w = node.size?.[0] ?? 200;
  const h = node.size?.[1] ?? 100;
  return [node.pos[0], node.pos[1] - 30, w, h + 30]; // title bar renders above pos
}

function unionBounds(list) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of list) {
    minX = Math.min(minX, b[0]);
    minY = Math.min(minY, b[1]);
    maxX = Math.max(maxX, b[0] + b[2]);
    maxY = Math.max(maxY, b[1] + b[3]);
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

/** Animate the viewport to `bounds`, padded by `padPct`, accounting for the
 *  sidebar panel overlay (mirrors the panel-aware inset in graph_canvas "fit"). */
function animateToBoundsPadded(bounds, padPct, duration) {
  const { canvas } = getGraphCtx();
  if (!canvas?.ds) return;
  const b = bounds.slice();
  const padX = b[2] * padPct;
  const padY = b[3] * padPct;
  b[0] -= padX;
  b[1] -= padY;
  b[2] += padX * 2;
  b[3] += padY * 2;
  try {
    const cEl = canvas.canvas;
    const pr = activePanelRoot?.isConnected ? activePanelRoot.getBoundingClientRect() : null;
    const cr = cEl?.getBoundingClientRect?.();
    if (pr && cr && pr.width > 0 && cr.width > 0) {
      const panelOnLeft = (pr.left + pr.right) / 2 < (cr.left + cr.right) / 2;
      const inset = panelOnLeft ? Math.max(0, pr.right - cr.left) : Math.max(0, cr.right - pr.left);
      if (inset > 8 && inset < cr.width * 0.9) {
        const extra = b[2] * (cr.width / (cr.width - inset) - 1);
        b[2] += extra;
        if (panelOnLeft) b[0] -= extra;
      }
    }
  } catch {
    // measurement unavailable — fall back to the un-inset bounds
  }
  if (typeof canvas.animateToBounds === "function") {
    canvas.animateToBounds(b, { duration });
    return;
  }
  // No animation support — set instantly.
  const ds = canvas.ds;
  const el = canvas.canvas;
  const next = Math.min(el.width / b[2], el.height / b[3], 1.5);
  ds.scale = next;
  ds.offset[0] = -b[0] + (el.width / next - b[2]) / 2;
  ds.offset[1] = -b[1] + (el.height / next - b[3]) / 2;
  canvas.setDirty(true, true);
}

/** Smoothly dart to the node(s) with the given ids (skips ones not found). */
function focusNodesById(ids) {
  let graph;
  try {
    ({ graph } = getGraphCtx());
  } catch {
    return; // canvas not ready
  }
  if (!graph) return;
  const boxes = [];
  for (const id of ids) {
    if (id == null) continue;
    let node;
    try {
      node = resolveNode(graph, id);
    } catch {
      continue; // id not on the currently-viewed graph (e.g. inside a subgraph)
    }
    if (node) boxes.push(nodeFocusBounds(node));
  }
  if (boxes.length) animateToBoundsPadded(unionBounds(boxes), FOCUS_PAD_PCT, FOCUS_ANIM_MS);
}

let fitBackTimer = null;
/** (Re)arm the "zoom back out to the whole graph" animation; fires once the
 *  agent's edits go quiet for FIT_BACK_MS. */
function scheduleFitBack() {
  if (fitBackTimer) clearTimeout(fitBackTimer);
  fitBackTimer = setTimeout(() => {
    fitBackTimer = null;
    try {
      GRAPH_TOOL_EXECUTORS.graph_canvas({ action: "fit" });
    } catch {
      // empty graph / canvas unavailable — nothing to fit
    }
  }, FIT_BACK_MS);
}

/** React to a completed agent command: dart to the edited node, and arm the
 *  zoom-back-out. Called from the bridge's onCommand after each ok reply. */
function focusFollowOnCommand(cmd, msg, reply) {
  if (!reply?.ok || !focusFollowEnabled()) return false;
  const targeter = FOCUS_TARGETS[cmd];
  if (!targeter) return false;
  try {
    focusNodesById(targeter(msg, reply));
  } catch {
    // never let eye-candy break command handling
  }
  scheduleFitBack();
  return true;
}

// ---------------------------------------------------------------------------
// Bridge client: WS connection to the comfyui-mcp server with auto-reconnect.
// ---------------------------------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

function createBridgeClient({ onStatus, onSay, onStream, onLog, onCommand, onAsk, onSecret, onReload, onTodo, onShowMedia, onDownloads, onThinking, onAgentStatus, onSession, onModels, onCommands, onAck, onTurn, onTurnAnchor, getResume, onHandshakeTimeout, onBridgeClosed }) {
  let sock = null;
  let url = loadBridgeUrl();
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;
  // De-duped status emitter. The pill only ever needs TRANSITIONS, so collapsing
  // consecutive repeats is a guard against any path double-emitting the same state
  // (and keeps the cold-start steady-"connecting" from re-painting on every retry).
  // "connected" is never swallowed — a re-handshake must still re-run its side
  // effects (budget reset, soft-reload interlock release).
  let lastStatus = null;
  function emitStatus(s) {
    if (s === lastStatus && s !== "connected") return;
    lastStatus = s;
    onStatus(s);
  }
  // FIX 1/2 — STEADY status + cold-start patience. While we're actively (auto)
  // reconnecting we hold the pill on a steady "connecting"; a terminal
  // "disconnected" ("couldn't connect") is only surfaced once the patient
  // cold-start window is exhausted. The bounded reconnect/respawn machinery keeps
  // trying underneath either way — `gaveUp` just latches the terminal display so
  // later background retries don't re-pulse the pill connecting↔disconnected.
  let gaveUp = false;
  let loggedWaiting = false; // FIX 3 — throttle the "waiting for the panel agent" log
  function backendNow() {
    try {
      return window.localStorage.getItem(STORAGE_KEY_BACKEND) || "claude";
    } catch {
      return "claude";
    }
  }
  // Bare WS retries before escalating to the BOUNDED /connect respawn. Codex's
  // `codex app-server` cold-starts much slower than Claude's Agent SDK, so it gets
  // ~3x the window. This is the escalation THRESHOLD only — the respawn/reclaim
  // BOUNDS (MAX_AUTO_RESPAWNS / MAX_AUTO_RECLAIMS) are untouched.
  const RESPAWN_AFTER_BY_BACKEND = { codex: 6, gemini: 6, claude: 2 };
  function respawnAfterAttempts() {
    return RESPAWN_AFTER_BY_BACKEND[backendNow()] ?? 2;
  }
  // Failed (re)connect attempts ridden out as a steady "connecting" before a
  // terminal "disconnected". Backend-aware, ~3x for Codex's slower cold start.
  const CONNECT_PATIENCE_BY_BACKEND = { codex: 12, gemini: 12, claude: 4 };
  function connectPatienceAttempts() {
    return CONNECT_PATIENCE_BY_BACKEND[backendNow()] ?? 4;
  }
  // Truthful "connected": a WS open is NOT enough — we only flip to "connected"
  // once the orchestrator handshake (its `models` frame) arrives. A non-orchestrator
  // squatter on the port (some other process) never sends it,
  // so the panel won't lie "connected" when there's no agent behind the socket.
  let handshakeTimer = null;
  let handshakeDone = false;
  // Handshake (models-frame) window AFTER the WS opens. Backend-aware: Codex's
  // app-server can still be booting its agent after the bridge accepts the socket,
  // so it gets a wider window before we treat the open socket as wedged (FIX 2).
  const HANDSHAKE_MS_BY_BACKEND = { codex: 45000, gemini: 45000, claude: 20000 };
  function handshakeMs() {
    return HANDSHAKE_MS_BY_BACKEND[backendNow()] ?? 20000;
  }
  function clearHandshake() {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  }
  function markConnected() {
    handshakeDone = true;
    clearHandshake();
    // Remember the user wants the agent connected, so we auto-reconnect after a
    // ComfyUI reboot / panel reopen (until they explicitly Disconnect). Mirror it
    // into the "Auto-connect on load" setting so the toggle reflects reality.
    lsSet(AUTOCONNECT_KEY, "1");
    setSetting(SETTING_AUTOCONNECT, true);
    // The REAL handshake landed — this is the ONLY place patience resets. A bare
    // WS open must NOT reset it: an orchestrator that repeatedly opens-then-closes
    // before sending `models` (crash loop / agent boot failure / a wrong process
    // that accepts-then-drops) would otherwise keep attempt pinned at 1 and spin
    // "connecting" forever, masking a genuine terminal failure.
    attempt = 0;
    gaveUp = false;
    loggedWaiting = false;
    emitStatus("connected");
  }

  function connect() {
    if (closed) return;
    // Re-entrancy guard: never open a second socket while one is already
    // connecting/open (multiple callers — reconnect timer, post-restart resume,
    // Connect button — can race).
    if (sock && (sock.readyState === WebSocket.CONNECTING || sock.readyState === WebSocket.OPEN)) {
      return;
    }
    // Steady "connecting" while we're still within the patient cold-start window.
    // Once we've given up (patience exhausted) we DON'T flip back to "connecting"
    // on each background retry — that latched "disconnected" is what stops the
    // connecting↔disconnected flicker.
    if (!gaveUp) emitStatus("connecting");
    try {
      sock = new WebSocket(url);
    } catch (err) {
      // Constructor threw before a socket exists → no open/close will fire, so we
      // drive the retry directly. Keep the status steady (scheduleReconnect decides
      // connecting-vs-terminal); do NOT flip to "disconnected" here (FIX 1).
      scheduleReconnect();
      return;
    }

    sock.addEventListener("open", () => {
      handshakeDone = false;
      // A bare WS open is NOT progress — the orchestrator handshake (`models`)
      // hasn't arrived yet. Do NOT reset attempt/gaveUp here (only markConnected
      // does), so an open-then-close-before-`models` cycle still INCREMENTS toward
      // the patience terminal. While we're still patient, show "connecting"; once
      // gaveUp is latched, a mere open must NOT clear it back to "connecting" —
      // only a real `models` handshake (markConnected) does.
      if (!gaveUp) emitStatus("connecting");
      // FIX 3 — log the "waiting for the panel agent" line ONCE per connect
      // sequence instead of on every (re)open during a cold-start flicker.
      if (!loggedWaiting) {
        loggedWaiting = true;
        onLog(`Connected to ${url} — waiting for the panel agent…`);
      }
      sendHello();
      clearHandshake();
      handshakeTimer = setTimeout(() => {
        if (handshakeDone) return;
        // The WS is OPEN but no orchestrator handshake (models frame) arrived
        // within the generous cold-start window. Two causes: (1) a WEDGED
        // orchestrator — alive, bridge up, agent dead — or (2) some non-orchestrator
        // process squatting the port. Hand off to the panel's bounded auto-reclaim
        // (force-respawn + reconnect); only if THAT is exhausted does it fall back
        // to the manual warning below. If no handler is wired, warn directly.
        const handled = onHandshakeTimeout?.(url);
        if (!handled) {
          onLog(
            `⚠ Bridge open on ${url} but no panel agent responded. Something else may be holding the port. ` +
              `Close it, or fully restart ComfyUI, then reconnect.`,
          );
        }
      }, handshakeMs());
    });

    sock.addEventListener("message", async (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg && typeof msg.rid === "string" && typeof msg.cmd === "string") {
        // Agent command — execute against the graph, reply with the rid.
        // Executors may be async (run, save) — await uniformly.
        let reply;
        try {
          let result;
          if (msg.cmd === "ask_user") {
            // Not a graph executor — render an interactive question card in the
            // chat (UI scope) and block on the user's pick. The chosen string
            // becomes the tool result the agent receives.
            if (!onAsk) throw new Error("This panel build can't display questions.");
            result = await onAsk(msg);
          } else if (msg.cmd === "request_secret") {
            // Secure secret entry. The pasted value rides back to the
            // orchestrator (which writes it to config) and is the tool's reply;
            // it is never surfaced to the agent's context or recorded to history.
            if (!onSecret) throw new Error("This panel build can't collect secrets.");
            result = await onSecret(msg);
          } else if (msg.cmd === "soft_reload") {
            // Agent-triggered soft reload. Reply FIRST (below), then bounce —
            // an "orchestrator" scope kills this very session, so the resume
            // flow (SOFT_RELOAD_KEY) continues the conversation afterward.
            if (!onReload) throw new Error("This panel build can't soft-reload.");
            const scope = msg.scope === "frontend" ? "frontend" : "orchestrator";
            result = `soft reload (${scope}) scheduled`;
            setTimeout(() => onReload(scope), 60);
          } else if (msg.cmd === "set_todo") {
            // Render/update the agent's live TODO checklist in the footer tray.
            const items = Array.isArray(msg.items) ? msg.items : [];
            onTodo?.(items);
            result = { ok: true, count: items.length };
          } else if (msg.cmd === "show_media") {
            // Render agent-requested media (images/videos) into the chat.
            // items: [{ kind: "image"|"video"|"viewRef", dataUrl?, viewRef?, filename, caption? }]
            const mediaItems = Array.isArray(msg.items) ? msg.items : [];
            onShowMedia?.(mediaItems);
            result = { ok: true, count: mediaItems.length };
          } else {
            const executor = GRAPH_TOOL_EXECUTORS[msg.cmd];
            if (!executor) throw new Error(`Unknown command "${msg.cmd}"`);
            result = await executor(msg);
          }
          reply = { rid: msg.rid, ok: true, result };
        } catch (err) {
          reply = {
            rid: msg.rid,
            ok: false,
            error: err && err.message ? err.message : String(err),
          };
        }
        try {
          sock.send(JSON.stringify(reply));
        } catch {
          // Socket died between receive and reply — agent side times out.
        }
        // ask_user / request_secret paint their OWN cards and their replies carry
        // user input (a choice, or a SECRET) — never echo them as an activity card
        // (and never record them). Other commands get the normal activity card.
        if (msg.cmd !== "ask_user" && msg.cmd !== "request_secret" && msg.cmd !== "set_todo" && msg.cmd !== "show_media") {
          onCommand?.(msg.cmd, msg, reply);
        }
        return;
      }
      if (msg && msg.type === "say" && typeof msg.text === "string") {
        // `id` reconciles this committed reply with its live streaming preview.
        onSay(msg.text, { id: msg.id, streamed: !!msg.streamed });
      }
      // Live streaming deltas: incremental thinking / reply text before the final
      // `say` commits. phase: "think" | "text" | "end".
      if (msg && msg.type === "stream" && typeof msg.id === "string") {
        onStream?.(msg);
      }
      // Optional agent-side status (context window fill, model name).
      if (msg && msg.type === "agent_status") {
        onAgentStatus?.(msg);
      }
      // Session lifecycle: the orchestrator reports the SDK session id (or null
      // on a reset) so the panel can persist it and resume across reloads.
      if (msg && msg.type === "session") {
        onSession?.(typeof msg.session_id === "string" ? msg.session_id : null);
      }
      // Per-turn rewind anchor (assistant UUID) → the panel stores it so a
      // later "rewind conversation to here" can fork the session at that point.
      if (msg && msg.type === "turn_anchor" && typeof msg.uuid === "string") {
        onTurnAnchor?.(msg.uuid);
      }
      // Live model catalog from the orchestrator (SDK-probed). This is also the
      // orchestrator HANDSHAKE — receiving it proves a real panel agent is behind
      // the socket, so it's the moment we truthfully flip to "connected".
      if (msg && msg.type === "models" && Array.isArray(msg.models)) {
        markConnected();
        onModels?.(
          msg.models,
          typeof msg.current === "string" ? msg.current : undefined,
          typeof msg.backend === "string" ? msg.backend : undefined,
        );
      }
      // SDK slash commands (built-ins like /compact, plus any loaded skills) —
      // surfaced in the composer's completion menu.
      if (msg && msg.type === "commands" && Array.isArray(msg.commands)) {
        onCommands?.(msg.commands);
      }
      // Structured acks (ready / working / options / …). The "ready" ack is sent
      // after the orchestrator has processed hello (resume armed), so it's the
      // reliable signal to send a post-restart resume nudge.
      if (msg && msg.type === "ack") {
        // A "degraded" ack is the orchestrator's OWN handshake: it's alive and
        // attending, but its agent backend can't enumerate models yet (typically
        // sign-in needed). That is NOT the "bridge open but nothing behind it"
        // wedge — so DISARM the no-handshake timer (no force-reclaim of a valid,
        // sign-in-needed orchestrator) WITHOUT calling markConnected(). `models`
        // stays the ONLY path to green/"connected"; a degraded orchestrator just
        // surfaces its own "please sign in" message and is left running.
        if (msg.kind === "degraded") clearHandshake();
        onAck?.(msg);
      }
      // Turn lifecycle → "working" indicator (working stays up through the whole
      // turn incl. silent tool work; done clears it).
      if (msg && msg.type === "turn" && typeof msg.state === "string") {
        onTurn?.(msg.state);
      }
      // Live download progress for the status tray (sourced orchestrator-side
      // from the download tool's temp progress file and/or the Manager queue).
      if (msg && msg.type === "download_progress" && Array.isArray(msg.downloads)) {
        onDownloads?.(msg.downloads);
      }
      // Live extended-thinking token count → "thinking… (N)" indicator.
      if (msg && msg.type === "thinking" && typeof msg.tokens === "number") {
        onThinking?.(msg.tokens);
      }
      // "echo" frames are ignored — we render the user bubble locally on send.
    });

    sock.addEventListener("close", () => {
      sock = null;
      handshakeDone = false;
      clearHandshake();
      lastBridgeDownAt = Date.now(); // for the fast-vs-slow reconnect heuristic
      if (!closed) {
        // FIX 1 — auto-reconnecting: keep the pill STEADY (scheduleReconnect picks
        // connecting-vs-terminal based on the patience window). Do NOT flip to
        // "disconnected" between attempts — that was the source of the flicker.
        scheduleReconnect();
      }
    });

    sock.addEventListener("error", () => {
      // close fires after error; reconnect handled there.
    });
  }

  function sendHello() {
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    try {
      // Carry the last session id so the orchestrator resumes the agent's
      // memory after a panel reload (only honored before the tab's agent spawns).
      const resume = getResume?.();
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: getTabId(),
          title: getWorkflowTitle(),
          ...(resume ? { resume } : {}),
        }),
      );
    } catch {
      // Reconnect path will retry.
    }
  }

  // When the workflow title changes (rename / open a different file / progress
  // ticks during a run / each graph edit toggling the modified "*"), send a
  // LIGHTWEIGHT title update — NOT a full hello. A full hello re-greets the user
  // ("agent ready"), so re-helloing on every title mutation during a build/run
  // produced a greeting storm. Deduped so identical titles don't spam.
  const titleEl = document.querySelector("title");
  let lastSentTitle = null;
  function sendTitle() {
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    const t = getWorkflowTitle();
    if (t === lastSentTitle) return;
    lastSentTitle = t;
    try {
      sock.send(JSON.stringify({ type: "title", tab_id: getTabId(), title: t }));
    } catch {
      // dropped — next mutation retries
    }
  }
  const titleObserver = titleEl ? new MutationObserver(() => sendTitle()) : null;
  titleObserver?.observe(titleEl, { childList: true });

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    // FIX 1/2 — STATUS: hold a steady "connecting" while we're still inside the
    // patient (backend-aware) cold-start window; only once it's exhausted do we
    // latch a terminal "disconnected" ("couldn't connect"). The reconnect/respawn
    // machinery below keeps trying regardless — this only governs the pill so it
    // neither thrashes nor lies.
    if (attempt > connectPatienceAttempts()) {
      gaveUp = true;
      emitStatus("disconnected");
    } else if (!gaveUp) {
      emitStatus("connecting");
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // The WS keeps failing to (re)open → the bridge port is likely dead. If the
      // panel's sticky-autoconnect respawn handles it (re-POST /connect, bounded),
      // let IT drive the client; otherwise fall back to a bare WS retry. The respawn
      // budget is NOT replenished by an automatic close (only by a successful
      // handshake / a user-initiated Connect), so a persistent failure loop
      // (respawn → agent fails → self-exit → respawn …) terminates instead of
      // spinning hot. The escalation THRESHOLD (respawnAfterAttempts) is backend-
      // aware so Codex's slower cold start gets more bare retries before we respawn;
      // the respawn/reclaim BOUNDS themselves are unchanged.
      if (attempt > respawnAfterAttempts() && onBridgeClosed?.() === true) return;
      connect();
    }, delay);
  }

  return {
    start() {
      closed = false;
      // A fresh connect intent (user Connect / sticky reconnect / respawn handoff)
      // restarts the patient cold-start window: clear the terminal latch and the
      // attempt count so we ride out the slow boot again as a steady "connecting"
      // (and the "waiting for the panel agent" line logs once more). FIX 1/2/3.
      gaveUp = false;
      loggedWaiting = false;
      attempt = 0;
      connect();
    },
    sendUserMessage(text, context, images, mid) {
      if (!sock || sock.readyState !== WebSocket.OPEN) return false;
      try {
        sock.send(
          JSON.stringify({
            type: "user_message",
            text,
            ...(context ? { context } : {}),
            ...(images?.length ? { images } : {}),
            // Client message id — the orchestrator echoes it in the "working"
            // ack so the panel can mark this exact bubble delivered ("Seen").
            ...(mid ? { mid } : {}),
          }),
        );
        return true;
      } catch {
        return false;
      }
    },
    /** Send an arbitrary control frame (set_options, new_session, …). */
    sendFrame(frame) {
      if (!sock || sock.readyState !== WebSocket.OPEN) return false;
      try {
        sock.send(JSON.stringify({ tab_id: getTabId(), ...frame }));
        return true;
      } catch {
        return false;
      }
    },
    setUrl(next) {
      url = next || DEFAULT_BRIDGE_URL;
      saveBridgeUrl(url);
      attempt = 0;
      // Pointing at a new bridge is a fresh connect → restart the patience window.
      gaveUp = false;
      loggedWaiting = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        sock?.close();
      } catch {}
      sock = null;
      connect();
    },
    currentUrl() {
      return url;
    },
    isConnected() {
      return !!sock && sock.readyState === WebSocket.OPEN;
    },
    stop() {
      // Close the socket and stop reconnecting, but stay re-startable (unlike
      // destroy, which also tears down the title observer for good).
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        sock?.close();
      } catch {}
      sock = null;
    },
    destroy() {
      closed = true;
      titleObserver?.disconnect();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        sock?.close();
      } catch {}
      sock = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Panel DOM — styled on ComfyUI's own design system. Every color, radius,
// and font below consumes the PrimeVue semantic tokens (`--p-*`) the native
// sidebar panels use, with hard fallbacks for older frontends, so the panel
// tracks the user's theme (light/dark/custom) automatically.
// ---------------------------------------------------------------------------

const PANEL_CSS = `
.cmcp-root {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  position: relative; /* positioning context for the rollback modal overlay */
  font-family: var(--font-inter, "Inter", ui-sans-serif, system-ui, sans-serif);
  font-size: 0.8125rem; line-height: 1.5;
  color: var(--p-text-color, #fff);
  background: var(--p-content-background, #18181b);
}
.cmcp-header {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color, #3f3f46);
}
.cmcp-logo { width: 20px; height: 20px; flex: none; border-radius: 4px; object-fit: contain; display: block; }
.cmcp-title { font-size: 0.9375rem; font-weight: 600; }
.cmcp-status { display: flex; align-items: center; gap: 0.375rem; margin-left: auto;
  font-size: 0.6875rem; color: var(--p-text-muted-color, #a1a1aa); }
.cmcp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--p-red-400, #f87171); flex: none; }
.cmcp-dot.connected { background: var(--p-green-400, #4ade80); }
.cmcp-dot.connecting { background: var(--p-yellow-400, #facc15); animation: cmcp-pulse 1.2s ease-in-out infinite; }
@keyframes cmcp-pulse { 50% { opacity: 0.3; } }
.cmcp-spin i { animation: cmcp-spin 0.8s linear infinite; }
@keyframes cmcp-spin { to { transform: rotate(360deg); } }

.cmcp-settings {
  margin: 0.625rem 0.75rem 0;
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-lg, 8px);
  background: var(--p-surface-800, #27272a);
}
.cmcp-settings > summary {
  padding: 0.5rem 0.75rem; cursor: pointer; user-select: none;
  font-size: 0.75rem; font-weight: 600; color: var(--p-text-muted-color, #a1a1aa);
  list-style: none; display: flex; align-items: center; gap: 0.375rem;
}
.cmcp-settings > summary::before { content: "▸"; transition: transform 0.15s; }
.cmcp-settings[open] > summary::before { transform: rotate(90deg); }
.cmcp-settings-body { padding: 0 0.75rem 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
.cmcp-label { font-size: 0.6875rem; color: var(--p-text-muted-color, #a1a1aa); }
.cmcp-input {
  width: 100%; box-sizing: border-box;
  padding: var(--p-form-field-padding-y, 0.5rem) var(--p-form-field-padding-x, 0.75rem);
  background: var(--p-form-field-background, #09090b);
  border: 1px solid var(--p-form-field-border-color, #52525b);
  border-radius: var(--p-border-radius-md, 6px);
  color: var(--p-form-field-color, #fff);
  font: inherit; outline: none; transition: border-color 0.15s;
}
.cmcp-input:focus { border-color: var(--p-focus-ring-color, #60a5fa); }
.cmcp-btn {
  padding: 0.4375rem 0.875rem; cursor: pointer; align-self: flex-start;
  background: var(--p-button-primary-background, var(--p-primary-color, #60a5fa));
  color: var(--p-button-primary-color, var(--p-primary-contrast-color, #18181b));
  border: none; border-radius: var(--p-border-radius-md, 6px);
  font: inherit; font-weight: 600; transition: opacity 0.15s;
}
.cmcp-btn:hover { opacity: 0.85; }
.cmcp-btn:disabled { opacity: 0.4; cursor: default; }
.cmcp-help { font-size: 0.6875rem; color: var(--p-text-muted-color, #a1a1aa); line-height: 1.55; }
.cmcp-cmd {
  display: block; margin-top: 0.25rem; padding: 0.375rem 0.5rem;
  background: var(--p-form-field-background, #09090b);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-sm, 4px);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem;
  user-select: all; cursor: copy; color: var(--p-text-color, #fff);
  overflow-x: auto; white-space: nowrap;
}

/* Middle section: bounded flex body whose only job is to host the scroll
   surface, so the header and composer stay pinned. */
.cmcp-body {
  flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
  overflow: hidden;
}
.cmcp-log {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0.75rem;
  display: flex; flex-direction: column; gap: 0.5rem;
}
.cmcp-empty {
  margin: auto; text-align: center; max-width: 230px;
  color: var(--p-text-muted-color, #a1a1aa);
}
.cmcp-empty .pi { font-size: 1.75rem; display: block; margin-bottom: 0.5rem; opacity: 0.5; }
.cmcp-empty-title { font-weight: 600; color: var(--p-text-color, #fff); margin-bottom: 0.25rem; }
.cmcp-examples { display: flex; flex-direction: column; gap: 0.375rem; margin-top: 0.875rem; text-align: left; }
.cmcp-example {
  display: flex; align-items: center; gap: 0.5rem; width: 100%; box-sizing: border-box;
  padding: 0.4375rem 0.625rem; cursor: pointer; font: inherit; font-size: 0.75rem;
  color: var(--p-text-color, #fff); text-align: left;
  background: var(--p-surface-800, #27272a);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-md, 6px);
  transition: border-color 0.15s, background 0.15s;
}
.cmcp-example:hover { border-color: var(--p-primary-color, #60a5fa); background: var(--p-surface-700, #3f3f46); }
.cmcp-example .pi { font-size: 0.8125rem; margin: 0; opacity: 1; color: var(--p-primary-color, #60a5fa); flex: none; }

/* Provider onboarding card — shown only when NEITHER provider is signed in. */
.cmcp-onboard {
  margin: 0.75rem; padding: 0.75rem 0.875rem;
  background: var(--p-surface-800, #27272a);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-md, 6px);
  display: flex; flex-direction: column; gap: 0.5rem;
}
.cmcp-onboard-title { font-weight: 600; color: var(--p-text-color, #fff); }
.cmcp-onboard-sub { font-size: 0.75rem; color: var(--p-text-muted-color, #a1a1aa); line-height: 1.4; }
.cmcp-onboard-col { display: flex; flex-direction: column; gap: 0.25rem; }
.cmcp-onboard-prov { font-weight: 600; font-size: 0.8125rem; color: var(--p-text-color, #fff); margin-top: 0.25rem; }
.cmcp-onboard-step { font-size: 0.7rem; color: var(--p-text-muted-color, #a1a1aa); }

.cmcp-bubble {
  padding: 0.5rem 0.75rem; max-width: 92%;
  border-radius: var(--p-border-radius-lg, 8px);
  white-space: pre-wrap; word-wrap: break-word;
  animation: cmcp-in 0.18s ease-out;
}
@keyframes cmcp-in { from { opacity: 0; transform: translateY(4px); } }
.cmcp-bubble.user {
  align-self: flex-end;
  position: relative; /* anchor for the absolute hover edit button (no reflow) */
  background: var(--p-highlight-background, rgba(96,165,250,0.16));
  border: 1px solid color-mix(in srgb, var(--p-primary-color, #60a5fa), transparent 70%);
}
/* Hover edit/rollback button — absolute to the LEFT so it never reflows text. */
.cmcp-edit-btn {
  position: absolute; left: -1.75rem; top: 0.1rem;
  width: 1.4rem; height: 1.4rem; padding: 0; border-radius: 5px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--p-content-border-color, #3f3f46);
  background: var(--p-surface-800, #27272a); color: var(--p-text-muted-color, #a1a1aa);
  cursor: pointer; opacity: 0; transition: opacity 0.12s, color 0.12s; font-size: 0.7rem;
}
.cmcp-bubble.user:hover .cmcp-edit-btn { opacity: 1; }
.cmcp-edit-btn:hover { color: var(--p-primary-color, #60a5fa); border-color: var(--p-primary-color, #60a5fa); }
/* Rollback modal */
.cmcp-modal-overlay {
  position: absolute; inset: 0; z-index: 50; display: flex; align-items: center;
  justify-content: center; padding: 1rem; background: rgba(0,0,0,0.45);
}
.cmcp-modal {
  width: 100%; max-width: 22rem; display: flex; flex-direction: column; gap: 0.6rem;
  padding: 0.85rem; border-radius: 10px; background: var(--p-surface-900, #18181b);
  border: 1px solid var(--p-content-border-color, #3f3f46); box-shadow: 0 8px 30px rgba(0,0,0,0.5);
}
.cmcp-modal-title { font-weight: 600; font-size: 0.85rem; }
.cmcp-modal-text {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 3.5rem;
  padding: 0.4rem 0.5rem; border-radius: 6px; font: inherit; font-size: 0.8rem;
  background: var(--p-surface-950, #111113); color: inherit;
  border: 1px solid var(--p-surface-500, #555);
}
.cmcp-modal-scopes { display: flex; flex-direction: column; gap: 0.3rem; }
.cmcp-modal-scope { display: flex; gap: 0.4rem; align-items: flex-start; font-size: 0.72rem; cursor: pointer; }
.cmcp-modal-scope input { margin-top: 0.15rem; }
.cmcp-modal-btns { display: flex; justify-content: flex-end; gap: 0.4rem; }
.cmcp-btn-primary { background: var(--p-primary-color, #3a7bd5); color: #fff; border: none; }
/* Agent text flows freely — no card/bubble. Only user messages are boxed. */
.cmcp-bubble.agent {
  align-self: stretch; max-width: 100%;
  padding: 0; background: none; border: none; border-radius: 0;
  /* Rendered markdown is real block elements — collapse the source newlines
     marked emits between tags (the base .cmcp-bubble pre-wrap would otherwise
     render every one as a blank line, ballooning the vertical spacing). Block
     margins below handle the rhythm. */
  white-space: normal;
}
/* While a reply is still STREAMING it's plain text (not yet markdown), so it
   needs pre-wrap to honor its newlines; the commit drops the .streaming class
   and it reverts to normal markdown flow. */
.cmcp-bubble.agent.streaming .cmcp-reply { white-space: pre-wrap; }
/* Per-message delivery status: invisible on success (a normal bubble = received
   and not dropped); only a FAILED send shows up — the bubble tints red and the
   status row exposes ✎ edit / ✕ delete. */
.cmcp-msg-status {
  align-self: flex-end; max-width: 92%;
  margin: 0.0625rem 0.125rem 0.125rem;
  font-size: 0.6875rem; color: var(--p-text-muted-color, #71717a);
  display: flex; gap: 0.375rem; align-items: center;
}
.cmcp-msg-status:empty { display: none; }
/* Queued: received but NOT yet read by the agent — muted/dimmed until it's read. */
.cmcp-bubble.user.queued { opacity: 0.5; }
.cmcp-bubble.user.failed {
  opacity: 1;
  border-color: color-mix(in srgb, var(--p-red-400, #f87171), transparent 35%);
  background: color-mix(in srgb, var(--p-red-400, #f87171), transparent 86%);
}
.cmcp-msg-action {
  background: none; border: none; padding: 0.0625rem; cursor: pointer;
  display: inline-flex; align-items: center; line-height: 1;
  color: var(--p-text-muted-color, #71717a);
  border-radius: var(--p-border-radius-sm, 4px);
  transition: color 0.12s, background 0.12s;
}
.cmcp-msg-action .pi { font-size: 0.75rem; }
.cmcp-msg-action:hover { color: var(--p-text-color, #fff); background: var(--p-surface-700, #3f3f46); }
.cmcp-msg-status.failed .cmcp-msg-action:hover { color: var(--p-red-300, #fca5a5); }
.cmcp-bubble.agent code, .cmcp-bubble.user code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem;
  background: var(--p-form-field-background, #09090b);
  padding: 0.0625rem 0.25rem; border-radius: var(--p-border-radius-sm, 4px);
}
/* GFM rendering (marked output) inside bubbles. */
.cmcp-bubble > :first-child { margin-top: 0; }
.cmcp-bubble > :last-child { margin-bottom: 0; }
.cmcp-bubble p { margin: 0 0 0.5rem; }
.cmcp-bubble ul, .cmcp-bubble ol { margin: 0 0 0.5rem; padding-left: 1.25rem; }
.cmcp-bubble li { margin: 0.125rem 0; }
.cmcp-bubble li > p { margin: 0; }
.cmcp-bubble h1, .cmcp-bubble h2, .cmcp-bubble h3,
.cmcp-bubble h4, .cmcp-bubble h5, .cmcp-bubble h6 {
  margin: 0.625rem 0 0.25rem; font-weight: 600; line-height: 1.3;
}
.cmcp-bubble h1 { font-size: 1.05rem; }
.cmcp-bubble h2 { font-size: 1rem; }
.cmcp-bubble h3 { font-size: 0.9375rem; }
.cmcp-bubble h4, .cmcp-bubble h5, .cmcp-bubble h6 { font-size: 0.875rem; }
.cmcp-bubble a { color: var(--p-primary-color, #60a5fa); text-decoration: underline; }
.cmcp-bubble blockquote {
  margin: 0.5rem 0; padding: 0.125rem 0 0.125rem 0.75rem;
  border-left: 3px solid var(--p-content-border-color, #3f3f46);
  color: var(--p-text-muted-color, #a1a1aa);
}
.cmcp-bubble hr { border: none; border-top: 1px solid var(--p-content-border-color, #3f3f46); margin: 0.75rem 0; }
.cmcp-bubble img { max-width: 100%; border-radius: var(--p-border-radius-md, 6px); }
.cmcp-bubble pre {
  margin: 0.375rem 0; padding: 0.5rem 0.625rem;
  background: var(--p-form-field-background, #09090b);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-md, 6px);
  overflow-x: auto; max-height: 20rem; overflow-y: auto;
  font-size: 0.6875rem; line-height: 1.5; tab-size: 2;
}
.cmcp-bubble.agent pre code, .cmcp-bubble.user pre code {
  background: none; padding: 0; border-radius: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre; color: var(--p-text-color, #fff);
}
/* Hover tools on rendered code (decorateCode): Copy + Wrap on fenced blocks,
   Copy on inline pills. Buttons are absolute so they never reflow the code, and
   match the panel's .cmcp-iconbtn style (borderless, muted, hover surface+white). */
.cmcp-bubble pre.cmcp-codeblock { position: relative; }
.cmcp-code-tools {
  position: absolute; top: 0.3rem; right: 0.3rem; display: flex; gap: 0.125rem;
  opacity: 0; transition: opacity 0.12s;
}
.cmcp-bubble pre.cmcp-codeblock:hover .cmcp-code-tools,
.cmcp-code-tools:focus-within { opacity: 1; }
.cmcp-code-tool {
  width: 1.5rem; height: 1.5rem; flex: none; padding: 0;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; cursor: pointer;
  border-radius: var(--p-border-radius-sm, 4px);
  color: var(--p-text-muted-color, #a1a1aa);
  transition: background 0.15s, color 0.15s;
}
.cmcp-code-tool:hover { background: var(--p-surface-700, #3f3f46); color: var(--p-text-color, #fff); }
.cmcp-code-tool .pi { font-size: 0.8rem; }
.cmcp-code-tool.ok { color: #4ade80; }
.cmcp-wrap-btn.on { color: var(--p-primary-color, #60a5fa); }
.cmcp-wrap-btn.on:hover { color: var(--p-primary-color, #60a5fa); }
/* Wrap toggle: flip the block from horizontal-scroll (pre) to wrapping. Higher
   specificity than the base pre-code rule so no !important is needed. */
.cmcp-bubble pre.cmcp-codeblock.cmcp-wrap { overflow-x: hidden; }
.cmcp-bubble pre.cmcp-codeblock.cmcp-wrap code { white-space: pre-wrap; word-break: break-word; }
/* Inline code copy: a small badge at the pill's top-right corner, shown on hover.
   Same muted→surface+white treatment as the icon buttons, sized for the pill. */
.cmcp-bubble.agent code.cmcp-inline-code, .cmcp-bubble.user code.cmcp-inline-code { position: relative; }
.cmcp-inline-copy {
  position: absolute; top: -0.5rem; right: -0.35rem; width: 1.1rem; height: 1.1rem; padding: 0;
  display: none; align-items: center; justify-content: center;
  background: var(--p-surface-700, #3f3f46); border: none; border-radius: 4px;
  color: var(--p-text-muted-color, #a1a1aa); cursor: pointer;
  font-size: 0.55rem; line-height: 1; z-index: 2; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
  transition: background 0.12s, color 0.12s;
}
.cmcp-bubble code.cmcp-inline-code:hover .cmcp-inline-copy { display: flex; }
.cmcp-inline-copy:hover { background: var(--p-surface-600, #52525b); color: var(--p-text-color, #fff); }
.cmcp-inline-copy.ok { color: #4ade80; display: flex; }
.cmcp-bubble table {
  /* Real table layout (NOT display:block) so the header row stays aligned with
     the body; fit the panel width and let long cells wrap instead of scrolling. */
  display: table; width: 100%; table-layout: fixed;
  border-collapse: collapse; margin: 0.5rem 0; font-size: 0.6875rem;
}
.cmcp-bubble th, .cmcp-bubble td {
  border: 1px solid var(--p-content-border-color, #3f3f46);
  padding: 0.25rem 0.5rem; text-align: left; vertical-align: top;
  overflow-wrap: anywhere; word-break: break-word;
}
.cmcp-bubble th { background: var(--p-surface-800, #27272a); font-weight: 600; }
.cmcp-newmsg {
  position: absolute; left: 50%; transform: translateX(-50%); bottom: 0.6rem; z-index: 6;
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.3rem 0.75rem; border-radius: 999px; border: none; cursor: pointer;
  background: var(--p-primary-color, #2563eb); color: var(--p-primary-contrast-color, #fff);
  font: inherit; font-size: 0.7rem; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
}
.cmcp-newmsg .pi { font-size: 0.7rem; }
/* The base rule sets display, which beats the UA [hidden] rule — so re-assert
   it or "newMsgBtn.hidden = true" won't actually hide the pill. */
.cmcp-newmsg[hidden] { display: none; }
.cmcp-tray {
  flex: none; margin: 0 0.5rem 0.25rem; padding: 0.4rem 0.55rem;
  background: var(--p-surface-800, #27272a); border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: 8px; max-height: 9rem; overflow-y: auto; font-size: 0.7rem;
}
.cmcp-tray[hidden] { display: none; }
.cmcp-tray-head { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.55; margin-bottom: 0.3rem; }
.cmcp-todo-item { display: flex; align-items: flex-start; gap: 0.4rem; padding: 0.12rem 0; line-height: 1.3; }
.cmcp-todo-item .pi { font-size: 0.7rem; margin-top: 0.1rem; flex: none; }
.cmcp-todo-item.done { opacity: 0.55; }
.cmcp-todo-item.done span { text-decoration: line-through; }
.cmcp-todo-item.done .pi { color: var(--p-green-400, #4ade80); }
.cmcp-todo-item.active { font-weight: 600; }
.cmcp-todo-item.active .pi { color: var(--p-primary-color, #60a5fa); }
/* Pending messages live in the tray (not the chat flow). The inline bubble + its
   status line stay hidden while queued/failed; on "read" the classes drop and the
   bubble materializes in place — right before the agent's reply. */
.cmcp-bubble.user.queued, .cmcp-bubble.user.failed { display: none; }
.cmcp-msg-status.queued, .cmcp-msg-status.failed { display: none; }
.cmcp-pending-item { display: flex; align-items: center; gap: 0.3rem; padding: 0.15rem 0; line-height: 1.3; }
.cmcp-pending-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmcp-pending-item.failed .cmcp-pending-text { color: var(--p-red-300, #fca5a5); }
.cmcp-pending-act { flex: none; width: 1.2rem; height: 1.2rem; padding: 0; border: none; background: transparent;
  color: var(--p-text-muted-color, #a1a1aa); cursor: pointer; border-radius: 4px; font-size: 0.7rem; }
.cmcp-pending-act:hover { color: var(--p-primary-color, #60a5fa); background: var(--p-surface-700, #3f3f46); }
.cmcp-pending-act.danger:hover { color: var(--p-red-300, #fca5a5); }
.cmcp-pending-handle { flex: none; width: 1rem; height: 1.2rem; display: flex; align-items: center; justify-content: center;
  color: var(--p-text-muted-color, #71717a); cursor: grab; font-size: 0.65rem; opacity: 0.6; }
.cmcp-pending-handle:hover { opacity: 1; color: var(--p-primary-color, #60a5fa); }
.cmcp-pending-handle:active { cursor: grabbing; }
.cmcp-pending-item.dragging { opacity: 0.4; }
.cmcp-pending-item.drop-target { box-shadow: inset 0 2px 0 0 var(--p-primary-color, #60a5fa); }
.cmcp-todo-item.pending .pi { opacity: 0.5; }
.cmcp-dl { margin-bottom: 0.4rem; }
.cmcp-dl-item { padding: 0.18rem 0; }
.cmcp-dl-top { display: flex; justify-content: space-between; gap: 0.5rem; align-items: baseline; }
.cmcp-dl-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmcp-dl-meta { flex: none; opacity: 0.7; font-size: 0.62rem; }
.cmcp-dl-bar { height: 4px; border-radius: 999px; background: var(--p-surface-700, #3f3f46); overflow: hidden; margin-top: 0.2rem; }
.cmcp-dl-fill { height: 100%; background: var(--p-primary-color, #3a7bd5); transition: width 0.3s ease; }
.cmcp-dl-item.done .cmcp-dl-fill { background: var(--p-green-400, #4ade80); }
.cmcp-dl-item.error .cmcp-dl-fill { background: var(--p-red-400, #f87171); }
.cmcp-dl-bar.indet .cmcp-dl-fill { width: 30%; animation: cmcp-indet 1.1s ease-in-out infinite; }
@keyframes cmcp-indet { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
.cmcp-sys {
  align-self: center; font-size: 0.6875rem; font-style: italic;
  color: var(--p-text-muted-color, #a1a1aa);
  animation: cmcp-in 0.18s ease-out;
}
.cmcp-card {
  align-self: flex-start; max-width: 92%; width: 100%; box-sizing: border-box;
  padding: 0.5rem 0.625rem;
  background: var(--p-surface-800, #27272a);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-left: 3px solid var(--p-primary-color, #60a5fa);
  border-radius: var(--p-border-radius-md, 6px);
  font-size: 0.75rem;
  animation: cmcp-in 0.18s ease-out;
}
.cmcp-card.error { border-left-color: var(--p-red-400, #f87171); }
.cmcp-card-head { display: flex; align-items: center; gap: 0.375rem; font-weight: 600; min-width: 0; }
.cmcp-card-head .pi { font-size: 0.75rem; color: var(--p-primary-color, #60a5fa); flex: none; }
.cmcp-card-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmcp-card.error .cmcp-card-head .pi { color: var(--p-red-400, #f87171); }
.cmcp-card-detail {
  margin-top: 0.25rem; color: var(--p-text-muted-color, #a1a1aa);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  max-height: 7.5rem; overflow-y: auto;
}

.cmcp-dropzone {
  position: absolute; inset: 0; z-index: 60;
  /* hidden by default — shown only while dragging a file over the composer.
     NB: use display:none (not the [hidden] attr) because an author display rule
     would otherwise override the UA [hidden]{display:none}. */
  display: none; align-items: center; justify-content: center;
  border: 2px dashed var(--p-primary-color, #3b82f6);
  border-radius: 10px;
  background: color-mix(in srgb, var(--p-primary-color, #3b82f6) 16%, var(--p-surface-900, #18181b));
  color: var(--p-primary-color, #60a5fa); font-weight: 600; font-size: 0.85rem;
  pointer-events: none; animation: cmcp-in 0.12s ease-out;
}
.cmcp-dropzone.cmcp-show { display: flex; }
.cmcp-dropzone span { display: inline-flex; align-items: center; gap: 0.4rem; }
.cmcp-thinking {
  align-self: flex-start; display: flex; align-items: center; gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--p-surface-800, #27272a);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-lg, 8px);
  color: var(--p-text-muted-color, #a1a1aa); font-size: 0.75rem;
  animation: cmcp-in 0.18s ease-out;
}
.cmcp-thinking-dots { display: inline-flex; gap: 3px; }
.cmcp-thinking-dots span {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--p-primary-color, #60a5fa);
  animation: cmcp-dotbounce 1.2s ease-in-out infinite;
}
.cmcp-thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
.cmcp-thinking-dots span:nth-child(3) { animation-delay: 0.3s; }
@keyframes cmcp-dotbounce {
  0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-3px); }
}

/* ---- live streaming: thinking accordion + reply preview ---- */
/* The "see thinking" disclosure above a streaming reply. Open + scrollable while
   the model reasons; collapses to a discreet one-line summary once text starts. */
.cmcp-think {
  margin: 0 0 0.5rem; border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-md, 6px);
  background: var(--p-surface-900, #18181b);
}
.cmcp-think > summary {
  list-style: none; cursor: pointer; user-select: none;
  padding: 0.3125rem 0.5rem; font-size: 0.6875rem; font-weight: 600;
  color: var(--p-text-muted-color, #a1a1aa);
  display: flex; align-items: center; gap: 0.375rem;
}
.cmcp-think > summary::-webkit-details-marker { display: none; }
.cmcp-think > summary::before {
  content: "\\25b8"; font-size: 0.625rem; transition: transform 0.15s;
}
.cmcp-think[open] > summary::before { transform: rotate(90deg); }
.cmcp-think-body {
  max-height: 11rem; overflow-y: auto;
  padding: 0 0.5rem 0.4375rem 0.875rem;
  font-size: 0.6875rem; line-height: 1.45;
  color: var(--p-text-muted-color, #8a8a93);
  white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}
/* While open & streaming, a soft pulse on the summary so it reads as "live". */
.cmcp-think[open] > summary { color: var(--p-primary-color, #60a5fa); }
/* Blinking caret on the reply preview while it streams in. */
.cmcp-reply.streaming-cursor::after {
  content: "\\258b"; margin-left: 1px; color: var(--p-primary-color, #60a5fa);
  animation: cmcp-caret 1s step-end infinite;
}
@keyframes cmcp-caret { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

.cmcp-composer {
  position: relative; margin: 0.625rem 0.75rem 0.75rem; flex: none;
  display: flex; flex-direction: column;
  background: var(--p-form-field-background, #09090b);
  border: 1px solid var(--p-form-field-border-color, #52525b);
  border-radius: var(--p-border-radius-xl, 12px);
  transition: border-color 0.15s;
}
.cmcp-composer:focus-within { border-color: var(--p-focus-ring-color, #60a5fa); }
.cmcp-composer-input {
  width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;
  background: transparent; color: var(--p-form-field-color, #fff);
  font: inherit; padding: 0.625rem 0.75rem 0.25rem;
  min-height: 2.25rem; max-height: 7.5rem;
}
.cmcp-composer-row { display: flex; align-items: center; gap: 0.25rem; padding: 0.25rem 0.5rem 0.5rem; }
.cmcp-spacer { flex: 1; }
.cmcp-iconbtn {
  width: 1.75rem; height: 1.75rem; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; cursor: pointer;
  border-radius: var(--p-border-radius-sm, 4px);
  color: var(--p-text-muted-color, #a1a1aa);
  transition: background 0.15s, color 0.15s;
}
.cmcp-iconbtn:hover { background: var(--p-surface-700, #3f3f46); color: var(--p-text-color, #fff); }
.cmcp-iconbtn:disabled { opacity: 0.35; cursor: default; }
.cmcp-iconbtn.active { color: var(--p-red-400, #f87171); }
.cmcp-iconbtn .pi { font-size: 0.875rem; }
.cmcp-chip {
  display: flex; align-items: center; gap: 0.25rem;
  border: none; background: transparent; cursor: pointer;
  color: var(--p-text-muted-color, #a1a1aa); font: inherit; font-size: 0.6875rem;
  padding: 0.125rem 0.375rem; border-radius: var(--p-border-radius-sm, 4px);
}
.cmcp-chip:hover { background: var(--p-surface-700, #3f3f46); }
/* Attachment chip strip (composer): viewable/expandable pasted text + files. */
.cmcp-attachbar { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.25rem 0.25rem 0; }
.cmcp-chipstrip { display: flex; flex-wrap: wrap; gap: 0.25rem; max-height: 4.75rem; overflow-y: auto; }
.cmcp-attach-chip {
  display: inline-flex; align-items: center; gap: 0.3125rem; max-width: 15rem;
  background: var(--p-surface-700, #3f3f46);
  border: 1px solid var(--p-content-border-color, #52525b);
  border-radius: var(--p-border-radius-md, 6px);
  color: var(--p-text-color, #fff); font: inherit; font-size: 0.6875rem;
  padding: 0.1875rem 0.25rem 0.1875rem 0.375rem; cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.cmcp-attach-chip:hover { background: var(--p-surface-600, #52525b); }
.cmcp-attach-chip.open { border-color: var(--p-primary-color, #60a5fa); }
.cmcp-attach-chip > .pi { font-size: 0.75rem; color: var(--p-text-muted-color, #a1a1aa); flex: none; }
.cmcp-attach-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmcp-attach-meta { color: var(--p-text-muted-color, #a1a1aa); flex: none; }
.cmcp-attach-thumb { width: 1.125rem; height: 1.125rem; border-radius: 3px; object-fit: cover; flex: none; }
.cmcp-attach-rm {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1rem; height: 1rem; flex: none; margin-left: 0.0625rem; padding: 0;
  border-radius: 3px; color: var(--p-text-muted-color, #a1a1aa);
}
.cmcp-attach-rm:hover { background: var(--p-surface-800, #27272a); color: var(--p-text-color, #fff); }
.cmcp-attach-rm .pi { font-size: 0.625rem; }
.cmcp-attach-preview {
  background: var(--p-surface-900, #18181b);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-md, 6px);
  max-height: 14rem; overflow: auto; padding: 0.5rem;
}
.cmcp-attach-preview pre {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.6875rem; line-height: 1.45; color: var(--p-text-color, #e4e4e7);
}
.cmcp-attach-preview img { max-width: 100%; max-height: 12rem; border-radius: 4px; display: block; }
.cmcp-ctx { font-size: 0.625rem; color: var(--p-text-muted-color, #a1a1aa); min-width: 1.75rem; }
.cmcp-ring { flex: none; margin: 0 0.125rem; transform: rotate(-90deg); }
.cmcp-ring .bg { stroke: var(--p-surface-600, #52525b); }
.cmcp-ring .fg { stroke: var(--p-primary-color, #60a5fa); transition: stroke-dashoffset 0.3s; }
.cmcp-popover {
  position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; z-index: 40;
  background: var(--p-surface-800, #27272a);
  border: 1px solid var(--p-content-border-color, #3f3f46);
  border-radius: var(--p-border-radius-lg, 8px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  max-height: 14rem; overflow-y: auto; padding: 0.25rem;
}
.cmcp-popover--down { bottom: auto; top: calc(100% + 4px); left: 0.5rem; right: 0.5rem; }
.cmcp-popover-item {
  display: flex; align-items: center; gap: 0.5rem; width: 100%; box-sizing: border-box;
  padding: 0.375rem 0.5rem; border: none; background: transparent; cursor: pointer;
  text-align: left; color: var(--p-text-color, #fff); font: inherit; font-size: 0.75rem;
  border-radius: var(--p-border-radius-sm, 4px);
}
.cmcp-popover-item.sel, .cmcp-popover-item:hover { background: var(--p-surface-700, #3f3f46); }
.cmcp-popover-item .pi { font-size: 0.75rem; color: var(--p-text-muted-color, #a1a1aa); flex: none; }
.cmcp-popover-item small { margin-left: auto; color: var(--p-text-muted-color, #a1a1aa); flex: none; padding-left: 0.5rem; }
.cmcp-popover-item .lbl { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Slash commands: keep the short /command always visible and let the (often
   long) hint truncate instead — otherwise a long hint collapsed the label. */
.cmcp-popover-item.cmcp-slash .lbl { flex: 0 0 auto; }
.cmcp-popover-item.cmcp-slash small { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmcp-status-btn {
  display: inline-flex; align-items: center; gap: 0.3125rem;
  background: none; border: none; cursor: pointer; font: inherit; color: inherit;
  padding: 0.125rem 0.375rem; border-radius: var(--p-border-radius-sm, 4px);
}
.cmcp-status-btn:hover { background: var(--p-surface-800, #27272a); }
.cmcp-status-btn .pi { color: var(--p-text-muted-color, #a1a1aa); }
.cmcp-conn-pop { padding: 0.625rem; max-height: none; }

/* History rows: open button + trash, revealed on hover. */
.cmcp-hist-row { display: flex; align-items: stretch; gap: 0.125rem; }
.cmcp-hist-row .cmcp-hist-open { flex: 1 1 auto; min-width: 0; }
.cmcp-hist-del {
  flex: none; width: 1.75rem; border: none; background: transparent; cursor: pointer;
  color: var(--p-text-muted-color, #a1a1aa); border-radius: var(--p-border-radius-sm, 4px);
  opacity: 0; transition: opacity 0.12s, background 0.12s, color 0.12s;
}
.cmcp-hist-row:hover .cmcp-hist-del { opacity: 1; }
.cmcp-hist-del:hover { background: var(--p-surface-700, #3f3f46); color: var(--p-red-400, #f87171); }
.cmcp-hist-del .pi { font-size: 0.75rem; }

/* Model/effort picker popover (anchored above the composer). */
.cmcp-pop-section { padding: 0.25rem 0.5rem 0.125rem; font-size: 0.625rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em; color: var(--p-text-muted-color, #a1a1aa); }
.cmcp-pop-section:not(:first-child) { margin-top: 0.25rem; border-top: 1px solid var(--p-content-border-color, #3f3f46); padding-top: 0.375rem; }
.cmcp-popover-item .check { flex: none; width: 1rem; text-align: center; margin-left: 0.375rem; color: var(--p-primary-color, #60a5fa); visibility: hidden; }
.cmcp-popover-item .check.on { visibility: visible; }
.cmcp-chip .pi-angle-down { font-size: 0.5625rem; opacity: 0.7; }
.cmcp-chip .dim { opacity: 0.65; }
`;

let styleInjected = false;
function ensureStyles() {
  if (styleInjected) return;
  const tag = document.createElement("style");
  tag.id = "comfyui-mcp-panel-styles";
  tag.textContent = PANEL_CSS;
  document.head.appendChild(tag);
  styleInjected = true;
}

/** Human-readable one-liner for an executed agent command. */
function describeCommand(cmd, msg, reply) {
  if (!reply.ok) return { icon: "pi-exclamation-triangle", text: `${cmd} failed`, detail: reply.error };
  const r = reply.result ?? {};
  switch (cmd) {
    case "graph_get_state":
      return { icon: "pi-eye", text: `Read graph — ${r.node_count} node${r.node_count === 1 ? "" : "s"}` };
    case "graph_add_node":
      return { icon: "pi-plus-circle", text: `Added ${r.added?.type ?? "node"} (id ${r.added?.id})` };
    case "graph_remove_node":
      return { icon: "pi-minus-circle", text: `Removed ${r.removed?.type ?? "node"} (id ${r.removed?.id})` };
    case "graph_clear":
      return {
        icon: "pi-eraser",
        text: `Cleared canvas — removed ${r.cleared} node${r.cleared === 1 ? "" : "s"} (one Ctrl+Z restores all)`,
      };
    case "graph_connect":
      return {
        icon: "pi-link",
        text: `Connected ${r.connected?.from?.node_id}.${r.connected?.from?.output} → ${r.connected?.to?.node_id}.${r.connected?.to?.input}`,
      };
    case "graph_disconnect":
      return { icon: "pi-times-circle", text: `Disconnected ${r.disconnected?.node_id}.${r.disconnected?.input}` };
    case "graph_set_widget":
      return {
        icon: "pi-sliders-h",
        text: `Set ${r.set?.widget} = ${JSON.stringify(r.set?.value)} on node ${r.set?.node_id}`,
        detail: `was ${JSON.stringify(r.set?.previous)}`,
      };
    case "graph_get_subgraph":
      return {
        icon: "pi-sitemap",
        text: `Read subgraph “${r.subgraph_of?.title}” — ${r.node_count} node${r.node_count === 1 ? "" : "s"}`,
      };
    case "graph_promote_widget":
      return r.demoted
        ? { icon: "pi-arrow-down", text: `Un-promoted “${r.demoted}” from the subgraph node` }
        : { icon: "pi-arrow-up", text: `Promoted “${r.promoted}” to the subgraph node` };
    case "graph_move_node":
      return { icon: "pi-arrows-alt", text: `Moved node ${r.moved?.node_id} to [${r.moved?.to?.map(Math.round)}]` };
    case "graph_create_group":
      return { icon: "pi-clone", text: `Created group “${r.group?.title}” (id ${r.group?.id})` };
    case "graph_move_group":
      return { icon: "pi-arrows-alt", text: `Moved group ${r.group?.id} (“${r.group?.title}”)` };
    case "graph_edit_group":
      return { icon: "pi-pencil", text: `Edited group ${r.group?.id} (“${r.group?.title}”)` };
    case "graph_remove_group":
      return { icon: "pi-minus-circle", text: `Removed group “${r.removed?.title}”` };
    case "graph_move_rail":
      return { icon: "pi-arrows-h", text: `Moved ${r.rail} rail to [${r.pos?.map(Math.round)}]` };
    case "graph_set_node_collapsed":
      return {
        icon: r.collapsed ? "pi-chevron-right" : "pi-chevron-down",
        text: `${r.collapsed ? "Collapsed" : "Expanded"} node ${r.node_id}`,
      };
    case "graph_set_node_color":
      return { icon: "pi-palette", text: `Recolored node ${r.node_id}` };
    case "graph_set_node_mode":
      return {
        icon: r.mode === "active" ? "pi-play-circle" : r.mode === "mute" ? "pi-volume-off" : "pi-ban",
        text: `Set node ${r.node_id} to ${r.mode}${r.previous_mode && r.previous_mode !== r.mode ? ` (was ${r.previous_mode})` : ""}`,
      };
    case "graph_screenshot":
      return { icon: "pi-camera", text: `Captured workflow image (${r.width}×${r.height})` };
    case "graph_canvas":
      return { icon: "pi-window-maximize", text: `Canvas: ${r.canvas?.action?.replace(/_/g, " ")}` };
    case "graph_run":
      return r.queued
        ? {
            icon: "pi-play",
            text:
              `Queued workflow${r.batch_count > 1 ? ` ×${r.batch_count}` : ""}` +
              (r.ran_to_node != null ? ` → node ${r.ran_to_node}` : ""),
          }
        : {
            icon: "pi-exclamation-triangle",
            // run-to-node rejection returns { error } (no node_errors); a normal
            // validation failure returns { node_errors }. Handle both — guard the
            // JSON.stringify so an undefined node_errors can't throw here.
            text: r.error ? "Run blocked" : "Run blocked by node errors",
            detail: r.error ?? (r.node_errors ? JSON.stringify(r.node_errors).slice(0, 300) : undefined),
          };
    case "graph_find_nodes":
      return {
        icon: "pi-search",
        text: `Found ${r.count}${r.truncated ? "+" : ""} of ${r.total} node${r.total === 1 ? "" : "s"}`,
      };
    case "graph_get_errors":
      return {
        icon: "pi-info-circle",
        text: r.node_errors || r.last_execution_error ? "Read execution errors" : "Checked errors — none",
      };
    case "free_vram":
      return { icon: "pi-bolt", text: "Unloaded models — freed VRAM" };
    case "workflow_save":
      return { icon: "pi-save", text: `Saved “${r.workflow}”` };
    case "workflow_save_as":
      return { icon: "pi-save", text: `Saved as “${r.workflow}”` };
    default:
      return { icon: "pi-bolt", text: cmd, detail: JSON.stringify(r).slice(0, 300) };
  }
}

// GitHub-flavored markdown, single-newline line breaks.
marked.setOptions({ gfm: true, breaks: true });

// CRITICAL: force every rendered link to open OUT of the panel frame. In the
// ComfyUI desktop (Electron) app a plain in-frame navigation hijacks the WHOLE
// window — no back button, hard-reload to escape. Tagging anchors target=_blank
// + rel makes them open in a new context (the desktop routes that to the default
// browser); a delegated click handler (wireExternalLinks) is the belt-and-braces
// that intercepts the click and opens externally even if _blank is ignored.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

/** Open a URL outside the panel frame — never navigate the app/webview itself.
 *  Prefers a desktop external-open bridge if present, else a new browser tab. */
function openExternalUrl(href) {
  if (!href) return;
  try {
    const ext =
      window.electronAPI?.openExternal ||
      window.comfyAPI?.electron?.openExternal ||
      window.api?.openExternal;
    if (typeof ext === "function") {
      ext(href);
      return;
    }
  } catch {
    // fall through to window.open
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

/** Delegate link clicks on a container so http(s)/mailto links open externally
 *  instead of navigating the panel frame (which hijacks the desktop app). */
function wireExternalLinks(container) {
  container.addEventListener("click", (ev) => {
    const a = ev.target?.closest?.("a[href]");
    if (!a || !container.contains(a)) return;
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("#")) return; // in-document anchors: leave alone
    ev.preventDefault();
    ev.stopPropagation();
    openExternalUrl(a.href || href); // a.href resolves relative URLs
  });
}

// ---- code-block hover tools (copy + global line-wrap toggle) ---------------
// Line-wrap is a SINGLE global preference (persisted), so toggling one block
// flips them all — matching how editors expose word-wrap as one setting.
const CODE_WRAP_KEY = "comfyui-mcp.panel.codeWrap";
function codeWrapOn() {
  return lsGet(CODE_WRAP_KEY) === "1";
}
function setCodeWrap(on) {
  lsSet(CODE_WRAP_KEY, on ? "1" : null);
  // Apply to every rendered block already on screen + sync the toggle buttons.
  for (const pre of document.querySelectorAll("pre.cmcp-codeblock")) {
    pre.classList.toggle("cmcp-wrap", on);
    const wb = pre.querySelector(".cmcp-wrap-btn");
    if (wb) wb.classList.toggle("on", on);
  }
}

/** Flash a tool button green for ~1s as copy confirmation (icon → check). */
function flashCopied(btn) {
  const i = btn.querySelector("i");
  const prev = i ? i.className : null;
  if (i) i.className = "pi pi-check";
  btn.classList.add("ok");
  setTimeout(() => {
    if (i && prev) i.className = prev;
    btn.classList.remove("ok");
  }, 1100);
}

function copyCodeText(text, btn) {
  navigator.clipboard?.writeText(text).then(() => flashCopied(btn), () => {});
}

function codeToolBtn(iconClass, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.title = title;
  const i = document.createElement("i");
  i.className = "pi " + iconClass;
  b.appendChild(i);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Add hover Copy (+ Wrap-toggle on fenced blocks) UI to rendered code in `el`.
 *  Idempotent per element; safe to call after every renderRichText. */
function decorateCode(el) {
  // Fenced blocks (```): Copy + global Wrap toggle.
  for (const pre of el.querySelectorAll("pre")) {
    if (pre.dataset.cmcpTools) continue;
    pre.dataset.cmcpTools = "1";
    pre.classList.add("cmcp-codeblock");
    if (codeWrapOn()) pre.classList.add("cmcp-wrap");
    const tools = document.createElement("div");
    tools.className = "cmcp-code-tools";
    const copyBtn = codeToolBtn("pi-copy", "Copy", () => {
      const code = pre.querySelector("code");
      copyCodeText(code ? code.textContent : pre.textContent, copyBtn);
    });
    copyBtn.className = "cmcp-code-tool";
    const wrapBtn = codeToolBtn("pi-bars", "Toggle line wrap (all blocks)", () => setCodeWrap(!codeWrapOn()));
    wrapBtn.className = "cmcp-code-tool cmcp-wrap-btn" + (codeWrapOn() ? " on" : "");
    tools.append(copyBtn, wrapBtn);
    pre.appendChild(tools);
  }
  // Inline code (`x`): Copy only (a wrap toggle is meaningless for inline).
  for (const code of el.querySelectorAll("code")) {
    if (code.closest("pre") || code.dataset.cmcpCopy) continue;
    code.dataset.cmcpCopy = "1";
    code.classList.add("cmcp-inline-code");
    const text = code.textContent; // capture before appending the button
    const copyBtn = codeToolBtn("pi-copy", "Copy", () => copyCodeText(text, copyBtn));
    copyBtn.className = "cmcp-inline-copy";
    code.appendChild(copyBtn);
  }
}

/** Render agent markdown (full GFM) via marked, sanitized with DOMPurify so
 *  agent output can never inject script/handlers into the panel. Links are
 *  forced external via the DOMPurify hook above + wireExternalLinks on the feed. */
function renderRichText(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(String(text)));
  decorateCode(el);
}

// SINGLETON GUARD: at most ONE bridge client may be live per page. ComfyUI can
// call the sidebar tab's render() more than once (sidebar restore on a fresh
// restart, layout re-mounts, open/close churn). Each render() builds a panel +
// a bridge client that connects with THIS tab's tab_id. If a prior client is
// left alive, two clients share the same tab_id and the bridge's
// close-old-on-new-hello (ui-bridge) makes them ping-pong reconnect forever —
// that's the ~1s "reconnect storm" (proven: alternating sockets, same tab_id,
// clean 1005 closes). Tracking the live client at module scope and tearing down
// any prior one before creating a new one makes the storm structurally impossible.
let liveBridgeClient = null;

function buildPanel() {
  ensureStyles();

  const root = document.createElement("div");
  root.className = "cmcp-root";
  // Expose this panel's root so canvas "fit" can measure how much of the canvas
  // the open panel occludes and frame the graph in the visible area.
  activePanelRoot = root;
  // Any link clicked anywhere in the panel opens externally — never let it
  // navigate (and hijack) the ComfyUI desktop webview.
  wireExternalLinks(root);

  // ---- Header: logo + title + status dot ----
  const header = document.createElement("div");
  header.className = "cmcp-header";
  // comfyui-mcp brand mark. Served from this pack's WEB_DIRECTORY (web/img/…), so
  // it must be referenced by a SERVED url — resolve it relative to this module so
  // it works regardless of where the extension is mounted.
  const logo = document.createElement("img");
  logo.className = "cmcp-logo";
  logo.alt = "";
  logo.setAttribute("aria-hidden", "true");
  const LOGO_SERVED_PATH = "/extensions/comfyui-mcp-panel/img/comfyui-mcp-logo.png";
  // A 404 on the module-resolved URL must also recover — not just a URL()
  // construction failure. Fall back to the served path once (a flag prevents an
  // error loop if the served path itself 404s) (P2 c).
  logo.addEventListener("error", () => {
    if (logo.dataset.fellBack === "1") return;
    logo.dataset.fellBack = "1";
    logo.src = LOGO_SERVED_PATH;
  });
  try {
    logo.src = new URL("../img/comfyui-mcp-logo.png", import.meta.url).href;
  } catch {
    logo.dataset.fellBack = "1";
    logo.src = LOGO_SERVED_PATH;
  }
  const title = document.createElement("span");
  title.className = "cmcp-title";
  title.textContent = "Agent";
  const status = document.createElement("button");
  status.type = "button";
  status.className = "cmcp-status cmcp-status-btn";
  status.title = "Connection";
  const dot = document.createElement("span");
  dot.className = "cmcp-dot";
  const statusText = document.createElement("span");
  statusText.textContent = "disconnected";
  const caret = document.createElement("i");
  caret.className = "pi pi-angle-down";
  caret.style.fontSize = "0.625rem";
  status.append(dot, statusText, caret);

  function iconBtn(icon, titleText) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cmcp-iconbtn";
    b.title = titleText;
    const i = document.createElement("i");
    i.className = `pi ${icon}`;
    b.appendChild(i);
    return b;
  }

  const actions = document.createElement("span");
  actions.style.cssText = "margin-left:auto;display:flex;gap:0.125rem;align-items:center;";
  const newChatBtn = iconBtn("pi-plus", "New chat");
  const historyBtn = iconBtn("pi-history", "Chat history");
  // Reload / restart live as slash commands (/reload, /reload-ui, /restart) — no
  // header buttons for them.
  actions.append(newChatBtn, historyBtn);

  header.style.position = "relative";
  const histPop = document.createElement("div");
  histPop.className = "cmcp-popover cmcp-popover--down";
  histPop.hidden = true;
  header.append(logo, title, actions, status, histPop);
  root.appendChild(header);

  // Panel preferences (model/effort/storyboard toggle/…), localStorage-backed.
  // Declared up here so the settings UI below can read/write it (e.g. the
  // video-storyboard toggle). Model-related migration happens at first use.
  const prefs = loadPrefs();
  if (prefs.model === "default") prefs.model = undefined; // migrate old saved value

  // ---- Connection settings ----
  const settingsBox = document.createElement("div");
  settingsBox.className = "cmcp-popover cmcp-popover--down cmcp-conn-pop";
  settingsBox.hidden = true;
  const settingsBody = document.createElement("div");
  settingsBody.className = "cmcp-settings-body";

  // ---- backend picker ----
  // "Pick a backend, not a port": chips for each discovered backend (Claude /
  // ChatGPT). Clicking one asks the pack to ensure that backend's orchestrator is
  // running and returns the bridge URL to connect to — the user never types a
  // port. Populated from GET /comfyui_mcp_panel/backends when settings open.
  const BACKEND_LABELS = { claude: "Claude", codex: "ChatGPT", gemini: "Gemini" };
  const backendLabel = document.createElement("label");
  backendLabel.className = "cmcp-label";
  backendLabel.textContent = "Agent backend";
  const backendChips = document.createElement("div");
  backendChips.className = "cmcp-backend-chips";
  backendChips.style.cssText =
    "display:flex;gap:0.375rem;flex-wrap:wrap;margin-bottom:0.5rem;";
  // The backend the user last picked (so the active chip is highlighted across
  // reopens). Defaults to claude for back-compat.
  let selectedBackend = (() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY_BACKEND) || "claude";
    } catch {
      return "claude";
    }
  })();
  // The backend we're actually CONNECTED to (set from the handshake). Used to
  // detect a real provider switch (vs. re-picking the current one).
  let connectedBackend = null;
  // The discovered providers (from GET /backends), kept so the model popup's
  // PROVIDER section can render them (the switcher now lives there, not in
  // settings). Defaults to claude-only until discovery lands.
  let knownBackends = [{ backend: "claude", running: false }];
  // Durable per-provider readiness (cli/auth/ready), keyed by backend id. Owned by
  // applyReadiness from GET /backends. Kept SEPARATE from knownBackends because
  // renderBackendChips is also called from connect/handshake paths that reconstruct
  // entries as {backend, running} (no readiness) — reading the map instead means a
  // connect never erases "is this provider signed in", so the set-up affordance and
  // not-ready hints survive a reconnect.
  const backendReady = {};
  // Short per-provider hint shown under each provider row in the popup.
  const BACKEND_HINTS = { claude: "Opus · Sonnet · Haiku", codex: "GPT-5 (Codex)", gemini: "Gemini 2.5 Pro · Flash" };

  // Hint for a provider that exists but isn't usable yet — distinguishes
  // "install the CLI" from "sign in". Empty when ready or readiness is unknown.
  function notReadyHint(b) {
    if (!b) return "";
    const r = backendReady[b.backend] || b; // durable readiness survives chip repaints
    if (r.ready !== false) return "";
    if (r.cli === false) return `${BACKEND_LABELS[b.backend] || b.backend} CLI not installed`;
    if (b.backend === "codex") return "Not signed in — run: codex login";
    if (b.backend === "gemini") return "Not signed in — run: gemini (then sign in with Google)";
    return "Not signed in — run: claude auth login";
  }

  function renderBackendChips(backends) {
    backendChips.replaceChildren();
    const list =
      Array.isArray(backends) && backends.length
        ? backends
        : [{ backend: "claude", running: false }];
    knownBackends = list;
    for (const b of list) {
      const id = b.backend;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "cmcp-btn cmcp-backend-chip";
      chip.dataset.backend = id;
      chip.textContent = BACKEND_LABELS[id] || id;
      const hint = notReadyHint(b);
      if (hint) {
        chip.title = hint;
        chip.style.opacity = "0.55"; // dim a provider that isn't signed in yet
      } else if (b.running) {
        chip.title = "Running";
      }
      if (id === selectedBackend) {
        chip.style.cssText =
          "background:var(--p-primary-color,#2563eb);color:var(--p-primary-contrast-color,#fff);border-color:transparent;";
      }
      chip.addEventListener("click", () => connectBackend(id));
      backendChips.appendChild(chip);
    }
  }
  // Initial paint with the default before discovery lands.
  renderBackendChips(null);

  async function loadBackends() {
    try {
      const res = await api.fetchApi("/comfyui_mcp_panel/backends");
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data?.backends)) {
        renderBackendChips(data.backends);
        applyReadiness(data);
      }
    } catch {
      // No /backends route (older host) — keep the default single chip.
    }
  }

  const urlLabel = document.createElement("label");
  urlLabel.className = "cmcp-label";
  urlLabel.textContent = "Bridge URL";
  const urlInput = document.createElement("input");
  urlInput.className = "cmcp-input";
  urlInput.type = "text";
  urlInput.value = loadBridgeUrl();
  urlInput.placeholder = DEFAULT_BRIDGE_URL;

  // Primary action: starts the background agent on demand (via ComfyUI's own
  // server) and connects. Nothing is ever spawned without this click.
  const connectBtn = document.createElement("button");
  connectBtn.className = "cmcp-btn";
  connectBtn.type = "button";
  connectBtn.textContent = "Connect";
  connectBtn.style.cssText =
    "background:var(--p-primary-color,#2563eb);color:var(--p-primary-contrast-color,#fff);border-color:transparent;";

  const disconnectBtn = document.createElement("button");
  disconnectBtn.className = "cmcp-btn";
  disconnectBtn.type = "button";
  disconnectBtn.textContent = "Disconnect";
  disconnectBtn.hidden = true;

  const saveBtn = document.createElement("button");
  saveBtn.className = "cmcp-btn";
  saveBtn.type = "button";
  saveBtn.textContent = "Reconnect";
  saveBtn.title = "Re-open the bridge connection at the URL above";
  saveBtn.style.opacity = "0.8";

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:0.375rem;align-items:center;flex-wrap:wrap;";
  btnRow.append(connectBtn, disconnectBtn, saveBtn);

  const helpDiv = document.createElement("div");
  helpDiv.className = "cmcp-help";
  helpDiv.textContent =
    "Click Connect to start an autonomous agent on your Claude subscription — no API keys. Sign in to Claude once (run `claude`) first. Prefer to run it yourself? Start the orchestrator, then Connect:";
  const helpCmd = document.createElement("code");
  helpCmd.className = "cmcp-cmd";
  helpCmd.textContent = "npx -y comfyui-mcp --panel-orchestrator";
  helpCmd.title = "Click to copy";
  helpCmd.addEventListener("click", () => {
    navigator.clipboard?.writeText(helpCmd.textContent).then(
      () => appendSystem("Command copied."),
      () => {},
    );
  });
  helpDiv.appendChild(helpCmd);

  // Bridge URL is now an ADVANCED/fallback control — the backend chips set the URL
  // for you. Keep it (collapsed) for manual/user-managed orchestrators.
  const advWrap = document.createElement("div");
  advWrap.className = "cmcp-advanced";

  // Toggle: auto-generate a frame storyboard (contact sheet) from each VIDEO
  // output and deliver it to the agent as an inline image (so it can "see" the
  // video it made). Default ON; persisted in prefs.
  const sbWrap = document.createElement("label");
  sbWrap.style.cssText = "display:flex;align-items:center;gap:0.4rem;cursor:pointer;font-size:0.85em;";
  const sbToggle = document.createElement("input");
  sbToggle.type = "checkbox";
  sbToggle.checked = prefs.videoStoryboard !== false; // default on
  sbToggle.addEventListener("change", () => {
    prefs.videoStoryboard = sbToggle.checked;
    savePrefs(prefs);
  });
  const sbText = document.createElement("span");
  sbText.textContent = "Show the agent a storyboard of generated videos";
  sbWrap.append(sbToggle, sbText);

  advWrap.append(urlLabel, urlInput, sbWrap);
  advWrap.hidden = true;
  const advToggle = document.createElement("button");
  advToggle.type = "button";
  advToggle.className = "cmcp-link";
  advToggle.textContent = "Advanced ▸";
  advToggle.style.cssText =
    "background:none;border:none;padding:0;cursor:pointer;color:var(--p-text-muted-color,#888);font-size:0.8em;text-align:left;";
  advToggle.addEventListener("click", () => {
    advWrap.hidden = !advWrap.hidden;
    advToggle.textContent = advWrap.hidden ? "Advanced ▸" : "Advanced ▾";
  });

  // NOTE: the provider switcher (backendLabel + backendChips) moved INTO the model
  // popup's PROVIDER section — see buildModelPop. The elements stay defined (so
  // renderBackendChips/loadBackends keep working as the data source) but are no
  // longer shown in settings.
  settingsBody.append(btnRow, advToggle, advWrap, helpDiv);
  settingsBox.appendChild(settingsBody);
  // Lives in the header as a dropdown anchored under the status pill.
  header.appendChild(settingsBox);
  status.addEventListener("click", (e) => {
    e.stopPropagation();
    histPop.hidden = true;
    settingsBox.hidden = !settingsBox.hidden;
    // Refresh the backend chips (running status) each time settings open.
    if (!settingsBox.hidden) void loadBackends();
  });

  // ---- Message log + empty state ----
  const log = document.createElement("div");
  log.className = "cmcp-log";
  const empty = document.createElement("div");
  empty.className = "cmcp-empty";
  const emptyIcon = document.createElement("i");
  emptyIcon.className = "pi pi-comments";
  const emptyTitle = document.createElement("div");
  emptyTitle.className = "cmcp-empty-title";
  emptyTitle.textContent = "Claude is at your canvas";
  const emptyBody = document.createElement("div");
  emptyBody.textContent =
    "Build and edit the live graph, generate images & audio, run the workflow and read its errors, or find models on Civitai — every graph edit undoes with Ctrl+Z.";
  empty.append(emptyIcon, emptyTitle, emptyBody);

  // Example prompts surface the agent's newer capabilities and prefill the
  // composer on click. `input` is assigned later in this closure; the click
  // handlers run long after, so referencing it is safe.
  const EXAMPLES = [
    { icon: "pi-volume-up", text: "Generate a 30s lofi piano track" },
    { icon: "pi-sliders-h", text: "Build a Flux txt2img graph and run it" },
    { icon: "pi-exclamation-triangle", text: "Run the workflow and tell me if it errors" },
    { icon: "pi-search", text: "Find a good Flux LoRA on Civitai and add it" },
  ];
  const examplesBox = document.createElement("div");
  examplesBox.className = "cmcp-examples";
  for (const ex of EXAMPLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cmcp-example";
    const i = document.createElement("i");
    i.className = `pi ${ex.icon}`;
    const t = document.createElement("span");
    t.textContent = ex.text;
    chip.append(i, t);
    chip.addEventListener("click", () => {
      input.value = ex.text;
      input.focus();
      input.dispatchEvent(new Event("input"));
    });
    examplesBox.appendChild(chip);
  }
  empty.appendChild(examplesBox);
  log.appendChild(empty);

  // ---- provider onboarding ----
  // `npx -y comfyui-mcp` bundles BOTH provider SDKs as optional deps, so package
  // presence is meaningless — the real gate is a login. This card walks a fresh
  // user through installing + signing into a provider, and is shown ONLY when
  // NEITHER provider is ready (CLI on PATH + a login on disk). The moment one is
  // ready it hides and the panel auto-picks that provider (see applyReadiness).
  const PROVIDER_SETUP = {
    claude: { label: "Claude", install: "npm i -g @anthropic-ai/claude-code", login: "claude auth login" },
    codex: { label: "ChatGPT", install: "npm i -g @openai/codex", login: "codex login" },
    gemini: { label: "Gemini", install: "npm i -g @google/gemini-cli", login: "gemini" },
  };
  let anyReady = false;
  let autoPickDone = false; // auto-switch + note fires at most once per panel mount
  const onboard = document.createElement("div");
  onboard.className = "cmcp-onboard";
  onboard.hidden = true;

  function onboardCmd(cmd) {
    const code = document.createElement("code");
    code.className = "cmcp-cmd";
    code.textContent = cmd;
    code.title = "Click to copy";
    code.addEventListener("click", () => {
      navigator.clipboard?.writeText(cmd).then(() => appendSystem("Command copied."), () => {});
    });
    return code;
  }

  function renderOnboard(list) {
    onboard.replaceChildren();
    const title = document.createElement("div");
    title.className = "cmcp-onboard-title";
    title.textContent = "Sign in to an AI provider to use the agent";
    const sub = document.createElement("div");
    sub.className = "cmcp-onboard-sub";
    sub.textContent =
      "The agent runs on your own Claude, ChatGPT, or Gemini subscription — no API keys. Set up at least one (Node ≥ 22 required), then click Connect.";
    onboard.append(title, sub);
    for (const id of ["claude", "codex", "gemini"]) {
      const meta = PROVIDER_SETUP[id];
      const st = list.find((b) => b.backend === id) || {};
      const col = document.createElement("div");
      col.className = "cmcp-onboard-col";
      const prov = document.createElement("div");
      prov.className = "cmcp-onboard-prov";
      prov.textContent = meta.label;
      col.appendChild(prov);
      // Only show the install step when the CLI isn't already on PATH (otherwise
      // the user just needs to sign in).
      if (!st.cli) {
        const s1 = document.createElement("div");
        s1.className = "cmcp-onboard-step";
        s1.textContent = "1. Install the CLI";
        col.append(s1, onboardCmd(meta.install));
      }
      const s2 = document.createElement("div");
      s2.className = "cmcp-onboard-step";
      s2.textContent = st.cli ? "Sign in" : "2. Sign in";
      col.append(s2, onboardCmd(meta.login));
      onboard.appendChild(col);
    }
  }

  // Apply per-provider readiness from GET /backends: toggle the onboarding card,
  // and — when a saved pick isn't usable but another provider IS — auto-switch the
  // active backend (in-memory only; the saved pref is left untouched so it returns
  // once that provider is set up) and leave a one-line system note.
  function applyReadiness(data) {
    const list = Array.isArray(data?.backends) ? data.backends : [];
    // Only act when the backend actually reports readiness. Derive any_ready from
    // the per-backend `ready` flags if the top-level field is absent (older Python
    // / mid-deploy), and treat a backend with NO readiness data at all as "ready"
    // so the onboarding card never shows spuriously against an old host.
    const hasReadiness = list.some((b) => typeof b.ready === "boolean");
    // Persist readiness durably so it survives later renderBackendChips repaints
    // that only carry {backend, running}.
    for (const b of list) {
      if (typeof b.ready === "boolean") backendReady[b.backend] = { cli: b.cli, auth: b.auth, ready: b.ready };
    }
    if (!hasReadiness) {
      anyReady = true;
      onboard.hidden = true;
      return;
    }
    anyReady = typeof data?.any_ready === "boolean" ? data.any_ready : list.some((b) => b.ready);
    if (list.length && !anyReady) {
      renderOnboard(list);
      onboard.hidden = false;
    } else {
      onboard.hidden = true;
    }
    if (!anyReady || autoPickDone) return;
    const sel = list.find((b) => b.backend === selectedBackend);
    if (sel && sel.ready === false) {
      const ready = list.find((b) => b.ready);
      if (ready) {
        autoPickDone = true;
        const prevLabel = BACKEND_LABELS[selectedBackend] || selectedBackend;
        selectedBackend = ready.backend; // active pick only; STORAGE_KEY_BACKEND untouched
        renderBackendChips(list);
        setAskPlaceholder(ready.backend);
        appendSystem(
          `${prevLabel} isn't signed in — using ${BACKEND_LABELS[ready.backend] || ready.backend}. ` +
            `Sign in to ${prevLabel} to switch back.`,
        );
      }
    } else {
      // Saved pick is ready (or readiness unknown) — nothing to switch.
      autoPickDone = true;
    }
  }

  // "Set up the other provider" — when one provider is signed in and the other
  // isn't, the working agent helps with the install/sign-in. Per design this is
  // JUST A PROMPT to the agent (no command-runner baked into the panel allowlist):
  // we send it the request if connected, else drop it in the composer to send once
  // the user connects to the provider that IS ready.
  function requestProviderSetup(id) {
    const meta = PROVIDER_SETUP[id];
    if (!meta) return;
    modelPop.hidden = true;
    const prompt =
      `Help me set up the ${meta.label} backend so I can use it in this panel — I'm not signed in to it yet. ` +
      `Walk me through it for my OS: install the CLI (\`${meta.install}\`), sign in (\`${meta.login}\`), ` +
      `then in this panel pick ${meta.label} in the provider picker and click Connect. Give exact terminal commands.`;
    if (client.isConnected() && client.sendUserMessage(prompt)) {
      appendSystem(`Asked the agent to help you set up ${meta.label}.`);
    } else {
      input.value = prompt;
      input.focus();
      input.dispatchEvent(new Event("input"));
      appendSystem(`Connect to a signed-in provider, then send this queued request to set up ${meta.label}.`);
    }
  }

  const body = document.createElement("div");
  body.className = "cmcp-body";
  body.style.position = "relative"; // anchor the "new messages" pill
  body.appendChild(onboard);
  body.appendChild(log);

  // Discord-style sticky autoscroll: follow new content only while the user is
  // already at the bottom. If they've scrolled up to read, leave them there and
  // surface a "New messages" pill that smooth-scrolls back down.
  let stickToBottom = true;
  const BOTTOM_SLACK_PX = 48;
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_SLACK_PX;
  const newMsgBtn = document.createElement("button");
  newMsgBtn.type = "button";
  newMsgBtn.className = "cmcp-newmsg";
  newMsgBtn.hidden = true;
  newMsgBtn.innerHTML = '<i class="pi pi-arrow-down"></i> New messages';
  newMsgBtn.addEventListener("click", () => {
    stickToBottom = true;
    newMsgBtn.hidden = true;
    log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  });
  // Track the user's scroll position; re-stick (and hide the pill) at the bottom.
  log.addEventListener("scroll", () => {
    stickToBottom = atBottom();
    if (stickToBottom) newMsgBtn.hidden = true;
  });
  body.appendChild(newMsgBtn);
  root.appendChild(body);

  // Footer status tray — docked above the composer. Hosts the agent's live TODO
  // checklist (download progress rows slot in here later). Hidden until non-empty.
  let todoItems = [];
  let downloadItems = [];
  const tray = document.createElement("div");
  tray.className = "cmcp-tray";
  tray.hidden = true;
  root.appendChild(tray);

  function fmtBytes(n) {
    if (!n || n < 1024) return `${n || 0} B`;
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1;
    let v = n;
    do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
    return `${v.toFixed(1)} ${u[i]}`;
  }

  function mkPendingAct(icon, title, onClick, danger) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cmcp-pending-act" + (danger ? " danger" : "");
    b.title = title;
    b.innerHTML = `<i class="pi ${icon}"></i>`;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderTray() {
    tray.replaceChildren();
    // Only messages actually waiting (queued behind a turn) or failed belong in
    // the tray — not idle sends that process immediately.
    const pendingList = [...pendingMsgs].filter(
      ([, e]) => e.state === "queued" || e.state === "failed",
    );
    const hasPending = pendingList.length > 0;
    const hasDl = downloadItems.length > 0;
    const hasTodo = todoItems.length > 0;
    tray.hidden = !hasPending && !hasDl && !hasTodo;
    if (tray.hidden) return;

    // Pending messages (queued/failed) live here, not in the chat flow. Each has
    // edit / send-now / delete. On dequeue they materialize as a chat bubble.
    if (hasPending) {
      const pend = document.createElement("div");
      const head = document.createElement("div");
      head.className = "cmcp-tray-head";
      head.textContent = `Pending · ${pendingList.length}`;
      pend.appendChild(head);
      for (const [mid, entry] of pendingList) {
        const row = document.createElement("div");
        row.className = "cmcp-pending-item" + (entry.state === "failed" ? " failed" : "");
        // Drag handle (LEFT) — reorder how the agent flushes the queue.
        const handle = document.createElement("span");
        handle.className = "cmcp-pending-handle";
        handle.draggable = true;
        handle.title = "Drag to reorder";
        handle.innerHTML = '<i class="pi pi-bars"></i>';
        handle.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/plain", mid);
          e.dataTransfer.effectAllowed = "move";
          row.classList.add("dragging");
        });
        handle.addEventListener("dragend", () => row.classList.remove("dragging"));
        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          row.classList.add("drop-target");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          row.classList.remove("drop-target");
          const dragMid = e.dataTransfer.getData("text/plain");
          if (dragMid) reorderPending(dragMid, mid);
        });
        const txt = document.createElement("span");
        txt.className = "cmcp-pending-text";
        txt.textContent = entry.raw || "";
        txt.title = entry.raw || "";
        row.append(
          handle,
          txt,
          mkPendingAct("pi-pencil", "Edit — pull back to the composer", () => editMsg(mid)),
          mkPendingAct(
            "pi-send",
            entry.state === "failed" ? "Resend now" : "Send now (interrupt the current turn)",
            () => sendNowMsg(mid),
          ),
          mkPendingAct("pi-times", "Delete this message", () => deleteMsg(mid), true),
        );
        pend.appendChild(row);
      }
      tray.appendChild(pend);
    }

    if (hasDl) {
      const dl = document.createElement("div");
      dl.className = "cmcp-dl";
      const head = document.createElement("div");
      head.className = "cmcp-tray-head";
      head.textContent = "Downloads";
      dl.appendChild(head);
      for (const d of downloadItems) {
        const total = d && Number(d.total) > 0 ? Number(d.total) : 0;
        const got = d && Number(d.downloaded) > 0 ? Number(d.downloaded) : 0;
        const pct = total ? Math.min(100, Math.round((100 * got) / total)) : null;
        const failed = d && (d.status === "error" || d.status === "failed");
        const done = d && d.status === "done";
        const row = document.createElement("div");
        row.className = "cmcp-dl-item" + (failed ? " error" : done ? " done" : "");
        const top = document.createElement("div");
        top.className = "cmcp-dl-top";
        const name = document.createElement("span");
        name.className = "cmcp-dl-name";
        name.textContent = (d && d.name) || "download";
        name.title = name.textContent;
        const meta = document.createElement("span");
        meta.className = "cmcp-dl-meta";
        const speed = d && Number(d.bytes_per_sec) > 0 ? `${fmtBytes(Number(d.bytes_per_sec))}/s` : "";
        meta.textContent = failed
          ? "failed"
          : done
            ? "done"
            : [pct != null ? `${pct}%` : "…", speed].filter(Boolean).join(" · ");
        top.append(name, meta);
        row.appendChild(top);
        const barWrap = document.createElement("div");
        barWrap.className = "cmcp-dl-bar" + (pct == null && !done && !failed ? " indet" : "");
        const fill = document.createElement("div");
        fill.className = "cmcp-dl-fill";
        fill.style.width = `${done ? 100 : (pct ?? (failed ? 100 : 30))}%`;
        barWrap.appendChild(fill);
        row.appendChild(barWrap);
        dl.appendChild(row);
      }
      tray.appendChild(dl);
    }

    if (hasTodo) {
      const list = document.createElement("div");
      list.className = "cmcp-todo";
      const doneN = todoItems.filter((it) => it && it.status === "done").length;
      const head = document.createElement("div");
      head.className = "cmcp-tray-head";
      head.textContent = `Plan · ${doneN}/${todoItems.length}`;
      list.appendChild(head);
      for (const it of todoItems) {
        const status = it && it.status === "active" ? "active" : it && it.status === "done" ? "done" : "pending";
        const row = document.createElement("div");
        row.className = "cmcp-todo-item " + status;
        const icon = document.createElement("i");
        icon.className =
          "pi " + (status === "done" ? "pi-check-circle" : status === "active" ? "pi-spin pi-spinner" : "pi-circle");
        const txt = document.createElement("span");
        txt.textContent = (it && it.text) || "";
        row.append(icon, txt);
        list.appendChild(row);
      }
      tray.appendChild(list);
    }
    scrollLog();
  }
  function renderTodo(items) {
    todoItems = Array.isArray(items) ? items : [];
    renderTray();
    // Persist the plan ON the active thread so it survives a reload / panel
    // remount (the tray is otherwise rebuilt empty) and follows thread switches.
    if (thread) {
      thread.todos = todoItems;
      persistThreads();
    }
  }
  function renderDownloads(downloads) {
    downloadItems = (Array.isArray(downloads) ? downloads : []).filter(Boolean);
    renderTray();
  }

  function clearEmpty() {
    if (empty.parentElement) empty.remove();
  }

  // ---- Composer ----
  const form = document.createElement("form");
  form.className = "cmcp-composer";

  const menuPop = document.createElement("div");
  menuPop.className = "cmcp-popover";
  menuPop.hidden = true;

  const input = document.createElement("textarea");
  input.className = "cmcp-composer-input";
  // Placeholder reflects the active backend ("Ask Claude…" / "Ask ChatGPT…").
  function setAskPlaceholder(id) {
    input.placeholder = `Ask ${BACKEND_LABELS[id] || "Claude"}… / for commands, @ for context`;
  }
  setAskPlaceholder(selectedBackend);
  input.rows = 1;

  // ---- Attachment chip strip (visual manager for attachments[]) -------------
  // A Claude-Code-style row of chips ABOVE the input. Each chip mirrors one entry
  // in attachments[]; clicking expands an inline read-only preview; the × removes
  // the attachment AND its inline token from the textarea. Purely additive — the
  // send/resolve pipeline still works off the textarea tokens + attachments[].
  const attachBar = document.createElement("div");
  attachBar.className = "cmcp-attachbar";
  attachBar.hidden = true;
  const chipStrip = document.createElement("div");
  chipStrip.className = "cmcp-chipstrip";
  const chipPreview = document.createElement("div");
  chipPreview.className = "cmcp-attach-preview";
  chipPreview.hidden = true;
  attachBar.append(chipStrip, chipPreview);

  const row = document.createElement("div");
  row.className = "cmcp-composer-row";

  // Context-window ring. Claude Code does not expose its context usage to
  // MCP servers, so this stays empty until an `agent_status` frame reports
  // a context_pct — the plumbing is live, the data source is future work.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const RING_R = 7;
  const RING_C = 2 * Math.PI * RING_R;
  const ring = document.createElementNS(SVG_NS, "svg");
  ring.setAttribute("class", "cmcp-ring");
  ring.setAttribute("width", "18");
  ring.setAttribute("height", "18");
  ring.setAttribute("viewBox", "0 0 18 18");
  for (const cls of ["bg", "fg"]) {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("class", cls);
    c.setAttribute("cx", "9");
    c.setAttribute("cy", "9");
    c.setAttribute("r", String(RING_R));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", "2");
    if (cls === "bg") c.setAttribute("opacity", "0.35");
    if (cls === "fg") {
      c.setAttribute("stroke-dasharray", String(RING_C));
      c.setAttribute("stroke-dashoffset", String(RING_C));
      c.setAttribute("stroke-linecap", "round");
    }
    ring.appendChild(c);
  }
  const ringTitle = document.createElementNS(SVG_NS, "title");
  ringTitle.textContent = "Context window — fills as Claude reports usage";
  ring.appendChild(ringTitle);
  // Compact context-usage readout shown right after the ring.
  const ctxLabel = document.createElement("span");
  ctxLabel.className = "cmcp-ctx";
  ctxLabel.title = "Context window used";
  const CTX_KEY = "comfyui-mcp.panel.ctxPct";
  ctxLabel.textContent = "—"; // until the first usage report

  function setContextPct(p) {
    const clamped = Math.max(0, Math.min(1, p > 1 ? p / 100 : p));
    ring.querySelector(".fg").setAttribute("stroke-dashoffset", String(RING_C * (1 - clamped)));
    const pct = Math.round(clamped * 100);
    ringTitle.textContent = `Context window ~${pct}% used`;
    ctxLabel.textContent = clamped > 0 ? `${pct}%` : "—";
  }
  // Restore last % across reloads (orchestrator also re-pushes on connect).
  {
    const p0 = Number(ssGet(CTX_KEY));
    if (p0 > 0) setContextPct(p0);
  }

  // Model + effort picker. The orchestrator forwards these to the Agent SDK,
  // so the chip actually drives the background agent (model live, effort on a
  // resumed restart). The catalog arrives live via the `models` frame; until
  // then it's the small fallback. Selection persists in localStorage and is
  // re-sent on connect so a freshly-spawned agent adopts it. (`prefs` itself is
  // declared earlier — near the settings UI that also reads it.)
  let modelCatalog = presentableModels(normalizeModels(FALLBACK_MODELS));
  if (!prefs.model) prefs.model = pickDefaultModel(modelCatalog);

  /** The effort ids offered for the currently-selected model. Driven primarily by
   *  the connected backend's scale (Claude vs. Codex offer different levels), so a
   *  Codex session shows none/minimal/… and a Claude session shows …/max. Falls
   *  back to the model row's enumerated levels, then the full Claude set. */
  function effortsForModel(id) {
    const backend = connectedBackend || selectedBackend;
    const scale = BACKEND_EFFORTS[backend] || ALL_EFFORTS;
    const row = modelCatalog.find((m) => m.id === id);
    // Explicit model metadata wins over the provider default: [] = this model has
    // NO effort control (hide the selector); a non-empty list is intersected with
    // the provider's scale. row.efforts === null (supports effort, levels unknown)
    // or no catalog row → fall back to the provider scale.
    if (row && Array.isArray(row.efforts)) {
      return row.efforts.length ? row.efforts.filter((e) => scale.includes(e)) : [];
    }
    return scale;
  }

  const modelChip = document.createElement("button");
  modelChip.type = "button";
  modelChip.className = "cmcp-chip";
  modelChip.title = "Model & reasoning effort for the background agent";
  const modelChipLabel = document.createElement("span");
  const modelChipEffort = document.createElement("span");
  modelChipEffort.className = "dim";
  const modelChipCaret = document.createElement("i");
  modelChipCaret.className = "pi pi-angle-down";
  modelChip.append(modelChipLabel, modelChipEffort, modelChipCaret);

  function refreshModelChip() {
    modelChipLabel.textContent = prefs.modelAuto ? "Auto" : modelLabel(modelCatalog, prefs.model);
    modelChipEffort.textContent = prefs.effort ? ` · ${prefs.effort}` : "";
  }

  // Reconcile the ComfyUI Settings defaults with the panel's localStorage runtime.
  // FIRST run with this feature: push the user's existing choices INTO the settings
  // (no regression on upgrade). AFTERWARDS: the settings are canonical and seed the
  // runtime here on each open. Applies directly to the already-declared runtime
  // (selectedBackend / prefs / urlInput) — no chat noise, no set_options push (the
  // normal connect/catalog path sends those once the catalog is live).
  /** SEED prefs (model/modelAuto/effort) from `backend`'s setting group. SEED-ONLY:
   *  it mutates the runtime prefs and saves them, but NEVER sends set_options — the
   *  connect→handshake→applyModelCatalog path makes the single push. Blank model =
   *  Auto (clears the forced model); blank effort = Model default (clears effort).
   *  An UNSET setting (never chosen) is left alone so a brand-new user keeps the
   *  default — callers that switch backends force Auto separately (see applyBackend). */
  function seedPrefsFromBackendGroup(backend) {
    let changed = false;
    const sm = getSetting(SETTING_MODEL[backend]);
    if (typeof sm === "string") {
      if (sm === "") {
        if (!prefs.modelAuto) {
          prefs.modelAuto = true;
          if (!prefs.model) prefs.model = pickDefaultModel(modelCatalog);
          changed = true;
        }
      } else if (sm !== prefs.model || prefs.modelAuto) {
        prefs.model = sm;
        prefs.modelAuto = false;
        prefs.userSet = true;
        changed = true;
      }
    }
    const se = getSetting(SETTING_EFFORT[backend]);
    if (typeof se === "string") {
      if (se === "") {
        if (prefs.effort) {
          prefs.effort = undefined;
          changed = true;
        }
      } else if (se !== prefs.effort) {
        prefs.effort = se;
        prefs.userSet = true;
        changed = true;
      }
    }
    if (changed) savePrefs(prefs);
  }

  function seedFromSettings() {
    if (!app?.ui?.settings) return;
    // One-time: migrate the pre-grouping single Default-model/effort into the Claude
    // group (the default backend) so an upgrade never loses the saved choice. Runs
    // independently of SETTINGS_SEEDED_KEY; only fills an empty Claude-group value.
    if (!lsGet(SETTINGS_GROUPS_MIGRATED_KEY)) {
      const lm = getSetting(LEGACY_SETTING_MODEL);
      const le = getSetting(LEGACY_SETTING_EFFORT);
      if (typeof lm === "string" && lm && getSetting(SETTING_MODEL.claude) == null) {
        setSetting(SETTING_MODEL.claude, lm);
      }
      if (typeof le === "string" && le && getSetting(SETTING_EFFORT.claude) == null) {
        setSetting(SETTING_EFFORT.claude, le);
      }
      // Migrate the pre-per-backend single Bridge URL into the Claude group (the old
      // default port), so a returning user's custom port isn't lost. Skip the dead
      // 9101 legacy default — that migrates to the modern per-backend default anyway.
      const lu = getSetting(LEGACY_SETTING_BRIDGE_URL);
      if (
        typeof lu === "string" &&
        lu &&
        lu !== LEGACY_BRIDGE_URL &&
        getSetting(SETTING_BRIDGE_URL.claude) == null
      ) {
        setSetting(SETTING_BRIDGE_URL.claude, lu);
      }
      lsSet(SETTINGS_GROUPS_MIGRATED_KEY, "1");
    }
    if (!lsGet(SETTINGS_SEEDED_KEY)) {
      setSetting(SETTING_BACKEND, selectedBackend || "claude");
      // Only persist model/effort the user actually chose — never a synthetic
      // fallback-catalog default (which may be an alias id, not a real model). Push
      // them into the ACTIVE backend's group.
      if (prefs.userSet && prefs.model && !prefs.modelAuto) {
        setSetting(SETTING_MODEL[selectedBackend], prefs.model);
      }
      if (prefs.userSet && prefs.effort) setSetting(SETTING_EFFORT[selectedBackend], prefs.effort);
      setSetting(
        SETTING_BRIDGE_URL[selectedBackend],
        urlInput.value || defaultBridgeUrlFor(selectedBackend),
      );
      setSetting(SETTING_AUTOCONNECT, !!lsGet(AUTOCONNECT_KEY));
      lsSet(SETTINGS_SEEDED_KEY, "1");
      return;
    }
    // Canonical path: settings seed the runtime. Backend FIRST (it decides which
    // group seeds prefs), then seed model/effort from THAT backend's group.
    const sb = getSetting(SETTING_BACKEND);
    if (sb && sb !== selectedBackend) {
      selectedBackend = sb;
      try {
        window.localStorage.setItem(STORAGE_KEY_BACKEND, sb);
      } catch {}
    }
    seedPrefsFromBackendGroup(selectedBackend);
    // Per-backend Bridge URL: seed the field from the ACTIVE backend's setting,
    // falling back to that backend's default port (claude 9180 / codex 9181).
    const su =
      getSetting(SETTING_BRIDGE_URL[selectedBackend]) || defaultBridgeUrlFor(selectedBackend);
    if (su && su !== urlInput.value) {
      urlInput.value = su;
      saveBridgeUrl(su);
    }
  }
  seedFromSettings();
  // Arm the setting onChange appliers only AFTER mount + the startup onChange volley
  // and the initial (sticky) connect decision have settled — so ComfyUI applying a
  // persisted Auto-connect/Bridge-URL at load can't drive a connect that storms.
  // Genuine user edits in the Settings dialog happen long after this window.
  setTimeout(() => {
    settingsArmed = true;
  }, 2500);

  refreshModelChip();

  const modelPop = document.createElement("div");
  modelPop.className = "cmcp-popover";
  modelPop.hidden = true;

  function buildModelPop() {
    modelPop.textContent = "";
    const section = (label) => {
      const h = document.createElement("div");
      h.className = "cmcp-pop-section";
      h.textContent = label;
      modelPop.appendChild(h);
    };
    const item = ({ label, small }, selected, onPick) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "cmcp-popover-item" + (selected ? " sel" : "");
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = label;
      el.appendChild(lbl);
      if (small) {
        const s = document.createElement("small");
        s.textContent = small;
        el.appendChild(s);
      }
      // Always render the check (visibility toggled) so the column is reserved
      // and rows don't reflow when the selection changes.
      const c = document.createElement("i");
      c.className = "pi pi-check check" + (selected ? " on" : "");
      el.appendChild(c);
      el.addEventListener("mousedown", (mev) => {
        mev.preventDefault();
        onPick();
      });
      modelPop.appendChild(el);
    };

    // PROVIDER — pick Claude or ChatGPT right here (the switcher used to live in
    // settings). Picking one runs the full switch flow (connectBackend → fresh
    // orchestrator on that backend's port → handshake repopulates Model + Effort).
    // Only shown when more than one provider is actually available.
    if (knownBackends.length > 1) {
      section("Provider");
      const activeBackend = connectedBackend || selectedBackend;
      for (const b of knownBackends) {
        const id = b.backend;
        const hint = notReadyHint(b);
        const notReady = (backendReady[id] || b).ready === false;
        // A not-ready provider can't be connected — tapping it asks the working
        // agent to help you install/sign in instead of failing a connect.
        const small = notReady ? `Tap to set up — ${hint}` : BACKEND_HINTS[id] || (id === activeBackend ? "connected" : b.running ? "running" : "");
        item({ label: BACKEND_LABELS[id] || id, small }, id === activeBackend, () => {
          modelPop.hidden = true;
          if (notReady) {
            requestProviderSetup(id);
          } else if (id !== activeBackend) {
            connectBackend(id);
          }
        });
      }
    }

    section("Model");
    for (const m of modelCatalog) {
      item({ label: m.label, small: m.small }, m.id === prefs.model && !prefs.modelAuto, () => {
        prefs.model = m.id;
        prefs.modelAuto = false; // an explicit pick clears the Auto state
        prefs.userSet = true;
        // SNAP the effort to the nearest level the new model supports (don't wipe
        // it silently); only clear if the model has no effort control at all.
        const before = prefs.effort;
        const avail = effortsForModel(m.id);
        if (prefs.effort && !avail.includes(prefs.effort)) {
          prefs.effort = avail.length ? nearestInList(prefs.effort, avail) : undefined;
        }
        savePrefs(prefs);
        // Keep the ACTIVE backend's Settings group in sync with the picker.
        const bk = connectedBackend || selectedBackend;
        setSetting(SETTING_MODEL[bk], m.id);
        setSetting(SETTING_EFFORT[bk], prefs.effort ?? "");
        refreshModelChip();
        modelPop.hidden = true;
        client?.sendFrame?.({ type: "set_options", model: m.id, effort: prefs.effort ?? null });
        if (prefs.effort && prefs.effort !== before) {
          appendSystem(`Model → ${m.label}. Reasoning effort set to ${effortMeta(prefs.effort).label} (nearest level this model supports).`);
        } else {
          appendSystem(`Model → ${m.label}.`);
        }
      });
    }

    const efforts = effortsForModel(prefs.model);
    if (efforts.length) {
      section("Effort");
      for (const id of efforts) {
        const meta = effortMeta(id);
        item(meta, id === prefs.effort, () => {
          prefs.effort = id;
          prefs.userSet = true;
          savePrefs(prefs);
          // keep the ACTIVE backend's Settings group in sync
          setSetting(SETTING_EFFORT[connectedBackend || selectedBackend], id);
          refreshModelChip();
          modelPop.hidden = true;
          client?.sendFrame?.({ type: "set_options", effort: id });
          appendSystem(`Effort → ${meta.label}. Continuing this chat at the new effort…`);
        });
      }
    }
  }

  /** Replace the catalog when the orchestrator reports the real model list. */
  function applyModelCatalog(list) {
    const next = presentableModels(normalizeModels(list));
    if (!next.length) return;
    modelCatalog = next;
    // Cache this FETCHED catalog for the CONNECTED backend so the Settings dialog's
    // per-backend "Default model" dropdown can offer the right list — and repaint
    // that backend's dropdown in place if it's currently mounted. Only ever touches
    // the connected backend's slot (the other backend's group stays independent).
    const bk = connectedBackend || selectedBackend;
    if (bk) {
      settingsBackendState.modelsByBackend[bk] = modelCatalog;
      if (settingsModelSelectEls[bk]?.isConnected) {
        populateModelSelect(settingsModelSelectEls[bk], bk);
      }
    }
    // Keep the user's saved pick if still valid; else pre-select Opus. When the
    // active backend's saved model is ABSENT from the fetched catalog and it isn't
    // already Auto, snap to Auto and clear the saved setting (under
    // suppressSettingOnChange) so the single post-handshake push sends model:null —
    // matching the Settings dropdown, which renders an absent saved id as DISABLED
    // and selects Auto. Otherwise the push would send a concrete fallback the UI
    // never shows (a UI/agent mismatch). The !modelAuto guard means this fires at
    // most once (then modelAuto persists), so it can't oscillate across reconnects.
    if (!modelCatalog.some((m) => m.id === prefs.model)) {
      if (!prefs.modelAuto && bk) {
        prefs.modelAuto = true;
        setSetting(SETTING_MODEL[bk], "");
      }
      prefs.model = pickDefaultModel(modelCatalog);
    }
    // Preserve the user's chosen effort across a backend switch: the new backend's
    // scale may not contain the exact level, so SNAP it to the nearest level this
    // MODEL actually offers (Claude "max" → Codex "xhigh", Codex "none"/"minimal"
    // → Claude "low") instead of dropping it. Only clear it to undefined when the
    // model has NO effort control (avail empty). Never change it invisibly: if the
    // resulting level differs from what the user had, leave a one-line note.
    if (prefs.effort) {
      const before = prefs.effort;
      const avail = effortsForModel(prefs.model);
      // Snap directly into the model's available set (which is already the
      // intersection of the model's levels with the connected backend's scale).
      const snapped = nearestInList(before, avail);
      prefs.effort = snapped;
      if (snapped !== before && prefs.userSet) {
        if (snapped) {
          appendSystem(
            `Reasoning effort set to ${effortMeta(snapped).label} for ${modelLabel(modelCatalog, prefs.model)} (nearest level this model supports).`,
          );
        } else {
          appendSystem(
            `${modelLabel(modelCatalog, prefs.model)} has no reasoning-effort control; effort cleared.`,
          );
        }
      }
    }
    savePrefs(prefs);
    refreshModelChip();
    if (!modelPop.hidden) buildModelPop();
    // Now that the catalog is live, prefs.model is a REAL id — safe to push the
    // user's saved pick so a freshly-spawned agent adopts it. (Never sent before
    // this point; the fallback id may not be a usable model.)
    if (prefs.userSet) {
      client?.sendFrame?.({
        type: "set_options",
        // Auto (modelAuto) un-pins the model so the agent uses its own default.
        model: prefs.modelAuto ? null : prefs.model,
        effort: prefs.effort ?? null,
      });
    }
  }

  modelChip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (modelPop.hidden) {
      buildModelPop();
      modelPop.hidden = false;
      // Refresh provider discovery (running status) in the background; rebuild the
      // popup if it's still open and the list changed, so the PROVIDER section is
      // current without blocking the open.
      void loadBackends().then(() => {
        if (!modelPop.hidden) buildModelPop();
      });
    } else {
      modelPop.hidden = true;
    }
  });

  const spacer = document.createElement("span");
  spacer.className = "cmcp-spacer";

  const attachBtn = iconBtn("pi-paperclip", "Attach an image, video, workflow (.json), or text file");
  const micBtn = iconBtn("pi-microphone", "Dictate (browser speech recognition)");
  const sendBtn = iconBtn("pi-send", "Send (Enter)");
  sendBtn.type = "submit";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  // Images + video upload into ComfyUI input/; workflows (.json) and text files
  // are read and delivered inline to the agent. See handleFile() below.
  fileInput.accept =
    "image/*,video/*,.json,.txt,.md,.markdown,.csv,.tsv,.yaml,.yml,.xml,.toml,.ini,.cfg,.log,.py,.js,.ts,.sh,text/*,application/json";
  fileInput.multiple = true;
  fileInput.hidden = true;

  row.append(ring, ctxLabel, modelChip, spacer, attachBtn, micBtn, sendBtn);
  form.append(menuPop, modelPop, attachBar, input, row, fileInput);
  root.appendChild(form);

  // ---- feed renderers + thread persistence ----
  // paint* draws DOM only; append* paints AND records into the current
  // thread (localStorage), so history can replay a conversation verbatim.
  const THREADS_KEY = "comfyui-mcp.panel.threads";
  const MAX_THREADS = 20;
  const MAX_THREAD_MSGS = 200;
  let threads = (() => {
    try {
      const t = JSON.parse(window.localStorage.getItem(THREADS_KEY) ?? "[]");
      return Array.isArray(t) ? t : [];
    } catch {
      return [];
    }
  })();
  let thread = null; // created lazily on first recorded message

  function persistThreads() {
    try {
      window.localStorage.setItem(THREADS_KEY, JSON.stringify(threads.slice(-MAX_THREADS)));
    } catch {
      // localStorage unavailable — history is session-only.
    }
  }

  function record(entry) {
    if (!thread) {
      thread = { id: crypto.randomUUID(), ts: Date.now(), msgs: [] };
      // Adopt any session id the orchestrator has already reported for this tab.
      const sid = ssGet(SESSION_KEY);
      if (sid) thread.sessionId = sid;
      threads.push(thread);
      if (threads.length > MAX_THREADS) threads = threads.slice(-MAX_THREADS);
      ssSet(CURRENT_THREAD_KEY, thread.id);
    }
    thread.msgs.push(entry);
    if (thread.msgs.length > MAX_THREAD_MSGS) {
      thread.msgs.splice(0, thread.msgs.length - MAX_THREAD_MSGS);
    }
    thread.ts = Date.now();
    persistThreads();
  }

  /** Bind the agent's current session id to the open thread (for reload/resume). */
  function bindSession(sessionId) {
    ssSet(SESSION_KEY, sessionId);
    if (thread) {
      thread.sessionId = sessionId || undefined;
      persistThreads();
    }
  }

  function scrollLog() {
    if (!stickToBottom) {
      // User is reading further up — don't yank them down; offer the jump pill.
      newMsgBtn.hidden = false;
      return;
    }
    // Defer to after layout so tall content (code blocks, images) still lands
    // at the true bottom.
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }

  // Build an inline, expandable chip (+ hidden preview) for one [Pasted text #N]
  // token inside a user bubble. The chip mirrors the composer chip look; clicking
  // it toggles a read-only, scrollable, monospace preview of the FULL content.
  // `bubble` scopes "one preview open at a time". Null-safe; never throws.
  // Render a user message into `container`, replacing each [Pasted text #N] token
  // with the actual pasted content INLINE (looked up in `atts` by id) — rendered
  // verbatim as a text node, exactly as if the user had typed it (no chip/widget).
  // Surrounding text renders verbatim too. Tokens with no matching attachment
  // content fall back to their literal text. Never throws into the render.
  function renderUserText(container, text, atts) {
    const raw = text != null ? String(text) : "";
    try {
      const byId = new Map();
      if (Array.isArray(atts)) {
        for (const a of atts) if (a && a.id != null) byId.set(String(a.id), a);
      }
      const re = /\[Pasted text #(\d+)\]/g;
      let last = 0;
      let m;
      while ((m = re.exec(raw)) !== null) {
        if (m.index > last) container.appendChild(document.createTextNode(raw.slice(last, m.index)));
        const att = byId.get(m[1]);
        if (att && att.content != null) {
          // Interpolate the pasted content INLINE as plain text — render the message
          // exactly as if the user had typed it (no chip / preview widget).
          container.appendChild(document.createTextNode(att.content));
        } else {
          container.appendChild(document.createTextNode(m[0])); // graceful fallback
        }
        last = re.lastIndex;
      }
      if (last < raw.length) container.appendChild(document.createTextNode(raw.slice(last)));
    } catch {
      container.textContent = raw; // a bad attachment must never blank the bubble
    }
  }

  function paintUser(text, opts = {}) {
    clearEmpty();
    const b = document.createElement("div");
    b.className = "cmcp-bubble user";
    renderUserText(b, text, opts.attachments);
    if (opts.mid) b.dataset.mid = opts.mid;
    // Hover edit/rollback button — only on live messages (those with a mid).
    // Absolute-positioned to the LEFT of the bubble so it never causes reflow.
    if (opts.mid) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "cmcp-edit-btn";
      edit.title = "Edit & roll back from this message";
      edit.innerHTML = '<i class="pi pi-pencil"></i>';
      const rewindAnchor = opts.rewindAnchor ?? null;
      edit.addEventListener("click", () => openRollbackModal({ mid: opts.mid, text, anchor: rewindAnchor }));
      b.appendChild(edit);
    }
    log.appendChild(b);
    // Live sends get a delivery-status line below the bubble (sending → seen, or
    // failed with resend/delete). Replayed history has no mid → no status.
    let statusEl = null;
    if (opts.mid) {
      statusEl = document.createElement("div");
      statusEl.className = "cmcp-msg-status";
      statusEl.dataset.mid = opts.mid;
      log.appendChild(statusEl);
    }
    scrollLog();
    return { bubble: b, statusEl };
  }

  function paintAgent(text) {
    clearEmpty();
    const b = document.createElement("div");
    b.className = "cmcp-bubble agent";
    renderRichText(b, text);
    log.appendChild(b);
    scrollLog();
  }

  function paintCard({ icon, text, detail, error }) {
    clearEmpty();
    const card = document.createElement("div");
    card.className = "cmcp-card" + (error ? " error" : "");
    const head = document.createElement("div");
    head.className = "cmcp-card-head";
    const i = document.createElement("i");
    i.className = `pi ${icon}`;
    const t = document.createElement("span");
    t.className = "cmcp-card-text";
    t.textContent = text;
    t.title = text; // full value on hover (the line is ellipsized)
    head.append(i, t);
    card.appendChild(head);
    if (detail) {
      const d = document.createElement("div");
      d.className = "cmcp-card-detail";
      d.textContent = detail;
      card.appendChild(d);
    }
    log.appendChild(card);
    scrollLog();
  }

  function paintImage(url, name) {
    clearEmpty();
    const card = document.createElement("div");
    card.className = "cmcp-bubble agent cmcp-imgcard";
    const img = document.createElement("img");
    img.src = url;
    img.alt = name || "output";
    img.loading = "lazy";
    img.style.cssText = "max-width:100%;border-radius:6px;display:block;cursor:zoom-in;";
    img.addEventListener("click", () => window.open(url, "_blank"));
    card.appendChild(img);
    if (name) {
      const cap = document.createElement("div");
      cap.style.cssText = "font-size:0.625rem;color:var(--p-text-muted-color,#a1a1aa);margin-top:0.25rem;";
      cap.textContent = name;
      card.appendChild(cap);
    }
    log.appendChild(card);
    scrollLog();
  }

  // Lazy chat-video manager: only videos currently scrolled into view hold a live
  // <video> element (autoplaying muted); off-screen ones are swapped for a gray
  // placeholder of the same aspect ratio, so a long session with many clips doesn't
  // accumulate decoded-video memory. Re-entering view re-mounts (and re-autoplays).
  let _videoIO = null;
  function videoObserver() {
    if (_videoIO) return _videoIO;
    _videoIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) mountHolderVideo(e.target);
          else unmountHolderVideo(e.target);
        }
      },
      { root: log, rootMargin: "300px 0px" }, // mount slightly before fully in view
    );
    return _videoIO;
  }
  function mountHolderVideo(holder) {
    if (holder._video) return; // already live
    const v = document.createElement("video");
    v.muted = true;
    v.setAttribute("muted", ""); // required for muted autoplay on some browsers
    v.autoplay = true;
    v.loop = true;
    v.playsInline = true;
    v.controls = true;
    v.preload = "metadata";
    v.src = holder.dataset.src;
    v.style.cssText = "width:100%;display:block;border-radius:6px;";
    v.addEventListener("loadedmetadata", () => {
      // Learn the real aspect ratio so the placeholder (and layout) match exactly.
      if (v.videoWidth && v.videoHeight) holder.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
    });
    holder.textContent = "";
    holder.appendChild(v);
    holder._video = v;
    v.play?.().catch(() => {}); // muted autoplay is allowed; ignore if the browser blocks it
  }
  function unmountHolderVideo(holder) {
    const v = holder._video;
    if (!v) return;
    try {
      v.pause();
      v.removeAttribute("src");
      v.load(); // release the decoded buffers — this is the memory win
    } catch {
      // best-effort
    }
    v.remove();
    holder._video = null; // holder keeps its learned aspect-ratio → gray placeholder fills it
  }

  function paintVideo(url, name) {
    clearEmpty();
    const card = document.createElement("div");
    card.className = "cmcp-bubble agent cmcp-imgcard";
    // Self-sizing holder: a live <video> when on-screen, a gray aspect-ratio box
    // when off-screen. Defaults to 16/9 until the first mount learns real dimensions.
    const holder = document.createElement("div");
    holder.className = "cmcp-video-holder";
    holder.dataset.src = url;
    holder.style.cssText =
      "width:100%;aspect-ratio:16 / 9;border-radius:6px;background:var(--p-content-hover-background,#2a2a2e);";
    card.appendChild(holder);
    if (name) {
      const cap = document.createElement("div");
      cap.style.cssText = "font-size:0.625rem;color:var(--p-text-muted-color,#a1a1aa);margin-top:0.25rem;";
      cap.textContent = name;
      card.appendChild(cap);
    }
    log.appendChild(card);
    videoObserver().observe(holder);
    scrollLog();
  }

  /** Decide whether a ComfyUI output descriptor is a VIDEO (render <video>) vs an
   *  image (<img>). ComfyUI groups video outputs under `gifs`/`videos` and tags
   *  them with a `format` like "video/h264-mp4" (vs "image/gif" for animated gifs,
   *  which still render fine in <img>). Fall back to the filename extension. */
  function isVideoOutput(m) {
    const fmt = String(m?.format || "").toLowerCase();
    if (fmt.startsWith("video/")) return true;
    if (fmt.startsWith("image/")) return false; // incl. image/gif → animate in <img>
    return /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(String(m?.filename || ""));
  }

  /**
   * Render an interactive question card and resolve with the user's pick.
   * `msg` = { question, header?, options:[{label, description?}], multi_select? }.
   * Single-select resolves on click; multi-select toggles and resolves on Submit.
   * An always-present "Other…" field lets the user answer freely. Returns the
   * chosen string (comma-joined for multi-select) — the agent's tool result.
   */
  function paintQuestion(msg) {
    clearEmpty();
    const opts = Array.isArray(msg.options) ? msg.options : [];
    const multi = !!msg.multi_select;
    const card = document.createElement("div");
    card.className = "cmcp-card cmcp-question";
    card.style.cssText = "border-left:3px solid var(--p-primary-color,#3a7bd5);";

    if (msg.header) {
      const chip = document.createElement("div");
      chip.className = "cmcp-card-head";
      chip.style.cssText = "text-transform:uppercase;font-size:0.6rem;letter-spacing:0.05em;opacity:0.7;";
      chip.textContent = msg.header;
      card.appendChild(chip);
    }
    const q = document.createElement("div");
    q.style.cssText = "font-weight:600;margin:0.15rem 0 0.5rem;";
    renderRichText(q, msg.question || "Pick one:");
    card.appendChild(q);

    const selected = new Set();
    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });

    const finish = (answer) => {
      if (done) return;
      done = true;
      // Collapse the interactive card into a STATIC result — remove every button
      // and input so it no longer looks clickable / awaiting an answer.
      card.replaceChildren();
      card.classList.remove("cmcp-question");
      card.style.cssText = "border-left:3px solid var(--p-primary-color,#3a7bd5);opacity:0.9;";
      if (msg.question) {
        const q = document.createElement("div");
        q.style.cssText = "font-size:0.72rem;opacity:0.65;";
        q.textContent = msg.question;
        card.appendChild(q);
      }
      const a = document.createElement("div");
      a.style.cssText = "font-weight:600;margin-top:0.15rem;color:var(--p-primary-color,#6ea8fe);";
      a.textContent = `✓ ${answer}`;
      card.appendChild(a);
      // Record as a plain card so a reload restores it as static text, not a widget.
      record({ role: "card", icon: "pi-check", text: msg.question || "Choice", detail: answer });
      scrollLog();
      resolveFn(answer);
    };

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;flex-direction:column;gap:0.3rem;";
    for (const opt of opts) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cmcp-opt";
      b.style.cssText =
        "text-align:left;padding:0.4rem 0.55rem;border-radius:6px;border:1px solid var(--p-surface-500,#555);" +
        "background:var(--p-surface-800,#2a2a2a);color:inherit;cursor:pointer;font-size:0.8rem;";
      const lbl = document.createElement("div");
      lbl.style.fontWeight = "600";
      lbl.textContent = opt.label ?? String(opt);
      b.appendChild(lbl);
      if (opt.description) {
        const d = document.createElement("div");
        d.style.cssText = "font-size:0.7rem;opacity:0.7;margin-top:0.1rem;";
        d.textContent = opt.description;
        b.appendChild(d);
      }
      b.addEventListener("click", () => {
        if (done) return;
        if (multi) {
          const label = opt.label ?? String(opt);
          if (selected.has(label)) { selected.delete(label); b.style.borderColor = "var(--p-surface-500,#555)"; }
          else { selected.add(label); b.style.borderColor = "var(--p-primary-color,#3a7bd5)"; }
        } else {
          finish(opt.label ?? String(opt));
        }
      });
      btnRow.appendChild(b);
    }
    card.appendChild(btnRow);

    // Always-available free-text answer ("Other").
    const otherRow = document.createElement("div");
    otherRow.style.cssText = "display:flex;gap:0.3rem;margin-top:0.4rem;";
    const other = document.createElement("input");
    other.type = "text";
    other.placeholder = "Other… (type your own answer)";
    other.style.cssText =
      "flex:1;padding:0.35rem 0.5rem;border-radius:6px;border:1px solid var(--p-surface-500,#555);" +
      "background:var(--p-surface-900,#1e1e1e);color:inherit;font-size:0.8rem;";
    other.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && other.value.trim()) { e.preventDefault(); finish(other.value.trim()); }
    });
    otherRow.appendChild(other);

    const submit = document.createElement("button");
    submit.type = "button";
    submit.style.cssText =
      "padding:0.35rem 0.7rem;border-radius:6px;border:none;cursor:pointer;font-size:0.8rem;" +
      "background:var(--p-primary-color,#3a7bd5);color:#fff;";
    submit.textContent = multi ? "Submit" : "Send";
    submit.addEventListener("click", () => {
      if (done) return;
      if (other.value.trim()) finish(other.value.trim());
      else if (multi && selected.size) finish([...selected].join(", "));
    });
    otherRow.appendChild(submit);
    card.appendChild(otherRow);

    log.appendChild(card);
    scrollLog();
    return promise;
  }

  /**
   * Render a SECURE secret/token input and resolve with the pasted value.
   * `msg` = { label?, hint? }. The value is masked, never echoed back into the
   * chat, and NEVER recorded to history — only the agent-supplied label and a
   * redacted "received" note are kept. The resolved string travels straight back
   * over the bridge to the orchestrator (which writes it to config); it never
   * enters the agent's context.
   */
  function paintSecret(msg) {
    clearEmpty();
    const card = document.createElement("div");
    card.className = "cmcp-card cmcp-secret";
    card.style.cssText =
      "border-left:3px solid var(--p-yellow-400,#facc15);width:100%;box-sizing:border-box;";

    const head = document.createElement("div");
    head.className = "cmcp-card-head";
    const lock = document.createElement("i");
    lock.className = "pi pi-lock";
    const t = document.createElement("span");
    t.style.fontWeight = "600";
    t.textContent = msg.label || "Paste your token";
    head.append(lock, t);
    card.appendChild(head);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:0.68rem;opacity:0.7;margin:0.2rem 0 0.4rem;";
    hint.textContent =
      msg.hint || "Sent straight to your config — never shown to the agent and never saved to chat history.";
    card.appendChild(hint);

    let done = false;
    let resolveFn;
    const promise = new Promise((res) => { resolveFn = res; });

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:0.3rem;";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Paste token…";
    input.style.cssText =
      "flex:1;min-width:7rem;padding:0.35rem 0.5rem;border-radius:6px;border:1px solid var(--p-surface-500,#555);" +
      "background:var(--p-surface-900,#1e1e1e);color:inherit;font-size:0.8rem;";

    // Show/record only a masked preview (first 4 … last 4) so the user can
    // confirm WHICH token without ever exposing the full value.
    const mask = (v) =>
      !v ? "" : v.length <= 8 ? "•".repeat(v.length) : `${v.slice(0, 4)}…${v.slice(-4)}`;
    const finish = (value) => {
      if (done) return;
      done = true;
      input.value = ""; // clear the field immediately
      card.replaceChildren();
      card.style.cssText = "border-left:3px solid var(--p-green-400,#4ade80);opacity:0.9;";
      const ok = document.createElement("div");
      ok.style.cssText = "font-size:0.75rem;color:var(--p-green-400,#4ade80);";
      const m = mask(value);
      ok.textContent = value ? `🔒 Token saved: ${m}` : "Skipped — no token entered.";
      card.appendChild(ok);
      // Record ONLY the masked preview — never the full value.
      record({ role: "card", icon: "pi-lock", text: msg.label || "Token", detail: value ? `saved ${m}` : "skipped" });
      scrollLog();
      resolveFn(value || "");
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(input.value.trim()); }
    });
    row.appendChild(input);

    const submit = document.createElement("button");
    submit.type = "button";
    submit.style.cssText =
      "padding:0.35rem 0.7rem;border-radius:6px;border:none;cursor:pointer;font-size:0.8rem;" +
      "background:var(--p-primary-color,#3a7bd5);color:#fff;";
    submit.textContent = "Save";
    submit.addEventListener("click", () => finish(input.value.trim()));
    row.appendChild(submit);

    const skip = document.createElement("button");
    skip.type = "button";
    skip.style.cssText =
      "padding:0.35rem 0.6rem;border-radius:6px;border:1px solid var(--p-surface-500,#555);" +
      "background:transparent;color:inherit;cursor:pointer;font-size:0.8rem;";
    skip.textContent = "Skip";
    skip.addEventListener("click", () => finish(""));
    row.appendChild(skip);

    card.appendChild(row);
    log.appendChild(card);
    scrollLog();
    setTimeout(() => input.focus(), 0);
    return promise;
  }

  function appendUser(text, opts = {}) {
    stickToBottom = true; // your own message → always jump to the latest
    newMsgBtn.hidden = true;
    // Capture the rewind anchor NOW (the latest turn's UUID) so a later rewind to
    // this message forks the conversation right before it — stored directly (not as
    // an index, which a bounded-ring shift() would invalidate).
    const rewindAnchor = turnAnchors.length > 0 ? turnAnchors[turnAnchors.length - 1] : null;
    const painted = paintUser(text, { ...opts, rewindAnchor });
    // Tag the record with its mid so deleteMsg can remove the EXACT message even
    // when several are queued (popping the trailing one would hit the wrong one).
    // Persist any pasted-text attachments ({id, content[, truncated]}) so reload
    // can re-render the bubble chips. `text` stays raw (tokens) for agent/rollback.
    const atts = Array.isArray(opts.attachments) ? opts.attachments : null;
    record({
      role: "user",
      text,
      ...(opts.mid ? { mid: opts.mid } : {}),
      ...(atts && atts.length ? { attachments: atts } : {}),
    });
    return painted;
  }

  // ---- message delivery / read state ----
  // Every live send carries a client message id (mid). A message is QUEUED (muted
  // + ✎/✕) from the moment it's sent until the agent actually DEQUEUES it (the
  // orchestrator's "seen" ack) — i.e. read state is the true read moment, not mere
  // receipt. The brief "working" ack (receipt) only cancels the failure timer.
  // While queued, ✎ pulls it back to the composer and ✕ cancels it — both yank it
  // out of the agent's queue so it's never processed. If the socket was closed at
  // send or nothing acks in time, it goes FAILED (red) — a dropped message never
  // silently vanishes.
  let midCounter = 0;
  const pendingMsgs = new Map(); // mid -> { statusEl, payload, raw, timer }
  const DELIVERY_TIMEOUT_MS = 7000;

  function newMid() {
    midCounter += 1;
    return `m${Date.now().toString(36)}_${midCounter.toString(36)}`;
  }

  function statusElFor(mid) {
    return (
      pendingMsgs.get(mid)?.statusEl ||
      log.querySelector(`.cmcp-msg-status[data-mid="${mid}"]`)
    );
  }

  function iconAction(icon, title, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cmcp-msg-action";
    b.title = title;
    const i = document.createElement("i");
    i.className = `pi ${icon}`;
    b.appendChild(i);
    b.addEventListener("click", onClick);
    return b;
  }

  function setMsgStatus(mid, state) {
    const statusEl = statusElFor(mid);
    const bubble = log.querySelector(`.cmcp-bubble.user[data-mid="${mid}"]`);
    const entry = pendingMsgs.get(mid);
    if (entry) entry.state = state;
    if (state === "read") {
      // The agent dequeued it → the bubble materializes in place (CSS un-hides it),
      // and it leaves the pending tray.
      bubble?.classList.remove("queued", "failed");
      statusEl?.remove();
      renderTray();
      return;
    }
    // queued (muted) or failed (red): tint the bubble + expose ✎/✕. The agent
    // hasn't read it yet, so editing/deleting just yanks it from the queue.
    bubble?.classList.toggle("queued", state === "queued");
    bubble?.classList.toggle("failed", state === "failed");
    renderTray(); // reflect queued/failed state in the pending tray
    if (!statusEl) return;
    statusEl.className = "cmcp-msg-status " + state;
    statusEl.replaceChildren(
      iconAction("pi-pencil", "Edit — pull back to the composer", () => editMsg(mid)),
      iconAction("pi-times", "Cancel this message", () => deleteMsg(mid)),
    );
  }

  /** Tell the orchestrator to drop a still-queued message from the agent's queue
   *  (no-op server-side if it was already read or never received). */
  function cancelOnServer(mid) {
    client?.sendFrame?.({ type: "cancel_message", mid });
  }

  /** ✎ a queued/failed message: yank it from the queue and drop its text back in
   *  the composer to edit & resend. */
  function editMsg(mid) {
    const entry = pendingMsgs.get(mid);
    const bubble = log.querySelector(`.cmcp-bubble.user[data-mid="${mid}"]`);
    const raw = entry?.raw ?? bubble?.textContent ?? "";
    deleteMsg(mid); // cancels on server + removes bubble + trailing record
    setComposerValue(raw);
    input.focus();
  }

  function armDeliveryTimeout(mid) {
    const entry = pendingMsgs.get(mid);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (pendingMsgs.has(mid)) setMsgStatus(mid, "failed");
    }, DELIVERY_TIMEOUT_MS);
  }

  function trackSend(mid, statusEl, payload, raw, materialize) {
    // A `materialize` fn means this is a QUEUED send: nothing is painted inline yet;
    // it waits in the pending tray and `materialize()` paints it at the END of the
    // chat when the agent dequeues it (so the chat flows in dequeue order). An idle
    // send ("sending") is already painted inline and processes immediately.
    pendingMsgs.set(mid, {
      statusEl,
      payload,
      raw,
      timer: null,
      state: materialize ? "queued" : "sending",
      materialize: materialize || null,
    });
    const ok = client.sendUserMessage(payload.text, payload.context, payload.images, mid);
    if (!ok) setMsgStatus(mid, "failed"); // socket wasn't open — instant fail
    else armDeliveryTimeout(mid);
    renderTray(); // surface it in the pending tray (not inline)
  }

  /** "Send now" from the pending tray: a queued message → interrupt the current
   *  turn so the agent gets to the queue immediately; a failed one → resend it. */
  function sendNowMsg(mid) {
    const entry = pendingMsgs.get(mid);
    if (!entry) return;
    if (entry.state === "failed") {
      setMsgStatus(mid, "queued");
      const ok = client.sendUserMessage(entry.payload.text, entry.payload.context, entry.payload.images, mid);
      if (!ok) setMsgStatus(mid, "failed");
      else armDeliveryTimeout(mid);
    } else {
      // requeue:true — this is SEND NOW, not a plain Stop: re-queue the turn the
      // agent was interrupted on so BOTH it and this queued message get answered.
      client?.sendFrame?.({ type: "interrupt", requeue: true });
    }
    renderTray();
  }

  /** Drag-reorder the pending tray: move `dragMid` to where `targetMid` sits, then
   *  tell the orchestrator the new flush order so it drains the queue that way. */
  function reorderPending(dragMid, targetMid) {
    if (!dragMid || dragMid === targetMid) return;
    const isTray = (e) => e.state === "queued" || e.state === "failed";
    const queued = [...pendingMsgs].filter(([, e]) => isTray(e));
    const others = [...pendingMsgs].filter(([, e]) => !isTray(e));
    const from = queued.findIndex(([m]) => m === dragMid);
    const to = queued.findIndex(([m]) => m === targetMid);
    if (from < 0 || to < 0) return;
    const [moved] = queued.splice(from, 1);
    queued.splice(to, 0, moved);
    // Rebuild the Map in the new order (queued reordered; transient sends trail).
    pendingMsgs.clear();
    for (const [m, e] of [...queued, ...others]) pendingMsgs.set(m, e);
    renderTray();
    client?.sendFrame?.({ type: "reorder", order: queued.map(([m]) => m) });
  }

  /** Receipt ack (orchestrator got it): not dropped → cancel the failure timer.
   *  Still QUEUED until the agent reads it (the "seen" ack). */
  function markReceived(mid) {
    const entry = pendingMsgs.get(mid);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /** Read ack (agent dequeued it): a queued message materializes at the END of the
   *  chat (dequeue order, before the reply); an idle send just sheds its status. */
  function markRead(mid) {
    const entry = pendingMsgs.get(mid);
    if (entry?.timer) clearTimeout(entry.timer);
    pendingMsgs.delete(mid);
    if (entry?.materialize) {
      entry.materialize(); // paint bubble + images at the bottom now
      renderTray(); // it left the pending tray
    } else {
      setMsgStatus(mid, "read");
    }
  }

  function deleteMsg(mid) {
    const entry = pendingMsgs.get(mid);
    if (entry?.timer) clearTimeout(entry.timer);
    pendingMsgs.delete(mid);
    cancelOnServer(mid); // drop it from the agent's queue if still there
    renderTray(); // remove it from the pending tray
    for (const el of log.querySelectorAll(`[data-mid="${mid}"]`)) el.remove();
    // Remove the EXACT record for this mid (not the trailing one — several may be
    // queued at once).
    const msgs = thread?.msgs;
    if (msgs) {
      const i = msgs.findIndex((m) => m.role === "user" && m.mid === mid);
      if (i >= 0) {
        msgs.splice(i, 1);
        persistThreads();
      }
    }
  }

  function appendAgent(text) {
    paintAgent(text);
    record({ role: "agent", text });
  }

  // ---- live streaming (thinking + reply) ----
  // Deltas arrive in uneven, network-sized chunks. To match the official app's
  // smooth character-by-character feel we DON'T paint each chunk directly —
  // instead each bubble holds a target string and a "shown" cursor, and ONE rAF
  // loop advances every active bubble a few chars per frame: fast enough to catch
  // up on a big burst, slow enough to read as typing. The committed `say` renders
  // markdown only once the typewriter has caught up, so it never snaps mid-reveal.
  // Keyed by SDK message id so deltas stay coherent and the final say replaces the
  // preview instead of duplicating. Zero deps (no GSAP) — streaming text wants a
  // render loop, not a DOM-splitting animation.
  const streamBubbles = new Map(); // id -> bubble state
  const animating = new Set(); // bubbles with characters still to reveal
  let streamRaf = null;

  function kickStreams(s) {
    animating.add(s);
    if (streamRaf == null) streamRaf = requestAnimationFrame(pumpStreams);
  }

  function pumpStreams() {
    streamRaf = null;
    let active = false;
    for (const s of animating) {
      let busy = false;
      // Reveal thinking text (proportional catch-up, a few chars/frame minimum).
      if (s.thinkBody && s.thinkShown < s.thinkTarget.length) {
        const rem = s.thinkTarget.length - s.thinkShown;
        s.thinkShown = Math.min(s.thinkTarget.length, s.thinkShown + Math.max(3, Math.ceil(rem / 6)));
        s.thinkBody.textContent = s.thinkTarget.slice(0, s.thinkShown);
        s.thinkBody.scrollTop = s.thinkBody.scrollHeight;
        busy = true;
      }
      // Reveal reply text a touch slower so it reads as deliberate typing.
      if (s.replyShown < s.replyTarget.length) {
        const rem = s.replyTarget.length - s.replyShown;
        s.replyShown = Math.min(s.replyTarget.length, s.replyShown + Math.max(2, Math.ceil(rem / 9)));
        s.replyEl.textContent = s.replyTarget.slice(0, s.replyShown);
        busy = true;
      }
      if (busy) {
        active = true;
      } else if (s.commitText != null) {
        finalizeStream(s); // caught up and the final text is waiting → commit it
      } else {
        animating.delete(s); // idle until the next delta arrives
      }
    }
    if (active) {
      scrollLog();
      streamRaf = requestAnimationFrame(pumpStreams);
    }
  }

  function ensureStreamBubble(id) {
    let s = streamBubbles.get(id);
    if (s) return s;
    clearEmpty();
    const el = document.createElement("div");
    el.className = "cmcp-bubble agent streaming";
    const replyEl = document.createElement("div");
    replyEl.className = "cmcp-reply";
    el.appendChild(replyEl);
    log.appendChild(el);
    s = {
      id,
      el,
      replyEl,
      thinkWrap: null,
      thinkBody: null,
      thinkSummary: null,
      thinkTarget: "",
      thinkShown: 0,
      replyTarget: "",
      replyShown: 0,
      commitText: null,
    };
    streamBubbles.set(id, s);
    bumpThinking(); // keep the working indicator pinned below the new bubble
    return s;
  }

  function ensureThinkArea(s) {
    if (s.thinkWrap) return s;
    const det = document.createElement("details");
    det.className = "cmcp-think";
    det.open = true;
    const sum = document.createElement("summary");
    sum.textContent = "Thinking…";
    const body = document.createElement("div");
    body.className = "cmcp-think-body";
    det.append(sum, body);
    s.el.insertBefore(det, s.replyEl); // thinking sits above the reply
    s.thinkWrap = det;
    s.thinkBody = body;
    s.thinkSummary = sum;
    return s;
  }

  function collapseThinking(s, label) {
    if (!s.thinkWrap) return;
    s.thinkShown = s.thinkTarget.length; // snap the (now hidden) reasoning to full
    if (s.thinkBody) s.thinkBody.textContent = s.thinkTarget;
    s.thinkWrap.open = false;
    if (s.thinkSummary) s.thinkSummary.textContent = label;
  }

  function onStreamDelta(msg) {
    const { phase, id } = msg;
    const delta = typeof msg.delta === "string" ? msg.delta : "";
    if (phase === "think") {
      const s = ensureStreamBubble(id);
      ensureThinkArea(s);
      s.thinkTarget += delta;
      kickStreams(s);
    } else if (phase === "text") {
      const s = ensureStreamBubble(id);
      collapseThinking(s, "See thinking"); // reply began → tuck the reasoning away
      s.replyTarget += delta;
      s.replyEl.classList.add("streaming-cursor");
      kickStreams(s);
    }
    // phase "end" (message_stop): nothing — the commit (or typewriter catch-up)
    // finalizes the bubble; the caret keeps blinking until the real text lands.
  }

  function finalizeStream(s) {
    animating.delete(s);
    streamBubbles.delete(s.id);
    s.replyEl.classList.remove("streaming-cursor");
    collapseThinking(s, "See thinking");
    renderRichText(s.replyEl, s.commitText); // streamed plain text → final markdown
    s.el.classList.remove("streaming");
    record({ role: "agent", text: s.commitText }); // thinking is ephemeral
    scrollLog();
  }

  /** Reconcile a committed `say` with its live preview: let the typewriter finish,
   *  then render final markdown (done in pumpStreams → finalizeStream). Returns
   *  false if there's no matching stream bubble (caller paints a normal bubble). */
  function commitStream(id, text) {
    const s = streamBubbles.get(id);
    if (!s) return false;
    s.commitText = text;
    s.replyTarget = text; // authoritative — guarantees the typewriter reaches the end
    // CRITICAL: the typewriter (pumpStreams) runs on requestAnimationFrame, which
    // the browser PAUSES in a hidden/background tab. If the user switched away
    // during the turn (common on long pipeline runs), the reply would never paint
    // and the bubble would sit empty with a stuck cursor — looking like "stuck
    // thinking / never drains." When hidden, render the final text SYNCHRONOUSLY
    // instead of waiting for an RAF tick that won't come.
    if (document.hidden) finalizeStream(s);
    else kickStreams(s); // run to completion; finalizeStream renders markdown when caught up
    return true;
  }

  function appendSystem(text) {
    // System notices are transient — painted, never recorded.
    const b = document.createElement("div");
    b.className = "cmcp-sys";
    b.textContent = text;
    log.appendChild(b);
    scrollLog();
  }

  function appendActivity(cmd, msg, reply) {
    const { icon, text, detail } = describeCommand(cmd, msg, reply);
    const card = { icon, text, detail, error: !reply.ok };
    paintCard(card);
    record({ role: "card", ...card });
  }

  function resetFeed() {
    for (const el of [...log.children]) el.remove();
    streamBubbles.clear(); // drop any in-flight streaming previews (DOM is gone)
    log.appendChild(empty);
  }

  function newChat() {
    thread = null;
    turnAnchors = []; // fresh conversation → no rewind anchors
    ssSet(CURRENT_THREAD_KEY, null);
    ssSet(SESSION_KEY, null);
    ssSet(CTX_KEY, null);
    if (typeof resetAttachments === "function") resetAttachments();
    resetFeed();
    renderTodo([]); // fresh chat → empty plan tray
    setContextPct(0);
    ctxLabel.textContent = "—";
    // Tell the orchestrator to forget this tab's session so the NEXT message
    // starts a genuinely fresh agent (no memory of the prior conversation).
    client?.sendFrame?.({ type: "new_session" });
  }

  function loadThread(t) {
    thread = t;
    ssSet(CURRENT_THREAD_KEY, t.id);
    resetFeed();
    for (const m of t.msgs) {
      if (m.role === "user") paintUser(m.text, { attachments: m.attachments });
      else if (m.role === "agent") paintAgent(m.text);
      else if (m.role === "card") paintCard(m);
    }
    renderTodo(t.todos || []); // restore this thread's plan into the tray
    // Resume this conversation's agent session (or start fresh if it has none),
    // so typing continues THIS chat rather than whatever was last active.
    ssSet(SESSION_KEY, t.sessionId || null);
    if (t.sessionId) client?.sendFrame?.({ type: "resume_session", session_id: t.sessionId });
    else client?.sendFrame?.({ type: "new_session" });
  }

  function renderHistory() {
    histPop.textContent = "";
    const list = [...threads].reverse();
    if (!list.length) {
      const none = document.createElement("div");
      none.className = "cmcp-sys";
      none.style.padding = "0.375rem";
      none.textContent = "No past chats yet.";
      histPop.appendChild(none);
      return;
    }
    for (const t of list) {
      const row = document.createElement("div");
      row.className = "cmcp-hist-row";

      const item = document.createElement("button");
      item.type = "button";
      item.className = "cmcp-popover-item cmcp-hist-open";
      const i = document.createElement("i");
      i.className = "pi pi-comment";
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      const firstUser = t.msgs.find((m) => m.role === "user");
      lbl.textContent = (firstUser?.text ?? "(no messages)").slice(0, 48);
      const when = document.createElement("small");
      when.textContent = new Date(t.ts).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      item.append(i, lbl, when);
      item.addEventListener("click", () => {
        histPop.hidden = true;
        loadThread(t);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "cmcp-hist-del";
      del.title = "Delete this chat";
      const di = document.createElement("i");
      di.className = "pi pi-trash";
      del.appendChild(di);
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        threads = threads.filter((x) => x.id !== t.id);
        persistThreads();
        // Deleting the open chat clears the feed and starts fresh.
        if (thread && thread.id === t.id) newChat();
        renderHistory();
      });

      row.append(item, del);
      histPop.appendChild(row);
    }
  }

  newChatBtn.addEventListener("click", () => {
    histPop.hidden = true;
    newChat();
  });
  historyBtn.addEventListener("click", () => {
    if (histPop.hidden) renderHistory();
    histPop.hidden = !histPop.hidden;
  });

  // ---- "working" indicator ----
  // Driven by the turn lifecycle (turn:working / turn:done from the orchestrator,
  // plus the optimistic show on send). It stays up through the WHOLE turn —
  // including silent tool work where nothing posts to the chat — so it never
  // looks idle right before a big reply lands. Whimsical status words cycle so
  // it's clearly alive.
  const WORK_WORDS = [
    "Flibbertigibbeting",
    "Reticulating splines",
    "Percolating",
    "Noodling",
    "Conjuring nodes",
    "Wrangling tensors",
    "Untangling the graph",
    "Spelunking latent space",
    "Frobnicating",
    "Hammering pixels",
    "Consulting the oracle",
    "Herding samplers",
    "Marinating",
    "Tinkering",
    "Vibing",
  ];
  let thinkingEl = null;
  let thinkingLabel = null;
  let workWordTimer = null;
  let workWordIdx = 0;
  let thinkingSafety = null;
  let thinkingTokens = 0;
  // Backstop: if no activity (say/command/turn signal) for this long, auto-hide
  // — covers a missed turn:done (e.g. an older orchestrator, or an errored turn)
  // so the indicator never sticks forever.
  const THINKING_SAFETY_MS = 120000;

  function armSafety() {
    if (thinkingSafety) clearTimeout(thinkingSafety);
    thinkingSafety = setTimeout(hideThinking, THINKING_SAFETY_MS);
  }

  function fmtThinkTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  }
  function cycleWord() {
    if (!thinkingLabel) return;
    const base =
      thinkingTokens > 0
        ? `Thinking… (${fmtThinkTokens(thinkingTokens)} tokens)`
        : `${WORK_WORDS[workWordIdx % WORK_WORDS.length]}…`;
    thinkingLabel.textContent = `${base} (Ctrl+C to stop)`;
    workWordIdx += 1;
  }
  // Live extended-thinking token meter (from the orchestrator's thinking frame).
  function setThinkingTokens(n) {
    thinkingTokens = Number(n) || 0;
    if (!thinkingEl) showThinking();
    cycleWord();
    armSafety();
  }

  function hideThinking() {
    if (workWordTimer) {
      clearInterval(workWordTimer);
      workWordTimer = null;
    }
    if (thinkingSafety) {
      clearTimeout(thinkingSafety);
      thinkingSafety = null;
    }
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
      thinkingLabel = null;
    }
    thinkingTokens = 0; // reset so the next turn doesn't show a stale count
  }

  function showThinking() {
    if (!thinkingEl) {
      clearEmpty();
      thinkingEl = document.createElement("div");
      thinkingEl.className = "cmcp-thinking";
      const dots = document.createElement("span");
      dots.className = "cmcp-thinking-dots";
      for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement("span"));
      thinkingLabel = document.createElement("span");
      thinkingEl.append(dots, thinkingLabel);
      log.appendChild(thinkingEl);
    }
    workWordIdx = 0;
    cycleWord();
    if (!workWordTimer) workWordTimer = setInterval(cycleWord, 2600);
    armSafety();
    scrollLog();
  }

  /** Keep the indicator pinned below the newest message/activity card. */
  function bumpThinking() {
    if (!thinkingEl) return;
    log.appendChild(thinkingEl);
    armSafety();
    scrollLog();
  }

  // ---- auto-fit: after the agent makes structural edits, zoom/center the
  // canvas so the user can watch what's being built (it's usually zoomed in).
  // Debounced so a burst of adds/wires/subgraphs settles into ONE fit, and only
  // for agent-driven structural ops (never the user's own panning/widget tweaks).
  const AUTOFIT_CMDS = new Set([
    "graph_add_node",
    "graph_remove_node",
    "graph_connect",
    "graph_disconnect",
    "graph_create_subgraph",
    "graph_add_subgraph",
    "graph_paste_nodes",
    "graph_enter_subgraph",
    "graph_exit_subgraph",
    "graph_create_group",
    "graph_move_group",
    "graph_remove_group",
  ]);
  let autoFitTimer = null;
  function scheduleAutoFit() {
    if (autoFitTimer) clearTimeout(autoFitTimer);
    autoFitTimer = setTimeout(() => {
      autoFitTimer = null;
      try {
        GRAPH_TOOL_EXECUTORS.graph_canvas({ action: "fit" });
      } catch {
        // empty graph / canvas unavailable — nothing to fit
      }
    }, 700);
  }

  // SDK-provided slash commands (built-ins like /compact, plus any loaded
  // skills), pushed by the orchestrator — surfaced in the completion menu below.
  let sdkCommands = [];

  // Per-turn conversation rewind anchors (assistant UUIDs), in order. A user
  // message records how many anchors existed when it was sent, so a rewind to
  // that message forks the session at turnAnchors[recorded-1]. Reset on new chat.
  let turnAnchors = [];

  // True while a turn is in flight — a message sent now will QUEUE (→ pending
  // tray) rather than start immediately. Drives the tray-vs-inline decision so
  // an idle send doesn't briefly flash through the tray.
  let agentWorking = false;

  // Set by a Settings "Set … token" button just before it asks the agent to open
  // the secure input, so the resolved value can be marked set/not-set (timestamp
  // only) for the Settings indicator. Cleared as soon as the next secret is painted.
  let pendingSecretRequest = null;

  // ---- bridge wiring ----
  // Tear down any client a previous mount left alive BEFORE creating ours, so
  // only one client ever holds this tab's tab_id (see liveBridgeClient note).
  if (liveBridgeClient) {
    try {
      liveBridgeClient.destroy();
    } catch {
      // already gone
    }
    liveBridgeClient = null;
  }
  // Push the live render-stall threshold (panel setting) to the orchestrator over
  // the bridge so a change applies WITHOUT a reconnect. No-op until connected.
  function sendStallConfig() {
    if (!client?.isConnected?.()) return;
    client.sendFrame?.({ type: "set_config", stall_seconds: stallSettingSeconds() });
  }

  const client = createBridgeClient({
    onStatus(state) {
      statusText.textContent = state;
      dot.className = "cmcp-dot" + (state === "connected" ? " connected" : state === "connecting" ? " connecting" : "");
      settingsBox.hidden = state !== "disconnected";
      const connected = state === "connected";
      connectBtn.hidden = connected;
      disconnectBtn.hidden = !connected;
      connectBtn.disabled = state === "connecting";
      connectBtn.textContent = state === "connecting" ? "Connecting…" : "Connect";
      // A successful handshake → restore the auto-reclaim budget, so a LATER wedge
      // (after a healthy session, e.g. the agent dies mid-use) can be auto-cleared
      // again. The bound only prevents a loop WITHIN one unsuccessful connect. Also
      // release the soft-reload interlock: the (possibly slow) reload's orchestrator
      // handshook, so auto-respawn can guard the next drop normally.
      if (connected) {
        resetAutoReclaim();
        clearSoftReloadGuard();
        // Push the current render-stall threshold so a reused/just-connected
        // orchestrator reflects the live setting (the spawn env covers a fresh one).
        sendStallConfig();
      }
      if (!connected) hideThinking();
      // NB: do NOT push set_options here. The saved model id is only known-valid
      // once the live catalog arrives, so the push happens in applyModelCatalog
      // — sending an unvalidated fallback id can wedge the agent on a model the
      // account can't use.
      // (Post-restart resume is handled in onAck on the "ready" ack, which the
      // orchestrator sends only AFTER it has armed hello.resume — so the nudge
      // can't out-race the session resume.)
    },
    onSay(text, meta) {
      // If this reply was streamed, commit it into its live preview bubble (same
      // message id) instead of painting a duplicate. Otherwise paint normally.
      // Either way KEEP the working indicator — the turn isn't over until
      // turn:done (a turn often emits progress text, then works on silently).
      if (!(meta && meta.id && commitStream(meta.id, text))) appendAgent(text);
      bumpThinking();
    },
    // Live streaming deltas (thinking + reply text) before the committed say.
    onStream(msg) {
      onStreamDelta(msg);
    },
    // The agent called panel_ask — render a question card and resolve with the
    // user's pick. Keep the working indicator pinned below it while we wait.
    onAsk(msg) {
      const p = paintQuestion(msg);
      bumpThinking();
      return p;
    },
    // The agent called panel_set_todo — render/update the live plan tray.
    onTodo(items) {
      renderTodo(items);
    },
    // The agent called panel_show_media — render images/videos directly in the chat.
    onShowMedia(items) {
      for (const item of items) {
        const caption = item.caption || item.filename || "";
        if (item.kind === "viewRef" && item.viewRef) {
          const url = imageViewUrl(item.viewRef);
          // Determine if ComfyUI ref is a video by extension
          const isVid = /.(mp4|webm)$/i.test(item.viewRef.filename || "");
          if (isVid) paintVideo(url, caption);
          else paintImage(url, caption);
        } else if (item.kind === "video" && item.dataUrl) {
          paintVideo(item.dataUrl, caption);
        } else if (item.dataUrl) {
          paintImage(item.dataUrl, caption);
        }
      }
    },
    // Orchestrator pushed live download progress → render rows in the tray.
    onDownloads(list) {
      renderDownloads(list);
    },
    // Live extended-thinking token count → update the working indicator.
    onThinking(tokens) {
      setThinkingTokens(tokens);
    },
    // The agent called panel_request_secret — collect a token securely.
    onSecret(msg) {
      const p = paintSecret(msg);
      bumpThinking();
      // If this secure request was kicked off from a Settings "Set … token" button,
      // record a (non-secret) "set at" marker once a non-empty value is submitted so
      // the Settings indicator can show set/not-set. Only the timestamp is stored.
      const req = pendingSecretRequest;
      pendingSecretRequest = null;
      if (req) {
        p.then((value) => {
          if (value) lsSet(SECRET_SET_AT_PREFIX + req.key, String(Date.now()));
        }).catch(() => {});
      }
      return p;
    },
    // The agent called panel_reload — perform the soft reload it asked for.
    onReload(scope) {
      softReload("agent", scope);
    },
    onTurn(state) {
      if (state === "working") {
        agentWorking = true;
        showThinking();
        ssSet(MID_TASK_KEY, "1"); // a turn is in flight — arm the resume nudge
      } else if (state === "done") {
        agentWorking = false;
        hideThinking();
        ssSet(MID_TASK_KEY, null); // turn finished cleanly — nothing to resume
        // Snapshot the graph the agent is leaving behind; the next user turn diffs
        // the live graph against this to surface MANUAL edits made between turns.
        try {
          lastAgentGraph = getGraphCtx().rootGraph.serialize();
        } catch {}
      }
    },
    onLog(text) {
      appendSystem(text);
    },
    onCommand(cmd, msg, reply) {
      appendActivity(cmd, msg, reply);
      bumpThinking();
      // After an edit, follow the action: dart to the edited NODE (25% pad) so
      // the user watches the change land, then zoom back out to a full fit once
      // the burst goes quiet (focusFollowOnCommand handles both). Structural ops
      // with no single node target (subgraph/group/paste) fall back to the plain
      // debounced fit so the view still settles.
      if (reply.ok) {
        const followed = focusFollowOnCommand(cmd, msg, reply);
        if (!followed && AUTOFIT_CMDS.has(cmd)) scheduleAutoFit();
      }
      // The agent restarted ComfyUI — arm the auto-resume so we reconnect and
      // nudge it to continue once ComfyUI is back (install→restart→continue).
      // Gate on the handler actually reporting rebooting:true — a busy-guard
      // refusal or a failed reboot also returns ok:true but rebooting:false, and
      // arming resume in those cases would leave the panel waiting for a restart
      // that never happens.
      if (cmd === "comfy_reboot" && reply.ok && reply.result?.rebooting === true) {
        ssSet(REBOOT_KEY, "1");
        appendSystem("Restarting ComfyUI to load new nodes — I'll reconnect and pick up automatically when it's back.");
      }
    },
    onAgentStatus(s) {
      // Percentage of the context window used (label + ring), persisted so a
      // reload isn't blank. % is what the user wants — not raw token counts.
      if (typeof s.context_pct === "number") {
        setContextPct(s.context_pct);
        ssSet(CTX_KEY, String(s.context_pct));
        if (typeof s.cost_usd === "number") {
          ringTitle.textContent = `Context ~${Math.round(s.context_pct * 100)}% used · $${s.cost_usd.toFixed(3)}`;
        }
      }
      // Keep the chip in sync if the agent reports a concrete model id we know.
      if (typeof s.model === "string" && modelCatalog.some((m) => m.id === s.model)) {
        prefs.model = s.model;
        refreshModelChip();
      }
    },
    onSession(sessionId) {
      bindSession(sessionId);
    },
    onTurnAnchor(uuid) {
      turnAnchors.push(uuid);
      if (turnAnchors.length > 200) turnAnchors.shift();
    },
    // The bridge opened but no orchestrator handshake (models frame) arrived
    // within the generous cold-start window. FIX 4 — first try a BOUNDED fresh
    // re-dial (exactly what Reconnect does) for the common initial-load race where
    // the socket opened before the agent was ready; only escalate to the heavier
    // BOUNDED force-respawn reclaim once that small redial budget is spent. Both are
    // bounded + reset on a successful handshake, so neither can become a storm.
    // Returns true if it handled it (suppresses the manual warning).
    onHandshakeTimeout(timedOutUrl) {
      if (tryHandshakeRedial(timedOutUrl)) return true;
      return tryAutoReclaim(timedOutUrl);
    },
    // WS reconnects keep failing → the bridge port is dead (orchestrator exited,
    // e.g. self-exit after its agent failed). If sticky autoconnect is on, drive a
    // BOUNDED respawn (re-POST /connect) so a fresh orchestrator comes up — instead
    // of retrying a dead port forever (P1). Returns true if it handled it.
    onBridgeClosed() {
      return tryAutoRespawn();
    },
    onModels(list, _current, backend) {
      // The orchestrator self-reports its backend on the handshake — this is the
      // AUTHORITATIVE source of which provider we're actually connected to. Resolve
      // the switch BEFORE applying the catalog, so the effort scale + nearest-level
      // mapping in applyModelCatalog uses the NEW backend's scale (fix #5).
      const known = typeof backend === "string" && BACKEND_LABELS[backend];
      if (known) {
        // A real provider switch = the connected backend changed AND we were
        // already connected to something (not the first connect, not a re-pick).
        const switched = connectedBackend !== null && connectedBackend !== backend;
        if (switched) {
          appendSystem(
            `Switched to ${BACKEND_LABELS[backend]} — sessions aren't shared across providers, so this starts a fresh chat.`,
          );
        }
        selectedBackend = backend;
        connectedBackend = backend; // authoritative: update from the handshake (fix #4)
        setAskPlaceholder(backend); // authoritative placeholder per backend (fix #3)
        try {
          window.localStorage.setItem(STORAGE_KEY_BACKEND, backend);
        } catch {
          /* non-persistent is fine */
        }
        renderBackendChips(
          Array.from(backendChips.querySelectorAll(".cmcp-backend-chip")).map((el) => ({
            backend: el.dataset.backend,
            running: el.title === "Running",
          })),
        );
      }
      // Apply the catalog AFTER the backend is known so effort mapping is correct.
      applyModelCatalog(list);
    },
    onCommands(list) {
      // SDK-provided slash commands → surface in the composer completion menu.
      sdkCommands = Array.isArray(list) ? list : [];
    },
    onAck(ack) {
      // Receipt: orchestrator got it (not dropped) → cancel the failure timer.
      // The bubble stays QUEUED (muted) until the agent actually reads it.
      if (ack?.kind === "working" && typeof ack.mid === "string") {
        markReceived(ack.mid);
        return;
      }
      // Read: the agent dequeued this message → flip its bubble to read (normal).
      if (ack?.kind === "seen" && typeof ack.mid === "string") {
        markRead(ack.mid);
        return;
      }
      // Effort change while the agent was mid-turn: it can't change a running
      // turn's effort, so it applies once the current turn finishes (no more
      // killing the in-flight reply). Let the user know so the picker selection
      // not taking effect *this* turn isn't a mystery.
      if (ack?.kind === "options" && ack.deferred) {
        appendSystem(`Effort → ${ack.effort ?? "default"} — applies after the current turn finishes.`);
        return;
      }
      // Post-restart auto-resume (#3): the "ready" ack is sent after the
      // orchestrator armed hello.resume, so resuming the agent is safe now.
      // Clear REBOOT_KEY only here (on actual send) so a drop mid-reconnect
      // retries instead of losing the resume.
      if (ack?.kind === "ready" && ssGet(REBOOT_KEY)) {
        ssSet(REBOOT_KEY, null);
        appendSystem("Reconnected — resuming where we left off.");
        showThinking();
        client.sendUserMessage(
          "✅ ComfyUI just restarted to load newly-installed custom nodes (now available). Continue what you were doing before the restart — if you were mid-build, pick it back up.",
        );
        return;
      }
      // Soft-reload resume: the fresh orchestrator is up. Resume silently for a
      // user-triggered reload; nudge to continue for an agent-triggered one
      // (it was mid-task and its tool call died with the old process).
      if (ack?.kind === "ready" && ssGet(SOFT_RELOAD_KEY)) {
        const origin = ssGet(SOFT_RELOAD_KEY);
        ssSet(SOFT_RELOAD_KEY, null);
        ssSet(MID_TASK_KEY, null); // deliberate reload — don't also fire the drop nudge
        appendSystem("Agent reloaded — session resumed.");
        if (origin === "agent") {
          showThinking();
          client.sendUserMessage(
            "✅ You were just soft-reloaded to pick up code changes (no ComfyUI restart) — your tools and system prompt are now the latest build. Continue exactly what you were doing before the reload.",
          );
        }
        return;
      }
      // Unexpected bounce while mid-task — a DIFFERENT agent restarting ComfyUI
      // (to load nodes), a crash, or an SDK self-heal. The session resumed with
      // full context but has no pending turn, so it would sit idle. Nudge it.
      if (ack?.kind === "ready" && ssGet(MID_TASK_KEY)) {
        ssSet(MID_TASK_KEY, null);
        // Only nudge for a REAL restart. A fast reconnect (a panel remount from a
        // sidebar swap, or a brief WS blip) means the orchestrator never died —
        // the agent's turn kept running — so a "you dropped" nudge is false AND
        // would inject a spurious turn into a live session. A real ComfyUI restart
        // takes many seconds to come back, so a long gap since the drop = real.
        if (Date.now() - lastBridgeDownAt < 6000) return;
        appendSystem("Reconnected — picking up where we left off.");
        showThinking();
        client.sendUserMessage(
          "✅ Your connection dropped mid-task (e.g. ComfyUI was restarted, possibly by another agent installing nodes). The session resumed with full context — continue exactly what you were doing before the drop; if you were mid-build or mid-edit, pick it right back up.",
        );
      }
    },
    getResume: () => ssGet(SESSION_KEY),
  });
  // This is now THE live client for the page.
  liveBridgeClient = client;

  // ---- ComfyUI execution events → image cards + agent awareness (#7) ----
  // When a run finishes with output images, show them in the chat and notify
  // the agent so it knows its render landed (the orchestrator drops the event
  // if no session is attending). On error, notify the agent to diagnose.
  // Upload a Blob into ComfyUI's input/ folder via the SAME endpoint chat
  // attachments use (/upload/image writes any blob verbatim) → returns an
  // ImageRef ({filename, subfolder, type:"input"}) the vision path can resolve,
  // or null on failure. Mirrors handleImageFile's upload.
  async function uploadBlobToInput(blob, name) {
    try {
      const fd = new FormData();
      fd.append("image", blob, name);
      const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
      if (res.status !== 200) return null;
      const info = await res.json();
      return { filename: info.name, subfolder: info.subfolder || undefined, type: info.type || "input" };
    } catch {
      return null;
    }
  }

  // VIDEO-VISION: a video output just landed and was painted as a <video> for the
  // user — but the agent can't see video bytes. Sample frames → contact sheet PNG
  // → upload to input/ → deliver THAT as an inline image (own executed event), and
  // paint it as a card so the user sees it too. Fully non-blocking + best-effort:
  // any failure just logs and leaves the video player as-is (no agent image).
  async function deliverVideoStoryboard(m, nodeId, promptId) {
    // Same final-vs-preview distinction as still images: a VHS-style video node
    // with `type:"output"` is the real SAVED file; `type:"temp"` (save_output off)
    // is a throwaway preview. Be conservative — only explicit "output" is final.
    const isFinalVideo = m && m.type === "output";
    const videoKind = isFinalVideo
      ? `the FINAL saved video (file ${m.filename} — reference THIS filename)`
      : `a PREVIEW video (file ${m.filename}, temporary — not a saved file; add/enable a save to persist it)`;
    // ── Video metadata (gathered up front) ─────────────────────────────────
    // path (subfolder-relative), real frame metadata when the VHS/video output
    // payload carries it, render duration, and completion time. Capture the
    // render-start SYNCHRONOUSLY here (before any await / before the run's flush
    // retires it) so the duration survives a concurrent execution_success.
    const subfolder = m?.subfolder || "";
    const path = subfolder ? `${subfolder}/${m?.filename || ""}` : (m?.filename || "");
    const startTs = runStartTimes.get(promptKey(promptId));
    const duration = startTs != null ? formatDuration(Date.now() - startTs) : null;
    const finishedClock = formatClock(new Date());
    // Real per-video frame metadata, when present on the descriptor (VHS-style
    // video/gif outputs may include frame_count / frame_rate / format). Omit if
    // the payload doesn't carry it (it's not always populated).
    const realFrames = m?.frame_count ?? m?.frameCount ?? m?.frames ?? null;
    const realFps = m?.frame_rate ?? m?.frameRate ?? m?.fps ?? null;
    const format = m?.format || null;
    // Compose the compact "· a · b · c" metadata suffix appended to a note.
    // sizeStr (async HEAD) and storyboardN are optional/contextual.
    const metaSuffix = (sizeStr, storyboardN) => {
      const parts = [`path: ${path}`];
      if (format) parts.push(String(format));
      if (Number.isFinite(realFrames)) {
        parts.push(
          `${realFrames} frames` +
            (Number.isFinite(realFps) ? ` @ ${realFps} fps` : ""),
        );
      } else if (storyboardN) {
        parts.push(`${storyboardN}-frame storyboard`);
      }
      if (sizeStr) parts.push(sizeStr);
      if (duration) parts.push(`rendered in ${duration}`);
      if (finishedClock) parts.push(`finished ${finishedClock}`);
      return parts.length ? `\n• ${m?.filename || "video"} — ${parts.join(" · ")}` : "";
    };
    // ALWAYS notify the agent a video rendered — with a storyboard if we can build
    // one, else a note-only event (no images) so the agent still learns the render
    // landed even when the preview is off or sampling/upload fails.
    const noteOnly = (why) =>
      client.sendFrame({
        type: "agent_event",
        kind: "executed",
        note:
          `🎬 A video rendered — ${videoKind}. You can't view it directly` +
          (why ? ` — ${why}` : "") +
          `; tell the user it's ready and ask how it looks if you need to judge it.` +
          metaSuffix(null, null),
        node_id: nodeId,
      });
    if (prefs.videoStoryboard === false) {
      noteOnly("storyboard preview is turned off in panel settings");
      return;
    }
    try {
      const blob = await buildVideoStoryboard(imageViewUrl(m));
      if (!blob) {
        console.warn("[cmcp] storyboard: could not sample frames from", m.filename);
        noteOnly("couldn't sample a storyboard from it");
        return;
      }
      const base = String(m.filename || "video").replace(/\.[^.]+$/, "");
      const ref = await uploadBlobToInput(blob, `storyboard_${base}.png`);
      if (!ref) {
        console.warn("[cmcp] storyboard: upload failed for", m.filename);
        noteOnly("couldn't upload its storyboard");
        return;
      }
      const n = storyboardFrameCount();
      // Best-effort file size of the SOURCE video via HEAD (resilient — null on
      // any failure, never blocks the storyboard delivery).
      const sizeStr = humanizeBytes(await fetchImageBytes(imageViewUrl(m)));
      // Show the user the contact sheet next to the <video> player.
      paintImage(imageViewUrl(ref), `Storyboard · ${n} frames`);
      // Deliver the storyboard to BOTH backends via the existing inline-vision
      // path: the ImageRef rides in the executed event's `images`; the `note`
      // tells the agent what it's looking at. Do NOT include the raw video ref.
      client.sendFrame({
        type: "agent_event",
        kind: "executed",
        images: [ref],
        note:
          `📽️ ${n}-frame storyboard (contact sheet) of ${videoKind} — ` +
          `frames run top-left→bottom-right = start→end. ` +
          `Review motion, sharpness, and temporal consistency.` +
          metaSuffix(sizeStr, n),
        node_id: nodeId,
      });
    } catch (err) {
      console.warn("[cmcp] storyboard pipeline failed:", err);
      noteOnly("its storyboard preview failed to build");
    }
  }

  // ── Per-run image batching ────────────────────────────────────────────────
  // ComfyUI fires `executed` once PER output node, so a multi-output run used to
  // inject several fragmented image turns into the agent. Instead we BUFFER each
  // run's inline image refs by prompt_id as `executed` events arrive (still
  // painting every image live for the user), then deliver ONE consolidated
  // `executed` agent_event when that prompt finishes (`execution_success`, or the
  // legacy `executing` with node===null). A short debounce flushes a buffer that
  // never sees a run-end signal so images are never stranded.
  const runImageBuffers = new Map(); // promptId -> { images: ImageRef[], timer }
  const RUN_FLUSH_DEBOUNCE_MS = 1500;
  const promptKey = (id) => id ?? "__no_prompt__";

  // Render-duration tracking: promptKey -> start Date.now(). The primary start
  // signal is ComfyUI's `execution_start` (carries prompt_id) — recorded the
  // instant a run begins. Fallbacks (first `executing`/`executed` for that
  // prompt) fill in if execution_start is missed, so we never invent a bogus
  // start. duration = finish - start is computed at flush; the entry is cleaned
  // up on flush / execution_success / clear. Clock-consistent: BOTH ends use the
  // client's Date.now(), so a server/client clock skew can't distort it.
  const runStartTimes = new Map();
  function markRunStart(promptId) {
    const key = promptKey(promptId);
    // First signal wins — don't let a later per-node event reset an earlier start.
    if (!runStartTimes.has(key)) runStartTimes.set(key, Date.now());
    // Safety cap: runs are sequential, but if a run starts and never produces a
    // run-end signal the entry would linger — bound the map so it can't grow.
    if (runStartTimes.size > 20) {
      const oldest = runStartTimes.keys().next().value;
      if (oldest !== key) runStartTimes.delete(oldest);
    }
  }

  function bufferRunImages(promptId, images) {
    if (!images.length) return;
    // Fallback render-start: if execution_start was missed, anchor the timer at
    // the first output we see for this run (no-op if a start is already recorded).
    markRunStart(promptId);
    const key = promptKey(promptId);
    let buf = runImageBuffers.get(key);
    if (!buf) {
      buf = { images: [], timer: null };
      runImageBuffers.set(key, buf);
    }
    buf.images.push(...images);
    // Debounce fallback: if no run-end signal lands, flush anyway after a beat.
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => flushRunImages(key), RUN_FLUSH_DEBOUNCE_MS);
  }

  async function flushRunImages(promptId) {
    const key = promptKey(promptId);
    const buf = runImageBuffers.get(key);
    if (!buf) return;
    if (buf.timer) clearTimeout(buf.timer);
    runImageBuffers.delete(key);
    // Render duration: read + retire the start time NOW (synchronously, before any
    // await) so a concurrent flush can't double-count it. null start ⇒ omit.
    const startTs = runStartTimes.get(key);
    runStartTimes.delete(key);
    const durationMs = startTs != null ? Date.now() - startTs : null;
    const duration = formatDuration(durationMs);
    const finishedAt = new Date();
    const finishedClock = formatClock(finishedAt);
    if (!buf.images.length) return;
    // Classify by ComfyUI's output type: SaveImage writes `type:"output"` with a
    // real filename = the FINAL saved result; PreviewImage writes `type:"temp"`
    // (under a temp/ subfolder, throwaway /tmp-style names) = a preview frame.
    // Be conservative: ONLY an explicit `type === "output"` counts as final, so a
    // missing/unknown type defaults to preview and we never mislabel a throwaway
    // frame as the saved result. Don't crash on odd shapes.
    const finals = [];
    const previews = [];
    for (const m of buf.images) {
      if (m && m.type === "output") finals.push(m);
      else previews.push(m);
    }
    // Send EVERYTHING for vision (the agent should see previews too), but ordered
    // finals-first so the primary result is unambiguous as image #1.
    const images = [...finals, ...previews];
    const finalNames = finals.map((m) => m?.filename).filter(Boolean);
    const previewCount = previews.length;
    let note;
    if (finalNames.length) {
      const list = finalNames.join(", ");
      const fileWord = finalNames.length === 1 ? "output" : "outputs";
      note =
        `Run finished. FINAL ${fileWord}: ${list} ` +
        `(this is the saved result — reference THIS filename` +
        (finalNames.length === 1 ? "" : "s") +
        `).`;
      if (previewCount) {
        const frameWord = previewCount === 1 ? "preview frame" : "preview frames";
        note += ` Also shown: ${previewCount} ${frameWord} (temporary, not the final file).`;
      }
    } else {
      // No SaveImage (or equivalent output node) ran — everything we have is a
      // throwaway preview. Tell the agent so it doesn't cite a /tmp name as final.
      const previewClause =
        previewCount === 1
          ? `this image is a preview (temporary, not a final file)`
          : `these ${previewCount} images are previews (temporary, not a final file)`;
      note =
        `Run finished, but no saved output node ran — ${previewClause}. ` +
        `Add a SaveImage node to persist the result, or treat the preview as the result if that's intended.`;
    }
    // ── Rich per-output metadata ───────────────────────────────────────────
    // Gather metadata for the FINAL outputs (size + dimensions fetched in
    // PARALLEL and bounded via allSettled, so a single failed HEAD/decode never
    // drops the agent_event). Weave a compact human-readable block into the note
    // (the agent reads TEXT) AND attach a structured `metadata` array for future
    // programmatic use. Every field is individually optional — omitted when
    // unavailable rather than shown as a bogus value.
    const total = finals.length;
    const finalNameSet = finalNames; // sibling list source (asset set)
    let metadata = [];
    try {
      metadata = await Promise.all(
        finals.map(async (m, idx) => {
          const filename = m?.filename || "(unknown)";
          const subfolder = m?.subfolder || "";
          const path = subfolder ? `${subfolder}/${filename}` : filename;
          const url = imageViewUrl(m);
          const [sizeRes, dimRes] = await Promise.allSettled([
            fetchImageBytes(url),
            fetchImageDimensions(url),
          ]);
          const sizeBytes =
            sizeRes.status === "fulfilled" ? sizeRes.value : null;
          const dim = dimRes.status === "fulfilled" ? dimRes.value : null;
          const siblings = finalNameSet.filter((n) => n !== filename);
          return {
            filename,
            path,
            subfolder,
            sizeBytes,
            size: humanizeBytes(sizeBytes),
            width: dim?.w ?? null,
            height: dim?.h ?? null,
            dimensions: dim ? `${dim.w}×${dim.h}` : null,
            index: idx + 1,
            total,
            siblings,
            durationMs,
            duration,
            finishedAt: finishedAt.toISOString(),
            finishedClock,
          };
        }),
      );
    } catch {
      // Defensive: metadata gathering must never block the agent_event.
      metadata = [];
    }
    // Append the readable metadata block (one bullet per final output).
    if (metadata.length) {
      const lines = metadata.map((meta) => {
        const parts = [`path: ${meta.path}`];
        if (meta.size) parts.push(meta.size);
        if (meta.dimensions) parts.push(meta.dimensions);
        // asset set (same-run grouping)
        parts.push(
          meta.total === 1
            ? "single output"
            : `output ${meta.index} of ${meta.total} from this run`,
        );
        if (meta.siblings.length) {
          parts.push(`alongside: ${meta.siblings.join(", ")}`);
        }
        if (meta.duration) parts.push(`rendered in ${meta.duration}`);
        if (meta.finishedClock) parts.push(`finished ${meta.finishedClock}`);
        return `• ${meta.filename} — ${parts.join(" · ")}`;
      });
      note += `\n${lines.join("\n")}`;
    } else if (duration || finishedClock) {
      // Preview-only run (no finals to attach metadata to) — still surface the
      // run-level render context if we have it.
      const bits = [];
      if (duration) bits.push(`rendered in ${duration}`);
      if (finishedClock) bits.push(`finished ${finishedClock}`);
      if (bits.length) note += `\n• ${bits.join(" · ")}`;
    }
    // One consolidated turn with ALL of the run's directly-viewable images,
    // finals-first, plus a note naming which file(s) are the real saved output
    // and the structured metadata array (one entry per final output).
    client.sendFrame({
      type: "agent_event",
      kind: "executed",
      images,
      note,
      metadata,
    });
  }

  function clearRunImages(promptId) {
    const key = promptKey(promptId);
    const buf = runImageBuffers.get(key);
    if (buf?.timer) clearTimeout(buf.timer);
    runImageBuffers.delete(key);
    runStartTimes.delete(key);
  }

  function flushAllRunImages() {
    for (const key of [...runImageBuffers.keys()]) flushRunImages(key);
  }

  function onExecuted(ev) {
    const d = ev?.detail ?? {};
    const out = d.output || {};
    // ComfyUI groups a node's outputs by kind: `images`, plus `gifs`/`videos` for
    // VHS-style video nodes (e.g. LTX → VHS_VideoCombine). Render each by type so a
    // video isn't shown as a broken <img>.
    const media = [...(out.images || []), ...(out.gifs || []), ...(out.videos || [])];
    if (!media.length) return;
    const nodeId = d.node ?? d.display_node ?? null;
    // Viewable images (incl. animated gifs) go inline to the agent as-is. Video
    // refs are EXCLUDED here — the agent can't decode them — and instead get a
    // storyboard delivered asynchronously below.
    const inlineImages = [];
    const videos = [];
    for (const m of media) {
      if (!m || !m.filename) continue;
      const url = imageViewUrl(m);
      if (isVideoOutput(m)) {
        paintVideo(url, m.filename);
        videos.push(m);
      } else {
        paintImage(url, m.filename);
        inlineImages.push(m);
      }
    }
    // Buffer the directly-viewable images for THIS run instead of sending a turn
    // per node — they're flushed as one consolidated `executed` event when the
    // prompt finishes (see flushRunImages). The image already painted above, so
    // the user still sees it live; only the agent delivery is deferred+grouped.
    if (inlineImages.length) {
      bufferRunImages(d.prompt_id, inlineImages);
    } else if (!videos.length) {
      // No viewable images and no videos (shouldn't happen given the guard above).
      return;
    }
    // Kick off a storyboard per video — non-blocking; onExecuted has already sent
    // its event and painted everything. Each storyboard delivers its own event.
    for (const m of videos) deliverVideoStoryboard(m, nodeId, d.prompt_id);
  }
  function onExecError(ev) {
    const d = ev?.detail ?? {};
    // The run failed — drop any images we'd buffered for it so we don't deliver a
    // stale "here are your outputs" batch on top of the run_error interrupt below.
    clearRunImages(d.prompt_id);
    // Name the failing node so the agent (and the user) know WHERE it broke —
    // "Ideogram4PromptBuilderKJ (node 200)" beats a bare exception string.
    const where = d.node_type
      ? `${d.node_type} (node ${d.node_id})`
      : d.node_id != null
        ? `node ${d.node_id}`
        : "";
    const msg = d.exception_message || d.exception_type || "execution error";
    const error = where ? `${where}: ${msg}` : msg;
    // 1) Push it to the agent — the orchestrator INTERRUPTS its live turn and
    //    front-queues this so it stops and fixes the error instead of running blind.
    client.sendFrame({ type: "agent_event", kind: "run_error", error });
    // 2) Render it immediately as an error widget in the chat, so the user sees it
    //    even before the agent reacts (no waiting on a check-errors call).
    paintCard({
      icon: "pi-exclamation-triangle",
      text: `Run error — ${where || "execution failed"}`,
      detail: msg,
      error: true,
    });
  }
  // Run-end signal: ComfyUI emits `execution_success` (carrying prompt_id) when a
  // prompt fully completes — flush THAT run's buffered images as one turn.
  function onExecutionSuccess(ev) {
    const id = ev?.detail?.prompt_id;
    flushRunImages(id);
    // Retire the render-start for runs that produced NO buffered inline images
    // (e.g. video-only runs) — flushRunImages early-returns for those and leaves
    // the start entry behind. The video storyboard already captured its duration
    // synchronously, so deleting here is safe.
    runStartTimes.delete(promptKey(id));
  }
  // Primary render-duration start signal: ComfyUI emits `execution_start` with the
  // prompt_id the instant a run begins — anchor the duration timer there.
  function onExecutionStart(ev) {
    markRunStart(ev?.detail?.prompt_id);
  }
  // Legacy/secondary run-end: `executing` fires with the current node id, or null
  // when nothing is left to run. The null event carries no prompt_id, so flush any
  // remaining buffers (runs are sequential — nothing is executing now).
  function onExecuting(ev) {
    if (ev?.detail == null) {
      flushAllRunImages();
      return;
    }
    // Fallback render-start: the first per-node `executing` for a prompt anchors
    // the timer if execution_start was missed (no-op if already recorded).
    if (ev?.detail?.prompt_id != null) markRunStart(ev.detail.prompt_id);
  }
  // Post-restart autonomy (#3): ComfyUI's api fires `reconnecting` when the
  // server goes down (e.g. a Manager reboot) and `reconnected` when it's back.
  // After a reboot we triggered, respawn the orchestrator (it died with ComfyUI)
  // so the bridge can reconnect; onStatus(connected) then resumes the agent.
  function onComfyReconnecting() {
    // Only flag a restart if our bridge actually went down — a benign ComfyUI WS
    // blip (asset view / image check) shouldn't print a false "restarting" alarm.
    if ((ssGet(REBOOT_KEY) || lsGet(AUTOCONNECT_KEY)) && !client.isConnected()) {
      appendSystem("ComfyUI is restarting…");
    }
  }
  function onComfyReconnected() {
    // After ComfyUI comes back (backend-only reboot — the page didn't reload),
    // the orchestrator died with it. Respawn + reconnect if the agent was in use:
    // either a restart WE triggered (REBOOT_KEY) or sticky auto-connect.
    if (!ssGet(REBOOT_KEY) && !lsGet(AUTOCONNECT_KEY)) return;
    // ComfyUI fires "reconnected" for BENIGN WS blips too — viewing assets,
    // checking an image's status, a tab refocus — and those do NOT kill the
    // orchestrator. If OUR bridge is still up, the agent is alive and well, so
    // do NOT bounce a live session (that was the spurious "you reconnected"). A
    // real ComfyUI restart drops the bridge (the orchestrator dies with it, and
    // the bridge's own retry can't respawn it) — only then do we respawn here.
    if (client.isConnected()) return;
    appendSystem("ComfyUI is back — reconnecting the agent…");
    connectAgent();
  }
  try {
    api.addEventListener("executed", onExecuted);
    api.addEventListener("execution_success", onExecutionSuccess);
    api.addEventListener("execution_start", onExecutionStart);
    api.addEventListener("executing", onExecuting);
    api.addEventListener("execution_error", onExecError);
    api.addEventListener("reconnecting", onComfyReconnecting);
    api.addEventListener("reconnected", onComfyReconnected);
  } catch {
    // api unavailable — execution surfacing disabled
  }

  saveBtn.addEventListener("click", () => {
    client.setUrl(urlInput.value.trim());
    appendSystem(`Reconnecting to ${client.currentUrl()}…`);
  });

  // Connect: ask ComfyUI's server to start the background agent on demand, then
  // open the bridge. The orchestrator is only ever spawned by this click — or by
  // the post-restart auto-resume. In-flight guard so the multiple callers
  // (button, reconnected event, mount auto-resume) can't double-spawn.
  let connecting = false;
  // Monotonic connect generation: each connectAgent() bumps it and remembers its
  // own value; a later attempt (e.g. a chip switch) supersedes an in-flight one, so
  // when the stale POST finally returns it must NOT touch the client (apply a
  // bridge_url / setUrl / start) — otherwise it could reconnect the PREVIOUS provider
  // after the user already picked a new one. Only the newest generation wins.
  let connectGen = 0;
  // The last ws URL the picker auto-applied (from /connect's bridge_url). Lets us
  // tell a MANUAL Advanced-URL override apart from an auto-managed one, so a user
  // who typed their own bridge URL isn't silently overwritten by the backend's port.
  let lastAutoUrl = "";
  // Bounded auto-reclaim of a WEDGED orchestrator (bridge open, agent never
  // handshook). Each user-initiated connectAgent() resets the budget; the
  // handshake-timeout handler spends it (force-respawn + reconnect). Once the
  // budget is exhausted we stop and let the manual warning show — so a genuinely
  // unrecoverable port (a foreign squatter the pack refuses to kill, or a backend
  // that can't sign in) can NEVER drive an infinite respawn loop.
  const MAX_AUTO_RECLAIMS = 2;
  let autoReclaimsLeft = MAX_AUTO_RECLAIMS;
  let autoReclaiming = false;
  // SEPARATE budget for close-driven RESPAWN (P1): when the bridge dies (e.g. the
  // orchestrator self-exited because its agent failed) the WS retries a dead port
  // forever unless we re-POST /connect to spawn a fresh orchestrator. CRITICAL:
  // this budget is NOT replenished on an automatic bridge-close — only by a
  // successful handshake or a user-initiated Connect (resetAutoReclaim) — so a
  // persistent failure (respawn → agent fails → self-exit → respawn …) is BOUNDED
  // and terminates with the manual warning, never a hot loop.
  const MAX_AUTO_RESPAWNS = 2;
  let autoRespawnsLeft = MAX_AUTO_RESPAWNS;
  let autoRespawning = false;
  let respawnGaveUpNoticed = false; // one-shot "keeps failing" notice per budget
  // FIX 4 — bounded FRESH RE-DIAL budget for the INITIAL-LOAD race: on auto-connect
  // the WS can open BEFORE the agent finishes spawning, so the orchestrator never
  // sends `models` on THAT socket and the panel sits "connecting" forever. A manual
  // Reconnect (a fresh hello on a brand-new socket) recovers it — so on a handshake
  // timeout we first re-dial automatically (close+reopen, exactly what Reconnect
  // does), and only escalate to the heavier force-respawn reclaim once this small
  // budget is spent. STRICTLY BOUNDED + reset by resetAutoReclaim (every user/sticky
  // Connect AND every successful handshake), so it can NEVER become a redial storm.
  const MAX_HANDSHAKE_REDIALS = 2;
  let handshakeRedialsLeft = MAX_HANDSHAKE_REDIALS;
  function resetAutoReclaim() {
    autoReclaimsLeft = MAX_AUTO_RECLAIMS;
    autoRespawnsLeft = MAX_AUTO_RESPAWNS;
    respawnGaveUpNoticed = false;
    handshakeRedialsLeft = MAX_HANDSHAKE_REDIALS;
  }

  // SOFT-RELOAD ↔ AUTO-RESPAWN interlock. A deliberate softReload(orchestrator)
  // OWNS the respawn: it client.stop() → POST /reload → client.start(), then
  // reconnects with backoff (up to RECONNECT_MAX_MS=15s) to the respawning
  // orchestrator. WITHOUT this guard, if the fresh orchestrator's cold start
  // (node spawn + env-capabilities probe) outlasts ~2 reconnect backoffs (~6s),
  // scheduleReconnect's escalation would fire tryAutoRespawn → a COMPETING POST
  // /connect, so two respawns race and reclaim/kill each other's orchestrator and
  // the handshake never settles ("soft reload never works"). While this flag is
  // set, tryAutoRespawn STANDS DOWN (returns false) so scheduleReconnect keeps
  // doing bare WS retries — the soft-reload's own backoff reaches the new
  // orchestrator uncontested. The flag is cleared on a successful handshake
  // (onStatus "connected"), on a fresh user/sticky Connect, on a soft-reload that
  // fails to even POST, and — as a safety net — after a generous timeout, so a
  // soft-reload whose orchestrator NEVER comes up eventually re-enables the normal
  // auto-respawn recovery instead of disabling it forever.
  // > RECONNECT_MAX_MS (15s) so the soft-reload's own backoff gets a full shot
  // before auto-respawn is re-armed. BACKEND-AWARE: the guard must outlast the
  // backend's handshake window (handshakeMs()) so a healthy slow reload completes
  // on its own backoff before the guard releases — Codex's app-server handshake is
  // 45s, so its guard is ~50s; Claude keeps 28s (still > its 20s handshake).
  const SOFT_RELOAD_GUARD_MS_BY_BACKEND = { codex: 50000, gemini: 50000, claude: 28000 };
  function softReloadGuardMs() {
    return SOFT_RELOAD_GUARD_MS_BY_BACKEND[selectedBackend] ?? 28000;
  }
  // One-shot escalation window for a STUCK soft-reload. The guard above stops
  // a competing-respawn storm, but it leaves a gap: when the fresh orchestrator binds
  // the port yet its AGENT handshake (the `models` frame → "connected") never lands,
  // the WS is OPEN — so there's no close event to drive scheduleReconnect, and
  // tryAutoRespawn is standing down for the guard window. The panel then sits in the
  // "Connected … waiting for the panel agent" stuck state until the user manually
  // clicks Reconnect. So: if the handshake hasn't landed within this window,
  // AUTO-ESCALATE once to exactly what Reconnect does — a single clean
  // connectAgent(). One-shot (never a loop) so it can't reintroduce the storm the
  // interlock prevents. BACKEND-AWARE: the escalation must sit BEYOND the backend's
  // normal cold-start handshake (handshakeMs()) so a healthy-but-slow reload is
  // never pre-empted — Codex (45s handshake) escalates at ~40s, comfortably under
  // its ~50s guard; Claude keeps 11s (under its 28s guard and > its 20s handshake).
  const SOFT_RELOAD_ESCALATE_MS_BY_BACKEND = { codex: 40000, gemini: 40000, claude: 11000 };
  function softReloadEscalateMs() {
    return SOFT_RELOAD_ESCALATE_MS_BY_BACKEND[selectedBackend] ?? 11000;
  }
  let softReloadInFlight = false;
  let softReloadGuardTimer = null;
  let softReloadEscalateTimer = null;
  function setSoftReloadGuard() {
    softReloadInFlight = true;
    if (softReloadGuardTimer) clearTimeout(softReloadGuardTimer);
    softReloadGuardTimer = setTimeout(() => {
      softReloadGuardTimer = null;
      softReloadInFlight = false; // safety: a failed soft-reload re-enables auto-respawn
    }, softReloadGuardMs());
    // Arm the stuck-handshake escalation. A FAST soft-reload handshakes well before
    // this fires and clearSoftReloadGuard() (on "connected") cancels it → no
    // escalation. Only a genuinely stuck reload reaches the timer.
    if (softReloadEscalateTimer) clearTimeout(softReloadEscalateTimer);
    softReloadEscalateTimer = setTimeout(() => {
      softReloadEscalateTimer = null;
      escalateSoftReload();
    }, softReloadEscalateMs());
  }
  function clearSoftReloadGuard() {
    softReloadInFlight = false;
    if (softReloadGuardTimer) {
      clearTimeout(softReloadGuardTimer);
      softReloadGuardTimer = null;
    }
    if (softReloadEscalateTimer) {
      clearTimeout(softReloadEscalateTimer);
      softReloadEscalateTimer = null;
    }
  }
  // The soft-reload's WS is open (or reconnecting) but the agent handshake hasn't
  // landed within the short window — the "connected … waiting for the panel agent"
  // stuck state. Escalate ONCE to exactly what the user's manual Reconnect does:
  // drop the stale (open-but-unhandshook) socket — necessary because connect()
  // early-returns on an already-OPEN socket, so a bare connectAgent()/client.start()
  // alone would NOT replace it — then run a single clean connectAgent(). connectAgent
  // bumps connectGen (superseding the soft-reload's own pending reconnect so the two
  // never both drive the client), resets the reclaim/respawn budgets and clears this
  // guard, so its own connectGen/budget logic owns recovery from here. One-shot
  // timer: it can't loop, so no competing-respawn storm.
  function escalateSoftReload() {
    if (!softReloadInFlight) return; // handshake already landed / guard cleared → nothing to do
    appendSystem("The agent reload is taking too long to hand off — reconnecting cleanly…");
    client.stop(); // drop the stuck socket so connect() won't early-return on an OPEN sock
    connecting = false; // don't let a stale in-flight guard block the escalation connect
    void connectAgent();
  }
  // The bridge died and WS reconnects keep failing → the port is dead (the
  // orchestrator exited). If sticky autoconnect is on, spend the bounded respawn
  // budget to re-POST /connect (spawn a FRESH orchestrator) and reconnect. Returns
  // true if it drove a respawn (the caller then skips its bare WS retry), false to
  // let the WS keep retrying / fall back to the manual warning.
  function tryAutoRespawn() {
    if (!lsGet(AUTOCONNECT_KEY)) return false; // user never connected / disconnected
    // A deliberate soft-reload owns the respawn — DON'T compete. Return false so
    // scheduleReconnect keeps doing bare WS retries (the soft-reload's own backoff
    // reaches the new orchestrator); the guard is time-bounded so a stuck reload
    // eventually re-enables this path.
    if (softReloadInFlight) return false;
    if (autoRespawning) return true; // one in flight — don't stack
    if (autoRespawnsLeft <= 0) {
      // Budget spent → stop respawning and tell the user once, then let the bare
      // WS retry continue quietly in the background (cheap; no more spawns).
      if (!respawnGaveUpNoticed) {
        respawnGaveUpNoticed = true;
        appendSystem(
          "⚠ The panel agent keeps failing to start. Check you're signed in " +
            "(run `claude` once, `codex login` for Codex, or `gemini` for Gemini), then click Connect.",
        );
      }
      return false;
    }
    autoRespawnsLeft -= 1;
    autoRespawning = true;
    appendSystem("The panel agent dropped — restarting it…");
    const myGen = connectGen;
    void (async () => {
      try {
        const res = await api.fetchApi("/comfyui_mcp_panel/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ backend: selectedBackend, stall_seconds: stallSettingSeconds(), comfyui_url: remoteUrlSetting() }),
        });
        const data = await res.json().catch(() => ({}));
        if (myGen !== connectGen) return; // a newer user connect took over
        if (!data?.ok) {
          if (data?.message) appendSystem(data.message);
          autoRespawnsLeft = 0; // can't spawn (e.g. not signed in) → stop looping
          client.start(); // resume the bare WS retry so the client isn't left idle
          return;
        }
        if (data?.bridge_url && data.bridge_url !== client.currentUrl()) {
          client.setUrl(data.bridge_url); // reconnects to the fresh orchestrator
        } else {
          client.start();
        }
      } catch (err) {
        if (myGen !== connectGen) return;
        appendSystem(`Auto-restart failed: ${err?.message ?? err}`);
        autoRespawnsLeft = 0; // can't reach the pack → don't loop
        client.start(); // resume the bare WS retry so the client isn't left idle
      } finally {
        autoRespawning = false;
      }
    })();
    return true;
  }
  // FIX 4 — a single BOUNDED fresh re-dial for the agent-not-ready-yet case: the WS
  // opened before the agent spawned, so no `models` arrived on this socket. Mirrors a
  // manual Reconnect: close + reopen on the SAME url → a new hello (which lands once
  // the agent is up). Returns true if it re-dialed (suppressing the heavier reclaim);
  // false once the budget is spent — OR if the url already moved on (a newer connect
  // owns recovery), so we never re-dial a stale target. The budget is replenished
  // only by resetAutoReclaim (a user/sticky Connect or a successful handshake), so it
  // can never loop within one unsuccessful connect.
  function tryHandshakeRedial(timedOutUrl) {
    if (handshakeRedialsLeft <= 0) return false;
    if (timedOutUrl !== client.currentUrl()) return false;
    handshakeRedialsLeft -= 1;
    appendSystem("The panel agent isn't answering yet — reconnecting…");
    client.setUrl(client.currentUrl()); // close + reopen on the same url → fresh hello
    return true;
  }
  // Returns true if it kicked off a reclaim (the bridge client then suppresses its
  // manual warning); false to let the warning show (budget spent / can't reclaim).
  function tryAutoReclaim(timedOutUrl) {
    if (autoReclaiming) return true; // one in flight already — don't stack
    if (autoReclaimsLeft <= 0) return false; // budget spent → fall back to warning
    autoReclaimsLeft -= 1;
    autoReclaiming = true;
    appendSystem(
      "No response from the panel agent on the bridge — the orchestrator looks wedged. " +
        "Restarting it automatically…",
    );
    const myGen = connectGen; // tie to the current connect generation
    void (async () => {
      try {
        // Ask the pack to FORCE-reclaim: kill the wedged (but lockfile-healthy)
        // orchestrator on this backend's port — verified-orchestrator-only,
        // server-side — and spawn a fresh one. The pack reports back if the port
        // is held by a non-orchestrator it refuses to kill.
        const res = await api.fetchApi("/comfyui_mcp_panel/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ backend: selectedBackend, force: true, stall_seconds: stallSettingSeconds(), comfyui_url: remoteUrlSetting() }),
        });
        const data = await res.json().catch(() => ({}));
        // A newer user-initiated connect superseded us → let it drive.
        if (myGen !== connectGen) return;
        if (!data?.ok) {
          // The pack couldn't reclaim (e.g. a foreign process holds the port) —
          // surface its message and stop auto-reclaiming so the warning can show.
          if (data?.message) appendSystem(data.message);
          autoReclaimsLeft = 0;
          return;
        }
        if (data?.bridge_url && data.bridge_url !== client.currentUrl()) {
          client.setUrl(data.bridge_url); // setUrl reconnects
        } else {
          client.start(); // re-open against the same URL → fresh handshake attempt
        }
      } catch (err) {
        if (myGen !== connectGen) return;
        appendSystem(`Auto-restart failed: ${err?.message ?? err}`);
        autoReclaimsLeft = 0; // can't reach the pack → don't loop
      } finally {
        autoReclaiming = false;
      }
    })();
    return true;
  }
  async function connectAgent(opts = {}) {
    // A chip pick (opts.fromChip) is an EXPLICIT backend choice — it must always
    // (re)connect to that backend's port, so it bypasses the in-flight guard (which
    // a sticky-reconnect could otherwise hold) and the manual-URL override below.
    if (connecting && !opts.fromChip) return;
    const myGen = ++connectGen; // newest attempt; stale ones bail before touching client
    // A fresh user-/sticky-initiated connect gets a fresh auto-reclaim budget — the
    // bound is PER user-initiated connect, so each new Connect can attempt to clear
    // a wedge again (but a single connect can never loop forever). It also
    // supersedes any in-flight soft-reload interlock (softReload reconnects via
    // client.start(), not connectAgent, so reaching here means a NEW connect intent
    // took over — re-arm normal auto-respawn).
    resetAutoReclaim();
    clearSoftReloadGuard();
    connecting = true;
    connectBtn.disabled = true;
    connectBtn.textContent = "Starting…";
    // Honor whatever is typed in the Bridge URL field — Connect previously
    // ignored it (only Reconnect applied it), so editing the port (e.g. 9181)
    // then clicking Connect still hit the old URL. setUrl persists + reconnects.
    // A non-empty URL that differs from the last auto-applied one is a deliberate
    // manual override → keep it, and don't let /connect's bridge_url clobber it.
    const wanted = urlInput.value.trim();
    // Only a GENUINELY custom URL counts as a manual override. The SELECTED backend's
    // DEFAULT bridge URL must NOT — the per-backend Settings "Bridge URL" seeds that
    // default (claude 9180 / codex 9181), and on a sticky/load connect lastAutoUrl is
    // still empty, so flagging the default as an override would SKIP the per-backend
    // bridge_url from /connect (#25, now generalized PER BACKEND). Comparing against
    // THIS backend's default — not just claude's 9180 — is what lets Codex follow 9181.
    // A chip switch is INCLUDED now (no `!opts.fromChip` guard): connectBackend already
    // seeds urlInput + the client url from SETTING_BRIDGE_URL[id] BEFORE this runs, so a
    // user-CUSTOMIZED non-default per-backend URL must survive the switch and not be
    // overwritten by /connect's default bridge_url. A per-backend DEFAULT url still
    // isn't an override, so a normal switch keeps following /connect's bridge_url.
    const manualOverride =
      !!wanted && wanted !== defaultBridgeUrlFor(selectedBackend) && wanted !== lastAutoUrl;
    if (manualOverride && wanted !== client.currentUrl()) client.setUrl(wanted);
    try {
      // Send the selected backend so the pack starts (and points us at) the right
      // orchestrator. Default "claude" keeps the historical no-pick Connect path.
      const res = await api.fetchApi("/comfyui_mcp_panel/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: selectedBackend, stall_seconds: stallSettingSeconds(), comfyui_url: remoteUrlSetting() }),
      });
      const data = await res.json().catch(() => ({}));
      // A newer connect (e.g. a backend switch) superseded this one while the POST
      // was in flight — don't let this stale response retarget/reconnect the client.
      if (myGen !== connectGen) return;
      // The pack returns the exact ws URL for the chosen backend's port — connect
      // there so the user never types a port. Skip it if they manually overrode.
      if (!manualOverride && data?.bridge_url && data.bridge_url !== client.currentUrl()) {
        client.setUrl(data.bridge_url);
        urlInput.value = data.bridge_url;
        lastAutoUrl = data.bridge_url;
      }
      if (!data?.ok && data?.message) appendSystem(data.message);
    } catch (err) {
      if (myGen !== connectGen) return; // superseded → swallow the stale error too
      // No /connect route (older/headless host) — fall through and try the
      // bridge directly in case the user started the orchestrator themselves.
      appendSystem(`Couldn't reach ComfyUI to start the agent: ${err?.message ?? err}`);
    } finally {
      connecting = false;
    }
    // Connect (or keep reconnecting with backoff until the bridge binds) — unless a
    // newer attempt has taken over, in which case let IT drive the client.
    if (myGen !== connectGen) return;
    client.start();
  }
  connectBtn.addEventListener("click", connectAgent);

  // Pick a backend chip → remember it, repaint the chips so it highlights, then
  // run the normal Connect flow (which now POSTs this backend and follows the
  // returned bridge URL). The user never types a port.
  /** Seed the live prefs from `id`'s setting group for a backend SWITCH. The
   *  previous prefs.model/effort belong to the OLD backend's catalog, so they must
   *  not be carried into the new connection (applyModelCatalog would then push a
   *  STALE cross-backend model/effort). Force Auto when the new group has no
   *  concrete saved model, and map the effort into the new backend's scale. SEEDS
   *  ONLY — sends no set_options; the single post-handshake applyModelCatalog push
   *  emits exactly one set_options with the NEW backend's values. */
  function seedPrefsForBackendSwitch(id) {
    seedPrefsFromBackendGroup(id);
    const sm = getSetting(SETTING_MODEL[id]);
    if (typeof sm !== "string" || sm === "") prefs.modelAuto = true;
    if (prefs.effort) {
      const scale = BACKEND_EFFORTS[id] || ALL_EFFORTS;
      prefs.effort = nearestInList(prefs.effort, scale) || undefined;
    }
    savePrefs(prefs);
    refreshModelChip();
  }

  function connectBackend(id) {
    // CENTRALIZED per-backend seeding: every switch path routes through here — the
    // backend chips, the model-popover provider row, AND the Settings backend combo
    // (panelHooks.applyBackend). When the target backend differs from the one prefs
    // currently reflect (connectedBackend if connected, else the last-picked
    // selectedBackend), seed prefs from the NEW backend's group BEFORE connecting, so
    // the post-handshake push uses the new backend's model/effort — never the
    // previous backend's stale values. A re-pick of the same backend doesn't reseed.
    const prevBackend = connectedBackend || selectedBackend;
    if (id !== prevBackend) seedPrefsForBackendSwitch(id);
    selectedBackend = id;
    try {
      window.localStorage.setItem(STORAGE_KEY_BACKEND, id);
    } catch {
      // localStorage unavailable — selection just won't persist.
    }
    // FIX 1 — do NOT write SETTING_BACKEND here. A live composer/chip backend switch
    // is TEMPORARY/session-only and must NOT change the saved Settings default. The
    // old setSetting(SETTING_BACKEND, id) re-entered through SETTING_BACKEND.onChange →
    // applyBackend → connectBackend → setSetting → … (ComfyUI fires onChange async,
    // AFTER setSetting's suppressSettingOnChange has already reset), so each switch
    // overlapped multiple connects and the bridge's close-old-on-new-hello looped
    // (the 9181 "ready"/"waiting" storm). The Settings "Default agent backend" now
    // changes ONLY when the user edits it in the Settings dialog. Runtime selection
    // still persists in STORAGE_KEY_BACKEND above (drives backendNow()'s timings).
    renderBackendChips(
      Array.from(backendChips.querySelectorAll(".cmcp-backend-chip")).map((el) => ({
        backend: el.dataset.backend,
        running: el.title === "Running",
      })),
    );
    // Switching to a DIFFERENT backend than we're connected to: agent sessions are
    // NOT shareable across providers, so start FRESH for the new one (fix #2).
    // Sending the saved (foreign) session id on hello makes the new orchestrator
    // try to resume a session it doesn't own ("waiting for the panel agent…" +
    // a spurious re-send). Mirror newChat()'s session-clear so getResume() → null;
    // the visible chat log stays, only the agent session resets.
    const switching = connectedBackend !== null && connectedBackend !== id;
    if (switching) {
      ssSet(SESSION_KEY, null);
      if (thread) thread.sessionId = undefined;
    }
    // Reflect the picked backend in the composer placeholder immediately; onModels
    // reaffirms it authoritatively from the handshake (fix #3).
    setAskPlaceholder(id);
    // CLEAN TEARDOWN before the (re)connect (fix #1). The old fromChip path bypassed
    // the in-flight guard, so a chip pick could OVERLAP a sticky-reconnect already
    // in flight — re-delivering the prior pending message (a visible duplicate) and
    // starting a reconnect storm that trips the orchestrator's bounded-restart
    // give-up ("the agent session keeps dropping"). Tearing the bridge down and
    // clearing the guard first means EXACTLY ONE connect runs for the new backend.
    client.stop();
    connecting = false;
    // FIX 2 — point the bridge (and the Advanced URL field) at the NEW backend's own
    // bridge URL before reconnecting, so a switch — and any later Reconnect — dials
    // THIS backend's port (codex 9181), never the previous backend's (claude 9180).
    // /connect's returned bridge_url still applies on top. The client is stopped, so
    // setUrl only updates its `url` here (its connect() no-ops while closed);
    // connectAgent's client.start() opens it. urlInput has no settings onChange wired,
    // so updating it can't re-enter the storm.
    const nextUrl = getSetting(SETTING_BRIDGE_URL[id]) || defaultBridgeUrlFor(id);
    urlInput.value = nextUrl;
    if (client.currentUrl() !== nextUrl) client.setUrl(nextUrl);
    void connectAgent({ fromChip: true });
  }

  // Soft reload: pick up new code WITHOUT restarting ComfyUI, keeping this
  // conversation. Two scopes:
  //   • "orchestrator" — respawn the background agent (new tools / prompt /
  //     services). Drops the bridge; the fresh orchestrator resumes the session
  //     (SESSION_KEY) and onAck continues it.
  //   • "frontend" — reload just this panel page (new panel JS); ComfyUI and the
  //     orchestrator stay up, and the reconnect resumes the session.
  // `origin` ("user" | "agent") only affects whether we nudge the agent to
  // continue after an orchestrator reload (agent-triggered = it was mid-task).
  let reloading = false;
  async function softReload(origin = "user", scope = "orchestrator") {
    if (reloading) return;
    if (scope === "frontend") {
      // Nothing to respawn — just re-fetch the panel with a cache-bust. The
      // session id persists in sessionStorage, so we reconnect + resume on load.
      // Arm the reopen flag so our sidebar tab re-activates after the reload
      // (ComfyUI won't, since our tab isn't registered yet when it restores).
      ssSet(SIDEBAR_REOPEN_KEY, "1");
      appendSystem("Reloading the panel UI (new frontend code)…");
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("cmcpReload", String(Date.now()));
        window.location.replace(u.toString());
      } catch {
        window.location.reload();
      }
      return;
    }
    reloading = true;
    ssSet(SOFT_RELOAD_KEY, origin === "agent" ? "agent" : "user");
    // This deliberate reload OWNS the respawn — stand auto-respawn down so it can't
    // POST a competing /connect while the fresh orchestrator cold-starts (the race
    // that made soft reload fail intermittently). Cleared on handshake or by the
    // guard's safety timeout.
    setSoftReloadGuard();
    appendSystem("Soft-reloading the agent (new code, no ComfyUI restart)…");
    try {
      client.stop(); // drop the bridge so the old orchestrator can release the port
      const res = await api.fetchApi("/comfyui_mcp_panel/reload", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) {
        ssSet(SOFT_RELOAD_KEY, null);
        clearSoftReloadGuard(); // never started respawning → re-enable auto-respawn
        appendSystem(data?.message || "Soft reload failed — try Disconnect then Connect.");
        return;
      }
    } catch (err) {
      ssSet(SOFT_RELOAD_KEY, null);
      clearSoftReloadGuard(); // POST failed → re-enable auto-respawn
      appendSystem(`Couldn't reach ComfyUI to reload the agent: ${err?.message ?? err}`);
      return;
    } finally {
      reloading = false;
    }
    // Reconnect with backoff until the fresh orchestrator binds; onAck resumes. The
    // soft-reload guard keeps auto-respawn from racing this backoff window.
    client.start();
  }

  // Hard restart: recover a wedged/unresponsive agent. Unlike soft reload (which
  // bounces the orchestrator in place and RESUMES, to pick up new code), this
  // kills the orchestrator AND its whole child tree — clearing a dead Agent-SDK
  // shell that an in-place reload can't — then respawns and starts a FRESH
  // session. Resuming would defeat the purpose: a dead tool-subprocess handle is
  // checkpointed into the session, so resume faithfully restores the corpse and
  // re-wedges. Fresh = a brand-new shell that works. The chat history stays
  // visible; the agent's memory resets (an acceptable trade to get it working).
  // Runs entirely over the Python /hard_restart route, so it works even when the
  // agent isn't answering.
  async function hardRestart(origin = "user") {
    if (reloading) return;
    reloading = true;
    appendSystem("Restarting the agent backend…");
    let ok = false;
    try {
      client.stop(); // drop the bridge so the old orchestrator can release the port
      const res = await api.fetchApi("/comfyui_mcp_panel/hard_restart", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (data?.ok) {
        ok = true;
      } else {
        appendSystem(
          data?.message ||
            "Restart failed — try Disconnect then Connect, or fully restart ComfyUI.",
        );
      }
    } catch (err) {
      appendSystem(`Couldn't reach ComfyUI to restart the agent: ${err?.message ?? err}`);
    } finally {
      reloading = false;
    }
    if (ok) {
      // Start FRESH on reconnect: clear the saved session id so hello sends no
      // resume (resuming would restore the wedged shell). Don't arm the resume
      // nudge. The reconnect spins up a brand-new agent.
      ssSet(SESSION_KEY, null);
      ssSet(SOFT_RELOAD_KEY, null);
      ssSet(MID_TASK_KEY, null);
      appendSystem("Agent restarted with a fresh session — your message history is still here.");
    }
    // Reconnect EITHER WAY: on success to the fresh orchestrator, on failure to
    // restore the bridge we dropped (the old backend may still be intact).
    client.start();
  }

  disconnectBtn.addEventListener("click", async () => {
    // Explicit Disconnect = opt out of sticky auto-reconnect (and the matching setting).
    lsSet(AUTOCONNECT_KEY, null);
    setSetting(SETTING_AUTOCONNECT, false);
    client.stop();
    connectBtn.hidden = false;
    disconnectBtn.hidden = true;
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
    statusText.textContent = "disconnected";
    dot.className = "cmcp-dot";
    settingsBox.hidden = false;
    try {
      await api.fetchApi("/comfyui_mcp_panel/disconnect", { method: "POST" });
    } catch {
      // best-effort; a user-run orchestrator is intentionally left running
    }
    appendSystem("Disconnected. Click Connect to start again.");
  });

  // ---- slash commands (run locally, no agent round-trip) ----
  async function runLocalCommand(cmd, args) {
    try {
      const result = await GRAPH_TOOL_EXECUTORS[cmd](args);
      appendActivity(cmd, args, { ok: true, result });
    } catch (err) {
      appendActivity(cmd, args, { ok: false, error: err?.message ?? String(err) });
    }
  }

  const SLASH_COMMANDS = [
    { cmd: "/new", icon: "pi-plus", hint: "start a new chat", run: () => newChat() },
    {
      cmd: "/fit",
      icon: "pi-window-maximize",
      hint: "fit the canvas to the graph",
      run: () => runLocalCommand("graph_canvas", { action: "fit" }),
    },
    { cmd: "/run", icon: "pi-play", hint: "queue the open workflow", run: () => runLocalCommand("graph_run", {}) },
    {
      cmd: "/reload",
      icon: "pi-sync",
      hint: "soft-reload the agent (new code, keeps ComfyUI + this chat)",
      run: () => softReload("user", "orchestrator"),
    },
    {
      cmd: "/reload-ui",
      icon: "pi-refresh",
      hint: "reload just the panel UI (new frontend code, keeps the session)",
      run: () => softReload("user", "frontend"),
    },
    {
      cmd: "/restart",
      icon: "pi-refresh",
      hint: "restart the agent backend — recover an unresponsive agent",
      run: () => hardRestart("user"),
    },
    {
      cmd: "/revert",
      icon: "pi-undo",
      hint: "undo the last turn's graph edits — revert the canvas to before your last message",
      run: () => {
        const snap = revertGraphToLastSnapshot();
        if (snap) {
          appendSystem(
            `↩ Reverted the canvas to before${snap.label ? ` “${snap.label}”` : " your last message"}.`,
          );
        } else {
          appendSystem("Nothing to revert — no graph snapshot captured in this session yet.");
        }
      },
    },
    {
      cmd: "/errors",
      icon: "pi-info-circle",
      hint: "show the last execution errors",
      run: () => runLocalCommand("graph_get_errors", {}),
    },
    {
      cmd: "/help",
      icon: "pi-question-circle",
      hint: "list commands",
      run: () => appendSystem(SLASH_COMMANDS.map((c) => `${c.cmd} — ${c.hint}`).join(" · ")),
    },
  ];

  // ---- completion menu (slash + @ mentions) ----
  let menuItems = [];
  let menuSel = 0;
  let menuToken = null; // { start, end } range in input.value being completed

  function hideMenu() {
    menuPop.hidden = true;
    menuItems = [];
    menuToken = null;
  }

  function showMenu(items) {
    menuItems = items;
    menuSel = 0;
    menuPop.textContent = "";
    if (!items.length) {
      hideMenu();
      return;
    }
    items.forEach((item, idx) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className =
        "cmcp-popover-item" + (idx === 0 ? " sel" : "") + (item.kind === "slash" || item.kind === "agent" ? " cmcp-slash" : "");
      const i = document.createElement("i");
      i.className = `pi ${item.icon}`;
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = item.label;
      lbl.title = item.label;
      el.append(i, lbl);
      if (item.small) {
        const s = document.createElement("small");
        s.textContent = item.small;
        s.title = item.small;
        el.appendChild(s);
      }
      // Full text on hover for the whole row, so anything truncated is readable.
      el.title = item.small ? `${item.label} — ${item.small}` : item.label;
      // mousedown (not click) so the textarea never loses focus.
      el.addEventListener("mousedown", (mev) => {
        mev.preventDefault();
        pickMenuItem(item);
      });
      menuPop.appendChild(el);
    });
    menuPop.hidden = false;
  }

  function moveSel(delta) {
    if (!menuItems.length) return;
    menuSel = (menuSel + delta + menuItems.length) % menuItems.length;
    [...menuPop.children].forEach((el, i) => el.classList.toggle("sel", i === menuSel));
    menuPop.children[menuSel]?.scrollIntoView({ block: "nearest" });
  }

  function pickMenuItem(item) {
    if (item.kind === "slash") {
      hideMenu();
      input.value = "";
      input.style.height = "auto";
      appendUser(item.ref.cmd);
      item.ref.run();
      return;
    }
    const { start, end } = menuToken ?? { start: input.value.length, end: input.value.length };
    input.value = input.value.slice(0, start) + item.insert + input.value.slice(end);
    const pos = start + item.insert.length;
    input.selectionStart = pos;
    input.selectionEnd = pos;
    hideMenu();
    input.focus();
  }

  function buildAtItems(query) {
    const q = query.toLowerCase();
    const items = [];
    const wf = getWorkflowTitle();
    if (!q || "workflow".includes(q) || wf.toLowerCase().includes(q)) {
      items.push({
        icon: "pi-file",
        label: `workflow — ${wf}`,
        small: "context",
        insert: `@workflow:"${wf}" `,
      });
    }
    try {
      const { graph } = getGraphCtx();
      for (const n of graph._nodes ?? []) {
        const name = n.title ?? n.type;
        const label = `#${n.id} ${name}`;
        if (!q || label.toLowerCase().includes(q)) {
          items.push({
            icon: n.subgraph ? "pi-sitemap" : "pi-circle",
            label,
            small: n.subgraph ? "subgraph" : n.type,
            insert: `@node:${n.id}(${name}) `,
          });
        }
        if (items.length >= 9) break;
      }
    } catch {
      // graph unavailable — node items skipped
    }
    try {
      const LG = window.LiteGraph ?? globalThis.LiteGraph;
      if (q.length >= 2 && LG?.registered_node_types) {
        let added = 0;
        for (const t of Object.keys(LG.registered_node_types)) {
          if (t.toLowerCase().includes(q)) {
            items.push({ icon: "pi-box", label: t, small: "node type", insert: `@type:${t} ` });
            added += 1;
            if (added >= 5) break;
          }
        }
      }
    } catch {
      // LiteGraph unavailable — type items skipped
    }
    return items.slice(0, 12);
  }

  function refreshMenu() {
    const caret = input.selectionStart ?? input.value.length;
    const upto = input.value.slice(0, caret);
    // Slash menu only while the whole message IS the command being typed.
    if (/^\/[\w-]*$/.test(upto) && upto === input.value) {
      const q = upto.toLowerCase();
      menuToken = { start: 0, end: input.value.length };
      const localItems = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q)).map((c) => ({
        kind: "slash",
        icon: c.icon,
        label: c.cmd,
        small: c.hint,
        ref: c,
      }));
      // SDK commands (sent to the agent — the SDK processes them). Skip any whose
      // name collides with a local command. Picking inserts "/name " so the user
      // can add args, then send routes it to the agent.
      const localNames = new Set(SLASH_COMMANDS.map((c) => c.cmd));
      const sdkItems = sdkCommands
        .filter((c) => {
          const names = ["/" + c.name, ...(c.aliases || []).map((a) => "/" + a)];
          return !localNames.has("/" + c.name) && names.some((n) => n.startsWith(q));
        })
        .map((c) => ({
          kind: "agent",
          icon: "pi-sparkles",
          label: "/" + c.name,
          small: c.description || c.argumentHint || "agent command",
          insert: "/" + c.name + " ",
        }));
      showMenu([...localItems, ...sdkItems]);
      return;
    }
    const atM = upto.match(/(^|\s)@([\w./:-]*)$/);
    if (atM) {
      menuToken = { start: caret - atM[2].length - 1, end: caret };
      showMenu(buildAtItems(atM[2]));
      return;
    }
    hideMenu();
  }

  // ---- attach (upload into ComfyUI's input/ folder) ----
  function insertAtCaret(text) {
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? s;
    input.value = input.value.slice(0, s) + text + input.value.slice(e);
    const pos = s + text.length;
    input.selectionStart = pos;
    input.selectionEnd = pos;
    input.dispatchEvent(new Event("input"));
    input.focus();
  }

  attachBtn.addEventListener("click", () => fileInput.click());
  // The attach button uses the same chip pipeline as drag/paste — each file drops
  // a typed chip ([Image #N] / [Video #N] / [Workflow #N] / [File #N]) and a
  // structured ref, delivered inline to the agent on send.
  fileInput.addEventListener("change", () => {
    for (const f of Array.from(fileInput.files || [])) handleFile(f);
    fileInput.value = "";
  });

  // ---- attachments: drag-drop / paste files + paste large text ------------
  // Claude-Code style. A dropped/pasted/attached file becomes a typed chip in the
  // composer; on send it's delivered to the agent inline:
  //   • image    → uploads into ComfyUI input/, shown + delivered as a viewable ref
  //   • video    → uploads into ComfyUI input/, delivered as an input/ path the
  //                agent can wire into a video-load node or pass to video tools
  //   • workflow → the .json is read and inlined so the agent can load/analyze it
  //   • text     → the file's text is read and inlined (like a big paste)
  // A big text paste also collapses to a [Pasted text #N] chip.
  const PASTE_TEXT_THRESHOLD = 800; // chars; longer pastes collapse to a chip
  const MAX_INLINE_TEXT = 600_000; // chars; cap inlined file text (workflows/docs)
  // Text-ish files we read & inline rather than upload. (.json is handled as a
  // workflow first; if it doesn't parse as one it falls back to a text file.)
  const TEXT_FILE_RE =
    /\.(txt|md|markdown|csv|tsv|ya?ml|xml|html?|toml|ini|cfg|conf|env|log|py|js|mjs|cjs|ts|tsx|jsx|sh|bat|ps1|rb|go|rs|c|h|cpp|hpp|java|kt|css|scss|sql|json5)$/i;
  let attachments = []; // { id, kind:"image"|"video"|"text"|"textfile"|"workflow", ... }
  let attachSeq = 0;
  function resetAttachments() {
    attachments = [];
    attachSeq = 0;
    openPreviewId = null;
    renderAttachmentChips();
  }

  // ---- Attachment chip rendering / preview / removal -----------------------
  // The chip strip is a viewer for attachments[]; it never changes how messages
  // are sent (send still resolves attachments by token-match against the textarea).
  let openPreviewId = null; // id of the attachment whose inline preview is open
  const ATT_ICON = {
    image: "pi-image",
    video: "pi-video",
    text: "pi-align-left",
    textfile: "pi-file",
    workflow: "pi-sitemap",
    file: "pi-file",
  };
  // The exact inline token a given attachment inserted into the textarea.
  function attTokenFor(att) {
    if (!att) return "";
    if (att.kind === "image") return `[Image #${att.id}]`;
    if (att.kind === "text") return `[Pasted text #${att.id}]`;
    return att.token || "";
  }
  function attChipLabel(att) {
    if (att.kind === "text") return `Pasted text #${att.id}`;
    return att.name || attTokenFor(att) || `#${att.id}`;
  }
  // Remove the attachment + its inline token (and a single trailing space) from
  // the textarea, then re-render. Precise: only the first exact token match.
  function removeAttachment(id) {
    try {
      const idx = attachments.findIndex((a) => a && a.id === id);
      if (idx === -1) return;
      const att = attachments[idx];
      attachments.splice(idx, 1);
      const tok = attTokenFor(att);
      if (tok && input) {
        const v = input.value;
        const i = v.indexOf(tok);
        if (i !== -1) {
          let end = i + tok.length;
          if (v[end] === " ") end++; // drop the trailing space the insert added
          input.value = v.slice(0, i) + v.slice(end);
          input.dispatchEvent(new Event("input")); // re-run autosize + menus
        }
      }
      if (openPreviewId === id) openPreviewId = null;
      renderAttachmentChips();
    } catch {
      /* never throw into the composer */
    }
  }
  function toggleAttachPreview(id) {
    openPreviewId = openPreviewId === id ? null : id;
    renderAttachmentChips();
  }
  // Fill the inline preview panel for the currently-open attachment.
  function renderAttachPreview() {
    if (!chipPreview) return;
    chipPreview.textContent = "";
    const att = attachments.find((a) => a && a.id === openPreviewId);
    if (!att) {
      chipPreview.hidden = true;
      openPreviewId = null;
      return;
    }
    chipPreview.hidden = false;
    if (att.kind === "image") {
      if (att.dataUrl) {
        const img = document.createElement("img");
        img.src = att.dataUrl;
        img.alt = att.name || "image";
        chipPreview.appendChild(img);
      } else {
        const p = document.createElement("pre");
        p.textContent = att.name || "image (no preview yet)";
        chipPreview.appendChild(p);
      }
      return;
    }
    const pre = document.createElement("pre");
    const content = att.content != null ? String(att.content) : "";
    pre.textContent = content || (att.ready ? "Loading…" : "(empty)");
    chipPreview.appendChild(pre);
  }
  // Rebuild the chip strip from attachments[]. Safe to call any time.
  function renderAttachmentChips() {
    if (!attachBar || !chipStrip) return;
    chipStrip.textContent = "";
    if (!attachments.length) {
      attachBar.hidden = true;
      chipPreview.hidden = true;
      chipPreview.textContent = "";
      openPreviewId = null;
      return;
    }
    attachBar.hidden = false;
    for (const att of attachments) {
      if (!att) continue;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "cmcp-attach-chip";
      if (att.id === openPreviewId) chip.classList.add("open");
      chip.title = "Click to preview";
      if (att.kind === "image" && att.dataUrl) {
        const img = document.createElement("img");
        img.className = "cmcp-attach-thumb";
        img.src = att.dataUrl;
        img.alt = "";
        chip.appendChild(img);
      } else {
        const ic = document.createElement("i");
        ic.className = "pi " + (ATT_ICON[att.kind] || "pi-file");
        chip.appendChild(ic);
      }
      const name = document.createElement("span");
      name.className = "cmcp-attach-name";
      name.textContent = attChipLabel(att);
      chip.appendChild(name);
      if (att.kind === "text") {
        const meta = document.createElement("span");
        meta.className = "cmcp-attach-meta";
        meta.textContent = `${(att.content || "").length.toLocaleString()} chars`;
        chip.appendChild(meta);
      }
      chip.addEventListener("click", () => toggleAttachPreview(att.id));
      // Remove control: a span (not a nested <button>, which is invalid HTML).
      const rm = document.createElement("span");
      rm.className = "cmcp-attach-rm";
      rm.setAttribute("role", "button");
      rm.title = "Remove attachment";
      const rmi = document.createElement("i");
      rmi.className = "pi pi-times";
      rm.appendChild(rmi);
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        removeAttachment(att.id);
      });
      chip.appendChild(rm);
      chipStrip.appendChild(chip);
    }
    renderAttachPreview();
  }
  function classifyFile(file) {
    const type = file?.type || "";
    const name = (file?.name || "").toLowerCase();
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (name.endsWith(".json") || type === "application/json") return "workflow";
    if (type.startsWith("text/") || TEXT_FILE_RE.test(name)) return "text";
    return "other"; // unknown binary — upload into input/ and reference by path
  }
  // Route any attached/dropped/pasted file to the right handler by kind.
  function handleFile(file) {
    if (!file) return;
    switch (classifyFile(file)) {
      case "image": return handleImageFile(file);
      case "video": return handleMediaUpload(file, "video");
      case "workflow": return handleWorkflowFile(file);
      case "text": return handleTextFile(file);
      default: return handleMediaUpload(file, "file");
    }
  }
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }
  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result ?? ""));
      fr.onerror = reject;
      fr.readAsText(file);
    });
  }
  function handleImageFile(file) {
    if (!file || !file.type?.startsWith("image/")) return;
    const id = ++attachSeq;
    const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const name = file.name || `pasted-${id}.${ext}`;
    const att = { id, kind: "image", name, mediaType: file.type, dataUrl: null, inputRef: null };
    attachments.push(att);
    insertAtCaret(`[Image #${id}] `);
    renderAttachmentChips();
    // Read for a thumbnail + upload to ComfyUI input/ (both async); submit awaits.
    att.ready = (async () => {
      try {
        att.dataUrl = await readAsDataURL(file);
      } catch {
        /* no preview */
      }
      try {
        const fd = new FormData();
        fd.append("image", file, name);
        const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (res.status === 200) {
          const info = await res.json();
          att.inputRef = (info.subfolder ? `${info.subfolder}/` : "") + info.name;
          att.ref = { filename: info.name, subfolder: info.subfolder || undefined, type: info.type || "input" };
        }
      } catch {
        /* upload failed — the chip still references it by name as a fallback */
      }
    })();
    att.ready.then(renderAttachmentChips, () => {}); // refresh once the thumb loads
  }
  function handlePastedText(text) {
    const id = ++attachSeq;
    attachments.push({ id, kind: "text", content: text });
    insertAtCaret(`[Pasted text #${id}] `);
    renderAttachmentChips();
  }
  // Upload a non-inlineable file (video, or an unknown binary) into ComfyUI's
  // input/ folder and drop a path-reference chip. Claude can't view video inline,
  // so on send the agent gets the input/ path — ready to wire into a video-load
  // node or hand to the comfyui video tools.
  function handleMediaUpload(file, kind /* "video" | "file" */) {
    if (!file) return;
    const id = ++attachSeq;
    const label = kind === "video" ? "Video" : "File";
    const name = file.name || `pasted-${id}`;
    const att = { id, kind, name, mediaType: file.type || "", inputRef: null, ref: null, token: `[${label} #${id}]` };
    attachments.push(att);
    insertAtCaret(`${att.token} `);
    renderAttachmentChips();
    att.ready = (async () => {
      try {
        const fd = new FormData();
        // ComfyUI's /upload/image writes ANY uploaded file verbatim into input/.
        fd.append("image", file, name);
        const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (res.status === 200) {
          const info = await res.json();
          att.inputRef = (info.subfolder ? `${info.subfolder}/` : "") + info.name;
          att.ref = { filename: info.name, subfolder: info.subfolder || undefined, type: info.type || "input" };
        }
      } catch {
        /* upload failed — the chip still names the file as a fallback */
      }
    })();
  }
  // Read a text file (docs, code, data) and inline its contents to the agent.
  function handleTextFile(file) {
    if (!file) return;
    const id = ++attachSeq;
    const name = file.name || `file-${id}.txt`;
    const att = { id, kind: "textfile", name, content: "", token: `[File #${id}]` };
    attachments.push(att);
    insertAtCaret(`${att.token} `);
    renderAttachmentChips();
    att.ready = (async () => {
      try {
        let t = await readAsText(file);
        if (t.length > MAX_INLINE_TEXT) t = t.slice(0, MAX_INLINE_TEXT) + `\n…[truncated — original ${t.length} chars]`;
        att.content = t;
      } catch {
        att.content = "";
      }
    })();
    att.ready.then(renderAttachmentChips, () => {}); // refresh once content is read
  }
  // Read a ComfyUI workflow .json and inline it so the agent can load / analyze /
  // merge it. If it doesn't parse as JSON, fall back to delivering it as raw text.
  function handleWorkflowFile(file) {
    if (!file) return;
    const id = ++attachSeq;
    const name = file.name || `workflow-${id}.json`;
    const att = { id, kind: "workflow", name, content: "", isWorkflow: true, token: `[Workflow #${id}]` };
    attachments.push(att);
    insertAtCaret(`${att.token} `);
    renderAttachmentChips();
    att.ready = (async () => {
      try {
        let t = await readAsText(file);
        try {
          const obj = JSON.parse(t);
          // Confirm it looks like a ComfyUI graph (UI format with nodes[], or API
          // format keyed by node id with class_type). Pretty-print either way.
          att.isWorkflow =
            !!obj && typeof obj === "object" &&
            (Array.isArray(obj.nodes) || "last_node_id" in obj ||
              Object.values(obj).some((v) => v && typeof v === "object" && "class_type" in v));
          t = JSON.stringify(obj, null, 2);
        } catch {
          att.isWorkflow = false; // not valid JSON — deliver as raw text
        }
        if (t.length > MAX_INLINE_TEXT) t = t.slice(0, MAX_INLINE_TEXT) + `\n…[truncated — original ${t.length} chars]`;
        att.content = t;
      } catch {
        att.content = "";
      }
    })();
    att.ready.then(renderAttachmentChips, () => {}); // refresh once content is read
  }

  // Resolve image references from an @node:<id> mention to ComfyUI /view refs:
  // a LoadImage-style input widget, and/or displayed output images (Save/Preview).
  const IMG_WIDGET_NAMES = /^(image|images|mask|video|file|filename|audio)$/i;
  function nodeImageRefs(node) {
    const out = [];
    for (const w of node?.widgets || []) {
      if (typeof w?.value === "string" && IMG_WIDGET_NAMES.test(w?.name || "")) {
        const v = w.value.replace(/\s*\[[^\]]+\]\s*$/, "").trim(); // strip " [input]"
        if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(v)) continue;
        const slash = v.lastIndexOf("/");
        out.push(
          slash >= 0
            ? { filename: v.slice(slash + 1), subfolder: v.slice(0, slash), type: "input" }
            : { filename: v, type: "input" },
        );
      }
    }
    for (const im of node?.imgs || []) {
      if (!im?.src) continue;
      try {
        const u = new URL(im.src, location.origin);
        const filename = u.searchParams.get("filename");
        if (filename) {
          out.push({
            filename,
            subfolder: u.searchParams.get("subfolder") || undefined,
            type: u.searchParams.get("type") || "output",
          });
        }
      } catch {
        /* non-view src — skip */
      }
    }
    return out;
  }

  // Gather all image refs to deliver inline with a message: attachment chips,
  // @input:<path> mentions, and @node:<id> mentions (Load/Save/Preview nodes).
  async function collectImageRefs(text, refImgs) {
    const refs = [];
    const seen = new Set();
    const add = (r) => {
      if (!r?.filename) return;
      const key = `${r.type || "input"}/${r.subfolder || ""}/${r.filename}`;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push(r);
    };
    for (const a of refImgs) if (a.ref) add(a.ref);
    for (const m of text.matchAll(/@input:(.+?\.(?:png|jpe?g|gif|webp|bmp))\b/gi)) {
      const p = m[1].trim();
      const slash = p.lastIndexOf("/");
      add(slash >= 0 ? { filename: p.slice(slash + 1), subfolder: p.slice(0, slash), type: "input" } : { filename: p, type: "input" });
    }
    let graph = null;
    try {
      graph = getGraphCtx().graph;
    } catch {
      /* no graph */
    }
    if (graph?.getNodeById) {
      for (const m of text.matchAll(/@node:(\d+)/g)) {
        const node = graph.getNodeById(Number(m[1]));
        if (node) for (const r of nodeImageRefs(node)) add(r);
      }
    }
    return refs;
  }

  // Drop overlay — scoped to the COMPOSER (text area), shown only while dragging
  // a file over it. Toggled via a class (not the [hidden] attr — see CSS note).
  form.style.position = form.style.position || "relative";
  const dropzone = document.createElement("div");
  dropzone.className = "cmcp-dropzone";
  dropzone.innerHTML = '<span><i class="pi pi-paperclip"></i> Drop a file to attach</span>';
  form.appendChild(dropzone);
  let dragDepth = 0;
  const showDrop = (on) => dropzone.classList.toggle("cmcp-show", on);
  const dragHasFiles = (ev) => Array.from(ev.dataTransfer?.types || []).includes("Files");
  form.addEventListener("dragenter", (ev) => {
    if (!dragHasFiles(ev)) return;
    ev.preventDefault();
    dragDepth += 1;
    showDrop(true);
  });
  form.addEventListener("dragover", (ev) => {
    if (!dragHasFiles(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  });
  form.addEventListener("dragleave", (ev) => {
    if (!dragHasFiles(ev)) return;
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      showDrop(false);
    }
  });
  form.addEventListener("drop", (ev) => {
    if (!dragHasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    showDrop(false);
    for (const f of Array.from(ev.dataTransfer.files || [])) handleFile(f);
    input.focus();
  });
  input.addEventListener("paste", (ev) => {
    const dt = ev.clipboardData;
    if (!dt) return;
    // Any pasted file (a screenshot, or a file copied from the OS) routes through
    // the same dispatcher as the attach button and drag-drop.
    const fileItem = Array.from(dt.items || []).find((it) => it.kind === "file");
    if (fileItem) {
      const file = fileItem.getAsFile();
      if (file) {
        ev.preventDefault();
        handleFile(file);
        return;
      }
    }
    const text = dt.getData("text/plain");
    if (text && (text.length > PASTE_TEXT_THRESHOLD || (text.match(/\n/g) || []).length >= 12)) {
      ev.preventDefault();
      handlePastedText(text);
    }
  });

  // ---- voice dictation (browser speech recognition; Chrome) ----
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  let recognition = null;
  if (!SR) {
    micBtn.disabled = true;
    micBtn.title = "Voice input is not supported in this browser";
  }
  micBtn.addEventListener("click", () => {
    if (!SR) return;
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SR();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.addEventListener("result", (ev) => {
      const last = ev.results[ev.results.length - 1];
      if (last?.isFinal) insertAtCaret(`${last[0].transcript.trim()} `);
    });
    recognition.addEventListener("end", () => {
      micBtn.classList.remove("active");
      recognition = null;
    });
    recognition.addEventListener("error", (ev) => {
      if (ev.error !== "aborted") appendSystem(`Voice input error: ${ev.error}`);
    });
    micBtn.classList.add("active");
    recognition.start();
  });

  // ---- composer history (press ↑ to recall your last message for editing) ----
  // Shell-style: ↑ from an empty composer (or with the caret at the very start)
  // walks back through messages you've sent and drops them back in the composer;
  // ↓ walks forward and finally restores the draft you were typing. Any keystroke
  // that edits the text exits history mode. Born from the muscle-memory urge to
  // press ↑ and fix a typo in the message you just fired off.
  const sentHistory = [];
  let histIdx = -1; // -1 = not navigating; otherwise an index into sentHistory
  let histDraft = ""; // the unsent draft stashed when navigation began

  function recordSent(text) {
    if (sentHistory[sentHistory.length - 1] !== text) sentHistory.push(text);
    if (sentHistory.length > 50) sentHistory.shift();
    histIdx = -1;
  }
  function setComposerValue(val) {
    input.value = val;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    const n = val.length;
    try {
      input.setSelectionRange(n, n);
    } catch {
      // detached/unsupported — value is set, caret position is cosmetic
    }
  }
  /** "Edit last message": when you start navigating, if the agent hasn't answered
   *  yet (the last recorded message is still yours), RETRACT it — pull the bubble
   *  out of the feed, drop any in-flight reply preview, and interrupt the turn —
   *  so editing and resending REPLACES it instead of leaving a duplicate. If the
   *  agent already replied, we leave the conversation intact and just browse. */
  function retractLastUserMessage() {
    const msgs = thread?.msgs;
    if (!msgs || !msgs.length || msgs[msgs.length - 1].role !== "user") return;
    msgs.pop();
    persistThreads();
    for (const s of streamBubbles.values()) s.el.remove(); // interrupting → drop previews
    streamBubbles.clear();
    animating.clear();
    const userBubbles = log.querySelectorAll(".cmcp-bubble.user");
    const last = userBubbles[userBubbles.length - 1];
    const mid = last?.dataset?.mid;
    if (last) last.remove();
    if (mid) {
      const entry = pendingMsgs.get(mid);
      if (entry?.timer) clearTimeout(entry.timer);
      pendingMsgs.delete(mid);
      log.querySelector(`.cmcp-msg-status[data-mid="${mid}"]`)?.remove();
    }
    if (thinkingEl) {
      client?.sendFrame?.({ type: "interrupt" });
      hideThinking();
    }
  }

  function recallPrev() {
    if (!sentHistory.length) return false;
    if (histIdx === -1) {
      histDraft = input.value;
      histIdx = sentHistory.length;
      retractLastUserMessage(); // pull an unanswered message back so resend ≠ duplicate
    }
    histIdx = Math.max(0, histIdx - 1);
    setComposerValue(sentHistory[histIdx]);
    return true;
  }
  function recallNext() {
    if (histIdx === -1) return false;
    histIdx += 1;
    if (histIdx >= sentHistory.length) {
      histIdx = -1;
      setComposerValue(histDraft); // back to the draft you were typing
    } else {
      setComposerValue(sentHistory[histIdx]);
    }
    return true;
  }

  // ---- double-Esc rewind (#44) ----
  // Two Escapes in quick succession rewind your last turn: revert the canvas to
  // before your last message AND bring that message back into the composer to
  // edit & resend. (Graph + edit scope; conversation-fork is a follow-up.)
  let lastEscAt = 0;
  function rewindLastTurn() {
    const snap = revertGraphToLastSnapshot();
    const recalled = recallPrev(); // pulls your last message into the composer to edit
    if (snap || recalled) {
      appendSystem(
        `↩ Rewound your last turn${snap ? " — canvas reverted" : ""}` +
          `${recalled ? "; your message is back in the composer to edit & resend" : ""}.`,
      );
      input.focus();
    } else {
      appendSystem("Nothing to rewind yet — no message/graph snapshot from this session.");
    }
  }

  // Per-message rollback modal (edit button on a user bubble). Edit the message
  // and choose what to roll back — code (revert the canvas to before it),
  // conversation (fork the agent's memory at that point), or both — then resend.
  function openRollbackModal({ mid, text, anchor }) {
    const overlay = document.createElement("div");
    overlay.className = "cmcp-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "cmcp-modal";
    const title = document.createElement("div");
    title.className = "cmcp-modal-title";
    title.textContent = "Roll back & edit";
    const ta = document.createElement("textarea");
    ta.className = "cmcp-modal-text";
    ta.rows = 3;
    ta.value = text;
    const scopeWrap = document.createElement("div");
    scopeWrap.className = "cmcp-modal-scopes";
    let chosen = "both";
    const scopes = [
      { v: "both", label: "Code + conversation", hint: "revert the canvas AND rewind the agent's memory" },
      { v: "code", label: "Code only", hint: "revert the canvas; keep the conversation" },
      { v: "conversation", label: "Conversation only", hint: "rewind the agent's memory; keep the canvas" },
    ];
    for (const s of scopes) {
      const lbl = document.createElement("label");
      lbl.className = "cmcp-modal-scope";
      const r = document.createElement("input");
      r.type = "radio";
      r.name = "cmcp-rollback-scope";
      r.value = s.v;
      if (s.v === chosen) r.checked = true;
      r.addEventListener("change", () => {
        chosen = s.v;
      });
      const span = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = s.label;
      span.append(strong, document.createTextNode(` — ${s.hint}`));
      lbl.append(r, span);
      scopeWrap.appendChild(lbl);
    }
    const btnRow = document.createElement("div");
    btnRow.className = "cmcp-modal-btns";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cmcp-btn";
    cancel.textContent = "Cancel";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "cmcp-btn cmcp-btn-primary";
    go.textContent = "Roll back & resend";
    const close = () => overlay.remove();
    cancel.addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    go.addEventListener("click", () => {
      const edited = ta.value.trim();
      const wantCode = chosen === "code" || chosen === "both";
      const wantConvo = chosen === "conversation" || chosen === "both";
      if (wantCode) {
        const snap = revertGraphSnapshotByMid(mid);
        appendSystem(
          snap
            ? "↩ Canvas reverted to before this message."
            : "No graph snapshot for this message — canvas left as-is.",
        );
      }
      if (wantConvo) {
        client.sendFrame?.({ type: "rewind", anchor });
        appendSystem(
          anchor
            ? "↩ Rewound the conversation to before this message."
            : "↩ Started a fresh conversation from this point.",
        );
      }
      close();
      if (edited) {
        setComposerValue(edited);
        form.requestSubmit();
      }
    });
    btnRow.append(cancel, go);
    modal.append(title, ta, scopeWrap, btnRow);
    overlay.appendChild(modal);
    root.appendChild(overlay);
    setTimeout(() => ta.focus(), 0);
  }

  // ---- submit ----
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    hideMenu();
    const text = input.value.trim();
    if (!text) return;
    recordSent(text); // remember it so ↑ can recall it later
    if (text.startsWith("/")) {
      const c = SLASH_COMMANDS.find((sc) => sc.cmd === text.split(/\s+/)[0]);
      if (c) {
        appendUser(text);
        input.value = "";
        input.style.height = "auto";
        c.run();
        return;
      }
    }
    if (!client.isConnected()) {
      appendSystem("Not connected — click Connect (in the Connection panel) and try again.");
      settingsBox.hidden = false;
      return;
    }
    const freshChat = !thread;
    const mid = newMid();
    // Decide tray-vs-inline at SEND time: if a turn is already in flight the message
    // QUEUES — paint nothing inline now; it lives in the pending tray and materializes
    // at the END of the chat when the agent dequeues it (so the chat flows in dequeue
    // order, matching any reordering). An idle send paints immediately.
    const isQueued = agentWorking;
    // Snapshot the pasted-text attachments referenced in this message so the SENT
    // bubble (and any later reload) can render them as expandable chips. Captured
    // BEFORE resetAttachments() clears the registry. Each content is capped so a
    // huge paste can't bloat localStorage — the agent already got the full text;
    // this copy is only for the user to read back.
    const PASTED_DISPLAY_CAP = 100_000;
    const pastedTexts = attachments
      .filter((a) => a && a.kind === "text" && text.includes(`[Pasted text #${a.id}]`))
      .map((a) => {
        const full = a.content != null ? String(a.content) : "";
        return full.length > PASTED_DISPLAY_CAP
          ? { id: a.id, content: full.slice(0, PASTED_DISPLAY_CAP), truncated: true }
          : { id: a.id, content: full };
      });
    const painted = isQueued ? null : appendUser(text, { mid, attachments: pastedTexts });
    // Capture the pre-turn graph so /revert can undo this turn's edits in one step.
    captureGraphSnapshot(mid, text);
    showThinking();
    input.value = "";
    input.style.height = "auto";

    // Resolve attachment chips referenced in this message (the user may have
    // deleted some), then clear the registry for the next message.
    const referenced = (a) => text.includes(a.token || `[Image #${a.id}]`);
    const refImgs = attachments.filter((a) => a.kind === "image" && text.includes(`[Image #${a.id}]`));
    const refTexts = attachments.filter((a) => a.kind === "text" && text.includes(`[Pasted text #${a.id}]`));
    const refVideos = attachments.filter((a) => a.kind === "video" && referenced(a));
    const refFiles = attachments.filter((a) => (a.kind === "textfile" || a.kind === "workflow") && referenced(a));
    const refUploads = attachments.filter((a) => a.kind === "file" && referenced(a));
    resetAttachments();
    const pending = [...refImgs, ...refVideos, ...refFiles, ...refUploads];
    if (pending.length) await Promise.all(pending.map((a) => a.ready));
    // Paint the message's media. For a queued send this runs later, inside
    // materialize() (at dequeue), so the bubble + its images land together at the end.
    const paintMedia = () => {
      for (const a of refImgs) if (a.dataUrl) paintImage(a.dataUrl, a.name);
      for (const a of refVideos) if (a.ref) paintVideo(imageViewUrl(a.ref), a.name);
    };
    if (!isQueued) paintMedia();

    // Compose the text the AGENT receives. Pasted text and text/workflow files
    // expand inline (in a labeled fence). Images (chips + @input:/@node: mentions)
    // are delivered as inline image blocks; video/binary uploads are delivered as
    // input/ paths the agent can wire or process. A short note lists chip paths.
    let sendText = text;
    for (const a of refTexts) sendText = sendText.split(`[Pasted text #${a.id}]`).join(a.content);
    for (const a of refFiles) {
      const lang = a.kind === "workflow" ? "json" : "";
      const head =
        a.kind === "workflow" && a.isWorkflow
          ? `ComfyUI workflow “${a.name}” (you can load, analyze, or merge it into the canvas):`
          : `File “${a.name}”:`;
      const block = `\n\n${head}\n\`\`\`${lang}\n${a.content}\n\`\`\``;
      sendText = sendText.split(a.token).join(block);
    }
    const imageRefs = await collectImageRefs(text, refImgs);
    if (refImgs.length) {
      const lines = refImgs.map((a) => `#${a.id}${a.inputRef ? ` (input/${a.inputRef})` : ""}`).join(", ");
      sendText += `\n\n[Attached image(s) ${lines} — shown inline below.]`;
    }
    const mediaUploads = [...refVideos, ...refUploads];
    if (mediaUploads.length) {
      const lines = mediaUploads
        .map((a) => `${a.token} ${a.inputRef ? `→ input/${a.inputRef}` : `(${a.name} — upload failed)`}`)
        .join("\n");
      sendText +=
        `\n\n[Attached media in ComfyUI's input/ folder (not viewable inline — load via a ` +
        `Load Video/file node or pass the path to the comfyui tools):\n${lines}]`;
    }

    // Ground a brand-new chat: if the open workflow was never saved, save it
    // first so the agent works from a real file (Ctrl+S / reload behave).
    if (freshChat) {
      const saved = await groundUnsavedWorkflow();
      if (saved) appendSystem(`Saved your workflow as “${saved}” — grounded base for the agent.`);
    }
    // Stamp where the user is — workflow + opened subgraph — so the agent
    // gets the context without asking.
    let viewing = { scope: "root" };
    try {
      viewing = describeActiveGraph(getGraphCtx().graph);
    } catch {
      // graph unavailable — send without subgraph context
    }
    const context = {
      workflow: getWorkflowTitle(),
      ...(viewing.scope === "subgraph" ? { subgraph: viewing.title } : {}),
    };
    // Surface any MANUAL canvas edits the user made since the agent's last turn,
    // prepended to the agent-facing text only (the visible `text` is untouched).
    const changeBanner = manualChangeBanner();
    if (changeBanner) sendText = changeBanner + sendText;
    // Track delivery: trackSend marks "Sending…", then the working ack flips it
    // to "✓ Seen" (or a timeout / closed socket flips it to "Not delivered").
    // `text` (the raw composer text) is kept so ✎ can restore it for editing.
    if (isQueued) {
      // Queued: hand trackSend a materializer that paints this message (bubble +
      // media) at the END of the chat when the agent finally dequeues it.
      const materialize = () => {
        appendUser(text, { mid, attachments: pastedTexts });
        paintMedia();
      };
      trackSend(mid, null, { text: sendText, context, images: imageRefs }, text, materialize);
    } else {
      trackSend(mid, painted.statusEl, { text: sendText, context, images: imageRefs }, text);
    }
  });

  input.addEventListener("keydown", (ev) => {
    if (!menuPop.hidden && menuItems.length) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        moveSel(1);
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        moveSel(-1);
        return;
      }
      if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        pickMenuItem(menuItems[menuSel]);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        hideMenu();
        return;
      }
    }
    // Double-Esc (two within 600ms, menu closed, not mid-history-nav) rewinds the
    // last turn. A single Esc falls through to its normal behavior below.
    if (ev.key === "Escape" && menuPop.hidden && histIdx === -1) {
      const now = performance.now();
      if (now - lastEscAt < 600) {
        lastEscAt = 0;
        ev.preventDefault();
        rewindLastTurn();
        return;
      }
      lastEscAt = now;
    }
    // ↑ recalls your previous sent message (when already navigating, or from the
    // very start of the composer so it never hijacks normal line-up movement);
    // ↓ walks forward / restores your draft. Esc bails out to the draft.
    if (ev.key === "ArrowUp" && (histIdx !== -1 || (input.selectionStart === 0 && input.selectionEnd === 0))) {
      if (recallPrev()) {
        ev.preventDefault();
        return;
      }
    }
    if (ev.key === "ArrowDown" && histIdx !== -1) {
      if (recallNext()) {
        ev.preventDefault();
        return;
      }
    }
    if (ev.key === "Escape" && histIdx !== -1) {
      ev.preventDefault();
      histIdx = -1;
      setComposerValue(histDraft);
      return;
    }
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  // Ctrl+C / Cmd+C interrupts a running turn. Only when no text is selected
  // (so copy still works) and a turn is actually in flight. Scoped to the panel
  // via bubbling — it won't hijack Ctrl+C elsewhere in ComfyUI.
  root.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "c" || ev.key === "C")) {
      const hasSelection = (window.getSelection?.()?.toString() ?? "").length > 0;
      if (!hasSelection && thinkingEl) {
        ev.preventDefault();
        if (client.sendFrame({ type: "interrupt" })) {
          hideThinking();
          appendSystem("Interrupted.");
        }
      }
    }
  });

  input.addEventListener("blur", () => setTimeout(hideMenu, 150));
  // Auto-grow the textarea up to its CSS max-height.
  input.addEventListener("input", () => {
    histIdx = -1; // a real edit exits message-history navigation
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    refreshMenu();
  });

  // Dismiss the header/picker dropdowns when clicking anywhere outside them
  // (not just on the trigger or an option). Uses mousedown so it settles before
  // an option's own click handler runs. The completion menu keeps its own
  // blur-based dismissal.
  //
  // CAPTURE PHASE (third arg `true`) is load-bearing: ComfyUI's LiteGraph canvas
  // calls stopPropagation() on its pointer/mouse events, so a bubble-phase
  // document listener never sees clicks on the canvas — the dropdown would only
  // close when clicking inside the panel. Capturing runs on the way DOWN to the
  // target, before LiteGraph can swallow the event, so a click ANYWHERE (canvas,
  // toolbar, other widgets) dismisses the dropdown.
  function onDocPointerDown(ev) {
    const t = ev.target;
    if (!settingsBox.hidden && !settingsBox.contains(t) && !status.contains(t)) {
      settingsBox.hidden = true;
    }
    if (!histPop.hidden && !histPop.contains(t) && !historyBtn.contains(t)) {
      histPop.hidden = true;
    }
    if (!modelPop.hidden && !modelPop.contains(t) && !modelChip.contains(t)) {
      modelPop.hidden = true;
    }
  }
  document.addEventListener("mousedown", onDocPointerDown, true);
  // Background-tab safety for streamed replies: requestAnimationFrame (which drives
  // the typewriter + finalize) is paused while the tab is hidden. When the tab goes
  // hidden, synchronously finalize any reply whose commit already arrived so it never
  // gets stranded as an empty cursor bubble; when it returns, resume the typewriters.
  function onVisibilityChange() {
    if (document.hidden) {
      for (const s of [...streamBubbles.values()]) {
        if (s.commitText != null) finalizeStream(s);
      }
    } else {
      for (const s of streamBubbles.values()) kickStreams(s);
    }
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Reload restore: repaint the chat this tab was last showing. The agent's
  // memory continues automatically — either the orchestrator's agent for this
  // (stable) tab id is still alive, or hello's `resume` (the session id kept in
  // sessionStorage) rehydrates it from disk after an orchestrator restart.
  (function restoreLastThread() {
    try {
      const cur = ssGet(CURRENT_THREAD_KEY);
      const t = cur ? threads.find((x) => x.id === cur) : null;
      if (!t || !t.msgs?.length) return;
      thread = t;
      resetFeed();
      for (const m of t.msgs) {
        if (m.role === "user") paintUser(m.text, { attachments: m.attachments });
        else if (m.role === "agent") paintAgent(m.text);
        else if (m.role === "card") paintCard(m);
      }
      renderTodo(t.todos || []); // restore this thread's plan into the tray
    } catch {
      // Corrupt/absent state — start clean.
    }
  })();

  // ---- Settings dialog → live panel hooks ----
  // Registered now that the runtime + connect functions exist. Each applier is
  // idempotent (no-ops when the value already matches) so a setSetting→onChange
  // echo can't loop. Cleared in destroy() so a stale closure can't drive a torn-down
  // panel; the most-recently-mounted panel owns the hooks.
  panelHooks.applyBackend = (id) => {
    if (!id || id === selectedBackend) return;
    appendSystem(`Default backend → ${BACKEND_LABELS[id] || id}.`);
    // Route through connectBackend, which CENTRALLY seeds prefs from the new
    // backend's group before connecting (same path as the chips / model-popover
    // provider row) — exactly ONE connect, and the single post-handshake catalog
    // push carries the new backend's values. No set_options is sent here.
    connectBackend(id);
  };
  panelHooks.applyModel = (id) => {
    const next = (id || "").trim();
    // Blank = "Auto (let the agent pick)" → CLEAR the forced model live: un-pin so a
    // fresh/continued session uses the agent's own default. Keep a valid display id;
    // the chip shows "Auto".
    if (!next) {
      if (prefs.modelAuto) return;
      prefs.modelAuto = true;
      if (!prefs.model) prefs.model = pickDefaultModel(modelCatalog);
      savePrefs(prefs);
      refreshModelChip();
      client?.sendFrame?.({ type: "set_options", model: null, effort: prefs.effort ?? null });
      appendSystem("Model → Auto (the agent picks).");
      return;
    }
    if (next === prefs.model && !prefs.modelAuto) return;
    prefs.model = next;
    prefs.modelAuto = false;
    prefs.userSet = true;
    savePrefs(prefs);
    refreshModelChip();
    client?.sendFrame?.({ type: "set_options", model: next, effort: prefs.effort ?? null });
    appendSystem(`Model → ${modelLabel(modelCatalog, next)}.`);
  };
  panelHooks.applyEffort = (eff) => {
    const next = eff || undefined;
    if (next === prefs.effort) return;
    prefs.effort = next;
    prefs.userSet = true;
    savePrefs(prefs);
    refreshModelChip();
    client?.sendFrame?.({ type: "set_options", effort: prefs.effort ?? null });
    appendSystem(next ? `Effort → ${effortMeta(next).label}.` : "Effort → model default.");
  };
  panelHooks.applyBridgeUrl = (url) => {
    const u = (url || "").trim();
    if (!u || u === urlInput.value.trim()) return;
    urlInput.value = u;
    saveBridgeUrl(u);
    if (client.isConnected()) {
      client.setUrl(u);
      appendSystem(`Bridge URL → ${u} (reconnecting).`);
    }
  };
  panelHooks.applyAutoConnect = (on) => {
    const cur = !!lsGet(AUTOCONNECT_KEY);
    if (on === cur) return;
    lsSet(AUTOCONNECT_KEY, on ? "1" : null);
    if (on && !client.isConnected()) connectAgent();
  };
  panelHooks.applyStallConfig = () => sendStallConfig();
  panelHooks.requestSecret = (envKey, friendly) => {
    if (!client.isConnected()) {
      appendSystem(
        `To set your ${friendly} token, connect the Agent first (click Connect), then choose “Set ${friendly} token…” again. ` +
          `Tokens are stored securely by the orchestrator — never in ComfyUI settings.`,
      );
      try {
        window.alert(`Connect the Agent first (open this panel → Connect), then set your ${friendly} token.`);
      } catch {}
      return;
    }
    pendingSecretRequest = { key: envKey, friendly };
    const sent = client.sendUserMessage(
      `Please securely store my ${friendly} API token. Call panel_request_secret now for the built-in "comfyui" ` +
        `MCP server with target_kind "env" and key "${envKey}", labeled "${friendly} API token" — so I can paste it ` +
        `into the masked field. Do not ask any clarifying questions; just open the secure input.`,
    );
    if (sent) {
      appendSystem(
        `Opening a secure field to set your ${friendly} token — paste it into the masked input below. ` +
          `It goes straight to the agent's secure store, never into ComfyUI settings, logs, or chat history.`,
      );
    } else {
      pendingSecretRequest = null;
      appendSystem(`Couldn't reach the agent to set your ${friendly} token — make sure it's connected, then try again.`);
    }
  };

  // On load, only auto-connect if a bridge is already up (you started the
  // orchestrator yourself, or another tab did). Otherwise sit idle behind the
  // Connect button — we never start a process without an explicit click.
  // Evaluate provider readiness on open (independent of the connect decision
  // below): shows the onboarding card if NEITHER provider is signed in, and
  // auto-picks a ready provider if the saved pick isn't usable.
  void loadBackends();

  (async () => {
    // If a restart we triggered reloaded the page, finish the autonomous resume:
    // respawn the orchestrator and let onStatus(connected) nudge the agent.
    if (ssGet(REBOOT_KEY)) {
      connectAgent();
      return;
    }
    // Sticky auto-connect: the user connected before and didn't Disconnect, so
    // reconnect on open — respawning the orchestrator if it died (e.g. ComfyUI
    // was rebooted). This is what makes "open the panel after a reboot → it's
    // back" work without a manual Connect click. The "Auto-connect on load" setting
    // opts into the same behavior even for a user who hasn't manually connected yet.
    if (lsGet(AUTOCONNECT_KEY) || getSetting(SETTING_AUTOCONNECT) === true) {
      connectAgent();
      return;
    }
    try {
      const res = await api.fetchApi("/comfyui_mcp_panel/status");
      const data = await res.json().catch(() => ({}));
      if (data?.running) client.start();
    } catch {
      // No status route — leave the Connect button for the user to drive.
    }
  })();

  return {
    root,
    destroy() {
      try {
        recognition?.stop();
      } catch {
        // recognition already stopped
      }
      document.removeEventListener("mousedown", onDocPointerDown, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      try {
        api.removeEventListener("executed", onExecuted);
        api.removeEventListener("execution_success", onExecutionSuccess);
        api.removeEventListener("execution_start", onExecutionStart);
        api.removeEventListener("executing", onExecuting);
        api.removeEventListener("execution_error", onExecError);
        api.removeEventListener("reconnecting", onComfyReconnecting);
        api.removeEventListener("reconnected", onComfyReconnected);
      } catch {
        // already detached
      }
      // Drop the Settings→panel hooks so the dialog can't drive a torn-down panel
      // (a freshly-mounted panel re-registers them).
      panelHooks.applyBackend = null;
      panelHooks.applyModel = null;
      panelHooks.applyEffort = null;
      panelHooks.applyBridgeUrl = null;
      panelHooks.applyAutoConnect = null;
      panelHooks.applyStallConfig = null;
      panelHooks.requestSecret = null;
      client.destroy();
      if (liveBridgeClient === client) liveBridgeClient = null;
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Registration. Resolve `app`/`api` from window.comfyAPI and register the
// extension only once they're ready — deferring past Vite/Rolldown's early
// module eval so a not-yet-populated shim can't throw and deadlock the loader.
// Defensive deferral contributed by @FreesoSaiFared (PR #2).
// ---------------------------------------------------------------------------
function registerExtensionWhenReady(tries = 0) {
  const comfyApp = window.comfyAPI?.app?.app || window.app;
  if (!comfyApp || typeof comfyApp.registerExtension !== "function") {
    if (tries >= 1000) {
      console.error(
        "[comfyui-mcp-panel] app.registerExtension never became available — incompatible ComfyUI frontend version.",
      );
      return;
    }
    setTimeout(() => registerExtensionWhenReady(tries + 1), 10);
    return;
  }
  app = comfyApp;
  api = window.comfyAPI?.api?.api || window.api || null;
  setupListeners();

  // TODO(v2): replace with `defineExtension({ name, setup() {...} })`.
  app.registerExtension({
    name: "comfyui-mcp.agent-panel",
    // Standard ComfyUI Settings dialog entries (persisted to comfy.settings.json).
    // Grouped under "Comfy MCP Agent". These seed the panel's runtime defaults and
    // stay in sync with the in-panel pickers; token entries are secure buttons that
    // never persist a raw value here. See panelSettingsList() above.
    settings: panelSettingsList(),
    async setup() {
      const tabId = "comfyui-mcp.agent";
      let mounted = null; // { root, destroy }

      const tabSpec = {
        id: tabId,
        title: "Agent",
        // ComfyUI ships PrimeIcons; `pi-comments` is the closest "chat" glyph.
        icon: "pi pi-comments",
        tooltip: "ComfyUI Agent Panel — your Claude session's window into this graph",
        type: "custom",
        render: (container) => {
          if (mounted) mounted.destroy();
          mounted = buildPanel();
          // Make the tab content a full-height flex column so the panel's header
          // and input pin to the edges and only the chat body scrolls (the
          // container otherwise sizes to content and the whole panel scrolls).
          container.style.height = "100%";
          container.style.minHeight = "0";
          container.style.display = "flex";
          container.style.flexDirection = "column";
          container.appendChild(mounted.root);
        },
        destroy: () => {
          mounted?.destroy();
          mounted = null;
        },
      };

      // TODO(v2): replace with `defineSidebarTab({...})` from
      // '@comfyorg/extension-api'.
      const mgr = app.extensionManager;
      if (mgr && typeof mgr.registerSidebarTab === "function") {
        mgr.registerSidebarTab(tabSpec);
      } else {
        console.error(
          "[comfyui-mcp-panel] app.extensionManager.registerSidebarTab is unavailable; " +
            "update ComfyUI to a version that exposes the extension manager.",
        );
      }

      // If WE just reloaded the page (frontend soft reload), re-open our tab so
      // the panel mounts and auto-resumes — ComfyUI's own tab-restore ran before
      // this registration, so it couldn't. Retry a few times since the sidebar
      // store may not be ready the instant setup() runs.
      if (ssGet(SIDEBAR_REOPEN_KEY)) {
        ssSet(SIDEBAR_REOPEN_KEY, null);
        let tries = 0;
        const reopen = () => {
          if (openSidebarTab() || ++tries >= 8) return;
          setTimeout(reopen, 150);
        };
        setTimeout(reopen, 120);
      }
    },
  });
}

registerExtensionWhenReady();
