/**
 * Tier 1 — Micro-Apps ("Apps") panel feature.
 *
 * Hermetic: the /comfyui_mcp_panel/apps* routes are stubbed with an in-memory
 * store (the dev box's real bundles are never touched), and the live canvas is
 * stubbed with a fixture graph (graphToPrompt + graph._nodes + node defs) so
 * "Convert current workflow" has something deterministic to serialize.
 *
 * Covers: empty grid → convert (fixture canvas) → card appears → detail →
 * one-click run (patched values POSTed, outputs rendered) → hide-workflow
 * (manifest update, warning copy present).
 */
import { test, expect } from './fixtures/panelTest'
import type { Page, Route } from '@playwright/test'

const APP_ID = '123e4567-e89b-42d3-a456-426614174000'

// 1x1 transparent PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const FIXTURE_PROMPT = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 42, steps: 20, model: ['4', 0], positive: ['6', 0] }
  },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } }
}

const FIXTURE_WORKFLOW = {
  last_node_id: 9,
  last_link_id: 5,
  nodes: [],
  links: [],
  groups: [],
  config: {},
  extra: {},
  version: 0.4
}

interface StoredApp {
  manifest: Record<string, unknown> & { id: string; name: string }
  workflow?: unknown
  prompt: unknown
}

/** In-memory apps API + fixture canvas. Returns the captured HTTP traffic. */
async function stubAppsBackend(page: Page) {
  const store = new Map<string, StoredApp>()
  const captured: { method: string; url: string; body: unknown }[] = []
  const record = (route: Route) => {
    const req = route.request()
    let body: unknown = null
    try {
      body = req.postDataJSON()
    } catch {
      /* no JSON body */
    }
    captured.push({ method: req.method(), url: req.url(), body })
  }

  await page.route('**/comfyui_mcp_panel/apps', async (route) => {
    record(route)
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as StoredApp
      store.set(body.manifest.id, body)
      return route.fulfill({ json: { ok: true, id: body.manifest.id } })
    }
    return route.fulfill({
      json: {
        apps: [...store.values()].map((s) => ({
          ...s.manifest,
          has_workflow: !!s.workflow,
          has_prompt: true,
          has_thumbnail: false
        }))
      }
    })
  })

  await page.route(/\/comfyui_mcp_panel\/apps\/[0-9a-f-]{36}$/, async (route) => {
    record(route)
    const id = route.request().url().split('/').pop()!
    const s = store.get(id)
    if (!s) return route.fulfill({ status: 404, json: { error: 'not found' } })
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { manifest?: Record<string, unknown> }
      s.manifest = { ...s.manifest, ...(body.manifest || {}) }
      return route.fulfill({ json: s.manifest })
    }
    if (route.request().method() === 'DELETE') {
      store.delete(id)
      return route.fulfill({ json: { ok: true } })
    }
    return route.fulfill({
      json: { ...s.manifest, has_workflow: !!s.workflow, has_prompt: true, has_thumbnail: false }
    })
  })

  await page.route(/\/comfyui_mcp_panel\/apps\/[0-9a-f-]{36}\/bundle$/, async (route) => {
    record(route)
    const id = route.request().url().split('/').slice(-2, -1)[0]
    const s = store.get(id)
    if (!s) return route.fulfill({ status: 404, json: { error: 'not found' } })
    return route.fulfill({ json: { manifest: s.manifest, prompt: s.prompt, ...(s.workflow ? { workflow: s.workflow } : {}) } })
  })

  await page.route(/\/comfyui_mcp_panel\/apps\/[0-9a-f-]{36}\/run$/, async (route) => {
    record(route)
    const id = route.request().url().split('/').slice(-2, -1)[0]
    const body = route.request().postDataJSON() as {
      values?: Record<string, unknown>
      dry?: boolean
    }
    if (body?.dry) {
      // Mirror the server's dry-run: patch values into the stored snapshot and
      // hand the prompt back instead of queueing.
      const s = store.get(id)
      if (!s) return route.fulfill({ status: 404, json: { error: 'not found' } })
      const patched = JSON.parse(JSON.stringify(s.prompt)) as Record<
        string,
        { inputs: Record<string, unknown> }
      >
      for (const [key, value] of Object.entries(body.values || {})) {
        const dot = key.indexOf('.')
        patched[key.slice(0, dot)].inputs[key.slice(dot + 1)] = value
      }
      return route.fulfill({ json: { ok: true, prompt: patched } })
    }
    return route.fulfill({ json: { ok: true, prompt_id: 'p1', number: 1 } })
  })

  await page.route(/\/comfyui_mcp_panel\/apps\/[0-9a-f-]{36}\/runs\/p1$/, async (route) => {
    record(route)
    return route.fulfill({
      json: {
        prompt_id: 'p1',
        status: 'done',
        status_detail: {},
        outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } }
      }
    })
  })

  await page.route(/\/view\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
  )

  // Fixture canvas: what the convert flow serializes + picks candidates from.
  // Called explicitly AFTER panel.goto() (ComfyUI replaces app.graph while
  // restoring the user's workflow on load, so an addInitScript patch races and
  // loses) AND again right before Convert (a late workflow-restore swap would
  // otherwise clobber it). Patches BOTH app references — the panel's lazily
  // resolved `app` and window.app can differ across frontends.
  const installFixtureCanvas = async () => {
    // The graph object appears only after the frontend restores the workflow.
    await page.waitForFunction(() => {
      const w = window as unknown as { comfyAPI?: { app?: { app?: any } }; app?: any }
      const app = w.comfyAPI?.app?.app || w.app
      return !!app?.graph
    })
    await page.evaluate(() => {
      const w = window as unknown as { comfyAPI?: { app?: { app?: any } }; app?: any }
      const apps = new Set([w.comfyAPI?.app?.app, w.app].filter(Boolean))
      if (!apps.size) throw new Error('ComfyUI app not ready')
      for (const app of apps) {
      app.graphToPrompt = async () => ({
        output: JSON.parse(
          '{"4":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"flux.safetensors"}},"6":{"class_type":"CLIPTextEncode","inputs":{"text":"a cat","clip":["4",1]}},"3":{"class_type":"KSampler","inputs":{"seed":42,"steps":20}},"9":{"class_type":"SaveImage","inputs":{"images":["8",0],"filename_prefix":"ComfyUI"}}}'
        ),
        workflow: {
          last_node_id: 9,
          nodes: [],
          links: [],
          groups: [],
          config: {},
          extra: {},
          version: 0.4
        }
      })
      const node = (id: number, type: string, widgets: unknown[], outputNode = false, inputs: unknown[] = []) => ({
        id,
        type,
        title: type,
        inputs,
        widgets,
        constructor: { nodeData: { output_node: outputNode } }
      })
      // Mutate the LIVE graph in place (assigning app.graph trips ComfyApp's
      // graph setter and the async workflow restore then clobbers our fixture).
      if (!app.graph) throw new Error('no live graph')
      app.graph._nodes = [
          node(4, 'CheckpointLoaderSimple', [
            { name: 'ckpt_name', value: 'flux.safetensors', type: 'combo', options: { values: ['flux.safetensors', 'sdxl.safetensors'] } }
          ]),
          // Unconnected widget-input SOCKET (link: null — how modern frontends
          // materialize every widget): must STAY a candidate.
          node(6, 'CLIPTextEncode', [{ name: 'text', value: 'a cat', type: 'text' }], false, [
            { name: 'text', widget: { name: 'text' }, link: null }
          ]),
          node(3, 'KSampler', [
            { name: 'seed', value: 42, type: 'number' },
            { name: 'steps', value: 20, type: 'number' }
          ], false, [
            // CONNECTED widget input: seed is link-driven → excluded.
            { name: 'seed', widget: { name: 'seed' }, link: 7 }
          ]),
          node(9, 'SaveImage', [], true)
        ]
      app.nodeManager = {
        ...(app.nodeManager || {}),
        defs: {
          CheckpointLoaderSimple: {},
          CLIPTextEncode: {},
          KSampler: {},
          SaveImage: {},
          VAEDecode: {}
        }
      }
      }
    })
  }

  return { store, captured, installFixtureCanvas }
}

