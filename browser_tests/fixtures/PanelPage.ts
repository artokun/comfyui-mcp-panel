/**
 * PanelPage — page object for the ComfyUI Agent Panel sidebar extension.
 *
 * Mirrors comfyui_frontend's ComfyPage: it owns the panel's selectors and the
 * user-flow helpers (open the sidebar, point at a bridge, connect, send a
 * message, read replies). Selectors are centralized here so a class rename in
 * web/js/comfyui-mcp-panel.js only needs fixing in one place.
 *
 * Selector reference (from web/js/comfyui-mcp-panel.js):
 *   - sidebar tab id .............. "comfyui-mcp.agent"  (button class
 *                                    "comfyui-mcp.agent-tab-button")
 *   - panel root .................. .cmcp-root
 *   - status pill (button) ........ .cmcp-status   (state word as text)
 *   - status dot .................. .cmcp-dot      (+ .connected / .connecting)
 *   - connection popover .......... .cmcp-conn-pop
 *   - bridge URL input ............ .cmcp-input    (inside .cmcp-advanced)
 *   - Reconnect button ............ .cmcp-btn with text "Reconnect"
 *   - composer input (textarea) ... .cmcp-composer-input
 *   - send button ................. button[type=submit] in .cmcp-composer
 *   - agent reply bubble .......... .cmcp-bubble.agent
 *   - user bubble ................. .cmcp-bubble.user
 *   - pending tray ................ .cmcp-tray  /  .cmcp-pending-item
 *
 * localStorage keys (read by the panel at build time):
 *   - comfyui-mcp.panel.bridgeUrl    bridge ws URL
 *   - comfyui-mcp.panel.autoConnect  sticky auto-connect ("1" to enable)
 *   - comfyui-mcp.panel.backend      selected backend ("claude"|"codex")
 */
import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

const SIDEBAR_TAB_ID = 'comfyui-mcp.agent'

export type PanelStatus = 'connected' | 'connecting' | 'disconnected' | string

export class PanelPage {
  readonly root: Locator
  readonly statusPill: Locator
  readonly statusDot: Locator
  readonly connectionPopover: Locator
  readonly bridgeUrlInput: Locator
  readonly reconnectButton: Locator
  readonly connectButton: Locator
  readonly disconnectButton: Locator
  readonly composerInput: Locator
  readonly sendButton: Locator
  readonly agentBubbles: Locator
  readonly userBubbles: Locator
  readonly streamingBubble: Locator
  readonly pendingTray: Locator
  readonly pendingItems: Locator

  constructor(public readonly page: Page) {
    this.root = page.locator('.cmcp-root')
    this.statusPill = this.root.locator('.cmcp-status')
    this.statusDot = this.statusPill.locator('.cmcp-dot')
    this.connectionPopover = this.root.locator('.cmcp-conn-pop')
    this.bridgeUrlInput = this.connectionPopover.locator('.cmcp-input')
    this.reconnectButton = this.connectionPopover.getByRole('button', {
      name: 'Reconnect'
    })
    this.connectButton = this.connectionPopover.getByRole('button', {
      name: 'Connect',
      exact: true
    })
    this.disconnectButton = this.connectionPopover.getByRole('button', {
      name: 'Disconnect'
    })
    this.composerInput = this.root.locator('.cmcp-composer-input')
    this.sendButton = this.root.locator('.cmcp-composer button[type="submit"]')
    this.agentBubbles = this.root.locator('.cmcp-bubble.agent')
    this.userBubbles = this.root.locator('.cmcp-bubble.user')
    this.streamingBubble = this.root.locator('.cmcp-bubble.agent.streaming')
    this.pendingTray = this.root.locator('.cmcp-tray')
    this.pendingItems = this.root.locator('.cmcp-pending-item')
  }

  /**
   * Navigate to ComfyUI and wait for the frontend to be ready, then neutralize
   * sticky auto-connect so the panel never spawns a REAL orchestrator via the
   * /connect route — Tier 1 connects only to the MockBridge, explicitly.
   */
  async goto(): Promise<void> {
    await this.page.goto('/')
    await this.page.waitForFunction(
      () => {
        const w = window as unknown as {
          comfyAPI?: { app?: { app?: { extensionManager?: unknown } } }
          app?: { extensionManager?: unknown }
        }
        const app = w.comfyAPI?.app?.app || w.app
        return !!(app && app.extensionManager)
      },
      undefined,
      { timeout: 30_000 }
    )
    await this.page.evaluate(() => {
      try {
        localStorage.setItem('comfyui-mcp.panel.autoConnect', '0')
        localStorage.setItem('comfyui-mcp.panel.backend', 'claude')
      } catch {
        // private mode / storage disabled — tests set the URL another way
      }
    })
  }

