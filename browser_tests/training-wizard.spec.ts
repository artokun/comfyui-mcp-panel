/**
 * Tier 1 — LoRA Training wizard.
 *
 * Drives the Character-LoRA wizard end-to-end against canned backends:
 *   - the /comfyui_mcp_panel/training/* py routes are route-intercepted
 *     (deterministic, no dependence on real output files), and
 *   - train_* call_tool frames over the bridge are answered by the MockBridge
 *     (onFrame) with scripted train_doctor / train_prepare_dataset /
 *     train_start payloads.
 *
 * Asserts the wizard walks gather → label → launch → monitor, issues the
 * right tool calls with the right payloads, and renders the completion card.
 *
 * THE STUB KEYS ON (tool, action), NEVER ON tool ALONE. 0.50.0 slice 10 folded
 * eighteen train_* names into three, so ONE name now carries what were separate
 * tools: `train_start` is start AND status AND cancel AND list_flows AND
 * job_config. A name-only stub would answer the capability probe
 * (action:"list_flows") with a job-started envelope and hand every later
 * assertion the WRONG call — `calls.find(c => c.tool === 'train_start')` would
 * match the probe, not the launch. Keying on the pair is what keeps this a test
 * of the wizard rather than of whichever call happened to arrive first.
 */
import { test, expect } from './fixtures/panelTest'

// panel#793 — the Training entry point is behind an off-by-default flag; see
// the note on `panelFlags` in fixtures/panelTest.ts.
test.use({ panelFlags: ['comfyui-mcp.featureFlag.training'] })

const OUT_IMAGES = [
  { filename: 'char_a.png', subfolder: '', type: 'output', size: 100, mtime: 2000 },
  { filename: 'char_b.png', subfolder: '', type: 'output', size: 100, mtime: 1000 }
]

function toolResult(text: unknown) {
  return [{ type: 'text', text: JSON.stringify(text) }]
}