test('convert canvas → app card → detail → one-click run with patched values', async ({
  panel,
  page
}) => {
  const { store, captured, installFixtureCanvas } = await stubAppsBackend(page)
  await panel.goto()
  await installFixtureCanvas()
  await panel.openSidebar()

  // Open the Apps modal from the toolbar; empty state first.
  await panel.root.getByRole('button', { name: 'Apps', exact: true }).click()
  const modal = page.locator('.cmcp-apps-modal')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('No apps yet')

  // Convert: candidates pre-checked from the fixture graph. Re-install right
  // before — a late workflow-restore swap can clobber the earlier patch.
  await installFixtureCanvas()
  await modal.getByRole('button', { name: 'Convert current workflow' }).click()
  await expect(modal.getByText('Inputs — the endpoints this app exposes')).toBeVisible()
  // Widget-input guard: the UNCONNECTED text socket stays a candidate; the
  // CONNECTED (link-driven) seed is excluded.
  const pickRows = modal.locator('.cmcp-apps-pick label')
  await expect(pickRows.filter({ hasText: 'text' })).not.toHaveCount(0)
  await expect(pickRows.filter({ hasText: 'seed' })).toHaveCount(0)
  await expect(pickRows.filter({ hasText: 'steps' })).not.toHaveCount(0)
  await modal.locator('.cmcp-apps-field input[type=text]').fill('Fixture App')
  await modal.locator('.cmcp-apps-field textarea').fill('Made from a fixture graph')
  await modal.getByRole('button', { name: 'Create app' }).click()

  // POST captured the bundle: manifest + workflow + prompt snapshot.
  const create = captured.find((c) => c.method === 'POST' && c.url.endsWith('/apps'))
  expect(create).toBeTruthy()
  const bundle = create!.body as StoredApp
  expect(bundle.manifest.name).toBe('Fixture App')
  expect((bundle.prompt as Record<string, unknown>)['6']).toBeTruthy()

  // Card appears; open the detail view.
  const card = modal.locator('.cmcp-app-card', { hasText: 'Fixture App' })
  await expect(card).toBeVisible()
  await card.click()

  // Generated form carries the conversion-time defaults (the prompt field is
  // the CLIPTextEncode row — the model field above it is also a textarea).
  const promptArea = modal
    .locator('.cmcp-apps-field', { hasText: 'CLIPTextEncode' })
    .locator('textarea')
  await expect(promptArea).toHaveValue('a cat')
  await promptArea.fill('a dog')

  // One-click run: values patched as <nodeId>.<widget>, outputs rendered.
  await modal.getByRole('button', { name: '▶ Run' }).click()
  await expect(modal.locator('.cmcp-apps-status').last()).toHaveText('Done.')
  await expect(modal.locator('.cmcp-apps-outputs img')).toHaveCount(1)
  const run = captured.find((c) => c.url.endsWith('/run'))
  expect((run!.body as { values: Record<string, unknown> }).values['6.text']).toBe('a dog')
  expect(store.size).toBe(1)
})

