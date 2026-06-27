# Agent Panel — Playwright e2e (Tier 1)

Tier 1 is the **agent-free** e2e tier for the ComfyUI Agent Panel. Every spec
points the panel at a scriptable **MockBridge** (a fake orchestrator) instead of
a real Claude/Codex backend, so the tests are deterministic, fast, need no auth,
and cost nothing. The MockBridge replaces only the **orchestrator** — the tests
still run against a **real ComfyUI** that hosts the panel.

## Prerequisites

1. **A running ComfyUI at `http://localhost:8188`.** The suite does not start it
   (mirroring comfyui_frontend, which assumes a running ComfyUI). Playwright
   launches its own browser and navigates there.
2. **CORS enabled** so the panel page can open a WebSocket to the MockBridge on a
   different port:
   ```
   comfyui --enable-cors-header
   ```
   (ComfyUI Desktop: launch with the equivalent setting.)
3. **This pack junctioned into `custom_nodes`** so the "Agent" sidebar tab is
   registered. (In this dev environment the panel is already junctioned in.)

## Install

```
npm install
npx playwright install chromium
```

## Run

```
npm run test:e2e          # headless
npm run test:e2e:ui       # Playwright UI mode
npm run test:e2e:list     # compile + discover specs only (no ComfyUI needed)
npm run typecheck         # tsc --noEmit
```

Override the target if ComfyUI is elsewhere:

```
PLAYWRIGHT_BASE_URL=http://127.0.0.1:8188 npm run test:e2e
```

## Specs

| Spec | What it covers |
| --- | --- |
| `connect.spec.ts` | Point the panel at the MockBridge, connect → status pill flips to "connected" (only the `models` handshake frame does this), greeting renders. |
| `streaming-render.spec.ts` | Send a message → MockBridge `replyStreamed("hello world")` → the last agent bubble shows the streamed text. |
| `hidden-tab.spec.ts` | Regression for commit `23a88ad`: with the tab hidden **and rAF neutered**, a streamed reply must still render via the synchronous hidden-path. See the header comment for the rAF limitation. |
| `pending-queue.spec.ts` | A 2nd message sent during a working turn queues in the pending tray, then drains/materializes when the agent dequeues it. |

## How it connects (agent-free)

The panel's "Connect" button POSTs `/comfyui_mcp_panel/connect`, which would start
a **real** orchestrator. Tests avoid that: `PanelPage.connect()` seeds the Bridge
URL (localStorage `comfyui-mcp.panel.bridgeUrl` + the Settings field) and clicks
**Reconnect**, which calls the bridge client's `setUrl()` → `connect()` directly —
no `/connect` POST, no real backend. Sticky auto-connect is also disabled in
`goto()` so opening the panel never spawns an agent.

## Fixtures

- `fixtures/MockBridge.ts` — the scriptable fake bridge (ws server). Emits the
  HELLO handshake (`models`, `commands`, `agent_status`, ready ack, greeting) and
  exposes `onUserMessage`, `waitForUserMessage`, `replyStreamed`, `emitWorking`,
  `turnDone`, `ack`/`markSeen`, `say`, `send`.
- `fixtures/PanelPage.ts` — the page object (centralized selectors + flows).
- `fixtures/panelTest.ts` — Playwright fixtures wiring a started `mockBridge` and
  a `panel` into each test.
