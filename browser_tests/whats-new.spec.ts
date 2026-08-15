/**
 * #758 — the panel says what changed after the install moved under the user.
 *
 * The panel updates from the Comfy Registry and the orchestrator runs `npx comfyui-mcp@latest`,
 * so the version changes without the user asking. Their first signal is behaviour they did
 * not expect, which reads as a bug rather than a release.
 *
 * Asserting the notice RENDERS is the point: the delta logic is unit-tested, but a correct
 * delta that never reaches the transcript answers nobody.
 */
import { test, expect } from './fixtures/panelTest'

/** Pretend this browser last saw `version`, the way an older install would have. */
async function seedLastSeen(page: import('@playwright/test').Page, version: string) {
  await page.evaluate((v) => {
    try {
      if (v) window.localStorage.setItem('comfyui-mcp.panel.lastSeenVersion', v)
      else window.localStorage.removeItem('comfyui-mcp.panel.lastSeenVersion')
    } catch {}
  }, version)
}

const panelVersion = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="panel-whats-new"] .cmcp-whatsnew-head')
    return el?.textContent ?? ''
  })

test('an updated panel reports what changed since the version you were on', async ({ page, panel }) => {
  await panel.goto()
  // Seed BEFORE the panel mounts, so the announcement runs against it.
  await seedLastSeen(page, '0.11.70')
  await panel.openSidebar()

  const notice = panel.root.locator('[data-testid="panel-whats-new"]')
  await expect(notice, 'the update notice must appear in the transcript').toBeVisible({ timeout: 15000 })
  await expect(notice).toContainText('you were on 0.11.70')
  // It must carry real entries, not just a header.
  const items = notice.locator('.cmcp-whatsnew-list li')
  expect(await items.count(), 'the notice must list actual changes').toBeGreaterThan(0)
  // Fixed vs Changed is the distinction the report asks for.
  const tags = await notice.locator('.cmcp-whatsnew-tag').allTextContents()
  expect(tags.length, 'each entry is tagged with its section').toBeGreaterThan(0)

  // Announced ONCE: a reload must not repeat it, because the version is now recorded.
  await page.reload()
  await panel.openSidebar()
  await page.waitForTimeout(2500)
  await expect(
    panel.root.locator('[data-testid="panel-whats-new"]'),
    'the same update must not be announced again after a reload'
  ).toHaveCount(0)
  expect(await panelVersion(page)).toBe('')
})

test('a first run announces nothing', async ({ page, panel }) => {
  // No recorded last-seen means a fresh install or a user who predates this feature.
  // Greeting them with a wall of history they did not ask for is the opposite of the point.
  await panel.goto()
  await seedLastSeen(page, '')
  await panel.openSidebar()
  await page.waitForTimeout(2500)
  await expect(panel.root.locator('[data-testid="panel-whats-new"]')).toHaveCount(0)
})
