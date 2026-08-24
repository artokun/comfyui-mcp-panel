/**
 * #941 — a Save-As must report the identity of the workflow it just made active.
 *
 * `panel_save_workflow({name})` writes the copy correctly and switches the active canvas to
 * it. The caller's session is still fenced to the workflow it held BEFORE its own save, so
 * every following `panel_*` graph call is refused — the agent breaks its own binding by
 * using a documented tool exactly as documented.
 *
 * That is survivable only if the reply says what to re-fence TO. It did not: the reply
 * carried `workflow_identity_unavailable`, because the identity read is deliberately pure
 * (#716) and a Save-As activates a brand-new object nothing has established one for. One
 * call later the fence refused with that very identity, which its own minting read had by
 * then produced. The panel knew the value and would not publish it.
 *
 * This asserts the reply carries it. Asserting only that a later call SUCCEEDS would not do:
 * the recovery path (`workflow_open`, fence-exempt) works on its own and would make the test
 * pass with the reply still empty — which is the bug.
 */
import { test, expect, deleteSavedWorkflow } from './fixtures/panelTest'
import { routeWorktreeSource } from './fixtures/worktreeSource'

test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

test('a Save-As reply carries the new workflow instance identity', async ({
  page,
  panel,
  mockBridge
}) => {
  const cleanup: string[] = []
  try {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    // Start from a SAVED workflow, as the report does — a Save-As from an unsaved canvas is
    // a different path (first_save) and already reported identity correctly.
    const first = await mockBridge.command('workflow_save', {})
    expect(first.ok, 'the setup save must succeed').toBe(true)
    const original = String(first.result?.workflow || '')
    expect(original, 'the setup save must report a name').toBeTruthy()
    cleanup.push(original)
    expect(
      first.result?.workflow_uuid,
      'an in-place/first save already reported identity — if this is missing the fix is aimed at the wrong path'
    ).toBeTruthy()

    // The Save-As. This is what strands a caller.
    const copyName = `e2e-941-${Date.now()}`
    const saved = await mockBridge.command('workflow_save', { name: copyName })
    expect(saved.ok, 'the Save-As must succeed').toBe(true)
    cleanup.push(copyName)
    expect(saved.result?.saved_as, 'this must actually be a Save-As, not an in-place save').toBe(true)

    // THE ASSERTION. Without an identity here the caller has nothing to re-fence to, and
    // every call that could tell it is itself refused.
    expect(
      saved.result?.workflow_identity_unavailable,
      'the reply must not report identity as unavailable — that is the wedge'
    ).toBeFalsy()
    expect(saved.result?.workflow_uuid, 'the reply must carry the new instance uuid').toBeTruthy()
    expect(saved.result?.routing_key, 'and the routing key the list records agree on').toBe(
      `wf:workflows/${copyName}.json`
    )
    // The caller must also be TOLD its fence is now stale, or it has no reason to use the
    // identity it was just handed.
    expect(saved.result?.workflow_instance_changed).toBe(true)

    // A Save-As copy is a NEW workflow and must not inherit the original's instance
    // identity — shouldCarryIdentityAcrossSaveSwap refuses the carry for savedAs, but the
    // resolution order is `objectUuid || embedded || pathAlias || random`, so an inherited
    // embedded id could still collapse the two onto one uuid (codex). Assert the outcome,
    // not the intent.
    expect(
      saved.result?.workflow_uuid,
      'the copy must not share the original workflow instance identity'
    ).not.toBe(first.result?.workflow_uuid)

    // The identity must describe the COPY, not whichever canvas happened to be active when
    // the reply was built — the reply's name and its identity have to be one snapshot.
    expect(saved.result?.routing_key).toBe(`wf:workflows/${copyName}.json`)
    expect(saved.result?.routing_key).not.toBe(`wf:workflows/${original}.json`)

    // The published identity has to be the one the fence actually compares against —
    // otherwise it is a plausible-looking value that re-fences to nothing.
    const refused = await mockBridge.command('graph_outline', {})
    expect(refused.ok, 'the session is still fenced to the pre-save workflow, so this is refused').toBe(false)
    expect(
      String(refused.error || ''),
      'the mismatch must name the identity the save reported, or the reply cannot recover the session'
    ).toContain(String(saved.result.workflow_uuid))

    // And the reported identity genuinely recovers the session: re-open the copy (the
    // fence-exempt path), then a graph read must succeed against it.
    const reopened = await mockBridge.command('workflow_open', { path: `workflows/${copyName}.json` })
    expect(reopened.ok, 'the fence-exempt recovery must work').toBe(true)
    const after = await mockBridge.command('graph_outline', {})
    expect(after.ok, 'graph tools must work again once the session is re-fenced').toBe(true)
  } finally {
    for (const name of cleanup.reverse()) {
      try {
        await deleteSavedWorkflow(page, name)
      } catch {
        // Best-effort: cleanup must never mask the assertion that failed.
      }
    }
  }
})

