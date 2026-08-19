/**
 * #702 — an open that proves the binding but not the CONTENT must not strand the caller.
 *
 * `workflow_open` on the already-active tab legitimately answers CONTENT_UNVERIFIED: the
 * binding is proven (instance, marker and identity all match) and only the content
 * cannot be called byte-identical. That outcome THROWS, so it never reaches the line
 * that publishes `workflow_uuid` — and the caller's command fence keeps whatever it had.
 *
 * The disclosure then closed by recommending `panel_graph_outline`, which is exactly the
 * call about to be refused as a `workflow instance mismatch`. Two reporters followed that
 * advice into the refusal and concluded only a full `panel_reload` could recover.
 *
 * Measured here before the fix, in this order:
 *     workflow_open (already active) -> ok:false, CONTENT_UNVERIFIED, no workflow_uuid
 *     workflow_list                  -> ok:true, republishes the SAME active uuid
 *     graph_outline stamped with it  -> ok:true
 *
 * So the recovery already existed and the reply simply never named it. This asserts both
 * halves: the disclosure names it, and it actually works.
 */
import { test, expect } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

test('a content-unverified open names the fence recovery, and it works', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await claimFreshCanvas(page, mockBridge)

  await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const LG = w.LiteGraph || w.comfyAPI?.litegraph?.LiteGraph
    const node = LG.createNode('EmptyLatentImage')
    ;(app?.canvas?.graph ?? app?.graph).add(node)
    // A NON-DEFAULT value, so the aborted restore below has something to fail to apply.
    // With the node left at its construction defaults the payload and the post-load canvas
    // are byte-identical even when configure throws, and the open is PROVEN — correctly,
    // because nothing was lost. The content verdict this spec guards needs a real loss.
    const widget = (node.widgets || []).find((x: any) => x.name === 'width')
    if (widget) widget.value = 1337
  })
  await settleCanvas(page)

  const listed = await mockBridge.command('workflow_list', {})
  const target =
    listed.result?.active?.routing_key || listed.result?.active?.key || listed.result?.active?.path
  expect(target, 'an active workflow must be resolvable').toBeTruthy()

  // panel#1283 — ARRANGE THE REAL CONTENT_UNVERIFIED CASE, rather than relying on a
  // benign repaint difference.
  //
  // This spec used to reach CONTENT_UNVERIFIED by simply reopening the already-active
  // tab: the repaint was not byte-identical and the panel had no way to say why. It has
  // one now — it watches the restore — so a benign normalization is reported APPLIED with
  // the fence published, which is the whole of panel#1283/#1285/#1307/#1330 and
  // comfyui-mcp#1705.
  //
  // The verdict this spec guards is unchanged, and it is the case #702 was always about:
  // a load that ABORTS part-way. `LGraph.configure` runs its node pass with no try/catch,
  // so one node's `configure` throwing is exactly that shape — the panel records it,
  // refuses the content, and must still name the fence-exempt recovery. Making a node
  // throw is therefore a STRONGER arrangement than the old one, not a weaker one: it is
  // the failure the disclosure exists for.
  await page.evaluate(() => {
    const w = window as any
    const LG = w.LiteGraph || w.comfyAPI?.litegraph?.LiteGraph
    const proto = LG?.LGraphNode?.prototype
    const original = proto.configure
    w.__cmcpRestoreConfigure = () => {
      proto.configure = original
      delete w.__cmcpRestoreConfigure
    }
    proto.configure = function (info: any) {
      if (info?.type === 'EmptyLatentImage') throw new Error('pack widgets not built yet')
      return original.call(this, info)
    }
  })

  // Reopening the ALREADY-ACTIVE workflow, with one node's restore throwing, is the
  // CONTENT_UNVERIFIED path.
  const reopened = await mockBridge.command('workflow_open', { path: target })
  await page.evaluate(() => (window as any).__cmcpRestoreConfigure?.())
  const text = JSON.stringify(reopened)
  // Precondition: this must be the outcome the issue is about, not some other failure.
  // panel#1283 — an ABORTED restore gets its own headline (the "and" form), because both
  // of the older ones were written for a load that completed and are false here: one says
  // there is no missing work to redo, the other that the panel cannot tell normalization
  // from a partial load. This is the more specific sentence of the two, not a looser match.
  expect(text, 'the reply must be the post-repaint content verdict').toContain(
    'workflow_open RAN and the canvas IS bound to'
  )
  expect(reopened.ok, 'content-unverified is ok:false by design').toBe(false)

  // panel#1283 — and it must name WHAT aborted, so the reader is not left to guess
  // between a normalization and a node that never got its values.
  expect(text, 'an aborted restore must be named as such').toContain('DID NOT RUN TO COMPLETION')
  expect(text, 'and the node that threw must be named').toContain('EmptyLatentImage')

  // It must SAY the fence was not refreshed, and name the call that refreshes it.
  // Without this the reply recommends the graph read that is about to be refused.
  expect(text, 'the reply must disclose that no fence refresh rode with it').toContain(
    'carries NO fence refresh'
  )
  expect(text, 'the reply must name the fence-exempt recovery probe').toContain(
    'panel_list_workflows'
  )

  // And the named recovery must actually work — a remedy that does not is worse than none.
  const after = await mockBridge.command('workflow_list', {})
  expect(after.ok, 'workflow_list must stay usable — it is the fence-exempt probe').toBe(true)
  const stamp = after.result?.active?.workflow_uuid
  expect(stamp, 'workflow_list must republish the active identity').toBeTruthy()

  const outline = await mockBridge.command('graph_outline', { workflow_uuid: stamp })
  expect(
    outline.ok,
    'a graph read stamped from the recovery probe must succeed — this is the whole loop'
  ).toBe(true)
})
