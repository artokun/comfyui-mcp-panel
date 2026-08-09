/**
 * Shared Playwright fixtures for the Agent panel Tier 1 suite.
 *
 * Provides:
 *   - `mockBridge`: a started MockBridge on an OS-assigned free port, auto-closed
 *     after each test.
 *   - `panel`: a PanelPage bound to the test's page.
 *
 * A typical spec: point the panel at `mockBridge.url`, open the sidebar, connect,
 * then drive the conversation via the MockBridge helpers.
 */
import type { Page } from '@playwright/test'
import { test as base } from '@playwright/test'

import { MockBridge } from './MockBridge'
import { PanelPage } from './PanelPage'

interface PanelFixtures {
  mockBridge: MockBridge
  panel: PanelPage
}

interface PanelOptions {
  /**
   * Panel feature flags to force ON for this spec, e.g.
   * `test.use({ panelFlags: ['comfyui-mcp.featureFlag.apps'] })`.
   *
   * panel#793 — the settings strip below deletes EVERY `comfyui-mcp.` key for
   * hermeticity. That is correct for `autoConnect`, and it also removed the
   * three feature flags, which are `defaultValue: false`. So the toolbar button
   * a flagged feature lives behind never rendered, and every spec for those
   * features failed the same way: a 30s timeout waiting to click a button that
   * was correctly hidden. The specs were not asserting a broken feature — they
   * were asserting one the harness had switched off.
   *
   * Opt-in per spec rather than blanket-on: a spec that checks a flagged button
   * is ABSENT by default must keep seeing it absent.
   */
  panelFlags: string[]
}

/** The stub set itself, kept in one place so the fixture and a spec's second page
 *  can never drift apart. */
async function applyPanelRouteStubs(page: Page, panelFlags: string[]) {
  // Hermetic runs on a dev box with a REAL orchestrator listening on :9180:
  // the panel's mount probe (GET /comfyui_mcp_panel/status → { running: true })
  // would auto-connect it to the live agent before the spec's setBridgeUrl()
  // override applies — the real greeting then pollutes the transcript and the
  // MockBridge never sees the session. Stub the discovery routes so every spec
  // sees "no orchestrator"; connection goes only where the spec points it.
  await page.route('**/comfyui_mcp_panel/status*', (route) =>
    route.fulfill({ json: { running: false } })
  )
  await page.route('**/comfyui_mcp_panel/backends*', (route) =>
    route.fulfill({ json: { backends: [] } })
  )
  await page.route('**/comfyui_mcp_panel/bridge_url*', (route) =>
    route.fulfill({ json: { url: null } })
  )
  // Panel-setting WRITES must never reach the real server: Reconnect mirrors
  // the (per-test, throwaway) mock URL into `comfyui-mcp.bridgeUrl.single`,
  // which would poison the developer's live panel with a dead port after the
  // suite exits. Swallow them; the panel treats the write as fire-and-forget.
  await page.route(
    (url) => /\/(api\/)?settings\/comfyui-mcp\./.test(url.pathname),
    (route) =>
      route.request().method() === 'GET'
        ? route.continue()
        : route.fulfill({ status: 200, json: {} })
  )
  // Same hermeticity for SERVER-STORED user settings: a dev box that uses the
  // panel daily has `comfyui-mcp.autoConnect: true` (+ a saved bridge URL) in
  // ComfyUI's /settings store, which auto-connects the panel to the live
  // orchestrator on mount even in a fresh browser profile. Strip the panel's
  // keys from the settings payload; everything else passes through untouched.
  await page.route(
    (url) => /\/(api\/)?settings\/?$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const res = await route.fetch()
      let body: Record<string, unknown>
      try {
        body = await res.json()
      } catch {
        return route.fulfill({ response: res })
      }
      for (const key of Object.keys(body)) {
        if (key.startsWith('comfyui-mcp.')) delete body[key]
      }
      // Put back only what this spec explicitly asked for, AFTER the strip, so
      // the flag value comes from the spec and never from the dev box.
      for (const flag of panelFlags) body[flag] = true
      return route.fulfill({ response: res, json: body })
    }
  )
}

/**
 * Apply every hermeticity stub to a page. Exported because the fixture only covers the
 * test's OWN `page`: a spec that opens a SECOND page must apply the identical set, or
 * that page's Reconnect writes the throwaway mock bridge URL into the developer's REAL
 * ComfyUI settings and leaves a dead port behind after the suite exits (codex, #693).
 */
export async function isolatePanelPage(page: Page, panelFlags: string[] = []) {
  await applyPanelRouteStubs(page, panelFlags)
}

export const test = base.extend<PanelFixtures & PanelOptions>({
  panelFlags: [[], { option: true }],
  mockBridge: async ({}, use) => {
    const bridge = new MockBridge({ port: 0 })
    await bridge.start()
    await use(bridge)
    await bridge.close()
  },
  panel: async ({ page, panelFlags }, use) => {
    await applyPanelRouteStubs(page, panelFlags)
    await use(new PanelPage(page))
  }
})

/**
 * Delete a workflow this spec persisted, through ComfyUI's own userdata API (#907).
 *
 * Specs that call `workflow_save` write a REAL file into the developer's workflow
 * library. Nothing removed them, and it compounded: 1221 of 1240 files on this machine
 * were `Untitled 2026-08-*` test output, burying the ~19 real workflows and inflating
 * every `workflows` store read the panel does.
 *
 * It lives HERE because the three specs that did clean up each hand-rolled their own
 * copy, and that is exactly how the two that did not came to be missed. One helper, so
 * forgetting is a shorter path than remembering.
 *
 * Best-effort by construction: a cleanup that throws must never mask the assertion that
 * actually failed, and a file that is already gone is already clean. Call it from a
 * `finally`, so a failing test does not leave litter either.
 */
export async function deleteSavedWorkflow(page: Page, workflowName: string): Promise<void> {
  const name = String(workflowName ?? '').trim()
  // An empty name would DELETE `workflows/.json` — a request about a file this spec never
  // created. Nothing to clean, and asking is worse than not asking.
  if (!name) {
    console.warn('[e2e cleanup] no workflow name to delete — a setup save likely failed')
    return
  }
  let outcome: string
  try {
    outcome = await page.evaluate(async (path) => {
      const api = (window as any).comfyAPI?.api?.api
      if (typeof api?.fetchApi !== 'function') return 'no api'
      // fetchApi RESOLVES on an HTTP error, so the status has to be read (codex) —
      // otherwise a 500 leaves litter and looks exactly like success.
      const res = await api.fetchApi(`/userdata/${encodeURIComponent(path)}`, { method: 'DELETE' })
      return res?.ok ? 'ok' : `HTTP ${res?.status ?? '?'}`
    }, `workflows/${name}.json`)
  } catch (err) {
    outcome = `threw: ${String(err)}`
  }
  // NON-MASKING but not SILENT. Throwing would replace a real assertion failure with a
  // cleanup failure, which is strictly worse for diagnosis — but a cleanup that quietly
  // fails forever is how 1221 files accumulated in the first place, so it must say so.
  if (outcome !== 'ok') {
    console.warn(`[e2e cleanup] failed to delete workflows/${name}.json — ${outcome}`)
  }
}

export { expect } from '@playwright/test'