test('run on RunPod: dry-patches locally, enqueues on the pod via the bridge', async ({
  panel,
  page,
  mockBridge
}) => {
  const { store } = await stubAppsBackend(page)
  store.set(APP_ID, {
    manifest: {
      id: APP_ID,
      name: 'Pod App',
      description: '',
      version: 1,
      hideWorkflow: false,
      appMode: {
        inputs: [
          { nodeId: 6, widget: 'text', label: 'Prompt', kind: 'text', default: 'a cat' },
          { nodeId: 5, widget: 'image', label: 'Face', kind: 'image' }
        ],
        outputs: [],
        importedFromFrontend: false
      },
      deps: { models: [], customNodes: [] },
      published: null
    },
    workflow: FIXTURE_WORKFLOW,
    prompt: {
      ...FIXTURE_PROMPT,
      '5': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } }
    }
  })

  // Answer the bridge's whitelisted call_tool surface: capture enqueue_workflow.
  const toolCalls: { tool: string; args: Record<string, unknown> }[] = []
  const uploads: { filename: string; mime: string }[] = []
  mockBridge.onFrame((frame) => {
    if (frame.type === 'upload_media') {
      uploads.push({ filename: String(frame.filename), mime: String(frame.mime) })
      mockBridge.send({
        type: 'media_uploaded',
        cid: frame.cid,
        ok: true,
        name: 'pod_img_00001.png',
        kind: 'image'
      })
      return
    }
    if (frame.type !== 'call_tool') return
    toolCalls.push({ tool: String(frame.tool), args: (frame.args || {}) as Record<string, unknown> })
    mockBridge.send({
      type: 'tool_result',
      cid: frame.cid,
      ok: true,
      result: [
        { type: 'text', text: JSON.stringify({ status: 'enqueued', prompt_id: 'pod-1', queue_remaining: 0 }) }
      ]
    })
  })

  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  // Honest host: renders go to a pod now.
  mockBridge.send({ type: 'comfyui_target', is_local: false, url: 'http://pod.example:8188' })

  await panel.root.getByRole('button', { name: 'Apps', exact: true }).click()
  const modal = page.locator('.cmcp-apps-modal')
  await modal.locator('.cmcp-app-card', { hasText: 'Pod App' }).click()
  await modal.locator('.cmcp-apps-field textarea').first().fill('a pod dog')
  // Image input: the bytes must go THROUGH THE BRIDGE to the pod, and the
  // patched prompt must carry the pod-side filename.
  await modal.locator('input[type=file]').setInputFiles({
    name: 'face.png',
    mimeType: 'image/png',
    buffer: PIXEL
  })
  await modal.getByRole('button', { name: '☁ Run on RunPod' }).click()

  await expect(modal.locator('.cmcp-apps-status')).toContainText('queued on pod (prompt_id pod-1)')
  // The remote name is uniquified (app prefix + random) so same-basename
  // inputs can never overwrite each other on the pod.
  expect(uploads).toHaveLength(1)
  expect(uploads[0].mime).toBe('image/png')
  expect(uploads[0].filename).toMatch(/^cmcp-app-123e4567-[0-9a-f]{8}-face\.png$/)
  const enqueue = toolCalls.find((c) => c.tool === 'enqueue_workflow')
  expect(enqueue).toBeTruthy()
  const wf = enqueue!.args.workflow as Record<string, { inputs: Record<string, unknown> }>
  expect(wf['6'].inputs.text).toBe('a pod dog')
  expect(wf['5'].inputs.image).toBe('pod_img_00001.png')
  // App inputs are the user's choices — the seed is never re-rolled.
  expect(enqueue!.args.disable_random_seed).toBe(true)
  // Nothing hit the LOCAL queue path.
  expect(store.size).toBe(1)
})

