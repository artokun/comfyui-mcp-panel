/**
 * #342 — the outline must not fabricate connectivity out of a stale `target_slot`.
 *
 * A link record's `target_slot` is captured at connect time. When the target node's
 * inputs are COMPACTED afterwards — a `COMFY_DYNAMICCOMBO_V3` rebuilding its slots on a
 * selection change, a removed dynamic `ref_video_N` input shifting the tail — the index
 * survives the transformation that invalidated it. `panel_graph_outline` rendered
 * `tgt.inputs[l.target_slot].name`, so it reported the link against whatever slot now
 * OCCUPIES that index. The reporter's outline said
 * `VAEDecode → easy saveVideo.output_mode.save_metadata` (a BOOLEAN) over a graph whose
 * IMAGE link no longer existed, while `panel_query_graph` — which reads the live
 * `inputs[].link` backlink — correctly showed it gone.
 *
 * This spec builds that state in a REAL graph in a REAL ComfyUI: connect two nodes, then
 * remove the target's input slot WITHOUT disconnecting, which is exactly what the
 * dynamic-combo rebuild leaves behind (link record alive in `graph.links` and in the
 * origin's `outputs[].links`; no input backlinks it any more). The unit tests pin the
 * render block; this pins that a live graph, a live outline handler and a live frontend
 * still agree.
 *
 * Measured here against the pre-fix panel: the outline row read `→ <id>.vae`.
 */
import { test, expect } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

test('an outgoing link whose target slot was removed renders NOTHING in the outline', async ({
  page,
  panel,
  mockBridge,
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await claimFreshCanvas(page, mockBridge)

  const made = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const LG = w.LiteGraph || w.comfyAPI?.litegraph?.LiteGraph
    const graph = app?.canvas?.graph ?? app?.graph
    const latent = LG.createNode('EmptyLatentImage')
    const decode = LG.createNode('VAEDecode')
    graph.add(latent)
    graph.add(decode)
    // VAEDecode inputs are [samples (LATENT), vae (VAE)]. Wire the LATENT into slot 0.
    latent.connect(0, decode, 0)
    const linkId = decode.inputs?.[0]?.link ?? null
    const before = {
      slot0: decode.inputs?.[0]?.name ?? null,
      linkId,
      // The origin still lists the link on its output — the outline walks THIS.
      onOutput: (latent.outputs?.[0]?.links ?? []).includes(linkId),
    }
    // The compaction: the slot the link landed on is REMOVED and the tail shifts up,
    // with no disconnect. `vae` now sits at index 0 — the index the link still records.
    decode.inputs.splice(0, 1)
    const after = {
      slot0: decode.inputs?.[0]?.name ?? null,
      backlinked: (decode.inputs ?? []).some((i: any) => i?.link === linkId),
      recordedTargetSlot: graph.links?.[linkId]?.target_slot ?? null,
      stillOnOutput: (latent.outputs?.[0]?.links ?? []).includes(linkId),
    }
    return { decodeId: String(decode.id), latentId: String(latent.id), before, after }
  })

  // Preconditions — if any of these drift, the spec is no longer reproducing #342 and
  // must be repaired rather than relaxed.
  expect(made.before.slot0, 'precondition: the LATENT lands on `samples`').toBe('samples')
  expect(made.before.linkId, 'precondition: the connect produced a link').not.toBeNull()
  expect(made.before.onOutput, 'precondition: the origin output lists the link').toBe(true)
  expect(made.after.slot0, 'precondition: compaction shifted `vae` into the freed index').toBe('vae')
  expect(made.after.backlinked, 'precondition: no input backlinks the link any more').toBe(false)
  expect(
    made.after.recordedTargetSlot,
    'precondition: the link record still points at the freed index',
  ).toBe(0)
  expect(
    made.after.stillOnOutput,
    'precondition: the orphaned record survives on the origin output — this is what the outline walks',
  ).toBe(true)

  await settleCanvas(page)

  const outline = await mockBridge.command('graph_outline', {})
  expect(outline.ok).toBe(true)
  const text = String(outline.result?.outline ?? '')

  // The bug, named exactly: the slot that took the freed index must not be reported as
  // the link's target.
  expect(text, 'the outline must not attribute the dropped link to `vae`').not.toContain(
    `${made.decodeId}.vae`,
  )
  // …and no row may claim ANY outgoing target for the origin node, because the graph has
  // none that executes.
  const originRow = text
    .split('\n')
    .findIndex((line) => line.trimStart().startsWith(`${made.latentId}  EmptyLatentImage`))
  expect(originRow, 'the origin node must still be listed').toBeGreaterThanOrEqual(0)
  const rowsAfterOrigin = text.split('\n').slice(originRow + 1, originRow + 3)
  expect(
    rowsAfterOrigin.filter((line) => line.trimStart().startsWith('→')),
    'an orphaned link must render no outgoing row at all',
  ).toEqual([])

  // The target node itself is untouched — the fix removes a false claim, it does not
  // hide the graph.
  expect(text, 'the target node is still in the outline').toContain(`${made.decodeId}  VAEDecode`)
})
