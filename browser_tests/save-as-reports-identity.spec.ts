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
