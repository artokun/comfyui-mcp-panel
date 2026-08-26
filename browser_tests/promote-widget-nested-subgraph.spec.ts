/**
 * mcp#2321: panel_promote_widget fails on nested subgraphs (root → 142 → 133).
 *
 * The parent lookup searches only the ROOT graph for the subgraph node, but
 * node 133 does not live at root — it lives inside node 142. The fix uses
 * findSubgraphOwner to walk the graph hierarchy, finding the immediate parent
 * regardless of nesting depth.
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
  timeoutMs = 15_000
): Promise<Record<string, unknown>> {
  const reply = (await bridge.command(cmd, args, timeoutMs)) as unknown as CmdReply
  if (!reply.ok) throw new Error(reply.error ?? `command "${cmd}" failed`)
  return reply.result ?? {}
}

// Serve THIS checkout's web/js
test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

test.describe('panel_promote_widget on nested subgraphs (mcp#2321)', () => {
  test('promotes a widget on a node inside a nested subgraph (root → outer → inner)', async ({
    panel,
    mockBridge
  }) => {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    await command(mockBridge, 'graph_clear')

    // Create outer subgraph (node 142 equivalent)
    const outerRes = await command(mockBridge, 'graph_add_node', { class_type: 'Reroute' })
    const outerNode = outerRes.added as { id: number } | undefined
    expect(outerNode?.id).toBeDefined()
    const outerNodeId = Number(outerNode!.id)

    // Create outer subgraph from this node
    const outerSubgraphRes = await command(mockBridge, 'graph_create_subgraph', {
      node_id: outerNodeId,
      title: 'Outer Subgraph'
    })
    expect(outerSubgraphRes.created).toBe(true)

    // Enter outer subgraph
    await command(mockBridge, 'graph_enter_subgraph', { node_id: outerNodeId })

    // Create inner node in outer subgraph
    const innerSubgraphNodeRes = await command(mockBridge, 'graph_add_node', {
      class_type: 'Reroute'
    })
    const innerSubgraphNode = innerSubgraphNodeRes.added as { id: number } | undefined
    expect(innerSubgraphNode?.id).toBeDefined()
    const innerSubgraphNodeId = Number(innerSubgraphNode!.id)

    // Create inner subgraph (node 133 equivalent)
    const innerRes = await command(mockBridge, 'graph_create_subgraph', {
      node_id: innerSubgraphNodeId,
      title: 'Inner Subgraph'
    })
    expect(innerRes.created).toBe(true)

    // Enter inner subgraph
    await command(mockBridge, 'graph_enter_subgraph', { node_id: innerSubgraphNodeId })

    // Add a node with a widget inside the inner subgraph
    const deepNodeRes = await command(mockBridge, 'graph_add_node', {
      class_type: 'CheckpointLoader',
      optional_inputs: false
    })
    const deepNode = deepNodeRes.added as { id: number } | undefined
    expect(deepNode?.id).toBeDefined()
    const deepNodeId = Number(deepNode!.id)

    // This should NOT throw "Could not locate the parent subgraph node for the open subgraph"
    // It should find the immediate parent (innerSubgraphNode) which lives inside outerNode
    const promoteRes = await command(mockBridge, 'graph_promote_widget', {
      node_id: deepNodeId,
      widget: 'ckpt_name'
    })

    // Verify promotion succeeded
    expect(promoteRes.promoted).toBe('ckpt_name')
    expect(promoteRes.from_node).toBe(deepNodeId)
    expect(promoteRes.on_subgraph_nodes).toContain(innerSubgraphNodeId)
  })

  test('still promotes widgets on single-level subgraphs (root → outer)', async ({
    panel,
    mockBridge
  }) => {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    await command(mockBridge, 'graph_clear')

    // Create outer subgraph
    const outerRes = await command(mockBridge, 'graph_add_node', { class_type: 'Reroute' })
    const outerNode = outerRes.added as { id: number } | undefined
    expect(outerNode?.id).toBeDefined()
    const outerNodeId = Number(outerNode!.id)

    // Create subgraph
    const subgraphRes = await command(mockBridge, 'graph_create_subgraph', {
      node_id: outerNodeId,
      title: 'Test Subgraph'
    })
    expect(subgraphRes.created).toBe(true)

    // Enter subgraph
    await command(mockBridge, 'graph_enter_subgraph', { node_id: outerNodeId })

    // Add a node with a widget
    const nodeRes = await command(mockBridge, 'graph_add_node', {
      class_type: 'CheckpointLoader',
      optional_inputs: false
    })
    const node = nodeRes.added as { id: number } | undefined
    expect(node?.id).toBeDefined()
    const nodeId = Number(node!.id)

    // Promote the widget — this should work as before
    const promoteRes = await command(mockBridge, 'graph_promote_widget', {
      node_id: nodeId,
      widget: 'ckpt_name'
    })

    // Verify promotion succeeded
    expect(promoteRes.promoted).toBe('ckpt_name')
    expect(promoteRes.from_node).toBe(nodeId)
    expect(promoteRes.on_subgraph_nodes).toContain(outerNodeId)
  })
})
