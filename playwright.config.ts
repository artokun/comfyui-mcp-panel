/**
 * Playwright config for the ComfyUI Agent Panel — Tier 1 e2e suite.
 *
 * Modeled on comfyui_frontend's browser_tests/playwright.config.ts.
 *
 * PREREQUISITES (this suite does NOT start ComfyUI for you):
 *   1. A real ComfyUI must be running and reachable at http://localhost:8188.
 *      Playwright launches its OWN browser which navigates there.
 *   2. ComfyUI must be started with cross-origin allowed so the panel page can
 *      open a WebSocket to the test's MockBridge on a different port:
 *        comfyui --enable-cors-header
 *      (ComfyUI Desktop users: launch with that flag, or set the equivalent.)
 *   3. THIS pack (comfyui-agent-panel) must be junctioned/symlinked into
 *      ComfyUI's custom_nodes so the Agent sidebar tab is registered.
 *
 * Tier 1 is AGENT-FREE: every spec points the panel at a scriptable MockBridge
 * (browser_tests/fixtures/MockBridge.ts) instead of a real Claude/Codex
 * orchestrator. Deterministic, fast, no auth, no cost.
 *
 * Run:  npm run test:e2e          (headless)
 *       npm run test:e2e:ui       (Playwright UI mode)
 *       npm run test:e2e:list     (compile + discover only — no ComfyUI needed)
 */
import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8188'

export default defineConfig({
  testDir: './browser_tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      timeout: 30_000
    }
  ]
})
