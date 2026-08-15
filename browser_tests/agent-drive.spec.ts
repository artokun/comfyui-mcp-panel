/**
 * Tier 1 — agent-driven CivitAI + Training modals.
 *
 * Exercises the post-open "drive" surface the agent reaches over the bridge:
 * open_civitai (docked), civitai_results / civitai_highlight / civitai_search /
 * civitai_switch_tab, and the training parity (open_training / training_highlight).
 * The bridge cmds are sent the way the real orchestrator sends them — via
 * MockBridge.command({rid,cmd,...}) — and we assert the reply shape AND the DOM
 * (green-glow cards/steps, dock geometry, teardown).
 *
 * Audit item-12 coverage present here: highlight-before-load, reload clears
 * glow, appended-card highlight on scroll, results shape, stale-handle throw
 * (CivitAI + Training), docked click-through, and training-first glow.
 *
 * NOT covered here (require real ComfyUI splitter/pane geometry the MockBridge
 * harness can't drive deterministically): dock ORIENTATION flip (pane docked
 * left vs right), pane COLLAPSE, and Agent-root DETACH re-centering. Those stay
 * manual checks in the live browser pass — see the report.
 *
 * NOTE: like the rest of this suite, these specs require a LIVE ComfyUI at
 * localhost:8188 with the pack junctioned in (see playwright.config.ts). They
 * are written to run under `npm run test:e2e` and are GATED ON THE LIVE PASS —
 * they do not run under `npm run test:unit` (node --test) which has no DOM.
 */
import { test, expect } from './fixtures/panelTest'

// A canned search page. Distinct ids so highlight-by-id is meaningful. `page`
// selects which ids come back so a later "page" can carry a target that the
// first page didn't (the scroll/append-highlight case).
//
// panel#793 — this used to emit the REST `/v1/images` shape,
// `{ items, metadata: { nextCursor } }`. The panel does not call that endpoint
// for a keyword search; it POSTs CivitAI's Meilisearch:
//
//     https://search-new.civitai.com/multi-search
//
// and reads `data.results[0].hits` (cmcp-civitai.js:925 → `_fromMeili`). The
// stub therefore answered every search with a body the reader found no hits in,
// so the grid stayed on its spinner with zero cards and all five specs here
// failed waiting for a card that could never render. The ITEM fields were right
// all along — only the envelope was stale.
function imagesPage(ids: number[]) {
  return {
    results: [
      {
        hits: ids.map((id) => ({
          id,
          url: `https://cdn/${id}.jpeg`,
          type: 'image',
          width: 512,
          height: 512,
          nsfwLevel: 1,
          username: `user${id}`,
          stats: { likeCount: id },
          meta: { prompt: `prompt for ${id}` }
        }))
      }
    ]
  }
}

/** An exhausted feed. Meili carries no cursor, so "no more results" is an empty
 *  hit list — the job `metadata.nextCursor: null` used to do. Without it the
 *  stub replays its last page forever and the grid fills with duplicates of the
 *  same id, which makes a `[data-id=N]` locator ambiguous. */
const EXHAUSTED = { results: [{ hits: [] as unknown[] }] }

async function stubCivitai(page: import('@playwright/test').Page, pages: Record<string, unknown>[]) {
  let call = 0
  // All CivitAI REST/tRPC calls funnel through the same-origin POST proxy.
  await page.route('**/comfyui_mcp_panel/civitai/api', (route) => {
    const body = call < pages.length ? pages[call] : EXHAUSTED
    call += 1
    route.fulfill({ json: body })
  })
  // Media proxy. This must be a DECODABLE image, not just the PNG signature.
  //
  // #847 — it used to be `Buffer.from([0x89, 0x50, 0x4e, 0x47])`, four bytes that
  // look like a PNG header and are not a PNG. Chrome fails to decode it and fires
  // `error` on the <img>, and the card's own handler responds by hiding itself:
  //
  //     img.addEventListener("error", () => { card.style.display = "none" })
  //
  // …which is correct product behaviour (a broken thumbnail should not leave a dead
  // tile in the grid) and made every card in this file disappear a moment after it
  // rendered. Assertions RACED that error event: `toBeVisible()` won often enough
  // that the specs mostly passed, and `append-on-scroll` — which waits for a second
  // page before asserting — lost about one run in three. The card was in the DOM
  // with the right class the whole time; it was `display: none`.
  //
  // A real 1x1 PNG decodes, so no card hides and nothing is racing.
  const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  await page.route('**/comfyui_mcp_panel/civitai/media*', (route) =>
    route.fulfill({ body: ONE_PIXEL_PNG, contentType: 'image/png' })
  )
  // Signed-out OAuth status so the favorites tab / account button stay inert.
  await page.route('**/comfyui_mcp_panel/civitai/oauth/status', (route) =>
    route.fulfill({ json: { signedIn: false } })
  )
}

