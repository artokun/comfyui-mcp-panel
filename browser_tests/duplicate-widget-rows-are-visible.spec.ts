/**
 * #1402 — a node whose widgets share ONE name must not read as a node with one row.
 *
 * rgthree's Fast Groups Bypasser/Muter names EVERY group-toggle row
 * `RGTHREE_TOGGLE_AND_NAV`. summarizeNode keys widgets by name, so a node rendering two
 * toggle rows returned a single, healthy-looking entry:
 *
 *     "widgets": {"RGTHREE_TOGGLE_AND_NAV": {"toggled": false}},
 *     "widget_labels": {"RGTHREE_TOGGLE_AND_NAV": "Enable MODEL REF"}
 *
 * On the strength of that read the agent told the user the node's data was correct and
 * only the canvas draw was stale — the opposite of the truth — and shipped a fix that
 * could not work. The unit tests pin the derivation; this pins that the payload an agent
 * actually receives, from a real panel in a real browser, carries the second row. The
 * report was filed with "parses cleanly, not verified at runtime" — this is that
 * verification.
 *
 * rgthree is not installed in this harness, so the shape is reproduced directly: two
 * widgets, one name, different labels and values. That is precisely what the bypasser
 * hands the panel.
 */
import { test, expect } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

const DUP = 'RGTHREE_TOGGLE_AND_NAV'

/** Add a node carrying two same-named toggle rows, as the bypasser does. */
async function makeDuplicateRowNode(page: import('@playwright/test').Page) {
  return await page.evaluate((dupName) => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const LG = w.LiteGraph || w.comfyAPI?.litegraph?.LiteGraph
    const n = LG.createNode('EmptyLatentImage')
    ;(app?.canvas?.graph ?? app?.graph).add(n)
    // Clone a real widget so the row keeps whatever type/options the canvas needs to
    // draw it, then give both copies the SAME name — the rgthree shape.
    const proto = (n.widgets || [])[0]
    const row = (label: string, toggled: boolean) => ({
      ...proto,
      name: dupName,
      label,
      value: { toggled },
    })
    n.widgets.push(row('Enable MODEL FL2', true))
    n.widgets.push(row('Enable MODEL REF', false))
    return { id: String(n.id), rows: n.widgets.filter((x: any) => x?.name === dupName).length }
  }, DUP)
}

test('the detail read reports BOTH rows that share one widget name', async ({
  page,
  panel,
  mockBridge,
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await claimFreshCanvas(page, mockBridge)

  const made = await makeDuplicateRowNode(page)
  expect(made.rows, 'precondition: the node really carries two same-named rows').toBe(2)
  await settleCanvas(page)

  const res = await mockBridge.command('graph_query', { ids: [made.id], fields: 'detail' })
  expect(res.ok).toBe(true)
  const text = String(res.result?.text ?? '')
  const node = JSON.parse(text.trim().split('\n').find((l) => l.includes(DUP)) ?? '{}')

  // THE BUG: this was the entire report for a two-row node.
  expect(node.widgets?.[DUP], 'the name-keyed map still holds the last row (back-compat)').toEqual({
    toggled: false,
  })

  // The fix: the dropped row is present, with its own label and its own value.
  const rows = node.duplicate_widgets?.[DUP]
  expect(rows, 'duplicate_widgets must name the repeated widget').toBeDefined()
  expect(rows).toHaveLength(2)
  expect(rows.map((r: any) => r.label)).toEqual(['Enable MODEL FL2', 'Enable MODEL REF'])
  expect(rows.map((r: any) => r.value?.toggled)).toEqual([true, false])
  // The precise wrong answer the reporter gave: the read said the node was all-off while
  // a row sat toggled ON. Both states are now visible in the payload.
  expect(
    rows.some((r: any) => r.value?.toggled === true),
    'a row that is ON must be visible even when the collapsed map says off',
  ).toBe(true)
  // Canvas order, so the LAST occurrence is the one `widgets` ended up holding.
  expect(rows.at(-1).value).toEqual(node.widgets[DUP])
})

test('a node with unique widget names carries no duplicate report at all', async ({
  page,
  panel,
  mockBridge,
}) => {
  // The other half of the fix, and the one that keeps it free: an ordinary node's detail
  // must be exactly what it was before this field existed. Without this, the key would
  // land on every read and cost every caller tokens to learn nothing.
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
    return { id: String(n.id) }
  })
  await settleCanvas(page)

  const res = await mockBridge.command('graph_query', { ids: [made.id], fields: 'detail' })
  expect(res.ok).toBe(true)
  const text = String(res.result?.text ?? '')
  expect(text, 'an ordinary node must not mention duplicates').not.toContain('duplicate_widgets')
})

test('the outline annotates each shared-name row with ITS OWN label', async ({
  page,
  panel,
  mockBridge,
}) => {
  // graph_outline renders one token per widget in the array, so it always showed both
  // rows — but it looked each row's label up BY NAME, which is last-wins. Both rows were
  // therefore annotated with the last row's label: the outline stated, of two different
  // group toggles, that they were the same one.
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await claimFreshCanvas(page, mockBridge)

  const made = await makeDuplicateRowNode(page)
  expect(made.rows).toBe(2)
  await settleCanvas(page)

  const outline = await mockBridge.command('graph_outline', {})
  expect(outline.ok).toBe(true)
  const text = String(outline.result?.outline ?? '')

  expect(text, 'the first row keeps its own label').toContain('[renamed "Enable MODEL FL2"]')
  expect(text, 'the second row keeps its own label').toContain('[renamed "Enable MODEL REF"]')
  // THE BUG: the last row's label was stamped on both, so FL2 never appeared and REF
  // appeared twice.
  expect(
    text.match(/\[renamed "Enable MODEL REF"\]/g)?.length ?? 0,
    'the last row\'s label must not be stamped onto the first',
  ).toBe(1)
})
