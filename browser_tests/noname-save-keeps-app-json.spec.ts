/**
 * #1535 — a NO-NAME `panel_save_workflow({})` on an active `.app.json` workflow must
 * write THAT file, not fork a plain `.json` beside it.
 *
 * The reported sequence, run here against the real ComfyUI frontend:
 *   save under a ".app" name  → workflows/<stem>.app.json
 *   open it                   → the frontend reports filename "<stem>" (getFilenameDetails
 *                               strips the compound ".app.json" suffix) while
 *                               `initialMode` is derived from the FILE's extra.linearMode
 *   graph_configure_app_mode  → writes extra.linearMode = true on the live root, and does
 *                               NOT touch `initialMode`
 *   save with no name         → the save layer rebuilt the target as
 *                               "<stem>" + modeExt(initialMode) = "<stem>.json", saw a
 *                               relocation, and routed to the Save-As COPY path. A NEW
 *                               `workflows/<stem>.json` appeared holding the app-mode
 *                               configuration, `saved_as: true` was reported, and the file
 *                               the user was actually editing was never written.
 *
 * That is silent data divergence: the caller is told the save succeeded and keeps working
 * in a file that does not have its edits.
 *
 * The assertions below are on the OBSERVED EFFECT — the routing key of the reply and the
 * bytes on disk — not on which branch the code took.
 */
import { test, expect } from './fixtures/panelTest'
import { routeWorktreeSource } from './fixtures/worktreeSource'

test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

/** Read a workflow file back through ComfyUI's own userdata API. `null` = absent. */
async function readWorkflowFile(page: import('@playwright/test').Page, userdataPath: string) {
  return await page.evaluate(async (path) => {
    const api = (window as any).comfyAPI?.api?.api
    if (typeof api?.fetchApi !== 'function') return { status: -1, body: null }
    const res = await api.fetchApi(`/userdata/${encodeURIComponent(path)}`)
    if (!res?.ok) return { status: res?.status ?? -1, body: null }
    let body: any = null
    try {
      body = JSON.parse(await res.text())
    } catch {
      body = null
    }
    return { status: res.status, body }
  }, userdataPath)
}

test('a no-name save of an active .app.json workflow writes that file, not a plain .json fork', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const stem = `cmcp-e2e-1535-${Date.now()}`
  const appPath = `workflows/${stem}.app.json`
  const forkPath = `workflows/${stem}.json`

  // Step 2 of the report: a save under a ".app" name lands the file at "<stem>.app.json".
  const created = await mockBridge.command('workflow_save', { name: `${stem}.app` })
  expect(created.ok, `the setup save must succeed: ${created.error ?? ''}`).toBe(true)
  expect(
    (await readWorkflowFile(page, appPath)).status,
    'the setup must actually produce the .app.json file the report starts from'
  ).toBe(200)

  // Step 3: reopen it, so the workflow's identity comes from the PATH the way the report's
  // does — this is what makes `filename` "<stem>" with the ".app" suffix living only in the
  // path.
  const opened = await mockBridge.command('workflow_open', { path: appPath })
  expect(opened.ok, `reopening the .app.json must succeed: ${opened.error ?? ''}`).toBe(true)

  // Step 4: configure app mode. This writes extra.linearMode on the live root.
  const configured = await mockBridge.command('graph_configure_app_mode', { default_mode: 'app' })
  expect(configured.ok, `configure_app_mode must succeed: ${configured.error ?? ''}`).toBe(true)
  expect(configured.result?.linearMode, 'app mode must be on for the save to carry it').toBe(true)

  // Step 5: THE CALL UNDER TEST — save with no name at all.
  const saved = await mockBridge.command('workflow_save', {})
  expect(saved.ok, `the no-name save must succeed: ${saved.error ?? ''}`).toBe(true)

  // THE ASSERTIONS. A no-name save is an in-place save of the file the caller is editing.
  expect(
    saved.result?.routing_key,
    'the no-name save must report the file it was editing, not a plain-.json fork'
  ).toBe(`wf:${appPath}`)
  expect(
    saved.result?.saved_as,
    'a no-name save is not a Save-As — reporting one tells the caller a NEW file holds its work'
  ).toBeFalsy()

  // Disk is the arbiter: the edits must be in the file the caller is editing...
  const appFile = await readWorkflowFile(page, appPath)
  expect(appFile.status, 'the .app.json the caller was editing must still be there').toBe(200)
  expect(
    appFile.body?.extra?.linearMode,
    'the app-mode configuration must have landed in the .app.json, not somewhere else'
  ).toBe(true)

  // ...and no orphan may have been created beside it holding that work.
  const fork = await readWorkflowFile(page, forkPath)
  expect(
    fork.status,
    `a no-name save must not create ${forkPath} — that is the orphan the report describes`
  ).toBe(404)
})