test('character LoRA wizard: gather → label → launch → monitor', async ({
  page,
  panel,
  mockBridge
}) => {
  // --- canned py routes -------------------------------------------------
  await page.route('**/comfyui_mcp_panel/training/list-outputs*', (route) =>
    route.fulfill({ json: { images: OUT_IMAGES } })
  )
  await page.route('**/comfyui_mcp_panel/training/resolve-paths', (route) =>
    route.fulfill({
      json: {
        paths: OUT_IMAGES.map((i) => ({
          path: `C:/rig/output/${i.filename}`,
          filename: i.filename,
          subfolder: null,
          type: 'output'
        }))
      }
    })
  )
  // Thumbnails via /view — any tiny body is fine (background-image doesn't care).
  await page.route('**/view?*', (route) =>
    route.fulfill({ body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' })
  )

  // --- scripted train_* tool answers ------------------------------------
  const calls: Array<{ tool: string; action: unknown; args: Record<string, unknown> }> = []
  let statusPayload: unknown = null
  mockBridge.onFrame((frame) => {
    if (frame.type !== 'call_tool') return
    const cid = frame.cid as string
    const tool = frame.tool as string
    const args = (frame.args ?? {}) as Record<string, unknown>
    const action = args.action
    calls.push({ tool, action, args })
    const reply = (payload: unknown, ok = true) =>
      mockBridge.send({ type: 'tool_result', cid, tool, ok, result: toolResult(payload) })
    const is = (t: string, a: string) => tool === t && action === a
    if (is('train_doctor', 'doctor')) {
      reply({ ok: true, command: 'train_doctor', data: { docker: true, gpu: true, image: true, image_tag: 't:latest', hints: [], hfTokenSet: true, localFs: true } })
    } else if (is('train_start', 'list_flows')) {
      reply({ ok: true, flows: [{ id: 'character' }], defaultParams: {} })
    } else if (is('train_prepare_dataset', 'prepare')) {
      reply({ ok: true, datasetPath: 'C:/rig/training/datasets/test_char', imageCount: 2, captionedCount: 2, warnings: [] })
    } else if (is('train_start', 'start')) {
      const job = {
        id: 'tjob1', name: 'test_char', flow: 'character', model: 'flux1-dev',
        trigger: 'ohwx', status: 'running',
        progress: { samples: [] }, containerName: 'c1',
        datasetPath: args.datasetPath, jobDir: 'j', outputDir: 'o', log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      }
      reply({ ok: true, job })
      statusPayload = {
        ok: true,
        job: { ...job, progress: { samples: [], step: 40, totalSteps: 200, loss: 0.42 }, log: ['40/200 loss: 0.42'] }
      }
    } else if (is('train_start', 'status')) {
      reply(statusPayload ?? { ok: true, count: 0, jobs: [] })
    } else if (is('train_start', 'job_config')) {
      reply({ ok: true, params: { steps: 2000 }, flow: 'character', model: 'flux1-dev', trigger: 'ohwx', datasetPath: 'C:/rig/training/datasets/test_char' })
    } else if (is('train_start', 'cancel')) {
      reply({ ok: true })
    }
  })

  // --- walk the wizard ---------------------------------------------------
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  await page.getByRole('button', { name: 'Training', exact: true }).click()
  const modal = page.locator('.cmcp-tr-modal')
  await expect(modal).toBeVisible()
  await modal.getByRole('button', { name: 'Start' }).click()

  // Gather: name + trigger, pick both canned outputs.
  await modal.locator('input[type=text]').first().fill('test_char')
  await modal.locator('input[type=text]').nth(1).fill('ohwx')
  const cells = modal.locator('.cmcp-tr-pick')
  await expect(cells).toHaveCount(2)
  await cells.nth(0).click()
  await cells.nth(1).click()
  await expect(modal.locator('.cmcp-tr-chip')).toHaveCount(2)
  await modal.getByRole('button', { name: /Next: label captions/ }).click()

  // Label: prefix the trigger into both captions.
  await expect(modal.locator('textarea')).toHaveCount(2)
  await modal.getByRole('button', { name: /Prefix/ }).click()
  await expect(modal.locator('textarea').nth(0)).toHaveValue('ohwx')
  await expect(modal.locator('textarea').nth(1)).toHaveValue('ohwx')
  await modal.locator('textarea').nth(0).fill('ohwx woman, studio portrait')
  await modal.getByRole('button', { name: /Next: review & launch/ }).click()

  // Launch: preflight renders, then fire.
  await expect(modal.locator('.cmcp-tr-preflight')).toContainText('docker:', { timeout: 15_000 })
  await modal.getByRole('button', { name: 'Launch training' }).click()

  // Monitor: running progress renders from the scripted train_start action:"status".
  await expect(modal.locator('.cmcp-tr-hint').filter({ hasText: /step 40\/200/ })).toBeVisible({ timeout: 15_000 })

  // Complete the run: flip the scripted status to completed and let the next poll land.
  statusPayload = {
    ok: true,
    job: {
      id: 'tjob1', name: 'test_char', flow: 'character', model: 'flux1-dev', trigger: 'ohwx',
      status: 'completed',
      progress: { samples: [], step: 200, totalSteps: 200, loss: 0.2 },
      containerName: 'c1', datasetPath: 'd', jobDir: 'j', outputDir: 'o',
      log: ['done'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: { loraPath: 'x', loraRelPath: 'loras/test_char.safetensors', catalogId: 'loras-test-char' }
    }
  }
  await expect(modal.getByText('LoRA ready ✓')).toBeVisible({ timeout: 15_000 })

  // --- assert the tool-call sequence ------------------------------------
  // Pairs, not names. `train_start` alone would be satisfied by the capability
  // probe (action:"list_flows"), which proves nothing about the launch.
  const pairs = calls.map((c) => `${c.tool}:${String(c.action)}`)
  expect(pairs).toContain('train_doctor:doctor')
  expect(pairs).toContain('train_start:list_flows')
  expect(pairs).toContain('train_prepare_dataset:prepare')
  expect(pairs).toContain('train_start:start')
  expect(pairs).toContain('train_start:status')

  // EVERY train_* frame must carry an action. `action` is REQUIRED on all three
  // survivors, so a call that omits it fails core's schema validation even
  // though its NAME is alive — a break the vocabulary gate structurally cannot
  // see, because it only hunts dead names. This is the only check that does.
  const actionless = calls.filter((c) => typeof c.action !== 'string' || c.action === '')
  expect(
    actionless,
    `call_tool frames with no action: ${JSON.stringify(actionless.map((c) => c.tool))}`
  ).toEqual([])

  const prep = calls.find((c) => c.tool === 'train_prepare_dataset' && c.action === 'prepare')!
  expect(prep.args.name).toBe('test_char')
  expect(prep.args.defaultCaption).toBe('ohwx')
  const items = prep.args.items as Array<{ path: string; caption?: string }>
  expect(items).toHaveLength(2)
  expect(items[0].path).toBe('C:/rig/output/char_a.png')
  expect(items[0].caption).toBe('ohwx woman, studio portrait')
  expect(items[1].caption).toBe('ohwx')

  const start = calls.find((c) => c.tool === 'train_start' && c.action === 'start')!
  expect(start.args.name).toBe('test_char')
  expect(start.args.flow).toBe('character')
  expect(start.args.model).toBe('flux1-dev')
  expect(start.args.datasetPath).toBe('C:/rig/training/datasets/test_char')
  expect(start.args.trigger).toBe('ohwx')
  expect((start.args.params as { steps: number }).steps).toBe(2000)
})
