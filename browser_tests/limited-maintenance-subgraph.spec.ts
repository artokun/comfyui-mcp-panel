import { test, expect } from './fixtures/panelTest'
import { routeWorktreeSource } from './fixtures/worktreeSource'
import type { MockBridge } from './fixtures/MockBridge'

async function command(bridge: MockBridge, cmd: string, args: Record<string, unknown> = {}) {
  const reply = await bridge.command(cmd, args, 20000) as unknown as { ok: boolean; result: any; error?: string }
  if (!reply.ok) throw new Error(reply.error)
  return reply.result
}
test.beforeEach(async ({ context }) => { await routeWorktreeSource(context) })

test('conversion retry has live provenance and unpack follows reminted identities', async ({ panel, mockBridge, page }) => {
  await panel.goto(); await page.keyboard.press('Escape'); await panel.setBridgeUrl(mockBridge.url); await panel.openSidebar(); await panel.connect()
  await command(mockBridge, 'graph_clear')
  const add = async (type: string) => Number((await command(mockBridge, 'graph_add_node', { class_type: type })).added.id)
  const source = await add('EmptyLatentImage'), middle = await add('LatentUpscale'), target = await add('VAEDecode')
  await command(mockBridge, 'graph_connect', { from_node_id: source, from_output: 0, to_node_id: middle, to_input: 'samples' })
  await command(mockBridge, 'graph_connect', { from_node_id: middle, from_output: 0, to_node_id: target, to_input: 'samples' })
  const first = await command(mockBridge, 'graph_create_subgraph', { node_ids: [middle] })
  const retry = await command(mockBridge, 'graph_create_subgraph', { node_ids: [middle] })
  expect(retry.subgraph.node_id).toBe(first.subgraph.node_id)
  expect(retry.subgraph.recovered).toBe(true)
  // Reproduce a dynamic slot rebuild on the actual frontend's cloned node.
  await page.evaluate(async () => {
    const { app } = await import('/scripts/app.js' as string)
    const graph = app.graph, original = graph.unpackSubgraph
    graph.unpackSubgraph = function (...args: any[]) {
      const before = new Set(this._nodes)
      const result = original.apply(this, args)
      const child = this._nodes.find((n: any) => !before.has(n) && n.type === 'LatentUpscale')
      const samples = child.inputs.find((s: any) => s.name === 'samples')
      const link = samples.link
      samples.link = null
      child.inputs.unshift({ name: 'dynamic_wrong_slot', type: 'VIDEO', link })
      return result
    }
  })
  const unpacked = await command(mockBridge, 'graph_unpack_subgraph', { node_id: first.subgraph.node_id })
  expect(unpacked.unpacked.external_links_identity_ok).toBe(true)
  const state = await page.evaluate(async () => {
    const { app } = await import('/scripts/app.js' as string)
    const child = app.graph._nodes.find((n: any) => n.type === 'LatentUpscale')
    const slot = child.inputs.findIndex((s: any) => s.name === 'samples')
    const link = app.graph.links.get(child.inputs[slot].link)
    return { id: child.id, slot, targetSlot: link.target_slot, origin: link.origin_id,
      properties: child.properties, targetOrigin: app.graph.links.get(app.graph._nodes.find((n: any) => n.type === 'VAEDecode').inputs[0].link).origin_id }
  })
  expect(state.id).not.toBe(middle)
  expect(state.targetSlot).toBe(state.slot)
  expect(state.origin).toBe(source)
  expect(state.targetOrigin).toBe(state.id)
  expect(state.properties).not.toHaveProperty('__comfyui_mcp_unpack_identity')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => page.evaluate(async () => {
    const { app } = await import('/scripts/app.js' as string)
    const host = app.graph._nodes.find((n: any) => n.subgraph)
    return host ? { count: app.graph._nodes.length, markers: host.subgraph._nodes.some((n: any) => Object.hasOwn(n.properties ?? {}, '__comfyui_mcp_unpack_identity')) } : null
  })).toEqual({ count: 3, markers: false })
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(async () => page.evaluate(async () => {
    const { app } = await import('/scripts/app.js' as string)
    const child = app.graph._nodes.find((n: any) => n.type === 'LatentUpscale')
    if (!child) return false
    const i = child.inputs.findIndex((s: any) => s.name === 'samples')
    return app.graph.links.get(child.inputs[i].link)?.target_slot === i
  })).toBe(true)
})

test('unprovable unpack rolls back the complete workflow without duplicating conversion', async ({ panel, mockBridge, page }) => {
  await panel.goto(); await page.keyboard.press('Escape'); await panel.setBridgeUrl(mockBridge.url); await panel.openSidebar(); await panel.connect()
  await command(mockBridge, 'graph_clear')
  const source = Number((await command(mockBridge, 'graph_add_node', { class_type: 'EmptyLatentImage' })).added.id)
  const child = Number((await command(mockBridge, 'graph_add_node', { class_type: 'LatentUpscale' })).added.id)
  await command(mockBridge, 'graph_connect', { from_node_id: source, from_output: 0, to_node_id: child, to_input: 'samples' })
  const created = await command(mockBridge, 'graph_create_subgraph', { node_ids: [child] })
  await page.evaluate(async () => {
    const { app } = await import('/scripts/app.js' as string)
    const graph = app.graph, original = graph.unpackSubgraph
    graph.unpackSubgraph = function (...args: any[]) {
      const before = new Set(this._nodes)
      const result = original.apply(this, args)
      for (const node of this._nodes.filter((n: any) => !before.has(n))) delete node.properties.__comfyui_mcp_unpack_identity
      return result
    }
  })
  await expect(command(mockBridge, 'graph_unpack_subgraph', { node_id: created.subgraph.node_id })).rejects.toThrow(/refused[\s\S]*pre-unpack snapshot/)
  const result = await page.evaluate(async () => {
    const { app } = await import('/scripts/app.js' as string)
    const host = app.graph._nodes.find((n: any) => n.subgraph)
    return { nodes: app.graph._nodes.length, hosts: app.graph._nodes.filter((n: any) => n.subgraph).length,
      inputLink: host.inputs[0].link, markers: host.subgraph._nodes.some((n: any) => Object.hasOwn(n.properties ?? {}, '__comfyui_mcp_unpack_identity')) }
  })
  expect(result.nodes).toBe(2); expect(result.hosts).toBe(1); expect(result.inputLink).not.toBeNull(); expect(result.markers).toBe(false)
  // Rollback loads a new graph inventory; old provenance must never claim success.
  await expect(command(mockBridge, 'graph_create_subgraph', { node_ids: [child] })).rejects.toThrow(/NOT run|NOT retried/)
})