  /**
   * Open the Agent sidebar tab. Tries the real user path (clicking the tab
   * button — the pi-comments icon), then falls back to the extension manager
   * API the panel itself uses (the tab id contains a dot, which makes the
   * generated CSS class awkward to target).
   */
  async openSidebar(): Promise<void> {
    if (await this.root.isVisible().catch(() => false)) return
    // The tab registers a beat after window.app is ready — wait for the button.
    const tabButton = this.page.locator(
      `[class~="${SIDEBAR_TAB_ID}-tab-button"]`
    )
    await tabButton
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => {})

    if (await tabButton.count()) {
      await tabButton.first().click().catch(() => {})
    } else {
      await this.activateSidebarProgrammatically()
    }

    // If the click didn't mount the panel, fall back to the extension manager.
    try {
      await this.root.waitFor({ state: 'visible', timeout: 8_000 })
    } catch {
      await this.activateSidebarProgrammatically()
      await this.root.waitFor({ state: 'visible', timeout: 8_000 })
    }
  }

  private async activateSidebarProgrammatically(): Promise<void> {
    await this.page.evaluate((tabId) => {
      const w = window as unknown as {
        comfyAPI?: { app?: { app?: Record<string, unknown> } }
        app?: Record<string, unknown>
      }
      const app = (w.comfyAPI?.app?.app || w.app) as
        | { extensionManager?: Record<string, unknown> }
        | undefined
      const em = app?.extensionManager as
        | {
            setActiveSidebarTab?: (id: string) => void
            toggleSidebarTab?: (id: string) => void
          }
        | undefined
      if (!em) return
      em.setActiveSidebarTab?.(tabId)
      em.toggleSidebarTab?.(tabId)
    }, SIDEBAR_TAB_ID)
  }

  /**
   * Point the panel at a bridge URL. Writes the localStorage key the panel reads
   * at build time AND, if the panel is already mounted, fills the visible Bridge
   * URL field so the Reconnect button uses it. Call BEFORE openSidebar() for the
   * cleanest path (the URL field is seeded from localStorage on mount).
   */
  async setBridgeUrl(url: string): Promise<void> {
    await this.page.evaluate((u) => {
      try {
        localStorage.setItem('comfyui-mcp.panel.bridgeUrl', u)
      } catch {
        // ignore — fall back to the input below
      }
      const input = document.querySelector<HTMLInputElement>(
        '.cmcp-root .cmcp-input'
      )
      if (input) input.value = u
    }, url)
  }

  /**
   * Open the connection settings popover and click Reconnect, which calls the
   * bridge client's setUrl(urlInput.value) -> connect(). This is the agent-free
   * connect path: it does NOT POST /connect (which would start a real backend).
   * Waits for the handshake (status "connected").
   */
  async connect(): Promise<void> {
    await this.openConnectionSettings()
    await this.reconnectButton.click()
    await this.waitForStatus('connected')
  }

  async openConnectionSettings(): Promise<void> {
    if (!(await this.connectionPopover.isVisible().catch(() => false))) {
      await this.statusPill.click()
    }
    await this.connectionPopover.waitFor({ state: 'visible' })
  }

  /** Current connection state word shown in the status pill. */
  async status(): Promise<PanelStatus> {
    return (await this.statusPill.innerText()).trim().toLowerCase()
  }

  async waitForStatus(state: PanelStatus, timeout = 20_000): Promise<void> {
    await expect(this.statusPill).toContainText(state, { timeout })
  }

  /** Type a message into the composer and submit it (Enter). */
  async sendMessage(text: string): Promise<void> {
    await this.composerInput.click()
    await this.composerInput.fill(text)
    await this.composerInput.press('Enter')
  }

  /** Text of the last agent reply bubble. */
  async lastAgentReply(): Promise<string> {
    const last = this.agentBubbles.last()
    await last.waitFor({ state: 'visible' })
    return (await last.innerText()).trim()
  }

  /** Number of messages currently waiting in the pending tray. */
  async pendingCount(): Promise<number> {
    if (!(await this.pendingTray.isVisible().catch(() => false))) return 0
    return this.pendingItems.count()
  }

  /** A user bubble for a specific message text (most recent match). */
  userBubble(text: string): Locator {
    return this.userBubbles.filter({ hasText: text }).last()
  }
}