test('Save-As repaints destination identity before a graph edit and no-name save', async ({
  page,
  panel,
  mockBridge
}) => {
  test.setTimeout(120_000)
  const cleanup: string[] = []
  try {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    const first = await mockBridge.command('workflow_save', {})
    expect(first.ok, 'the setup save must succeed').toBe(true)
    const original = String(first.result?.workflow || '')
    expect(original).toBeTruthy()
    cleanup.push(original)

    const copyName = `e2e-939-${Date.now()}`
    const saved = await mockBridge.command('workflow_save', { name: copyName })
    expect(saved.ok, 'the Save-As must succeed').toBe(true)
    cleanup.push(copyName)
    expect(saved.result?.saved_as).toBe(true)
    expect(saved.result?.canvas_repainted).toBe(true)
    expect(saved.result?.canvas_repaint_not_requested).toBeUndefined()
    expect(saved.result?.routing_key).toBe(`wf:workflows/${copyName}.json`)

    // Re-read the active identity the same way a real orchestrator does after a Save-As,
    // without using workflow_open (which would hide a missing Save-As repaint by repairing
    // the canvas as a separate operation).
    mockBridge.forgetWorkflowUuid()
    const edited = await mockBridge.command('graph_add_node', { class_type: 'VAEDecode' })
    expect(edited.ok, `the graph edit must reach the repainted copy: ${edited.error || ''}`).toBe(true)

    const resaved = await mockBridge.command('workflow_save', {})
    expect(resaved.ok, `the no-name save must remain on the destination: ${resaved.error || ''}`).toBe(true)
    expect(resaved.result?.saved_as).toBeUndefined()

    const onDisk = await page.evaluate(async (path) => {
      const api = (window as any).comfyAPI?.api?.api
      const response = await api.fetchApi(`/userdata/${encodeURIComponent(path)}`)
      return response?.ok ? response.json() : { error: `HTTP ${response?.status}` }
    }, `workflows/${copyName}.json`)
    expect(onDisk.extra?.comfyui_mcp?.workflow_path).toBe(`workflows/${copyName}.json`)
    expect((onDisk.nodes ?? []).length).toBeGreaterThan(0)
  } finally {
    for (const name of cleanup.reverse()) {
      try {
        await deleteSavedWorkflow(page, name)
      } catch {
        // Best-effort cleanup must not mask the production-path assertion.
      }
    }
  }
})

