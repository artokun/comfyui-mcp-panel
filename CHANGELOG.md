# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format follows
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed
- CivitAI browser filters actually respond: chips re-render on click (the sheet
  wired a rerender hook that was never defined, so they looked dead), and the
  level/base-model toggles no longer mutate the frozen module defaults
- CivitAI lightbox no longer claims "✓ Embedded ComfyUI workflow" for posts
  whose `meta.comfy.workflow` is the empty `{}` civitai sometimes emits — it
  now falls back to the API-format prompt (savable) and says which one it found

### Added
- CivitAI browser: **"See more from @creator"** in the lightbox and model
  detail, and **GitHub-style search qualifiers** — "@name terms" sets the
  creator filter (the displayed @token always owns it; deleting it clears)
  while the terms stay ranked full-text search (#86)
- CivitAI browser: **Load workflow onto canvas** (community request from
  Discord). In the lightbox, a post with an embedded UI-format ComfyUI graph
  gets a "Load onto canvas" action: confirm-overwrite when the current
  workflow has unsaved changes, then load through the same undoable path the
  agent bridge uses (snapshot → `loadGraphData` → change-tracker `checkState`,
  so one load = one Ctrl+Z). API-format-only posts say so honestly instead of
  corrupting the canvas (Save still keeps their JSON — there is no client-side
  API→UI converter). On the Workflows tab, model versions grow a
  "Load workflow onto canvas" button per downloadable workflow file: raw
  `.json` loads directly; civitai's `.zip` wrappers (780 of 844 live versions)
  are unpacked in the browser (central-directory walk +
  `DecompressionStream("deflate-raw")`, no new dependency) with a picker when
  an archive holds several workflows, under zip-bomb caps (entry count,
  per-entry and aggregate uncompressed size — a lying size header is
  re-checked after inflation; duplicate directory records aimed at one blob
  are deduped). Downloads stream through a new same-origin proxy route that
  follows civitai's 307 server-side with an SSRF guard — only https civitai
  download CDNs (civitai/B2 **and** civitai's signed Cloudflare R2 delivery
  worker, where signed-in downloads land) whose every DNS answer is a public
  address (no loopback/RFC1918/link-local/metadata, no rebinding), OAuth
  header dropped on the cross-host hop — streaming through (no buffering)
  with a 100MB cap.
  Gated files (civitai 307s the download to `/login?…reason=download-auth`,
  even on some "Public" versions) are detected deterministically and return a
  clean 401, and every download/parse/empty/API-only outcome is surfaced BOTH
  as a top-of-stack toast and an inline status line in the version sheet
  (which stays open) — with a one-click "sign in" for the gated case — so the
  action is never a silent no-op. A load reporting zero nodes is treated as a
  failure (the explorer stays open) rather than a phantom success. The
  overwrite-confirm dirty check fails CLOSED (unknown workflow state ⇒ ask),
  and the load is awaited so success/undo bookkeeping only fires once the
  graph actually landed
- CivitAI browser: **Creator filter** in the filter sheet (parity with the
  mobile app) — an empty field shows the site's top-creators leaderboard
  (ranked, with download/like counts; degrades to a friendly note when the
  endpoint balks), typing runs a debounced username search, and the picked
  creator becomes a removable pill that narrows every feed: images/videos
  (`/v1/images?username=`), media search (Meili `user.username` filter,
  escaped), and model tabs (`/v1/models?username=` — keyword+creator matches
  the keyword client-side around an API quirk). Favorites shows the filter as
  visibly ignored (your likes come from every creator); Reset clears it
- CivitAI browser: **like/unlike toggle** — heart on card hover and in the
  lightbox (signed out, the heart opens sign-in); likes mirror into a **default
  likes collection** picked (or created) in the new account sheet
- CivitAI browser: sub-nav under the tabs with **debounced (500ms) search on
  every tab** (Meili for media, REST query for models, client-side for
  favorites) behind a blur+spinner overlay; **Favorites shows ALL your likes**
  (no browsing-level gate on your own reactions) with All/Images/Videos filter
  chips; all feeds page 100 at a time with scroll auto-load
- CivitAI OAuth scope now includes SocialWrite + CollectionsRead (reactions and
  collections 403'd under the old scope — existing sign-ins re-consent once)
- CivitAI browser: clicking an image/video opens a full-screen LIGHTBOX — media
  on the left, details on the right (author, stats, prompt/negative, parameters,
  share-with-agent / save-workflow actions), with arrow-key/wheel paging and Esc
- **panel-owned sessions (default)** — the conversation and agent memory now
  persist while you switch, save, rename, or create workflows; the agent is
  mechanically told which canvas it operates on (one-shot context, no memory
  tools). The live agent instance is rebound across tab ids (no respawn), so
  even in-memory local backends keep their history. Settings → General →
  "Conversation follows the panel" restores the legacy per-workflow mode

### Changed
- the agent-feed gate is now **Deafen** (was Mute), with ear / slashed-ear icons —
  "deafen" says what it does (the agent stops HEARING canvas events; your typed
  messages still go through), the old speaker icon read as audio mute. The saved
  setting carries over (same storage key).

## [0.8.2] - 2026-07-14

### Added
- graph_serialize command — full-fidelity live-canvas capture

### Fixed
- replace expired invite with the permanent link (#82)


## [0.8.1] - 2026-07-14

### Fixed
- keyed-provider hints lead with the API Keys card; custom endpoint advertises DeepSeek BYOK


## [0.8.0] - 2026-07-12

### Added
- utility strip (header row 2) — Mute/Blind move off the composer; Civitai explorer parked
- Clear button on credential slot rows — revoke a saved key (comfyui-mcp#203)
- A2UI chat cards — validated interactive UI cards in chat (lit renderer) — ported from MichaelDanCurtis fork (#79)
- per-workflow agent sessions + provider on/off + thread rename migration — ported from MichaelDanCurtis fork (#80)
- Grok + Kimi providers, in-panel OAuth sign-in, experimental-backend gating — ported from MichaelDanCurtis fork (#81)

### Fixed
- QR encodes the https lander URL — phone cameras refuse ws:// ("No usable data found")


## [0.7.3] - 2026-07-09

### Added
- the agent now keeps working when you switch to another sidebar tab (Assets,
  Queue, …) — the panel detaches instead of tearing down, so the connection,
  session, and chat survive; replies that land while you're away are waiting
  when you come back
- agent activity badge on the sidebar tab icon: green spinner while a turn is
  in flight, red dot when it finished while you weren't looking (clears on
  open), plain chat glyph when idle

### Fixed
- rapid sidebar tab switching no longer causes any bridge reconnect churn —
  the panel is built once per page instead of once per tab open


## [0.7.2] - 2026-07-09

### Fixed
- the "Control via Mobile app (beta)" gate now actually hides the header QR
  button when off — the `hidden` attribute was overridden by the icon-button's
  `display: flex` CSS; switched to inline display toggling


## [0.7.1] - 2026-07-09

### Added
- "Remote control" QR — pair a phone (LAN default / Internet opt-in) (#78)
- Settings: "Control via Mobile app (beta)" toggle (default off) gating the QR
  pair button, plus "Get the beta app" tester links (iOS TestFlight / Android
  Firebase App Distribution — buttons show "coming soon" until channels open)

### Fixed
- bridge-driven graph mutations are now actually undoable — the dispatcher
  registers each successful command with ComfyUI's ChangeTracker
  (checkState()), so one command = one Ctrl+Z step
- e2e suite is hermetic on dev boxes (13/13): fixtures stub orchestrator
  discovery + panel settings so a live agent can't hijack specs or have its
  settings polluted by them


## [0.7.0] - 2026-07-09

### Added
- graph_auto_layout — topological auto-layout with group + reroute handling,
  barycenter ordering, dry-run planner; pure engine module in web/js/lib/ (#75)
- graph_connect auto-match by type + full slot diagnostics on failure —
  wildcard/COMBO/widget ranking, ambiguity guard, replaced_link reporting (#76)
- graph_query executor — filter/traverse/aggregate the live canvas (#169 panel side) (#77)
- Custom endpoint chip + Settings, all token buttons agent-free (#162 panel side) (#74)
- llama.cpp backend chip + setup card (#161 panel side) (#73)

### Fixed
- comboSignature — text-safe NUL separator; raw NUL byte made git/scanners treat the bundle as binary
- clear both Python findings from the release scan (#72)


## [0.6.9] - 2026-07-09

### Added
- LM Studio backend chip + setup card (#160 panel side) (#71)
- Discord + Need-help buttons + version-sync guard (recover stranded 0.6.8) (#68)

### Fixed
- Fable 5 was invisible — dedupe pinned claude-* ids by resolvedModel, not pattern (#70)


## [0.6.8] - 2026-07-08

### Added

- **Discord community + one-tap "Need help?" in Settings → About.** Alongside
  ⭐ Star on GitHub there's now **💬 Join the Discord** and a **🆘 Need help?**
  button that copies a short diagnostics summary (panel version, backend,
  ComfyUI version, page URL, user-agent) to the clipboard and opens the Discord,
  so a stuck user pastes exactly what's needed to help fast. README links the
  Discord too. Invite: https://discord.gg/TtQpf96BHS

### Changed

- **Panel version can no longer drift out of the diagnostics blob.** The JS
  `PANEL_VERSION` is now bumped together with `pyproject.toml` via
  `node scripts/set-version.mjs <v>`, and CI + the publish gate FAIL if the two
  disagree — a stale version can't be shipped.

## [0.6.7] - 2026-07-08

### Changed

- **Local (Ollama) backend now defaults to the fine-tuned `gemma4-comfyui-mcp`
  ladder**, with a one-time migration of the stale `gemma4:e4b` default to the
  fine-tune. (#62, #66)

## [0.6.6] - 2026-07-08

### Fixed

- **Switching to an already-open workflow tab (`panel_open_workflow`) left the
  canvas frozen on the previous graph, and earlier attempts corrupted tab
  buffers.** Root cause (confirmed by live in-browser debugging): the frontend
  store's `openWorkflow` sets the tab *active* but does **not** load the graph
  onto the canvas — that repaint normally rides the frontend's workflow
  *service* tab-switch, which the panel can't reach (it's a Vue composable, not
  exposed on the store or `window`). So switching among open tabs showed the
  wrong graph (#65), and prior in-place-load workarounds clobbered a tab's live
  buffer, where a Save would then overwrite the good file (#63, #64). Fix: after
  `openWorkflow`, force the repaint the way a real tab-click does — load the
  target's own live buffer (`changeTracker.activeState`, so unsaved edits are
  preserved, not the on-disk copy) into **its** tab via
  `app.loadGraphData(state, true, true, target)` (the 4th arg associates the
  load with the target so no duplicate "Unsaved Workflow" tab spawns). Verified
  live: switching among 12/39/126-node tabs repaints correctly each time with no
  duplicate tabs and no cross-tab clobber. NOTE: `getWorkflowByPath` returns the
  *same object* as the open-tab instance, so the `find()` reorder proposed in
  #63 was a no-op red herring (it only regressed switching, per #65) — reverted
  and not shipped.

## [0.6.5] - 2026-07-07

### Fixed

- **Clicking a chat image on a remote pod opened a blank tab.** Bridge-delivered
  images arrive as `data:` URIs, and Chrome blocks top-frame navigation to
  `data:` — the zoom click's new tab stayed on `about:blank`. Data URIs are now
  re-wrapped as same-origin `blob:` URLs before opening (plain `/view` URLs on
  local ComfyUI are unaffected).

## [0.6.4] - 2026-07-07

### Fixed

- **Ctrl+C never interrupted the agent when focus sat outside the panel.** The
  interrupt hotkey listened on the panel root in bubble phase, so clicking the
  chat log or the canvas (focus on `<body>`) made the shortcut silently do
  nothing. It now uses a document-level capture listener gated to a turn in
  flight, with **Esc** added as a second stop key. Guards keep the global scope
  polite: Ctrl+C never steals a real copy (text selection and selected graph
  nodes win), Esc defers to the composer menu, ComfyUI dialogs, and editable
  fields outside the panel, and the listener is removed on destroy so remounts
  can't stack it. The thinking label now reads "(Esc or Ctrl+C to stop)". (#61)
- **Onboarding card never hid once shown.** The `.cmcp-onboard` base rule's
  `display:flex` beat the UA's `[hidden]` rule by cascade, so readiness updates
  that set `hidden` had no visual effect. `display:none` is now re-asserted
  under `[hidden]`, matching the existing overrides in the stylesheet. (#59,
  #60)

## [0.6.3] - 2026-07-06

### Fixed

- **Registry security-scan: stop shipping this changelog in the published
  archive.** The Registry's private YARA scan matches code-shaped literals in
  ANY file of the uploaded zip — markdown prose included. 0.6.2 (which cleared
  the SUSP_SVG tokens) was still flagged `any-code-execute` because THIS file's
  0.3.x-era entry quoted, verbatim, the process-spawn call that entry was
  documenting the removal of. `CHANGELOG.md` is now `.comfyignore`'d (it
  documents security fixes, so it will always contain such literals), and CI +
  the publish gate scan every file that still ships for process-spawn literals.
  The three remaining scanner findings (env-var reads, the local orchestrator
  port probe, and the panel's WebSocket client) are info-severity and intrinsic
  to what this pack is; per the scanner's design any finding queues the version
  for manual review, which is being requested separately.

## [0.6.1] - 2026-07-06

### Fixed

- **Reconnect wedged forever on a remote pod's `wss://` secure bridge.** On an
  https pod page, if a tab's first autoconnect raced the orchestrator's advertise
  of the secure tunnel URL (e.g. right at orchestrator startup, or a background
  tab that was already retrying before this orchestrator came up), it fell back
  to the plain unauthenticated `ws://127.0.0.1:<port>` default. Contrary to this
  file's own long-standing assumption, Chrome does **not** mixed-content-block a
  `ws://127.0.0.1` dial from an `https://` page (loopback is exempt) — so that
  fallback actually reached the real local bridge directly and got rejected for a
  missing token, then retried that SAME wrong URL forever (capped at 15s) with no
  way back to the correct tunnel short of a manual Reconnect. The reconnect loop
  now re-fetches the advertised bridge URL on every retry and switches over the
  moment one becomes available, self-healing without user action.

## [0.4.13] - 2026-07-01

### Changed

- **The connect command now prefills THIS pod's own URL on https pages** (help
  dropdown, onboarding step, no-agent hint) — e.g.
  `npx -y comfyui-mcp@latest connect https://<this-pod>`, read from
  `window.location`. Running it with the URL lets the orchestrator open a secure
  `wss://` bridge that works in **every browser** (Safari / Firefox / Comet), not
  just Chrome-with-a-prompt. Composes with the per-shell copy block (0.4.12); bare
  form still shown on http/localhost. Pairs with comfyui-mcp 0.23.4.

## [0.4.12] - 2026-07-01

### Changed

- **Per-shell copy for the `connect` command.** The Settings connect help and the
  onboarding "start the agent" step now offer the command as **three labeled copy
  buttons — PowerShell, Command Prompt, macOS / Linux** — with your detected OS
  preselected. PowerShell copies the `cmd /c "npx -y comfyui-mcp@latest connect"`
  form (which sidesteps the `npx.ps1` execution-policy trap), while Command Prompt
  and bash/zsh copy the bare `npx -y comfyui-mcp@latest connect`. Replaces the
  single OS-guessed command + Windows caveat, so a copy always pastes-and-runs in
  the shell you're actually using.

## [0.4.11] - 2026-07-01

### Added

- **Secure bridge for remote pods.** When a local orchestrator drives this pod via
  `connect` over https, it advertises a token-gated `wss://` bridge URL (a
  Cloudflare tunnel) to two new routes — `POST /comfyui_mcp_panel/advertise_bridge`
  and `GET /comfyui_mcp_panel/bridge_url`. On an **https** page the panel now fetches
  that URL on Connect and uses it instead of the plain `ws://127.0.0.1:9180` default
  — which browsers block from a secure origin (mixed content / Private Network
  Access). No URL to paste; works in any browser. Local/http pages are unchanged.
  Pairs with comfyui-mcp 0.23.4.

## [0.4.10] - 2026-07-01

### Changed

- **The "run the agent on YOUR machine" hint, the onboarding step, and the help
  dropdown now show `npx -y comfyui-mcp@latest connect`** — replacing the deprecated
  `--panel-orchestrator` flag, and pinned to `@latest` so users pick up new releases.
  `connect` (no URL) starts the orchestrator and auto-targets whatever ComfyUI the
  panel is served from (local or a remote pod).
- README / pyproject positioning: **"the local-first, agent-native control plane for
  ComfyUI"**.

## [0.4.9] - 2026-07-01

### Added

- **The agent now sees ComfyUI's validation errors the moment you do.** A
  `⚠️ GRAPH VALIDATION` block is injected at the agent's turn start — populated from
  `app.lastNodeErrors`, the same data behind the frontend's "N ERRORS" panel (missing
  models, `value_not_in_list` / invalid widget values, broken links) — plus the last
  runtime execution error, labeled distinctly. Previously the agent only learned of a
  broken graph if it independently re-ran. It mirrors the existing `⟳ MANUAL CANVAS
  CHANGES` injection and is **event-driven**: shown only when errors exist AND the
  state changed since the last injection (no nagging on mid-build graphs, no token
  cost on clean/chat turns). Pairs with comfyui-mcp 0.23.2 (whose `validate_workflow`
  now reports out-of-list combo values as errors, matching this block).

## [0.4.8] - 2026-07-01

### Fixed

- **Provider switcher no longer falsely says "CLI not installed."** Readiness was
  probed only by the ComfyUI-side Python (`shutil.which` + on-disk logins), which
  runs wherever ComfyUI runs — behind a remote pod that's a box with no provider
  CLIs, no logins, and no visibility into Claude's SDK (which has no CLI at all),
  so every provider read as unavailable. The panel now prefers the **orchestrator's**
  readiness (the machine that actually runs the agents), pushed as a `{type:"backends"}`
  frame on connect, and a successful "ready" ack marks the live backend ready outright.
  Pairs with comfyui-mcp 0.23.1.

### Changed

- **Connect dropdown shows `npx -y comfyui-mcp connect`** (not the old
  `--panel-orchestrator`, which read as "local only"). With browser-host targeting
  the panel hands the orchestrator whatever ComfyUI you're viewing — local or a remote
  pod — so the bare `connect` is the canonical one-command start. OS-aware (`cmd /c`
  wrapper on Windows, where a bare npx line can trip PowerShell's exec policy).

## [0.4.7] - 2026-07-01

### Added

- **Remote ComfyUI URL (drive a RunPod / remote instance).** A new
  *Settings → Comfy MCP Agent → General → Remote ComfyUI URL (advanced)* field points the
  agent at a remote ComfyUI (e.g. `https://xxxxxxxx-8188.proxy.runpod.net`) instead of
  localhost. When set, it's sent on Connect and the orchestrator spawns its MCP with
  `COMFYUI_URL` targeting the remote server (queue, models, history, uploads all go there);
  for a non-loopback URL `COMFYUI_PATH` is deliberately omitted so the agent runs in clean
  remote mode (no local-FS/remote-API split). Blank = local (unchanged default). The URL is
  validated server-side (`http`/`https` + host) and applied on the next Connect. Your live
  canvas still follows whichever ComfyUI you opened in the browser. (MCP already supported
  remote via `COMFYUI_URL`/`isRemoteMode`; this exposes it from the panel — no MCP change.)
- **External/local orchestrator mode** (Settings → General → "Use external/local
  orchestrator (advanced)"). When ON, Connect no longer asks the ComfyUI host to
  spawn an orchestrator — it connects the bridge WebSocket straight to the
  configured Bridge URL (default `ws://127.0.0.1:9180`) and treats the host
  `/comfyui_mcp_panel/connect` POST as skipped. This lets an agent running on the
  USER's machine (`npx -y comfyui-mcp connect <url>`) drive a REMOTE ComfyUI (e.g.
  a RunPod pod with no Node/agent) — no agent login on the box, no tunnel. If no
  orchestrator answers on the bridge, the panel surfaces a clear "start it locally"
  hint with the exact `npx` command. OFF by default, so the co-located autospawn
  path is byte-for-byte unchanged. The toggle persists via ComfyUI settings.

### Changed

- **Auto-target the ComfyUI you're on — no `connect <url>`.** The panel is served
  by ComfyUI, so it sends the URL it was loaded from (`window.location`) in its
  hello; the orchestrator retargets to it and picks local vs remote mode from the
  host. So `npx -y comfyui-mcp --panel-orchestrator` just works for both a local
  ComfyUI and a remote (RunPod proxy) one — the start command everywhere is now the
  bare `--panel-orchestrator`. The Remote ComfyUI URL setting stays as an advanced
  override (subpath / tunnel cases the browser origin can't express). Requires
  `comfyui-mcp` ≥ 0.23.0.
- **Single-port multi-provider.** All providers now share ONE bridge
  (`ws://127.0.0.1:9180`) instead of a port per provider (claude 9180 / codex 9181
  / gemini 9182). The panel names its chosen provider in the `hello` handshake
  (`backend` field), and one orchestrator routes each tab to the right backend.
  Switching provider re-handshakes on the same bridge (fresh session for the new
  provider — agent sessions aren't portable across providers). Requires the paired
  `comfyui-mcp` single-port orchestrator.
- **Provider switch replays the transcript.** Because a switch starts a fresh
  session on the new provider, the panel now sends the visible user+agent
  transcript as one-shot `context` on the first message after a switch, so the new
  provider picks up the conversation (internal thinking / tool history don't carry
  — they aren't portable). Capped from the end so a long chat can't blow context.
- **External/local orchestrator is now the only mode.** Since the pack can no
  longer spawn the orchestrator, Connect always dials the bridge directly (never
  the host `/connect` POST). The "Use external/local orchestrator" toggle is
  retained for back-compat but is now a no-op.
- **The pack is now a pure frontend extension — it never spawns the orchestrator.**
  Every published registry version `0.1.0`–`0.4.6` sat `NodeVersionStatusFlagged`
  on the Comfy Registry (so the registry computed no `latest_version` and
  ComfyUI-Manager could only offer the nightly channel). The cause was
  `__init__.py` calling `subprocess.Popen([… "npx", "-y", "comfyui-mcp" …])` to
  auto-start the orchestrator: the registry standards
  (https://docs.comfy.org/registry/standards) forbid a node spawning processes /
  installing-and-running packages at runtime, and the static (Bandit) scanner
  flags it (`B404`/`B603`) regardless of runtime guards. `__init__.py` no longer
  imports or calls `subprocess` (nor `psutil`, process kills, or lockfiles); it
  only serves the panel JS and exposes **read-only** status / discovery routes.
  The remote-URL helpers are kept (they shape the start command, not a spawn).

### Removed

- In-process auto-spawn / reclaim / soft-reload / hard-restart of the orchestrator.
  The orchestrator now always runs **out-of-band** — external-orchestrator mode is
  effectively the only mode. Start it once (`npx -y comfyui-mcp connect <url>` for a
  remote instance, or `--panel-orchestrator` locally) and the panel connects to the
  bridge automatically and keeps retrying until it's up. The `/connect` etc. routes
  still exist but report status and return that command instead of launching anything.

### Added

- CI **security-scan parity** step: `bandit -r . -s B101,B112,B311 -ll` mirrors the
  Comfy Registry scanner (public stand-in `christian-byrne/custom-nodes-security-scan`)
  so a would-be-flagged release fails CI before it can publish. `.comfyignore` now
  also drops dev-only `scripts/` and `.githooks/` from the published archive.

### Fixed

- **Panel remount no longer silently swaps provider or drops the conversation
  (#43).** Navigating away from the agent panel and back (a remount) used to
  re-seed the runtime backend from the durable default and reconnect on Claude —
  swapping an active Codex session and losing its thread. The last *runtime* pick
  (session-only chip switch) now wins over the durable default on remount, so the
  panel reconnects on the same provider; combined with single-port + the
  orchestrator-owned per-(tab, backend) session, the conversation **resumes**
  instead of starting fresh. (A Settings-dialog change to the default still takes
  effect — it already writes the runtime pick.)
- **Stale Bridge URL made Connect dial a dead port.** A legacy per-backend Bridge
  URL (e.g. a migrated custom port) could survive into the single-port layout and
  send the panel to a phantom port — the "connecting… then red" flash. Bridge-URL
  resolution now reads one setting (default `ws://127.0.0.1:9180`) and self-heals a
  polluted value.

## [0.4.6] - 2026-06-29

### Added

- **Graph navigation executors** (for the panel agent's new read tools):
  - `graph_outline` — a compact, dependency-ordered TEXT map of the open graph
    (topologically sorted, each node with its key widgets + `←`/`→` wiring, plus a
    groups index). Built to be read top-to-bottom by an LLM instead of dumping JSON.
  - `graph_find_nodes` — search every node on the open graph by type, title, input/
    output port, widget name, widget value, `is_output`, `is_subgraph`, or mode (or a
    free-text query across all), returning enriched matches with a `matched_on` reason.
  - `graph_subgraph_group` — wrap an existing group's nodes into one subgraph node in a
    single step (resolves the group by title/id and computes its geometric membership).
- `graph_get_state` groups now report their member `node_ids` (groups are geometric —
  they don't own nodes), so a region can be wrapped/toggled without reconstructing
  membership by hand.
- **Manual-edit awareness.** The graph the agent leaves at each turn's end is snapshotted;
  when the user sends their next message, the live graph is diffed against it and a compact
  "⟳ MANUAL CANVAS CHANGES" list (node add/remove, mode bypass/mute, widget-value, title,
  and connection changes) is prepended to the agent's input — so a hand edit between turns
  (e.g. bypassing a node) never catches the agent unaware. Visible chat text is untouched.

### Fixed

- Agent-facing error messages now name agent tools (`panel_get_graph`/`panel_search_nodes`)
  instead of the internal `graph_get_state` command.
- `graph_find_nodes` no longer throws on exotic widget values — widget stringification is
  guarded (a BigInt or circular/custom value would have failed the whole search call).
- `graph_outline` topological sort uses an index cursor instead of `Array.shift()`, keeping
  it linear (was O(n²)) on large/flat graphs.

## [0.4.5] - 2026-06-29

### Added

- **Run to node (partial execution).** `graph_run` now accepts `to_node_id`: render only
  that output node's branch (the node plus everything upstream) via ComfyUI's native
  partial execution (`app.queuePrompt(0, batch, partial_execution_targets)`), skipping
  every other output branch — fast/cheap previewing or debugging of part of a big graph.
  The target must be a root-level **output** node (SaveImage/PreviewImage/SaveVideo/…);
  non-output or subgraph-nested targets are rejected with actionable guidance instead of
  silently running the whole graph. Node summaries now tag output nodes `is_output:true`,
  and the command line shows `→ node N` when a partial run was queued. Omitting
  `to_node_id` is byte-identical to the previous full-graph run. Pairs with the MCP
  `panel_run` `to_node_id` parameter and the `debug-render` skill (comfyui-mcp ≥ 0.21.0).

### Fixed

- **Run-result display crash.** A blocked run that returns `{ error }` (the new
  run-to-node rejection) no longer throws in the activity line — `describeCommand` guarded
  the `JSON.stringify(node_errors)` path and now shows the returned guidance for `error`
  and the node-error JSON only when `node_errors` is present.

## [0.4.4] - 2026-06-27

### Added

- **Rich media metadata in agent pushes.** When a render's media is sent to the agent,
  the executed-event note (and a structured `metadata` field) now include each output's
  path (subfolder-relative), file size, pixel dimensions, asset-set grouping ("output K
  of N from this run" + sibling filenames, or "single output"), render duration, and
  completion time. Video storyboards add format + real frame count/fps when the payload
  carries them.
- **Provider onboarding.** Connect-time readiness detection per provider (CLI on PATH +
  a login on disk; macOS Keychain handled) via `/backends`. An onboarding card shows
  only when neither provider is signed in; the panel auto-switches to a ready provider
  when the saved pick isn't usable (saved preference untouched), and a not-ready
  provider row becomes a "set up" action that seeds a prompt to the working agent.
- **Code-block tools.** Rendered fenced code blocks get a Copy button + a persisted
  global line-wrap toggle (off by default); inline code gets Copy. Hover-gated, styled
  to match the panel.
- **Render-stall warning threshold setting** (General; default 180s, range 15–3600).
  Sent on connect (the orchestrator spawn default) and pushed **live** via a `set_config`
  frame, so changing it applies without a reconnect.

## [0.4.3] - 2026-06-27

### Fixed

- **Streamed replies now render when the ComfyUI tab is in the background.** The
  reply typewriter + its commit-finalize ran on `requestAnimationFrame`, which the
  browser **pauses in a hidden/background tab** — so if you switched away during an
  agent turn (common on long multi-stage pipeline runs), the reply never painted and
  the bubble sat empty with a stuck streaming cursor, looking like the agent was
  "stuck thinking / never draining the queue" even though the turn had finished. The
  commit now finalizes the reply **synchronously when the tab is hidden**, plus a
  `visibilitychange` handler flushes any pending reply on hide and resumes the
  typewriter on return. Foreground animation is unchanged.

## [0.4.2] - 2026-06-26

### Added

- **Subgraph rail I/O + expand/dissolve** — from inside a subgraph the agent can
  now wire an interior node to the boundary: `graph_expose_subgraph_output` /
  `graph_expose_subgraph_input` expose an interior node's output/input as a
  subgraph output/input (the host subgraph node gains the slot). `graph_get_state`'s
  `rails` now reports the input/output rail node ids + their slots, and
  `graph_connect` tolerates rail endpoints with a clear "enter the subgraph first"
  error at root. `graph_unpack_subgraph` **dissolves** a subgraph back into its
  parent (inlines the interior nodes, rewires external links) — the inverse of
  create-subgraph, Ctrl+Z-undoable.
- **Pasted text renders inline in sent bubbles** — a sent (or reloaded) user
  message no longer shows the raw `[Pasted text #N]` token. Each token is now
  replaced **inline with the actual pasted content**, rendered verbatim as plain
  text — exactly as if you had typed it (no chip or preview widget). The pasted
  content is persisted with the message (capped at 100,000 chars, marked
  truncated beyond that) so reloaded conversations re-render the full text. Tokens
  with no stored content fall back gracefully to their literal text. The raw
  `text` (with tokens) is unchanged — the agent, history, and edit/rollback still
  use it.
- **Expandable attachment chips** — composer attachments now show as a chip
  strip above the input (Claude-Code style) instead of only an opaque
  `[Pasted text #N]` token in the textarea. Each chip carries a kind icon +
  label (pasted text shows a dim char count; files show their name; images show
  a thumbnail). Click a text/pasted/file/workflow chip to expand an inline,
  read-only, scrollable monospace preview of the full content (one open at a
  time); click an image chip to see a larger thumbnail. A per-chip × removes the
  attachment and precisely strips its inline token (e.g. `[Pasted text #N]`)
  from the textarea. Purely additive — the send/resolve pipeline still resolves
  attachments by token-match against the textarea, unchanged.
- **Edit focus-follow** — when the agent changes a node's widget **value**, the
  canvas now smoothly darts to that node with 50% padding so you watch the change
  land. Once edits go quiet for ~5s, it animates back to a full fit so the whole
  graph is visible again. Scoped to value edits only (wiring and node placement
  don't move the view — those keep the existing gentle fit). Reuses the
  panel-aware "fit" insets and the native zoom easing. **On by default**; toggle
  via Settings → Comfy MCP Agent → General → **"Zoom to agent edits"**.

## [0.4.1] - 2026-06-26

### Added

- **`graph_set_node_mode`** — bypass / mute / activate a node on the live canvas
  (undo-able like every other edit), so the agent can enable a bypassed path (e.g. a
  pack's Ideogram-JSON prompt builder) instead of improvising. The graph read now
  surfaces each node's mode, so bypassed/muted nodes are visible. (#30)

### Fixed

- **Run outputs now name the FINAL result vs previews.** A run emits both preview
  images (`type:"temp"`, throwaway `/tmp` names) and the saved output (`type:"output"`,
  real filename); the panel now batches them into one event, orders finals first, and
  the note tells the agent which filename is the real saved result — so it stops citing
  a preview's temp name as the output. Applies to images and videos. (#31)

## [0.4.0] - 2026-06-26

### Added

- **Application Settings page** under ComfyUI Settings → **"Comfy MCP Agent"**, split
  into per-backend groups so each provider owns its own defaults (#20, #21, #27, #29):
  - **General** — Default agent backend, Auto-connect on load.
  - **Claude** / **ChatGPT (Codex)** — Default model (a dropdown of the backend's
    *fetched* models), Default reasoning effort (the backend's own scale), and a
    per-backend **Bridge URL** (`9180` for Claude, `9181` for Codex).
  - **About** — ⭐ Star on GitHub. **API tokens** — secure CivitAI / HuggingFace
    buttons (stored by the orchestrator, never in ComfyUI settings).
  - The comfyui-mcp logo in the panel header.

### Fixed

- **Reconnect storm eliminated at the root.** Only one bridge client may be live per
  page now — a re-rendered/restored sidebar no longer spawns a second client that
  shares the tab id and ping-pongs the connection (the bridge's close-old-on-new-hello
  was closing each socket in a ~1s loop). (#28)
- **Backend-switch storm.** Switching Claude↔Codex no longer re-enters the connect
  path via a settings `onChange`; a live switch produces exactly one connect. (#29)
- **Per-backend bridge ports.** The Codex backend connects to `9181` (not Claude's
  `9180`), and **Reconnect after a switch dials the right port** (the default URL is no
  longer mistaken for a manual override). (#25, #29)
- **Cold-start "stuck on connecting".** A handshake timeout now auto-redials (bounded)
  and recovers like Reconnect, instead of sitting idle while the agent spawns. (#29)
- **Settings-load reconnect storm** — ComfyUI fires `onChange` during its startup
  settings load; appliers are now gated until the panel is armed. (#22)
- **Steady connection status** — no connecting↔disconnected flicker, with
  backend-aware patience for slow Codex cold starts. (#24)

## [0.3.1] - 2026-06-25

### Fixed

- **`comfy_reboot` (restart_comfyui) no longer reports a false failure.** ComfyUI
  Desktop's Manager `exit(0)`s before answering the reboot POST, so the fetch
  rejected with "Failed to fetch" and the restart looked failed (auto-resume never
  armed). A dropped connection mid-request is now treated as a successful reboot,
  with an endpoint fallback chain and accurate errors otherwise.
- **Stuck soft-reload auto-recovers.** If a soft-reload's fresh orchestrator binds
  but the agent handshake stalls, the panel now auto-escalates to a clean reconnect
  (~11s) — what you'd do by clicking Reconnect — instead of sitting on "waiting for
  the panel agent."
- **Workflow tabs**: `save` keeps a renamed tab's title (no more "Untitled …"
  overwrite); merely opening a workflow no longer marks a clean tab modified.
- **Run output images batch at run-end.** A multi-output run now delivers all its
  images to the agent in ONE turn when the run completes (buffered per `prompt_id`,
  flushed on `execution_success`, with a debounce fallback) instead of a fragmented
  turn per node — while still painting each image live as it finishes.
- **Desktop-nested ComfyUI path self-heal** in `_detect_comfyui_path` (mirrors the
  orchestrator fix).

## [0.3.0] - 2026-06-25

### Added

- **Provider switcher in the model selector.** Pick Claude or ChatGPT from a
  PROVIDER section at the top of the model popup (Provider → Model → Effort).
- **`show_media` + `free_vram` panel commands**, **soft-reload ↔ auto-respawn
  interlock**, **pack force-reclaim** of a wedged orchestrator, **Desktop-nested
  ComfyUI path self-heal**, and **effort snaps to the nearest supported level** on a
  model/provider switch (no silent drop). New multi-provider branding (banner, icon,
  OG card).

- **Run errors interrupt the agent and show a widget.** When a queued render fails,
  the panel now names the failing node (e.g. `Ideogram4PromptBuilderKJ (node 200)`),
  pushes it to the agent as an urgent `run_error` event — the orchestrator
  **interrupts the live turn and front-queues it**, so the agent stops and fixes the
  error instead of carrying on as if the run succeeded — and immediately renders a
  red **error card** in the chat, so you see it without waiting on a check-errors
  call. (ComfyUI targets `execution_error` to the queuing client, so the panel is
  the right place to catch and forward it.)

- **Multi-provider agent: Claude + ChatGPT/Codex at full parity.** The panel is no
  longer Claude-only — a **backend picker** (Claude / ChatGPT chips) lets you choose
  a provider rather than a port, and each runs its own background orchestrator on
  *your* subscription (no API keys). Both providers reach **full feature parity**:
  - **Provider switch** posts a system message and starts a fresh chat (sessions
    aren't shared across providers), with a **per-backend composer placeholder**
    ("Ask Claude…" / "Ask ChatGPT…").
  - **Reasoning-effort + model selector** is per-provider; a chosen effort survives
    a provider switch by mapping to the nearest valid level for the target backend.
    The **provider switcher now lives inside the model selector** (Claude models vs
    ChatGPT/GPT-5 models via Codex), so picking an agent and a model is one control.
  - **Live-canvas tools** (`panel_*`) and the **headless comfyui MCP** are exposed
    identically to both backends — in-process for Claude, and over a loopback
    streamable-HTTP MCP plus `codex app-server -c mcp_servers` for ChatGPT — so the
    `panel_*` surface (incl. the destructive-confirm gating) is the same everywhere.
  - **Knowledge parity** — both backends can discover bundled skills, installer
    packs, and the connected server's official workflow templates
    (`list_skills` / `read_skill` / `list_packs` / `read_pack_workflow` /
    `list_workflow_templates`) with steering toward packs over hand-built graphs.
  - **Docs/README rebalanced multi-provider** — setup, sign-in, and usage copy now
    present Claude and ChatGPT (Codex) as equal first-class providers.
- **One-shot workflow / pack load (`panel_load_workflow`).** Drop a whole workflow
  onto the live canvas in one call — prefer `pack:<name>` to load a bundled
  installer pack's local-GPU workflow without shuttling the JSON through the chat.
  The replaced graph is captured as an undo point (double-Esc / `/revert`).
- **Local-GPU vs paid-API cost guardrail (`check_workflow_runtime`).** Bundled
  packs are local/free; for an ad-hoc or generated graph the agent classifies the
  runtime (local / api / mixed / unknown) and **asks before spending paid API
  credits** rather than silently using hosted API nodes.

## [0.2.0] - 2026-06-19

### Added

- **Rewind & rollback (#44).** A hover ✎ on any past message opens a rollback modal
  to undo **code**, **conversation**, or **both** and resend an edited message —
  graph reverts via per-turn snapshots, conversation rewinds via `forkSession`.
  **`/revert`** undoes the last turn's graph edits, and a quick **double-Esc** in
  the composer rewinds your last turn (revert graph + recall the message to edit).
- **Pending-message tray.** Messages sent while the agent is busy now wait in a
  fixed **Pending** tray above downloads (out of the chat flow), each with
  **edit / send-now / delete**. **Send-now** interrupts the current turn (steer);
  **drag the ≡ handle** to reorder how the agent flushes them. When the agent
  dequeues a message it **materializes at the bottom of the chat** — so the chat
  reads in the exact order Claude processes them.
- **Spatial layout control.** The agent can now see and arrange the canvas: reads
  include node positions/sizes and subgraph I/O rails; it can move rails, create
  and edit groups, collapse/recolor nodes, and **screenshot** the canvas to verify
  its own layout (with the "expose inputs/outputs" rule baked into a skill).
- **Attach more than images.** The composer's attach button, drag-drop, and paste
  now accept **video**, **workflows (`.json`)**, and **text files** alongside
  images. Images and video upload into ComfyUI's `input/` folder (video is
  delivered as an `input/` path the agent can wire into a Load Video node, since
  it can't be viewed inline); workflow `.json` and text files are read and inlined
  to the agent (a recognized ComfyUI graph is flagged so it can load/analyze/merge
  it). Each file drops a typed chip — `[Image #N]` / `[Video #N]` / `[Workflow #N]`
  / `[File #N]` — and the picker accepts multiple files at once.

### Fixed

- **Reconnect durability.** Connect now reclaims a lockfile-less orchestrator
  "zombie" (alive but no longer serving the bridge) that would otherwise survive
  reloads and a full ComfyUI restart and block reconnection — it finds the port
  owner, and if it's our orchestrator, kills its tree and respawns a clean one.
- **Rollback anchor stability** — the rewind anchor is stored as the turn's UUID in
  the message's own handler (not an array index), so a bounded-history eviction
  can't point a rollback at the wrong turn.
- **Save-card** rendering fix.

## [0.1.3] - 2026-06-19

### Added

- **Live-streaming chat** — extended-thinking in a collapsible "see thinking"
  accordion + character-by-character reply, with a live thinking-token counter.
- **SDK slash commands** in the composer `/` menu — `/compact`, `/context`,
  `/usage`, `/loop`, `/goal`, `/clear` (the SDK's useful built-ins).
- **`/restart` — one-click recovery for a wedged agent.** Kills the orchestrator
  **and its whole child tree** (clearing a dead Agent-SDK shell an in-place reload
  can't) and starts a **fresh** session — resuming would just restore the wedge.
  Pure-Python route, so it works even when the agent isn't answering.
- **Per-message delivery status** (queued → seen) with edit/cancel on a queued
  message, and a **live model-download progress** tray.
- **Subgraph authoring** — promote/retract inner widgets, node-title rename,
  workflow-tab tools, built-in Manager install→restart→resume.

### Changed

- **Rebranded to "ComfyUI Agent Panel"** (registry slug `comfyui-agent-panel`);
  license declared as the Comfy-correct `{ file = "LICENSE" }` table form.
- **Removed all `--channels` plumbing.** The panel runs only on the autonomous
  orchestrator (dedicated bridge `9180`); reload/restart live as slash commands
  (`/reload`, `/reload-ui`, `/restart`), not header buttons.

### Fixed

- **Pid-reuse-safe orchestrator kill** — identity (cmdline + creation time) is
  re-verified immediately before every terminate/kill, for the orchestrator and
  each child, so a recycled pid is never mistaken for ours and a user's unrelated
  process is never signalled.
- **Connect honors the Bridge URL field** (previously only Reconnect did).
- **Deferred extension registration** so a Vite/Rolldown early module eval can't
  throw and deadlock the loader (adapted from a community PR, thanks
  @FreesoSaiFared).
- **Truthful "connected".** The panel now turns green only after the orchestrator
  handshake (its `models` frame) arrives — a non-orchestrator squatting the
  bridge port (e.g. a stray `comfyui-mcp --channels` server from another
  Claude/Cursor/codex session) leaves it on "connecting…" with a clear warning
  instead of a silent dead connection.
- **Dedicated bridge port `9180`.** The panel/orchestrator bridge moved off
  `9101` (now reserved for the legacy `--channels` path) so a `--channels` server
  can't steal it. Saved bridge URLs on the old `9101` default auto-migrate.
- **Sticky auto-reconnect.** Once you connect, the panel reconnects on its own —
  respawning the orchestrator if it died (e.g. after a ComfyUI reboot) — on every
  open, until you explicitly **Disconnect**.
- **Drop-zone** appears only while dragging a file and is scoped to the composer
  (was permanently visible over the whole panel).
- **Registry-safe `__init__.py`.** Nothing executes at import except registering
  the Connect/disconnect/reload routes; the only subprocess the pack ever runs is
  the orchestrator spawn behind an explicit **Connect** (POST). Process
  start-time and process-kill are psutil-only — no constructed PowerShell scripts
  or `taskkill`, so the security scanner sees no shell-exec surface.

### Added

- **Drag-drop / paste images** and **paste-large-text chips**, delivered to the
  agent as inline image blocks — chips, `@input:`/`@node:` mentions, and
  end-of-run output — with no fetch round-trip.
- **Smooth animated zoom-to-fit** after the agent makes structural edits.
- **Programmatic save** (no Save/Rename dialog) and a persistent **"working"**
  indicator with cycling status words.

## [0.4.1] - 2026-06-17

Start the agent with a **Connect** button instead of auto-spawning it on load.
The Comfy Registry's security scanner flagged 0.4.0 because the pack launched a
subprocess (`npx … --panel-orchestrator`) at import time. Now nothing spawns
until you explicitly click Connect — the registry-safe pattern — and the panel
still auto-connects when a bridge is already running.

### Changed

- **Connect button replaces import-time auto-spawn.** `__init__.py` no longer
  starts the orchestrator when ComfyUI imports the pack. Instead it registers a
  small local API on ComfyUI's own server (`/comfyui_mcp_panel/{status,connect,
  disconnect}`), and the panel's **Connect** button starts the orchestrator on
  demand — an explicit, authenticated, local action. On load the panel only
  auto-connects if a bridge is *already* running (you started it, or another
  tab did); otherwise it waits behind the Connect button. A **Disconnect**
  button stops an orchestrator the pack started. `COMFYUI_MCP_NO_AUTOSPAWN=1`
  now makes Connect report status without spawning; `COMFYUI_MCP_BRIDGE_PORT`
  still overrides the port. Fixes the `NodeVersionStatusFlagged` 0.4.0 release.

## [0.4.0] - 2026-06-17

The panel now drives itself: it auto-starts an autonomous background agent on
your Claude subscription, so you just open ComfyUI and type.

### Added

- **Auto-start the panel orchestrator on load.** The pack launches
  `npx -y comfyui-mcp --panel-orchestrator` when ComfyUI loads it — idempotent
  (skips if the bridge port is already owned), auto-detects this ComfyUI's
  `COMFYUI_URL`, and runs on your Claude **subscription** (no API key). The agent
  is a background Claude Agent SDK session per tab that loads comfyui-mcp's
  bundled skills (model expertise), so the only prerequisite is being signed in
  to Claude (`claude` once). Opt out with `COMFYUI_MCP_NO_AUTOSPAWN=1`; override
  the port with `COMFYUI_MCP_BRIDGE_PORT`. Requires comfyui-mcp ≥ 0.14.
- **Lifecycle beacon.** The pack passes its PID so the orchestrator shuts down
  when ComfyUI exits — including crashes/hard-kills — with an `atexit` teardown
  on clean shutdown too. No orphan left holding the bridge port.

### Changed

- **Connection UI reflects the orchestrator model.** The settings help text and
  header no longer tell you to wire the MCP into your interactive session with
  `--channels` (which would steal the bridge port from the orchestrator); they
  now describe the autonomous background agent and the one-time
  `npx -y comfyui-mcp --panel-orchestrator` fallback.

## [0.3.0] - 2026-06-16

The polished public release — now live on the [Comfy Registry](https://registry.comfy.org/nodes/comfyui-agent-panel) and installable from ComfyUI-Manager.

### Added

- **Registry banner & SEO listing.** Added a 21:9 brand banner
  (`assets/banner.png`) so the registry/social card uses a custom image
  instead of the generic OG fallback, and rewrote the pack description to
  lead with the terms people actually search (Claude Code, MCP / Model
  Context Protocol, AI agent, live graph editing).

- **Capability-aware empty state.** The onboarding hero now reflects the
  agent's full surface — build/edit the live graph, generate images **and
  audio** (`generate_audio`, ACE Step 1.5 / Stable Audio 3), run the workflow
  and read its errors, and find models on Civitai — with clickable example
  prompts that prefill the composer. Requires comfyui-mcp ≥ 0.13.
- **Native ComfyUI design system.** The panel is restyled on the same
  PrimeVue semantic tokens (`--p-content-background`, `--p-form-field-*`,
  `--p-primary-color`, border radii, Inter) the built-in sidebar panels use —
  it tracks your ComfyUI theme automatically. Header with live status dot,
  empty-state onboarding, animated message bubbles, auto-growing composer.
- **Activity cards.** Every graph edit the agent makes renders as a human-
  readable card in the chat feed — "➕ Added KSampler (id 26)",
  "🔗 Connected 4.MODEL → 26.model", "🎚 Set steps = 30 (was 20)" — so you
  can watch Claude work.
- **Multi-tab support.** Each ComfyUI browser tab holds its own bridge
  connection, identified by a per-tab session id plus the open workflow's
  title. The agent sees every tab (`panel_status`), routes edits per tab,
  and knows which tab you typed in. Requires comfyui-mcp ≥ 0.12.
- **Markdown-lite agent bubbles** — `code` and **bold** rendering, safely.
- **"Claude is working…" indicator.** Sending a message shows an animated
  typing indicator immediately; incoming graph edits keep it alive (and bump
  it below the newest activity card), the agent's reply retires it, and a
  45-second quiet period swaps it for a hint explaining that the agent reads
  panel messages by polling its inbox. (Claude Code doesn't stream its
  internal reasoning to MCP servers — narration + activity cards + this
  indicator are the feedback surface.)
- **`graph_clear` command** — wipes every node in a single
  `beforeChange`/`afterChange` pair, so one Ctrl+Z restores the whole graph.
  Exposed as the `panel_clear` MCP tool (comfyui-mcp ≥ 0.12).
- **Full programmatic graph & app control.** New executor commands (each
  with a matching `panel_*` MCP tool): `graph_move_node`, `graph_canvas`
  (fit / center-on-node / pan / zoom), `graph_run` (queue the open workflow,
  surfacing frontend validation errors), `graph_get_errors` (last
  `execution_error` event + `lastNodeErrors`), `workflow_save` (Ctrl+S
  path) and `workflow_save_as` (duplicate to `workflows/<name>.json`).
- **Subgraph-aware reads.** Executors target the graph you're *viewing*
  (root or an opened subgraph); `graph_get_state` reports `viewing`, marks
  subgraph nodes `is_subgraph` with an inner node count (boundary slots +
  widgets only), and `graph_get_subgraph` drills inside on demand.
- **Zed-style composer.** Rounded composer card with a context-window ring
  (radial fill — wired to `agent_status` frames; data source pending host
  support), model chip, attach button (uploads straight into ComfyUI's
  `input/` folder and inserts an `@input:` mention), and voice dictation
  via the browser's speech recognition.
- **Slash commands & @ mentions.** `/new`, `/fit`, `/run`, `/errors`,
  `/help` run locally with arrow-key + Enter completion; `@` autocompletes
  the current workflow, graph nodes, subgraphs, and registered node types.
  Outgoing messages stamp the workflow + opened subgraph so the agent has
  the context without asking.
- **Chat threads.** New-chat and history buttons in the header; threads
  persist to localStorage (last 20) and replay verbatim, activity cards
  included.

## [0.2.0] - 2026-06-12

### Changed

- **BREAKING: MCP-driven, no API keys.** Dropped the AI-SDK `/api/chat`
  backend entirely. The panel is now a WebSocket client of
  [comfyui-mcp](https://github.com/artokun/comfyui-mcp)'s `--channels`
  bridge (`ws://127.0.0.1:9101`): **your own Claude Code session is the
  agent**, subscription-billed, zero LLM API keys anywhere in the path.
  Settings reduced to one field (bridge URL); SSE parser and bearer token
  removed.

### Fixed

- `import { app } from "/scripts/app.js"` — `window.app` is no longer
  assigned at extension-eval time on ComfyUI frontend 1.4x, so the v1
  global-read pattern silently failed and the sidebar tab never registered.

## [0.1.0] - 2026-06-12

### Added

- Initial release: sidebar **Agent** tab with a chat UI, six-tool graph
  executor (`get_state`, `add_node`, `remove_node`, `connect`, `disconnect`,
  `set_widget`) wrapped in `beforeChange`/`afterChange` for native Ctrl+Z
  undo, talking to the comfyui-mcp AI-SDK backend.

[0.2.0]: https://github.com/artokun/comfyui-mcp-panel/releases/tag/v0.2.0
[0.1.0]: https://github.com/artokun/comfyui-mcp-panel/commits/4f22ed0
