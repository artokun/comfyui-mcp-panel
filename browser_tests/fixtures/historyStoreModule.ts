import type { Page } from '@playwright/test'

/**
 * Resolve the extension mount ComfyUI actually loaded. Registry installs use
 * `comfyui-agent-panel`, while repository-named dev junctions commonly use
 * `comfyui-mcp-panel`; tests must work with either without editing the spec.
 */
export async function resolveHistoryStoreModuleUrl(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const panelResource = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => /\/extensions\/[^/]+\/js\/comfyui-mcp-panel\.js(?:[?#]|$)/.test(url))

    if (panelResource) {
      return new URL('./lib/chat-history-store.js', panelResource).href
    }

    // Some browser builds omit module requests from the resource timeline.
    // Probe the two supported mount names rather than assuming the registry one.
    for (const mount of ['comfyui-agent-panel', 'comfyui-mcp-panel']) {
      const candidate = new URL(`/extensions/${mount}/js/lib/chat-history-store.js`, location.href)
      try {
        const response = await fetch(candidate, { cache: 'no-store' })
        if (response.ok) return candidate.href
      } catch {
        // Try the next mount.
      }
    }

    throw new Error('Unable to resolve the Agent Panel chat-history module mount')
  })
}