test('a tab switch during the real Save-As load reconciles the newer canvas and refuses the save', async ({
  page,
  panel,
  mockBridge
}) => {
  test.setTimeout(120_000)
  const cleanup: string[] = []
  try {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    const first = await mockBridge.command('workflow_save', {})
    expect(first.ok, 'the setup save must succeed').toBe(true)
    const original = String(first.result?.workflow || '')
    expect(original).toBeTruthy()
    cleanup.push(original)

    // Give the source graph content that is visibly different from a newly-created
    // blank tab. The production Save-As payload will therefore be detectable if it
    // lands on the newer tab after that tab switch.
    const edited = await mockBridge.command('graph_add_node', { class_type: 'VAEDecode' })
    expect(edited.ok, `the source setup edit must succeed: ${edited.error || ''}`).toBe(true)

    const copyName = `e2e-939-mid-load-${Date.now()}`
    const copyPath = `workflows/${copyName}.json`
    cleanup.push(copyName)

    // Hold the actual production loadGraphData promise used by repaintSaveAsCanvas.
    // The switch below happens while this promise is suspended, not merely before a
    // test double returns from a repaint hook.
    await page.evaluate((targetPath) => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      if (typeof app?.loadGraphData !== 'function') throw new Error('loadGraphData unavailable')
      const gate: any = { entered: false, released: false, release: null }
      const originalLoad = app.loadGraphData.bind(app)
      app.loadGraphData = async (...args: any[]) => {
        const path = args[0]?.extra?.comfyui_mcp?.workflow_path
        if (path === targetPath && !gate.entered) {
          gate.entered = true
          await new Promise<void>((resolve) => { gate.release = resolve })
          gate.released = true
        }
        return originalLoad(...args)
      }
      w.__cmcp939MidLoadGate = gate
    }, copyPath)

    const saving = mockBridge.command('workflow_save', { name: copyName })
    await page.waitForFunction(() => Boolean((window as any).__cmcp939MidLoadGate?.entered))

    const switched = await mockBridge.command('workflow_new')
    expect(switched.ok, `the concurrent tab switch must succeed: ${switched.error || ''}`).toBe(true)
    expect(switched.result?.created).toBe(true)

    await page.evaluate(() => {
      const gate = (window as any).__cmcp939MidLoadGate
      if (typeof gate?.release !== 'function') throw new Error('Save-As load gate was not releasable')
      gate.release()
    })
    const saved = await saving

    expect(saved.ok, 'a Save-As that lost canvas ownership must not report success').toBe(false)
    expect(String(saved.error || '')).toMatch(/could not be proven active|canvas owner|reconciliation/i)

    const listed = await mockBridge.command('workflow_list')
    expect(listed.ok).toBe(true)
    expect(listed.result?.active?.path).not.toBe(copyPath)
    expect(listed.result?.active?.path).not.toBe(`workflows/${original}.json`)

    const canvas = await page.evaluate(() => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      const graph = app?.canvas?.graph ?? app?.graph
      return {
        nodeCount: graph?.nodes?.length ?? -1,
        workflowUuid: graph?.extra?.comfyui_mcp?.workflow_uuid ?? null
      }
    })
    expect(canvas.nodeCount, 'the newer blank tab must not retain the Save-As source graph').toBe(0)
    expect(canvas.workflowUuid, 'the reconciled canvas must retain the newer active identity').toBe(
      listed.result?.active?.workflow_uuid
    )

    const onDisk = await page.evaluate(async (path) => {
      const api = (window as any).comfyAPI?.api?.api
      const response = await api.fetchApi(`/userdata/${encodeURIComponent(path)}`)
      return response?.status
    }, copyPath)
    expect(onDisk, 'fail-closed reconciliation must not persist the destination').toBe(404)
  } finally {
    for (const name of cleanup.reverse()) {
      try {
        await deleteSavedWorkflow(page, name)
      } catch {
        // Best-effort cleanup must never mask the production-path assertion.
      }
    }
  }
})

