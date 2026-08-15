/**
 * Serve this checkout's web/js tree in place of the target ComfyUI's installed
 * copy.
 *
 * The dev ComfyUI loads the pack from a git-linked checkout that may be on a
 * different branch (or simply older) than the worktree under test, and the
 * panel is ~80 ES modules that must agree on their import shapes: mixing this
 * worktree's comfyui-mcp-panel.js with a stale server lib/ kills the module at
 * import time and the Agent tab never registers. Routing the WHOLE tree keeps
 * the module graph coherent and makes the specs exercise this commit.
 */
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { BrowserContext } from '@playwright/test'

const WEB_JS_ROOT = resolve('web/js')
const sourceCache = new Map<string, string | null>()

function worktreeSource(relPath: string): string | null {
  const cached = sourceCache.get(relPath)
  if (cached !== undefined) return cached
  const file = resolve(WEB_JS_ROOT, relPath)
  let body: string | null = null
  // Refuse path escapes; unknown files fall through to the live server.
  if (file === WEB_JS_ROOT || file.startsWith(WEB_JS_ROOT + sep)) {
    try {
      body = readFileSync(file, 'utf8')
    } catch {
      body = null
    }
  }
  sourceCache.set(relPath, body)
  return body
}

export async function routeWorktreeSource(context: BrowserContext) {
  await context.route(/\/extensions\/[^/]+\/js\/.+\.js(?:\?.*)?$/, (route) => {
    const pathname = new URL(route.request().url()).pathname
    const relPath = pathname.replace(/^.*\/extensions\/[^/]+\/js\//, '')
    const body = worktreeSource(relPath)
    return body == null
      ? route.continue()
      : route.fulfill({ contentType: 'text/javascript', body })
  })
}