test('run on RunPod without a connected pod is an honest error, not a silent local run', async ({
  panel,
  page,
  mockBridge
}) => {
  const { store } = await stubAppsBackend(page)
  store.set(APP_ID, {
    manifest: {
      id: APP_ID,
      name: 'Local Only',
      description: '',
      version: 1,
      hideWorkflow: false,
      appMode: {
        inputs: [{ nodeId: 6, widget: 'text', label: 'Prompt', kind: 'text' }],
        outputs: [],
        importedFromFrontend: false
      },
      deps: { models: [], customNodes: [] },
      published: null
    },
    workflow: FIXTURE_WORKFLOW,
    prompt: FIXTURE_PROMPT
  })

  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  // No comfyui_target frame at all → target unknown → treated as local.
  await panel.root.getByRole('button', { name: 'Apps', exact: true }).click()
  const modal = page.locator('.cmcp-apps-modal')
  await modal.locator('.cmcp-app-card', { hasText: 'Local Only' }).click()
  await modal.getByRole('button', { name: '☁ Run on RunPod' }).click()
  await expect(modal.locator('.cmcp-apps-status')).toContainText('No pod connected')
})

test('hide workflow: warns honestly and strips the graph from the bundle', async ({
  panel,
  page
}) => {
  const { store, captured } = await stubAppsBackend(page)
  store.set(APP_ID, {
    manifest: {
      id: APP_ID,
      name: 'Secret Sauce',
      description: '',
      version: 1,
      hideWorkflow: false,
      appMode: { inputs: [{ nodeId: 6, widget: 'text', label: 'Prompt', kind: 'text' }], outputs: [], importedFromFrontend: false },
      deps: { models: [], customNodes: [] },
      published: null
    },
    workflow: FIXTURE_WORKFLOW,
    prompt: FIXTURE_PROMPT
  })
  await panel.goto()
  await panel.openSidebar()
  await panel.root.getByRole('button', { name: 'Apps', exact: true }).click()
  const modal = page.locator('.cmcp-apps-modal')
  await modal.locator('.cmcp-app-card', { hasText: 'Secret Sauce' }).click()

  // The native window.confirm is now a themed modal (cmcp-modal.js). The
  // honest-warning copy lives inside it; click its confirm button to proceed.
  await modal.getByRole('button', { name: /Hide workflow/ }).click()
  const confirm = page.locator('.cmcp-mdl')
  await expect(confirm).toContainText('DELETES the stored node graph')
  await page.locator('.cmcp-mdl-ok').click()

  // After confirming: the PUT flips the flag (stub drops workflow.json) and the
  // detail re-renders with the honest below-the-fold warning.
  await expect(modal).toContainText('Hidden workflow (best effort)')
  await expect(modal).toContainText('anyone technical who runs this app can still intercept')
  const put = captured.find((c) => c.method === 'PUT')
  expect((put!.body as { manifest: { hideWorkflow: boolean } }).manifest.hideWorkflow).toBe(true)
})