test('a failed Save-As does not publish the destination identity alias before persistence', async ({
  page,
  panel,
  mockBridge
}) => {
  test.setTimeout(120_000)
  const cleanup: string[] = []
  let copyPath: string | null = null
  try {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    const first = await mockBridge.command('workflow_save', {})
    expect(first.ok, 'the setup save must succeed').toBe(true)
    const original = String(first.result?.workflow || '')
    expect(original).toBeTruthy()
    cleanup.push(original)

    const copyName = `e2e-939-identity-failure-${Date.now()}`
    copyPath = `workflows/${copyName}.json`

    // Fail the production repaint after the destination UUID has been resolved. A failed
    // copy may clean its in-memory tab, but must not leave the destination path reusable as
    // an identity alias in localStorage/history (#939).
    await page.evaluate((targetPath) => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      if (typeof app?.loadGraphData !== 'function') throw new Error('loadGraphData unavailable')
      const originalLoad = app.loadGraphData.bind(app)
      app.loadGraphData = async (...args: any[]) => {
        const path = args[0]?.extra?.comfyui_mcp?.workflow_path
        if (path === targetPath) throw new Error('forced Save-As repaint failure')
        return originalLoad(...args)
      }
    }, copyPath)

    const failed = await mockBridge.command('workflow_save', { name: copyName })
    expect(failed.ok, 'the forced repaint failure must refuse the Save-As').toBe(false)

    const alias = await page.evaluate((path) => {
      const aliases = JSON.parse(localStorage.getItem('comfyui-mcp.panel.workflowUuidAliases') || '{}')
      return aliases[path] || null
    }, copyPath)
    expect(alias, 'a failed Save-As must not leave a reusable destination alias').toBeNull()
  } finally {
    if (copyPath) {
      await page.evaluate((path) => {
        const aliases = JSON.parse(localStorage.getItem('comfyui-mcp.panel.workflowUuidAliases') || '{}')
        if (Object.hasOwn(aliases, path)) {
          delete aliases[path]
          localStorage.setItem('comfyui-mcp.panel.workflowUuidAliases', JSON.stringify(aliases))
        }
      }, copyPath).catch(() => {})
    }
    for (const name of cleanup.reverse()) {
      try {
        await deleteSavedWorkflow(page, name)
      } catch {
        // Best-effort cleanup must never mask the production-path assertion.
      }
    }
  }
})

