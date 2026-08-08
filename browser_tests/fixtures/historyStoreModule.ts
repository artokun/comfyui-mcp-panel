import type { Page } from '@playwright/test'

/**
 * Resolve the extension mount ComfyUI actually loaded. Registry installs use
 * `comfyui-agent-panel`, while repository-named dev junctions commonly use
 * `comfyui-mcp-panel`; tests must work with either without editing the spec.
 *
 * panel#793 — this used to probe the two known names with `fetch` and take the
 * first that answered 200. That is unsound HERE, and produced three specs that
 * failed with an error naming a file which had loaded perfectly:
 *
 *     TypeError: Failed to fetch dynamically imported module:
 *     http://localhost:8188/extensions/comfyui-agent-panel/js/lib/chat-history-store.js
 *
 * The specs route `/extensions/<any>/js/lib/chat-history-store.js` to serve the
 * checked-out source instead of the server's copy. That pattern matches EVERY
 * mount, so the probe got 200 for a mount this server does not have, and picked
 * whichever name the candidate list held first. The module then imported its
 * relative sibling `./workflow-chat-identity.js`, which is NOT routed — measured
 * against the live server, 404 under the wrong mount and 200 under the right
 * one. Chrome reports a failed dependency against the URL you asked for, not the
 * one that 404'd, so the message accused the routed file.
 *
 * So ask the server which mount it serves rather than probing a route the test
 * has already overridden.
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
    // ComfyUI's own extension list is authoritative and is not routed by any
    // spec, so it survives the interception that defeats a probe.
    try {
      const response = await fetch('/api/extensions', { cache: 'no-store' })
      if (response.ok) {
        const listed: unknown = await response.json()
        const entry = Array.isArray(listed)
          ? listed.find(
              (path): path is string =>
                typeof path === 'string' && /\/js\/comfyui-mcp-panel\.js$/.test(path)
            )
          : undefined
        if (entry) {
          return new URL('./lib/chat-history-store.js', new URL(entry, location.href)).href
        }
      }
    } catch {
      // Fall through to the probe below.
    }

    // Last resort. Probe a file NO spec routes — routing the module under test
    // is exactly what made the old probe lie. If a future spec starts routing
    // this sibling too, this branch will start lying in the same way.
    for (const mount of ['comfyui-mcp-panel', 'comfyui-agent-panel']) {
      const sibling = new URL(
        `/extensions/${mount}/js/lib/workflow-chat-identity.js`,
        location.href
      )
      try {
        const response = await fetch(sibling, { cache: 'no-store' })
        if (response.ok) {
          return new URL(`/extensions/${mount}/js/lib/chat-history-store.js`, location.href).href
        }
      } catch {
        // Try the next mount.
      }
    }

    throw new Error('Unable to resolve the Agent Panel chat-history module mount')
  })
}