// ── Registry (P4): publish / explore / install, worker stubbed over HTTP ────

const REG_ID = '323e4567-e89b-42d3-a456-426614174002'

/** Mock the registry worker (any host — the client defaults to the production
 *  URL, and intercepting at the URL-pattern level keeps the spec hermetic). */
async function stubRegistry(page: Page) {
  const published = new Map<string, Record<string, unknown>>()
  const calls: { method: string; url: string; body: unknown }[] = []

  await page.route(/.*\/v1\/apps.*/, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    let body: unknown = null
    try {
      body = req.postDataJSON()
    } catch {
      /* GETs */
    }
    calls.push({ method: req.method(), url: url.pathname + url.search, body })

    if (req.method() === 'POST' && url.pathname === '/v1/apps') {
      const b = body as { app: { id: string; name: string }; creator_name: string }
      published.set(b.app.id, b as unknown as Record<string, unknown>)
      return route.fulfill({
        json: { ok: true, id: b.app.id, slug: `tester/${b.app.name.toLowerCase().replace(/\s+/g, '-')}`, version: 1 }
      })
    }
    if (req.method() === 'GET' && url.pathname === '/v1/apps') {
      return route.fulfill({
        json: {
          apps: [
            {
              id: REG_ID,
              slug: 'maker/cloud-app',
              name: 'Cloud App',
              description: 'from the registry',
              creator: 'maker',
              version: 3,
              hide_workflow: false,
              nsfw: false,
              stars: 12,
              runs: 340,
              score: 0,
              created_at: 1,
              updated_at: 2
            }
          ],
          next_cursor: null
        }
      })
    }
    if (req.method() === 'GET' && url.pathname.endsWith('/bundle')) {
      return route.fulfill({
        json: {
          format: 1,
          manifest: {
            id: REG_ID,
            name: 'Cloud App',
            description: 'from the registry',
            hideWorkflow: false,
            appMode: {
              inputs: [{ nodeId: 6, widget: 'text', label: 'Prompt', kind: 'text', default: 'hello' }],
              outputs: [],
              importedFromFrontend: false
            },
            deps: {
              models: [{ name: 'flux.safetensors', widget: 'ckpt_name', civitaiVersionId: 12345 }],
              customNodes: ['FancyCustomNode']
            }
          },
          prompt: FIXTURE_PROMPT,
          workflow: FIXTURE_WORKFLOW
        }
      })
    }
    if (req.method() === 'GET' && url.pathname.endsWith('/starred')) {
      return route.fulfill({ json: { starred: false } })
    }
    if (req.method() === 'GET' && url.pathname.endsWith('/thumbnail')) {
      return route.fulfill({ status: 404, json: { error: 'no thumbnail' } })
    }
    if (req.method() === 'GET') {
      return route.fulfill({
        json: { app: { id: REG_ID, slug: 'maker/cloud-app', name: 'Cloud App', stars: 12, runs: 340 } }
      })
    }
    return route.fulfill({ json: { ok: true } })
  })

  return { published, calls }
}

