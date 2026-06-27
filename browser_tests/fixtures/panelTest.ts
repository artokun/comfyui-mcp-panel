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
import { test as base } from '@playwright/test'

import { MockBridge } from './MockBridge'
import { PanelPage } from './PanelPage'

interface PanelFixtures {
  mockBridge: MockBridge
  panel: PanelPage
}

export const test = base.extend<PanelFixtures>({
  mockBridge: async ({}, use) => {
    const bridge = new MockBridge({ port: 0 })
    await bridge.start()
    await use(bridge)
    await bridge.close()
  },
  panel: async ({ page }, use) => {
    await use(new PanelPage(page))
  }
})

export { expect } from '@playwright/test'
