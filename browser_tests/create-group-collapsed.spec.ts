/**
 * Tier 1 — mcp#1877: panel_create_group must not build a box around a node and
 * then report that node as missing (agent-free).
 *
 * The unit tests pin the geometry and the call site against fixtures. This spec
 * is the part they cannot reach: the box is a rectangle LiteGraph draws, and
 * membership is LiteGraph's own containsCentre rule over its own cached rects.
 * Here the panel's real dispatcher runs `graph_create_group` against the LIVE
 * graph in a real browser, and the assertion is taken from the ENGINE
 * (LGraphGroup._nodes after its own recomputeInsideNodes), not from the panel's
 * report of itself.
 *
 * The reported shape: a COLLAPSED node whose `size` carries a zero height —
 * accepted, serialized and re-configured unchanged by the frontend. The box
 * builder read that 0 literally while the cached-rect writer replaced it with
 * the default 100, so the rect's centre landed just below the box that had been
 * built around it and the tool returned an EMPTY group with bounds that visibly
 * covered the requested node.
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

// Serve THIS checkout's web/js. Without it the spec exercises whatever pack the
// dev ComfyUI has installed — which is how it reproduced the shipped bug while
// this branch's fix sat unloaded a directory away.
test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

test.describe('graph_create_group with a collapsed node (mcp#1877)', () => {
  test('the requested node is a member of the box built around it', async ({
    panel,
    mockBridge
  }) => {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    await command(mockBridge, 'graph_clear')

    const res0 = await command(mockBridge, 'graph_add_node', { class_type: 'VAEDecode' })
    const added = res0.added as { id: number } | undefined
    expect(added?.id).toBeDefined()
    const nodeId = Number(added!.id)

    // Put the node in the reported state, then PROVE the frontend accepted it.
    // Whole-array assignment, not element writes: `size` and `pos` are
    // layout-store-backed on this frontend and an element poke can be dropped by
    // the next render, which would leave this spec silently testing an ordinary
    // expanded node — green, and blind to the bug it exists for.
    const state = await panel.page.evaluate(
      ({ id }) => {
        const graph = (window as unknown as { app: { graph: any } }).app.graph
        const n = graph.getNodeById(id)
        n.pos = [9750, 5410]
        n.size = [225, 0]
        if (!n.flags?.collapsed) n.collapse?.()
        if (!n.flags?.collapsed) n.flags = { ...(n.flags ?? {}), collapsed: true }
        return {
          pos: [n.pos?.[0], n.pos?.[1]],
          size: [n.size?.[0], n.size?.[1]],
          collapsed: !!n.flags?.collapsed
        }
      },
      { id: nodeId }
    )
    expect(state.pos).toEqual([9750, 5410])
    expect(state.size).toEqual([225, 0])
    expect(state.collapsed).toBe(true)

    const res = await command(mockBridge, 'graph_create_group', {
      title: 'Decode',
      node_ids: [nodeId]
    })
    const group = res.group as Record<string, unknown>

    // The panel's own answer. Ids are compared as STRINGS: this frontend hands
    // out string node ids, and the whole point of classifyRequestedMembership's
    // normalisation is that a requested 72 and a member "72" are the same node.
    expect(group.node_count).toBe(1)
    expect((group.node_ids as unknown[]).map(String)).toEqual([String(nodeId)])
    expect(group.missing_node_ids).toBeUndefined()
    expect(group.warning).toBeUndefined()


    // The ENGINE's answer, which is what the user sees on the canvas. Before the
    // fix this array was empty while `bounding` covered [9750, 5410].
    const engine = await panel.page.evaluate(
      ({ id, nodeId }) => {
        const graph = (window as unknown as { app: { graph: any } }).app.graph
        const g = (graph._groups ?? []).find((x: any) => x.id === id) ?? (graph._groups ?? []).at(-1)
        g?.recomputeInsideNodes?.()
        const n = graph.getNodeById(nodeId)
        return {
          memberIds: (g?._nodes ?? []).map((x: any) => String(x.id)),
          bounding: g?._bounding ? Array.from(g._bounding as number[]).map(Math.round) : null,
          // Reported so a drifted precondition is diagnosable rather than a mystery.
          nodeSize: [n?.size?.[0], n?.size?.[1]],
          nodePos: [n?.pos?.[0], n?.pos?.[1]]
        }
      },
      { id: Number(group.id), nodeId }
    )


    expect(engine.memberIds, JSON.stringify(engine)).toContain(String(nodeId))
    const [gx, gy, gw, gh] = engine.bounding as number[]
    expect(9750 >= gx && 9750 < gx + gw).toBe(true)
    expect(5410 >= gy && 5410 < gy + gh).toBe(true)
  })
})