async function openPanel(panel: any, mockBridge: any) {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
}

test.describe('agent-driven CivitAI modal', () => {
  test('highlight issued BEFORE the first page lands still glows once it arrives', async ({
    page,
    panel,
    mockBridge
  }) => {
    await stubCivitai(page, [imagesPage([11, 12, 13])])
    await openPanel(panel, mockBridge)

    // Agent opens docked and IMMEDIATELY highlights — before results exist.
    await mockBridge.command('open_civitai', { query: 'cats', dock: true })
    const hl = await mockBridge.command('civitai_highlight', { ids: [12] })
    expect(hl.ok).toBe(true)
    // highlight() awaited the in-flight first-page load, so the card is glowing.
    await expect(page.locator('.cmcp-cv-card[data-id="12"].cmcp-agent-glow')).toBeVisible()
    expect(hl.result.highlighted).toBe(1)
    expect(hl.result.missing).toEqual([])
  })

  test('a reload (switch_tab / search) clears the glow', async ({ page, panel, mockBridge }) => {
    await stubCivitai(page, [imagesPage([21, 22])])
    await openPanel(panel, mockBridge)
    await mockBridge.command('open_civitai', { query: 'a', dock: true })
    await mockBridge.command('civitai_highlight', { ids: [21] })
    await expect(page.locator('.cmcp-cv-card[data-id="21"].cmcp-agent-glow')).toBeVisible()

    await mockBridge.command('civitai_search', { query: 'b' })
    // The grid was wiped + re-fetched → no lingering glow.
    await expect(page.locator('.cmcp-agent-glow')).toHaveCount(0)
  })

  test('append-on-scroll re-applies the highlight to a card from a LATER page', async ({
    page,
    panel,
    mockBridge
  }) => {
    // First page lacks id 99; the second page (next cursor) carries it.
    await stubCivitai(page, [
      imagesPage([31, 32]),
      imagesPage([99])
    ])
    await openPanel(panel, mockBridge)
    await mockBridge.command('open_civitai', { query: 'x', dock: true })
    const hl = await mockBridge.command('civitai_highlight', { ids: [99] })
    // Not on the first page yet → reported missing, but the set persists.
    expect(hl.result.missing).toContain('99')

    // Scroll the body to trigger loadMore → the second page appends id 99, and
    // appendItems re-applies the retained highlight set.
    await page.locator('.cmcp-cv-body').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(page.locator('.cmcp-cv-card[data-id="99"].cmcp-agent-glow')).toBeVisible()
  })

  test('civitai_results returns bounded metadata + URLs (no image bytes)', async ({
    page,
    panel,
    mockBridge
  }) => {
    await stubCivitai(page, [imagesPage([41, 42, 43, 44])])
    await openPanel(panel, mockBridge)
    await mockBridge.command('open_civitai', { query: 'y', dock: true })
    const res = await mockBridge.command('civitai_results', { limit: 2 })
    expect(res.ok).toBe(true)
    expect(res.result.count).toBe(2)
    expect(res.result.truncated).toBe(true)
    expect(typeof res.result.renderRev).toBe('number')
    for (const it of res.result.items) {
      expect(typeof it.id).not.toBe('undefined')
      for (const u of it.urls) expect(typeof u).toBe('string')
    }
  })

  test('stale handle: a drive cmd after close is an honest error (outer ok:false)', async ({
    page,
    panel,
    mockBridge
  }) => {
    await stubCivitai(page, [imagesPage([51])])
    await openPanel(panel, mockBridge)
    await mockBridge.command('open_civitai', { query: 'z', dock: true })
    await expect(page.locator('.cmcp-civitai-modal')).toBeVisible()
    // Close via Escape (audit item 9 — base modals now handle it).
    await page.keyboard.press('Escape')
    await expect(page.locator('.cmcp-civitai-modal')).toHaveCount(0)

    const reply = await mockBridge.command('civitai_results', {})
    expect(reply.ok).toBe(false) // the bridge THREW, not swallowed as success
    expect(String(reply.error)).toContain('not open')
  })

  test('docked mode leaves the chat interactive (overlay is click-through)', async ({
    page,
    panel,
    mockBridge
  }) => {
    await stubCivitai(page, [imagesPage([61])])
    await openPanel(panel, mockBridge)
    await mockBridge.command('open_civitai', { query: 'q', dock: true })
    const overlay = page.locator('.cmcp-cv-overlay.cmcp-docked')
    await expect(overlay).toBeVisible()
    // The overlay must not intercept pointer events (chat stays usable).
    await expect(overlay).toHaveCSS('pointer-events', 'none')
    // The card itself DOES catch them.
    await expect(page.locator('.cmcp-docked .cmcp-civitai-modal')).toHaveCSS('pointer-events', 'auto')
  })
})

