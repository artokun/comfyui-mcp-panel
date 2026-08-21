/**
 * Tier 1 — panel#1563/#1564: a save must never report success for a graph the file
 * does not contain (agent-free).
 *
 * THE MEASURED DEFECT, reproduced here end to end on a real ComfyUI. ComfyUI persists
 * a tab by serializing `changeTracker.activeState` — the tracker SNAPSHOT, never the
 * graph on screen — and refreshes that snapshot first via `prepareForSave()` →
 * `captureCanvasState()`. That capture opens with a silent early return:
 *
 *     if (!app.graph || this.changeCount > 0 || this._restoringState ||
 *         ChangeTracker.isLoadingGraph) return
 *
 * With one of those windows open, `panel_create_group` lands a group on the canvas,
 * the snapshot never moves, and (before this fix) `panel_save_workflow` answered
 * `{"saved": true}` while the file came back WITHOUT the group. The same stale snapshot
 * is what the binding fence sees, which is the `root-shape-mismatch` half of #1563.
 *
 * The window is opened here by setting one of upstream's OWN flags, the way an undo
 * restore sets it — not by stubbing the panel. The unit suites pin the verdict and the wiring;
 * this spec is the part they cannot reach: that the refusal actually reaches
 * `panel_save_workflow` through ComfyUI's real save funnel, that the file on disk is
 * untouched, and that the guard CLEARS — a guard that wedged saving would be a worse
 * bug than the one it fixes.
 *
 * #1564 is why this spec does not test "await the capture": that experiment was run on
 * the live panel and failed. A suppressed capture returns `undefined` synchronously —
 * there is nothing to await.
 *
 * PREREQUISITE: a real ComfyUI at http://localhost:8188 with this pack linked into
 * custom_nodes and CORS enabled (see playwright.config.ts).
 */
import { test, expect, deleteSavedWorkflow } from './fixtures/panelTest'
import type { MockBridge } from './fixtures/MockBridge'
import { routeWorktreeSource } from './fixtures/worktreeSource'

interface CmdReply {
  ok: boolean
  result?: Record<string, any>
  error?: string
}

async function cmd(
  bridge: MockBridge,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30_000
): Promise<CmdReply> {
  const reply = (await bridge.command(name, args, timeoutMs)) as unknown as CmdReply
  return { ok: !!reply.ok, result: reply.result, error: reply.error }
}

test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

test.describe('a save whose snapshot is behind the canvas (panel#1563)', () => {
  test('is refused instead of silently writing a file without the new group', async ({
    panel,
    mockBridge
  }) => {
    test.setTimeout(120_000)
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.page
      .locator('[class~="comfyui-mcp.agent-tab-button"]')
      .first()
      .click({ timeout: 20_000 })
    await panel.page.locator('.cmcp-root').waitFor({ state: 'visible', timeout: 20_000 })
    await panel.connect()

    const name = `cmcp-e2e-1563-${Date.now()}`
    const path = `workflows/${name}.json`

    /**
     * Open or close one of upstream's OWN suppression windows. `_restoringState` is the
     * flag ComfyUI holds for the whole of an undo/redo restore (it awaits
     * `loadGraphData`), so a panel command arriving during one meets exactly this. It is
     * used here rather than `isLoadingGraph` because that static also gates unrelated
     * frontend work — with it set, `graph_create_group` itself fails with "Illegal
     * invocation", which would test the harness rather than the guard.
     */
    const setSuppressionWindow = (open: boolean) =>
      panel.page.evaluate((isOpen) => {
        const app = (window as any).app
        const tracker = app?.extensionManager?.workflow?.activeWorkflow?.changeTracker
        if (!tracker) return false
        tracker._restoringState = isOpen
        return tracker._restoringState === isOpen
      }, open)

    const groupsOnDisk = () =>
      panel.page.evaluate(async (p) => {
        const api = (window as any).comfyAPI?.api?.api
        const res = await api.fetchApi(`/userdata/${encodeURIComponent(p)}`)
        if (!res?.ok) return { error: `HTTP ${res?.status}` }
        const json = await res.json()
        return {
          nodes: Array.isArray(json?.nodes) ? json.nodes.length : null,
          titles: (Array.isArray(json?.groups) ? json.groups : []).map((g: any) => g?.title)
        }
      }, path)

    try {
      await cmd(mockBridge, 'graph_clear')
      const ids: number[] = []
      for (let i = 0; i < 4; i++) {
        const added = await cmd(mockBridge, 'graph_add_node', { class_type: 'VAEDecode' })
        ids.push(Number(added.result?.added?.id))
      }
      // Spread them so the two groups cannot overlap into one another's box.
      await panel.page.evaluate((nodeIds) => {
        const graph = (window as any).app.graph
        nodeIds.forEach((id: number, i: number) => {
          const node = graph.getNodeById(id)
          if (node) node.pos = [200 + i * 600, 200]
        })
      }, ids)

      const pre = await cmd(mockBridge, 'graph_create_group', { title: 'Pre', node_ids: [ids[0]] })
      expect(pre.ok, pre.error).toBe(true)
      const saved = await cmd(mockBridge, 'workflow_save', { name })
      expect(saved.ok, saved.error).toBe(true)
      expect(await groupsOnDisk()).toMatchObject({ titles: ['Pre'] })

      // ---- the reported sequence -------------------------------------------
      // Let upstream's 50ms debounced `squashState` (scheduled by the save's own
      // capture) drain FIRST. It re-captures without checking `_restoringState`, so a
      // squash still in flight would heal the snapshot and this spec would silently
      // stop exercising the defect.
      await panel.page.waitForTimeout(300)
      expect(await setSuppressionWindow(true)).toBe(true)

      const created = await cmd(mockBridge, 'graph_create_group', {
        title: 'Added',
        node_ids: [ids[2], ids[3]]
      })
      expect(created.ok, created.error).toBe(true)

      // The canvas HAS the group; the tracker snapshot does not — read both from the
      // engine so a drifted precondition is diagnosable rather than a mystery.
      const drift = await panel.page.evaluate(() => {
        const app = (window as any).app
        const tracker = app?.extensionManager?.workflow?.activeWorkflow?.changeTracker
        return {
          live: (app?.rootGraph?.serialize?.()?.groups ?? []).length,
          snapshot: (tracker?.activeState?.groups ?? []).length
        }
      })
      expect(drift, JSON.stringify(drift)).toEqual({ live: 2, snapshot: 1 })

      const lossy = await cmd(mockBridge, 'workflow_save', {})
      expect(lossy.ok, `the save must NOT report success: ${JSON.stringify(lossy.result)}`).toBe(
        false
      )
      expect(lossy.error ?? '').toMatch(/BEHIND the live canvas/)
      expect(lossy.error ?? '').toMatch(/NOTHING was written/)

      // And nothing was written: the file still holds exactly what it held before.
      expect(await groupsOnDisk()).toMatchObject({ nodes: 4, titles: ['Pre'] })

      // ---- and the guard CLEARS ---------------------------------------------
      // Every suppression condition upstream is transient. Once the window closes the
      // save must go through and carry the group with it — a guard that wedged saving
      // would trade data loss for a cannot-save bug.
      expect(await setSuppressionWindow(false)).toBe(true)
      const healed = await cmd(mockBridge, 'workflow_save', {})
      expect(healed.ok, healed.error).toBe(true)
      expect(await groupsOnDisk()).toMatchObject({ nodes: 4, titles: ['Pre', 'Added'] })
    } finally {
      await setSuppressionWindow(false).catch(() => false)
      await deleteSavedWorkflow(panel.page, name)
    }
  })
})
