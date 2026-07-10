/**
 * Tier 1 — graph_auto_layout end-to-end (agent-free).
 *
 * Drives the panel's command dispatcher directly through the MockBridge: the
 * bridge SENDS `{rid, cmd, ...}` frames (exactly what a real orchestrator would
 * emit for a tool call) and the panel executes them against the LIVE LiteGraph
 * and replies `{rid, ok, result}`. We build a small chain graph, then assert:
 *
 *   1. dry_run:true returns positions but graph_get_state shows UNCHANGED pos.
 *   2. Applying moves nodes to the returned `to` coordinates with monotone
 *      column-X ordering.
 *   3. A single Ctrl+Z restores the prior arrangement (one undo step, because
 *      every write is wrapped in one beforeChange/afterChange pair).
 *
 * PREREQUISITE: a real ComfyUI at http://localhost:8188 with this pack linked
 * into custom_nodes and CORS enabled (see playwright.config.ts). This suite does
 * NOT start ComfyUI for you.
 */
import { test, expect } from './fixtures/panelTest'
import type { MockBridge } from './fixtures/MockBridge'

interface CmdReply {
  rid: string
  ok: boolean
  result?: Record<string, unknown>
  error?: string
}

/**
 * Send a graph command through the bridge and resolve with its result. The panel
 * replies `{rid, ok, result|error}`; we match on rid via the MockBridge frame tap.
 */
function command(
  bridge: MockBridge,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 15_000
): Promise<Record<string, unknown>> {
  const rid = `t-${cmd}-${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`command "${cmd}" timed out`))
    }, timeoutMs)
    const off = bridge.onFrame((frame) => {
      const f = frame as unknown as CmdReply
      if (f.rid === rid && typeof f.ok === 'boolean') {
        clearTimeout(timer)
        off()
        if (f.ok) resolve(f.result ?? {})
        else reject(new Error(f.error ?? `command "${cmd}" failed`))
      }
    })
    bridge.send({ rid, cmd, ...args })
  })
}

/** Best-effort connect (ignores type-incompat refusals — layout is edge-tolerant). */
async function tryConnect(
  bridge: MockBridge,
  from: number,
  to: number
): Promise<void> {
  try {
    await command(bridge, 'graph_connect', {
      from_node_id: from,
      from_output: 0,
      to_node_id: to,
      to_input: 0
    })
  } catch {
    // incompatible slots — the chain still lays out by whatever edges landed
  }
}

test.describe('graph_auto_layout', () => {
  test('dry_run previews without moving; apply arranges; one undo restores', async ({
    panel,
    mockBridge
  }) => {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    // Fresh canvas.
    await command(mockBridge, 'graph_clear')

    // A short chain of core nodes. Types that ship with ComfyUI core.
    const ids: number[] = []
    for (const type of [
      'CheckpointLoaderSimple',
      'CLIPTextEncode',
      'KSampler',
      'VAEDecode'
    ]) {
      const res = await command(mockBridge, 'graph_add_node', { class_type: type })
      const added = res.added as { id: number } | undefined
      expect(added?.id).toBeDefined()
      ids.push(added!.id)
    }
    // Wire them into a chain (best-effort; layout tolerates missing edges).
    for (let i = 0; i < ids.length - 1; i++) {
      await tryConnect(mockBridge, ids[i], ids[i + 1])
    }

    // Snapshot original positions.
    const before = (await command(mockBridge, 'graph_get_state')) as {
      nodes: Array<{ id: number; pos: [number, number] }>
    }
    const posBefore = new Map(before.nodes.map((n) => [n.id, n.pos]))

    // 1) dry_run must NOT move anything.
    const dry = (await command(mockBridge, 'graph_auto_layout', {
      dry_run: true,
      mode: 'flow_horizontal'
    })) as {
      applied: boolean
      moved: Array<{ node_id: number; to: [number, number]; column: number }>
      columns: number
    }
    expect(dry.applied).toBe(false)
    expect(dry.moved.length).toBeGreaterThan(0)
    expect(dry.columns).toBeGreaterThanOrEqual(1)

    const afterDry = (await command(mockBridge, 'graph_get_state')) as {
      nodes: Array<{ id: number; pos: [number, number] }>
    }
    for (const n of afterDry.nodes) {
      expect(n.pos).toEqual(posBefore.get(n.id))
    }

    // 2) Apply: nodes land at the returned coordinates; X is monotone by column.
    const applied = (await command(mockBridge, 'graph_auto_layout', {
      mode: 'flow_horizontal'
    })) as {
      applied: boolean
      moved: Array<{ node_id: number; to: [number, number]; column: number }>
      columns: number
    }
    expect(applied.applied).toBe(true)

    const byColumn = [...applied.moved].sort((a, b) => a.column - b.column)
    for (let i = 1; i < byColumn.length; i++) {
      expect(byColumn[i].to[0]).toBeGreaterThanOrEqual(byColumn[i - 1].to[0])
    }

    const afterApply = (await command(mockBridge, 'graph_get_state')) as {
      nodes: Array<{ id: number; pos: [number, number] }>
    }
    const posAfter = new Map(afterApply.nodes.map((n) => [n.id, n.pos]))
    for (const m of applied.moved) {
      expect(posAfter.get(m.node_id)).toEqual(m.to)
    }

    // 3) One Ctrl+Z restores the pre-layout arrangement.
    await panel.page.evaluate(() => {
      const w = window as unknown as { app?: { canvas?: { canvas?: HTMLElement } } }
      const cv = w.app?.canvas?.canvas
      cv?.focus?.()
    })
    await panel.page.keyboard.press('Control+z')

    await expect
      .poll(async () => {
        const st = (await command(mockBridge, 'graph_get_state')) as {
          nodes: Array<{ id: number; pos: [number, number] }>
        }
        return st.nodes.every(
          (n) => JSON.stringify(n.pos) === JSON.stringify(posBefore.get(n.id))
        )
      })
      .toBe(true)
  })

  test('unknown mode is rejected with a readable error', async ({
    panel,
    mockBridge
  }) => {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    await command(mockBridge, 'graph_clear')
    await command(mockBridge, 'graph_add_node', { class_type: 'CLIPTextEncode' })

    await expect(
      command(mockBridge, 'graph_auto_layout', { mode: 'spiral' })
    ).rejects.toThrow(/Unknown layout mode/)
  })
})
