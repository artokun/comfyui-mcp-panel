/**
 * #1634 — the agent kept handing back a CUT-OFF positive prompt.
 *
 * The filed hypothesis was `graph_outline`'s ladder shedding widget values on an
 * over-budget graph. Measured, that is not it: it reproduces on a graph of a handful of
 * nodes, where no rung degrades and nothing is near a budget. The cause is that the
 * compact projection's fixed 60-char value clip — a SURVEY cap, sized so a 200-node
 * listing of unidentified nodes stays small — was also applied when the caller named the
 * node explicitly by `ids`. That is the opposite case: the node is already identified, so
 * the clip only starves the value that was asked for. The shortfall is silent, because a
 * clipped prompt ends in an ellipsis a real prompt could plausibly contain.
 *
 * This drives the REAL executor against a REAL canvas, because the fix's call site
 * (`clipCompactValue(v, compactValueCap)` in comfyui-mcp-panel.js) is invisible to the
 * helper-level unit tests in browser_tests/unit/graph-read.test.mjs — those would stay
 * green with the wiring deleted.
 */
import { test, expect } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

/** 300 chars — longer than the 60-char survey clip, far under every budget. */
const PROMPT =
  'masterpiece, best quality, ultra detailed, a lone astronaut standing on a windswept ' +
  'red dune at golden hour, visor reflecting twin suns, volumetric god rays, fine sand ' +
  'particles drifting, cinematic composition, 85mm lens, shallow depth of field, ' +
  'photorealistic, 8k, sharp focus, dramatic rim lighting'

async function makePromptNode(page: any) {
  return await page.evaluate((text: string) => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const LG = w.LiteGraph || w.comfyAPI?.litegraph?.LiteGraph
    const n = LG.createNode('CLIPTextEncode')
    ;(app?.canvas?.graph ?? app?.graph).add(n)
    n.title = 'Positive Prompt'
    const wdg = (n.widgets || []).find((x: any) => x.name === 'text') || (n.widgets || [])[0]
    if (wdg) wdg.value = text
    return { id: String(n.id), value: String(wdg?.value ?? '') }
  }, PROMPT)
}

test('reading ONE node by id returns its full prompt, without fields:detail', async ({
  page,
  panel,
  mockBridge,
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await claimFreshCanvas(page, mockBridge)

  const made = await makePromptNode(page)
  expect(made.value, 'precondition: the widget really holds the whole prompt').toBe(PROMPT)
  expect(PROMPT.length).toBeGreaterThan(60)
  await settleCanvas(page)

  // The pinpoint read, exactly as an agent issues it — `ids`, no `fields`.
  const res = await mockBridge.command('graph_query', { ids: [made.id] })
  expect(res.ok).toBe(true)
  const text = String(res.result?.text ?? '')

  // THE BUG: this returned the prompt cut at 60 chars.
  expect(text, 'the node asked for by id must carry its whole value').toContain(PROMPT)
  // …and with nothing clipped there is nothing to report.
  expect(text, 'no clip note when nothing was clipped').not.toContain('widget value(s) clipped')
  // Still a compact one-line row, not the detail JSON — the shape is unchanged.
  expect(text, 'compact shape preserved').toMatch(new RegExp(`#${made.id}\\s+CLIPTextEncode`))
})

test('a SURVEY read still clips at 60 and names the lever that helps', async ({
  page,
  panel,
  mockBridge,
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await claimFreshCanvas(page, mockBridge)

  await makePromptNode(page)
  await settleCanvas(page)

  // No `ids` — the caller has NOT identified the node, so the survey cap is correct and
  // must survive the fix. This is the assertion that stops the pinpoint cap leaking into
  // the survey path and un-bounding a 200-node listing.
  const res = await mockBridge.command('graph_query', { types: ['CLIPTextEncode'] })
  expect(res.ok).toBe(true)
  const text = String(res.result?.text ?? '')

  expect(text, 'a survey must NOT carry the whole value').not.toContain(PROMPT)
  expect(text).toContain('clipped to 60 chars by `fields`:"compact"')
  expect(text, 'and it points at a projection that genuinely carries more').toContain(
    'read fuller values with `fields`:"detail"',
  )
})