test('publish: bundle goes to the registry, local manifest records the slug', async ({
  panel,
  page
}) => {
  const { store } = await stubAppsBackend(page)
  const { published, calls } = await stubRegistry(page)
  store.set(APP_ID, {
    manifest: {
      id: APP_ID,
      name: 'Shareable',
      description: 'publish me',
      version: 1,
      hideWorkflow: false,
      appMode: { inputs: [{ nodeId: 6, widget: 'text', label: 'Prompt', kind: 'text' }], outputs: [], importedFromFrontend: false },
      deps: { models: [], customNodes: [] },
      published: null
    },
    workflow: FIXTURE_WORKFLOW,
    prompt: FIXTURE_PROMPT
  })
  await panel.goto()
  await panel.openSidebar()
  await panel.root.getByRole('button', { name: 'Apps', exact: true }).click()
  const modal = page.locator('.cmcp-apps-modal')
  await modal.locator('.cmcp-app-card', { hasText: 'Shareable' }).click()
  await modal.getByRole('button', { name: /Publish/ }).click()

  // The window.prompt for the creator name is now a themed prompt modal
  // (cmcp-modal.js): type the name and submit.
  const creatorField = page.locator('.cmcp-mdl input')
  await expect(creatorField).toBeVisible()
  await creatorField.fill('tester')
  await page.locator('.cmcp-mdl-ok').click()

  // The registry got the app; the local manifest records published{slug}.
  await expect(modal.getByRole('button', { name: /Update published/ })).toBeVisible()
  const post = calls.find((c) => c.method === 'POST' && c.url === '/v1/apps')
  expect(post).toBeTruthy()
  const payload = post!.body as { app: { id: string; name: string; hide_workflow: boolean }; workflow?: unknown; creator_key: string }
  expect(payload.app.id).toBe(APP_ID)
  expect(payload.app.hide_workflow).toBe(false)
  expect(payload.workflow).toBeTruthy()
  expect(payload.creator_key).toMatch(/^[0-9a-f-]{36,64}$/)
  expect(published.has(APP_ID)).toBe(true)
  expect(store.get(APP_ID)!.manifest.published).toMatchObject({ slug: 'tester/shareable' })
})

