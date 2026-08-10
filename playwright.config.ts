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
  // Pure-module unit tests (browser_tests/unit/*.test.mjs) run under
  // `node --test` (npm run test:unit), NOT Playwright — Playwright's default
  // testMatch would otherwise import them (node:test auto-runs on import).
  testIgnore: '**/unit/**',
  // #907 — the suite persists real workflows through ComfyUI's userdata API, and
  // was leaving them in the developer's own library (1269 of 1286 files were test
  // output when this was measured). Per-spec cleanup could not fix it: it sits at
  // the end of a test body, so it does not run when the test FAILS. Only these
  // two see the whole run.
  globalSetup: './browser_tests/global-setup.ts',
  globalTeardown: './browser_tests/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // #847 — BOUND, not `undefined`. Playwright's default is roughly half the cores,
  // which on a 16-worker machine puts sixteen browsers through ONE ComfyUI and one
  // origin's storage. Measured on the same suite, same machine, back to back:
  //
  //     16 workers (the default here) ...  3 of 49 passed, 2.1 min
  //      2 workers ....................... 48 of 49 passed, 2.1 min
  //
  // The parallelism costs 45 specs and buys no wall-clock at all — the run is
  // bounded by ComfyUI, not by the browsers. Worse, it cost the suite its meaning:
  // anyone running `npm run test:e2e` locally met a wall of red and learned to
  // ignore it, which is how a genuine regression gets waved through.
  //
  // Two rather than one because the difference is not measurable here and a single
  // worker has no headroom if a spec hangs. 4 was also tried: 2-4 specs fail.
  workers: process.env.CI ? 1 : 2,
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