test('a second tab switch during reconciliation is re-read and remains bounded', async ({
  page,
  panel,
  mockBridge
}) => {
  test.setTimeout(120_000)
  const cleanup: string[] = []
  try {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    const first = await mockBridge.command('workflow_save', {})
    expect(first.ok, 'the setup save must succeed').toBe(true)
    const original = String(first.result?.workflow || '')
    expect(original).toBeTruthy()
    cleanup.push(original)

    // Prepare two persisted routed tabs so the production reconciliation has a
    // path-bearing owner to load, followed by another owner to switch to.
    const reconcileAName = `e2e-939-reconcile-a-${Date.now()}`
    const reconcileA = await mockBridge.command('workflow_new')
    expect(reconcileA.ok).toBe(true)
    const savedA = await mockBridge.command('workflow_save', { name: reconcileAName })
    expect(savedA.ok, `the first reconciliation tab must save: ${savedA.error || ''}`).toBe(true)
    cleanup.push(reconcileAName)

    const reconcileBName = `e2e-939-reconcile-b-${Date.now()}`
    const reconcileB = await mockBridge.command('workflow_new')
    expect(reconcileB.ok).toBe(true)
    const savedB = await mockBridge.command('workflow_save', { name: reconcileBName })
    expect(savedB.ok, `the second reconciliation tab must save: ${savedB.error || ''}`).toBe(true)
    cleanup.push(reconcileBName)

    const openedOriginal = await mockBridge.command('workflow_open', {
      path: `workflows/${original}.json`
    })
    expect(openedOriginal.ok, `the source tab must be active: ${openedOriginal.error || ''}`).toBe(true)

    const edited = await mockBridge.command('graph_add_node', { class_type: 'VAEDecode' })
    expect(edited.ok, `the source setup edit must succeed: ${edited.error || ''}`).toBe(true)

    const copyName = `e2e-939-second-switch-${Date.now()}`
    const copyPath = `workflows/${copyName}.json`
    const reconcileAPath = `workflows/${reconcileAName}.json`
    const reconcileBPath = `workflows/${reconcileBName}.json`
    cleanup.push(copyName)

    // Hold the initial Save-As load and the first reconciliation load. The
    // second switch happens while the reconciliation await is suspended.
    await page.evaluate(({ copyPath, reconcileAPath }) => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      if (typeof app?.loadGraphData !== 'function') throw new Error('loadGraphData unavailable')
      const gate: any = {
        copyEntered: false,
        reconcileEntered: false,
        copyRelease: null,
        reconcileRelease: null
      }
      const originalLoad = app.loadGraphData.bind(app)
      app.loadGraphData = async (...args: any[]) => {
        const path = args[0]?.extra?.comfyui_mcp?.workflow_path
        const isSaveAsRepaint = args[4]?.__cmcpKeepInstance === true
        if (isSaveAsRepaint && path === copyPath && !gate.copyEntered) {
          gate.copyEntered = true
          await new Promise<void>((resolve) => { gate.copyRelease = resolve })
        } else if (isSaveAsRepaint && path === reconcileAPath && !gate.reconcileEntered) {
          gate.reconcileEntered = true
          await new Promise<void>((resolve) => { gate.reconcileRelease = resolve })
        }
        return originalLoad(...args)
      }
      w.__cmcp939SecondSwitchGate = gate
    }, { copyPath, reconcileAPath })

    const saving = mockBridge.command('workflow_save', { name: copyName })
    await page.waitForFunction(() => Boolean((window as any).__cmcp939SecondSwitchGate?.copyEntered))

    const switchedA = await mockBridge.command('workflow_open', { path: reconcileAPath })
    expect(switchedA.ok, `the first concurrent switch must succeed: ${switchedA.error || ''}`).toBe(true)
    await page.evaluate(() => {
      const gate = (window as any).__cmcp939SecondSwitchGate
      if (typeof gate?.copyRelease !== 'function') throw new Error('initial Save-As gate was not releasable')
      gate.copyRelease()
    })
    await page.waitForFunction(() => Boolean((window as any).__cmcp939SecondSwitchGate?.reconcileEntered))

    const switchedB = await mockBridge.command('workflow_open', { path: reconcileBPath })
    expect(switchedB.ok, `the second concurrent switch must succeed: ${switchedB.error || ''}`).toBe(true)
    await page.evaluate(() => {
      const gate = (window as any).__cmcp939SecondSwitchGate
      if (typeof gate?.reconcileRelease !== 'function') throw new Error('reconciliation gate was not releasable')
      gate.reconcileRelease()
    })

    const saved = await saving
    expect(saved.ok, 'losing ownership during reconciliation must refuse the Save-As').toBe(false)
    expect(String(saved.error || '')).toMatch(/could not be proven active|canvas owner|reconciliation/i)

    const listed = await mockBridge.command('workflow_list')
    expect(listed.ok).toBe(true)
    expect(listed.result?.active?.path).toBe(reconcileBPath)

    const canvas = await page.evaluate(() => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      const graph = app?.canvas?.graph ?? app?.graph
      return {
        nodeCount: graph?.nodes?.length ?? -1,
        workflowUuid: graph?.extra?.comfyui_mcp?.workflow_uuid ?? null
      }
    })
    expect(canvas.nodeCount, 'the newest tab must not retain the Save-As source graph').toBe(0)
    expect(canvas.workflowUuid, 'the second reconciliation must preserve the newest identity').toBe(
      listed.result?.active?.workflow_uuid
    )

    const onDisk = await page.evaluate(async (path) => {
      const api = (window as any).comfyAPI?.api?.api
      const response = await api.fetchApi(`/userdata/${encodeURIComponent(path)}`)
      return response?.status
    }, copyPath)
    expect(onDisk, 'bounded fail-closed reconciliation must not persist the destination').toBe(404)
  } finally {
    for (const name of cleanup.reverse()) {
      try {
        await deleteSavedWorkflow(page, name)
      } catch {
        // Best-effort cleanup must never mask the assertion that failed.
      }
    }
  }
})