test('explore: registry app opens straight into inputs — star icon, requirements, no install gate', async ({
  panel,
  page,
  mockBridge
}) => {
  const { store } = await stubAppsBackend(page)
  await stubRegistry(page)
  // Deps-state lookups: the pinned model is MISSING locally (fake model list;
  // object_info passes through to the real server — FancyCustomNode can't be
  // in it) — both rows must show as actionable, not a gate.
  await page.route(/\/models\/checkpoints/, (route) => route.fulfill({ json: ['sdxl.safetensors'] }))
  // The download action goes through the bridge's whitelisted tool; model
  // install-state checks go through the SAME channel (list_local_models).
  const downloads: Record<string, unknown>[] = []
  mockBridge.onFrame((frame) => {
    if (frame.type !== 'call_tool') return
    if (frame.tool === 'list_local_models') {
      mockBridge.send({
        type: 'tool_result',
        cid: frame.cid,
        ok: true,
        result: [{ type: 'text', text: JSON.stringify({ checkpoints: ['sdxl.safetensors'] }) }]
      })
      return
    }
    if (frame.tool === 'download_civitai_model') {
      downloads.push(frame.args as Record<string, unknown>)
      mockBridge.send({
        type: 'tool_result',
        cid: frame.cid,
        ok: true,
        result: [{ type: 'text', text: 'downloaded flux.safetensors' }]
      })
    }
  })

  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await panel.root.getByRole('button', { name: 'Apps', exact: true }).click()
  const modal = page.locator('.cmcp-apps-modal')

  await modal.getByRole('button', { name: 'Explore', exact: true }).click()
  const card = modal.locator('.cmcp-app-card', { hasText: 'Cloud App' })
  await expect(card).toBeVisible()
  await card.click()

  // NO Install button anywhere — the app silently installed on open and the
  // LOCAL detail (inputs!) shows right away.
  await expect(modal.getByRole('button', { name: '▶ Run' })).toBeVisible()
  await expect(modal.getByRole('button', { name: /Install/ })).toHaveCount(0)
  await expect(modal.locator('h3')).toHaveText('Cloud App')
  // The prompt input is there immediately.
  await expect(modal.locator('.cmcp-apps-field', { hasText: 'Prompt' }).locator('textarea')).toHaveValue('hello')

  // Star icon sits next to the title (not an action-row button); it stays
  // disabled until the real starred state arrives, then toggles.
  const starBtn = modal.locator('.cmcp-apps-starbtn')
  await expect(starBtn).toBeVisible()
  await expect(starBtn).toBeEnabled()
  await expect(starBtn).toHaveText('☆')
  await starBtn.click()
  await expect(starBtn).toHaveText('★')
  await expect(modal.locator('.cmcp-apps-starcount')).toHaveText('13')

  // Requirements side panel: pinned model shows ⬇ (missing locally), custom
  // node shows missing. Clicking ⬇ downloads via the bridge and flips to ✓.
  const reqs = modal.locator('.cmcp-apps-reqs')
  await expect(reqs).toBeVisible()
  await expect(reqs).toContainText('flux.safetensors')
  await expect(reqs).toContainText('FancyCustomNode')
  await expect(reqs.locator('.cmcp-apps-req-miss', { hasText: 'missing' })).toBeVisible()
  await reqs.locator('.cmcp-apps-req-dl').click()
  await expect(reqs.locator('.cmcp-apps-req-ok').first()).toBeVisible()
  expect(downloads).toHaveLength(1)
  expect(downloads[0]).toMatchObject({ model_version_id: 12345, target_subfolder: 'checkpoints' })

  // The silent install recorded registry provenance locally.
  expect(store.has(REG_ID)).toBe(true)
  const installed = store.get(REG_ID)!
  expect(installed.manifest.source).toMatchObject({ type: 'registry', registryId: REG_ID })
  expect(installed.manifest.published).toMatchObject({ slug: 'maker/cloud-app' })
})
