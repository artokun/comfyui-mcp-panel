/**
 * mcp#1998 — a SCOPED batch must not queue N byte-identical prompts.
 *
 * This is the CALL-SITE test. The unit tests in
 * `browser_tests/unit/scoped-batch-seed.test.mjs` prove the drive computes the right
 * thing against a port of the frontend's hook; this one drives the REAL `graph_run`
 * through the REAL bridge frame against the REAL ComfyUI frontend, and reads the seeds
 * out of the bodies the panel actually POSTs. A helper can be perfect and unreached.
 *
 * NOTHING IS QUEUED. `api.fetchApi` is wrapped BEFORE the run so the panel's own scoped
 * guard chains on top of it, and every POST /prompt is answered locally with a synthetic
 * accepted reply. No GPU time, no model needed, no queue traffic on a shared instance —
 * the same technique the #988 investigation used.
 *
 * WHAT THE BUG LOOKED LIKE HERE, measured before the fix on ComfyUI 0.33.2 /
 * frontend 1.49.6: the four posts carried seed 707000, 707000, 707000, 707000.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { test, expect } from './fixtures/panelTest'
import { routeWorktreeSource } from './fixtures/worktreeSource'

// Resolved from the Playwright cwd, the same way worktreeSource.ts resolves web/js —
// `import.meta` is unavailable in this suite's CommonJS transform.
const WORKFLOW = JSON.parse(
  readFileSync(resolve('browser_tests/fixtures/scoped-batch-workflow.json'), 'utf8')
)
/** ids inside that fixture. */
const KSAMPLER_ID = '3'
const SAVE_IMAGE_ID = 9
const START_SEED = 707000

test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

type Posted = { seed: unknown; scoped: boolean }

async function loadFixtureGraph(
  page: import('@playwright/test').Page,
  mode: string
): Promise<void> {
  await page.evaluate(
    async ({ wf, mode, ksId, startSeed }) => {
      const app = (window as any).app
      await app.loadGraphData(wf, true, true, 'cmcp-1998-scoped-batch')
      await new Promise((r) => setTimeout(r, 1500))
      const ks = app.rootGraph._nodes.find((n: any) => String(n.id) === ksId)
      if (!ks) throw new Error('fixture graph did not load: no KSampler')
      ks.widgets.find((w: any) => w.name === 'control_after_generate').value = mode
      ks.widgets.find((w: any) => w.name === 'seed').value = startSeed
    },
    { wf: WORKFLOW, mode, ksId: KSAMPLER_ID, startSeed: START_SEED }
  )
}

/** Answer every POST /prompt locally and record what it carried. */
async function interceptPrompts(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).comfyAPI.api.api
    ;(window as any).__posted1998 = []
    const orig = api.fetchApi.bind(api)
    ;(window as any).__restore1998 = () => {
      api.fetchApi = orig
    }
    api.fetchApi = async (route: string, opts: any) => {
      if (String(route).startsWith('/prompt') && opts?.method === 'POST') {
        let body: any = null
        try {
          body = JSON.parse(opts.body)
        } catch {
          /* recorded as null, which fails the assertions loudly */
        }
        ;(window as any).__posted1998.push(body)
        const n = (window as any).__posted1998.length
        return new Response(
          JSON.stringify({ prompt_id: `e2e-1998-${n}`, number: n, node_errors: {} }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return orig(route, opts)
    }
  })
}

async function readPosted(page: import('@playwright/test').Page): Promise<Posted[]> {
  return page.evaluate((ksId) => {
    const posted = (window as any).__posted1998 ?? []
    ;(window as any).__restore1998?.()
    return posted.map((b: any) => ({
      seed: b?.prompt?.[ksId]?.inputs?.seed,
      scoped: Array.isArray(b?.partial_execution_targets) && b.partial_execution_targets.length > 0
    }))
  }, KSAMPLER_ID)
}

async function runScopedBatch(
  page: import('@playwright/test').Page,
  panel: any,
  mockBridge: any,
  mode: string,
  batchCount: number
): Promise<{ reply: any; posted: Posted[] }> {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await loadFixtureGraph(page, mode)
  await interceptPrompts(page)
  const reply = await mockBridge.command(
    'graph_run',
    { batch_count: batchCount, to_node_id: SAVE_IMAGE_ID },
    45_000
  )
  const posted = await readPosted(page)
  return { reply, posted }
}

test('mcp#1998 a scoped randomize batch posts a DIFFERENT seed for every item', async ({
  page,
  panel,
  mockBridge
}) => {
  const { reply, posted } = await runScopedBatch(page, panel, mockBridge, 'randomize', 4)

  expect(reply.ok, JSON.stringify(reply)).toBeTruthy()
  expect(posted, 'the panel must post one prompt per batch item').toHaveLength(4)

  // The SCOPE must survive. This fix must never buy distinct seeds by dropping
  // partial_execution_targets and running the whole graph (#556).
  expect(posted.every((p) => p.scoped), JSON.stringify(posted)).toBe(true)

  const seeds = posted.map((p) => p.seed)
  expect(seeds[0], 'the first item still carries the seed the user can see').toBe(START_SEED)
  expect(new Set(seeds).size, `expected four distinct seeds, got ${JSON.stringify(seeds)}`).toBe(4)
})

test('mcp#1998 a scoped FIXED batch still posts the SAME seed for every item', async ({
  page,
  panel,
  mockBridge
}) => {
  const { reply, posted } = await runScopedBatch(page, panel, mockBridge, 'fixed', 4)

  expect(reply.ok, JSON.stringify(reply)).toBeTruthy()
  expect(posted).toHaveLength(4)
  expect(posted.every((p) => p.scoped)).toBe(true)

  const seeds = posted.map((p) => p.seed)
  expect(seeds, 'fixed means "repeat", and repeating is what the user asked for').toEqual([
    START_SEED,
    START_SEED,
    START_SEED,
    START_SEED
  ])
})

test('mcp#1998 a scoped batch of ONE leaves ComfyUI_frontend #8774 alone', async ({
  page,
  panel,
  mockBridge
}) => {
  const { posted } = await runScopedBatch(page, panel, mockBridge, 'randomize', 1)

  expect(posted).toHaveLength(1)
  expect(posted[0].seed, 'a single scoped preview must submit exactly the visible seed').toBe(
    START_SEED
  )
  // …and the widget must be untouched afterwards: upstream disables the control for a
  // partial execution so iterating on one branch does not churn the seed, and that is
  // only overridden for a batch.
  const after = await page.evaluate((ksId) => {
    const app = (window as any).app
    const ks = app.rootGraph._nodes.find((n: any) => String(n.id) === ksId)
    return ks?.widgets.find((w: any) => w.name === 'seed')?.value
  }, KSAMPLER_ID)
  expect(after).toBe(START_SEED)
})
