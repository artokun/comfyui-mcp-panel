/**
 * mcp#2321: panel_promote_widget failed on a NESTED subgraph (root → 142 → 133).
 *
 * The parent lookup scanned only `rootGraph._nodes` for a node whose `.subgraph`
 * is the open graph. One level down that works; two levels down the owning
 * SubgraphNode does not live at root — it lives inside the outer subgraph — so
 * the scan came back empty and the command threw
 * "Could not locate the parent subgraph node for the open subgraph."
 *
 * The fix (panel #1828 / 717ae98) walks the whole graph hierarchy instead.
 *
 * These two cases are the mutation pair: revert the walk to the old
 * `rootGraph._nodes` filter and the NESTED case must fail with that exact
 * message while the SINGLE-LEVEL case keeps passing — the single-level case is
 * the control that proves the nested failure is about depth, not about the
 * harness.
 *
 * PREREQUISITE: a real ComfyUI at http://localhost:8188 with this pack linked
 * into custom_nodes and CORS enabled (see playwright.config.ts).
 */
import { test, expect } from './fixtures/panelTest'
import type { MockBridge } from './fixtures/MockBridge'
import { routeWorktreeSource } from './fixtures/worktreeSource'

interface CmdReply {
  rid: string
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

async function command(
  bridge: MockBridge,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 20_000
): Promise<Record<string, unknown>> {
  const reply = (await bridge.command(cmd, args, timeoutMs)) as unknown as CmdReply
  if (!reply.ok) throw new Error(reply.error ?? `command "${cmd}" failed`)
  return reply.result ?? {}
}

/** graph_add_node returns { added: summarizeNode(node) }. */
async function addNode(bridge: MockBridge, classType: string): Promise<number> {
  const res = await command(bridge, 'graph_add_node', { class_type: classType })
  const added = res.added as { id?: number | string } | undefined
  expect(added?.id, `graph_add_node(${classType}) returned no id`).toBeDefined()
  return Number(added!.id)
}

/**
 * graph_create_subgraph takes `node_ids` (an ARRAY) and returns
 * { subgraph: { node_id } } — the id of the NEW SubgraphNode that replaced the
 * selection, which is NOT the id of the node that went in.
 */
async function createSubgraph(bridge: MockBridge, nodeIds: number[]): Promise<number> {
  const res = await command(bridge, 'graph_create_subgraph', { node_ids: nodeIds })
  const sub = res.subgraph as { node_id?: number | string } | undefined
  expect(sub?.node_id, 'graph_create_subgraph returned no subgraph node_id').toBeDefined()
  return Number(sub!.node_id)
}

/**
 * Ids cross the bridge as JSON and come back as strings inside a subgraph
 * scope, so compare numerically rather than asserting a wire type this test
 * does not care about.
 */
function ids(value: unknown): number[] {
  return (Array.isArray(value) ? value : [value]).map(Number)
}

// Serve THIS checkout's web/js
test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

async function openPanel(panel: { goto: () => Promise<unknown>; setBridgeUrl: (u: string) => Promise<unknown>; openSidebar: () => Promise<unknown>; connect: () => Promise<unknown> }, mockBridge: MockBridge) {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await command(mockBridge, 'graph_clear')
}

test.describe('panel_promote_widget on nested subgraphs (mcp#2321)', () => {
  test('promotes a widget two levels deep (root → outer → inner)', async ({
    panel,
    mockBridge
  }) => {
    await openPanel(panel, mockBridge)

    // root → outer  (the "node 142" of the report)
    const outerSeed = await addNode(mockBridge, 'CheckpointLoaderSimple')
    const outerSubgraphNodeId = await createSubgraph(mockBridge, [outerSeed])
    await command(mockBridge, 'graph_enter_subgraph', { node_id: outerSubgraphNodeId })

    // outer → inner  (the "node 133" of the report). This SubgraphNode lives
    // INSIDE the outer subgraph, so it is absent from rootGraph._nodes — that
    // absence is the whole bug.
    const innerSeed = await addNode(mockBridge, 'CheckpointLoaderSimple')
    const innerSubgraphNodeId = await createSubgraph(mockBridge, [innerSeed])
    await command(mockBridge, 'graph_enter_subgraph', { node_id: innerSubgraphNodeId })

    // A node two levels down, whose widget we promote onto its immediate parent.
    const deepNodeId = await addNode(mockBridge, 'CheckpointLoaderSimple')

    const promoteRes = await command(mockBridge, 'graph_promote_widget', {
      node_id: deepNodeId,
      widget: 'ckpt_name'
    })

    expect(promoteRes.promoted).toBe('ckpt_name')
    expect(ids(promoteRes.from_node)).toEqual([deepNodeId])
    // The immediate parent is the INNER SubgraphNode, which the old root-only
    // scan could never see.
    expect(ids(promoteRes.on_subgraph_nodes)).toContain(innerSubgraphNodeId)
  })

  test('still promotes one level deep (root → outer) — control', async ({
    panel,
    mockBridge
  }) => {
    await openPanel(panel, mockBridge)

    const seed = await addNode(mockBridge, 'CheckpointLoaderSimple')
    const subgraphNodeId = await createSubgraph(mockBridge, [seed])
    await command(mockBridge, 'graph_enter_subgraph', { node_id: subgraphNodeId })

    const nodeId = await addNode(mockBridge, 'CheckpointLoaderSimple')

    const promoteRes = await command(mockBridge, 'graph_promote_widget', {
      node_id: nodeId,
      widget: 'ckpt_name'
    })

    expect(promoteRes.promoted).toBe('ckpt_name')
    expect(ids(promoteRes.from_node)).toEqual([nodeId])
    expect(ids(promoteRes.on_subgraph_nodes)).toContain(subgraphNodeId)
  })
})