test.describe('agent-driven Training modal', () => {
  // panel#793 — off-by-default flag; see fixtures/panelTest.ts.
  test.use({ panelFlags: ['comfyui-mcp.featureFlag.training'] })

  test('training-first glow: step highlight works without the CivitAI CSS ever loading', async ({
    page,
    panel,
    mockBridge
  }) => {
    // No CivitAI modal is ever opened here — proves .cmcp-agent-glow is injected
    // by the training module itself (audit item 4).
    await openPanel(panel, mockBridge)
    await mockBridge.command('open_training', { dock: true })
    await expect(page.locator('.cmcp-tr-modal')).toBeVisible()
    // open_training lands on the FLOWS view (step bar cleared) — navigate to the
    // Dataset step so the step:dataset chip exists before highlighting it. Step 1
    // has no prerequisite gate, so gotoStep(1) enters directly.
    await mockBridge.command('training_goto_step', { step: 1 })
    await expect(page.locator('[data-ref="step:dataset"]')).toBeVisible()
    const hl = await mockBridge.command('training_highlight', { refs: ['step:dataset'] })
    expect(hl.ok).toBe(true)
    await expect(page.locator('[data-ref="step:dataset"].cmcp-agent-glow')).toBeVisible()
  })

  test('training_get_state is routed (not "Unknown command") and reports readiness', async ({
    page,
    panel,
    mockBridge
  }) => {
    await openPanel(panel, mockBridge)
    await mockBridge.command('open_training', { dock: true })
    await expect(page.locator('.cmcp-tr-modal')).toBeVisible()
    const st = await mockBridge.command('training_get_state', {})
    expect(st.ok).toBe(true)
    expect(st.result.view).toBe('flows')
    expect(st.result.readiness).toBeTruthy()
    // A fresh wizard has no dataset name/images yet → not advance-ready.
    expect(st.result.readiness.nameOk).toBe(false)
    expect(st.result.readiness.hasImages).toBe(false)
  })

  test('gotoStep enforces prerequisites — jumping to Label without a dataset is rejected', async ({
    page,
    panel,
    mockBridge
  }) => {
    await openPanel(panel, mockBridge)
    await mockBridge.command('open_training', { dock: true })
    await expect(page.locator('.cmcp-tr-modal')).toBeVisible()
    // panel#793 — entering a wizard step runs the backend-capability probe,
    // which callJson's with a 15s timeout. MockBridge.command defaults to 10s,
    // so the harness gave up 5s before the panel could answer and the failure
    // read as a hung command. The rejection itself is correct and honest.
    const reply = await mockBridge.command('training_goto_step', { step: 2 }, 25_000)
    expect(reply.ok).toBe(false)
    // Backend-capability or dataset-name/image gate fires — either is an honest
    // rejection rather than a silent jump.
    expect(String(reply.error)).toMatch(/backend|dataset name|image/i)
  })

  test('stale training handle after Escape → honest not-open error', async ({
    page,
    panel,
    mockBridge
  }) => {
    await openPanel(panel, mockBridge)
    await mockBridge.command('open_training', { dock: true })
    await expect(page.locator('.cmcp-tr-modal')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.cmcp-tr-modal')).toHaveCount(0)
    const reply = await mockBridge.command('training_highlight', { refs: ['step:dataset'] })
    expect(reply.ok).toBe(false)
    expect(String(reply.error)).toContain('not open')
  })
})
