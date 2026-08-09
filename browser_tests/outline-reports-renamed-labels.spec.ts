/**
 * #636 part 2 — a rename must be visible in the reader an agent reaches for first.
 *
 * A user renamed a subgraph's promoted widgets. The canvas showed the new names; every
 * structured reader kept returning the underlying keys. The agent concluded the renames
 * "had not stuck" and told the user so, and only a screenshot settled it.
 *
 * `graph_query` was fixed for this in 0.11.42 (it emits `widget_labels` and a per-slot
 * `label`). `graph_outline` was NOT, and it is the cheapest, most-used overview — so the
 * misleading answer was still one call away. Measured against a live ComfyUI before the
 * fix: the outline rendered `width=512 height=512 batch_size=1` with the rename nowhere.
 *
 * The NAME stays first and unannotated, because it is what `panel_set_widget` addresses;
 * the label rides beside it in the same bracket idiom as `[after_gen=…]` and `[bypass]`.
 * Renamed widgets only, so an unrenamed graph's outline is byte-identical to before.
 */
import { test, expect } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

test('the outline reports a widget the user renamed', async ({ page, panel, mockBridge }) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await claimFreshCanvas(page, mockBridge)

  const made = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const LG = w.LiteGraph || w.comfyAPI?.litegraph?.LiteGraph
    const n = LG.createNode('EmptyLatentImage')
    ;(app?.canvas?.graph ?? app?.graph).add(n)
    // What a UI rename does: sets a DISPLAY label, leaving the addressable name alone.
    const wdg = (n.widgets || []).find((x: any) => x.name === 'width')
    if (wdg) wdg.label = 'Frame Width'
    return { id: String(n.id), renamed: wdg?.label ?? null }
  })
  expect(made.renamed, 'precondition: the widget must carry a display label').toBe('Frame Width')
  await settleCanvas(page)

  const outline = await mockBridge.command('graph_outline', {})
  expect(outline.ok).toBe(true)
  const text = String(outline.result?.outline ?? '')

  // The rename must be visible AT ALL — this is the whole bug.
  expect(text, 'the outline must show the name the user gave it').toContain('Frame Width')
  // …beside the addressable name, not instead of it. An agent that sees only "Frame
  // Width" cannot call panel_set_widget, which takes `width`.
  expect(text, 'the addressable name must survive').toMatch(/width=512 \[renamed "Frame Width"\]/)

  // And an UNRENAMED widget must stay exactly as it was — the annotation is per-widget,
  // so it can never inflate an ordinary graph's outline against max_chars.
  expect(text, 'unrenamed widgets are untouched').toContain('height=512 batch_size=1')
  expect(text.match(/\[renamed /g)?.length ?? 0).toBe(1)
})
