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
import type { BrowserContext, Page } from '@playwright/test'
import { test as base } from '@playwright/test'

import { COMFY_BASE_URL, deleteWorkflowByPath } from '../global-workflow-litter'
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
   * hermeticity. That is correct for `autostartMcp`, and it also removed the
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
  /** Enable panel-open MCP autostart and route it to this test's MockBridge. */
  panelAutostartMcp: boolean
}

/** The stub set itself, kept in one place so the fixture and a spec's second page
 *  can never drift apart. */
async function applyPanelRouteStubs(
  page: Page,
  panelFlags: string[],
  panelAutostartMcp = false,
  bridgeUrl: string | null = null,
) {
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
  await page.route('**/comfyui_mcp_panel/launcher/**', (route) =>
    route.fulfill({ status: 503, json: { ok: false, installed: false, running: false } })
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
      // Existing bridge-centric specs click Connect themselves and must never
      // ask a real per-user launcher to open a terminal on the developer's box.
      // Autostart behavior has its own focused route-driven coverage.
      body['comfyui-mcp.autostartMcp'] = panelAutostartMcp
      if (panelAutostartMcp && bridgeUrl) {
        body['comfyui-mcp.bridgeUrl.single'] = bridgeUrl
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

/**
 * Record every workflow file a test WRITES, so the fixture deletes exactly those (#907).
 *
 * The leaks left after 0.11.79 were not `workflow_save` — converted to an owned
 * `cmcp-e2e-*` name — and not `workflow_new`, which persists nothing. They are GROUNDING
 * (#330): the panel auto-saves an unsaved workflow before a turn, so any spec that calls
 * `sendMessage` silently creates `Untitled <date> <time>.json`. Measured:
 *
 *   before  workflows/Unsaved Workflow.json
 *   after   workflows/Untitled 2026-08-09 22-51-44.json   persisted: true
 *
 * Which is why auditing the save TOOLS never found it — nothing in those specs asks to save.
 *
 * OWNERSHIP IS OBSERVED, NOT INFERRED, and that is what makes this safe where name-matching
 * was not. `Untitled <date> <time>` is also what ComfyUI names a developer's own unnamed
 * save, so a cleanup keyed on that pattern could delete their file (codex refused exactly
 * that on #940). This records the requests this test's own browser context actually issued.
 *
 * Recorded in the TEST PROCESS rather than in the page, and both page-side attempts that
 * failed are worth keeping: a window array is wiped by `addInitScript` re-running on every
 * navigation, and sessionStorage dies with the page — a spec calling `pageB.close()` takes
 * its record with it, which was the last leak left in a full suite run.
 */
function recordWorkflowWrites(context: BrowserContext, state: WriteRecord) {
  // A CREATE is what proves ownership. ComfyUI's workflow write is
  // `POST /api/userdata/workflows%2F<name>.json?overwrite=false`, and `overwrite=false`
  // means the server REFUSES an existing path — so an ok response is proof the file did not
  // exist a moment ago and this browser is what brought it into being. Anything else is
  // skipped rather than guessed at (codex): an OPTIONS preflight, a DELETE, a write that
  // permits overwriting, a failed write, or a request to some other instance are all cases
  // where deleting the path could destroy a file this test did not create.
  const owns = (url: string, method: string) => {
    // POST only. That is the contract actually observed for the workflow save; accepting
    // PUT as well would widen the trusted surface on an assumption rather than evidence
    // (codex).
    if (method !== 'POST') return null
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    // Same instance the cleanup will delete against — a spec pointed at another ComfyUI
    // must never make us delete a same-named workflow on the default one.
    if (parsed.origin !== new URL(COMFY_BASE_URL).origin) return null
    if (parsed.pathname !== '/api/userdata' && !parsed.pathname.startsWith('/api/userdata/')) return null
    if (parsed.searchParams.get('overwrite') !== 'false') return null
    const m = /^\/api\/userdata\/(.+)$/.exec(parsed.pathname)
    if (!m) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(m[1])
    } catch {
      return null
    }
    if (!/^workflows\//.test(decoded) || !/\.json$/i.test(decoded)) return null
    return decoded
  }

  context.on('request', (request) => {
    try {
      if (owns(request.url(), request.method().toUpperCase())) state.pending.add(request)
    } catch {
      /* bookkeeping must never interfere with the request under test */
    }
  })
  const settle = (request: import('@playwright/test').Request) => state.pending.delete(request)
  context.on('requestfailed', settle)
  context.on('requestfinished', (request) => {
    let path: string | null = null
    try {
      path = owns(request.url(), request.method().toUpperCase())
    } catch {
      path = null
    }
    if (!path) {
      settle(request)
      return
    }
    // STAY PENDING UNTIL CLASSIFIED (codex). Settling first and classifying in a detached
    // promise let teardown observe zero pending, delete the `created` set it had, and only
    // then receive the path — recreating the missed-cleanup bug without needing a hung
    // request at all. The drain below is only meaningful if "pending" covers the
    // bookkeeping too, not just the wire.
    const owned = path
    void (async () => {
      try {
        const response = await request.response()
        // Only a SUCCEEDED create is ours to remove.
        if (response?.ok()) state.created.add(owned)
      } catch {
        /* unreadable response ⇒ claim nothing */
      } finally {
        settle(request)
      }
    })()
  })
}

interface WriteRecord {
  created: Set<string>
  pending: Set<import('@playwright/test').Request>
}

/** Delete what this test created. Best-effort: a cleanup failure must never mask a real one. */
async function cleanupRecordedWorkflowWrites(state: WriteRecord) {
  // WAIT FOR IN-FLIGHT WRITES FIRST (codex). Deleting while a save is still on the wire
  // gets a 404 and then the write lands afterwards — recreating the very file this is
  // supposed to remove, and doing it invisibly because the delete "succeeded". Bounded, so
  // a wedged request delays teardown by a second rather than hanging the suite.
  //
  // WHAT THIS DOES NOT PROMISE, stated rather than implied: it drains writes it has already
  // OBSERVED. A save kicked off by a pending timer after the drain reads zero is recorded
  // too late for this pass. Closing that needs quiescence the fixture cannot establish
  // without closing the context first; the suite-level sweep still REPORTS anything left,
  // which is how these were found in the first place.
  const deadline = Date.now() + 1000
  while (state.pending.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  for (const userdataPath of state.created) {
    try {
      await deleteWorkflowByPath(userdataPath)
    } catch {
      // The suite-level sweep still reports anything left behind.
    }
  }
}

export const test = base.extend<PanelFixtures & PanelOptions>({
  panelFlags: [[], { option: true }],
  panelAutostartMcp: [false, { option: true }],
  mockBridge: async ({}, use) => {
    const bridge = new MockBridge({ port: 0 })
    await bridge.start()
    await use(bridge)
    await bridge.close()
  },
  panel: async ({ page, panelFlags, panelAutostartMcp, mockBridge }, use) => {
    await applyPanelRouteStubs(page, panelFlags, panelAutostartMcp, mockBridge.url)
    // #907 — record before anything loads, clean up after the test whatever it ends up
    // being. Runs on FAILURE too, which per-spec cleanup at the end of a test body never
    // did — and a failing test is exactly when a spec is most likely to have left a file.
    const wrote: WriteRecord = { created: new Set<string>(), pending: new Set() }
    recordWorkflowWrites(page.context(), wrote)
    await use(new PanelPage(page))
    await cleanupRecordedWorkflowWrites(wrote)
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
      // 404 IS success: the file is gone, which is the whole objective. It happens
      // routinely now that the fixture also sweeps what the page wrote — a spec that
      // cleaned up after itself is then asked a second time. Warning on it trains readers
      // to ignore the warning, which is worse than not printing it.
      if (res?.status === 404) return 'ok'
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
